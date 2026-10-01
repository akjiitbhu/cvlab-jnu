#!/usr/bin/env node
'use strict';

/**
 * Refresh the citation figures in the database.
 *
 *   npm run refresh-metrics                    read OpenAlex, write the result
 *   npm run refresh-metrics -- --dry-run       show what it would write
 *   npm run refresh-metrics -- --citations 351 --h 10 --i10 11 --source "Google Scholar"
 *
 * WHY NOT GOOGLE SCHOLAR
 * ----------------------
 * Scholar has no public API and its robots.txt disallows automated reads of
 * /citations. Scraping it from a server on a timer gets the host rate-limited,
 * served CAPTCHAs, and eventually blocked. So the automatic path reads OpenAlex,
 * which is free, documented, and built for this.
 *
 * The trade-off, stated plainly because the site displays it: OpenAlex indexes
 * fewer venues than Scholar and will normally report a LOWER citation count.
 * The two numbers are not interchangeable. This script writes the source name
 * into the database and the page prints it, so a figure is never credited to
 * Scholar when it came from somewhere else.
 *
 * To publish the Scholar numbers specifically, read them off the profile and
 * pass them with the manual flags above.
 *
 * Cron on the host, Mondays at 06:00:
 *   0 6 * * 1 cd /srv/cvlab && /usr/bin/node scripts/refresh-metrics.js >> /var/log/cvlab-metrics.log 2>&1
 */

require('dotenv').config();

const { connect, disconnect } = require('../src/db');
const Metrics = require('../src/models/Metrics');

const ORCID = process.env.ORCID || '0000-0003-1736-9157';
const MAILTO = process.env.OPENALEX_MAILTO || 'ankitjaiswal@jnu.ac.in';
const OPENALEX = 'https://api.openalex.org';
const TIMEOUT_MS = 30000;

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

async function getJson(url) {
  const sep = url.includes('?') ? '&' : '?';
  const full = `${url}${sep}mailto=${encodeURIComponent(MAILTO)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(full, {
      signal: controller.signal,
      headers: {
        'User-Agent': `cvlab-jnu-metrics/1.0 (mailto:${MAILTO})`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) throw new Error(`OpenAlex returned HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Largest h such that h works each have at least h citations. */
function hIndexOf(sortedDesc) {
  let h = 0;
  for (let i = 0; i < sortedDesc.length; i++) {
    if (sortedDesc[i] >= i + 1) h = i + 1;
    else break;
  }
  return h;
}

async function fromOpenAlex() {
  const found = await getJson(`${OPENALEX}/authors?filter=orcid:${encodeURIComponent(ORCID)}`);
  const author = (found.results || [])[0];
  if (!author) throw new Error(`no OpenAlex author record for ORCID ${ORCID}`);

  const shortId = String(author.id).replace(/\/$/, '').split('/').pop();

  // Page through every work, collecting citation counts.
  const counts = [];
  let cursor = '*';
  while (cursor) {
    const page = await getJson(
      `${OPENALEX}/works?filter=author.id:${shortId}` +
      `&select=cited_by_count&per-page=200&cursor=${encodeURIComponent(cursor)}`
    );
    const rows = page.results || [];
    for (const w of rows) counts.push(Number(w.cited_by_count) || 0);
    cursor = (page.meta || {}).next_cursor;
    if (rows.length === 0) break;
  }
  counts.sort((a, b) => b - a);

  const stats = author.summary_stats || {};

  return {
    name: author.display_name,
    citations: Number(author.cited_by_count) || counts.reduce((a, b) => a + b, 0),
    hIndex: Number(stats.h_index) || hIndexOf(counts),
    i10Index: stats.i10_index != null ? Number(stats.i10_index) : counts.filter((c) => c >= 10).length,
    works: Number(author.works_count) || counts.length,
    source: 'OpenAlex',
    profileUrl: author.id,
  };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const manualCitations = arg('citations');
  let next;

  if (manualCitations) {
    next = {
      citations: Number(manualCitations),
      hIndex: arg('h') != null ? Number(arg('h')) : null,
      i10Index: arg('i10') != null ? Number(arg('i10')) : null,
      source: arg('source') || 'Google Scholar',
      profileUrl: arg('profile') || 'https://scholar.google.com/citations?user=ftr72kcAAAAJ',
      name: '(manual entry)',
    };
    if (!Number.isFinite(next.citations)) throw new Error('--citations must be a number');
  } else {
    next = await fromOpenAlex();
    console.log(`[metrics] matched OpenAlex author: ${next.name} (${next.works} works)`);
  }

  const asOf = new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  await connect(process.env.MONGODB_URI);
  const before = await Metrics.findById('current').lean();

  // A large jump usually means the wrong author was matched, not a real change.
  if (before && before.citations && next.citations) {
    const change = Math.abs(next.citations - before.citations) / before.citations;
    if (change > 0.5) {
      console.warn(
        `[metrics] WARNING: citations move from ${before.citations} to ${next.citations} ` +
        `(${Math.round(change * 100)}%). Check the author match before trusting this.`
      );
    }
  }

  const update = {
    citations: next.citations,
    hIndex: next.hIndex,
    i10Index: next.i10Index,
    asOf,
    source: next.source,
    profileUrl: next.profileUrl,
  };

  if (dryRun) {
    console.log('[metrics] --dry-run, nothing written. Would set:');
    console.log(JSON.stringify(update, null, 2));
  } else {
    await Metrics.findByIdAndUpdate('current', { $set: update }, { upsert: true, new: true });
    console.log(
      `[metrics] citations=${update.citations} h=${update.hIndex} ` +
      `i10=${update.i10Index} source=${update.source} asOf=${asOf}`
    );
  }

  await disconnect();
}

main().catch(async (err) => {
  // Leave the previous figures in place rather than blanking the page because
  // one scheduled run could not reach the network.
  console.error('[metrics] refresh failed, existing values kept:', err.message);
  await disconnect().catch(() => {});
  process.exit(1);
});

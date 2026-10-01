#!/usr/bin/env node
'use strict';

/**
 * Load the site's starting content into MongoDB.
 *
 *   npm run seed            add anything missing, leave existing rows alone
 *   npm run seed -- --reset delete all content first, then load
 *
 * Safe to run more than once: without --reset it matches on a natural key
 * (member name, research title + kind, course slug) and skips rows that are
 * already there, so it will not create duplicates.
 *
 * The admin account is NOT created here — run `npm run create-admin` for that,
 * so a password is never written into a file that lives in the repository.
 */

require('dotenv').config();

const path = require('path');
const { connect, disconnect } = require('../src/db');
const Member = require('../src/models/Member');
const ResearchItem = require('../src/models/ResearchItem');
const Course = require('../src/models/Course');
const Metrics = require('../src/models/Metrics');

const data = require(path.join(__dirname, 'seed-data.json'));

async function main() {
  const reset = process.argv.includes('--reset');

  await connect(process.env.MONGODB_URI);

  if (reset) {
    console.log('[seed] --reset given: clearing members, research and courses');
    await Promise.all([
      Member.deleteMany({}),
      ResearchItem.deleteMany({}),
      Course.deleteMany({}),
    ]);
  }

  const counts = { members: 0, research: 0, courses: 0, skipped: 0 };

  for (const m of data.members) {
    const exists = await Member.findOne({ name: m.name });
    if (exists) { counts.skipped++; continue; }
    await Member.create(m);
    counts.members++;
  }

  for (const r of data.research) {
    const exists = await ResearchItem.findOne({ kind: r.kind, title: r.title });
    if (exists) { counts.skipped++; continue; }
    await ResearchItem.create(r);
    counts.research++;
  }

  for (const c of data.courses) {
    const exists = await Course.findOne({ slug: c.slug });
    if (exists) { counts.skipped++; continue; }
    await Course.create(c);
    counts.courses++;
  }

  // Metrics is a single pinned document, so upsert rather than skip.
  await Metrics.findByIdAndUpdate(
    'current',
    { $set: data.metrics },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  console.log(
    `[seed] members +${counts.members}  research +${counts.research}  ` +
    `courses +${counts.courses}  (${counts.skipped} already present)`
  );
  console.log('[seed] metrics document written');

  if (!reset && counts.skipped > 0) {
    console.log('[seed] nothing was overwritten — use --reset to start clean');
  }

  await disconnect();
}

main().catch(async (err) => {
  console.error('[seed] failed:', err.message);
  await disconnect().catch(() => {});
  process.exit(1);
});

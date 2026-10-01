'use strict';

const express = require('express');
const Member = require('../models/Member');
const ResearchItem = require('../models/ResearchItem');
const Course = require('../models/Course');
const Metrics = require('../models/Metrics');
const GalleryItem = require('../models/GalleryItem');

const router = express.Router();

/**
 * Everything the public site needs, in one request.
 *
 * The page renders four sections from this payload, and four separate fetches
 * on a free host that sleeps would mean four cold starts on the first visit.
 * One call keeps the first paint to a single round trip.
 */
router.get('/', async (req, res, next) => {
  try {
    const visible = { visible: { $ne: false } };

    const [members, research, courses, metrics, gallery] = await Promise.all([
      Member.find(visible).sort({ order: 1, name: 1 }).lean({ virtuals: true }),
      ResearchItem.find(visible).sort({ order: 1, year: -1, _id: 1 }).lean(),
      Course.find(visible).sort({ order: 1, title: 1 }).lean(),
      Metrics.findById('current').lean(),
      GalleryItem.find(visible).sort({ order: 1, createdAt: -1 }).limit(200).lean(),
    ]);

    // lean() skips virtuals unless the plugin is present, so compute initials here.
    for (const m of members) {
      m.initials = initialsOf(m.name);
    }

    res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');

    const grouped = groupBy(members, 'group');

    // The lab in-charge is rendered in their own place on two pages, not as a
    // card in a cohort, so lift them out of the grouping the Members page
    // iterates over.
    const pi = (grouped.pi || [])[0] || null;
    delete grouped.pi;

    res.json({
      metrics: metrics || null,
      pi,
      members: grouped,
      research: groupBy(research, 'kind'),
      courses,
      gallery,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
});

function groupBy(rows, key) {
  const out = {};
  for (const row of rows) {
    const k = row[key] || 'other';
    if (!out[k]) out[k] = [];
    out[k].push(row);
  }
  return out;
}

function initialsOf(name) {
  const cleaned = String(name || '')
    .replace(/^(Dr|Mr|Ms|Mrs|Prof|Shri|Smt)\.?\s+/i, '')
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

module.exports = router;

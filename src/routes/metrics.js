'use strict';

const express = require('express');
const Metrics = require('../models/Metrics');
const { requireAdmin } = require('../middleware/auth');

const router = express.Router();

const NUMERIC = ['citations', 'hIndex', 'i10Index', 'phdScholars', 'mtechSupervised', 'patents'];
const TEXT = ['asOf', 'source', 'profileUrl'];

/** Empty string and null both mean "not recorded" — the tile hides. */
function normalise(body) {
  const out = {};
  for (const key of NUMERIC) {
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
    const raw = body[key];
    if (raw === null || raw === '' || raw === undefined) {
      out[key] = null;
    } else {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) {
        const err = new Error(`${key} must be a number of 0 or more, or blank.`);
        err.status = 400;
        throw err;
      }
      out[key] = Math.round(n);
    }
  }
  for (const key of TEXT) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      out[key] = String(body[key] || '').slice(0, 500);
    }
  }
  return out;
}

router.get('/', async (req, res, next) => {
  try {
    const doc = await Metrics.findById('current');
    res.json(doc || { _id: 'current' });
  } catch (err) {
    next(err);
  }
});

router.put('/', requireAdmin, async (req, res, next) => {
  try {
    const update = normalise(req.body || {});
    const doc = await Metrics.findByIdAndUpdate(
      'current',
      { $set: update },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );
    res.json(doc);
  } catch (err) {
    next(err);
  }
});

module.exports = router;

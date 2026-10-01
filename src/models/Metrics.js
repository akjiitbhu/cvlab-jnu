'use strict';

const { Schema, model } = require('mongoose');

/**
 * Bibliometrics shown in the row on the home page.
 *
 * Exactly one document, pinned to _id "current", so reads never have to sort or
 * guess which row is live and the refresh script is an idempotent upsert.
 *
 * A note on `source`, because it matters for honesty: Google Scholar has no API
 * and its robots.txt disallows automated reads of /citations, so a scheduled
 * refresh cannot get Scholar's numbers. OpenAlex can be read automatically but
 * indexes fewer venues and therefore reports LOWER counts. Whichever is used,
 * the page prints this field, so the figures are never labelled as Scholar's
 * when they came from somewhere else.
 */
const MetricsSchema = new Schema(
  {
    _id: { type: String, default: 'current' },

    citations: { type: Number, default: null, min: 0 },
    hIndex: { type: Number, default: null, min: 0 },
    i10Index: { type: Number, default: null, min: 0 },

    // Counts that are not bibliometric but sit in the same row.
    phdScholars: { type: Number, default: null, min: 0 },
    mtechSupervised: { type: Number, default: null, min: 0 },
    patents: { type: Number, default: null, min: 0 },

    // "August 2026"
    asOf: { type: String, trim: true, default: '', maxlength: 60 },

    source: {
      type: String,
      trim: true,
      default: 'Google Scholar',
      maxlength: 80,
    },

    profileUrl: { type: String, trim: true, default: '', maxlength: 500 },
  },
  { timestamps: true, _id: false }
);

module.exports = model('Metrics', MetricsSchema);

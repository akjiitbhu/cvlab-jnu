'use strict';

const { Schema, model } = require('mongoose');

/**
 * One item of research activity. A single collection covers publications,
 * talks, organized events, chaired conferences and research themes, because
 * they share almost all their fields and the admin screen stays simpler with
 * one form whose optional fields light up per kind.
 */
const KINDS = [
  'patent',
  'journal',
  'chapter',
  'conference',
  'talk',
  'organized',
  'chaired',
  'theme',
];

const ResearchItemSchema = new Schema(
  {
    kind: { type: String, required: true, enum: KINDS, index: true },

    // Paper title, talk title, event name, or the theme's heading.
    title: { type: String, required: true, trim: true, maxlength: 500 },

    // "Ankit Kumar Jaiswal and Rajeev Srivastava" — stored as typed, so the
    // published author order is never rearranged by the site.
    authors: { type: String, trim: true, default: '', maxlength: 800 },

    // Journal, proceedings, or host institution.
    venue: { type: String, trim: true, default: '', maxlength: 500 },

    // "2026", or "20–22 Jul 2026" for talks and events.
    date: { type: String, trim: true, default: '', maxlength: 120 },

    // Numeric year, used only for sorting. Set it and ordering is automatic.
    year: { type: Number, default: null, index: true },

    // "vol. 79, pp. 11837–11860" / "Application No. 202211038984"
    detail: { type: String, trim: true, default: '', maxlength: 300 },

    // Optional figure — a graphical abstract or result panel. Stored as
    // "/api/photos/<id>", uploaded with the "figure" variant so the aspect
    // ratio is preserved rather than cropped square.
    image: { type: String, trim: true, default: '', maxlength: 500 },
    imageCaption: { type: String, trim: true, default: '', maxlength: 300 },

    doi: { type: String, trim: true, default: '', maxlength: 200 },
    url: { type: String, trim: true, default: '', maxlength: 500 },

    // Small labels on the entry: "Scopus", "Best paper", "First author".
    tags: [{ type: String, trim: true, maxlength: 60 }],

    // themes only — the eyebrow above the heading, and the body text.
    label: { type: String, trim: true, default: '', maxlength: 80 },
    body: { type: String, trim: true, default: '', maxlength: 1200 },

    // Optional link to the lab member whose work this is.
    member: { type: Schema.Types.ObjectId, ref: 'Member', default: null },

    order: { type: Number, default: 0 },
    visible: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Newest first within a kind, with `order` as the manual override.
ResearchItemSchema.index({ kind: 1, order: 1, year: -1 });

ResearchItemSchema.statics.KINDS = KINDS;

module.exports = model('ResearchItem', ResearchItemSchema);

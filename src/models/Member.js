'use strict';

const { Schema, model } = require('mongoose');

/**
 * A person in the lab. `group` decides which block of the Members page they
 * appear in; `order` decides their position inside that block.
 */
const MemberSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 160 },

    group: {
      type: String,
      required: true,
      // 'pi' is the lab in-charge. Keeping them in this collection means the
      // photograph, the links and the editing form are all the same machinery
      // as everyone else's; the public pages just render them in their own
      // place rather than as a card in a cohort.
      enum: ['pi', 'phd', 'mtech', 'btech', 'alumni', 'staff'],
      default: 'phd',
      index: true,
    },

    // "Deepfake Generation and Detection"
    topic: { type: String, trim: true, default: '', maxlength: 600 },

    // Free text so "2023", "Enrolled 2023", "M.Tech. 2024–2026" all work.
    period: { type: String, trim: true, default: '', maxlength: 80 },

    email: { type: String, trim: true, default: '', maxlength: 200 },

    // Optional links shown as small chips on the card.
    links: [
      {
        _id: false,
        label: { type: String, trim: true, maxlength: 60 },
        url: { type: String, trim: true, maxlength: 500 },
      },
    ],

    // Path or absolute URL to a photograph. Empty renders the initials tile.
    photo: { type: String, trim: true, default: '', maxlength: 500 },

    // Alumni only — where they are now.
    currentPosition: { type: String, trim: true, default: '', maxlength: 300 },

    order: { type: Number, default: 0, index: true },
    visible: { type: Boolean, default: true },
  },
  { timestamps: true }
);

MemberSchema.index({ group: 1, order: 1, name: 1 });

/** Two-letter monogram for the avatar tile, ignoring honorifics. */
MemberSchema.virtual('initials').get(function () {
  const cleaned = String(this.name || '')
    .replace(/^(Dr|Mr|Ms|Mrs|Prof|Shri|Smt)\.?\s+/i, '')
    .trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
});

MemberSchema.set('toJSON', { virtuals: true });

module.exports = model('Member', MemberSchema);

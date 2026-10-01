'use strict';

const { Schema, model } = require('mongoose');

/**
 * One photograph in the lab gallery — group photos, equipment, event pictures.
 *
 * The image itself lives in the Photo collection (uploaded with the "gallery"
 * variant, so it carries a thumbnail). This document holds only what the page
 * needs to caption and order it, which keeps a gallery listing small: the grid
 * fetches captions, not megabytes.
 */
const GalleryItemSchema = new Schema(
  {
    // "/api/photos/<id>" — the same shape as a member's photo field, so the
    // public page resolves it through one helper.
    photo: { type: String, required: true, trim: true, maxlength: 500 },

    caption: { type: String, trim: true, default: '', maxlength: 400 },

    // Grouping, e.g. "FDP 2025", "Lab", "Conferences". Blank means ungrouped,
    // which is the common case for a small gallery.
    album: { type: String, trim: true, default: '', maxlength: 80, index: true },

    // Free text: "July 2025". Not a Date, because "2025" and "July 2025" are
    // both things you want to be able to write.
    taken: { type: String, trim: true, default: '', maxlength: 60 },

    order: { type: Number, default: 0, index: true },
    visible: { type: Boolean, default: true },
  },
  { timestamps: true }
);

GalleryItemSchema.index({ album: 1, order: 1, createdAt: -1 });

module.exports = model('GalleryItem', GalleryItemSchema);

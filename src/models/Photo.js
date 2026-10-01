'use strict';

const { Schema, model } = require('mongoose');

/**
 * An uploaded photograph, stored as bytes inside MongoDB.
 *
 * WHY IN THE DATABASE AND NOT ON DISK
 * -----------------------------------
 * Both of this project's deployment targets make the filesystem the wrong
 * place:
 *
 *   - A free host (Render, Railway) gives the process an ephemeral disk. It is
 *     wiped on every deploy and on every restart, so photographs uploaded
 *     through the editor would silently vanish the next time you pushed a
 *     commit — the worst kind of data loss, because nothing reports it.
 *   - The systemd unit for a self-hosted server sets ProtectSystem=strict,
 *     making the whole filesystem read-only. Writing uploads to disk would mean
 *     granting a writable path back to a process that serves the public
 *     internet.
 *
 * Keeping them in MongoDB means they are covered by the same backup as the
 * rest of the content, they survive redeploys everywhere, and a restore brings
 * the site back complete.
 *
 * The cost is that every photo occupies a document. That is fine at this scale:
 * images are re-encoded to at most 600x600, which lands around 10-60 kB, and a
 * lab has tens of people, not thousands. A document cannot exceed 16 MB, and
 * the upload route rejects anything that would come close.
 */
const PhotoSchema = new Schema(
  {
    // The re-encoded image. Never the bytes the browser uploaded — see
    // routes/photos.js for why that distinction is the whole security model.
    data: { type: Buffer, required: true },

    contentType: {
      type: String,
      required: true,
      enum: ['image/jpeg', 'image/png', 'image/webp'],
      default: 'image/jpeg',
    },

    // How this image was processed — see routes/photos.js VARIANTS.
    variant: {
      type: String,
      enum: ['portrait', 'figure', 'gallery'],
      default: 'portrait',
      index: true,
    },

    // Gallery and figure images keep a small version so a grid of twenty
    // photographs does not pull twenty full-size images over the wire.
    thumb: { type: Buffer, default: null },
    thumbWidth: { type: Number, default: null },
    thumbHeight: { type: Number, default: null },

    width: { type: Number, default: null },
    height: { type: Number, default: null },
    bytes: { type: Number, default: null },

    // What this photo is for, so an orphan sweep can reason about it.
    // Free text rather than a ref, because a photo may be uploaded before the
    // member document it belongs to exists.
    usage: { type: String, trim: true, default: '', maxlength: 120 },

    // Caption / alt text. Empty is correct for a portrait next to its own name:
    // a screen reader would otherwise read the name twice.
    alt: { type: String, trim: true, default: '', maxlength: 200 },
  },
  { timestamps: true }
);

/**
 * `data` is large, so it must never ride along with a list query. Any route
 * that lists photos selects explicitly; only the single-photo fetch asks for
 * the bytes.
 */
PhotoSchema.statics.metaFields =
  'contentType variant width height thumbWidth thumbHeight bytes usage alt createdAt updatedAt';

module.exports = model('Photo', PhotoSchema);

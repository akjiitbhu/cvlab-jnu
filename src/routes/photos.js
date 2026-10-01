'use strict';

const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const mongoose = require('mongoose');

const Photo = require('../models/Photo');
const Member = require('../models/Member');
const { requireAdmin } = require('../middleware/auth');
const { publicCors } = require('../middleware/cors');

const router = express.Router();

/**
 * How each kind of image is processed.
 *
 * One size does not fit all: a portrait wants a square crop centred on the
 * face, while a research figure cropped square would lose half the diagram.
 *
 *   portrait  square, cropped to the most face-like region. Member cards and
 *             the lab in-charge frames.
 *   figure    fits inside a box, aspect ratio preserved, never cropped. A
 *             graphical abstract or result panel next to a publication.
 *   gallery   same as figure but larger, plus a thumbnail for the grid.
 */
const VARIANTS = {
  portrait: { width: 600, height: 600, fit: 'cover', position: 'attention', thumb: 0, lossless: false },
  figure:   { width: 1400, height: 1400, fit: 'inside', position: 'centre', thumb: 0, lossless: true },
  gallery:  { width: 1600, height: 1600, fit: 'inside', position: 'centre', thumb: 400, lossless: false },
};

const DEFAULT_VARIANT = 'portrait';

// Kept for the existing callers and tests that refer to the portrait size.
const MAX_DIMENSION = VARIANTS.portrait.width;

// Largest upload accepted, before re-encoding. A photo straight off a phone is
// 3-8 MB; 12 MB leaves room without letting someone fill the database.
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

// Refuse absurd pixel dimensions before decoding. A "decompression bomb" is a
// small file that expands to gigabytes in memory — 100 megapixels is far beyond
// any real portrait.
const MAX_PIXELS = 100 * 1000 * 1000;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 },
  fileFilter(req, file, cb) {
    // A first, cheap filter. It is NOT the security boundary — the browser
    // chooses this content type and a caller can send anything. The real check
    // is that sharp must be able to decode the bytes as an image.
    if (!/^image\/(jpeg|png|webp|gif|avif|tiff|heic|heif)$/i.test(file.mimetype)) {
      const err = new Error('That file is not an image. Use JPEG, PNG, WebP or HEIC.');
      err.status = 400;
      return cb(err);
    }
    cb(null, true);
  },
});

/**
 * POST /api/photos   (admin only)
 *
 * Accepts one file field named "photo" and returns { id, url, width, height }.
 *
 * THE SECURITY MODEL IS THE RE-ENCODE
 * -----------------------------------
 * The uploaded bytes are never stored and never served. sharp decodes the image
 * and writes a brand new JPEG from the decoded pixels, which means:
 *
 *   - A file that is not really an image fails to decode and is rejected. The
 *     filename and the declared content type are irrelevant; only whether it is
 *     a decodable image counts.
 *   - A polyglot — a file that is a valid image AND valid HTML or JavaScript,
 *     the classic way to get stored XSS through an upload form — loses
 *     everything that is not pixel data. What comes out is pixels re-compressed
 *     into a fresh container.
 *   - EXIF goes with it, including GPS coordinates. Phone photographs routinely
 *     carry the location where they were taken; publishing a scholar's portrait
 *     should not publish their home address. sharp drops all metadata by
 *     default, and .rotate() with no argument applies the orientation tag
 *     first, so portraits are not left sideways once that tag is gone.
 *
 * Content-Type on the way out is then a constant this code chose, not anything
 * derived from the upload.
 */
router.post('/', requireAdmin, upload.single('photo'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: 'No file received. Choose an image first.' });
    }

    const variantName = Object.prototype.hasOwnProperty.call(
      VARIANTS, String((req.body && req.body.variant) || '')
    ) ? String(req.body.variant) : DEFAULT_VARIANT;
    const V = VARIANTS[variantName];

    let image = sharp(req.file.buffer, { failOn: 'error', limitInputPixels: MAX_PIXELS });

    let meta;
    try {
      meta = await image.metadata();
    } catch (err) {
      return res.status(400).json({
        error: 'That file could not be read as an image. It may be corrupt, or not really an image.',
      });
    }

    if (!meta.width || !meta.height) {
      return res.status(400).json({ error: 'That image has no readable dimensions.' });
    }

    // An animated GIF or WebP would lose its animation; say so rather than
    // silently flattening it to the first frame.
    if (meta.pages && meta.pages > 1) {
      return res.status(400).json({
        error: 'Animated images are not supported for photographs. Upload a still image.',
      });
    }

    let output;
    let outMeta;
    let contentType = 'image/jpeg';
    let thumb = null;
    let thumbMeta = null;

    try {
      // .rotate() with no argument applies the EXIF orientation tag before all
      // metadata is dropped, so a portrait shot on a phone is not left sideways.
      const base = () => sharp(req.file.buffer, { failOn: 'error', limitInputPixels: MAX_PIXELS }).rotate();

      const fitted = () => base().resize(V.width, V.height, {
        fit: V.fit,
        position: V.position,
        withoutEnlargement: V.fit === 'inside',
      });

      const asJpeg = await fitted()
        .jpeg({ quality: 82, mozjpeg: true, progressive: true })
        .toBuffer({ resolveWithObject: true });

      output = asJpeg.data;
      outMeta = asJpeg.info;
      contentType = 'image/jpeg';

      // A research figure is usually a diagram: flat colour, sharp edges, text
      // labels. JPEG is the wrong codec for that — it blurs the text and can
      // come out LARGER than the PNG it started as. So for figures, encode both
      // and keep whichever is smaller. A photograph stays JPEG because its PNG
      // would be several times the size; a line drawing becomes PNG and stays
      // crisp. Measured rather than guessed, per image.
      if (V.lossless) {
        const asPng = await fitted()
          .png({ compressionLevel: 9, palette: true })
          .toBuffer({ resolveWithObject: true });

        if (asPng.data.length < asJpeg.data.length) {
          output = asPng.data;
          outMeta = asPng.info;
          contentType = 'image/png';
        }
      }

      if (V.thumb) {
        const t = await base()
          .resize(V.thumb, V.thumb, { fit: 'cover', position: 'attention' })
          .jpeg({ quality: 78, mozjpeg: true })
          .toBuffer({ resolveWithObject: true });
        thumb = t.data;
        thumbMeta = t.info;
      }
    } catch (err) {
      return res.status(400).json({
        error: 'That image could not be processed. Try re-saving it as a JPEG or PNG.',
      });
    }

    const doc = await Photo.create({
      data: output,
      contentType,
      variant: variantName,
      width: outMeta.width,
      height: outMeta.height,
      thumb,
      thumbWidth: thumbMeta ? thumbMeta.width : null,
      thumbHeight: thumbMeta ? thumbMeta.height : null,
      bytes: output.length,
      usage: String((req.body && req.body.usage) || '').slice(0, 120),
      alt: String((req.body && req.body.alt) || '').slice(0, 200),
    });

    res.status(201).json({
      id: String(doc._id),
      variant: variantName,
      contentType,
      // Root-relative on purpose. The public site prepends its configured API
      // base, so the same value works whether the pages are served by this host
      // or from GitHub Pages against a different origin.
      url: '/api/photos/' + doc._id,
      width: doc.width,
      height: doc.height,
      thumbUrl: thumb ? '/api/photos/' + doc._id + '?size=thumb' : null,
      bytes: doc.bytes,
      originalBytes: req.file.size,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/photos/:id   (public)
 *
 * Cross-origin readable, because the public pages may be served from GitHub
 * Pages while this API lives elsewhere.
 */
router.get('/:id', publicCors, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Not a valid photo id.' });
    }

    const photo = await Photo.findById(req.params.id).lean();
    if (!photo || !photo.data) {
      return res.status(404).json({ error: 'No such photo.' });
    }

    // ?size=thumb serves the small version where one exists, so a gallery grid
    // pulls 400px files rather than twenty 1600px ones. Falls back to the full
    // image rather than 404ing, so a caller never has to know which variants
    // carry a thumbnail.
    const wantThumb = String(req.query.size || '') === 'thumb';
    const body = wantThumb && photo.thumb ? photo.thumb : photo.data;
    const isThumb = body === photo.thumb;

    // The bytes for a given id never change — a replacement gets a new id — so
    // this can be cached hard and revalidated with an ETag.
    const etag = '"' + String(photo._id) + (isThumb ? '-t' : '-f') + '-' + body.length + '"';

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.set({
      'Content-Type': photo.contentType,        // from our enum, never from the upload
      'Content-Length': String(body.length),
      Vary: 'Origin',
      'Cache-Control': 'public, max-age=31536000, immutable',
      ETag: etag,
      // Belt and braces: even though the type is one we chose, tell the browser
      // not to sniff, and to display rather than execute in a document context.
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
    });

    res.send(body);
  } catch (err) {
    next(err);
  }
});

/** GET /api/photos  (admin) — metadata only, never the bytes. */
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const rows = await Photo.find({})
      .select(Photo.metaFields)
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    // Mark which are actually referenced, so orphans are visible.
    const inUse = new Set(
      (await Member.find({ photo: { $ne: '' } }).select('photo').lean())
        .map((m) => String(m.photo).split('/').pop())
    );

    res.json(
      rows.map((p) => ({
        ...p,
        url: '/api/photos/' + p._id,
        inUse: inUse.has(String(p._id)),
      }))
    );
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/photos/:id  (admin) */
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ error: 'Not a valid photo id.' });
    }

    // Refuse to orphan a member's portrait by accident.
    const user = await Member.findOne({ photo: new RegExp(req.params.id + '$') })
      .select('name')
      .lean();
    if (user && !('force' in req.query)) {
      return res.status(409).json({
        error: `That photo is still used by "${user.name}". Change their photo first, ` +
               'or add ?force=1 to delete it anyway.',
      });
    }

    const doc = await Photo.findByIdAndDelete(req.params.id);
    if (!doc) return res.status(404).json({ error: 'No such photo.' });

    res.json({ ok: true, deleted: String(doc._id) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.MAX_UPLOAD_BYTES = MAX_UPLOAD_BYTES;
module.exports.MAX_DIMENSION = MAX_DIMENSION;
module.exports.VARIANTS = VARIANTS;

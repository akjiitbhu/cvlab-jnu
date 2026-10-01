'use strict';

const express = require('express');
const multer = require('multer');

const store = require('../storage/files');
const { requireAdmin } = require('../middleware/auth');
const { publicCors } = require('../middleware/cors');

const router = express.Router();

// A slide deck is 5-20 MB; a dataset can be larger. 64 MB is generous without
// letting one upload swallow a free cluster's whole 512 MB budget.
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 6 },
  fileFilter(req, file, cb) {
    // Notebooks arrive as application/octet-stream from some browsers, so allow
    // the extension to vouch for a generic type — but never for a type on the
    // NEVER list, which isAllowed already refuses.
    const looksLikeNotebook = /\.ipynb$/i.test(file.originalname || '');
    if (looksLikeNotebook && /^(application\/octet-stream|application\/json)$/i.test(file.mimetype)) {
      file.mimetype = 'application/x-ipynb+json';
    }

    if (!store.isAllowed(file.mimetype)) {
      const err = new Error(
        `"${file.mimetype || 'unknown'}" files are not accepted. Upload a PDF, notebook, ` +
        'Office document, CSV, ZIP or image.'
      );
      err.status = 415;
      return cb(err);
    }
    cb(null, true);
  },
});

/** POST /api/files  (admin) — store one course material or dataset. */
router.post('/', requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file || !req.file.buffer || !req.file.buffer.length) {
      return res.status(400).json({ error: 'No file received. Choose a file first.' });
    }

    const saved = await store.put(req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
      label: String((req.body && req.body.label) || '').slice(0, 200),
      usage: String((req.body && req.body.usage) || '').slice(0, 120),
    });

    // Report the storage position back so the editor can warn in good time.
    let quota = null;
    try {
      quota = await store.usage();
    } catch (err) {
      /* a stats failure must not fail the upload */
    }

    res.status(201).json({ ...saved, quota });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/files/:id  (public) — stream a stored file.
 *
 * SERVING UNTRUSTED FILES SAFELY
 * These are arbitrary documents, not re-encoded images, so the protection has
 * to come from the response headers rather than from the bytes:
 *
 *   - `Content-Type` comes from our own allow-list, never from the request.
 *   - `X-Content-Type-Options: nosniff` stops a browser deciding a .csv is
 *     really HTML and running it.
 *   - `Content-Disposition: attachment` for everything except PDFs and images,
 *     so a document downloads rather than rendering in the site's origin. That
 *     is what keeps a malicious upload from becoming stored XSS.
 *   - `Content-Security-Policy: sandbox` as a second line for the types that do
 *     render inline.
 */
router.get('/:id', publicCors, async (req, res, next) => {
  try {
    const file = await store.findById(req.params.id);
    if (!file) return res.status(404).json({ error: 'No such file.' });

    const type = file.contentType || 'application/octet-stream';
    const inlineOk = /^(application\/pdf|image\/(png|jpeg))$/i.test(type);
    const etag = '"' + String(file._id) + '-' + file.length + '"';

    if (req.headers['if-none-match'] === etag) return res.status(304).end();

    res.set({
      'Content-Type': type,
      'Content-Length': String(file.length),
      'Cache-Control': 'public, max-age=86400',
      ETag: etag,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'",
      'Content-Disposition':
        (inlineOk ? 'inline' : 'attachment') +
        '; filename="' + store.safeName(file.filename) + '"',
    });

    const stream = store.openDownloadStream(file._id);
    stream.on('error', (err) => {
      if (!res.headersSent) return next(err);
      res.destroy();
    });
    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

/** GET /api/files  (admin) — the library, plus storage usage. */
router.get('/', requireAdmin, async (req, res, next) => {
  try {
    const [files, quota] = await Promise.all([
      store.list(),
      store.usage().catch(() => null),
    ]);
    res.json({ files, quota });
  } catch (err) {
    next(err);
  }
});

/** DELETE /api/files/:id  (admin) */
router.delete('/:id', requireAdmin, async (req, res, next) => {
  try {
    const gone = await store.remove(req.params.id);
    if (!gone) return res.status(404).json({ error: 'No such file.' });
    res.json({ ok: true, deleted: req.params.id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.MAX_FILE_BYTES = MAX_FILE_BYTES;

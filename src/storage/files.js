'use strict';

const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Document storage on GridFS.
 *
 * WHY GRIDFS AND NOT A PLAIN DOCUMENT
 * -----------------------------------
 * Photographs are re-encoded down to a few kilobytes, so they sit happily
 * inside a Photo document. Course materials do not: a slide deck is 5-20 MB and
 * a dataset can be far more, while a MongoDB document is capped at 16 MB.
 * GridFS splits a file into chunks across two collections and streams it back,
 * so size stops being a design constraint.
 *
 * It also keeps the property that makes backups simple: `mongodump` captures
 * GridFS along with everything else, so one archive still restores the entire
 * site — pages, content, photographs and course materials together. Putting
 * files on a disk or in a separate object store would mean two backups that can
 * drift apart, and on a host with an ephemeral filesystem the disk copy would
 * not survive a redeploy at all.
 *
 * STORAGE QUOTA — READ THIS BEFORE UPLOADING A SEMESTER OF SLIDES
 * A MongoDB Atlas M0 (free) cluster gives 512 MB TOTAL, and that budget covers
 * documents, indexes and GridFS together. Perhaps 30-60 lecture decks. usage()
 * below reports what has been consumed so the editor can warn rather than
 * letting an upload fail mysteriously at the cluster level.
 */

const BUCKET = 'materials';

/** Mime types accepted for course materials, mapped to a sane extension. */
const ALLOWED = new Map([
  ['application/pdf', 'pdf'],
  ['application/zip', 'zip'],
  ['application/x-zip-compressed', 'zip'],
  ['text/csv', 'csv'],
  ['text/plain', 'txt'],
  ['text/markdown', 'md'],
  ['application/json', 'json'],           // also .ipynb
  ['application/x-ipynb+json', 'ipynb'],
  ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  ['application/vnd.ms-excel', 'xls'],
  ['application/msword', 'doc'],
  ['application/vnd.ms-powerpoint', 'ppt'],
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
]);

/**
 * Types a browser will happily execute or render as a document if it is talked
 * into treating our response as one. None of these are legitimate course
 * material, and all of them are dangerous served from the site's own origin.
 */
const NEVER = /^(text\/html|application\/xhtml|image\/svg|application\/javascript|text\/javascript|application\/xml|text\/xml)/i;

function bucket() {
  const conn = mongoose.connection;
  if (!conn || conn.readyState !== 1) {
    const err = new Error('The database is not connected, so files cannot be stored.');
    err.status = 503;
    throw err;
  }
  return new mongoose.mongo.GridFSBucket(conn.db, { bucketName: BUCKET });
}

/**
 * Make a filename safe to put in a Content-Disposition header and in a URL.
 *
 * The browser supplies this, so it is untrusted: it can contain quotes, CR/LF
 * (header injection), path separators, or 300 characters of unicode. Rebuild it
 * from a conservative character set rather than trying to strip what is bad.
 */
function safeName(raw, fallbackExt) {
  let name = String(raw || '').split(/[\\/]/).pop() || '';
  name = name.normalize('NFKD').replace(/[^\w.\- ]+/g, '').trim();
  name = name.replace(/\s+/g, '-').replace(/-{2,}/g, '-').replace(/^[.\-]+/, '');

  if (!name) name = 'file';
  if (name.length > 80) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '';
    name = name.slice(0, 80 - ext.length) + ext;
  }
  if (fallbackExt && !/\.[A-Za-z0-9]{1,8}$/.test(name)) name += '.' + fallbackExt;
  return name;
}

function isAllowed(mimetype) {
  if (NEVER.test(String(mimetype || ''))) return false;
  return ALLOWED.has(String(mimetype || '').toLowerCase());
}

/** Store a buffer. Resolves to the metadata the API returns. */
function put(buffer, { filename, contentType, label = '', usage = '' }) {
  return new Promise((resolve, reject) => {
    const ext = ALLOWED.get(String(contentType).toLowerCase()) || '';
    const name = safeName(filename, ext);
    const sha = crypto.createHash('sha256').update(buffer).digest('hex');

    const stream = bucket().openUploadStream(name, {
      contentType,
      metadata: { label, usage, sha256: sha, uploadedAt: new Date() },
    });

    stream.on('error', reject);
    stream.on('finish', () => {
      resolve({
        id: String(stream.id),
        filename: name,
        contentType,
        bytes: buffer.length,
        sha256: sha,
        url: '/api/files/' + stream.id,
      });
    });

    stream.end(buffer);
  });
}

async function findById(id) {
  if (!mongoose.isValidObjectId(id)) return null;
  const files = await bucket()
    .find({ _id: new mongoose.Types.ObjectId(String(id)) })
    .limit(1)
    .toArray();
  return files[0] || null;
}

function openDownloadStream(id, opts) {
  return bucket().openDownloadStream(new mongoose.Types.ObjectId(String(id)), opts);
}

async function list(limit = 500) {
  const files = await bucket().find({}).sort({ uploadDate: -1 }).limit(limit).toArray();
  return files.map((f) => ({
    id: String(f._id),
    filename: f.filename,
    contentType: f.contentType,
    bytes: f.length,
    uploadedAt: f.uploadDate,
    label: (f.metadata && f.metadata.label) || '',
    usage: (f.metadata && f.metadata.usage) || '',
    url: '/api/files/' + f._id,
  }));
}

async function remove(id) {
  if (!mongoose.isValidObjectId(id)) return false;
  try {
    await bucket().delete(new mongoose.Types.ObjectId(String(id)));
    return true;
  } catch (err) {
    // The driver throws when the id does not exist; that is a 404, not a 500.
    if (/File not found|FileNotFound/i.test(err.message)) return false;
    throw err;
  }
}

/**
 * How much of the cluster's storage has been used.
 *
 * Reported so the editor can warn before an upload pushes a free Atlas cluster
 * over its 512 MB ceiling, which otherwise surfaces as a confusing write error.
 */
async function usage() {
  const conn = mongoose.connection;
  if (!conn || conn.readyState !== 1) return null;

  const stats = await conn.db.command({ dbStats: 1, scale: 1 });
  const files = await bucket().find({}).toArray();
  const fileBytes = files.reduce((sum, f) => sum + (f.length || 0), 0);

  return {
    fileCount: files.length,
    fileBytes,
    databaseBytes: stats.dataSize + (stats.indexSize || 0),
    storageBytes: stats.storageSize || 0,
  };
}

module.exports = {
  BUCKET,
  ALLOWED,
  put,
  findById,
  openDownloadStream,
  list,
  remove,
  usage,
  safeName,
  isAllowed,
};

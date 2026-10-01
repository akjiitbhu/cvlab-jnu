'use strict';

const express = require('express');
const mongoose = require('mongoose');
const { requireAdmin, attachAdmin } = require('../middleware/auth');

/**
 * Builds a REST router for one model.
 *
 *   GET    /            public   list (admins also see hidden items)
 *   GET    /:id         public
 *   POST   /            admin    create
 *   PUT    /:id         admin    replace the given fields
 *   DELETE /:id         admin
 *   POST   /reorder     admin    apply a new order to several documents
 *
 * `fields` is an allow-list. Anything a client sends that is not on it is
 * dropped, so a crafted request cannot set `_id`, `createdAt`, or a field the
 * schema happens to gain later.
 */
function crudRouter(Model, options) {
  const opts = options || {};
  const fields = opts.fields || [];
  const sort = opts.sort || { order: 1, _id: 1 };
  const router = express.Router();

  function pick(body) {
    const out = {};
    if (!body || typeof body !== 'object') return out;
    for (const key of fields) {
      if (Object.prototype.hasOwnProperty.call(body, key)) out[key] = body[key];
    }
    return out;
  }

  function isAdminRequest(req) {
    return Boolean(req.admin);
  }

  router.get('/', attachAdmin, async (req, res, next) => {
    try {
      const filter = {};

      // Visitors never see hidden rows; the admin editor needs them.
      if (!isAdminRequest(req)) filter.visible = { $ne: false };

      if (req.query.kind) filter.kind = String(req.query.kind);
      if (req.query.group) filter.group = String(req.query.group);

      const docs = await Model.find(filter).sort(sort).limit(2000);
      res.json(docs);
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ error: 'Not a valid id.' });
      }
      const doc = await Model.findById(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Not found.' });
      res.json(doc);
    } catch (err) {
      next(err);
    }
  });

  router.post('/', requireAdmin, async (req, res, next) => {
    try {
      const doc = await Model.create(pick(req.body));
      res.status(201).json(doc);
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id', requireAdmin, async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ error: 'Not a valid id.' });
      }
      const doc = await Model.findByIdAndUpdate(
        req.params.id,
        { $set: pick(req.body) },
        { new: true, runValidators: true }
      );
      if (!doc) return res.status(404).json({ error: 'Not found.' });
      res.json(doc);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:id', requireAdmin, async (req, res, next) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) {
        return res.status(400).json({ error: 'Not a valid id.' });
      }
      const doc = await Model.findByIdAndDelete(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Not found.' });
      res.json({ ok: true, deleted: doc._id });
    } catch (err) {
      next(err);
    }
  });

  router.post('/reorder', requireAdmin, async (req, res, next) => {
    try {
      const items = Array.isArray(req.body && req.body.items) ? req.body.items : null;
      if (!items) {
        return res.status(400).json({ error: 'Send { items: [{ id, order }, ...] }.' });
      }
      const ops = items
        .filter((i) => i && mongoose.isValidObjectId(i.id) && Number.isFinite(Number(i.order)))
        .map((i) => ({
          updateOne: {
            filter: { _id: i.id },
            update: { $set: { order: Number(i.order) } },
          },
        }));
      if (ops.length === 0) return res.json({ ok: true, updated: 0 });
      const result = await Model.bulkWrite(ops);
      res.json({ ok: true, updated: result.modifiedCount });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = { crudRouter };

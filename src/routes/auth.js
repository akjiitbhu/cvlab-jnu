'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const AdminUser = require('../models/AdminUser');
const {
  issueToken,
  setSessionCookie,
  clearSessionCookie,
  requireAdmin,
} = require('../middleware/auth');

const router = express.Router();

const MAX_FAILED = 8;
const LOCK_MINUTES = 15;

/**
 * Per-IP limit, in front of the per-account lockout below. The two cover
 * different attacks: this one slows a flood from one host, the account lock
 * stops a slow distributed guess at one password.
 */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Try again in a few minutes.' },
});

router.post('/login', loginLimiter, async (req, res, next) => {
  try {
    const username = String((req.body && req.body.username) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');

    if (!username || !password) {
      return res.status(400).json({ error: 'Enter your username and password.' });
    }

    const user = await AdminUser.findOne({ username }).select('+passwordHash');

    // Same message and roughly the same work whether the account exists or not,
    // so the response cannot be used to enumerate usernames.
    const genericFailure = { error: 'Incorrect username or password.' };

    if (!user) {
      await AdminUser.hashPassword(password); // equalise timing
      return res.status(401).json(genericFailure);
    }

    if (user.isLocked()) {
      const mins = Math.ceil((user.lockedUntil - Date.now()) / 60000);
      return res.status(423).json({
        error: `Account locked after too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`,
      });
    }

    const ok = await user.verifyPassword(password);

    if (!ok) {
      user.failedAttempts = (user.failedAttempts || 0) + 1;
      if (user.failedAttempts >= MAX_FAILED) {
        user.lockedUntil = new Date(Date.now() + LOCK_MINUTES * 60 * 1000);
        user.failedAttempts = 0;
      }
      await user.save();
      return res.status(401).json(genericFailure);
    }

    user.failedAttempts = 0;
    user.lockedUntil = null;
    user.lastLoginAt = new Date();
    await user.save();

    setSessionCookie(res, issueToken(user));

    res.json({
      ok: true,
      user: { username: user.username, displayName: user.displayName },
    });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/** Lets the admin page decide whether to show the login form or the editor. */
router.get('/me', requireAdmin, (req, res) => {
  res.json({
    user: {
      username: req.admin.username,
      displayName: req.admin.displayName,
      lastLoginAt: req.admin.lastLoginAt,
    },
  });
});

router.post('/change-password', requireAdmin, async (req, res, next) => {
  try {
    const current = String((req.body && req.body.currentPassword) || '');
    const next_ = String((req.body && req.body.newPassword) || '');

    if (next_.length < 12) {
      return res.status(400).json({
        error: 'The new password must be at least 12 characters.',
      });
    }

    const user = await AdminUser.findById(req.admin._id).select('+passwordHash');
    if (!(await user.verifyPassword(current))) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    user.passwordHash = await AdminUser.hashPassword(next_);
    user.tokenVersion += 1; // signs out every other session
    await user.save();

    setSessionCookie(res, issueToken(user)); // keep this session signed in
    res.json({ ok: true, message: 'Password changed. Other sessions were signed out.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

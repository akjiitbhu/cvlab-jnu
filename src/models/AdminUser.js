'use strict';

const { Schema, model } = require('mongoose');
const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 12;

/**
 * The single administrator account.
 *
 * Only the bcrypt hash is stored — the plaintext password is never written to
 * the database, to a log, or to a response. `select: false` on passwordHash
 * means an accidental `AdminUser.find()` in a route cannot leak it.
 */
const AdminUserSchema = new Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      minlength: 3,
      maxlength: 60,
    },

    passwordHash: { type: String, required: true, select: false },

    displayName: { type: String, trim: true, default: '', maxlength: 120 },

    lastLoginAt: { type: Date, default: null },

    // Bumping this invalidates every issued token at once — used by
    // "sign out everywhere" and automatically on a password change.
    tokenVersion: { type: Number, default: 0 },

    // Brute-force throttling, persisted so a process restart does not reset it.
    failedAttempts: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
  },
  { timestamps: true }
);

AdminUserSchema.statics.hashPassword = function (plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
};

AdminUserSchema.methods.verifyPassword = function (plain) {
  if (!this.passwordHash) return Promise.resolve(false);
  return bcrypt.compare(plain, this.passwordHash);
};

AdminUserSchema.methods.isLocked = function () {
  return Boolean(this.lockedUntil && this.lockedUntil > new Date());
};

module.exports = model('AdminUser', AdminUserSchema);
module.exports.BCRYPT_ROUNDS = BCRYPT_ROUNDS;

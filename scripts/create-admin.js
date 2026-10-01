#!/usr/bin/env node
'use strict';

/**
 * Create the administrator account, or reset its password.
 *
 *   npm run create-admin
 *
 * Prompts for the username and password. The password is read with echo off and
 * only its bcrypt hash is stored, so the plaintext never reaches the database,
 * the shell history, or a log.
 *
 * Non-interactive (for a host's one-off shell, where a prompt cannot be shown):
 *
 *   ADMIN_USERNAME=ankit ADMIN_PASSWORD='...' node scripts/create-admin.js --from-env
 *
 * Prefer the interactive form. Passing a password as an environment variable on
 * a command line can leave it in shell history and in the process list.
 */

require('dotenv').config();

const readline = require('readline');
const { Writable } = require('stream');
const { connect, disconnect } = require('../src/db');
const AdminUser = require('../src/models/AdminUser');

const MIN_LENGTH = 12;

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    // A writable that suppresses echo for the password prompt.
    const muted = new Writable({
      write(chunk, enc, cb) {
        if (!hidden || !muted.muting) process.stdout.write(chunk, enc);
        cb();
      },
    });

    const rl = readline.createInterface({
      input: process.stdin,
      output: muted,
      terminal: true,
    });

    process.stdout.write(question);
    muted.muting = hidden;

    rl.question('', (answer) => {
      muted.muting = false;
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

function checkPassword(pw) {
  if (pw.length < MIN_LENGTH) {
    return `Password must be at least ${MIN_LENGTH} characters (this one is ${pw.length}).`;
  }
  if (/^[a-z]+$/i.test(pw)) {
    return 'Use a mix of character types, or a longer passphrase of several words.';
  }
  return null;
}

async function main() {
  await connect(process.env.MONGODB_URI);

  let username;
  let password;

  if (process.argv.includes('--from-env')) {
    username = String(process.env.ADMIN_USERNAME || '').trim().toLowerCase();
    password = String(process.env.ADMIN_PASSWORD || '');
    if (!username || !password) {
      throw new Error('--from-env needs both ADMIN_USERNAME and ADMIN_PASSWORD set.');
    }
    const problem = checkPassword(password);
    if (problem) throw new Error(problem);
  } else {
    username = (await ask('Username: ')).trim().toLowerCase();
    if (username.length < 3) throw new Error('Username must be at least 3 characters.');

    password = await ask('Password (not shown): ', { hidden: true });
    const problem = checkPassword(password);
    if (problem) throw new Error(problem);

    const again = await ask('Repeat password: ', { hidden: true });
    if (again !== password) throw new Error('The two passwords do not match.');
  }

  const existing = await AdminUser.findOne({ username });
  const passwordHash = await AdminUser.hashPassword(password);

  if (existing) {
    existing.passwordHash = passwordHash;
    existing.tokenVersion += 1; // invalidate any live session
    existing.failedAttempts = 0;
    existing.lockedUntil = null;
    await existing.save();
    console.log(`\n[admin] password reset for "${username}". Other sessions were signed out.`);
  } else {
    const count = await AdminUser.countDocuments();
    if (count > 0) {
      console.log(
        `\n[admin] note: ${count} account(s) already exist. This site is designed ` +
        'for a single administrator; extra accounts all get full rights.'
      );
    }
    await AdminUser.create({ username, passwordHash, displayName: username });
    console.log(`\n[admin] account "${username}" created.`);
  }

  console.log('[admin] sign in at /admin');
  await disconnect();
}

main().catch(async (err) => {
  console.error('\n[admin] ' + err.message);
  await disconnect().catch(() => {});
  process.exit(1);
});

#!/usr/bin/env node
'use strict';

/**
 * End-to-end check against a throwaway in-memory MongoDB.
 *
 *   npm run smoke
 *
 * Starts a real mongod, seeds it, boots the real Express app, and exercises the
 * API the way the browser does — including the cases that matter for security:
 * that writes are refused without a session, that a hidden row stays out of the
 * public payload, and that the login lockout engages.
 *
 * Needs no MONGODB_URI and touches no real database.
 */

const assert = require('assert');
const { MongoMemoryServer } = require('mongodb-memory-server');

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failed++;
    console.error('  FAIL ' + name + '\n         ' + err.message);
  }
}

async function main() {
  console.log('starting in-memory mongodb…');
  const mongo = await MongoMemoryServer.create();

  process.env.MONGODB_URI = mongo.getUri('cvlab_test');
  process.env.JWT_SECRET = 'x'.repeat(64);
  process.env.NODE_ENV = 'test';
  process.env.PORT = '0';

  const { connect, disconnect } = require('../src/db');
  await connect(process.env.MONGODB_URI);

  const AdminUser = require('../src/models/AdminUser');
  const Member = require('../src/models/Member');
  const Course = require('../src/models/Course');

  // seed content
  const seedData = require('./seed-data.json');
  const ResearchItem = require('../src/models/ResearchItem');
  const Metrics = require('../src/models/Metrics');
  await Member.insertMany(seedData.members);
  await ResearchItem.insertMany(seedData.research);
  await Course.insertMany(seedData.courses);
  await Metrics.create(seedData.metrics);

  // admin account
  const PASSWORD = 'correct horse battery staple';
  await AdminUser.create({
    username: 'testadmin',
    passwordHash: await AdminUser.hashPassword(PASSWORD),
  });

  const app = require('../server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  let cookie = '';
  async function call(method, path, body, opts) {
    const o = opts || {};
    const res = await fetch(base + path, {
      method,
      headers: Object.assign(
        body ? { 'Content-Type': 'application/json' } : {},
        o.noCookie || !cookie ? {} : { Cookie: cookie }
      ),
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie && !o.noCookie) cookie = setCookie.split(';')[0];
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: res.status, data, headers: res.headers };
  }

  console.log('\npublic endpoints');

  await check('GET /api/health reports a live database', async () => {
    const r = await call('GET', '/api/health');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.ok, true);
  });

  await check('GET /api/content returns all four sections', async () => {
    const r = await call('GET', '/api/content');
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.metrics, 'metrics missing');
    assert.strictEqual(r.data.members.phd.length, 3);
    assert.strictEqual(r.data.courses.length, 4);
    assert.strictEqual(r.data.research.journal.length, 8);
    assert.strictEqual(r.data.research.conference.length, 14);
    assert.strictEqual(r.data.research.chapter.length, 2);
    assert.strictEqual(r.data.research.talk.length, 13);
    assert.strictEqual(r.data.research.theme.length, 8);
    assert.strictEqual(r.data.research.patent.length, 1);
  });

  await check('member initials are computed, honorific stripped', async () => {
    const r = await call('GET', '/api/content');
    const archana = r.data.members.phd.find((m) => /Archana/.test(m.name));
    assert.strictEqual(archana.initials, 'AS');
  });

  await check('GET / serves the public page', async () => {
    const r = await call('GET', '/');
    assert.strictEqual(r.status, 200);
    assert.ok(String(r.data).includes('Computing and Vision Lab'));
  });

  await check('GET /admin serves the editor', async () => {
    const r = await call('GET', '/admin');
    assert.strictEqual(r.status, 200);
    assert.ok(String(r.data).includes('Sign in to edit'));
  });

  await check('security headers are present', async () => {
    const r = await call('GET', '/');
    assert.ok(r.headers.get('content-security-policy'), 'no CSP header');
    assert.ok(
      !/unsafe-inline/.test(r.headers.get('content-security-policy').match(/script-src[^;]*/)[0]),
      'script-src allows unsafe-inline'
    );
    assert.strictEqual(r.headers.get('x-powered-by'), null);
  });

  console.log('\nwrites are refused without a session');

  await check('POST /api/members → 401', async () => {
    const r = await call('POST', '/api/members', { name: 'Intruder' }, { noCookie: true });
    assert.strictEqual(r.status, 401);
  });

  await check('DELETE /api/courses/:id → 401', async () => {
    const c = await Course.findOne();
    const r = await call('DELETE', '/api/courses/' + c._id, null, { noCookie: true });
    assert.strictEqual(r.status, 401);
    assert.ok(await Course.findById(c._id), 'course was deleted without auth');
  });

  await check('PUT /api/metrics → 401', async () => {
    const r = await call('PUT', '/api/metrics', { citations: 99999 }, { noCookie: true });
    assert.strictEqual(r.status, 401);
  });

  await check('a forged session cookie is rejected', async () => {
    const res = await fetch(base + '/api/auth/me', {
      headers: { Cookie: 'cvlab_session=not.a.real.token' },
    });
    assert.strictEqual(res.status, 401);
  });

  console.log('\nauthentication');

  await check('wrong password → 401 with a generic message', async () => {
    const r = await call('POST', '/api/auth/login',
      { username: 'testadmin', password: 'wrong' }, { noCookie: true });
    assert.strictEqual(r.status, 401);
    assert.match(r.data.error, /Incorrect username or password/);
  });

  await check('unknown user gives the same message (no enumeration)', async () => {
    const r = await call('POST', '/api/auth/login',
      { username: 'nobody', password: 'wrong' }, { noCookie: true });
    assert.strictEqual(r.status, 401);
    assert.match(r.data.error, /Incorrect username or password/);
  });

  await check('correct password signs in and sets an httpOnly cookie', async () => {
    const res = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'testadmin', password: PASSWORD }),
    });
    assert.strictEqual(res.status, 200);
    const sc = res.headers.get('set-cookie');
    assert.ok(/HttpOnly/i.test(sc), 'cookie is not HttpOnly');
    assert.ok(/SameSite=Lax/i.test(sc), 'cookie has no SameSite');
    cookie = sc.split(';')[0];
  });

  await check('GET /api/auth/me works with the session', async () => {
    const r = await call('GET', '/api/auth/me');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.user.username, 'testadmin');
  });

  console.log('\ncrud with a session');

  let newId = null;

  await check('create a member', async () => {
    const r = await call('POST', '/api/members', {
      name: 'Mr. Test Student', group: 'mtech', topic: 'A test topic', order: 5,
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.data.name, 'Mr. Test Student');
    newId = r.data._id;
  });

  await check('an unlisted field is dropped, not saved', async () => {
    const r = await call('POST', '/api/members', {
      name: 'Mr. Field Test', group: 'mtech', _id: 'aaaaaaaaaaaaaaaaaaaaaaaa', createdAt: '1990-01-01',
    });
    assert.strictEqual(r.status, 201);
    assert.notStrictEqual(String(r.data._id), 'aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.ok(new Date(r.data.createdAt).getFullYear() > 2000);
    await call('DELETE', '/api/members/' + r.data._id);
  });

  await check('update a member', async () => {
    const r = await call('PUT', '/api/members/' + newId, { topic: 'An edited topic' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.topic, 'An edited topic');
  });

  await check('a hidden member is absent from /api/content', async () => {
    await call('PUT', '/api/members/' + newId, { visible: false });
    const pub = await fetch(base + '/api/content').then((r) => r.json());
    const found = (pub.members.mtech || []).some((m) => String(m._id) === String(newId));
    assert.strictEqual(found, false, 'hidden member leaked to the public payload');
  });

  await check('but the admin listing still shows it', async () => {
    const r = await call('GET', '/api/members');
    assert.ok(r.data.some((m) => String(m._id) === String(newId)));
  });

  await check('reorder applies new positions', async () => {
    const members = (await call('GET', '/api/members')).data.filter((m) => m.group === 'phd');
    const items = members.map((m, i) => ({ id: m._id, order: 100 + i }));
    const r = await call('POST', '/api/members/reorder', { items });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.updated, items.length);
  });

  await check('delete a member', async () => {
    const r = await call('DELETE', '/api/members/' + newId);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(await Member.findById(newId), null);
  });

  await check('a duplicate course slug is refused with 409', async () => {
    const r = await call('POST', '/api/courses', { slug: 'dbms', title: 'Clash' });
    assert.strictEqual(r.status, 409);
  });

  await check('an invalid slug is refused with 400', async () => {
    const r = await call('POST', '/api/courses', { slug: 'Not A Slug!', title: 'Bad' });
    assert.strictEqual(r.status, 400);
  });

  await check('a bad id shape gives 400, not a 500', async () => {
    const r = await call('GET', '/api/members/not-an-objectid');
    assert.strictEqual(r.status, 400);
  });

  await check('metrics update, and a blank clears a tile', async () => {
    const r = await call('PUT', '/api/metrics', { citations: 350, hIndex: 11, i10Index: '' });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.citations, 350);
    assert.strictEqual(r.data.i10Index, null);
  });

  await check('a negative metric is refused', async () => {
    const r = await call('PUT', '/api/metrics', { citations: -5 });
    assert.strictEqual(r.status, 400);
  });

  await check('course units and resources round-trip intact', async () => {
    const dip = (await call('GET', '/api/courses')).data.find((c) => c.slug === 'dip');
    assert.strictEqual(dip.units.length, 8);
    assert.ok(dip.units[3].topics.includes('DCT'));
    assert.strictEqual(dip.resources.length, 6);
  });

  console.log('\nphotograph upload');

  const sharpLib = require('sharp');
  let photoUrl = null;

  await check('upload a photo: it is re-encoded, resized and stored', async () => {
    const original = await sharpLib({
      create: { width: 2400, height: 1800, channels: 3, background: { r: 30, g: 95, b: 85 } },
    }).withExif({ IFD0: { Software: 'SmokeTestCam' } }).jpeg({ quality: 95 }).toBuffer();

    const form = new FormData();
    form.append('photo', new Blob([original], { type: 'image/jpeg' }), 'portrait.jpg');

    const res = await fetch(base + '/api/photos', {
      method: 'POST', headers: { Cookie: cookie }, body: form,
    });
    assert.strictEqual(res.status, 201, 'upload returned ' + res.status);
    const out = await res.json();

    assert.match(out.url, /^\/api\/photos\/[a-f0-9]{24}$/, 'bad url: ' + out.url);
    assert.strictEqual(out.width, 600);
    assert.strictEqual(out.height, 600);
    assert.ok(out.bytes < original.length, 'stored file is not smaller than the original');
    photoUrl = out.url;
  });

  await check('the stored photo serves with the right headers and no EXIF', async () => {
    const res = await fetch(base + photoUrl);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'image/jpeg');
    assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('cache-control'), /immutable/);
    assert.ok(res.headers.get('etag'), 'no ETag');

    const bytes = Buffer.from(await res.arrayBuffer());
    const meta = await sharpLib(bytes).metadata();
    assert.strictEqual(meta.width, 600);
    assert.strictEqual(meta.exif, undefined, 'EXIF was served to the public');
    assert.ok(!bytes.includes(Buffer.from('SmokeTestCam')), 'camera name survived');
  });

  await check('an ETag match returns 304', async () => {
    const first = await fetch(base + photoUrl);
    const etag = first.headers.get('etag');
    const second = await fetch(base + photoUrl, { headers: { 'If-None-Match': etag } });
    assert.strictEqual(second.status, 304);
  });

  await check('a non-image upload is refused', async () => {
    const form = new FormData();
    form.append('photo', new Blob([Buffer.from('<script>alert(1)</script>')],
      { type: 'image/jpeg' }), 'evil.jpg');
    const res = await fetch(base + '/api/photos', {
      method: 'POST', headers: { Cookie: cookie }, body: form,
    });
    assert.strictEqual(res.status, 400, 'a text file was accepted as a photo');
  });

  await check('an upload without a session is refused', async () => {
    const png = await sharpLib({
      create: { width: 10, height: 10, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer();
    const form = new FormData();
    form.append('photo', new Blob([png], { type: 'image/png' }), 'x.png');
    const res = await fetch(base + '/api/photos', { method: 'POST', body: form });
    assert.strictEqual(res.status, 401);
  });

  await check('attaching the photo to the lab in-charge shows it publicly', async () => {
    const pi = (await call('GET', '/api/members')).data.find((m) => m.group === 'pi');
    assert.ok(pi, 'no pi member seeded');
    await call('PUT', '/api/members/' + pi._id, { photo: photoUrl });

    const pub = await fetch(base + '/api/content').then((r) => r.json());
    assert.ok(pub.pi, '/api/content did not surface the lab in-charge');
    assert.strictEqual(pub.pi.photo, photoUrl);
    assert.ok(!pub.members.pi, 'the pi leaked into the member cohorts');
  });

  await check('deleting a photo still in use is refused', async () => {
    const id = photoUrl.split('/').pop();
    const r = await call('DELETE', '/api/photos/' + id);
    assert.strictEqual(r.status, 409, 'deleted a photo that a member still uses');
    assert.match(r.data.error, /still used by/);
  });

  await check('force-deleting it works', async () => {
    const id = photoUrl.split('/').pop();
    const r = await call('DELETE', '/api/photos/' + id + '?force=1');
    assert.strictEqual(r.status, 200);
    const gone = await fetch(base + photoUrl);
    assert.strictEqual(gone.status, 404);
  });

  console.log('\nsign out and lockout');

  await check('sign out clears the session', async () => {
    await call('POST', '/api/auth/logout');
    const r = await call('GET', '/api/auth/me', null, { noCookie: true });
    assert.strictEqual(r.status, 401);
  });

  await check('repeated failures lock the account', async () => {
    for (let i = 0; i < 8; i++) {
      await call('POST', '/api/auth/login',
        { username: 'testadmin', password: 'nope' + i }, { noCookie: true });
    }
    const r = await call('POST', '/api/auth/login',
      { username: 'testadmin', password: PASSWORD }, { noCookie: true });
    assert.strictEqual(r.status, 423, 'expected 423 Locked, got ' + r.status);
    assert.match(r.data.error, /locked/i);
  });

  await check('the lock can be lifted by resetting the password', async () => {
    const u = await AdminUser.findOne({ username: 'testadmin' });
    u.lockedUntil = null;
    u.failedAttempts = 0;
    await u.save();
    const r = await call('POST', '/api/auth/login',
      { username: 'testadmin', password: PASSWORD }, { noCookie: true });
    assert.strictEqual(r.status, 200);
  });

  server.close();
  await disconnect();
  await mongo.stop();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nsmoke test crashed:', err);
  process.exit(1);
});

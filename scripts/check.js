#!/usr/bin/env node
'use strict';

/**
 * Offline checks — everything that can be verified without a running MongoDB.
 *
 *   npm run check
 *
 * Validates every seed document against its schema, boots the real Express app,
 * and confirms the routes, security headers and authorisation refusals behave.
 * `npm run smoke` is the fuller test and needs a database.
 */

const assert = require('assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'y'.repeat(64);
process.env.NODE_ENV = 'test';

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
  const Member = require('../src/models/Member');
  const ResearchItem = require('../src/models/ResearchItem');
  const Course = require('../src/models/Course');
  const Metrics = require('../src/models/Metrics');
  const AdminUser = require('../src/models/AdminUser');
  const Photo = require('../src/models/Photo');
  const seed = require('./seed-data.json');

  console.log('seed data against the schemas');

  await check(`all ${seed.members.length} members validate`, () => {
    for (const m of seed.members) {
      const err = new Member(m).validateSync();
      if (err) throw new Error(`${m.name}: ${err.message}`);
    }
  });

  await check(`all ${seed.research.length} research items validate`, () => {
    for (const r of seed.research) {
      const err = new ResearchItem(r).validateSync();
      if (err) throw new Error(`${r.kind} "${String(r.title).slice(0, 40)}": ${err.message}`);
    }
  });

  await check(`all ${seed.courses.length} courses validate`, () => {
    for (const c of seed.courses) {
      const err = new Course(c).validateSync();
      if (err) throw new Error(`${c.slug}: ${err.message}`);
    }
  });

  await check('a gallery item validates and requires a photo', () => {
    const GalleryItem = require('../src/models/GalleryItem');
    assert.ok(new GalleryItem({ photo: '/api/photos/abc', caption: 'Group, 2026' }).validateSync() === undefined);
    const err = new GalleryItem({ caption: 'no image' }).validateSync();
    assert.ok(err && err.errors.photo, 'a gallery item with no photo validated');
  });

  await check('a course resource accepts an uploaded file reference', () => {
    const doc = new Course({
      slug: 'tst', title: 'Test',
      resources: [{ kind: 'Slides', item: 'Unit I', fileUrl: '/api/files/abc',
                    fileName: 'unit1.pdf', fileBytes: 240000 }],
    });
    assert.strictEqual(doc.validateSync(), undefined);
    assert.strictEqual(doc.resources[0].fileBytes, 240000);
  });

  await check('a research item accepts a figure', () => {
    const doc = new ResearchItem({
      kind: 'journal', title: 'T', image: '/api/photos/abc', imageCaption: 'Pipeline',
    });
    assert.strictEqual(doc.validateSync(), undefined);
  });

  await check('metrics document validates', () => {
    const err = new Metrics(seed.metrics).validateSync();
    if (err) throw new Error(err.message);
  });

  console.log('\nseed content is complete');

  await check('research counts match the source site', () => {
    const by = {};
    for (const r of seed.research) by[r.kind] = (by[r.kind] || 0) + 1;
    assert.strictEqual(by.journal, 8, 'journals: ' + by.journal);
    assert.strictEqual(by.conference, 14, 'conferences: ' + by.conference);
    assert.strictEqual(by.chapter, 2, 'chapters: ' + by.chapter);
    assert.strictEqual(by.talk, 13, 'talks: ' + by.talk);
    assert.strictEqual(by.patent, 1, 'patents: ' + by.patent);
    assert.strictEqual(by.theme, 8, 'themes: ' + by.theme);
    assert.ok(by.organized >= 2 && by.chaired >= 7, 'events/chaired counts low');
  });

  await check('every publication kept its DOI', () => {
    const withDoi = seed.research.filter((r) => r.kind === 'journal' && r.doi);
    assert.strictEqual(withDoi.length, 8, 'only ' + withDoi.length + ' journals have DOIs');
    for (const r of withDoi) {
      assert.match(r.doi, /^10\.\d{4,}\//, 'malformed DOI: ' + r.doi);
    }
  });

  await check('every publication kept its authors and venue', () => {
    for (const r of seed.research) {
      if (!['journal', 'conference', 'chapter'].includes(r.kind)) continue;
      assert.ok(r.authors && r.authors.length > 5, 'no authors on: ' + r.title);
      assert.ok(r.venue && r.venue.length > 5, 'no venue on: ' + r.title);
      assert.ok(/Jaiswal/.test(r.authors), 'author list lost Jaiswal: ' + r.title);
    }
  });

  await check('courses carry units, materials and reading', () => {
    for (const c of seed.courses) {
      assert.ok(c.units.length >= 6, c.slug + ' has only ' + c.units.length + ' units');
      assert.ok(c.resources.length >= 5, c.slug + ' has only ' + c.resources.length + ' resources');
      assert.ok(c.reading.split('\n').filter(Boolean).length >= 3, c.slug + ' has thin reading list');
      assert.ok(c.description.length > 40, c.slug + ' has no description');
    }
  });

  await check('the lab in-charge is seeded as a member', () => {
    const pis = seed.members.filter((m) => m.group === 'pi');
    assert.strictEqual(pis.length, 1, 'expected exactly one pi member, got ' + pis.length);
    assert.match(pis[0].name, /Jaiswal/);
    assert.ok('photo' in pis[0], 'pi record has no photo field');
  });

  await check('the three named scholars are present with topics', () => {
    const names = seed.members.map((m) => m.name).join(' | ');
    for (const who of ['Archana Singh', 'Soha Muskaan Sayyad', 'Aman Gupta']) {
      assert.ok(names.includes(who), 'missing scholar: ' + who);
    }
    for (const m of seed.members) {
      assert.ok(m.topic && m.topic.length > 20, 'no topic for ' + m.name);
    }
  });

  console.log('\npassword handling');

  await check('bcrypt hashes and verifies, and never stores plaintext', async () => {
    const pw = 'a-long-enough-test-passphrase';
    const hash = await AdminUser.hashPassword(pw);
    assert.match(hash, /^\$2[aby]\$\d{2}\$/, 'not a bcrypt hash');
    assert.ok(!hash.includes(pw));
    const u = new AdminUser({ username: 'x', passwordHash: hash });
    assert.strictEqual(await u.verifyPassword(pw), true);
    assert.strictEqual(await u.verifyPassword(pw + '!'), false);
  });

  await check('passwordHash is not selected by default', () => {
    assert.strictEqual(AdminUser.schema.path('passwordHash').options.select, false);
  });

  console.log('\nphotograph storage');

  await check('the Photo schema rejects a non-image content type', () => {
    const bad = new Photo({ data: Buffer.from('x'), contentType: 'text/html' });
    const err = bad.validateSync();
    assert.ok(err && err.errors.contentType, 'text/html was accepted as a photo type');
  });

  await check('the Photo schema requires actual bytes', () => {
    const err = new Photo({ contentType: 'image/jpeg' }).validateSync();
    assert.ok(err && err.errors.data, 'a photo with no data validated');
  });

  await check('photo bytes are never selected by a metadata listing', () => {
    assert.ok(!Photo.metaFields.includes('data'), 'metaFields would fetch the image bytes');
  });

  await check('sharp re-encodes, strips metadata and enforces a size cap', async () => {
    const sharp = require('sharp');

    // A JPEG carrying EXIF, the way a phone photograph arrives.
    const withExif = await sharp({
      create: { width: 1200, height: 900, channels: 3, background: { r: 20, g: 90, b: 80 } },
    })
      .withExif({ IFD0: { Software: 'TestCam', Copyright: 'somebody' } })
      .jpeg()
      .toBuffer();

    const before = await sharp(withExif).metadata();
    assert.ok(before.exif, 'test fixture has no EXIF, so this proves nothing');

    const out = await sharp(withExif)
      .rotate()
      .resize(600, 600, { fit: 'cover', position: 'attention' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();

    const after = await sharp(out).metadata();
    assert.strictEqual(after.exif, undefined, 'EXIF survived the re-encode');
    assert.strictEqual(after.width, 600);
    assert.strictEqual(after.height, 600);
  });

  await check('a non-image is refused by the decoder, whatever it claims to be', async () => {
    const sharp = require('sharp');
    // A file that is really HTML — the stored-XSS upload attempt.
    const notAnImage = Buffer.from('<html><script>alert(1)</script></html>');
    await assert.rejects(() => sharp(notAnImage).metadata(), 'HTML was accepted as an image');
  });

  await check('a polyglot loses its payload in the re-encode', async () => {
    const sharp = require('sharp');
    // A valid image with a script tag stuffed into a comment field — valid
    // image, valid-ish HTML, the classic polyglot.
    const base = await sharp({
      create: { width: 300, height: 300, channels: 3, background: { r: 1, g: 2, b: 3 } },
    }).jpeg().toBuffer();
    const payload = Buffer.from('<script>alert(document.cookie)</script>');
    const polyglot = Buffer.concat([base, payload]);

    assert.ok(polyglot.includes(payload), 'fixture is wrong: payload not present');

    const out = await sharp(polyglot)
      .rotate()
      .resize(600, 600, { fit: 'cover' })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer();

    assert.ok(!out.includes(payload), 'the script payload survived re-encoding');
  });

  await check('image variants have sane, distinct geometry', () => {
    const { VARIANTS } = require('../src/routes/photos');
    assert.strictEqual(VARIANTS.portrait.fit, 'cover', 'portraits must crop to square');
    assert.strictEqual(VARIANTS.figure.fit, 'inside', 'a figure must not be cropped');
    assert.strictEqual(VARIANTS.gallery.fit, 'inside');
    assert.ok(VARIANTS.gallery.thumb > 0, 'gallery needs a thumbnail for the grid');
    assert.strictEqual(VARIANTS.portrait.thumb, 0);
    assert.ok(VARIANTS.gallery.width > VARIANTS.portrait.width);
  });

  await check('a figure keeps its aspect ratio; a portrait is squared', async () => {
    const sharp = require('sharp');
    const { VARIANTS } = require('../src/routes/photos');
    const wide = await sharp({
      create: { width: 2000, height: 800, channels: 3, background: { r: 10, g: 60, b: 55 } },
    }).jpeg().toBuffer();

    const fig = await sharp(wide).resize(VARIANTS.figure.width, VARIANTS.figure.height,
      { fit: 'inside', withoutEnlargement: true }).jpeg().toBuffer({ resolveWithObject: true });
    assert.ok(Math.abs(fig.info.width / fig.info.height - 2.5) < 0.02,
      'figure aspect drifted: ' + fig.info.width + 'x' + fig.info.height);

    const port = await sharp(wide).resize(600, 600,
      { fit: 'cover', position: 'attention' }).jpeg().toBuffer({ resolveWithObject: true });
    assert.strictEqual(port.info.width, 600);
    assert.strictEqual(port.info.height, 600);
  });

  console.log('\ndocument storage');

  await check('dangerous content types are never accepted', () => {
    const fstore = require('../src/storage/files');
    for (const t of ['text/html', 'image/svg+xml', 'application/javascript',
                     'text/javascript', 'application/xhtml+xml', 'text/xml']) {
      assert.strictEqual(fstore.isAllowed(t), false, t + ' was accepted');
    }
  });

  await check('real course-material types are accepted', () => {
    const fstore = require('../src/storage/files');
    for (const t of ['application/pdf', 'application/x-ipynb+json', 'text/csv',
                     'application/zip',
                     'application/vnd.openxmlformats-officedocument.presentationml.presentation']) {
      assert.strictEqual(fstore.isAllowed(t), true, t + ' was refused');
    }
  });

  await check('filenames are rebuilt, not merely stripped', () => {
    const { safeName } = require('../src/storage/files');
    // Header injection via CR/LF in Content-Disposition.
    assert.ok(!/[\r\n]/.test(safeName('a\r\nSet-Cookie: x=1.pdf')), 'CRLF survived');
    // Path traversal.
    assert.strictEqual(safeName('../../../etc/passwd'), 'passwd');
    assert.strictEqual(safeName('..\\..\\windows\\system32\\x.dll'), 'x.dll');
    // Quotes would break out of the header's quoted string.
    assert.ok(!safeName('evil".pdf').includes('"'), 'quote survived');
    // Always something usable.
    assert.ok(safeName('').length > 0);
    assert.ok(safeName('...').length > 0);
    // Extension is supplied when missing.
    assert.match(safeName('notes', 'pdf'), /\.pdf$/);
    // Length is bounded, extension preserved.
    const long = safeName('x'.repeat(300) + '.pdf');
    assert.ok(long.length <= 80, 'length ' + long.length);
    assert.match(long, /\.pdf$/);
  });

  console.log('\nconfiguration guards');

  await check('a missing JWT_SECRET refuses to run', () => {
    const saved = process.env.JWT_SECRET;
    delete process.env.JWT_SECRET;
    const { secret } = require('../src/middleware/auth');
    assert.throws(() => secret(), /JWT_SECRET/);
    process.env.JWT_SECRET = saved;
  });

  await check('a too-short JWT_SECRET refuses to run', () => {
    const saved = process.env.JWT_SECRET;
    process.env.JWT_SECRET = 'short';
    const { secret } = require('../src/middleware/auth');
    assert.throws(() => secret(), /32/);
    process.env.JWT_SECRET = saved;
  });

  await check('a missing MONGODB_URI gives a useful error', async () => {
    const { connect } = require('../src/db');
    await assert.rejects(() => connect(''), /MONGODB_URI/);
  });

  await check('an unreachable cluster produces actionable instructions', () => {
    const { diagnose } = require('../src/db');
    const uri = 'mongodb+srv://u:p@c.abc.mongodb.net/cvlab';

    const sel = diagnose(new Error('Could not connect to any servers in your MongoDB Atlas cluster'), uri);
    assert.match(sel, /IP ACCESS LIST/);
    assert.match(sel, /0\.0\.0\.0\/0/);
    assert.match(sel, /PAUSED CLUSTER/);
    assert.ok(!sel.includes(':p@'), 'password leaked into the error message');

    const auth = diagnose(new Error('bad auth : authentication failed'), uri);
    assert.match(auth, /Database Access/);
    assert.match(auth, /URL-encoded/);
    assert.ok(!auth.includes(':p@'));

    const dns = diagnose(new Error('querySrv ENOTFOUND _mongodb._tcp.c.abc.mongodb.net'), uri);
    assert.match(dns, /could not be resolved/);
    assert.ok(!dns.includes(':p@'));
  });

  await check('connection strings are redacted before logging', () => {
    const { redact } = require('../src/db');
    const out = redact('mongodb+srv://user:sup3rs3cret@cluster0.abc.mongodb.net/cvlab');
    assert.ok(!out.includes('sup3rs3cret'), 'password survived redaction');
    assert.ok(out.includes('user:****@'));
  });

  console.log('\nhttp surface');

  const app = require('../server');
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  async function req(method, path, opts) {
    const o = opts || {};
    return fetch(base + path, {
      method,
      headers: o.headers,
      body: o.body,
      redirect: 'manual',
    });
  }

  await check('GET / serves the public page', async () => {
    const r = await req('GET', '/');
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('Computing and Vision Lab'));
    assert.ok(html.includes('assets/site.js'), 'site.js not linked');
    assert.ok(html.includes('assets/config.js'), 'config.js not linked');
    // Relative, not absolute: GitHub Pages publishes project sites under
    // /repository-name/, where an absolute /assets/... path 404s.
    assert.ok(!html.includes('href="/assets/'), 'absolute asset path would break on Pages');
    assert.ok(!html.includes('src="/assets/'), 'absolute asset path would break on Pages');
  });

  await check('GET /admin serves the editor', async () => {
    const r = await req('GET', '/admin');
    assert.strictEqual(r.status, 200);
    const html = await r.text();
    assert.ok(html.includes('Sign in to edit'));
    assert.ok(html.includes('noindex'), 'admin page is not marked noindex');
  });

  await check('static assets are served from docs/ and admin/', async () => {
    for (const p of ['/assets/site.css', '/assets/site.js', '/assets/config.js',
                     '/assets/admin.js', '/assets/admin.css', '/404.html']) {
      const r = await req('GET', p);
      assert.strictEqual(r.status, 200, p + ' → ' + r.status);
    }
  });

  await check('the published site does not contain the editor', async () => {
    const fs = require('fs');
    const path = require('path');
    const docs = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) walk(full);
        else docs.push(full);
      }
    })(path.join(__dirname, '..', 'docs'));

    const leaked = docs.filter((f) => /admin\.(html|js|css)$/.test(f));
    assert.strictEqual(leaked.length, 0, 'editor files inside docs/: ' + leaked.join(', '));

    // And nothing in docs/ may mention a secret or a connection string.
    for (const f of docs.filter((x) => /\.(html|js|css|json)$/.test(x))) {
      const body = fs.readFileSync(f, 'utf8');
      assert.ok(!/mongodb\+srv:\/\//.test(body), 'connection string in ' + f);
      assert.ok(!/JWT_SECRET/.test(body), 'JWT_SECRET mentioned in ' + f);
      assert.ok(!/passwordHash/.test(body), 'passwordHash mentioned in ' + f);
    }
  });

  await check('config.js ships with an unset API base', () => {
    const fs = require('fs');
    const path = require('path');
    const cfg = fs.readFileSync(path.join(__dirname, '..', 'docs', 'assets', 'config.js'), 'utf8');
    const m = cfg.match(/API_BASE:\s*'([^']*)'/);
    assert.ok(m, 'no API_BASE line in config.js');
    assert.strictEqual(m[1], '', 'config.js has a hardcoded API base: ' + m[1]);
  });

  await check('CSP is set and blocks inline script', async () => {
    const r = await req('GET', '/');
    const csp = r.headers.get('content-security-policy');
    assert.ok(csp, 'no CSP header');
    const scriptSrc = csp.match(/script-src[^;]*/)[0];
    assert.ok(!/unsafe-inline/.test(scriptSrc), 'script-src allows unsafe-inline: ' + scriptSrc);
    assert.ok(/frame-ancestors 'none'/.test(csp), 'clickjacking not blocked');
    assert.ok(/object-src 'none'/.test(csp));
  });

  await check('x-powered-by is not advertised', async () => {
    const r = await req('GET', '/');
    assert.strictEqual(r.headers.get('x-powered-by'), null);
  });

  await check('writes without a session are refused', async () => {
    for (const [method, path] of [
      ['POST', '/api/members'],
      ['PUT', '/api/members/507f1f77bcf86cd799439011'],
      ['DELETE', '/api/members/507f1f77bcf86cd799439011'],
      ['POST', '/api/research'],
      ['POST', '/api/courses'],
      ['PUT', '/api/metrics'],
      ['POST', '/api/members/reorder'],
      ['POST', '/api/photos'],
      ['GET', '/api/photos'],
      ['DELETE', '/api/photos/507f1f77bcf86cd799439011'],
      ['POST', '/api/files'],
      ['GET', '/api/files'],
      ['DELETE', '/api/files/507f1f77bcf86cd799439011'],
      ['POST', '/api/gallery'],
      ['PUT', '/api/gallery/507f1f77bcf86cd799439011'],
      ['DELETE', '/api/gallery/507f1f77bcf86cd799439011'],
    ]) {
      // fetch refuses a body on GET, so only send one where it is allowed.
      const opts = method === 'GET'
        ? {}
        : { headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'x', citations: 1 }) };
      const r = await req(method, path, opts);
      assert.strictEqual(r.status, 401, method + ' ' + path + ' → ' + r.status);
    }
  });

  await check('a forged session cookie is refused', async () => {
    const r = await req('GET', '/api/auth/me', {
      headers: { Cookie: 'cvlab_session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.forged' },
    });
    assert.strictEqual(r.status, 401);
  });

  await check('a session cookie signed with the wrong key is refused', async () => {
    const jwt = require('jsonwebtoken');
    const bad = jwt.sign({ sub: '507f1f77bcf86cd799439011', usr: 'admin', ver: 0 }, 'z'.repeat(64));
    const r = await req('GET', '/api/auth/me', { headers: { Cookie: 'cvlab_session=' + bad } });
    assert.strictEqual(r.status, 401);
  });

  await check('login with no body gives 400, not a crash', async () => {
    const r = await req('POST', '/api/auth/login', {
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(r.status, 400);
  });

  await check('unknown /api path gives JSON 404', async () => {
    const r = await req('GET', '/api/nope');
    assert.strictEqual(r.status, 404);
    const body = await r.json();
    assert.ok(body.error);
  });

  await check('an unknown page falls back to the site, not a stack trace', async () => {
    const r = await req('GET', '/no/such/page');
    assert.strictEqual(r.status, 404);
    const html = await r.text();
    assert.ok(html.includes('Computing and Vision Lab'));
  });

  await check('an oversized body is rejected', async () => {
    const r = await req('POST', '/api/members', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x'.repeat(400000) }),
    });
    assert.ok(r.status === 413 || r.status === 401, 'got ' + r.status);
  });

  console.log('\ncors: public reads only');

  const ALLOWED = 'https://ankitjaiswal.github.io';
  process.env.SITE_ORIGIN = ALLOWED + ',https://cvlab.jnu.ac.in';

  // These use /api/health and OPTIONS, which return without touching MongoDB.
  await check('an allowed origin may read the API', async () => {
    const r = await req('GET', '/api/health', { headers: { Origin: ALLOWED } });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), ALLOWED);
    assert.strictEqual(r.headers.get('vary'), 'Origin');
  });

  await check('a trailing slash on SITE_ORIGIN still matches', async () => {
    process.env.SITE_ORIGIN = ALLOWED + '/';
    const r = await req('GET', '/api/health', { headers: { Origin: ALLOWED } });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), ALLOWED);
    process.env.SITE_ORIGIN = ALLOWED;
  });

  await check('a second configured origin also matches', async () => {
    process.env.SITE_ORIGIN = ALLOWED + ',https://cvlab.jnu.ac.in';
    const r = await req('GET', '/api/health', { headers: { Origin: 'https://cvlab.jnu.ac.in' } });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), 'https://cvlab.jnu.ac.in');
    process.env.SITE_ORIGIN = ALLOWED;
  });

  await check('an unknown origin gets no CORS header', async () => {
    const r = await req('GET', '/api/health', { headers: { Origin: 'https://evil.example' } });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
  });

  await check('a lookalike origin does not match by prefix', async () => {
    const r = await req('GET', '/api/health', {
      headers: { Origin: ALLOWED + '.evil.example' },
    });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
  });

  await check('credentials are never allowed cross-origin', async () => {
    const r = await req('GET', '/api/health', { headers: { Origin: ALLOWED } });
    assert.strictEqual(
      r.headers.get('access-control-allow-credentials'), null,
      'cross-origin credentials would force SameSite=None and lose CSRF protection'
    );
  });

  await check('the preflight is answered with 204', async () => {
    const r = await req('OPTIONS', '/api/content', {
      headers: { Origin: ALLOWED, 'Access-Control-Request-Method': 'GET' },
    });
    assert.strictEqual(r.status, 204);
    assert.match(r.headers.get('access-control-allow-methods'), /GET/);
  });

  await check('auth and write routes send no CORS headers at all', async () => {
    for (const p of ['/api/auth/login', '/api/auth/me', '/api/members', '/api/metrics']) {
      const r = await req('OPTIONS', p, {
        headers: { Origin: ALLOWED, 'Access-Control-Request-Method': 'POST' },
      });
      assert.strictEqual(
        r.headers.get('access-control-allow-origin'), null,
        p + ' is CORS-enabled — another site could call it with the admin\'s cookie'
      );
    }
  });

  await check('a single photo is readable cross-origin', async () => {
    // The public pages may be on GitHub Pages while the photos live here.
    const r = await req('GET', '/api/photos/507f1f77bcf86cd799439011', {
      headers: { Origin: ALLOWED },
    });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), ALLOWED);
  });

  await check('the photo listing is NOT readable cross-origin', async () => {
    const r = await req('OPTIONS', '/api/photos', {
      headers: { Origin: ALLOWED, 'Access-Control-Request-Method': 'GET' },
    });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
  });

  await check('a stored file is readable cross-origin', async () => {
    const r = await req('GET', '/api/files/507f1f77bcf86cd799439011', {
      headers: { Origin: ALLOWED },
    });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), ALLOWED);
  });

  await check('the file library is NOT readable cross-origin', async () => {
    const r = await req('OPTIONS', '/api/files', {
      headers: { Origin: ALLOWED, 'Access-Control-Request-Method': 'GET' },
    });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
  });

  await check('health check is readable cross-origin', async () => {
    const r = await req('GET', '/api/health', { headers: { Origin: ALLOWED } });
    assert.strictEqual(r.headers.get('access-control-allow-origin'), ALLOWED);
  });

  await check('the session cookie stays SameSite=Lax', () => {
    // Reading the source is the honest check here: setting the cookie needs a
    // successful login, which needs a database. If this ever becomes None, the
    // CSRF protection described in src/middleware/cors.js is gone.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'auth.js'), 'utf8');
    assert.match(src, /sameSite:\s*'lax'/i);
    assert.ok(!/sameSite:\s*'none'/i.test(src), 'cookie is SameSite=None');
    assert.match(src, /httpOnly:\s*true/);
  });

  delete process.env.SITE_ORIGIN;

  server.close();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log('\nRun `npm run smoke` with MongoDB available for the full integration test.');
  }
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\ncheck crashed:', err);
  process.exit(1);
});

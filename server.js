'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');

const { connect } = require('./src/db');
const { secret, insecureHttp } = require('./src/middleware/auth');
const { publicCors, parseOrigins } = require('./src/middleware/cors');

const Member = require('./src/models/Member');
const ResearchItem = require('./src/models/ResearchItem');
const Course = require('./src/models/Course');
const GalleryItem = require('./src/models/GalleryItem');

const authRoutes = require('./src/routes/auth');
const metricsRoutes = require('./src/routes/metrics');
const contentRoutes = require('./src/routes/content');
const photoRoutes = require('./src/routes/photos');
const fileRoutes = require('./src/routes/files');
const { crudRouter } = require('./src/routes/crud');

const app = express();
const PORT = process.env.PORT || 3000;

// Render, Railway and every other proxying host put the real client IP in
// X-Forwarded-For. Without this the login rate limiter sees one shared IP.
app.set('trust proxy', 1);

app.disable('x-powered-by');

const HTTP_ONLY = insecureHttp();

/**
 * Content-Security-Policy. The pages load Google Fonts and nothing else from
 * off-origin, so everything else stays on 'self'. `styleSrc` needs
 * 'unsafe-inline' because the page keeps its CSS in a <style> block; scripts do
 * NOT get 'unsafe-inline', which is the half that actually blocks injected JS.
 *
 * Two directives have to come off when the site is served over plain HTTP —
 * which is the case when it is reached by bare IP, since no certificate can be
 * issued for an IP address:
 *
 *   upgrade-insecure-requests  rewrites the page's own http:// asset requests
 *                              to https://, which then fail: no stylesheet, no
 *                              JavaScript, an unstyled and empty page.
 *   Strict-Transport-Security  tells the browser to use HTTPS for this host for
 *                              months. Set it once by mistake on an IP with no
 *                              certificate and that browser cannot reach the
 *                              site again until its HSTS entry is cleared by
 *                              hand. Browsers ignore the header over HTTP, but
 *                              it is not worth sending at all.
 */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'https:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests:
          process.env.NODE_ENV === 'production' && !HTTP_ONLY ? [] : null,
      },
    },
    strictTransportSecurity: HTTP_ONLY ? false : undefined,
    crossOriginEmbedderPolicy: false,
  })
);

app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// ---------------------------------------------------------------- API

// Cross-origin reads: only the public content endpoint and the health check.
// Everything below stays same-origin — see src/middleware/cors.js for why.
app.use('/api/content', publicCors, contentRoutes);
app.get('/api/health', publicCors, (req, res) => {
  const { mongoose } = require('./src/db');
  res.json({
    ok: mongoose.connection.readyState === 1,
    dbState: mongoose.connection.readyState,
    uptimeSeconds: Math.round(process.uptime()),
  });
});

// Same-origin only: no CORS headers are ever sent for these, so a page on any
// other site cannot call them even with a valid session cookie.
// Photos: GET is public and cross-origin readable (the route applies CORS to
// that verb only); POST and DELETE are admin and same-origin.
app.use('/api/photos', photoRoutes);

// Course materials and datasets, stored in GridFS. GET is public and
// cross-origin readable; upload, listing and delete are admin.
app.use('/api/files', fileRoutes);

app.use('/api/auth', authRoutes);
app.use('/api/metrics', metricsRoutes);

app.use(
  '/api/members',
  crudRouter(Member, {
    sort: { order: 1, name: 1 },
    fields: [
      'name', 'group', 'topic', 'period', 'email',
      'links', 'photo', 'currentPosition', 'order', 'visible',
    ],
  })
);

app.use(
  '/api/research',
  crudRouter(ResearchItem, {
    sort: { order: 1, year: -1, _id: 1 },
    fields: [
      'kind', 'title', 'authors', 'venue', 'date', 'year', 'detail',
      'doi', 'url', 'image', 'imageCaption', 'tags', 'label', 'body',
      'member', 'order', 'visible',
    ],
  })
);

app.use(
  '/api/courses',
  crudRouter(Course, {
    sort: { order: 1, title: 1 },
    fields: [
      'slug', 'title', 'designation', 'semester', 'level', 'ltp', 'category',
      'description', 'units', 'resources', 'reading', 'current', 'order', 'visible',
    ],
  })
);

app.use(
  '/api/gallery',
  crudRouter(GalleryItem, {
    sort: { order: 1, createdAt: -1 },
    fields: ['photo', 'caption', 'album', 'taken', 'order', 'visible'],
  })
);

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'No such endpoint.' });
});

// ------------------------------------------------------------- static

// docs/ is the same directory GitHub Pages publishes, so the API host serves a
// working copy of the public site too — useful for checking a change before it
// reaches Pages, and as a fallback if Pages is ever down.
const staticOpts = { maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 };

app.use(express.static(path.join(__dirname, 'docs'), staticOpts));

// The editor is served only from here, never published to Pages.
app.use(express.static(path.join(__dirname, 'admin'), staticOpts));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'admin.html'));
});

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'docs', 'index.html'));
});

// -------------------------------------------------------------- errors

app.use((err, req, res, next) => {
  // multer reports an oversized upload as a thrown error, not a 400.
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    const { MAX_UPLOAD_BYTES } = require('./src/routes/photos');
    return res.status(413).json({
      error: `That image is too large. The limit is ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB — ` +
             'most phone photographs are well under it.',
    });
  }
  if (err && err.code === 'LIMIT_FILE_SIZE' && req.path.startsWith('/api/files')) {
    const { MAX_FILE_BYTES } = require('./src/routes/files');
    return res.status(413).json({
      error: `That file is too large. The limit is ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MB.`,
    });
  }
  if (err && typeof err.code === 'string' && err.code.startsWith('LIMIT_')) {
    return res.status(400).json({ error: 'That upload was not accepted. Send one image file.' });
  }

  const status = err.status || (err.name === 'ValidationError' ? 400 : 500);

  if (status >= 500) console.error('[error]', err);

  // Duplicate key — the only 11000 in this schema set is a taken course slug.
  if (err && err.code === 11000) {
    return res.status(409).json({
      error: 'That value is already used. Course slugs and usernames must be unique.',
    });
  }

  res.status(status).json({
    error:
      status >= 500
        ? 'Something went wrong on the server.'
        : err.message || 'Request could not be processed.',
  });
});

// --------------------------------------------------------------- boot

async function start() {
  try {
    secret(); // fail now, not on the first login attempt
  } catch (err) {
    console.error('\n[config] ' + err.message + '\n');
    process.exit(1);
  }

  try {
    await connect(process.env.MONGODB_URI);
  } catch (err) {
    console.error('\n[config] ' + err.message + '\n');
    process.exit(1);
  }

  const server = app.listen(PORT, () => {
    console.log(`[server] listening on http://localhost:${PORT}`);
    console.log(`[server] admin portal at http://localhost:${PORT}/admin`);

    if (HTTP_ONLY) {
      console.warn('');
      console.warn('  ############################################################');
      console.warn('  #  INSECURE_HTTP=true — this server is running WITHOUT TLS #');
      console.warn('  ############################################################');
      console.warn('');
      console.warn('  The session cookie is being sent without the Secure flag so');
      console.warn('  that the admin login works over plain http://. That means:');
      console.warn('');
      console.warn('    - Anyone on the network path can read the admin password as');
      console.warn('      it is submitted, and can copy the session cookie.');
      console.warn('    - Do not use a password here that you use anywhere else.');
      console.warn('');
      console.warn('  This is acceptable only as a temporary state, or on a network');
      console.warn('  you control. Get a domain name, run certbot, then delete');
      console.warn('  INSECURE_HTTP and restart. See DEPLOY-UBUNTU.md.');
      console.warn('');
    }

    const origins = parseOrigins(process.env.SITE_ORIGIN);
    if (origins.length) {
      console.log('[cors] public reads allowed from: ' + origins.join(', '));
    } else {
      console.log(
        '[cors] SITE_ORIGIN not set — same-origin only. Set it to your GitHub ' +
        'Pages URL so the published site can read the API.'
      );
    }
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      console.log(`[server] ${signal} received, shutting down`);
      server.close(() => require('./src/db').disconnect().then(() => process.exit(0)));
    });
  }
}

if (require.main === module) start();

module.exports = app;

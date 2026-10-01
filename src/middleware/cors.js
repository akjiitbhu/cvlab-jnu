'use strict';

/**
 * CORS for the public read endpoints only.
 *
 * WHY THIS IS DELIBERATELY NARROW
 * -------------------------------
 * The public pages are static files on GitHub Pages; the API is on another
 * host. Those are different origins, so the pages need CORS to read
 * /api/content.
 *
 * The admin portal is a different matter. It is served BY the API host, from
 * the same origin as the API, so it needs no CORS at all — and it must not get
 * any. The session is an httpOnly cookie with SameSite=Lax, and that Lax is
 * what stops another website from making an authenticated request on the
 * admin's behalf. Enabling cross-origin credentialed requests would force
 * SameSite=None, throwing that protection away and requiring a CSRF token to
 * replace it.
 *
 * So: cross-origin reads are allowed and carry no credentials; anything that
 * authenticates or writes is same-origin and gets no CORS headers, which means
 * a browser on any other site cannot call it at all.
 *
 * SITE_ORIGIN holds the allowed origins, comma separated:
 *   SITE_ORIGIN=https://username.github.io,https://cvlab.jnu.ac.in
 * Unset means "reflect nothing" — the API still works same-origin, which is
 * what happens locally.
 */

function parseOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

function publicCors(req, res, next) {
  const allowed = parseOrigins(process.env.SITE_ORIGIN);
  const origin = req.headers.origin;

  // Same-origin requests send no Origin header (or one that matches the host);
  // nothing to do for them.
  if (!origin) return next();

  if (allowed.includes(origin.replace(/\/+$/, ''))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    // Different allowed origins get different responses, so caches must not
    // serve one origin's response to another.
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Accept, Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    // Note the absence of Access-Control-Allow-Credentials. Reads are public;
    // no cookie is wanted or sent.
  }

  if (req.method === 'OPTIONS') {
    // Answer the preflight whether or not the origin was allowed. An
    // unallowed origin simply gets no Allow-Origin header and the browser
    // blocks it, which is the correct outcome.
    return res.status(204).end();
  }

  next();
}

module.exports = { publicCors, parseOrigins };

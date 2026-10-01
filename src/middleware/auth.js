'use strict';

const jwt = require('jsonwebtoken');
const AdminUser = require('../models/AdminUser');

const COOKIE_NAME = 'cvlab_session';
const TOKEN_TTL = '8h';

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    // Refusing to start is the right behaviour: a short or missing secret means
    // anyone can forge a session cookie and edit the site.
    throw new Error(
      'JWT_SECRET must be set to at least 32 random characters. ' +
      'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"'
    );
  }
  return s;
}

function issueToken(user) {
  return jwt.sign(
    { sub: String(user._id), usr: user.username, ver: user.tokenVersion },
    secret(),
    { expiresIn: TOKEN_TTL }
  );
}

/**
 * Should the session cookie carry the Secure flag?
 *
 * A Secure cookie is only ever sent over HTTPS. That is what you want — except
 * when the site genuinely has no TLS, which is the case when it is reached by
 * bare IP address: Let's Encrypt will not issue a certificate for an IP, so
 * there is no certificate to have.
 *
 * Without an escape hatch the failure is nasty and silent: the login returns
 * 200, the browser drops the Secure cookie on the floor because the connection
 * is plain HTTP, and the very next request looks unauthenticated. The user sees
 * "signed in" flash past and the editor bounce straight back to the login form,
 * with nothing in any log to explain it.
 *
 * So INSECURE_HTTP=true is an explicit, deliberately ugly opt-in. It is
 * announced loudly at boot, and it should be removed the moment a domain and a
 * certificate exist.
 */
function insecureHttp() {
  return String(process.env.INSECURE_HTTP || '').toLowerCase() === 'true';
}

/**
 * The session lives in an httpOnly cookie, not localStorage, so page
 * JavaScript — including anything injected through a stored XSS — cannot read
 * the token. SameSite=Lax blocks the cookie on cross-site requests, which is
 * the CSRF vector that matters here.
 */
function setSessionCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd && !insecureHttp(),
    maxAge: 8 * 60 * 60 * 1000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

/**
 * Gate for every write route. Verifies the signature, then re-checks the user
 * against the database: a deleted account or a bumped tokenVersion invalidates
 * a token that is still cryptographically valid and unexpired.
 */
async function requireAdmin(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, secret());
  } catch (err) {
    clearSessionCookie(res);
    const expired = err && err.name === 'TokenExpiredError';
    return res.status(401).json({
      error: expired ? 'Session expired. Sign in again.' : 'Invalid session.',
    });
  }

  const user = await AdminUser.findById(payload.sub);
  if (!user || user.tokenVersion !== payload.ver) {
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Session is no longer valid. Sign in again.' });
  }

  req.admin = user;
  next();
}

/**
 * Attaches req.admin when a valid session is present and otherwise does
 * nothing at all — never responds, never clears the cookie. Used by GET routes
 * that serve both the public page and the editor, where a stale cookie must not
 * turn a visitor's page load into a 401.
 */
async function attachAdmin(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return next();

  try {
    const payload = jwt.verify(token, secret());
    const user = await AdminUser.findById(payload.sub);
    if (user && user.tokenVersion === payload.ver) req.admin = user;
  } catch (err) {
    // A bad or expired cookie simply means "treat as a visitor".
  }
  next();
}

module.exports = {
  COOKIE_NAME,
  insecureHttp,
  issueToken,
  setSessionCookie,
  clearSessionCookie,
  requireAdmin,
  attachAdmin,
  secret,
};

'use strict';

const mongoose = require('mongoose');

/**
 * Single mongoose connection for the process.
 *
 * Mongoose buffers queries until the connection is up, so routes registered
 * before connect() resolves still work — but we await it in server.js anyway so
 * the process fails loudly on a bad URI instead of hanging on the first request.
 */
async function connect(uri) {
  if (!uri) {
    throw new Error(
      'MONGODB_URI is not set. Copy .env.example to .env and fill it in, ' +
      'or set the variable in your host\'s dashboard.'
    );
  }

  mongoose.set('strictQuery', true);

  mongoose.connection.on('connected', () => {
    console.log('[db] connected to', redact(uri));
  });
  mongoose.connection.on('error', (err) => {
    console.error('[db] connection error:', err.message);
  });
  mongoose.connection.on('disconnected', () => {
    console.warn('[db] disconnected');
  });

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
      maxPoolSize: 10,

      // Return BSON binary as a Node Buffer rather than a driver `Binary`.
      //
      // Without this, a .lean() query — which skips the schema casting that
      // would normally do the conversion — hands the photo routes a `Binary`.
      // Express does not recognise it as a body, so it JSON-serialises the
      // object instead of writing the bytes, and the browser receives JSON
      // labelled image/jpeg and reports a corrupt image. `Binary.length` is
      // also a method, so Content-Length came out as a function's source.
      promoteBuffers: true,
    });
  } catch (err) {
    // Mongoose's own message for an unreachable cluster is a wall of host names
    // that does not say what to change. Replace it with the checklist, ordered
    // by how often each cause is the real one.
    throw new Error(diagnose(err, uri));
  }

  return mongoose.connection;
}

/** Turn a driver connection failure into instructions. */
function diagnose(err, uri) {
  const raw = String((err && err.message) || err);
  const lines = [];

  const isSrv = /^mongodb\+srv:\/\//.test(uri);
  const authFailed = /bad auth|Authentication failed|AuthenticationFailed/i.test(raw);
  const dnsFailed = /ENOTFOUND|querySrv|EAI_AGAIN|getaddrinfo/i.test(raw);
  const selectionFailed = /Could not connect to any servers|ServerSelectionError|connection timed out/i.test(raw);

  lines.push('Could not connect to MongoDB.');
  lines.push('');

  if (authFailed) {
    lines.push('The cluster answered but rejected the credentials. Check, in order:');
    lines.push('  1. The username and password in MONGODB_URI match a user under');
    lines.push('     Atlas → Database Access.');
    lines.push('  2. Special characters in the password are URL-encoded.');
    lines.push('     : / ? # [ ] @ must be percent-escaped — @ becomes %40, # becomes %23.');
    lines.push('  3. That user has readWrite on the database named in the URI.');
  } else if (dnsFailed) {
    lines.push('The cluster hostname could not be resolved, so the address is wrong');
    lines.push('or DNS is blocked. Check:');
    lines.push('  1. The host in MONGODB_URI matches Atlas → Connect exactly.');
    if (isSrv) {
      lines.push('  2. mongodb+srv:// needs outbound DNS SRV lookups. If your network');
      lines.push('     blocks them, use the non-SRV "mongodb://host1,host2,host3/..."');
      lines.push('     string that Atlas offers under Connect → Drivers → older driver.');
    }
  } else if (selectionFailed) {
    lines.push('The cluster did not accept the connection. In order of likelihood:');
    lines.push('');
    lines.push('  1. THE IP ACCESS LIST. This is the usual cause on a cloud host.');
    lines.push('     Atlas → Network Access → IP Access List → Add IP Address.');
    lines.push('     Render, Railway and Fly.io free tiers have no fixed outbound IP,');
    lines.push('     so add 0.0.0.0/0 ("allow access from anywhere").');
    lines.push('     That is safe here only because the database user has a strong');
    lines.push('     password and this connection string never reaches a browser.');
    lines.push('     Changes take about a minute to take effect.');
    lines.push('');
    lines.push('  2. A PAUSED CLUSTER. Atlas pauses free clusters after around 60 days');
    lines.push('     idle. Atlas → Database → Resume if it shows as paused.');
    lines.push('');
    lines.push('  3. STILL PROVISIONING. A brand new cluster takes a few minutes');
    lines.push('     before it accepts connections.');
    lines.push('');
    lines.push('  4. A WRONG PASSWORD can also surface this way rather than as an auth');
    lines.push('     error. Re-copy the string from Atlas → Connect and re-insert the');
    lines.push('     password, URL-encoding any of : / ? # [ ] @');
  } else {
    lines.push('Check MONGODB_URI, the Atlas IP access list, and whether the cluster');
    lines.push('is running.');
  }

  lines.push('');
  lines.push('Connecting to: ' + redact(uri));
  lines.push('Driver said:   ' + raw.split('\n')[0].slice(0, 300));

  return lines.join('\n');
}

/** Strip the password out of a connection string before logging it. */
function redact(uri) {
  return String(uri).replace(/\/\/([^:]+):([^@]+)@/, '//$1:****@');
}

async function disconnect() {
  await mongoose.disconnect();
}

module.exports = { connect, disconnect, redact, diagnose, mongoose };

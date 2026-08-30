// OAuth2 for an installed app: the loopback redirect flow, with PKCE.
//
// Nothing here is logged. Access tokens, refresh tokens, the authorisation code
// and the client secret never reach a console line — errors from the token
// endpoint routinely embed them, so every message goes through redact().
const { app, shell, net, safeStorage } = require('electron');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const TOKEN_PATH = path.join(app.getPath('userData'), 'gmail-token.bin');

// Tokens and secrets show up inside error text from the token endpoint.
function redact(text) {
  return String(text == null ? '' : text)
    .replace(/[A-Za-z0-9._-]{24,}/g, '<redacted>')
    .replace(/https?:\/\/\S+/g, '<url>');
}

function b64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// --- refresh token at rest -------------------------------------------------

function saveRefreshToken(token) {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      fs.writeFileSync(TOKEN_PATH, safeStorage.encryptString(token));
      return true;
    }
    // Refusing is the right call: writing a long-lived mailbox credential in
    // cleartext is worse than making the user reconnect each launch.
    console.warn('Gmail: OS encryption unavailable; refresh token not stored.');
    return false;
  } catch (err) {
    console.error('Gmail: failed to store refresh token:', redact(err.message));
    return false;
  }
}

function loadRefreshToken() {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    const token = safeStorage.decryptString(fs.readFileSync(TOKEN_PATH));
    return token || null;
  } catch {
    return null;
  }
}

function clearRefreshToken() {
  try {
    if (fs.existsSync(TOKEN_PATH)) fs.unlinkSync(TOKEN_PATH);
  } catch { /* nothing useful to do */ }
}

function isConnected() {
  return Boolean(loadRefreshToken());
}

// --- HTTP ------------------------------------------------------------------

// Electron's net rather than node https: it uses the system proxy and cert
// store, which matters on managed or campus networks.
function postForm(url, form) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(form).toString();
    const request = net.request({ method: 'POST', url });
    request.setHeader('Content-Type', 'application/x-www-form-urlencoded');

    const timer = setTimeout(() => {
      request.abort();
      reject(new Error('Token request timed out'));
    }, 20000);

    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf-8');
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* handled below */ }
        if (response.statusCode >= 200 && response.statusCode < 300 && parsed) {
          resolve(parsed);
        } else {
          // Google reports a dead refresh token as invalid_grant. Surface that
          // verbatim so callers can tell "reconnect" from "network is down".
          const code = parsed && parsed.error ? parsed.error : 'http_' + response.statusCode;
          const err = new Error(code);
          err.oauthError = code;
          reject(err);
        }
      });
    });
    request.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(redact(err.message)));
    });
    request.write(body);
    request.end();
  });
}

// --- authorisation ---------------------------------------------------------

let pending = null;

// Opens the system browser for consent and catches the redirect on loopback.
// Resolves once a refresh token has been stored.
function connect() {
  const cfg = config.load();
  if (!cfg.ok) return Promise.reject(new Error(cfg.reason));
  if (pending) return pending;

  pending = new Promise((resolve, reject) => {
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const stateToken = b64url(crypto.randomBytes(16));

    const server = http.createServer();
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { server.close(); } catch { /* already closing */ }
      pending = null;
      if (err) reject(err); else resolve(value);
    };

    // Consent can be abandoned; don't leave a listening socket behind.
    const timeout = setTimeout(() => finish(new Error('Authorisation timed out')), 5 * 60 * 1000);

    server.on('request', async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') { res.writeHead(404).end(); return; }

      const reply = (message) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><meta charset="utf-8"><title>Desktop Widgets</title>' +
          '<body style="font:16px system-ui;padding:3rem;background:#14141a;color:#fff">' +
          '<p>' + message + '</p></body>');
      };

      // State is checked first, on every response including errors. RFC 6749
      // requires it on error responses too, and checking it second would let
      // any local process or web page abort a live consent flow by hitting the
      // loopback port with ?error=.
      if (url.searchParams.get('state') !== stateToken) {
        reply('Unexpected response. You can close this tab.');
        // Not finish(): an unrelated caller must not kill a genuine flow.
        return;
      }
      const oauthError = url.searchParams.get('error');
      if (oauthError) {
        reply('Authorisation was declined. You can close this tab.');
        // Redacted like every other path — this string is attacker-influenced
        // and is surfaced to the renderer.
        finish(new Error(redact(oauthError)));
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) { reply('No authorisation code. You can close this tab.'); return; }

      try {
        const port = server.address().port;
        const tokens = await postForm(TOKEN_URL, {
          code,
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          code_verifier: verifier,
          grant_type: 'authorization_code',
          redirect_uri: 'http://127.0.0.1:' + port,
        });
        if (!tokens.refresh_token) {
          reply('Google did not return a refresh token. You can close this tab.');
          finish(new Error('no_refresh_token'));
          return;
        }
        saveRefreshToken(tokens.refresh_token);
        cacheAccessToken(tokens);
        reply('Gmail connected. You can close this tab and return to your widgets.');
        finish(null, true);
      } catch (err) {
        reply('Could not complete sign-in. You can close this tab.');
        finish(new Error(redact(err.message)));
      }
    });

    server.on('error', (err) => finish(new Error(redact(err.message))));

    // Port 0 lets the OS pick; Google allows any port on the loopback address.
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        redirect_uri: 'http://127.0.0.1:' + port,
        response_type: 'code',
        scope: SCOPE,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: stateToken,
        // Without both of these Google withholds the refresh token on repeat
        // authorisations, which is precisely what we need to persist.
        access_type: 'offline',
        prompt: 'consent',
      });
      // Fire-and-forget would strand the flow: with no default browser or a
      // policy block there would be no tab, no error, and a socket listening
      // for five minutes.
      shell.openExternal(AUTH_URL + '?' + params.toString())
        .catch((err) => finish(new Error('Could not open a browser: ' + redact(err.message))));
    });
  });

  return pending;
}

// --- access tokens ---------------------------------------------------------

let accessToken = null;
let accessExpiry = 0;

function cacheAccessToken(tokens) {
  if (!tokens || !tokens.access_token) return false;
  accessToken = tokens.access_token;
  // Expire a minute early so a call can't land on a just-dead token. A missing
  // or non-numeric expires_in falls back to an hour rather than producing NaN,
  // which would make the freshness check permanently false.
  const ttl = Number(tokens.expires_in);
  const seconds = Number.isFinite(ttl) && ttl > 0 ? ttl : 3600;
  accessExpiry = Date.now() + (seconds - 60) * 1000;
  return true;
}

// Drops the cached access token without touching the refresh token, so the
// next call mints a fresh one. Used when the API rejects a token that the
// refresh grant still considers valid.
function forgetAccessToken() {
  accessToken = null;
  accessExpiry = 0;
}

// Throws an error carrying needsReconnect when the refresh token is gone or
// rejected — in Testing status Google expires them after seven days, so this
// is an expected state rather than a failure to hide.
async function getAccessToken() {
  if (accessToken && Date.now() < accessExpiry) return accessToken;

  const cfg = config.load();
  if (!cfg.ok) {
    const err = new Error(cfg.reason);
    err.needsSetup = true;
    throw err;
  }

  const refresh = loadRefreshToken();
  if (!refresh) {
    const err = new Error('Gmail is not connected.');
    err.needsReconnect = true;
    throw err;
  }

  try {
    const tokens = await postForm(TOKEN_URL, {
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    });
    // A 2xx without an access_token would otherwise leave the previous (or
    // null) value in place and send "Bearer null" on the next call.
    if (!cacheAccessToken(tokens)) {
      throw new Error('Token refresh returned no access token');
    }
    return accessToken;
  } catch (err) {
    if (err.oauthError === 'invalid_grant') {
      // Seven days elapsed, or access was revoked. Drop the dead token so we
      // stop retrying it every refresh cycle.
      clearRefreshToken();
      accessToken = null;
      accessExpiry = 0;
      const dead = new Error('Gmail access expired — reconnect to continue.');
      dead.needsReconnect = true;
      throw dead;
    }
    throw new Error(redact(err.message));
  }
}

function disconnect() {
  clearRefreshToken();
  accessToken = null;
  accessExpiry = 0;
}

module.exports = {
  connect,
  disconnect,
  forgetAccessToken,
  isConnected,
  getAccessToken,
  redact,
  TOKEN_PATH,
  SCOPE,
};

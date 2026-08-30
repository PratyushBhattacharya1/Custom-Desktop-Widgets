// Fetches recent messages and keeps them cached.
//
// Built around a constraint: while the OAuth app sits in Testing status Google
// expires refresh tokens after seven days. That isn't an error to hide — it is
// a normal weekly event — so a dead token surfaces as a "reconnect" state with
// the last known messages still on screen, and polling stops until you act.
const { app, net } = require('electron');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const auth = require('./auth');

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const CACHE_PATH = path.join(app.getPath('userData'), 'gmail-cache.json');

const state = {
  messages: [],
  lastSuccessAt: null,
  stale: false,
  needsReconnect: false,
  needsSetup: false,
  error: null,
};

let timer = null;
let inFlight = false;
const listeners = [];

function onUpdated(fn) { listeners.push(fn); }
function emit() { listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } }); }

// --- cache -----------------------------------------------------------------

function readCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
    if (parsed && Array.isArray(parsed.messages)) {
      state.messages = parsed.messages;
      state.lastSuccessAt = parsed.lastSuccessAt || null;
      state.stale = true; // until a live fetch confirms it
    }
  } catch { /* no cache yet */ }
}

function writeCache() {
  try {
    fs.writeFileSync(CACHE_PATH, JSON.stringify({
      messages: state.messages,
      lastSuccessAt: state.lastSuccessAt,
    }));
  } catch (err) {
    console.error('Gmail: failed to write cache:', auth.redact(err.message));
  }
}

// --- API -------------------------------------------------------------------

function apiGet(url, token) {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: 'GET', url });
    request.setHeader('Authorization', 'Bearer ' + token);
    const timeout = setTimeout(() => { request.abort(); reject(new Error('Gmail request timed out')); }, 20000);
    request.on('response', (response) => {
      const chunks = [];
      response.on('data', (c) => chunks.push(c));
      response.on('end', () => {
        clearTimeout(timeout);
        const text = Buffer.concat(chunks).toString('utf-8');
        const status = response.statusCode;

        if (status === 401 || status === 403) {
          // 403 covers both "your token is wrong" and "you asked too often",
          // and the two must not be conflated: treating a rate limit as an auth
          // failure would throw away a perfectly good refresh token.
          let reason = '';
          try {
            const parsed = JSON.parse(text);
            const detail = parsed && parsed.error && parsed.error.errors && parsed.error.errors[0];
            reason = (detail && detail.reason) || (parsed && parsed.error && parsed.error.status) || '';
          } catch { /* fall through to the status-only decision */ }

          const transient = /rateLimit|quotaExceeded|backendError|userRateLimitExceeded/i.test(reason);
          const err = new Error(transient
            ? 'Gmail is rate limiting requests'
            : 'Gmail rejected the token' + (reason ? ' (' + reason + ')' : ''));
          // Only a genuine credential problem should reach the disconnect path.
          if (!transient) err.authFailed = true;
          err.retryable = transient;
          reject(err);
          return;
        }
        if (status < 200 || status >= 300) {
          const err = new Error('Gmail returned ' + status);
          err.retryable = status >= 500 || status === 429;
          reject(err);
          return;
        }
        try { resolve(JSON.parse(text)); } catch { reject(new Error('Malformed Gmail response')); }
      });
    });
    request.on('error', (err) => { clearTimeout(timeout); reject(new Error(auth.redact(err.message))); });
    request.end();
  });
}

function header(payload, name) {
  const headers = (payload && payload.headers) || [];
  const found = headers.filter((h) => h.name.toLowerCase() === name.toLowerCase())[0];
  return found ? found.value : '';
}

// "Pratyush B <a@b.com>" -> "Pratyush B"; a bare address keeps its local part.
function senderName(from) {
  if (!from) return '(unknown)';
  const named = from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/);
  if (named) return named[1].trim();
  const bare = from.match(/^<?([^@\s>]+)@/);
  return bare ? bare[1] : from.trim();
}

async function fetchMessages() {
  const cfg = config.load();
  if (!cfg.ok) {
    state.needsSetup = true;
    state.error = cfg.reason;
    return;
  }

  const token = await auth.getAccessToken();

  const listUrl = API + '/messages?maxResults=' + cfg.maxMessages +
    '&q=' + encodeURIComponent(cfg.query);
  const list = await apiGet(listUrl, token);
  const ids = (list.messages || []).map((m) => m.id);

  // metadata format carries the snippet and labelIds without the body, which is
  // all the widget shows and keeps each response small.
  const detailUrl = (id) => API + '/messages/' + id +
    '?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date';

  const messages = [];
  let failed = 0;
  // Modest concurrency: enough to stay quick, far short of any rate limit.
  const CHUNK = 5;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = await Promise.all(
      ids.slice(i, i + CHUNK).map((id) => apiGet(detailUrl(id), token).catch((err) => {
        // A detail fetch that fails for an auth reason means the whole run is
        // doomed; let it out rather than quietly returning a short list.
        if (err && err.authFailed) throw err;
        failed += 1;
        return null;
      }))
    );
    batch.forEach((m) => {
      if (!m) return;
      const labels = m.labelIds || [];
      messages.push({
        id: m.id,
        from: senderName(header(m.payload, 'From')),
        subject: header(m.payload, 'Subject') || '(no subject)',
        snippet: m.snippet || '',
        unread: labels.indexOf('UNREAD') !== -1,
        dateMs: Number(m.internalDate) || 0,
      });
    });
  }

  messages.sort((a, b) => b.dateMs - a.dateMs);

  // Every detail request failing while the list call succeeded means something
  // is broadly wrong. Keep the cache rather than replacing a full inbox with an
  // empty one that claims to be current.
  if (ids.length && !messages.length) {
    const err = new Error('Gmail returned no readable messages');
    err.retryable = true;
    throw err;
  }

  state.messages = messages;
  state.needsReconnect = false;
  state.needsSetup = false;

  if (failed) {
    // Partial results are worth showing, but they are not a fresh snapshot:
    // leave the timestamp and the cache alone so the dot stays up.
    state.stale = true;
    state.error = failed + ' of ' + ids.length + ' messages could not be loaded';
    return false;
  }

  state.lastSuccessAt = Date.now();
  state.stale = false;
  state.error = null;
  return true;
}

async function refresh() {
  if (inFlight) return getState();
  inFlight = true;
  try {
    // Only a complete fetch is allowed to overwrite the cache; a partial one
    // would replace known-good mail with a short list.
    if (await fetchMessages()) writeCache();
  } catch (err) {
    if (err.needsSetup) {
      state.needsSetup = true;
    } else if (err.needsReconnect) {
      // The refresh grant was rejected — the authoritative signal that the
      // credential is dead. Expected roughly weekly under Testing status.
      // auth.getAccessToken has already cleared the stored token.
      state.needsReconnect = true;
      stopPolling(); // nothing will succeed until the user reconnects
    } else if (err.authFailed) {
      // The API rejected the access token without the refresh grant failing.
      // Drop only the cached access token and let the next cycle re-mint one;
      // deleting the refresh token here would turn a hiccup into a re-consent.
      auth.forgetAccessToken();
      state.needsReconnect = !auth.isConnected();
    }
    state.stale = true;
    state.error = auth.redact(err.message);
  } finally {
    inFlight = false;
    emit();
  }
  return getState();
}

// --- scheduling ------------------------------------------------------------

function stopPolling() {
  if (timer) { clearInterval(timer); timer = null; }
}

function startPolling() {
  stopPolling();
  const cfg = config.load();
  const minutes = cfg.ok ? cfg.refreshMinutes : 5;
  timer = setInterval(refresh, minutes * 60 * 1000);
}

async function connect() {
  // Reload first. A startup with a missing or placeholder config caches a
  // negative result, and auth.connect() rejects on it — so reloading afterwards
  // was unreachable and fixing the file could only be picked up by restarting.
  config.reload();
  state.needsSetup = false;
  await auth.connect();
  const result = await refresh();
  // refresh() halts polling when it lands in a state nothing will recover from
  // (a declined scope, say); don't restart the timer it just stopped.
  if (!state.needsReconnect && !state.needsSetup) startPolling();
  return result;
}

function disconnect() {
  auth.disconnect();
  stopPolling();
  state.messages = [];
  state.needsReconnect = true;
  state.lastSuccessAt = null;
  writeCache();
  emit();
  return getState();
}

// Lets callers outside the fetch loop (the menu) put a failure on screen.
function reportError(err) {
  state.error = auth.redact((err && err.message) || 'Something went wrong');
  state.stale = true;
  if (err && err.needsSetup) state.needsSetup = true;
  emit();
  return getState();
}

function getState() {
  return {
    messages: state.messages,
    lastSuccessAt: state.lastSuccessAt,
    stale: state.stale,
    needsReconnect: state.needsReconnect,
    needsSetup: state.needsSetup,
    connected: auth.isConnected(),
    error: state.error,
  };
}

function init() {
  // Cache first, so an offline or expired start still renders something.
  readCache();
  const cfg = config.load();
  if (!cfg.ok) { state.needsSetup = true; state.error = cfg.reason; return; }
  if (!auth.isConnected()) { state.needsReconnect = true; return; }
  refresh();
  startPolling();
}

module.exports = { init, refresh, connect, disconnect, getState, onUpdated, reportError };

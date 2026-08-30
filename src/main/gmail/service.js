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
        if (response.statusCode === 401 || response.statusCode === 403) {
          const err = new Error('Gmail rejected the token');
          err.authFailed = true;
          reject(err);
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error('Gmail returned ' + response.statusCode));
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
  // Modest concurrency: enough to stay quick, far short of any rate limit.
  const CHUNK = 5;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const batch = await Promise.all(
      ids.slice(i, i + CHUNK).map((id) => apiGet(detailUrl(id), token).catch(() => null))
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
  state.messages = messages;
  state.lastSuccessAt = Date.now();
  state.stale = false;
  state.needsReconnect = false;
  state.needsSetup = false;
  state.error = null;
}

async function refresh() {
  if (inFlight) return getState();
  inFlight = true;
  try {
    await fetchMessages();
    writeCache();
  } catch (err) {
    if (err.needsSetup) {
      state.needsSetup = true;
    } else if (err.needsReconnect || err.authFailed) {
      // Expected roughly weekly under Testing status.
      state.needsReconnect = true;
      auth.disconnect();
      stopPolling(); // nothing will succeed until the user reconnects
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
  await auth.connect();
  config.reload();
  const result = await refresh();
  startPolling();
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

module.exports = { init, refresh, connect, disconnect, getState, onUpdated };

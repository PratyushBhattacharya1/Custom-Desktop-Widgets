// Loads gmail.local.json — the OAuth client the widget authenticates with.
//
// The client secret lives here in plaintext deliberately: Google documents that
// an installed app cannot keep one confidential, which is why the loopback
// redirect (not the secret) is what makes the flow safe. The refresh token is
// the credential that actually matters, and that goes to safeStorage instead.
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, '..', '..', '..', 'gmail.local.json');
const PLACEHOLDER = /^PASTE_/;

const DEFAULTS = {
  refreshMinutes: 5,
  maxMessages: 25,
  query: 'in:inbox',
};

let cached = null;

function load() {
  if (cached) return cached;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (err) {
    cached = {
      ok: false,
      reason: err.code === 'ENOENT'
        ? 'gmail.local.json not found — copy gmail.example.json and fill it in.'
        : 'gmail.local.json could not be parsed.',
    };
    return cached;
  }

  const clientId = typeof raw.clientId === 'string' ? raw.clientId.trim() : '';
  const clientSecret = typeof raw.clientSecret === 'string' ? raw.clientSecret.trim() : '';

  if (!clientId || PLACEHOLDER.test(clientId) || !clientSecret || PLACEHOLDER.test(clientSecret)) {
    cached = { ok: false, reason: 'Gmail is not configured yet — add your OAuth client to gmail.local.json.' };
    return cached;
  }

  const refreshMinutes = Number(raw.refreshMinutes);
  const maxMessages = Number(raw.maxMessages);

  cached = {
    ok: true,
    clientId,
    clientSecret,
    // Clamped at both ends: setInterval takes a 32-bit delay, so anything past
    // ~24 days silently becomes a 1ms timer and hammers the API.
    refreshMinutes: Number.isFinite(refreshMinutes) && refreshMinutes >= 1
      ? Math.min(refreshMinutes, 1440) : DEFAULTS.refreshMinutes,
    maxMessages: Number.isFinite(maxMessages) && maxMessages >= 1
      ? Math.min(Math.round(maxMessages), 50) : DEFAULTS.maxMessages,
    query: typeof raw.query === 'string' && raw.query.trim() ? raw.query.trim() : DEFAULTS.query,
  };
  return cached;
}

// Config is read once at startup; this exists so a reload can pick up edits.
function reload() {
  cached = null;
  return load();
}

module.exports = { load, reload, CONFIG_PATH };

// Persistent per-widget state, written to userData.
//
// Shape: { "<widgetId>": { x, y, w, h, pinned, settings: { ... } } }
//
// Two buckets. The top level is window state — the things the BrowserWindow
// itself owns and the OS enforces (setBounds, setMovable). `settings` is
// appearance and behaviour, which only the renderer cares about; see
// settings.js for its catalogue and sanitiser.
//
// Every key is additive, so older state files still load cleanly: a missing
// flag reads as false and a missing size falls back to the registry default.
//
// The filename is historical — it predates everything but x/y — and is kept
// because renaming it would either lose saved positions or require a fallback
// path maintained forever.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const configPath = path.join(app.getPath('userData'), 'widget-positions.json');

let cache = null;

function readAll() {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    cache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    cache = {};
  }
  return cache;
}

let writeTimer = null;

function flush() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (!cache) return;
  try {
    fs.writeFileSync(configPath, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error('Failed to save widget state:', err.message);
  }
}

// Debounced so dragging doesn't write on every pixel of movement.
function scheduleWrite() {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(flush, 250);
}

function get(id) {
  return readAll()[id] || {};
}

function patch(id, fields) {
  const all = readAll();
  all[id] = { ...all[id], ...fields };
  scheduleWrite();
  return all[id];
}

module.exports = { get, patch, flush, configPath };

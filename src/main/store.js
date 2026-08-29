// Persistent per-widget state (position + pinned flag), written to userData.
//
// Shape: { "<widgetId>": { x, y, pinned } }
// The `pinned` key is additive, so state files written before pinning existed
// still load cleanly — a missing flag simply reads as false.
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

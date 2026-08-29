// Owns calendar state for the main process: config, cached ICS text, parsed
// events, and month-window expansion.
//
// Parsing is done once per fetch and held in memory; expansion is done per
// requested month. Re-parsing 279KB on every month change would be wasteful,
// re-expanding one month is trivial.
const { app, powerMonitor } = require('electron');
const config = require('./config');
const feed = require('./feed');
const { parseCalendar } = require('../ics/vevent');
const { expandEvents } = require('../ics/expand');

let root = null;
let calendars = [];
let refreshMinutes = 60;
let problems = [];
let status = {};
const parsed = new Map(); // calendarId -> VEVENT[]
let refreshTimer = null;
let listeners = [];

function onUpdated(fn) {
  listeners.push(fn);
}

function emitUpdated() {
  const payload = { changedAt: Date.now() };
  listeners.forEach((fn) => {
    try {
      fn(payload);
    } catch {
      /* a dead renderer shouldn't break the others */
    }
  });
}

function ingest(id, icsText) {
  try {
    parsed.set(id, parseCalendar(icsText));
  } catch (err) {
    parsed.set(id, []);
    console.error(`Failed to parse calendar "${id}": ${feed.redact(err)}`);
  }
}

// Loads whatever is already on disk. Runs before any network request so an
// offline start still renders instantly.
function loadFromCache() {
  for (const cal of calendars) {
    const text = feed.readCache(cal.id);
    if (text === null) continue;
    ingest(cal.id, text);
    const age = feed.cacheAge(cal.id);
    status[cal.id] = { ok: true, lastSuccessAt: age, stale: true, fromCache: true };
  }
}

async function refresh() {
  if (!calendars.length) return { ok: false, reason: 'no-calendars' };
  const result = await feed.refreshAll(calendars, (id, text) => ingest(id, text));
  status = { ...status, ...result };
  emitUpdated();
  return { ok: Object.values(result).some((s) => s.ok) };
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (!calendars.length) return;
  refreshTimer = setInterval(() => {
    refresh().catch(() => {});
  }, refreshMinutes * 60 * 1000);
}

function init(projectRoot) {
  root = projectRoot;
  reloadConfig();

  loadFromCache();

  // Kick off a network refresh, but never block startup on it.
  refresh().catch((err) => console.error('Initial calendar refresh failed:', feed.redact(err)));
  scheduleRefresh();

  // A laptop that slept overnight should refresh on wake rather than waiting
  // out the remainder of its interval.
  try {
    powerMonitor.on('resume', () => {
      refresh().catch(() => {});
    });
  } catch {
    /* powerMonitor is unavailable on some platforms */
  }

  if (problems.length) {
    console.log('Calendar config notes:');
    problems.forEach((p) => console.log('  - ' + p));
  }
}

function reloadConfig() {
  const loaded = config.load(root || app.getAppPath());
  calendars = loaded.calendars;
  refreshMinutes = loaded.refreshMinutes;
  problems = loaded.problems;
  return loaded;
}

// Returns everything the calendar widget needs for one month.
function getMonth(year, month) {
  const windowStart = new Date(year, month, 1, 0, 0, 0, 0).getTime();
  const windowEnd = new Date(year, month + 1, 0, 23, 59, 59, 999).getTime();

  const instances = [];
  for (const cal of calendars) {
    const events = parsed.get(cal.id);
    if (!events || !events.length) continue;
    for (const inst of expandEvents(events, windowStart, windowEnd)) {
      instances.push({
        calId: cal.id,
        calName: cal.name,
        color: cal.color,
        uid: inst.uid,
        summary: inst.summary,
        location: inst.location,
        allDay: inst.allDay,
        startMs: inst.startMs,
        endMs: inst.endMs,
      });
    }
  }

  instances.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  return {
    instances,
    calendars: config.publicView(calendars),
    status,
    problems,
  };
}

module.exports = { init, refresh, getMonth, reloadConfig, onUpdated };

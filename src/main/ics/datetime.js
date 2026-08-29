// Date/time handling for ICS values, with zero dependencies.
//
// Three forms appear in real Google exports and all three must work:
//   DTSTART;VALUE=DATE:20260829                        -> all-day
//   DTSTART:20231102T170000Z                           -> UTC instant
//   DTSTART;TZID=America/Los_Angeles:20240401T080000   -> zoned wall time
//
// All-day values are anchored to LOCAL midnight so that reading .getDate() off
// the result yields the calendar day the user expects, regardless of where they
// are. Timed values resolve to a true instant.

// Constructing an Intl.DateTimeFormat is expensive; one per call across ~500
// events is a real perf cliff, so they're cached per zone.
const formatterCache = new Map();

function formatterFor(timeZone) {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

// How far `timeZone` is from UTC at a given instant, in ms.
function tzOffsetMs(utcMs, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const g = {};
  for (const p of parts) {
    if (p.type !== 'literal') g[p.type] = p.value;
  }
  // Some ICU builds emit hour "24" for midnight under hour12:false.
  let hour = parseInt(g.hour, 10);
  if (hour === 24) hour = 0;

  const asIfUtc = Date.UTC(
    parseInt(g.year, 10),
    parseInt(g.month, 10) - 1,
    parseInt(g.day, 10),
    hour,
    parseInt(g.minute, 10),
    parseInt(g.second, 10)
  );
  return asIfUtc - utcMs;
}

// Converts a wall-clock time in `timeZone` to a UTC instant.
//
// Two passes: the offset at the *guess* can differ from the offset at the
// *result* across a DST boundary, so the first pass gets us close and the
// second lands on the correct side.
function zonedWallToUtc(y, mo, d, h, mi, s, timeZone) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let offset = tzOffsetMs(guess, timeZone);
  offset = tzOffsetMs(guess - offset, timeZone);
  return guess - offset;
}

function isValidTimeZone(tz) {
  if (!tz) return false;
  try {
    formatterFor(tz);
    return true;
  } catch {
    return false;
  }
}

// Parses a DATE or DATE-TIME property value into a normalised descriptor.
// Returns null when the value isn't a recognisable date.
function parseIcsDate(value, params) {
  const v = String(value || '').trim();
  if (!v) return null;

  const dateOnly = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (dateOnly || params.VALUE === 'DATE') {
    const m = dateOnly || /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    const y = +m[1];
    const mo = +m[2];
    const d = +m[3];
    return {
      allDay: true,
      y,
      mo,
      d,
      h: 0,
      mi: 0,
      s: 0,
      tz: null,
      // Local midnight: keeps the event on the intended calendar square.
      ms: new Date(y, mo - 1, d, 0, 0, 0, 0).getTime(),
    };
  }

  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(v);
  if (!dt) return null;

  const y = +dt[1];
  const mo = +dt[2];
  const d = +dt[3];
  const h = +dt[4];
  const mi = +dt[5];
  const s = +dt[6];
  const isUtc = dt[7] === 'Z';

  let ms;
  let tz = null;

  if (isUtc) {
    ms = Date.UTC(y, mo - 1, d, h, mi, s);
  } else if (isValidTimeZone(params.TZID)) {
    tz = params.TZID;
    ms = zonedWallToUtc(y, mo, d, h, mi, s, tz);
  } else {
    // Floating time (or an unknown TZID): interpret as local wall time.
    ms = new Date(y, mo - 1, d, h, mi, s).getTime();
  }

  return { allDay: false, y, mo, d, h, mi, s, tz, isUtc, ms };
}

// Local calendar-day key, used to match RECURRENCE-ID and EXDATE by date rather
// than by exact instant. Necessary because an all-day master can carry a TIMED
// RECURRENCE-ID, which exact comparison would never match.
function localDateKey(ms) {
  const dt = new Date(ms);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Parses an ISO-ish DURATION (e.g. -P0DT7H0M0S, P1D, PT30M) into ms.
function parseDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    String(value || '').trim()
  );
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const weeks = +(m[2] || 0);
  const days = +(m[3] || 0);
  const hours = +(m[4] || 0);
  const mins = +(m[5] || 0);
  const secs = +(m[6] || 0);
  return (
    sign *
    (weeks * 604800000 + days * 86400000 + hours * 3600000 + mins * 60000 + secs * 1000)
  );
}

module.exports = {
  parseIcsDate,
  zonedWallToUtc,
  tzOffsetMs,
  localDateKey,
  parseDuration,
  isValidTimeZone,
};

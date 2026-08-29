// A deliberately narrow RRULE engine.
//
// Real Google exports of this calendar only ever use FREQ=WEEKLY (with BYDAY,
// UNTIL, occasionally COUNT) and FREQ=YEARLY. A general RRULE implementation
// would be an order of magnitude more code for no benefit here.
//
// Two rules drive the design:
//   1. Occurrences are generated in the master's own WALL-CLOCK timezone and
//      only then converted to instants. Stepping by 7*86400000ms in UTC makes an
//      8:00 AM event drift to 9:00 AM across a DST boundary.
//   2. COUNT counts from DTSTART, not from the start of the requested window,
//      so a COUNT rule cannot be jump-started.
const { zonedWallToUtc } = require('./datetime');

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const MAX_INSTANCES = 2000;
const MAX_ITERATIONS = 20000;

const DAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRRule(text) {
  const rule = {
    freq: null,
    interval: 1,
    count: null,
    until: null,
    untilDateOnly: false,
    byDay: [],
    byMonth: [],
    byMonthDay: [],
    wkst: 'MO',
  };

  for (const part of String(text || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).toUpperCase();
    const value = part.slice(eq + 1);

    switch (key) {
      case 'FREQ':
        rule.freq = value.toUpperCase();
        break;
      case 'INTERVAL':
        rule.interval = Math.max(1, parseInt(value, 10) || 1);
        break;
      case 'COUNT':
        rule.count = parseInt(value, 10) || null;
        break;
      case 'WKST':
        rule.wkst = value.toUpperCase();
        break;
      case 'UNTIL':
        // Both forms occur in real data: a full UTC datetime, and a bare date.
        if (/^\d{8}$/.test(value)) {
          rule.until = {
            y: +value.slice(0, 4),
            mo: +value.slice(4, 6),
            d: +value.slice(6, 8),
          };
          rule.untilDateOnly = true;
        } else {
          const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/.exec(value);
          if (m) {
            rule.until = { ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) };
          }
        }
        break;
      case 'BYDAY':
        for (const token of value.split(',')) {
          // Ordinal prefixes (2SU) appear only in VTIMEZONE rules, never in the
          // VEVENTs here, but strip them rather than choke.
          const code = token.replace(/^[+-]?\d+/, '').toUpperCase();
          if (code in DAY_CODES) rule.byDay.push(DAY_CODES[code]);
        }
        rule.byDay.sort((a, b) => a - b);
        break;
      case 'BYMONTH':
        rule.byMonth = value.split(',').map((v) => parseInt(v, 10)).filter(Boolean);
        break;
      case 'BYMONTHDAY':
        rule.byMonthDay = value.split(',').map((v) => parseInt(v, 10)).filter(Boolean);
        break;
      default:
        break;
    }
  }

  return rule.freq ? rule : null;
}

// Resolves a wall-clock y/m/d (carrying the master's time-of-day) to an instant.
function materialise(start, y, mo, d) {
  if (start.allDay) {
    return new Date(y, mo - 1, d, 0, 0, 0, 0).getTime();
  }
  if (start.tz) {
    return zonedWallToUtc(y, mo, d, start.h, start.mi, start.s, start.tz);
  }
  // UTC-anchored or floating masters keep their original offset behaviour.
  if (start.isUtc) {
    return Date.UTC(y, mo - 1, d, start.h, start.mi, start.s);
  }
  return new Date(y, mo - 1, d, start.h, start.mi, start.s).getTime();
}

function untilExceeded(rule, y, mo, d, ms) {
  if (!rule.until) return false;
  if (rule.untilDateOnly) {
    const u = rule.until;
    if (y !== u.y) return y > u.y;
    if (mo !== u.mo) return mo > u.mo;
    return d > u.d;
  }
  return ms > rule.until.ms;
}

// Expands a recurrence into instant timestamps overlapping [windowStart, windowEnd].
function expandRRule(rruleText, start, windowStart, windowEnd) {
  const rule = parseRRule(rruleText);
  if (!rule) return [];

  const out = [];
  let emitted = 0;
  let iterations = 0;

  if (rule.freq === 'WEEKLY') {
    const days = rule.byDay.length ? rule.byDay : [new Date(start.ms).getDay()];

    // Anchor on the Sunday of DTSTART's week, then step whole weeks. Wall-clock
    // date arithmetic via the local Date constructor, never raw ms addition.
    const anchor = new Date(start.y, start.mo - 1, start.d);
    anchor.setDate(anchor.getDate() - anchor.getDay());

    // Jump-start: with no COUNT we can skip straight to the window. With COUNT
    // we must walk from the beginning, because COUNT is measured from DTSTART.
    let weekIndex = 0;
    if (rule.count === null && windowStart > start.ms) {
      const weeksAway = Math.floor((windowStart - anchor.getTime()) / WEEK_MS);
      weekIndex = Math.max(0, weeksAway - (weeksAway % rule.interval) - rule.interval);
    }

    while (iterations++ < MAX_ITERATIONS && emitted < MAX_INSTANCES) {
      const weekStart = new Date(anchor);
      weekStart.setDate(weekStart.getDate() + weekIndex * 7);
      if (weekStart.getTime() > windowEnd + WEEK_MS) break;

      let sawValid = false;
      for (const dow of days) {
        const day = new Date(weekStart);
        day.setDate(day.getDate() + dow);
        const y = day.getFullYear();
        const mo = day.getMonth() + 1;
        const d = day.getDate();
        const ms = materialise(start, y, mo, d);

        if (ms < start.ms) continue;
        if (untilExceeded(rule, y, mo, d, ms)) {
          iterations = MAX_ITERATIONS; // done
          break;
        }
        sawValid = true;
        emitted++;
        if (rule.count !== null && emitted > rule.count) {
          iterations = MAX_ITERATIONS;
          break;
        }
        if (ms >= windowStart && ms <= windowEnd) out.push(ms);
      }
      void sawValid;
      weekIndex += rule.interval;
    }
    return out;
  }

  if (rule.freq === 'YEARLY') {
    const baseMonth = rule.byMonth.length ? rule.byMonth[0] : start.mo;
    const baseDay = rule.byMonthDay.length ? rule.byMonthDay[0] : start.d;

    let year = start.y;
    if (rule.count === null) {
      const windowYear = new Date(windowStart).getFullYear();
      if (windowYear > year) {
        const step = Math.floor((windowYear - year) / rule.interval) * rule.interval;
        year += Math.max(0, step - rule.interval);
      }
    }

    while (iterations++ < MAX_ITERATIONS && emitted < MAX_INSTANCES) {
      const ms = materialise(start, year, baseMonth, baseDay);
      if (ms > windowEnd + 366 * DAY_MS) break;
      if (untilExceeded(rule, year, baseMonth, baseDay, ms)) break;

      if (ms >= start.ms) {
        emitted++;
        if (rule.count !== null && emitted > rule.count) break;
        if (ms >= windowStart && ms <= windowEnd) out.push(ms);
      }
      year += rule.interval;
    }
    return out;
  }

  if (rule.freq === 'DAILY') {
    const cursor = new Date(start.y, start.mo - 1, start.d);
    while (iterations++ < MAX_ITERATIONS && emitted < MAX_INSTANCES) {
      const y = cursor.getFullYear();
      const mo = cursor.getMonth() + 1;
      const d = cursor.getDate();
      const ms = materialise(start, y, mo, d);
      if (ms > windowEnd) break;
      if (untilExceeded(rule, y, mo, d, ms)) break;
      if (ms >= start.ms) {
        emitted++;
        if (rule.count !== null && emitted > rule.count) break;
        if (ms >= windowStart && ms <= windowEnd) out.push(ms);
      }
      cursor.setDate(cursor.getDate() + rule.interval);
    }
    return out;
  }

  if (rule.freq === 'MONTHLY') {
    const dayOfMonth = rule.byMonthDay.length ? rule.byMonthDay[0] : start.d;
    let cursor = new Date(start.y, start.mo - 1, 1);
    while (iterations++ < MAX_ITERATIONS && emitted < MAX_INSTANCES) {
      const y = cursor.getFullYear();
      const mo = cursor.getMonth() + 1;
      const ms = materialise(start, y, mo, dayOfMonth);
      if (ms > windowEnd) break;
      if (untilExceeded(rule, y, mo, dayOfMonth, ms)) break;
      if (ms >= start.ms) {
        emitted++;
        if (rule.count !== null && emitted > rule.count) break;
        if (ms >= windowStart && ms <= windowEnd) out.push(ms);
      }
      cursor = new Date(y, cursor.getMonth() + rule.interval, 1);
    }
    return out;
  }

  return out;
}

module.exports = { parseRRule, expandRRule, MAX_INSTANCES };

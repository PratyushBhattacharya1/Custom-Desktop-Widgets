// A deliberately narrow RRULE engine.
//
// It expands the rules real calendar feeds contain: DAILY, WEEKLY with BYDAY,
// MONTHLY on days of the month (BYMONTHDAY=15,-1) or weekdays of the month
// (BYDAY=2TU, -1FR), and YEARLY with BYMONTH plus either, all with INTERVAL,
// COUNT and UNTIL. A general RRULE implementation (BYSETPOS, BYWEEKNO,
// BYYEARDAY, sub-daily frequencies) would be an order of magnitude more code
// for rules these feeds don't use.
//
// Three rules drive the design:
//   1. Occurrences are generated in the master's own WALL-CLOCK timezone and
//      only then converted to instants. Stepping by 7*86400000ms in UTC makes an
//      8:00 AM event drift to 9:00 AM across a DST boundary.
//   2. COUNT counts from DTSTART, not from the start of the requested window,
//      so a COUNT rule cannot be jump-started.
//   3. A rule with a part the engine doesn't implement shows only DTSTART, its
//      first instance. Ignoring the part would put every later instance on a
//      wrong date, which is worse than leaving them out.
const { zonedWallToUtc } = require('./datetime');

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const MAX_INSTANCES = 2000;
const MAX_ITERATIONS = 20000;

// The loops below step through local dates, but an instance can fall up to 26
// hours either side of local midnight on its own wall-clock date, because
// zones run from UTC-12 to UTC+14. Jump-starts and window checks on dates keep
// two days of slack, so they never skip an instance.
const SLACK_MS = 2 * DAY_MS;

const DAY_CODES = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRRule(text) {
  const rule = {
    freq: null,
    interval: 1,
    count: null,
    until: null,
    untilDateOnly: false,
    byDay: [],
    byDayNth: [],
    byMonth: [],
    byMonthDay: [],
    wkst: 'MO',
    unsupported: false,
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
        // An unreadable COUNT would make the series endless.
        if (rule.count === null || rule.count < 0) rule.unsupported = true;
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
          } else {
            rule.unsupported = true; // an unreadable UNTIL would make the series endless
          }
        }
        break;
      case 'BYDAY':
        // An ordinal (2TU, -1FR) picks one of that weekday's dates in the month,
        // and a bare weekday picks each of them. WEEKLY reads only the weekday,
        // since RFC 5545 allows no ordinal there.
        for (const token of value.split(',')) {
          const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(token.trim());
          if (!m) {
            rule.unsupported = true;
            continue;
          }
          const dow = DAY_CODES[m[2].toUpperCase()];
          rule.byDay.push(dow);
          rule.byDayNth.push({ n: m[1] ? parseInt(m[1], 10) : 0, dow });
        }
        rule.byDay.sort((a, b) => a - b);
        break;
      case 'BYMONTH':
        rule.byMonth = value.split(',').map(Number).sort((a, b) => a - b);
        if (!rule.byMonth.every((mo) => Number.isInteger(mo) && mo >= 1 && mo <= 12)) rule.unsupported = true;
        break;
      case 'BYMONTHDAY':
        rule.byMonthDay = value.split(',').map(Number);
        if (!rule.byMonthDay.every((d) => Number.isInteger(d) && d !== 0 && d >= -31 && d <= 31)) rule.unsupported = true;
        break;
      default:
        // BYSETPOS, BYWEEKNO, BYYEARDAY, BYHOUR and the rest.
        rule.unsupported = true;
        break;
    }
  }

  return rule.freq ? rule : null;
}

// Whether the engine implements every part of `rule`, in the combination given.
function supported(rule) {
  if (rule.unsupported) return false;
  const byDay = rule.byDay.length > 0;
  const byMonthDay = rule.byMonthDay.length > 0;
  const byMonth = rule.byMonth.length > 0;
  switch (rule.freq) {
    case 'DAILY':
      return !byDay && !byMonthDay && !byMonth;
    case 'WEEKLY':
      // Weeks run from Sunday below. With INTERVAL>1, WKST decides which week a
      // day before it belongs to, so WKST=MO with a Sunday would land a week out.
      return !byMonthDay && !byMonth && !(rule.interval > 1 && rule.byDay.some((d) => d < DAY_CODES[rule.wkst]));
    case 'MONTHLY':
      // BYDAY with BYMONTHDAY means the dates both pick (Friday the 13th).
      return !byMonth && !(byDay && byMonthDay);
    case 'YEARLY':
      // Without BYMONTH, a BYDAY ordinal counts weeks of the year (20MO) and a
      // BYMONTHDAY applies to every month.
      return !(byDay && byMonthDay) && (byMonth || (!byDay && !byMonthDay));
    default:
      return false; // HOURLY, MINUTELY, SECONDLY
  }
}

// Whether expandRRule expands `rruleText` in full, rather than showing only
// DTSTART.
function isSupported(rruleText) {
  const rule = parseRRule(rruleText);
  return rule !== null && supported(rule);
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

// Days in a wall-clock month.
function daysIn(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

// The days of month y/mo that a MONTHLY or YEARLY rule picks, ascending. A
// negative BYMONTHDAY counts back from the end, so -1 is the last day. A day
// the month doesn't have (31 April, 29 February in a common year, a fifth
// Monday) is left out: RFC 5545 skips it rather than rolling it into the next
// month, so it doesn't count toward COUNT either.
function monthDays(rule, start, y, mo) {
  const last = daysIn(y, mo);
  let days;
  if (rule.byMonthDay.length) {
    days = rule.byMonthDay.map((n) => (n > 0 ? n : last + 1 + n));
  } else if (rule.byDayNth.length) {
    days = [];
    const firstDow = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    for (const { n, dow } of rule.byDayNth) {
      const dates = [];
      for (let d = 1 + ((dow - firstDow + 7) % 7); d <= last; d += 7) dates.push(d);
      if (n === 0) days.push(...dates);
      else days.push(n > 0 ? dates[n - 1] : dates[dates.length + n]);
    }
  } else {
    days = [start.d];
  }
  return [...new Set(days)].filter((d) => d >= 1 && d <= last).sort((a, b) => a - b);
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
  if (!rule || !supported(rule)) {
    return start.ms >= windowStart && start.ms <= windowEnd ? [start.ms] : [];
  }

  const out = [];
  let emitted = 0;
  let iterations = 0;

  // Takes the next date of a DAILY, MONTHLY or YEARLY series, which must come
  // in order. Returns false once the series has ended or passed the window.
  function visit(y, mo, d) {
    const ms = materialise(start, y, mo, d);
    if (ms > windowEnd || untilExceeded(rule, y, mo, d, ms)) return false;
    if (ms < start.ms) return true;
    emitted++;
    if (rule.count !== null && emitted > rule.count) return false;
    if (ms >= windowStart) out.push(ms);
    return true;
  }

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
        emitted++;
        if (rule.count !== null && emitted > rule.count) {
          iterations = MAX_ITERATIONS;
          break;
        }
        if (ms >= windowStart && ms <= windowEnd) out.push(ms);
      }
      weekIndex += rule.interval;
    }
    return out;
  }

  if (rule.freq === 'YEARLY') {
    const months = rule.byMonth.length ? rule.byMonth : [start.mo];

    let year = start.y;
    if (rule.count === null) {
      const windowYear = new Date(windowStart).getFullYear();
      if (windowYear > year) {
        const step = Math.floor((windowYear - year) / rule.interval) * rule.interval;
        year += Math.max(0, step - rule.interval);
      }
    }

    while (iterations++ < MAX_ITERATIONS && emitted < MAX_INSTANCES) {
      // Checked per year as well as per date, because a rule can go years
      // without a date (29 February with INTERVAL=3).
      if (new Date(year, 0, 1).getTime() > windowEnd + SLACK_MS) break;
      const y = year;
      if (!months.every((mo) => monthDays(rule, start, y, mo).every((d) => visit(y, mo, d)))) break;
      year += rule.interval;
    }
    return out;
  }

  if (rule.freq === 'DAILY') {
    const cursor = new Date(start.y, start.mo - 1, start.d);

    // Jump-start, as WEEKLY does, to a whole number of intervals short of the
    // window. Without it, a series that began years ago would run into
    // MAX_INSTANCES before reaching the window, and show nothing.
    if (rule.count === null && windowStart > start.ms) {
      const daysAway = Math.floor((windowStart - SLACK_MS - cursor.getTime()) / DAY_MS);
      if (daysAway > 0) cursor.setDate(cursor.getDate() + daysAway - (daysAway % rule.interval));
    }

    while (iterations++ < MAX_ITERATIONS && emitted < MAX_INSTANCES) {
      if (!visit(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate())) break;
      cursor.setDate(cursor.getDate() + rule.interval);
    }
    return out;
  }

  if (rule.freq === 'MONTHLY') {
    let cursor = new Date(start.y, start.mo - 1, 1);

    // Jump-start, as WEEKLY does, to a whole number of intervals short of the
    // window's month, less a month of slack.
    if (rule.count === null && windowStart > start.ms) {
      const w = new Date(windowStart);
      const monthsAway = (w.getFullYear() - start.y) * 12 + (w.getMonth() + 1 - start.mo) - 1;
      if (monthsAway > 0) cursor = new Date(start.y, start.mo - 1 + monthsAway - (monthsAway % rule.interval), 1);
    }

    while (iterations++ < MAX_ITERATIONS && emitted < MAX_INSTANCES) {
      // Checked per month as well as per date, because a rule can pick no
      // date in a month (BYMONTHDAY=31 every other month from February).
      if (cursor.getTime() > windowEnd + SLACK_MS) break;
      const y = cursor.getFullYear();
      const mo = cursor.getMonth() + 1;
      if (!monthDays(rule, start, y, mo).every((d) => visit(y, mo, d))) break;
      cursor = new Date(y, cursor.getMonth() + rule.interval, 1);
    }
    return out;
  }

  return out;
}

module.exports = { parseRRule, expandRRule, isSupported, MAX_INSTANCES };

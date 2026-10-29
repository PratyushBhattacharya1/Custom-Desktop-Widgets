// A deliberately narrow RRULE engine.
//
// It expands the rules real calendar feeds contain: DAILY, WEEKLY with BYDAY,
// MONTHLY on days of the month (BYMONTHDAY=15,-1) or weekdays of the month
// (BYDAY=2TU, -1FR), and YEARLY with BYMONTH plus either, all with INTERVAL,
// COUNT, UNTIL and WKST. Where RFC 5545 makes a part a limit rather than an
// expansion, it limits: DAILY;BYDAY=MO,TU,WE,TH,FR is every weekday, and
// BYMONTH keeps a DAILY, WEEKLY or MONTHLY rule to its months. A general RRULE
// implementation (BYSETPOS, BYWEEKNO, BYYEARDAY, sub-daily frequencies) would
// be an order of magnitude more code for rules these feeds don't use.
//
// Four rules drive the design:
//   1. Occurrences are generated in the master's own WALL-CLOCK timezone and
//      only then converted to instants. Stepping by 7*86400000ms in UTC makes an
//      8:00 AM event drift to 9:00 AM across a DST boundary.
//   2. COUNT counts from DTSTART, not from the start of the requested window.
//      A COUNT rule skips ahead to the window only where it can count what it
//      skips: a DAILY rule with no limits, where each step is one instance.
//   3. DTSTART is always the first instance, and counts toward COUNT, even when
//      it isn't one of the rule's own dates (RFC 5545 section 3.8.5.3).
//   4. A rule with a part the engine doesn't implement shows only DTSTART.
//      Ignoring the part would put every later instance on a wrong date, which
//      is worse than leaving them out.
const { zonedWallToUtc } = require('./datetime');

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const MAX_INSTANCES = 2000;
const MAX_ITERATIONS = 20000;

// The loops below step through local dates, but an instance can fall from 26
// hours before to 50 hours after local midnight on its own wall-clock date:
// zones run from UTC-12 to UTC+14, and the time of day adds up to 24 hours.
// A jump-start lands at least two days short of the window, so the last date
// it skips has its instance about 22 hours before the window at the latest. A
// loop stops at a period that starts more than two days after the window, so
// that period's first instance falls about 22 hours after it at the earliest.
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
        rule.interval = /^\d+$/.test(value) ? +value : 0;
        // An unreadable INTERVAL would put every instance after DTSTART on a
        // wrong date.
        if (rule.interval < 1) rule.unsupported = true;
        break;
      case 'COUNT':
        rule.count = parseInt(value, 10) || null;
        // An unreadable COUNT would make the series endless.
        if (rule.count === null || rule.count < 0) rule.unsupported = true;
        break;
      case 'WKST':
        rule.wkst = value.toUpperCase();
        if (!Object.hasOwn(DAY_CODES, rule.wkst)) rule.unsupported = true;
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
          const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value);
          if (m) {
            const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
            // With Z, UNTIL is an instant. Without, it's a wall-clock time in
            // DTSTART's own zone, which expandRRule resolves.
            rule.until = m[7] ? { ms: Date.UTC(y, mo - 1, d, h, mi, s) } : { wall: [y, mo, d, h, mi, s] };
          } else {
            rule.unsupported = true; // an unreadable UNTIL would make the series endless
          }
        }
        break;
      case 'BYDAY':
        // An ordinal (2TU, -1FR) picks one of that weekday's dates in the month,
        // and a bare weekday (n 0) picks each of them.
        for (const token of value.split(',')) {
          const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(token.trim());
          // An unreadable token, or a 0 ordinal, which names no date.
          if (!m || (m[1] !== undefined && +m[1] === 0)) {
            rule.unsupported = true;
            continue;
          }
          rule.byDay.push({ n: m[1] ? parseInt(m[1], 10) : 0, dow: DAY_CODES[m[2].toUpperCase()] });
        }
        break;
      case 'BYMONTH':
        rule.byMonth = [...new Set(value.split(',').map(Number))].sort((a, b) => a - b);
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
  const ordinal = rule.byDay.some((x) => x.n !== 0);
  const byMonthDay = rule.byMonthDay.length > 0;
  const byMonth = rule.byMonth.length > 0;
  switch (rule.freq) {
    case 'DAILY':
      // BYDAY, BYMONTHDAY and BYMONTH only limit the days. RFC 5545 allows no
      // ordinal outside MONTHLY and YEARLY.
      return !ordinal;
    case 'WEEKLY':
      // BYMONTH limits the days. RFC 5545 allows no BYMONTHDAY here.
      return !ordinal && !byMonthDay;
    case 'MONTHLY':
      // BYDAY with BYMONTHDAY means the dates both pick (Friday the 13th).
      return !(byDay && byMonthDay);
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

// The weekday of a wall-clock date, 0 for Sunday. UTC has no DST, so this is
// the calendar's own weekday, whatever zone the date is in.
function weekday(y, mo, d) {
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

// The day a BYMONTHDAY value names in a month of `last` days. A negative value
// counts back from the end, so -1 is the last day.
function monthDay(n, last) {
  return n > 0 ? n : last + 1 + n;
}

// The days of month y/mo that a MONTHLY or YEARLY rule picks, ascending and
// once each, since visit() takes dates in order. A day the month doesn't have
// (31 April, 29 February in a common year, a fifth Monday) is left out: RFC
// 5545 skips it rather than rolling it into the next month, so it doesn't
// count toward COUNT either.
function monthDays(rule, start, y, mo) {
  const last = daysIn(y, mo);
  let days;
  if (rule.byMonthDay.length) {
    days = rule.byMonthDay.map((n) => monthDay(n, last));
  } else if (rule.byDay.length) {
    days = [];
    const firstDow = weekday(y, mo, 1);
    for (const { n, dow } of rule.byDay) {
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

// Whether y/mo/d passes the rule's limits: BYMONTH keeps a DAILY, WEEKLY or
// MONTHLY rule to its months, and BYMONTHDAY and BYDAY keep a DAILY rule to
// their days. Where a part expands instead (BYMONTH on YEARLY, BYDAY on WEEKLY,
// BYMONTHDAY and BYDAY on MONTHLY and YEARLY), every date it produced passes,
// so one test serves every frequency.
function inLimits(rule, y, mo, d) {
  if (rule.byMonth.length && !rule.byMonth.includes(mo)) return false;
  if (rule.byMonthDay.length && !rule.byMonthDay.some((n) => monthDay(n, daysIn(y, mo)) === d)) return false;
  if (rule.byDay.length && !rule.byDay.some((x) => x.dow === weekday(y, mo, d))) return false;
  return true;
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
  const out = start.ms >= windowStart && start.ms <= windowEnd ? [start.ms] : [];
  if (!rule || !supported(rule)) return out;

  // A floating UNTIL bounds wall-clock times, so it's read the way the
  // instances are, in DTSTART's own zone.
  if (rule.until && rule.until.wall) {
    const [y, mo, d, h, mi, s] = rule.until.wall;
    rule.until = { ms: materialise({ ...start, allDay: false, h, mi, s }, y, mo, d) };
  }

  let emitted = 1; // DTSTART
  let iterations = 0;

  // Each loop steps a period (a day, week, month or year) at a time, and stops
  // after MAX_ITERATIONS of them if the rule never ends. MAX_INSTANCES caps the
  // instances in the window only: capping the ones before it as well cut a
  // long COUNT series off before it reached the window.
  const more = () => iterations++ < MAX_ITERATIONS && out.length < MAX_INSTANCES;

  // Takes the next date of the series, which must come in order. Returns false
  // once the series has ended or passed the window.
  function visit(y, mo, d) {
    const ms = materialise(start, y, mo, d);
    if (ms > windowEnd || untilExceeded(rule, y, mo, d, ms)) return false;
    // DTSTART is in already, and a date the limits rule out isn't an instance.
    if (ms <= start.ms || !inLimits(rule, y, mo, d)) return true;
    emitted++;
    if (rule.count !== null && emitted > rule.count) return false;
    if (ms >= windowStart) out.push(ms);
    return true;
  }

  if (rule.freq === 'WEEKLY') {
    // Weeks start on WKST, Monday unless the rule says otherwise. With an
    // INTERVAL above 1 that decides which weeks a day falls in: under WKST=MO a
    // Sunday ends the week its Monday starts. Each day is an offset from the
    // start of the week. With no BYDAY it's DTSTART's own weekday, read from
    // its wall-clock date, not from its instant in the machine's zone.
    const wkst = DAY_CODES[rule.wkst];
    const weekdays = rule.byDay.length
      ? [...new Set(rule.byDay.map((x) => x.dow))]
      : [weekday(start.y, start.mo, start.d)];
    const offsets = weekdays.map((dow) => (dow - wkst + 7) % 7).sort((a, b) => a - b);

    // Anchor on the start of DTSTART's week, then step whole weeks. Wall-clock
    // date arithmetic via the local Date constructor, never raw ms addition.
    const anchor = new Date(start.y, start.mo - 1, start.d);
    anchor.setDate(anchor.getDate() - ((anchor.getDay() - wkst + 7) % 7));

    // Jump-start: with no COUNT we can skip straight to the window. With COUNT
    // we must walk from the beginning, because COUNT is measured from DTSTART.
    let weekIndex = 0;
    if (rule.count === null && windowStart > start.ms) {
      const weeksAway = Math.floor((windowStart - anchor.getTime()) / WEEK_MS);
      weekIndex = Math.max(0, weeksAway - (weeksAway % rule.interval) - rule.interval);
    }

    while (more()) {
      const weekStart = new Date(anchor);
      weekStart.setDate(weekStart.getDate() + weekIndex * 7);
      if (weekStart.getTime() > windowEnd + WEEK_MS) break;
      const ongoing = offsets.every((offset) => {
        const day = new Date(weekStart);
        day.setDate(day.getDate() + offset);
        return visit(day.getFullYear(), day.getMonth() + 1, day.getDate());
      });
      if (!ongoing) break;
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

    while (more()) {
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
    // window, so a series that began years ago doesn't walk every day since.
    // With no limits each step is one instance, so a COUNT rule can jump too
    // and count the steps it skips. With limits, it has to walk.
    const limited = rule.byDay.length || rule.byMonth.length || rule.byMonthDay.length;
    if ((rule.count === null || !limited) && windowStart > start.ms) {
      const daysAway = Math.floor((windowStart - SLACK_MS - cursor.getTime()) / DAY_MS);
      const skip = daysAway - (daysAway % rule.interval);
      if (skip > 0) {
        cursor.setDate(cursor.getDate() + skip);
        // The first step skipped is DTSTART's, counted already.
        emitted += skip / rule.interval - 1;
      }
    }

    while (more()) {
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

    while (more()) {
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

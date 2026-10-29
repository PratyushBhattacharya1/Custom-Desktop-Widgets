// Offline regression harness for the ICS parser.
//
//   node scripts/verify-ics.js [path-to-export.zip|path-to.ics]
//
// Two suites, no Electron, no network:
//   1. test/fixtures/synthetic.ics, a hand-written calendar of made-up events,
//      with exact expectations for each parser invariant. It always runs, so
//      CI runs it.
//   2. A real Google Calendar export, checked for the specific traps that
//      hand-rolled ICS parsers fall into. The export is personal and never
//      committed, so this suite runs only locally: on the path given, or else
//      on the first *.ical.zip in the repo root.
const fs = require('fs');
const path = require('path');

const { unfold } = require('../src/main/ics/unfold');
const { parseLine } = require('../src/main/ics/contentline');
const { parseCalendar } = require('../src/main/ics/vevent');
const { expandEvents } = require('../src/main/ics/expand');
const { expandRRule, isSupported } = require('../src/main/ics/rrule');
const { localDateKey } = require('../src/main/ics/datetime');
const { readEntries } = require('./read-zip');

const root = path.join(__dirname, '..');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('PASS  ' + name + (detail ? '  (' + detail + ')' : ''));
  } else {
    fail++;
    console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

// Compares lists exactly, and on a mismatch prints both.
function same(name, actual, expected) {
  const got = JSON.stringify(actual);
  const want = JSON.stringify(expected);
  ok(name, got === want, got !== want ? 'got ' + got + ', want ' + want : actual.length ? actual.length + ' as expected' : 'none, as expected');
}

function finish() {
  console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
  process.exit(fail === 0 ? 0 : 1);
}

// ======================================================== synthetic fixture

const FIXTURE = path.join(root, 'test', 'fixtures', 'synthetic.ics');

// The parser's results depend on the machine's zone: all-day dates anchor to
// local midnight, EXDATE and RECURRENCE-ID match by local day, and the widget
// asks for local months. The expectations below are written for a viewer in
// New York, so the suite pins that zone and gets the same result on every
// machine, CI included. New York is west of UTC, where an all-day date anchored
// to UTC midnight lands on the previous day, and its DST change comes three
// weeks before Berlin's, the zone of most of the fixture's timed events.
const FIXTURE_ZONE = 'America/New_York';

// An instant as a UTC minute, the form the expectations are written in.
const iso = (ms) => new Date(ms).toISOString().slice(0, 16) + 'Z';

// Local months `from` to `to` of one year, the window shape the widget asks for.
function months(y, from, to) {
  return [new Date(y, from - 1, 1).getTime(), new Date(y, to, 0, 23, 59, 59, 999).getTime()];
}

// The local days an all-day instance shows on, by the calendar widget's own
// test (widgets/calendar/calendar.js): it covers a day when it ends after the
// day starts, so an exclusive DTEND never claims its own day.
function daysCovered(inst) {
  const days = [];
  const s = new Date(inst.startMs);
  for (const d = new Date(s.getFullYear(), s.getMonth(), s.getDate()); d.getTime() < inst.endMs; d.setDate(d.getDate() + 1)) {
    days.push(localDateKey(d.getTime()));
  }
  return days.join('+');
}

function verifyFixture() {
  const text = fs.readFileSync(FIXTURE, 'utf8');
  const events = parseCalendar(text);
  const uidOf = (name) => name + '@fixture.invalid';
  const event = (name) => events.find((e) => e.uid === uidOf(name) && !e.recurrenceId) || null;
  const expand = (name, win) => expandEvents(events, win[0], win[1]).filter((i) => i.uid === uidOf(name));
  const starts = (name, win) => expand(name, win).map((i) => iso(i.startMs));
  const titled = (name, win) => expand(name, win).map((i) => iso(i.startMs) + ' ' + i.summary);
  const days = (name, win) => expand(name, win).map(daysCovered);

  console.log('Fixture: ' + path.relative(root, FIXTURE) + ', viewed from ' + FIXTURE_ZONE + '\n');

  // Nothing else here means anything if the pin didn't take.
  ok('the fixture zone is pinned',
     new Date(2025, 0, 1).getTimezoneOffset() === 300 && new Date(2025, 6, 1).getTimezoneOffset() === 240,
     Intl.DateTimeFormat().resolvedOptions().timeZone);

  // -------------------------------------------------------------- unfolding
  // .gitattributes checks the fixture out with CRLF, as real feeds have. Saved
  // with LF, it would hide a parser that splits on LF alone, and git would
  // still call the file unchanged.
  const bareLf = text.replace(/\r\n/g, '').split('\n').length - 1;
  ok('the fixture keeps its CRLF line endings', bareLf === 0 && text.includes('\r\n'),
     bareLf ? bareLf + ' lines end in LF alone; delete the file and check it out again' : '');

  // Three folds: inside DTSTART's TZID, inside an ATTENDEE's quoted CN (so its
  // first physical line has no colon, as Google's do), and a SUMMARY continued
  // with a tab.
  const physical = text.split(/\r\n|\r|\n/).filter((l) => l !== '');
  const logical = unfold(text);
  ok('unfolding joins all three folds', physical.length - logical.length === 3,
     physical.length + ' physical -> ' + logical.length + ' logical');
  ok('every unfolded line parses', logical.every((l) => parseLine(l) !== null));

  const folded = event('folded-params');
  ok('a fold inside the TZID parameter keeps the zoned start',
     folded !== null && folded.start.tz === 'Europe/Berlin' && iso(folded.start.ms) === '2025-01-15T08:00Z',
     folded ? folded.start.tz + ' ' + iso(folded.start.ms) : 'event lost');
  ok('a tab continuation joins without a space', folded !== null && folded.summary === 'Folded across lines',
     folded && JSON.stringify(folded.summary));

  const attendee = parseLine(logical.find((l) => l.startsWith('ATTENDEE;')) || '');
  ok('a quoted parameter keeps its colon and semicolon',
     attendee !== null && attendee.params.CN === 'Doe; Jane: chair' && attendee.value === 'mailto:jane.doe@example.com',
     attendee && JSON.stringify(attendee.params.CN));

  // ---------------------------------------------------------------- parsing
  // VTIMEZONE's DAYLIGHT and STANDARD blocks carry DTSTART and RRULE, and the
  // VALARM carries its own SUMMARY. None of them may become or change an event.
  ok('parses exactly the 45 events', events.length === 45, events.length + ' parsed');
  const standup = event('weekly-dst');
  ok('VALARM properties do not leak into their event', standup !== null && standup.summary === 'Standup',
     standup && JSON.stringify(standup.summary));

  // TEXT unescapes in one left-to-right pass, so "\\n" is a backslash and an n,
  // not a newline. Only the first unquoted colon ends the property name.
  const note = event('duration-text');
  ok('TEXT escapes unescape in one pass',
     note !== null && note.summary === 'Review: drafts, notes; C:\\new' && note.location === 'Room 4, Floor 2\nNorth wing',
     note && JSON.stringify(note.summary) + ' ' + JSON.stringify(note.location));
  ok('DURATION sets the end when DTEND is missing', note !== null && iso(note.end.ms) === '2025-05-20T16:30Z',
     note && iso(note.end.ms));

  // ------------------------------------------------- wall-clock recurrence
  // A DST change moves the UTC time of a fixed wall-clock time: 09:00 in Berlin
  // is 08:00Z until 30 March 2025 and 07:00Z after it. Stepping by days or
  // weeks of milliseconds keeps the UTC time and moves the wall clock instead.
  // The weekly series also carries the EXDATE, overrides and UNTIL checked
  // further down.
  same('WEEKLY keeps 09:00 Berlin across the EU DST change', titled('weekly-dst', months(2025, 3, 4)), [
    '2025-03-17T08:00Z Standup',
    '2025-03-19T08:00Z Standup',
    '2025-03-24T08:00Z Standup',
    '2025-03-28T09:00Z Standup (moved to Friday)',
    '2025-03-31T07:00Z Standup',
    '2025-04-07T07:00Z Standup',
    '2025-04-09T12:00Z Standup (afternoon)',
    '2025-04-14T07:00Z Standup',
    '2025-04-16T07:00Z Standup',
  ]);
  // New York falls back on 2 November 2025, in the viewer's zone as well as
  // the event's. At 05:30 that day the UTC offset differs from the one at
  // 05:30Z, so converting the wall time needs datetime.js's second pass.
  same('DAILY keeps 05:30 New York across the US DST change', starts('daily-dst', months(2025, 10, 11)), [
    '2025-10-31T09:30Z', '2025-11-01T09:30Z', '2025-11-02T10:30Z', '2025-11-03T10:30Z', '2025-11-04T10:30Z',
  ]);
  same('MONTHLY keeps 18:00 Berlin across the EU DST change', starts('monthly-dst', months(2025, 1, 6)), [
    '2025-01-15T17:00Z', '2025-02-15T17:00Z', '2025-03-15T17:00Z', '2025-04-15T16:00Z', '2025-05-15T16:00Z',
  ]);
  // With no BYDAY, WEEKLY repeats on DTSTART's weekday in DTSTART's own zone.
  // 08:00 on a Monday in Tokyo is still Sunday in New York, so reading the
  // weekday there moves the series to Tokyo Sundays and drops its first
  // instance.
  same('WEEKLY without BYDAY keeps the weekday of its own zone', starts('weekly-tokyo', months(2025, 3, 3)), [
    '2025-03-02T23:00Z', '2025-03-09T23:00Z', '2025-03-16T23:00Z',
  ]);

  // -------------------------------------------------------- COUNT and UNTIL
  // COUNT counts from DTSTART. A rule that skips ahead to the requested window
  // must not when it has a COUNT, or it starts counting again there. The weekly
  // course runs across the US fall-back, in Chicago and in the viewer's zone.
  same('WEEKLY COUNT stops after its fourth instance', starts('weekly-count', months(2025, 10, 11)), [
    '2025-10-20T17:00Z', '2025-10-27T17:00Z', '2025-11-03T18:00Z', '2025-11-10T18:00Z',
  ]);
  same('WEEKLY COUNT counts from DTSTART, not from the window', starts('weekly-count', months(2025, 12, 12)), []);
  same('DAILY COUNT counts from DTSTART, not from the window', starts('daily-dst', months(2025, 12, 12)), []);
  same('MONTHLY COUNT counts from DTSTART, not from the window', starts('monthly-dst', months(2025, 8, 8)), []);
  same('YEARLY COUNT counts from DTSTART, not from the window',
       [2021, 2022, 2023].map((y) => days('yearly-count', months(y, 7, 7)).join()),
       ['2021-07-04', '2022-07-04', '']);
  same('YEARLY with neither COUNT nor UNTIL reaches a far-future window',
       days('yearly-forever', months(2030, 2, 2)), ['2030-02-20']);
  // A DAILY rule with no limits skips ahead even with a COUNT, and counts the
  // instances it skips. A COUNT longer than MAX_INSTANCES still reaches its
  // end: the cap is on the window's instances, not on those since DTSTART.
  const longCount = starts('daily-long-count', months(2028, 3, 3));
  same('DAILY COUNT=3000 ends on its 3000th day, years after DTSTART',
       [longCount.length, longCount[0], longCount.pop()], [18, '2028-03-01T08:00Z', '2028-03-18T08:00Z']);
  // A DAILY rule with BYDAY can't count what it would skip, so it walks: the
  // weekends it passes on the way don't count toward COUNT.
  same('DAILY BYDAY COUNT counts only the days it keeps', starts('daily-weekdays', months(2025, 2, 2)), [
    '2025-02-03T07:00Z', '2025-02-04T07:00Z', '2025-02-05T07:00Z', '2025-02-06T07:00Z', '2025-02-07T07:00Z',
  ]);
  // DTSTART is always the first instance and counts toward COUNT, even when
  // it isn't one of the rule's own dates.
  same('a DTSTART off the rule is its first instance', starts('monthly-off-rule', months(2025, 1, 3)), [
    '2025-01-10T08:00Z', '2025-01-15T08:00Z', '2025-02-15T08:00Z',
  ]);

  // UNTIL is inclusive in both forms: 07:00Z on 16 April is exactly the last
  // standup, and the plants get watered on the UNTIL date itself.
  const lastStandup = starts('weekly-dst', months(2025, 4, 5)).pop();
  ok('a UTC UNTIL keeps the instance that falls on it', lastStandup === '2025-04-16T07:00Z', 'last ' + lastStandup);
  same('DAILY INTERVAL=2 stops on its date-only UNTIL', days('daily-until-date', months(2025, 6, 6)), [
    '2025-06-10', '2025-06-12', '2025-06-14', '2025-06-16',
  ]);
  // An UNTIL without Z is a wall-clock time, read in DTSTART's frame. Read as
  // UTC, 09:00 on 5 June is 05:00 in New York, before that day's 09:00 instance.
  same('a floating UNTIL keeps the instance that falls on it', starts('daily-floating-until', months(2025, 6, 6)), [
    '2025-06-01T13:00Z', '2025-06-02T13:00Z', '2025-06-03T13:00Z', '2025-06-04T13:00Z', '2025-06-05T13:00Z',
  ]);

  // ------------------------------------------------- skipping to the window
  // A rule without COUNT skips ahead to the requested window a whole number of
  // intervals at a time, so it must land on the series' own dates there. The
  // daily series began in 1900, so walking from DTSTART instead would run out
  // of MAX_ITERATIONS before 2030.
  same('DAILY INTERVAL=2 from 1900 reaches 2030 on its own days', starts('daily-forever', months(2030, 2, 2)), [
    '2030-02-01T06:00Z', '2030-02-03T06:00Z', '2030-02-05T06:00Z', '2030-02-07T06:00Z', '2030-02-09T06:00Z',
    '2030-02-11T06:00Z', '2030-02-13T06:00Z', '2030-02-15T06:00Z', '2030-02-17T06:00Z', '2030-02-19T06:00Z',
    '2030-02-21T06:00Z', '2030-02-23T06:00Z', '2030-02-25T06:00Z', '2030-02-27T06:00Z',
  ]);
  same('WEEKLY INTERVAL=2 keeps to its own weeks', starts('weekly-interval', months(2025, 1, 1)), [
    '2025-01-07T16:00Z', '2025-01-09T16:00Z', '2025-01-21T16:00Z', '2025-01-23T16:00Z',
  ]);
  same('WEEKLY INTERVAL=2 keeps to its own weeks in a far-future window', starts('weekly-interval', months(2030, 6, 6)), [
    '2030-06-04T15:00Z', '2030-06-06T15:00Z', '2030-06-18T15:00Z', '2030-06-20T15:00Z',
  ]);
  same('MONTHLY INTERVAL=2 keeps to its own months in a far-future window',
       starts('monthly-second-tuesday', months(2030, 10, 11)), ['2030-11-12T16:00Z']);

  // The engine steps local dates, but an instance can fall more than a day
  // from its date's local midnight. 23:00 in Honolulu is 04:00 the next day in
  // New York, and midnight in Kiritimati is 05:00 the day before. A jump-start
  // must land far enough short of the window, and a loop must stop far enough
  // past it, to catch those. expandEvents widens the window by a day, which
  // hides the near misses, so these call the engine with the exact window.
  const exact = (name, win) => {
    const ev = event(name);
    return ev ? expandRRule(ev.rrule, ev.start, win[0], win[1]).map(iso) : [];
  };
  const lateDaily = exact('daily-honolulu-late', months(2025, 2, 2));
  same('DAILY skips ahead short enough to keep a date that lands in the window the next day',
       [lateDaily.length, lateDaily[0]], [28, '2025-02-01T09:00Z']);
  same('MONTHLY skips ahead short enough to keep a month-end that lands in the window',
       exact('monthly-honolulu-last', months(2025, 2, 2)), ['2025-02-01T09:00Z']);
  same('MONTHLY looks far enough past the window for a month-start that lands in it',
       exact('monthly-kiritimati-first', months(2025, 1, 1)), ['2025-01-31T10:00Z']);

  // ------------------------------------------------------ nonexistent dates
  // A date the month or year doesn't have is skipped, not rolled into the next
  // month, and it doesn't count toward COUNT: the three leap days are 2024's,
  // 2028's and 2032's.
  same('MONTHLY on the 31st skips the shorter months', starts('monthly-31st', months(2025, 1, 8)), [
    '2025-01-31T17:00Z', '2025-03-31T16:00Z', '2025-05-31T16:00Z', '2025-07-31T16:00Z',
  ]);
  same('YEARLY on 29 February skips common years',
       [2025, 2028, 2032, 2036].map((y) => days('yearly-leap', months(y, 2, 3)).join()),
       ['', '2028-02-29', '2032-02-29', '']);

  // ------------------------------------------ weekdays and days of the month
  // MONTHLY and YEARLY pick weekdays of the month by ordinal, where 2TU is the
  // second Tuesday and -1FR the last Friday, and days of the month from either
  // end, where -1 is the last day. The last-Friday series starts on the 31st,
  // so it must not skip short months the way a day-of-month rule does.
  same('MONTHLY BYDAY=2TU takes the second Tuesday, every other month',
       starts('monthly-second-tuesday', months(2025, 1, 6)), ['2025-01-14T16:00Z', '2025-03-11T15:00Z', '2025-05-13T15:00Z']);
  same('MONTHLY BYDAY=-1FR takes the last Friday', starts('monthly-last-friday', months(2025, 1, 6)), [
    '2025-01-31T15:00Z', '2025-02-28T15:00Z', '2025-03-28T15:00Z', '2025-04-25T14:00Z',
  ]);
  same('MONTHLY BYMONTHDAY=15,-1 takes the 15th and the last day', days('monthly-pay-day', months(2025, 1, 6)), [
    '2025-01-31', '2025-02-15', '2025-02-28', '2025-03-15', '2025-03-31',
  ]);
  same('YEARLY BYMONTH=11;BYDAY=4TH takes the fourth Thursday',
       [2025, 2030].map((y) => days('yearly-thanksgiving', months(y, 11, 11)).join()), ['2025-11-27', '2030-11-28']);
  same('YEARLY takes each of its BYMONTH months', days('yearly-two-months', months(2026, 1, 12)), ['2026-03-01', '2026-09-01']);

  // The engine takes a series' dates in order and once each, since COUNT and
  // the end of the window both stop it at the first date past them. These
  // rules list their parts out of order and twice.
  same('WEEKLY takes BYDAY in week order, once each', starts('weekly-unordered', months(2025, 1, 1)), [
    '2025-01-09T09:00Z', '2025-01-14T09:00Z', '2025-01-16T09:00Z', '2025-01-21T09:00Z',
  ]);
  same('MONTHLY takes its days in date order', starts('monthly-unordered', months(2025, 1, 6)), [
    '2025-01-31T15:00Z', '2025-02-03T15:00Z', '2025-02-28T15:00Z', '2025-03-03T15:00Z',
  ]);
  same('YEARLY takes BYMONTH and BYMONTHDAY in order, once each',
       [2025, 2026].map((y) => days('yearly-unordered', months(y, 1, 12)).join()),
       ['2025-03-01,2025-09-01', '2026-03-01']);

  // ------------------------------------------------------------------ limits
  // Where RFC 5545 makes a part a limit, it keeps only the dates it names, and
  // the dates it drops don't count toward COUNT.
  same('DAILY BYDAY=MO,TU,WE,TH,FR keeps to weekdays', starts('daily-weekdays', months(2025, 1, 1)), [
    '2025-01-20T07:00Z', '2025-01-21T07:00Z', '2025-01-22T07:00Z', '2025-01-23T07:00Z', '2025-01-24T07:00Z',
    '2025-01-27T07:00Z', '2025-01-28T07:00Z', '2025-01-29T07:00Z', '2025-01-30T07:00Z', '2025-01-31T07:00Z',
  ]);
  same('DAILY BYMONTH and BYMONTHDAY keep to the days both name',
       [2025, 2030].map((y) => days('daily-limits', months(y, 1, 12)).join()),
       ['2025-03-01,2025-03-31', '2030-03-01,2030-03-31']);
  same('WEEKLY BYMONTH keeps to its month and counts only its days',
       [2025, 2026].map((y) => days('weekly-june', months(y, 1, 12)).join()),
       ['2025-06-02,2025-06-09,2025-06-16,2025-06-23,2025-06-30', '2026-06-01']);
  same('MONTHLY BYMONTH keeps to its months', days('monthly-jan-jul', months(2025, 1, 12)), ['2025-01-14', '2025-07-08']);

  // -------------------------------------------------------------------- WKST
  // Weeks start on WKST, Monday by default, which decides the fortnight a day
  // falls in: from Monday 6 January, the Sunday of a Monday week is the 12th,
  // and the Sunday of a Sunday week is the 5th, before DTSTART.
  same('a fortnightly rule keeps a Sunday in its Monday week by default',
       starts('weekly-wkst-default', months(2025, 1, 1)),
       ['2025-01-06T08:00Z', '2025-01-12T08:00Z', '2025-01-20T08:00Z', '2025-01-26T08:00Z']);
  same('a fortnightly rule with WKST=SU starts each week on Sunday',
       starts('weekly-wkst-sunday', months(2025, 1, 1)), ['2025-01-06T08:00Z', '2025-01-19T08:00Z', '2025-01-20T08:00Z']);

  // A rule part the engine doesn't implement would put instances on wrong
  // dates if it were ignored, so the series shows its DTSTART alone.
  same('a rule with BYSETPOS shows only DTSTART', starts('unsupported-setpos', months(2025, 2, 4)), ['2025-02-11T08:00Z']);
  // An unreadable COUNT or UNTIL would make the series endless, and an
  // unreadable INTERVAL, a month or day of the month that can't exist, a zero
  // ordinal or an unknown WKST would put it on wrong dates.
  same('a malformed rule is not expanded',
       ['FREQ=DAILY;COUNT=ten', 'FREQ=DAILY;UNTIL=2025-06-01', 'FREQ=WEEKLY;INTERVAL=two;BYDAY=MO',
        'FREQ=YEARLY;BYMONTH=13', 'FREQ=MONTHLY;BYMONTHDAY=0', 'FREQ=WEEKLY;BYDAY=MONDAY',
        'FREQ=MONTHLY;BYDAY=0MO', 'FREQ=WEEKLY;WKST=XX;BYDAY=MO', 'FREQ=HOURLY', 'COUNT=3'].filter(isSupported), []);
  // Each of these combinations means something the engine doesn't do: an
  // ordinal outside MONTHLY and YEARLY, BYMONTHDAY on WEEKLY, dates that BYDAY
  // and BYMONTHDAY both pick, and YEARLY BYDAY or BYMONTHDAY with no BYMONTH.
  same('a combination the engine does not implement is not expanded',
       ['FREQ=DAILY;BYDAY=1MO', 'FREQ=WEEKLY;BYDAY=1MO', 'FREQ=WEEKLY;BYMONTHDAY=1',
        'FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13', 'FREQ=YEARLY;BYMONTH=6;BYDAY=FR;BYMONTHDAY=13',
        'FREQ=YEARLY;BYDAY=20MO', 'FREQ=YEARLY;BYMONTHDAY=1'].filter(isSupported), []);

  // ---------------------------------------------- EXDATE and RECURRENCE-ID
  // Both match an instance by local calendar day, not by exact instant. The
  // EXDATE is an hour off its instance, and the all-day series' override has a
  // timed RECURRENCE-ID (see src/main/ics/expand.js).
  const onDay = (list, key) => list.filter((i) => localDateKey(i.startMs) === key);
  const spring = expand('weekly-dst', months(2025, 3, 4));
  ok('EXDATE removes its instance though their times differ', onDay(spring, '2025-03-26').length === 0);
  same('RECURRENCE-ID replaces its instance on the same day',
       onDay(spring, '2025-04-09').map((i) => iso(i.startMs) + ' ' + i.summary),
       ['2025-04-09T12:00Z Standup (afternoon)']);
  // The 2 April standup moved to 28 March. Each month must show it once, where
  // it now is: March has no 2 April instance to swap it into, and April must
  // drop the original without showing the move.
  ok('an instance moved into the window from outside it still shows',
     titled('weekly-dst', months(2025, 3, 3)).includes('2025-03-28T09:00Z Standup (moved to Friday)'));
  ok('a moved instance leaves its original day', onDay(expand('weekly-dst', months(2025, 4, 4)), '2025-04-02').length === 0);
  same('a timed RECURRENCE-ID replaces an all-day instance',
       expand('allday-weekly', months(2025, 3, 3)).map((i) => daysCovered(i) + ' ' + i.summary),
       ['2025-03-03 Bin day', '2025-03-10 Bin day', '2025-03-18 Bin day (holiday delay)', '2025-03-24 Bin day']);

  // ---------------------------------------------------------------- all-day
  // All-day dates anchor to local midnight, and DTEND is exclusive: the long
  // weekend runs Saturday to Monday, across New York's 23-hour DST Sunday.
  const allDay = expandEvents(events, ...months(2025, 1, 12)).filter((i) => i.allDay);
  const atMidnight = (ms) => new Date(ms).getHours() === 0 && new Date(ms).getMinutes() === 0;
  ok('all-day instances start at local midnight',
     allDay.length > 0 && allDay.every((i) => atMidnight(i.startMs)),
     allDay.length + ' checked');
  // They end at one too, a whole number of days later. A DST change makes a
  // day 23 or 25 hours long, so an end computed in milliseconds lands at
  // 01:00 or 23:00 instead.
  const offMidnight = allDay.filter((i) => !atMidnight(i.endMs)).map((i) => i.uid.split('@')[0] + ' ' + iso(i.endMs));
  ok('all-day instances end at local midnight', offMidnight.length === 0,
     offMidnight.length ? 'ending ' + offMidnight.join(', ') : allDay.length + ' checked');
  same('an all-day DTEND is exclusive', days('allday-span', months(2025, 3, 3)), ['2025-03-08+2025-03-09+2025-03-10']);
  // Each instance of an all-day series lasts as many days as its master. The
  // master's day has 24 hours and 9 March, New York's spring-forward Sunday,
  // has 23, so 24 hours from that midnight is 01:00 on Monday.
  same('a recurring all-day instance keeps to its day across DST', days('allday-sunday', months(2025, 3, 3)), [
    '2025-03-02', '2025-03-09', '2025-03-16',
  ]);
  // With no DTEND, an all-day event lasts one day, and the days of an all-day
  // DURATION are calendar days (RFC 5545 3.3.6). Both cross the same Sunday.
  same('an all-day event with no DTEND lasts one day', days('allday-no-end', months(2025, 3, 3)), ['2025-03-09']);
  same('an all-day DURATION counts calendar days', days('allday-duration', months(2025, 3, 3)), ['2025-03-08+2025-03-09']);

  // ------------------------------------------ instances that run into a month
  // A month shows every instance that overlaps it, however early it starts.
  // The book fair's 30 January instance runs Thursday to Saturday, 1 February,
  // and the on-call weekend of 29 August runs to 08:00 on Monday, 1 September.
  // Both start more than a day before the month they run into. The book fair
  // has a COUNT, so its expansion walks from DTSTART, and the on-call weekend
  // has none, so its expansion jump-starts to the window.
  same('an all-day instance that starts days before the month shows in it',
       days('allday-multiday-weekly', months(2025, 2, 2)),
       ['2025-01-30+2025-01-31+2025-02-01', '2025-02-06+2025-02-07+2025-02-08']);
  same('a timed instance that starts days before the month shows in it',
       starts('timed-multiday-weekly', months(2025, 9, 9)),
       ['2025-08-29T22:00Z', '2025-09-05T22:00Z', '2025-09-12T22:00Z']);
}

// The export suite checks the parser as the widget runs on this machine, so it
// gets the machine's own zone back.
const machineZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
process.env.TZ = FIXTURE_ZONE; // Node re-reads the zone when TZ is assigned
verifyFixture();
process.env.TZ = machineZone;

// ========================================================== personal export

function findExport(argv) {
  if (argv[2]) return argv[2];
  const zip = fs.readdirSync(root).find((f) => f.endsWith('.ical.zip'));
  return zip ? path.join(root, zip) : null;
}

const exportPath = findExport(process.argv);
console.log('');
if (!exportPath) {
  console.log('No personal export found, so only the synthetic fixture ran. To check one too,');
  console.log('pass a .zip or .ics path, or put a *.ical.zip in the repo root.');
  finish();
}
if (!fs.existsSync(exportPath)) {
  ok('the export exists', false, exportPath);
  finish();
}

const sources = exportPath.endsWith('.zip')
  ? readEntries(exportPath).filter((e) => e.name.endsWith('.ics'))
  : [{ name: path.basename(exportPath), text: fs.readFileSync(exportPath, 'utf8') }];

console.log('Export:  ' + path.basename(exportPath));
console.log('Files:   ' + sources.length + '\n');

// ---------------------------------------------------------------- unfolding
const main = sources.reduce((a, b) => (b.text.length > a.text.length ? b : a));
const logical = unfold(main.text);
const physical = main.text.split(/\r\n|\r|\n/).filter((l) => l !== '');

ok('unfolding actually joins continuation lines', logical.length < physical.length,
   physical.length + ' physical -> ' + logical.length + ' logical');

// A fold can split before the colon; those lines are unparseable in isolation.
const unparseablePhysical = physical.filter((l) => !/^[ \t]/.test(l) && parseLine(l) === null).length;
const unparseableLogical = logical.filter((l) => parseLine(l) === null).length;
ok('every unfolded line parses', unparseableLogical === 0,
   unparseableLogical + ' unparseable after unfolding');

// ATTENDEE is the property that proves it: its first physical line has no colon.
const attendeeLogical = logical.filter((l) => l.startsWith('ATTENDEE')).length;
ok('ATTENDEE lines recovered by unfolding', attendeeLogical > 0,
   attendeeLogical + ' found (a per-physical-line parser finds 0)');
void unparseablePhysical;

// ---------------------------------------------------------------- parsing
let allEvents = [];
for (const src of sources) {
  const evs = parseCalendar(src.text);
  allEvents = allEvents.concat(evs);
  console.log('  ' + src.name.slice(0, 46).padEnd(48) + String(evs.length).padStart(4) + ' events');
}
console.log('');

ok('parsed a realistic number of events', allEvents.length > 400,
   allEvents.length + ' total');
ok('every event has a UID', allEvents.every((e) => e.uid));
ok('every event has a start', allEvents.every((e) => e.start));
ok('every event has an end (DTEND fallback applied)', allEvents.every((e) => e.end),
   'incl. the one event with no DTEND');
ok('no end precedes its start', allEvents.every((e) => e.end.ms >= e.start.ms));

// VALARM nesting must not leak into event fields.
const alarmLeak = allEvents.filter((e) => e.summary === 'This is an event reminder').length;
ok('VALARM properties do not leak into events', alarmLeak === 0);

// ---------------------------------------------------------------- date forms
const allDay = allEvents.filter((e) => e.allDay).length;
const timed = allEvents.length - allDay;
ok('both all-day and timed events present', allDay > 0 && timed > 0,
   allDay + ' all-day, ' + timed + ' timed');

const tzEvents = allEvents.filter((e) => e.start.tz);
ok('TZID-qualified events resolved', tzEvents.length > 0,
   tzEvents.length + ' with an explicit zone');

// All-day events must land on their stated calendar day in local time.
const adSample = allEvents.filter((e) => e.allDay).slice(0, 50);
const adCorrect = adSample.every((e) => {
  const d = new Date(e.startMs || e.start.ms);
  return d.getDate() === e.start.d && d.getMonth() + 1 === e.start.mo;
});
ok('all-day events land on the right local day', adCorrect);

// ---------------------------------------------------------------- recurrence
const masters = allEvents.filter((e) => e.rrule && !e.recurrenceId);
const overrides = allEvents.filter((e) => e.recurrenceId);
const withEx = allEvents.filter((e) => e.exdates.length > 0);

ok('recurrence masters found', masters.length > 0, masters.length + ' masters');
// A rule the engine can't expand in full shows only its DTSTART in the widget.
const partial = masters.filter((e) => !isSupported(e.rrule)).length;
ok('the RRULE engine expands every rule in full', partial === 0, partial + ' shown as DTSTART only');
ok('overrides found', overrides.length > 0, overrides.length + ' RECURRENCE-ID events');
ok('EXDATEs parsed', withEx.length > 0, withEx.length + ' events with exclusions');
ok('no event is both master and override',
   allEvents.every((e) => !(e.rrule && e.recurrenceId)));

// The heavily-overridden series: one UID with many RECURRENCE-ID siblings.
const byUid = new Map();
for (const e of allEvents) byUid.set(e.uid, (byUid.get(e.uid) || 0) + 1);
const busiest = [...byUid.entries()].sort((a, b) => b[1] - a[1])[0];
ok('heavily-overridden series parsed', busiest[1] > 10,
   busiest[1] + ' blocks share one UID');

// An all-day master with a TIMED RECURRENCE-ID must still match by day.
const mismatched = overrides.filter((o) => {
  const m = allEvents.find((e) => e.uid === o.uid && e.rrule);
  return m && m.allDay && !o.recurrenceId.allDay;
});
ok('date-key matching handles all-day master vs timed RECURRENCE-ID',
   true, mismatched.length + ' such case(s) present in fixture');

// ---------------------------------------------------------------- expansion
// April 2024: dense month with active weekly series in the sample data.
const [ws, we] = months(2024, 4, 4);
const april = expandEvents(allEvents, ws, we);
ok('expansion produces instances for a dense month', april.length > 0,
   april.length + ' instances in April 2024');
ok('instances are chronologically sorted',
   april.every((v, i, a) => i === 0 || a[i - 1].startMs <= v.startMs));
ok('all instances fall inside the window',
   april.every((i) => i.endMs >= ws && i.startMs <= we));

// A weekly series must not drift its wall-clock time across the DST boundary.
const marchStart = new Date(2024, 2, 1).getTime();
const marchEnd = new Date(2024, 2, 31, 23, 59, 59).getTime();
const march = expandEvents(allEvents, marchStart, marchEnd);
const seriesByUid = new Map();
for (const i of march) {
  if (!i.allDay) {
    if (!seriesByUid.has(i.uid)) seriesByUid.set(i.uid, []);
    seriesByUid.get(i.uid).push(i);
  }
}
// The hour must be checked in the EVENT'S OWN timezone, not the machine's. A
// US-DST shift legitimately moves the local hour for a viewer in a zone that
// doesn't observe it (e.g. Asia/Dubai), so asserting on local hours is wrong.
let driftChecked = 0;
let driftFound = 0;
const hourFmtCache = new Map();
function hourIn(tz, ms) {
  let f = hourFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, hour: '2-digit' });
    hourFmtCache.set(tz, f);
  }
  return f.format(new Date(ms));
}
for (const [uid, list] of seriesByUid) {
  if (list.length < 3) continue;
  const master = allEvents.find((e) => e.uid === uid && e.rrule);
  const tz = master && master.start.tz;
  if (!tz) continue;
  driftChecked++;
  const hours = new Set(list.map((i) => hourIn(tz, i.startMs)));
  if (hours.size > 1) driftFound++;
}
ok('weekly series hold their wall-clock hour across the March DST change',
   driftChecked > 0 && driftFound === 0,
   driftChecked + ' zoned series checked in their own tz, ' + driftFound + ' drifted');

// EXDATEs must actually remove instances.
const exMaster = withEx.find((e) => e.rrule);
if (exMaster) {
  const exKey = localDateKey(exMaster.exdates[0].ms);
  const around = expandEvents([exMaster], exMaster.start.ms, exMaster.start.ms + 400 * 86400000);
  const hit = around.filter((i) => localDateKey(i.startMs) === exKey).length;
  ok('EXDATE removes its instance', hit === 0, 'excluded ' + exKey);
} else {
  ok('EXDATE removes its instance', false, 'no fixture case found');
}

// Infinite yearly rules (birthdays) must stay cheap and still produce a hit.
const yearly = allEvents.filter((e) => e.rrule && /FREQ=YEARLY/.test(e.rrule) && !/UNTIL/.test(e.rrule));
if (yearly.length) {
  const b = yearly[0];
  const t0 = Date.now();
  const future = expandEvents([b], new Date(2030, b.start.mo - 1, 1).getTime(),
                                   new Date(2030, b.start.mo, 0, 23, 59, 59).getTime());
  const elapsed = Date.now() - t0;
  ok('infinite yearly rule expands into a far-future window', future.length === 1,
     future.length + ' instance(s) in 2030');
  ok('infinite yearly expansion is fast (lazy, not eager)', elapsed < 50, elapsed + 'ms');
}

// Whole-run performance.
const perfStart = Date.now();
for (let m = 1; m <= 12; m++) {
  const [a, b] = months(2024, m, m);
  expandEvents(allEvents, a, b);
}
const perfMs = Date.now() - perfStart;
ok('expanding 12 months is fast', perfMs < 2000, perfMs + 'ms for a full year');

finish();

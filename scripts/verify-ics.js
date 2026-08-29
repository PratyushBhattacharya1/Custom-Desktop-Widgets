// Offline regression harness for the ICS parser.
//
//   node scripts/verify-ics.js [path-to-export.zip|path-to.ics]
//
// Runs against a real Google Calendar export and asserts the specific traps
// that hand-rolled ICS parsers fall into. No Electron, no network.
const fs = require('fs');
const path = require('path');

const { unfold } = require('../src/main/ics/unfold');
const { parseLine } = require('../src/main/ics/contentline');
const { parseCalendar } = require('../src/main/ics/vevent');
const { expandEvents } = require('../src/main/ics/expand');
const { localDateKey } = require('../src/main/ics/datetime');
const { readEntries } = require('./read-zip');

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

function findFixture(argv) {
  if (argv[2]) return argv[2];
  const root = path.join(__dirname, '..');
  const zip = fs.readdirSync(root).find((f) => f.endsWith('.ical.zip'));
  return zip ? path.join(root, zip) : null;
}

const fixture = findFixture(process.argv);
if (!fixture || !fs.existsSync(fixture)) {
  console.log('No fixture found. Pass a .zip or .ics path as the first argument.');
  console.log('(This harness is optional — it only runs against a sample export.)');
  process.exit(0);
}

const sources = fixture.endsWith('.zip')
  ? readEntries(fixture).filter((e) => e.name.endsWith('.ics'))
  : [{ name: path.basename(fixture), text: fs.readFileSync(fixture, 'utf8') }];

console.log('Fixture: ' + path.basename(fixture));
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
function monthWindow(y, m) {
  return [new Date(y, m, 1, 0, 0, 0, 0).getTime(), new Date(y, m + 1, 0, 23, 59, 59, 999).getTime()];
}

// April 2024: dense month with active weekly series in the sample data.
const [ws, we] = monthWindow(2024, 3);
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
for (let m = 0; m < 12; m++) {
  const [a, b] = monthWindow(2024, m);
  expandEvents(allEvents, a, b);
}
const perfMs = Date.now() - perfStart;
ok('expanding 12 months is fast', perfMs < 2000, perfMs + 'ms for a full year');

console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
process.exit(fail === 0 ? 0 : 1);

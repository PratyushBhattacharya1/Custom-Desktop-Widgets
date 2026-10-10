// Mutation check for the ICS fixture suite.
//
//   node scripts/mutate-ics.js
//
// Evidence that verify-ics.js's fixture suite catches what it claims to. It
// copies the parser, the fixture and verify-ics.js into a temporary folder,
// breaks one invariant there at a time, and runs the suite on each copy. No
// Electron, no network, and nothing in the repo is modified.
//
// Every mutation must fail the suite through a named assertion. A pass means
// the fixture has a gap. A crash means the mutation itself is broken (a typo
// in its replacement text crashes the suite too), so it proves nothing.
//
// A mutation finds its target by exact text, so refactoring the parser can
// leave one stale. A stale mutation fails the run and is named, never skipped:
// update its text to match the new code. That brittleness is why CI doesn't
// run this. Run it after changing src/main/ics/, the fixture or verify-ics.js,
// and add a mutation for each invariant you add.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const COPY = ['src/main/ics', 'scripts/verify-ics.js', 'scripts/read-zip.js', 'test/fixtures'];

// [name, file, exact text to find, replacement]. Grouped by the AGENTS.md
// invariant (or parser rule) each one breaks.
const MUTATIONS = [
  // Unfold the whole file before parsing any line.
  ['unfold: continuation lines not joined', 'src/main/ics/unfold.js',
    "if ((line[0] === ' ' || line[0] === '\\t') && logical.length > 0) {", 'if (false) {'],
  ['unfold: split on LF only, leaving CR', 'src/main/ics/unfold.js',
    'text.split(/\\r\\n|\\r|\\n/)', "text.split('\\n')"],
  ['unfold: tab not a continuation', 'src/main/ics/unfold.js',
    "(line[0] === ' ' || line[0] === '\\t')", "(line[0] === ' ')"],
  ['unfold: leading space kept', 'src/main/ics/unfold.js',
    'logical[logical.length - 1] += line.slice(1);', 'logical[logical.length - 1] += line;'],

  // Content lines and TEXT values.
  ['contentline: colon inside quotes ends the name', 'src/main/ics/contentline.js',
    "if (c === '\"') inQuotes = !inQuotes;", 'if (false) inQuotes = !inQuotes;'],
  ['text: chained replaces instead of one pass', 'src/main/ics/text.js',
    'if (value.indexOf(BACKSLASH) === -1) return value;',
    "return value.replace(/\\\\\\\\/g, BACKSLASH).replace(/\\\\n/gi, '\\n').replace(/\\\\,/g, ',').replace(/\\\\;/g, ';');"],

  // Expand recurrences in the event's own wall-clock timezone; never step by
  // adding milliseconds.
  ['tz: instances stepped by ms from DTSTART', 'src/main/ics/rrule.js',
    'return zonedWallToUtc(y, mo, d, start.h, start.mi, start.s, start.tz);',
    'return start.ms + (Date.UTC(y, mo - 1, d) - Date.UTC(start.y, start.mo - 1, start.d));'],
  ['tz: wall clock read in the machine zone', 'src/main/ics/rrule.js',
    'if (start.tz) {', 'if (false) {'],
  ['tz: TZID ignored, times floating', 'src/main/ics/datetime.js',
    '} else if (isValidTimeZone(params.TZID)) {', '} else if (false) {'],
  ['tz: single-pass wall-time conversion', 'src/main/ics/datetime.js',
    'offset = tzOffsetMs(guess - offset, timeZone);', ''],
  ['WEEKLY: weeks stepped by ms', 'src/main/ics/rrule.js',
    'weekStart.setDate(weekStart.getDate() + weekIndex * 7);', 'weekStart.setTime(anchor.getTime() + weekIndex * WEEK_MS);'],
  ['DAILY: days stepped by ms', 'src/main/ics/rrule.js',
    'cursor.setDate(cursor.getDate() + rule.interval);', 'cursor.setTime(cursor.getTime() + rule.interval * DAY_MS);'],

  // Anchor all-day dates to local midnight. An all-day DTEND is exclusive.
  ['all-day: anchored to UTC midnight', 'src/main/ics/datetime.js',
    'ms: new Date(y, mo - 1, d, 0, 0, 0, 0).getTime(),', 'ms: Date.UTC(y, mo - 1, d),'],
  ['all-day: DTEND inclusive', 'src/main/ics/vevent.js',
    "case 'DTEND':\n        ev.end = parseIcsDate(p.value, p.params);",
    "case 'DTEND':\n        ev.end = parseIcsDate(p.value, p.params);\n" +
    '        if (ev.end && ev.end.allDay) ev.end = { ...ev.end, ms: ev.end.ms + DAY_MS };'],

  // Match EXDATE and RECURRENCE-ID by local calendar day, not by exact instant.
  ['EXDATE: matched by exact instant', 'src/main/ics/expand.js',
    'if (exdateKeys.has(key)) continue;', 'if (master.exdates.some((x) => x.ms === ms)) continue;'],
  ['RECURRENCE-ID: matched by exact instant', 'src/main/ics/expand.js',
    'const override = overrideIndex.get(overrideKey);',
    'const override = [overrideIndex.get(overrideKey)].find((ov) => ov && ov.recurrenceId.ms === ms);'],
  ['RECURRENCE-ID: overrides moved in from outside the window dropped', 'src/main/ics/expand.js',
    'if (consumed.has(key)) continue;', 'continue;'],
  ['expand: instances left unsorted', 'src/main/ics/expand.js',
    'out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);', ''],

  // COUNT counts from DTSTART, so a COUNT rule can't skip ahead to the window.
  ['COUNT: WEEKLY skips ahead anyway', 'src/main/ics/rrule.js',
    'if (rule.count === null && windowStart > start.ms) {', 'if (windowStart > start.ms) {'],
  ['COUNT: YEARLY skips ahead anyway', 'src/main/ics/rrule.js',
    'if (rule.count === null) {\n      const windowYear', 'if (true) {\n      const windowYear'],

  // UNTIL is inclusive, in its datetime and its date form.
  ['UNTIL: datetime form exclusive', 'src/main/ics/rrule.js', 'return ms > rule.until.ms;', 'return ms >= rule.until.ms;'],
  ['UNTIL: date form exclusive', 'src/main/ics/rrule.js', 'return d > u.d;', 'return d >= u.d;'],
  ['UNTIL: date form ignored', 'src/main/ics/rrule.js', 'if (/^\\d{8}$/.test(value)) {', 'if (false) {'],

  // The RRULE engine: WEEKLY and YEARLY, plus basic DAILY and MONTHLY.
  ['engine: no DAILY', 'src/main/ics/rrule.js', "if (rule.freq === 'DAILY') {", "if (rule.freq === 'NONE') {"],
  ['engine: no MONTHLY', 'src/main/ics/rrule.js', "if (rule.freq === 'MONTHLY') {", "if (rule.freq === 'NONE') {"],
  ['engine: no YEARLY', 'src/main/ics/rrule.js', "if (rule.freq === 'YEARLY') {", "if (rule.freq === 'NONE') {"],
  ['engine: INTERVAL ignored', 'src/main/ics/rrule.js', 'rule.interval = Math.max(1, parseInt(value, 10) || 1);', ''],

  // Block nesting and DTEND fallbacks.
  ['VALARM: properties collected at any depth', 'src/main/ics/vevent.js',
    "if (current && stack.length === 2 && stack[1] === 'VEVENT') {", 'if (current) {'],
  ['DURATION ignored', 'src/main/ics/vevent.js', 'durationMs = parseDuration(p.value);', ''],

  // The suite's own zone pin: without it, results depend on the machine.
  ['harness: fixture zone not pinned', 'scripts/verify-ics.js', 'process.env.TZ = FIXTURE_ZONE;', ''],
];

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ics-mutants-'));

// The copy has no *.ical.zip in its root, so only the fixture suite runs. It
// runs in UTC, as in CI: in a zone that already matches New York, deleting the
// suite's zone pin would change nothing, and that mutation would go uncaught.
function runSuite() {
  const r = spawnSync(process.execPath, [path.join(work, 'scripts', 'verify-ics.js')], {
    cwd: work,
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC' },
    timeout: 30000, // a mutant that loops forever is named, not waited on
  });
  const out = r.stdout || '';
  const failed = out.split(/\r?\n/).filter((l) => l.startsWith('FAIL  ')).map((l) => l.slice(6).split('  (')[0]);
  // A run that never printed its tally crashed or timed out, even if some
  // assertions failed first, and a crash proves nothing.
  const finished = /^===== \d+ passed, \d+ failed =====\r?$/m.test(out);
  const crash = r.error ? r.error.message
    : finished ? null
    : ((r.stderr || '').split(/\r?\n/).find((l) => /Error/.test(l)) || 'exit ' + r.status);
  return { status: r.status, failed, crash };
}

let caught = 0;
try {
  for (const rel of COPY) fs.cpSync(path.join(root, rel), path.join(work, rel), { recursive: true });

  const base = runSuite();
  if (base.status !== 0) {
    console.log('The unmutated suite fails, so no mutation result would mean anything. Fix that first:');
    console.log('  ' + (base.crash || base.failed.join('; ')));
    process.exitCode = 1;
    return;
  }

  for (const [name, rel, find, replace] of MUTATIONS) {
    const file = path.join(work, rel);
    // With core.autocrlf, a Windows checkout has CRLF and CI has LF. Match
    // multi-line text either way, write the mutant with the file's own line
    // endings (the fixture's CRLF is under test), and restore the exact file.
    const raw = fs.readFileSync(file, 'utf8');
    const original = raw.replace(/\r\n/g, '\n');
    if (!original.includes(find)) {
      console.log('STALE   ' + name + '  (text not found in ' + rel + ')');
      continue;
    }
    // A function replacement, so `$&` or `$'` in a mutation stays literal.
    const mutant = original.replace(find, () => replace);
    fs.writeFileSync(file, raw.includes('\r\n') ? mutant.replace(/\n/g, '\r\n') : mutant);
    const { failed, crash } = runSuite();
    fs.writeFileSync(file, raw);

    if (crash) {
      console.log('CRASH   ' + name + '  (' + crash + ')');
    } else if (failed.length) {
      caught++;
      console.log('CAUGHT  ' + name + '  (' + failed.length + ' failed, first: ' + failed[0] + ')');
    } else {
      console.log('MISSED  ' + name);
    }
  }

  console.log('\n===== ' + caught + ' of ' + MUTATIONS.length + ' mutations caught =====');
  process.exitCode = caught === MUTATIONS.length ? 0 : 1;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}

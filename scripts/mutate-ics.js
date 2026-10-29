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
// A mutation finds its target by exact text, which must appear exactly once in
// its file, so it can't land on a lookalike line elsewhere. Refactoring the
// parser can leave one stale or repeated. Either fails the run and is named,
// never skipped: update its text to match the new code, with enough context to
// be unique. That brittleness is why CI doesn't run this. Run it after changing
// src/main/ics/, the fixture or verify-ics.js, and add a mutation for each
// invariant you add.
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
  // ...and take DTSTART's weekday from that zone too.
  ['WEEKLY: weekday read in the machine zone', 'src/main/ics/rrule.js',
    ': [weekday(start.y, start.mo, start.d)];', ': [new Date(start.ms).getDay()];'],

  // Anchor all-day dates to local midnight. An all-day DTEND is exclusive.
  // Count all-day lengths in calendar days, never in milliseconds.
  ['all-day: anchored to UTC midnight', 'src/main/ics/datetime.js',
    'ms: new Date(y, mo - 1, d, 0, 0, 0, 0).getTime(),', 'ms: Date.UTC(y, mo - 1, d),'],
  // An all-day length is counted from the dates, so moving only the DTEND's
  // ms would change nothing. Move its date.
  ['all-day: DTEND inclusive', 'src/main/ics/vevent.js',
    "case 'DTEND':\n        ev.end = parseIcsDate(p.value, p.params);",
    "case 'DTEND':\n        ev.end = parseIcsDate(p.value, p.params);\n" +
    '        if (ev.end && ev.end.allDay) ev.end = addDays(ev.end, 1);'],
  ['all-day: instance length in ms', 'src/main/ics/expand.js',
    'return new Date(s.getFullYear(), s.getMonth(), s.getDate() + days).getTime();',
    'return startMs + (event.end.ms - event.start.ms);'],
  ['all-day: missing DTEND and DURATION in ms', 'src/main/ics/vevent.js',
    'ev.end = addDays(ev.start, days);', 'ev.end = { ...ev.start, ms: ev.start.ms + days * DAY_MS };'],

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

  // A window includes every instance that overlaps it, so a series expands
  // from as far before the window as its master lasts.
  ['window: expansion starts a fixed day early', 'src/main/ics/expand.js',
    'return windowStart - Math.max(0, event.end.ms - event.start.ms);', 'return windowStart - 86400000;'],
  ['window: expansion starts half the length early', 'src/main/ics/expand.js',
    'return windowStart - Math.max(0, event.end.ms - event.start.ms);',
    'return windowStart - Math.max(0, event.end.ms - event.start.ms) / 2;'],
  // An end is exclusive, so an instance that ends as the window starts isn't
  // in it.
  ['window: an end at windowStart counts as overlap', 'src/main/ics/expand.js',
    '(startMs >= windowStart || endMs > windowStart)', '(endMs >= windowStart)'],
  ['window: an instance with no length at windowStart dropped', 'src/main/ics/expand.js',
    '(startMs >= windowStart || endMs > windowStart)', '(endMs > windowStart)'],

  // COUNT counts from DTSTART. A COUNT rule skips ahead to the window only
  // where it counts what it skips: a DAILY rule with no limits.
  ['COUNT: WEEKLY skips ahead anyway', 'src/main/ics/rrule.js',
    'if (rule.count === null && windowStart > start.ms) {\n      const weeksAway',
    'if (windowStart > start.ms) {\n      const weeksAway'],
  ['COUNT: YEARLY skips ahead anyway', 'src/main/ics/rrule.js',
    'if (rule.count === null) {\n      const windowYear', 'if (true) {\n      const windowYear'],
  ['COUNT: MONTHLY skips ahead anyway', 'src/main/ics/rrule.js',
    'if (rule.count === null && windowStart > start.ms) {\n      const w = new Date(windowStart);',
    'if (windowStart > start.ms) {\n      const w = new Date(windowStart);'],
  ['COUNT: DAILY with limits skips ahead anyway', 'src/main/ics/rrule.js',
    'if ((rule.count === null || !limited) && windowStart > start.ms) {', 'if (windowStart > start.ms) {'],
  ['COUNT: DAILY skips ahead without counting', 'src/main/ics/rrule.js',
    'emitted += skip / rule.interval - 1;', ''],
  ['COUNT: DAILY counts DTSTART again when it skips ahead', 'src/main/ics/rrule.js',
    'emitted += skip / rule.interval - 1;', 'emitted += skip / rule.interval;'],
  ['COUNT: MAX_INSTANCES counts the instances before the window', 'src/main/ics/rrule.js',
    'out.length < MAX_INSTANCES', 'emitted < MAX_INSTANCES'],

  // DTSTART is always the first instance, and counts toward COUNT, even when
  // it isn't one of the rule's own dates.
  ['DTSTART: not counted toward COUNT', 'src/main/ics/rrule.js',
    'let emitted = 1; // DTSTART', 'let emitted = 0;'],
  ['DTSTART: shown only when the rule picks it', 'src/main/ics/rrule.js',
    'if (!rule || !supported(rule)) return out;', 'if (!rule || !supported(rule)) return out;\n  out.length = 0;'],

  // Without COUNT, a rule skips ahead to the window, a whole number of
  // intervals at a time.
  ['DAILY: walks from DTSTART into MAX_ITERATIONS', 'src/main/ics/rrule.js',
    'if ((rule.count === null || !limited) && windowStart > start.ms) {', 'if (false) {'],
  ['DAILY: skips ahead off the INTERVAL grid', 'src/main/ics/rrule.js',
    'const skip = daysAway - (daysAway % rule.interval);', 'const skip = daysAway;'],
  ['WEEKLY: skips ahead off the INTERVAL grid', 'src/main/ics/rrule.js',
    'weeksAway - (weeksAway % rule.interval) - rule.interval', 'weeksAway - rule.interval'],
  ['MONTHLY: skips ahead off the INTERVAL grid', 'src/main/ics/rrule.js',
    'start.mo - 1 + monthsAway - (monthsAway % rule.interval)', 'start.mo - 1 + monthsAway'],

  // An instance can fall more than a day from its date's local midnight, so a
  // jump-start lands short of the window and a loop stops past it.
  ['slack: none', 'src/main/ics/rrule.js', 'const SLACK_MS = 2 * DAY_MS;', 'const SLACK_MS = 0;'],
  ['DAILY: skips ahead to the window itself', 'src/main/ics/rrule.js',
    '(windowStart - SLACK_MS - cursor.getTime())', '(windowStart - cursor.getTime())'],
  ['MONTHLY: skips ahead to the window month itself', 'src/main/ics/rrule.js',
    '(w.getMonth() + 1 - start.mo) - 1;', '(w.getMonth() + 1 - start.mo);'],

  // UNTIL is inclusive, in its UTC, floating and date forms.
  ['UNTIL: datetime form exclusive', 'src/main/ics/rrule.js', 'return ms > rule.until.ms;', 'return ms >= rule.until.ms;'],
  ['UNTIL: date form exclusive', 'src/main/ics/rrule.js', 'return d > u.d;', 'return d >= u.d;'],
  ['UNTIL: date form ignored', 'src/main/ics/rrule.js', 'if (/^\\d{8}$/.test(value)) {', 'if (false) {'],
  ['UNTIL: floating form read as UTC', 'src/main/ics/rrule.js',
    'rule.until = m[7] ? { ms: Date.UTC(y, mo - 1, d, h, mi, s) } : { wall: [y, mo, d, h, mi, s] };',
    'rule.until = { ms: Date.UTC(y, mo - 1, d, h, mi, s) };'],

  // The RRULE engine: DAILY, WEEKLY with BYDAY, MONTHLY with BYMONTHDAY or
  // BYDAY, and YEARLY with BYMONTH plus either.
  ['engine: no DAILY', 'src/main/ics/rrule.js', "if (rule.freq === 'DAILY') {", "if (rule.freq === 'NONE') {"],
  ['engine: no MONTHLY', 'src/main/ics/rrule.js', "if (rule.freq === 'MONTHLY') {", "if (rule.freq === 'NONE') {"],
  ['engine: no YEARLY', 'src/main/ics/rrule.js', "if (rule.freq === 'YEARLY') {", "if (rule.freq === 'NONE') {"],
  ['engine: INTERVAL ignored', 'src/main/ics/rrule.js', 'rule.interval = /^\\d+$/.test(value) ? +value : 0;', ''],
  ['WEEKLY: INTERVAL ignored', 'src/main/ics/rrule.js', 'weekIndex += rule.interval;', 'weekIndex += 1;'],
  ['nonexistent dates rolled over', 'src/main/ics/rrule.js',
    '.filter((d) => d >= 1 && d <= last)', '.filter((d) => d >= 1)'],
  ['BYMONTHDAY: negative days not counted from the end', 'src/main/ics/rrule.js',
    'return n > 0 ? n : last + 1 + n;', 'return n;'],
  ['BYDAY: ignored outside WEEKLY', 'src/main/ics/rrule.js',
    '} else if (rule.byDay.length) {', '} else if (false) {'],
  ['BYDAY: ordinal ignored', 'src/main/ics/rrule.js',
    'if (n === 0) days.push(...dates);', 'if (true) days.push(...dates);'],
  ['BYDAY: negative ordinal counted from the start', 'src/main/ics/rrule.js',
    'dates[dates.length + n]', 'dates[-n - 1]'],
  ['YEARLY: only the first BYMONTH', 'src/main/ics/rrule.js',
    'const months = rule.byMonth.length ? rule.byMonth : [start.mo];', 'const months = [rule.byMonth[0] || start.mo];'],

  // Weeks start on WKST, Monday by default.
  ['WKST: weeks start on Sunday', 'src/main/ics/rrule.js', 'const wkst = DAY_CODES[rule.wkst];', 'const wkst = 0;'],
  ['WKST: ignored', 'src/main/ics/rrule.js', 'rule.wkst = value.toUpperCase();', ''],
  ['WKST: Sunday by default', 'src/main/ics/rrule.js', "wkst: 'MO',", "wkst: 'SU',"],

  // A series' dates come in order and once each, since COUNT and the end of
  // the window stop it at the first date past them.
  ['order: days of the month unsorted', 'src/main/ics/rrule.js',
    '.filter((d) => d >= 1 && d <= last).sort((a, b) => a - b);', '.filter((d) => d >= 1 && d <= last);'],
  ['order: days of the month repeated', 'src/main/ics/rrule.js',
    'return [...new Set(days)].filter(', 'return days.filter('],
  ['order: BYMONTH unsorted', 'src/main/ics/rrule.js',
    "rule.byMonth = [...new Set(value.split(',').map(Number))].sort((a, b) => a - b);",
    "rule.byMonth = [...new Set(value.split(',').map(Number))];"],
  ['order: BYMONTH repeated', 'src/main/ics/rrule.js',
    "rule.byMonth = [...new Set(value.split(',').map(Number))].sort((a, b) => a - b);",
    "rule.byMonth = value.split(',').map(Number).sort((a, b) => a - b);"],
  ['order: WEEKLY days unsorted', 'src/main/ics/rrule.js',
    '.map((dow) => (dow - wkst + 7) % 7).sort((a, b) => a - b);', '.map((dow) => (dow - wkst + 7) % 7);'],
  ['order: WEEKLY days repeated', 'src/main/ics/rrule.js',
    '[...new Set(rule.byDay.map((x) => x.dow))]', 'rule.byDay.map((x) => x.dow)'],

  // Where RFC 5545 makes a part a limit, it keeps only the dates it names, and
  // the dates it drops don't count toward COUNT.
  ['limits: BYMONTH ignored', 'src/main/ics/rrule.js',
    'if (rule.byMonth.length && !rule.byMonth.includes(mo)) return false;', ''],
  ['limits: BYMONTHDAY ignored', 'src/main/ics/rrule.js',
    'if (rule.byMonthDay.length && !rule.byMonthDay.some((n) => monthDay(n, daysIn(y, mo)) === d)) return false;', ''],
  ['limits: BYDAY ignored', 'src/main/ics/rrule.js',
    'if (rule.byDay.length && !rule.byDay.some((x) => x.dow === weekday(y, mo, d))) return false;', ''],
  ['limits: dropped dates counted', 'src/main/ics/rrule.js',
    'if (ms <= start.ms || !inLimits(rule, y, mo, d)) return true;\n    emitted++;',
    'if (ms <= start.ms) return true;\n    emitted++;\n    if (!inLimits(rule, y, mo, d)) return true;'],

  // A rule with a part, a value or a combination the engine doesn't implement
  // shows only DTSTART.
  ['unsupported: rule expanded anyway', 'src/main/ics/rrule.js',
    'if (!rule || !supported(rule)) return out;', 'if (!rule) return out;'],
  ['unsupported: unknown rule part accepted', 'src/main/ics/rrule.js',
    '// BYSETPOS, BYWEEKNO, BYYEARDAY, BYHOUR and the rest.\n        rule.unsupported = true;',
    '// BYSETPOS, BYWEEKNO, BYYEARDAY, BYHOUR and the rest.'],
  ['unsupported: unreadable INTERVAL accepted', 'src/main/ics/rrule.js',
    'if (rule.interval < 1) rule.unsupported = true;', ''],
  ['unsupported: unreadable COUNT accepted', 'src/main/ics/rrule.js',
    'if (rule.count === null || rule.count < 0) rule.unsupported = true;', ''],
  ['unsupported: unknown WKST accepted', 'src/main/ics/rrule.js',
    'if (!Object.hasOwn(DAY_CODES, rule.wkst)) rule.unsupported = true;', ''],
  ['unsupported: unreadable UNTIL accepted', 'src/main/ics/rrule.js',
    'rule.unsupported = true; // an unreadable UNTIL would make the series endless', ''],
  ['unsupported: impossible BYMONTH accepted', 'src/main/ics/rrule.js',
    'if (!rule.byMonth.every((mo) => Number.isInteger(mo) && mo >= 1 && mo <= 12)) rule.unsupported = true;', ''],
  ['unsupported: impossible BYMONTHDAY accepted', 'src/main/ics/rrule.js',
    'if (!rule.byMonthDay.every((d) => Number.isInteger(d) && d !== 0 && d >= -31 && d <= 31)) rule.unsupported = true;', ''],
  ['unsupported: unreadable BYDAY skipped', 'src/main/ics/rrule.js',
    'if (!m || (m[1] !== undefined && +m[1] === 0)) {\n            rule.unsupported = true;\n            continue;\n          }',
    'if (!m) continue;\n          if (+m[1] === 0) {\n            rule.unsupported = true;\n            continue;\n          }'],
  ['unsupported: 0 ordinal accepted', 'src/main/ics/rrule.js',
    'if (!m || (m[1] !== undefined && +m[1] === 0)) {', 'if (!m) {'],
  ['unsupported: ordinal on DAILY accepted', 'src/main/ics/rrule.js', 'return !ordinal;', 'return true;'],
  ['unsupported: ordinal on WEEKLY accepted', 'src/main/ics/rrule.js',
    'return !ordinal && !byMonthDay;', 'return !byMonthDay;'],
  ['unsupported: BYMONTHDAY on WEEKLY accepted', 'src/main/ics/rrule.js',
    'return !ordinal && !byMonthDay;', 'return !ordinal;'],
  ['unsupported: MONTHLY BYDAY with BYMONTHDAY accepted', 'src/main/ics/rrule.js',
    'return !(byDay && byMonthDay);', 'return true;'],
  ['unsupported: YEARLY BYDAY with BYMONTHDAY accepted', 'src/main/ics/rrule.js',
    'return !(byDay && byMonthDay) && (byMonth', 'return (byMonth'],
  ['unsupported: YEARLY BYDAY or BYMONTHDAY without BYMONTH accepted', 'src/main/ics/rrule.js',
    ' && (byMonth || (!byDay && !byMonthDay));', ';'],
  ['unsupported: sub-daily frequency accepted', 'src/main/ics/rrule.js',
    'return false; // HOURLY, MINUTELY, SECONDLY', 'return true;'],

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
    const hits = original.split(find).length - 1;
    if (hits === 0) {
      console.log('STALE   ' + name + '  (text not found in ' + rel + ')');
      continue;
    }
    if (hits > 1) {
      console.log('REPEATED ' + name + '  (text found ' + hits + ' times in ' + rel + ')');
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

// Resolves parsed VEVENTs into concrete instances inside a date window.
//
// Recurrence in a Google export is three interacting pieces:
//   - masters      : have RRULE, no RECURRENCE-ID
//   - overrides    : have RECURRENCE-ID, no RRULE (a single moved/edited instance)
//   - EXDATEs      : instances deleted from a series
//
// Matching is done on the LOCAL CALENDAR DAY, not on exact instants. One real
// event is an all-day master carrying a *timed* RECURRENCE-ID, which exact
// datetime equality would never match.
const { expandRRule } = require('./rrule');
const { localDateKey } = require('./datetime');

function instanceFrom(event, startMs) {
  const duration = Math.max(0, event.end.ms - event.start.ms);
  return {
    uid: event.uid,
    summary: event.summary,
    location: event.location,
    allDay: event.allDay,
    startMs,
    endMs: startMs + duration,
  };
}

function expandEvents(events, windowStart, windowEnd) {
  const masters = [];
  const overrides = [];

  for (const ev of events) {
    if (ev.status === 'CANCELLED') continue; // defensive; none in current data
    if (ev.recurrenceId) overrides.push(ev);
    else masters.push(ev);
  }

  // Index overrides by uid + calendar day so a master can find its replacements.
  const overrideIndex = new Map();
  for (const ov of overrides) {
    const key = `${ov.uid}|${localDateKey(ov.recurrenceId.ms)}`;
    overrideIndex.set(key, ov);
  }
  const consumed = new Set();

  const out = [];

  for (const master of masters) {
    if (!master.rrule) {
      // Plain one-off event: include if it overlaps the window at all.
      if (master.end.ms >= windowStart && master.start.ms <= windowEnd) {
        out.push(instanceFrom(master, master.start.ms));
      }
      continue;
    }

    const exdateKeys = new Set(master.exdates.map((d) => localDateKey(d.ms)));

    // Widen the expansion window by a day so an instance that starts just
    // before the window but runs into it is still produced.
    const occurrences = expandRRule(
      master.rrule,
      master.start,
      windowStart - 86400000,
      windowEnd + 86400000
    );

    for (const ms of occurrences) {
      const key = localDateKey(ms);
      if (exdateKeys.has(key)) continue;

      const overrideKey = `${master.uid}|${key}`;
      const override = overrideIndex.get(overrideKey);

      if (override) {
        consumed.add(overrideKey);
        if (override.end.ms >= windowStart && override.start.ms <= windowEnd) {
          out.push(instanceFrom(override, override.start.ms));
        }
        continue;
      }

      const inst = instanceFrom(master, ms);
      if (inst.endMs >= windowStart && inst.startMs <= windowEnd) out.push(inst);
    }
  }

  // An override can be moved INTO the window from a date outside it, in which
  // case no base occurrence was generated to swap it into. Pick those up here.
  for (const [key, ov] of overrideIndex) {
    if (consumed.has(key)) continue;
    if (ov.end.ms >= windowStart && ov.start.ms <= windowEnd) {
      out.push(instanceFrom(ov, ov.start.ms));
    }
  }

  out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  return out;
}

module.exports = { expandEvents };

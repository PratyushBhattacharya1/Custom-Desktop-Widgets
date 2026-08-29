// Turns raw ICS text into structured VEVENT records.
//
// Block nesting is tracked by depth so that VALARM properties (nested inside a
// VEVENT) and VTIMEZONE blocks never get merged into event fields.
const { unfold } = require('./unfold');
const { parseLine } = require('./contentline');
const { unescapeText } = require('./text');
const { parseIcsDate, parseDuration } = require('./datetime');

const DAY_MS = 86400000;

function buildEvent(props) {
  const ev = {
    uid: null,
    summary: '',
    location: '',
    start: null,
    end: null,
    rrule: null,
    exdates: [],
    recurrenceId: null,
    status: null,
    transparent: false,
    sequence: 0,
  };

  let durationMs = null;

  for (const p of props) {
    switch (p.name) {
      case 'UID':
        ev.uid = p.value;
        break;
      case 'SUMMARY':
        ev.summary = unescapeText(p.value);
        break;
      case 'LOCATION':
        ev.location = unescapeText(p.value);
        break;
      case 'DTSTART':
        ev.start = parseIcsDate(p.value, p.params);
        break;
      case 'DTEND':
        ev.end = parseIcsDate(p.value, p.params);
        break;
      case 'DURATION':
        durationMs = parseDuration(p.value);
        break;
      case 'RRULE':
        ev.rrule = p.value;
        break;
      case 'RECURRENCE-ID':
        ev.recurrenceId = parseIcsDate(p.value, p.params);
        break;
      case 'STATUS':
        ev.status = p.value.toUpperCase();
        break;
      case 'TRANSP':
        ev.transparent = p.value.toUpperCase() === 'TRANSPARENT';
        break;
      case 'SEQUENCE':
        ev.sequence = parseInt(p.value, 10) || 0;
        break;
      case 'EXDATE': {
        // Defensive: the spec allows comma-separated values on one line, even
        // though Google emits one per line.
        for (const piece of p.value.split(',')) {
          const d = parseIcsDate(piece, p.params);
          if (d) ev.exdates.push(d);
        }
        break;
      }
      default:
        break;
    }
  }

  if (!ev.start) return null;

  // RFC 5545 3.6.1 fallbacks for a missing DTEND. One real event in the sample
  // export has DTSTART and no DTEND at all.
  if (!ev.end) {
    if (durationMs !== null) {
      ev.end = { ...ev.start, ms: ev.start.ms + durationMs };
    } else if (ev.start.allDay) {
      ev.end = { ...ev.start, ms: ev.start.ms + DAY_MS };
    } else {
      ev.end = { ...ev.start };
    }
  }

  ev.allDay = ev.start.allDay;
  return ev;
}

function parseCalendar(icsText) {
  const lines = unfold(icsText);
  const events = [];
  const stack = [];
  let current = null;

  for (const raw of lines) {
    const cl = parseLine(raw);
    if (!cl) continue;

    if (cl.name === 'BEGIN') {
      const block = cl.value.toUpperCase().trim();
      stack.push(block);
      // Only a VEVENT directly inside VCALENDAR starts a record.
      if (block === 'VEVENT' && stack.length === 2) current = [];
      continue;
    }

    if (cl.name === 'END') {
      const block = stack.pop();
      if (block === 'VEVENT' && current) {
        const ev = buildEvent(current);
        if (ev && ev.uid) events.push(ev);
        current = null;
      }
      continue;
    }

    // Collect only at VEVENT depth — this is what skips nested VALARM.
    if (current && stack.length === 2 && stack[1] === 'VEVENT') {
      current.push(cl);
    }
  }

  return events;
}

module.exports = { parseCalendar, DAY_MS };

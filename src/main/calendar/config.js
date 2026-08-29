// Loads and validates calendars.local.json.
//
// That file holds Google "secret address in iCal format" URLs, which are
// credential-equivalent: anyone holding one can read the calendar indefinitely.
// It is gitignored, and nothing here ever logs or forwards a url field.
const fs = require('fs');
const path = require('path');

const CONFIG_NAME = 'calendars.local.json';
const EXAMPLE_NAME = 'calendars.example.json';

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const SAFE_ID = /^[a-z0-9_-]+$/i;
const PLACEHOLDER = /PASTE_SECRET_ICAL_URL_HERE|REPLACE_ME/;

function configPath(root) {
  return path.join(root, CONFIG_NAME);
}

function examplePath(root) {
  return path.join(root, EXAMPLE_NAME);
}

// Returns { calendars: [...], refreshMinutes, problems: [...] }.
// Never throws — a missing or malformed config simply yields no calendars, and
// the widget renders an empty (but working) month.
function load(root) {
  const result = { calendars: [], refreshMinutes: 60, problems: [], exists: false };
  const file = configPath(root);

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
    result.exists = true;
  } catch {
    result.problems.push(
      `No ${CONFIG_NAME} found. Copy ${EXAMPLE_NAME} to ${CONFIG_NAME} and paste your calendar URLs into it.`
    );
    return result;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    result.problems.push(`${CONFIG_NAME} is not valid JSON: ${err.message}`);
    return result;
  }

  if (Number.isFinite(parsed.refreshMinutes)) {
    result.refreshMinutes = Math.max(5, parsed.refreshMinutes);
  }

  const seen = new Set();
  const list = Array.isArray(parsed.calendars) ? parsed.calendars : [];

  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.enabled === false) continue;

    const id = String(entry.id || '').trim();
    if (!SAFE_ID.test(id)) {
      result.problems.push(`Skipped a calendar with an invalid id: ${JSON.stringify(entry.id)}`);
      continue;
    }
    if (seen.has(id)) {
      result.problems.push(`Skipped duplicate calendar id "${id}".`);
      continue;
    }

    const url = String(entry.url || '').trim();
    if (!url || PLACEHOLDER.test(url)) {
      result.problems.push(`Calendar "${id}" has no URL set yet.`);
      continue;
    }
    if (!/^https:\/\//i.test(url)) {
      // Deliberately does not echo the value back.
      result.problems.push(`Calendar "${id}" must use an https:// URL.`);
      continue;
    }

    const color = HEX_COLOR.test(entry.color) ? entry.color : '#4c8dff';

    seen.add(id);
    result.calendars.push({
      id,
      name: String(entry.name || id).slice(0, 60),
      url,
      color,
    });
  }

  return result;
}

// The subset that is safe to hand to a renderer — note the absence of `url`.
function publicView(calendars) {
  return calendars.map((c) => ({ id: c.id, name: c.name, color: c.color }));
}

module.exports = { load, publicView, configPath, examplePath, CONFIG_NAME, EXAMPLE_NAME };

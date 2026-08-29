// Fetches calendar .ics feeds, caches them to disk, and schedules refreshes.
//
// Security rules enforced here:
//   1. A feed URL never crosses IPC — only parsed events do.
//   2. A feed URL never reaches a log line. net/https errors routinely embed the
//      URL in err.message, so every message goes through redact().
//   3. A feed URL never reaches a filename. Cache files are named from the
//      config id, which is validated against [a-z0-9_-] before we get here.
const { app, net } = require('electron');
const fs = require('fs');
const path = require('path');

const REQUEST_TIMEOUT_MS = 20000;
const MAX_BYTES = 10 * 1024 * 1024;
const STAGGER_MS = 1500;

function cacheDir() {
  return path.join(app.getPath('userData'), 'calendar-cache');
}

function cacheFile(id) {
  return path.join(cacheDir(), `${id}.ics`);
}

// Strips any URL from a message before it can be logged.
function redact(value) {
  const text = value instanceof Error ? value.message : String(value);
  return text.replace(/https?:\/\/\S+/gi, '<url>');
}

function fetchOne(calendar) {
  return new Promise((resolve) => {
    let settled = false;
    const chunks = [];
    let total = 0;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let request;
    try {
      request = net.request({ method: 'GET', url: calendar.url, redirect: 'follow' });
    } catch (err) {
      finish({ ok: false, error: redact(err) });
      return;
    }

    const timer = setTimeout(() => {
      try {
        request.abort();
      } catch {
        /* already gone */
      }
      finish({ ok: false, error: 'Timed out after ' + REQUEST_TIMEOUT_MS + 'ms' });
    }, REQUEST_TIMEOUT_MS);

    request.on('response', (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        clearTimeout(timer);
        finish({ ok: false, error: `HTTP ${response.statusCode}` });
        response.resume?.();
        return;
      }

      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_BYTES) {
          clearTimeout(timer);
          try {
            request.abort();
          } catch {
            /* ignore */
          }
          finish({ ok: false, error: 'Response exceeded ' + MAX_BYTES + ' bytes' });
          return;
        }
        chunks.push(chunk);
      });

      response.on('end', () => {
        clearTimeout(timer);
        const text = Buffer.concat(chunks).toString('utf-8');
        if (!/BEGIN:VCALENDAR/i.test(text)) {
          finish({ ok: false, error: 'Response was not an iCalendar document' });
          return;
        }
        finish({ ok: true, text });
      });

      response.on('error', (err) => {
        clearTimeout(timer);
        finish({ ok: false, error: redact(err) });
      });
    });

    request.on('error', (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: redact(err) });
    });

    try {
      request.end();
    } catch (err) {
      clearTimeout(timer);
      finish({ ok: false, error: redact(err) });
    }
  });
}

function readCache(id) {
  try {
    return fs.readFileSync(cacheFile(id), 'utf-8');
  } catch {
    return null;
  }
}

function writeCache(id, text) {
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    fs.writeFileSync(cacheFile(id), text, 'utf-8');
    return true;
  } catch (err) {
    console.error(`Failed to cache calendar "${id}": ${redact(err)}`);
    return false;
  }
}

function cacheAge(id) {
  try {
    return fs.statSync(cacheFile(id)).mtimeMs;
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetches every calendar in sequence, spaced out so we don't fire five
// simultaneous requests at boot. Returns a per-calendar status map.
async function refreshAll(calendars, onCalendarUpdated) {
  const status = {};

  for (let i = 0; i < calendars.length; i++) {
    const cal = calendars[i];
    const result = await fetchOne(cal);

    if (result.ok) {
      writeCache(cal.id, result.text);
      status[cal.id] = { ok: true, lastSuccessAt: Date.now(), stale: false };
      if (onCalendarUpdated) onCalendarUpdated(cal.id, result.text);
    } else {
      const age = cacheAge(cal.id);
      status[cal.id] = {
        ok: false,
        lastSuccessAt: age,
        stale: true,
        error: result.error,
      };
      console.warn(`Calendar "${cal.id}" refresh failed: ${result.error}`);
    }

    if (i < calendars.length - 1) await sleep(STAGGER_MS);
  }

  return status;
}

module.exports = { refreshAll, readCache, cacheAge, cacheDir, redact, REQUEST_TIMEOUT_MS };

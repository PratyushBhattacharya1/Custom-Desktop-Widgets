# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` imports this file, so make edits here.

## Overview

Frameless desktop widgets for Windows: a clock, a calendar fed by live read-only iCal feeds, and a Gmail inbox. Built with Electron 31 and plain HTML/CSS/JS. There is no framework, bundler, build step or runtime dependency; `electron` (a devDependency) is the only package. The app targets Windows. The context menu relies on the win32-only `system-context-menu` event and on how Windows hit-tests drag regions.

## Commands

```bash
npm install
npm start                                     # electron . — opens every widget plus the tray icon
node scripts/verify-ics.js [export.zip|.ics]  # ICS parser regression suite (plain Node, no Electron)
node --check path/to/file.js                  # syntax check
```

- There is no linter, formatter, test framework or `npm test`. `scripts/verify-ics.js` is the only committed test. Run it after any change under `src/main/ics/`.
- With no argument, `verify-ics.js` uses the first `*.ical.zip` in the repo root, which is a gitignored personal Google Calendar export. If it finds no fixture it prints a notice and exits 0, so a pass without a fixture proves nothing. Its thresholds are tuned to that export (more than 400 events, instances in April 2024, a March 2024 DST check), so a different export can fail because of the data rather than the code.
- `npm start` has no dev profile. It reads the real `calendars.local.json` and `gmail.local.json`, polls the real Gmail account, and writes the real saved state in `userData`.
- The renderers expose `window.__cal`, `window.__mail` and `window.__settings` for an external verification harness that is not in the repo. Keep these hooks when refactoring.

## Architecture

### Processes and trust boundary

- `main.js` holds the `WIDGETS` registry. It creates one frameless, transparent `BrowserWindow` per widget, builds the tray menu, and forwards service updates to the matching window.
- Renderers run with `contextIsolation: true`. Their only route to the main process is `preload.js`, which exposes `widgetAPI`, `calendarAPI` and `gmailAPI`. All file and network access happens in main.
- A widget's identity never comes from the renderer. `main.js` stamps `win.__widgetId` on each window, and every handler in `src/main/ipc.js` resolves the widget from `event.sender`. `ipc.js` is the only place `ipcMain` handlers are registered. No preload method takes a widget id, so one widget can't read or change another's state. Keep it that way.
- `widgetAPI` deliberately has no settings setter. Settings change only through the main-process context menu.
- A new IPC channel needs three edits: the handler in `src/main/ipc.js`, the bridge in `preload.js`, and the call in the renderer. Main pushes to renderers with `webContents.send` on `widget:settings-changed`, `widget:work-area-changed`, `calendar:updated` and `gmail:updated`.

### Persisted state and appearance settings

- `src/main/store.js` owns the only state file, `widget-positions.json` in Electron `userData` (`%APPDATA%\desktop-widgets\`). The file name is historical, and renaming it would lose saved positions. Its shape is `{ [widgetId]: { x, y, w, h, pinned, settings } }`. Writes are debounced by 250 ms and flushed on `before-quit`. `patch()` merges only one level deep, so always write the whole `settings` object through `settings.setSetting()`.
- `src/main/settings.js` holds three things: the catalogue of allowed values (backgrounds, opacity steps, sizes), a reader that sanitises stored values, and `composeFor(id)`, which turns the settings into CSS values. After every change, main pushes the composed payload (`ipc.pushSettings`). `widgets/shared/settings.js` applies it as CSS custom properties on `<html>`. `CAPABILITIES` decides which menu items each widget gets; only the clock offers Size. The module is separate from `main.js` to avoid a require cycle.
- Background presets are dark-only on purpose. The calendar's chrome is hard-coded white-on-dark.

### Context menu and window activation

- `src/main/menu.js` needs two triggers. Windows delivers a right-click on a `-webkit-app-region: drag` area as a non-client message that Chromium never sees, so only the window's `system-context-menu` event fires there. Right-clicks on `no-drag` areas go through the `webContents` `context-menu` event, and so do all right-clicks on a pinned widget, because `html.pos-locked` makes the whole body `no-drag`. `popup()` ignores a second popup within 300 ms and opens at the cursor.
- Keep widget windows activatable. `focusable: false` (the `WS_EX_NOACTIVATE` window style) was tried to stop Windows bringing widgets to the front whenever it picks a new foreground window. It broke the context menu: the menu no longer closed on an outside click, and forcing `focus()` made taskbar buttons flash. The surfacing problem is still unsolved. Any fix must leave window activation alone.

### Self-sizing

- Widgets size their own windows. `widgets/shared/autosize.js` watches `.card` with a `ResizeObserver` and sends `widget:request-size`. `ipc.applySize()` caps the request at 45% of the display work area's height and 35% of its width, and at the room left below and to the right of the window. It then saves `w`/`h`, so the next launch opens at the fitted size.
- Three guards prevent resize loops: the renderer ignores changes of 1 px or less, main skips requests that change nothing, and main accepts at most 10 requests per second. Keep all three. `MIN_SIZE` and `MIN_CAP` reproduce the earlier clamping exactly; don't "tidy" them.
- The clock reports both width and height, and `width: max-content` on its card is required for it to shrink. The calendar reports height only, because its 320 px width is tuned to the grid. The email widget has a fixed size.

### Calendar pipeline

Data flows `calendars.local.json` → `calendar/config.js` → `calendar/feed.js` → `calendar/service.js` → `calendar:get-month`:

- `config.js` validates each entry.
- `feed.js` fetches each feed with Electron `net`. The limits are a 20 s timeout and 10 MB per response, with requests spaced 1.5 s apart. Responses are cached to `userData/calendar-cache/<id>.ics`.
- `service.js` parses each feed once per fetch and expands events for each month the widget requests.

Cached feeds load before any network request, so an offline start still renders. Feeds refresh every `refreshMinutes` (default 60, minimum 5) and when the machine wakes.

`src/main/ics/` is a hand-rolled, zero-dependency subset of RFC 5545 (iCalendar), built to handle real Google exports. Keep these invariants:

- Unfold the whole file before parsing any line, because Google folds lines in the middle of parameters.
- Expand recurrences in the event's own wall-clock timezone (`Intl.DateTimeFormat`). Never step by adding milliseconds, which drifts an hour across DST.
- Anchor all-day dates to local midnight. An all-day DTEND is exclusive.
- Match EXDATE and RECURRENCE-ID by local calendar day, not by exact instant.
- COUNT counts from DTSTART, so a COUNT rule can't skip ahead to the requested window.
- The RRULE engine is deliberately narrow: WEEKLY and YEARLY, plus basic DAILY and MONTHLY.
- Times display in the machine's current timezone. That is correct conversion, not a bug. There is no configured display timezone.

### Gmail pipeline

Data flows `gmail.local.json` → `gmail/auth.js` → `gmail/service.js` → `gmail:updated`:

- `gmail.local.json` holds the OAuth desktop client plus `refreshMinutes`, `maxMessages` and `query`.
- `auth.js` runs the OAuth sign-in with scope `gmail.readonly`. It uses a loopback redirect to `127.0.0.1` on a random port, PKCE and a `state` check.
- `service.js` polls, fetches message details in `format=metadata` five at a time, and caches them to `userData/gmail-cache.json`.

Rules:

- The refresh token is stored only through `safeStorage`, in `userData/gmail-token.bin`. If OS encryption is unavailable, the token is not stored at all.
- The OAuth app is in Google's Testing status, so refresh tokens expire every 7 days. "Needs reconnect" is therefore a normal state. The widget shows it, and the email widget's context menu offers Connect/Reconnect Gmail… and Refresh now.
- Only `invalid_grant` from the token endpoint means the credential is dead. A 401 or 403 from the Gmail API must not delete the refresh token, because rate limits also arrive as 403.
- Only a complete fetch may overwrite the cache or the last-success timestamp.
- Only rendered message fields cross IPC, never tokens or the client secret.

### Renderers (`widgets/`)

- Each widget lives in `widgets/<id>/index.html`, and the calendar splits out `calendar.css` and `calendar.js`. Shared files are in `widgets/shared/`, and load order matters:
  - `widget.css` goes before the widget's own styles.
  - `autosize.js` and `settings.js` go before the widget's script.
  - `pin.js` goes after the `.card` markup, because it attaches to the card.
- Don't redeclare the `.card` background, color, border-radius, backdrop-filter or text-shadow in a widget's own styles. A widget's styles load after `widget.css`, so an override silently stops responding to settings.
- The whole window is a drag region (`-webkit-app-region: drag`). Every interactive element needs `no-drag`, or it won't receive clicks.
- Render external data (event summaries, mail) with `textContent` only. Use `innerHTML` only for static strings written in the code.
- The reduced-motion override uses 0.01 ms, not 0. A zero-length transition never fires `transitionend`, and the calendar's cross-fade depends on that event.

### Adding a widget

1. Create `widgets/<id>/index.html` with a `<div class="card">`, linking `../shared/widget.css` and the shared scripts in the order above.
2. Add `{ id, file, width, height, defaultX, defaultY }` to `WIDGETS` in `main.js`.
3. Add a `CAPABILITIES` entry in `src/main/settings.js`. Without one, the widget gets no Size option.

## Secrets and local data

- These files are gitignored and must stay that way:
  - `calendars.local.json`: a secret iCal URL gives anyone who holds it permanent read access to that calendar.
  - `gmail.local.json`: the OAuth client ID and secret.
  - `*.ical.zip` and `*.ics`: personal calendar exports.
- The committed templates are `calendars.example.json` and `gmail.example.json`.
- A feed URL must never reach a log line, a renderer or a filename. Error messages from `net` include the URL, so pass every message through `feed.redact()` or `auth.redact()` (which also masks long tokens). Cache files are named from the validated config `id`, never from the URL.
- GitHub Pages publishes `docs/` from `main`, so a push to `main` makes docs changes live. The site includes the privacy policy (`docs/privacy.md`) used for Google OAuth publishing. Update it when scopes or stored data change.

## Conventions

- CommonJS with no transpiling. Having no runtime dependencies is deliberate, so prefer Node and Electron built-ins. Use Electron's `net` rather than `https`, because `net` uses the system proxy and certificate store.
- Comments explain why: platform quirks, constraints, rejected approaches. Keep that level of commenting when editing nearby code.
- Commit subjects are imperative and describe the behaviour, e.g. "Carry the selected day across midnight". Commit bodies explain the reasoning and how the change was verified.

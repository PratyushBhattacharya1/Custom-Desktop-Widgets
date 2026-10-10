# AGENTS.md

Guidance for coding agents working in this repository. `CLAUDE.md` imports this file, so make edits here.

## Overview

Frameless desktop widgets for Windows: a clock, a calendar fed by live read-only iCal feeds, and a Gmail inbox. Built with Electron 31 and plain HTML/CSS/JS. There is no framework, bundler, build step or runtime dependency; `electron` (a devDependency) is the only package. The app targets Windows. The context menu relies on the win32-only `system-context-menu` event and on how Windows hit-tests drag regions.

## Commands

```bash
npm install
npm start                                     # electron . — opens every widget plus the tray icon
node scripts/check.js                         # the static checks CI runs: syntax, JSON, secrets
node scripts/verify-ics.js [export.zip|.ics]  # ICS parser regression suite (plain Node, no Electron)
node scripts/verify-gmail.js                  # Gmail message-id and request-URL checks (plain Node)
node scripts/verify-placement.js              # widget placement and screen-edge anchor checks (plain Node)
node --check path/to/file.js                  # syntax check
```

- There is no linter, formatter, test framework or `npm test`. `scripts/check.js` runs the static checks that CI runs: syntax (inline `<script>` blocks included), JSON, and secrets. `scripts/verify-ics.js`, `scripts/verify-gmail.js` and `scripts/verify-placement.js` are the only committed tests. Run `verify-ics.js` after any change under `src/main/ics/`, `verify-gmail.js` after any change under `src/main/gmail/`, and `verify-placement.js` after any change to `src/main/placement.js`.
- `verify-ics.js` runs two suites. The first checks `test/fixtures/synthetic.ics`, a hand-written calendar of made-up events, against exact expectations for each parser invariant (see Calendar pipeline). The script pins `TZ` to America/New_York for that suite, so it gives the same result on every machine and in CI. The second checks a personal Google Calendar export in the machine's own zone: the path you pass, or else the first `*.ical.zip` in the repo root, which is gitignored. Without an export only the fixture runs. The export suite's thresholds are tuned to that export (more than 400 events, instances in April 2024, a March 2024 DST check), so a different export can fail because of the data rather than the code.
- `npm start` has no dev profile. It reads the real `calendars.local.json` and `gmail.local.json`, polls the real Gmail account, and writes the real saved state in `userData`.
- The renderers expose `window.__cal`, `window.__mail` and `window.__settings` for an external verification harness that is not in the repo. Keep these hooks when refactoring.

## Workflow

Every change starts as a GitHub issue and lands through a pull request. A repository ruleset on `main` rejects direct pushes, force pushes and deletion. A PR can merge only when its required checks pass and its review threads are resolved. The ruleset has no bypass list, so it binds the repo owner too.

1. Open an issue with `gh issue create`. Issues are public, so keep feed URLs, OAuth secrets, tokens and email contents out of them.
2. Branch from an up-to-date `main` as `<issue>-<short-slug>`. `gh issue develop <issue> --checkout` creates the branch and links it to the issue.
3. Before pushing, run `node scripts/check.js`, `node scripts/verify-ics.js` if you changed `src/main/ics/`, `node scripts/verify-gmail.js` if you changed `src/main/gmail/`, and `node scripts/verify-placement.js` if you changed `src/main/placement.js`.
4. Open the PR against `main` with `Closes #<issue>` in the description. The PR template starts with that line, so fill in the number.
5. Merge once the checks pass. GitHub closes the issue and deletes the branch.

The required checks both run on GitHub Actions:

- `checks` (`.github/workflows/ci.yml`) runs `scripts/check.js`, `scripts/verify-ics.js`, `scripts/verify-gmail.js` and `scripts/verify-placement.js`. CI has no calendar export, so `verify-ics.js` checks only the synthetic fixture there, and the export suite runs only locally.
- `linked-issue` (`.github/workflows/linked-issue.yml`) fails unless the PR closes an open issue in this repo. Editing the description re-runs it. Linking the issue from the Development sidebar doesn't, so re-run the job by hand after that.

A check's name is its job id. If you rename a job, the ruleset keeps waiting for a check that never reports, and every PR is blocked. Change the job id, `.github/rulesets/main.json` and the live ruleset together.

`.github/rulesets/main.json` is a hand-kept snapshot of the live ruleset, not its source. GitHub never reads the file and nothing compares the two, and the live ruleset also carries server defaults the file leaves out. The live ruleset is what's enforced. When you change it, update the file in the same PR; `gh api repos/{owner}/{repo}/rulesets` shows the live version.

ECC Tools and CodeQL (GitHub's default code scanning setup) also check each PR. Neither is a required check, so their findings are advisory.

## Architecture

### Processes and trust boundary

- `main.js` holds the `WIDGETS` registry. It creates one frameless, transparent `BrowserWindow` per widget, builds the tray menu, and forwards service updates to the matching window.
- Renderers run with `contextIsolation: true`. Their only route to the main process is `preload.js`, which exposes `widgetAPI`, `calendarAPI` and `gmailAPI`. All file and network access happens in main.
- A widget's identity never comes from the renderer. `main.js` stamps `win.__widgetId` on each window, and every handler in `src/main/ipc.js` resolves the widget from `event.sender`. `ipc.js` is the only place `ipcMain` handlers are registered. No preload method takes a widget id, so one widget can't read or change another's state. Keep it that way.
- `widgetAPI` deliberately has no settings setter. Settings change only through the main-process context menu.
- A new IPC channel needs three edits: the handler in `src/main/ipc.js`, the bridge in `preload.js`, and the call in the renderer. Main pushes to renderers with `webContents.send` on `widget:settings-changed`, `widget:work-area-changed`, `calendar:updated` and `gmail:updated`.

### Persisted state and appearance settings

- `src/main/store.js` owns the only state file, `widget-positions.json` in Electron `userData` (`%APPDATA%\desktop-widgets\`). The file name is historical, and renaming it would lose saved positions. Its shape is `{ [widgetId]: { anchor, w, h, pinned, settings } }`; see Placement for `anchor`. `w` and `h` are read only on an axis the widget measures (`fits` in `WIDGETS`). Writes are debounced by 250 ms and flushed on `before-quit`. `patch()` merges only one level deep, so always write the whole `settings` object through `settings.setSetting()`.
- `src/main/settings.js` holds three things: the catalogue of allowed values (backgrounds, opacity steps, sizes), a reader that sanitises stored values, and `composeFor(id)`, which turns the settings into CSS values. After every change, main pushes the composed payload (`ipc.pushSettings`). `widgets/shared/settings.js` applies it as CSS custom properties on `<html>`. `CAPABILITIES` decides which menu items each widget gets; only the clock offers Size. The module is separate from `main.js` to avoid a require cycle.
- Background presets are dark-only on purpose. The calendar's chrome is hard-coded white-on-dark.

### Context menu and window activation

- `src/main/menu.js` needs two triggers. Windows delivers a right-click on a `-webkit-app-region: drag` area as a non-client message that Chromium never sees, so only the window's `system-context-menu` event fires there. Right-clicks on `no-drag` areas go through the `webContents` `context-menu` event, and so do all right-clicks on a pinned widget, because `html.pos-locked` makes the whole body `no-drag`. `popup()` ignores a second popup within 300 ms and opens at the cursor.
- Keep widget windows activatable. `focusable: false` (the `WS_EX_NOACTIVATE` window style) was tried to stop Windows bringing widgets to the front whenever it picks a new foreground window. It broke the context menu: the menu no longer closed on an outside click, and forcing `focus()` made taskbar buttons flash. The surfacing problem is still unsolved. Any fix must leave window activation alone.

### Placement

- A saved position is an anchor, not a coordinate: the widget's distance from the nearer horizontal and the nearer vertical edge of its display's work area, e.g. `{ display: 1879209626, fingerprint: 'internal:1920x1080', right: 8, top: 15 }`. Absolute coordinates broke on a laptop that Windows runs at 100% on one GPU and 125% on the other: the desktop is 1920 DIP wide in one session and 1536 in the next, so a corner spot saved at one scale was off-screen at the other. An anchor keeps a corner widget in its corner at any scale. The cost: a widget near the middle anchors to whichever edge is closer, so it shifts when the screen width changes. A rect bigger than the work area anchors to its left and top, never to a negative far edge.
- `src/main/placement.js` holds the geometry, including `resize()`, and has no Electron dependency, so `scripts/verify-placement.js` tests it in plain Node. The helpers that read and write the store live in `src/main/ipc.js`: `initialBounds`, `place`, `startDrag`, `rememberPosition` and `resetPosition`.
- Every placement moves the window inside a work area, flush against an edge if need be. A window bigger than the work area keeps its top-left corner on screen and hangs off the right or bottom. Placement happens when a window is created, on `display-metrics-changed`/`-added`/`-removed`, whenever Windows moves or resizes a widget on its own (its per-window DPI resize can arrive well after the display event, so each window's `'move'`/`'resize'` re-places it), before tray Show and Show All, and on tray Reset Positions. Pinned widgets are placed too, because `setMovable(false)` blocks only user drags, not `setBounds()`.
- Placement never re-applies a position read back from the window. At 125% most DIP values fall between whole pixels, so `getBounds()` can come back a DIP off (y 15 as 14), and re-applying what it returns makes the error accumulate. Positions and sizes are always computed from saved values. The window is read only to compare it within `DRIFT` (2 DIP) and, at the end of a drag, for where it was dropped. The budget a renderer gets (`workAreaFor`) comes from the anchor's display, the same one `applySize()` caps against.
- A user drag runs from `'will-move'` to `'moved'`; neither fires for `setBounds()`. While it runs, placement leaves the window alone and `applySize()` only saves the size. Three things write an anchor: the end of a drag that moved the widget, a resize that moves the widget's vertical edge (see Self-sizing), and the one-time conversion below. Tray Reset Positions clears the anchor, so the widget takes the registry default, as a widget that was never moved does. A drop partly off-screen is pulled back on. When an anchor's display id is missing, the widget goes to the one display with the anchor's fingerprint (physical size, built-in or external: Windows can renumber a monitor), and otherwise to the primary. The anchor keeps the original id, so the widget goes back when that display returns.
- A state entry with `x`/`y` and no `anchor` comes from an older build. `initialBounds()` converts its absolute `x`/`y` once, at the size `sizeFor()` gives, which ignores the width that build saved for the calendar.

### Self-sizing

- Widgets size their own windows. `widgets/shared/autosize.js` watches `.card` with a `ResizeObserver` and sends `widget:request-size`. `ipc.applySize()` caps the request at 45% of the display work area's height and 35% of its width. Width grows away from the anchored horizontal edge, so a clock in a right-hand corner stays in it. Height grows down from the current top, and the window moves up only as far as it must to stay on screen, so the calendar's header and grid hold still under the cursor while its events panel opens and closes. The vertical edge is then picked again and saved. `applySize()` applies and saves only the axes named in the widget's `fits` in `WIDGETS`, so the next launch opens at the fitted size. Any other axis stays at its registry size.
- Three guards prevent resize loops: the renderer ignores changes of 1 px or less, main skips requests that change nothing, and main accepts at most 10 requests per second. Keep all three. `MIN_SIZE` and `MIN_CAP` reproduce the earlier floors exactly; don't "tidy" them.
- Main sends `widget:work-area-changed` only when a widget's budget changed, because the calendar rebuilds its events list on each one, which scrolls the list back to the top.
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
- Anchor all-day dates to local midnight. An all-day DTEND is exclusive. Count all-day lengths in calendar days, never in milliseconds, because a DST day has 23 or 25 hours. A missing DTEND means one day, a `P<n>D` DURATION means n days, and each instance of a series lasts as many days as its master.
- Match EXDATE and RECURRENCE-ID by local calendar day, not by exact instant.
- COUNT counts from DTSTART, so a COUNT rule can't skip ahead to the requested window.
- The RRULE engine is deliberately narrow: WEEKLY and YEARLY, plus basic DAILY and MONTHLY.
- Times display in the machine's current timezone. That is correct conversion, not a bug. There is no configured display timezone.

`test/fixtures/synthetic.ics` has at least one case for each invariant, and `verify-ics.js` checks them in CI, so breaking one fails the `checks` job. When you change an invariant or add one, update the fixture and its expectations in the same PR. Keep the fixture made up: no real events, names or addresses. Use `example.com` addresses and `@fixture.invalid` UIDs. The fixture is checked out with CRLF line endings (`.gitattributes`), as real feeds have.

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
- Message ids come out of an API response. `urls.js` builds every request URL, and an id goes into one only after `isMessageId()` accepts it.
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
2. Add `{ id, file, width, height, defaultX, defaultY, fits }` to `WIDGETS` in `main.js`. `defaultX`/`defaultY` are distances from the left and top of the primary display's work area. `fits` is `'both'`, `'height'` or left out, matching the axes the widget passes to `widgetAutosize`.
3. Add a `CAPABILITIES` entry in `src/main/settings.js`. Without one, the widget gets no Size option.

## Secrets and local data

- These files are gitignored and must stay that way:
  - `calendars.local.json`: a secret iCal URL gives anyone who holds it permanent read access to that calendar.
  - `gmail.local.json`: the OAuth client ID and secret.
  - `*.ical.zip` and `*.ics`: personal calendar exports. The exception is `.ics` files in `test/fixtures/`, which hold only made-up events. `.gitignore` and `scripts/check.js` both allow that folder.
- The committed templates are `calendars.example.json` and `gmail.example.json`.
- A feed URL must never reach a log line, a renderer or a filename. Error messages from `net` include the URL, so pass every message through `feed.redact()` or `auth.redact()` (which also masks long tokens). Cache files are named from the validated config `id`, never from the URL.
- Secret scanning and push protection are on, so GitHub rejects a push that contains a known token format. Don't bypass the rejection. Remove the secret from the branch's commits instead; it never reached GitHub, so there is nothing to rotate.
- CI's `checks` job fails when a gitignored credential file is committed anyway, or when a file contains a secret calendar address or a Google OAuth secret or token. The check runs after the push, so on this public repo a hit means the value is already exposed. Rotate it by resetting the calendar's secret address or the OAuth client secret. Deleting the commit doesn't revoke it.
- GitHub Pages publishes `docs/` from `main`, so merging a PR that touches `docs/` makes the change live. The site includes the privacy policy (`docs/privacy.md`) used for Google OAuth publishing. Update it when scopes or stored data change.

## Conventions

- CommonJS with no transpiling. Having no runtime dependencies is deliberate, so prefer Node and Electron built-ins. Use Electron's `net` rather than `https`, because `net` uses the system proxy and certificate store.
- Comments explain why: platform quirks, constraints, rejected approaches. Keep that level of commenting when editing nearby code.
- Commit subjects are imperative and describe the behaviour, e.g. "Carry the selected day across midnight". Commit bodies explain the reasoning and how the change was verified.

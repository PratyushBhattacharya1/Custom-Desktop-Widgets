# Desktop Widgets

Draggable, borderless desktop widgets (clock, calendar, email preview) built with Electron + plain HTML/CSS/JS.

## Run it

```bash
npm install
npm start
```

Three widgets appear on screen. Drag a widget by its background to move it — the position is saved automatically and restored next launch.

A tray icon (bottom-right of the taskbar) lets you show/hide individual widgets, show/hide all, and quit.

## Pinning a widget in place

Every widget has a **pin button** in its top-right corner.

- Click the unhighlighted pin → the widget locks in place and can no longer be dragged; the pin highlights blue.
- Click the highlighted pin → dragging is re-enabled.

The pinned state is saved per widget and survives restarts.

## Connecting your calendars

The calendar widget reads **read-only iCal feeds**, so it stays current without any manual export.

1. Copy the template:
   ```bash
   cp calendars.example.json calendars.local.json
   ```
2. In Google Calendar, go to **Settings → Settings for my calendars → _(pick a calendar)_ → Integrate calendar**, and copy the **"Secret address in iCal format"** URL.
3. Paste it into the matching `url` field in `calendars.local.json`.

The UAE and US holiday calendars are already filled in with public URLs and work out of the box.

> **`calendars.local.json` is gitignored and must stay that way.** A secret iCal URL is credential-equivalent: anyone holding one can read that calendar indefinitely. The app never logs these URLs, never sends them to a widget, and never puts them in a filename.

Each entry takes:

| Field | Meaning |
|---|---|
| `id` | Stable key, `[a-z0-9_-]`. Also names the offline cache file. |
| `name` | Display name, shown when hovering an event. |
| `url` | The secret iCal URL (must be `https://`). |
| `color` | `#rrggbb` — the outline color for that calendar's events. |
| `enabled` | Set `false` to skip a calendar without deleting it. |

Feeds refresh every 60 minutes (configurable via `refreshMinutes`), on wake from sleep, and are cached to disk so the widget still works offline. A small amber dot next to the month label means you're seeing cached data.

### Using the calendar

- **Week starts Monday.** Today is always filled blue; the selected day gets a blue outline.
- **Click a day** to see its events below the grid. The widget grows and shrinks to fit, up to 45% of your monitor's work area, then scrolls.
- **Chevrons** change month (up = previous, down = next). Navigating clears the selection and collapses the events panel.
- **"Today"** jumps back to the present day from anywhere.
- **Click the month/year label** to open a month picker; its chevrons step the year (1926–2099).

## How it's structured

```
main.js                     app lifecycle, windows, tray
preload.js                  contextBridge API for the renderers
src/main/store.js           per-widget position + pinned state
src/main/ipc.js             all ipcMain handlers, incl. self-resize
src/main/calendar/          config, feed fetching/caching, month expansion
src/main/ics/               zero-dependency iCalendar parser + recurrence
widgets/shared/             tokens, pin button, shared scrollbar
widgets/<name>/index.html   one self-contained widget each
scripts/verify-ics.js       offline parser regression harness
```

Renderers are sandboxed with `contextIsolation`, so all file and network access happens in the main process and crosses to widgets over IPC. A widget's identity is resolved from the IPC sender, never from anything the renderer sends, so one widget cannot read or modify another's state.

### The iCalendar parser

Hand-rolled with no dependencies. It handles the things real Google exports actually contain: line folding that splits mid-parameter, quoted parameter values, `\,`/`\;`/`\n` escaping, all three DTSTART forms, exclusive all-day DTENDs, `RRULE` (weekly/yearly), `EXDATE`, and `RECURRENCE-ID` overrides matched by calendar day. Timezone conversion uses `Intl.DateTimeFormat` — recurrences expand in the event's own wall-clock zone so a weekly 8 AM class doesn't drift an hour across a DST change.

**Times are shown in your machine's current timezone**, converted from each event's own `TZID`. A class scheduled for 8 AM Los Angeles displays as 8 PM when your machine is set to Dubai, and shifts by an hour when one zone changes for DST and the other doesn't — the same behaviour Google Calendar shows for the same event. This is correct conversion, not a bug; there is no fixed or configured display timezone anywhere in the code.

Run the regression harness against a Google Calendar export (`.zip` or `.ics`):

```bash
node scripts/verify-ics.js path/to/export.zip
```

## Add a new widget

1. Create `widgets/my-widget/index.html`, linking the shared assets:
   ```html
   <link rel="stylesheet" href="../shared/widget.css" />
   <script src="../shared/pin.js"></script>
   ```
2. Wrap your content in `<div class="card">` — the pin button attaches to it automatically.
3. Add an entry to the `WIDGETS` array in `main.js`:
   ```js
   { id: 'my-widget', file: 'widgets/my-widget/index.html', width: 300, height: 200, defaultX: 100, defaultY: 100 }
   ```
4. Give any clickable element `-webkit-app-region: no-drag` so it stays clickable.

## Wiring up real email

The email widget is still a placeholder. To show real messages:
- **Gmail**: Gmail API with OAuth2 (`googleapis`), fetched in the main process and sent to the widget via `webContents.send`
- **Outlook/Microsoft 365**: Microsoft Graph API, same shape

Both need an app registration and an OAuth consent flow.

## Known limitations

- An event crossing local midnight shows an end time earlier than its start.
- Google Tasks are not available in any iCal feed, so there is no task section.
- Google's iCal export carries no color information, which is why colors are assigned per calendar in config rather than per event.

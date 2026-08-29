# Desktop Widgets

Draggable, borderless desktop widgets (clock, calendar, email preview) built with Electron + plain HTML/CSS/JS.

## Run it

```bash
npm install
npm start
```

Three widgets will appear on screen. Click and drag anywhere on a widget to move it — its new position is saved automatically to a local JSON file, so it'll reopen in the same spot next time.

## How it's structured

- `main.js` — creates one `BrowserWindow` per widget (frameless, transparent, no taskbar entry) and persists window positions
- `preload.js` — empty bridge, ready for future IPC calls (e.g. real email data)
- `widgets/<name>/index.html` — each widget is a self-contained HTML/CSS/JS page

## Add a new widget

1. Create `widgets/my-widget/index.html`
2. Add an entry to the `WIDGETS` array in `main.js`:
   ```js
   { id: 'my-widget', file: 'widgets/my-widget/index.html', width: 300, height: 200, defaultX: 100, defaultY: 100 }
   ```
3. Give the widget's root element `-webkit-app-region: drag` in CSS so it's draggable (add `-webkit-app-region: no-drag` to any buttons/inputs inside so they stay clickable).

## Wiring up real email

The email widget is currently a placeholder. To show real messages:
- **Gmail**: use the Gmail API with OAuth2 (`googleapis` npm package), fetch from the main process, and send results to the widget window via `webContents.send`
- **Outlook/Microsoft 365**: use Microsoft Graph API similarly

Both require registering an app with the provider and handling an OAuth consent flow — happy to build either one out if you tell me which inbox you use.

## Making widgets stay pinned even when other windows are on top of them

Right now widgets behave like normal windows (they can be covered by other apps). Two options if you want different behavior:
- Set `alwaysOnTop: true` in `main.js` to keep widgets above everything
- To truly pin widgets to the desktop layer (visible even when apps are maximized, like Rainmeter does), Windows requires attaching the window to the hidden `WorkerW` handle behind desktop icons. This needs a native call (`SetParent`), which isn't exposed by plain Electron — packages like `electget` or `electron-as-wallpaper` implement this if you want to go that route.

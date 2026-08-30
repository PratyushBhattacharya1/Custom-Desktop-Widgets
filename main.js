const { app, BrowserWindow, Menu, Tray, screen } = require('electron');
const path = require('path');
const store = require('./src/main/store');
const ipc = require('./src/main/ipc');
const widgetMenu = require('./src/main/menu');
const calendarService = require('./src/main/calendar/service');
const gmailService = require('./src/main/gmail/service');

// ---- Add / remove widgets here ----
const WIDGETS = [
  { id: 'clock', file: 'widgets/clock/index.html', width: 260, height: 260, defaultX: 60, defaultY: 60 },
  { id: 'calendar', file: 'widgets/calendar/index.html', width: 320, height: 340, defaultX: 360, defaultY: 60 },
  { id: 'email', file: 'widgets/email/index.html', width: 360, height: 300, defaultX: 60, defaultY: 360 },
];

const windows = {};
let tray = null;

function createWidget(widget) {
  const saved = store.get(widget.id);

  const win = new BrowserWindow({
    // Saved size wins over the registry default, so a fitted widget reopens at
    // the size it settled on rather than snapping after the first measurement.
    width: Number.isFinite(saved.w) ? saved.w : widget.width,
    height: Number.isFinite(saved.h) ? saved.h : widget.height,
    x: Number.isFinite(saved.x) ? saved.x : widget.defaultX,
    y: Number.isFinite(saved.y) ? saved.y : widget.defaultY,
    frame: false,          // no title bar / borders
    transparent: true,     // lets rounded/irregular widget shapes show through
    resizable: false,      // no drag-to-resize; the calendar resizes itself via setBounds
    hasShadow: false,
    skipTaskbar: true,     // don't clutter the taskbar with widgets
    alwaysOnTop: false,    // normal z-order — widgets behave like ordinary windows
    // Widgets are never a place you type, and being activatable made Windows
    // hand them the foreground whenever it had to pick a window — closing an
    // app, switching virtual desktops, opening a file dialog — which surfaced
    // them over whatever was in front. Mouse input is unaffected; only OS
    // keyboard focus is given up.
    focusable: false,
    show: false,           // shown on ready-to-show to avoid a flash of unpositioned content
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  // Identifies this window to IPC handlers, which resolve it from event.sender.
  // The renderer never sends its own id, so one widget can't act on another.
  win.__widgetId = widget.id;
  win.setMenuBarVisibility(false);
  win.loadFile(widget.file);

  // A widget saved as pinned comes back immovable.
  if (saved.pinned) win.setMovable(false);

  // Right-click settings. Both paths are needed — see src/main/menu.js.
  widgetMenu.attach(win);

  win.once('ready-to-show', () => win.show());

  // Keep the tray checkboxes honest: they read isVisible() at build time, so the
  // menu has to be rebuilt whenever visibility actually changes.
  win.on('show', refreshTray);
  win.on('hide', refreshTray);

  // setBounds() can emit 'moved' on Windows even when x/y are unchanged, so only
  // write when the position actually differs. store.patch is itself debounced.
  win.on('moved', () => {
    const [x, y] = win.getPosition();
    const prev = store.get(widget.id);
    if (prev.x === x && prev.y === y) return;
    store.patch(widget.id, { x, y });
    notifyWorkArea(win);
  });

  windows[widget.id] = win;
}

function widgetLabel(id) {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function buildTrayMenu() {
  const toggleItems = WIDGETS.map((widget) => {
    const win = windows[widget.id];
    return {
      label: widgetLabel(widget.id),
      type: 'checkbox',
      checked: win ? win.isVisible() : false,
      // Toggle off the window's real state rather than the menu item's, so a
      // stale tick can never invert the action.
      click: () => {
        if (!win) return;
        if (win.isVisible()) win.hide();
        else win.show();
      },
    };
  });

  return Menu.buildFromTemplate([
    { label: 'Widgets', enabled: false },
    ...toggleItems,
    { type: 'separator' },
    { label: 'Show All', click: () => Object.values(windows).forEach((w) => w.show()) },
    { label: 'Hide All', click: () => Object.values(windows).forEach((w) => w.hide()) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

// Menus are immutable once built, so resyncing the checkboxes means rebuilding.
function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  tray = new Tray(path.join(__dirname, 'assets', 'tray-icon.png'));
  tray.setToolTip('Desktop Widgets');
  refreshTray();
}

// Tells a widget which display it's on, so it can recompute its height budget.
function notifyWorkArea(win) {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send('widget:work-area-changed', ipc.workAreaFor(win));
}

function notifyAllWorkAreas() {
  Object.values(windows).forEach(notifyWorkArea);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  ipc.register();
  WIDGETS.forEach((w) => createWidget(w));
  createTray();

  calendarService.init(__dirname);
  calendarService.onUpdated((payload) => {
    const cal = windows.calendar;
    if (cal && !cal.isDestroyed() && !cal.webContents.isDestroyed()) {
      cal.webContents.send('calendar:updated', payload);
    }
  });

  gmailService.init();
  gmailService.onUpdated(() => {
    const mail = windows.email;
    if (mail && !mail.isDestroyed() && !mail.webContents.isDestroyed()) {
      mail.webContents.send('gmail:updated', gmailService.getState());
    }
  });

  screen.on('display-metrics-changed', notifyAllWorkAreas);
  screen.on('display-added', notifyAllWorkAreas);
  screen.on('display-removed', notifyAllWorkAreas);
});

// Don't lose a debounced write if the app exits mid-timer.
app.on('before-quit', () => store.flush());

app.on('window-all-closed', () => {
  // Widgets are meant to run headless in the tray; closing a window shouldn't quit the app.
});

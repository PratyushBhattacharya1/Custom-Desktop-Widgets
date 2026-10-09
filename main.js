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
  // The saved anchor, fitted to today's displays, so a widget can't open
  // off-screen after the display layout or scale changed. A saved size still
  // wins over the registry default, so a fitted widget reopens at the size it
  // settled on rather than snapping after the first measurement.
  const bounds = ipc.initialBounds(widget.id);
  const saved = store.get(widget.id);

  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    frame: false,          // no title bar / borders
    transparent: true,     // lets rounded/irregular widget shapes show through
    resizable: false,      // no drag-to-resize; the calendar resizes itself via setBounds
    hasShadow: false,
    skipTaskbar: true,     // don't clutter the taskbar with widgets
    alwaysOnTop: false,    // normal z-order — widgets behave like ordinary windows
    // NOTE: focusable:false was tried here to stop Windows handing widgets the
    // foreground when it picks a window (closing an app, switching desktops).
    // It broke the context menu instead: WS_EX_NOACTIVATE means the owner can
    // never be the foreground window, and Windows only dismisses a popup menu
    // when its owner is foreground. Forcing it with focus() is refused for a
    // process without foreground rights, and Windows answers that refusal by
    // flashing taskbar buttons. Correct menus beat occasional surfacing.
    show: false,           // shown on ready-to-show to avoid a flash of unpositioned content
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  // Identifies this window to IPC handlers, which resolve it from event.sender.
  // The renderer never sends its own id, so one widget can't act on another.
  win.__widgetId = widget.id;
  // At 125% the constructor comes out 3-4 DIP larger than asked (260x260 opens
  // as 264x264) while setBounds() lands within a DIP. The email widget never
  // measures itself, so without this it would keep the inflated size.
  ipc.place(win);
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

  // 'moved' fires when a drag ends, and also when a click on the drag strip ends
  // without moving anything; rememberPosition tells the two apart. setBounds()
  // fires 'move' but never 'moved', so placing a widget doesn't land here.
  win.on('moved', () => {
    ipc.rememberPosition(win);
    notifyWorkArea(win);
  });

  windows[widget.id] = win;
}

function widgetLabel(id) {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

// The displays may have changed while a widget was hidden, so place it first.
function showWidget(win) {
  ipc.place(win);
  win.show();
}

// The escape hatch for a widget that ends up somewhere unhelpful, pinned or not.
function resetPositions() {
  Object.values(windows).forEach((win) => ipc.resetPosition(win));
  notifyAllWorkAreas();
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
        else showWidget(win);
      },
    };
  });

  return Menu.buildFromTemplate([
    { label: 'Widgets', enabled: false },
    ...toggleItems,
    { type: 'separator' },
    { label: 'Show All', click: () => Object.values(windows).forEach((w) => showWidget(w)) },
    { label: 'Hide All', click: () => Object.values(windows).forEach((w) => w.hide()) },
    { label: 'Reset Positions', click: resetPositions },
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

// Windows can resize and rescale every display under the widgets: a GPU switch
// can flip a laptop panel between 100% and 125%, and a monitor can vanish.
// Re-place each widget from its anchor, then send it the budget for the
// display it ended up on.
function placeAll() {
  Object.values(windows).forEach((win) => ipc.place(win));
  notifyAllWorkAreas();
}

// Windows resizes each window for a new DPI with a message of its own, which
// can arrive after this event and push a widget off its anchor. So place again
// once things settle; place() is a no-op for a widget already where it belongs.
let settleTimer = null;
function onDisplaysChanged() {
  placeAll();
  clearTimeout(settleTimer);
  settleTimer = setTimeout(placeAll, 500);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  ipc.register(WIDGETS);
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

  screen.on('display-metrics-changed', onDisplaysChanged);
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
});

// Don't lose a debounced write if the app exits mid-timer.
app.on('before-quit', () => store.flush());

app.on('window-all-closed', () => {
  // Widgets are meant to run headless in the tray; closing a window shouldn't quit the app.
});

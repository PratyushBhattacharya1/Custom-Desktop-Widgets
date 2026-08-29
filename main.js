const { app, BrowserWindow, Menu, Tray } = require('electron');
const path = require('path');
const fs = require('fs');

// Where we persist each widget's x/y position between runs
const configPath = path.join(app.getPath('userData'), 'widget-positions.json');

function loadPositions() {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return {};
  }
}

function savePositions(positions) {
  fs.writeFileSync(configPath, JSON.stringify(positions, null, 2));
}

// ---- Add / remove widgets here ----
const WIDGETS = [
  { id: 'clock', file: 'widgets/clock/index.html', width: 260, height: 260, defaultX: 60, defaultY: 60 },
  { id: 'calendar', file: 'widgets/calendar/index.html', width: 320, height: 340, defaultX: 360, defaultY: 60 },
  { id: 'email', file: 'widgets/email/index.html', width: 360, height: 300, defaultX: 60, defaultY: 360 },
];

const windows = {};
let tray = null;

function createWidget(widget, positions) {
  const saved = positions[widget.id];

  const win = new BrowserWindow({
    width: widget.width,
    height: widget.height,
    x: saved ? saved.x : widget.defaultX,
    y: saved ? saved.y : widget.defaultY,
    frame: false,          // no title bar / borders
    transparent: true,     // lets rounded/irregular widget shapes show through
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,     // don't clutter the taskbar with widgets
    alwaysOnTop: false,    // normal z-order — widgets behave like ordinary windows
    show: false,           // shown on ready-to-show to avoid a flash of unpositioned content
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  win.__widgetId = widget.id;
  win.setMenuBarVisibility(false);
  win.loadFile(widget.file);

  win.once('ready-to-show', () => win.show());

  // Keep the tray checkboxes honest: they read isVisible() at build time, so the
  // menu has to be rebuilt whenever visibility actually changes.
  win.on('show', refreshTray);
  win.on('hide', refreshTray);

  // Debounced save so we're not writing to disk on every pixel of movement
  let saveTimeout;
  win.on('moved', () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      const [x, y] = win.getPosition();
      const positions = loadPositions();
      positions[widget.id] = { x, y };
      savePositions(positions);
    }, 250);
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

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  const positions = loadPositions();
  WIDGETS.forEach((w) => createWidget(w, positions));
  createTray();
});

app.on('window-all-closed', () => {
  // Widgets are meant to run headless in the tray; closing a window shouldn't quit the app.
});

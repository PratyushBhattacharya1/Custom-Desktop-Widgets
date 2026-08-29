// Every ipcMain handler lives here.
//
// Widget identity is always resolved from `event.sender`, never from a value the
// renderer supplies — so one widget can't read or mutate another's state.
const { ipcMain, BrowserWindow, screen } = require('electron');
const store = require('./store');
const settings = require('./settings');
const calendarService = require('./calendar/service');

function windowFor(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

// Fraction of the display's work area the calendar is allowed to occupy.
const MAX_HEIGHT_FRACTION = 0.45;

function workAreaFor(win) {
  const [x, y] = win.getPosition();
  const display = screen.getDisplayNearestPoint({ x, y });
  return {
    width: display.workArea.width,
    height: display.workArea.height,
    maxWidgetHeight: Math.round(display.workArea.height * MAX_HEIGHT_FRACTION),
  };
}

function register() {
  ipcMain.handle('widget:get-pinned', (event) => {
    const win = windowFor(event);
    if (!win) return false;
    return Boolean(store.get(win.__widgetId).pinned);
  });

  ipcMain.handle('widget:set-pinned', (event, pinned) => {
    const win = windowFor(event);
    if (!win) return false;
    return setPinned(win, pinned);
  });

  ipcMain.handle('widget:get-settings', (event) => {
    const win = windowFor(event);
    if (!win) return null;
    return settings.composeFor(win.__widgetId);
  });

  ipcMain.handle('widget:get-work-area', (event) => {
    const win = windowFor(event);
    if (!win) return null;
    return workAreaFor(win);
  });

  ipcMain.on('widget:request-height', (event, height) => {
    const win = windowFor(event);
    if (!win) return;
    applyHeight(win, height);
  });

  // --- calendar ---
  ipcMain.handle('calendar:get-month', (_event, payload) => {
    const year = Number(payload && payload.year);
    const month = Number(payload && payload.month);
    if (!Number.isInteger(year) || !Number.isInteger(month)) return null;
    return calendarService.getMonth(year, month);
  });

  ipcMain.handle('calendar:refresh', async () => calendarService.refresh());
}

// --- helpers the context menu drives, kept here so store writes live in one place ---

function setPinned(win, pinned) {
  const value = Boolean(pinned);
  store.patch(win.__widgetId, { pinned: value });
  win.setMovable(!value); // belt-and-braces: also block OS-level moves
  pushSettings(win);
  return value;
}

// Renderers apply settings live, so every mutation pushes the composed result.
function pushSettings(win) {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send('widget:settings-changed', settings.composeFor(win.__widgetId));
}

// --- height application, with the three anti-oscillation guards ---
const heightState = new WeakMap(); // win -> { last, times: [] }

function applyHeight(win, requested) {
  if (!Number.isFinite(requested)) return;

  const state = heightState.get(win) || { last: null, times: [] };
  heightState.set(win, state);

  // Guard 3: hard rate limit. A runaway renderer can't spin the main process.
  const now = Date.now();
  state.times = state.times.filter((t) => now - t < 1000);
  if (state.times.length >= 10) {
    if (!state.warned) {
      console.warn(`Height request rate limit hit for "${win.__widgetId}"; dropping.`);
      state.warned = true;
    }
    return;
  }
  state.times.push(now);

  const bounds = win.getBounds();
  const { maxWidgetHeight, height: workHeight } = workAreaFor(win);

  // Never let the widget run off the bottom of the screen: the panel's own
  // scrollbar absorbs whatever doesn't fit.
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
  const roomBelow = display.workArea.y + workHeight - bounds.y - 8;
  const cap = Math.max(120, Math.min(maxWidgetHeight, roomBelow));
  const target = Math.max(80, Math.min(Math.round(requested), cap));

  // Guard 2: main-side no-op when nothing would change.
  if (state.last === target && bounds.height === target) return;
  state.last = target;

  win.setMinimumSize(bounds.width, 1);
  win.setMaximumSize(bounds.width, 10000);
  win.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: target });
}

module.exports = { register, workAreaFor, MAX_HEIGHT_FRACTION, setPinned, pushSettings };

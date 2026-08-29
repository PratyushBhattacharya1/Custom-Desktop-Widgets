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

// Fractions of the display's work area a widget is allowed to occupy.
const MAX_HEIGHT_FRACTION = 0.45;
const MAX_WIDTH_FRACTION = 0.35;

// Floors. MIN_SIZE bounds the target, MIN_CAP bounds the cap, so a widget near
// a screen edge still has room to be useful. The height pair reproduces the
// original Math.max(80,...)/Math.max(120,...) exactly — don't "tidy" it or the
// calendar's clamping changes.
const MIN_SIZE = { w: 120, h: 80 };
const MIN_CAP = { w: 160, h: 120 };

function workAreaFor(win) {
  const [x, y] = win.getPosition();
  const display = screen.getDisplayNearestPoint({ x, y });
  return {
    width: display.workArea.width,
    height: display.workArea.height,
    maxWidgetHeight: Math.round(display.workArea.height * MAX_HEIGHT_FRACTION),
    maxWidgetWidth: Math.round(display.workArea.width * MAX_WIDTH_FRACTION),
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

  ipcMain.on('widget:request-size', (event, size) => {
    const win = windowFor(event);
    if (!win) return;
    applySize(win, size);
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

// --- size application, with the three anti-oscillation guards ---
//
// A missing axis means "leave it alone", which is what lets the calendar keep
// sending height only and stay byte-identical.
const sizeState = new WeakMap(); // win -> { last: {w, h}, times: [], warned }

function applySize(win, requested) {
  const wantW = requested && Number.isFinite(requested.width) ? Math.round(requested.width) : null;
  const wantH = requested && Number.isFinite(requested.height) ? Math.round(requested.height) : null;
  if (wantW === null && wantH === null) return;

  const state = sizeState.get(win) || { last: { w: null, h: null }, times: [], warned: false };
  sizeState.set(win, state);

  // Guard 3: hard rate limit, shared across both axes so a widget oscillating
  // in width and height still can't spin the main process.
  const now = Date.now();
  state.times = state.times.filter((t) => now - t < 1000);
  if (state.times.length >= 10) {
    if (!state.warned) {
      console.warn(`Size request rate limit hit for "${win.__widgetId}"; dropping.`);
      state.warned = true;
    }
    return;
  }
  state.times.push(now);

  const bounds = win.getBounds();
  const budget = workAreaFor(win);
  const display = screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });

  // Never let a widget run off the bottom or the right: the calendar's own
  // scrollbar absorbs whatever doesn't fit.
  const roomBelow = display.workArea.y + budget.height - bounds.y - 8;
  const roomRight = display.workArea.x + budget.width - bounds.x - 8;
  const capH = Math.max(MIN_CAP.h, Math.min(budget.maxWidgetHeight, roomBelow));
  const capW = Math.max(MIN_CAP.w, Math.min(budget.maxWidgetWidth, roomRight));

  const targetH = wantH === null ? bounds.height : Math.max(MIN_SIZE.h, Math.min(wantH, capH));
  const targetW = wantW === null ? bounds.width : Math.max(MIN_SIZE.w, Math.min(wantW, capW));

  // Guard 2: main-side no-op when nothing would change.
  if (state.last.w === targetW && state.last.h === targetH &&
      bounds.width === targetW && bounds.height === targetH) return;
  state.last = { w: targetW, h: targetH };

  win.setMinimumSize(1, 1);
  win.setMaximumSize(10000, 10000);
  win.setBounds({ x: bounds.x, y: bounds.y, width: targetW, height: targetH });

  // Remember it so the next launch opens at the fitted size instead of the
  // registry default and then visibly snapping once the renderer measures.
  store.patch(win.__widgetId, { w: targetW, h: targetH });
}

module.exports = {
  register, workAreaFor, applySize,
  MAX_HEIGHT_FRACTION, MAX_WIDTH_FRACTION, MIN_SIZE, MIN_CAP,
  setPinned, pushSettings,
};

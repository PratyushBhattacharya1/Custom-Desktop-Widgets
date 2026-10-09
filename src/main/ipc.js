// Every ipcMain handler lives here.
//
// Widget identity is always resolved from `event.sender`, never from a value the
// renderer supplies — so one widget can't read or mutate another's state.
const { ipcMain, BrowserWindow, screen } = require('electron');
const store = require('./store');
const settings = require('./settings');
const placement = require('./placement');
const calendarService = require('./calendar/service');
const gmailService = require('./gmail/service');

// main.js's WIDGETS registry by id, for default sizes and positions. Handed in
// through register() because main.js requires this module, not the reverse.
let registry = {};

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

function budgetFor(display) {
  return {
    width: display.workArea.width,
    height: display.workArea.height,
    maxWidgetHeight: Math.round(display.workArea.height * MAX_HEIGHT_FRACTION),
    maxWidgetWidth: Math.round(display.workArea.width * MAX_WIDTH_FRACTION),
  };
}

function workAreaFor(win) {
  const [x, y] = win.getPosition();
  return budgetFor(screen.getDisplayNearestPoint({ x, y }));
}

function register(widgets) {
  registry = Object.fromEntries(widgets.map((w) => [w.id, w]));

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

  // --- gmail ---
  // Only rendered messages cross this boundary: no tokens, no client secret.
  ipcMain.handle('gmail:get-state', () => gmailService.getState());
  ipcMain.handle('gmail:refresh', async () => gmailService.refresh());
  ipcMain.handle('gmail:connect', async () => {
    try {
      return await gmailService.connect();
    } catch (err) {
      // The same path the menu takes. Returning err.message directly was the
      // one error string in the module that skipped redact(), and it told only
      // this caller: nothing was emitted, so the widget never heard about it.
      return gmailService.reportError(err);
    }
  });
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

// --- placement: a saved position is an anchor to screen edges (see placement.js) ---

function displays() {
  return screen.getAllDisplays();
}

function primaryId() {
  return screen.getPrimaryDisplay().id;
}

// The registry position, as an anchor on the primary display.
function defaultAnchor(id) {
  const widget = registry[id];
  return { display: primaryId(), left: widget.defaultX, top: widget.defaultY };
}

function anchorFor(id) {
  const saved = store.get(id).anchor;
  return placement.isAnchor(saved) ? saved : defaultAnchor(id);
}

// An axis the widget fits to its content comes from the store. Any other axis
// stays at the registry size and is never read back off the window. At 125% a
// setBounds/getBounds round trip can be off by a DIP, and re-applying the
// read-back width on every height request walked the calendar from 320 to 324
// in a replay, with x and y creeping as well.
function sizeFor(id) {
  const saved = store.get(id);
  const widget = registry[id];
  return {
    width: Number.isFinite(saved.w) ? saved.w : widget.width,
    height: Number.isFinite(saved.h) ? saved.h : widget.height,
  };
}

function boundsFor(id) {
  return placement.fromAnchor(anchorFor(id), sizeFor(id), displays(), primaryId());
}

// Bounds for a widget about to be created.
//
// An entry with no anchor was written by an older build. Its x/y are absolute
// coordinates, so they become an anchor. Its w/h are dropped: that build saved
// whatever width the window had even for a widget that never measured one,
// which left the calendar reopening at 274 px around its 320 px card. Widgets
// that do measure themselves refit within a frame, around their anchor.
function initialBounds(id) {
  const saved = store.get(id);
  if (!placement.isAnchor(saved.anchor)) {
    const widget = registry[id];
    const anchor = Number.isFinite(saved.x) && Number.isFinite(saved.y)
      ? placement.anchorFromRect({
        x: saved.x,
        y: saved.y,
        width: Number.isFinite(saved.w) ? saved.w : widget.width,
        height: Number.isFinite(saved.h) ? saved.h : widget.height,
      }, displays())
      : defaultAnchor(id);
    // Undefined drops a key when the store serialises.
    store.patch(id, { anchor, x: undefined, y: undefined, w: undefined, h: undefined });
  }
  return boundsFor(id);
}

// Puts a window where its anchor says. Skips the setBounds when it's already
// there, because display events fire often (a taskbar auto-hiding is one).
function place(win) {
  if (!win || win.isDestroyed()) return;
  const target = boundsFor(win.__widgetId);
  if (!placement.closeTo(win.getBounds(), target)) win.setBounds(target);
}

// A drag the user just finished. Re-anchors the widget where it was dropped and
// pulls it fully onto that display. 'moved' also fires when a click on the drag
// strip ends without moving anything; re-anchoring then would move a widget
// that's on the primary only while its own monitor is unplugged, so a window
// still where its anchor puts it is left alone. (setBounds never fires 'moved'.)
function rememberPosition(win) {
  if (!win || win.isDestroyed()) return;
  const id = win.__widgetId;
  const [x, y] = win.getPosition();
  const dropped = { x, y, ...sizeFor(id) };
  if (placement.closeTo(dropped, boundsFor(id))) return;
  store.patch(id, { anchor: placement.anchorFromRect(dropped, displays()) });
  place(win);
}

// Back to the registry position. Pin state stays: once the widget is on screen,
// its context menu can unlock it.
function resetPosition(win) {
  if (!win || win.isDestroyed()) return;
  store.patch(win.__widgetId, { anchor: defaultAnchor(win.__widgetId) });
  place(win);
}

// --- size application, with the three anti-oscillation guards ---
//
// A missing axis stays at its registry size (see sizeFor), which is what lets
// the calendar send height only and keep its 320 px width.
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

  // Everything below starts from the saved anchor and size, never from
  // getBounds(), so Windows' rounding can't accumulate across requests.
  const id = win.__widgetId;
  const all = displays();
  const anchor = anchorFor(id);
  const area = placement.anchorDisplay(anchor, all, primaryId()).workArea;
  const budget = budgetFor({ workArea: area });
  const size = sizeFor(id);
  const at = placement.fromAnchor(anchor, size, all, primaryId());

  // Never let a widget run off the screen: the calendar's own scrollbar absorbs
  // whatever doesn't fit. A widget grows away from its anchored edges, so its
  // room is on the far side: below one anchored to the top, above one anchored
  // to the bottom, and likewise across.
  const margin = placement.EDGE_MARGIN;
  const roomY = Number.isFinite(anchor.top)
    ? area.y + area.height - at.y - margin
    : at.y + at.height - area.y;
  const roomX = Number.isFinite(anchor.left)
    ? area.x + area.width - at.x - margin
    : at.x + at.width - area.x;
  const capH = Math.max(MIN_CAP.h, Math.min(budget.maxWidgetHeight, roomY));
  const capW = Math.max(MIN_CAP.w, Math.min(budget.maxWidgetWidth, roomX));

  const targetH = wantH === null ? size.height : Math.max(MIN_SIZE.h, Math.min(wantH, capH));
  const targetW = wantW === null ? size.width : Math.max(MIN_SIZE.w, Math.min(wantW, capW));
  const target = placement.fromAnchor(anchor, { width: targetW, height: targetH }, all, primaryId());

  // Guard 2: main-side no-op when nothing would change. The window is compared
  // within rounding, or a DIP that can never be reached would defeat the guard.
  if (state.last.w === targetW && state.last.h === targetH &&
      placement.closeTo(win.getBounds(), target)) return;
  state.last = { w: targetW, h: targetH };

  win.setMinimumSize(1, 1);
  win.setMaximumSize(10000, 10000);
  win.setBounds(target);

  // Remember what the renderer measured, so the next launch opens at the fitted
  // size instead of the registry default and then visibly snapping. Only those
  // axes: saving the calendar's unmeasured width is what kept it at 274 px.
  const fitted = {};
  if (wantW !== null) fitted.w = targetW;
  if (wantH !== null) fitted.h = targetH;
  store.patch(id, fitted);
}

module.exports = {
  register, workAreaFor, applySize,
  MAX_HEIGHT_FRACTION, MAX_WIDTH_FRACTION, MIN_SIZE, MIN_CAP,
  setPinned, pushSettings,
  initialBounds, place, rememberPosition, resetPosition,
};

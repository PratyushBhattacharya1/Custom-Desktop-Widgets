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

// main.js's WIDGETS registry by id, for default sizes and positions and the axes
// each widget fits to its content. Handed in through register() because main.js
// requires this module, not the reverse.
let registry = {};

function windowFor(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

// Fractions of the display's work area a widget is allowed to occupy.
const MAX_HEIGHT_FRACTION = 0.45;
const MAX_WIDTH_FRACTION = 0.35;

// Floors. MIN_SIZE bounds the target, MIN_CAP bounds the cap, so a widget on a
// small display still has room to be useful. The height pair reproduces the
// original Math.max(80,...)/Math.max(120,...) exactly — don't "tidy" it or the
// calendar's clamping changes.
const MIN_SIZE = { w: 120, h: 80 };
const MIN_CAP = { w: 160, h: 120 };

function budgetFor(area) {
  return {
    width: area.width,
    height: area.height,
    maxWidgetHeight: Math.round(area.height * MAX_HEIGHT_FRACTION),
    maxWidgetWidth: Math.round(area.width * MAX_WIDTH_FRACTION),
  };
}

// The budget for the display the widget's anchor puts it on: the same display
// applySize caps against, so the calendar's list and its window agree even while
// the window is somewhere else (mid-drag, or moved by Windows). Null while
// Windows reports no displays at all. roomBelow is what a list with a dragged
// limit may grow the widget to. It changes only when the widget's top moves (a
// drag, a display change, a reset), and each of those sends the new budget.
function workAreaFor(win) {
  const all = displays();
  if (!all.length) return null;
  const id = win.__widgetId;
  const anchor = anchorFor(id);
  return {
    ...budgetFor(placement.anchorDisplay(anchor, all, primaryId()).workArea),
    roomBelow: placement.roomBelow(anchor, sizeFor(id), all, primaryId()),
  };
}

// The last budget each window was given, as JSON. The calendar rebuilds its
// events list on every budget it receives, which scrolls the list back to the
// top, so main.js sends a budget only when it changed.
const toldBudgets = new WeakMap();

// The window's budget when it differs from the last one it was given, else null.
function newWorkArea(win) {
  const budget = workAreaFor(win);
  const key = JSON.stringify(budget);
  if (!budget || toldBudgets.get(win) === key) return null;
  toldBudgets.set(win, key);
  return budget;
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
    const budget = workAreaFor(win);
    if (budget) toldBudgets.set(win, JSON.stringify(budget));
    return budget;
  });

  ipcMain.on('widget:request-size', (event, size) => {
    const win = windowFor(event);
    if (!win) return;
    applySize(win, size);
  });

  // Only a widget that fits its height can hold its window open or keep a list
  // height. Any other never sends the size request that ends a hold, so its
  // window would stay stretched, and a list height would lift its cap.
  ipcMain.handle('widget:begin-resize', (event) => {
    const win = windowFor(event);
    if (!win || !fits(win.__widgetId, 'height')) return null;
    return beginResize(win);
  });

  ipcMain.handle('widget:get-list-height', (event) => {
    const win = windowFor(event);
    if (!win) return null;
    return listHeightFor(win.__widgetId);
  });

  ipcMain.handle('widget:set-list-height', (event, height) => {
    const win = windowFor(event);
    if (!win || !fits(win.__widgetId, 'height')) return;
    // Anything but a positive number clears it, and undefined drops the key
    // when the store serialises, so the list goes back to the widget's budget.
    store.patch(win.__widgetId, { listHeight: validListHeight(height) ?? undefined });
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

// Whether the widget fits this axis ('width' or 'height') to its content, per
// `fits` in main.js's WIDGETS.
function fits(id, axis) {
  const declared = registry[id].fits;
  return declared === 'both' || declared === axis;
}

// A saved size counts only on an axis the widget measures, so a width an older
// build saved for the calendar can't stick. Any other axis stays at the registry
// size and is never read back off the window. At 125% a setBounds/getBounds
// round trip can be off by a DIP, and re-applying the read-back width on every
// height request walked the calendar from 320 to 324 in a replay, with x and y
// creeping as well.
function sizeFor(id) {
  const saved = store.get(id);
  const widget = registry[id];
  return {
    width: fits(id, 'width') && Number.isFinite(saved.w) ? saved.w : widget.width,
    height: fits(id, 'height') && Number.isFinite(saved.h) ? saved.h : widget.height,
  };
}

function boundsFor(id) {
  return placement.fromAnchor(anchorFor(id), sizeFor(id), displays(), primaryId());
}

// A list height worth keeping: a positive number of DIP, else null for none.
// The one check for both what the renderer sends and what the store holds.
function validListHeight(value) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

// The most the widget's list may grow to (the calendar's events list), set by a
// drag on its grip, or null for a list limited by the widget's budget.
function listHeightFor(id) {
  return validListHeight(store.get(id).listHeight);
}

// Windows in a user drag: from 'will-move', which fires only for a move the user
// makes and never for setBounds, until 'moved'. Placement leaves them alone: a
// setBounds now would aim at the spot the drag started from, and Electron
// re-applies bounds set during a move loop when the loop ends.
const dragging = new WeakSet();

// Windows inside one of our own setBounds calls, whose 'move'/'resize' events
// must not re-enter place().
const placing = new WeakSet();

// Windows held open for a drag on the calendar's events list, from beginResize
// until the next size request, which the renderer sends when the drag ends.
// Placement leaves them alone too: putting one back at its saved size would cut
// the list off under the pointer.
const resizing = new WeakSet();

function setBounds(win, rect) {
  placing.add(win);
  try {
    win.setBounds(rect);
  } finally {
    placing.delete(win);
  }
}

function startDrag(win) {
  dragging.add(win);
}

// Bounds for a widget about to be created.
//
// An entry with x/y and no anchor was written by an older build. Its x/y are
// absolute coordinates, so they become an anchor, measured at the size sizeFor
// gives: that build also saved a width the calendar never measured (274 px
// around its 320 px card), and sizeFor ignores it. Only this conversion writes
// an anchor here. A widget with no position takes the registry default from
// anchorFor, so it keeps following the defaults and the primary display.
function initialBounds(id) {
  const saved = store.get(id);
  if (!placement.isAnchor(saved.anchor) && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const anchor = placement.anchorFromRect({ x: saved.x, y: saved.y, ...sizeFor(id) }, displays());
    // Undefined drops a key when the store serialises.
    store.patch(id, { anchor, x: undefined, y: undefined });
  }
  return boundsFor(id);
}

// Puts a window where its anchor says. Leaves a window mid-drag alone, and skips
// the setBounds when it's already there, because display events fire often (a
// taskbar auto-hiding is one) and so do the window's own 'move' and 'resize'.
function place(win) {
  if (!win || win.isDestroyed() || dragging.has(win) || resizing.has(win) || placing.has(win)) return;
  if (!displays().length) return;
  const target = boundsFor(win.__widgetId);
  if (!placement.closeTo(win.getBounds(), target)) setBounds(win, target);
}

// The end of a user drag. Re-anchors the widget where it was dropped and pulls
// it fully onto that display. A 'moved' with no 'will-move' before it isn't a
// drag, so it changes nothing. A drag that ended where it started (Esc, or
// dropped back on its spot) keeps its anchor: re-anchoring a widget parked on
// the primary while its own monitor is unplugged would leave it there for good.
function rememberPosition(win) {
  if (!win || win.isDestroyed() || !dragging.delete(win)) return;
  const all = displays();
  if (!all.length) return;
  const id = win.__widgetId;
  const [x, y] = win.getPosition();
  const dropped = { x, y, ...sizeFor(id) };
  if (!placement.closeTo(dropped, boundsFor(id))) {
    store.patch(id, { anchor: placement.anchorFromRect(dropped, all) });
  }
  // Also applies a size that arrived mid-drag.
  place(win);
}

// Back to the registry position: with no anchor saved, anchorFor supplies the
// default. Pin state stays: once the widget is on screen, its context menu can
// unlock it.
function resetPosition(win) {
  if (!win || win.isDestroyed()) return;
  store.patch(win.__widgetId, { anchor: undefined });
  place(win);
}

// The start of a drag on the calendar's events list. The window stretches down
// to the bottom of its work area and is held there, so the list can grow into it
// as fast as the pointer moves. Growing the window with a size request per
// pointer move would hit the rate limit, and the list would be cut off until the
// window caught up. Nothing is saved: the size request that ends the drag starts
// from the saved anchor and size, like any other. Returns the window's height,
// or null while Windows reports no displays.
function beginResize(win) {
  const all = displays();
  if (!all.length) return null;
  const id = win.__widgetId;
  const rect = placement.stretchDown(anchorFor(id), sizeFor(id), all, primaryId());
  if (!resizing.has(win)) {
    resizing.add(win);
    setBounds(win, rect);
  }
  return rect.height;
}

// Ends a hold that the renderer can't end itself, because it crashed, and puts
// the window back at its saved size so it doesn't stay stretched over the
// desktop.
function endResize(win) {
  if (resizing.delete(win)) place(win);
}

// --- size application, with the three anti-oscillation guards ---
//
// Only an axis the widget measures is applied or saved (see fits). Any other
// stays at its registry size, which is what lets the calendar send height only
// and keep its 320 px width.
const sizeState = new WeakMap(); // win -> { last: {w, h}, times: [], warned, pending, timer }

function applySize(win, requested) {
  // The request that ends a drag on the events list also ends its hold. One
  // with nothing to apply hands the window back to place(), or it would stay
  // stretched over the desktop. Without displays place() can't either, and the
  // display event that brings them back places it.
  const held = resizing.delete(win);
  const id = win.__widgetId;
  const want = (axis) =>
    fits(id, axis) && requested && Number.isFinite(requested[axis]) ? Math.round(requested[axis]) : null;
  const wantW = want('width');
  const wantH = want('height');
  if (wantW === null && wantH === null) {
    if (held) place(win);
    return;
  }
  const all = displays();
  if (!all.length) return;

  const state = sizeState.get(win) ||
    { last: { w: null, h: null }, times: [], warned: false, pending: null, timer: null };
  sizeState.set(win, state);

  // Guard 3: hard rate limit, shared across both axes so a widget oscillating
  // in width and height still can't spin the main process. A request over the
  // limit waits for the second to be up instead of being dropped, because the
  // renderer's Guard 1 already counts it as sent and would never send it again.
  // Only the latest waits: a newer request replaces it, and one applied in the
  // meantime makes it stale.
  const now = Date.now();
  state.times = state.times.filter((t) => now - t < 1000);
  if (state.times.length >= 10) {
    if (!state.warned) {
      console.warn(`Size request rate limit hit for "${id}"; deferring.`);
      state.warned = true;
    }
    state.pending = requested;
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        const next = state.pending;
        state.pending = null;
        if (!win.isDestroyed()) applySize(win, next);
      }, 1000 - (now - state.times[0]));
    }
    return;
  }
  state.times.push(now);
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
    state.pending = null;
  }

  // Everything below starts from the saved anchor and size, never from
  // getBounds(), so Windows' rounding can't accumulate across requests.
  const anchor = anchorFor(id);
  const budget = budgetFor(placement.anchorDisplay(anchor, all, primaryId()).workArea);
  const size = sizeFor(id);

  // Never let a widget run off the screen: the calendar's own scrollbar absorbs
  // whatever doesn't fit, and placement.resize slides the window back on when it
  // would overhang the work area. A list whose limit the user dragged may grow
  // its widget down to the bottom of the work area when that's more than the
  // budget, but no further. Past it the window would move up, and the anchor
  // picked again would keep it there on lighter days and at other scales.
  const roomH = listHeightFor(id) === null
    ? budget.maxWidgetHeight
    : Math.max(budget.maxWidgetHeight, placement.roomBelow(anchor, size, all, primaryId()));
  const capH = Math.max(MIN_CAP.h, roomH);
  const capW = Math.max(MIN_CAP.w, budget.maxWidgetWidth);

  const targetH = wantH === null ? size.height : Math.max(MIN_SIZE.h, Math.min(wantH, capH));
  const targetW = wantW === null ? size.width : Math.max(MIN_SIZE.w, Math.min(wantW, capW));

  // Remember what the renderer measured, so the next launch opens at the fitted
  // size instead of the registry default and then visibly snapping.
  const fitted = {};
  if (wantW !== null) fitted.w = targetW;
  if (wantH !== null) fitted.h = targetH;

  // Mid-drag, only save the size: the end of the drag places the window.
  if (dragging.has(win)) {
    store.patch(id, fitted);
    return;
  }

  const next = placement.resize(anchor, size, { width: targetW, height: targetH }, all, primaryId());

  // Guard 2: main-side no-op when nothing would change. The window is compared
  // within rounding, or a DIP that can never be reached would defeat the guard.
  if (state.last.w === targetW && state.last.h === targetH &&
      placement.closeTo(win.getBounds(), next.rect)) return;
  state.last = { w: targetW, h: targetH };

  // Saved before the setBounds, because the window's 'move'/'resize' re-place it
  // from the store. The anchor is written only when the resize moved its
  // vertical edge, so a widget on its registry default keeps following it.
  if (next.anchor.top !== anchor.top || next.anchor.bottom !== anchor.bottom) {
    fitted.anchor = next.anchor;
  }
  store.patch(id, fitted);

  win.setMinimumSize(1, 1);
  win.setMaximumSize(10000, 10000);
  setBounds(win, next.rect);
}

module.exports = {
  register, workAreaFor, newWorkArea, applySize,
  MAX_HEIGHT_FRACTION, MAX_WIDTH_FRACTION, MIN_SIZE, MIN_CAP,
  setPinned, pushSettings,
  initialBounds, place, startDrag, rememberPosition, resetPosition, endResize,
};

// Offline checks for widgets sizing their own windows: the hold that a drag on
// the calendar's events list keeps on its window (src/main/ipc.js), and the
// renderer's side of it (widgets/shared/autosize.js).
//
//   node scripts/verify-resize.js
//
// No Electron, so CI runs it in full. ipc.js is loaded with a stand-in for the
// electron module, which records its handlers and serves one display shaped
// like screen.getAllDisplays(): a 1920x1080 laptop panel at 125% with a 48 DIP
// taskbar. Its store writes to a temporary folder. autosize.js runs in a vm
// context with a stand-in card and a clock the script moves by hand.
//
// What a stretched or clipped window looks like only shows up in manual use, so
// these pin down the rules behind it: a hold starts only through beginResize,
// placement leaves a held window alone, and every way a hold can end puts the
// window back at its saved size.
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

let pass = 0;
let fail = 0;

function ok(name, cond, detail) {
  if (cond) {
    pass++;
    console.log('PASS  ' + name + (detail ? '  (' + detail + ')' : ''));
  } else {
    fail++;
    console.log('FAIL  ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (v) => JSON.stringify(v);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// --- the main process: ipc.js behind a stand-in electron ---

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-resize-'));
const AT_125 = { id: 1, workArea: { x: 0, y: 0, width: 1536, height: 816 } };
let displays = [AT_125];
const handlers = {};
const listeners = {};

const electron = {
  app: { getPath: () => userData },
  ipcMain: {
    handle: (channel, fn) => { handlers[channel] = fn; },
    on: (channel, fn) => { listeners[channel] = fn; },
  },
  BrowserWindow: { fromWebContents: (sender) => sender.win },
  screen: { getAllDisplays: () => displays, getPrimaryDisplay: () => AT_125 },
  // Required by the services ipc.js loads, never called here.
  powerMonitor: { on() {} }, net: {}, shell: {}, safeStorage: {},
};
const load = Module._load;
Module._load = function (request, ...rest) {
  return request === 'electron' ? electron : load.call(this, request, ...rest);
};

const ipc = require('../src/main/ipc');
const store = require('../src/main/store');

// Shaped like main.js's WIDGETS, which can't be required without starting the app.
ipc.register([
  { id: 'calendar', width: 320, height: 340, defaultX: 360, defaultY: 60, fits: 'height' },
  { id: 'email', width: 360, height: 300, defaultX: 60, defaultY: 360 },
]);

function fakeWindow(id, bounds) {
  const win = {
    __widgetId: id,
    bounds: { ...bounds },
    sets: 0,
    isDestroyed: () => false,
    getBounds: () => ({ ...win.bounds }),
    setBounds: (rect) => { win.bounds = { ...rect }; win.sets++; },
    setMinimumSize() {},
    setMaximumSize() {},
  };
  win.event = { sender: { win } };
  return win;
}

const beginResize = (win) => handlers['widget:begin-resize'](win.event);
const requestSize = (win, size) => listeners['widget:request-size'](win.event, size);
const setListHeight = (win, h) => handlers['widget:set-list-height'](win.event, h);
const getListHeight = (win) => handlers['widget:get-list-height'](win.event);

// The calendar on its registry default: 60 DIP below the top of an 816 DIP work
// area, so the room below its top is 756.
const FITTED = { x: 360, y: 60, width: 320, height: 300 };
const STRETCHED = { x: 360, y: 60, width: 320, height: 756 };

async function mainChecks() {
  const cal = fakeWindow('calendar', { x: 360, y: 60, width: 320, height: 340 });
  requestSize(cal, { height: 300 });
  ok('a size request fits the calendar', same(cal.bounds, FITTED), show(cal.bounds));

  // --- starting a hold ---

  const held = await beginResize(cal);
  ok('beginResize stretches the window from its top to the work area\'s bottom',
    held === 756 && same(cal.bounds, STRETCHED), show(cal.bounds));
  ok('and saves nothing', store.get('calendar').h === 300 && store.get('calendar').anchor === undefined,
    show(store.get('calendar')));

  let sets = cal.sets;
  await beginResize(cal);
  ok('a second beginResize keeps the hold without moving the window', cal.sets === sets);

  cal.bounds = { ...STRETCHED, y: 70 };
  sets = cal.sets;
  ipc.place(cal);
  ok('placement leaves a held window alone', cal.sets === sets && cal.bounds.y === 70, show(cal.bounds));

  // --- every way a hold ends ---

  cal.bounds = { ...STRETCHED };
  requestSize(cal, { height: 300 });
  ok('the request that ends the drag fits the window from its saved size, past Guard 2',
    same(cal.bounds, FITTED), show(cal.bounds));
  cal.bounds = { ...FITTED, y: 90 };
  ipc.place(cal);
  ok('and placement acts on the window again', same(cal.bounds, FITTED), show(cal.bounds));

  await beginResize(cal);
  requestSize(cal, { width: 500 });
  ok('a request with nothing to apply still puts a held window back', same(cal.bounds, FITTED), show(cal.bounds));
  await beginResize(cal);
  requestSize(cal, null);
  ok('so does a malformed one', same(cal.bounds, FITTED), show(cal.bounds));

  await beginResize(cal);
  displays = [];
  requestSize(cal, { height: 300 });
  displays = [AT_125];
  ipc.place(cal);
  ok('a hold that ends while Windows reports no displays is placed when they return',
    same(cal.bounds, FITTED), show(cal.bounds));

  await beginResize(cal);
  ipc.endResize(cal);
  ok('endResize, for a renderer that crashed mid-hold, puts the window back', same(cal.bounds, FITTED),
    show(cal.bounds));
  sets = cal.sets;
  ipc.endResize(cal);
  ok('endResize on a window that isn\'t held does nothing', cal.sets === sets);

  // --- only a widget that fits its height can hold ---

  const mail = fakeWindow('email', { x: 60, y: 360, width: 360, height: 300 });
  const refused = await beginResize(mail);
  ok('a widget that doesn\'t fit its height can\'t start a hold', refused === null && mail.sets === 0);
  await setListHeight(mail, 400);
  ok('or keep a list height', store.get('email').listHeight === undefined && (await getListHeight(mail)) === null);

  // --- the cap a list height lifts ---

  requestSize(cal, { height: 2000 });
  ok('without a list height the calendar is capped at 45% of the work area',
    cal.bounds.height === Math.round(816 * ipc.MAX_HEIGHT_FRACTION), show(cal.bounds));
  await setListHeight(cal, 250.4);
  ok('a list height is kept as whole DIP', (await getListHeight(cal)) === 250);
  requestSize(cal, { height: 2001 });
  ok('with one, the calendar may grow down to the bottom of the work area',
    same(cal.bounds, STRETCHED), show(cal.bounds));
  ok('and the renderer\'s budget gives it the same room', ipc.workAreaFor(cal).roomBelow === 756,
    show(ipc.workAreaFor(cal)));
  for (const junk of [-5, 0, NaN, 'abc', null]) {
    await setListHeight(cal, 250);
    await setListHeight(cal, junk);
    ok('a list height of ' + String(junk) + ' clears it', (await getListHeight(cal)) === null);
  }
  requestSize(cal, { height: 300 });

  // A widget whose bottom is already on the work area's bottom has nowhere to
  // stretch, so the request that ends its drag changes nothing and stops at
  // Guard 2. The hold must have ended before then, or placement would skip the
  // window for good.
  store.patch('calendar', { anchor: { display: 1, left: 360, bottom: 0 } });
  const AT_BOTTOM = { x: 360, y: 516, width: 320, height: 300 };
  requestSize(cal, { height: 300 });
  await beginResize(cal);
  ok('a widget already at the bottom isn\'t stretched', same(cal.bounds, AT_BOTTOM), show(cal.bounds));
  requestSize(cal, { height: 300 });
  cal.bounds = { ...AT_BOTTOM, y: 530 };
  ipc.place(cal);
  ok('and a request that changes nothing still ends its hold', same(cal.bounds, AT_BOTTOM), show(cal.bounds));
  store.patch('calendar', { anchor: undefined });

  // --- Guard 3 defers the latest request instead of dropping it ---

  const burst = fakeWindow('calendar', { ...FITTED });
  for (let h = 200; h < 210; h++) requestSize(burst, { height: h });
  ok('ten requests in a second all apply', burst.bounds.height === 209, show(burst.bounds));
  await beginResize(burst);
  requestSize(burst, { height: 250 });
  requestSize(burst, { height: 260 });
  ok('requests past the limit wait', burst.bounds.height === 756, show(burst.bounds));
  await wait(1200);
  ok('and the latest lands once the second is up, ending the hold',
    burst.bounds.height === 260 && store.get('calendar').h === 260, show(burst.bounds));
}

// --- the renderer: autosize.js in a vm context ---

function autosizeChecks() {
  let now = 0;
  let timers = [];
  const advance = (ms) => {
    now += ms;
    const due = timers.filter((t) => t.at <= now);
    timers = timers.filter((t) => t.at > now);
    due.forEach((t) => t.fn());
  };
  let nextId = 1;
  const requests = [];
  const window = {
    widgetAPI: { requestSize: (size) => requests.push(size) },
    ResizeObserver: function () { return { observe() {} }; },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../widgets/shared/autosize.js'), 'utf8'), {
    window,
    ResizeObserver: window.ResizeObserver,
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ id, fn, at: now + ms }); return id; },
    clearTimeout: (id) => { timers = timers.filter((t) => t.id !== id); },
  });

  const card = { width: 320, height: 300, getBoundingClientRect() { return { width: this.width, height: this.height }; } };
  const sync = window.widgetAutosize(card, { axes: 'height' });
  const sent = () => requests.splice(0);

  sync();
  ok('a card that grew is reported at once', same(sent(), [{ height: 300 }]));

  card.height = 250;
  sync();
  advance(49);
  ok('a shrink waits', sent().length === 0);
  advance(1);
  ok('and is reported 50 ms later', same(sent(), [{ height: 250 }]));

  card.height = 200;
  sync();
  card.height = 280;
  sync();
  advance(50);
  ok('growth inside the wait is reported at once and drops the shrink', same(sent(), [{ height: 280 }]));

  card.height = 281;
  sync();
  advance(50);
  ok('Guard 1: a change of 1 px isn\'t reported', sent().length === 0);

  card.height = 200;
  sync();
  sync.hold();
  advance(50);
  ok('hold() drops a shrink that was waiting', sent().length === 0);
  card.height = 400;
  sync();
  card.height = 100;
  sync();
  advance(100);
  ok('and nothing is reported while held', sent().length === 0);

  card.height = 280;
  sync.release();
  ok('release() reports at once, past Guard 1, though the card is the size last reported',
    same(sent(), [{ height: 280 }]));
  card.height = 320;
  sync();
  ok('and reporting carries on after it', same(sent(), [{ height: 320 }]));

  const clockCard = { width: 200, height: 100, getBoundingClientRect() { return { width: this.width, height: this.height }; } };
  const clock = window.widgetAutosize(clockCard, { axes: 'both' });
  clock();
  sent();
  clockCard.width = 240;
  clock();
  ok('a widget that fits both axes reports a wider card at once', same(sent(), [{ width: 240, height: 100 }]));
  clockCard.width = 220;
  clock();
  ok('and waits on a narrower one', sent().length === 0);
  advance(50);
  ok('then reports it', same(sent(), [{ width: 220, height: 100 }]));
}

(async () => {
  try {
    await mainChecks();
    autosizeChecks();
  } catch (err) {
    fail++;
    console.log('FAIL  the checks threw: ' + (err && err.stack));
  } finally {
    store.flush();
    fs.rmSync(userData, { recursive: true, force: true });
  }
  console.log('\n===== ' + pass + ' passed, ' + fail + ' failed =====');
  process.exit(fail ? 1 : 0);
})();

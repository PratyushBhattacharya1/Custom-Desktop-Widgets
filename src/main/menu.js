// Per-widget right-click menu — the settings surface.
//
// Two handlers are needed, and which one fires depends on where you click AND
// whether the widget is pinned:
//
//   unpinned, card body ......... drag region .... 'system-context-menu'
//   unpinned, pin zone / controls  no-drag ....... webContents 'context-menu'
//   pinned, anywhere ............ html.pos-locked makes body no-drag, so the
//                                 renderer path fires everywhere
//
// A drag region is hit-tested as HTCAPTION, so Windows delivers the click as a
// non-client message that never enters Chromium's input pipeline. The renderer
// therefore never sees it, and webContents 'context-menu' — which is raised
// downstream of the renderer — never fires either. 'system-context-menu' is the
// documented hook for exactly that case (win32 only).
const { app, Menu } = require('electron');
const settings = require('./settings');
const ipc = require('./ipc');
const gmailService = require('./gmail/service');

function widgetLabel(id) {
  return id.charAt(0).toUpperCase() + id.slice(1);
}

function buildMenu(win) {
  const id = win.__widgetId;
  const s = settings.settingsFor(id);
  const caps = settings.capabilities(id);

  const backgrounds = Object.keys(settings.BACKGROUNDS).map((key) => ({
    label: settings.BACKGROUNDS[key].label,
    type: 'radio',
    checked: s.background === key,
    click: () => {
      settings.setSetting(id, 'background', key);
      ipc.pushSettings(win);
    },
  }));

  const opacities = settings.OPACITY_STEPS.map((step) => ({
    label: Math.round(step * 100) + '%',
    type: 'radio',
    checked: s.opacity === step,
    click: () => {
      settings.setSetting(id, 'opacity', step);
      ipc.pushSettings(win);
    },
  }));

  const sizes = Object.keys(settings.SIZES).map((key) => ({
    label: settings.SIZES[key].label,
    type: 'radio',
    checked: s.size === key,
    click: () => {
      settings.setSetting(id, 'size', key);
      ipc.pushSettings(win);
    },
  }));

  const template = [
    { label: widgetLabel(id), enabled: false },
    { type: 'separator' },
    { label: 'Background', submenu: backgrounds },
    { label: 'Opacity', submenu: opacities },
  ];

  // Scaling type only works where the window refits around the result.
  if (caps.size) template.push({ label: 'Size', submenu: sizes });

  // The email widget carries its own connection controls: under Testing status
  // Google expires the refresh token weekly, so reconnecting is routine.
  if (id === 'email') {
    const mail = gmailService.getState();
    template.push(
      { type: 'separator' },
      {
        label: mail.connected ? 'Reconnect Gmail…' : 'Connect Gmail…',
        // Swallowing this made every failure invisible: the menu is the only
        // trigger, and the failing path never reaches the code that emits an
        // update. Record it so the widget can say something went wrong.
        click: () => { gmailService.connect().catch((err) => gmailService.reportError(err)); },
      },
      {
        label: 'Refresh now',
        enabled: mail.connected,
        click: () => { gmailService.refresh().catch((err) => gmailService.reportError(err)); },
      }
    );
  }

  template.push(
    { type: 'separator' },
    {
      label: 'Lock position',
      type: 'checkbox',
      checked: settings.composeFor(id).pinned,
      click: (item) => ipc.setPinned(win, item.checked),
    },
    {
      label: 'Show pin button',
      type: 'checkbox',
      checked: s.showPin,
      // Hiding the pin is only safe because Lock position lives here too —
      // otherwise a pinned widget with no pin would be stuck.
      click: (item) => {
        settings.setSetting(id, 'showPin', item.checked);
        ipc.pushSettings(win);
      },
    },
    { type: 'separator' },
    {
      label: 'Reset appearance',
      click: () => {
        settings.reset(id);
        ipc.pushSettings(win);
      },
    },
    // win.hide() fires the existing 'hide' listener, so the tray checkbox
    // re-syncs on its own.
    { label: 'Hide this widget', click: () => win.hide() },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  );

  return Menu.buildFromTemplate(template);
}

let lastPopupAt = 0;

function popup(win) {
  if (!win || win.isDestroyed()) return;
  // One click can reach both handlers depending on where it lands, and a
  // synthesised WM_CONTEXTMENU can follow a client-area click. Never stack two.
  const now = Date.now();
  if (now - lastPopupAt < 300) return;
  lastPopupAt = now;

  const menu = buildMenu(win);

  // No x/y: 'system-context-menu' reports screen coordinates while
  // 'context-menu' reports content coordinates, and popup() expects
  // window-relative. Its default — the current cursor position — is right for
  // both, and sidesteps the whole coordinate-space mismatch.
  menu.popup({ window: win });
}

// Wires both paths for one widget window.
function attach(win) {
  win.on('system-context-menu', (event) => {
    // Must precede popup(), which runs a nested message loop; otherwise
    // Windows' own Move/Size/Close menu can still appear.
    event.preventDefault();
    popup(win);
  });
  win.webContents.on('context-menu', () => popup(win));
}

module.exports = { attach, popup, buildMenu };

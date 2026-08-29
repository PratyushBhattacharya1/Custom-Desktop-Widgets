// Bridges a minimal, explicit API into each widget renderer.
//
// Renderers are sandboxed with contextIsolation, so this is their only route to
// the main process. Note that no method takes a widget id — main resolves that
// from the IPC sender, so a widget can only ever act on itself.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widgetAPI', {
  // Pin (lock position)
  getPinned: () => ipcRenderer.invoke('widget:get-pinned'),
  setPinned: (pinned) => ipcRenderer.invoke('widget:set-pinned', pinned),

  // Display metrics + self-resize
  getWorkArea: () => ipcRenderer.invoke('widget:get-work-area'),
  onWorkAreaChanged: (cb) =>
    ipcRenderer.on('widget:work-area-changed', (_event, data) => cb(data)),
  requestHeight: (height) => ipcRenderer.send('widget:request-height', height),
});

contextBridge.exposeInMainWorld('calendarAPI', {
  getMonth: (year, month) => ipcRenderer.invoke('calendar:get-month', { year, month }),
  refresh: () => ipcRenderer.invoke('calendar:refresh'),
  onUpdated: (cb) => ipcRenderer.on('calendar:updated', (_event, data) => cb(data)),
});

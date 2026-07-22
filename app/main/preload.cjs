// ============================================================================
// preload (CommonJS)。renderer に安全な型付きブリッジ window.fm を露出する。
// contextIsolation 前提。renderer からは core へ直接触れない（IPC 経由のみ）。
// ============================================================================
const { contextBridge, ipcRenderer } = require('electron');

/** @type {Map<string, Set<Function>>} */
const listeners = new Map();

ipcRenderer.on('core:event', (_e, { event, payload }) => {
  const set = listeners.get(event);
  if (set) for (const cb of set) cb(payload);
});

contextBridge.exposeInMainWorld('fm', {
  invoke: (channel, payload) => ipcRenderer.invoke('core:invoke', { channel, payload }),
  on: (event, cb) => {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(cb);
    return () => set.delete(cb);
  },
});

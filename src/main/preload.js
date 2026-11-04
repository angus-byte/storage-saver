const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('storage', {
  platform: process.platform,
  diskInfo: () => ipcRenderer.invoke('disk:info'),
  scan: (root) => ipcRenderer.invoke('scan:start', root),
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  onProgress: (cb) => {
    const handler = (_e, p) => cb(p);
    ipcRenderer.on('scan:progress', handler);
    return () => ipcRenderer.removeListener('scan:progress', handler);
  },
  reveal: (p) => ipcRenderer.invoke('fs:reveal', p),
  pickFolder: () => ipcRenderer.invoke('fs:pickFolder'),
  trash: (paths) => ipcRenderer.invoke('fs:trash', paths),
  emptyFolder: (dir) => ipcRenderer.invoke('fs:emptyFolder', dir),
  protectedPaths: () => ipcRenderer.invoke('fs:protected'),
  permStatus: () => ipcRenderer.invoke('perm:status'),
  openPermissions: () => ipcRenderer.invoke('perm:open'),
  // Free / Pro plan + Deep Clean
  planStatus: () => ipcRenderer.invoke('plan:status'),
  activateLicence: (key) => ipcRenderer.invoke('plan:activate', key),
  deactivateLicence: () => ipcRenderer.invoke('plan:deactivate'),
  openCheckout: () => ipcRenderer.invoke('plan:checkout'),
  setWeekly: (on) => ipcRenderer.invoke('plan:setWeekly', on),
  onPlan: (cb) => {
    const handler = (_e, st) => cb(st);
    ipcRenderer.on('plan:changed', handler);
    return () => ipcRenderer.removeListener('plan:changed', handler);
  },
  deepScan: () => ipcRenderer.invoke('deep:scan'),
  trashDuplicate: (p, keep) => ipcRenderer.invoke('fs:trashDuplicate', p, keep),
  // City Hall
  listApps: (fresh) => ipcRenderer.invoke('apps:list', fresh),
  uninstallApp: (p) => ipcRenderer.invoke('apps:uninstall', p),
  listStartup: () => ipcRenderer.invoke('startup:list'),
  removeStartup: (p) => ipcRenderer.invoke('startup:remove', p),
  openLoginItems: () => ipcRenderer.invoke('startup:openSettings'),
  // Privacy (browser data)
  listBrowsers: () => ipcRenderer.invoke('privacy:list'),
  clearBrowser: (id, kinds) => ipcRenderer.invoke('privacy:clear', id, kinds),
});

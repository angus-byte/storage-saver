const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('storage', {
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
});

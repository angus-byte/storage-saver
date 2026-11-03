const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const { scan, suggestions, defaultRoots } = require('./scanner');

let win;
let currentScan = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Storage Saver',
    backgroundColor: '#0b0f17',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// --- IPC -------------------------------------------------------------------

ipcMain.handle('disk:info', async () => {
  const roots = defaultRoots();
  const out = [];
  for (const r of roots) {
    try {
      const st = await fsp.statfs(r);
      out.push({ path: r, total: st.blocks * st.bsize, free: st.bavail * st.bsize });
    } catch {
      out.push({ path: r, total: 0, free: 0 });
    }
  }
  return { platform: process.platform, home: os.homedir(), roots: out };
});

ipcMain.handle('scan:start', async (event, root) => {
  if (currentScan) currentScan.abort();
  const controller = new AbortController();
  currentScan = controller;
  const target = root || defaultRoots()[0];
  const sender = event.sender;
  try {
    const tree = await scan(target, {
      signal: controller.signal,
      onProgress: (p) => {
        if (!sender.isDestroyed()) sender.send('scan:progress', p);
      },
    });
    return { tree, suggestions: suggestions(tree) };
  } finally {
    if (currentScan === controller) currentScan = null;
  }
});

ipcMain.handle('scan:cancel', () => {
  if (currentScan) currentScan.abort();
  return true;
});

ipcMain.handle('fs:reveal', (_e, p) => {
  shell.showItemInFolder(p);
  return true;
});

ipcMain.handle('fs:pickFolder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return res.canceled ? null : res.filePaths[0];
});

// Moves items to the OS Trash / Recycle Bin (never a permanent delete).
ipcMain.handle('fs:trash', async (_e, paths) => {
  const results = [];
  for (const p of paths) {
    try {
      if (!fs.existsSync(p)) {
        results.push({ path: p, ok: false, error: 'missing' });
        continue;
      }
      await shell.trashItem(p);
      results.push({ path: p, ok: true });
    } catch (err) {
      results.push({ path: p, ok: false, error: String(err.message || err) });
    }
  }
  return results;
});

// Empties the contents of a folder (e.g. a cache dir) into the Trash, keeping the folder itself.
ipcMain.handle('fs:emptyFolder', async (_e, dir) => {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    return [{ path: dir, ok: false, error: String(err.message || err) }];
  }
  const results = [];
  for (const name of entries) {
    const p = path.join(dir, name);
    try {
      await shell.trashItem(p);
      results.push({ path: p, ok: true });
    } catch (err) {
      results.push({ path: p, ok: false, error: String(err.message || err) });
    }
  }
  return results;
});

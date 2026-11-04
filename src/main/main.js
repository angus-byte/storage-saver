const { app, BrowserWindow, ipcMain, shell, dialog, Notification } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const { scan, suggestions, defaultRoots } = require('./scanner');
const { createLicence } = require('./licence');
const { deepSuggestions, sweepOnly, sizeOf, sameFile } = require('./deepclean');
const config = require('./config');
const cityhall = require('./cityhall');

let win;
let currentScan = null;
let lastTree = null;
let plan = null; // created once the app is ready (needs userData)

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'Gigapolis',
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
  plan = createLicence({ dir: app.getPath('userData'), forcePro: !app.isPackaged && process.env.GIGAPOLIS_PRO === '1' });
  plan.revalidate().then(pushPlan);
  setInterval(() => plan.revalidate().then(pushPlan), 6 * 3600000);
  startWeeklyCheckup();
  startAutoUpdates();
  // Opened at login for the weekly check-up: stay in the background.
  const hidden = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden;
  if (!hidden) createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Auto-update from GitHub Releases (latest-mac.yml). Downloads in the
// background and installs on next quit, with a notification when ready.
function startAutoUpdates() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require('electron-updater')); } catch { return; }
  autoUpdater.on('error', (err) => console.warn('Update check failed:', err && err.message));
  const check = () => autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  setTimeout(check, 10000);
  setInterval(check, 6 * 3600000);
}

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
    lastTree = tree;
    return { tree, suggestions: sweepOnly(suggestions(tree)) };
  } finally {
    if (currentScan === controller) currentScan = null;
  }
});

// macOS "Full Disk Access": one switch in System Settings that covers every
// folder, so the app never has to ask per folder. Reading the TCC database
// only works once it has been granted, which makes it a reliable probe.
function hasFullDiskAccess() {
  if (process.platform !== 'darwin') return true;
  try {
    const fd = fs.openSync(path.join(os.homedir(), 'Library/Application Support/com.apple.TCC/TCC.db'), 'r');
    fs.closeSync(fd);
    return true;
  } catch {
    return false;
  }
}

ipcMain.handle('perm:status', () => ({ platform: process.platform, fullDisk: hasFullDiskAccess() }));

ipcMain.handle('perm:open', () => {
  if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles');
  return true;
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

// Bytes that count towards the free Demolish allowance. Items already in the
// Trash are free to clear.
const inTrash = (p) => /[\\/](\.Trash|\$Recycle\.Bin)([\\/]|$)/i.test(p);
async function measure(paths) {
  const sizes = new Map();
  for (const p of paths) sizes.set(p, inTrash(p) ? 0 : await sizeOf(p));
  return sizes;
}
const sum = (sizes, paths) => paths.reduce((n, p) => n + (sizes.get(p) || 0), 0);

// Moves items to the OS Trash / Recycle Bin (never a permanent delete).
// Free plan: refuses the whole request if it would pass the allowance.
ipcMain.handle('fs:trash', async (_e, paths) => {
  const sizes = await measure(paths);
  const blocked = plan.checkAllowance(sum(sizes, paths));
  if (blocked) return paths.map((p) => ({ path: p, ...blocked }));
  const results = await trashPaths(paths);
  plan.recordDemolished(sum(sizes, results.filter((r) => r.ok).map((r) => r.path)));
  pushPlan();
  return results;
});

// Deep Clean duplicates: only trashed after a full byte-for-byte check that
// the copy we keep is identical and still there.
ipcMain.handle('fs:trashDuplicate', async (_e, p, keep) => {
  if (!plan.isPro()) return [{ path: p, ok: false, error: 'pro' }];
  if (!(await sameFile(p, keep))) return [{ path: p, ok: false, error: 'Not an exact copy any more, left in place' }];
  const results = await trashPaths([p]);
  pushPlan();
  return results;
});

async function trashPaths(paths) {
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
}

// Empties the contents of a folder (e.g. a cache dir) into the Trash, keeping the folder itself.
ipcMain.handle('fs:emptyFolder', async (_e, dir) => {
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    return [{ path: dir, ok: false, error: String(err.message || err) }];
  }
  const paths = entries.map((name) => path.join(dir, name));
  const sizes = await measure(paths);
  const blocked = plan.checkAllowance(sum(sizes, paths));
  if (blocked) return [{ path: dir, ...blocked }];
  const results = [];
  for (const p of paths) {
    try {
      await shell.trashItem(p);
      results.push({ path: p, ok: true });
    } catch (err) {
      results.push({ path: p, ok: false, error: String(err.message || err) });
    }
  }
  plan.recordDemolished(sum(sizes, results.filter((r) => r.ok).map((r) => r.path)));
  pushPlan();
  return results;
});

// --- Plan (free / Pro) + Deep Clean -----------------------------------------
function pushPlan() {
  for (const w of BrowserWindow.getAllWindows()) if (!w.webContents.isDestroyed()) w.webContents.send('plan:changed', plan.status());
}
ipcMain.handle('plan:status', () => plan.status());
ipcMain.handle('plan:activate', async (_e, key) => {
  const r = await plan.activate(key);
  if (r.ok) {
    pushPlan();
    applyLoginItem();
  }
  return r;
});
ipcMain.handle('plan:deactivate', async () => {
  const r = await plan.deactivate();
  pushPlan();
  applyLoginItem();
  return r;
});
ipcMain.handle('plan:checkout', () => {
  shell.openExternal(config.checkoutUrl);
  return true;
});
ipcMain.handle('plan:setWeekly', (_e, enabled) => {
  const st = plan.setWeekly({ enabled: !!enabled });
  applyLoginItem();
  pushPlan();
  return st;
});
// Deep Clean runs for everyone: free users see what it found (and the total)
// so they know what Pro would clear, but only Pro gets the checkboxes.
ipcMain.handle('deep:scan', async () => {
  if (!lastTree) return null;
  return deepSuggestions(lastTree);
});

// --- Weekly check-up (Pro) ----------------------------------------------------
// While Gigapolis is running (it starts hidden at login when this is on),
// rescan once a week and post a notification with what can be cleaned. It
// never deletes on its own.
function applyLoginItem() {
  if (process.platform !== 'darwin' || !app.isPackaged) return;
  const on = plan.isPro() && plan.status().weekly.enabled;
  app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
}

async function weeklyCheckup() {
  const st = plan.status();
  if (st.plan !== 'pro' || !st.weekly.enabled || currentScan) return;
  if (Date.now() - (st.weekly.lastRun || 0) < config.weeklyMs) return;
  plan.setWeekly({ lastRun: Date.now() });
  try {
    const tree = await scan(defaultRoots()[0], {});
    lastTree = tree;
    const sweep = sweepOnly(suggestions(tree));
    const deep = await deepSuggestions(tree);
    const bytes = [...Object.values(sweep), ...Object.values(deep)].reduce((n, g) => n + g.total, 0);
    plan.setWeekly({ lastRun: Date.now(), lastFound: bytes });
    pushPlan();
    if (bytes > 1024 ** 3 && Notification.isSupported()) {
      const n = new Notification({ title: 'Gigapolis weekly check-up', body: `${(bytes / 1024 ** 3).toFixed(1)} GB can be cleared. Open the city to demolish it.` });
      n.on('click', () => {
        if (!BrowserWindow.getAllWindows().length) createWindow();
        else BrowserWindow.getAllWindows()[0].show();
      });
      n.show();
    }
  } catch {}
}

function startWeeklyCheckup() {
  applyLoginItem();
  setTimeout(weeklyCheckup, 60000);
  setInterval(weeklyCheckup, 3600000);
}

// --- City Hall: Moving Day (apps) + Rush Hour (startup items) ---------------
let appsCache = null;
ipcMain.handle('apps:list', async (_e, fresh) => {
  if (process.platform !== 'darwin') return { supported: false, apps: [] };
  if (!appsCache || fresh) appsCache = cityhall.listApps(os.homedir());
  try {
    return { supported: true, apps: await appsCache };
  } catch (err) {
    appsCache = null;
    return { supported: true, apps: [], error: String(err.message || err) };
  }
});

// Moves an app and all of its ~/Library files to the Trash. The file list is
// worked out again here rather than trusted from the page. Counts towards the
// free Demolish allowance like any other demolish.
ipcMain.handle('apps:uninstall', async (_e, appPath) => {
  const apps = await (appsCache || cityhall.listApps(os.homedir()));
  const app = apps.find((a) => a.path === appPath);
  if (!app) return { ok: false, error: 'App not found. Rescan City Hall.' };
  if (await cityhall.isRunning(app.path)) return { ok: false, error: `Quit ${app.name} first, then move it out.` };
  const files = await cityhall.appFiles(app, os.homedir());
  const paths = [app.path, ...files.map((f) => f.path)];
  const sizes = await measure(paths);
  const blocked = plan.checkAllowance(sum(sizes, paths));
  if (blocked) return { ok: false, ...blocked };
  const results = await trashPaths(paths);
  plan.recordDemolished(sum(sizes, results.filter((r) => r.ok).map((r) => r.path)));
  pushPlan();
  appsCache = null;
  const appRes = results[0];
  if (!appRes.ok) return { ok: false, error: /permission|not permitted|EACCES|EPERM/i.test(appRes.error) ? 'macOS needs your password for this one. Drag it to the Bin in Finder.' : appRes.error, results };
  return { ok: true, freed: sum(sizes, results.filter((r) => r.ok).map((r) => r.path)), results };
});

ipcMain.handle('startup:list', async () => {
  if (process.platform !== 'darwin') return { supported: false, items: [] };
  return { supported: true, items: await cityhall.listStartup(os.homedir()) };
});

// Switch off a commuter: unload it and move its plist to the Trash (so it can
// be put back). Only your own LaunchAgents; system ones need an admin. Free
// plan: only ones Neighbourhood Watch flagged.
ipcMain.handle('startup:remove', async (_e, file) => {
  const items = await cityhall.listStartup(os.homedir());
  const item = items.find((i) => i.path === file);
  if (!item) return { ok: false, error: 'Not found any more.' };
  if (!item.canRemove) return { ok: false, error: 'This one is for every user. Remove it in Finder with your password.' };
  if (!item.freeToRemove && !plan.isPro()) return { ok: false, error: 'pro' };
  await cityhall.unloadAgent(file);
  const [res] = await trashPaths([file]);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
});

ipcMain.handle('startup:openSettings', () => {
  if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension');
  return true;
});

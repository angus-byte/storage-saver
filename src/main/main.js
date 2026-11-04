const { app, BrowserWindow, ipcMain, shell, dialog, Notification, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const { scan, suggestions, defaultRoots } = require('./scanner');
const { createLicence } = require('./licence');
const { deepSuggestions, sweepOnly, sizeOf, sameFile } = require('./deepclean');
const config = require('./config');
const cityhall = require('./cityhall');
const photos = require('./photos');
const browsers = require('./browsers');
const cityhallWin = require('./cityhall-win');
const { createProtection, friendlyError } = require('./protect');
const { createSettings, lowSpaceCheck } = require('./settings');
const { createTray, fmt } = require('./tray');
const protection = createProtection();
const { createDrives, driveMessage } = require('./drives');
let drives = createDrives(); // reloaded with the saved opt-ins once userData is known
const driveBlock = (p) => {
  const c = drives.blocked(p);
  return c ? { ok: false, error: 'drive', drive: c, message: driveMessage(c) } : null;
};
// Scanning never walks into cloud folders or other drives that aren't opted in.
const scanSkip = (p) => {
  const c = drives.blocked(p);
  return c ? { kind: c.kind, label: c.label } : null;
};

let win;
let currentScan = null;
let lastTree = null;
let plan = null; // created once the app is ready (needs userData)
let settings = null;
let tray = null;
let isQuitting = false;

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
  // Closing the window keeps Gigapolis in the menu bar / tray (unless switched off).
  win.on('close', (e) => {
    if (isQuitting || !settings || !settings.get().keepInTray) return;
    e.preventDefault();
    win.hide();
    if (process.platform === 'darwin' && app.dock) app.dock.hide();
  });
  win.on('closed', () => {
    win = null;
  });
}

// Show the city (creating the window if needed), optionally on a given panel tab.
function showWindow(tab) {
  if (process.platform === 'darwin' && app.dock) app.dock.show();
  if (!win || win.isDestroyed()) {
    createWindow();
    if (tab) win.webContents.once('did-finish-load', () => win && win.webContents.send('nav:tab', tab));
  } else {
    if (win.isMinimized()) win.restore();
    win.show();
    if (tab) win.webContents.send('nav:tab', tab);
  }
  win.focus();
}

const WIN = process.platform === 'win32';
// One Gigapolis at a time: opening it again (e.g. while the weekly check-up
// runs hidden) just shows the window.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => showWindow());
app.on('before-quit', () => {
  isQuitting = true;
});
// Windows needs this for notifications to show the app's name and icon.
if (WIN) app.setAppUserModelId('com.sommarfilms.storagesaver');

app.whenReady().then(() => {
  settings = createSettings({ dir: app.getPath('userData') });
  drives = createDrives({ file: path.join(app.getPath('userData'), 'drives.json') });
  plan = createLicence({ dir: app.getPath('userData'), forcePro: !app.isPackaged && process.env.GIGAPOLIS_PRO === '1' });
  plan.revalidate().then(pushPlan);
  setInterval(() => plan.revalidate().then(pushPlan), 6 * 3600000);
  startWeeklyCheckup();
  startAutoUpdates();
  // Opened at login for the weekly check-up: stay in the background.
  const hidden = WIN ? process.argv.includes('--hidden') : process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden;
  if (!hidden) createWindow();
  else if (process.platform === 'darwin' && app.dock) app.dock.hide();
  startTray();
  app.on('activate', () => showWindow());
});

// Auto-update from GitHub Releases (latest-mac.yml / latest.yml on Windows). Downloads in the
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

// Only reached when "Keep running in menu bar / tray" is off: then closing the
// window quits fully, on Mac and Windows alike.
app.on('window-all-closed', () => {
  app.quit();
});

// --- Menu bar / tray widget ---------------------------------------------------
let safe = { state: 'unknown', bytes: 0, items: [] };
let lowSpaceArmed = true;

// Safe Clean = caches + Trash, the same two groups as the Safe Clean tab.
async function updateSafe() {
  if (!lastTree) return;
  const s = await withRecycleBin(sweepOnly(suggestions(lastTree)));
  const items = ['caches', 'trash'].flatMap((k) => (s[k] ? s[k].items : []));
  safe = { state: 'ready', bytes: items.reduce((n, i) => n + i.size, 0), items };
  if (tray) tray.render();
}

async function diskFree() {
  try {
    const st = await fsp.statfs(defaultRoots()[0]);
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch {
    return { free: 0, total: 0 };
  }
}

function notify(title, body, tab) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body });
  n.on('click', () => showWindow(tab));
  n.show();
}

async function refreshDisk() {
  const d = await diskFree();
  if (tray) tray.setDisk(d);
  const st = settings.get();
  const r = lowSpaceCheck(lowSpaceArmed, d.free, st.lowSpaceGB);
  lowSpaceArmed = r.armed;
  if (r.notify && st.lowSpaceAlert) {
    notify('Gigapolis: running low on space', `Only ${fmt(d.free)} left.${safe.bytes ? ` Safe Clean can free ${fmt(safe.bytes)}.` : ' Open the city to see what can go.'}`, 'safe');
  }
}

// Background rescan for the tray (when the window isn't open to do it).
async function backgroundScan() {
  if (currentScan) return;
  const wc = win && !win.isDestroyed() && win.webContents;
  if (wc && win.isVisible()) {
    wc.send('nav:rescan');
    return;
  }
  safe = { ...safe, state: 'checking' };
  if (tray) tray.render();
  const controller = new AbortController();
  currentScan = controller;
  try {
    lastTree = await scan(defaultRoots()[0], { signal: controller.signal, skip: scanSkip });
    await updateSafe();
  } catch {
    safe = { state: 'unknown', bytes: 0, items: [] };
    if (tray) tray.render();
  } finally {
    if (currentScan === controller) currentScan = null;
  }
}

async function traySafeClean() {
  const { items, bytes } = safe;
  if (!items.length) return;
  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Safe Clean', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    title: 'Safe Clean',
    message: `Free ${fmt(bytes)}?`,
    detail: 'Moves caches and temp files to the Trash and clears what is already in it. Apps rebuild caches when needed.',
  });
  if (response !== 0) return;
  safe = { ...safe, state: 'cleaning' };
  tray.render();
  let freed = 0;
  let capped = false;
  for (const it of items) {
    const res = await emptyFolder(it.path);
    if (res.some((r) => r.error === 'cap')) capped = true;
    else if (res.every((r) => r.ok)) freed += it.size;
  }
  if (freed) notify('Safe Clean done', `Moved ${fmt(freed)} to the Trash. Empty the Trash to get the space back.`);
  if (capped) notify('Free limit reached', 'Upgrade to Gigapolis Pro to keep cleaning.', 'safe');
  safe = { state: 'unknown', bytes: 0, items: [] };
  refreshDisk();
  backgroundScan();
}

function onSetting(key, value) {
  settings.set({ [key]: value });
  if (key === 'launchAtLogin') applyLoginItem();
  if (key === 'lowSpaceAlert' && value) lowSpaceArmed = true;
  tray.render();
}

function startTray() {
  try {
    tray = createTray({
      getSafe: () => safe,
      safeClean: traySafeClean,
      checkSafe: backgroundScan,
      open: () => showWindow(),
      settings,
      onSetting,
      quit: () => app.quit(),
    });
  } catch (err) {
    console.warn('Tray unavailable:', err && err.message);
    return;
  }
  refreshDisk();
  setInterval(refreshDisk, 60000);
}

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
  const block = driveBlock(target);
  if (block) {
    if (currentScan === controller) currentScan = null;
    return { blocked: block };
  }
  try {
    const tree = await scan(target, {
      skip: scanSkip,
      signal: controller.signal,
      onProgress: (p) => {
        if (!sender.isDestroyed()) sender.send('scan:progress', p);
      },
    });
    lastTree = tree;
    updateSafe();
    return { tree, suggestions: await withRecycleBin(sweepOnly(suggestions(tree))) };
  } finally {
    if (currentScan === controller) currentScan = null;
  }
});

// Windows keeps the Recycle Bin at the drive root, outside the scanned home
// folder, so Street Sweep adds it here (the Mac Trash is inside the home).
async function withRecycleBin(sugg) {
  if (!WIN || !sugg.trash) return sugg;
  const bin = await cityhallWin.recycleBin(os.homedir()).catch(() => null);
  if (bin && bin.size > 0 && !sugg.trash.items.some((i) => i.path.toLowerCase() === bin.path.toLowerCase())) {
    sugg.trash = { items: [...sugg.trash.items, bin], total: sugg.trash.total + bin.size };
  }
  return sugg;
}

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

ipcMain.handle('fs:protected', () => protection.list());

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

// Cloud folders and other drives: off by default, opted in one by one.
ipcMain.handle('drives:list', () => drives.available());
ipcMain.handle('drives:add', (_e, root) => drives.add(root));
ipcMain.handle('drives:remove', (_e, root) => drives.remove(root));

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
  // Never trash a top-level user or system folder (e.g. ~/Pictures, /Applications).
  const guarded = paths.map((p) => [p, protection.check(p)]).filter(([, r]) => r);
  if (guarded.length) return guarded.map(([p, r]) => ({ path: p, ok: false, error: 'protected', name: r.name, contents: r.contents }));
  const offDrive = paths.map((p) => [p, driveBlock(p)]).find(([, b]) => b);
  if (offDrive) return paths.map((p) => ({ path: p, ...offDrive[1] }));
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
      if (protection.isProtected(p)) {
        results.push({ path: p, ok: false, error: 'protected' });
        continue;
      }
      const block = driveBlock(p);
      if (block) {
        results.push({ path: p, ...block });
        continue;
      }
      if (!fs.existsSync(p)) {
        results.push({ path: p, ok: false, error: 'missing' });
        continue;
      }
      await shell.trashItem(p);
      results.push({ path: p, ok: true });
    } catch (err) {
      results.push({ path: p, ok: false, ...friendlyError(err, p) });
    }
  }
  return results;
}

// Empties the contents of a folder (e.g. a cache dir) into the Trash, keeping the folder itself.
ipcMain.handle('fs:emptyFolder', (_e, dir) => emptyFolder(dir));
async function emptyFolder(dir) {
  // Emptying the Recycle Bin is the one permanent delete: the person already deleted these.
  if (WIN && /[\\/]\$Recycle\.Bin([\\/]|$)/i.test(dir)) return [{ path: dir, ok: await cityhallWin.emptyRecycleBin(dir) }];
  const guard = protection.check(dir);
  if (guard && !guard.contents) return [{ path: dir, ok: false, error: 'protected', name: guard.name, contents: false }];
  const block = driveBlock(dir);
  if (block) return [{ path: dir, ...block }];
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    return [{ path: dir, ok: false, ...friendlyError(err, dir) }];
  }
  // Skip hidden system files (.localized, desktop.ini) and anything protected.
  const paths = entries.filter((name) => name !== '.localized' && name.toLowerCase() !== 'desktop.ini').map((name) => path.join(dir, name)).filter((p) => !protection.isProtected(p));
  if (!paths.length) return [{ path: dir, ok: true }];
  const sizes = await measure(paths);
  const blocked = plan.checkAllowance(sum(sizes, paths));
  if (blocked) return [{ path: dir, ...blocked }];
  const results = [];
  for (const p of paths) {
    try {
      if (driveBlock(p)) throw new Error('Cloud or other drive not added');
      await shell.trashItem(p);
      results.push({ path: p, ok: true });
    } catch (err) {
      results.push({ path: p, ok: false, ...friendlyError(err, p) });
    }
  }
  plan.recordDemolished(sum(sizes, results.filter((r) => r.ok).map((r) => r.path)));
  pushPlan();
  return results;
}

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
  return deepSuggestions(lastTree, deepOpts());
});

// Windows: Deep Clean's leftover check needs the installed apps from the registry.
const deepOpts = () => (WIN ? { listApps: () => cityhallWin.appNames() } : {});

// --- Weekly check-up (Pro) ----------------------------------------------------
// While Gigapolis is running (it starts hidden at login when this is on),
// rescan once a week and post a notification with what can be cleaned. It
// never deletes on its own.
function applyLoginItem() {
  if (!['darwin', 'win32'].includes(process.platform) || !app.isPackaged) return;
  const on = settings.get().launchAtLogin || (plan.isPro() && plan.status().weekly.enabled);
  if (WIN) app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
  else app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true });
}

async function weeklyCheckup() {
  const st = plan.status();
  if (st.plan !== 'pro' || !st.weekly.enabled || currentScan) return;
  if (Date.now() - (st.weekly.lastRun || 0) < config.weeklyMs) return;
  plan.setWeekly({ lastRun: Date.now() });
  try {
    const tree = await scan(defaultRoots()[0], { skip: scanSkip });
    lastTree = tree;
    updateSafe();
    const sweep = await withRecycleBin(sweepOnly(suggestions(tree)));
    const deep = await deepSuggestions(tree, deepOpts());
    const bytes = [...Object.values(sweep), ...Object.values(deep)].reduce((n, g) => n + g.total, 0);
    plan.setWeekly({ lastRun: Date.now(), lastFound: bytes });
    pushPlan();
    if (bytes > 1024 ** 3 && Notification.isSupported()) {
      const n = new Notification({ title: 'Gigapolis weekly check-up', body: `${(bytes / 1024 ** 3).toFixed(1)} GB can be cleared. Open the city to demolish it.` });
      n.on('click', () => showWindow('clean'));
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
// Same tab on both platforms. Mac: apps + their ~/Library boxes go to the
// Trash. Windows: the app's own uninstaller runs, then its AppData /
// ProgramData boxes go to the Recycle Bin (src/main/cityhall-win.js).
const CITY = ['darwin', 'win32'].includes(process.platform);
let appsCache = null;
const listAppsNow = () => (WIN ? cityhallWin.listApps(os.homedir()) : cityhall.listApps(os.homedir()));
ipcMain.handle('apps:list', async (_e, fresh) => {
  if (!CITY) return { supported: false, apps: [] };
  if (!appsCache || fresh) appsCache = listAppsNow();
  try {
    return { supported: true, apps: await appsCache };
  } catch (err) {
    appsCache = null;
    return { supported: true, apps: [], error: String(err.message || err) };
  }
});

// Moves an app and all of its files to the Trash. The file list is worked out
// again here rather than trusted from the page. Counts towards the free
// Demolish allowance like any other demolish.
ipcMain.handle('apps:uninstall', async (_e, appPath) => {
  const apps = await (appsCache || listAppsNow());
  const app = apps.find((a) => a.path === appPath);
  if (!app) return { ok: false, error: 'App not found. Rescan City Hall.' };
  if (WIN) return uninstallWin(app, apps);
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
  if (!appRes.ok) return { ok: false, error: appRes.perm || /permission|not permitted|EACCES|EPERM/i.test(appRes.error) ? 'macOS needs your password for this one. Drag it to the Bin in Finder.' : appRes.error, results };
  return { ok: true, freed: sum(sizes, results.filter((r) => r.ok).map((r) => r.path)), results };
});

async function uninstallWin(app, apps) {
  if (await cityhallWin.isRunning(app)) return { ok: false, error: `Close ${app.name} first, then move it out.` };
  const home = os.homedir();
  const before = await cityhallWin.appFiles(app, home, { others: apps });
  const blocked = plan.checkAllowance(app.size + before.reduce((n, f) => n + f.size, 0));
  if (blocked) return { ok: false, ...blocked };
  appsCache = null;
  const gone = await cityhallWin.runUninstaller(app);
  if (!gone) return { ok: false, error: `${app.name} is still installed. The uninstaller was cancelled or needs finishing.` };
  // Boxes the uninstaller left behind, plus the install folder if it is still there.
  const left = await cityhallWin.appFiles(app, home, { others: apps.filter((a) => a !== app) });
  const paths = left.map((f) => f.path).filter((p) => !protection.isProtected(p));
  if (app.installLocation && fs.existsSync(app.installLocation) && !protection.isProtected(app.installLocation)) paths.push(app.installLocation);
  const sizes = await measure(paths);
  const results = paths.length ? await trashPaths(paths) : [];
  const freed = app.size + sum(sizes, results.filter((r) => r.ok && r.path !== app.installLocation).map((r) => r.path));
  plan.recordDemolished(freed);
  pushPlan();
  const failed = results.filter((r) => !r.ok).length;
  return { ok: true, freed, results, uninstalled: true, note: failed ? `${failed} leftover folder${failed > 1 ? 's' : ''} need an admin to remove.` : '' };
}

ipcMain.handle('startup:list', async () => {
  if (!CITY) return { supported: false, items: [] };
  return { supported: true, items: WIN ? await cityhallWin.listStartup() : await cityhall.listStartup(os.homedir()) };
});

// Switch off a commuter. Mac: unload it and move its plist to the Trash (so it
// can be put back). Windows: Run-key items are switched off like Task Manager
// does (switch back on there); Startup-folder shortcuts go to the Recycle Bin.
// Only your own; ones for every user need an admin. Free plan: only ones
// Neighbourhood Watch flagged.
ipcMain.handle('startup:remove', async (_e, file) => {
  const items = WIN ? await cityhallWin.listStartup() : await cityhall.listStartup(os.homedir());
  const item = items.find((i) => i.path === file);
  if (!item) return { ok: false, error: 'Not found any more.' };
  if (!item.canRemove) return { ok: false, error: WIN ? 'This one is for every user. Switch it off in Task Manager › Startup apps.' : 'This one is for every user. Remove it in Finder with your password.' };
  if (!item.freeToRemove && !plan.isPro()) return { ok: false, error: 'pro' };
  if (WIN && item.kind === 'run') return (await cityhallWin.disableRun(item)) ? { ok: true, note: `${item.name} switched off. Switch it back on in Task Manager › Startup apps.` } : { ok: false, error: 'Windows would not switch it off.' };
  if (!WIN) await cityhall.unloadAgent(file);
  const [res] = await trashPaths([file]);
  return res.ok ? { ok: true } : { ok: false, error: res.error };
});

ipcMain.handle('startup:openSettings', () => {
  if (process.platform === 'darwin') shell.openExternal('x-apple.systempreferences:com.apple.LoginItems-Settings.extension');
  else if (WIN) shell.openExternal('ms-settings:startupapps');
  return true;
});

// --- Photo Studio: duplicate + similar photos ---------------------------------
// Scans only the home folder on the startup disk (see photos.js for what is
// skipped). Free plan: trashing photos counts toward the Demolish allowance;
// Pro: unlimited. Same on macOS and Windows (nativeImage thumbnails use
// QuickLook / the Windows shell).
let photoScan = null;
let lastPhotos = null;
const photoCacheFile = () => path.join(app.getPath('userData'), 'gigapolis-photos.json');
function loadPhotoCache() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(photoCacheFile(), 'utf8'))));
  } catch {
    return new Map();
  }
}
async function photoThumb(p, size) {
  let img = null;
  if (process.platform === 'darwin' || WIN) {
    try {
      img = await nativeImage.createThumbnailFromPath(p, { width: size, height: size });
    } catch {}
  }
  if (!img || img.isEmpty()) {
    img = nativeImage.createFromPath(p);
    if (img.isEmpty()) return null;
    const { width, height } = img.getSize();
    const k = size / Math.max(width, height);
    if (k < 1) img = img.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), quality: 'good' });
  }
  return img.isEmpty() ? null : img;
}
async function decodePhoto(p) {
  const img = await photoThumb(p, 64);
  if (!img) return null;
  const { width, height } = img.getSize();
  return { bitmap: img.toBitmap(), w: width, h: height };
}
async function photoDims(p) {
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? null : img.getSize();
}

ipcMain.handle('photos:scan', async (event) => {
  if (photoScan) photoScan.abort();
  const controller = new AbortController();
  photoScan = controller;
  const sender = event.sender;
  const cache = loadPhotoCache();
  try {
    const res = await photos.findPhotos({
      roots: [os.homedir()],
      signal: controller.signal,
      decode: decodePhoto,
      dims: photoDims,
      cache,
      onProgress: (p) => {
        if (!sender.isDestroyed()) sender.send('photos:progress', p);
      },
    });
    try {
      fs.writeFileSync(photoCacheFile(), JSON.stringify(Object.fromEntries(cache)));
    } catch {}
    lastPhotos = res;
    // Small previews for the groups (capped so the reply stays light).
    let budget = 800;
    for (const g of [...res.exact, ...res.similar])
      for (const it of g.items) {
        if (budget-- <= 0) break;
        const t = await photoThumb(it.path, 160).catch(() => null);
        if (t) it.thumb = 'data:image/jpeg;base64,' + t.toJPEG(72).toString('base64');
      }
    return res;
  } catch (err) {
    if (controller.signal.aborted) return { cancelled: true };
    throw err;
  } finally {
    if (photoScan === controller) photoScan = null;
  }
});

ipcMain.handle('photos:cancel', () => {
  if (photoScan) photoScan.abort();
  return true;
});

// Moves the chosen photos to the Trash / Recycle Bin. Checked again here: each
// photo must be in a group from the last scan, one photo of every group is
// kept, and an exact duplicate goes only if it still matches the keeper byte
// for byte.
ipcMain.handle('photos:trash', async (_e, paths) => {
  const { ok, refused } = photos.planTrash(lastPhotos, paths || []);
  const results = refused.map((r) => ({ ...r, ok: false }));
  const go = [];
  for (const item of ok) {
    if (!fs.existsSync(item.keep)) results.push({ path: item.path, ok: false, error: 'The photo you are keeping has gone. Scan photos again.' });
    else if (item.kind === 'exact' && !(await sameFile(item.path, item.keep))) results.push({ path: item.path, ok: false, error: 'Not an exact copy any more, left in place' });
    else go.push(item.path);
  }
  if (!go.length) return results;
  const sizes = await measure(go);
  const blocked = plan.checkAllowance(sum(sizes, go));
  if (blocked) return [...results, ...go.map((p) => ({ path: p, ...blocked }))];
  const done = await trashPaths(go);
  const gone = new Set(done.filter((r) => r.ok).map((r) => r.path));
  for (const g of [...lastPhotos.exact, ...lastPhotos.similar]) g.items = g.items.filter((i) => !gone.has(i.path));
  plan.recordDemolished(sum(sizes, done.filter((r) => r.ok).map((r) => r.path)));
  pushPlan();
  return [...results, ...done];
});

// --- Privacy: browser caches, history, cookies, downloads, site data --------
// The page only says which browser and which kinds; the paths are worked out
// again here. Browsers must be closed. Free: caches (count towards the
// allowance). Pro: history, download history, cookies and site data.
ipcMain.handle('privacy:list', async () => {
  try {
    return { ok: true, platform: process.platform, browsers: await browsers.listBrowsers() };
  } catch (err) {
    return { ok: false, browsers: [], error: String((err && err.message) || err) };
  }
});

ipcMain.handle('privacy:clear', async (_e, browserId, kinds) => {
  kinds = (Array.isArray(kinds) ? kinds : []).filter((k) => browsers.KINDS.includes(k));
  if (!kinds.length) return { ok: false, error: 'Nothing selected.' };
  if (!plan.isPro() && kinds.some((k) => !browsers.FREE_KINDS.has(k))) return { ok: false, error: 'pro' };
  const prep = await browsers.prepare(browserId, kinds);
  if (!prep) return { ok: false, error: 'Browser not found. Refresh the list.' };
  const procs = await browsers.runningProcesses();
  if (browsers.isRunning(prep.browser, procs)) {
    const name = prep.browser.name;
    const hint = WIN ? (prep.browser.id === 'edge' ? ' Edge can keep running in the background: turn off Startup boost in Edge settings, or end it in Task Manager.' : ` It may still be running in the system tray.`) : '';
    return { ok: false, error: `Quit ${name} first, then try again.${hint}`, running: true };
  }
  const paths = prep.files.map((f) => f.path);
  const sizes = await measure(paths);
  const blocked = plan.checkAllowance(sum(sizes, paths));
  if (blocked) return { ok: false, ...blocked };
  const trashOne = async (p) => (await trashPaths([p]))[0];
  const { results, freed } = await browsers.clear(prep, { trash: trashOne, sizes });
  plan.recordDemolished(sum(sizes, results.filter((r) => r.ok && sizes.has(r.path)).map((r) => r.path)));
  pushPlan();
  const failed = results.filter((r) => !r.ok);
  return { ok: !failed.length, freed, results, error: failed.length ? failed[0].error || 'Some items could not be cleared' : undefined, perm: failed.some((r) => r.perm) };
});

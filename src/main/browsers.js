// Browser privacy: finds the caches, history, cookies, download history and
// site data of Safari (Mac), Chrome, Edge, Brave, Arc and Firefox, and clears
// the kinds the person picks. Pure Node (no Electron import) so it can be
// tested; main.js passes in `trash` (move a path to the Trash / Recycle Bin).
//
// How each kind is cleared:
//  - Files the browser rebuilds on its own (caches, cookies, site data, Safari
//    history) go to the Trash / Recycle Bin, so they can be put back.
//  - History that shares a database with things we must keep (Firefox keeps
//    bookmarks next to history; Chromium keeps download history inside
//    History) is cleared inside the database. A copy of the original goes to
//    the Trash first, then the cleaned database replaces it.
// Browsers must be closed: a running browser is refused, never force-quit.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { sizeOf } = require('./deepclean');

const KINDS = ['cache', 'history', 'downloads', 'cookies', 'siteData'];
// Free plan: caches only. History, cookies, downloads and site data are Pro.
const FREE_KINDS = new Set(['cache']);

const exists = (p) => fsp.lstat(p).then(() => true, () => false);
async function dirs(p) {
  try {
    return (await fsp.readdir(p, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Where each browser keeps its things
// ---------------------------------------------------------------------------

const CHROMIUM = [
  // id, name, mac user-data dir (under ~/Library/Application Support), mac cache dir (under ~/Library/Caches), windows user-data dir (under %LOCALAPPDATA%), process names
  { id: 'chrome', name: 'Google Chrome', mac: 'Google/Chrome', macCache: 'Google/Chrome', win: 'Google\\Chrome\\User Data', macProc: /\/Google Chrome\.app\/Contents\/MacOS\/Google Chrome$/, winProc: 'chrome.exe' },
  { id: 'edge', name: 'Microsoft Edge', mac: 'Microsoft Edge', macCache: 'Microsoft Edge', win: 'Microsoft\\Edge\\User Data', macProc: /\/Microsoft Edge\.app\/Contents\/MacOS\/Microsoft Edge$/, winProc: 'msedge.exe' },
  { id: 'brave', name: 'Brave', mac: 'BraveSoftware/Brave-Browser', macCache: 'BraveSoftware/Brave-Browser', win: 'BraveSoftware\\Brave-Browser\\User Data', macProc: /\/Brave Browser\.app\/Contents\/MacOS\/Brave Browser$/, winProc: 'brave.exe' },
  { id: 'arc', name: 'Arc', mac: 'Arc/User Data', macCache: 'Arc/User Data', win: null, macProc: /\/Arc\.app\/Contents\/MacOS\/Arc$/, winProc: 'arc.exe' },
];
const FIREFOX = { id: 'firefox', name: 'Firefox', macProc: /\/Firefox[^/]*\.app\/Contents\/MacOS\/firefox$/, winProc: 'firefox.exe' };
const SAFARI = { id: 'safari', name: 'Safari', macProc: /\/Safari\.app\/Contents\/MacOS\/Safari$/ };

// Inside a Chromium profile folder.
const CR_CACHE = ['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'Service Worker/CacheStorage', 'Service Worker/ScriptCache', 'Application Cache', 'Media Cache'];
const CR_CACHE_TOP = ['ShaderCache', 'GrShaderCache', 'GraphiteDawnCache', 'component_crx_cache']; // next to the profiles
const CR_HISTORY = ['History', 'History-journal', 'Visited Links', 'Top Sites', 'Top Sites-journal', 'Shortcuts', 'Shortcuts-journal', 'Network Action Predictor', 'Network Action Predictor-journal', 'Favicons', 'Favicons-journal'];
const CR_COOKIES = ['Cookies', 'Cookies-journal', 'Network/Cookies', 'Network/Cookies-journal', 'Extension Cookies', 'Extension Cookies-journal', 'Safe Browsing Cookies', 'Safe Browsing Cookies-journal'];
const CR_SITE = ['Local Storage', 'Session Storage', 'IndexedDB', 'Service Worker/Database', 'File System', 'databases', 'blob_storage', 'Shared Dictionary', 'WebStorage', 'SharedStorage', 'SharedStorage-wal', 'Storage'];

// Inside a Firefox profile folder.
const FF_CACHE = ['cache2', 'startupCache', 'thumbnails', 'jumpListCache', 'OfflineCache'];
const FF_COOKIES = ['cookies.sqlite', 'cookies.sqlite-wal', 'cookies.sqlite-shm'];
const FF_SITE = ['storage/default', 'storage/temporary', 'storage/to-be-removed', 'webappsstore.sqlite', 'webappsstore.sqlite-wal', 'webappsstore.sqlite-shm'];

function locations({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const J = platform === 'win32' ? path.win32.join : path.posix.join;
  const local = env.LOCALAPPDATA || J(home, 'AppData', 'Local');
  const roaming = env.APPDATA || J(home, 'AppData', 'Roaming');
  const out = [];
  if (platform === 'darwin') {
    const sup = J(home, 'Library', 'Application Support');
    const caches = J(home, 'Library', 'Caches');
    const lib = J(home, 'Library');
    const container = J(lib, 'Containers', 'com.apple.Safari', 'Data', 'Library');
    out.push({
      ...SAFARI,
      type: 'safari',
      access: J(lib, 'Safari'), // unreadable without Full Disk Access
      cache: [J(caches, 'com.apple.Safari'), J(container, 'Caches'), J(caches, 'com.apple.WebKit.Networking'), J(caches, 'com.apple.WebKit.WebContent')],
      history: [J(lib, 'Safari', 'History.db'), J(lib, 'Safari', 'History.db-wal'), J(lib, 'Safari', 'History.db-shm'), J(lib, 'Safari', 'History.db-lock'), J(lib, 'Safari', 'RecentlyClosedTabs.plist')],
      downloads: [J(lib, 'Safari', 'Downloads.plist')],
      cookies: [J(container, 'Cookies'), J(lib, 'Cookies', 'Cookies.binarycookies'), J(lib, 'HTTPStorages', 'com.apple.Safari')],
      siteData: [J(lib, 'Safari', 'LocalStorage'), J(lib, 'Safari', 'Databases'), J(container, 'WebKit', 'WebsiteData'), J(lib, 'WebKit', 'com.apple.Safari', 'WebsiteData')],
    });
    for (const b of CHROMIUM) out.push({ ...b, type: 'chromium', root: J(sup, b.mac), cacheRoot: J(caches, b.macCache) });
    out.push({ ...FIREFOX, type: 'firefox', root: J(sup, 'Firefox', 'Profiles'), cacheRoot: J(caches, 'Firefox', 'Profiles') });
  } else if (platform === 'win32') {
    for (const b of CHROMIUM) {
      if (b.win) out.push({ ...b, type: 'chromium', root: J(local, b.win), cacheRoot: null });
      else if (b.id === 'arc') out.push({ ...b, type: 'chromium', root: null, findRoot: () => arcWindowsRoot(local), cacheRoot: null });
    }
    out.push({ ...FIREFOX, type: 'firefox', root: J(roaming, 'Mozilla', 'Firefox', 'Profiles'), cacheRoot: J(local, 'Mozilla', 'Firefox', 'Profiles') });
  }
  return out;
}

// Arc on Windows is a Store-style package: %LOCALAPPDATA%\Packages\TheBrowserCompany.Arc_<id>\LocalCache\Local\Arc\User Data
async function arcWindowsRoot(local) {
  const pk = path.win32.join(local, 'Packages');
  for (const d of await dirs(pk)) if (/^TheBrowserCompany\.Arc_/i.test(d)) return path.win32.join(pk, d, 'LocalCache', 'Local', 'Arc', 'User Data');
  return null;
}

// ---------------------------------------------------------------------------
// Databases (sql.js: plain WebAssembly, same on Mac and Windows)
// ---------------------------------------------------------------------------

let SQL = null;
async function sqlite() {
  if (!SQL) SQL = await require('sql.js')();
  return SQL;
}

/** A database is only safe to edit when nothing is waiting in its write-ahead log. */
async function walEmpty(file) {
  try {
    return (await fsp.stat(file + '-wal')).size === 0;
  } catch {
    return true;
  }
}

async function withDb(file, fn) {
  const S = await sqlite();
  const db = new S.Database(await fsp.readFile(file));
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const one = (db, sql) => {
  try {
    const r = db.exec(sql);
    return r.length && r[0].values.length ? Number(r[0].values[0][0]) || 0 : 0;
  } catch {
    return 0; // table missing in this browser version
  }
};
const tryRun = (db, sql) => {
  try {
    db.run(sql);
    return true;
  } catch {
    return false;
  }
};

// Chromium: download history lives in the History database.
const CR_DL_COUNT = 'SELECT COUNT(*) FROM downloads';
const CR_DL_BYTES = "SELECT COALESCE(SUM(LENGTH(target_path)+LENGTH(current_path)+LENGTH(IFNULL(tab_url,''))+LENGTH(IFNULL(tab_referrer_url,''))+LENGTH(IFNULL(site_url,''))+LENGTH(IFNULL(referrer,''))+LENGTH(IFNULL(mime_type,''))+120),0) FROM downloads";
const CR_DL_CHAIN_BYTES = 'SELECT COALESCE(SUM(LENGTH(url)+16),0) FROM downloads_url_chains';
const CR_DL_CLEAR = ['DELETE FROM downloads_url_chains', 'DELETE FROM downloads_slices', 'DELETE FROM downloads_reroute_info', 'DELETE FROM downloads'];

// Firefox: history and bookmarks share places.sqlite. Bookmarked places are
// kept (foreign_count > 0), everything else that was only visited goes.
const FF_DL_ATTR = "SELECT id FROM moz_anno_attributes WHERE name LIKE 'downloads/%'";
const FF_DL_COUNT = `SELECT COUNT(DISTINCT place_id) FROM moz_annos WHERE anno_attribute_id IN (${FF_DL_ATTR})`;
const FF_DL_BYTES = `SELECT COALESCE(SUM(LENGTH(content)+40),0) FROM moz_annos WHERE anno_attribute_id IN (${FF_DL_ATTR})`;
const FF_DL_CLEAR = [`DELETE FROM moz_annos WHERE anno_attribute_id IN (${FF_DL_ATTR})`, 'DELETE FROM moz_historyvisits WHERE visit_type = 7'];
const FF_HISTORY_COUNT = 'SELECT COUNT(*) FROM moz_historyvisits';
const FF_HISTORY_CLEAR = [
  'DELETE FROM moz_historyvisits',
  'DELETE FROM moz_inputhistory',
  'DELETE FROM moz_places_metadata_search_queries',
  'DELETE FROM moz_places_metadata',
  'DELETE FROM moz_annos WHERE place_id IN (SELECT id FROM moz_places WHERE foreign_count = 0)',
  'DELETE FROM moz_places WHERE foreign_count = 0',
  'UPDATE moz_places SET visit_count = 0, last_visit_date = NULL',
  'DELETE FROM moz_origins WHERE id NOT IN (SELECT origin_id FROM moz_places WHERE origin_id IS NOT NULL)',
];

// ---------------------------------------------------------------------------
// Finding things
// ---------------------------------------------------------------------------

async function sumPaths(paths) {
  const found = [];
  let size = 0;
  for (const p of paths) {
    if (!(await exists(p))) continue;
    const s = await sizeOf(p);
    found.push(p);
    size += s;
  }
  return { size, paths: found };
}

async function chromiumProfiles(root) {
  const out = [];
  for (const d of await dirs(root)) {
    if (d !== 'Default' && !/^Profile \d+$/.test(d) && d !== 'Guest Profile') continue;
    const dir = path.join(root, d);
    if (!(await exists(path.join(dir, 'Preferences')))) continue;
    let name = d;
    try {
      const prefs = JSON.parse(await fsp.readFile(path.join(dir, 'Preferences'), 'utf8'));
      if (prefs.profile && prefs.profile.name) name = prefs.profile.name;
    } catch {}
    out.push({ id: d, name, dir });
  }
  return out;
}

async function firefoxProfiles(root) {
  const out = [];
  for (const d of await dirs(root)) {
    const dir = path.join(root, d);
    if (!(await exists(path.join(dir, 'prefs.js'))) && !(await exists(path.join(dir, 'places.sqlite')))) continue;
    out.push({ id: d, name: d.replace(/^[^.]+\./, '') || d, dir });
  }
  return out;
}

/** Where each kind lives for one browser. `db` entries are cleared inside a database. */
async function plan(b) {
  const k = { cache: [], history: [], downloads: [], cookies: [], siteData: [] };
  const db = { history: [], downloads: [] }; // [{ file, engine }]
  let profiles = [];
  if (b.type === 'safari') {
    for (const kind of KINDS) k[kind] = b[kind] || [];
    profiles = [{ id: 'default', name: 'Safari' }];
  } else if (b.type === 'chromium') {
    const root = b.root || (b.findRoot && (await b.findRoot()));
    if (!root) return null;
    profiles = await chromiumProfiles(root);
    if (!profiles.length) return null;
    for (const p of profiles) {
      k.cache.push(...CR_CACHE.map((f) => path.join(p.dir, f)));
      if (b.cacheRoot) k.cache.push(path.join(b.cacheRoot, p.id));
      k.history.push(...CR_HISTORY.map((f) => path.join(p.dir, f)));
      k.cookies.push(...CR_COOKIES.map((f) => path.join(p.dir, f)));
      k.siteData.push(...CR_SITE.map((f) => path.join(p.dir, f)));
      db.downloads.push({ file: path.join(p.dir, 'History'), engine: 'chromium' });
    }
    k.cache.push(...CR_CACHE_TOP.map((f) => path.join(root, f)));
  } else if (b.type === 'firefox') {
    profiles = await firefoxProfiles(b.root);
    if (!profiles.length) return null;
    for (const p of profiles) {
      k.cache.push(...FF_CACHE.map((f) => path.join(p.dir, f)));
      if (b.cacheRoot) k.cache.push(...FF_CACHE.map((f) => path.join(b.cacheRoot, p.id, f)));
      k.cookies.push(...FF_COOKIES.map((f) => path.join(p.dir, f)));
      k.siteData.push(...FF_SITE.map((f) => path.join(p.dir, f)));
      db.history.push({ file: path.join(p.dir, 'places.sqlite'), engine: 'firefox' });
      db.downloads.push({ file: path.join(p.dir, 'places.sqlite'), engine: 'firefox' });
    }
  }
  return { k, db, profiles };
}

async function dbStats(entries, kind) {
  let size = 0;
  let count = 0;
  const files = [];
  for (const { file, engine } of entries) {
    if (!(await exists(file))) continue;
    try {
      await withDb(file, (d) => {
        if (engine === 'chromium' && kind === 'downloads') {
          count += one(d, CR_DL_COUNT);
          size += one(d, CR_DL_BYTES) + one(d, CR_DL_CHAIN_BYTES);
        } else if (engine === 'firefox' && kind === 'downloads') {
          count += one(d, FF_DL_COUNT);
          size += one(d, FF_DL_BYTES);
        } else if (engine === 'firefox' && kind === 'history') {
          count += one(d, FF_HISTORY_COUNT);
          size += fs.statSync(file).size || 0; // most of places.sqlite is history
        }
      });
      files.push(file);
    } catch {}
  }
  return { size, count, files };
}

async function runningProcesses(platform = process.platform) {
  const run = (cmd, args) => new Promise((res) => execFile(cmd, args, { timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, out) => res(err ? '' : String(out || ''))));
  if (platform === 'win32') {
    const out = await run('tasklist', ['/fo', 'csv', '/nh']);
    return out.split(/\r?\n/).map((l) => (l.match(/^"([^"]+)"/) || [])[1]).filter(Boolean).map((s) => s.toLowerCase());
  }
  if (platform === 'darwin') return (await run('/bin/ps', ['-axo', 'comm='])).split('\n').map((s) => s.trim()).filter(Boolean);
  return [];
}

function isRunning(b, procs, platform = process.platform) {
  if (platform === 'win32') return !!b.winProc && procs.includes(b.winProc);
  return !!b.macProc && procs.some((p) => b.macProc.test(p));
}

async function canRead(dir) {
  try {
    await fsp.readdir(dir);
    return true;
  } catch (e) {
    return !(e && (e.code === 'EPERM' || e.code === 'EACCES'));
  }
}

/**
 * Every installed browser with the size of each kind of data.
 * Returns [{ id, name, running, needsAccess, profiles, items: { cache: { size, count? } ... } }].
 */
async function listBrowsers(opts = {}) {
  const platform = opts.platform || process.platform;
  const procs = opts.procs || (await runningProcesses(platform));
  const out = [];
  for (const b of opts.browsers || locations(opts)) {
    if (b.type === 'safari' && !(await canRead(b.access))) {
      out.push({ id: b.id, name: b.name, running: isRunning(b, procs, platform), needsAccess: true, profiles: 1, items: {} });
      continue;
    }
    const p = await plan(b);
    if (!p) continue;
    const items = {};
    for (const kind of KINDS) {
      const files = await sumPaths(p.k[kind]);
      const inDb = p.db[kind] ? await dbStats(p.db[kind], kind) : { size: 0, count: 0, files: [] };
      const size = files.size + inDb.size;
      const found = files.paths.length + inDb.files.length;
      if (!found) continue;
      items[kind] = p.db[kind] && p.db[kind].length ? { size, count: inDb.count } : { size };
    }
    if (b.type === 'safari' && !Object.keys(items).length) continue; // Safari never opened
    // Chromium's download history is inside History: clearing history clears it too.
    out.push({ id: b.id, name: b.name, running: isRunning(b, procs, platform), needsAccess: false, profiles: p.profiles.length, historyIncludesDownloads: b.type === 'chromium', items });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Clearing
// ---------------------------------------------------------------------------

/** Clears rows in a database: original copy to the Trash, cleaned copy swapped in. */
async function editDb(file, statements, { trash, label, tmpDir = os.tmpdir() }) {
  if (!(await exists(file))) return { ok: true, freed: 0 };
  if (!(await walEmpty(file))) return { ok: false, error: 'busy' };
  const before = (await fsp.stat(file)).size;
  const data = await withDb(file, (d) => {
    for (const s of statements) tryRun(d, s);
    tryRun(d, 'VACUUM');
    return Buffer.from(d.export());
  });
  // Keep the original in the Trash so it can be put back.
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const backupDir = await fsp.mkdtemp(path.join(tmpDir, 'gigapolis-'));
  const backup = path.join(backupDir, `${label} before Gigapolis ${stamp}${path.extname(file) || '.db'}`);
  await fsp.copyFile(file, backup);
  const tr = await trash(backup);
  await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {});
  if (!tr || !tr.ok) return { ok: false, error: (tr && tr.error) || 'Could not put a backup in the Trash' };
  const tmp = file + '.gigapolis-tmp';
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
  for (const side of ['-wal', '-shm', '-journal']) {
    try {
      if ((await fsp.stat(file + side)).size === 0) await fsp.unlink(file + side);
    } catch {}
  }
  return { ok: true, freed: Math.max(0, before - data.length) };
}

/**
 * Works out exactly what `kinds` means for one browser: file paths for the
 * Trash and database edits. Used by main.js both to size a request (for the
 * free allowance) and to carry it out.
 */
async function prepare(browserId, kinds, opts = {}) {
  const b = (opts.browsers || locations(opts)).find((x) => x.id === browserId);
  if (!b) return null;
  const p = await plan(b);
  if (!p) return null;
  const want = new Set(kinds.filter((k) => KINDS.includes(k)));
  // Chromium download history is part of History, so history implies downloads.
  if (b.type === 'chromium' && want.has('history')) want.delete('downloads');
  const files = [];
  const edits = [];
  for (const kind of want) {
    const f = await sumPaths(p.k[kind]);
    files.push(...f.paths.map((x) => ({ path: x, kind })));
    for (const e of p.db[kind] || []) {
      if (!(await exists(e.file))) continue;
      const stmts = e.engine === 'chromium' ? CR_DL_CLEAR : kind === 'history' ? [...FF_DL_CLEAR, ...FF_HISTORY_CLEAR] : FF_DL_CLEAR;
      const prev = edits.find((x) => x.file === e.file);
      if (prev) prev.statements.push(...stmts.filter((s) => !prev.statements.includes(s)));
      else edits.push({ file: e.file, kind, engine: e.engine, statements: [...stmts] });
    }
  }
  // Firefox: one edit of places.sqlite covers both history and downloads.
  for (const e of edits) if (e.statements.some((s) => FF_HISTORY_CLEAR.includes(s))) e.kind = 'history';
  return { browser: b, files, edits };
}

async function clear(prep, { trash, sizes, tmpDir }) {
  const results = [];
  let freed = 0;
  for (const f of prep.files) {
    const r = await trash(f.path);
    results.push({ ...f, ...r });
    if (r.ok) freed += (sizes && sizes.get(f.path)) || 0;
  }
  for (const e of prep.edits) {
    const label = `${prep.browser.name} ${e.kind === 'history' ? 'history' : 'download history'}`;
    let r;
    try {
      r = await editDb(e.file, e.statements, { trash, label, tmpDir });
    } catch (err) {
      r = { ok: false, error: String((err && err.message) || err) };
    }
    if (r.error === 'busy') r.error = `${prep.browser.name} is still writing its history. Quit it and try again.`;
    results.push({ path: e.file, kind: e.kind, ...r });
    if (r.ok) freed += r.freed || 0;
  }
  return { results, freed };
}

module.exports = { KINDS, FREE_KINDS, locations, listBrowsers, prepare, clear, editDb, isRunning, runningProcesses, chromiumProfiles, firefoxProfiles };

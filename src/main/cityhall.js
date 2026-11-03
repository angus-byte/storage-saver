// City Hall: the apps that live in the city (Moving Day: uninstall an app with
// all of its files) and the commuters that start with the Mac (Rush Hour:
// launch agents, with a Neighbourhood Watch check for suspicious ones).
// Pure Node (macOS tools are called via execFile) so it can be tested.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { sizeOf } = require('./deepclean');

const DAY = 86400000;

function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => resolve({ ok: !err, out: String(stdout || '') }));
  });
}

async function readPlist(file) {
  const r = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], 4000);
  if (!r.ok) return null;
  try {
    return JSON.parse(r.out);
  } catch {
    return null;
  }
}

/** Disk usage in bytes. `du` is much faster than walking big app bundles in JS. */
async function duBytes(p) {
  const r = await run('/usr/bin/du', ['-sk', p], 20000);
  const kb = r.ok && parseInt(r.out, 10);
  return Number.isFinite(kb) && kb > 0 ? kb * 1024 : sizeOf(p);
}

const exists = (p) => fsp.lstat(p).then(() => true, () => false);

// ---------------------------------------------------------------------------
// Moving Day: apps and the boxes they leave behind
// ---------------------------------------------------------------------------

// [folder under ~/Library, how entries are matched]
//  'id'   entry is the bundle id, or starts with "<id>." (e.g. com.foo.savedState, com.foo.plist)
//  'name' entry is exactly the app's name
//  'group' entry ends with the bundle id or its team prefix group (Group Containers)
const LEFTOVER_PLACES = [
  ['Application Support', ['id', 'name']],
  ['Caches', ['id', 'name']],
  ['Containers', ['id']],
  ['Group Containers', ['group']],
  ['Preferences', ['id']],
  ['Saved Application State', ['id']],
  ['Logs', ['id', 'name']],
  ['HTTPStorages', ['id']],
  ['WebKit', ['id']],
  ['Cookies', ['id']],
  ['Application Scripts', ['id']],
  ['LaunchAgents', ['id']],
];

/** Does a ~/Library entry belong to this app? Strict on purpose: no fuzzy name matches. */
function matchesApp(entry, rules, app) {
  const e = entry.toLowerCase();
  const id = (app.bundleId || '').toLowerCase();
  const name = (app.name || '').toLowerCase();
  for (const r of rules) {
    if (r === 'id' && id && (e === id || e.startsWith(id + '.'))) return true;
    if (r === 'name' && name.length > 2 && e === name) return true;
    if (r === 'group' && id && (e.endsWith('.' + id) || e === 'group.' + id)) return true;
  }
  return false;
}

/** Support files, caches, settings etc. an app keeps in ~/Library. */
async function appFiles(app, home) {
  const out = [];
  if (!app.bundleId || /^com\.apple\./i.test(app.bundleId)) return out;
  const lib = path.join(home, 'Library');
  for (const [dir, rules] of LEFTOVER_PLACES) {
    const root = path.join(lib, dir);
    let entries = [];
    try {
      entries = await fsp.readdir(root);
    } catch {}
    for (const e of entries) {
      if (!matchesApp(e, rules, app)) continue;
      const p = path.join(root, e);
      out.push({ name: `${dir} › ${e}`, path: p, size: await sizeOf(p) });
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

async function lastUsed(appPath) {
  const r = await run('/usr/bin/mdls', ['-raw', '-name', 'kMDItemLastUsedDate', appPath], 4000);
  const t = r.ok ? Date.parse(r.out.trim().replace(' +0000', 'Z').replace(' ', 'T')) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** Apps the person installed (Apple's own are left out: macOS protects them). */
async function listApps(home, { now = Date.now(), dirs } = {}) {
  dirs = dirs || ['/Applications', path.join(home, 'Applications')];
  const apps = [];
  for (const d of dirs) {
    let entries = [];
    try {
      entries = await fsp.readdir(d);
    } catch {}
    for (const e of entries) {
      if (!e.endsWith('.app')) continue;
      const appPath = path.join(d, e);
      const info = (await readPlist(path.join(appPath, 'Contents', 'Info.plist'))) || {};
      const bundleId = info.CFBundleIdentifier || '';
      if (/^com\.apple\./i.test(bundleId)) continue;
      const name = e.slice(0, -4);
      const app = { name, path: appPath, bundleId, version: info.CFBundleShortVersionString || '' };
      const [size, files, used] = await Promise.all([duBytes(appPath), appFiles(app, home), lastUsed(appPath)]);
      const filesSize = files.reduce((n, f) => n + f.size, 0);
      const lastUsedAt = used || 0;
      apps.push({ ...app, size, files, filesSize, total: size + filesSize, lastUsed: lastUsedAt, unused: !!lastUsedAt && now - lastUsedAt > 180 * DAY, appStore: await exists(path.join(appPath, 'Contents', '_MASReceipt')) });
    }
  }
  return apps.sort((a, b) => b.total - a.total);
}

/** Is the app running right now? (Its files should not be moved while it is.) */
async function isRunning(appPath) {
  const r = await run('/bin/ps', ['-axo', 'comm='], 4000);
  return r.ok && r.out.split('\n').some((l) => l.startsWith(appPath + '/'));
}

// ---------------------------------------------------------------------------
// Rush Hour: things that start with the Mac
// ---------------------------------------------------------------------------

// Well-known adware / scareware families seen in launch agents. A match is a
// strong hint, not proof; the person always decides.
const ADWARE = /(genieo|installmac|vsearch|conduit|spigot|crossrider|pirrit|bundlore|adload|shlayer|mughthesec|mackeeper|advancedmaccleaner|searchmine|searchbaron|searchpulse|chumsearch|safefinder|operatorsearch|webtools|mapsgalaxy|myshopcoupon|amc\.)/i;
const ODD_PLACE = /^(\/tmp\/|\/private\/tmp\/|\/var\/tmp\/|\/users\/shared\/)/i;

/** Human name for a launch agent label: com.google.keystone.agent → Google Keystone Agent. */
function friendlyName(label) {
  const parts = String(label).split('.').filter((p) => !/^(com|org|net|io|co|app|de|uk|launchd|plist|\d+)$/i.test(p));
  return (parts.length ? parts : [label]).map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

/**
 * Neighbourhood Watch flags for one launch agent. `signed` is true / false / null (unknown).
 * ghost: the program it runs is gone. adware: known adware name. hidden: hidden file or odd place.
 * unsigned: the program is not code-signed.
 */
function watchFlags({ file, label, program, programExists, signed }) {
  const flags = [];
  if (program && !programExists) flags.push('ghost');
  if (ADWARE.test(label || '') || ADWARE.test(program || '') || ADWARE.test(path.basename(file || ''))) flags.push('adware');
  if (path.basename(file || '').startsWith('.') || ODD_PLACE.test(program || '') || /\/\.[^/]+\//.test(program || '')) flags.push('hidden');
  if (programExists && signed === false) flags.push('unsigned');
  return flags;
}

/** Flags that make an item safe to switch off on the free plan. */
const FREE_FLAGS = new Set(['ghost', 'adware', 'hidden']);
const freeToRemove = (flags) => flags.some((f) => FREE_FLAGS.has(f));

async function isSigned(program) {
  if (!program) return null;
  const r = await run('/usr/bin/codesign', ['-v', program], 6000);
  return r.ok;
}

async function loadedLabels() {
  const r = await run('/bin/launchctl', ['list'], 4000);
  const map = new Map();
  if (!r.ok) return map;
  for (const line of r.out.split('\n').slice(1)) {
    const [pid, , label] = line.split('\t');
    if (label) map.set(label.trim(), pid && pid !== '-' ? Number(pid) : 0);
  }
  return map;
}

async function listStartup(home, { dirs, check = isSigned, loaded } = {}) {
  dirs = dirs || [
    [path.join(home, 'Library', 'LaunchAgents'), 'you'],
    ['/Library/LaunchAgents', 'all'],
    ['/Library/LaunchDaemons', 'system'],
  ];
  const running = loaded || (await loadedLabels());
  const out = [];
  for (const [dir, scope] of dirs) {
    let entries = [];
    try {
      entries = await fsp.readdir(dir);
    } catch {}
    for (const e of entries) {
      if (!e.endsWith('.plist')) continue;
      const file = path.join(dir, e);
      const info = (await readPlist(file)) || {};
      const label = info.Label || e.replace(/\.plist$/, '');
      const program = info.Program || (Array.isArray(info.ProgramArguments) ? info.ProgramArguments[0] : '') || '';
      const programExists = program ? await exists(program) : false;
      const signed = programExists ? await check(program) : null;
      const flags = watchFlags({ file, label, program, programExists, signed });
      out.push({
        name: friendlyName(label),
        label,
        path: file,
        program,
        scope, // you = ~/Library (can switch off), all/system = needs an admin password
        runAtLoad: !!info.RunAtLoad,
        keepAlive: !!info.KeepAlive,
        disabled: !!info.Disabled,
        running: running.has(label) ? running.get(label) > 0 : false,
        flags,
        freeToRemove: freeToRemove(flags),
        canRemove: scope === 'you',
      });
    }
  }
  const rank = (i) => (i.flags.includes('adware') ? 0 : i.flags.length ? 1 : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/** Stops a user launch agent (if loaded) before its plist goes to the Trash. */
async function unloadAgent(file) {
  const uid = process.getuid ? process.getuid() : 0;
  const r = await run('/bin/launchctl', ['bootout', `gui/${uid}`, file], 6000);
  if (!r.ok) await run('/bin/launchctl', ['unload', file], 6000);
}

module.exports = { listApps, appFiles, matchesApp, isRunning, listStartup, watchFlags, freeToRemove, friendlyName, unloadAgent, LEFTOVER_PLACES };

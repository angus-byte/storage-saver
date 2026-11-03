// Deep Clean (Pro): finds the space a surface sweep misses. Runs after the
// normal scan, using the scanned tree plus a few well-known folders.
// Pure Node so it can be tested; nothing here deletes anything.
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { collect } = require('./scanner');

const DAY = 86400000;
const MB = 1024 ** 2;

// Folder names editing apps rebuild on demand (Final Cut, Premiere, Resolve, Audition).
const RENDER_DIRS = new Set(['render files', 'media cache files', 'media cache', 'cacheclip', 'peak files', 'analysis files']);
const INSTALLER_EXT = /\.(dmg|pkg|iso|xip|mpkg)$/i;
// Apple's own Application Support folders, never offered as leftovers.
const SUPPORT_KEEP = /^(com\.apple|apple|addressbook|callhistory|clouddocs|crashreporter|dock|filefileprovider|fileprovider|icloud|knowledge|mobilesync|quick ?look|sync ?services|ubiquity|accounts|animoji|cloudkit|contextstore|default|familycircle|homekit|identityservices|siri|spotlight|text ?replacement|videoconference|networkserviceproxy|com\.microsoft\.autoupdate)/i;

const lc = (p) => p.replace(/\\/g, '/').toLowerCase();
const strip = (n, extra = {}) => ({ name: n.name, path: n.path, size: n.size, kind: n.kind || 'cache', mtime: n.mtime || 0, isDir: !!n.isDir, ...extra });
const total = (list) => list.reduce((s, n) => s + n.size, 0);
const group = (items, limit = 100) => ({ items: items.slice(0, limit), total: total(items) });

/** Paths that belong to Deep Clean, so Street Sweep leaves them alone. */
function isDeepPath(p) {
  const s = lc(p) + '/';
  if (s.includes('/node_modules/') || s.includes('/deriveddata/') || s.includes('/library/logs/') || s.includes('/library/developer/')) return true;
  return s.split('/').some((seg) => RENDER_DIRS.has(seg));
}

/** Total bytes under a path (files counted once, symlinks not followed). */
async function sizeOf(p) {
  let st;
  try {
    st = await fsp.lstat(p);
  } catch {
    return 0;
  }
  if (st.isSymbolicLink()) return 0;
  if (!st.isDirectory()) return st.size;
  let size = 0;
  const stack = [p];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) {
        try {
          size += (await fsp.lstat(full)).size;
        } catch {}
      }
    }
  }
  return size;
}

async function newestMtime(p) {
  try {
    return (await fsp.stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}

/** Fingerprint from size + three 1 MB samples: cheap way to find candidate twins. */
async function sampleHash(file, size) {
  const h = crypto.createHash('sha1');
  h.update(String(size));
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(MB, size));
    for (const pos of [0, Math.max(0, Math.floor(size / 2) - buf.length / 2), Math.max(0, size - buf.length)]) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      h.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await fh.close();
  }
  return h.digest('hex');
}

function fullHash(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}

/** True only if both files exist and are byte-identical. Run before trashing a duplicate. */
async function sameFile(a, b) {
  if (!a || !b || a === b) return false;
  try {
    const [sa, sb] = await Promise.all([fsp.stat(a), fsp.stat(b)]);
    if (!sa.isFile() || !sb.isFile() || sa.size !== sb.size) return false;
    if (sa.dev === sb.dev && sa.ino === sb.ino) return false; // same file via a hard link
    const [ha, hb] = await Promise.all([fullHash(a), fullHash(b)]);
    return ha === hb;
  } catch {
    return false;
  }
}

async function findDuplicates(tree, minSize = 50 * MB) {
  const files = collect(tree, (n) => !n.isDir && !n.aggregate && n.size >= minSize);
  const bySize = new Map();
  for (const f of files) bySize.set(f.size, [...(bySize.get(f.size) || []), f]);
  const out = [];
  for (const same of bySize.values()) {
    if (same.length < 2) continue;
    const byHash = new Map();
    for (const f of same) {
      try {
        const k = await sampleHash(f.path, f.size);
        byHash.set(k, [...(byHash.get(k) || []), f]);
      } catch {}
    }
    for (const twins of byHash.values()) {
      if (twins.length < 2) continue;
      // Keep the oldest copy (most likely the original); offer the rest.
      twins.sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
      const keep = twins[0];
      for (const extra of twins.slice(1)) out.push(strip(extra, { keep: keep.path, note: `Copy of ${keep.path}` }));
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

function readPlistJson(file) {
  return new Promise((resolve) => {
    execFile('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { timeout: 4000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

/** Names and bundle ids of installed apps (macOS). */
async function installedApps(home) {
  const dirs = ['/Applications', '/Applications/Utilities', '/System/Applications', '/System/Applications/Utilities', path.join(home, 'Applications')];
  const names = new Set();
  const ids = new Set();
  for (const d of dirs) {
    let entries = [];
    try {
      entries = await fsp.readdir(d);
    } catch {}
    for (const e of entries) {
      if (!e.endsWith('.app')) continue;
      names.add(e.slice(0, -4).toLowerCase());
      const info = await readPlistJson(path.join(d, e, 'Contents', 'Info.plist'));
      if (info && info.CFBundleIdentifier) ids.add(info.CFBundleIdentifier.toLowerCase());
      if (info && info.CFBundleName) names.add(String(info.CFBundleName).toLowerCase());
    }
  }
  return { names, ids };
}

function belongsToApp(folder, apps) {
  const f = folder.toLowerCase();
  if (apps.ids.has(f)) return true;
  for (const id of apps.ids) if (f.startsWith(id) || id.startsWith(f + '.')) return true;
  for (const n of apps.names) {
    const first = n.split(/\s+/)[0];
    if (n === f || n.includes(f) || f.includes(n) || (first.length > 3 && f.startsWith(first))) return true;
  }
  return false;
}

async function appLeftovers(home, now, listApps = installedApps) {
  const apps = await listApps(home);
  if (!apps.names.size) return [];
  const out = [];
  const roots = [path.join(home, 'Library', 'Application Support'), path.join(home, 'Library', 'Containers')];
  for (const root of roots) {
    let entries = [];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      if (!e.isDirectory() || SUPPORT_KEEP.test(e.name) || belongsToApp(e.name, apps)) continue;
      const p = path.join(root, e.name);
      const mtime = await newestMtime(p);
      if (now - mtime < 90 * DAY) continue;
      const size = await sizeOf(p);
      if (size < 20 * MB) continue;
      out.push({ name: e.name, path: p, size, kind: 'apps', mtime, isDir: true, note: 'No matching app installed' });
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

async function iosBackups(home, now) {
  const root = path.join(home, 'Library', 'Application Support', 'MobileSync', 'Backup');
  let entries = [];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {}
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const p = path.join(root, e.name);
    const info = await readPlistJson(path.join(p, 'Info.plist'));
    const mtime = (info && Date.parse(info['Last Backup Date'])) || (await newestMtime(p));
    if (now - mtime < 30 * DAY) continue;
    const size = await sizeOf(p);
    if (!size) continue;
    const device = (info && (info['Device Name'] || info['Display Name'])) || 'iPhone / iPad';
    out.push({ name: `${device} backup`, path: p, size, kind: 'other', mtime, isDir: true, note: `Last backed up ${new Date(mtime).toLocaleDateString()}` });
  }
  return out.sort((a, b) => b.size - a.size);
}

async function devJunk(tree, home, now) {
  const fixed = [
    ['Xcode DerivedData', 'Library/Developer/Xcode/DerivedData'],
    ['Old iOS device support', 'Library/Developer/Xcode/iOS DeviceSupport'],
    ['Simulator caches', 'Library/Developer/CoreSimulator/Caches'],
    ['npm cache', '.npm/_cacache'],
    ['Yarn cache', 'Library/Caches/Yarn'],
    ['Homebrew downloads', 'Library/Caches/Homebrew'],
    ['Gradle caches', '.gradle/caches'],
    ['pip cache', 'Library/Caches/pip'],
    ['CocoaPods cache', 'Library/Caches/CocoaPods'],
  ];
  const out = [];
  for (const [name, rel] of fixed) {
    const p = path.join(home, rel);
    const size = await sizeOf(p);
    if (size > 20 * MB) out.push({ name, path: p, size, kind: 'cache', mtime: await newestMtime(p), isDir: true, mode: 'empty', note: 'Rebuilt automatically' });
  }
  // Top-level node_modules of projects not touched for a month.
  const seen = [];
  collect(tree, (n) => {
    if (n.isDir && n.name === 'node_modules' && !seen.some((s) => n.path.startsWith(s + path.sep))) {
      seen.push(n.path);
      if (n.size > 20 * MB && now - (n.mtime || 0) > 30 * DAY) out.push(strip(n, { name: `${path.basename(path.dirname(n.path))}/node_modules`, note: 'npm install brings it back' }));
    }
    return false;
  });
  return out.sort((a, b) => b.size - a.size);
}

async function logsAndInstallers(tree, home, now) {
  const out = [];
  const logs = path.join(home, 'Library', 'Logs');
  const size = await sizeOf(logs);
  if (size > 10 * MB) out.push({ name: 'App logs', path: logs, size, kind: 'cache', mtime: await newestMtime(logs), isDir: true, mode: 'empty', note: 'Old diagnostic logs' });
  // Installers outside Downloads (Downloads is already in Street Sweep).
  const inst = collect(tree, (n) => !n.isDir && !n.aggregate && INSTALLER_EXT.test(n.name) && !lc(n.path).includes('/downloads/') && now - (n.mtime || 0) > 14 * DAY);
  for (const n of inst) out.push(strip(n, { kind: 'downloads', note: 'Installer, the app is already set up' }));
  return out.sort((a, b) => b.size - a.size);
}

function renderCaches(tree) {
  const seen = [];
  const out = [];
  collect(tree, (n) => {
    if (n.isDir && RENDER_DIRS.has(n.name.toLowerCase()) && n.size > 0 && !seen.some((s) => n.path.startsWith(s + path.sep))) {
      seen.push(n.path);
      const parent = path.basename(path.dirname(n.path));
      out.push(strip(n, { name: `${parent} › ${n.name}`, mode: 'empty', note: 'Your editing app rebuilds these when needed' }));
    }
    return false;
  });
  return out.sort((a, b) => b.size - a.size);
}

/** All Deep Clean groups for a scanned tree. */
async function deepSuggestions(tree, { home = require('os').homedir(), now = Date.now(), platform = process.platform, listApps } = {}) {
  const mac = platform === 'darwin';
  const [render, dups, leftovers, backups, dev, logs] = await Promise.all([
    renderCaches(tree),
    findDuplicates(tree),
    mac ? appLeftovers(home, now, listApps) : [],
    mac ? iosBackups(home, now) : [],
    devJunk(tree, home, now),
    logsAndInstallers(tree, home, now),
  ]);
  return {
    renderCaches: group(render),
    duplicates: group(dups),
    appLeftovers: group(leftovers),
    iosBackups: group(backups),
    devJunk: group(dev),
    logsInstallers: group(logs),
  };
}

/** Street Sweep minus anything Deep Clean owns, so nothing is listed twice. */
function sweepOnly(sugg) {
  const out = {};
  for (const [k, g] of Object.entries(sugg)) {
    const items = g.items.filter((i) => !isDeepPath(i.path));
    out[k] = { items, total: items.length === g.items.length ? g.total : total(items) };
  }
  return out;
}

module.exports = { deepSuggestions, sweepOnly, isDeepPath, sizeOf, sameFile, findDuplicates, belongsToApp, renderCaches };

// Disk scanner: walks a folder tree, aggregates sizes, and returns a trimmed
// tree suitable for rendering. Pure Node, no Electron dependency (testable).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const MEDIA_EXT = new Set([
  'mp4', 'mov', 'mxf', 'r3d', 'braw', 'avi', 'mkv', 'prores', 'wav', 'aif', 'aiff',
  'mp3', 'flac', 'jpg', 'jpeg', 'png', 'raw', 'cr2', 'cr3', 'arw', 'dng', 'tif', 'tiff', 'psd',
]);
const INSTALLER_EXT = new Set(['dmg', 'pkg', 'exe', 'msi', 'zip', 'iso', 'tar', 'gz', '7z', 'rar']);
const APP_EXT = new Set(['app', 'exe']);
const DOC_EXT = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'md', 'pages', 'key', 'numbers', 'prproj', 'drp', 'fcpbundle']);

const CACHE_MARKERS = ['/library/caches/', '/appdata/local/temp/', '/node_modules/', '/.cache/', '/caches/', '/.npm/', '/derived data/', '/deriveddata/', '/.gradle/', '/temp/', '/tmp/', '/cache/', '/com.apple.bird/', '/logs/'];
const TRASH_MARKERS = ['/.trash/', '/$recycle.bin/'];
// Only these cache places are offered to Safe Clean. The generic CACHE_MARKERS
// above colour the city, but a person's own "Logs", "Temp" or "Cache" folder
// (e.g. ~/Documents/Client Logs) must never be emptied by a one-click sweep.
const SAFE_CACHE_MARKERS = ['/library/caches/', '/appdata/local/temp/', '/appdata/local/microsoft/windows/inetcache/', '/.cache/', '/.npm/_cacache/', '/com.apple.bird/'];
function isSafeCache(fullPath) {
  const p = fullPath.replace(/\\/g, '/').toLowerCase() + '/';
  return SAFE_CACHE_MARKERS.some((m) => p.includes(m));
}
const SYSTEM_MARKERS = ['/system/', '/windows/', '/private/var/', '/usr/', '/library/apple/', '/program files/'];

// File types for grouping folders into city categories. Must match
// TYPE_EXT / BUNDLE_TYPE in src/renderer/categories.js (a test checks).
const TYPE_EXT = {
  video: 'mp4 mov mxf r3d braw avi mkv m4v webm mts m2ts prores mpg mpeg wmv flv 3gp',
  photo: 'jpg jpeg png heic heif raw cr2 cr3 arw dng tif tiff psd gif nef raf orf rw2 bmp webp svg ai',
  audio: 'wav aif aiff mp3 flac m4a aac ogg opus alac caf mid midi',
  doc: 'pdf doc docx xls xlsx ppt pptx txt md rtf pages key numbers csv epub odt ods prproj drp aep fdx',
  archive: 'dmg pkg zip iso tar gz tgz 7z rar bz2 xz img',
  app: 'app exe msi',
  code: 'js ts jsx tsx py rb go rs c h cpp hpp m swift java kt php cs sh',
};
const EXT_TYPE = {};
for (const [t, list] of Object.entries(TYPE_EXT)) for (const e of list.split(' ')) EXT_TYPE[e] = t;
const BUNDLE_TYPE = { photoslibrary: 'photo', fcpbundle: 'video', imovielibrary: 'video', fcpxproject: 'video', logicx: 'audio', band: 'audio', app: 'app', xcodeproj: 'code' };
const DEV_MARKERS = new Set(['.git', 'node_modules', 'package.json', 'cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'gemfile', 'requirements.txt', 'pyproject.toml', 'makefile']);
const addType = (t, k, v) => (t[k] = (t[k] || 0) + v);

function ext(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

/**
 * Category for a path. Used for colouring in the 3D view and cleanup rules.
 * @returns {'cache'|'trash'|'downloads'|'media'|'apps'|'documents'|'system'|'other'}
 */
function classify(fullPath, isDir, name) {
  const p = (fullPath.replace(/\\/g, '/') + (isDir ? '/' : '')).toLowerCase();
  if (TRASH_MARKERS.some((m) => p.includes(m))) return 'trash';
  if (CACHE_MARKERS.some((m) => p.includes(m))) return 'cache';
  if (p.includes('/downloads/')) return 'downloads';
  if (SYSTEM_MARKERS.some((m) => p.includes(m))) return 'system';
  const e = ext(name || path.basename(fullPath));
  if (!isDir) {
    if (MEDIA_EXT.has(e)) return 'media';
    if (INSTALLER_EXT.has(e)) return 'downloads';
    if (APP_EXT.has(e)) return 'apps';
    if (DOC_EXT.has(e)) return 'documents';
  } else {
    if (e === 'app' || p.includes('/applications/')) return 'apps';
    if (e === 'fcpbundle' || e === 'photoslibrary' || e === 'imovielibrary') return 'media';
  }
  return 'other';
}

/**
 * Recursively scan `root`. Returns a tree of {name, path, size, kind, isDir, mtime, children}.
 * options: { onProgress(fn), maxDepth, keepFileMin (bytes), maxChildren, signal }
 */
async function scan(root, options = {}) {
  const {
    onProgress = () => {},
    maxDepth = 12,
    keepFileMin = 20 * 1024 * 1024, // files smaller than this are folded into "Small files"
    maxChildren = 40,
    signal,
    skip = () => null, // (dirPath) => truthy to leave a folder out (cloud / other drives)
  } = options;
  const skipped = [];
  let scannedFiles = 0;
  let scannedBytes = 0;
  let lastProgress = 0;
  let visitedInodes = new Set();

  async function walk(dir, depth) {
    if (signal && signal.aborted) throw new Error('aborted');
    const node = { name: path.basename(dir) || dir, path: dir, size: 0, isDir: true, kind: classify(dir, true), mtime: 0, children: [], files: 0, types: {} };
    let devMarked = false;
    const smallTypes = {};
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      node.error = 'unreadable';
      return node;
    }
    let smallSize = 0;
    let smallCount = 0;
    let newestSmall = 0;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (DEV_MARKERS.has(entry.name.toLowerCase())) devMarked = true;
      if (entry.isDirectory()) {
        const why = skip(full);
        if (why) {
          skipped.push({ path: full, name: entry.name, ...why });
          continue;
        }
        if (depth >= maxDepth) {
          // Too deep to detail: size it flat.
          const flat = await sizeFlat(full);
          smallSize += flat.size;
          smallCount += flat.files;
          node.files += flat.files;
          node.size += flat.size;
          addType(smallTypes, BUNDLE_TYPE[ext(entry.name)] || 'other', flat.size);
          addType(node.types, BUNDLE_TYPE[ext(entry.name)] || 'other', flat.size);
          continue;
        }
        const child = await walk(full, depth + 1);
        node.size += child.size;
        node.files += child.files;
        node.mtime = Math.max(node.mtime, child.mtime);
        for (const [k, v] of Object.entries(child.types)) addType(node.types, k, v);
        if (child.size > 0) node.children.push(child);
        // A top-level folder is complete: tell the UI so it can raise its building now.
        if (depth === 0 && child.size > 0) onProgress({ files: scannedFiles, bytes: scannedBytes, current: full, done: { name: child.name, path: child.path, size: child.size, kind: child.kind, isDir: true, files: child.files } });
      } else if (entry.isFile()) {
        let st;
        try {
          st = await fsp.stat(full);
        } catch {
          continue;
        }
        // Hard links: count each inode once.
        if (st.nlink > 1) {
          const key = `${st.dev}:${st.ino}`;
          if (visitedInodes.has(key)) continue;
          visitedInodes.add(key);
        }
        scannedFiles++;
        scannedBytes += st.size;
        node.size += st.size;
        node.files += 1;
        node.mtime = Math.max(node.mtime, st.mtimeMs);
        const ftype = EXT_TYPE[ext(entry.name)] || 'other';
        addType(node.types, ftype, st.size);
        if (st.size >= keepFileMin) {
          const leaf = { name: entry.name, path: full, size: st.size, isDir: false, kind: classify(full, false, entry.name), mtime: st.mtimeMs, files: 1, types: { [ftype]: st.size } };
          node.children.push(leaf);
          if (depth === 0) onProgress({ files: scannedFiles, bytes: scannedBytes, current: full, done: leaf });
        } else {
          smallSize += st.size;
          smallCount += 1;
          addType(smallTypes, ftype, st.size);
          newestSmall = Math.max(newestSmall, st.mtimeMs);
        }
      }
      const now = Date.now();
      if (now - lastProgress > 150) {
        lastProgress = now;
        onProgress({ files: scannedFiles, bytes: scannedBytes, current: full });
      }
    }
    // Bundles (Photos library, app) and code projects count as one type.
    const whole = BUNDLE_TYPE[ext(node.name)] || (devMarked ? 'code' : null);
    if (whole) node.types = { [whole]: node.size };
    if (smallSize > 0) {
      node.children.push({ name: `${smallCount.toLocaleString()} small files`, path: dir, size: smallSize, isDir: false, kind: node.kind, mtime: newestSmall, files: smallCount, aggregate: true, types: whole ? { [whole]: smallSize } : smallTypes });
    }
    node.children.sort((a, b) => b.size - a.size);
    if (node.children.length > maxChildren) {
      const rest = node.children.splice(maxChildren - 1);
      const restSize = rest.reduce((s, c) => s + c.size, 0);
      const restFiles = rest.reduce((s, c) => s + (c.files || 0), 0);
      const restTypes = {};
      for (const c of rest) for (const [k, v] of Object.entries(c.types || {})) addType(restTypes, k, v);
      node.children.push({ name: `${rest.length} other items`, path: dir, size: restSize, isDir: false, kind: node.kind, mtime: 0, files: restFiles, aggregate: true, types: restTypes });
    }
    return node;
  }

  async function sizeFlat(dir) {
    let size = 0;
    let files = 0;
    const stack = [dir];
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
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) {
          if (!skip(full)) stack.push(full);
        }
        else if (e.isFile()) {
          try {
            const st = await fsp.stat(full);
            size += st.size;
            files += 1;
            scannedFiles++;
            scannedBytes += st.size;
          } catch {}
        }
      }
    }
    return { size, files };
  }

  const tree = await walk(path.resolve(root), 0);
  tree.skipped = skipped;
  onProgress({ files: scannedFiles, bytes: scannedBytes, current: root, done: true });
  return tree;
}

/** Flatten a tree into a list of leaves/folders matching a predicate. */
function collect(tree, predicate, out = []) {
  if (predicate(tree)) out.push(tree);
  for (const c of tree.children || []) collect(c, predicate, out);
  return out;
}

/** Suggestions for the "Safe clean" panel. */
function suggestions(tree, now = Date.now()) {
  const DAY = 86400000;
  const topCache = [];
  const seenCachePaths = [];
  // Highest-level cache folders only (don't list every nested cache dir).
  collect(tree, (n) => {
    if (n.isDir && n.kind === 'cache' && n.size > 50 * 1024 * 1024 && isSafeCache(n.path)) {
      if (!seenCachePaths.some((p) => n.path.startsWith(p + '/') || n.path.startsWith(p + '\\'))) {
        seenCachePaths.push(n.path);
        topCache.push(n);
      }
    }
    return false;
  });
  const oldDownloads = collect(tree, (n) => !n.isDir && !n.aggregate && n.kind === 'downloads' && now - n.mtime > 60 * DAY);
  const largeStale = collect(tree, (n) => !n.isDir && !n.aggregate && n.size > 500 * 1024 * 1024 && now - n.mtime > 180 * DAY && n.kind !== 'cache');
  const trash = collect(tree, (n) => n.isDir && n.kind === 'trash' && n.size > 0 && path.basename(n.path).toLowerCase().match(/^(\.trash|\$recycle\.bin)$/));
  const total = (list) => list.reduce((s, n) => s + n.size, 0);
  const strip = (n) => ({ name: n.name, path: n.path, size: n.size, kind: n.kind, mtime: n.mtime, isDir: n.isDir });
  return {
    caches: { items: topCache.slice(0, 50).map(strip), total: total(topCache) },
    oldDownloads: { items: oldDownloads.slice(0, 100).map(strip), total: total(oldDownloads) },
    largeStale: { items: largeStale.sort((a, b) => b.size - a.size).slice(0, 100).map(strip), total: total(largeStale) },
    trash: { items: trash.map(strip), total: total(trash) },
  };
}

// --- Keeping a scan current after a delete (no rescan) ----------------------
// The renderer has the same helpers (src/renderer/app.js, "Tree upkeep").
const isUnder = (p, dir) => p.startsWith(dir + '/') || p.startsWith(dir + '\\');
const BIN_NAME = /^(\.trash|\$recycle\.bin)$/i;

/** Nodes from the root down to `p`, or to its deepest scanned folder. */
function chainTo(tree, p) {
  if (!tree || !p || !(tree.path === p || isUnder(p, tree.path))) return null;
  const chain = [tree];
  for (let n = tree; n.path !== p; ) {
    n = (n.children || []).find((c) => !c.aggregate && (c.path === p || (c.isDir && isUnder(p, c.path))));
    if (!n) break;
    chain.push(n);
  }
  return chain;
}

function shrink(chain, node) {
  for (const a of chain) {
    a.size = Math.max(0, a.size - node.size);
    a.files = Math.max(0, (a.files || 0) - (node.files || 0));
    if (a.types && node.types) for (const [k, v] of Object.entries(node.types)) if (a.types[k]) a.types[k] = Math.max(0, a.types[k] - v);
  }
}

/** Takes the item at `p` out of the tree. Returns the bytes it held (0 if not in the scan). */
function forget(tree, p) {
  const chain = chainTo(tree, p);
  if (!chain || chain.length < 2 || chain[chain.length - 1].path !== p) return 0;
  const node = chain.pop();
  const parent = chain[chain.length - 1];
  parent.children.splice(parent.children.indexOf(node), 1);
  shrink(chain, node);
  return node.size;
}

/** Empties a folder in the tree, keeping the folder. Returns the bytes it held. */
function clearDir(tree, dir) {
  const chain = chainTo(tree, dir);
  if (!chain || chain[chain.length - 1].path !== dir) return 0;
  const node = { ...chain[chain.length - 1], types: { ...(chain[chain.length - 1].types || {}) } };
  shrink(chain, node);
  chain[chain.length - 1].children = [];
  return node.size;
}

/** The Trash / Recycle Bin folder inside the scan, if the scan covers it. */
function findBin(tree) {
  return collect(tree, (n) => n.isDir && BIN_NAME.test(path.basename(n.path))).sort((a, b) => a.path.length - b.path.length)[0] || null;
}

/** Things moved to the Trash still take space there until it's emptied. */
function addToBin(tree, bytes) {
  const bin = bytes > 0 && findBin(tree);
  if (!bin) return null;
  for (const a of chainTo(tree, bin.path)) {
    a.size += bytes;
    if (a.types) a.types.other = (a.types.other || 0) + bytes;
  }
  bin.children = bin.children || [];
  let lot = bin.children.find((c) => c.aggregate && c.moved);
  if (!lot) bin.children.push((lot = { name: 'Moved here by Gigapolis', path: bin.path, size: 0, isDir: false, kind: 'trash', mtime: Date.now(), files: 0, aggregate: true, moved: true, types: {} }));
  lot.size += bytes;
  lot.types.other = (lot.types.other || 0) + bytes;
  bin.children.sort((a, b) => b.size - a.size);
  return bin;
}

/** Default places to scan for a user. */
function defaultRoots() {
  const home = require('os').homedir();
  return [home];
}

module.exports = { scan, classify, collect, suggestions, defaultRoots, forget, clearDir, addToBin, findBin, ext, isSafeCache, TYPE_EXT, BUNDLE_TYPE };

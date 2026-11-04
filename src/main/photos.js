// Photo Studio: finds duplicate photos (byte-identical) and similar photos
// (perceptual hash) in your own home folder, grouped so you pick which to
// keep. Pure Node: image decoding is passed in (main.js uses Electron's
// nativeImage), so the logic can be unit tested. Nothing here deletes anything.
//
// Only your own disk: the walk stays on the home folder's drive (mount points
// such as Google Drive, network shares and external drives are skipped), skips
// cloud sync folders and ~/Library / AppData, and never reads files that are
// only in the cloud (macOS "optimised storage" placeholders).
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const PHOTO_EXT = new Set('jpg jpeg jpe png heic heif tif tiff webp gif bmp cr2 cr3 nef arw dng raf orf rw2 srw pef'.split(' '));
const RAW_EXT = new Set('cr2 cr3 nef arw dng raf orf rw2 srw pef'.split(' '));
const MIN_BYTES = 20 * 1024; // icons and web sprites are not photos
// Folders the walk never enters (lower case).
const SKIP_DIRS = new Set(['library', 'appdata', 'node_modules', '$recycle.bin', 'system volume information', 'applications', 'program files', 'program files (x86)', 'windows']);
// Cloud sync folders: their files may live only online, and deleting there deletes everywhere.
const CLOUD_DIR = /^(onedrive( - .*)?|dropbox( \(.*\))?|google ?drive|my drive|icloud ?drive|box|box sync|creative cloud files.*|pcloud drive|mega|nextcloud|sync|tresorit)$/i;
// Packages managed by an app: removing a file inside breaks the library.
const BUNDLE = /\.(photoslibrary|photolibrary|aplibrary|lrdata|lrcat-data|fcpbundle|imovielibrary|app|bundle|framework|logicx|band)$/i;
// Similar = dHash distance at most this (out of 64). 8 bands of 8 bits means
// two hashes this close always share a band, so bucketing finds every pair.
const SIMILAR_MAX = 7;
const BANDS = 8;
const MAX_SIMILAR_GROUP = 40; // bigger clusters are blank pages / screenshots, not lookalikes

const ext = (name) => {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
};
const isPhoto = (name) => PHOTO_EXT.has(ext(name));

function skipDir(name) {
  if (name.startsWith('.')) return true;
  const n = name.toLowerCase();
  return SKIP_DIRS.has(n) || CLOUD_DIR.test(name) || BUNDLE.test(name);
}

/** Lists photo files under `root`, on the same drive only. */
async function walkPhotos(root, { signal, onFile = () => {} } = {}) {
  const out = [];
  let rootDev;
  try {
    rootDev = (await fsp.stat(root)).dev;
  } catch {
    return out;
  }
  const stack = [root];
  const seen = new Set();
  while (stack.length) {
    if (signal && signal.aborted) throw new Error('aborted');
    const dir = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDir(e.name)) continue;
        try {
          const st = await fsp.stat(full);
          if (st.dev !== rootDev) continue; // a mounted drive (external, network, Google Drive)
        } catch {
          continue;
        }
        stack.push(full);
      } else if (e.isFile() && isPhoto(e.name)) {
        let st;
        try {
          st = await fsp.stat(full);
        } catch {
          continue;
        }
        if (st.size < MIN_BYTES) continue;
        if (st.blocks === 0 && st.size > 0) continue; // only in the cloud: reading it would download it
        const key = st.dev + ':' + st.ino;
        if (st.ino && seen.has(key)) continue; // hard link to a photo we already have
        seen.add(key);
        out.push({ path: full, name: e.name, size: st.size, mtime: st.mtimeMs });
        onFile(out.length);
      }
    }
  }
  return out;
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

/** Groups byte-identical files: same size first, then a full SHA-1. */
async function exactGroups(files, { signal, onStep = () => {} } = {}) {
  const bySize = new Map();
  for (const f of files) bySize.set(f.size, [...(bySize.get(f.size) || []), f]);
  const groups = [];
  for (const same of bySize.values()) {
    if (same.length < 2) continue;
    const byHash = new Map();
    for (const f of same) {
      if (signal && signal.aborted) throw new Error('aborted');
      try {
        const h = await fullHash(f.path);
        byHash.set(h, [...(byHash.get(h) || []), f]);
      } catch {}
      onStep();
    }
    for (const twins of byHash.values()) if (twins.length > 1) groups.push(twins);
  }
  return groups;
}

// --- Perceptual hash ---------------------------------------------------------

/** Box-averages an RGBA/BGRA bitmap down to outW x outH greys (channel order doesn't matter). */
function toGray(bitmap, w, h, outW, outH) {
  const g = new Float64Array(outW * outH);
  for (let oy = 0; oy < outH; oy++) {
    const y0 = Math.floor((oy * h) / outH);
    const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * h) / outH));
    for (let ox = 0; ox < outW; ox++) {
      const x0 = Math.floor((ox * w) / outW);
      const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * w) / outW));
      let s = 0;
      let n = 0;
      for (let y = y0; y < y1 && y < h; y++)
        for (let x = x0; x < x1 && x < w; x++) {
          const i = (y * w + x) * 4;
          s += (bitmap[i] + bitmap[i + 1] + bitmap[i + 2]) / 3;
          n++;
        }
      g[oy * outW + ox] = n ? s / n : 0;
    }
  }
  return g;
}

/**
 * Difference hash: 64 bits, each "is this pixel brighter than its right
 * neighbour" on a 9x8 grey thumbnail. Returns 16 hex chars, or null for flat
 * images (blank, black) which would all look alike.
 */
function dhash(bitmap, w, h) {
  if (!bitmap || !w || !h) return null;
  const g = toGray(bitmap, w, h, 9, 8);
  let mean = 0;
  for (const v of g) mean += v;
  mean /= g.length;
  let varc = 0;
  for (const v of g) varc += (v - mean) ** 2;
  if (Math.sqrt(varc / g.length) < 4) return null;
  let hex = '';
  for (let y = 0; y < 8; y++) {
    let byte = 0;
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (g[y * 9 + x] > g[y * 9 + x + 1] ? 1 : 0);
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

const POP = Array.from({ length: 16 }, (_, i) => (i & 1) + ((i >> 1) & 1) + ((i >> 2) & 1) + ((i >> 3) & 1));
function hamming(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POP[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  return d;
}

/** Groups photos whose hashes are within SIMILAR_MAX. items: [{hash, ...}] */
function similarGroups(items, max = SIMILAR_MAX) {
  const withHash = items.filter((i) => i.hash);
  const parent = withHash.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const buckets = new Map();
  withHash.forEach((it, i) => {
    for (let b = 0; b < BANDS; b++) {
      const k = b + ':' + it.hash.slice(b * 2, b * 2 + 2);
      const list = buckets.get(k);
      if (list) list.push(i);
      else buckets.set(k, [i]);
    }
  });
  const tried = new Set();
  for (const list of buckets.values()) {
    if (list.length < 2 || list.length > 5000) continue;
    for (let x = 0; x < list.length; x++)
      for (let y = x + 1; y < list.length; y++) {
        const a = list[x];
        const b = list[y];
        const key = a < b ? a * 1e7 + b : b * 1e7 + a;
        if (tried.has(key)) continue;
        tried.add(key);
        if (hamming(withHash[a].hash, withHash[b].hash) <= max) parent[find(a)] = find(b);
      }
  }
  const clusters = new Map();
  withHash.forEach((it, i) => {
    const r = find(i);
    clusters.set(r, [...(clusters.get(r) || []), it]);
  });
  return [...clusters.values()].filter((c) => c.length > 1 && c.length <= MAX_SIMILAR_GROUP);
}

// --- Picking the one to keep -----------------------------------------------

/** Pixel size from the file header (JPEG, PNG, GIF, WebP); null if unknown. */
async function headerSize(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return parseHeaderSize(buf.subarray(0, bytesRead));
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function parseHeaderSize(b) {
  if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length > 10 && b.toString('ascii', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length > 30 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      const v = b.readUInt32LE(21);
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
    }
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7) || m === 0xff) {
        i += m === 0xff ? 1 : 2;
        continue;
      }
      const len = b.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8), DAC (CC)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
  }
  return null;
}

const FORMAT_RANK = (name) => {
  const e = ext(name);
  if (RAW_EXT.has(e)) return 4;
  if (e === 'tif' || e === 'tiff' || e === 'png') return 3;
  if (e === 'heic' || e === 'heif') return 2;
  if (e === 'jpg' || e === 'jpeg' || e === 'jpe') return 1;
  return 0;
};
const looksLikeCopy = (name) => /(\bcopy\b|kopie|\(\d+\)|[-_ ]\d{1,2}\.[a-z0-9]+$|-edited|_small|-min\.)/i.test(name);
// Where a keeper most likely belongs: Pictures best, Downloads / Desktop worst.
function placeRank(p) {
  const s = p.replace(/\\/g, '/').toLowerCase();
  if (s.includes('/pictures/') || s.includes('/photos/')) return 3;
  if (s.includes('/documents/') || s.includes('/movies/') || s.includes('/videos/')) return 2;
  if (s.includes('/downloads/') || s.includes('/desktop/')) return 0;
  return 1;
}

/** Sorts a group best-first and says why the first one is suggested. */
function rankGroup(items, kind) {
  const px = (i) => (i.width && i.height ? i.width * i.height : 0);
  const sorted = [...items].sort((a, b) => {
    if (kind === 'similar') {
      if (px(b) !== px(a)) return px(b) - px(a);
      if (FORMAT_RANK(b.name) !== FORMAT_RANK(a.name)) return FORMAT_RANK(b.name) - FORMAT_RANK(a.name);
      if (b.size !== a.size) return b.size - a.size;
    }
    if (placeRank(b.path) !== placeRank(a.path)) return placeRank(b.path) - placeRank(a.path);
    if (looksLikeCopy(a.name) !== looksLikeCopy(b.name)) return looksLikeCopy(a.name) ? 1 : -1;
    if ((a.mtime || 0) !== (b.mtime || 0)) return (a.mtime || 0) - (b.mtime || 0);
    return a.path.length - b.path.length;
  });
  const best = sorted[0];
  let why = 'Oldest copy, most likely the original';
  if (kind === 'similar') {
    const second = sorted[1];
    if (px(best) > px(second)) why = `Highest resolution${best.width ? ` (${best.width}×${best.height})` : ''}`;
    else if (FORMAT_RANK(best.name) > FORMAT_RANK(second.name)) why = 'Best quality format';
    else if (best.size > second.size) why = 'Largest file, least compressed';
  } else if (placeRank(best.path) > placeRank(sorted[1].path)) why = 'Already in a photo folder';
  else if (!looksLikeCopy(best.name) && looksLikeCopy(sorted[1].name)) why = 'Not named as a copy';
  return { items: sorted, keep: best.path, why };
}

// --- The whole job -------------------------------------------------------------

/**
 * options: {
 *   roots: [home], signal, onProgress({phase, done, total}),
 *   decode(path) -> Promise<{bitmap, w, h} | null>   small thumbnail pixels
 *   dims(path) -> Promise<{width, height} | null>     fallback full size (e.g. HEIC)
 *   cache: Map(path -> {size, mtime, hash})           perceptual hashes from last time
 *   concurrency
 * }
 * Returns { exact: [group], similar: [group], photos, bytes } where
 * group = { id, kind, items, keep, why, saving }.
 */
async function findPhotos(options = {}) {
  const { roots = [], signal, onProgress = () => {}, decode, dims, cache = new Map(), concurrency = 4 } = options;
  let last = 0;
  const report = (p, force) => {
    const t = Date.now();
    if (force || t - last > 150) {
      last = t;
      onProgress(p);
    }
  };

  let files = [];
  for (const r of roots) files = files.concat(await walkPhotos(r, { signal, onFile: (n) => report({ phase: 'finding', done: n + files.length, total: 0 }) }));
  const byPath = new Map(files.map((f) => [f.path, f]));
  report({ phase: 'finding', done: files.length, total: files.length }, true);

  // 1. Exact duplicates.
  const sizeCounts = new Map();
  for (const f of files) sizeCounts.set(f.size, (sizeCounts.get(f.size) || 0) + 1);
  const toHash = files.filter((f) => sizeCounts.get(f.size) > 1).length;
  let hashed = 0;
  const exactRaw = await exactGroups(files, { signal, onStep: () => report({ phase: 'twins', done: ++hashed, total: toHash }) });

  // 2. Similar photos: one representative per exact group.
  const dupOf = new Set();
  for (const g of exactRaw) for (const f of g.slice(1)) dupOf.add(f.path);
  const reps = files.filter((f) => !dupOf.has(f.path));
  let done = 0;
  if (decode) {
    let next = 0;
    const worker = async () => {
      while (next < reps.length) {
        if (signal && signal.aborted) throw new Error('aborted');
        const f = reps[next++];
        const c = cache.get(f.path);
        if (c && c.size === f.size && c.mtime === f.mtime && 'hash' in c) f.hash = c.hash;
        else {
          try {
            const img = await decode(f.path);
            f.hash = img ? dhash(img.bitmap, img.w, img.h) : null;
          } catch {
            f.hash = null;
          }
          cache.set(f.path, { size: f.size, mtime: f.mtime, hash: f.hash });
        }
        report({ phase: 'lookalikes', done: ++done, total: reps.length });
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  }
  // Drop stale cache entries.
  for (const k of cache.keys()) if (!byPath.has(k)) cache.delete(k);
  const similarRaw = similarGroups(reps);

  // 3. Rank each group (needs pixel sizes for similar ones).
  const sizeOfImage = async (f) => {
    if (f.width) return;
    const d = (await headerSize(f.path)) || (dims ? await dims(f.path).catch(() => null) : null);
    if (d && d.width && d.height) Object.assign(f, { width: d.width, height: d.height });
  };
  const shape = (kind) => (g, i) => {
    const r = rankGroup(g, kind);
    const items = r.items.map((f) => ({ path: f.path, name: f.name, size: f.size, mtime: f.mtime, width: f.width || 0, height: f.height || 0 }));
    return { id: `${kind}-${i}`, kind, items, keep: r.keep, why: r.why, saving: items.filter((x) => x.path !== r.keep).reduce((n, x) => n + x.size, 0) };
  };
  for (const g of [...exactRaw, ...similarRaw]) for (const f of g) await sizeOfImage(f);
  const exact = exactRaw.map(shape('exact')).sort((a, b) => b.saving - a.saving);
  const similar = similarRaw.map(shape('similar')).sort((a, b) => b.saving - a.saving);
  report({ phase: 'done', done: files.length, total: files.length }, true);
  return { exact, similar, photos: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
}

/**
 * Checks a trash request against the last result: each path must be in a
 * group, its group's keeper must not be trashed, and at least one photo of
 * every group stays. Returns { ok: [{path, keep, kind}], refused: [{path, error}] }.
 */
function planTrash(result, paths) {
  const where = new Map();
  for (const g of [...((result && result.exact) || []), ...((result && result.similar) || [])]) for (const it of g.items) where.set(it.path, g);
  const want = new Set(paths);
  const ok = [];
  const refused = [];
  for (const p of want) {
    const g = where.get(p);
    if (!g) {
      refused.push({ path: p, error: 'Not in the photo list any more. Scan photos again.' });
      continue;
    }
    // The one we keep: the suggested keeper unless that's being trashed too,
    // then the best-ranked photo that isn't.
    const keeper = g.items.find((i) => !want.has(i.path));
    if (!keeper) {
      refused.push({ path: p, error: 'Keep at least one photo from each group.' });
      continue;
    }
    ok.push({ path: p, keep: want.has(g.keep) ? keeper.path : g.keep, kind: g.kind });
  }
  return { ok, refused };
}

module.exports = { findPhotos, walkPhotos, exactGroups, similarGroups, dhash, hamming, toGray, rankGroup, planTrash, parseHeaderSize, headerSize, skipDir, isPhoto, SIMILAR_MAX };

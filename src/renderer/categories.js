// Groups a scanned folder tree into a handful of main categories. The city
// shows one building per category; clicking it lists what is inside.
// Pure functions (no DOM), so the tests can import this module directly.

// Colours follow the reference city: terracotta, brick, salmon, sand, cream and warm greys.
export const CATEGORIES = [
  { id: 'video', label: 'Movies & Video', color: 0xeadfcb },
  { id: 'photos', label: 'Photos & Images', color: 0xd4805f },
  { id: 'music', label: 'Music & Audio', color: 0x9c5a46 },
  { id: 'documents', label: 'Documents', color: 0xd8b28a },
  { id: 'downloads', label: 'Downloads', color: 0xb9583c },
  { id: 'desktop', label: 'Desktop', color: 0xe0a07c },
  { id: 'apps', label: 'Applications', color: 0xd9d2c5 },
  { id: 'dev', label: 'Developer & Code', color: 0x8f6f5e },
  { id: 'cloud', label: 'Cloud Drives', color: 0xb7aea3 },
  { id: 'backups', label: 'Phone & Backups', color: 0xc49a74 },
  { id: 'mail', label: 'Mail & Messages', color: 0xdc9474 },
  { id: 'archives', label: 'Archives & Installers', color: 0xc0694a },
  { id: 'cache', label: 'Caches & Temp', color: 0xcf7a54 },
  { id: 'library', label: 'App Data & Settings', color: 0xe6d6bd },
  { id: 'system', label: 'System', color: 0x9d968e },
  { id: 'trash', label: 'Trash', color: 0xa59a8e },
  { id: 'other', label: 'Other Files', color: 0xd6c7b4 },
];
export const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

// File type by extension, used for loose files and for folders with no
// well-known name (their biggest type decides where they go).
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
// Bundles that look like folders but are really one thing.
const BUNDLE_TYPE = { photoslibrary: 'photo', fcpbundle: 'video', imovielibrary: 'video', fcpxproject: 'video', logicx: 'audio', band: 'audio', app: 'app', xcodeproj: 'code' };
const TYPE_CAT = { video: 'video', photo: 'photos', audio: 'music', doc: 'documents', archive: 'archives', app: 'apps', code: 'dev' };

export function extOf(name) {
  const i = (name || '').lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}
export function typeOfName(name, isDir) {
  const e = extOf(name);
  return (isDir ? BUNDLE_TYPE[e] : EXT_TYPE[e]) || null;
}

// Folders under the scanned root with a well-known name.
const NAMED = {
  movies: 'video', videos: 'video', video: 'video', films: 'video', footage: 'video',
  pictures: 'photos', photos: 'photos', images: 'photos', screenshots: 'photos',
  music: 'music', audio: 'music', podcasts: 'music', 'garageband': 'music',
  documents: 'documents', docs: 'documents',
  downloads: 'downloads',
  desktop: 'desktop',
  applications: 'apps', 'program files': 'apps', 'program files (x86)': 'apps',
  '.trash': 'trash', trash: 'trash', '$recycle.bin': 'trash',
  dropbox: 'cloud', 'google drive': 'cloud', googledrive: 'cloud', onedrive: 'cloud', box: 'cloud', 'box sync': 'cloud', 'icloud drive': 'cloud', 'creative cloud files': 'cloud', pcloud: 'cloud', mega: 'cloud',
  developer: 'dev', projects: 'dev', code: 'dev', src: 'dev', repos: 'dev', git: 'dev', github: 'dev', workspace: 'dev', dev: 'dev', go: 'dev', androidstudioprojects: 'dev',
  '.npm': 'cache', '.cache': 'cache', '.gradle': 'cache', '.m2': 'cache', '.yarn': 'cache', '.pnpm-store': 'cache', '.cargo': 'dev', '.rustup': 'dev', '.nvm': 'dev', '.docker': 'dev', '.android': 'dev', '.vagrant.d': 'dev', '.conda': 'dev', anaconda3: 'dev', miniconda3: 'dev',
  system: 'system', windows: 'system',
  library: 'split', appdata: 'split',
};
// Inside Library / AppData: what each child is. Unlisted children are app data.
const LIBRARY = {
  caches: 'cache', logs: 'cache', temp: 'cache', 'saved application state': 'cache', webkit: 'cache', 'cache': 'cache',
  mail: 'mail', messages: 'mail', 'mail downloads': 'mail', 'group containers/group.com.apple.mail': 'mail',
  'mobile documents': 'cloud', cloudstorage: 'cloud',
  developer: 'dev',
  'application support': 'split', local: 'split', roaming: 'split', containers: 'split',
  'application support/mobilesync': 'backups', 'application support/mobilesync/backup': 'backups', 'roaming/apple computer/mobilesync': 'backups', 'apple computer': 'split',
  'containers/com.apple.mail': 'mail', 'local/temp': 'cache', 'local/microsoft/windows/inetcache': 'cache',
  'application support/caches': 'cache', 'application support/crashreporter': 'cache',
};
const DEV_MARKERS = new Set(['.git', 'node_modules', 'package.json', 'cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'gemfile', 'requirements.txt', 'pyproject.toml', 'makefile', '.xcodeproj', 'deriveddata']);

/**
 * Byte counts per file type for a node. The scanner fills `types` (it sees
 * every small file); trees without it (demo data) are worked out here.
 */
export function typesOf(node) {
  if (node.types) return node.types;
  const t = {};
  const add = (k, v) => (t[k] = (t[k] || 0) + v);
  const bundle = typeOfName(node.name, node.isDir);
  if (bundle) add(bundle, node.size);
  else if (node.isDir && (node.children || []).some((c) => DEV_MARKERS.has((c.name || '').toLowerCase()))) add('code', node.size);
  else if (!node.isDir) {
    const ty = typeOfName(node.name, false) || { media: 'video', documents: 'doc', downloads: 'archive', apps: 'app' }[node.kind];
    add(ty || 'other', node.size);
  } else {
    let counted = 0;
    for (const c of node.children || []) {
      for (const [k, v] of Object.entries(typesOf(c))) add(k, v);
      counted += c.size;
    }
    if (node.size > counted) add('other', node.size - counted);
  }
  node.types = t;
  return t;
}

/** Category for a folder or file that has no well-known name. */
export function categoryByContent(node, rootKind = 'other') {
  const n = (node.name || '').toLowerCase();
  // Kind comes from the full path; ignore it when the scanned folder itself sits in a cache/trash path.
  if ((node.kind === 'cache' && rootKind !== 'cache') || n === 'node_modules' || n === 'deriveddata') return 'cache';
  if (node.kind === 'trash' && rootKind !== 'trash') return 'trash';
  const t = typesOf(node);
  let best = null;
  let bestV = 0;
  for (const [k, v] of Object.entries(t)) if (k !== 'other' && v > bestV) [best, bestV] = [k, v];
  if (best && bestV >= node.size * 0.3) return TYPE_CAT[best];
  // Hidden folders in the home folder are almost always app settings.
  if (n.startsWith('.') && node.isDir) return 'library';
  return 'other';
}

function categoryFor(node, rel, rootKind) {
  const n = (node.name || '').toLowerCase();
  if (node.virtual) return node.kind === 'system' ? 'system' : null;
  if (node.aggregate) return null; // assigned by caller
  if (rel.length === 1 && NAMED[n]) return NAMED[n];
  if (rel.length > 1) {
    const key = rel.slice(1).join('/').toLowerCase();
    if (LIBRARY[key]) return LIBRARY[key];
    // Unlisted Library children are app data, unless they are mostly media etc.
    const c = categoryByContent(node, rootKind);
    return c === 'other' ? 'library' : c;
  }
  return categoryByContent(node, rootKind);
}

/**
 * Turn the scanned tree into category nodes:
 * [{ name, category, kind, size, files, mtime, isDir, virtual, children: [items] }]
 * Each item is the original tree node (so Show in Finder / Demolish work on it),
 * tagged with `rel`, its path relative to the scanned folder.
 */
export function categorize(tree) {
  const buckets = new Map();
  const put = (cat, node, rel) => {
    if (!node || node.size <= 0) return;
    if (!buckets.has(cat)) buckets.set(cat, []);
    node.rel = rel.join('/');
    buckets.get(cat).push(node);
  };
  const visit = (node, rel, parentFallback) => {
    if (node.aggregate) return put(parentFallback, node, rel.slice(0, -1).concat(node.name));
    const cat = categoryFor(node, rel, tree.kind);
    if (cat === 'split') {
      const fallback = rel.length === 1 ? 'library' : parentFallback;
      for (const c of node.children || []) visit(c, rel.concat(c.name), fallback);
      return;
    }
    put(cat, node, rel);
  };
  for (const c of tree.children || []) visit(c, [c.name], c.aggregate ? categoryByContent(c, tree.kind) : 'other');
  const out = [];
  for (const def of CATEGORIES) {
    const list = buckets.get(def.id);
    if (!list || !list.length) continue;
    list.sort((a, b) => b.size - a.size);
    out.push({
      name: def.label,
      path: tree.path,
      category: def.id,
      kind: def.id,
      isDir: true,
      virtual: true,
      size: list.reduce((s, i) => s + i.size, 0),
      files: list.reduce((s, i) => s + (i.files || 0), 0),
      mtime: Math.max(0, ...list.map((i) => i.mtime || 0)),
      children: list,
    });
  }
  return out;
}

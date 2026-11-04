// Cloud-synced folders and other drives. Gigapolis only scans and cleans the
// startup disk by default: deleting from Google Drive, Dropbox, OneDrive or
// iCloud Drive deletes the file online and on every synced device, and
// external / network drives are not what "keep my Mac's storage low" means.
// Each one can be opted in from the Drives window; the choice is remembered.
const fs = require('fs');
const path = require('path');
const os = require('os');

// Cloud folders that live inside the home folder (case-insensitive match).
const HOME_CLOUD = [
  [/^library[\\/]cloudstorage[\\/][^\\/]+/i, null], // Google Drive, Dropbox, OneDrive, Box… (macOS File Provider)
  [/^library[\\/]mobile documents/i, 'iCloud Drive'],
  [/^icloud ?drive/i, 'iCloud Drive'],
  [/^onedrive[^\\/]*/i, 'OneDrive'],
  [/^dropbox[^\\/]*/i, 'Dropbox'],
  [/^google ?drive[^\\/]*/i, 'Google Drive'],
  [/^my drive/i, 'Google Drive'],
  [/^box( sync)?(?=[\\/]|$)/i, 'Box'],
  [/^creative cloud files[^\\/]*/i, 'Creative Cloud'],
  [/^pcloud ?drive/i, 'pCloud'],
  [/^mega(?=[\\/]|$)/i, 'MEGA'],
  [/^sync(?=[\\/]|$)/i, 'Sync.com'],
];

// "GoogleDrive-angus@x.com" -> "Google Drive (angus@x.com)"
function providerName(folder) {
  const [raw, ...rest] = folder.split('-');
  const acct = rest.join('-');
  const names = { googledrive: 'Google Drive', dropbox: 'Dropbox', onedrive: 'OneDrive', box: 'Box', icloud: 'iCloud Drive', pcloud: 'pCloud' };
  const name = names[raw.toLowerCase()] || raw;
  return acct && acct.toLowerCase() !== raw.toLowerCase() && acct.toLowerCase() !== 'box' ? `${name} (${acct})` : name;
}

function createDrives({ home = os.homedir(), platform = process.platform, file = null, env = process.env, exists = fs.existsSync, realpath = fs.realpathSync } = {}) {
  const WIN = platform === 'win32';
  const P = WIN ? path.win32 : path.posix;
  const fold = (s) => (WIN || platform === 'darwin' ? s.toLowerCase() : s);
  const norm = (p) => {
    let s = P.resolve(String(p || ''));
    if (s !== P.parse(s).root) s = s.replace(/[\\/]+$/, '');
    return s;
  };
  const under = (p, root) => {
    const a = fold(p);
    const b = fold(root);
    return a === b || a.startsWith(b.endsWith(P.sep) ? b : b + P.sep);
  };
  const homeN = norm(home);
  const systemDrive = ((env.SystemDrive || 'C:') + '\\').toUpperCase();
  const memo = new Map(); // drive roots are checked once per run (realpath / "My Drive" probe)
  const once = (key, fn) => {
    if (!memo.has(key)) memo.set(key, fn());
    return memo.get(key);
  };

  let added = new Set();
  try {
    if (file) added = new Set(JSON.parse(fs.readFileSync(file, 'utf8')).added || []);
  } catch {}
  const save = () => {
    if (!file) return;
    try {
      fs.writeFileSync(file, JSON.stringify({ added: [...added] }, null, 2));
    } catch {}
  };

  /** null for the startup disk, else { kind: 'cloud'|'external'|'network', label, root }. */
  function classify(p) {
    const n = norm(p);
    // Cloud folders inside home.
    if (under(n, homeN) && n !== homeN) {
      const rel = n.slice(homeN.length + (homeN.endsWith(P.sep) ? 0 : 1));
      for (const [re, label] of HOME_CLOUD) {
        const m = rel.match(re);
        if (m) {
          const root = P.join(homeN, m[0]);
          return { kind: 'cloud', label: label || providerName(P.basename(root)), root };
        }
      }
      return null;
    }
    if (WIN) {
      if (/^\\\\/.test(n)) {
        const m = n.match(/^\\\\[^\\]+\\[^\\]+/);
        return { kind: 'network', label: 'Network drive ' + (m ? m[0] : n), root: m ? m[0] : n };
      }
      const drive = P.parse(n).root.toUpperCase();
      if (/^[A-Z]:\\$/.test(drive) && drive !== systemDrive) {
        // Google Drive for desktop mounts as its own letter with "My Drive" at the top.
        const cloud = once(drive, () => exists(drive + 'My Drive') || exists(drive + 'Shared drives'));
        return { kind: cloud ? 'cloud' : 'external', label: `${cloud ? 'Google Drive' : 'Drive'} (${drive.slice(0, 2)})`, root: drive };
      }
      return null;
    }
    // macOS: everything else mounted lives in /Volumes. Linux: /media, /mnt.
    const m = n.match(/^\/Volumes\/[^/]+/) || (platform === 'linux' && n.match(/^\/(media\/[^/]+|mnt|run\/media\/[^/]+)\/[^/]+/));
    if (m) {
      const root = m[0];
      const real = once(root, () => {
        try {
          return realpath(root);
        } catch {
          return root;
        }
      });
      if (real === '/') return null; // /Volumes/Macintosh HD is the startup disk
      const name = P.basename(root);
      if (/^googledrive|^google drive/i.test(name)) return { kind: 'cloud', label: 'Google Drive', root };
      return { kind: 'external', label: name, root };
    }
    return null;
  }

  const isAdded = (root) => [...added].some((a) => fold(norm(a)) === fold(norm(root)));
  /** Info about a cloud/external location that is not opted in, else null. */
  function blocked(p) {
    const c = classify(p);
    return c && !isAdded(c.root) ? c : null;
  }

  function add(root) {
    const c = classify(root);
    if (!c) return false;
    added.add(c.root);
    save();
    return true;
  }
  function remove(root) {
    const c = classify(root);
    for (const a of [...added]) if (fold(norm(a)) === fold(norm(c ? c.root : root))) added.delete(a);
    save();
    return true;
  }

  /** Cloud folders and other drives found on this computer. */
  function available() {
    memo.clear();
    const out = new Map();
    const push = (p) => {
      const c = classify(p);
      if (c && !out.has(fold(c.root))) out.set(fold(c.root), { ...c, path: c.root, added: isAdded(c.root) });
    };
    const ls = (dir) => {
      try {
        return fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
      } catch {
        return [];
      }
    };
    for (const n of ls(P.join(home, 'Library', 'CloudStorage'))) push(P.join(home, 'Library', 'CloudStorage', n));
    if (exists(P.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'))) push(P.join(home, 'Library', 'Mobile Documents'));
    for (const n of ls(home)) {
      const full = P.join(home, n);
      let st;
      try {
        st = fs.lstatSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory() && !st.isSymbolicLink()) push(full);
    }
    if (WIN) {
      for (let i = 65; i <= 90; i++) {
        const d = String.fromCharCode(i) + ':\\';
        if (d !== systemDrive && exists(d)) push(d);
      }
    } else if (platform === 'darwin') {
      for (const n of ls('/Volumes')) push('/Volumes/' + n);
    } else {
      for (const base of ['/media', '/mnt', '/run/media']) for (const n of ls(base)) push(base + '/' + n);
    }
    for (const a of added) if (!out.has(fold(a)) && exists(a)) push(a);
    return [...out.values()];
  }

  return { classify, blocked, add, remove, available, added: () => [...added] };
}

/** User-facing reason a path can't be scanned or cleaned yet. */
function driveMessage(c) {
  if (c.kind === 'cloud') return `${c.label} is a cloud drive. Gigapolis leaves it alone unless you add it under Drives, because deleting there deletes it online and on every synced device.`;
  return `${c.label} is ${c.kind === 'network' ? 'a network' : 'another'} drive. Add it under Drives to scan or clean it.`;
}

module.exports = { createDrives, driveMessage, providerName };

// Folders Gigapolis must never move to the Trash. macOS refuses most of them
// anyway ("you don't have permission"), but we should never offer it.
// `whole`: never trash the folder itself. `contents`: may we clear what's inside?
const path = require('path');
const os = require('os');

const HOME_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures', 'Public', 'Applications', 'Sites', 'Videos', 'OneDrive', 'iCloud Drive', 'Creative Cloud Files', 'Dropbox'];
// Inside these, the items themselves are fine to remove but the folder isn't.
const HOME_EMPTYABLE = new Set(['Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures', 'Videos', 'Library/Caches', 'Library/Logs', '.Trash']);
const LIBRARY_KEEP = ['Library', 'Library/Application Support', 'Library/Caches', 'Library/Containers', 'Library/Group Containers', 'Library/Preferences', 'Library/Logs', 'Library/Mobile Documents', 'Library/Mail', 'Library/Messages', 'Library/Photos', 'Library/Keychains', 'Library/CloudStorage', '.Trash', 'AppData', 'AppData/Local', 'AppData/Roaming', 'AppData/Local/Temp'];
const SYSTEM = process.platform === 'win32'
  ? ['C:\\', 'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData', 'C:\\Users']
  : ['/', '/Applications', '/System', '/Library', '/Users', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/opt', '/cores', '/Volumes', '/dev', '/tmp', '/home', '/Library/Caches', '/Library/Application Support', '/System/Volumes/Data'];

function createProtection(home = os.homedir(), platform = process.platform) {
  const norm = (p) => {
    let s = path.resolve(String(p || '')).replace(/[\\/]+$/, '') || path.sep;
    if (platform === 'win32' || platform === 'darwin') s = s.toLowerCase(); // case-insensitive file systems
    return s;
  };
  const rules = new Map(); // normalised path -> { name, contents }
  const add = (p, contents) => rules.set(norm(p), { name: path.basename(p) || p, contents });
  for (const p of SYSTEM) add(p, false);
  add(home, false);
  for (const f of [...HOME_FOLDERS, ...LIBRARY_KEEP]) add(path.join(home, f), HOME_EMPTYABLE.has(f));

  // Returns null when the path is fine to trash, else { name, contents }.
  function check(p) {
    const n = norm(p);
    if (rules.has(n)) return rules.get(n);
    // Any ancestor of a protected folder (e.g. /Users) is protected too.
    for (const k of rules.keys()) if (k.startsWith(n + path.sep) || (n === path.sep && k !== n)) return { name: path.basename(p) || p, contents: false };
    return null;
  }
  return { check, isProtected: (p) => !!check(p), list: () => [...rules.entries()].map(([p, r]) => ({ path: p, ...r })) };
}

// Turns raw trash errors into something a person can act on.
function friendlyError(err, p) {
  const msg = String((err && err.message) || err || '');
  const name = path.basename(p || '') || p;
  if (/permission|not permitted|EPERM|EACCES|access is denied|operation not permitted/i.test(msg)) {
    return { error: `macOS didn't let Gigapolis move “${name}”. Turn on Full Disk Access for Gigapolis in System Settings › Privacy & Security, or remove it in Finder.`, perm: true };
  }
  if (/EBUSY|in use|resource busy/i.test(msg)) return { error: `“${name}” is in use. Quit the app using it and try again.` };
  return { error: msg || 'Unknown error' };
}

module.exports = { createProtection, friendlyError };

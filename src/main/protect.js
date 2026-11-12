// Folders Gigapolis must never move to the Trash. macOS refuses most of them
// anyway ("you don't have permission"), but we should never offer it.
// `whole`: never trash the folder itself. `contents`: may we clear what's inside?
const path = require('path');
const os = require('os');

const HOME_FOLDERS = ['Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures', 'Public', 'Applications', 'Sites', 'Videos', 'OneDrive', 'iCloud Drive', 'iCloudDrive', 'Creative Cloud Files', 'Dropbox', 'Saved Games', 'Contacts', 'Favorites', 'Links', 'Searches', '3D Objects'];
// Inside these, the items themselves are fine to remove but the folder isn't.
const HOME_EMPTYABLE = new Set(['Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures', 'Videos', 'Library/Caches', 'Library/Logs', '.Trash', 'AppData/Local/Temp']);
const LIBRARY_KEEP = ['Library', 'Library/Application Support', 'Library/Caches', 'Library/Containers', 'Library/Group Containers', 'Library/Preferences', 'Library/Logs', 'Library/Mobile Documents', 'Library/Mail', 'Library/Messages', 'Library/Photos', 'Library/Keychains', 'Library/CloudStorage', '.Trash', 'AppData', 'AppData/Local', 'AppData/LocalLow', 'AppData/Roaming', 'AppData/Local/Temp', 'AppData/Local/Microsoft', 'AppData/Local/Packages', 'AppData/Roaming/Microsoft', 'NTUSER.DAT'];
const MAC_SYSTEM = ['/', '/Applications', '/System', '/Library', '/Users', '/usr', '/bin', '/sbin', '/etc', '/var', '/private', '/opt', '/cores', '/Volumes', '/dev', '/tmp', '/home', '/Library/Caches', '/Library/Application Support', '/System/Volumes/Data', '/Users/Shared'];
function windowsSystem(env = process.env) {
  const drive = (env.SystemDrive || 'C:') + '\\';
  const list = [drive, 'Windows', 'Program Files', 'Program Files (x86)', 'ProgramData', 'Users', 'Recovery', 'System Volume Information', '$Recycle.Bin', 'PerfLogs', 'Users\\Public'].map((d) => (d === drive ? d : drive + d));
  for (const k of ['SystemRoot', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData']) if (env[k]) list.push(env[k]);
  return list;
}

function createProtection(home = os.homedir(), platform = process.platform) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const SYSTEM = platform === 'win32' ? windowsSystem() : MAC_SYSTEM;
  const norm = (p) => {
    let s = P.resolve(String(p || ''));
    if (s !== P.parse(s).root) s = s.replace(/[\\/]+$/, '');
    if (platform === 'win32' || platform === 'darwin') s = s.toLowerCase(); // case-insensitive file systems
    return s;
  };
  const rules = new Map(); // normalised path -> { name, contents }
  const add = (p, contents) => rules.set(norm(p), { name: P.basename(p) || p, contents });
  for (const p of SYSTEM) add(p, false);
  add(home, false);
  for (const f of [...HOME_FOLDERS, ...LIBRARY_KEEP]) add(P.join(home, f), HOME_EMPTYABLE.has(f));

  // Returns null when the path is fine to trash, else { name, contents }.
  function check(p) {
    const n = norm(p);
    if (rules.has(n)) return rules.get(n);
    // Any ancestor of a protected folder (e.g. /Users) is protected too.
    const prefix = n.endsWith(P.sep) ? n : n + P.sep; // a drive root already ends in a separator
    for (const k of rules.keys()) if (k !== n && k.startsWith(prefix)) return { name: P.basename(p) || p, contents: false };
    return null;
  }
  return { check, isProtected: (p) => !!check(p), list: () => [...rules.entries()].map(([p, r]) => ({ path: p, ...r })) };
}

// Turns raw trash errors into something a person can act on.
function friendlyError(err, p, platform = process.platform) {
  const msg = String((err && err.message) || err || '');
  const name = (platform === 'win32' ? path.win32 : path.posix).basename(p || '') || p;
  if (/permission|not permitted|EPERM|EACCES|access is denied|operation not permitted/i.test(msg)) {
    if (platform === 'win32') return { error: `Windows didn't let Gigapolis move “${name}”. It may be in use or need an administrator. Close any app using it, or remove it in File Explorer.`, perm: true };
    return { error: `macOS didn't let Gigapolis move “${name}”. Turn on Full Disk Access for Gigapolis in System Settings › Privacy & Security, or remove it in Finder.`, perm: true };
  }
  if (/EBUSY|in use|resource busy/i.test(msg)) return { error: `“${name}” is in use. Quit the app using it and try again.` };
  return { error: msg || 'Unknown error' };
}

module.exports = { createProtection, friendlyError };

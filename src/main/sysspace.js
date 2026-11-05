// "System & other users": break down the disk space outside the scanned folder
// (macOS). Nothing here deletes anything. It only measures, so the page can say
// what the space is and point at the safe way to clear each part.
//
// Parts: purgeable space (mostly Time Machine local snapshots), swap and sleep
// files, /Applications, /Library, /private/var, Homebrew and dev tools,
// /Users/Shared and other users' folders. What is left over is macOS itself
// plus anything Gigapolis can't read; the page shows that as the remainder.
const fs = require('fs');
const os = require('os');
const path = require('path').posix; // macOS paths, also when tests run on Windows
const { execFile } = require('child_process');

const MB = 1024 * 1024;
const VM_DIR = '/System/Volumes/VM';

// Folders measured with `du`. id: part id, the page picks the advice by it.
const DU_PARTS = [
  { id: 'apps', icon: '📦', name: 'Apps in Applications', paths: ['/Applications'] },
  { id: 'library', icon: '🏛', name: 'Shared Library (all users)', paths: ['/Library'] },
  { id: 'var', icon: '🗄', name: 'System logs, temp and caches', paths: ['/private/var'] },
  { id: 'dev', icon: '🛠', name: 'Homebrew and developer tools', paths: ['/opt', '/usr/local'] },
  { id: 'shared', icon: '🤝', name: 'Shared folder', paths: ['/Users/Shared'] },
];

const run = (cmd, args, timeout) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * MB }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
  });

// `du -k -x -d 1 dir` output: "<KB>\t<path>" lines; the dir itself is last.
function parseDu(out, dir) {
  let size = 0;
  const children = [];
  for (const line of out.split('\n')) {
    const m = /^(\d+)\t(.+)$/.exec(line);
    if (!m) continue;
    const bytes = Number(m[1]) * 1024;
    if (m[2] === dir) size = bytes;
    else children.push({ name: path.basename(m[2]), path: m[2], size: bytes });
  }
  children.sort((a, b) => b.size - a.size);
  return { size, children };
}

// Does a overlap b (same, or one inside the other)?
const overlaps = (a, b) => {
  const x = a.replace(/\/+$/, '') + '/';
  const y = b.replace(/\/+$/, '') + '/';
  return x.startsWith(y) || y.startsWith(x);
};

// Free space macOS can reclaim on its own (snapshots, iCloud copies, caches).
// statfs "free" leaves it out; Finder's "available" counts it.
const JXA_IMPORTANT = 'ObjC.import("Foundation");var d=$.NSURL.fileURLWithPath("/").resourceValuesForKeysError($(["NSURLVolumeAvailableCapacityForImportantUsageKey"]),null);String(d.objectForKey("NSURLVolumeAvailableCapacityForImportantUsageKey").doubleValue)';

function createSysSpace({ exec = run, home = os.homedir(), fsImpl = fs, platform = process.platform } = {}) {
  const dirSizes = (dir) => {
    let n = 0;
    try {
      for (const f of fsImpl.readdirSync(dir)) {
        try {
          const st = fsImpl.statSync(path.join(dir, f));
          if (st.isFile()) n += st.size;
        } catch {}
      }
    } catch {}
    return n;
  };

  async function du(dir) {
    if (!fsImpl.existsSync(dir)) return null;
    const r = await exec('/usr/bin/du', ['-k', '-x', '-d', '1', dir], 120000);
    const out = parseDu(r.stdout, dir);
    out.denied = /Permission denied|Operation not permitted/.test(r.stderr);
    return out;
  }

  async function snapshots() {
    const r = await exec('/usr/bin/tmutil', ['listlocalsnapshots', '/'], 20000);
    return (r.stdout.match(/com\.apple\.TimeMachine\./g) || []).length;
  }

  async function purgeable(free) {
    const r = await exec('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_IMPORTANT], 20000);
    const avail = Number(String(r.stdout).trim());
    return Number.isFinite(avail) && avail > free ? avail - free : 0;
  }

  // scanRoot: the folder the city was built from (its sizes are already shown).
  // free: statfs free bytes for the disk.
  async function measure({ scanRoot = home, free = 0 } = {}) {
    if (platform !== 'darwin') return null;
    const skip = (p) => overlaps(p, scanRoot);
    const parts = [];

    const [snapCount, purge] = await Promise.all([snapshots().catch(() => 0), purgeable(free).catch(() => 0)]);
    if (purge > 0 || snapCount > 0) {
      parts.push({ id: 'purgeable', icon: '🕰', name: 'Snapshots & purgeable space', size: purge, snapshots: snapCount, children: [] });
    }

    const swap = dirSizes(VM_DIR);
    if (swap > 0) parts.push({ id: 'swap', icon: '💤', name: 'Swap and sleep files', size: swap, path: VM_DIR, children: [] });

    const jobs = DU_PARTS.map(async (p) => {
      const todo = p.paths.filter((x) => !skip(x));
      const res = (await Promise.all(todo.map(du))).filter(Boolean);
      if (!res.length) return;
      const size = res.reduce((s, r) => s + r.size, 0);
      const children = res.flatMap((r) => r.children).sort((a, b) => b.size - a.size);
      parts.push({ id: p.id, icon: p.icon, name: p.name, size, path: todo.length === 1 ? todo[0] : undefined, children: children.filter((c) => c.size >= 100 * MB).slice(0, 8) });
    });

    // Other people's home folders. Usually private: then we can only name them.
    let others = [];
    try {
      others = fsImpl
        .readdirSync('/Users')
        .filter((n) => !n.startsWith('.') && n !== 'Shared' && n !== 'Guest')
        .map((n) => path.join('/Users', n))
        .filter((p) => !skip(p) && p !== home);
    } catch {}
    jobs.push(
      (async () => {
        if (!others.length) return;
        const res = await Promise.all(others.map(du));
        const children = others.map((p, i) => ({ name: path.basename(p), path: p, size: res[i] ? res[i].size : 0, private: !res[i] || res[i].denied }));
        const size = children.reduce((s, c) => s + c.size, 0);
        parts.push({ id: 'users', icon: '👥', name: 'Other users on this Mac', size, private: children.some((c) => c.private), children });
      })()
    );

    await Promise.all(jobs);
    parts.sort((a, b) => b.size - a.size);
    return { parts, measuredAt: Date.now() };
  }

  return { measure };
}

module.exports = { createSysSpace, parseDu, overlaps };

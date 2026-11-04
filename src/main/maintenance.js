// Public Works (Maintenance tab): the housekeeping jobs that keep the city
// running. They don't free much space; they fix slow lookups, broken "Open
// With" menus, stale search results and the like.
//
// Safety: the renderer only ever sends task ids. Every command is a constant
// in this file, so nothing the page sends can become part of a command line.
// Jobs that need an administrator run together behind ONE password prompt
// (macOS) or ONE UAC prompt (Windows).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const MIN = 60 * 1000;
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

// --- Task table ------------------------------------------------------------
// admin: run as administrator. sh (Mac) / ps (Windows): the command.
// cmd + args: run directly as the user (no shell).
// timeout: ms. ok/fail: shown after the run.
function macTasks({ uid = process.getuid ? process.getuid() : 501, exists = fs.existsSync } = {}) {
  const u = Number.isInteger(uid) && uid >= 0 ? uid : 501;
  return [
    {
      id: 'dns',
      icon: '📞',
      name: 'Flush the DNS cache',
      city: 'Reset the phone exchange',
      desc: 'Fixes websites that won’t load or still point to an old address.',
      admin: true,
      quick: true,
      recommended: true,
      sh: '/usr/bin/dscacheutil -flushcache; /usr/bin/killall -HUP mDNSResponder',
      timeout: 1 * MIN,
      ok: 'DNS cache flushed.',
    },
    {
      id: 'launch',
      icon: '🗺',
      name: 'Rebuild Launch Services',
      city: 'Reprint the street directory',
      desc: 'Fixes duplicate or missing apps in “Open With” menus, and wrong default apps.',
      admin: false,
      recommended: true,
      cmd: LSREGISTER,
      args: ['-kill', '-r', '-domain', 'local', '-domain', 'system', '-domain', 'user'],
      fallbackArgs: ['-r', '-domain', 'local', '-domain', 'system', '-domain', 'user'],
      timeout: 5 * MIN,
      ok: '“Open With” menus rebuilt. Finder may take a minute to catch up.',
    },
    {
      id: 'scripts',
      icon: '🌙',
      name: 'Run maintenance scripts',
      city: 'Send out the night shift',
      desc: 'Runs macOS’s daily, weekly and monthly clean-up of logs and temporary files.',
      admin: true,
      recommended: true,
      available: exists('/usr/sbin/periodic'),
      sh: '/usr/sbin/periodic daily weekly monthly',
      timeout: 10 * MIN,
      ok: 'Daily, weekly and monthly scripts finished.',
    },
    {
      id: 'ram',
      icon: '🧹',
      name: 'Free up memory',
      city: 'Clear the roads',
      desc: 'Empties cached files out of memory. Handy before opening a big project.',
      admin: true,
      quick: true,
      sh: '/usr/sbin/purge',
      timeout: 2 * MIN,
      ok: 'Memory cache cleared.',
    },
    {
      id: 'firstaid',
      icon: '🩺',
      name: 'Check the disk (First Aid)',
      city: 'Building inspection',
      desc: 'Checks your startup disk for errors. Your Mac may pause for a moment while it runs.',
      admin: false,
      cmd: '/usr/sbin/diskutil',
      args: ['verifyVolume', '/'],
      timeout: 20 * MIN,
      ok: 'Your startup disk looks healthy.',
      fail: 'Problems were found. Restart into Recovery and run Disk Utility › First Aid to repair them.',
      // diskutil exits non-zero both for "problems found" and "couldn't check".
      classify: (code, out) => (code !== 0 && /corrupt|needs? (to be )?repair|error/i.test(out) ? 2 : code),
    },
    {
      id: 'perms',
      icon: '🔑',
      name: 'Repair home folder permissions',
      city: 'Re-key the front doors',
      desc: 'Fixes “you don’t have permission” errors on your own files and folders.',
      admin: true,
      sh: `/usr/sbin/diskutil resetUserPermissions / ${u}`,
      timeout: 15 * MIN,
      ok: 'Home folder permissions repaired.',
    },
    {
      id: 'spotlight',
      icon: '📚',
      name: 'Rebuild the Spotlight index',
      city: 'Re-catalogue the library',
      desc: 'Fixes search that misses files or shows ones you deleted.',
      warn: 'Search results stay incomplete while it rebuilds, which can take an hour.',
      admin: true,
      sh: '/usr/bin/mdutil -E /',
      timeout: 2 * MIN,
      ok: 'Spotlight is re-indexing in the background. Searches fill back in over the next hour.',
    },
  ].filter((t) => t.available !== false);
}

function winTasks({ env = process.env } = {}) {
  const drive = /^[A-Za-z]:$/.test(env.SystemDrive || '') ? env.SystemDrive.toUpperCase() : 'C:';
  const letter = drive[0];
  const sys32 = path.win32.join(env.SystemRoot || 'C:\\Windows', 'System32');
  return [
    {
      id: 'dns',
      icon: '📞',
      name: 'Flush the DNS cache',
      city: 'Reset the phone exchange',
      desc: 'Fixes websites that won’t load or still point to an old address.',
      admin: false,
      quick: true,
      recommended: true,
      cmd: path.win32.join(sys32, 'ipconfig.exe'),
      args: ['/flushdns'],
      timeout: 1 * MIN,
      ok: 'DNS cache flushed.',
    },
    {
      id: 'icons',
      icon: '🖼',
      name: 'Reset the icon cache',
      city: 'Repaint the shop signs',
      desc: 'Fixes blank, wrong or out-of-date icons on the desktop and in File Explorer.',
      admin: false,
      recommended: true,
      cmd: path.win32.join(sys32, 'ie4uinit.exe'),
      args: ['-show'],
      iconCache: true,
      timeout: 2 * MIN,
      ok: 'Icons refreshed. Any that are still wrong are fixed after your next restart.',
    },
    {
      id: 'cleanup',
      icon: '🧽',
      name: 'Open Disk Cleanup',
      city: 'Call the street sweepers',
      desc: 'Opens Windows Disk Cleanup for your system drive, so you can pick what it clears.',
      admin: false,
      detached: true,
      cmd: path.win32.join(sys32, 'cleanmgr.exe'),
      args: [`/d${letter}`],
      timeout: 10 * 1000,
      ok: 'Disk Cleanup is open in its own window.',
    },
    {
      id: 'diskcheck',
      icon: '🩺',
      name: 'Check the disk for errors',
      city: 'Building inspection',
      desc: `Scans drive ${drive} for errors while you keep working.`,
      admin: true,
      ps: `$r = Repair-Volume -DriveLetter ${letter} -Scan -ErrorAction Stop; if ("$r" -eq 'NoErrorsFound') { 0 } else { 2 }`,
      timeout: 30 * MIN,
      ok: `Drive ${drive} looks healthy.`,
      fail: `Problems were found on ${drive}. Restart your PC and Windows will offer to repair them.`,
    },
    {
      id: 'optimise',
      icon: '⚙️',
      name: 'Optimise the drive',
      city: 'Resurface the roads',
      desc: 'Trims an SSD or defragments a hard drive, so it stays quick.',
      admin: true,
      ps: `Optimize-Volume -DriveLetter ${letter} -ErrorAction Stop | Out-Null; 0`,
      timeout: 60 * MIN,
      ok: `Drive ${drive} optimised.`,
    },
    {
      id: 'sfc',
      icon: '🛡',
      name: 'Repair system files',
      city: 'Check the foundations',
      desc: 'Finds and replaces damaged Windows files (System File Checker).',
      warn: 'Takes 10 to 30 minutes.',
      admin: true,
      ps: `& "$env:SystemRoot\\System32\\sfc.exe" /scannow | Out-Null; if ($LASTEXITCODE -eq 0) { 0 } else { 2 }`,
      timeout: 60 * MIN,
      ok: 'System files checked. Anything damaged was repaired.',
      fail: 'Some system files could not be repaired. A restart, then running it again, often fixes this.',
    },
  ];
}

function tasksFor(platform, opts) {
  if (platform === 'darwin') return macTasks(opts);
  if (platform === 'win32') return winTasks(opts);
  return [];
}

// What the renderer sees: no commands.
function publicTask(t) {
  const { id, icon, name, city, desc, warn, admin, quick, recommended, detached } = t;
  return { id, icon, name, city, desc, warn: warn || null, admin: !!admin, quick: !!quick, recommended: !!recommended, opens: !!detached };
}

// --- Pure helpers (unit-tested) -----------------------------------------------

// Only known ids, each once, in the table's order.
function pick(tasks, ids) {
  const want = new Set((Array.isArray(ids) ? ids : []).map(String));
  return tasks.filter((t) => want.has(t.id));
}

// AppleScript string literal.
const asString = (s) => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';

// One shell script for every admin job; each prints a marker with its exit code.
function macAdminScript(tasks) {
  return tasks.map((t) => `( ${t.sh} ) >/dev/null 2>&1; echo "@@${t.id}:$?"`).join('; ');
}

// Markers back into { id: exitCode }.
function parseMarkers(out) {
  const codes = {};
  for (const m of String(out || '').matchAll(/@@([a-z]+):(\d+)/g)) codes[m[1]] = Number(m[2]);
  return codes;
}

// PowerShell single-quoted string.
const psString = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// The elevated PowerShell script: runs each job (whose last output is its
// status: 0 fine, 2 problems found) with a time limit, then writes
// { id: status } as JSON to `outFile`.
function winAdminScript(tasks, outFile) {
  const lines = ['$ErrorActionPreference = "Continue"', '$res = @{}'];
  for (const t of tasks) {
    const id = psString(t.id);
    lines.push(
      `try { $j = Start-Job -ScriptBlock { ${t.ps} }; if (Wait-Job $j -Timeout ${Math.round(t.timeout / 1000)}) { $v = Receive-Job $j -ErrorAction SilentlyContinue | Select-Object -Last 1; $res[${id}] = $(if ($j.State -eq 'Completed' -and $null -ne $v) { [int]$v } else { 1 }) } else { Stop-Job $j; $res[${id}] = 124 }; Remove-Job $j -Force } catch { $res[${id}] = 1 }`
    );
  }
  lines.push(`$res | ConvertTo-Json -Compress | Set-Content -Encoding UTF8 -Path ${psString(outFile)}`);
  return lines.join('\r\n');
}

// Exit status -> what the page shows. 0 fine, 2 problems found, 124 timed out.
function resultFor(t, code) {
  if (code === 0) return { id: t.id, ok: true, message: t.ok };
  if (code === 124) return { id: t.id, ok: false, message: 'Took too long and was stopped.' };
  if (code === 2 && t.fail) return { id: t.id, ok: false, problems: true, message: t.fail };
  return { id: t.id, ok: false, message: `Couldn’t finish${code != null ? ` (code ${code})` : ''}.` };
}

// --- Runners ------------------------------------------------------------------

function runFile(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const out = String(stdout || '') + String(stderr || '');
      if (!err) return resolve({ code: 0, out });
      if (err.killed || err.signal === 'SIGTERM') return resolve({ code: 124, out });
      resolve({ code: typeof err.code === 'number' ? err.code : 1, out, missing: err.code === 'ENOENT' });
    });
  });
}

async function runUserTask(t, { exec = runFile, platform } = {}) {
  if (t.detached) {
    try {
      const c = spawn(t.cmd, t.args, { detached: true, stdio: 'ignore', windowsHide: false });
      c.on('error', () => {});
      c.unref();
      return { id: t.id, ok: true, message: t.ok };
    } catch {
      return { id: t.id, ok: false, message: 'Couldn’t open it.' };
    }
  }
  let r = await exec(t.cmd, t.args, t.timeout);
  if (r.code !== 0 && r.code !== 124 && t.fallbackArgs) r = await exec(t.cmd, t.fallbackArgs, t.timeout);
  if (t.iconCache && platform === 'win32') clearWinIconCache();
  if (r.missing) return { id: t.id, ok: false, message: 'Not available on this computer.' };
  return resultFor(t, t.classify ? t.classify(r.code, r.out) : r.code);
}

// Icon cache files that aren't locked by Explorer right now; the rest go on restart.
function clearWinIconCache(env = process.env) {
  const local = env.LOCALAPPDATA;
  if (!local) return 0;
  let n = 0;
  const tryRm = (f) => {
    try {
      fs.unlinkSync(f);
      n++;
    } catch {}
  };
  tryRm(path.join(local, 'IconCache.db'));
  const dir = path.join(local, 'Microsoft', 'Windows', 'Explorer');
  try {
    for (const f of fs.readdirSync(dir)) if (/^iconcache_[\w]+\.db$/i.test(f)) tryRm(path.join(dir, f));
  } catch {}
  return n;
}

async function runMacAdmin(tasks, { exec = runFile } = {}) {
  const script = macAdminScript(tasks);
  const total = tasks.reduce((n, t) => n + t.timeout, 0) + 2 * MIN; // + time to type the password
  const r = await exec('/usr/bin/osascript', ['-e', `do shell script ${asString(script)} with administrator privileges`], total);
  if (r.code !== 0 && /-128|User canceled|cancelled/i.test(r.out)) return tasks.map((t) => ({ id: t.id, ok: false, cancelled: true, message: 'Cancelled: no password given.' }));
  const codes = parseMarkers(r.out);
  return tasks.map((t) => resultFor(t, t.id in codes ? codes[t.id] : r.code === 124 ? 124 : 1));
}

async function runWinAdmin(tasks, { exec = runFile, tmp = os.tmpdir() } = {}) {
  const stamp = `gigapolis-maint-${process.pid}-${Date.now()}`;
  const ps1 = path.join(tmp, stamp + '.ps1');
  const out = path.join(tmp, stamp + '.json');
  fs.writeFileSync(ps1, '\ufeff' + winAdminScript(tasks, out), 'utf8');
  const outer = `try { Start-Process -FilePath powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psString('"' + ps1 + '"')} -ErrorAction Stop } catch { exit 5 }`;
  const total = tasks.reduce((n, t) => n + t.timeout, 0) + 2 * MIN;
  const r = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', outer], total);
  let codes = {};
  try {
    codes = JSON.parse(fs.readFileSync(out, 'utf8').replace(/^\ufeff/, ''));
  } catch {}
  for (const f of [ps1, out]) fs.rm(f, { force: true }, () => {});
  if (r.code === 5 && !Object.keys(codes).length) return tasks.map((t) => ({ id: t.id, ok: false, cancelled: true, message: 'Cancelled: administrator access was not given.' }));
  return tasks.map((t) => resultFor(t, t.id in codes ? Number(codes[t.id]) : r.code === 124 ? 124 : 1));
}

// --- History (when each job last ran) ---------------------------------------

function createHistory(dir) {
  const file = dir ? path.join(dir, 'maintenance.json') : null;
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {}
  return {
    get: () => ({ ...data }),
    record(results, now = Date.now()) {
      for (const r of results) if (r.ok) data[r.id] = now;
      if (!file) return;
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data));
      } catch {}
    },
  };
}

function createMaintenance({ platform = process.platform, dir = null, exec } = {}) {
  const tasks = tasksFor(platform);
  const history = createHistory(dir);
  let busy = false;
  return {
    list: () => ({ platform, tasks: tasks.map(publicTask), lastRun: history.get(), busy }),
    async run(ids) {
      if (busy) return { ok: false, error: 'Already running maintenance.' };
      const chosen = pick(tasks, ids);
      if (!chosen.length) return { ok: false, error: 'Nothing selected.' };
      busy = true;
      try {
        const results = [];
        // Quick user jobs first, then everything that needs one password, then the rest.
        const user = chosen.filter((t) => !t.admin);
        const admin = chosen.filter((t) => t.admin);
        for (const t of user.filter((t) => t.quick || t.detached)) results.push(await runUserTask(t, { exec, platform }));
        if (admin.length) results.push(...(platform === 'win32' ? await runWinAdmin(admin, { exec }) : await runMacAdmin(admin, { exec })));
        for (const t of user.filter((t) => !(t.quick || t.detached))) results.push(await runUserTask(t, { exec, platform }));
        history.record(results);
        const order = new Map(chosen.map((t, i) => [t.id, i]));
        results.sort((a, b) => order.get(a.id) - order.get(b.id));
        return { ok: results.every((r) => r.ok), results, lastRun: history.get() };
      } finally {
        busy = false;
      }
    },
  };
}

module.exports = { createMaintenance, macTasks, winTasks, tasksFor, publicTask, pick, macAdminScript, parseMarkers, winAdminScript, resultFor, asString, psString, createHistory, runMacAdmin, runUserTask };

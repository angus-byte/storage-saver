// Power Station: live memory, CPU, heavy processes, disk activity, battery
// and heat. Works the same on macOS and Windows (and falls back to plain
// `ps` + os.* elsewhere, used by the tests on Linux).
//
// Kept light: nothing runs unless the Performance tab is open and asking for
// samples. macOS spawns a few tiny tools (ps, vm_stat, sysctl, ioreg) per
// sample. Windows keeps one PowerShell helper alive while the tab is open,
// because starting PowerShell every few seconds would cost more than the
// numbers it reports; the helper stops itself 15 s after the tab stops asking.
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 8 * 1024 * 1024, timeout: 5000, windowsHide: true, ...opts }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout || '')));
  });

// --- Parsers (pure, unit-tested) ------------------------------------------

// ps TIME column: "[dd-][hh:]mm:ss[.cc]" -> seconds.
function parseCpuTime(s) {
  if (!s) return 0;
  let days = 0;
  let rest = s.trim();
  const dash = rest.indexOf('-');
  if (dash > 0) {
    days = Number(rest.slice(0, dash)) || 0;
    rest = rest.slice(dash + 1);
  }
  const parts = rest.split(':').map(Number);
  let sec = 0;
  for (const p of parts) sec = sec * 60 + (Number.isFinite(p) ? p : 0);
  return days * 86400 + sec;
}

// `ps -Aeo pid=,ppid=,uid=,rss=,time=,comm=` (comm last: it can hold spaces).
function parsePs(out) {
  const procs = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (!m) continue;
    const exe = m[6];
    procs.push({ pid: +m[1], ppid: +m[2], uid: +m[3], mem: +m[4] * 1024, cpuSec: parseCpuTime(m[5]), path: exe, name: path.posix.basename(exe) });
  }
  return procs;
}

// Which "business" a process belongs to: the outermost .app on macOS (so all
// of Chrome's helpers count as Chrome), the program name elsewhere.
function groupOf(proc, platform) {
  if (platform === 'win32') {
    const name = proc.desc || proc.name;
    return { key: 'win:' + proc.name.toLowerCase(), name };
  }
  const m = proc.path.match(/^(.*?\/([^/]+)\.app)(\/|$)/);
  if (m) return { key: 'app:' + m[1], name: m[2], bundle: m[1] };
  return { key: 'exe:' + proc.path, name: proc.name };
}

// Never offered a Quit button: the OS and anything it needs to keep running.
const MAC_CORE = new Set(['kernel_task', 'launchd', 'WindowServer', 'loginwindow', 'Dock', 'Finder', 'SystemUIServer', 'ControlCenter', 'NotificationCenter', 'Spotlight', 'coreaudiod', 'cfprefsd', 'distnoted', 'mds', 'mds_stores', 'mdworker', 'mdworker_shared', 'opendirectoryd', 'securityd', 'trustd', 'syspolicyd', 'logd', 'configd', 'powerd', 'bluetoothd', 'airportd', 'UserEventAgent', 'sharingd', 'universalaccessd', 'TextInputMenuAgent', 'WallpaperAgent']);
const WIN_CORE = new Set(['system', 'idle', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso', 'svchost', 'dwm', 'explorer', 'fontdrvhost', 'sihost', 'ctfmon', 'runtimebroker', 'shellexperiencehost', 'startmenuexperiencehost', 'searchhost', 'searchindexer', 'searchapp', 'textinputhost', 'audiodg', 'conhost', 'spoolsv', 'msmpeng', 'nissrv', 'securityhealthservice', 'securityhealthsystray', 'memory compression', 'wudfhost', 'dllhost', 'taskhostw', 'lockapp', 'applicationframehost', 'systemsettings', 'smartscreen', 'secure system', 'wlanext', 'dashost', 'sgrmbroker', 'mpdefendercoreservice']);
const MAC_SYSTEM_DIRS = ['/System/', '/usr/', '/sbin/', '/bin/', '/Library/Apple/', '/private/', '/Library/PrivilegedHelperTools/'];

// Why a process can't be quit from here, or null if it can.
function systemReason(proc, { platform, uid, systemRoot }) {
  if (platform === 'win32') {
    const n = proc.name.toLowerCase();
    if (proc.pid <= 4 || WIN_CORE.has(n)) return 'Windows';
    if (proc.session === 0) return 'service';
    if (!proc.path) return 'protected';
    const root = (systemRoot || 'C:\\Windows').toLowerCase() + '\\';
    if (proc.path.toLowerCase().startsWith(root)) return 'Windows';
    return null;
  }
  if (proc.pid <= 1) return 'macOS';
  if (uid != null && proc.uid !== uid) return platform === 'darwin' ? 'macOS' : 'system';
  if (MAC_CORE.has(proc.name)) return 'macOS';
  // Apple's own apps (Mail, Photos, Music...) live in /System/Applications
  // and are fine to quit; everything else under /System is the OS.
  if (platform === 'darwin' && proc.path.startsWith('/System/Applications/')) return null;
  if (platform === 'darwin' && MAC_SYSTEM_DIRS.some((d) => proc.path.startsWith(d))) return 'macOS';
  return null;
}

// Group processes into businesses, add up memory and CPU, flag the ones that
// must not be quit. `cpu` on each proc is a % of the whole machine.
function groupProcesses(procs, { platform, uid, selfPids = [], systemRoot } = {}) {
  const self = new Set(selfPids);
  const groups = new Map();
  for (const p of procs) {
    const g = groupOf(p, platform);
    let e = groups.get(g.key);
    if (!e) {
      e = { key: g.key, name: g.name, pids: [], mem: 0, cpu: 0, count: 0, system: null, self: false, roots: [] };
      groups.set(g.key, e);
    }
    e.pids.push(p.pid);
    e.mem += p.mem || 0;
    e.cpu += p.cpu || 0;
    e.count++;
    if (self.has(p.pid)) e.self = true;
    const why = systemReason(p, { platform, uid, systemRoot });
    if (why && !e.system) e.system = why;
  }
  for (const e of groups.values()) {
    const pids = new Set(e.pids);
    e.roots = procs.filter((p) => pids.has(p.pid) && !pids.has(p.ppid)).map((p) => p.pid);
    e.cpu = Math.round(e.cpu * 10) / 10;
    e.canQuit = !e.system && !e.self;
  }
  return [...groups.values()];
}

// The busiest few by memory and by CPU (union), so the page has both lists.
function topGroups(groups, n = 12) {
  const byMem = [...groups].sort((a, b) => b.mem - a.mem).slice(0, n);
  const byCpu = [...groups].sort((a, b) => b.cpu - a.cpu).slice(0, n);
  const seen = new Set();
  const out = [];
  for (const g of [...byMem, ...byCpu]) if (!seen.has(g.key)) seen.add(g.key), out.push(g);
  return out.map(({ roots, pids, ...g }) => g);
}

function parseVmStat(out) {
  const page = Number((out.match(/page size of (\d+) bytes/) || [])[1]) || 16384;
  const v = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^(.+?):\s+(\d+)\.?$/);
    if (m) v[m[1].trim()] = Number(m[2]) * page;
  }
  return {
    pageSize: page,
    free: v['Pages free'] || 0,
    active: v['Pages active'] || 0,
    inactive: v['Pages inactive'] || 0,
    speculative: v['Pages speculative'] || 0,
    wired: v['Pages wired down'] || 0,
    compressed: v['Pages occupied by compressor'] || 0,
    purgeable: v['Pages purgeable'] || 0,
    anonymous: v['Anonymous pages'] || 0,
    fileBacked: v['File-backed pages'] || 0,
  };
}

const PRESSURE = { 1: 'normal', 2: 'warn', 4: 'critical' };
function pressureFromPct(pct) {
  return pct >= 92 ? 'critical' : pct >= 80 ? 'warn' : 'normal';
}

// Same sums as Activity Monitor: Used = App + Wired + Compressed; the rest
// (cached files + free) is memory macOS hands back the moment it's needed.
function macMemory(vm, total, sysctlOut) {
  const app = Math.max(0, vm.anonymous - vm.purgeable) || vm.active;
  const used = Math.min(total, app + vm.wired + vm.compressed);
  const lines = (sysctlOut || '').split('\n');
  const level = Number(lines[0]);
  const swap = (sysctlOut || '').match(/used = ([\d.]+)([MG])/);
  const swapUsed = swap ? Number(swap[1]) * (swap[2] === 'G' ? 1024 ** 3 : 1024 ** 2) : 0;
  return {
    total,
    used,
    free: Math.max(0, total - used),
    app,
    wired: vm.wired,
    compressed: vm.compressed,
    cached: Math.max(0, vm.fileBacked + vm.purgeable),
    swapUsed,
    pressure: PRESSURE[level] || pressureFromPct((used / total) * 100),
  };
}

// ioreg IOBlockStorageDriver statistics: cumulative bytes read/written.
function parseIoreg(out) {
  let read = 0;
  let write = 0;
  for (const m of out.matchAll(/"Bytes \(Read\)"=(\d+)/g)) read += Number(m[1]);
  for (const m of out.matchAll(/"Bytes \(Write\)"=(\d+)/g)) write += Number(m[1]);
  return read || write ? { read, write } : null;
}

function parsePmset(out) {
  const m = out.match(/(\d+)%;\s*([^;]+);\s*([^\s]+)?/);
  if (!m) return null;
  const state = m[2].trim().toLowerCase();
  const time = (m[3] || '').match(/^(\d+):(\d+)$/);
  return {
    percent: Number(m[1]),
    charging: state === 'charging' || state === 'finishing charge',
    onAC: /AC Power/.test(out),
    minutesLeft: time && state === 'discharging' ? Number(time[1]) * 60 + Number(time[2]) : null,
  };
}

// --- Windows helper ---------------------------------------------------------

const WIN_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$parent = [int]$args[0]
$desc = @{}
$path = @{}
$n = 0
while ($true) {
  if (-not (Get-Process -Id $parent -ErrorAction SilentlyContinue)) { exit }
  $procs = foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {
    $id = $p.Id
    if (-not $path.ContainsKey($id)) {
      $f = $null; $d = $null
      try { $m = $p.MainModule; $f = $m.FileName; $d = $m.FileVersionInfo.FileDescription } catch {}
      $path[$id] = $f; $desc[$id] = $d
    }
    $c = $null; try { $c = $p.TotalProcessorTime.TotalSeconds } catch {}
    [pscustomobject]@{ i = $id; n = $p.ProcessName; c = $c; m = $p.WorkingSet64; s = $p.SessionId; p = $path[$id]; d = $desc[$id] }
  }
  $disk = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk -Filter "Name='_Total'"
  $bat = $null
  if ($n % 10 -eq 0) { $bat = Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining, BatteryStatus, EstimatedRunTime }
  $o = [pscustomobject]@{ t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds(); procs = $procs; dr = $disk.DiskReadBytesPersec; dw = $disk.DiskWriteBytesPersec; bat = $bat; hasBat = ($n % 10 -eq 0) }
  [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 3))
  [Console]::Out.Flush()
  $n++
  if ($n % 60 -eq 0) { $live = @{}; foreach ($p in [System.Diagnostics.Process]::GetProcesses()) { $live[$p.Id] = 1 }; foreach ($k in @($path.Keys)) { if (-not $live.ContainsKey($k)) { $path.Remove($k); $desc.Remove($k) } } }
  Start-Sleep -Milliseconds 2500
}
`;

function winBattery(b) {
  if (!b) return null;
  // BatteryStatus 2 = on mains; EstimatedRunTime is a huge number when charging.
  const onAC = b.BatteryStatus === 2 || b.BatteryStatus >= 6;
  return {
    percent: b.EstimatedChargeRemaining,
    charging: b.BatteryStatus >= 6 && b.BatteryStatus <= 9,
    onAC,
    minutesLeft: !onAC && b.EstimatedRunTime && b.EstimatedRunTime < 100000 ? b.EstimatedRunTime : null,
  };
}

function createWinHelper() {
  let child = null;
  let latest = null;
  let buf = '';
  let lastAsk = 0;
  let idleTimer = null;
  let battery = null;
  let batteryKnown = false;
  const start = () => {
    if (child) return;
    // -EncodedCommand can't take $args, so the parent pid goes in via the script.
    const script = WIN_SCRIPT.replace('[int]$args[0]', String(process.pid));
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const o = JSON.parse(line);
          if (o.hasBat) (battery = winBattery(o.bat)), (batteryKnown = true);
          latest = o;
        } catch {}
      }
    });
    child.on('exit', () => {
      child = null;
      buf = '';
    });
  };
  const stop = () => {
    if (child) child.kill();
    child = null;
    latest = null;
  };
  return {
    // Latest snapshot from the helper (starting it if needed).
    get() {
      lastAsk = Date.now();
      start();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => Date.now() - lastAsk >= 15000 && stop(), 15500);
      return latest ? { ...latest, battery, batteryKnown } : null;
    },
    stop,
  };
}

// --- Monitor ----------------------------------------------------------------

function createMonitor({ platform = process.platform, uid = process.getuid ? process.getuid() : null, selfPids = () => [process.pid], thermal = () => null, systemRoot = process.env.SystemRoot } = {}) {
  const cores = os.cpus().length || 1;
  let lastCpu = cpuTimes();
  let lastProcs = new Map(); // pid -> cpuSec
  let lastT = platform === 'win32' ? 0 : Date.now();
  let lastDisk = null;
  let batteryCache = { t: 0, value: null };
  let inflight = null;
  let lastGroups = [];
  const win = platform === 'win32' ? createWinHelper() : null;

  function cpuTimes() {
    let idle = 0;
    let total = 0;
    for (const c of os.cpus()) {
      for (const v of Object.values(c.times)) total += v;
      idle += c.times.idle;
    }
    return { idle, total };
  }

  function cpuLoad() {
    const now = cpuTimes();
    const dt = now.total - lastCpu.total;
    const load = dt > 0 ? (1 - (now.idle - lastCpu.idle) / dt) * 100 : 0;
    lastCpu = now;
    return Math.max(0, Math.min(100, Math.round(load)));
  }

  // Per-process CPU as a share of the whole machine, from CPU-seconds deltas.
  function withCpu(procs, dtSec) {
    const next = new Map();
    for (const p of procs) {
      const prev = lastProcs.get(p.pid);
      next.set(p.pid, p.cpuSec);
      p.cpu = prev != null && dtSec > 0 && p.cpuSec >= prev ? Math.min(100, ((p.cpuSec - prev) / dtSec / cores) * 100) : 0;
    }
    lastProcs = next;
    return procs;
  }

  async function battery() {
    if (Date.now() - batteryCache.t < 30000) return batteryCache.value;
    let value = null;
    if (platform === 'darwin') value = parsePmset(await run('pmset', ['-g', 'batt']));
    batteryCache = { t: Date.now(), value };
    return value;
  }

  async function samplePosix() {
    const now = Date.now();
    const dtSec = (now - lastT) / 1000;
    lastT = now;
    const mac = platform === 'darwin';
    const [psOut, vmOut, sysOut, ioOut, bat] = await Promise.all([
      run('ps', ['-Aeo', 'pid=,ppid=,uid=,rss=,time=,comm=']),
      mac ? run('vm_stat') : '',
      mac ? run('sysctl', ['-n', 'kern.memorystatus_vm_pressure_level', 'vm.swapusage']) : '',
      mac ? run('ioreg', ['-r', '-c', 'IOBlockStorageDriver', '-w', '0']) : '',
      battery(),
    ]);
    const total = os.totalmem();
    let mem;
    if (mac && vmOut) mem = macMemory(parseVmStat(vmOut), total, sysOut);
    else {
      const free = os.freemem();
      mem = { total, used: total - free, free, swapUsed: null, pressure: pressureFromPct(((total - free) / total) * 100) };
    }
    let disk = null;
    const io = parseIoreg(ioOut);
    if (io) {
      if (lastDisk && dtSec > 0) disk = { read: Math.max(0, (io.read - lastDisk.read) / dtSec), write: Math.max(0, (io.write - lastDisk.write) / dtSec) };
      lastDisk = io;
    }
    const procs = withCpu(parsePs(psOut), dtSec);
    return { mem, disk, battery: bat, procs, diskSupported: mac };
  }

  function sampleWin() {
    const o = win.get();
    const total = os.totalmem();
    const free = os.freemem();
    const mem = { total, used: total - free, free, swapUsed: null, pressure: pressureFromPct(((total - free) / total) * 100) };
    if (!o) return { mem, disk: null, battery: null, procs: null, diskSupported: true, warming: true };
    const disk = o.dr != null ? { read: Number(o.dr) || 0, write: Number(o.dw) || 0 } : null;
    // Same helper output as last time: keep the last groups (and their CPU).
    if (o.t === lastT) return { mem, disk, battery: o.battery, procs: null, diskSupported: true };
    const dtSec = lastT ? (o.t - lastT) / 1000 : 0;
    lastT = o.t;
    const raw = (Array.isArray(o.procs) ? o.procs : [o.procs]).filter(Boolean);
    const procs = raw.map((p) => ({ pid: p.i, ppid: 0, name: p.n || '', desc: p.d || null, path: p.p || null, session: p.s, mem: p.m || 0, cpuSec: p.c || 0 }));
    withCpu(procs, dtSec);
    return { mem, disk, battery: o.battery, procs, diskSupported: true };
  }

  async function sample() {
    if (inflight) return inflight;
    inflight = (async () => {
      const cpu = cpuLoad();
      const s = platform === 'win32' ? sampleWin() : await samplePosix();
      let groups = lastGroups;
      if (s.procs) {
        groups = groupProcesses(s.procs, { platform, uid, selfPids: selfPids(), systemRoot });
        lastGroups = groups;
      }
      return {
        t: Date.now(),
        platform,
        cpu: { load: cpu, cores, model: (os.cpus()[0] || {}).model || '' },
        mem: s.mem,
        disk: s.disk,
        diskSupported: s.diskSupported,
        battery: s.battery,
        thermal: thermal(),
        procs: topGroups(groups),
        procCount: groups.reduce((n, g) => n + g.count, 0),
        warming: !!s.warming,
      };
    })().finally(() => (inflight = null));
    return inflight;
  }

  // Quit a business. Everything is worked out again here from a fresh process
  // list: the page only names the group, never the pids.
  async function quit(key, force = false) {
    let procs;
    if (platform === 'win32') {
      const g = lastGroups.find((x) => x.key === key);
      if (!g) return { ok: false, error: 'It has already closed.' };
      if (!g.canQuit) return { ok: false, error: g.self ? 'That is Gigapolis itself.' : 'That one keeps Windows running, so Gigapolis leaves it alone.' };
      // Check the pids still belong to the same program before touching them.
      const list = await run('tasklist', ['/FO', 'CSV', '/NH']);
      const live = new Map();
      for (const line of list.split('\n')) {
        const m = line.match(/^"([^"]+)","(\d+)"/);
        if (m) live.set(Number(m[2]), m[1].replace(/\.exe$/i, '').toLowerCase());
      }
      const name = key.slice(4);
      const pids = g.pids.filter((pid) => live.get(pid) === name);
      if (!pids.length) return { ok: false, error: 'It has already closed.' };
      const args = [...(force ? ['/F'] : []), '/T', ...pids.flatMap((p) => ['/PID', String(p)])];
      const out = await new Promise((resolve) => execFile('taskkill', args, { windowsHide: true }, (err, so, se) => resolve({ err, text: String(se || so || '') })));
      if (out.err && !force) return { ok: false, error: 'It did not want to close politely.', needsForce: true };
      if (out.err) return { ok: false, error: out.text.trim() || 'Windows would not let it close.' };
      return { ok: true, name: g.name };
    }
    procs = parsePs(await run('ps', ['-Aeo', 'pid=,ppid=,uid=,rss=,time=,comm=']));
    const groups = groupProcesses(procs, { platform, uid, selfPids: selfPids(), systemRoot });
    const g = groups.find((x) => x.key === key);
    if (!g) return { ok: false, error: 'It has already closed.' };
    if (g.self) return { ok: false, error: 'That is Gigapolis itself.' };
    if (g.system) return { ok: false, error: 'That one keeps macOS running, so Gigapolis leaves it alone.' };
    // Polite quit: ask the top process(es) to close; helpers follow them.
    const targets = force ? g.pids : g.roots.length ? g.roots : g.pids;
    let sent = 0;
    for (const pid of targets) {
      try {
        process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
        sent++;
      } catch {}
    }
    if (!sent) return { ok: false, error: 'macOS would not let it close.' };
    return { ok: true, name: g.name };
  }

  return { sample, quit, stop: () => win && win.stop() };
}

module.exports = { createMonitor, parseCpuTime, parsePs, groupOf, groupProcesses, topGroups, systemReason, parseVmStat, macMemory, parseIoreg, parsePmset, pressureFromPct, winBattery, WIN_SCRIPT };

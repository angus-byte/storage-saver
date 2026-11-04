// City Hall on Windows: the same Moving Day and Rush Hour as the Mac, built on
// Windows' own records. Apps come from the registry Uninstall keys (plus Store
// apps); moving one out runs the app's own uninstaller, then moves the boxes
// it left in AppData / ProgramData to the Recycle Bin. Rush Hour reads the Run
// keys, the Startup folders and logon/boot scheduled tasks.
//
// Windows is asked through PowerShell (one call per list, JSON back); the
// parsing and matching below is plain JS so it can be tested anywhere.
const fsp = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { sizeOf } = require('./deepclean');

const DAY = 86400000;
const pw = path.win32;

/** Runs a PowerShell script and returns its stdout (UTF-8). */
function ps(script, timeout = 30000) {
  const full = "$ErrorActionPreference='SilentlyContinue';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.Encoding]::UTF8;" + script;
  const enc = Buffer.from(full, 'utf16le').toString('base64');
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }, (err, stdout) =>
      resolve({ ok: !err, out: String(stdout || '') }),
    );
  });
}
async function psJson(script, timeout) {
  const r = await ps(script, timeout);
  try {
    return JSON.parse(r.out.trim() || 'null');
  } catch {
    return null;
  }
}
const q = (s) => "'" + String(s).replace(/'/g, "''") + "'"; // PowerShell string literal
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const exists = (p) => fsp.lstat(p).then(() => true, () => false);
const low = (s) => String(s || '').toLowerCase();

/** %ProgramFiles%\x → C:\Program Files\x (unknown variables are left as they are). */
function expandEnv(s, env = process.env) {
  return String(s || '').replace(/%([^%]+)%/g, (m, k) => {
    const key = Object.keys(env).find((e) => e.toLowerCase() === k.toLowerCase());
    return key ? env[key] : m;
  });
}

/** The program a command line starts: "C:\a b\x.exe" -arg → C:\a b\x.exe. */
function programOf(cmd, env) {
  const s = expandEnv(cmd, env).trim();
  if (!s) return '';
  if (s[0] === '"') {
    const end = s.indexOf('"', 1);
    return end > 0 ? s.slice(1, end) : s.slice(1);
  }
  const m = s.match(/^(.*?\.(exe|com|bat|cmd|vbs|js|ps1|scr|lnk))(\s|$)/i);
  if (m) return m[1];
  return s.split(/\s+/)[0];
}

/** Splits an uninstall command into file + arguments for Start-Process. MSI /I (repair) becomes /X (remove). */
function splitCommand(cmd) {
  const s = expandEnv(cmd).trim();
  const file = programOf(s);
  let rest = s.slice(s[0] === '"' ? file.length + 2 : file.length).trim();
  if (/^msiexec(\.exe)?$/i.test(pw.basename(file))) rest = rest.replace(/(^|\s)\/I\s*(\{[0-9A-F-]+\})/i, '$1/X$2');
  return { file, args: rest };
}

// ---------------------------------------------------------------------------
// Moving Day
// ---------------------------------------------------------------------------

const UNINSTALL_KEYS = [
  ['HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'you'],
  ['HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'all'],
  ['HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'all'],
];

const APPS_PS = `
$out=@()
foreach($k in @(${UNINSTALL_KEYS.map(([k, s]) => `@(${q(k)},${q(s)})`).join(',')})){
  Get-ChildItem $k[0] | ForEach-Object { $p=Get-ItemProperty $_.PSPath
    $out+=[pscustomobject]@{key=$_.Name;scope=$k[1];DisplayName=$p.DisplayName;DisplayVersion=[string]$p.DisplayVersion;Publisher=$p.Publisher;InstallLocation=$p.InstallLocation;DisplayIcon=$p.DisplayIcon;UninstallString=$p.UninstallString;EstimatedSize=$p.EstimatedSize;SystemComponent=$p.SystemComponent;ParentKeyName=$p.ParentKeyName;ReleaseType=$p.ReleaseType;NoRemove=$p.NoRemove} } }
$start=@{}; Get-StartApps | ForEach-Object { $start[$_.AppID.Split('!')[0]]=$_.Name }
$store=@(Get-AppxPackage | Where-Object { -not $_.IsFramework -and -not $_.NonRemovable -and $_.SignatureKind -eq 'Store' -and $_.Publisher -notmatch 'CN=Microsoft' } | ForEach-Object {
  [pscustomobject]@{Name=$_.Name;Display=$start[$_.PackageFamilyName];PackageFullName=$_.PackageFullName;PackageFamilyName=$_.PackageFamilyName;InstallLocation=$_.InstallLocation;Version=[string]$_.Version} })
@{reg=$out;store=$store} | ConvertTo-Json -Depth 3 -Compress`;

// Shared pieces of Windows that other apps need: never offered for removal (like Apple's own apps on the Mac).
const HIDE_APP = /(redistributable|runtime|\.net |\bsdk\b|driver|webview2|visual c\+\+|directx|microsoft update health|windows (pc health|subsystem)|gigapolis)/i;

/** Registry Uninstall entries → apps a person can remove. Pure. */
function parseApps(raw) {
  const apps = [];
  const seen = new Set();
  for (const e of arr(raw && raw.reg)) {
    const name = String(e.DisplayName || '').trim();
    if (!name || !e.UninstallString || Number(e.SystemComponent) === 1 || Number(e.NoRemove) === 1 || e.ParentKeyName || /update|hotfix/i.test(e.ReleaseType || '')) continue;
    if (HIDE_APP.test(name) || /^KB\d+/.test(name)) continue;
    const dedupe = low(name) + '|' + low(e.DisplayVersion);
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    let loc = String(e.InstallLocation || '').replace(/^"|"$/g, '').replace(/[\\/]+$/, '');
    if (!loc && e.DisplayIcon) {
      const icon = programOf(String(e.DisplayIcon).replace(/,\s*-?\d+$/, ''));
      if (/\\program files( \(x86\))?\\[^\\]+\\/i.test(icon) || /\\appdata\\local\\(programs\\)?[^\\]+\\/i.test(icon)) loc = pw.dirname(icon);
    }
    if (isRootish(loc)) loc = '';
    apps.push({
      name,
      path: e.key, // registry key: the id Moving Day uses for this app
      key: e.key,
      kind: 'win32',
      version: String(e.DisplayVersion || ''),
      publisher: String(e.Publisher || ''),
      installLocation: loc,
      uninstall: String(e.UninstallString),
      estimated: Number(e.EstimatedSize) > 0 ? Number(e.EstimatedSize) * 1024 : 0,
      scope: e.scope,
      appStore: false,
    });
  }
  for (const s of arr(raw && raw.store)) {
    const name = String(s.Display || '').trim() || tidyPackageName(s.Name);
    apps.push({ name, path: 'appx:' + s.PackageFullName, key: s.PackageFullName, kind: 'appx', family: s.PackageFamilyName, version: String(s.Version || ''), publisher: '', installLocation: String(s.InstallLocation || ''), uninstall: '', estimated: 0, scope: 'you', appStore: true });
  }
  return apps;
}

// SpotifyAB.SpotifyMusic → Spotify Music
function tidyPackageName(n) {
  const last = String(n || '').split('.').pop();
  return last.replace(/([a-z])([A-Z])/g, '$1 $2');
}

function isRootish(p) {
  if (!p) return true;
  const s = low(p).replace(/\//g, '\\').replace(/\\+$/, '');
  return /^[a-z]:$/.test(s) || /^[a-z]:\\(program files( \(x86\))?|programdata|windows|users|users\\[^\\]+|users\\[^\\]+\\appdata\\(local|roaming|locallow)(\\programs)?)$/.test(s);
}

// Folder names that are never one app's own box.
const KEEP_FOLDER = /^(microsoft|windows|packages|programs|temp|tmp|comms|connecteddevicesplatform|d3dscache|crashdumps|virtualstore|package cache|publishers|placeholdertilelogofolder|application data|history|fontcache|elevateddiagnostics|common files|application|app|bin|data|cache|caches|config|settings|logs|update|updater|gigapolis|storage-saver|desktop|documents|downloads)$/i;

const VERSIONISH = /\s*(\(?\s*(x64|x86|64-bit|32-bit|arm64|amd64)\s*\)?|\bv?\d+(\.\d+)+\S*|\(\s*\d+(\.\d+)*\s*\)|\s-\s.*)\s*$/i;
/** "7-Zip 23.01 (x64)" → "7-Zip". */
function baseName(name) {
  let s = String(name || '').trim();
  for (let i = 0; i < 4; i++) s = s.replace(VERSIONISH, '').trim();
  return s;
}
/** "Google LLC" → "Google". */
function vendorName(pub) {
  let s = String(pub || '').trim();
  const tail = /[,.]?\s*\b(inc|llc|ltd|limited|gmbh|corp|corporation|co|s\.a|ab|b\.v|pty|software|technologies|international)\.?\s*$/i;
  for (let i = 0; i < 4 && tail.test(s); i++) s = s.replace(tail, '').trim();
  return s;
}

/** Folder names an app's own boxes are kept under. */
function boxNames(app) {
  const out = new Set();
  const add = (s) => {
    s = String(s || '').trim();
    if (s.length > 2 && !KEEP_FOLDER.test(s)) out.add(low(s));
  };
  add(app.name);
  add(baseName(app.name));
  if (app.installLocation && app.kind === 'win32') {
    const b = pw.basename(app.installLocation);
    if (KEEP_FOLDER.test(b) || /^\d+(\.\d+)*$/.test(b)) add(pw.basename(pw.dirname(app.installLocation)));
    else add(b);
  }
  return out;
}

/** Places apps keep their files. */
function leftoverRoots(home, env = process.env) {
  return [
    ['AppData', path.join(home, 'AppData', 'Roaming')],
    ['Local', path.join(home, 'AppData', 'Local')],
    ['LocalLow', path.join(home, 'AppData', 'LocalLow')],
    ['ProgramData', env.ProgramData || env.PROGRAMDATA || 'C:\\ProgramData'],
  ];
}

/**
 * An app's boxes: <root>\<App> and <root>\<Vendor>\<App>, matched by exact
 * folder name only (never a whole vendor folder, never a folder another
 * installed app also claims). Store apps: their Packages folder.
 */
async function appFiles(app, home, { others = [], env } = {}) {
  const out = [];
  if (app.kind === 'appx') {
    const p = path.join(home, 'AppData', 'Local', 'Packages', app.family || '');
    if (app.family && (await exists(p))) out.push({ name: `Packages › ${app.family}`, path: p, size: await sizeOf(p) });
    return out;
  }
  const mine = boxNames(app);
  if (!mine.size) return out;
  const theirs = new Set();
  for (const o of others) if (o !== app && o.kind === 'win32') for (const n of boxNames(o)) theirs.add(n);
  const vendor = low(vendorName(app.publisher));
  const ok = (n) => mine.has(low(n)) && !theirs.has(low(n));
  for (const [label, root] of leftoverRoots(home, env)) {
    let entries = [];
    try {
      entries = await fsp.readdir(root, { withFileTypes: true });
    } catch {}
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (ok(e.name)) {
        const p = path.join(root, e.name);
        out.push({ name: `${label} › ${e.name}`, path: p, size: await sizeOf(p) });
      } else if (vendor.length > 2 && !KEEP_FOLDER.test(e.name) && (low(e.name) === vendor || low(vendorName(e.name)) === vendor)) {
        let sub = [];
        try {
          sub = await fsp.readdir(path.join(root, e.name), { withFileTypes: true });
        } catch {}
        for (const s of sub) {
          if (!s.isDirectory() || !ok(s.name)) continue;
          const p = path.join(root, e.name, s.name);
          out.push({ name: `${label} › ${e.name} › ${s.name}`, path: p, size: await sizeOf(p) });
        }
      }
    }
  }
  return out.sort((a, b) => b.size - a.size);
}

/** Newest change in a folder or its first level: a stand-in for "last opened". */
async function touched(p) {
  let t = 0;
  try {
    t = (await fsp.stat(p)).mtimeMs;
    for (const e of await fsp.readdir(p)) {
      try {
        t = Math.max(t, (await fsp.stat(path.join(p, e))).mtimeMs);
      } catch {}
    }
  } catch {}
  return t;
}

async function readApps() {
  return parseApps(await psJson(APPS_PS, 60000));
}

async function listApps(home, { now = Date.now(), raw } = {}) {
  const list = raw ? parseApps(raw) : await readApps();
  const out = [];
  for (const app of list) {
    const files = await appFiles(app, home, { others: list });
    let size = app.installLocation ? await sizeOf(app.installLocation) : 0;
    if (!size) size = app.estimated;
    const filesSize = files.reduce((n, f) => n + f.size, 0);
    let used = 0;
    for (const f of files) used = Math.max(used, await touched(f.path));
    out.push({ ...app, size, files, filesSize, total: size + filesSize, lastUsed: used, unused: !!used && now - used > 180 * DAY });
  }
  return out.sort((a, b) => b.total - a.total);
}

/** Names + vendors of installed apps, for Deep Clean's leftover check. */
async function appNames() {
  const names = new Set();
  for (const a of await readApps()) {
    names.add(low(a.name));
    names.add(low(baseName(a.name)));
    if (a.publisher) names.add(low(vendorName(a.publisher)));
    for (const n of boxNames(a)) names.add(n);
  }
  names.delete('');
  return { names, ids: new Set() };
}

async function runningPrograms() {
  const r = await ps('Get-Process | ForEach-Object { $_.Path } | Where-Object { $_ }', 15000);
  return r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

async function isRunning(app) {
  if (!app.installLocation) return false;
  const dir = low(app.installLocation).replace(/\\+$/, '') + '\\';
  return (await runningPrograms()).some((p) => low(p).startsWith(dir));
}

async function stillInstalled(app) {
  if (app.kind === 'appx') return (await ps(`if(Get-AppxPackage | Where-Object { $_.PackageFullName -eq ${q(app.key)} }){'yes'}`, 20000)).out.includes('yes');
  return (await ps(`if(Test-Path -LiteralPath ${q('Registry::' + app.key)}){'yes'}`, 10000)).out.includes('yes');
}

/**
 * Runs the app's own uninstaller (Windows shows its window, and a UAC prompt
 * for apps installed for every user) and waits for it. Resolves true once the
 * app is gone from Windows' list of installed apps.
 */
async function runUninstaller(app, { waitMs = 15 * 60000 } = {}) {
  if (app.kind === 'appx') {
    await ps(`Remove-AppxPackage -Package ${q(app.key)}`, 10 * 60000);
  } else {
    const { file, args } = splitCommand(app.uninstall);
    if (!file) return false;
    // Start-Process goes through ShellExecute, so elevation works; -Wait also waits for helper copies NSIS starts.
    await ps(`Start-Process -FilePath ${q(file)}${args ? ` -ArgumentList ${q(args)}` : ''} -Wait`, waitMs);
  }
  // Some uninstallers hand off to a helper and return early: give them a moment.
  for (let i = 0; i < 20; i++) {
    if (!(await stillInstalled(app))) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rush Hour
// ---------------------------------------------------------------------------

const RUN = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved';
const RUN_KEYS = [
  ['HKCU', RUN, 'you', 'Run'],
  ['HKLM', RUN, 'all', 'Run'],
  ['HKLM', 'Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run', 'all', 'Run32'],
];

const STARTUP_PS = `
$run=@(); foreach($k in @(${RUN_KEYS.map(([h, k, s, a]) => `@(${q(h)},${q(k)},${q(s)},${q(a)})`).join(',')})){ $i=Get-Item -LiteralPath ($k[0]+':\\'+$k[1]); if($i){ foreach($n in $i.GetValueNames()){ if($n){ $run+=[pscustomobject]@{hive=$k[0];key=$k[1];scope=$k[2];approved=$k[3];name=$n;command=[string]$i.GetValue($n,'',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)} } } } }
$off=@(); foreach($h in @('HKCU','HKLM')){ foreach($s in @('Run','Run32','StartupFolder')){ $i=Get-Item -LiteralPath ($h+':\\${APPROVED}\\'+$s); if($i){ foreach($n in $i.GetValueNames()){ $v=$i.GetValue($n); if($v -and $v.Length -and ($v[0] -band 1)){ $off+=($h+'|'+$s+'|'+$n) } } } } }
$sh=New-Object -ComObject WScript.Shell; $files=@()
foreach($f in @(@([Environment]::GetFolderPath('Startup'),'you'),@([Environment]::GetFolderPath('CommonStartup'),'all'))){ if($f[0] -and (Test-Path -LiteralPath $f[0])){ Get-ChildItem -LiteralPath $f[0] -File -Force | Where-Object { $_.Name -ne 'desktop.ini' } | ForEach-Object { $t=''; if($_.Extension -eq '.lnk'){ $t=$sh.CreateShortcut($_.FullName).TargetPath }; $files+=[pscustomobject]@{file=$_.FullName;scope=$f[1];target=[string]$t;hidden=[bool]($_.Attributes -band [IO.FileAttributes]::Hidden)} } } }
$tasks=@(Get-ScheduledTask | Where-Object { $_.State -ne 'Disabled' -and $_.TaskPath -notlike '\\Microsoft\\*' -and ($_.Triggers | Where-Object { $_.CimClass.CimClassName -in 'MSFT_TaskLogonTrigger','MSFT_TaskBootTrigger' }) } | ForEach-Object { $a=$_.Actions | Select-Object -First 1; [pscustomobject]@{name=$_.TaskName;path=$_.TaskPath;program=[string]$a.Execute;running=($_.State -eq 'Running')} })
$procs=@(Get-Process | ForEach-Object { $_.Path } | Where-Object { $_ })
@{run=$run;off=$off;files=$files;tasks=$tasks;procs=$procs} | ConvertTo-Json -Depth 3 -Compress`;

// Well-known Windows adware / PUP families. A strong hint, not proof.
const ADWARE = /(conduit|babylon|mywebsearch|mindspark|ask ?toolbar|sweetim|delta-?homes|search ?protect|wajam|crossrider|opencandy|installcore|reimage|restoro|segurazo|bytefence|pc ?accelerate|driver ?(booster|support|updater)|mypcbackup|wincleaner|advanced ?system ?care|pcoptimizer|onesafe|webcompanion|shopperpro|browsefox|multiplug|superfish|vosteran|safefinder|lollipop|coupon|clara ?search|kingoffers)/i;
const ODD_PLACE = /\\(temp|tmp)\\|\\users\\public\\|\\\$recycle\.bin\\|\\appdata\\local\\temp\\|^[a-z]:\\programdata\\[^\\]+\.(exe|dll|vbs|js|bat|cmd|ps1)$|\\\.[^\\]+\\/i;

/** Neighbourhood Watch flags, Windows edition (same flags as the Mac). */
function watchFlags({ name, program, programExists, signed, hidden }) {
  const flags = [];
  if (program && programExists === false) flags.push('ghost');
  if (ADWARE.test(name || '') || ADWARE.test(program || '')) flags.push('adware');
  if (hidden || ODD_PLACE.test(program || '')) flags.push('hidden');
  if (programExists && signed === false) flags.push('unsigned');
  return flags;
}

/** A full path we can check (bare names like "ctfmon.exe" are found via PATH: left unchecked). */
const checkable = (p) => /^[a-z]:\\/i.test(p || '') && !/%/.test(p);

/** PowerShell's raw startup data → Rush Hour items. Pure apart from `exists` / `signed`. */
async function buildStartup(raw, { exists: ex = exists, signed = {}, env = process.env } = {}) {
  const off = new Set(arr(raw && raw.off).map(low));
  const procs = new Set(arr(raw && raw.procs).map(low));
  const items = [];
  const add = async (it, hidden = false) => {
    const known = checkable(it.program);
    const programExists = known ? await ex(it.program) : it.program ? null : false;
    const sig = known && programExists ? signed[low(it.program)] : null;
    const flags = watchFlags({ name: it.label, program: it.program, programExists, signed: sig === undefined ? null : sig, hidden });
    items.push({ ...it, running: it.running || (known && procs.has(low(it.program))), flags, freeToRemove: flags.some((f) => FREE_FLAGS.has(f)) });
  };
  for (const r of arr(raw && raw.run)) {
    if (off.has(low(`${r.hive}|${r.approved}|${r.name}`)) || off.has(low(`HKCU|${r.approved}|${r.name}`))) continue; // already switched off in Task Manager
    const program = programOf(r.command, env);
    const id = `${r.hive}\\${r.key}\\${r.name}`;
    await add({ name: r.name, label: r.command, path: 'reg:' + id, reveal: checkable(program) ? program : '', program, scope: r.scope, kind: 'run', regName: r.name, approved: r.approved, canRemove: r.scope === 'you' });
  }
  for (const f of arr(raw && raw.files)) {
    const base = pw.basename(f.file).replace(/\.lnk$/i, '');
    if (off.has(low(`${f.scope === 'you' ? 'HKCU' : 'HKLM'}|StartupFolder|${pw.basename(f.file)}`))) continue;
    const program = f.target || f.file;
    await add({ name: base, label: pw.basename(f.file), path: f.file, reveal: f.file, program, scope: f.scope, kind: 'folder', canRemove: f.scope === 'you' }, !!f.hidden);
  }
  for (const t of arr(raw && raw.tasks)) {
    const program = programOf(t.program, env);
    await add({ name: t.name, label: `${t.path}${t.name}`, path: `task:${t.path}${t.name}`, reveal: checkable(program) ? program : '', program, scope: 'all', kind: 'task', canRemove: false, running: !!t.running });
  }
  const rank = (i) => (i.flags.includes('adware') ? 0 : i.flags.length ? 1 : 2);
  return items.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

const FREE_FLAGS = new Set(['ghost', 'adware', 'hidden']);

async function signatures(paths) {
  const out = {};
  if (!paths.length) return out;
  const r = await ps(`foreach($p in @(${paths.map(q).join(',')})){ $s=Get-AuthenticodeSignature -LiteralPath $p; $p+[char]9+$s.Status }`, 60000);
  for (const line of r.out.split(/\r?\n/)) {
    const [p, st] = line.split('\t');
    if (p && st) out[low(p.trim())] = /^valid/i.test(st.trim()) ? true : /notsigned/i.test(st.trim()) ? false : null;
  }
  return out;
}

async function listStartup() {
  const raw = (await psJson(STARTUP_PS, 60000)) || {};
  const progs = new Set();
  for (const r of arr(raw.run)) progs.add(programOf(r.command));
  for (const f of arr(raw.files)) progs.add(f.target || f.file);
  for (const t of arr(raw.tasks)) progs.add(programOf(t.program));
  const check = [];
  for (const p of progs) if (checkable(p) && (await exists(p))) check.push(p);
  return buildStartup(raw, { signed: await signatures(check) });
}

/**
 * Switch off a commuter you own. Run-key items are switched off the way Task
 * Manager does it (StartupApproved), so they can be switched back on there.
 * Startup-folder shortcuts go to the Recycle Bin (done by the caller).
 */
async function disableRun(item) {
  const key = `HKCU\\${APPROVED}\\${item.approved || 'Run'}`;
  return new Promise((resolve) => {
    execFile('reg.exe', ['add', key, '/v', item.regName, '/t', 'REG_BINARY', '/d', '030000000000000000000000', '/f'], { timeout: 8000, windowsHide: true }, (err) => resolve(!err));
  });
}

// ---------------------------------------------------------------------------
// Recycle Bin (Street Sweep's "Trash" on Windows lives at the drive root, outside the scanned home)
// ---------------------------------------------------------------------------

async function userSid() {
  return new Promise((resolve) => {
    execFile('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { timeout: 6000, windowsHide: true }, (err, out) => {
      const m = String(out || '').match(/"(S-1-[\d-]+)"/);
      resolve(m ? m[1] : '');
    });
  });
}

/** This person's Recycle Bin folder on the home drive, with its size. */
async function recycleBin(home) {
  const sid = await userSid();
  if (!sid) return null;
  const p = pw.join(pw.parse(home).root, '$Recycle.Bin', sid);
  let size = 0;
  try {
    for (const e of await fsp.readdir(p)) if (e.toLowerCase() !== 'desktop.ini') size += await sizeOf(path.join(p, e));
  } catch {
    return null;
  }
  return { name: 'Recycle Bin', path: p, size, kind: 'trash', mtime: Date.now(), isDir: true };
}

async function emptyRecycleBin(dir) {
  const drive = pw.parse(dir).root.replace(/[:\\]/g, '');
  const r = await ps(`Clear-RecycleBin -DriveLetter ${q(drive)} -Force -ErrorAction Stop; 'ok'`, 120000);
  return r.out.includes('ok');
}

module.exports = {
  listApps,
  appFiles,
  appNames,
  isRunning,
  runUninstaller,
  stillInstalled,
  listStartup,
  buildStartup,
  disableRun,
  recycleBin,
  emptyRecycleBin,
  parseApps,
  programOf,
  splitCommand,
  expandEnv,
  boxNames,
  baseName,
  vendorName,
  watchFlags,
  isRootish,
};

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const w = require('../src/main/cityhall-win');
const { deepSuggestions } = require('../src/main/deepclean');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gp-win-'));
const put = (file, bytes = 10) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
};

test('programOf and splitCommand read Windows command lines', () => {
  const env = { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' };
  assert.strictEqual(w.programOf('"C:\\Program Files\\Zoom\\bin\\Zoom.exe" --autostart', env), 'C:\\Program Files\\Zoom\\bin\\Zoom.exe');
  assert.strictEqual(w.programOf('C:\\Program Files\\Foo Bar\\foo.exe -silent', env), 'C:\\Program Files\\Foo Bar\\foo.exe');
  assert.strictEqual(w.programOf('%ProgramFiles%\\x\\y.exe /min', env), 'C:\\Program Files\\x\\y.exe');
  assert.strictEqual(w.programOf('ctfmon.exe', env), 'ctfmon.exe');
  assert.deepStrictEqual(w.splitCommand('MsiExec.exe /I{12345678-ABCD-1234-ABCD-1234567890AB}'), { file: 'MsiExec.exe', args: '/X{12345678-ABCD-1234-ABCD-1234567890AB}' });
  assert.deepStrictEqual(w.splitCommand('"C:\\Program Files\\7-Zip\\Uninstall.exe"'), { file: 'C:\\Program Files\\7-Zip\\Uninstall.exe', args: '' });
  assert.deepStrictEqual(w.splitCommand('"C:\\Users\\a\\AppData\\Local\\slack\\Update.exe" --uninstall -s'), { file: 'C:\\Users\\a\\AppData\\Local\\slack\\Update.exe', args: '--uninstall -s' });
});

test('parseApps keeps real apps, hides Windows parts and updates', () => {
  const raw = {
    reg: [
      { key: 'HKEY_LOCAL_MACHINE\\...\\7-Zip', scope: 'all', DisplayName: '7-Zip 23.01 (x64)', DisplayVersion: '23.01', Publisher: 'Igor Pavlov', InstallLocation: 'C:\\Program Files\\7-Zip\\', UninstallString: '"C:\\Program Files\\7-Zip\\Uninstall.exe"', EstimatedSize: 5000 },
      { key: 'k2', scope: 'all', DisplayName: 'Microsoft Visual C++ 2015-2022 Redistributable (x64)', UninstallString: 'x' },
      { key: 'k3', scope: 'all', DisplayName: 'Hidden thing', UninstallString: 'x', SystemComponent: 1 },
      { key: 'k4', scope: 'all', DisplayName: 'Some Update', UninstallString: 'x', ParentKeyName: 'Office' },
      { key: 'k5', scope: 'all', DisplayName: 'No uninstaller' },
      { key: 'k6', scope: 'you', DisplayName: 'Slack', Publisher: 'Slack Technologies Inc.', DisplayIcon: 'C:\\Users\\a\\AppData\\Local\\slack\\app.ico', UninstallString: 'x' },
      { key: 'k7', scope: 'all', DisplayName: 'Weird', InstallLocation: 'C:\\Program Files', UninstallString: 'x' },
    ],
    store: { Name: 'SpotifyAB.SpotifyMusic', Display: 'Spotify', PackageFullName: 'SpotifyAB.SpotifyMusic_1.2_x64__zpdnekdrzrea0', PackageFamilyName: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0', InstallLocation: 'C:\\Program Files\\WindowsApps\\x', Version: '1.2' },
  };
  const apps = w.parseApps(raw);
  assert.deepStrictEqual(apps.map((a) => a.name), ['7-Zip 23.01 (x64)', 'Slack', 'Weird', 'Spotify']);
  assert.strictEqual(apps[0].installLocation, 'C:\\Program Files\\7-Zip');
  assert.strictEqual(apps[0].estimated, 5000 * 1024);
  assert.strictEqual(apps[2].installLocation, ''); // never a whole Program Files
  assert.ok(apps[3].appStore && apps[3].path.startsWith('appx:'));
});

test('baseName, vendorName, boxNames', () => {
  assert.strictEqual(w.baseName('7-Zip 23.01 (x64)'), '7-Zip');
  assert.strictEqual(w.baseName('Zoom Workplace (64-bit)'), 'Zoom Workplace');
  assert.strictEqual(w.vendorName('Google LLC'), 'Google');
  assert.strictEqual(w.vendorName('Blackmagic Design Pty. Ltd.'), 'Blackmagic Design');
  const chrome = { kind: 'win32', name: 'Google Chrome', installLocation: 'C:\\Program Files\\Google\\Chrome\\Application' };
  assert.deepStrictEqual([...w.boxNames(chrome)].sort(), ['chrome', 'google chrome']);
});

test('appFiles finds AppData boxes by exact name, under the vendor too, never shared ones', async () => {
  const home = tmp();
  const A = (p) => path.join(home, 'AppData', ...p.split('/'));
  put(A('Roaming/DaVinci Resolve/prefs'), 100);
  put(A('Local/Blackmagic Design/DaVinci Resolve/cache'), 1000);
  put(A('Local/Blackmagic Design/Fusion/keep'), 999); // another app from the same vendor
  put(A('Local/DaVinci/keep'), 999); // similar name: not matched
  put(A('Roaming/Microsoft/keep'), 999);
  put(A('Local/Shared/keep'), 999);
  const resolve = { kind: 'win32', name: 'DaVinci Resolve', publisher: 'Blackmagic Design Pty. Ltd.', installLocation: 'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve' };
  const other = { kind: 'win32', name: 'Shared', publisher: 'X' };
  const files = await w.appFiles(resolve, home, { others: [resolve, other] });
  assert.deepStrictEqual(files.map((f) => f.name), ['Local › Blackmagic Design › DaVinci Resolve', 'AppData › DaVinci Resolve']);
  // A folder two installed apps both claim is left alone.
  const twin = { kind: 'win32', name: 'Shared', publisher: 'Y' };
  assert.deepStrictEqual(await w.appFiles(twin, home, { others: [twin, other] }), []);
  // Store apps: their Packages folder.
  put(A('Local/Packages/Spotify_x/LocalState/a'), 50);
  const sp = await w.appFiles({ kind: 'appx', family: 'Spotify_x' }, home);
  assert.strictEqual(sp.length, 1);
});

test('Rush Hour on Windows: Run keys, Startup folder, tasks, with Neighbourhood Watch', async () => {
  const raw = {
    run: [
      { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', scope: 'you', approved: 'Run', name: 'Spotify', command: '"C:\\Users\\a\\AppData\\Roaming\\Spotify\\Spotify.exe" /minimized' },
      { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', scope: 'you', approved: 'Run', name: 'Gone', command: '"C:\\Program Files\\Gone\\gone.exe"' },
      { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', scope: 'you', approved: 'Run', name: 'Off already', command: 'C:\\x.exe' },
      { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', scope: 'you', approved: 'Run', name: 'Updater', command: 'C:\\Users\\a\\AppData\\Local\\Temp\\upd.exe' },
      { hive: 'HKLM', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', scope: 'all', approved: 'Run', name: 'SecurityHealth', command: '%windir%\\system32\\SecurityHealthSystray.exe' },
      { hive: 'HKLM', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', scope: 'all', approved: 'Run', name: 'WebCompanion', command: '"C:\\Program Files (x86)\\Lavasoft\\Web Companion\\WebCompanion.exe" -silent' },
    ],
    off: ['HKCU|Run|Off already'],
    files: [{ file: 'C:\\Users\\a\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\Notes.lnk', scope: 'you', target: 'C:\\Tools\\notes.exe', hidden: false }],
    tasks: [{ name: 'GoogleUpdateTaskMachineUA', path: '\\', program: '"C:\\Program Files (x86)\\Google\\Update\\GoogleUpdate.exe"', running: false }],
    procs: ['C:\\Users\\a\\AppData\\Roaming\\Spotify\\Spotify.exe'],
  };
  const present = new Set(['C:\\Users\\a\\AppData\\Roaming\\Spotify\\Spotify.exe', 'C:\\Users\\a\\AppData\\Local\\Temp\\upd.exe', 'C:\\Program Files (x86)\\Lavasoft\\Web Companion\\WebCompanion.exe', 'C:\\Tools\\notes.exe', 'C:\\Program Files (x86)\\Google\\Update\\GoogleUpdate.exe']);
  const items = await w.buildStartup(raw, { exists: async (p) => present.has(p), signed: { 'c:\\tools\\notes.exe': false }, env: {} });
  const by = Object.fromEntries(items.map((i) => [i.name, i]));
  assert.ok(!by['Off already'], 'switched off in Task Manager: not listed');
  assert.strictEqual(items[0].name, 'WebCompanion'); // adware first
  assert.deepStrictEqual(by.WebCompanion.flags, ['adware']);
  assert.strictEqual(by.WebCompanion.canRemove, false);
  assert.deepStrictEqual(by.Gone.flags, ['ghost']);
  assert.ok(by.Gone.freeToRemove && by.Gone.canRemove);
  assert.deepStrictEqual(by.Updater.flags, ['hidden']);
  assert.deepStrictEqual(by.Spotify.flags, []);
  assert.ok(by.Spotify.running);
  assert.ok(!by.Spotify.freeToRemove);
  assert.deepStrictEqual(by.SecurityHealth.flags, [], 'unexpanded %windir% is not a ghost');
  assert.deepStrictEqual(by.Notes.flags, ['unsigned']);
  assert.strictEqual(by.Notes.kind, 'folder');
  assert.strictEqual(by.GoogleUpdateTaskMachineUA.kind, 'task');
  assert.strictEqual(by.GoogleUpdateTaskMachineUA.canRemove, false);
});

test('Deep Clean finds Windows app leftovers only with the installed-app list', async () => {
  const home = tmp();
  const old = Date.now() - 200 * 86400000;
  for (const [rel, size] of [['AppData/Roaming/OldTool/big.bin', 30 * 1024 ** 2], ['AppData/Local/Spotify/cache.bin', 30 * 1024 ** 2], ['AppData/Local/Microsoft/x.bin', 30 * 1024 ** 2]]) {
    const f = path.join(home, ...rel.split('/'));
    put(f, size);
    fs.utimesSync(f, old / 1000, old / 1000);
    fs.utimesSync(path.dirname(f), old / 1000, old / 1000);
  }
  const tree = { name: 'h', path: home, isDir: true, size: 0, children: [] };
  const listApps = async () => ({ names: new Set(['spotify']), ids: new Set() });
  const deep = await deepSuggestions(tree, { home, platform: 'win32', listApps });
  assert.deepStrictEqual(deep.appLeftovers.items.map((i) => i.name), ['OldTool']);
  const none = await deepSuggestions(tree, { home, platform: 'win32' });
  assert.strictEqual(none.appLeftovers.items.length, 0);
});

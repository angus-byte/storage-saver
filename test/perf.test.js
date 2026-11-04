const test = require('node:test');
const assert = require('node:assert');
const p = require('../src/main/perf');

test('ps CPU time parses all formats', () => {
  assert.equal(p.parseCpuTime('0:01.50'), 1.5);
  assert.equal(p.parseCpuTime('12:34.00'), 754);
  assert.equal(p.parseCpuTime('1:02:03'), 3723);
  assert.equal(p.parseCpuTime('2-00:00:01'), 172801);
});

const PS = `    1     0     0  9000   1:00.00 /sbin/launchd
  400     1   501 512000   0:10.00 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
  401   400   501 256000   0:05.00 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/1/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)
  500     1   501 128000   0:01.00 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder
  501     1   501  64000   0:01.00 /System/Applications/Photos.app/Contents/MacOS/Photos
  502     1    88 300000   0:20.00 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer
  600     1   501  32000   0:00.50 /usr/local/bin/node
  700     1   501  16000   0:00.10 /Applications/Gigapolis.app/Contents/MacOS/Gigapolis
`;

test('mac processes group by app and flag the OS', () => {
  const procs = p.parsePs(PS);
  assert.equal(procs.length, 8);
  const groups = p.groupProcesses(procs, { platform: 'darwin', uid: 501, selfPids: [700] });
  const by = Object.fromEntries(groups.map((g) => [g.name, g]));
  assert.equal(by['Google Chrome'].count, 2);
  assert.equal(by['Google Chrome'].mem, (512000 + 256000) * 1024);
  assert.deepEqual(by['Google Chrome'].roots, [400]);
  assert.ok(by['Google Chrome'].canQuit);
  assert.ok(by.Photos.canQuit, 'Apple apps in /System/Applications can be quit');
  assert.ok(!by.Finder.canQuit);
  assert.ok(!by.WindowServer.canQuit, 'other users / OS');
  assert.ok(!by.launchd.canQuit);
  assert.ok(!by['/usr/local/bin/node'] && by.node.canQuit === false, '/usr is system');
  assert.ok(!by.Gigapolis.canQuit && by.Gigapolis.self);
});

test('windows: system dir, session 0, core names and no-path are protected', () => {
  const procs = [
    { pid: 10, name: 'chrome', desc: 'Google Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', session: 1, mem: 100, cpu: 2 },
    { pid: 11, name: 'chrome', desc: 'Google Chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', session: 1, mem: 50, cpu: 1 },
    { pid: 20, name: 'explorer', path: 'C:\\Windows\\explorer.exe', session: 1, mem: 10 },
    { pid: 21, name: 'svchost', path: null, session: 0, mem: 10 },
    { pid: 22, name: 'SomeService', path: 'C:\\Program Files\\X\\x.exe', session: 0, mem: 10 },
    { pid: 23, name: 'notepad', path: 'C:\\WINDOWS\\system32\\notepad.exe', session: 1, mem: 10 },
    { pid: 24, name: 'locked', path: null, session: 1, mem: 10 },
  ];
  const groups = p.groupProcesses(procs, { platform: 'win32', systemRoot: 'C:\\Windows' });
  const by = Object.fromEntries(groups.map((g) => [g.key, g]));
  assert.equal(by['win:chrome'].name, 'Google Chrome');
  assert.equal(by['win:chrome'].count, 2);
  assert.equal(by['win:chrome'].cpu, 3);
  assert.ok(by['win:chrome'].canQuit);
  for (const k of ['win:explorer', 'win:svchost', 'win:someservice', 'win:notepad', 'win:locked']) assert.ok(!by[k].canQuit, k);
});

test('top groups include the busiest by memory and by CPU', () => {
  const groups = Array.from({ length: 30 }, (_, i) => ({ key: 'k' + i, name: 'n' + i, mem: i, cpu: 30 - i, pids: [i], roots: [i] }));
  const top = p.topGroups(groups, 5);
  const keys = top.map((g) => g.key);
  assert.ok(keys.includes('k29') && keys.includes('k0'));
  assert.equal(top.length, 10);
  assert.ok(!('pids' in top[0]));
});

const VM = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               10000.
Pages active:                            200000.
Pages inactive:                          190000.
Pages speculative:                         5000.
Pages wired down:                         100000.
Pages purgeable:                           8000.
File-backed pages:                        150000.
Anonymous pages:                          250000.
Pages occupied by compressor:              50000.
`;

test('mac memory matches Activity Monitor sums', () => {
  const vm = p.parseVmStat(VM);
  assert.equal(vm.pageSize, 16384);
  const total = 16 * 1024 ** 3;
  const m = p.macMemory(vm, total, '2\ntotal = 2048.00M  used = 1024.00M  free = 1024.00M  (encrypted)\n');
  const pg = 16384;
  assert.equal(m.app, (250000 - 8000) * pg);
  assert.equal(m.used, (242000 + 100000 + 50000) * pg);
  assert.equal(m.pressure, 'warn');
  assert.equal(m.swapUsed, 1024 * 1024 ** 2);
});

test('pressure from percent', () => {
  assert.equal(p.pressureFromPct(50), 'normal');
  assert.equal(p.pressureFromPct(85), 'warn');
  assert.equal(p.pressureFromPct(95), 'critical');
});

test('ioreg disk bytes add up across disks', () => {
  const out = `"Statistics" = {"Operations (Write)"=1,"Bytes (Write)"=1000,"Bytes (Read)"=500}\n"Statistics" = {"Bytes (Write)"=10,"Bytes (Read)"=5}`;
  assert.deepEqual(p.parseIoreg(out), { read: 505, write: 1010 });
  assert.equal(p.parseIoreg(''), null);
});

test('pmset battery', () => {
  const b = p.parsePmset("Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1234)\t87%; discharging; 4:12 remaining present: true\n");
  assert.deepEqual(b, { percent: 87, charging: false, onAC: false, minutesLeft: 252 });
  const c = p.parsePmset("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t40%; charging; 1:00 remaining present: true\n");
  assert.equal(c.charging, true);
  assert.equal(c.onAC, true);
  assert.equal(c.minutesLeft, null);
  assert.equal(p.parsePmset("Now drawing from 'AC Power'\n"), null);
});

test('windows battery', () => {
  assert.deepEqual(p.winBattery({ EstimatedChargeRemaining: 60, BatteryStatus: 1, EstimatedRunTime: 120 }), { percent: 60, charging: false, onAC: false, minutesLeft: 120 });
  assert.equal(p.winBattery({ EstimatedChargeRemaining: 60, BatteryStatus: 2, EstimatedRunTime: 71582788 }).minutesLeft, null);
  assert.equal(p.winBattery(null), null);
});

test('monitor samples this machine and refuses to quit itself', async () => {
  const m = p.createMonitor({ selfPids: () => [process.pid] });
  const s = await m.sample();
  assert.ok(s.mem.total > 0 && s.cpu.cores > 0 && s.procs.length > 0);
  const self = s.procs.find((g) => g.self) || { key: 'exe:' + process.argv[0] };
  const r = await m.quit(self.key);
  assert.equal(r.ok, false);
});

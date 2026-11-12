const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const m = require('../src/main/maintenance');

const mac = m.macTasks({ uid: 501, exists: () => true });
const win = m.winTasks({ env: { SystemDrive: 'D:', SystemRoot: 'D:\\Windows' } });

test('task tables have unique ids and every job has a command', () => {
  for (const list of [mac, win]) {
    const ids = list.map((t) => t.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const t of list) {
      assert.ok(t.admin ? t.sh || t.ps : t.cmd, t.id);
      assert.ok(/^[a-z]+$/.test(t.id), t.id);
      assert.ok(t.ok && t.name && t.desc);
    }
  }
  assert.deepEqual(mac.map((t) => t.id), ['dns', 'launch', 'scripts', 'ram', 'firstaid', 'perms', 'snapshots', 'syscaches', 'syslogs', 'brew', 'spotlight']);
  assert.deepEqual(win.map((t) => t.id), ['dns', 'icons', 'cleanup', 'diskcheck', 'optimise', 'sfc']);
});

test('Homebrew clean-up only when brew is installed, and only fixed paths are deleted', () => {
  assert.ok(!m.macTasks({ exists: (p) => !/brew/.test(p) }).some((t) => t.id === 'brew'));
  const brew = m.macTasks({ exists: (p) => p === '/opt/homebrew/bin/brew' }).find((t) => t.id === 'brew');
  assert.equal(brew.cmd, '/opt/homebrew/bin/brew');
  assert.ok(!brew.admin);
  const caches = mac.find((t) => t.id === 'syscaches');
  assert.ok(caches.admin && caches.sh.startsWith('/usr/bin/find /Library/Caches -mindepth 1 '));
  assert.match(mac.find((t) => t.id === 'syslogs').sh, /-mtime \+7 -delete/);
});

test('maintenance scripts are hidden when periodic is missing', () => {
  assert.ok(!m.macTasks({ exists: () => false }).some((t) => t.id === 'scripts'));
});

test('the page never sees commands', () => {
  for (const t of [...mac, ...win].map(m.publicTask)) {
    assert.equal(t.sh, undefined);
    assert.equal(t.ps, undefined);
    assert.equal(t.cmd, undefined);
    assert.equal(t.args, undefined);
  }
});

test('only known ids are picked, in table order, once', () => {
  const p = m.pick(mac, ['spotlight', 'rm -rf /', 'dns', 'dns', '; reboot']);
  assert.deepEqual(p.map((t) => t.id), ['dns', 'spotlight']);
  assert.deepEqual(m.pick(mac, 'dns'), []);
  assert.deepEqual(m.pick(mac, null), []);
});

test('uid and drive letter cannot inject into commands', () => {
  const bad = m.macTasks({ uid: '501; rm -rf ~', exists: () => true }).find((t) => t.id === 'perms');
  assert.equal(bad.sh, '/usr/sbin/diskutil resetUserPermissions / 501');
  const w = m.winTasks({ env: { SystemDrive: 'C:; Format-Volume' } });
  assert.ok(w.find((t) => t.id === 'diskcheck').ps.includes('-DriveLetter C '));
  assert.ok(win.find((t) => t.id === 'diskcheck').ps.includes('-DriveLetter D '));
  assert.deepEqual(win.find((t) => t.id === 'cleanup').args, ['/dD']);
});

test('mac admin jobs share one script with exit markers', () => {
  const s = m.macAdminScript(m.pick(mac, ['dns', 'spotlight']));
  assert.match(s, /mDNSResponder \) >\/dev\/null 2>&1; echo "@@dns:\$\?"/);
  assert.match(s, /mdutil -E \/ \) >\/dev\/null 2>&1; echo "@@spotlight:\$\?"$/);
  assert.deepEqual(m.parseMarkers('blah\r@@dns:0\r@@spotlight:1\r'), { dns: 0, spotlight: 1 });
});

test('AppleScript and PowerShell strings are escaped', () => {
  assert.equal(m.asString('a "b" \\c'), '"a \\"b\\" \\\\c"');
  assert.equal(m.psString("it's"), "'it''s'");
});

test('windows admin script writes a JSON status per job', () => {
  const s = m.winAdminScript(m.pick(win, ['diskcheck', 'sfc']), "C:\\Users\\O'Neil\\x.json");
  assert.match(s, /Repair-Volume -DriveLetter D -Scan/);
  assert.match(s, /\$res\['diskcheck'\]/);
  assert.match(s, /\$res\['sfc'\]/);
  assert.match(s, /Wait-Job \$j -Timeout 1800/);
  assert.ok(s.includes("-Path 'C:\\Users\\O''Neil\\x.json'"));
});

test('exit codes map to friendly results', () => {
  const fa = mac.find((t) => t.id === 'firstaid');
  assert.deepEqual(m.resultFor(fa, 0), { id: 'firstaid', ok: true, message: fa.ok });
  assert.equal(m.resultFor(fa, 2).problems, true);
  assert.match(m.resultFor(fa, 124).message, /too long/);
  assert.match(m.resultFor(fa, 1).message, /code 1/);
  assert.equal(fa.classify(1, 'error: the volume is corrupt'), 2);
  assert.equal(fa.classify(1, 'Unable to run'), 1);
  assert.equal(fa.classify(0, 'appears to be OK'), 0);
});

test('mac admin run: one prompt, cancel is reported', async () => {
  const calls = [];
  const okExec = async (cmd, args) => {
    calls.push([cmd, args]);
    return { code: 0, out: '@@dns:0\r@@ram:1' };
  };
  const res = await m.runMacAdmin(m.pick(mac, ['dns', 'ram']), { exec: okExec });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/usr/bin/osascript');
  assert.match(calls[0][1][1], /^do shell script ".*" with administrator privileges$/);
  assert.deepEqual(res.map((r) => r.ok), [true, false]);
  const cancel = await m.runMacAdmin(m.pick(mac, ['dns']), { exec: async () => ({ code: 1, out: 'execution error: User canceled. (-128)' }) });
  assert.equal(cancel[0].cancelled, true);
});

test('user jobs fall back to other args and report missing tools', async () => {
  const launch = mac.find((t) => t.id === 'launch');
  const seen = [];
  const r = await m.runUserTask(launch, { exec: async (cmd, args) => (seen.push(args), { code: seen.length === 1 ? 1 : 0, out: '' }) });
  assert.equal(seen.length, 2);
  assert.ok(!seen[1].includes('-kill'));
  assert.ok(r.ok);
  const miss = await m.runUserTask(win[0], { exec: async () => ({ code: 'ENOENT', out: '', missing: true }) });
  assert.match(miss.message, /Not available/);
});

test('maintenance run: admin batched once, history saved, busy guard', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-'));
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push(cmd);
    if (cmd === '/usr/bin/osascript') return { code: 0, out: '@@dns:0\r@@spotlight:0\r@@ram:0' };
    return { code: 0, out: 'appears to be OK' };
  };
  const svc = m.createMaintenance({ platform: 'darwin', dir, exec });
  const list = svc.list();
  assert.ok(list.tasks.every((t) => !('sh' in t)));
  const p = svc.run(['spotlight', 'firstaid', 'dns', 'ram', 'bogus']);
  assert.equal((await svc.run(['dns'])).error, 'Already running maintenance.');
  const r = await p;
  assert.ok(r.ok);
  assert.deepEqual(r.results.map((x) => x.id), ['dns', 'ram', 'firstaid', 'spotlight']);
  assert.equal(calls.filter((c) => c === '/usr/bin/osascript').length, 1);
  assert.ok(r.lastRun.dns > 0);
  const again = m.createMaintenance({ platform: 'darwin', dir, exec });
  assert.ok(again.list().lastRun.firstaid > 0);
  assert.equal((await svc.run([])).error, 'Nothing selected.');
  fs.rmSync(dir, { recursive: true, force: true });
});

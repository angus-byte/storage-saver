const test = require('node:test');
const assert = require('node:assert');
const { createSysSpace, parseDu, overlaps } = require('../src/main/sysspace');

test('parseDu reads du -k -d 1 output', () => {
  const r = parseDu('100\t/Library/Audio\n2000\t/Library/Application Support\n2100\t/Library\n', '/Library');
  assert.equal(r.size, 2100 * 1024);
  assert.deepEqual(r.children.map((c) => c.name), ['Application Support', 'Audio']);
});

test('overlaps', () => {
  assert.ok(overlaps('/Users/a', '/'));
  assert.ok(overlaps('/Users/a/x', '/Users/a'));
  assert.ok(!overlaps('/Users/ab', '/Users/a'));
});

test('measure builds parts and skips the scanned folder', async () => {
  const GB = 1024 * 1024 * 1024;
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    if (cmd.endsWith('tmutil')) return { stdout: 'com.apple.TimeMachine.2026-11-01-010101.local\ncom.apple.TimeMachine.2026-11-02-010101.local\n', stderr: '' };
    if (cmd.endsWith('osascript')) return { stdout: String(150 * GB) + '\n', stderr: '' };
    const dir = args[args.length - 1];
    if (dir === '/Users/bob') return { stdout: '0\t/Users/bob\n', stderr: 'du: /Users/bob: Permission denied\n' };
    return { stdout: `${(GB / 1024) * 2}\t${dir}/Big\n${(GB / 1024) * 3}\t${dir}\n`, stderr: '' };
  };
  const fsImpl = {
    existsSync: (p) => p !== '/opt',
    readdirSync: (d) => (d === '/Users' ? ['angus', 'bob', 'Shared', '.localized'] : d === '/System/Volumes/VM' ? ['swapfile0'] : []),
    statSync: () => ({ isFile: () => true, size: 2 * GB }),
  };
  const s = createSysSpace({ exec, fsImpl, home: '/Users/angus', platform: 'darwin' });
  const r = await s.measure({ scanRoot: '/Users/angus', free: 50 * GB });
  const by = Object.fromEntries(r.parts.map((p) => [p.id, p]));
  assert.equal(by.purgeable.size, 100 * GB);
  assert.equal(by.purgeable.snapshots, 2);
  assert.equal(by.swap.size, 2 * GB);
  assert.equal(by.library.size, 3 * GB);
  assert.equal(by.library.children[0].path, '/Library/Big');
  assert.equal(by.dev.size, 3 * GB); // /usr/local only, /opt missing
  assert.ok(by.users.private);
  assert.deepEqual(by.users.children.map((c) => c.name), ['bob']);
  assert.ok(!calls.some((c) => c.includes('/Users/angus')));
  assert.equal(r.parts[0].id, 'purgeable');
});

test('measure skips parts inside a whole-disk scan, and is Mac only', async () => {
  const exec = async () => ({ stdout: '', stderr: '' });
  const fsImpl = { existsSync: () => true, readdirSync: () => [], statSync: () => ({ isFile: () => false }) };
  const r = await createSysSpace({ exec, fsImpl, platform: 'darwin' }).measure({ scanRoot: '/' });
  assert.deepEqual(r.parts, []);
  assert.equal(await createSysSpace({ platform: 'win32' }).measure({}), null);
});

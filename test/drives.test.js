const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDrives, providerName } = require('../src/main/drives');
const { scan } = require('../src/main/scanner');

const mac = createDrives({ home: '/Users/angus', platform: 'darwin', realpath: (p) => (p === '/Volumes/Macintosh HD' ? '/' : p) });

test('macOS: cloud folders in home are cloud drives', () => {
  const g = mac.classify('/Users/angus/Library/CloudStorage/GoogleDrive-angus@x.com/My Drive/clip.mov');
  assert.equal(g.kind, 'cloud');
  assert.equal(g.root, '/Users/angus/Library/CloudStorage/GoogleDrive-angus@x.com');
  assert.equal(g.label, 'Google Drive (angus@x.com)');
  assert.equal(mac.classify('/Users/angus/Library/Mobile Documents/com~apple~CloudDocs/a.pdf').label, 'iCloud Drive');
  for (const p of ['/Users/angus/Dropbox/x', '/Users/angus/Google Drive', '/Users/angus/OneDrive - Sommar/x', '/Users/angus/Box Sync']) assert.equal(mac.classify(p).kind, 'cloud', p);
});
test('macOS: home, its folders and the startup volume are not', () => {
  for (const p of ['/Users/angus', '/Users/angus/Movies/a.mov', '/Users/angus/Library/Caches', '/Users/angus/Boxes', '/Applications', '/Volumes/Macintosh HD/Users']) assert.equal(mac.classify(p), null, p);
});
test('macOS: /Volumes are other drives; GoogleDrive volume is cloud', () => {
  assert.deepEqual(mac.classify('/Volumes/Samsung T7/Footage'), { kind: 'external', label: 'Samsung T7', root: '/Volumes/Samsung T7' });
  assert.equal(mac.classify('/Volumes/GoogleDrive/My Drive').kind, 'cloud');
});
test('Windows: OneDrive, other drive letters, Google Drive letter, network shares', () => {
  const w = createDrives({ home: 'C:\\Users\\angus', platform: 'win32', env: { SystemDrive: 'C:' }, exists: (p) => p === 'G:\\My Drive' });
  assert.equal(w.classify('C:\\Users\\angus\\OneDrive\\Desktop\\a.txt').kind, 'cloud');
  assert.equal(w.classify('C:\\Users\\angus\\Downloads\\a.zip'), null);
  assert.equal(w.classify('C:\\Games'), null);
  assert.deepEqual(w.classify('E:\\Footage'), { kind: 'external', label: 'Drive (E:)', root: 'E:\\' });
  assert.deepEqual(w.classify('g:\\My Drive\\x'), { kind: 'cloud', label: 'Google Drive (G:)', root: 'G:\\' });
  assert.equal(w.classify('\\\\nas\\media\\x').kind, 'network');
});
test('blocked until added; opt-ins are saved', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-'));
  const file = path.join(dir, 'drives.json');
  const d = createDrives({ home: '/Users/angus', platform: 'darwin', file });
  const p = '/Users/angus/Library/CloudStorage/Dropbox/a.mov';
  assert.ok(d.blocked(p));
  assert.ok(d.add('/Users/angus/Library/CloudStorage/Dropbox'));
  assert.equal(d.blocked(p), null);
  assert.equal(createDrives({ home: '/Users/angus', platform: 'darwin', file }).blocked(p), null);
  d.remove('/Users/angus/Library/CloudStorage/Dropbox');
  assert.ok(d.blocked(p));
  assert.equal(d.add('/Users/angus/Movies'), false);
});
test('provider names', () => {
  assert.equal(providerName('OneDrive-Personal'), 'OneDrive (Personal)');
  assert.equal(providerName('Box-Box'), 'Box');
  assert.equal(providerName('Dropbox'), 'Dropbox');
});
test('scan leaves out cloud folders and lists them', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-home-'));
  const g = path.join(home, 'Library', 'CloudStorage', 'GoogleDrive-a@b.com');
  fs.mkdirSync(g, { recursive: true });
  fs.writeFileSync(path.join(g, 'big.mov'), Buffer.alloc(4096));
  fs.mkdirSync(path.join(home, 'Movies'));
  fs.writeFileSync(path.join(home, 'Movies', 'a.mov'), Buffer.alloc(1024));
  const d = createDrives({ home, platform: process.platform === 'win32' ? 'win32' : 'darwin' });
  const tree = await scan(home, { skip: (p) => d.blocked(p) });
  assert.equal(tree.size, 1024);
  assert.equal(tree.skipped.length, 1);
  assert.match(tree.skipped[0].label, /Google Drive/);
  d.add(g);
  assert.equal((await scan(home, { skip: (p) => d.blocked(p) })).size, 1024 + 4096);
});

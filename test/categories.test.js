const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan, TYPE_EXT, BUNDLE_TYPE } = require('../src/main/scanner');

const load = () => import('../src/renderer/categories.js');
const MB = 1024 ** 2;

function mkfile(p, size) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const fd = fs.openSync(p, 'w');
  if (size) fs.ftruncateSync(fd, size);
  fs.closeSync(fd);
}

test('scanner and renderer agree on file types', async () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/renderer/categories.js'), 'utf8');
  for (const [t, list] of Object.entries(TYPE_EXT)) assert.ok(src.includes(`${t}: '${list}'`), `type ${t} differs`);
  for (const [e, t] of Object.entries(BUNDLE_TYPE)) assert.ok(new RegExp(`${e}: '${t}'`).test(src), `bundle ${e} differs`);
});

test('random folders are grouped into main categories by content', async () => {
  const { categorize } = await load();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-cat-'));
  mkfile(path.join(home, 'Movies/a.mov'), 30 * MB);
  mkfile(path.join(home, 'Client Work/rushes.mov'), 25 * MB);
  mkfile(path.join(home, 'Client Work/brief.pdf'), 1 * MB);
  mkfile(path.join(home, 'old stuff/backup.zip'), 22 * MB);
  mkfile(path.join(home, 'beats/kick.wav'), 3 * MB); // small files still count by type
  mkfile(path.join(home, 'site/package.json'), 1000);
  mkfile(path.join(home, 'site/index.js'), 2000);
  mkfile(path.join(home, '.vscode/settings.db'), 5000);
  mkfile(path.join(home, 'Library/Caches/x/blob'), 4000);
  mkfile(path.join(home, 'Library/Application Support/MobileSync/Backup/1/f'), 6000);
  mkfile(path.join(home, 'Library/Application Support/Slack/data'), 7000);
  mkfile(path.join(home, 'Library/Mail/V10/msg'), 3000);
  mkfile(path.join(home, 'Dropbox/notes.bin'), 2000);
  mkfile(path.join(home, 'notes.txt'), 500);
  const tree = await scan(home);
  const city = categorize(tree);
  const where = Object.fromEntries(city.flatMap((c) => c.children.map((i) => [i.rel, c.category])));
  assert.strictEqual(where['Movies'], 'video');
  assert.strictEqual(where['Client Work'], 'video');
  assert.strictEqual(where['old stuff'], 'archives');
  assert.strictEqual(where['beats'], 'music');
  assert.strictEqual(where['site'], 'dev');
  assert.strictEqual(where['.vscode'], 'library');
  assert.strictEqual(where['Library/Caches'], 'cache');
  assert.strictEqual(where['Library/Application Support/MobileSync'], 'backups');
  assert.strictEqual(where['Library/Application Support/Slack'], 'library');
  assert.strictEqual(where['Library/Mail'], 'mail');
  assert.strictEqual(where['Dropbox'], 'cloud');
  // Category sizes add up to the scanned total: nothing lost, nothing counted twice.
  assert.strictEqual(city.reduce((s, c) => s + c.size, 0), tree.size);
  assert.ok(city.length <= 17);
});

test('demo tree without types is categorised too', async () => {
  const { categorize } = await load();
  const tree = { name: 'h', path: '/h', isDir: true, size: 30, children: [
    { name: 'stuff', path: '/h/stuff', isDir: true, size: 20, kind: 'other', children: [{ name: 'a.mp3', path: '/h/stuff/a.mp3', isDir: false, size: 20, kind: 'media' }] },
    { name: '4 small files', path: '/h', isDir: false, size: 10, kind: 'other', aggregate: true },
  ] };
  const city = categorize(tree);
  assert.deepStrictEqual(city.map((c) => [c.category, c.size]), [['music', 20], ['other', 10]]);
});

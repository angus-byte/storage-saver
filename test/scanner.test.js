const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan, classify, suggestions, isSafeCache } = require('../src/main/scanner');

function mk(dir, files) {
  for (const [rel, size] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(size));
  }
}

test('classify picks categories from path and extension', () => {
  assert.equal(classify('/Users/a/Library/Caches/foo', true), 'cache');
  assert.equal(classify('/Users/a/Downloads/x.dmg', false, 'x.dmg'), 'downloads');
  assert.equal(classify('/Users/a/Movies/a.braw', false, 'a.braw'), 'media');
  assert.equal(classify('C:\\Users\\a\\AppData\\Local\\Temp\\x', true), 'cache');
  assert.equal(classify('/Users/a/.Trash', true), 'trash');
  assert.equal(classify('/Users/a/code/x/node_modules', true), 'cache');
});

test('scan aggregates sizes and folds small files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-'));
  mk(dir, { 'big.mov': 3000, 'docs/a.txt': 10, 'docs/b.txt': 20, 'Caches/c.bin': 500 });
  const tree = await scan(dir, { keepFileMin: 1000 });
  assert.equal(tree.size, 3530);
  assert.equal(tree.files, 4);
  const names = tree.children.map((c) => c.name);
  assert.ok(names.includes('big.mov'));
  const docs = tree.children.find((c) => c.name === 'docs');
  assert.equal(docs.size, 30);
  assert.equal(docs.children.length, 1);
  assert.ok(docs.children[0].aggregate);
  assert.equal(tree.children[0].size, 3000); // sorted desc
  fs.rmSync(dir, { recursive: true });
});

test('suggestions find caches and old downloads', () => {
  const now = Date.now();
  const tree = {
    name: 'home', path: '/h', size: 0, isDir: true, kind: 'other', children: [
      { name: 'Caches', path: '/h/Library/Caches', size: 200e6, isDir: true, kind: 'cache', children: [
        { name: 'x', path: '/h/Library/Caches/x', size: 150e6, isDir: true, kind: 'cache', children: [] },
      ] },
      { name: 'old.dmg', path: '/h/Downloads/old.dmg', size: 5e6, isDir: false, kind: 'downloads', mtime: now - 100 * 86400000 },
      { name: 'new.dmg', path: '/h/Downloads/new.dmg', size: 5e6, isDir: false, kind: 'downloads', mtime: now - 2 * 86400000 },
    ],
  };
  const s = suggestions(tree, now);
  assert.equal(s.caches.items.length, 1); // nested cache not double-listed
  assert.equal(s.caches.total, 200e6);
  assert.deepEqual(s.oldDownloads.items.map((i) => i.name), ['old.dmg']);
});

test('Safe Clean only offers well-known cache folders, never a person\'s own Logs/Temp folder', () => {
  assert.ok(isSafeCache('/Users/a/Library/Caches/com.foo'));
  assert.ok(isSafeCache('/Users/a/Library/Containers/com.foo/Data/Library/Caches/x'));
  assert.ok(isSafeCache('C:\\Users\\a\\AppData\\Local\\Temp\\x'));
  assert.ok(!isSafeCache('/Users/a/Documents/Client Logs'));
  assert.ok(!isSafeCache('/Users/a/Movies/Temp'));
  assert.ok(!isSafeCache('/Users/a/Pictures/Cache'));
  const tree = {
    name: 'home', path: '/h', size: 0, isDir: true, kind: 'other', children: [
      { name: 'Caches', path: '/h/Library/Caches', size: 200e6, isDir: true, kind: 'cache', children: [] },
      { name: 'Logs', path: '/h/Documents/Client Logs', size: 900e6, isDir: true, kind: classify('/h/Documents/Client Logs', true), children: [] },
      { name: 'Temp', path: '/h/Movies/Temp', size: 900e6, isDir: true, kind: classify('/h/Movies/Temp', true), children: [] },
    ],
  };
  const s = suggestions(tree);
  assert.deepEqual(s.caches.items.map((i) => i.path), ['/h/Library/Caches']);
});

test('a delete updates the scan in place: folders shrink, Trash grows', () => {
  const { forget, clearDir, addToBin, findBin } = require('../src/main/scanner');
  const leaf = (p, size, t = 'video') => ({ name: p.split('/').pop(), path: p, size, isDir: false, files: 1, types: { [t]: size } });
  const tree = {
    path: '/h', isDir: true, size: 0, files: 0, types: {}, children: [
      { path: '/h/Movies', name: 'Movies', isDir: true, children: [leaf('/h/Movies/a.mov', 700), leaf('/h/Movies/b.mov', 300)] },
      { path: '/h/Cache', name: 'Cache', isDir: true, children: [leaf('/h/Cache/x', 50, 'other'), { name: '9 small files', path: '/h/Cache', size: 20, isDir: false, files: 9, aggregate: true, types: { other: 20 } }] },
      { path: '/h/.Trash', name: '.Trash', isDir: true, children: [leaf('/h/.Trash/old', 100, 'other')] },
    ],
  };
  // Fill in folder totals the way the scanner would.
  const sumUp = (n) => {
    if (!n.isDir) return n;
    n.size = 0; n.files = 0; n.types = {};
    for (const c of n.children.map(sumUp)) {
      n.size += c.size; n.files += c.files;
      for (const [k, v] of Object.entries(c.types)) n.types[k] = (n.types[k] || 0) + v;
    }
    return n;
  };
  sumUp(tree);
  assert.strictEqual(tree.size, 1170);
  assert.strictEqual(findBin(tree).path, '/h/.Trash');

  assert.strictEqual(forget(tree, '/h/Movies/a.mov'), 700);
  assert.strictEqual(tree.children[0].size, 300);
  assert.strictEqual(tree.types.video, 300);
  addToBin(tree, 700);
  assert.strictEqual(tree.size, 1170, 'still on disk, now in the Trash');
  assert.strictEqual(findBin(tree).size, 800);

  assert.strictEqual(clearDir(tree, '/h/Cache'), 70);
  assert.strictEqual(tree.children[1].size, 0);
  assert.deepStrictEqual(tree.children[1].children, []);
  assert.strictEqual(tree.size, 1100);

  assert.strictEqual(clearDir(tree, '/h/.Trash'), 800);
  assert.strictEqual(tree.size, 300);
  assert.strictEqual(forget(tree, '/h/not/scanned'), 0);
  assert.strictEqual(forget(tree, '/elsewhere'), 0);
});

test('oldDownloads lists old small files and folders in Downloads', async () => {
  const { oldDownloads } = require('../src/main/deepclean');
  const fsx = require('fs');
  const osx = require('os');
  const px = require('path');
  const home = fsx.mkdtempSync(px.join(osx.tmpdir(), 'dl-'));
  const dl = px.join(home, 'Downloads');
  fsx.mkdirSync(px.join(dl, 'old-folder'), { recursive: true });
  const big = Buffer.alloc(2 * 1024 * 1024);
  fsx.writeFileSync(px.join(dl, 'old.zip'), big);
  fsx.writeFileSync(px.join(dl, 'old-folder', 'a.bin'), big);
  fsx.writeFileSync(px.join(dl, 'new.pdf'), big);
  fsx.writeFileSync(px.join(dl, 'tiny.txt'), 'x');
  fsx.writeFileSync(px.join(dl, '.DS_Store'), big);
  const old = new Date(Date.now() - 90 * 86400000);
  for (const f of ['old.zip', 'old-folder/a.bin', 'old-folder', 'tiny.txt']) fsx.utimesSync(px.join(dl, f), old, old);
  const g = await oldDownloads(home);
  assert.deepStrictEqual(g.items.map((i) => i.name).sort(), ['old-folder', 'old.zip']);
  assert.strictEqual(g.total, 4 * 1024 * 1024);
  fsx.rmSync(home, { recursive: true, force: true });
});

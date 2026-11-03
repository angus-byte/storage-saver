const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scan, classify, suggestions } = require('../src/main/scanner');

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

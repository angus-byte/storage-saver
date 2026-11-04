const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ph = require('../src/main/photos');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ph-'));
const put = (file, buf) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
};
const bytes = (seed, n = 30 * 1024) => Buffer.from(Array.from({ length: n }, (_, i) => (i * seed + seed) & 255));

// 32x32 RGBA test pictures.
function picture(fn, w = 32, h = 32) {
  const b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(fn(x, y))));
      b.set([v, v, v, 255], (y * w + x) * 4);
    }
  return b;
}
const sunset = (x, y) => 128 + 90 * Math.sin(x / 3 + y / 5);
const sunsetBrighter = (x, y) => sunset(x, y) * 0.9 + 12 + ((x * 7 + y * 3) % 5);
const checker = (x, y) => (((x >> 2) + (y >> 2)) % 2 ? 230 : 20);

test('dhash: similar pictures are close, different ones are far, flat ones are skipped', () => {
  const a = ph.dhash(picture(sunset), 32, 32);
  const b = ph.dhash(picture(sunsetBrighter), 32, 32);
  const c = ph.dhash(picture(checker), 32, 32);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.ok(ph.hamming(a, b) <= ph.SIMILAR_MAX, `close: ${ph.hamming(a, b)}`);
  assert.ok(ph.hamming(a, c) > 16, `far: ${ph.hamming(a, c)}`);
  assert.strictEqual(ph.dhash(picture(() => 0), 32, 32), null);
  assert.strictEqual(ph.dhash(picture(() => 255), 32, 32), null);
  // Same picture at another size gives a near-identical hash.
  assert.ok(ph.hamming(a, ph.dhash(picture((x, y) => sunset(x / 2, y / 2), 64, 64), 64, 64)) <= 4);
});

test('hamming counts differing bits', () => {
  assert.strictEqual(ph.hamming('0000000000000000', '0000000000000000'), 0);
  assert.strictEqual(ph.hamming('ffffffffffffffff', '0000000000000000'), 64);
  assert.strictEqual(ph.hamming('0000000000000001', '0000000000000003'), 1);
});

test('similarGroups finds every pair within range and leaves strangers alone', () => {
  const items = [
    { path: 'a', hash: '0000000000000000' },
    { path: 'b', hash: '7f00000000000000' }, // 7 bits from a: same band elsewhere
    { path: 'c', hash: 'ffffffffffffffff' },
    { path: 'd', hash: 'fffffffffffffff0' },
    { path: 'e', hash: '0f0f0f0f0f0f0f0f' },
    { path: 'f', hash: null },
  ];
  const groups = ph.similarGroups(items).map((g) => g.map((i) => i.path).sort().join(''));
  assert.deepStrictEqual(groups.sort(), ['ab', 'cd']);
});

test('walkPhotos: only photos in your own folders, never cloud, Library, hidden or app libraries', async () => {
  const home = tmp();
  put(path.join(home, 'Pictures', 'a.jpg'), bytes(1));
  put(path.join(home, 'Desktop', 'b.HEIC'), bytes(2));
  put(path.join(home, 'Documents', 'notes.txt'), bytes(3));
  put(path.join(home, 'Pictures', 'tiny.png'), Buffer.alloc(100));
  put(path.join(home, 'Library', 'Caches', 'c.jpg'), bytes(4));
  put(path.join(home, 'Library', 'CloudStorage', 'GoogleDrive-me', 'd.jpg'), bytes(5));
  put(path.join(home, 'Google Drive', 'e.jpg'), bytes(6));
  put(path.join(home, 'OneDrive - Sommar Films', 'f.jpg'), bytes(7));
  put(path.join(home, 'Dropbox', 'g.jpg'), bytes(8));
  put(path.join(home, '.hidden', 'h.jpg'), bytes(9));
  put(path.join(home, 'Pictures', 'Photos Library.photoslibrary', 'originals', 'i.jpg'), bytes(10));
  put(path.join(home, 'AppData', 'Local', 'j.jpg'), bytes(11));
  const found = (await ph.walkPhotos(home)).map((f) => path.relative(home, f.path)).sort();
  assert.deepStrictEqual(found, [path.join('Desktop', 'b.HEIC'), path.join('Pictures', 'a.jpg')]);
});

test('findPhotos groups exact twins and lookalikes, suggests the best to keep', async () => {
  const home = tmp();
  const pics = path.join(home, 'Pictures');
  put(path.join(pics, 'beach.jpg'), bytes(1));
  put(path.join(home, 'Downloads', 'beach (1).jpg'), bytes(1));
  put(path.join(home, 'Desktop', 'beach copy.jpg'), bytes(1));
  put(path.join(pics, 'other.jpg'), bytes(2)); // same size, different bytes
  put(path.join(pics, 'sunset-small.jpg'), bytes(3, 25 * 1024));
  put(path.join(pics, 'sunset.jpg'), bytes(4, 40 * 1024));
  put(path.join(pics, 'checks.jpg'), bytes(5, 33 * 1024));
  const looks = { 'sunset.jpg': [(x, y) => sunset(x / 2, y / 2), 64], 'sunset-small.jpg': [sunsetBrighter, 32], 'checks.jpg': [checker, 32], 'other.jpg': [(x, y) => ((x * 13 + y * 29) % 17) * 15, 32], 'beach.jpg': [(x, y) => 128 + 100 * Math.cos((x * y) / 40 + x / 2), 32] };
  const sizes = { 'sunset.jpg': { width: 4000, height: 3000 }, 'sunset-small.jpg': { width: 1200, height: 900 } };
  const cache = new Map();
  let decoded = 0;
  const opts = {
    roots: [home],
    cache,
    decode: async (p) => {
      decoded++;
      const [fn, s] = looks[path.basename(p)] || [() => 0, 8];
      return { bitmap: picture(fn, s, s), w: s, h: s };
    },
    dims: async (p) => sizes[path.basename(p)] || null,
  };
  const res = await ph.findPhotos(opts);
  assert.strictEqual(res.photos, 7);

  assert.strictEqual(res.exact.length, 1);
  const twins = res.exact[0];
  assert.strictEqual(twins.items.length, 3);
  assert.strictEqual(twins.keep, path.join(pics, 'beach.jpg'));
  assert.strictEqual(twins.saving, 2 * 30 * 1024);

  assert.strictEqual(res.similar.length, 1);
  const alike = res.similar[0];
  assert.deepStrictEqual(alike.items.map((i) => i.name).sort(), ['sunset-small.jpg', 'sunset.jpg']);
  assert.strictEqual(alike.keep, path.join(pics, 'sunset.jpg'));
  assert.match(alike.why, /Highest resolution \(4000×3000\)/);
  // Only one of the three twins is hashed for lookalikes.
  assert.strictEqual(decoded, 5);

  // Second run reuses the cache.
  decoded = 0;
  await ph.findPhotos(opts);
  assert.strictEqual(decoded, 0);
});

test('planTrash keeps one photo from every group', () => {
  const result = {
    exact: [{ id: 'exact-0', kind: 'exact', keep: '/a', items: [{ path: '/a' }, { path: '/b' }, { path: '/c' }] }],
    similar: [{ id: 'similar-0', kind: 'similar', keep: '/x', items: [{ path: '/x' }, { path: '/y' }] }],
  };
  let r = ph.planTrash(result, ['/b', '/c']);
  assert.deepStrictEqual(r.ok, [{ path: '/b', keep: '/a', kind: 'exact' }, { path: '/c', keep: '/a', kind: 'exact' }]);
  // Trashing the suggested keeper is fine if another stays.
  r = ph.planTrash(result, ['/x']);
  assert.deepStrictEqual(r.ok, [{ path: '/x', keep: '/y', kind: 'similar' }]);
  r = ph.planTrash(result, ['/x', '/y', '/elsewhere']);
  assert.strictEqual(r.ok.length, 0);
  assert.strictEqual(r.refused.length, 3);
  assert.strictEqual(ph.planTrash(null, ['/a']).refused.length, 1);
});

test('parseHeaderSize reads PNG, GIF and JPEG sizes', () => {
  const png = Buffer.alloc(33);
  png.writeUInt32BE(0x89504e47, 0);
  png.writeUInt32BE(4032, 16);
  png.writeUInt32BE(3024, 20);
  assert.deepStrictEqual(ph.parseHeaderSize(png), { width: 4032, height: 3024 });
  const gif = Buffer.from('GIF89a\x40\x01\xf0\x00xxxxx', 'latin1');
  assert.deepStrictEqual(ph.parseHeaderSize(gif), { width: 320, height: 240 });
  // SOI, APP0 (len 16), SOF0 with 1200x800
  const app0 = [0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x20, 0x04, 0xb0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1];
  const jpg = Buffer.from([0xff, 0xd8, ...app0, ...sof, 0, 0, 0, 0]);
  assert.deepStrictEqual(ph.parseHeaderSize(jpg), { width: 1200, height: 800 });
  assert.strictEqual(ph.parseHeaderSize(Buffer.from('nope')), null);
});

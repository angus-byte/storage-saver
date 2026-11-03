const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createLicence } = require('../src/main/licence');
const { deepSuggestions, sweepOnly, isDeepPath, sameFile, findDuplicates, belongsToApp } = require('../src/main/deepclean');
const { scan } = require('../src/main/scanner');

const GB = 1024 ** 3;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gp-'));
const cfg = { freeCapBytes: 20 * GB, offlineGraceMs: 30 * 86400000, revalidateMs: 3 * 86400000, storeId: 1, productId: 2, priceLabel: '$19.99', checkoutUrl: 'x' };

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, opts) => {
    const endpoint = url.split('/').pop();
    const params = Object.fromEntries(new URLSearchParams(opts.body));
    calls.push({ endpoint, params });
    const body = handler(endpoint, params);
    if (body instanceof Error) throw body;
    return { ok: true, json: async () => body };
  };
  f.calls = calls;
  return f;
}
const good = (endpoint) =>
  endpoint === 'activate'
    ? { activated: true, instance: { id: 'inst-1' }, meta: { store_id: 1, product_id: 2, customer_email: 'a@b.c' } }
    : endpoint === 'validate'
      ? { valid: true, meta: { store_id: 1, product_id: 2 } }
      : { deactivated: true };

test('free plan caps total demolish at 20 GB and persists usage', () => {
  const dir = tmp();
  const lic = createLicence({ dir, cfg, fetchImpl: fakeFetch(good) });
  assert.equal(lic.status().plan, 'free');
  assert.equal(lic.checkAllowance(15 * GB), null);
  lic.recordDemolished(15 * GB);
  const blocked = lic.checkAllowance(6 * GB);
  assert.equal(blocked.error, 'cap');
  assert.equal(blocked.remainingBytes, 5 * GB);
  assert.equal(lic.checkAllowance(5 * GB), null);
  const again = createLicence({ dir, cfg });
  assert.equal(again.status().remainingBytes, 5 * GB);
});

test('activating a valid key unlocks Pro with no cap', async () => {
  const lic = createLicence({ dir: tmp(), cfg, fetchImpl: fakeFetch(good) });
  lic.recordDemolished(20 * GB);
  const r = await lic.activate(' KEY-123 ');
  assert.ok(r.ok);
  assert.equal(r.status.plan, 'pro');
  assert.equal(r.status.email, 'a@b.c');
  assert.equal(lic.checkAllowance(500 * GB), null);
});

test('keys for another product are refused and released', async () => {
  const f = fakeFetch((e) => (e === 'activate' ? { activated: true, instance: { id: 'i' }, meta: { store_id: 1, product_id: 99 } } : { deactivated: true }));
  const lic = createLicence({ dir: tmp(), cfg, fetchImpl: f });
  const r = await lic.activate('OTHER');
  assert.equal(r.ok, false);
  assert.equal(lic.status().plan, 'free');
  await new Promise((r) => setImmediate(r));
  assert.ok(f.calls.some((c) => c.endpoint === 'deactivate'));
});

test('offline keeps Pro within the grace period; a refunded key downgrades', async () => {
  let t = Date.now();
  let mode = 'good';
  const f = fakeFetch((e, p) => (mode === 'offline' ? new Error('offline') : mode === 'refunded' && e === 'validate' ? { valid: false, error: 'disabled' } : good(e, p)));
  const lic = createLicence({ dir: tmp(), cfg, fetchImpl: f, now: () => t });
  await lic.activate('K');
  mode = 'offline';
  t += 10 * 86400000;
  assert.equal((await lic.revalidate()).plan, 'pro');
  t += 25 * 86400000; // 35 days without a successful check
  assert.equal((await lic.revalidate()).plan, 'free');
  mode = 'refunded';
  const lic2 = createLicence({ dir: tmp(), cfg, fetchImpl: f, now: () => t });
  mode = 'good';
  await lic2.activate('K');
  mode = 'refunded';
  assert.equal((await lic2.revalidate(true)).plan, 'free');
});

test('Street Sweep leaves Deep Clean paths alone', () => {
  assert.ok(isDeepPath('/Users/a/code/x/node_modules'));
  assert.ok(isDeepPath('/Users/a/Movies/Doc.fcpbundle/Doc/Render Files'));
  assert.ok(!isDeepPath('/Users/a/Library/Caches/com.spotify.client'));
  const s = sweepOnly({ caches: { items: [{ path: '/u/Library/Caches/x', size: 5 }, { path: '/u/p/node_modules', size: 7 }], total: 12 } });
  assert.deepEqual(s.caches.items.map((i) => i.path), ['/u/Library/Caches/x']);
  assert.equal(s.caches.total, 5);
});

test('duplicates are found, oldest kept, and verified byte for byte', async () => {
  const dir = tmp();
  const a = Buffer.alloc(3 * 1024 * 1024, 7);
  fs.writeFileSync(path.join(dir, 'orig.mov'), a);
  fs.writeFileSync(path.join(dir, 'copy.mov'), a);
  const b = Buffer.from(a);
  b[1500000] = 1; // same size, differs outside the sampled blocks? still differs in full hash
  fs.writeFileSync(path.join(dir, 'other.mov'), b);
  const old = Date.now() / 1000 - 86400;
  fs.utimesSync(path.join(dir, 'orig.mov'), old, old);
  const tree = await scan(dir, { keepFileMin: 1024 });
  const dups = await findDuplicates(tree, 1024);
  const copy = dups.find((d) => d.name === 'copy.mov');
  assert.ok(copy);
  assert.equal(copy.keep, path.join(dir, 'orig.mov'));
  assert.ok(await sameFile(path.join(dir, 'copy.mov'), path.join(dir, 'orig.mov')));
  assert.ok(!(await sameFile(path.join(dir, 'other.mov'), path.join(dir, 'orig.mov'))));
});

test('deep clean finds render caches, dev junk, logs and leftovers', async () => {
  const home = tmp();
  const w = (rel, size) => {
    fs.mkdirSync(path.dirname(path.join(home, rel)), { recursive: true });
    fs.writeFileSync(path.join(home, rel), Buffer.alloc(size));
  };
  const MB = 1024 * 1024;
  w('Movies/Doc.fcpbundle/Doc/Render Files/r1.mov', 30 * MB);
  w('Library/Developer/Xcode/DerivedData/App/b.o', 25 * MB);
  w('Library/Logs/x.log', 11 * MB);
  w('Library/Application Support/OldApp/data.db', 25 * MB);
  w('Library/Application Support/Spotify/data.db', 25 * MB);
  const old = Date.now() / 1000 - 200 * 86400;
  for (const d of ['OldApp', 'Spotify']) fs.utimesSync(path.join(home, 'Library/Application Support', d), old, old);
  const tree = await scan(home, { keepFileMin: MB });
  const listApps = async () => ({ names: new Set(['spotify']), ids: new Set(['com.spotify.client']) });
  const deep = await deepSuggestions(tree, { home, platform: 'darwin', listApps });
  assert.equal(deep.renderCaches.items.length, 1);
  assert.ok(deep.devJunk.items.some((i) => i.name === 'Xcode DerivedData'));
  assert.ok(deep.logsInstallers.items.some((i) => i.name === 'App logs'));
  assert.deepEqual(deep.appLeftovers.items.map((i) => i.name), ['OldApp']);
});

test('app matching by name and bundle id', () => {
  const apps = { names: new Set(['google chrome', 'davinci resolve']), ids: new Set(['com.google.chrome']) };
  assert.ok(belongsToApp('Google', apps));
  assert.ok(belongsToApp('com.google.Chrome', apps));
  assert.ok(belongsToApp('DaVinci Resolve', apps));
  assert.ok(!belongsToApp('Avid', apps));
});

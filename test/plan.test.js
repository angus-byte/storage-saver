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

test('free allowance resets each calendar month and resists clock and file tricks', () => {
  const dir = tmp();
  let t = new Date(2026, 10, 20, 12).getTime(); // 20 Nov
  const lic = createLicence({ dir, cfg, now: () => t, machineId: () => 'm1' });
  lic.recordDemolished(18 * GB);
  assert.equal(lic.status().remainingBytes, 2 * GB);
  assert.equal(lic.status().resetsAt, new Date(2026, 11, 1).getTime());
  assert.equal(lic.checkAllowance(3 * GB).resetsAt, new Date(2026, 11, 1).getTime());
  t = new Date(2026, 11, 1, 0, 5).getTime(); // 1 Dec: fresh 20 GB
  assert.equal(lic.status().remainingBytes, 20 * GB);
  lic.recordDemolished(20 * GB);
  t = new Date(2026, 10, 25).getTime(); // clock wound back to November
  assert.equal(lic.status().remainingBytes, 0);
  assert.equal(createLicence({ dir, cfg, now: () => t, machineId: () => 'm1' }).status().remainingBytes, 0);
  // Hand-editing the usage breaks the signature: month counts as used up.
  t = new Date(2026, 11, 10).getTime();
  const f = path.join(dir, 'gigapolis-plan.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.allowance.used = 0;
  fs.writeFileSync(f, JSON.stringify(j));
  const edited = createLicence({ dir, cfg, now: () => t, machineId: () => 'm1' });
  assert.equal(edited.status().remainingBytes, 0);
  t = new Date(2027, 0, 1, 9).getTime();
  assert.equal(edited.status().remainingBytes, 20 * GB);
});

test('old lifetime counter carries into the current month', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'gigapolis-plan.json'), JSON.stringify({ demolishedBytes: 12 * GB }));
  let t = new Date(2026, 10, 4).getTime();
  const lic = createLicence({ dir, cfg, now: () => t });
  assert.equal(lic.status().remainingBytes, 8 * GB);
  t = new Date(2026, 11, 2).getTime();
  assert.equal(lic.status().remainingBytes, 20 * GB);
});

test('free plan caps demolish at 20 GB a month and persists usage', () => {
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
  for (const d of ['OldApp', 'Spotify']) for (const f of ['', 'data.db']) fs.utimesSync(path.join(home, 'Library/Application Support', d, f), old, old);
  const tree = await scan(home, { keepFileMin: MB });
  const listApps = async () => ({ names: new Set(['spotify']), ids: new Set(['com.spotify.client']) });
  const deep = await deepSuggestions(tree, { home, platform: 'darwin', listApps });
  assert.equal(deep.renderCaches.items.length, 1);
  assert.ok(deep.devJunk.items.some((i) => i.name === 'Xcode DerivedData'));
  assert.ok(deep.logsInstallers.items.some((i) => i.name === 'App logs'));
  assert.deepEqual(deep.appLeftovers.items.map((i) => i.name), ['OldApp']);
});

test('a support folder with recent files inside is in use, not a leftover', async () => {
  const home = tmp();
  const MB = 1024 * 1024;
  const dir = path.join(home, 'Library/Application Support/BusyApp');
  fs.mkdirSync(path.join(dir, 'deep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'deep', 'today.db'), Buffer.alloc(25 * MB));
  const old = Date.now() / 1000 - 200 * 86400;
  fs.utimesSync(dir, old, old); // the folder itself looks untouched
  const tree = await scan(home, { keepFileMin: MB });
  const deep = await deepSuggestions(tree, { home, platform: 'darwin', listApps: async () => ({ names: new Set(['other']), ids: new Set() }) });
  assert.equal(deep.appLeftovers.items.length, 0);
});

test('installed apps are found one folder down (Adobe, Setapp style)', async () => {
  const { appBundles } = require('../src/main/deepclean');
  const root = tmp();
  fs.mkdirSync(path.join(root, 'Top.app'));
  fs.mkdirSync(path.join(root, 'Adobe Photoshop 2025', 'Adobe Photoshop 2025.app'), { recursive: true });
  fs.mkdirSync(path.join(root, '.hidden', 'Nope.app'), { recursive: true });
  const found = (await appBundles(root)).map(([, n]) => n).sort();
  assert.deepEqual(found, ['Adobe Photoshop 2025.app', 'Top.app']);
});

test('app matching by name and bundle id', () => {
  const apps = { names: new Set(['google chrome', 'davinci resolve']), ids: new Set(['com.google.chrome']) };
  assert.ok(belongsToApp('Google', apps));
  assert.ok(belongsToApp('com.google.Chrome', apps));
  assert.ok(belongsToApp('DaVinci Resolve', apps));
  assert.ok(!belongsToApp('Avid', apps));
});

test('owner key unlocks Pro offline; only its hash is configured', async () => {
  const crypto = require('crypto');
  const salt = 'testsalt';
  const hash = crypto.scryptSync('GIGA-TEST-OWNR-KEY1-2345-6789', salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  const dir = tmp();
  const f = fakeFetch(() => new Error('should not call the network'));
  const lic = createLicence({ dir, cfg: { ...cfg, ownerKey: { salt, hash } }, fetchImpl: f });
  assert.equal((await lic.activate('wrong-key')).ok, false);
  const r = await lic.activate(' giga-test-ownr-key1-2345-6789 ');
  assert.ok(r.ok);
  assert.equal(r.status.plan, 'pro');
  assert.equal(r.status.keyHint, 'Owner key');
  assert.ok(!f.calls.some((c) => c.endpoint === 'activate' && c.params.license_key.includes('TEST')));
  // Survives a restart, far beyond the offline grace period.
  const later = createLicence({ dir, cfg: { ...cfg, ownerKey: { salt, hash } }, now: () => Date.now() + 400 * 86400000 });
  assert.equal(later.status().plan, 'pro');
  // A hand-edited plan file claiming owner without the right key stays free.
  const p = path.join(dir, 'gigapolis-plan.json');
  const d = JSON.parse(fs.readFileSync(p, 'utf8'));
  d.licence.key = 'GIGA-FAKE';
  fs.writeFileSync(p, JSON.stringify(d));
  assert.equal(createLicence({ dir, cfg: { ...cfg, ownerKey: { salt, hash } } }).status().plan, 'free');
});

test('the real owner key is not in the repo', () => {
  const real = require('../src/main/config').ownerKey;
  assert.ok(real && /^[0-9a-f]{64}$/.test(real.hash));
});

test('owner key accepts sloppy typing and smart dashes', async () => {
  const crypto = require('crypto');
  const salt = 's2';
  const hash = crypto.scryptSync('GIGA-ABCD-EFGH-JKLM-NPQR-STUV', salt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString('hex');
  for (const typed of ['giga abcd efgh jklm npqr stuv', 'GIGA–ABCD–EFGH–JKLM–NPQR–STUV', 'ABCDEFGHJKLMNPQRSTUV', ' `GIGA-ABCD-EFGH-JKLM-NPQR-STUV` ']) {
    const lic = createLicence({ dir: tmp(), cfg: { ...cfg, ownerKey: { salt, hash } }, fetchImpl: fakeFetch(() => new Error('x')) });
    assert.ok((await lic.activate(typed)).ok, typed);
  }
});

test('Deep Clean on Windows: iPhone backups, crash dumps, Outlook, dev caches', async () => {
  const home = tmp();
  const put = (rel, size) => {
    const p = path.join(home, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '');
    fs.truncateSync(p, size);
  };
  const MB = 1024 ** 2;
  put('AppData/Roaming/Apple Computer/MobileSync/Backup/0001/data', 30 * MB);
  fs.writeFileSync(path.join(home, 'AppData/Roaming/Apple Computer/MobileSync/Backup/0001/Info.plist'),
    '<?xml version="1.0"?><plist><dict><key>Device Name</key><string>Angus&amp;s iPhone</string><key>Last Backup Date</key><date>2024-01-02T03:04:05Z</date></dict></plist>');
  put('AppData/Local/CrashDumps/app.dmp', 12 * MB);
  put('AppData/Local/Microsoft/Windows/INetCache/Content.Outlook/AB12/report.pdf', 6 * MB);
  put('AppData/Local/npm-cache/_cacache/blob', 25 * MB);
  const tree = await scan(home, {});
  const deep = await deepSuggestions(tree, { home, platform: 'win32' });
  assert.strictEqual(deep.iosBackups.items[0].name, 'Angus&s iPhone backup');
  assert.deepStrictEqual(deep.logsInstallers.items.map((i) => i.name), ['Crash dumps']);
  assert.deepStrictEqual(deep.mailAttachments.items.map((i) => i.name), ['Outlook attachments']);
  assert.deepStrictEqual(deep.devJunk.items.map((i) => i.name), ['npm cache']);
  assert.strictEqual(deep.appLeftovers.items.length, 0);
  assert.ok(isDeepPath(path.join(home, 'AppData/Local/CrashDumps/app.dmp')));
});

test('a licence copied to another computer does not unlock Pro there', async () => {
  const dir = tmp();
  const a = createLicence({ dir, cfg, fetchImpl: fakeFetch(good), machineId: () => 'mac-a' });
  await a.activate('KEY-1');
  assert.equal(a.status().plan, 'pro');
  const f = fakeFetch(good);
  const b = createLicence({ dir, cfg, fetchImpl: f, machineId: () => 'mac-b' });
  assert.equal(b.status().plan, 'free');
  assert.equal(b.status().licenceProblem, 'other-computer');
  await b.revalidate(true);
  assert.equal(f.calls.length, 0);
  // Releasing it there must not free the seat the first computer is using.
  await b.deactivate();
  assert.equal(f.calls.length, 0);
});

test('licences saved before machine binding are adopted by this computer', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'gigapolis-plan.json'), JSON.stringify({ licence: { key: 'K', instanceId: 'i', status: 'active', validatedAt: Date.now() } }));
  const lic = createLicence({ dir, cfg, machineId: () => 'mac-a' });
  assert.equal(lic.status().plan, 'pro');
  assert.equal(createLicence({ dir, cfg, machineId: () => 'mac-b' }).status().plan, 'free');
});

test('activation limit reached gives a clear message; seats are shown', async () => {
  const full = fakeFetch(() => ({ activated: false, error: 'This license key has reached the activation limit.' }));
  const r = await createLicence({ dir: tmp(), cfg, fetchImpl: full }).activate('KEY');
  assert.equal(r.ok, false);
  assert.match(r.error, /most computers allowed/);
  const f = fakeFetch((e) => (e === 'activate' ? { ...good(e), license_key: { status: 'active', activation_limit: 3, activation_usage: 2 } } : good(e)));
  const ok = await createLicence({ dir: tmp(), cfg, fetchImpl: f }).activate('KEY');
  assert.deepEqual(ok.status.activations, { used: 2, limit: 3 });
});

test('refunded (disabled) key locks Pro at the next check', async () => {
  let refunded = false;
  let t = 1e12;
  const f = fakeFetch((e) => (e === 'validate' && refunded ? { valid: false, error: 'license_key is disabled', license_key: { status: 'disabled' }, meta: { store_id: 1, product_id: 2 } } : good(e)));
  const lic = createLicence({ dir: tmp(), cfg, fetchImpl: f, now: () => t });
  await lic.activate('KEY');
  refunded = true;
  t += cfg.revalidateMs + 1;
  await lic.revalidate();
  assert.equal(lic.status().plan, 'free');
  assert.equal(lic.status().licenceProblem, 'invalid');
});

test('a validatedAt date in the future (hand-edited file) is not trusted', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'gigapolis-plan.json'), JSON.stringify({ licence: { key: 'K', instanceId: 'i', machine: 'unknown', status: 'active', validatedAt: Date.now() + 365 * 86400000 } }));
  assert.equal(createLicence({ dir, cfg }).status().plan, 'free');
});

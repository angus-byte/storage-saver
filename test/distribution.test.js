const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { capabilities, filterMaintenance, IAP_PRODUCT_ID } = require('../src/main/distribution');
const { macTasks, createMaintenance } = require('../src/main/maintenance');
const { createLicence } = require('../src/main/licence');

const cfg = { freeCapBytes: 20 * 1024 ** 3, offlineGraceMs: 86400000, revalidateMs: 86400000, priceLabel: '$19.99', checkoutUrl: 'x' };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gp-mas-'));

test('direct build keeps every feature', () => {
  const c = capabilities({ mas: false, platform: 'darwin' });
  assert.equal(c.channel, 'direct');
  assert.ok(c.autoUpdate && c.externalCheckout && c.licenceKeys && c.adminJobs && c.systemSpace && c.uninstaller && c.quitApps && c.fullDiskAccessPrompt);
  assert.equal(c.inAppPurchase, false);
});

test('App Store build turns off what the sandbox and store rules forbid', () => {
  const c = capabilities({ mas: true, platform: 'darwin' });
  assert.equal(c.channel, 'mas');
  assert.ok(c.inAppPurchase && c.folderBookmarks);
  for (const k of ['autoUpdate', 'externalCheckout', 'licenceKeys', 'adminJobs', 'systemSpace', 'uninstaller', 'quitApps', 'fullDiskAccessPrompt']) assert.equal(c[k], false, k);
  // Still there: the city, Safe Clean, Deep Clean, Photo Studio, browser privacy.
  assert.ok(c.deepClean && c.photos && c.browserData);
  assert.match(IAP_PRODUCT_ID, /^com\.sommarfilms\.storagesaver\./);
});

test('App Store maintenance list has no administrator or system-volume jobs', () => {
  const all = macTasks({ exists: () => true });
  const lite = filterMaintenance(all, capabilities({ mas: true }));
  assert.ok(lite.length > 0 && lite.length < all.length);
  for (const t of lite) {
    assert.equal(!!t.admin, false, t.id);
    assert.ok(!['snapshots', 'firstaid'].includes(t.id), t.id);
  }
  assert.deepEqual(filterMaintenance(all, capabilities({ mas: false })), all);
  const m = createMaintenance({ platform: 'darwin', filter: (ts) => filterMaintenance(ts, capabilities({ mas: true })) });
  assert.ok(m.list().tasks.every((t) => !t.admin));
});

test('an App Store purchase unlocks Pro and survives a restart on the same Mac', () => {
  const dir = tmp();
  const a = createLicence({ dir, cfg, machineId: () => 'mac-1' });
  assert.equal(a.isPro(), false);
  const st = a.setStorePurchase({ productId: IAP_PRODUCT_ID, transactionId: 't1', date: '2026-11-15' });
  assert.equal(st.plan, 'pro');
  assert.equal(st.storePurchase, true);
  assert.equal(st.keyHint, 'App Store');
  assert.equal(st.licenceProblem, null);
  const b = createLicence({ dir, cfg, machineId: () => 'mac-1' });
  assert.equal(b.isPro(), true);
  assert.equal(b.checkAllowance(100 * 1024 ** 3), null);
  // Copying the plan file to another Mac doesn't carry the purchase (Restore does).
  const c = createLicence({ dir, cfg, machineId: () => 'mac-2' });
  assert.equal(c.isPro(), false);
});

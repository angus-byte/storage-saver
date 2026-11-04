const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSettings, lowSpaceCheck, DEFAULTS } = require('../src/main/settings');

const GB = 1024 ** 3;

test('settings default, persist and ignore unknown keys', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gp-settings-'));
  const s = createSettings({ dir });
  assert.deepStrictEqual(s.get(), DEFAULTS);
  s.set({ keepInTray: false, launchAtLogin: true, bogus: 1 });
  const again = createSettings({ dir }).get();
  assert.strictEqual(again.keepInTray, false);
  assert.strictEqual(again.launchAtLogin, true);
  assert.ok(!('bogus' in again));
});

test('low-space alert fires once, re-arms after recovering', () => {
  let r = lowSpaceCheck(true, 20 * GB, 10);
  assert.deepStrictEqual(r, { notify: false, armed: true });
  r = lowSpaceCheck(r.armed, 8 * GB, 10);
  assert.deepStrictEqual(r, { notify: true, armed: false });
  r = lowSpaceCheck(r.armed, 7 * GB, 10);
  assert.strictEqual(r.notify, false);
  r = lowSpaceCheck(r.armed, 10.5 * GB, 10);
  assert.strictEqual(r.armed, false); // still within the 1 GB buffer
  r = lowSpaceCheck(r.armed, 12 * GB, 10);
  assert.strictEqual(r.armed, true);
  assert.strictEqual(lowSpaceCheck(true, 0, 10).notify, false); // unknown disk
});

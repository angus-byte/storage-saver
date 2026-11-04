const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { appFiles, matchesApp, watchFlags, freeToRemove, friendlyName, listStartup } = require('../src/main/cityhall');
const { mailAttachments } = require('../src/main/deepclean');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'gp-ch-'));
const put = (file, bytes = 10) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes));
};

test('matchesApp is strict: bundle id, id-prefixed, exact name only', () => {
  const app = { name: 'Slack', bundleId: 'com.tinyspeck.slackmacgap' };
  assert.ok(matchesApp('com.tinyspeck.slackmacgap', ['id'], app));
  assert.ok(matchesApp('com.tinyspeck.slackmacgap.plist', ['id'], app));
  assert.ok(matchesApp('com.tinyspeck.slackmacgap.savedState', ['id'], app));
  assert.ok(matchesApp('Slack', ['id', 'name'], app));
  assert.ok(matchesApp('T1234.com.tinyspeck.slackmacgap', ['group'], app));
  assert.ok(!matchesApp('Slack Helper', ['name'], app));
  assert.ok(!matchesApp('com.tinyspeck.slackmacgapX', ['id'], app));
  assert.ok(!matchesApp('Slack', ['id'], app));
  // Short names never match by name alone.
  assert.ok(!matchesApp('Go', ['name'], { name: 'Go', bundleId: 'x.y' }));
});

test('appFiles finds an app’s boxes in ~/Library and nothing else', async () => {
  const home = tmp();
  const L = (p) => path.join(home, 'Library', p);
  put(L('Application Support/Zoom/data.db'), 1000);
  put(L('Caches/us.zoom.xos/c'), 500);
  put(L('Preferences/us.zoom.xos.plist'), 20);
  put(L('Saved Application State/us.zoom.xos.savedState/x'), 5);
  put(L('Containers/us.zoom.xos/Data/a'), 50);
  put(L('Application Support/Zoomer/keep'), 999); // different app, similar name
  put(L('Caches/com.other/keep'), 999);
  const files = await appFiles({ name: 'Zoom', bundleId: 'us.zoom.xos' }, home);
  const names = files.map((f) => f.name).sort();
  assert.deepStrictEqual(names, ['Application Support › Zoom', 'Caches › us.zoom.xos', 'Containers › us.zoom.xos', 'Preferences › us.zoom.xos.plist', 'Saved Application State › us.zoom.xos.savedState']);
  assert.strictEqual(files[0].size, 1000);
  // Apple apps are never touched.
  assert.deepStrictEqual(await appFiles({ name: 'Safari', bundleId: 'com.apple.Safari' }, home), []);
});

test('Neighbourhood Watch flags', () => {
  assert.deepStrictEqual(watchFlags({ file: '/u/LaunchAgents/com.a.plist', label: 'com.a', program: '/Applications/A.app/a', programExists: true, signed: true }), []);
  assert.deepStrictEqual(watchFlags({ file: '/u/LaunchAgents/com.a.plist', label: 'com.a', program: '/Applications/Gone.app/a', programExists: false, signed: null }), ['ghost']);
  assert.ok(watchFlags({ file: '/u/x.plist', label: 'com.pirrit.agent', program: '/a', programExists: true, signed: true }).includes('adware'));
  assert.ok(watchFlags({ file: '/u/.hidden.plist', label: 'x', program: '/a', programExists: true, signed: true }).includes('hidden'));
  assert.ok(watchFlags({ file: '/u/x.plist', label: 'x', program: '/tmp/run', programExists: true, signed: true }).includes('hidden'));
  assert.ok(watchFlags({ file: '/u/x.plist', label: 'x', program: '/Users/me/Library/Application Support/.mgx/mgx', programExists: true, signed: true }).includes('hidden'));
  assert.deepStrictEqual(watchFlags({ file: '/u/x.plist', label: 'x', program: '/opt/x', programExists: true, signed: false }), ['unsigned']);
  assert.ok(freeToRemove(['ghost']));
  assert.ok(!freeToRemove(['unsigned']));
  assert.ok(!freeToRemove([]));
});

test('friendlyName', () => {
  assert.strictEqual(friendlyName('com.google.keystone.agent'), 'Google Keystone Agent');
  assert.strictEqual(friendlyName('us.zoom.updater'), 'Us Zoom Updater');
});

test('listStartup reads plists and ranks flagged first (macOS only: needs plutil)', { skip: process.platform !== 'darwin' }, async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'com.ok.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>com.ok</string><key>Program</key><string>/bin/ls</string></dict></plist>');
  fs.writeFileSync(path.join(dir, 'com.gone.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>Label</key><string>com.gone</string><key>ProgramArguments</key><array><string>/nope/gone</string></array></dict></plist>');
  const items = await listStartup('/x', { dirs: [[dir, 'you']], check: async () => true, loaded: new Map() });
  assert.deepStrictEqual(items.map((i) => i.label), ['com.gone', 'com.ok']);
  assert.ok(items[0].freeToRemove);
});

test('mailAttachments finds Mail Downloads', async () => {
  const home = tmp();
  put(path.join(home, 'Library/Containers/com.apple.mail/Data/Library/Mail Downloads/abc/file.pdf'), 6 * 1024 * 1024);
  const out = await mailAttachments(home, 'darwin');
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].mode, 'empty');
});

const test = require('node:test');
const assert = require('node:assert');
const { createProtection, friendlyError } = require('../src/main/protect');

const home = '/Users/angus';
const p = createProtection(home, 'darwin');

test('top-level user and system folders are protected', () => {
  for (const f of ['/Users/angus', '/Users/angus/Pictures', '/Users/angus/pictures/', '/Users/angus/Library', '/Applications', '/', '/Users', '/System', '/Users/angus/Library/Caches'])
    assert.ok(p.isProtected(f), f);
});
test('Pictures contents can be cleared, home and Library cannot', () => {
  assert.equal(p.check('/Users/angus/Pictures').contents, true);
  assert.equal(p.check('/Users/angus/Library').contents, false);
  assert.equal(p.check('/Users/angus').contents, false);
});
test('things inside protected folders are fine', () => {
  for (const f of ['/Users/angus/Pictures/Photos Library.photoslibrary', '/Users/angus/Downloads/big.dmg', '/Applications/Old.app', '/Users/angus/Library/Caches/com.foo'])
    assert.ok(!p.isProtected(f), f);
});
test('permission errors get a Full Disk Access hint', () => {
  const r = friendlyError(new Error('“Pictures” couldn’t be moved to the Bin because you don’t have permission to it'), '/Users/angus/Pictures');
  assert.ok(r.perm);
  assert.match(r.error, /Full Disk Access/);
});

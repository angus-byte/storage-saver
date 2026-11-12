const test = require('node:test');
const assert = require('node:assert');
const { createProtection, friendlyError } = require('../src/main/protect');

const home = '/Users/angus';
const p = createProtection(home, 'darwin');

test('top-level user and system folders are protected', () => {
  for (const f of ['/Users/angus', '/Users/angus/Pictures', '/Users/angus/pictures/', '/Users/angus/Library', '/Applications', '/', '/Users', '/System', '/Users/angus/Library/Caches', '/Users/Shared'])
    assert.ok(p.isProtected(f), f);
});
test('Pictures contents can be cleared, home and Library cannot', () => {
  assert.equal(p.check('/Users/angus/Pictures').contents, true);
  assert.equal(p.check('/Users/angus/Library').contents, false);
  assert.equal(p.check('/Users/angus').contents, false);
});
test('things inside protected folders are fine', () => {
  for (const f of ['/Users/angus/Pictures/Photos Library.photoslibrary', '/Users/angus/Downloads/big.dmg', '/Applications/Old.app', '/Users/angus/Library/Caches/com.foo', '/Users/Shared/Old Projects'])
    assert.ok(!p.isProtected(f), f);
});
test('permission errors get a Full Disk Access hint', () => {
  const r = friendlyError(new Error('“Pictures” couldn’t be moved to the Bin because you don’t have permission to it'), '/Users/angus/Pictures', 'darwin');
  assert.ok(r.perm);
  assert.match(r.error, /Full Disk Access/);
});

const w = createProtection('C:\\Users\\angus', 'win32');
test('Windows: home, AppData and system folders are protected', () => {
  for (const f of ['C:\\', 'c:\\windows', 'C:\\Program Files', 'C:\\Users', 'C:\\Users\\angus', 'C:\\Users\\angus\\Pictures\\', 'C:\\Users\\angus\\AppData', 'C:\\Users\\angus\\AppData\\Local', 'C:\\Users\\angus\\AppData\\Roaming', 'C:\\Users\\angus\\OneDrive'])
    assert.ok(w.isProtected(f), f);
  assert.equal(w.check('C:\\Users\\angus\\Downloads').contents, true);
  assert.equal(w.check('C:\\Users\\angus\\AppData\\Local\\Temp').contents, true);
  assert.equal(w.check('C:\\Users\\angus\\AppData').contents, false);
});
test('Windows: things inside are fine', () => {
  for (const f of ['C:\\Users\\angus\\Downloads\\setup.exe', 'C:\\Users\\angus\\AppData\\Local\\Temp\\x', 'C:\\Users\\angus\\AppData\\Local\\SomeApp\\Cache', 'D:\\Footage'])
    assert.ok(!w.isProtected(f), f);
});
test('Windows permission errors mention File Explorer', () => {
  const r = friendlyError(new Error('EPERM: operation not permitted'), 'C:\\Users\\angus\\x.bin', 'win32');
  assert.ok(r.perm);
  assert.match(r.error, /Windows.*x\.bin.*File Explorer/);
});

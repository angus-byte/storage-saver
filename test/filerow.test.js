const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../src/renderer/categories.js');

test('folder with a picked child collapses on first click', async () => {
  const { fileRowClick } = await load();
  // Child was picked, so the open folder lost its pick: clicking it must close it.
  assert.deepStrictEqual(fileRowClick({ open: true, picked: false, canOpen: true }, 'row'), { open: false, picked: false });
  assert.deepStrictEqual(fileRowClick({ open: true, picked: false, canOpen: true }, 'chev'), { open: false, picked: false });
});

test('arrow toggles open without touching the pick; row opens and picks', async () => {
  const { fileRowClick } = await load();
  assert.deepStrictEqual(fileRowClick({ open: false, picked: false, canOpen: true }, 'chev'), { open: true, picked: false });
  assert.deepStrictEqual(fileRowClick({ open: true, picked: true, canOpen: true }, 'chev'), { open: false, picked: false });
  assert.deepStrictEqual(fileRowClick({ open: false, picked: false, canOpen: true }, 'row'), { open: true, picked: true });
  assert.deepStrictEqual(fileRowClick({ open: true, picked: true, canOpen: true }, 'row'), { open: false, picked: false });
});

test('files just toggle their pick', async () => {
  const { fileRowClick } = await load();
  assert.deepStrictEqual(fileRowClick({ open: false, picked: false, canOpen: false }, 'row'), { open: false, picked: true });
  assert.deepStrictEqual(fileRowClick({ open: false, picked: true, canOpen: false }, 'row'), { open: false, picked: false });
});

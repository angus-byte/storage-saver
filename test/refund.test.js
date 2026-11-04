const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '../functions/api/refund.js')).href);
const NOW = Date.parse('2026-11-20T00:00:00Z');
const env = { LEMONSQUEEZY_API_KEY: 'k' };

function fakeLS({ email = 'a@b.com', product = 1496849, store = 513897, created = '2026-11-10T00:00:00Z', status = 'paid', refundOk = true } = {}) {
  const calls = [];
  const json = (body, ok = true) => ({ ok, json: async () => body });
  const f = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    if (url.endsWith('/licenses/validate')) return json({ valid: true, license_key: { id: 7 }, meta: { store_id: store, product_id: product, order_id: 42, customer_email: email } });
    if (url.endsWith('/orders/42')) return json({ data: { attributes: { status, refunded: status === 'refunded', created_at: created, total: 1999 } } });
    if (url.endsWith('/orders/42/refund')) return json({}, refundOk);
    if (url.endsWith('/license-keys/7')) return json({});
    throw new Error('unexpected ' + url);
  };
  return { f, calls };
}

test('refunds a recent matching order and disables the key', async () => {
  const { handleRefund } = await load();
  const { f, calls } = fakeLS();
  const r = await handleRefund({ email: ' A@B.com ', key: 'KEY' }, env, f, NOW);
  assert.deepStrictEqual(r, { status: 200, body: { ok: true } });
  const refund = calls.find((c) => c.url.endsWith('/refund'));
  assert.strictEqual(JSON.parse(refund.body).data.attributes.amount, 1999);
  assert.ok(calls.some((c) => c.method === 'PATCH'));
});

test('rejects wrong email, wrong product, old orders, missing input', async () => {
  const { handleRefund } = await load();
  assert.strictEqual((await handleRefund({ email: 'x@y.com', key: 'K' }, env, fakeLS().f, NOW)).status, 404);
  assert.strictEqual((await handleRefund({ email: 'a@b.com', key: 'K' }, env, fakeLS({ product: 1 }).f, NOW)).status, 404);
  const old = fakeLS({ created: '2026-10-01T00:00:00Z' });
  assert.strictEqual((await handleRefund({ email: 'a@b.com', key: 'K' }, env, old.f, NOW)).status, 403);
  assert.ok(!old.calls.some((c) => c.url.endsWith('/refund')));
  assert.strictEqual((await handleRefund({ email: '', key: '' }, env, fakeLS().f, NOW)).status, 400);
  assert.strictEqual((await handleRefund({ email: 'a@b.com', key: 'K' }, {}, fakeLS().f, NOW)).status, 500);
});

test('already refunded is a no-op success; failed refund reports an error', async () => {
  const { handleRefund } = await load();
  const done = fakeLS({ status: 'refunded' });
  assert.deepStrictEqual((await handleRefund({ email: 'a@b.com', key: 'K' }, env, done.f, NOW)).body, { ok: true, already: true });
  assert.ok(!done.calls.some((c) => c.url.endsWith('/refund')));
  assert.strictEqual((await handleRefund({ email: 'a@b.com', key: 'K' }, env, fakeLS({ refundOk: false }).f, NOW)).status, 502);
});

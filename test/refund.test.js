const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');
const { d1 } = require('./d1');

const fn = (f) => import(pathToFileURL(path.join(__dirname, '../functions', f)).href);
const NOW = Date.parse('2026-11-20T00:00:00Z');
const KEY = 'GP-AAAAA-BBBBB-CCCCC-DDDDD';

async function setup({ created = '2026-11-10T00:00:00Z', refundOk = true, already = false } = {}) {
  const { issueFromSession } = await fn('_lib/licences.js');
  const db = d1();
  const env = { STRIPE_SECRET_KEY: 'sk_test', LICENCE_DB: db };
  await issueFromSession(db, env, { id: 'cs_test_1', payment_status: 'paid', payment_intent: 'pi_1', amount_total: 1999, currency: 'usd', created: Date.parse(created) / 1000, livemode: false, customer_details: { email: 'A@b.com' }, metadata: { licence_key: KEY } });
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body });
    if (url.endsWith('/v1/refunds')) {
      if (already) return { ok: false, json: async () => ({ error: { code: 'charge_already_refunded' } }) };
      return { ok: refundOk, json: async () => ({}) };
    }
    throw new Error('unexpected ' + url);
  };
  return { db, env, f, calls };
}

test('refunds a recent matching order and disables the key', async () => {
  const { handleRefund } = await fn('api/refund.js');
  const { db, env, f, calls } = await setup();
  const r = await handleRefund({ email: ' a@B.com ', key: 'gp aaaaa bbbbb ccccc ddddd' }, env, f, NOW);
  assert.deepStrictEqual(r, { status: 200, body: { ok: true } });
  assert.match(calls[0].body, /payment_intent=pi_1/);
  const row = await db.prepare('SELECT * FROM licences WHERE key = ?').bind(KEY).first();
  assert.equal(row.status, 'disabled');
  assert.equal(row.refunded_at, NOW);
  // A second request is a no-op success.
  assert.deepStrictEqual((await handleRefund({ email: 'a@b.com', key: KEY }, env, f, NOW)).body, { ok: true, already: true });
  assert.equal(calls.length, 1);
});

test('rejects wrong email, unknown key, old orders, missing input', async () => {
  const { handleRefund } = await fn('api/refund.js');
  const s = await setup();
  assert.strictEqual((await handleRefund({ email: 'x@y.com', key: KEY }, s.env, s.f, NOW)).status, 404);
  assert.strictEqual((await handleRefund({ email: 'a@b.com', key: 'GP-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ' }, s.env, s.f, NOW)).status, 404);
  assert.strictEqual((await handleRefund({ email: '', key: '' }, s.env, s.f, NOW)).status, 400);
  assert.strictEqual((await handleRefund({ email: 'a@b.com', key: KEY }, {}, s.f, NOW)).status, 500);
  const old = await setup({ created: '2026-10-01T00:00:00Z' });
  assert.strictEqual((await handleRefund({ email: 'a@b.com', key: KEY }, old.env, old.f, NOW)).status, 403);
  assert.equal(old.calls.length, 0);
});

test('failed refund reports an error and keeps the key; refunded-in-Stripe counts as done', async () => {
  const { handleRefund } = await fn('api/refund.js');
  const bad = await setup({ refundOk: false });
  assert.strictEqual((await handleRefund({ email: 'a@b.com', key: KEY }, bad.env, bad.f, NOW)).status, 502);
  assert.equal((await bad.db.prepare('SELECT status FROM licences').first()).status, 'active');
  const done = await setup({ already: true });
  assert.deepStrictEqual((await handleRefund({ email: 'a@b.com', key: KEY }, done.env, done.f, NOW)).body, { ok: true, already: true });
});

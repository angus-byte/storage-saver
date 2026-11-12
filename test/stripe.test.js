const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const { d1 } = require('./d1');

const fn = (f) => import(pathToFileURL(path.join(__dirname, '../functions', f)).href);
const NOW = Date.parse('2026-11-20T00:00:00Z');
const SECRET = 'whsec_test';

function signed(event, t = NOW / 1000) {
  const payload = JSON.stringify(event);
  const sig = crypto.createHmac('sha256', SECRET).update(`${t}.${payload}`).digest('hex');
  return { payload, header: `t=${t},v1=${sig}` };
}
const session = (key, extra = {}) => ({ id: 'cs_test_abcdefghijkl', payment_status: 'paid', payment_intent: 'pi_9', amount_total: 1999, currency: 'usd', created: NOW / 1000, livemode: true, customer_details: { email: 'Buyer@x.com' }, metadata: { licence_key: key }, ...extra });

test('keys look right and are forgiving when typed', async () => {
  const { makeKey, cleanKey, form } = await fn('_lib/licences.js');
  const k = makeKey();
  assert.match(k, /^GP-[2-9A-HJ-NP-Z]{5}(-[2-9A-HJ-NP-Z]{5}){3}$/);
  assert.notEqual(k, makeKey());
  assert.equal(cleanKey(' ' + k.toLowerCase().replace(/-/g, ' ') + ' '), k);
  assert.equal(cleanKey('GIGA-AAAA-BBBB-CCCC-DDDD-EEEE'), '');
  assert.equal(form({ a: [{ b: 1 }], c: { d: 'x' }, e: undefined }).toString(), 'a%5B0%5D%5Bb%5D=1&c%5Bd%5D=x');
});

test('/buy creates a Stripe checkout with the key on the invoice and redirects', async () => {
  const { handleBuy } = await fn('buy.js');
  let sent;
  const f = async (url, opts) => {
    sent = { url, body: new URLSearchParams(opts.body), auth: opts.headers.Authorization };
    return { ok: true, json: async () => ({ url: 'https://checkout.stripe.com/c/pay/cs_1' }) };
  };
  const r = await handleBuy(new Request('https://getgigapolis.com/buy?ref=app'), { STRIPE_SECRET_KEY: 'sk_test_1' }, f);
  assert.deepEqual(r, { status: 303, location: 'https://checkout.stripe.com/c/pay/cs_1' });
  assert.equal(sent.url, 'https://api.stripe.com/v1/checkout/sessions');
  assert.equal(sent.auth, 'Bearer sk_test_1');
  assert.equal(sent.body.get('line_items[0][price_data][unit_amount]'), '1999');
  assert.equal(sent.body.get('metadata[ref]'), 'app');
  const key = sent.body.get('metadata[licence_key]');
  assert.match(key, /^GP-/);
  assert.equal(sent.body.get('invoice_creation[invoice_data][custom_fields][0][value]'), key);
  assert.equal(sent.body.get('automatic_tax[enabled]'), null);
  assert.equal((await handleBuy(new Request('https://getgigapolis.com/buy'), {}, f)).status, 503);
});

test('webhook issues a key once, rejects bad signatures, and refunds lock the key', async () => {
  const { handleWebhook } = await fn('api/stripe-webhook.js');
  const { handleClaim } = await fn('api/licence/claim.js');
  const db = d1();
  const env = { STRIPE_WEBHOOK_SECRET: SECRET, LICENCE_DB: db };
  const key = 'GP-AAAAA-BBBBB-CCCCC-DDDDD';
  const ev = signed({ type: 'checkout.session.completed', data: { object: session(key) } });
  assert.equal((await handleWebhook(ev.payload, ev.header.replace(/v1=./, 'v1=0'), env, NOW)).status, 400);
  assert.equal((await handleWebhook(ev.payload, ev.header, env, NOW + 3600e3)).status, 400); // too old
  assert.equal((await handleWebhook(ev.payload, ev.header, env, NOW)).status, 200);
  assert.equal((await handleWebhook(ev.payload, ev.header, env, NOW)).status, 200);
  const rows = await db.prepare('SELECT * FROM licences').all();
  assert.equal(rows.results.length, 1);
  assert.equal(rows.results[0].email, 'buyer@x.com');
  assert.equal(rows.results[0].activation_limit, 3);
  assert.deepEqual((await handleClaim('cs_test_abcdefghijkl', env, null, NOW)).body, { key, email: 'buyer@x.com', status: 'active' });
  const refund = signed({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_9', refunded: true, amount: 1999, amount_refunded: 1999 } } });
  await handleWebhook(refund.payload, refund.header, env, NOW);
  assert.equal((await db.prepare('SELECT status FROM licences').first()).status, 'disabled');
});

test('thank-you page claim falls back to asking Stripe when the webhook is late', async () => {
  const { handleClaim } = await fn('api/licence/claim.js');
  const db = d1();
  const key = 'GP-EEEEE-FFFFF-GGGGG-HHHHH';
  let paid = false;
  const f = async (url) => ({ ok: true, json: async () => session(key, { payment_status: paid ? 'paid' : 'unpaid' }) });
  const env = { STRIPE_SECRET_KEY: 'sk', LICENCE_DB: db };
  assert.equal((await handleClaim('cs_test_abcdefghijkl', env, f, NOW)).status, 404);
  paid = true;
  assert.equal((await handleClaim('cs_test_abcdefghijkl', env, f, NOW)).body.key, key);
  assert.equal((await handleClaim('bad', env, f, NOW)).status, 400);
});

test('licence server: activate up to the limit, validate, deactivate frees a seat, refund disables', async () => {
  const { handleLicence } = await fn('api/licence/[action].js');
  const { issueFromSession } = await fn('_lib/licences.js');
  const db = d1();
  const env = { LICENCE_DB: db };
  const key = 'GP-JJJJJ-KKKKK-LLLLL-MMMMM';
  await issueFromSession(db, env, session(key));
  const act = (k = key) => handleLicence('activate', { license_key: k, instance_name: 'Mac' }, env, NOW);
  const a1 = (await act(key.toLowerCase())).body;
  assert.equal(a1.activated, true);
  assert.deepEqual(a1.meta, { store_id: 'gigapolis', product_id: 'pro', customer_email: 'buyer@x.com' });
  assert.deepEqual(a1.license_key, { status: 'active', activation_limit: 3, activation_usage: 1 });
  await act();
  await act();
  const full = (await act()).body;
  assert.equal(full.activated, false);
  assert.match(full.error, /activation limit/);
  assert.equal((await handleLicence('validate', { license_key: key, instance_id: a1.instance.id }, env)).body.valid, true);
  assert.equal((await handleLicence('validate', { license_key: key, instance_id: 'nope' }, env)).body.valid, false);
  assert.equal((await handleLicence('deactivate', { license_key: key, instance_id: a1.instance.id }, env)).body.deactivated, true);
  assert.equal((await handleLicence('validate', { license_key: key, instance_id: a1.instance.id }, env)).body.valid, false);
  assert.equal((await act()).body.activated, true);
  assert.equal((await act('GP-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ')).body.activated, false);
  await db.prepare("UPDATE licences SET status = 'disabled'").run();
  const v = (await handleLicence('validate', { license_key: key, instance_id: a1.instance.id }, env)).body;
  assert.equal(v.valid, false);
  assert.equal(v.license_key.status, 'disabled');
  assert.match((await act()).body.error, /disabled/);
});

test('the app talks to the licence server end to end', async () => {
  const fs = require('fs'), os = require('os');
  const { createLicence } = require('../src/main/licence');
  const { handleLicence } = await fn('api/licence/[action].js');
  const { issueFromSession } = await fn('_lib/licences.js');
  const db = d1();
  const env = { LICENCE_DB: db };
  const key = 'GP-NNNNN-PPPPP-QQQQQ-RRRRR';
  await issueFromSession(db, env, session(key));
  const fetchImpl = async (url, opts) => {
    const out = await handleLicence(url.split('/').pop(), Object.fromEntries(new URLSearchParams(opts.body)), env);
    return { ok: out.status < 300, json: async () => out.body };
  };
  const cfg = { ...require('../src/main/config'), licenceApi: 'https://getgigapolis.com/api/licence/' };
  let t = Date.now();
  const lic = createLicence({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'gp-')), cfg, fetchImpl, now: () => t, machineId: () => 'm1' });
  const r = await lic.activate(key);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.status.plan, 'pro');
  assert.deepEqual(r.status.activations, { used: 1, limit: 3 });
  await db.prepare("UPDATE licences SET status = 'disabled'").run();
  t += cfg.revalidateMs + 1;
  await lic.revalidate();
  assert.equal(lic.status().plan, 'free');
});

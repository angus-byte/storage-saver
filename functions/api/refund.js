// Cloudflare Pages Function: POST /api/refund
// Self-serve 30-day refunds for Gigapolis Pro, paid through Stripe.
// Needs STRIPE_SECRET_KEY and the licence database (see functions/_lib/licences.js).
// The refund switches the licence key off, and the app locks Pro on its next check.
import { REFUND_DAYS, cleanKey, dbOf, ensureTables, json, stripe } from '../_lib/licences.js';

export { REFUND_DAYS };
const DAY = 24 * 60 * 60 * 1000;
const fail = (status, error) => ({ status, body: { ok: false, error } });

export async function handleRefund(input, env, fetchImpl = fetch, now = Date.now()) {
  const email = String((input && input.email) || '').trim().toLowerCase();
  const key = cleanKey(input && input.key);
  if (!email || !(input && input.key)) return fail(400, 'Enter the email you bought with and your licence key.');
  const db = dbOf(env);
  if (!db || !env.STRIPE_SECRET_KEY) return fail(500, 'Refunds are not set up yet. Email hello@getgigapolis.com.');
  await ensureTables(db);

  const row = key && (await db.prepare('SELECT * FROM licences WHERE key = ?').bind(key).first());
  if (!row || String(row.email || '').toLowerCase() !== email) {
    return fail(404, "We couldn't find a Gigapolis Pro purchase with that email and licence key.");
  }
  if (row.refunded_at) return { status: 200, body: { ok: true, already: true } };
  if (row.status !== 'active' || !row.payment_intent) return fail(409, 'This order is not eligible for an automatic refund. Email hello@getgigapolis.com.');
  const age = now - row.created_at;
  if (!(age >= 0 && age <= REFUND_DAYS * DAY)) {
    return fail(403, `Automatic refunds are available for ${REFUND_DAYS} days after purchase. Email hello@getgigapolis.com if something went wrong.`);
  }

  const r = await stripe(env, fetchImpl, 'POST', '/refunds', { payment_intent: row.payment_intent, reason: 'requested_by_customer', metadata: { licence_key: key } });
  const already = r.body && r.body.error && r.body.error.code === 'charge_already_refunded';
  if (!r.ok && !already) return fail(502, 'The refund could not be processed automatically. Email hello@getgigapolis.com and we will sort it out.');

  await db.prepare("UPDATE licences SET status = 'disabled', refunded_at = ? WHERE key = ?").bind(now, key).run();
  return { status: 200, body: already ? { ok: true, already: true } : { ok: true } };
}

export async function onRequestPost({ request, env }) {
  let input = {};
  try {
    input = await request.json();
  } catch {}
  const out = await handleRefund(input, env).catch(() => fail(502, 'Something went wrong. Email hello@getgigapolis.com and we will sort it out.'));
  return json(out.body, out.status);
}

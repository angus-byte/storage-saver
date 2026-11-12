// Cloudflare Pages Function: POST /api/stripe-webhook
// Stripe → Developers → Webhooks → add endpoint https://getgigapolis.com/api/stripe-webhook with events:
//   checkout.session.completed, checkout.session.async_payment_succeeded, charge.refunded, charge.dispute.created
// Then paste its signing secret into Cloudflare as STRIPE_WEBHOOK_SECRET.
import { dbOf, disableByPaymentIntent, issueFromSession, json, verifyStripe } from '../_lib/licences.js';

export async function handleWebhook(payload, signature, env, now = Date.now()) {
  if (!(await verifyStripe(payload, signature, env && env.STRIPE_WEBHOOK_SECRET, now))) return { status: 400, body: { error: 'bad signature' } };
  const db = dbOf(env);
  if (!db) return { status: 500, body: { error: 'no database' } };
  const event = JSON.parse(payload);
  const o = (event.data && event.data.object) || {};
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      await issueFromSession(db, env, o, now);
      break;
    case 'charge.refunded':
      // Full refunds only; a partial goodwill refund keeps the key working.
      if (o.refunded || o.amount_refunded >= o.amount) await disableByPaymentIntent(db, o.payment_intent, 'refund', now);
      break;
    case 'charge.dispute.created':
      await disableByPaymentIntent(db, o.payment_intent, 'dispute', now);
      break;
  }
  return { status: 200, body: { received: true } };
}

export async function onRequestPost({ request, env }) {
  const out = await handleWebhook(await request.text(), request.headers.get('Stripe-Signature'), env).catch(() => ({ status: 500, body: { error: 'failed' } }));
  return json(out.body, out.status);
}

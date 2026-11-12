// Cloudflare Pages Function: GET /api/licence/claim?session_id=cs_…
// The thank-you page uses this to show the buyer their key straight after paying.
// If the webhook hasn't arrived yet, the session is checked with Stripe directly.
import { dbOf, ensureTables, issueFromSession, json, stripe } from '../../_lib/licences.js';

export async function handleClaim(sessionId, env, fetchImpl = fetch, now = Date.now()) {
  if (!/^cs_[A-Za-z0-9_]{10,200}$/.test(sessionId || '')) return { status: 400, body: { error: 'Missing order reference.' } };
  const db = dbOf(env);
  if (!db) return { status: 500, body: { error: 'Not set up yet.' } };
  await ensureTables(db);
  let row = await db.prepare('SELECT * FROM licences WHERE session_id = ?').bind(sessionId).first();
  if (!row && env.STRIPE_SECRET_KEY) {
    const r = await stripe(env, fetchImpl, 'GET', '/checkout/sessions/' + sessionId);
    if (r.ok) row = await issueFromSession(db, env, r.body, now);
  }
  if (!row) return { status: 404, body: { error: 'pending' } };
  return { status: 200, body: { key: row.key, email: row.email, status: row.status } };
}

export async function onRequestGet({ request, env }) {
  const id = new URL(request.url).searchParams.get('session_id');
  const out = await handleClaim(id, env).catch(() => ({ status: 500, body: { error: 'failed' } }));
  return json(out.body, out.status);
}

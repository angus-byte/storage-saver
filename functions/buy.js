// Cloudflare Pages Function: GET /buy  →  redirects to a Stripe Checkout page for Gigapolis Pro.
// Used by the website's "Buy Pro" button and the app's "Buy Pro". ?ref=<source> is kept for stats.
import { checkoutParams, makeKey, stripe } from './_lib/licences.js';

export async function handleBuy(request, env, fetchImpl = fetch) {
  if (!env || !env.STRIPE_SECRET_KEY) return { status: 503, error: 'Checkout is not set up yet. Email hello@getgigapolis.com.' };
  const ref = (new URL(request.url).searchParams.get('ref') || '').replace(/[^a-z0-9._-]/gi, '').slice(0, 40);
  const r = await stripe(env, fetchImpl, 'POST', '/checkout/sessions', checkoutParams(env, makeKey(), ref));
  if (!r.ok || !r.body.url) return { status: 502, error: 'Checkout is unavailable right now. Please try again in a minute.' };
  return { status: 303, location: r.body.url };
}

export async function onRequestGet({ request, env }) {
  let out;
  try {
    out = await handleBuy(request, env);
  } catch {
    out = { status: 502, error: 'Checkout is unavailable right now. Please try again in a minute.' };
  }
  if (out.location) return new Response(null, { status: 303, headers: { Location: out.location, 'Cache-Control': 'no-store' } });
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Gigapolis</title><p style="font:17px system-ui;padding:40px">${out.error} <a href="/">Back</a></p>`, {
    status: out.status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

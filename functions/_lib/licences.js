// Shared code for selling Gigapolis Pro with Stripe and issuing our own licence keys.
// Storage: the D1 database bound as LICENCE_DB (falls back to STATS_DB, so the existing
// gigapolis-stats database works with no extra setup). Tables are created on first use.
//
// Secrets (Cloudflare Pages → Settings → Variables and Secrets):
//   STRIPE_SECRET_KEY      sk_live_… (or sk_test_… while testing)
//   STRIPE_WEBHOOK_SECRET  whsec_… from the Stripe webhook endpoint
// Optional variables:
//   STRIPE_PRICE_ID        a Stripe price to sell; otherwise US$19.99 is created inline
//   STRIPE_AUTOMATIC_TAX   "1" to let Stripe Tax add sales tax / VAT at checkout
//   ACTIVATION_LIMIT       computers per key (default 3)

export const PRICE_CENTS = 1999;
export const REFUND_DAYS = 30;
export const SITE = 'https://getgigapolis.com';
// Sent back to the app so it can tell a Gigapolis Pro key from anything else.
export const META = { store_id: 'gigapolis', product_id: 'pro' };
const STRIPE = 'https://api.stripe.com/v1';

export const dbOf = (env) => (env && (env.LICENCE_DB || env.STATS_DB)) || null;
export const limitOf = (env) => Math.max(1, Number(env && env.ACTIVATION_LIMIT) || 3);

const ready = new WeakMap();
export function ensureTables(db) {
  if (!ready.has(db)) {
    ready.set(db, db
      .batch([
        db.prepare(`CREATE TABLE IF NOT EXISTS licences (
          key TEXT PRIMARY KEY, email TEXT, session_id TEXT UNIQUE, payment_intent TEXT,
          amount INTEGER, currency TEXT, created_at INTEGER, status TEXT, refunded_at INTEGER,
          live INTEGER, activation_limit INTEGER)`),
        db.prepare('CREATE INDEX IF NOT EXISTS licences_pi ON licences (payment_intent)'),
        db.prepare('CREATE TABLE IF NOT EXISTS activations (id TEXT PRIMARY KEY, key TEXT, name TEXT, created_at INTEGER)'),
        db.prepare('CREATE INDEX IF NOT EXISTS activations_key ON activations (key)'),
      ])
      .catch((e) => {
        ready.delete(db);
        throw e;
      }));
  }
  return ready.get(db);
}

// GP-XXXXX-XXXXX-XXXXX-XXXXX: 100 random bits, no look-alike characters.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export function makeKey() {
  const b = crypto.getRandomValues(new Uint8Array(20));
  let s = '';
  for (const x of b) s += ALPHABET[x & 31];
  return 'GP-' + s.match(/.{5}/g).join('-');
}
// Forgiving about case, spaces and dashes when a key is typed or pasted.
export function cleanKey(k) {
  const s = String(k || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^GP[A-Z0-9]{20}$/.test(s)) return '';
  return 'GP-' + s.slice(2).match(/.{5}/g).join('-');
}

// Stripe's API takes form-encoded bodies with bracketed nested keys.
export function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const name = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, name, out);
    else out.append(name, String(v));
  }
  return out;
}
export async function stripe(env, fetchImpl, method, path, params) {
  const res = await fetchImpl(STRIPE + path, {
    method,
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params ? form(params).toString() : undefined,
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

// Checkout session for one copy of Pro. The licence key is made up front and travels in
// the session's metadata, so it can be printed on the receipt / invoice Stripe emails.
export function checkoutParams(env, key, ref) {
  const item = env.STRIPE_PRICE_ID
    ? { price: env.STRIPE_PRICE_ID, quantity: 1 }
    : { price_data: { currency: 'usd', unit_amount: PRICE_CENTS, product_data: { name: 'Gigapolis Pro', description: 'Lifetime licence for up to 3 computers (Mac or Windows).' } }, quantity: 1 };
  return {
    mode: 'payment',
    line_items: [item],
    success_url: `${SITE}/thanks?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${SITE}/#pricing`,
    allow_promotion_codes: 'true',
    metadata: { licence_key: key, ref: ref || '' },
    payment_intent_data: { description: `Gigapolis Pro. Your licence key: ${key}`, metadata: { licence_key: key } },
    invoice_creation: {
      enabled: 'true',
      invoice_data: {
        description: `Your Gigapolis Pro licence key: ${key}. In Gigapolis, open Pro and paste it in. Refunds within 30 days: ${SITE}/refund`,
        custom_fields: [{ name: 'Licence key', value: key }],
        metadata: { licence_key: key },
      },
    },
    automatic_tax: env.STRIPE_AUTOMATIC_TAX === '1' ? { enabled: 'true' } : undefined,
  };
}

const PAID = (s) => s && s.metadata && s.metadata.licence_key && (s.payment_status === 'paid' || s.payment_status === 'no_payment_required');

// Store the key for a completed checkout session. Safe to call twice (webhook + thank-you page).
export async function issueFromSession(db, env, session, now = Date.now()) {
  if (!PAID(session)) return null;
  await ensureTables(db);
  const key = cleanKey(session.metadata.licence_key);
  if (!key) return null;
  const email = String((session.customer_details && session.customer_details.email) || session.customer_email || '').toLowerCase();
  await db
    .prepare(`INSERT OR IGNORE INTO licences (key, email, session_id, payment_intent, amount, currency, created_at, status, live, activation_limit)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`)
    .bind(key, email, session.id, session.payment_intent || null, session.amount_total || 0, session.currency || 'usd',
      session.created ? session.created * 1000 : now, session.livemode ? 1 : 0, limitOf(env))
    .run();
  return db.prepare('SELECT * FROM licences WHERE session_id = ?').bind(session.id).first();
}

export async function disableByPaymentIntent(db, pi, reason, now = Date.now()) {
  if (!pi) return;
  await ensureTables(db);
  await db.prepare("UPDATE licences SET status = 'disabled', refunded_at = COALESCE(refunded_at, ?) WHERE payment_intent = ?").bind(reason === 'refund' ? now : null, pi).run();
}

// Stripe-Signature: t=<unix>,v1=<hex hmac of "t.body">
export async function verifyStripe(payload, header, secret, now = Date.now(), toleranceS = 300) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(String(header).split(',').map((p) => p.split('=')).filter((p) => p.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
  const sigs = String(header).split(',').filter((p) => p.trim().startsWith('v1=')).map((p) => p.trim().slice(3));
  const t = Number(parts.t);
  if (!t || !sigs.length || Math.abs(now / 1000 - t) > toleranceS) return false;
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${t}.${payload}`)));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  return sigs.some((s) => sameString(s, hex));
}
export function sameString(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

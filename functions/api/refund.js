// Cloudflare Pages Function: POST /api/refund
// Self-serve 30-day refunds for Gigapolis Pro via the Lemon Squeezy API.
// Needs one secret in Cloudflare Pages: LEMONSQUEEZY_API_KEY.
// The refund disables the licence key, and the app locks Pro on its next check.

const LS = 'https://api.lemonsqueezy.com/v1';
export const STORE_ID = 513897;
export const PRODUCT_ID = 1496849;
export const REFUND_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

const fail = (status, error) => ({ status, body: { ok: false, error } });

export async function handleRefund(input, env, fetchImpl = fetch, now = Date.now()) {
  const email = String((input && input.email) || '').trim().toLowerCase();
  const key = String((input && input.key) || '').trim();
  if (!email || !key) return fail(400, 'Enter the email you bought with and your licence key.');
  if (!env || !env.LEMONSQUEEZY_API_KEY) return fail(500, 'Refunds are not set up yet. Email hello@getgigapolis.com.');

  const auth = {
    Accept: 'application/vnd.api+json',
    'Content-Type': 'application/vnd.api+json',
    Authorization: `Bearer ${env.LEMONSQUEEZY_API_KEY}`,
  };

  // 1. Look up the key (public endpoint) and make sure it belongs to this buyer and product.
  const vRes = await fetchImpl(`${LS}/licenses/validate`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ license_key: key }).toString(),
  });
  const v = await vRes.json().catch(() => ({}));
  const meta = v.meta || {};
  const lk = v.license_key || {};
  const match =
    meta.store_id === STORE_ID &&
    meta.product_id === PRODUCT_ID &&
    String(meta.customer_email || '').toLowerCase() === email;
  if (!lk.id || !meta.order_id || !match) {
    return fail(404, "We couldn't find a Gigapolis Pro purchase with that email and licence key.");
  }

  // 2. Check the order: paid, not already refunded, within 30 days.
  const oRes = await fetchImpl(`${LS}/orders/${meta.order_id}`, { headers: auth });
  if (!oRes.ok) return fail(502, 'Our payment provider did not respond. Please try again in a minute.');
  const order = ((await oRes.json()).data || {}).attributes || {};
  if (order.refunded || order.status === 'refunded') return { status: 200, body: { ok: true, already: true } };
  if (order.status !== 'paid') return fail(409, 'This order is not eligible for an automatic refund. Email hello@getgigapolis.com.');
  const age = now - Date.parse(order.created_at);
  if (!(age >= 0 && age <= REFUND_DAYS * DAY)) {
    return fail(403, `Automatic refunds are available for ${REFUND_DAYS} days after purchase. Email hello@getgigapolis.com if something went wrong.`);
  }

  // 3. Refund in full.
  const rRes = await fetchImpl(`${LS}/orders/${meta.order_id}/refund`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ data: { type: 'orders', id: String(meta.order_id), attributes: { amount: order.total } } }),
  });
  if (!rRes.ok) return fail(502, 'The refund could not be processed automatically. Email hello@getgigapolis.com and we will sort it out.');

  // 4. Make sure the key is switched off (Lemon Squeezy normally does this on refund).
  await fetchImpl(`${LS}/license-keys/${lk.id}`, {
    method: 'PATCH',
    headers: auth,
    body: JSON.stringify({ data: { type: 'license-keys', id: String(lk.id), attributes: { disabled: true } } }),
  }).catch(() => {});

  return { status: 200, body: { ok: true } };
}

export async function onRequestPost({ request, env }) {
  let input = {};
  try {
    input = await request.json();
  } catch {}
  let out;
  try {
    out = await handleRefund(input, env);
  } catch {
    out = fail(502, 'Something went wrong. Email hello@getgigapolis.com and we will sort it out.');
  }
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

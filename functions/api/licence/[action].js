// Cloudflare Pages Function: POST /api/licence/activate | validate | deactivate
// Called by the app (src/main/licence.js). Form-encoded like the Lemon Squeezy licence API the
// app used before, and answers in the same shape, so the app logic stayed the same.
import { META, cleanKey, dbOf, ensureTables, json } from '../../_lib/licences.js';

const keyInfo = (row, usage) => ({ status: row.status === 'active' ? 'active' : 'disabled', activation_limit: row.activation_limit || 3, activation_usage: usage });
const meta = (row) => ({ ...META, customer_email: row.email || null });
const count = async (db, key) => ((await db.prepare('SELECT COUNT(*) AS n FROM activations WHERE key = ?').bind(key).first()) || {}).n || 0;

export async function handleLicence(action, params, env, now = Date.now()) {
  const db = dbOf(env);
  if (!db) return { status: 500, body: { error: 'Licence server is not set up.' } };
  await ensureTables(db);
  const key = cleanKey(params.license_key);
  const row = key && (await db.prepare('SELECT * FROM licences WHERE key = ?').bind(key).first());
  const no = (flag, error, status = 404) => ({ status, body: { [flag]: false, error } });

  if (action === 'activate') {
    if (!row) return no('activated', 'license_key not found');
    if (row.status !== 'active') return no('activated', 'This license key is disabled (refunded).', 400);
    const used = await count(db, key);
    if (used >= (row.activation_limit || 3)) return no('activated', 'This license key has reached the activation limit.', 400);
    const id = crypto.randomUUID();
    const name = String(params.instance_name || '').slice(0, 120);
    await db.prepare('INSERT INTO activations (id, key, name, created_at) VALUES (?, ?, ?, ?)').bind(id, key, name, now).run();
    return { status: 200, body: { activated: true, error: null, instance: { id, name }, license_key: keyInfo(row, used + 1), meta: meta(row) } };
  }
  if (action === 'validate') {
    if (!row) return no('valid', 'license_key not found');
    const inst = params.instance_id ? await db.prepare('SELECT id FROM activations WHERE id = ? AND key = ?').bind(String(params.instance_id), key).first() : true;
    const used = await count(db, key);
    const valid = row.status === 'active' && !!inst;
    return { status: 200, body: { valid, error: valid ? null : row.status !== 'active' ? 'license_key is disabled' : 'instance not found', license_key: keyInfo(row, used), meta: meta(row) } };
  }
  if (action === 'deactivate') {
    if (!row) return no('deactivated', 'license_key not found');
    await db.prepare('DELETE FROM activations WHERE id = ? AND key = ?').bind(String(params.instance_id || ''), key).run();
    return { status: 200, body: { deactivated: true, error: null, license_key: keyInfo(row, await count(db, key)), meta: meta(row) } };
  }
  return { status: 404, body: { error: 'unknown action' } };
}

export async function onRequestPost({ request, env, params }) {
  let input = {};
  try {
    const type = request.headers.get('Content-Type') || '';
    input = type.includes('json') ? await request.json() : Object.fromEntries(new URLSearchParams(await request.text()));
  } catch {}
  const out = await handleLicence(params.action, input, env).catch(() => ({ status: 500, body: { error: 'Licence server error. Try again shortly.' } }));
  return json(out.body, out.status);
}

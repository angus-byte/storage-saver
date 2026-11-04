// Free / Pro plan: Lemon Squeezy licence keys + the free Demolish allowance.
// Pure Node (no Electron import) so it can be unit tested; main.js passes in
// the folder to keep state in and, optionally, a fetch implementation.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const config = require('./config');

const API = 'https://api.lemonsqueezy.com/v1/licenses/';

function createLicence({ dir, fetchImpl = globalThis.fetch, now = () => Date.now(), forcePro = false, cfg = config, machineId = () => 'unknown' }) {
  const file = path.join(dir, 'gigapolis-plan.json');
  let data = { licence: null, demolishedBytes: 0, weekly: { enabled: true, lastRun: 0 } };
  try {
    data = { ...data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {}

  function save() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch {}
  }

  // Owner key: only a salted scrypt hash of it lives in config, so it can't be
  // read from the repo or the app bundle. Checked again on every launch, so a
  // hand-edited plan file can't fake it.
  function isOwnerKey(key) {
    const o = cfg.ownerKey;
    if (!o || !o.salt || !o.hash || !canonicalOwnerKey(key || '')) return false;
    const want = Buffer.from(o.hash, 'hex');
    const got = crypto.scryptSync(canonicalOwnerKey(key), o.salt, want.length, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    return crypto.timingSafeEqual(got, want);
  }
  // Forgiving about how the key was typed or pasted: case, spaces, smart or
  // missing dashes, a dropped "GIGA" prefix.
  function canonicalOwnerKey(key) {
    let k = String(key).toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (k.length === 20) k = 'GIGA' + k;
    if (!/^GIGA[A-Z0-9]{20}$/.test(k)) return '';
    return 'GIGA-' + k.slice(4).match(/.{4}/g).join('-');
  }
  let ownerOk = !!(data.licence && data.licence.owner && isOwnerKey(data.licence.key));

  // A licence activated on another computer (plan file copied across, or a
  // restored backup / migrated Mac) doesn't count here. It needs its own
  // activation, which uses one of the key's seats on Lemon Squeezy.
  const here = machineId();
  // Licences saved by versions before 0.10.6 have no computer id: adopt this one.
  if (data.licence && !data.licence.owner && !data.licence.machine) {
    data.licence.machine = here;
    save();
  }

  function isPro() {
    if (forcePro || ownerOk) return true;
    const l = data.licence;
    if (!l || l.owner || l.status === 'invalid' || l.machine !== here) return false;
    const age = now() - (l.validatedAt || 0);
    // A date in the future means the plan file was edited by hand.
    return age >= -3600000 && age < cfg.offlineGraceMs;
  }

  function status() {
    const pro = isPro();
    const used = data.demolishedBytes || 0;
    return {
      plan: pro ? 'pro' : 'free',
      capBytes: pro ? null : cfg.freeCapBytes,
      usedBytes: used,
      remainingBytes: pro ? null : Math.max(0, cfg.freeCapBytes - used),
      email: data.licence && data.licence.email,
      keyHint: ownerOk ? 'Owner key' : data.licence ? '…' + data.licence.key.slice(-6) : null,
      // Seats: "used on 2 of 3 computers" (null when unknown / owner key).
      activations: !ownerOk && data.licence && data.licence.limit ? { used: data.licence.usage || 1, limit: data.licence.limit } : null,
      // Why a saved licence isn't giving Pro, so the UI can explain it.
      licenceProblem: pro || !data.licence || ownerOk ? null : data.licence.machine !== here ? 'other-computer' : data.licence.status === 'invalid' ? 'invalid' : 'offline',
      weekly: { ...data.weekly },
      priceLabel: cfg.priceLabel,
      devPro: forcePro,
    };
  }

  async function call(endpoint, params) {
    const res = await fetchImpl(API + endpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    let body = {};
    try {
      body = await res.json();
    } catch {}
    return { httpOk: res.ok, body };
  }

  // Lemon Squeezy key status: active / inactive are fine; disabled (refund,
  // or switched off by hand in the dashboard) and expired are not.
  function keyUsable(k) {
    return !k || !k.status || k.status === 'active' || k.status === 'inactive';
  }
  function seats(k) {
    return k && k.activation_limit ? { limit: k.activation_limit, usage: k.activation_usage || null } : {};
  }
  function friendlyError(b) {
    const e = String(b.error || '');
    if (/activation limit/i.test(e)) return `This key is already in use on the most computers allowed. Open Gigapolis on one of them and choose "Deactivate this computer", then try again.`;
    if (/disabled|refund/i.test(e)) return 'That key has been refunded or disabled.';
    if (/expired/i.test(e)) return 'That key has expired.';
    if (/not found|invalid/i.test(e)) return 'That key was not recognised. Check it against your receipt email.';
    return e || 'That key was not accepted.';
  }

  function rightProduct(meta) {
    if (!meta) return false;
    if (cfg.storeId && meta.store_id !== cfg.storeId) return false;
    if (cfg.productId && meta.product_id !== cfg.productId) return false;
    return true;
  }

  async function activate(rawKey) {
    const key = String(rawKey || '').trim();
    if (!key) return { ok: false, error: 'Enter your licence key.' };
    if (isOwnerKey(key)) {
      data.licence = { key: canonicalOwnerKey(key), owner: true, email: null, status: 'active', validatedAt: now() };
      ownerOk = true;
      save();
      return { ok: true, status: status() };
    }
    let r;
    try {
      r = await call('activate', { license_key: key, instance_name: `Gigapolis on ${os.hostname()}` });
    } catch {
      return { ok: false, error: 'Could not reach the licence server. Check your internet connection.' };
    }
    const b = r.body;
    if (!b.activated || !b.instance) return { ok: false, error: friendlyError(b) };
    if (b.license_key && !keyUsable(b.license_key)) {
      call('deactivate', { license_key: key, instance_id: b.instance.id }).catch(() => {});
      return { ok: false, error: 'That key has been refunded or disabled.' };
    }
    if (!rightProduct(b.meta)) {
      // Release the activation we just used up on someone else's product.
      call('deactivate', { license_key: key, instance_id: b.instance.id }).catch(() => {});
      return { ok: false, error: 'That key is not for Gigapolis Pro.' };
    }
    data.licence = { key, instanceId: b.instance.id, machine: here, email: b.meta.customer_email || null, status: 'active', validatedAt: now(), ...seats(b.license_key) };
    save();
    return { ok: true, status: status() };
  }

  // Called at startup and every few hours. Network trouble never downgrades;
  // only an explicit "not valid" from the server (refund, disabled key) does.
  async function revalidate(force = false) {
    const l = data.licence;
    if (!l || l.owner || l.status === 'invalid' || l.machine !== here) return status();
    const age = now() - (l.validatedAt || 0);
    if (!force && age >= 0 && age < cfg.revalidateMs) return status();
    try {
      const r = await call('validate', { license_key: l.key, instance_id: l.instanceId });
      if (typeof r.body.valid === 'boolean') {
        // valid:false covers a refunded/disabled key and an activation that
        // was removed (from another computer or the Lemon Squeezy dashboard).
        const good = r.body.valid && rightProduct(r.body.meta) && keyUsable(r.body.license_key);
        l.status = good ? 'active' : 'invalid';
        if (good) {
          l.validatedAt = now();
          Object.assign(l, seats(r.body.license_key));
        }
        save();
      }
    } catch {}
    return status();
  }

  async function deactivate() {
    const l = data.licence;
    if (!l) return { ok: true, status: status() };
    if (!l.owner && l.machine === here) try {
      await call('deactivate', { license_key: l.key, instance_id: l.instanceId });
    } catch {}
    data.licence = null;
    ownerOk = false;
    save();
    return { ok: true, status: status() };
  }

  // --- Free Demolish allowance --------------------------------------------
  /** null when allowed, otherwise a 'cap' error object for the UI. */
  function checkAllowance(bytes) {
    if (isPro() || bytes <= 0) return null;
    const remaining = Math.max(0, cfg.freeCapBytes - (data.demolishedBytes || 0));
    if (bytes <= remaining) return null;
    return { ok: false, error: 'cap', needBytes: bytes, remainingBytes: remaining, capBytes: cfg.freeCapBytes };
  }
  function recordDemolished(bytes) {
    if (bytes <= 0) return;
    data.demolishedBytes = (data.demolishedBytes || 0) + bytes;
    save();
  }

  function setWeekly(patch) {
    data.weekly = { ...data.weekly, ...patch };
    save();
    return status();
  }

  return { status, isPro, activate, revalidate, deactivate, checkAllowance, recordDemolished, setWeekly, checkoutUrl: cfg.checkoutUrl };
}

module.exports = { createLicence };

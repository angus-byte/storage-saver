// Free / Pro plan: Lemon Squeezy licence keys + the free Demolish allowance.
// Pure Node (no Electron import) so it can be unit tested; main.js passes in
// the folder to keep state in and, optionally, a fetch implementation.
const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');

const API = 'https://api.lemonsqueezy.com/v1/licenses/';

function createLicence({ dir, fetchImpl = globalThis.fetch, now = () => Date.now(), forcePro = false, cfg = config }) {
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

  function isPro() {
    if (forcePro) return true;
    const l = data.licence;
    if (!l || l.status === 'invalid') return false;
    return now() - (l.validatedAt || 0) < cfg.offlineGraceMs;
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
      keyHint: data.licence ? '…' + data.licence.key.slice(-6) : null,
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

  function rightProduct(meta) {
    if (!meta) return false;
    if (cfg.storeId && meta.store_id !== cfg.storeId) return false;
    if (cfg.productId && meta.product_id !== cfg.productId) return false;
    return true;
  }

  async function activate(rawKey) {
    const key = String(rawKey || '').trim();
    if (!key) return { ok: false, error: 'Enter your licence key.' };
    let r;
    try {
      r = await call('activate', { license_key: key, instance_name: `Gigapolis on ${os.hostname()}` });
    } catch {
      return { ok: false, error: 'Could not reach the licence server. Check your internet connection.' };
    }
    const b = r.body;
    if (!b.activated || !b.instance) return { ok: false, error: b.error || 'That key was not accepted.' };
    if (!rightProduct(b.meta)) {
      // Release the activation we just used up on someone else's product.
      call('deactivate', { license_key: key, instance_id: b.instance.id }).catch(() => {});
      return { ok: false, error: 'That key is not for Gigapolis Pro.' };
    }
    data.licence = { key, instanceId: b.instance.id, email: b.meta.customer_email || null, status: 'active', validatedAt: now() };
    save();
    return { ok: true, status: status() };
  }

  // Called at startup and every few hours. Network trouble never downgrades;
  // only an explicit "not valid" from the server (refund, disabled key) does.
  async function revalidate(force = false) {
    const l = data.licence;
    if (!l || l.status === 'invalid') return status();
    if (!force && now() - (l.validatedAt || 0) < cfg.revalidateMs) return status();
    try {
      const r = await call('validate', { license_key: l.key, instance_id: l.instanceId });
      if (typeof r.body.valid === 'boolean') {
        const good = r.body.valid && rightProduct(r.body.meta);
        l.status = good ? 'active' : 'invalid';
        if (good) l.validatedAt = now();
        save();
      }
    } catch {}
    return status();
  }

  async function deactivate() {
    const l = data.licence;
    if (!l) return { ok: true, status: status() };
    try {
      await call('deactivate', { license_key: l.key, instance_id: l.instanceId });
    } catch {}
    data.licence = null;
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

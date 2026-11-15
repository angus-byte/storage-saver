// Mac App Store build only (process.mas): In-App Purchase for Pro and the
// security-scoped bookmarks that let the sandboxed app keep reading the
// folders the user picked. Nothing here runs in the direct-download build.
const { app, dialog, inAppPurchase } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { IAP_PRODUCT_ID } = require('./distribution');

// --- Folder access (security-scoped bookmarks) ------------------------------
// The sandbox only sees folders the user chose in an Open dialog. The bookmark
// returned with the choice is saved, and re-opened at every launch with
// startAccessingSecurityScopedResource, so the user picks each folder once.
function createBookmarks({ dir }) {
  const file = path.join(dir, 'bookmarks.json');
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8')) || {};
  } catch {}
  const open = new Map(); // path -> stopAccessing()

  function save() {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } catch {}
  }
  function start(p) {
    if (open.has(p) || !data[p]) return;
    try {
      open.set(p, app.startAccessingSecurityScopedResource(data[p]));
    } catch (err) {
      console.warn('Bookmark no longer valid for', p, err && err.message);
      delete data[p];
      save();
    }
  }
  // Re-open everything saved earlier (called once the app is ready).
  function restore() {
    for (const p of Object.keys(data)) start(p);
  }
  const covers = (root, p) => {
    const r = path.resolve(root);
    const q = path.resolve(p);
    return q === r || q.startsWith(r + path.sep);
  };
  // True when some granted folder contains p.
  const has = (p) => [...open.keys()].some((root) => covers(root, p));

  // Ask for a folder (default: the one given). Returns the chosen path, or
  // null when cancelled. The bookmark is kept for next time.
  async function request(win, { defaultPath = os.homedir(), message } = {}) {
    const res = await dialog.showOpenDialog(win || undefined, {
      title: 'Give Gigapolis access',
      message: message || `Choose your home folder (${path.basename(defaultPath)}) and click Open so Gigapolis can measure it. Nothing is deleted without asking.`,
      buttonLabel: 'Open',
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
      securityScopedBookmarks: true,
    });
    if (res.canceled || !res.filePaths[0]) return null;
    const p = res.filePaths[0];
    if (res.bookmarks && res.bookmarks[0]) {
      data[p] = res.bookmarks[0];
      save();
      start(p);
    } else {
      // Not sandboxed (mas-dev with the sandbox off): access is implicit.
      open.set(p, () => {});
    }
    return p;
  }
  // Make sure p is readable: already granted, or ask for the folder itself.
  async function ensure(win, p, opts) {
    if (has(p)) return p;
    return request(win, { defaultPath: p, ...opts });
  }
  function stopAll() {
    for (const stop of open.values()) {
      try { stop(); } catch {}
    }
    open.clear();
  }
  return { restore, has, request, ensure, stopAll, list: () => Object.keys(data) };
}

// --- In-App Purchase (StoreKit) ----------------------------------------------
// One non-consumable product, IAP_PRODUCT_ID, unlocks Pro for life. The
// transaction's purchased/restored state is what unlocks Pro; it is stored by
// the licence module (plan.setStorePurchase) so Pro survives restarts, and
// "Restore purchases" brings it back on a new Mac.
function createStore({ plan, onChange = () => {} }) {
  let products = null;
  let pending = null; // { resolve } of the purchase in flight

  function finish(result) {
    if (pending) {
      pending.resolve(result);
      pending = null;
    }
    onChange();
  }

  inAppPurchase.on('transactions-updated', (_e, transactions) => {
    for (const t of transactions || []) {
      const payment = t.payment || {};
      if (payment.productIdentifier !== IAP_PRODUCT_ID && t.transactionState !== 'failed') continue;
      switch (t.transactionState) {
        case 'purchased':
        case 'restored':
          plan.setStorePurchase({ productId: payment.productIdentifier, transactionId: t.transactionIdentifier, date: t.transactionDate, state: t.transactionState });
          inAppPurchase.finishTransactionByDate(t.transactionDate);
          finish({ ok: true, restored: t.transactionState === 'restored', status: plan.status() });
          break;
        case 'failed':
          inAppPurchase.finishTransactionByDate(t.transactionDate);
          finish({ ok: false, error: (t.errorMessage && !/cancel/i.test(t.errorMessage) ? t.errorMessage : null) || 'Purchase cancelled.' , cancelled: true });
          break;
        case 'deferred':
          finish({ ok: false, error: 'Waiting for approval (Ask to Buy). Pro turns on as soon as it is approved.', deferred: true });
          break;
        default:
          break; // purchasing: wait
      }
    }
  });

  async function product() {
    if (products) return products;
    const list = await inAppPurchase.getProducts([IAP_PRODUCT_ID]);
    products = list && list.length ? list : null;
    return products;
  }
  // Price as the App Store formats it for the user's storefront ("US$19.99").
  async function price() {
    const p = await product().catch(() => null);
    return p ? p[0].formattedPrice : null;
  }

  function purchase() {
    if (!inAppPurchase.canMakePayments()) return Promise.resolve({ ok: false, error: 'Purchases are not allowed on this Mac (check Screen Time / parental controls).' });
    if (pending) return Promise.resolve({ ok: false, error: 'A purchase is already in progress.' });
    return new Promise((resolve) => {
      pending = { resolve };
      inAppPurchase.purchaseProduct(IAP_PRODUCT_ID, 1).then((started) => {
        if (!started) finish({ ok: false, error: 'This purchase is not available right now. Please try again later.' });
      }).catch((err) => finish({ ok: false, error: String(err && err.message || err) }));
      // Belt and braces: never leave the button spinning forever.
      setTimeout(() => pending && finish({ ok: false, error: 'The App Store did not answer. Please try again.' }), 5 * 60000);
    });
  }
  function restore() {
    if (pending) return Promise.resolve({ ok: false, error: 'A purchase is already in progress.' });
    return new Promise((resolve) => {
      pending = { resolve };
      inAppPurchase.restoreCompletedTransactions();
      setTimeout(() => pending && finish({ ok: false, error: 'No previous purchase of Gigapolis Pro was found for this Apple Account.' }), 30000);
    });
  }
  return { purchase, restore, price, productId: IAP_PRODUCT_ID };
}

module.exports = { createBookmarks, createStore };

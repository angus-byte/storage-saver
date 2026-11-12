// Gigapolis Pro settings. Pro is sold with Stripe through getgigapolis.com/buy,
// and licence keys are issued and checked by the site's Cloudflare functions
// (functions/api/licence). Environment variables override these, which is
// handy for testing a build against a preview deployment.
const GB = 1024 ** 3;

module.exports = {
  // Checkout page opened by "Buy Pro".
  checkoutUrl: process.env.GIGAPOLIS_CHECKOUT_URL || 'https://getgigapolis.com/buy?ref=app',
  // Licence server: activate / validate / deactivate.
  licenceApi: process.env.GIGAPOLIS_LICENCE_API || 'https://getgigapolis.com/api/licence/',
  // Only keys the server reports as Gigapolis Pro unlock Pro.
  storeId: 'gigapolis',
  productId: 'pro',
  priceLabel: '$19.99',
  // Angus's private owner key unlocks Pro without a purchase. Only its salted
  // scrypt hash is stored here; the key itself is never committed.
  ownerKey: { salt: '25d4942e3e4c3bac342b36907a1785e2', hash: '84afab7285f18fa29bcd00db81b7bf9a152dba54aa7d868ddfdd4325c2e0fc34' },
  // Free plan: bytes that may be demolished (moved to Trash) each calendar
  // month; resets on the 1st. Emptying the Trash itself is never counted.
  freeCapBytes: 20 * GB,
  // Re-check a Pro licence online this often, and keep Pro working offline
  // for this long after the last successful check. A refunded key locks Pro
  // at the next online check, or after the grace period if kept offline.
  // Seats per key (3) are set on the server (ACTIVATION_LIMIT), not here.
  revalidateMs: 1 * 86400000,
  offlineGraceMs: 14 * 86400000,
  weeklyMs: 7 * 86400000,
};

// Gigapolis Pro settings. Fill these in from the Lemon Squeezy dashboard
// (Store → Settings for the store id, Products → Gigapolis Pro for the
// product id and the checkout "Share" link). Environment variables override
// them, which is handy for testing a build without editing the file.
const GB = 1024 ** 3;

module.exports = {
  // Checkout page opened by "Buy Pro".
  checkoutUrl: process.env.GIGAPOLIS_CHECKOUT_URL || 'https://gigopolis.lemonsqueezy.com/checkout/buy/d9c533fc-fe6a-43c8-988f-f0b9bf46b9bc',
  // Only licence keys from this store + product unlock Pro.
  storeId: Number(process.env.GIGAPOLIS_STORE_ID) || 513897,
  productId: Number(process.env.GIGAPOLIS_PRODUCT_ID) || 1496849,
  priceLabel: '$19.99',
  // Free plan: total bytes that may be demolished (moved to Trash) over the
  // lifetime of the install. Emptying the Trash itself is never counted.
  freeCapBytes: 20 * GB,
  // Re-check a Pro licence online this often, and keep Pro working offline
  // for this long after the last successful check.
  revalidateMs: 3 * 86400000,
  offlineGraceMs: 30 * 86400000,
  weeklyMs: 7 * 86400000,
};

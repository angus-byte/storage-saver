// Gigapolis Pro settings. Fill these in from the Lemon Squeezy dashboard
// (Store → Settings for the store id, Products → Gigapolis Pro for the
// product id and the checkout "Share" link). Environment variables override
// them, which is handy for testing a build without editing the file.
const GB = 1024 ** 3;

module.exports = {
  // Checkout page opened by "Buy Pro". Placeholder until the product exists.
  checkoutUrl: process.env.GIGAPOLIS_CHECKOUT_URL || 'https://gigapolis.lemonsqueezy.com/buy/REPLACE_WITH_PRODUCT_LINK',
  // Only licence keys from this store + product unlock Pro. null = accept any
  // Lemon Squeezy key (development only, set both before shipping).
  storeId: Number(process.env.GIGAPOLIS_STORE_ID) || null,
  productId: Number(process.env.GIGAPOLIS_PRODUCT_ID) || null,
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

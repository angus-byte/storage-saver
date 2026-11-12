# Gigapolis website

Static site: `index.html`, `privacy.html`, `terms.html`, `404.html`, `img/`, plus `robots.txt`, `sitemap.xml` and `_headers` (Cloudflare Pages). No build step.

- Download buttons resolve the latest GitHub release's `-arm64.dmg` / `-x64.dmg` / `Setup-*.exe` at load time (falls back to the releases page). Windows visitors get the .exe as the main button. Requires the repo's releases to be public.
- Buy Pro links to `/buy` (`functions/buy.js`), which opens a Stripe Checkout page. After paying, buyers land on `/thanks`, which shows their licence key. The key is also printed on the Stripe invoice email.

## Hosting (Cloudflare Pages, recommended)

1. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → `angus-byte/storage-saver`.
2. Build command: none. Build output directory: `site`.
3. Custom domains → add `getgigapolis.com` and `www.getgigapolis.com`. If the domain is already on Cloudflare, DNS is set automatically; otherwise point the registrar's nameservers at Cloudflare first.
4. Selling Pro with Stripe (`functions/buy.js`, `functions/api/stripe-webhook.js`, `functions/api/licence/*`, `functions/api/refund.js`, shared code in `functions/_lib/licences.js`):
   - Stripe → Developers → API keys → copy the **Secret key**. Cloudflare Pages project → Settings → Variables and Secrets → add secret `STRIPE_SECRET_KEY`.
   - Stripe → Developers → Webhooks → Add endpoint `https://getgigapolis.com/api/stripe-webhook`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`. Copy its signing secret into Cloudflare as `STRIPE_WEBHOOK_SECRET`.
   - Stripe → Settings → Customer emails → turn on emails for successful payments (the invoice email carries the licence key).
   - Optional: `STRIPE_AUTOMATIC_TAX=1` once Stripe Tax is set up; `STRIPE_PRICE_ID` to sell a price made in Stripe instead of the built-in US$19.99; `ACTIVATION_LIMIT` (default 3).
   - Licence keys and activations live in the same D1 database as stats (`STATS_DB`), or a separate one bound as `LICENCE_DB`. Tables are created on first use.
   - Redeploy. Test with `sk_test_…` keys and card 4242 4242 4242 4242 first; a 100%-off promotion code works for a free live test.
   - Refunds (`refund.html` → `/api/refund`): checks email + key match, under 30 days, refunds in full through Stripe and switches the key off.
5. Stats (`/stats.html`, `functions/api/track.js` + `stats.js`): Workers & Pages → D1 → create database `gigapolis-stats`; Pages project → Settings → Bindings → add D1 binding `STATS_DB` → that database; Settings → Variables and Secrets → add secret `STATS_KEY` (any long random string); redeploy. Open `getgigapolis.com/stats#k=<STATS_KEY>` once (the key is then remembered in that browser). Shows visits and download clicks by source/platform/country (cookieless daily totals, bots filtered), GitHub release download counts, and Pro sales/refunds (from the licence table). Tag listing links with `?ref=<site>` to see which listing sends downloads.
6. `hello@getgigapolis.com` (used on the site): Cloudflare → Email → Email Routing → forward to your inbox.

GitHub Pages alternative: Settings → Pages → deploy from a GitHub Actions workflow that uploads `site/`.

# Gigapolis website

Static site: `index.html`, `privacy.html`, `terms.html`, `404.html`, `img/`, plus `robots.txt`, `sitemap.xml` and `_headers` (Cloudflare Pages). No build step.

- Download buttons resolve the latest GitHub release's `-arm64.dmg` / `-x64.dmg` / `Setup-*.exe` at load time (falls back to the releases page). Windows visitors get the .exe as the main button. Requires the repo's releases to be public.
- Buy Pro links to the Lemon Squeezy checkout (same URL as `src/main/config.js`).

## Hosting (Cloudflare Pages, recommended)

1. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → `angus-byte/storage-saver`.
2. Build command: none. Build output directory: `site`.
3. Custom domains → add `getgigapolis.com` and `www.getgigapolis.com`. If the domain is already on Cloudflare, DNS is set automatically; otherwise point the registrar's nameservers at Cloudflare first.
4. Refunds: Pages project → Settings → Variables and Secrets → add secret `LEMONSQUEEZY_API_KEY` (Lemon Squeezy → Settings → API → new key), then redeploy. Powers `refund.html` → `/api/refund` (`functions/api/refund.js` at repo root): checks email + key match the order, under 30 days, then refunds in full and disables the key.
5. Stats (`/stats.html`, `functions/api/track.js` + `stats.js`): Workers & Pages → D1 → create database `gigapolis-stats`; Pages project → Settings → Bindings → add D1 binding `STATS_DB` → that database; Settings → Variables and Secrets → add secret `STATS_KEY` (any long random string); redeploy. Open `getgigapolis.com/stats#k=<STATS_KEY>` once (the key is then remembered in that browser). Shows visits and download clicks by source/platform/country (cookieless daily totals, bots filtered), GitHub release download counts, and Lemon Squeezy sales/refunds (read-only, uses `LEMONSQUEEZY_API_KEY`). Tag listing links with `?ref=<site>` to see which listing sends downloads.
6. `hello@getgigapolis.com` (used on the site): Cloudflare → Email → Email Routing → forward to your inbox.

GitHub Pages alternative: Settings → Pages → deploy from a GitHub Actions workflow that uploads `site/`.

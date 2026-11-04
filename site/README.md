# Gigapolis website

Static single page (`index.html` + `img/`). No build step.

- Download buttons resolve the latest GitHub release's `-arm64.dmg` / `-x64.dmg` at load time (falls back to the releases page). Requires the repo's releases to be public.
- Buy Pro links to the Lemon Squeezy checkout (same URL as `src/main/config.js`).

## Hosting (Cloudflare Pages, recommended)

1. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → `angus-byte/storage-saver`.
2. Build command: none. Build output directory: `site`.
3. Custom domains → add `getgigapolis.com` (and `www`).

GitHub Pages alternative: Settings → Pages → deploy from a GitHub Actions workflow that uploads `site/`.

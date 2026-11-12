// Cloudflare Pages Function: GET /api/stats  (used by /stats.html)
// One place for: website visits + download clicks (D1), GitHub release downloads, Pro sales/refunds (Stripe orders in the licence table).
// Protected by the STATS_KEY secret (sent as "Authorization: Bearer <key>"). Read-only: it never changes anything.

import { ensureTable } from './track.js';
import { dbOf, ensureTables } from '../_lib/licences.js';

const DAYS = 30;

export function sameKey(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function platformOf(name) {
  if (/-arm64\.dmg$/i.test(name)) return 'mac-arm';
  if (/-x64\.dmg$/i.test(name)) return 'mac-intel';
  if (/\.exe$/i.test(name)) return 'win';
  return null; // zips, blockmaps, latest*.yml (auto-update files) are not counted as downloads
}

async function siteStats(db, now) {
  if (!db) return { enabled: false };
  await ensureTable(db);
  const since = new Date(now - (DAYS - 1) * 864e5).toISOString().slice(0, 10);
  const { results } = await db
    .prepare('SELECT day, kind, platform, source, country, SUM(n) AS n FROM counts WHERE day >= ? GROUP BY day, kind, platform, source, country')
    .bind(since)
    .all();
  const all = await db.prepare('SELECT kind, SUM(n) AS n FROM counts GROUP BY kind').all();
  const totals = {};
  for (const r of all.results || []) totals[r.kind] = r.n;
  return { enabled: true, since, rows: results || [], totals };
}

async function githubStats(fetchImpl) {
  const res = await fetchImpl('https://api.github.com/repos/angus-byte/storage-saver/releases?per_page=100', {
    headers: { 'User-Agent': 'gigapolis-stats', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return { error: `GitHub ${res.status}` };
  const releases = await res.json();
  const byPlatform = { 'mac-arm': 0, 'mac-intel': 0, win: 0 };
  const list = [];
  for (const rel of releases) {
    const row = { tag: rel.tag_name, date: (rel.published_at || '').slice(0, 10), 'mac-arm': 0, 'mac-intel': 0, win: 0 };
    for (const a of rel.assets || []) {
      const p = platformOf(a.name);
      if (p) { row[p] += a.download_count; byPlatform[p] += a.download_count; }
    }
    list.push(row);
  }
  return { byPlatform, total: byPlatform['mac-arm'] + byPlatform['mac-intel'] + byPlatform.win, releases: list.slice(0, 10) };
}

async function salesStats(db, now) {
  if (!db) return { enabled: false };
  await ensureTables(db);
  const { results } = await db.prepare('SELECT amount, created_at, refunded_at, live FROM licences').all();
  const orders = results || [];
  const since = now - DAYS * 864e5;
  const sum = (list) => {
    const out = { orders: 0, refunds: 0, gross: 0, refunded: 0 };
    for (const o of list) {
      out.orders++;
      out.gross += o.amount || 0;
      if (o.refunded_at) {
        out.refunds++;
        out.refunded += o.amount || 0;
      }
    }
    out.net = out.gross - out.refunded; // cents, before Stripe fees and tax
    return out;
  };
  const days = {};
  for (const o of orders) {
    if (o.created_at >= since) {
      const d = new Date(o.created_at).toISOString().slice(0, 10);
      days[d] = (days[d] || 0) + 1;
    }
  }
  return {
    enabled: true,
    testMode: orders.length > 0 && orders.every((o) => !o.live),
    allTime: sum(orders),
    last30: sum(orders.filter((o) => o.created_at >= since)),
    perDay: days,
  };
}

export async function handleStats(request, env, fetchImpl = fetch, now = Date.now()) {
  const auth = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env || !env.STATS_KEY) return { status: 500, body: { error: 'Add a STATS_KEY secret in Cloudflare Pages first.' } };
  if (!sameKey(auth, env.STATS_KEY)) return { status: 401, body: { error: 'Wrong key.' } };
  const safe = (p) => p.catch((e) => ({ error: String((e && e.message) || e) }));
  const [site, downloads, sales] = await Promise.all([
    safe(siteStats(env.STATS_DB, now)),
    safe(githubStats(fetchImpl)),
    safe(salesStats(dbOf(env), now)),
  ]);
  return { status: 200, body: { generated: new Date(now).toISOString(), days: DAYS, site, downloads, sales } };
}

export async function onRequestGet({ request, env }) {
  const out = await handleStats(request, env);
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' },
  });
}

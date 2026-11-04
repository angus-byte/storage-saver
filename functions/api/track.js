// Cloudflare Pages Function: POST /api/track
// Cookieless, bot-filtered counters for the website: visits and download clicks.
// Stores only daily totals (day, kind, platform, source, country). No IPs, no IDs, no cookies.
// Needs a D1 database bound to the Pages project as STATS_DB (table is created on first use).

export const KINDS = ['visit', 'download'];
export const PLATFORMS = ['', 'mac-arm', 'mac-intel', 'win', 'releases'];
const BOT = /bot|crawl|spider|slurp|scrap|headless|lighthouse|pagespeed|preview|monitor|uptime|curl|wget|python|java\/|go-http|httpclient|okhttp|axios|node-fetch|phantom|puppeteer|playwright|selenium|facebookexternalhit|embedly|whatsapp|telegram|discord|slack/i;

export function isBot(ua) {
  return !ua || ua.length < 20 || BOT.test(ua);
}

export function cleanSource(s) {
  s = String(s || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  s = s.replace(/[^a-z0-9._-]/g, '').slice(0, 40);
  return s || 'direct';
}

let ready = null;
export function ensureTable(db) {
  if (!ready) {
    ready = db
      .prepare(
        'CREATE TABLE IF NOT EXISTS counts (day TEXT NOT NULL, kind TEXT NOT NULL, platform TEXT NOT NULL, source TEXT NOT NULL, country TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, kind, platform, source, country))'
      )
      .run()
      .catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export async function handleTrack(request, env, now = Date.now()) {
  const ua = request.headers.get('User-Agent') || '';
  const site = request.headers.get('Sec-Fetch-Site');
  const origin = request.headers.get('Origin');
  const host = new URL(request.url).host;
  if (isBot(ua)) return 'bot';
  if (site && site !== 'same-origin') return 'cross-site';
  if (origin && new URL(origin).host !== host) return 'cross-site';
  if (!env || !env.STATS_DB) return 'no-db';

  let body = {};
  try { body = JSON.parse(await request.text()); } catch {}
  const kind = KINDS.includes(body.k) ? body.k : null;
  if (!kind) return 'bad';
  const platform = kind === 'download' && PLATFORMS.includes(body.p) ? body.p : '';
  const source = cleanSource(body.s);
  const country = String((request.cf && request.cf.country) || '').replace(/[^A-Z]/g, '').slice(0, 2) || '??';
  const day = new Date(now).toISOString().slice(0, 10);

  await ensureTable(env.STATS_DB);
  await env.STATS_DB
    .prepare('INSERT INTO counts (day, kind, platform, source, country, n) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT (day, kind, platform, source, country) DO UPDATE SET n = n + 1')
    .bind(day, kind, platform, source, country)
    .run();
  return 'ok';
}

export async function onRequestPost({ request, env }) {
  try { await handleTrack(request, env); } catch {}
  return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
}

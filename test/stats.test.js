const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const load = (f) => import(pathToFileURL(path.join(__dirname, '../functions/api', f)).href);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
const NOW = Date.parse('2026-11-20T12:00:00Z');

// Minimal in-memory stand-in for a D1 database (only what track/stats use).
function fakeDB() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async run() {
          if (sql.startsWith('INSERT')) {
            const k = args.join('|');
            rows.set(k, (rows.get(k) || 0) + 1);
          }
          return {};
        },
        async all() {
          const list = [...rows].map(([k, n]) => { const [day, kind, platform, source, country] = k.split('|'); return { day, kind, platform, source, country, n }; });
          if (sql.includes('GROUP BY kind')) {
            const t = {};
            for (const r of list) t[r.kind] = (t[r.kind] || 0) + r.n;
            return { results: Object.entries(t).map(([kind, n]) => ({ kind, n })) };
          }
          return { results: list.filter((r) => r.day >= args[0]) };
        },
      };
      return stmt;
    },
  };
}

const req = (body, headers = {}) =>
  new Request('https://getgigapolis.com/api/track', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'User-Agent': UA, 'Sec-Fetch-Site': 'same-origin', 'Accept-Language': 'en-AU,en;q=0.9', ...headers },
  });

test('track counts visits and downloads as daily totals', async () => {
  const { handleTrack } = await load('track.js');
  const env = { STATS_DB: fakeDB() };
  assert.equal(await handleTrack(req({ k: 'visit', s: 'https://www.MacUpdate.com/app/123' }), env, NOW), 'ok');
  assert.equal(await handleTrack(req({ k: 'download', p: 'mac-arm', s: 'macupdate.com' }), env, NOW), 'ok');
  assert.equal(await handleTrack(req({ k: 'download', p: 'mac-arm', s: 'macupdate.com' }), env, NOW), 'ok');
  assert.deepEqual([...env.STATS_DB.rows], [
    ['2026-11-20|visit||macupdate.com|??', 1],
    ['2026-11-20|download|mac-arm|macupdate.com|??', 2],
  ]);
});

test('track ignores bots, other sites and junk', async () => {
  const { handleTrack } = await load('track.js');
  const env = { STATS_DB: fakeDB() };
  assert.equal(await handleTrack(req({ k: 'visit' }, { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' }), env, NOW), 'bot');
  assert.equal(await handleTrack(req({ k: 'visit' }, { 'User-Agent': 'Mozilla/5.0 HeadlessChrome/120.0 Safari/537.36' }), env, NOW), 'bot');
  const noLang = new Request('https://getgigapolis.com/api/track', { method: 'POST', body: JSON.stringify({ k: 'visit' }), headers: { 'User-Agent': UA } });
  assert.equal(await handleTrack(noLang, env, NOW), 'bot');
  assert.equal(await handleTrack(req({ k: 'visit' }, { 'Sec-Fetch-Site': 'cross-site' }), env, NOW), 'cross-site');
  assert.equal(await handleTrack(req({ k: 'visit' }, { Origin: 'https://evil.example' }), env, NOW), 'cross-site');
  assert.equal(await handleTrack(req({ k: 'hack' }), env, NOW), 'bad');
  assert.equal(env.STATS_DB.rows.size, 0);
  await handleTrack(req({ k: 'download', p: '<script>', s: '<b>x</b>' }), env, NOW);
  assert.deepEqual([...env.STATS_DB.rows.keys()], ['2026-11-20|download||bx|??']);
});

test('stats needs the key and sums everything read-only', async () => {
  const { handleStats, platformOf } = await load('stats.js');
  const { handleTrack } = await load('track.js');
  assert.equal(platformOf('Gigapolis-0.10.9-arm64.dmg'), 'mac-arm');
  assert.equal(platformOf('Gigapolis-0.10.9-arm64-mac.zip'), null);
  const db = fakeDB();
  await handleTrack(req({ k: 'visit', s: 'direct' }), { STATS_DB: db }, NOW);
  const calls = [];
  const f = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    const json = (b) => ({ ok: true, json: async () => b });
    if (url.includes('api.github.com')) return json([{ tag_name: 'v0.10.9', published_at: '2026-11-04T00:00:00Z', assets: [
      { name: 'Gigapolis-0.10.9-arm64.dmg', download_count: 10 }, { name: 'Gigapolis-0.10.9-x64.dmg', download_count: 3 },
      { name: 'Gigapolis-Setup-0.10.9.exe', download_count: 4 }, { name: 'latest-mac.yml', download_count: 999 }] }]);
    if (url.includes('lemonsqueezy.com/v1/orders')) return json({ data: [
      { attributes: { status: 'paid', total_usd: 1999, created_at: '2026-11-15T00:00:00Z', test_mode: true } },
      { attributes: { status: 'refunded', refunded: true, total_usd: 1999, refunded_amount_usd: 1999, created_at: '2026-11-16T00:00:00Z', test_mode: true } },
      { attributes: { status: 'paid', total_usd: 1999, created_at: '2026-09-01T00:00:00Z', test_mode: true } }], links: {} });
    throw new Error('unexpected ' + url);
  };
  const env = { STATS_KEY: 'secret-key', STATS_DB: db, LEMONSQUEEZY_API_KEY: 'k' };
  const r = (k) => new Request('https://getgigapolis.com/api/stats', { headers: { Authorization: 'Bearer ' + k } });
  assert.equal((await handleStats(r('nope'), env, f, NOW)).status, 401);
  assert.equal(calls.length, 0);
  const out = await handleStats(r('secret-key'), env, f, NOW);
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.downloads.byPlatform, { 'mac-arm': 10, 'mac-intel': 3, win: 4 });
  assert.equal(out.body.downloads.total, 17);
  assert.equal(out.body.site.rows.length, 1);
  assert.deepEqual(out.body.sales.last30, { orders: 2, refunds: 1, gross: 3998, refunded: 1999, net: 1999 });
  assert.equal(out.body.sales.allTime.orders, 3);
  assert.equal(out.body.sales.testMode, true);
  assert.ok(calls.every((c) => c.method === 'GET'));
});

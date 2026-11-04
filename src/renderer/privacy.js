// Privacy tab: browser caches, history, download history, cookies and site
// data for Safari (Mac), Chrome, Edge, Brave, Arc and Firefox.
// Free: caches (count towards the allowance). Pro: everything else.
// Limits and paths are worked out in the main process (src/main/browsers.js).
import { IS_WIN } from './platform.js';

const KINDS = [
  // key, label, what it is, default-selected, free
  ['cache', 'Cache', 'Copies of pages and images. Browsers rebuild it as you browse.', true, true],
  ['history', 'History', 'Sites you visited.', false, false],
  ['downloads', 'Download history', 'The list of downloads. Your downloaded files stay.', false, false],
  ['cookies', 'Cookies', 'Signs you out of websites.', false, false],
  ['siteData', 'Site data', 'Offline data and logins websites keep. May sign you out.', false, false],
];
const WARN = new Set(['cookies', 'siteData']);

const PRIVACY_CSS = `
#tab-privacy .note { display: flex; gap: 8px; padding: 9px 11px; border-radius: 12px; background: rgba(246,164,74,.16); color: var(--text); font-size: 12.5px; margin-bottom: 10px; line-height: 1.4; }
#tab-privacy .browser { background: var(--soft); border-radius: 14px; padding: 10px 12px; margin-bottom: 8px; }
#tab-privacy .browser h3 { display: flex; align-items: center; gap: 8px; margin: 0 0 6px; font-size: 13.5px; }
#tab-privacy .browser h3 .name { flex: 1; }
#tab-privacy .browser h3 .size { color: var(--muted); font-weight: 600; font-size: 12px; }
#tab-privacy .kind { display: flex; align-items: flex-start; gap: 8px; padding: 5px 0; font-size: 12.5px; cursor: pointer; }
#tab-privacy .kind input { margin-top: 2px; }
#tab-privacy .kind .what { flex: 1; min-width: 0; }
#tab-privacy .kind small { display: block; color: var(--muted); font-size: 11px; }
#tab-privacy .kind small.warn { color: var(--danger); }
#tab-privacy .kind .size { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
#tab-privacy .kind.locked { opacity: .75; }
#tab-privacy .kind.off { opacity: .45; cursor: default; }
#tab-privacy .tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 700; background: var(--soft-2); color: var(--muted); }
#tab-privacy .tag.warn { background: rgba(229,72,77,.14); color: var(--danger); }
#tab-privacy .row { display: flex; gap: 8px; margin-top: 8px; }
#tab-privacy .row button { flex: 1; padding: 7px 10px; font-size: 12.5px; }
#tab-privacy .go { background: var(--danger); color: #fff; font-weight: 600; }
#tab-privacy .confirm { font-size: 12px; color: var(--danger); margin-top: 8px; }
#tab-privacy .empty { color: var(--muted); font-size: 12.5px; padding: 6px 2px 10px; }
#tab-privacy .wide { width: 100%; margin-top: 4px; font-size: 12.5px; }
`;

export function mockBrowsers() {
  const MB = 1024 ** 2;
  return [
    { id: 'safari', name: 'Safari', running: false, needsAccess: false, profiles: 1, items: { cache: { size: 820 * MB }, history: { size: 38 * MB }, downloads: { size: 0.2 * MB }, cookies: { size: 3 * MB }, siteData: { size: 410 * MB } } },
    { id: 'chrome', name: 'Google Chrome', running: true, needsAccess: false, profiles: 2, historyIncludesDownloads: true, items: { cache: { size: 2.4 * 1024 * MB }, history: { size: 96 * MB }, downloads: { size: 0.4 * MB, count: 312 }, cookies: { size: 6 * MB }, siteData: { size: 1.1 * 1024 * MB } } },
    { id: 'firefox', name: 'Firefox', running: false, needsAccess: false, profiles: 1, items: { cache: { size: 540 * MB }, history: { size: 24 * MB, count: 18000 }, downloads: { size: 0.05 * MB, count: 41 }, cookies: { size: 2 * MB }, siteData: { size: 160 * MB } } },
  ];
}

export function initPrivacy({ api, fmt, esc, toast, pro, DEMO }) {
  const style = document.createElement('style');
  style.textContent = PRIVACY_CSS;
  document.head.appendChild(style);

  if (DEMO || !api.listBrowsers) {
    let mock = mockBrowsers();
    const demoPro = () => (pro.status() || {}).plan === 'pro';
    api = {
      ...api,
      listBrowsers: async () => ({ ok: true, browsers: mock }),
      clearBrowser: async (id, kinds) => {
        const b = mock.find((x) => x.id === id);
        if (kinds.some((k) => k !== 'cache') && !demoPro()) return { ok: false, error: 'pro' };
        if (b.running) return { ok: false, error: `Quit ${b.name} first, then try again.` };
        if (kinds.includes('cache')) {
          const res = await api.trash(['/demo/browser-cache/' + id]); // charges the demo allowance
          const cap = res.find((r) => r.error === 'cap');
          if (cap) return { ok: false, ...cap };
        }
        const freed = kinds.reduce((n, k) => n + ((b.items[k] && b.items[k].size) || 0), 0);
        for (const k of kinds) delete b.items[k];
        if (kinds.includes('history') && b.historyIncludesDownloads) delete b.items.downloads;
        mock = mock.map((x) => x);
        return { ok: true, freed };
      },
    };
  }

  const tabs = document.getElementById('tabs');
  const body = document.getElementById('panel-body');
  if (!tabs || !body) return {};
  const tabBtn = document.createElement('button');
  tabBtn.className = 'tab';
  tabBtn.dataset.tab = 'privacy';
  tabBtn.textContent = 'Privacy';
  tabs.appendChild(tabBtn);
  const page = document.createElement('section');
  page.id = 'tab-privacy';
  page.className = 'tab-page';
  page.hidden = true;
  page.innerHTML = `
    <div class="section-head"><span>🕵️ Browser privacy</span><span class="muted" id="priv-total"></span></div>
    <div class="note"><span>⚠️</span><span><b>Quit your browsers first.</b> Clearing <b>cookies</b> signs you out of websites.${IS_WIN ? '' : ' Safari needs Full Disk Access.'}</span></div>
    <div id="priv-list"><div class="empty">Open this tab to check your browsers…</div></div>
    <button class="ghost wide" id="priv-refresh">Check again</button>
    <p class="hint">Everything goes to the Trash, so you can put it back. History kept with bookmarks is cleaned in place, and a copy of the original goes to the Trash first.</p>`;
  body.appendChild(page);

  let data = null;
  let loading = false;
  const picked = new Map(); // browser id -> Set of kinds
  const isPro = () => pro.isPro && pro.isPro();
  page.querySelector('#priv-refresh').onclick = () => load();

  function render() {
    const el = page.querySelector('#priv-list');
    if (!data) {
      el.innerHTML = `<div class="empty">${loading ? 'Checking browsers…' : ''}</div>`;
      return;
    }
    const list = data.browsers || [];
    const total = list.reduce((n, b) => n + Object.values(b.items).reduce((m, i) => m + i.size, 0), 0);
    page.querySelector('#priv-total').textContent = list.length ? `· ${list.length} browser${list.length > 1 ? 's' : ''} · ${fmt(total)}` : '';
    el.innerHTML = list.length ? '' : `<div class="empty">${data.error ? esc(data.error) : 'No browsers found.'}</div>`;
    for (const b of list) {
      const card = document.createElement('div');
      card.className = 'browser';
      if (b.needsAccess) {
        card.innerHTML = `<h3><span class="name">${esc(b.name)}</span><span class="tag warn">needs access</span></h3>
          <div class="empty" style="padding-bottom:6px">macOS keeps Safari private. Turn on Full Disk Access for Gigapolis to see and clear its data.</div>
          <div class="row"><button class="ghost perm">Open System Settings</button></div>`;
        card.querySelector('.perm').onclick = () => api.openPermissions && api.openPermissions();
        el.appendChild(card);
        continue;
      }
      if (!picked.has(b.id)) picked.set(b.id, new Set(KINDS.filter(([k, , , def]) => def && b.items[k]).map(([k]) => k)));
      const sel = picked.get(b.id);
      const bTotal = Object.values(b.items).reduce((m, i) => m + i.size, 0);
      card.innerHTML = `<h3><span class="name">${esc(b.name)}</span>${b.running ? '<span class="tag warn">open: quit it first</span>' : ''}${b.profiles > 1 ? `<span class="tag">${b.profiles} profiles</span>` : ''}<span class="size">${fmt(bTotal)}</span></h3>`;
      for (const [k, label, what, , free] of KINDS) {
        const it = b.items[k];
        if (!it) continue;
        const locked = !free && !isPro();
        const viaHistory = k === 'downloads' && b.historyIncludesDownloads && sel.has('history');
        const row = document.createElement('label');
        row.className = 'kind' + (locked ? ' locked' : '') + (viaHistory ? ' off' : '');
        const count = it.count ? ` · ${it.count.toLocaleString()} ${k === 'downloads' ? 'downloads' : 'visits'}` : '';
        const note = viaHistory ? 'Cleared with History in this browser.' : what;
        row.innerHTML = `<input type="checkbox" ${sel.has(k) || viaHistory ? 'checked' : ''} ${viaHistory ? 'disabled' : ''}>
          <span class="what">${locked ? '🔒 ' : ''}${esc(label)}${esc(count)}<small class="${WARN.has(k) ? 'warn' : ''}">${esc(note)}</small></span>
          <span class="size">${fmt(it.size)}</span>`;
        const box = row.querySelector('input');
        box.onchange = () => {
          if (locked) {
            box.checked = false;
            return pro.showUpgrade('privacy');
          }
          if (box.checked) sel.add(k);
          else sel.delete(k);
          render();
        };
        card.appendChild(row);
      }
      const kinds = [...sel].filter((k) => b.items[k]);
      const size = kinds.reduce((n, k) => n + b.items[k].size, 0);
      const actions = document.createElement('div');
      actions.className = 'row';
      actions.innerHTML = `<button class="go" ${kinds.length ? '' : 'disabled'}>Clear selected${kinds.length ? ' · ' + fmt(size) : ''}</button>`;
      card.appendChild(actions);
      actions.querySelector('.go').onclick = () => {
        const signsOut = kinds.some((k) => WARN.has(k));
        const loses = kinds.includes('history');
        actions.innerHTML = `<button class="go yes">Yes, clear ${esc(b.name)}</button><button class="keep">Cancel</button>`;
        const msg = document.createElement('div');
        msg.className = 'confirm';
        msg.textContent = [b.running ? `Quit ${b.name} first.` : `Make sure ${b.name} is closed.`, signsOut ? 'You will be signed out of websites.' : '', loses ? 'Your history will be gone from this browser (and may sync back from other devices).' : ''].filter(Boolean).join(' ');
        card.appendChild(msg);
        actions.querySelector('.keep').onclick = () => render();
        actions.querySelector('.yes').onclick = async () => {
          actions.innerHTML = '<button disabled>Clearing…</button>';
          const r = await api.clearBrowser(b.id, kinds);
          if (!r.ok) {
            if (r.error === 'cap') pro.showUpgrade('cap', r);
            else if (r.error === 'pro') pro.showUpgrade('privacy');
            else {
              toast(r.error || 'Could not clear it');
              if (r.perm && api.openPermissions) setTimeout(() => api.openPermissions(), 1200);
            }
            if (r.results) await load();
            else render();
            return;
          }
          picked.delete(b.id);
          toast(`${b.name} cleared (${fmt(r.freed || size)}). Empty the Trash to reclaim the space.`);
          await load();
        };
      };
      el.appendChild(card);
    }
  }

  async function load() {
    if (loading) return;
    loading = true;
    render();
    data = await api.listBrowsers().catch((e) => ({ ok: false, browsers: [], error: String(e) }));
    loading = false;
    render();
  }

  tabBtn.addEventListener('click', () => {
    if (!data && !loading) load();
  });
  if (api.onPlan) api.onPlan(() => render());

  return { load, open: () => tabBtn.click() };
}

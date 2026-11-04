// City Hall tab: Moving Day (uninstall apps with all their files) and Rush
// Hour (things that start with the Mac, with Neighbourhood Watch flags).
// Limits are enforced in the main process (src/main/main.js); this only shows them.
import { IS_WIN } from './platform.js';

const CITYHALL_CSS = `
#tab-hall .chips { display: flex; gap: 6px; margin: 0 0 8px; }
#tab-hall .chip { padding: 4px 10px; border-radius: 999px; font-size: 12px; background: var(--soft); color: var(--muted); font-weight: 600; }
#tab-hall .chip.on { background: var(--accent); color: var(--accent-ink); }
#tab-hall .tenant summary .name, #tab-hall .commuter .name { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
#tab-hall .tenant summary { gap: 8px; }
#tab-hall .tenant .meta { font-size: 12px; color: var(--muted); margin-top: 6px; }
#tab-hall .tenant ul { max-height: 130px; }
#tab-hall .tenant .row { display: flex; gap: 8px; margin-top: 8px; }
#tab-hall .tenant .row button { flex: 1; padding: 7px 10px; font-size: 12.5px; }
#tab-hall .tenant .move { background: var(--danger); color: #fff; font-weight: 600; }
#tab-hall .tenant .move:hover:not(:disabled) { background: var(--danger); filter: brightness(1.08); }
#tab-hall .tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 700; background: var(--soft-2); color: var(--muted); white-space: nowrap; }
#tab-hall .tag.warn { background: rgba(229,72,77,.14); color: var(--danger); }
#tab-hall .tag.idle { background: rgba(246,164,74,.18); color: #c4741c; }
#tab-hall .commuter { display: flex; align-items: center; gap: 8px; padding: 8px 10px; background: var(--soft); border-radius: 12px; margin-bottom: 6px; font-size: 12.5px; }
#tab-hall .commuter .who { flex: 1; min-width: 0; display: flex; flex-direction: column; }
#tab-hall .commuter .who small { color: var(--muted); font-size: 11px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
#tab-hall .commuter .tags { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 3px; }
#tab-hall .commuter button { padding: 5px 10px; font-size: 12px; flex: none; }
#tab-hall .commuter.flagged { box-shadow: inset 3px 0 0 var(--danger); }
#tab-hall .empty { color: var(--muted); font-size: 12.5px; padding: 6px 2px 10px; }
#tab-hall .hall-gap { margin-top: 16px; }
#tab-hall .wide { width: 100%; margin-top: 4px; font-size: 12.5px; }
`;

const WATCH = {
  ghost: ['Ghost commuter', 'Starts a program that is no longer there', true],
  adware: ['Known adware', 'Name matches a known adware family', true],
  hidden: ['Hiding', 'Hidden file or runs from an odd place', true],
  unsigned: ['Unsigned', 'Program is not signed by a developer', false],
};

export function mockCityHall(home = '/Users/angus') {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  const DAY = 86400000;
  const now = Date.now();
  const app = (name, id, size, boxes, daysAgo) => {
    const files = boxes.map(([dir, s]) => ({ name: `${dir} › ${dir === 'Preferences' ? id + '.plist' : id}`, path: `${home}/Library/${dir}/${id}`, size: s }));
    const filesSize = files.reduce((n, f) => n + f.size, 0);
    return { name, path: `/Applications/${name}.app`, bundleId: id, version: '', size, files, filesSize, total: size + filesSize, lastUsed: now - daysAgo * DAY, unused: daysAgo > 180, appStore: false };
  };
  return {
    apps: [
      app('Final Cut Pro', 'com.apple.FinalCut', 0, [], 1), // filtered below (Apple)
      app('DaVinci Resolve', 'com.blackmagic-design.DaVinciResolve', 4.1 * GB, [['Application Support', 6.2 * GB], ['Caches', 900 * MB], ['Preferences', 40e3]], 12),
      app('Adobe Premiere Pro 2024', 'com.adobe.PremierePro.24', 3.8 * GB, [['Caches', 1.4 * GB], ['Preferences', 2e5]], 260),
      app('Avid Media Composer', 'com.avid.mediacomposer', 2.9 * GB, [['Application Support', 1.1 * GB], ['Saved Application State', 3e5]], 420),
      app('Steam', 'com.valvesoftware.steam', 600 * MB, [['Application Support', 38 * GB]], 200),
      app('Slack', 'com.tinyspeck.slackmacgap', 520 * MB, [['Containers', 1.3 * GB], ['Caches', 210 * MB]], 0),
      app('Zoom', 'us.zoom.xos', 310 * MB, [['Application Support', 90 * MB], ['Logs', 25 * MB]], 30),
    ].filter((a) => !/^com\.apple\./.test(a.bundleId)),
    startup: [
      { name: 'Mapsgalaxy Agent', label: 'com.mapsgalaxy.agent', path: `${home}/Library/LaunchAgents/com.mapsgalaxy.agent.plist`, program: `${home}/Library/Application Support/.mgx/mgx`, scope: 'you', running: true, flags: ['adware', 'hidden'], freeToRemove: true, canRemove: true },
      { name: 'Avid Updater', label: 'com.avid.updater', path: `${home}/Library/LaunchAgents/com.avid.updater.plist`, program: '/Applications/Avid Updater.app/Contents/MacOS/Avid Updater', scope: 'you', running: false, flags: ['ghost'], freeToRemove: true, canRemove: true },
      { name: 'Adobe GC Invoker Utility', label: 'com.adobe.GC.Invoker-1.0', path: '/Library/LaunchAgents/com.adobe.GC.Invoker-1.0.plist', program: '/Library/Application Support/Adobe/AdobeGCClient/AGCInvokerUtility', scope: 'all', running: true, flags: [], freeToRemove: false, canRemove: false },
      { name: 'Google Keystone Agent', label: 'com.google.keystone.agent', path: `${home}/Library/LaunchAgents/com.google.keystone.agent.plist`, program: `${home}/Library/Google/GoogleSoftwareUpdate/GoogleSoftwareUpdate.bundle/Contents/Resources/GoogleSoftwareUpdateAgent.app/Contents/MacOS/GoogleSoftwareUpdateAgent`, scope: 'you', running: true, flags: [], freeToRemove: false, canRemove: true },
      { name: 'Zoom Updater', label: 'us.zoom.updater', path: `${home}/Library/LaunchAgents/us.zoom.updater.plist`, program: '/Library/Application Support/zoom.us/ZoomUpdater', scope: 'you', running: false, flags: [], freeToRemove: false, canRemove: true },
    ],
  };
}

function ago(t) {
  if (!t) return 'never opened (or unknown)';
  const d = Math.floor((Date.now() - t) / 86400000);
  if (d < 1) return 'opened today';
  if (d < 30) return `opened ${d} day${d > 1 ? 's' : ''} ago`;
  const m = Math.floor(d / 30);
  if (m < 12) return `opened ${m} month${m > 1 ? 's' : ''} ago`;
  const y = Math.floor(m / 12);
  return `opened ${y} year${y > 1 ? 's' : ''} ago`;
}

export function initCityHall({ api, fmt, esc, toast, pro, DEMO }) {
  const style = document.createElement('style');
  style.textContent = CITYHALL_CSS;
  document.head.appendChild(style);

  // Demo: in-memory City Hall so the flow can be tried in a browser.
  if (DEMO || !api.listApps) {
    const mock = mockCityHall();
    const demoPro = () => (pro.status() || {}).plan === 'pro';
    api = {
      ...api,
      listApps: async () => ({ supported: true, apps: mock.apps }),
      uninstallApp: async (p) => {
        const a = mock.apps.find((x) => x.path === p);
        const res = await api.trash([p]); // charges the demo allowance
        const cap = res.find((r) => r.error === 'cap');
        if (cap) return { ok: false, ...cap };
        mock.apps = mock.apps.filter((x) => x !== a);
        return { ok: true, freed: a.total };
      },
      listStartup: async () => ({ supported: true, items: mock.startup }),
      removeStartup: async (p) => {
        const it = mock.startup.find((x) => x.path === p);
        if (!it.freeToRemove && !demoPro()) return { ok: false, error: 'pro' };
        mock.startup = mock.startup.filter((x) => x !== it);
        return { ok: true };
      },
      openLoginItems: async () => toast('Demo: would open System Settings › Login Items'),
    };
  }

  const tabs = document.getElementById('tabs');
  const body = document.getElementById('panel-body');
  if (!tabs || !body) return {};
  const tabBtn = document.createElement('button');
  tabBtn.className = 'tab';
  tabBtn.dataset.tab = 'hall';
  tabBtn.textContent = 'City Hall';
  tabs.appendChild(tabBtn);
  const page = document.createElement('section');
  page.id = 'tab-hall';
  page.className = 'tab-page';
  page.hidden = true;
  page.innerHTML = `
    <div class="section-head"><span>🚚 Moving Day</span><span class="muted" id="hall-apps-total"></span></div>
    <p class="hint" style="margin-top:0;margin-bottom:8px">${IS_WIN ? 'Every app is a business in the city. Moving one out runs its own uninstaller, then takes its boxes with it: settings and caches in AppData and ProgramData.' : 'Every app is a business in the city. Moving one out takes its boxes with it: support files, caches and settings in your Library.'}</p>
    <div class="chips"><button class="chip on" data-f="all">All apps</button><button class="chip" data-f="unused">Closed for 6+ months</button></div>
    <div id="hall-apps"><div class="empty">Open this tab to look round the city…</div></div>
    <div class="section-head hall-gap"><span>🚦 Rush Hour</span><span class="muted" id="hall-start-total"></span></div>
    <p class="hint" style="margin-top:0;margin-bottom:8px">Commuters that start every time your Mac does. <b>Neighbourhood Watch</b> flags ones that look wrong.</p>
    <div id="hall-start"></div>
    <button class="ghost wide" id="hall-login">${IS_WIN ? 'Open Startup apps (Windows Settings)' : 'Open at Login apps (System Settings)'}</button>
    <p class="hint">${IS_WIN ? 'Leftover files and startup shortcuts go to the Recycle Bin. Startup apps switched off here can be switched back on in Task Manager.' : 'Everything goes to the Trash, so you can put it back.'} Neighbourhood Watch is a quick check, not an antivirus.</p>`;
  body.appendChild(page);

  let apps = null;
  let startup = null;
  let filter = 'all';
  let loading = false;
  const isPro = () => pro.isPro && pro.isPro();

  page.querySelector('.chips').onclick = (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    filter = c.dataset.f;
    page.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
    renderApps();
  };
  page.querySelector('#hall-login').onclick = () => api.openLoginItems();

  function renderApps() {
    const el = page.querySelector('#hall-apps');
    if (!apps) {
      el.innerHTML = `<div class="empty">${loading ? 'Knocking on doors… (measuring apps)' : ''}</div>`;
      return;
    }
    if (!apps.supported) {
      el.innerHTML = '<div class="empty">Moving Day is for macOS and Windows.</div>';
      return;
    }
    const list = apps.apps.filter((a) => filter === 'all' || a.unused);
    page.querySelector('#hall-apps-total').textContent = `· ${apps.apps.length} apps · ${fmt(apps.apps.reduce((n, a) => n + a.total, 0))}`;
    el.innerHTML = list.length ? '' : `<div class="empty">${filter === 'unused' ? 'Every business has been open in the last 6 months.' : 'No apps found.'}</div>`;
    for (const a of list) {
      const det = document.createElement('details');
      det.className = 'group tenant';
      det.innerHTML = `<summary><span class="name">${esc(a.name)}</span>${a.unused ? '<span class="tag idle">closed 6+ mo</span>' : ''}<span class="size">${fmt(a.total)}</span></summary>
        <div class="meta">App ${fmt(a.size)} · ${a.files.length} box${a.files.length === 1 ? '' : 'es'} ${fmt(a.filesSize)} · ${esc(ago(a.lastUsed))}</div>
        ${a.files.length ? `<ul>${a.files.slice(0, 12).map((f) => `<li><span class="name" title="${esc(f.path)}">${esc(f.name)}</span><span class="size">${fmt(f.size)}</span></li>`).join('')}</ul>` : ''}
        <div class="row"><button class="move">🚚 Move out · ${fmt(a.total)}</button></div>`;
      const row = det.querySelector('.row');
      det.querySelector('.move').onclick = () => {
        row.innerHTML = `<button class="move yes">Yes, move ${esc(a.name)} out</button><button class="keep">Keep it</button>`;
        row.querySelector('.keep').onclick = () => renderApps();
        row.querySelector('.yes').onclick = async () => {
          row.innerHTML = `<button disabled>${IS_WIN ? 'Follow the uninstaller window…' : 'Packing boxes…'}</button>`;
          const r = await api.uninstallApp(a.path);
          if (!r.ok) {
            if (r.error === 'cap') pro.showUpgrade('cap', r);
            else toast(r.error || 'Could not move it out');
            renderApps();
            return;
          }
          apps.apps = apps.apps.filter((x) => x !== a);
          toast(IS_WIN ? `${a.name} moved out (${fmt(r.freed || a.total)}). Leftovers are in the Recycle Bin.${r.note ? ' ' + r.note : ''}` : `${a.name} moved out (${fmt(r.freed || a.total)} to the Trash). Empty the Trash to reclaim the space.`);
          renderApps();
        };
      };
      el.appendChild(det);
    }
  }

  function renderStartup() {
    const el = page.querySelector('#hall-start');
    if (!startup) {
      el.innerHTML = loading ? '<div class="empty">Counting cars…</div>' : '';
      return;
    }
    if (!startup.supported) {
      el.innerHTML = '<div class="empty">Rush Hour is for macOS and Windows.</div>';
      return;
    }
    const flagged = startup.items.filter((i) => i.flags.some((f) => WATCH[f] && WATCH[f][2])).length;
    page.querySelector('#hall-start-total').textContent = `· ${startup.items.length}${flagged ? ` · ${flagged} flagged` : ''}`;
    el.innerHTML = startup.items.length ? '' : '<div class="empty">No commuters. Quiet streets.</div>';
    for (const it of startup.items) {
      const row = document.createElement('div');
      const warn = it.flags.some((f) => WATCH[f] && WATCH[f][2]);
      row.className = 'commuter' + (warn ? ' flagged' : '');
      const tags = [
        it.running ? '<span class="tag">running</span>' : '',
        it.scope !== 'you' ? '<span class="tag">all users</span>' : '',
        it.kind === 'task' ? '<span class="tag">scheduled task</span>' : '',
        ...it.flags.map((f) => (WATCH[f] ? `<span class="tag ${WATCH[f][2] ? 'warn' : ''}" title="${esc(WATCH[f][1])}">${WATCH[f][2] ? '🚨 ' : ''}${esc(WATCH[f][0])}</span>` : '')),
      ].join('');
      const action = !it.canRemove ? (it.reveal === '' ? '' : '<button class="ghost show" style="width:auto">Show</button>') : it.freeToRemove || isPro() ? '<button class="off">Switch off</button>' : '<button class="off locked" title="Gigapolis Pro">🔒 Switch off</button>';
      row.innerHTML = `<div class="who"><span class="name" title="${esc(it.label)}">${esc(it.name)}</span><small title="${esc(it.program || '')}">${esc(it.program || it.label)}</small>${tags ? `<div class="tags">${tags}</div>` : ''}</div>${action}`;
      const show = row.querySelector('.show');
      if (show) show.onclick = () => api.reveal(it.reveal || it.path);
      const off = row.querySelector('.off');
      if (off)
        off.onclick = async () => {
          if (off.classList.contains('locked')) return pro.showUpgrade('startup');
          off.disabled = true;
          const r = await api.removeStartup(it.path);
          if (!r.ok) {
            off.disabled = false;
            if (r.error === 'pro') return pro.showUpgrade('startup');
            return toast(r.error || 'Could not switch it off');
          }
          startup.items = startup.items.filter((x) => x !== it);
          toast(r.note || `${it.name} switched off. Its file is in the Trash if you want it back.`);
          renderStartup();
        };
      el.appendChild(row);
    }
  }

  async function load(fresh) {
    if (loading) return;
    loading = true;
    renderApps();
    renderStartup();
    const [a, s] = await Promise.all([api.listApps(fresh).catch(() => ({ supported: true, apps: [] })), api.listStartup().catch(() => ({ supported: true, items: [] }))]);
    apps = a;
    startup = s;
    loading = false;
    renderApps();
    renderStartup();
  }

  tabBtn.addEventListener('click', () => {
    if (!apps && !loading) load(false);
  });
  if (api.onPlan) api.onPlan(() => renderStartup());

  return { load, open: () => tabBtn.click() };
}

// Maintenance tab ("Public Works"): one-click housekeeping jobs (flush DNS,
// rebuild Spotlight / Launch Services, First Aid, maintenance scripts; on
// Windows: icon cache, Disk Cleanup, disk check, drive optimise, SFC).
// Free for everyone; nothing here deletes your files. The commands themselves
// live in the main process (src/main/maintenance.js): this page only sends ids.
import { IS_WIN } from './platform.js';

const MAINT_CSS = `
#tab-maint .job { display: flex; gap: 9px; align-items: flex-start; background: var(--soft); border-radius: 12px; padding: 9px 10px; margin-bottom: 6px; font-size: 12.5px; cursor: pointer; }
#tab-maint .job input { margin: 2px 0 0; flex: none; accent-color: var(--accent); }
#tab-maint .job .ico { font-size: 17px; line-height: 1.1; flex: none; width: 20px; text-align: center; }
#tab-maint .job .txt { flex: 1; min-width: 0; }
#tab-maint .job .ttl { font-weight: 650; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
#tab-maint .job .city { color: var(--muted); font-size: 11px; font-style: italic; }
#tab-maint .job .desc { color: var(--muted); font-size: 11.5px; margin-top: 2px; line-height: 1.35; }
#tab-maint .job .warn { color: var(--cache); font-size: 11.5px; margin-top: 3px; }
#tab-maint .job .meta { font-size: 11px; color: var(--muted); margin-top: 4px; }
#tab-maint .job .res { font-size: 11.5px; margin-top: 4px; font-weight: 600; }
#tab-maint .job .res.ok { color: var(--accent); }
#tab-maint .job .res.bad { color: var(--danger); }
#tab-maint .job .res.run { color: var(--muted); }
#tab-maint .tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 700; background: var(--soft-2); color: var(--muted); white-space: nowrap; }
#tab-maint .job.running { outline: 1.5px solid var(--accent); }
#tab-maint .job.running .ico { animation: mt-bob 1s ease-in-out infinite; }
@keyframes mt-bob { 50% { transform: translateY(-2px) rotate(-8deg); } }
#tab-maint .row { display: flex; gap: 6px; margin: 2px 0 8px; }
#tab-maint .row button { flex: 1; padding: 6px 8px; font-size: 12px; }
#tab-maint .go { width: 100%; margin-top: 4px; }
#tab-maint .empty { color: var(--muted); font-size: 12.5px; padding: 6px 2px 10px; }
`;

const mtAgo = (t) => {
  if (!t) return 'Never run';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 2) return 'Last run just now';
  if (m < 60) return `Last run ${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `Last run ${h} hour${h > 1 ? 's' : ''} ago`;
  const d = Math.round(h / 24);
  return `Last run ${d} day${d > 1 ? 's' : ''} ago`;
};

// Demo: the same jobs as the app, run with fake timings.
function createMockMaintenance(win) {
  const mac = [
    ['dns', '📞', 'Flush the DNS cache', 'Reset the phone exchange', 'Fixes websites that won’t load or still point to an old address.', null, true, true, true, 'DNS cache flushed.'],
    ['launch', '🗺', 'Rebuild Launch Services', 'Reprint the street directory', 'Fixes duplicate or missing apps in “Open With” menus, and wrong default apps.', null, false, false, true, '“Open With” menus rebuilt. Finder may take a minute to catch up.'],
    ['scripts', '🌙', 'Run maintenance scripts', 'Send out the night shift', 'Runs macOS’s daily, weekly and monthly clean-up of logs and temporary files.', null, true, false, true, 'Daily, weekly and monthly scripts finished.'],
    ['ram', '🧹', 'Free up memory', 'Clear the roads', 'Empties cached files out of memory. Handy before opening a big project.', null, true, true, false, 'Memory cache cleared.'],
    ['firstaid', '🩺', 'Check the disk (First Aid)', 'Building inspection', 'Checks your startup disk for errors. Your Mac may pause for a moment while it runs.', null, false, false, false, 'Your startup disk looks healthy.'],
    ['perms', '🔑', 'Repair home folder permissions', 'Re-key the front doors', 'Fixes “you don’t have permission” errors on your own files and folders.', null, true, false, false, 'Home folder permissions repaired.'],
    ['snapshots', '🕰', 'Clear Time Machine snapshots', 'Clear the archive basement', 'Removes the local snapshots Time Machine keeps on this Mac. Often frees many GB of “System Data”. Backups on your backup drive are not touched.', null, true, false, false, 'Local Time Machine snapshots cleared. The space shows as free within a minute or two.'],
    ['spotlight', '📚', 'Rebuild the Spotlight index', 'Re-catalogue the library', 'Fixes search that misses files or shows ones you deleted.', 'Search results stay incomplete while it rebuilds, which can take an hour.', true, false, false, 'Spotlight is re-indexing in the background. Searches fill back in over the next hour.'],
  ];
  const pc = [
    ['dns', '📞', 'Flush the DNS cache', 'Reset the phone exchange', 'Fixes websites that won’t load or still point to an old address.', null, false, true, true, 'DNS cache flushed.'],
    ['icons', '🖼', 'Reset the icon cache', 'Repaint the shop signs', 'Fixes blank, wrong or out-of-date icons on the desktop and in File Explorer.', null, false, false, true, 'Icons refreshed. Any that are still wrong are fixed after your next restart.'],
    ['cleanup', '🧽', 'Open Disk Cleanup', 'Call the street sweepers', 'Opens Windows Disk Cleanup for your system drive, so you can pick what it clears.', null, false, false, false, 'Disk Cleanup is open in its own window.'],
    ['diskcheck', '🩺', 'Check the disk for errors', 'Building inspection', 'Scans drive C: for errors while you keep working.', null, true, false, false, 'Drive C: looks healthy.'],
    ['optimise', '⚙️', 'Optimise the drive', 'Resurface the roads', 'Trims an SSD or defragments a hard drive, so it stays quick.', null, true, false, false, 'Drive C: optimised.'],
    ['sfc', '🛡', 'Repair system files', 'Check the foundations', 'Finds and replaces damaged Windows files (System File Checker).', 'Takes 10 to 30 minutes.', true, false, false, 'System files checked. Anything damaged was repaired.'],
  ];
  const tasks = (win ? pc : mac).map(([id, icon, name, city, desc, warn, admin, quick, recommended, ok]) => ({ id, icon, name, city, desc, warn, admin, quick, recommended, ok }));
  const lastRun = { firstaid: Date.now() - 12 * 86400000, dns: Date.now() - 3 * 3600000 };
  return {
    list: async () => ({ platform: win ? 'win32' : 'darwin', tasks: tasks.map(({ ok, ...t }) => t), lastRun: { ...lastRun }, demo: true }),
    run: async (ids) => {
      const chosen = tasks.filter((t) => ids.includes(t.id));
      await new Promise((r) => setTimeout(r, 900 + chosen.length * 500));
      const now = Date.now();
      for (const t of chosen) lastRun[t.id] = now;
      return { ok: true, results: chosen.map((t) => ({ id: t.id, ok: true, message: t.ok })), lastRun: { ...lastRun } };
    },
  };
}

export function initMaintenance({ api, esc, toast, DEMO }) {
  const style = document.createElement('style');
  style.textContent = MAINT_CSS;
  document.head.appendChild(style);

  const svc = DEMO || !api.maintList ? createMockMaintenance(IS_WIN) : { list: api.maintList, run: api.maintRun };

  const tabs = document.getElementById('tabs');
  const body = document.getElementById('panel-body');
  if (!tabs || !body) return {};
  const tabBtn = document.createElement('button');
  tabBtn.className = 'tab';
  tabBtn.dataset.tab = 'maint';
  tabBtn.textContent = 'Maintenance';
  tabs.appendChild(tabBtn);
  const page = document.createElement('section');
  page.id = 'tab-maint';
  page.className = 'tab-page';
  page.hidden = true;
  page.innerHTML = `
    <div class="section-head"><span>🚧 Public Works</span><span class="muted" id="mt-count"></span></div>
    <div class="row"><button class="ghost" id="mt-rec">Recommended</button><button class="ghost" id="mt-all">All</button><button class="ghost" id="mt-none">None</button></div>
    <div id="mt-list"><div class="empty">Loading the work orders…</div></div>
    <button class="primary go" id="mt-go" disabled>Run selected</button>
    <p class="hint" id="mt-hint"></p>`;
  body.appendChild(page);

  let data = null;
  let running = false;
  const picked = new Set();
  const results = new Map(); // id -> { ok, message } from the last run
  const $ = (s) => page.querySelector(s);

  function setPicked(fn) {
    if (running || !data) return;
    picked.clear();
    for (const t of data.tasks) if (fn(t)) picked.add(t.id);
    render();
  }
  $('#mt-rec').onclick = () => setPicked((t) => t.recommended);
  $('#mt-all').onclick = () => setPicked(() => true);
  $('#mt-none').onclick = () => setPicked(() => false);

  function render() {
    const el = $('#mt-list');
    if (!data) return;
    el.innerHTML = data.tasks.length ? '' : '<div class="empty">No maintenance jobs for this computer.</div>';
    for (const t of data.tasks) {
      const row = document.createElement('label');
      row.className = 'job' + (running && picked.has(t.id) ? ' running' : '');
      const r = results.get(t.id);
      const res = running && picked.has(t.id) ? '<div class="res run">Working on it…</div>' : r ? `<div class="res ${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓' : '✕'} ${esc(r.message)}</div>` : '';
      row.innerHTML = `<input type="checkbox" ${picked.has(t.id) ? 'checked' : ''} ${running ? 'disabled' : ''} /><span class="ico">${t.icon}</span><div class="txt">
        <div class="ttl">${esc(t.name)}${t.admin ? `<span class="tag" title="${IS_WIN ? 'Windows asks for permission' : 'macOS asks for your password'}">🔒 ${IS_WIN ? 'admin' : 'password'}</span>` : ''}${t.opens ? '<span class="tag">opens a window</span>' : ''}</div>
        <div class="city">${esc(t.city)}</div>
        <div class="desc">${esc(t.desc)}</div>
        ${t.warn ? `<div class="warn">⚠️ ${esc(t.warn)}</div>` : ''}
        <div class="meta">${esc(mtAgo(data.lastRun && data.lastRun[t.id]))}</div>${res}</div>`;
      row.querySelector('input').onchange = (e) => {
        e.target.checked ? picked.add(t.id) : picked.delete(t.id);
        renderFoot();
      };
      el.appendChild(row);
    }
    renderFoot();
  }

  function renderFoot() {
    const chosen = data ? data.tasks.filter((t) => picked.has(t.id)) : [];
    const go = $('#mt-go');
    go.disabled = running || !chosen.length;
    go.textContent = running ? 'Crews at work…' : chosen.length ? `Run ${chosen.length} job${chosen.length > 1 ? 's' : ''}` : 'Run selected';
    $('#mt-count').textContent = data ? `· ${data.tasks.length} jobs` : '';
    const admin = chosen.some((t) => t.admin);
    $('#mt-hint').textContent = admin
      ? IS_WIN
        ? 'Jobs marked admin run together after one Windows permission prompt. Nothing here deletes your files.'
        : 'Jobs marked password run together after you type your Mac password once. Nothing here deletes your files.'
      : 'Nothing here deletes your files. These jobs tidy up the system so it runs smoothly.';
  }

  $('#mt-go').onclick = async () => {
    if (running || !picked.size) return;
    running = true;
    for (const id of picked) results.delete(id);
    render();
    let r;
    try {
      r = await svc.run([...picked]);
    } catch (err) {
      r = { ok: false, error: String((err && err.message) || err) };
    }
    running = false;
    if (r.lastRun) data.lastRun = r.lastRun;
    for (const x of r.results || []) results.set(x.id, x);
    render();
    const n = (r.results || []).filter((x) => x.ok).length;
    if (r.error) toast(r.error);
    else if ((r.results || []).some((x) => x.cancelled)) toast('Cancelled. Nothing that needs a password was run.');
    else toast(r.ok ? `All done. ${n} job${n === 1 ? '' : 's'} finished.${DEMO ? ' (demo)' : ''}` : `${n} of ${r.results.length} jobs finished. See the notes below each one.`);
  };

  let only = null; // ids to tick when opened from elsewhere (e.g. the System building)
  async function load() {
    try {
      data = await svc.list();
      if (only) for (const t of data.tasks) if (only.includes(t.id)) picked.add(t.id);
      if (!picked.size) for (const t of data.tasks) if (t.recommended) picked.add(t.id);
    } catch {
      data = { tasks: [], lastRun: {} };
    }
    render();
  }
  // Load when first opened.
  let loaded = false;
  new MutationObserver(() => {
    if (!page.hidden && !loaded) (loaded = true), load();
  }).observe(page, { attributes: true, attributeFilter: ['hidden'] });

  // open(['snapshots']): show the tab with just those jobs ticked.
  function open(ids) {
    if (ids && !running) {
      only = ids;
      picked.clear();
      if (data) {
        for (const t of data.tasks) if (ids.includes(t.id)) picked.add(t.id);
        render();
      }
    }
    tabBtn.click();
  }
  return { open, reload: load };
}

// Gigapolis free / Pro plan in the UI: plan chip, Deep Clean groups,
// upgrade + licence screen. The real limits are enforced in the main
// process (src/main/licence.js); this file only shows them.

const PGB = 1024 ** 3;

export const DEEP_GROUPS = [
  ['renderCaches', 'Video render caches', 'Final Cut, Premiere and Resolve rebuild these when needed.', 'empty'],
  ['duplicates', 'Duplicate files', 'Exact copies (checked byte for byte before removing). The oldest copy is kept.', 'dup'],
  ['appLeftovers', 'App leftovers', 'Support files of apps that are no longer installed. Check before removing.', 'trash'],
  ['iosBackups', 'Old iPhone & iPad backups', 'Not updated for 30+ days.', 'trash'],
  ['devJunk', 'Developer junk', 'Build caches and node_modules of idle projects.', 'trash'],
  ['logsInstallers', 'Logs & leftover installers', 'Old logs and .dmg / .pkg files outside Downloads.', 'trash'],
  ['mailAttachments', 'Mail attachments', 'Copies Mail saved when you opened attachments. They stay in the emails.', 'empty'],
];

// ---------------------------------------------------------------------------
// Browser demo: an in-memory plan so the whole flow can be tried without the
// app. Licence key "DEMO-PRO" unlocks Pro.
// ---------------------------------------------------------------------------
export function demoPlanApi(sizeOf) {
  let st = { plan: 'free', capBytes: 20 * PGB, usedBytes: 0, remainingBytes: 20 * PGB, email: null, keyHint: null, weekly: { enabled: true, lastRun: 0 }, priceLabel: '$19.99' };
  const subs = [];
  const emit = () => subs.forEach((cb) => cb({ ...st }));
  const charge = (paths) => {
    const bytes = paths.reduce((n, p) => n + (/\/\.Trash(\/|$)/.test(p) ? 0 : sizeOf(p)), 0);
    if (st.plan === 'free' && bytes > st.remainingBytes) return { ok: false, error: 'cap', needBytes: bytes, remainingBytes: st.remainingBytes, capBytes: st.capBytes };
    if (st.plan === 'free') {
      st.usedBytes += bytes;
      st.remainingBytes = Math.max(0, st.capBytes - st.usedBytes);
      emit();
    }
    return null;
  };
  return {
    trash: async (paths) => {
      const blocked = charge(paths);
      return paths.map((path) => (blocked ? { path, ...blocked } : { path, ok: true }));
    },
    emptyFolder: async (dir) => {
      const blocked = charge([dir]);
      return [blocked ? { path: dir, ...blocked } : { path: dir, ok: true }];
    },
    trashDuplicate: async (path) => [{ path, ok: st.plan === 'pro' }],
    planStatus: async () => ({ ...st }),
    onPlan: (cb) => subs.push(cb),
    openCheckout: async () => true,
    activateLicence: async (key) => {
      if (String(key).trim().toUpperCase() !== 'DEMO-PRO') return { ok: false, error: 'Demo: use the key DEMO-PRO' };
      st = { ...st, plan: 'pro', capBytes: null, remainingBytes: null, email: 'you@example.com', keyHint: '…MO-PRO' };
      emit();
      return { ok: true, status: { ...st } };
    },
    deactivateLicence: async () => {
      st = { ...st, plan: 'free', capBytes: 20 * PGB, remainingBytes: Math.max(0, 20 * PGB - st.usedBytes), email: null, keyHint: null };
      emit();
      return { ok: true, status: { ...st } };
    },
    setWeekly: async (on) => {
      st.weekly = { ...st.weekly, enabled: !!on };
      emit();
      return { ...st };
    },
    deepScan: async () => null, // filled from mock data by app.js in demo mode
  };
}

export function mockDeep(home = '/Users/angus') {
  const DAY = 86400000;
  const now = Date.now();
  const it = (name, rel, size, extra = {}) => ({ name, path: `${home}/${rel}`, size: size * PGB, kind: 'cache', mtime: now - 120 * DAY, isDir: true, ...extra });
  const g = (items) => ({ items, total: items.reduce((s, i) => s + i.size, 0) });
  return {
    renderCaches: g([
      it('Summer Doc 2025 › Render Files', 'Movies/Summer Doc.fcpbundle/Summer Doc/Render Files', 38.4, { mode: 'empty' }),
      it('Common › Media Cache Files', 'Library/Application Support/Adobe/Common/Media Cache Files', 21.7, { mode: 'empty' }),
      it('Resolve › CacheClip', 'Movies/Resolve/CacheClip', 9.2, { mode: 'empty' }),
    ]),
    duplicates: g([
      it('Interview_cam_B copy.mov', 'Desktop/Interview_cam_B copy.mov', 22, { isDir: false, kind: 'media', keep: `${home}/Movies/Projects/Summer Doc 2025/Interview_cam_B.mov`, note: 'Copy of Interview_cam_B.mov' }),
      it('Showreel_final_v3.mp4', 'Downloads/Showreel_final_v3.mp4', 3.1, { isDir: false, kind: 'media', keep: `${home}/Movies/Showreel_final_v3.mp4` }),
    ]),
    appLeftovers: g([it('Avid', 'Library/Application Support/Avid', 4.6, { kind: 'apps', note: 'No matching app installed' })]),
    iosBackups: g([it('Angus’s old iPhone backup', 'Library/Application Support/MobileSync/Backup/00008030-001', 61.2, { kind: 'other' })]),
    devJunk: g([it('Xcode DerivedData', 'Library/Developer/Xcode/DerivedData', 7.8, { mode: 'empty' })]),
    logsInstallers: g([it('App logs', 'Library/Logs', 0.9, { mode: 'empty' }), it('DaVinci_Resolve_19.dmg', 'Desktop/DaVinci_Resolve_19.dmg', 3.4, { isDir: false, kind: 'downloads' })]),
    mailAttachments: g([it('Mail attachments', 'Library/Containers/com.apple.mail/Data/Library/Mail Downloads', 2.3, { kind: 'documents', mode: 'empty' })]),
  };
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------
const PRO_CSS = `
#plan-chip { display: flex; align-items: center; gap: 8px; width: 100%; margin-top: 10px; padding: 9px 12px; border-radius: 14px; background: var(--soft); border: 1px solid var(--border); color: var(--text); font-size: 12px; text-align: left; cursor: pointer; }
#plan-chip:hover { background: var(--soft-2); }
#plan-chip .meter { flex: 1; height: 5px; border-radius: 3px; background: var(--soft-2); overflow: hidden; }
#plan-chip .meter i { display: block; height: 100%; background: var(--accent); }
#plan-chip .go { color: var(--accent); font-weight: 700; white-space: nowrap; }
#plan-chip.pro { background: linear-gradient(90deg, rgba(246,164,74,.18), rgba(192,132,252,.18)); }
.pro-badge { display: inline-block; padding: 1px 7px; border-radius: 999px; background: linear-gradient(90deg,#f6a44a,#c084fc); color: #fff; font-size: 10px; font-weight: 800; letter-spacing: .5px; }
.deep-head { margin-top: 16px; }
.group.locked summary { cursor: pointer; }
.group.locked .peek { margin: 6px 0 0; padding: 0; list-style: none; font-size: 12px; color: var(--muted); }
.group.locked .peek li { display: flex; gap: 8px; padding: 2px 0; filter: blur(.4px); }
.group.locked .peek .name { flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.group li .note { color: var(--muted); font-size: 11px; }
#btn-deep-unlock { width: 100%; margin-top: 4px; }
#pro-modal .card { width: 460px; }
#pro-modal .price { font-size: 30px; font-weight: 800; letter-spacing: -.5px; margin: 4px 0 0; }
#pro-modal .price small { font-size: 13px; font-weight: 600; color: var(--muted); letter-spacing: 0; }
#pro-modal .why { background: rgba(229,72,77,.1); color: var(--text); border-radius: 12px; padding: 9px 12px; font-size: 13px; margin: 12px 0 0; }
#pro-modal ul.feat { list-style: none; padding: 0; margin: 14px 0; font-size: 13px; }
#pro-modal ul.feat li { padding: 4px 0; display: flex; justify-content: space-between; gap: 10px; }
#pro-modal ul.feat li b { white-space: nowrap; }
#pro-modal .found { color: var(--accent); font-weight: 700; }
#pro-modal .row { display: flex; gap: 8px; margin-top: 10px; }
#pro-modal .row .primary { flex: 1; padding: 12px 16px; }
#pro-modal input[type=text] { flex: 1; min-width: 0; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--border); background: var(--soft); color: var(--text); font: inherit; font-size: 13px; }
#pro-modal .err { color: var(--danger); font-size: 12px; min-height: 16px; margin: 6px 2px 0; }
#pro-modal .close { position: absolute; top: 14px; right: 16px; background: none; border: none; color: var(--muted); font-size: 20px; padding: 4px; }
#pro-modal .card { position: relative; }
#pro-modal label.switch { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 13px; padding: 10px 0; border-top: 1px solid var(--border); }
`;

export function initPro({ api, state, fmt, esc, toast, buildGroup, rerender, DEMO }) {
  let st = null;
  const style = document.createElement('style');
  style.textContent = PRO_CSS;
  document.head.appendChild(style);

  // Plan chip under the scan button.
  const chip = document.createElement('button');
  chip.id = 'plan-chip';
  chip.onclick = () => showUpgrade();
  const actions = document.querySelector('#panel .actions');
  if (actions) actions.after(chip);

  // "Go Pro" pill in the top-right HUD.
  const hudBtn = document.createElement('button');
  hudBtn.className = 'float';
  hudBtn.id = 'btn-pro';
  hudBtn.textContent = '★ Go Pro';
  hudBtn.onclick = () => showUpgrade();
  const hud = document.getElementById('hud');
  if (hud) hud.prepend(hudBtn);

  // Rename the free section to the plan's name.
  const head = document.querySelector('#tab-clean .section-head span');
  if (head) head.textContent = 'Street Sweep';

  // Modal shell.
  const modal = document.createElement('div');
  modal.id = 'pro-modal';
  modal.className = 'overlay';
  modal.hidden = true;
  modal.innerHTML = '<div class="card"></div>';
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.hidden = true;
  });
  document.body.appendChild(modal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.hidden) {
      modal.hidden = true;
      e.stopImmediatePropagation();
    }
  }, true);

  const isPro = () => st && st.plan === 'pro';

  function renderChip() {
    if (!st) return;
    chip.classList.toggle('pro', isPro());
    hudBtn.hidden = isPro();
    if (isPro()) {
      chip.innerHTML = `<span class="pro-badge">PRO</span><span style="flex:1">Unlimited Demolish · Deep Clean${st.weekly.enabled ? ' · weekly check-up on' : ''}</span><span class="go">Manage</span>`;
    } else {
      const usedPct = Math.min(100, (st.usedBytes / st.capBytes) * 100);
      chip.innerHTML = `<span><b>Free</b> · ${fmt(st.remainingBytes)} of ${fmt(st.capBytes)} left</span><span class="meter"><i style="width:${100 - usedPct}%"></i></span><span class="go">Go Pro</span>`;
    }
  }

  function deepTotal() {
    if (!state.deep) return 0;
    return Object.values(state.deep).reduce((n, g) => n + g.total, 0);
  }

  // Deep Clean section, appended under Street Sweep by renderClean().
  function renderDeep(wrap) {
    const head = document.createElement('div');
    head.className = 'section-head deep-head';
    if (!state.deep) {
      if (state.deepLoading) {
        head.innerHTML = `<span>Deep Clean <span class="pro-badge">PRO</span></span><span class="muted">looking deeper…</span>`;
        wrap.appendChild(head);
      }
      return;
    }
    const total = deepTotal();
    if (!total) return;
    head.innerHTML = `<span>Deep Clean <span class="pro-badge">PRO</span></span><span class="muted">· up to ${fmt(total)}</span>`;
    wrap.appendChild(head);
    for (const [key, title, desc, mode] of DEEP_GROUPS) {
      const g = state.deep[key];
      if (!g || !g.items.length) continue;
      if (isPro()) {
        wrap.appendChild(buildGroup(g, title, desc, mode, false));
        continue;
      }
      const det = document.createElement('details');
      det.className = 'group locked';
      det.innerHTML = `<summary><span>🔒 ${esc(title)}</span><span class="size">${fmt(g.total)}</span></summary><div class="hint">${esc(desc)}</div><ul class="peek">${g.items
        .slice(0, 3)
        .map((i) => `<li><span class="name">${esc(i.name)}</span><span>${fmt(i.size)}</span></li>`)
        .join('')}</ul>`;
      wrap.appendChild(det);
    }
    if (!isPro()) {
      const b = document.createElement('button');
      b.id = 'btn-deep-unlock';
      b.className = 'primary';
      b.textContent = `Unlock Deep Clean · ${st ? st.priceLabel : '$19.99'} once`;
      b.onclick = () => showUpgrade('deep');
      wrap.appendChild(b);
    }
  }

  async function loadDeep() {
    state.deep = null;
    state.deepLoading = true;
    rerender();
    try {
      state.deep = await api.deepScan();
    } catch {
      state.deep = null;
    }
    state.deepLoading = false;
    rerender();
  }

  function featureList() {
    const d = state.deep || {};
    const found = (k) => (d[k] && d[k].total ? `<span class="found">${fmt(d[k].total)} found</span>` : '');
    return `<ul class="feat">
      <li><span>🧨 Unlimited Demolish</span><b>${st && st.plan === 'free' ? `free: ${fmt(st.capBytes)}` : ''}</b></li>
      <li><span>🎬 Video render caches</span>${found('renderCaches')}</li>
      <li><span>👯 Duplicate files</span>${found('duplicates')}</li>
      <li><span>🏚️ App leftovers</span>${found('appLeftovers')}</li>
      <li><span>📱 Old iPhone backups</span>${found('iosBackups')}</li>
      <li><span>🛠️ Developer junk</span>${found('devJunk')}</li>
      <li><span>📎 Mail attachments</span>${found('mailAttachments')}</li>
      <li><span>🚦 Rush Hour: switch off any startup item</span></li>
      <li><span>🕵️ Browser privacy: history, cookies &amp; site data</span></li>
      <li><span>🧾 Logs &amp; old installers</span>${found('logsInstallers')}</li>
      <li><span>📅 Weekly check-up with alert</span></li>
      <li><span>🍂 Autumn &amp; ❄️ Winter cities</span></li>
    </ul>`;
  }

  function showUpgrade(reason, info) {
    const card = modal.querySelector('.card');
    if (isPro()) {
      card.innerHTML = `<button class="close" aria-label="Close">×</button>
        <span class="pro-badge">PRO</span><h2>Gigapolis Pro is on</h2>
        <p>Licence ${esc(st.keyHint || '')}${st.email ? ` · ${esc(st.email)}` : ''}${st.devPro ? ' · developer mode' : ''}</p>
        <label class="switch"><span><b>Weekly check-up</b><br><small class="muted">Rescans once a week in the background and alerts you when there is space to clear. Never deletes on its own.</small></span><input type="checkbox" id="pro-weekly" ${st.weekly.enabled ? 'checked' : ''}></label>
        <div class="row"><button class="link" id="pro-deact">Move licence to another Mac (deactivate here)</button></div>
        <div class="err" id="pro-err"></div>`;
      card.querySelector('#pro-weekly').onchange = async (e) => {
        st = await api.setWeekly(e.target.checked);
        renderChip();
      };
      card.querySelector('#pro-deact').onclick = async () => {
        const r = await api.deactivateLicence();
        if (r.status) st = r.status;
        modal.hidden = true;
        renderChip();
        rerender();
        toast('Licence released. This Mac is back on the free plan.');
      };
    } else {
      const why =
        reason === 'cap' && info
          ? `<div class="why">The free plan demolishes up to <b>${fmt(info.capBytes)}</b> in total. ${info.remainingBytes > 0 ? `You have ${fmt(info.remainingBytes)} left and this needs ${fmt(info.needBytes)}.` : 'You have used it all.'}</div>`
          : '';
      const more = deepTotal();
      card.innerHTML = `<button class="close" aria-label="Close">×</button>
        <span class="pro-badge">PRO</span><h2>Gigapolis Pro</h2>
        <div class="price">${esc(st ? st.priceLabel : '$19.99')} <small>once. No subscription. Yours forever.</small></div>
        ${why}
        ${more ? `<p style="margin-top:12px">Deep Clean found <b class="found">${fmt(more)}</b> more on this ${DEMO ? 'demo city' : 'Mac'}.</p>` : ''}
        ${featureList()}
        <div class="row"><button class="primary" id="pro-buy">Buy Pro · ${esc(st ? st.priceLabel : '$19.99')}</button></div>
        <p class="hint" style="margin-top:14px">Already bought it? Paste the licence key from your receipt email.</p>
        <div class="row"><input type="text" id="pro-key" placeholder="XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" spellcheck="false" autocomplete="off"><button class="ghost" id="pro-activate" style="width:auto;padding:0 14px">Activate</button></div>
        <div class="err" id="pro-err"></div>
        <p class="hint">Everything still goes to the Trash, so you can always get it back.${DEMO ? ' Demo: use the key DEMO-PRO.' : ''}</p>`;
      card.querySelector('#pro-buy').onclick = () => {
        api.openCheckout();
        if (DEMO) toast('Demo: would open the checkout page');
      };
      const doActivate = async () => {
        const btn = card.querySelector('#pro-activate');
        btn.disabled = true;
        btn.textContent = 'Checking…';
        let r;
        try {
          r = await api.activateLicence(card.querySelector('#pro-key').value);
        } catch (err) {
          r = { ok: false, error: 'Something went wrong checking the key: ' + (err && err.message ? err.message : err) };
        }
        btn.disabled = false;
        btn.textContent = 'Activate';
        if (!r.ok) {
          card.querySelector('#pro-err').textContent = r.error;
          return;
        }
        st = r.status;
        modal.hidden = true;
        renderChip();
        rerender();
        toast('Welcome to Gigapolis Pro. Deep Clean and unlimited Demolish are unlocked.');
      };
      card.querySelector('#pro-activate').onclick = doActivate;
      card.querySelector('#pro-key').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doActivate();
      });
    }
    card.querySelector('.close').onclick = () => (modal.hidden = true);
    modal.hidden = false;
  }

  /** Looks at trash results; shows the upgrade screen if the free cap stopped them. */
  function handleBlocked(results) {
    const capped = (results || []).find((r) => r && r.error === 'cap');
    if (capped) showUpgrade('cap', capped);
    return !!capped;
  }

  api.onPlan((s) => {
    const was = st && st.plan;
    st = s;
    renderChip();
    if (was && was !== s.plan) rerender();
  });
  api.planStatus().then((s) => {
    st = s;
    renderChip();
    rerender();
  });

  return { isPro, renderDeep, loadDeep, showUpgrade, handleBlocked, status: () => st };
}

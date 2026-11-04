// Photo Studio tab: duplicate photos ("Twins", byte-identical) and similar
// photos ("Lookalikes", perceptual hash). Each group suggests the best one to
// keep; click a photo to switch between Keep and Trash. The main process
// checks everything again (src/main/main.js photos:trash) and applies the
// free Demolish allowance; Pro is unlimited.

const PHOTOS_CSS = `
#tab-photos .ph-hero { display: flex; align-items: baseline; gap: 8px; margin: 2px 0 10px; }
#tab-photos .ph-big { font-size: 22px; font-weight: 800; }
#tab-photos .ph-group { background: var(--soft); border-radius: 14px; padding: 9px 10px; margin-bottom: 8px; }
#tab-photos .ph-head { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; margin-bottom: 7px; }
#tab-photos .ph-head .why { flex: 1; min-width: 0; color: var(--muted); font-weight: 500; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
#tab-photos .ph-head button { padding: 3px 9px; font-size: 11.5px; width: auto; flex: none; }
#tab-photos .ph-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(82px, 1fr)); gap: 6px; }
#tab-photos .ph-card { display: flex; flex-direction: column; align-items: stretch; gap: 0; height: auto; width: auto; position: relative; border-radius: 10px; overflow: hidden; background: var(--soft-2); cursor: pointer; border: 2px solid transparent; padding: 0; text-align: left; font: inherit; color: inherit; }
#tab-photos .ph-card .img { flex: none; width: 100%; aspect-ratio: 1; background: var(--soft-2) center / cover no-repeat; display: block; }
#tab-photos .ph-card .meta { padding: 3px 5px 4px; font-size: 10.5px; line-height: 1.25; }
#tab-photos .ph-card .meta .name { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
#tab-photos .ph-card .meta small { color: var(--muted); }
#tab-photos .ph-card .badge { position: absolute; top: 4px; left: 4px; padding: 1px 6px; border-radius: 999px; font-size: 10px; font-weight: 800; background: rgba(0,0,0,.55); color: #fff; }
#tab-photos .ph-card.keep { border-color: var(--accent); }
#tab-photos .ph-card.keep .badge { background: var(--accent); color: var(--accent-ink); }
#tab-photos .ph-card.bin { opacity: .62; }
#tab-photos .ph-card.bin .badge { background: var(--danger); }
#tab-photos .ph-card.bin .img { filter: grayscale(.7); }
#tab-photos .ph-card .show { position: absolute; top: 3px; right: 3px; width: 20px; height: 20px; border-radius: 6px; background: rgba(0,0,0,.45); color: #fff; font-size: 11px; display: grid; place-items: center; }
#tab-photos .empty { color: var(--muted); font-size: 12.5px; padding: 6px 2px 10px; }
#tab-photos .ph-gap { margin-top: 14px; }
#tab-photos .ph-more { width: 100%; font-size: 12px; margin-bottom: 8px; }
#tab-photos .ph-bar { padding-top: 4px; }
#tabs .tab { padding: 7px 5px; font-size: 12px; }
`;

const PAGE = 30; // groups shown per section before "Show more"

// Demo: a few made-up groups with drawn thumbnails.
export function mockPhotos(home = '/Users/angus') {
  const MB = 1024 ** 2;
  const art = (hue, shift = 0) =>
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,${62 + shift}%)"/><stop offset="1" stop-color="hsl(${hue + 40},60%,${38 + shift}%)"/></linearGradient></defs><rect width="80" height="80" fill="url(#g)"/><circle cx="${52 - shift}" cy="30" r="11" fill="hsl(${hue + 20},90%,85%)"/><path d="M0 62 L${24 + shift} 44 L46 58 L62 46 L80 60 V80 H0Z" fill="hsl(${hue + 180},30%,22%)"/></svg>`
    );
  const now = Date.now();
  const it = (dir, name, mb, w, h, days, thumb) => ({ path: `${home}/${dir}/${name}`, name, size: mb * MB, mtime: now - days * 86400000, width: w, height: h, thumb });
  const g = (kind, i, items, why) => ({ id: `${kind}-${i}`, kind, items, keep: items[0].path, why, saving: items.slice(1).reduce((n, x) => n + x.size, 0) });
  const exact = [
    g('exact', 0, [it('Pictures/2024 Iceland', 'DSC_4410.NEF', 48, 6048, 4024, 400, art(200)), it('Downloads', 'DSC_4410.NEF', 48, 6048, 4024, 30, art(200)), it('Desktop/Selects', 'DSC_4410 copy.NEF', 48, 6048, 4024, 12, art(200))], 'Already in a photo folder'),
    g('exact', 1, [it('Pictures/Shoots/Sommar', 'BTS_0192.jpg', 9.4, 5472, 3648, 220, art(20)), it('Documents/Pitch deck/images', 'BTS_0192.jpg', 9.4, 5472, 3648, 90, art(20))], 'Already in a photo folder'),
    g('exact', 2, [it('Pictures', 'poster-final.png', 14.2, 3000, 4500, 60, art(300)), it('Downloads', 'poster-final (1).png', 14.2, 3000, 4500, 58, art(300))], 'Already in a photo folder'),
  ];
  const similar = [
    g('similar', 0, [it('Pictures/2024 Iceland', 'IMG_2201.HEIC', 3.1, 4032, 3024, 380, art(190)), it('Pictures/2024 Iceland', 'IMG_2202.HEIC', 2.9, 4032, 3024, 380, art(190, 4)), it('Pictures/2024 Iceland', 'IMG_2203.HEIC', 3.0, 4032, 3024, 380, art(190, 8))], 'Highest resolution (4032×3024)'),
    g('similar', 1, [it('Pictures/Stills', 'still_0042.tif', 36, 3840, 2160, 150, art(40, 2)), it('Desktop', 'still_0042.jpg', 1.8, 1920, 1080, 149, art(40, 4))], 'Highest resolution (3840×2160)'),
  ];
  return { exact, similar, photos: 4182, bytes: 61.4 * 1024 ** 3 };
}

export function initPhotos({ api, fmt, esc, toast, pro, DEMO }) {
  const style = document.createElement('style');
  style.textContent = PHOTOS_CSS;
  document.head.appendChild(style);

  if (DEMO || !api.scanPhotos) {
    const handlers = [];
    let mock = null;
    api = {
      ...api,
      scanPhotos: async () => {
        for (let i = 1; i <= 10; i++) {
          await new Promise((r) => setTimeout(r, 120));
          handlers.forEach((cb) => cb({ phase: i < 4 ? 'finding' : i < 6 ? 'twins' : 'lookalikes', done: i * 418, total: 4182 }));
        }
        mock = mockPhotos();
        return mock;
      },
      cancelPhotos: async () => true,
      onPhotoProgress: (cb) => handlers.push(cb),
      trashPhotos: async (paths) => {
        const res = await api.trash(paths); // demo allowance
        if (res.some((r) => r.error === 'cap')) return res;
        return paths.map((p) => ({ path: p, ok: true }));
      },
    };
  }

  const tabs = document.getElementById('tabs');
  const body = document.getElementById('panel-body');
  if (!tabs || !body) return {};
  const tabBtn = document.createElement('button');
  tabBtn.className = 'tab';
  tabBtn.dataset.tab = 'photos';
  tabBtn.textContent = 'Photos';
  const hall = tabs.querySelector('[data-tab="hall"]');
  tabs.insertBefore(tabBtn, hall || null);
  const page = document.createElement('section');
  page.id = 'tab-photos';
  page.className = 'tab-page';
  page.hidden = true;
  page.innerHTML = `
    <div class="section-head"><span>📸 Photo Studio</span><span class="muted" id="ph-count"></span></div>
    <p class="hint" style="margin-top:0;margin-bottom:8px">Finds <b>twins</b> (exact copies) and <b>lookalikes</b> (near-identical shots) in your own folders. Cloud drives and external drives are left alone.</p>
    <div id="ph-body"></div>`;
  body.appendChild(page);
  const el = page.querySelector('#ph-body');

  let res = null; // last scan
  let busy = false;
  let progress = null;
  const marked = new Set(); // paths marked for the Trash
  const shown = { exact: PAGE, similar: PAGE };
  api.onPhotoProgress((p) => {
    progress = p;
    if (busy) renderProgress();
  });

  const allGroups = () => (res ? [...res.exact, ...res.similar] : []);
  const markedBytes = () => allGroups().reduce((n, g) => n + g.items.filter((i) => marked.has(i.path)).reduce((s, i) => s + i.size, 0), 0);
  const dims = (i) => (i.width ? `${i.width}×${i.height}` : '');

  function renderProgress() {
    const words = { finding: 'Looking through your folders', twins: 'Checking for twins', lookalikes: 'Comparing lookalikes', done: 'Tidying up' };
    const p = progress || { phase: 'finding', done: 0, total: 0 };
    const pct = p.total ? Math.round((100 * p.done) / p.total) : 0;
    el.innerHTML = `<div class="empty">${esc(words[p.phase] || 'Scanning')}… ${p.total && p.phase !== 'finding' ? `${pct}%` : `${p.done.toLocaleString()} photos`}</div>
      <div class="bar" style="margin:4px 0 8px"><div style="width:${p.phase === 'finding' ? 8 : pct}%;height:100%;background:var(--accent);border-radius:inherit"></div></div>
      <button class="link" id="ph-cancel">Cancel</button>`;
    el.querySelector('#ph-cancel').onclick = () => api.cancelPhotos();
  }

  function card(g, i) {
    const keep = !marked.has(i.path);
    const best = i.path === g.keep;
    const b = document.createElement('button');
    b.className = 'ph-card ' + (keep ? 'keep' : 'bin');
    b.title = `${i.path}\n${dims(i)} · ${fmt(i.size)}\nClick to ${keep ? 'move to the Trash' : 'keep'}`;
    b.innerHTML = `<span class="img" style="background-image:url('${esc(i.thumb || '')}')"></span>
      <span class="badge">${keep ? (best ? '★ Keep' : 'Keep') : 'Trash'}</span>
      <span class="show" title="Show in Finder">↗</span>
      <span class="meta"><span class="name">${esc(i.name)}</span><small>${esc(dims(i))}${dims(i) ? ' · ' : ''}${fmt(i.size)}</small></span>`;
    b.onclick = (e) => {
      if (e.target.closest('.show')) return api.reveal(i.path);
      if (keep) {
        // Never mark the last one in a group.
        const left = g.items.filter((x) => !marked.has(x.path) && x !== i).length;
        if (!left) return toast('Keep at least one photo from each group.');
        marked.add(i.path);
      } else marked.delete(i.path);
      render();
    };
    return b;
  }

  function group(g) {
    const box = document.createElement('div');
    box.className = 'ph-group';
    const bin = g.items.filter((i) => marked.has(i.path));
    const onlyBest = bin.length === g.items.length - 1 && !marked.has(g.keep);
    box.innerHTML = `<div class="ph-head"><span>${g.items.length} ${g.kind === 'exact' ? 'twins' : 'lookalikes'}</span><span class="why" title="${esc(g.why)}">★ ${esc(g.why)}</span><button class="ghost">${onlyBest ? 'Keep all' : 'Keep ★ only'}</button></div><div class="ph-row"></div>`;
    box.querySelector('.ph-head button').onclick = () => {
      for (const i of g.items) {
        if (onlyBest || i.path === g.keep) marked.delete(i.path);
        else marked.add(i.path);
      }
      render();
    };
    const row = box.querySelector('.ph-row');
    for (const i of g.items) row.appendChild(card(g, i));
    return box;
  }

  function section(kind, title, hint) {
    const list = res[kind];
    const frag = document.createDocumentFragment();
    const head = document.createElement('div');
    head.className = 'section-head ph-gap';
    const saving = list.reduce((n, g) => n + g.saving, 0);
    head.innerHTML = `<span>${title}</span><span class="muted">${list.length ? `${list.length} group${list.length === 1 ? '' : 's'} · up to ${fmt(saving)}` : ''}</span>`;
    frag.appendChild(head);
    if (!list.length) {
      const e = document.createElement('div');
      e.className = 'empty';
      e.textContent = hint;
      frag.appendChild(e);
      return frag;
    }
    for (const g of list.slice(0, shown[kind])) frag.appendChild(group(g));
    if (list.length > shown[kind]) {
      const more = document.createElement('button');
      more.className = 'ghost ph-more';
      more.textContent = `Show ${Math.min(PAGE, list.length - shown[kind])} more`;
      more.onclick = () => {
        shown[kind] += PAGE;
        render();
      };
      frag.appendChild(more);
    }
    return frag;
  }

  function render() {
    if (busy) return renderProgress();
    if (!res) {
      el.innerHTML = `<button class="primary" id="ph-scan" style="width:100%">Find duplicate photos</button>
        <p class="hint">Reads your photos on this Mac only. Nothing is removed until you choose.</p>`;
      el.querySelector('#ph-scan').onclick = scanNow;
      return;
    }
    page.querySelector('#ph-count').textContent = `· ${res.photos.toLocaleString()} photos · ${fmt(res.bytes)}`;
    el.innerHTML = `<div class="ph-hero"><span class="ph-big">${fmt(res.exact.reduce((n, g) => n + g.saving, 0) + res.similar.reduce((n, g) => n + g.saving, 0))}</span><span class="muted">in copies and lookalikes</span></div>`;
    el.appendChild(section('exact', '👯 Twins', 'No exact copies. Tidy!'));
    el.appendChild(section('similar', '🎞️ Lookalikes', 'No near-identical shots found.'));
    const bar = document.createElement('div');
    bar.className = 'ph-bar';
    const n = marked.size;
    const st = pro.status && pro.status();
    const capNote = st && st.plan === 'free' && n ? ` Counts toward your free ${fmt(st.capBytes)} (${fmt(st.remainingBytes)} left).` : '';
    bar.innerHTML = `<button class="danger" id="ph-trash" ${n ? '' : 'disabled'} style="width:100%">${n ? `Move ${n} photo${n === 1 ? '' : 's'} to Trash · ${fmt(markedBytes())}` : 'Click photos to mark them for the Trash'}</button>
      <p class="hint">★ is the suggested keeper. Twins are checked byte for byte again before anything moves. Everything goes to the Trash, so you can get it back.${capNote}</p>
      <button class="link" id="ph-rescan">Scan photos again</button>`;
    bar.querySelector('#ph-trash').onclick = trashNow;
    bar.querySelector('#ph-rescan').onclick = scanNow;
    el.appendChild(bar);
  }

  async function scanNow() {
    if (busy) return;
    busy = true;
    progress = null;
    render();
    let r;
    try {
      r = await api.scanPhotos();
    } catch (err) {
      r = null;
      toast('Photo scan failed: ' + (err && err.message ? err.message : err));
    }
    busy = false;
    if (r && !r.cancelled) {
      res = r;
      marked.clear();
      shown.exact = shown.similar = PAGE;
      // Twins are exact copies: mark all but the keeper. Lookalikes wait for you.
      for (const g of res.exact) for (const i of g.items) if (i.path !== g.keep) marked.add(i.path);
    }
    render();
  }

  async function trashNow() {
    const paths = [...marked];
    if (!paths.length) return;
    const btn = el.querySelector('#ph-trash');
    btn.disabled = true;
    btn.textContent = 'Moving to the Trash…';
    const results = await api.trashPhotos(paths);
    if (pro.handleBlocked(results)) return render();
    const ok = new Set(results.filter((r) => r.ok).map((r) => r.path));
    let freed = 0;
    for (const kind of ['exact', 'similar']) {
      res[kind] = res[kind]
        .map((g) => {
          freed += g.items.filter((i) => ok.has(i.path)).reduce((n, i) => n + i.size, 0);
          const items = g.items.filter((i) => !ok.has(i.path));
          const keep = items.some((i) => i.path === g.keep) ? g.keep : items[0] && items[0].path;
          return { ...g, items, keep, saving: items.filter((i) => i.path !== keep).reduce((n, i) => n + i.size, 0) };
        })
        .filter((g) => g.items.length > 1);
    }
    for (const p of ok) marked.delete(p);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) for (const f of failed) marked.delete(f.path);
    toast(`${ok.size} photo${ok.size === 1 ? '' : 's'} moved to the Trash (${fmt(freed)}).${failed.length ? ` ${failed.length} left in place: ${failed[0].error}` : ' Empty the Trash to reclaim the space.'}`);
    render();
  }

  tabBtn.addEventListener('click', () => render());
  if (api.onPlan) api.onPlan(() => res && !busy && render());
  render();
  return { scan: scanNow, open: () => tabBtn.click() };
}

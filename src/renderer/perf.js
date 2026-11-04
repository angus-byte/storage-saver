// Power tab ("Power Station"): live memory, CPU, the heaviest businesses in
// town, disk traffic, battery and heat. Samples every 3 s, and only while the
// tab is open and the window is visible. Free for everyone.
// Safety (what can be quit) is decided in the main process (src/main/perf.js).
import { IS_WIN } from './platform.js';

const PERF_CSS = `
#tabs { flex-wrap: wrap; }
#tab-power .ps-hero { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
#tab-power .dial { background: var(--soft); border-radius: 14px; padding: 10px 12px; position: relative; overflow: hidden; }
#tab-power .dial .lbl { font-size: 11.5px; color: var(--muted); font-weight: 600; display: flex; align-items: center; gap: 6px; }
#tab-power .dial .big { font-size: 24px; font-weight: 750; letter-spacing: -0.5px; margin-top: 2px; font-variant-numeric: tabular-nums; }
#tab-power .dial .sub { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
#tab-power .dial .meter { height: 5px; border-radius: 3px; background: var(--soft-2); margin-top: 7px; overflow: hidden; }
#tab-power .dial .meter i { display: block; height: 100%; border-radius: 3px; background: var(--accent); transition: width .6s ease, background .6s ease; }
#tab-power .light { width: 8px; height: 8px; border-radius: 50%; background: #35c77d; box-shadow: 0 0 6px #35c77d; }
#tab-power .light.warn { background: #f6a44a; box-shadow: 0 0 6px #f6a44a; }
#tab-power .light.critical { background: var(--danger); box-shadow: 0 0 8px var(--danger); animation: ps-blink 1s steps(2) infinite; }
@keyframes ps-blink { 50% { opacity: .35; } }
#tab-power .ps-status { font-size: 12.5px; margin: 8px 2px 0; display: flex; gap: 6px; align-items: baseline; }
#tab-power .ps-status b { font-weight: 700; }
#tab-power .graph { margin-top: 8px; background: var(--soft); border-radius: 14px; padding: 8px 10px 6px; }
#tab-power .graph canvas { width: 100%; height: 64px; display: block; }
#tab-power .graph .key { display: flex; gap: 12px; font-size: 11px; color: var(--muted); margin-top: 4px; }
#tab-power .graph .key i { display: inline-block; width: 10px; height: 3px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
#tab-power .membar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: var(--soft-2); margin: 8px 0 4px; }
#tab-power .membar i { display: block; height: 100%; transition: width .6s ease; }
#tab-power .memkey { display: flex; flex-wrap: wrap; gap: 4px 10px; font-size: 11px; color: var(--muted); }
#tab-power .memkey span::before { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 2px; margin-right: 4px; background: var(--c); }
#tab-power .chips { display: flex; gap: 6px; margin: 0 0 8px; }
#tab-power .chip { padding: 4px 10px; border-radius: 999px; font-size: 12px; background: var(--soft); color: var(--muted); font-weight: 600; }
#tab-power .chip.on { background: var(--accent); color: var(--accent-ink); }
#tab-power .biz { background: var(--soft); border-radius: 12px; margin-bottom: 5px; padding: 7px 10px; font-size: 12.5px; }
#tab-power .biz .top { display: flex; align-items: center; gap: 8px; }
#tab-power .biz .name { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 600; }
#tab-power .biz .name small { font-weight: 500; color: var(--muted); margin-left: 4px; }
#tab-power .biz .num { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 12px; min-width: 52px; text-align: right; }
#tab-power .biz .num.hot { color: var(--text); font-weight: 650; }
#tab-power .biz .bar { height: 3px; border-radius: 2px; background: var(--soft-2); margin-top: 5px; overflow: hidden; }
#tab-power .biz .bar i { display: block; height: 100%; background: var(--accent); border-radius: 2px; }
#tab-power .biz button.quit { padding: 4px 9px; font-size: 11.5px; flex: none; }
#tab-power .biz .tag { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 10.5px; font-weight: 700; background: var(--soft-2); color: var(--muted); white-space: nowrap; flex: none; }
#tab-power .biz .confirm { margin-top: 7px; font-size: 12px; }
#tab-power .biz .confirm .row { display: flex; gap: 6px; margin-top: 6px; }
#tab-power .biz .confirm button { flex: 1; padding: 6px 8px; font-size: 12px; }
#tab-power .biz .yes { background: var(--danger); color: #fff; font-weight: 600; }
#tab-power .minis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
#tab-power .mini { background: var(--soft); border-radius: 12px; padding: 8px 9px; font-size: 11.5px; min-width: 0; }
#tab-power .mini .lbl { color: var(--muted); font-weight: 600; white-space: nowrap; }
#tab-power .mini .val { font-size: 13.5px; font-weight: 700; margin-top: 2px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#tab-power .mini .sub { color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#tab-power .empty { color: var(--muted); font-size: 12.5px; padding: 6px 2px 10px; }
#tab-power .gap { margin-top: 14px; }
`;

const STATUS = {
  normal: ['All quiet', 'The grid has plenty of power to spare.'],
  warn: ['Grid under strain', 'Memory is getting tight, so things may slow down. Quitting a heavy business helps.'],
  critical: ['Brownout', 'Memory is nearly gone and your Mac is swapping to disk. Quit something heavy below.'],
};
const HEAT = { nominal: ['Cool', 'Running normally'], fair: ['Warm', 'Fans may spin up'], serious: ['Hot', 'Slowing down to cool off'], critical: ['Overheating', 'Heavily throttled'] };
const HISTORY = 40; // 40 × 3 s = 2 minutes

// Demo: a believable machine that wiggles, so the tab can be tried in a browser.
function createMockMonitor() {
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  let t = 0;
  let quit = new Set();
  const biz = [
    ['app:/Applications/DaVinci Resolve.app', 'DaVinci Resolve', 3.9 * GB, 34, 6],
    ['app:/Applications/Google Chrome.app', 'Google Chrome', 2.6 * GB, 9, 31],
    ['app:/Applications/Adobe Premiere Pro 2024.app', 'Adobe Premiere Pro 2024', 2.1 * GB, 4, 9],
    ['app:/Applications/Slack.app', 'Slack', 780 * MB, 2, 6],
    ['exe:/System/Library/Frameworks/WebKit.framework/XPCServices/com.apple.WebKit.WebContent', 'com.apple.WebKit.WebContent', 640 * MB, 1.5, 5, 'macOS'],
    ['app:/System/Applications/Photos.app', 'Photos', 520 * MB, 0.6, 3],
    ['exe:/System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer', 'WindowServer', 480 * MB, 6, 1, 'macOS'],
    ['app:/Applications/Spotify.app', 'Spotify', 410 * MB, 1.2, 5],
    ['exe:/System/Library/Frameworks/CoreServices.framework/Frameworks/Metadata.framework/Support/mds_stores', 'mds_stores', 260 * MB, 3.5, 2, 'macOS'],
    ['app:/Applications/Zoom.app', 'Zoom', 240 * MB, 0.8, 3],
    ['app:/Applications/Gigapolis.app', 'Gigapolis', 210 * MB, 2, 4, null, true],
    ['exe:/Users/angus/.nvm/versions/node/v20/bin/node', 'node', 180 * MB, 0.4, 2],
    ['exe:/usr/libexec/kernel_task', 'kernel_task', 1.1 * GB, 4, 1, 'macOS'],
  ];
  const wig = (v, f) => v * (1 + (Math.sin(t * 0.9 + f) + Math.sin(t * 2.3 + f * 3)) * 0.18);
  return {
    async sample() {
      t++;
      const procs = biz
        .filter(([k]) => !quit.has(k))
        .map(([key, name, mem, cpu, count, system = null, self = false], i) => ({ key, name, mem: wig(mem, i), cpu: Math.max(0, Math.round(wig(cpu, i + 1) * 10) / 10), count, system, self, canQuit: !system && !self }));
      const total = 16 * GB;
      const app = procs.reduce((n, p) => n + p.mem, 0) * 0.62;
      const wired = 2.3 * GB;
      const compressed = wig(1.4 * GB, 7);
      const used = Math.min(total * 0.97, app + wired + compressed);
      const pct = (used / total) * 100;
      return {
        t: Date.now(),
        platform: IS_WIN ? 'win32' : 'darwin',
        cpu: { load: Math.min(100, Math.round(procs.reduce((n, p) => n + p.cpu, 0) * 0.7)), cores: 10, model: 'Apple M2 Pro' },
        mem: { total, used, free: total - used, app, wired, compressed, cached: wig(2.2 * GB, 2), swapUsed: pct > 80 ? 1.6 * GB : 0, pressure: pct >= 92 ? 'critical' : pct >= 80 ? 'warn' : 'normal' },
        disk: { read: Math.abs(wig(38 * MB, 4) - 30 * MB) + 1.2 * MB, write: Math.abs(wig(12 * MB, 5) - 9 * MB) + 0.4 * MB },
        diskSupported: true,
        battery: { percent: 82, charging: false, onAC: false, minutesLeft: 248 },
        thermal: t % 40 > 30 ? 'fair' : 'nominal',
        procs,
        procCount: 512,
      };
    },
    async quit(key) {
      const b = biz.find(([k]) => k === key);
      if (!b || b[5] || b[6]) return { ok: false, error: 'That one keeps macOS running, so Gigapolis leaves it alone.' };
      quit.add(key);
      return { ok: true, name: b[1] };
    },
  };
}

export function initPerformance({ api, fmt, esc, toast, DEMO }) {
  const style = document.createElement('style');
  style.textContent = PERF_CSS;
  document.head.appendChild(style);

  let sample;
  let quitProc;
  if (DEMO || !api.perfSample) {
    const mock = createMockMonitor();
    sample = mock.sample;
    quitProc = mock.quit;
  } else {
    sample = api.perfSample;
    quitProc = api.perfQuit;
  }

  const tabs = document.getElementById('tabs');
  const body = document.getElementById('panel-body');
  if (!tabs || !body) return {};
  const tabBtn = document.createElement('button');
  tabBtn.className = 'tab';
  tabBtn.dataset.tab = 'power';
  tabBtn.textContent = 'Performance';
  tabs.appendChild(tabBtn);
  const page = document.createElement('section');
  page.id = 'tab-power';
  page.className = 'tab-page';
  page.hidden = true;
  page.innerHTML = `
    <div class="section-head"><span>⚡ Power Station</span><span class="muted" id="ps-live">live</span></div>
    <div class="ps-hero">
      <div class="dial" id="ps-mem"><div class="lbl"><span class="light"></span>Memory (the grid)</div><div class="big">—</div><div class="sub">&nbsp;</div><div class="meter"><i style="width:0"></i></div></div>
      <div class="dial" id="ps-cpu"><div class="lbl">🚦 Processor (traffic)</div><div class="big">—</div><div class="sub">&nbsp;</div><div class="meter"><i style="width:0"></i></div></div>
    </div>
    <div class="ps-status" id="ps-status"></div>
    <div class="graph"><canvas id="ps-graph" height="64"></canvas><div class="key"><span><i style="background:var(--accent)"></i>Processor</span><span><i style="background:var(--cache)"></i>Memory</span><span style="margin-left:auto">last 2 min</span></div></div>
    <div class="membar" id="ps-membar"></div>
    <div class="memkey" id="ps-memkey"></div>
    <div class="section-head gap"><span>🏭 Heavy industry</span><span class="muted" id="ps-count"></span></div>
    <div class="chips"><button class="chip on" data-s="mem">Memory</button><button class="chip" data-s="cpu">Processor</button></div>
    <div id="ps-list"><div class="empty">Reading the meters…</div></div>
    <div class="minis gap">
      <div class="mini" id="ps-disk"><div class="lbl">🚚 Freight (disk)</div><div class="val">—</div><div class="sub">&nbsp;</div></div>
      <div class="mini" id="ps-bat"><div class="lbl">🔋 Battery</div><div class="val">—</div><div class="sub">&nbsp;</div></div>
      <div class="mini" id="ps-heat"><div class="lbl">🌡 Heat</div><div class="val">—</div><div class="sub">&nbsp;</div></div>
    </div>
    <p class="hint">Quitting closes the app like choosing Quit, so save your work first. Parts of macOS are never offered.</p>`;
  body.appendChild(page);

  let sortBy = 'mem';
  let last = null;
  let timer = null;
  let busy = false;
  const hist = { cpu: [], mem: [] };
  const confirmKey = { key: null, force: false };
  const pct = (n) => `${Math.round(n)}%`;
  const rate = (b) => (b < 1024 * 100 ? '0 MB/s' : `${fmt(b)}/s`);

  page.querySelector('.chips').onclick = (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    sortBy = c.dataset.s;
    page.querySelectorAll('.chip').forEach((x) => x.classList.toggle('on', x === c));
    renderList();
  };

  function renderDials(s) {
    const m = s.mem;
    const mp = (m.used / m.total) * 100;
    const mem = page.querySelector('#ps-mem');
    mem.querySelector('.light').className = 'light ' + m.pressure;
    mem.querySelector('.big').textContent = pct(mp);
    mem.querySelector('.sub').textContent = `${fmt(m.used)} / ${fmt(m.total)}`;
    const mi = mem.querySelector('.meter i');
    mi.style.width = mp + '%';
    mi.style.background = m.pressure === 'critical' ? 'var(--danger)' : m.pressure === 'warn' ? 'var(--cache)' : 'var(--accent)';
    const cpu = page.querySelector('#ps-cpu');
    cpu.querySelector('.big').textContent = pct(s.cpu.load);
    cpu.querySelector('.sub').textContent = `${s.cpu.cores} cores · ${s.cpu.load >= 85 ? 'gridlock' : s.cpu.load >= 50 ? 'busy roads' : 'light traffic'}`;
    const ci = cpu.querySelector('.meter i');
    ci.style.width = s.cpu.load + '%';
    ci.style.background = s.cpu.load >= 85 ? 'var(--danger)' : s.cpu.load >= 50 ? 'var(--cache)' : 'var(--accent)';
    const [title, text] = STATUS[m.pressure] || STATUS.normal;
    const swap = m.swapUsed ? ` Swap in use: ${fmt(m.swapUsed)}.` : '';
    page.querySelector('#ps-status').innerHTML = `<b>${esc(title)}.</b><span class="muted">${esc(text)}${esc(m.pressure !== 'normal' ? swap : '')}</span>`;

    // Memory breakdown: Activity Monitor's buckets on a Mac, used/free elsewhere.
    const parts = m.app != null
      ? [['Apps', m.app, 'var(--media)'], ['System (wired)', m.wired, 'var(--system)'], ['Compressed', m.compressed, 'var(--downloads)'], ['Cached files', Math.min(m.cached, m.free), 'var(--trash)']]
      : [['In use', m.used, 'var(--media)']];
    const freeLeft = Math.max(0, m.total - parts.reduce((n, p) => n + p[1], 0));
    parts.push(['Free', freeLeft, 'transparent']);
    page.querySelector('#ps-membar').innerHTML = parts.map(([, v, c]) => `<i style="width:${(v / m.total) * 100}%;background:${c}"></i>`).join('');
    page.querySelector('#ps-memkey').innerHTML = parts.map(([n, v, c]) => `<span style="--c:${c === 'transparent' ? 'var(--soft-2)' : c}">${esc(n)} ${fmt(v)}</span>`).join('');
  }

  function renderGraph() {
    const cv = page.querySelector('#ps-graph');
    const w = cv.clientWidth;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    const h = 64;
    if (cv.width !== Math.round(w * dpr)) (cv.width = Math.round(w * dpr)), (cv.height = h * dpr);
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(page);
    g.strokeStyle = css.getPropertyValue('--soft-2');
    g.lineWidth = 1;
    for (const y of [0.5, h / 2, h - 0.5]) g.beginPath(), g.moveTo(0, y), g.lineTo(w, y), g.stroke();
    const line = (vals, color, fill) => {
      if (vals.length < 2) return;
      const step = w / (HISTORY - 1);
      const x0 = w - (vals.length - 1) * step;
      g.beginPath();
      vals.forEach((v, i) => {
        const x = x0 + i * step;
        const y = h - 2 - (Math.min(100, v) / 100) * (h - 4);
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.strokeStyle = color;
      g.lineWidth = 2;
      g.lineJoin = 'round';
      g.stroke();
      if (fill) {
        g.lineTo(w, h);
        g.lineTo(x0, h);
        g.closePath();
        g.globalAlpha = 0.14;
        g.fillStyle = color;
        g.fill();
        g.globalAlpha = 1;
      }
    };
    line(hist.mem, css.getPropertyValue('--cache').trim() || '#f6a44a', false);
    line(hist.cpu, css.getPropertyValue('--accent').trim() || '#15a39a', true);
  }

  function renderList() {
    const el = page.querySelector('#ps-list');
    if (!last) return;
    const procs = [...last.procs].sort((a, b) => (sortBy === 'mem' ? b.mem - a.mem : b.cpu - a.cpu)).slice(0, 10);
    page.querySelector('#ps-count').textContent = last.procCount ? `· ${last.procCount} processes` : '';
    if (!procs.length) {
      el.innerHTML = `<div class="empty">${last.warming ? 'Reading the meters…' : 'Nothing running.'}</div>`;
      return;
    }
    const maxMem = Math.max(...procs.map((p) => p.mem), 1);
    el.innerHTML = '';
    for (const p of procs) {
      const row = document.createElement('div');
      row.className = 'biz';
      const barW = sortBy === 'mem' ? (p.mem / maxMem) * 100 : Math.min(100, p.cpu);
      const action = p.canQuit ? '<button class="ghost quit">Quit</button>' : `<span class="tag" title="${p.self ? 'This app' : 'Keeps your Mac running'}">${p.self ? 'this app' : 'city service'}</span>`;
      row.innerHTML = `<div class="top"><span class="name" title="${esc(p.key.replace(/^\w+:/, ''))}">${esc(p.name)}${p.count > 1 ? `<small>×${p.count}</small>` : ''}</span><span class="num ${sortBy === 'mem' ? 'hot' : ''}">${fmt(p.mem)}</span><span class="num ${sortBy === 'cpu' ? 'hot' : ''}">${p.cpu.toFixed(p.cpu < 10 ? 1 : 0)}%</span>${action}</div><div class="bar"><i style="width:${barW}%"></i></div>`;
      if (confirmKey.key === p.key) {
        const c = document.createElement('div');
        c.className = 'confirm';
        c.innerHTML = confirmKey.force
          ? `<span>${esc(p.name)} didn't close. <b>Force quit</b> it? Anything unsaved is lost.</span><div class="row"><button class="yes">Force quit</button><button class="keep">Leave it</button></div>`
          : `<span>Quit <b>${esc(p.name)}</b>${p.count > 1 ? ` and its ${p.count - 1} helper${p.count > 2 ? 's' : ''}` : ''}? Save your work in it first.</span><div class="row"><button class="yes">Quit ${esc(p.name)}</button><button class="keep">Keep it</button></div>`;
        c.querySelector('.keep').onclick = () => {
          confirmKey.key = null;
          renderList();
        };
        c.querySelector('.yes').onclick = () => doQuit(p, confirmKey.force);
        row.appendChild(c);
      }
      const q = row.querySelector('.quit');
      if (q)
        q.onclick = () => {
          confirmKey.key = p.key;
          confirmKey.force = false;
          renderList();
        };
      el.appendChild(row);
    }
  }

  async function doQuit(p, force) {
    confirmKey.key = null;
    renderList();
    const r = await quitProc(p.key, force);
    if (!r.ok) {
      if (r.needsForce) {
        confirmKey.key = p.key;
        confirmKey.force = true;
        renderList();
      } else toast(r.error || 'Could not quit it');
      return;
    }
    toast(`${force ? 'Force quit' : 'Asked'} ${p.name}${force ? '' : ' to close'}.`);
    // Still running a few seconds later (e.g. a "Save changes?" box, or it
    // ignored the request): offer Force quit.
    if (!force)
      setTimeout(async () => {
        await tick();
        if (last && last.procs.some((x) => x.key === p.key) && !confirmKey.key) {
          confirmKey.key = p.key;
          confirmKey.force = true;
          renderList();
        }
      }, 5000);
    else setTimeout(tick, 1200);
  }

  function renderMinis(s) {
    const set = (id, val, sub) => {
      const el = page.querySelector(id);
      el.querySelector('.val').textContent = val;
      el.querySelector('.sub').textContent = sub || ' ';
    };
    if (s.disk) set('#ps-disk', `↓ ${rate(s.disk.read)}`, `↑ ${rate(s.disk.write)} written`);
    else set('#ps-disk', s.diskSupported ? '…' : 'n/a', s.diskSupported ? 'measuring' : 'not reported');
    const b = s.battery;
    if (b) set('#ps-bat', `${b.percent}%`, b.charging ? 'charging' : b.onAC ? 'plugged in' : b.minutesLeft ? `${Math.floor(b.minutesLeft / 60)}h ${b.minutesLeft % 60}m left` : 'on battery');
    else set('#ps-bat', 'Mains', 'no battery');
    const h = s.thermal && HEAT[s.thermal];
    if (h) set('#ps-heat', h[0], h[1]);
    else set('#ps-heat', '—', IS_WIN ? 'not reported by Windows' : 'not reported');
  }

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const s = await sample();
      last = s;
      hist.cpu.push(s.cpu.load);
      hist.mem.push((s.mem.used / s.mem.total) * 100);
      for (const k of ['cpu', 'mem']) if (hist[k].length > HISTORY) hist[k].shift();
      renderDials(s);
      renderGraph();
      renderList();
      renderMinis(s);
    } catch (err) {
      page.querySelector('#ps-live').textContent = 'paused';
    } finally {
      busy = false;
    }
  }

  // Only sample while someone is looking.
  const visible = () => !page.hidden && !document.hidden && !document.getElementById('panel').classList.contains('collapsed');
  function sync() {
    if (visible() && !timer) {
      tick();
      timer = setInterval(tick, 3000);
      page.querySelector('#ps-live').textContent = 'live';
    } else if (!visible() && timer) {
      clearInterval(timer);
      timer = null;
    }
  }
  new MutationObserver(sync).observe(page, { attributes: true, attributeFilter: ['hidden'] });
  new MutationObserver(sync).observe(document.getElementById('panel'), { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', sync);

  return { open: () => tabBtn.click(), tick };
}

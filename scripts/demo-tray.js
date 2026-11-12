// Demo only: a mock of the menu bar / system tray widget (src/main/tray.js),
// drawn as a fake menu bar strip so the browser demo can show it.
(function demoTray() {
  const css = `
#demo-menubar { position: absolute; top: 0; left: 0; right: 0; height: 24px; z-index: 8; display: flex; justify-content: flex-end; align-items: center; gap: 14px; padding: 0 14px; font: 600 12.5px -apple-system, system-ui, sans-serif; color: #fff; background: rgba(10, 20, 30, 0.32); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px); }
#demo-menubar .tag { opacity: 0.7; font-weight: 500; margin-right: auto; }
#demo-tray-btn { all: unset; cursor: pointer; padding: 1px 8px; border-radius: 5px; display: flex; gap: 6px; align-items: center; font-variant-numeric: tabular-nums; }
#demo-tray-btn.on, #demo-tray-btn:hover { background: rgba(255, 255, 255, 0.22); }
#demo-tray-btn i { display: inline-flex; align-items: flex-end; gap: 1.5px; height: 11px; }
#demo-tray-btn i b { width: 2.5px; background: currentColor; border-radius: 1px; }
#demo-tray-menu { position: absolute; top: 28px; right: 70px; z-index: 9; width: 270px; padding: 5px; border-radius: 10px; background: rgba(240, 240, 244, 0.92); color: #111; backdrop-filter: blur(24px); -webkit-backdrop-filter: blur(24px); box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35); font: 13px -apple-system, system-ui, sans-serif; }
#demo-tray-menu div { padding: 4px 10px; border-radius: 5px; display: flex; align-items: center; gap: 6px; }
#demo-tray-menu div.act { cursor: default; }
#demo-tray-menu div.act:hover { background: #2f6fec; color: #fff; }
#demo-tray-menu div.dis { color: #8a8a90; }
#demo-tray-menu div .ck { width: 12px; }
#demo-tray-menu hr { border: none; border-top: 1px solid rgba(0, 0, 0, 0.12); margin: 4px 8px; }
#panel { top: 34px; max-height: calc(100% - 52px); }
#hud { top: 36px; }
`;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const fmt = (bytes) => {
    if (!bytes) return '0 GB';
    const gb = bytes / 1024 ** 3;
    if (gb >= 100) return `${Math.round(gb)} GB`;
    if (gb >= 1) return `${gb.toFixed(1)} GB`;
    return `${Math.round(bytes / 1024 ** 2)} MB`;
  };
  const settings = { lowSpaceAlert: true, keepInTray: true, launchAtLogin: false };
  const bar = document.createElement('div');
  bar.id = 'demo-menubar';
  bar.innerHTML = '<span class="tag">Menu bar widget (demo)</span><button id="demo-tray-btn" title="Gigapolis"><i><b style="height:6px"></b><b style="height:11px"></b><b style="height:8px"></b></i><span id="demo-tray-free"></span></button><span>Wed 9:41</span>';
  document.body.appendChild(bar);
  const btn = bar.querySelector('#demo-tray-btn');
  const menu = document.createElement('div');
  menu.id = 'demo-tray-menu';
  menu.hidden = true;
  document.body.appendChild(menu);

  const S = () => window.__storageSaver || {};
  const disk = () => (S().state && S().state.disk && S().state.disk.roots && S().state.disk.roots[0]) || { free: 0, total: 0 };
  const safeBytes = () => {
    const t = document.getElementById('safe-total');
    const b = document.getElementById('btn-safe');
    return { ready: b && !b.disabled, label: t ? t.textContent : '' };
  };
  const openTab = (tab) => {
    const p = document.getElementById('panel');
    if (p && p.classList.contains('collapsed')) document.getElementById('btn-panel').click();
    const t = document.querySelector(`#tabs .tab[data-tab="${tab}"]`);
    if (t) t.click();
  };

  function render() {
    const d = disk();
    const used = d.total ? Math.round(((d.total - d.free) / d.total) * 100) : 0;
    bar.querySelector('#demo-tray-free').textContent = d.total ? fmt(d.free) : '';
    const s = safeBytes();
    const ck = (k, label) => `<div class="act" data-set="${k}"><span class="ck">${settings[k] ? '✓' : ''}</span>${label}</div>`;
    menu.innerHTML = `
      <div class="dis">${d.total ? `${fmt(d.free)} free of ${fmt(d.total)} (${used}% used)` : 'Checking disk…'}</div><hr>
      ${s.ready ? `<div class="act" data-do="safe">Safe Clean · free ${s.label}</div>` : '<div class="dis">Safe Clean · nothing to clear</div>'}
      <div class="act" data-do="open">Open Gigapolis</div><hr>
      ${ck('lowSpaceAlert', 'Low-space alert')}${ck('keepInTray', 'Keep running in menu bar')}${ck('launchAtLogin', 'Open at login')}<hr>
      <div class="act" data-do="quit">Quit Gigapolis</div>`;
  }
  const close = () => { menu.hidden = true; btn.classList.remove('on'); };
  btn.onclick = (e) => {
    e.stopPropagation();
    if (!menu.hidden) return close();
    render();
    menu.hidden = false;
    btn.classList.add('on');
  };
  menu.onclick = (e) => {
    e.stopPropagation();
    const a = e.target.closest('[data-do],[data-set]');
    if (!a) return;
    if (a.dataset.set) { settings[a.dataset.set] = !settings[a.dataset.set]; return render(); }
    close();
    if (a.dataset.do === 'safe') { openTab('safe'); document.getElementById('btn-safe').click(); }
    if (a.dataset.do === 'open') openTab('safe');
    if (a.dataset.do === 'quit') {
      const t = document.getElementById('toast');
      t.textContent = 'Demo: Gigapolis would quit here.';
      t.hidden = false;
      setTimeout(() => (t.hidden = true), 2500);
    }
  };
  document.addEventListener('click', close);
  setInterval(() => { if (menu.hidden) render(); }, 1500);
})();

// Gigapolis Pro seasons. Summer is the normal city; Autumn turns the trees
// orange and red with leaves drifting down, Winter brings falling snow, snowy
// roofs, parks and trees and a frosty sky. Both are Pro only: free users see
// them locked in the season menu. Works on top of day / night.

export const SEASONS = [
  ['summer', '☀️', 'Summer'],
  ['autumn', '🍂', 'Autumn'],
  ['winter', '❄️', 'Winter'],
];

const SEASON_CSS = `
#sky-autumn, #sky-winter { position: absolute; inset: 0; pointer-events: none; }
#sky-autumn { background: radial-gradient(ellipse 90% 75% at 55% 30%, #ffe6c4 0%, #f2bf8e 45%, #d39a76 100%); opacity: var(--autumn, 0); }
#sky-winter { background: radial-gradient(ellipse 90% 75% at 55% 30%, #f1f6fb 0%, #c9dbe8 45%, #93afc6 100%); opacity: var(--winter, 0); }
#frost { position: absolute; inset: 0; pointer-events: none; z-index: 1; opacity: calc(var(--winter, 0) * (0.9 - var(--night, 0) * 0.55));
  background: radial-gradient(ellipse 120% 95% at 50% 50%, rgba(255,255,255,0) 62%, rgba(232,244,255,.55) 86%, rgba(246,251,255,.85) 100%); }
#season-wrap { position: relative; }
#season-menu { position: absolute; top: calc(100% + 8px); right: 0; min-width: 190px; padding: 6px; border-radius: 16px; background: var(--panel); border: 1px solid var(--border); box-shadow: var(--shadow); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); display: flex; flex-direction: column; gap: 2px; }
#season-menu button { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 10px; border: none; border-radius: 11px; background: none; color: var(--text); font: inherit; font-weight: 600; text-align: left; cursor: pointer; }
#season-menu button:hover { background: var(--soft-2); }
#season-menu button.on { background: var(--soft-2); }
#season-menu button .lbl { flex: 1; }
#season-menu button.locked .lbl { color: var(--muted); }
#season-menu .tick { color: var(--accent); font-weight: 800; }
`;

export function initSeasons(ctx) {
  const { THREE, blocks, mats, isPro, planKnown, showUpgrade, getMeshes, getExtras, getTreeSpots, applyNight } = ctx;
  const SECONDS = 2.2;
  let season = 'summer';
  let wanted = null; // saved choice waiting for the plan to load
  const k = { autumn: 0, winter: 0 };

  // --- DOM: skies, frost, HUD button + menu ---------------------------------
  const style = document.createElement('style');
  style.textContent = SEASON_CSS;
  document.head.appendChild(style);
  const skyDay = document.getElementById('sky-day');
  for (const id of ['sky-autumn', 'sky-winter']) {
    const d = document.createElement('div');
    d.id = id;
    if (skyDay) skyDay.after(d);
  }
  const frost = document.createElement('div');
  frost.id = 'frost';
  document.getElementById('scene')?.after(frost);

  const wrap = document.createElement('div');
  wrap.id = 'season-wrap';
  const btn = document.createElement('button');
  btn.className = 'float';
  btn.id = 'btn-season';
  const menu = document.createElement('div');
  menu.id = 'season-menu';
  menu.hidden = true;
  wrap.append(btn, menu);
  const nightBtn = document.getElementById('btn-night');
  if (nightBtn) nightBtn.before(wrap);
  else document.getElementById('hud')?.append(wrap);

  function renderUi() {
    const cur = SEASONS.find((s) => s[0] === season);
    btn.textContent = `${cur[1]} ${cur[2]}`;
    const pro = isPro();
    menu.innerHTML = SEASONS.map(([id, icon, label]) => {
      const locked = id !== 'summer' && !pro;
      return `<button data-season="${id}" class="${id === season ? 'on' : ''} ${locked ? 'locked' : ''}"><span>${icon}</span><span class="lbl">${label}</span>${
        locked ? '🔒 <span class="pro-badge">PRO</span>' : id === season ? '<span class="tick">✓</span>' : ''
      }</button>`;
    }).join('');
  }
  btn.onclick = (e) => {
    e.stopPropagation();
    renderUi();
    menu.hidden = !menu.hidden;
  };
  menu.onclick = (e) => {
    const b = e.target.closest('button[data-season]');
    if (!b) return;
    e.stopPropagation();
    menu.hidden = true;
    const id = b.dataset.season;
    if (id !== 'summer' && !isPro()) {
      showUpgrade('seasons');
      const h2 = document.querySelector('#pro-modal .card h2');
      if (h2) h2.insertAdjacentHTML('afterend', `<div class="why" style="background:rgba(79,209,197,.14)">${id === 'winter' ? '❄️ Winter' : '🍂 Autumn'} city is part of Pro, along with ${id === 'winter' ? '🍂 Autumn' : '❄️ Winter'}.</div>`);
      return;
    }
    setSeason(id);
  };
  document.addEventListener('click', () => (menu.hidden = true));

  function setSeason(id, { save = true } = {}) {
    season = id;
    wanted = null;
    if (save) {
      try {
        localStorage.setItem('gp-season', id);
      } catch {}
    }
    renderUi();
  }
  try {
    const saved = localStorage.getItem('gp-season');
    if (saved === 'autumn' || saved === 'winter') wanted = saved;
  } catch {}
  renderUi();

  // --- Ground, roofs, clouds -------------------------------------------------
  const TINT = {
    autumn: { park: 0xc9b35e, pavement: 0xe3d7c3, roof: 0xb9aea2, kerb: 0xe8e0d2, plinth: 0xcdc6bb, cloud: 0xfff1e0 },
    winter: { park: 0xf2f6fa, pavement: 0xedf2f7, roof: 0xf5f8fb, kerb: 0xf3f7fa, plinth: 0xdbe3ec, cloud: 0xe2e8ef },
  };
  const base = {};
  for (const [name, m] of Object.entries(mats)) if (m) base[name] = m.color.getHex();
  const _a = new THREE.Color();
  const _b = new THREE.Color();
  function tintMaterials() {
    for (const [name, m] of Object.entries(mats)) {
      if (!m || base[name] === undefined) continue;
      m.color.setHex(base[name]);
      if (k.autumn) m.color.lerp(_a.setHex(TINT.autumn[name]), k.autumn);
      if (k.winter) m.color.lerp(_a.setHex(TINT.winter[name]), k.winter);
    }
  }

  // --- Trees: per-instance colours ------------------------------------------
  const AUTUMN = [0xe8762b, 0xd9452b, 0xf2b134, 0xc0392b, 0xe59a3a, 0xb8541f, 0xf0c24a];
  let trees = []; // { im, base: Float32Array, autumn, winter }
  function collectTrees() {
    trees = [];
    for (const im of getExtras()) {
      const role = im.userData && im.userData.tree;
      if (!role || !im.instanceColor) continue;
      const n = im.count;
      const b = im.instanceColor.array.slice();
      const au = new Float32Array(n * 3);
      const wi = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        if (role === 'pine') {
          _a.fromArray(b, i * 3);
          _a.toArray(au, i * 3); // evergreen in autumn
          _a.lerp(_b.setHex(0xeef4f8), 0.45).toArray(wi, i * 3);
        } else {
          _a.setHex(AUTUMN[(i * 7 + (role === 'upper' ? 3 : 0)) % AUTUMN.length]).offsetHSL(0, 0, (Math.random() - 0.5) * 0.06).toArray(au, i * 3);
          _a.setHex(role === 'upper' ? 0xf8fbfd : 0xe8eef3).toArray(wi, i * 3);
        }
      }
      trees.push({ im, base: b, autumn: au, winter: wi });
    }
  }
  function tintTrees() {
    for (const t of trees) {
      const arr = t.im.instanceColor.array;
      for (let i = 0; i < arr.length; i++) {
        let v = t.base[i];
        v += (t.autumn[i] - v) * k.autumn;
        v += (t.winter[i] - v) * k.winter;
        arr[i] = v;
      }
      t.im.instanceColor.needsUpdate = true;
    }
  }

  // --- Snow caps on every building ------------------------------------------
  const MAX_CAPS = 800;
  const capGeo = new THREE.BoxGeometry(1, 1, 1);
  capGeo.translate(0, 0.5, 0);
  const snowMat = new THREE.MeshStandardMaterial({ color: 0xf7fafd, roughness: 0.85 });
  const caps = new THREE.InstancedMesh(capGeo, snowMat, MAX_CAPS);
  caps.count = 0;
  caps.receiveShadow = true;
  caps.frustumCulled = false;
  blocks.add(caps);
  const _m = new THREE.Matrix4();
  function updateCaps() {
    if (k.winter < 0.002) {
      caps.count = 0;
      return;
    }
    let n = 0;
    for (const b of getMeshes()) {
      if (n >= MAX_CAPS) break;
      if (!b.userData || b.userData.district || !b.userData.targetH || !b.visible) continue;
      const s = b.scale;
      if (s.y < 0.2) continue;
      const th = 0.12 + 0.3 * k.winter;
      _m.makeScale(s.x * 1.04, th, s.z * 1.04);
      _m.setPosition(b.position.x, b.position.y + s.y, b.position.z);
      caps.setMatrixAt(n++, _m);
    }
    caps.count = n;
    caps.instanceMatrix.needsUpdate = true;
  }

  // --- Snowfall ---------------------------------------------------------------
  const FLAKES = 2600;
  const flakePos = new Float32Array(FLAKES * 3);
  const flakeV = new Float32Array(FLAKES * 2); // fall speed, drift phase
  for (let i = 0; i < FLAKES; i++) {
    flakePos[i * 3] = (Math.random() - 0.5) * 240;
    flakePos[i * 3 + 1] = Math.random() * 120;
    flakePos[i * 3 + 2] = (Math.random() - 0.5) * 200;
    flakeV[i * 2] = 3 + Math.random() * 4;
    flakeV[i * 2 + 1] = Math.random() * Math.PI * 2;
  }
  const flakeGeo = new THREE.BufferGeometry();
  flakeGeo.setAttribute('position', new THREE.BufferAttribute(flakePos, 3));
  const flakeTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 32;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.45, 'rgba(255,255,255,.8)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 32, 32);
    return new THREE.CanvasTexture(c);
  })();
  const flakeMat = new THREE.PointsMaterial({ size: 1.5, map: flakeTex, transparent: true, depthWrite: false, opacity: 0, color: 0xffffff });
  const snow = new THREE.Points(flakeGeo, flakeMat);
  snow.visible = false;
  snow.frustumCulled = false;
  ctx.scene.add(snow);

  // --- Falling leaves + leaf litter -----------------------------------------
  const LEAVES = 320;
  const leafGeo = new THREE.PlaneGeometry(0.55, 0.38);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, roughness: 0.9 });
  const leaves = new THREE.InstancedMesh(leafGeo, leafMat, LEAVES);
  leaves.frustumCulled = false;
  leaves.visible = false;
  for (let i = 0; i < LEAVES; i++) leaves.setColorAt(i, _a.setHex(AUTUMN[i % AUTUMN.length]));
  blocks.add(leaves);
  const leafState = Array.from({ length: LEAVES }, () => ({ x: 0, y: -1, z: 0, vy: 0, ph: Math.random() * 6.28, spin: 1 + Math.random() * 3 }));
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3();
  function spawnLeaf(L, anywhere) {
    const spots = getTreeSpots();
    if (spots.length) {
      const [x, z] = spots[Math.floor(Math.random() * spots.length)];
      L.x = x + (Math.random() - 0.5) * 1.6;
      L.z = z + (Math.random() - 0.5) * 1.6;
    } else {
      L.x = (Math.random() - 0.5) * 110;
      L.z = (Math.random() - 0.5) * 84;
    }
    L.y = anywhere ? 1.2 + Math.random() * 4 : 3.2 + Math.random() * 2;
    L.vy = 0.7 + Math.random() * 0.8;
  }
  const LITTER = 900;
  const litter = new THREE.InstancedMesh(leafGeo, leafMat, LITTER);
  litter.count = 0;
  litter.visible = false;
  litter.receiveShadow = true;
  blocks.add(litter);
  function scatterLitter() {
    const spots = getTreeSpots();
    if (!spots.length) {
      litter.count = 0;
      return;
    }
    const n = Math.min(LITTER, spots.length * 3);
    for (let i = 0; i < n; i++) {
      const [x, z] = spots[i % spots.length];
      const r = Math.random() * 1.8;
      const a = Math.random() * Math.PI * 2;
      _e.set(-Math.PI / 2, 0, Math.random() * Math.PI * 2);
      _q.setFromEuler(_e);
      _m.compose(_p.set(x + Math.cos(a) * r, 0.88, z + Math.sin(a) * r), _q, _s.setScalar(0.8 + Math.random() * 0.5));
      litter.setMatrixAt(i, _m);
      litter.setColorAt(i, _a.setHex(AUTUMN[(i * 3) % AUTUMN.length]));
    }
    litter.count = n;
    litter.instanceMatrix.needsUpdate = true;
    if (litter.instanceColor) litter.instanceColor.needsUpdate = true;
  }

  // --- Light / fog tint (called from applyNight after its own blend) --------
  function tintLights({ fog, hemi, key, nightK }) {
    const day = 1 - nightK * 0.75;
    if (k.autumn) {
      fog.color.lerp(_a.setHex(nightK > 0.5 ? 0x1c1630 : 0xe6b48a), k.autumn * 0.7 * day);
      hemi.color.lerp(_a.setHex(0xffe2bd), k.autumn * 0.35 * day);
      key.color.lerp(_a.setHex(0xffa860), k.autumn * 0.3 * (1 - nightK));
    }
    if (k.winter) {
      fog.color.lerp(_a.setHex(0xd2e1ec), k.winter * 0.8 * day);
      hemi.color.lerp(_a.setHex(0xf0f6ff), k.winter * 0.5 * day);
      hemi.groundColor.lerp(_a.setHex(0xa9b8c8), k.winter * 0.5 * day);
      key.color.lerp(_a.setHex(0xe6efff), k.winter * 0.45 * (1 - nightK));
    }
    const root = document.documentElement.style;
    root.setProperty('--autumn', k.autumn.toFixed(3));
    root.setProperty('--winter', k.winter.toFixed(3));
  }

  // --- Per frame ----------------------------------------------------------------
  function step(dt, t) {
    // The saved season comes back once the plan says Pro; a lapsed licence
    // drops back to summer.
    if (wanted && isPro()) setSeason(wanted, { save: false });
    if (season !== 'summer' && planKnown() && !isPro()) setSeason('summer', { save: false });

    let changed = false;
    for (const id of ['autumn', 'winter']) {
      const target = season === id ? 1 : 0;
      if (k[id] === target) continue;
      const d = dt / SECONDS;
      k[id] = k[id] < target ? Math.min(target, k[id] + d) : Math.max(target, k[id] - d);
      changed = true;
    }
    if (changed) {
      tintMaterials();
      tintTrees();
      applyNight();
    }
    updateCaps();

    snow.visible = k.winter > 0.01;
    if (snow.visible) {
      flakeMat.opacity = 0.9 * k.winter;
      for (let i = 0; i < FLAKES; i++) {
        const j = i * 3;
        flakePos[j + 1] -= flakeV[i * 2] * dt;
        flakePos[j] += Math.sin(t * 0.8 + flakeV[i * 2 + 1]) * 1.2 * dt;
        if (flakePos[j + 1] < 0.8) {
          flakePos[j + 1] = 110 + Math.random() * 10;
          flakePos[j] = (Math.random() - 0.5) * 240;
          flakePos[j + 2] = (Math.random() - 0.5) * 200;
        }
      }
      flakeGeo.attributes.position.needsUpdate = true;
    }

    const showLeaves = k.autumn > 0.01;
    leaves.visible = litter.visible = showLeaves;
    if (showLeaves) {
      const sc = k.autumn;
      for (let i = 0; i < LEAVES; i++) {
        const L = leafState[i];
        if (L.y < 0.95) spawnLeaf(L, L.y === -1);
        L.y -= L.vy * dt;
        L.x += Math.sin(t * 1.3 + L.ph) * 0.9 * dt + 0.25 * dt;
        L.z += Math.cos(t * 1.1 + L.ph) * 0.6 * dt;
        _e.set(t * L.spin + L.ph, t * L.spin * 0.7, Math.sin(t * 2 + L.ph) * 0.8);
        _q.setFromEuler(_e);
        _m.compose(_p.set(L.x, Math.max(0.95, L.y), L.z), _q, _s.setScalar(sc));
        leaves.setMatrixAt(i, _m);
      }
      leaves.instanceMatrix.needsUpdate = true;
      if (leaves.instanceColor) leaves.instanceColor.needsUpdate = true;
    }
  }

  /** Call after every layout(): picks up the new trees and buildings. */
  function refresh() {
    collectTrees();
    tintTrees();
    scatterLitter();
    for (const L of leafState) L.y = -1;
  }

  return {
    step,
    refresh,
    tintLights,
    setSeason: (id) => (id === 'summer' || isPro() ? setSeason(id) : showUpgrade('seasons')),
    season: () => season,
    renderUi,
  };
}

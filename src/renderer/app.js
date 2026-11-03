import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { squarify } from './treemap.js';
import { mockTree, mockSuggestions, mockDisk } from './mock.js';

// ---------------------------------------------------------------------------
// Backend: Electron bridge or in-browser demo
// ---------------------------------------------------------------------------
const DEMO = !window.storage;
const api = DEMO
  ? {
      diskInfo: async () => mockDisk,
      scan: async () => {
        const tree = mockTree();
        for (let i = 1; i <= 8; i++) {
          await new Promise((r) => setTimeout(r, 90));
          progressHandlers.forEach((cb) => cb({ files: i * 61234, bytes: i * 48e9, current: '/Users/angus/Movies/…' }));
        }
        return { tree, suggestions: mockSuggestions(tree) };
      },
      cancelScan: async () => true,
      onProgress: (cb) => {
        progressHandlers.push(cb);
        return () => progressHandlers.splice(progressHandlers.indexOf(cb), 1);
      },
      reveal: async () => toast('Demo mode: would reveal in Finder / Explorer'),
      pickFolder: async () => null,
      trash: async (paths) => paths.map((path) => ({ path, ok: true })),
      emptyFolder: async (dir) => [{ path: dir, ok: true }],
    }
  : window.storage;
const progressHandlers = [];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const KIND_COLORS = {
  cache: 0xf6a44a,
  trash: 0xa0a7b5,
  downloads: 0xc084fc,
  media: 0x4f8ef7,
  apps: 0x35c77d,
  documents: 0xf2d35b,
  system: 0x5b6577,
  other: 0x7f8da3,
  free: 0x1f2a3d,
};
const KIND_LABELS = { cache: 'Caches & temp', trash: 'Trash', downloads: 'Downloads & installers', media: 'Video, photo & audio', apps: 'Apps', documents: 'Documents', system: 'System', other: 'Other', free: 'Free space' };
const BASE_W = 120;
const BASE_D = 80;
const GAP = 0.6;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = { disk: null, tree: null, suggestions: null, path: [], selected: new Map(), scanning: false };

// ---------------------------------------------------------------------------
// Scene setup
// ---------------------------------------------------------------------------
const container = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0f17);
scene.fog = new THREE.Fog(0x0b0f17, 260, 520);

const camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 0.5, 2000);
camera.position.set(90, 110, 150);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2.05;
controls.minDistance = 40;
controls.maxDistance = 420;
controls.target.set(0, 4, 0);

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x101620, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(80, 140, 60);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -120;
key.shadow.camera.right = 120;
key.shadow.camera.top = 120;
key.shadow.camera.bottom = -120;
key.shadow.camera.far = 400;
scene.add(key);
const rim = new THREE.DirectionalLight(0x4fd1c5, 0.5);
rim.position.set(-100, 40, -80);
scene.add(rim);

// The "computer": a chassis with a drive slab on top.
const computer = new THREE.Group();
scene.add(computer);
const chassis = new THREE.Mesh(
  new THREE.BoxGeometry(BASE_W + 16, 8, BASE_D + 16),
  new THREE.MeshStandardMaterial({ color: 0x151c2b, metalness: 0.6, roughness: 0.45 })
);
chassis.position.y = -4;
chassis.receiveShadow = true;
computer.add(chassis);
const slab = new THREE.Mesh(
  new THREE.BoxGeometry(BASE_W + 4, 2, BASE_D + 4),
  new THREE.MeshStandardMaterial({ color: 0x0f1522, metalness: 0.3, roughness: 0.7 })
);
slab.position.y = 1;
slab.receiveShadow = true;
computer.add(slab);
const edge = new THREE.Mesh(
  new THREE.BoxGeometry(BASE_W + 4.4, 0.3, BASE_D + 4.4),
  new THREE.MeshBasicMaterial({ color: 0x4fd1c5, transparent: true, opacity: 0.55 })
);
edge.position.y = 2.1;
computer.add(edge);
// Floor grid for depth cues
const grid = new THREE.GridHelper(900, 60, 0x1a2436, 0x131b2a);
grid.position.y = -8.1;
scene.add(grid);

const blocks = new THREE.Group();
computer.add(blocks);

const boxGeo = new THREE.BoxGeometry(1, 1, 1);
boxGeo.translate(0, 0.5, 0); // grow upwards from y=0
const materials = {};
function materialFor(kind) {
  if (!materials[kind]) {
    materials[kind] = new THREE.MeshStandardMaterial({
      color: KIND_COLORS[kind] || KIND_COLORS.other,
      metalness: 0.15,
      roughness: 0.55,
      transparent: kind === 'free',
      opacity: kind === 'free' ? 0.35 : 1,
    });
  }
  return materials[kind];
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
let meshes = [];
let labels = [];

function currentNode() {
  let n = state.tree;
  for (const name of state.path) {
    const next = (n.children || []).find((c) => c.name === name && c.isDir);
    if (!next) break;
    n = next;
  }
  return n;
}

function heightFor(node, rootSize) {
  const share = node.size / Math.max(rootSize, 1);
  return 2 + 16 * Math.sqrt(share);
}

function clearBlocks() {
  for (const m of meshes) blocks.remove(m);
  for (const l of labels) blocks.remove(l);
  meshes = [];
  labels = [];
}

function layout() {
  clearBlocks();
  if (!state.tree) return;
  const node = currentNode();
  const items = [...(node.children || [])];
  const atRoot = state.path.length === 0;
  // At the top level show free space as part of the drive, so the slab is the whole disk.
  if (atRoot && state.disk && state.disk.roots[0]) {
    const { total, free } = state.disk.roots[0];
    if (total > 0) {
      const otherUsed = Math.max(0, total - free - node.size);
      if (free > 0) items.push({ name: 'Free space', size: free, kind: 'free', isDir: false, virtual: true });
      if (otherUsed > node.size * 0.02) items.push({ name: 'System & other users', size: otherUsed, kind: 'system', isDir: false, virtual: true, files: 0 });
    }
  }
  items.sort((a, b) => b.size - a.size);
  const rects = squarify(items, { x: -BASE_W / 2, y: -BASE_D / 2, w: BASE_W, h: BASE_D });
  const rootSize = items.reduce((s, i) => s + i.size, 0);
  for (const r of rects) placeBlock(r, 2, rootSize, 0);
  renderCrumbs();
  renderTop(node);
}

function placeBlock(r, y, rootSize, depth) {
  const item = r.item;
  const w = Math.max(0.2, r.w - GAP);
  const d = Math.max(0.2, r.h - GAP);
  if (w < 0.25 || d < 0.25) return;
  const h = item.kind === 'free' ? 0.6 : heightFor(item, rootSize) / (depth + 1);
  const mesh = new THREE.Mesh(boxGeo, materialFor(item.kind).clone());
  mesh.position.set(r.x + r.w / 2, y, r.y + r.h / 2);
  mesh.scale.set(w, 0.001, d);
  mesh.userData = { item, targetH: h, depth };
  mesh.castShadow = item.kind !== 'free';
  mesh.receiveShadow = true;
  blocks.add(mesh);
  meshes.push(mesh);
  if (w * d > 90 && depth === 0) addLabel(item, r.x + r.w / 2, y + h + 0.5, r.y + r.h / 2, Math.min(w, 40));
  // One level of nesting: children stacked on top of a folder, inset slightly.
  if (item.isDir && item.children && depth === 0 && w > 5 && d > 5) {
    const inset = Math.min(1.2, w * 0.08, d * 0.08);
    const inner = { x: r.x + GAP / 2 + inset, y: r.y + GAP / 2 + inset, w: w - inset * 2, h: d - inset * 2 };
    const kids = item.children.slice(0, 24);
    const subRects = squarify(kids, inner);
    for (const sr of subRects) placeBlock(sr, y + h, item.size, 1);
  }
}

function addLabel(item, x, y, z, width) {
  const text = item.name.length > 22 ? item.name.slice(0, 20) + '…' : item.name;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(11,15,23,0.75)';
  roundRect(ctx, 6, 6, 500, 116, 18);
  ctx.fill();
  ctx.fillStyle = '#e8edf5';
  ctx.font = 'bold 44px -apple-system, Segoe UI, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, 256, 56);
  ctx.font = '34px -apple-system, Segoe UI, system-ui, sans-serif';
  ctx.fillStyle = '#9fb0c8';
  ctx.fillText(fmt(item.size), 256, 102);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  const s = Math.max(10, Math.min(26, width * 0.6));
  sprite.scale.set(s, s / 4, 1);
  sprite.position.set(x, y + 1.5, z);
  sprite.renderOrder = 2;
  blocks.add(sprite);
  labels.push(sprite);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2(-2, -2);
let hovered = null;
const tooltip = document.getElementById('tooltip');
let downAt = null;

renderer.domElement.addEventListener('pointermove', (e) => {
  pointer.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1);
  tooltip.style.left = e.clientX + 14 + 'px';
  tooltip.style.top = e.clientY + 14 + 'px';
});
renderer.domElement.addEventListener('pointerdown', (e) => (downAt = [e.clientX, e.clientY]));
renderer.domElement.addEventListener('click', (e) => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  if (hovered && hovered.userData.item.isDir) {
    const item = hovered.userData.item;
    // Dive into the folder: path relative to the current node.
    const target = relativePath(item);
    if (target) {
      state.path = target;
      layout();
    }
  }
});
renderer.domElement.addEventListener('dblclick', () => {
  if (!hovered && state.path.length) {
    state.path.pop();
    layout();
  }
});

function relativePath(item) {
  // Find the folder by walking from the current node, one or two levels down.
  const node = currentNode();
  for (const c of node.children || []) {
    if (c === item) return [...state.path, c.name];
    for (const g of c.children || []) if (g === item) return [...state.path, c.name, g.name];
  }
  return null;
}

function updateHover() {
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(meshes, false);
  const hit = hits.length ? hits[0].object : null;
  if (hit !== hovered) {
    if (hovered) hovered.material.emissive.setHex(0x000000);
    hovered = hit;
    if (hovered) {
      hovered.material.emissive.setHex(0x334455);
      const it = hovered.userData.item;
      tooltip.innerHTML = `<b>${esc(it.name)}</b>${fmt(it.size)} · ${KIND_LABELS[it.kind] || it.kind}${it.files ? ` · ${it.files.toLocaleString()} files` : ''}${it.isDir ? ' · click to open' : ''}<div class="path">${esc(it.path || '')}</div>`;
      tooltip.hidden = false;
      renderer.domElement.style.cursor = it.isDir ? 'pointer' : 'default';
    } else {
      tooltip.hidden = true;
      renderer.domElement.style.cursor = 'default';
    }
  }
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  for (const m of meshes) {
    const t = m.userData.targetH;
    if (Math.abs(m.scale.y - t) > 0.01) m.scale.y += (t - m.scale.y) * 0.12;
  }
  if (!state.scanning) updateHover();
  renderer.render(scene, camera);
}
animate();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------------------------------------------------------------------------
// Panel UI
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);

function fmt(bytes) {
  if (bytes >= 1024 ** 4) return (bytes / 1024 ** 4).toFixed(2) + ' TB';
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + ' GB';
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(0) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}
function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

function renderDisk() {
  const root = state.disk && state.disk.roots[0];
  if (!root || !root.total) {
    $('gauge-label').textContent = state.tree ? `Scanned ${fmt(state.tree.size)}` : 'No scan yet';
    return;
  }
  const used = root.total - root.free;
  const pct = (used / root.total) * 100;
  $('gauge-fill').style.width = pct.toFixed(1) + '%';
  $('gauge-fill').classList.toggle('warn', pct > 85);
  $('gauge-label').textContent = `${fmt(used)} used of ${fmt(root.total)} · ${fmt(root.free)} free (${(100 - pct).toFixed(0)}%)`;
}

function renderCrumbs() {
  const el = $('crumbs');
  el.innerHTML = '';
  if (!state.tree) return;
  const parts = [state.tree.name, ...state.path];
  parts.forEach((name, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = ' › ';
      el.appendChild(sep);
    }
    const a = document.createElement(i === parts.length - 1 ? 'span' : 'a');
    a.textContent = name;
    if (i === parts.length - 1) a.className = 'here';
    else a.onclick = () => {
      state.path = state.path.slice(0, i);
      layout();
    };
    el.appendChild(a);
  });
}

function renderTop(node) {
  const ol = $('top-list');
  ol.innerHTML = '';
  for (const c of (node.children || []).slice(0, 12)) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="dot" style="background:#${(KIND_COLORS[c.kind] || KIND_COLORS.other).toString(16).padStart(6, '0')}"></span><span class="name">${esc(c.name)}</span><span class="size">${fmt(c.size)}</span>`;
    li.title = c.path || '';
    li.onclick = () => {
      if (c.isDir) {
        state.path = [...state.path, c.name];
        layout();
      } else if (c.path && !c.aggregate) api.reveal(c.path);
    };
    ol.appendChild(li);
  }
}

const GROUPS = [
  ['caches', 'Caches & temp files', 'Safe to clear; apps rebuild them.', 'empty'],
  ['trash', 'Trash / Recycle Bin', 'Already deleted by you; just not emptied.', 'empty'],
  ['oldDownloads', 'Old downloads & installers', 'Untouched for 60+ days.', 'trash'],
  ['largeStale', 'Large files not opened in 6 months', 'Over 500 MB. Check before removing.', 'trash'],
];

function renderClean() {
  const wrap = $('clean-groups');
  wrap.innerHTML = '';
  state.selected.clear();
  if (!state.suggestions) {
    $('clean-total').textContent = '';
    updateTrashButton();
    return;
  }
  let grand = 0;
  for (const [keyName, title, desc, mode] of GROUPS) {
    const g = state.suggestions[keyName];
    if (!g || !g.items.length) continue;
    grand += g.total;
    const det = document.createElement('details');
    det.className = 'group';
    det.open = keyName === 'caches';
    det.innerHTML = `<summary><span>${title}</span><span class="size">${fmt(g.total)}</span></summary><div class="hint">${desc}</div><ul></ul><span class="all">Select all</span>`;
    const ul = det.querySelector('ul');
    for (const it of g.items) {
      const li = document.createElement('li');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.onchange = () => {
        if (cb.checked) state.selected.set(it.path, { ...it, mode });
        else state.selected.delete(it.path);
        updateTrashButton();
      };
      li.appendChild(cb);
      li.insertAdjacentHTML('beforeend', `<span class="name" title="${esc(it.path)}">${esc(it.name)}</span><span class="size">${fmt(it.size)}</span><span class="reveal" title="Show in Finder / Explorer">⌕</span>`);
      li.querySelector('.reveal').onclick = () => api.reveal(it.path);
      ul.appendChild(li);
    }
    det.querySelector('.all').onclick = () => {
      ul.querySelectorAll('input').forEach((cb) => {
        if (!cb.checked) {
          cb.checked = true;
          cb.onchange();
        }
      });
    };
    wrap.appendChild(det);
  }
  $('clean-total').textContent = grand ? `· up to ${fmt(grand)}` : '';
  updateTrashButton();
}

function updateTrashButton() {
  const total = [...state.selected.values()].reduce((s, i) => s + i.size, 0);
  const btn = $('btn-trash');
  btn.disabled = state.selected.size === 0;
  btn.textContent = state.selected.size ? `Move ${state.selected.size} item${state.selected.size > 1 ? 's' : ''} to Trash (${fmt(total)})` : 'Move selected to Trash';
}

$('btn-trash').onclick = async () => {
  const items = [...state.selected.values()];
  if (!items.length) return;
  const btn = $('btn-trash');
  btn.disabled = true;
  btn.textContent = 'Moving to Trash…';
  let freed = 0;
  let failed = 0;
  for (const it of items) {
    const res = it.mode === 'empty' ? await api.emptyFolder(it.path) : await api.trash([it.path]);
    if (res.every((r) => r.ok)) freed += it.size;
    else failed += 1;
  }
  toast(`Moved ${fmt(freed)} to Trash${failed ? ` · ${failed} failed` : ''}. Empty the Trash to reclaim the space.`);
  await runScan(state.tree ? state.tree.path : null);
};

function renderLegend() {
  $('legend').innerHTML = Object.entries(KIND_LABELS)
    .map(([k, l]) => `<span><span class="dot" style="background:#${KIND_COLORS[k].toString(16).padStart(6, '0')}"></span>${l}</span>`)
    .join('');
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------
async function runScan(root) {
  if (state.scanning) return;
  state.scanning = true;
  $('btn-scan').disabled = true;
  $('progress').hidden = false;
  tooltip.hidden = true;
  const off = api.onProgress((p) => {
    $('progress-text').textContent = `Scanning… ${p.files.toLocaleString()} files · ${fmt(p.bytes)}`;
  });
  try {
    state.disk = await api.diskInfo();
    renderDisk();
    const { tree, suggestions } = await api.scan(root || undefined);
    state.tree = tree;
    state.suggestions = suggestions;
    state.path = [];
    state.disk = await api.diskInfo();
    renderDisk();
    renderClean();
    layout();
  } catch (err) {
    if (!/aborted/.test(String(err))) toast('Scan failed: ' + (err.message || err));
  } finally {
    off();
    state.scanning = false;
    $('btn-scan').disabled = false;
    $('progress').hidden = true;
  }
}

$('btn-scan').onclick = () => runScan(null);
$('btn-cancel').onclick = () => api.cancelScan();
$('btn-pick').onclick = async () => {
  const dir = await api.pickFolder();
  if (dir) runScan(dir);
  else if (DEMO) toast('Demo mode: folder picker is only available in the desktop app');
};

renderLegend();
api.diskInfo().then((d) => {
  state.disk = d;
  renderDisk();
});
if (DEMO) {
  $('btn-scan').textContent = 'Scan (demo data)';
  runScan(null);
}

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
// Façade tints per category (soft, city-like) and park green for free space.
const KIND_COLORS = {
  cache: 0xe8935a,
  trash: 0xaab0ba,
  downloads: 0xb48fe3,
  media: 0x6f9fe6,
  apps: 0x72c995,
  documents: 0xe9cf78,
  system: 0x8d96a6,
  other: 0xe3ddd0,
  free: 0x7cc46a,
};
const KIND_LABELS = { cache: 'Caches & temp', trash: 'Trash', downloads: 'Downloads & installers', media: 'Video, photo & audio', apps: 'Apps', documents: 'Documents', system: 'System', other: 'Other', free: 'Free space (park)' };
const BASE_W = 112;
const BASE_D = 86;
const STREET = 5; // gap between districts
const SIDEWALK = 1.6; // pavement ring inside a district
const LOT_GAP = 0.9; // gap between buildings in a district
const MAX_H = 46;

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
renderer.toneMappingExposure = 1.05;
container.appendChild(renderer.domElement);

const SKY = 0x3cb6b4;
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 320, 700);

const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.5, 2000);
camera.position.set(165, 150, 185);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2.1;
controls.minDistance = 50;
controls.maxDistance = 520;
controls.target.set(0, 14, 0);

scene.add(new THREE.HemisphereLight(0xe6f7f6, 0x5e6b73, 1.1));
const key = new THREE.DirectionalLight(0xfff1dc, 2.1);
key.position.set(90, 160, 70);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -140;
key.shadow.camera.right = 140;
key.shadow.camera.top = 140;
key.shadow.camera.bottom = -140;
key.shadow.camera.far = 500;
key.shadow.bias = -0.0005;
scene.add(key);
const fill = new THREE.DirectionalLight(0xbfe9ff, 0.5);
fill.position.set(-120, 60, -90);
scene.add(fill);

// Decorative clouds drifting behind the city.
const clouds = new THREE.Group();
scene.add(clouds);
(function makeClouds() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.92 });
  const geo = new THREE.SphereGeometry(1, 12, 10);
  const spots = [[-140, 90, -120], [110, 120, -160], [190, 70, 60], [-180, 55, 90], [30, 140, -220]];
  for (const [x, y, z] of spots) {
    const g = new THREE.Group();
    const n = 4 + Math.floor(Math.random() * 3);
    for (let i = 0; i < n; i++) {
      const s = new THREE.Mesh(geo, mat);
      const r = 3 + Math.random() * 4;
      s.scale.set(r * 1.4, r * 0.75, r);
      s.position.set((i - n / 2) * 7 + Math.random() * 3, Math.random() * 2, Math.random() * 4);
      g.add(s);
    }
    g.position.set(x, y, z);
    g.userData.speed = 0.4 + Math.random() * 0.4;
    clouds.add(g);
  }
})();

// The plinth: a chunky grey base; its top is the asphalt the districts sit on.
const city = new THREE.Group();
scene.add(city);
const plinth = new THREE.Mesh(
  new THREE.BoxGeometry(BASE_W + 10, 10, BASE_D + 10),
  new THREE.MeshStandardMaterial({ color: 0xc9ced4, metalness: 0.05, roughness: 0.85 })
);
plinth.position.y = -5;
plinth.receiveShadow = true;
city.add(plinth);
const asphalt = new THREE.Mesh(
  new THREE.BoxGeometry(BASE_W + 4, 0.6, BASE_D + 4),
  new THREE.MeshStandardMaterial({ color: 0x4a4f5a, roughness: 0.95 })
);
asphalt.position.y = 0.3;
asphalt.receiveShadow = true;
city.add(asphalt);
const kerb = new THREE.Mesh(
  new THREE.BoxGeometry(BASE_W + 10, 0.5, BASE_D + 10),
  new THREE.MeshStandardMaterial({ color: 0xe4e7eb, roughness: 0.9 })
);
kerb.position.y = 0.2;
kerb.receiveShadow = true;
city.add(kerb);

const blocks = new THREE.Group();
city.add(blocks);

// Shared geometries and materials.
const boxGeo = new THREE.BoxGeometry(1, 1, 1);
boxGeo.translate(0, 0.5, 0);
const coneGeo = new THREE.ConeGeometry(0.5, 1, 8);
coneGeo.translate(0, 0.5, 0);
const cylGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
cylGeo.translate(0, 0.5, 0);
const pavementMat = new THREE.MeshStandardMaterial({ color: 0xdedbd3, roughness: 0.9 });
const parkMat = new THREE.MeshStandardMaterial({ color: 0x8ccf76, roughness: 0.95 });
const roofMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.7 });
const spireMat = new THREE.MeshStandardMaterial({ color: 0xdfe3e8, metalness: 0.5, roughness: 0.3 });
const trunkMat = new THREE.MeshStandardMaterial({ color: 0x7a5a3a, roughness: 1 });
const canopyMat = new THREE.MeshStandardMaterial({ color: 0x4fae5f, roughness: 0.9 });
const laneMat = new THREE.MeshBasicMaterial({ color: 0xf2f0e6 });

// Window texture: white base with darker window cells; the material colour tints it.
const windowTex = (() => {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 64, 64);
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const lit = Math.random() < 0.25;
      ctx.fillStyle = lit ? 'rgba(255,240,200,0.55)' : 'rgba(40,52,74,0.55)';
      ctx.fillRect(x * 16 + 4, y * 16 + 3, 8, 10);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();

function facadeMaterial(kind, w, h, d) {
  const tex = windowTex.clone();
  tex.needsUpdate = true;
  tex.repeat.set(Math.max(1, Math.round(Math.max(w, d) / 2.2)), Math.max(1, Math.round(h / 2.2)));
  return new THREE.MeshStandardMaterial({ color: KIND_COLORS[kind] || KIND_COLORS.other, map: tex, roughness: 0.75, metalness: 0.05 });
}

// ---------------------------------------------------------------------------
// Layout: districts (top-level items) separated by streets; buildings inside.
// ---------------------------------------------------------------------------
let meshes = []; // hoverable: buildings and district pavements
let extras = []; // decoration: roofs, trees, labels, lanes
let treeSpots = [];

function currentNode() {
  let n = state.tree;
  for (const name of state.path) {
    const next = (n.children || []).find((c) => c.name === name && c.isDir);
    if (!next) break;
    n = next;
  }
  return n;
}

function clearBlocks() {
  for (const m of meshes) {
    blocks.remove(m);
    if (m.material.map) m.material.map.dispose();
    if (m.material !== pavementMat && m.material !== parkMat) m.material.dispose();
  }
  for (const e of extras) blocks.remove(e);
  meshes = [];
  extras = [];
  treeSpots = [];
}

let maxSizeInView = 1;
function heightFor(size) {
  return 2.5 + MAX_H * Math.sqrt(size / Math.max(maxSizeInView, 1));
}
// Lot (footprint) area grows slowly with size so big items become towers, not slabs.
function lotFor(size) {
  return 6 + 48 * Math.pow(size / Math.max(maxSizeInView, 1), 0.45);
}

const SUBURB_NAMES = { cache: 'Cache Town', trash: 'Trash Yard', downloads: 'Downloads', media: 'Media District', apps: 'App Quarter', documents: 'Document Row', system: 'System Heights', other: 'Old Town', free: 'Free Space Park' };

function layout() {
  clearBlocks();
  closeMenu();
  if (!state.tree) return;
  const node = currentNode();
  const items = [...(node.children || [])];
  const atRoot = state.path.length === 0;
  if (atRoot && state.disk && state.disk.roots[0]) {
    const { total, free } = state.disk.roots[0];
    if (total > 0) {
      const otherUsed = Math.max(0, total - free - node.size);
      if (free > 0) items.push({ name: 'Free space', size: free, kind: 'free', isDir: false, virtual: true });
      if (otherUsed > node.size * 0.02) items.push({ name: 'System & other users', size: otherUsed, kind: 'system', isDir: false, virtual: true, files: 0 });
    }
  }
  items.sort((a, b) => b.size - a.size);
  maxSizeInView = items.length ? items[0].size : 1;
  // Group into suburbs by category.
  const groups = new Map();
  for (const it of items) {
    const k = it.kind || 'other';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const suburbs = [...groups.entries()].map(([kind, list]) => {
    const lots = list.map((it) => ({ size: lotFor(it.size), item: it }));
    const area = lots.reduce((s, l) => s + l.size, 0);
    return { kind, list, lots, size: area * 1.3 + 24, total: list.reduce((s, i) => s + i.size, 0) };
  });
  suburbs.sort((a, b) => b.size - a.size);
  const rects = squarify(suburbs, { x: -BASE_W / 2, y: -BASE_D / 2, w: BASE_W, h: BASE_D });
  for (const r of rects) placeSuburb(r);
  placeTrees();
  renderCrumbs();
  renderTop(node);
}

function placeSuburb(r) {
  const sub = r.item;
  const x0 = r.x + STREET / 2;
  const z0 = r.y + STREET / 2;
  const w = r.w - STREET;
  const d = r.h - STREET;
  if (w < 1 || d < 1) return;
  const park = sub.kind === 'free';
  const slab = new THREE.Mesh(boxGeo, park ? parkMat : pavementMat);
  slab.position.set(x0 + w / 2, 0.6, z0 + d / 2);
  slab.scale.set(w, 0.5, d);
  slab.userData = { item: { name: SUBURB_NAMES[sub.kind] || sub.kind, size: sub.total, kind: sub.kind, isDir: false, virtual: true, files: sub.list.length, suburb: true }, targetH: 0.5, depth: 0, district: true };
  slab.receiveShadow = true;
  blocks.add(slab);
  meshes.push(slab);
  addLaneMarks(r);
  if (w > 6 && d > 6) ringTrees(x0, z0, w, d, park ? 2.2 : 4.5);
  if (park) {
    scatterTrees(x0 + SIDEWALK, z0 + SIDEWALK, w - SIDEWALK * 2, d - SIDEWALK * 2, Math.min(80, Math.floor((w * d) / 14)));
    addLabel({ name: SUBURB_NAMES.free, size: sub.total }, x0 + w / 2, 3, z0 + d / 2, w, true);
    return;
  }
  const inner = { x: x0 + SIDEWALK, y: z0 + SIDEWALK, w: w - SIDEWALK * 2, h: d - SIDEWALK * 2 };
  if (inner.w < 2 || inner.h < 2) return;
  const lotRects = squarify(sub.lots, inner);
  let tallest = 0;
  let tallestRect = null;
  for (const lr of lotRects) {
    const h = placeBuilding(lr, 1, LOT_GAP);
    if (h > tallest) {
      tallest = h;
      tallestRect = lr;
    }
  }
  // Suburb sign at the front edge; building labels on the biggest items.
  if (w * d > 90) addLabel({ name: SUBURB_NAMES[sub.kind] || sub.kind, size: sub.total }, x0 + w / 2, 1.2, z0 + d - 1, Math.min(w, 30), true);
  for (const lr of lotRects.slice(0, 3)) {
    if (lr.w * lr.h > 40) addLabel(lr.item.item, lr.x + lr.w / 2, 1.1 + heightFor(lr.item.item.size), lr.y + lr.h / 2, Math.min(lr.w + 6, 26));
  }
}

function placeBuilding(r, depth, gap) {
  const item = r.item.item;
  // Footprint is capped by the item's own lot size, so towers stay slender
  // even when a suburb has room to spare.
  const side = Math.sqrt(r.item.size) * 1.05;
  const w = Math.max(0.3, Math.min(r.w - gap, side * (0.9 + Math.random() * 0.2)));
  const d = Math.max(0.3, Math.min(r.h - gap, side * (0.9 + Math.random() * 0.2)));
  if (w < 0.6 || d < 0.6) return 0;
  const h = heightFor(item.size);
  const mat = facadeMaterial(item.kind, w, h, d);
  const b = new THREE.Mesh(boxGeo, mat);
  b.position.set(r.x + r.w / 2, 1.1, r.y + r.h / 2);
  b.scale.set(w, 0.001, d);
  b.userData = { item, targetH: h, depth };
  b.castShadow = true;
  b.receiveShadow = true;
  blocks.add(b);
  meshes.push(b);
  decorateRoof(b, w, h, d);
  return h;
}

function decorateRoof(b, w, h, d) {
  const x = b.position.x;
  const z = b.position.z;
  const top = 1.1 + h;
  const minSide = Math.min(w, d);
  if (h > 30 && minSide > 3) {
    // Tiered crown and spire for the tallest towers.
    const tier = new THREE.Mesh(boxGeo, b.material);
    tier.position.set(x, top, z);
    tier.scale.set(w * 0.6, h * 0.08, d * 0.6);
    tier.castShadow = true;
    blocks.add(tier);
    extras.push(tier);
    const spire = new THREE.Mesh(coneGeo, spireMat);
    spire.position.set(x, top + h * 0.08, z);
    spire.scale.set(Math.min(1.6, minSide * 0.25), h * 0.22, Math.min(1.6, minSide * 0.25));
    blocks.add(spire);
    extras.push(spire);
  } else if (minSide > 2.5 && h > 8) {
    // Rooftop plant room or water tank.
    const roof = new THREE.Mesh(Math.random() < 0.5 ? boxGeo : cylGeo, roofMat);
    roof.position.set(x + (Math.random() - 0.5) * w * 0.3, top, z + (Math.random() - 0.5) * d * 0.3);
    const s = Math.min(1.6, minSide * 0.3);
    roof.scale.set(s, 0.6 + Math.random() * 0.8, s);
    roof.castShadow = true;
    blocks.add(roof);
    extras.push(roof);
  }
}

function addLaneMarks(r) {
  // Dashed centre line along the street on the right and bottom edges of this district.
  const dash = (x, z, len, alongX) => {
    const m = new THREE.Mesh(boxGeo, laneMat);
    m.position.set(x, 0.62, z);
    m.scale.set(alongX ? len : 0.35, 0.03, alongX ? 0.35 : len);
    blocks.add(m);
    extras.push(m);
  };
  const right = r.x + r.w;
  const bottom = r.y + r.h;
  if (right < BASE_W / 2 - 1) for (let z = r.y + 1; z < r.y + r.h - 1; z += 3) dash(right, z + 0.7, 1.4, false);
  if (bottom < BASE_D / 2 - 1) for (let x = r.x + 1; x < r.x + r.w - 1; x += 3) dash(x + 0.7, bottom, 1.4, true);
}

function ringTrees(x0, z0, w, d, step) {
  const inset = SIDEWALK * 0.5;
  for (let x = x0 + inset + 1; x < x0 + w - inset; x += step) {
    treeSpots.push([x, z0 + inset]);
    treeSpots.push([x, z0 + d - inset]);
  }
  for (let z = z0 + inset + step; z < z0 + d - inset - 1; z += step) {
    treeSpots.push([x0 + inset, z]);
    treeSpots.push([x0 + w - inset, z]);
  }
}

function scatterTrees(x0, z0, w, d, n) {
  for (let i = 0; i < n; i++) treeSpots.push([x0 + Math.random() * w, z0 + Math.random() * d]);
}

function placeTrees() {
  const n = Math.min(treeSpots.length, 900);
  if (!n) return;
  const trunks = new THREE.InstancedMesh(cylGeo, trunkMat, n);
  const canopies = new THREE.InstancedMesh(new THREE.SphereGeometry(0.5, 8, 7), canopyMat, n);
  const m = new THREE.Matrix4();
  const color = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const [x, z] = treeSpots[i];
    const s = 0.8 + Math.random() * 0.6;
    m.makeScale(0.25 * s, 0.9 * s, 0.25 * s);
    m.setPosition(x, 1.1, z);
    trunks.setMatrixAt(i, m);
    m.makeScale(1.6 * s, 1.5 * s, 1.6 * s);
    m.setPosition(x, 1.1 + 0.9 * s + 0.6 * s, z);
    canopies.setMatrixAt(i, m);
    canopies.setColorAt(i, color.setHSL(0.3 + Math.random() * 0.06, 0.5, 0.42 + Math.random() * 0.12));
  }
  trunks.castShadow = canopies.castShadow = true;
  blocks.add(trunks);
  blocks.add(canopies);
  extras.push(trunks, canopies);
}

function addLabel(item, x, y, z, width, sign = false) {
  const text = item.name.length > 22 ? item.name.slice(0, 20) + '…' : item.name;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = sign ? 'rgba(79,209,197,0.92)' : 'rgba(20,28,40,0.78)';
  roundRect(ctx, 6, 6, 500, 116, 18);
  ctx.fill();
  ctx.fillStyle = sign ? '#06201d' : '#ffffff';
  ctx.font = 'bold 44px -apple-system, Segoe UI, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, 256, 56);
  ctx.font = '34px -apple-system, Segoe UI, system-ui, sans-serif';
  ctx.fillStyle = sign ? '#0d3a36' : '#cfe3ec';
  ctx.fillText(fmt(item.size), 256, 102);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
  const s = Math.max(10, Math.min(24, width * 0.55));
  sprite.scale.set(s, s / 4, 1);
  sprite.position.set(x, y + 3, z);
  sprite.renderOrder = 2;
  blocks.add(sprite);
  extras.push(sprite);
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
  if (hovered && !hovered.userData.district) openMenu(hovered.userData.item, e.clientX, e.clientY);
  else closeMenu();
});
renderer.domElement.addEventListener('dblclick', () => {
  closeMenu();
  if (!hovered && state.path.length) {
    state.path.pop();
    layout();
  }
});

function relativePath(item) {
  // Find the folder by walking from the current node, one or two levels down.
  const node = currentNode();
  for (const c of node.children || []) if (c === item) return [...state.path, c.name];
  return null;
}

function updateHover() {
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(meshes, false);
  const hit = hits.length ? hits[0].object : null;
  if (hit !== hovered) {
    if (hovered && !hovered.userData.district) hovered.material.emissive.setHex(0x000000);
    hovered = hit;
    if (hovered) {
      if (!hovered.userData.district) hovered.material.emissive.setHex(0x3a3a3a);
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
// Context menu at the cursor
// ---------------------------------------------------------------------------
const menu = document.getElementById('menu');
let menuItem = null;
function closeMenu() {
  menu.hidden = true;
  menuItem = null;
}
function openMenu(item, x, y) {
  menuItem = item;
  const canDemolish = item.path && !item.aggregate && !item.virtual;
  menu.innerHTML = `<div class="menu-title"><b>${esc(item.name)}</b><span>${fmt(item.size)} · ${KIND_LABELS[item.kind] || item.kind}</span></div>` +
    (item.isDir && !item.virtual ? `<button data-act="open">Walk in</button>` : '') +
    (item.path && !item.virtual ? `<button data-act="reveal">Show in Finder / Explorer</button>` : '') +
    (canDemolish ? `<button data-act="demolish" class="demolish">Demolish (move to Trash)</button>` : '') +
    (!canDemolish ? `<div class="menu-note">${item.suburb ? 'A suburb' : item.virtual ? 'Not a file' : 'Lots of small files'}: walk in to pick what to demolish.</div>` : '');
  menu.hidden = false;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = Math.min(x + 8, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(y + 8, window.innerHeight - mh - 8) + 'px';
  tooltip.hidden = true;
}
menu.addEventListener('click', async (e) => {
  const act = e.target.dataset && e.target.dataset.act;
  if (!act || !menuItem) return;
  const item = menuItem;
  if (act === 'open') {
    const target = relativePath(item);
    if (target) {
      state.path = target;
      layout();
    }
  } else if (act === 'reveal') {
    api.reveal(item.path);
    closeMenu();
  } else if (act === 'demolish') {
    menu.innerHTML = `<div class="menu-title"><b>Demolish ${esc(item.name)}?</b><span>${fmt(item.size)} goes to the Trash. You can restore it from there.</span></div><button data-act="confirm" class="demolish">Yes, demolish</button><button data-act="cancel">Cancel</button>`;
  } else if (act === 'cancel') {
    closeMenu();
  } else if (act === 'confirm') {
    closeMenu();
    await demolish(item);
  }
});
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());

async function demolish(item) {
  const mesh = meshes.find((m) => m.userData.item === item);
  const res = await api.trash([item.path]);
  if (!res.every((r) => r.ok)) {
    toast('Could not move to Trash: ' + (res.find((r) => !r.ok) || {}).error);
    return;
  }
  // Collapse animation, then update the tree locally (no rescan needed).
  if (mesh) {
    mesh.userData.targetH = 0.001;
    for (const ex of extras) if (Math.abs(ex.position.x - mesh.position.x) < 0.01 && Math.abs(ex.position.z - mesh.position.z) < 0.01) blocks.remove(ex);
  }
  await new Promise((r) => setTimeout(r, 450));
  removeFromTree(item);
  if (state.disk && state.disk.roots[0]) state.disk.roots[0].free += 0; // Trash still holds the bytes until emptied
  renderDisk();
  toast(`Demolished ${item.name} (${fmt(item.size)}). Empty the Trash to reclaim the space.`);
  layout();
}

function removeFromTree(item) {
  let n = state.tree;
  const chain = [n];
  for (const name of state.path) {
    n = (n.children || []).find((c) => c.name === name && c.isDir);
    if (!n) return;
    chain.push(n);
  }
  const idx = (n.children || []).indexOf(item);
  if (idx < 0) return;
  n.children.splice(idx, 1);
  for (const anc of chain) {
    anc.size -= item.size;
    anc.files -= item.files || 0;
  }
  if (state.suggestions) {
    for (const g of Object.values(state.suggestions)) {
      const before = g.items.length;
      g.items = g.items.filter((i) => i.path !== item.path && !i.path.startsWith(item.path + '/'));
      if (g.items.length !== before) g.total = g.items.reduce((s, i) => s + i.size, 0);
    }
    renderClean();
  }
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
function animate() {
  requestAnimationFrame(animate);
  controls.update();
  for (const c of clouds.children) {
    c.position.x += c.userData.speed * 0.03;
    if (c.position.x > 280) c.position.x = -280;
  }
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

// Exposed for automated UI checks.
window.__storageSaver = { state, openMenu, layout };

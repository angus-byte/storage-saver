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
        const kids = tree.children;
        for (let i = 1; i <= 24; i++) {
          await new Promise((r) => setTimeout(r, 200));
          const done = i % 3 === 0 ? kids[i / 3 - 1] : null;
          progressHandlers.forEach((cb) => cb({ files: i * 20400, bytes: i * 16e9, current: '/Users/angus/Movies/…', done }));
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
let night = false; // target state
let nightK = 0; // 0 = full day, 1 = full night; eased towards the target each frame
const clock = new THREE.Clock();
const NIGHT_SECONDS = 4.5;
let labelPairs = [];

// ---------------------------------------------------------------------------
// Scene setup
// ---------------------------------------------------------------------------
const container = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setClearColor(0x000000, 0); // the CSS gradient behind the canvas is the sky
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
container.appendChild(renderer.domElement);

const SKY = 0x3cb6b4;
const scene = new THREE.Scene();
scene.background = null;
scene.fog = new THREE.Fog(0x4fbdbb, 320, 700);

const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 0.5, 2000);
camera.position.set(165, 150, 185);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2.1;
controls.minDistance = 50;
controls.maxDistance = 520;
controls.target.set(0, 14, 0);

const hemi = new THREE.HemisphereLight(0xdff3ef, 0x6b6558, 1.0);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffd9a8, 2.6); // warm late-afternoon sun
key.position.set(120, 120, 90);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.left = -140;
key.shadow.camera.right = 140;
key.shadow.camera.top = 140;
key.shadow.camera.bottom = -140;
key.shadow.camera.far = 500;
key.shadow.bias = -0.0002;
key.shadow.radius = 6; // soft penumbra
key.shadow.blurSamples = 12;
scene.add(key);
const fill = new THREE.DirectionalLight(0x9fd8e8, 0.45);
fill.position.set(-120, 60, -90);
scene.add(fill);

// Decorative clouds drifting behind the city.
const clouds = new THREE.Group();
scene.add(clouds);
(function makeClouds() {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.5, depthWrite: false });
  const geo = new THREE.SphereGeometry(1, 12, 10);
  const spots = [[-120, 42, -90], [90, 55, -130], [170, 38, -30], [-150, 30, 70], [20, 60, -180], [-60, 36, 150], [-40, 70, -140], [140, 62, -110], [-190, 48, -20], [60, 34, 170], [200, 50, 40], [-100, 58, -200]];
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
    // Clouds whose track crosses the city fly above the tallest spire; the
    // low ones stay out beyond the plinth so nothing drifts through a tower.
    g.position.set(x, Math.abs(z) < 70 ? Math.max(y, 92) : y, z);
    if (z > 100) g.scale.setScalar(0.55); // the cloud nearest the camera stays small
    g.userData.speed = 0.4 + Math.random() * 0.4;
    clouds.add(g);
  }
})();

// Night sky: stars on a far dome, a moon, and a glow sprite texture for lamps and neon.
const nightOnly = []; // objects shown only at night
const stars = (() => {
  const n = 2200;
  const pos = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const u = Math.random();
    const v = Math.random();
    const theta = u * Math.PI * 2;
    const phi = Math.acos(1 - 2 * v); // the city floats in the sky, so stars go all the way round
    const r = 750;
    pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    pos[i * 3 + 1] = r * Math.cos(phi) + 20;
    pos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    c.setHSL(0.55 + Math.random() * 0.12, 0.3, 0.75 + Math.random() * 0.25);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const m = new THREE.PointsMaterial({ size: 6, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, fog: false });
  const pts = new THREE.Points(g, m);
  pts.visible = false;
  scene.add(pts);
  nightOnly.push(pts);
  return pts;
})();
const glowTex = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const gr = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.35, 'rgba(255,255,255,0.45)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gr;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
})();
function glow(x, y, z, size, color, opacity = 0.7, th = 0.4 + Math.random() * 0.45) {
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  sp.position.set(x, y, z);
  sp.scale.set(size, size, 1);
  sp.userData.baseOpacity = opacity;
  sp.userData.th = th; // the point in the sunset at which this light flicks on
  sp.visible = false;
  return sp;
}
const moon = new THREE.Mesh(new THREE.SphereGeometry(9, 24, 18), new THREE.MeshBasicMaterial({ color: 0xf6f2dc, fog: false, transparent: true, opacity: 0 }));
moon.position.set(-260, 170, -330);
moon.visible = false;
scene.add(moon);
nightOnly.push(moon);
const moonGlow = glow(-260, 170, -330, 70, 0xcfd8ff, 0.5, 0.3);
scene.add(moonGlow);
nightOnly.push(moonGlow);

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
const canopyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
const canopyGeo = new THREE.IcosahedronGeometry(0.5, 1);
const laneMat = new THREE.MeshBasicMaterial({ color: 0xf2f0e6 });

// Window texture: light facade with framed windows, floor bands and a few lit rooms.
// The material colour tints it, so one texture serves every category.
// Night version: black facade, only the lit rooms glow. Each building gets
// its own pattern (sparse, busy, floor bands, columns, checker, top floors
// working late, lobby only…) and palette so no two towers look alike.
function makeNightWindowTexture(seed, style = Math.floor(Math.random() * 7), palette = Math.floor(Math.random() * 4)) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 128, 128);
  let r = seed * 7 + 3;
  const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  const palettes = [
    ['#ffd58a', '#fff3c4', '#ffb86b'], // warm
    ['#dff4ff', '#ffffff', '#9fd8ff'], // cool office
    ['#ffd58a', '#9fd8ff', '#ffb3c6'], // mixed homes
    ['#b5ffd9', '#fff3c4', '#7df9ff'], // teal/green
  ][palette];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const v = rnd();
      let lit = false;
      switch (style) {
        case 0: lit = v < 0.22; break; // sparse
        case 1: lit = v < 0.6; break; // busy
        case 2: lit = y % 2 === 0 ? v < 0.75 : v < 0.1; break; // floor bands
        case 3: lit = x % 2 === 0 ? v < 0.7 : v < 0.12; break; // columns
        case 4: lit = (x + y) % 2 === 0 ? v < 0.65 : v < 0.08; break; // checker
        case 5: lit = y < 3 ? v < 0.7 : v < 0.15; break; // top floors working late
        default: lit = y > 5 ? v < 0.75 : v < 0.12; // lobby and lower floors
      }
      if (lit) {
        ctx.fillStyle = palettes[Math.floor(rnd() * palettes.length)];
        ctx.globalAlpha = 0.7 + rnd() * 0.3;
        ctx.fillRect(x * 16 + 3, y * 16 + 2, 10, 9);
        ctx.globalAlpha = 1;
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}


function makeWindowTexture(seed) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 128, 128);
  // Floor bands.
  ctx.fillStyle = 'rgba(0,0,0,0.10)';
  for (let y = 0; y < 128; y += 16) ctx.fillRect(0, y + 13, 128, 3);
  // Windows with frames.
  let r = seed;
  const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const px = x * 16 + 3;
      const py = y * 16 + 2;
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(px - 1, py - 1, 12, 11);
      const v = rnd();
      ctx.fillStyle = v < 0.18 ? 'rgba(255,236,190,0.75)' : v < 0.3 ? 'rgba(140,190,215,0.55)' : 'rgba(45,62,88,0.6)';
      ctx.fillRect(px, py, 10, 9);
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      ctx.fillRect(px, py, 10, 2);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const windowTextures = [1, 2, 3, 4].map(makeWindowTexture);

function facadeMaterial(kind, w, h, d, variant = 0) {
  const tex = windowTextures[variant % windowTextures.length].clone();
  tex.needsUpdate = true;
  tex.repeat.set(Math.max(1, Math.round(Math.max(w, d) / 2.6)), Math.max(1, Math.round(h / 2.6)));
  const color = new THREE.Color(KIND_COLORS[kind] || KIND_COLORS.other);
  const hsl = {};
  color.getHSL(hsl);
  color.setHSL(hsl.h + (Math.random() - 0.5) * 0.03, hsl.s, Math.min(0.9, hsl.l + (Math.random() - 0.5) * 0.12));
  const em = makeNightWindowTexture(Math.floor(Math.random() * 1e6));
  em.repeat.copy(tex.repeat);
  const mat = new THREE.MeshStandardMaterial({ color, map: tex, roughness: 0.7, metalness: 0.05, emissive: 0xffffff, emissiveMap: em, emissiveIntensity: night ? 0.9 : 0 });
  mat.userData.dayI = 0;
  mat.userData.nightI = 0.9;
  mat.userData.th = 0.35 + Math.random() * 0.6;
  return mat;
}
function trimMaterial(base) {
  const c = base.color.clone();
  const hsl = {};
  c.getHSL(hsl);
  c.setHSL(hsl.h, hsl.s * 0.8, Math.max(0.15, hsl.l * 0.72));
  return new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 });
}
const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fd3e8, roughness: 0.2, metalness: 0.4 });
const darkMat = new THREE.MeshStandardMaterial({ color: 0x2b3240, roughness: 0.8 });
const awningMat = new THREE.MeshStandardMaterial({ color: 0xd94f4f, roughness: 0.9 });
const tankMat = new THREE.MeshStandardMaterial({ color: 0x8a6a4e, roughness: 0.9 });
const acMat = new THREE.MeshStandardMaterial({ color: 0xcfd4da, roughness: 0.8 });
const poleMat = new THREE.MeshStandardMaterial({ color: 0x5a6068, roughness: 0.6, metalness: 0.5 });
const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff1c2, emissive: 0xffd27a, emissiveIntensity: 0.4, roughness: 0.4 });
lampMat.userData.dayI = 0.4;
lampMat.userData.nightI = 2.6;
const whiteMat = new THREE.MeshStandardMaterial({ color: 0xf4f2ea, roughness: 0.9 });
const vehicleMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0.3 });
const personMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
const skinMat = new THREE.MeshStandardMaterial({ color: 0xf0c9a6, roughness: 0.9 });
const courtMat = new THREE.MeshStandardMaterial({ color: 0xd98a4b, roughness: 0.95 });
const waterMat = new THREE.MeshStandardMaterial({ color: 0x5bc0e8, roughness: 0.15, metalness: 0.2 });
const benchMat = new THREE.MeshStandardMaterial({ color: 0x8b5e3c, roughness: 0.9 });
const stoneMat = new THREE.MeshStandardMaterial({ color: 0xcfcac0, roughness: 0.9 });
const signalMat = new THREE.MeshStandardMaterial({ color: 0x23272e, roughness: 0.7 });
const BILLBOARD_COLORS = [0xff6b6b, 0xffd166, 0x06d6a0, 0x4cc9f0, 0xf72585, 0xff9f1c];
const sphereGeo = new THREE.SphereGeometry(0.5, 8, 6);
const discGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 24);
discGeo.translate(0, 0.5, 0);
const torusGeo = new THREE.TorusGeometry(0.5, 0.05, 6, 20);
torusGeo.rotateX(Math.PI / 2);

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
    if (m.material.emissiveMap) m.material.emissiveMap.dispose();
    if (m.material !== pavementMat && m.material !== parkMat) m.material.dispose();
  }
  for (const e of extras) blocks.remove(e);
  meshes = [];
  extras = [];
  treeSpots = [];
  cars = [];
  people = [];
  labelPairs = [];
  carMesh = cabMesh = headMesh = tailMesh = peopleBody = peopleHead = peopleHat = null;
  site = null;
  // Drop night-only objects that belonged to the old layout.
  for (let i = nightOnly.length - 1; i >= 0; i--) if (nightOnly[i].parent === blocks || !nightOnly[i].parent) nightOnly.splice(i, 1);
}

let maxSizeInView = 1;
function heightFor(size) {
  return 2.5 + MAX_H * Math.sqrt(size / Math.max(maxSizeInView, 1));
}
// Lot (footprint) area grows slowly with size so big items become towers, not slabs.
function lotFor(size) {
  return 6 + 48 * Math.pow(size / Math.max(maxSizeInView, 1), 0.45);
}

const SUBURB_NAMES = { cache: 'Cache Canyon', trash: 'Trash Flats', downloads: 'Downtown Downloads', media: 'Media Heights', apps: 'App Avenue', documents: 'Document Docks', system: 'System Hills', other: 'Odds & Ends Village', free: 'Free Space Park' };

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
  buildStreets(rects);
  buildPeople(rects);
  placeTrees();
  renderCrumbs();
  renderTop(node);
  renderLeave(node);
  applyNight();
}

// Day / night. applyNight blends every light, colour and label for the
// current nightK; the sun sets through orange before the moon takes over,
// and each light flicks on at its own point in the dusk.
const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const lerpHex = (target, a, b, k) => target.setHex(a).lerp(_c2.setHex(b), k);
function applyNight() {
  const k = nightK;
  document.documentElement.style.setProperty('--night', k.toFixed(3));
  document.body.classList.toggle('night', k > 0.5);
  $('btn-night').textContent = night ? '☀ Day' : '☾ Night';
  scene.fog.color.copy(lerpHex(_c1, 0x4fbdbb, 0x0c1430, k));
  hemi.color.copy(lerpHex(_c1, 0xdff3ef, 0x3a4a7a, k));
  hemi.groundColor.copy(lerpHex(_c1, 0x6b6558, 0x0c1020, k));
  hemi.intensity = 1.0 + (0.35 - 1.0) * k;
  fill.intensity = 0.45 + (0.15 - 0.45) * k;
  renderer.toneMappingExposure = 1.1 + (0.95 - 1.1) * k;
  // Sun: warm and high → low orange at the horizon → cool moonlight from the other side.
  if (k < 0.5) {
    const u = k / 0.5;
    key.color.copy(lerpHex(_c1, 0xffd9a8, 0xff7a3d, u));
    key.intensity = 2.6 + (1.1 - 2.6) * u;
    key.position.set(120 + (170 - 120) * u, 120 + (14 - 120) * u, 90 + (-40 - 90) * u);
  } else {
    const u = (k - 0.5) / 0.5;
    key.color.copy(lerpHex(_c1, 0xff7a3d, 0x9fb4ff, u));
    key.intensity = 1.1 + (0.55 - 1.1) * u;
    key.position.set(170 + (-90 - 170) * u, 14 + (130 - 14) * u, -40 + (-70 + 40) * u);
  }
  stars.visible = k > 0.02;
  stars.material.opacity = (0.78 + 0.2 * Math.sin(clock.elapsedTime * 2.3)) * Math.max(0, (k - 0.3) / 0.7);
  moon.visible = k > 0.3;
  moon.material.opacity = Math.max(0, (k - 0.3) / 0.5);
  const onAt = (th) => (k <= th ? 0 : Math.min(1, (k - th) / 0.06));
  const flicker = (th) => (k > th && k < th + 0.06 && Math.random() < 0.4 ? 0 : 1);
  const setMat = (mat) => {
    if (!mat || !mat.userData || mat.userData.nightI === undefined) return;
    const th = mat.userData.th === undefined ? 0.5 : mat.userData.th;
    const on = onAt(th) * flicker(th);
    mat.emissiveIntensity = mat.userData.dayI + (mat.userData.nightI - mat.userData.dayI) * on;
  };
  for (const m of meshes) setMat(m.material);
  for (const e of extras) setMat(e.material);
  for (const o of nightOnly) {
    if (o.userData.th !== undefined) {
      const on = onAt(o.userData.th) * flicker(o.userData.th);
      o.visible = on > 0;
      o.material.opacity = o.userData.baseOpacity * on;
    } else if (o === headMesh || o === tailMesh) o.visible = k > 0.45;
  }
  for (const lp of labelPairs) {
    lp.day.material.opacity = 1 - k;
    lp.night.material.opacity = k;
  }
  clouds.children.forEach((c) => c.children.forEach((s) => (s.material.opacity = 0.5 + (0.22 - 0.5) * k)));
}
function toggleNight() {
  night = !night;
  $('btn-night').textContent = night ? '☀ Day' : '☾ Night';
}
function stepNight(dt) {
  const target = night ? 1 : 0;
  if (Math.abs(nightK - target) < 0.0005) {
    if (nightK !== target) {
      nightK = target;
      applyNight();
    }
    return;
  }
  const step = dt / NIGHT_SECONDS;
  nightK = nightK < target ? Math.min(target, nightK + step) : Math.max(target, nightK - step);
  applyNight();
}

// Floating "Leave" button over the city when you have walked into a folder.
function renderLeave(node) {
  const btn = $('btn-leave');
  if (!state.path.length) {
    btn.hidden = true;
    return;
  }
  btn.hidden = false;
  btn.textContent = `← Leave ${node.name}`;
}
function leaveBuilding() {
  if (!state.path.length) return;
  closeMenu();
  state.path.pop();
  layout();
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
  streetLights(x0, z0, w, d);
  trafficSignals(x0, z0, w, d);
  if (park) {
    const keepOut = buildPark(x0, z0, w, d);
    scatterTrees(x0 + SIDEWALK, z0 + SIDEWALK, w - SIDEWALK * 2, d - SIDEWALK * 2, Math.min(70, Math.floor((w * d) / 16)), keepOut);
    addLabel({ name: SUBURB_NAMES.free, size: sub.total }, x0 + w / 2, 3, z0 + d / 2, w, true);
    return;
  }
  if (w > 14) busStop(x0 + w * 0.3, z0 + d - 0.9);
  const inner = { x: x0 + SIDEWALK, y: z0 + SIDEWALK, w: w - SIDEWALK * 2, h: d - SIDEWALK * 2 };
  if (inner.w < 2 || inner.h < 2) return;
  const lotRects = squarify(sub.lots, inner);
  let tallest = 0;
  let tallestRect = null;
  for (const lr of lotRects) {
    const before = meshes.length;
    const h = placeBuilding(lr, 1, LOT_GAP);
    if (h > tallest) {
      tallest = h;
      tallestRect = lr;
    }
    const built = meshes.length > before ? meshes[meshes.length - 1].userData.footprint : null;
    fillLot(lr, built);
  }
  // Suburb sign at the front edge; building labels on the biggest items.
  if (w * d > 90) addLabel({ name: SUBURB_NAMES[sub.kind] || sub.kind, size: sub.total }, x0 + w / 2, 1.2, z0 + d - 1, Math.min(w, 30), true);
  for (const lr of lotRects.slice(0, 3)) {
    if (lr.w * lr.h > 40) {
      const bh = heightFor(lr.item.item.size);
      addLabel(lr.item.item, lr.x + lr.w / 2, 1.1 + bh + (bh > 30 ? bh * 0.55 : 2), lr.y + lr.h / 2, Math.min(lr.w + 6, 26));
    }
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
  let h = heightFor(item.size);
  const landmark = landmarkFor(item);
  if (landmark === 'library') h = Math.min(h, 9);
  const mat = landmark ? new THREE.MeshStandardMaterial({ color: 0xe9e2d0, roughness: 0.85 }) : facadeMaterial(item.kind, w, h, d, Math.floor(Math.random() * 4));
  const b = new THREE.Mesh(boxGeo, mat);
  b.position.set(r.x + r.w / 2, 1.1, r.y + r.h / 2);
  b.scale.set(w, 0.001, d);
  // Build-up animation: a wave sweeps across the city; each building grows
  // from the ground with a playful overshoot, and its details pop on as the
  // shaft reaches them (roofs last).
  const delay = ((b.position.x + b.position.z + BASE_W / 2 + BASE_D / 2) / (BASE_W + BASE_D)) * 0.7 + Math.random() * 0.25;
  b.userData = { item, targetH: h, depth, build: { t: -delay, dur: 0.7 + Math.min(0.6, h / 60) }, pieces: [] };
  b.castShadow = true;
  b.receiveShadow = true;
  blocks.add(b);
  meshes.push(b);
  activeBuilding = b;
  if (landmark === 'library') decorateLibrary(b, w, h, d, heightFor(item.size));
  else decorate(b, w, h, d);
  activeBuilding = null;
  b.userData.footprint = { x: b.position.x, z: b.position.z, w, d };
  return h;
}
let activeBuilding = null;
const easeOutBack = (p) => 1 + 2.70158 * Math.pow(p - 1, 3) + 1.70158 * Math.pow(p - 1, 2);

// Decoration helpers: every piece is parented to the building's position so
// a demolish removes them together (see demolish()).
function piece(geo, mat, x, y, z, sx, sy, sz, shadow = true) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  if (activeBuilding) {
    m.userData.attachY = y - activeBuilding.position.y;
    m.userData.finalScale = [sx, sy, sz];
    m.userData.pop = 0;
    m.scale.set(0, 0, 0);
    activeBuilding.userData.pieces.push(m);
  }
  m.castShadow = shadow;
  m.receiveShadow = true;
  blocks.add(m);
  extras.push(m);
  return m;
}

// Folders with a well-known role get a landmark instead of a generic tower.
function landmarkFor(item) {
  if (!item.isDir) return null;
  const n = item.name.toLowerCase();
  if (n === 'library') return 'library';
  return null;
}

const columnMat = new THREE.MeshStandardMaterial({ color: 0xf4efe2, roughness: 0.8 });
const domeMat = new THREE.MeshStandardMaterial({ color: 0x5f9c8a, roughness: 0.5, metalness: 0.3 });
const pyramidGeo = new THREE.ConeGeometry(0.5, 1, 4);
pyramidGeo.translate(0, 0.5, 0);
pyramidGeo.rotateY(Math.PI / 4);

// A classical library: steps, colonnade, entablature, pediment and a dome
// whose size carries the folder's size.
function decorateLibrary(b, w, h, d, fullH) {
  const x = b.position.x;
  const z = b.position.z;
  const base = 1.1;
  const top = base + h;
  const front = z + d / 2;
  // Steps.
  piece(boxGeo, stoneMat, x, base, z, w + 1.6, 0.35, d + 1.6, false);
  piece(boxGeo, stoneMat, x, base + 0.35, z, w + 0.9, 0.35, d + 0.9, false);
  // Colonnade along the front.
  const n = Math.max(3, Math.floor(w / 1.1));
  for (let i = 0; i < n; i++) {
    const cx = x - w / 2 + 0.55 + (i * (w - 1.1)) / Math.max(1, n - 1);
    piece(cylGeo, columnMat, cx, base + 0.7, front + 0.55, 0.32, h - 0.7, 0.32);
    piece(boxGeo, columnMat, cx, base + h - 0.05, front + 0.55, 0.5, 0.2, 0.5, false);
  }
  // Entablature and pediment over the portico.
  piece(boxGeo, columnMat, x, top, z + d * 0.25, w + 0.4, 0.6, d * 0.5 + 1.3);
  const ped = piece(pyramidGeo, stoneMat, x, top + 0.6, front + 0.1, w + 0.2, 1.4, 1.6);
  ped.scale.z = 1.6;
  // Doorway.
  piece(boxGeo, darkMat, x, base + 0.7, front + 0.08, Math.min(1.6, w * 0.3), 2.2, 0.1, false);
  // Dome: taller for bigger folders.
  const r = Math.min(w, d) * 0.38;
  const domeH = Math.max(2.5, Math.min(fullH * 0.35, 14));
  piece(cylGeo, columnMat, x, top, z - d * 0.1, r * 1.1, 1.2, r * 1.1);
  const dome = piece(sphereGeo, domeMat, x, top + 1.2 - domeH * 0.1, z - d * 0.1, r * 2, domeH * 1.2, r * 2);
  dome.castShadow = true;
  piece(cylGeo, columnMat, x, top + 1.2 + domeH * 0.5, z - d * 0.1, r * 0.35, 1.0, r * 0.35, false);
  piece(coneGeo, spireMat, x, top + 2.2 + domeH * 0.5, z - d * 0.1, r * 0.3, 1.2, r * 0.3, false);
  // "LIBRARY" lettering along the entablature as a dark strip.
  piece(boxGeo, signalMat, x, top + 0.15, front + 0.95, w * 0.5, 0.3, 0.03, false);
}

function decorate(b, w, h, d) {
  const x = b.position.x;
  const z = b.position.z;
  const base = 1.1;
  const top = base + h;
  const minSide = Math.min(w, d);
  const trim = trimMaterial(b.material);
  const front = z + d / 2; // the face towards the camera

  // Ground floor: darker podium band and an entrance with an awning.
  if (minSide > 1.4) {
    piece(boxGeo, trim, x, base, z, w + 0.16, Math.min(1.6, h * 0.12), d + 0.16);
    if (h > 6 && w > 2) {
      const doorW = Math.min(1.1, w * 0.3);
      piece(boxGeo, darkMat, x, base + 0.02, front + 0.18, doorW, 1.1, 0.12, false); // proud of the podium so it never z-fights
      piece(boxGeo, awningMat, x, base + 1.15, front + 0.25, doorW + 0.5, 0.1, 0.55);
    }
  }

  if (h > 30 && minSide > 3) {
    // Skyscraper: setbacks, cornices, crown, spire and antenna.
    const t1 = piece(boxGeo, b.material, x, top, z, w * 0.72, h * 0.12, d * 0.72);
    const top1 = top + h * 0.12;
    piece(boxGeo, trim, x, top1 - 0.1, z, w * 0.72 + 0.2, 0.25, d * 0.72 + 0.2);
    piece(boxGeo, b.material, x, top1, z, w * 0.48, h * 0.09, d * 0.48);
    const top2 = top1 + h * 0.09;
    piece(boxGeo, trim, x, top2 - 0.1, z, w * 0.48 + 0.2, 0.25, d * 0.48 + 0.2);
    piece(boxGeo, glassMat, x, top2, z, w * 0.3, h * 0.05, d * 0.3);
    const top3 = top2 + h * 0.05;
    piece(coneGeo, spireMat, x, top3, z, Math.min(1.4, minSide * 0.22), h * 0.2, Math.min(1.4, minSide * 0.22));
    piece(cylGeo, spireMat, x, top3 + h * 0.2, z, 0.12, h * 0.08, 0.12, false);
    // Cornice ledges along the shaft.
    piece(boxGeo, trim, x, base + h * 0.35, z, w + 0.2, 0.22, d + 0.2);
    piece(boxGeo, trim, x, top - 0.25, z, w + 0.24, 0.25, d + 0.24);
    t1.material = b.material;
  } else if (h > 12 && minSide > 2.2) {
    // Mid-rise: cornice, parapet, rooftop water tank or plant room, AC units.
    if (Math.random() < 0.5) neonSign(x + (Math.random() - 0.5) * w * 0.4, base + h * 0.55, front + 0.12, Math.min(h * 0.35, 6), Math.random() < 0.5);
    piece(boxGeo, trim, x, top - 0.2, z, w + 0.22, 0.22, d + 0.22);
    const roll = Math.random();
    if (roll < 0.4) {
      // Water tank on legs.
      const tx = x + (Math.random() - 0.5) * w * 0.4;
      const tz = z + (Math.random() - 0.5) * d * 0.4;
      piece(cylGeo, darkMat, tx, top, tz, 0.5, 0.5, 0.5, false);
      piece(cylGeo, tankMat, tx, top + 0.5, tz, 0.9, 1.1, 0.9);
      piece(coneGeo, trim, tx, top + 1.6, tz, 0.95, 0.35, 0.95);
    } else if (roll < 0.75) {
      // Penthouse / plant room with a door.
      piece(boxGeo, b.material, x + (Math.random() - 0.5) * w * 0.3, top, z + (Math.random() - 0.5) * d * 0.3, w * 0.45, 1.1, d * 0.45);
    }
    // A couple of AC units.
    for (let i = 0; i < 2; i++) piece(boxGeo, acMat, x + (Math.random() - 0.5) * w * 0.7, top, z + (Math.random() - 0.5) * d * 0.7, 0.45, 0.3, 0.45, false);
    if (Math.random() < 0.5) piece(cylGeo, spireMat, x + w * 0.3, top, z - d * 0.3, 0.06, 2.2 + Math.random() * 2, 0.06, false);
    if (Math.random() < 0.35 && w > 3) {
      // Rooftop billboard facing the camera.
      const bw = Math.min(w * 0.8, 3.2);
      piece(cylGeo, poleMat, x - bw * 0.35, top, z + d * 0.3, 0.08, 1.2, 0.08, false);
      piece(cylGeo, poleMat, x + bw * 0.35, top, z + d * 0.3, 0.08, 1.2, 0.08, false);
      const bbc = BILLBOARD_COLORS[Math.floor(Math.random() * BILLBOARD_COLORS.length)];
      const bbm = new THREE.MeshStandardMaterial({ color: bbc, emissive: bbc, emissiveIntensity: 0.15, roughness: 0.6 });
      bbm.userData.dayI = 0.15;
      bbm.userData.nightI = 1.6;
      bbm.userData.th = 0.5 + Math.random() * 0.4;
      const bb = piece(boxGeo, bbm, x, top + 1.1, z + d * 0.3, bw, 1.4, 0.12);
      const bg = glow(x, top + 1.1, z + d * 0.3 + 0.3, bw * 1.6, bbc, 0.45, bbm.userData.th);
      blocks.add(bg);
      extras.push(bg);
      nightOnly.push(bg);
      piece(boxGeo, whiteMat, x, top + 1.3, z + d * 0.3 + 0.09, bw * 0.7, 0.35, 0.02, false);
      bb.castShadow = true;
    }
  } else if (minSide > 1.5) {
    // Low-rise: parapet and a chimney or skylight.
    piece(boxGeo, trim, x, top - 0.15, z, w + 0.18, 0.18, d + 0.18);
    if (Math.random() < 0.6) piece(boxGeo, trim, x + (Math.random() - 0.5) * w * 0.5, top, z + (Math.random() - 0.5) * d * 0.5, 0.4, 0.7, 0.4, false);
    else piece(boxGeo, glassMat, x, top, z, w * 0.4, 0.25, d * 0.4, false);
  }
}

// ---------------------------------------------------------------------------
// Lot fillers: the pavement left around a building gets small city props so
// no block is a blank slab (parking, cafés, kiosks, gardens, playgrounds…).
// ---------------------------------------------------------------------------
const CELL = 3.0;
const PROP_COLORS = [0xff6b6b, 0xffd166, 0x4cc9f0, 0xf72585, 0x90be6d, 0xff9f1c];
const propMats = {};
function propMat(hex) {
  if (!propMats[hex]) propMats[hex] = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.85 });
  return propMats[hex];
}
const asphaltTileMat = new THREE.MeshStandardMaterial({ color: 0x565b66, roughness: 0.95 });
const soilMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2e, roughness: 1 });
const hedgeMat = new THREE.MeshStandardMaterial({ color: 0x3f9a4f, roughness: 0.9 });

function fillLot(lr, b) {
  const x0 = lr.x + LOT_GAP / 2;
  const z0 = lr.y + LOT_GAP / 2;
  const w = lr.w - LOT_GAP;
  const d = lr.h - LOT_GAP;
  const strips = [];
  if (!b) {
    strips.push({ x: x0, z: z0, w, d });
  } else {
    const m = 0.7; // breathing room around the building
    const bx0 = b.x - b.w / 2 - m;
    const bx1 = b.x + b.w / 2 + m;
    const bz0 = b.z - b.d / 2 - m;
    const bz1 = b.z + b.d / 2 + m;
    strips.push({ x: x0, z: z0, w, d: bz0 - z0 }); // top
    strips.push({ x: x0, z: bz1, w, d: z0 + d - bz1 }); // bottom
    strips.push({ x: x0, z: bz0, w: bx0 - x0, d: bz1 - bz0 }); // left
    strips.push({ x: bx1, z: bz0, w: x0 + w - bx1, d: bz1 - bz0 }); // right
  }
  for (const st of strips) {
    if (st.w < CELL || st.d < CELL) continue;
    const cols = Math.floor(st.w / CELL);
    const rows = Math.floor(st.d / CELL);
    const ox = st.x + (st.w - cols * CELL) / 2;
    const oz = st.z + (st.d - rows * CELL) / 2;
    // A strip of several cells gets one theme so it reads as a place, not clutter.
    const theme = Math.random();
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const cx = ox + (i + 0.5) * CELL;
        const cz = oz + (j + 0.5) * CELL;
        const r = Math.random();
        if (r < 0.3) continue; // leave open pavement
        if (r < 0.5) {
          piece(boxGeo, parkMat, cx, 1.1, cz, CELL - 0.5, 0.05, CELL - 0.5, false); // lawn
          if (Math.random() < 0.5) treeSpots.push([cx + (Math.random() - 0.5), cz + (Math.random() - 0.5)]);
          continue;
        }
        placeProp(cx, cz, Math.random() < 0.7 ? theme : Math.random(), (i + j) % 2 === 0);
      }
    }
  }
}

function placeProp(x, z, theme, alt) {
  const y = 1.1;
  if (theme < 0.22) {
    // Parking bay with a car in most spaces.
    piece(boxGeo, asphaltTileMat, x, y, z, CELL - 0.1, 0.06, CELL - 0.1, false);
    piece(boxGeo, laneMat, x - CELL / 2 + 0.1, y + 0.06, z, 0.08, 0.02, CELL - 0.4, false);
    if (Math.random() < 0.7) {
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(Math.random(), 0.55, 0.5), roughness: 0.5, metalness: 0.3 });
      piece(boxGeo, mat, x, y + 0.06, z, 0.8, 0.45, 1.6);
      piece(boxGeo, glassMat, x, y + 0.51, z + 0.1, 0.7, 0.3, 0.85, false);
    }
  } else if (theme < 0.4) {
    // Café terrace: umbrella, table, chairs.
    const c = PROP_COLORS[Math.floor(Math.random() * PROP_COLORS.length)];
    piece(cylGeo, poleMat, x, y, z, 0.06, 2.0, 0.06, false);
    piece(coneGeo, propMat(c), x, y + 1.6, z, 1.7, 0.45, 1.7);
    piece(discGeo, whiteMat, x, y + 0.55, z, 0.8, 0.06, 0.8, false);
    piece(cylGeo, poleMat, x, y, z, 0.08, 0.55, 0.08, false);
    for (const [dx, dz] of [[0.65, 0], [-0.65, 0], [0, 0.65], [0, -0.65]]) piece(boxGeo, benchMat, x + dx, y, z + dz, 0.35, 0.4, 0.35, false);
  } else if (theme < 0.52) {
    // Flower bed.
    piece(boxGeo, soilMat, x, y, z, CELL - 0.5, 0.25, CELL - 0.5, false);
    for (let k = 0; k < 5; k++) {
      const c = [0xff5d8f, 0xffd23f, 0xff8c42, 0xffffff, 0xb388ff][k];
      piece(sphereGeo, propMat(c), x + (Math.random() - 0.5) * (CELL - 1), y + 0.35, z + (Math.random() - 0.5) * (CELL - 1), 0.35, 0.3, 0.35, false);
    }
  } else if (theme < 0.62) {
    // Kiosk with striped awning.
    piece(boxGeo, whiteMat, x, y, z, 1.5, 1.3, 1.3);
    piece(boxGeo, propMat(alt ? 0xff6b6b : 0x4cc9f0), x, y + 1.3, z + 0.35, 1.8, 0.1, 0.9);
    piece(boxGeo, signalMat, x, y + 0.35, z + 0.66, 0.9, 0.5, 0.04, false);
    piece(boxGeo, propMat(0xffd166), x, y + 1.42, z, 1.2, 0.3, 0.6, false);
  } else if (theme < 0.72) {
    // Playground: slide and a swing frame.
    if (alt) {
      piece(cylGeo, poleMat, x - 0.5, y, z, 0.06, 1.3, 0.06, false);
      const slide = piece(boxGeo, propMat(0xffd166), x + 0.15, y + 0.55, z, 1.6, 0.08, 0.5, false);
      slide.rotation.z = 0.7;
      piece(boxGeo, propMat(0x4cc9f0), x - 0.5, y + 1.3, z, 0.6, 0.08, 0.6, false);
    } else {
      piece(cylGeo, poleMat, x - 0.8, y, z, 0.06, 1.6, 0.06, false);
      piece(cylGeo, poleMat, x + 0.8, y, z, 0.06, 1.6, 0.06, false);
      piece(boxGeo, poleMat, x, y + 1.6, z, 1.7, 0.06, 0.06, false);
      for (const dx of [-0.35, 0.35]) {
        piece(boxGeo, poleMat, x + dx, y + 0.5, z, 0.02, 1.1, 0.02, false);
        piece(boxGeo, propMat(0xff6b6b), x + dx, y + 0.45, z, 0.35, 0.05, 0.2, false);
      }
    }
  } else if (theme < 0.82) {
    // Market stall.
    piece(boxGeo, benchMat, x, y, z, 1.6, 0.7, 0.9, false);
    for (const [dx, dz] of [[-0.75, -0.4], [0.75, -0.4], [-0.75, 0.4], [0.75, 0.4]]) piece(cylGeo, poleMat, x + dx, y, z + dz, 0.05, 1.7, 0.05, false);
    piece(boxGeo, propMat(alt ? 0xf72585 : 0x90be6d), x, y + 1.7, z, 1.9, 0.08, 1.2);
    for (let k = 0; k < 3; k++) piece(boxGeo, propMat(PROP_COLORS[(k + (alt ? 2 : 0)) % PROP_COLORS.length]), x - 0.5 + k * 0.5, y + 0.7, z, 0.35, 0.2, 0.5, false);
  } else if (theme < 0.9) {
    // Hedge row with a tree.
    piece(sphereGeo, hedgeMat, x, y, z, CELL - 0.4, 0.9, 0.7, true);
    if (alt) treeSpots.push([x, z + 0.7]);
  } else {
    // Small plaza: paving, statue plinth and bike racks.
    piece(boxGeo, stoneMat, x, y, z, CELL - 0.2, 0.05, CELL - 0.2, false);
    if (alt) {
      piece(boxGeo, stoneMat, x, y + 0.05, z, 0.6, 0.5, 0.6, false);
      piece(cylGeo, poleMat, x, y + 0.55, z, 0.18, 0.7, 0.18, false);
      piece(sphereGeo, poleMat, x, y + 1.25, z, 0.3, 0.3, 0.3, false);
    } else {
      for (let k = 0; k < 3; k++) {
        const r = piece(torusGeo, poleMat, x - 0.6 + k * 0.6, y + 0.3, z, 0.5, 1, 0.5, false);
        r.rotation.x = 0;
      }
    }
  }
}

const NEON = [0xff2d95, 0x00f0ff, 0xb5ff2d, 0xffb300, 0xa259ff];
function neonSign(x, y, z, len, vertical) {
  const c = NEON[Math.floor(Math.random() * NEON.length)];
  const m = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.25, roughness: 0.4 });
  m.userData.dayI = 0.25;
  m.userData.nightI = 2.2;
  m.userData.th = 0.5 + Math.random() * 0.4;
  if (vertical) {
    piece(boxGeo, signalMat, x, y - len / 2 - 0.1, z - 0.06, 0.7, len + 0.2, 0.1, false);
    piece(boxGeo, m, x, y - len / 2, z, 0.35, len, 0.08, false);
    for (let k = 0; k < Math.floor(len / 0.9); k++) piece(boxGeo, signalMat, x, y - len / 2 + 0.2 + k * 0.9, z + 0.05, 0.4, 0.08, 0.03, false);
  } else {
    piece(boxGeo, signalMat, x, y, z - 0.06, len + 0.2, 0.9, 0.1, false);
    piece(boxGeo, m, x, y + 0.2, z, len, 0.4, 0.08, false);
  }
  const g = glow(x, vertical ? y : y + 0.4, z + 0.4, vertical ? len * 0.9 : len * 1.1, c, 0.5, m.userData.th);
  blocks.add(g);
  extras.push(g);
  nightOnly.push(g);
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

function scatterTrees(x0, z0, w, d, n, keepOut = []) {
  for (let i = 0; i < n; i++) {
    const x = x0 + Math.random() * w;
    const z = z0 + Math.random() * d;
    if (keepOut.some((k) => x > k.x && x < k.x + k.w && z > k.z && z < k.z + k.d)) continue;
    treeSpots.push([x, z]);
  }
}

function placeTrees() {
  const n = Math.min(treeSpots.length, 900);
  if (!n) return;
  const trunks = new THREE.InstancedMesh(cylGeo, trunkMat, n);
  const lower = new THREE.InstancedMesh(canopyGeo, canopyMat, n);
  const upper = new THREE.InstancedMesh(canopyGeo, canopyMat, n);
  const pines = new THREE.InstancedMesh(coneGeo, canopyMat, n);
  const m = new THREE.Matrix4();
  const color = new THREE.Color();
  const hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < n; i++) {
    const [x, z] = treeSpots[i];
    const s = 0.8 + Math.random() * 0.6;
    const pine = Math.random() < 0.22;
    const trunkH = (pine ? 0.7 : 0.9) * s;
    m.makeScale(0.22 * s, trunkH, 0.22 * s);
    m.setPosition(x, 1.1, z);
    trunks.setMatrixAt(i, m);
    color.setHSL(0.28 + Math.random() * 0.08, 0.6, 0.28 + Math.random() * 0.12);
    if (pine) {
      m.makeScale(1.3 * s, 2.6 * s, 1.3 * s);
      m.setPosition(x, 1.1 + trunkH * 0.6, z);
      pines.setMatrixAt(i, m);
      pines.setColorAt(i, color.offsetHSL(0.03, 0, -0.06));
      lower.setMatrixAt(i, hidden);
      upper.setMatrixAt(i, hidden);
    } else {
      m.makeScale(1.7 * s, 1.3 * s, 1.7 * s);
      m.setPosition(x + (Math.random() - 0.5) * 0.2, 1.1 + trunkH + 0.5 * s, z + (Math.random() - 0.5) * 0.2);
      lower.setMatrixAt(i, m);
      lower.setColorAt(i, color);
      m.makeScale(1.15 * s, 1.0 * s, 1.15 * s);
      m.setPosition(x + (Math.random() - 0.5) * 0.3, 1.1 + trunkH + 1.15 * s, z + (Math.random() - 0.5) * 0.3);
      upper.setMatrixAt(i, m);
      upper.setColorAt(i, color.clone().offsetHSL(0, 0, 0.07));
      pines.setMatrixAt(i, hidden);
    }
  }
  for (const im of [trunks, lower, upper, pines]) {
    im.castShadow = true;
    im.receiveShadow = true;
    blocks.add(im);
    extras.push(im);
  }
}

// ---------------------------------------------------------------------------
// Street life: crosswalks, lights, signals, cars, people, park features
// ---------------------------------------------------------------------------
let streets = []; // {axis:'x'|'z', at, from, to}
let cars = [];
let people = [];
let carMesh = null;
let cabMesh = null;
let headMesh = null;
let tailMesh = null;
const headMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff6d5, emissiveIntensity: 2.5 });
const tailMat = new THREE.MeshStandardMaterial({ color: 0xff3b3b, emissive: 0xff2222, emissiveIntensity: 2.0 });
let peopleBody = null;
let peopleHead = null;
let peopleHat = null;

function streetLights(x0, z0, w, d) {
  const inset = 0.45;
  const spots = [];
  for (let x = x0 + 3.2; x < x0 + w - 2; x += 9) {
    spots.push([x, z0 + inset]);
    spots.push([x, z0 + d - inset]);
  }
  for (let z = z0 + 7.7; z < z0 + d - 2; z += 9) {
    spots.push([x0 + inset, z]);
    spots.push([x0 + w - inset, z]);
  }
  for (const [x, z] of spots) {
    piece(cylGeo, poleMat, x, 1.1, z, 0.1, 3.2, 0.1, false);
    piece(boxGeo, poleMat, x, 4.3, z, 0.12, 0.1, 0.9, false);
    const lm = lampMat.clone();
    lm.userData = { dayI: 0.4, nightI: 2.6, th: 0.38 + Math.random() * 0.25 };
    piece(sphereGeo, lm, x, 4.1, z + 0.35, 0.32, 0.22, 0.32, false);
    const g = glow(x, 4.0, z + 0.35, 5, 0xffc77a, 0.55, lm.userData.th);
    blocks.add(g);
    extras.push(g);
    nightOnly.push(g);
  }
}

function trafficSignals(x0, z0, w, d) {
  if (w < 8 || d < 8) return;
  const corners = [[x0 + 0.5, z0 + 0.5], [x0 + w - 0.5, z0 + 0.5], [x0 + 0.5, z0 + d - 0.5], [x0 + w - 0.5, z0 + d - 0.5]];
  for (const [x, z] of corners) {
    piece(cylGeo, poleMat, x, 1.1, z, 0.08, 2.6, 0.08, false);
    piece(boxGeo, signalMat, x, 3.6, z, 0.3, 0.8, 0.3, false);
    // Signals at the left/right corners govern the north-south streets, the
    // others the east-west ones; cars read the same phase (see updateLife).
    const axis = (x < x0 + 1) === (z < z0 + 1) ? 'z' : 'x';
    const light = piece(sphereGeo, new THREE.MeshStandardMaterial({ color: 0x3ddc84, emissive: 0x1faa5a, emissiveIntensity: 1.2 }), x, 3.7, z + 0.17, 0.16, 0.16, 0.16, false);
    light.userData.signalAxis = axis;
    light.userData.on = true;
  }
}

function busStop(x, z) {
  piece(cylGeo, poleMat, x - 1.1, 1.1, z, 0.08, 2.2, 0.08, false);
  piece(cylGeo, poleMat, x + 1.1, 1.1, z, 0.08, 2.2, 0.08, false);
  piece(boxGeo, glassMat, x, 1.1, z - 0.45, 2.4, 2.0, 0.05, false);
  piece(boxGeo, signalMat, x, 3.3, z - 0.2, 2.6, 0.1, 1.1);
  piece(boxGeo, benchMat, x, 1.6, z - 0.2, 1.8, 0.1, 0.4, false);
  piece(boxGeo, whiteMat, x + 1.1, 2.9, z + 0.35, 0.5, 0.5, 0.05, false);
}

function buildPark(x0, z0, w, d) {
  const keepOut = [];
  const cx = x0 + w / 2;
  const cz = z0 + d / 2;
  // Fountain in the middle.
  piece(discGeo, stoneMat, cx, 1.1, cz, 3.2, 0.35, 3.2, false);
  piece(discGeo, waterMat, cx, 1.35, cz, 2.8, 0.15, 2.8, false);
  piece(cylGeo, stoneMat, cx, 1.4, cz, 0.5, 1.1, 0.5);
  piece(discGeo, waterMat, cx, 2.5, cz, 1.2, 0.12, 1.2, false);
  piece(sphereGeo, waterMat, cx, 2.6, cz, 0.3, 0.5, 0.3, false);
  keepOut.push({ x: cx - 2, z: cz - 2, w: 4, d: 4 });
  // Benches around the fountain.
  for (const [dx, dz] of [[2.6, 0], [-2.6, 0], [0, 2.6], [0, -2.6]]) {
    const b = piece(boxGeo, benchMat, cx + dx, 1.1, cz + dz, dx ? 0.4 : 1.4, 0.45, dx ? 1.4 : 0.4, false);
    b.userData.bench = true;
  }
  if (w > 16 && d > 12) {
    // Basketball court in one corner.
    const cw = 8;
    const cd = 5;
    const qx = x0 + SIDEWALK + 0.8;
    const qz = z0 + SIDEWALK + 0.8;
    piece(boxGeo, courtMat, qx + cw / 2, 1.1, qz + cd / 2, cw, 0.08, cd, false);
    piece(boxGeo, whiteMat, qx + cw / 2, 1.18, qz + cd / 2, cw - 0.4, 0.02, 0.12, false); // centre line
    piece(boxGeo, whiteMat, qx + cw / 2, 1.18, qz + 0.2, cw - 0.4, 0.02, 0.1, false);
    piece(boxGeo, whiteMat, qx + cw / 2, 1.18, qz + cd - 0.2, cw - 0.4, 0.02, 0.1, false);
    piece(torusGeo, whiteMat, qx + cw / 2, 1.19, qz + cd / 2, 1.6, 1, 1.6, false);
    for (const ex of [qx + 0.3, qx + cw - 0.3]) {
      piece(cylGeo, poleMat, ex, 1.1, qz + cd / 2, 0.08, 2.4, 0.08, false);
      piece(boxGeo, whiteMat, ex, 2.9, qz + cd / 2, 0.06, 0.7, 1.0, false);
      const hoop = piece(torusGeo, new THREE.MeshStandardMaterial({ color: 0xff7a00 }), ex + (ex < qx + cw / 2 ? 0.35 : -0.35), 3.05, qz + cd / 2, 0.45, 1, 0.45, false);
      hoop.rotation.y = 0;
    }
    keepOut.push({ x: qx - 0.5, z: qz - 0.5, w: cw + 1, d: cd + 1 });
    // Pond in the opposite corner.
    const px = x0 + w - SIDEWALK - 4.2;
    const pz = z0 + d - SIDEWALK - 3.2;
    piece(discGeo, stoneMat, px, 1.1, pz, 7.2, 0.12, 5.4, false);
    piece(discGeo, waterMat, px, 1.15, pz, 6.6, 0.12, 4.8, false);
    keepOut.push({ x: px - 3.8, z: pz - 2.9, w: 7.6, d: 5.8 });
  }
  // A winding path of flagstones.
  for (let i = 0; i < 10; i++) {
    const t = i / 9;
    piece(boxGeo, stoneMat, x0 + SIDEWALK + 1 + t * (w - SIDEWALK * 2 - 2), 1.1, cz + Math.sin(t * Math.PI * 2) * Math.min(3, d * 0.2), 0.8, 0.05, 0.6, false);
  }
  return keepOut;
}

function buildStreets(rects, opts = {}) {
  // Internal streets lie along the right and bottom edges of each suburb.
  // Merge collinear pieces into continuous segments.
  const vertical = new Map();
  const horizontal = new Map();
  for (const r of rects) {
    const right = r.x + r.w;
    const bottom = r.y + r.h;
    if (right < BASE_W / 2 - 1) addRange(vertical, Math.round(right * 10) / 10, r.y - STREET / 2, bottom + STREET / 2);
    if (bottom < BASE_D / 2 - 1) addRange(horizontal, Math.round(bottom * 10) / 10, r.x - STREET / 2, right + STREET / 2);
  }
  streets = [];
  for (const [at, ranges] of vertical) for (const [from, to] of ranges) streets.push({ axis: 'z', at, from: Math.max(from, -BASE_D / 2 - 2), to: Math.min(to, BASE_D / 2 + 2) });
  for (const [at, ranges] of horizontal) for (const [from, to] of ranges) streets.push({ axis: 'x', at, from: Math.max(from, -BASE_W / 2 - 2), to: Math.min(to, BASE_W / 2 + 2) });

  // Crosswalks near both ends of every internal street, and in the middle of
  // long ones. Skip any that would land inside a crossing street or on top of
  // another crosswalk, so junctions don't get a pile of stripes.
  const placed = [];
  for (const st of streets) {
    const len = st.to - st.from;
    const candidates = [st.from + 3.4, st.to - 3.4];
    if (len > 40) candidates.push((st.from + st.to) / 2);
    st.stops = [];
    for (const sp of candidates) {
      const px = st.axis === 'z' ? st.at : sp;
      const pz = st.axis === 'z' ? sp : st.at;
      const inJunction = streets.some((o) => o.axis !== st.axis && Math.abs(sp - o.at) < STREET / 2 + 1.6 && st.at > o.from - 0.1 && st.at < o.to + 0.1);
      const tooClose = placed.some(([qx, qz]) => Math.hypot(qx - px, qz - pz) < 5);
      if (inJunction || tooClose) continue;
      placed.push([px, pz]);
      st.stops.push(sp);
      crosswalk(st, sp);
      roadSign(st, sp);
    }
    if (!opts.site) parkedCars(st);
  }

  // Ring road around the whole city.
  const rx = BASE_W / 2 - 0.25; // centre of the ring road, inside the asphalt
  const rz = BASE_D / 2 - 0.25;
  const ring = { loop: true, points: [[-rx, -rz], [rx, -rz], [rx, rz], [-rx, rz]] };
  const paths = [ring];
  for (const st of streets) paths.push({ loop: false, street: st, points: st.axis === 'z' ? [[st.at, st.from], [st.at, st.to]] : [[st.from, st.at], [st.to, st.at]] });
  for (const pth of paths) pth.length = pathLength(pth);

  // Cars.
  cars = [];
  let n = Math.min(48, 8 + Math.floor(paths.reduce((s, p) => s + p.length, 0) / 22));
  if (opts.site) n = Math.ceil(n / 3);
  for (let i = 0; i < n; i++) {
    const pth = i < 10 ? ring : paths[1 + Math.floor(Math.random() * (paths.length - 1))] || ring;
    cars.push({ path: pth, s: Math.random() * pth.length, lane: Math.random() < 0.5 ? 1 : -1, speed: 5 + Math.random() * 4 });
  }
  carMesh = new THREE.InstancedMesh(boxGeo, vehicleMat, cars.length);
  cabMesh = new THREE.InstancedMesh(boxGeo, glassMat, cars.length);
  const col = new THREE.Color();
  cars.forEach((c, i) => carMesh.setColorAt(i, col.setHSL(Math.random(), 0.65, 0.5)));
  carMesh.castShadow = cabMesh.castShadow = true;
  blocks.add(carMesh, cabMesh);
  extras.push(carMesh, cabMesh);
  headMesh = new THREE.InstancedMesh(sphereGeo, headMat, cars.length * 2);
  tailMesh = new THREE.InstancedMesh(sphereGeo, tailMat, cars.length * 2);
  headMesh.visible = tailMesh.visible = nightK > 0.45;
  blocks.add(headMesh, tailMesh);
  extras.push(headMesh, tailMesh);
  nightOnly.push(headMesh, tailMesh);
}

function addRange(map, key, from, to) {
  const list = map.get(key) || [];
  // Merge with any overlapping/touching range.
  let merged = [from, to];
  const rest = [];
  for (const [a, b] of list) {
    if (b >= merged[0] - 0.5 && a <= merged[1] + 0.5) merged = [Math.min(a, merged[0]), Math.max(b, merged[1])];
    else rest.push([a, b]);
  }
  rest.push(merged);
  map.set(key, rest);
}

// Signal phase: north-south streets get 5 s green, then east-west, with a
// short all-red gap so nobody meets in the middle of the junction.
function greenFor(axis, t) {
  const ph = t % 11;
  if (axis === 'z') return ph < 5;
  return ph >= 5.5 && ph < 10.5;
}

const signMats = {
  stop: new THREE.MeshStandardMaterial({ color: 0xd62828, roughness: 0.6 }),
  blue: new THREE.MeshStandardMaterial({ color: 0x2b6cb0, roughness: 0.6 }),
  yellow: new THREE.MeshStandardMaterial({ color: 0xf6c90e, roughness: 0.6 }),
};
const octGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
octGeo.rotateX(Math.PI / 2);

function roadSign(st, pos) {
  // One sign on the pavement beside each crossing: stop, one-way, or a warning.
  const side = Math.random() < 0.5 ? 1 : -1;
  const off = STREET / 2 + 0.45;
  const x = st.axis === 'z' ? st.at + side * off : pos + 2.2;
  const z = st.axis === 'z' ? pos + 2.2 : st.at + side * off;
  piece(cylGeo, poleMat, x, 1.1, z, 0.06, 2.4, 0.06, false);
  const kind = Math.random();
  if (kind < 0.4) {
    piece(octGeo, signMats.stop, x, 3.3, z, 0.8, 0.8, 0.08, false);
    piece(boxGeo, whiteMat, x, 3.25, z + 0.05, 0.5, 0.1, 0.02, false);
  } else if (kind < 0.7) {
    piece(boxGeo, signMats.blue, x, 3.1, z, 0.9, 0.5, 0.08, false);
    piece(boxGeo, whiteMat, x, 3.33, z + 0.05, 0.55, 0.08, 0.02, false);
  } else {
    const tri = piece(coneGeo, signMats.yellow, x, 2.95, z, 0.9, 0.8, 0.08, false);
    tri.rotation.y = 0;
    piece(boxGeo, signalMat, x, 3.15, z + 0.05, 0.08, 0.35, 0.02, false);
  }
  if (st.axis === 'x') {
    // Face the sign along the street.
    for (let i = extras.length - 3; i < extras.length; i++) if (extras[i]) extras[i].rotation.y = Math.PI / 2;
  }
}

function crosswalk(st, pos) {
  for (let k = -2; k <= 2; k++) {
    const off = k * 0.95;
    if (st.axis === 'z') piece(boxGeo, laneMat, st.at + off, 0.64, pos, 0.5, 0.03, 2.2, false);
    else piece(boxGeo, laneMat, pos, 0.64, st.at + off, 2.2, 0.03, 0.5, false);
  }
}

function parkedCars(st) {
  const len = st.to - st.from;
  for (let p = st.from + 6; p < st.to - 6; p += 7 + Math.random() * 6) {
    if (Math.random() < 0.4) continue;
    if ((st.stops || []).some((sp) => Math.abs(sp - p) < 3)) continue;
    const side = Math.random() < 0.5 ? 1 : -1;
    const col = new THREE.Color().setHSL(Math.random(), 0.5, 0.5);
    const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.5, metalness: 0.3 });
    if (st.axis === 'z') {
      piece(boxGeo, mat, st.at + side * 1.95, 0.62, p, 0.8, 0.45, 1.7);
      piece(boxGeo, glassMat, st.at + side * 1.95, 1.07, p + 0.1, 0.7, 0.3, 0.9, false);
    } else {
      piece(boxGeo, mat, p, 0.62, st.at + side * 1.95, 1.7, 0.45, 0.8);
      piece(boxGeo, glassMat, p + 0.1, 1.07, st.at + side * 1.95, 0.9, 0.3, 0.7, false);
    }
  }
}

function pathLength(pth) {
  let L = 0;
  const pts = pth.points;
  const n = pth.loop ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    L += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return L;
}

// Position and heading at distance s along a path (wraps on loops).
function pointAt(pth, s, out) {
  const pts = pth.points;
  const n = pth.loop ? pts.length : pts.length - 1;
  let rem = ((s % pth.length) + pth.length) % pth.length;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % pts.length];
    const seg = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (rem <= seg || i === n - 1) {
      const t = seg ? Math.min(1, rem / seg) : 0;
      out.x = a[0] + (b[0] - a[0]) * t;
      out.z = a[1] + (b[1] - a[1]) * t;
      out.dx = (b[0] - a[0]) / (seg || 1);
      out.dz = (b[1] - a[1]) / (seg || 1);
      return out;
    }
    rem -= seg;
  }
  return out;
}

function buildPeople(rects, opts = {}) {
  people = [];
  for (const r of rects) {
    const x0 = r.x + STREET / 2 + 1.1;
    const z0 = r.y + STREET / 2 + 1.1;
    const w = r.w - STREET - 2.2;
    const d = r.h - STREET - 2.2;
    if (w < 6 || d < 6) continue;
    const loop = { loop: true, points: [[x0, z0], [x0 + w, z0], [x0 + w, z0 + d], [x0, z0 + d]] };
    loop.length = pathLength(loop);
    const n = Math.min(14, Math.max(2, Math.floor(loop.length / 9)));
    for (let i = 0; i < n; i++) people.push({ path: loop, s: Math.random() * loop.length, dir: Math.random() < 0.5 ? 1 : -1, speed: 1 + Math.random() * 0.8, phase: Math.random() * 6 });
  }
  for (const loop of opts.loops || []) {
    loop.length = pathLength(loop);
    const n = Math.max(2, Math.floor(loop.length / 7));
    for (let i = 0; i < n; i++) people.push({ path: loop, s: Math.random() * loop.length, dir: Math.random() < 0.5 ? 1 : -1, speed: 0.8 + Math.random() * 0.7, phase: Math.random() * 6 });
  }
  if (!people.length) return;
  peopleBody = new THREE.InstancedMesh(cylGeo, personMat, people.length);
  peopleHead = new THREE.InstancedMesh(sphereGeo, skinMat, people.length);
  const col = new THREE.Color();
  people.forEach((_, i) => peopleBody.setColorAt(i, opts.workers ? col.setHSL(Math.random() < 0.5 ? 0.08 : 0.14, 1, 0.52) : col.setHSL(Math.random(), 0.55, 0.5)));
  peopleBody.castShadow = true;
  blocks.add(peopleBody, peopleHead);
  extras.push(peopleBody, peopleHead);
  if (opts.workers) {
    peopleHat = new THREE.InstancedMesh(sphereGeo, hardHatMat, people.length);
    blocks.add(peopleHat);
    extras.push(peopleHat);
  }
}

const _pt = { x: 0, z: 0, dx: 0, dz: 0 };
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function updateLife(dt, t) {
  if (carMesh) {
    cars.forEach((c, i) => {
      const dir = c.lane > 0 ? 1 : -1;
      let v = c.speed;
      const st = c.path.street;
      if (st && !greenFor(st.axis, t)) {
        // Stop line 2 units before each crossing in our direction of travel.
        const L = c.path.length;
        const pos = st.from + (((c.s % L) + L) % L); // path starts at st.from
        for (const sp of st.stops) {
          const line = sp - dir * 2.2;
          const gap = (line - pos) * dir;
          if (gap > 0 && gap < 1.2) v = 0;
        }
      }
      c.s += v * dt * dir;
      pointAt(c.path, c.s, _pt);
      // Right-hand lane offset.
      const ox = -_pt.dz * c.lane * 1.1;
      const oz = _pt.dx * c.lane * 1.1;
      const heading = Math.atan2(_pt.dx * c.lane, _pt.dz * c.lane);
      _q.setFromAxisAngle(_up, heading);
      _p.set(_pt.x + ox, 0.62, _pt.z + oz);
      _m.compose(_p, _q, _sc.set(0.8, 0.45, 1.7));
      carMesh.setMatrixAt(i, _m);
      _p.set(_pt.x + ox, 1.07, _pt.z + oz);
      _m.compose(_p, _q, _sc.set(0.7, 0.3, 0.9));
      cabMesh.setMatrixAt(i, _m);
      if (nightK > 0.45 && headMesh) {
        const fx = _pt.dx * dir;
        const fz = _pt.dz * dir;
        const rx = -_pt.dz * dir;
        const rz = _pt.dx * dir;
        for (const sgn of [-1, 1]) {
          _p.set(_pt.x + ox + fx * 0.85 + rx * sgn * 0.26, 0.9, _pt.z + oz + fz * 0.85 + rz * sgn * 0.26);
          _m.compose(_p, _q, _sc.set(0.16, 0.12, 0.1));
          headMesh.setMatrixAt(i * 2 + (sgn > 0 ? 1 : 0), _m);
          _p.set(_pt.x + ox - fx * 0.85 + rx * sgn * 0.26, 0.9, _pt.z + oz - fz * 0.85 + rz * sgn * 0.26);
          _m.compose(_p, _q, _sc.set(0.14, 0.1, 0.08));
          tailMesh.setMatrixAt(i * 2 + (sgn > 0 ? 1 : 0), _m);
        }
      }
    });
    carMesh.instanceMatrix.needsUpdate = true;
    cabMesh.instanceMatrix.needsUpdate = true;
    if (nightK > 0.45 && headMesh) {
      headMesh.instanceMatrix.needsUpdate = true;
      tailMesh.instanceMatrix.needsUpdate = true;
    }
  }
  if (peopleBody) {
    people.forEach((pp, i) => {
      pp.s += pp.speed * dt * pp.dir;
      pointAt(pp.path, pp.s, _pt);
      const bob = Math.abs(Math.sin(t * 6 + pp.phase)) * 0.06;
      _q.identity();
      _p.set(_pt.x, 1.1 + bob, _pt.z);
      _m.compose(_p, _q, _sc.set(0.32, 0.7, 0.32));
      peopleBody.setMatrixAt(i, _m);
      _p.set(_pt.x, 1.85 + bob, _pt.z);
      _m.compose(_p, _q, _sc.set(0.3, 0.3, 0.3));
      peopleHead.setMatrixAt(i, _m);
      if (peopleHat) {
        _p.set(_pt.x, 1.93 + bob, _pt.z);
        _m.compose(_p, _q, _sc.set(0.36, 0.22, 0.36));
        peopleHat.setMatrixAt(i, _m);
      }
    });
    peopleBody.instanceMatrix.needsUpdate = true;
    peopleHead.instanceMatrix.needsUpdate = true;
    if (peopleHat) peopleHat.instanceMatrix.needsUpdate = true;
  }
  // Traffic signals follow the global phase.
  for (const ex of extras) {
    const ax = ex.userData.signalAxis;
    if (!ax) continue;
    const go = greenFor(ax, t);
    if (go !== ex.userData.on) {
      ex.userData.on = go;
      ex.material.color.setHex(go ? 0x3ddc84 : 0xff4d4d);
      ex.material.emissive.setHex(go ? 0x1faa5a : 0xcc2222);
      ex.position.y = go ? 3.7 : 4.15;
    }
  }
}


// ---------------------------------------------------------------------------
// Construction site: shown while a scan runs. The roads are already laid and
// being patched by road crews; the lots are dirt with cranes, scaffolds and
// workers, and the scaffolds climb as the scan finds more files.
// ---------------------------------------------------------------------------
let site = null;
const hardHatMat = new THREE.MeshStandardMaterial({ color: 0xffd23f, roughness: 0.6 });
const craneMat = new THREE.MeshStandardMaterial({ color: 0xf4a300, roughness: 0.6, metalness: 0.3 });
const scaffoldMat = new THREE.MeshStandardMaterial({ color: 0x9aa3ad, roughness: 0.5, metalness: 0.6 });
const plankMat = new THREE.MeshStandardMaterial({ color: 0xc9a46a, roughness: 0.95 });
const concreteMat = new THREE.MeshStandardMaterial({ color: 0xb9b5ad, roughness: 0.95 });
const gravelMat = new THREE.MeshStandardMaterial({ color: 0xa79d8f, roughness: 1 });
const coneMat = new THREE.MeshStandardMaterial({ color: 0xff6a00, roughness: 0.7 });
const stripeRedMat = new THREE.MeshStandardMaterial({ color: 0xe03a2f, roughness: 0.7 });
const fenceMat = new THREE.MeshStandardMaterial({ color: 0xd8dde3, roughness: 0.6, metalness: 0.4, transparent: true, opacity: 0.55 });
const machineMat = new THREE.MeshStandardMaterial({ color: 0xffb000, roughness: 0.55, metalness: 0.3 });
const trackMat = new THREE.MeshStandardMaterial({ color: 0x2b2f36, roughness: 0.9 });
const brickMat = new THREE.MeshStandardMaterial({ color: 0xb5553c, roughness: 0.9 });
const beamMat = new THREE.MeshStandardMaterial({ color: 0x6d7580, roughness: 0.4, metalness: 0.7 });
const beaconMat = new THREE.MeshStandardMaterial({ color: 0xffb000, emissive: 0xff9500, emissiveIntensity: 1.6 });
const patchMat = new THREE.MeshStandardMaterial({ color: 0x3a3e46, roughness: 1 });

function buildSite() {
  clearBlocks();
  closeMenu();
  site = { cranes: [], scaffolds: [], machines: [], beacons: [], progress: 0, shown: 0 };
  // Provisional plan: the same six lots every time, so the site is familiar.
  const plan = [34, 26, 18, 14, 10, 8].map((size, i) => ({ size, i }));
  const rects = squarify(plan, { x: -BASE_W / 2, y: -BASE_D / 2, w: BASE_W, h: BASE_D });
  const loops = [];
  for (const r of rects) siteLot(r, loops);
  buildStreets(rects, { site: true });
  roadWorks();
  buildPeople(rects, { workers: true, loops });
  placeTrees();
  addLabel({ name: 'Building your city', sub: 'surveying your files…' }, 0, 8, 0, 40, true);
  applyNight();
}

function siteLot(r, loops) {
  const x0 = r.x + STREET / 2;
  const z0 = r.y + STREET / 2;
  const w = r.w - STREET;
  const d = r.h - STREET;
  if (w < 4 || d < 4) return;
  // Pavement ring with a gravel yard inside.
  piece(boxGeo, pavementMat, x0 + w / 2, 0.6, z0 + d / 2, w, 0.5, d, false);
  piece(boxGeo, gravelMat, x0 + w / 2, 0.6, z0 + d / 2, w - SIDEWALK * 2, 0.55, d - SIDEWALK * 2, false);
  streetLights(x0, z0, w, d);
  trafficSignals(x0, z0, w, d);
  // Hoarding fence around the yard.
  const fx0 = x0 + SIDEWALK;
  const fz0 = z0 + SIDEWALK;
  const fw = w - SIDEWALK * 2;
  const fd = d - SIDEWALK * 2;
  const gate = fx0 + fw * 0.5;
  for (let x = fx0; x <= fx0 + fw + 0.01; x += 2.5) {
    piece(cylGeo, poleMat, x, 1.15, fz0, 0.08, 1.4, 0.08, false);
    piece(cylGeo, poleMat, x, 1.15, fz0 + fd, 0.08, 1.4, 0.08, false);
  }
  for (let z = fz0; z <= fz0 + fd + 0.01; z += 2.5) {
    piece(cylGeo, poleMat, fx0, 1.15, z, 0.08, 1.4, 0.08, false);
    piece(cylGeo, poleMat, fx0 + fw, 1.15, z, 0.08, 1.4, 0.08, false);
  }
  piece(boxGeo, fenceMat, fx0 + fw / 2, 1.2, fz0, fw, 1.2, 0.05, false);
  // Front fence leaves a gate open for trucks.
  piece(boxGeo, fenceMat, (fx0 + gate - 2) / 2, 1.2, fz0 + fd, gate - 2 - fx0, 1.2, 0.05, false);
  piece(boxGeo, fenceMat, (gate + 2 + fx0 + fw) / 2, 1.2, fz0 + fd, fx0 + fw - gate - 2, 1.2, 0.05, false);
  piece(boxGeo, fenceMat, fx0, 1.2, fz0 + fd / 2, 0.05, 1.2, fd, false);
  piece(boxGeo, fenceMat, fx0 + fw, 1.2, fz0 + fd / 2, 0.05, 1.2, fd, false);
  // Inner lots: a few foundations, the biggest with a crane.
  const inner = { x: fx0 + 1.2, y: fz0 + 1.2, w: fw - 2.4, h: fd - 2.4 };
  if (inner.w < 4 || inner.h < 4) return;
  const count = Math.max(1, Math.min(4, Math.floor((inner.w * inner.h) / 120)));
  const lots = [];
  for (let i = 0; i < count; i++) lots.push({ size: 1 + Math.random() * 2.5 });
  const lotRects = squarify(lots, inner);
  lotRects.forEach((lr, i) => {
    const lw = Math.max(1.5, lr.w - 1.6);
    const ld = Math.max(1.5, lr.h - 1.6);
    const cx = lr.x + lr.w / 2;
    const cz = lr.y + lr.h / 2;
    const sw = Math.min(lw, ld) * 0.8;
    // Foundation slab and a scaffold that grows with the scan.
    piece(boxGeo, concreteMat, cx, 1.15, cz, sw + 0.8, 0.25, sw + 0.8, false);
    const floors = 4 + Math.floor(Math.random() * 7);
    const sc = { floors: [], cx, cz, sw, start: Math.random() * 0.35 };
    for (let f = 0; f < floors; f++) {
      const y = 1.4 + f * 2.2;
      const parts = [];
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) parts.push(piece(cylGeo, scaffoldMat, cx + (sx * sw) / 2, y, cz + (sz * sw) / 2, 0.1, 2.2, 0.1, false));
      parts.push(piece(boxGeo, scaffoldMat, cx, y + 2.1, cz - sw / 2, sw, 0.08, 0.08, false));
      parts.push(piece(boxGeo, scaffoldMat, cx, y + 2.1, cz + sw / 2, sw, 0.08, 0.08, false));
      parts.push(piece(boxGeo, scaffoldMat, cx - sw / 2, y + 2.1, cz, 0.08, 0.08, sw, false));
      parts.push(piece(boxGeo, scaffoldMat, cx + sw / 2, y + 2.1, cz, 0.08, 0.08, sw, false));
      parts.push(piece(boxGeo, f % 2 ? plankMat : concreteMat, cx, y + 2.14, cz, sw - 0.1, 0.12, sw - 0.1, false));
      for (const m of parts) {
        m.userData.finalScale = [m.scale.x, m.scale.y, m.scale.z];
        m.scale.set(0, 0, 0);
        m.userData.pop = 0;
      }
      sc.floors.push(parts);
    }
    site.scaffolds.push(sc);
    // A worker path around the slab.
    const m = sw / 2 + 1.0;
    loops.push({ loop: true, points: [[cx - m, cz - m], [cx + m, cz - m], [cx + m, cz + m], [cx - m, cz + m]] });
    if (i === 0 && lr.w > 7 && lr.h > 7) crane(lr.x + 1.0, lr.y + 1.0, 8 + floors * 2.2);
    else if (Math.random() < 0.6) excavator(lr.x + lr.w - 1.6, lr.y + lr.h - 1.6);
    // Materials: dirt pile, pallet of bricks, steel beams.
    piece(coneGeo, soilMat, lr.x + lr.w - 1.2, 1.15, lr.y + 1.2, 2.2, 1.1, 2.2);
    piece(boxGeo, plankMat, lr.x + 1.2, 1.15, lr.y + lr.h - 1.0, 1.4, 0.12, 1.1, false);
    piece(boxGeo, brickMat, lr.x + 1.2, 1.27, lr.y + lr.h - 1.0, 1.2, 0.8, 0.9);
    piece(boxGeo, beamMat, lr.x + lr.w / 2, 1.15, lr.y + lr.h - 0.7, Math.min(5, lr.w - 2), 0.3, 0.4);
  });
  // Site office (portable cabin) and a mixer by the gate.
  piece(boxGeo, whiteMat, gate + 3.2, 1.15, fz0 + fd - 1.6, 3.2, 1.6, 2.0);
  piece(boxGeo, signalMat, gate + 3.2, 2.75, fz0 + fd - 1.6, 3.4, 0.12, 2.2, false);
  piece(boxGeo, glassMat, gate + 3.2, 1.7, fz0 + fd - 0.58, 2.0, 0.6, 0.04, false);
  mixer(gate - 2.6, fz0 + fd - 1.8);
  // Beacons on the gate posts.
  for (const gx of [gate - 2, gate + 2]) {
    piece(cylGeo, stripeRedMat, gx, 1.15, fz0 + fd, 0.14, 1.5, 0.14, false);
    const b = piece(sphereGeo, beaconMat.clone(), gx, 2.75, fz0 + fd, 0.3, 0.3, 0.3, false);
    b.userData.blink = Math.random() * 2;
    site.beacons.push(b);
  }
}

function crane(x, z, h) {
  // Tower crane: lattice mast, slewing jib with trolley and a swinging load.
  const base = 1.15;
  piece(boxGeo, concreteMat, x, base, z, 2.6, 0.4, 2.6, false);
  piece(boxGeo, craneMat, x, base + 0.4, z, 0.7, h, 0.7);
  for (let y = base + 1.5; y < base + h; y += 1.6) {
    piece(boxGeo, craneMat, x, y, z, 0.95, 0.08, 0.08, false);
    piece(boxGeo, craneMat, x, y, z, 0.08, 0.08, 0.95, false);
  }
  const top = base + 0.4 + h;
  const pivot = new THREE.Group();
  pivot.position.set(x, top, z);
  blocks.add(pivot);
  extras.push(pivot);
  const add = (geo, mat, px, py, pz, sx, sy, sz) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(px, py, pz);
    m.scale.set(sx, sy, sz);
    m.castShadow = true;
    pivot.add(m);
    return m;
  };
  add(boxGeo, craneMat, 0, 0, 0, 0.9, 1.4, 0.9); // slewing unit
  add(boxGeo, glassMat, 0.55, 0.3, 0, 0.6, 0.7, 0.7); // cab
  const jib = 10 + h * 0.4;
  add(boxGeo, craneMat, jib / 2, 1.4, 0, jib, 0.35, 0.35); // jib
  add(boxGeo, craneMat, -jib * 0.3, 1.4, 0, jib * 0.6, 0.35, 0.35); // counter-jib
  add(boxGeo, concreteMat, -jib * 0.5, 1.2, 0, 1.2, 0.9, 1.0); // counterweight
  add(boxGeo, craneMat, 0, 1.75, 0, 0.3, 2.4, 0.3); // apex
  // Pendant lines from the apex to the jib and counter-jib tips.
  for (const tipX of [jib * 0.92, -jib * 0.55]) {
    const dx = tipX;
    const dy = 1.6 - 4.15;
    const tie = add(cylGeo, beamMat, 0, 4.15, 0, 0.05, Math.hypot(dx, dy), 0.05);
    tie.rotation.z = Math.atan2(-dx, dy);
  }
  const trolley = new THREE.Group();
  trolley.position.set(jib * 0.6, 1.4, 0);
  pivot.add(trolley);
  const cable = add(cylGeo, trackMat, 0, 0, 0, 0.04, 1, 0.04);
  trolley.add(cable);
  cable.position.set(0, 0, 0);
  const hook = new THREE.Group();
  trolley.add(hook);
  const hookBlock = new THREE.Mesh(boxGeo, trackMat);
  hookBlock.scale.set(0.3, 0.4, 0.3);
  hook.add(hookBlock);
  const load = new THREE.Mesh(boxGeo, Math.random() < 0.5 ? beamMat : brickMat);
  load.scale.set(Math.random() < 0.5 ? 3.5 : 1.2, 0.5, 0.9);
  load.position.y = -0.9;
  load.castShadow = true;
  hook.add(load);
  site.cranes.push({ pivot, trolley, cable, hook, jib, base: Math.random() * Math.PI * 2, phase: Math.random() * 10, speed: 0.25 + Math.random() * 0.2 });
}

function excavator(x, z) {
  const g = new THREE.Group();
  g.position.set(x, 1.15, z);
  g.rotation.y = Math.random() * Math.PI * 2;
  blocks.add(g);
  extras.push(g);
  const add = (geo, mat, px, py, pz, sx, sy, sz, parent = g) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(px, py, pz);
    m.scale.set(sx, sy, sz);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  add(boxGeo, trackMat, 0, 0, -0.8, 2.4, 0.5, 0.6);
  add(boxGeo, trackMat, 0, 0, 0.8, 2.4, 0.5, 0.6);
  const body = new THREE.Group();
  body.position.y = 0.55;
  g.add(body);
  add(boxGeo, machineMat, -0.2, 0, 0, 1.9, 0.9, 1.7, body);
  add(boxGeo, glassMat, 0.35, 0.9, 0.45, 0.9, 0.8, 0.8, body);
  const boom = new THREE.Group();
  boom.position.set(0.9, 0.8, -0.2);
  body.add(boom);
  const arm1 = add(boxGeo, machineMat, 0, 0, 0, 0.3, 2.8, 0.3, boom);
  arm1.rotation.z = -0.9;
  const elbow = new THREE.Group();
  elbow.position.set(2.8 * Math.sin(0.9), 2.8 * Math.cos(0.9), 0);
  boom.add(elbow);
  const arm2 = add(boxGeo, machineMat, 0, 0, 0, 0.25, 2.2, 0.25, elbow);
  arm2.rotation.z = 2.3;
  const bucket = add(boxGeo, trackMat, 2.2 * Math.sin(2.3) * -1, -2.2 * Math.cos(2.3), 0, 0.7, 0.5, 0.7, elbow);
  bucket.position.set(-2.2 * Math.sin(2.3), -2.2 * Math.cos(2.3) * 1, 0);
  site.machines.push({ kind: 'excavator', body, boom, elbow, phase: Math.random() * 10 });
}

function mixer(x, z) {
  const g = new THREE.Group();
  g.position.set(x, 1.15, z);
  g.rotation.y = Math.PI / 2 + (Math.random() - 0.5) * 0.4;
  blocks.add(g);
  extras.push(g);
  const add = (geo, mat, px, py, pz, sx, sy, sz, parent = g) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(px, py, pz);
    m.scale.set(sx, sy, sz);
    m.castShadow = true;
    parent.add(m);
    return m;
  };
  add(boxGeo, trackMat, 0, 0, 0, 3.4, 0.5, 1.4);
  add(boxGeo, whiteMat, 1.1, 0.5, 0, 1.1, 1.0, 1.3);
  add(boxGeo, glassMat, 1.62, 0.9, 0, 0.06, 0.5, 1.1);
  const drum = add(cylGeo, stripeRedMat, -0.5, 1.1, 0, 1.2, 2.0, 1.2);
  drum.rotation.z = Math.PI / 2 + 0.35;
  drum.position.set(0.35, 0.9, 0);
  for (let i = 0; i < 3; i++) {
    const w = add(cylGeo, trackMat, -0.9 + i * 0.9, 0.3, 0, 0.55, 1.5, 0.55);
    w.rotation.x = Math.PI / 2;
    w.position.set(-1.0 + i * 1.0, 0.28, -0.75);
  }
  site.machines.push({ kind: 'mixer', drum, phase: Math.random() * 10 });
}

function roadWorks() {
  // One works zone per internal street plus one on the ring road: a closed
  // lane of cones, striped barriers, a fresh asphalt patch, a warning sign,
  // a flagger, and a roller rolling back and forth over the patch.
  const zones = [];
  for (const st of streets) {
    const len = st.to - st.from;
    if (len < 18) continue;
    const mid = (st.from + st.to) / 2 + (Math.random() - 0.5) * len * 0.3;
    if ((st.stops || []).some((sp) => Math.abs(sp - mid) < 7)) continue;
    zones.push({ axis: st.axis, at: st.at, pos: mid, side: Math.random() < 0.5 ? 1 : -1 });
  }
  zones.push({ axis: 'x', at: BASE_D / 2 - 0.25, pos: -BASE_W * 0.25, side: -1 });
  zones.push({ axis: 'z', at: -BASE_W / 2 + 0.25, pos: BASE_D * 0.1, side: 1 });
  for (const zn of zones) {
    const L = 8;
    const P = (along, across, y = 1.1) => (zn.axis === 'z' ? [zn.at + across, y, zn.pos + along] : [zn.pos + along, y, zn.at + across]);
    const lane = zn.side * 1.2;
    const sz = (a, b) => (zn.axis === 'z' ? [b, a] : [a, b]);
    // Patch of new asphalt and an open trench beside it.
    let [px, py, pz] = P(0, lane, 0.63);
    let [sx, szz] = sz(L - 1, 2.0);
    piece(boxGeo, patchMat, px, py, pz, sx, 0.03, szz, false);
    [px, py, pz] = P(-L / 2 + 1.5, lane, 0.64);
    [sx, szz] = sz(2.2, 1.2);
    piece(boxGeo, soilMat, px, py, pz, sx, 0.02, szz, false);
    // Cones along the lane edge and across both ends.
    for (let a = -L / 2; a <= L / 2; a += 1.6) {
      [px, py, pz] = P(a, zn.side * 0.25);
      piece(coneGeo, coneMat, px, py, pz, 0.45, 0.7, 0.45, false);
      piece(cylGeo, whiteMat, px, py + 0.35, pz, 0.34, 0.1, 0.34, false);
    }
    for (const end of [-L / 2, L / 2]) {
      for (let c = 0.9; c <= 2.3; c += 0.7) {
        [px, py, pz] = P(end, zn.side * c);
        piece(coneGeo, coneMat, px, py, pz, 0.45, 0.7, 0.45, false);
      }
      // Striped barrier with a blinking lamp.
      [px, py, pz] = P(end + (end < 0 ? -1.2 : 1.2), lane);
      [sx, szz] = sz(0.15, 2.2);
      piece(boxGeo, stripeRedMat, px, py, pz, sx, 1.0, szz, false);
      [sx, szz] = sz(0.17, 2.2);
      piece(boxGeo, whiteMat, px, py + 0.3, pz, sx, 0.25, szz, false);
      piece(boxGeo, whiteMat, px, py + 0.75, pz, sx, 0.2, szz, false);
      const b = piece(sphereGeo, beaconMat.clone(), px, py + 1.15, pz, 0.26, 0.26, 0.26, false);
      b.userData.blink = Math.random() * 2;
      site.beacons.push(b);
    }
    // Warning sign on the pavement before the zone.
    [px, py, pz] = P(-L / 2 - 4, zn.side * (STREET / 2 + 0.5));
    piece(cylGeo, poleMat, px, py, pz, 0.06, 2.2, 0.06, false);
    const dia = piece(boxGeo, signMats.yellow, px, py + 2.1, pz, 0.9, 0.9, 0.06, false);
    dia.rotation.z = Math.PI / 4;
    if (zn.axis === 'x') dia.rotation.y = Math.PI / 2;
    // Flagger holding a stop paddle.
    [px, py, pz] = P(L / 2 + 2.2, zn.side * 2.0);
    piece(cylGeo, hardHatMat, px, py, pz, 0.32, 0.7, 0.32, false);
    piece(sphereGeo, skinMat, px, py + 0.85, pz, 0.3, 0.3, 0.3, false);
    piece(sphereGeo, hardHatMat, px, py + 0.93, pz, 0.36, 0.22, 0.36, false);
    piece(cylGeo, poleMat, px + 0.3, py, pz, 0.04, 1.6, 0.04, false);
    piece(octGeo, signMats.stop, px + 0.3, py + 1.7, pz, 0.5, 0.5, 0.05, false);
    // Roller.
    const g = new THREE.Group();
    blocks.add(g);
    extras.push(g);
    const add = (geo, mat, x, y, z, sx, sy, sz2) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.scale.set(sx, sy, sz2);
      m.castShadow = true;
      g.add(m);
      return m;
    };
    add(boxGeo, machineMat, 0, 0.5, 0, 1.6, 0.6, 1.2);
    add(boxGeo, glassMat, -0.2, 1.1, 0, 0.9, 0.7, 1.0);
    add(boxGeo, machineMat, -0.2, 1.8, 0, 1.1, 0.08, 1.2);
    const drumF = add(cylGeo, beamMat, 1.3, 0.55, 0, 1.0, 1.3, 1.0);
    drumF.rotation.x = Math.PI / 2;
    drumF.position.set(1.3, 0.55, -0.65);
    const drumB = add(cylGeo, trackMat, -1.1, 0.5, 0, 0.9, 1.3, 0.9);
    drumB.rotation.x = Math.PI / 2;
    drumB.position.set(-1.1, 0.5, -0.65);
    const beacon = add(sphereGeo, beaconMat.clone(), -0.2, 1.95, 0, 0.22, 0.22, 0.22);
    beacon.userData.blink = Math.random() * 2;
    site.beacons.push(beacon);
    site.machines.push({ kind: 'roller', g, zone: zn, lane, L: L - 3, phase: Math.random() * 10 });
  }
}

function updateSite(dt, t) {
  // Scaffolds climb with the scan; each floor pops on in turn.
  const prog = site.progress;
  for (const sc of site.scaffolds) {
    const want = Math.floor(Math.max(0, (prog - sc.start) / (1 - sc.start)) * (sc.floors.length + 1));
    sc.floors.forEach((parts, f) => {
      if (f >= want) return;
      for (const m of parts) {
        if (m.userData.pop >= 1) continue;
        m.userData.pop = Math.min(1, m.userData.pop + dt * 3.5);
        const k = easeOutBack(m.userData.pop);
        const fs = m.userData.finalScale;
        m.scale.set(fs[0] * k, fs[1] * k, fs[2] * k);
      }
    });
  }
  for (const c of site.cranes) {
    c.pivot.rotation.y = c.base + Math.sin(t * c.speed + c.phase) * 1.3;
    c.trolley.position.x = c.jib * (0.55 + 0.3 * Math.sin(t * 0.37 + c.phase));
    const drop = 4 + (c.jib * 0.6) * (0.5 + 0.5 * Math.sin(t * 0.5 + c.phase * 1.7));
    c.cable.scale.y = drop;
    c.cable.rotation.x = Math.PI; // hangs down from the trolley
    c.hook.position.y = -drop;
    c.hook.rotation.y = Math.sin(t * 0.8 + c.phase) * 0.4;
  }
  for (const m of site.machines) {
    if (m.kind === 'excavator') {
      m.body.rotation.y = Math.sin(t * 0.6 + m.phase) * 0.7;
      m.boom.rotation.z = Math.sin(t * 1.1 + m.phase) * 0.35;
      m.elbow.rotation.z = Math.sin(t * 1.1 + m.phase + 1) * 0.5;
    } else if (m.kind === 'mixer') {
      m.drum.rotation.y += dt * 1.5;
    } else if (m.kind === 'roller') {
      const a = Math.sin(t * 0.45 + m.phase) * (m.L / 2);
      const dir = Math.cos(t * 0.45 + m.phase) >= 0 ? 1 : -1;
      const zn = m.zone;
      if (zn.axis === 'z') {
        m.g.position.set(zn.at + m.lane, 0.62, zn.pos + a);
        m.g.rotation.y = dir > 0 ? 0 : Math.PI;
      } else {
        m.g.position.set(zn.pos + a, 0.62, zn.at + m.lane);
        m.g.rotation.y = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
      }
    }
  }
  for (const b of site.beacons) {
    const on = (t * 2 + b.userData.blink) % 1 < 0.5;
    b.material.emissiveIntensity = on ? 2.2 : 0.2;
  }
}

// A top-level item finished scanning: swap the next scaffold for its building.
function siteBuilding(item) {
  if (!site) return;
  const free = site.scaffolds.filter((x) => !x.used);
  const sc = free[Math.floor(Math.random() * free.length)];
  if (!sc) return;
  sc.used = true;
  for (const parts of sc.floors) for (const m of parts) m.visible = false;
  site.maxSeen = Math.max(site.maxSeen || 1, item.size);
  maxSizeInView = site.maxSeen;
  const side = sc.sw + 0.8;
  const r = { x: sc.cx - side / 2, y: sc.cz - side / 2, w: side, h: side, item: { size: side * side, item } };
  const h = placeBuilding(r, 1, 0);
  addLabel(item, sc.cx, 1.1 + h + 2, sc.cz, Math.min(side + 8, 24));
  if (labelPairs.length) {
    const lp = labelPairs[labelPairs.length - 1];
    lp.day.material.opacity = 1 - nightK;
    lp.night.material.opacity = nightK;
  }
}

function setScanProgress(p) {
  if (!site) return;
  if (p.done) siteBuilding(p.done);
  // Unknown total, so ease towards 1 as files and bytes pile up.
  const byFiles = 1 - Math.exp(-(p.files || 0) / 220000);
  const byBytes = 1 - Math.exp(-(p.bytes || 0) / 250e9);
  site.progress = Math.max(site.progress, Math.min(0.97, Math.max(byFiles, byBytes)));
}

function drawLabel(item, sign, nightStyle) {
  const text = item.name.length > 22 ? item.name.slice(0, 20) + '…' : item.name;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (nightStyle) ctx.fillStyle = sign ? 'rgba(255,255,255,0.95)' : 'rgba(255,255,255,0.92)';
  else ctx.fillStyle = sign ? 'rgba(79,209,197,0.92)' : 'rgba(20,28,40,0.78)';
  roundRect(ctx, 6, 6, 500, 116, 18);
  ctx.fill();
  if (nightStyle && sign) {
    ctx.strokeStyle = 'rgba(79,209,197,0.9)';
    ctx.lineWidth = 6;
    ctx.stroke();
  }
  ctx.fillStyle = nightStyle ? '#101828' : sign ? '#06201d' : '#ffffff';
  ctx.font = 'bold 44px -apple-system, Segoe UI, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, 256, 56);
  ctx.font = '34px -apple-system, Segoe UI, system-ui, sans-serif';
  ctx.fillStyle = nightStyle ? '#4b5566' : sign ? '#0d3a36' : '#cfe3ec';
  ctx.fillText(item.sub || fmt(item.size), 256, 102);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false }));
}

function addLabel(item, x, y, z, width, sign = false) {
  const s = Math.max(10, Math.min(24, width * 0.55));
  const pair = {};
  for (const nightStyle of [false, true]) {
    const sprite = drawLabel(item, sign, nightStyle);
    sprite.scale.set(s, s / 4, 1);
    sprite.position.set(x, y + 3, z);
    sprite.renderOrder = nightStyle ? 3 : 2;
    sprite.material.opacity = nightStyle ? nightK : 1 - nightK;
    blocks.add(sprite);
    extras.push(sprite);
    pair[nightStyle ? 'night' : 'day'] = sprite;
  }
  labelPairs.push(pair);
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
    // Highlight by lightening the facade colour; emissive is reserved for lit windows.
    if (hovered && hovered.userData.hoverColor) {
      hovered.material.color.copy(hovered.userData.hoverColor);
      hovered.userData.hoverColor = null;
    }
    hovered = hit;
    if (hovered) {
      if (!hovered.userData.district) {
        hovered.userData.hoverColor = hovered.material.color.clone();
        hovered.material.color.offsetHSL(0, 0, 0.14);
      }
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
  const color = '#' + (KIND_COLORS[item.kind] || KIND_COLORS.other).toString(16).padStart(6, '0');
  const where = item.suburb ? 'Suburb' : SUBURB_NAMES[item.kind] || KIND_LABELS[item.kind] || item.kind;
  const row = (act, icon, label, sub, cls = '') => `<button data-act="${act}" class="${cls}"><i>${icon}</i><span class="lbl">${label}<small>${sub}</small></span></button>`;
  menu.innerHTML = `<div class="menu-head" style="--kind:${color}"><span class="swatch"></span><div><b>${esc(item.name)}</b><span>${fmt(item.size)}${item.files ? ` · ${item.files.toLocaleString()} files` : ''} · ${esc(where)}</span></div></div>` +
    (item.isDir && !item.virtual ? row('open', '🚶', 'Walk in', 'see what is inside') : '') +
    (state.path.length ? row('leave', '↩', `Leave ${esc(currentNode().name)}`, 'back out to the street') : '') +
    (item.path && !item.virtual ? row('reveal', '📍', 'Show in Finder', 'open its folder') : '') +
    (canDemolish ? row('demolish', '🧨', 'Demolish', 'moves it to the Trash', 'demolish') : '') +
    (!canDemolish ? `<div class="menu-note">${item.suburb ? 'A suburb' : item.virtual ? 'Not a file' : 'Lots of small files'}: walk in to pick what to demolish.</div>` : '');
  menu.hidden = false;
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = Math.min(x + 8, window.innerWidth - mw - 8) + 'px';
  menu.style.top = Math.min(y + 8, window.innerHeight - mh - 8) + 'px';
  tooltip.hidden = true;
}
menu.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  const act = btn && btn.dataset.act;
  if (!act || !menuItem) return;
  const item = menuItem;
  if (act === 'open') {
    const target = relativePath(item);
    if (target) {
      state.path = target;
      layout();
    }
  } else if (act === 'leave') {
    leaveBuilding();
  } else if (act === 'reveal') {
    api.reveal(item.path);
    closeMenu();
  } else if (act === 'demolish') {
    menu.innerHTML = `<div class="menu-head" style="--kind:#e5484d"><span class="swatch"></span><div><b>Demolish ${esc(item.name)}?</b><span>${fmt(item.size)} goes to the Trash. You can restore it from there.</span></div></div><button data-act="confirm" class="confirm">🧨 Yes, demolish</button><button data-act="cancel" class="cancel">Keep it</button>`;
  } else if (act === 'cancel') {
    closeMenu();
  } else if (act === 'confirm') {
    closeMenu();
    await demolish(item);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!menu.hidden) closeMenu();
    else leaveBuilding();
  }
  if (e.key === 'Backspace' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) leaveBuilding();
});

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
    mesh.userData.build = null;
    for (const pc of mesh.userData.pieces || []) blocks.remove(pc);
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
  const dt = Math.min(0.1, clock.getDelta());
  const t = clock.elapsedTime;
  controls.update();
  updateLife(dt, t);
  if (site) updateSite(dt, t);
  stepNight(dt);
  if (nightK >= 1) stars.material.opacity = 0.78 + 0.2 * Math.sin(t * 2.3);
  for (const c of clouds.children) {
    c.position.x += c.userData.speed * dt * 1.8;
    if (c.position.x > 280) c.position.x = -280;
  }
  for (const m of meshes) {
    const th = m.userData.targetH;
    const bd = m.userData.build;
    if (bd && !bd.done) {
      bd.t += dt;
      const p = Math.min(1, Math.max(0, bd.t / bd.dur));
      const curH = th * Math.max(0.001, easeOutBack(p));
      m.scale.y = curH;
      let allPopped = true;
      for (const pc of m.userData.pieces) {
        if (pc.userData.pop >= 1) continue;
        if (p >= 1 || curH >= pc.userData.attachY - 0.05) {
          pc.userData.pop = Math.min(1, pc.userData.pop + dt * 4.5);
          const k = easeOutBack(pc.userData.pop);
          const f = pc.userData.finalScale;
          pc.scale.set(f[0] * k, f[1] * k, f[2] * k);
        }
        if (pc.userData.pop < 1) allPopped = false;
      }
      if (p >= 1 && allPopped) bd.done = true;
    } else if (Math.abs(m.scale.y - th) > 0.01) {
      m.scale.y += (th - m.scale.y) * Math.min(1, dt * 7);
    }
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
    $('disk-big').textContent = state.tree ? fmt(state.tree.size) : '—';
    return;
  }
  const used = root.total - root.free;
  const pct = (used / root.total) * 100;
  const ring = $('ring-fill');
  const C = 2 * Math.PI * 35;
  ring.style.strokeDashoffset = (C * (1 - pct / 100)).toFixed(1);
  ring.classList.toggle('warn', pct > 85);
  $('disk-big').innerHTML = `${esc(fmt(root.free))}<small>free</small>`;
  $('gauge-label').textContent = `${fmt(used)} of ${fmt(root.total)} used (${pct.toFixed(0)}%)`;
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
    .map(([k, l]) => `<span><span class="dot" style="background:#${KIND_COLORS[k].toString(16).padStart(6, '0')}"></span><b>${SUBURB_NAMES[k]}</b><small>${l}</small></span>`)
    .join('');
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------
// Full Disk Access (macOS). One prompt, one switch, no more pop-ups. The
// overlay polls until the switch is on, then the scan starts by itself.
let permTimer = null;
async function ensureAccess() {
  if (DEMO || !api.permStatus) return true;
  const st = await api.permStatus();
  if (st.fullDisk) return true;
  if (sessionStorage.getItem('ss-perm-skip')) return true;
  return new Promise((resolve) => {
    const perm = $('perm');
    perm.hidden = false;
    const done = (ok) => {
      clearInterval(permTimer);
      permTimer = null;
      perm.hidden = true;
      resolve(ok);
    };
    $('btn-perm-open').onclick = () => api.openPermissions();
    $('btn-perm-skip').onclick = () => {
      sessionStorage.setItem('ss-perm-skip', '1');
      done(true);
    };
    clearInterval(permTimer);
    permTimer = setInterval(async () => {
      const now = await api.permStatus();
      if (now.fullDisk) {
        toast('Full access granted. Scanning…');
        done(true);
      }
    }, 1500);
  });
}

async function runScan(root) {
  if (state.scanning) return;
  if (!(await ensureAccess())) return;
  state.scanning = true;
  $('btn-scan').disabled = true;
  $('progress').hidden = false;
  tooltip.hidden = true;
  buildSite();
  const off = api.onProgress((p) => {
    $('progress-text').textContent = `Scanning… ${p.files.toLocaleString()} files · ${fmt(p.bytes)}`;
    setScanProgress(p);
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
    layout();
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

$('btn-leave').onclick = leaveBuilding;
$('btn-night').onclick = toggleNight;
// Side panel: collapsed by default, remembered per browser.
function setPanel(open) {
  $('panel').classList.toggle('collapsed', !open);
  $('btn-panel').title = open ? 'Hide details' : 'Show details';
  try {
    localStorage.setItem('ss-panel-open', open ? '1' : '0');
  } catch {}
}
let panelOpen = false;
try {
  panelOpen = localStorage.getItem('ss-panel-open') === '1';
} catch {}
setPanel(panelOpen);
$('btn-panel').onclick = () => setPanel($('panel').classList.contains('collapsed'));
$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  for (const t of $('tabs').children) t.classList.toggle('active', t === tab);
  for (const page of document.querySelectorAll('.tab-page')) page.hidden = page.id !== 'tab-' + tab.dataset.tab;
});
renderLegend();
api.diskInfo().then((d) => {
  state.disk = d;
  renderDisk();
});
if (DEMO) {
  $('btn-scan').querySelector('span').textContent = 'Scan (demo data)';
  runScan(null);
}

// Exposed for automated UI checks.
window.__storageSaver = { state, openMenu, layout, toggleNight, buildSite, setScanProgress };

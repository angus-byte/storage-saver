import * as THREE from './vendor/three.module.js';
import { OrbitControls } from './vendor/OrbitControls.js';
import { initCityHall } from './cityhall.js';
import { initPhotos } from './photos.js';
import { initPrivacy } from './privacy.js';
import { initPerformance } from './perf.js';
import { initMaintenance } from './maintenance.js';
import { squarify } from './treemap.js';
import { categorize, CATEGORIES } from './categories.js';
import { mockTree, mockSuggestions, mockDisk } from './mock.js';
import { initPro, demoPlanApi, mockDeep } from './pro.js';
import { initSeasons } from './seasons.js';
import { localizeDom, IS_WIN } from './platform.js';
import { initDrives } from './drives.js';

localizeDom();

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
          progressHandlers.forEach((cb) => cb({ files: i * 20400, bytes: i * 18.9e9, current: '/Users/angus/Movies/…', done }));
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
      ...demoPlanApi((p) => findSize(p)),
    }
  : window.storage;
if (DEMO) api.deepScan = async () => mockDeep();
// Top-level user / system folders (~/Pictures, /Applications…) are never
// offered for Demolish. Some (Pictures, Downloads…) can have their contents cleared.
const protectedMap = new Map();
const normPath = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase() || '/';
(async () => {
  let list = [];
  try {
    if (api.protectedPaths) list = await api.protectedPaths();
    else if (DEMO) {
      const h = '/Users/angus';
      list = [['/', 0], [h, 0], [h + '/Library', 0], ['/Applications', 0], ...['Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures'].map((f) => [h + '/' + f, 1])].map(([p, c]) => ({ path: p, name: p.split('/').pop(), contents: !!c }));
    }
  } catch {}
  for (const r of list) protectedMap.set(normPath(r.path), r);
})();
const protectionOf = (p) => protectedMap.get(normPath(p)) || null;
// Size of a scanned path (demo mode uses it to apply the free allowance).
function findSize(p) {
  const lists = [...Object.values(state.suggestions || {}), ...Object.values(state.deep || {})];
  for (const g of lists) for (const i of g.items) if (i.path === p) return i.size;
  let hit = 0;
  const walk = (n) => {
    if (hit || !n) return;
    if (n.path === p && !n.aggregate) hit = n.size;
    (n.children || []).forEach(walk);
  };
  walk(state.tree);
  return hit;
}
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
for (const c of CATEGORIES) KIND_COLORS[c.id] = c.color;
const KIND_LABELS = { cache: 'Caches & temp', trash: 'Trash', downloads: 'Downloads & installers', media: 'Video, photo & audio', apps: 'Apps', documents: 'Documents', system: 'System', other: 'Other', free: 'Free space (park)' };
for (const c of CATEGORIES) KIND_LABELS[c.id] = c.label;
const BASE_W = 112;
const BASE_D = 86;
const STREET = 5; // gap between districts
const SIDEWALK = 1.0; // pavement ring inside a district
const LOT_GAP = 0.45; // gap between buildings in a district
const MAX_H = 85;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
// city: one node per main category (see categories.js); open: the category whose files show in the panel.
const SYS_OTHER = 'sysother'; // the "System & other users" building
const state = { disk: null, tree: null, city: [], open: null, suggestions: null, deep: null, selected: new Map(), scanning: false };
let pro = null; // free / Pro plan UI, see pro.js
let seasons = null; // Pro autumn / winter, see seasons.js
let drives = null; // cloud / other drives window, see drives.js
let night = false; // target state
let nightK = 0; // 0 = full day, 1 = full night; eased towards the target each frame
const clock = new THREE.Clock();
const NIGHT_SECONDS = 4.5;
// Auto day/night: by default the lighting runs a full 24 hours every
// CYCLE_SECONDS while the app is open. Only the light and sky follow this
// clock; cars, people and everything else keep their normal speed. Clicking
// the Day / Night button stops the cycle and stays in that mode.
const CYCLE_SECONDS = 120;
const SUN_SWING = 0.4; // radians the sun / moon travel round the sky across the day / night
let autoCycle = true;
let cycleP = 0.04; // 0..1 through the day; starts just after sunrise
let sunAngle = 0;
const _yAxis = new THREE.Vector3(0, 1, 0);
const MOON_BASE = new THREE.Vector3(-260, 170, -330);
let labelPairs = [];
let pickExtras = []; // roofs, spires, signs and labels that count as clicking their building

// ---------------------------------------------------------------------------
// Scene setup
// ---------------------------------------------------------------------------
const container = document.getElementById('scene');
// Logarithmic depth keeps far-away facades from z-fighting (flicker) when the
// whole city is in view.
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance', logarithmicDepthBuffer: true });
renderer.setClearColor(0x000000, 0); // the CSS gradient behind the canvas is the sky
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.VSMShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.98;
container.appendChild(renderer.domElement);

const SKY = 0x3cb6b4;
const scene = new THREE.Scene();
scene.background = null;
scene.fog = new THREE.Fog(0x4fbdbb, 320, 700);

const camera = new THREE.PerspectiveCamera(32, window.innerWidth / window.innerHeight, 1, 1500);
camera.position.set(165, 150, 185);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI / 2.1;
controls.minDistance = 50;
controls.maxDistance = 520;
controls.target.set(0, 14, 0);

const hemi = new THREE.HemisphereLight(0xdff3ef, 0x4a4238, 0.4);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffe6c4, 3.6); // hard, warm afternoon sun
key.position.set(130, 95, 55); // lower sun: longer, crisper shadows
key.castShadow = true;
// Finer shadow map on Mac so moving sun shadows glide; Windows laptops keep 2048 for speed.
key.shadow.mapSize.setScalar(window.storage && window.storage.platform === "win32" ? 2048 : 4096);
key.shadow.camera.left = -140;
key.shadow.camera.right = 140;
key.shadow.camera.top = 140;
key.shadow.camera.bottom = -140;
key.shadow.camera.far = 500;
key.shadow.bias = -0.0002;
key.shadow.radius = 1.5; // crisp daytime shadows (softened at night in applyNight)
key.shadow.blurSamples = 16;
scene.add(key);
const fill = new THREE.DirectionalLight(0x9fd8e8, 0.12);
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
// Reflections: a small sky (gradient dome + sun or moon) rendered into an
// environment map, so glass, water, metal and cars mirror the sky. One map
// for day and one for night; applyNight swaps and blends them.
const pmrem = new THREE.PMREMGenerator(renderer);
function skyEnv(top, horizon, ground, light, lightPos, lightPower) {
  const env = new THREE.Scene();
  const geo = new THREE.SphereGeometry(100, 32, 16);
  const cols = [];
  const cT = new THREE.Color(top), cH = new THREE.Color(horizon), cG = new THREE.Color(ground), c = new THREE.Color();
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 100;
    if (y >= 0) c.copy(cH).lerp(cT, Math.pow(y, 0.6));
    else c.copy(cH).lerp(cG, Math.min(1, -y * 3));
    cols.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  env.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide })));
  const sun = new THREE.Mesh(new THREE.SphereGeometry(7, 16, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(light).multiplyScalar(lightPower) }));
  sun.position.copy(lightPos).setLength(85);
  env.add(sun);
  const tex = pmrem.fromScene(env, 0.02).texture;
  geo.dispose();
  return tex;
}
const envDay = skyEnv(0x5cc4c2, 0xd9f4ee, 0x5a5a52, 0xfff0d6, new THREE.Vector3(130, 95, 55), 6);
const envNight = skyEnv(0x0b1430, 0x22346e, 0x05070f, 0xcfd8ff, new THREE.Vector3(-260, 170, -330), 2.5);
scene.environment = envDay;
scene.environmentIntensity = 0.28;

const moonGlow = glow(-260, 170, -330, 70, 0xcfd8ff, 0.5, 0.3);
scene.add(moonGlow);
nightOnly.push(moonGlow);

// The plinth: a chunky grey base; its top is the asphalt the districts sit on.
const city = new THREE.Group();
scene.add(city);
// Dark charcoal slab with a chamfered edge; the pale kerb sits on its rim.
const plinthShape = new THREE.Shape();
{
  const hw = BASE_W / 2 + 4.2;
  const hd = BASE_D / 2 + 4.2;
  const r = 1.2;
  plinthShape.moveTo(-hw + r, -hd);
  plinthShape.lineTo(hw - r, -hd);
  plinthShape.quadraticCurveTo(hw, -hd, hw, -hd + r);
  plinthShape.lineTo(hw, hd - r);
  plinthShape.quadraticCurveTo(hw, hd, hw - r, hd);
  plinthShape.lineTo(-hw + r, hd);
  plinthShape.quadraticCurveTo(-hw, hd, -hw, hd - r);
  plinthShape.lineTo(-hw, -hd + r);
  plinthShape.quadraticCurveTo(-hw, -hd, -hw + r, -hd);
}
const plinthGeo = new THREE.ExtrudeGeometry(plinthShape, { depth: 5.5, bevelEnabled: true, bevelThickness: 1.6, bevelSize: 1.6, bevelSegments: 3, curveSegments: 6 });
plinthGeo.rotateX(Math.PI / 2);
plinthGeo.translate(0, -1.6, 0); // bevel top sits at y = 0, under the kerb and asphalt
const plinth = new THREE.Mesh(plinthGeo, new THREE.MeshStandardMaterial({ color: 0x2c3038, metalness: 0.15, roughness: 0.55 }));
plinth.receiveShadow = true;
plinth.castShadow = true;
city.add(plinth);
// Soft shadow pad under the slab so it reads as sitting on the ground.
const padMat = new THREE.MeshBasicMaterial({ color: 0x0a2a2e, transparent: true, opacity: 0.07, depthWrite: false });
const pad = new THREE.Mesh(new THREE.CircleGeometry(1, 48), padMat);
pad.rotation.x = -Math.PI / 2;
pad.scale.set(BASE_W * 0.62, BASE_D * 0.66, 1);
pad.position.y = -7.2;
city.add(pad);
const asphalt = new THREE.Mesh(
  new THREE.BoxGeometry(BASE_W + 4, 0.6, BASE_D + 4),
  new THREE.MeshStandardMaterial({ color: 0x4a4f5a, roughness: 0.95 })
);
asphalt.position.y = 0.3;
asphalt.receiveShadow = true;
city.add(asphalt);
const kerb = new THREE.Mesh(
  new THREE.BoxGeometry(BASE_W + 8.4, 0.5, BASE_D + 8.4),
  new THREE.MeshStandardMaterial({ color: 0xe9ebee, roughness: 0.9 })
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
const barrelGeo = new THREE.CylinderGeometry(0.5, 0.5, 1, 28);
barrelGeo.translate(0, 0.5, 0);
const pavementMat = new THREE.MeshStandardMaterial({ color: 0xdedbd3, roughness: 0.9 });
const parkMat = new THREE.MeshStandardMaterial({ color: 0x8ccf76, roughness: 0.95 });
const roofMat = new THREE.MeshStandardMaterial({ color: 0xc8734e, roughness: 0.75 }); // terracotta caps, as in the reference
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



// Facade textures per building style, drawn on a 256px canvas. Windows sit in
// the same 8x8 grid as the night window map (cells of 32px, glass at
// x 6..26, y 4..22) so lit windows line up after dark. Each texture also
// gets a bump map (same drawing in greys) so mortar, frames and sills read
// as relief in the hard sun.
const FACADE_KINDS = ['office', 'brick', 'stone', 'glass', 'concrete'];
function makeFacade(kind, seed) {
  const S = 256;
  const C = 32;
  const col = document.createElement('canvas');
  const bmp = document.createElement('canvas');
  col.width = col.height = bmp.width = bmp.height = S;
  const c = col.getContext('2d');
  const k = bmp.getContext('2d');
  let r = seed * 13 + 7;
  const rnd = () => ((r = (r * 9301 + 49297) % 233280) / 233280);
  const both = (fillC, fillB, x, y, w, h) => {
    if (fillC) {
      c.fillStyle = fillC;
      c.fillRect(x, y, w, h);
    }
    if (fillB) {
      k.fillStyle = fillB;
      k.fillRect(x, y, w, h);
    }
  };
  const glassFill = () => {
    const v = rnd();
    return v < 0.14 ? 'rgba(255,232,180,0.85)' : v < 0.32 ? 'rgba(150,200,225,0.75)' : 'rgba(42,58,84,0.8)';
  };
  // Window with frame, sill and a sky glint at the top.
  const win = (x, y, w, h, frame = 'rgba(30,30,36,0.55)', sill = true) => {
    both(frame, '#303030', x - 1.5, y - 1.5, w + 3, h + 3);
    both(glassFill(), '#1a1a1a', x, y, w, h);
    c.fillStyle = 'rgba(255,255,255,0.28)';
    c.fillRect(x, y, w, 2.5);
    c.fillStyle = 'rgba(255,255,255,0.08)';
    c.beginPath();
    c.moveTo(x, y + h);
    c.lineTo(x + w * 0.45, y);
    c.lineTo(x + w * 0.65, y);
    c.lineTo(x + w * 0.2, y + h);
    c.fill();
    if (sill) both('rgba(255,255,255,0.45)', '#e6e6e6', x - 2.5, y + h + 1.5, w + 5, 2.5);
  };
  if (kind === 'brick') {
    both('#ffffff', '#9a9a9a', 0, 0, S, S);
    for (let y = 0; y < S; y += 4) {
      const off = (y / 4) % 2 ? 4 : 0;
      for (let x = -8; x < S; x += 8) {
        const t = 0.82 + rnd() * 0.3;
        both(`rgba(${Math.round(255 * t)},${Math.round(236 * t)},${Math.round(226 * t)},1)`, '#b4b4b4', x + off, y, 7, 3);
      }
    }
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        both('rgba(255,255,255,0.6)', '#d0d0d0', x * C + 5, y * C + 2, 22, 3); // lintel
        win(x * C + 6, y * C + 5, 20, 17, 'rgba(250,250,245,0.9)');
        both('rgba(0,0,0,0.18)', null, x * C + 15.5, y * C + 5, 1.5, 17); // sash bar
      }
  } else if (kind === 'stone') {
    both('#f4f1ea', '#a8a8a8', 0, 0, S, S);
    for (let y = 0; y < S; y += 8) both('rgba(0,0,0,0.07)', '#8c8c8c', 0, y, S, 1);
    for (let y = 0; y < S; y += 8) for (let x = ((y / 8) % 2) * 12; x < S; x += 24) both('rgba(0,0,0,0.06)', '#8c8c8c', x, y, 1, 8);
    for (let x = 0; x < 8; x++) both('rgba(255,255,255,0.35)', '#d8d8d8', x * C, 0, 4, S); // pilasters
    for (let y = 0; y < 8; y++) {
      both('rgba(0,0,0,0.12)', '#cfcfcf', 0, y * C + 27, S, 3); // string course
      for (let x = 0; x < 8; x++) win(x * C + 8, y * C + 4, 16, 19, 'rgba(60,52,40,0.55)');
    }
  } else if (kind === 'glass') {
    both('#c9c2b8', '#202020', 0, 0, S, S);
    const g = c.createLinearGradient(0, 0, S, S);
    g.addColorStop(0, 'rgba(255,255,255,0.35)');
    g.addColorStop(0.5, 'rgba(255,255,255,0)');
    g.addColorStop(1, 'rgba(255,255,255,0.18)');
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        const v = rnd();
        c.fillStyle = v < 0.12 ? 'rgba(255,236,190,0.55)' : v < 0.5 ? 'rgba(88,92,98,0.7)' : 'rgba(58,62,70,0.75)';
        c.fillRect(x * C + 2, y * C + 2, C - 4, C - 4);
      }
    c.fillStyle = g;
    c.fillRect(0, 0, S, S);
    for (let i = 0; i <= S; i += C) {
      both('rgba(240,232,220,0.95)', '#d0d0d0', i - 2, 0, 4, S); // mullions
      both('rgba(240,232,220,0.95)', '#d0d0d0', 0, i - 2, S, 4); // transoms
    }
    for (let i = C / 2; i < S; i += C) both('rgba(225,232,238,0.5)', '#909090', i - 0.5, 0, 1, S);
  } else if (kind === 'concrete') {
    both('#f0efec', '#b0b0b0', 0, 0, S, S);
    for (let i = 0; i < 900; i++) both(`rgba(0,0,0,${0.03 + rnd() * 0.05})`, null, rnd() * S, rnd() * S, 2, 2);
    for (let y = 0; y < 8; y++) {
      // Ribbon window per floor with thin frames, a deep spandrel beneath.
      both('rgba(30,34,44,0.6)', '#2a2a2a', 0, y * C + 3, S, 21);
      for (let x = 0; x < 8; x++) {
        both(glassFill(), '#1a1a1a', x * C + 1, y * C + 4, C - 2, 19);
        c.fillStyle = 'rgba(255,255,255,0.22)';
        c.fillRect(x * C + 1, y * C + 4, C - 2, 2);
      }
      both('rgba(255,255,255,0.55)', '#ececec', 0, y * C + 24, S, 2); // slab edge
      both('rgba(0,0,0,0.08)', null, 0, y * C + 26, S, 6);
    }
  } else {
    // Office: spandrel bands, framed windows, column lines.
    both('#ffffff', '#b8b8b8', 0, 0, S, S);
    for (let y = 0; y < 8; y++) both('rgba(0,0,0,0.09)', '#a0a0a0', 0, y * C + 25, S, 7);
    for (let x = 0; x < 8; x++) both('rgba(0,0,0,0.05)', '#c8c8c8', x * C + 29, 0, 3, S);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) win(x * C + 6, y * C + 4, 20, 18, 'rgba(0,0,0,0.3)', false);
  }
  const tex = new THREE.CanvasTexture(col);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const bump = new THREE.CanvasTexture(bmp);
  bump.wrapS = bump.wrapT = THREE.RepeatWrapping;
  return { tex, bump };
}
const facadeTex = {};
for (const kind of FACADE_KINDS) facadeTex[kind] = [1, 2, 3].map((sd) => makeFacade(kind, sd));
const STYLE_FACADE = { brick: 'brick', deco: 'stone', chrysler: 'stone', civic: 'stone', stepped: 'brick', glass: 'glass', twin: 'glass', modern: 'concrete', shop: 'brick', default: 'office' };

function facadeMaterial(kind, w, h, d, variant = 0, style = null) {
  const fk = STYLE_FACADE[style] || (variant % 2 ? 'concrete' : 'office');
  const set = facadeTex[fk][variant % 3];
  const tex = set.tex.clone();
  const bump = set.bump.clone();
  tex.needsUpdate = bump.needsUpdate = true;
  // One tile = 8 x 8 windows, about 1.2 units per storey (people are ~0.6 tall).
  tex.repeat.set(Math.max(0.5, Math.round((Math.max(w, d) / 9.6) * 2) / 2), Math.max(0.5, Math.round((h / 9.6) * 2) / 2));
  bump.repeat.copy(tex.repeat);
  const color = new THREE.Color(KIND_COLORS[kind] || KIND_COLORS.other);
  const hsl = {};
  color.getHSL(hsl);
  color.setHSL(hsl.h + (Math.random() - 0.5) * 0.03, hsl.s, Math.min(0.9, hsl.l + (Math.random() - 0.5) * 0.12));
  const em = makeNightWindowTexture(Math.floor(Math.random() * 1e6));
  em.repeat.copy(tex.repeat);
  const mat = new THREE.MeshStandardMaterial({ color, map: tex, bumpMap: bump, bumpScale: fk === 'glass' ? 0.6 : 1.4, roughness: fk === 'glass' ? 0.25 : 0.78, metalness: fk === 'glass' ? 0.35 : 0.04, emissive: 0xffffff, emissiveMap: em, emissiveIntensity: night ? 0.9 : 0 });
  mat.userData.dayI = 0;
  mat.userData.nightI = 0.9;
  mat.userData.th = 0.35 + Math.random() * 0.6;
  return mat;
}
// Trim (cornices, ledges, quoins, podiums) is a much darker, warmer shade of
// the facade, like the reference city's brown-red bands on cream and brick.
const TRIM_BROWN = new THREE.Color(0x5e3326);
function trimMaterial(base) {
  const c = base.color.clone();
  const hsl = {};
  c.getHSL(hsl);
  c.setHSL(hsl.h, Math.min(1, hsl.s * 1.05), Math.max(0.12, hsl.l * 0.5));
  c.lerp(TRIM_BROWN, 0.35);
  return new THREE.MeshStandardMaterial({ color: c, roughness: 0.75 });
}
const glassMat = new THREE.MeshStandardMaterial({ color: 0x9aa4a6, roughness: 0.08, metalness: 0.75 });
const darkMat = new THREE.MeshStandardMaterial({ color: 0x2b3240, roughness: 0.8 });
const awningMat = new THREE.MeshStandardMaterial({ color: 0xa84a35, roughness: 0.9 });
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
const waterMat = new THREE.MeshStandardMaterial({ color: 0x4fb6e0, roughness: 0.05, metalness: 0.55 });
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
  pickExtras = [];
  carMesh = cabMesh = headMesh = tailMesh = peopleBody = peopleHead = peopleHat = null;
  site = null;
  landmarkAnims = [];
  // Drop night-only objects that belonged to the old layout.
  for (let i = nightOnly.length - 1; i >= 0; i--) if (nightOnly[i].parent === blocks || !nightOnly[i].parent) nightOnly.splice(i, 1);
}

let maxSizeInView = 1;
function heightFor(size) {
  return 6 + MAX_H * Math.sqrt(size / Math.max(maxSizeInView, 1));
}
// Lot (footprint) area grows slowly with size so big items become towers, not slabs.
function lotFor(size) {
  return 6 + 48 * Math.pow(size / Math.max(maxSizeInView, 1), 0.45);
}

// The city shows one building per main category. Each sits on its own block
// so streets run between them; clicking one lists its files in the panel.
function layout() {
  clearBlocks();
  closeMenu();
  if (!state.tree) return;
  const node = state.tree;
  state.city = categorize(node);
  const items = [...state.city];
  if (state.disk && state.disk.roots[0]) {
    const { total, free } = state.disk.roots[0];
    if (total > 0) {
      const otherUsed = Math.max(0, total - free - node.size);
      if (free > 0) items.push({ name: 'Free space', size: free, kind: 'free', isDir: false, virtual: true });
      if (otherUsed > node.size * 0.02) items.push({ name: 'System & other users', size: otherUsed, kind: 'system', isDir: false, virtual: true, files: 0, category: SYS_OTHER });
    }
  }
  items.sort((a, b) => b.size - a.size);
  maxSizeInView = items.length ? items[0].size : 1;
  // One block per building (free space becomes the park).
  const groups = new Map();
  for (const it of items) {
    const k = it.category || it.name;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(it);
  }
  const suburbs = [...groups.entries()].map(([kind, list]) => {
    const lots = list.map((it) => ({ size: lotFor(it.size), item: it }));
    const area = lots.reduce((s, l) => s + l.size, 0);
    return { kind: list[0].kind, list, lots, size: area * 1.3 + 24, total: list.reduce((s, i) => s + i.size, 0) };
  });
  suburbs.sort((a, b) => b.size - a.size);
  const rects = squarify(suburbs, { x: -BASE_W / 2, y: -BASE_D / 2, w: BASE_W, h: BASE_D });
  for (const r of rects) placeSuburb(r);
  buildStreets(rects);
  buildPeople(rects);
  placeTrees();
  renderCrumbs();
  renderFiles();
  if (state.open) {
    const fm = meshes.find((m) => !m.userData.district && m.userData.item.category === state.open);
    focusMesh = fm || null;
    focusTarget = fm ? 1 : 0;
  }
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
  // Golden hour: a warm glow that peaks just before the sun sets (and, run
  // backwards, just after it rises) and tints the sky, fog and light.
  const glow = Math.max(0, 1 - Math.abs(k - 0.35) / 0.35);
  const warm = glow * glow * (3 - 2 * glow);
  document.documentElement.style.setProperty('--dusk', warm.toFixed(3));
  document.body.classList.toggle('night', k > 0.5);
  $('btn-night').textContent = nightLabel();
  scene.fog.color.copy(lerpHex(_c1, 0x4fbdbb, 0x0c1430, k));
  hemi.color.copy(lerpHex(_c1, 0xdff3ef, 0x3a4a7a, k));
  hemi.groundColor.copy(lerpHex(_c1, 0x4a4238, 0x0c1020, k));
  scene.fog.color.lerp(_c2.setHex(0xe8875a), warm * 0.7);
  // Thicker haze in the golden hour.
  scene.fog.near = 320 - 150 * warm;
  scene.fog.far = 700 - 200 * warm;
  hemi.color.lerp(_c2.setHex(0xffb98a), warm * 0.55);
  hemi.intensity = 0.4 + (0.35 - 0.4) * k;
  fill.intensity = 0.12 + (0.15 - 0.12) * k;
  // Softer shadow edges while the sun is moving, so they glide rather than shimmer.
  key.shadow.radius = (autoCycle ? 6 : 1.5) + 4.5 * k;
  renderer.toneMappingExposure = 0.98 + (0.95 - 0.98) * k;
  scene.environment = k < 0.5 ? envDay : envNight;
  scene.environmentIntensity = k < 0.5 ? 0.28 * (1 - k * 1.4) : 0.3 * (k - 0.3);
  // Sun: warm and high → low orange at the horizon → cool moonlight from the other side.
  if (k < 0.5) {
    const u = k / 0.5;
    key.color.copy(lerpHex(_c1, 0xffe6c4, 0xff7a3d, Math.min(1, u * 1.6)));
    key.intensity = 3.6 + (1.1 - 3.6) * u;
    key.position.set(130 + (170 - 130) * u, 95 + (14 - 95) * u, 55 + (-40 - 55) * u);
  } else {
    const u = (k - 0.5) / 0.5;
    key.color.copy(lerpHex(_c1, 0xff7a3d, 0x9fb4ff, u));
    key.intensity = 1.1 + (0.55 - 1.1) * u;
    key.position.set(170 + (-90 - 170) * u, 14 + (130 - 14) * u, -40 + (-70 + 40) * u);
  }
  applySunAngle();
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
  if (seasons) seasons.tintLights({ fog: scene.fog, hemi, key, nightK: k });
  applyFocusDim();
}
// Spotlight: selecting a building drops a ray of light onto it while the
// rest of the city (lights, reflections, sky) dims. focusK eases 0 -> 1.
let focusMesh = null;
let focusK = 0;
let focusTarget = 0;
let beamT = 0;
const focusSpot = new THREE.SpotLight(0xfff4d6, 0, 0, Math.PI / 14, 0.55, 0);
focusSpot.visible = false;
scene.add(focusSpot, focusSpot.target);
const rayGeo = new THREE.CylinderGeometry(0.18, 1, 1, 40, 1, true).translate(0, -0.5, 0); // hangs down from y=0
const rayMat = new THREE.MeshBasicMaterial({ color: 0xfff2c8, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
const ray = new THREE.Mesh(rayGeo, rayMat);
ray.visible = false;
ray.renderOrder = 5;
scene.add(ray);
const RAY_TOP = 190;
const _focusAim = new THREE.Vector3();
const _focusSrc = new THREE.Vector3();
const _focusDir = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);
function setFocus(mesh) {
  if (mesh && mesh !== focusMesh) beamT = 0;
  focusMesh = mesh || focusMesh;
  focusTarget = mesh ? 1 : 0;
}
function applyFocusDim() {
  const d = 1 - 0.68 * focusK;
  hemi.intensity *= d;
  fill.intensity *= d;
  key.intensity *= 1 - 0.75 * focusK;
  scene.environmentIntensity *= d;
  document.documentElement.style.setProperty('--focus', (focusK * 0.55).toFixed(3));
}
function stepFocus(dt) {
  const prev = focusK;
  focusK += (focusTarget - focusK) * Math.min(1, dt * (focusTarget ? 3.2 : 4.5));
  if (Math.abs(focusK - focusTarget) < 0.002) focusK = focusTarget;
  if (focusK !== prev) applyNight();
  const m = focusMesh;
  const on = focusK > 0.001 && m && m.parent;
  ray.visible = focusSpot.visible = !!on;
  if (!on) {
    if (!focusTarget) focusMesh = null;
    return;
  }
  beamT = Math.min(1, beamT + dt * 1.6);
  const fp = m.userData.footprint || { x: m.position.x, z: m.position.z, w: m.scale.x, d: m.scale.z };
  const topY = 1.1 + m.scale.y;
  const drop = 1 - Math.pow(1 - beamT, 3); // ray shoots down from the sky, easing in
  // The ray comes from high up on the camera's side so it lights the facade, not just the roof.
  const aim = _focusAim.set(fp.x, topY * 0.45, fp.z);
  const src = _focusSrc.set(camera.position.x - controls.target.x, 0, camera.position.z - controls.target.z).setLength(RAY_TOP * 0.45).add(aim);
  src.y = RAY_TOP;
  const dist = src.distanceTo(aim) + topY * 0.6;
  const r = Math.max(fp.w, fp.d) * 0.8 + 2;
  ray.position.copy(src);
  ray.quaternion.setFromUnitVectors(_down, _focusDir.subVectors(aim, src).normalize());
  ray.scale.set(r, Math.max(0.01, dist * drop), r);
  rayMat.opacity = 0.16 * focusK * (0.85 + 0.15 * Math.sin(clock.elapsedTime * 2.2));
  focusSpot.position.copy(src);
  focusSpot.target.position.copy(aim);
  focusSpot.angle = Math.min(0.6, Math.atan2(Math.max(r, topY * 0.6), dist));
  focusSpot.intensity = 6 * focusK * (beamT > 0.8 ? 1 : beamT / 0.8);
}

function nightLabel() {
  const isNight = autoCycle ? nightK > 0.5 : night;
  return isNight ? '☀ Day' : '☾ Night';
}
function toggleNight() {
  // While the cycle runs the button jumps to the other half of the day; either
  // way the cycle stops and the city stays in the chosen mode.
  night = autoCycle ? nightK <= 0.5 : !night;
  autoCycle = false;
  $('btn-night').textContent = nightLabel();
}
// Rotates the sun (key light) and moon round the city by sunAngle, on top of
// the base position applyNight picks for the current nightK.
const _keyBase = new THREE.Vector3(130, 95, 55);
function applySunAngle() {
  _keyBase.copy(key.position);
  key.position.applyAxisAngle(_yAxis, sunAngle);
  moon.position.copy(MOON_BASE).applyAxisAngle(_yAxis, sunAngle);
}
const smooth = (x) => x * x * (3 - 2 * x);
// Day plan as a fraction of the cycle: day, dusk, night, dawn.
const DUSK_AT = 0.36;
const NIGHT_AT = 0.56;
const DAWN_AT = 0.8;
function cycleState(p) {
  if (p < DUSK_AT) return { k: 0, a: SUN_SWING * (1 - p / DUSK_AT) };
  if (p < NIGHT_AT) return { k: smooth((p - DUSK_AT) / (NIGHT_AT - DUSK_AT)), a: 0 };
  if (p < DAWN_AT) return { k: 1, a: SUN_SWING * ((p - NIGHT_AT) / (DAWN_AT - NIGHT_AT)) };
  return { k: 1 - smooth((p - DAWN_AT) / (1 - DAWN_AT)), a: SUN_SWING };
}
function stepCycle(dt) {
  cycleP = (cycleP + dt / CYCLE_SECONDS) % 1;
  const { k, a } = cycleState(cycleP);
  sunAngle = a;
  if (k !== nightK) {
    nightK = k;
    night = k > 0.5;
    applyNight(); // full relight only while the light is changing
  } else {
    // Plateau (full day or night): just move the sun / moon.
    key.position.copy(_keyBase);
    applySunAngle();
  }
}
function stepNight(dt) {
  if (autoCycle) return stepCycle(dt);
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
  slab.userData = { item: { name: sub.list[0].name, size: sub.total, kind: sub.kind, isDir: false, virtual: true, files: sub.list.length, suburb: true }, targetH: 0.5, depth: 0, district: true };
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
    lr.builtH = h;
    if (h > tallest) {
      tallest = h;
      tallestRect = lr;
    }
    const built = meshes.length > before ? meshes[meshes.length - 1].userData.footprint : null;
    fillLot(lr, built);
  }
  // Name label on each category building.
  for (const lr of lotRects.slice(0, 3)) {
    if (lr.w * lr.h > 40) {
      // Use the height actually built (landmarks are capped), not the raw size.
      const bh = lr.builtH || heightFor(lr.item.item.size);
      addLabel(lr.item.item, lr.x + lr.w / 2, 1.1 + bh + (bh > 30 ? bh * 0.2 : 2), lr.y + lr.h / 2, Math.min(lr.w + 6, 26));
    }
  }
}

function placeBuilding(r, depth, gap) {
  const item = r.item.item;
  // Footprint is capped by the item's own lot size, so towers stay slender
  // even when a suburb has room to spare.
  // Buildings fill most of their lot so they read big; scale is deliberately
  // generous next to streets, cars and people.
  const side = Math.sqrt(r.item.size) * 2;
  const w = Math.max(0.3, Math.min(r.w - gap, side * (0.95 + Math.random() * 0.1)));
  const d = Math.max(0.3, Math.min(r.h - gap, side * (0.95 + Math.random() * 0.1)));
  if (w < 0.6 || d < 0.6) return 0;
  let h = heightFor(item.size);
  const landmark = landmarkFor(item);
  if (landmark === 'library') h = Math.min(h, 17);
  if (LANDMARK_MAX_H[landmark]) h = Math.min(h, LANDMARK_MAX_H[landmark]);
  const plain = { library: 0xe9e2d0, tip: 0x7a6a58, studio: 0xd8cfbe, market: 0xd8d2c6 };
  const style = landmark && landmark !== 'music' ? null : styleFor(item, h, Math.min(w, d));
  const mat = plain[landmark] ? new THREE.MeshStandardMaterial({ color: plain[landmark], roughness: 0.9 }) : facadeMaterial(item.kind, w, h, d, Math.floor(Math.random() * 6), style);
  if (style) applyStyleTint(mat, style);
  const b = new THREE.Mesh(boxGeo, mat);
  b.position.set(r.x + r.w / 2, 1.1, r.y + r.h / 2);
  b.scale.set(w, 0.001, d);
  // Stepped styles keep the main shaft short and stack tiers above it.
  const shaft = style ? h * STYLE_SHAFT[style] : h;
  // Build-up animation: a wave sweeps across the city; each building grows
  // from the ground with a playful overshoot, and its details pop on as the
  // shaft reaches them (roofs last).
  const delay = ((b.position.x + b.position.z + BASE_W / 2 + BASE_D / 2) / (BASE_W + BASE_D)) * 0.7 + Math.random() * 0.25;
  b.userData = { item, targetH: shaft, depth, style, build: { t: -delay, dur: 0.7 + Math.min(0.6, h / 60) }, pieces: [] };
  b.castShadow = true;
  b.receiveShadow = true;
  blocks.add(b);
  meshes.push(b);
  activeBuilding = b;
  if (landmark === 'library') decorateLibrary(b, w, h, d, heightFor(item.size));
  else if (landmark === 'tip') decorateTip(b, w, h, d);
  else if (landmark === 'studio') decorateStudio(b, w, h, d, item);
  else if (landmark === 'factory') decorateFactory(b, w, h, d);
  else if (landmark === 'apartments') decorateApartments(b, w, h, d);
  else if (landmark === 'market') decorateMarket(b, w, h, d);
  else if (style && style !== 'default') decorateStyled(b, w, h, d, style);
  else decorate(b, w, h, d);
  if (!landmark || landmark === 'music') facadeDetail(b, w, d, style || 'default');
  if (landmark === 'music' && w > 1.8) guitarSign(b, w, h, d);
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
    m.userData.owner = activeBuilding;
    pickExtras.push(m);
  }
  m.castShadow = shadow;
  m.receiveShadow = true;
  blocks.add(m);
  extras.push(m);
  return m;
}

// Folders with a well-known role get a landmark instead of a generic tower.
const CATEGORY_LANDMARK = { video: 'studio', photos: 'studio', music: 'music', trash: 'tip', system: 'factory', downloads: 'apartments', desktop: 'market', library: 'library' };
function landmarkFor(item) {
  if (item.category) return CATEGORY_LANDMARK[item.category] || null;
  const n = (item.name || '').toLowerCase();
  if (item.virtual && item.kind === 'system') return 'factory';
  if (!item.isDir) return null;
  if (n === 'library') return 'library';
  if (n === 'music') return 'music';
  if (n === 'trash' || n === '.trash' || n === 'bin' || n === '$recycle.bin') return 'tip';
  if (n === 'movies' || n === 'pictures' || n === 'videos' || n === 'photos' || n === 'video' || n === 'films') return 'studio';
  if (n === 'system' || n === 'windows') return 'factory';
  if (n === 'downloads') return 'apartments';
  if (n === 'desktop') return 'market';
  return null;
}
const LANDMARK_MAX_H = { tip: 6, market: 4.5, studio: 24, factory: 22 };

// Painted sign: text on a plane, facing +z. Added straight to the scene (no
// build pop) so the texture never gets squashed.
function textSign(text, x, y, z, w, h, bg = '#1d2230', fg = '#ffffff', opts = {}) {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 128;
  const ctx = c.getContext('2d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, 512, 128);
  if (opts.border) {
    ctx.strokeStyle = opts.border;
    ctx.lineWidth = 10;
    ctx.strokeRect(5, 5, 502, 118);
  }
  ctx.fillStyle = fg;
  let size = opts.size || 72;
  do {
    ctx.font = `bold ${size}px Impact, "Arial Black", -apple-system, system-ui, sans-serif`;
    size -= 4;
  } while (ctx.measureText(text).width > 470 && size > 20);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 256, 68);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.15, roughness: 0.6, side: THREE.DoubleSide }));
  m.material.userData = { dayI: 0.15, nightI: 1.4, th: 0.5 };
  m.position.set(x, y, z);
  if (opts.rotY) m.rotation.y = opts.rotY;
  if (activeBuilding) {
    m.userData.owner = activeBuilding;
    pickExtras.push(m);
  }
  blocks.add(m);
  extras.push(m);
  return m;
}

// Animated landmark props (trucks, gulls, searchlights, smoke) live here and
// are stepped from updateLife.
let landmarkAnims = [];
const truckGreen = new THREE.MeshStandardMaterial({ color: 0x3f8f4f, roughness: 0.6 });
const rubbishMat = new THREE.MeshStandardMaterial({ color: 0x5a5247, roughness: 1 });
const hangarMat = new THREE.MeshStandardMaterial({ color: 0xd8cfbe, roughness: 0.9 });
const hangarRoofMat = new THREE.MeshStandardMaterial({ color: 0x8e8a84, roughness: 0.7 });
const factoryMat = new THREE.MeshStandardMaterial({ color: 0x9a6a56, roughness: 0.9 });
const stackMat = new THREE.MeshStandardMaterial({ color: 0x6b6f76, roughness: 0.8 });
const gullMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
const smokeMat = new THREE.SpriteMaterial({ map: glowTex, color: 0x8d939c, transparent: true, opacity: 0.85, depthWrite: false });
const beamMat2 = new THREE.MeshBasicMaterial({ color: 0xfff2c0, transparent: true, opacity: 0.0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
const awningStripes = [0xb9583c, 0xeadfcb, 0x9a3f2e, 0xd8b28a, 0x7a4a3a];
const beamGeo = new THREE.CylinderGeometry(1.6, 0.25, 1, 12, 1, true);
beamGeo.translate(0, 0.5, 0);

function addGroup(x, y, z) {
  const g = new THREE.Group();
  g.position.set(x, y, z);
  if (activeBuilding) {
    g.userData.owner = activeBuilding;
    pickExtras.push(g);
  }
  blocks.add(g);
  extras.push(g);
  return g;
}
function part(parent, geo, mat, x, y, z, sx, sy, sz, shadow = true) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  m.castShadow = shadow;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

// --- Rubbish tip: mounds, scattered junk, compactor, gulls and garbage trucks.
function decorateTip(b, w, h, d) {
  const x = b.position.x;
  const z = b.position.z;
  const base = 1.1;
  const top = base + h;
  // Mounds of rubbish in grey-brown with coloured junk poking out.
  const mounds = Math.max(2, Math.floor((w * d) / 14));
  for (let i = 0; i < mounds; i++) {
    const mx = x + (Math.random() - 0.5) * w * 0.7;
    const mz = z + (Math.random() - 0.5) * d * 0.7;
    const r = 1.2 + Math.random() * Math.min(2.2, Math.min(w, d) * 0.3);
    piece(sphereGeo, rubbishMat, mx, top - r * 0.45, mz, r * 2, r * 1.3, r * 2);
    for (let k = 0; k < 5; k++) piece(boxGeo, propMat(PROP_COLORS[(i + k) % PROP_COLORS.length]), mx + (Math.random() - 0.5) * r * 1.4, top + Math.random() * r * 0.4, mz + (Math.random() - 0.5) * r * 1.4, 0.35, 0.25, 0.3, false);
  }
  // Chain-link fence with a gate sign.
  for (let fx = -w / 2; fx <= w / 2; fx += 2) {
    piece(cylGeo, poleMat, x + fx, top, z - d / 2, 0.06, 1.4, 0.06, false);
    piece(cylGeo, poleMat, x + fx, top, z + d / 2, 0.06, 1.4, 0.06, false);
  }
  piece(boxGeo, fenceMat, x, top, z - d / 2, w, 1.2, 0.04, false);
  piece(boxGeo, fenceMat, x - w / 2, top, z, 0.04, 1.2, d, false);
  piece(boxGeo, fenceMat, x + w / 2, top, z, 0.04, 1.2, d, false);
  textSign('TIP', x, top + 2.2, z + d / 2 + 0.3, Math.min(4, w * 0.8), 1.0, '#f6c90e', '#1d2230');
  // Compactor (tracked machine) pushing rubbish.
  const g = addGroup(x + w * 0.25, top, z + d * 0.15);
  g.rotation.y = -0.6;
  part(g, boxGeo, trackMat, 0, 0, -0.7, 2.2, 0.5, 0.5);
  part(g, boxGeo, trackMat, 0, 0, 0.7, 2.2, 0.5, 0.5);
  part(g, boxGeo, machineMat, -0.2, 0.5, 0, 1.8, 0.8, 1.5);
  part(g, boxGeo, glassMat, 0.2, 1.3, 0, 0.8, 0.7, 0.9);
  part(g, boxGeo, stackMat, 1.5, 0.1, 0, 0.2, 1.1, 2.2); // blade
  // Gulls circling above.
  for (let i = 0; i < 5; i++) {
    const gull = addGroup(x, top + 4 + Math.random() * 3, z);
    part(gull, boxGeo, gullMat, 0, 0, 0, 0.5, 0.12, 0.2, false);
    const l = part(gull, boxGeo, gullMat, -0.5, 0.05, 0, 0.7, 0.06, 0.15, false);
    const r = part(gull, boxGeo, gullMat, 0.5, 0.05, 0, 0.7, 0.06, 0.15, false);
    landmarkAnims.push({ kind: 'gull', g: gull, l, r, cx: x, cz: z, rad: 1.5 + Math.random() * Math.max(2, Math.min(w, d) * 0.6), y: gull.position.y, phase: Math.random() * 6.28, speed: 0.5 + Math.random() * 0.4 });
  }
  // Garbage trucks on a loop around the tip.
  const m = 1.3;
  const loop = { loop: true, points: [[x - w / 2 - m, z - d / 2 - m], [x + w / 2 + m, z - d / 2 - m], [x + w / 2 + m, z + d / 2 + m], [x - w / 2 - m, z + d / 2 + m]] };
  loop.length = pathLength(loop);
  const n = loop.length > 30 ? 3 : 2;
  for (let i = 0; i < n; i++) {
    const t = addGroup(x, base, z);
    part(t, boxGeo, darkMat, 0, 0.3, 0, 0.9, 0.3, 2.4); // chassis
    part(t, boxGeo, truckGreen, 0, 0.6, 0.75, 0.95, 0.8, 0.8); // cab
    part(t, boxGeo, glassMat, 0, 0.95, 1.16, 0.8, 0.4, 0.04, false);
    part(t, boxGeo, truckGreen, 0, 0.6, -0.45, 1.0, 1.0, 1.5); // hopper
    part(t, boxGeo, darkMat, 0, 0.9, -1.25, 0.9, 0.6, 0.2, false); // tailgate
    part(t, sphereGeo, beaconMat.clone(), 0, 1.72, 0.75, 0.2, 0.2, 0.2, false).userData.blink = Math.random() * 2;
    for (const [sx, sz] of [[-0.5, 0.75], [0.5, 0.75], [-0.5, -0.6], [0.5, -0.6]]) {
      const wh = part(t, cylGeo, trackMat, sx, 0.3, sz, 0.5, 0.2, 0.5, false);
      wh.rotation.z = Math.PI / 2;
      wh.position.set(sx, 0.3, sz);
    }
    landmarkAnims.push({ kind: 'truck', g: t, loop, s: (i * loop.length) / n, speed: 2.5 + Math.random() });
  }
}

// --- Hollywood studio lot: sound stage with a barrel roof, painted sign,
// water tower, lighting rigs and searchlights that sweep the night sky.
function decorateStudio(b, w, h, d, item) {
  const x = b.position.x;
  const z = b.position.z;
  const base = 1.1;
  const top = base + h;
  const front = z + d / 2;
  const name = (item.name || '').toUpperCase();
  // Barrel roof: a half cylinder along the long axis.
  const alongX = w >= d;
  // Slightly shorter and narrower than the stage so its end caps and flanks
  // never share a surface with the walls (that z-fights and flickers).
  if (alongX) piece(barrelGeo, hangarRoofMat, x - w / 2 + 0.2, top - 0.05, z, d * 0.55, w - 0.4, d * 0.94).rotation.set(0, 0, -Math.PI / 2);
  else piece(barrelGeo, hangarRoofMat, x, top - 0.05, z - d / 2 + 0.2, w * 0.94, d - 0.4, w * 0.55).rotation.set(Math.PI / 2, 0, 0);
  // Big painted name and a stage number.
  textSign(name + ' STUDIOS', x, base + h * 0.72, front + 0.3, Math.min(w * 0.95, 14), Math.min(w * 0.95, 14) * 0.25, '#d94f4f', '#fff4d6', { border: '#fff4d6' });
  textSign('STAGE ' + (1 + (hashName(name) * 9) | 0), x, base + h * 0.35, front + 0.3, Math.min(w * 0.6, 7), Math.min(w * 0.6, 7) * 0.28, '#1d2230', '#ffffff');
  // Big sliding stage door.
  piece(boxGeo, darkMat, x - w * 0.2, base, front + 0.1, Math.min(w * 0.4, 6), Math.min(h * 0.4, 6), 0.1, false);
  piece(boxGeo, awningMat, x - w * 0.2, base + Math.min(h * 0.4, 6), front + 0.18, Math.min(w * 0.4, 6) + 0.3, 0.25, 0.12, false);
  // Water tower with the studio badge.
  const tx = x + w * 0.3;
  const tz = z - d * 0.25;
  for (const [sx, sz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]]) piece(cylGeo, poleMat, tx + sx, top, tz + sz, 0.1, 4.5, 0.1, false);
  piece(cylGeo, whiteMat, tx, top + 4.5, tz, 2.0, 2.2, 2.0);
  piece(coneGeo, awningMat, tx, top + 6.7, tz, 2.2, 1.0, 2.2);
  textSign(name[0] || 'M', tx, top + 5.6, tz + 1.2, 1.3, 1.3, '#d94f4f', '#ffffff', { size: 90 });
  // Lighting rigs along the roof edge.
  for (let i = -1; i <= 1; i++) {
    const lx = x + i * w * 0.3;
    piece(cylGeo, poleMat, lx, top, front - 0.6, 0.08, 2.4, 0.08, false);
    piece(boxGeo, signalMat, lx, top + 2.2, front - 0.6, 0.6, 0.5, 0.5, false);
    const lm = lampMat.clone();
    lm.userData = { dayI: 0.3, nightI: 2.6, th: 0.45 };
    piece(boxGeo, lm, lx, top + 2.25, front - 0.3, 0.5, 0.4, 0.05, false);
  }
  // Searchlights: two long beams that sweep at night.
  for (const sx of [-0.35, 0.35]) {
    const g = addGroup(x + sx * w, top, z + d * 0.1);
    part(g, cylGeo, stackMat, 0, 0, 0, 0.6, 0.8, 0.6, false);
    const head = new THREE.Group();
    head.position.y = 0.9;
    g.add(head);
    part(head, cylGeo, darkMat, 0, 0, 0, 0.5, 0.6, 0.5, false);
    const beam = part(head, beamGeo, beamMat2.clone(), 0, 0.6, 0, 1, 60, 1, false);
    landmarkAnims.push({ kind: 'searchlight', head, beam, phase: Math.random() * 6.28, speed: 0.35 + Math.random() * 0.2, tilt: 0.55 });
  }
  // A camera crane on the lot.
  const c = addGroup(x - w * 0.3, base, front - 1.2);
  part(c, boxGeo, trackMat, 0, 0, 0, 1.2, 0.3, 1.2);
  const arm = part(c, boxGeo, machineMat, 0, 0.3, 0, 0.2, 4, 0.2);
  arm.rotation.z = -0.9;
  part(c, boxGeo, darkMat, 3.1, 2.4, 0, 0.6, 0.5, 0.5);
}

// --- Factory: sawtooth roof, smokestacks with drifting smoke, pipes, gantry.
function decorateFactory(b, w, h, d) {
  const x = b.position.x;
  const z = b.position.z;
  const base = 1.1;
  const top = base + h;
  const front = z + d / 2;
  b.material.color.lerp(new THREE.Color(0x9a6a56), 0.6);
  // Sawtooth roof: wedges across the width.
  const teeth = Math.max(2, Math.floor(w / 2.2));
  const tw = w / teeth;
  for (let i = 0; i < teeth; i++) {
    const wedge = piece(pyramidGeo, factoryMat, x - w / 2 + tw * (i + 0.5), top, z, tw, 1.6, d);
    wedge.scale.set(tw * 1.0, 1.6, d * 1.0);
    piece(boxGeo, glassMat, x - w / 2 + tw * (i + 0.5) - tw * 0.2, top + 0.02, z, 0.05, 1.3, d * 0.8, false);
  }
  // Smokestacks.
  const stacks = w > 6 ? 3 : 2;
  for (let i = 0; i < stacks; i++) {
    const sx = x - w * 0.3 + (i * w * 0.6) / Math.max(1, stacks - 1);
    const sz = z - d * 0.25;
    const sh = 5 + h * 0.35 + i * 1.2;
    piece(cylGeo, stackMat, sx, top, sz, 1.1, sh, 1.1);
    piece(cylGeo, awningMat, sx, top + sh - 0.6, sz, 1.2, 0.6, 1.2, false);
    const puffs = [];
    for (let k = 0; k < 14; k++) {
      const sp = new THREE.Sprite(smokeMat.clone());
      sp.position.set(sx, top + sh, sz);
      sp.scale.set(0.1, 0.1, 1);
      blocks.add(sp);
      extras.push(sp);
      puffs.push({ sp, t: k / 14 });
    }
    landmarkAnims.push({ kind: 'smoke', puffs, x: sx, y: top + sh, z: sz, speed: 0.22 + Math.random() * 0.1 });
  }
  // Pipes along the side and a loading gantry at the front.
  piece(cylGeo, stackMat, x + w / 2 + 0.3, base, z + d * 0.2, 0.3, h * 0.9, 0.3, false);
  piece(cylGeo, stackMat, x + w / 2 + 0.3, base + h * 0.9, z, 0.3, d * 0.4, 0.3, false).rotation.x = Math.PI / 2;
  piece(boxGeo, poleMat, x, base, front + 1.0, w * 0.7, 0.2, 0.2, false);
  piece(cylGeo, poleMat, x - w * 0.3, base, front + 1.0, 0.12, 3.2, 0.12, false);
  piece(cylGeo, poleMat, x + w * 0.3, base, front + 1.0, 0.12, 3.2, 0.12, false);
  piece(boxGeo, poleMat, x, base + 3.1, front + 1.0, w * 0.65, 0.2, 0.3, false);
  piece(boxGeo, darkMat, x, base, front + 0.14, Math.min(3, w * 0.4), Math.min(2.6, h * 0.4), 0.1, false); // roller door
  textSign('SYSTEM WORKS', x, base + Math.min(2.6, h * 0.4) + 1.1, front + 0.3, Math.min(w * 0.9, 9), Math.min(w * 0.9, 9) * 0.22, '#2b3240', '#f6c90e', { size: 64 });
}

// --- Apartments: balconies on every side, washing lines, dishes, colour.
function decorateApartments(b, w, h, d) {
  const x = b.position.x;
  const z = b.position.z;
  const base = 1.1;
  const top = base + h;
  b.material.color.lerp(new THREE.Color(0xe8d9c4), 0.5);
  const floors = Math.floor(h / 2.4);
  for (let f = 1; f < floors; f++) {
    const y = base + f * 2.4;
    for (const [sx, sz, bw, bd] of [[0, 1, w * 0.8, 0.5], [0, -1, w * 0.8, 0.5], [1, 0, 0.5, d * 0.8], [-1, 0, 0.5, d * 0.8]]) {
      const col = propMat(WARM[(f + sx + sz * 2 + 10) % WARM.length]);
      piece(boxGeo, whiteMat, x + (sx * (w + 0.5)) / 2, y, z + (sz * (d + 0.5)) / 2, bw, 0.12, bd, false);
      piece(boxGeo, col, x + (sx * (w + 0.95)) / 2, y + 0.12, z + (sz * (d + 0.95)) / 2, sx ? 0.06 : bw, 0.6, sz ? 0.06 : bd, false);
    }
    if (f % 2 === 0) {
      // Washing line with a few bright clothes on the front balcony.
      for (let k = -2; k <= 2; k++) piece(boxGeo, propMat(WARM[(k + f + 7) % WARM.length]), x + k * w * 0.15, y + 0.8, z + d / 2 + 0.3, 0.3, 0.4, 0.04, false);
    }
  }
  piece(boxGeo, trimMaterial(b.material), x, top - 0.1, z, w + 0.2, 0.2, d + 0.2);
  for (let i = 0; i < 3; i++) {
    const dish = piece(discGeo, whiteMat, x + (Math.random() - 0.5) * w * 0.7, top + 0.3, z + (Math.random() - 0.5) * d * 0.7, 0.6, 0.08, 0.6, false);
    dish.rotation.x = -0.9;
  }
  piece(boxGeo, hedgeMat, x, top, z, w * 0.3, 0.4, d * 0.3, false);
  piece(boxGeo, darkMat, x, base, z + d / 2 + 0.14, Math.min(1.4, w * 0.3), 1.3, 0.1, false);
  piece(boxGeo, awningMat, x, base + 1.3, z + d / 2 + 0.3, Math.min(1.4, w * 0.3) + 0.6, 0.1, 0.6);
}

// --- Market square: stalls under striped awnings, a corkboard full of
// sticky notes, a coffee cart.
function decorateMarket(b, w, h, d) {
  const x = b.position.x;
  const z = b.position.z;
  const base = 1.1;
  const top = base + h;
  b.material.color.setHex(0xd8d2c6);
  const cols = Math.max(1, Math.floor(w / 2.4));
  const rows = Math.max(1, Math.floor(d / 2.4));
  let i = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (Math.random() < 0.2) continue;
      const sx = x - w / 2 + (c + 0.5) * (w / cols);
      const sz = z - d / 2 + (r + 0.5) * (d / rows);
      piece(boxGeo, benchMat, sx, top, sz, 1.6, 0.8, 1.0);
      for (let k = 0; k < 3; k++) piece(boxGeo, propMat(PROP_COLORS[(i + k) % PROP_COLORS.length]), sx - 0.5 + k * 0.5, top + 0.8, sz, 0.35, 0.3, 0.6, false);
      piece(cylGeo, poleMat, sx - 0.8, top, sz - 0.5, 0.05, 2.0, 0.05, false);
      piece(cylGeo, poleMat, sx + 0.8, top, sz - 0.5, 0.05, 2.0, 0.05, false);
      const aw = piece(pyramidGeo, propMat(awningStripes[i % awningStripes.length]), sx, top + 2.0, sz, 2.0, 0.5, 1.6);
      aw.scale.z = 1.6;
      i++;
    }
  }
  // Corkboard with sticky notes.
  const bw = Math.min(w * 0.8, 6);
  piece(boxGeo, benchMat, x, top, z + d / 2 - 0.3, bw, 2.6, 0.15);
  for (let k = 0; k < Math.floor(bw * 2.2); k++) piece(boxGeo, propMat([0xfff176, 0xff8a80, 0x80d8ff, 0xccff90][k % 4]), x - bw / 2 + 0.4 + (k % Math.floor(bw * 1.1)) * 0.9 * (bw / Math.max(1, bw)), top + 0.5 + (k % 3) * 0.7, z + d / 2 - 0.2, 0.55, 0.55, 0.03, false);
  textSign('DESKTOP', x, top + 3.1, z + d / 2 - 0.1, bw, bw * 0.22, '#8b5e3c', '#fff4d6', { size: 70 });
  // Coffee cart.
  const c = addGroup(x - w * 0.35, top, z - d * 0.35);
  part(c, boxGeo, whiteMat, 0, 0.3, 0, 1.4, 0.9, 0.8);
  part(c, cylGeo, trackMat, -0.5, 0, 0.45, 0.4, 0.4, 0.1, false).rotation.x = Math.PI / 2;
  part(c, cylGeo, trackMat, 0.5, 0, 0.45, 0.4, 0.4, 0.1, false).rotation.x = Math.PI / 2;
  part(c, boxGeo, awningMat, 0, 1.9, 0, 1.8, 0.1, 1.2, false);
  part(c, cylGeo, poleMat, -0.6, 1.2, 0, 0.05, 0.7, 0.05, false);
  part(c, cylGeo, poleMat, 0.6, 1.2, 0, 0.05, 0.7, 0.05, false);
  part(c, cylGeo, propMat(0xff9f1c), 0.3, 1.2, 0, 0.3, 0.35, 0.3, false); // urn
}

function stepLandmarks(dt, t) {
  for (const a of landmarkAnims) {
    if (a.kind === 'truck') {
      a.s += a.speed * dt;
      pointAt(a.loop, a.s, _pt);
      a.g.position.x = _pt.x;
      a.g.position.z = _pt.z;
      a.g.rotation.y = Math.atan2(_pt.dx, _pt.dz);
    } else if (a.kind === 'gull') {
      const ang = t * a.speed + a.phase;
      a.g.position.set(a.cx + Math.cos(ang) * a.rad, a.y + Math.sin(t * 1.7 + a.phase) * 0.4, a.cz + Math.sin(ang) * a.rad);
      a.g.rotation.y = -ang;
      const flap = Math.sin(t * 9 + a.phase) * 0.6;
      a.l.rotation.z = flap;
      a.r.rotation.z = -flap;
    } else if (a.kind === 'searchlight') {
      a.head.rotation.y = t * a.speed + a.phase;
      a.head.rotation.x = -0.9 + Math.sin(t * 0.5 + a.phase) * 0.25;
      a.beam.material.opacity = 0.3 * Math.max(0, (nightK - 0.5) / 0.5);
    } else if (a.kind === 'smoke') {
      for (const p of a.puffs) {
        p.t += dt * a.speed;
        if (p.t > 1) p.t -= 1;
        const k = p.t;
        p.sp.position.set(a.x + Math.sin(k * 6 + a.x) * 0.6 + k * 2.5, a.y + k * 9, a.z + Math.cos(k * 5) * 0.4);
        const sc = 1.2 + k * 5;
        p.sp.scale.set(sc, sc, 1);
        p.sp.material.opacity = 0.85 * (1 - k * k) * Math.min(1, k * 8);
      }
    }
  }
}


// A big neon guitar on the roof, facing the camera, for the Music folder.
function guitarSign(b, w, h, d) {
  const x = b.position.x;
  const z = b.position.z;
  const top = 1.1 + (b.userData.style ? h * STYLE_SHAFT[b.userData.style] : h);
  const S = Math.max(3.4, Math.min(w * 1.3, 7)); // sign height
  const neon = (c) => {
    const m = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.3, roughness: 0.4 });
    m.userData = { dayI: 0.3, nightI: 2.4, th: 0.55 };
    return m;
  };
  const body = neon(0xff3d7f);
  const neck = neon(0xffd23f);
  const strings = neon(0x7df9ff);
  const zf = z + d / 2 + 0.3; // just in front of the roof edge
  // Frame and backing board on two posts.
  piece(cylGeo, poleMat, x - S * 0.5, top, zf - 0.25, 0.1, S * 0.35, 0.1, false);
  piece(cylGeo, poleMat, x + S * 0.5, top, zf - 0.25, 0.1, S * 0.35, 0.1, false);
  piece(boxGeo, signalMat, x, top + S * 0.3, zf - 0.2, S * 1.25, S * 1.05, 0.12);
  const y0 = top + S * 0.38; // bottom of the guitar
  const u = S / 10; // guitar is 10 units tall in its own scale
  // Body: two overlapping rounded lobes (flattened spheres), lower one bigger.
  const lower = piece(sphereGeo, body, x, y0 + u * 2.2, zf, u * 4.2, u * 4.4, 0.25);
  const upper = piece(sphereGeo, body, x, y0 + u * 4.6, zf, u * 3.3, u * 3.4, 0.25);
  lower.castShadow = upper.castShadow = false;
  piece(discGeo, signalMat, x, y0 + u * 3.1, zf + 0.14, u * 1.3, 0.06, u * 1.3, false).rotation.x = Math.PI / 2; // sound hole
  piece(boxGeo, neck, x, y0 + u * 2.0, zf + 0.12, u * 1.4, u * 0.35, 0.08, false); // bridge
  // Neck, headstock and tuning pegs.
  piece(boxGeo, neck, x, y0 + u * 5.6, zf + 0.05, u * 0.9, u * 3.4, 0.14);
  piece(boxGeo, neck, x, y0 + u * 9.0, zf + 0.05, u * 1.3, u * 1.1, 0.14);
  for (let i = 0; i < 3; i++) {
    piece(boxGeo, strings, x - u * 0.85, y0 + u * (9.1 + i * 0.3), zf + 0.1, u * 0.35, u * 0.14, 0.06, false);
    piece(boxGeo, strings, x + u * 0.85, y0 + u * (9.1 + i * 0.3), zf + 0.1, u * 0.35, u * 0.14, 0.06, false);
  }
  // Strings and frets.
  for (let i = 0; i < 4; i++) piece(boxGeo, strings, x - u * 0.3 + i * u * 0.2, y0 + u * 2.1, zf + 0.2, 0.04, u * 7.0, 0.03, false);
  for (let i = 0; i < 6; i++) piece(boxGeo, strings, x, y0 + u * (5.9 + i * 0.5), zf + 0.14, u * 0.9, 0.05, 0.03, false);
  // Little notes beside it.
  for (const [dx, dy] of [[-0.62, 0.55], [0.6, 0.75], [0.66, 0.35]]) {
    const nm = neon(0xffffff);
    piece(sphereGeo, nm, x + dx * S, y0 + dy * S, zf, u * 0.55, u * 0.45, 0.2, false);
    piece(boxGeo, nm, x + dx * S + u * 0.25, y0 + dy * S + u * 0.55, zf, 0.06, u * 1.2, 0.05, false);
  }
  const g = glow(x, y0 + S * 0.5, zf + 0.5, S * 2.2, 0xff5fa0, 0.5, 0.55);
  blocks.add(g);
  extras.push(g);
  nightOnly.push(g);
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


// ---------------------------------------------------------------------------
// Building styles: each item gets a distinct silhouette, chosen from its name
// so it stays the same between scans. Shaft = how much of the height the
// plain box takes; the rest is tiers, crowns and spires.
// ---------------------------------------------------------------------------
const STYLE_SHAFT = { default: 1, deco: 0.62, chrysler: 0.7, stepped: 0.5, glass: 1, twin: 1, brick: 1, modern: 1, civic: 1, shop: 1 };
const STYLE_TINT = { deco: 0xeadfcb, chrysler: 0xd9cbb5, stepped: 0xc0694a, glass: 0xb7aea3, twin: 0xc9bfb3, brick: 0xa84a35, modern: 0xe6dccb, civic: 0xeadfcb, shop: 0xd4805f };
function hashName(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967295;
}
function styleFor(item, h, minSide) {
  const v = hashName(item.name || '');
  const pick = (list) => list[Math.floor(v * list.length) % list.length];
  if (h > 30 && minSide > 3) return pick(['deco', 'chrysler', 'glass', 'twin', 'stepped', 'default', 'deco']);
  if (h > 12 && minSide > 2.2) return pick(['brick', 'stepped', 'modern', 'glass', 'default', 'brick']);
  if (minSide > 3 && h <= 9) return pick(['civic', 'shop', 'default', 'shop']);
  return pick(['shop', 'default', 'modern']);
}
function applyStyleTint(mat, style) {
  const tint = STYLE_TINT[style];
  if (tint === undefined) return;
  mat.color.lerp(new THREE.Color(tint), 0.55);
  if (style === 'glass' || style === 'twin') {
    // Curtain-wall glass: shiny enough to mirror the sky and sun (see skyEnv).
    mat.metalness = 0.7;
    mat.roughness = 0.12;
  }
}
const terracottaRoof = new THREE.MeshStandardMaterial({ color: 0xb8432f, roughness: 0.85 });
const limestoneMat = new THREE.MeshStandardMaterial({ color: 0xe8dfc8, roughness: 0.85 });
const copperMat = new THREE.MeshStandardMaterial({ color: 0x5f9c8a, roughness: 0.5, metalness: 0.3 });

function decorateStyled(b, w, h, d, style) {
  const x = b.position.x;
  const z = b.position.z;
  const base = 1.1;
  const shaft = h * STYLE_SHAFT[style];
  const top = base + shaft;
  const minSide = Math.min(w, d);
  const trim = trimMaterial(b.material);
  const front = z + d / 2;
  const fm = b.material;
  // Entrance on everything tall enough.
  if (minSide > 1.4 && h > 5 && w > 2) {
    piece(boxGeo, trim, x, base, z, w + 0.16, Math.min(1.4, h * 0.1), d + 0.16);
    const doorW = Math.min(1.1, w * 0.3);
    piece(boxGeo, darkMat, x, base + 0.02, front + 0.18, doorW, 1.1, 0.12, false);
  }
  if (style === 'deco') {
    // Empire State: pilasters, three setbacks, lantern and a tall mast.
    const n = Math.max(2, Math.floor(w / 1.3));
    for (let i = 0; i < n; i++) {
      const px = x - w / 2 + 0.65 + (i * (w - 1.3)) / Math.max(1, n - 1);
      piece(boxGeo, limestoneMat, px, base, front + 0.06, 0.22, shaft, 0.1, false);
    }
    let y = top;
    let cw = w;
    let cd = d;
    for (const [f, hh] of [[0.78, 0.16], [0.58, 0.12], [0.4, 0.07]]) {
      piece(boxGeo, trim, x, y - 0.12, z, cw + 0.2, 0.25, cd + 0.2);
      cw = w * f;
      cd = d * f;
      piece(boxGeo, fm, x, y, z, cw, h * hh, cd);
      y += h * hh;
    }
    piece(cylGeo, limestoneMat, x, y, z, Math.min(1.6, minSide * 0.25), h * 0.05, Math.min(1.6, minSide * 0.25));
    y += h * 0.05;
    piece(cylGeo, spireMat, x, y, z, 0.3, h * 0.12, 0.3, false);
    piece(cylGeo, spireMat, x, y + h * 0.12, z, 0.1, h * 0.08, 0.1, false);
  } else if (style === 'chrysler') {
    // Tapering crown of stacked arcs and a needle.
    piece(boxGeo, trim, x, top - 0.12, z, w + 0.2, 0.25, d + 0.2);
    let y = top;
    let r = minSide * 0.95;
    for (let i = 0; i < 6; i++) {
      piece(cylGeo, spireMat, x, y, z, r, h * 0.045, r);
      piece(cylGeo, copperMat, x, y + h * 0.045, z, r * 0.92, h * 0.012, r * 0.92, false);
      y += h * 0.057;
      r *= 0.78;
    }
    piece(coneGeo, spireMat, x, y, z, r, h * 0.08, r);
    piece(cylGeo, spireMat, x, y + h * 0.08, z, 0.08, h * 0.06, 0.08, false);
    // Winged ornaments at the corners.
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) piece(boxGeo, spireMat, x + (sx * w) / 2, top - 0.5, z + (sz * d) / 2, 0.5, 1.3, 0.5, false);
  } else if (style === 'stepped') {
    // Ziggurat of terracotta tiers.
    let y = top;
    let f = 0.8;
    for (let i = 0; i < 3; i++) {
      piece(boxGeo, trim, x, y - 0.1, z, w * (f + 0.22) + 0.1, 0.22, d * (f + 0.22) + 0.1);
      piece(boxGeo, fm, x, y, z, w * f, h * 0.16, d * f);
      y += h * 0.16;
      f -= 0.2;
    }
    piece(boxGeo, trim, x, y - 0.1, z, w * 0.42, 0.22, d * 0.42);
    piece(boxGeo, limestoneMat, x, y, z, w * 0.18, 1.2, d * 0.18, false);
    piece(cylGeo, spireMat, x, y + 1.2, z, 0.08, 2.5, 0.08, false);
  } else if (style === 'glass') {
    // Dark-glass slab with a pale service core and a helipad.
    piece(boxGeo, limestoneMat, x - w * 0.28, base, z - d * 0.28, w * 0.36, h * 1.06, d * 0.36);
    piece(boxGeo, trim, x, top - 0.1, z, w + 0.12, 0.14, d + 0.12);
    piece(discGeo, darkMat, x + w * 0.12, top, z + d * 0.12, Math.min(w, d) * 0.5, 0.12, Math.min(w, d) * 0.5, false);
    piece(discGeo, whiteMat, x + w * 0.12, top + 0.12, z + d * 0.12, Math.min(w, d) * 0.3, 0.04, Math.min(w, d) * 0.3, false);
    for (let yy = base + 3; yy < top - 1; yy += 3.2) piece(boxGeo, spireMat, x, yy, front + 0.04, w, 0.08, 0.06, false);
  } else if (style === 'twin') {
    // Two slender shafts joined by a sky bridge.
    b.scale.x = w * 0.44;
    b.position.x = x - w * 0.28;
    piece(boxGeo, fm, x + w * 0.28, base, z, w * 0.44, h * 0.9, d);
    piece(boxGeo, trim, x, base + h * 0.55, z, w * 0.2, 1.4, d * 0.5);
    piece(boxGeo, trim, x - w * 0.28, top - 0.1, z, w * 0.44 + 0.2, 0.22, d + 0.2);
    piece(boxGeo, trim, x + w * 0.28, base + h * 0.9 - 0.1, z, w * 0.44 + 0.2, 0.22, d + 0.2);
    piece(cylGeo, spireMat, x - w * 0.28, top, z, 0.1, 3, 0.1, false);
  } else if (style === 'brick') {
    // Brick walk-up: cornice, fire escape, water tower, chimney.
    piece(boxGeo, trim, x, top - 0.25, z, w + 0.3, 0.3, d + 0.3);
    piece(boxGeo, limestoneMat, x, top - 0.55, z, w + 0.1, 0.12, d + 0.1, false);
    if (w > 2.4) {
      const fx = x + w * 0.22;
      for (let yy = base + 2.6; yy < top - 1.5; yy += 2.6) {
        piece(boxGeo, darkMat, fx, yy, front + 0.35, 1.3, 0.06, 0.6, false);
        piece(boxGeo, darkMat, fx, yy + 0.06, front + 0.62, 1.3, 0.7, 0.04, false);
        piece(boxGeo, darkMat, fx - 0.5, yy + 0.06, front + 0.35, 0.05, 2.4, 0.05, false);
      }
    }
    const tx = x - w * 0.25;
    const tz = z - d * 0.2;
    piece(cylGeo, darkMat, tx, top, tz, 0.5, 0.6, 0.5, false);
    piece(cylGeo, tankMat, tx, top + 0.6, tz, 0.9, 1.1, 0.9);
    piece(coneGeo, trim, tx, top + 1.7, tz, 0.95, 0.35, 0.95);
    piece(boxGeo, trim, x + w * 0.3, top, z + d * 0.3, 0.45, 0.9, 0.45, false);
  } else if (style === 'modern') {
    // White slab with balcony bands and a rooftop garden.
    for (let yy = base + 2.4; yy < top - 0.5; yy += 2.4) piece(boxGeo, whiteMat, x, yy, front + 0.18, w * 0.92, 0.12, 0.4, false);
    piece(boxGeo, trim, x, top - 0.1, z, w + 0.16, 0.18, d + 0.16);
    piece(boxGeo, hedgeMat, x - w * 0.2, top, z, w * 0.4, 0.5, d * 0.6, false);
    piece(boxGeo, glassMat, x + w * 0.25, top, z, w * 0.3, 1.0, d * 0.4, false);
  } else if (style === 'civic') {
    // Civic hall: colonnade, pediment and a copper dome.
    const n = Math.max(3, Math.floor(w / 1.1));
    for (let i = 0; i < n; i++) {
      const cx = x - w / 2 + 0.55 + (i * (w - 1.1)) / Math.max(1, n - 1);
      piece(cylGeo, limestoneMat, cx, base, front + 0.5, 0.3, shaft, 0.3);
    }
    piece(boxGeo, limestoneMat, x, top, z + d * 0.25, w + 0.4, 0.5, d * 0.5 + 1.2);
    const ped = piece(pyramidGeo, limestoneMat, x, top + 0.5, front + 0.1, w + 0.2, 1.1, 1.4);
    ped.scale.z = 1.4;
    const r = Math.min(w, d) * 0.4;
    piece(cylGeo, limestoneMat, x, top, z - d * 0.1, r * 1.1, 1.0, r * 1.1);
    const dome = piece(sphereGeo, copperMat, x, top + 1.0 - r * 0.2, z - d * 0.1, r * 2, r * 2.2, r * 2);
    dome.castShadow = true;
    piece(cylGeo, spireMat, x, top + 1.0 + r * 0.9, z - d * 0.1, 0.1, 1.2, 0.1, false);
  } else if (style === 'shop') {
    // Shopfront with a hipped terracotta roof and a chimney.
    piece(boxGeo, trim, x, top - 0.12, z, w + 0.2, 0.15, d + 0.2);
    const roof = piece(pyramidGeo, terracottaRoof, x, top, z, w * 1.15, Math.min(2.4, minSide * 0.6), d * 1.15);
    roof.castShadow = true;
    piece(boxGeo, brickMat, x + w * 0.3, top, z - d * 0.2, 0.4, Math.min(2.4, minSide * 0.6) + 0.5, 0.4, false);
    if (w > 2) piece(boxGeo, awningMat, x, base + 1.15, front + 0.25, Math.min(w * 0.8, 3), 0.1, 0.6);
  }
}

// Shared facade detail on top of each style: shopfronts with awnings at
// street level, corner quoins and floor ledges on masonry, fins on glass,
// balconies on concrete. Front (+z) and right (+x) faces are the ones the
// camera sees, so the detail goes there.
const shopGlassMat = new THREE.MeshStandardMaterial({ color: 0x3b3633, roughness: 0.1, metalness: 0.7 });
const frameMat = new THREE.MeshStandardMaterial({ color: 0x2d3038, roughness: 0.6, metalness: 0.3 });
const railMat = new THREE.MeshStandardMaterial({ color: 0xbfe3f0, roughness: 0.1, metalness: 0.5, transparent: true, opacity: 0.55 });
const awningMats = awningStripesMats();
function awningStripesMats() {
  return [0xb9583c, 0x7a4a3a, 0xeadfcb, 0x9a3f2e, 0x5f5a54].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 }));
}
function facadeDetail(b, w, d, style) {
  const x = b.position.x;
  const z = b.position.z;
  const base = 1.1;
  const shaft = b.userData.targetH;
  const minSide = Math.min(w, d);
  if (minSide < 1.6 || shaft < 4) return;
  const trim = trimMaterial(b.material);
  const fk = STYLE_FACADE[style] || 'office';
  const faces = [
    { nx: 0, nz: 1, len: w, at: z + d / 2, along: (t) => [x + t, null] }, // front
    { nx: 1, nz: 0, len: d, at: x + w / 2, along: (t) => [null, z + t] }, // right
  ];
  const put = (f, geo, mat, t, y, out, sAlong, sy, sOut, shadow = false) => {
    if (f.nz) piece(geo, mat, x + t, y, f.at + out, sAlong, sy, sOut, shadow);
    else piece(geo, mat, f.at + out, y, z + t, sOut, sy, sAlong, shadow);
  };
  // Street level: shop windows, mullions and a striped awning per bay.
  const shopH = Math.min(1.5, shaft * 0.14);
  for (const f of faces) {
    const bays = Math.max(1, Math.floor(f.len / 1.8));
    const bw = f.len / bays;
    for (let i = 0; i < bays; i++) {
      const t = -f.len / 2 + bw * (i + 0.5);
      if (f.nz && bays > 1 && i === Math.floor(bays / 2)) continue; // the entrance bay
      put(f, boxGeo, shopGlassMat, t, base + 0.15, 0.07, bw * 0.78, shopH * 0.8, 0.06);
      put(f, boxGeo, frameMat, t, base + 0.15 + shopH * 0.8, 0.09, bw * 0.84, 0.08, 0.08);
      if (Math.random() < 0.7) put(f, boxGeo, awningMats[Math.floor(Math.random() * awningMats.length)], t, base + shopH * 0.95, 0.32, bw * 0.8, 0.07, 0.55, true);
    }
  }
  if (fk === 'brick' || fk === 'stone' || fk === 'office') {
    // Corner quoins / pilasters, full height.
    for (const [cx, cz] of [[1, 1], [1, -1], [-1, 1]]) piece(boxGeo, trim, x + cx * (w / 2 + 0.02), base, z + cz * (d / 2 + 0.02), 0.32, shaft, 0.32);
    // Floor ledges every few storeys.
    const step = fk === 'office' ? 7.8 : 5.2;
    for (let y = base + shopH + 0.2; y < base + shaft - 1.5; y += step) {
      for (const f of faces) put(f, boxGeo, trim, 0, y, 0.05, f.len + 0.12, 0.16, 0.14);
    }
  } else if (fk === 'glass') {
    // Vertical aluminium fins catch the sun.
    for (const f of faces) {
      const n = Math.max(2, Math.floor(f.len / 1.25));
      for (let i = 1; i < n; i++) put(f, boxGeo, spireMat, -f.len / 2 + (i * f.len) / n, base + shopH, 0.08, 0.07, shaft - shopH, 0.16);
    }
  } else if (fk === 'concrete') {
    // Balconies with glass rails on some floors.
    const f = faces[0];
    const cols = Math.max(1, Math.floor(f.len / 2.2));
    for (let y = base + shopH + 2.6; y < base + shaft - 1.5; y += 2.6) {
      for (let i = 0; i < cols; i++) {
        if (Math.random() < 0.35) continue;
        const t = -f.len / 2 + (f.len / cols) * (i + 0.5);
        put(f, boxGeo, whiteMat, t, y, 0.35, 1.3, 0.1, 0.7, true);
        put(f, boxGeo, railMat, t, y + 0.1, 0.68, 1.3, 0.45, 0.04);
      }
    }
  }
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
// Warm palette from the reference city, for building trim and balconies.
const WARM = [0xb9583c, 0xeadfcb, 0xd8b28a, 0xa84a35, 0xd4805f, 0x8f6f5e];
const PROP_COLORS = [0xff6b6b, 0xffd166, 0x4cc9f0, 0x4361ee, 0x90be6d, 0xff9f1c];
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
  } else if (theme < 0.76) {
    // Market stall (kept rare).
    piece(boxGeo, benchMat, x, y, z, 1.6, 0.7, 0.9, false);
    for (const [dx, dz] of [[-0.75, -0.4], [0.75, -0.4], [-0.75, 0.4], [0.75, 0.4]]) piece(cylGeo, poleMat, x + dx, y, z + dz, 0.05, 1.7, 0.05, false);
    piece(boxGeo, propMat(alt ? 0x4cc9f0 : 0x90be6d), x, y + 1.7, z, 1.9, 0.08, 1.2);
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
  lower.userData.tree = 'lower';
  upper.userData.tree = 'upper';
  pines.userData.tree = 'pine';
  for (const im of [trunks, lower, upper, pines]) {
    im.castShadow = true;
    im.receiveShadow = true;
    blocks.add(im);
    extras.push(im);
  }
  if (seasons) seasons.refresh();
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
  stepLandmarks(dt, t);
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

function setScanProgress(p, fraction = null) {
  if (!site) return;
  if (p.done) siteBuilding(p.done);
  let f = fraction;
  if (f === null) {
    // Unknown total, so ease towards 1 as files and bytes pile up.
    const byFiles = 1 - Math.exp(-(p.files || 0) / 220000);
    const byBytes = 1 - Math.exp(-(p.bytes || 0) / 250e9);
    f = Math.min(0.97, Math.max(byFiles, byBytes));
  }
  site.progress = Math.max(site.progress, f);
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
    sprite.userData.labelItem = item;
    pickExtras.push(sprite);
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
  const it = hovered && !hovered.userData.district ? hovered.userData.item : null;
  if (it && it.category) openCategory(state.open === it.category ? null : it.category); // click again to deselect
  else if (it && it.virtual) toast(`${it.name}: ${fmt(it.size)}`);
  else if (state.open) openCategory(null);
});

function updateHover() {
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects([...meshes, ...pickExtras], true);
  let hit = null;
  for (const h of hits) {
    let o = h.object;
    if (o.isSprite && !o.material.opacity) continue; // the hidden day/night twin of a label
    while (o && !o.userData.owner && !o.userData.labelItem && !meshes.includes(o)) o = o.parent;
    if (!o) continue;
    if (o.userData.owner) hit = o.userData.owner;
    else if (o.userData.labelItem) hit = meshes.find((m) => !m.userData.district && m.userData.item === o.userData.labelItem) || null;
    else hit = o;
    if (hit) break;
  }
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
      tooltip.innerHTML = `<b>${esc(it.name)}</b>${fmt(it.size)} · ${KIND_LABELS[it.kind] || it.kind}${it.files ? ` · ${it.files.toLocaleString()} files` : ''}${it.category === SYS_OTHER ? ' · click to see what this is' : it.category ? ' · click to see files' : ''}<div class="path">${esc(it.path || '')}</div>`;
      tooltip.hidden = false;
      renderer.domElement.style.cursor = it.category ? 'pointer' : 'default';
    } else {
      tooltip.hidden = true;
      renderer.domElement.style.cursor = 'default';
    }
  }
}

const menu = document.getElementById('menu');
function closeMenu() {
  menu.hidden = true;
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.open && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) openCategory(null);
});

async function demolish(item) {
  const cat = state.city.find((c) => c.children.includes(item));
  const mesh = cat && meshes.find((m) => m.userData.item === cat);
  const res = await api.trash([item.path]);
  if (pro.handleBlocked(res)) return;
  if (!res.every((r) => r.ok)) {
    const bad = res.find((r) => !r.ok) || {};
    if (bad.error === 'protected') {
      if (bad.contents) return clearContents(item);
      toast(`${bad.name || item.name} is a macOS system folder and has to stay. Open it to pick files inside.`);
      return;
    }
    trashError(bad);
    return;
  }
  // The category building shrinks, then the tree updates locally (no rescan needed).
  if (mesh && cat.size > 0) {
    mesh.userData.build = null;
    mesh.userData.targetH *= Math.max(0.05, 1 - item.size / cat.size);
  }
  await new Promise((r) => setTimeout(r, 450));
  toast(`Demolished ${item.name} (${fmt(item.size)}). Empty the Trash to reclaim the space.`);
  await applyRemoved(removedFrom(item, res, 'trash'));
}

// --- Tree upkeep: apply a delete to the scan in place, no rescan ------------
// Same rules as forget / clearDir / addToBin in src/main/scanner.js.
const isUnder = (p, dir) => p.startsWith(dir + '/') || p.startsWith(dir + '\\');
function chainTo(p) {
  const tree = state.tree;
  if (!tree || !p || !(tree.path === p || isUnder(p, tree.path))) return null;
  const chain = [tree];
  for (let n = tree; n.path !== p; ) {
    n = (n.children || []).find((c) => !c.aggregate && (c.path === p || (c.isDir && isUnder(p, c.path))));
    if (!n) break;
    chain.push(n);
  }
  return chain;
}
function shrink(chain, node) {
  for (const a of chain) {
    a.size = Math.max(0, a.size - node.size);
    a.files = Math.max(0, (a.files || 0) - (node.files || 0));
    if (a.types && node.types) for (const [k, v] of Object.entries(node.types)) if (a.types[k]) a.types[k] = Math.max(0, a.types[k] - v);
  }
}
// Takes the item at `p` out of the tree; returns the bytes it held.
function forgetPath(p) {
  const chain = chainTo(p);
  if (!chain || chain.length < 2 || chain[chain.length - 1].path !== p) return 0;
  const node = chain.pop();
  const parent = chain[chain.length - 1];
  parent.children.splice(parent.children.indexOf(node), 1);
  shrink(chain, node);
  return node.size;
}
// Empties a folder in the tree, keeping the folder; returns the bytes it held.
function clearPath(dir) {
  const chain = chainTo(dir);
  if (!chain || chain[chain.length - 1].path !== dir) return 0;
  const last = chain[chain.length - 1];
  const node = { ...last, types: { ...(last.types || {}) } };
  shrink(chain, node);
  last.children = [];
  return node.size;
}
// Things moved to the Trash still take space there until it's emptied, so the
// Trash building (and Safe Clean's Trash line) grows by what was moved.
function addToBin(bytes) {
  if (!(bytes > 0) || !state.tree) return;
  const bins = [];
  const walk = (n) => {
    if (n.isDir && isBin(n.path)) bins.push(n);
    else (n.children || []).forEach(walk);
  };
  walk(state.tree);
  const bin = bins.sort((a, b) => a.path.length - b.path.length)[0];
  if (bin) {
    for (const a of chainTo(bin.path)) {
      a.size += bytes;
      if (a.types) a.types.other = (a.types.other || 0) + bytes;
    }
    bin.children = bin.children || [];
    let lot = bin.children.find((c) => c.aggregate && c.moved);
    if (!lot) bin.children.push((lot = { name: 'Moved here by Gigapolis', path: bin.path, size: 0, isDir: false, kind: 'trash', mtime: Date.now(), files: 0, aggregate: true, moved: true, types: {} }));
    lot.size += bytes;
    lot.types.other = (lot.types.other || 0) + bytes;
    bin.children.sort((a, b) => b.size - a.size);
  }
  const g = state.suggestions && state.suggestions.trash;
  if (!g) return;
  const it = bin ? g.items.find((i) => i.path === bin.path) : g.items.find((i) => isBin(i.path) && !/^[A-Za-z]:\\/.test(i.path));
  if (it) it.size += bytes;
  else if (bin) g.items.push({ name: bin.name, path: bin.path, size: bytes, kind: 'trash', mtime: Date.now(), isDir: true });
  g.total = g.items.reduce((n, i) => n + i.size, 0);
}
// Drops gone paths from Street Sweep and Deep Clean lists. `cleared` folders
// stay on disk but are now empty, so they leave the lists too.
function pruneLists(gone) {
  if (!gone.length) return;
  const hit = (p) => gone.some((g) => p === g || isUnder(p, g));
  for (const g of [...Object.values(state.suggestions || {}), ...Object.values(state.deep || {})]) {
    if (!g || !g.items) continue;
    const before = g.items.length;
    g.items = g.items.filter((i) => !hit(i.path));
    if (g.items.length !== before) g.total = g.items.reduce((s, i) => s + i.size, 0);
  }
}
// Applies finished deletes. Each entry: { path, mode } where mode is 'trash'
// (moved to the Trash), 'gone' (deleted for good, from inside the Trash),
// 'clear' (folder emptied into the Trash, kept) or 'bin' (Trash emptied).
async function applyRemoved(done) {
  if (!state.tree || !done.length) return;
  let forGood = 0;
  // In order: a Safe Clean moves caches into the Trash, then empties it.
  for (const d of done) {
    const bytes = d.mode === 'trash' || d.mode === 'gone' ? forgetPath(d.path) : clearPath(d.path);
    pruneLists([d.path]);
    if (d.mode === 'trash' || d.mode === 'clear') addToBin(bytes);
    else forGood += bytes;
  }
  if (DEMO) {
    if (forGood && state.disk && state.disk.roots[0]) state.disk.roots[0].free += forGood;
  } else {
    state.disk = await api.diskInfo().catch(() => state.disk);
  }
  renderDisk();
  renderClean();
  layout();
}
// Turns one delete's results into what applyRemoved needs.
function removedFrom(item, res, mode) {
  const ok = res.filter((r) => r.ok);
  if (!ok.length) return [];
  if (mode === 'trash') return ok.map((r) => ({ path: r.path, mode: 'trash' }));
  const bin = isBin(item.path);
  // Whole folder emptied: clear it. Partly: drop just the items that went.
  if (ok.length === res.length) return [{ path: item.path, mode: bin ? 'bin' : 'clear' }];
  return ok.map((r) => ({ path: r.path, mode: bin ? 'gone' : 'trash' }));
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
  stepFocus(dt);
  if (seasons) seasons.step(dt, t);
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
// The Trash / Recycle Bin itself: emptying it is permanent (the one delete that is).
const isBin = (p) => /[\\/](\.Trash|\$Recycle\.Bin)([\\/]S-1-[\d-]+)?[\\/]?$/i.test(p || '');
// Empties a protected folder (e.g. ~/Pictures) into the Trash, keeping the folder.
async function clearContents(item) {
  const res = await api.emptyFolder(item.path);
  if (pro.handleBlocked(res)) return;
  const bad = res.filter((r) => !r.ok);
  if (bad.length && bad.length === res.length) return trashError(bad[0]);
  if (isBin(item.path)) toast(`Emptied the Trash${bad.length ? ` · ${bad.length} item${bad.length > 1 ? 's' : ''} couldn't be removed` : ''}. ${fmt(item.size)} freed.`);
  else toast(`Moved the contents of ${item.name} to Trash${bad.length ? ` · ${bad.length} couldn't be moved` : ''}. Empty the Trash to reclaim the space.`);
  await applyRemoved(removedFrom(item, res, 'empty'));
}
function trashError(r) {
  if (r.error === 'drive') return toast(r.message);
  if (r.error === 'protected') return toast(`${r.name || 'That folder'} is a macOS system folder and has to stay.`);
  toast('Could not move to Trash: ' + (r.error || 'unknown error'));
  if (r.perm && api.openPermissions) setTimeout(() => api.openPermissions(), 1200);
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), msg.length > 90 ? 7000 : 3500);
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
  el.textContent = state.tree ? state.tree.name : '';
}

// Files tab: the list of categories, or the files in the one you clicked.
// Folders open in place (no walking inside buildings).
const hexColor = (k) => '#' + (KIND_COLORS[k] || KIND_COLORS.other).toString(16).padStart(6, '0');
function openCategory(id) {
  state.open = id;
  setFocus(id ? meshes.find((m) => !m.userData.district && m.userData.item.category === id) : null);
  renderFiles();
  if (!id) return;
  setPanel(true);
  showTab('files');
}
// "System & other users": disk space outside the scanned folder. Gigapolis
// can't see inside it, so the Files tab explains it and points at what is safe.
const SYS_PARTS = IS_WIN
  ? [
      ['🪟', 'Windows itself', 'The operating system. Can’t be removed.'],
      ['📦', 'Program Files', 'Installed apps. Remove them in App Uninstaller.'],
      ['💤', 'Page file and hibernation file', 'Windows manages these. Size depends on your memory.'],
      ['⏪', 'System Restore points', 'Windows Disk Cleanup can remove older ones.'],
      ['👥', 'Other users on this PC', 'Their files are private to them.'],
    ]
  : [
      ['🍎', 'macOS itself', 'The operating system. Sealed and read-only.'],
      ['📦', 'Apps in Applications', 'Remove them in App Uninstaller.'],
      ['🕰', 'Time Machine local snapshots', 'Often the biggest part of “System Data”. Safe to clear.'],
      ['💤', 'Swap and sleep files', 'macOS manages these. They shrink after a restart.'],
      ['👥', 'Other users on this Mac', 'Their files are private to them.'],
    ];
function renderSysOther(wrap) {
  const total = state.disk && state.disk.roots[0] ? Math.max(0, state.disk.roots[0].total - state.disk.roots[0].free - (state.tree ? state.tree.size : 0)) : 0;
  $('files-head').innerHTML = `<button class="link" id="files-back">‹ All</button><span class="cat-title"><span class="dot" style="background:${hexColor('system')}"></span>System &amp; other users</span><span class="muted">${fmt(total)}</span>`;
  $('files-back').onclick = () => openCategory(null);
  wrap.innerHTML = `<p class="hint" style="margin:0 2px 8px">Space used on your disk outside your home folder. It isn’t files you made, and deleting things here by hand can break your ${IS_WIN ? 'PC' : 'Mac'}, so there is nothing to Demolish. What it usually holds:</p>
    <ul class="file-list sys-parts">${SYS_PARTS.map(([i, n, d]) => `<li class="row"><span class="icon">${i}</span><span class="name">${esc(n)}<small>${esc(d)}</small></span></li>`).join('')}</ul>
    <div class="row-actions" style="padding-left:0">
      <button data-act="snap">${IS_WIN ? '🧽 Open Disk Cleanup' : '🕰 Clear Time Machine snapshots'}</button>
      <button data-act="safe">🧹 Safe Clean caches</button>
      <button data-act="apps">📦 App Uninstaller</button>
    </div>`;
  wrap.querySelector('[data-act="snap"]').onclick = () => maint && maint.open && maint.open([IS_WIN ? 'cleanup' : 'snapshots']);
  wrap.querySelector('[data-act="safe"]').onclick = () => showTab('safe');
  wrap.querySelector('[data-act="apps"]').onclick = () => (cityHall && cityHall.open ? cityHall.open() : showTab('hall'));
}

function renderFiles() {
  const wrap = $('files');
  if (!wrap) return;
  wrap.innerHTML = '';
  if (state.open === SYS_OTHER) return renderSysOther(wrap);
  const cat = state.open && state.city.find((c) => c.category === state.open);
  if (!cat) {
    state.open = null;
    $('files-head').innerHTML = `<span>Your city</span><span class="muted">${state.city.length} buildings</span>`;
    const ul = document.createElement('ul');
    ul.className = 'file-list';
    for (const c of state.city) {
      const li = document.createElement('li');
      li.className = 'cat-row';
      li.innerHTML = `<span class="dot" style="background:${hexColor(c.kind)}"></span><span class="name">${esc(c.name)}</span><span class="size">${fmt(c.size)}</span>`;
      li.onclick = () => openCategory(c.category);
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
    return;
  }
  $('files-head').innerHTML = `<button class="link" id="files-back">‹ All</button><span class="cat-title"><span class="dot" style="background:${hexColor(cat.kind)}"></span>${esc(cat.name)}</span><span class="muted">${fmt(cat.size)}</span>`;
  $('files-back').onclick = () => openCategory(null);
  wrap.appendChild(fileList(cat.children, true));
}
function fileList(items, top) {
  const ul = document.createElement('ul');
  ul.className = 'file-list';
  for (const it of items.slice(0, 200)) {
    const li = document.createElement('li');
    const canOpen = it.isDir && (it.children || []).length > 0;
    const guard = it.path && protectionOf(it.path);
    // Already in the Trash: "demolishing" it again would free nothing.
    const inBin = !!it.path && /[\\/](\.Trash|\$Recycle\.Bin)[\\/]/i.test(it.path);
    const canDemolish = it.path && !it.aggregate && !it.virtual && !guard && !inBin;
    const sub = top && it.rel && it.rel !== it.name ? `<small>${esc(it.rel.slice(0, -it.name.length - 1))}</small>` : '';
    li.innerHTML = `<div class="row"><span class="chev">${canOpen ? '›' : ''}</span><span class="icon">${it.isDir ? '📁' : it.aggregate ? '🗂' : '📄'}</span><span class="name" title="${esc(it.path || '')}">${esc(it.name)}${sub}</span><span class="size">${fmt(it.size)}</span></div>`;
    const row = li.firstChild;
    // Clicking a row picks it and shows its actions underneath (folders also open).
    const actions = document.createElement('div');
    actions.className = 'row-actions';
    const showActions = () => {
      actions.innerHTML =
        (it.path && !it.virtual ? `<button data-act="reveal">📍 Show in Finder</button>` : '') +
        (canDemolish
          ? `<button data-act="demolish" class="demolish">🧨 Demolish</button>`
          : guard && guard.contents
            ? `<button data-act="clear" class="demolish">${isBin(it.path) ? '🗑 Empty Trash' : '🧹 Clear contents'}</button>`
            : `<span class="muted">${guard ? 'A macOS system folder, it has to stay. Open it to pick files.' : inBin ? 'Already in the Trash. Empty the Trash to free the space.' : it.aggregate ? 'Lots of small files: open the folder in Finder to pick.' : ''}</span>`);
    };
    actions.onclick = async (e) => {
      const act = e.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'reveal') api.reveal(it.path);
      else if (act.dataset.act === 'demolish') {
        const cloud = drives.cloudOf(it.path);
        actions.innerHTML = (cloud ? `<span class="muted">⚠️ This is in ${esc(cloud.label)}: it will be deleted online and on every synced device.</span>` : '') + `<button data-act="confirm" class="demolish">Yes, demolish ${fmt(it.size)}${cloud ? ' everywhere' : ''}</button><button data-act="keep">Keep it</button>`;
      }
      else if (act.dataset.act === 'clear') actions.innerHTML = `<button data-act="confirm-clear" class="demolish">${isBin(it.path) ? `Yes, empty the Trash for good (${fmt(it.size)})` : `Yes, move everything inside ${esc(it.name)} to Trash (${fmt(it.size)})`}</button><button data-act="keep">Keep it</button>`;
      else if (act.dataset.act === 'confirm-clear') await clearContents(it);
      else if (act.dataset.act === 'keep') showActions();
      else if (act.dataset.act === 'confirm') await demolish(it);
    };
    row.onclick = () => {
      const picked = !li.classList.contains('picked');
      for (const o of document.querySelectorAll('#files li.picked')) {
        if (o === li) continue;
        o.classList.remove('picked');
        const bar = o.querySelector(':scope > .row-actions');
        if (bar) bar.remove();
      }
      li.classList.toggle('picked', picked);
      if (picked) {
        showActions();
        row.after(actions);
      } else actions.remove();
      if (!canOpen) return;
      li.classList.toggle('open', picked);
      if (picked && !li.querySelector('ul')) li.appendChild(fileList(it.children, false));
    };
    ul.appendChild(li);
  }
  if (items.length > 200) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = `…and ${items.length - 200} more`;
    ul.appendChild(li);
  }
  return ul;
}

// Safe Clean tab: one button, only things that are always safe to clear.
const SAFE_GROUPS = [
  ['caches', '🧹 Caches & temp files', 'Apps rebuild them when needed.'],
  ['trash', '🗑 Trash / Recycle Bin', 'Things you already deleted. Emptied for good.'],
];
const GROUPS = [
  ['oldDownloads', 'Old downloads & installers', 'Untouched for 60+ days.', 'trash'],
  ['largeStale', 'Large files not opened in 6 months', 'Over 500 MB. Check before removing.', 'trash'],
];

// One cleanup group (a <details> with a checkbox per item). Pro's Deep Clean
// groups use it too; an item may carry its own mode (e.g. 'empty').
function buildGroup(g, title, desc, mode, open) {
  const det = document.createElement('details');
  det.className = 'group';
  det.open = open;
  det.innerHTML = `<summary><span>${title}</span><span class="size">${fmt(g.total)}</span></summary><div class="hint">${desc}</div><ul></ul><span class="all">Select all</span>`;
  const ul = det.querySelector('ul');
  for (const it of g.items) {
    const li = document.createElement('li');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.onchange = () => {
      if (cb.checked) state.selected.set(it.path, { ...it, mode: mode === 'dup' ? 'dup' : it.mode || mode });
      else state.selected.delete(it.path);
      updateTrashButton();
    };
    li.appendChild(cb);
    li.insertAdjacentHTML('beforeend', `<span class="name" title="${esc(it.note ? it.path + '\n' + it.note : it.path)}">${esc(it.name)}</span><span class="size">${fmt(it.size)}</span><span class="reveal" title="Show in Finder / Explorer">⌕</span>`);
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
  return det;
}

function renderSafe() {
  const list = $('safe-list');
  const btn = $('btn-safe');
  if (!list) return;
  const groups = state.suggestions ? SAFE_GROUPS.map(([k, t, d]) => [state.suggestions[k], t, d]).filter(([g]) => g && g.items.length) : [];
  const total = groups.reduce((n, [g]) => n + g.total, 0);
  $('safe-total').textContent = state.suggestions ? fmt(total) : '—';
  $('safe-sub').textContent = !state.suggestions ? 'Scan your files to see what can go.' : total ? 'can be cleared safely right now' : 'Nothing to clear. Your city is spotless.';
  list.innerHTML = groups.map(([g, t, d]) => `<li><span class="name"><b>${t}</b><small>${d}</small></span><span class="size">${fmt(g.total)}</span></li>`).join('');
  btn.disabled = !total;
  btn.textContent = total ? `Safe clean · free ${fmt(total)}` : 'Safe clean';
}
$('btn-safe').onclick = async () => {
  if (!state.suggestions) return;
  const items = SAFE_GROUPS.flatMap(([k]) => (state.suggestions[k] ? state.suggestions[k].items : [])).map((it) => ({ ...it, mode: 'empty' }));
  if (!items.length) return;
  $('btn-safe').disabled = true;
  $('btn-safe').textContent = 'Cleaning…';
  await moveToTrash(items);
};

function renderClean() {
  renderSafe();
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
    wrap.appendChild(buildGroup(g, title, desc, mode, keyName === 'caches'));
  }
  $('clean-total').textContent = grand ? `· up to ${fmt(grand)}` : '';
  if (pro) pro.renderDeep(wrap);
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
  await moveToTrash(items);
};
async function moveToTrash(items) {
  let freed = 0; // moved to the Trash
  let emptied = 0; // removed from the Trash for good
  let failed = 0;
  let capped = null;
  const done = [];
  for (const it of items) {
    const res = it.mode === 'dup' ? await api.trashDuplicate(it.path, it.keep) : it.mode === 'empty' ? await api.emptyFolder(it.path) : await api.trash([it.path]);
    const cap = res.find((r) => r.error === 'cap');
    if (cap) {
      capped = capped || cap; // over the free allowance: skip it, smaller items may still fit
      continue;
    }
    done.push(...removedFrom(it, res, it.mode === 'empty' ? 'empty' : 'trash'));
    if (!res.every((r) => r.ok)) failed += 1;
    else if (isBin(it.path)) emptied += it.size;
    else freed += it.size;
  }
  if (capped) pro.showUpgrade('cap', capped);
  if (!freed && !emptied && !failed) {
    updateTrashButton();
    renderSafe();
    return;
  }
  const parts = [];
  if (freed) parts.push(`Moved ${fmt(freed)} to Trash`);
  if (emptied) parts.push(`emptied ${fmt(emptied)} from the Trash`);
  if (!parts.length) parts.push('Nothing moved');
  toast(`${parts.join(' and ')}${failed ? ` · ${failed} failed` : ''}${capped ? ' · free limit reached' : ''}.${freed ? ' Empty the Trash to reclaim the space.' : ''}`);
  await applyRemoved(done);
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
  // Expected total: when scanning the home folder, the space used on the disk
  // is a good yardstick (system files make it land a little under 100%). For a
  // chosen folder there is no yardstick, so the bar eases instead.
  state.disk = await api.diskInfo();
  renderDisk();
  const usedOnDisk = !root && state.disk && state.disk.roots[0] && state.disk.roots[0].total ? state.disk.roots[0].total - state.disk.roots[0].free : 0;
  $('progress-bar').classList.toggle('indeterminate', !usedOnDisk);
  $('progress-bar').style.width = usedOnDisk ? '0%' : '';
  const off = api.onProgress((p) => {
    const pct = usedOnDisk ? Math.min(99, Math.round((p.bytes / usedOnDisk) * 100)) : null;
    $('progress-text').textContent = `${pct === null ? 'Scanning…' : pct + '% scanned ·'} ${p.files.toLocaleString()} files · ${fmt(p.bytes)}`;
    if (pct !== null) $('progress-bar').style.width = pct + '%';
    setScanProgress(p, pct === null ? null : pct / 100);
  });
  try {
    const result = await api.scan(root || undefined);
    if (result.blocked) {
      toast(result.blocked.message);
      drives.open();
      return;
    }
    const { tree, suggestions } = result;
    state.tree = tree;
    if (tree.skipped && tree.skipped.length) {
      const names = [...new Set(tree.skipped.map((s) => s.label))];
      setTimeout(() => toast(`Left out ${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''} so nothing synced gets deleted. Add drives with the drive button.`), 400);
    }
    state.suggestions = suggestions;
    state.open = null;
    state.disk = await api.diskInfo();
    renderDisk();
    renderClean();
    layout();
    pro.loadDeep();
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
function showTab(name) {
  for (const t of $('tabs').children) t.classList.toggle('active', t.dataset.tab === name);
  for (const page of document.querySelectorAll('.tab-page')) page.hidden = page.id !== 'tab-' + name;
}
$('tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) showTab(tab.dataset.tab);
});
// Opened from the menu bar / tray (e.g. the low-space alert): jump to that tab.
if (api.onNavigate) {
  api.onNavigate((tab) => {
    setPanel(true);
    showTab(tab);
  });
}
if (api.onRescan) api.onRescan(() => runScan(state.tree ? state.tree.path : null));
pro = initPro({ api, state, fmt, esc, toast, buildGroup, rerender: () => renderClean(), DEMO });
seasons = initSeasons({
  THREE,
  scene,
  blocks,
  mats: { park: parkMat, pavement: pavementMat, roof: roofMat, kerb: kerb.material, plinth: plinth.material, cloud: clouds.children[0].children[0].material },
  isPro: () => pro.isPro(),
  planKnown: () => !!pro.status(),
  showUpgrade: (why) => pro.showUpgrade(why),
  getMeshes: () => meshes,
  getExtras: () => extras,
  getTreeSpots: () => treeSpots,
  applyNight,
});
api.diskInfo().then((d) => {
  state.disk = d;
  renderDisk();
});
const cityHall = initCityHall({ api, fmt, esc, toast, pro, DEMO });
initPhotos({ api, fmt, esc, toast, pro, DEMO });
initPrivacy({ api, fmt, esc, toast, pro, DEMO });
const perf = initPerformance({ api, fmt, esc, toast, DEMO });
const maint = initMaintenance({ api, esc, toast, DEMO });
drives = initDrives({ api, esc, toast, runScan, DEMO });
if (DEMO) {
  $('btn-scan').querySelector('span').textContent = 'Scan (demo data)';
  runScan(null);
}

// Exposed for automated UI checks.
window.__storageSaver = { perf, maint, state, openCategory, layout, toggleNight, dayCycle: (p) => (p === undefined ? { auto: autoCycle, p: cycleP, nightK } : (cycleP = p)), buildSite, setScanProgress, pro, seasons, camera, controls, blocks };

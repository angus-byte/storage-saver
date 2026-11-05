// Hand-made landmark buildings shipped as glTF (.glb) models. The .glb files
// live in assets/models and are embedded as base64 modules by
// scripts/embed-models.js, so nothing is fetched at runtime.
// Each model is merged into up to three meshes (body, glass, neon) for speed, turned to
// Y-up (the files are Z-up), centred, and sat on y = 0 with its front on +z.
import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { mergeGeometries } from './vendor/BufferGeometryUtils.js';
import { ART_DECO_TOWER_GLB } from './models/art-deco-tower.js';
import { DOMED_STATION_GLB } from './models/domed-station.js';
import { APARTMENT_DETAILED_GLB } from './models/apartment-detailed.js';
import { FILM_SOUNDSTAGE_GLB } from './models/film-soundstage.js';
import { NEON_GUITAR_TOWER_GLB } from './models/neon-guitar-tower.js';
import { MARKET_SQUARE_GLB } from './models/market-square.js';
import { CLASSICAL_LIBRARY_GLB } from './models/classical-library.js';
import { FACTORY_GLB } from './models/factory.js';
import { RUBBISH_TIP_GLB } from './models/rubbish-tip.js';
import { SAND_TOWER_GLB } from './models/sand-tower.js';
import { PALE_GREY_TOWER_GLB } from './models/pale-grey-tower.js';

// Category id -> model. Parts are picked by node name: `glass` windows glow
// warm at night, `neon` signs and bulbs glow in their own colour.
export const MODEL_FOR_CATEGORY = {
  apps: 'paleGreyTower',
  backups: 'decoTower',
  documents: 'sandTower',
  cloud: 'domedStation',
  downloads: 'apartment',
  video: 'soundstage',
  photos: 'soundstage',
  music: 'guitarTower',
  desktop: 'marketSquare',
  library: 'library',
  system: 'factory',
  sysother: 'factory', // the "System & other users" building
  trash: 'rubbishTip',
};
const SOURCES = {
  decoTower: { b64: ART_DECO_TOWER_GLB, glass: /glazing|glazed window|glass|lamp head|lamp glow/i },
  domedStation: { b64: DOMED_STATION_GLB, glass: /glazing|glazed bay|window pane|lamp globe|lantern glow|side window -?\d/i },
  apartment: { b64: APARTMENT_DETAILED_GLB, glass: /glazed window|window glass|ground floor window|entrance glazing|warm lobby|streetlight globe|wall lantern/i },
  soundstage: { b64: FILM_SOUNDSTAGE_GLB, glass: /glazing|glazed|stage side window|tall window|lamp light/i, neon: /marquee lighting|illuminated marquee|luminous lens/i },
  guitarTower: { b64: NEON_GUITAR_TOWER_GLB, glass: /glazing|amber glow|side window|glass door|lamp glowing bulb/i, neon: /neon|illuminated|marquee bulb/i },
  library: { b64: CLASSICAL_LIBRARY_GLB, glass: /window glass|^(side|rear) window \d+$|lamp lantern/i },
  // Smoke is split out so the city can make it drift (see placeModel).
  factory: { b64: FACTORY_GLB, glass: /warm glass|lamp globe/i, smoke: /smoke cloud/i },
  // Gulls are split out so they can circle over the tip.
  rubbishTip: { b64: RUBBISH_TIP_GLB, glass: /office window|windscreen|cab side window|headlamp|lamp head/i, spin: /^gull /i },
  sandTower: { b64: SAND_TOWER_GLB, glass: /window glass|entry glazing|lamp globe|roof skylight/i },
  paleGreyTower: { b64: PALE_GREY_TOWER_GLB, glass: /(front|side) window [\d -]+$|glass door|lamp globe/i },
  marketSquare: { b64: MARKET_SQUARE_GLB, glass: /glazing|warm glass|^window$|^window \d/i, neon: /string light|lamp globe/i },
};
const GLASS_EXCLUDE = /trim|mullion|transom|jamb|sill|frame|housing|backing|divider|window top|lintel/i;

const _c = new THREE.Color();
function prep(mesh) {
  let g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  g.applyMatrix4(mesh.matrixWorld);
  const pos = g.getAttribute('position');
  const src = g.getAttribute('color');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    // trimesh writes sRGB bytes; three expects linear vertex colours.
    if (src) _c.setRGB(src.getX(i), src.getY(i), src.getZ(i), THREE.SRGBColorSpace);
    else _c.setRGB(0.8, 0.8, 0.8);
    col[i * 3] = _c.r;
    col[i * 3 + 1] = _c.g;
    col[i * 3 + 2] = _c.b;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', pos.clone());
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  out.computeVertexNormals(); // non-indexed, so faces stay crisp
  g.dispose();
  return out;
}

async function gunzip(b64) {
  const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

async function loadOne({ b64, glass, neon, smoke, spin }) {
  const gltf = await new GLTFLoader().parseAsync(await gunzip(b64), '');
  gltf.scene.updateMatrixWorld(true);
  const body = [];
  const glow = [];
  const lit = [];
  const puffs = [];
  const birds = [];
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    // Original node name (three sanitises o.name); underscores read as spaces.
    // Numbered names ("0123_side_window_4") lose their leading number.
    const name = (o.userData.name || o.name || (o.parent && (o.parent.userData.name || o.parent.name)) || '').replace(/_/g, ' ').replace(/^(V2 )?\d+ /i, ''); // drop numbering like "0123_"
    const skip = GLASS_EXCLUDE.test(name);
    (spin && spin.test(name) ? birds : smoke && smoke.test(name) ? puffs : neon && neon.test(name) && !skip ? lit : glass.test(name) && !skip ? glow : body).push(prep(o));
  });
  if (!body.length) throw new Error('model has no meshes');
  const merge = (list) => (list.length ? mergeGeometries(list) : null);
  const parts = { body: merge(body), glass: merge(glow), neon: merge(lit), smoke: merge(puffs), spin: merge(birds) };
  // Z-up -> Y-up (front, at -y in the file, ends up facing +z), then centre.
  const box = new THREE.Box3();
  for (const g of Object.values(parts)) if (g) g.rotateX(-Math.PI / 2);
  for (const g of Object.values(parts)) if (g) { g.computeBoundingBox(); box.union(g.boundingBox); }
  const c = box.getCenter(new THREE.Vector3());
  for (const g of Object.values(parts)) if (g) g.translate(-c.x, -box.min.y, -c.z);
  const size = box.getSize(new THREE.Vector3());
  // Smoke pivots on the chimney mouth: the bottom centre of the plume.
  let smokeAt = null;
  if (parts.smoke) {
    parts.smoke.computeBoundingBox();
    const sb = parts.smoke.boundingBox;
    smokeAt = new THREE.Vector3((sb.min.x + sb.max.x) / 2, sb.min.y, (sb.min.z + sb.max.z) / 2);
    smokeAt.x = sb.min.x + 0.6; // the plume leans downwind; its root is at the low end
    parts.smoke.translate(-smokeAt.x, -smokeAt.y, -smokeAt.z);
  }
  return { ...parts, smokeAt, w: size.x, h: size.y, d: size.z };
}

// Resolves to { decoTower: {...}, domedStation: {...} }; a model that fails to
// load is left out, and its category falls back to the procedural building.
export async function loadLandmarkModels() {
  const out = {};
  await Promise.all(
    Object.entries(SOURCES).map(([id, src]) =>
      loadOne(src).then(
        (m) => (out[id] = m),
        (e) => console.warn(`Landmark model ${id} failed to load; using the built-in building.`, e)
      )
    )
  );
  return out;
}

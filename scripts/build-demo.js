// Builds a single-file browser demo (demo/index.html) that runs on mock data,
// loading Three.js from a CDN. Handy for previewing the UI without Electron.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const r = (p) => fs.readFileSync(path.join(root, 'src', 'renderer', p), 'utf8');
const THREE_VER = require(path.join(root, 'node_modules', 'three', 'package.json')).version;

let html = r('index.html');
const css = r('styles.css');
let app = r('app.js');
const treemap = r('treemap.js').replace(/^export /gm, '');
const mock = r('mock.js').replace(/^export /gm, '');
const pro = r('pro.js').replace(/^export /gm, '');
const seasonsJs = r('seasons.js').replace(/^export /gm, '');
const categoriesJs = r('categories.js').replace(/^export /gm, '');
const drivesJs = r('drives.js').replace(/^export /gm, '');

app = app
  .replace("import * as THREE from './vendor/three.module.js';", "import * as THREE from 'three';")
  .replace("import { OrbitControls } from './vendor/OrbitControls.js';", "import { OrbitControls } from 'three/addons/controls/OrbitControls.js';")
  .replace("import { squarify } from './treemap.js';\n", '')
  .replace("import { categorize, CATEGORIES } from './categories.js';\n", '')
  .replace("import { mockTree, mockSuggestions, mockDisk } from './mock.js';\n", '')
  .replace("import { initPro, demoPlanApi, mockDeep } from './pro.js';\n", '')
  .replace("import { initSeasons } from './seasons.js';\n", '')
  .replace("import { localizeDom } from './platform.js';\n", '')
  .replace("import { initDrives } from './drives.js';\n", '');

html = html
  .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>\n/, '')
  .replace('<link rel="stylesheet" href="styles.css" />', `<style>\n${css}\n</style>`)
  .replace(
    /<title>[^<]*<\/title>/,
    (t) => `${t}\n  <script type="importmap">{ "imports": { "three": "https://cdn.jsdelivr.net/npm/three@${THREE_VER}/build/three.module.js", "three/addons/": "https://cdn.jsdelivr.net/npm/three@${THREE_VER}/examples/jsm/" } }</script>`
  )
  .replace('<script type="module" src="app.js"></script>', `<script type="module">\n${treemap}\n${categoriesJs}\n${mock}\n${pro}\n${seasonsJs}\n${drivesJs}\n${app}\n</script>`);

fs.mkdirSync(path.join(root, 'demo'), { recursive: true });
// City Hall tab (apps + startup items): inlined ahead of the app code.
const cityhall = r('cityhall.js').replace(/^export /gm, '').replace("import { IS_WIN } from './platform.js';\n", '');
const privacy = r('privacy.js').replace(/^export /gm, '').replace("import { IS_WIN } from './platform.js';\n", '');
// Performance tab (Power Station), same treatment.
const perfJs = r('perf.js').replace(/^export /gm, '').replace("import { IS_WIN } from './platform.js';\n", '');
const platformJs = r('platform.js').replace(/^export /gm, '');
const photosJs = r('photos.js').replace(/^export /gm, '');
html = html
  .replace("import { initCityHall } from './cityhall.js';\n", '')
  .replace("import { initPrivacy } from './privacy.js';\n", '')
  .replace("import { initPhotos } from './photos.js';\n", '')
  .replace("import { initPerformance } from './perf.js';\n", '')
  .replace('<script type="module">\n', () => `<script type="module">\n${platformJs}\n${cityhall}\n${privacy}\n${photosJs}\n${perfJs}\n`);
fs.writeFileSync(path.join(root, 'demo', 'index.html'), html);
console.log('demo/index.html written');

// Copies the Three.js ES modules the renderer needs into src/renderer/vendor
// so the app works offline and without a bundler.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const threeDir = path.join(root, 'node_modules', 'three');
const out = path.join(root, 'src', 'renderer', 'vendor');

const files = [
  ['build/three.module.js', 'three.module.js'],
  ['examples/jsm/controls/OrbitControls.js', 'OrbitControls.js'],
];

fs.mkdirSync(out, { recursive: true });
for (const [from, to] of files) {
  const src = path.join(threeDir, from);
  if (!fs.existsSync(src)) {
    console.warn(`copy-vendor: missing ${src}; run npm install first`);
    continue;
  }
  let code = fs.readFileSync(src, 'utf8');
  if (to === 'OrbitControls.js') code = code.replace(/from 'three'/g, "from './three.module.js'");
  fs.writeFileSync(path.join(out, to), code);
}
console.log('copy-vendor: done');

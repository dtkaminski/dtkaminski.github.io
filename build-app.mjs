// Repeatable dashboard build (post pre-bundle). SOURCE OF TRUTH = greta-app.jsx.
// Edit greta-app.jsx, then run `node build-app.mjs` to transpile → greta-app.js and bump the
// cache-bust ?v= on the <script> in greta-dashboard.html.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const DIR = 'C:/Users/danie/Documents/Claude/Business/frkl/_deploy';

execSync('npx --yes esbuild greta-app.jsx --jsx=transform --target=es2019 --minify --outfile=greta-app.js', { cwd: DIR, stdio: 'inherit' });
const size = readFileSync(join(DIR, 'greta-app.js'), 'utf8').length;

// Cache-bust the bundle reference so browsers fetch the rebuilt file.
const HTML = join(DIR, 'greta-dashboard.html');
let html = readFileSync(HTML, 'utf8');
const v = String(Date.now());
html = html.replace(/(greta-app\.js\?v=)[^"]+/, `$1${v}`);
writeFileSync(HTML, html);
console.log(`built greta-app.js (${size} chars) · cache-bust v=${v}`);

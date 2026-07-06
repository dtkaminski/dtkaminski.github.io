// Repeatable dashboard build (post pre-bundle). SOURCE OF TRUTH = frkl-app.jsx.
// Edit frkl-app.jsx, then run `node build-app.mjs` to transpile → frkl-app.js and bump the
// cache-bust ?v= on the <script> in frkl-live-dashboard.html.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const DIR = 'C:/Users/danie/Documents/Claude/Business/frkl/_deploy';

execSync('npx --yes esbuild frkl-app.jsx --jsx=transform --target=es2019 --minify --outfile=frkl-app.js', { cwd: DIR, stdio: 'inherit' });
const size = readFileSync(join(DIR, 'frkl-app.js'), 'utf8').length;

// Cache-bust the bundle reference so browsers fetch the rebuilt file.
const HTML = join(DIR, 'frkl-live-dashboard.html');
let html = readFileSync(HTML, 'utf8');
const v = String(Date.now());
html = html.replace(/(frkl-app\.js\?v=)[^"]+/, `$1${v}`);
writeFileSync(HTML, html);
console.log(`built frkl-app.js (${size} chars) · cache-bust v=${v}`);

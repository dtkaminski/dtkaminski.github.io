// Pre-bundles the dashboard: extracts the inline <script type="text/babel"> JSX, transpiles it
// with esbuild (classic React.createElement, minified) to frkl-app.js, then rewrites the HTML to
// load that static file and drops babel-standalone. Eliminates the in-browser transpile (eval fix #4).
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const DIR = 'C:/Users/danie/Documents/Claude/Business/frkl/_deploy';
const HTML = join(DIR, 'frkl-live-dashboard.html');
const V = '2026061502';

let html = readFileSync(HTML, 'utf8');
writeFileSync(HTML + '.bak', html); // safety backup

const START = '<script type="text/babel">';
const i = html.indexOf(START);
if (i < 0) throw new Error('no babel script found');
const codeStart = i + START.length;
const codeEnd = html.indexOf('</script>', codeStart);
const code = html.slice(codeStart, codeEnd);
writeFileSync(join(DIR, 'frkl-app.jsx'), code);
console.log('extracted JSX:', code.length, 'chars');

execSync('npx --yes esbuild frkl-app.jsx --jsx=transform --target=es2019 --minify --outfile=frkl-app.js', { cwd: DIR, stdio: 'inherit' });
const outSize = readFileSync(join(DIR, 'frkl-app.js'), 'utf8').length;
console.log('transpiled frkl-app.js:', outSize, 'chars');

// Replace the whole babel block with an external script tag.
const blockEnd = codeEnd + '</script>'.length;
let out = html.slice(0, i) + `<script src="./frkl-app.js?v=${V}"></script>` + html.slice(blockEnd);
// Drop the babel-standalone CDN script (no longer needed).
out = out.replace(/\n?\s*<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/babel-standalone\/[^"]+"><\/script>/, '');
writeFileSync(HTML, out);
console.log('HTML rewritten:', html.length, '->', out.length, 'chars');

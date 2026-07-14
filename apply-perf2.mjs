/*
 * apply-perf2.mjs — perf pass 2 (host). Idempotent.
 *   1. greta-app.jsx        — guard the 5 unguarded `const P = window.FRKL_PATTERNS;` reads with `|| {}`.
 *   2. greta-dashboard.html — move greta-patterns.js (203KB) from blocking <head> to the background injector.
 * (The GA4 loader speed-up ships as the pre-modified greta-data-loader.js placed beside this — no apply step.)
 * Then: node build-app.mjs → hard-refresh → commit → push.  Rollback: git checkout -- greta-app.jsx greta-dashboard.html
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
const APP = 'greta-app.jsx', HTML = 'greta-dashboard.html';
function die(m){ console.error('✘ '+m); process.exit(1); }
for (const f of [APP, HTML]) if (!existsSync(f)) die(`${f} not found — run inside _deploy.`);

let app = readFileSync(APP,'utf8');
if (!/ReactDOM\.createRoot\([\s\S]*?\.render\(<App\/>\);\s*$/.test(app.trim())) die('greta-app.jsx looks truncated — do NOT build.');
if (app.includes('window.FRKL_PATTERNS || {}')) { console.log('• patterns guards already present — skipping.'); }
else {
  const before = 'const P = window.FRKL_PATTERNS;';
  const count = app.split(before).length - 1;
  copyFileSync(APP, APP+'.bak-perf2');
  app = app.split(before).join('const P = window.FRKL_PATTERNS || {};');
  writeFileSync(APP, app);
  console.log(`✓ greta-app.jsx: guarded ${count} FRKL_PATTERNS reads with || {}`);
}

let html = readFileSync(HTML,'utf8');
if (html.includes('"greta-patterns.js"')) { console.log('• greta-patterns.js already deferred — skipping.'); }
else {
  const tag = /\n?<script src="\.\/greta-patterns\.js\?v=[^"]*"><\/script>/;
  const arr = 'var files=["greta-cvr.js","greta-cohorts.js","greta-discount-codes.js","greta-products.js"]';
  if (!tag.test(html)) die('greta-patterns.js blocking <script> tag not found.');
  if (html.indexOf(arr) < 0) die('background injector array not found (apply the earlier perf pass first).');
  copyFileSync(HTML, HTML+'.bak-perf2');
  html = html.replace(tag, '');
  html = html.replace(arr, 'var files=["greta-cvr.js","greta-cohorts.js","greta-discount-codes.js","greta-products.js","greta-patterns.js"]');
  writeFileSync(HTML, html);
  console.log('✓ greta-dashboard.html: greta-patterns.js moved to background injector');
}
console.log('\nNext: node build-app.mjs → hard-refresh ?brand=frkl → commit & push (include greta-data-loader.js).');

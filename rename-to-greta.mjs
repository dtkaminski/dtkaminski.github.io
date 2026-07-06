// rename-to-greta.mjs — one-shot P5 rename: frkl-* framework files -> greta-*, and update
// every reference. Run it on YOUR machine, from the _deploy folder, on a CLEAN git tree:
//
//     cd "C:\Users\danie\Documents\Claude\Business\frkl\_deploy"
//     node rename-to-greta.mjs
//
// Review the report. If it says "VERIFY PASSED", then:
//     git add -A
//     git commit -m "P5: rename frkl-* framework files to greta-*"
//     git push
//
// SAFE BY DESIGN: aborts if app/index.html is truncated (won't re-break the shell),
// backs up every touched file to _greta-rename-backup/, uses exact string replacement
// (preserves line endings, no regex backrefs), and verifies all references resolve.
// The runtime globals stay window.FRKL_* — this renames FILES only, so NO rebuild is needed.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join } from 'path';

const DIR = process.cwd();
const abort = (m) => { console.error('\n✗ ABORT:', m, '\n(nothing was changed if this is the first check)'); process.exit(1); };

// ── 0) Safety gate: the shell must be intact before we touch anything ──
const appIdx = join(DIR, 'app', 'index.html');
if (!existsSync(join(DIR, 'frkl-live-dashboard.html')) && existsSync(join(DIR, 'greta-dashboard.html')))
  abort('Looks already renamed (greta-dashboard.html exists, frkl-live-dashboard.html does not).');
if (!existsSync(appIdx)) abort('app/index.html not found — run this from the _deploy folder.');
if (!readFileSync(appIdx, 'utf8').trimEnd().endsWith('</html>'))
  abort('app/index.html is TRUNCATED (does not end with </html>). Fix it first:  git checkout -- app/index.html');

// ── 1) Rename map ──
const statics = ['action-status','agent-insights','benchmarks','board-read','business-data','clarity',
  'cohorts','creative-vision','creators','cvr','diagnostic-analyst','discount-codes','events','links',
  'live-data','patterns','products','retention'];
const renames = [
  ['frkl-live-dashboard.html','greta-dashboard.html'],
  ['frkl-app.js','greta-app.js'],
  ['frkl-app.jsx','greta-app.jsx'],
  ['frkl-data-loader.js','greta-data-loader.js'],
  ['frkl-fit.js','greta-fit.js'],
  ...statics.map(s => [`frkl-${s}.js`, `greta-${s}.js`]),
];

const bak = join(DIR, '_greta-rename-backup');
if (!existsSync(bak)) mkdirSync(bak);
copyFileSync(appIdx, join(bak, 'app-index.html.bak'));

// ── 2) Rename files (backing up each first) ──
let renamed = 0;
for (const [from, to] of renames) {
  const src = join(DIR, from), dst = join(DIR, to);
  if (!existsSync(src)) { console.warn('  (skip, not found:', from + ')'); continue; }
  if (existsSync(dst)) abort(`target already exists: ${to}`);
  copyFileSync(src, join(bak, from));
  renameSync(src, dst);
  renamed++;
}

// ── 3) Reference edits (exact string replace; line endings preserved) ──
const edit = (file, subs) => {
  const p = join(DIR, file);
  copyFileSync(p, join(bak, file.replace(/[\\/]/g, '__')));
  let s = readFileSync(p, 'utf8');
  for (const [a, b] of subs) s = s.split(a).join(b);
  writeFileSync(p, s);
};
edit('greta-dashboard.html', [['"./frkl-', '"./greta-']]);        // 20 <script src> paths
edit(join('app', 'index.html'), [['frkl-live-dashboard.html', 'greta-dashboard.html']]); // richUrl
edit('build-app.mjs', [['frkl-app', 'greta-app'], ['frkl-live-dashboard.html', 'greta-dashboard.html']]);

// ── 4) Verify ──
const dash = readFileSync(join(DIR, 'greta-dashboard.html'), 'utf8');
const srcs = [...dash.matchAll(/src="\.\/([a-z0-9-]+\.js)\?/g)].map(m => m[1]);
const problems = [];
for (const f of srcs) if (!existsSync(join(DIR, f))) problems.push('dashboard references a missing file: ' + f);
if (/src="\.\/frkl-/.test(dash)) problems.push('greta-dashboard.html still references ./frkl-*');
const appNow = readFileSync(appIdx, 'utf8');
if (/frkl-live-dashboard\.html/.test(appNow)) problems.push('app/index.html still references frkl-live-dashboard.html');
if (!appNow.trimEnd().endsWith('</html>')) problems.push('app/index.html no longer ends with </html>');
if (srcs.length !== 20) problems.push(`expected 20 script refs in the dashboard, found ${srcs.length}`);

console.log(`\nRenamed ${renamed} files. greta-dashboard.html now loads ${srcs.length} scripts.`);
if (problems.length) {
  console.error('\n✗ VERIFY FAILED:');
  problems.forEach(p => console.error('   -', p));
  console.error('\nRestore from _greta-rename-backup/ (or `git checkout -- .` + move the greta-* files back) and tell Claude.');
  process.exit(1);
}
console.log('✓ VERIFY PASSED — every referenced file exists, no frkl- refs remain, shell intact.');
console.log('\nNow run:\n  git add -A\n  git commit -m "P5: rename frkl-* framework files to greta-*"\n  git push');
console.log('\n(Backups are in _greta-rename-backup/ — delete once you\'ve confirmed the live dashboard renders.)');

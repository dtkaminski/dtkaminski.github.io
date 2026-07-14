/*
 * apply-plan.mjs — wires the Plan panel (readiness gate + goal setter) into the Greta app, on the HOST.
 * Idempotent. Requires greta-plan-panel.jsx + greta-plan-data.js beside greta-app.jsx in _deploy.
 *   1. greta-app.jsx        — splice GretaPlanPanel before `const NAV=[`, add a "Plan" subtab after Overview.
 *   2. greta-dashboard.html — add <script src="./greta-plan-data.js"> after greta-overview-data.js.
 * Then: node build-app.mjs → hard-refresh → confirm → commit → push.
 * Rollback: git checkout -- greta-app.jsx greta-dashboard.html
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
const APP = 'greta-app.jsx', HTML = 'greta-dashboard.html', COMP = 'greta-plan-panel.jsx', DATA = 'greta-plan-data.js';
function die(m) { console.error('✘ ' + m); process.exit(1); }
for (const f of [APP, HTML, COMP, DATA]) if (!existsSync(f)) die(`${f} not found — run inside _deploy with the plan files copied in.`);

let app = readFileSync(APP, 'utf8');
if (!/ReactDOM\.createRoot\([\s\S]*?\.render\(<App\/>\);\s*$/.test(app.trim())) die('greta-app.jsx looks truncated — do NOT build.');
if (app.includes('GretaPlanPanel')) { console.log('• greta-app.jsx already has GretaPlanPanel — skipping.'); }
else {
  const comp = readFileSync(COMP, 'utf8');
  const navA = 'const NAV = [';
  const subA = "{ id:'overview-tiers', label:'Overview', component: () => <GretaOverviewTiers/> },";
  if (app.split(navA).length !== 2) die('NAV anchor not unique.');
  if (app.split(subA).length !== 2) die('overview-tiers subtab anchor not found (apply the Overview first).');
  copyFileSync(APP, APP + '.bak-plan');
  app = app.replace(navA, comp + '\n' + navA)
           .replace(subA, subA + "\n    { id:'plansetup', label:'Plan', component: () => <GretaPlanPanel/> },");
  writeFileSync(APP, app);
  console.log('✓ greta-app.jsx: GretaPlanPanel spliced + "Plan" subtab added after Overview (backup .bak-plan)');
}
let html = readFileSync(HTML, 'utf8');
if (html.includes('greta-plan-data.js')) { console.log('• greta-dashboard.html already loads greta-plan-data.js — skipping.'); }
else {
  const re = /(<script src="\.\/greta-overview-data\.js\?v=[^"]*"><\/script>)/;
  if (!re.test(html)) die('greta-overview-data.js script tag not found (apply the Overview first).');
  copyFileSync(HTML, HTML + '.bak-plan');
  html = html.replace(re, `$1\n<script src="./greta-plan-data.js?v=${Date.now()}"></script>`);
  writeFileSync(HTML, html);
  console.log('✓ greta-dashboard.html: greta-plan-data.js script tag added');
}
console.log('\nNext: node build-app.mjs → hard-refresh ?brand=frkl → open the Plan tab → Calculate → Confirm → commit & push.');

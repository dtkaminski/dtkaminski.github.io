/*
 * apply-economics.mjs — adds the Plan "Operating economics" editor + Overview "Operating profit" rung (host, idempotent).
 *   greta-app.jsx        — replace GretaOverviewTiers+GretaPlanPanel (marker→const NAV) with the new components
 *                          (Plan gains an economics editor writing brand_config; Overview component unchanged).
 *   greta-dashboard.html — cache-bust greta-overview-data.js (now fetches brand_config.fixed_costs_monthly → Operating profit tile)
 *                          AND greta-plan-data.js (now fetches brand_config + saveEconomics()).
 * greta-overview-data.js + greta-plan-data.js placed alongside. Then: node build-app.mjs → refresh → commit → push.
 * Rollback: git checkout -- greta-app.jsx greta-dashboard.html greta-overview-data.js greta-plan-data.js
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
const APP='greta-app.jsx', HTML='greta-dashboard.html', OV='greta-overview-tiers.jsx', PL='greta-plan-panel.jsx';
function die(m){ console.error('✘ '+m); process.exit(1); }
for (const f of [APP,HTML,OV,PL]) if(!existsSync(f)) die(`${f} not found`);
let app=readFileSync(APP,'utf8');
if(!/ReactDOM\.createRoot\([\s\S]*?\.render\(<App\/>\);\s*$/.test(app.trim())) die('greta-app.jsx truncated — do NOT build.');
const ov=readFileSync(OV,'utf8').replace(/\s+$/,''), pl=readFileSync(PL,'utf8').replace(/\s+$/,'');
const re=/\/\/ ── Overview tiers \(Business → Customer → Channel\)[\s\S]*?const NAV = \[/;
if(!re.test(app)) die('component region not found.');
copyFileSync(APP, APP+'.bak-econ');
app=app.replace(re, ov+'\n\n'+pl+'\n\nconst NAV = [');
writeFileSync(APP, app);
console.log('✓ greta-app.jsx: components updated (Plan economics editor)');
let html=readFileSync(HTML,'utf8'); let n=0;
for (const mod of ['greta-overview-data\\.js', 'greta-plan-data\\.js']) {
  const r=new RegExp('('+mod+'\\?v=)[0-9]+');
  if(r.test(html)){ html=html.replace(r,'$1'+(Date.now()+n)); n++; }
}
if(n){ copyFileSync(HTML,HTML+'.bak-econ'); writeFileSync(HTML,html); console.log(`✓ greta-dashboard.html: cache-bust ${n} data module(s)`); }
else console.log('• data-module ?v= not found');
console.log('Next: node build-app.mjs → hard-refresh → commit & push (include greta-overview-data.js + greta-plan-data.js).');

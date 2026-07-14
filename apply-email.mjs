/*
 * apply-email.mjs — adds the Klaviyo email breakdown block + re-applies the light restyle/AOV (host, idempotent).
 *   greta-app.jsx        — replace GretaOverviewTiers+GretaPlanPanel (marker→const NAV) with the new components.
 *   greta-dashboard.html — cache-bust greta-overview-data.js (now fetches vw_email_breakdown).
 * greta-overview-data.js placed alongside. Then: node build-app.mjs → refresh → commit → push.
 * Rollback: git checkout -- greta-app.jsx greta-dashboard.html greta-overview-data.js
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
copyFileSync(APP, APP+'.bak-email');
app=app.replace(re, ov+'\n\n'+pl+'\n\nconst NAV = [');
writeFileSync(APP, app);
console.log('✓ greta-app.jsx: components updated (email breakdown block + light restyle + AOV)');
let html=readFileSync(HTML,'utf8'); const r2=/(greta-overview-data\.js\?v=)[0-9]+/;
if(r2.test(html)){ copyFileSync(HTML,HTML+'.bak-email'); html=html.replace(r2,'$1'+Date.now()); writeFileSync(HTML,html); console.log('✓ greta-dashboard.html: cache-bust greta-overview-data.js'); }
else console.log('• data-module ?v= not found');
console.log('Next: node build-app.mjs → hard-refresh → commit & push (include greta-overview-data.js).');

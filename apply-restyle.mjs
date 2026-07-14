import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
const APP='greta-app.jsx', OV='greta-overview-tiers.jsx', PL='greta-plan-panel.jsx';
function die(m){ console.error('✘ '+m); process.exit(1); }
for (const f of [APP,OV,PL]) if(!existsSync(f)) die(`${f} not found`);
let app=readFileSync(APP,'utf8');
if(!/ReactDOM\.createRoot\([\s\S]*?\.render\(<App\/>\);\s*$/.test(app.trim())) die('greta-app.jsx truncated — do NOT build.');
const ov=readFileSync(OV,'utf8').replace(/\s+$/,''), pl=readFileSync(PL,'utf8').replace(/\s+$/,'');
const re=/\/\/ ── Overview tiers \(Business → Customer → Channel\)[\s\S]*?const NAV = \[/;
if(!re.test(app)) die('component region (marker → const NAV) not found.');
copyFileSync(APP, APP+'.bak-restyle');
app=app.replace(re, ov+'\n\n'+pl+'\n\nconst NAV = [');
writeFileSync(APP, app);
console.log('✓ greta-app.jsx: Overview + Plan components restyled to light app tokens + AOV column');
console.log('Next: node build-app.mjs → hard-refresh → commit & push.');

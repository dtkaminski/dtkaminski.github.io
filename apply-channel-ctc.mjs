/*
 * apply-channel-ctc.mjs — rebuilds the Overview channel tier to the CTC layout (host, idempotent).
 *   1. greta-app.jsx        — replace the GretaOverviewTiers block (marker → const NAV) with the new
 *                             greta-overview-tiers.jsx (CTC channel table: Spend·Incr rev·iCPA·iROAS·Marginal).
 *   2. greta-dashboard.html — cache-bust greta-overview-data.js (its channel data shape changed).
 * greta-overview-data.js is placed alongside (served file). Then: node build-app.mjs → refresh → commit → push.
 * Rollback: git checkout -- greta-app.jsx greta-dashboard.html greta-overview-data.js
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
const APP='greta-app.jsx', HTML='greta-dashboard.html', COMP='greta-overview-tiers.jsx';
function die(m){ console.error('✘ '+m); process.exit(1); }
for (const f of [APP,HTML,COMP]) if (!existsSync(f)) die(`${f} not found — run inside _deploy with the new files copied in.`);

let app = readFileSync(APP,'utf8');
if (!/ReactDOM\.createRoot\([\s\S]*?\.render\(<App\/>\);\s*$/.test(app.trim())) die('greta-app.jsx looks truncated — do NOT build.');
if (app.includes("'Incr rev'")) { console.log('• channel tier already CTC layout — skipping component swap.'); }
else {
  const comp = readFileSync(COMP,'utf8').replace(/\s+$/,'');
  const re = /\/\/ ── Overview tiers \(Business → Customer → Channel\)[\s\S]*?const NAV = \[/;
  if (!re.test(app)) die('component block (marker → const NAV) not found.');
  copyFileSync(APP, APP+'.bak-channelctc');
  app = app.replace(re, comp + '\n\nconst NAV = [');
  writeFileSync(APP, app);
  console.log('✓ greta-app.jsx: GretaOverviewTiers swapped to CTC channel layout (backup .bak-channelctc)');
}
let html = readFileSync(HTML,'utf8');
const re2 = /(greta-overview-data\.js\?v=)[0-9]+/;
if (re2.test(html)) { copyFileSync(HTML, HTML+'.bak-channelctc'); html = html.replace(re2, '$1'+Date.now()); writeFileSync(HTML, html); console.log('✓ greta-dashboard.html: cache-bust greta-overview-data.js'); }
else console.log('• greta-overview-data.js cache-bust token not found — check the script tag ?v=.');
console.log('\nNext: node build-app.mjs → hard-refresh ?brand=frkl → Channel tier shows CTC layout → commit & push (include greta-overview-data.js).');

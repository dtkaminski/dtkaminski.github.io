/*
 * apply-overview.mjs — wires the new Overview into the Greta app, on the HOST.
 *
 * WHY host-only: the Cowork sandbox mount truncates large files (greta-app.jsx ~895KB,
 * and even ~14KB files) on READ, so editing/building through it corrupts tails. Your host
 * has the complete files. Run this there.
 *
 * Does four idempotent edits, then you build:
 *   1. greta-app.jsx        — splice GretaOverviewTiers before `const NAV=[`, add it as the
 *                             FIRST subtab of the landing `home` section (→ first screen).
 *   2. greta-data-loader.js — repoint the Shopify daily read to v_tenant_shopify_daily_agg
 *                             (fixes the PostgREST 1000-row cap that hid sales after 8 Feb).
 *   3. greta-dashboard.html — add <script src="./greta-overview-data.js"> after greta-data-loader.js
 *                             (feeds window.FRKL_OVERVIEW for all 5 timeframes).
 *   4. verifies greta-overview-tiers.jsx + greta-overview-data.js are present beside it.
 *
 * USAGE (from the _deploy repo, with greta-overview-tiers.jsx + greta-overview-data.js copied in):
 *   node apply-overview.mjs
 *   node build-app.mjs
 *   # hard-refresh ?brand=frkl → verify → git add -A && git commit && git push
 *
 * Rollback: git checkout -- greta-app.jsx greta-data-loader.js greta-dashboard.html
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const APP = 'greta-app.jsx';
const LOADER = 'greta-data-loader.js';
const HTML = 'greta-dashboard.html';
const COMP = 'greta-overview-tiers.jsx';
const DATA = 'greta-overview-data.js';

function die(m) { console.error('✘ ' + m); process.exit(1); }
for (const fn of [APP, LOADER, HTML, COMP, DATA]) if (!existsSync(fn)) die(`${fn} not found — run inside _deploy with all files copied in.`);

// ---------- 1. greta-app.jsx: splice component + subtab ----------
let app = readFileSync(APP, 'utf8');
if (!/ReactDOM\.createRoot\([\s\S]*?\.render\(<App\/>\);\s*$/.test(app.trim())) die('greta-app.jsx looks truncated (no trailing ReactDOM…render). Aborting — do NOT build.');
if (app.includes('GretaOverviewTiers')) {
  console.log('• greta-app.jsx already has GretaOverviewTiers — skipping splice.');
} else {
  const comp = readFileSync(COMP, 'utf8');
  const navA = 'const NAV = [';
  const homeA = "{ id:'home',    label:'Today',    icon:'home',     subtabs:[";
  if (app.split(navA).length !== 2) die('NAV anchor not unique.');
  if (app.split(homeA).length !== 2) die('home-section anchor not unique.');
  copyFileSync(APP, APP + '.bak-overview');
  app = app.replace(navA, comp + '\n' + navA)
           .replace(homeA, homeA + "\n    { id:'overview-tiers', label:'Overview', component: () => <GretaOverviewTiers/> },");
  writeFileSync(APP, app);
  console.log('✓ greta-app.jsx: component spliced + Overview added as first screen (backup .bak-overview)');
}

// ---------- 2. greta-data-loader.js: repoint Shopify read to the agg view ----------
let ld = readFileSync(LOADER, 'utf8');
if (ld.includes('v_tenant_shopify_daily_agg')) {
  console.log('• greta-data-loader.js already on v_tenant_shopify_daily_agg — skipping.');
} else {
  const selOld = ".select('day, order_count, net_revenue, discounts, line_items, aov, returns, channel')";
  const fromOld = "sb.from('v_tenant_shopify_daily')";
  if (!ld.includes(fromOld) || !ld.includes(selOld)) die('loader Shopify anchors not found — repoint manually: from(v_tenant_shopify_daily_agg) + drop ", channel" from its select.');
  copyFileSync(LOADER, LOADER + '.bak-overview');
  ld = ld.replace(fromOld, "sb.from('v_tenant_shopify_daily_agg')")
         .replace(selOld, ".select('day, order_count, net_revenue, discounts, line_items, aov, returns')");
  writeFileSync(LOADER, ld);
  console.log('✓ greta-data-loader.js: Shopify read repointed to v_tenant_shopify_daily_agg (1000-row-cap fix)');
}

// ---------- 3. greta-dashboard.html: add the data-module script tag ----------
let html = readFileSync(HTML, 'utf8');
if (html.includes('greta-overview-data.js')) {
  console.log('• greta-dashboard.html already loads greta-overview-data.js — skipping.');
} else {
  const re = /(<script src="\.\/greta-data-loader\.js\?v=[^"]*"><\/script>)/;
  if (!re.test(html)) die('greta-data-loader.js script tag not found in greta-dashboard.html.');
  copyFileSync(HTML, HTML + '.bak-overview');
  html = html.replace(re, `$1\n<script src="./greta-overview-data.js?v=${Date.now()}"></script>`);
  writeFileSync(HTML, html);
  console.log('✓ greta-dashboard.html: greta-overview-data.js script tag added after the loader');
}

console.log('\nNext: node build-app.mjs → hard-refresh ?brand=frkl → verify Overview + fresh sales → commit & push.');
console.log('Rollback: git checkout -- greta-app.jsx greta-data-loader.js greta-dashboard.html');

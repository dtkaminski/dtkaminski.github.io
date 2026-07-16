/*
 * apply-accent.mjs — unify the legacy periwinkle accent to the refined indigo, on the HOST.
 *
 * WHY host-only: the Cowork sandbox mount truncates greta-app.jsx (~914KB) on READ, so editing
 * through it corrupts the tail. Your host has the complete file. Run this there.
 *
 * WHAT it does (idempotent): three safe, literal colour replacements in greta-app.jsx —
 *   #7c8cff      → #8B5CF6        (old accent hex        → refined indigo)   ~36×
 *   #9aa6ff      → #8B5CF6        (old accent light tint → refined indigo)   ~15×
 *   124,140,255  → 139,92,246     (old accent rgba base  → indigo rgba base) ~25×
 * Literals are used (not var(--accent)) on purpose: these values live in a mix of CSS style
 * objects AND SVG/Recharts stroke/fill attributes + colour-map/palette data, where var() is
 * invalid. A literal hex is valid in every context, so nothing can break.
 *
 * USAGE (from the _deploy repo):
 *   node apply-accent.mjs
 *   node build-app.mjs                 # transpiles greta-app.jsx → greta-app.js + cache-busts
 *   # hard-refresh ?brand=frkl → verify → git add -A && git commit && git push
 *
 * Rollback: git checkout -- greta-app.jsx     (or restore greta-app.jsx.bak-accent)
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const APP = 'greta-app.jsx';
const NEW_HEX = '#8B5CF6';
const OLD_RGB = '124,140,255';
const NEW_RGB = '139,92,246';

function die(m) { console.error('✘ ' + m); process.exit(1); }
if (!existsSync(APP)) die(`${APP} not found — run inside the _deploy repo.`);

let app = readFileSync(APP, 'utf8');

// --- truncation guard: the bundle MUST end with the ReactDOM mount, or the mount clipped it ---
if (!/ReactDOM\.createRoot\([\s\S]*?\.render\(<App\/>\);\s*$/.test(app.trim()))
  die('greta-app.jsx looks truncated (no trailing ReactDOM…render(<App/>)). Aborting — do NOT build.');

// --- count before ---
const c7 = (app.match(/#7c8cff/gi) || []).length;
const c9 = (app.match(/#9aa6ff/gi) || []).length;
const cR = (app.split(OLD_RGB).length - 1);

if (c7 + c9 + cR === 0) {
  console.log('• No legacy accent values found — already applied. Nothing to do.');
  process.exit(0);
}

copyFileSync(APP, APP + '.bak-accent');

app = app.replace(/#7c8cff/gi, NEW_HEX)
         .replace(/#9aa6ff/gi, NEW_HEX)
         .split(OLD_RGB).join(NEW_RGB);

// --- verify none remain ---
const left = (app.match(/#7c8cff/gi) || []).length
           + (app.match(/#9aa6ff/gi) || []).length
           + (app.split(OLD_RGB).length - 1);
if (left !== 0) die(`still ${left} legacy accent value(s) after replace — aborting, greta-app.jsx NOT written.`);

writeFileSync(APP, app);
console.log(`✓ greta-app.jsx accent unified → ${NEW_HEX}`);
console.log(`  #7c8cff ×${c7}  ·  #9aa6ff ×${c9}  ·  rgba(${OLD_RGB}) ×${cR}  =  ${c7 + c9 + cR} replacements`);
console.log('  backup: greta-app.jsx.bak-accent');
console.log('Next: node build-app.mjs → hard-refresh → verify → commit & push.');

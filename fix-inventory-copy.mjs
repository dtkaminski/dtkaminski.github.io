// fix-inventory-copy.mjs — de-frkl the onboarding "Inventory health" card copy.
// Run on your machine, from _deploy:  node fix-inventory-copy.mjs
// Then:  git add app/index.html && git commit -m "de-frkl: generic inventory onboarding copy" && git push
//
// SAFE: aborts if app/index.html is truncated (won't re-break the shell); backs up first;
// exact string replace only; verifies the frkl reference is gone and the file still closes cleanly.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { join } from 'path';

const p = join(process.cwd(), 'app', 'index.html');
if (!existsSync(p)) { console.error('✗ run from the _deploy folder (app/index.html not found)'); process.exit(1); }
let s = readFileSync(p, 'utf8');
if (!s.trimEnd().endsWith('</html>')) { console.error('✗ app/index.html is TRUNCATED — fix first: git checkout -- app/index.html'); process.exit(1); }

const OLD = 'Flags critical low-stock + working capital trapped in overstock. The frkl version found <b>£295k locked up</b>.';
const NEW = 'Flags critical low-stock + working capital trapped in overstock — days of cover per SKU and the cash tied up in slow movers.';

if (!s.includes(OLD)) {
  if (s.includes(NEW)) { console.log('✓ already de-frkl\'d — nothing to do.'); process.exit(0); }
  console.error('✗ expected copy not found — the line may have changed. No change made.'); process.exit(1);
}
copyFileSync(p, p + '.bak');
s = s.split(OLD).join(NEW);
writeFileSync(p, s);

const after = readFileSync(p, 'utf8');
const problems = [];
if (/the frkl version/i.test(after)) problems.push('frkl reference still present');
if (!after.trimEnd().endsWith('</html>')) problems.push('file no longer ends with </html>');
if (problems.length) { console.error('✗ VERIFY FAILED:', problems.join('; '), '\nRestore: git checkout -- app/index.html'); process.exit(1); }
console.log('✓ done — inventory card copy is now brand-neutral (backup at app/index.html.bak).');
console.log('  git add app/index.html && git commit -m "de-frkl: generic inventory onboarding copy" && git push');

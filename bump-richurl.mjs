// bump-richurl.mjs — bump the shell's pinned dashboard cache-bust so browsers re-fetch the iframe
// HTML (and thus the latest greta-app.js). Run from _deploy:  node bump-richurl.mjs
// Then:  git add app/index.html && git commit -m "cache-bust: bump richUrl" && git push
//
// SAFE: aborts if app/index.html is truncated; backs up first; exact replace; verifies.

import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'fs';
import { join } from 'path';

const p = join(process.cwd(), 'app', 'index.html');
if (!existsSync(p)) { console.error('✗ run from _deploy (app/index.html not found)'); process.exit(1); }
let s = readFileSync(p, 'utf8');
if (!s.trimEnd().endsWith('</html>')) { console.error('✗ app/index.html is TRUNCATED — fix first: git checkout -- app/index.html'); process.exit(1); }

const m = s.match(/(const richUrl = '\/greta-dashboard\.html\?v=)(\d+)(';)/);
if (!m) { console.error('✗ richUrl line not found — no change made.'); process.exit(1); }
const now = new Date();
const v = now.getFullYear().toString() + String(now.getMonth()+1).padStart(2,'0') + String(now.getDate()).padStart(2,'0')
        + String(now.getHours()).padStart(2,'0') + String(now.getMinutes()).padStart(2,'0') + String(now.getSeconds()).padStart(2,'0');
if (m[2] === v) { console.log('✓ already current'); process.exit(0); }
copyFileSync(p, p + '.bak');
s = s.replace(m[0], m[1] + v + m[3]);
writeFileSync(p, s);

const after = readFileSync(p, 'utf8');
if (!after.includes('?v=' + v) || !after.trimEnd().endsWith('</html>')) {
  console.error('✗ VERIFY FAILED — restore: git checkout -- app/index.html'); process.exit(1);
}
console.log('✓ richUrl bumped ' + m[2] + ' -> ' + v + ' (backup at app/index.html.bak)');
console.log('  git add app/index.html && git commit -m "cache-bust: bump dashboard richUrl" && git push');

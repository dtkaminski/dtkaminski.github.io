// Repeatable dashboard build (post pre-bundle). SOURCE OF TRUTH = greta-app.jsx.
// Edit greta-app.jsx, then run `node build-app.mjs` to transpile → greta-app.js and bump the
// cache-bust ?v= on the <script> in greta-dashboard.html.
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const DIR = 'C:/Users/danie/Documents/Claude/Businesses/frkl/_deploy';

execSync('npx --yes esbuild greta-app.jsx --jsx=transform --target=es2019 --minify --outfile=greta-app.js', { cwd: DIR, stdio: 'inherit' });
const size = readFileSync(join(DIR, 'greta-app.js'), 'utf8').length;

// Cache-bust the bundle reference so browsers fetch the rebuilt file.
const HTML = join(DIR, 'greta-dashboard.html');
let html = readFileSync(HTML, 'utf8');
const v = String(Date.now());
html = html.replace(/(greta-app\.js\?v=)[^"]+/, `$1${v}`);
// The kit stylesheet changes alongside the JSX more often than not; bump it too.
html = html.replace(/(greta-kit\.css\?v=)[^"]+/, `$1${v}`);
writeFileSync(HTML, html);

// Also bump the app-shell's pointer to greta-dashboard.html — otherwise returning
// visitors keep the cached shell (fixed ?v) and never fetch the rebuilt dashboard.
const SHELL = join(DIR, 'app', 'index.html');
let shell = readFileSync(SHELL, 'utf8');
shell = shell.replace(/(greta-dashboard\.html\?v=)[^'"]+/, `$1${v}`);
writeFileSync(SHELL, shell);

console.log(`built greta-app.js (${size} chars) · cache-bust v=${v} (dashboard + shell)`);

// Design-debt ratchet (ui-lint.mjs): report, never block — other sessions build here too.
try {
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, [join(DIR, 'ui-lint.mjs'), '--check'], { cwd: DIR, stdio: 'pipe' });
} catch (e) {
  const out = String((e && e.stdout) || '') + String((e && e.stderr) || '');
  const NL = String.fromCharCode(10);
  if (out) console.warn('ui-lint: design debt went up —' + NL + out.split(NL).filter(l => /^✖|went up/.test(l)).join(NL));
}

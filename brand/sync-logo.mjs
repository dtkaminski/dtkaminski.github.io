// Writes the one logo master (brand/greta-logo.inline.svg) into every page that shows the lockup.
// Each copy gets its own gradient ids, so two logos on one page never share a definition.
// Run from the repo root: node brand/sync-logo.mjs
import { readFileSync, writeFileSync } from 'node:fs';
const TEMPLATE = readFileSync('brand/greta-logo.inline.svg', 'utf8').trim();
const PAGES = ['index.html', 'app/index.html', 'auth/login.html', 'auth/signup.html', 'auth/apply.html', 'auth/workspace.html'];
const LOGO = /<svg class="(greta-logo[^"]*)"[\s\S]*?<\/svg>/g;
for (const page of PAGES) {
  const tag = page.replace(/[^a-z]/g, '').slice(0, 6);
  let n = 0;
  const before = readFileSync(page, 'utf8');
  const after = before.replace(LOGO, (_, cls) =>
    TEMPLATE.replace('class="greta-logo"', `class="${cls}"`).replaceAll('{N}', `${tag}${++n}`));
  if (after !== before) writeFileSync(page, after);
  console.log(`${page}: ${n} logo${n === 1 ? '' : 's'}`);
}

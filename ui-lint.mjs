// ui-lint.mjs — design-debt ratchet for greta-app.jsx (Phase 4 of the visual overhaul).
//
//   node ui-lint.mjs            report counts against the baseline
//   node ui-lint.mjs --check    exit 1 if any count went UP (run before committing)
//   node ui-lint.mjs --update   write today's counts as the new baseline (after paying debt down)
//
// It is a ratchet, not a gate: the counts are what the file carries today, and the only rule
// is that none of them grows. New UI is built from greta-kit.css classes and design tokens,
// so a change that adds an inline hex, an accent bar or a glyph icon shows up here first.
import fs from 'node:fs';

const SRC = 'greta-app.jsx';
const BASE = 'ui-lint.baseline.json';
const src = fs.readFileSync(SRC, 'utf8');
// Strip comments so prose about a banned pattern does not count as the pattern.
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');

const count = (re) => (code.match(re) || []).length;
const CHART_HEIGHTS = new Set([32, 64, 160, 240]);   // spark, mini (in a card), compact, standard

const rules = {
  // Coloured accent bars down the left of a box: the "budget dashboard" signature.
  border_left_bars: count(/borderLeft\s*:\s*['"`][^'"`]*(?:solid|var\()/g),
  // Hex colours written into JSX instead of a token (PAL fallbacks live in one object and are excluded).
  inline_hex: count(/(?:color|background|fill|stroke|borderColor)\s*:\s*['"]#[0-9a-fA-F]{3,8}['"]/g),
  // Unicode glyphs drawn as UI icons: carets, triangles, check/cross marks, warning signs.
  glyph_icons: count(/['"`>][^'"`<>\n]{0,3}[▸▾▴▲▼◂◀▶◎⚠✓✔✕✖✗☐☑★☆●○◆◇][^'"`<>\n]{0,3}['"`<]/g),
  // A card nested inside a card.
  card_in_card: (() => {
    let n = 0;
    const re = /className=["'`][^"'`]*\bcard\b[^"'`]*["'`]/g;
    // Heuristic: count "card" class openings that follow another within 400 chars without a
    // closing </div> balance check — reported, not enforced to zero.
    const idx = []; let m;
    while ((m = re.exec(code))) idx.push(m.index);
    for (let i = 1; i < idx.length; i++) {
      const between = code.slice(idx[i - 1], idx[i]);
      const opens = (between.match(/<div\b/g) || []).length, closes = (between.match(/<\/div>/g) || []).length;
      if (opens > closes) n++;
    }
    return n;
  })(),
  // Chart heights outside the kit's set (spark 32, mini 64, compact 160, standard 240).
  off_scale_chart_heights: (() => {
    let n = 0; const re = /ResponsiveContainer[^>]*height=\{(\d+)\}/g; let m;
    while ((m = re.exec(code))) if (!CHART_HEIGHTS.has(Number(m[1]))) n++;
    return n;
  })(),
  // Raw px numbers inside style objects (padding: 12, gap: 6, fontSize: 11 …). Informational:
  // the long tail of legacy panels; the number should only go down.
  inline_px_values: count(/\b(?:padding|margin|gap|fontSize|marginTop|marginBottom|marginLeft|marginRight|paddingTop|paddingBottom|borderRadius)\s*:\s*\d+/g),
  // Formatting that leaks to the screen.
  iso_date_slices: count(/\.slice\(0,\s*10\)\s*\}/g),
  to_fixed_in_jsx: count(/\{[^{}\n]*\.toFixed\(\d\)[^{}\n]*\}/g),
};

const base = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, 'utf8')) : null;
const arg = process.argv[2] || '';
if (arg === '--update' || !base) {
  fs.writeFileSync(BASE, JSON.stringify(rules, null, 2) + '\n');
  console.log((base ? 'baseline updated' : 'baseline written') + ' → ' + BASE);
}
let worse = 0;
for (const [k, v] of Object.entries(rules)) {
  const b = base ? base[k] : v;
  const d = v - b;
  if (d > 0) worse++;
  console.log((d > 0 ? '✖ ' : d < 0 ? '↓ ' : '  ') + k.padEnd(26) + String(v).padStart(6) + (base ? '   baseline ' + b + (d ? ' (' + (d > 0 ? '+' : '') + d + ')' : '') : ''));
}
if (arg === '--check' && worse) {
  console.error('\nui-lint: ' + worse + ' count(s) went up. Build from greta-kit.css classes and tokens instead.');
  process.exit(1);
}

# Dashboard build — READ BEFORE EDITING `frkl-live-dashboard.html`

**The dashboard is now pre-bundled. The app code is NO LONGER in the HTML.**

As of 2026-06-15 the in-browser Babel transpile was removed (it was downloading babel-standalone and
transpiling ~800 KB of JSX on every page load — slow first paint, and the eval's fix #4). The app now
ships as a pre-built static bundle.

## Where the code lives

| File | Role |
|---|---|
| **`frkl-app.jsx`** | **SOURCE OF TRUTH** — all React/JSX dashboard code. Edit this. |
| `frkl-app.js` | Built output (esbuild, minified). Loaded by the HTML. **Do not hand-edit** — it's regenerated. |
| `frkl-live-dashboard.html` | A ~59 KB shell: `<head>` (CDN libs, data files), `#root`, and `<script src="./frkl-app.js?v=…">`. **Contains no app code.** |
| `build-app.mjs` | The build script. |
| `frkl-live-dashboard.html.bak` | Pre-bundle backup (the old 872 KB single-file version) — rollback only. |
| `frkl-*.js` (cohorts, cvr, fit, …) | Data globals (`window.FRKL_*`). Unchanged by the bundling. |

## How to make a change

```bash
# 1. edit the source
#    frkl-app.jsx
# 2. rebuild (transpiles → frkl-app.js and bumps the ?v= cache-bust in the HTML)
node build-app.mjs
# 3. deploy frkl-app.js + frkl-live-dashboard.html together (commit both)
```

`build-app.mjs` runs `npx esbuild frkl-app.jsx --jsx=transform --target=es2019 --minify` and rewrites
the `frkl-app.js?v=` query string so browsers fetch the new bundle. esbuild uses the classic
`React.createElement` transform — React/ReactDOM/Recharts stay global via the CDN `<script>`s, and
hooks come from `const { useState, useMemo } = React` at the top of `frkl-app.jsx`.

**Gotcha:** don't paste new components/JSX into `frkl-live-dashboard.html` — they won't run (it's a
shell). Put them in `frkl-app.jsx` and rebuild.

## Local preview
`python -m http.server 8902 --directory <this dir>` then open `/frkl-live-dashboard.html`.
(There's a `.claude/launch.json` "frkl-deploy" config for the same.)

## Recent changes baked into `frkl-app.jsx` (2026-06-15)
- **Nav/IA restructure** — funnel-led `RAIL`/`NAV` (Overview · Act · Growth · Customers · Products & supply);
  new `Conversion` (CVR + Site), `Spend forecast`, `Competitors` sections; consistent labels.
- **Fit engine** — `FitCard` (OMF/PMF) in Channels → Cross-channel, reads `window.FRKL_FIT`.
- **Density pass** — global freshness banner → app-bar `FreshnessChip`; Fit verdict de-capsed (don't put
  sentences in `.micro`, it's `text-transform:uppercase`); **Products & stock** split into
  Stock · Performance · Bundles subtabs; **CVR drivers** stats (sections 3–4) collapsed behind a
  "Show the statistics" toggle.

## Roadmap note
Visual screenshot QA in the preview still times out (Recharts/render, not the transpile). Verify changes
via the DOM. A future improvement: move the build into Netlify CI so `node build-app.mjs` runs on deploy
rather than locally.

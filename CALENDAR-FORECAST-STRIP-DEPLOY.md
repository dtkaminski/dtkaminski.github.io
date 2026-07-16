# Deploy — Plan "Forecast vs goal" strip (calendar → forecast impact) · 2026-07-15

Surfaces the calendar's impact on the plan on the **Plan** tab, reading the SOT view
`vw_forecast_vs_goal` (no client recompute). Built in the served source-of-truth `greta-app.jsx`.

## Files edited (in `_deploy`)
- **`greta-plan-data.js`** — `refresh()` now also reads `vw_forecast_vs_goal` → `window.FRKL_PLAN.forecast`.
- **`greta-app.jsx`** — added a "Forecast vs goal" strip inside `GretaPlanPanel` (between the readiness
  gate and the goal setter): Forecast revenue/CAM vs target, the calendar's own contribution, and the
  revenue/CAM gap, with honest horizon coverage. Uses in-scope `GP_T` / `GP_gbp` / `GP_Metric`.
- **`greta-plan-panel.jsx`** — same strip mirrored into the module source (keeps SOT in sync; `apply-plan.mjs`
  is one-time, so `greta-app.jsx` is the file that actually ships).

## Build + validate + deploy (host — the build IS the validation)
```powershell
cd C:\Users\danie\Documents\Claude\Business\frkl\_deploy
# optional integrity check first:
Select-String -Path greta-app.jsx -Pattern "ReactDOM.createRoot\(document.getElementById\('root'\)\).render\(<App/>\)"   # must match (tail intact)
Select-String -Path greta-app.jsx -Pattern "Forecast vs goal"                                                           # must match (strip present)
node build-app.mjs          # esbuild → greta-app.js + cache-bust. If the JSX has any error it FAILS HERE, before push.
```
Then bump the `greta-plan-data.js?v=` cache-bust in `greta-dashboard.html` (or hard-refresh), and:
```powershell
git add greta-app.jsx greta-app.js greta-plan-data.js greta-plan-panel.jsx greta-dashboard.html
git commit -m "Plan: Forecast-vs-goal strip (calendar impact) reading vw_forecast_vs_goal"
git push
```
Verify: open `?brand=frkl` → **Plan** tab → the "Forecast vs goal" strip renders above the goal setter
(frkl today: forecast covers to Aug 12, £0 from the calendar until Q3 events are added).

## Note on in-session validation
The edits were applied with the reliable file editor and the true `greta-app.jsx` tail is intact
(confirmed via a direct read: 11,657 lines, ends with the `ReactDOM.createRoot(...).render(<App/>)`).
I could **not** esbuild in-session: this sandbox's mount truncates large-file reads, so an in-session
build reads a cut-off input and throws a false "unexpected end of file". `node build-app.mjs` on the host
reads the complete file and is the real gate.

## Rollback
```powershell
git checkout -- greta-app.jsx greta-plan-data.js greta-plan-panel.jsx greta-dashboard.html
# or restore the bundle from the pre-edit backup if needed: greta-app.jsx.bak-econ
```

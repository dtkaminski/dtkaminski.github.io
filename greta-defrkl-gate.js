/*
 * greta-defrkl-gate.js — de-frkl pre-eval gate, as a deferred file.
 *
 * WHY THIS IS A FILE AND NOT AN INLINE <script>
 * This logic used to be an inline script in <body>. Inline scripts are parser-inserted
 * and run DURING parse; the static greta-*.js snapshots were blocking, so they had
 * already evaluated by then and the gate could clear what they set. On 2026-09-29 those
 * snapshots became `defer` (692 KB was blocking first paint for every tenant), and
 * deferred scripts run AFTER parse — so an inline gate would have run BEFORE the files
 * it exists to neutralise, silently undoing itself and leaking frkl's data to every
 * other brand. As a deferred file placed after them and before greta-app.js, document
 * order guarantees it runs in between.
 *
 * WHAT IT DOES
 * greta-app.jsx captures some globals into module-level consts at bundle-eval
 * (FRKL_LINKS -> _linkKeys/_linkRe, FRKL_INSIGHTS -> INS). Reassigning window.X after
 * that point would not reach those consts, so they must be cleared BEFORE the bundle
 * evaluates. Everything else is read fresh at render time and is handled later by
 * greta-data-loader.js's neutraliseStaticOnlyForNonFrkl(), which runs at
 * DOMContentLoaded and mutates the objects in place for the same reason.
 *
 * frkl keeps its own snapshot and returns early.
 */
(function () {
  'use strict';
  try {
    // Same resolution order as greta-data-loader.js and greta-headline-data.js: our own
    // window, then the /app shell one frame up, then frkl. The fallback is deliberately
    // frkl, so a failure to resolve the slug loads everything rather than blanking a
    // working dashboard — fail toward the previous behaviour, not toward an empty screen.
    var parentSlug = null;
    try { parentSlug = (window.parent && window.parent !== window) ? window.parent.OI_BRAND_SLUG : null; } catch (e) {}
    var slug = window.OI_BRAND_SLUG || parentSlug || 'frkl';
    if (slug === 'frkl') return;
    window.FRKL_LINKS = {};
    window.FRKL_INSIGHTS = {};
  } catch (e) { /* never let the gate break the boot */ }
})();

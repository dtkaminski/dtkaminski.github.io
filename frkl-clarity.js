// Intentionally empty (eval 10 Oct 2026, fix 1; Dan approved). This file used to hold a static snapshot of
// one brand's real figures, and GitHub Pages served it to anyone. Signed-in pages never relied on it: the
// loader retires or neutralises these globals (greta-data-loader.js) and greta-live-snapshots.js rebuilds
// what screens read from the brand's own live views. What is left is the empty shape the loader gives any
// brand without a snapshot, so each panel shows its empty state until live data lands.
window.FRKL_CLARITY = null;

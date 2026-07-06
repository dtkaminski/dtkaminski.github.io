// Intentionally empty. This file previously held a STATIC snapshot of one brand's fit
// result (window.FRKL_FIT = {... omfScore:100, pmfScore:90 ...}), auto-generated from
// frkl's live data. That snapshot rendered for every tenant and for the unauthed demo,
// showing one brand's flattering scores as if they were the viewer's.
//
// Fit is now read LIVE per brand from the assess-fit edge function (see useFitResult in
// frkl-app.jsx). The dashboard no longer loads this file (the <script> include was removed
// from frkl-live-dashboard.html); with no window.FRKL_FIT the fit panel shows its
// loading/empty state until the per-tenant live read resolves.
//
// To restore a per-brand cached snapshot, regenerate it FROM THAT BRAND's data at build
// time — never ship one brand's numbers as a shared default.

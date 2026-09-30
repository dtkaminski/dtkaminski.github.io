/*
 * greta-track.js — first-party product analytics. Load AFTER greta-data-loader.js.
 *
 * WHY THIS AND NOT A TAG
 * The product had no analytics at all, so activation and churn were invisible. The options
 * were a third-party tag or the stack already here. This is the stack already here: rows go
 * to public.product_events through the same Supabase client and the same RLS as
 * client_error_log, which means no new sub-processor, no cookie banner, no PII beyond the
 * auth user id we already hold, and a tenant can read its own usage but nobody else's.
 *
 * If PostHog earns its place later, this file is the seam — track() fans out, call sites
 * do not change.
 *
 * CONTRACT
 *   greta.track(name, props, surface)   one row, fire-and-forget, never throws, never blocks
 * Names are a closed set (EVENTS below) so the funnel view cannot drift from what is sent.
 */
(function () {
  'use strict';

  // The closed set. vw_product_activation reads these names; adding one here without adding
  // it there gives you rows nobody looks at, which is how event schemas rot.
  var EVENTS = {
    signup: 1, source_connected: 1, costs_entered: 1, goal_confirmed: 1,
    action_started: 1, action_done: 1, action_skipped: 1, ask_used: 1, page_view: 1
  };

  // One id per tab, so "sessions" means visits rather than users. sessionStorage, because it
  // should die with the tab; wrapped because private mode throws on access.
  var sid = (function () {
    try {
      var k = 'greta_sid', v = sessionStorage.getItem(k);
      if (!v) { v = Math.random().toString(36).slice(2) + Date.now().toString(36); sessionStorage.setItem(k, v); }
      return v;
    } catch (e) { return 'nostore'; }
  })();

  function client() {
    if (typeof window === 'undefined') return null;
    return window.sb || (window.FRKL_LIVE && window.FRKL_LIVE.sb) || null;
  }
  function brandId() {
    var L = (typeof window !== 'undefined' && window.FRKL_LIVE) || {};
    return L.brandId || L.brand_id || (window.OI_ASK && window.OI_ASK.brand_id) || null;
  }

  // Events raised before the brand id resolves are held, not dropped: the first page_view of
  // a session fires while membership is still in flight, and that is exactly the one that
  // marks the start of a visit.
  var pending = [];
  var MAX_PENDING = 40;

  function send(row) {
    var sb = client();
    try {
      sb.from('product_events').insert(row).then(function () {}, function () {});
    } catch (e) { /* analytics must never break a screen */ }
  }

  function flush() {
    if (!pending.length) return;
    var b = brandId(), sb = client();
    if (!b || !sb) return;
    var batch = pending.splice(0, pending.length);
    batch.forEach(function (r) { r.brand_id = b; send(r); });
  }

  function track(name, props, surface) {
    try {
      if (!EVENTS[name]) { if (window.console) console.warn('[track] unknown event', name); return; }
      var row = {
        brand_id: brandId(),
        user_id: (window.FRKL_LIVE && window.FRKL_LIVE.session && window.FRKL_LIVE.session.user
                  && window.FRKL_LIVE.session.user.id) || null,
        name: name,
        surface: surface || (window.__oiDest || null),
        props: props && typeof props === 'object' ? props : {},
        session_id: sid
      };
      if (!row.brand_id || !client()) {
        if (pending.length < MAX_PENDING) pending.push(row);
        return;
      }
      send(row);
    } catch (e) { /* never throw out of a track call */ }
  }

  if (typeof window !== 'undefined') {
    window.greta = window.greta || {};
    window.greta.track = track;
    // The brand id arrives asynchronously; both of these fire once it does.
    window.addEventListener('frkl-brand-ready', flush);
    window.addEventListener('frkl-data-updated', flush);
    var tries = 0, iv = setInterval(function () {
      tries++;
      if (brandId() && client()) { clearInterval(iv); flush(); }
      else if (tries > 60) clearInterval(iv);
    }, 500);
  }
})();

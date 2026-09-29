/*
 * greta-headline-data.js — builds window.GRETA_HEADLINE for the V3 Today screen.
 * Plain global-scope JS (no build). Load AFTER greta-data-loader.js in greta-dashboard.html.
 *
 * ONE PROFIT NUMBER (Phase 2 decision 1, approved 2026-09-23):
 *   the headline is PROFIT AFTER ADS = vw_brand_headline.cm_after_marketing_30d.
 *   Profit before ads, ad spend and sales come from the same row and render as the
 *   secondary line — both bases on screen, one big number. Nothing is recomputed here:
 *   every figure is read from the view (FRONTEND-SOT-SPEC render-the-view rule).
 *
 * PACING: vw_brand_headline.cam_target_monthly is the after-ads target, stored since
 *   migration 0169. Nothing is worked out here any more — the browser used to compute
 *   (quarter product target − quarter spend cap) ÷ 3 itself, which put the basis
 *   arithmetic somewhere no other reader could see it. cam_target_source says whether
 *   the owner confirmed that figure or it was converted off the spend cap, and Today
 *   only calls it estimated in the second case. Greta abstains rather than guess: no
 *   after-ads target → no pace, and Today says why.
 *
 * ONE READ: vw_brand_today (0184) carries the headline, the readiness gate, the connection
 * count and the top four actions in a single row. It replaced four separate requests.
 * Publishes: window.GRETA_HEADLINE + 'greta-headline-updated'. Never throws.
 */
(function () {
  'use strict';

  function sbClient() {
    if (typeof window === 'undefined') return null;
    return window.sb || (window.FRKL_LIVE && window.FRKL_LIVE.sb) || null;
  }
  function brandId() {
    var L = (typeof window !== 'undefined' && window.FRKL_LIVE) || {};
    return L.brandId || L.brand_id || (window.OI_ASK && window.OI_ASK.brand_id) || null;
  }
  function num(x) { return x == null ? null : Number(x); }

  // Swallowing a failed read is right — one slow query must not blank the screen — but it cannot
  // be the end of the story. Three failures found on 2026-09-29 had been running for MONTHS with
  // no visible symptom: the cost panel 404ing, the engine's realized-COGS path no-op'ing, and
  // Meta's token expired for ten days. All three were found by reading edge logs, not by using the
  // product. A failure nobody learns about is indistinguishable from a feature never built.
  //
  // So the read still degrades quietly for the operator, and quietly TELLS US. Deduped per session
  // per source, so one broken panel is one row per session rather than one per render, and every
  // path is wrapped — reporting an error must never itself throw.
  var reported = {};
  function reportFailure(source, kind, detail) {
    try {
      if (reported[source]) return;
      reported[source] = 1;
      var sb = sbClient(), b = brandId();
      if (!sb || !b) return;
      sb.from('client_error_log').insert({
        brand_id: b, kind: kind, source: String(source).slice(0, 120),
        detail: detail ? String(detail).slice(0, 500) : null,
        screen: 'today'
      }).then(function () {}, function () {});
    } catch (e) { /* never let telemetry break the screen */ }
  }
  if (typeof window !== 'undefined') window.FRKL_REPORT_FAILURE = reportFailure;

  async function safeQ(q, ms, def, source) {
    var label = source || 'unknown';
    try {
      return await Promise.race([
        Promise.resolve(q).then(function (r) {
          if (r && r.error) { reportFailure(label, 'read_failed', r.error.message || r.error.code); return def; }
          return (r && r.data != null) ? r.data : def;
        }).catch(function (e) { reportFailure(label, 'read_failed', e && e.message); return def; }),
        new Promise(function (res) {
          setTimeout(function () { reportFailure(label, 'read_timeout', 'no response in ' + ms + 'ms'); res(def); }, ms);
        })
      ]);
    } catch (e) { reportFailure(label, 'read_failed', e && e.message); return def; }
  }

  async function build() {
    var sb = sbClient(), b = brandId();
    if (!sb || !b) return;
    // ONE row, not four requests (0184): vw_brand_today carries the headline, the readiness gate,
    // the connection count and the top four actions together.
    //
    // FAST PATH (0200). The composed view costs ~2,054ms server-side — its own parts only total
    // 490ms, the rest is four joins and two laterals re-evaluated per read — and through PostgREST
    // it has been seen at 9.8s and once 35.9s. Cached, the same row is a single-key lookup at 9ms.
    // An 18-second first paint disqualifies the product however it looks, so Today reads the cache.
    var rows = null, asOf = null;
    var cached = await safeQ(
      sb.from('cache_brand_today').select('payload,refreshed_at').eq('brand_id', b).limit(1),
      8000, null, 'cache_brand_today');
    var c0 = cached && cached[0];
    if (c0 && c0.payload) {
      var age = Date.now() - new Date(c0.refreshed_at).getTime();
      // 26h, so a single missed cron still serves rather than falling back to the slow path
      if (age >= 0 && age < 26 * 3600 * 1000) { rows = [c0.payload]; asOf = c0.refreshed_at; }
    }

    // LIVE FALLBACK. A brand that has just connected has no cached row yet, and a cron can fail;
    // either way the screen must be correct, just slower. First attempt is generous on purpose —
    // a 12s cap was measured timing out and the retry pushed first paint to ~50s, so giving up
    // early cost far more than waiting.
    for (var attempt = 0; attempt < 3 && !rows; attempt++) {
      if (attempt) await new Promise(function (r) { setTimeout(r, 1500 * attempt); });
      rows = await safeQ(sb.from('vw_brand_today').select('*').eq('brand_id', b).limit(1), 22000 + attempt * 9000, null, 'vw_brand_today');
    }
    var h = (rows && rows[0]) || null;
    // Say so rather than sit on an em-dash forever: Today reads this to explain itself.
    if (!h) {
      window.GRETA_HEADLINE_ERROR = 'slow';
      try { window.dispatchEvent(new CustomEvent('greta-headline-updated')); } catch (e) {}
      return;
    }
    window.GRETA_HEADLINE_ERROR = null;
    var rd = h;                                   // readiness fields are on the same row now
    var acts = Array.isArray(h.top_actions) ? h.top_actions : [];

    var out = {
      period_start: h.period_start, period_end: h.period_end,
      cm_basis: h.cm_basis, plan_status: h.plan_status,
      net_revenue_30d: num(h.net_revenue_30d),
      paid_spend_30d: num(h.paid_spend_30d),
      product_contribution_30d: num(h.product_contribution_30d),
      cm_after_marketing_30d: num(h.cm_after_marketing_30d),
      cam_target_monthly: num(h.cam_target_monthly),
      cam_target_source: h.cam_target_source || null,
      pace_pct_after_ads: num(h.pace_pct_after_ads),
      // Kept as the screen's own word for it: "we worked this out, you did not agree to it".
      target_is_derived: h.cam_target_source === 'converted_from_product_basis',
      open_actions: h.open_actions,
      // What the queue will actually render (0195). open_actions counts every open row; the board
      // filters out descriptive/unfalsifiable ones, so "See all 47" used to open a list of 20.
      board_actions: h.board_actions,
      can_show_cm: rd ? rd.can_show_cm !== false : true,
      cm_source: rd ? rd.cm_source : null,
      // What the profit number is actually built on (0192). cm_source does NOT answer this:
      // 'fit_engine' means the engine derived margin from the CONFIGURED gross margin, not from
      // the brand's own costs, and Today used to call that "Measured". cogs_basis is 'measured'
      // only when realized COGS covers >=80% of revenue AND those costs include freight or duty.
      cogs_basis: h.cogs_basis || 'blended',
      cogs_coverage_90d: num(h.cogs_coverage_90d),
      cogs_landed_complete: h.cogs_landed_complete === true,
      cogs_realized_margin_pct: num(h.cogs_realized_margin_pct),
      cogs_gap_reason: h.cogs_gap_reason || null,
      // How hard the operator can lean on the number, on one ladder (0196):
      // direct > likely > probably > possible > outside chance. Stale ad spend and unmeasured
      // costs each pull it down a rung; pace_is_reliable is false when the spend that has not
      // come through could swallow half the claimed gap to goal.
      trust_level: h.trust_level || 'probably',
      spend_is_stale: h.spend_is_stale === true,
      spend_stale_days: num(h.spend_stale_days),
      unreported_spend: num(h.unreported_spend),
      stale_feeds: h.stale_feeds || null,
      pace_is_reliable: h.pace_is_reliable !== false,
      gate_message: rd ? rd.gate_message : null,
      // First-run state: what is still needed before Greta can answer properly.
      setup: {
        connected: Number(h.active_connections) || 0,
        connected_total: 5,
        has_revenue: rd ? rd.has_revenue !== false : false,
        has_economics: rd ? rd.has_economics === true : false,
        goal_confirmed: h.plan_status === 'confirmed',
        has_action: !!acts[0]
      },
      top_action: acts[0] || null,
      next_actions: acts.slice(1, 4),
      // when the cached row was built, so the screen can say how fresh it is rather than imply now
      data_as_of: asOf,
      fetched_at: new Date().toISOString()
    };
    window.GRETA_HEADLINE = out;
    try { window.dispatchEvent(new CustomEvent('greta-headline-updated')); } catch (e) {}

    // Why the headline moved (edge action today_why → fn_today_v2). Fetched AFTER the
    // headline is published, never before: the function takes ~16s on a live brand and
    // the profit number must not wait on the paragraph. If the request fails, Today
    // simply renders without it.
    try {
      var A = window.OI_ASK;
      if (A && A.endpoint && A.getJwt) {
        var jwt = await A.getJwt();
        var wr = await fetch(A.endpoint.replace(/\/functions\/v1\/[^/]*$/, '/functions/v1') + '/marketing-os', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
          body: JSON.stringify({ action: 'today_why', brandId: b, brand_id: b })
        });
        if (wr.ok) {
          var wj = await wr.json();
          if (wj && wj.why) {
            out.why = wj.why;
            out.why_period = wj.period || null;
            window.GRETA_HEADLINE = Object.assign({}, out);
            try { window.dispatchEvent(new CustomEvent('greta-headline-updated')); } catch (e) {}
          }
        }
      }
    } catch (e) { /* the paragraph is optional; never block the headline on it */ }

    try { window.dispatchEvent(new CustomEvent('greta-headline-updated')); } catch (e) {}
    if (window.console) console.info('[headline-data] GRETA_HEADLINE built · after-ads £' + out.cm_after_marketing_30d + (out.target_is_derived ? ' · target derived' : ''));
  }

  function boot() { build().catch(function () {}); }
  // The session and brand id arrive asynchronously (greta-data-loader resolves the
  // membership after auth), so a fixed delay races it and exits silently — which is
  // exactly what happened live on 2026-09-25. Poll for the brand id like the overview
  // loader does, then build; keep listening for refreshes afterwards.
  if (typeof window !== 'undefined') {
    // 'frkl-brand-ready' fires the moment the brand is known, BEFORE the loader's ~24-request
    // bulk refresh. Booting there rather than waiting for the 500ms poll tick (or for the whole
    // refresh to finish) is what keeps Today's read out of the queue behind it.
    window.addEventListener('frkl-brand-ready', boot);
    window.addEventListener('frkl-data-updated', boot);
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      var ready = window.FRKL_LIVE && window.FRKL_LIVE.brandId && window.FRKL_LIVE.sb;
      if (ready || tries > 60) { clearInterval(iv); if (ready) boot(); }
    }, 500);
  }
})();

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
 * PACING: vw_brand_headline.cm_target_monthly follows the goal's stored basis
 *   (cm_basis). When the goal is stored on the product-contribution basis we cannot
 *   pace the after-ads number against it, so cam_target_monthly is derived as
 *   (quarter product target − quarter spend cap) ÷ 3 and flagged target_is_derived.
 *   When the goal is re-saved on the after-ads basis this derivation drops out.
 *   Greta abstains rather than guess: no spend cap → no pace, and Today says why.
 *
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

  async function safeQ(q, ms, def) {
    try {
      return await Promise.race([
        Promise.resolve(q).then(function (r) { return (r && !r.error && r.data != null) ? r.data : def; }).catch(function () { return def; }),
        new Promise(function (res) { setTimeout(function () { res(def); }, ms); })
      ]);
    } catch (e) { return def; }
  }

  async function build() {
    var sb = sbClient(), b = brandId();
    if (!sb || !b) return;
    var today = new Date().toISOString().slice(0, 10);

    var res = await Promise.all([
      safeQ(sb.from('vw_brand_headline').select('period_start, period_end, cm_basis, plan_status, cm_target_quarter, cm_target_monthly, net_revenue_30d, paid_spend_30d, product_contribution_30d, cm_after_marketing_30d, pace_pct_of_plan, open_actions').eq('brand_id', b).limit(1), 10000, null),
      safeQ(sb.from('vw_brand_readiness').select('has_revenue, has_economics, can_show_cm, cm_source, gate_message, can_rank_actions').eq('brand_id', b).limit(1), 8000, null),
      safeQ(sb.from('vw_brand_action_board').select('external_id, description, step1, priority, category, cm_gbp').eq('brand_id', b).order('cm_gbp', { ascending: false, nullsFirst: false }).limit(4), 10000, []),
      safeQ(sb.from('mos_business_goal').select('spend_cap, contribution_margin_target, cm_basis, confirmed, period_start, period_end').eq('brand_id', b).lte('period_start', today).gte('period_end', today).order('created_at', { ascending: false }).limit(1), 8000, null),
      safeQ(sb.from('connections').select('provider, status').eq('brand_id', b), 8000, [])
    ]);

    var h = (res[0] && res[0][0]) || null;
    var rd = (res[1] && res[1][0]) || null;
    var acts = res[2] || [];
    var goal = (res[3] && res[3][0]) || null;
    var conns = res[4] || [];
    if (!h) return;

    // The target on the headline's own basis, or derived from the stored plan.
    var camTarget = null, derived = false;
    if (h.cm_basis === 'after_marketing') {
      camTarget = num(h.cm_target_monthly);
    } else if (goal && goal.contribution_margin_target != null && goal.spend_cap != null) {
      var q = Number(goal.contribution_margin_target) - Number(goal.spend_cap);
      if (isFinite(q)) { camTarget = Math.round(q / 3); derived = true; }
    }

    var out = {
      period_start: h.period_start, period_end: h.period_end,
      cm_basis: h.cm_basis, plan_status: h.plan_status,
      net_revenue_30d: num(h.net_revenue_30d),
      paid_spend_30d: num(h.paid_spend_30d),
      product_contribution_30d: num(h.product_contribution_30d),
      cm_after_marketing_30d: num(h.cm_after_marketing_30d),
      cam_target_monthly: camTarget,
      target_is_derived: derived,
      open_actions: h.open_actions,
      can_show_cm: rd ? rd.can_show_cm !== false : true,
      cm_source: rd ? rd.cm_source : null,
      gate_message: rd ? rd.gate_message : null,
      // First-run state: what is still needed before Greta can answer properly.
      setup: {
        connected: conns.filter(function (c) { return c.status === 'active'; }).length,
        connected_total: 5,
        has_revenue: rd ? rd.has_revenue !== false : false,
        has_economics: rd ? rd.has_economics === true : false,
        goal_confirmed: h.plan_status === 'confirmed',
        has_action: !!acts[0]
      },
      top_action: acts[0] || null,
      next_actions: acts.slice(1, 4),
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
    if (window.console) console.info('[headline-data] GRETA_HEADLINE built · after-ads £' + out.cm_after_marketing_30d + (derived ? ' · target derived' : ''));
  }

  function boot() { build().catch(function () {}); }
  // The session and brand id arrive asynchronously (greta-data-loader resolves the
  // membership after auth), so a fixed delay races it and exits silently — which is
  // exactly what happened live on 2026-09-25. Poll for the brand id like the overview
  // loader does, then build; keep listening for refreshes afterwards.
  if (typeof window !== 'undefined') {
    window.addEventListener('frkl-data-updated', boot);
    var tries = 0;
    var iv = setInterval(function () {
      tries++;
      var ready = window.FRKL_LIVE && window.FRKL_LIVE.brandId && window.FRKL_LIVE.sb;
      if (ready || tries > 60) { clearInterval(iv); if (ready) boot(); }
    }, 500);
  }
})();

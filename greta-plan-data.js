/*
 * greta-plan-data.js — Plan/target setup data layer. Load AFTER greta-data-loader.js.
 * Exposes window.FRKL_PLAN = { ready, readiness[], goal, config, forecast, period, refresh(), derive(amt,basis), confirm(derived), saveEconomics(fields) }.
 *   readiness  ← vw_brand_plan_readiness (the completeness gate)
 *   forecast   ← vw_forecast_vs_goal (calendar-aware forecast for the period vs goal + the gap; SOT view, not recomputed)
 *   spendCurve ← vw_brand_spend_curve (+ _points): the k curve, its 95% band and `verdict`
 *   channels   ← vw_channel_scoreboard (per-channel normalized iROAS vs break-even/target CAC, CM-first focus rank)
 *   derive()   ← rpc fn_derive_business_goal (preview targets from a CAM or revenue goal; 'auto' = run-rate)
 *   confirm()  ← upserts mos_business_goal (confirmed=true). USER-initiated only (a button), never automatic.
 * Reuses FRKL_LIVE.sb; recomputes on 'frkl-data-updated'; fires 'frkl-plan-updated'; never throws.
 */
(function () {
  'use strict';
  function quarter() {
    var d = new Date(), qi = Math.floor(d.getUTCMonth() / 3);
    var s = new Date(Date.UTC(d.getUTCFullYear(), qi * 3, 1));
    var e = new Date(Date.UTC(d.getUTCFullYear(), qi * 3 + 3, 0));
    return { start: s.toISOString().slice(0, 10), end: e.toISOString().slice(0, 10) };
  }
  var PERIOD = quarter();
  function sb() { return window.FRKL_LIVE && window.FRKL_LIVE.sb; }
  function bid() { return window.FRKL_LIVE && window.FRKL_LIVE.brandId; }

  function withTimeout(pr, ms) {
    return Promise.race([
      Promise.resolve(pr).catch(function (e) { return { data: null, error: e }; }),
      new Promise(function (res) { setTimeout(function () { res({ data: null, error: { message: 'timeout' } }); }, ms); })
    ]);
  }
  async function refresh() {
    var s = sb(), b = bid(); if (!s || !b) return;
    // Resilient: each query is independent + time-boxed, so one slow/failing view can't
    // stall or wipe the whole plan feed. Core (goal + config + readiness) flips `ready` so the
    // rail and Plan tab render; the heavy scoreboard/forecast views fill in afterwards.
    var g = await withTimeout(s.from('mos_business_goal').select('*').eq('brand_id', b).lte('period_start', PERIOD.end).gte('period_end', PERIOD.start).order('created_at', { ascending: false }).limit(1), 8000);
    if (g && g.data) window.FRKL_PLAN.goal = g.data[0] || null;
    var cfg = await withTimeout(s.from('brand_config').select('gross_margin, variable_costs, fixed_costs_monthly, inventory_days, discount_rate_annual').eq('brand_id', b).limit(1), 8000);
    if (cfg && cfg.data) window.FRKL_PLAN.config = cfg.data[0] || null;
    var rd = await withTimeout(s.from('vw_brand_plan_readiness').select('section,item,status,detail,blocks_targets,ord').eq('brand_id', b).order('ord', { ascending: true }), 8000);
    if (rd && rd.data) window.FRKL_PLAN.readiness = rd.data || [];
    window.FRKL_PLAN.ready = true;
    window.dispatchEvent(new CustomEvent('frkl-plan-updated'));
    var fc = await withTimeout(s.from('vw_forecast_vs_goal').select('*').eq('brand_id', b).limit(1), 12000);
    if (fc && fc.data) window.FRKL_PLAN.forecast = fc.data[0] || null;
    var ch = await withTimeout(s.from('vw_channel_scoreboard').select('channel_type,spend_30d,avg_iroas,phi,break_even_iroas,target_marginal_iroas,break_even_reported_roas,target_reported_roas,target_is_ltv_adjusted,ltv_share,ltv_status,marginal_cac,max_cac_first_order,status,action,focus_rank,phi_is_assumed,planned_spend,spend_pace_pct_of_plan,plan_target_iroas,plan_target_cac,plan_confirmed').eq('brand_id', b).order('focus_rank', { ascending: true }), 12000);
    if (ch && ch.data) window.FRKL_PLAN.channels = ch.data || [];
    var cm = await withTimeout(s.from('vw_channel_revenue_mix').select('window_label,channel,orders,net_revenue,aov,new_orders,returning_orders,new_revenue,returning_revenue,orders_with_discount,pct_of_revenue').eq('brand_id', b), 10000);
    if (cm && cm.data) window.FRKL_PLAN.channelMix = cm.data || [];
    var hh = await withTimeout(s.from('vw_brand_channel_health').select('*').eq('brand_id', b).limit(1), 10000);
    if (hh && hh.data) window.FRKL_PLAN.channelHealth = hh.data[0] || null;
    // Spend curve (the k curve). Two feeds on purpose: the POINTS are measurement and stay
    // plottable even when the fit is not identified; the CURVE is inference and carries its own
    // band + verdict. A surface must honour `verdict` - see 0141/0142.
    var sc = await withTimeout(s.from('vw_brand_spend_curve').select('*').eq('brand_id', b).limit(1), 10000);
    if (sc && sc.data) window.FRKL_PLAN.spendCurve = sc.data[0] || null;
    var sp = await withTimeout(s.from('vw_brand_spend_curve_points')
      .select('month,spend,cac,new_customers,cm_per_order,cac_above_contribution,recency_rank')
      .eq('brand_id', b).order('month', { ascending: true }), 10000);
    if (sp && sp.data) window.FRKL_PLAN.spendCurvePoints = sp.data || [];

    // The three reads that explain the curve rather than just drawing it (0145). Live
    // since September 2026 with no consumer until the V3 Growth plan mounted them:
    // why it bends (auction vs conversion), how the read has changed, what would move it.
    var cd = await withTimeout(s.from('vw_brand_curve_decomposition').select('*').eq('brand_id', b).limit(1), 10000);
    if (cd && cd.data) window.FRKL_PLAN.curveDecomposition = cd.data[0] || null;
    var ch2 = await withTimeout(s.from('vw_brand_curve_history').select('*').eq('brand_id', b).order('month', { ascending: true }), 10000);
    if (ch2 && ch2.data) window.FRKL_PLAN.curveHistory = ch2.data || [];
    var cl = await withTimeout(s.from('vw_brand_curve_levers').select('*').eq('brand_id', b), 10000);
    if (cl && cl.data) window.FRKL_PLAN.curveLevers = cl.data || [];

    window.dispatchEvent(new CustomEvent('frkl-plan-updated'));
  }
  async function derive(amount, basis) {
    var s = sb(), b = bid(); if (!s || !b) return null;
    try {
      var r = await s.rpc('fn_derive_business_goal', { p_brand: b, p_start: PERIOD.start, p_end: PERIOD.end, p_goal: (amount == null || amount === '') ? null : Number(amount), p_basis: basis || 'auto' });
      if (r.error) throw r.error;
      return (r.data && r.data[0]) || (Array.isArray(r.data) ? null : r.data) || null;
    } catch (e) { if (window.console) console.warn('[plan] derive failed', e); return null; }
  }
  async function confirm(d) {
    var s = sb(), b = bid(); if (!s || !b || !d) return { ok: false, error: 'no session' };
    var row = {
      brand_id: b, period_start: PERIOD.start, period_end: PERIOD.end,
      revenue_target: d.revenue_target, contribution_margin_target: d.product_cm_target, gross_margin_target: d.gross_margin_target,
      spend_cap: d.spend_cap, mer_target: d.mer_target, new_customer_target: d.new_customer_target, returning_revenue_target: d.returning_revenue_target,
      cm_basis: 'product_contribution', confirmed: true, status: 'active',
      notes: 'Confirmed ' + new Date().toISOString().slice(0, 10) + ' · CAM (after-marketing) target £' + Math.round(d.cam_target)
    };
    try {
      var existing = window.FRKL_PLAN.goal, res;
      if (existing && existing.id) res = await s.from('mos_business_goal').update(row).eq('id', existing.id);
      else res = await s.from('mos_business_goal').insert(row);
      if (res.error) throw res.error;
      await refresh();
      return { ok: true };
    } catch (e) { if (window.console) console.warn('[plan] confirm failed', e); return { ok: false, error: String((e && e.message) || e) }; }
  }
  // ONE WRITER (Phase 2 decision 5, 2026-09-25): costs are saved through the
  // save-brand-config edge function, the same route Settings uses, instead of this
  // panel updating brand_config straight from the browser. The function validates the
  // fields, checks brand membership and applies PATCH semantics (omitted = unchanged).
  async function saveEconomics(fields) {
    var b = bid(); if (!b || !fields) return { ok: false, error: 'no session' };
    var ASK = (typeof window !== 'undefined' && window.OI_ASK) || null;
    if (!ASK || !ASK.endpoint || !ASK.getJwt) return { ok: false, error: 'not signed in' };
    var body = { brand_id: b };
    if (fields.gross_margin != null && fields.gross_margin !== '') body.gross_margin = Number(fields.gross_margin);
    if (fields.fixed_costs_monthly != null && fields.fixed_costs_monthly !== '') body.fixed_costs_monthly = Number(fields.fixed_costs_monthly);
    if (fields.variable_costs && typeof fields.variable_costs === 'object') body.variable_costs = fields.variable_costs;
    if (Object.keys(body).length < 2) return { ok: false, error: 'nothing to save' };
    try {
      var jwt = await ASK.getJwt();
      var base = String(ASK.endpoint).replace(/\/functions\/v1\/[^/]*$/, '/functions/v1');
      var r = await fetch(base + '/save-brand-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + jwt },
        body: JSON.stringify(body)
      });
      var out = await r.json().catch(function () { return {}; });
      if (!r.ok) throw new Error(out.error || ('save failed (' + r.status + ')'));
      await refresh();
      return { ok: true };
    } catch (e) { if (window.console) console.warn('[plan] saveEconomics failed', e); return { ok: false, error: String((e && e.message) || e) }; }
  }
  async function deriveChannelPlan(confirm) {
    var s = sb(), b = bid(); if (!s || !b) return { ok: false, error: 'no session' };
    try {
      var r = await s.rpc('fn_derive_channel_plan', { p_brand: b, p_start: PERIOD.start, p_end: PERIOD.end, p_commit: true, p_confirm: !!confirm });
      if (r.error) throw r.error;
      await refresh();
      return { ok: true, data: r.data };
    } catch (e) { if (window.console) console.warn('[plan] deriveChannelPlan failed', e); return { ok: false, error: String((e && e.message) || e) }; }
  }
  async function saveBands(f) {
    var s = sb(), b = bid(); if (!s || !b || !f) return { ok: false, error: 'no session' };
    var num = function (v) { return (v == null || v === '') ? null : Number(v); };
    try {
      var r = await s.rpc('fn_set_channel_bands', { p_brand: b, p_ret_low: num(f.retLow), p_ret_high: num(f.retHigh), p_email_low: num(f.emailLow), p_email_high: num(f.emailHigh) });
      if (r.error) throw r.error;
      await refresh();
      return { ok: true };
    } catch (e) { if (window.console) console.warn('[plan] saveBands failed', e); return { ok: false, error: String((e && e.message) || e) }; }
  }
  window.FRKL_PLAN = { curveDecomposition: null, curveHistory: [], curveLevers: [], ready: false, readiness: [], goal: null, config: null, forecast: null, channels: [], channelMix: [], channelHealth: null, spendCurve: null, spendCurvePoints: [], period: PERIOD, refresh: refresh, derive: derive, confirm: confirm, saveEconomics: saveEconomics, deriveChannelPlan: deriveChannelPlan, saveBands: saveBands };
  window.addEventListener('frkl-data-updated', refresh);
  var t = 0, iv = setInterval(function () { t++; if ((sb() && bid()) || t > 60) { clearInterval(iv); refresh(); } }, 500);
})();

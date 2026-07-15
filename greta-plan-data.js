/*
 * greta-plan-data.js — Plan/target setup data layer. Load AFTER greta-data-loader.js.
 * Exposes window.FRKL_PLAN = { ready, readiness[], goal, config, forecast, period, refresh(), derive(amt,basis), confirm(derived), saveEconomics(fields) }.
 *   readiness  ← vw_brand_plan_readiness (the completeness gate)
 *   forecast   ← vw_forecast_vs_goal (calendar-aware forecast for the period vs goal + the gap; SOT view, not recomputed)
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

  async function refresh() {
    var s = sb(), b = bid(); if (!s || !b) return;
    try {
      var rd = await s.from('vw_brand_plan_readiness').select('section,item,status,detail,blocks_targets,ord').eq('brand_id', b).order('ord', { ascending: true });
      var g = await s.from('mos_business_goal').select('*').eq('brand_id', b).lte('period_start', PERIOD.end).gte('period_end', PERIOD.start).order('created_at', { ascending: false }).limit(1);
      var cfg = await s.from('brand_config').select('gross_margin, variable_costs, fixed_costs_monthly, inventory_days, discount_rate_annual').eq('brand_id', b).limit(1);
      var fc = await s.from('vw_forecast_vs_goal').select('*').eq('brand_id', b).limit(1);
      var ch = await s.from('vw_channel_scoreboard').select('channel_type,spend_30d,avg_iroas,break_even_iroas,target_marginal_iroas,marginal_cac,max_cac_first_order,status,action,focus_rank,phi_is_assumed,planned_spend,spend_pace_pct_of_plan,plan_target_iroas,plan_target_cac,plan_confirmed').eq('brand_id', b).order('focus_rank', { ascending: true });
      window.FRKL_PLAN.readiness = (rd && rd.data) || [];
      window.FRKL_PLAN.goal = (g && g.data && g.data[0]) || null;
      window.FRKL_PLAN.config = (cfg && cfg.data && cfg.data[0]) || null;
      window.FRKL_PLAN.forecast = (fc && fc.data && fc.data[0]) || null;
      window.FRKL_PLAN.channels = (ch && ch.data) || [];
      window.FRKL_PLAN.ready = true;
      window.dispatchEvent(new CustomEvent('frkl-plan-updated'));
    } catch (e) { if (window.console) console.warn('[plan] refresh failed', e); }
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
  async function saveEconomics(fields) {
    var s = sb(), b = bid(); if (!s || !b || !fields) return { ok: false, error: 'no session' };
    var patch = {};
    if (fields.gross_margin != null && fields.gross_margin !== '') patch.gross_margin = Number(fields.gross_margin);
    if (fields.fixed_costs_monthly != null && fields.fixed_costs_monthly !== '') patch.fixed_costs_monthly = Number(fields.fixed_costs_monthly);
    if (fields.variable_costs && typeof fields.variable_costs === 'object') patch.variable_costs = fields.variable_costs;
    if (!Object.keys(patch).length) return { ok: false, error: 'nothing to save' };
    try {
      var res = await s.from('brand_config').update(patch).eq('brand_id', b);
      if (res.error) throw res.error;
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
  window.FRKL_PLAN = { ready: false, readiness: [], goal: null, config: null, forecast: null, channels: [], period: PERIOD, refresh: refresh, derive: derive, confirm: confirm, saveEconomics: saveEconomics, deriveChannelPlan: deriveChannelPlan };
  window.addEventListener('frkl-data-updated', refresh);
  var t = 0, iv = setInterval(function () { t++; if ((sb() && bid()) || t > 60) { clearInterval(iv); refresh(); } }, 500);
})();

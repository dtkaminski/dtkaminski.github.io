/*
 * greta-overview-data.js — builds window.FRKL_OVERVIEW[timeframe] for the Overview tiers.
 * Plain global-scope JS (no build). Load AFTER greta-data-loader.js in greta-dashboard.html.
 *
 * ── CANONICAL METRIC SPINE (Greta-Metrics-Hierarchy-Review.md §8) ──
 *   L1 revenue = Shopify truth; Product CM = revenue × cm_ratio; CAM = Product CM − ad spend;
 *   MER = revenue/spend; CVR = orders/sessions; normalized iROAS = reported × φ;
 *   incremental revenue = spend × iROAS; paid contribution = Σ(incremental×cm_ratio − spend);
 *   break-even iROAS = 1/cm_ratio. New+returning revenue == L1 revenue (split applied to L1).
 * Insights are diagnosis-derived from vw_brand_action_board (cm_gbp), same source as Today/Actions.
 *
 * ROBUSTNESS: every supplemental query is individually timed (no Promise.all fail-all/hang); the
 * business tier always builds from the loader's FRKL_DATA even if all supplementals are empty, so
 * FRKL_OVERVIEW always populates. Reuses FRKL_LIVE.sb; recomputes on 'frkl-data-updated'; never throws.
 */
(function () {
  'use strict';
  var TF = { daily: 1, weekly: 7, monthly: 30, quarterly: 90, yearly: 365 };
  var LBL = {
    daily: ['Today', 'vs yesterday'], weekly: ['Last 7 days', 'vs previous 7 days'],
    monthly: ['Last 30 days', 'vs previous 30 days'], quarterly: ['Last 90 days', 'vs previous 90 days'],
    yearly: ['Last 365 days', 'vs previous 365 days']
  };
  var CVR_BENCH = 1.5;
  var TIER_CATS = { business: ['site', 'finance', 'ops', 'product'], customer: ['retention', 'cx'], channel: ['paid', 'creative'] };

  var n = function (x) { return Number(x || 0); };
  var f0 = function (x) { return Math.round(x); };
  var gbp = function (x) { return '£' + f0(x).toLocaleString('en-GB'); };
  var cmk = function (v) { return '£' + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : String(f0(v))); };
  function trim(s, m) { s = String(s || ''); return s.length > m ? s.slice(0, m - 1) + '…' : s; }
  function maxDate(a, k) { var m = null, i; for (i = 0; i < (a || []).length; i++) { var d = a[i][k]; if (d && (!m || d > m)) m = d; } return m; }
  function addDays(iso, d) { var t = new Date(iso + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10); }
  function sumR(a, dk, s, e, vf) { var t = 0, i; for (i = 0; i < (a || []).length; i++) { var d = a[i][dk]; if (d >= s && d <= e) t += vf(a[i]); } return t; }
  function delta(cur, prev) { if (prev == null || prev === 0) return null; return (cur - prev) / prev * 100; }
  function win(end, days) { return { cs: addDays(end, -(days - 1)), ce: end, ps: addDays(end, -(2 * days - 1)), pe: addDays(end, -days) }; }
  function ragTrend(d) { if (d == null) return 'a'; return d >= -2 ? 'g' : d >= -15 ? 'a' : 'r'; }
  function tile(k, v, fmt, d, cmp, rag, tgt) { return { k: k, v: v, fmt: fmt, d: d, cmp: cmp, rag: rag, tgt: tgt }; }

  // Individually-timed query: resolves to data or the default within ms; never rejects, never hangs.
  function safeQ(q, ms, def) {
    return Promise.race([
      Promise.resolve(q).then(function (r) { return (r && !r.error && r.data != null) ? r.data : def; }).catch(function () { return def; }),
      new Promise(function (res) { setTimeout(function () { res(def); }, ms); })
    ]);
  }

  async function fetchSupp(sb, brandId) {
    var cutoff = new Date(Date.now() - 400 * 864e5).toISOString().slice(0, 10);
    var Q = 12000;
    var r = await Promise.all([
      safeQ(sb.from('vw_brand_cm').select('cm_ratio, aov').eq('brand_id', brandId).limit(1), Q, null),
      safeQ(sb.from('vw_brand_customer_economics_30d').select('new_customers, ncac, amer').eq('brand_id', brandId).limit(1), Q, null),
      safeQ(sb.from('vw_channel_iroas').select('channel_type, spend_30d, reported_roas, normalized_iroas, phi_applied').eq('brand_id', brandId), Q, []),
      safeQ(sb.from('vw_channel_iroas_targets').select('channel_type, target_true_iroas').eq('brand_id', brandId), Q, []),
      safeQ(sb.from('vw_daily_new_vs_returning').select('order_date, customer_type, orders, net_revenue').eq('brand_id', brandId).gte('order_date', cutoff).order('order_date', { ascending: false }).limit(1000), Q, []),
      safeQ(sb.from('v_tenant_shopify_lineitems_daily').select('day, product_title, units, revenue').eq('brand_id', brandId).gte('day', cutoff).order('day', { ascending: false }).limit(1000), Q, []),
      safeQ(sb.from('vw_brand_action_board').select('external_id, description, step1, priority, category, cm_gbp').eq('brand_id', brandId).order('cm_gbp', { ascending: false, nullsFirst: false }).limit(30), Q, []),
      safeQ(sb.from('vw_channel_effect').select('channel_type, family, spend_30d, attributed_rev_30d, phi, incremental_rev_30d, cost_30d, contribution_30d, drives, rev_per_send').eq('brand_id', brandId), Q, []),
      safeQ(sb.from('vw_channel_optimum').select('channel_type, avg_iroas, marginal_iroas, target_marginal_iroas, break_even_iroas, marginal_cm_per_pound, status').eq('brand_id', brandId), Q, []),
      safeQ(sb.from('vw_email_breakdown').select('total_rev, total_orders, total_sends, campaign_rev, campaign_orders, flow_rev, flow_orders, rev_per_1k_sent').eq('brand_id', brandId).limit(1), Q, null),
      safeQ(sb.from('mos_business_goal').select('revenue_target, contribution_margin_target, spend_cap, period_start, period_end, confirmed').eq('brand_id', brandId).lte('period_start', new Date().toISOString().slice(0,10)).gte('period_end', new Date().toISOString().slice(0,10)).order('created_at', { ascending: false }).limit(1), Q, null),
      safeQ(sb.from('daily_forecast').select('day, revenue, spend, cm').eq('brand_id', brandId).order('day', { ascending: true }), Q, []),
      safeQ(sb.from('brand_config').select('fixed_costs_monthly, gross_margin').eq('brand_id', brandId).limit(1), Q, null),
      safeQ(sb.from('vw_brand_efficiency_targets').select('actual_cac, breakeven_cac_first_order, breakeven_cac_ltv, target_cac, actual_roas, breakeven_roas_first_order, breakeven_roas_ltv, target_roas, goal_confirmed, cac_ltv_headroom, roas_ltv_headroom, orders_per_customer, repeat_ltv_share, status').eq('brand_id', brandId).limit(1), Q, null)
    ]);
    var cmRow = Array.isArray(r[0]) ? r[0][0] : r[0];
    var econRow = Array.isArray(r[1]) ? r[1][0] : r[1];
    return { cmRatio: (cmRow && cmRow.cm_ratio) || 0.6, aov: (cmRow && cmRow.aov) || 55, econ: econRow || {}, iroas: r[2] || [], tgts: r[3] || [], nvr: r[4] || [], items: r[5] || [], board: r[6] || [], effect: r[7] || [], optimum: r[8] || [], email: (Array.isArray(r[9]) ? r[9][0] : r[9]) || null, goal: (Array.isArray(r[10]) ? r[10][0] : r[10]) || null, forecast: r[11] || [], config: (Array.isArray(r[12]) ? r[12][0] : r[12]) || null, cac: (Array.isArray(r[13]) ? r[13][0] : r[13]) || null };
  }

  function topSellers(items, s, e) {
    var by = {}, i;
    for (i = 0; i < items.length; i++) { var r = items[i]; if (r.day >= s && r.day <= e) by[r.product_title] = (by[r.product_title] || 0) + n(r.revenue); }
    return Object.keys(by).map(function (k) { return { name: k, rev: by[k] }; }).sort(function (a, b) { return b.rev - a.rev; }).slice(0, 3);
  }
  function boardTop(board, cats) {
    var r = (board || []).filter(function (a) { return a.cm_gbp != null && cats.indexOf(a.category) >= 0; });
    r.sort(function (a, b) { return n(b.cm_gbp) - n(a.cm_gbp); });
    return r[0] || null;
  }
  function channelTable(effect, optimum, cmRatio, aov) {
    var breakEven = cmRatio > 0 ? 1 / cmRatio : null;
    var omap = {}; (optimum || []).forEach(function (o) { omap[o.channel_type] = o; });
    var rows = (effect || []).slice().sort(function (a, b) { return n(b.contribution_30d) - n(a.contribution_30d); }).map(function (c) {
      var spend = n(c.spend_30d), incRev = n(c.incremental_rev_30d), phi = c.phi == null ? null : n(c.phi);
      var iroas = spend > 0 ? incRev / spend : null;
      var icpa = (iroas && iroas > 0) ? aov / iroas : null;
      var o = omap[c.channel_type] || {};
      var marg = o.marginal_iroas == null ? null : n(o.marginal_iroas);
      var tgt = o.target_marginal_iroas == null ? 1.23 : n(o.target_marginal_iroas);
      var status = o.status || null, isEmail = c.family === "email";
      var rag = isEmail ? "g" : iroas == null ? "n" : (breakEven != null && iroas < breakEven) ? "r" : iroas >= tgt * 1.3 ? "g" : iroas < tgt ? "a" : "g";
      var verdict = isEmail ? ("returning" + (c.rev_per_send != null ? " · £" + f0(n(c.rev_per_send) * 1000) + "/1k sent" : ""))
        : status === "fix" ? "fix — avg below break-even" : status === "scale" ? "scale — marginal headroom"
        : status === "ease" ? "ease — near saturation" : status === "hold" ? "at optimum"
        : (iroas != null && breakEven != null && iroas < breakEven ? "below break-even" : "on target");
      return { name: c.channel_type.replace(/_/g, " ").replace(/\b\w/g, function (m) { return m.toUpperCase(); }),
        family: c.family, acquisition: c.drives !== "returning", spend: spend, incRev: incRev, phi: phi,
        aov: aov, iroas: iroas, icpa: icpa, marginal: marg, tgt: tgt, status: status, rag: rag,
        verdict: verdict, contribution: n(c.contribution_30d) };
    });
    return { rows: rows, breakEven: breakEven,
      paidContribution: rows.filter(function (r) { return r.family === "paid"; }).reduce(function (a, r) { return a + r.contribution; }, 0),
      channelSpend: rows.reduce(function (a, r) { return a + r.spend; }, 0) };
  }
  function heroFromBoard(board, fallback) {
    var top = (board || []).filter(function (a) { return a.cm_gbp != null; })[0];
    if (!top) return fallback;
    return { value: cmk(n(top.cm_gbp)) + '/mo CM', title: top.description, why: trim(top.step1 || ('Priority ' + (top.priority || '') + ' · ' + (top.category || '')), 150), source: 'action-board:' + top.external_id };
  }
  function heroDerived(m30, chan, cmRatio) {
    var cands = [];
    if (m30.cvr != null && m30.cvr < CVR_BENCH && m30.sessions > 0) cands.push({ v: m30.sessions * (CVR_BENCH / 100 - m30.cvr / 100) * m30.aov * cmRatio, title: 'Restore site conversion to ' + CVR_BENCH + '%', why: 'CVR ' + m30.cvr.toFixed(2) + '% on ' + f0(m30.sessions).toLocaleString('en-GB') + ' sessions.' });
    if (m30.discRate > 20 && m30.revenue > 0) cands.push({ v: (m30.discounts - 0.20 * m30.revenue) * cmRatio, title: 'Cut discount depth toward 20%', why: 'Discounts ' + m30.discRate.toFixed(0) + '% of revenue.' });
    (chan || []).forEach(function (c) { if (c.iroas != null && c.contribution < 0 && c.spend > 0) cands.push({ v: -c.contribution, title: 'Cut ' + c.name + ' — iROAS ' + c.iroas.toFixed(2), why: c.name + ' below break-even.' }); });
    cands.sort(function (a, b) { return b.v - a.v; });
    var t = cands[0] || { v: 0, title: 'Hold course', why: 'No single lever dominates.' };
    return { value: cmk(t.v) + '/mo CM', title: t.title, why: t.why, source: 'derived' };
  }
  function tierInsight(nums, board, cats, fb) {
    var a = boardTop(board, cats);
    if (!a) return fb;
    return { text: nums + ' Top lever: ' + trim(a.description, 92), action: trim(a.step1 || a.description, 130), value: cmk(n(a.cm_gbp)) + '/mo CM' };
  }

  function buildTf(tf, D, S) {
    var days = TF[tf];
    var endS = maxDate(D.shopify, 'date'); if (!endS) return null;
    var w = win(endS, days);
    var rev = sumR(D.shopify, 'date', w.cs, w.ce, function (r) { return n(r.netSales); });
    var revP = sumR(D.shopify, 'date', w.ps, w.pe, function (r) { return n(r.netSales); });
    var ord = sumR(D.shopify, 'date', w.cs, w.ce, function (r) { return n(r.orders); });
    var ordP = sumR(D.shopify, 'date', w.ps, w.pe, function (r) { return n(r.orders); });
    var disc = sumR(D.shopify, 'date', w.cs, w.ce, function (r) { return n(r.discounts); });
    var ret = sumR(D.shopify, 'date', w.cs, w.ce, function (r) { return n(r.returns); });
    var aov = ord > 0 ? rev / ord : 0, aovP = ordP > 0 ? revP / ordP : 0;
    var endG = maxDate(D.ga4 || [], 'date') || endS, wg = win(endG, days);
    var sess = sumR(D.ga4 || [], 'date', wg.cs, wg.ce, function (r) { return n(r.sessions); });
    var sessP = sumR(D.ga4 || [], 'date', wg.ps, wg.pe, function (r) { return n(r.sessions); });
    var metaSp = sumR(D.metaDaily || [], 'date', w.cs, w.ce, function (r) { return n(r.cost); });
    var googleSp = sumR(D.googleAds || [], 'date', w.cs, w.ce, function (r) { return n(r.cost); });
    var spend = metaSp + googleSp;
    var productCM = S.cmRatio * rev, productCMp = S.cmRatio * revP, CAM = productCM - spend;
    var fixedMonthly = n(S.config && S.config.fixed_costs_monthly), fixedWin = fixedMonthly * (days / 30), opProfit = CAM - fixedWin;
    var mer = spend > 0 ? rev / spend : null;
    var cvr = sess > 0 ? ord / sess * 100 : null, cvrP = sessP > 0 ? ordP / sessP * 100 : null;
    var discRate = rev > 0 ? disc / rev * 100 : 0, retRate = rev > 0 ? ret / rev * 100 : 0;
    var nNew = sumR(S.nvr, 'order_date', w.cs, w.ce, function (r) { return r.customer_type === 'new' ? n(r.net_revenue) : 0; });
    var nRet = sumR(S.nvr, 'order_date', w.cs, w.ce, function (r) { return r.customer_type === 'returning' ? n(r.net_revenue) : 0; });
    var nTot = nNew + nRet, splitNew = nTot > 0 ? +(nNew / nTot * 100).toFixed(1) : 0;
    var newRev = f0(splitNew / 100 * rev), retRev = f0(rev - newRev);
    var oNew = sumR(S.nvr, 'order_date', w.cs, w.ce, function (r) { return r.customer_type === 'new' ? n(r.orders) : 0; });
    var oRet = sumR(S.nvr, 'order_date', w.cs, w.ce, function (r) { return r.customer_type === 'returning' ? n(r.orders) : 0; });
    var repeat = (oNew + oRet) > 0 ? +(oRet / (oNew + oRet) * 100).toFixed(1) : 0;
    var ch = channelTable(S.effect, S.optimum, S.cmRatio, S.aov);
    var m30 = win(endS, 30), wg30 = win(endG, 30);
    var r30 = sumR(D.shopify, 'date', m30.cs, m30.ce, function (r) { return n(r.netSales); });
    var o30 = sumR(D.shopify, 'date', m30.cs, m30.ce, function (r) { return n(r.orders); });
    var d30 = sumR(D.shopify, 'date', m30.cs, m30.ce, function (r) { return n(r.discounts); });
    var s30 = sumR(D.ga4 || [], 'date', wg30.cs, wg30.ce, function (r) { return n(r.sessions); });
    var sp30 = sumR(D.metaDaily || [], 'date', m30.cs, m30.ce, function (r) { return n(r.cost); }) + sumR(D.googleAds || [], 'date', m30.cs, m30.ce, function (r) { return n(r.cost); });
    var spendReconcile = sp30 > 0 ? Math.abs(ch.channelSpend - sp30) / sp30 : 0;
    var hero = heroFromBoard(S.board, heroDerived({ revenue: r30, discounts: d30, discRate: r30 > 0 ? d30 / r30 * 100 : 0, sessions: s30, aov: o30 > 0 ? r30 / o30 : 0, cvr: s30 > 0 ? o30 / s30 * 100 : null }, ch.rows, S.cmRatio));
    var productCM30 = S.cmRatio * r30, CAM30 = productCM30 - sp30, breakEvenTxt = ch.breakEven != null ? ch.breakEven.toFixed(2) : '—';
    var numsB = 'Revenue ' + (delta(rev, revP) == null ? '—' : (delta(rev, revP) >= 0 ? 'up ' : 'down ') + Math.abs(delta(rev, revP)).toFixed(0) + '%') + ', CVR ' + (cvr == null ? '—' : cvr.toFixed(2) + '% vs ' + CVR_BENCH + '%') + '; product CM ' + gbp(productCM) + ' → CAM ' + gbp(CAM) + ' after ' + gbp(spend) + ' spend.';
    var numsC = 'New ' + splitNew + '% / returning ' + (100 - splitNew).toFixed(0) + '% of L1 revenue (' + gbp(newRev) + ' / ' + gbp(retRev) + '); repeat ' + repeat + '%.';
    var numsCh = 'Trailing 30d · break-even iROAS ' + breakEvenTxt + '; paid contribution ' + gbp(ch.paidContribution) + '; channel spend ' + gbp(ch.channelSpend) + ' vs L1 ' + gbp(sp30) + (spendReconcile > 0.10 ? ' ⚠' : ' ✓') + '.';
    var pacing = (function () {
      var g = S.goal; if (!g || !g.period_start) return null;
      var gDays = Math.max(1, Math.round((new Date(g.period_end) - new Date(g.period_start)) / 864e5) + 1);
      var tSalesPD = n(g.revenue_target) / gDays, tSpendPD = n(g.spend_cap) / gDays;
      var byDay = {};
      (D.shopify || []).forEach(function (r) { if (r.date >= w.cs && r.date <= w.ce) { (byDay[r.date] = byDay[r.date] || { d: r.date, sales: 0, spend: 0 }).sales += n(r.netSales); } });
      (D.metaDaily || []).forEach(function (r) { if (r.date >= w.cs && r.date <= w.ce) { (byDay[r.date] = byDay[r.date] || { d: r.date, sales: 0, spend: 0 }).spend += n(r.cost); } });
      (D.googleAds || []).forEach(function (r) { if (r.date >= w.cs && r.date <= w.ce) { (byDay[r.date] = byDay[r.date] || { d: r.date, sales: 0, spend: 0 }).spend += n(r.cost); } });
      var days = Object.keys(byDay).sort().map(function (k) { var x = byDay[k]; return { date: k.slice(5), sales: f0(x.sales), spend: f0(x.spend), tSales: f0(tSalesPD), tSpend: f0(tSpendPD) }; });
      var today = new Date().toISOString().slice(0, 10);
      var elapsed = Math.max(1, Math.round((new Date(today) - new Date(g.period_start)) / 864e5) + 1);
      var actTD = sumR(D.shopify, "date", g.period_start, today, function (r) { return n(r.netSales); });
      var tgtTD = tSalesPD * elapsed;
      return { days: days, goalConfirmed: g.confirmed === true, revActual: f0(actTD), revTarget: f0(tgtTD), pacePct: tgtTD > 0 ? +((actTD / tgtTD - 1) * 100).toFixed(1) : null };
    })();
    var cacBlock = (function () {
      var c = S.cac; if (!c) return null;
      var st = c.status;
      var verdict = st === 'scale' ? 'Returning above break-even ROAS (below break-even CAC) — headroom to scale acquisition.'
        : st === 'watch' ? 'Between lifetime and first-order break-even — profitable over the customer’s life but not on order 1. Hold spend, or lift AOV / repeat.'
        : st === 'fix' ? 'Below lifetime break-even ROAS (above lifetime CAC) — each new customer loses money. Cut CAC / raise ROAS before scaling.'
        : 'Efficiency targets need cohort + spend data.';
      return {
        cac: { actual: n(c.actual_cac), first: n(c.breakeven_cac_first_order), ltv: n(c.breakeven_cac_ltv), target: n(c.target_cac) },
        roas: { actual: n(c.actual_roas), first: n(c.breakeven_roas_first_order), ltv: n(c.breakeven_roas_ltv), target: n(c.target_roas) },
        status: st, rag: st === 'scale' ? 'g' : st === 'watch' ? 'a' : st === 'fix' ? 'r' : 'n',
        opc: n(c.orders_per_customer), repeatPct: c.repeat_ltv_share != null ? +(100 * c.repeat_ltv_share).toFixed(1) : null,
        goalConfirmed: c.goal_confirmed === true, verdict: verdict };
    })();
    return {
      pacing: pacing,
      cacBlock: cacBlock,
      periodLabel: LBL[tf][0] + ' · ' + w.cs + ' – ' + w.ce, compareLabel: LBL[tf][1],
      hero: { cmAfterMkt: CAM30, cm: productCM30, cmPct: +(S.cmRatio * 100).toFixed(1), spend: sp30, opProfit: CAM30 - fixedMonthly, fixedMonthly: fixedMonthly, targetEstimated: true, action: hero },
      business: [
        tile('Revenue', rev, 'gbp', delta(rev, revP), 'vs ' + gbp(revP), ragTrend(delta(rev, revP)), 'Shopify truth (L1)'),
        tile('Contribution (product)', productCM, 'gbp', delta(productCM, productCMp), '= rev × ' + (S.cmRatio * 100).toFixed(1) + '%', ragTrend(delta(productCM, productCMp)), 'before ad spend'),
        tile('Contribution after mktg', CAM, 'gbp', null, '= product CM − spend', CAM >= 0 ? 'g' : 'r', 'CAM'),
        tile('Operating profit', opProfit, 'gbp', null, fixedMonthly > 0 ? '= CAM − fixed ' + gbp(fixedWin) : 'set fixed costs in Plan', fixedMonthly <= 0 ? 'n' : opProfit >= 0 ? 'g' : 'r', fixedMonthly > 0 ? 'after £' + f0(fixedMonthly) + '/mo' : '—'),
        tile('Ad spend', spend, 'gbp', null, 'Meta ' + gbp(metaSp) + ' · Google ' + gbp(googleSp), 'a', mer != null ? 'MER ' + mer.toFixed(2) : ''),
        tile('Conversion rate', cvr, 'pct1', delta(cvr, cvrP), cvrP != null ? 'vs ' + cvrP.toFixed(2) + '%' : '', cvr == null ? 'n' : cvr >= CVR_BENCH ? 'g' : cvr >= 1.2 ? 'a' : 'r', 'benchmark ' + CVR_BENCH + '%'),
        tile('Sessions', sess, 'int', delta(sess, sessP), 'vs ' + f0(sessP).toLocaleString('en-GB'), ragTrend(delta(sess, sessP)), 'GA4'),
        tile('AOV', aov, 'gbp', delta(aov, aovP), 'net ÷ orders', ragTrend(delta(aov, aovP)), 'vs ' + gbp(aovP)),
        tile('Discounts', disc, 'gbp', null, discRate.toFixed(1) + '% of revenue', discRate > 25 ? 'r' : discRate > 20 ? 'a' : 'g', 'target <20%'),
        tile('Returns', ret, 'gbp', null, retRate.toFixed(1) + '% of revenue', retRate > 15 ? 'r' : retRate > 8 ? 'a' : 'g', 'healthy <8%'),
        tile('Orders', ord, 'int', delta(ord, ordP), 'vs ' + f0(ordP).toLocaleString('en-GB'), ragTrend(delta(ord, ordP)), 'MER ' + (mer != null ? mer.toFixed(2) : '—'))
      ],
      bestSellers: topSellers(S.items, w.cs, w.ce),
      customer: (function () {
        var retAov = oRet > 0 ? nRet / oRet : 0, newAov = oNew > 0 ? nNew / oNew : 0;
        var paidRows = (S.effect || []).filter(function (e) { return e.family === "paid"; });
        var pRev = paidRows.reduce(function (a, e) { return a + n(e.incremental_rev_30d); }, 0);
        var pSpend = paidRows.reduce(function (a, e) { return a + n(e.spend_30d); }, 0);
        var pOrders = newAov > 0 ? pRev / newAov : 0;
        return {
          splitNew: splitNew, splitRet: +(100 - splitNew).toFixed(1), newRev: newRev, retRev: retRev,
          rows: [
            { label: "Returning", rag: repeat >= 30 ? "g" : repeat >= 20 ? "a" : "r", cells: [
              { k: "Revenue", v: gbp(nRet) }, { k: "Orders", v: f0(oRet).toLocaleString("en-GB") },
              { k: "AOV", v: gbp(retAov) }, { k: "Repeat rate", v: repeat + "%" } ] },
            { label: "New", rag: "g", cells: [
              { k: "Revenue", v: gbp(nNew) }, { k: "Orders", v: f0(oNew).toLocaleString("en-GB") },
              { k: "AOV", v: gbp(newAov) }, { k: "Weighted CAC", v: S.econ.ncac == null ? "—" : gbp(n(S.econ.ncac)) },
              { k: "aMER", v: S.econ.amer == null ? "—" : n(S.econ.amer).toFixed(2) + "×" } ] },
            { label: "Paid · incremental", rag: pRev > pSpend ? "g" : "a", cells: [
              { k: "iRevenue", v: gbp(pRev) }, { k: "iOrders", v: f0(pOrders).toLocaleString("en-GB") },
              { k: "iAOV", v: gbp(newAov) }, { k: "iCAC", v: pOrders > 0 ? gbp(pSpend / pOrders) : "—" },
              { k: "ipaMER", v: pSpend > 0 ? (pRev / pSpend).toFixed(2) + "×" : "—" } ] }
          ]
        };
      })(),
      emailBlock: S.email,
      channel: ch.rows.length ? ch.rows : [{ name: 'No channel data', phi: null, spend: 0, rep: null, iroas: null, tgt: 1.23, rag: 'n', verdict: 'connect ad platforms' }],
      insights: {
        business: tierInsight(numsB, S.board, TIER_CATS.business, { text: numsB, action: hero.title, value: hero.value }),
        customer: tierInsight(numsC, S.board, TIER_CATS.customer, { text: numsC, action: repeat < 30 ? 'Turn on post-purchase & winback flows to lift repeat rate.' : 'Retention healthy — protect it.', value: 'retention' }),
        channel: tierInsight(numsCh, S.board, TIER_CATS.channel, { text: numsCh, action: 'Reallocate from below-break-even channels.', value: 'iROAS' })
      }
    };
  }

  var _supp = null;
  function rebuild() {
    try {
      var L = window.FRKL_LIVE, D = window.FRKL_DATA;
      if (!L || !L.brandId || !D || !D.shopify || !D.shopify.length) { return; }
      var S = _supp || { cmRatio: 0.6, econ: {}, iroas: [], tgts: [], nvr: [], items: [], board: [] };
      var out = {};
      Object.keys(TF).forEach(function (tf) { try { var b = buildTf(tf, D, S); if (b) out[tf] = b; } catch (e) { if (window.console) console.warn('[overview-data] buildTf ' + tf, e); } });
      if (Object.keys(out).length) { window.FRKL_OVERVIEW = out; window.dispatchEvent(new CustomEvent('frkl-overview-updated')); if (window.console) console.info('[overview-data] FRKL_OVERVIEW built', Object.keys(out).length, 'timeframes · supp=' + (_supp ? 'yes' : 'pending')); }
    } catch (e) { if (window.console) console.warn('[overview-data] rebuild failed', e); }
  }
  async function refreshSupp() {
    var L = window.FRKL_LIVE;
    if (!L || !L.brandId || !window.FRKL_DATA || !window.FRKL_DATA.shopify || !window.FRKL_DATA.shopify.length) return;
    rebuild(); // build business tier immediately from loader data
    if (L.sb) { try { _supp = await fetchSupp(L.sb, L.brandId); } catch (e) { if (window.console) console.warn('[overview-data] supp fetch failed', e); } rebuild(); }
  }
  window.addEventListener('frkl-data-updated', refreshSupp);
  var tries = 0, iv = setInterval(function () { tries++; if ((window.FRKL_LIVE && window.FRKL_LIVE.brandId && window.FRKL_DATA && window.FRKL_DATA.shopify && window.FRKL_DATA.shopify.length) || tries > 60) { clearInterval(iv); refreshSupp(); } }, 500);
})();

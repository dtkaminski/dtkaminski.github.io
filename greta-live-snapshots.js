/* greta-live-snapshots.js — the bundled snapshots, rebuilt from live views.
 *
 * Several screens were written against frkl's July snapshot files (FRKL_COHORTS, FRKL_CLARITY,
 * FRKL_DISCOUNT_CODES, FRKL_CVR, FRKL_BUSINESS.products …). Since 2026-09-30 the loader retires
 * those once they are old, so the screens went blank ("—", "0 of 0 units", "connect Shopify to
 * build cohorts", "No Clarity data yet") although every one of those numbers is in the database.
 *
 * This file builds the same objects, in the same shapes, from the live views, per brand, and
 * re-applies them whenever the old snapshot files land (they load at idle and would overwrite
 * them). Each object carries as_of = today and _source = 'live', so retirement leaves it alone.
 * The screens did not change. Never throws; a source that fails leaves its screen as it was.
 */
(function () {
  'use strict';
  var TODAY = function () { return new Date().toISOString().slice(0, 10); };
  var addDays = function (iso, n) { var d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  var weekOf = function (iso) { var d = new Date(iso + 'T00:00:00Z'); var wd = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - wd); return d.toISOString().slice(0, 10); };
  var num = function (v) { var n = Number(v); return isFinite(n) ? n : null; };
  var r1 = function (v) { return v == null ? null : Math.round(v * 10) / 10; };
  var r2 = function (v) { return v == null ? null : Math.round(v * 100) / 100; };
  var SERVICE = /^(replacement|resend|exchange|missing from order|lost in transit|custom discount|freeship)\b/i;

  var built = {};          // brand id -> { key: object }
  var state = { brand: null, busy: false };

  function sb() { return window.FRKL_LIVE && window.FRKL_LIVE.sb; }
  function bid() { return window.FRKL_LIVE && window.FRKL_LIVE.brandId; }
  // One retry: a first read that fails (a cold pool, a dropped connection) should not leave a
  // screen on its empty state for the whole visit.
  async function q(build) {
    for (var attempt = 0; attempt < 2; attempt++) {
      try { var r = await build(); if (r && !r.error && r.data) return r.data; } catch (e) {}
      if (!attempt) await new Promise(function (res) { setTimeout(res, 1500); });
    }
    return null;
  }
  // PostgREST caps a response at 1,000 rows; page through anything that can be longer.
  async function qAll(build, cap) {
    var out = [], step = 1000;
    for (var from = 0; from < (cap || 20000); from += step) {
      var page = await q(function () { return build().range(from, from + step - 1); });
      if (!page) return out.length ? out : null;
      out = out.concat(page); if (page.length < step) break;
    }
    return out;
  }

  // ── Clarity: the friction card, from the last 30 days of the daily sync ──────────────────
  async function clarity(s, b) {
    var rows = await q(function () { return s.from('tenant_clarity_daily').select('date,metric_name,sessions_count,with_metric_pct,sub_total,raw')
      .eq('brand_id', b).eq('dim_value', 'all').gte('date', addDays(TODAY(), -30)); });
    if (!rows || !rows.length) return null;
    var by = {}; rows.forEach(function (r) { (by[r.metric_name] = by[r.metric_name] || []).push(r); });
    var wPct = function (k) { var a = by[k] || [], n = 0, w = 0; a.forEach(function (r) { var s2 = num(r.sessions_count), p = num(r.with_metric_pct); if (s2 && p != null) { n += s2; w += s2 * p; } }); return n ? r1(w / n) : null; };
    var traffic = by.Traffic || [], sessions = 0, bots = 0, users = 0, ppsW = 0;
    traffic.forEach(function (r) { var x = r.raw || {}; var t = num(x.totalSessionCount) || 0; sessions += t; bots += num(x.totalBotSessionCount) || 0; users += num(x.distinctUserCount) || 0; ppsW += t * (num(x.pagesPerSessionPercentage) || 0); });
    var scroll = (by.ScrollDepth || []).map(function (r) { return num((r.raw || {}).averageScrollDepth); }).filter(function (v) { return v != null; });
    var eng = (by.EngagementTime || []).reduce(function (a, r) { var x = r.raw || {}; a.t += num(x.totalTime) || 0; a.a += num(x.activeTime) || 0; return a; }, { t: 0, a: 0 });
    var days = {}; rows.forEach(function (r) { days[r.date] = 1; });
    var nDays = Object.keys(days).length, last = Object.keys(days).sort().pop();
    var se = wPct('ScriptErrorCount'), ec = wPct('ErrorClickCount'), dc = wPct('DeadClickCount'), qb = wPct('QuickbackClick'), rc = wPct('RageClickCount'), xs = wPct('ExcessiveScroll');
    var seCount = (by.ScriptErrorCount || []).reduce(function (a, r) { return a + (num(r.sub_total) || 0); }, 0);
    var pps = sessions ? r2(ppsW / sessions) : null, sd = scroll.length ? Math.round(scroll.reduce(function (a, v) { return a + v; }, 0) / scroll.length) : null;
    var active = eng.t ? eng.a / eng.t : null;
    var flags = [];
    if (se != null && se >= 10) flags.push({ sev: 'high', text: Math.round(se) + '% of sessions hit a JavaScript error — a likely conversion blocker. Reproduce the top error before scaling spend.' });
    if (pps != null && pps < 1.5) flags.push({ sev: 'high', text: 'Only ' + pps.toFixed(2) + ' pages per session — visitors land and leave without browsing. A landing or product page problem, not a traffic one.' });
    if (sd != null && sd < 50) flags.push({ sev: 'med', text: 'Average scroll depth is ' + sd + '% — what sits below that point is mostly unseen.' });
    if (ec != null && ec >= 2) flags.push({ sev: 'med', text: ec.toFixed(1) + '% of sessions click something broken (error clicks) — usually a dead button or failing widget.' });
    if (dc != null && dc >= 3) flags.push({ sev: 'med', text: dc.toFixed(1) + '% of sessions register dead clicks — taps that do nothing.' });
    if (active != null && active < 0.5) flags.push({ sev: 'low', text: 'Visitors are active for ' + Math.round(active * 100) + '% of their time on site — attention drops fast.' });
    return { available: true, source: 'live', _source: 'live', as_of: TODAY(), asOf: last, windowDays: nDays, days: nDays, thinData: nDays < 7,
      sessions: sessions || null, botSessions: bots, distinctUsers: users || null, pagesPerSession: pps, scrollDepth: sd,
      engagement: { activePct: active },
      friction: { scriptError: { pct: se, count: seCount }, errorClick: { pct: ec }, deadClick: { pct: dc }, quickback: { pct: qb }, rageClick: { pct: rc }, excessiveScroll: { pct: xs } },
      flags: flags, notes: { window: 'From the daily Clarity sync, last ' + nDays + ' days.' } };
  }

  // ── Discount codes: 26 weeks of orders, ex-VAT, drafts and exchanges excluded ─────────────
  async function discountCodes(s, b) {
    var since = addDays(TODAY(), -182);
    var rows = await qAll(function () { return s.from('v_shopify_orders_ex_vat').select('processed_at,channel,discount_codes,subtotal_price,total_discounts')
      .eq('brand_id', b).gte('processed_at', since).order('processed_at', { ascending: true }); }, 40000);
    if (!rows) return null;
    var axis = []; for (var w = weekOf(since); w <= weekOf(TODAY()); w = addDays(w, 7)) axis.push(w);
    var M = { axis: axis, weeks: axis.length, days: 182, fullPriceOrders: 0, fullPriceRevenue: 0, discountedOrders: 0, discountedRevenue: 0,
      marketingDiscount: 0, automaticDiscount: 0, automaticOrders: 0, draftOrdersExcluded: 0, draftDiscountExcluded: 0, codedOrders: 0, markdownEstimate: 0 };
    var codes = {}, weekly = {}; axis.forEach(function (a) { weekly[a] = { w: a }; });
    rows.forEach(function (o) {
      var day = String(o.processed_at).slice(0, 10), wk = weekOf(day), rev = num(o.subtotal_price) || 0, disc = num(o.total_discounts) || 0;
      var cs = (o.discount_codes || []).map(function (c) { return String(c).trim(); }).filter(Boolean);
      var service = cs.length && cs.every(function (c) { return SERVICE.test(c); });
      if (o.channel === 'shopify_draft_order' || service) { M.draftOrdersExcluded++; M.draftDiscountExcluded += disc; }
      if (o.channel === 'shopify_draft_order') return;
      if (!(disc > 0)) { M.fullPriceOrders++; M.fullPriceRevenue += rev; } else { M.discountedOrders++; M.discountedRevenue += rev; }
      if (!cs.length && disc > 0) { M.automaticDiscount += disc; M.automaticOrders++; }
      if (cs.length) M.codedOrders++;
      cs.forEach(function (c) {
        var k = SERVICE.test(c) ? 'service' : 'marketing', share = disc / cs.length;
        var e = codes[c] = codes[c] || { code: c, kind: k, orders: 0, revenue: 0, discount: 0, perWeek: {}, firstSeen: day, lastSeen: day };
        e.orders++; e.revenue += rev / cs.length; e.discount += share; e.perWeek[wk] = (e.perWeek[wk] || 0) + 1; e.lastSeen = day;
        if (k === 'marketing') M.marketingDiscount += share;
      });
    });
    var total = M.fullPriceOrders + M.discountedOrders;
    M.fullPriceShare = total ? M.fullPriceOrders / total : null;
    M.codedShare = total ? M.codedOrders / total : null;
    M.fullPriceRevenueShare = (M.fullPriceRevenue + M.discountedRevenue) ? M.fullPriceRevenue / (M.fullPriceRevenue + M.discountedRevenue) : null;
    var list = Object.keys(codes).map(function (c) {
      var e = codes[c], active = axis.filter(function (a) { return e.perWeek[a]; }).length, span = axis.filter(function (a) { return a >= weekOf(e.firstSeen) && a <= weekOf(e.lastSeen); }).length || 1;
      e.series = axis.map(function (a) { return e.perWeek[a] || 0; });
      e.pattern = e.orders === 1 ? 'one-off' : (active / span >= 0.75 && active >= 8) ? 'always-on' : (active <= 2) ? 'spike' : 'recurring';
      e.discountRate = (e.revenue + e.discount) ? e.discount / (e.revenue + e.discount) : 0;
      e.recent = e.lastSeen >= addDays(TODAY(), -21);
      e.revenue = Math.round(e.revenue); e.discount = Math.round(e.discount); delete e.perWeek;
      return e;
    });
    var mkt = list.filter(function (c) { return c.kind === 'marketing'; }).sort(function (a, b2) { return b2.orders - a.orders; });
    M.topCodes = mkt.slice(0, 5).map(function (c) { return c.code; });
    list.forEach(function (c) {
      c.series.forEach(function (n, i) { if (!n) return; var row = weekly[axis[i]];
        var key = c.kind === 'service' ? 'Service' : (M.topCodes.indexOf(c.code) >= 0 ? c.code : 'Other'); row[key] = (row[key] || 0) + n; });
    });
    var always = mkt.filter(function (c) { return c.pattern === 'always-on'; }).sort(function (a, b2) { return b2.discount - a.discount; });
    M.alwaysOnCount = always.length; M.alwaysOnLeak = always[0] ? { code: always[0].code, discount: always[0].discount, orders: always[0].orders } : null;
    ['fullPriceRevenue', 'discountedRevenue', 'marketingDiscount', 'automaticDiscount', 'draftDiscountExcluded'].forEach(function (k) { M[k] = Math.round(M[k]); });
    return { _source: 'live', as_of: TODAY(), meta: M, codes: list, weekly: axis.map(function (a) { return weekly[a]; }) };
  }

  // ── Cohorts: what a customer is worth, from the live cohort and unit-economics views ─────
  async function cohorts(s, b) {
    var res = await Promise.all([
      q(function () { return s.from('v_tenant_cohort_curve').select('offset_m,customers_observed,cum_rev_per_cust').eq('brand_id', b).order('offset_m'); }),
      q(function () { return s.from('v_tenant_retention_summary').select('customers,orders_per_customer,repeat_rate').eq('brand_id', b).limit(1); }),
      q(function () { return s.from('vw_brand_unit_economics').select('cac,ltv_rev').eq('brand_id', b).limit(1); }),
      q(function () { return s.from('vw_cac_elasticity_fit_input').select('month,spend,new_customers,cac').eq('brand_id', b).order('month'); }),
      q(function () { return s.from('vw_discount_dependency').select('first_on_markdown,customers,repeat_rate_180d').eq('brand_id', b); }),
      q(function () { return s.from('vw_acq_cohort_base').select('cohort_month').eq('brand_id', b).order('cohort_month').limit(1); })
    ]);
    var curve = res[0], ret = res[1] && res[1][0], ue = res[2] && res[2][0], months = res[3] || [], dep = res[4] || [], first = res[5] && res[5][0];
    if (!ret || !ret.customers || !curve || !curve.length) return null;
    var pooled = curve.map(function (c) { return { m: c.offset_m, cumRevPerCust: r2(num(c.cum_rev_per_cust)), customersObserved: num(c.customers_observed) }; });
    var paidMonths = months.filter(function (m) { return num(m.spend) > 0; });
    var spendAll = months.reduce(function (a, m) { return a + (num(m.spend) || 0); }, 0), newAll = months.reduce(function (a, m) { return a + (num(m.new_customers) || 0); }, 0);
    return { _source: 'live', as_of: TODAY(),
      totalCustomers: num(ret.customers), ordersPerCustomer: r2(num(ret.orders_per_customer)), repeatRate: num(ret.repeat_rate),
      windowFirst: first ? String(first.cohort_month).slice(0, 7) : (months[0] && months[0].month), windowLast: TODAY().slice(0, 7),
      lifetimeRevPerCust: ue && ue.ltv_rev != null ? num(ue.ltv_rev) : (pooled.length ? pooled[pooled.length - 1].cumRevPerCust : null),
      firstOrderRevPerCust: pooled[0] ? pooled[0].cumRevPerCust : null,
      pooledCurve: pooled,
      cac: { paid: ue && ue.cac != null ? num(ue.cac) : null, blended: newAll ? r2(spendAll / newAll) : null, paidMonths: paidMonths.length,
        byMonth: months.map(function (m) { return { month: m.month, newCustomers: num(m.new_customers), spend: num(m.spend), cac: num(m.spend) > 0 ? r2(num(m.cac)) : null }; }) },
      byAcqType: dep.filter(function (d) { return d.first_on_markdown != null; }).map(function (d) {
        return { type: d.first_on_markdown ? 'Discounted first order' : 'Full-price first order', newCustomers: num(d.customers), repeatRate: num(d.repeat_rate_180d), ordersPerCust: null, lifetimeRevPerCust: null }; }),
      byProduct: [], notes: null };
  }

  // ── Products, retention by month, Klaviyo: the parts of FRKL_BUSINESS screens still read ───
  async function business(s, b) {
    var res = await Promise.all([
      q(function () { return s.from('vw_product_contribution').select('sku,shopify_product_id,product_title,units,realized_rev,cogs,cost_quality').eq('brand_id', b); }),
      q(function () { return s.from('vw_daily_new_vs_returning').select('order_date,customer_type,orders').eq('brand_id', b).eq('ledger', 'dtc').gte('order_date', addDays(TODAY(), -365)).limit(5000); }),
      q(function () { return s.from('tenant_klaviyo_campaigns').select('name,status,send_time,recipients,open_rate,click_rate,attributed_revenue,attributed_orders,channel').eq('brand_id', b).gte('send_time', addDays(TODAY(), -90)).order('send_time', { ascending: false }).limit(500); }),
      q(function () { return s.from('tenant_klaviyo_flows').select('name,status,trigger_type,recipients_30d,open_rate_30d,click_rate_30d,attributed_revenue_30d,attributed_orders_30d').eq('brand_id', b); })
    ]);
    var out = {};
    if (res[0] && res[0].length) {
      var byP = {};
      res[0].forEach(function (r) { var k = r.shopify_product_id || r.sku || r.product_title; var e = byP[k] = byP[k] || { title: r.product_title, sku: r.sku, units: 0, netSales: 0, cogs: 0, costed: true };
        e.units += num(r.units) || 0; e.netSales += num(r.realized_rev) || 0; if (num(r.cogs) == null) e.costed = false; else e.cogs += num(r.cogs); });
      out.products = Object.keys(byP).map(function (k) { var e = byP[k];
        var gp = e.costed ? e.netSales - e.cogs : null;
        return { title: e.title, sku: e.sku, units: e.units, netSales: Math.round(e.netSales), grossProfit: gp == null ? null : Math.round(gp),
          marginPct: (gp != null && e.netSales > 0) ? gp / e.netSales : null, returns: null, returnRate: null, window: '28d' }; })
        .filter(function (p) { return p.units > 0; });
    }
    if (res[1] && res[1].length) {
      var byM = {};
      res[1].forEach(function (r) { var m = String(r.order_date).slice(0, 7); var e = byM[m] = byM[m] || { month: m, ret: 0, new: 0, total: 0 };
        var n = num(r.orders) || 0; e.total += n; if (r.customer_type === 'returning') e.ret += n; else if (r.customer_type === 'new') e.new += n; });
      out.retentionByMonth = Object.keys(byM).sort().map(function (m) { return byM[m]; });
    }
    var rpr = function (rev, rec) { return (rev != null && rec) ? rev / rec : null; };
    if (res[2]) out.emailCampaigns = res[2].map(function (c) { var rec = num(c.recipients), rev = num(c.attributed_revenue);
      return { name: c.name, subject: c.name, status: c.status, sendTime: c.send_time, sendDate: c.send_time ? String(c.send_time).slice(0, 10) : null, recipients: rec,
        openRate: num(c.open_rate), clickRate: num(c.click_rate), revenue: rev, orderValue: rev, orders: num(c.attributed_orders), revPerRecip: rpr(rev, rec), channel: c.channel }; });
    if (res[3]) out.emailFlows = res[3].filter(function (f) { return f.status === 'live'; }).map(function (f) { var rec = num(f.recipients_30d), rev = num(f.attributed_revenue_30d);
      return { name: f.name, status: f.status, trigger: f.trigger_type, recipients: rec, openRate: num(f.open_rate_30d), clickRate: num(f.click_rate_30d),
        revenue: rev, orderValue: rev, orders: num(f.attributed_orders_30d), revPerRecip: rpr(rev, rec) }; });
    // Totals the email hub leads with. Campaigns cover the last 90 days, flows Klaviyo's last 30.
    var summ = function (rows) { rows = (rows || []).filter(function (r) { return r.recipients; }); if (!rows.length) return null;
      var rec = rows.reduce(function (a, r) { return a + r.recipients; }, 0), rev = rows.reduce(function (a, r) { return a + (r.orderValue || 0); }, 0);
      var w = function (k) { return rows.reduce(function (a, r) { return a + (r[k] || 0) * r.recipients; }, 0) / rec; };
      return { messages: rows.length, recipients: rec, orderValue: Math.round(rev), revPerRecip: rec ? rev / rec : null, avgOpenRate: w('openRate'), avgClickRate: w('clickRate') }; };
    if (out.emailCampaigns || out.emailFlows) out.emailSummary = { campaigns: summ(out.emailCampaigns) || {}, flows: summ(out.emailFlows) || {}, _source: 'live' };
    return Object.keys(out).length ? out : null;
  }

  // ── Conversion drivers: funnel stages, traffic mix vs rate, on clean GA4 days only ───────
  async function cvr(s, b) {
    var since = addDays(TODAY(), -120);
    var res = await Promise.all([
      q(function () { return s.from('v_tenant_ga4_daily_valid').select('date,channel,sessions,new_users,engagement_rate,bounce_rate,ecommerce_purchases,add_to_carts,begin_checkouts').eq('brand_id', b).gte('date', since).limit(5000); }),
      q(function () { return s.from('v_tenant_shopify_daily_agg').select('day,order_count,net_revenue,discounts').eq('brand_id', b).gte('day', since).limit(1000); })
    ]);
    var ga = res[0], shop = res[1];
    if (!ga) return null;
    var D = {};
    ga.forEach(function (r) { var d = r.date, e = D[d] = D[d] || { w: d, ch: {}, total: null };
      if (r.channel === 'total') e.total = r; else e.ch[r.channel] = r; });
    (shop || []).forEach(function (r) { if (D[r.day]) { D[r.day].orders = num(r.order_count) || 0; D[r.day].rev = num(r.net_revenue) || 0; D[r.day].disc = num(r.discounts) || 0; } });
    var days = Object.keys(D).sort().map(function (d) { var e = D[d], t = e.total || {}, chs = Object.keys(e.ch);
      var sess = num(t.sessions) || chs.reduce(function (a, c) { return a + (num(e.ch[c].sessions) || 0); }, 0);
      var sum = function (k) { return t[k] != null ? num(t[k]) : chs.reduce(function (a, c) { return a + (num(e.ch[c][k]) || 0); }, 0); };
      var share = function (re) { var n = chs.filter(function (c) { return re.test(c); }).reduce(function (a, c) { return a + (num(e.ch[c].sessions) || 0); }, 0); return sess ? n / sess * 100 : null; };
      var atc = sum('add_to_carts'), co = sum('begin_checkouts'), pu = sum('ecommerce_purchases');
      return { w: d, sessions: sess, orders: e.orders || 0, purchases: pu, atc: atc, checkouts: co, ch: e.ch,
        cvr: sess ? r2((e.orders || 0) / sess * 100) : null,
        s2c: sess ? r2(atc / sess * 100) : null, c2co: atc ? r2(co / atc * 100) : null, co2p: co ? r2(pu / co * 100) : null,
        newShare: sess ? r1(sum('new_users') / sess * 100) : null,
        paidShare: r1(share(/^paid|cross-network/i)), emailShare: r1(share(/email/i)), organicShare: r1(share(/organic/i)),
        bounce: t.bounce_rate != null ? r1(num(t.bounce_rate) * 100) : null, engagement: t.engagement_rate != null ? r1(num(t.engagement_rate) * 100) : null,
        aov: e.orders ? r2(e.rev / e.orders) : null, discountIntensity: (e.rev + e.disc) ? r1(e.disc / (e.rev + e.disc) * 100) : null };
    }).filter(function (x) { return x.sessions > 0; });
    // Only the latest unbroken run of clean days. GA4 days marked unusable are missing from the
    // view, so July and late September sat side by side and "recent vs before" compared them.
    var run = [];
    for (var i = days.length - 1; i >= 0; i--) {
      if (run.length && (Date.parse(run[0].w) - Date.parse(days[i].w)) / 86400000 > 3) break;
      run.unshift(days[i]);
    }
    days = run;
    var meta = { days: days.length, lo: days[0] && days[0].w, hi: days.length && days[days.length - 1].w, benchmarkLabel: null };
    if (days.length < 21) { meta.insufficient = true; return { _source: 'live', as_of: TODAY(), name: 'live', meta: meta, series: [], seriesDaily: days, channels: [], drivers: [] }; }
    // now = the newest half (up to 28 clean days), prev = the half before it
    var n = Math.min(28, Math.floor(days.length / 2)), now = days.slice(-n), prev = days.slice(-2 * n, -n);
    var agg = function (a) { var o = { sessions: 0, orders: 0, purchases: 0, atc: 0, checkouts: 0, ch: {} };
      a.forEach(function (d) { o.sessions += d.sessions; o.orders += d.orders; o.purchases += d.purchases; o.atc += d.atc; o.checkouts += d.checkouts;
        Object.keys(d.ch).forEach(function (c) { var x = o.ch[c] = o.ch[c] || { s: 0, p: 0 }; x.s += num(d.ch[c].sessions) || 0; x.p += num(d.ch[c].ecommerce_purchases) || 0; }); });
      return o; };
    var A = agg(now), P = agg(prev);
    var cvrOf = function (o) { return o.sessions ? o.purchases / o.sessions * 100 : 0; };
    var stage = function (o) { return { 'session→cart': o.sessions ? o.atc / o.sessions * 100 : 0, 'cart→checkout': o.atc ? o.checkouts / o.atc * 100 : 0, 'checkout→purchase': o.checkouts ? o.purchases / o.checkouts * 100 : 0 }; };
    var sN = stage(A), sP = stage(P), keys = Object.keys(sN), logs = {}, logT = 0;
    keys.forEach(function (k) { logs[k] = (sN[k] > 0 && sP[k] > 0) ? Math.log(sN[k] / sP[k]) : 0; logT += logs[k]; });
    // Each stage's share of the total movement (stages can move in opposite directions, so
    // dividing by the net change can exceed 100%).
    var absT = keys.reduce(function (a, k) { return a + Math.abs(logs[k]); }, 0);
    var contrib = {}; keys.forEach(function (k) { contrib[k] = absT ? Math.abs(logs[k]) / absT : 0; });
    var mover = keys.slice().sort(function (a, c) { return Math.abs(logs[c]) - Math.abs(logs[a]); })[0];
    // shift-share: mix = Σ (shareNow − sharePrev) × cvrPrev ; rate = Σ shareNow × (cvrNow − cvrPrev)
    var names = Object.keys(Object.assign({}, A.ch, P.ch)), mix = 0, rate = 0;
    var channels = names.map(function (c) { var a = A.ch[c] || { s: 0, p: 0 }, p = P.ch[c] || { s: 0, p: 0 };
      var shN = A.sessions ? a.s / A.sessions : 0, shP = P.sessions ? p.s / P.sessions : 0, cN = a.s ? a.p / a.s * 100 : 0, cP = p.s ? p.p / p.s * 100 : 0;
      mix += (shN - shP) * cP; rate += shN * (cN - cP);
      return { name: c, sessions: a.s, shareNow: r1(shN * 100), sharePrev: r1(shP * 100), cvrNow: r2(cN), cvrPrev: r2(cP), cvr: r2(cN) }; })
      .filter(function (c) { return c.shareNow >= 1 || c.sharePrev >= 1; }).sort(function (a, c) { return c.shareNow - a.shareNow; });
    var cN = cvrOf(A), cP = cvrOf(P);
    var weeks = {}; days.forEach(function (d) { var w = weekOf(d.w), e = weeks[w] = weeks[w] || { w: w, sessions: 0, orders: 0, purchases: 0, atc: 0, checkouts: 0, n: 0 };
      e.sessions += d.sessions; e.orders += d.orders; e.purchases += d.purchases; e.atc += d.atc; e.checkouts += d.checkouts; e.n++; });
    var series = Object.keys(weeks).sort().map(function (w) { var e = weeks[w];
      return { w: w, sessions: e.sessions, orders: e.orders, cvr: e.sessions ? r2(e.orders / e.sessions * 100) : null,
        s2c: e.sessions ? r2(e.atc / e.sessions * 100) : null, c2co: e.atc ? r2(e.checkouts / e.atc * 100) : null, co2p: e.checkouts ? r2(e.purchases / e.checkouts * 100) : null }; });
    Object.assign(meta, { insufficient: false, cvrNow: r2(cN), cvrPrev: r2(cP), deltaCVR: r2(cN - cP), mixEffect: r2(mix), rateEffect: r2(rate),
      mixDominant: Math.abs(mix) > Math.abs(rate),
      stageNow: Object.fromEntries(keys.map(function (k) { return [k, r1(sN[k])]; })), stagePrev: Object.fromEntries(keys.map(function (k) { return [k, r1(sP[k])]; })),
      stageMoves: Object.fromEntries(keys.map(function (k) { return [k, r1(sN[k] - sP[k])]; })), stageContribution: contrib, moverStage: mover,
      siteCvrNow: A.sessions ? r2(A.orders / A.sessions * 100) : null, lo: now[0].w, hi: now[now.length - 1].w });
    days.forEach(function (d) { delete d.ch; });
    return { _source: 'live', as_of: TODAY(), name: 'live', meta: meta, series: series, seriesDaily: days, channels: channels, drivers: [] };
  }

  function apply() {
    var b = bid(), L = b && built[b]; if (!L) return;
    if (L.clarity) window.FRKL_CLARITY = L.clarity;
    if (L.discountCodes) window.FRKL_DISCOUNT_CODES = L.discountCodes;
    if (L.cohorts) window.FRKL_COHORTS = L.cohorts;
    if (L.cvr) window.FRKL_CVR = L.cvr;
    if (L.business) {
      var BUS = window.FRKL_BUSINESS = window.FRKL_BUSINESS || {};
      var keys = window.FRKL_LIVE.liveBusinessKeys = window.FRKL_LIVE.liveBusinessKeys || [];
      Object.keys(L.business).forEach(function (k) { BUS[k] = L.business[k]; if (keys.indexOf(k) < 0) keys.push(k); });
    }
  }

  async function build() {
    var s = sb(), b = bid(); if (!s || !b || state.busy || built[b]) return;
    state.busy = true;
    try {
      var r = await Promise.all([clarity(s, b), discountCodes(s, b), cohorts(s, b), business(s, b), cvr(s, b)]);
      built[b] = { clarity: r[0], discountCodes: r[1], cohorts: r[2], business: r[3], cvr: r[4] };
      window.FRKL_LIVE.liveSnapshots = Object.keys(built[b]).filter(function (k) { return built[b][k]; });
      apply();
      try { window.dispatchEvent(new CustomEvent('frkl-data-updated', { detail: { liveSnapshots: true } })); } catch (e) {}
    } catch (e) { if (window.console) console.warn('[live-snapshots]', e); }
    finally { state.busy = false; }
  }

  // The loader's own listener retires the old files first; this one runs after it and puts the
  // live objects back.
  window.addEventListener('frkl-snapshots-loaded', function () { apply(); try { window.dispatchEvent(new CustomEvent('frkl-data-updated', { detail: { liveSnapshots: true } })); } catch (e) {} });
  // Only after the main live read has landed: these are ~20 more requests, and starting them at
  // brand-ready put them in the queue ahead of the figures every screen is waiting for.
  var ready = function () { return !!(window.FRKL_LIVE && window.FRKL_LIVE.lastFetchAt); };
  window.addEventListener('frkl-data-updated', function (e) { if (e && e.detail && e.detail.liveSnapshots) return; if (ready()) build(); });
  if (ready()) build();
  window.OI_LIVE_SNAPSHOTS = { rebuild: function () { var b = bid(); if (b) delete built[b]; return build(); }, built: built };
})();

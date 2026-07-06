// frkl-data-loader.js
// ────────────────────────────────────────────────────────────────────────────
// Live data layer for the frkl dashboard. Replaces the "open file, see snapshot"
// model with "open file, see what's in Supabase right now, refresh every 60s."
//
// HOW IT WORKS
//   1. Loads BEFORE the static window.FRKL_* JS files so it can override them.
//   2. Initialises a Supabase client using the anon (publishable) key.
//   3. If an authenticated session exists (set by /saas/auth/login.html) and
//      that user is a member of the frkl brand via brand_users, queries the
//      RLS-protected tables and populates window.FRKL_* from live data.
//   4. Falls back gracefully to whatever the static files later set if there's
//      no session / Supabase is unreachable / queries error.
//   5. Polls every 60s for fresh data. Dispatches 'frkl-data-updated' on the
//      window so the React app can re-render.
//   6. Renders a freshness indicator in the page header.
//
// Designed for the design-partner phase: works without auth (falls back to
// static), works better with auth (live).

(function () {
  'use strict';

  const SUPABASE_URL = 'https://awcncqvsnuhqyihpdgcx.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_6NLIq1JL_LZIMjez3FmnVQ_JIVw3-A2';
  // Brand slug for the live-data fetch. The /app shell injects window.OI_BRAND_SLUG per
  // tenant. This loader runs inside a same-origin iframe, so (like OI_ASK) we read our own
  // window first, then window.parent.OI_BRAND_SLUG; without the parent fallback every tenant
  // would silently load frkl's data. Final fallback is frkl for the standalone/demo view.
  const parentSlug = (function () {
    try { return (window.parent && window.parent !== window) ? window.parent.OI_BRAND_SLUG : null; }
    catch (e) { return null; }
  })();
  const BRAND_SLUG = (typeof window !== 'undefined' && (window.OI_BRAND_SLUG || parentSlug)) || 'frkl';
  const POLL_INTERVAL_MS = 60_000; // 60 seconds

  // Public surface — accessed by the dashboard to query liveness state
  window.FRKL_LIVE = {
    enabled: false,         // becomes true once we successfully fetch live data
    status: 'initialising', // 'initialising' | 'static-only' | 'live' | 'error' | 'stale'
    lastFetchAt: null,
    lastError: null,
    brandId: null,
    session: null,
    sb: null,               // the supabase client (for ad-hoc queries from devtools)
  };

  // Provisional Fit panels (genome cash/EBITDA/CCC + the shadow signal layer) are GATED
  // OFF until frkl's real brand_config (fixed costs, inventory/supplier days, discount rate)
  // is populated — until then those figures are prior-driven. Flip genomeSignal to true
  // (here, or via an inline window.FRKL_FIT_FLAGS set BEFORE this script) to reveal them.
  // No rebuild needed — it's a runtime global the panel reads on the next render.
  window.FRKL_FIT_FLAGS = window.FRKL_FIT_FLAGS || { genomeSignal: true };

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  // ── De-frkl: neutralise static-only globals for non-frkl brands ──────────────
  // The static frkl-*.js files set these globals to frkl's snapshot as the DEFAULT, and
  // there is no live per-brand source for them yet. For any brand other than frkl, null them
  // so each panel falls to its own empty state instead of showing frkl's data. frkl itself
  // returns early here, so its curated dashboard is completely unaffected. Remove entries as
  // live per-brand sources come online. See [[cache-bust-regex-hazard]] for why we edit plainly.
  // Empty every own key of an object in place, preserving shape (array->[], object->{}), leaving
  // primitives untouched. Used to strip static frkl snapshots the loader doesn't repopulate live.
  function emptyAllKeys(o){ for (var k in o){ if(!Object.prototype.hasOwnProperty.call(o,k)) continue;
    var v=o[k]; if(Array.isArray(v)) o[k]=[]; else if(v&&typeof v==='object') o[k]={}; } }

  function neutraliseStaticOnlyForNonFrkl() {
    if (BRAND_SLUG === 'frkl') return;
    // (A) Render-time globals — components read window.FRKL_* fresh each render, so nulling makes
    // each panel fall to its own verified empty state (Cohorts/Retention/Creative/Creators/Clarity/
    // CVR/Discounts/Board/Products/DX/Events).
    window.FRKL_COHORTS = null;
    window.FRKL_RETENTION = null;
    window.FRKL_CREATIVE_VISION = null;
    window.FRKL_CREATORS = null;
    window.FRKL_CLARITY = null;
    window.FRKL_CVR = null;
    window.FRKL_DISCOUNT_CODES = null;
    window.FRKL_BOARD_READ = null;
    window.FRKL_PRODUCTS = null;
    window.FRKL_DX_ANALYST = null;
    window.FRKL_EVENTS = null;
    // (B) Module-captured objects — frkl-app.jsx binds these into TOP-LEVEL consts at bundle-eval
    // (FRKL_BUSINESS -> const B @L4377 used by InventoryPanel/EmailAttributionPanel; FRKL_INSIGHTS
    // -> const INS @L608 used by the specialist-actions aggregator). Reassigning window.X would not
    // reach those consts, so we MUTATE the existing objects in place.
    // FRKL_BUSINESS is a 100% static frkl snapshot — no key has a live per-brand source — so empty
    // EVERY key so nothing (products, bundles, tiers, collections, discountCodes, email*, igPosts,
    // competitors, geo, returning, retention...) leaks frkl data. Mutated in place: module const
    // B @L4377 holds this same reference.
    var BUS = window.FRKL_BUSINESS;
    if (BUS && typeof BUS === 'object') { emptyAllKeys(BUS); }
    // FRKL_DATA: the live fetch below repopulates the channel keys (shopify/metaDaily/googleAds/ga4/
    // klaviyo); every OTHER key is a static frkl extra (creatives, demoAgeGender/Placement, the
    // shopify* channel breakdowns). Empty them all now — the 5 live keys are overwritten moments
    // later. Reset meta to a neutral label so the footer never renders frkl's snapshot source.
    var DATA = window.FRKL_DATA;
    if (DATA && typeof DATA === 'object') { emptyAllKeys(DATA); DATA.meta = { source: 'Live data', captured: '' }; }
    if (window.FRKL_PRODUCTS_META && typeof window.FRKL_PRODUCTS_META === 'object') window.FRKL_PRODUCTS_META = {};
    var INSIGHTS = window.FRKL_INSIGHTS;
    if (INSIGHTS && typeof INSIGHTS === 'object') {
      Object.keys(INSIGHTS).forEach(function (k) { delete INSIGHTS[k]; });
    }
    // Deferred: FRKL_LINKS (autolink URL map) is captured AND derived at eval (_linkKeys/_linkRe are
    // frozen), so it can't be cleared from here — needs an inline gate before frkl-app.js or a rebuild.
  }

  async function bootstrap() {
    // De-frkl static-only globals before anything renders live (frkl is a no-op).
    neutraliseStaticOnlyForNonFrkl();
    dispatchUpdate();
    // 1. Wait for supabase-js to be on window
    if (!window.supabase) {
      console.warn('[frkl-live] supabase-js not loaded — staying in static mode');
      setStatus('static-only', 'supabase-js missing');
      return;
    }

    const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
    window.FRKL_LIVE.sb = sb;

    // 2. Check for active session (set if the user logged in via the same-origin /auth/login.html).
    const { data: sessionData } = await sb.auth.getSession();
    if (!sessionData?.session) {
      // No same-origin session → stay static, but surface a login ENTRY so the user can switch to live.
      // RLS stays intact: login yields a per-user Supabase session JWT (publishable key only — never a
      // privileged/static token). The magic-link round-trip carries ?next so it returns to this page.
      try {
        const next = location.pathname + location.search;
        window.FRKL_LIVE.loginUrl = '/auth/login.html?next=' + encodeURIComponent(next);
        window.FRKL_LIVE.needsLogin = true;
      } catch (e) { /* location unavailable — leave the plain static state */ }
      console.info('[frkl-live] no auth session — static mode. Click the status pill to log in for live data.');
      setStatus('static-only', 'not authenticated');
      return;
    }
    window.FRKL_LIVE.session = sessionData.session;

    // 3. Resolve user's brand membership for frkl
    const { data: memberships, error: memErr } = await sb
      .from('brand_users')
      .select('brand_id, role, brand:brands(id, slug, name)')
      .eq('user_id', sessionData.session.user.id);
    if (memErr) {
      console.warn('[frkl-live] brand_users query failed', memErr);
      setStatus('error', memErr.message);
      return;
    }
    const frkl = (memberships || []).find(m => m.brand?.slug === BRAND_SLUG);
    if (!frkl) {
      console.warn(`[frkl-live] logged-in user is not a member of the '${BRAND_SLUG}' brand — see saas/multi-tenant-auth.md for the SQL to backfill.`);
      setStatus('static-only', 'no membership');
      return;
    }
    window.FRKL_LIVE.brandId = frkl.brand_id;

    // Activate the dashboard's live per-tenant Fit path. useFitResult() in the app treats
    // OI_ASK as authenticated only when it carries a getJwt() FUNCTION (oi-app-boot's /app
    // shell sets a static jwt, which leaves the standalone demo dormant). We publish getJwt
    // sourced from the live Supabase session so FitCard calls assess-fit with the user's JWT.
    // endpoint ends in /ask-data by convention — useFitResult strips the last segment to reach
    // …/functions/v1 and appends /assess-fit. No privileged key: publishable key + user JWT only.
    window.OI_ASK = window.OI_ASK || {
      endpoint: SUPABASE_URL + '/functions/v1/ask-data',
      brand_id: frkl.brand_id,
      getJwt: async () => {
        const { data: { session } } = await sb.auth.getSession();
        return session?.access_token || '';
      },
    };

    // 4. First fetch immediately, then poll
    await refresh();
    setInterval(refresh, POLL_INTERVAL_MS);
  }

  // ── Main refresh — runs at boot then every 60s ───────────────────────────

  async function refresh() {
    const sb = window.FRKL_LIVE.sb;
    const brandId = window.FRKL_LIVE.brandId;
    if (!sb || !brandId) return;

    try {
      const [patterns, actions, connections, dailyShopify, dailyMeta, dailyGoogle, dailyGa4, klaviyoDaily, syncLog] = await Promise.all([
        fetchPatterns(sb, brandId),
        fetchActions(sb, brandId),
        fetchConnections(sb, brandId),
        fetchDailyShopify(sb, brandId),
        fetchDailyMeta(sb, brandId),
        fetchDailyGoogleAds(sb, brandId),
        fetchDailyGa4(sb, brandId),
        fetchDailyKlaviyo(sb, brandId),
        fetchRecentSyncLog(sb, brandId),
      ]);

      // ── Patterns / money — ALWAYS reflect the authenticated brand's real live state, even when
      // empty, so a brand with no engine output shows £0 rather than inheriting frkl's static default. ──
      if (patterns) {
        const prior = window.FRKL_PATTERNS || {};
        window.FRKL_PATTERNS = {
          ...prior,
          patterns: patterns.patterns,
          diff: patterns.diff,
          money_rollup: patterns.money_rollup,
          money_patterns: patterns.money_patterns,
          action_money: patterns.action_money,
          action_phit: patterns.action_phit || {},
          actions_with_attribution: patterns.actions_with_attribution,
          scorecard: patterns.scorecard,
          diagnoses_by_parent: patterns.diagnoses_by_parent,
          metrics: patterns.metrics,
          generated_at: patterns.generated_at || new Date().toISOString(),
          _source: 'live',
        };
      }

      // ── Action statuses — replace with the brand's own live map (empty => {}), never merge frkl's. ──
      if (actions) {
        window.FRKL_ACTION_STATUS = actions;
      }

      // ── Daily channel data — only override if Supabase has it ──
      if (window.FRKL_DATA) {
        window.FRKL_DATA.shopify = dailyShopify;
        window.FRKL_DATA.metaDaily = dailyMeta;
        window.FRKL_DATA.googleAds = dailyGoogle;
        window.FRKL_DATA.ga4 = dailyGa4;
        window.FRKL_DATA.klaviyo = klaviyoDaily;
        // Update meta block so the timestamp surfaces in the UI
        window.FRKL_DATA.meta = {
          ...(window.FRKL_DATA.meta || {}),
          source: 'Supabase live',
          captured: new Date().toISOString().slice(0, 16).replace('T', ' '),
          currency: window.FRKL_DATA.meta?.currency || 'GBP',
        };
      }

      // Expose connection + sync state for the dashboard's existing health strip
      window.FRKL_LIVE.connections = connections;
      window.FRKL_LIVE.recent_sync = syncLog;

      setStatus('live', null);
      window.FRKL_LIVE.lastFetchAt = new Date();
      dispatchUpdate();
    } catch (err) {
      console.warn('[frkl-live] refresh failed', err);
      setStatus('error', err?.message || String(err));
      // Don't dispatch — keep showing last-good state
    }
  }

  // ── Per-resource fetchers (each returns an empty array on miss, never throws) ──

  async function fetchPatterns(sb, brandId) {
    try {
      const [pRes, mRes, sRes, aRes] = await Promise.all([
        sb.from('patterns_brand').select('kind, metric_id, related_metric_id, description, detected_at, window_start, window_end, confidence, significance, effect_size, metadata').eq('brand_id', brandId).eq('active', true).order('detected_at', { ascending: false }),
        sb.from('metrics').select('id, name, unit, direction, category'),
        sb.from('agent_scorecard').select('agent, category, window_days, hits, misses, inconclusive, total_closed, hit_rate, avg_attributed_lift, last_updated').eq('brand_id', brandId).order('agent').order('category'),
        sb.from('actions').select('external_id, agent, category, priority, description, status, verdict, predicted_metric_id, predicted_direction, predicted_magnitude_abs, baseline_value, observed_value, observed_delta, counterfactual_delta, attributed_lift, significance_z, observed_at, metadata').eq('brand_id', brandId),
      ]);
      const active = pRes.data || [];

      // Build money rollup + action_money from current state
      const moneyPatterns = active.filter(p => p.kind === 'money');
      const action_money = {};
      for (const a of (aRes.data || [])) {
        const m = (a.metadata || {}).money;
        if (m && a.external_id) {
          action_money[a.external_id] = { ...m, agent: a.agent, category: a.category, priority: a.priority, description: a.description, status: a.status, external_id: a.external_id };
        }
      }
      const rollup = { leakage: 0, opportunity: 0, at_risk: 0, total: 0 };
      for (const m of Object.values(action_money)) {
        const v = Math.abs(m.monthly_impact_gbp || 0);
        if (m.kind === 'leakage') rollup.leakage += v;
        else if (m.kind === 'opportunity') rollup.opportunity += v;
        else if (m.kind === 'at_risk') rollup.at_risk += v;
      }
      for (const p of moneyPatterns) {
        const md = p.metadata || {};
        const v = Math.abs(md.monthly_impact_gbp || 0);
        if (md.kind === 'leakage') rollup.leakage += v;
        else if (md.kind === 'opportunity') rollup.opportunity += v;
        else if (md.kind === 'at_risk') rollup.at_risk += v;
      }
      rollup.total = rollup.leakage + rollup.opportunity + rollup.at_risk;

      // Diagnoses index
      const diagnoses_by_parent = {};
      for (const p of active) {
        if (p.kind !== 'diagnosis') continue;
        const parentDesc = p.metadata?.parent_description;
        if (!parentDesc) continue;
        (diagnoses_by_parent[parentDesc] = diagnoses_by_parent[parentDesc] || []).push({
          description: p.description,
          confidence: p.confidence,
          recipe: (p.metadata || {}).recipe,
          metadata: p.metadata,
        });
      }

      // Metrics map
      const metrics = {};
      for (const m of (mRes.data || [])) metrics[m.id] = m;

      return {
        patterns: active,
        money_rollup: rollup,
        action_money,
        money_patterns: moneyPatterns.map(p => ({ ...(p.metadata || {}), description: p.description, confidence: p.confidence })),
        scorecard: sRes.data || [],
        diagnoses_by_parent,
        metrics,
        actions_with_attribution: (aRes.data || []).filter(a => a.attributed_lift != null),
        generated_at: active[0]?.detected_at || null,
        // diff is harder to compute live — left to the existing static value
        diff: null,
      };
    } catch (e) {
      console.warn('[frkl-live] fetchPatterns error', e);
      return null;
    }
  }

  async function fetchActions(sb, brandId) {
    try {
      const { data } = await sb.from('actions')
        .select('external_id, status, observed_at, observed_value, attributed_lift, verdict')
        .eq('brand_id', brandId);
      const out = {};
      for (const a of (data || [])) {
        if (!a.external_id) continue;
        out[a.external_id] = {
          status: a.status === 'done' ? 'verified-done' : a.status,
          evidence: null,
          resolvedAt: a.observed_at,
          impact: a.attributed_lift != null ? { lift: { deltaPct: a.attributed_lift } } : null,
        };
      }
      return out;
    } catch (e) { return {}; }
  }

  async function fetchConnections(sb, brandId) {
    try {
      const { data } = await sb.from('connections')
        .select('provider, status, account_label, last_sync_at, last_error')
        .eq('brand_id', brandId);
      return data || [];
    } catch (e) { return []; }
  }

  // ── Daily aggregates per channel — map Supabase tables → the shape the dashboard expects ──

  async function fetchDailyShopify(sb, brandId) {
    try {
      const { data } = await sb.from('v_tenant_shopify_daily')
        .select('day, order_count, net_revenue, discounts, line_items, aov, returns, channel')
        .eq('brand_id', brandId)
        .eq('channel', 'online_store')
        .order('day', { ascending: true });
      return (data || []).map(r => ({
        date: r.day,
        orders: Number(r.order_count || 0),
        netSales: Number(r.net_revenue || 0),
        discounts: Number(r.discounts || 0),
        totalSales: Number(r.net_revenue || 0) + Number(r.discounts || 0),
        aov: Number(r.aov || 0),      // static schema has aov; was selected but dropped → undefined → 0
        returns: Number(r.returns || 0), // real net-merch refunds (subtotal − current_subtotal); was absent → 0
      }));
    } catch (e) { return []; }
  }

  async function fetchDailyMeta(sb, brandId) {
    try {
      const { data } = await sb.from('tenant_meta_insights_daily')
        .select('date, spend, impressions, reach, clicks, link_clicks, purchases, purchase_value, frequency')
        .eq('brand_id', brandId).eq('level', 'account')
        .order('date', { ascending: true });
      return (data || []).map(r => {
        const impressions = Number(r.impressions || 0);
        const linkClicks = Number(r.link_clicks || 0);
        return {
          date: r.date,
          cost: Number(r.spend || 0),
          impressions,
          reach: Number(r.reach || 0),
          clicks: Number(r.clicks || 0),
          linkClicks,
          linkCtr: impressions > 0 ? linkClicks / impressions : 0, // static schema has linkCtr (rate); loader emitted only the raw count → component read .linkCtr → 0
          purchases: Number(r.purchases || 0),
          purchaseValue: Number(r.purchase_value || 0),
          frequency: Number(r.frequency || 0),
        };
      });
    } catch (e) { return []; }
  }

  async function fetchDailyGoogleAds(sb, brandId) {
    try {
      const { data } = await sb.from('v_tenant_google_ads_daily')
        .select('date, spend, impressions, clicks, conversions, conversion_value')
        .eq('brand_id', brandId)
        .order('date', { ascending: true });
      return (data || []).map(r => {
        const cost = Number(r.spend || 0);
        const clicks = Number(r.clicks || 0);
        return {
          date: r.date,
          cost,
          impressions: Number(r.impressions || 0),
          clicks,
          conversions: Number(r.conversions || 0), // was mis-keyed `conv` → dashboard read .conversions → undefined → 0
          convValue: Number(r.conversion_value || 0),
          cpc: clicks > 0 ? cost / clicks : 0,       // dashboard expects a cpc field; was absent → £0
        };
      });
    } catch (e) { return []; }
  }

  // Paginate past PostgREST's 1000-row cap. Without this, any table with >1000
  // rows for a brand (GA4 daily = ~12 channel rows/day crosses it after ~80 days)
  // silently returns only the first page — and with ascending order that drops the
  // most RECENT days, making fresh data look stale. makeQuery must apply a stable,
  // unique ordering (date + a tiebreaker) so pages neither overlap nor skip rows.
  async function fetchAllPaged(makeQuery) {
    const PAGE = 1000; let from = 0; const out = [];
    for (;;) {
      const { data, error } = await makeQuery(from, from + PAGE - 1);
      if (error || !data || !data.length) break;
      out.push(...data);
      if (data.length < PAGE) break;
      from += PAGE;
    }
    return out;
  }

  async function fetchDailyGa4(sb, brandId) {
    try {
      // GA4 daily is stored per channel-group (~12 rows/day), so it crosses the
      // 1000-row cap after ~80 days — paginate, then sum to one row per date.
      const all = await fetchAllPaged((from, to) => sb.from('tenant_ga4_daily')
        .select('date, channel, sessions, active_users, new_users, conversions, purchase_revenue, ecommerce_purchases, add_to_carts, begin_checkouts, engagement_rate, bounce_rate')
        .eq('brand_id', brandId)
        .neq('channel', 'total')   // exclude GA4's daily summary row — channel groups already sum to it; including it double-counts sessions/purchases
        .order('date', { ascending: true })
        .order('channel', { ascending: true })
        .range(from, to));
      const byDate = {};
      for (const r of all) {
        const a = byDate[r.date] = byDate[r.date] || { date: r.date, sessions: 0, active_users: 0, new_users: 0, conversions: 0, purchase_revenue: 0, ecommerce_purchases: 0, add_to_carts: 0, begin_checkouts: 0, engaged_sessions: 0, bounced_sessions: 0 };
        const sess = Number(r.sessions || 0);
        a.sessions += sess;
        a.active_users += Number(r.active_users || 0);
        a.new_users += Number(r.new_users || 0);
        a.conversions += Number(r.conversions || 0);
        a.purchase_revenue += Number(r.purchase_revenue || 0);
        a.ecommerce_purchases += Number(r.ecommerce_purchases || 0);
        a.add_to_carts += Number(r.add_to_carts || 0);
        a.begin_checkouts += Number(r.begin_checkouts || 0);
        // engagement_rate / bounce_rate are RATES — weight by sessions before summing across channel rows
        a.engaged_sessions += sess * Number(r.engagement_rate || 0);
        a.bounced_sessions += sess * Number(r.bounce_rate || 0);
      }
      const rows = Object.values(byDate).sort((a, b) => a.date < b.date ? -1 : 1);
      return rows.map(r => {
        const sessions = Number(r.sessions || 0);
        return {
          date: r.date,
          sessions,
          users: Number(r.active_users || 0),
          engagedSessions: Math.round(r.engaged_sessions || 0),
          engagementRate: sessions > 0 ? r.engaged_sessions / sessions : 0, // was never selected → 0.0%
          bounceRate: sessions > 0 ? r.bounced_sessions / sessions : 0,
          purchases: Number(r.ecommerce_purchases || 0),
          purchaseValue: Number(r.purchase_revenue || 0),
          revenue: Number(r.purchase_revenue || 0),
          addToCarts: Number(r.add_to_carts || 0),
          checkouts: Number(r.begin_checkouts || 0),
        };
      });
    } catch (e) { return []; }
  }

  async function fetchDailyKlaviyo(sb, brandId) {
    try {
      // Multiple metrics per day → crosses the 1000-row cap on long histories; paginate.
      const data = await fetchAllPaged((from, to) => sb.from('tenant_klaviyo_metrics_daily')
        .select('date, metric_id, metric_name, value, unit')
        .eq('brand_id', brandId)
        .order('date', { ascending: true })
        .order('metric_id', { ascending: true })
        .range(from, to));
      // Pivot: one row per date with email engagement + placed_order count + value.
      // Was dropping Received/Opened/Clicked Email entirely → sends/opens/open-rate all read 0.
      const byDate = {};
      for (const r of (data || [])) {
        const k = r.date;
        const a = byDate[k] = byDate[k] || { date: r.date, recipients: 0, opens: 0, clicks: 0, orders: 0, orderValue: 0 };
        switch (r.metric_name) {
          case 'Received Email':     a.recipients = Number(r.value || 0); break;
          case 'Opened Email':       a.opens      = Number(r.value || 0); break;
          case 'Clicked Email':      a.clicks     = Number(r.value || 0); break;
          case 'Placed Order':       a.orders     = Number(r.value || 0); break;
          case 'Placed Order Value': a.orderValue = Number(r.value || 0); break;
        }
      }
      return Object.values(byDate).sort((a, b) => a.date < b.date ? -1 : 1).map(a => ({
        ...a,
        openRate: a.recipients > 0 ? a.opens / a.recipients : 0,
        clickRate: a.recipients > 0 ? a.clicks / a.recipients : 0,
      }));
    } catch (e) { return []; }
  }

  async function fetchRecentSyncLog(sb, brandId) {
    try {
      // First find this brand's connection IDs
      const { data: conns } = await sb.from('connections').select('id').eq('brand_id', brandId);
      if (!conns || conns.length === 0) return [];
      const ids = conns.map(c => c.id);
      const { data } = await sb.from('connection_sync_log')
        .select('connection_id, resource, status, rows_synced, started_at, finished_at, error_message')
        .in('connection_id', ids)
        .order('started_at', { ascending: false })
        .limit(10);
      return data || [];
    } catch (e) { return []; }
  }

  // ── UI: freshness indicator ──────────────────────────────────────────────

  function setStatus(status, error) {
    window.FRKL_LIVE.status = status;
    window.FRKL_LIVE.lastError = error;
    window.FRKL_LIVE.enabled = (status === 'live');
    renderIndicator();
  }

  function renderIndicator() {
    let host = document.getElementById('frkl-live-indicator');
    if (!host) {
      host = document.createElement('div');
      host.id = 'frkl-live-indicator';
      host.style.cssText = `
        position: fixed; top: 14px; right: 18px; z-index: 9999;
        display: inline-flex; align-items: center; gap: 7px;
        padding: 5px 11px; border-radius: 999px;
        font: 500 11px/1 'Inter', -apple-system, sans-serif;
        letter-spacing: .01em; cursor: help; user-select: none;
        backdrop-filter: blur(8px);
        transition: background 200ms ease, border-color 200ms ease;
      `;
      document.body.appendChild(host);
    }

    const status = window.FRKL_LIVE.status;
    const lastFetch = window.FRKL_LIVE.lastFetchAt;
    const ageMs = lastFetch ? Date.now() - lastFetch.getTime() : null;
    let ageLabel = lastFetch ? formatAge(ageMs) : null;

    // Determine effective status (live but stale > 5 min → stale)
    let effective = status;
    if (status === 'live' && ageMs > 5 * 60 * 1000) effective = 'stale';

    const styles = {
      'initialising': { bg: 'rgba(126,126,138,0.10)', border: 'rgba(126,126,138,0.3)', dot: '#7e7e8a', text: '#b1b1bc', label: 'Initialising…' },
      'static-only':  { bg: 'rgba(126,126,138,0.10)', border: 'rgba(126,126,138,0.3)', dot: '#7e7e8a', text: '#b1b1bc', label: 'Static · log in for live' },
      'live':         { bg: 'rgba(74,222,128,0.10)',  border: 'rgba(74,222,128,0.35)', dot: '#4ade80', text: '#4ade80', label: `Live · ${ageLabel || 'fresh'}`,  pulse: true },
      'stale':        { bg: 'rgba(245,181,68,0.10)',  border: 'rgba(245,181,68,0.35)', dot: '#f5b544', text: '#f5b544', label: `Stale · ${ageLabel || ''}` },
      'error':        { bg: 'rgba(239,107,111,0.10)', border: 'rgba(239,107,111,0.35)', dot: '#ef6b6f', text: '#ef6b6f', label: 'Live data error' },
    };
    const s = styles[effective] || styles['static-only'];

    host.style.background = s.bg;
    host.style.border = `1px solid ${s.border}`;
    host.style.color = s.text;
    host.style.cursor = 'pointer';
    host.title = window.FRKL_LIVE.needsLogin
      ? `${s.label}\nClick to log in for live data`
      : window.FRKL_LIVE.lastError
        ? `${s.label} · ${window.FRKL_LIVE.lastError}`
        : `${s.label}\nLast fetch: ${lastFetch ? lastFetch.toLocaleString() : 'never'}\nClick for details`;
    host.onclick = () => {
      // No session → the pill is the login entry. Same-origin magic-link login, returns here via ?next.
      if (window.FRKL_LIVE.needsLogin && window.FRKL_LIVE.loginUrl) {
        window.location.href = window.FRKL_LIVE.loginUrl;
        return;
      }
      console.log('[frkl-live]', JSON.parse(JSON.stringify({
        status: window.FRKL_LIVE.status,
        lastFetchAt: window.FRKL_LIVE.lastFetchAt,
        lastError: window.FRKL_LIVE.lastError,
        brandId: window.FRKL_LIVE.brandId,
        connections: window.FRKL_LIVE.connections,
        recent_sync: window.FRKL_LIVE.recent_sync,
      })));
      alert(`Live status: ${s.label}\n\nLast fetch: ${lastFetch ? lastFetch.toLocaleString() : 'never'}\n${window.FRKL_LIVE.lastError ? '\nError: ' + window.FRKL_LIVE.lastError : ''}\n\nFull state logged to console.`);
    };

    host.innerHTML = `
      <span style="display:inline-block; width:7px; height:7px; border-radius:999px; background:${s.dot}; ${s.pulse ? 'animation: frkl-pulse 1.6s ease-in-out infinite;' : ''}"></span>
      <span>${s.label}</span>
    `;

    // Inject keyframes once
    if (!document.getElementById('frkl-live-keyframes')) {
      const style = document.createElement('style');
      style.id = 'frkl-live-keyframes';
      style.textContent = `@keyframes frkl-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(0.8); } }`;
      document.head.appendChild(style);
    }
  }

  function formatAge(ms) {
    if (ms == null) return '';
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  }

  function dispatchUpdate() {
    window.dispatchEvent(new CustomEvent('frkl-data-updated', {
      detail: { at: window.FRKL_LIVE.lastFetchAt, status: window.FRKL_LIVE.status },
    }));
  }

  // ── Continuous freshness re-render so "30s ago" → "31s ago" smoothly ──
  setInterval(renderIndicator, 5000);

  // Boot once the DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();

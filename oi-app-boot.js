// oi-app-boot.js — authenticated multi-tenant bootstrap for the OI workspace.
//
// This is the integration layer that turns the (brand-agnostic) dashboard into a
// real multi-tenant app: it authenticates the user, resolves the brand they belong
// to, fetches THAT brand's live bundle from `brand-data` with the user's JWT, and
// injects it into the globals the dashboard reads — then boots the dashboard.
//
// The backend it depends on is DONE + verified:
//   • brand-data (JWT + brand_users membership, returns the channel bundle + brand_config)
//   • ask-data   (JWT + membership, key server-side)
//   • brand_config (per-tenant gross margin / costs / benchmarks / seasonality)
//
// Load order in the workspace shell:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="/oi-app-boot.js"></script>     ← then the dashboard scripts
//
// NOTE: this runs only in the authenticated workspace (a real Supabase session).
// The public static demo doesn't load it, so the demo is unaffected.

(async function () {
  const OI = window.OI_ENV || {};                 // {supabaseUrl, anonKey, functionsBase}
  if (!OI.supabaseUrl || !window.supabase) { console.warn('[oi-boot] no OI_ENV / supabase-js — skipping (demo mode)'); return; }

  const sb = window.supabase.createClient(OI.supabaseUrl, OI.anonKey);

  // 1. Session (else send to login).
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { location.href = '/auth/login.html?next=' + encodeURIComponent(location.pathname); return; }
  const jwt = session.access_token;

  // 2. Resolve the user's brand(s). RLS scopes brand_users to the caller. A stored
  //    selection (multi-brand / agency) wins; else the first.
  const { data: memberships } = await sb.from('brand_users').select('brand_id, role, brands(name)').order('created_at');
  if (!memberships || !memberships.length) { location.href = '/auth/workspace.html'; return; }  // no brand yet → onboarding
  const stored = localStorage.getItem('oi_brand');
  const chosen = memberships.find(m => m.brand_id === stored) || memberships[0];
  const brandId = chosen.brand_id;
  window.OI_BRAND = { id: brandId, name: chosen.brands?.name, role: chosen.role, memberships };

  // 3. Fetch this brand's live bundle (JWT-authenticated, membership-enforced server-side).
  const fnBase = OI.functionsBase || (OI.supabaseUrl + '/functions/v1');
  let bundle;
  try {
    const r = await fetch(fnBase + '/brand-data', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + jwt },
      body: JSON.stringify({ brand_id: brandId, days: 150 }),
    });
    bundle = await r.json();
    if (bundle.error) throw new Error(bundle.error);
  } catch (e) {
    document.body.innerHTML = '<div style="padding:40px;font-family:Inter,sans-serif;color:#e8e8ec;background:#08080b;min-height:100vh">Couldn\'t load your data: ' + (e.message || e) + '</div>';
    return;
  }

  // 4. Inject into the globals the dashboard reads (same shapes as the static snapshot).
  window.FRKL_DATA = {
    shopify: bundle.shopify || [], metaDaily: bundle.metaDaily || [], googleAds: bundle.googleAds || [],
    ga4: bundle.ga4 || [], klaviyo: bundle.klaviyo || [],
    meta: { captured: bundle.captured, brand: window.OI_BRAND.name, range: { start: bundle.since } },
  };
  window.FRKL_EVENTS = bundle.events || [];

  // Per-tenant config → the dashboard's gross margin + cost inputs + benchmarks + seasonality.
  const cfg = bundle.config || {};
  window.OI_CONFIG = { grossMargin: cfg.gross_margin, benchmarks: cfg.benchmarks || {}, vertical: cfg.vertical };
  if (cfg.gross_margin != null) {                  // make config margin authoritative (dashboard prefers OI_CONFIG.grossMargin)
    window.FRKL_BUSINESS = window.FRKL_BUSINESS || {};
    window.FRKL_BUSINESS.products = [{ grossProfit: cfg.gross_margin, netSales: 1, units: 0, returns: 0 }];
  }
  try {
    if (cfg.variable_costs && Object.keys(cfg.variable_costs).length) {
      const vc = cfg.variable_costs;
      localStorage.setItem('frkl-contrib-inputs', JSON.stringify({
        packaging: String(vc.packaging ?? ''), fulfilment: String(vc.fulfilment ?? ''), shipping: String(vc.shipping ?? ''),
        payPct: String(vc.payPct ?? ''), payFixed: String(vc.payFixed ?? ''), refundPct: String(vc.refundPct ?? ''),
      }));
    }
    if (Array.isArray(cfg.seasonality) && cfg.seasonality.length === 12) {
      const fc = JSON.parse(localStorage.getItem('frkl-forecast-inputs') || '{}');
      cfg.seasonality.forEach((v, i) => { fc['seas' + i] = String(v); });
      localStorage.setItem('frkl-forecast-inputs', JSON.stringify(fc));
    }
  } catch (e) { /* ignore */ }

  // Channel freshness/source flags (Google estimated etc. become per-tenant later).
  window.FRKL_SOURCES = window.FRKL_SOURCES || {};

  // 5. Point the Ask panel at the server-side relay, authenticated as this user.
  window.OI_ASK = { endpoint: fnBase + '/ask-data', token: '', jwt, brand_id: brandId };
  // (ask-data accepts Authorization: Bearer + brand_id; AskPanel sends those — see note below)

  window.OI_READY = true;
  console.log('[oi-boot] booted brand', window.OI_BRAND.name, 'sources', bundle.sources);
})();

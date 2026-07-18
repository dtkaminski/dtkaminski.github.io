import { jsxDEV as _jsxDEV, Fragment as _Fragment } from "react/jsx-dev-runtime";
/* dashboard_app.jsx — the complete Today + Calendar app (single self-contained source file).
 *
 * MERGED 2026-07-13: this file used to contain its own older, stale copy of the `Today`
 * component (pre-UI_V2) alongside the Calendar/Nav/Shell/mount code. `Today.jsx` had since
 * become the actively-maintained source for the UI_V2 Today component (dual CM lines, typed
 * empty states, tier chips, stock section, Proven strip — 2026-07-12 review), but was never
 * re-integrated back into this file, so the live bundle (today.app.js) and this source had
 * drifted apart with duplicate/conflicting declarations (both files declared `useState`,
 * `tdyMoney`, `tdyPri`, `TDY_ORIGIN`, etc. as `const` — concatenating them naively throws
 * "Identifier has already been declared"). This merge:
 *   - Keeps this file's `tdyDefaultFetcher`, `tdyMoney`, `tdyPri`, `TDY_ORIGIN`, `tdyOrigin`,
 *     `TdyRow`, `DataCoverage` (byte-identical or functionally identical to Today.jsx's versions
 *     — no need to duplicate).
 *   - Pulls in Today.jsx's UNIQUE additions: `TDY_V2`, `tdyPhi`, `tdyCmSrc`,
 *     `tdyQuarterBounds`, `TdyTargetsForm`, and the new `Today` function body.
 *   - Re-inserts `<DataCoverage brandId={brandId} />` into the new Today (Today.jsx's version
 *     had dropped it — a regression this merge fixes, since Today.jsx was written without
 *     awareness this file already had it wired in).
 *   - Leaves the Calendar component (already UI_V2-updated with vw_event_actualisation),
 *     EventDrawer, Nav, Shell, and the mount call untouched.
 *
 * `Today.jsx` should be treated as SUPERSEDED by this file going forward — this is now the
 * single source of truth. Do not edit Today.jsx and this file independently again; if
 * Today-specific work continues, edit the `Today` function inside this file directly.
 *
 * EMBED-SAFE 2026-07-13: this same source now serves TWO deploy targets, because Today/Calendar
 * were originally shipped only as a disconnected standalone app (today.html on Netlify) and were
 * never wired into the actual live Operator Intelligence dashboard the way Command Centre was
 * (see marketing-os/README.md's "Live SPA integration" section — Command Centre was transpiled
 * into a `window.CommandCentre`/`window.DecisionLog` bundle and added as a nav tab in the
 * `Business/frkl/_deploy` repo's `greta-app.jsx`). Today/Calendar are meant to upgrade/supersede
 * that dashboard, not sit beside it as a separate app, so this file is now embed-aware:
 *   - `sbClient()` resolves the Supabase client from `window.sb` (standalone) OR
 *     `window.FRKL_LIVE.sb` (the client greta-data-loader.js already exposes when this bundle is
 *     embedded in greta-dashboard.html) — Calendar/EventDrawer/DataCoverage use this instead of
 *     a hardcoded `window.sb`.
 *   - `window.Today` / `window.Calendar` are always exposed as plain components (same pattern as
 *     Command Centre's `window.CommandCentre`), so a host page's own `mosView('Today')` can render
 *     them with ITS OWN auth/brandId — no Shell/auth duplication.
 *   - The self-mount (`<Shell/>` into `#root`) only fires when `window.MOS_EMBEDDED` is NOT set,
 *     so the standalone today.html deploy is completely unaffected; the host page sets
 *     `window.MOS_EMBEDDED = true` before loading this bundle to suppress it.
 *
 * Build (identical output serves both targets):
 * `npx babel dashboard_app.jsx --presets @babel/preset-react -o today.app.js`
 * (single file in, single file out — no concatenation, no ordering to get wrong). Copy/rename the
 * same output file for the `_deploy` repo (see DEPLOY-RUNBOOK section for Today/Calendar).
 */
(function () {
  const {
    useState,
    useEffect,
    useCallback,
    useMemo,
    useRef
  } = React;

  // EMBED-SAFE 2026-07-13: resolves the live Supabase client whether this bundle is running
  // standalone (today.html sets window.sb before this script loads) or embedded as a nav tab
  // inside greta-dashboard.html (greta-data-loader.js exposes its client at window.FRKL_LIVE.sb,
  // not window.sb). Falls back to window.sb first so the standalone deployment is untouched.
  function sbClient() {
    if (typeof window === 'undefined') return null;
    return window.sb || window.FRKL_LIVE && window.FRKL_LIVE.sb || null;
  }
  function tdyDefaultFetcher(apiBase, getToken) {
    return async (action, args = {}) => {
      const token = getToken ? await getToken() : window.OI_GET_TOKEN && (await window.OI_GET_TOKEN());
      const res = await fetch((apiBase || window.OI_API_BASE) + '/functions/v1/marketing-os', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token
        },
        body: JSON.stringify({
          action,
          ...args
        })
      });
      if (!res.ok) throw new Error('marketing-os ' + action + ' failed: ' + res.status);
      return res.json();
    };
  }
  const tdyMoney = (v, cur = '£') => v == null ? '—' : cur + Math.round(v).toLocaleString();
  const tdyPri = p => p === 'P1' ? 'tdy-p1' : p === 'P2' ? 'tdy-p2' : 'tdy-p3';
  const TDY_ORIGIN = {
    synthetic: 'signal',
    creative: 'creative',
    measurement: 'measurement',
    seed: 'action',
    forecast: 'forecast'
  };
  function tdyOrigin(a) {
    if ((a.external_id || '').startsWith('greta_forecast')) return 'forecast';
    return TDY_ORIGIN[a.origin] || 'action';
  }

  /* UI_V2 (2026-07-12 review, P0): both CM lines + typed empty states + tier chips + £ provenance.
     Reversible: set window.GRETA_UI_V2 = false before load to restore the previous rendering. */
  const TDY_V2 = typeof window === 'undefined' || window.GRETA_UI_V2 !== false;
  // φ provenance — a normalized iROAS must NEVER render without saying whether φ was measured or assumed.
  const tdyPhi = s => s && String(s).indexOf('measured') === 0 ? 'measured' : 'benchmark φ · not measured';
  // CM confidence label from vw_brand_readiness.cm_source (fit_engine = fitted, config_estimate = from cost inputs).
  const tdyCmSrc = s => s === 'fit_engine' ? 'measured economics' : s === 'config_estimate' ? 'estimated from your cost inputs' : null;

  // Shared with the hero-action gate check below — a scale-type action is any action whose text
  // matches this pattern, regardless of where in the queue it renders.
  const TDY_SCALE_RE = /\b(scale|open bids|raise|increase|budget|spend)\b/i;
  function TdyRow(props) {
    const a = props.a;
    // 2026-07-13 fix (build order 3, §6 audit): the S3 stock gate previously only rendered on the
    // hero action — a scale action further down the queue could appear un-gated while the hero one
    // was correctly blocked. Same check, same gate data, now applied to every row.
    const gate = props.stock && props.stock.gate;
    const isScale = TDY_SCALE_RE.test(a.description || '');
    return /*#__PURE__*/_jsxDEV("div", {
      className: "tdy-row tdy-pop-host",
      children: [/*#__PURE__*/_jsxDEV("span", {
        className: "tdy-rank",
        children: props.rank
      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-row-body",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "tdy-row-title",
          children: a.description
        }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-row-meta",
          children: [a.owner || '—', " · ", tdyOrigin(a), a.category ? ' · ' + a.category : '']
        }, void 0, true), isScale && gate && gate.status === 'blocked' && /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-row-gate tdy-gate-blocked",
          children: ["⛔ S3: ", gate.detail]
        }, void 0, true), isScale && gate && gate.status === 'warn' && /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-row-gate tdy-gate-warn",
          children: ["⚠ S3: ", gate.detail]
        }, void 0, true)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("span", {
        className: 'tdy-badge ' + tdyPri(a.priority),
        children: a.priority
      }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
        className: "tdy-row-cm",
        children: tdyMoney(a.cm_gbp)
      }, void 0, false), /*#__PURE__*/_jsxDEV("button", {
        className: "tdy-linkbtn",
        disabled: props.busy,
        onClick: () => props.onDone(a.external_id),
        title: "Mark done",
        children: "done"
      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-pop",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "tdy-pop-head",
          children: ["Action #", props.rank, " · what this is"]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          style: {
            fontSize: 'var(--text-xs)',
            color: 'var(--color-muted)',
            lineHeight: 1.5
          },
          children: a.description
        }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-pop-row",
          children: [/*#__PURE__*/_jsxDEV("span", {
            children: "CM impact"
          }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
            children: [tdyMoney(a.cm_gbp), "/mo"]
          }, void 0, true)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-pop-row",
          children: [/*#__PURE__*/_jsxDEV("span", {
            children: "Priority"
          }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
            children: a.priority
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-pop-row",
          children: [/*#__PURE__*/_jsxDEV("span", {
            children: "Owner"
          }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
            children: a.owner || '—'
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-pop-row",
          children: [/*#__PURE__*/_jsxDEV("span", {
            children: "Signal"
          }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
            children: tdyOrigin(a)
          }, void 0, false)]
        }, void 0, true), a.category && /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-pop-row",
          children: [/*#__PURE__*/_jsxDEV("span", {
            children: "Area"
          }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
            children: a.category
          }, void 0, false)]
        }, void 0, true)]
      }, void 0, true)]
    }, void 0, true);
  }
  const DC_LABELS = {
    connections: 'Connections',
    channel_incrementality: 'Incrementality φ',
    creative_demand: 'Creative',
    calendar_learning: 'Calendar learning',
    customer_l2: 'Customers',
    email_attribution: 'Email/SMS'
  };
  function DataCoverage(props) {
    const [rows, setRows] = useState(null);
    const [open, setOpen] = useState(false);
    useEffect(() => {
      let alive = true;
      (async () => {
        const sb = sbClient();
        if (!sb || !props.brandId) return;
        const r = await sb.from('vw_brand_data_readiness').select('capability,status,headline,detail,basis,sort_order').eq('brand_id', props.brandId).order('sort_order');
        if (alive && !r.error) setRows(r.data || []);
      })();
      return () => {
        alive = false;
      };
    }, [props.brandId]);
    if (!rows || !rows.length) return null;
    const ready = rows.filter(r => r.status === 'ready').length;
    const attn = rows.length - ready;
    return /*#__PURE__*/_jsxDEV("div", {
      className: "dc",
      children: [/*#__PURE__*/_jsxDEV("div", {
        className: "dc-head",
        onClick: () => setOpen(o => !o),
        children: [/*#__PURE__*/_jsxDEV("span", {
          className: "dc-title",
          children: "Data coverage"
        }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
          className: "dc-sum",
          children: [ready, "/", rows.length, " ready", attn ? ' · ' + attn + ' to improve' : '']
        }, void 0, true), /*#__PURE__*/_jsxDEV("span", {
          className: "dc-caret",
          children: open ? '▾' : '▸'
        }, void 0, false)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
        className: "dc-chips",
        children: rows.map(r => /*#__PURE__*/_jsxDEV("span", {
          className: 'dc-chip dc-' + r.status,
          title: r.detail,
          children: [/*#__PURE__*/_jsxDEV("i", {
            className: "dc-dot"
          }, void 0, false), DC_LABELS[r.capability] || r.capability, r.basis === 'benchmark' && /*#__PURE__*/_jsxDEV("em", {
            className: "dc-basis",
            children: "benchmark"
          }, void 0, false)]
        }, r.capability, true))
      }, void 0, false), open && /*#__PURE__*/_jsxDEV("div", {
        className: "dc-detail",
        children: rows.map(r => /*#__PURE__*/_jsxDEV("div", {
          className: "dc-drow",
          children: [/*#__PURE__*/_jsxDEV("span", {
            className: 'dc-dot dc-' + r.status
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            children: [/*#__PURE__*/_jsxDEV("div", {
              className: "dc-drow-h",
              children: [/*#__PURE__*/_jsxDEV("b", {
                children: DC_LABELS[r.capability] || r.capability
              }, void 0, false), " — ", r.headline, r.basis ? ' · ' + r.basis : '']
            }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
              className: "dc-drow-d",
              children: r.detail
            }, void 0, false)]
          }, void 0, true)]
        }, r.capability, true))
      }, void 0, false)]
    }, void 0, true);
  }

  // Current-quarter bounds (UTC) for a sensible default period.
  function tdyQuarterBounds(d) {
    d = d || new Date();
    const y = d.getUTCFullYear(),
      q = Math.floor(d.getUTCMonth() / 3);
    return {
      start: new Date(Date.UTC(y, q * 3, 1)).toISOString().slice(0, 10),
      end: new Date(Date.UTC(y, q * 3 + 3, 0)).toISOString().slice(0, 10)
    };
  }

  /* The owner's target-metrics form. Pre-fills from the latest goal (incl. the auto-derived
     PROVISIONAL one, so the operator accepts/adjusts rather than typing from scratch), then
     writes a CONFIRMED plan via create_goal. cm_basis is explicit so pace is never ambiguous. */
  function TdyTargetsForm(props) {
    const {
      brandId,
      fetcher,
      onSaved,
      onCancel
    } = props;
    const [f, setF] = useState(null);
    const [prov, setProv] = useState(false);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    useEffect(() => {
      let alive = true;
      (async () => {
        let goal = null;
        try {
          const r = await fetcher('list_goals', {
            brandId
          });
          goal = (r.goals || [])[0] || null;
        } catch (_) {/* fall back to blank */}
        if (!alive) return;
        const qb = tdyQuarterBounds();
        setProv(!!goal && goal.confirmed === false);
        setF({
          periodStart: goal && goal.period_start || qb.start,
          periodEnd: goal && goal.period_end || qb.end,
          revenueTarget: goal && goal.revenue_target != null ? goal.revenue_target : '',
          contributionMarginTarget: goal && goal.contribution_margin_target != null ? goal.contribution_margin_target : '',
          spendCap: goal && goal.spend_cap != null ? goal.spend_cap : '',
          merTarget: goal && goal.mer_target != null ? goal.mer_target : '',
          newCustomerTarget: goal && goal.new_customer_target != null ? goal.new_customer_target : '',
          returningRevenueTarget: goal && goal.returning_revenue_target != null ? goal.returning_revenue_target : '',
          cmBasis: goal && goal.cm_basis || 'after_marketing'
        });
      })();
      return () => {
        alive = false;
      };
    }, [brandId, fetcher]);
    if (!f) return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-empty",
      children: "Loading targets…"
    }, void 0, false);
    const set = k => e => setF(Object.assign({}, f, {
      [k]: e.target.value
    }));
    const num = v => v === '' || v == null ? null : Number(v);
    const submit = async e => {
      e.preventDefault();
      setSaving(true);
      setError(null);
      try {
        await fetcher('create_goal', {
          brandId,
          periodStart: f.periodStart,
          periodEnd: f.periodEnd,
          revenueTarget: num(f.revenueTarget),
          contributionMarginTarget: num(f.contributionMarginTarget),
          spendCap: num(f.spendCap),
          merTarget: num(f.merTarget),
          newCustomerTarget: num(f.newCustomerTarget),
          returningRevenueTarget: num(f.returningRevenueTarget),
          cmBasis: f.cmBasis,
          notes: 'Set by owner'
        });
        onSaved && onSaved();
      } catch (err) {
        setError(String(err && err.message ? err.message : err));
        setSaving(false);
      }
    };
    return /*#__PURE__*/_jsxDEV("form", {
      className: "tdy-targets",
      onSubmit: submit,
      children: [prov && /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-targets-hint",
        children: "These are auto-estimated from your last 90 days. Adjust and confirm to make them your plan of record."
      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-targets-grid",
        children: [/*#__PURE__*/_jsxDEV("label", {
          children: ["Quarter start", /*#__PURE__*/_jsxDEV("input", {
            type: "date",
            value: f.periodStart,
            onChange: set('periodStart')
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("label", {
          children: ["Quarter end", /*#__PURE__*/_jsxDEV("input", {
            type: "date",
            value: f.periodEnd,
            onChange: set('periodEnd')
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("label", {
          children: ["Revenue target (£)", /*#__PURE__*/_jsxDEV("input", {
            type: "number",
            value: f.revenueTarget,
            onChange: set('revenueTarget')
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("label", {
          children: ["Contribution-margin target (£)", /*#__PURE__*/_jsxDEV("input", {
            type: "number",
            value: f.contributionMarginTarget,
            onChange: set('contributionMarginTarget')
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("label", {
          children: ["Spend cap (£)", /*#__PURE__*/_jsxDEV("input", {
            type: "number",
            value: f.spendCap,
            onChange: set('spendCap')
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("label", {
          children: ["MER target (×)", /*#__PURE__*/_jsxDEV("input", {
            type: "number",
            step: "0.1",
            value: f.merTarget,
            onChange: set('merTarget')
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("label", {
          children: ["New-customer target", /*#__PURE__*/_jsxDEV("input", {
            type: "number",
            value: f.newCustomerTarget,
            onChange: set('newCustomerTarget')
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("label", {
          children: ["Returning-revenue target (£)", /*#__PURE__*/_jsxDEV("input", {
            type: "number",
            value: f.returningRevenueTarget,
            onChange: set('returningRevenueTarget')
          }, void 0, false)]
        }, void 0, true)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("fieldset", {
        className: "tdy-targets-basis",
        children: [/*#__PURE__*/_jsxDEV("legend", {
          children: "What does your CM target mean?"
        }, void 0, false), /*#__PURE__*/_jsxDEV("label", {
          children: [/*#__PURE__*/_jsxDEV("input", {
            type: "radio",
            name: "cmBasis",
            checked: f.cmBasis === 'after_marketing',
            onChange: () => setF(Object.assign({}, f, {
              cmBasis: 'after_marketing'
            }))
          }, void 0, false), " After marketing — revenue × margin − ad spend (true profit)"]
        }, void 0, true), /*#__PURE__*/_jsxDEV("label", {
          children: [/*#__PURE__*/_jsxDEV("input", {
            type: "radio",
            name: "cmBasis",
            checked: f.cmBasis === 'product_contribution',
            onChange: () => setF(Object.assign({}, f, {
              cmBasis: 'product_contribution'
            }))
          }, void 0, false), " Product contribution — revenue × margin, before ad spend"]
        }, void 0, true)]
      }, void 0, true), error && /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-targets-err",
        children: ["Couldn't save — ", error]
      }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-targets-btns",
        children: [/*#__PURE__*/_jsxDEV("button", {
          type: "submit",
          className: "tdy-btn tdy-btn-go",
          disabled: saving,
          children: saving ? 'Saving…' : 'Confirm as plan'
        }, void 0, false), onCancel && /*#__PURE__*/_jsxDEV("button", {
          type: "button",
          className: "tdy-btn",
          onClick: onCancel,
          disabled: saving,
          children: "Cancel"
        }, void 0, false)]
      }, void 0, true)]
    }, void 0, true);
  }
  function Today(props) {
    const brandId = props.brandId || typeof window !== 'undefined' && window.OI_BRAND;
    // 2026-07-13 fix: tdyDefaultFetcher(...) was called unmemoized on every render, creating a new
    // function reference each time. That flowed into load's useCallback deps -> load itself changed
    // identity every render -> the effect below (deps: [load]) refired every render -> setData ->
    // re-render -> repeat, forever. Confirmed live: hundreds of duplicate OPTIONS preflights per
    // second hitting the marketing-os edge function (one even timed out at 10s), which is what made
    // Daily Ops feel "incredibly slow" once Today/Calendar were actually mounted for the first time.
    const fetcher = useMemo(() => props.fetcher || tdyDefaultFetcher(props.apiBase, props.getToken), [props.fetcher, props.apiBase, props.getToken]);
    const [data, setData] = useState(null);
    const [err, setErr] = useState(null);
    const [busy, setBusy] = useState(null);
    const [editTargets, setEditTargets] = useState(false);
    const load = useCallback(async () => {
      setErr(null);
      try {
        setData(await fetcher('brand_headline', {
          brandId
        }));
      } catch (e) {
        setErr(String(e && e.message ? e.message : e));
      }
    }, [brandId, fetcher]);
    useEffect(() => {
      load();
    }, [load]);
    const act = async (action, ext) => {
      setBusy(ext);
      try {
        await fetcher(action, {
          brandId,
          external_id: ext
        });
        await load();
      } finally {
        setBusy(null);
      }
    };
    if (err) return /*#__PURE__*/_jsxDEV("div", {
      className: "tdy",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: ["Couldn't load today — ", err]
      }, void 0, true)
    }, void 0, false);
    if (!data) return /*#__PURE__*/_jsxDEV("div", {
      className: "tdy",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: "Loading…"
      }, void 0, false)
    }, void 0, false);
    const h = data.headline || {};
    const acts = data.actions || [];
    const rd = data.readiness || {};
    const channels = data.channels || [];
    const saturation = data.saturation || [];
    const cmSrcLabel = tdyCmSrc(h.cm_source);
    const top = acts[0];
    const rest = acts.slice(1);
    const pace = h.pace_pct;
    const planStatus = h.plan_status || 'none';
    const paceCls = pace == null ? 'mos-muted' : pace >= 100 ? 'mos-pos' : pace >= 90 ? 'mos-warn' : 'tdy-behind';
    const barW = pace == null ? 0 : Math.max(0, Math.min(100, pace));
    return /*#__PURE__*/_jsxDEV("div", {
      className: "tdy",
      children: [/*#__PURE__*/_jsxDEV("div", {
        className: "tdy-head",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "tdy-title",
          children: "Today"
        }, void 0, false), h.period_end && /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-period",
          children: ["quarter to ", h.period_end]
        }, void 0, true)]
      }, void 0, true), rd.can_show_cm === false ? /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-plan tdy-gate",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "tdy-plan-label",
          children: "Contribution margin · this month vs plan"
        }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-gate-msg",
          children: rd.gate_message || 'Connect economics (COGS + variable costs) to unlock CM & ranked actions.'
        }, void 0, false)]
      }, void 0, true) : /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-plan tdy-pop-host",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "tdy-plan-label",
          children: ["Contribution margin · this month vs plan", cmSrcLabel ? /*#__PURE__*/_jsxDEV("span", {
            className: "tdy-cmsrc",
            children: [" · ", cmSrcLabel]
          }, void 0, true) : null]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-plan-row",
          children: [/*#__PURE__*/_jsxDEV("span", {
            className: "tdy-plan-num",
            children: tdyMoney(h.cm_actual_30d)
          }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
            className: "tdy-plan-of",
            children: ["of ", tdyMoney(h.cm_target_monthly), " target"]
          }, void 0, true), pace != null && /*#__PURE__*/_jsxDEV("span", {
            className: 'tdy-pace ' + paceCls,
            children: [pace, "% of plan"]
          }, void 0, true)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-bar",
          children: /*#__PURE__*/_jsxDEV("i", {
            style: {
              width: barW + '%'
            },
            className: paceCls
          }, void 0, false)
        }, void 0, false), TDY_V2 && h.cm_after_marketing_30d != null && h.product_contribution_30d != null && /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-plan-otherline tdy-muted",
          children: (h.cm_basis || 'after_marketing') === 'after_marketing' ? tdyMoney(h.product_contribution_30d) + ' before marketing (product contribution)' : tdyMoney(h.cm_after_marketing_30d) + ' after marketing (true profit)'
        }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-plan-sub",
          children: pace != null && pace < 100 ? 'Behind pace — the actions below close the gap, biggest contribution first.' : pace != null ? 'On or ahead of plan — keep the highest-contribution actions moving.' : planStatus === 'provisional' ? 'Pace hidden until you confirm targets — the current goal is auto-estimated.' : 'Set targets to see pace against your plan.'
        }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-pop",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop-head",
            children: "Contribution margin · what this is"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            style: {
              fontSize: 'var(--text-xs)',
              color: 'var(--color-muted)',
              lineHeight: 1.5
            },
            children: "Profit after product costs and ad spend, measured against your monthly plan. The line shows daily CM over the last 30 days."
          }, void 0, false), h.cm_series && h.cm_series.length > 1 && (() => {
            const RC = typeof window !== 'undefined' && window.Recharts || null;
            return RC ? /*#__PURE__*/_jsxDEV(RC.ResponsiveContainer, {
              width: "100%",
              height: 90,
              children: /*#__PURE__*/_jsxDEV(RC.LineChart, {
                data: h.cm_series,
                margin: {
                  top: 4,
                  right: 6,
                  left: -6,
                  bottom: 0
                },
                children: [/*#__PURE__*/_jsxDEV(RC.CartesianGrid, {
                  stroke: "var(--color-line)",
                  vertical: false
                }, void 0, false), /*#__PURE__*/_jsxDEV(RC.XAxis, {
                  dataKey: "d",
                  tick: {
                    fill: 'var(--color-muted)',
                    fontSize: 8
                  },
                  interval: "preserveStartEnd",
                  tickLine: false,
                  axisLine: false
                }, void 0, false), /*#__PURE__*/_jsxDEV(RC.YAxis, {
                  tick: {
                    fill: 'var(--color-muted)',
                    fontSize: 8
                  },
                  width: 30,
                  tickFormatter: v => Math.abs(v) >= 1000 ? (v / 1000).toFixed(0) + 'k' : Math.round(v)
                }, void 0, false), /*#__PURE__*/_jsxDEV(RC.Tooltip, {
                  contentStyle: {
                    fontSize: 10,
                    background: 'var(--color-panel)',
                    border: '1px solid var(--color-line)',
                    borderRadius: 6,
                    padding: '2px 6px'
                  },
                  formatter: v => ['£' + Math.round(v), 'CM/day']
                }, void 0, false), /*#__PURE__*/_jsxDEV(RC.Line, {
                  type: "monotone",
                  dataKey: "v",
                  stroke: "#8B5CF6",
                  strokeWidth: 2,
                  dot: false,
                  isAnimationActive: false
                }, void 0, false)]
              }, void 0, true)
            }, void 0, false) : null;
          })(), h.product_contribution_30d != null && /*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop-row",
            children: [/*#__PURE__*/_jsxDEV("span", {
              children: "Product contribution (before mktg)"
            }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
              children: tdyMoney(h.product_contribution_30d)
            }, void 0, false)]
          }, void 0, true), h.cm_after_marketing_30d != null && /*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop-row",
            children: [/*#__PURE__*/_jsxDEV("span", {
              children: "After marketing (true profit)"
            }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
              children: tdyMoney(h.cm_after_marketing_30d)
            }, void 0, false)]
          }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop-row",
            children: [/*#__PURE__*/_jsxDEV("span", {
              children: "Monthly target"
            }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
              children: tdyMoney(h.cm_target_monthly)
            }, void 0, false)]
          }, void 0, true), pace != null && /*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop-row",
            children: [/*#__PURE__*/_jsxDEV("span", {
              children: "Pace vs plan"
            }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
              children: [pace, "%"]
            }, void 0, true)]
          }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop-row",
            children: [/*#__PURE__*/_jsxDEV("span", {
              children: "Basis"
            }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
              children: (h.cm_basis || 'after_marketing') === 'product_contribution' ? 'product contribution' : 'after marketing'
            }, void 0, false)]
          }, void 0, true), cmSrcLabel && /*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop-row",
            children: [/*#__PURE__*/_jsxDEV("span", {
              children: "Source"
            }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
              children: cmSrcLabel
            }, void 0, false)]
          }, void 0, true)]
        }, void 0, true)]
      }, void 0, true), /*#__PURE__*/_jsxDEV(DataCoverage, {
        brandId: brandId
      }, void 0, false), editTargets ? /*#__PURE__*/_jsxDEV(TdyTargetsForm, {
        brandId: brandId,
        fetcher: fetcher,
        onSaved: () => {
          setEditTargets(false);
          load();
        },
        onCancel: () => setEditTargets(false)
      }, void 0, false) : rd.can_show_cm !== false && /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-planstatus tdy-pop-host",
        children: [planStatus !== 'confirmed' ? /*#__PURE__*/_jsxDEV("span", {
          className: "tdy-prov-chip",
          children: planStatus === 'provisional' ? 'Targets auto-estimated — not confirmed as your plan' : 'No plan set yet'
        }, void 0, false) : /*#__PURE__*/_jsxDEV("span", {
          className: "tdy-conf-chip tdy-muted",
          children: ["plan confirmed", h.cm_basis ? ' · ' + (h.cm_basis === 'product_contribution' ? 'product contribution' : 'after marketing') : '']
        }, void 0, true), /*#__PURE__*/_jsxDEV("button", {
          className: "tdy-linkbtn",
          onClick: () => setEditTargets(true),
          children: planStatus === 'confirmed' ? 'Edit targets' : 'Set targets'
        }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-pop",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop-head",
            children: "Plan status · what this is"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            style: {
              fontSize: 'var(--text-xs)',
              color: 'var(--color-muted)',
              lineHeight: 1.5
            },
            children: "Whether your targets are confirmed as your plan of record. Pace and RAG-vs-target only appear once you confirm — until then the goal is auto-estimated from your last 90 days."
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop-row",
            children: [/*#__PURE__*/_jsxDEV("span", {
              children: "Status"
            }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
              children: planStatus
            }, void 0, false)]
          }, void 0, true), h.cm_basis && /*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop-row",
            children: [/*#__PURE__*/_jsxDEV("span", {
              children: "CM basis"
            }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
              children: h.cm_basis === 'product_contribution' ? 'product contribution' : 'after marketing'
            }, void 0, false)]
          }, void 0, true)]
        }, void 0, true)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-sec",
        children: "do this first"
      }, void 0, false), top ? /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-first tdy-pop-host",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "tdy-first-meta",
          children: [/*#__PURE__*/_jsxDEV("span", {
            className: 'tdy-badge ' + tdyPri(top.priority),
            children: top.priority
          }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
            className: "tdy-first-owner",
            children: [top.owner || '—', " · ", tdyOrigin(top), top.category ? ' · ' + top.category : '']
          }, void 0, true), /*#__PURE__*/_jsxDEV("span", {
            className: "tdy-first-cm",
            children: [tdyMoney(top.cm_gbp), /*#__PURE__*/_jsxDEV("span", {
              className: "tdy-permo",
              children: "/mo CM"
            }, void 0, false)]
          }, void 0, true)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-first-title",
          children: top.description
        }, void 0, false), TDY_V2 && data.stock && data.stock.gate && TDY_SCALE_RE.test(top.description || '') && (data.stock.gate.status === 'blocked' ? /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-stockgate tdy-gate-blocked",
          children: ["⛔ Stock gate (S3): ", data.stock.gate.detail, " — reorder first, then start this."]
        }, void 0, true) : data.stock.gate.status === 'warn' ? /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-stockgate tdy-gate-warn",
          children: ["⚠ Stock gate: ", data.stock.gate.detail]
        }, void 0, true) : data.stock.gate.status === 'unknown' ? /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-stockgate tdy-gate-warn",
          children: ["⏸ Stock gate unknown — ", data.stock.gate.detail]
        }, void 0, true) : /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-stockgate tdy-gate-ok",
          children: "✓ stock cover supports this scale"
        }, void 0, false)), top.step1 && /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-first-step",
          children: top.step1
        }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-first-btns",
          children: [/*#__PURE__*/_jsxDEV("button", {
            className: "tdy-btn tdy-btn-go",
            disabled: busy === top.external_id,
            onClick: () => act('action_start', top.external_id),
            children: "Start"
          }, void 0, false), /*#__PURE__*/_jsxDEV("button", {
            className: "tdy-btn",
            disabled: busy === top.external_id,
            onClick: () => act('action_done', top.external_id),
            children: "Mark done"
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-pop",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop-head",
            children: "Do this first · what this is"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            style: {
              fontSize: 'var(--text-xs)',
              color: 'var(--color-muted)',
              lineHeight: 1.5
            },
            children: "The single highest-£ action right now — ranked by contribution-margin impact across every signal (money synthetics, recipes, forecast deviations, creative, measurement). Start it, or mark it done when handled."
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop-row",
            children: [/*#__PURE__*/_jsxDEV("span", {
              children: "CM impact"
            }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
              children: [tdyMoney(top.cm_gbp), "/mo"]
            }, void 0, true)]
          }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop-row",
            children: [/*#__PURE__*/_jsxDEV("span", {
              children: "Owner"
            }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
              children: top.owner || '—'
            }, void 0, false)]
          }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop-row",
            children: [/*#__PURE__*/_jsxDEV("span", {
              children: "Signal"
            }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
              children: tdyOrigin(top)
            }, void 0, false)]
          }, void 0, true), top.category && /*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop-row",
            children: [/*#__PURE__*/_jsxDEV("span", {
              children: "Area"
            }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
              children: top.category
            }, void 0, false)]
          }, void 0, true)]
        }, void 0, true)]
      }, void 0, true) : TDY_V2 && data.abstention ?
      /*#__PURE__*/
      /* UI_V2 (review A4): abstention is NOT "you're clear" — silence must be typed. */
      _jsxDEV("div", {
        className: "mos-empty tdy-abstained",
        children: ["⏸ No reliable read this cycle. ", data.abstention.reason || 'A data gate failed.', /*#__PURE__*/_jsxDEV("span", {
          className: "tdy-muted",
          children: " Greta abstains rather than guess — fix the gate above and the read returns."
        }, void 0, false)]
      }, void 0, true) : /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: TDY_V2 ? '✓ Nothing open — CM read is clean and no material deviation was found.' : "Nothing open — you're clear."
      }, void 0, false), TDY_V2 && data.pricing_provenance && data.pricing_provenance.needs_refresh && acts.length > 0 && /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-muted tdy-pricing-note",
        children: ["£ impacts are priced from seeded cost inputs marked for refresh", data.pricing_provenance.stamped_at ? ' (as of ' + data.pricing_provenance.stamped_at + ')' : '', " — directionally right, unverified."]
      }, void 0, true), rest.length > 0 && /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-sec",
        children: "then, in order"
      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-rows",
        children: rest.map((a, i) => /*#__PURE__*/_jsxDEV(TdyRow, {
          a: a,
          rank: i + 2,
          busy: busy === a.external_id,
          stock: data.stock,
          onStart: e => act('action_start', e),
          onDone: e => act('action_done', e)
        }, a.external_id, false))
      }, void 0, false), (channels.length > 0 || saturation.some(s => s.spend_cac_corr != null && s.spend_cac_corr > 0.4)) && /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-chan",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "tdy-sec",
          children: "channel efficiency"
        }, void 0, false), saturation.filter(s => s.spend_cac_corr != null && s.spend_cac_corr > 0.4).map(s => /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-sat",
          children: ["⚠ ", s.platform, " saturating — CAC £", s.best_cac, "→£", s.worst_cac, " as spend scales. Test incrementality here next.", /*#__PURE__*/_jsxDEV("span", {
            className: "tdy-muted",
            children: " (observational, not causal)"
          }, void 0, false)]
        }, s.platform, true)), channels.map(c => /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-chan-row tdy-pop-host",
          children: [/*#__PURE__*/_jsxDEV("span", {
            className: "tdy-chan-name",
            children: c.channel_type
          }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
            className: "tdy-chan-iroas",
            children: [c.normalized_iroas != null ? c.normalized_iroas + '×' : '—', /*#__PURE__*/_jsxDEV("span", {
              className: "tdy-permo",
              children: " iROAS"
            }, void 0, false)]
          }, void 0, true), TDY_V2 && c.evidence_tier ? /*#__PURE__*/_jsxDEV("span", {
            className: 'tdy-chan-tier ' + (c.evidence_tier === 'T4' ? 'tdy-tier-warn' : 'tdy-tier-ok'),
            title: c.phi_lo != null ? 'φ band ' + c.phi_lo + '–' + c.phi_hi + (c.evidence_tier === 'T4' ? ' — industry prior, unconfirmed for you. Run a holdout to measure.' : '') : '',
            children: [c.evidence_tier, c.evidence_tier === 'T4' ? ' prior' : ' measured']
          }, void 0, true) : /*#__PURE__*/_jsxDEV("span", {
            className: "tdy-chan-phi tdy-muted",
            children: tdyPhi(c.phi_source)
          }, void 0, false), TDY_V2 && c.reported_target_roas != null && /*#__PURE__*/_jsxDEV("span", {
            className: "tdy-chan-target tdy-muted",
            title: "Reported ROAS this channel must beat, derived from CM% + LTV + φ (never a gut number).",
            children: ["target ", c.reported_target_roas, "× rep."]
          }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop",
            children: [/*#__PURE__*/_jsxDEV("div", {
              className: "tdy-pop-head",
              children: [c.channel_type, " · what this is"]
            }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
              style: {
                fontSize: 'var(--text-xs)',
                color: 'var(--color-muted)',
                lineHeight: 1.5
              },
              children: "How efficiently this channel turns spend into incremental revenue. Normalized iROAS below the reported target means it's under the bar it must clear to be worth scaling."
            }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
              className: "tdy-pop-row",
              children: [/*#__PURE__*/_jsxDEV("span", {
                children: "Normalized iROAS"
              }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
                children: c.normalized_iroas != null ? c.normalized_iroas + '×' : '—'
              }, void 0, false)]
            }, void 0, true), c.reported_target_roas != null && /*#__PURE__*/_jsxDEV("div", {
              className: "tdy-pop-row",
              children: [/*#__PURE__*/_jsxDEV("span", {
                children: "Reported ROAS to beat"
              }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
                children: [c.reported_target_roas, "×"]
              }, void 0, true)]
            }, void 0, true), c.evidence_tier && /*#__PURE__*/_jsxDEV("div", {
              className: "tdy-pop-row",
              children: [/*#__PURE__*/_jsxDEV("span", {
                children: "Evidence"
              }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
                children: c.evidence_tier === 'T4' ? 'T4 · industry prior' : c.evidence_tier + ' · measured'
              }, void 0, false)]
            }, void 0, true), c.phi_lo != null && /*#__PURE__*/_jsxDEV("div", {
              className: "tdy-pop-row",
              children: [/*#__PURE__*/_jsxDEV("span", {
                children: "φ band"
              }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
                children: [c.phi_lo, "–", c.phi_hi]
              }, void 0, true)]
            }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
              className: "tdy-pop-row",
              children: [/*#__PURE__*/_jsxDEV("span", {
                children: "Read"
              }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
                children: c.evidence_tier === 'T4' ? 'Run a holdout to confirm' : 'Measured for you'
              }, void 0, false)]
            }, void 0, true)]
          }, void 0, true)]
        }, c.channel_type, true))]
      }, void 0, true), TDY_V2 && data.stock && (data.stock.stockouts.length > 0 || data.stock.reorder_now.length > 0 || data.stock.trapped_cash_total != null) && /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-stock tdy-pop-host",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "tdy-sec",
          children: "stock"
        }, void 0, false), data.stock.stockouts.map(s => /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-stock-row tdy-stock-out",
          children: [/*#__PURE__*/_jsxDEV("span", {
            className: "tdy-stock-sku",
            children: s.sku
          }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
            children: ["out of stock", s.lost_cm_per_day != null ? ' — losing ' + tdyMoney(s.lost_cm_per_day) + '/day CM' : '']
          }, void 0, true), /*#__PURE__*/_jsxDEV("span", {
            className: "tdy-muted",
            children: "S1 · fix availability before the funnel"
          }, void 0, false)]
        }, s.sku, true)), data.stock.reorder_now.filter(r => !data.stock.stockouts.some(s => s.sku === r.sku)).slice(0, 3).map(r => /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-stock-row",
          children: [/*#__PURE__*/_jsxDEV("span", {
            className: "tdy-stock-sku",
            children: r.sku
          }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
            children: ["reorder by ", /*#__PURE__*/_jsxDEV("b", {
              children: r.reorder_by_date
            }, void 0, false), r.suggested_order_units ? ' · ~' + r.suggested_order_units + ' units' : '', r.demand_uplift_next_6wk > 1 ? ' · demand +' + Math.round((r.demand_uplift_next_6wk - 1) * 100) + '% from planned events' : '']
          }, void 0, true), r.cm_at_risk_before_resupply != null && /*#__PURE__*/_jsxDEV("span", {
            className: "tdy-stock-risk",
            children: [tdyMoney(r.cm_at_risk_before_resupply), " CM at risk"]
          }, void 0, true)]
        }, r.sku, true)), data.stock.trapped_cash_total != null && /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-stock-row tdy-muted",
          children: [tdyMoney(data.stock.trapped_cash_total), " cash trapped in overstock — clear at the shallowest depth (bundle/threshold), never a blanket markdown (S2)"]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "tdy-pop",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop-head",
            children: "Stock · what this is"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            style: {
              fontSize: 'var(--text-xs)',
              color: 'var(--color-muted)',
              lineHeight: 1.5
            },
            children: "Where stock is costing you contribution margin — items out of stock bleeding CM now, SKUs to reorder before they run out, and cash trapped in overstock. Fix availability (S1) before spending on traffic."
          }, void 0, false), data.stock.trapped_cash_total != null && /*#__PURE__*/_jsxDEV("div", {
            className: "tdy-pop-row",
            children: [/*#__PURE__*/_jsxDEV("span", {
              children: "Cash in overstock"
            }, void 0, false), /*#__PURE__*/_jsxDEV("b", {
              children: tdyMoney(data.stock.trapped_cash_total)
            }, void 0, false)]
          }, void 0, true)]
        }, void 0, true)]
      }, void 0, true), TDY_V2 && data.calibration && data.calibration.flags > 0 && /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-proven tdy-muted",
        children: ["Proven — ", data.calibration.flags, " flags · ", data.calibration.hits, " hit · ", data.calibration.misses, " miss · ", data.calibration.abstentions, " abstained", data.calibration.precision != null ? ' · precision ' + data.calibration.precision : '']
      }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-foot",
        children: [h.open_actions != null ? h.open_actions + ' open actions · ' : '', "ranked by contribution margin · updates nightly"]
      }, void 0, true)]
    }, void 0, true);
  }

  /* ---------- Overview: Business tier (2026-07-13 IA spec, build order 1) ----------
   * Reads `overview_business` (marketing-os edge fn -> vw_business_tier_periods, 0075). No local
   * recomputation: every value + RAG chip is server-composed. Collapses independently; state
   * remembered per user via localStorage (spec §2.6). Starts expanded (spec decision #3). */
  const ovMoney = (v, cur = '£') => v == null ? '—' : cur + Math.round(v).toLocaleString();
  const ovPct = (v, dp = 1) => v == null ? '—' : (v * 100).toFixed(dp) + '%';
  const ovNum = v => v == null ? '—' : Math.round(v).toLocaleString();
  const OV_RAG_CLASS = {
    green: 'ov-rag-green',
    amber: 'ov-rag-amber',
    red: 'ov-rag-red',
    grey: 'ov-rag-grey'
  };
  const OV_METRIC_LABEL = {
    revenue: 'Revenue',
    cm_after_marketing: 'Contribution margin',
    sessions: 'Sessions',
    conversion_rate: 'Conversion rate',
    aov: 'AOV',
    discount_rate: 'Discount',
    return_rate: 'Returns',
    // Conversion/CRO drill-down (build order 4) — same OvMetricCard grid, server-computed RAG.
    site_cvr: 'Site conversion rate',
    session_to_atc: 'Session → ATC',
    atc_to_checkout: 'ATC → checkout',
    checkout_to_purchase: 'Checkout → purchase'
  };
  const OV_METRIC_FMT = {
    revenue: ovMoney,
    cm_after_marketing: ovMoney,
    sessions: ovNum,
    conversion_rate: ovPct,
    aov: ovMoney,
    discount_rate: ovPct,
    return_rate: ovPct,
    site_cvr: ovPct,
    session_to_atc: ovPct,
    atc_to_checkout: ovPct,
    checkout_to_purchase: ovPct
  };
  function OvMetricCard({
    m
  }) {
    const fmt = OV_METRIC_FMT[m.key] || ovNum;
    return /*#__PURE__*/_jsxDEV("div", {
      className: "ov-stat",
      children: [/*#__PURE__*/_jsxDEV("div", {
        className: "ov-stat-head",
        children: [/*#__PURE__*/_jsxDEV("span", {
          className: "ov-stat-label",
          children: OV_METRIC_LABEL[m.key] || m.key
        }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
          className: 'ov-rag ' + (OV_RAG_CLASS[m.rag?.chip] || 'ov-rag-grey'),
          title: m.rag?.band != null ? 'noise band ±' + Math.round(m.rag.band * 1000) / 10 + '% (' + m.rag.band_source + ')' : '',
          children: m.rag?.chip === 'grey' ? 'no target set' : m.rag?.label
        }, void 0, false)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
        className: "ov-stat-value",
        children: fmt(m.value)
      }, void 0, false), m.key === 'cm_after_marketing' && m.product_contribution != null && /*#__PURE__*/_jsxDEV("div", {
        className: "ov-stat-sub tdy-muted",
        children: [ovMoney(m.product_contribution), " before marketing", m.cm_basis_note ? ' · ' + (m.cm_basis_note === 'fit_engine' ? 'measured economics' : 'estimated from cost inputs') : '']
      }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
        className: "ov-stat-deltas",
        children: [/*#__PURE__*/_jsxDEV("span", {
          className: m.rag?.delta_pct == null ? 'tdy-muted' : m.rag.delta_pct >= 0 ? 'mos-pos' : 'mos-neg',
          children: [m.rag?.delta_pct == null ? '—' : (m.rag.delta_pct >= 0 ? '▲' : '▼') + ' ' + Math.abs(m.rag.delta_pct) + '%', /*#__PURE__*/_jsxDEV("span", {
            className: "tdy-permo",
            children: " vs prior"
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("span", {
          className: m.yoy_delta_pct == null ? 'tdy-muted' : m.yoy_delta_pct >= 0 ? 'mos-pos' : 'mos-neg',
          children: [m.yoy_delta_pct == null ? '—' : (m.yoy_delta_pct >= 0 ? '▲' : '▼') + ' ' + Math.abs(m.yoy_delta_pct) + '%', /*#__PURE__*/_jsxDEV("span", {
            className: "tdy-permo",
            children: " YoY"
          }, void 0, false)]
        }, void 0, true)]
      }, void 0, true)]
    }, void 0, true);
  }
  function BusinessTier(props) {
    const brandId = props.brandId;
    const fetcher = props.fetcher;
    const [data, setData] = useState(null);
    const [err, setErr] = useState(null);
    const [open, setOpen] = useState(() => {
      try {
        const v = window.localStorage.getItem('ov_tier_business_open');
        return v == null ? true : v === '1';
      } catch (_) {
        return true;
      }
    });
    useEffect(() => {
      let alive = true;
      fetcher('overview_business', {
        brandId
      }).then(d => {
        if (alive) setData(d);
      }).catch(e => {
        if (alive) setErr(String(e && e.message ? e.message : e));
      });
      return () => {
        alive = false;
      };
    }, [brandId, fetcher]);
    const toggle = () => {
      setOpen(o => {
        const next = !o;
        try {
          window.localStorage.setItem('ov_tier_business_open', next ? '1' : '0');
        } catch (_) {}
        return next;
      });
    };
    return /*#__PURE__*/_jsxDEV("div", {
      className: "ov-tier",
      children: [/*#__PURE__*/_jsxDEV("button", {
        className: "ov-tier-head",
        onClick: toggle,
        children: [/*#__PURE__*/_jsxDEV("span", {
          className: "ov-tier-caret",
          children: open ? '▾' : '▸'
        }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
          className: "ov-tier-title",
          children: "Business"
        }, void 0, false)]
      }, void 0, true), open && (err ? /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: ["Couldn't load Business tier — ", err]
      }, void 0, true) : !data ? /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: "Loading…"
      }, void 0, false) : /*#__PURE__*/_jsxDEV(_Fragment, {
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "ov-grid",
          children: data.metrics.filter(m => m.value != null || m.key !== 'sessions').map(m => /*#__PURE__*/_jsxDEV(OvMetricCard, {
            m: m
          }, m.key, false))
        }, void 0, false), data.channels && data.channels.length > 0 && /*#__PURE__*/_jsxDEV("div", {
          className: "ov-chanmini",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Spend by channel"
          }, void 0, false), data.channels.map(c => /*#__PURE__*/_jsxDEV("span", {
            className: "ov-chanchip",
            children: [c.channel, " ", ovMoney(c.spend)]
          }, c.channel, true))]
        }, void 0, true), data.best_sellers && data.best_sellers.length > 0 && /*#__PURE__*/_jsxDEV("div", {
          className: "ov-bestsellers",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Best sellers"
          }, void 0, false), data.best_sellers.map((s, i) => /*#__PURE__*/_jsxDEV("div", {
            className: "ov-bs-row",
            children: [/*#__PURE__*/_jsxDEV("span", {
              className: "tdy-rank",
              children: i + 1
            }, void 0, false), s.sku, /*#__PURE__*/_jsxDEV("span", {
              className: "ov-bs-rev",
              children: ovMoney(s.revenue)
            }, void 0, false)]
          }, s.sku, true))]
        }, void 0, true), data.insight && /*#__PURE__*/_jsxDEV("div", {
          className: "ov-insight",
          children: [data.insight.text, data.insight.kind === 'rule_based' && /*#__PURE__*/_jsxDEV("span", {
            className: "tdy-muted",
            children: " (rule-based read, not LLM-generated — see build notes)"
          }, void 0, false)]
        }, void 0, true)]
      }, void 0, true))]
    }, void 0, true);
  }

  /* ---------- Overview: Customer tier (2026-07-13 IA spec, build order 2) ----------
   * Reads `overview_customer` (-> vw_customer_tier_periods 0076, fn_brand_ltv, cohorts/cohort_retention).
   * Blended MER/aMER always shown WITH their mix weights (new/returning split) — never bare blended
   * numbers, per spec (a specific trust risk flagged in the 2026-07-12 review). */
  const ovX = (v, dp = 2) => v == null ? '—' : Number(v).toFixed(dp) + '×';
  const OV_CUST_LABEL = {
    blended_mer: 'Blended MER',
    amer: 'aMER (new-customer)',
    ncac: 'nCAC'
  };
  const OV_CUST_FMT = {
    blended_mer: ovX,
    amer: ovX,
    ncac: ovMoney
  };
  function OvSplitBar({
    split
  }) {
    if (!split) return null;
    const n = split.new,
      r = split.returning;
    const nPct = n.revenue_share != null ? n.revenue_share * 100 : 50;
    return /*#__PURE__*/_jsxDEV("div", {
      className: "ov-splitbar-wrap",
      children: [/*#__PURE__*/_jsxDEV("div", {
        className: "ov-splitbar",
        children: /*#__PURE__*/_jsxDEV("i", {
          style: {
            width: nPct + '%'
          }
        }, void 0, false)
      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
        className: "ov-splitbar-legend",
        children: [/*#__PURE__*/_jsxDEV("span", {
          children: ["New ", ovPct(n.revenue_share), " rev · ", n.customers ?? '—', " customers (", n.customer_share != null ? n.customer_share + '%' : '—', ")"]
        }, void 0, true), /*#__PURE__*/_jsxDEV("span", {
          children: ["Returning ", ovPct(r.revenue_share), " rev · ", r.customers ?? '—', " customers (", r.customer_share != null ? r.customer_share + '%' : '—', ")"]
        }, void 0, true)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-muted ov-splitnote",
        children: split.cm_share_note
      }, void 0, false)]
    }, void 0, true);
  }
  function OvRetentionCurve({
    curve
  }) {
    if (!curve || !curve.length) return null;
    return /*#__PURE__*/_jsxDEV("div", {
      className: "ov-retention",
      children: [/*#__PURE__*/_jsxDEV("div", {
        className: "ov-stat-label",
        children: "Cohort retention (compact)"
      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
        className: "ov-retention-row",
        children: curve.map(p => /*#__PURE__*/_jsxDEV("div", {
          className: "ov-retention-pt",
          children: [/*#__PURE__*/_jsxDEV("span", {
            className: "ov-retention-v",
            children: p.retention_rate != null ? p.retention_rate + '%' : '—'
          }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
            className: "tdy-muted",
            children: ["m", p.months_since]
          }, void 0, true)]
        }, p.months_since, true))
      }, void 0, false)]
    }, void 0, true);
  }
  function CustomerTier(props) {
    const {
      brandId,
      fetcher
    } = props;
    const [data, setData] = useState(null);
    const [err, setErr] = useState(null);
    const [open, setOpen] = useState(() => {
      try {
        const v = window.localStorage.getItem('ov_tier_customer_open');
        return v == null ? true : v === '1';
      } catch (_) {
        return true;
      }
    });
    useEffect(() => {
      let alive = true;
      fetcher('overview_customer', {
        brandId
      }).then(d => {
        if (alive) setData(d);
      }).catch(e => {
        if (alive) setErr(String(e && e.message ? e.message : e));
      });
      return () => {
        alive = false;
      };
    }, [brandId, fetcher]);
    const toggle = () => setOpen(o => {
      const next = !o;
      try {
        window.localStorage.setItem('ov_tier_customer_open', next ? '1' : '0');
      } catch (_) {}
      return next;
    });
    return /*#__PURE__*/_jsxDEV("div", {
      className: "ov-tier",
      children: [/*#__PURE__*/_jsxDEV("button", {
        className: "ov-tier-head",
        onClick: toggle,
        children: [/*#__PURE__*/_jsxDEV("span", {
          className: "ov-tier-caret",
          children: open ? '▾' : '▸'
        }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
          className: "ov-tier-title",
          children: "Customer"
        }, void 0, false)]
      }, void 0, true), open && (err ? /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: ["Couldn't load Customer tier — ", err]
      }, void 0, true) : !data ? /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: "Loading…"
      }, void 0, false) : /*#__PURE__*/_jsxDEV(_Fragment, {
        children: [/*#__PURE__*/_jsxDEV(OvSplitBar, {
          split: data.split
        }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
          className: "ov-grid",
          children: (data.metrics || []).map(m => {
            const fmt = OV_CUST_FMT[m.key] || ovNum;
            return /*#__PURE__*/_jsxDEV("div", {
              className: "ov-stat",
              children: [/*#__PURE__*/_jsxDEV("div", {
                className: "ov-stat-head",
                children: [/*#__PURE__*/_jsxDEV("span", {
                  className: "ov-stat-label",
                  children: OV_CUST_LABEL[m.key] || m.key
                }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
                  className: 'ov-rag ' + (OV_RAG_CLASS[m.rag?.chip] || 'ov-rag-grey'),
                  children: m.rag?.chip === 'grey' ? 'no target set' : m.rag?.label
                }, void 0, false)]
              }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
                className: "ov-stat-value",
                children: fmt(m.value)
              }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
                className: "ov-stat-deltas",
                children: [/*#__PURE__*/_jsxDEV("span", {
                  className: m.rag?.delta_pct == null ? 'tdy-muted' : m.rag.delta_pct >= 0 ? 'mos-pos' : 'mos-neg',
                  children: [m.rag?.delta_pct == null ? '—' : (m.rag.delta_pct >= 0 ? '▲' : '▼') + ' ' + Math.abs(m.rag.delta_pct) + '%', /*#__PURE__*/_jsxDEV("span", {
                    className: "tdy-permo",
                    children: " vs prior"
                  }, void 0, false)]
                }, void 0, true), /*#__PURE__*/_jsxDEV("span", {
                  className: m.yoy_delta_pct == null ? 'tdy-muted' : m.yoy_delta_pct >= 0 ? 'mos-pos' : 'mos-neg',
                  children: [m.yoy_delta_pct == null ? '—' : (m.yoy_delta_pct >= 0 ? '▲' : '▼') + ' ' + Math.abs(m.yoy_delta_pct) + '%', /*#__PURE__*/_jsxDEV("span", {
                    className: "tdy-permo",
                    children: " YoY"
                  }, void 0, false)]
                }, void 0, true)]
              }, void 0, true)]
            }, m.key, true);
          })
        }, void 0, false), data.ltv && /*#__PURE__*/_jsxDEV("div", {
          className: "ov-ltv",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "LTV-derived target true iROAS"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: ovX(data.ltv.target_true_iroas)
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "tdy-muted",
            children: [data.ltv.provenance_note, " — CM2% ", ovPct(data.ltv.cm2_pct), " (", data.ltv.cm2_source, "), L ", ovPct(data.ltv.ltv_share), ". ", data.ltv.status !== 'measured' ? data.ltv.status + ': ' : '', data.ltv.detail]
          }, void 0, true)]
        }, void 0, true), /*#__PURE__*/_jsxDEV(OvRetentionCurve, {
          curve: data.retention_curve
        }, void 0, false), data.insight && /*#__PURE__*/_jsxDEV("div", {
          className: "ov-insight",
          children: [data.insight.text, data.insight.kind === 'rule_based' && /*#__PURE__*/_jsxDEV("span", {
            className: "tdy-muted",
            children: " (rule-based read, not LLM-generated — see build notes)"
          }, void 0, false)]
        }, void 0, true)]
      }, void 0, true))]
    }, void 0, true);
  }

  /* ---------- Overview: Channel tier (2026-07-13 IA spec, build order 2) ----------
   * Reads `overview_channel` (-> vw_channel_iroas + channel_iroas_prior + vw_channel_iroas_targets +
   * fn_congruency_check). Same per-channel iROAS+evidence-tier+band the masthead already renders —
   * jargon is allowed to surface here (with hover explainers) per spec §2.5. */
  function ChannelTier(props) {
    const {
      brandId,
      fetcher
    } = props;
    const [data, setData] = useState(null);
    const [err, setErr] = useState(null);
    const [open, setOpen] = useState(() => {
      try {
        const v = window.localStorage.getItem('ov_tier_channel_open');
        return v == null ? true : v === '1';
      } catch (_) {
        return true;
      }
    });
    useEffect(() => {
      let alive = true;
      fetcher('overview_channel', {
        brandId
      }).then(d => {
        if (alive) setData(d);
      }).catch(e => {
        if (alive) setErr(String(e && e.message ? e.message : e));
      });
      return () => {
        alive = false;
      };
    }, [brandId, fetcher]);
    const toggle = () => setOpen(o => {
      const next = !o;
      try {
        window.localStorage.setItem('ov_tier_channel_open', next ? '1' : '0');
      } catch (_) {}
      return next;
    });
    return /*#__PURE__*/_jsxDEV("div", {
      className: "ov-tier",
      children: [/*#__PURE__*/_jsxDEV("button", {
        className: "ov-tier-head",
        onClick: toggle,
        children: [/*#__PURE__*/_jsxDEV("span", {
          className: "ov-tier-caret",
          children: open ? '▾' : '▸'
        }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
          className: "ov-tier-title",
          children: "Channel"
        }, void 0, false)]
      }, void 0, true), open && (err ? /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: ["Couldn't load Channel tier — ", err]
      }, void 0, true) : !data ? /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: "Loading…"
      }, void 0, false) : /*#__PURE__*/_jsxDEV(_Fragment, {
        children: [/*#__PURE__*/_jsxDEV("table", {
          className: "mos-table ov-chantable",
          children: [/*#__PURE__*/_jsxDEV("thead", {
            children: /*#__PURE__*/_jsxDEV("tr", {
              children: [/*#__PURE__*/_jsxDEV("th", {
                style: {
                  textAlign: 'left'
                },
                children: "Channel"
              }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
                children: "Spend"
              }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
                children: "MER"
              }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
                children: "iROAS (norm.)"
              }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
                children: "Target rep. ROAS"
              }, void 0, false)]
            }, void 0, true)
          }, void 0, false), /*#__PURE__*/_jsxDEV("tbody", {
            children: (data.channels || []).map(c => /*#__PURE__*/_jsxDEV("tr", {
              children: [/*#__PURE__*/_jsxDEV("td", {
                style: {
                  textAlign: 'left'
                },
                children: c.channel
              }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
                children: ovMoney(c.spend)
              }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
                children: ovX(c.mer)
              }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
                children: [ovX(c.normalized_iroas), ' ', c.evidence_tier ? /*#__PURE__*/_jsxDEV("span", {
                  className: 'ov-tierchip ' + (c.evidence_tier === 'T4' ? 'ov-tier-warn' : 'ov-tier-ok'),
                  title: c.phi_lo != null ? 'φ band ' + c.phi_lo + '–' + c.phi_hi : '',
                  children: [c.evidence_tier, c.evidence_tier === 'T4' ? ' prior' : ' measured']
                }, void 0, true) : /*#__PURE__*/_jsxDEV("span", {
                  className: "tdy-muted",
                  children: c.phi_source
                }, void 0, false)]
              }, void 0, true), /*#__PURE__*/_jsxDEV("td", {
                className: "tdy-muted",
                children: ovX(c.reported_target_roas)
              }, void 0, false)]
            }, c.channel, true))
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "mos-basis",
          children: "Per-channel aMER/CAC not shown — no canonical view attributes new customers per channel yet (see build notes)."
        }, void 0, false), data.insight && /*#__PURE__*/_jsxDEV("div", {
          className: "ov-insight",
          children: [data.insight.text, data.congruency?.verdict && /*#__PURE__*/_jsxDEV("span", {
            className: "tdy-muted",
            children: [" (congruency: ", data.congruency.verdict.replace(/_/g, ' '), ")"]
          }, void 0, true)]
        }, void 0, true)]
      }, void 0, true))]
    }, void 0, true);
  }

  /* Overview = Today's masthead + Business/Customer/Channel tiers beneath it (2026-07-13 spec: Today
   * merges into Overview as its masthead, not a separate screen). Performance/Plan drill-downs are
   * later build-order items — not part of this pass. */
  function Overview(props) {
    // Same fix as Today (2026-07-13, see above): memoize the fetcher so the tiers don't refire their
    // effects every render and hammer the edge function with duplicate requests.
    const fetcher = useMemo(() => props.fetcher || tdyDefaultFetcher(props.apiBase, props.getToken), [props.fetcher, props.apiBase, props.getToken]);
    return /*#__PURE__*/_jsxDEV("div", {
      children: [/*#__PURE__*/_jsxDEV(Today, {
        ...props,
        fetcher: fetcher
      }, void 0, false), /*#__PURE__*/_jsxDEV(BusinessTier, {
        brandId: props.brandId,
        fetcher: fetcher
      }, void 0, false), /*#__PURE__*/_jsxDEV(CustomerTier, {
        brandId: props.brandId,
        fetcher: fetcher
      }, void 0, false), /*#__PURE__*/_jsxDEV(ChannelTier, {
        brandId: props.brandId,
        fetcher: fetcher
      }, void 0, false)]
    }, void 0, true);
  }

  /* ---------- calendar helpers + editor ---------- */
  function calParse(d) {
    return new Date(d + 'T00:00:00');
  }
  function calClass(v) {
    return v == null ? 'cal-neutral' : v >= 1.2 ? 'cal-hot' : v < 0.9 ? 'cal-cool' : 'cal-neutral';
  }
  function calShort(name) {
    return String(name).replace(/^Creator - /, '').split(' / ')[0].replace(/\s*20\d\d\s*$/, '').replace(/\s*\(evergreen\)\s*/i, '').trim();
  }
  function ymd0(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  const CG_GROUPS = [['key_date', 'Key Dates'], ['seasonality', 'Seasonality'], ['product_focus', 'Product Focus'], ['theme', 'Themes'], ['promo', 'Promos'], ['risk', 'Risks'], ['channel', 'Channels']];
  // Calendar cockpit (0119–0127): funnel roles + structured-offer mechanics for the drawer.
  const FUNNELS = ['awareness', 'acquisition', 'retention'];
  const OFFERS = ['', 'pct_off', 'bogo', 'gwp', 'bundle', 'free_ship', 'tiered', 'price_drop'];
  // Map a drawer channel value (CHANNELS taxonomy) to the platform slug used as row_key in
  // vw_calendar_channel_actuals ('email','google','meta','website',…). Used to suppress a channel
  // row's live-actual cell on any day already covered by a planned event in that same channel.
  function actualKey(ch) {
    if (ch === 'instagram' || ch === 'facebook' || ch === 'meta') return 'meta';
    if (ch === 'google_search' || ch === 'google_pmax' || ch === 'youtube' || ch === 'google') return 'google';
    if (ch === 'website') return 'website';
    return ch || null;
  }
  // Channel taxonomy: [value, label]. Value maps to a data platform (channelPlatform) so picking a
  // channel pulls that platform's live iROAS/spend from vw_platform_channel into the drawer.
  const CHANNELS = [['', '—'], ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['tiktok', 'TikTok'], ['email', 'Email'], ['sms', 'SMS'], ['google_search', 'Google Search'], ['google_pmax', 'Google PMax'], ['youtube', 'YouTube'], ['pinterest', 'Pinterest'], ['affiliate', 'Affiliates'], ['creator', 'Influencer / Creator'], ['pr', 'PR'], ['organic_social', 'Organic social'], ['website', 'Website / On-site']];
  function channelPlatform(ch) {
    if (ch === 'instagram' || ch === 'facebook') return 'meta';
    if (ch === 'google_search' || ch === 'google_pmax' || ch === 'youtube') return 'google';
    if (ch === 'email' || ch === 'sms') return 'klaviyo';
    if (ch === 'tiktok') return 'tiktok';
    if (ch === 'pinterest') return 'pinterest';
    return ch || null;
  }
  const CHANNEL_LABEL = CHANNELS.reduce((m, o) => {
    m[o[0]] = o[1];
    return m;
  }, {});
  const WD1 = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  function numOrNull(v) {
    return v === '' || v == null ? null : isNaN(Number(v)) ? null : Number(v);
  }
  function EventDrawer(props) {
    const e = props.event || {};
    const today = new Date().toISOString().slice(0, 10);
    const [f, setF] = useState(() => ({
      title: e.title || '',
      row_group: e.row_group || 'promo',
      channel: e.channel || '',
      campaign_id: e.campaign_id || '',
      funnel_stage: e.funnel_stage || 'acquisition',
      owner: e.owner || '',
      due_date: e.due_date || '',
      brief: e.brief || '',
      start_date: e.start_date || today,
      end_date: e.end_date || '',
      status: e.status || 'planned',
      approval_status: e.approval_status || 'draft',
      sku: e.sku || '',
      creator: e.creator || '',
      content_pillar: e.content_pillar || '',
      format: e.format || '',
      message_angle: e.message_angle || '',
      cta: e.cta || '',
      asset_link: e.asset_link || '',
      usage_rights: e.usage_rights || '',
      offer: e.metadata && e.metadata.offer || '',
      offer_type: e.offer_type || '',
      discount_code: e.discount_code || '',
      margin_floor: e.margin_floor == null ? '' : e.margin_floor,
      expected_revenue: e.expected_revenue == null ? '' : e.expected_revenue,
      expected_spend: e.expected_spend == null ? '' : e.expected_spend,
      expected_cm: e.expected_cm == null ? '' : e.expected_cm,
      target_kpi: e.target_kpi || '',
      measurement_plan: e.measurement_plan || '',
      actual_revenue: e.actual_revenue == null ? '' : e.actual_revenue,
      actual_spend: e.actual_spend == null ? '' : e.actual_spend,
      actual_cm: e.actual_cm == null ? '' : e.actual_cm,
      learnings: e.learnings || ''
    }));
    const [saving, setSaving] = useState(false);
    const [err, setErr] = useState('');
    const set = (k, v) => setF(p => ({
      ...p,
      [k]: v
    }));

    // promo/event forecaster (fn_forecast_event): discount-adjusted CM + measured-analogue lift
    const parseDisc = s => {
      const m = String(s || '').match(/(\d{1,2})\s*%/) || String(s || '').match(/(?:^|[^\d])(\d{2})(?!\d)/);
      const n = m ? +m[1] : null;
      return n && n >= 5 && n <= 90 ? String(n) : '';
    };
    const [disc, setDisc] = useState(() => (e.discount_pct != null ? String(e.discount_pct) : '') || parseDisc(e.metadata && e.metadata.offer) || parseDisc(e.title) || '');
    const [pf, setPf] = useState(null);
    const [pfBusy, setPfBusy] = useState(false);

    // Campaign + Shopify SKU/collection picker data (loaded once when the drawer opens).
    const [campaigns, setCampaigns] = useState([]);
    const [pickColls, setPickColls] = useState([]);
    const [pickProds, setPickProds] = useState([]);
    const [selProd, setSelProd] = useState([]); // selected shopify_product_id[]
    const [selColl, setSelColl] = useState([]); // selected shopify_collection_id[]
    const [pickAll, setPickAll] = useState(false); // "all products" scope
    const [pickMode, setPickMode] = useState('collections');
    const [pickSearch, setPickSearch] = useState('');
    const [stockRisk, setStockRisk] = useState(null); // vw_event_stock_risk for a saved event
    // Calendar cockpit (0119–0127): multi-channel + lead, dependencies, per-lead efficiency, readiness/guardrail.
    const [channelDim, setChannelDim] = useState([]); // channel_dim rows (enum vocabulary)
    const [chosenChannels, setChosenChannels] = useState([]); // channel_type[]
    const [leadChannel, setLeadChannel] = useState(null); // one channel_type flagged is_lead
    const [siblings, setSiblings] = useState([]); // other events, for the depends-on picker
    const [deps, setDeps] = useState([]); // depends_on_event_id[]
    const [optimum, setOptimum] = useState(null); // vw_channel_optimum for the lead's platform
    const [readiness, setReadiness] = useState(null); // vw_event_readiness
    const [guardrail, setGuardrail] = useState(null); // vw_promo_guardrail
    useEffect(() => {
      let alive = true;
      const sb = sbClient();
      if (!sb || !props.brandId) return;
      sb.from('mos_campaign').select('id,name,status').eq('brand_id', props.brandId).order('created_at', {
        ascending: false
      }).then(r => {
        if (alive && r.data) setCampaigns(r.data);
      });
      sb.from('vw_brand_collections').select('shopify_collection_id,title,collection_type,product_count').eq('brand_id', props.brandId).order('product_count', {
        ascending: false
      }).then(r => {
        if (alive && r.data) setPickColls(r.data);
      });
      sb.from('vw_brand_product_pick').select('shopify_product_id,title,price,stock_status,weeks_of_cover').eq('brand_id', props.brandId).order('title').then(r => {
        if (alive && r.data) setPickProds(r.data);
      });
      sb.from('channel_dim').select('channel_type,platform,display_name,is_paid,sort').order('sort').then(r => {
        if (alive && r.data) setChannelDim(r.data);
      });
      sb.from('mos_calendar_event').select('id,title,start_date').eq('brand_id', props.brandId).neq('status', 'skipped').order('start_date').limit(200).then(r => {
        if (alive && r.data) setSiblings(r.data.filter(x => x.id !== e.id));
      });
      if (e.id) {
        sb.from('mos_event_product').select('scope,shopify_product_id,shopify_collection_id').eq('event_id', e.id).then(r => {
          if (!alive || !r.data) return;
          if (r.data.some(x => x.scope === 'all')) setPickAll(true);
          setSelProd(r.data.filter(x => x.shopify_product_id != null).map(x => x.shopify_product_id));
          setSelColl(r.data.filter(x => x.shopify_collection_id != null).map(x => x.shopify_collection_id));
        });
        sb.from('vw_event_stock_risk').select('covered_skus,skus_at_risk,earliest_reorder_by,cm_at_risk').eq('event_id', e.id).maybeSingle().then(r => {
          if (alive && r && r.data) setStockRisk(r.data);
        });
        sb.from('mos_event_channel').select('channel_type,is_lead').eq('event_id', e.id).then(r => {
          if (!alive || !r.data) return;
          setChosenChannels(r.data.map(x => x.channel_type));
          setLeadChannel((r.data.find(x => x.is_lead) || {}).channel_type || null);
        });
        sb.from('mos_event_dependency').select('depends_on_event_id').eq('event_id', e.id).then(r => {
          if (alive && r.data) setDeps(r.data.map(x => x.depends_on_event_id));
        });
        sb.from('vw_event_readiness').select('readiness,reasons').eq('event_id', e.id).maybeSingle().then(r => {
          if (alive && r && r.data) setReadiness(r.data);
        });
        sb.from('vw_promo_guardrail').select('verdict,reasons').eq('event_id', e.id).maybeSingle().then(r => {
          if (alive && r && r.data) setGuardrail(r.data);
        });
      }
      return () => {
        alive = false;
      };
    }, [props.brandId, e.id]);
    // Lead-channel efficiency strip (vw_channel_optimum, by the lead's platform — paid channels only).
    useEffect(() => {
      if (!leadChannel) {
        setOptimum(null);
        return;
      }
      const cd = channelDim.find(c => c.channel_type === leadChannel);
      if (!cd || !cd.is_paid) {
        setOptimum(null);
        return;
      }
      let alive = true;
      sbClient().from('vw_channel_optimum').select('*').eq('brand_id', props.brandId).eq('platform', cd.platform).order('spend_30d', {
        ascending: false
      }).then(r => {
        if (alive) setOptimum((r.data || [])[0] || null);
      });
      return () => {
        alive = false;
      };
    }, [leadChannel, channelDim, props.brandId]);
    const toggleIn = (arr, setArr, v) => setArr(arr.indexOf(v) >= 0 ? arr.filter(x => x !== v) : arr.concat([v]));
    const text = (label, key) => /*#__PURE__*/_jsxDEV("label", {
      className: "dw-f",
      children: [/*#__PURE__*/_jsxDEV("span", {
        children: label
      }, void 0, false), /*#__PURE__*/_jsxDEV("input", {
        value: f[key],
        onChange: ev => set(key, ev.target.value)
      }, void 0, false)]
    }, void 0, true);
    const numf = (label, key) => /*#__PURE__*/_jsxDEV("label", {
      className: "dw-f dw-numf",
      children: [/*#__PURE__*/_jsxDEV("span", {
        children: label
      }, void 0, false), /*#__PURE__*/_jsxDEV("input", {
        inputMode: "decimal",
        value: f[key],
        onChange: ev => set(key, ev.target.value)
      }, void 0, false)]
    }, void 0, true);
    const datef = (label, key) => /*#__PURE__*/_jsxDEV("label", {
      className: "dw-f",
      children: [/*#__PURE__*/_jsxDEV("span", {
        children: label
      }, void 0, false), /*#__PURE__*/_jsxDEV("input", {
        type: "date",
        value: f[key],
        onChange: ev => set(key, ev.target.value)
      }, void 0, false)]
    }, void 0, true);
    const area = (label, key) => /*#__PURE__*/_jsxDEV("label", {
      className: "dw-f",
      children: [/*#__PURE__*/_jsxDEV("span", {
        children: label
      }, void 0, false), /*#__PURE__*/_jsxDEV("textarea", {
        rows: "2",
        value: f[key],
        onChange: ev => set(key, ev.target.value)
      }, void 0, false)]
    }, void 0, true);
    const self = (label, key, opts) => /*#__PURE__*/_jsxDEV("label", {
      className: "dw-f",
      children: [/*#__PURE__*/_jsxDEV("span", {
        children: label
      }, void 0, false), /*#__PURE__*/_jsxDEV("select", {
        value: f[key],
        onChange: ev => set(key, ev.target.value),
        children: opts.map(o => /*#__PURE__*/_jsxDEV("option", {
          value: o,
          children: o || '—'
        }, o, false))
      }, void 0, false)]
    }, void 0, true);
    // pairs = [value,label][]; used for the channel taxonomy and campaign picker
    const selP = (label, key, pairs) => /*#__PURE__*/_jsxDEV("label", {
      className: "dw-f",
      children: [/*#__PURE__*/_jsxDEV("span", {
        children: label
      }, void 0, false), /*#__PURE__*/_jsxDEV("select", {
        value: f[key],
        onChange: ev => set(key, ev.target.value),
        children: pairs.map(o => /*#__PURE__*/_jsxDEV("option", {
          value: o[0],
          children: o[1]
        }, o[0], false))
      }, void 0, false)]
    }, void 0, true);
    const pill = (label, on, onClick, extra) => /*#__PURE__*/_jsxDEV("span", {
      className: 'dw-pill' + (on ? ' on' : ''),
      onClick: onClick,
      children: [label, extra || null]
    }, void 0, true);
    const variance = (exp, act) => {
      const a = numOrNull(act),
        x = numOrNull(exp);
      if (a == null || x == null || x === 0) return null;
      return Math.round((a - x) / Math.abs(x) * 100);
    };
    const revVar = variance(f.expected_revenue, f.actual_revenue);
    const cmVar = variance(f.expected_cm, f.actual_cm);

    // channel-history forecast (fix #4): seed expected from vw_platform_channel normalized iROAS
    const ps = props.platformStats && props.platformStats[channelPlatform(f.channel)];
    // 2026-07-13 fix: this silently substituted a 60% CM ratio whenever the real brand figure wasn't
    // passed in, rendering the resulting £ CAM figure below with no indication it was a generic
    // assumption rather than this brand's measured margin — track that so the UI can say so.
    const cmRIsFallback = props.cmRatio == null;
    const cmR = props.cmRatio ?? 0.6;
    const es = numOrNull(f.expected_spend);
    const iroas = ps && ps.normalized_iroas != null ? Number(ps.normalized_iroas) : null;
    const fcRev = iroas != null && es != null ? Math.round(es * iroas) : null;
    const fcCam = fcRev != null ? Math.round(fcRev * cmR - es) : null;
    const applyFc = () => {
      if (fcRev != null) {
        set('expected_revenue', fcRev);
        set('expected_cm', fcCam);
      }
    };
    const runPromoFc = async () => {
      const dnum = numOrNull(disc);
      if (dnum == null) return;
      setPfBusy(true);
      try {
        const r = await sbClient().rpc('fn_forecast_event', {
          p_brand: props.brandId,
          p_discount_pct: dnum,
          p_start: f.start_date,
          p_end: f.end_date || f.start_date,
          p_expected_spend: numOrNull(f.expected_spend) || 0,
          p_type: f.row_group,
          p_event_id: e.id || null // saved event → margin from its promoted SKUs (else brand average)
        });
        setPf(r && !r.error && r.data ? r.data : null);
      } catch (_) {
        setPf(null);
      }
      setPfBusy(false);
    };
    const applyPromoFc = () => {
      const c = pf && pf.forecast && pf.forecast.central;
      if (!c) return;
      set('expected_revenue', Math.round(c.promo_revenue));
      set('expected_cm', Math.round(c.window_cm)); // window CM is comparable to the window-measured actual_cm
    };
    const isDiscrete = ['promo', 'key_date', 'seasonality', 'theme', 'launch'].indexOf(f.row_group) >= 0;
    const save = async () => {
      if (!f.title.trim()) {
        setErr('Title is required.');
        return;
      }
      if (!f.start_date) {
        setErr('Start date is required.');
        return;
      }
      setSaving(true);
      setErr('');
      const row = {
        // Legacy single `channel` stays populated (= lead channel when one is set) so the gantt's
        // Channels grouping and the vw_platform_channel history forecast keep working. Multi-channel
        // fan-out is written separately to mos_event_channel below.
        title: f.title.trim(),
        row_group: f.row_group,
        channel: leadChannel || f.channel || null,
        campaign_id: f.campaign_id || null,
        funnel_stage: f.funnel_stage || null,
        owner: f.owner || null,
        due_date: f.due_date || null,
        brief: f.brief || null,
        offer_type: f.row_group === 'promo' ? f.offer_type || null : null,
        discount_pct: numOrNull(disc),
        discount_code: f.discount_code || null,
        margin_floor: numOrNull(f.margin_floor),
        shopify_product_id: !pickAll && selProd.length === 1 ? String(selProd[0]) : e.shopify_product_id || null,
        start_date: f.start_date,
        end_date: f.end_date || null,
        status: f.status,
        approval_status: f.approval_status,
        sku: f.sku || null,
        creator: f.creator || null,
        content_pillar: f.content_pillar || null,
        format: f.format || null,
        message_angle: f.message_angle || null,
        cta: f.cta || null,
        asset_link: f.asset_link || null,
        usage_rights: f.usage_rights || null,
        expected_revenue: numOrNull(f.expected_revenue),
        expected_spend: numOrNull(f.expected_spend),
        expected_cm: numOrNull(f.expected_cm),
        target_kpi: f.target_kpi || null,
        measurement_plan: f.measurement_plan || null,
        actual_revenue: numOrNull(f.actual_revenue),
        actual_spend: numOrNull(f.actual_spend),
        actual_cm: numOrNull(f.actual_cm),
        learnings: f.learnings || null,
        metadata: Object.assign({}, e.metadata || {}, {
          offer: f.offer || null
        }),
        updated_at: new Date().toISOString()
      };
      const anyActual = numOrNull(f.actual_revenue) != null || numOrNull(f.actual_spend) != null || numOrNull(f.actual_cm) != null;
      if (anyActual) row.metadata.actuals_source = 'manual';
      const sb = sbClient();
      let evId = e.id,
        error;
      if (e.id) {
        const r = await sb.from('mos_calendar_event').update(row).eq('id', e.id);
        error = r.error;
      } else {
        row.brand_id = props.brandId;
        row.source = 'manual';
        const r = await sb.from('mos_calendar_event').insert(row).select('id').single();
        error = r.error;
        if (r.data) evId = r.data.id;
      }
      if (error) {
        setSaving(false);
        setErr(error.message);
        return;
      }
      // Sync Shopify product/collection links (mos_event_product). Additive — a link failure must
      // never lose the saved event, so it's best-effort and doesn't block onSaved.
      if (evId) {
        try {
          await sb.from('mos_event_product').delete().eq('event_id', evId);
          let links = [];
          if (pickAll) links = [{
            event_id: evId,
            brand_id: props.brandId,
            scope: 'all'
          }];else links = selColl.map(id => ({
            event_id: evId,
            brand_id: props.brandId,
            scope: 'collection',
            shopify_collection_id: id
          })).concat(selProd.map(id => ({
            event_id: evId,
            brand_id: props.brandId,
            scope: 'product',
            shopify_product_id: id
          })));
          if (links.length) await sb.from('mos_event_product').insert(links);
        } catch (_) {/* additive; keep the event */}
        // Replace the event's channel fan-out (mos_event_channel): delete + insert, one is_lead.
        try {
          await sb.from('mos_event_channel').delete().eq('event_id', evId);
          if (chosenChannels.length) {
            await sb.from('mos_event_channel').insert(chosenChannels.map(ct => ({
              event_id: evId,
              brand_id: props.brandId,
              channel_type: ct,
              is_lead: ct === leadChannel
            })));
          }
        } catch (_) {/* additive; keep the event */}
        // Replace the event's dependencies (mos_event_dependency): delete + insert.
        try {
          await sb.from('mos_event_dependency').delete().eq('event_id', evId);
          if (deps.length) {
            await sb.from('mos_event_dependency').insert(deps.map(pid => ({
              brand_id: props.brandId,
              event_id: evId,
              depends_on_event_id: pid,
              dep_type: 'finish_before_start'
            })));
          }
        } catch (_) {/* additive; keep the event */}
      }
      setSaving(false);
      props.onSaved();
    };
    return /*#__PURE__*/_jsxDEV("div", {
      className: "dw-wrap",
      children: [/*#__PURE__*/_jsxDEV("div", {
        className: "dw-backdrop",
        onClick: props.onClose
      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
        className: "dw",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "dw-head",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "dw-title",
            children: e.id ? 'Edit event' : 'New event'
          }, void 0, false), /*#__PURE__*/_jsxDEV("button", {
            className: "dw-x",
            onClick: props.onClose,
            children: "×"
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "dw-body",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "dw-sec",
            children: "What & when"
          }, void 0, false), text('Title', 'title'), /*#__PURE__*/_jsxDEV("div", {
            className: "dw-2",
            children: [self('Row', 'row_group', CG_GROUPS.map(g => g[0])), selP('Channel', 'channel', CHANNELS)]
          }, void 0, true), selP('Campaign (leading with)', 'campaign_id', [['', '— none —']].concat(campaigns.map(c => [c.id, c.name + (c.status ? ' · ' + c.status : '')]))), /*#__PURE__*/_jsxDEV("div", {
            className: "dw-2",
            children: [datef('Start', 'start_date'), datef('End', 'end_date')]
          }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
            className: "dw-2",
            children: [self('Status', 'status', ['proposed', 'planned', 'live', 'complete', 'skipped']), self('Approval', 'approval_status', ['draft', 'in_review', 'approved', 'blocked'])]
          }, void 0, true), /*#__PURE__*/_jsxDEV("style", {
            children: `.dw-pill{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--border-subtle,rgba(255,255,255,.15));border-radius:var(--radius-md,6px);padding:4px 10px;font-size:12px;margin:0 5px 5px 0;cursor:pointer;color:inherit}
.dw-pill.on{border-color:var(--accent,#7c8cff);background:var(--accent-soft,rgba(124,140,255,.12));color:var(--accent,#a9b4ff)}
.dw-pill .dw-star{color:var(--accent,#7c8cff)}
.dw-pill .dw-star.off{color:var(--border-subtle,rgba(255,255,255,.3))}
.dw-strip{border:1px solid var(--border-subtle,rgba(255,255,255,.12));border-radius:var(--radius-md,6px);padding:8px 10px;font-size:12px;margin:2px 0 8px}
.dw-strip .dw-strip-r{display:flex;justify-content:space-between;margin:2px 0}
.dw-strip .dw-strip-r span:last-child{font-family:var(--font-mono,monospace)}
.dw-ready{font-size:12px;margin-top:8px}
.dw-ready.ok{color:var(--pos,#8ff0bd)}.dw-ready.warn{color:var(--warn,#f3cf95)}.dw-ready.bad{color:var(--neg,#f4a3a5)}`
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "dw-sec",
            children: "Funnel & owner"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            children: FUNNELS.map(fn => pill(fn, f.funnel_stage === fn, () => set('funnel_stage', fn)))
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "dw-2",
            children: [text('Owner', 'owner'), datef('Asset due', 'due_date')]
          }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
            className: "dw-sec",
            children: "Channels & lead"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "tdy-muted",
            style: {
              fontSize: '11px',
              marginBottom: '6px'
            },
            children: "Click a channel to add it; ★ sets the lead."
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            children: channelDim.map(c => pill(c.display_name, chosenChannels.indexOf(c.channel_type) >= 0, () => toggleIn(chosenChannels, setChosenChannels, c.channel_type), /*#__PURE__*/_jsxDEV("span", {
              className: 'dw-star' + (leadChannel === c.channel_type ? '' : ' off'),
              onClick: ev => {
                ev.stopPropagation();
                setLeadChannel(c.channel_type);
                if (chosenChannels.indexOf(c.channel_type) < 0) toggleIn(chosenChannels, setChosenChannels, c.channel_type);
              },
              children: "★"
            }, void 0, false)))
          }, void 0, false), optimum ? /*#__PURE__*/_jsxDEV("div", {
            className: "dw-strip",
            children: [/*#__PURE__*/_jsxDEV("div", {
              className: "dw-strip-r",
              children: [/*#__PURE__*/_jsxDEV("span", {
                children: "Lead efficiency"
              }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
                style: {
                  color: optimum.status === 'scale' ? 'var(--pos,#8ff0bd)' : optimum.status === 'fix' ? 'var(--neg,#f4a3a5)' : 'var(--warn,#f3cf95)'
                },
                children: String(optimum.status || '—').toUpperCase()
              }, void 0, false)]
            }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
              className: "dw-strip-r",
              children: [/*#__PURE__*/_jsxDEV("span", {
                children: "iROAS / break-even"
              }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
                children: [optimum.marginal_iroas ?? '—', " / ", optimum.break_even_iroas ?? '—']
              }, void 0, true)]
            }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
              className: "dw-strip-r",
              children: [/*#__PURE__*/_jsxDEV("span", {
                children: "Max CAC (1st order)"
              }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
                children: tdyMoney(optimum.max_cac_first_order)
              }, void 0, false)]
            }, void 0, true)]
          }, void 0, true) : null, /*#__PURE__*/_jsxDEV("div", {
            className: "dw-sec",
            children: "Products & collections"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "dw-pick",
            children: [/*#__PURE__*/_jsxDEV("style", {
              children: `.dw-pick-list{max-height:180px;overflow-y:auto;border:1px solid rgba(255,255,255,.12);border-radius:4px;margin-top:6px}
.dw-pick-row{display:flex;align-items:center;gap:8px;padding:4px 8px;font-size:12px;cursor:pointer}
.dw-pick-row:hover{background:rgba(255,255,255,.05)}
.dw-pick-t{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dw-pick-m{flex:none;font-size:11px}
.dw-pick-tabs{display:flex;gap:6px;margin-bottom:6px}
.dw-pick-tabs button{padding:2px 10px;border-radius:4px;border:1px solid rgba(255,255,255,.15);background:transparent;color:inherit;cursor:pointer;font-size:12px}
.dw-pick-tabs button.on{background:var(--accent,#7c8cff);border-color:var(--accent,#7c8cff);color:#fff}
.dw-pick-search{width:100%;box-sizing:border-box;margin-bottom:4px}
.dw-pick-all{display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:6px}
.dw-pick-sum{font-size:11px;margin-top:4px}`
            }, void 0, false), /*#__PURE__*/_jsxDEV("label", {
              className: "dw-pick-all",
              children: [/*#__PURE__*/_jsxDEV("input", {
                type: "checkbox",
                checked: pickAll,
                onChange: ev => setPickAll(ev.target.checked)
              }, void 0, false), " All products (whole store)"]
            }, void 0, true), !pickAll ? /*#__PURE__*/_jsxDEV("div", {
              children: [/*#__PURE__*/_jsxDEV("div", {
                className: "dw-pick-tabs",
                children: [/*#__PURE__*/_jsxDEV("button", {
                  type: "button",
                  className: pickMode === 'collections' ? 'on' : '',
                  onClick: () => setPickMode('collections'),
                  children: ["Collections", selColl.length ? ' (' + selColl.length + ')' : '']
                }, void 0, true), /*#__PURE__*/_jsxDEV("button", {
                  type: "button",
                  className: pickMode === 'products' ? 'on' : '',
                  onClick: () => setPickMode('products'),
                  children: ["Products", selProd.length ? ' (' + selProd.length + ')' : '']
                }, void 0, true)]
              }, void 0, true), /*#__PURE__*/_jsxDEV("input", {
                className: "dw-pick-search",
                placeholder: 'Search ' + pickMode + '…',
                value: pickSearch,
                onChange: ev => setPickSearch(ev.target.value)
              }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
                className: "dw-pick-list",
                children: pickMode === 'collections' ? pickColls.filter(c => !pickSearch || (c.title || '').toLowerCase().indexOf(pickSearch.toLowerCase()) >= 0).slice(0, 200).map(c => /*#__PURE__*/_jsxDEV("label", {
                  className: "dw-pick-row",
                  children: [/*#__PURE__*/_jsxDEV("input", {
                    type: "checkbox",
                    checked: selColl.indexOf(c.shopify_collection_id) >= 0,
                    onChange: () => toggleIn(selColl, setSelColl, c.shopify_collection_id)
                  }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
                    className: "dw-pick-t",
                    children: c.title
                  }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
                    className: "dw-pick-m tdy-muted",
                    children: [c.collection_type, " · ", c.product_count]
                  }, void 0, true)]
                }, c.shopify_collection_id, true)) : pickProds.filter(p => !pickSearch || (p.title || '').toLowerCase().indexOf(pickSearch.toLowerCase()) >= 0).slice(0, 200).map(p => /*#__PURE__*/_jsxDEV("label", {
                  className: "dw-pick-row",
                  children: [/*#__PURE__*/_jsxDEV("input", {
                    type: "checkbox",
                    checked: selProd.indexOf(p.shopify_product_id) >= 0,
                    onChange: () => toggleIn(selProd, setSelProd, p.shopify_product_id)
                  }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
                    className: "dw-pick-t",
                    children: p.title
                  }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
                    className: "dw-pick-m tdy-muted",
                    children: p.stock_status && p.stock_status !== 'ok' ? '⚠ ' + p.stock_status : p.price != null ? '£' + p.price : ''
                  }, void 0, false)]
                }, p.shopify_product_id, true))
              }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
                className: "dw-pick-sum tdy-muted",
                children: [selColl.length, " collection(s) · ", selProd.length, " product(s) selected — pulled live from Shopify"]
              }, void 0, true), stockRisk && stockRisk.covered_skus > 0 ? /*#__PURE__*/_jsxDEV("div", {
                className: "dw-pick-sum",
                style: {
                  color: stockRisk.skus_at_risk > 0 ? '#e5a54b' : 'inherit'
                },
                children: [stockRisk.skus_at_risk > 0 ? '⚠ ' + stockRisk.skus_at_risk + ' of ' + stockRisk.covered_skus + ' covered SKUs at stock risk for this uplift' + (stockRisk.earliest_reorder_by ? ' — reorder by ' + stockRisk.earliest_reorder_by : '') + '.' : '✓ Stock cover OK across ' + stockRisk.covered_skus + ' covered SKUs for the forecast uplift.', /*#__PURE__*/_jsxDEV("span", {
                  className: "tdy-muted",
                  children: " (based on last saved selection)"
                }, void 0, false)]
              }, void 0, true) : null]
            }, void 0, true) : /*#__PURE__*/_jsxDEV("div", {
              className: "dw-pick-sum tdy-muted",
              children: "Applies to every product in the store."
            }, void 0, false)]
          }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
            className: "dw-sec",
            children: "Creative"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "dw-2",
            children: [text('Creator', 'creator'), text('SKU (manual override)', 'sku')]
          }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
            className: "dw-2",
            children: [text('Content pillar', 'content_pillar'), text('Format', 'format')]
          }, void 0, true), text('Message angle', 'message_angle'), text('CTA', 'cta'), text('Offer', 'offer'), f.row_group === 'promo' ? /*#__PURE__*/_jsxDEV(_Fragment, {
            children: [/*#__PURE__*/_jsxDEV("div", {
              className: "dw-2",
              children: [self('Mechanic', 'offer_type', OFFERS), text('Discount code', 'discount_code')]
            }, void 0, true), numf('Margin floor (CM ratio, e.g. 0.30)', 'margin_floor'), guardrail && guardrail.verdict && guardrail.verdict !== 'ok' ? /*#__PURE__*/_jsxDEV("div", {
              className: "dw-err",
              children: [String(guardrail.verdict).toUpperCase(), ": ", guardrail.reasons]
            }, void 0, true) : null]
          }, void 0, true) : null, /*#__PURE__*/_jsxDEV("div", {
            className: "dw-sec",
            children: "Assets & approval"
          }, void 0, false), text('Asset link', 'asset_link'), text('Usage rights', 'usage_rights'), /*#__PURE__*/_jsxDEV("div", {
            className: "dw-sec",
            children: "Expected (plan)"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "dw-3",
            children: [numf('Revenue £', 'expected_revenue'), numf('Spend £', 'expected_spend'), numf('CM £', 'expected_cm')]
          }, void 0, true), ps && iroas != null ? /*#__PURE__*/_jsxDEV("div", {
            className: "dw-fc",
            children: [/*#__PURE__*/_jsxDEV("b", {
              children: CHANNEL_LABEL[f.channel] || f.channel
            }, void 0, false), " (", channelPlatform(f.channel), ") history: iROAS ", iroas.toFixed(2), "× · £", Math.round(ps.spend_30d || 0).toLocaleString(), " spend/30d.", ' ', fcRev != null ? /*#__PURE__*/_jsxDEV("span", {
              children: ["At £", es.toLocaleString(), " spend → ", /*#__PURE__*/_jsxDEV("b", {
                children: ["£", fcRev.toLocaleString()]
              }, void 0, true), " incremental rev, ", /*#__PURE__*/_jsxDEV("b", {
                children: ["£", fcCam.toLocaleString()]
              }, void 0, true), " CAM", cmRIsFallback ? /*#__PURE__*/_jsxDEV("span", {
                className: "tdy-muted",
                children: " (est. @ 60% CM — brand CM% not available)"
              }, void 0, false) : null, " ", /*#__PURE__*/_jsxDEV("a", {
                className: "dw-fc-use",
                onClick: applyFc,
                children: "use these"
              }, void 0, false)]
            }, void 0, true) : /*#__PURE__*/_jsxDEV("span", {
              children: "enter expected spend to forecast from channel history"
            }, void 0, false)]
          }, void 0, true) : null, isDiscrete ? /*#__PURE__*/_jsxDEV("div", {
            className: "dw-fc",
            children: [/*#__PURE__*/_jsxDEV("div", {
              className: "dw-2",
              children: [/*#__PURE__*/_jsxDEV("label", {
                className: "dw-f dw-numf",
                children: [/*#__PURE__*/_jsxDEV("span", {
                  children: "Discount %"
                }, void 0, false), /*#__PURE__*/_jsxDEV("input", {
                  inputMode: "decimal",
                  value: disc,
                  onChange: ev => setDisc(ev.target.value),
                  placeholder: "e.g. 50"
                }, void 0, false)]
              }, void 0, true), /*#__PURE__*/_jsxDEV("button", {
                className: "dw-fc-use",
                onClick: runPromoFc,
                disabled: pfBusy || numOrNull(disc) == null,
                children: pfBusy ? 'Forecasting…' : 'Forecast from past events'
              }, void 0, false)]
            }, void 0, true), pf && pf.forecast && pf.forecast.central ? /*#__PURE__*/_jsxDEV("div", {
              children: ["At ", disc, "% off → ", /*#__PURE__*/_jsxDEV("b", {
                children: ["£", Math.round(pf.forecast.central.promo_revenue).toLocaleString()]
              }, void 0, true), " revenue · window CM ", /*#__PURE__*/_jsxDEV("b", {
                children: ["£", Math.round(pf.forecast.central.window_cm).toLocaleString()]
              }, void 0, true), ", lifetime CM ", /*#__PURE__*/_jsxDEV("b", {
                children: ["£", Math.round(pf.forecast.central.lifetime_cm).toLocaleString()]
              }, void 0, true), ' ', "(window range £", Math.round(pf.forecast.low.window_cm).toLocaleString(), "…£", Math.round(pf.forecast.high.window_cm).toLocaleString(), ") · CM ", Math.round(pf.economics.cm_under_promo * 100), "% at this depth · ", pf.analogues.source, ".", ' ', /*#__PURE__*/_jsxDEV("a", {
                className: "dw-fc-use",
                onClick: applyPromoFc,
                children: "use these"
              }, void 0, false), pf.note ? /*#__PURE__*/_jsxDEV("div", {
                className: "tdy-muted",
                children: [pf.flags && pf.flags.lifetime_cm_negative ? '⚠ ' : '', pf.note]
              }, void 0, true) : null]
            }, void 0, true) : /*#__PURE__*/_jsxDEV("span", {
              className: "tdy-muted",
              children: "enter a discount % (and optional spend) to forecast revenue, CM, ROAS & MER from similar past events"
            }, void 0, false)]
          }, void 0, true) : null, text('Target KPI', 'target_kpi'), area('Measurement plan', 'measurement_plan'), /*#__PURE__*/_jsxDEV("div", {
            className: "dw-sec",
            children: "Actual (result)"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "dw-3",
            children: [numf('Revenue £', 'actual_revenue'), numf('Spend £', 'actual_spend'), numf('CM £', 'actual_cm')]
          }, void 0, true), revVar != null || cmVar != null ? /*#__PURE__*/_jsxDEV("div", {
            className: "dw-var",
            children: ["vs expected: ", revVar != null ? 'revenue ' + (revVar >= 0 ? '+' : '') + revVar + '%' : '', revVar != null && cmVar != null ? ' · ' : '', cmVar != null ? 'CM ' + (cmVar >= 0 ? '+' : '') + cmVar + '%' : '']
          }, void 0, true) : null, area('Learnings', 'learnings'), /*#__PURE__*/_jsxDEV("div", {
            className: "dw-sec",
            children: "Depends on"
          }, void 0, false), /*#__PURE__*/_jsxDEV("label", {
            className: "dw-f",
            children: [/*#__PURE__*/_jsxDEV("span", {
              children: "Add a prerequisite"
            }, void 0, false), /*#__PURE__*/_jsxDEV("select", {
              value: "",
              onChange: ev => {
                if (ev.target.value) toggleIn(deps, setDeps, ev.target.value);
              },
              children: [/*#__PURE__*/_jsxDEV("option", {
                value: "",
                children: "＋ add a prerequisite…"
              }, void 0, false), siblings.filter(s => deps.indexOf(s.id) < 0).map(s => /*#__PURE__*/_jsxDEV("option", {
                value: s.id,
                children: [s.title, " (", s.start_date, ")"]
              }, s.id, true))]
            }, void 0, true)]
          }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
            children: deps.map(pid => {
              const s = siblings.find(x => x.id === pid);
              return pill((s ? calShort(s.title) : pid) + ' ✕', true, () => toggleIn(deps, setDeps, pid));
            })
          }, void 0, false), readiness && readiness.readiness ? /*#__PURE__*/_jsxDEV("div", {
            className: 'dw-ready ' + (readiness.readiness === 'ready' ? 'ok' : readiness.readiness === 'blocked' ? 'bad' : 'warn'),
            children: ["Readiness: ", readiness.readiness, readiness.reasons ? ' — ' + readiness.reasons : '']
          }, void 0, true) : null]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "dw-foot",
          children: [err ? /*#__PURE__*/_jsxDEV("div", {
            className: "dw-err",
            children: err
          }, void 0, false) : null, /*#__PURE__*/_jsxDEV("button", {
            className: "dw-cancel",
            onClick: props.onClose,
            disabled: saving,
            children: "Cancel"
          }, void 0, false), /*#__PURE__*/_jsxDEV("button", {
            className: "dw-save",
            onClick: save,
            disabled: saving,
            children: saving ? 'Saving…' : e.id ? 'Save changes' : 'Create event'
          }, void 0, false)]
        }, void 0, true)]
      }, void 0, true)]
    }, void 0, true);
  }
  const DAYW = 34;

  // Calendar cockpit scoped styles (rail / tray / empty-state / channel-actuals / risk badge).
  // Tokens-first with the file's established var(name,fallback) idiom — no new hardcoded palette.
  const CG_STYLE = `
.cg-shell{display:flex;align-items:flex-start;gap:0}
.cg-main{flex:1;min-width:0}
.cg-rail{width:300px;flex:none;border-left:1px solid var(--border-subtle,rgba(255,255,255,.12));padding:16px 14px;box-sizing:border-box}
.cg-rail-h{font-size:13px;font-weight:600;margin-bottom:2px}
.cg-rail-sub{color:var(--text-dim,#8b93a4);font-size:11px;margin-bottom:12px}
.cg-rail-stats{display:flex;gap:8px;margin-bottom:14px}
.cg-rail-stat{flex:1;border:1px solid var(--border-subtle,rgba(255,255,255,.12));border-radius:var(--radius-md,6px);padding:8px;text-align:center}
.cg-rail-stat b{display:block;font-family:var(--font-mono,monospace);font-size:16px}
.cg-rail-stat span{font-size:10px;color:var(--text-dim,#8b93a4)}
.cg-sev-high-txt{color:var(--neg,#f4a3a5)}
.cg-rail-empty{color:var(--text-dim,#8b93a4);font-size:12px}
.cg-rail-item{display:flex;gap:9px;padding:9px;border-radius:var(--radius-md,6px);margin-bottom:8px;cursor:pointer;border:1px solid var(--border-subtle,rgba(255,255,255,.12))}
.cg-rail-item:hover{background:var(--surface-2,rgba(255,255,255,.04))}
.cg-rail-itembody{min-width:0}
.cg-rail-msg{font-size:12px;line-height:1.35}
.cg-rail-meta{color:var(--text-dim,#8b93a4);font-size:10px;font-family:var(--font-mono,monospace);margin-top:3px}
.cg-sev{width:6px;border-radius:3px;flex:none}
.cg-sev-high{background:var(--neg,#e5484d)}
.cg-sev-medium{background:var(--warn,#e0a13c)}
.cg-sev-low{background:var(--border-strong,#5b6172)}
.cg-tray{border:1px solid var(--border-subtle,rgba(255,255,255,.12));border-radius:var(--radius-md,6px);padding:14px;margin:12px 0}
.cg-tray-h{font-size:13px;font-weight:600}
.cg-tray-sub{color:var(--text-dim,#8b93a4);font-size:11.5px;margin-bottom:8px}
.cg-tray-row{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--border-subtle,rgba(255,255,255,.1))}
.cg-tray-src{font-family:var(--font-mono,monospace);font-size:9px;padding:2px 7px;border-radius:20px;border:1px dashed var(--accent,#7c8cff);color:var(--accent,#a9b4ff);text-transform:uppercase}
.cg-tray-body{flex:1;min-width:0}
.cg-tray-t{font-size:12.5px}
.cg-tray-m{color:var(--text-dim,#8b93a4);font-size:10.5px;font-family:var(--font-mono,monospace)}
.cg-go,.cg-dismiss{background:transparent;border:1px solid var(--border-subtle,rgba(255,255,255,.15));border-radius:var(--radius-md,6px);padding:4px 10px;font-size:11px;cursor:pointer;color:inherit}
.cg-go{border-color:var(--pos,#2fbf71);color:var(--pos,#8ff0bd)}
.cg-empty{max-width:680px;margin:30px auto;text-align:center}
.cg-empty.cg-empty-busy{opacity:.5;pointer-events:none}
.cg-empty h2{font-size:19px;margin:0 0 6px}
.cg-empty>p{color:var(--text-dim,#8b93a4);margin:0 0 22px}
.cg-empty-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;text-align:left}
.cg-empty-card{border:1px solid var(--border-subtle,rgba(255,255,255,.12));border-radius:var(--radius-md,6px);padding:15px;cursor:pointer}
.cg-empty-card:hover{border-color:var(--accent,#7c8cff)}
.cg-empty-ic{font-size:18px;margin-bottom:8px}
.cg-empty-card h3{margin:0 0 4px;font-size:13.5px}
.cg-empty-card p{margin:0;color:var(--text-dim,#8b93a4);font-size:11.5px}
.cg-act-lane .cg-act-label{font-family:var(--font-mono,monospace);font-size:10px;color:var(--text-dim,#8b93a4);text-transform:uppercase;letter-spacing:.4px}
.cg-act-cell{position:absolute;bottom:2px;display:flex;align-items:flex-end;justify-content:center;height:26px}
.cg-act-bar{width:60%;min-width:3px;background:var(--accent,#7c8cff);opacity:.5;border-radius:2px 2px 0 0}
.cg-bar-risk{box-shadow:0 0 0 1px var(--warn,#e0a13c) inset}
.cg-risk{margin-left:4px;font-size:10px}
@media (max-width:900px){.cg-shell{flex-wrap:wrap}.cg-rail{width:100%;border-left:0;border-top:1px solid var(--border-subtle,rgba(255,255,255,.12))}}
`;

  /* ---------- Calendar cockpit: right-rail "Needs you" (fn_calendar_reminders) ---------- */
  function NeedsYouRail(props) {
    const {
      brandId,
      onOpenEvent
    } = props;
    const [feed, setFeed] = useState({
      count: 0,
      high: 0,
      items: []
    });
    const [loading, setLoading] = useState(true);
    useEffect(() => {
      let live = true;
      const sb = sbClient();
      if (!sb || !brandId) {
        setLoading(false);
        return;
      }
      sb.rpc('fn_calendar_reminders', {
        p_brand: brandId,
        p_within_days: 14
      }).then(r => {
        if (live) setFeed(r && r.data || {
          count: 0,
          high: 0,
          items: []
        });
      }).then(() => {
        if (live) setLoading(false);
      }, () => {
        if (live) setLoading(false);
      });
      return () => {
        live = false;
      };
    }, [brandId]);
    const items = feed.items || [];
    return /*#__PURE__*/_jsxDEV("aside", {
      className: "cg-rail",
      children: [/*#__PURE__*/_jsxDEV("div", {
        className: "cg-rail-h",
        children: "Needs you"
      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
        className: "cg-rail-sub",
        children: "In-app nudges from your calendar."
      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
        className: "cg-rail-stats",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "cg-rail-stat",
          children: [/*#__PURE__*/_jsxDEV("b", {
            className: feed.high ? 'cg-sev-high-txt' : '',
            children: feed.high || 0
          }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
            children: "high"
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "cg-rail-stat",
          children: [/*#__PURE__*/_jsxDEV("b", {
            children: feed.count || 0
          }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
            children: "total"
          }, void 0, false)]
        }, void 0, true)]
      }, void 0, true), loading ? /*#__PURE__*/_jsxDEV("div", {
        className: "cg-rail-empty",
        children: "Loading…"
      }, void 0, false) : items.length === 0 ? /*#__PURE__*/_jsxDEV("div", {
        className: "cg-rail-empty",
        children: "Nothing needs you right now."
      }, void 0, false) : items.map((a, i) => /*#__PURE__*/_jsxDEV("div", {
        className: "cg-rail-item",
        onClick: () => a.event_id && onOpenEvent && onOpenEvent(a.event_id),
        children: [/*#__PURE__*/_jsxDEV("span", {
          className: 'cg-sev cg-sev-' + (a.severity || 'low')
        }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
          className: "cg-rail-itembody",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "cg-rail-msg",
            children: a.message
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "cg-rail-meta",
            children: [a.type, a.days_until != null ? ' · ' + a.days_until + 'd' : '', a.owner ? ' · ' + a.owner : '']
          }, void 0, true)]
        }, void 0, true)]
      }, i, true))]
    }, void 0, true);
  }

  /* ---------- Calendar cockpit: proposed-events tray (status='proposed' → planned/skipped) ---------- */
  function ProposedTray(props) {
    const rows = props.rows || [];
    if (rows.length === 0) return null;
    return /*#__PURE__*/_jsxDEV("div", {
      className: "cg-tray",
      children: [/*#__PURE__*/_jsxDEV("div", {
        className: "cg-tray-h",
        children: "Proposed — confirm to add"
      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
        className: "cg-tray-sub",
        children: "Detected from your Shopify codes, Klaviyo sends and the UK calendar. Nothing is added until you confirm."
      }, void 0, false), rows.map(p => /*#__PURE__*/_jsxDEV("div", {
        className: "cg-tray-row",
        children: [/*#__PURE__*/_jsxDEV("span", {
          className: "cg-tray-src",
          children: String(p.source || 'proposed').replace('auto_', '')
        }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
          className: "cg-tray-body",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "cg-tray-t",
            children: p.title
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "cg-tray-m",
            children: [p.start_date, p.expected_revenue ? ' · ' + tdyMoney(p.expected_revenue) : '']
          }, void 0, true)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("button", {
          className: "cg-go",
          onClick: () => props.onAct(p.id, 'planned'),
          children: "Confirm"
        }, void 0, false), /*#__PURE__*/_jsxDEV("button", {
          className: "cg-dismiss",
          onClick: () => props.onAct(p.id, 'skipped'),
          children: "Dismiss"
        }, void 0, false)]
      }, p.id, true))]
    }, void 0, true);
  }

  /* ---------- Calendar cockpit: empty-state build journey (4 builders) ---------- */
  function EmptyStateBuilders(props) {
    const {
      brandId,
      onEdit,
      onBuilt
    } = props;
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState('');
    const year = new Date().getFullYear();
    const run = async fn => {
      setBusy(true);
      setErr('');
      try {
        await fn();
        await onBuilt();
      } catch (ex) {
        setErr(ex && ex.message || 'Builder failed.');
      } finally {
        setBusy(false);
      }
    };
    const seasonality = async () => {
      const r = await sbClient().rpc('fn_calendar_seasonality', {
        p_brand: brandId,
        p_year: year,
        p_commit: true
      });
      if (r && r.error) throw r.error;
    };
    // p_min_rev passed to bind the 4-arg overload unambiguously (two overloads exist in prod).
    const propose = async () => {
      const r = await sbClient().rpc('fn_calendar_propose_events', {
        p_brand: brandId,
        p_commit: true,
        p_lookback: 90,
        p_min_rev: 50
      });
      if (r && r.error) throw r.error;
    };
    const builders = [{
      ic: '🗓️',
      h: 'Generate key dates',
      p: 'Auto-place UK retail moments, paydays, delivery cutoffs.',
      run: seasonality
    }, {
      ic: '✨',
      h: 'Import from your activity',
      p: 'Detect promos & email sends you already ran.',
      run: propose
    }, {
      ic: '➕',
      h: 'Add a moment',
      p: 'Promo, launch, email, paid — pickers + instant forecast.',
      run: async () => onEdit && onEdit({
        start_date: new Date().toISOString().slice(0, 10)
      })
    }, {
      ic: '📋',
      h: 'Start from a template',
      p: 'Launch / evergreen / seasonal playbooks.',
      run: async () => onEdit && onEdit({
        row_group: 'promo',
        start_date: new Date().toISOString().slice(0, 10)
      })
    }];
    return /*#__PURE__*/_jsxDEV("div", {
      className: 'cg-empty' + (busy ? ' cg-empty-busy' : ''),
      children: [/*#__PURE__*/_jsxDEV("h2", {
        children: "Let's build your calendar"
      }, void 0, false), /*#__PURE__*/_jsxDEV("p", {
        children: "Start from what Greta already knows — you confirm, you don't type."
      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
        className: "cg-empty-grid",
        children: builders.map(b => /*#__PURE__*/_jsxDEV("div", {
          className: "cg-empty-card",
          onClick: () => !busy && run(b.run),
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "cg-empty-ic",
            children: b.ic
          }, void 0, false), /*#__PURE__*/_jsxDEV("h3", {
            children: b.h
          }, void 0, false), /*#__PURE__*/_jsxDEV("p", {
            children: b.p
          }, void 0, false)]
        }, b.h, true))
      }, void 0, false), err ? /*#__PURE__*/_jsxDEV("div", {
        className: "dw-err",
        style: {
          marginTop: '12px'
        },
        children: err
      }, void 0, false) : null]
    }, void 0, true);
  }
  function Calendar(props) {
    const brandId = props.brandId || window.OI_BRAND;
    const [events, setEvents] = useState(null);
    /* 2026-07-14 fix (§6 audit, item 4): vw_brand_calendar.lift_vs_baseline is a GROSS read
       (window daily revenue / trailing-365d daily revenue — no trough/pull-forward netting,
       no provisional/collided handling). It was kept as a fallback since 2026-07-12 so any
       event without an actualisation row yet still got a hot/cool colour — but that fallback
       is exactly the "two truths" risk the spec calls out: same calendar, one event coloured
       by a real net-of-trough CM read, the next by a gross ratio, with no visual distinction.
       Retired outright. An event with no vw_event_actualisation row now falls back to its
       approval_status (blocked/approved/pending) — an honest "not yet measured" state,
       not a fabricated performance read. */
    const [actMap, setActMap] = useState({});
    const [platformStats, setPlatformStats] = useState({});
    const [cmRatio, setCmRatio] = useState(0.6);
    const [err, setErr] = useState(null);
    const [editing, setEditing] = useState(null);
    // Calendar cockpit (0119–0127): live channel actuals overlay + per-event at-risk badges.
    const [channelActs, setChannelActs] = useState([]); // vw_calendar_channel_actuals rows
    const [riskMap, setRiskMap] = useState({}); // event_id -> { atRisk, reasons[] }
    const [collapsed, setCollapsed] = useState({});
    const [cursor, setCursor] = useState(() => {
      const d = new Date();
      return new Date(d.getFullYear(), d.getMonth(), 1);
    });
    const [drag, setDrag] = useState(null);
    const dragRef = useRef(null);
    useEffect(() => {
      dragRef.current = drag;
    }, [drag]);
    const reload = useCallback(() => {
      let alive = true;
      const sb = sbClient();
      if (!sb) {
        setErr('No Supabase client available.');
        return () => {
          alive = false;
        };
      }
      Promise.all([sb.from('mos_calendar_event').select('id,campaign_id,row_group,channel,title,description,start_date,end_date,creator,sku,content_pillar,format,message_angle,cta,asset_link,usage_rights,approval_status,status,funnel_stage,owner,due_date,brief,offer_type,discount_pct,discount_code,margin_floor,source,expected_revenue,expected_spend,expected_cm,target_kpi,measurement_plan,actual_revenue,actual_spend,actual_cm,revenue_basis,learnings,metadata').eq('brand_id', brandId), sb.from('vw_platform_channel').select('platform,spend_30d,reported_roas,normalized_iroas').eq('brand_id', brandId), sb.from('vw_brand_cm_ladder').select('cm_ratio').eq('brand_id', brandId),
      // The one canonical event-impact read (net of trough, provisional/collided-aware) — see the
      // 2026-07-14 retirement note in this component's header for what this replaced.
      sb.from('vw_event_actualisation').select('event_id,cm_impact,net_revenue_impact,event_delta,provisional,collided,baseline_source').eq('brand_id', brandId),
      // Live per-day channel actuals overlaid on the Channels group (0122).
      sb.from('vw_calendar_channel_actuals').select('day,row_group,row_key,platform,spend,reported_revenue,orders,sends,reported_roas').eq('brand_id', brandId),
      // At-risk signals badged onto event bars (0124–0127).
      sb.from('vw_event_readiness').select('event_id,readiness,reasons').eq('brand_id', brandId), sb.from('vw_promo_guardrail').select('event_id,verdict,reasons').eq('brand_id', brandId), sb.from('vw_event_creative_demand').select('event_id,creative_status,reason').eq('brand_id', brandId), sb.from('vw_event_blockers').select('event_id,unmet_deps,reasons').eq('brand_id', brandId)]).then(res => {
        if (!alive) return;
        const ev = res[0],
          pc = res[1],
          cm = res[2],
          ac = res[3],
          ca = res[4];
        const rd = res[5],
          gr = res[6],
          cd = res[7],
          bl = res[8];
        if (ev.error) {
          setErr(ev.error.message);
          return;
        }
        const ps = {};
        (pc.data || []).forEach(r => {
          ps[r.platform] = r;
        });
        const am = {};
        (ac && ac.data || []).forEach(r => {
          if (r.event_id != null) am[r.event_id] = r;
        });
        // Build the per-event at-risk map. A bar is badged when any signal is red; reasons collected
        // for the tooltip. Views are RLS-scoped and may be empty — every access is guarded.
        const rm = {};
        const flag = (id, why) => {
          if (id == null) return;
          rm[id] || (rm[id] = {
            atRisk: false,
            reasons: []
          });
          rm[id].atRisk = true;
          if (why) rm[id].reasons.push(why);
        };
        (rd && rd.data || []).forEach(r => {
          if (r.readiness === 'blocked' || r.readiness === 'at_risk') flag(r.event_id, r.reasons || 'readiness: ' + r.readiness);
        });
        (gr && gr.data || []).forEach(r => {
          if (r.verdict && r.verdict !== 'ok') flag(r.event_id, r.reasons || 'guardrail: ' + r.verdict);
        });
        (cd && cd.data || []).forEach(r => {
          if (r.creative_status && r.creative_status !== 'ok' && r.creative_status !== 'covered') flag(r.event_id, r.reason || 'creative: ' + r.creative_status);
        });
        (bl && bl.data || []).forEach(r => {
          if (r.unmet_deps > 0) flag(r.event_id, r.reasons || r.unmet_deps + ' unmet dependency(ies)');
        });
        setActMap(am);
        setRiskMap(rm);
        setChannelActs(ca && ca.data || []);
        setEvents(ev.data || []);
        setPlatformStats(ps);
        setCmRatio(cm.data && cm.data[0] && cm.data[0].cm_ratio != null ? Number(cm.data[0].cm_ratio) : 0.6);
      });
      return () => {
        alive = false;
      };
    }, [brandId]);
    useEffect(() => reload(), [reload]);
    const year = cursor.getFullYear(),
      month = cursor.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const moveEvent = useCallback(async (e, delta) => {
      if (!delta) return;
      const ns = new Date(calParse(e.start_date));
      ns.setDate(ns.getDate() + delta);
      let ne = null;
      if (e.end_date) {
        ne = new Date(calParse(e.end_date));
        ne.setDate(ne.getDate() + delta);
      }
      const {
        error
      } = await sbClient().from('mos_calendar_event').update({
        start_date: ymd(ns),
        end_date: ne ? ymd(ne) : null,
        updated_at: new Date().toISOString()
      }).eq('id', e.id);
      if (!error) reload();
    }, [reload]);
    useEffect(() => {
      if (!drag) return;
      const dayIdx = (el, clientX) => {
        const r = el.getBoundingClientRect();
        return Math.max(0, Math.min(daysInMonth - 1, Math.floor((clientX - r.left) / DAYW)));
      };
      const mm = ev => setDrag(d => {
        if (!d) return d;
        const idx = dayIdx(d.el, ev.clientX);
        if (d.mode === 'create') return {
          ...d,
          cur: idx
        };
        if (d.mode === 'move') {
          const delta = idx - d.grabIdx;
          return {
            ...d,
            delta,
            moved: d.moved || delta !== 0
          };
        }
        return d;
      });
      const mu = () => {
        const d = dragRef.current;
        setDrag(null);
        if (!d) return;
        if (d.mode === 'create') {
          const a = Math.min(d.anchor, d.cur),
            b = Math.max(d.anchor, d.cur);
          setEditing({
            row_group: d.group,
            start_date: ymd(new Date(year, month, a + 1)),
            end_date: a === b ? '' : ymd(new Date(year, month, b + 1))
          });
        } else if (d.mode === 'move') {
          if (d.moved && d.delta) moveEvent(d.event, d.delta);else setEditing(d.event);
        }
      };
      window.addEventListener('mousemove', mm);
      window.addEventListener('mouseup', mu);
      return () => {
        window.removeEventListener('mousemove', mm);
        window.removeEventListener('mouseup', mu);
      };
    }, [!!drag, daysInMonth, year, month, moveEvent]);
    if (err) return /*#__PURE__*/_jsxDEV("div", {
      className: "tg-view",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: ["Couldn't load calendar — ", err]
      }, void 0, true)
    }, void 0, false);
    if (!events) return /*#__PURE__*/_jsxDEV("div", {
      className: "tg-view",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: "Loading…"
      }, void 0, false)
    }, void 0, false);
    const today = ymd0(new Date());
    const evClass = e => {
      // Single canonical event-impact read (vw_event_actualisation, net of trough): collided
      // reads are quarantined (J3), never coloured as wins or losses; provisional stays
      // pending-styled until returns close. No gross-lift fallback — see the retirement note
      // in this component's header. An event with no actualisation row yet is genuinely
      // "not measured", so it falls back to its approval_status, not a fabricated performance colour.
      const act = actMap[e.id];
      if (act) {
        if (act.collided) return 'cg-collided';
        if (act.cm_impact != null && !act.provisional) return calClass(Number(act.cm_impact));
        if (act.provisional) return 'cg-pending';
      }
      if (e.approval_status === 'blocked') return 'cg-blocked';
      if (e.approval_status === 'approved') return 'cg-approved';
      return 'cg-pending';
    };
    // Honest tooltip per event — the CM verdict, its state, and its baseline source.
    const evTitle = e => {
      const act = actMap[e.id];
      if (!act) return e.title || '';
      const bits = [e.title || ''];
      if (act.collided) bits.push('⚠ collided — started inside a prior event’s decay window; not an execution read (J3)');
      if (act.cm_impact != null) bits.push('CM impact (net of trough): £' + Math.round(Number(act.cm_impact)).toLocaleString());else if (act.event_delta != null) bits.push('window delta: £' + Math.round(Number(act.event_delta)).toLocaleString() + ' (trough not yet readable)');
      if (act.provisional) bits.push('provisional — returns window still open');
      if (act.baseline_source) bits.push('baseline: ' + (act.baseline_source === 'daily_forecast' ? 'forecast' : 'pre-window (naive)'));
      return bits.join('\n');
    };
    const mStart = ymd0(new Date(year, month, 1)),
      mEnd = ymd0(new Date(year, month, daysInMonth));
    const dayList = [];
    for (let i = 0; i < daysInMonth; i++) dayList.push(new Date(year, month, i + 1));
    const trackW = daysInMonth * DAYW;
    const todayIdx = today >= mStart && today <= mEnd ? today.getDate() - 1 : -1;
    const seg = e => {
      const s = ymd0(calParse(e.start_date)),
        en = ymd0(calParse(e.end_date || e.start_date));
      if (en < mStart || s > mEnd) return null;
      const a = s < mStart ? mStart : s,
        b = en > mEnd ? mEnd : en;
      return {
        startIdx: Math.round((a - mStart) / 864e5),
        len: Math.round((b - a) / 864e5) + 1,
        contL: s < mStart,
        contR: en > mEnd
      };
    };
    const byGroup = {};
    CG_GROUPS.forEach(g => {
      byGroup[g[0]] = [];
    });
    events.forEach(e => {
      if (seg(e)) (byGroup[e.row_group] || (byGroup[e.row_group] = [])).push(e);
    });
    Object.keys(byGroup).forEach(g => byGroup[g].sort((a, b) => a.start_date < b.start_date ? -1 : 1));
    const monthLabel = cursor.toLocaleString('en', {
      month: 'long',
      year: 'numeric'
    });
    const go = delta => setCursor(new Date(year, month + delta, 1));
    const goToday = () => {
      const d = new Date();
      setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
    };
    const gridlines = {
      backgroundImage: 'repeating-linear-gradient(to right, transparent 0, transparent ' + (DAYW - 1) + 'px, var(--border-subtle) ' + (DAYW - 1) + 'px, var(--border-subtle) ' + DAYW + 'px)'
    };
    const dayIdxOf = (el, clientX) => {
      const r = el.getBoundingClientRect();
      return Math.max(0, Math.min(daysInMonth - 1, Math.floor((clientX - r.left) / DAYW)));
    };
    const todayLine = todayIdx >= 0 ? /*#__PURE__*/_jsxDEV("div", {
      className: "tg-todayline",
      style: {
        left: todayIdx * DAYW + DAYW / 2 - 1
      }
    }, void 0, false) : null;

    // Proposed-events tray + empty-state gate.
    const setEventStatus = async (id, status) => {
      const {
        error
      } = await sbClient().from('mos_calendar_event').update({
        status,
        updated_at: new Date().toISOString()
      }).eq('id', id);
      if (!error) reload();
    };
    const proposedRows = events.filter(e => e.status === 'proposed');
    const noEvents = events.filter(e => e.status !== 'skipped').length === 0;

    // Channel actuals overlay: index vw_calendar_channel_actuals by row_key→day, track a per-row max
    // for the bar height, and the day-indices already covered by a planned Channels-group event.
    const actByKeyDay = {},
      actKeys = [],
      actMaxByKey = {};
    const actVal = r => r.reported_revenue != null ? Number(r.reported_revenue) : r.spend != null ? Number(r.spend) : r.sends != null ? Number(r.sends) : 0;
    channelActs.forEach(r => {
      const k = r.row_key;
      if (!k) return;
      const day = String(r.day).slice(0, 10);
      if (!actByKeyDay[k]) {
        actByKeyDay[k] = {};
        actKeys.push(k);
        actMaxByKey[k] = 0;
      }
      actByKeyDay[k][day] = r;
      actMaxByKey[k] = Math.max(actMaxByKey[k], actVal(r));
    });
    actKeys.sort();
    const coveredByKey = {};
    (byGroup['channel'] || []).forEach(e => {
      const k = actualKey(e.channel);
      if (!k) return;
      const s = seg(e);
      if (!s) return;
      const set = coveredByKey[k] || (coveredByKey[k] = {});
      for (let i = 0; i < s.len; i++) set[s.startIdx + i] = true;
    });
    return /*#__PURE__*/_jsxDEV("div", {
      className: "cg-shell",
      children: [/*#__PURE__*/_jsxDEV("style", {
        children: CG_STYLE
      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
        className: 'cg-main tg-view' + (drag ? ' tg-dragging' : ''),
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "mc-top",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "mc-nav",
            children: [/*#__PURE__*/_jsxDEV("button", {
              className: "mc-arrow",
              onClick: () => go(-1),
              title: "Previous month",
              children: "‹"
            }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
              className: "mc-month",
              children: monthLabel
            }, void 0, false), /*#__PURE__*/_jsxDEV("button", {
              className: "mc-arrow",
              onClick: () => go(1),
              title: "Next month",
              children: "›"
            }, void 0, false), /*#__PURE__*/_jsxDEV("button", {
              className: "mc-today-btn",
              onClick: goToday,
              children: "Today"
            }, void 0, false)]
          }, void 0, true), /*#__PURE__*/_jsxDEV("button", {
            className: "cg-add",
            onClick: () => setEditing({
              start_date: ymd(new Date(year, month, Math.min(new Date().getDate(), daysInMonth)))
            }),
            children: "+ Add event"
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV(ProposedTray, {
          rows: proposedRows,
          onAct: setEventStatus
        }, void 0, false), noEvents ? /*#__PURE__*/_jsxDEV(EmptyStateBuilders, {
          brandId: brandId,
          onEdit: setEditing,
          onBuilt: reload
        }, void 0, false) : /*#__PURE__*/_jsxDEV(_Fragment, {
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "tg-scroll",
            children: /*#__PURE__*/_jsxDEV("div", {
              className: "tg",
              style: {
                width: 140 + trackW
              },
              children: [/*#__PURE__*/_jsxDEV("div", {
                className: "tg-headrow",
                children: [/*#__PURE__*/_jsxDEV("div", {
                  className: "tg-corner",
                  children: monthLabel
                }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
                  className: "tg-days",
                  children: dayList.map((d, i) => {
                    const wknd = d.getDay() === 0 || d.getDay() === 6;
                    return /*#__PURE__*/_jsxDEV("div", {
                      className: 'tg-day' + (wknd ? ' wknd' : '') + (i === todayIdx ? ' tdy' : ''),
                      style: {
                        width: DAYW
                      },
                      onClick: () => setEditing({
                        start_date: ymd(d)
                      }),
                      title: 'Add event on ' + ymd(d),
                      children: [/*#__PURE__*/_jsxDEV("div", {
                        className: "wd",
                        children: WD1[d.getDay()]
                      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
                        className: "dn",
                        children: i + 1
                      }, void 0, false)]
                    }, i, true);
                  })
                }, void 0, false)]
              }, void 0, true), CG_GROUPS.map(gp => {
                const g = gp[0],
                  label = gp[1];
                const rows = byGroup[g] || [];
                const isCol = collapsed[g];
                const ghost = drag && drag.mode === 'create' && drag.group === g;
                const ga = ghost ? Math.min(drag.anchor, drag.cur) : 0;
                const gb = ghost ? Math.max(drag.anchor, drag.cur) : 0;
                return /*#__PURE__*/_jsxDEV("div", {
                  className: "tg-group",
                  children: [/*#__PURE__*/_jsxDEV("div", {
                    className: "tg-grouprow",
                    children: [/*#__PURE__*/_jsxDEV("div", {
                      className: "tg-glabel",
                      onClick: () => setCollapsed({
                        ...collapsed,
                        [g]: !isCol
                      }),
                      children: [/*#__PURE__*/_jsxDEV("span", {
                        className: "cg-caret",
                        children: isCol ? '▸' : '▾'
                      }, void 0, false), label, /*#__PURE__*/_jsxDEV("span", {
                        className: "cg-count",
                        children: rows.length
                      }, void 0, false)]
                    }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
                      className: "tg-gtrack",
                      style: {
                        width: trackW,
                        ...gridlines
                      },
                      onMouseDown: e2 => {
                        e2.preventDefault();
                        const idx = dayIdxOf(e2.currentTarget, e2.clientX);
                        setDrag({
                          mode: 'create',
                          group: g,
                          anchor: idx,
                          cur: idx,
                          el: e2.currentTarget
                        });
                      },
                      title: "Click or drag to add an event in this row",
                      children: [todayLine, ghost ? /*#__PURE__*/_jsxDEV("div", {
                        className: "tg-ghost",
                        style: {
                          left: ga * DAYW + 1,
                          width: (gb - ga + 1) * DAYW - 2
                        }
                      }, void 0, false) : null]
                    }, void 0, true)]
                  }, void 0, true), !isCol && rows.length === 0 ? /*#__PURE__*/_jsxDEV("div", {
                    className: "tg-lane",
                    children: [/*#__PURE__*/_jsxDEV("div", {
                      className: "tg-llabel tg-llabel-empty",
                      children: "— nothing this month"
                    }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
                      className: "tg-ltrack",
                      style: {
                        width: trackW,
                        ...gridlines
                      },
                      children: todayLine
                    }, void 0, false)]
                  }, void 0, true) : null, !isCol && rows.map(e => {
                    const s = seg(e);
                    const isDragged = drag && drag.mode === 'move' && drag.event.id === e.id;
                    const off = isDragged ? drag.delta * DAYW : 0;
                    return /*#__PURE__*/_jsxDEV("div", {
                      className: "tg-lane",
                      children: [/*#__PURE__*/_jsxDEV("div", {
                        className: "tg-llabel",
                        title: e.title,
                        children: calShort(e.title)
                      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
                        className: "tg-ltrack",
                        style: {
                          width: trackW,
                          ...gridlines
                        },
                        children: [todayLine, /*#__PURE__*/_jsxDEV("div", {
                          className: 'tg-bar ' + evClass(e) + (s.contL ? ' contL' : '') + (s.contR ? ' contR' : '') + (isDragged ? ' tg-bar-drag' : '') + (riskMap[e.id] && riskMap[e.id].atRisk ? ' cg-bar-risk' : ''),
                          style: {
                            left: s.startIdx * DAYW + 1 + off,
                            width: s.len * DAYW - 2
                          },
                          onMouseDown: e2 => {
                            e2.stopPropagation();
                            e2.preventDefault();
                            const el = e2.currentTarget.closest('.tg-ltrack');
                            const idx = dayIdxOf(el, e2.clientX);
                            setDrag({
                              mode: 'move',
                              event: e,
                              grabIdx: idx,
                              delta: 0,
                              moved: false,
                              el
                            });
                          },
                          title: (actMap[e.id] ? evTitle(e) : e.title + ' — drag to move, click to edit') + (riskMap[e.id] && riskMap[e.id].atRisk ? '\n⚠ ' + riskMap[e.id].reasons.join('; ') : ''),
                          children: [/*#__PURE__*/_jsxDEV("span", {
                            className: "tg-bar-t",
                            children: calShort(e.title)
                          }, void 0, false), riskMap[e.id] && riskMap[e.id].atRisk ? /*#__PURE__*/_jsxDEV("span", {
                            className: "cg-risk",
                            children: "⚠"
                          }, void 0, false) : null]
                        }, void 0, true)]
                      }, void 0, true)]
                    }, e.id, true);
                  }), !isCol && g === 'channel' && actKeys.length ? actKeys.map(k => /*#__PURE__*/_jsxDEV("div", {
                    className: "tg-lane cg-act-lane",
                    children: [/*#__PURE__*/_jsxDEV("div", {
                      className: "tg-llabel cg-act-label",
                      title: 'Live actuals · ' + k,
                      children: k
                    }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
                      className: "tg-ltrack",
                      style: {
                        width: trackW,
                        ...gridlines
                      },
                      children: [todayLine, dayList.map((d, i) => {
                        if (coveredByKey[k] && coveredByKey[k][i]) return null; // planned event covers this day → no overlay
                        const a = actByKeyDay[k] && actByKeyDay[k][ymd(d)];
                        if (!a) return null;
                        const v = actVal(a);
                        if (!v) return null;
                        const h = Math.max(2, Math.round(24 * v / (actMaxByKey[k] || 1)));
                        const tip = k + ' ' + ymd(d) + ' — rev ' + tdyMoney(a.reported_revenue) + (a.spend != null ? ', spend ' + tdyMoney(a.spend) : '') + (a.reported_roas != null ? ', ROAS ' + a.reported_roas + 'x' : '') + (a.sends != null ? ', ' + Math.round(a.sends) + ' sends' : '');
                        return /*#__PURE__*/_jsxDEV("div", {
                          className: "cg-act-cell",
                          style: {
                            left: i * DAYW + 1,
                            width: DAYW - 2
                          },
                          title: tip,
                          children: /*#__PURE__*/_jsxDEV("div", {
                            className: "cg-act-bar",
                            style: {
                              height: h
                            }
                          }, void 0, false)
                        }, i, false);
                      })]
                    }, void 0, true)]
                  }, 'act-' + k, true)) : null]
                }, g, true);
              })]
            }, void 0, true)
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "cg-foot",
            children: "Click a day cell to add, drag for multi-day, click a bar to edit. Colour = CM impact net of pull-forward (past; hollow = provisional, ⚠ = collided) or approval (planned). Bars under Channels = live per-day actuals (hover for £/ROAS); ⚠ = at-risk."
          }, void 0, false)]
        }, void 0, true)]
      }, void 0, true), /*#__PURE__*/_jsxDEV(NeedsYouRail, {
        brandId: brandId,
        onOpenEvent: id => {
          const ev = (events || []).find(x => x.id === id);
          setEditing(ev || {
            id
          });
        }
      }, void 0, false), editing ? /*#__PURE__*/_jsxDEV(EventDrawer, {
        brandId: brandId,
        event: editing,
        platformStats: platformStats,
        cmRatio: cmRatio,
        onClose: () => setEditing(null),
        onSaved: () => {
          setEditing(null);
          reload();
        }
      }, editing.id || 'new', false) : null]
    }, void 0, true);
  }

  /* ---------- Performance: Products & Stock drill-down (2026-07-13 IA spec, build order 3) ----------
   * Reads `performance_stock`. First Performance page built — the spec's flagged content gap. The other
   * eight (CRO, Email, Organic, Creative, Competitors, Business, Customers, Channels) are ports of
   * existing tab content and are the next build-order item, not this one. */
  function PfGateBanner({
    label,
    gate
  }) {
    if (!gate) return null;
    const cls = gate.status === 'blocked' || gate.status === 'attention' ? 'ov-rag-red' : gate.status === 'warn' ? 'ov-rag-amber' : gate.status === 'unknown' ? 'ov-rag-grey' : 'ov-rag-green';
    return /*#__PURE__*/_jsxDEV("div", {
      className: "pf-gate-row",
      children: [/*#__PURE__*/_jsxDEV("span", {
        className: 'ov-rag ' + cls,
        children: label
      }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
        className: "pf-gate-detail",
        children: gate.detail
      }, void 0, false)]
    }, void 0, true);
  }
  function PerformanceStock(props) {
    const {
      brandId
    } = props;
    // Same top-level default-fetcher pattern as Today/Overview — this is a nav destination mounted
    // directly by Shell, not a child that's always handed a memoized fetcher from a parent.
    const fetcher = useMemo(() => props.fetcher || tdyDefaultFetcher(props.apiBase, props.getToken), [props.fetcher, props.apiBase, props.getToken]);
    const [data, setData] = useState(null);
    const [err, setErr] = useState(null);
    const [tab, setTab] = useState('reorder'); // 'reorder' | 'stockouts' | 'overstock' | 'all'
    useEffect(() => {
      let alive = true;
      fetcher('performance_stock', {
        brandId
      }).then(d => {
        if (alive) setData(d);
      }).catch(e => {
        if (alive) setErr(String(e && e.message ? e.message : e));
      });
      return () => {
        alive = false;
      };
    }, [brandId, fetcher]);
    if (err) return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: ["Couldn't load Products & Stock — ", err]
      }, void 0, true)
    }, void 0, false);
    if (!data) return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: "Loading…"
      }, void 0, false)
    }, void 0, false);
    const skus = data.skus || [];
    const stockouts = skus.filter(s => s.stock_status === 'stockout');
    const overstock = skus.filter(s => s.stock_status === 'overstock');
    const shown = tab === 'stockouts' ? stockouts : tab === 'overstock' ? overstock : tab === 'reorder' ? data.demand_plan || [] : skus;
    return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: [/*#__PURE__*/_jsxDEV("div", {
        className: "mos-head",
        children: [/*#__PURE__*/_jsxDEV("h1", {
          className: "mos-title",
          children: "Products & Stock"
        }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
          className: "mos-asof",
          children: [skus.length, " SKUs tracked"]
        }, void 0, true)]
      }, void 0, true), data.insight && /*#__PURE__*/_jsxDEV("div", {
        className: "ov-insight",
        children: [data.insight.text, data.insight.kind === 'rule_based' && /*#__PURE__*/_jsxDEV("span", {
          className: "tdy-muted",
          children: " (rule-based read, not LLM-generated)"
        }, void 0, false)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
        className: "pf-gates",
        children: [/*#__PURE__*/_jsxDEV(PfGateBanner, {
          label: "S1 · availability",
          gate: data.gates?.s1
        }, void 0, false), /*#__PURE__*/_jsxDEV(PfGateBanner, {
          label: "S2 · trapped cash",
          gate: data.gates?.s2
        }, void 0, false), /*#__PURE__*/_jsxDEV(PfGateBanner, {
          label: "S3 · scale gate",
          gate: data.gates?.s3
        }, void 0, false)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
        className: "ov-grid",
        style: {
          marginBottom: 'var(--space-4, 16px)'
        },
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Stockouts"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: data.counts?.stockout || 0
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Overstock"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: data.counts?.overstock || 0
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Healthy"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: data.counts?.healthy || 0
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Lost CM/day"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: tdyMoney(data.total_lost_cm_per_day)
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Cash trapped"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: tdyMoney(data.total_trapped_cash)
          }, void 0, false)]
        }, void 0, true)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
        className: "nav",
        style: {
          marginTop: 0
        },
        children: [/*#__PURE__*/_jsxDEV("button", {
          className: 'nav-item' + (tab === 'reorder' ? ' nav-active' : ''),
          onClick: () => setTab('reorder'),
          children: ["Reorder (", (data.demand_plan || []).length, ")"]
        }, void 0, true), /*#__PURE__*/_jsxDEV("button", {
          className: 'nav-item' + (tab === 'stockouts' ? ' nav-active' : ''),
          onClick: () => setTab('stockouts'),
          children: ["Stockouts (", stockouts.length, ")"]
        }, void 0, true), /*#__PURE__*/_jsxDEV("button", {
          className: 'nav-item' + (tab === 'overstock' ? ' nav-active' : ''),
          onClick: () => setTab('overstock'),
          children: ["Overstock (", overstock.length, ")"]
        }, void 0, true), /*#__PURE__*/_jsxDEV("button", {
          className: 'nav-item' + (tab === 'all' ? ' nav-active' : ''),
          onClick: () => setTab('all'),
          children: ["All SKUs (", skus.length, ")"]
        }, void 0, true)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("table", {
        className: "mos-table pf-table",
        children: [/*#__PURE__*/_jsxDEV("thead", {
          children: /*#__PURE__*/_jsxDEV("tr", {
            children: [/*#__PURE__*/_jsxDEV("th", {
              style: {
                textAlign: 'left'
              },
              children: "SKU"
            }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
              children: "On hand"
            }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
              children: "Weekly vel."
            }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
              children: "Wks cover"
            }, void 0, false), tab === 'reorder' ? /*#__PURE__*/_jsxDEV(_Fragment, {
              children: [/*#__PURE__*/_jsxDEV("th", {
                children: "Reorder by"
              }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
                children: "Suggested units"
              }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
                children: "CM at risk"
              }, void 0, false)]
            }, void 0, true) : /*#__PURE__*/_jsxDEV(_Fragment, {
              children: [/*#__PURE__*/_jsxDEV("th", {
                children: "Lost CM/day"
              }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
                children: "Trapped cash"
              }, void 0, false)]
            }, void 0, true)]
          }, void 0, true)
        }, void 0, false), /*#__PURE__*/_jsxDEV("tbody", {
          children: shown.slice(0, 100).map(s => /*#__PURE__*/_jsxDEV("tr", {
            children: [/*#__PURE__*/_jsxDEV("td", {
              style: {
                textAlign: 'left'
              },
              children: [s.product_title || s.sku, /*#__PURE__*/_jsxDEV("div", {
                className: "tdy-muted",
                style: {
                  fontSize: '10px'
                },
                children: s.sku
              }, void 0, false)]
            }, void 0, true), /*#__PURE__*/_jsxDEV("td", {
              children: s.on_hand ?? '—'
            }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
              children: s.weekly_velocity ?? '—'
            }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
              children: s.weeks_of_cover != null ? Number(s.weeks_of_cover).toFixed(1) : '—'
            }, void 0, false), tab === 'reorder' ? /*#__PURE__*/_jsxDEV(_Fragment, {
              children: [/*#__PURE__*/_jsxDEV("td", {
                children: s.reorder_by_date || '—'
              }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
                children: s.suggested_order_units ?? '—'
              }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
                children: tdyMoney(s.cm_at_risk_before_resupply)
              }, void 0, false)]
            }, void 0, true) : /*#__PURE__*/_jsxDEV(_Fragment, {
              children: [/*#__PURE__*/_jsxDEV("td", {
                children: tdyMoney(s.lost_cm_per_day)
              }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
                children: tdyMoney(s.trapped_cash)
              }, void 0, false)]
            }, void 0, true)]
          }, s.sku, true))
        }, void 0, false)]
      }, void 0, true), shown.length === 0 && /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: "Nothing in this view."
      }, void 0, false), shown.length > 100 && /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-muted",
        style: {
          marginTop: '8px'
        },
        children: ["Showing first 100 of ", shown.length, "."]
      }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
        className: "mos-basis",
        style: {
          marginTop: 'var(--space-6, 24px)'
        },
        children: ["Product performance (share/velocity trend) reads ", data.products?.length || 0, " products from vw_product_performance — full table not yet surfaced here; available via the edge fn for a future pass."]
      }, void 0, true)]
    }, void 0, true);
  }

  /* ---------- Performance drill-downs (2026-07-13 IA spec, build order 4) ----------
   * Conversion/CRO, Email, Organic/SEO, Creative, Competitors. Same tdyDefaultFetcher pattern as
   * PerformanceStock — each is a standalone nav destination, not a child handed a memoized fetcher. */
  function PerformanceCro(props) {
    const {
      brandId
    } = props;
    const fetcher = useMemo(() => props.fetcher || tdyDefaultFetcher(props.apiBase, props.getToken), [props.fetcher, props.apiBase, props.getToken]);
    const [data, setData] = useState(null);
    const [err, setErr] = useState(null);
    useEffect(() => {
      let alive = true;
      fetcher('performance_cro', {
        brandId
      }).then(d => {
        if (alive) setData(d);
      }).catch(e => {
        if (alive) setErr(String(e && e.message ? e.message : e));
      });
      return () => {
        alive = false;
      };
    }, [brandId, fetcher]);
    if (err) return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: ["Couldn't load Conversion — ", err]
      }, void 0, true)
    }, void 0, false);
    if (!data) return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: "Loading…"
      }, void 0, false)
    }, void 0, false);
    if (!data.funnel) return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: "No funnel data yet for this brand."
      }, void 0, false)
    }, void 0, false);
    const f = data.funnel;
    return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: [/*#__PURE__*/_jsxDEV("div", {
        className: "mos-head",
        children: /*#__PURE__*/_jsxDEV("h1", {
          className: "mos-title",
          children: "Conversion (CRO)"
        }, void 0, false)
      }, void 0, false), data.insight && /*#__PURE__*/_jsxDEV("div", {
        className: "ov-insight",
        children: [data.insight.text, /*#__PURE__*/_jsxDEV("span", {
          className: "tdy-muted",
          children: " (rule-based read, not LLM-generated)"
        }, void 0, false)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
        className: "ov-grid",
        children: data.metrics.map(m => /*#__PURE__*/_jsxDEV(OvMetricCard, {
          m: m
        }, m.key, false))
      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
        className: "pf-funnel",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "pf-funnel-step",
          children: [/*#__PURE__*/_jsxDEV("span", {
            className: "ov-stat-label",
            children: "Sessions"
          }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
            className: "ov-stat-value",
            children: ovNum(f.sessions)
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("span", {
          className: "pf-funnel-arrow",
          children: "→"
        }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
          className: "pf-funnel-step",
          children: [/*#__PURE__*/_jsxDEV("span", {
            className: "ov-stat-label",
            children: "Add to cart"
          }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
            className: "ov-stat-value",
            children: ovNum(f.add_to_carts)
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("span", {
          className: "pf-funnel-arrow",
          children: "→"
        }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
          className: "pf-funnel-step",
          children: [/*#__PURE__*/_jsxDEV("span", {
            className: "ov-stat-label",
            children: "Begin checkout"
          }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
            className: "ov-stat-value",
            children: ovNum(f.begin_checkouts)
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("span", {
          className: "pf-funnel-arrow",
          children: "→"
        }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
          className: "pf-funnel-step",
          children: [/*#__PURE__*/_jsxDEV("span", {
            className: "ov-stat-label",
            children: "Purchase"
          }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
            className: "ov-stat-value",
            children: ovNum(f.purchases)
          }, void 0, false)]
        }, void 0, true)]
      }, void 0, true), data.checkout_mix && /*#__PURE__*/_jsxDEV("div", {
        className: "mos-basis",
        style: {
          marginTop: 'var(--space-4, 16px)'
        },
        children: ["Checkout mix (", ovNum(data.checkout_mix.web_orders), " web orders): free-shipping-threshold ", ovPct(data.checkout_mix.free_ship_share), " · alt-pay (Apple/Google/Shop Pay etc.) ", ovPct(data.checkout_mix.alt_pay_share), "."]
      }, void 0, true)]
    }, void 0, true);
  }
  function PerformanceEmail(props) {
    const {
      brandId
    } = props;
    const fetcher = useMemo(() => props.fetcher || tdyDefaultFetcher(props.apiBase, props.getToken), [props.fetcher, props.apiBase, props.getToken]);
    const [data, setData] = useState(null);
    const [err, setErr] = useState(null);
    const [tab, setTab] = useState('campaigns');
    useEffect(() => {
      let alive = true;
      fetcher('performance_email', {
        brandId
      }).then(d => {
        if (alive) setData(d);
      }).catch(e => {
        if (alive) setErr(String(e && e.message ? e.message : e));
      });
      return () => {
        alive = false;
      };
    }, [brandId, fetcher]);
    if (err) return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: ["Couldn't load Email — ", err]
      }, void 0, true)
    }, void 0, false);
    if (!data) return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: "Loading…"
      }, void 0, false)
    }, void 0, false);
    const rows = tab === 'campaigns' ? data.top_campaigns || [] : data.top_flows || [];
    return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: [/*#__PURE__*/_jsxDEV("div", {
        className: "mos-head",
        children: /*#__PURE__*/_jsxDEV("h1", {
          className: "mos-title",
          children: "Email"
        }, void 0, false)
      }, void 0, false), data.insight && /*#__PURE__*/_jsxDEV("div", {
        className: "ov-insight",
        children: [data.insight.text, /*#__PURE__*/_jsxDEV("span", {
          className: "tdy-muted",
          children: " (rule-based read, not LLM-generated)"
        }, void 0, false)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
        className: "ov-grid",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Campaign revenue (30d)"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: ovMoney(data.campaigns_30d?.revenue)
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-deltas",
            children: /*#__PURE__*/_jsxDEV("span", {
              className: data.campaigns_30d?.delta_pct_vs_prior == null ? 'tdy-muted' : data.campaigns_30d.delta_pct_vs_prior >= 0 ? 'mos-pos' : 'mos-neg',
              children: [data.campaigns_30d?.delta_pct_vs_prior == null ? '—' : (data.campaigns_30d.delta_pct_vs_prior >= 0 ? '▲' : '▼') + ' ' + Math.abs(data.campaigns_30d.delta_pct_vs_prior) + '%', /*#__PURE__*/_jsxDEV("span", {
                className: "tdy-permo",
                children: " vs prior 30d"
              }, void 0, false)]
            }, void 0, true)
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Sends (30d)"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: ovNum(data.campaigns_30d?.sends)
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Flow revenue (30d, rolling)"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: ovMoney(data.flows?.revenue_30d)
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Live flows"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: [ovNum(data.flows?.live_count), " / ", ovNum(data.flows?.total_count)]
          }, void 0, true)]
        }, void 0, true)]
      }, void 0, true), data.flows?.basis_note && /*#__PURE__*/_jsxDEV("div", {
        className: "tdy-muted",
        style: {
          marginBottom: 'var(--space-3, 12px)'
        },
        children: data.flows.basis_note
      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
        className: "nav",
        style: {
          marginTop: 0
        },
        children: [/*#__PURE__*/_jsxDEV("button", {
          className: 'nav-item' + (tab === 'campaigns' ? ' nav-active' : ''),
          onClick: () => setTab('campaigns'),
          children: "Top campaigns"
        }, void 0, false), /*#__PURE__*/_jsxDEV("button", {
          className: 'nav-item' + (tab === 'flows' ? ' nav-active' : ''),
          onClick: () => setTab('flows'),
          children: "Top flows"
        }, void 0, false)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("table", {
        className: "mos-table pf-table",
        children: [/*#__PURE__*/_jsxDEV("thead", {
          children: /*#__PURE__*/_jsxDEV("tr", {
            children: [/*#__PURE__*/_jsxDEV("th", {
              style: {
                textAlign: 'left'
              },
              children: "Name"
            }, void 0, false), tab === 'campaigns' ? /*#__PURE__*/_jsxDEV(_Fragment, {
              children: [/*#__PURE__*/_jsxDEV("th", {
                children: "Sent"
              }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
                children: "Recipients"
              }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
                children: "Revenue"
              }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
                children: "Open rate"
              }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
                children: "Click rate"
              }, void 0, false)]
            }, void 0, true) : /*#__PURE__*/_jsxDEV(_Fragment, {
              children: [/*#__PURE__*/_jsxDEV("th", {
                children: "Status"
              }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
                children: "Trigger"
              }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
                children: "Revenue (30d)"
              }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
                children: "Open rate"
              }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
                children: "Click rate"
              }, void 0, false)]
            }, void 0, true)]
          }, void 0, true)
        }, void 0, false), /*#__PURE__*/_jsxDEV("tbody", {
          children: rows.slice(0, 20).map((r, i) => /*#__PURE__*/_jsxDEV("tr", {
            children: [/*#__PURE__*/_jsxDEV("td", {
              style: {
                textAlign: 'left'
              },
              children: r.name
            }, void 0, false), tab === 'campaigns' ? /*#__PURE__*/_jsxDEV(_Fragment, {
              children: [/*#__PURE__*/_jsxDEV("td", {
                children: r.send_time ? r.send_time.slice(0, 10) : '—'
              }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
                children: ovNum(r.recipients)
              }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
                children: ovMoney(r.attributed_revenue)
              }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
                children: r.open_rate != null ? ovPct(r.open_rate) : '—'
              }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
                children: r.click_rate != null ? ovPct(r.click_rate) : '—'
              }, void 0, false)]
            }, void 0, true) : /*#__PURE__*/_jsxDEV(_Fragment, {
              children: [/*#__PURE__*/_jsxDEV("td", {
                children: r.status || '—'
              }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
                children: r.trigger_type || '—'
              }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
                children: ovMoney(r.attributed_revenue_30d)
              }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
                children: r.open_rate_30d != null ? ovPct(r.open_rate_30d) : '—'
              }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
                children: r.click_rate_30d != null ? ovPct(r.click_rate_30d) : '—'
              }, void 0, false)]
            }, void 0, true)]
          }, i, true))
        }, void 0, false)]
      }, void 0, true), rows.length === 0 && /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: "Nothing in this view."
      }, void 0, false)]
    }, void 0, true);
  }
  function PerformanceOrganic(props) {
    const {
      brandId
    } = props;
    const fetcher = useMemo(() => props.fetcher || tdyDefaultFetcher(props.apiBase, props.getToken), [props.fetcher, props.apiBase, props.getToken]);
    const [data, setData] = useState(null);
    const [err, setErr] = useState(null);
    useEffect(() => {
      let alive = true;
      fetcher('performance_organic', {
        brandId
      }).then(d => {
        if (alive) setData(d);
      }).catch(e => {
        if (alive) setErr(String(e && e.message ? e.message : e));
      });
      return () => {
        alive = false;
      };
    }, [brandId, fetcher]);
    if (err) return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: ["Couldn't load Organic — ", err]
      }, void 0, true)
    }, void 0, false);
    if (!data) return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: "Loading…"
      }, void 0, false)
    }, void 0, false);
    const o = data.organic || {};
    const seqDelta = o.sessions_prior_30d ? Math.round((o.sessions_current_30d - o.sessions_prior_30d) / o.sessions_prior_30d * 1000) / 10 : null;
    return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: [/*#__PURE__*/_jsxDEV("div", {
        className: "mos-head",
        children: /*#__PURE__*/_jsxDEV("h1", {
          className: "mos-title",
          children: "Organic / SEO"
        }, void 0, false)
      }, void 0, false), data.insight && /*#__PURE__*/_jsxDEV("div", {
        className: "ov-insight",
        children: [data.insight.text, /*#__PURE__*/_jsxDEV("span", {
          className: "tdy-muted",
          children: " (rule-based read, not LLM-generated)"
        }, void 0, false)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
        className: "ov-grid",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Organic sessions (30d)"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: ovNum(o.sessions_current_30d)
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-deltas",
            children: /*#__PURE__*/_jsxDEV("span", {
              className: seqDelta == null ? 'tdy-muted' : seqDelta >= 0 ? 'mos-pos' : 'mos-neg',
              children: [seqDelta == null ? '—' : (seqDelta >= 0 ? '▲' : '▼') + ' ' + Math.abs(seqDelta) + '%', /*#__PURE__*/_jsxDEV("span", {
                className: "tdy-permo",
                children: " vs prior"
              }, void 0, false)]
            }, void 0, true)
          }, void 0, false)]
        }, void 0, true), data.search_console?.connected ? /*#__PURE__*/_jsxDEV(_Fragment, {
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat",
            children: [/*#__PURE__*/_jsxDEV("div", {
              className: "ov-stat-label",
              children: "GSC clicks (30d)"
            }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
              className: "ov-stat-value",
              children: ovNum(data.search_console.totals.clicks_30d)
            }, void 0, false)]
          }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat",
            children: [/*#__PURE__*/_jsxDEV("div", {
              className: "ov-stat-label",
              children: "GSC impressions (30d)"
            }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
              className: "ov-stat-value",
              children: ovNum(data.search_console.totals.impressions_30d)
            }, void 0, false)]
          }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat",
            children: [/*#__PURE__*/_jsxDEV("div", {
              className: "ov-stat-label",
              children: "Avg. position"
            }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
              className: "ov-stat-value",
              children: data.search_console.totals.avg_position
            }, void 0, false)]
          }, void 0, true)]
        }, void 0, true) : /*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Search Console"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value tdy-muted",
            style: {
              fontSize: '14px'
            },
            children: "Not connected"
          }, void 0, false)]
        }, void 0, true)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
        className: "mos-basis",
        children: o.basis
      }, void 0, false)]
    }, void 0, true);
  }
  function PerformanceCreative(props) {
    const {
      brandId
    } = props;
    const fetcher = useMemo(() => props.fetcher || tdyDefaultFetcher(props.apiBase, props.getToken), [props.fetcher, props.apiBase, props.getToken]);
    const [data, setData] = useState(null);
    const [err, setErr] = useState(null);
    useEffect(() => {
      let alive = true;
      fetcher('performance_creative', {
        brandId
      }).then(d => {
        if (alive) setData(d);
      }).catch(e => {
        if (alive) setErr(String(e && e.message ? e.message : e));
      });
      return () => {
        alive = false;
      };
    }, [brandId, fetcher]);
    if (err) return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: ["Couldn't load Creative — ", err]
      }, void 0, true)
    }, void 0, false);
    if (!data) return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: "Loading…"
      }, void 0, false)
    }, void 0, false);
    if (!data.demand) return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: data.insight?.text || 'No creative data connected.'
      }, void 0, false)
    }, void 0, false);
    const d = data.demand;
    return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: [/*#__PURE__*/_jsxDEV("div", {
        className: "mos-head",
        children: [/*#__PURE__*/_jsxDEV("h1", {
          className: "mos-title",
          children: "Creative"
        }, void 0, false), /*#__PURE__*/_jsxDEV("span", {
          className: "mos-asof",
          children: [ovNum(d.active_ads), " active ads"]
        }, void 0, true)]
      }, void 0, true), data.insight && /*#__PURE__*/_jsxDEV("div", {
        className: "ov-insight",
        children: [data.insight.text, /*#__PURE__*/_jsxDEV("span", {
          className: "tdy-muted",
          children: " (rule-based read, not LLM-generated)"
        }, void 0, false)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
        className: "ov-grid",
        children: [/*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Winners needed"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: ovNum(d.winners_needed)
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Surviving winners"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: ovNum(d.surviving_winners)
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Net winner gap"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: ovNum(d.net_winner_gap)
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Win rate"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: ovPct(d.win_rate)
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Ads needed / month"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: ovNum(d.ads_needed_month)
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Zero-rev rate"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: ovPct(d.zero_rev_rate)
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Ad concentration"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: ovPct(d.ad_concentration)
          }, void 0, false)]
        }, void 0, true), /*#__PURE__*/_jsxDEV("div", {
          className: "ov-stat",
          children: [/*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-label",
            children: "Evergreen share"
          }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
            className: "ov-stat-value",
            children: ovPct(d.evergreen_share)
          }, void 0, false)]
        }, void 0, true)]
      }, void 0, true), /*#__PURE__*/_jsxDEV("table", {
        className: "mos-table pf-table",
        children: [/*#__PURE__*/_jsxDEV("thead", {
          children: /*#__PURE__*/_jsxDEV("tr", {
            children: [/*#__PURE__*/_jsxDEV("th", {
              style: {
                textAlign: 'left'
              },
              children: "Ad"
            }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
              children: "Spend (90d)"
            }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
              children: "Revenue (90d)"
            }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
              children: "ROAS wk1"
            }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
              children: "ROAS after"
            }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
              children: "Active days"
            }, void 0, false)]
          }, void 0, true)
        }, void 0, false), /*#__PURE__*/_jsxDEV("tbody", {
          children: (data.ads || []).slice(0, 20).map(a => /*#__PURE__*/_jsxDEV("tr", {
            children: [/*#__PURE__*/_jsxDEV("td", {
              style: {
                textAlign: 'left'
              },
              children: a.ad_name || a.ad_id
            }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
              children: ovMoney(a.spend_90d)
            }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
              children: ovMoney(a.rev_90d)
            }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
              children: ovX(a.roas_w1)
            }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
              children: ovX(a.roas_after)
            }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
              children: ovNum(a.active_days)
            }, void 0, false)]
          }, a.ad_id, true))
        }, void 0, false)]
      }, void 0, true), (!data.ads || data.ads.length === 0) && /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: "No per-ad data."
      }, void 0, false)]
    }, void 0, true);
  }
  function PerformanceCompetitors(props) {
    const {
      brandId
    } = props;
    const fetcher = useMemo(() => props.fetcher || tdyDefaultFetcher(props.apiBase, props.getToken), [props.fetcher, props.apiBase, props.getToken]);
    const [data, setData] = useState(null);
    const [err, setErr] = useState(null);
    useEffect(() => {
      let alive = true;
      fetcher('performance_competitors', {
        brandId
      }).then(d => {
        if (alive) setData(d);
      }).catch(e => {
        if (alive) setErr(String(e && e.message ? e.message : e));
      });
      return () => {
        alive = false;
      };
    }, [brandId, fetcher]);
    if (err) return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: ["Couldn't load Competitors — ", err]
      }, void 0, true)
    }, void 0, false);
    if (!data) return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: "Loading…"
      }, void 0, false)
    }, void 0, false);
    const competitors = data.competitors || [];
    return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-root",
      children: [/*#__PURE__*/_jsxDEV("div", {
        className: "mos-head",
        children: /*#__PURE__*/_jsxDEV("h1", {
          className: "mos-title",
          children: "Competitors"
        }, void 0, false)
      }, void 0, false), data.insight && /*#__PURE__*/_jsxDEV("div", {
        className: "ov-insight",
        children: data.insight.text
      }, void 0, false), competitors.length === 0 ? /*#__PURE__*/_jsxDEV("div", {
        className: "mos-empty",
        children: "No competitor intel captured yet for this brand."
      }, void 0, false) : /*#__PURE__*/_jsxDEV("table", {
        className: "mos-table pf-table",
        children: [/*#__PURE__*/_jsxDEV("thead", {
          children: /*#__PURE__*/_jsxDEV("tr", {
            children: [/*#__PURE__*/_jsxDEV("th", {
              style: {
                textAlign: 'left'
              },
              children: "Name"
            }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
              style: {
                textAlign: 'left'
              },
              children: "Domain"
            }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
              children: "Confidence"
            }, void 0, false), /*#__PURE__*/_jsxDEV("th", {
              children: "Refreshed"
            }, void 0, false)]
          }, void 0, true)
        }, void 0, false), /*#__PURE__*/_jsxDEV("tbody", {
          children: competitors.map((c, i) => /*#__PURE__*/_jsxDEV("tr", {
            children: [/*#__PURE__*/_jsxDEV("td", {
              style: {
                textAlign: 'left'
              },
              children: c.name
            }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
              style: {
                textAlign: 'left'
              },
              children: c.domain
            }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
              children: c.confidence || '—'
            }, void 0, false), /*#__PURE__*/_jsxDEV("td", {
              children: c.refreshed_at ? c.refreshed_at.slice(0, 10) : '—'
            }, void 0, false)]
          }, i, true))
        }, void 0, false)]
      }, void 0, true)]
    }, void 0, true);
  }

  /* ---------- Performance shell — sub-nav across Products & Stock + the 5 build-order-4 drill-downs.
   * A single nav destination (Shell mounts <Performance/>, not each sub-page directly) so the top-level
   * Nav doesn't need six new items; sub-tab state is local, not persisted (cheap to reload). ---------- */
  function Performance(props) {
    const [sub, setSub] = useState('stock');
    const tabs = [['stock', 'Products & Stock'], ['cro', 'Conversion'], ['email', 'Email'], ['organic', 'Organic/SEO'], ['creative', 'Creative'], ['competitors', 'Competitors']];
    return /*#__PURE__*/_jsxDEV("div", {
      children: [/*#__PURE__*/_jsxDEV("div", {
        className: "nav",
        style: {
          marginBottom: 'var(--space-4, 16px)'
        },
        children: tabs.map(([id, label]) => /*#__PURE__*/_jsxDEV("button", {
          className: 'nav-item' + (sub === id ? ' nav-active' : ''),
          onClick: () => setSub(id),
          children: label
        }, id, false))
      }, void 0, false), sub === 'stock' && /*#__PURE__*/_jsxDEV(PerformanceStock, {
        ...props
      }, void 0, false), sub === 'cro' && /*#__PURE__*/_jsxDEV(PerformanceCro, {
        ...props
      }, void 0, false), sub === 'email' && /*#__PURE__*/_jsxDEV(PerformanceEmail, {
        ...props
      }, void 0, false), sub === 'organic' && /*#__PURE__*/_jsxDEV(PerformanceOrganic, {
        ...props
      }, void 0, false), sub === 'creative' && /*#__PURE__*/_jsxDEV(PerformanceCreative, {
        ...props
      }, void 0, false), sub === 'competitors' && /*#__PURE__*/_jsxDEV(PerformanceCompetitors, {
        ...props
      }, void 0, false)]
    }, void 0, true);
  }
  function Nav(props) {
    const item = (id, label, disabled) => /*#__PURE__*/_jsxDEV("button", {
      className: 'nav-item' + (props.view === id ? ' nav-active' : '') + (disabled ? ' nav-disabled' : ''),
      disabled: disabled,
      title: disabled ? 'Coming soon, per the 2026-07-13 IA spec' : undefined,
      onClick: () => !disabled && props.setView(id),
      children: label
    }, void 0, false);
    // 2026-07-13 IA spec §1: Overview · Calendar · Performance ▾ · Plan. Today merges into Overview
    // (spec §2.2/decision #1) — 'today' kept as an internal view id/alias so nothing else that
    // still references it (e.g. any deep link) breaks. Performance is now the full drill-down group
    // (build orders 3+4): Products & Stock, Conversion, Email, Organic/SEO, Creative, Competitors —
    // rendered as sub-tabs inside <Performance/>, not separate top-level nav items. Plan is unbuilt,
    // disabled.
    return /*#__PURE__*/_jsxDEV("div", {
      className: "nav",
      children: [item('today', 'Overview'), item('calendar', 'Calendar'), item('performance', 'Performance'), item('plan', 'Plan', true)]
    }, void 0, true);
  }

  /* ---------- passwordless (email OTP code) auth shell ---------- */
  const sb = window.sb;
  function Shell() {
    const [phase, setPhase] = useState('checking');
    const [brandId, setBrandId] = useState(null);
    const [view, setView] = useState('today');
    const [email, setEmail] = useState('');
    const [code, setCode] = useState('');
    const [sent, setSent] = useState(false);
    const [err, setErr] = useState('');
    const [busy, setBusy] = useState(false);
    const resolve = useCallback(async () => {
      const {
        data
      } = await sb.auth.getSession();
      if (!data.session) {
        setPhase('signin');
        return;
      }
      setEmail(data.session.user.email || '');
      const b = await window.OI_RESOLVE_BRAND();
      if (!b) {
        setErr('Signed in, but this account is not a member of any brand.');
        setPhase('signin');
        return;
      }
      window.OI_BRAND = b;
      setBrandId(b);
      setPhase('ready');
    }, []);
    useEffect(() => {
      resolve();
      const {
        data: sub
      } = sb.auth.onAuthStateChange((_e, s) => {
        if (s) resolve();
      });
      return () => sub.subscription.unsubscribe();
    }, [resolve]);
    const sendCode = async e => {
      e.preventDefault();
      setErr('');
      setBusy(true);
      const {
        error
      } = await sb.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: window.location.href
        }
      });
      setBusy(false);
      if (error) setErr(error.message);else setSent(true);
    };
    const verifyCode = async e => {
      e.preventDefault();
      setErr('');
      setBusy(true);
      const {
        error
      } = await sb.auth.verifyOtp({
        email,
        token: code.trim(),
        type: 'email'
      });
      setBusy(false);
      if (error) setErr(error.message);else {
        setCode('');
        resolve();
      }
    };
    const signOut = async () => {
      await sb.auth.signOut();
      setBrandId(null);
      setSent(false);
      setPhase('signin');
    };
    useEffect(() => {
      const el = document.getElementById('shellbar');
      if (phase === 'ready') {
        el.innerHTML = '<div class="tdy-shellbar"><span class="brand">Greta</span>' + '<span class="who">' + (email || '') + '<a id="tdy-signout">sign out</a></span></div>';
        const so = document.getElementById('tdy-signout');
        if (so) so.onclick = signOut;
      } else {
        el.innerHTML = '';
      }
    }, [phase, email]);
    if (phase === 'checking') return /*#__PURE__*/_jsxDEV("div", {
      className: "mos-empty",
      style: {
        margin: '80px auto',
        textAlign: 'center'
      },
      children: "Loading…"
    }, void 0, false);
    if (phase === 'ready') {
      return /*#__PURE__*/_jsxDEV("div", {
        children: [/*#__PURE__*/_jsxDEV(Nav, {
          view: view,
          setView: setView
        }, void 0, false), view === 'calendar' ? /*#__PURE__*/_jsxDEV(Calendar, {
          brandId: brandId
        }, void 0, false) : view === 'performance' ? /*#__PURE__*/_jsxDEV(Performance, {
          brandId: brandId
        }, void 0, false) : /*#__PURE__*/_jsxDEV(Overview, {
          brandId: brandId
        }, void 0, false)]
      }, void 0, true);
    }
    const emailStep = /*#__PURE__*/_jsxDEV("div", {
      children: [/*#__PURE__*/_jsxDEV("p", {
        children: "Enter your email and we will send a 6-digit sign-in code. No password needed."
      }, void 0, false), /*#__PURE__*/_jsxDEV("label", {
        children: "Email"
      }, void 0, false), /*#__PURE__*/_jsxDEV("input", {
        type: "email",
        autoComplete: "username",
        value: email,
        onChange: e => setEmail(e.target.value),
        required: true
      }, void 0, false), /*#__PURE__*/_jsxDEV("button", {
        type: "submit",
        disabled: busy,
        children: busy ? 'Sending...' : 'Send sign-in code'
      }, void 0, false)]
    }, void 0, true);
    const codeStep = /*#__PURE__*/_jsxDEV("div", {
      children: [/*#__PURE__*/_jsxDEV("p", {
        children: ["We emailed a 6-digit code to ", email, ". Enter it below."]
      }, void 0, true), /*#__PURE__*/_jsxDEV("label", {
        children: "Code"
      }, void 0, false), /*#__PURE__*/_jsxDEV("input", {
        inputMode: "numeric",
        autoComplete: "one-time-code",
        value: code,
        onChange: e => setCode(e.target.value),
        required: true
      }, void 0, false), /*#__PURE__*/_jsxDEV("button", {
        type: "submit",
        disabled: busy,
        children: busy ? 'Verifying...' : 'Verify and sign in'
      }, void 0, false), /*#__PURE__*/_jsxDEV("div", {
        style: {
          marginTop: '12px',
          fontSize: '12px'
        },
        children: /*#__PURE__*/_jsxDEV("a", {
          style: {
            color: 'var(--accent,#7c8cff)',
            cursor: 'pointer'
          },
          onClick: () => {
            setSent(false);
            setCode('');
            setErr('');
          },
          children: "use a different email"
        }, void 0, false)
      }, void 0, false)]
    }, void 0, true);
    return /*#__PURE__*/_jsxDEV("form", {
      className: "tdy-auth",
      onSubmit: sent ? verifyCode : sendCode,
      children: [/*#__PURE__*/_jsxDEV("h1", {
        children: "Today"
      }, void 0, false), sent ? codeStep : emailStep, /*#__PURE__*/_jsxDEV("div", {
        className: "err",
        children: err
      }, void 0, false)]
    }, void 0, true);
  }

  // EMBED-SAFE 2026-07-13: this file serves two contexts from one source.
  //   1. Standalone (today.html): no globals set beforehand → self-mounts <Shell/> (own
  //      passwordless auth, own Nav) into #root, exactly as before this change.
  //   2. Embedded (greta-dashboard.html, as a nav tab alongside Command Centre): the host page
  //      sets `window.MOS_EMBEDDED = true` in an inline <script> BEFORE this bundle loads, and
  //      already has its own #root mounted by greta-app.js for the main app shell. Self-mounting
  //      here would either crash (no #root belonging to this app) or double-mount over the host
  //      app. Skip the mount; expose `Today`/`Calendar` as plain components on window instead, so
  //      the host's own `mosView('Today')` / `mosView('Calendar')` (same pattern already used for
  //      window.CommandCentre / window.DecisionLog) can render them with its own auth/brandId.
  if (typeof window !== 'undefined') {
    window.Today = Today;
    window.Overview = Overview;
    window.Calendar = Calendar;
    window.PerformanceStock = PerformanceStock;
    window.Performance = Performance;
  }
  if (typeof window === 'undefined' || !window.MOS_EMBEDDED) {
    ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/_jsxDEV(Shell, {}, void 0, false));
  }
})();

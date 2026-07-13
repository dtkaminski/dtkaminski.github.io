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
  function TdyRow(props) {
    const a = props.a;
    return /*#__PURE__*/React.createElement("div", {
      className: "tdy-row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "tdy-rank"
    }, props.rank), /*#__PURE__*/React.createElement("div", {
      className: "tdy-row-body"
    }, /*#__PURE__*/React.createElement("div", {
      className: "tdy-row-title"
    }, a.description), /*#__PURE__*/React.createElement("div", {
      className: "tdy-row-meta"
    }, a.owner || '—', " · ", tdyOrigin(a), a.category ? ' · ' + a.category : '')), /*#__PURE__*/React.createElement("span", {
      className: 'tdy-badge ' + tdyPri(a.priority)
    }, a.priority), /*#__PURE__*/React.createElement("span", {
      className: "tdy-row-cm"
    }, tdyMoney(a.cm_gbp)), /*#__PURE__*/React.createElement("button", {
      className: "tdy-linkbtn",
      disabled: props.busy,
      onClick: () => props.onDone(a.external_id),
      title: "Mark done"
    }, "done"));
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
    return /*#__PURE__*/React.createElement("div", {
      className: "dc"
    }, /*#__PURE__*/React.createElement("div", {
      className: "dc-head",
      onClick: () => setOpen(o => !o)
    }, /*#__PURE__*/React.createElement("span", {
      className: "dc-title"
    }, "Data coverage"), /*#__PURE__*/React.createElement("span", {
      className: "dc-sum"
    }, ready, "/", rows.length, " ready", attn ? ' · ' + attn + ' to improve' : ''), /*#__PURE__*/React.createElement("span", {
      className: "dc-caret"
    }, open ? '▾' : '▸')), /*#__PURE__*/React.createElement("div", {
      className: "dc-chips"
    }, rows.map(r => /*#__PURE__*/React.createElement("span", {
      key: r.capability,
      className: 'dc-chip dc-' + r.status,
      title: r.detail
    }, /*#__PURE__*/React.createElement("i", {
      className: "dc-dot"
    }), DC_LABELS[r.capability] || r.capability, r.basis === 'benchmark' && /*#__PURE__*/React.createElement("em", {
      className: "dc-basis"
    }, "benchmark")))), open && /*#__PURE__*/React.createElement("div", {
      className: "dc-detail"
    }, rows.map(r => /*#__PURE__*/React.createElement("div", {
      key: r.capability,
      className: "dc-drow"
    }, /*#__PURE__*/React.createElement("span", {
      className: 'dc-dot dc-' + r.status
    }), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "dc-drow-h"
    }, /*#__PURE__*/React.createElement("b", null, DC_LABELS[r.capability] || r.capability), " — ", r.headline, r.basis ? ' · ' + r.basis : ''), /*#__PURE__*/React.createElement("div", {
      className: "dc-drow-d"
    }, r.detail))))));
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
    if (!f) return /*#__PURE__*/React.createElement("div", {
      className: "mos-empty"
    }, "Loading targets…");
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
    return /*#__PURE__*/React.createElement("form", {
      className: "tdy-targets",
      onSubmit: submit
    }, prov && /*#__PURE__*/React.createElement("div", {
      className: "tdy-targets-hint"
    }, "These are auto-estimated from your last 90 days. Adjust and confirm to make them your plan of record."), /*#__PURE__*/React.createElement("div", {
      className: "tdy-targets-grid"
    }, /*#__PURE__*/React.createElement("label", null, "Quarter start", /*#__PURE__*/React.createElement("input", {
      type: "date",
      value: f.periodStart,
      onChange: set('periodStart')
    })), /*#__PURE__*/React.createElement("label", null, "Quarter end", /*#__PURE__*/React.createElement("input", {
      type: "date",
      value: f.periodEnd,
      onChange: set('periodEnd')
    })), /*#__PURE__*/React.createElement("label", null, "Revenue target (£)", /*#__PURE__*/React.createElement("input", {
      type: "number",
      value: f.revenueTarget,
      onChange: set('revenueTarget')
    })), /*#__PURE__*/React.createElement("label", null, "Contribution-margin target (£)", /*#__PURE__*/React.createElement("input", {
      type: "number",
      value: f.contributionMarginTarget,
      onChange: set('contributionMarginTarget')
    })), /*#__PURE__*/React.createElement("label", null, "Spend cap (£)", /*#__PURE__*/React.createElement("input", {
      type: "number",
      value: f.spendCap,
      onChange: set('spendCap')
    })), /*#__PURE__*/React.createElement("label", null, "MER target (×)", /*#__PURE__*/React.createElement("input", {
      type: "number",
      step: "0.1",
      value: f.merTarget,
      onChange: set('merTarget')
    })), /*#__PURE__*/React.createElement("label", null, "New-customer target", /*#__PURE__*/React.createElement("input", {
      type: "number",
      value: f.newCustomerTarget,
      onChange: set('newCustomerTarget')
    })), /*#__PURE__*/React.createElement("label", null, "Returning-revenue target (£)", /*#__PURE__*/React.createElement("input", {
      type: "number",
      value: f.returningRevenueTarget,
      onChange: set('returningRevenueTarget')
    }))), /*#__PURE__*/React.createElement("fieldset", {
      className: "tdy-targets-basis"
    }, /*#__PURE__*/React.createElement("legend", null, "What does your CM target mean?"), /*#__PURE__*/React.createElement("label", null, /*#__PURE__*/React.createElement("input", {
      type: "radio",
      name: "cmBasis",
      checked: f.cmBasis === 'after_marketing',
      onChange: () => setF(Object.assign({}, f, {
        cmBasis: 'after_marketing'
      }))
    }), " After marketing — revenue × margin − ad spend (true profit)"), /*#__PURE__*/React.createElement("label", null, /*#__PURE__*/React.createElement("input", {
      type: "radio",
      name: "cmBasis",
      checked: f.cmBasis === 'product_contribution',
      onChange: () => setF(Object.assign({}, f, {
        cmBasis: 'product_contribution'
      }))
    }), " Product contribution — revenue × margin, before ad spend")), error && /*#__PURE__*/React.createElement("div", {
      className: "tdy-targets-err"
    }, "Couldn't save — ", error), /*#__PURE__*/React.createElement("div", {
      className: "tdy-targets-btns"
    }, /*#__PURE__*/React.createElement("button", {
      type: "submit",
      className: "tdy-btn tdy-btn-go",
      disabled: saving
    }, saving ? 'Saving…' : 'Confirm as plan'), onCancel && /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "tdy-btn",
      onClick: onCancel,
      disabled: saving
    }, "Cancel")));
  }
  function Today(props) {
    const brandId = props.brandId || typeof window !== 'undefined' && window.OI_BRAND;
    const fetcher = props.fetcher || tdyDefaultFetcher(props.apiBase, props.getToken);
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
    if (err) return /*#__PURE__*/React.createElement("div", {
      className: "tdy"
    }, /*#__PURE__*/React.createElement("div", {
      className: "mos-empty"
    }, "Couldn't load today — ", err));
    if (!data) return /*#__PURE__*/React.createElement("div", {
      className: "tdy"
    }, /*#__PURE__*/React.createElement("div", {
      className: "mos-empty"
    }, "Loading…"));
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
    return /*#__PURE__*/React.createElement("div", {
      className: "tdy"
    }, /*#__PURE__*/React.createElement("div", {
      className: "tdy-head"
    }, /*#__PURE__*/React.createElement("div", {
      className: "tdy-title"
    }, "Today"), h.period_end && /*#__PURE__*/React.createElement("div", {
      className: "tdy-period"
    }, "quarter to ", h.period_end)), rd.can_show_cm === false ? /*#__PURE__*/React.createElement("div", {
      className: "tdy-plan tdy-gate"
    }, /*#__PURE__*/React.createElement("div", {
      className: "tdy-plan-label"
    }, "Contribution margin · this month vs plan"), /*#__PURE__*/React.createElement("div", {
      className: "tdy-gate-msg"
    }, rd.gate_message || 'Connect economics (COGS + variable costs) to unlock CM & ranked actions.')) : /*#__PURE__*/React.createElement("div", {
      className: "tdy-plan"
    }, /*#__PURE__*/React.createElement("div", {
      className: "tdy-plan-label"
    }, "Contribution margin · this month vs plan", cmSrcLabel ? /*#__PURE__*/React.createElement("span", {
      className: "tdy-cmsrc"
    }, " · ", cmSrcLabel) : null), /*#__PURE__*/React.createElement("div", {
      className: "tdy-plan-row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "tdy-plan-num"
    }, tdyMoney(h.cm_actual_30d)), /*#__PURE__*/React.createElement("span", {
      className: "tdy-plan-of"
    }, "of ", tdyMoney(h.cm_target_monthly), " target"), pace != null && /*#__PURE__*/React.createElement("span", {
      className: 'tdy-pace ' + paceCls
    }, pace, "% of plan")), /*#__PURE__*/React.createElement("div", {
      className: "tdy-bar"
    }, /*#__PURE__*/React.createElement("i", {
      style: {
        width: barW + '%'
      },
      className: paceCls
    })), TDY_V2 && h.cm_after_marketing_30d != null && h.product_contribution_30d != null && /*#__PURE__*/React.createElement("div", {
      className: "tdy-plan-otherline tdy-muted"
    }, (h.cm_basis || 'after_marketing') === 'after_marketing' ? tdyMoney(h.product_contribution_30d) + ' before marketing (product contribution)' : tdyMoney(h.cm_after_marketing_30d) + ' after marketing (true profit)'), /*#__PURE__*/React.createElement("div", {
      className: "tdy-plan-sub"
    }, pace != null && pace < 100 ? 'Behind pace — the actions below close the gap, biggest contribution first.' : pace != null ? 'On or ahead of plan — keep the highest-contribution actions moving.' : planStatus === 'provisional' ? 'Pace hidden until you confirm targets — the current goal is auto-estimated.' : 'Set targets to see pace against your plan.')), /*#__PURE__*/React.createElement(DataCoverage, {
      brandId: brandId
    }), editTargets ? /*#__PURE__*/React.createElement(TdyTargetsForm, {
      brandId: brandId,
      fetcher: fetcher,
      onSaved: () => {
        setEditTargets(false);
        load();
      },
      onCancel: () => setEditTargets(false)
    }) : rd.can_show_cm !== false && /*#__PURE__*/React.createElement("div", {
      className: "tdy-planstatus"
    }, planStatus !== 'confirmed' ? /*#__PURE__*/React.createElement("span", {
      className: "tdy-prov-chip"
    }, planStatus === 'provisional' ? 'Targets auto-estimated — not confirmed as your plan' : 'No plan set yet') : /*#__PURE__*/React.createElement("span", {
      className: "tdy-conf-chip tdy-muted"
    }, "plan confirmed", h.cm_basis ? ' · ' + (h.cm_basis === 'product_contribution' ? 'product contribution' : 'after marketing') : ''), /*#__PURE__*/React.createElement("button", {
      className: "tdy-linkbtn",
      onClick: () => setEditTargets(true)
    }, planStatus === 'confirmed' ? 'Edit targets' : 'Set targets')), /*#__PURE__*/React.createElement("div", {
      className: "tdy-sec"
    }, "do this first"), top ? /*#__PURE__*/React.createElement("div", {
      className: "tdy-first"
    }, /*#__PURE__*/React.createElement("div", {
      className: "tdy-first-meta"
    }, /*#__PURE__*/React.createElement("span", {
      className: 'tdy-badge ' + tdyPri(top.priority)
    }, top.priority), /*#__PURE__*/React.createElement("span", {
      className: "tdy-first-owner"
    }, top.owner || '—', " · ", tdyOrigin(top), top.category ? ' · ' + top.category : ''), /*#__PURE__*/React.createElement("span", {
      className: "tdy-first-cm"
    }, tdyMoney(top.cm_gbp), /*#__PURE__*/React.createElement("span", {
      className: "tdy-permo"
    }, "/mo CM"))), /*#__PURE__*/React.createElement("div", {
      className: "tdy-first-title"
    }, top.description), TDY_V2 && data.stock && data.stock.gate && /\b(scale|open bids|raise|increase|budget|spend)\b/i.test(top.description || '') && (data.stock.gate.status === 'blocked' ? /*#__PURE__*/React.createElement("div", {
      className: "tdy-stockgate tdy-gate-blocked"
    }, "⛔ Stock gate (S3): ", data.stock.gate.detail, " — reorder first, then start this.") : data.stock.gate.status === 'warn' ? /*#__PURE__*/React.createElement("div", {
      className: "tdy-stockgate tdy-gate-warn"
    }, "⚠ Stock gate: ", data.stock.gate.detail) : data.stock.gate.status === 'unknown' ? /*#__PURE__*/React.createElement("div", {
      className: "tdy-stockgate tdy-gate-warn"
    }, "⏸ Stock gate unknown — ", data.stock.gate.detail) : /*#__PURE__*/React.createElement("div", {
      className: "tdy-stockgate tdy-gate-ok"
    }, "✓ stock cover supports this scale")), top.step1 && /*#__PURE__*/React.createElement("div", {
      className: "tdy-first-step"
    }, top.step1), /*#__PURE__*/React.createElement("div", {
      className: "tdy-first-btns"
    }, /*#__PURE__*/React.createElement("button", {
      className: "tdy-btn tdy-btn-go",
      disabled: busy === top.external_id,
      onClick: () => act('action_start', top.external_id)
    }, "Start"), /*#__PURE__*/React.createElement("button", {
      className: "tdy-btn",
      disabled: busy === top.external_id,
      onClick: () => act('action_done', top.external_id)
    }, "Mark done"))) : TDY_V2 && data.abstention ? /*#__PURE__*/React.createElement("div", {
      className: "mos-empty tdy-abstained"
    }, "⏸ No reliable read this cycle. ", data.abstention.reason || 'A data gate failed.', /*#__PURE__*/React.createElement("span", {
      className: "tdy-muted"
    }, " Greta abstains rather than guess — fix the gate above and the read returns.")) : /*#__PURE__*/React.createElement("div", {
      className: "mos-empty"
    }, TDY_V2 ? '✓ Nothing open — CM read is clean and no material deviation was found.' : "Nothing open — you're clear."), TDY_V2 && data.pricing_provenance && data.pricing_provenance.needs_refresh && acts.length > 0 && /*#__PURE__*/React.createElement("div", {
      className: "tdy-muted tdy-pricing-note"
    }, "£ impacts are priced from seeded cost inputs marked for refresh", data.pricing_provenance.stamped_at ? ' (as of ' + data.pricing_provenance.stamped_at + ')' : '', " — directionally right, unverified."), rest.length > 0 && /*#__PURE__*/React.createElement("div", {
      className: "tdy-sec"
    }, "then, in order"), /*#__PURE__*/React.createElement("div", {
      className: "tdy-rows"
    }, rest.map((a, i) => /*#__PURE__*/React.createElement(TdyRow, {
      key: a.external_id,
      a: a,
      rank: i + 2,
      busy: busy === a.external_id,
      onStart: e => act('action_start', e),
      onDone: e => act('action_done', e)
    }))), (channels.length > 0 || saturation.some(s => s.spend_cac_corr != null && s.spend_cac_corr > 0.4)) && /*#__PURE__*/React.createElement("div", {
      className: "tdy-chan"
    }, /*#__PURE__*/React.createElement("div", {
      className: "tdy-sec"
    }, "channel efficiency"), saturation.filter(s => s.spend_cac_corr != null && s.spend_cac_corr > 0.4).map(s => /*#__PURE__*/React.createElement("div", {
      key: s.platform,
      className: "tdy-sat"
    }, "⚠ ", s.platform, " saturating — CAC £", s.best_cac, "→£", s.worst_cac, " as spend scales. Test incrementality here next.", /*#__PURE__*/React.createElement("span", {
      className: "tdy-muted"
    }, " (observational, not causal)"))), channels.map(c => /*#__PURE__*/React.createElement("div", {
      key: c.channel_type,
      className: "tdy-chan-row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "tdy-chan-name"
    }, c.channel_type), /*#__PURE__*/React.createElement("span", {
      className: "tdy-chan-iroas"
    }, c.normalized_iroas != null ? c.normalized_iroas + '×' : '—', /*#__PURE__*/React.createElement("span", {
      className: "tdy-permo"
    }, " iROAS")), TDY_V2 && c.evidence_tier ? /*#__PURE__*/React.createElement("span", {
      className: 'tdy-chan-tier ' + (c.evidence_tier === 'T4' ? 'tdy-tier-warn' : 'tdy-tier-ok'),
      title: c.phi_lo != null ? 'φ band ' + c.phi_lo + '–' + c.phi_hi + (c.evidence_tier === 'T4' ? ' — industry prior, unconfirmed for you. Run a holdout to measure.' : '') : ''
    }, c.evidence_tier, c.evidence_tier === 'T4' ? ' prior' : ' measured') : /*#__PURE__*/React.createElement("span", {
      className: "tdy-chan-phi tdy-muted"
    }, tdyPhi(c.phi_source)), TDY_V2 && c.reported_target_roas != null && /*#__PURE__*/React.createElement("span", {
      className: "tdy-chan-target tdy-muted",
      title: "Reported ROAS this channel must beat, derived from CM% + LTV + φ (never a gut number)."
    }, "target ", c.reported_target_roas, "× rep.")))), TDY_V2 && data.stock && (data.stock.stockouts.length > 0 || data.stock.reorder_now.length > 0 || data.stock.trapped_cash_total != null) && /*#__PURE__*/React.createElement("div", {
      className: "tdy-stock"
    }, /*#__PURE__*/React.createElement("div", {
      className: "tdy-sec"
    }, "stock"), data.stock.stockouts.map(s => /*#__PURE__*/React.createElement("div", {
      key: s.sku,
      className: "tdy-stock-row tdy-stock-out"
    }, /*#__PURE__*/React.createElement("span", {
      className: "tdy-stock-sku"
    }, s.sku), /*#__PURE__*/React.createElement("span", null, "out of stock", s.lost_cm_per_day != null ? ' — losing ' + tdyMoney(s.lost_cm_per_day) + '/day CM' : ''), /*#__PURE__*/React.createElement("span", {
      className: "tdy-muted"
    }, "S1 · fix availability before the funnel"))), data.stock.reorder_now.filter(r => !data.stock.stockouts.some(s => s.sku === r.sku)).slice(0, 3).map(r => /*#__PURE__*/React.createElement("div", {
      key: r.sku,
      className: "tdy-stock-row"
    }, /*#__PURE__*/React.createElement("span", {
      className: "tdy-stock-sku"
    }, r.sku), /*#__PURE__*/React.createElement("span", null, "reorder by ", /*#__PURE__*/React.createElement("b", null, r.reorder_by_date), r.suggested_order_units ? ' · ~' + r.suggested_order_units + ' units' : '', r.demand_uplift_next_6wk > 1 ? ' · demand +' + Math.round((r.demand_uplift_next_6wk - 1) * 100) + '% from planned events' : ''), r.cm_at_risk_before_resupply != null && /*#__PURE__*/React.createElement("span", {
      className: "tdy-stock-risk"
    }, tdyMoney(r.cm_at_risk_before_resupply), " CM at risk"))), data.stock.trapped_cash_total != null && /*#__PURE__*/React.createElement("div", {
      className: "tdy-stock-row tdy-muted"
    }, tdyMoney(data.stock.trapped_cash_total), " cash trapped in overstock — clear at the shallowest depth (bundle/threshold), never a blanket markdown (S2)")), TDY_V2 && data.calibration && data.calibration.flags > 0 && /*#__PURE__*/React.createElement("div", {
      className: "tdy-proven tdy-muted"
    }, "Proven — ", data.calibration.flags, " flags · ", data.calibration.hits, " hit · ", data.calibration.misses, " miss · ", data.calibration.abstentions, " abstained", data.calibration.precision != null ? ' · precision ' + data.calibration.precision : ''), /*#__PURE__*/React.createElement("div", {
      className: "tdy-foot"
    }, h.open_actions != null ? h.open_actions + ' open actions · ' : '', "ranked by contribution margin · updates nightly"));
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
  const CHANNELS = ['', 'website', 'email', 'sms', 'meta', 'google', 'instagram', 'tiktok', 'creator', 'pr', 'internal'];
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
    const text = (label, key) => /*#__PURE__*/React.createElement("label", {
      className: "dw-f"
    }, /*#__PURE__*/React.createElement("span", null, label), /*#__PURE__*/React.createElement("input", {
      value: f[key],
      onChange: ev => set(key, ev.target.value)
    }));
    const numf = (label, key) => /*#__PURE__*/React.createElement("label", {
      className: "dw-f dw-numf"
    }, /*#__PURE__*/React.createElement("span", null, label), /*#__PURE__*/React.createElement("input", {
      inputMode: "decimal",
      value: f[key],
      onChange: ev => set(key, ev.target.value)
    }));
    const datef = (label, key) => /*#__PURE__*/React.createElement("label", {
      className: "dw-f"
    }, /*#__PURE__*/React.createElement("span", null, label), /*#__PURE__*/React.createElement("input", {
      type: "date",
      value: f[key],
      onChange: ev => set(key, ev.target.value)
    }));
    const area = (label, key) => /*#__PURE__*/React.createElement("label", {
      className: "dw-f"
    }, /*#__PURE__*/React.createElement("span", null, label), /*#__PURE__*/React.createElement("textarea", {
      rows: "2",
      value: f[key],
      onChange: ev => set(key, ev.target.value)
    }));
    const self = (label, key, opts) => /*#__PURE__*/React.createElement("label", {
      className: "dw-f"
    }, /*#__PURE__*/React.createElement("span", null, label), /*#__PURE__*/React.createElement("select", {
      value: f[key],
      onChange: ev => set(key, ev.target.value)
    }, opts.map(o => /*#__PURE__*/React.createElement("option", {
      key: o,
      value: o
    }, o || '—'))));
    const variance = (exp, act) => {
      const a = numOrNull(act),
        x = numOrNull(exp);
      if (a == null || x == null || x === 0) return null;
      return Math.round((a - x) / Math.abs(x) * 100);
    };
    const revVar = variance(f.expected_revenue, f.actual_revenue);
    const cmVar = variance(f.expected_cm, f.actual_cm);
    const ps = props.platformStats && props.platformStats[f.channel];
    const cmR = props.cmRatio || 0.6;
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
        title: f.title.trim(),
        row_group: f.row_group,
        channel: f.channel || null,
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
      let error;
      if (e.id) {
        const r = await sb.from('mos_calendar_event').update(row).eq('id', e.id);
        error = r.error;
      } else {
        row.brand_id = props.brandId;
        row.source = 'manual';
        const r = await sb.from('mos_calendar_event').insert(row);
        error = r.error;
      }
      setSaving(false);
      if (error) {
        setErr(error.message);
        return;
      }
      props.onSaved();
    };
    return /*#__PURE__*/React.createElement("div", {
      className: "dw-wrap"
    }, /*#__PURE__*/React.createElement("div", {
      className: "dw-backdrop",
      onClick: props.onClose
    }), /*#__PURE__*/React.createElement("div", {
      className: "dw"
    }, /*#__PURE__*/React.createElement("div", {
      className: "dw-head"
    }, /*#__PURE__*/React.createElement("div", {
      className: "dw-title"
    }, e.id ? 'Edit event' : 'New event'), /*#__PURE__*/React.createElement("button", {
      className: "dw-x",
      onClick: props.onClose
    }, "×")), /*#__PURE__*/React.createElement("div", {
      className: "dw-body"
    }, /*#__PURE__*/React.createElement("div", {
      className: "dw-sec"
    }, "What & when"), text('Title', 'title'), /*#__PURE__*/React.createElement("div", {
      className: "dw-2"
    }, self('Row', 'row_group', CG_GROUPS.map(g => g[0])), self('Channel', 'channel', CHANNELS)), /*#__PURE__*/React.createElement("div", {
      className: "dw-2"
    }, datef('Start', 'start_date'), datef('End', 'end_date')), /*#__PURE__*/React.createElement("div", {
      className: "dw-2"
    }, self('Status', 'status', ['proposed', 'planned', 'live', 'complete', 'skipped']), self('Approval', 'approval_status', ['draft', 'in_review', 'approved', 'blocked'])), /*#__PURE__*/React.createElement("div", {
      className: "dw-sec"
    }, "Product & creative"), /*#__PURE__*/React.createElement("div", {
      className: "dw-2"
    }, text('SKU', 'sku'), text('Creator', 'creator')), /*#__PURE__*/React.createElement("div", {
      className: "dw-2"
    }, text('Content pillar', 'content_pillar'), text('Format', 'format')), text('Message angle', 'message_angle'), text('CTA', 'cta'), text('Offer', 'offer'), /*#__PURE__*/React.createElement("div", {
      className: "dw-sec"
    }, "Assets & approval"), text('Asset link', 'asset_link'), text('Usage rights', 'usage_rights'), /*#__PURE__*/React.createElement("div", {
      className: "dw-sec"
    }, "Expected (plan)"), /*#__PURE__*/React.createElement("div", {
      className: "dw-3"
    }, numf('Revenue £', 'expected_revenue'), numf('Spend £', 'expected_spend'), numf('CM £', 'expected_cm')), ps && iroas != null ? /*#__PURE__*/React.createElement("div", {
      className: "dw-fc"
    }, /*#__PURE__*/React.createElement("b", null, f.channel), " history: iROAS ", iroas.toFixed(2), "× · £", Math.round(ps.spend_30d || 0).toLocaleString(), " spend/30d.", ' ', fcRev != null ? /*#__PURE__*/React.createElement("span", null, "At £", es.toLocaleString(), " spend → ", /*#__PURE__*/React.createElement("b", null, "£", fcRev.toLocaleString()), " incremental rev, ", /*#__PURE__*/React.createElement("b", null, "£", fcCam.toLocaleString()), " CAM ", /*#__PURE__*/React.createElement("a", {
      className: "dw-fc-use",
      onClick: applyFc
    }, "use these")) : /*#__PURE__*/React.createElement("span", null, "enter expected spend to forecast from channel history")) : null, text('Target KPI', 'target_kpi'), area('Measurement plan', 'measurement_plan'), /*#__PURE__*/React.createElement("div", {
      className: "dw-sec"
    }, "Actual (result)"), /*#__PURE__*/React.createElement("div", {
      className: "dw-3"
    }, numf('Revenue £', 'actual_revenue'), numf('Spend £', 'actual_spend'), numf('CM £', 'actual_cm')), revVar != null || cmVar != null ? /*#__PURE__*/React.createElement("div", {
      className: "dw-var"
    }, "vs expected: ", revVar != null ? 'revenue ' + (revVar >= 0 ? '+' : '') + revVar + '%' : '', revVar != null && cmVar != null ? ' · ' : '', cmVar != null ? 'CM ' + (cmVar >= 0 ? '+' : '') + cmVar + '%' : '') : null, area('Learnings', 'learnings')), /*#__PURE__*/React.createElement("div", {
      className: "dw-foot"
    }, err ? /*#__PURE__*/React.createElement("div", {
      className: "dw-err"
    }, err) : null, /*#__PURE__*/React.createElement("button", {
      className: "dw-cancel",
      onClick: props.onClose,
      disabled: saving
    }, "Cancel"), /*#__PURE__*/React.createElement("button", {
      className: "dw-save",
      onClick: save,
      disabled: saving
    }, saving ? 'Saving…' : e.id ? 'Save changes' : 'Create event'))));
  }
  const DAYW = 34;
  function Calendar(props) {
    const brandId = props.brandId || window.OI_BRAND;
    const [events, setEvents] = useState(null);
    const [liftMap, setLiftMap] = useState({});
    const CAL_V2 = typeof window === 'undefined' || window.GRETA_UI_V2 !== false;
    const [actMap, setActMap] = useState({});
    const [platformStats, setPlatformStats] = useState({});
    const [cmRatio, setCmRatio] = useState(0.6);
    const [err, setErr] = useState(null);
    const [editing, setEditing] = useState(null);
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
      Promise.all([sb.from('mos_calendar_event').select('id,campaign_id,row_group,channel,title,description,start_date,end_date,creator,sku,content_pillar,format,message_angle,cta,asset_link,usage_rights,approval_status,status,expected_revenue,expected_spend,expected_cm,target_kpi,measurement_plan,actual_revenue,actual_spend,actual_cm,revenue_basis,learnings,metadata').eq('brand_id', brandId), sb.from('vw_brand_calendar').select('campaign_id,lift_vs_baseline').eq('brand_id', brandId), sb.from('vw_platform_channel').select('platform,spend_30d,reported_roas,normalized_iroas').eq('brand_id', brandId), sb.from('vw_brand_cm_ladder').select('cm_ratio').eq('brand_id', brandId), sb.from('vw_event_actualisation').select('event_id,cm_impact,net_revenue_impact,event_delta,provisional,collided,baseline_source').eq('brand_id', brandId)]).then(res => {
        if (!alive) return;
        const ev = res[0],
          lf = res[1],
          pc = res[2],
          cm = res[3],
          ac = res[4];
        if (ev.error) {
          setErr(ev.error.message);
          return;
        }
        const m = {};
        (lf.data || []).forEach(r => {
          if (r.campaign_id != null) m[r.campaign_id] = r.lift_vs_baseline;
        });
        const ps = {};
        (pc.data || []).forEach(r => {
          ps[r.platform] = r;
        });
        const am = {};
        (ac && ac.data || []).forEach(r => {
          if (r.event_id != null) am[r.event_id] = r;
        });
        setActMap(am);
        setLiftMap(m);
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
    if (err) return /*#__PURE__*/React.createElement("div", {
      className: "tg-view"
    }, /*#__PURE__*/React.createElement("div", {
      className: "mos-empty"
    }, "Couldn't load calendar — ", err));
    if (!events) return /*#__PURE__*/React.createElement("div", {
      className: "tg-view"
    }, /*#__PURE__*/React.createElement("div", {
      className: "mos-empty"
    }, "Loading…"));
    const today = ymd0(new Date());
    const liftOf = e => {
      const v = e.campaign_id != null ? liftMap[e.campaign_id] : null;
      return v == null ? null : Number(v);
    };
    const evClass = e => {
      const act = CAL_V2 ? actMap[e.id] : null;
      if (act) {
        if (act.collided) return 'cg-collided';
        if (act.cm_impact != null && !act.provisional) return calClass(Number(act.cm_impact));
        if (act.provisional) return 'cg-pending';
      }
      const v = liftOf(e);
      if (v != null) return calClass(v);
      if (e.approval_status === 'blocked') return 'cg-blocked';
      if (e.approval_status === 'approved') return 'cg-approved';
      return 'cg-pending';
    };
    const evTitle = e => {
      const act = CAL_V2 ? actMap[e.id] : null;
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
    const todayLine = todayIdx >= 0 ? /*#__PURE__*/React.createElement("div", {
      className: "tg-todayline",
      style: {
        left: todayIdx * DAYW + DAYW / 2 - 1
      }
    }) : null;
    return /*#__PURE__*/React.createElement("div", {
      className: 'tg-view' + (drag ? ' tg-dragging' : '')
    }, /*#__PURE__*/React.createElement("div", {
      className: "mc-top"
    }, /*#__PURE__*/React.createElement("div", {
      className: "mc-nav"
    }, /*#__PURE__*/React.createElement("button", {
      className: "mc-arrow",
      onClick: () => go(-1),
      title: "Previous month"
    }, "‹"), /*#__PURE__*/React.createElement("div", {
      className: "mc-month"
    }, monthLabel), /*#__PURE__*/React.createElement("button", {
      className: "mc-arrow",
      onClick: () => go(1),
      title: "Next month"
    }, "›"), /*#__PURE__*/React.createElement("button", {
      className: "mc-today-btn",
      onClick: goToday
    }, "Today")), /*#__PURE__*/React.createElement("button", {
      className: "cg-add",
      onClick: () => setEditing({
        start_date: ymd(new Date(year, month, Math.min(new Date().getDate(), daysInMonth)))
      })
    }, "+ Add event")), /*#__PURE__*/React.createElement("div", {
      className: "tg-scroll"
    }, /*#__PURE__*/React.createElement("div", {
      className: "tg",
      style: {
        width: 140 + trackW
      }
    }, /*#__PURE__*/React.createElement("div", {
      className: "tg-headrow"
    }, /*#__PURE__*/React.createElement("div", {
      className: "tg-corner"
    }, monthLabel), /*#__PURE__*/React.createElement("div", {
      className: "tg-days"
    }, dayList.map((d, i) => {
      const wknd = d.getDay() === 0 || d.getDay() === 6;
      return /*#__PURE__*/React.createElement("div", {
        key: i,
        className: 'tg-day' + (wknd ? ' wknd' : '') + (i === todayIdx ? ' tdy' : ''),
        style: {
          width: DAYW
        },
        onClick: () => setEditing({
          start_date: ymd(d)
        }),
        title: 'Add event on ' + ymd(d)
      }, /*#__PURE__*/React.createElement("div", {
        className: "wd"
      }, WD1[d.getDay()]), /*#__PURE__*/React.createElement("div", {
        className: "dn"
      }, i + 1));
    }))), CG_GROUPS.map(gp => {
      const g = gp[0],
        label = gp[1];
      const rows = byGroup[g] || [];
      const isCol = collapsed[g];
      const ghost = drag && drag.mode === 'create' && drag.group === g;
      const ga = ghost ? Math.min(drag.anchor, drag.cur) : 0;
      const gb = ghost ? Math.max(drag.anchor, drag.cur) : 0;
      return /*#__PURE__*/React.createElement("div", {
        key: g,
        className: "tg-group"
      }, /*#__PURE__*/React.createElement("div", {
        className: "tg-grouprow"
      }, /*#__PURE__*/React.createElement("div", {
        className: "tg-glabel",
        onClick: () => setCollapsed({
          ...collapsed,
          [g]: !isCol
        })
      }, /*#__PURE__*/React.createElement("span", {
        className: "cg-caret"
      }, isCol ? '▸' : '▾'), label, /*#__PURE__*/React.createElement("span", {
        className: "cg-count"
      }, rows.length)), /*#__PURE__*/React.createElement("div", {
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
        title: "Click or drag to add an event in this row"
      }, todayLine, ghost ? /*#__PURE__*/React.createElement("div", {
        className: "tg-ghost",
        style: {
          left: ga * DAYW + 1,
          width: (gb - ga + 1) * DAYW - 2
        }
      }) : null)), !isCol && rows.length === 0 ? /*#__PURE__*/React.createElement("div", {
        className: "tg-lane"
      }, /*#__PURE__*/React.createElement("div", {
        className: "tg-llabel tg-llabel-empty"
      }, "— nothing this month"), /*#__PURE__*/React.createElement("div", {
        className: "tg-ltrack",
        style: {
          width: trackW,
          ...gridlines
        }
      }, todayLine)) : null, !isCol && rows.map(e => {
        const s = seg(e);
        const isDragged = drag && drag.mode === 'move' && drag.event.id === e.id;
        const off = isDragged ? drag.delta * DAYW : 0;
        return /*#__PURE__*/React.createElement("div", {
          key: e.id,
          className: "tg-lane"
        }, /*#__PURE__*/React.createElement("div", {
          className: "tg-llabel",
          title: e.title
        }, calShort(e.title)), /*#__PURE__*/React.createElement("div", {
          className: "tg-ltrack",
          style: {
            width: trackW,
            ...gridlines
          }
        }, todayLine, /*#__PURE__*/React.createElement("div", {
          className: 'tg-bar ' + evClass(e) + (s.contL ? ' contL' : '') + (s.contR ? ' contR' : '') + (isDragged ? ' tg-bar-drag' : ''),
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
          title: CAL_V2 && actMap[e.id] ? evTitle(e) : e.title + ' — drag to move, click to edit'
        }, /*#__PURE__*/React.createElement("span", {
          className: "tg-bar-t"
        }, calShort(e.title)))));
      }));
    }))), /*#__PURE__*/React.createElement("div", {
      className: "cg-foot"
    }, CAL_V2 ? 'Click a day cell to add, drag for multi-day, click a bar to edit. Colour = CM impact net of pull-forward (past; hollow = provisional, ⚠ = collided) or approval (planned).' : 'Click a day cell to add, drag across cells for a multi-day event, drag a bar to reschedule, click a bar to edit. Colour = measured lift (past) or approval (planned).'), editing ? /*#__PURE__*/React.createElement(EventDrawer, {
      key: editing.id || 'new',
      brandId: brandId,
      event: editing,
      platformStats: platformStats,
      cmRatio: cmRatio,
      onClose: () => setEditing(null),
      onSaved: () => {
        setEditing(null);
        reload();
      }
    }) : null);
  }
  function Nav(props) {
    const item = (id, label) => /*#__PURE__*/React.createElement("button", {
      className: 'nav-item' + (props.view === id ? ' nav-active' : ''),
      onClick: () => props.setView(id)
    }, label);
    return /*#__PURE__*/React.createElement("div", {
      className: "nav"
    }, item('today', 'Today'), item('calendar', 'Calendar'));
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
    if (phase === 'checking') return /*#__PURE__*/React.createElement("div", {
      className: "mos-empty",
      style: {
        margin: '80px auto',
        textAlign: 'center'
      }
    }, "Loading…");
    if (phase === 'ready') {
      return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement(Nav, {
        view: view,
        setView: setView
      }), view === 'calendar' ? /*#__PURE__*/React.createElement(Calendar, {
        brandId: brandId
      }) : /*#__PURE__*/React.createElement(Today, {
        brandId: brandId
      }));
    }
    const emailStep = /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", null, "Enter your email and we will send a 6-digit sign-in code. No password needed."), /*#__PURE__*/React.createElement("label", null, "Email"), /*#__PURE__*/React.createElement("input", {
      type: "email",
      autoComplete: "username",
      value: email,
      onChange: e => setEmail(e.target.value),
      required: true
    }), /*#__PURE__*/React.createElement("button", {
      type: "submit",
      disabled: busy
    }, busy ? 'Sending...' : 'Send sign-in code'));
    const codeStep = /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("p", null, "We emailed a 6-digit code to ", email, ". Enter it below."), /*#__PURE__*/React.createElement("label", null, "Code"), /*#__PURE__*/React.createElement("input", {
      inputMode: "numeric",
      autoComplete: "one-time-code",
      value: code,
      onChange: e => setCode(e.target.value),
      required: true
    }), /*#__PURE__*/React.createElement("button", {
      type: "submit",
      disabled: busy
    }, busy ? 'Verifying...' : 'Verify and sign in'), /*#__PURE__*/React.createElement("div", {
      style: {
        marginTop: '12px',
        fontSize: '12px'
      }
    }, /*#__PURE__*/React.createElement("a", {
      style: {
        color: 'var(--accent,#7c8cff)',
        cursor: 'pointer'
      },
      onClick: () => {
        setSent(false);
        setCode('');
        setErr('');
      }
    }, "use a different email")));
    return /*#__PURE__*/React.createElement("form", {
      className: "tdy-auth",
      onSubmit: sent ? verifyCode : sendCode
    }, /*#__PURE__*/React.createElement("h1", null, "Today"), sent ? codeStep : emailStep, /*#__PURE__*/React.createElement("div", {
      className: "err"
    }, err));
  }
  if (typeof window !== 'undefined') {
    window.Today = Today;
    window.Calendar = Calendar;
  }
  if (typeof window === 'undefined' || !window.MOS_EMBEDDED) {
    ReactDOM.createRoot(document.getElementById('root')).render(/*#__PURE__*/React.createElement(Shell, null));
  }
})();

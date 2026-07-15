// ── Plan panel (readiness gate + target setter) ──────────────────────────────
// Added 2026-07-14. Wires steps 1-2 of the targets workstream: shows the plan-readiness
// gate (vw_brand_plan_readiness), lets the user set a quarter goal in EITHER contribution
// (CAM) or revenue and see the full derived target set (both units), then confirm it as the
// plan of record (mos_business_goal.confirmed=true). Global-scope, GP_* namespaced. Data +
// writes live in window.FRKL_PLAN (greta-plan-data.js). Confirm is user-initiated only.
var GP_T = { bg:'transparent', panel:'var(--color-panel)', panel2:'var(--color-surface)', line:'var(--color-line)', ink:'var(--color-ink)',
  mut:'var(--color-muted)', dim:'#9a948c', accent:'var(--color-accent)', accent2:'var(--color-accent)', green:'var(--color-success)', amber:'var(--color-warning)', red:'var(--color-danger)',
  mono:'var(--font-mono)' };
var GP_gbp = function (x) { return x == null ? '—' : '£' + Math.round(Number(x)).toLocaleString('en-GB'); };
var GP_rag = function (s) { return s === 'ready' ? GP_T.green : s === 'unconfirmed' || s === 'stale' ? GP_T.amber : GP_T.red; };

function GP_Dot(p) { return React.createElement('span', { style: { width: 8, height: 8, borderRadius: '50%', display: 'inline-block', background: p.c } }); }

function GP_Metric(p) {
  return (
    <div style={{ background: GP_T.panel, border: '1px solid ' + GP_T.line, borderRadius: 10, padding: '10px 12px' }}>
      <div style={{ fontSize: 11, color: GP_T.mut }}>{p.k}</div>
      <div style={{ fontFamily: GP_T.mono, fontSize: 19, fontWeight: 600, marginTop: 3, color: p.hi ? GP_T.accent2 : GP_T.ink }}>{p.v}</div>
      {p.sub && <div style={{ fontSize: 10.5, color: GP_T.dim, marginTop: 2 }}>{p.sub}</div>}
    </div>
  );
}

function GretaPlanPanel() {
  var P = (typeof window !== 'undefined' && window.FRKL_PLAN) || { readiness: [], goal: null, period: { start: '', end: '' } };
  var s = React.useState(0), tick = s[0], setTick = s[1];
  var b = React.useState('cam'), basis = b[0], setBasis = b[1];
  var a = React.useState(''), amount = a[0], setAmount = a[1];
  var d = React.useState(null), derived = d[0], setDerived = d[1];
  var z = React.useState(false), busy = z[0], setBusy = z[1];
  var m = React.useState(null), msg = m[0], setMsg = m[1];
  var ec = React.useState(null), econ = ec[0], setEcon = ec[1];
  var em = React.useState(null), ecMsg = em[0], setEcMsg = em[1];

  React.useEffect(function () {
    var h = function () { setTick(function (x) { return x + 1; }); };
    window.addEventListener('frkl-plan-updated', h);
    if (window.FRKL_PLAN && !derived) window.FRKL_PLAN.derive(null, 'auto').then(function (r) { if (r) setDerived(r); });
    return function () { window.removeEventListener('frkl-plan-updated', h); };
  }, []);

  React.useEffect(function () {
    var c = window.FRKL_PLAN && window.FRKL_PLAN.config;
    if (c && econ === null) {
      var v = c.variable_costs || {};
      setEcon({
        gm: c.gross_margin != null ? String(Math.round(c.gross_margin * 1000) / 10) : '',
        fixed: c.fixed_costs_monthly != null ? String(c.fixed_costs_monthly) : '',
        shipping: v.shipping != null ? String(v.shipping) : '', packaging: v.packaging != null ? String(v.packaging) : '',
        fulfilment: v.fulfilment != null ? String(v.fulfilment) : '', payPct: v.payPct != null ? String(v.payPct) : '',
        payFixed: v.payFixed != null ? String(v.payFixed) : '', refundPct: v.refundPct != null ? String(v.refundPct) : ''
      });
    }
  }, [tick]);

  var readiness = P.readiness || [];
  var blocking = readiness.filter(function (r) { return r.blocks_targets && r.status !== 'ready'; });
  var readyCount = readiness.filter(function (r) { return r.status === 'ready'; }).length;
  var sections = {};
  readiness.forEach(function (r) { (sections[r.section] = sections[r.section] || []).push(r); });

  function calc() {
    setBusy(true); setMsg(null);
    window.FRKL_PLAN.derive(amount === '' ? null : amount, amount === '' ? 'auto' : basis).then(function (r) { setDerived(r); setBusy(false); });
  }
  function confirm() {
    if (!derived) return;
    setBusy(true); setMsg(null);
    window.FRKL_PLAN.confirm(derived).then(function (res) { setBusy(false); setMsg(res.ok ? 'ok' : ('err:' + (res.error || 'failed'))); });
  }

  function saveEcon() {
    if (!econ) return;
    setBusy(true); setEcMsg(null);
    var base = (window.FRKL_PLAN.config && window.FRKL_PLAN.config.variable_costs) || {};
    var vc = Object.assign({}, base);
    ['shipping', 'packaging', 'fulfilment', 'payPct', 'payFixed', 'refundPct'].forEach(function (k) { if (econ[k] !== '' && econ[k] != null) vc[k] = Number(econ[k]); });
    var fields = { gross_margin: econ.gm === '' ? null : Number(econ.gm) / 100, fixed_costs_monthly: econ.fixed === '' ? null : Number(econ.fixed), variable_costs: vc };
    window.FRKL_PLAN.saveEconomics(fields).then(function (res) { setBusy(false); setEcMsg(res.ok ? 'ok' : ('err:' + (res.error || 'failed'))); });
  }
  function setE(k, val) { setEcon(function (o) { var n = Object.assign({}, o); n[k] = val.replace(/[^0-9.]/g, ''); return n; }); }

  var wrap = { maxWidth: 1180, margin: '0 auto', padding: '10px 6px 60px', background: GP_T.bg, color: GP_T.ink };
  var input = { background: 'var(--color-surface)', border: '1px solid ' + GP_T.line, borderRadius: 8, color: GP_T.ink, fontFamily: GP_T.mono, fontSize: 16, padding: '8px 11px', width: 160 };
  var seg = function (on) { return { background: on ? GP_T.accent : 'none', color: on ? '#fff' : GP_T.mut, fontWeight: on ? 600 : 400, border: 0, fontSize: 12.5, padding: '7px 13px', borderRadius: 6, cursor: 'pointer' }; };
  var cfg = (window.FRKL_PLAN && window.FRKL_PLAN.config) || null;
  var perDays = (P.period && P.period.start && P.period.end) ? Math.max(1, Math.round((new Date(P.period.end) - new Date(P.period.start)) / 864e5) + 1) : 90;
  var fixedForPeriod = cfg && cfg.fixed_costs_monthly ? Number(cfg.fixed_costs_monthly) * (perDays / 30) : 0;
  var opTarget = derived ? (Number(derived.cam_target || 0) - fixedForPeriod) : null;
  var targetCac = (derived && derived.new_customer_target > 0) ? (derived.spend_cap / derived.new_customer_target) : null;
  var g = P.goal;

  return (
    <div style={wrap}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 4 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Plan</h2>
        <span style={{ fontSize: 12.5, color: GP_T.dim }}>quarter {P.period.start} – {P.period.end}</span>
      </div>
      <div style={{ fontSize: 12, color: GP_T.dim, marginBottom: 14 }}>Confirm your economics, set a goal, and the targets below drive pace &amp; the action queue.</div>

      {/* readiness gate */}
      <div style={{ background: GP_T.panel, border: '1px solid ' + GP_T.line, borderRadius: 12, padding: '14px 16px', marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <div style={{ fontSize: 11, letterSpacing: '.5px', textTransform: 'uppercase', color: GP_T.accent2 }}>Data readiness</div>
          <div style={{ fontSize: 12, color: blocking.length ? GP_T.amber : GP_T.green }}>{readyCount}/{readiness.length} ready{blocking.length ? ' · ' + blocking.length + ' blocking targets' : ' · plan-ready ✓'}</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(300px,1fr))', gap: '6px 22px' }}>
          {Object.keys(sections).map(function (sec) {
            return (
              <div key={sec}>
                <div style={{ fontSize: 10.5, color: GP_T.dim, textTransform: 'uppercase', letterSpacing: '.4px', margin: '4px 0 3px' }}>{sec}</div>
                {sections[sec].map(function (r, i) {
                  return (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 0', fontSize: 12.5 }}>
                      <GP_Dot c={GP_rag(r.status)} />
                      <span style={{ flex: 1 }}>{r.item}{r.blocks_targets ? '' : ' ·'}</span>
                      <span style={{ color: GP_T.dim, fontSize: 11.5 }}>{r.detail}</span>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>

      {/* economics editor — operating costs feed Operating Profit on the Overview */}
      <div style={{ background: GP_T.panel, border: '1px solid ' + GP_T.line, borderRadius: 12, padding: '14px 16px', marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <div style={{ fontSize: 11, letterSpacing: '.5px', textTransform: 'uppercase', color: GP_T.accent2 }}>Operating economics</div>
          <span style={{ fontSize: 11.5, color: GP_T.dim }}>feeds contribution &amp; Operating Profit</span>
        </div>
        <div style={{ fontSize: 12, color: GP_T.dim, marginBottom: 12 }}>Fixed (operating) costs are your monthly overhead — rent, salaries, software. Operating Profit = contribution-after-marketing − fixed costs.</div>
        {econ ? (
          <div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 12 }}>
              {[['gm', 'Gross margin', '%'], ['fixed', 'Operating (fixed) costs', '£ / month'], ['shipping', 'Shipping', '£ / order'], ['packaging', 'Packaging', '£ / order'], ['fulfilment', 'Fulfilment', '£ / order'], ['payPct', 'Payment fee', '%'], ['payFixed', 'Payment fixed', '£ / order'], ['refundPct', 'Refund rate', '%']].map(function (f) {
                var hi = f[0] === 'fixed';
                return (
                  <div key={f[0]}>
                    <div style={{ fontSize: 11, color: hi ? GP_T.accent2 : GP_T.mut, marginBottom: 4, fontWeight: hi ? 600 : 400 }}>{f[1]} <span style={{ color: GP_T.dim }}>({f[2]})</span></div>
                    <input style={{ background: 'var(--color-surface)', border: '1px solid ' + (hi ? GP_T.accent : GP_T.line), borderRadius: 8, color: GP_T.ink, fontFamily: GP_T.mono, fontSize: 14, padding: '7px 9px', width: '100%', boxSizing: 'border-box' }} value={econ[f[0]]} onChange={function (e) { setE(f[0], e.target.value); }} />
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 14 }}>
              <button onClick={saveEcon} disabled={busy} style={{ borderRadius: 8, padding: '9px 16px', fontSize: 13, border: '1px solid ' + GP_T.accent, background: GP_T.accent, color: '#fff', fontWeight: 600, cursor: 'pointer' }}>{busy ? '…' : 'Save economics'}</button>
              {ecMsg === 'ok' && <span style={{ color: GP_T.green, fontSize: 12.5 }}>✓ Saved — Operating Profit now uses these costs.</span>}
              {ecMsg && ecMsg.indexOf('err') === 0 && <span style={{ color: GP_T.red, fontSize: 12.5 }}>{ecMsg.slice(4)}</span>}
              <span style={{ fontSize: 11, color: GP_T.dim }}>Gross margin &amp; variable costs recompute your contribution ratio.</span>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12.5, color: GP_T.dim }}>Loading economics…</div>
        )}
      </div>

      {/* forecast vs goal — the calendar's impact on the plan (reads vw_forecast_vs_goal, SOT) */}
      {P.forecast && (
        <div style={{ background: GP_T.panel, border: '1px solid ' + GP_T.line, borderRadius: 12, padding: '14px 16px', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 11, letterSpacing: '.5px', textTransform: 'uppercase', color: GP_T.accent2 }}>Forecast vs goal</div>
            <div style={{ fontSize: 11.5, color: GP_T.dim }}>calendar-driven · covers {P.forecast.forecast_covers_from} – {P.forecast.forecast_covers_to}{Number(P.forecast.uncovered_days) > 0 ? ' · ' + P.forecast.uncovered_days + 'd beyond horizon' : ''}</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 10 }}>
            <GP_Metric k="Forecast revenue" v={GP_gbp(P.forecast.forecast_revenue_period)} sub={'target ' + GP_gbp(P.forecast.revenue_target)} />
            <GP_Metric k="Forecast CAM" v={GP_gbp(P.forecast.forecast_cm_period)} hi={true} sub={'target ' + GP_gbp(P.forecast.contribution_margin_target)} />
            <GP_Metric k="From the calendar" v={GP_gbp(P.forecast.forecast_event_revenue_period)} sub={'CM ' + GP_gbp(P.forecast.forecast_event_cm_period)} />
            <GP_Metric k="Revenue gap" v={GP_gbp(P.forecast.revenue_gap)} sub={Number(P.forecast.revenue_gap) >= 0 ? 'ahead of plan' : 'behind — add events'} />
            <GP_Metric k="CAM gap" v={GP_gbp(P.forecast.cm_gap)} sub={Number(P.forecast.cm_gap) >= 0 ? 'ahead' : 'behind plan'} />
          </div>
          <div style={{ fontSize: 11, color: GP_T.dim, marginTop: 8 }}>Events with no expected figure are benchmark-seeded (flagged, not measured). Add promos/launches to the calendar to lift the forecast toward the goal.</div>
        </div>
      )}

      {/* channel efficiency vs targets — CTC: CM-first, normalized iROAS, fix before scale */}
      {P.channels && P.channels.length ? (
        <div style={{ background: GP_T.panel, border: '1px solid ' + GP_T.line, borderRadius: 12, padding: '14px 16px', marginBottom: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 11, letterSpacing: '.5px', textTransform: 'uppercase', color: GP_T.accent2 }}>Channel efficiency vs targets</div>
            <button onClick={function () { window.FRKL_PLAN.deriveChannelPlan(true); }} style={{ fontSize: 11, color: GP_T.mut, background: 'none', border: '1px solid ' + GP_T.line, borderRadius: 6, padding: '4px 9px', cursor: 'pointer' }}>{(P.channels[0] && P.channels[0].plan_confirmed) ? 'Re-derive plan from goal' : 'Set plan from goal'}</button>
          </div>
          <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
            <thead><tr style={{ color: GP_T.mut, fontSize: 11 }}>
              <th style={{ textAlign: 'left', fontWeight: 400 }}>Channel</th>
              <th style={{ textAlign: 'right', fontWeight: 400 }}>Spend 30d</th>
              <th style={{ textAlign: 'right', fontWeight: 400 }}>iROAS</th>
              <th style={{ textAlign: 'right', fontWeight: 400 }}>CAC</th>
              <th style={{ textAlign: 'right', fontWeight: 400 }}>Planned</th>
              <th style={{ textAlign: 'right', fontWeight: 400 }}>Pace</th>
              <th style={{ textAlign: 'right', fontWeight: 400, paddingLeft: 10 }}>Verdict</th>
            </tr></thead>
            <tbody>
              {P.channels.map(function (c, i) {
                var col = c.status === 'fix' ? GP_T.red : c.status === 'scale' ? GP_T.green : c.status === 'ease' ? GP_T.amber : GP_T.mut;
                var pace = c.spend_pace_pct_of_plan;
                var paceCol = pace == null ? GP_T.dim : ((c.status === 'fix' && pace > 100) || pace > 140) ? GP_T.red : pace < 80 ? GP_T.amber : GP_T.dim;
                var tgt = c.plan_target_iroas != null ? c.plan_target_iroas : (c.target_marginal_iroas != null ? c.target_marginal_iroas : c.break_even_iroas);
                return (
                  <tr key={i} style={{ borderTop: '1px solid ' + GP_T.line }}>
                    <td style={{ textAlign: 'left', padding: '4px 0' }}>{String(c.channel_type).replace(/_/g, ' ')}</td>
                    <td style={{ textAlign: 'right', fontFamily: GP_T.mono }}>{GP_gbp(c.spend_30d)}</td>
                    <td style={{ textAlign: 'right', fontFamily: GP_T.mono, color: col }}>{Number(c.avg_iroas).toFixed(2)}×</td>
                    <td style={{ textAlign: 'right', fontFamily: GP_T.mono, color: c.plan_target_cac != null && c.plan_target_cac > 100 ? GP_T.red : GP_T.dim }}>{c.plan_target_cac == null ? '—' : '£' + Math.round(c.plan_target_cac)}</td>
                    <td style={{ textAlign: 'right', fontFamily: GP_T.mono }}>{c.planned_spend == null ? '—' : GP_gbp(c.planned_spend)}</td>
                    <td style={{ textAlign: 'right', fontFamily: GP_T.mono, color: paceCol }}>{pace == null ? '—' : pace + '%'}</td>
                    <td style={{ textAlign: 'right', color: col, textTransform: 'uppercase', fontSize: 11, paddingLeft: 10 }}>{c.status}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div style={{ fontSize: 11, color: GP_T.dim, marginTop: 8 }}>
            Focus: <b style={{ color: GP_T.ink }}>{String(P.channels[0].channel_type).replace(/_/g, ' ')}</b> — {P.channels[0].action}
            {P.channels[0].phi_is_assumed ? <span> · iROAS uses <b>benchmark</b> incrementality (φ), not yet measured — run a holdout to confirm.</span> : null}
          </div>
        </div>
      ) : null}

      {/* goal setter */}
      <div style={{ background: 'linear-gradient(180deg,' + GP_T.panel + ',' + GP_T.panel2 + ')', border: '1px solid ' + GP_T.line, borderRadius: 12, padding: '16px 18px' }}>
        <div style={{ fontSize: 11, letterSpacing: '.5px', textTransform: 'uppercase', color: GP_T.accent2, marginBottom: 10 }}>Set the quarter goal</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', background: 'var(--color-surface)', border: '1px solid ' + GP_T.line, borderRadius: 8, padding: 3 }}>
            <button onClick={function () { setBasis('cam'); }} style={seg(basis === 'cam')}>Contribution (CAM)</button>
            <button onClick={function () { setBasis('revenue'); }} style={seg(basis === 'revenue')}>Revenue</button>
          </div>
          <div>
            <div style={{ fontSize: 11, color: GP_T.mut, marginBottom: 4 }}>{basis === 'cam' ? 'Contribution-after-marketing goal' : 'Revenue goal'} (£)</div>
            <input style={input} value={amount} onChange={function (e) { setAmount(e.target.value.replace(/[^0-9.]/g, '')); }} placeholder={basis === 'cam' ? 'e.g. 25000' : 'e.g. 90000'} />
          </div>
          <button onClick={calc} disabled={busy} style={{ borderRadius: 8, padding: '9px 15px', fontSize: 13, border: '1px solid ' + GP_T.line, background: GP_T.panel, color: GP_T.ink, cursor: 'pointer' }}>{busy ? '…' : 'Calculate'}</button>
          <span style={{ fontSize: 11.5, color: GP_T.dim }}>leave blank + Calculate for the run-rate baseline</span>
        </div>

        {derived && (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(150px,1fr))', gap: 10 }}>
              <GP_Metric k="Revenue target" v={GP_gbp(derived.revenue_target)} />
              <GP_Metric k="Contribution (product)" v={GP_gbp(derived.product_cm_target)} sub={'× ' + Math.round((derived.cm_ratio_used || 0) * 100) + '%'} />
              <GP_Metric k="Contribution after mktg" v={GP_gbp(derived.cam_target)} hi={true} sub="the arbiter (CAM)" />
              <GP_Metric k="Spend cap" v={GP_gbp(derived.spend_cap)} sub={'MER ' + derived.mer_target} />
              <GP_Metric k="New customers" v={Math.round(derived.new_customer_target).toLocaleString('en-GB')} sub={'aMER ' + derived.amer_used} />
              <GP_Metric k="Returning (baseline)" v={GP_gbp(derived.returning_revenue_target)} />
              <GP_Metric k="Target CAC (optimal)" v={targetCac == null ? '—' : '£' + targetCac.toFixed(2)} hi={true} sub="spend cap ÷ new custs" />
              <GP_Metric k="Operating profit" v={opTarget == null ? '—' : GP_gbp(opTarget)} sub={fixedForPeriod > 0 ? 'CAM − ' + GP_gbp(fixedForPeriod) + ' fixed' : 'set fixed costs above'} />
            </div>
            {g && (
              <div style={{ fontSize: 11.5, color: GP_T.dim, marginTop: 8 }}>
                Current {g.confirmed ? 'confirmed' : 'provisional'} goal: revenue {GP_gbp(g.revenue_target)} · product CM {GP_gbp(g.contribution_margin_target)} · spend cap {GP_gbp(g.spend_cap)} · MER {g.mer_target}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
              <button onClick={confirm} disabled={busy} style={{ borderRadius: 8, padding: '9px 16px', fontSize: 13, border: '1px solid ' + GP_T.accent, background: GP_T.accent, color: '#fff', fontWeight: 600, cursor: 'pointer' }}>Confirm as plan of record</button>
              {msg === 'ok' && <span style={{ color: GP_T.green, fontSize: 12.5 }}>✓ Confirmed — this is now your plan; pace &amp; RAG-vs-target are live.</span>}
              {msg && msg.indexOf('err') === 0 && <span style={{ color: GP_T.red, fontSize: 12.5 }}>{msg.slice(4)}</span>}
              <span style={{ fontSize: 11, color: GP_T.dim }}>Confirming derives from live economics (cm {Math.round((derived.cm_ratio_used || 0) * 100)}%, aMER {derived.amer_used}).</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}


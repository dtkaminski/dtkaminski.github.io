// ── Plan panel (readiness gate + target setter) ──────────────────────────────
// Added 2026-07-14. Wires steps 1-2 of the targets workstream: shows the plan-readiness
// gate (vw_brand_plan_readiness), lets the user set a quarter goal in EITHER contribution
// (CAM) or revenue and see the full derived target set (both units), then confirm it as the
// plan of record (mos_business_goal.confirmed=true). Global-scope, GP_* namespaced. Data +
// writes live in window.FRKL_PLAN (greta-plan-data.js). Confirm is user-initiated only.
var GP_T = { bg:'#0b0d12', panel:'#14161c', panel2:'#181b23', line:'#232733', ink:'#e8eaf0',
  mut:'#8b93a7', dim:'#5b6479', accent:'#7c8cff', accent2:'#a6b0ff', green:'#3fbf87', amber:'#e0a53d', red:'#e5644e',
  mono:'"SF Mono",ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace' };
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

  React.useEffect(function () {
    var h = function () { setTick(function (x) { return x + 1; }); };
    window.addEventListener('frkl-plan-updated', h);
    if (window.FRKL_PLAN && !derived) window.FRKL_PLAN.derive(null, 'auto').then(function (r) { if (r) setDerived(r); });
    return function () { window.removeEventListener('frkl-plan-updated', h); };
  }, []);

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

  var wrap = { maxWidth: 1180, margin: '0 auto', padding: '10px 6px 60px', background: GP_T.bg, color: GP_T.ink };
  var input = { background: '#0f1218', border: '1px solid ' + GP_T.line, borderRadius: 8, color: GP_T.ink, fontFamily: GP_T.mono, fontSize: 16, padding: '8px 11px', width: 160 };
  var seg = function (on) { return { background: on ? GP_T.accent : 'none', color: on ? '#0b0d12' : GP_T.mut, fontWeight: on ? 600 : 400, border: 0, fontSize: 12.5, padding: '7px 13px', borderRadius: 6, cursor: 'pointer' }; };
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

      {/* goal setter */}
      <div style={{ background: 'linear-gradient(180deg,' + GP_T.panel + ',' + GP_T.panel2 + ')', border: '1px solid ' + GP_T.line, borderRadius: 12, padding: '16px 18px' }}>
        <div style={{ fontSize: 11, letterSpacing: '.5px', textTransform: 'uppercase', color: GP_T.accent2, marginBottom: 10 }}>Set the quarter goal</div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', background: '#0f1218', border: '1px solid ' + GP_T.line, borderRadius: 8, padding: 3 }}>
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
            </div>
            {g && (
              <div style={{ fontSize: 11.5, color: GP_T.dim, marginTop: 8 }}>
                Current {g.confirmed ? 'confirmed' : 'provisional'} goal: revenue {GP_gbp(g.revenue_target)} · product CM {GP_gbp(g.contribution_margin_target)} · spend cap {GP_gbp(g.spend_cap)} · MER {g.mer_target}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 12 }}>
              <button onClick={confirm} disabled={busy} style={{ borderRadius: 8, padding: '9px 16px', fontSize: 13, border: '1px solid ' + GP_T.accent, background: GP_T.accent, color: '#0b0d12', fontWeight: 600, cursor: 'pointer' }}>Confirm as plan of record</button>
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

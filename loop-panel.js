/* loop-panel.jsx — the operating loop and the spend curve, as two embeddable views.
 *
 * Follows the same conventions as dashboard_app.jsx:
 *   - single self-contained IIFE, no imports, React/ReactDOM from the host page
 *   - sbClient() resolves window.sb (standalone) or window.FRKL_LIVE.sb (embedded)
 *   - components exposed on window for the host's mosView() to render
 *   - no self-mount: this file is always embedded
 *
 * Build:  npx babel loop-panel.jsx --presets "@babel/preset-react" -o loop-panel.js
 *         (babel 8: add --plugins to force classic runtime, or keep the .babelrc in this folder --
 *          the host page supplies React as a GLOBAL, so the automatic runtime would emit a bare
 *          `import` and break the bundle)
 *
 * PRINCIPLE (FRONTEND-SOT-SPEC): if a number has a view, render the view. Nothing here
 * recomputes a rate, a band, a pound allocation or an elasticity. In particular the
 * decision of WHETHER to show a marginal cost at all is made by
 * vw_brand_curve_panel.can_show_point_estimate, never by this file.
 *
 * Views read:
 *   cache_funnel_loop     per-stage pound allocation + sigma vs own 12-month normal
 *   cache_funnel_cut      which cut localises a funnel change (share-weighted rank)
 *                         (both refreshed from vw_funnel_leak / vw_funnel_cut_change by
 *                          fn_refresh_funnel_loop_cache() on the daily cron)
 *   vw_brand_curve_panel  elasticity, its interval, and the resolved abstention
 *   vw_brand_spend_curve_points   monthly (spend, new customers) for the response curve
 *   vw_brand_curve_history        point-in-time k, refitted each month
 */
(function () {
  const {
    useState,
    useEffect,
    useMemo
  } = React;

  // Read the CACHE tables, not the views. vw_funnel_leak recomputes the whole spine, the
  // control bands and a lateral percentile on every call: ~5.4s in SQL and over 23s through
  // PostgREST, which is far too slow for a panel. fn_refresh_funnel_loop_cache() materialises
  // both on the daily cron, the same pattern as cache_customer_tier_periods. The views remain
  // the source of truth and stay queryable for analysis.
  const LEAK_SRC = 'cache_funnel_loop';
  const CUT_SRC = 'cache_funnel_cut';
  function sbClient() {
    if (typeof window === 'undefined') return null;
    return window.sb || window.FRKL_LIVE && window.FRKL_LIVE.sb || null;
  }

  /* ── formatting ─────────────────────────────────────────────────────── */
  const money = (n, dp) => n === null || n === undefined || !isFinite(n) ? '—' : '£' + Number(n).toLocaleString('en-GB', {
    minimumFractionDigits: dp === undefined ? 0 : dp,
    maximumFractionDigits: dp === undefined ? 0 : dp
  });
  const count = n => n === null || n === undefined || !isFinite(n) ? '—' : Number(n).toLocaleString('en-GB');
  const pct1 = n => n === null || n === undefined || !isFinite(n) ? '—' : (n * 100).toFixed(1) + '%';
  const signedPct = n => n === null || n === undefined || !isFinite(n) ? '—' : (n >= 0 ? '+' : '−') + Math.abs(n * 100).toFixed(0) + '%';
  const signedMoney = n => n === null || n === undefined || !isFinite(n) ? '—' : (n >= 0 ? '−' : '+') + money(Math.abs(n)); // a positive leak is money LOST

  function fmtStage(v, fmt) {
    if (fmt === 'rate') return pct1(v);
    if (fmt === 'money') return money(v, 2);
    return count(Math.round(v));
  }

  /* A month is judged against its own normal, so severity is distance in sigma.
     Direction matters: a stage ABOVE its normal is never an alarm. */
  function severity(sigma) {
    if (sigma === null || sigma === undefined || !isFinite(sigma)) return 'flat';
    if (sigma >= 1) return 'good';
    if (sigma > -1) return 'flat';
    return sigma <= -2 ? 'bad' : 'watch';
  }
  function useRows(view, brandId, opts) {
    const [rows, setRows] = useState(null);
    const [err, setErr] = useState(null);
    const key = JSON.stringify(opts || {});
    useEffect(() => {
      let alive = true,
        timer = null,
        tries = 0;
      function run() {
        const sb = sbClient();
        // greta-data-loader.js installs the Supabase client asynchronously, so it is
        // routinely absent when this panel first mounts. Returning here without a retry
        // strands the panel on "Loading…" for ever, because none of this effect's deps
        // change when the client later appears. So wait for it, with a cap.
        if (!sb || !brandId) {
          if (!alive) return;
          if (++tries > 75) {
            setErr('Supabase client never became available');
            return;
          }
          timer = setTimeout(run, 400);
          return;
        }
        let q = sb.from(view).select('*').eq('brand_id', brandId);
        const o = opts || {};
        if (o.eq) Object.keys(o.eq).forEach(k => {
          q = q.eq(k, o.eq[k]);
        });
        if (o.order) q = q.order(o.order, {
          ascending: o.asc !== false
        });
        if (o.limit) q = q.limit(o.limit);
        q.then(r => {
          if (!alive) return;
          if (r.error) setErr(r.error.message);else setRows(r.data || []);
        }).catch(e => {
          if (alive) setErr(String(e && e.message || e));
        });
      }
      run();
      return () => {
        alive = false;
        if (timer) clearTimeout(timer);
      };
    }, [view, brandId, key]);
    return [rows, err];
  }

  /* ── the ring ───────────────────────────────────────────────────────── */
  const RING = {
    W: 1000,
    H: 760,
    CX: 500,
    CY: 378,
    RAD: 214,
    MAXT: 62,
    MAXL: 108
  };
  function polar(a, r) {
    const t = a * Math.PI / 180;
    return [RING.CX + r * Math.cos(t), RING.CY + r * Math.sin(t)];
  }
  function ringPaths(stages) {
    const potential = stages.length ? Number(stages[0].potential) : 0;
    const maxLeak = Math.max(...stages.map(s => Math.abs(Number(s.leak))), 1);
    const thick = v => Math.max(6, v / (potential || 1) * RING.MAXT);
    const seg = (a0, a1, f0, f1) => {
      const out = [];
      const N = 30;
      for (let i = 0; i <= N; i++) {
        const u = i / N,
          a = a0 + (a1 - a0) * u,
          t = thick(f0 + (f1 - f0) * u);
        out.push(polar(a, RING.RAD + t / 2));
      }
      for (let i = N; i >= 0; i--) {
        const u = i / N,
          a = a0 + (a1 - a0) * u,
          t = thick(f0 + (f1 - f0) * u);
        out.push(polar(a, RING.RAD - t / 2));
      }
      return 'M' + out.map(p => p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join('L') + 'Z';
    };
    const wedge = (a, amount, tAt) => {
      const ln = Math.abs(amount) / maxLeak * RING.MAXL;
      const half = Math.max(3.5, Math.min(tAt / 2, 16));
      let r0, r1;
      if (amount > 0) {
        r0 = RING.RAD + tAt / 2;
        r1 = r0 + ln;
      } else {
        r0 = RING.RAD - tAt / 2;
        r1 = Math.max(168, r0 - ln * 0.42);
      }
      const spread = half / Math.max(r0, 1) * (180 / Math.PI);
      const tipsp = 2.5 / Math.max(Math.abs(r1), 1) * (180 / Math.PI);
      const p = [polar(a - spread, r0), polar(a + spread, r0), polar(a + tipsp, r1), polar(a - tipsp, r1)];
      return 'M' + p.map(q => q[0].toFixed(1) + ' ' + q[1].toFixed(1)).join('L') + 'Z';
    };
    return stages.map((s, i) => {
      const a0 = -90 + i * 72;
      const aJoin = a0 + 68;
      const leak = Number(s.leak);
      const tAt = thick(Number(s.flow_out));
      const ln = Math.abs(leak) / maxLeak * RING.MAXL;
      const labelR = leak > 0 ? RING.RAD + tAt / 2 + ln + 19 : RING.RAD + tAt / 2 + 26;
      const [lx, ly] = polar(aJoin, labelR);
      const ca = Math.cos(aJoin * Math.PI / 180);
      const anchor = ca > 0.35 ? 'start' : ca < -0.35 ? 'end' : 'middle';
      const ox = anchor === 'start' ? 8 : anchor === 'end' ? -8 : 0;
      const [sx, sy] = polar(a0 + 32, RING.RAD + RING.MAXT / 2 + 52);
      return {
        key: s.stage,
        pipe: seg(a0, a0 + 64, Number(s.flow_in), Number(s.flow_out)),
        wedge: wedge(aJoin, leak, tAt),
        show: Math.abs(leak) > maxLeak * 0.06,
        leak,
        lx: lx + ox,
        ly,
        anchor,
        sx,
        sy,
        row: s
      };
    });
  }
  function LeakRing(props) {
    const g = props.geometry,
      s = props.stages;
    if (!s || !s.length) return null;
    const potential = Number(s[0].potential),
      actual = Number(s[0].actual);
    return /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("div", {
      className: "lp-inflow"
    }, /*#__PURE__*/React.createElement("span", {
      className: "lp-inflow-n"
    }, money(potential)), /*#__PURE__*/React.createElement("span", {
      className: "lp-inflow-d"
    }, "goes in, which is what this brand produces with every stage at its own twelve month normal")), /*#__PURE__*/React.createElement("div", {
      className: "lp-chwrap"
    }, /*#__PURE__*/React.createElement("svg", {
      className: "lp-ring",
      viewBox: '0 0 ' + RING.W + ' ' + RING.H,
      role: "img",
      "aria-label": 'The operating loop drawn as a pipe. It enters carrying ' + money(potential) + ' of contribution, the amount every stage at its own twelve month normal would produce, ' + 'and leaks at each join until ' + money(actual) + ' reaches the centre.'
    }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("marker", {
      id: "lpArrow",
      viewBox: "0 0 10 10",
      refX: "8",
      refY: "5",
      markerWidth: "5.5",
      markerHeight: "5.5",
      orient: "auto-start-reverse"
    }, /*#__PURE__*/React.createElement("polygon", {
      points: "0,1 9,5 0,9",
      fill: "currentColor"
    }))), g.map(x => /*#__PURE__*/React.createElement("path", {
      key: 'p' + x.key,
      className: "lp-pipe",
      d: x.pipe
    })), g.map(x => /*#__PURE__*/React.createElement("path", {
      key: 'w' + x.key,
      className: x.leak > 0 ? 'lp-leak' : 'lp-gain',
      d: x.wedge
    }, /*#__PURE__*/React.createElement("title", null, x.row.stage + ' · ' + x.row.metric + ' · ' + Number(x.row.sigma).toFixed(1) + ' sd from its own normal · ' + (x.leak > 0 ? 'losing ' : 'gaining ') + money(Math.abs(x.leak)) + ' a month'))), g.filter(x => x.show).map(x => /*#__PURE__*/React.createElement("g", {
      key: 'l' + x.key
    }, /*#__PURE__*/React.createElement("text", {
      className: 'lp-amt ' + (x.leak > 0 ? 'lp-t-leak' : 'lp-t-gain'),
      x: x.lx.toFixed(0),
      y: x.ly.toFixed(0),
      textAnchor: x.anchor
    }, signedMoney(x.leak)), /*#__PURE__*/React.createElement("text", {
      className: 'lp-amtw ' + (x.leak > 0 ? 'lp-t-leak' : 'lp-t-gain'),
      x: x.lx.toFixed(0),
      y: (x.ly + 15).toFixed(0),
      textAnchor: x.anchor
    }, (x.leak > 0 ? 'lost at ' : 'gained at ') + x.row.stage.toLowerCase()))), g.map(x => /*#__PURE__*/React.createElement("g", {
      key: 's' + x.key
    }, /*#__PURE__*/React.createElement("text", {
      className: "lp-stage",
      x: x.sx.toFixed(0),
      y: (x.sy - 7).toFixed(0),
      textAnchor: "middle"
    }, x.row.stage), /*#__PURE__*/React.createElement("text", {
      className: "lp-metric",
      x: x.sx.toFixed(0),
      y: (x.sy + 9).toFixed(0),
      textAnchor: "middle"
    }, x.row.metric), /*#__PURE__*/React.createElement("text", {
      className: 'lp-val lp-sev-' + severity(Number(x.row.sigma)),
      x: x.sx.toFixed(0),
      y: (x.sy + 25).toFixed(0),
      textAnchor: "middle"
    }, fmtStage(Number(x.row.v), x.row.fmt) + ' · normal ' + fmtStage(Number(x.row.mu), x.row.fmt)))), /*#__PURE__*/React.createElement("rect", {
      className: "lp-hub",
      x: RING.CX - 150,
      y: RING.CY - 88,
      width: "300",
      height: "176",
      rx: "6"
    }), /*#__PURE__*/React.createElement("text", {
      className: "lp-hub-k",
      x: RING.CX,
      y: RING.CY - 52,
      textAnchor: "middle"
    }, "REACHES THE CENTRE"), /*#__PURE__*/React.createElement("text", {
      className: "lp-hub-n",
      x: RING.CX,
      y: RING.CY - 14,
      textAnchor: "middle"
    }, money(actual)), /*#__PURE__*/React.createElement("text", {
      className: "lp-hub-s",
      x: RING.CX,
      y: RING.CY + 8,
      textAnchor: "middle"
    }, "contribution before media"), /*#__PURE__*/React.createElement("line", {
      className: "lp-hub-r",
      x1: RING.CX - 104,
      x2: RING.CX + 104,
      y1: RING.CY + 24,
      y2: RING.CY + 24
    }), /*#__PURE__*/React.createElement("text", {
      className: "lp-hub-s2",
      x: RING.CX,
      y: RING.CY + 46,
      textAnchor: "middle"
    }, money(potential - actual) + ' did not arrive'))));
  }

  /* ── which cut localises the change ─────────────────────────────────── */
  function CutStrip(props) {
    const rows = props.rows;
    if (!rows || !rows.length) return null;
    const dims = [];
    rows.forEach(r => {
      let d = dims.find(x => x.dim === r.dim);
      if (!d) {
        d = {
          dim: r.dim,
          rank: r.cut_rank,
          disp: Number(r.ctc_dispersion),
          segs: []
        };
        dims.push(d);
      }
      if (r.ctc_chg !== null) d.segs.push(r);
    });
    dims.sort((a, b) => a.rank - b.rank);
    // scale on the segments that can actually drive the ranking; a 3% segment swinging +241%
    // would otherwise squash every real segment into the left edge. Thin ones are clamped in.
    const solid = rows.filter(r => r.ctc_chg !== null && !r.is_thin).map(r => Number(r.ctc_chg));
    const base = solid.length ? solid : rows.filter(r => r.ctc_chg !== null).map(r => Number(r.ctc_chg));
    const pad = 0.08;
    const lo = Math.min(-0.05, ...base) - pad,
      hi = Math.max(0.05, ...base) + pad;
    const X = v => Math.max(0, Math.min(100, (v - lo) / (hi - lo) * 100));
    return /*#__PURE__*/React.createElement("div", {
      className: "lp-cuts"
    }, dims.map((d, i) => /*#__PURE__*/React.createElement("div", {
      className: 'lp-cut' + (i === 0 ? ' lp-cut-win' : ''),
      key: d.dim
    }, /*#__PURE__*/React.createElement("div", {
      className: "lp-cut-head"
    }, /*#__PURE__*/React.createElement("span", {
      className: "lp-cut-name"
    }, d.dim === 'landing' ? 'Landing page' : d.dim === 'device' ? 'Device' : 'Country'), /*#__PURE__*/React.createElement("span", {
      className: "lp-cut-disp"
    }, i === 0 ? 'separates most · ' : '', (d.disp * 100).toFixed(0), " pts apart")), /*#__PURE__*/React.createElement("div", {
      className: "lp-cut-track"
    }, /*#__PURE__*/React.createElement("div", {
      className: "lp-cut-zero",
      style: {
        left: X(0) + '%'
      }
    }), d.segs.map(s => {
      const chg = Number(s.ctc_chg),
        share = Number(s.share);
      const size = 6 + Math.sqrt(share) * 22;
      return /*#__PURE__*/React.createElement("div", {
        key: s.value,
        className: 'lp-dot' + (chg > 0 ? ' lp-dot-up' : '') + (s.is_thin ? ' lp-dot-thin' : ''),
        style: {
          left: X(chg) + '%',
          width: size + 'px',
          height: size + 'px'
        },
        title: s.value + ' · ' + pct1(Number(s.prev_ctc)) + ' to ' + pct1(Number(s.cur_ctc)) + ' (' + signedPct(chg) + ') · ' + (share * 100).toFixed(0) + '% of sessions' + (s.is_thin ? ' · too thin to affect the ranking' : '')
      });
    })), /*#__PURE__*/React.createElement("div", {
      className: "lp-cut-legend"
    }, d.segs.filter(s => !s.is_thin).sort((a, b) => Number(a.ctc_chg) - Number(b.ctc_chg)).slice(0, 3).map(s => /*#__PURE__*/React.createElement("span", {
      key: s.value
    }, /*#__PURE__*/React.createElement("b", null, s.value === '/' ? 'home page' : s.value), " ", signedPct(Number(s.ctc_chg))))))), /*#__PURE__*/React.createElement("p", {
      className: "lp-note"
    }, "Each dot is one segment, sized by its share of sessions. Faded dots carry under 5% of the cut and are shown but never allowed to drive the ranking, because a tiny segment with a wild swing will otherwise outrank a real split in the traffic that matters."));
  }

  /* ── the spend curve ────────────────────────────────────────────────── */
  function Spark(props) {
    const {
      pts,
      W = 560,
      H = 190,
      xKey,
      yKey,
      band
    } = props;
    if (!pts || pts.length < 2) return null;
    const xs = pts.map(p => Number(p[xKey])),
      ys = pts.map(p => Number(p[yKey]));
    const x0 = Math.min(...xs),
      x1 = Math.max(...xs);
    let y0 = Math.min(...ys),
      y1 = Math.max(...ys);
    if (band) {
      y0 = Math.min(y0, ...pts.map(p => Number(p[band[0]])));
      y1 = Math.max(y1, ...pts.map(p => Number(p[band[1]])));
    }
    const pad = (y1 - y0) * 0.08 || 1;
    y0 -= pad;
    y1 += pad;
    const PX = v => 46 + (v - x0) / (x1 - x0 || 1) * (W - 62);
    const PY = v => H - 30 - (v - y0) / (y1 - y0 || 1) * (H - 48);
    const line = pts.map((p, i) => (i ? 'L' : 'M') + PX(Number(p[xKey])).toFixed(1) + ' ' + PY(Number(p[yKey])).toFixed(1)).join('');
    let ribbon = null;
    if (band) {
      const top = pts.map((p, i) => (i ? 'L' : 'M') + PX(Number(p[xKey])).toFixed(1) + ' ' + PY(Number(p[band[1]])).toFixed(1)).join('');
      const bot = pts.slice().reverse().map(p => 'L' + PX(Number(p[xKey])).toFixed(1) + ' ' + PY(Number(p[band[0]])).toFixed(1)).join('');
      ribbon = top + bot + 'Z';
    }
    // round tick values rather than percentiles of the range: "0.5" reads, "0.03" does not
    const span = y1 - y0;
    const step = Math.pow(10, Math.floor(Math.log10(span / 3))) * ([1, 2, 5, 10].find(m => span / (Math.pow(10, Math.floor(Math.log10(span / 3))) * m) <= 4) || 1);
    const ticks = [];
    for (let t = Math.ceil(y0 / step) * step; t <= y1 + 1e-9; t += step) ticks.push(t);
    const xEnds = [pts[0], pts[pts.length - 1]];
    return /*#__PURE__*/React.createElement("svg", {
      className: "lp-ch",
      viewBox: '0 0 ' + W + ' ' + H,
      role: "img",
      "aria-label": props.label
    }, ticks.map((t, i) => /*#__PURE__*/React.createElement("g", {
      key: i
    }, /*#__PURE__*/React.createElement("line", {
      className: "lp-grid",
      x1: "46",
      x2: W - 16,
      y1: PY(t),
      y2: PY(t)
    }), /*#__PURE__*/React.createElement("text", {
      className: "lp-tick",
      x: "40",
      y: PY(t) + 3.5,
      textAnchor: "end"
    }, props.fmtY(t)))), props.rules && props.rules.filter(r => r.v >= y0 && r.v <= y1).map((r, i) => /*#__PURE__*/React.createElement("g", {
      key: 'r' + i
    }, /*#__PURE__*/React.createElement("line", {
      className: "lp-rule",
      x1: "46",
      x2: W - 16,
      y1: PY(r.v),
      y2: PY(r.v)
    }), /*#__PURE__*/React.createElement("text", {
      className: "lp-rulelab",
      x: r.left ? 50 : W - 18,
      y: PY(r.v) + (r.below ? 13 : -6),
      textAnchor: r.left ? 'start' : 'end'
    }, r.label))), ribbon && /*#__PURE__*/React.createElement("path", {
      className: "lp-ribbon",
      d: ribbon
    }), ribbon && /*#__PURE__*/React.createElement("path", {
      className: "lp-ribedge",
      d: ribbon
    }), !props.scatter && /*#__PURE__*/React.createElement("path", {
      className: "lp-line",
      d: line
    }), pts.map((p, i) => /*#__PURE__*/React.createElement("circle", {
      key: i,
      className: "lp-pt",
      cx: PX(Number(p[xKey])),
      cy: PY(Number(p[yKey])),
      r: props.scatter ? 4.5 : 3.5
    }, /*#__PURE__*/React.createElement("title", null, props.tip(p)))), xEnds.map((p, i) => /*#__PURE__*/React.createElement("text", {
      key: 'x' + i,
      className: "lp-tick",
      x: PX(Number(p[xKey])),
      y: H - 20,
      textAnchor: i ? 'end' : 'start'
    }, props.fmtX ? props.fmtX(p) : '')), /*#__PURE__*/React.createElement("text", {
      className: "lp-axlab",
      x: (W / 2).toFixed(0),
      y: H - 6,
      textAnchor: "middle"
    }, props.xLabel));
  }
  function CurvePanel(props) {
    const brandId = props.brandId;
    const [panel] = useRows('vw_brand_curve_panel', brandId);
    const [points] = useRows('vw_brand_spend_curve_points', brandId, {
      order: 'month'
    });
    const [hist] = useRows('vw_brand_curve_history', brandId, {
      order: 'month'
    });
    const p = panel && panel[0];
    if (!p) return /*#__PURE__*/React.createElement("div", {
      className: "lp-empty"
    }, "No fitted curve yet.");
    const canPoint = p.can_show_point_estimate === true;
    const k = Number(p.k),
      kLo = Number(p.k_low),
      kHi = Number(p.k_high);
    const cm = Number(p.cm_per_order);
    return /*#__PURE__*/React.createElement("div", {
      className: "lp-wrap"
    }, /*#__PURE__*/React.createElement("div", {
      className: "lp-head"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "lp-h"
    }, "What the next pound buys"), /*#__PURE__*/React.createElement("span", {
      className: "lp-asof"
    }, "fitted ", p.as_of, " · ", p.k_n, " months")), /*#__PURE__*/React.createElement("div", {
      className: "lp-hero"
    }, /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
      className: "lp-k"
    }, "Saturation, k"), /*#__PURE__*/React.createElement("span", {
      className: "lp-n"
    }, isFinite(k) ? k.toFixed(2) : '—'), /*#__PURE__*/React.createElement("span", {
      className: "lp-d"
    }, isFinite(kLo) ? 'Interval ' + kLo.toFixed(2) + ' to ' + kHi.toFixed(2) + '. ' : '', "Double the budget and you get ", isFinite(k) ? Math.pow(2, 1 - k).toFixed(2) : '—', " times the customers, not twice as many.")), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
      className: "lp-k"
    }, "What the next customer costs"), /*#__PURE__*/React.createElement("span", {
      className: 'lp-n' + (canPoint ? '' : ' lp-n-abstain')
    }, canPoint ? money(Number(p.marginal_cac)) : 'not yet measurable'), /*#__PURE__*/React.createElement("span", {
      className: "lp-d"
    }, p.abstain_reason)), /*#__PURE__*/React.createElement("div", null, /*#__PURE__*/React.createElement("span", {
      className: "lp-k"
    }, "What a customer is worth"), /*#__PURE__*/React.createElement("span", {
      className: "lp-n"
    }, money(cm)), /*#__PURE__*/React.createElement("span", {
      className: "lp-d"
    }, "Contribution per order, from your own realised costs."))), points && points.length > 1 && /*#__PURE__*/React.createElement("div", {
      className: "lp-fig"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "lp-h3"
    }, "The response curve"), /*#__PURE__*/React.createElement("p", {
      className: "lp-kick"
    }, "Each dot is a month: what was spent, and how many new customers came. The slope of this cloud is the whole question, and it is fitted on a spend range of only", ' ', Number(p.spend_range_x).toFixed(1), " times."), /*#__PURE__*/React.createElement("div", {
      className: "lp-chwrap"
    }, /*#__PURE__*/React.createElement(Spark, {
      pts: points.slice().sort((a, b) => Number(a.spend) - Number(b.spend)),
      xKey: "spend",
      yKey: "new_customers",
      W: 620,
      H: 210,
      scatter: true,
      fmtY: v => Math.round(v).toString(),
      fmtX: r => money(Number(r.spend)),
      xLabel: "Media spend in the month",
      label: "New customers against monthly media spend, one dot per month.",
      tip: r => r.month + ' · ' + money(Number(r.spend)) + ' · ' + count(r.new_customers) + ' new customers · CAC ' + money(Number(r.cac), 2)
    }))), hist && hist.length > 1 && /*#__PURE__*/React.createElement("div", {
      className: "lp-fig"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "lp-h3"
    }, "Is the answer getting sharper?"), /*#__PURE__*/React.createElement("p", {
      className: "lp-kick"
    }, "k refitted every month on the data available at the time, with its interval. A model that is learning shows the band narrowing. If it is not narrowing, more of the same trading will not settle the question and only a deliberate test will."), /*#__PURE__*/React.createElement("div", {
      className: "lp-chwrap"
    }, /*#__PURE__*/React.createElement(Spark, {
      pts: hist,
      xKey: "n",
      yKey: "beta",
      band: ['ci_low', 'ci_high'],
      W: 620,
      H: 210,
      fmtY: v => v.toFixed(1),
      fmtX: r => r.month + ' (' + r.n + 'mo)',
      xLabel: "Each month's refit, by how much data it could see",
      label: "The saturation exponent refitted each month, with its confidence band.",
      rules: [{
        v: 1,
        label: 'k = 1, extra spend buys nothing'
      }, {
        v: 0,
        label: 'k = 0, no saturation at all',
        left: true,
        below: true
      }],
      tip: r => 'as at ' + r.month + ' · k ' + Number(r.beta).toFixed(2) + ' · interval ' + Number(r.ci_low).toFixed(2) + ' to ' + Number(r.ci_high).toFixed(2) + ' · width ' + Number(r.ci_width).toFixed(2)
    }))), !canPoint && /*#__PURE__*/React.createElement("div", {
      className: "lp-abstain"
    }, /*#__PURE__*/React.createElement("b", null, "No spend ceiling is shown, and that is the finding."), /*#__PURE__*/React.createElement("p", null, p.abstain_reason), /*#__PURE__*/React.createElement("p", null, "Waiting does not fix this: the interval narrows with the square root of the months, so another six months of trading as usual barely moves it. Varying spend deliberately, or running a geo holdout, moves it far faster because both lengthen the lever the slope is fitted on.")));
  }

  /* ── the loop ───────────────────────────────────────────────────────── */
  function LoopView(props) {
    const brandId = props.brandId;
    const [leak, leakErr] = useRows(LEAK_SRC, brandId, {
      order: 'mo',
      asc: false
    });
    const month = useMemo(() => {
      if (!leak || !leak.length) return null;
      return leak.reduce((m, r) => r.mo > m ? r.mo : m, leak[0].mo);
    }, [leak]);
    // The newest month shown can trail the calendar when later months fail the data checks;
    // say so, or the panel looks broken.
    const monthLags = useMemo(() => {
      if (!month) return false;
      const d = new Date(),
        lastComplete = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      const lc = lastComplete.getFullYear() + '-' + String(lastComplete.getMonth() + 1).padStart(2, '0');
      return String(month).slice(0, 7) < lc;
    }, [month]);
    const stages = useMemo(() => {
      if (!leak || !month) return null;
      return leak.filter(r => r.mo === month).sort((a, b) => a.stage_no - b.stage_no);
    }, [leak, month]);
    const [cuts] = useRows(CUT_SRC, brandId, month ? {
      eq: {
        mo: month
      }
    } : null);
    const geometry = useMemo(() => stages ? ringPaths(stages) : null, [stages]);
    if (leakErr) return /*#__PURE__*/React.createElement("div", {
      className: "lp-empty"
    }, "Could not load the loop: ", leakErr);
    if (!stages) return /*#__PURE__*/React.createElement("div", {
      className: "lp-empty"
    }, "Loading the loop…");
    if (!stages.length) {
      return /*#__PURE__*/React.createElement("div", {
        className: "lp-empty"
      }, "Not enough history to draw the loop yet. Each stage is judged against its own trailing twelve months, so this needs at least six complete months before it will say anything.");
    }
    const losses = stages.filter(s => Number(s.leak) > 0);
    const biggest = losses.reduce((w, s) => Number(s.leak) > Number(w.leak) ? s : w, losses[0] || stages[0]);
    // most abnormal loss, which is not always the largest one: a big number inside normal
    // variation is not a finding, a smaller one three deviations out is.
    const oddest = losses.reduce((w, s) => Number(s.sigma) < Number(w.sigma) ? s : w, losses[0] || stages[0]);
    const worst = oddest;
    const splitStory = biggest && oddest && biggest.stage !== oddest.stage;
    const gain = stages.filter(s => Number(s.leak) < 0);
    const cutRows = cuts && cuts.filter(c => c.cut_rank === 1);
    const top = cutRows && cutRows.filter(c => !c.is_thin && c.ctc_chg !== null).sort((a, b) => Number(a.ctc_chg) - Number(b.ctc_chg))[0];
    return /*#__PURE__*/React.createElement("div", {
      className: "lp-wrap"
    }, /*#__PURE__*/React.createElement("div", {
      className: "lp-head"
    }, /*#__PURE__*/React.createElement("h2", {
      className: "lp-h"
    }, "Where the month went"), /*#__PURE__*/React.createElement("span", {
      className: "lp-asof"
    }, month, " · each stage against its own twelve month normal")), monthLags && /*#__PURE__*/React.createElement("p", {
      className: "lp-note"
    }, String(month).slice(0, 7), " is the latest month whose site tracking passed Greta's quality checks. Later months are held back because their site analytics data was incomplete (for example, checkout events stopped recording); they appear here automatically once the data is reliable. ", window.__oiNav && /*#__PURE__*/React.createElement("button", {
      type: "button",
      className: "tdy-linkbtn",
      onClick: () => window.__oiNav('settings', 'connections')
    }, "Check connections")), /*#__PURE__*/React.createElement("p", {
      className: "lp-answer"
    }, "The clearest break is ", /*#__PURE__*/React.createElement("b", null, oddest.metric), ", ", Math.abs(Number(oddest.sigma)).toFixed(1), ' ', "standard deviations below its own normal and worth ", /*#__PURE__*/React.createElement("b", null, money(Number(oddest.leak))), top && /*#__PURE__*/React.createElement("span", null, ", concentrated in ", /*#__PURE__*/React.createElement("b", null, top.value === '/' ? 'the home page' : top.value), ' ', "at ", signedPct(Number(top.ctc_chg)), " on the month"), ".", splitStory && /*#__PURE__*/React.createElement("span", null, " ", biggest.metric, " lost more in pounds, ", money(Number(biggest.leak)), ", but at", ' ', Math.abs(Number(biggest.sigma)).toFixed(1), " standard deviations that is ordinary month-to-month variation rather than something that broke."), gain.length > 0 && /*#__PURE__*/React.createElement("span", null, " ", gain.map(g => g.metric).join(' and '), " ran above normal and put", ' ', money(Math.abs(gain.reduce((t, g) => t + Number(g.leak), 0))), " back.")), /*#__PURE__*/React.createElement(LeakRing, {
      stages: stages,
      geometry: geometry
    }), /*#__PURE__*/React.createElement("p", {
      className: "lp-note"
    }, "The pipe enters carrying what this brand would produce with every stage at its own twelve month normal, and narrows at each join. The five figures sum exactly to the difference between that and what the month actually produced, allocated by log contribution so no stage is double counted and the order they are drawn in does not change the answer."), cutRows && cutRows.length > 0 && /*#__PURE__*/React.createElement("div", {
      className: "lp-section"
    }, /*#__PURE__*/React.createElement("h3", {
      className: "lp-h3"
    }, "Which slice of traffic it happened in"), /*#__PURE__*/React.createElement("p", {
      className: "lp-kick"
    }, "A rate that fell by the same amount everywhere is a site-wide change. A rate that fell in one slice and held in the others names its own cause."), /*#__PURE__*/React.createElement(CutStrip, {
      rows: cuts
    })));
  }
  if (typeof window !== 'undefined') {
    window.LoopView = LoopView;
    window.LeakRing = LeakRing;
    // CurvePanel is deliberately NOT exported. Greta already has a live k curve in
    // GretaPlanPanel reading vw_brand_spend_curve, which already abstains when the
    // interval admits no ceiling. Two curves on two views is how a dashboard loses trust.
    // The one genuinely missing piece is k over time (vw_brand_curve_history), which
    // belongs inside that existing panel rather than in a rival screen.
  }
})();

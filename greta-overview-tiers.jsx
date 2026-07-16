// ── Overview tiers (Business → Customer → Channel) ───────────────────────────
// Added 2026-07-14. New first-screen Overview per Dan's IA brief: clear metrics up
// front (three CTC tiers, timeframe toggle, comparison + RAG vs target, per-tier LLM
// read), detail out back. Reads window.FRKL_OVERVIEW[timeframe] once the loader feeds
// it; until then falls back to the live frkl snapshot — but ONLY on brand frkl, so no
// frkl values leak onto other brands (de-frkl rule). Namespaced GO_* to avoid collisions.
const GO_T = { bg:'transparent', panel:'var(--color-panel)', panel2:'var(--color-surface)', line:'var(--color-line)', ink:'var(--color-ink)',
  mut:'var(--color-muted)', dim:'#9a948c', accent:'var(--color-accent)', accent2:'var(--color-accent)', green:'var(--color-success)', amber:'var(--color-warning)', red:'var(--color-danger)',
  mono:'var(--font-mono)' };
const GO_gbp = n => (n==null?'—':'£'+Math.round(n).toLocaleString('en-GB'));
const GO_pctv = n => (n==null?'':(n>0?'+':'')+n.toFixed(1)+'%');
const GO_rag = r => r==='g'?GO_T.green:r==='a'?GO_T.amber:r==='r'?GO_T.red:GO_T.dim;
const GO_arrow = d => d==null?'▬':d>0.5?'▲':d<-0.5?'▼':'▬';
const GO_fmt = (v,f) => f==='gbp'?GO_gbp(v):f==='gbp2'?'£'+(v!=null?v.toFixed(2):'—'):f==='int'?Math.round(v).toLocaleString('en-GB')
  :f==='pct1'?(v!=null?v.toFixed(2)+'%':'—'):f==='x'?(v!=null?v.toFixed(1)+'×':'—'):v;
const GO_TIMEFRAMES = ['daily','weekly','monthly','quarterly','yearly'];

const GO_FALLBACK = { monthly: {
  periodLabel:'14 Jun – 14 Jul 2026', compareLabel:'vs previous 30 days',
  hero:{ cmAfterMkt:6343, cm:12817, cmPct:59.9, spend:6474, targetEstimated:true,
    action:{ value:'£6.3k/mo CM', title:'Restore site conversion to 1.5%', why:'CVR is 0.92% on 39k sessions — a conversion problem, not demand.' } },
  business:[
    { k:'Revenue', v:21398, fmt:'gbp', d:-15.3, cmp:'vs £25,260', rag:'a', tgt:'target ~£24k' },
    { k:'Contribution margin', v:12817, fmt:'gbp', d:-15.3, cmp:'59.9% ratio', rag:'a', tgt:'fit-engine' },
    { k:'Ad spend', v:6474, fmt:'gbp', d:null, cmp:'Meta £5,122 · Google £1,353', rag:'a', tgt:'MER 3.17 · aMER 2.23' },
    { k:'Conversion rate', v:0.92, fmt:'pct1', d:-1, cmp:'vs 0.93%', rag:'r', tgt:'benchmark 1.5%' },
    { k:'Sessions', v:39039, fmt:'int', d:-10.1, cmp:'vs 43,405', rag:'a', tgt:'traffic softening' },
    { k:'AOV', v:60, fmt:'gbp', d:-3.2, cmp:'vs £62', rag:'g', tgt:'steady' },
    { k:'Discounts', v:6545, fmt:'gbp', d:null, cmp:'30.6% of revenue', rag:'r', tgt:'target <20%' },
    { k:'Returns', v:850, fmt:'gbp', d:null, cmp:'4.0% of revenue', rag:'g', tgt:'healthy' },
    { k:'Orders', v:359, fmt:'int', d:-11.4, cmp:'vs 405', rag:'a', tgt:'below pace' },
  ],
  bestSellers:[ {name:'the mega necklace gold',rev:2236},{name:'lower case initial charm',rev:1556},{name:'link up necklace',rev:1516} ],
  customer:{ splitNew:64.8, splitRet:35.2, newRev:14939, retRev:8133, tiles:[
    { k:'New customers', v:167, fmt:'int', cmp:'acquired · 30d', rag:'g' },
    { k:'New CAC', v:40.08, fmt:'gbp2', cmp:'nCAC', rag:'g' },
    { k:'Repeat rate', v:24.3, fmt:'pct1', cmp:'retention thin', rag:'a', tgt:'target 30%+' },
    { k:'LTV : CAC', v:5.4, fmt:'x', cmp:'contribution basis', rag:'g' },
  ]},
  channel:[
    { name:'Facebook acquisition', phi:1.14, spend:5278, rep:1.92, iroas:2.19, tgt:1.23, rag:'g', verdict:'scale headroom' },
    { name:'Google brand', phi:0.27, spend:338, rep:12.73, iroas:3.44, tgt:1.23, rag:'a', verdict:'low incrementality' },
    { name:'Google PMax', phi:0.55, spend:1078, rep:0.36, iroas:0.20, tgt:1.23, rag:'r', verdict:'burning CM' },
    { name:'Google non-brand', phi:null, spend:0, rep:null, iroas:null, tgt:1.23, rag:'n', verdict:'untapped' },
  ],
  insights:{
    business:{ text:'Revenue is down 15% MoM, but so are sessions (−10%) and CVR sits at 0.92% vs a 1.5% benchmark — a traffic-and-conversion problem, not weak demand. Discounts eat 31% of revenue.', action:'Fix the mobile checkout drop before scaling spend.', value:'+£6.3k/mo CM' },
    customer:{ text:'65% of revenue is from new customers at £40 nCAC, but repeat rate is only 24%. You acquire efficiently (5.4× LTV:CAC) yet under-retain.', action:'Turn on the 30-day post-purchase & winback flows.', value:'≈ +£4–6k/mo CM' },
    channel:{ text:'Facebook acquisition runs iROAS 2.19 vs a 1.23 target — over-efficient, i.e. underspending. PMax is underwater at 0.20; google_nonbrand isn\'t running.', action:'Cut PMax → FB acquisition + open non-brand bids.', value:'≈ +£26k/mo CM' },
  },
}};

function GO_Dot(p){ return React.createElement('span',{style:Object.assign({width:7,height:7,borderRadius:'50%',display:'inline-block',background:GO_rag(p.r)},p.style||{})}); }

function GO_Tile(p){ const t=p.t; const _sr=(t.series&&t.series.length>1)?t.series:null;
  const _stroke=t.rag==='r'?'#e96b73':t.rag==='g'?'#4ec98c':'#8B5CF6';
  const _statusTxt=t.rag==='g'?'On track':t.rag==='a'?'Watch':t.rag==='r'?'Off target':'—';
  return (
  <div className="go-tile" style={{background:GO_T.panel,border:'1px solid '+GO_T.line,borderRadius:8,padding:'14px 15px',position:'relative',boxShadow:'var(--shadow-panel)'}}>
    {t.rag && <GO_Dot r={t.rag} style={{position:'absolute',top:12,right:12}}/>}
    <div style={{fontSize:11.5,color:GO_T.mut,display:'flex',alignItems:'center',gap:5}}>{t.k}<span className="go-dot" style={{width:4,height:4,borderRadius:'50%',background:GO_T.accent,display:'inline-block'}}/></div>
    <div style={{fontFamily:GO_T.mono,fontSize:23,fontWeight:600,margin:'8px 0 4px',letterSpacing:'-.5px',fontVariantNumeric:'tabular-nums'}}>{GO_fmt(t.v,t.fmt)}</div>
    <div style={{fontFamily:GO_T.mono,fontSize:11.5,color:t.d>0?GO_T.green:t.d<0?GO_T.red:GO_T.mut}}>{t.d!=null?GO_arrow(t.d)+' '+GO_pctv(Math.abs(t.d)).replace('+','')+' ':''}<span style={{color:GO_T.dim}}>{t.cmp}</span></div>
    {t.tgt && <div style={{fontSize:10.5,color:GO_T.dim,marginTop:5}}>{t.tgt}</div>}
    <div className="go-pop">
      <div className="go-head">{_sr?(t.k+' · trend over selected timeframe'):(t.k+' · detail')}</div>
      {_sr && <R.ResponsiveContainer width="100%" height={92}>
        <R.LineChart data={t.series} margin={{top:4,right:6,left:-6,bottom:0}}>
          <R.CartesianGrid stroke="var(--color-line)" vertical={false}/>
          <R.XAxis dataKey="d" tick={{fill:GO_T.dim,fontSize:8}} interval="preserveStartEnd" tickLine={false} axisLine={false}/>
          <R.YAxis tick={{fill:GO_T.dim,fontSize:8}} width={30} tickFormatter={function(v){return Math.abs(v)>=1000?(v/1000).toFixed(0)+'k':Math.round(v);}}/>
          <R.Tooltip contentStyle={{fontSize:10,background:'var(--color-panel)',border:'1px solid '+GO_T.line,borderRadius:6,padding:'2px 6px'}} labelStyle={{color:GO_T.dim}} formatter={function(v){return [GO_fmt(v,t.fmt),t.k];}}/>
          <R.Line type="monotone" dataKey="v" stroke={_stroke} strokeWidth={2} dot={false} isAnimationActive={false}/>
        </R.LineChart>
      </R.ResponsiveContainer>}
      {t.d!=null && <div className="go-row"><span>Change vs prior</span><b style={{color:t.d>0?GO_T.green:t.d<0?GO_T.red:GO_T.mut}}>{GO_arrow(t.d)+' '+GO_pctv(t.d)}</b></div>}
      {t.cmp && <div className="go-row"><span>Detail</span><b>{t.cmp}</b></div>}
      {t.tgt && <div className="go-row"><span>Target</span><b>{t.tgt}</b></div>}
      <div className="go-row"><span>Status</span><b style={{color:GO_rag(t.rag)}}>{_statusTxt}</b></div>
      <div className="go-ask" onClick={function(e){e.stopPropagation(); if(window.__oiAsk) window.__oiAsk('About "'+t.k+'" (currently '+GO_fmt(t.v,t.fmt)+'): what is driving this over the selected timeframe, and what should I do?');}}>Ask Greta about {t.k} →</div>
    </div>
  </div>); }

function GO_Insight(p){ const i=p.i; return (
  <div style={{background:'var(--color-surface)',border:'1px solid #202742',borderRadius:11,padding:'15px 17px',marginTop:14}}>
    <div style={{display:'flex',alignItems:'center',gap:8,fontSize:11,letterSpacing:'.5px',textTransform:'uppercase',color:GO_T.accent2,marginBottom:6}}>
      <span style={{width:14,height:14,borderRadius:4,background:'linear-gradient(135deg,'+GO_T.accent+',#5563d6)',display:'inline-block'}}/> greta reads this
    </div>
    <p style={{margin:'0 0 8px',fontSize:13,color:'var(--color-ink)'}}>{i.text}</p>
    <div style={{fontSize:12.5,background:'#FBEEE6',border:'1px solid #263056',borderRadius:8,padding:'8px 11px',display:'flex',justifyContent:'space-between',gap:12,alignItems:'center'}}>
      <span>{i.action}</span><b style={{color:GO_T.accent2,fontFamily:GO_T.mono}}>{i.value}</b>
    </div>
  </div>); }

function GO_TierHead(p){ return (
  <div style={{display:'flex',alignItems:'baseline',gap:10,margin:'0 2px 16px'}}>
    <span style={{fontFamily:GO_T.mono,fontSize:11,color:GO_T.accent2,border:'1px solid #2b3050',borderRadius:5,padding:'1px 6px'}}>{p.n}</span>
    <h2 style={{fontSize:15,margin:0,letterSpacing:'.2px'}}>{p.title}</h2>
    <span style={{fontSize:12,color:GO_T.dim}}>{p.sub}</span>
  </div>); }

function GretaOverviewTiers(){
  const [tf,setTf] = React.useState('monthly');
  const [,GO_force] = React.useState(0);
  React.useEffect(function(){ var h=function(){ GO_force(function(x){return x+1;}); };
    window.addEventListener('frkl-overview-updated', h);
    window.addEventListener('frkl-data-updated', h);
    return function(){ window.removeEventListener('frkl-overview-updated', h); window.removeEventListener('frkl-data-updated', h); };
  },[]);
  const isFrkl = (typeof window!=='undefined' && window.OI_BRAND && window.OI_BRAND.slug==='frkl');
  const live = (typeof window!=='undefined' && window.FRKL_OVERVIEW) || null;
  const src = live || (isFrkl ? GO_FALLBACK : null);
  const d = React.useMemo(()=> src ? (src[tf]||src.monthly||null) : null, [src,tf]);

  const wrap = { maxWidth:1180, margin:'0 auto', padding:'8px 4px 60px', background:GO_T.bg, color:GO_T.ink };
  const toggle = (
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:6,marginBottom:6}}>
      <div style={{fontSize:12.5,color:GO_T.dim}}>{d?('Snapshot · '):''}{d && <span style={{fontFamily:GO_T.mono}}>{d.periodLabel}</span>} {d?d.compareLabel:''}</div>
      <div style={{display:'inline-flex',background:GO_T.panel,border:'1px solid '+GO_T.line,borderRadius:9,padding:3}}>
        {GO_TIMEFRAMES.map(x=> <button key={x} onClick={()=>setTf(x)} style={{background:x===tf?GO_T.accent:'none',color:x===tf?'#fff':GO_T.mut,fontWeight:x===tf?600:400,border:0,fontSize:12.5,padding:'6px 12px',borderRadius:6,cursor:'pointer',textTransform:'capitalize'}}>{x}</button>)}
      </div>
    </div>);

  if(!d) return (
    <div style={wrap}>{toggle}
      <div style={{background:GO_T.panel,border:'1px solid '+GO_T.line,borderRadius:12,padding:'26px',textAlign:'center',color:GO_T.mut,marginTop:10}}>
        Overview is loading this brand's live data. Connect Shopify, GA4, Meta, Google &amp; Klaviyo to populate the tiers.
      </div>
    </div>);

  return (
    <div style={wrap}>
      {toggle}
      <div style={{background:'linear-gradient(180deg,'+GO_T.panel+','+GO_T.panel2+')',border:'1px solid '+GO_T.line,borderRadius:14,padding:'20px 24px',margin:'8px 0 6px',display:'flex',justifyContent:'space-between',gap:24,flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:11,letterSpacing:'.6px',textTransform:'uppercase',color:GO_T.dim}}>Contribution after marketing · this period</div>
          <div style={{fontFamily:GO_T.mono,fontSize:38,fontWeight:600,margin:'4px 0 2px',letterSpacing:'-1px'}}>{GO_gbp(d.hero.cmAfterMkt)}</div>
          <div style={{fontSize:12.5,color:GO_T.mut}}>CM {GO_gbp(d.hero.cm)} ({d.hero.cmPct}%) − ad spend {GO_gbp(d.hero.spend)}{d.hero.targetEstimated && <span style={{color:GO_T.amber}}> · target auto-estimated — not yet confirmed</span>}</div>
        {d.hero.opProfit!=null && d.hero.fixedMonthly>0 && <div style={{fontSize:12,marginTop:2,color:(d.hero.opProfit>=0?GO_T.green:GO_T.red)}}>{'Operating profit '+GO_gbp(d.hero.opProfit)+' · after '+GO_gbp(d.hero.fixedMonthly)+'/mo fixed costs'}</div>}
        {d.pacing && <div style={{fontSize:12,marginTop:4,color:(d.pacing.pacePct==null?GO_T.mut:(d.pacing.pacePct>=0?GO_T.green:GO_T.red))}}>{'Pace · '+GO_gbp(d.pacing.revActual)+' of '+GO_gbp(d.pacing.revTarget)+' revenue to date'+(d.pacing.pacePct!=null?(' · '+(d.pacing.pacePct>=0?'+':'')+d.pacing.pacePct+'%'):'')+' · '+(d.pacing.goalConfirmed?'your plan':'auto-estimated')}</div>}
        </div>
        <div style={{minWidth:300,flex:1,background:'var(--color-panel)',border:'1px solid '+GO_T.line,borderLeft:'3px solid '+GO_T.accent,borderRadius:10,padding:'13px 15px'}}>
          <div><span style={{fontSize:10.5,fontFamily:GO_T.mono,letterSpacing:'.5px',color:GO_T.accent2,border:'1px solid #2b3050',borderRadius:5,padding:'1px 6px',marginRight:6}}>DO FIRST</span><span style={{fontSize:10.5,fontFamily:GO_T.mono,letterSpacing:'.5px',color:GO_T.red,border:'1px solid #4a2b2b',borderRadius:5,padding:'1px 6px'}}>{d.hero.action.value}</span></div>
          <h3 style={{margin:'8px 0 5px',fontSize:15}}>{d.hero.action.title}</h3>
          <p style={{margin:0,color:GO_T.mut,fontSize:12.5}}>{d.hero.action.why}</p>
        </div>
      </div>
      <div style={{fontSize:11,color:GO_T.dim,margin:'4px 2px 0'}}>Factual read of synced Shopify · GA4 · Meta · Google · Klaviyo — not a projection. RAG is vs target; arrows vs previous period.</div>

      <div style={{margin:'28px 0 10px'}}>
        <GO_TierHead n="01" title="Business" sub="how the business is performing"/>
        <div style={{display:'grid',gap:12,gridTemplateColumns:'repeat(5,1fr)'}}>
          {d.business.map((t,i)=><GO_Tile key={i} t={t}/>)}
          <div style={{background:'var(--color-surface)',border:'1px solid #202742',borderRadius:11,padding:'14px 15px'}}>
            <div style={{fontSize:11.5,color:GO_T.mut}}>Best sellers →</div>
            <div style={{fontSize:12,color:GO_T.mut,marginTop:6,lineHeight:1.7}}>{d.bestSellers.map((s,i)=><div key={i}>{s.name} · {GO_gbp(s.rev)}</div>)}</div>
          </div>
        </div>
        {d.pacing && d.pacing.days && d.pacing.days.length>0 && <div style={{background:GO_T.panel,border:'1px solid '+GO_T.line,borderRadius:8,padding:'10px 12px 4px',boxShadow:'var(--shadow-panel)',marginTop:10}}><div style={{fontSize:10.5,color:GO_T.dim,textTransform:'uppercase',letterSpacing:'.4px',marginBottom:6}}>Sales &amp; spend vs target</div><R.ResponsiveContainer width="100%" height={200}><R.ComposedChart data={d.pacing.days} margin={{top:5,right:8,left:0,bottom:0}}><R.CartesianGrid strokeDasharray="2 4" stroke="var(--color-line)"/><R.XAxis dataKey="date" tick={{fontSize:9,fill:'var(--color-muted)'}} interval="preserveStartEnd"/><R.YAxis tick={{fontSize:9,fill:'var(--color-muted)'}} width={44} tickFormatter={function(v){return '£'+Math.round(v/1000)+'k';}}/><R.Tooltip formatter={function(v){return '£'+Number(v).toLocaleString('en-GB');}}/><R.Bar dataKey="sales" name="Sales" fill="var(--color-success)" radius={[2,2,0,0]}/><R.Bar dataKey="spend" name="Spend" fill="var(--color-accent)" radius={[2,2,0,0]}/><R.Line dataKey="tSales" name="Target sales" stroke="var(--color-success)" strokeDasharray="4 3" dot={false} strokeWidth={1.5}/><R.Line dataKey="tSpend" name="Target spend" stroke="var(--color-accent)" strokeDasharray="4 3" dot={false} strokeWidth={1.5}/></R.ComposedChart></R.ResponsiveContainer></div>}
        <GO_Insight i={d.insights.business}/>
      </div>

      <div style={{margin:'28px 0 10px'}}>
        <GO_TierHead n="02" title="Customer" sub="returning · new · paid-incremental (CTC)"/>
        <div style={{background:GO_T.panel,border:'1px solid '+GO_T.line,borderRadius:8,padding:'13px 15px',boxShadow:'var(--shadow-panel)',marginBottom:10}}>
          <div style={{fontSize:11,color:GO_T.mut,marginBottom:6}}>New vs returning revenue</div>
          <div style={{display:'flex',height:9,borderRadius:5,overflow:'hidden',marginBottom:6}}><div style={{width:d.customer.splitNew+'%',background:GO_T.accent}}/><div style={{width:d.customer.splitRet+'%',background:'#2563EB'}}/></div>
          <div style={{fontFamily:GO_T.mono,fontSize:11.5}}><span style={{color:GO_T.accent}}>New {d.customer.splitNew}% · {GO_gbp(d.customer.newRev)}</span> &nbsp; <span style={{color:'#2563EB'}}>Ret {d.customer.splitRet}% · {GO_gbp(d.customer.retRev)}</span></div>
        </div>
        {(d.customer.rows||[]).map(function(row,ri){return (
          <div key={ri} style={{display:'flex',alignItems:'stretch',gap:10,marginBottom:8,flexWrap:'wrap'}}>
            <div style={{minWidth:120,display:'flex',alignItems:'center',gap:7,fontSize:12.5,fontWeight:600}}><GO_Dot r={row.rag}/> {row.label}</div>
            <div style={{flex:1,display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(115px,1fr))',gap:8}}>
              {row.cells.map(function(c,ci){return <div key={ci} style={{background:GO_T.panel,border:'1px solid '+GO_T.line,borderRadius:8,padding:'8px 11px',boxShadow:'var(--shadow-panel)'}}><div style={{fontSize:10.5,color:GO_T.mut}}>{c.k}</div><div style={{fontFamily:GO_T.mono,fontSize:15,fontWeight:600,marginTop:1}}>{c.v}</div></div>;})}
            </div>
          </div>);})}
                {d.cacBlock && (function(){ var C=d.cacBlock;
          var g2=function(x){return x==null?"—":"£"+Number(x).toFixed(2);};
          var rx=function(x){return x==null?"—":Number(x).toFixed(2)+"×";};
          var col=C.rag==="g"?GO_T.green:C.rag==="a"?GO_T.amber:C.rag==="r"?GO_T.red:GO_T.dim;
          var cell=function(k,v,sub,hi){return <div style={{background:GO_T.panel,border:"1px solid "+(hi||GO_T.line),borderRadius:8,padding:"9px 11px",boxShadow:"var(--shadow-panel)"}}><div style={{fontSize:10.5,color:GO_T.mut}}>{k}</div><div style={{fontFamily:GO_T.mono,fontSize:16,fontWeight:600,marginTop:2}}>{v}</div><div style={{fontSize:10,color:GO_T.dim}}>{sub}</div></div>;};
          var ltvSub=C.opc.toFixed(2)+" orders/cust"+(C.repeatPct!=null?" · "+C.repeatPct+"% repeat":"");
          var tgtSub=C.goalConfirmed?"from your goal":"profit-safe default";
          return <div style={{marginTop:2,marginBottom:6}}>
            <div style={{fontSize:10.5,color:GO_T.dim,textTransform:"uppercase",letterSpacing:".4px",margin:"0 2px 6px"}}>Acquisition efficiency · break-even &amp; optimal</div>
            <div style={{fontSize:10.5,color:GO_T.mut,margin:"0 2px 4px"}}>CAC — most you can pay per new customer</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:8,marginBottom:9}}>
              {cell("Actual CAC (paid)",g2(C.cac.actual),"spend ÷ new custs",col)}
              {cell("Break-even · 1st order",g2(C.cac.first),"CM-positive on order 1")}
              {cell("Break-even · lifetime",g2(C.cac.ltv),ltvSub)}
              {cell("Target / optimal CAC",g2(C.cac.target),tgtSub)}
            </div>
            <div style={{fontSize:10.5,color:GO_T.mut,margin:"0 2px 4px"}}>ROAS — least you can accept (aMER)</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(150px,1fr))",gap:8}}>
              {cell("Actual ROAS (aMER)",rx(C.roas.actual),"new rev ÷ spend",col)}
              {cell("Break-even · 1st order",rx(C.roas.first),"= 1 ÷ contribution")}
              {cell("Break-even · lifetime",rx(C.roas.ltv),"LTV-adjusted floor")}
              {cell("Target / optimal ROAS",rx(C.roas.target),tgtSub)}
            </div>
            <div style={{fontSize:11.5,color:col,marginTop:7,display:"flex",gap:6,alignItems:"baseline"}}><GO_Dot r={C.rag} style={{marginTop:4}}/> <span>{C.verdict}</span></div>
          </div>; })()}
        <GO_Insight i={d.insights.customer}/>
      </div>

      <div style={{margin:'28px 0 10px'}}>
        <GO_TierHead n="03" title="Channel" sub="avg vs marginal iROAS — where the next £ goes (CTC)"/>
        <div style={{background:GO_T.panel,border:'1px solid '+GO_T.line,borderRadius:11,padding:'2px 4px',overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
            <thead><tr>{['Channel','Spend','Incr rev','AOV','iCPA','iROAS','Marginal','Verdict'].map((h,i)=><th key={i} style={{textAlign:i===0?'left':'right',color:GO_T.dim,fontWeight:500,fontSize:10.5,textTransform:'uppercase',letterSpacing:'.4px',padding:'8px 9px',borderBottom:'1px solid '+GO_T.line}}>{h}</th>)}</tr></thead>
            <tbody>{d.channel.map((c,i)=>(
              <tr key={i} style={{background:c.family==='email'?'var(--color-surface)':'none'}}>
                <td style={{textAlign:'left',padding:'8px 9px',borderBottom:'1px solid '+GO_T.line}}>{c.name} <span style={{fontSize:10.5,color:c.family==='email'?GO_T.accent2:GO_T.mut}}>{c.family==='email'?'email':(c.acquisition?'acq':'retn')}{c.phi!=null?' · φ'+c.phi:''}</span></td>
                <td style={{textAlign:'right',fontFamily:GO_T.mono,padding:'8px 9px',borderBottom:'1px solid '+GO_T.line}}>{GO_gbp(c.spend)}</td>
                <td style={{textAlign:'right',fontFamily:GO_T.mono,padding:'8px 9px',borderBottom:'1px solid '+GO_T.line}}>{GO_gbp(c.incRev)}</td>
                <td style={{textAlign:'right',fontFamily:GO_T.mono,padding:'8px 9px',borderBottom:'1px solid '+GO_T.line}}>{c.aov!=null?GO_gbp(c.aov):'—'}</td>
                <td style={{textAlign:'right',fontFamily:GO_T.mono,padding:'8px 9px',borderBottom:'1px solid '+GO_T.line}}>{c.icpa!=null?GO_gbp(c.icpa):'—'}</td>
                <td style={{textAlign:'right',fontFamily:GO_T.mono,color:c.rag==='r'?GO_T.red:c.rag==='g'?GO_T.green:GO_T.ink,padding:'8px 9px',borderBottom:'1px solid '+GO_T.line}}>{c.iroas!=null?c.iroas.toFixed(2)+'×':'—'}</td>
                <td style={{textAlign:'right',fontFamily:GO_T.mono,color:c.marginal!=null?(c.marginal>=c.tgt?GO_T.green:GO_T.amber):GO_T.dim,padding:'8px 9px',borderBottom:'1px solid '+GO_T.line}}>{c.marginal!=null?c.marginal.toFixed(2)+'×':'—'}</td>
                <td style={{textAlign:'right',fontSize:11.5,padding:'8px 9px',borderBottom:'1px solid '+GO_T.line}}><GO_Dot r={c.rag}/> {c.verdict}</td>
              </tr>))}</tbody>
          </table>
        </div>
        {d.emailBlock && (function () { var E = d.emailBlock; var cell = function (k, v, sub) { return <div style={{ background: GO_T.panel, border: '1px solid ' + GO_T.line, borderRadius: 8, padding: '9px 11px', boxShadow: 'var(--shadow-panel)' }}><div style={{ fontSize: 10.5, color: GO_T.mut }}>{k}</div><div style={{ fontFamily: GO_T.mono, fontSize: 16, fontWeight: 600, marginTop: 2 }}>{v}</div><div style={{ fontSize: 10, color: GO_T.dim }}>{sub}</div></div>; }; return <div style={{ marginTop: 10 }}><div style={{ fontSize: 10.5, color: GO_T.dim, textTransform: 'uppercase', letterSpacing: '.4px', margin: '0 2px 6px' }}>Email breakdown · Klaviyo</div><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(130px,1fr))', gap: 8 }}>{cell('Email revenue', GO_gbp(E.total_rev), E.total_orders + ' orders')}{cell('Campaign rev', GO_gbp(E.campaign_rev), E.campaign_orders + ' orders')}{cell('Flow rev', GO_gbp(E.flow_rev), E.flow_orders + ' orders')}{cell('Rev / 1k sent', GO_gbp(E.rev_per_1k_sent), Math.round(E.total_sends / 1000) + 'k sent')}</div></div>; })()}
        <GO_Insight i={d.insights.channel}/>
      </div>
    </div>);
}


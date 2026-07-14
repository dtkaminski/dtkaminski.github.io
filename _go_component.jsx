// ── Overview tiers (Business → Customer → Channel) ───────────────────────────
// Added 2026-07-14. New first-screen Overview per Dan's IA brief: clear metrics up
// front (three CTC tiers, timeframe toggle, comparison + RAG vs target, per-tier LLM
// read), detail out back. Reads window.FRKL_OVERVIEW[timeframe] once the loader feeds
// it; until then falls back to the live frkl snapshot — but ONLY on brand frkl, so no
// frkl values leak onto other brands (de-frkl rule). Namespaced GO_* to avoid collisions.
const GO_T = { bg:'#0b0d12', panel:'#14161c', panel2:'#181b23', line:'#232733', ink:'#e8eaf0',
  mut:'#8b93a7', dim:'#5b6479', accent:'#7c8cff', accent2:'#a6b0ff', green:'#3fbf87', amber:'#e0a53d', red:'#e5644e',
  mono:'"SF Mono",ui-monospace,"JetBrains Mono",Menlo,Consolas,monospace' };
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

function GO_Tile(p){ const t=p.t; return (
  <div style={{background:GO_T.panel,border:'1px solid '+GO_T.line,borderRadius:11,padding:'12px 13px',position:'relative'}}>
    {t.rag && <GO_Dot r={t.rag} style={{position:'absolute',top:12,right:12}}/>}
    <div style={{fontSize:11.5,color:GO_T.mut}}>{t.k}</div>
    <div style={{fontFamily:GO_T.mono,fontSize:23,fontWeight:600,margin:'6px 0 3px',letterSpacing:'-.5px',fontVariantNumeric:'tabular-nums'}}>{GO_fmt(t.v,t.fmt)}</div>
    <div style={{fontFamily:GO_T.mono,fontSize:11.5,color:t.d>0?GO_T.green:t.d<0?GO_T.red:GO_T.mut}}>{t.d!=null?GO_arrow(t.d)+' '+GO_pctv(Math.abs(t.d)).replace('+','')+' ':''}<span style={{color:GO_T.dim}}>{t.cmp}</span></div>
    {t.tgt && <div style={{fontSize:10.5,color:GO_T.dim,marginTop:4}}>{t.tgt}</div>}
  </div>); }

function GO_Insight(p){ const i=p.i; return (
  <div style={{background:'#0f1420',border:'1px solid #202742',borderRadius:11,padding:'13px 15px',marginTop:11}}>
    <div style={{display:'flex',alignItems:'center',gap:8,fontSize:11,letterSpacing:'.5px',textTransform:'uppercase',color:GO_T.accent2,marginBottom:6}}>
      <span style={{width:14,height:14,borderRadius:4,background:'linear-gradient(135deg,'+GO_T.accent+',#5563d6)',display:'inline-block'}}/> greta reads this
    </div>
    <p style={{margin:'0 0 8px',fontSize:13,color:'#c9cee0'}}>{i.text}</p>
    <div style={{fontSize:12.5,background:'#141a2b',border:'1px solid #263056',borderRadius:8,padding:'8px 11px',display:'flex',justifyContent:'space-between',gap:12,alignItems:'center'}}>
      <span>{i.action}</span><b style={{color:GO_T.accent2,fontFamily:GO_T.mono}}>{i.value}</b>
    </div>
  </div>); }

function GO_TierHead(p){ return (
  <div style={{display:'flex',alignItems:'baseline',gap:10,margin:'0 2px 12px'}}>
    <span style={{fontFamily:GO_T.mono,fontSize:11,color:GO_T.accent2,border:'1px solid #2b3050',borderRadius:5,padding:'1px 6px'}}>{p.n}</span>
    <h2 style={{fontSize:15,margin:0,letterSpacing:'.2px'}}>{p.title}</h2>
    <span style={{fontSize:12,color:GO_T.dim}}>{p.sub}</span>
  </div>); }

function GretaOverviewTiers(){
  const [tf,setTf] = React.useState('monthly');
  const isFrkl = (typeof window!=='undefined' && window.OI_BRAND && window.OI_BRAND.slug==='frkl');
  const live = (typeof window!=='undefined' && window.FRKL_OVERVIEW) || null;
  const src = live || (isFrkl ? GO_FALLBACK : null);
  const d = React.useMemo(()=> src ? (src[tf]||src.monthly||null) : null, [src,tf]);

  const wrap = { maxWidth:1180, margin:'0 auto', padding:'8px 4px 60px', background:GO_T.bg, color:GO_T.ink };
  const toggle = (
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginTop:6,marginBottom:6}}>
      <div style={{fontSize:12.5,color:GO_T.dim}}>{d?('Snapshot · '):''}{d && <span style={{fontFamily:GO_T.mono}}>{d.periodLabel}</span>} {d?d.compareLabel:''}</div>
      <div style={{display:'inline-flex',background:GO_T.panel,border:'1px solid '+GO_T.line,borderRadius:9,padding:3}}>
        {GO_TIMEFRAMES.map(x=> <button key={x} onClick={()=>setTf(x)} style={{background:x===tf?GO_T.accent:'none',color:x===tf?'#0b0d12':GO_T.mut,fontWeight:x===tf?600:400,border:0,fontSize:12.5,padding:'6px 12px',borderRadius:6,cursor:'pointer',textTransform:'capitalize'}}>{x}</button>)}
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
      <div style={{background:'linear-gradient(180deg,'+GO_T.panel+','+GO_T.panel2+')',border:'1px solid '+GO_T.line,borderRadius:14,padding:'18px 20px',margin:'8px 0 6px',display:'flex',justifyContent:'space-between',gap:24,flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:11,letterSpacing:'.6px',textTransform:'uppercase',color:GO_T.dim}}>Contribution after marketing · this period</div>
          <div style={{fontFamily:GO_T.mono,fontSize:38,fontWeight:600,margin:'4px 0 2px',letterSpacing:'-1px'}}>{GO_gbp(d.hero.cmAfterMkt)}</div>
          <div style={{fontSize:12.5,color:GO_T.mut}}>CM {GO_gbp(d.hero.cm)} ({d.hero.cmPct}%) − ad spend {GO_gbp(d.hero.spend)}{d.hero.targetEstimated && <span style={{color:GO_T.amber}}> · target auto-estimated — not yet confirmed</span>}</div>
        </div>
        <div style={{minWidth:300,flex:1,background:'#101219',border:'1px solid '+GO_T.line,borderLeft:'3px solid '+GO_T.accent,borderRadius:10,padding:'13px 15px'}}>
          <div><span style={{fontSize:10.5,fontFamily:GO_T.mono,letterSpacing:'.5px',color:GO_T.accent2,border:'1px solid #2b3050',borderRadius:5,padding:'1px 6px',marginRight:6}}>DO FIRST</span><span style={{fontSize:10.5,fontFamily:GO_T.mono,letterSpacing:'.5px',color:GO_T.red,border:'1px solid #4a2b2b',borderRadius:5,padding:'1px 6px'}}>{d.hero.action.value}</span></div>
          <h3 style={{margin:'8px 0 5px',fontSize:15}}>{d.hero.action.title}</h3>
          <p style={{margin:0,color:GO_T.mut,fontSize:12.5}}>{d.hero.action.why}</p>
        </div>
      </div>
      <div style={{fontSize:11,color:GO_T.dim,margin:'4px 2px 0'}}>Factual read of synced Shopify · GA4 · Meta · Google · Klaviyo — not a projection. RAG is vs target; arrows vs previous period.</div>

      <div style={{margin:'22px 0 8px'}}>
        <GO_TierHead n="01" title="Business" sub="how the business is performing"/>
        <div style={{display:'grid',gap:10,gridTemplateColumns:'repeat(5,1fr)'}}>
          {d.business.map((t,i)=><GO_Tile key={i} t={t}/>)}
          <div style={{background:'#0f1420',border:'1px solid #202742',borderRadius:11,padding:'12px 13px'}}>
            <div style={{fontSize:11.5,color:GO_T.mut}}>Best sellers →</div>
            <div style={{fontSize:12,color:GO_T.mut,marginTop:6,lineHeight:1.7}}>{d.bestSellers.map((s,i)=><div key={i}>{s.name} · {GO_gbp(s.rev)}</div>)}</div>
          </div>
        </div>
        <GO_Insight i={d.insights.business}/>
      </div>

      <div style={{margin:'22px 0 8px'}}>
        <GO_TierHead n="02" title="Customer" sub="who is buying — new vs returning"/>
        <div style={{display:'grid',gap:10,gridTemplateColumns:'repeat(5,1fr)'}}>
          <div style={{background:GO_T.panel,border:'1px solid '+GO_T.line,borderRadius:11,padding:'12px 13px'}}>
            <div style={{fontSize:11.5,color:GO_T.mut}}>New vs returning revenue</div>
            <div style={{display:'flex',height:9,borderRadius:5,overflow:'hidden',margin:'10px 0 7px'}}><div style={{width:d.customer.splitNew+'%',background:GO_T.accent}}/><div style={{width:d.customer.splitRet+'%',background:'#38406e'}}/></div>
            <div style={{fontFamily:GO_T.mono,fontSize:11.5}}><span style={{color:GO_T.accent2}}>New {d.customer.splitNew}% · {GO_gbp(d.customer.newRev)}</span> <span style={{color:GO_T.mut}}>Ret {d.customer.splitRet}% · {GO_gbp(d.customer.retRev)}</span></div>
          </div>
          {d.customer.tiles.map((t,i)=><GO_Tile key={i} t={t}/>)}
        </div>
        <GO_Insight i={d.insights.customer}/>
      </div>

      <div style={{margin:'22px 0 8px'}}>
        <GO_TierHead n="03" title="Channel" sub="true efficiency — iROAS vs target (CTC)"/>
        <div style={{background:GO_T.panel,border:'1px solid '+GO_T.line,borderRadius:11,padding:'2px 4px',overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12.5}}>
            <thead><tr>{['Channel','Spend 30d','Reported ROAS','iROAS (φ-adj)','Target','Verdict'].map((h,i)=><th key={i} style={{textAlign:i===0?'left':'right',color:GO_T.dim,fontWeight:500,fontSize:11,textTransform:'uppercase',letterSpacing:'.4px',padding:'9px 10px',borderBottom:'1px solid '+GO_T.line}}>{h}</th>)}</tr></thead>
            <tbody>{d.channel.map((c,i)=>(
              <tr key={i}>
                <td style={{textAlign:'left',padding:'9px 10px',borderBottom:'1px solid '+GO_T.line}}>{c.name} <span style={{fontSize:11,color:GO_T.mut}}>{c.phi!=null?'φ '+c.phi:'not running'}</span></td>
                <td style={{textAlign:'right',fontFamily:GO_T.mono,padding:'9px 10px',borderBottom:'1px solid '+GO_T.line}}>{GO_gbp(c.spend)}</td>
                <td style={{textAlign:'right',fontFamily:GO_T.mono,padding:'9px 10px',borderBottom:'1px solid '+GO_T.line}}>{c.rep!=null?c.rep.toFixed(2)+'×':'—'}</td>
                <td style={{textAlign:'right',fontFamily:GO_T.mono,color:c.rag==='r'?GO_T.red:c.rag==='g'?GO_T.green:GO_T.ink,padding:'9px 10px',borderBottom:'1px solid '+GO_T.line}}>{c.iroas!=null?c.iroas.toFixed(2)+'×':'—'}</td>
                <td style={{textAlign:'right',fontFamily:GO_T.mono,padding:'9px 10px',borderBottom:'1px solid '+GO_T.line}}>{c.tgt.toFixed(2)}×</td>
                <td style={{textAlign:'right',padding:'9px 10px',borderBottom:'1px solid '+GO_T.line}}><GO_Dot r={c.rag}/> {c.verdict}</td>
              </tr>))}</tbody>
          </table>
        </div>
        <GO_Insight i={d.insights.channel}/>
      </div>
    </div>);
}

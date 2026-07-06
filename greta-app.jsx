
const { useState, useMemo } = React;
const R = Recharts;
const D = window.FRKL_DATA;
const _CUR_SYM = { GBP:'£', USD:'$', EUR:'€', AUD:'A$', CAD:'C$', NZD:'NZ$', JPY:'¥' };
const curSym = () => _CUR_SYM[(typeof window!=='undefined' && window.OI_CURRENCY)] || '£';
const GBP = n => n==null ? '—' : curSym() + Math.round(n).toLocaleString('en-GB');
const GBP2 = n => n==null ? '—' : curSym() + n.toLocaleString('en-GB',{minimumFractionDigits:0,maximumFractionDigits:0});
const PCT = n => n==null ? '—' : (n*100).toFixed(1) + '%';
const NUM = n => n==null ? '—' : Math.round(n).toLocaleString('en-GB');

// ── Cost config & margin confidence ─────────────────────────────────────────
// Every margin-derived number (gross margin, contribution, CAC payback, LTV:CAC,
// break-even ROAS) is only as good as the costs behind it. Until the operator
// confirms their real costs, those numbers are ESTIMATES and must be labelled as
// such. Config lives in localStorage (frkl-contrib-inputs) — the same store the
// Contribution card already uses — extended with a gross-margin % and a verified
// flag. (Per-tenant server-side persistence is the v2; local-first today.)
const COST_DEFAULTS = {gmPct:'', packaging:'0.50', fulfilment:'2.00', shipping:'3.50', payPct:'1.5', payFixed:'0.25', refundPct:'7.4'};
function costConfig(){
  try { return {...COST_DEFAULTS, ...(JSON.parse(localStorage.getItem('frkl-contrib-inputs')||'{}'))}; }
  catch(e){ return {...COST_DEFAULTS}; }
}
function marginVerified(){ const c = costConfig(); return c.verified===true || c.verified==='true'; }
function saveCostConfig(next){ try { localStorage.setItem('frkl-contrib-inputs', JSON.stringify(next)); window.dispatchEvent(new Event('oi-costs-updated')); } catch(e){} }
// User-entered gross margin (fraction) when present, else null → callers fall
// back to OI_CONFIG.grossMargin or the live catalogue margin.
function userGrossMargin(){ const c = costConfig(); const v = parseFloat(c.gmPct); return (c.gmPct!=='' && c.gmPct!=null && isFinite(v)) ? v/100 : null; }

// ── Supplier lead times (for restock alerts) ─────────────────────────────────
// Days between placing a reorder and stock landing. Drives the reorder-by date
// and the urgency bands (a slow-to-restock SKU needs ordering far earlier than a
// fast one at the same days-of-cover). Editable per product type; defaults are
// estimates until the operator confirms them. localStorage-first like cost config.
const LEAD_DEFAULTS = { default: 30, byType: { Charm: 14, Necklace: 42, Bracelet: 42, Earring: 21 } };
function leadConfig(){
  try {
    const s = JSON.parse(localStorage.getItem('oi_lead_times') || 'null');
    if(s && typeof s==='object') return { default: s.default!=null?s.default:LEAD_DEFAULTS.default, byType: {...(s.byType||{})} };
  } catch(e){}
  return { default: LEAD_DEFAULTS.default, byType: {...LEAD_DEFAULTS.byType} };
}
function saveLeadConfig(next){ try { localStorage.setItem('oi_lead_times', JSON.stringify(next)); window.dispatchEvent(new Event('oi-leadtimes-updated')); } catch(e){} }

// ── Cash position (for the runway card) ──────────────────────────────────────
// Cash on hand + monthly overheads (salaries/rent/tools — NOT ad spend or COGS,
// which the run-rate already captures). localStorage-first like cost config;
// reuses the 'oi-costs-updated' event so subscribed cards refresh on save.
function cashConfig(){
  try { const s = JSON.parse(localStorage.getItem('oi_cash_v1')||'null'); if(s && typeof s==='object') return {cash:s.cash!=null?s.cash:'', overheads:s.overheads!=null?s.overheads:'', adSpend:s.adSpend!=null?s.adSpend:''}; } catch(e){}
  return {cash:'', overheads:'', adSpend:''};
}
function saveCashConfig(next){ try { localStorage.setItem('oi_cash_v1', JSON.stringify(next)); window.dispatchEvent(new Event('oi-costs-updated')); } catch(e){} }

// ── Supplier / MOQ / unit-cost (per product type) + reorder policy ───────────
// Powers the Production / PO planner. Lead time comes from leadConfig (per type);
// supplier name, MOQ and a unit-cost override live here. Inventory types are
// granular ("Necklace stack") so leadDaysForType matches the lead-time category
// by substring (a "Necklace stack" inherits the "Necklace" lead time).
function leadDaysForType(type){
  const cfg = leadConfig();
  if(type){ for(const key of Object.keys(cfg.byType)){ const ov=cfg.byType[key]; if(ov!=null && ov!=='' && isFinite(Number(ov)) && String(type).toLowerCase().includes(key.toLowerCase())) return Number(ov); } }
  const d = Number(cfg.default); return isFinite(d)&&d>0?d:30;
}
function supplierConfig(){ try { const s=JSON.parse(localStorage.getItem('oi_supplier_v1')||'null'); if(s && s.byType) return {byType:{...s.byType}}; } catch(e){} return {byType:{}}; }
function saveSupplierConfig(next){ try { localStorage.setItem('oi_supplier_v1', JSON.stringify(next)); window.dispatchEvent(new Event('oi-supplier-updated')); } catch(e){} }
function supplierFor(type){ const c=supplierConfig(); return (c.byType && c.byType[type]) || {}; }
// ── SKU-level supplier master data — built up over time, one SKU at a time ────
// Keyed by SKU (or title). {supplier, email, notes, moq, unitCost, lead}. This is
// the source of truth for raising POs to the right manufacturer per product.
function skuKeyOf(p){ return (p && (p.sku || p.title)) || ''; }
function skuSupplierAll(){ try { const s=JSON.parse(localStorage.getItem('oi_supplier_sku_v1')||'{}'); return (s&&typeof s==='object')?s:{}; } catch(e){ return {}; } }
function saveSkuSupplierAll(all){ try { localStorage.setItem('oi_supplier_sku_v1', JSON.stringify(all)); window.dispatchEvent(new Event('oi-supplier-updated')); } catch(e){} }
// Add a quoted unit price to a SKU later (supplier quotes off the PO).
function setSkuPrice(key, v){ const all=skuSupplierAll(); const cur=all[key]||{}; all[key]={...cur, unitCost:(v===''||v==null)?'':Number(v)}; saveSkuSupplierAll(all); }
// Set a SKU's production lead (order→shipment, days) inline. Blank → falls back to the type default.
function setSkuLead(key, v){ const all=skuSupplierAll(); const cur=all[key]||{}; all[key]={...cur, lead:(v===''||v==null)?'':Number(v)}; saveSkuSupplierAll(all); }
function supplierForSku(p){ const r = skuSupplierAll()[skuKeyOf(p)]; return r || {}; }
function skuHasSupplier(p){ const r = skuSupplierAll()[skuKeyOf(p)]; return !!(r && r.supplier && String(r.supplier).trim()); }
// ── Supplier directory — tracked suppliers keyed by name; SKUs reference by name,
// full contact details live here and resolve onto POs. Add a name anywhere and it
// becomes a tracked supplier you can flesh out on the Suppliers tab. ───────────
function suppliersAll(){ try { const s=JSON.parse(localStorage.getItem('oi_suppliers_v1')||'{}'); return (s&&typeof s==='object')?s:{}; } catch(e){ return {}; } }
function saveSuppliersAll(all){ try { localStorage.setItem('oi_suppliers_v1', JSON.stringify(all)); window.dispatchEvent(new Event('oi-supplier-updated')); } catch(e){} }
function registerSupplier(name){ name=(name||'').trim(); if(!name) return; const all=suppliersAll(); if(!all[name]){ all[name]={name, email:'', phone:'', address:'', notes:''}; saveSuppliersAll(all); } }
function supplierContact(name){ name=(name||'').trim(); return (name && suppliersAll()[name]) || {}; }
// Every supplier name in use: the directory + any names referenced by SKU master.
function supplierNamesInUse(){ const set=new Set(Object.keys(suppliersAll())); const sk=skuSupplierAll(); Object.keys(sk).forEach(k=>{ const n=sk[k]&&sk[k].supplier&&String(sk[k].supplier).trim(); if(n) set.add(n); }); return [...set].sort((a,b)=>a.localeCompare(b)); }
// ── Delist — products that won't be reordered; hidden from the plan + POs ─────
function delistAll(){ try { const s=JSON.parse(localStorage.getItem('oi_delist_v1')||'{}'); return (s&&typeof s==='object')?s:{}; } catch(e){ return {}; } }
function isDelisted(p){ return !!delistAll()[skuKeyOf(p)]; }
function setDelisted(key, on){ const all=delistAll(); if(on) all[key]=true; else delete all[key]; try { localStorage.setItem('oi_delist_v1', JSON.stringify(all)); window.dispatchEvent(new Event('oi-supplier-updated')); } catch(e){} }
const REORDER_DEFAULTS = {safetyDays:14, coverDays:45, strategy:'jit', waves:3, depositPct:100, shipDays:0};
const STRAT_SHORT = {jit:'JIT', bulk:'Bulk', staged:'Staged'};
function reorderConfig(){ try { const s=JSON.parse(localStorage.getItem('oi_reorder_v1')||'null'); if(s) return {...REORDER_DEFAULTS, ...s}; } catch(e){} return {...REORDER_DEFAULTS}; }
function saveReorderConfig(next){ try { localStorage.setItem('oi_reorder_v1', JSON.stringify(next)); window.dispatchEvent(new Event('oi-supplier-updated')); } catch(e){} }
// Per-wave demand split for Staged ordering. rc.waveSplit holds relative weights;
// blank or a length that no longer matches the wave count → an even split. Returns a
// normalized array (length = waves, sums to 1) so Wave 1 can be front-loaded for peak.
function waveWeights(rc, waves){ waves=Math.max(1,Math.round(waves||1));
  let raw = Array.isArray(rc&&rc.waveSplit) ? rc.waveSplit.map(Number).filter(x=>isFinite(x)&&x>0) : [];
  if(raw.length!==waves) raw = Array.from({length:waves}, ()=>1);
  const sum = raw.reduce((t,x)=>t+x,0)||waves; return raw.map(x=>x/sum); }
function wavePreset(kind, waves){ waves=Math.max(1,Math.round(waves||1));
  const arr=Array.from({length:waves},(_,i)=> kind==='front'?(waves-i):kind==='back'?(i+1):1);
  const sum=arr.reduce((t,x)=>t+x,0)||waves; return arr.map(x=>x/sum); }
function wavePresetName(weights){ const n=weights.length; if(n<2) return 'even';
  if(weights.every(w=>Math.abs(w-1/n)<0.02)) return 'even';
  const m=(a,b)=>a.every((x,i)=>Math.abs(x-b[i])<0.02);
  if(m(weights,wavePreset('front',n))) return 'front'; if(m(weights,wavePreset('back',n))) return 'back'; return 'custom'; }
function usePlanningTick(){ const [,f]=React.useState(0); React.useEffect(()=>{ const h=()=>f(x=>x+1); ['oi-supplier-updated','oi-leadtimes-updated','oi-costs-updated','oi-forecast-updated','oi-po-updated'].forEach(ev=>window.addEventListener(ev,h)); return ()=>['oi-supplier-updated','oi-leadtimes-updated','oi-costs-updated','oi-forecast-updated','oi-po-updated'].forEach(ev=>window.removeEventListener(ev,h)); }, []); return 0; }

// ── Demand-plan + packaging BOM (for the Forecast & demand planner) ───────────
const DEMAND_DEFAULTS = {months:3, growth:0, targetMode:'growth', targetValue:'', shape:'even', startMonth:'', monthly:[], focus:[]};
function demandConfig(){ try { const s=JSON.parse(localStorage.getItem('oi_demandplan_v1')||'null'); if(s) return {...DEMAND_DEFAULTS, ...s, monthly:Array.isArray(s.monthly)?s.monthly:[], focus:Array.isArray(s.focus)?s.focus:[]}; } catch(e){} return {...DEMAND_DEFAULTS}; }
// Product-focus / promotion weight for a product over the horizon: multiply
// matching focus entries. Entry = {key:'type:X'|'product:SKU'|'all', mult, label,
// month}. month '' = whole horizon; a month index applies the uplift to just that
// 1-of-`months` slice, so the effective horizon-average weight is diluted.
function focusMultFor(p, focus, months){
  if(!Array.isArray(focus) || !focus.length || !p) return 1;
  const M = Math.max(1, months||1);
  const pid = 'product:'+(p.sku||p.title), tid = 'type:'+(p.type||'');
  let m = 1;
  focus.forEach(f=>{ const mult=Number(f.mult); if(!(mult>0)) return;
    if(!(f.key===pid || f.key===tid || f.key==='all')) return;
    if(f.month==='' || f.month==null) m*=mult;                 // whole horizon
    else m *= ((M-1) + mult)/M;                                 // one month of M
  });
  return m;
}
// Month label N steps on from a YYYY-MM start (browser Date is fine here).
function oiMonthLabel(startYYYYMM, i){ try { let y,m; if(/^\d{4}-\d{2}$/.test(startYYYYMM||'')){ y=+startYYYYMM.slice(0,4); m=+startYYYYMM.slice(5,7)-1; } else { const d=new Date(); y=d.getFullYear(); m=d.getMonth(); } const d=new Date(y, m+i, 1); return d.toLocaleString('en-GB',{month:'short', year:'2-digit'}); } catch(e){ return 'M'+(i+1); } }
function saveDemandConfig(next){ try { localStorage.setItem('oi_demandplan_v1', JSON.stringify(next)); window.dispatchEvent(new Event('oi-forecast-updated')); } catch(e){} }
const PACK_DEFAULTS = { avgItemsPerOrder:1.3, components:[ {name:'Mailer / box',perItem:0,perOrder:1}, {name:'Pouch / bag',perItem:1,perOrder:0}, {name:'Thank-you card',perItem:0,perOrder:1}, {name:'Sticker / seal',perItem:0,perOrder:1} ] };
// Each component carries its BOM (perItem/perOrder) and — when the operator wants
// packaging reorder POs — stock-on-hand + supplier/MOQ/cost/lead. onHand blank =
// "not tracked" → no packaging PO is raised for it.
function _packComp(c){ return {name:c.name||'', perItem:c.perItem!=null?c.perItem:0, perOrder:c.perOrder!=null?c.perOrder:0, onHand:c.onHand!=null?c.onHand:'', supplier:c.supplier||'', moq:c.moq!=null?c.moq:'', unitCost:c.unitCost!=null?c.unitCost:'', leadDays:c.leadDays!=null?c.leadDays:30}; }
function packagingConfig(){ try { const s=JSON.parse(localStorage.getItem('oi_packaging_v1')||'null'); if(s && Array.isArray(s.components)) return {avgItemsPerOrder:s.avgItemsPerOrder!=null?s.avgItemsPerOrder:1.3, components:s.components.map(_packComp)}; } catch(e){} return {avgItemsPerOrder:PACK_DEFAULTS.avgItemsPerOrder, components:PACK_DEFAULTS.components.map(_packComp)}; }
function savePackagingConfig(next){ try { localStorage.setItem('oi_packaging_v1', JSON.stringify(next)); window.dispatchEvent(new Event('oi-forecast-updated')); } catch(e){} }
// The forecast multiplier the demand plan applies to each product's run-rate.
// Reads the SAVED plan (demandConfig) so the PO planner sizes orders to planned
// demand, not just current velocity. (DemandPlanner computes the same scale from
// its live local state for instant feedback; this reads the persisted plan.)
function demandScaleFactor(){
  const cfg = demandConfig();
  const B = (typeof window!=='undefined' && window.FRKL_BUSINESS) || {};
  const months = cfg.months||3, horizonDays = months*30.4;
  const _del = delistAll();
  const sellers = (B.inventory||[]).filter(p=>p && p.status!=='ARCHIVED' && (p.dailyVelocity||0)>0 && !_del[p.sku||p.title]);
  const revMap={}; (B.products||[]).forEach(p=>{ if(p.sku && p.units>0) revMap[p.sku]=p.netSales/p.units; });
  const fb=(B.productSummary&&B.productSummary.singles&&B.productSummary.singles.aovPerUnit)||37;
  const rv = p=> (p.sku&&revMap[p.sku]!=null)?revMap[p.sku]:fb;
  const fm = p=> focusMultFor(p, cfg.focus, months);
  const baseTotal = sellers.reduce((t,p)=>t+p.dailyVelocity*horizonDays,0);                 // raw
  const baseRev = sellers.reduce((t,p)=>t+p.dailyVelocity*horizonDays*rv(p),0);             // raw
  const baseTotalF = sellers.reduce((t,p)=>t+p.dailyVelocity*horizonDays*fm(p),0);          // focus-weighted
  const baseRevF = sellers.reduce((t,p)=>t+p.dailyVelocity*horizonDays*fm(p)*rv(p),0);
  const focusActive = (cfg.focus||[]).some(f=>Number(f.mult)>0 && Number(f.mult)!==1);
  let scale = 1;
  if(cfg.targetMode==='growth') scale = 1+(Number(cfg.growth)||0)/100;
  else {
    // month-by-month: sum per-month targets (blank month → raw run-rate baseline)
    let target;
    if(cfg.shape==='month'){
      const baseMo = (cfg.targetMode==='units'?baseTotal:baseRev)/months;
      target = 0; for(let i=0;i<months;i++){ const v=(cfg.monthly||[])[i]; target += (v!=null&&v!=='')?(Number(v)||0):baseMo; }
    } else target = Number(cfg.targetValue);
    // normalise against the FOCUS-weighted baseline so the total still hits the target
    if(cfg.targetMode==='units' && target>0 && baseTotalF>0) scale = target/baseTotalF;
    else if(cfg.targetMode==='revenue' && target>0 && baseRevF>0) scale = target/baseRevF;
  }
  if(!(scale>0)) scale = 1;
  const totalUnits = scale*baseTotalF;
  const totalRevenue = scale*baseRevF;                       // projected gross revenue over the horizon
  const growthPct = baseTotal>0 ? (totalUnits/baseTotal-1)*100 : (scale-1)*100;
  return {scale, months, growthPct, mode:cfg.targetMode, active: Math.abs(scale-1)>0.005 || focusActive, byMonth: cfg.shape==='month', focusActive, units:totalUnits, revenue:totalRevenue};
}

// ── PO lifecycle: raised → awaiting Shopify stock → auto-closed ───────────────
// Per-SKU status so the app never re-nags about a PO already raised. When marked
// raised we snapshot baselineQty; on a later data sync, if Shopify stock has risen
// materially, the PO auto-closes (the acknowledgement). Key = SKU (or 'pkg:Name').
function oiToday(){ try{ return new Date().toISOString().slice(0,10); }catch(e){ return ''; } }
function oiAddDays(iso, n){ try{ const d=new Date((iso||oiToday())+'T00:00:00'); d.setDate(d.getDate()+(Number(n)||0)); return d.toISOString().slice(0,10); }catch(e){ return ''; } }
function oiDayDiff(aIso, bIso){ try{ const a=new Date((aIso||oiToday())+'T00:00:00'), b=new Date((bIso||oiToday())+'T00:00:00'); return Math.round((b-a)/86400000); }catch(e){ return 0; } }
function poStatusAll(){ try{ const s=JSON.parse(localStorage.getItem('oi_po_status_v1')||'{}'); return (s&&typeof s==='object')?s:{}; }catch(e){ return {}; } }
function savePoStatusAll(all){ try{ localStorage.setItem('oi_po_status_v1', JSON.stringify(all)); window.dispatchEvent(new Event('oi-po-updated')); }catch(e){} }
function setPoStatus(key, patch){ const all=poStatusAll(); if(patch==null) delete all[key]; else all[key]={...(all[key]||{}), ...patch}; savePoStatusAll(all); }
function setPoStatusMany(updates){ const all=poStatusAll(); Object.keys(updates).forEach(key=>{ const patch=updates[key]; if(patch==null) delete all[key]; else all[key]={...(all[key]||{}), ...patch}; }); savePoStatusAll(all); }
function clearPoStatus(key){ setPoStatus(key, null); }

// Shared reorder engine — used by the Production planner AND the action queue, so
// the to-do list and the PO drafts can never disagree about what's been ordered.
// Strategy-aware order sizing — shared by products AND packaging so they can't drift.
// vel = planned daily consumption, stock = units on hand. Returns trigger + quantity.
function _reorderSizing(strategy, vel, stock, lead, o){
  const cover = vel>0 ? stock/vel : 999;
  const forecastUnits = Math.ceil(vel*o.horizonDays);
  let qty=0, needs=false, basis='cover', waveUnits=null, nextWaveBy=null;
  if(strategy==='bulk'){
    const target = forecastUnits + Math.ceil(vel*o.safety);
    qty = Math.max(0, target - stock); needs = qty>0; basis='forecast';
  } else if(strategy==='staged'){
    const waveDays = o.horizonDays*(o.waveFrac!=null?o.waveFrac:1/o.waves); waveUnits = Math.ceil(vel*waveDays);  // first wave's slice (front-loadable)
    qty = Math.max(0, Math.ceil(vel*(lead+waveDays)) - stock); needs = cover <= lead+o.safety; basis='wave';
    nextWaveBy = oiAddDays(o.today, Math.max(0, Math.round(cover - lead - o.safety)));
  } else {
    qty = Math.max(0, Math.ceil(vel*(lead+o.coverDays)) - stock); needs = cover <= lead+o.safety; basis='cover';
  }
  return {cover, forecastUnits, qty, needs, basis, waveUnits, nextWaveBy};
}
function planReorder(over){
  over = over||{};   // {strategy} lets callers cost a strategy without switching to it
  const B = (typeof window!=='undefined' && window.FRKL_BUSINESS) || {};
  const inv = (B.inventory||[]).filter(p=>p && p.status!=='ARCHIVED');
  const rc = reorderConfig(); const safety = Number(rc.safetyDays)||14, coverDays = Number(rc.coverDays)||45;
  const strategy = over.strategy || rc.strategy || 'jit'; const waves = Math.max(1, Math.round(Number(over.waves!=null?over.waves:rc.waves)||3));
  const plan = demandScaleFactor(); const scale = plan.scale;
  const dcfg = demandConfig();                 // product-focus / promotion weights
  const horizonDays = (plan.months||3)*30.4;
  const po = poStatusAll(); const today = oiToday();
  const _ww = waveWeights(rc, waves);                          // per-wave demand split (front-loadable)
  const opt = {safety, coverDays, horizonDays, waves, today, waveFrac:_ww[0]};
  const skuSup = skuSupplierAll(); const del = delistAll(); const dir = suppliersAll();
  const productLines = inv.filter(p=>(p.dailyVelocity||0)>0 && !del[p.sku||p.title]).map(p=>{
    const sup = skuSup[p.sku||p.title] || {};                                   // SKU-level supplier master
    const assigned = !!(sup.supplier && String(sup.supplier).trim());
    const supplier = assigned ? sup.supplier.trim() : 'Unassigned — set supplier';
    const contact = assigned ? (dir[supplier]||{}) : {};
    const leadMake = (sup.lead!=null&&sup.lead!=='') ? Number(sup.lead) : leadDaysForType(p.type);  // order → shipment (production)
    const leadShip = (contact.shipDays!=null&&contact.shipDays!=='') ? Number(contact.shipDays) : (Number(rc.shipDays)||0);  // shipment → landing (transit)
    const lead = leadMake + leadShip;                                            // order → in stock — drives OOS + sizing
    const depositPct = (contact.depositPct!=null&&contact.depositPct!=='') ? Number(contact.depositPct) : (rc.depositPct!=null?Number(rc.depositPct):100);
    const stock = p.inventoryQty||0;
    const focusM = focusMultFor(p, dcfg.focus, plan.months);
    const vel = (p.dailyVelocity||0)*scale*focusM;
    const s = _reorderSizing(strategy, vel, stock, lead, opt);
    let qty = s.qty; const moq = Number(sup.moq)||0; let moqBumped=false;
    if(qty>0 && moq>0 && qty<moq){ qty=moq; moqBumped=true; }
    const unitCost = (sup.unitCost!=null&&sup.unitCost!=='') ? Number(sup.unitCost) : (p.costPerItem!=null?p.costPerItem:null);
    const lineCost = unitCost!=null?unitCost*qty:null;
    const depositCost = lineCost!=null ? lineCost*Math.max(0,Math.min(100,depositPct))/100 : null;
    return {key:p.sku||p.title, p, lead, leadMake, leadShip, depositPct, cover:s.cover, stock, vel, focusM, assigned, forecastUnits:s.forecastUnits, needs:s.needs, qty, basis:s.basis, waveUnits:s.waveUnits, nextWaveBy:s.nextWaveBy, moq, moqBumped, unitCost, priceTBC: unitCost==null, supplier, supEmail:contact.email||sup.email||'', supNotes:contact.notes||sup.notes||'', supPhone:contact.phone||'', supAddress:contact.address||'', lineCost, depositCost, balanceCost: lineCost!=null?lineCost-depositCost:null};
  });
  // ── packaging lines — consume the demand plan (per-item × units + per-order × orders) ──
  const pk = packagingConfig(); const aipo = Number(pk.avgItemsPerOrder)||1.3;
  const totalDailyUnits = inv.reduce((t,p)=> del[p.sku||p.title]?t:t+(p.dailyVelocity||0)*scale*focusMultFor(p, dcfg.focus, plan.months), 0);
  const totalDailyOrders = aipo>0 ? totalDailyUnits/aipo : 0;
  const pkgLines = (pk.components||[]).filter(c=> c.onHand!=='' && c.onHand!=null && isFinite(Number(c.onHand)) && ((Number(c.perItem)||0)>0 || (Number(c.perOrder)||0)>0)).map(c=>{
    const onHand = Number(c.onHand)||0;
    const dailyUse = (Number(c.perItem)||0)*totalDailyUnits + (Number(c.perOrder)||0)*totalDailyOrders;
    const leadMake = Number(c.leadDays)||30;
    const leadShip = Number(rc.shipDays)||0;
    const lead = leadMake + leadShip;
    const depositPct = (rc.depositPct!=null?Number(rc.depositPct):100);
    const s = _reorderSizing(strategy, dailyUse, onHand, lead, opt);
    let qty = s.qty; const moq = Number(c.moq)||0; let moqBumped=false;
    if(qty>0 && moq>0 && qty<moq){ qty=moq; moqBumped=true; }
    const unitCost = (c.unitCost!=null&&c.unitCost!=='') ? Number(c.unitCost) : null;
    const supplier = (c.supplier&&c.supplier.trim()) || 'Packaging';
    const p = {title:c.name, type:'Packaging', sku:'', inventoryQty:onHand};
    const lineCost = unitCost!=null?unitCost*qty:null;
    const depositCost = lineCost!=null ? lineCost*Math.max(0,Math.min(100,depositPct))/100 : null;
    return {key:'pkg:'+c.name, p, isPackaging:true, lead, leadMake, leadShip, depositPct, cover:s.cover, stock:onHand, vel:dailyUse, forecastUnits:s.forecastUnits, needs:s.needs, qty, basis:s.basis, waveUnits:s.waveUnits, nextWaveBy:s.nextWaveBy, moq, moqBumped, unitCost, supplier, lineCost, depositCost, balanceCost: lineCost!=null?lineCost-depositCost:null};
  });
  const lines = productLines.concat(pkgLines);
  // OOS-before-lead: runs out before a reorder placed today could land → order TODAY
  lines.forEach(l=>{ l.oosBeforeLead = l.cover < l.lead; l.oosGap = l.oosBeforeLead ? Math.round(l.lead-l.cover) : 0; });
  // auto-acknowledge: a raised/received PO whose stock has risen materially is closed
  // (products: Shopify inventory; packaging: the on-hand figure you update)
  const ackPending={};
  lines.forEach(l=>{ const st=po[l.key]; if(st && (st.status==='ordered'||st.status==='received')){ const cur=l.p.inventoryQty||0; if(cur >= (st.baselineQty||0)+Math.max(1, Math.ceil(0.5*(st.qty||l.qty)))) ackPending[l.key]=true; } });
  lines.forEach(l=>{ const st = ackPending[l.key]?null:(po[l.key]||null); l.po=st; l.poStatus=st?st.status:null;
    if(st && st.status==='ordered'){ l.expected = oiAddDays(st.raisedAt||today, l.lead); l.overdue = l.expected && today > oiAddDays(st.raisedAt||today, l.lead+7); } });
  // strategy surfaces the can't-wait items first: OOS-before-lead, biggest gap, then lowest cover
  const toOrder = lines.filter(l=>l.needs && l.qty>0 && !l.poStatus)
    .sort((a,b)=> (b.oosBeforeLead-a.oosBeforeLead) || (b.oosGap-a.oosGap) || (a.cover-b.cover));
  const awaiting = lines.filter(l=>l.poStatus==='ordered').sort((a,b)=>(a.expected||'').localeCompare(b.expected||''));
  const approaching = lines.filter(l=>!l.needs && l.cover <= l.lead + coverDays && !l.poStatus).length;
  const oosNow = toOrder.filter(l=>l.oosBeforeLead).length;   // order today to avoid a gap
  return {inv, lines, toOrder, awaiting, approaching, oosNow, ackPending, plan, scale, safety, coverDays, strategy, waves, horizonDays};
}
function leadDaysFor(type, cfg){
  cfg = cfg || leadConfig();
  const ov = type!=null ? cfg.byType[type] : null;
  if(ov!=null && ov!=='' && isFinite(Number(ov))) return Number(ov);
  const d = Number(cfg.default);
  return isFinite(d) && d>0 ? d : 30;
}
// Best-available gross margin: verified operator value → tenant config → catalogue → 0.6.
function oiGrossMargin(){
  const u = userGrossMargin(); if(u!=null) return u;
  if(typeof window!=='undefined' && window.OI_CONFIG && window.OI_CONFIG.grossMargin) return window.OI_CONFIG.grossMargin;
  const meta = (typeof window!=='undefined' && window.FRKL_PRODUCTS_META) || {};
  if(meta.grossMargin) return meta.grossMargin;
  return 0.6;
}
// Re-render hook: any component showing a margin number can subscribe so badges
// + figures update the instant costs are saved.
function useCostTick(){
  const [, force] = React.useState(0);
  React.useEffect(()=>{ const h=()=>force(x=>x+1); window.addEventListener('oi-costs-updated', h); return ()=>window.removeEventListener('oi-costs-updated', h); }, []);
  return marginVerified();
}

// ── Signal-quality ranking ──────────────────────────────────────────────────
// Order findings so the HIGHEST-QUALITY signal leads, not just the biggest £:
// confidence-weighted, actionable-weighted £. A rock-solid finding outranks a
// bigger but speculative one; confounded ('info') + watch ('monitor') items sink.
const FIND_CONF_W = {high:1, med:0.62, low:0.28};
const FIND_VERDICT_W = {act:1, monitor:0.4, info:0.22};
function findingScore(f){
  if(!f) return 0;
  const c = FIND_CONF_W[f.confidence] != null ? FIND_CONF_W[f.confidence] : 0.62;
  const v = FIND_VERDICT_W[f.verdict] != null ? FIND_VERDICT_W[f.verdict] : 0.6;
  return (Math.max(0, f.gbp||0) + 1) * c * v;   // +1 so £0 synthesis items still rank by conf/verdict
}
// Map a finding to the tab that holds its evidence, so cross-refs become clickable.
function findingNav(f){
  if(!f) return null;
  if(f._cvr) return {section:'conversion', sub:'cvr', label:'CVR drivers'};
  if(f._markdown || f._discount) return {section:'commerce', sub:'promos', label:'Promotions'};
  if(f._product) return {section:'commerce', sub:'products', label:'Products'};
  const a = (f.area||'').toLowerCase();
  if(/conversion|checkout|cvr/.test(a)) return {section:'conversion', sub:'cvr', label:'CVR drivers'};
  if(/margin|promotion|discount/.test(a)) return {section:'commerce', sub:'promos', label:'Promotions'};
  if(/merchandis|product|availability/.test(a)) return {section:'commerce', sub:'products', label:'Products'};
  return null;
}
function NavChip({f}){
  const n = findingNav(f); if(!n) return null;
  return <button onClick={()=>window.__oiNav&&window.__oiNav(n.section,n.sub)} title={`Open ${n.label}`}
    style={{fontSize:10.5,fontWeight:600,color:'#9aa6ff',background:'rgba(124,140,255,0.12)',border:'1px solid rgba(124,140,255,0.3)',borderRadius:999,padding:'1px 8px',cursor:'pointer',whiteSpace:'nowrap'}}>→ {n.label}</button>;
}
const sum = (arr,k) => arr.reduce((a,r)=>a+(r[k]||0),0);
const COL = { meta:'#5b8def', google:'#f4a23b', revenue:'#4ade80', email:'#c084fc', sessions:'#38bdf8' };

// ── linkify ──────────────────────────────────────────────────────────────
// Turn explicit URLs and known product mentions in free text into clickable
// links. window.FRKL_LINKS maps lowercased product title → its PDP URL (active
// products only, generated from live Shopify data). Matching is exact whole-
// phrase, case-insensitive, longest-first → no false positives.
const FRKL_LINKS = window.FRKL_LINKS || {};
const _linkKeys = Object.keys(FRKL_LINKS).sort((a,b)=>b.length-a.length);
const _linkRe = (() => {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = ['https?:\\/\\/[^\\s)]+'];
  if (_linkKeys.length) parts.push('(?:' + _linkKeys.map(esc).join('|') + ')');
  return new RegExp('(' + parts.join('|') + ')', 'gi');
})();
function linkify(text){
  if (!text || typeof text !== 'string') return text;
  const out = []; let last = 0; let m; let i = 0;
  _linkRe.lastIndex = 0;
  while ((m = _linkRe.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const href = /^https?:\/\//i.test(tok) ? tok : (FRKL_LINKS[tok.toLowerCase()] || null);
    if (href) out.push(<a key={i++} href={href} target="_blank" rel="noopener noreferrer" className="txt-link">{tok}</a>);
    else out.push(tok);
    last = m.index + tok.length;
    if (_linkRe.lastIndex === m.index) _linkRe.lastIndex++;  // guard zero-width
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ── Active review window ──────────────────────────────────────────────────
// REAL_* are the true data bounds. ACTIVE_END is the end of the window the user
// is currently reviewing — the latest data date for a preset (7/30/60/90d), or
// the chosen "to" date for a custom between-two-dates range. App sets ACTIVE_END
// synchronously at the top of each render (before panels read it), so inRange /
// startFor / dataEndOf transparently respect a custom end with no prop-threading.
const REAL_END = (() => { const ds=(D.shopify||[]).map(r=>r.date).sort(); return ds[ds.length-1]; })();
const REAL_START = (() => { const ds=(D.shopify||[]).map(r=>r.date).sort(); return ds[0]; })();
// ── Canonical benchmarks (single source of truth — must match scripts/oi_db.py BENCHMARKS).
// Site CVR = Shopify orders ÷ GA4 sessions; one benchmark everywhere so the dashboard
// never shows the same KPI against two different targets.
// Industry benchmark library — category-resolved for this brand, emitted from
// oi_db.BENCHMARK_LIB (single source of truth). Falls back gracefully if absent.
const OI_BM = (typeof window!=='undefined' && window.OI_BENCHMARKS) || {metrics:{}};
function bmGet(metric){ return (OI_BM.metrics||{})[metric] || null; }
function bmFmt(unit, v){ if(v==null) return '—';
  if(unit==='pct')   return (+(v*100).toFixed(v*100<10?1:0))+'%';
  if(unit==='gbp')   return curSym()+Math.round(v).toLocaleString('en-GB');
  if(unit==='ratio') return (+v.toFixed(1))+'×';
  return String(v); }
// CVR benchmark now flows from the registry (jewellery/frkl = 1.5%), not a literal.
const CVR_BENCH = (bmGet('site_cvr') && bmGet('site_cvr').value) || 0.015;
const CVR_BENCH_LABEL = bmFmt('pct', CVR_BENCH);
// ── Brand identity for copy + LLM prompts (multi-brand). The /app shell injects
// window.OI_BRAND per tenant. This dashboard runs as a same-origin iframe inside the
// shell, so — exactly like OI_ASK below — we read our own window first, then fall back
// to window.parent.OI_BRAND. Final fallback is frkl so the standalone/demo view is
// unchanged. Without the parent fallback a tenant would silently render frkl's copy.
const OI_BRAND = (typeof window!=='undefined' && (window.OI_BRAND || (function(){
  try { return (window.parent && window.parent!==window) ? window.parent.OI_BRAND : null; }
  catch(e){ return null; }
})())) || {
  name: 'frkl', vertical: 'demi-fine jewellery', markets: 'UK/Ireland',
  seasonality: "Valentine's, Mother's Day and Christmas are demand peaks; post-peak softness is normal",
};
// DEMO gate: hardcoded frkl narratives/examples render ONLY on the frkl demo workspace.
const DEMO = (typeof OI_BRAND!=='undefined' && OI_BRAND && OI_BRAND.slug==='frkl');
// The six specialist agents and their remit — surfaced next to each name so the
// founder knows whose lens a read is coming from (transparency).
const AGENT_ROLE = {
  Pulse: 'Performance & analytics',
  Frame: 'Brand & creative',
  Atlas: 'Finance & commercial',
  Lux:   'Creator, community & CX',
  Sage:  'Content & copy',
  Scout: 'Competitive intelligence',
};
function agentRole(name){ return AGENT_ROLE[name] || null; }
function agentTitle(name){ const r=agentRole(name); return r ? `${name} — ${r}` : (name||''); }
// Axis tick formatter that keeps precision on small-range axes (e.g. visibility
// 0–3%): 1 dp under 10 so ticks stay distinct, integers above. Trailing .0 stripped.
function niceTick(v){ if(v==null||isNaN(v)) return v; return (+(v).toFixed(Math.abs(v)<10?1:0)).toString(); }
let ACTIVE_END = REAL_END;
function setActiveEnd(e){ ACTIVE_END = e || REAL_END; }

// Named period presets → {start,end}. To-date periods end at the latest data
// date (REAL_END); calendar periods (last week/month) end at their own close.
// All clamp within [REAL_START, REAL_END] so empty future ranges never show.
const PERIODS = [
  {key:'7d',        label:'Last 7 days'},
  {key:'30d',       label:'Last 30 days'},
  {key:'90d',       label:'Last 90 days'},
  {key:'wtd',       label:'Week to date'},
  {key:'lastweek',  label:'Last week'},
  {key:'mtd',       label:'Month to date'},
  {key:'lastmonth', label:'Last month'},
  {key:'qtd',       label:'Quarter to date'},
  {key:'ytd',       label:'Year to date'},
  {key:'12m',       label:'Last 12 months'},
  {key:'all',       label:'All time'},
];
function periodRange(key){
  const iso = d => d.toISOString().slice(0,10);
  const e = new Date(REAL_END + 'T00:00:00Z');
  const back = n => { const s = new Date(e); s.setUTCDate(e.getUTCDate()-(n-1)); return iso(s); };
  const monday = dt => { const d = new Date(dt); const off = (d.getUTCDay()+6)%7; d.setUTCDate(d.getUTCDate()-off); return d; };
  const clamp = s => s < REAL_START ? REAL_START : s;
  switch(key){
    case '7d':  return {start: clamp(back(7)),  end: REAL_END};
    case '30d': return {start: clamp(back(30)), end: REAL_END};
    case '90d': return {start: clamp(back(90)), end: REAL_END};
    case 'wtd': return {start: clamp(iso(monday(e))), end: REAL_END};
    case 'lastweek': { const ws = monday(e); const lwEnd = new Date(ws); lwEnd.setUTCDate(ws.getUTCDate()-1); const lwStart = new Date(lwEnd); lwStart.setUTCDate(lwEnd.getUTCDate()-6); return {start: clamp(iso(lwStart)), end: iso(lwEnd)}; }
    case 'mtd': return {start: clamp(iso(new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), 1)))), end: REAL_END};
    case 'lastmonth': { const s = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth()-1, 1)); const en = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth(), 0)); return {start: clamp(iso(s)), end: iso(en)}; }
    case 'qtd': { const q = Math.floor(e.getUTCMonth()/3)*3; return {start: clamp(iso(new Date(Date.UTC(e.getUTCFullYear(), q, 1)))), end: REAL_END}; }
    case 'ytd': return {start: clamp(iso(new Date(Date.UTC(e.getUTCFullYear(), 0, 1)))), end: REAL_END};
    case '12m': { const s = new Date(e); s.setUTCFullYear(e.getUTCFullYear()-1); s.setUTCDate(s.getUTCDate()+1); return {start: clamp(iso(s)), end: REAL_END}; }
    case 'all': return {start: REAL_START, end: REAL_END};
    default:    return {start: clamp(back(30)), end: REAL_END};
  }
}

function inRange(rows, start) { return rows.filter(r => r.date >= start && r.date <= ACTIVE_END); }
function startFor(days){ const d = new Date((ACTIVE_END||REAL_END)+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()-(days-1)); return d.toISOString().slice(0,10); }

function priorPeriod(start, end){
  const s = new Date(start+'T00:00:00Z');
  const e = new Date(end+'T00:00:00Z');
  const span = Math.round((e-s)/86400000) + 1;
  const pe = new Date(s.getTime() - 86400000);
  const ps = new Date(pe.getTime() - (span-1) * 86400000);
  return {start: ps.toISOString().slice(0,10), end: pe.toISOString().slice(0,10), span};
}
function inRangeBounded(rows, start, end){ return (rows||[]).filter(r => r.date >= start && r.date <= end); }
function dataEndOf(){ return ACTIVE_END || REAL_END; }
function fmtDelta(d){ if(d==null) return null; const pct = Math.abs(d*100); if (pct < 0.5) return '·0%'; return (d>0?'↑':'↓') + pct.toFixed(0) + '%'; }

// Small inline confidence pill for any margin-derived figure. Subscribes to cost
// updates so it flips the instant the operator verifies their costs.
function MarginBadge({onSetup}){
  const verified = useCostTick();
  const tip = verified
    ? 'Based on your entered costs — verified.'
    : 'Estimated from catalogue defaults. Enter your real costs to make this accurate.';
  return (<span title={tip} onClick={(!verified && onSetup) ? (e=>{e.stopPropagation(); onSetup();}) : undefined}
    style={{display:'inline-flex', alignItems:'center', gap:3, fontSize:9, fontWeight:700, letterSpacing:'.03em', textTransform:'uppercase',
            padding:'1px 6px', borderRadius:'var(--r-full)', cursor:(!verified && onSetup)?'pointer':'help', whiteSpace:'nowrap',
            background: verified?'var(--good-bg)':'var(--warn-bg)', color: verified?'var(--good)':'var(--warn)',
            border:'1px solid '+(verified?'rgba(74,222,128,.3)':'rgba(245,181,68,.3)')}}>
    {verified ? '✓ verified' : '~ est.'}
  </span>);
}

// Guided cost setup — makes contribution/CAC/LTV trustworthy. Pre-fills the
// catalogue gross margin + current variable-cost assumptions; saving marks costs
// verified so every margin number flips from "est." to "verified".
function CostSetupModal({catalogueGm, onClose}){
  const init = costConfig();
  const [f, setF] = React.useState(()=>({
    gmPct: init.gmPct!=='' && init.gmPct!=null ? init.gmPct : (catalogueGm!=null ? (catalogueGm*100).toFixed(0) : ''),
    packaging: init.packaging, fulfilment: init.fulfilment, shipping: init.shipping,
    payPct: init.payPct, payFixed: init.payFixed, refundPct: init.refundPct,
  }));
  const set = (k,v)=> setF(p=>({...p, [k]:v}));
  const num = v => { const x=parseFloat(String(v).replace(',','.').replace(/[^0-9.]/g,'')); return isFinite(x)?x:0; };
  const gm = num(f.gmPct)/100;
  const aovGuess = (typeof window!=='undefined' && window.FRKL_DATA && (window.FRKL_DATA.shopify||[]).length)
    ? (()=>{ const s=window.FRKL_DATA.shopify; const o=s.reduce((a,r)=>a+(r.orders||0),0); const rev=s.reduce((a,r)=>a+(r.netSales||0),0); return o>0?rev/o:60; })() : 60;
  const varPerOrder = num(f.packaging)+num(f.fulfilment)+num(f.shipping)+num(f.payFixed) + aovGuess*(num(f.payPct)/100) + aovGuess*(num(f.refundPct)/100);
  const cmRate = Math.max(0, gm - (aovGuess>0?varPerOrder/aovGuess:0));
  const beRoas = cmRate>0 ? 1/cmRate : null;
  const valid = f.gmPct!=='' && num(f.gmPct)>0 && num(f.gmPct)<100;
  const save = ()=>{ saveCostConfig({...costConfig(), ...f, verified:true, verifiedAt:new Date().toISOString()}); onClose(); };
  const Field = ({k, label, prefix, suffix, hint}) => (
    <div style={{marginBottom:12}}>
      <label style={{display:'block', fontSize:12, fontWeight:600, color:'var(--text-secondary)', marginBottom:4}}>{label}</label>
      <div style={{display:'flex', alignItems:'center', gap:6}}>
        {prefix && <span style={{color:'var(--text-faint)', fontSize:13}}>{prefix}</span>}
        <input value={f[k]} onChange={e=>set(k, e.target.value)} inputMode="decimal"
          style={{width:90, background:'var(--bg-app)', color:'var(--text-primary)', border:'1px solid var(--border-default)', borderRadius:'var(--r-sm)', padding:'7px 9px', fontSize:13}}/>
        {suffix && <span style={{color:'var(--text-faint)', fontSize:13}}>{suffix}</span>}
        {hint && <span className="micro" style={{color:'var(--text-faint)', marginLeft:4}}>{hint}</span>}
      </div>
    </div>);
  return (<div className="modal-bg" onClick={onClose}>
    <div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:560}}>
      <h3>Set up your real costs <span style={{fontWeight:400, color:'var(--text-faint)', fontSize:13}}>· ~5 min, makes margin numbers accurate</span></h3>
      <div className="micro" style={{color:'var(--text-muted)', marginBottom:14, lineHeight:1.5}}>
        Contribution, CAC payback and LTV:CAC are only as good as the costs behind them. Until these are confirmed they're shown as <b style={{color:'var(--warn)'}}>estimates</b>. Enter your real numbers once and every margin figure flips to <b style={{color:'var(--good)'}}>verified</b>.
      </div>
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'0 24px'}}>
        <Field k="gmPct"    label="Gross margin %"        suffix="%" hint={catalogueGm!=null?`catalogue ≈ ${(catalogueGm*100).toFixed(0)}%`:''}/>
        <Field k="refundPct" label="Refund / return rate" suffix="%"/>
        <Field k="fulfilment" label="Fulfilment / pick-pack" prefix="£" suffix="/order"/>
        <Field k="packaging"  label="Packaging"             prefix="£" suffix="/order"/>
        <Field k="shipping"   label="Shipping cost"         prefix="£" suffix="/order"/>
        <Field k="payFixed"   label="Payment fee (fixed)"   prefix="£" suffix="/order"/>
        <Field k="payPct"     label="Payment fee (%)"       suffix="%"/>
      </div>
      <div style={{marginTop:8, padding:'10px 12px', background:'var(--bg-app)', borderRadius:'var(--r-sm)', border:'1px solid var(--border-subtle)', fontSize:12.5, color:'var(--text-secondary)'}}>
        At ~{GBP(aovGuess)} AOV that's a <b style={{color:'var(--text-primary)'}}>{(cmRate*100).toFixed(0)}%</b> per-order contribution margin → break-even ROAS <b style={{color:'var(--text-primary)'}}>{beRoas?beRoas.toFixed(2)+'×':'—'}</b>. Every order needs to clear this to be profitable.
      </div>
      <div className="row">
        <button className="primary" onClick={save} disabled={!valid} style={!valid?{opacity:.5,cursor:'default'}:undefined}>Save &amp; verify costs</button>
        <button onClick={onClose} style={{marginLeft:'auto'}}>Cancel</button>
      </div>
      <div className="hint">Stored in this browser for now (server-side per-tenant config is coming). Edit any time from the cost badge.</div>
    </div>
  </div>);
}

function KPI({label, val, sub, badge, status, statusLabel, conf, series, seriesLabel, current, prior, goodDirection, agent, observation, implication, benchmark, bmValue}){
  const delta = (prior!=null && current!=null && prior!==0) ? (current-prior)/prior : null;
  let deltaColor = 'var(--text-muted)';
  if (delta!=null && goodDirection) {
    const isGood = goodDirection==='down' ? delta<0 : delta>0;
    deltaColor = Math.abs(delta) < 0.005 ? 'var(--text-muted)' : (isGood ? 'var(--good)' : 'var(--bad)');
  } else if (delta!=null) {
    deltaColor = 'var(--text-secondary)';
  }
  const hasSpark = series && series.length > 1;
  const hasExplainer = agent || observation || implication;
  const hasPop = hasSpark || hasExplainer;
  const lineColor = (delta!=null && goodDirection)
    ? (deltaColor === 'var(--text-muted)' ? 'var(--accent)' : deltaColor)
    : 'var(--accent)';
  // Resolve the CSS variable to a real hex for Recharts SVG stroke
  const rechartsStroke = lineColor === 'var(--good)' ? '#4ade80'
    : lineColor === 'var(--bad)' ? '#ef6b6f'
    : lineColor === 'var(--accent)' ? '#7c8cff'
    : '#7c8cff';
  return (<div className={'card kpi' + (hasPop ? ' has-pop' : '')}>
    <div className="label">
      <span>{label}</span>
      {status && <StatusBadge kind={status} label={statusLabel}/>}
      {badge}
      {hasPop && <span className="info-dot"/>}
    </div>
    <div className="val">{val}{delta!=null && <span className="delta" style={{color:deltaColor}}>{fmtDelta(delta)}</span>}</div>
    {sub && <div className="sub">{sub}{conf && <span style={{marginLeft:7}}>{confChip(conf)}</span>}</div>}
    {!sub && conf && <div className="sub">{confChip(conf)}</div>}
    {benchmark && <div className="sub" style={{marginTop:6}}><Benchmark metric={benchmark} value={bmValue}/></div>}
    {hasPop && (
      <div className="kpi-pop">
        {hasSpark && (<div>
          <div className="head">{seriesLabel || `${series.length}-day trend · vs prior period`}</div>
          <R.ResponsiveContainer width="100%" height={132}>
            <R.LineChart data={series} margin={{top:6,right:10,left:2,bottom:4}}>
              <R.CartesianGrid stroke="#23232c" vertical={false}/>
              <R.XAxis dataKey="d" tick={{fill:'#7e7e8a',fontSize:9}} interval={Math.ceil(series.length/5)} tickLine={false}/>
              <R.YAxis tick={{fill:'#7e7e8a',fontSize:9}} width={34} domain={['auto','auto']}
                       tickFormatter={v=> Math.abs(v)>=1000 ? (v/1000).toFixed(1)+'k' : (Math.abs(v)<10 ? v.toFixed(1) : Math.round(v))}/>
              <R.Tooltip contentStyle={{fontSize:10,background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:6,padding:'2px 6px'}} formatter={v=> typeof v==='number' ? (Math.abs(v)>=1000 ? Math.round(v).toLocaleString() : v.toFixed(2)) : v} labelFormatter={l=>l}/>
              <R.Line type="monotone" dataKey="v" stroke={rechartsStroke} strokeWidth={2} dot={false} isAnimationActive={false}/>
            </R.LineChart>
          </R.ResponsiveContainer>
        </div>)}
        {hasExplainer && (
          <div className="explainer">
            {agent && <div className="agent" title={agentTitle(agent)}>◆ {agent}{agentRole(agent) && <span style={{fontWeight:500,color:'var(--text-faint)',marginLeft:6}}>· {agentRole(agent)}</span>}</div>}
            {observation && <div className="obs">{observation}</div>}
            {implication && <div className="imp">{implication}</div>}
            <div onClick={(e)=>{ e.stopPropagation(); if(window.__oiAsk) window.__oiAsk(`About "${label}"${val?` (currently ${val})`:''}: what's driving this, and what should I do about it?`); }}
              style={{marginTop:8, fontSize:11, color:'#9aa6ff', cursor:'pointer', fontWeight:600}}>✦ Ask AI about this →</div>
          </div>
        )}
      </div>
    )}
  </div>);
}

const INS = window.FRKL_INSIGHTS || {};
const STATUS = window.FRKL_ACTION_STATUS || {};
function pClass(p){ return p==='P1'?'red':p==='P2'?'amber':'grey'; }
function statusBadge(s){
  if (s === "verified-done") return ["done","✓ DONE"];
  if (s === "needs-chrome")  return ["chrome","◐ chrome"];
  if (s === "needs-input")   return ["input","? input"];
  if (s === "open")          return ["open","○ open"];
  return ["noreg","· no recipe"];
}
function fmtPct(x){ if (x==null) return "—"; const v=x*100; return (v>=0?"+":"")+v.toFixed(0)+"%"; }
function ImpactLine({impact, resolvedAt}){
  if (!impact || !Object.keys(impact).length) return null;
  const parts = Object.entries(impact).map(([k,v]) => `${k.replace(/_/g,' ')}: ${fmtPct(v.deltaPct)}`).join(" · ");
  const when = resolvedAt ? new Date(resolvedAt).toISOString().slice(0,10) : "";
  return <div className="impact"><span className="label">Since {when}:</span> {parts}</div>;
}
function MarkDoneModal({action, onClose}){
  const [note, setNote] = React.useState("");
  const [doneDate, setDoneDate] = React.useState(new Date().toISOString().slice(0,10));
  const [copied, setCopied] = React.useState(false);
  const escapedNote = note.replace(/"/g, '\\"');
  const cmd = `/frkl-done ${action.id} --date ${doneDate}` + (note ? ` "${escapedNote}"` : '');
  const copy = () => {
    navigator.clipboard?.writeText(cmd).then(() => {
      setCopied(true);
      toast('Command copied', {kind:'good', body:'Paste it into any Cowork chat to persist this status.'});
      setTimeout(() => setCopied(false), 2000);
    });
  };
  // Local-only mark — writes a flag to localStorage so the dashboard remembers
  // until the next refresh actually persists it server-side
  const markLocal = () => {
    const local = JSON.parse(localStorage.getItem('frkl-action-local-done')||'{}');
    local[action.id] = {note, completedDate: doneDate, at: new Date().toISOString()};
    localStorage.setItem('frkl-action-local-done', JSON.stringify(local));
    onClose();
    toast('Action marked done', {kind:'good', body:'Saved in this browser until the next data refresh.'});
    setTimeout(() => location.reload(), 850);
  };
  return (<div className="modal-bg" onClick={onClose}>
    <div className="modal" onClick={e=>e.stopPropagation()}>
      <h3>Mark action as done</h3>
      <div className="id">{action.id}</div>
      <div className="actiontxt">{action.text}</div>
      <label>Date completed <span style={{color:'var(--text-faint)',fontWeight:400}}>— when the change went live; business impact is measured from this date</span></label>
      <input type="date" value={doneDate} max={new Date().toISOString().slice(0,10)} onChange={e=>setDoneDate(e.target.value)} style={{colorScheme:'light dark'}}/>
      <label>Optional note (what did you do?)</label>
      <input type="text" value={note} onChange={e=>setNote(e.target.value)} placeholder='e.g. "Confirmed COGS 32% with supplier, brand_config updated"' autoFocus/>
      <label>Command to run in Cowork</label>
      <div className="cmd">{cmd}</div>
      <div className="row">
        <button className="primary" onClick={copy}>
          <span className={copied ? "copied" : ""}>{copied ? "✓ Copied!" : "Copy command"}</span>
        </button>
        <button onClick={markLocal}>Mark done locally</button>
        <button onClick={onClose} style={{marginLeft:'auto'}}>Cancel</button>
      </div>
      <div className="hint">
        <b>Recommended:</b> copy the command, paste it into any Cowork chat. The plugin will persist the status to the data files so it sticks across refreshes.<br/>
        <b>"Mark done locally"</b> is a quick override that only persists in this browser until the next data refresh — useful for trying it out.
      </div>
    </div>
  </div>);
}

function isLocallyDone(id){
  try {
    const local = JSON.parse(localStorage.getItem('frkl-action-local-done')||'{}');
    return !!local[id];
  } catch(e){ return false; }
}

function ActionRow({a, area, onMark}){
  const st = STATUS[a.id] || {};
  const localDone = isLocallyDone(a.id);
  const effectiveStatus = localDone && st.status !== "verified-done" ? "verified-done" : st.status;
  const [statCls, statTxt] = statusBadge(effectiveStatus);
  const isDone = effectiveStatus === "verified-done";
  const ev = localDone && st.status !== "verified-done" ? "Marked done locally — pending refresh to persist" : st.evidence;
  return (<div className={"actionrow"+(isDone?" done":"")}>
    <span className={'pill '+pClass(a.p)}>{a.p}</span>
    <div className="t" style={{flex:1}}>
      {linkify(a.text)}
      {ev && <div className="ev">{ev}</div>}
      {isDone && st.impact && <ImpactLine impact={st.impact} resolvedAt={st.resolvedAt}/>}
    </div>
    {!isDone && onMark && <button className="markbtn" onClick={()=>onMark(a)}>Mark done</button>}
    <span className={'stat '+statCls} title={ev||""}>{statTxt}</span>
  </div>);
}
function Insight({k}){
  const d=INS[k]; if(!d) return null;
  const [modalAction, setModalAction] = React.useState(null);
  const [dismissed, setDismissed] = React.useState(()=> oiSnoozed(d.headline) ? 'snoozed' : null);
  if(dismissed){
    return (<div className="card insight ia-collapsed" style={{marginTop:14}}>
      <div className="ia-dismissed">
        <Icon name={dismissed==='wrong'?'alert':'bell'} size={14}/>
        <span><b>{d.agent}</b> · {dismissed==='wrong'?'flagged as not useful':'snoozed'} — {d.headline}</span>
        <button onClick={()=>{ oiSnoozeRemove(d.headline); setDismissed(null); }}>Undo</button>
      </div>
    </div>);
  }
  return (<div className="card insight" style={{marginTop:14}}>
    <span style={{display:'inline-flex',alignItems:'baseline',gap:8,flexWrap:'wrap'}}>
      <span className="agentbadge" title={agentTitle(d.agent)}>◆ {d.agent}</span>
      {agentRole(d.agent) && <span style={{fontSize:11,color:'var(--text-faint)',fontWeight:500}}>{agentRole(d.agent)}</span>}
    </span>
    <div className="head">{d.headline}</div>
    <ul>{d.analysis.map((a,i)=><li key={i}>{a}</li>)}</ul>
    <div style={{marginTop:8}}>
      {d.actions.map((a,i)=>(<ActionRow key={i} a={a} area={k} onMark={setModalAction}/>))}
    </div>
    <InsightActions title={d.headline} why={d.analysis} agent={d.agent}
      recommendation={(d.actions[0] && d.actions[0].text) || d.headline}
      onSnooze={()=>setDismissed('snoozed')} onWrong={()=>setDismissed('wrong')}/>
    {modalAction && <MarkDoneModal action={modalAction} onClose={()=>setModalAction(null)}/>}
  </div>);
}
function MoneyBadge({money}){
  if (!money || money.monthly_impact_gbp == null) return null;
  const v = money.monthly_impact_gbp;
  const kind = money.kind || 'opportunity';
  const conf = money.confidence || 'low';
  const KIND_VAR = {leakage:'var(--bad)', at_risk:'var(--warn)', opportunity:'var(--good)'};
  const KIND_BG  = {leakage:'var(--bad-bg)', at_risk:'var(--warn-bg)', opportunity:'var(--good-bg)'};
  const KIND_LABEL = {leakage:'leaking', at_risk:'at risk', opportunity:'opportunity'};
  const color = KIND_VAR[kind] || 'var(--text-muted)';
  const bg = KIND_BG[kind] || 'var(--border-subtle)';
  const opacity = conf === 'high' ? 1 : conf === 'medium' ? 0.88 : 0.72;
  const abs = Math.abs(v);
  const fmt = abs >= 1000 ? '£'+(abs/1000).toFixed(1)+'k' : '£'+Math.round(abs);
  const tooltip = `${fmt}/mo ${KIND_LABEL[kind]} (${conf} confidence). ${money.basis||''}`;
  return (<span title={tooltip} style={{
    display:'inline-block', whiteSpace:'nowrap',
    fontSize:10.5, fontWeight:700,
    padding:'2px 8px', borderRadius:'var(--r-sm)',
    background: bg, color, opacity,
    cursor:'help', letterSpacing:.03,
  }}>{fmt}/mo</span>);
}

function MoneyOnTablePanel(){
  const P = window.FRKL_PATTERNS;
  if (!P || !P.money_rollup) return null;
  const rollup = P.money_rollup;
  const am = P.action_money || {};
  const mp = P.money_patterns || [];
  const items = [
    ...Object.values(am).map(m => ({...m, source: 'action'})),
    ...mp.map(m => ({
      external_id: m.synthetic_id, agent: 'synthetic', priority: '—',
      description: m.label, basis: m.basis,
      monthly_impact_gbp: m.monthly_impact_gbp,
      kind: m.kind, confidence: m.confidence,
      status: 'open',
      source: 'synthetic',
    }))
  ].filter(x => x.monthly_impact_gbp && Math.abs(x.monthly_impact_gbp) >= 50)
   .sort((a,b) => Math.abs(b.monthly_impact_gbp) - Math.abs(a.monthly_impact_gbp));
  return (<div className="card">
    <div className="card-section-title">
      <h2 style={{margin:0}}>Money on the table</h2>
      <span className="meta">£/mo at stake · conservative estimates · total is illustrative (items overlap)</span>
    </div>
    <div className="stat-strip" style={{marginBottom:'var(--s-4)'}}>
      <div className="stat-strip-item">
        <div className="stat-strip-val" style={{color:'var(--bad)'}}>£{(rollup.leakage/1000).toFixed(1)}k<span style={{fontSize:11, color:'var(--text-muted)', marginLeft:3}}>/mo</span></div>
        <div className="stat-strip-label">Leaking now</div>
      </div>
      <div className="stat-strip-divider"/>
      <div className="stat-strip-item">
        <div className="stat-strip-val" style={{color:'var(--warn)'}}>£{(rollup.at_risk/1000).toFixed(1)}k<span style={{fontSize:11, color:'var(--text-muted)', marginLeft:3}}>/mo</span></div>
        <div className="stat-strip-label">At risk</div>
      </div>
      <div className="stat-strip-divider"/>
      <div className="stat-strip-item">
        <div className="stat-strip-val" style={{color:'var(--good)'}}>£{(rollup.opportunity/1000).toFixed(1)}k<span style={{fontSize:11, color:'var(--text-muted)', marginLeft:3}}>/mo</span></div>
        <div className="stat-strip-label">Opportunity</div>
      </div>
      <div className="stat-strip-divider"/>
      <div className="stat-strip-item">
        <div className="stat-strip-val">£{(rollup.total/1000).toFixed(1)}k<span style={{fontSize:11, color:'var(--text-muted)', marginLeft:3}}>/mo</span></div>
        <div className="stat-strip-label">Total identified</div>
      </div>
    </div>
    {(() => {
      // Separate EVIDENCED findings from HYPOTHESES (unvalidated opportunities) so
      // speculation never sits beside grounded leakage. Synthetic opportunities and
      // low-confidence items are hypotheses; everything else is evidenced.
      const tier = (c) => typeof c === 'number' ? (c >= 0.66 ? 'high' : c >= 0.45 ? 'medium' : 'low') : (c || 'low');
      const isHyp = (m) => m.source === 'synthetic' || tier(m.confidence) === 'low';
      const evidenced = items.filter(m => !isHyp(m));
      const hypotheses = items.filter(isHyp);
      const confColor = (c) => { const t=tier(c); return t==='high'?'var(--good)':t==='medium'?'var(--warn)':'var(--text-muted)'; };
      const Row = (m,i)=>{
        return (<tr key={i}>
          <td style={{fontSize:12, maxWidth:320}}>
            <span style={{fontWeight:550, color: m.source==='synthetic' ? 'var(--text-secondary)' : 'var(--text-primary)'}}>{m.description}</span>
            <div className="meta" style={{fontSize:10}}>{m.agent || m.source} · {m.priority || ''} · {m.kind}</div>
          </td>
          <td><MoneyBadge money={m}/></td>
          <td className="tl" style={{fontSize:10, textTransform:'uppercase', letterSpacing:.04, color:confColor(m.confidence), fontWeight:600}}>{tier(m.confidence)}</td>
          <td className="meta tl" style={{fontSize:11, maxWidth:320}}>{m.basis}</td>
          <td className="tl"><span className="pill grey" style={{fontSize:10}}>{m.status||'open'}</span></td>
        </tr>);
      };
      return (<>
        <table><thead><tr><th>Evidenced finding</th><th>£/mo impact</th><th className="tl">Confidence</th><th className="tl">Basis</th><th className="tl">Status</th></tr></thead>
          <tbody>{evidenced.map(Row)}</tbody></table>
        {hypotheses.length > 0 && (<div style={{marginTop:'var(--s-5)'}}>
          <div className="card-section-title" style={{marginBottom:6}}>
            <h3 style={{margin:0, fontSize:13, color:'var(--text-muted)'}}>Hypotheses — unvalidated upside</h3>
            <span className="meta" style={{fontSize:11}}>low-confidence estimates · test before committing budget, don't bank them</span>
          </div>
          <table style={{opacity:0.85}}><thead><tr><th>Hypothesis</th><th>£/mo if it works</th><th className="tl">Confidence</th><th className="tl">Assumption</th><th className="tl">Status</th></tr></thead>
            <tbody>{hypotheses.map(Row)}</tbody></table>
        </div>)}
      </>);
    })()}
  </div>);
}

function MoneyHeaderStrip(){
  // Compact strip for the Overview tab. Headline £ numbers only.
  const P = window.FRKL_PATTERNS;
  if (!P || !P.money_rollup) return null;
  const r = P.money_rollup;
  return (<div className="card" style={{marginBottom:14, padding:'10px 14px', borderLeft:'3px solid #4ade80', display:'flex',gap:18,alignItems:'center',flexWrap:'wrap'}}>
    <div style={{fontSize:11,textTransform:'uppercase',letterSpacing:.05,color:'#7b7b87',fontWeight:700}}>£ AT STAKE THIS MONTH</div>
    <div style={{display:'flex',alignItems:'baseline',gap:6}}><span style={{fontSize:18,fontWeight:700,color:'#f87171'}}>£{(r.leakage/1000).toFixed(1)}k</span><span className="muted" style={{fontSize:11}}>leaking</span></div>
    <div style={{display:'flex',alignItems:'baseline',gap:6}}><span style={{fontSize:18,fontWeight:700,color:'#fbbf24'}}>£{(r.at_risk/1000).toFixed(1)}k</span><span className="muted" style={{fontSize:11}}>at risk</span></div>
    <div style={{display:'flex',alignItems:'baseline',gap:6}}><span style={{fontSize:18,fontWeight:700,color:'#4ade80'}}>£{(r.opportunity/1000).toFixed(1)}k</span><span className="muted" style={{fontSize:11}}>opportunity</span></div>
    <div style={{marginLeft:'auto',fontSize:11,color:'#7b7b87'}}>See <b>Intelligence</b> tab → Money on the table for breakdown</div>
  </div>);
}

function PHitBadge({phit}){
  if (!phit) return null;
  const v = phit.phit;
  const conf = phit.confidence;
  const n = phit.sample_size;
  // Colours: green >60%, amber 30-60%, red <30%. Faded if confidence is low.
  const color = v > 0.6 ? '#4ade80' : v >= 0.3 ? '#fbbf24' : '#f87171';
  const opacity = conf === 'high' ? 1 : conf === 'medium' ? 0.85 : 0.55;
  const tooltip = `P(hit) = ${(v*100).toFixed(0)}% based on ${phit.source} (n=${n}, ${conf} confidence). `
    + (n === 0 ? 'No history yet — pure prior. Badges become meaningful once 3+ actions of this type have closed.'
       : `Closed actions in this bucket: ${(phit.breakdown.agent_category?.hits ?? 0)} hits / ${(phit.breakdown.agent_category?.misses ?? 0)} misses.`);
  return (<span title={tooltip} style={{
    display:'inline-block',
    minWidth:46, textAlign:'center',
    fontSize:10, fontWeight:700,
    padding:'2px 6px', borderRadius:4,
    background: color + '22', color, border: `1px solid ${color}55`,
    opacity, letterSpacing:.04,
    cursor:'help',
  }}>{(v*100).toFixed(0)}%{conf === 'low' ? '?' : ''}</span>);
}

// Pairs of action keywords that pull in OPPOSITE directions. If both have
// open actions, surface a conflict banner so the user must consciously pick
// one — not silently try to do both.
const ACTION_TRADEOFFS = [
  {
    name: "Scale spend vs Tighten efficiency",
    keywords_a: ["scale", "increase budget", "push spend"],
    keywords_b: ["cut budget", "tighten", "pause", "reduce spend"],
    framework: "Pick one. Efficiency (cutting waste) and scale (adding spend) at the same time produce noise that masks both signals. Sequence: efficiency first (1-2 weeks), then scale into the cleaner baseline.",
  },
  {
    name: "Discount more vs Lift AOV",
    keywords_a: ["discount", "promo", "sale", "% off"],
    keywords_b: ["aov", "free-ship threshold", "raise price"],
    framework: "Heavy discounting and AOV growth fight each other. If raising AOV is the goal, freeze promo campaigns for 30 days and watch. If discounting is the goal, accept the AOV hit and quantify the contribution-margin trade-off explicitly.",
  },
  {
    name: "New customer acquisition vs Retention focus",
    keywords_a: ["new customer", "acquisition", "cold audience", "prospecting"],
    keywords_b: ["returning", "loyalty", "win-back", "vip", "retargeting only"],
    framework: "Both are valid but resource-constrained. Quantify: 1 new customer at £15 CAC vs 1 reactivated returning customer at £4 CAC — the math usually says retention first when CAC is high. State your bet explicitly.",
  },
];

function ActionConflictBanner(){
  const all = [];
  if (window.FRKL_INSIGHTS) {
    Object.entries(window.FRKL_INSIGHTS).forEach(([k,d]) => (d.actions||[]).forEach(a => all.push({...a, area:k})));
  }
  const STATUS = window.FRKL_ACTION_STATUS || {};
  const isOpen = (a) => {
    const st = STATUS[a.id];
    return !st || st.status === 'open' || st.status === 'needs-input' || st.status === 'needs-chrome';
  };
  const open = all.filter(isOpen).map(a => ({...a, text_lc: (a.text||'').toLowerCase()}));
  const conflicts = [];
  for (const t of ACTION_TRADEOFFS) {
    const hits_a = open.filter(a => t.keywords_a.some(k => a.text_lc.includes(k)));
    const hits_b = open.filter(a => t.keywords_b.some(k => a.text_lc.includes(k)));
    if (hits_a.length > 0 && hits_b.length > 0) {
      conflicts.push({...t, hits_a, hits_b});
    }
  }
  if (!conflicts.length) return null;
  return (<div className="card alert-warn" style={{marginBottom:'var(--s-3)'}}>
    <div className="micro" style={{color:'var(--warn)', marginBottom:'var(--s-3)'}}>
      ⚠ {conflicts.length} contradictory goal pair{conflicts.length>1?'s':''} open — pick one
    </div>
    {conflicts.map((c,i) => (<div key={i} style={{
      marginTop: i ? 'var(--s-4)' : 0,
      paddingTop: i ? 'var(--s-4)' : 0,
      borderTop: i ? '1px solid var(--border-subtle)' : 'none'
    }}>
      <div style={{fontWeight:600, color:'var(--text-primary)', marginBottom:'var(--s-2)', fontSize:13}}>{c.name}</div>
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'var(--s-3)', marginBottom:'var(--s-2)'}}>
        <div>
          <div className="micro" style={{marginBottom:'var(--s-1)'}}>Scale / grow ({c.hits_a.length})</div>
          {c.hits_a.map((a,j)=>(<div key={j} style={{fontSize:11.5, color:'var(--text-secondary)', marginBottom:2, lineHeight:1.5}}>· {a.text.slice(0,80)}{a.text.length>80?'…':''}</div>))}
        </div>
        <div>
          <div className="micro" style={{marginBottom:'var(--s-1)'}}>Efficiency / tighten ({c.hits_b.length})</div>
          {c.hits_b.map((a,j)=>(<div key={j} style={{fontSize:11.5, color:'var(--text-secondary)', marginBottom:2, lineHeight:1.5}}>· {a.text.slice(0,80)}{a.text.length>80?'…':''}</div>))}
        </div>
      </div>
      <div style={{fontSize:12, color:'var(--text-secondary)', background:'var(--bg-elevated)', padding:'var(--s-3)', borderRadius:'var(--r-sm)', borderLeft:'2px solid var(--good)', lineHeight:1.5}}>
        <b style={{color:'var(--good)'}}>Framework:</b> {c.framework}
      </div>
    </div>))}
  </div>);
}

// Areas roll up into a handful of themes an operator actually reviews by.
const ACTION_GROUP_OF = {meta:'Paid media', google:'Paid media', klaviyo:'Email', cro:'Site & CVR', shopify:'Site & CVR', creative:'Creative', economics:'Finance', cx:'Customer & retention', content:'Content', competitive:'Competitive'};
function moneyAbs(money){ return (money && money.monthly_impact_gbp!=null) ? Math.abs(money.monthly_impact_gbp) : 0; }
function gbpShort(v){ return v>=1000 ? curSym()+(v/1000).toFixed(1)+'k' : curSym()+Math.round(v); }
function ActionBoard(){
  const order={P1:0,P2:1,P3:2};
  const all=[];
  Object.entries(INS).forEach(([k,d])=>d.actions.forEach(a=>all.push({...a, agent:d.agent, area:k})));
  const [showDone, setShowDone] = useState(false);
  const [openGroups, setOpenGroups] = useState({});   // specialist groups collapsed by default (default-collapsed = less noise)
  const [liveAll, setLiveAll] = useState(false);       // live read shows top few, expand for the rest
  const [liveSort, setLiveSort] = useState({key:'gbp', dir:'desc'});   // sortable live-read table
  const [modalAction, setModalAction] = React.useState(null);
  const effStatus = (a) => isLocallyDone(a.id) ? "verified-done" : (STATUS[a.id]||{}).status;
  const done = all.filter(a => effStatus(a) === "verified-done");
  const open = all.filter(a => effStatus(a) !== "verified-done");
  const phitMap = (window.FRKL_PATTERNS && window.FRKL_PATTERNS.action_phit) || {};
  const moneyMap = (window.FRKL_PATTERNS && window.FRKL_PATTERNS.action_money) || {};
  // Only show a "needs you" flag when it's genuinely on the operator; hide internal states.
  const friendly = s => s==='needs-input' ? {t:'Needs your input', c:'input'} : s==='needs-chrome' ? {t:'Needs a site check', c:'chrome'} : null;

  // ── LIVE actions straight from the diagnostic engine (Crux) — coherent with the
  // diagnostic by construction. The specialist FRKL_INSIGHTS below are a static
  // (pending-refresh) review; where today's read contradicts them, they're flagged. ──
  const liveRead = (window.FRKL_DX_ANALYST && (window.FRKL_DX_ANALYST['30d'] || Object.values(window.FRKL_DX_ANALYST)[0])) || null;
  const liveFindings = [...((liveRead && liveRead.findings) || []), ...productFindings(), ...discountFindings(), ...markdownFindings(), ...cvrFindings()];
  const liveText = liveRead ? `${liveRead.headline||''} ${liveRead.narrative||''} ${liveFindings.map(f=>`${f.reasoning||''} ${f.recommendation||''}`).join(' ')}` : '';
  const ruledOutFatigue = /not (creative |audience )?fatigue|fatigue[^.]{0,30}(ruled out|not)|frequency[^.]{0,30}(low|healthy|down|1\.9)/i.test(liveText);
  const contradicts = (text) => ruledOutFatigue && /fatigu|refresh[^.]{0,18}creative/i.test(text||'');

  const renderRow = (a, i) => {
    const st = STATUS[a.id] || {};
    const localDone = isLocallyDone(a.id);
    const eff = localDone && st.status !== "verified-done" ? "verified-done" : st.status;
    const isDone = eff === "verified-done";
    const phit = phitMap[a.id];
    const showPhit = !isDone && phit && phit.sample_size >= 3;            // meaningful only with history
    const rawEv = localDone && st.status !== "verified-done" ? "Marked done locally — pending refresh to persist" : st.evidence;
    const why = rawEv && /\(target/i.test(rawEv) ? rawEv : (localDone ? rawEv : '');  // keep metric justification, drop ops noise
    const fs = !isDone ? friendly(eff) : null;
    const pdot = pClass(a.p);
    const contra = !isDone && contradicts(a.text);
    const money = moneyAbs(moneyMap[a.id]);
    return (<div className={"sp-row"+(isDone?" done":"")} key={i} style={{opacity:contra?0.6:1}}>
      <div className="sp-pri">
        <span className="dot" title={a.p+' priority'} style={{background:pdot==='red'?'var(--bad)':pdot==='amber'?'var(--warn)':'var(--text-muted)'}}/>
        <span className="lbl">{a.p}</span>
      </div>
      <div>
        <div className="sp-text" style={{textDecoration:contra?'line-through':'none',textDecorationColor:'var(--bad)'}}>{linkify(a.text)}</div>
        {contra && <div style={{fontSize:11,color:'var(--bad)',marginTop:2}}>⚠ Today's live read contradicts this (ad frequency is healthy — fatigue ruled out). Re-validate before acting.</div>}
        {why && <div className="sp-ev">{why}</div>}
        {isDone && st.impact && <ImpactLine impact={st.impact} resolvedAt={st.resolvedAt}/>}
        <div className="sp-cta">
          <span className="sp-agent" title={agentTitle(a.agent)}>{a.agent}</span>
          {!isDone && <button className="markbtn" onClick={()=>setModalAction(a)}>Mark done</button>}
        </div>
      </div>
      <div className="sp-status">
        {showPhit && <PHitBadge phit={phit} />}
        {fs ? <span className={'stat '+fs.c} title={fs.c==='chrome'?'Needs a manual check on the live site / Shopify — the data can flag it, but someone has to eyeball it to confirm.':'Waiting on a number or decision from you before it can proceed.'} style={{cursor:'help'}}>{fs.t}</span>
            : isDone ? <span className="stat done">Done</span>
            : <span style={{fontSize:11,color:'var(--text-faint)'}}>On track</span>}
      </div>
      <div className="sp-impact">
        {money>0 ? (<><span className="amt">{gbpShort(money)}</span><span className="per">/mo</span></>)
                 : <span className="dash">—</span>}
      </div>
    </div>);
  };
  const SpecialistHead = () => (<div className="sp-head">
    <span className="sp-hcell">Priority</span>
    <span className="sp-hcell">Action</span>
    <span className="sp-hcell">Status</span>
    <span className="sp-hcell right">£/mo</span>
  </div>);

  // Group open actions by theme; rank groups (and rows) by £ at stake.
  const groups = {};
  open.forEach(a => { const g = ACTION_GROUP_OF[a.area] || 'Other'; (groups[g] = groups[g] || []).push(a); });
  const groupList = Object.entries(groups).map(([g, items]) => {
    const sum = items.reduce((acc,a)=>acc+moneyAbs(moneyMap[a.id]), 0);
    items.sort((x,y)=> (contradicts(x.text)?1:0)-(contradicts(y.text)?1:0) || moneyAbs(moneyMap[y.id]) - moneyAbs(moneyMap[x.id]) || order[x.p]-order[y.p]);
    return {g, items, sum};
  }).sort((a,b)=> b.sum-a.sum || b.items.length-a.items.length);
  const totalMoney = open.reduce((acc,a)=>acc+moneyAbs(moneyMap[a.id]), 0);
  const contraCount = open.filter(a=>contradicts(a.text)).length;

  // Live actions from the diagnostic → board rows (verdict + confidence + £ + playbook).
  const renderLive = (f, i) => {
    const vs = verdictStyle(f.verdict);
    const CONF = {
      high: {lbl:'High confidence',   fg:'var(--good)',       bg:'rgba(110,231,183,0.12)'},
      med:  {lbl:'Medium confidence', fg:'var(--warn)',       bg:'rgba(245,158,11,0.12)'},
      low:  {lbl:'Low · validate',    fg:'var(--text-muted)', bg:'rgba(255,255,255,0.06)'},
    };
    const cf = CONF[f.confidence || 'med'] || CONF.med;
    // £ impact: right-aligned, magnitude only; muted for "expected" (context, not opportunity).
    const amt = f.gbp > 0 ? ('£' + (f.gbp >= 1000 ? (f.gbp/1000).toFixed(1) + 'k' : Math.round(f.gbp))) : null;
    const impColor = f.verdict === 'expected' ? 'var(--text-muted)' : 'var(--good)';
    return (
      <div className="live-row" key={'live'+i}>
        <div className="lr-verdict"><span className="lr-pill" style={{color:vs.fg, background:vs.bg}}>{vs.label}</span></div>
        <div className="lr-content">
          <div className="lr-title"><b>{f.area}.</b> {f.recommendation}</div>
          {f.metric && <div className="lr-ev">{f.metric}</div>}
          <div className="lr-cta"><PlaybookHint text={`${f.recommendation} ${f.metric} ${f.area}`}/><NavChip f={f}/></div>
        </div>
        <div className="lr-confcell"><span className="lr-pill lr-conf" style={{color:cf.fg, background:cf.bg}}>{cf.lbl}</span></div>
        <div className="lr-impact">
          {amt ? (<><span className="amt" style={{color:impColor}}>{amt}</span><span className="per">/mo</span></>)
               : <span className="per">—</span>}
        </div>
      </div>);
  };
  // Sortable header + sorted rows for the live-read table.
  const LIVE_RANK = { verdict:{act:3, monitor:2, expected:1}, confidence:{high:3, med:2, low:1} };
  const liveSortVal = (f) => {
    if(liveSort.key==='verdict')    return LIVE_RANK.verdict[f.verdict] || 0;
    if(liveSort.key==='confidence') return LIVE_RANK.confidence[f.confidence||'med'] || 0;
    if(liveSort.key==='area')       return (f.area||'').toLowerCase();
    return f.gbp || 0;                                                  // 'gbp'
  };
  const onLiveSort = (key) => setLiveSort(s => s.key===key ? {key, dir: s.dir==='asc'?'desc':'asc'} : {key, dir: key==='area'?'asc':'desc'});
  const liveHeadCell = (key, label, right) => {
    const active = liveSort.key===key;
    return (<button className={'live-hcell'+(active?' active':'')+(right?' right':'')} onClick={()=>onLiveSort(key)} title={`Sort by ${label.toLowerCase()}`}>
      {label}<span className="caret">{active ? (liveSort.dir==='asc'?'▲':'▼') : '↕'}</span>
    </button>);
  };
  const LiveHead = () => (<div className="live-head">
    {liveHeadCell('verdict','Priority')}
    {liveHeadCell('area','Action')}
    {liveHeadCell('confidence','Confidence')}
    {liveHeadCell('gbp','£/mo', true)}
  </div>);

  return (<div className="card">
    <div className="card-section-title">
      <h2 style={{margin:0}}>Action plan <span style={{color:'var(--text-faint)',fontWeight:400,fontSize:13}}>— live read first, ranked by £ impact</span></h2>
      <span className="meta">Crux live read{liveRead&&liveRead.generatedAt?` (${liveRead.generatedAt.slice(0,10)})`:''} · {open.length} specialist items{contraCount>0?` · ${contraCount} contradicted by today's read`:''}</span>
    </div>
    <ActionConflictBanner/>

    {/* LIVE — from the diagnostic engine, always coherent with the diagnostic card */}
    {liveFindings.length>0 && (<div style={{marginBottom:12}}>
      <div style={{display:'flex',alignItems:'center',gap:9,borderBottom:'1px solid var(--border-subtle)',padding:'9px 0 7px'}}>
        <span style={{width:7,height:7,borderRadius:'50%',background:'var(--accent)'}}/>
        <span style={{fontWeight:700,color:'var(--text-primary)',fontSize:13.5}}>Now — live read</span>
        <span style={{fontSize:11,color:'var(--text-faint)'}}>Crux · from today's diagnostic</span>
      </div>
      {(()=>{
        const dir = liveSort.dir==='asc' ? 1 : -1;
        const ranked=[...liveFindings].sort((a,b)=>{
          const va=liveSortVal(a), vb=liveSortVal(b);
          if(va<vb) return -1*dir; if(va>vb) return 1*dir;
          return findingScore(b)-findingScore(a);   // stable tiebreak by £-weighted score
        });
        const CAP=6; const shown=liveAll?ranked:ranked.slice(0,CAP); return (<>
        <LiveHead/>
        {shown.map(renderLive)}
        {ranked.length>CAP && <button onClick={()=>setLiveAll(v=>!v)} className="btn-ghost" style={{padding:'5px 11px',fontSize:11.5,marginTop:8}}>{liveAll?'Show fewer':`Show ${ranked.length-CAP} more`}</button>}
      </>); })()}
    </div>)}

    {/* SPECIALIST — dated agent review (LLM-generated, not the daily metric refresh) */}
    {(()=>{ const sm=(typeof window!=='undefined'&&window.FRKL_INSIGHTS_META)||{}; const run=sm.specialistRunAt; const age=run?Math.round((Date.now()-new Date(run))/86400000):null; const stale=age!=null&&age>7; return (
    <div style={{display:'flex',alignItems:'baseline',gap:8,marginBottom:2,flexWrap:'wrap'}}>
      <span style={{fontSize:11,letterSpacing:'.04em',textTransform:'uppercase',color:'var(--text-faint)'}}>Specialist agent review</span>
      <span style={{fontSize:11,color:stale?'var(--warn)':'var(--text-muted)'}}>· {run?`from ${run}${age!=null?` · ${age}d old`:''}`:'static'}{stale?' — needs an agent re-run; re-validate against the live read above':' — re-validate against the live read above'}</span>
    </div>); })()}
    <div style={{fontSize:11,color:'var(--text-faint)',lineHeight:1.5,margin:'4px 0 2px'}}>The <b style={{color:'#4ade80'}}>%</b> next to a status is the <b>hit-rate</b> — how often this <i>type</i> of action has actually moved the metric before (<span style={{color:'#4ade80'}}>green &gt;60%</span> · <span style={{color:'#fbbf24'}}>amber 30–60%</span> · <span style={{color:'#f87171'}}>red &lt;30%</span>; a “?” = small sample). Hover it for the track record.</div>
    <div style={{display:'flex', flexDirection:'column', gap:4}}>
      {groupList.map(({g, items, sum})=>(
        <div key={g}>
          <button onClick={()=>setOpenGroups(o=>({...o,[g]:!o[g]}))} style={{display:'flex',alignItems:'center',gap:9,width:'100%',background:'transparent',border:'none',borderBottom:'1px solid var(--border-subtle)',padding:'9px 0 7px',cursor:'pointer',textAlign:'left',marginTop:6}}>
            <span style={{color:'var(--text-faint)',display:'inline-flex',transform:openGroups[g]?'rotate(90deg)':'none',transition:'transform 120ms'}}><Icon name="chevron" size={12}/></span>
            <span style={{fontWeight:700,color:'var(--text-primary)',fontSize:13.5}}>{g}</span>
            <span style={{fontSize:11,color:'var(--text-faint)',background:'var(--border-subtle)',borderRadius:999,padding:'1px 7px'}}>{items.length}</span>
            {sum>0 && <span style={{marginLeft:'auto',fontSize:12,fontWeight:700,color:'var(--text-secondary)'}}>~{gbpShort(sum)}/mo</span>}
          </button>
          {openGroups[g] && <><SpecialistHead/>{items.map(renderRow)}</>}
        </div>
      ))}
    </div>
    <div style={{display:'flex',alignItems:'center',marginTop:'var(--s-4)'}}>
      <span className="meta">{done.length} closed</span>
      <div style={{flex:1}}/>
      <button onClick={()=>setShowDone(s=>!s)} className="btn-ghost" style={{padding:'5px 11px', fontSize:11.5}}>
        {showDone ? 'Hide closed' : `Show ${done.length} closed`}
      </button>
    </div>
    {showDone && done.length > 0 && (<div style={{marginTop:'var(--s-2)', paddingTop:'var(--s-3)', borderTop:'1px solid var(--border-subtle)'}}>
      <div style={{display:'flex', flexDirection:'column'}}>{done.map(renderRow)}</div>
    </div>)}
    {modalAction && <MarkDoneModal action={modalAction} onClose={()=>setModalAction(null)}/>}
  </div>);
}

function buildDaily(start){
  const map = {};
  const touch = d => (map[d] = map[d] || {date:d, metaSpend:0, googleSpend:0, revenue:0, sessions:0, emailRev:0, orders:0, discounts:0, totalSales:0});
  inRange(D.metaDaily,start).forEach(r=>{touch(r.date).metaSpend += r.cost||0;});
  inRange(D.googleAds,start).forEach(r=>{touch(r.date).googleSpend += r.cost||0;});
  inRange(D.shopify,start).forEach(r=>{const m=touch(r.date); m.revenue += r.netSales||0; m.orders += r.orders||0; m.discounts += r.discounts||0; m.totalSales += r.totalSales||0;});
  inRange(D.ga4,start).forEach(r=>{touch(r.date).sessions += r.sessions||0;});
  inRange(D.klaviyo,start).forEach(r=>{touch(r.date).emailRev += r.orderValue||0;});
  return Object.values(map).sort((a,b)=>a.date<b.date?-1:1).map(m=>({...m, paid:m.metaSpend+m.googleSpend, dlabel:m.date.slice(5)}));
}

function ChannelStreamPanel(){
  // Show DTC vs Wholesale vs Gifting breakdown over the last 30 days.
  const wh = D.shopifyWholesale || [], gi = D.shopifyGifting || [], oth = D.shopifyOther || [], dtc = D.shopify || [];
  if (!wh.length && !gi.length) return null;
  const all = (dtc).concat(wh).concat(gi).concat(oth);
  const dates = [...new Set(all.map(r=>r.date))].sort();
  const latest = dates[dates.length-1];
  if (!latest) return null;
  const cutoff = (()=>{ const d=new Date(latest); d.setDate(d.getDate()-29); return d.toISOString().slice(0,10); })();
  const win = (rows) => rows.filter(r=>r.date>=cutoff && r.date<=latest);
  const dt = win(dtc), wh30 = win(wh), gi30 = win(gi), ot30 = win(oth);
  const sum = (rows, k) => rows.reduce((a,r)=>a+(r[k]||0),0);
  const dtcRev = sum(dt,'netSales'), whRev = sum(wh30,'netSales'), giRev = sum(gi30,'netSales'), otRev = sum(ot30,'netSales');
  const dtcOrd = sum(dt,'orders'), whOrd = sum(wh30,'orders'), giOrd = sum(gi30,'orders'), otOrd = sum(ot30,'orders');
  const giDisc = sum(gi30,'discounts');
  const total = dtcRev + whRev + giRev + otRev || 1;
  // Per-stream daily trends so each channel tile carries a hover graph.
  const _cs = (rows,k) => rows.slice().sort((a,b)=>a.date<b.date?-1:1).map(r=>({d:(r.date||'').slice(5), v:+(r[k]||0).toFixed(0)}));
  const sDtc=_cs(dt,'netSales'), sWh=_cs(wh30,'netSales'), sGi=_cs(gi30,'orders'), sOt=_cs(ot30,'netSales');
  const _dot = c => (<span style={{display:'inline-block',width:6,height:6,borderRadius:'var(--r-full)',background:c,marginRight:6}}/>);
  return (<div className="card">
    <div className="card-section-title">
      <h2 style={{margin:0}}>Revenue by stream — last 30 days</h2>
      <span className="meta">Headline KPIs use <b>DTC only</b> · wholesale + gifting tracked separately</span>
    </div>
    <div className="row" style={{marginBottom:'var(--s-3)'}}>
      <KPI label={<>{_dot('var(--good)')}DTC (Online Store)</>} val={GBP(dtcRev)} sub={`${NUM(dtcOrd)} orders · ${PCT(dtcRev/total)} of revenue · AOV ${GBP(dtcOrd?dtcRev/dtcOrd:null)}`} series={sDtc} seriesLabel="DTC revenue · last 30 days" />
      <KPI label={<>{_dot('var(--warn)')}Wholesale (JL + Faire)</>} val={GBP(whRev)} sub={`${NUM(whOrd)} orders · ${PCT(whRev/total)} of revenue · AOV ${GBP(whOrd?whRev/whOrd:null)}`} series={sWh} seriesLabel="Wholesale revenue · last 30 days" />
      <KPI label={<>{_dot('var(--accent)')}Gifting (Draft Orders)</>} val={`${NUM(giOrd)} drops`} sub={`${GBP(giDisc)} retail value gifted · £0 revenue (100% comped)`} series={sGi} seriesLabel="Gifting drops · last 30 days" />
      <KPI label={<>{_dot('var(--text-muted)')}Other channels</>} val={GBP(otRev)} sub={`${NUM(otOrd)} orders · likely IG/FB Shop / POS`} series={sOt} seriesLabel="Other revenue · last 30 days" />
    </div>
    <div className="note">
      <b>Important context:</b> before this segmentation, headline metrics conflated all 4 streams. Discount rate looked like 36-47% (actually 12% on real DTC); AOV looked like £63 (actually £{Math.round(dtcOrd?dtcRev/dtcOrd:0)}). Two headline "crises" were data artefacts.
    </div>
  </div>);
}

function DailyPanel(){
  // "Today" view — what's happening right now, anomalies overnight, pacing through the month
  const meta = D.metaDaily || [], gads = D.googleAds || [], ga = D.ga4 || [], shop = D.shopify || [], kl = D.klaviyo || [];
  const dates = [...new Set([...shop.map(r=>r.date)])].sort();
  const latest = dates[dates.length-1];
  if (!latest) return null;
  const find = (rows) => rows.find(r => r.date === latest) || {};
  const prior7 = (rows) => rows.filter(r=>r.date<latest).slice(-7);
  const avgOf = (rows,k) => rows.length ? rows.reduce((a,r)=>a+(r[k]||0),0)/rows.length : 0;
  const sumOf = (rows,k) => rows.reduce((a,r)=>a+(r[k]||0),0);

  const yMeta = find(meta), yGads = find(gads), yShop = find(shop), yGa = find(ga), yKl = find(kl);
  const ySpend = (yMeta.cost||0) + (yGads.cost||0);
  const yRev = yShop.netSales||0;
  const yOrders = yShop.orders||0;
  const yMER = ySpend ? yRev/ySpend : null;
  const ySess = yGa.sessions||0;

  const pMeta7 = prior7(meta), pGads7 = prior7(gads), pShop7 = prior7(shop), pGa7 = prior7(ga);
  const pSpendAvg = avgOf(pMeta7,'cost') + avgOf(pGads7,'cost');
  const pRevAvg = avgOf(pShop7,'netSales');
  const pOrdAvg = avgOf(pShop7,'orders');
  const pMERavg = pSpendAvg ? pRevAvg/pSpendAvg : null;
  const pSessAvg = avgOf(pGa7,'sessions');

  // Month-to-date pacing
  const ym = latest.slice(0,7);
  const monthStart = ym + '-01';
  const dayOfMonth = parseInt(latest.slice(8,10));
  const yr = parseInt(latest.slice(0,4)), mo = parseInt(latest.slice(5,7));
  const daysInMonth = new Date(yr, mo, 0).getDate();
  const mtdMeta = meta.filter(r => r.date >= monthStart && r.date <= latest);
  const mtdGads = gads.filter(r => r.date >= monthStart && r.date <= latest);
  const mtdShop = shop.filter(r => r.date >= monthStart && r.date <= latest);
  const mtdSpend = sumOf(mtdMeta,'cost') + sumOf(mtdGads,'cost');
  const mtdRev = sumOf(mtdShop,'netSales');
  const projSpend = mtdSpend * (daysInMonth / dayOfMonth);
  const projRev = mtdRev * (daysInMonth / dayOfMonth);

  const delta = (cur, prev) => prev ? (cur - prev) / prev : null;
  const fmtD = (d) => d==null ? '' : (d>=0?'↑':'↓') + Math.round(Math.abs(d)*100) + '%';
  const dColor = (d, good='up') => {
    if (d==null || Math.abs(d) < 0.005) return '#7b7b87';
    const isGood = good==='down' ? d<0 : d>0;
    return isGood ? '#4ade80' : '#f87171';
  };

  // Anomalies
  const anomalies = [];
  const merDelta = delta(yMER, pMERavg);
  if (yMER!=null && pMERavg!=null && merDelta!=null && merDelta < -0.25) anomalies.push({sev:'red', text:`MER dropped ${Math.round(Math.abs(merDelta)*100)}% vs 7-day avg (${yMER.toFixed(2)}× vs ${pMERavg.toFixed(2)}×)`});
  if (yMER!=null && pMERavg!=null && merDelta!=null && merDelta > 0.30) anomalies.push({sev:'green', text:`MER up ${Math.round(merDelta*100)}% vs 7-day avg — what worked?`});
  const sDelta = delta(ySpend, pSpendAvg);
  if (sDelta != null && Math.abs(sDelta) > 0.40) anomalies.push({sev:'amber', text:`Spend ${sDelta>0?'jumped':'dropped'} ${Math.round(Math.abs(sDelta)*100)}% vs 7-day avg (${GBP(ySpend)} vs ${GBP(pSpendAvg)})`});
  // Creative frequency
  const creatives = D.creatives || [];
  const fatigued = creatives.filter(c => (c.frequency||0) >= 7).sort((a,b)=>(b.frequency||0)-(a.frequency||0));
  if (fatigued.length) anomalies.push({sev:'amber', text:`${fatigued.length} ad${fatigued.length>1?'s':''} at frequency ≥ 7×: ${fatigued.slice(0,2).map(c=>`${c.name} (${c.frequency.toFixed(1)}×)`).join(', ')}`});
  // Below-average conv rank spend
  const weakCre = creatives.filter(c => (c.qualConv||'').startsWith('Below'));
  if (weakCre.length) {
    const weakSpend = weakCre.reduce((a,c)=>a+(c.cost||0),0);
    const totSpend = creatives.reduce((a,c)=>a+(c.cost||0),0);
    if (weakSpend/totSpend > 0.30) anomalies.push({sev:'red', text:`${Math.round(weakSpend/totSpend*100)}% of Meta spend on ads flagged Below-average conv rank (${weakCre.length} ad${weakCre.length>1?'s':''})`});
  }
  // 7-day discount load
  const last7 = shop.slice(-7);
  const discR = sumOf(last7,'netSales') ? sumOf(last7,'discounts')/sumOf(last7,'netSales') : 0;
  if (discR > 0.35) anomalies.push({sev:'red', text:`Discount load (7d) at ${(discR*100).toFixed(0)}% — sustainability flag`});
  // Returns
  const retR = sumOf(last7,'totalSales') ? sumOf(last7,'returns')/sumOf(last7,'totalSales') : 0;
  if (retR > 0.10) anomalies.push({sev:'amber', text:`Return rate (7d) at ${(retR*100).toFixed(0)}% — investigate SKU hotspots`});

  const projVsBudgetSev = null; // No fixed monthly budget set — placeholder for future config

  // Trailing 14-day mini-trends so each pacing tile carries a hover graph.
  const _tail = dates.slice(-14);
  const _dm = {}; _tail.forEach(dt=>{ _dm[dt]={d:dt.slice(5), spend:0, rev:0}; });
  meta.forEach(r=>{ if(_dm[r.date]) _dm[r.date].spend += r.cost||0; });
  gads.forEach(r=>{ if(_dm[r.date]) _dm[r.date].spend += r.cost||0; });
  shop.forEach(r=>{ if(_dm[r.date]) _dm[r.date].rev += r.netSales||0; });
  const _tr = _tail.map(dt=>_dm[dt]);
  const sSpend = _tr.map(x=>({d:x.d, v:+x.spend.toFixed(0)}));
  const sRev   = _tr.map(x=>({d:x.d, v:+x.rev.toFixed(0)}));
  const sMER   = _tr.map(x=>({d:x.d, v: x.spend>0 ? +(x.rev/x.spend).toFixed(2) : 0}));
  // Cumulative MTD spend — the pacing line toward the projection.
  const _mtdDates = [...new Set(mtdShop.map(r=>r.date))].sort();
  let _run=0; const sMTD = _mtdDates.map(dt=>{ _run += (sumOf(mtdMeta.filter(r=>r.date===dt),'cost') + sumOf(mtdGads.filter(r=>r.date===dt),'cost')); return {d:dt.slice(5), v:+_run.toFixed(0)}; });

  return (<div className="card">
    <div className="card-section-title">
      <h2 style={{margin:0}}>Today's view</h2>
      <span className="meta">Latest day in data: <b style={{color:'var(--text-secondary)'}}>{latest}</b> · data auto-updates daily</span>
    </div>
    <div className="row" style={{marginBottom:'var(--s-4)'}}>
      <KPI label="Latest-day spend" val={GBP(ySpend)} sub={`7d avg ${GBP(pSpendAvg)}`} series={sSpend} seriesLabel="Daily spend · last 14 days" current={ySpend} prior={pSpendAvg} />
      <KPI label="Latest-day revenue" val={GBP(yRev)} sub={`${NUM(yOrders)} orders · 7d avg ${GBP(pRevAvg)}`} series={sRev} seriesLabel="Daily revenue · last 14 days" current={yRev} prior={pRevAvg} goodDirection="up" />
      <KPI label="Latest-day MER" val={yMER?yMER.toFixed(2)+'×':'—'} sub={`7d avg ${pMERavg?pMERavg.toFixed(2)+'×':'—'}`} series={sMER} seriesLabel="Daily MER · last 14 days" current={yMER} prior={pMERavg} goodDirection="up" />
      <KPI label="MTD pacing" val={GBP(mtdSpend)} sub={`Day ${dayOfMonth}/${daysInMonth} · proj. EOM ${GBP(projSpend)} spend · ${GBP(projRev)} rev`} series={sMTD} seriesLabel="Cumulative MTD spend" />
    </div>
    {anomalies.length > 0 && (<div>
      <div className="micro" style={{color:'var(--warn)', marginBottom:'var(--s-2)'}}>⚠ Flags — {anomalies.length}</div>
      <div style={{display:'flex', flexDirection:'column', gap:'var(--s-1)'}}>
        {anomalies.map((a,i)=>{
          const c = a.sev==='red' ? 'var(--bad)' : a.sev==='amber' ? 'var(--warn)' : 'var(--good)';
          return (<div key={i} style={{fontSize:12.5, padding:'8px 12px', borderLeft:`2px solid ${c}`, background:'var(--bg-elevated)', borderRadius:'0 var(--r-sm) var(--r-sm) 0', color:'var(--text-secondary)', lineHeight:1.5}}>{linkify(a.text)}</div>);
        })}
      </div>
    </div>)}
    {anomalies.length === 0 && <div style={{fontSize:12, padding:'10px 14px', background:'var(--good-bg)', color:'var(--good)', borderRadius:'var(--r-sm)', fontWeight:550}}>✓ No anomalies detected vs 7-day baseline.</div>}
  </div>);
}

// Calm-by-default: render a curated core of KPI tiles, collapse the rest behind a
// toggle so the page opens quiet. `children` are the secondary tiles — created in
// the parent scope, so all their data refs resolve. Holds its own open state.
function MoreKpis({count, children}){
  const [open, setOpen] = React.useState(false);
  return (<React.Fragment>
    {open && children}
    <button onClick={()=>setOpen(o=>!o)}
      style={{cursor:'pointer', border:'1px dashed var(--border-default)', background:'transparent',
        color:'var(--accent)', fontWeight:600, fontSize:13, borderRadius:'var(--r-md)',
        padding:'0 18px', minHeight:72, minWidth:128, display:'flex', alignItems:'center', justifyContent:'center', gap:6}}>
      {open ? '− Show fewer' : `+ ${count} more metrics`}
    </button>
  </React.Fragment>);
}

// Hover-explainer for each hero £ tile: what the bucket means + the top findings
// driving it. Turns a bare colour-coded number into "here's what & why".
function HeroStat({valK, color, label, explain, items, total, alignRight}){
  const [show, setShow] = React.useState(false);
  const money = (g)=> '£' + Math.round(Math.abs(g||0)).toLocaleString() + '/mo';
  return (
    <div className="hero-stat" style={{position:'relative', cursor:'help'}}
         onMouseEnter={()=>setShow(true)} onMouseLeave={()=>setShow(false)}>
      <div className="hero-stat-val" style={{color}}>£{valK}k</div>
      <div className="hero-stat-label" style={{borderBottom:'1px dotted var(--text-faint)', display:'inline-block', paddingBottom:1}}>
        {label} <span style={{fontSize:9, opacity:.55}} aria-hidden="true">&#9432;</span>
      </div>
      {show && (
        <div role="tooltip" style={{position:'absolute', top:'calc(100% + 10px)',
             left: alignRight?'auto':0, right: alignRight?0:'auto', zIndex:60, width:330,
             background:'var(--bg-elevated)', border:'1px solid var(--border-default)',
             borderRadius:'var(--r-md)', padding:'12px 14px', boxShadow:'var(--shadow-lg)',
             textAlign:'left', whiteSpace:'normal', fontWeight:400}}>
          <div style={{fontSize:12.5, color:'var(--text-secondary)', lineHeight:1.5}}>{explain}</div>
          {total ? (
            <div style={{marginTop:10, display:'flex', flexDirection:'column', gap:5}}>
              {total.map((t,i)=>(<div key={i} style={{display:'flex', justifyContent:'space-between', fontSize:12.5}}>
                <span style={{color:t.c}}>{t.k}</span><span style={{color:t.c, fontWeight:650}}>{money(t.v)}</span></div>))}
            </div>
          ) : (items && items.length ? (
            <div style={{marginTop:10}}>
              <div className="micro" style={{marginBottom:6}}>Top {items.length} driver{items.length>1?'s':''}</div>
              {items.map((it,i)=>(
                <div key={i} style={{padding:'5px 0', borderTop:i?'1px solid var(--border-subtle)':'none'}}>
                  <div style={{display:'flex', justifyContent:'space-between', gap:10, fontSize:12.5}}>
                    <span style={{color:'var(--text-primary)', fontWeight:550}}>{it.label}</span>
                    <span style={{color, fontWeight:650, whiteSpace:'nowrap'}}>{money(it.monthly_impact_gbp)}</span>
                  </div>
                  {it.basis && <div className="micro" style={{color:'var(--text-faint)', marginTop:2, lineHeight:1.4}}>{it.basis}</div>}
                </div>
              ))}
            </div>
          ) : <div className="micro" style={{marginTop:8, color:'var(--text-faint)'}}>No itemised findings in this bucket yet.</div>)}
        </div>
      )}
    </div>
  );
}

// ── This-week hero — the one card a founder needs to see on Monday morning ──
function ThisWeekHero(){
  const P = window.FRKL_PATTERNS;
  const r = (P && P.money_rollup) || {leakage:0, at_risk:0, opportunity:0, total:0};
  const moneyPatterns = (P && P.money_patterns) || [];
  const topFor = (k) => moneyPatterns.filter(m => m.kind === k)
    .sort((a, b) => Math.abs(b.monthly_impact_gbp||0) - Math.abs(a.monthly_impact_gbp||0)).slice(0, 5);
  const diff = (P && P.diff) || {new:[], resolved:[], stronger:[], weaker:[]};
  const actionMoney = (P && P.action_money) || {};
  const phitMap = (P && P.action_phit) || {};
  const STATUS = window.FRKL_ACTION_STATUS || {};

  // Build top-3 actions ranked by £/mo impact (with P(hit) as tiebreaker)
  const allActions = [];
  if (window.FRKL_INSIGHTS) {
    Object.entries(window.FRKL_INSIGHTS).forEach(([k, d]) => {
      (d.actions || []).forEach(a => allActions.push({...a, agent: d.agent, area: k}));
    });
  }
  const openActions = allActions.filter(a => {
    const st = STATUS[a.id];
    return !st || st.status === 'open' || st.status === 'needs-input' || st.status === 'needs-chrome';
  }).map(a => ({
    ...a,
    money: actionMoney[a.id]?.monthly_impact_gbp || 0,
    phit: phitMap[a.id]?.phit || 0,
  })).sort((a, b) => {
    const moneyDelta = Math.abs(b.money) - Math.abs(a.money);
    if (Math.abs(moneyDelta) > 100) return moneyDelta;
    return b.phit - a.phit;
  });
  const top3 = openActions.slice(0, 3);

  // Date framing
  const latest = dataEndOf();
  const latestDate = latest ? new Date(latest + 'T00:00:00Z') : new Date();
  const weekday = latestDate.toLocaleDateString('en-GB', {weekday:'long'});
  const dateStr = latestDate.toLocaleDateString('en-GB', {day:'numeric', month:'long'});

  // Topline narrative
  const totalK = (r.total / 1000).toFixed(1);
  const biggestKind = r.leakage >= r.at_risk && r.leakage >= r.opportunity ? 'leakage'
    : r.at_risk >= r.opportunity ? 'at_risk' : 'opportunity';
  const biggestLabel = biggestKind === 'leakage' ? 'active leakage to plug'
    : biggestKind === 'at_risk' ? 'concentration risk to diversify'
    : 'opportunity unlock to chase';

  return (<div className="hero">
    <div className="hero-bg"/>
    <div className="hero-content">
      <div className="hero-meta">
        <span className="micro" style={{color:'var(--accent)'}}>{weekday} · {dateStr}</span>
        <span style={{margin:'0 var(--s-2)', color:'var(--text-faint)'}}>·</span>
        <span className="micro">Operator weekly</span>
      </div>
      <h1 className="hero-headline">
        <span style={{color:'var(--accent)'}}>£{totalK}k/mo</span> in play this week
      </h1>
      <div className="hero-sub">
        Concentrated in <b style={{color:'var(--text-primary)'}}>{biggestLabel}</b>. The three highest-impact actions are queued below.
      </div>

      <div className="hero-stats">
        <HeroStat valK={(r.leakage/1000).toFixed(1)} color="var(--bad)" label="Leaking now"
          explain="Revenue going out the door right now — broken checkout/PDP steps, JS errors, over-discounting. The most urgent bucket: fixing these recovers money you're already losing."
          items={topFor('leakage')}/>
        <div className="hero-stat-divider"/>
        <HeroStat valK={(r.at_risk/1000).toFixed(1)} color="var(--warn)" label="At risk"
          explain="Revenue exposed but not yet lost — over-reliance on one channel, code or SKU, or a metric trending down. Worth de-risking before it bites."
          items={topFor('at_risk')}/>
        <div className="hero-stat-divider"/>
        <HeroStat valK={(r.opportunity/1000).toFixed(1)} color="var(--good)" label="Opportunity"
          explain="Upside you're not yet capturing — AOV, bundle attach, audience or range levers that could add revenue if pursued."
          items={topFor('opportunity')}/>
        <div className="hero-stat-divider"/>
        <HeroStat valK={totalK} color="var(--text-primary)" label="Total identified" alignRight
          explain="Everything money-tagged this week — leaking + at-risk + opportunity. These are illustrative estimates that can overlap, so they're not strictly additive. Read it as where to look, not a guaranteed sum."
          total={[{c:'var(--bad)',k:'Leaking now',v:r.leakage},{c:'var(--warn)',k:'At risk',v:r.at_risk},{c:'var(--good)',k:'Opportunity',v:r.opportunity}]}/>
      </div>
      <div className="micro" style={{color:'var(--text-faint)',marginTop:'var(--s-2)'}}>Illustrative — each line is a money-tagged <i>estimate</i>, not a guaranteed recovery, and findings can overlap so the total isn't strictly additive. Treat it as where to look, not a forecast.</div>

      <div className="hero-grid">
        <div className="hero-col">
          <div className="micro" style={{marginBottom:'var(--s-3)'}}>What changed since last run</div>
          {!diff.previous_run_at && <div className="meta">First run — comparison will appear next week.</div>}
          {diff.previous_run_at && (<div style={{display:'flex',flexDirection:'column',gap:'var(--s-2)'}}>
            <HeroChangeRow color="var(--bad)"  count={diff.new.length}      label="new findings"/>
            <HeroChangeRow color="var(--warn)" count={diff.stronger.length} label="strengthened"/>
            <HeroChangeRow color="var(--good)" count={diff.resolved.length} label="resolved"/>
            <HeroChangeRow color="var(--text-muted)" count={diff.weaker.length} label="weakened"/>
          </div>)}
        </div>
        <div className="hero-col">
          <div className="micro" style={{marginBottom:'var(--s-3)'}}>Do this week</div>
          {top3.length === 0 && <div className="meta">All open actions cleared. Sit tight until next refresh.</div>}
          {top3.map((a, i) => (<div key={a.id} className="hero-action">
            <div className="hero-action-rank">{i+1}</div>
            <div className="hero-action-body">
              <div className="hero-action-text">{linkify(a.text)}</div>
              <div className="hero-action-meta">
                <span className={'pill ' + (a.p==='P1'?'red':a.p==='P2'?'amber':'grey')} style={{fontSize:9.5,padding:'1px 6px'}}>{a.p}</span>
                <span className="meta" style={{fontSize:10.5}} title={agentTitle(a.agent)}>{a.agent}</span>
                {Math.abs(a.money) >= 100 && <span style={{
                  fontSize:10.5, fontWeight:700, color: a.money < 0 ? 'var(--bad)' : 'var(--good)',
                }}>£{Math.abs(a.money/1000).toFixed(1)}k/mo</span>}
              </div>
            </div>
          </div>))}
        </div>
      </div>
    </div>
  </div>);
}

function HeroChangeRow({color, count, label}){
  return (<div style={{display:'flex',alignItems:'baseline',gap:'var(--s-3)'}}>
    <div style={{fontSize:18, fontWeight:600, color, minWidth:28, letterSpacing:'-.01em'}}>{count}</div>
    <div style={{fontSize:12.5, color:'var(--text-secondary)'}}>{label}</div>
  </div>);
}

// Hoisted to module scope so its identity is stable across ContributionCard
// re-renders — otherwise React remounts the whole subtree on every keystroke
// and the focused input is destroyed (only the first character would land).
function CmRow({label, amount, bold, color, top}){
  return (<div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,padding:'7px 0',borderTop: top||'1px solid var(--border-subtle)', fontWeight:bold?700:400, color:color||'var(--text-secondary)'}}>
    <span style={{display:'flex',alignItems:'center'}}>{label}</span>
    <span style={{fontVariantNumeric:'tabular-nums',whiteSpace:'nowrap'}}>{amount}</span>
  </div>);
}

// ── Operator diagnostic ────────────────────────────────────────────────────
// Deterministic cross-metric engine: reads the full live metric set, applies
// the operator model (funnel × unit economics × margin) against DTC benchmarks,
// estimates the £ contribution unlock for each gap, and returns the binding
// constraint + the highest-leverage actions (root cause, not 30 observations).
// ── Evidence layer ───────────────────────────────────────────────────────────
// Turns raw period-vs-prior deltas into analyst-grade context so the diagnostic
// can tell real decay from expected reversion. This is the "look sideways before
// concluding" step: decompose the move, detect events (promos), pick a baseline.
function pctChange(cur, prev){ return (prev!=null && prev!==0 && cur!=null) ? (cur-prev)/Math.abs(prev) : null; }
function signed(p){ return p==null ? '—' : `${p>=0?'+':''}${(p*100).toFixed(0)}%`; }

// Detect promo windows in a daily series: contiguous runs where discount load sits
// materially above the series' own median. Returns [{start,end,days,avgLoad}].
function detectPromoWindows(rows){
  if(!rows || rows.length < 4) return [];
  const load = rows.map(d=> d.totalSales>0 ? d.discounts/d.totalSales : 0);
  const s = [...load].sort((a,b)=>a-b);
  const med = s[Math.floor(s.length/2)] || 0;
  const thresh = Math.max(med*1.6, med+0.08, 0.15);   // promo day = clearly above the brand's own norm
  const out = []; let run = null;
  rows.forEach((d,i)=>{
    if(load[i] >= thresh){ run = run || {a:i,b:i}; run.b = i; }
    else if(run){ out.push(run); run = null; }
  });
  if(run) out.push(run);
  return out.filter(r=> r.b-r.a+1 >= 2).map(r=>({
    start: rows[r.a].dlabel, end: rows[r.b].dlabel, days: r.b-r.a+1,
    avgLoad: load.slice(r.a,r.b+1).reduce((x,y)=>x+y,0)/(r.b-r.a+1)
  }));
}

// ── Operator event log helpers ──
// Events are ground-truth context the metrics can't contain (promos, launches,
// price changes, deliberate spend changes…). Sourced from window.FRKL_EVENTS
// (generated from OI) merged with anything the operator logged live (localStorage).
const EVENT_META = {
  promo:        {label:'Promo',         icon:'🏷️'},
  launch:       {label:'Launch',        icon:'🚀'},
  price_change: {label:'Price change',  icon:'💷'},
  spend_change: {label:'Spend change',  icon:'📈'},
  stockout:     {label:'Stockout',      icon:'📦'},
  pr:           {label:'PR / influencer', icon:'📣'},
  other:        {label:'Event',         icon:'📌'},
};
function loadBrandEvents(){
  let evs = (typeof window!=='undefined' && Array.isArray(window.FRKL_EVENTS)) ? window.FRKL_EVENTS.slice() : [];
  try {
    const local = JSON.parse(localStorage.getItem('frkl-brand-events') || '[]');
    if(Array.isArray(local)) evs = evs.concat(local);
  } catch(e){ /* ignore */ }
  return evs.filter(e=>e && e.startsOn);
}
function eventOverlaps(ev, ws, we){
  const s = ev.startsOn, e = ev.endsOn || ev.startsOn;
  return !!(s && s <= we && e >= ws);
}
function eventDateLabel(ev){
  const s = (ev.startsOn||'').slice(5), e = (ev.endsOn||'').slice(5);
  return e && e !== s ? `${s}–${e}` : s;
}

// Build the merged pin list for a trend chart: operator-logged events PLUS the
// brand's major site-wide sales (concentrated discount campaigns — NOT always-on
// affiliate codes). Each pin snaps to the nearest chart bucket <= its date and
// carries a rich `tip` so the chart stays clean and the detail lives on hover.
//
// `buckets` may be either an array of YYYY-MM-DD strings (axis key == date, e.g.
// the weekly CVR chart) OR an array of {x, date} objects where `x` is the axis
// category value and `date` is the real YYYY-MM-DD to snap against (e.g. the
// daily spend↔revenue chart, whose axis key is a MM-DD label). The returned
// pin `x` is always the axis value a ReferenceLine should match.
function buildChartPins(buckets){
  if(!buckets || !buckets.length) return [];
  const rows = buckets.map(b => (typeof b === 'string') ? {x:b, date:b} : b);
  const minW = rows[0].date;
  const snap = (d)=>{ if(!d || d < minW) return null; let pin=null; for(let k=0;k<rows.length;k++){ if(rows[k].date<=d) pin=rows[k].x; else break; } return pin; };
  const pins = [];
  // 1) operator-logged ground-truth events
  loadBrandEvents().forEach(e=>{ const x = snap(e.startsOn); if(x==null) return; const mt = EVENT_META[e.type]||EVENT_META.other;
    pins.push({x, icon:mt.icon, title:(e.title||mt.label), date:e.startsOn, detail:mt.label}); });
  // 2) major site-wide sales derived from discount codes — exclude always-on (standing/affiliate)
  //    codes; keep concentrated campaigns with meaningful £. Pin at each code's peak-discount week.
  const codes = (typeof window!=='undefined' && window.FRKL_DISCOUNT_CODES && window.FRKL_DISCOUNT_CODES.codes) || [];
  codes.filter(c=>{
      if(!c || c.pattern==='always-on') return false;
      const concentrated = c.pattern==='spike' || c.pattern==='one-off' || (c.pattern==='recurring' && (c.spanDays||0)<=45);
      return concentrated && (c.discount||0) >= 120;
    })
    .sort((a,b)=>(b.discount||0)-(a.discount||0)).slice(0,6)
    .forEach(c=>{
      let pk=null; (c.series||[]).forEach(p=>{ if(!pk || p.d>pk.d) pk=p; });
      if(!pk) return; const x = snap(pk.w); if(x==null) return;
      const rate = c.discountRate!=null ? Math.round(c.discountRate*100)+'% off' : 'sale';
      pins.push({x, icon:'🏷️', title:c.code, date:pk.w, sale:true,
        detail:`${rate} · £${Math.round(c.discount)} given · ${c.orders} orders`});
    });
  // 3) collapse pins landing in the same bucket so markers never crowd; sale leads the badge
  const byX = {};
  pins.forEach(p=>{ (byX[p.x] = byX[p.x] || []).push(p); });
  return Object.keys(byX).map(x=>{
    const g = byX[x], head = g.find(p=>p.sale) || g[0];
    const tip = g.map(p=> `${p.icon} ${p.title}${p.detail? ' — '+p.detail : ''}  (${(p.date||'').slice(5)})`).join('\n');
    return {x, icon:head.icon, n:g.length, tip};
  });
}

// Hoverable pin marker rendered as a Recharts ReferenceLine label. Native SVG <title>
// gives an instant tooltip on hover ("what is this pin for?") with zero layout risk.
function PinMarker(props){
  const vb = props.viewBox || {}; const cx = vb.x || 0; const top = (vb.y || 0);
  return (
    <g style={{cursor:'help'}}>
      <title>{props.tip}</title>
      <rect x={cx-10} y={top} width={20} height={18} fill="transparent"/>
      <text x={cx} y={top+12} textAnchor="middle" fontSize={13}>{props.icon}</text>
      {props.n>1 ? <text x={cx+9} y={top+5} textAnchor="middle" fontSize={8} fill="var(--text-faint)" fontWeight={700}>{'+'+(props.n-1)}</text> : null}
    </g>
  );
}

// Build the context bundle the diagnostic reasons over.
function buildEvidence(a){
  const {mer,pMer,paid,pPaid,rev,pRev,orders,pOrders,discLoad,pDiscLoad,histDaily} = a;
  const ev = a.events || {current:[], prior:[], all:[]};
  const curEv = ev.current || [], priEv = ev.prior || [];
  const aov = orders>0 ? rev/orders : null, pAov = pOrders>0 ? pRev/pOrders : null;
  const decomp = {
    spendChg: pctChange(paid, pPaid), revChg: pctChange(rev, pRev),
    ordersChg: pctChange(orders, pOrders), aovChg: pctChange(aov, pAov)
  };
  const detected = detectPromoWindows(histDaily || []);
  const notes = [];

  // Ground-truth events beat inference. A promo logged in the prior period (but not
  // the current one) makes the prior baseline a promo-inflated one → reversion.
  const priorPromoEvent = priEv.some(e=>e.type==='promo') && !curEv.some(e=>e.type==='promo');
  const priorPromoHeuristic = pDiscLoad!=null && discLoad!=null && pDiscLoad > discLoad + 0.06 && pDiscLoad > 0.18;
  const priorPromo = priorPromoEvent || priorPromoHeuristic;
  // A deliberate spend change logged in the current period reframes an MER drop.
  const spendChangeEvent = curEv.find(e=>e.type==='spend_change') || null;
  const spendChangeLogged = !!spendChangeEvent;

  const revLed = decomp.revChg!=null && decomp.revChg < -0.04 && (decomp.spendChg==null || decomp.spendChg < 0.10);
  const merFell = mer!=null && pMer!=null && mer < pMer*0.97;
  const merConfounded = merFell && priorPromo && revLed;

  if(merConfounded){
    const why = priorPromoEvent
      ? `the prior period included a logged promo (${eventDateLabel(priEv.find(e=>e.type==='promo'))})`
      : `prior period ran hotter on discounts (${(pDiscLoad*100).toFixed(0)}% load vs ${(discLoad*100).toFixed(0)}% now)`;
    notes.push(`${why[0].toUpperCase()+why.slice(1)} — a promo inflated the prior MER, so this period's lower MER is largely reversion, not decay.`);
  }
  if(spendChangeLogged && decomp.spendChg!=null && decomp.spendChg>0.10){
    notes.push(`You logged a deliberate spend change this period (${spendChangeEvent.title}, ${eventDateLabel(spendChangeEvent)}) — the MER dip is read as the cost of that test, not unplanned fatigue.`);
  }
  if(!priorPromoEvent && detected.length){
    const e = detected[detected.length-1];
    notes.push(`Detected a promo window in the trailing data (${e.start}–${e.end}, ~${(e.avgLoad*100).toFixed(0)}% avg discount load) — period comparisons spanning it are interpreted with care.`);
  }

  // Events overlapping either window, for the "Context considered" display.
  const seen = new Set();
  const eventLines = [...curEv, ...priEv].filter(e=>{ const k=e.id||e.title+e.startsOn; if(seen.has(k))return false; seen.add(k); return true; })
    .map(e=>({text:`${e.title} (${eventDateLabel(e)})`, source:e.source||'operator', type:e.type}));

  return {aov, pAov, decomp, events:detected, eventLines, notes, merConfounded, priorPromo,
          priorPromoEvent, spendChangeLogged, spendChangeEvent, revLed, priorDiscLoad:pDiscLoad, discLoad};
}

function runDiagnostic(m, ctx){
  ctx = ctx || {};
  const f = [];
  const aov = m.orders>0 ? m.rev/m.orders : 0;
  const gm = m.gm || 0;
  // 1. Conversion rate vs the single CVR benchmark — usually the biggest revenue lever.
  if (m.cvr!=null && m.cvr < CVR_BENCH && m.sessions>0){
    const gbp = m.sessions*(CVR_BENCH - m.cvr)*aov*gm;
    f.push({sev: m.cvr<CVR_BENCH*0.75?'red':'amber', area:'Conversion', metric:`CVR ${(m.cvr*100).toFixed(2)}% vs ${CVR_BENCH_LABEL} target`,
      title:'Site conversion is throttling revenue', gbp,
      evidence:`${NUM(m.sessions)} sessions converting at ${(m.cvr*100).toFixed(2)}% — you're paying for visits that don't convert.`,
      action:'Fix cart→checkout friction + PDP before adding spend; every 0.1pt of CVR is more revenue than more traffic.'});
  }
  // 2. LTV:CAC vs 3× scaling threshold.
  if (m.ltvCac!=null && m.ltvCac < 3 && m.cac!=null){
    f.push({sev: m.ltvCac<1.5?'red':'amber', area:'Unit economics', metric:`LTV:CAC ${m.ltvCac.toFixed(1)}× vs 3× target`,
      title:'Acquisition economics below the scaling threshold', gbp:0,
      evidence:`Each acquired customer returns ${m.ltvCac.toFixed(1)}× their £${Math.round(m.cac)} CAC. Below 3×, more spend erodes value.`,
      action:'Lift repeat rate (post-purchase flows) or cut CAC (creative/targeting) before scaling spend.'});
  }
  // 3. Discount load vs 20% ceiling — margin recapture on the excess.
  if (m.discLoad!=null && m.discLoad > 0.20){
    f.push({sev: m.discLoad>0.30?'red':'amber', area:'Margin', metric:`Discount load ${(m.discLoad*100).toFixed(0)}% vs ≤20%`,
      title:'Discounting is compressing contribution', gbp:m.rev*(m.discLoad-0.20)*gm,
      evidence:`${(m.discLoad*100).toFixed(0)}% of gross sales given away in discounts — above the 20% healthy ceiling.`,
      action:'Audit always-on codes + affiliate rates; protect full-price demand.'});
  }
  // 4. Return rate vs 10% — pure margin leak.
  if (m.returnRate!=null && m.returnRate > 0.10){
    f.push({sev:'amber', area:'Margin', metric:`Return rate ${(m.returnRate*100).toFixed(1)}% vs ≤10%`,
      title:'Returns are leaking contribution', gbp:m.rev*(m.returnRate-0.10)*gm,
      evidence:`${(m.returnRate*100).toFixed(1)}% of units returned — each point is pure margin lost.`,
      action:'Isolate the SKUs/sizes driving returns; fix sizing guidance + PDP imagery.'});
  }
  // 5. MER falling — but decompose and confounder-check before calling it decay.
  if (m.mer!=null && m.pMer!=null && m.mer < m.pMer*0.97 && m.paid>0){
    const dc = ctx.decomp || {};
    const drivers = [];
    if(dc.spendChg!=null) drivers.push(`spend ${signed(dc.spendChg)}`);
    if(dc.revChg!=null)   drivers.push(`revenue ${signed(dc.revChg)}`);
    if(dc.aovChg!=null)   drivers.push(`AOV ${signed(dc.aovChg)}`);
    const driverTxt = drivers.length?` (${drivers.join(', ')})`:'';
    if(ctx.merConfounded){
      // Expected reversion after a promo ended — surfaced as context, not an action.
      f.push({sev:'info', area:'Efficiency', metric:`MER ${m.mer.toFixed(2)}× (was ${m.pMer.toFixed(2)}×) — expected`, gbp:0, confidence:'high',
        title:'MER dip is a post-promo reversion, not efficiency decay',
        evidence:`MER fell on the revenue side${driverTxt}, and the prior period carried a promo (discount load ${(ctx.priorDiscLoad*100).toFixed(0)}% vs ${(ctx.discLoad*100).toFixed(0)}% now). Underlying efficiency looks stable ex-promo.`,
        action:'No action — expected after the promo ended. Re-check once discounts have been normalised for a full period; only treat as decay if MER keeps falling then.'});
    } else if(ctx.spendChangeLogged && dc.spendChg!=null && dc.spendChg>0.10){
      // Operator logged a deliberate spend increase → it's a test to judge on payback, not fatigue.
      f.push({sev:'info', area:'Efficiency', metric:`MER ${m.mer.toFixed(2)}× (was ${m.pMer.toFixed(2)}×) — logged spend test`, gbp:0, confidence:'high',
        title:'MER dip aligns with your logged spend increase — watch payback, not fatigue',
        evidence:`MER fell on the spend side${driverTxt}. You logged "${ctx.spendChangeEvent.title}" this period, so the lower MER is the expected cost of a deliberate scale-up — judge it on payback over the test window, not as unplanned fatigue.`,
        action:'No action yet — track contribution and CAC against the test\'s payback horizon before deciding to hold or pull back.'});
    } else {
      const fatigue = dc.spendChg!=null && dc.spendChg>0.10;
      f.push({sev:'amber', area:'Efficiency', metric:`MER ${m.mer.toFixed(2)}× (was ${m.pMer.toFixed(2)}×)`, confidence:'med',
        title:'Ad efficiency falling as spend scales', gbp:m.paid*(m.pMer-m.mer),
        evidence:`Each £ of spend now returns ${m.mer.toFixed(2)}× vs ${m.pMer.toFixed(2)}× prior${driverTxt} — ${fatigue?'spend is scaling into a fatiguing audience':'demand is softening faster than spend is coming down'}.`,
        action: fatigue?'Pause scaling; refresh fatigued creative + fix the conversion leak first.':'Hold spend flat and protect efficiency until demand recovers; don\'t cut winning campaigns into the dip.'});
    }
  }
  // 6. Thin / negative contribution margin.
  if (m.cmPct!=null && m.cmPct < 0.10){
    f.push({sev: m.cmPct<0?'red':'amber', area:'Profitability', metric:`Contribution margin ${(m.cmPct*100).toFixed(0)}%`, gbp:0,
      title: m.cmPct<0?'Selling below contribution breakeven':'Contribution margin is thin',
      evidence:`After COGS + ad spend, contribution is ${(m.cmPct*100).toFixed(0)}% of revenue.`,
      action:'The levers above (CVR, discount, CAC) feed this — fix the top one and contribution follows.'});
  }
  f.sort((a,b)=>(b.gbp||0)-(a.gbp||0));
  const actions = f.filter(x=>x.sev!=='info');
  const context = f.filter(x=>x.sev==='info');
  const top = actions.slice(0,3);
  return {findings: top, context, notes: ctx.notes||[], eventLines: ctx.eventLines||[], inPlay: top.reduce((a,x)=>a+(x.gbp||0),0), count: actions.length};
}

function ContextConsidered({dx}){
  const evs = dx.eventLines || [];
  if(!dx.context.length && !dx.notes.length && !evs.length) return null;
  const srcStyle = s => s==='inferred' ? {fg:'var(--text-muted)',bg:'rgba(255,255,255,0.05)',lbl:'detected'}
                       : s==='shopify' ? {fg:'var(--accent)',bg:'rgba(124,140,255,0.12)',lbl:'shopify'}
                       : {fg:'var(--good)',bg:'rgba(110,231,183,0.10)',lbl:'logged'};
  return (<div style={{marginTop:12,padding:'10px 14px',borderRadius:'var(--r-md)',background:'rgba(255,255,255,0.02)',border:'1px solid var(--border-subtle)'}}>
    <div style={{fontSize:11,letterSpacing:'.05em',textTransform:'uppercase',color:'var(--text-faint)',marginBottom:6}}>Context considered</div>
    {evs.map((e,i)=>{ const ss=srcStyle(e.source); const em=(EVENT_META[e.type]||EVENT_META.other); return (
      <div key={'e'+i} style={{fontSize:12.5,color:'var(--text-secondary)',lineHeight:1.5,marginBottom:4,display:'flex',gap:8,alignItems:'center'}}>
        <span>{em.icon}</span><span style={{color:'var(--text-primary)'}}>{e.text}</span>
        <span style={{fontSize:9.5,fontWeight:700,letterSpacing:'.05em',color:ss.fg,background:ss.bg,padding:'1px 6px',borderRadius:999,textTransform:'uppercase'}}>{ss.lbl}</span>
      </div>);})}
    {dx.notes.map((n,i)=>(<div key={'n'+i} style={{fontSize:12.5,color:'var(--text-secondary)',lineHeight:1.5,marginBottom:4,display:'flex',gap:8}}><span style={{color:'var(--text-faint)'}}>·</span><span>{n}</span></div>))}
    {dx.context.map((x,i)=>(<div key={'c'+i} style={{display:'flex',gap:8,alignItems:'flex-start',marginTop:6}}>
      <span style={{width:7,height:7,borderRadius:'50%',background:'var(--accent)',marginTop:5,flexShrink:0}}/>
      <div style={{flex:1}}>
        <div style={{fontWeight:600,color:'var(--text-primary)',fontSize:13}}>{x.title} <span style={{fontWeight:400,color:'var(--text-faint)'}}>· {x.metric}</span></div>
        <div style={{fontSize:12.5,color:'var(--text-secondary)',marginTop:2,lineHeight:1.5}}>{x.evidence}</div>
        <div style={{fontSize:12.5,color:'var(--text-muted)',marginTop:2,lineHeight:1.5}}>→ {x.action}</div>
      </div>
    </div>))}
  </div>);
}

// Layer 2 — the LLM analyst's read (from diagnostic-analyst edge fn, generated at
// snapshot time). Reasons over the evidence bundle with confidence + blindspots.
function verdictStyle(v){
  if(v==='act')      return {label:'ACT NOW', bg:'rgba(255,99,99,0.12)',  fg:'var(--bad)'};
  if(v==='monitor')  return {label:'MONITOR', bg:'rgba(124,140,255,0.12)', fg:'var(--accent)'};
  return {label:'EXPECTED', bg:'rgba(255,255,255,0.05)', fg:'var(--text-muted)'};   // 'expected'
}
function Disclosure({label, open, onToggle}){
  return (<button onClick={onToggle} style={{display:'flex',alignItems:'center',gap:7,width:'100%',background:'transparent',border:'none',borderTop:'1px solid var(--border-subtle)',padding:'10px 0 2px',cursor:'pointer',color:'var(--text-secondary)',fontSize:12.5,fontWeight:600,textAlign:'left'}}>
    <span style={{color:'var(--text-faint)',transition:'transform 120ms',transform:open?'rotate(90deg)':'none',display:'inline-flex'}}><Icon name="chevron" size={12}/></span>{label}
  </button>);
}
// Confidence drives BEHAVIOUR, not decoration: high = directive, med = likely,
// low = a hypothesis to validate (never presented as a command).
function confChip(level){
  const m = {
    high: {lbl:'High confidence', fg:'var(--good)', bg:'rgba(110,231,183,0.12)'},
    med:  {lbl:'Medium confidence', fg:'var(--warn)', bg:'rgba(245,158,11,0.12)'},
    low:  {lbl:'Low · validate first', fg:'var(--text-muted)', bg:'rgba(255,255,255,0.06)'},
  };
  const c = m[level] || m.med;
  return <span style={{fontSize:9,fontWeight:700,letterSpacing:'.04em',color:c.fg,background:c.bg,padding:'2px 7px',borderRadius:999,whiteSpace:'nowrap'}}>{c.lbl}</span>;
}
// Close the loop: a recommendation isn't useful to a non-expert unless they know
// HOW. Keyword-match an action to a step-by-step playbook (works on live LLM text too).
const PLAYBOOKS = [
  {match:/geo-?holdout|holdout|incremental|spend-?down|true paid|in-platform/i,
   title:'How to run a geo-holdout (measure true paid return)',
   steps:[
     "Pick two regions you advertise to that normally behave alike — e.g. UK (test) and Ireland (control).",
     "Keep the control region's budget unchanged. In the test region, cut paid spend by ~half (or pause it) for 2–3 full weeks.",
     "Track TOTAL revenue in each region (all channels) — not Meta/Google's reported ROAS.",
     "If test-region revenue barely moves, paid was mostly taking credit for sales you'd get anyway. If it drops sharply, paid is genuinely driving demand.",
     "Incremental MER = revenue you lost ÷ spend you removed. Use that as your scale-up floor — not the blended topline.",
   ],
   caution:"Run it long enough to clear the buy-consideration lag, and don't overlap a promo or peak week."},
  {match:/checkout|cart→checkout|cart to checkout|abandoned|payment option/i,
   title:'How to audit the cart → checkout leak',
   steps:[
     "On your phone, add an item and go all the way to the payment screen. Note every tap and every surprise.",
     "Make sure the shipping cost shows on the cart page — not first revealed at checkout. Late shipping cost is the #1 abandon cause.",
     "Check Shop Pay / Apple Pay / Google Pay appear at the top of checkout — one-tap pay lifts completion.",
     "Open the browser console (right-click → Inspect → Console) on the cart and checkout pages; get any red JS errors fixed — a broken coupon field can block the step.",
     "Re-check the cart→checkout and checkout→purchase rates weekly; aim for each above ~45–55%.",
   ]},
  {match:/out[-\s]?of[-\s]?stock|stockout|restock|inventory/i,
   title:'How to clear the out-of-stock drag',
   steps:[
     "In Shopify → Products, filter Inventory = 0 to list everything out of stock.",
     "For best-sellers in that list: reorder now, and switch on a Klaviyo back-in-stock alert to capture waiting demand.",
     "For the rest: unpublish them or hide from collections + search so shoppers don't hit dead ends.",
     "Exclude all out-of-stock items from your Meta/Google product feed so you stop paying to send clicks to them.",
   ]},
  {match:/discount|promo|stacking|popup|always-on code/i,
   title:'How to tighten discount leakage',
   steps:[
     "List every live discount: the on-site popup code, any always-on codes, affiliate/influencer codes, and active sales.",
     "Check whether they stack (popup + code + sale on one order) — that's where margin quietly leaks.",
     "Set one rule: codes don't stack, and cap total discount per order (e.g. 15%).",
     "Switch the first-visit popup to exit-intent / after-30s, so you're not discounting buyers who'd pay full price.",
   ]},
];
function PlaybookHint({text}){
  const [open, setOpen] = React.useState(false);
  const pb = PLAYBOOKS.find(p => p.match.test(text || ''));
  if(!pb) return null;
  return (<div style={{marginTop:9}}>
    <button onClick={()=>setOpen(o=>!o)} style={{display:'inline-flex',alignItems:'center',gap:6,background:'transparent',border:'none',padding:0,cursor:'pointer',color:'var(--accent)',fontSize:12.5,fontWeight:600}}>
      <span style={{display:'inline-flex',transform:open?'rotate(90deg)':'none',transition:'transform 120ms'}}><Icon name="chevron" size={12}/></span>{open?'Hide steps':'Show me how →'}
    </button>
    {open && (<div style={{marginTop:6,padding:'10px 14px',borderRadius:'var(--r-md)',background:'rgba(255,255,255,0.02)',border:'1px solid var(--border-subtle)'}}>
      <div style={{fontSize:12,fontWeight:700,color:'var(--text-primary)',marginBottom:6}}>{pb.title}</div>
      <ol style={{margin:0,paddingLeft:18,fontSize:12.5,color:'var(--text-secondary)',lineHeight:1.6}}>
        {pb.steps.map((s,i)=><li key={i} style={{marginBottom:4}}>{s}</li>)}
      </ol>
      {pb.caution && <div style={{fontSize:11.5,color:'var(--text-faint)',marginTop:7,lineHeight:1.5}}>⚠ {pb.caution}</div>}
    </div>)}
  </div>);
}
// Per-channel data freshness — so the operator never trusts a stale or estimated
// channel. Flags BOTH date-staleness AND source quality (a channel can carry recent
// dates but be embedded/estimated rather than live-synced — e.g. Google Ads while
// its connector is pending approval). Override via window.FRKL_SOURCES per tenant.
// Dark/Light theme toggle — flips html[data-theme] + persists to localStorage.
// CSS does the re-theming (token overrides + Recharts class rules), so no app re-render needed.
function ThemeToggle(){
  const [theme, setTheme] = React.useState(()=>{ try { return document.documentElement.dataset.theme || 'dark'; } catch(e){ return 'dark'; } });
  const set = t => { try { document.documentElement.dataset.theme=t; localStorage.setItem('oi_theme', t); } catch(e){} setTheme(t); };
  const next = theme==='light' ? 'dark' : 'light';
  return (<button onClick={()=>set(next)} title={`Switch to ${next} theme`} aria-label="Toggle colour theme"
    style={{display:'inline-flex',alignItems:'center',justifyContent:'center',width:30,height:30,flexShrink:0,
      borderRadius:8, background:'var(--bg-card)', border:'1px solid var(--border-default)',
      color:'var(--text-secondary)', cursor:'pointer', fontSize:14, lineHeight:1}}>
    {theme==='light' ? <Icon name="moon" size={15}/> : <Icon name="sun" size={15}/>}
  </button>);
}

// ── Icon system — one inline-SVG line family; currentColor → themes for free ──
const OI_ICONS = {
  sun:'<circle cx="12" cy="12" r="4.2"/><path d="M12 2v2.5M12 19.5V22M4.2 4.2l1.8 1.8M18 18l1.8 1.8M2 12h2.5M19.5 12H22M4.2 19.8 6 18M18 6l1.8-1.8"/>',
  moon:'<path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8z"/>',
  chevron:'<path d="M9 5l7 7-7 7"/>',
  alert:'<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4.5M12 17h.01"/>',
  spark:'<path d="M12 3l1.9 5.6L20 10l-6.1 1.4L12 17l-1.9-5.6L4 10l6.1-1.4z"/>',
  check:'<path d="M20 6 9 17l-5-5"/>',
  checkCircle:'<circle cx="12" cy="12" r="9"/><path d="M8.5 12.2l2.4 2.4 4.6-5"/>',
  bookmark:'<path d="M18 21l-6-4.3L6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 7.5h.01"/>',
  bell:'<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  home:'<path d="M3 10.6 12 3.5l9 7.1"/><path d="M5.4 9v11.5h13.2V9"/>',
  clipboard:'<rect x="6" y="4.2" width="12" height="16.8" rx="2"/><path d="M9 4.2V3h6v1.2"/><path d="M8.8 12.2l2 2 4.4-4.4"/>',
  trendUp:'<path d="M3 17l5.5-5.5 3.5 3.5 7-7"/><path d="M16 8h4v4"/>',
  box:'<path d="M21 8 12 3.2 3 8v8l9 4.8L21 16z"/><path d="M3 8l9 4.8L21 8M12 12.8V20.8"/>',
  users:'<circle cx="9" cy="8" r="3.1"/><path d="M3.2 20a5.8 5.8 0 0 1 11.6 0"/><path d="M16.2 5.4a3.1 3.1 0 0 1 0 5.9M20.8 20a5.8 5.8 0 0 0-3.8-5.4"/>',
  calendar:'<rect x="3.2" y="4.6" width="17.6" height="16" rx="2"/><path d="M3.2 9.2h17.6M8 3v3.2M16 3v3.2"/>',
  sliders:'<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2.1"/><circle cx="9" cy="17" r="2.1"/>',
  search:'<circle cx="11" cy="11" r="7"/><path d="m20.5 20.5-4-4"/>',
  pulse:'<path d="M3 12h3.5l2.2-6.5 4 13 2.3-6.5H21"/>',
  image:'<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="8.4" cy="9.4" r="1.5"/><path d="M21 15.5 16 11 5 19.5"/>',
  report:'<rect x="5" y="3.2" width="14" height="17.6" rx="2"/><path d="M8.4 8h7.2M8.4 12h7.2M8.4 16h4.2"/>',
  truck:'<rect x="1.5" y="6.5" width="11.5" height="8.5" rx="1"/><path d="M13 9.5h3.6l3.4 3.2V15H13z"/><circle cx="6" cy="17.4" r="1.7"/><circle cx="16.6" cy="17.4" r="1.7"/>',
  factory:'<path d="M3 21V10.5l5.2 3.2V10.5l5.2 3.2V6.5H21V21z"/><path d="M2.2 21h19.6M11 21v-3.2M16 21v-3.2"/>',
};
function Icon({name, size=16, stroke=1.7, style, className, title}){
  const p = OI_ICONS[name]; if(!p) return null;
  return (<svg className={'oi-ic'+(className?' '+className:'')} width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round"
    style={style} aria-hidden={title?undefined:'true'} role={title?'img':undefined}
    dangerouslySetInnerHTML={{__html: (title?`<title>${title}</title>`:'')+p}}/>);
}

// ── Status taxonomy — one named-state vocabulary used across the product ──────
const STATUS_KINDS = {
  healthy:{l:'Healthy',c:'good'},          watch:{l:'Watch',c:'warn'},
  action:{l:'Action required',c:'bad'},    critical:{l:'Critical',c:'bad'},
  promo:{l:'Promo-distorted',c:'warn'},    stock:{l:'Stock-constrained',c:'warn'},
  margin:{l:'Margin risk',c:'bad'},        attribution:{l:'Attribution risk',c:'warn'},
  lowconf:{l:'Low confidence',c:'mut'},    missing:{l:'Missing data',c:'mut'},
  info:{l:'Info',c:'info'},
};
function StatusBadge({kind, label, dot=true, title}){
  const s = STATUS_KINDS[kind] || {l: label||kind, c:'mut'};
  return (<span className={'sbadge '+s.c} title={title||label||s.l}>{dot && <span className="dot"/>}{label||s.l}</span>);
}

// Industry benchmark chip: "vs ~1.5% · jewellery (?)" — hover reveals source,
// definition, range, recency and confidence. Optional live `value` adds an
// above/below dot (direction-aware via the metric's `better`). Renders nothing
// if the metric isn't in the registry.
function Benchmark({metric, value}){
  const b = bmGet(metric);
  if(!b || b.value==null) return null;
  const catTxt = (!b.category || b.category==='default') ? 'all DTC' : b.category;
  const rangeTxt = (b.lo!=null && b.hi!=null && b.lo!==b.hi) ? `${bmFmt(b.unit,b.lo)}–${bmFmt(b.unit,b.hi)}` : null;
  // Some metrics are targets (a goal to clear), not observed peer medians.
  const isTarget = b.kind==='target' || ['contribution_margin','ltv_cac','cart_abandonment'].indexOf(metric)>=0;
  let good = null;
  if(value!=null) good = b.better==='down' ? value<=b.value : value>=b.value;
  const tip = [
    `${isTarget?'Target':'Typical'} ${bmFmt(b.unit,b.value)}${rangeTxt?` (range ${rangeTxt})`:''} for ${catTxt}.`,
    b.definition ? `Definition: ${b.definition}.` : '',
    b.source ? `Source: ${b.source}${b.as_of?` (${b.as_of})`:''}.` : '',
    b.confidence ? `Confidence: ${b.confidence}.` : '',
    b.caveat || '', b.note || '',
  ].filter(Boolean).join(' ');
  return (<span className="bm-chip" title={tip}>
    {good!=null && <span className={'bm-dot '+(good?'good':'bad')}/>}
    {isTarget?'target':'vs'} {bmFmt(b.unit, b.value)} <span className="bm-cat">{catTxt}</span>
    <span className="bm-q">?</span>
  </span>);
}

// ── Toasts — lightweight confirmations; window.__oiToast(msg, {kind,body,icon,ttl}) ──
function ToastHost(){
  const [items, setItems] = React.useState([]);
  React.useEffect(()=>{
    window.__oiToast = (msg, opts) => {
      opts = opts || {};
      const id = 'to'+Math.random().toString(36).slice(2);
      const kind = opts.kind || 'info';
      const ic = opts.icon || (kind==='good'?'checkCircle':kind==='bad'?'alert':kind==='warn'?'alert':'info');
      setItems(x => [...x, {id, title:msg, body:opts.body, kind, ic}]);
      const ttl = opts.ttl==null ? 3400 : opts.ttl;
      if(ttl>0) setTimeout(()=> setItems(x => x.filter(t=>t.id!==id)), ttl);
    };
    return ()=>{ try{ delete window.__oiToast; }catch(e){} };
  }, []);
  const dismiss = id => setItems(x => x.filter(t=>t.id!==id));
  if(!items.length) return null;
  return (<div className="toast-host">{items.map(t => (
    <div key={t.id} className={'toast '+t.kind} role="status">
      <Icon name={t.ic} size={17} className="t-ic"/>
      <div style={{flex:1, minWidth:0}}>
        <div className="t-title">{t.title}</div>
        {t.body && <div className="t-body">{t.body}</div>}
      </div>
      <button className="t-x" onClick={()=>dismiss(t.id)} aria-label="Dismiss">×</button>
    </div>))}</div>);
}
function toast(msg, opts){ try{ window.__oiToast && window.__oiToast(msg, opts); }catch(e){} }

// ── Insight feedback store (snooze / mark-wrong), persisted per browser ──────
function oiSnoozeAdd(t){ try{ const s=JSON.parse(localStorage.getItem('oi_snoozed')||'[]'); if(!s.some(x=>x.t===t)){ s.push({t}); localStorage.setItem('oi_snoozed', JSON.stringify(s.slice(-200))); } }catch(e){} }
function oiSnoozeRemove(t){ try{ let s=JSON.parse(localStorage.getItem('oi_snoozed')||'[]'); s=s.filter(x=>x.t!==t); localStorage.setItem('oi_snoozed', JSON.stringify(s)); }catch(e){} }
function oiSnoozed(t){ try{ return JSON.parse(localStorage.getItem('oi_snoozed')||'[]').some(x=>x.t===t); }catch(e){ return false; } }
function oiFeedbackAdd(t){ try{ const s=JSON.parse(localStorage.getItem('oi_insight_feedback')||'[]'); s.push({t, at:new Date().toISOString()}); localStorage.setItem('oi_insight_feedback', JSON.stringify(s.slice(-200))); }catch(e){} }

// ── Evidence drawer — global slide-in trust panel; window.__oiEvidence(payload) ──
function EvidenceDrawer(){
  const [data, setData] = React.useState(null);
  React.useEffect(()=>{
    window.__oiEvidence = (payload) => setData(payload || {});
    const onKey = (e)=>{ if(e.key==='Escape') setData(null); };
    window.addEventListener('keydown', onKey);
    return ()=>{ window.removeEventListener('keydown', onKey); try{ delete window.__oiEvidence; }catch(e){} };
  }, []);
  if(!data) return null;
  const close = ()=>setData(null);
  const sec = (label, body) => body ? (<div className="drawer-sec"><div className="lbl">{label}</div>{Array.isArray(body)
    ? <ul>{body.map((w,i)=><li key={i}>{w}</li>)}</ul> : <div className="bd">{body}</div>}</div>) : null;
  return (<><div className="drawer-bg" onClick={close}/>
    <div className="drawer" role="dialog" aria-label="Evidence">
      <div className="drawer-head">
        <Icon name="info" size={18} style={{color:'var(--accent)', marginTop:1}}/>
        <h3>{data.title || 'Evidence'}</h3>
        <button className="drawer-x" onClick={close} aria-label="Close evidence">×</button>
      </div>
      <div className="drawer-body">
        {(data.impact || data.confidence) && <div className="drawer-sec" style={{display:'flex', gap:8, flexWrap:'wrap', alignItems:'center'}}>
          {data.impact && <StatusBadge kind="info" label={data.impact}/>}
          {data.confidence && confChip(data.confidence)}
        </div>}
        {sec("Why you're seeing this", data.why)}
        {sec('Recommended action', data.recommendation)}
        {sec('Caveat', data.caveat)}
        {data.sources && data.sources.length>0 && <div className="drawer-sec"><div className="lbl">Data sources</div>
          <div>{data.sources.map((s,i)=>(<span key={i} className="drawer-src"><Icon name="info" size={12}/>{s}</span>))}</div></div>}
        {data.synced && sec('Last synced', data.synced)}
      </div>
    </div></>);
}

// ── Standard insight action row — View evidence / Create task / Ask AI / Snooze / Mark wrong ──
function InsightActions({title, why, recommendation, agent, askQ, caveat, confidence, impact, onSnooze, onWrong}){
  const evidence = () => window.__oiEvidence && window.__oiEvidence({
    title, why, recommendation, caveat, confidence, impact,
    sources: agent ? ['Agent: '+agent] : [],
    synced: (window.FRKL_DATA && window.FRKL_DATA.meta && window.FRKL_DATA.meta.captured) || null,
  });
  return (<div className="insight-actions">
    <button className="ia-btn primary" onClick={evidence}><Icon name="info" size={13}/>View evidence</button>
    <button className="ia-btn" onClick={()=>aiSaveTask(recommendation||title)}><Icon name="clipboard" size={13}/>Create task</button>
    <button className="ia-btn" onClick={()=>window.__oiAsk && window.__oiAsk(askQ||('Explain this finding: '+title))}><Icon name="spark" size={13}/>Ask AI</button>
    <button className="ia-btn" onClick={()=>{ oiSnoozeAdd(title); toast('Snoozed', {body:'Hidden from your view.'}); onSnooze && onSnooze(); }}><Icon name="bell" size={13}/>Snooze</button>
    <button className="ia-btn" onClick={()=>{ oiFeedbackAdd(title); toast('Flagged as not useful', {kind:'warn', body:'Thanks — this tunes future insights.'}); onWrong && onWrong(); }}><Icon name="alert" size={13}/>Mark wrong</button>
  </div>);
}

// Skeleton placeholder — a calm shimmer while a heavy section mounts.
function Skeleton({height}){
  return (<div className="skeleton-card" style={{minHeight: height||320}}>
    <div className="sk-bar" style={{width:'34%', height:13, marginBottom:9}}/>
    <div className="sk-bar" style={{width:'52%', height:10, marginBottom:22, opacity:.7}}/>
    <div className="sk-bar" style={{width:'100%', height:(height||320)-110, borderRadius:8, opacity:.5}}/>
  </div>);
}

// Premium empty state — what's missing, why it matters, the fix.
function EmptyState({icon, title, body, cta, ctaOnClick, secondary, secondaryOnClick}){
  return (<div className="empty-state">
    <div className="es-ic"><Icon name={icon||'info'} size={22}/></div>
    <div className="es-title">{title}</div>
    {body && <div className="es-body">{body}</div>}
    <div className="es-actions">
      {cta && <button className="btn-primary" onClick={ctaOnClick}>{cta}</button>}
      {secondary && <button className="btn-ghost" onClick={secondaryOnClick}>{secondary}</button>}
    </div>
  </div>);
}

// Sticky health summary bar — keeps the verdict + £ at stake visible on scroll.
function StickyHealthBar(){
  const [show, setShow] = React.useState(false);
  React.useEffect(()=>{
    const onScroll = ()=>setShow(window.scrollY > 280);
    window.addEventListener('scroll', onScroll, {passive:true});
    onScroll();
    return ()=>window.removeEventListener('scroll', onScroll);
  }, []);
  const P = (typeof window!=='undefined' && window.FRKL_PATTERNS) || {};
  const roll = P.money_rollup || {};
  const atStake = (roll.leakage||0) + (roll.at_risk||0);
  let openCount = 0;
  try {
    const st = window.FRKL_ACTION_STATUS || {};
    const local = JSON.parse(localStorage.getItem('frkl-action-local-done')||'{}');
    openCount = Object.keys(st).filter(id=>{ const s=(st[id]||{}).status; return s!=='verified-done' && s!=='done' && !local[id]; }).length;
  } catch(e){}
  const status = (roll.leakage>0) ? {kind:'action', label:'Action required'} : (roll.at_risk>0) ? {kind:'watch', label:'Watch'} : {kind:'healthy', label:'Healthy'};
  return (<div className={'health-bar'+(show?' show':'')} aria-hidden={!show}>
    <div className="health-bar-inner">
      <StatusBadge kind={status.kind} label={status.label}/>
      {atStake>0 && <span className="hb-metric"><b>{atStake>=1000?'£'+(atStake/1000).toFixed(1)+'k':'£'+Math.round(atStake)}</b>/mo at stake</span>}
      {openCount>0 && <span className="hb-metric"><b>{openCount}</b> open action{openCount===1?'':'s'}</span>}
      <span className="hb-spacer"/>
      <button className="ia-btn primary" onClick={()=>window.__oiNav && window.__oiNav('actions','queue')}><Icon name="clipboard" size={13}/>Review actions</button>
    </div>
  </div>);
}

// Chart card footer — short interpretation + view-as-table + ask-AI-about-this.
function ChartFooter({note, ask, rows, columns}){
  const [tbl, setTbl] = React.useState(false);
  const hasTable = rows && rows.length && columns && columns.length;
  return (<>
    <div className="chart-foot">
      {note && <span className="cf-note">{note}</span>}
      {!note && <span style={{flex:1}}/>}
      {hasTable && <button className="cf-btn" onClick={()=>setTbl(v=>!v)}><Icon name="clipboard" size={12}/>{tbl?'Hide table':'View as table'}</button>}
      {ask && <button className="cf-btn" onClick={()=>window.__oiAsk && window.__oiAsk(ask)}><Icon name="spark" size={12}/>Ask AI about this</button>}
    </div>
    {tbl && hasTable && (<div className="cf-table-wrap">
      <table><thead><tr>{columns.map((c,i)=>(<th key={i} className={c.right?'':'tl'}>{c.label}</th>))}</tr></thead>
        <tbody>{rows.map((r,ri)=>(<tr key={ri}>{columns.map((c,ci)=>(<td key={ci} className={c.right?'':'tl'}>{c.fmt?c.fmt(r[c.key], r):r[c.key]}</td>))}</tr>))}</tbody>
      </table>
    </div>)}
  </>);
}

// Small labelled-control wrapper for the configurable-chart control strip.
function Field({label, children}){
  return (<label style={{display:'flex',flexDirection:'column',gap:3}}>
    <span style={{fontSize:10,letterSpacing:'.04em',textTransform:'uppercase',color:'var(--text-faint)'}}>{label}</span>
    {children}
  </label>);
}

// Inline-config exploratory chart — "metric × dimension" with KPI/Split/Chart/Order/Top-N
// controls, mirroring the Conjura pattern. Aggregates `dataset` live and reuses ChartFooter
// (data table + "Ask AI about this"). For exploratory views only; bespoke diagnostic charts stay hand-built.
function ConfigurableChart({dataset, dimensions, metrics, defaultMetric, defaultSplit, defaultChart='bar', defaultTopN=10, title}){
  const [metric, setMetric] = useState(defaultMetric || metrics[0].key);
  const [split,  setSplit]  = useState(defaultSplit  || dimensions[0].key);
  const [ctype,  setCtype]  = useState(defaultChart);
  const [order,  setOrder]  = useState('desc');
  const [topN,   setTopN]   = useState(defaultTopN);
  const M = metrics.find(m=>m.key===metric) || metrics[0];
  const D = dimensions.find(d=>d.key===split) || dimensions[0];
  const fmt = M.fmt || (v=>v);

  const rows = useMemo(()=>{
    const g = {};
    (dataset||[]).forEach(r=>{
      const k = (r[split]==null || r[split]==='') ? '—' : String(r[split]);
      (g[k] || (g[k]={label:k, val:0})).val += Number(r[metric])||0;
    });
    return Object.values(g).sort((a,b)=> order==='desc' ? b.val-a.val : a.val-b.val).slice(0, topN);
  }, [dataset, metric, split, order, topN]);

  const selStyle = {background:'var(--bg-app)',color:'var(--text-primary)',border:'1px solid var(--border-default)',borderRadius:6,padding:'4px 8px',fontSize:12,fontFamily:'inherit',cursor:'pointer'};
  const sel = (val,set,opts) => (
    <select value={val} onChange={e=>set(e.target.value)} style={selStyle}>
      {opts.map(o=><option key={o.key} value={o.key}>{o.label}</option>)}
    </select>);
  const segB = (active)=>({fontSize:11.5,fontWeight:600,padding:'5px 11px',borderRadius:6,cursor:'pointer',border:'1px solid '+(active?'#7c8cff':'var(--border-subtle)'),background:active?'rgba(124,140,255,0.14)':'transparent',color:active?'#9aa6ff':'var(--text-muted)'});
  const bar = ctype==='bar';

  return (<div className="card">
    {title && <div className="card-section-title"><h2 style={{margin:0}}>{title}</h2></div>}
    <div style={{display:'flex',gap:14,flexWrap:'wrap',alignItems:'flex-end',margin:'4px 0 12px'}}>
      <Field label="KPI">{sel(metric,setMetric,metrics.map(m=>({key:m.key,label:m.label})))}</Field>
      <Field label="Split by">{sel(split,setSplit,dimensions.map(d=>({key:d.key,label:d.label})))}</Field>
      <Field label="Chart">
        <div style={{display:'inline-flex',gap:6}}>
          <button style={segB(bar)}  onClick={()=>setCtype('bar')}>Bar</button>
          <button style={segB(!bar)} onClick={()=>setCtype('line')}>Line</button>
        </div>
      </Field>
      <Field label="Order">{sel(order,setOrder,[{key:'desc',label:'Top'},{key:'asc',label:'Bottom'}])}</Field>
      <Field label="Show">{sel(String(topN),v=>setTopN(+v),[5,10,15,25].map(n=>({key:String(n),label:'Top '+n})))}</Field>
    </div>
    <R.ResponsiveContainer width="100%" height={bar?Math.max(220, rows.length*30+60):300}>
      <R.ComposedChart data={rows} layout={bar?'vertical':'horizontal'} margin={{top:6,right:24,left:14,bottom:16}}>
        <R.CartesianGrid stroke="#1f1f27" horizontal={!bar} vertical={bar}/>
        {bar
          ? (<><R.XAxis type="number" tickFormatter={fmt} tick={{fill:'#7e7e8a',fontSize:11}}/>
               <R.YAxis type="category" dataKey="label" width={150} tick={{fill:'#7e7e8a',fontSize:11}}/></>)
          : (<><R.XAxis dataKey="label" tick={{fill:'#7e7e8a',fontSize:11}} interval={0} angle={-20} textAnchor="end" height={60}/>
               <R.YAxis tickFormatter={fmt} tick={{fill:'#7e7e8a',fontSize:11}}/></>)}
        <R.Tooltip contentStyle={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:10,boxShadow:'var(--shadow-md)'}} formatter={v=>fmt(v)}/>
        {bar
          ? <R.Bar dataKey="val" name={M.label} fill={COL.revenue} radius={[0,4,4,0]}/>
          : <R.Line dataKey="val" name={M.label} stroke={COL.revenue} strokeWidth={2.2} dot={false}/>}
      </R.ComposedChart>
    </R.ResponsiveContainer>
    <ChartFooter
      note={`${M.label} by ${D.label.toLowerCase()} — ${order==='desc'?'highest':'lowest'} ${topN}.`}
      ask={`Looking at ${M.label} by ${D.label}, what's driving the ${order==='desc'?'top':'bottom'} ${topN} and what should I do about it?`}
      rows={rows} columns={[{key:'label',label:D.label},{key:'val',label:M.label,right:true,fmt}]}/>
  </div>);
}

function DataFreshness(){
  const today = (()=>{ try { return new Date(); } catch(e){ return null; } })();
  const maxDate = rows => (rows && rows.length) ? rows.reduce((m,r)=> (r.date && r.date>m) ? r.date : m, '') : '';
  const SRC_META = (typeof window!=='undefined' && window.FRKL_SOURCES) ||
    { Google: {live:false, note:'Estimated — live Google Ads sync pending dev-token approval, so these figures are not yet a live read.'} };
  const src = [['Shopify',D.shopify],['Meta',D.metaDaily],['Google',D.googleAds],['GA4',D.ga4],['Klaviyo',D.klaviyo]];
  const items = src.map(([name,rows])=>{
    const d = maxDate(rows);
    const stale = (d && today) ? Math.round((today - new Date(d))/86400000) : null;
    const sm = SRC_META[name];
    const estimated = !!(sm && sm.live===false);
    return {name, d, stale, estimated, note: sm && sm.note};
  }).filter(x=>x.d);
  if(!items.length) return null;
  const tone = it => it.estimated ? 'var(--warn)' : (it.stale==null?'var(--text-muted)': it.stale<=3?'var(--good)': it.stale<=10?'var(--warn)':'var(--bad)');
  const label = it => it.estimated ? 'estimated' : (it.stale!=null && it.stale<=1 ? 'today' : it.stale!=null && it.stale<=10 ? it.d.slice(5) : `${it.d.slice(5)} · ${it.stale}d old`);
  const flagged = items.some(x=>x.estimated || (x.stale!=null && x.stale>10));
  return (<div style={{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap',fontSize:11.5,padding:'0 2px'}}>
    <span style={{textTransform:'uppercase',letterSpacing:'.05em',fontSize:10,color:'var(--text-faint)'}}>Data freshness</span>
    {items.map((x,i)=>(<span key={i} title={x.note||''} style={{display:'inline-flex',alignItems:'center',gap:5,cursor:x.note?'help':'default'}}>
      <span style={{width:7,height:7,borderRadius:'50%',background:tone(x)}}/>
      <span style={{color:'var(--text-secondary)'}}>{x.name}</span>
      <span style={{color:tone(x)}}>{label(x)}</span>
    </span>))}
    {flagged && <span style={{color:'var(--warn)'}}>⚠ estimated/stale channels aren't a live read — reconnect to refresh</span>}
  </div>);
}
// ── Crux — commercial-intelligence synthesis: composite scores across the team ──
// Crux is the cross-functional member: it reads Pulse (efficiency), Atlas (unit
// economics), Lux (retention) etc. into three whole-business scores. Deterministic.
function clamp01(x){ return Math.max(0, Math.min(1, x)); }
function computeScores(m){
  const beRoas = m.breakEvenRoas || 2;
  const f = [];
  const add = (label, val, w, detail) => { if(val!=null && isFinite(val)) f.push({label, s:clamp01(val), w, detail}); };
  add('Contribution margin', m.cmPct!=null ? m.cmPct/0.10 : null, 0.20, m.cmPct!=null?`${(m.cmPct*100).toFixed(0)}% (≥10% healthy)`:'');
  add('Marketing efficiency', m.mer!=null ? m.mer/(beRoas*2) : null, 0.15, m.mer!=null?`MER ${m.mer.toFixed(1)}× vs ${beRoas.toFixed(1)}× break-even`:'');
  add('CAC vs allowable', (m.cac && m.allowableCac) ? m.allowableCac/m.cac : null, 0.15, (m.cac&&m.allowableCac)?`£${Math.round(m.cac)} vs £${Math.round(m.allowableCac)} allowable`:'');
  add('LTV:CAC', m.ltvCac!=null ? m.ltvCac/3 : null, 0.15, m.ltvCac!=null?`${m.ltvCac.toFixed(1)}× (3× target)`:'');
  add('Gross margin', m.gm ? m.gm/0.6 : null, 0.10, m.gm?`${(m.gm*100).toFixed(0)}%`:'');
  add('Conversion rate', m.cvr!=null ? m.cvr/CVR_BENCH : null, 0.10, m.cvr!=null?`${(m.cvr*100).toFixed(2)}% (${CVR_BENCH_LABEL} target)`:'');
  add('Discount discipline', m.discLoad!=null ? 1-Math.max(0,m.discLoad-0.10)/0.10 : null, 0.08, m.discLoad!=null?`${(m.discLoad*100).toFixed(0)}% load (≤10% ideal · 20% ceiling)`:'');
  add('Returns', m.returnRate!=null ? 1-m.returnRate/0.10 : null, 0.07, m.returnRate!=null?`${(m.returnRate*100).toFixed(1)}%`:'');
  const wsum = f.reduce((a,x)=>a+x.w,0) || 1;
  const health = Math.round(100 * f.reduce((a,x)=>a+x.s*x.w,0)/wsum);
  const weakest = [...f].sort((a,b)=>a.s-b.s).slice(0,2);

  const gates = [
    {k:'CAC below allowable', pass:(m.cac!=null&&m.allowableCac!=null)? m.cac<=m.allowableCac : null},
    {k:'MER above break-even', pass:(m.mer!=null)? m.mer>=beRoas*1.3 : null},
    {k:'Contribution positive', pass:(m.contrib!=null)? m.contrib>0 : null},
    {k:'Payback ≤ 2 orders', pass:(m.paybackOrders!=null)? m.paybackOrders<=2 : null},
    {k:'LTV:CAC ≥ 3×', pass:(m.ltvCac!=null)? m.ltvCac>=3 : null},
    {k:'Conversion not falling', pass:(m.cvr!=null&&m.pCvr!=null)? m.cvr>=m.pCvr*0.9 : null},
    {k:'Gross margin ≥ 40%', pass:(m.gm!=null)? m.gm>=0.4 : null},
  ].filter(g=>g.pass!=null);
  const passed = gates.filter(g=>g.pass).length;
  const scale = Math.round(100*passed/(gates.length||1));
  const fails = gates.filter(g=>!g.pass).map(g=>g.k);

  const signals = []; let band = 'Insufficient history';
  if(m.pRev!=null && m.pContrib!=null){
    const revUp = m.rev > m.pRev*1.02, revDown = m.rev < m.pRev*0.98;
    const contribUp = m.contrib > m.pContrib;
    const cacWorse = m.pCac!=null && m.cac!=null && m.cac > m.pCac*1.05;
    const discWorse = m.pDiscLoad!=null && m.discLoad!=null && m.discLoad > m.pDiscLoad*1.05;
    const revPct = m.pRev ? ((m.rev-m.pRev)/m.pRev*100) : 0;
    const contribPct = m.pContrib ? ((m.contrib-m.pContrib)/Math.abs(m.pContrib)*100) : 0;
    if(revUp && contribUp && !cacWorse && !discWorse) band='Healthy growth';
    else if(revUp && (!contribUp || cacWorse || discWorse)) band='Low-quality growth';
    else if(!revUp && contribUp) band='Efficient consolidation';
    else if(revDown && !contribUp) band='Contracting';
    else band='Flat';
    signals.push(`Revenue ${revPct>=0?'+':''}${revPct.toFixed(0)}%`);
    signals.push(`Contribution ${contribPct>=0?'+':''}${contribPct.toFixed(0)}%`);
    if(cacWorse) signals.push('CAC rising');
    if(discWorse) signals.push('discount load rising');
  }
  // Scale readiness must respect the TREND, not just point-in-time gates: don't say
  // "ready to scale" while growth quality is deteriorating.
  const badTrend = (band==='Low-quality growth' || band==='Contracting');
  if(badTrend){ gates.push({k:'Growth quality not deteriorating', pass:false}); fails.push('Growth quality deteriorating'); }
  const passed2 = gates.filter(g=>g.pass).length;
  const scale2 = Math.round(100*passed2/(gates.length||1));
  return {
    health:{score:health, band: health>=75?'Strong':health>=55?'Healthy':'Needs work', weakest},
    scale:{score:scale2, band: scale2>=80?'Ready to scale':scale2>=55?'Conditional':'Not yet', fails, gates:gates.length},
    growth:{band, signals},
  };
}
// Hover explainer for a single Crux score — plain-English so a non-expert grasps
// what it measures, the scale, and what's driving it right now.
function ScoreTip({valueNode, title, lines}){
  const [show, setShow] = React.useState(false);
  return (<span style={{position:'relative', cursor:'help', display:'inline-flex', alignItems:'center', gap:4}}
      onMouseEnter={()=>setShow(true)} onMouseLeave={()=>setShow(false)}>
    {valueNode}<span style={{fontSize:9, opacity:.5}} aria-hidden="true">&#9432;</span>
    {show && <div role="tooltip" style={{position:'absolute', top:'calc(100% + 8px)', left:0, zIndex:60, width:300,
        background:'var(--bg-elevated)', border:'1px solid var(--border-default)', borderRadius:'var(--r-md)',
        padding:'11px 13px', boxShadow:'var(--shadow-lg)', textAlign:'left', whiteSpace:'normal', fontWeight:400,
        color:'var(--text-secondary)', fontSize:12, lineHeight:1.5}}>
      <div style={{fontWeight:650, color:'var(--text-primary)', marginBottom:5}}>{title}</div>
      {lines.filter(Boolean).map((ln,i)=><div key={i} style={{marginTop:i?5:0}}>{ln}</div>)}
    </div>}
  </span>);
}
// Compact one-line scorecard (Crux) — sits at the top of the diagnostic verdict.
// Each score hovers to a plain-English explainer; a "plain terms" line under the row
// translates all three into one sentence a first-time user can act on.
function ScoresStrip({metrics, windowLabel}){
  const s = computeScores(metrics);
  const [open, setOpen] = React.useState(false);
  const tone = v => v>=75?'var(--good)':v>=55?'var(--warn)':'var(--bad)';
  const gTone = b => (b==='Healthy growth'||b==='Efficient consolidation')?'var(--good)':(b==='Low-quality growth'||b==='Contracting')?'var(--bad)':'var(--text-muted)';
  const w0 = s.health.weakest[0];
  const healthWord = s.health.score>=75?'fundamentally sound':s.health.score>=55?'okay, with some soft spots':'under real strain';
  const growthPlain = ({
    'Healthy growth':'growing profitably',
    'Low-quality growth':"growing on sales, but profit isn't keeping pace",
    'Efficient consolidation':'getting more profitable without growing much',
    'Contracting':'shrinking',
    'Flat':'roughly flat',
    'Insufficient history':'not yet showing enough history to judge the trend',
  })[s.growth.band] || String(s.growth.band).toLowerCase();
  const scaleWord = s.scale.score>=80?'the economics support spending more to grow'
    : s.scale.score>=55?'it’s not safe to scale spend yet — clear the blockers first'
    : 'it’s not safe to scale — the unit economics need work first';
  return (<div style={{padding:'10px 12px',borderRadius:'var(--r-md)',background:'rgba(255,255,255,0.02)',border:'1px solid var(--border-subtle)',marginBottom:12}}>
    <div style={{display:'flex',alignItems:'center',gap:16,flexWrap:'wrap',fontSize:12,color:'var(--text-secondary)'}}>
      <span style={{textTransform:'uppercase',letterSpacing:'.05em',fontSize:10,color:'var(--text-faint)'}}>Crux scorecard{windowLabel?<span style={{textTransform:'none',letterSpacing:0,color:'var(--text-faint)',fontWeight:400}}> · {windowLabel} · independent of the date picker</span>:null}</span>
      <ScoreTip title="Health — is the engine sound?" lines={[
          "A 0–100 blend of your profit margins, ad efficiency, conversion rate, returns and discount discipline. Answers: are the fundamentals healthy?",
          "75+ strong · 55–74 okay · under 55 needs work.",
          w0?`Weakest right now: ${w0.label} — ${w0.detail}.`:'' ]}
        valueNode={<span>Health <b style={{color:tone(s.health.score),fontSize:14}}>{s.health.score}</b><span style={{color:'var(--text-faint)'}}>/100 · {s.health.band}</span></span>}/>
      <ScoreTip title="Scale-readiness — safe to spend more?" lines={[
          "The share of 'safe to scale' checks you pass — e.g. cost to win a customer (CAC) under your limit, profitable per order, fast payback, conversion not slipping.",
          "80+ ready · 55–79 conditional (fix blockers first) · under 55 not yet.",
          s.scale.fails.length?`Blocking: ${s.scale.fails.slice(0,3).join('; ')}.`:'All checks pass.' ]}
        valueNode={<span>Scale-readiness <b style={{color:tone(s.scale.score),fontSize:14}}>{s.scale.score}</b><span style={{color:'var(--text-faint)'}}>/100 · {s.scale.band}</span></span>}/>
      <ScoreTip title="Growth quality — is the growth profitable?" lines={[
          "Whether recent revenue growth came with profit growth.",
          "'Low-quality growth' = sales up but profit (contribution = revenue minus product + ad costs) flat or down — usually rising ad costs or heavier discounting.",
          s.growth.signals.length?('Latest: '+s.growth.signals.join(' · ')):'' ]}
        valueNode={<span>Growth <b style={{color:gTone(s.growth.band)}}>{s.growth.band}</b></span>}/>
      <button onClick={()=>setOpen(o=>!o)} style={{marginLeft:'auto',background:'transparent',border:'none',color:'var(--accent)',cursor:'pointer',fontSize:11.5,fontWeight:600}}>{open?'Hide detail':'Detail'}</button>
    </div>
    <div style={{marginTop:8,fontSize:12.5,color:'var(--text-secondary)',lineHeight:1.55,borderTop:'1px solid var(--border-subtle)',paddingTop:8}}>
      <b style={{color:'var(--text-primary)'}}>In plain terms:</b> the business is <b style={{color:tone(s.health.score)}}>{healthWord}</b> (Health {s.health.score}/100){s.growth.band!=='Insufficient history'?<> and right now it&rsquo;s <b style={{color:gTone(s.growth.band)}}>{growthPlain}</b></>:''}. On growing, {scaleWord}.
    </div>
    {open && (<div style={{marginTop:7,fontSize:12,color:'var(--text-secondary)',lineHeight:1.55}}>
      <div><b style={{color:'var(--text-primary)'}}>Weakest fundamentals:</b> {s.health.weakest.map(w=>`${w.label} — ${w.detail}`).join('; ')||'—'}.</div>
      {s.scale.fails.length>0
        ? <div style={{marginTop:3}}><b style={{color:'var(--text-primary)'}}>Scale blockers:</b> {s.scale.fails.join('; ')}.</div>
        : <div style={{marginTop:3}}>All scale gates pass — economics support gradual scaling.</div>}
    </div>)}
  </div>);
}
// "What changed" — the visible first slice of the commercial graph. Decomposes the
// revenue change vs prior period into traffic / conversion / order-value effects
// (exact, additive: Revenue = Sessions × CVR × AOV), then translates to contribution.
// This is spec §5 (variance) + §6 (£) + §11 (causal narrative) made visible. Owned by Crux.
function ChangeBridgeBody({metrics:m}){
  if(!m.havePrior || !(m.pSessions>0) || !(m.pOrders>0) || m.pRev==null) return null;
  const S0=m.pSessions, S1=m.sessions, C0=m.pOrders/m.pSessions, C1=m.cvr||0, A0=m.pRev/m.pOrders, A1=m.aov||0;
  const eS=(S1-S0)*C0*A0, eC=S1*(C1-C0)*A0, eA=S1*C1*(A1-A0);   // sum = ΔRevenue (exact)
  const dRev=m.rev-m.pRev, gm=m.gm||0;
  const dSpend=(m.paid!=null&&m.pPaid!=null)?(m.paid-m.pPaid):0;
  const dContrib=dRev*gm - dSpend;
  const items=[
    {label:'Traffic (sessions)', v:eS, note:`${NUM(S0)}→${NUM(S1)} sessions`},
    {label:'Conversion rate', v:eC, note:`${(C0*100).toFixed(2)}%→${(C1*100).toFixed(2)}%`},
    {label:'Order value (AOV)', v:eA, note:`${GBP(A0)}→${GBP(A1)}`},
  ].sort((a,b)=>Math.abs(b.v)-Math.abs(a.v));
  const max=Math.max(1,...items.map(i=>Math.abs(i.v)));
  const col=v=> v>=0?'var(--good)':'var(--bad)';
  const top=items[0];
  return (<div style={{marginTop:10,paddingTop:10,borderTop:'1px solid var(--border-subtle)'}}>
    <div style={{fontSize:11,letterSpacing:'.05em',textTransform:'uppercase',color:'var(--text-faint)',marginBottom:6}}>What changed · revenue {dRev>=0?'up':'down'} {GBP(Math.abs(dRev))} vs prior period</div>
    <div style={{fontSize:12.5,color:'var(--text-secondary)',lineHeight:1.55,marginBottom:10}}>
      Revenue {dRev>=0?'rose':'fell'} <b style={{color:col(dRev)}}>{GBP(Math.abs(dRev))}</b>. Biggest driver: <b>{top.label.toLowerCase()}</b> ({top.v>=0?'+':'−'}{GBP(Math.abs(top.v))}). At {PCT(gm)} margin, net of a {GBP(Math.abs(dSpend))} ad-spend {dSpend>=0?'rise':'cut'}, contribution moved <b style={{color:col(dContrib)}}>{dContrib>=0?'+':'−'}{GBP(Math.abs(dContrib))}</b>.
    </div>
    {items.map((it,i)=>(<div key={i} style={{display:'flex',alignItems:'center',gap:10,padding:'4px 0'}}>
      <span style={{width:130,fontSize:12,color:'var(--text-secondary)',flexShrink:0}}>{it.label}</span>
      <div style={{flex:1,height:14,position:'relative',background:'rgba(255,255,255,0.03)',borderRadius:4,minWidth:100}}>
        <div style={{position:'absolute',left:'50%',top:0,bottom:0,width:1,background:'var(--border-default)'}}/>
        <div style={{position:'absolute',top:3,bottom:3,borderRadius:3,background:col(it.v),left: it.v>=0?'50%':`${50 - 50*Math.abs(it.v)/max}%`, width:`${50*Math.abs(it.v)/max}%`}}/>
      </div>
      <span style={{width:80,textAlign:'right',fontSize:12,fontWeight:700,color:col(it.v),flexShrink:0}}>{it.v>=0?'+':'−'}{GBP(Math.abs(it.v))}</span>
      <span style={{width:130,fontSize:10.5,color:'var(--text-faint)',flexShrink:0}}>{it.note}</span>
    </div>))}
    <div style={{fontSize:11,color:'var(--text-faint)',marginTop:8,lineHeight:1.5}}>Revenue = Sessions × Conversion × AOV — the three effects sum exactly to the revenue change. Contribution applies {PCT(gm)} margin and nets off the {GBP(Math.abs(dSpend))} ad-spend change.</div>
  </div>);
}
// Concise, decision-first layout: ONE move up top, everything else folded away.
// The agent did the thinking — the operator should get the answer, not the working.
function AnalystRead({read, dx, metrics, onLog, logUI}){
  const [showMore, setShowMore] = React.useState(false);   // tier 2: other actions
  const [showWhy, setShowWhy]   = React.useState(false);   // tier 3: the reasoning
  // Merge live product-signal findings so the biggest product lever competes for the move.
  const findings = [...(read.findings || []), ...productFindings(), ...discountFindings(), ...markdownFindings(), ...cvrFindings()];
  const conf = f => f.confidence || 'med';
  const acts = findings.filter(f => f.verdict === 'act');
  const pool = acts.length ? acts : findings;
  // Move guard: a low-confidence finding must never be the headline directive.
  // Lead with the highest-QUALITY high/med finding (confidence-weighted £, not raw £);
  // only fall back to low if nothing else.
  const confidentPool = pool.filter(f => conf(f) !== 'low');
  const move = [...(confidentPool.length ? confidentPool : pool)].sort((a,b)=>findingScore(b)-findingScore(a))[0] || findings[0] || null;
  const moveLow = !!move && conf(move) === 'low';
  // Surface order: confident actions first, then watch/validate items — within each,
  // by signal quality (so the strongest, most certain signal sits highest).
  const isWatch = f => (f.verdict !== 'act' || conf(f) === 'low');
  const rest = findings.filter(f => f !== move).sort((a,b)=> (isWatch(a)?1:0)-(isWatch(b)?1:0) || findingScore(b)-findingScore(a));

  return (<div className="card">
    {logUI}
    <div className="card-section-title">
      <h2 style={{margin:0}}>What to do next <span style={{color:'var(--text-faint)',fontWeight:400,fontSize:13}}>— operator diagnostic</span></h2>
      <div style={{display:'flex',alignItems:'center',gap:10}}>
        <span className="meta">AI analyst{read.generatedAt?` · ${read.generatedAt.slice(0,10)}`:''}</span>
        {onLog && <LogEventButton onClick={onLog}/>}
      </div>
    </div>

    {/* TIER 1 — THE MOVE (framing + accent shift by confidence) */}
    {move && (
    <div style={{padding:'14px 16px',borderRadius:'var(--r-md)',background:moveLow?'rgba(255,255,255,0.03)':'rgba(124,140,255,0.07)',border:'1px solid '+(moveLow?'var(--border-default)':'var(--border-subtle)')}}>
      <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
        <span style={{fontSize:10,fontWeight:700,letterSpacing:'.07em',textTransform:'uppercase',color:moveLow?'var(--text-muted)':'var(--accent)'}}>{moveLow?'Top hypothesis · validate first':'Do this next'}</span>
        {confChip(conf(move))}
        {move.gbp>0 && <span style={{marginLeft:'auto',fontWeight:700,color:'var(--good)',whiteSpace:'nowrap'}}>~{GBP(move.gbp)}{moveLow?' if confirmed':' on the table'}</span>}
      </div>
      <div style={{fontSize:16,fontWeight:700,color:'var(--text-primary)',marginTop:6,lineHeight:1.45}}>{moveLow?'Test this: ':''}{move.recommendation}</div>
      <div style={{fontSize:12.5,color:'var(--text-secondary)',marginTop:6,lineHeight:1.5}}><span style={{color:'var(--text-faint)'}}>Why · </span>{move.metric}</div>
      <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',marginTop:2}}><PlaybookHint text={`${move.recommendation} ${move.metric} ${move.area}`}/><NavChip f={move}/></div>
    </div>
    )}

    {/* TIER 2 — what else (folded): verdict + confidence on every row */}
    {rest.length>0 && <Disclosure label={`What else (${rest.length})`} open={showMore} onToggle={()=>setShowMore(s=>!s)}/>}
    {showMore && rest.map((x,i)=>{ const vs=verdictStyle(x.verdict); const low=conf(x)==='low'; return (
      <div key={i} style={{display:'flex',gap:10,alignItems:'baseline',padding:'9px 0 9px 18px',borderTop:i?'1px solid var(--border-subtle)':'none'}}>
        <div style={{display:'flex',gap:6,flexShrink:0,width:142,flexWrap:'wrap'}}>
          <span style={{fontSize:9,fontWeight:700,letterSpacing:'.05em',color:vs.fg,background:vs.bg,padding:'2px 6px',borderRadius:999,height:'fit-content'}}>{vs.label}</span>
          {confChip(conf(x))}
        </div>
        <div style={{flex:1,minWidth:0,fontSize:13,color:low?'var(--text-secondary)':'var(--text-primary)',lineHeight:1.5}}><b>{x.area}.</b> {low?'Worth checking: ':''}{x.recommendation}{x.metric && <div style={{fontSize:11.5,color:'var(--text-faint)',marginTop:1}}>{x.metric}</div>}</div>
        <div style={{width:64,textAlign:'right',flexShrink:0,fontWeight:700,color:'var(--good)',whiteSpace:'nowrap',fontSize:12.5}}>{x.gbp>0?'~'+GBP(x.gbp):''}</div>
        <div style={{flexShrink:0}}><NavChip f={x}/></div>
      </div>
    );})}

    {/* TIER 3 — the thinking (folded) */}
    <Disclosure label="Show the thinking" open={showWhy} onToggle={()=>setShowWhy(s=>!s)}/>
    {showWhy && (
      <div style={{padding:'8px 0 0 18px'}}>
        <div style={{fontSize:13,color:'var(--text-primary)',fontWeight:600,lineHeight:1.5}}>{read.headline}</div>
        <div style={{fontSize:12.5,color:'var(--text-secondary)',marginTop:6,lineHeight:1.55}}>{read.narrative}</div>
        {metrics && <ChangeBridgeBody metrics={metrics}/>}
        <div style={{marginTop:10}}>
          {findings.map((x,i)=>(<div key={i} style={{fontSize:12.5,color:'var(--text-secondary)',lineHeight:1.5,marginBottom:5}}><b style={{color:'var(--text-primary)'}}>{x.area}{x.confidence?` · ${x.confidence} confidence`:''}.</b> {x.reasoning}</div>))}
        </div>
        {(read.blindspots||[]).length>0 && (
          <div style={{marginTop:10,padding:'10px 14px',borderRadius:'var(--r-md)',background:'rgba(255,255,255,0.02)',border:'1px solid var(--border-subtle)'}}>
            <div style={{fontSize:11,letterSpacing:'.05em',textTransform:'uppercase',color:'var(--text-faint)',marginBottom:6}}>What I can't see yet</div>
            {read.blindspots.map((b,i)=>(<div key={i} style={{fontSize:12,color:'var(--text-secondary)',lineHeight:1.5,display:'flex',gap:8,marginBottom:3}}><span style={{color:'var(--text-faint)'}}>·</span><span>{b}</span></div>))}
          </div>
        )}
        <ContextConsidered dx={dx}/>
        <div className="note" style={{marginTop:10}}>Reasoned over the live evidence bundle (decomposition → baseline → confounder → verdict). £ are contribution-impact estimates used to rank leverage, not forecasts.</div>
      </div>
    )}
  </div>);
}

// Lets the operator log business context the data can't contain (a promo, a
// launch, a deliberate spend test). Stored locally and merged into the evidence
// bundle immediately so the diagnostic re-reads with it. In the full SaaS this
// POSTs to OI's brand_events; here it overlays via localStorage.
function LogEventModal({onClose, onSaved}){
  const [type,setType] = React.useState('spend_change');
  const [title,setTitle] = React.useState('');
  const [starts,setStarts] = React.useState('');
  const [ends,setEnds] = React.useState('');
  const [note,setNote] = React.useState('');
  const save = () => {
    if(!title.trim() || !starts) return;
    let cur = [];
    try { cur = JSON.parse(localStorage.getItem('frkl-brand-events')||'[]'); } catch(e){ cur=[]; }
    cur.push({id:'local-'+starts+'-'+type, type, title:title.trim(), startsOn:starts, endsOn:ends||null, note:note.trim()||null, source:'operator'});
    localStorage.setItem('frkl-brand-events', JSON.stringify(cur));
    onSaved && onSaved();
    onClose();
  };
  return (<div onClick={onClose} style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.55)',zIndex:200,display:'flex',alignItems:'center',justifyContent:'center',padding:20}}>
    <div onClick={e=>e.stopPropagation()} style={{background:'var(--surface-1,#15151c)',border:'1px solid var(--border-default)',borderRadius:'var(--r-lg,12px)',padding:'20px 22px',width:'min(440px,100%)',boxShadow:'0 20px 60px rgba(0,0,0,0.5)'}}>
      <div style={{fontSize:16,fontWeight:700,marginBottom:4}}>Log a business event</div>
      <div style={{fontSize:12.5,color:'var(--text-secondary)',marginBottom:16,lineHeight:1.5}}>Tell the diagnostic what happened — it'll factor this into the read straight away (e.g. a deliberate spend test stops an MER dip reading as fatigue).</div>
      <label style={{fontSize:11,color:'var(--text-faint)',textTransform:'uppercase',letterSpacing:'.05em'}}>Type</label>
      <select value={type} onChange={e=>setType(e.target.value)} style={{width:'100%',margin:'4px 0 12px',padding:'8px 10px',background:'transparent',border:'1px solid var(--border-subtle)',borderRadius:6,color:'var(--text-primary)',colorScheme:'light dark'}}>
        {Object.keys(EVENT_META).map(k=><option key={k} value={k}>{EVENT_META[k].icon} {EVENT_META[k].label}</option>)}
      </select>
      <label style={{fontSize:11,color:'var(--text-faint)',textTransform:'uppercase',letterSpacing:'.05em'}}>Title</label>
      <input value={title} onChange={e=>setTitle(e.target.value)} placeholder="e.g. Scaled Meta prospecting +40% (growth test)" style={{width:'100%',margin:'4px 0 12px',padding:'8px 10px',background:'transparent',border:'1px solid var(--border-subtle)',borderRadius:6,color:'var(--text-primary)'}}/>
      <div style={{display:'flex',gap:10}}>
        <div style={{flex:1}}>
          <label style={{fontSize:11,color:'var(--text-faint)',textTransform:'uppercase',letterSpacing:'.05em'}}>Start</label>
          <input type="date" value={starts} onChange={e=>setStarts(e.target.value)} style={{width:'100%',margin:'4px 0 12px',padding:'8px 10px',background:'transparent',border:'1px solid var(--border-subtle)',borderRadius:6,color:'var(--text-primary)',colorScheme:'light dark'}}/>
        </div>
        <div style={{flex:1}}>
          <label style={{fontSize:11,color:'var(--text-faint)',textTransform:'uppercase',letterSpacing:'.05em'}}>End <span style={{textTransform:'none'}}>(optional)</span></label>
          <input type="date" value={ends} onChange={e=>setEnds(e.target.value)} style={{width:'100%',margin:'4px 0 12px',padding:'8px 10px',background:'transparent',border:'1px solid var(--border-subtle)',borderRadius:6,color:'var(--text-primary)',colorScheme:'light dark'}}/>
        </div>
      </div>
      <label style={{fontSize:11,color:'var(--text-faint)',textTransform:'uppercase',letterSpacing:'.05em'}}>Note <span style={{textTransform:'none'}}>(optional)</span></label>
      <input value={note} onChange={e=>setNote(e.target.value)} placeholder="e.g. 60-day payback horizon" style={{width:'100%',margin:'4px 0 16px',padding:'8px 10px',background:'transparent',border:'1px solid var(--border-subtle)',borderRadius:6,color:'var(--text-primary)'}}/>
      <div style={{display:'flex',gap:10,justifyContent:'flex-end'}}>
        <button onClick={onClose} style={{padding:'8px 14px',background:'transparent',border:'1px solid var(--border-subtle)',borderRadius:6,color:'var(--text-secondary)',cursor:'pointer',fontWeight:600}}>Cancel</button>
        <button onClick={save} disabled={!title.trim()||!starts} style={{padding:'8px 14px',background:(title.trim()&&starts)?'var(--accent)':'var(--border-subtle)',border:'none',borderRadius:6,color:'#fff',cursor:(title.trim()&&starts)?'pointer':'default',fontWeight:600}}>Log event</button>
      </div>
    </div>
  </div>);
}
function LogEventButton({onClick}){
  return (<button onClick={onClick} title="Log a promo, launch, price change or spend test"
    style={{background:'transparent',border:'1px solid var(--border-subtle)',borderRadius:6,color:'var(--text-secondary)',cursor:'pointer',fontSize:11.5,fontWeight:600,padding:'4px 9px',whiteSpace:'nowrap'}}>+ Log event</button>);
}

function DiagnosticCard({metrics, context, period, onLogEvent}){
  const dx = runDiagnostic(metrics, context);
  const [logOpen,setLogOpen] = React.useState(false);
  const onSaved = () => { onLogEvent && onLogEvent(); };
  const read = (typeof window!=='undefined' && window.FRKL_DX_ANALYST && period) ? window.FRKL_DX_ANALYST[period] : null;
  const logUI = (<>{logOpen && <LogEventModal onClose={()=>setLogOpen(false)} onSaved={onSaved}/>}</>);
  if (read && read.headline) return <AnalystRead read={read} dx={dx} metrics={metrics} onLog={()=>setLogOpen(true)} logUI={logUI}/>;
  const sevColor = s => s==='red'?'var(--bad)':'var(--warn)';
  if (!dx.findings.length) return (<div className="card">
    {logUI}
    <div className="card-section-title"><h2 style={{margin:0}}>Operator diagnostic <span style={{color:'var(--text-faint)',fontWeight:400,fontSize:13}}>— what the numbers say right now</span></h2><div style={{display:'flex',alignItems:'center',gap:10}}><span className="meta">Live cross-metric read</span><LogEventButton onClick={()=>setLogOpen(true)}/></div></div>
    <div className="note">No binding constraint this period — funnel, margin and unit economics are all within healthy ranges. Keep scaling while LTV:CAC holds above 3×.</div>
    <ContextConsidered dx={dx}/>
  </div>);
  const top = dx.findings[0];
  return (<div className="card">
    {logUI}
    <div className="card-section-title">
      <h2 style={{margin:0}}>Operator diagnostic <span style={{color:'var(--text-faint)',fontWeight:400,fontSize:13}}>— what the numbers say right now</span></h2>
      <div style={{display:'flex',alignItems:'center',gap:10}}><span className="meta">Live cross-metric read{dx.inPlay>0?` · ~${GBP(dx.inPlay)} contribution in play`:''}</span><LogEventButton onClick={()=>setLogOpen(true)}/></div>
    </div>
    <div style={{padding:'12px 16px',borderRadius:'var(--r-md)',background:'rgba(124,140,255,0.06)',border:'1px solid var(--border-subtle)',marginBottom:14}}>
      <div style={{fontSize:11,letterSpacing:'.05em',textTransform:'uppercase',color:'var(--text-faint)'}}>Biggest lever</div>
      <div style={{fontSize:16,fontWeight:700,color:'var(--text-primary)',marginTop:2}}>{top.title}</div>
      <div style={{fontSize:13,color:'var(--text-secondary)',marginTop:4,lineHeight:1.5}}>{top.evidence}</div>
    </div>
    <div style={{display:'flex',flexDirection:'column'}}>
      {dx.findings.map((x,i)=>(
        <div key={i} style={{display:'flex',gap:12,alignItems:'flex-start',padding:'11px 0',borderTop:i?'1px solid var(--border-subtle)':'none'}}>
          <span style={{width:8,height:8,borderRadius:'50%',background:sevColor(x.sev),marginTop:6,flexShrink:0}}/>
          <div style={{flex:1}}>
            <div style={{display:'flex',justifyContent:'space-between',gap:10,alignItems:'baseline'}}>
              <span style={{fontWeight:600,color:'var(--text-primary)'}}>{x.area}: {x.metric}</span>
              {x.gbp>0 && <span style={{fontWeight:700,color:'var(--good)',whiteSpace:'nowrap'}}>~{GBP(x.gbp)}</span>}
            </div>
            <div style={{fontSize:13,color:'var(--text-secondary)',marginTop:3,lineHeight:1.5}}>→ {x.action}</div>
          </div>
        </div>
      ))}
    </div>
    <ContextConsidered dx={dx}/>
    <div className="note" style={{marginTop:10}}>Computed live from this period's metrics via the operator model (funnel × unit economics × margin), with decomposition + event detection applied before ranking. £ are contribution-impact estimates used to rank leverage — not forecasts.</div>
  </div>);
}

function LtvCacCard({daily, gm, ordersPerCust}){
  if (!ordersPerCust || !daily || !daily.length) return null;
  // Bucket the windowed daily series into ISO weeks (Monday start).
  const wk = {};
  daily.forEach(d=>{
    const dt = new Date(d.date+'T00:00:00Z'); const off=(dt.getUTCDay()+6)%7; dt.setUTCDate(dt.getUTCDate()-off);
    const key = dt.toISOString().slice(0,10);
    const b = wk[key] || (wk[key]={week:key, label:key.slice(5), spend:0, rev:0, orders:0});
    b.spend += d.paid||0; b.rev += d.revenue||0; b.orders += d.orders||0;
  });
  const rows = Object.values(wk).sort((a,b)=>a.week<b.week?-1:1).map(b=>{
    const newCust = b.orders/ordersPerCust;
    const cac = newCust>0 ? +(b.spend/newCust).toFixed(2) : null;
    const aov = b.orders>0 ? b.rev/b.orders : 0;
    const ltv = +(aov*gm*ordersPerCust).toFixed(2);
    return {...b, cac, ltv, ratio: cac ? +(ltv/cac).toFixed(2) : null};
  });
  const tot = rows.reduce((a,r)=>({spend:a.spend+r.spend, rev:a.rev+r.rev, orders:a.orders+r.orders}),{spend:0,rev:0,orders:0});
  const totNew = tot.orders/ordersPerCust;
  const cacT = totNew>0 ? tot.spend/totNew : null;
  const aovT = tot.orders>0 ? tot.rev/tot.orders : 0;
  const ltvT = aovT*gm*ordersPerCust;
  const ratioT = cacT ? ltvT/cacT : null;
  const single = rows.length <= 1;
  return (<div className="card">
    <div className="card-section-title">
      <h2 style={{margin:0}}>LTV : CAC over time <span style={{color:'var(--text-faint)',fontWeight:400,fontSize:13}}>— weekly · est.</span></h2>
      <span className="meta">This period: CAC {GBP(cacT)} · LTV {GBP(ltvT)} · ratio <b style={{color:(ratioT||0)>=3?'var(--good)':(ratioT||0)>=1?'var(--warn)':'var(--bad)'}}>{ratioT?ratioT.toFixed(1)+'×':'—'}</b> · target 3×+</span>
    </div>
    <R.ResponsiveContainer width="100%" height={312}>
      <R.ComposedChart data={rows} margin={{top:6,right:20,left:14,bottom:22}}>
        <R.CartesianGrid stroke="#1f1f27" vertical={false}/>
        <R.XAxis dataKey="label" tick={{fill:'#7e7e8a',fontSize:11}} label={{value:'Week (starting)', position:'insideBottom', offset:-10, fill:'#6f6f7b', fontSize:11}}/>
        <R.YAxis yAxisId="l" tick={{fill:'#7e7e8a',fontSize:11}} tickFormatter={v=>'£'+v} label={{value:'£ per customer', angle:-90, position:'insideLeft', style:{textAnchor:'middle'}, fill:'#6f6f7b', fontSize:11}}/>
        <R.YAxis yAxisId="r" orientation="right" tick={{fill:'#7e7e8a',fontSize:11}} tickFormatter={v=>v+'×'} label={{value:'LTV:CAC', angle:90, position:'insideRight', style:{textAnchor:'middle'}, fill:'#6f6f7b', fontSize:11}}/>
        <R.Tooltip contentStyle={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:10,boxShadow:'var(--shadow-md)'}} formatter={(v,nm)=> nm==='LTV:CAC' ? v+'×' : GBP(v)} labelFormatter={l=>'Week of '+l}/>
        <R.Legend verticalAlign="top" align="center" wrapperStyle={{fontSize:12, paddingBottom:8}}/>
        <R.Line yAxisId="l" type="monotone" dataKey="ltv" name="LTV" stroke={COL.revenue} strokeWidth={2.2} dot={single?{r:3}:false}/>
        <R.Line yAxisId="l" type="monotone" dataKey="cac" name="CAC" stroke={COL.meta} strokeWidth={2.2} dot={single?{r:3}:false}/>
        <R.Line yAxisId="r" type="monotone" dataKey="ratio" name="LTV:CAC" stroke={COL.email} strokeWidth={2} strokeDasharray="4 3" dot={single?{r:3}:false}/>
        <R.ReferenceLine yAxisId="r" y={3} stroke={COL.email} strokeDasharray="5 4" strokeOpacity={0.7}
          label={{value:'3× target', position:'insideTopRight', fill:COL.email, fontSize:10.5}}/>
        <R.Brush {...brushProps('label')} />
      </R.ComposedChart>
    </R.ResponsiveContainer>
    <div style={{fontSize:10.5,color:'var(--text-faint)',textAlign:'right',marginTop:2}}>{BRUSH_HINT}</div>
    <div className="note" style={{marginTop:8}}>Weekly estimate: CAC = paid spend ÷ new customers (new-customer share from repeat data); LTV = AOV × gross margin ({PCT(gm)}) × repeat orders/customer. Healthy DTC unit economics run LTV:CAC ≥ 3×.</div>
    <ChartFooter note="Is growth profitable? Watch LTV:CAC against the 3× line week to week."
      ask="Looking at the LTV vs CAC trend, is my growth profitable and is the LTV:CAC ratio improving or deteriorating?"
      rows={rows} columns={[{key:'label',label:'Week'},{key:'ltv',label:'LTV',right:true,fmt:v=>GBP(v)},{key:'cac',label:'CAC',right:true,fmt:v=>GBP(v)},{key:'ratio',label:'LTV:CAC',right:true,fmt:v=>v!=null?v.toFixed(2)+'×':'—'}]}/>
  </div>);
}

function ContributionCard({rev, orders, paid, gm}){
  // Fully-loaded contribution. COGS comes from live product margin; the variable
  // operating costs (packaging / fulfilment / shipping / payment fees / refunds)
  // aren't in any connected source — they're operator inputs, editable here and
  // saved to the browser. rev/orders/paid are period-windowed.
  // Inputs are stored as the RAW TEXT the user typed (so "0.", "1.5", "" all work);
  // parsed to numbers only at compute time. This avoids the wipe-on-keystroke bug.
  const DEFAULTS = {packaging:'0.50', fulfilment:'2.00', shipping:'3.50', payPct:'1.5', payFixed:'0.25', refundPct:'7.4'};
  const [inp, setInp] = useState(()=>{ try { return {...DEFAULTS, ...(JSON.parse(localStorage.getItem('frkl-contrib-inputs')||'{}'))}; } catch(e){ return DEFAULTS; } });
  // Store the raw typed text untouched (uncontrolled input → React never reverts
  // what you type). Parse leniently at compute time, accepting comma decimals.
  const set = (k,v)=>{ const next={...inp,[k]:v}; setInp(next); try{localStorage.setItem('frkl-contrib-inputs',JSON.stringify(next));}catch(e){} };
  const n = k => { const f = parseFloat(String(inp[k]==null?'':inp[k]).replace(',','.').replace(/[^0-9.]/g,'')); return isFinite(f) ? f : 0; };
  const cogs = rev*(1-gm), grossProfit = rev*gm;
  const packaging = n('packaging')*orders, fulfilment = n('fulfilment')*orders, shipping = n('shipping')*orders;
  const payFees = (n('payPct')/100)*rev + n('payFixed')*orders;
  const refunds = (n('refundPct')/100)*rev;
  const contribution = grossProfit - packaging - fulfilment - shipping - payFees - refunds - paid;
  const cmPct = rev>0 ? contribution/rev : null;
  const inStyle = {width:74, background:'var(--bg-base)', border:'1px solid var(--border-default)', borderRadius:5, color:'var(--text-primary)', fontSize:12.5, padding:'3px 7px', textAlign:'right', colorScheme:'light dark'};
  const ed = (k, suffix) => <span style={{color:'var(--text-faint)',fontSize:11,fontWeight:400}}> (<input type="text" inputMode="decimal" defaultValue={inp[k]} onChange={e=>set(k,e.target.value)} onFocus={e=>e.target.select()} style={inStyle}/>{suffix})</span>;
  return (<div className="card">
    <div className="card-section-title">
      <h2 style={{margin:0}}>Contribution margin <span style={{color:'var(--text-faint)',fontWeight:400,fontSize:13}}>— fully loaded · {NUM(orders)} orders</span></h2>
      <span className="meta">COGS from live product margin {PCT(gm)} · variable costs editable (saved in your browser)</span>
    </div>
    <div style={{maxWidth:620,fontSize:14}}>
      <CmRow label="Net revenue" amount={GBP(rev)} bold color="var(--text-primary)" top="none"/>
      <CmRow label={`− COGS (${PCT(1-gm)})`} amount={'−'+GBP(cogs)} color="var(--text-muted)"/>
      <CmRow label="= Gross profit" amount={GBP(grossProfit)} bold color="var(--good)"/>
      <CmRow label={<span>− Packaging{ed('packaging','/order')}</span>} amount={'−'+GBP(packaging)} color="var(--text-muted)"/>
      <CmRow label={<span>− Fulfilment{ed('fulfilment','/order')}</span>} amount={'−'+GBP(fulfilment)} color="var(--text-muted)"/>
      <CmRow label={<span>− Shipping{ed('shipping','/order')}</span>} amount={'−'+GBP(shipping)} color="var(--text-muted)"/>
      <CmRow label={<span>− Payment fees{ed('payPct','%')}{ed('payFixed','/order')}</span>} amount={'−'+GBP(payFees)} color="var(--text-muted)"/>
      <CmRow label={<span>− Refunds{ed('refundPct','%')}</span>} amount={'−'+GBP(refunds)} color="var(--text-muted)"/>
      <CmRow label="− Paid ad spend" amount={'−'+GBP(paid)} color="var(--text-muted)"/>
      <CmRow label="= Contribution after marketing" amount={GBP(contribution)} bold color={contribution>=0?'var(--good)':'var(--bad)'} top="2px solid var(--border-default)"/>
      <div style={{display:'flex',justifyContent:'space-between',padding:'4px 0',fontWeight:700}}>
        <span>Contribution margin %</span><span style={{color:(cmPct||0)>=0?'var(--good)':'var(--bad)'}}>{PCT(cmPct)}</span>
      </div>
    </div>
    <div className="note" style={{marginTop:10}}>
      Edit the per-order costs + fee rate to your actuals — the waterfall recomputes live for the selected period. COGS is the blended product margin from live catalogue data. <b>Refunds:</b> Shopify net revenue here doesn't yet net out refunds, so they're subtracted in this line; capturing refunds in the Shopify sync will fold them into net revenue and make this exact.
    </div>
  </div>);
}

// ── P&L + forecast engine (detailed, seasonalised) ──────────────────────────
// Revenue is built from real operator levers, split NEW (acquisition) vs RETURNING
// (a compounding customer base) vs WHOLESALE, every line seasonalised by calendar
// month. Top-down keeps a simple revenue×growth path with marketing implied at MER.
const FC_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const FC_SEASON = [0.75,1.05,1.10,0.95,0.95,0.85,0.80,0.85,0.95,1.05,1.30,1.40];  // UK jewellery, avg≈1.0
function projectPnL(inp, n, mode){
  const months = Math.max(1, Math.min(36, Math.round(n('horizon')) || 12));
  const startM = (Math.max(1, Math.min(12, Math.round(n('startMonth')) || 1)) - 1);   // 0-indexed calendar month
  const seas = FC_MONTHS.map((_,j)=>{ const v = n('seas'+j); return v>0 ? v : 1; });
  const gm = n('gmPct')/100;
  const newAov = n('newAov') || n('aov') || 1, retAov = n('returnAov') || newAov;
  const pack=n('packaging'), ful=n('fulfilment'), ship=n('shipping'), payPct=n('payPct')/100, payFix=n('payFixed'), refPct=n('refundPct')/100;
  const opex = n('fixedOpex');
  const rows = [];
  let base = n('startBase'), prevNew = 0;
  for(let i=0;i<months;i++){
    const cm = (startM + i) % 12, s = seas[cm];
    let revenue, paidSpend, ordersN, newRev=0, retRev=0, whRev=0, newCust=0, retOrders=0;
    if(mode==='topdown'){
      const g = n('growthPct')/100;
      revenue = n('startRevenue')*Math.pow(1+g,i)*s;
      paidSpend = revenue/(n('targetMER')||1);          // marketing implied at target efficiency
      ordersN = revenue/newAov;
      newRev = revenue;
    } else {
      const paidSp = n('startSpend')*Math.pow(1+n('spendGrowthPct')/100,i);
      const cac = n('cac')||1;
      const paidNew = cac>0 ? paidSp/cac : 0;            // CAC bundles CPM×CTR×CVR
      const orgNew = n('organicNew')*Math.pow(1+n('organicGrowthPct')/100,i);
      newCust = (paidNew + orgNew)*s;
      base = (i===0) ? n('startBase') : (base*(1-n('churnPct')/100) + prevNew);   // last month's acquirers join the base
      retOrders = base*(n('repeatRate')/100)*s;
      newRev = newCust*newAov;
      retRev = retOrders*retAov;
      whRev = n('wholesale')*Math.pow(1+n('wholesaleGrowthPct')/100,i);            // own stream, un-seasonalised
      revenue = newRev + retRev + whRev;
      paidSpend = paidSp;
      ordersN = newCust + retOrders;
      prevNew = newCust;
    }
    const cogs = revenue*(1-gm), grossProfit = revenue - cogs;
    const varCosts = ordersN*(pack+ful+ship+payFix) + revenue*payPct + revenue*refPct;
    const contribution = grossProfit - varCosts - paidSpend;
    const ebitda = contribution - opex;
    rows.push({i, label:FC_MONTHS[cm],
      revenue:Math.round(revenue), newRev:Math.round(newRev), retRev:Math.round(retRev), whRev:Math.round(whRev),
      paidSpend:Math.round(paidSpend), orders:Math.round(ordersN),
      cogs:Math.round(cogs), grossProfit:Math.round(grossProfit), varCosts:Math.round(varCosts),
      contribution:Math.round(contribution), ebitda:Math.round(ebitda)});
  }
  return rows;
}
function pnlTotals(rows){
  const s = k => rows.reduce((a,r)=>a+r[k],0);
  const t = {revenue:s('revenue'), newRev:s('newRev'), retRev:s('retRev'), whRev:s('whRev'),
             cogs:s('cogs'), grossProfit:s('grossProfit'), varCosts:s('varCosts'),
             paidSpend:s('paidSpend'), contribution:s('contribution'), ebitda:s('ebitda')};
  t.opex = t.contribution - t.ebitda;
  t.cmPct = t.revenue>0 ? t.contribution/t.revenue : 0;
  t.ebitdaPct = t.revenue>0 ? t.ebitda/t.revenue : 0;
  return t;
}
function ForecastCard({rev, orders, paid, gm, aov, cac, returningPct}){
  const COST_DEFAULTS = {packaging:'0.50', fulfilment:'2.00', shipping:'3.50', payPct:'1.5', payFixed:'0.25', refundPct:'7.4'};
  let contribSaved = {}; try { contribSaved = JSON.parse(localStorage.getItem('frkl-contrib-inputs')||'{}'); } catch(e){}
  // Seed the driver tree from live data so defaults reproduce roughly the current run-rate.
  const retShare = (returningPct!=null && returningPct>0 && returningPct<1) ? returningPct : 0.3;
  const newOrders = Math.max(1, Math.round((orders||1)*(1-retShare)));
  const retOrdersNow = Math.max(0, Math.round((orders||0)*retShare));
  const aovN = Math.round(aov||83);
  const cacSeed = (cac && cac>0) ? cac : (paid>0 && newOrders>0 ? paid/newOrders : 35);
  const paidNewSeed = cacSeed>0 ? (paid||0)/cacSeed : 0;
  const orgNewSeed = Math.max(0, Math.round(newOrders - paidNewSeed));
  const repeatSeed = 8;                                  // %/mo of base reordering
  const baseSeed = Math.round(retOrdersNow / (repeatSeed/100));
  const nowMonth = (()=>{ try { return new Date().getMonth()+1; } catch(e){ return 6; } })();
  const seed = {
    mode:'bottomup', horizon:'12', startMonth:String(nowMonth), gmPct:((gm||0.77)*100).toFixed(1), fixedOpex:(()=>{ try{ const o=cashConfig().overheads; return (o!=null&&o!=='')?String(o):'0'; }catch(e){ return '0'; } })(),
    aov:String(aovN), newAov:String(aovN), returnAov:String(aovN),
    startRevenue:String(Math.round(rev||0)), growthPct:'4', targetMER:(paid>0?(rev/paid):4.5).toFixed(2),
    startSpend:String(Math.round(paid||0)), spendGrowthPct:'4', cac:String(Math.round(cacSeed)),
    organicNew:String(orgNewSeed), organicGrowthPct:'3',
    repeatRate:String(repeatSeed), churnPct:'3', startBase:String(baseSeed),
    wholesale:'0', wholesaleGrowthPct:'0',
  };
  FC_SEASON.forEach((v,j)=>{ seed['seas'+j] = String(v); });
  const DEFAULTS = {...COST_DEFAULTS, ...contribSaved, ...seed};
  const [inp, setInp] = useState(()=>{ try { return {...DEFAULTS, ...(JSON.parse(localStorage.getItem('frkl-forecast-inputs')||'{}'))}; } catch(e){ return DEFAULTS; } });
  const [showAdv, setShowAdv] = useState(false);
  const [showWork, setShowWork] = useState(false);
  const set = (k,v)=>{ const next={...inp,[k]:v}; setInp(next); try{localStorage.setItem('frkl-forecast-inputs',JSON.stringify(next));}catch(e){} };
  const nOf = obj => k => { const f = parseFloat(String(obj[k]==null?'':obj[k]).replace(',','.').replace(/[^0-9.]/g,'')); return isFinite(f)?f:0; };
  const n = nOf(inp);
  const mode = inp.mode==='topdown' ? 'topdown' : 'bottomup';

  const rows = projectPnL(inp, n, mode);
  const t = pnlTotals(rows);
  const beIdx = rows.findIndex(r=>r.ebitda>0);
  const beLabel = rows.length && rows[0].ebitda>0 ? 'Profitable from M1' : beIdx<0 ? 'Not within horizon' : rows[beIdx].label+' (M'+(beIdx+1)+')';
  const pctOf = v => t.revenue>0 ? Math.round(100*v/t.revenue) : 0;

  // Scenario band — flex the growth + retention/efficiency levers.
  const scen = (gMult, eMult) => {
    const o = {...inp};
    if(mode==='topdown'){ o.growthPct = String(n('growthPct')*gMult); }
    else { o.spendGrowthPct=String(n('spendGrowthPct')*gMult); o.organicGrowthPct=String(n('organicGrowthPct')*gMult); o.repeatRate=String(n('repeatRate')*eMult); }
    return pnlTotals(projectPnL(o, nOf(o), mode));
  };
  const downside = scen(0.4,0.85), upside = scen(1.6,1.15);

  const inStyle = {width:80, background:'var(--bg-base)', border:'1px solid var(--border-default)', borderRadius:5, color:'var(--text-primary)', fontSize:12.5, padding:'4px 7px', textAlign:'right', colorScheme:'light dark'};
  const seasStyle = {...inStyle, width:40, padding:'3px 4px'};
  const fld = (k,label,pre,suf)=>(<label style={{display:'flex',flexDirection:'column',gap:3,fontSize:10.5,color:'var(--text-faint)',textTransform:'uppercase',letterSpacing:'.04em'}}>
    <span>{label}</span>
    <span style={{display:'flex',alignItems:'center',gap:4,color:'var(--text-secondary)',textTransform:'none'}}>
      {pre&&<span>{pre}</span>}<input type="text" inputMode="decimal" defaultValue={inp[k]} onChange={e=>set(k,e.target.value)} onFocus={e=>e.target.select()} style={inStyle}/>{suf&&<span>{suf}</span>}
    </span>
  </label>);
  const tile = (label,val,sub,col)=>(<div style={{flex:'1 1 130px',padding:'10px 12px',borderRadius:'var(--r-md)',background:'rgba(255,255,255,0.02)',border:'1px solid var(--border-subtle)'}}>
    <div style={{fontSize:10.5,letterSpacing:'.05em',textTransform:'uppercase',color:'var(--text-faint)'}}>{label}</div>
    <div style={{fontSize:18,fontWeight:700,color:col||'var(--text-primary)',marginTop:2}}>{val}</div>
    {sub&&<div style={{fontSize:11,color:'var(--text-muted)',marginTop:1}}>{sub}</div>}
  </div>);
  const modeBtn = (key,label)=>(<button onClick={()=>set('mode',key)} style={{padding:'5px 11px',borderRadius:6,border:'1px solid '+(mode===key?'var(--accent)':'var(--border-subtle)'),background:mode===key?'rgba(124,140,255,0.14)':'transparent',color:mode===key?'var(--text-primary)':'var(--text-muted)',fontSize:12,fontWeight:600,cursor:'pointer'}}>{label}</button>);
  const annLabel = rows.length===12 ? 'Year 1' : rows.length+'-month';

  return (<div className="card">
    <div className="card-section-title">
      <h2 style={{margin:0}}>P&amp;L &amp; forecast <span style={{color:'var(--text-faint)',fontWeight:400,fontSize:13}}>— {annLabel}, seasonalised</span></h2>
      <div style={{display:'flex',gap:6}}>{modeBtn('topdown','Top-down')}{modeBtn('bottomup','Bottom-up')}</div>
    </div>

    {/* Assumptions — all number inputs at the TOP, before the outputs */}
    <div style={{marginTop:6}}>
      <div style={{fontSize:11,letterSpacing:'.05em',textTransform:'uppercase',color:'var(--text-faint)',marginBottom:8}}>Assumptions <span style={{textTransform:'none',letterSpacing:0,color:'var(--text-muted)'}}>· seeded from last 30 days · saved in your browser · edit to recompute below</span></div>
      <div style={{display:'flex',gap:14,flexWrap:'wrap',marginBottom:8}}>
        {mode==='topdown' ? (<>
          {fld('startRevenue','Start revenue','£')}
          {fld('growthPct','Growth /mo',null,'%')}
          {fld('targetMER','Target MER',null,'×')}
          {fld('newAov','AOV','£')}
        </>) : (<>
          {fld('startSpend','Paid spend /mo','£')}
          {fld('spendGrowthPct','Spend growth /mo',null,'%')}
          {fld('cac','CAC','£')}
          {fld('newAov','New AOV','£')}
          {fld('organicNew','Organic new /mo',null,'cust')}
          {fld('organicGrowthPct','Organic growth /mo',null,'%')}
          {fld('repeatRate','Repeat rate /mo',null,'%')}
          {fld('returnAov','Returning AOV','£')}
        </>)}
      </div>
      <div style={{display:'flex',gap:14,flexWrap:'wrap'}}>
        {fld('gmPct','Gross margin',null,'%')}
        {fld('fixedOpex','Fixed opex /mo','£')}
        {fld('horizon','Horizon',null,'mo')}
        {fld('startMonth','Start month (1-12)',null,null)}
      </div>
    </div>

    {/* Advanced — retention, wholesale, seasonality */}
    <Disclosure label="Advanced — retention base, wholesale & seasonality" open={showAdv} onToggle={()=>setShowAdv(s=>!s)}/>
    {showAdv && (
      <div style={{padding:'10px 0 0 4px'}}>
        {mode==='bottomup' && <div style={{display:'flex',gap:14,flexWrap:'wrap',marginBottom:12}}>
          {fld('startBase','Customer base',null,'cust')}
          {fld('churnPct','Monthly churn',null,'%')}
          {fld('wholesale','Wholesale /mo','£')}
          {fld('wholesaleGrowthPct','Wholesale growth /mo',null,'%')}
        </div>}
        <div style={{fontSize:10.5,letterSpacing:'.04em',textTransform:'uppercase',color:'var(--text-faint)',marginBottom:6}}>Seasonality index <span style={{textTransform:'none',letterSpacing:0,color:'var(--text-muted)'}}>· 1.0 = average month · default = UK jewellery (Nov–Dec, Feb, Mar peaks)</span></div>
        <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
          {FC_MONTHS.map((m,j)=>(<label key={j} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:2,fontSize:10,color:'var(--text-faint)'}}>
            <span>{m}</span>
            <input type="text" inputMode="decimal" defaultValue={inp['seas'+j]} onChange={e=>set('seas'+j,e.target.value)} onFocus={e=>e.target.select()} style={seasStyle}/>
          </label>))}
        </div>
      </div>
    )}

    {/* Outputs — recompute live from the assumptions above */}
    <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:6}}>
      {tile(annLabel+' revenue', GBP(t.revenue), null)}
      {tile(annLabel+' contribution', GBP(t.contribution), PCT(t.cmPct)+' margin', t.contribution>=0?'var(--good)':'var(--bad)')}
      {tile(annLabel+' EBITDA', GBP(t.ebitda), PCT(t.ebitdaPct)+' margin', t.ebitda>=0?'var(--good)':'var(--bad)')}
      {tile('EBITDA break-even', beLabel, mode==='bottomup'?('repeat '+n('repeatRate').toFixed(0)+'%/mo'):('growth '+n('growthPct').toFixed(0)+'%/mo'))}
    </div>
    {mode==='bottomup' && <div style={{fontSize:12,color:'var(--text-muted)',marginBottom:10}}>Revenue mix: <b style={{color:'#7c8cff'}}>New {pctOf(t.newRev)}%</b> · <b style={{color:'#6ee7b7'}}>Returning {pctOf(t.retRev)}%</b>{t.whRev>0?<> · <b style={{color:'#f59e0b'}}>Wholesale {pctOf(t.whRev)}%</b></>:''} — returning revenue compounds as the base grows.</div>}

    <R.ResponsiveContainer width="100%" height={250}>
      <R.ComposedChart data={rows} margin={{top:6,right:16,left:14,bottom:20}}>
        <R.CartesianGrid stroke="#1f1f27" vertical={false}/>
        <R.XAxis dataKey="label" tick={{fill:'#7e7e8a',fontSize:11}} label={{value:'Month', position:'insideBottom', offset:-9, fill:'#6f6f7b', fontSize:11}}/>
        <R.YAxis tick={{fill:'#7e7e8a',fontSize:11}} tickFormatter={v=>'£'+(Math.abs(v)>=1000?(v/1000).toFixed(0)+'k':v)} width={52}/>
        <R.Tooltip contentStyle={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:10}} formatter={v=>GBP(v)}/>
        <R.Legend verticalAlign="top" align="center" wrapperStyle={{fontSize:12, paddingBottom:8}}/>
        {mode==='bottomup' ? [
          <R.Area key="n" type="monotone" dataKey="newRev" name="New" stackId="rev" stroke="#7c8cff" fill="rgba(124,140,255,0.5)" strokeWidth={1}/>,
          <R.Area key="r" type="monotone" dataKey="retRev" name="Returning" stackId="rev" stroke="#6ee7b7" fill="rgba(110,231,183,0.45)" strokeWidth={1}/>,
          <R.Area key="w" type="monotone" dataKey="whRev" name="Wholesale" stackId="rev" stroke="#f59e0b" fill="rgba(245,158,11,0.4)" strokeWidth={1}/>
        ] : (
          <R.Area key="rev" type="monotone" dataKey="revenue" name="Revenue" stroke="#7c8cff" fill="rgba(124,140,255,0.16)" strokeWidth={2}/>
        )}
        <R.Line type="monotone" dataKey="ebitda" name="EBITDA" stroke="#f0f0f4" strokeWidth={2} strokeDasharray="4 3" dot={false}/>
      </R.ComposedChart>
    </R.ResponsiveContainer>

    {/* Scenario band — investor-grade */}
    <div style={{marginTop:14,overflowX:'auto'}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:12.5,minWidth:420}}>
        <thead><tr style={{color:'var(--text-faint)',textAlign:'right'}}>
          <th style={{textAlign:'left',fontWeight:600,padding:'4px 0'}}>{annLabel} scenario</th>
          <th style={{fontWeight:600,padding:'4px 8px'}}>Downside</th>
          <th style={{fontWeight:600,padding:'4px 8px',color:'var(--text-secondary)'}}>Base</th>
          <th style={{fontWeight:600,padding:'4px 8px'}}>Upside</th>
        </tr></thead>
        <tbody>
          {[['Revenue','revenue'],['Contribution','contribution'],['EBITDA','ebitda']].map(([lab,key])=>(
            <tr key={key} style={{borderTop:'1px solid var(--border-subtle)',textAlign:'right'}}>
              <td style={{textAlign:'left',padding:'5px 0',color:'var(--text-secondary)'}}>{lab}</td>
              <td style={{padding:'5px 8px',color:'var(--text-muted)'}}>{GBP(downside[key])}</td>
              <td style={{padding:'5px 8px',fontWeight:700,color:'var(--text-primary)'}}>{GBP(t[key])}</td>
              <td style={{padding:'5px 8px',color:'var(--good)'}}>{GBP(upside[key])}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>

    <Disclosure label="Show annual P&L statement" open={showWork} onToggle={()=>setShowWork(s=>!s)}/>
    {showWork && (
      <div style={{maxWidth:560,fontSize:13,padding:'8px 0 0 4px'}}>
        <CmRow label={`Revenue (${annLabel})`} amount={GBP(t.revenue)} bold color="var(--text-primary)" top="none"/>
        {mode==='bottomup' && <><CmRow label="  · New customers" amount={GBP(t.newRev)} color="var(--text-muted)"/>
        <CmRow label="  · Returning customers" amount={GBP(t.retRev)} color="var(--text-muted)"/>
        {t.whRev>0 && <CmRow label="  · Wholesale" amount={GBP(t.whRev)} color="var(--text-muted)"/>}</>}
        <CmRow label={`− COGS (${PCT(1-n('gmPct')/100)})`} amount={'−'+GBP(t.cogs)} color="var(--text-muted)"/>
        <CmRow label="= Gross profit" amount={GBP(t.grossProfit)} bold color="var(--good)"/>
        <CmRow label="− Variable order costs (pack/fulfil/ship/fees/refunds)" amount={'−'+GBP(t.varCosts)} color="var(--text-muted)"/>
        <CmRow label="− Paid marketing" amount={'−'+GBP(t.paidSpend)} color="var(--text-muted)"/>
        <CmRow label="= Contribution" amount={GBP(t.contribution)} bold color={t.contribution>=0?'var(--good)':'var(--bad)'} top="2px solid var(--border-default)"/>
        <CmRow label="− Fixed overheads" amount={'−'+GBP(t.opex)} color="var(--text-muted)"/>
        <CmRow label="= EBITDA" amount={GBP(t.ebitda)} bold color={t.ebitda>=0?'var(--good)':'var(--bad)'} top="2px solid var(--border-default)"/>
      </div>
    )}

    <div className="note" style={{marginTop:10}}>
      {mode==='bottomup'
        ? <>Bottom-up: <b>New</b> = (paid spend ÷ CAC + organic new) × new AOV; <b>Returning</b> = customer base × repeat rate × returning AOV, where the base compounds (each month's new customers join it); <b>+ Wholesale</b>. Every line is seasonalised by calendar month. CAC bundles CPM×CTR×CVR — seed it from a defensible blended figure. Base + repeat rate are seeded to reproduce your current returning-order share.</>
        : <>Top-down: revenue compounds at your monthly growth rate (×seasonality); paid marketing is implied at your target MER. Cross-check against bottom-up — if the spend to hit this revenue is unaffordable, it's a wish, not a plan.</>}
      {' '}Seasonality defaults to a UK-jewellery curve (peaks Nov–Dec, Feb, Mar; troughs Jan + summer) — edit in Advanced. Scenarios flex growth + retention. Not a cash-flow model — working capital (stock + AR/AP days) sits on top.
    </div>
  </div>);
}

// ── Mobile + performance helpers (UX Phase 3) ────────────────────────────────
function useIsMobile(bp){
  const b = bp || 760;
  // Use the layout viewport (documentElement.clientWidth) — it's the reliable width
  // (window.innerWidth can lag/!= the rendered viewport in embedded/iframed contexts).
  const w = () => (typeof document!=='undefined' && document.documentElement && document.documentElement.clientWidth) || (typeof window!=='undefined' ? window.innerWidth : 1280);
  const [m, setM] = useState(()=> w() < b);
  React.useEffect(()=>{ const f=()=>setM(w() < b); window.addEventListener('resize', f); return ()=>window.removeEventListener('resize', f); }, [b]);
  return m;
}

// Defer a heavy (chart) subtree until it scrolls near the viewport — keeps cold
// first-paint fast and avoids mounting Recharts at 0-width. Reserves height so
// layout doesn't jump.
function LazyMount({minHeight, children}){
  const ref = React.useRef(null);
  const [shown, setShown] = useState(false);
  React.useEffect(()=>{
    if(shown) return;
    const el = ref.current; if(!el) return;
    let io;
    if(typeof IntersectionObserver!=='undefined'){
      io = new IntersectionObserver(es=>{ if(es.some(e=>e.isIntersecting)){ setShown(true); io.disconnect(); } }, {rootMargin:'600px'});
      io.observe(el);
    }
    // Fallback: after first paint settles, mount regardless — so a jump-scroll or
    // SPA nav-reset can never leave a section as an empty placeholder. Off-screen
    // mounting is safe (the placeholder has real column width, so no 0-width charts).
    const t = setTimeout(()=>setShown(true), 2500);
    return ()=>{ if(io) io.disconnect(); clearTimeout(t); };
  }, [shown]);
  return <div ref={ref}>{shown ? children : <Skeleton height={minHeight||320}/>}</div>;
}

// Mobile "Today" — a 60-second check-in: £ in play, the health verdict, the top 3
// £-ranked open actions (tap → ask the AI how), and one Ask button. Reads globals
// directly so it has no dependency on Overview internals.
function MobileToday(){
  const P = (typeof window!=='undefined' && window.FRKL_PATTERNS) || {};
  const dx = ((typeof window!=='undefined' && window.FRKL_DX_ANALYST) || {})['30d'] || {};
  const rollup = P.money_rollup || {};
  const am = P.action_money || {};
  const byWhen = p => ({P1:'this week', P2:'next 2 weeks', P3:'this month'})[p] || '';
  const kc = k => k==='opportunity'?'var(--good)':k==='at_risk'?'var(--warn)':'var(--bad)';
  const actions = Object.values(am)
    .filter(a => a && a.status!=='done' && a.status!=='verified-done' && Math.abs(a.monthly_impact_gbp||0) >= 50)
    .sort((a,b)=> Math.abs(b.monthly_impact_gbp||0) - Math.abs(a.monthly_impact_gbp||0))
    .slice(0,3);
  return (<div className="card" style={{borderLeft:'3px solid var(--accent)', marginBottom:14}}>
    <div style={{fontSize:11,fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',color:'var(--accent)',marginBottom:6}}>Today</div>
    {rollup.total!=null && <div style={{fontSize:22,fontWeight:750,lineHeight:1.2}}>£{(Math.round((rollup.total||0)/100)/10)}k/mo in play</div>}
    {dx.headline && <div style={{fontSize:13,color:'var(--text-secondary)',margin:'6px 0 12px',lineHeight:1.5}}>{dx.headline}</div>}
    <div style={{fontSize:11,fontWeight:700,letterSpacing:'.04em',textTransform:'uppercase',color:'var(--text-muted)',marginBottom:6}}>Do this next</div>
    <div style={{display:'flex',flexDirection:'column',gap:8}}>
      {actions.length ? actions.map((a,i)=>(
        <div key={i} onClick={()=>window.__oiAsk&&window.__oiAsk(`How do I action this, and what's the expected impact: ${a.description}`)}
          style={{padding:'10px 12px',background:'var(--bg-elevated)',border:'1px solid var(--border-subtle)',borderRadius:10,cursor:'pointer'}}>
          <div style={{fontSize:13,color:'var(--text-primary)',lineHeight:1.4}}>{a.description}</div>
          <div style={{fontSize:11,color:'var(--text-faint)',marginTop:5,display:'flex',gap:12,flexWrap:'wrap'}}>
            <span style={{color:kc(a.kind),fontWeight:600}}>~£{Math.round(Math.abs(a.monthly_impact_gbp)).toLocaleString()}/mo</span>
            {a.priority && <span>⏱ {byWhen(a.priority)}</span>}
            <span style={{color:'var(--accent)'}}>tap to ask →</span>
          </div>
        </div>
      )) : <div className="muted" style={{fontSize:12}}>No high-£ actions open right now.</div>}
    </div>
    <button onClick={()=>window.__oiAsk&&window.__oiAsk('What should I do today? Give me the top 3 actions, ranked by £ impact.')}
      style={{marginTop:12,width:'100%',padding:'12px',background:'#c084fc',border:'none',borderRadius:10,color:'#fff',fontWeight:650,fontSize:14,cursor:'pointer'}}>✦ Ask: What should I do today?</button>
    <div style={{fontSize:11,color:'var(--text-faint)',textAlign:'center',marginTop:10}}>↓ Full dashboard below</div>
  </div>);
}

// "What changed" — latest complete week vs the one before, the movers worth a look.
// Reuses the weekly-board data model (boardWeeks/boardRag); picker-independent.
// Mini trend chart for the What-changed cards — axes + hover detail (not a bare sparkline).
function WcSpark({data, color, fmt, axisFmt}){
  if(!data || data.filter(d=>d.v!=null).length < 2) return <div style={{height:66}}/>;
  return (<R.ResponsiveContainer width="100%" height={66}>
    <R.LineChart data={data} margin={{top:6, right:8, left:-6, bottom:0}}>
      <R.CartesianGrid stroke="#1f1f27" vertical={false}/>
      <R.XAxis dataKey="x" tick={{fill:'#7e7e8a', fontSize:8.5}} interval={Math.ceil(data.length/3)} tickLine={false} axisLine={{stroke:'#2a2a34'}} minTickGap={6}/>
      <R.YAxis tick={{fill:'#7e7e8a', fontSize:8.5}} width={34} tickCount={3} tickLine={false} axisLine={false} domain={['auto','auto']} tickFormatter={axisFmt||fmt}/>
      <R.Tooltip cursor={{stroke:color, strokeWidth:1, strokeDasharray:'3 3'}} content={({active,payload,label})=>{
        if(!active||!payload||!payload.length) return null; const v=payload[0].value;
        return (<div style={{background:'var(--bg-elevated)', border:'1px solid var(--border-default)', borderRadius:8, fontSize:11, padding:'5px 9px', boxShadow:'var(--shadow-md)'}}>
          <div style={{color:'var(--text-faint)', fontSize:10, marginBottom:1}}>Week of {label}</div>
          <div style={{fontWeight:700, color:'var(--text-primary)'}}>{fmt?fmt(v):v}</div>
        </div>); }}/>
      <R.Line type="monotone" dataKey="v" stroke={color} strokeWidth={1.8} dot={false} activeDot={{r:3, strokeWidth:0}} isAnimationActive={false}/>
    </R.LineChart>
  </R.ResponsiveContainer>);
}

function WhatChangedStrip(){
  const weeks = useMemo(boardWeeks, [(typeof window!=='undefined' && window.FRKL_LIVE && window.FRKL_LIVE.lastFetchAt) || 0]);  // recompute when live data arrives (was [] → froze frkl static)
  if(!weeks.length) return null;
  let i = weeks.length-1; while(i>0 && weeks[i].partial) i--;
  const W = weeks[i], prev = weeks[i-1];
  if(!W || !prev) return null;
  const gbpK = v=>'£'+(Math.abs(v)>=1000?(v/1000).toFixed(1).replace(/\.0$/,'')+'k':Math.round(v));
  const pct0 = v=>v!=null?(v*100).toFixed(0)+'%':'—';
  const SPECS = [
    {key:'revenue',       label:'Revenue',             fmt:v=>GBP(v),                              axisFmt:gbpK,                better:'up'},
    {key:'orders',        label:'Orders',              fmt:v=>NUM(v),                              axisFmt:v=>Math.round(v),    better:'up'},
    {key:'aov',           label:'AOV',                 fmt:v=>GBP(v),                              axisFmt:v=>'£'+Math.round(v), better:'up'},
    {key:'cvr',           label:'Conversion rate',     fmt:v=>v!=null?(v*100).toFixed(2)+'%':'—',  axisFmt:v=>(v*100).toFixed(1)+'%', better:'up',   bench:CVR_BENCH},
    {key:'mer',           label:'Blended ROAS',        fmt:v=>v!=null?v.toFixed(2)+'×':'—',         axisFmt:v=>v.toFixed(1)+'×', better:'up',   bench:3},
    {key:'paid',          label:'Paid spend',          fmt:v=>GBP(v),                              axisFmt:gbpK,                better:'flat'},
    {key:'discountDepth', label:'Discount depth',      fmt:v=>v!=null?(v*100).toFixed(1)+'%':'—',  axisFmt:pct0,                better:'down'},
    {key:'returnRate',    label:'Return rate',         fmt:v=>v!=null?(v*100).toFixed(1)+'%':'—',  axisFmt:pct0,                better:'down'},
    // 'Email revenue share' removed: Klaviyo orderValue over-counts (same order credited to
    // multiple emails/flows) and is gross vs Shopify net, so the share crossed 100% (e.g. 116%).
    // Attributed email revenue lives honestly in Channels → Email; kept off the board per :7487.
  ];
  const trail = (key)=> weeks.slice(Math.max(0,i-8), i+1).map(w=>({x:(w.weekStart||'').slice(5), v:w.m[key]}));
  const ddNow=W.m.discountDepth, ddPrev=prev.m.discountDepth;
  const promoUp = (ddNow!=null && ddPrev!=null && (ddNow-ddPrev) > 0.03);   // +3pp discount depth = revenue likely promo-distorted
  const rows = SPECS.map(sp=>{
    const val=W.m[sp.key], pv=prev.m[sp.key];
    const ch = (pv!=null && pv!==0 && val!=null) ? (val-pv)/Math.abs(pv) : null;
    return {...sp, val, pv, ch, rag: boardRag(sp, val, pv)};
  }).filter(r=>r.val!=null && r.ch!=null);
  const movers = rows.filter(r=> Math.abs(r.ch)>=0.03 || r.key==='revenue')
                     .sort((a,b)=> Math.abs(b.ch)-Math.abs(a.ch)).slice(0,6);
  // Level-aware status: a WoW dip on a metric that's still above its benchmark is
  // NOT "off-track" (revenue/MER down ≠ red). Red is reserved for an actual
  // benchmark breach; an un-benchmarked dip reads as "Watch", not alarm.
  const badgeFor = (r)=>{
    if(r.key==='revenue' && promoUp && r.rag!=='bad') return {kind:'promo', label:'Promo-distorted'};
    if(r.rag==='good') return {kind:'healthy', label:'Healthy'};
    if(r.rag==='bad')  return r.bench!=null ? {kind:'action', label:'Below target'} : {kind:'watch', label:'Watch'};
    if(r.rag==='warn') return {kind:'watch',  label:'Watch'};
    return {kind:'info', label:'Steady'};
  };
  return (<div>
    <div className="section-eyebrow" style={{display:'flex',alignItems:'center',gap:8,margin:'4px 0 -4px',fontSize:11,fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',color:'var(--text-muted)'}}>
      <span style={{width:3,height:14,background:'var(--text-faint)',borderRadius:2}}/>What changed · week of {W.label}
    </div>
    <div className="card">
      <div className="muted" style={{fontSize:12, marginBottom:11}}>Latest complete week vs the one before — the movers worth a look. Independent of the date picker above.</div>
      {movers.length ? (<div className="wc-grid">
        {movers.map((r,idx)=>{ const sb=badgeFor(r); const up=r.ch>=0;
          const good = r.better==='flat' ? null : (r.better==='down' ? !up : up);
          const chColor = good==null ? 'var(--text-muted)' : (good ? 'var(--good)' : 'var(--bad)');
          return (<div key={idx} className="wc-item">
            <div className="wc-top"><span className="wc-label">{r.label}</span><StatusBadge kind={sb.kind} label={sb.label}/></div>
            <div className="wc-val">{r.fmt(r.val)} <span className="wc-ch" style={{color:chColor}}>{up?'↑':'↓'}{Math.abs(r.ch*100).toFixed(0)}%</span></div>
            <WcSpark data={trail(r.key)} color={RAG_COL[r.rag]||'var(--text-faint)'} fmt={r.fmt} axisFmt={r.axisFmt}/>
          </div>);
        })}
      </div>) : (<div className="muted" style={{fontSize:13}}>Quiet week — nothing moved more than 3% vs the prior week.</div>)}
    </div>
  </div>);
}

function Overview({start, period, customActive}){
  const isMobile = useIsMobile();
  const [evTick, setEvTick] = useState(0);   // bump to re-read the operator event log
  const [costsOpen, setCostsOpen] = useState(false);
  const [showPlanning, setShowPlanning] = useState(false);  // collapse forecast/LTV deep-dive
  const costsVerified = useCostTick();       // re-renders margin figures/badges on save
  const daily = useMemo(()=>buildDaily(start),[start]);
  const end = dataEndOf();
  const prior = priorPeriod(start, end);
  const meta = inRangeBounded(D.metaDaily,start,end), gads = inRangeBounded(D.googleAds,start,end), shop = inRangeBounded(D.shopify,start,end), ga = inRangeBounded(D.ga4,start,end), kl = inRangeBounded(D.klaviyo,start,end);
  const pMeta = inRangeBounded(D.metaDaily,prior.start,prior.end), pGads = inRangeBounded(D.googleAds,prior.start,prior.end), pShop = inRangeBounded(D.shopify,prior.start,prior.end), pGa = inRangeBounded(D.ga4,prior.start,prior.end), pKl = inRangeBounded(D.klaviyo,prior.start,prior.end);
  const paid = sum(meta,'cost')+sum(gads,'cost');
  const rev = sum(shop,'netSales');
  const orders = sum(shop,'orders');
  const sessions = sum(ga,'sessions');
  const purch = sum(ga,'purchases');
  const emailRev = sum(kl,'orderValue');
  const mer = paid>0 ? rev/paid : null;
  const havePrior = pShop.length >= Math.max(3, Math.floor((shop.length||1)*0.5));
  const pPaid = havePrior ? (sum(pMeta,'cost')+sum(pGads,'cost')) : null;
  const pRev = havePrior ? sum(pShop,'netSales') : null;
  const pSessions = havePrior ? sum(pGa,'sessions') : null;
  const pEmailRev = havePrior ? sum(pKl,'orderValue') : null;
  const pMer = (havePrior && pPaid>0) ? pRev/pPaid : null;
  const seriesPaid    = daily.map(d=>({d:d.dlabel, v:d.paid}));
  const seriesRev     = daily.map(d=>({d:d.dlabel, v:d.revenue}));
  const seriesMER     = daily.map(d=>({d:d.dlabel, v: d.paid>0 ? +(d.revenue/d.paid).toFixed(2) : 0}));
  const seriesSessions= daily.map(d=>({d:d.dlabel, v:d.sessions}));
  const seriesEmail   = daily.map(d=>({d:d.dlabel, v:d.emailRev}));
  // ── Additional headline KPIs ──
  const pOrders = havePrior ? sum(pShop,'orders') : null;
  const cvr  = sessions>0 ? orders/sessions : null;
  const pCvr = (havePrior && pSessions>0) ? pOrders/pSessions : null;
  const seriesCVR = daily.map(d=>({d:d.dlabel, v: d.sessions>0 ? +(100*d.orders/d.sessions).toFixed(2) : 0}));
  const grossSales = sum(shop,'totalSales');
  const discAmt = sum(shop,'discounts');
  const discLoad = grossSales>0 ? discAmt/grossSales : null;
  const pGross = havePrior ? sum(pShop,'totalSales') : 0;
  const pDiscLoad = (havePrior && pGross>0) ? sum(pShop,'discounts')/pGross : null;
  const seriesDisc = daily.map(d=>({d:d.dlabel, v: d.totalSales>0 ? +(100*d.discounts/d.totalSales).toFixed(2) : 0}));
  // Margin-bridge inputs (current vs prior period). gross merchandise = net + discounts + returns.
  const returnsAmt = sum(shop,'returns'), pDisc = havePrior ? sum(pShop,'discounts') : 0, pReturns = havePrior ? sum(pShop,'returns') : 0;
  const bridgeCur = {orders, disc:discAmt, returns:returnsAmt, paid, grossMerch: rev + discAmt + returnsAmt};
  const bridgePri = havePrior ? {orders:pOrders, disc:pDisc, returns:pReturns, paid:pPaid, grossMerch: pRev + pDisc + pReturns} : null;
  const _dc = (window.FRKL_DISCOUNT_CODES||{}).meta || {};   // OI discount context (draft-excluded, markdown-aware)
  const _mdPct = _dc.markdownShareOfValue!=null ? Math.round(_dc.markdownShareOfValue*100) : null;
  // Business-snapshot KPIs (COGS-based, trailing 90d — not period-windowed)
  const B = window.FRKL_BUSINESS || {};
  const _prod = B.products || [];
  const _gp = _prod.reduce((a,p)=>a+(p.grossProfit||0),0), _ns = _prod.reduce((a,p)=>a+(p.netSales||0),0);
  const grossMargin = _ns>0 ? _gp/_ns : null;
  const _units = _prod.reduce((a,p)=>a+(p.units||0),0), _rets = _prod.reduce((a,p)=>a+(p.returns||0),0);
  const returnRate = _units>0 ? _rets/_units : null;
  const _rbm = B.retentionByMonth || [];
  const _ret = _rbm.reduce((a,m)=>a+(m.ret||0),0), _tot = _rbm.reduce((a,m)=>a+(m.total||0),0);
  const returningPct = _tot>0 ? _ret/_tot : null;
  // Contribution margin (after marketing): gross profit (net rev × blended product
  // margin) − paid ad spend. COGS-based; excludes shipping/payment fees/returns
  // until those inputs land. Windowed via rev/paid; prior-period comparable.
  // Per-tenant config gross margin wins when present (set by the authenticated boot); else live catalogue margin.
  // Prefer the operator's verified gross margin; else tenant config; else live catalogue margin.
  const gm = userGrossMargin() != null ? userGrossMargin()
    : (((typeof window!=='undefined' && window.OI_CONFIG && window.OI_CONFIG.grossMargin) || grossMargin) || 0);
  const cogs = rev * (1 - gm);
  const grossProfit = rev * gm;
  const contrib = grossProfit - paid;
  const cmPct = rev>0 ? contrib/rev : null;
  const pContrib = (havePrior && pRev!=null && pPaid!=null) ? (pRev*gm - pPaid) : null;
  const seriesContrib = daily.map(d=>({d:d.dlabel, v: +((d.revenue*gm) - d.paid).toFixed(0)}));
  // LTV / CAC (estimates): repeat behaviour from retentionByMonth, windowed spend + AOV.
  const _new = _rbm.reduce((a,m)=>a+(m.new||0),0);
  const ordersPerCust = _new>0 ? _tot/_new : null;               // orders per acquired customer
  const aov = orders>0 ? rev/orders : null;
  const newCust = ordersPerCust ? orders/ordersPerCust : null;   // windowed new customers
  const cac = (newCust && newCust>0) ? paid/newCust : null;
  const pNewCust = (havePrior && ordersPerCust && pOrders) ? pOrders/ordersPerCust : null;
  const pCac = (havePrior && pNewCust && pNewCust>0 && pPaid!=null) ? pPaid/pNewCust : null;
  const ltv = (aov!=null && ordersPerCust!=null) ? aov*gm*ordersPerCust : null;  // contribution LTV
  const ltvCac = (ltv!=null && cac) ? ltv/cac : null;
  // ── Hover-graph trends for the remaining headline KPIs ──
  // Real series wherever the data supports one; gross margin is a structural
  // catalogue constant so its line is deliberately flat (stability, not a bug).
  const seriesDiscVal = daily.map(d=>({d:d.dlabel, v:+((d.discounts||0)).toFixed(0)}));
  const seriesGM      = (gm? daily.map(d=>({d:d.dlabel, v:+(gm*100).toFixed(1)})) : null);
  const seriesCAC     = (ordersPerCust>0) ? daily.map(d=>({d:d.dlabel, v: d.orders>0 ? +((d.paid*ordersPerCust)/d.orders).toFixed(0) : 0})) : null;
  const seriesLTV     = (ordersPerCust>0 && gm) ? daily.map(d=>({d:d.dlabel, v: d.orders>0 ? +((d.revenue/d.orders)*gm*ordersPerCust).toFixed(0) : 0})) : null;
  const seriesReturn  = shop.map(r=>({d:(r.date||'').slice(5), v: r.totalSales>0 ? +(100*(r.returns||0)/r.totalSales).toFixed(2) : 0}));
  const seriesReturning = _rbm.length>1 ? _rbm.map((m,i)=>({d:(m.month||m.label||('M'+(i+1))), v: m.total>0 ? +(100*(m.ret||0)/m.total).toFixed(1) : 0})) : null;
  // Weekly discount penetration (orders carrying a code ÷ all orders) from the code time-series.
  const seriesPenetration = (()=>{
    const codes=(window.FRKL_DISCOUNT_CODES&&window.FRKL_DISCOUNT_CODES.codes)||[];
    if(!codes.length || !daily.length) return null;
    const monday = s => { const d=new Date(s+'T00:00:00Z'); const off=(d.getUTCDay()+6)%7; d.setUTCDate(d.getUTCDate()-off); return d.toISOString().slice(0,10); };
    const tot={}, coded={};
    daily.forEach(d=>{ const w=monday(d.date); tot[w]=(tot[w]||0)+(d.orders||0); });
    codes.forEach(c=>{ (c.series||[]).forEach(p=>{ if(tot[p.w]!=null) coded[p.w]=(coded[p.w]||0)+(p.o||0); }); });
    const wks=Object.keys(tot).sort();
    return wks.length>1 ? wks.map(w=>({d:w.slice(5), v: tot[w]>0 ? +Math.min(100,100*(coded[w]||0)/tot[w]).toFixed(1) : 0})) : null;
  })();
  // ── Unit economics (Atlas): break-even ROAS, allowable CAC, first-order payback ──
  // Variable cost rate from the contribution card's saved inputs (per-order + %).
  const _ci = (()=>{ try { return {packaging:'0.50',fulfilment:'2.00',shipping:'3.50',payPct:'1.5',payFixed:'0.25',refundPct:'7.4', ...(JSON.parse(localStorage.getItem('frkl-contrib-inputs')||'{}'))}; } catch(e){ return {}; } })();
  const _cn = k => { const f=parseFloat(String(_ci[k]==null?'':_ci[k]).replace(',','.').replace(/[^0-9.]/g,'')); return isFinite(f)?f:0; };
  const varCostRate = aov>0 ? ((_cn('packaging')+_cn('fulfilment')+_cn('shipping')+_cn('payFixed'))/aov + _cn('payPct')/100 + _cn('refundPct')/100) : 0;
  const cmRateBeforeMkt = Math.max(0.01, gm - varCostRate);                 // per-order contribution margin, pre-marketing
  const breakEvenRoas = 1/cmRateBeforeMkt;                                   // revenue ÷ spend to break even on an order
  const TARGET_LTVCAC = 3;
  const allowableCac = ltv!=null ? ltv/TARGET_LTVCAC : null;                 // max CAC that still clears 3× LTV:CAC
  const firstOrderContrib = aov!=null ? aov*cmRateBeforeMkt : null;
  const paybackOrders = (cac!=null && firstOrderContrib>0) ? cac/firstOrderContrib : null;  // orders to recover CAC
  const dxMetrics = {rev, orders, sessions, cvr, pCvr, paid, mer, pMer, cac, pCac, ltv, ltvCac, gm, contrib, pContrib, cmPct, returnRate, discLoad, pDiscLoad, returningPct, pRev,
                     aov, breakEvenRoas, allowableCac, paybackOrders, cmRateBeforeMkt,
                     pSessions, pOrders, pPaid, havePrior};
  // ── Crux scorecard = stable business "vitals" on a FIXED trailing window, NOT the
  // page date picker. A health read shouldn't whipsaw 7d↔90d as you explore charts;
  // it's pinned to the last 30 days (vs the prior 30) and labelled as such. The
  // picker still drives every chart/KPI/diagnostic below. (gm, returnRate,
  // ordersPerCust are catalogue/cohort constants — window-independent — and reused.)
  const CRUX_DAYS = 30;
  const cruxStart = (()=>{ const d=new Date(end); d.setDate(d.getDate()-(CRUX_DAYS-1)); return d.toISOString().slice(0,10); })();
  const cruxMetrics = (()=>{
    const cp = priorPeriod(cruxStart, end);
    const cM=inRangeBounded(D.metaDaily,cruxStart,end), cG=inRangeBounded(D.googleAds,cruxStart,end), cS=inRangeBounded(D.shopify,cruxStart,end), cA=inRangeBounded(D.ga4,cruxStart,end);
    const pM=inRangeBounded(D.metaDaily,cp.start,cp.end), pG=inRangeBounded(D.googleAds,cp.start,cp.end), pS=inRangeBounded(D.shopify,cp.start,cp.end), pA=inRangeBounded(D.ga4,cp.start,cp.end);
    const r=sum(cS,'netSales'), o=sum(cS,'orders'), ses=sum(cA,'sessions'), pd=sum(cM,'cost')+sum(cG,'cost'), gs=sum(cS,'totalSales'), da=sum(cS,'discounts');
    const pr=sum(pS,'netSales'), po=sum(pS,'orders'), pses=sum(pA,'sessions'), ppd=sum(pM,'cost')+sum(pG,'cost'), pgs=sum(pS,'totalSales'), pda=sum(pS,'discounts');
    const _aov=o>0?r/o:null, _nc=ordersPerCust?o/ordersPerCust:null, _cac=(_nc&&_nc>0)?pd/_nc:null;
    const _pnc=ordersPerCust&&po?po/ordersPerCust:null, _pcac=(_pnc&&_pnc>0)?ppd/_pnc:null;
    const _ltv=(_aov!=null&&ordersPerCust!=null)?_aov*gm*ordersPerCust:null, _contrib=r*gm-pd;
    const _vcr=_aov>0?((_cn('packaging')+_cn('fulfilment')+_cn('shipping')+_cn('payFixed'))/_aov + _cn('payPct')/100 + _cn('refundPct')/100):0;
    const _cmr=Math.max(0.01, gm-_vcr), _beroas=1/_cmr, _foc=_aov!=null?_aov*_cmr:null;
    return {rev:r, orders:o, sessions:ses, paid:pd, cvr:ses>0?o/ses:null, pCvr:pses>0?po/pses:null,
            mer:pd>0?r/pd:null, cac:_cac, pCac:_pcac, ltv:_ltv, ltvCac:(_ltv!=null&&_cac)?_ltv/_cac:null,
            gm, contrib:_contrib, pContrib:pr*gm-ppd, cmPct:r>0?_contrib/r:null, returnRate,
            discLoad:gs>0?da/gs:null, pDiscLoad:pgs>0?pda/pgs:null, pRev:pr,
            aov:_aov, breakEvenRoas:_beroas, allowableCac:_ltv!=null?_ltv/TARGET_LTVCAC:null,
            paybackOrders:(_cac!=null&&_foc>0)?_cac/_foc:null, cmRateBeforeMkt:_cmr, havePrior:pS.length>0};
  })();
  // Evidence layer: trailing-90d series for event detection + decomposition vs prior.
  const histStart = (()=>{ const d=new Date(end); d.setDate(d.getDate()-90); return d.toISOString().slice(0,10); })();
  const histDaily = buildDaily(histStart);
  // Operator event log: ground-truth context, re-read whenever an event is logged.
  const brandEvents = useMemo(()=>loadBrandEvents(), [evTick]);
  const curEvents = brandEvents.filter(e=>eventOverlaps(e, start, end));
  const priEvents = brandEvents.filter(e=>eventOverlaps(e, prior.start, prior.end));
  const dxContext = buildEvidence({mer, pMer, paid, pPaid, rev, pRev, orders, pOrders, discLoad, pDiscLoad, histDaily,
                                   events:{current:curEvents, prior:priEvents, all:brandEvents}});
  return (<div style={{display:'flex', flexDirection:'column', gap:'var(--s-5)'}}>
    {costsOpen && <CostSetupModal catalogueGm={grossMargin} onClose={()=>setCostsOpen(false)}/>}

    {/* Cost-setup prompt deliberately lives BELOW the hero + diagnosis (prove value
        first, then ask for the ~5-min margin input) — see after DiagnosticCard. */}

    {/* Mobile "Today" — 60-second check-in at the very top on narrow screens. */}
    {isMobile && <MobileToday/>}

    {/* Per-channel freshness moved to the app-bar FreshnessChip (was duplicated here). */}

    {/* Hero — the answer to "what should I look at right now" */}
    <ThisWeekHero/>

    {/* Crux verdict: compact scorecard strip + the diagnostic (with the £-bridge nested in its "thinking") */}
    <ScoresStrip metrics={cruxMetrics} windowLabel={`last ${CRUX_DAYS} days`}/>
    <DiagnosticCard metrics={dxMetrics} context={dxContext} period={customActive?null:period} onLogEvent={()=>setEvTick(t=>t+1)}/>

    {/* WHAT CHANGED — the weekly diff, so the founder sees the movers before the deep-dive. */}
    <WhatChangedStrip/>

    {/* Prove-value-first onboarding nudge: the read above already works on
        catalogue-estimate margins — now offer the one ~5-min input that makes the
        margin figures exact. Placed AFTER the value, framed as "make it exact". */}
    {!costsVerified && (
      <div className="card" style={{borderLeft:'3px solid var(--accent)', display:'flex', alignItems:'center', gap:16, flexWrap:'wrap'}}>
        <div style={{flex:'1 1 420px'}}>
          <div style={{fontWeight:650, fontSize:14, marginBottom:3}}>Make the margin numbers exact <span style={{fontWeight:400, color:'var(--text-faint)', fontSize:12}}>· optional, ~5 min</span></div>
          <div className="micro" style={{color:'var(--text-secondary)', lineHeight:1.5}}>The read above already works on catalogue-estimate margins. Enter your real COGS + fulfilment once and contribution, CAC payback and LTV:CAC become exact — and carry a <b>✓ verified</b> badge for the raise.</div>
        </div>
        <button onClick={()=>setCostsOpen(true)} className="btn-primary" style={{flexShrink:0}}>Set up costs →</button>
      </div>
    )}
    {costsVerified && (
      <div className="micro" style={{color:'var(--text-faint)', display:'flex', alignItems:'center', gap:8}}>
        <MarginBadge/> margin figures are based on your entered costs · <span onClick={()=>setCostsOpen(true)} style={{color:'var(--accent)', cursor:'pointer'}}>edit costs</span>
      </div>
    )}

    {/* DO THIS NEXT — the action queue sits directly under the diagnosis (what's
        happening + why → what to do), not buried beneath the analysis charts. */}
    <div className="section-eyebrow" style={{display:'flex',alignItems:'center',gap:8,margin:'4px 0 -4px',fontSize:11,fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',color:'var(--accent)'}}>
      <span style={{width:3,height:14,background:'var(--accent)',borderRadius:2}}/>Do this next
    </div>
    <ActionBoard/>

    {/* COMMERCIAL HEALTH */}
    <div className="section-eyebrow" style={{display:'flex',alignItems:'center',gap:8,margin:'8px 0 -4px',fontSize:11,fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',color:'var(--text-muted)'}}>
      <span style={{width:3,height:14,background:'var(--text-faint)',borderRadius:2}}/>Commercial health
    </div>

    {/* KPI strip — collapsed by default, hover for full agent commentary */}
    <div>
      <div className="card-section-title" style={{marginBottom:'var(--s-3)'}}>
        <h2 style={{margin:0}}>Headline KPIs</h2>
        <span className="meta">Last {daily.length} days · vs prior period · hover any card for the full read</span>
      </div>
      <div className="row">
        <KPI label="Paid ad spend" val={GBP(paid)} sub={`Meta ${GBP(sum(meta,'cost'))} · Google ${GBP(sum(gads,'cost'))}`} series={seriesPaid} current={paid} prior={pPaid}
          agent="Pulse" observation={OI_BRAND.slug==='frkl' ? "Up ~46% on prior period as Meta scaled from ~£100 to ~£170/day from 13 April." : undefined}
          implication={OI_BRAND.slug==='frkl' ? "Don't push further until Ireland frequency drops below 8× and the cart-checkout JS error is fixed." : undefined} />
        <KPI label="Shopify net revenue" val={GBP(rev)} sub={`${NUM(orders)} orders · AOV ${GBP(orders?rev/orders:null)}`} series={seriesRev} current={rev} prior={pRev} goodDirection="up"
          agent="Atlas" observation={`Draft/exchange orders are excluded. ~${discLoad!=null?Math.round(discLoad*100):10}% of DTC gross sales went out as code/automatic discounts, with sale-price markdowns on top — see Promotions for the full load.`}
          implication="Confirm a real COGS% so this becomes a defensible contribution number for the raise." />
        <KPI label="Blended MER" val={mer?mer.toFixed(2)+'x':'—'} sub="net revenue ÷ paid spend" series={seriesMER} current={mer} prior={pMer} goodDirection="up"
          agent="Atlas" observation="Down ~14%: revenue grew slower than spend (27% vs 46%), so each pound of ad earns less."
          implication="Classic diminishing returns from scaling into a fatigued audience — pause scaling, fix creative + site first."
          benchmark="blended_mer" bmValue={mer} />
        <KPI label="Sessions (GA4)" val={NUM(sessions)} sub={`Site CVR ${PCT(sessions?orders/sessions:null)} (orders ÷ sessions)`} series={seriesSessions} current={sessions} prior={pSessions} goodDirection="up"
          agent="Pulse" observation={`Sessions grew far slower than spend. Site CVR (Shopify orders ÷ GA4 sessions) is ${sessions?PCT(orders/sessions):'—'} vs the ${CVR_BENCH_LABEL} target.`}
          implication="Spend is buying impressions, not visits. Site fixes (cart JS, sticky checkout) unlock more revenue than more spend." />
        <KPI label="Klaviyo-tracked orders" val={GBP(emailRev)} sub="gross order value — not email-attributed" series={seriesEmail} current={emailRev} prior={pEmailRev} goodDirection="up"
          agent="Lux" observation="Up ~32% — email is keeping pace with the paid scale-up."
          implication="Highest-leverage moment to switch on attributed reporting + a real abandoned-cart sequence." />
        <KPI label="Conversion rate (CVR)" val={PCT(cvr)} sub={`${NUM(orders)} orders ÷ ${NUM(sessions)} sessions`} series={seriesCVR} current={cvr} prior={pCvr} goodDirection="up"
          status={cvr==null?undefined:cvr>=CVR_BENCH?'healthy':cvr>=CVR_BENCH*0.8?'watch':'action'} statusLabel={cvr==null?undefined:cvr>=CVR_BENCH?'Healthy':cvr>=CVR_BENCH*0.8?'Watch':'Below target'}
          agent="Pulse" observation={`Site CVR (Shopify orders ÷ GA4 sessions) is the single biggest revenue lever — against the ${CVR_BENCH_LABEL} target, more spend just buys more bounces.`}
          implication="Fix the cart→checkout JS error and sticky-checkout before scaling spend further."
          benchmark="site_cvr" bmValue={cvr} />
        <KPI label="Discount depth" val={PCT(discLoad)} sub="£ off ÷ £ of sales — how deep, not how many orders · drafts excluded" series={seriesDisc} current={discLoad} prior={pDiscLoad} goodDirection="down"
          agent="Atlas" observation={`Code + automatic discount as a share of DTC gross sales (draft/exchange orders excluded). This excludes sale-price markdowns${_mdPct?`, which add ~${_mdPct}% of value on top`:''} — the full load is on the Promotions tab.`}
          implication="Audit always-on codes + affiliate rates; protect full-price demand. The true load incl. markdowns is materially higher — see Promotions."
          benchmark="discount_load" bmValue={discLoad} />
        <KPI label="Contribution margin" val={cmPct!=null?PCT(cmPct):'—'} sub="net rev × margin − ad spend, net of returns · ≥10% healthy" badge={<MarginBadge onSetup={()=>setCostsOpen(true)}/>} series={seriesContrib} seriesLabel="Contribution £ · by day" current={contrib} prior={pContrib} goodDirection="up"
          status={cmPct==null?undefined:cmPct>=0.10?'healthy':cmPct>=0.05?'watch':'margin'} statusLabel={cmPct==null?undefined:cmPct>=0.10?'Healthy':cmPct>=0.05?'Watch':'Margin risk'}
          agent="Atlas" observation="Whether the growth is actually profitable — net revenue × product margin minus paid media, as a share of revenue. Returns are already netted out of revenue. The single best read on profitable vs vanity growth."
          implication="Below 10% means scaling just amplifies a thin engine — fix discount load, returns and CAC before adding spend."
          benchmark="contribution_margin" bmValue={cmPct} />
        <KPI label="CAC payback" val={paybackOrders!=null?(paybackOrders<=1?'1st order':paybackOrders.toFixed(1)+' orders'):'—'} sub={cac!=null?`paid CAC £${Math.round(cac)} ÷ first-order contribution · target ≤2`:'needs paid CAC'} goodDirection="down"
          status={paybackOrders==null?undefined:paybackOrders<=2?'healthy':paybackOrders<=3?'watch':'action'} statusLabel={paybackOrders==null?undefined:paybackOrders<=2?'Healthy':paybackOrders<=3?'Watch':'Slow payback'}
          agent="Atlas" observation="How many orders it takes to recover the paid cost of acquiring a customer, at your margin. Under ~2 orders = a healthy cash cycle that funds reinvestment."
          implication="This is the lever on cash flow — faster payback frees working capital. Watch it as you scale spend; if it stretches past 2, growth starts eating cash." />
        <MoreKpis count={8}>
        <KPI label="Gross margin" val={PCT(gm)} sub={costsVerified?"Your entered gross margin":"COGS-based · catalogue estimate"} badge={<MarginBadge onSetup={()=>setCostsOpen(true)}/>} series={seriesGM} seriesLabel="Catalogue margin · structurally stable"
          agent="Atlas" observation="Blended product margin across the live catalogue, after cost of goods."
          implication="This is the contribution base for the raise — defend it by keeping discount load in check."
          benchmark="gross_margin" bmValue={gm} />
        <KPI label="Return rate" val={PCT(returnRate)} sub={`${NUM(_rets)} of ${NUM(_units)} units · 90d`} series={seriesReturn} seriesLabel="Refunds ÷ sales · by day" goodDirection="down"
          agent="Lux" observation="Share of shipped units returned — watch by SKU for sizing/quality hotspots. (Card is unit-based over 90d; trend is refund-£ share of sales by day.)"
          implication="A point of return rate is pure margin; flag any SKU materially above this blended rate."
          benchmark="return_rate" bmValue={returnRate} />
        <KPI label="Orders with a discount" val={_dc.fullPriceShare!=null?PCT(1-_dc.fullPriceShare):'—'} sub="share of orders using a code/auto discount — how often, not how deep · drafts excluded" goodDirection="down"
          agent="Atlas" observation={_dc.fullPriceShare!=null?`${Math.round((1-_dc.fullPriceShare)*100)}% of orders carry a discount; ${Math.round(_dc.fullPriceShare*100)}% pay full price. Read it with Discount depth: lots of orders but a shallow ~${discLoad!=null?Math.round(discLoad*100):9}% of revenue = many small codes, not deep cuts.`:'How often a discount is used across orders (draft/exchange orders excluded).'}
          implication="If penetration and depth climb together you're training customers to wait for a code — tighten the always-on codes first." series={seriesPenetration} seriesLabel="Orders with a code · by week" />
        <KPI label="Discount value" val={GBP(discAmt)} sub="total £ given as code/auto discount this period — drafts excluded" series={seriesDiscVal} seriesLabel="Discount £ given · by day" goodDirection="down"
          agent="Atlas" observation="The actual money handed back as discounts this period (code + automatic). Excludes sale-price markdowns, which are shown separately on Promotions."
          implication="Recoverable margin to the extent any of it went to buyers who'd have paid full price — start with the biggest always-on codes." />
        <KPI label="Returning customers" val={PCT(returningPct)} sub="share of orders · trailing months" series={seriesReturning} seriesLabel="Repeat-order share · by month" goodDirection="up"
          agent="Lux" observation="Repeat-purchase share — the cheapest revenue you have and a read on brand love."
          implication="Lift with post-purchase flows + a reason to come back; it compounds faster than paid." />
        <KPI label="Contribution (pre-opex)" val={GBP(contrib)} sub="gross profit − paid media · full breakdown below" badge={<MarginBadge onSetup={()=>setCostsOpen(true)}/>} series={seriesContrib} current={contrib} prior={pContrib} goodDirection="up"
          agent="Atlas" observation="Net revenue × blended product margin, minus paid ad spend — before packaging/fulfilment/fees. The fully-loaded figure is in the Contribution margin card."
          implication="This is what the raise hinges on; hold it by balancing discount load (margin) against MER (CAC)." />
        <KPI label="CAC (est.)" val={GBP(cac)} sub={`${NUM(newCust)} new customers · paid spend ÷ new`} badge={<MarginBadge onSetup={()=>setCostsOpen(true)}/>} series={seriesCAC} seriesLabel="Spend ÷ new customers · by day" current={cac} prior={pCac} goodDirection="down"
          agent="Pulse" observation="Paid ad spend ÷ estimated new customers (new-customer share derived from repeat-purchase data)."
          implication="Judge against contribution-LTV — keep scaling only while LTV:CAC stays at 3×+." />
        <KPI label="LTV (est.)" val={GBP(ltv)} sub={`contribution · ${ordersPerCust?ordersPerCust.toFixed(1):'—'} orders/customer · LTV:CAC ${ltvCac?ltvCac.toFixed(1)+'×':'—'}`} badge={<MarginBadge onSetup={()=>setCostsOpen(true)}/>} series={seriesLTV} seriesLabel="Contribution/customer · by day" goodDirection="up"
          agent="Atlas" observation="Estimated contribution per acquired customer: AOV × gross margin × repeat orders per customer."
          implication="The LTV:CAC ratio is the unit-economics headline for the raise — 3×+ is the target to defend."
          benchmark="ltv_cac" bmValue={ltvCac} />
        </MoreKpis>
      </div>
    </div>

    {/* Below-the-fold operational charts — lazy-mounted so cold first-paint isn't
        blocked by mounting every Recharts at once (and never at 0-width). */}
    {/* Contribution margin — editable, fully-loaded operator P&L for the period */}
    <LazyMount minHeight={360}><ContributionCard rev={rev} orders={orders} paid={paid} gm={gm}/></LazyMount>

    {/* Margin bridge — why contribution moved vs prior period (volume/price/discount/returns/paid) */}
    <LazyMount minHeight={360}><MarginBridge cur={bridgeCur} pri={bridgePri} gm={gm}
      perOrderFixed={_cn('packaging')+_cn('fulfilment')+_cn('shipping')+_cn('payFixed')} payPct={_cn('payPct')/100}/></LazyMount>

    {/* Channel stream chart */}
    <LazyMount minHeight={340}><ChannelStreamPanel/></LazyMount>

    {/* Today's view — the pacing + anomaly tile */}
    <LazyMount minHeight={300}><DailyPanel/></LazyMount>

    {/* The big paid-vs-revenue chart */}
    <LazyMount minHeight={360}><div className="card">
      <div className="card-section-title">
        <h2 style={{margin:0}}>Paid spend vs Shopify revenue — daily</h2>
        <span className="meta">Bars = paid spend (left axis) · Line = net revenue (right axis)</span>
      </div>
      <R.ResponsiveContainer width="100%" height={334}>
        <R.ComposedChart data={daily} margin={{top:6,right:20,left:14,bottom:22}}>
          <R.CartesianGrid stroke="#1f1f27" vertical={false} />
          <R.XAxis dataKey="dlabel" tick={{fill:'#7e7e8a',fontSize:11}} interval={Math.ceil(daily.length/12)}
                   label={{value:'Date', position:'insideBottom', offset:-10, fill:'#6f6f7b', fontSize:11}} />
          <R.YAxis yAxisId="l" tick={{fill:'#7e7e8a',fontSize:11}} tickFormatter={v=>'£'+(v/1000).toFixed(0)+'k'}
                   label={{value:'Paid spend (£)', angle:-90, position:'insideLeft', style:{textAnchor:'middle'}, fill:'#6f6f7b', fontSize:11}} />
          <R.YAxis yAxisId="r" orientation="right" tick={{fill:'#7e7e8a',fontSize:11}} tickFormatter={v=>'£'+(v/1000).toFixed(1)+'k'}
                   label={{value:'Net revenue (£)', angle:90, position:'insideRight', style:{textAnchor:'middle'}, fill:'#6f6f7b', fontSize:11}} />
          <R.Tooltip contentStyle={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:10,boxShadow:'var(--shadow-md)'}}
                     formatter={(v,n)=>[GBP(v),n]}
                     labelFormatter={(l,p)=> (p&&p[0]&&p[0].payload&&p[0].payload.date) ? p[0].payload.date : l} />
          <R.Legend verticalAlign="top" align="center" wrapperStyle={{fontSize:12, paddingBottom:8}} />
          <R.Bar yAxisId="l" dataKey="metaSpend" stackId="s" name="Meta spend" fill={COL.meta} />
          <R.Bar yAxisId="l" dataKey="googleSpend" stackId="s" name="Google spend" fill={COL.google} />
          <R.Line yAxisId="r" type="monotone" dataKey="revenue" name="Shopify net rev" stroke={COL.revenue} strokeWidth={2.4} dot={false} />
          <R.Brush {...brushProps('dlabel')} />
          {/* Event & sale pins: same hoverable markers as the CVR trend so spikes have a named cause. */}
          {(function(){ var pins=buildChartPins(daily.map(function(d){return {x:d.dlabel, date:d.date};}));
            return pins.map(function(p,i){ return (
              <R.ReferenceLine key={'pin'+i} yAxisId="l" x={p.x} stroke="#8b8b99" strokeDasharray="3 3" strokeOpacity={0.55}
                label={<PinMarker icon={p.icon} n={p.n} tip={p.tip}/>}/>); });
          })()}
        </R.ComposedChart>
      </R.ResponsiveContainer>
      <div style={{fontSize:10.5,color:'var(--text-faint)',textAlign:'right',marginTop:2}}>{BRUSH_HINT}</div>
      {(function(){ var pins=buildChartPins(daily.map(function(d){return {x:d.dlabel, date:d.date};})); if(!pins.length) return null; return (
        <div className="micro" style={{color:'var(--text-faint)',marginTop:4}}>🏷️ sales &amp; promos · 📌 your events — <span style={{color:'var(--text-muted)'}}>hover any marker for what it was</span></div>); })()}
      <ChartFooter note="Does paid spend track with revenue? Watch for spend rising while revenue flattens — that's efficiency slipping."
        ask="Looking at daily paid spend vs Shopify revenue, is my paid media still efficient, and what changed?"
        rows={daily} columns={[
          {key:'dlabel', label:'Date'},
          {key:'metaSpend', label:'Meta spend', right:true, fmt:v=>GBP(v)},
          {key:'googleSpend', label:'Google spend', right:true, fmt:v=>GBP(v)},
          {key:'revenue', label:'Net revenue', right:true, fmt:v=>GBP(v)},
        ]}/>
    </div></LazyMount>

    {/* PLANNING & DEEP-DIVE — forecast + unit-economics-over-time are board/planning
        artifacts, not "what's happening this week", so they live behind a toggle. */}
    <div className="section-eyebrow" style={{display:'flex',alignItems:'center',gap:8,margin:'8px 0 -4px',fontSize:11,fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',color:'var(--text-muted)'}}>
      <span style={{width:3,height:14,background:'var(--text-faint)',borderRadius:2}}/>Planning &amp; deep-dive
    </div>
    <button onClick={()=>setShowPlanning(s=>!s)} className="show-more">
      {showPlanning ? '↑ Hide planning & forecast' : '↓ Planning & forecast — LTV:CAC trend + Year-1 P&L'}
    </button>
    {showPlanning && (<div style={{display:'flex', flexDirection:'column', gap:'var(--s-5)', marginTop:'var(--s-4)'}}>
      <LtvCacCard daily={daily} gm={gm} ordersPerCust={ordersPerCust}/>
      <ForecastCard rev={rev} orders={orders} paid={paid} gm={gm} aov={orders?rev/orders:83} cac={cac} returningPct={returningPct}/>
    </div>)}
  </div>);
}

// ── Fit engine (OMF + PMF) — renders window.FRKL_FIT in Channels › Cross-channel ──────────────
function fitBand(b){ return b===2?'green':b===1?'amber':b===0?'red':'grey'; }
function fitBandColor(b){ return b===2?'#34d399':b===1?'#fbbf24':b===0?'#f87171':'var(--text-faint)'; }
function fitScoreColor(s){ return s==null?'var(--text-faint)':s>=70?'#34d399':s>=40?'#fbbf24':'#f87171'; }
function fitConfColor(c){ return c==='high'?'#34d399':c==='medium'?'#fbbf24':'#f87171'; }
function FitScore({label,value,sub}){
  return (<div style={{flex:1,textAlign:'center',padding:'14px 8px',borderRadius:'var(--r-sm)',background:'var(--bg-app)',border:'1px solid var(--border-subtle)'}}>
    <div style={{fontSize:34,fontWeight:800,lineHeight:1,color:fitScoreColor(value)}}>{value==null?'—':value}</div>
    <div className="micro" style={{color:'var(--text-muted)',marginTop:6,fontWeight:600}}>{label}</div>
    <div className="micro" style={{color:'var(--text-faint)'}}>{sub}</div>
  </div>);
}
function FitGauge({label,band,value}){
  return (<div className="mrow" style={{alignItems:'center'}}>
    <span className="k" style={{display:'flex',alignItems:'center',gap:8}}><span style={{width:9,height:9,borderRadius:'50%',background:fitBandColor(band),display:'inline-block'}}/>{label}</span>
    <span className="v" style={{color:fitBandColor(band)}}>{value}</span>
  </div>);
}
// Live per-tenant fit. The /app shell injects window.OI_ASK = {endpoint, brand_id, getJwt}
// (the same context the Ask panel uses). When present we fetch assess-fit for the SELECTED
// window, scoped to this brand by the caller's JWT (RLS). With no shell (public demo) we fall
// back to the static window.FRKL_FIT snapshot. An authenticated tenant NEVER falls back to the
// static snapshot (which is frkl's), so there is no cross-tenant bleed.
function getOIAsk(){
  try{
    if(typeof window==='undefined') return null;
    if(window.OI_ASK) return window.OI_ASK;
    if(window.parent && window.parent!==window) return window.parent.OI_ASK || null;
  }catch(e){}
  return null;
}
function useFitResult(start, end){
  const ASK = getOIAsk();
  const authed = !!(ASK && ASK.brand_id && typeof ASK.getJwt==='function' && ASK.endpoint);
  const cached = ()=> (typeof window!=='undefined' && window.FRKL_FIT) || null;   // static frkl-fit.js fallback
  const [state, setState] = React.useState(()=>({
    fit: authed ? null : cached(),
    loading: authed, error: '', source: authed ? 'live' : 'cached',
  }));
  React.useEffect(()=>{
    if(!authed){ setState({ fit:cached(), loading:false, error:'', source:'cached' }); return; }
    if(!start || !end){ return; }
    let cancelled=false;
    setState(s=>({ ...s, loading:true, error:'' }));
    (async ()=>{
      try{
        const jwt = await ASK.getJwt();
        if(!jwt) throw new Error('no session');
        const base = String(ASK.endpoint).replace(/\/[^/]*$/, '');   // …/functions/v1
        const resp = await fetch(base+'/assess-fit', {
          method:'POST',
          headers:{ 'content-type':'application/json', 'authorization':'Bearer '+jwt },
          body: JSON.stringify({ brandId: ASK.brand_id, start, end }),
        });
        const data = await resp.json().catch(()=>null);
        if(cancelled) return;
        if(!resp.ok || !data || data.error){
          // Live fetch failed → fall back to the cached static snapshot, flagged 'cached'.
          setState({ fit:cached(), loading:false, error:(data&&data.error) || ('assess-fit '+resp.status), source:'cached' });
          return;
        }
        // Publish the live result so the sibling FitGenomePanel reads it, and nudge a
        // re-render via the loader's existing event (deps are stable → no refetch loop).
        if(typeof window!=='undefined'){ window.FRKL_FIT = data; window.FRKL_FIT_SOURCE = 'live'; try{ window.dispatchEvent(new CustomEvent('frkl-data-updated')); }catch(_){} }
        setState({ fit:data, loading:false, error:'', source:'live' });
      }catch(e){ if(!cancelled) setState({ fit:cached(), loading:false, error:e.message||String(e), source:'cached' }); }
    })();
    return ()=>{ cancelled=true; };
  }, [authed, start, end]);
  return state;
}
function FitCard({start, end}){
  const { fit:FIT, loading, error, source } = useFitResult(start, end);
  if(loading && (!FIT||!FIT.blended)){ return (<div className="card" style={{marginBottom:14}}><h2>Offer &amp; Product Market Fit</h2><div className="note">Assessing fit for the selected window…</div></div>); }
  if(!FIT||!FIT.blended){ return (<div className="card" style={{marginBottom:14}}><h2>Offer &amp; Product Market Fit</h2><div className="note">{error ? ('Fit not available — '+error) : 'No fit assessment yet — connect Meta, Shopify and GA4, then the engine reads offer-market fit (the paid funnel) and product-market fit (cohorts) and tells you whether to scale.'}</div></div>); }
  const b=FIT.blended;
  // Paid-only offer fit (engine: parameters.paidOmf). OMF is a paid-acquisition read, but the blended
  // headline sums in zero-spend organic/direct customers, flattering it. Show the honest paid number as
  // the headline when the engine reports it and some channels were excluded for no spend; absent
  // (pre-deploy / cached snapshot) ⇒ falls back to the blended OMF unchanged.
  const pomf=(FIT.parameters&&FIT.parameters.paidOmf)||null;
  const diluted=!!(pomf&&pomf.excludedChannels&&pomf.excludedChannels.length>0&&pomf.omfScore!=null);
  const omfHeadline=diluted?pomf.omfScore:b.omfScore;
  const pc=(x,dp=1)=>x==null?'—':(x*100).toFixed(dp)+'%';
  const rx=(x,dp=2)=>x==null?'—':x.toFixed(dp)+'x';
  return (<div className="card" style={{marginBottom:14}}>
    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',flexWrap:'wrap',gap:8}}>
      <h2 style={{margin:0}}>Offer &amp; Product Market Fit</h2>
      <div style={{display:'flex',gap:6,alignItems:'center'}}>
        {source==='live'
          ? <span className="pill" style={{background:'rgba(52,211,153,.13)',color:'#34d399'}} title={'Live engine output'+(FIT.window?` · window ${FIT.window.start} → ${FIT.window.end}`:'')}>live</span>
          : <span className="pill" style={{background:'rgba(148,148,160,.14)',color:'var(--text-faint)'}} title={(error?('Live fetch failed ('+error+') — showing cached snapshot. '):'')+'Log in to load your live engine output'}>cached</span>}
        <span className="pill" style={{background:fitConfColor(FIT.confidence)+'22',color:fitConfColor(FIT.confidence)}}>{FIT.confidence} confidence</span>
      </div>
    </div>
    <div style={{display:'flex',gap:10,margin:'12px 0'}}>
      <FitScore label="Offer-market fit" value={omfHeadline} sub={diluted?'paid channels only':'CTR · landing CVR · CAC coverage'}/>
      <FitScore label="Product-market fit" value={b.pmfScore} sub="LTV:CAC · payback · retention"/>
    </div>
    {diluted&&(<div className="note" style={{marginBottom:12,borderLeft:'3px solid #f5b544'}}><b>Paid-only offer fit.</b> Blended (incl. organic/direct) reads <b>{pomf.blendedOmfScore}</b> at {rx(pomf.blendedCacCoverageRatio)} CAC coverage — flattered by {pomf.excludedChannels.join(', ')} with no ad spend. On the paid channels you control, CAC coverage is {rx(pomf.cacCoverageRatio)}.</div>)}
    <div style={{padding:'12px 14px',borderRadius:'var(--r-sm)',background:'var(--accent-bg)',border:'1px solid rgba(124,140,255,.25)',marginBottom:12}}>
      <div style={{fontWeight:700,color:'var(--text-primary)',marginBottom:4}}>{FIT.primaryDiagnosis}</div>
      <div style={{fontSize:'12.5px',lineHeight:1.5,color:'var(--text-secondary)'}}>{FIT.recommendedAction}</div>
    </div>
    {(()=>{
      // Prioritized actionable insights (engine: parameters.insights). The verdict + confidence items are
      // already shown (diagnosis box / confidence pill), so render the rest — paid dilution, cash, scaling.
      const ins=((FIT.parameters&&FIT.parameters.insights)||[]).filter(i=>i.key!=='verdict'&&i.key!=='confidence');
      if(!ins.length) return null;
      const sc={critical:'#f87171',warning:'#fbbf24',good:'#34d399',info:'var(--text-faint)'};
      const sl={critical:'Act now',warning:'Watch',good:'Good',info:'Note'};
      return (<div style={{marginBottom:12}}>
        <div className="micro" style={{color:'var(--text-muted)',marginBottom:6,fontWeight:600}}>WHAT TO ACT ON</div>
        {ins.map((i,idx)=>(<div key={i.key||idx} style={{borderLeft:'3px solid '+(sc[i.severity]||'var(--text-faint)'),background:'var(--bg-app)',borderRadius:'var(--r-sm)',padding:'10px 12px',marginBottom:6}}>
          <div style={{display:'flex',alignItems:'baseline',gap:8,flexWrap:'wrap'}}>
            <span className="pill" style={{background:(sc[i.severity]||'#888')+'22',color:sc[i.severity]||'var(--text-faint)',fontSize:10}}>{sl[i.severity]||i.severity}</span>
            <span style={{fontWeight:700,color:'var(--text-primary)'}}>{i.title}</span>
          </div>
          {i.detail&&<div style={{fontSize:'12px',color:'var(--text-secondary)',marginTop:4,lineHeight:1.5}}>{i.detail}</div>}
          <div style={{fontSize:'12px',color:'var(--text-primary)',marginTop:5,lineHeight:1.5}}><span style={{color:'var(--accent)'}}>→ </span>{i.action}</div>
        </div>))}
      </div>);
    })()}
    <div className="row">
      <div style={{flex:'1 1 240px'}}>
        <div className="micro" style={{color:'var(--text-muted)',marginBottom:6,fontWeight:600}}>OFFER (the paid funnel)</div>
        <FitGauge label="CTR" band={b.bands.ctr} value={pc(b.ctr,2)}/>
        <FitGauge label="Landing CVR" band={b.bands.landingCvr} value={pc(b.landingCvr)}/>
        <FitGauge label="Checkout CVR" band={b.bands.checkoutCvr} value={pc(b.checkoutCvr)}/>
        <FitGauge label="CAC coverage" band={b.bands.cacCoverage} value={rx(b.cacCoverageRatio)}/>
      </div>
      <div style={{flex:'1 1 240px'}}>
        <div className="micro" style={{color:'var(--text-muted)',marginBottom:6,fontWeight:600}}>PRODUCT (repeat &amp; demand)</div>
        <FitGauge label="LTV : CAC" band={b.bands.ltvCac} value={rx(b.ltvCacRatio)}/>
        <FitGauge label="Payback (months)" band={b.bands.payback} value={b.paybackMonths==null?'—':b.paybackMonths.toFixed(1)}/>
        <FitGauge label="Retention shape" band={b.bands.retentionShape} value={fitBand(b.bands.retentionShape)}/>
        <FitGauge label="CAC elasticity" band={b.bands.cacElasticity} value={b.cacElasticity==null?'—':b.cacElasticity.toFixed(2)}/>
      </div>
    </div>
    {FIT.channels&&FIT.channels.length>1&&(<table style={{marginTop:14}}>
      <thead><tr><th>Channel</th><th>OMF</th><th>PMF</th><th>CAC coverage</th><th>LTV:CAC</th></tr></thead>
      <tbody>{FIT.channels.map(c=>(<tr key={c.channel}>
        <td><span className="pill" style={{background:(COL[c.channel]||'var(--accent)')+'22',color:COL[c.channel]||'var(--accent)'}}>{c.channel}</span></td>
        <td style={{color:fitScoreColor(c.omfScore)}}>{c.omfScore??'—'}</td>
        <td style={{color:fitScoreColor(c.pmfScore)}}>{c.pmfScore??'—'}</td>
        <td>{rx(c.cacCoverageRatio)}</td><td>{rx(c.ltvCacRatio)}</td>
      </tr>))}</tbody>
    </table>)}
    {FIT.confidenceReasons&&FIT.confidenceReasons.length>0&&(<div className="note" style={{marginTop:12}}><b>Read with care:</b> {FIT.confidenceReasons.join(' · ')}</div>)}
    <div className="micro" style={{color:'var(--text-faint)',marginTop:8}}>Blended/MER treated as truth; platform ROAS is directional. Window {FIT.window.start} → {FIT.window.end}.</div>
  </div>);
}

// ── Genome (cash, profitability & discounted LTV) + shadow SIGNAL layer ───────────────────────
//    Ported verbatim from the backend repo's fit-engine/dashboard/GenomePanel.jsx (commit ba8242f)
//    — the richer rendering that SUPERSEDES the old gated FitGenomePanel. Reads window.FRKL_FIT
//    .parameters (cashConversion / profitability / discountedLtv / signal), all of which the LIVE
//    assess-fit engine already returns. Self-hides when the parameter vector is absent (public
//    cached snapshot / pre-genome engine), so no flag gate is needed. Source-honest: each genome
//    input is tagged 'your number' (brand-entered) or 'prior' (category default); the whole panel
//    is badged 'shadow · not scored' — reported, never folded into the OMF/PMF verdict.
function gpGBP0(x) { return x == null ? '-' : '£' + Math.round(x).toLocaleString('en-GB'); }
function gpGBP2(x) { return x == null ? '-' : '£' + x.toFixed(2); }
function gpPCT(x, dp = 1) { return x == null ? '-' : (x * 100).toFixed(dp) + '%'; }
function gpRX(x, dp = 2) { return x == null ? '-' : x.toFixed(dp) + 'x'; }
function gpDays(x) { return x == null ? '-' : Math.round(x) + 'd'; }

/* 'your number' (brand-entered) vs 'prior' (category default) - the source-honesty tag.
 * When `label` is passed it overrides the brand/prior dichotomy with free-text basis honesty
 * (e.g. 'vintage-weighted · extrapolated · low confidence'), always rendered in the muted /
 * non-confident style so the value never reads as a precise, brand-confirmed figure. */
function GpSrc({ source, label }) {
  if (label) {
    return (
      <span className="pill" style={{
        fontSize: 10, padding: '1px 6px', marginLeft: 6, verticalAlign: 'middle',
        background: 'transparent', color: 'var(--text-faint)',
        border: '1px solid var(--border-subtle)',
      }}>{label}</span>
    );
  }
  const brand = source === 'brand-entered';
  return (
    <span className="pill" style={{
      fontSize: 10, padding: '1px 6px', marginLeft: 6, verticalAlign: 'middle',
      background: brand ? 'var(--accent-bg)' : 'transparent',
      color: brand ? 'var(--accent)' : 'var(--text-faint)',
      border: '1px solid ' + (brand ? 'rgba(124,140,255,.35)' : 'var(--border-subtle)'),
    }}>{brand ? 'your number' : 'prior'}</span>
  );
}

function GpStat({ label, value, sub, accent, src }) {
  return (
    <div style={{ flex: 1, minWidth: 124, padding: '12px 12px', borderRadius: 'var(--r-sm)', background: 'var(--bg-app)', border: '1px solid var(--border-subtle)' }}>
      <div className="micro" style={{ color: 'var(--text-muted)', fontWeight: 600, marginBottom: 7 }}>{label}{src}</div>
      <div className="v" style={{ fontSize: 23, lineHeight: 1, color: accent || 'var(--text-primary)' }}>{value}</div>
      {sub && <div className="micro" style={{ color: 'var(--text-faint)', marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

/* Tiny inline sparkline for a monthly trajectory. Normalises across its own min/max. */
function GpSpark({ series, color }) {
  const pts = (series || []).filter((n) => typeof n === 'number' && isFinite(n));
  if (pts.length < 2) return null;
  const w = 132, h = 30, pad = 3;
  const lo = Math.min(...pts), hi = Math.max(...pts), span = hi - lo || 1;
  const x = (i) => pad + (i * (w - 2 * pad)) / (pts.length - 1);
  const y = (v) => pad + (h - 2 * pad) * (1 - (v - lo) / span);
  const d = pts.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
  return (
    <svg width={w} height={h} style={{ display: 'block' }} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth="1.6" />
      <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1])} r="2.4" fill={color} />
    </svg>
  );
}

function GenomePanel() {
  const FIT = (typeof window !== 'undefined' && window.FRKL_FIT) || null;
  const p = FIT && FIT.parameters;
  if (!p || !p.cashConversion) return null; // pre-genome engine / no profile - render nothing

  const cc = p.cashConversion, dl = p.discountedLtv, pr = p.profitability;
  const sig = p.signal || {}, me = sig.marginalEconomics || {}, tj = sig.trajectories || {};

  // Source-honesty tag for the Discounted-LTV £: it's a curve-fitted estimate, not a brand-entered
  // figure. Reflect what the engine actually emitted for the value — the discountedLtv.basis (the
  // engine's single-enum primary qualifier) plus extrapolation (which composes with vintage-weighting
  // in confidenceReasons, not the enum) plus the result-level confidence — so the £ reads as the
  // estimate it is. Never asserts a confident label.
  const BASIS_PHRASE = { 'curve-vintage-weighted': 'vintage-weighted', 'curve-extrapolated': 'extrapolated', 'curve-timed': 'curve-timed', 'cadence-timed': 'cadence-timed', 'single-order': 'single-order' };
  const ltvBasisLabel = (() => {
    if (!dl || dl.discountedLtv == null || dl.basis === 'none') return null;
    const quals = [];
    if (BASIS_PHRASE[dl.basis]) quals.push(BASIS_PHRASE[dl.basis]);
    const reasons = (FIT && FIT.confidenceReasons) || [];
    const extrapolated = Array.isArray(reasons) && reasons.some((r) => /extrapolat/i.test(r));
    if (extrapolated && !quals.includes('extrapolated')) quals.push('extrapolated');
    if (FIT && FIT.confidence) quals.push(FIT.confidence + ' confidence');
    return quals.length ? quals.join(' · ') : null;
  })();
  const accent = 'var(--accent)';
  const good = '#34d399', warn = '#fbbf24', bad = '#f87171';

  // The headline insight: a profitable P&L can still be cash-negative once ad spend + the cash cycle
  // are counted. Surface it when EBITDA is positive but operating cash isn't.
  const cashTrap = (pr.operatingProfitWindow ?? 0) > 0 && (tj.monthlyNetOperatingCash ?? 0) < 0;

  return (
    <div className="card" style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: 8 }}>
        <h2 style={{ margin: 0 }}>Cash, profitability &amp; forward signal</h2>
        <span className="pill" style={{ background: 'var(--bg-app)', color: 'var(--text-faint)', border: '1px solid var(--border-subtle)' }}>shadow · not scored</span>
      </div>
      <div className="micro" style={{ color: 'var(--text-faint)', margin: '4px 0 12px' }}>
        Computed from the fitted curves &amp; your economics - what the OMF/PMF score can't see: when cash moves, and whether the business (not the order) makes money.
      </div>

      {/* The four genome magnitudes. */}
      <div className="row" style={{ gap: 10 }}>
        <GpStat label="Cash conversion cycle" value={gpDays(cc.cccDays)} sub="cash gap, order to bank" />
        <GpStat label="Working capital tied" value={gpGBP0(cc.workingCapitalRequired)} sub="locked across the cycle" />
        <GpStat label="Discounted LTV" value={gpGBP2(dl.discountedLtv)} sub={'vs ' + gpGBP2(dl.undiscountedLtv) + ' undiscounted'} src={ltvBasisLabel && <GpSrc label={ltvBasisLabel} />} />
        <GpStat label="Operating profit (EBITDA)" value={gpGBP0(pr.operatingProfitWindow)} sub={gpPCT(pr.ebitdaMarginPct) + ' margin · window'} accent={(pr.operatingProfitWindow ?? 0) >= 0 ? good : bad} />
      </div>

      {cashTrap && (
        <div style={{ padding: '11px 13px', borderRadius: 'var(--r-sm)', background: 'rgba(251,191,36,.10)', border: '1px solid rgba(251,191,36,.30)', marginTop: 12 }}>
          <div style={{ fontWeight: 700, color: warn, marginBottom: 3 }}>EBITDA-positive, cash-negative</div>
          <div className="micro" style={{ color: 'var(--text-secondary)' }}>
            The window clears {gpGBP0(pr.operatingProfitWindow)} of operating profit, but once ad spend is netted in, monthly operating cash is {gpGBP0(tj.monthlyNetOperatingCash)} and {gpGBP0(cc.workingCapitalRequired)} sits locked in the {gpDays(cc.cccDays)} cash cycle. Unit-profitable, cash-trapped.
          </div>
        </div>
      )}

      {/* Genome breakdowns + sources. */}
      <div className="row" style={{ marginTop: 12 }}>
        <div style={{ flex: '1 1 240px' }}>
          <div className="micro" style={{ color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600 }}>CASH CYCLE (days)</div>
          <div className="mrow"><span className="k">Inventory held<GpSrc source={cc.inventoryDays.source} /></span><span className="v">{gpDays(cc.inventoryDays.days)}</span></div>
          <div className="mrow"><span className="k">+ Settlement lag<GpSrc source={cc.settlementLagDays.source} /></span><span className="v">{gpDays(cc.settlementLagDays.days)}</span></div>
          <div className="mrow"><span className="k">− Supplier terms (DPO)<GpSrc source={cc.supplierPaymentDays.source} /></span><span className="v">{gpDays(cc.supplierPaymentDays.days)}</span></div>
          <div className="mrow" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 6, marginTop: 2 }}><span className="k" style={{ fontWeight: 700 }}>= Cash conversion cycle</span><span className="v" style={{ fontWeight: 700 }}>{gpDays(cc.cccDays)}</span></div>
        </div>
        <div style={{ flex: '1 1 240px' }}>
          <div className="micro" style={{ color: 'var(--text-muted)', marginBottom: 6, fontWeight: 600 }}>PROFIT &amp; LTV</div>
          <div className="mrow"><span className="k">Contribution (window)</span><span className="v">{gpGBP0(pr.contributionWindow)}</span></div>
          <div className="mrow"><span className="k">− Fixed costs<GpSrc source={pr.fixedCostsSource} /></span><span className="v">{gpGBP0(pr.fixedCostsWindow)}</span></div>
          <div className="mrow" style={{ borderTop: '1px solid var(--border-subtle)', paddingTop: 6, marginTop: 2 }}><span className="k" style={{ fontWeight: 700 }}>= EBITDA</span><span className="v" style={{ fontWeight: 700, color: (pr.operatingProfitWindow ?? 0) >= 0 ? good : bad }}>{gpGBP0(pr.operatingProfitWindow)}</span></div>
          <div className="mrow"><span className="k">Discount rate<GpSrc source={dl.discountRateSource} /></span><span className="v">{gpPCT(dl.discountRateAnnual, 0)}/yr</span></div>
          <div className="mrow"><span className="k">LTV haircut (discounting)</span><span className="v">{gpGBP2(dl.discountHaircut)}</span></div>
        </div>
      </div>

      {/* The forward signal: marginal economics + trajectories. */}
      <div className="micro" style={{ color: 'var(--text-muted)', margin: '16px 0 8px', fontWeight: 600 }}>FORWARD SIGNAL <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>· projected from the fitted curves</span></div>
      <div className="row">
        <div style={{ flex: '1 1 240px' }}>
          {me.status === 'ok' ? (
            <>
              <div className="mrow"><span className="k">Marginal CAC (next customer)</span><span className="v">{gpGBP2(me.marginalCac)}</span></div>
              <div className="mrow"><span className="k">Avg CAC (now)</span><span className="v">{gpGBP2(me.averageCac)}</span></div>
              <div className="mrow"><span className="k">Profitable spend ceiling</span><span className="v">{gpGBP0(me.profitableSpendCeiling)}/mo</span></div>
              <div className="mrow"><span className="k">Headroom vs current</span><span className="v" style={{ color: (me.spendHeadroom ?? 0) >= 0 ? good : bad }}>{gpPCT(me.spendHeadroomPct, 0)}</span></div>
            </>
          ) : (
            <div style={{ padding: '12px 13px', borderRadius: 'var(--r-sm)', background: 'var(--bg-app)', border: '1px dashed var(--border-subtle)' }}>
              <div style={{ fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 4 }}>Marginal CAC &amp; spend ceiling — not yet available</div>
              <div className="micro" style={{ color: 'var(--text-faint)' }}>{me.note || 'Needs a fitted CAC-elasticity curve (≥3 aligned spend/CAC months). No number shown rather than a guessed one.'}</div>
            </div>
          )}
        </div>
        <div style={{ flex: '1 1 240px' }}>
          <div className="mrow" style={{ alignItems: 'center' }}><span className="k">LTV:CAC over {tj.horizonMonths}mo</span><span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><GpSpark series={tj.ltvCacTrajectory} color={good} /><span className="v">{gpRX(tj.ltvCacTrajectory && tj.ltvCacTrajectory[tj.ltvCacTrajectory.length - 1])}</span></span></div>
          <div className="mrow" style={{ alignItems: 'center' }}><span className="k">Cash position, {tj.horizonMonths}mo</span><span style={{ display: 'flex', alignItems: 'center', gap: 8 }}><GpSpark series={tj.netCashPositionByMonth} color={bad} /><span className="v" style={{ color: bad }}>{gpGBP0(tj.netCashPositionByMonth && tj.netCashPositionByMonth[tj.netCashPositionByMonth.length - 1])}</span></span></div>
          <div className="mrow"><span className="k">Monthly operating cash</span><span className="v" style={{ color: (tj.monthlyNetOperatingCash ?? 0) >= 0 ? good : bad }}>{gpGBP0(tj.monthlyNetOperatingCash)}</span></div>
          <div className="mrow"><span className="k">CAC payback</span><span className="v">{tj.paybackMonthProjected == null ? '> ' + tj.horizonMonths + 'mo' : (tj.paybackMonthProjected === 0 ? 'first order' : 'month ' + tj.paybackMonthProjected)}</span></div>
        </div>
      </div>

      <div className="micro" style={{ color: 'var(--text-faint)', marginTop: 10 }}>
        Projection assumes spend flat, retention curve holds, costs constant; paid-attributed orders only. Shadow layer — reported, not yet gating any verdict.
      </div>
    </div>
  );
}

function CrossChannel({start}){
  const daily = useMemo(()=>buildDaily(start),[start]);
  const meta=inRange(D.metaDaily,start), gads=inRange(D.googleAds,start), shop=inRange(D.shopify,start), ga=inRange(D.ga4,start), kl=inRange(D.klaviyo,start);
  const rev=sum(shop,'netSales');
  const channels=[
    {name:'Meta Ads', spend:sum(meta,'cost'), claimed:sum(meta,'purchaseValue'), color:COL.meta},
    {name:'Google Ads', spend:sum(gads,'cost'), claimed:sum(gads,'convValue'), color:COL.google},
  ];
  // funnel from GA4
  const f = [
    {stage:'Sessions', v:sum(ga,'sessions')},
    {stage:'Add to cart', v:sum(ga,'addToCarts')},
    {stage:'Checkout', v:sum(ga,'checkouts')},
    {stage:'Purchase', v:sum(ga,'purchases')},
  ];
  const fmax=f[0].v||1;
  // simple spend->revenue correlation (same-day, paid vs revenue)
  const xs=daily.map(d=>d.paid), ys=daily.map(d=>d.revenue);
  const corr=pearson(xs,ys);
  // Lagged correlation — paid today vs revenue +0..3 days (Phase 2.3): revenue
  // responds with a lag, so same-day understates paid's effect.
  const lagCorr=[0,1,2,3].map(L=>({lag:L, r:(L<xs.length-3)?pearson(xs.slice(0,xs.length-L), ys.slice(L)):null}));
  const bestLag=lagCorr.filter(l=>l.r!=null).slice().sort((a,b)=>b.r-a.r)[0];
  // Meta spend-tier efficiency (Phase 2.1, Meta-only): claimed ROAS by daily spend
  // tier → does each extra pound earn less? (Google absent → Meta only for now.)
  const mdays=meta.filter(r=>(r.cost||0)>0 && r.purchaseValue!=null).map(r=>({cost:r.cost, val:r.purchaseValue})).sort((a,b)=>a.cost-b.cost);
  let tiers=null;
  if(mdays.length>=6){ const t=Math.floor(mdays.length/3); const grp=[mdays.slice(0,t), mdays.slice(t,2*t), mdays.slice(2*t)];
    tiers=grp.map((g,i)=>{ const c=g.reduce((a,x)=>a+x.cost,0), v=g.reduce((a,x)=>a+x.val,0); return {label:['Low','Mid','High'][i], avgSpend:c/g.length, roas:c>0?v/c:null, n:g.length}; }); }
  const tierFalling = tiers && tiers[0].roas!=null && tiers[2].roas!=null && tiers[2].roas < tiers[0].roas*0.85;
  return (<div>
    <FitCard start={start} end={ACTIVE_END}/>
    <GenomePanel/>
    <div className="card" style={{marginBottom:14}}>
      <h2>Channel revenue claims vs spend</h2>
      <table>
        <thead><tr><th>Channel</th><th>Spend</th><th>Claimed revenue</th><th>Claimed ROAS</th><th>% of Shopify net</th></tr></thead>
        <tbody>
        {channels.map(c=>(<tr key={c.name}><td><span className="pill" style={{background:c.color+'22',color:c.color}}>{c.name}</span></td><td>{c.spend?GBP(c.spend):'—'}</td><td>{GBP(c.claimed)}</td><td>{c.spend?(c.claimed/c.spend).toFixed(2)+'x':'—'}</td><td>{PCT(rev?c.claimed/rev:null)}</td></tr>))}
        </tbody>
      </table>
      <div className="note" style={{marginTop:12}}>Platform-claimed revenue is <b>double-counted</b> — Meta + Google each claim conversions the other (and email) also touched, so claims sum to more than Shopify's actual net. That gap is exactly why the next step is incrementality. (Klaviyo email-attributed revenue needs its attributed report types — a follow-up pull — so it's left out here rather than mislabeled.)</div>
    </div>
    <div className="row">
      <div className="card" style={{flex:'1 1 380px'}}>
        <h2>Site funnel (GA4)</h2>
        {f.map(s=>(<div key={s.stage} style={{margin:'10px 0'}}>
          <div className="mrow"><span className="k">{s.stage}</span><span className="v">{NUM(s.v)} ({PCT(s.v/fmax)})</span></div>
          <div style={{height:9,background:'#23232b',borderRadius:6,marginTop:4}}><div style={{height:9,width:(100*s.v/fmax)+'%',background:COL.sessions,borderRadius:6}}/></div>
        </div>))}
        <div className="muted" style={{marginTop:8}}>Add-to-cart → checkout is the steepest drop — a website-structure question for the next phase.</div>
      </div>
      <div className="card" style={{flex:'1 1 380px'}}>
        <h2>Paid effect &amp; incrementality</h2>
        <div className="micro" style={{color:'var(--text-muted)', marginBottom:6}}>Spend↔revenue correlation by lag (revenue responds with a delay, so same-day understates paid).</div>
        <div style={{display:'flex', gap:8, marginBottom:10}}>
          {lagCorr.map(l=>(<div key={l.lag} style={{flex:1, textAlign:'center', padding:'8px 4px', borderRadius:'var(--r-sm)', background: bestLag&&l.lag===bestLag.lag?'var(--accent-bg)':'var(--bg-app)', border:'1px solid '+(bestLag&&l.lag===bestLag.lag?'rgba(124,140,255,.35)':'var(--border-subtle)')}}>
            <div style={{fontSize:18, fontWeight:700, color: bestLag&&l.lag===bestLag.lag?'var(--accent)':'var(--text-primary)'}}>{l.r==null?'—':l.r.toFixed(2)}</div>
            <div className="micro" style={{color:'var(--text-faint)'}}>+{l.lag}d</div>
          </div>))}
        </div>
        {bestLag && <div className="micro" style={{color:'var(--text-secondary)', marginBottom:10}}>Strongest at a <b>{bestLag.lag}-day lag</b> (r={bestLag.r.toFixed(2)}) — judge paid on a few-day window, not same-day ROAS.</div>}
        {tiers && (<div style={{marginBottom:8}}>
          <div className="micro" style={{color:'var(--text-muted)', marginBottom:4}}>Meta claimed ROAS by daily-spend tier {tierFalling?'— falling at higher spend (diminishing returns)':'— broadly flat across tiers'}:</div>
          <div style={{display:'flex', gap:8}}>
            {tiers.map((t,i)=>(<div key={i} style={{flex:1, textAlign:'center', fontSize:12}}>
              <div style={{fontWeight:700, color: tierFalling&&i===2?'#f87171':'var(--text-primary)'}}>{t.roas!=null?t.roas.toFixed(1)+'×':'—'}</div>
              <div className="micro" style={{color:'var(--text-faint)'}}>{t.label} · {GBP(t.avgSpend)}/d</div>
            </div>))}
          </div>
        </div>)}
        <div className="note" style={{marginTop:6}}>Correlation isn't causation. To <b>measure</b> incrementality: log a 2-week geo-holdout in the event log (pause Meta in one region, hold another), then read the revenue gap here. {tiers?'':'Google Ads data will unlock true cross-channel allocation once linked.'}</div>
      </div>
    </div>
    <Insight k="economics" />
    <Insight k="competitive" />
  </div>);
}

function pearson(x,y){ const n=x.length; if(!n) return null; const mx=x.reduce((a,b)=>a+b,0)/n, my=y.reduce((a,b)=>a+b,0)/n; let nu=0,dx=0,dy=0; for(let i=0;i<n;i++){const a=x[i]-mx,b=y[i]-my; nu+=a*b; dx+=a*a; dy+=b*b;} return (dx&&dy)? nu/Math.sqrt(dx*dy):null; }

function qualColor(t){ if(!t||t==='No rating') return 'grey'; if(t.indexOf('Above')===0) return 'green'; if(t.indexOf('Below')===0) return 'red'; return 'amber'; }
function freqColor(f){ if(f==null) return 'grey'; if(f>=7) return 'red'; if(f>=4) return 'amber'; return 'green'; }
function creativeTag(c){
  if(c.qualConv && c.qualConv.indexOf('Below')===0) return ['red','weak conv'];
  if(c.roas==null||c.purchases==null) return ['grey','no sales'];
  if(c.roas>=3.0 && c.frequency<5) return ['green','scale'];
  if(c.roas>=2.3) return ['green','keep'];
  if(c.roas>=1.7) return ['amber','watch'];
  return ['red','cut'];
}

function agg(rows, key){
  const groups={};
  rows.forEach(r=>{
    const k=r[key]||'—';
    const g=groups[k]=groups[k]||{key:k, count:0, spend:0, impr:0, reach:0, atc:0, ic:0, purch:0, val:0, ctrNum:0, ctrDen:0};
    g.count++;
    g.spend+=r.cost||0; g.impr+=r.impressions||0; g.reach+=r.reach||0;
    g.atc+=r.atc||0; g.ic+=r.ic||0; g.purch+=r.purchases||0; g.val+=r.purchaseValue||0;
    g.ctrNum+=(r.linkCtr||0)*(r.impressions||0); g.ctrDen+=r.impressions||0;
  });
  return Object.values(groups).map(g=>({...g, roas:g.spend>0?g.val/g.spend:null, ctr:g.ctrDen>0?g.ctrNum/g.ctrDen:null, cpa:g.purch>0?g.spend/g.purch:null})).sort((a,b)=>b.spend-a.spend);
}

function AggTable({title, rows, lblCol}){
  return (<div className="card" style={{flex:'1 1 320px'}}>
    <h2>{title}</h2>
    <table><thead><tr><th>{lblCol}</th><th>Ads</th><th>Spend</th><th>ROAS</th><th>CTR</th><th>CPA</th></tr></thead><tbody>
    {rows.map((r,i)=>(<tr key={i}><td>{r.key}</td><td>{r.count}</td><td>{GBP(r.spend)}</td><td style={{color:r.roas==null?'#888':r.roas>=2.5?'#4ade80':r.roas>=1.7?'#fbbf24':'#f87171'}}>{r.roas==null?'—':r.roas.toFixed(2)+'x'}</td><td>{PCT(r.ctr)}</td><td>{r.cpa==null?'—':GBP(r.cpa)}</td></tr>))}
    </tbody></table>
  </div>);
}

function aggBy(rows, keyFn){
  const groups={};
  rows.forEach(r=>{
    const k=keyFn(r);
    if(!k||k==='Unknown'||k==='unknown') return;
    const g=groups[k]=groups[k]||{key:k,cost:0,impr:0,atc:0,purch:0,val:0,ctrNum:0,ctrDen:0};
    g.cost+=r.cost||0; g.impr+=r.impressions||0; g.atc+=r.atc||0; g.purch+=r.purchases||0; g.val+=r.purchaseValue||0;
    g.ctrNum+=(r.linkCtr||0)*(r.impressions||0); g.ctrDen+=r.impressions||0;
  });
  return Object.values(groups).map(g=>({...g, ctr:g.ctrDen>0?g.ctrNum/g.ctrDen:null, roas:g.cost>0?g.val/g.cost:null, cpa:g.purch>0?g.cost/g.purch:null})).sort((a,b)=>b.cost-a.cost);
}

function DemoPanel(){
  const rows=D.demoAgeGender||[];
  const byAge=aggBy(rows, r=>r.age);
  const byGender=aggBy(rows, r=>r.gender);
  const totalSpend=byGender.reduce((a,b)=>a+b.cost,0);
  const femaleSpend=byGender.find(g=>g.key==='female')?.cost||0;
  const ageOrder=['18-24','25-34','35-44','45-54','55-64','65+'];
  const sortedAge=[...byAge].sort((a,b)=>ageOrder.indexOf(a.key)-ageOrder.indexOf(b.key));
  return (<div className="card" style={{marginTop:14}}>
    <h2>Audience — who's actually buying</h2>
    <div className="row" style={{marginBottom:12}}>
      <KPI label="% spend female" val={PCT(totalSpend>0?femaleSpend/totalSpend:0)} sub={`vs ${PCT(totalSpend>0?(1-femaleSpend/totalSpend):0)} male/unknown`}
        agent="Pulse" observation="95%+ of spend is female — Meta has correctly identified the audience, the IG follower base confirms it."
        implication="Explicitly exclude male audiences in targeting — the ~5% currently going there is waste." />
      <KPI label="Top spend age" val={byAge[0]?.key||'—'} sub={byAge[0]?GBP(byAge[0].cost)+' · ROAS '+(byAge[0].roas?byAge[0].roas.toFixed(2)+'x':'—'):''}
        agent="Pulse" observation="35-44 / 45-54 females absorb most of the spend — Meta's algorithm chose them because they trigger more events."
        implication="Check ROAS per £, not just spend volume — the algorithm optimises for events, not necessarily for your margin." />
      <KPI label="Best ROAS age" val={[...byAge].filter(a=>a.roas).sort((a,b)=>b.roas-a.roas)[0]?.key||'—'} sub={(()=>{const b=[...byAge].filter(a=>a.roas).sort((a,b)=>b.roas-a.roas)[0]; return b?b.roas.toFixed(2)+'x · '+GBP(b.cost)+' spend':'';})()}
        agent="Frame" observation="25-34 females convert at the highest ROAS per £ but get the lowest spend allocation."
        implication="Run an age-split test campaign aimed at 25-34 to validate scaling — could materially shift the efficiency curve." />
    </div>
    <h2 style={{fontSize:14,marginTop:8}}>By age band (female only — male spend is tiny)</h2>
    <table><thead><tr><th>Age</th><th>Spend</th><th>% of spend</th><th>CTR</th><th>Purch</th><th>CPA</th><th>ROAS</th></tr></thead><tbody>
      {sortedAge.map((a,i)=>(<tr key={i}>
        <td>{a.key}</td><td>{GBP(a.cost)}</td><td>{PCT(totalSpend>0?a.cost/totalSpend:0)}</td><td>{PCT(a.ctr)}</td><td>{a.purch}</td><td>{a.cpa?GBP(a.cpa):'—'}</td>
        <td style={{color:a.roas==null?'#888':a.roas>=2.5?'#4ade80':a.roas>=1.7?'#fbbf24':'#f87171'}}>{a.roas?a.roas.toFixed(2)+'x':'—'}</td>
      </tr>))}
    </tbody></table>
    <div className="note" style={{marginTop:10}}>The algorithm has settled on <b>35–54 females</b> as the biggest spend bucket — but younger <b>25–34 females</b> often convert at higher ROAS per £ when they do convert. <b>18–24 doesn't convert.</b> Almost zero male conversions across the whole library — male spend is wasted.</div>
  </div>);
}

function PlacementPanel(){
  const rows=D.demoPlacement||[];
  const byPlat=aggBy(rows, r=>r.platform);
  const byPos=aggBy(rows, r=>r.position);
  const byDevice=aggBy(rows, r=>r.device);
  const totalSpend=byPlat.reduce((a,b)=>a+b.cost,0);
  const igSpend=byPlat.find(p=>p.key==='instagram')?.cost||0;
  return (<div className="card" style={{marginTop:14}}>
    <h2>Where the ads run — placement & device</h2>
    <div className="row" style={{marginBottom:12}}>
      <KPI label="% Instagram spend" val={PCT(totalSpend>0?igSpend/totalSpend:0)} sub="Facebook delivery: zero"
        agent="Pulse" observation="100% Instagram, 0% Facebook — an entire ad surface is currently untouched."
        implication="Test FB placement with the same creative — different audience, often lower CPM, free incremental reach." />
      <KPI label="Top placement" val={byPos[0]?.key.replace('instagram_','').replace('_',' ')||'—'} sub={byPos[0]?GBP(byPos[0].cost)+' · ROAS '+(byPos[0].roas?byPos[0].roas.toFixed(2)+'x':'—'):''}
        agent="Frame" observation="Feed dominates spend, but Stories has the highest CTR on catalogue ads (3.6% iPhone, 5.3% Android)."
        implication="Brief Stories-native creative for the Stacks catalogue — match format to the placement that's already winning." />
      <KPI label="Best ROAS placement" val={(()=>{const b=[...byPos].filter(a=>a.roas&&a.cost>50).sort((a,b)=>b.roas-a.roas)[0]; return b?b.key.replace('instagram_','').replace('_',' '):'—';})()} sub={(()=>{const b=[...byPos].filter(a=>a.roas&&a.cost>50).sort((a,b)=>b.roas-a.roas)[0]; return b?b.roas.toFixed(2)+'x · '+GBP(b.cost):'';})()}
        agent="Frame" observation="Reels iPhone on Angela is 4.49× ROAS but starved at £192 vs £530 in feed."
        implication="Push budget into Reels with Reels-native edits (9:16, hook in 1.5s, captions for sound-off)." />
    </div>
    <div className="row">
      <div style={{flex:'1 1 320px'}}>
        <h2 style={{fontSize:14}}>By placement (position)</h2>
        <table><thead><tr><th>Placement</th><th>Spend</th><th>CTR</th><th>Purch</th><th>ROAS</th></tr></thead><tbody>
          {byPos.map((a,i)=>(<tr key={i}><td>{a.key.replace('instagram_','').replace('_',' ')}</td><td>{GBP(a.cost)}</td><td>{PCT(a.ctr)}</td><td>{a.purch}</td><td style={{color:a.roas==null?'#888':a.roas>=2.5?'#4ade80':a.roas>=1.7?'#fbbf24':'#f87171'}}>{a.roas?a.roas.toFixed(2)+'x':'—'}</td></tr>))}
        </tbody></table>
      </div>
      <div style={{flex:'1 1 320px'}}>
        <h2 style={{fontSize:14}}>By device</h2>
        <table><thead><tr><th>Device</th><th>Spend</th><th>CTR</th><th>Purch</th><th>ROAS</th></tr></thead><tbody>
          {byDevice.map((a,i)=>(<tr key={i}><td>{a.key.replace('_',' ')}</td><td>{GBP(a.cost)}</td><td>{PCT(a.ctr)}</td><td>{a.purch}</td><td style={{color:a.roas==null?'#888':a.roas>=2.5?'#4ade80':a.roas>=1.7?'#fbbf24':'#f87171'}}>{a.roas?a.roas.toFixed(2)+'x':'—'}</td></tr>))}
        </tbody></table>
      </div>
    </div>
    {DEMO && <div className="note" style={{marginTop:10}}>frkl is delivering <b>100% on Instagram, 0% on Facebook</b> — an entire ad surface is untouched. <b>iPhone dominates</b> spend (~70%); Android converts at similar quality. <b>Stories</b> on Stacks/Catalogue is the highest-CTR placement; <b>Reels</b> is the best converter on Angela but under-funded.</div>}
  </div>);
}

function FatigueBoard({rows}){
  const sorted=[...rows].sort((a,b)=>(b.frequency||0)-(a.frequency||0));
  const totalSpend=rows.reduce((a,r)=>a+(r.cost||0),0);
  return (<div className="card">
    <h2>Fatigue board — frequency × Meta quality ranking</h2>
    <div className="muted" style={{marginBottom:10}}>Higher frequency = audience saturated. Below-average conversion-rate ranking = Meta thinks post-click is weak.</div>
    <table><thead><tr><th>Ad</th><th>Freq</th><th>Reach</th><th>Engage rank</th><th>Conv rank</th><th>Spend</th><th>% spend</th></tr></thead><tbody>
    {sorted.map((c,i)=>(<tr key={i}>
      <td style={{maxWidth:280,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{c.name}</td>
      <td><span className={'pill '+freqColor(c.frequency)}>{c.frequency==null?'—':c.frequency.toFixed(1)+'x'}</span></td>
      <td>{NUM(c.reach)}</td>
      <td><span className={'pill '+qualColor(c.qualEngage)}>{c.qualEngage||'—'}</span></td>
      <td><span className={'pill '+qualColor(c.qualConv)}>{c.qualConv||'—'}</span></td>
      <td>{GBP(c.cost)}</td>
      <td>{PCT(totalSpend>0?c.cost/totalSpend:0)}</td>
    </tr>))}
    </tbody></table>
  </div>);
}

function HookRetention({rows}){
  React.useEffect(()=>{const t=setTimeout(()=>window.dispatchEvent(new Event('resize')),60);return ()=>clearTimeout(t);},[]);
  const videos=rows.filter(c=>(c.v3s||0)>50);
  if(!videos.length) return null;
  // normalise each curve to 3sv = 100
  const data=[{stage:'3s'},{stage:'25%'},{stage:'50%'},{stage:'75%'},{stage:'100%'}];
  const palette=['#5b8def','#4ade80','#fbbf24','#c084fc','#f87171','#22d3ee'];
  const names=[];
  videos.forEach((v,i)=>{
    const key='c'+i; names.push({key, name:v.name+(videos.filter(x=>x.name===v.name).length>1?' #'+(videos.slice(0,i+1).filter(x=>x.name===v.name).length):''), color:palette[i%palette.length]});
    const base=v.v3s||1;
    data[0][key]=100;
    data[1][key]=v.vp25?Math.min(100, +(100*v.vp25/Math.max(v.v3s,v.vp25)).toFixed(0)):null;
    data[2][key]=v.vp50?+(100*v.vp50/Math.max(v.v3s,v.vp25,v.vp50)).toFixed(0):null;
    data[3][key]=v.vp75?+(100*v.vp75/Math.max(v.v3s,v.vp25,v.vp50,v.vp75)).toFixed(0):null;
    data[4][key]=v.vp100?+(100*v.vp100/Math.max(v.v3s,v.vp25,v.vp50,v.vp75,v.vp100)).toFixed(0):null;
  });
  return (<div className="card">
    <h2>Hook retention — video drop-off after the 3s view</h2>
    <div className="muted" style={{marginBottom:8}}>Each line normalised to 100 at the highest milestone reached. Steeper drop = weaker hook.</div>
    <R.ResponsiveContainer width="100%" height={260}>
      <R.LineChart data={data} margin={{top:6,right:8,left:10,bottom:20}}>
        <R.CartesianGrid stroke="#222229" vertical={false} />
        <R.XAxis dataKey="stage" tick={{fill:'#6f6f7b',fontSize:11}} label={{value:'Video milestone', position:'insideBottom', offset:-8, fill:'#6f6f7b', fontSize:11}} />
        <R.YAxis tick={{fill:'#6f6f7b',fontSize:11}} tickFormatter={v=>v+'%'} label={{value:'Retention (%)', angle:-90, position:'insideLeft', style:{textAnchor:'middle'}, fill:'#6f6f7b', fontSize:11}} />
        <R.Tooltip contentStyle={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:10}} formatter={v=>v+'%'} />
        {names.map(n=>(<R.Line key={n.key} type="monotone" dataKey={n.key} name={n.name} stroke={n.color} strokeWidth={2} dot={{r:3}} />))}
      </R.LineChart>
    </R.ResponsiveContainer>
    <div style={{marginTop:8,display:'flex',flexWrap:'wrap',gap:10}}>{names.map(n=>(<span key={n.key} style={{fontSize:11,color:'#b6b6c0'}}><span style={{display:'inline-block',width:10,height:10,background:n.color,borderRadius:2,marginRight:5,verticalAlign:'middle'}}/>{n.name}</span>))}</div>
  </div>);
}

function FunnelTable({rows}){
  const sorted=[...rows].filter(r=>r.atc).sort((a,b)=>(b.cost||0)-(a.cost||0));
  return (<div className="card">
    <h2>Per-creative funnel — where the cart leaks</h2>
    <div className="muted" style={{marginBottom:10}}>ATC = website add-to-cart; IC = initiate checkout; P = purchase. Ratios show step-by-step drop.</div>
    <table><thead><tr><th>Ad</th><th>ATC</th><th>IC</th><th>P</th><th>ATC→IC</th><th>IC→P</th><th>ATC:P</th></tr></thead><tbody>
    {sorted.map((c,i)=>{ const atcIc=c.atc>0?c.ic/c.atc:null; const icP=c.ic>0&&c.purchases?c.purchases/c.ic:null; const atcP=c.atc>0&&c.purchases?c.atc/c.purchases:null;
      const leakAtcP = atcP!=null && atcP>=7 ? 'red' : atcP!=null && atcP>=5 ? 'amber' : 'green';
      return (<tr key={i}>
        <td style={{maxWidth:280,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{c.name}</td>
        <td>{NUM(c.atc)}</td><td>{NUM(c.ic)}</td><td>{c.purchases==null?'—':c.purchases}</td>
        <td>{PCT(atcIc)}</td>
        <td>{PCT(icP)}</td>
        <td><span className={'pill '+leakAtcP}>{atcP==null?'—':atcP.toFixed(1)+':1'}</span></td>
      </tr>);
    })}
    </tbody></table>
    <div className="muted" style={{marginTop:8,fontSize:12}}>A high ATC:P ratio means lots of carts but few sales — likely a landing/checkout problem more than a creative one.</div>
  </div>);
}

function CreativeVisionPanel(){
  const V = window.FRKL_CREATIVE_VISION;
  if (!V || !Array.isArray(V.creatives)) return null;
  const cre = [...V.creatives].sort((a,b)=>(b.composite||0)-(a.composite||0));
  const avgComposite = cre.reduce((a,c)=>a+(c.composite||0),0) / Math.max(1,cre.length);
  const SCORE_COLOR = (v) => v >= 4.0 ? '#4ade80' : v >= 3.0 ? '#fbbf24' : '#f87171';
  const insights = V.cross_creative_insights || {};
  const meta = V.meta || {};
  const refreshedAt = meta.generated_at_last_refresh || meta.generated_at;
  return (<div className="card" style={{marginBottom:14, borderLeft:'3px solid #c084fc'}}>
    <h2>Creative vision analysis — Claude looks at the actual creative</h2>
    <div className="muted" style={{marginBottom:10, fontSize:12}}>
      {meta.analyst || 'Claude vision'} scored each creative on hook strength, visual hierarchy, claim quality, audience fit, brand consistency. <b>This is what Triple Whale doesn't do</b> — most performance tools tell you which ad won; this tells you WHY at the asset level.
      {refreshedAt && <span> · Last refresh: {new Date(refreshedAt).toLocaleString()}</span>}
      · Re-run with <code>python scripts/oi_creative_vision.py --force</code>
    </div>
    <div className="row" style={{marginBottom:10}}>
      <div className="card kpi" style={{borderLeft:`3px solid ${SCORE_COLOR(avgComposite)}`}}>
        <div className="label">Avg composite score</div>
        <div className="val">{avgComposite.toFixed(2)}<span style={{fontSize:14,color:'#7b7b87'}}>/5</span></div>
        <div className="sub">across {cre.length} analysed creatives</div>
      </div>
      <div className="card kpi" style={{borderLeft:'3px solid #4ade80'}}>
        <div className="label">Top scorer</div>
        <div className="val" style={{fontSize:14,lineHeight:1.2}}>{cre[0]?.name?.slice(0,32) || '—'}</div>
        <div className="sub">{cre[0]?.composite?.toFixed(2) || '—'} composite · {cre[0]?.verdict || ''}</div>
      </div>
      <div className="card kpi" style={{borderLeft:'3px solid #f87171'}}>
        <div className="label">Pause-or-rework</div>
        <div className="val">{(insights.pause_or_rework || []).length}</div>
        <div className="sub">composite ≤ 2.0 — wasted impressions</div>
      </div>
      <div className="card kpi" style={{borderLeft:'3px solid #fbbf24'}}>
        <div className="label">Need full asset</div>
        <div className="val">{(insights.need_more_data || []).length}</div>
        <div className="sub">scoring confidence low — pull video</div>
      </div>
    </div>
    {/* Per-creative cards */}
    <div className="grid cg" style={{marginBottom:14}}>
    {cre.map((c,i) => {
      const compColor = SCORE_COLOR(c.composite || 0);
      const scores = c.scores || {};
      return (<div className="creative" key={i} style={{borderLeft:`3px solid ${compColor}`}}>
        {c.thumbnail ? (<img className="thumb" src={c.thumbnail} alt={c.name||''} onError={e=>{e.target.style.opacity=.2;}} />) : (<div className="thumb" style={{background:'#1a1a22'}}/>)}
        <div className="body">
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'start',gap:8,marginBottom:6}}>
            <span className="name" style={{fontSize:12,fontWeight:600,color:'var(--text-primary)'}}>{c.name}</span>
            <span style={{fontSize:18,fontWeight:700,color:compColor,whiteSpace:'nowrap'}}>{(c.composite||0).toFixed(1)}</span>
          </div>
          <div className="muted" style={{fontSize:11,marginBottom:8,fontStyle:'italic'}}>{c.verdict}</div>
          <div style={{display:'flex',flexDirection:'column',gap:3,marginBottom:8}}>
            {[['hook_strength','Hook'],['visual_hierarchy','Visual'],['claim_quality','Claim'],['audience_fit','Audience'],['brand_consistency','Brand']].map(([k,l]) => {
              const v = scores[k] || 0;
              const c2 = SCORE_COLOR(v);
              return (<div key={k} className="mrow"><span className="k">{l}</span><span className="v" style={{color:c2,fontWeight:600}}>{v}/5 {'★'.repeat(v)}</span></div>);
            })}
          </div>
          <div style={{fontSize:11,color:'#b6b6c0',lineHeight:1.45,marginBottom:8}}>
            <b style={{color:'var(--text-primary)'}}>What Claude sees:</b> {c.what_i_see}
          </div>
          <ul style={{margin:'0 0 8px 0',padding:'0 0 0 16px',fontSize:11,color:'#b6b6c0',lineHeight:1.5}}>
            {(c.feedback||[]).map((f,j)=>(<li key={j}>{f}</li>))}
          </ul>
          <div style={{padding:8,background:'var(--bg-app)',borderLeft:'2px solid #4ade80',borderRadius:'0 4px 4px 0',fontSize:11,color:'var(--text-secondary)'}}>
            <b style={{color:'#4ade80'}}>Next iteration:</b> {c.next_iteration}
          </div>
        </div>
      </div>);
    })}
    </div>
    {/* Frame director brief */}
    {(insights.frame_director_brief || []).length > 0 && (<div className="card" style={{marginBottom:0, borderLeft:'3px solid #fbbf24'}}>
      <h2>Frame's brief to the creative team</h2>
      <ol style={{margin:0,padding:'0 0 0 18px',fontSize:13,color:'var(--text-secondary)',lineHeight:1.7}}>
        {insights.frame_director_brief.map((b,i)=>(<li key={i} dangerouslySetInnerHTML={{__html: b.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')}}/>))}
      </ol>
    </div>)}
  </div>);
}

function Creatives(){
  const [sort,setSort]=useState('cost');
  const rows=D.creatives;
  const total={spend:0,impr:0,reach:0,atc:0,purch:0,val:0,weakSpend:0};
  rows.forEach(r=>{ total.spend+=r.cost||0; total.impr+=r.impressions||0; total.reach+=r.reach||0; total.atc+=r.atc||0; total.purch+=r.purchases||0; total.val+=r.purchaseValue||0; if(r.qualConv&&r.qualConv.indexOf('Below')===0) total.weakSpend+=r.cost||0; });
  const sortedCards=[...rows].sort((a,b)=>(b[sort]||0)-(a[sort]||0));
  return (<div>
    <CreativeVisionPanel/>
    <CreativeFatiguePanel/>
    <div className="row" style={{marginBottom:14}}>
      <KPI label="Active ads (30d)" val={rows.length} sub={`${NUM(total.impr)} impressions · reach ${NUM(total.reach)}`}
        agent="Pulse" observation="10 active ads is a small library for this spend level — concentration risk on a couple of creatives."
        implication="Brief 3–5 new creator variants every fortnight to keep the rotation fresh and avoid audience fatigue." />
      <KPI label="Creative spend" val={GBP(total.spend)} sub={`${NUM(total.purch)} purchases · CPA ${GBP(total.purch>0?total.spend/total.purch:null)}`}
        agent="Pulse" observation="Top 2 ads carry ~50% of the spend — Angela video + Stacks catalogue."
        implication="Spread budget across more proven winners so a single creative pause doesn't blow up the month." />
      <KPI label="Blended creative ROAS" val={(total.val/total.spend).toFixed(2)+'x'} sub={`Claimed value ${GBP(total.val)}`}
        agent="Atlas" observation="Platform-claimed — net of code discounts (~10% of DTC), sale-price markdowns and ~30% COGS it sits close to contribution breakeven."
        implication="Re-report on a contribution basis before any investor conversation; claimed ROAS overstates." />
      <KPI label="% spend on weak conv rank" val={PCT(total.spend>0?total.weakSpend/total.spend:0)} sub="ads flagged Below average by Meta"
        agent="Frame" observation="Over a third of spend is on ads Meta itself flags Below-average for conversion — Angela + All Videos."
        implication="It's probably landing / audience mismatch, not creative — fix the cart JS error first, then re-judge." />
    </div>
    <div className="row">
      <AggTable title="By format" rows={agg(rows,'format')} lblCol="Format" />
      <AggTable title="By concept" rows={agg(rows,'concept')} lblCol="Concept" />
      <AggTable title="By market" rows={agg(rows,'market')} lblCol="Market" />
    </div>
    <DemoPanel />
    <PlacementPanel />
    <div style={{marginTop:14}}>
      <FatigueBoard rows={rows} />
    </div>
    <div style={{marginTop:14}}>
      <FunnelTable rows={rows} />
    </div>
    <div style={{marginTop:14}}>
      <HookRetention rows={rows} />
    </div>
    <div className="card" style={{marginTop:14,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:10}}>
      <div><h2 style={{marginBottom:4}}>Creative gallery</h2><div className="muted">Live thumbnails from Meta · tags now factor Meta's conv-rate ranking, not just ROAS.</div></div>
      <div className="seg">{['cost','roas','purchases','frequency','linkCtr'].map(s=>(<button key={s} className={sort===s?'on':''} onClick={()=>setSort(s)}>{ {cost:'Spend',roas:'ROAS',purchases:'Purchases',frequency:'Frequency',linkCtr:'Link CTR'}[s] }</button>))}</div>
    </div>
    <div className="grid cg">
      {sortedCards.map((c,i)=>{ const [cls,txt]=creativeTag(c); return (
        <div className="creative" key={i}>
          <img className="thumb" src={c.image||c.thumbnail} alt={c.name} referrerPolicy="no-referrer" onError={e=>{e.target.style.opacity=.25;}} />
          <div className="body">
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'start',gap:8}}><span className="name">{c.name}</span><span className={'pill '+cls}>{txt}</span></div>
            <div style={{display:'flex',flexWrap:'wrap',gap:5,marginTop:2}}>
              <span className="pill grey" style={{fontSize:10}}>{c.format}</span>
              <span className="pill grey" style={{fontSize:10}}>{c.market}</span>
              <span className={'pill '+freqColor(c.frequency)} style={{fontSize:10}}>freq {c.frequency==null?'—':c.frequency.toFixed(1)+'x'}</span>
              <span className={'pill '+qualColor(c.qualConv)} style={{fontSize:10}}>conv: {(c.qualConv||'—').replace(' (bottom 35%)','')}</span>
            </div>
            <div className="copy">{c.body}</div>
            <div style={{marginTop:'auto',display:'flex',flexDirection:'column',gap:4}}>
              <div className="mrow"><span className="k">Spend</span><span className="v">{GBP(c.cost)}</span></div>
              <div className="mrow"><span className="k">CTR / CPM</span><span className="v">{PCT(c.linkCtr)} · {GBP2(c.cpm)}</span></div>
              <div className="mrow"><span className="k">ATC → IC → P</span><span className="v">{NUM(c.atc)} → {NUM(c.ic)} → {c.purchases==null?'—':c.purchases}</span></div>
              <div className="mrow"><span className="k">ROAS</span><span className="v" style={{color:cls==='green'?'#4ade80':cls==='red'?'#f87171':'#e8e8ec'}}>{c.roas==null?'—':c.roas.toFixed(2)+'x'}</span></div>
            </div>
          </div>
        </div>); })}
    </div>
    <div className="note" style={{marginTop:14}}>The two biggest spenders (Angela | Video and All Videos | Flexi) have <b>below-average Meta conversion-rate ranking</b> — they drive purchases but Meta judges the post-click weak (landing/audience mismatch). 'Stacks Catalogue UK' at 7.6× frequency is the most fatigued. Image URLs from Meta CDN expire ~24h after the pull — regenerate the data file for fresh images.</div>
    <Insight k="creative" />
  </div>);
}

function Channels({start}){
  const meta=inRange(D.metaDaily,start), gads=inRange(D.googleAds,start), kl=inRange(D.klaviyo,start), ga=inRange(D.ga4,start), shop=inRange(D.shopify,start);
  const box=(title,kids)=> (<div className="card" style={{flex:'1 1 380px'}}><h2>{title}</h2>{kids}</div>);
  const line=(k,v)=>(<div className="mrow" style={{margin:'6px 0'}}><span className="k">{k}</span><span className="v">{v}</span></div>);
  const klEmail = kl.filter(r=>(r.recipients||0)>1000);
  const chMix = (B.channelMix||[]).map(c=>({channel:c.channel, group:/^Paid/.test(c.channel)?'Paid':'Organic & owned', revenue:c.revenue||0, purchases:c.purchases||0, sessions:c.sessions||0}));
  return (<div>
    {chMix.length>0 && <ConfigurableChart
      title="Explore channels — GA4 attribution"
      dataset={chMix}
      dimensions={[{key:'channel',label:'Channel'},{key:'group',label:'Paid vs organic'}]}
      metrics={[{key:'revenue',label:'Revenue',fmt:GBP},{key:'purchases',label:'Purchases',fmt:NUM},{key:'sessions',label:'Sessions',fmt:NUM}]}
      defaultMetric="revenue" defaultSplit="channel" defaultChart="bar" defaultTopN={10}/>}
    <div className="row">
    {box('Meta Ads',(<div>{line('Spend',GBP(sum(meta,'cost')))}{line('Impressions',NUM(sum(meta,'impressions')))}{line('Pixel purchases',NUM(sum(meta,'purchases')))}{line('Claimed value',GBP(sum(meta,'purchaseValue')))}{line('Claimed ROAS',(sum(meta,'purchaseValue')/sum(meta,'cost')).toFixed(2)+'x')}</div>))}
    {box('Google Ads',(<div>{line('Spend',GBP(sum(gads,'cost')))}{line('Clicks',NUM(sum(gads,'clicks')))}{line('Impressions',NUM(sum(gads,'impressions')))}{line('Conversions',NUM(sum(gads,'conversions')))}{line('Conv. value',GBP(sum(gads,'convValue')))}{line('CPC',GBP2(sum(gads,'cost')/Math.max(1,sum(gads,'clicks'))))}</div>))}
    {box('Klaviyo (email/SMS)',(<div>{line('Send days',klEmail.length)}{line('Recipients (sends)',NUM(sum(klEmail,'recipients')))}{line('Avg open rate',PCT(klEmail.reduce((a,r)=>a+(r.openRate>2?0:r.openRate||0),0)/Math.max(1,klEmail.filter(r=>r.openRate<=2).length)))}{line('Klaviyo-tracked orders',NUM(sum(kl,'orders')))}{line('Tracked order value (gross)',GBP(sum(kl,'orderValue')))}</div>))}
    {box('GA4 behaviour',(<div>{line('Sessions',NUM(sum(ga,'sessions')))}{line('Avg engagement rate',PCT(ga.reduce((a,r)=>a+(r.engagementRate||0),0)/Math.max(1,ga.length)))}{line('Add-to-carts',NUM(sum(ga,'addToCarts')))}{line('Checkouts',NUM(sum(ga,'checkouts')))}{line('Purchases',NUM(sum(ga,'purchases')))}</div>))}
    {box('Shopify (revenue truth)',(<div>{line('Net revenue',GBP(sum(shop,'netSales')))}{line('Total sales',GBP(sum(shop,'totalSales')))}{line('Orders',NUM(sum(shop,'orders')))}{line('AOV',GBP(sum(shop,'netSales')/Math.max(1,sum(shop,'orders'))))}{line('Discounts',GBP(sum(shop,'discounts')))}{line('Returns',GBP(sum(shop,'returns')))}</div>))}
    </div>
    <AffiliatePanel/>
    <CreatorCandidatesPanel/>
    <Insight k="meta" /><Insight k="google" /><Insight k="klaviyo" /><Insight k="shopify" /><Insight k="cx" />
  </div>);
}

function CreatorCandidatesPanel(){
  const C = window.FRKL_CREATORS;
  if (!C || !Array.isArray(C.candidates)) return null;
  const [tierFilter, setTierFilter] = useState('actionable');
  const [statusFilter, setStatusFilter] = useState('all');
  const TIER_COLOR = {hero:'#4ade80', core:'#5b8def', longtail:'#fbbf24', pass:'#f87171'};

  const candidates = C.candidates.filter(c => {
    if (tierFilter === 'actionable' && c.tier !== 'hero' && c.tier !== 'core') return false;
    if (tierFilter !== 'all' && tierFilter !== 'actionable' && c.tier !== tierFilter) return false;
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    return true;
  });

  const summary = C.summary || {};
  const meta = C.meta || {};

  return (<div style={{marginTop:14}}>
    <div className="card" style={{marginBottom:14, borderLeft:'3px solid #38bdf8'}}>
      <h2>Creator candidate discovery — Tier B</h2>
      <div className="muted" style={{marginBottom:10, fontSize:12}}>
        {summary.totalCandidates || 0} candidates scored by LLM against frkl's brand brief and current winning affiliates. Sources searched: Astrid &amp; Miyu ambassador roster · Modash UK micro-influencer listings · SheerLuxe / Marie Claire / Fashion Monitor curated lists · UK lifestyle podcast hosts. <b>Scores are inference, not measurement</b> — verify follower counts, audience demos and engagement via Heepsy / Modash before significant outreach.
      </div>
      <div className="row" style={{marginBottom:8}}>
        <div className="card kpi" style={{borderLeft:'3px solid #4ade80'}}>
          <div className="label">Hero candidates</div>
          <div className="val">{(summary.tierCounts && summary.tierCounts.hero) || 0}</div>
          <div className="sub">composite ≥ 0.80</div>
        </div>
        <div className="card kpi" style={{borderLeft:'3px solid #5b8def'}}>
          <div className="label">Core candidates</div>
          <div className="val">{(summary.tierCounts && summary.tierCounts.core) || 0}</div>
          <div className="sub">composite 0.65–0.80</div>
        </div>
        <div className="card kpi" style={{borderLeft:'3px solid #fbbf24'}}>
          <div className="label">Est. actionable reach</div>
          <div className="val">{(summary.actionableReachEst||0).toLocaleString()}</div>
          <div className="sub">summed followers of hero + core. Inferred.</div>
        </div>
        <div className="card kpi" style={{borderLeft:'3px solid #c084fc'}}>
          <div className="label">Avg actionable score</div>
          <div className="val">{((summary.actionableAvgComposite||0)*100).toFixed(0)}%</div>
          <div className="sub">brand × audience × engagement</div>
        </div>
      </div>
      <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:10,flexWrap:'wrap'}}>
        <span className="muted" style={{fontSize:11,textTransform:'uppercase',letterSpacing:.05,fontWeight:700}}>FILTER</span>
        <select value={tierFilter} onChange={e=>setTierFilter(e.target.value)} style={{background:'var(--bg-input)',color:'var(--text-primary)',border:'1px solid var(--border-default)',borderRadius:4,padding:'4px 8px',fontSize:12}}>
          <option value="actionable">Actionable (hero + core)</option>
          <option value="all">All tiers</option>
          <option value="hero">Hero only</option>
          <option value="core">Core only</option>
          <option value="longtail">Longtail</option>
          <option value="pass">Pass (audience/budget mismatch)</option>
        </select>
        <select value={statusFilter} onChange={e=>setStatusFilter(e.target.value)} style={{background:'var(--bg-input)',color:'var(--text-primary)',border:'1px solid var(--border-default)',borderRadius:4,padding:'4px 8px',fontSize:12}}>
          <option value="all">All statuses</option>
          <option value="prospect">Prospect</option>
          <option value="contacted">Contacted</option>
          <option value="active">Active</option>
          <option value="declined">Declined</option>
          <option value="pass">Passed</option>
        </select>
        <span className="muted" style={{marginLeft:'auto',fontSize:11}}>{candidates.length} of {summary.totalCandidates || 0}</span>
      </div>
      <table><thead><tr><th>Tier</th><th className="tl">Handle</th><th className="tl">Name / themes</th><th>Est. reach</th><th>Brand fit</th><th>Audience fit</th><th>Eng. quality</th><th>Composite</th><th className="tl">Status</th></tr></thead><tbody>
      {candidates.map((c,i) => {
        const color = TIER_COLOR[c.tier] || '#7b7b87';
        return (<tr key={i}>
          <td><span className="pill" style={{background:color+'22',color:color,fontSize:10,padding:'2px 8px',borderRadius:4,fontWeight:700,textTransform:'uppercase'}}>{c.tier}</span></td>
          <td className="tl" style={{fontSize:11.5}}><code>{c.handle}</code></td>
          <td className="tl" style={{fontSize:11,maxWidth:280}}>
            <b>{c.name}</b>
            <div className="muted" style={{fontSize:10,marginTop:2}}>{(c.themes||[]).join(' · ')}</div>
            {(c.brand_partnerships_known||[]).length>0 && <div className="muted" style={{fontSize:10,marginTop:2}}>Past: {(c.brand_partnerships_known||[]).join(', ')}</div>}
          </td>
          <td>{c.audience_size_estimated ? (c.audience_size_estimated/1000).toFixed(0)+'k' : '—'}<br/><span className="muted" style={{fontSize:9}}>{c.audience_size_confidence} conf.</span></td>
          <td>{PCT(c.brand_fit)}</td>
          <td>{PCT(c.audience_fit)}</td>
          <td>{PCT(c.engagement_quality)}</td>
          <td><b style={{color:color}}>{PCT(c.composite)}</b></td>
          <td className="tl"><span className="pill grey" style={{fontSize:10}}>{c.status}</span></td>
        </tr>);
      })}
      </tbody></table>
    </div>
    <div className="row">
      <div className="card" style={{flex:'1 1 360px'}}>
        <h2>Top reasoning notes</h2>
        <div className="muted" style={{marginBottom:8,fontSize:11}}>Why each hero/core candidate ranks where they do. Click handle in table above for details.</div>
        <div style={{display:'flex',flexDirection:'column',gap:10,maxHeight:520,overflowY:'auto'}}>
        {(C.candidates||[]).filter(c=>c.tier==='hero'||c.tier==='core').slice(0,12).map((c,i)=>(<div key={i} style={{padding:10,background:'var(--bg-app)',borderLeft:`3px solid ${TIER_COLOR[c.tier]}`,borderRadius:'0 6px 6px 0',fontSize:11.5}}>
          <div style={{fontWeight:600,marginBottom:4}}>{c.name} <span className="muted" style={{fontWeight:400}}>({c.handle})</span></div>
          <div style={{color:'#b6b6c0',lineHeight:1.45}}>{c.reasoning}</div>
          {(c.verify_next||[]).length>0 && <div style={{marginTop:6,fontSize:10,color:'#7b7b87'}}><b>Verify next:</b> {c.verify_next.join(' · ')}</div>}
        </div>))}
        </div>
      </div>
      <div className="card" style={{flex:'1 1 280px'}}>
        <h2>How to use this</h2>
        <div style={{fontSize:12.5,lineHeight:1.6,color:'var(--text-secondary)'}}>
          <p><b>Scores are inferred not measured.</b> They reflect what LLM reasoning can extract from public web signals — past partnerships, audience age cues, content themes, engagement signals quoted in articles.</p>
          <p><b>Before outreaching at scale</b>, verify with a real creator-discovery tool (Heepsy £69/mo or Modash £150+/mo). Look for: actual follower count, UK audience %, age split, engagement rate, brand-overlap with frkl peers.</p>
          <p><b>The highest-EV move</b> isn't in any external creator — it's an internal audit of <code>#myfrkl</code> tagged users. These are existing customers who already buy frkl AND have audiences. Brief Lux to pull that list.</p>
          <p><b>To add a new candidate:</b> edit <code>creator_candidates.json</code> and re-run <code>python scripts/build_creators_data.py</code>. Status field tracks: prospect → contacted → active → declined.</p>
        </div>
      </div>
    </div>
  </div>);
}

function AffiliatePanel(){
  const affs = (window.FRKL_BUSINESS||{}).affiliates || [];
  const summary = (window.FRKL_BUSINESS||{}).discountSummary || {};
  if (!affs.length) return null;
  const aff = summary.affiliate || {};
  const camp = summary.campaign || {};
  const cs = summary.cs_adjustment || {};
  const totalAffRev = aff.netSales || 0;
  const topAff = affs[0];
  const topShare = totalAffRev ? topAff.netSales / totalAffRev : 0;
  // DTC total = aff + campaign + no_code
  const noCode = summary.no_code || {};
  const dtcTotal = (aff.netSales||0) + (camp.netSales||0) + (noCode.netSales||0);
  const affShareDTC = dtcTotal ? totalAffRev / dtcTotal : 0;
  return (<div style={{marginTop:14}}>
    <div className="card" style={{marginBottom:14, borderLeft:'3px solid #4ade80'}}>
      <h2>Affiliates & creator partnerships — 90d</h2>
      <div className="muted" style={{marginBottom:10,fontSize:12}}>Tracked via Shopify discount-code attribution. Edit the code → creator mapping in <code>scripts/_affiliate_codes.txt</code>.</div>
      <div className="row" style={{marginBottom:8}}>
        <KPI label="Affiliate revenue (90d)" val={GBP(totalAffRev)} sub={`${PCT(affShareDTC)} of DTC revenue · ${aff.orders||0} orders · AOV £${aff.avgAov||0}`}
          agent="Scout" observation={`Creator partnerships drive ${PCT(affShareDTC)} of revenue — significantly higher per-order than paid acquisition.`}
          implication="This is the most efficient acquisition channel in the business. Double down on top performers, replicate format with lookalikes." />
        <KPI label="Top affiliate" val={topAff.code} sub={`${topAff.orders} orders · ${GBP(topAff.netSales)} · ${PCT(topShare)} of affiliate rev`}
          agent="Lux" observation={`${topAff.label} is the single biggest revenue driver — ${PCT(topShare)} concentration is a risk if the relationship cools.`}
          implication="Lock in long-term commercials. Brief a like-for-like discovery search to reduce single-creator dependency." />
        <KPI label="Affiliate avg discount" val={PCT(aff.discountPct)} sub={`vs ${PCT(camp.discountPct)} for promo campaigns`}
          agent="Atlas" observation={`Affiliates cost ~${Math.round((aff.discountPct||0)*100)}% off list vs ${Math.round((camp.discountPct||0)*100)}% for blanket promos. Cheaper acquisition, higher AOV.`}
          implication="Shift incremental budget from promo campaigns toward creator commercials. Better unit economics." />
        <KPI label="Gifting & CS adjustments" val={cs.orders||0} sub={`${cs.codeCount||0} codes · £${NUM(cs.discounts)} retail value of comped product`}
          agent="Lux" observation="Operational comps (gifting, replacements, lost-in-transit) total £10k+ in product value over 90d. Tracked but not in DTC revenue."
          implication="Worth quarterly review with ops — is the gifting budget converting to UGC / press / repurchase? Currently no attribution loop." />
      </div>
    </div>
    <div className="row">
      <div className="card" style={{flex:'2 1 520px'}}>
        <h2>Affiliate league table</h2>
        <table><thead><tr><th>Code</th><th>Creator</th><th>Orders</th><th>Net rev</th><th>AOV</th><th>Discount %</th><th>£ given/order</th></tr></thead><tbody>
        {affs.map((a,i)=>{
          const tier = a.netSales > 5000 ? 'hero' : a.netSales > 1000 ? 'core' : a.netSales > 200 ? 'mid' : 'long-tail';
          const tierColor = {hero:'#4ade80',core:'#5b8def',mid:'#fbbf24','long-tail':'#7b7b87'}[tier];
          return (<tr key={i}>
            <td><span className="pill" style={{background:tierColor+'22',color:tierColor,fontSize:10,padding:'2px 6px',borderRadius:4,fontWeight:700}}>{a.code}</span></td>
            <td style={{fontSize:12,maxWidth:200}}>{a.label}{a.notes && <div className="muted" style={{fontSize:10}}>{a.notes}</div>}</td>
            <td><b>{a.orders}</b></td>
            <td><b>{GBP(a.netSales)}</b></td>
            <td style={{color: a.aov>80?'#4ade80':a.aov>50?'#fbbf24':'#7b7b87'}}>{GBP(a.aov)}</td>
            <td>{PCT(a.discountPct)}</td>
            <td>{GBP(a.avgDiscountGivenPerOrder)}</td>
          </tr>);
        })}
        </tbody></table>
      </div>
      <div className="card" style={{flex:'1 1 300px'}}>
        <h2>Code categories</h2>
        <table><thead><tr><th>Category</th><th>Codes</th><th>Orders</th><th>Net rev</th><th>AOV</th></tr></thead><tbody>
        {Object.entries(summary).filter(([_,s])=>s.orders>0).sort((a,b)=>(b[1].netSales||0)-(a[1].netSales||0)).map(([cat,s],i)=>{
          const LABELS = {affiliate:'Affiliate creators',campaign:'Promo campaigns',cs_adjustment:'Gifting / CS',auto_generated:'Auto-generated',bundle_ref:'Bundle ref',no_code:'No code',unclassified:'Unclassified'};
          const COLORS = {affiliate:'#4ade80',campaign:'#fbbf24',cs_adjustment:'#c084fc',no_code:'#7b7b87',auto_generated:'#94a3b8',unclassified:'#f87171'};
          return (<tr key={i}>
            <td><span className="pill" style={{background:(COLORS[cat]||'#7b7b87')+'22',color:COLORS[cat]||'#7b7b87',fontSize:10,padding:'2px 6px',borderRadius:4,fontWeight:600}}>{LABELS[cat]||cat}</span></td>
            <td>{s.codeCount}</td>
            <td>{s.orders}</td>
            <td>{GBP(s.netSales)}</td>
            <td>{GBP(s.avgAov)}</td>
          </tr>);
        })}
        </tbody></table>
      </div>
    </div>
    <div className="note" style={{marginTop:14}}><b>Scout's read:</b> Creator partnerships are doing more work than the data has been crediting them for. HEYGIRL (Angela Scanlon) is genuinely the biggest single attribution lever you have — that's <b>one quarter of revenue from one relationship</b>. Diversification candidates: brief a discovery search for UK creators in the 35-54 lifestyle/jewellery space with engagement rates above 4% (matching Angela's audience profile). The other named affiliates (GMS, Boldly, Davidson, Nora, Charissa) all have signal but tiny volume — worth a deeper conversation per creator about content cadence and commercial terms.</div>
  </div>);
}

const SITE_STEPS = [
  {step:'Homepage', live:'Promo "10% off" popup interrupts on load; announcement bar (free UK delivery over £75); clear nav (necklaces/charms/bracelets/earrings, gifting).', issue:'Cookie banner + popup consume the first interaction. 50.8% of visitors drop between 10–15% scroll — most never see past the hero. 1.07 pages/session.', sev:'red'},
  {step:'Collection (PLP)', live:'Filters (type/price/availability), "worth £X" bundle-saving badges, 106 products, build-system style labels.', issue:'Out-of-stock products sit in prime grid slots → dead-end clicks. 80–85% scroll cliff where the grid ends. Mobile filter/pagination friction.', sev:'amber'},
  {step:'Product (PDP)', live:'Gallery + lifestyle shots, Clearpay BNPL, reviews, variant swatches, Shop Pay express, 90-day returns & free-ship badges.', issue:'Judge.me review widget throws JS errors → elements look clickable but do nothing (dead/rage clicks).', sev:'amber'},
  {step:'Cart drawer', live:'Free-shipping progress bar, cross-sell add-ons (charm £25, notebook £12), qty stepper, coupon field, Checkout CTA.', issue:'Coupon-code field throws JS errors when codes are applied — a prime suspect for the 67.8% ATC→checkout drop (people hunt for a code, it fails, they leave).', sev:'red'},
  {step:'Checkout', live:'Standard Shopify checkout. Express: Shop Pay + Google Pay. Discount field, taxes shown.', issue:'No Apple Pay express button — a real gap for an iOS-heavy female audience. 90% of checkout-starters still abandon (vs 50–60% benchmark).', sev:'red'},
];
const CLARITY = [
  {m:'Begin-checkout rate', v:'1.10%', bench:'4–6%', sev:'red'},
  {m:'Checkout-complete rate', v:'0.11%', bench:'1–3%', sev:'red'},
  {m:'Avg scroll depth', v:'38.3%', bench:'50–60%', sev:'red'},
  {m:'Rage-click rate', v:'0.03%', bench:'<3%', sev:'green'},
  {m:'Dead-click rate', v:'2.0%', bench:'<8%', sev:'green'},
  {m:'Quick-back rate', v:'1.08%', bench:'<20%', sev:'green'},
];
const FIXES = [
  {fix:'Suppress the 10% popup on first visit (show on exit-intent / after 30s); fix its dismiss handler', p:'P1'},
  {fix:'Fix the cart coupon-code JS error (kills the ATC→checkout step)', p:'P1'},
  {fix:'Remove out-of-stock products from collection grids', p:'P1'},
  {fix:'Fix Judge.me JS errors on PDPs', p:'P1'},
  {fix:'Move cookie consent to a non-blocking bottom bar', p:'P1'},
  {fix:'Add Apple Pay to express checkout', p:'P2'},
  {fix:'Rework hero to a value prop + product CTA above the 15% scroll cliff', p:'P2'},
];
const B = window.FRKL_BUSINESS || {};

function Customers(){
  const ret=B.returning||[]; const months=B.retentionByMonth||[]; const geo=B.geo||[]; const list=B.listGrowth||[];
  const totalNew=ret.filter(r=>r.isReturning==='false').reduce((a,r)=>a+(r.orders||0),0);
  const totalRet=ret.filter(r=>r.isReturning==='true').reduce((a,r)=>a+(r.orders||0),0);
  const totalNewRev=ret.filter(r=>r.isReturning==='false').reduce((a,r)=>a+(r.netSales||0),0);
  const totalRetRev=ret.filter(r=>r.isReturning==='true').reduce((a,r)=>a+(r.netSales||0),0);
  const subsTotal=list.reduce((a,r)=>a+(r.subscribed||0),0);
  const unsubsTotal=list.reduce((a,r)=>a+(r.unsubscribed||0),0);
  // chart data: returning share per week
  const byWeek={};
  ret.forEach(r=>{ const d=new Date(r.date+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()-d.getUTCDay()); const w=d.toISOString().slice(0,10); byWeek[w]=byWeek[w]||{week:w,new:0,ret:0,newRev:0,retRev:0}; if(r.isReturning==='true'){ byWeek[w].ret+=r.orders||0; byWeek[w].retRev+=r.netSales||0; } else { byWeek[w].new+=r.orders||0; byWeek[w].newRev+=r.netSales||0; } });
  const weeks=Object.values(byWeek).sort((a,b)=>a.week<b.week?-1:1).map(w=>({...w, retPct:w.ret/Math.max(1,w.ret+w.new)*100, retRevPct:w.retRev/Math.max(1,w.retRev+w.newRev)*100, label:w.week.slice(5)}));
  // list growth chart
  const listChart=list.map(r=>({date:r.date.slice(5), net:(r.subscribed||0)-(r.unsubscribed||0)}));
  // Hover-graph trends.
  const retPctSeries    = weeks.map(w=>({d:w.label, v:+w.retPct.toFixed(1)}));
  const retRevPctSeries = weeks.map(w=>({d:w.label, v:+w.retRevPct.toFixed(1)}));
  const listNetSeries   = listChart.map(r=>({d:r.date, v:r.net}));
  return (<div>
    <RetentionPanel/>
    <div className="row" style={{marginBottom:14}}>
      <KPI label="% orders from returning" val={PCT((totalRet)/(totalNew+totalRet))} sub={`${NUM(totalRet)} returning / ${NUM(totalNew)} new (90d)`} series={retPctSeries} seriesLabel="Returning order share · by week"
        agent="Lux" observation="38.7% repeat is healthier than Clarity's 95% new-visitor stat suggested — buyers ARE coming back."
        implication="The repeat customer is real but undermonetised — post-purchase + restyle flows would lift LTV materially." />
      <KPI label="Returning revenue share" val={PCT((totalRetRev)/(totalNewRev+totalRetRev))} sub={`£${NUM(totalRetRev)} of £${NUM(totalNewRev+totalRetRev)}`} series={retRevPctSeries} seriesLabel="Returning revenue share · by week"
        agent="Atlas" observation="29.6% of revenue from returning customers comes with zero acquisition cost — highest-margin slice."
        implication="Every £1 of retention spend likely returns more than every £1 of paid acquisition right now." />
      <KPI label="Net list growth (90d)" val={'+'+NUM(subsTotal-unsubsTotal)} sub={`${NUM(subsTotal)} new − ${NUM(unsubsTotal)} unsub`} series={listNetSeries} seriesLabel="Net list growth · by day"
        agent="Sage" observation="~26 new subs/day with <5 unsubs — acquisition is filling the funnel cleanly."
        implication="The list is healthy; the gap is monetisation — abandoned-cart + welcome series are the levers, not more sign-ups." />
      <KPI label="Markets" val={geo.length+'+'} sub={`UK ${PCT(geo[0]?.netSales/geo.reduce((a,b)=>a+b.netSales,0))} · IE ${PCT((geo[1]?.netSales||0)/geo.reduce((a,b)=>a+b.netSales,0))}`}
        agent="Scout" observation={OI_BRAND.slug==='frkl' ? "UK 66% / Ireland 30% — Ireland is genuinely a second home market, and AOV is £6 higher there." : undefined}
        implication={OI_BRAND.slug==='frkl' ? "An IE-specific creative + landing test could capitalise on the higher-AOV behaviour you're already seeing." : undefined} />
    </div>
    <div className="card" style={{marginBottom:14}}>
      <h2>New vs returning orders — weekly</h2>
      <R.ResponsiveContainer width="100%" height={250}>
        <R.ComposedChart data={weeks} margin={{top:6,right:8,left:14,bottom:20}}>
          <R.CartesianGrid stroke="#222229" vertical={false} />
          <R.XAxis dataKey="label" tick={{fill:'#6f6f7b',fontSize:11}} label={{value:'Week', position:'insideBottom', offset:-8, fill:'#6f6f7b', fontSize:11}} />
          <R.YAxis yAxisId="l" tick={{fill:'#6f6f7b',fontSize:11}} label={{value:'Orders', angle:-90, position:'insideLeft', style:{textAnchor:'middle'}, fill:'#6f6f7b', fontSize:11}} />
          <R.YAxis yAxisId="r" orientation="right" tick={{fill:'#6f6f7b',fontSize:11}} tickFormatter={v=>v+'%'} domain={[0,80]} label={{value:'% returning', angle:90, position:'insideRight', style:{textAnchor:'middle'}, fill:'#6f6f7b', fontSize:11}} />
          <R.Tooltip contentStyle={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:10}} />
          <R.Legend verticalAlign="top" align="center" wrapperStyle={{fontSize:12, paddingBottom:8}} />
          <R.Bar yAxisId="l" dataKey="new" stackId="o" name="New" fill={COL.sessions} />
          <R.Bar yAxisId="l" dataKey="ret" stackId="o" name="Returning" fill={COL.revenue} />
          <R.Line yAxisId="r" type="monotone" dataKey="retPct" name="% returning" stroke={COL.email} strokeWidth={2} dot={false} />
        </R.ComposedChart>
      </R.ResponsiveContainer>
    </div>
    <ConfigurableChart
      title="Explore markets — Shopify settlement"
      dataset={(geo||[]).map(g=>({country:g.country||'(unknown)', region:/kingdom|^uk$|^gb$/i.test(g.country||'')?'UK':/ireland|^ie$/i.test(g.country||'')?'Ireland':'Rest of world', revenue:g.netSales||0, orders:g.orders||0}))}
      dimensions={[{key:'country',label:'Country'},{key:'region',label:'Region (UK/IE/RoW)'}]}
      metrics={[{key:'revenue',label:'Net revenue',fmt:GBP},{key:'orders',label:'Orders',fmt:NUM}]}
      defaultMetric="revenue" defaultSplit="country" defaultChart="bar" defaultTopN={10}/>
    <div className="row">
      <div className="card" style={{flex:'1 1 360px'}}>
        <h2>Markets — top 10</h2>
        <table><thead><tr><th>Country</th><th>Orders</th><th>Net rev</th><th>AOV</th></tr></thead><tbody>
        {geo.map((g,i)=>(<tr key={i}><td>{g.country||'(unknown)'}</td><td>{NUM(g.orders)}</td><td>{GBP(g.netSales)}</td><td>{GBP(g.aov)}</td></tr>))}
        </tbody></table>
      </div>
      <div className="card" style={{flex:'1 1 360px'}}>
        <h2>Klaviyo list — daily net growth</h2>
        <R.ResponsiveContainer width="100%" height={200}>
          <R.BarChart data={listChart} margin={{top:6,right:8,left:14,bottom:18}}>
            <R.CartesianGrid stroke="#222229" vertical={false} />
            <R.XAxis dataKey="date" tick={{fill:'#6f6f7b',fontSize:10}} interval={Math.ceil(listChart.length/10)} label={{value:'Date', position:'insideBottom', offset:-6, fill:'#6f6f7b', fontSize:10}} />
            <R.YAxis tick={{fill:'#6f6f7b',fontSize:10}} label={{value:'Net subs', angle:-90, position:'insideLeft', style:{textAnchor:'middle'}, fill:'#6f6f7b', fontSize:10}} />
            <R.Tooltip contentStyle={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:10}} />
            <R.Bar dataKey="net" fill={COL.email} />
          </R.BarChart>
        </R.ResponsiveContainer>
      </div>
    </div>
    {OI_BRAND.slug==='frkl' && <div className="note" style={{marginTop:14}}>The big spike of returning customers <b>late April</b> (Apr 22–28) is the cohort responding to Meta re-scaling on Apr 13 — and the email flow firing on that traffic. Ireland's AOV (£71) is meaningfully higher than the UK's (£65). The list is net-positive every single day — Klaviyo has product-market fit for acquisition; the gap is monetisation of the list with proper attributed reporting.</div>}
  </div>);
}

function BundlesPanel(){
  const summary = (B.productSummary||{});
  const bundles = B.bundles || [];
  if (!bundles.length) return null;
  const singles = summary.singles || {};
  const bundlesAgg = summary.bundles || {};
  const wrapperRows = bundles.filter(b => (b.title||'').toLowerCase().includes('(bundle for reference only)'));
  const explicitRows = bundles.filter(b => !((b.title||'').toLowerCase().includes('(bundle for reference only)')));
  const aovLift = (singles.aovPerUnit && bundlesAgg.aovPerUnit)
    ? ((bundlesAgg.aovPerUnit / singles.aovPerUnit) - 1) : null;
  return (<div className="card" style={{marginBottom:14, borderLeft:'3px solid #c084fc'}}>
    <h2>Bundles & stacks — 90d</h2>
    {DEMO && <div className="muted" style={{marginBottom:10, fontSize:12}}>frkl's "stack" products are pre-styled bundles (base + style + charm). They unlock higher AOV but currently sell rarely. Two bundle tracking systems exist in Shopify: explicit "stack" SKUs and a hidden "Bundle for reference only" wrapper — both surfaced below.</div>}
    <div className="row" style={{marginBottom:10}}>
      <KPI label="Bundle revenue share" val={PCT(summary.bundleRevenueShare)} sub={`£${NUM(bundlesAgg.netSales)} of £${NUM((singles.netSales||0)+(bundlesAgg.netSales||0)+(summary.giftCards?.netSales||0))} total products`}
        agent="Atlas" observation={`Bundles are only ${PCT(summary.bundleRevenueShare)} of product revenue. This is the single biggest AOV lever sitting unused.`}
        implication="Brief Lux + Frame on a bundle merchandising push: stack-builder UX, social proof, gifting positioning. Worth pulling forward in Q3 plan." />
      <KPI label="Bundle attach rate" val={PCT(summary.bundleAttachRate)} sub={`${bundlesAgg.units} bundle units of ${(singles.units||0)+(bundlesAgg.units||0)} total`}
        agent="Lux" observation="Less than 1% of customers buy a pre-styled stack. Either discovery's broken (no PDP cross-sell?) or the price gap to à la carte isn't compelling."
        implication="Test a 'complete the stack' upsell on every PDP. Test a £10 bundle saving banner. Track delta in Site CVR." />
      <KPI label="Avg bundle price (per unit)" val={GBP(bundlesAgg.aovPerUnit)} sub={aovLift != null ? `${(aovLift*100).toFixed(0)}% vs single AOV £${NUM(singles.aovPerUnit)}` : '—'}
        agent="Frame" observation={aovLift > 0 ? `Bundle AOV per unit is ${(aovLift*100).toFixed(0)}% higher than singles. Each stack sale = one customer behaving like ${(1+aovLift).toFixed(1)} customers.` : 'Bundle pricing not yet outperforming singles — pricing strategy worth reviewing.'}
        implication="Frame bundles to investor materials as the AOV play. Each percentage point of bundle attach rate moves blended AOV measurably." />
      <KPI label="Bundle margin %" val={PCT(bundlesAgg.marginPct)} sub={`100% reflects missing bundle COGS in Shopify — true margin is component-weighted`}
        agent="Atlas" observation="COGS isn't tracked per bundle SKU in Shopify, so the margin figure here is artificial. Real bundle margin should match (or exceed) the weighted-average margin of its components."
        implication="One-off fix: add COGS to each bundle parent SKU in Shopify. ~30 min job, makes this number trustworthy." />
    </div>
    <div className="row">
      <div className="card" style={{flex:'2 1 460px'}}>
        <h2>Explicit stack SKUs sold (last 90d)</h2>
        <div className="muted" style={{marginBottom:8, fontSize:12}}>Each row = a stack product set up as its own SKU. Sold as one purchase.</div>
        {explicitRows.length ? (<table><thead><tr><th>Type</th><th className="tl">Title</th><th>Units</th><th>Net rev</th><th>AOV</th><th>Returns</th></tr></thead><tbody>
        {explicitRows.map((b,i)=>(<tr key={i}>
          <td><span className="pill" style={{background:'#c084fc22',color:'#c084fc',fontSize:10,padding:'2px 6px',borderRadius:4,fontWeight:600}}>{b.type}</span></td>
          <td className="tl" style={{fontSize:12, maxWidth:280}}>{b.image && <img src={b.image} style={{width:22,height:22,borderRadius:4,verticalAlign:'middle',marginRight:8,objectFit:'cover'}} onError={e=>{e.target.style.opacity=.2;}}/>}{b.title}</td>
          <td>{b.units}</td>
          <td>{GBP(b.netSales)}</td>
          <td>{GBP(b.units ? b.netSales/b.units : null)}</td>
          <td>{b.returns}</td>
        </tr>))}
        </tbody></table>) : (<div className="muted">No explicit stack SKUs sold in this window.</div>)}
      </div>
      <div className="card" style={{flex:'1 1 280px'}}>
        <h2>Bundle wrappers (Shopify-native)</h2>
        <div className="muted" style={{marginBottom:8, fontSize:12}}>"Bundle for reference only" entries record the purchase event without splitting line items. Revenue is recorded on component SKUs.</div>
        {wrapperRows.length ? (<ul style={{margin:0,padding:'0 0 0 18px',fontSize:12,lineHeight:1.7}}>
          {wrapperRows.map((b,i)=>(<li key={i}>{(b.title||'').replace(' (Bundle for reference only)','')} — <b>{b.units} purchase{b.units===1?'':'s'}</b></li>))}
        </ul>) : (<div className="muted">No Shopify-native bundle wrappers in this window.</div>)}
      </div>
    </div>
    <div className="note" style={{marginTop:14}}><b>Strategic read:</b> bundles are a tiny share of revenue (1.9%) at a high relative AOV. If you can move bundle attach from ~0.8% to ~5%, blended AOV would lift by roughly 2-4% with no extra ad spend. The Klaviyo data already showed Pre-styled stacks have their own welcome flow — that audience is the natural place to test a stack-builder PDP module first.</div>
  </div>);
}

function InventoryPanel(){
  const inv = B.inventory || [];
  const summary = B.inventorySummary || {};
  if (!inv.length) return null;
  const [tierFilter, setTierFilter] = useState('actionable');
  const TIER_COLOR = {critical:'#f87171', low:'#fbbf24', healthy:'#4ade80', high:'#94a3b8', overstock:'#c084fc', archived_stock:'#7b7b87', no_stock_no_sales:'#3a3a44'};
  const TIER_LABEL = {critical:'CRITICAL <14d',low:'LOW <30d',healthy:'HEALTHY 30-90d',high:'HIGH 90-180d',overstock:'OVERSTOCK >180d',archived_stock:'ARCHIVED (dead)',no_stock_no_sales:'NO STOCK / NO SALES'};
  const filtered = tierFilter === 'all' ? inv :
                   tierFilter === 'actionable' ? inv.filter(r => r.coverTier === 'critical' || r.coverTier === 'low' || r.coverTier === 'overstock' || r.coverTier === 'archived_stock') :
                   inv.filter(r => r.coverTier === tierFilter);
  const sorted = [...filtered].sort((a,b) => {
    // critical first, then by units90d desc; overstock by inv value desc
    const order = {critical:0, low:1, no_stock_no_sales:2, overstock:3, archived_stock:4, high:5, healthy:6};
    const ao = order[a.coverTier] ?? 9, bo = order[b.coverTier] ?? 9;
    if (ao !== bo) return ao - bo;
    if (a.coverTier === 'overstock' || a.coverTier === 'archived_stock') return (b.inventoryValue||0) - (a.inventoryValue||0);
    return (b.units90d||0) - (a.units90d||0);
  });

  // Crit + low: estimate lost-sales £/mo at current velocity if stock-out happens
  const critRows = inv.filter(r => r.coverTier === 'critical');
  const lostSalesEstMonthly = critRows.reduce((acc, r) => acc + (r.units90d / 90) * 30 * 7, 0);  // assume £7 charm avg
  const overstockValue = (summary.overstock || {}).totalValue || 0;
  const archivedValue = (summary.archived_stock || {}).totalValue || 0;
  return (<div className="card" style={{marginBottom:14, borderLeft:'3px solid #fbbf24'}}>
    <h2>Inventory + stock cover (DTC velocity)</h2>
    <div className="muted" style={{marginBottom:10, fontSize:12}}>
      Days of cover = inventory ÷ daily 90-day velocity. Joined SKU-level via Shopify ProductNoTimeDimensions. <b>Capital tied up in &gt;180d cover SKUs is dead-money risk.</b>
    </div>
    <div className="row" style={{marginBottom:10}}>
      <div className="card kpi" style={{borderLeft:'3px solid #f87171'}}>
        <div className="label">Critical / out of stock</div>
        <div className="val">{(summary.critical||{}).skus||0}</div>
        <div className="sub">{(summary.critical||{}).totalQty||0} units left · running out in &lt;14 days</div>
      </div>
      <div className="card kpi" style={{borderLeft:'3px solid #fbbf24'}}>
        <div className="label">Healthy cover (30-90d)</div>
        <div className="val">{(summary.healthy||{}).skus||0}</div>
        <div className="sub">{(summary.healthy||{}).totalQty||0} units · £{NUM((summary.healthy||{}).totalValue)} on shelf</div>
      </div>
      <div className="card kpi" style={{borderLeft:'3px solid #c084fc'}}>
        <div className="label">Overstock (&gt;180d)</div>
        <div className="val">{(summary.overstock||{}).skus||0}</div>
        <div className="sub">{(summary.overstock||{}).totalQty||0} units · <b>£{NUM(overstockValue)} tied up</b></div>
      </div>
      <div className="card kpi" style={{borderLeft:'3px solid #7b7b87'}}>
        <div className="label">Archived (dead stock)</div>
        <div className="val">{(summary.archived_stock||{}).skus||0}</div>
        <div className="sub">{(summary.archived_stock||{}).totalQty||0} units · <b>£{NUM(archivedValue)}</b> at sell-value</div>
      </div>
    </div>
    <div style={{display:'flex',gap:10,alignItems:'center',marginBottom:10,flexWrap:'wrap'}}>
      <span className="muted" style={{fontSize:11,textTransform:'uppercase',letterSpacing:.05,fontWeight:700}}>FILTER</span>
      <select value={tierFilter} onChange={e=>setTierFilter(e.target.value)} style={{background:'var(--bg-input)',color:'var(--text-primary)',border:'1px solid var(--border-default)',borderRadius:4,padding:'4px 8px',fontSize:12}}>
        <option value="actionable">Actionable (critical + low + overstock + archived)</option>
        <option value="all">All tiers</option>
        <option value="critical">Critical only (&lt;14d)</option>
        <option value="low">Low (&lt;30d)</option>
        <option value="healthy">Healthy (30-90d)</option>
        <option value="high">High (90-180d)</option>
        <option value="overstock">Overstock (&gt;180d)</option>
        <option value="archived_stock">Archived</option>
      </select>
      <span className="muted" style={{marginLeft:'auto',fontSize:11}}>{sorted.length} of {inv.length} SKUs</span>
    </div>
    <div style={{maxHeight:560,overflowY:'auto'}}>
      <table className="sticky"><thead><tr><th>Tier</th><th className="tl">SKU / title</th><th className="tl">Type</th><th>Stock</th><th>Sold 90d</th><th>Days cover</th><th>Inv £ value</th></tr></thead><tbody>
      {sorted.slice(0,80).map((r,i) => {
        const color = TIER_COLOR[r.coverTier] || '#7b7b87';
        return (<tr key={i}>
          <td><span className="pill" style={{background:color+'22',color:color,fontSize:10,padding:'2px 6px',borderRadius:4,fontWeight:700,whiteSpace:'nowrap'}}>{TIER_LABEL[r.coverTier]||r.coverTier}</span></td>
          <td className="tl" style={{fontSize:11,maxWidth:280}}>
            <b>{r.title}</b>
            {r.sku && <div className="muted" style={{fontSize:10}}><code>{r.sku}</code></div>}
          </td>
          <td className="muted tl" style={{fontSize:11}}>{r.type||'—'}</td>
          <td><b>{r.inventoryQty}</b></td>
          <td>{r.units90d}</td>
          <td>{r.daysOfCover === null ? '∞' : r.daysOfCover === 999 ? '∞' : r.daysOfCover + 'd'}</td>
          <td>£{NUM(r.inventoryValue)}</td>
        </tr>);
      })}
      </tbody></table>
    </div>
    {sorted.length > 80 && <div className="muted" style={{fontSize:11,marginTop:8}}>Showing 80 of {sorted.length}. Adjust filter to drill in.</div>}
    {DEMO && <div className="note" style={{marginTop:14}}><b>Atlas read:</b> {critRows.length} SKUs are about to stock out — at current velocity that's roughly £{NUM(lostSalesEstMonthly)}/mo in lost sales if reorders don't land. Meanwhile <b>£{NUM(overstockValue + archivedValue)} of capital is locked in slow-moving stock + archived SKUs</b>. For a brand at £16k/mo DTC revenue, that's ~18 months of working capital tied up. Most of the overstock is in <b>pre-styled stack SKUs</b> — connects directly to the Bundle attach finding (Products tab): bundles aren't selling, so the bundle-specific inventory is bloating. Liquidate the dead bundles + redirect capital to charm + necklace replenishment.</div>}
  </div>);
}

function CollectionsPanel(){
  const cols = B.productCollections || [];
  if (!cols.length) return null;
  const COLOR = {'Necklaces':'#5b8def','Bracelets':'#c084fc','Earrings':'#4ade80','Charms':'#fbbf24','Accessories':'#38bdf8','Gift cards':'#94a3b8'};
  const top = cols[0];
  const tinyCollections = cols.filter(c => c.skus <= 2 && c.netSales > 50);
  return (<div className="card" style={{marginBottom:14, borderLeft:'3px solid #38bdf8'}}>
    <h2>Collections — revenue by product category (90d)</h2>
    <div className="muted" style={{marginBottom:10, fontSize:12}}>Buyer-facing category roll-up. Click any collection's top SKUs to find drilldown candidates. Bundles are surfaced separately above.</div>
    <table><thead><tr><th>Collection</th><th>SKUs</th><th>Units</th><th>Net rev</th><th>% rev</th><th>AOV/unit</th><th>Margin</th><th>Return</th><th className="tl">Top SKUs</th></tr></thead><tbody>
    {cols.map((c,i)=>{
      const color = COLOR[c.collection] || '#7b7b87';
      return (<tr key={i}>
        <td><span className="pill" style={{background:color+'22',color:color,fontSize:11,padding:'3px 8px',borderRadius:4,fontWeight:700}}>{c.collection}</span></td>
        <td><b>{c.skus}</b>{c.skus<=2&&<span className="muted" style={{fontSize:10,marginLeft:4}}>thin range</span>}</td>
        <td>{NUM(c.units)}</td>
        <td><b>{GBP(c.netSales)}</b></td>
        <td>{PCT(c.revenueShare)}</td>
        <td>{GBP(c.aovPerUnit)}</td>
        <td style={{color:c.marginPct>=0.8?'var(--good)':c.marginPct>=0.6?'var(--warn)':'var(--bad)',fontWeight:600}}>{PCT(c.marginPct)}</td>
        <td style={{color:c.returnRate>=0.1?'var(--bad)':c.returnRate>=0.06?'var(--warn)':'var(--text-faint)',fontWeight:600}}>{PCT(c.returnRate)}</td>
        <td className="muted tl" style={{fontSize:11,maxWidth:240}}>{(c.topSkus||[]).map(s=>s.title?.slice(0,28)).join(' · ')}</td>
      </tr>);
    })}
    </tbody></table>
    <div className="note" style={{marginTop:14}}><b>Collection read:</b> {top.collection} drive {PCT(top.revenueShare)} of product revenue ({top.skus} SKUs, AOV £{Math.round(top.aovPerUnit||0)}). {tinyCollections.length > 0 ? `${tinyCollections.length} collection${tinyCollections.length>1?'s':''} have only 1-2 active SKUs (${tinyCollections.map(c=>c.collection).join(', ')}) — long-tail expansion candidates worth a Frame brief.` : ''} The Necklaces + Charms combination is 85% of revenue — the modular system working as designed.</div>
  </div>);
}

function ProductTiersPanel(){
  const tiers = B.productTiers || [];
  if (!tiers.length) return null;
  const colors = {base:'#5b8def', charm:'#fbbf24', style:'#4ade80'};
  const labels = {base:'01: Base', charm:'02: Charm', style:'03: Style'};
  const total = tiers.reduce((a,t)=>a+(t.netSales||0),0);
  return (<div className="card" style={{marginBottom:14, borderLeft:'3px solid #5b8def'}}>
    <h2>Component tiers — base / charm / style</h2>
    {DEMO && <div className="muted" style={{marginBottom:10, fontSize:12}}>frkl's modular system uses three tiers, encoded in the Shopify vendor field. A customer buys a base, layers a style, attaches charms — every charm raises AOV, every style raises margin.</div>}
    <table><thead><tr><th>Tier</th><th>SKUs</th><th>Units</th><th>Net revenue</th><th>% of rev</th><th>AOV / unit</th><th>Margin %</th><th>Return %</th></tr></thead><tbody>
      {tiers.map((t,i)=>(<tr key={i}>
        <td><span className="pill" style={{background:colors[t.tier]+'22',color:colors[t.tier],fontSize:11,padding:'2px 8px',borderRadius:4,fontWeight:700,textTransform:'uppercase'}}>{labels[t.tier]||t.tier}</span></td>
        <td>{t.skus}</td>
        <td>{NUM(t.units)}</td>
        <td><b>{GBP(t.netSales)}</b></td>
        <td>{PCT(t.netSales/total)}</td>
        <td>{GBP(t.aovPerUnit)}</td>
        <td style={{color:t.marginPct>=0.8?'var(--good)':t.marginPct>=0.6?'var(--warn)':'var(--bad)',fontWeight:600}}>{PCT(t.marginPct)}</td>
        <td style={{color:t.returnRate>=0.1?'var(--bad)':t.returnRate>=0.06?'var(--warn)':'var(--text-faint)',fontWeight:600}}>{PCT(t.returnRate)}</td>
      </tr>))}
    </tbody></table>
    {DEMO && <div className="note" style={{marginTop:12}}><b>Tier read:</b> bases drive revenue (£23k, biggest), styles drive margin (92%, highest), charms drive volume (450 units = lowest unit price but highest engagement). A pre-styled stack is literally one of each — so the bundle thesis is exactly the multiplier this product system was designed to produce.</div>}
  </div>);
}

// Shared product-signal engine — used by the Products view AND the Crux diagnostic,
// so the biggest product lever is the SAME finding everywhere (coherent by construction).
function computeProductSignals(){
  const PR = (typeof window!=='undefined' && window.FRKL_PRODUCTS) || [];
  const META = (typeof window!=='undefined' && window.FRKL_PRODUCTS_META) || {};
  if(!PR.length) return null;
  const gm = userGrossMargin() != null ? userGrossMargin()
    : (((typeof window!=='undefined' && window.OI_CONFIG && window.OI_CONFIG.grossMargin) || META.grossMargin || 0.6));
  const monthly = 30 / (META.windowDays || 90);
  const totV = PR.reduce((a,p)=>a+p.views,0) || 1;
  const totAtc = PR.reduce((a,p)=>a+p.atc,0), totPur = PR.reduce((a,p)=>a+p.purchases,0);
  const siteV2A = totAtc/totV, atc2pur = totAtc>0 ? totPur/totAtc : 0;
  const pcts = PR.map(p=>p.pctViews).sort((a,b)=>a-b);
  const medPct = pcts[Math.floor(pcts.length/2)] || 0, p75v = pcts[Math.floor(pcts.length*0.75)] || medPct;
  const labelOf = p => { if(p.oos) return 'oos'; const visHi=p.pctViews>=medPct, desHi=p.viewToAtc>=siteV2A; return visHi&&desHi?'star':!visHi&&desHi?'gem':visHi&&!desHi?'dud':'dead'; };
  const enriched = PR.map(p=>{
    const lab = labelOf(p); let gbp=0, move='';
    // Third funnel stage, per product (no longer assumed uniform): cart→purchase.
    const atcToPurch = p.atc>0 ? p.purchases/p.atc : 0;
    const completionHi = atcToPurch >= atc2pur;
    // Checkout leak = "wanted, not bought": healthy desire (they DO cart it) but the
    // cart→purchase step is materially below the site benchmark. A distinct failure
    // from a "dud" (browsed, not wanted) — and the opposite fix.
    const checkoutLeak = !p.oos && p.atc>=12 && p.viewToAtc>=siteV2A*0.85 && atc2pur>0 && atcToPurch < atc2pur*0.7;
    // Dominant bottleneck: the funnel stage furthest below the site benchmark.
    const stages=[];
    if(p.pctViews<medPct) stages.push(['visibility',(medPct-p.pctViews)/(medPct||1)]);
    if(p.viewToAtc<siteV2A) stages.push(['desire',(siteV2A-p.viewToAtc)/(siteV2A||1)]);
    if(atc2pur>0 && atcToPurch<atc2pur) stages.push(['completion',(atc2pur-atcToPurch)/atc2pur]);
    const leakStage = stages.length ? stages.sort((a,b)=>b[1]-a[1])[0][0] : 'none';
    if(lab==='gem'){ const extraViews=Math.max(0,(p75v-p.pctViews)/100*totV); gbp=extraViews*p.viewToPurch*p.price*gm*monthly;
      move='Merchandise it — homepage/collection + ad feed. It converts; it just isn\'t seen.'; }
    else if(lab==='dud'){ const rec=p.views*siteV2A*atc2pur - p.purchases; gbp=Math.max(0,rec)*p.price*gm*monthly;
      move='Seen a lot, wanted little — fix the PDP (price/imagery/offer) or stop sending traffic.'; }
    else if(lab==='oos'){ gbp=p.views*siteV2A*atc2pur*p.price*gm*monthly;
      move='Out of stock but in demand — restock + switch on a back-in-stock email.'; }
    else if(lab==='star'){ move='Working — protect it and scale its visibility.'; }
    else { move='Low visibility + low desire — candidate to delist.'; }
    // Checkout leak overrides the move + £ (it can hit a "star" or a "dud") — the recoverable
    // money is the carts that would convert if this SKU closed at the site rate.
    if(checkoutLeak){ const recPur=Math.max(0, p.atc*(atc2pur-atcToPurch)); gbp=Math.max(gbp, recPur*p.price*gm*monthly);
      move='Wanted but not bought — carted, then dropped at checkout. Check the price/shipping reveal, trust signals, or a missing/out-of-stock variant on this PDP.'; }
    const redFlag = !p.oos && p.atc>=20 && p.viewToPurch<0.003 && p.viewToAtc>=siteV2A*0.7;
    if(redFlag){ gbp=Math.max(gbp, p.atc*atc2pur*p.price*gm*monthly); move='Strong intent but ~0 sales — check stock/variant selector/checkout on this PDP.'; }
    return {...p, lab, atcToPurch, completionHi, checkoutLeak, leakStage, gbp, move, redFlag};
  });
  // Materiality floor: only list a product where closing the gap is worth ≥ £50/mo (the
  // same threshold the home finding uses). Buckets are MUTUALLY EXCLUSIVE — each product
  // shows under its single dominant story — and returned in full (£-ranked) so the view
  // can offer "show more". A checkout leak takes precedence over its gem/star label.
  const FLOOR = 50, byGbp = (a,b)=>b.gbp-a.gbp;
  const gems = enriched.filter(p=>p.lab==='gem' && !p.checkoutLeak && !p.redFlag && p.gbp>=FLOOR).sort(byGbp);
  const checkoutFix = enriched.filter(p=>(p.checkoutLeak||p.redFlag) && p.gbp>=FLOOR).sort(byGbp);
  const pdpFix = enriched.filter(p=>p.lab==='dud' && !p.checkoutLeak && !p.redFlag && p.gbp>=FLOOR).sort(byGbp);
  const restock = enriched.filter(p=>p.lab==='oos' && p.gbp>=FLOOR).sort(byGbp);
  const fixes = [...pdpFix, ...checkoutFix].sort(byGbp);   // pooled (finding candidates)
  return { PR, META, gm, monthly, totV, siteV2A, atc2pur, medPct, p75v, enriched, gems, fixes, pdpFix, checkoutFix, restock };
}
// The single biggest product opportunity, expressed as a diagnostic finding — so it
// competes for the home "what to do next" and surfaces in the action board's live read.
function productFindings(){
  const S = computeProductSignals();
  if(!S) return [];
  const cands = [...S.restock, ...S.gems, ...S.fixes].filter(p=>p.gbp>=50).sort((a,b)=>b.gbp-a.gbp);
  return cands.slice(0,1).map(p=>{
    const isRestock=p.lab==='oos', isGem=p.lab==='gem', isCheckout=p.checkoutLeak||p.redFlag;
    const a2p=(p.atcToPurch*100).toFixed(0), site=(S.atc2pur*100).toFixed(0);
    return {
      area: isRestock?'Availability':isGem?'Merchandising':isCheckout?'Checkout':'Product',
      metric: isRestock ? `${p.name} — ${p.pctViews}% of all views, out of stock`
            : isGem ? `${p.name} — view→cart ${(p.viewToAtc*100).toFixed(0)}% but only ${p.pctViews}% of views`
            : isCheckout ? `${p.name} — carted by ${(p.viewToAtc*100).toFixed(0)}% of viewers, but only ${a2p}% of carts buy`
            : `${p.name} — ${NUM(p.views)} views, view→cart ${(p.viewToAtc*100).toFixed(1)}%`,
      verdict:'act', confidence: isRestock?'high':'med',
      reasoning: isCheckout
        ? `Product-level GA4: ${NUM(p.views)} views, view→cart ${(p.viewToAtc*100).toFixed(1)}% (healthy desire — people want it), but cart→purchase just ${a2p}% vs the site's ${site}%. They cart it, then drop at checkout — a completion problem, not a product one.`
        : `Product-level GA4: ${NUM(p.views)} views, view→cart ${(p.viewToAtc*100).toFixed(1)}%, view→buy ${(p.viewToPurch*100).toFixed(1)}%. ${isRestock?'In demand but out of stock.':isGem?'Strong desire, low visibility — a merchandising win.':'High visibility, weak desire — a PDP/product problem.'}`,
      recommendation: p.move, gbp: Math.round(p.gbp), _product:true,
    };
  });
}

// The biggest always-on discount code, expressed as a diagnostic finding — an
// evergreen code quietly running every week is structural margin given away with no
// campaign trigger. Surfaces in the home read & action board so it's a decision, not a
// number buried in the Promotions tab. Conservative: framed as "validate", not "recover".
function discountFindings(){
  const D = (typeof window!=='undefined' && window.FRKL_DISCOUNT_CODES) || null;
  if(!D || !D.meta || !D.meta.alwaysOnLeak) return [];
  const leak = D.meta.alwaysOnLeak;
  const full = (D.codes||[]).find(c=>c.code===leak.code);
  if(!full) return [];
  const months = Math.max(1, (full.spanDays||30)/30);
  const perMonth = Math.round((full.discount||0)/months);   // run-rate, not one-off
  if(perMonth < 150) return [];                              // immaterial — skip
  const ratePct = Math.round((full.discountRate||0)*100);
  return [{
    area:'Promotions',
    metric:`${leak.code} — always-on ${ratePct}% code, every week on ${NUM(full.orders)} orders`,
    verdict:'act', confidence:'med',
    reasoning:`"${leak.code}" has run continuously since ${fmtWk(full.firstSeen)} (${full.activeDays} active days) — not a campaign, a standing discount. It gives away ~${GBP(perMonth)}/mo of margin (${GBP(full.discount)} over the window). Some of those orders would convert at full price; the open question is how many.`,
    recommendation:`Decide if this is a deliberate evergreen offer or a default capping margin. Test it: gate it behind email signup, or run a 2-week holdout, and watch whether orders hold. If they do, you've recovered the margin; if they drop, it's load-bearing demand.`,
    gbp: perMonth, _discount:true,
  }];
}

// Sale-price markdowns as a diagnostic finding (Atlas/Crux) — the discount that never
// hits Shopify's total_discounts, so the headline discount load understates the real
// giveaway. Connects the discount work to the true margin picture.
function markdownFindings(){
  const D = (typeof window!=='undefined' && window.FRKL_DISCOUNT_CODES && window.FRKL_DISCOUNT_CODES.meta) || null;
  if(!D) return [];
  const md = D.markdownEstimate||0;
  if(md < 1500) return [];                                  // immaterial — skip
  const months = Math.max(1, (D.weeks||26)/4.345);
  const perMonth = Math.round(md/months);
  const codeAuto = (D.marketingDiscount||0) + (D.automaticDiscount||0);
  return [{
    area:'Margin',
    metric:`Sale-price markdowns — ${D.catalogOnSale}/${D.catalogActive} of catalogue at ~${D.avgMarkdownPct}% off (~${Math.round((D.markdownShareOfValue||0)*100)}% of sold value)`,
    verdict:'act', confidence:'med',
    reasoning:`Compare-at markdowns never enter Shopify's total_discounts, so the headline discount load (codes + automatic ≈ ${GBP(codeAuto)}) understates the real giveaway. Markdowns add ~${GBP(md)} over the window — the true discount load is materially higher than the code figure. A margin lever hiding from the discount reports.`,
    recommendation:`Review the markdown/clearance strategy — it's a bigger margin lever than your codes. Tighten deep markdowns on full-demand SKUs; reserve them for genuine clearance. Full breakdown on Promotions.`,
    gbp: perMonth, _markdown:true,
  }];
}

// CVR synthesis as a diagnostic finding (Crux) — surfaces the funnel-stage mover +
// mix-vs-within-channel verdict on the home screen, connecting CVR to WHERE it moved.
function cvrFindings(){
  const M = (typeof window!=='undefined' && window.FRKL_CVR && window.FRKL_CVR.meta) || null;
  if(!M || M.insufficient) return [];
  const up = M.deltaCVR>=0, mover = M.moverStage||'', contrib = Math.round(((M.stageContribution&&M.stageContribution[mover])||0)*100);
  const td = M.topDriver;
  return [{
    area:'Conversion',
    metric:`CVR ${M.cvrPrev}% → ${M.cvrNow}% (${M.deltaCVR>=0?'+':''}${M.deltaCVR}pp) · ${M.mixDominant?'traffic-mix':'site / within-channel'}`,
    verdict: up?'monitor':'act', confidence:'med',
    reasoning:`${M.mixDominant?'Largely a traffic-mix shift (who you sent, not how the site converts)':'A real within-channel move — the site converts differently, not just a mix artefact'}; ${contrib}% of the change sits at ${mover}.${td?` Strongest daily correlate: ${td.label} (r=${td.r>0?'+':''}${td.r}${td.confound?', traffic-mix confounded':''}).`:''}`,
    recommendation: up
      ? `Protect what changed at ${mover}. See CVR drivers for the funnel decomposition, mix-vs-site split and the week-vs-week comparator.`
      : `Investigate ${mover} first. See CVR drivers for the funnel decomposition, mix-vs-site split and correlations.`,
    gbp:0, _cvr:true,
  }];
}

// ── Lightweight stats (no deps) — used to lift the CVR analysis from "here are
// the numbers" to "is this gap even real, and what survives the confounds". ────
function _mean(a){ return a.length? a.reduce((s,x)=>s+x,0)/a.length : 0; }
function _normCdf(x){ const t=1/(1+0.2316419*Math.abs(x)); const d=0.3989423*Math.exp(-x*x/2);
  const pr=d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274)))); return x>0? 1-pr : pr; }
// significance of a correlation: |r| past the ~95% two-sided line for n points
function corrSig(r,n){ if(n<4) return false; const t=Math.abs(r)*Math.sqrt((n-2)/Math.max(1e-9,1-r*r)); return t>1.98; }
// Wilson score interval for k successes of n (z=1.96 -> 95%)
function wilson(k,n,z){ z=z||1.96; if(!n) return {p:0,lo:0,hi:0}; const p=k/n, z2=z*z, dn=1+z2/n;
  const c=(p+z2/(2*n))/dn, h=(z*Math.sqrt(p*(1-p)/n+z2/(4*n*n)))/dn; return {p,lo:Math.max(0,c-h),hi:Math.min(1,c+h)}; }
// Two-proportion z-test (two-sided p). k1/n1 vs k2/n2.
function twoPropZ(k1,n1,k2,n2){ if(!n1||!n2) return {z:0,p:1}; const p1=k1/n1,p2=k2/n2,pp=(k1+k2)/(n1+n2);
  const se=Math.sqrt(pp*(1-pp)*(1/n1+1/n2)); if(se===0) return {z:0,p:1}; const z=(p1-p2)/se; return {z,p:2*(1-_normCdf(Math.abs(z)))}; }
// Solve Ax=b (Gaussian elimination, partial pivot). Returns null if singular.
function _solve(A,b){ const n=b.length, M=A.map((r,i)=>[...r,b[i]]);
  for(let c=0;c<n;c++){ let pv=c; for(let r=c+1;r<n;r++) if(Math.abs(M[r][c])>Math.abs(M[pv][c])) pv=r;
    if(Math.abs(M[pv][c])<1e-9) return null; const tmp=M[c]; M[c]=M[pv]; M[pv]=tmp;
    for(let r=0;r<n;r++){ if(r===c) continue; const fct=M[r][c]/M[c][c]; for(let j=c;j<=n;j++) M[r][j]-=fct*M[c][j]; } }
  const out=M.map((r,i)=>r[n]/r[i][i]); return out.every(v=>Number.isFinite(v))? out : null; }
// OLS with intercept. Predictors are STANDARDIZED internally and a small ridge is
// added — essential here because the candidate predictors (traffic shares) are
// collinear and on wildly different scales; raw normal-equations would go singular
// and silently return NaN. predictRow accepts RAW rows (standardisation applied).
function ols(X,y,lam){ const n=X.length, k=(X[0]?X[0].length:0); if(n<k+2) return null;
  const cols=Array.from({length:k},(_,j)=>X.map(r=>r[j]));
  const mu=cols.map(_mean), sg=cols.map(c=>{ const m=_mean(c); return Math.sqrt(_mean(c.map(v=>(v-m)*(v-m))))||1; });
  const Zs=Array.from({length:n},(_,i)=>cols.map((c,j)=>(c[i]-mu[j])/sg[j]));
  const p=k+1, D=Zs.map(r=>[1,...r]);
  const XtX=Array.from({length:p},()=>new Array(p).fill(0)), Xty=new Array(p).fill(0);
  for(let i=0;i<n;i++){ for(let a=0;a<p;a++){ Xty[a]+=D[i][a]*y[i]; for(let b=0;b<p;b++) XtX[a][b]+=D[i][a]*D[i][b]; } }
  const ridge=Math.max(lam||0, n*1e-3); for(let a=1;a<p;a++) XtX[a][a]+=ridge;   // ridge off the intercept
  const beta=_solve(XtX,Xty); if(!beta) return null;
  return {beta, mu, sg, predictRow:(r)=>{ let v=beta[0]; for(let j=0;j<k;j++) v+=beta[j+1]*((r[j]-mu[j])/sg[j]); return v; }}; }
// Partial correlation of x with y controlling for a single variable z (closed form
// — exact and numerically bulletproof, unlike multi-control normal equations which
// go singular when the controls are collinear). z = the dominant confound vector.
function partialCorr(x,y,z){ const _r=(a,b)=>{ const v=pearson(a,b); return v==null?0:v; };
  if(x.length<6) return _r(x,y);
  const rxy=_r(x,y), rxz=_r(x,z), ryz=_r(y,z), den=Math.sqrt(Math.max(0,(1-rxz*rxz)*(1-ryz*ryz)));
  return den>1e-6? Math.max(-1,Math.min(1,(rxy-rxz*ryz)/den)) : _r(x,y); }

// ── CVR drivers (Crux) — a clearer picture of conversion rate ────────────────
// Three layers, strongest evidence first: (1) WHERE in the funnel CVR moved,
// (2) WHETHER it's traffic-mix or the site itself, (3) WHAT correlates with it
// day-to-day (ranked hypotheses to test — correlation is not causation).
function CvrDrivers(){
  const [showStats,setShowStats]=useState(false);
  const D = (typeof window!=='undefined' && window.FRKL_CVR) || null;
  if(!D || !D.meta || D.meta.insufficient) return (
    <div className="card"><div className="card-section-title"><h2 style={{margin:0}}>Conversion rate — drivers</h2></div>
    <div className="note">Needs ~3 weeks of daily GA4 history to decompose. {D&&D.meta?`Have ${D.meta.days||0} days.`:'No GA4 daily data yet.'}</div></div>);
  const M=D.meta, series=D.series||[], channels=D.channels||[], drivers=D.drivers||[];
  const STAGES=['session→cart','cart→checkout','checkout→purchase'];
  const up = M.deltaCVR>=0, mixDom=M.mixDominant;
  const verdict = mixDom
    ? {txt:'Traffic-mix shift', color:'#f5b544', sub:'mostly who you’re sending, not how the site converts'}
    : {txt:(up?'Real site improvement':'Real site slowdown'), color:(up?'#4ade80':'#ef6b6f'), sub:'channels are converting differently — not just a mix artefact'};
  const maxAbs = Math.max(...drivers.map(d=>d.abs), 0.01);

  // ── Two-week comparator: default to the pair with the biggest CVR gap among
  // similar-session weeks (sessions within 75%) — i.e. "same traffic, different CVR". ──
  const seriesDaily = D.seriesDaily || [];
  // ── Granularity + range. chartGran is the SINGLE source for both the trend
  // chart and the period comparison, so clicking a point on the chart selects a
  // directly-comparable period. ──
  const [chartGran,setChartGran] = useState('week');   // weekly ↔ daily
  const [chartDays,setChartDays] = useState(0);        // 0 = all; else last N days
  const [showDisc,setShowDisc] = useState(true);       // overlay total discount depth on the trend
  const gran = chartGran;                              // comparator follows the chart
  const panel = (chartGran==='day' ? seriesDaily : series);
  const segBtn = (active)=>({fontSize:11.5,fontWeight:600,padding:'4px 10px',borderRadius:7,cursor:'pointer',border:'1px solid '+(active?'#7c8cff':'var(--border-subtle)'),background:active?'rgba(124,140,255,0.14)':'transparent',color:active?'#9aa6ff':'var(--text-muted)'});
  const _cbase = (chartGran==='day' ? seriesDaily : series);
  const _clast = _cbase.length ? _cbase[_cbase.length-1].w : null;
  const _ccut = (chartDays && _clast) ? new Date(new Date(_clast+'T00:00:00Z').getTime() - chartDays*86400000).toISOString().slice(0,10) : '0000';
  const chartData = _cbase.filter(s=> s.w >= _ccut);
  // ── Discount-depth overlay. trueDiscountIntensity = codes + automatic + sale-
  // price markdowns, as % of sales. We shade it as a low amber band and flag the
  // deepest periods (top quartile of the visible range) so promo spikes line up
  // visually against the CVR line — the eye does the correlation. ──
  const _dv = chartData.map(d=>d.trueDiscountIntensity).filter(v=>v!=null).sort((a,b)=>a-b);
  const discMax = _dv.length ? _dv[_dv.length-1] : 1;
  const discThr = _dv.length ? _dv[Math.floor(_dv.length*0.75)] : Infinity;   // top quartile = "deep"
  // Custom dot: an amber diamond + % label, drawn only on the deepest periods.
  const discDot = (props)=>{ const {cx,cy,payload}=props; const v=payload&&payload.trueDiscountIntensity;
    if(cx==null||cy==null||v==null||v<discThr) return null;
    return (<g key={'dd'+cx+'-'+cy} style={{pointerEvents:'none'}}>
      <path d={`M${cx} ${cy-5} L${cx+5} ${cy} L${cx} ${cy+5} L${cx-5} ${cy} Z`} fill="#f5b544" stroke="var(--bg-card)" strokeWidth={1.2}/>
      <text x={cx} y={cy-8} textAnchor="middle" fill="#f5b544" fontSize={9.5} fontWeight={700}>{Math.round(v)}%</text>
    </g>); };
  // ── Discount lift: mean CVR on the deepest-discount periods vs all the rest,
  // over the visible range. A direct number for "do deep promos convert better?"
  // — observational, so we flag the confound rather than imply causation. ──
  const _deep = chartData.filter(d=>d.trueDiscountIntensity!=null && d.cvr!=null && d.trueDiscountIntensity>=discThr);
  const _rest = chartData.filter(d=>d.trueDiscountIntensity!=null && d.cvr!=null && d.trueDiscountIntensity< discThr);
  const _avg = (a,k)=> a.length ? a.reduce((s,d)=>s+d[k],0)/a.length : null;
  let discLift = (_deep.length>=2 && _rest.length>=2) ? {
    deepN:_deep.length, restN:_rest.length,
    deepCvr:_avg(_deep,'cvr'),  restCvr:_avg(_rest,'cvr'),
    deepDisc:_avg(_deep,'trueDiscountIntensity'), restDisc:_avg(_rest,'trueDiscountIntensity'),
  } : null;
  if(discLift){ discLift.pp = discLift.deepCvr - discLift.restCvr; discLift.pct = discLift.restCvr ? discLift.pp/discLift.restCvr : null; }
  const defaultPair = (p)=>{ let best=null;
    for(let i=0;i<p.length;i++) for(let j=i+1;j<p.length;j++){
      const A=p[i],B=p[j], lo=Math.min(A.sessions,B.sessions), hi=Math.max(A.sessions,B.sessions);
      if(hi<=0 || lo/hi<0.75) continue;
      const gap=Math.abs(A.cvr-B.cvr); if(!best||gap>best.gap) best={a:A.w,b:B.w,gap};
    }
    if(!best && p.length>=2) best={a:p[p.length-2].w,b:p[p.length-1].w};
    return best?{a:best.a,b:best.b}:{a:p[0]&&p[0].w,b:p[0]&&p[0].w};
  };
  const [cmp,setCmp] = useState(()=>defaultPair(series));
  // ── Click a point on the trend chart to select it ──
  // First click → A, second → B, and the comparison rebuilds the moment both
  // are set. Clicking a selected period clears it; a third click starts a fresh
  // pair. No dropdowns, no chips — you point at the week you mean.
  const pickPeriod = (w)=>{ const p=cmp; let n;
    if(p.a===w)      n={a:null,b:p.b};   // deselect A
    else if(p.b===w) n={a:p.a,b:null};   // deselect B
    else if(!p.a)    n={a:w,b:p.b};      // fill A
    else if(!p.b)    n={a:p.a,b:w};      // fill B
    else             n={a:w,b:null};     // both full → start a fresh pair
    setCmp(n);
  };
  // Switching weekly/daily re-defaults the pair (week keys ≠ day keys).
  const setGranReset = (g)=>{ setChartGran(g); setCmp(defaultPair(g==='day'?seriesDaily:series)); };
  const lbl = (s)=> (gran==='day'?'':'wc ')+fmtWk(s.w);
  const CMP_METRICS=[
    {g:'Funnel stage', k:'s2c', l:'Session→cart', t:'pct'},
    {g:'Funnel stage', k:'c2co', l:'Cart→checkout', t:'pct'},
    {g:'Funnel stage', k:'co2p', l:'Checkout→purchase', t:'pct'},
    {g:'Traffic & behaviour', k:'paidShare', l:'Paid-traffic share', t:'pct'},
    {g:'Traffic & behaviour', k:'emailShare', l:'Email-traffic share', t:'pct'},
    {g:'Traffic & behaviour', k:'organicShare', l:'Organic share', t:'pct'},
    {g:'Traffic & behaviour', k:'newShare', l:'New-visitor share', t:'pct'},
    {g:'Traffic & behaviour', k:'bounce', l:'Bounce rate', t:'pct'},
    {g:'Traffic & behaviour', k:'engagement', l:'Engagement rate', t:'pct'},
    {g:'Device, geography & source', k:'mobileShare', l:'Mobile-traffic share', t:'pct'},
    {g:'Device, geography & source', k:'mobileCvr', l:'Mobile CVR', t:'pct'},
    {g:'Device, geography & source', k:'desktopCvr', l:'Desktop CVR', t:'pct'},
    {g:'Device, geography & source', k:'ukShare', l:'UK-traffic share', t:'pct'},
    {g:'Device, geography & source', k:'webOrderShare', l:'Web-order share (vs draft/wholesale)', t:'pct'},
    {g:'Checkout & payment', k:'freeShipShare', l:'Free-shipping rate (web)', t:'pct'},
    {g:'Checkout & payment', k:'altPayShare', l:'Alt-payment share (PayPal/other)', t:'pct'},
    {g:'Commercial', k:'aov', l:'AOV', t:'gbp'},
    {g:'Commercial', k:'trueDiscountIntensity', l:'Discount intensity — incl. sale prices (web)', t:'pct'},
    {g:'Commercial', k:'markdownIntensity', l:'— of which sale-price markdowns', t:'pct'},
    {g:'Commercial', k:'discountIntensity', l:'Discount intensity — codes/auto only (all orders)', t:'pct'},
    {g:'Commercial', k:'emailSends', l:'Email sends', t:'num'},
    {g:'Commercial', k:'adSpend', l:'Ad spend', t:'gbp'},
    {g:'Commercial', k:'revenue', l:'Revenue', t:'gbp'},
  ];
  const byW = Object.fromEntries(panel.map(s=>[s.w,s]));
  const cA=byW[cmp.a], cB=byW[cmp.b];
  const fmtVal=(t,v)=> v==null?'—': t==='pct'?(v+'%'): t==='gbp'?GBP(v): NUM(v);
  const relDiff=(a,b)=>{ if(a==null||b==null) return 0; const m=(Math.abs(a)+Math.abs(b))/2||1; return Math.abs(b-a)/m; };
  const cmpRows = CMP_METRICS.map(m=>({...m, a:cA?cA[m.k]:null, b:cB?cB[m.k]:null, rel:relDiff(cA&&cA[m.k], cB&&cB[m.k])}));
  const movers = cmpRows.filter(r=>r.a!=null&&r.b!=null&&r.rel>=0.12).sort((x,y)=>y.rel-x.rel).slice(0,4);
  const moverKeys = new Set(movers.map(m=>m.k));
  const hiW=(cA&&cB)?(cA.cvr>=cB.cvr?cA:cB):null, loW=(cA&&cB)?(cA.cvr>=cB.cvr?cB:cA):null;
  const sessClose = (cA&&cB)?(Math.min(cA.sessions,cB.sessions)/Math.max(cA.sessions,cB.sessions)>=0.8):false;
  const dlt=(r)=>{ if(r.a==null||r.b==null) return '—'; const d=r.b-r.a; const s=d>=0?'+':''; return r.t==='pct'?`${s}${d.toFixed(1)}pp`: r.t==='gbp'?`${d>=0?'+':'-'}${GBP(Math.abs(d))}`:`${s}${NUM(d)}`; };

  // ── A↔B explanation engine ──────────────────────────────────────────────────
  // Applies the structural model that connects the metrics: CVR is *exactly*
  // session→cart × cart→checkout × checkout→purchase, so the CVR change splits
  // across those three stages by log-contribution. Then it reads which inputs
  // moved with the change and classifies each by how it's known to act on CVR —
  // separating genuine site/offer/checkout levers from traffic-mix confounds
  // (the #1 false positive). Output is a ranked, honest "why", not a black box.
  const cmLabel={}, cmType={}; CMP_METRICS.forEach(m=>{ cmLabel[m.k]=m.l; cmType[m.k]=m.t; });
  // dir = sign of the effect on CVR for an *increase* in the metric. rate = use
  // higher/lower wording (rates) vs more/fewer (shares & counts). The phrase is
  // built direction-aware at runtime so "new share 73→62%" reads "fewer", not "more".
  const DRIVER_MODEL = {
    newShare:             {dir:-1, kind:'mix',      noun:'first-time visitors', note:'a colder, lower-converting segment'},
    paidShare:            {dir:-1, kind:'mix',      noun:'paid traffic', note:'colder than organic/email'},
    organicShare:         {dir:+1, kind:'mix',      noun:'organic traffic', note:'warmer intent'},
    emailShare:           {dir:+1, kind:'mix',      noun:'email traffic', note:'your warmest audience'},
    mobileShare:          {dir:-1, kind:'device',   noun:'mobile traffic', note:'converts below desktop'},
    ukShare:              {dir:+1, kind:'mix',      noun:'UK traffic', note:'your best-converting market'},
    bounce:               {dir:-1, kind:'site',     noun:'bounce', rate:true, note:'landing relevance or speed'},
    engagement:           {dir:+1, kind:'site',     noun:'engagement', rate:true, note:'stickier sessions'},
    trueDiscountIntensity:{dir:+1, kind:'offer',    noun:'discounting', rate:true, note:'codes + sale prices'},
    discountIntensity:    {dir:+1, kind:'offer',    noun:'code/automatic discounting', rate:true},
    freeShipShare:        {dir:+1, kind:'checkout', noun:'free-shipping orders', note:'removes a checkout blocker'},
    altPayShare:          {dir:+1, kind:'checkout', noun:'express/alt payments', note:'smoother checkout'},
    adSpend:              {dir:-1, kind:'mix',      noun:'ad spend', rate:true, note:'usually buys colder reach'},
  };
  const KIND_VERDICT = {
    mix:`mostly a traffic-mix effect — the gap is about WHO visited, not how the site converted. Treat it as a composition artefact unless within-channel CVR also moved.`,
    site:`a site / behaviour change (relevance, speed, engagement) — a genuine, ownable lever.`,
    offer:`offer-led — discounting moved with CVR. Watch margin: a CVR win bought with depth can still lose money.`,
    checkout:`checkout mechanics (shipping or payment friction) — usually a fixable, durable lever.`,
    device:`a device-mix shift (mobile vs desktop) — check mobile CVR specifically before acting.`,
  };
  const buildCmpStory = ()=>{ if(!cA||!cB||cA.cvr==null||cB.cvr==null) return null;
    const pp=+(cB.cvr-cA.cvr).toFixed(2), up=pp>=0;
    const ln=(a,b)=> (a>0&&b>0)?Math.log(b/a):0;
    const stages=[['session→cart','s2c'],['cart→checkout','c2co'],['checkout→purchase','co2p']]
      .map(([label,k])=>({label,k,a:cA[k],b:cB[k],ln:ln(cA[k],cB[k])}));
    const sumLn=stages.reduce((s,x)=>s+x.ln,0);
    const tiny = Math.abs(pp)<0.03 || Math.abs(sumLn)<1e-4;
    stages.forEach(x=> x.share = sumLn? x.ln/sumLn : 0);
    const ranked=[...stages].sort((x,y)=>Math.abs(y.ln)-Math.abs(x.ln));
    const lead=ranked[0];
    const offset=ranked.find(x=> x!==lead && Math.sign(x.ln)!==Math.sign(lead.ln) && Math.abs(x.ln)>Math.abs(lead.ln)*0.3);
    const drivers=Object.keys(DRIVER_MODEL).map(k=>{ const a=cA[k], b=cB[k]; if(a==null||b==null) return null;
      const d=b-a, mag=relDiff(a,b), m=DRIVER_MODEL[k];
      if(k!=='adSpend' && Math.abs(d)<1) return null;     // <1pp pct move = noise
      if(mag<0.08) return null;                            // <8% relative = noise
      const word = d>0 ? (m.rate?'higher':'more') : (m.rate?'lower':'fewer');
      const phrase = `${word} ${m.noun}${m.note?` — ${m.note}`:''}`;
      const push=Math.sign(d)*m.dir, consistent= up? push>0 : push<0;
      return {k,a,b,d,mag,kind:m.kind,phrase,consistent}; }).filter(Boolean).sort((x,y)=>y.mag-x.mag);
    const consistent=drivers.filter(d=>d.consistent).slice(0,4);
    const against=drivers.filter(d=>!d.consistent).slice(0,2);
    const kw={}; consistent.forEach(d=> kw[d.kind]=(kw[d.kind]||0)+d.mag);
    const topKind=Object.keys(kw).sort((a,b)=>kw[b]-kw[a])[0]||null;
    return {pp,up,tiny,stages,lead,offset,consistent,against,topKind,verdict:topKind?KIND_VERDICT[topKind]:null};
  };
  const cmpStory = buildCmpStory();
  // ── Significance on the A↔B CVR gap + Wilson CIs (CVR = orders ÷ sessions). ──
  const ciA = cA? wilson(cA.orders,cA.sessions):null;
  const ciB = cB? wilson(cB.orders,cB.sessions):null;
  const gapSig = (cA&&cB)? twoPropZ(cA.orders,cA.sessions,cB.orders,cB.sessions):null;
  const pTxt = (p)=> p<0.001?'p<0.001': p<0.01?'p<0.01': p<0.05?('p='+p.toFixed(3)): ('p='+p.toFixed(2));

  // ── Deeper signal: confound-controlled drivers + expected-CVR residuals + the
  // cleanest "natural experiment" pairs. Computed from the daily/weekly series. ──
  const STAT = useMemo(()=>{
    const dd = seriesDaily.length>=12 ? seriesDaily : series; const nD=dd.length;
    const col = k => dd.map(d=> d[k]);
    const ctrlKey='newShare';   // dominant traffic-mix confound (closed-form partial)
    const LEVERS=[
      {k:'trueDiscountIntensity',label:'Discount depth (incl. sale)'},
      {k:'discountIntensity',label:'Code/auto discount'},
      {k:'bounce',label:'Bounce rate'},
      {k:'engagement',label:'Engagement rate'},
      {k:'emailSends',label:'Email sends'},
      {k:'adSpend',label:'Ad spend'},
      {k:'aov',label:'AOV'},
      {k:'freeShipShare',label:'Free-shipping rate'},
      {k:'altPayShare',label:'Alt-payment share'},
      {k:'emailShare',label:'Email-traffic share'},
    ];
    const zc=col(ctrlKey); const y=col('cvr');
    const drivers=LEVERS.filter(L=>L.k!==ctrlKey).map(L=>{ const x=col(L.k);
      const X=[],Y=[],Zv=[];
      for(let i=0;i<nD;i++){ const xv=x[i],yv=y[i],zv=zc[i];
        if(xv==null||yv==null||zv==null) continue; X.push(xv); Y.push(yv); Zv.push(zv); }
      if(X.length<8) return null;
      const raw=(()=>{ const r=pearson(X,Y); return r==null?0:r; })();
      const adj=partialCorr(X,Y,Zv);
      return {k:L.k,label:L.label,n:X.length,raw,adj,sig:corrSig(adj,X.length)};
    }).filter(Boolean).sort((a,b)=>Math.abs(b.adj)-Math.abs(a.adj));
    // expected-CVR residuals, weekly: simple closed-form regression on new-visitor
    // share (traffic warmth). Residual = CVR the traffic mix alone does NOT explain
    // — the genuine "something off-model happened" signal. Closed form = bulletproof.
    const wk=series; const XX=[],yy=[],idx=[];
    wk.forEach((sx,i)=>{ if(sx.newShare==null||sx.cvr==null) return; XX.push(sx.newShare); yy.push(sx.cvr); idx.push(i); });
    let resid=null;
    if(XX.length>=8){ const mx=_mean(XX), my=_mean(yy); let sxy=0,sxx=0;
      for(let i=0;i<XX.length;i++){ sxy+=(XX[i]-mx)*(yy[i]-my); sxx+=(XX[i]-mx)*(XX[i]-mx); }
      const slope=sxx>0? sxy/sxx : 0, b0=my-slope*mx;
      const res=yy.map((v,i)=> v-(b0+slope*XX[i])); const sd=Math.sqrt(_mean(res.map(r=>r*r)));
      const byW={}; idx.forEach((wi,i)=>{ const w=wk[wi].w; const e=res[i]; byW[w]={exp:b0+slope*XX[i],act:yy[i],e,z:sd?e/sd:0}; });
      resid={sd,byW,list:Object.keys(byW).map(w=>({w,...byW[w]})).filter(r=>Math.abs(r.z)>=1.3).sort((a,b)=>Math.abs(b.e)-Math.abs(a.e)).slice(0,5)};
    }
    // clean "natural experiment" pairs: matched traffic, one lever differs
    const mixKeys=['newShare','paidShare','mobileShare'];
    const levers=[['trueDiscountIntensity','discount depth','pct'],['emailSends','email volume','num'],['freeShipShare','free-ship rate','pct'],['aov','AOV','gbp']];
    const pairs=[];
    for(let i=0;i<wk.length;i++) for(let j=i+1;j<wk.length;j++){ const A=wk[i],B=wk[j]; if(A.cvr==null||B.cvr==null) continue;
      const lo=Math.min(A.sessions,B.sessions),hi=Math.max(A.sessions,B.sessions); if(hi<=0||lo/hi<0.7) continue;
      if(!mixKeys.every(k=> A[k]!=null&&B[k]!=null&&Math.abs(A[k]-B[k])<=6)) continue;
      let best=null; levers.forEach(([k,lab,t])=>{ if(A[k]==null||B[k]==null) return; const rel=relDiff(A[k],B[k]); if(!best||rel>best.rel) best={k,lab,t,rel,a:A[k],b:B[k]}; });
      if(!best||best.rel<0.2) continue;
      pairs.push({a:A.w,b:B.w,lever:best,cvrGap:Math.abs(A.cvr-B.cvr),score:best.rel*Math.abs(A.cvr-B.cvr)});
    }
    return {drivers, resid, cleanPairs:pairs.sort((x,y)=>y.score-x.score).slice(0,3)};
  }, [seriesDaily, series]);

  const fmtMetric=(k,v)=> fmtVal(cmType[k]||'pct', v);
  const cmpAskAI = ()=>{ if(!window.__oiAsk||!cA||!cB||!cmpStory) return; const S=cmpStory; const u=gran==='day'?'day':'week';
    const fld=(c)=>`CVR ${c.cvr}%, sessions ${NUM(c.sessions)} | funnel: session→cart ${c.s2c}%, cart→checkout ${c.c2co}%, checkout→purchase ${c.co2p}% | new-visitor ${c.newShare}%, paid ${c.paidShare}%, email ${c.emailShare}%, mobile ${c.mobileShare}%, bounce ${c.bounce}%, engagement ${c.engagement}% | discount(incl. sale) ${c.trueDiscountIntensity}%, free-ship ${c.freeShipShare}%, AOV ${GBP(c.aov)}`;
    const prompt=`Act as my analyst. Compare these two ${u}s for frkl and explain what most likely drove the CVR difference. Use the identity CVR = session→cart × cart→checkout × checkout→purchase, and separate genuine site/offer/checkout levers from traffic-mix confounds (paid/new-visitor/device share).\n\nA · ${lbl(cA)} — ${fld(cA)}\nB · ${lbl(cB)} — ${fld(cB)}\n\nMy structural read: CVR moved ${S.up?'+':''}${S.pp}pp, mostly at ${S.lead?S.lead.label:'—'}${S.offset?` (partly offset by ${S.offset.label})`:''}. Moving with it: ${S.consistent.map(d=>cmLabel[d.k]).join(', ')||'little else'}. Against the grain: ${S.against.map(d=>cmLabel[d.k]).join(', ')||'none'}. Looks ${S.topKind||'unclear'}.\n\nDo you agree? Give the single most likely cause, the strongest confound to rule out, and one controlled test (holdout/A-B) that would confirm it.`;
    window.__oiAsk(prompt);
  };

  const tile = (label,val,sub,accent) => (<div style={{flex:'1 1 170px',background:'var(--surface-1,#111116)',border:'1px solid var(--border-subtle,#23232b)',borderRadius:12,padding:'12px 14px'}}>
    <div style={{fontSize:11,letterSpacing:'.04em',textTransform:'uppercase',color:'var(--text-faint)'}}>{label}</div>
    <div style={{fontSize:22,fontWeight:700,marginTop:3,color:accent||'var(--text-primary)'}}>{val}</div>
    <div style={{fontSize:11.5,color:'var(--text-muted)',marginTop:2}}>{sub}</div>
  </div>);

  const stageCard = (k) => { const now=M.stageNow[k], prev=M.stagePrev[k], dlt=M.stageMoves[k], contrib=Math.round((M.stageContribution[k]||0)*100); const isMover=k===M.moverStage; const good=dlt>=0;
    return (<div key={k} style={{flex:'1 1 200px',background:isMover?'rgba(124,140,255,0.08)':'var(--surface-1,#111116)',border:'1px solid '+(isMover?'#3a4080':'var(--border-subtle,#23232b)'),borderRadius:12,padding:'11px 13px'}}>
      <div style={{fontSize:12,fontWeight:600,color:'var(--text-secondary)'}}>{k}{isMover&&<span style={{marginLeft:6,fontSize:10,color:'#9aa6ff',fontWeight:700}}>BIGGEST MOVER</span>}</div>
      <div style={{fontSize:18,fontWeight:700,marginTop:3}}>{prev}% <span style={{color:'var(--text-faint)'}}>→</span> {now}% <span style={{fontSize:12.5,color:good?'#4ade80':'#ef6b6f'}}>{dlt>=0?'+':''}{dlt}pp</span></div>
      <div style={{fontSize:11.5,color:'var(--text-muted)',marginTop:2}}>{contrib>=0?contrib:0}% of the CVR change</div>
    </div>);
  };

  const barCell = (d) => { const w=Math.round(d.abs/maxAbs*48); const pos=d.dir==='up'; const col=pos?'#4ade80':'#ef6b6f';
    return (<div style={{position:'relative',height:16,background:'var(--surface-2,#15151b)',borderRadius:4}}>
      <div style={{position:'absolute',left:'50%',top:0,bottom:0,width:1,background:'#3a3a44'}}/>
      <div style={{position:'absolute',top:2,bottom:2,borderRadius:3,background:col,opacity:d.significant?0.95:0.4,left:(pos?50:(50-w))+'%',width:w+'%'}}/>
    </div>);
  };

  // recommended test — derived, honest
  const topReal = drivers.find(d=>d.significant && !d.confound);
  const test = M.moverStage==='checkout→purchase'
    ? `Most of the move is at checkout→purchase — audit what changed there (payment/shipping reveal, trust, the discount→full-price mix) and protect it. ${topReal?`Bounce/engagement tracks CVR most tightly (${topReal.label}, r=${topReal.r}); improve landing relevance on your top pages and watch CVR.`:''}`
    : `${topReal?`${topReal.label} tracks CVR most tightly (r=${topReal.r}). It's a hypothesis, not proof — run a controlled change (e.g. a holdout or A/B) and watch CVR before committing.`:'Confirm the top correlate with a controlled test before acting.'}`;

  return (<div>
    <ClarityFrictionPanel/>
    <div className="card" style={{marginBottom:14}}>
      <div className="card-section-title">
        <h2 style={{margin:0}}>Conversion rate — what's moving it <span style={{color:'var(--text-faint)',fontWeight:400,fontSize:13}}>(sessions → order)</span></h2>
        <span className="meta">Crux · {M.lo} → {M.hi} · {M.days} days · GA4 × Shopify × Klaviyo × Meta</span>
      </div>
      <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:8}}>
        {tile('GA4 funnel CVR (recent)', M.cvrNow+'%', `was ${M.cvrPrev}% · ${M.deltaCVR>=0?'+':''}${M.deltaCVR}pp`, up?'#4ade80':'#ef6b6f')}
        {tile('What kind of move', verdict.txt, verdict.sub, verdict.color)}
        {tile('Biggest funnel mover', M.moverStage, `${Math.round((M.stageContribution[M.moverStage]||0)*100)}% of the change`, '#9aa6ff')}
      </div>
      {M.siteCvrNow!=null && (
        <div className="note" style={{marginBottom:14}}>
          <b>Headline site CVR: {M.siteCvrNow}%</b> (Shopify orders ÷ GA4 sessions) vs the {M.benchmarkLabel||CVR_BENCH_LABEL} target — this is the figure shown on the Overview and board. The funnel percentages here are GA4-tracked (GA4 undercounts purchases vs Shopify), used to pinpoint <i>where</i> in the journey conversion moves, not as the headline number.
        </div>
      )}
      <div style={{display:'flex',gap:6,flexWrap:'wrap',alignItems:'center',marginBottom:8}}>
        <span style={{fontSize:11,color:'var(--text-faint)',textTransform:'uppercase',letterSpacing:'.04em',marginRight:2}}>View</span>
        {[['week','Weekly'],['day','Daily']].map(([g,l])=>(<button key={g} onClick={()=>setGranReset(g)} style={segBtn(chartGran===g)}>{l}</button>))}
        <span style={{width:1,height:18,background:'var(--border-subtle)',margin:'0 6px'}}/>
        <span style={{fontSize:11,color:'var(--text-faint)',textTransform:'uppercase',letterSpacing:'.04em',marginRight:2}}>Range</span>
        {[[0,'All'],[90,'90d'],[60,'60d'],[30,'30d'],[14,'14d']].map(([d,l])=>(<button key={l} onClick={()=>setChartDays(d)} style={segBtn(chartDays===d)}>{l}</button>))}
        <span style={{width:1,height:18,background:'var(--border-subtle)',margin:'0 6px'}}/>
        <span style={{fontSize:11,color:'var(--text-faint)',textTransform:'uppercase',letterSpacing:'.04em',marginRight:2}}>Overlay</span>
        <button onClick={()=>setShowDisc(v=>!v)} title="Shade total discount depth (codes + sale prices) and flag the deepest-discount periods" style={{...segBtn(showDisc), border:'1px solid '+(showDisc?'#f5b544':'var(--border-subtle)'), background:showDisc?'rgba(245,181,68,0.14)':'transparent', color:showDisc?'#f5b544':'var(--text-muted)'}}>🏷️ Discounts</button>
        <span style={{fontSize:11,color:'var(--text-faint)',marginLeft:4}}>{chartData.length} {chartGran==='day'?'days':'weeks'}{chartGran==='day'?' · daily CVR is noisier — read the trend, not single days':''}</span>
      </div>
      <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',margin:'2px 0 8px',padding:'7px 11px',borderRadius:9,background:'rgba(124,140,255,0.07)',border:'1px solid rgba(124,140,255,0.18)'}}>
        <span style={{fontSize:12,fontWeight:600,color:'#9aa6ff'}}>📈 Click two points on the chart to compare them</span>
        <span style={{fontSize:12,color:'var(--text-muted)'}}>{cA&&cB
          ? <>Comparing <b style={{color:'#7c8cff'}}>A · {lbl(cA)}</b> <span style={{color:'var(--text-faint)'}}>vs</span> <b style={{color:'#4ade80'}}>B · {lbl(cB)}</b> — see table below.</>
          : cA ? <>Picked <b style={{color:'#7c8cff'}}>A · {lbl(cA)}</b> — now click another point for <b style={{color:'#4ade80'}}>B</b>.</>
          : <>Click the first {chartGran==='day'?'day':'week'} to set <b style={{color:'#7c8cff'}}>A</b>.</>}</span>
        {(cmp.a||cmp.b) && <button onClick={()=>setCmp({a:null,b:null})} style={{fontSize:11.5,fontWeight:600,padding:'4px 10px',borderRadius:7,cursor:'pointer',border:'1px solid var(--border-subtle)',background:'transparent',color:'var(--text-muted)'}}>✕ Clear</button>}
        <button onClick={()=>setCmp(defaultPair(panel))} title="Auto-pick the clearest pair: similar traffic, biggest CVR gap" style={{fontSize:11.5,fontWeight:600,padding:'4px 10px',borderRadius:7,cursor:'pointer',border:'1px solid var(--border-subtle)',background:'transparent',color:'var(--text-muted)'}}>↻ Best pair</button>
      </div>
      <div style={{cursor:'pointer'}}>
      <R.ResponsiveContainer width="100%" height={288}>
        <R.ComposedChart data={chartData} margin={{top:6,right:14,left:8,bottom:20}} onClick={(st)=>{ if(st && st.activeLabel!=null) pickPeriod(st.activeLabel); }}>
          <R.CartesianGrid stroke="#1f1f27" vertical={false}/>
          <R.XAxis dataKey="w" tickFormatter={fmtWk} tick={{fill:'#7e7e8a',fontSize:10.5}} interval={Math.ceil(chartData.length/9)} tickMargin={8} label={{value:chartGran==='day'?'Day':'Week', position:'insideBottom', offset:-10, fill:'#6f6f7b', fontSize:11}}/>
          <R.YAxis yAxisId="l" tick={{fill:'#7e7e8a',fontSize:11}} tickFormatter={v=>v+'%'} label={{value:'CVR (sessions→order)', angle:-90, position:'insideLeft', style:{textAnchor:'middle'}, fill:'#6f6f7b', fontSize:11}}/>
          <R.YAxis yAxisId="r" orientation="right" tick={{fill:'#7e7e8a',fontSize:11}} tickFormatter={v=>(v/1000).toFixed(0)+'k'} label={{value:'Sessions', angle:90, position:'insideRight', style:{textAnchor:'middle'}, fill:'#6f6f7b', fontSize:11}}/>
          {/* Hidden axis for the discount-depth overlay, scaled so the amber band sits in the lower ~45% — readable but never fighting the CVR line. */}
          <R.YAxis yAxisId="disc" hide domain={[0, (discMax||10)*2.2]}/>
          <R.Tooltip contentStyle={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:10,fontSize:12,boxShadow:'var(--shadow-md)'}} labelFormatter={w=>(chartGran==='day'?'':'Week of ')+fmtWk(w)} formatter={(v,n)=> (n==='CVR'||n==='Discount depth')?v+'%':NUM(v)}/>
          <R.Legend verticalAlign="top" align="center" wrapperStyle={{fontSize:12, paddingBottom:8}}/>
          <R.Bar yAxisId="r" dataKey="sessions" name="Sessions" fill="#26262e" maxBarSize={30}/>
          {/* Total discount depth (codes + sale prices) as a soft amber band; amber diamonds flag the deepest periods. */}
          {showDisc && <R.Area yAxisId="disc" type="monotone" dataKey="trueDiscountIntensity" name="Discount depth" stroke="#f5b544" strokeWidth={1.4} strokeOpacity={0.6} fill="#f5b544" fillOpacity={0.10} dot={discDot} activeDot={false} isAnimationActive={false} connectNulls/>}
          <R.Brush {...brushProps('w', fmtWk)} />
          <R.Line yAxisId="l" type="monotone" dataKey="cvr" name="CVR" stroke="#7c8cff" strokeWidth={2.5} dot={false}/>
          {/* Show, don't tell: the single CVR benchmark drawn on the chart so the gap is visible, not described. */}
          <R.ReferenceLine yAxisId="l" y={CVR_BENCH*100} stroke="#7c8cff" strokeDasharray="5 4" strokeOpacity={0.75}
            label={{value:`${CVR_BENCH_LABEL} CVR target`, position:'insideTopRight', fill:'#7c8cff', fontSize:10.5}}/>
          {/* The two selected periods, marked where you clicked — A (blue) vs B (green). */}
          {cmp.a && chartData.some(d=>d.w===cmp.a) && <R.ReferenceLine yAxisId="l" x={cmp.a} stroke="#7c8cff" strokeWidth={2} strokeOpacity={0.95}
            label={{value:'A', position:'top', fill:'#7c8cff', fontSize:12.5, fontWeight:800}}/>}
          {cmp.b && chartData.some(d=>d.w===cmp.b) && <R.ReferenceLine yAxisId="l" x={cmp.b} stroke="#4ade80" strokeWidth={2} strokeOpacity={0.95}
            label={{value:'B', position:'top', fill:'#4ade80', fontSize:12.5, fontWeight:800}}/>}
          {/* Event & sale pins: logged events + major site-wide sales, snapped to chart buckets.
              Icon-only on the chart; full detail lives on hover so the chart stays calm. */}
          {(function(){ var pins=buildChartPins(chartData.map(function(d){return d.w;}));
            return pins.map(function(p,i){ return (
              <R.ReferenceLine key={'pin'+i} yAxisId="l" x={p.x} stroke="#8b8b99" strokeDasharray="3 3" strokeOpacity={0.55}
                label={<PinMarker icon={p.icon} n={p.n} tip={p.tip}/>}/>); });
          })()}
        </R.ComposedChart>
      </R.ResponsiveContainer>
      </div>
      <div style={{fontSize:10.5,color:'var(--text-faint)',textAlign:'right',marginTop:2}}>{BRUSH_HINT}</div>
      {(function(){ var pins=buildChartPins(chartData.map(function(d){return d.w;})); if(!pins.length) return null; return (
        <div className="micro" style={{color:'var(--text-faint)',marginTop:4}}>🏷️ sales &amp; promos · 📌 your events — <span style={{color:'var(--text-muted)'}}>hover any marker for what it was</span></div>); })()}
      {showDisc && _dv.length>0 && <div className="micro" style={{color:'var(--text-faint)',marginTop:4}}>
        <span style={{color:'#f5b544',fontWeight:600}}>◆ amber band = total discount depth</span> (codes + automatic + sale prices, % of sales) · <span style={{color:'#f5b544'}}>◆ diamonds</span> = the deepest {chartGran==='day'?'days':'weeks'} (≥{Math.round(discThr)}%, top quartile). Line up the amber peaks against CVR to see whether a deep promo actually moved conversion{chartGran==='day'?'':' — heavy always-on discounting can flatten the link, so look for the spikes'}.</div>}
      {showDisc && discLift && (()=>{ const L=discLift; const big=Math.abs(L.pct||0)>=0.05; const pos=L.pp>=0; const col=!big?'var(--text-muted)':(pos?'#4ade80':'#ef6b6f');
        const unit=chartGran==='day'?'days':'weeks';
        const verdict = !big
          ? `Deep-discount ${unit} convert about the same as the rest — discounting isn't buying conversion here.`
          : pos
            ? `Deep-discount ${unit} convert ${Math.abs(L.pct*100).toFixed(0)}% higher — worth a look, but check it isn't just traffic mix or seasonality.`
            : `Deep-discount ${unit} convert ${Math.abs(L.pct*100).toFixed(0)}% lower — promos aren't lifting conversion.`;
        return (<div style={{marginTop:10,padding:'11px 13px',borderRadius:10,background:'rgba(245,181,68,0.06)',border:'1px solid rgba(245,181,68,0.22)'}}>
          <div style={{display:'flex',alignItems:'baseline',gap:8,flexWrap:'wrap',marginBottom:7}}>
            <span style={{fontSize:11,textTransform:'uppercase',letterSpacing:'.04em',color:'#f5b544',fontWeight:700}}>◆ Discount lift</span>
            <span style={{fontSize:11.5,color:'var(--text-faint)'}}>mean CVR on the deepest-discount {unit} vs the rest · this range</span>
          </div>
          <div style={{display:'flex',gap:16,flexWrap:'wrap',alignItems:'center'}}>
            <div><div style={{fontSize:10,color:'var(--text-faint)',textTransform:'uppercase',letterSpacing:'.03em'}}>Deepest {L.deepN} · avg {Math.round(L.deepDisc)}% off</div><div style={{fontSize:19,fontWeight:700,color:'#f5b544'}}>{L.deepCvr.toFixed(2)}%</div></div>
            <div style={{fontSize:15,color:'var(--text-faint)'}}>vs</div>
            <div><div style={{fontSize:10,color:'var(--text-faint)',textTransform:'uppercase',letterSpacing:'.03em'}}>Other {L.restN} · avg {Math.round(L.restDisc)}% off</div><div style={{fontSize:19,fontWeight:700}}>{L.restCvr.toFixed(2)}%</div></div>
            <div style={{fontSize:15,color:'var(--text-faint)'}}>→</div>
            <div><div style={{fontSize:10,color:'var(--text-faint)',textTransform:'uppercase',letterSpacing:'.03em'}}>Lift</div><div style={{fontSize:19,fontWeight:800,color:col}}>{L.pp>=0?'+':''}{L.pp.toFixed(2)}pp{L.pct!=null?` (${L.pp>=0?'+':''}${Math.round(L.pct*100)}%)`:''}</div></div>
          </div>
          <div style={{fontSize:11.5,color:'var(--text-muted)',marginTop:8}}>{verdict} <span style={{color:'var(--text-faint)'}}>Observational, not causal — deep-discount {unit} can also differ in traffic mix, season and email volume. Click a deep-discount point vs a normal one below to inspect a specific pair.</span></div>
        </div>); })()}
      <ChartFooter note={`Is conversion holding above the ${CVR_BENCH_LABEL} target? A falling line on rising sessions usually means traffic-mix, not the site.`}
        ask="Looking at the weekly conversion-rate trend vs sessions, what's driving CVR and is it a site problem or a traffic-mix one?"
        rows={chartData} columns={[
          {key:'w', label:'Week', fmt:v=>fmtWk(v)},
          {key:'cvr', label:'CVR', right:true, fmt:v=>v!=null?v+'%':'—'},
          {key:'sessions', label:'Sessions', right:true, fmt:v=>NUM(v)},
        ]}/>
    </div>

    <div className="card" style={{marginBottom:14}}>
      <div className="card-section-title"><h2 style={{margin:0}}>Compare two {gran==='day'?'days':'weeks'}</h2>
        <span className="meta">click two points on the trend chart above — biggest differences flagged automatically</span></div>
      <div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'center',marginBottom:10}}>
        {cA && cB
          ? <div style={{fontSize:12.5,color:'var(--text-muted)'}}>Comparing <b style={{color:'#7c8cff'}}>{lbl(cA)}</b> <span style={{color:'var(--text-faint)'}}>vs</span> <b style={{color:'#4ade80'}}>{lbl(cB)}</b></div>
          : <div style={{fontSize:12.5,color:'var(--text-faint)'}}>↑ Click two points on the chart above to pick the {gran==='day'?'days':'weeks'} to compare.</div>}
        <button onClick={()=>setCmp(defaultPair(panel))} title="Auto-pick the clearest pair: similar traffic, biggest CVR gap" style={{fontSize:12,fontWeight:600,padding:'6px 12px',borderRadius:8,cursor:'pointer',border:'1px solid var(--border-subtle)',background:'transparent',color:'var(--text-muted)'}}>↻ Best pair</button>
        {(cmp.a||cmp.b) && <button onClick={()=>setCmp({a:null,b:null})} style={{fontSize:12,fontWeight:600,padding:'6px 12px',borderRadius:8,cursor:'pointer',border:'1px solid var(--border-subtle)',background:'transparent',color:'var(--text-muted)'}}>✕ Clear</button>}
      </div>
      {gran==='week' && STAT.cleanPairs && STAT.cleanPairs.length>0 && <div style={{marginBottom:12}}>
        <div style={{fontSize:10.5,textTransform:'uppercase',letterSpacing:'.04em',color:'var(--text-faint)',marginBottom:5}}>Cleanest tests — matched traffic, one lever differs <span title="Week pairs where traffic mix (new/paid/mobile share) and volume are near-identical, so the CVR gap is mostly attributable to the single lever shown. The lowest-confound comparisons in your data — the closest thing to a natural experiment." style={{cursor:'help',color:'var(--text-muted)'}}>ⓘ</span></div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>{STAT.cleanPairs.map((p,i)=>{ const A=byW[p.a],B=byW[p.b]; if(!A||!B) return null; const f=(t,v)=> t==='pct'?Math.round(v)+'%': t==='gbp'?GBP(v): NUM(v);
          return (<button key={i} onClick={()=>setCmp({a:p.a,b:p.b})} title="Load this low-confound pair" style={{fontSize:11.5,padding:'5px 10px',borderRadius:8,cursor:'pointer',border:'1px solid rgba(110,231,183,0.3)',background:'rgba(110,231,183,0.08)',color:'var(--text-secondary)',textAlign:'left'}}>
            <b style={{color:'#6ee7b7'}}>{p.lever.lab}</b> {f(p.lever.t,p.lever.a)}→{f(p.lever.t,p.lever.b)} <span style={{color:'var(--text-faint)'}}>· {fmtWk(p.a)} vs {fmtWk(p.b)} · ΔCVR {p.cvrGap.toFixed(2)}pp</span>
          </button>); })}</div>
      </div>}
      {cA&&cB&&<>
        <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:12}}>
          {tile(lbl(cA), cA.cvr+'%', `${NUM(cA.orders)}/${NUM(cA.sessions)} · 95% CI ${ciA?(ciA.lo*100).toFixed(2)+'–'+(ciA.hi*100).toFixed(2)+'%':'—'}`, cA.cvr>=cB.cvr?'#4ade80':'var(--text-primary)')}
          {tile(lbl(cB), cB.cvr+'%', `${NUM(cB.orders)}/${NUM(cB.sessions)} · 95% CI ${ciB?(ciB.lo*100).toFixed(2)+'–'+(ciB.hi*100).toFixed(2)+'%':'—'}`, cB.cvr>=cA.cvr?'#4ade80':'var(--text-primary)')}
          {tile('CVR gap', `${(Math.abs(cA.cvr-cB.cvr)).toFixed(2)}pp`, gapSig?(gapSig.p<0.05?`${pTxt(gapSig.p)} — a real difference`:`${pTxt(gapSig.p)} — within sampling noise`):'', gapSig?(gapSig.p<0.05?'#4ade80':'#f5b544'):'#9aa6ff')}
        </div>
        {movers.length>0 && <div style={{marginBottom:10}}>
          <div style={{fontSize:11,textTransform:'uppercase',letterSpacing:'.04em',color:'var(--text-faint)',marginBottom:5}}>Biggest differences</div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>{movers.map(m=>(<span key={m.k} style={{fontSize:12,background:'rgba(124,140,255,0.12)',border:'1px solid rgba(124,140,255,0.3)',borderRadius:999,padding:'3px 10px'}}><b>{m.l}</b> {fmtVal(m.t,m.a)} <span style={{color:'var(--text-faint)'}}>→</span> {fmtVal(m.t,m.b)}</span>))}</div>
        </div>}
        {/* Why the difference — deterministic read of the metric algorithm: funnel split + driver classification + confound-aware verdict, with a handoff to the live assistant. */}
        {cmpStory && (()=>{ const S=cmpStory; const vcol = S.topKind==='site'||S.topKind==='checkout'?'#4ade80' : S.topKind==='offer'?'#f5b544' : S.topKind==='mix'||S.topKind==='device'?'#9aa6ff' : 'var(--text-muted)';
          const u=gran==='day'?'day':'week';
          return (<div style={{marginBottom:12,padding:'13px 15px',borderRadius:12,background:'rgba(124,140,255,0.06)',border:'1px solid rgba(124,140,255,0.22)'}}>
            <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',marginBottom:8}}>
              <span style={{fontSize:11,textTransform:'uppercase',letterSpacing:'.04em',color:'#9aa6ff',fontWeight:700}}>✦ Why the difference — likely drivers</span>
              <span style={{fontSize:11,color:'var(--text-faint)'}} title={agentTitle('Pulse')}>◆ Pulse · auto-diagnosis from the metric model</span>
            </div>
            {gapSig && (gapSig.p<0.05
              ? <div style={{fontSize:11.5,color:'#4ade80',marginBottom:8,fontWeight:600}}>✓ The CVR gap is statistically real ({pTxt(gapSig.p)}, two-proportion test) — worth explaining.</div>
              : <div style={{fontSize:12,color:'#f5b544',marginBottom:8,padding:'7px 10px',borderRadius:8,background:'rgba(245,181,68,0.08)',border:'1px solid rgba(245,181,68,0.25)'}}>⚠ This CVR gap is within sampling noise ({pTxt(gapSig.p)}) — only {NUM(cA.orders)} vs {NUM(cB.orders)} orders on these {gran==='day'?'days':'weeks'}. Treat the read below as a weak hypothesis, not a finding; a wider-apart or higher-volume pair gives a cleaner signal.</div>)}
            {S.tiny
              ? <div style={{fontSize:12.5,color:'var(--text-muted)'}}>CVR is essentially flat between these two ({S.pp>=0?'+':''}{S.pp}pp). The inputs below shifted but netted out — there's no real conversion difference to explain. Pick a wider-apart pair to see a driver story.</div>
              : <div style={{fontSize:12.5,color:'var(--text-secondary)',lineHeight:1.55}}>
                  <div style={{marginBottom:6}}><b style={{color:'#7c8cff'}}>1 · Where in the funnel.</b> The <b style={{color:S.up?'#4ade80':'#ef6b6f'}}>{S.up?'+':''}{S.pp}pp</b> move is mostly at <b>{S.lead.label}</b> ({Math.round(Math.min(Math.abs(S.lead.share),1)*100)}% of it{S.offset?<>, partly offset by <b>{S.offset.label}</b></>:''}) — {(+S.lead.a).toFixed(1)}% → {(+S.lead.b).toFixed(1)}%.</div>
                  <div style={{marginBottom:6}}><b style={{color:'#7c8cff'}}>2 · What moved with it.</b> {S.consistent.length
                    ? <>{S.consistent.map((d,i)=><span key={d.k}>{i>0?'; ':''}<b>{cmLabel[d.k]}</b> {fmtMetric(d.k,d.a)}→{fmtMetric(d.k,d.b)} <span style={{color:'var(--text-faint)'}}>({d.phrase})</span></span>)}.</>
                    : <span style={{color:'var(--text-muted)'}}>nothing else moved much — the tracked inputs don't explain this gap, so suspect data noise or an untracked factor.</span>}</div>
                  {S.against.length>0 && <div style={{marginBottom:6}}><b style={{color:'#7c8cff'}}>3 · Against the grain.</b> {S.against.map((d,i)=><span key={d.k}>{i>0?'; ':''}<b>{cmLabel[d.k]}</b> {fmtMetric(d.k,d.a)}→{fmtMetric(d.k,d.b)}</span>)} usually push{S.against.length>1?'':'es'} CVR the other way — so the {S.up?'gain':'drop'} happened <i>despite</i> {S.against.length>1?'them':'it'}, which sharpens the diagnosis.</div>}
                  {S.verdict && <div style={{marginTop:8,paddingTop:8,borderTop:'1px solid var(--border-subtle)'}}><b style={{color:vcol}}>Likely driver:</b> <span style={{color:'var(--text-secondary)'}}>{S.verdict}</span> <span style={{color:'var(--text-faint)'}}>{sessClose?'Sessions are near-identical, so this is a relatively clean read.':'Sessions differ a lot here — volume itself shifts the mix, so read with care.'} Two periods is correlation, not proof.</span></div>}
                  {STAT.resid && STAT.resid.byW[cmp.b] && (()=>{ const rB=STAT.resid.byW[cmp.b]; const unexp=Math.abs(rB.z)>=1.3;
                    return (<div style={{marginTop:6,fontSize:11.5,color:'var(--text-faint)'}}><b style={{color:unexp?'#9aa6ff':'var(--text-muted)'}}>Mix-adjusted:</b> after modelling CVR from traffic warmth (new-visitor share), {lbl(cB)} lands <b style={{color:rB.e>=0?'#4ade80':'#ef6b6f'}}>{rB.e>=0?'+':''}{rB.e.toFixed(2)}pp</b> vs expected ({(rB.exp).toFixed(2)}%) — {unexp?'a genuinely un-modelled move, the kind worth a controlled test':'about what the model predicts, so most of the gap is explained by the inputs'}.</div>); })()}
                </div>}
            <div onClick={cmpAskAI} style={{marginTop:9,fontSize:12,color:'#9aa6ff',cursor:'pointer',fontWeight:600}}>✦ Ask AI to dig deeper into this pair →</div>
          </div>); })()}
        <div style={{overflowX:'auto'}}>
        <table style={{width:'100%',borderCollapse:'collapse',fontSize:12.5}}>
          <thead><tr style={{textAlign:'left',color:'var(--text-faint)',fontSize:11,textTransform:'uppercase',letterSpacing:'.04em'}}>
            <th style={{padding:'5px 8px 5px 0'}}>Metric</th><th style={{padding:'5px 8px',textAlign:'right'}}>{lbl(cA)}</th><th style={{padding:'5px 8px',textAlign:'right'}}>{lbl(cB)}</th><th style={{padding:'5px 8px',textAlign:'right'}}>Δ</th></tr></thead>
          <tbody>{['Funnel stage','Traffic & behaviour','Device, geography & source','Checkout & payment','Commercial'].map(g=>(<React.Fragment key={g}>
            <tr><td colSpan={4} style={{padding:'8px 0 3px',fontSize:10.5,textTransform:'uppercase',letterSpacing:'.05em',color:'#7c8cff'}}>{g}</td></tr>
            {cmpRows.filter(r=>r.g===g).map(r=>{ const big=moverKeys.has(r.k); return (<tr key={r.k} style={{borderTop:'1px solid var(--border-subtle)',background:big?'rgba(124,140,255,0.06)':'transparent'}}>
              <td style={{padding:'6px 8px 6px 8px',fontWeight:big?700:500,borderLeft:big?'2px solid #7c8cff':'2px solid transparent'}}>{r.l}</td>
              <td style={{padding:'6px 8px',textAlign:'right',color:'var(--text-muted)'}}>{fmtVal(r.t,r.a)}</td>
              <td style={{padding:'6px 8px',textAlign:'right',fontWeight:big?700:500}}>{fmtVal(r.t,r.b)}</td>
              <td style={{padding:'6px 8px',textAlign:'right',color:big?'#9aa6ff':'var(--text-faint)'}}>{dlt(r)}</td></tr>); })}
          </React.Fragment>))}</tbody>
        </table></div>

        {Object.keys(cA.landing||{}).length>0 && (()=>{ const types=[...new Set([...Object.keys(cA.landing||{}),...Object.keys(cB.landing||{})])].sort((x,y)=>((cB.landing[y]||{}).share||0)-((cB.landing[x]||{}).share||0));
          return (<div style={{marginTop:14}}>
            <div style={{fontSize:11,textTransform:'uppercase',letterSpacing:'.04em',color:'#7c8cff',marginBottom:4}}>Landing pages — where they entered (share · CVR within type)</div>
            <div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse',fontSize:12.5}}>
              <thead><tr style={{textAlign:'left',color:'var(--text-faint)',fontSize:10.5,textTransform:'uppercase',letterSpacing:'.04em'}}><th style={{padding:'4px 8px 4px 0'}}>Type</th><th style={{padding:'4px 8px',textAlign:'right'}}>{lbl(cA)} share</th><th style={{padding:'4px 8px',textAlign:'right'}}>{lbl(cB)} share</th><th style={{padding:'4px 8px',textAlign:'right'}}>{lbl(cA)} CVR</th><th style={{padding:'4px 8px',textAlign:'right'}}>{lbl(cB)} CVR</th></tr></thead>
              <tbody>{types.map(t=>{ const A=cA.landing[t]||{}, B=cB.landing[t]||{}; const cg=(B.cvr||0)-(A.cvr||0); return (<tr key={t} style={{borderTop:'1px solid var(--border-subtle)'}}>
                <td style={{padding:'5px 8px 5px 0',fontWeight:600}}>{t}</td>
                <td style={{padding:'5px 8px',textAlign:'right',color:'var(--text-muted)'}}>{A.share!=null?A.share+'%':'—'}</td>
                <td style={{padding:'5px 8px',textAlign:'right',color:'var(--text-muted)'}}>{B.share!=null?B.share+'%':'—'}</td>
                <td style={{padding:'5px 8px',textAlign:'right',color:'var(--text-muted)'}}>{A.cvr!=null?A.cvr+'%':'—'}</td>
                <td style={{padding:'5px 8px',textAlign:'right'}}><b>{B.cvr!=null?B.cvr+'%':'—'}</b> {A.cvr!=null&&B.cvr!=null&&<span style={{color:cg>=0?'#4ade80':'#ef6b6f',fontSize:11}}>{cg>=0?'+':''}{cg.toFixed(2)}</span>}</td></tr>); })}</tbody>
            </table></div>
            <div style={{fontSize:11,color:'var(--text-faint)',marginTop:3}}>If the <b>share</b> is similar but <b>CVR moves inside every type</b>, the cause is site-wide (checkout/offer/tracking), not where people landed.</div>
          </div>); })()}

        {((cA.landTop||[]).length>0 || (cB.landTop||[]).length>0) && <div style={{marginTop:14}}>
          <div style={{fontSize:11,textTransform:'uppercase',letterSpacing:'.04em',color:'#7c8cff',marginBottom:4}}>Top landing pages — specific URLs (sessions · CVR)</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(300px,1fr))',gap:16}}>
            {[[lbl(cA),cA.landTop||[]],[lbl(cB),cB.landTop||[]]].map((pair,i)=>(<div key={i}>
              <div style={{fontSize:11.5,fontWeight:600,color:'var(--text-secondary)',marginBottom:2}}>{pair[0]}</div>
              {pair[1].length?pair[1].map(p=>(<div key={p.url} style={{display:'flex',justifyContent:'space-between',gap:8,padding:'4px 0',borderTop:'1px solid var(--border-subtle)',fontSize:12}}>
                <span style={{overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',flex:1}} title={p.url}><span style={{color:'var(--text-primary)'}}>{p.url}</span>{p.oos&&<span style={{marginLeft:6,fontSize:9.5,fontWeight:700,color:'#ef6b6f',background:'rgba(239,107,111,0.15)',border:'1px solid rgba(239,107,111,0.4)',borderRadius:4,padding:'0 4px'}}>OOS</span>}</span>
                <span style={{whiteSpace:'nowrap',color:'var(--text-muted)'}}>{NUM(p.sessions)} · <b style={{color:p.cvr>=1.5?'#4ade80':(p.cvr<0.4?'#ef6b6f':'var(--text-secondary)')}}>{p.cvr}%</b></span>
              </div>)):<div style={{fontSize:12,color:'var(--text-muted)',padding:'4px 0'}}>—</div>}
            </div>))}
          </div>
          <div style={{fontSize:11,color:'var(--text-faint)',marginTop:3}}>Watch for pages pulling big traffic at <b style={{color:'#ef6b6f'}}>near-zero CVR</b> — cold campaigns or <b style={{color:'#ef6b6f'}}>out-of-stock</b> PDPs leaking spend (e.g. an ad sending traffic to an OOS product). OOS = the product is currently out of stock.</div>
        </div>}

        {((cA.topProducts||[]).length>0 || (cB.topProducts||[]).length>0) && <div style={{marginTop:14}}>
          <div style={{fontSize:11,textTransform:'uppercase',letterSpacing:'.04em',color:'#7c8cff',marginBottom:4}}>Top products purchased (web · units · % of units)</div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(240px,1fr))',gap:16}}>
            {[[lbl(cA),cA.topProducts||[]],[lbl(cB),cB.topProducts||[]]].map((pair,i)=>(<div key={i}>
              <div style={{fontSize:11.5,fontWeight:600,color:'var(--text-secondary)',marginBottom:2}}>{pair[0]}</div>
              {pair[1].length?pair[1].map(p=>(<div key={p.name} style={{display:'flex',justifyContent:'space-between',gap:8,padding:'4px 0',borderTop:'1px solid var(--border-subtle)',fontSize:12}}><span style={{color:'var(--text-primary)',overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.name}</span><span style={{color:'var(--text-muted)',whiteSpace:'nowrap'}}>{NUM(p.units)} · {p.share}%</span></div>)):<div style={{fontSize:12,color:'var(--text-muted)',padding:'4px 0'}}>—</div>}
            </div>))}
          </div></div>}

        <div className="note" style={{marginTop:14}}>{hiW&&loW&&<>The <b>{lbl(hiW)}</b> {gran==='day'?'day':'week'} converted <b>{hiW.cvr}%</b> vs <b>{loW.cvr}%</b>{sessClose?' on near-identical traffic':''}. Clearest differences: {movers.length?movers.map((m,i)=>`${m.l.toLowerCase()} ${fmtVal(m.t,m.a)}→${fmtVal(m.t,m.b)}`).join(', '):'none stand out'}. Funnel-stage gaps are mechanical; landing/traffic gaps suggest <i>why</i>. {gran==='day'?<b>Daily samples are small — read day-vs-day as a hint, not proof.</b>:'Still correlation within two periods — the lead, not proof.'}</>}</div>
      </>}
    </div>

    <div className="card" style={{marginBottom:14}}>
      <div className="card-section-title"><h2 style={{margin:0}}>1 · Where in the funnel it moved</h2>
        <span className="meta">CVR = session→cart × cart→checkout × checkout→purchase — strongest evidence (structural)</span></div>
      <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>{STAGES.map(stageCard)}</div>
      <div className="note" style={{marginTop:12}}>This splits CVR into its three multiplicative stages and shows which one actually moved — the most causal view available, because it's arithmetic, not correlation. {M.stageContribution[M.moverStage]>=0.5?<>Here <b>{Math.round(M.stageContribution[M.moverStage]*100)}%</b> of the change sits at <b>{M.moverStage}</b> — start the investigation there.</>:null}</div>
    </div>

    <div className="card" style={{marginBottom:14}}>
      <div className="card-section-title"><h2 style={{margin:0}}>2 · Traffic mix, or the site itself?</h2>
        <span className="meta">controls the #1 confounder — a CVR move that's really just colder/warmer traffic</span></div>
      <div className="note" style={{marginBottom:10}}>Of the <b>{M.deltaCVR>=0?'+':''}{M.deltaCVR}pp</b> change, <b style={{color:'#f5b544'}}>{M.mixEffect>=0?'+':''}{M.mixEffect}pp</b> is <b>traffic mix</b> (sending more/less of higher-converting channels) and <b style={{color:up?'#4ade80':'#ef6b6f'}}>{M.rateEffect>=0?'+':''}{M.rateEffect}pp</b> is <b>within-channel</b> (each channel converting differently). {mixDom?'So this is largely a mix shift — be careful calling it a site win.':<>So this is <b>real</b> — channels are genuinely converting {up?'better':'worse'}{channels.length&&Math.max(...channels.map(c=>c.shareNow-c.sharePrev))>3?', even against a rising paid-traffic share':''}.</>}</div>
      <div style={{overflowX:'auto'}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:12.5}}>
        <thead><tr style={{textAlign:'left',color:'var(--text-faint)',fontSize:11,textTransform:'uppercase',letterSpacing:'.04em'}}>
          <th style={{padding:'5px 8px 5px 0'}}>Channel</th><th style={{padding:'5px 8px',textAlign:'right'}}>Share (prev→now)</th><th style={{padding:'5px 8px',textAlign:'right'}}>CVR (prev→now)</th></tr></thead>
        <tbody>{channels.map(c=>{ const cg=c.cvrNow-c.cvrPrev; return (<tr key={c.name} style={{borderTop:'1px solid var(--border-subtle)'}}>
          <td style={{padding:'6px 8px 6px 0',fontWeight:600}}>{c.name}</td>
          <td style={{padding:'6px 8px',textAlign:'right',color:'var(--text-muted)'}}>{c.sharePrev}% → {c.shareNow}%</td>
          <td style={{padding:'6px 8px',textAlign:'right'}}>{c.cvrPrev}% → <b>{c.cvrNow}%</b> <span style={{color:cg>=0?'var(--good)':'var(--bad)',fontSize:11}}>{cg>=0?'+':''}{cg.toFixed(2)}</span></td></tr>); })}</tbody>
      </table></div>
    </div>

    <button onClick={()=>setShowStats(s=>!s)} style={{display:'flex',alignItems:'center',gap:8,width:'100%',background:'transparent',border:'1px solid var(--border-subtle)',borderRadius:10,padding:'11px 14px',cursor:'pointer',textAlign:'left',marginBottom:showStats?0:14}}>
      <span style={{color:'var(--text-faint)',display:'inline-flex',transform:showStats?'rotate(90deg)':'none',transition:'transform 120ms'}}><Icon name="chevron" size={13}/></span>
      <span style={{fontWeight:700,color:'var(--text-primary)',fontSize:13.5}}>Show the statistics</span>
      <span className="muted" style={{fontSize:11.5}}>correlation scan + mix-adjusted partial correlations — methodology, on demand</span>
      <span style={{marginLeft:'auto',fontSize:11.5,color:'var(--accent)',fontWeight:600}}>{showStats?'Hide':'Show'}</span>
    </button>
    {showStats && (<div>
    <div className="card">
      <div className="card-section-title"><h2 style={{margin:0}}>3 · What correlates with daily CVR</h2>
        <span className="meta">ranked by strength · green = moves with CVR, red = against · ⚑ = likely confounded by traffic mix</span></div>
      <div style={{marginTop:4}}>{drivers.map(d=>(<div key={d.key} style={{padding:'6px 0',borderTop:'1px solid var(--border-subtle)'}}>
        <div style={{display:'grid',gridTemplateColumns:'180px 1fr 118px',gap:10,alignItems:'center'}}>
          <div style={{fontSize:12.5,fontWeight:600}}>{d.label}{d.confound&&<span title="moves with traffic mix — likely confounded" style={{marginLeft:5,fontSize:10,color:'#f5b544'}}>⚑</span>}</div>
          {barCell(d)}
          <div style={{fontSize:11.5,textAlign:'right'}}><b style={{color:d.dir==='up'?'#4ade80':'#ef6b6f'}}>{d.r>0?'+':''}{d.r.toFixed(2)}</b> <span style={{color:'var(--text-faint)'}}>n={d.n}{d.significant?'':' · ns'}</span></div>
        </div>
        <div style={{fontSize:11,color:'var(--text-faint)',marginTop:2}}>{d.note}</div>
      </div>))}</div>
      <div className="note" style={{marginTop:12}}><b>Correlation ≠ causation.</b> This ranks what moves <i>with</i> CVR day-to-day; the funnel and mix sections above are stronger evidence. ⚑-flagged drivers (paid share, new-visitor share, traffic volume, spend) mostly reflect <i>who</i> is visiting, not a site lever. <b>Next:</b> {test} <span style={{color:'var(--text-faint)'}}>Significance: |r| past the ~95% line for the sample (n shown); “ns” = not significant. Bounce ≈ 1−engagement, so they’re one signal shown twice.</span></div>
    </div>

    <div className="card" style={{marginTop:14}}>
      <div className="card-section-title"><h2 style={{margin:0}}>4 · Deeper signal <span style={{color:'var(--text-faint)',fontWeight:400,fontSize:13}}>— what survives the confounds</span></h2>
        <span className="meta">Pulse · partial correlations + an expected-CVR model{STAT.drivers[0]?` · n=${STAT.drivers[0].n} ${seriesDaily.length>=12?'days':'weeks'}`:''}</span></div>
      {STAT.drivers.length>0 ? <>
      <div style={{fontSize:11,textTransform:'uppercase',letterSpacing:'.04em',color:'#7c8cff',marginBottom:6}}>Levers, mix-adjusted — independent link to CVR after holding new-visitor share constant</div>
      <div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse',fontSize:12.5}}>
        <thead><tr style={{textAlign:'left',color:'var(--text-faint)',fontSize:10.5,textTransform:'uppercase',letterSpacing:'.04em'}}>
          <th style={{padding:'4px 8px 4px 0'}}>Lever</th><th style={{padding:'4px 8px',textAlign:'right'}}>Raw r</th><th style={{padding:'4px 8px',width:120}}>Mix-adjusted</th><th style={{padding:'4px 8px',textAlign:'right'}}>Adj r</th><th style={{padding:'4px 8px'}}></th></tr></thead>
        <tbody>{STAT.drivers.map(d=>{ const w=Math.round(Math.min(Math.abs(d.adj),1)*46); const pos=d.adj>=0; const col=d.sig?(pos?'#4ade80':'#ef6b6f'):'var(--text-faint)';
          const collapsed=Math.abs(d.raw)>=0.12 && Math.abs(d.adj)<Math.abs(d.raw)*0.5;
          return (<tr key={d.k} style={{borderTop:'1px solid var(--border-subtle)'}}>
            <td style={{padding:'6px 8px 6px 0',fontWeight:600}}>{d.label}{!d.sig&&<span style={{color:'var(--text-faint)',fontWeight:400,fontSize:10.5}}> · ns</span>}</td>
            <td style={{padding:'6px 8px',textAlign:'right',color:'var(--text-faint)'}}>{d.raw>=0?'+':''}{d.raw.toFixed(2)}</td>
            <td style={{padding:'6px 8px'}}><div style={{position:'relative',height:12,background:'var(--surface-2,#15151b)',borderRadius:3}}><div style={{position:'absolute',left:'50%',top:0,bottom:0,width:1,background:'#3a3a44'}}/><div style={{position:'absolute',top:2,bottom:2,borderRadius:2,background:col,left:(pos?50:(50-w))+'%',width:w+'%'}}/></div></td>
            <td style={{padding:'6px 8px',textAlign:'right',fontWeight:700,color:col}}>{d.adj>=0?'+':''}{d.adj.toFixed(2)}</td>
            <td style={{padding:'6px 8px',fontSize:10.5,color:collapsed?'#f5b544':'var(--text-faint)'}}>{collapsed?'mostly mix':(d.sig?'holds':'')}</td>
          </tr>); })}</tbody>
      </table></div>
      <div className="note" style={{marginTop:8}}>Each lever's correlation with daily CVR <b>after partialling out new-visitor share</b> — the dominant traffic-mix confound (it alone correlates r≈−0.46 with CVR). Where the adjusted figure holds near the raw one, the signal is genuinely that lever; where it collapses toward 0 (<span style={{color:'#f5b544'}}>“mostly mix”</span>), the raw correlation was really just <i>who</i> visited. This is the honest read on what's actually moveable. “ns” = not significant at n shown.</div>
      </> : <div className="note">Not enough clean daily history yet to separate levers from traffic mix.</div>}

      {STAT.resid && <div style={{marginTop:16}}>
        <div style={{fontSize:11,textTransform:'uppercase',letterSpacing:'.04em',color:'#7c8cff',marginBottom:6}}>Unexplained CVR weeks — actual vs an expected-CVR model</div>
        {STAT.resid.list.length? <div style={{display:'flex',flexDirection:'column',gap:6}}>{STAT.resid.list.map(r=>{ const pos=r.e>=0;
          return (<div key={r.w} style={{display:'flex',justifyContent:'space-between',gap:10,padding:'6px 10px',borderRadius:8,background:'var(--surface-1,#111116)',border:'1px solid var(--border-subtle)'}}>
            <span><b>{fmtWk(r.w)}</b> <span style={{color:'var(--text-faint)'}}>actual {r.act.toFixed(2)}% vs expected {r.exp.toFixed(2)}%</span></span>
            <span style={{fontWeight:700,color:pos?'#4ade80':'#ef6b6f'}}>{pos?'+':''}{r.e.toFixed(2)}pp unexplained</span>
          </div>); })}</div>
          : <div className="note">No week deviates much from the model — over this window CVR is well-explained by traffic mix + discount, so there's no off-model anomaly to chase.</div>}
        <div className="note" style={{marginTop:8}}>Expected CVR is modelled from new-visitor share (how cold the week's traffic was); big residuals are weeks where <b>something other than traffic warmth</b> moved CVR — a site change, a tracking break, a one-off promo — i.e. the genuine “investigate this” list, already stripped of the mix confound. Click a flagged week on the chart above to compare it.</div>
      </div>}
    </div>
    </div>)}
  </div>);
}

// Product Signal (Pulse) — the per-product quadrant + opportunities view (Commerce tab).
// ── Interactive chart zoom + pan (Products deep-dive) ────────────────────────
// Investigate scatter detail like a map: drag to pan, mouse-wheel to zoom toward
// the cursor, +/−/Reset controls, double-click to reset. Controlled numeric
// domains drive the chart's X/Y axes; allowDataOverflow clips points outside the
// current window. Domains clamp to the data extents so you can't pan into a void.
function useChartZoom(fx0, fx1, fy0, fy1){
  const [v, setV] = useState([fx0, fx1, fy0, fy1]);
  const wrapRef = React.useRef(null);
  const drag = React.useRef(null);
  React.useEffect(()=>{ setV([fx0, fx1, fy0, fy1]); }, [fx0, fx1, fy0, fy1]);
  const minX=(fx1-fx0)*0.05||1, minY=(fy1-fy0)*0.05||1;
  const clampX=(a,b)=>{ if(b-a<minX){const m=(a+b)/2; a=m-minX/2; b=m+minX/2;} if(a<fx0){b+=fx0-a;a=fx0;} if(b>fx1){a-=b-fx1;b=fx1;} return [Math.max(a,fx0),Math.min(b,fx1)]; };
  const clampY=(a,b)=>{ if(b-a<minY){const m=(a+b)/2; a=m-minY/2; b=m+minY/2;} if(a<fy0){b+=fy0-a;a=fy0;} if(b>fy1){a-=b-fy1;b=fy1;} return [Math.max(a,fy0),Math.min(b,fy1)]; };
  const zoom=(f, rx, ry)=>setV(([a,b,c,d])=>{
    const fpx=a+(b-a)*rx, fpy=d-(d-c)*ry;                 // focal point (ry: 0 = top)
    const [na,nb]=clampX(fpx-(fpx-a)*f, fpx+(b-fpx)*f);
    const [nc,nd]=clampY(fpy-(fpy-c)*f, fpy+(d-fpy)*f);
    return [na,nb,nc,nd];
  });
  React.useEffect(()=>{
    const el=wrapRef.current; if(!el) return;
    const onWheel=(e)=>{
      // Plain scroll must scroll the PAGE — only zoom on pinch (trackpad sends
      // ctrlKey) or an explicit Ctrl/⌘-scroll. Otherwise let the event bubble.
      if(!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const r=el.getBoundingClientRect();
      const rx=Math.min(1,Math.max(0,(e.clientX-r.left)/r.width)), ry=Math.min(1,Math.max(0,(e.clientY-r.top)/r.height));
      // Gentle, delta-proportional step (clamped) so a pinch glides instead of snapping.
      const f=Math.min(1.12, Math.max(0.89, Math.pow(1.0016, e.deltaY)));
      zoom(f, rx, ry);
    };
    el.addEventListener('wheel', onWheel, {passive:false});
    return ()=>el.removeEventListener('wheel', onWheel);
  }, [fx0, fx1, fy0, fy1]);
  const onMouseDown=(e)=>{ const el=wrapRef.current; if(!el) return; drag.current={x:e.clientX, y:e.clientY, v:v.slice(), r:el.getBoundingClientRect()}; };
  const onMouseMove=(e)=>{ const d=drag.current; if(!d) return; const dx=(e.clientX-d.x)/d.r.width, dy=(e.clientY-d.y)/d.r.height;
    const [a,b,c,dd]=d.v; const sx=b-a, sy=dd-c;
    const [na,nb]=clampX(a-dx*sx, b-dx*sx); const [nc,nd]=clampY(c+dy*sy, dd+dy*sy); setV([na,nb,nc,nd]); };
  const end=()=>{ drag.current=null; };
  const reset=()=>setV([fx0, fx1, fy0, fy1]);
  const zoomed = v[0]>fx0+1e-6 || v[1]<fx1-1e-6 || v[2]>fy0+1e-6 || v[3]<fy1-1e-6;
  return { wrapRef, view:v, zoomed, reset, zoomIn:()=>zoom(0.7,0.5,0.5), zoomOut:()=>zoom(1.43,0.5,0.5),
    bind:{ ref:wrapRef, onMouseDown, onMouseMove, onMouseUp:end, onMouseLeave:end, onDoubleClick:reset,
           style:{ cursor:'grab', position:'relative', userSelect:'none' } } };
}
function ZoomControls({z}){
  const b={width:27,height:27,display:'inline-flex',alignItems:'center',justifyContent:'center',border:'1px solid var(--border-default)',background:'var(--bg-card)',color:'var(--text-secondary)',borderRadius:7,cursor:'pointer',fontSize:15,lineHeight:1,fontFamily:'inherit'};
  return (<div style={{position:'absolute',top:4,right:8,display:'flex',gap:5,zIndex:3}}>
    <button title="Zoom out" style={b} onClick={z.zoomOut}>–</button>
    <button title="Zoom in" style={b} onClick={z.zoomIn}>+</button>
    <button title="Reset zoom (or double-click the chart)" onClick={z.reset} disabled={!z.zoomed}
      style={{...b, width:'auto', padding:'0 9px', fontSize:11, fontWeight:600, opacity:z.zoomed?1:0.4, cursor:z.zoomed?'pointer':'default'}}>Reset</button>
  </div>);
}
const ZOOM_HINT = 'Drag to pan · pinch or ⌘/Ctrl-scroll to zoom · double-click to reset';
const BRUSH_HINT = 'Drag the slider below to scroll · drag its handles to zoom the date range';
// Themed Recharts <Brush> for time-series charts — drag the window to scroll,
// drag a handle to zoom the date range. Must be a direct child of the chart.
function brushProps(key, fmt){
  return { dataKey:key, height:24, travellerWidth:9, gap:1,
           stroke:'var(--accent)', fill:'var(--bg-app)', tickFormatter:fmt };
}

function ProductSignal(){
  const S = computeProductSignals();
  if(!S) return null;
  const { gm, siteV2A, atc2pur, medPct, enriched, gems, pdpFix, checkoutFix, fixes, restock, META, PR } = S;
  const [lens,setLens] = useState('desire');   // Y-axis lens: desirability ↔ completion
  const [showAll,setShowAll] = useState(false); // ranked lists: top 3 ↔ up to 10

  const COL={star:'#6ee7b7',gem:'#7c8cff',dud:'#f87171',dead:'#6f6f7b',oos:'#f59e0b'};
  const LBL={star:'Star',gem:'Hidden gem',dud:'Dud',dead:'Dead weight',oos:'Out of stock'};
  // Two lenses, same quadrant: Y = desire (view→cart) or completion (cart→purchase).
  // Plotting completion while keeping the desire-based colours makes the leak visible —
  // a green "star" sitting BELOW the completion line = wanted, but not bought.
  const LENS={ desire:{key:'viewToAtc', ref:siteV2A, label:'Desirability — view→cart %', short:'Desire (view→cart)'},
               completion:{key:'atcToPurch', ref:atc2pur, label:'Completion — cart→purchase %', short:'Completion (cart→buy)'} };
  const L=LENS[lens];
  const scatter = enriched.filter(p=>p.views>=30);
  const series = ['gem','star','dud','oos','dead'].map(k=>({k, data: scatter.filter(p=>p.lab===k).map(p=>({x:p.pctViews, y:+(p[L.key]*100).toFixed(1), z:p.views, name:p.name, d:+(p.viewToAtc*100).toFixed(1), c:+(p.atcToPurch*100).toFixed(1)}))}));
  const allPts = series.flatMap(s=>s.data);
  const xMax = allPts.length ? Math.max(...allPts.map(p=>p.x)) : 100;
  const yMax = allPts.length ? Math.max(...allPts.map(p=>p.y)) : 100;
  const z = useChartZoom(0, +((xMax*1.08)||1).toFixed(2), 0, +((yMax*1.12)||1).toFixed(2));
  const lensBtn=(id)=>(<button key={id} onClick={()=>setLens(id)} style={{fontSize:11.5,fontWeight:600,padding:'3px 11px',borderRadius:7,cursor:'pointer',border:'1px solid '+(lens===id?'#7c8cff':'var(--border-subtle)'),background:lens===id?'rgba(124,140,255,0.14)':'transparent',color:lens===id?'#9aa6ff':'var(--text-muted)'}}>{LENS[id].short}</button>);

  const oppRow = (p,accent) => (<div key={p.name} style={{display:'flex',gap:10,alignItems:'baseline',padding:'7px 0',borderTop:'1px solid var(--border-subtle)'}}>
    <span style={{width:7,height:7,borderRadius:'50%',background:accent,flexShrink:0,alignSelf:'center'}}/>
    <div style={{flex:1,minWidth:0}}>
      <div style={{fontSize:13,color:'var(--text-primary)',fontWeight:600}}>{p.handle?<a className="txt-link" href={`https://myfrkl.com/products/${p.handle}`} target="_blank">{p.name}</a>:p.name}</div>
      <div style={{fontSize:11.5,color:'var(--text-muted)',marginTop:1}}>{NUM(p.views)} views · {p.pctViews}% of views · view→cart {(p.viewToAtc*100).toFixed(1)}% · cart→buy {(p.atcToPurch*100).toFixed(0)}%{p.price?` · £${p.price}`:''}</div>
      <div style={{fontSize:12,color:'var(--text-secondary)',marginTop:2}}>→ {p.move}</div>
    </div>
    {p.gbp>=50 && <span style={{fontWeight:700,color:'var(--good)',whiteSpace:'nowrap'}}>~{GBP(p.gbp)}/mo</span>}
  </div>);

  // A funnel-stage column: header (with count) + up to CAP rows + "+N more".
  const CAP = showAll ? 10 : 3;
  const oppCol = (title,color,arr,empty) => (<div>
    <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:8,marginBottom:3}}>
      <span style={{fontSize:11,letterSpacing:'.05em',textTransform:'uppercase',color,lineHeight:1.35}}>{title}</span>
      {arr.length>0 && <span style={{fontSize:11,fontWeight:700,color:'var(--text-faint)',flexShrink:0}}>{arr.length}</span>}
    </div>
    {arr.length
      ? <>{arr.slice(0,CAP).map(p=>oppRow(p,color))}{arr.length>CAP && <div style={{fontSize:11,color:'var(--text-faint)',paddingTop:6}}>+ {arr.length-CAP} more (smaller £)</div>}</>
      : <div style={{fontSize:12,color:'var(--text-muted)',padding:'6px 0'}}>{empty}</div>}
  </div>);
  const totalOpps = gems.length+pdpFix.length+checkoutFix.length+restock.length;
  const moreAvail = Math.max(gems.length,pdpFix.length,checkoutFix.length,restock.length) > 3;

  return (<div className="card" style={{marginBottom:14}}>
    <div className="card-section-title">
      <h2 style={{margin:0}}>Product signals <span style={{color:'var(--text-faint)',fontWeight:400,fontSize:13}}>— where each product leaks in the funnel</span></h2>
      <span className="meta">Pulse · {gems.length} unseen gems · {pdpFix.length} PDP problems · {checkoutFix.length} checkout leaks · {restock.length} OOS in demand · view→cart = desire, cart→buy = completion</span>
    </div>
    <div style={{display:'flex',alignItems:'center',gap:8,margin:'2px 0 6px'}}>
      <span style={{fontSize:11,color:'var(--text-faint)',textTransform:'uppercase',letterSpacing:'.04em'}}>Y axis</span>
      {['desire','completion'].map(lensBtn)}
      <span style={{fontSize:11,color:'var(--text-faint)'}}>{lens==='completion'?'— a high-desire dot sitting low here = wanted, but not bought':'— how badly people want it once they see it'}</span>
    </div>
    <div {...z.bind}>
    <ZoomControls z={z}/>
    <R.ResponsiveContainer width="100%" height={300}>
      <R.ScatterChart margin={{top:10,right:20,left:10,bottom:24}}>
        <R.CartesianGrid stroke="#1f1f27"/>
        <R.XAxis type="number" dataKey="x" name="Visibility" unit="%" domain={[z.view[0],z.view[1]]} allowDataOverflow tickFormatter={niceTick} tick={{fill:'#7e7e8a',fontSize:11}} label={{value:'Visibility — % of all product views', position:'insideBottom', offset:-12, fill:'#6f6f7b', fontSize:11}}/>
        <R.YAxis type="number" dataKey="y" name={L.short} unit="%" domain={[z.view[2],z.view[3]]} allowDataOverflow tickFormatter={niceTick} tick={{fill:'#7e7e8a',fontSize:11}} label={{value:L.label, angle:-90, position:'insideLeft', style:{textAnchor:'middle'}, fill:'#6f6f7b', fontSize:11}}/>
        <R.ZAxis type="number" dataKey="z" range={[25,320]} name="views"/>
        <R.ReferenceLine x={medPct} stroke="#3a3a44" strokeDasharray="4 3"/>
        <R.ReferenceLine y={+(L.ref*100).toFixed(1)} stroke="#3a3a44" strokeDasharray="4 3"/>
        <R.Tooltip cursor={{strokeDasharray:'3 3'}} content={({payload})=>{ const p=payload&&payload[0]&&payload[0].payload; return p?(<div style={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:8,padding:'7px 10px',fontSize:12,boxShadow:'var(--shadow-md)'}}><b>{p.name}</b><br/>{NUM(p.z)} views · {p.x}% of views<br/>view→cart {p.d}% · cart→buy {p.c}%</div>):null; }}/>
        <R.Legend verticalAlign="top" align="center" wrapperStyle={{fontSize:12, paddingBottom:8}}/>
        {series.map(s=> s.data.length>0 && <R.Scatter key={s.k} name={LBL[s.k]} data={s.data} fill={COL[s.k]} fillOpacity={0.75}/>)}
      </R.ScatterChart>
    </R.ResponsiveContainer>
    <div style={{fontSize:10.5,color:'var(--text-faint)',textAlign:'right',marginTop:2}}>{ZOOM_HINT}</div>
    </div>
    <div style={{fontSize:11,color:'var(--text-faint)',margin:'2px 0 12px'}}>{lens==='completion'
      ? <>Y = cart→purchase. Dots <b>below the dashed line buy worse than the site average once carted</b> — a checkout/commitment problem, not a desire one. X = visibility. Bubble = views.</>
      : <>Top-left = wanted but unseen (merchandise) · top-right = stars · bottom-right = seen but unwanted (fix/stop). Dashed lines = site median visibility &amp; average view→cart.</>}</div>

    <div style={{fontSize:11.5,color:'var(--text-muted)',margin:'2px 0 10px',lineHeight:1.5}}>The <b style={{color:'var(--good)'}}>~£/mo in green</b> is the <b>opportunity size</b> — estimated extra <b>gross profit per month</b> if this product closed the gap to the site's average funnel (for out-of-stock, the demand missed while it's unavailable). Margin-weighted at {PCT(gm)} and scaled to a month — a ceiling worth chasing, not a guaranteed gain. Only products worth ≥ £50/mo are listed.</div>

    <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(250px,1fr))',gap:16}}>
      {oppCol('Unseen — visibility problem','#7c8cff',gems,'None — visibility matches desire.')}
      {oppCol('Browsed, not wanted — PDP problem','#f87171',pdpFix,'None flagged.')}
      {oppCol('Wanted, not bought — checkout leak','#fbbf24',checkoutFix,'None — carts close at the site rate.')}
      {oppCol('Restock — in demand, out of stock','#f59e0b',restock,'None.')}
    </div>
    {moreAvail && <div style={{marginTop:12,textAlign:'center'}}>
      <button onClick={()=>setShowAll(!showAll)} style={{fontSize:12,fontWeight:600,padding:'6px 16px',borderRadius:8,cursor:'pointer',border:'1px solid var(--border-subtle)',background:'transparent',color:'#9aa6ff'}}>{showAll?'Show fewer':`Show more — ${totalOpps} opportunities ≥ £50/mo`}</button>
    </div>}
    <div className="note" style={{marginTop:12}}>The full funnel, per product: <b>% of views = visibility</b>, <b>view→cart = desire</b> (do they want it once seen), <b>cart→purchase = completion</b> (do they close once they want it). Splitting the last two is the depth — a low-converting SKU is now diagnosed as either <b style={{color:'#f87171'}}>browsed-not-wanted</b> (fix the PDP/product) or <b style={{color:'#fbbf24'}}>wanted-not-bought</b> (fix price/shipping/trust/variant at checkout) — opposite fixes. Out-of-stock SKUs are separated (they can't convert); £ is margin-weighted at {PCT(gm)}, scaled to /month. GA4 item-scoped ({META.products||PR.length} products) × Shopify price/stock.</div>
  </div>);
}

// ── Affiliate & discount code tracker over time ─────────────────────────────
// Answers: is a code a one-off SPIKE (sale/launch) or a CONSTANT always-on discount
// quietly running every week — and how much margin does each give away? Splits real
// MARKETING codes from SERVICE/goodwill codes (replacements, resends) that are £0-
// revenue cost, not promotion. From Shopify order-level discount_codes over time.
const DC_PATTERN = {
  'always-on': {label:'Always-on', color:'#f59e0b', note:'runs constantly — structural margin'},
  'recurring': {label:'Recurring', color:'#7c8cff', note:'on & off over time'},
  'spike':     {label:'Spike',     color:'#4ade80', note:'short campaign burst'},
  'one-off':   {label:'One-off',   color:'#9aa0aa', note:'single day'},
};
function fmtWk(iso){ const d=new Date(iso+'T00:00:00Z'); return d.toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'}); }

// Lightweight inline SVG sparkline of a code's weekly orders across the full axis —
// so "constant" reads as an even row of bars and "spike" as one tall bar.
function DCSpark({series, axis, color}){
  const byW = {}; (series||[]).forEach(s=>{ byW[s.w]=s.o; });
  const vals = axis.map(w=>byW[w]||0);
  const max = Math.max(1, ...vals);
  const W=120, H=22, gap=1, bw=(W-(vals.length-1)*gap)/vals.length;
  return (<svg width={W} height={H} style={{display:'block'}}>
    {vals.map((v,i)=>{ const h=v?Math.max(2,v/max*H):0; return (
      <rect key={i} x={i*(bw+gap)} y={H-h} width={bw} height={h} rx={0.6}
        fill={v?color:'#26262e'} opacity={v?0.9:1}/> ); })}
  </svg>);
}

function DiscountCodeTracker(){
  const DATA = (typeof window!=='undefined' && window.FRKL_DISCOUNT_CODES) || null;
  if(!DATA || !DATA.codes || !DATA.codes.length) return (
    <div className="card"><div className="card-section-title"><h2 style={{margin:0}}>Affiliate & discount codes</h2></div>
    <div className="note">No coded orders found in the window. Once Shopify orders carry discount codes, this fills in.</div></div>);
  const M = DATA.meta||{}, axis = M.axis||[];
  const codes = DATA.codes.filter(c=>c.kind!=='noise');
  const mkt = codes.filter(c=>c.kind==='marketing').sort((a,b)=>b.orders-a.orders);
  const svc = codes.filter(c=>c.kind==='service').sort((a,b)=>b.discount-a.discount);
  const tableMkt = mkt.filter(c=>c.orders>=2);
  const oneOffN = mkt.length - tableMkt.length;
  const leak = M.alwaysOnLeak;

  // Palette for the stacked chart — top codes get distinct hues, Other grey, Service red.
  const HUES = ['#f59e0b','#7c8cff','#4ade80','#f472b6','#38bdf8','#c084fc'];
  const top = (M.topCodes||[]).map((c,i)=>({code:c, color:HUES[i%HUES.length]}));
  const stackKeys = [...top, {code:'Other', color:'#3a3a44'}, {code:'Service', color:'#ef6b6f'}];
  const weekly = DATA.weekly||[];

  const Badge = ({p}) => { const m=DC_PATTERN[p]||DC_PATTERN['recurring'];
    return <span style={{fontSize:10.5,fontWeight:650,letterSpacing:'.02em',color:m.color,
      background:m.color+'1f',border:'1px solid '+m.color+'40',padding:'1px 7px',borderRadius:999}}>{m.label}</span>; };

  const tile = (label,val,sub,accent) => (<div style={{flex:'1 1 180px',background:'var(--surface-1,#111116)',border:'1px solid var(--border-subtle,#23232b)',borderRadius:12,padding:'12px 14px'}}>
    <div style={{fontSize:11,letterSpacing:'.04em',textTransform:'uppercase',color:'var(--text-faint)'}}>{label}</div>
    <div style={{fontSize:22,fontWeight:700,marginTop:3,color:accent||'var(--text-primary)'}}>{val}</div>
    <div style={{fontSize:11.5,color:'var(--text-muted)',marginTop:2}}>{sub}</div>
  </div>);

  return (<div>
    <div className="card" style={{marginBottom:14}}>
      <div className="card-section-title">
        <h2 style={{margin:0}}>Affiliate & discount codes <span style={{color:'var(--text-faint)',fontWeight:400,fontSize:13}}>— over time</span></h2>
        <span className="meta">Atlas · {Math.round((M.codedShare||0)*100)}% of orders use a code · spike vs constant · codes + automatic + markdowns · last {M.weeks||26}w · draft/exchange orders excluded</span>
      </div>

      <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:14}}>
        {tile('Full-price orders', Math.round((M.fullPriceShare||0)*100)+'%', `${NUM(M.fullPriceOrders)} orders · ${GBP(M.fullPriceRevenue)} (${Math.round((M.fullPriceRevenueShare||0)*100)}% of revenue)`, 'var(--good)')}
        {tile('Orders with a discount', Math.round((1-(M.fullPriceShare||0))*100)+'%', `${NUM(M.discountedOrders)} orders · ${GBP(M.discountedRevenue)} revenue`)}
        {tile('Marketing discount', GBP(M.marketingDiscount), `${mkt.length} promo / affiliate codes`, '#7c8cff')}
        {tile('Draft orders excluded', String(M.draftOrdersExcluded||0), `exchanges/replacements · ${GBP(M.draftDiscountExcluded)} internal credits not counted as discount`, 'var(--text-muted)')}
        {tile('Always-on codes', String(M.alwaysOnCount||0), leak?`${leak.code} = ${GBP(leak.discount)} given away`:'—', '#f59e0b')}
      </div>

      {(()=>{ const td=(M.marketingDiscount||0)+(M.automaticDiscount||0);
        const gr=(M.fullPriceRevenue||0)+(M.discountedRevenue||0);
        const inten=gr?Math.round(td/gr*100):0, pen=Math.round((1-(M.fullPriceShare||0))*100), avg=(M.discountedOrders)?td/M.discountedOrders:0;
        return (
        <div style={{background:'var(--accent-bg)',border:'1px solid rgba(124,140,255,0.25)',borderRadius:12,padding:'11px 14px',marginBottom:14,fontSize:12.5,color:'var(--text-secondary)',lineHeight:1.55}}>
          <b style={{color:'var(--text-primary)'}}>How often vs how deep —</b> these two figures look like they disagree but they measure different things:
          <span style={{display:'inline'}}> <b style={{color:'var(--text-primary)'}}>{pen}%</b> of orders carry a discount (how <i>often</i>), but the average is only <b style={{color:'var(--text-primary)'}}>{GBP(avg)}</b> off — so across all sales discounts come to only <b style={{color:'var(--text-primary)'}}>~{inten}%</b> of revenue (how <i>deep</i>). Frequent but shallow: lots of small codes, not deep cuts.</span>
          <span style={{color:'var(--text-faint)',display:'block',marginTop:4}}>The Home <i>“Discount depth”</i> tile (~{inten}%) is the £-weighted view; the <i>“Orders with a discount”</i> tile above ({pen}%) is the order-count view. Same data, different denominators — not a discrepancy.</span>
        </div>); })()}

      {(M.markdownEstimate>0 || M.automaticDiscount>0) && <div style={{background:'rgba(245,181,68,0.06)',border:'1px solid rgba(245,181,68,0.3)',borderRadius:12,padding:'11px 14px',marginBottom:14}}>
        <div style={{fontSize:11,textTransform:'uppercase',letterSpacing:'.04em',color:'#f5b544',fontWeight:700,marginBottom:5}}>Discounts beyond codes — not in the £ above</div>
        <div style={{display:'flex',gap:20,flexWrap:'wrap',fontSize:12.5,color:'var(--text-secondary)'}}>
          <div style={{flex:'1 1 240px'}}><b>Automatic (no code):</b> {GBP(M.automaticDiscount)} on {NUM(M.automaticOrders)} orders <span style={{color:'var(--text-faint)'}}>— in Shopify's discount totals, just not tied to a code.</span></div>
          <div style={{flex:'1 1 320px'}}><b style={{color:'#ef6b6f'}}>Sale-price markdowns:</b> ~{GBP(M.markdownEstimate)} est. ({Math.round((M.markdownShareOfValue||0)*100)}% of sold value) · <b>{M.catalogOnSale}/{M.catalogActive}</b> of catalog on sale at ~{M.avgMarkdownPct}% off. <span style={{color:'var(--text-faint)'}}>Compare-at markdowns never enter Shopify's <code>total_discounts</code>, so they're invisible to the code/automatic figures — this is the true site-wide discount the £ above misses. Estimated from web line-items × current compare-at price.</span></div>
        </div>
      </div>}

      <R.ResponsiveContainer width="100%" height={280}>
        <R.BarChart data={weekly} margin={{top:6,right:16,left:6,bottom:22}}>
          <R.CartesianGrid stroke="#1f1f27" vertical={false}/>
          <R.XAxis dataKey="w" tickFormatter={fmtWk} tick={{fill:'#7e7e8a',fontSize:10.5}} interval={Math.ceil(axis.length/9)} tickMargin={8}
            label={{value:'Week', position:'insideBottom', offset:-10, fill:'#6f6f7b', fontSize:11}}/>
          <R.YAxis allowDecimals={false} tick={{fill:'#7e7e8a',fontSize:11}} label={{value:'Orders with a code', angle:-90, position:'insideLeft', style:{textAnchor:'middle'}, fill:'#6f6f7b', fontSize:11}}/>
          <R.Tooltip cursor={{fill:'rgba(124,140,255,0.06)'}} contentStyle={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:10,fontSize:12}}
            labelFormatter={w=>'Week of '+fmtWk(w)} itemSorter={it=>-it.value}/>
          <R.Legend verticalAlign="top" align="center" wrapperStyle={{fontSize:11.5, paddingBottom:8}}/>
          {stackKeys.map(k=> <R.Bar key={k.code} dataKey={k.code} stackId="a" fill={k.color} maxBarSize={26}/>) }
        </R.BarChart>
      </R.ResponsiveContainer>
      <div style={{fontSize:11,color:'var(--text-faint)',margin:'2px 0 4px'}}>A steady band every week = an <b style={{color:'#f59e0b'}}>always-on</b> code (structural discount). A tall single-week bar = a <b style={{color:'#4ade80'}}>spike</b> (sale/launch). <span style={{color:'#ef6b6f'}}>Service</span> = goodwill codes (replacement/resend), shown for context — not promotion.</div>
      <ChartFooter ask="From discount-code usage over time, which codes are always-on structural margin give-away vs one-off campaign spikes, and where should I tighten?"/>
    </div>

    <ConfigurableChart
      title="Explore codes — marketing discounts"
      dataset={mkt.map(c=>({code:c.code, pattern:(DC_PATTERN[c.pattern]||DC_PATTERN.recurring).label, discount:c.discount||0, revenue:c.revenue||0, orders:c.orders||0}))}
      dimensions={[{key:'code',label:'Code'},{key:'pattern',label:'Pattern'}]}
      metrics={[{key:'discount',label:'Discount £',fmt:GBP},{key:'revenue',label:'Revenue',fmt:GBP},{key:'orders',label:'Orders',fmt:NUM}]}
      defaultMetric="discount" defaultSplit="code" defaultChart="bar" defaultTopN={10}/>
    <div className="card">
      <div className="card-section-title"><h2 style={{margin:0}}>By code</h2>
        <span className="meta">marketing codes · sorted by orders · sparkline = weekly usage across the window</span></div>
      <div style={{overflowX:'auto'}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:12.5}}>
        <thead><tr style={{textAlign:'left',color:'var(--text-faint)',fontSize:11,textTransform:'uppercase',letterSpacing:'.04em'}}>
          <th style={{padding:'6px 8px 6px 0'}}>Code</th><th style={{padding:'6px 8px'}}>Pattern</th>
          <th style={{padding:'6px 8px'}}>Usage over time</th>
          <th style={{padding:'6px 8px',textAlign:'right'}}>Orders</th><th style={{padding:'6px 8px',textAlign:'right'}}>Revenue</th>
          <th style={{padding:'6px 8px',textAlign:'right'}}>Discount £</th><th style={{padding:'6px 8px',textAlign:'right'}}>Disc %</th>
          <th style={{padding:'6px 8px',whiteSpace:'nowrap'}}>Active window</th></tr></thead>
        <tbody>
          {tableMkt.map(c=>{ const m=DC_PATTERN[c.pattern]||DC_PATTERN['recurring'];
            return (<tr key={c.code} style={{borderTop:'1px solid var(--border-subtle)'}}>
            <td style={{padding:'8px 8px 8px 0',fontWeight:600,color:'var(--text-primary)'}}>{c.code}
              {c.discountRate>=0.22 && <span title="heavy discount" style={{marginLeft:6,color:'#f59e0b',fontSize:11}}>⚠ deep</span>}</td>
            <td style={{padding:'8px'}}><Badge p={c.pattern}/></td>
            <td style={{padding:'6px 8px'}}><DCSpark series={c.series} axis={axis} color={m.color}/></td>
            <td style={{padding:'8px',textAlign:'right'}}>{NUM(c.orders)}</td>
            <td style={{padding:'8px',textAlign:'right'}}>{GBP(c.revenue)}</td>
            <td style={{padding:'8px',textAlign:'right',color:'#ef6b6f'}}>{GBP(c.discount)}</td>
            <td style={{padding:'8px',textAlign:'right'}}>{Math.round(c.discountRate*100)}%</td>
            <td style={{padding:'8px',whiteSpace:'nowrap',color:'var(--text-muted)',fontSize:11.5}}>{fmtWk(c.firstSeen)} → {fmtWk(c.lastSeen)}{c.recent?'':' · ended'}</td>
          </tr>); })}
          {oneOffN>0 && <tr style={{borderTop:'1px solid var(--border-subtle)'}}><td colSpan={8} style={{padding:'8px 0',color:'var(--text-faint)',fontSize:11.5}}>+ {oneOffN} one-off / single-order codes (creator trials, edge cases)</td></tr>}
        </tbody>
      </table>
      </div>
      <div className="note" style={{marginTop:12}}>
        <b>Read it:</b> <b>{Math.round((M.fullPriceShare||0)*100)}% of orders ({NUM(M.fullPriceOrders)}) were placed at full price</b> — {GBP(M.fullPriceRevenue)}, {Math.round((M.fullPriceRevenueShare||0)*100)}% of revenue, at ~{GBP(M.fullPriceOrders?M.fullPriceRevenue/M.fullPriceOrders:0)} AOV. The other {NUM(M.discountedOrders)} orders carried a discount. {leak ? <>Your biggest always-on code <b>{leak.code}</b> has run every week since launch on {NUM(leak.orders)} orders — {GBP(leak.discount)} of margin given away with no campaign trigger. Worth asking whether it's a deliberate evergreen offer or a default that quietly caps margin. </> : null}
        {(M.draftOrdersExcluded>0) && <> <b>{NUM(M.draftOrdersExcluded)} draft orders</b> (exchanges/replacements, ~{GBP(M.draftDiscountExcluded)} of internal credits) are <b>excluded</b> — they're not real sales and were inflating the discount totals.</>} The figures above are codes + automatic discounts; sale-price markdowns are shown separately as they never enter Shopify's discount totals.
      </div>
    </div>
  </div>);
}

// Restock intelligence — join inventory velocity with REAL revenue-per-unit (from
// the products table, net of returns) so the £ at risk is grounded, then surface the
// GOOD SELLERS (above-median velocity) that are about to run out. Keeps founders from
// losing the SKUs that actually pay the bills. Pure frontend over existing data.
function computeRestockAlerts(leadCfg){
  const BB = window.FRKL_BUSINESS || {};
  const inv = BB.inventory || [];
  const prods = BB.products || [];
  if(!inv.length) return null;
  const cfg = leadCfg || leadConfig();
  // SKU / title → net revenue per unit.
  const revBySku = {}, revByTitle = {};
  prods.forEach(p=>{
    const rpu = (p.units>0 && p.netSales!=null) ? p.netSales/p.units : null;
    if(rpu==null) return;
    if(p.sku) revBySku[p.sku] = rpu;
    const t=(p.title||'').trim().toLowerCase(); if(t) revByTitle[t]=rpu;
  });
  const skuRevs = Object.values(revBySku).sort((a,b)=>a-b);
  const medianRpu = skuRevs.length ? skuRevs[Math.floor(skuRevs.length/2)] : 30;
  const revPerUnitOf = r => {
    if(r.sku && revBySku[r.sku]!=null) return revBySku[r.sku];
    const t=(r.title||'').trim().toLowerCase();
    if(t && revByTitle[t]!=null) return revByTitle[t];
    return medianRpu;  // conservative fallback so we never under-state risk to zero
  };
  // Only SELLING SKUs with finite cover (exclude archived / no-sales / infinite).
  const selling = inv.filter(r => (r.units90d||0) > 0 && r.daysOfCover!=null && r.daysOfCover < 900 && r.coverTier!=='archived_stock');
  if(!selling.length) return null;
  // "Good seller" = at or above median velocity among selling SKUs (relative, brand-agnostic).
  const vels = selling.map(r=>r.units90d).sort((a,b)=>a-b);
  const medVel = vels[Math.floor(vels.length/2)] || 0;
  const enriched = selling.map(r=>{
    const rpu = revPerUnitOf(r);
    const daily = r.dailyVelocity || (r.units90d/90);
    const monthlyRev = daily * 30 * rpu;          // £/mo throughput this SKU generates
    const cover = r.daysOfCover;
    const leadDays = leadDaysFor(r.type, cfg);     // supplier lead time for this SKU's type
    // Slack = days you can wait before the order MUST be placed to avoid a stock-out.
    const slack = cover - leadDays;
    // Lead-time-aware bands: a slow-to-restock SKU is urgent far earlier than a fast one.
    const urgency = slack <= 0 ? 'now' : slack <= 7 ? 'soon' : slack <= 21 ? 'watch' : null;
    // Reorder-to target = cover the lead time + a 30-day buffer after stock lands.
    const targetCover = leadDays + 30;
    const reorderQty = Math.max(0, Math.round(daily*targetCover) - (r.inventoryQty||0));
    return {...r, revPerUnit:rpu, monthlyRev, goodSeller:(r.units90d >= Math.max(medVel,3) && monthlyRev >= 100), urgency, reorderQty, daily, leadDays, slack, targetCover};
  });
  const alerts = enriched.filter(r=>r.goodSeller && r.urgency).sort((a,b)=>(b.monthlyRev||0)-(a.monthlyRev||0));
  const imminent = alerts.filter(a=>a.urgency!=='watch');
  // Distinct product types present among alerts — drives the per-type lead-time editor.
  const typesPresent = [...new Set(alerts.map(a=>a.type).filter(Boolean))];
  return {
    alerts,
    atRiskMonthly: imminent.reduce((s,a)=>s+a.monthlyRev,0),
    nowCount: alerts.filter(a=>a.urgency==='now').length,
    soonCount: alerts.filter(a=>a.urgency==='soon').length,
    watchCount: alerts.filter(a=>a.urgency==='watch').length,
    typesPresent,
  };
}

// Format a "reorder by" date from slack days (days until the order must be placed).
function reorderByLabel(slackDays){
  if(slackDays <= 0) return {txt:'Order today', overdue:true};
  const d = new Date(Date.now() + Math.round(slackDays)*86400000);
  return {txt: d.toLocaleDateString('en-GB',{day:'numeric',month:'short'}), overdue:false};
}

function RestockAlertsPanel(){
  const [lead,setLead] = useState(leadConfig());
  const [sort,setSort] = useState({key:'slack',dir:'asc'});   // most-urgent (least slack) first
  const [showWatch,setShowWatch] = useState(false);
  const [editLead,setEditLead] = useState(false);
  const data = computeRestockAlerts(lead);
  if(!data || !data.alerts.length) return null;
  const updateLead = (next) => { setLead(next); saveLeadConfig(next); };
  const setDefault = (v) => updateLead({...lead, default: v});
  const setType = (type, v) => updateLead({...lead, byType: {...lead.byType, [type]: v}});
  const U = {
    now:  {lbl:'REORDER NOW',  fg:'var(--bad)',        bg:'var(--bad-bg)'},
    soon: {lbl:'REORDER SOON', fg:'var(--warn)',       bg:'var(--warn-bg)'},
    watch:{lbl:'WATCH',        fg:'var(--text-muted)', bg:'var(--border-subtle)'},
  };
  const URANK = {now:3, soon:2, watch:1};
  const rows = data.alerts.filter(a => showWatch ? true : a.urgency!=='watch');
  const sortVal = (r) => {
    switch(sort.key){
      case 'urgency': return URANK[r.urgency]||0;
      case 'cover':   return r.daysOfCover;
      case 'slack':   return r.slack;
      case 'vel':     return r.units90d;
      case 'reorder': return r.reorderQty;
      default:        return r.monthlyRev;   // 'monthlyRev'
    }
  };
  const dir = sort.dir==='asc' ? 1 : -1;
  const sorted = [...rows].sort((a,b)=>{ const va=sortVal(a), vb=sortVal(b); return va<vb?-1*dir : va>vb?1*dir : (b.monthlyRev-a.monthlyRev); });
  const onSort = (key) => setSort(s => s.key===key ? {key, dir:s.dir==='asc'?'desc':'asc'} : {key, dir:(key==='cover'||key==='slack')?'asc':'desc'});
  const th = (key,label,right) => {
    const active = sort.key===key;
    return (<th onClick={()=>onSort(key)} style={{cursor:'pointer',whiteSpace:'nowrap',textAlign:right?'right':'left',userSelect:'none',color:active?'var(--text-primary)':undefined}}
      title={`Sort by ${label.toLowerCase()}`}>{label} <span style={{fontSize:9,opacity:active?1:.4}}>{active?(sort.dir==='asc'?'▲':'▼'):'↕'}</span></th>);
  };
  const top = data.alerts.find(a=>a.urgency!=='watch') || data.alerts[0];
  const leadInput = (val, onCh) => (<input type="number" min="0" value={val==null?'':val} onChange={e=>onCh(e.target.value)}
    style={{width:52,background:'var(--bg-app)',color:'var(--text-primary)',border:'1px solid var(--border-default)',borderRadius:5,padding:'3px 6px',fontSize:12,fontFamily:'inherit'}}/>);
  return (<div className="card" style={{marginBottom:14, borderLeft:'3px solid var(--bad)'}}>
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:8}}>
      <div style={{display:'inline-flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
        <h2 style={{margin:0}}>Restock alerts — good sellers running low</h2>
        <StatusBadge kind={data.nowCount>0 ? 'action' : 'watch'} label={data.nowCount>0 ? 'Action required' : 'Watch'}/>
      </div>
      <button className="btn-ghost" style={{padding:'4px 10px',fontSize:11.5}} onClick={()=>setEditLead(v=>!v)}>
        {editLead?'Done':'⚙ Lead times'}
      </button>
    </div>
    <div className="muted" style={{margin:'8px 0 10px', fontSize:12}}>
      Your fastest-moving SKUs ranked by the revenue they'd stop earning if they stock out. <b>Reorder by</b> = the date you
      must place the order so it lands before you run out (days of cover − supplier lead time). Suggested reorder refills to
      lead time + 30 days of cover.
    </div>
    {editLead && (<div className="card" style={{background:'var(--bg-app)',marginBottom:10,padding:'10px 12px'}}>
      <div style={{fontSize:12,fontWeight:700,marginBottom:8}}>Supplier lead times <span className="muted" style={{fontWeight:400}}>— days from reorder to stock landing. Defaults are estimates; set your real ones.</span></div>
      <div style={{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap'}}>
        <label style={{display:'flex',alignItems:'center',gap:6,fontSize:12}}>Default {leadInput(lead.default, setDefault)} days</label>
        {data.typesPresent.map(t=>(
          <label key={t} style={{display:'flex',alignItems:'center',gap:6,fontSize:12}}>{t} {leadInput(lead.byType[t]!=null?lead.byType[t]:'', v=>setType(t,v))} <span className="muted" style={{fontSize:10}}>days</span></label>
        ))}
      </div>
      <div className="muted" style={{fontSize:10.5,marginTop:8}}>Blank type = uses the default. Saved to this browser.</div>
    </div>)}
    <div className="row" style={{marginBottom:10}}>
      <div className="card kpi" style={{borderLeft:'3px solid var(--bad)'}}>
        <div className="label">Reorder now</div>
        <div className="val">{data.nowCount}</div>
        <div className="sub">must order today — cover ≤ lead time</div>
      </div>
      <div className="card kpi" style={{borderLeft:'3px solid var(--warn)'}}>
        <div className="label">Reorder soon</div>
        <div className="val">{data.soonCount}</div>
        <div className="sub">order within ~a week</div>
      </div>
      <div className="card kpi" style={{borderLeft:'3px solid var(--accent)'}}>
        <div className="label">At risk if you don't reorder</div>
        <div className="val">{GBP(data.atRiskMonthly)}<span style={{fontSize:13,fontWeight:600}}>/mo</span></div>
        <div className="sub">{data.nowCount+data.soonCount} best-sellers · order this week to keep it</div>
      </div>
    </div>
    <div style={{overflowX:'auto'}}>
      <table><thead><tr>
        {th('urgency','Urgency')}
        <th className="tl">Product</th>
        {th('slack','Reorder by', true)}
        {th('cover','Days left', true)}
        {th('vel','Sold / 90d', true)}
        {th('monthlyRev','£/mo at risk', true)}
        {th('reorder','Reorder qty', true)}
      </tr></thead><tbody>
      {sorted.map((r,i)=>{ const u=U[r.urgency]; const rb=reorderByLabel(r.slack);
        return (<tr key={i}>
          <td><span className="pill" style={{background:u.bg,color:u.fg,fontSize:10,padding:'2px 7px',borderRadius:4,fontWeight:700,whiteSpace:'nowrap'}}>{r.urgency==='now' ? `Restock or lose ${GBP(r.monthlyRev)}/mo` : u.lbl}</span></td>
          <td className="tl" style={{fontSize:12,maxWidth:260}}>
            <b>{r.title}</b>
            {(r.type||r.sku) && <div className="muted" style={{fontSize:10}}>{r.type||''}{r.type&&r.sku?' · ':''}{r.sku?<code>{r.sku}</code>:''} · {r.leadDays}d lead</div>}
          </td>
          <td style={{whiteSpace:'nowrap',fontWeight:700,textAlign:'right',color:rb.overdue?'var(--bad)':'var(--text-secondary)'}}>{rb.txt}</td>
          <td style={{whiteSpace:'nowrap',textAlign:'right',color:u.fg}}>{Math.round(r.daysOfCover)}d</td>
          <td style={{textAlign:'right'}}>{NUM(r.units90d)} <span className="muted" style={{fontSize:10}}>({r.daily.toFixed(1)}/day)</span></td>
          <td style={{textAlign:'right',fontVariantNumeric:'tabular-nums',fontWeight:700}}>{GBP(r.monthlyRev)}</td>
          <td style={{textAlign:'right',fontVariantNumeric:'tabular-nums'}}>{r.reorderQty>0?('+'+NUM(r.reorderQty)):'—'}</td>
        </tr>);
      })}
      </tbody></table>
    </div>
    {data.watchCount>0 && <button className="btn-ghost" style={{marginTop:10,padding:'5px 11px',fontSize:11.5}} onClick={()=>setShowWatch(v=>!v)}>
      {showWatch ? 'Hide watch list' : `+ ${data.watchCount} approaching (order within ~3 weeks)`}
    </button>}
    <div className="note" style={{marginTop:14}}>
      {data.nowCount+data.soonCount>0
        ? <><b>Atlas read:</b> <b>{GBP(data.atRiskMonthly)}/mo</b> of revenue rides on {data.nowCount+data.soonCount} best-sellers you need to reorder within the week to land before they run out. {top ? <>Biggest: <b>{top.title}</b> — {reorderByLabel(top.slack).overdue?'order today':`order by ${reorderByLabel(top.slack).txt}`} or lose <b>{GBP(top.monthlyRev)}/mo</b> ({top.leadDays}d lead). </> : null}Place these before chasing new-SKU launches. Adjust lead times above if these don't match your suppliers.</>
        : <><b>Atlas read:</b> no good sellers need an order placed right now — the watch list shows the next ones so you stay ahead of a stock-out.</>}
    </div>
  </div>);
}

function Products(){
  const products=B.products||[];
  const [sort,setSort]=useState('units');
  const [pview,setPview]=useState('stock');
  const sorted=[...products].sort((a,b)=>(b[sort]||0)-(a[sort]||0));
  const totalUnits=products.reduce((a,p)=>a+(p.units||0),0);
  const totalRev=products.reduce((a,p)=>a+(p.netSales||0),0);
  const totalProfit=products.reduce((a,p)=>a+(p.grossProfit||0),0);
  const blendedMargin=totalRev>0?totalProfit/totalRev:0;
  const returnHotspots=[...products].filter(p=>(p.returnRate||0)>=0.1&&(p.units||0)>=10).sort((a,b)=>(b.returnRate||0)-(a.returnRate||0));
  return (<div>
    <div className="row" style={{marginBottom:14}}>
      <KPI label="SKUs sold (90d)" val={products.length+'+'} sub={`${NUM(totalUnits)} units · £${NUM(totalRev)} net`}
        agent="Atlas" observation="200+ SKUs sold in 90d but the top 40 carry most of the volume — long tail of low-velocity stock."
        implication="Trim the tail. Focus inventory + creative on the top 20 to lift margin and shorten the cash cycle." />
      <KPI label="Top seller" val={sorted[0]?.title?.slice(0,28)||'—'} sub={`${sorted[0]?.units||0} units · £${NUM(sorted[0]?.netSales)} · ${PCT(sorted[0]?.marginPct)} margin`}
        agent="Frame" observation={DEMO ? "The mega necklace gold is the hero (117 units, £8.7k) but has the lowest margin (~58%) and 8.5% returns." : undefined}
        implication={DEMO ? "Heavy reliance on one SKU = concentration risk. Find the next hero — and root-cause why this one returns." : undefined} />
      <KPI label="Blended gross margin" val={PCT(blendedMargin)} sub={`£${NUM(totalProfit)} GP / £${NUM(totalRev)} net`}
        agent="Atlas" observation={DEMO ? "78% blended GM is excellent for jewellery — the charms (80–93% margin) are the cash cow." : undefined}
        implication="Investors will love this number once COGS is confirmed and the true discount load — code + automatic + sale-price markdowns, draft orders excluded — is netted out (see Promotions)." />
      <KPI label="Return-rate hotspots" val={returnHotspots.length} sub={`SKUs with ≥10% returns (sold ≥10)`}
        agent="Lux" observation={DEMO ? "12 SKUs have ≥10% return rates — 'love is pain charm' hits 22% — that's a CX signal, not a quality fluke." : undefined}
        implication="Add a post-purchase survey + PDP sizing/expectation copy to the top 3 hotspots before adding any new SKUs." />
    </div>
    {/* Three jobs split into subtabs — Stock (ops) · Performance (analytics) · Bundles (merch) */}
    <div className="seg" style={{marginBottom:14}}>
      {[['stock','Stock'],['performance','Performance'],['bundles','Bundles']].map(([k,l])=>(<button key={k} className={pview===k?'on':''} onClick={()=>setPview(k)}>{l}</button>))}
    </div>
    {pview==='stock' && (<div>
      <RestockAlertsPanel/>
      <StockThrottlePanel/>
      <InventoryPanel/>
    </div>)}
    {pview==='performance' && (<div>
      <ProductRetentionMatrix/>
      <ProductSignal/>
      <CollectionsPanel/>
      {returnHotspots.length>0&&(<div className="card" style={{marginBottom:14}}>
        <h2>Return-rate hotspots</h2>
        <div className="muted" style={{marginBottom:8}}>SKUs returning ≥10% of units sold — likely sizing/quality/expectation issues per Lux's read.</div>
        <table><thead><tr><th>Product</th><th>Sold</th><th>Returns</th><th>Rate</th></tr></thead><tbody>
          {returnHotspots.map((p,i)=>(<tr key={i}><td>{p.title}</td><td>{p.units}</td><td>{p.returns}</td><td><span className="pill red">{PCT(p.returnRate)}</span></td></tr>))}
        </tbody></table>
      </div>)}
      <ConfigurableChart
        title="Explore products"
        dataset={products}
        dimensions={[{key:'title',label:'Product'},{key:'type',label:'Type'}]}
        metrics={[
          {key:'grossProfit',label:'Gross profit',fmt:GBP},
          {key:'netSales',label:'Net revenue',fmt:GBP},
          {key:'units',label:'Units',fmt:NUM},
          {key:'returns',label:'Returns',fmt:NUM},
        ]}
        defaultMetric="grossProfit" defaultSplit="title" defaultChart="bar" defaultTopN={10}/>
      <div className="card" style={{marginBottom:14,display:'flex',justifyContent:'space-between',alignItems:'center',flexWrap:'wrap',gap:10}}>
        <h2 style={{margin:0}}>Top SKUs — sortable</h2>
        <div className="seg">{['units','netSales','grossProfit','marginPct','returnRate'].map(s=>(<button key={s} className={sort===s?'on':''} onClick={()=>setSort(s)}>{ {units:'Units',netSales:'Revenue',grossProfit:'Gross profit',marginPct:'Margin %',returnRate:'Return %'}[s] }</button>))}</div>
      </div>
      <div className="card">
        <table><thead><tr><th className="tc">#</th><th className="tl">Product</th><th className="tl">SKU</th><th>Units</th><th>Returns</th><th>Net rev</th><th>Gross profit</th><th>Margin</th></tr></thead><tbody>
        {sorted.slice(0,30).map((p,i)=>(<tr key={i}>
          <td className="tc muted">{i+1}</td>
          <td className="tl" style={{maxWidth:300}}>{p.image&&<img src={p.image} style={{width:22,height:22,borderRadius:4,verticalAlign:'middle',marginRight:8,objectFit:'cover',background:'var(--bg-elevated)'}} onError={e=>{e.target.style.opacity=.2;}}/>}{p.title}</td>
          <td className="tl"><span className="muted" style={{fontSize:11}}>{p.sku||'—'}</span></td>
          <td>{p.units}</td>
          <td><span className={'pill '+((p.returnRate||0)>=0.1?'red':(p.returnRate||0)>=0.05?'amber':'grey')}>{p.returns}</span></td>
          <td>{GBP(p.netSales)}</td>
          <td>{GBP(p.grossProfit)}</td>
          <td style={{color:p.marginPct>=0.7?'var(--good)':p.marginPct>=0.4?'var(--warn)':'var(--bad)',fontWeight:600}}>{PCT(p.marginPct)}</td>
        </tr>))}
        </tbody></table>
      </div>
      {DEMO && <div className="note" style={{marginTop:14}}>The <b>mega necklace gold</b> drives volume but has the lowest margin (~58%) and an 8.5% return rate. <b>Charms are the cash cow</b> — punk pearl choker (93% margin), candy bead necklace (91%), pixelated heart (84%). The <b>love is pain charm</b> has a 22% return rate — investigate immediately.</div>}
    </div>)}
    {pview==='bundles' && (<div>
      <BundlesPanel/>
      <ProductTiersPanel/>
    </div>)}
  </div>);
}

function Organic(){
  const ch=B.channelMix||[];
  const total=ch.reduce((a,c)=>a+(c.revenue||0),0);
  const sortedCh=[...ch].sort((a,b)=>(b.revenue||0)-(a.revenue||0));
  const isPaid=n=>/^Paid/.test(n);
  const paidRev=ch.filter(c=>isPaid(c.channel)).reduce((a,c)=>a+(c.revenue||0),0);
  const orgRev=total-paidRev;
  const palette=['#5b8def','#c084fc','#4ade80','#fbbf24','#38bdf8','#f87171','#a3a3a3','#34d399','#fb923c','#818cf8','#6ee7b7','#fcd34d'];
  const pieData=sortedCh.map((c,i)=>({name:c.channel,value:c.revenue||0,fill:palette[i%palette.length]}));
  return (<div>
    <div className="row" style={{marginBottom:14}}>
      <KPI label="Organic+direct revenue share" val={PCT(orgRev/total)} sub={`£${NUM(orgRev)} of £${NUM(total)} (GA4-attributed)`}
        agent="Sage" observation={DEMO ? "74% of attributed revenue is organic+direct — frkl is NOT a paid-acquisition business." : undefined}
        implication="Defend organic search rankings + brand search aggressively. That's the moat — paid is a top-up." />
      <KPI label="Top channel" val={sortedCh[0]?.channel||'—'} sub={`£${NUM(sortedCh[0]?.revenue)} · ${sortedCh[0]?.purchases} purchases`}
        agent="Lux" observation="Email drives 32% of attributed revenue — more than every paid channel combined."
        implication={DEMO ? "Klaviyo is the highest-leverage marketing surface frkl has. Fix attributed reporting + abandoned-cart flow first." : undefined} />
      <KPI label="Paid social GA4 vs Meta claim" val="≈10×" sub="Meta claims £12.5k; GA4 attributes £1.1k"
        agent="Atlas" observation="A 10× gap between platform-claimed and GA4-attributed Meta revenue is normal but startling at first."
        implication="For investor materials, lead with contribution-net ROAS — neither claimed nor last-click is the right answer alone." />
      <KPI label="Channels active" val={ch.length} sub="GA4 default channel grouping"
        agent="Scout" observation="12 channels active with no single-channel >32% — healthy diversification, no single-point-of-failure."
        implication={DEMO ? "This is a real strength to lead with in the fundraise — frkl isn't a one-channel pony." : undefined} />
    </div>
    <div className="row">
      <div className="card" style={{flex:'1 1 340px'}}>
        <h2>Revenue share by channel (GA4 attribution)</h2>
        <R.ResponsiveContainer width="100%" height={280}>
          <R.PieChart>
            <R.Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={100} paddingAngle={1}>
              {pieData.map((p,i)=><R.Cell key={i} fill={p.fill}/>)}
            </R.Pie>
            <R.Tooltip contentStyle={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:10}} formatter={v=>GBP(v)} />
          </R.PieChart>
        </R.ResponsiveContainer>
      </div>
      <div className="card" style={{flex:'1 1 380px'}}>
        <h2>Channel detail</h2>
        <table><thead><tr><th>Channel</th><th>Sessions</th><th>Purch</th><th>Rev</th><th>% rev</th><th>CVR</th></tr></thead><tbody>
        {sortedCh.map((c,i)=>(<tr key={i}>
          <td>{c.channel}</td><td>{NUM(c.sessions)}</td><td>{c.purchases||0}</td>
          <td>{GBP(c.revenue)}</td>
          <td>{PCT((c.revenue||0)/total)}</td>
          <td>{PCT((c.purchases||0)/Math.max(1,c.sessions))}</td>
        </tr>))}
        </tbody></table>
      </div>
    </div>
    <div className="note" style={{marginTop:14}}><b>Email is the #1 revenue channel</b> (£18.5k, 32% of attributed revenue) — the Klaviyo flows are doing more for the business than any paid channel. <b>Organic Search drives £10k (17.3%)</b> — bigger than Paid Search. The <b>Paid Social attribution gap</b> (Meta claims 10× what GA4 measures) is the headline reconciliation problem for the investor view.</div>
    <InstagramPanel/>
    <ContentCalendar/>
    <StoriesPanel/>
  </div>);
}

function EmailAttributionPanel(){
  const a = B.emailAttribution;
  const flows = B.attributedFlows || [];
  const campaigns30 = B.attributedCampaigns_30d || [];
  if (!a) return null;
  const gap = (a.grossFlowRevenue_90d_klaviyo_tracked || 0) - (a.attributedFlowRevenue_90d || 0);
  const gapPct = a.grossFlowRevenue_90d_klaviyo_tracked
    ? gap / a.grossFlowRevenue_90d_klaviyo_tracked
    : 0;
  return (<div className="card" style={{marginBottom:14, borderLeft:'3px solid #4ade80'}}>
    <h2>True email attribution (Klaviyo Attributed report types)</h2>
    <div className="muted" style={{marginBottom:10,fontSize:12}}>
      Pulled from <code>MetricExportAttributedFlow</code> + <code>MetricExportAttributedCampaign</code>. These are TRUE email-attributed orders within Klaviyo's attribution window (default: 5 days post-click). <b>This is the correct figure for "email channel revenue contribution".</b> The previous "gross Klaviyo-tracked" was every Shopify order Klaviyo's profiles touched — including orders the customer would have made anyway. {a.interpretation}
    </div>
    <div className="row" style={{marginBottom:10}}>
      <div className="card kpi" style={{borderLeft:'3px solid #4ade80'}}>
        <div className="label">Attributed flow rev (90d)</div>
        <div className="val">{GBP(a.attributedFlowRevenue_90d)}</div>
        <div className="sub">{a.attributedFlowOrders_90d} orders directly attributable to email flows</div>
      </div>
      <div className="card kpi" style={{borderLeft:'3px solid #5b8def'}}>
        <div className="label">Attributed campaign rev (30d)</div>
        <div className="val">{GBP(a.attributedCampaignRevenue_30d)}</div>
        <div className="sub">{a.attributedCampaignOrders_30d} orders directly attributable to campaign sends</div>
      </div>
      <div className="card kpi" style={{borderLeft: Math.abs(gapPct) > 0.3 ? '3px solid #fbbf24' : '3px solid #4ade80'}}>
        <div className="label">Flow attribution gap</div>
        <div className="val">{GBP(gap)}</div>
        <div className="sub">vs gross tracked £{NUM(a.grossFlowRevenue_90d_klaviyo_tracked)} ({(gapPct*100).toFixed(0)}% gap)</div>
      </div>
      <div className="card kpi" style={{borderLeft:'3px solid #c084fc'}}>
        <div className="label">Attribution window</div>
        <div className="val" style={{fontSize:14,lineHeight:1.3}}>5d post-click</div>
        <div className="sub">Klaviyo default. Cross-channel attribution overlap is the residual.</div>
      </div>
    </div>
    <div className="row">
      <div className="card" style={{flex:'1 1 380px'}}>
        <h2>Per-flow attributed revenue (90d)</h2>
        <table><thead><tr><th>Flow</th><th>Orders</th><th>Revenue</th><th>Active days</th><th>£/active day</th></tr></thead><tbody>
        {flows.map((f,i)=>(<tr key={i}>
          <td style={{fontSize:12}}>{f.flow}</td>
          <td>{f.orders}</td>
          <td><b>{GBP(f.orderValue)}</b></td>
          <td>{f.days}</td>
          <td>{GBP(f.avgPerDay)}</td>
        </tr>))}
        </tbody></table>
      </div>
      <div className="card" style={{flex:'1 1 380px'}}>
        <h2>Per-campaign attributed revenue (30d)</h2>
        <table><thead><tr><th>Campaign</th><th>Orders</th><th>Revenue</th></tr></thead><tbody>
        {campaigns30.slice(0,15).map((c,i)=>(<tr key={i}>
          <td style={{fontSize:12, maxWidth:240}}>{c.name}</td>
          <td>{c.orders}</td>
          <td><b>{GBP(c.orderValue)}</b></td>
        </tr>))}
        </tbody></table>
        <div className="muted" style={{fontSize:11, marginTop:6}}>Showing top {Math.min(15, campaigns30.length)} of {campaigns30.length} attributed campaigns.</div>
      </div>
    </div>
    {DEMO && <div className="note" style={{marginTop:14}}><b>Atlas read:</b> for frkl, the gross-vs-attributed flow gap is ~£{Math.abs(gap)} ({(gapPct*100).toFixed(0)}%) — Klaviyo's flow tracking is precise. So the £28k flow revenue claim that drives the "flows = 19× lift over campaigns" finding holds up. The Welcome Flow alone attributes £{NUM(flows[0]?.orderValue)} from {flows[0]?.orders} orders over 90d — the highest-leverage owned-audience surface frkl has.</div>}
  </div>);
}

function EmailHealthPanel(){
  const camps = (B.emailCampaigns||[]).filter(c=>c.recipients);
  const flows = (B.emailFlows||[]).filter(c=>c.recipients);
  const list = B.listGrowth || [];

  // Weighted avg open and click across campaigns + flows
  const wsum = (rows, k) => rows.reduce((a,r)=>a+(r[k]||0)*(r.recipients||0),0) / Math.max(1, rows.reduce((a,r)=>a+(r.recipients||0),0));
  const campOpenW = wsum(camps, 'openRate');
  const flowOpenW = wsum(flows, 'openRate');
  const campClickW = wsum(camps, 'clickRate');
  const flowClickW = wsum(flows, 'clickRate');

  // List growth: net growth + churn over last 60 days
  const last60 = list.slice(-60);
  const subs = last60.reduce((a,r)=>a+(r.subscribed||0),0);
  const unsubs = last60.reduce((a,r)=>a+(r.unsubscribed||0),0);
  const netGrowth = subs - unsubs;
  const dailyChurnRate = unsubs / Math.max(1, last60.length * 8500);   // ~8500 list size proxy

  // Apple MPP inflation flag
  const mppFlag = campOpenW > 0.55 || flowOpenW > 0.55;

  // Flow gap analysis — best-practice DTC flow inventory
  // Map existing frkl flow names to "categories"
  const flowNames = flows.map(f => (f.name || '').toLowerCase());
  const has = (kw) => flowNames.some(n => kw.some(k => n.includes(k)));
  const flowChecklist = [
    {label: "Welcome (per-category)", present: has(['welcome']), critical: true,
     present_detail: has(['necklaces welcome','bracelets welcome','charms welcome']) ? 'Per-category welcomes detected (NECKLACES, BRACELETS, CHARMS, PRE-STYLED) — best practice.' : 'Single welcome flow only — consider per-category.'},
    {label: "Browse abandonment", present: has(['browse abandon']), critical: true},
    {label: "Cart abandonment", present: has(['abandoned cart','cart abandon']), critical: true},
    {label: "Back-in-stock", present: has(['back in stock','back-in-stock']), critical: true},
    {label: "Post-purchase / shipping", present: has(['post purchase','post-purchase','first time purchaser']), critical: true},
    {label: "Birthday", present: has(['birthday']), critical: false,
     present_detail: 'Present but earning £0 — flow is broken (subject works, CTA fails).'},
    {label: "Win-back (lapsed 60-90d)", present: has(['win back','win-back','lapsed','we miss you']), critical: true,
     gap_text: "MISSING. For a brand where ~35% of orders are returning, this is the highest-leverage missing flow. Trigger at 60-90d since last purchase with a £-off return code."},
    {label: "Replenishment / repurchase nudge", present: has(['replenish','repurchase','time to restock']), critical: false,
     gap_text: "MISSING. Less critical for jewellery (not consumable) but a 'complete your stack' replenishment nudge for prior charm-buyers would convert."},
    {label: "VIP / 2nd+ purchaser", present: has(['vip','loyalty','existing customer']) || flowNames.some(n=>n.includes('existing customer')), critical: false,
     present_detail: "Existing Customer welcome variant present — partial VIP coverage."},
    {label: "Review request (post-shipping)", present: has(['review','rating','judge']), critical: true,
     gap_text: "MISSING from this view. If reviews already auto-trigger via Judge.me that's fine — but isn't being tracked here. Worth confirming with the team."},
    {label: "Anniversary (first-purchase 12mo)", present: has(['anniversary']), critical: false,
     gap_text: "MISSING. Trigger 12mo after first purchase to re-engage now-dormant first-time buyers."},
  ];

  const missingCritical = flowChecklist.filter(f => f.critical && !f.present).length;
  const presentCount = flowChecklist.filter(f => f.present).length;

  return (<div className="card" style={{marginBottom:14, borderLeft:'3px solid #c084fc'}}>
    <h2>Email programme health + flow gap audit</h2>
    <div className="muted" style={{marginBottom:10, fontSize:12}}>
      Lux audit of deliverability signals, list growth, and flow coverage vs DTC best-practice inventory.
    </div>
    <div className="row" style={{marginBottom:10}}>
      <div className="card kpi" style={{borderLeft: mppFlag ? '3px solid #fbbf24' : '3px solid #4ade80'}}>
        <div className="label">Open rates {mppFlag && <span style={{color:'#fbbf24',fontSize:10}}>⚠ MPP inflated</span>}</div>
        <div className="val">{(campOpenW*100).toFixed(0)}% / {(flowOpenW*100).toFixed(0)}%</div>
        <div className="sub">campaigns / flows. {mppFlag ? 'Apple Mail Privacy Protection auto-fetches emails since iOS 15 — anything >50% is inflated. Click rate is the true engagement signal.' : 'Open rates look natural.'}</div>
      </div>
      <div className="card kpi" style={{borderLeft:'3px solid #5b8def'}}>
        <div className="label">Click rates (truth)</div>
        <div className="val">{(campClickW*100).toFixed(1)}% / {(flowClickW*100).toFixed(1)}%</div>
        <div className="sub">campaigns / flows · vs DTC benchmarks 2.5% campaigns / 5%+ flows</div>
      </div>
      <div className="card kpi" style={{borderLeft:'3px solid #4ade80'}}>
        <div className="label">List net growth (60d)</div>
        <div className="val">+{NUM(netGrowth)}</div>
        <div className="sub">{NUM(subs)} subs · {NUM(unsubs)} unsubs · churn ~{(dailyChurnRate*1000).toFixed(2)}‰/day proxy</div>
      </div>
      <div className="card kpi" style={{borderLeft: missingCritical > 0 ? '3px solid #f87171' : '3px solid #4ade80'}}>
        <div className="label">Critical flow gaps</div>
        <div className="val">{missingCritical}</div>
        <div className="sub">{presentCount} of {flowChecklist.length} best-practice flows present</div>
      </div>
    </div>
    <div className="row">
      <div className="card" style={{flex:'2 1 460px'}}>
        <h2>Flow inventory vs best-practice DTC stack</h2>
        <table><thead><tr><th>Flow</th><th className="tl">Status</th><th className="tl">Notes</th></tr></thead><tbody>
        {flowChecklist.map((f,i)=>(<tr key={i}>
          <td style={{fontSize:12}}>{f.label} {f.critical && <span className="muted" style={{fontSize:10,marginLeft:4}}>critical</span>}</td>
          <td className="tl">{f.present ? <span className="pill" style={{background:'var(--good-bg)',color:'var(--good)',fontSize:10,padding:'2px 6px',borderRadius:4,fontWeight:700}}>PRESENT</span> : <span className="pill" style={{background:'var(--bad-bg)',color:'var(--bad)',fontSize:10,padding:'2px 6px',borderRadius:4,fontWeight:700}}>GAP</span>}</td>
          <td className="muted tl" style={{fontSize:11,maxWidth:340}}>{f.present ? (f.present_detail || '—') : (f.gap_text || 'Not detected in current flow list.')}</td>
        </tr>))}
        </tbody></table>
      </div>
      <div className="card" style={{flex:'1 1 300px'}}>
        <h2>Deliverability + list health flags</h2>
        <div style={{display:'flex',flexDirection:'column',gap:10,fontSize:12.5}}>
          {mppFlag && (<div style={{padding:10,background:'var(--bg-app)',borderLeft:'3px solid #fbbf24',borderRadius:'0 6px 6px 0'}}>
            <div style={{fontWeight:600,marginBottom:3,color:'#fbbf24'}}>⚠ Apple MPP open-rate inflation</div>
            <div className="muted">Campaign opens {(campOpenW*100).toFixed(0)}%, flow opens {(flowOpenW*100).toFixed(0)}%. Real open rates are likely 25-40% lower. <b>Don't optimise on open rate</b>. Use click rate + order-attributed revenue as the true signals. Suppress "non-openers" segmentation that relies on opens; use "non-clickers" instead.</div>
          </div>)}
          <div style={{padding:10,background:'var(--bg-app)',borderLeft:'3px solid #5b8def',borderRadius:'0 6px 6px 0'}}>
            <div style={{fontWeight:600,marginBottom:3}}>List engagement decay risk</div>
            <div className="muted">No 30/60/90d engagement segmentation visible in current data. <b>Recommended:</b> create "actively engaged" (opened or clicked in last 30d) and "decayed" (no engagement 60d+) segments. Suppress decayed list from regular campaigns or reactivate via re-engagement series. Otherwise sender rep degrades over months.</div>
          </div>
          <div style={{padding:10,background:'var(--bg-app)',borderLeft:'3px solid #f87171',borderRadius:'0 6px 6px 0'}}>
            <div style={{fontWeight:600,marginBottom:3,color:'#f87171'}}>Bounce/spam complaint rate not tracked</div>
            <div className="muted">Supermetrics' Klaviyo connector doesn't expose bounce or spam-complaint rates in current pull. <b>Manual check needed:</b> log into Klaviyo → Analytics → Deliverability. Bounce rate should be &lt;2%, spam complaints &lt;0.1%. Higher = deliverability is at risk.</div>
          </div>
          <div style={{padding:10,background:'var(--bg-app)',borderLeft:'3px solid #c084fc',borderRadius:'0 6px 6px 0'}}>
            <div style={{fontWeight:600,marginBottom:3}}>Top opportunity: win-back flow</div>
            <div className="muted">~35% of orders are returning customers, but there's no flow nurturing the lapsed segment. Building a win-back (trigger at 60-90d since purchase) likely adds £200-500/mo at current scale. Best-practice format: nostalgia trigger → product reminder → discount escalation.</div>
          </div>
        </div>
      </div>
    </div>
    <div className="note" style={{marginTop:14}}><b>Lux's read:</b> the flow programme is fundamentally healthy (5 critical flows present, per-category welcomes is best-practice). The two missing critical flows are <b>win-back</b> and <b>review request</b> — both are 1-time builds with ongoing revenue. The MPP open-rate inflation isn't a problem per se, but means anyone optimising on opens (subject-line testing) is optimising for noise. Click-rate-as-truth is the right rule.</div>
  </div>);
}

function EmailHub(){
  const camps = (B.emailCampaigns||[]).filter(c=>c.recipients);
  const flows = (B.emailFlows||[]).filter(c=>c.recipients);
  const summary = B.emailSummary || {campaigns:{}, flows:{}};
  const campSorted = [...camps].sort((a,b)=>(b.revPerRecip||0)-(a.revPerRecip||0));
  const flowSorted = [...flows].sort((a,b)=>(b.revPerRecip||0)-(a.revPerRecip||0));
  const campByDate = [...camps].sort((a,b)=>(a.sendDate<b.sendDate?1:-1));
  // Aggregate by week for cadence chart
  const wkMap = {};
  camps.forEach(c=>{
    if (!c.sendDate || c.sendDate.length<10) return;
    const wk = c.sendDate.slice(0,10);
    wkMap[wk] = wkMap[wk] || {date: wk.slice(5), sends:0, revenue:0, recipients:0};
    wkMap[wk].sends += 1;
    wkMap[wk].revenue += c.orderValue || 0;
    wkMap[wk].recipients += c.recipients || 0;
  });
  const sendChart = Object.values(wkMap).sort((a,b)=>(a.date<b.date?-1:1));
  // Lift ratio
  const lift = summary.flows.revPerRecip && summary.campaigns.revPerRecip ? (summary.flows.revPerRecip/summary.campaigns.revPerRecip).toFixed(1) : '—';
  const totalRev = (summary.flows.orderValue||0) + (summary.campaigns.orderValue||0);
  const flowShare = totalRev ? summary.flows.orderValue/totalRev : null;
  // Discount dependency (Phase 3.2) — code-level proxy from FRKL_DISCOUNT_CODES:
  // promo/campaign codes (pushed in broadcasts & flows) vs standing affiliate codes.
  const _codes = (typeof window!=='undefined' && window.FRKL_DISCOUNT_CODES && window.FRKL_DISCOUNT_CODES.codes) || [];
  const _promo = _codes.filter(c=>c && c.pattern!=='always-on');
  const promoRev = _promo.reduce((a,c)=>a+(c.revenue||0),0);
  const promoDisc = _promo.reduce((a,c)=>a+(c.discount||0),0);
  const promoRate = (promoRev+promoDisc)>0 ? promoDisc/(promoRev+promoDisc) : null;
  const alwaysOnDisc = _codes.filter(c=>c&&c.pattern==='always-on').reduce((a,c)=>a+(c.discount||0),0);
  return (<div>
    <EmailAttributionPanel/>
    <EmailHealthPanel/>
    {_codes.length>0 && (<div className="card" style={{marginBottom:14, borderLeft:'3px solid var(--warn)'}}>
      <h2>How discount-dependent is email-driven demand?</h2>
      <div className="muted" style={{marginBottom:10, fontSize:12}}>Promo/campaign codes — the kind pushed in broadcasts &amp; flows — vs standing affiliate codes. <i>(A precise email-attributed split needs the Klaviyo↔Shopify order-code join; this is the code-level proxy.)</i></div>
      <div className="row">
        <KPI label="Revenue on promo codes" val={GBP(promoRev)} sub={`${_promo.length} campaign/promo codes`}/>
        <KPI label="Discount given (promo)" val={GBP(promoDisc)} sub={promoRate!=null?`${PCT(promoRate)} blended off`:''} goodDirection="down"/>
        <KPI label="Always-on affiliate leak" val={GBP(alwaysOnDisc)} sub="standing codes — margin given away regardless of channel" goodDirection="down"/>
      </div>
      <div className="note" style={{marginTop:6}}>If broadcast revenue mostly rides on a code, that demand is <b>rented, not owned</b> — a margin risk. Build full-price email angles (new-in, restock, editorial, UGC) so campaigns aren't only "here's a discount", and reserve codes for genuine win-back.</div>
    </div>)}
    <div className="card" style={{marginBottom:14, borderLeft:'3px solid #c084fc'}}>
      <h2>Email is the #1 revenue channel — and flows are doing the heavy lifting</h2>
      <div className="muted" style={{marginBottom:10,fontSize:12}}>Last 90 days · Klaviyo via Supermetrics. Campaigns = broadcasts. Flows = automated triggers (welcome, abandoned cart, browse abandonment, back-in-stock, birthday).</div>
      <div className="row">
        <KPI label="Flow revenue (90d)" val={GBP(summary.flows.orderValue)} sub={`${summary.flows.messages} messages · ${NUM(summary.flows.recipients)} recipients`}
          agent="Lux" observation={`Flows generate ${PCT(flowShare)} of email revenue from just ${summary.flows.messages} message templates.`}
          implication={DEMO ? "This is the highest-margin marketing activity frkl runs. Investment in flow optimisation = direct revenue." : undefined} />
        <KPI label="Campaign revenue (90d)" val={GBP(summary.campaigns.orderValue)} sub={`${summary.campaigns.messages} sends · ${NUM(summary.campaigns.recipients)} total recipients`} series={sendChart.map(w=>({d:w.date, v:Math.round(w.revenue)}))} seriesLabel="Campaign revenue · by send date"
          agent="Lux" observation={`${summary.campaigns.messages} broadcasts producing ${GBP(summary.campaigns.orderValue)} — less revenue than 15 flow messages.`}
          implication="Send cadence is high; revenue per send isn't. Either cut the 50% lowest-performing or differentiate angles." />
        <KPI label="Flow rev per recipient" val={'£'+(summary.flows.revPerRecip||0).toFixed(2)} sub={`vs £${(summary.campaigns.revPerRecip||0).toFixed(2)} for campaigns — ${lift}× lift`}
          agent="Atlas" observation={`Each flow recipient is worth ${lift}× more than a campaign recipient.`}
          implication="The action: get more profiles INTO flows (sign-up forms, browse, cart, post-purchase) before sending another broadcast." />
        <KPI label="Avg open rate (camp.)" val={PCT(summary.campaigns.avgOpenRate)} sub={`Click ${PCT(summary.campaigns.avgClickRate)} — flows avg ${PCT(summary.flows.avgOpenRate)} open`}
          agent="Lux" observation="58% campaign open rate is excellent — list hygiene + brand affinity are strong. Click-through is the weak link."
          implication="Subject lines work; CTAs and content layout don't. A/B test single-CTA emails next." />
      </div>
    </div>
    <div className="row">
      <div className="card" style={{flex:'2 1 480px'}}>
        <h2>Top flows by revenue per recipient</h2>
        <div className="muted" style={{marginBottom:8,fontSize:12}}>The signal: which automated touchpoints justify investment in deeper personalisation.</div>
        <table><thead><tr><th>Flow</th><th>Recip</th><th>Open</th><th>Click</th><th>Orders</th><th>Revenue</th><th>£/recip</th></tr></thead><tbody>
        {flowSorted.map((f,i)=>(<tr key={i}>
          <td style={{fontSize:12}}>{f.name}</td>
          <td>{NUM(f.recipients)}</td>
          <td>{PCT(f.openRate)}</td>
          <td>{PCT(f.clickRate)}</td>
          <td>{f.orders}</td>
          <td>{GBP(f.orderValue)}</td>
          <td><b style={{color:f.revPerRecip>3?'#4ade80':f.revPerRecip>1?'#fbbf24':'#7b7b87'}}>£{(f.revPerRecip||0).toFixed(2)}</b></td>
        </tr>))}
        </tbody></table>
      </div>
      <div className="card" style={{flex:'1 1 280px'}}>
        <h2>Quick wins</h2>
        <div style={{display:'flex',flexDirection:'column',gap:10,fontSize:12.5}}>
          <div style={{padding:10,background:'var(--bg-app)',borderLeft:'3px solid #4ade80',borderRadius:'0 6px 6px 0'}}>
            <div style={{fontWeight:600,marginBottom:3}}>Back-in-Stock at £8.16/recipient</div>
            <div className="muted">Best-performing flow. Audit which products trigger it — expand to more SKUs.</div>
          </div>
          <div style={{padding:10,background:'var(--bg-app)',borderLeft:'3px solid #4ade80',borderRadius:'0 6px 6px 0'}}>
            <div style={{fontWeight:600,marginBottom:3}}>NECKLACES Welcome at £6.65/recipient</div>
            <div className="muted">Per-category welcome flows crushing — replicate for new categories.</div>
          </div>
          <div style={{padding:10,background:'var(--bg-app)',borderLeft:'3px solid #fbbf24',borderRadius:'0 6px 6px 0'}}>
            <div style={{fontWeight:600,marginBottom:3}}>Happy Birthday flow = 0 revenue</div>
            <div className="muted">Open rate 41% but zero orders. Subject works, CTA doesn't. Test a stronger offer.</div>
          </div>
          <div style={{padding:10,background:'var(--bg-app)',borderLeft:'3px solid #f87171',borderRadius:'0 6px 6px 0'}}>
            <div style={{fontWeight:600,marginBottom:3}}>43 campaigns in 90d = 1 every 2 days</div>
            <div className="muted">High frequency. List fatigue likely — consider cutting low performers.</div>
          </div>
        </div>
      </div>
    </div>
    <div className="card" style={{marginTop:14}}>
      <h2>Campaign sends by week</h2>
      <R.ResponsiveContainer width="100%" height={220}>
        <R.ComposedChart data={sendChart} margin={{top:6,right:12,left:14,bottom:18}}>
          <R.CartesianGrid stroke="#222229" vertical={false} />
          <R.XAxis dataKey="date" tick={{fill:'#6f6f7b',fontSize:10}} interval={Math.ceil(sendChart.length/12)} label={{value:'Date', position:'insideBottom', offset:-6, fill:'#6f6f7b', fontSize:10}} />
          <R.YAxis yAxisId="l" tick={{fill:'#6f6f7b',fontSize:10}} label={{value:'Sends', angle:-90, position:'insideLeft', style:{textAnchor:'middle'}, fill:'#6f6f7b', fontSize:10}} />
          <R.YAxis yAxisId="r" orientation="right" tick={{fill:'#6f6f7b',fontSize:10}} tickFormatter={v=>'£'+(v/1000).toFixed(1)+'k'} label={{value:'Revenue (£)', angle:90, position:'insideRight', style:{textAnchor:'middle'}, fill:'#6f6f7b', fontSize:10}} />
          <R.Tooltip contentStyle={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:10}} />
          <R.Legend verticalAlign="top" align="center" wrapperStyle={{fontSize:11, paddingBottom:8}}/>
          <R.Bar yAxisId="l" dataKey="sends" name="Campaign sends" fill={COL.email} />
          <R.Line yAxisId="r" type="monotone" dataKey="revenue" name="Revenue" stroke={COL.revenue} strokeWidth={2} dot={false} />
        </R.ComposedChart>
      </R.ResponsiveContainer>
      <ChartFooter note="Are we over-emailing? Watch revenue-per-send falling as send volume climbs."
        ask="Looking at email send volume vs revenue, are we over-emailing the list and is revenue-per-send holding up?"
        rows={sendChart} columns={[{key:'date',label:'Date'},{key:'sends',label:'Sends',right:true,fmt:v=>NUM(v)},{key:'revenue',label:'Revenue',right:true,fmt:v=>GBP(v)}]}/>
    </div>
    <div className="card" style={{marginTop:14}}>
      <h2>All campaigns — sorted by recent</h2>
      <table><thead><tr><th>Date</th><th>Name</th><th>Subject</th><th>Recip</th><th>Open</th><th>Click</th><th>Orders</th><th>Revenue</th><th>£/recip</th></tr></thead><tbody>
      {campByDate.slice(0,30).map((c,i)=>(<tr key={i}>
        <td style={{whiteSpace:'nowrap'}}>{c.sendDate}</td>
        <td style={{fontSize:11}}>{c.name}</td>
        <td className="muted" style={{fontSize:11,maxWidth:240}}>{c.subject}</td>
        <td>{NUM(c.recipients)}</td>
        <td>{PCT(c.openRate)}</td>
        <td>{PCT(c.clickRate)}</td>
        <td>{c.orders}</td>
        <td>{GBP(c.orderValue)}</td>
        <td><span style={{color:c.revPerRecip>0.2?'#4ade80':c.revPerRecip>0.05?'#e8e8ec':'#7b7b87'}}>£{(c.revPerRecip||0).toFixed(2)}</span></td>
      </tr>))}
      </tbody></table>
      <div className="muted" style={{fontSize:11,marginTop:8}}>Showing 30 most recent of {camps.length} campaigns.</div>
    </div>
    {DEMO && <div className="note" style={{marginTop:14}}><b>Lux's read:</b> the 19× revenue lift of flows over campaigns is the single biggest leverage finding in this dashboard. Every pound spent making flows smarter (segmentation, dynamic content, more triggers) returns multiples of any pound spent on the next broadcast. Three immediate moves: (1) audit Back-in-Stock — expand triggers to more SKUs; (2) replicate the NECKLACES per-category welcome flow for charms/bracelets/pre-styled (already exists for those — confirm performance match); (3) fix the Happy Birthday flow — open rate proves attention, offer must be stronger to convert.</div>}
  </div>);
}

function ContentCalendar(){
  const posts = B.igPosts60d || [];
  const stories = B.igStories || [];
  const cadence = B.contentCadence || [];
  // Build a calendar grid by date
  const byDate = {};
  posts.forEach(p=>{ byDate[p.date] = byDate[p.date] || []; byDate[p.date].push({...p, _kind:'post'}); });
  stories.forEach(s=>{ byDate[s.date] = byDate[s.date] || []; byDate[s.date].push({...s, _kind:'story'}); });
  // 60-day window of dates (most recent)
  const today = posts.concat(stories).map(p=>p.date).sort();
  const last = today[today.length-1] || '2026-05-26';
  // Build 8 weeks of dates ending on most recent Sunday
  const end = new Date(last);
  const dayOfWeek = end.getDay(); // 0=Sun
  // Roll back to end of that week (Sunday)
  end.setDate(end.getDate() + (7-dayOfWeek)%7);
  const weeks = [];
  for (let w=7; w>=0; w--) {
    const wk = [];
    for (let d=0; d<7; d++) {
      const date = new Date(end);
      date.setDate(end.getDate() - (w*7) - (6-d));
      wk.push(date.toISOString().slice(0,10));
    }
    weeks.push(wk);
  }
  const dayLabels = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  // Stats
  const days = Object.keys(byDate).length;
  const avgPerWeek = posts.length / 8;
  const reelCount = posts.filter(p=>p.type==='REELS').length;
  const feedCount = posts.length - reelCount;
  const storyCount = stories.length;
  const avgEngRate = posts.length ? posts.reduce((a,p)=>a+(p.engRate||0),0)/posts.length : 0;
  return (<div className="card" style={{marginTop:14}}>
    <h2>Content calendar — last 8 weeks</h2>
    <div className="muted" style={{marginBottom:10,fontSize:12}}>Sage view: posting cadence + topic mix at a glance. Click any cell for the post; colour indicates engagement rate (reach-weighted).</div>
    <div className="row" style={{marginBottom:14}}>
      <div className="card kpi"><div className="label">Posts (60d)</div><div className="val">{posts.length}</div><div className="sub">{reelCount} reels · {feedCount} feed · {storyCount} stories</div></div>
      <div className="card kpi"><div className="label">Avg per week</div><div className="val">{avgPerWeek.toFixed(1)}</div><div className="sub">vs benchmark 4-5 for active DTC</div></div>
      <div className="card kpi"><div className="label">Posting days</div><div className="val">{days}/{8*7}</div><div className="sub">{PCT(days/56)} of days had content</div></div>
      <div className="card kpi"><div className="label">Avg engagement rate</div><div className="val">{PCT(avgEngRate)}</div><div className="sub">Of reach. Strong if &gt;3%, breakout &gt;6%.</div></div>
    </div>
    <div style={{overflowX:'auto'}}>
      <table style={{width:'100%',borderCollapse:'separate',borderSpacing:'4px 4px'}}>
        <thead><tr><th></th>{dayLabels.map(d=>(<th key={d} style={{fontSize:10,color:'var(--text-faint)',fontWeight:500}}>{d}</th>))}</tr></thead>
        <tbody>
          {weeks.map((wk,wi)=>(<tr key={wi}>
            <td style={{fontSize:10,color:'var(--text-faint)',padding:'0 6px',whiteSpace:'nowrap'}}>{wk[0].slice(5)}</td>
            {wk.map((date,di)=>{
              const items = byDate[date] || [];
              const hasContent = items.length > 0;
              const reels = items.filter(i=>i.type==='REELS' || i._kind==='story' && i.type==='VIDEO');
              const carousel = items.filter(i=>i.type==='CAROUSEL_ALBUM');
              const stories = items.filter(i=>i._kind==='story');
              const maxEng = items.reduce((a,i)=>Math.max(a,i.engRate||0),0);
              const colour = !hasContent ? 'var(--heat-empty)' : maxEng>0.06 ? 'var(--heat-high)' : maxEng>0.03 ? 'var(--heat-mid)' : maxEng>0.01 ? 'var(--heat-low)' : 'var(--heat-none)';
              const tooltip = items.map(i=>`${i._kind==='story'?'STORY':i.type} · ${(i.caption||'').slice(0,40)}`).join('\n');
              return (<td key={di} style={{width:50,height:48,background:colour,borderRadius:6,verticalAlign:'top',padding:4,cursor:hasContent?'pointer':'default',position:'relative'}} title={tooltip} onClick={()=>{ if(items[0]?.permalink) window.open(items[0].permalink,'_blank'); }}>
                <div style={{fontSize:9,color:'var(--heat-ink)',fontWeight:600}}>{parseInt(date.slice(8,10))}</div>
                {hasContent && (<div style={{position:'absolute',bottom:2,right:2,display:'flex',gap:2}}>
                  {reels.length>0 && <span style={{fontSize:8,background:'#5b8def',color:'#fff',padding:'1px 3px',borderRadius:3,fontWeight:700}}>R{reels.length>1?reels.length:''}</span>}
                  {carousel.length>0 && <span style={{fontSize:8,background:'#c084fc',color:'#fff',padding:'1px 3px',borderRadius:3,fontWeight:700}}>F{carousel.length>1?carousel.length:''}</span>}
                  {stories.length>0 && <span style={{fontSize:8,background:'#fbbf24',color:'#000',padding:'1px 3px',borderRadius:3,fontWeight:700}}>S{stories.length>1?stories.length:''}</span>}
                </div>)}
              </td>);
            })}
          </tr>))}
        </tbody>
      </table>
    </div>
    <div style={{marginTop:10,display:'flex',gap:14,fontSize:11,color:'var(--text-muted)',flexWrap:'wrap'}}>
      <span><span style={{display:'inline-block',width:10,height:10,background:'var(--heat-high)',borderRadius:2,marginRight:4,verticalAlign:'middle'}}/>Breakout (&gt;6% eng)</span>
      <span><span style={{display:'inline-block',width:10,height:10,background:'var(--heat-mid)',borderRadius:2,marginRight:4,verticalAlign:'middle'}}/>Strong (3-6%)</span>
      <span><span style={{display:'inline-block',width:10,height:10,background:'var(--heat-low)',borderRadius:2,marginRight:4,verticalAlign:'middle'}}/>Low (1-3%)</span>
      <span><span style={{display:'inline-block',width:10,height:10,background:'var(--heat-none)',borderRadius:2,marginRight:4,verticalAlign:'middle',border:'1px solid var(--border-subtle)'}}/>Posted, no reach data</span>
      <span><span style={{display:'inline-block',width:10,height:10,background:'var(--heat-empty)',borderRadius:2,marginRight:4,verticalAlign:'middle',border:'1px solid var(--border-subtle)'}}/>No content</span>
    </div>
    <div className="note" style={{marginTop:14}}><b>Sage's read:</b> {avgPerWeek.toFixed(1)} posts/week is on the low side for a DTC brand fighting for organic reach — 4-5/week is the active competitor benchmark. The {storyCount === 0 ? 'complete absence of Stories' : storyCount + ' story in 60 days'} is the biggest organic blind spot — Stories are the daily-cadence touchpoint that competitors (Astrid &amp; Miyu, Abbott Lyon) use for behind-the-scenes, drops, and link-to-product. Brief Angela on a weekly Story cadence (3-5/week minimum).</div>
  </div>);
}

function StoriesPanel(){
  const stories = B.igStories || [];
  return (<div className="card" style={{marginTop:14, borderLeft:'3px solid #fbbf24'}}>
    <h2>Instagram Stories — last 60 days</h2>
    {DEMO && <div className="muted" style={{marginBottom:10,fontSize:12}}>Stories are the daily-cadence organic surface. Competitors post 5-15/week; frkl posted {stories.length} in 60 days.</div>}
    {stories.length === 0 ? (<EmptyState icon="image"
      title="No Instagram Stories in the last 60 days"
      body="Stories are the daily-cadence organic touchpoint — they outperform Feed for product link-outs and live-feel community signals. Competitors post 5–15 a week; a consistent Stories habit is one of the cheapest reach levers you have."
      cta="Ask AI for a Stories plan" ctaOnClick={()=>window.__oiAsk && window.__oiAsk('I post no Instagram Stories. Give me a simple weekly Stories cadence and content plan to lift organic reach.')}/>) : (
      <table><thead><tr><th>Date</th><th>Type</th><th>Views</th><th>Reach</th><th>Exits</th><th>Replies</th><th>Shares</th><th>Tap fwd</th><th>Tap back</th><th>Completion</th></tr></thead><tbody>
      {stories.map((s,i)=>{
        const completion = s.views ? 1 - (s.exits||0)/s.views : null;
        return (<tr key={i}>
          <td>{s.date}</td>
          <td><span className="pill blue">{s.type}</span></td>
          <td>{NUM(s.views)}</td>
          <td>{NUM(s.reach)}</td>
          <td>{s.exits}</td>
          <td>{s.replies}</td>
          <td>{s.shares}</td>
          <td>{s.tapsForward}</td>
          <td>{s.tapsBack}</td>
          <td><b style={{color:completion>0.8?'#4ade80':completion>0.6?'#fbbf24':'#f87171'}}>{PCT(completion)}</b></td>
        </tr>);
      })}
      </tbody></table>
    )}
    {DEMO && <div className="note" style={{marginTop:14}}><b>Frame's read:</b> the one Story posted on 2026-05-26 had 161 views, 122 reach, 93% completion (only 11 exits of 161 views) — strong signal that when frkl posts Stories, the audience watches. The opportunity: 0.5 stories/month is essentially "Stories are off". Move to 3-5/week. Use as: behind-the-scenes (campaign shoots, packing), new-product reveals, polls/quizzes, link-stickers to bestsellers. Each Story is essentially a free push notification to ~30% of your 37k followers.</div>}
  </div>);
}

function InstagramPanel(){
  React.useEffect(()=>{const t=setTimeout(()=>window.dispatchEvent(new Event('resize')),80);return ()=>clearTimeout(t);},[]);
  const snap=B.igSnapshot||{}; const daily=B.igDaily||[]; const audience=B.igAudience||[]; const posts=B.igPosts||[];
  const totalNew=daily.reduce((a,r)=>a+(r.newFollowers||0),0);
  const avgReach=daily.reduce((a,r)=>a+(r.reach||0),0)/Math.max(1,daily.length);
  const avgViews=daily.reduce((a,r)=>a+(r.profileViews||0),0)/Math.max(1,daily.length);
  // age aggregation
  const ageOrder=['13-17','18-24','25-34','35-44','45-54','55-64','65+'];
  const byAge={};
  audience.forEach(a=>{ const k=a.age; byAge[k]=byAge[k]||{age:k, female:0, male:0, undef:0, total:0}; byAge[k][a.gender==='female'?'female':a.gender==='male'?'male':'undef']+=a.followers||0; byAge[k].total+=a.followers||0; });
  const ageRows=ageOrder.map(a=>byAge[a]).filter(Boolean);
  const totalAudience=ageRows.reduce((a,b)=>a+b.total,0);
  const totalFemale=ageRows.reduce((a,b)=>a+b.female,0);
  // chart
  const dailyChart=daily.map(d=>({date:d.date.slice(5), new:d.newFollowers||0, reach:d.reach||0}));
  // top posts sorted by likes
  const topPosts=[...posts].sort((a,b)=>(b.likes||0)-(a.likes||0));
  const totalEng=posts.reduce((a,p)=>a+(p.likes||0)+(p.comments||0)+(p.saves||0)+(p.shares||0),0);
  // Hover-graph trends (real daily IG data).
  const igNewSeries   = daily.map(d=>({d:(d.date||'').slice(5), v:d.newFollowers||0}));
  const igReachSeries = daily.map(d=>({d:(d.date||'').slice(5), v:Math.round(d.reach||0)}));
  const igFollowerSeries = (function(){ const out=[]; let run=snap.followers||0; for(let i=daily.length-1;i>=0;i--){ out.unshift({d:(daily[i].date||'').slice(5), v:Math.round(run)}); run -= (daily[i].newFollowers||0); } return out; })();
  return (<div style={{marginTop:14}}>
    <div className="card" style={{marginBottom:14}}>
      <h2>Instagram organic — {OI_BRAND.name||'frkl'}</h2>
      <div className="muted" style={{marginBottom:10}}>Live from Instagram Insights via Supermetrics. Profile snapshot + last-30-days growth + top-20 posts (last 90 days).</div>
      <div className="row">
        <KPI label="Followers" val={NUM(snap.followers)} sub={`${NUM(snap.mediaCount)} posts · following ${NUM(snap.follows)}`} series={igFollowerSeries} seriesLabel="Total followers · by day"
          agent="Lux" observation="37.8k followers, 974 posts — a substantial owned audience that converts at the highest ROAS when reached."
          implication="Treat this list with the same intent as your email list — content cadence, IG-native creator collabs." />
        <KPI label="New followers (30d)" val={'+'+NUM(totalNew)} sub={`~${Math.round(totalNew/30)} /day avg`} series={igNewSeries} seriesLabel="New followers · by day"
          agent="Sage" observation="+613 in 30d with a May 17 outlier (+86) — proves content can break out when the topic lands."
          implication="Study what drove May 17. If repeatable, it's a recurring lever for organic acquisition." />
        <KPI label="Avg daily reach" val={NUM(avgReach)} sub={`Profile views ${NUM(avgViews)}/day`} series={igReachSeries} seriesLabel="Daily reach · by day"
          agent="Frame" observation="~9.5k people reached organically every day — roughly what £100/day of paid would buy you."
          implication="Organic IG is paid-equivalent reach for free. Brief 2 content pillars per week, not occasional one-offs." />
        <KPI label="Top post (90d)" val={NUM(topPosts[0]?.views)} sub={`${topPosts[0]?.likes} likes — ${(topPosts[0]?.caption||'').slice(0,32)}…`}
          agent="Frame" observation="The ADHD reel (79k views) is the breakout outlier — non-jewellery, relatable hook, broad appeal."
          implication="Test more lifestyle/relatable content alongside product posts. Not every Reel needs to sell directly." />
      </div>
    </div>
    <div className="row">
      <div className="card" style={{flex:'2 1 420px'}}>
        <h2>Daily growth — new followers + reach</h2>
        <R.ResponsiveContainer width="100%" height={240}>
          <R.ComposedChart data={dailyChart} margin={{top:6,right:10,left:14,bottom:18}}>
            <R.CartesianGrid stroke="#222229" vertical={false} />
            <R.XAxis dataKey="date" tick={{fill:'#6f6f7b',fontSize:10}} interval={Math.ceil(dailyChart.length/8)} label={{value:'Date', position:'insideBottom', offset:-6, fill:'#6f6f7b', fontSize:10}} />
            <R.YAxis yAxisId="l" tick={{fill:'#6f6f7b',fontSize:10}} label={{value:'New followers', angle:-90, position:'insideLeft', style:{textAnchor:'middle'}, fill:'#6f6f7b', fontSize:10}} />
            <R.YAxis yAxisId="r" orientation="right" tick={{fill:'#6f6f7b',fontSize:10}} tickFormatter={v=>(v/1000).toFixed(0)+'k'} label={{value:'Reach', angle:90, position:'insideRight', style:{textAnchor:'middle'}, fill:'#6f6f7b', fontSize:10}} />
            <R.Tooltip contentStyle={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:10}} />
            <R.Legend verticalAlign="top" align="center" wrapperStyle={{fontSize:11, paddingBottom:8}}/>
            <R.Bar yAxisId="l" dataKey="new" name="New followers" fill={COL.email} />
            <R.Line yAxisId="r" type="monotone" dataKey="reach" name="Reach" stroke={COL.sessions} strokeWidth={2} dot={false} />
          </R.ComposedChart>
        </R.ResponsiveContainer>
      </div>
      <div className="card" style={{flex:'1 1 320px'}}>
        <h2>Follower audience (age × gender)</h2>
        <div className="muted" style={{marginBottom:8,fontSize:12}}>{PCT(totalFemale/totalAudience)} female · {NUM(totalAudience)} followers with reported demographics</div>
        <table><thead><tr><th>Age</th><th>Female</th><th>Other</th><th>% of total</th></tr></thead><tbody>
        {ageRows.map((r,i)=>(<tr key={i}>
          <td>{r.age}</td>
          <td>{NUM(r.female)}</td>
          <td>{NUM(r.male+r.undef)}</td>
          <td><span style={{display:'inline-block',width:80,background:'#23232b',borderRadius:4,height:8,position:'relative',marginRight:8,verticalAlign:'middle'}}><span style={{display:'block',width:(100*r.total/totalAudience)+'%',height:8,background:COL.email,borderRadius:4}}/></span>{PCT(r.total/totalAudience)}</td>
        </tr>))}
        </tbody></table>
      </div>
    </div>
    <div className="card" style={{marginTop:14}}>
      <h2>Top posts — last 90 days</h2>
      <div className="muted" style={{marginBottom:10}}>Sorted by likes. Click any title to open the original post. Thumbnails are Instagram CDN URLs — they may expire after ~24h; regenerate the data file for fresh images.</div>
      <div className="grid cg">
      {topPosts.slice(0,20).map((p,i)=>{
        const eng=(p.likes||0)+(p.comments||0)+(p.saves||0)+(p.shares||0);
        return (<div className="creative" key={i}>
          {p.thumb?(<img className="thumb" src={p.thumb} alt={p.caption?.slice(0,30)} referrerPolicy="no-referrer" onError={e=>{e.target.style.opacity=.2;}} />):(<div className="thumb" style={{display:'flex',alignItems:'center',justifyContent:'center',color:'#5a5a64',fontSize:11,letterSpacing:1}}>{p.type==='CAROUSEL_ALBUM'?'CAROUSEL':p.type}</div>)}
          <div className="body">
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'start',gap:8}}>
              <a href={p.permalink} target="_blank" rel="noreferrer" className="name" style={{fontSize:12,fontWeight:600,color:'var(--text-primary)'}}>{p.date} · {p.product||p.type}</a>
              <span className="pill grey" style={{fontSize:10}}>#{i+1}</span>
            </div>
            <div className="copy">{p.caption}</div>
            <div style={{marginTop:'auto',display:'flex',flexDirection:'column',gap:3}}>
              <div className="mrow"><span className="k">Views / reach</span><span className="v">{NUM(p.views)} / {NUM(p.reach)}</span></div>
              <div className="mrow"><span className="k">Likes / comments</span><span className="v">{p.likes} · {p.comments}</span></div>
              <div className="mrow"><span className="k">Saves / shares</span><span className="v">{p.saves} · {p.shares}</span></div>
              <div className="mrow"><span className="k">Eng. rate (reach)</span><span className="v">{PCT((p.reach>0)?eng/p.reach:0)}</span></div>
            </div>
          </div>
        </div>);
      })}
      </div>
    </div>
    {DEMO && <div className="note" style={{marginTop:14}}><b>Audience confirmation:</b> the IG follower base independently confirms the Meta Ads finding — frkl is genuinely a <b>35–54 female brand</b> (35–44 ≈ 44%, 45–54 ≈ 31%), with 25–34 a meaningful secondary (~15%). 18–24 is essentially absent (1.4%). The <b>ADHD reel</b> (79k views) is the breakout outlier — non-jewellery content with high relatable hook; worth studying. The <b>#myfrkl UGC mechanic</b> (£250 monthly) is generating reliable engagement on community posts.</div>}
  </div>);
}

function Competitors(){
  const comps=B.competitors||[];
  return (<div>
    <div className="card" style={{marginBottom:14}}>
      <h2>Competitor matrix — Scout snapshot</h2>
      <div className="muted" style={{marginBottom:10}}>Category positioning for the demi-fine / customisable jewellery space. Refresh via Chrome (Meta Ads Library + competitor stores) when warranted — the dashboard's a flag-board, not a live scraper.</div>
      <table><thead><tr><th>Brand</th><th className="tl">Position</th><th>AOV</th><th>Meta intensity</th><th>Threat</th><th className="tl">vs frkl</th></tr></thead><tbody>
      {comps.map((c,i)=>(<tr key={i}>
        <td><b>{c.name}</b><br/><span className="muted" style={{fontSize:11}}>{c.url}</span></td>
        <td className="tl" style={{maxWidth:200}}>{c.position}</td>
        <td>{c.aov}</td>
        <td>{c.metaIntensity}</td>
        <td><span className={'pill '+(c.threat||'grey')}>{c.threat==='red'?'High':c.threat==='amber'?'Watch':'Low'}</span></td>
        <td className="tl" style={{fontSize:12,color:'var(--text-secondary)'}}>{c.vsFrkl}</td>
      </tr>))}
      </tbody></table>
    </div>
    <Insight k="competitive" />
  </div>);
}

function SiteStructure({start}){
  const ga=inRange(D.ga4,start);
  const f=[{stage:'Sessions',v:sum(ga,'sessions')},{stage:'Add to cart',v:sum(ga,'addToCarts')},{stage:'Checkout',v:sum(ga,'checkouts')},{stage:'Purchase',v:sum(ga,'purchases')}];
  const fmax=f[0].v||1;
  return (<div>
    <ClarityFrictionPanel/>
    {DEMO && <div className="note" style={{marginBottom:14}}>Funnel mapped live from myfrkl.com. The problem is <b>engagement and a broken cart→checkout step</b> — see the live Clarity friction signals above. Paid spend (Overview tab) lands on a homepage where most visitors drop before 15% scroll.</div>}
    <div className="row">
      <div className="card" style={{flex:'2 1 520px'}}>
        <h2>Funnel structure & friction</h2>
        {SITE_STEPS.map((s,i)=>(<div key={i} style={{padding:'11px 0',borderBottom:i<SITE_STEPS.length-1?'1px solid #23232b':'none'}}>
          <div style={{display:'flex',alignItems:'center',gap:9,marginBottom:5}}><span className={'pill '+s.sev}>{s.step}</span></div>
          <div style={{fontSize:12.5,color:'#b6b6c0',marginBottom:4}}><b style={{color:'#8a8a96',fontWeight:600}}>On the site:</b> {s.live}</div>
          <div style={{fontSize:12.5,color:s.sev==='red'?'#f4a3a3':'#d8c89a'}}><b style={{color:'#8a8a96',fontWeight:600}}>Friction:</b> {s.issue}</div>
        </div>))}
      </div>
      <div className="card" style={{flex:'1 1 320px'}}>
        <h2>GA4 funnel (selected window)</h2>
        {f.map(s=>(<div key={s.stage} style={{margin:'9px 0'}}>
          <div className="mrow"><span className="k">{s.stage}</span><span className="v">{NUM(s.v)} ({PCT(s.v/fmax)})</span></div>
          <div style={{height:9,background:'#23232b',borderRadius:6,marginTop:4}}><div style={{height:9,width:(100*s.v/fmax)+'%',background:COL.sessions,borderRadius:6}}/></div>
        </div>))}
        <div className="note" style={{marginTop:10,fontSize:12}}>Clarity confirms the killers: <b>ATC→checkout −67.8%</b> (vs 40–50% normal) and <b>checkout→complete −90%</b> (vs 50–60%).</div>
      </div>
    </div>
    <div className="row" style={{marginTop:14}}>
      <div className="card" style={{flex:'1 1 360px'}}>
        <h2>Clarity behaviour vs benchmark</h2>
        <table><thead><tr><th>Metric</th><th>frkl</th><th>Healthy</th></tr></thead><tbody>
          {CLARITY.map((c,i)=>(<tr key={i}><td>{c.m}</td><td><span className={'pill '+c.sev}>{c.v}</span></td><td className="muted">{c.bench}</td></tr>))}
        </tbody></table>
      </div>
      <div className="card" style={{flex:'1 1 360px'}}>
        <h2>Prioritised fixes</h2>
        {FIXES.map((x,i)=>(<div key={i} className="mrow" style={{margin:'8px 0',alignItems:'start'}}><span className="k" style={{maxWidth:'82%'}}>{x.fix}</span><span className={'pill '+(x.p==='P1'?'red':'amber')}>{x.p}</span></div>))}
      </div>
    </div>
    <Insight k="cro" />
    <Insight k="content" />
  </div>);
}

// ===== Intelligence: Operator Intelligence patterns + attributed actions =====
// ── Collapsible helper: shows N items then a "Show X more" button ────────────
function Collapsible({items, initialCount, renderItem, moreLabel}) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, initialCount);
  const hidden = items.length - initialCount;
  return (<>
    <div style={{display:'flex', flexDirection:'column', gap:'var(--s-2)'}}>
      {visible.map(renderItem)}
    </div>
    {hidden > 0 && (
      <button className="show-more" onClick={()=>setExpanded(!expanded)}>
        {expanded ? '↑ Collapse' : `↓ Show ${hidden} more ${moreLabel || ''}`}
      </button>
    )}
  </>);
}

// ── Zone header (visual separator between sections of a tab) ─────────────────
function ZoneHeader({number, title, meta, accent}) {
  return (<div className="zone-header">
    <span className="zone-number" style={accent ? {color: accent, background: accent + '18'} : null}>
      {number}
    </span>
    <span className="zone-title">{title}</span>
    {meta && <span className="zone-meta">{meta}</span>}
  </div>);
}

function IntelligencePanel(){
  const P = window.FRKL_PATTERNS;
  if (!P || !Array.isArray(P.patterns)) {
    return (<div className="card"><EmptyState icon="spark"
      title="Intelligence is still warming up"
      body="No patterns have been detected yet. The intelligence engine surfaces trends, step-changes and anomalies once a few days of synced data are in — check back after the next daily refresh, or ask the analyst directly in the meantime."
      cta="Ask the AI analyst" ctaOnClick={()=>window.__oiAsk && window.__oiAsk('What are the most important things happening in my business right now?')}/></div>);
  }
  const metrics = P.metrics || {};
  const [kindFilter, setKindFilter] = useState('all');
  const [verdictFilter, setVerdictFilter] = useState('all');
  const [sortBy, setSortBy] = useState('effect');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const diagnosesByParent = P.diagnoses_by_parent || {};
  const topLevelPatterns = P.patterns.filter(p => p.kind !== 'diagnosis');
  const kindCounts = topLevelPatterns.reduce((acc, p) => { acc[p.kind] = (acc[p.kind]||0)+1; return acc; }, {});
  const diagnosisCount = P.patterns.length - topLevelPatterns.length;

  // Use design-token-aligned palette: trends are accent, status patterns are semantic
  const KIND_COLOR = {trend:'#7c8cff', change_point:'#f5b544', anomaly:'#ef6b6f', association:'#7c8cff', co_movement:'#7e7e8a', divergence:'#f5b544', money:'#4ade80', diagnosis:'#7c8cff'};
  const VERDICT_COLOR = {favourable:'#4ade80', unfavourable:'#ef6b6f', neutral:'#7e7e8a', hit:'#4ade80', miss:'#ef6b6f', inconclusive:'#7e7e8a'};
  const KIND_LABEL = {trend:'Trend', change_point:'Step change', anomaly:'Anomaly', association:'Action attribution', co_movement:'Co-mover', divergence:'Divergence', money:'£ finding', diagnosis:'Diagnosis'};

  const filtered = topLevelPatterns.filter(p => {
    if (kindFilter !== 'all' && p.kind !== kindFilter) return false;
    const v = p.metadata?.verdict;
    if (verdictFilter !== 'all' && v !== verdictFilter) return false;
    return true;
  }).sort((a, b) => {
    if (sortBy === 'effect') return Math.abs(b.effect_size || 0) - Math.abs(a.effect_size || 0);
    if (sortBy === 'confidence') return (b.confidence || 0) - (a.confidence || 0);
    if (sortBy === 'recent') return (b.detected_at || '').localeCompare(a.detected_at || '');
    return 0;
  });

  const attribActions = P.actions_with_attribution || [];
  const hits = attribActions.filter(a => a.verdict === 'hit').length;
  const misses = attribActions.filter(a => a.verdict === 'miss').length;
  const openCount = attribActions.filter(a => a.verdict == null).length;

  // Pattern card renderer (used inside the Why zone)
  const renderPattern = (p, i) => {
    const m = metrics[p.metric_id] || {};
    const v = p.metadata?.verdict;
    const vc = VERDICT_COLOR[v] || 'var(--text-muted)';
    const kindColor = KIND_COLOR[p.kind] || 'var(--text-muted)';
    const diagnoses = diagnosesByParent[p.description] || [];
    return (<div key={i} className="pattern-card">
      <div className="pattern-card-head">
        <div className="pattern-card-tags">
          <span className="pattern-card-tag" style={{background: kindColor + '18', color: kindColor}}>
            {KIND_LABEL[p.kind] || p.kind}
          </span>
          {m.category && <span className="meta" style={{fontSize:11}}>{m.category}</span>}
          {v && <span style={{fontSize:10, color:vc, fontWeight:600, textTransform:'uppercase', letterSpacing:.04}}>{v}</span>}
        </div>
        <div className="pattern-card-meta">
          {p.effect_size != null && (p.kind==='money'
            ? <span>impact <b style={{color:vc}}>{GBP(p.effect_size)}/mo</b></span>
            : <span>effect <b style={{color:vc}}>{(p.effect_size*100).toFixed(1)}%</b></span>)}
          {p.confidence != null && <span>conf <b>{(p.confidence*100).toFixed(0)}%</b></span>}
        </div>
      </div>
      <div className="pattern-card-desc">{p.description}</div>
      {diagnoses.length > 0 && (<div className="pattern-diagnoses">
        {diagnoses.map((d, di) => (<div key={di} className="pattern-diagnosis">
          <div className="pattern-diagnosis-head">
            <span className="why-pill">Why</span>
            <span className="meta" style={{fontSize:10}}>recipe: {d.recipe}</span>
            {d.confidence != null && <span className="meta" style={{fontSize:10, marginLeft:'auto'}}>conf {Math.round(d.confidence*100)}%</span>}
          </div>
          <div className="pattern-diagnosis-body" dangerouslySetInnerHTML={{__html: d.description}}/>
        </div>))}
      </div>)}
    </div>);
  };

  // P(hit) action rows
  const phitRows = (() => {
    if (!P.action_phit) return [];
    const all = Object.entries(P.action_phit).map(([id, ph]) => {
      let match = null;
      if (window.FRKL_INSIGHTS) {
        for (const area of Object.values(window.FRKL_INSIGHTS)) {
          const found = (area.actions || []).find(a => a.id === id);
          if (found) { match = {...found, agent: area.agent}; break; }
        }
      }
      const st = (window.FRKL_ACTION_STATUS || {})[id] || {};
      const mon = (P.action_money || {})[id] || {};
      // Prefer the reconciled live copy from action-status over the (possibly stale)
      // specialist text, and carry the contradiction flag through.
      const liveText = st.text || (match && match.text);
      // Completeness: expected £ impact, success metric (watch metric → target), and a
      // by-when horizon derived from priority — so every action is executable.
      const watchM = Array.isArray(st.watch) && st.watch.length ? st.watch[0] : null;
      const successMetric = watchM ? (watchM.replace(/_/g,' ') + (st.target!=null ? ` → ${st.target}` : '')) : null;
      const byWhen = {P1:'this week', P2:'next 2 weeks', P3:'this month'}[(match&&match.p)||st.priority] || null;
      return {id, ...ph, ...(match || {}), ...(liveText?{text:liveText}:{}), status: st.status || 'unknown',
              gbp: mon.monthly_impact_gbp || null, kind: mon.kind || null, basis: mon.basis || null,
              successMetric, byWhen, owner: (match&&match.agent)||st.agent||null,
              premiseStale: !!st.premiseStale, reconcileNote: st.reconcileNote || null};
    });
    // Stale-premise actions (the live metric no longer supports them) sink to the bottom.
    return all.filter(a => a.status !== 'verified-done' && a.status !== 'done')
              .sort((a,b) => (a.premiseStale?1:0) - (b.premiseStale?1:0) || (b.phit || 0) - (a.phit || 0));
  })();

  return (<div style={{display:'flex', flexDirection:'column', gap:'var(--s-7)'}}>

    {/* Track record — closes the loop on acted-on advice */}
    <AdviceLedgerPanel/>

    {/* ZONE 1 — WHAT CHANGED */}
    <section>
      <ZoneHeader
        number="01"
        title="What changed"
        meta={P.diff?.previous_run_at ? `vs run at ${new Date(P.diff.previous_run_at).toLocaleString()}` : 'No prior run to diff against'}
      />
      {P.diff && P.diff.previous_run_at ? (<>
        <div className="stat-strip" style={{marginBottom:'var(--s-4)'}}>
          <div className="stat-strip-item">
            <div className="stat-strip-val" style={{color:'var(--bad)'}}>{P.diff.new.length}</div>
            <div className="stat-strip-label">New</div>
          </div>
          <div className="stat-strip-divider"/>
          <div className="stat-strip-item">
            <div className="stat-strip-val" style={{color:'var(--warn)'}}>{P.diff.stronger.length}</div>
            <div className="stat-strip-label">Stronger</div>
          </div>
          <div className="stat-strip-divider"/>
          <div className="stat-strip-item">
            <div className="stat-strip-val" style={{color:'var(--good)'}}>{P.diff.resolved.length}</div>
            <div className="stat-strip-label">Resolved</div>
          </div>
          <div className="stat-strip-divider"/>
          <div className="stat-strip-item">
            <div className="stat-strip-val" style={{color:'var(--text-muted)'}}>{P.diff.weaker.length}</div>
            <div className="stat-strip-label">Weaker</div>
          </div>
          <div style={{flex:1}}/>
          <div className="meta" style={{fontSize:11}}>{P.diff.previous_run_size} → {topLevelPatterns.length} patterns active</div>
        </div>
        {[['new','New findings','var(--bad)'],['stronger','Strengthened','var(--warn)'],['resolved','Resolved','var(--good)'],['weaker','Weakened','var(--text-muted)']].map(([key, label, color]) => {
          const list = P.diff[key] || [];
          if (!list.length) return null;
          return (<div key={key} style={{marginBottom:'var(--s-3)'}}>
            <div className="micro" style={{color, marginBottom:'var(--s-2)'}}>{label} ({list.length})</div>
            <Collapsible
              items={list}
              initialCount={4}
              moreLabel={label.toLowerCase()}
              renderItem={(p, i) => (<div key={i} style={{
                padding:'8px 12px', background:'var(--bg-elevated)',
                borderLeft:`2px solid ${color}`, borderRadius:'0 var(--r-sm) var(--r-sm) 0',
                fontSize:12, color:'var(--text-secondary)', lineHeight:1.5,
              }}>
                {p.description}
                {p._effect_delta_pct != null && <span style={{color, fontWeight:600, marginLeft:8}}>({p._effect_delta_pct>0?'+':''}{p._effect_delta_pct}%)</span>}
              </div>)}
            />
          </div>);
        })}
      </>) : (<div className="card"><div className="muted">First engine run — pattern diff will appear next week.</div></div>)}
    </section>

    {/* ZONE 2 — WHY (the diagnostic layer) */}
    <section>
      <ZoneHeader
        number="02"
        title="Why it's happening"
        meta={`${topLevelPatterns.length} patterns · ${diagnosisCount} auto-diagnoses`}
      />
      <div className="toolbar">
        <label>Kind</label>
        <select value={kindFilter} onChange={e=>setKindFilter(e.target.value)}>
          <option value="all">All</option>
          {Object.keys(kindCounts).map(k => <option key={k} value={k}>{KIND_LABEL[k] || k}</option>)}
        </select>
        <div className="divider"/>
        <label>Verdict</label>
        <select value={verdictFilter} onChange={e=>setVerdictFilter(e.target.value)}>
          <option value="all">All</option>
          <option value="unfavourable">Unfavourable</option>
          <option value="favourable">Favourable</option>
          <option value="neutral">Neutral</option>
        </select>
        <div className="divider"/>
        <label>Sort</label>
        <select value={sortBy} onChange={e=>setSortBy(e.target.value)}>
          <option value="effect">Effect size</option>
          <option value="confidence">Confidence</option>
          <option value="recent">Most recent</option>
        </select>
        <span className="toolbar-count">{filtered.length} of {topLevelPatterns.length}</span>
      </div>
      <Collapsible
        items={filtered}
        initialCount={8}
        moreLabel="patterns"
        renderItem={renderPattern}
      />
    </section>

    {/* ZONE 3 — WHAT TO DO (money + actions) */}
    <section>
      <ZoneHeader
        number="03"
        title="What to do"
        meta={`${phitRows.length} open actions · £${((P.money_rollup?.total || 0)/1000).toFixed(1)}k/mo at stake`}
      />
      <MoneyOnTablePanel/>
      {phitRows.length > 0 && (<div style={{marginTop:'var(--s-4)'}}>
        <div className="card-section-title">
          <h2 style={{margin:0}}>Open actions, ranked by P(hit)</h2>
          <span className="meta">Bayesian estimate per agent + category, with sample size badges</span>
        </div>
        <Collapsible
          items={phitRows}
          initialCount={6}
          moreLabel="open actions"
          renderItem={(a, i) => { const kc = a.kind==='opportunity'?'var(--good)':a.kind==='at_risk'?'var(--warn)':'var(--bad)'; return (<div key={i} style={{
            display:'flex', alignItems:'flex-start', gap:'var(--s-3)',
            padding:'var(--s-3) var(--s-4)', background:'var(--bg-elevated)',
            border:'1px solid var(--border-subtle)', borderRadius:'var(--r-md)',
          }}>
            <div style={{flexShrink:0, marginTop:2}}><PHitBadge phit={a}/></div>
            <span className={'pill '+(a.p === 'P1' ? 'red' : a.p === 'P2' ? 'amber' : 'grey')} style={{fontSize:10, flexShrink:0, marginTop:2}}>{a.p}</span>
            <div style={{flex:1, minWidth:0}}>
              <div style={{display:'flex', alignItems:'baseline', gap:8, flexWrap:'wrap'}}>
                <span style={{fontSize:12.5, color: a.premiseStale?'var(--text-muted)':'var(--text-primary)', lineHeight:1.4, textDecoration:a.premiseStale?'line-through':'none'}}>{a.text || a.id}</span>
                {a.premiseStale && <span className="pill grey" title={a.reconcileNote||''} style={{fontSize:9.5}}>⚠ premise out of date</span>}
              </div>
              <div style={{display:'flex', flexWrap:'wrap', gap:12, marginTop:5, fontSize:10.5, color:'var(--text-faint)', alignItems:'baseline'}}>
                <span title="Owner">{a.owner || '—'}</span>
                {a.gbp ? <span style={{color:kc, fontWeight:600}} title="Expected monthly impact">~£{Math.round(Math.abs(a.gbp)).toLocaleString()}/mo</span> : null}
                {a.successMetric && <span title="Success metric">✓ {a.successMetric}</span>}
                {a.byWhen && <span title="Review by">⏱ {a.byWhen}</span>}
                <span title="P(hit) confidence · sample size">{a.confidence} (n={a.sample_size})</span>
              </div>
            </div>
          </div>); }}
        />
      </div>)}
    </section>

    {/* Advanced detail — collapsible by default, for reference */}
    <section>
      <button className="show-more" onClick={()=>setShowAdvanced(!showAdvanced)}>
        {showAdvanced ? '↑ Hide advanced' : '↓ Advanced: synergy matrix · agent scorecard · attribution ledger'}
      </button>
      {showAdvanced && (<div style={{display:'flex', flexDirection:'column', gap:'var(--s-4)', marginTop:'var(--s-4)'}}>
        <SynergyMatrix/>
        {(P.scorecard || []).length > 0 && (<div className="card">
          <div className="card-section-title">
            <h2 style={{margin:0}}>Agent scorecard</h2>
            <span className="meta">3-7 closed = medium confidence · 8+ = high</span>
          </div>
          <table><thead><tr><th>Agent</th><th>Category</th><th>Closed</th><th>Hits</th><th>Misses</th><th>Inconc.</th><th>Hit rate</th><th>Avg lift</th><th>Confidence</th></tr></thead><tbody>
          {P.scorecard.map((s, i) => {
            const conf = s.total_closed >= 8 ? 'high' : s.total_closed >= 3 ? 'medium' : 'low';
            const confColor = conf === 'high' ? 'var(--good)' : conf === 'medium' ? 'var(--warn)' : 'var(--text-muted)';
            const isRollup = s.category === 'ALL';
            return (<tr key={i} style={{background: isRollup ? 'rgba(255,255,255,0.02)' : undefined, fontWeight: isRollup ? 600 : 400}}>
              <td><b>{s.agent}</b>{agentRole(s.agent) && <div className="meta" style={{fontSize:10}}>{agentRole(s.agent)}</div>}</td>
              <td>{isRollup ? <span style={{color:'var(--text-muted)'}}>— all —</span> : s.category}</td>
              <td>{s.total_closed}</td>
              <td style={{color:'var(--good)'}}>{s.hits}</td>
              <td style={{color:'var(--bad)'}}>{s.misses}</td>
              <td className="muted">{s.inconclusive}</td>
              <td>{s.hit_rate != null ? <b>{(s.hit_rate * 100).toFixed(0)}%</b> : '—'}</td>
              <td>{s.avg_attributed_lift != null ? s.avg_attributed_lift.toFixed(3) : '—'}</td>
              <td><span style={{fontSize:10, padding:'2px 6px', borderRadius:4, color:confColor, fontWeight:600, textTransform:'uppercase'}}>{conf} (n={s.total_closed})</span></td>
            </tr>);
          })}
          </tbody></table>
        </div>)}
        {attribActions.length > 0 && (<div className="card">
          <div className="card-section-title">
            <h2 style={{margin:0}}>Attribution ledger</h2>
            <span className="meta">{hits} hits · {misses} misses · {openCount} open</span>
          </div>
          <table><thead><tr><th>Agent</th><th className="tl">Action</th><th>Status</th><th>Baseline → Observed</th><th>Counterfactual Δ</th><th>Attributed lift</th><th>Verdict</th></tr></thead><tbody>
          {attribActions.map((a, i) => {
            const m = metrics[a.predicted_metric_id] || {};
            const fmt = (v) => v == null ? '—' : (m.unit==='pct' ? (v*100).toFixed(1)+'%' : m.unit==='gbp' ? '£'+Math.round(v).toLocaleString() : m.unit==='ratio' ? v.toFixed(2)+'×' : v.toFixed(3));
            const lift = a.attributed_lift;
            const goodLift = m.direction==='higher_better' ? lift>0 : m.direction==='lower_better' ? lift<0 : null;
            const liftColor = goodLift==null ? 'var(--text-muted)' : goodLift ? 'var(--good)' : 'var(--bad)';
            return (<tr key={i}>
              <td title={agentTitle(a.agent)}><b>{a.agent}</b><br/><span className="meta" style={{fontSize:10}}>{agentRole(a.agent)||a.category} · {a.priority}</span></td>
              <td style={{fontSize:12, maxWidth:280}}>{a.description}</td>
              <td><span className="pill grey" style={{fontSize:10}}>{a.status}</span></td>
              <td>{fmt(a.baseline_value)} → {fmt(a.observed_value)}</td>
              <td>{fmt(a.counterfactual_delta)}</td>
              <td><b style={{color:liftColor}}>{fmt(lift)}</b>{a.significance_z!=null && <span className="meta" style={{fontSize:10, marginLeft:4}}>z={a.significance_z.toFixed(2)}</span>}</td>
              <td>{a.verdict ? <span className="pill" style={{background:VERDICT_COLOR[a.verdict]+'22', color:VERDICT_COLOR[a.verdict], fontSize:10}}>{a.verdict}</span> : <span className="meta">open</span>}</td>
            </tr>);
          })}
          </tbody></table>
        </div>)}
      </div>)}
    </section>
  </div>);
}

function ForecastPanel(){
  // Edge Fix 7 — intentionally refuses to forecast without operator inputs.
  // The whole point: most analytics tools confidently extrapolate from
  // contaminated baselines. We require: per-channel spend plan, expected ROAS,
  // event days that should be excluded/included. If user gives nothing back,
  // the panel shows the refusal and explains why.
  const [horizon, setHorizon] = useState(30);
  const [metaSpend, setMetaSpend] = useState('');
  const [googleSpend, setGoogleSpend] = useState('');
  const [metaRoas, setMetaRoas] = useState('');
  const [googleRoas, setGoogleRoas] = useState('');
  const [emailUplift, setEmailUplift] = useState('');
  const [eventDays, setEventDays] = useState('');
  const [organicAssumption, setOrganicAssumption] = useState('flat');
  const [submitted, setSubmitted] = useState(false);

  // Pull historical baselines for context — these are what the operator inputs
  // are graded against. We never fill the input from these — that would defeat
  // the point. We display them as a reference table only.
  const B = window.FRKL_BUSINESS_DATA || {};
  const D = window.FRKL_DATA || {};
  const historicalMetaSpend30d = (() => {
    try {
      const rows = (D.channels && D.channels.meta && D.channels.meta.daily) || [];
      const last30 = rows.slice(-30);
      const total = last30.reduce((a, r) => a + (r.spend || 0), 0);
      return total ? Math.round(total / Math.max(1, last30.length)) : null;
    } catch (e) { return null; }
  })();
  const historicalGoogleSpend30d = (() => {
    try {
      const rows = (D.channels && D.channels.google && D.channels.google.daily) || [];
      const last30 = rows.slice(-30);
      const total = last30.reduce((a, r) => a + (r.spend || 0), 0);
      return total ? Math.round(total / Math.max(1, last30.length)) : null;
    } catch (e) { return null; }
  })();
  const historicalMetaRoas = (() => {
    try {
      const rows = (D.channels && D.channels.meta && D.channels.meta.daily) || [];
      const last30 = rows.slice(-30);
      const totalSpend = last30.reduce((a, r) => a + (r.spend || 0), 0);
      const totalValue = last30.reduce((a, r) => a + (r.value || 0), 0);
      return totalSpend ? (totalValue / totalSpend) : null;
    } catch (e) { return null; }
  })();
  const historicalGoogleRoas = (() => {
    try {
      const rows = (D.channels && D.channels.google && D.channels.google.daily) || [];
      const last30 = rows.slice(-30);
      const totalSpend = last30.reduce((a, r) => a + (r.spend || 0), 0);
      const totalValue = last30.reduce((a, r) => a + (r.value || 0), 0);
      return totalSpend ? (totalValue / totalSpend) : null;
    } catch (e) { return null; }
  })();

  const inputs = {
    metaSpend: parseFloat(metaSpend),
    googleSpend: parseFloat(googleSpend),
    metaRoas: parseFloat(metaRoas),
    googleRoas: parseFloat(googleRoas),
    emailUplift: parseFloat(emailUplift) || 0,
  };
  const allRequiredFilled = !isNaN(inputs.metaSpend) && !isNaN(inputs.googleSpend) && !isNaN(inputs.metaRoas) && !isNaN(inputs.googleRoas);
  const calc = allRequiredFilled ? {
    metaRevenue: inputs.metaSpend * inputs.metaRoas * horizon,
    googleRevenue: inputs.googleSpend * inputs.googleRoas * horizon,
    emailRevenue: inputs.emailUplift * horizon,
  } : null;
  if (calc) calc.total = calc.metaRevenue + calc.googleRevenue + calc.emailRevenue;

  // Quick-start scenario: pre-fill the form using historical values × a multiplier.
  // Explicit user action — they're opting into the assumption — so it still
  // satisfies the "we won't extrapolate without operator input" principle.
  const applyScenario = (label) => {
    const mult = label === 'worst' ? 0.8 : label === 'best' ? 1.2 : 1.0;
    setMetaSpend(historicalMetaSpend30d ? Math.round(historicalMetaSpend30d).toString() : '');
    setGoogleSpend(historicalGoogleSpend30d ? Math.round(historicalGoogleSpend30d).toString() : '');
    setMetaRoas(historicalMetaRoas ? (historicalMetaRoas * mult).toFixed(2) : '');
    setGoogleRoas(historicalGoogleRoas ? (historicalGoogleRoas * mult).toFixed(2) : '');
  };

  return (<div style={{display:'flex', flexDirection:'column', gap:'var(--s-5)'}}>
    {/* Header — quieter, explains the principle once */}
    <div>
      <div className="card-section-title">
        <h2 style={{margin:0}}>Forecast</h2>
        <span className="meta">Operator-input-driven · no baseline extrapolation</span>
      </div>
      <div className="meta" style={{lineHeight:1.6}}>
        Most analytics tools extrapolate forward from the last 30 days as if the next 30 will look the same. They won't. Enter your planning assumptions below, or pick a scenario to pre-fill the form.
      </div>
    </div>

    {/* Guided empty state — only when nothing submitted yet */}
    {!submitted && (<div className="forecast-empty">
      <div className="forecast-empty-icon">∅</div>
      <div className="forecast-empty-title">Pick a scenario to start</div>
      <div className="forecast-empty-body">
        Each scenario pre-fills the form with your historical baseline × a multiplier. You can then tune any value before computing. This is the platform's "what-if" mode — it never assumes the future will look like the past without you saying so.
      </div>
      <div className="forecast-empty-cta">
        <button className="btn-ghost" onClick={()=>applyScenario('worst')}>Worst case (×0.8)</button>
        <button className="btn-primary" onClick={()=>applyScenario('central')}>Current rate (×1.0)</button>
        <button className="btn-ghost" onClick={()=>applyScenario('best')}>Best case (×1.2)</button>
      </div>
      <div className="meta" style={{marginTop:'var(--s-5)', fontSize:11}}>
        Historical reference (last 30 days):
        Meta <b style={{color:'var(--text-secondary)'}}>£{historicalMetaSpend30d ?? '—'}/day</b> @ <b style={{color:'var(--text-secondary)'}}>{historicalMetaRoas != null ? historicalMetaRoas.toFixed(2) + '×' : '—'}</b> ·
        Google <b style={{color:'var(--text-secondary)'}}>£{historicalGoogleSpend30d ?? '—'}/day</b> @ <b style={{color:'var(--text-secondary)'}}>{historicalGoogleRoas != null ? historicalGoogleRoas.toFixed(2) + '×' : '—'}</b>
      </div>
    </div>)}

    {/* Input form */}
    <div className="card">
      <div className="card-section-title">
        <h2 style={{margin:0}}>Planning inputs</h2>
        <span className="meta">
          Reference: Meta £{historicalMetaSpend30d ?? '—'}/d @ {historicalMetaRoas != null ? historicalMetaRoas.toFixed(2) + '×' : '—'} · Google £{historicalGoogleSpend30d ?? '—'}/d @ {historicalGoogleRoas != null ? historicalGoogleRoas.toFixed(2) + '×' : '—'}
        </span>
      </div>
      <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(220px, 1fr))', gap:'var(--s-3)'}}>
        <FInput label="Horizon (days)" type="select" value={horizon} setValue={v=>setHorizon(parseInt(v))} options={[7,14,30,60,90]} optionLabels={d=>`${d} days`}/>
        <FInput label="Meta spend/day (£)" required value={metaSpend} setValue={setMetaSpend} placeholder="e.g. 120"/>
        <FInput label="Meta target ROAS"   required value={metaRoas} setValue={setMetaRoas} placeholder="e.g. 2.5" step="0.1"/>
        <FInput label="Google spend/day (£)" required value={googleSpend} setValue={setGoogleSpend} placeholder="e.g. 50"/>
        <FInput label="Google target ROAS"   required value={googleRoas} setValue={setGoogleRoas} placeholder="e.g. 3.0" step="0.1"/>
        <FInput label="Daily email revenue (£)" optional value={emailUplift} setValue={setEmailUplift} placeholder="e.g. 250"/>
        <FInput label="Seasonal events in window" type="text" value={eventDays} setValue={setEventDays} placeholder="e.g. Father's Day, BFCM"/>
        <FInput label="Organic assumption" type="select" value={organicAssumption} setValue={setOrganicAssumption}
          options={['flat','grow','decline','exclude']}
          optionLabels={v => ({flat:'Flat vs last 30d', grow:'+10% (organic acceleration)', decline:'-10% (organic decline)', exclude:'Exclude entirely'}[v])}/>
      </div>
      <div style={{marginTop:'var(--s-4)', display:'flex', alignItems:'center', gap:'var(--s-3)'}}>
        <button className="btn-primary" onClick={()=>setSubmitted(true)}>Compute forecast</button>
        <span className="meta" style={{fontSize:11}}>Required fields are marked. Empty required = no forecast.</span>
      </div>
    </div>

    {/* Refusal panel */}
    {submitted && !allRequiredFilled && (<div className="card alert-bad">
      <div className="card-section-title">
        <h2 style={{margin:0, color:'var(--bad)'}}>Refusing to forecast — required inputs missing</h2>
      </div>
      <div style={{fontSize:13, lineHeight:1.6, color:'var(--text-secondary)'}}>
        At least one of Meta spend, Meta ROAS, Google spend, or Google ROAS is empty or non-numeric. Extrapolating the missing channel would just re-project the last 30 days, which:
        <ul style={{marginTop:'var(--s-2)', paddingLeft:'var(--s-5)'}}>
          <li>contains discount-rate contamination (Draft Orders channel)</li>
          <li>contains creative fatigue not yet corrected</li>
          <li>doesn't reflect your stated plans for next month</li>
        </ul>
      </div>
    </div>)}

    {/* Forecast results */}
    {submitted && calc && (<div className="card alert-good">
      <div className="card-section-title">
        <h2 style={{margin:0}}>Forecast — next {horizon} days</h2>
        <span className="meta">spend × ROAS × horizon · no baseline extrapolation</span>
      </div>
      <table>
        <thead><tr><th>Channel</th><th className="tl">Inputs</th><th>Forecast revenue</th></tr></thead>
        <tbody>
          <tr><td><b>Meta</b></td><td className="meta tl" style={{fontSize:11}}>£{inputs.metaSpend}/day × {inputs.metaRoas}× × {horizon}d</td><td><b>£{Math.round(calc.metaRevenue).toLocaleString()}</b></td></tr>
          <tr><td><b>Google</b></td><td className="meta tl" style={{fontSize:11}}>£{inputs.googleSpend}/day × {inputs.googleRoas}× × {horizon}d</td><td><b>£{Math.round(calc.googleRevenue).toLocaleString()}</b></td></tr>
          {calc.emailRevenue > 0 && <tr><td><b>Email</b></td><td className="meta tl" style={{fontSize:11}}>£{inputs.emailUplift}/day × {horizon}d (no extrapolation)</td><td><b>£{Math.round(calc.emailRevenue).toLocaleString()}</b></td></tr>}
          <tr style={{background:'var(--bg-card-hover)', fontWeight:600}}><td>Total (paid + supplied email)</td><td></td><td><b style={{color:'var(--good)'}}>£{Math.round(calc.total).toLocaleString()}</b></td></tr>
        </tbody>
      </table>
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'var(--s-3)', marginTop:'var(--s-4)'}}>
        <div style={{padding:'var(--s-3)', background:'var(--bg-elevated)', borderLeft:'2px solid var(--warn)', borderRadius:'0 var(--r-sm) var(--r-sm) 0'}}>
          <div className="micro" style={{color:'var(--warn)', marginBottom:'var(--s-2)'}}>NOT included</div>
          <ul style={{fontSize:12, color:'var(--text-secondary)', lineHeight:1.6, paddingLeft:'var(--s-4)', margin:0}}>
            <li>Organic / direct traffic (you marked "{organicAssumption}")</li>
            <li>Affiliate revenue (held separately)</li>
            <li>Wholesale orders (DTC scope by design)</li>
            <li>BFCM amplification (state in input ROAS)</li>
            <li>Creative-fatigue degradation mid-period</li>
          </ul>
        </div>
        <div style={{padding:'var(--s-3)', background:'var(--bg-elevated)', borderLeft:'2px solid var(--accent)', borderRadius:'0 var(--r-sm) var(--r-sm) 0'}}>
          <div className="micro" style={{color:'var(--accent)', marginBottom:'var(--s-2)'}}>Stress-test this</div>
          <div style={{fontSize:12, color:'var(--text-secondary)', lineHeight:1.6}}>
            Re-run with ROAS at your <b>worst</b> 30-day rate, then your <b>best</b>. The gap between those two forecasts is the planning range — not the central case. Use the scenario buttons at the top to swap quickly.
          </div>
        </div>
      </div>
    </div>)}
  </div>);
}

// Small input wrapper used by ForecastPanel — keeps the form code dense without losing semantics
function FInput({label, required, optional, value, setValue, placeholder, type, step, options, optionLabels}) {
  const isSelect = type === 'select';
  const isText = type === 'text';
  const inputType = isText ? 'text' : (isSelect ? null : 'number');
  return (<div>
    <label className="micro" style={{display:'block', marginBottom:4, fontSize:10, color:'var(--text-muted)'}}>
      {label} {required && <span style={{color:'var(--bad)'}}>*</span>} {optional && <span className="meta" style={{textTransform:'none', letterSpacing:0, fontWeight:400}}>(optional)</span>}
    </label>
    {isSelect ? (
      <select value={value} onChange={e=>setValue(e.target.value)} style={{width:'100%', background:'var(--bg-input)', color:'var(--text-primary)', border:'1px solid var(--border-default)', borderRadius:'var(--r-sm)', padding:'8px 10px', fontSize:13, fontFamily:'inherit'}}>
        {options.map(opt => <option key={opt} value={opt}>{optionLabels ? optionLabels(opt) : opt}</option>)}
      </select>
    ) : (
      <input value={value} onChange={e=>setValue(e.target.value)} placeholder={placeholder} type={inputType} step={step}
             style={{width:'100%', background:'var(--bg-input)', color:'var(--text-primary)', border:'1px solid var(--border-default)', borderRadius:'var(--r-sm)', padding:'8px 10px', fontSize:13, fontFamily:'inherit'}}/>
    )}
  </div>);
}

function SynergyMatrix(){
  const P = window.FRKL_PATTERNS;
  if (!P || !Array.isArray(P.patterns)) return null;
  const synergies = P.patterns.filter(p => p.kind === 'synergy');
  if (!synergies.length) return null;
  // Group by (src, tgt) pair so each cell shows the best correlation across lags
  const CHANNEL_COLORS = {meta:'#4267B2', google:'#fbbc05', site:'#4ade80', email:'#c084fc', shopify:'#f87171'};
  // Build list of all metrics that appear in any synergy
  const metricsSet = new Set();
  synergies.forEach(s => {
    metricsSet.add(s.metadata?.source_metric);
    metricsSet.add(s.metadata?.target_metric);
  });
  // Channel order: meta, google, email, site, shopify
  const CHANNEL_ORDER = ['meta','google','email','site','shopify'];
  const METRIC_CHANNEL = {
    meta_spend_daily:'meta', meta_purchases_daily:'meta', meta_value_daily:'meta',
    google_spend_daily:'google', google_clicks_daily:'google', google_conv_daily:'google', google_value_daily:'google',
    ga4_sessions_daily:'site', ga4_purchases_daily:'site', ga4_revenue_daily:'site',
    email_sends_daily:'email', email_opens_daily:'email', email_clicks_daily:'email',
    shopify_orders_daily:'shopify', shopify_revenue_daily:'shopify',
  };
  const SHORT_LABEL = {
    meta_spend_daily:'Spend', meta_purchases_daily:'Purchases', meta_value_daily:'Rev',
    google_spend_daily:'Spend', google_clicks_daily:'Clicks', google_conv_daily:'Conv', google_value_daily:'Rev',
    ga4_sessions_daily:'Sessions', ga4_purchases_daily:'Purchases', ga4_revenue_daily:'Rev',
    email_sends_daily:'Sends', email_opens_daily:'Opens', email_clicks_daily:'Clicks',
    shopify_orders_daily:'Orders', shopify_revenue_daily:'Rev',
  };
  const metrics = [...metricsSet].filter(m => METRIC_CHANNEL[m]).sort((a,b) => {
    const ca = CHANNEL_ORDER.indexOf(METRIC_CHANNEL[a]);
    const cb = CHANNEL_ORDER.indexOf(METRIC_CHANNEL[b]);
    return ca - cb || a.localeCompare(b);
  });
  // Build pair → best r at any lag (signed)
  const pairR = {};
  const pairLag = {};
  const pairFull = {};      // {pair: {0:r, 1:r, 2:r, ...}}
  synergies.forEach(s => {
    const src = s.metadata?.source_metric, tgt = s.metadata?.target_metric;
    if (!src || !tgt) return;
    const key = src + '→' + tgt;
    pairR[key] = s.metadata.r;
    pairLag[key] = s.metadata.lag_days;
    pairFull[key] = {};
    Object.entries(s.metadata?.r_at_lag || {}).forEach(([L,v]) => { pairFull[key][L] = v.r; });
  });
  const rgb = (r) => {
    // Diverging colour: green for positive, red for negative, intensity by |r|
    const abs = Math.abs(r);
    if (r >= 0) return `rgba(74,222,128,${0.15 + abs * 0.6})`;
    return `rgba(248,113,113,${0.15 + abs * 0.6})`;
  };
  // Top 8 cross-channel synergies as a separate "leaderboard" with full lag profile
  const topPairs = [...new Set(synergies.map(s => {
    const src = s.metadata?.source_metric, tgt = s.metadata?.target_metric;
    return src && tgt ? [src,tgt].sort().join('|') : null;
  }).filter(Boolean))]
    .map(pair => {
      const [a,b] = pair.split('|');
      const k1 = a+'→'+b, k2 = b+'→'+a;
      const r1 = pairR[k1] || 0, r2 = pairR[k2] || 0;
      const r = Math.abs(r1) > Math.abs(r2) ? r1 : r2;
      const winner = Math.abs(r1) > Math.abs(r2) ? k1 : k2;
      const lag = pairLag[winner] || 0;
      return {pair, src: a, tgt: b, r, lag, full: pairFull[winner] || {}};
    })
    .sort((a,b) => Math.abs(b.r) - Math.abs(a.r))
    .slice(0, 10);

  return (<div className="card" style={{marginBottom:14, borderLeft:'3px solid #38bdf8'}}>
    <h2>Channel synergy matrix</h2>
    <div className="muted" style={{marginBottom:10, fontSize:12}}>
      Pearson correlation between daily series across 5 channels (Meta · Google · Email · Site · Shopify). Each cell = correlation between row (today) and column (today + best lag). Green = positive, red = negative. Same-channel pairs are blank (internal identities). Synergies persist to <code>patterns_brand</code> as kind="synergy".
    </div>
    {/* Matrix */}
    <div style={{overflowX:'auto', marginBottom:14}}>
      <table style={{borderCollapse:'separate', borderSpacing:0, fontSize:10}}>
        <thead>
          <tr><th></th>{metrics.map(m => {
            const ch = METRIC_CHANNEL[m];
            return (<th key={m} style={{padding:'4px 6px', writingMode:'vertical-rl', textOrientation:'mixed', color:CHANNEL_COLORS[ch], fontWeight:600, fontSize:10, height:90, verticalAlign:'bottom'}}>{SHORT_LABEL[m]||m}<br/><span style={{color:'#7b7b87',fontSize:9,textTransform:'uppercase'}}>{ch}</span></th>);
          })}</tr>
        </thead>
        <tbody>
          {metrics.map(src => {
            const srcCh = METRIC_CHANNEL[src];
            return (<tr key={src}>
              <td style={{padding:'2px 8px', color:CHANNEL_COLORS[srcCh], fontWeight:600, fontSize:11, whiteSpace:'nowrap'}}>
                <span style={{color:'#7b7b87',fontSize:9,textTransform:'uppercase',marginRight:6}}>{srcCh}</span>{SHORT_LABEL[src]||src}
              </td>
              {metrics.map(tgt => {
                if (METRIC_CHANNEL[src] === METRIC_CHANNEL[tgt]) {
                  return (<td key={tgt} style={{width:38, height:24, background:'#1a1a22'}}></td>);
                }
                const k = src+'→'+tgt;
                const r = pairR[k];
                const lag = pairLag[k];
                if (r == null) return (<td key={tgt} style={{width:38, height:24, background:'var(--bg-app)', textAlign:'center', color:'#3a3a44', fontSize:10}}>·</td>);
                return (<td key={tgt} title={`${SHORT_LABEL[src]} → ${SHORT_LABEL[tgt]}: r=${r.toFixed(2)} at lag ${lag}d`}
                  style={{width:38, height:24, background:rgb(r), textAlign:'center', fontWeight:600, color:Math.abs(r)>0.7?'#0a0a0e':'#e8e8ec', fontSize:10}}>
                  {r.toFixed(2)}{lag > 0 ? <sup style={{fontSize:8,marginLeft:1}}>+{lag}d</sup> : ''}
                </td>);
              })}
            </tr>);
          })}
        </tbody>
      </table>
    </div>
    {/* Top synergies leaderboard */}
    <h3 style={{margin:'14px 0 8px', fontSize:13}}>Top 10 cross-channel synergies (full lag profile)</h3>
    <table><thead><tr><th>Source → Target</th><th>Best r</th><th>Best lag</th><th>r@0d</th><th>r@1d</th><th>r@2d</th><th>r@3d</th><th>r@7d</th></tr></thead><tbody>
    {topPairs.map((p,i)=>{
      const srcCh = METRIC_CHANNEL[p.src], tgtCh = METRIC_CHANNEL[p.tgt];
      return (<tr key={i}>
        <td style={{fontSize:11.5}}>
          <span style={{color:CHANNEL_COLORS[srcCh], fontWeight:600}}>{SHORT_LABEL[p.src]||p.src}</span>
          <span className="muted" style={{margin:'0 6px'}}>→</span>
          <span style={{color:CHANNEL_COLORS[tgtCh], fontWeight:600}}>{SHORT_LABEL[p.tgt]||p.tgt}</span>
          <div className="muted" style={{fontSize:10}}>{srcCh} → {tgtCh}</div>
        </td>
        <td><b style={{color:p.r>0?'#4ade80':'#f87171'}}>{p.r.toFixed(2)}</b></td>
        <td>{p.lag === 0 ? <span className="muted">same day</span> : <b>+{p.lag}d</b>}</td>
        {['0','1','2','3','7'].map(L => {
          const r = p.full[L];
          if (r == null) return (<td key={L} className="muted">—</td>);
          return (<td key={L} style={{background: rgb(r), color:Math.abs(r)>0.7?'#0a0a0e':'#e8e8ec', textAlign:'center', fontSize:11, fontWeight:600}}>{r.toFixed(2)}</td>);
        })}
      </tr>);
    })}
    </tbody></table>
    <div className="note" style={{marginTop:14}}><b>How to read this:</b> r=1.0 means perfect positive correlation, r=0 means none, r=-1.0 perfect inverse. The <b>"+Nd"</b> superscript means the target metric peaks N days <i>after</i> the source — a leading indicator. {topPairs.filter(p=>p.lag>0).length === 0 ? <span><b>Notable: every cross-channel pair's strongest correlation is at lag 0 (same day).</b> frkl's channels move in lockstep — there's no measurable "Channel X today predicts Channel Y in N days" structure. Likely cause: all channels respond to the same external drivers (campaign launches, news cycles, weather, day-of-week). To detect true lead-lag would need either intraday granularity, or longer history with more isolated channel pushes.</span> : <span>Look for lag &gt; 0 patterns — those are leading indicators worth treating as early-warning signals.</span>}</div>
  </div>);
}

// ===== Ask: dataset Q&A via Claude API (browser-side) =====
function buildAskContext(){
  // Compact, structured summary of all data the model is allowed to reason over.
  // Aims to stay well under 100k tokens so prompt caching covers most of the cost.
  const D = window.FRKL_DATA || {}, B = window.FRKL_BUSINESS || {};
  const tail = (a, n=14) => Array.isArray(a) ? a.slice(-n) : a;
  // Data-quality guardrail — the same partial-window / small-sample protection the
  // automated reads get, computed client-side so the interactive analyst can't
  // diagnose off a half-finished day or a thin order base for any window the user asks about.
  const _shp = D.shopify || [];
  let _today = ''; try { _today = new Date().toISOString().slice(0,10); } catch(e) {}
  const _dates = _shp.map(r=>r && r.date).filter(Boolean).sort();
  const _latestDate = _dates.length ? _dates[_dates.length-1] : null;
  const _partialLatestDay = !!(_latestDate && _today && _latestDate >= _today);
  let _lastCompleteDate = _latestDate;
  if (_partialLatestDay && _latestDate) { try { const d=new Date(_latestDate+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()-1); _lastCompleteDate=d.toISOString().slice(0,10); } catch(e) {} }
  const _recentDailyOrders = _shp.slice(-10).map(r=>({date:r&&r.date, orders: Math.round(Number(r&&r.orders)||0)}));
  const dataQuality = {
    latestDate: _latestDate, today: _today, partialLatestDay: _partialLatestDay,
    lastCompleteDate: _lastCompleteDate, recentDailyOrders: _recentDailyOrders, smallSampleOrders: 60,
    note: 'GUARDRAIL (must reflect in confidence + caveats): when answering about a recent window, treat the latest date as a PARTIAL/incomplete day if partialLatestDay is true — never read a partial-window dip as a real decline; compare complete days only (≤ lastCompleteDate) or say the period is still in progress. If the window in question has under ~60 orders (see recentDailyOrders), treat CVR/AOV swings as possible sampling noise and lower confidence accordingly.',
  };
  const ctx = {
    _meta: { brand: OI_BRAND.slug, currency:'GBP', captured:D.meta?.captured, range:D.meta?.range,
      data_dictionary: {
        metaDaily: 'Meta paid daily: {date,cost,impressions,linkCtr,purchases,purchaseValue}',
        googleAds: 'Google paid daily: {date,cost,clicks,impressions,conversions,convValue}',
        ga4: 'GA4 daily: {date,sessions,engagedSessions,engagementRate,addToCarts,checkouts,purchases,revenue,bounceRate}',
        klaviyo: 'Klaviyo daily: {date,recipients,opens,clicks,openRate,clickRate,orders,orderValue} — orders/value are GROSS Shopify orders Klaviyo tracks, NOT email-attributed',
        shopify: 'Shopify daily: {date,totalSales,netSales,orders,aov,discounts,returns}',
        creatives: 'Meta ad-level last 30d: {name,format,market,concept,cost,impressions,frequency,videoCurve,qualConv,linkCtr,atc,purchases,purchaseValue,thumbnail}',
        demoAgeGender: 'Meta ad x age x gender last 30d: {name,age,gender,cost,impressions,linkCtr,atc,purchases,purchaseValue}',
        demoPlacement: 'Meta ad x placement last 30d: {name,platform,position,device,cost,impressions,linkCtr,atc,purchases,purchaseValue}',
        channelMix: 'GA4 channel grouping 90d: {channel,sessions,engaged,purchases,revenue}',
        retentionByMonth: 'Monthly returning customer split: {month,new,ret,newRev,retRev,total,returningShare}',
        products: 'Top 40 SKUs 90d: {title,sku,units,returns,netSales,grossProfit,marginPct,returnRate}',
        geo: 'Shopify orders by country 90d',
        igPosts60d: 'Top IG posts 60d: {date,type,product,caption,permalink,likes,comments,views,reach,saves,shares,engagement,engRate}',
        igStories: 'IG Stories 60d (frkl barely posts any)',
        emailCampaigns: 'Klaviyo broadcasts 90d: {name,sendDate,subject,recipients,openRate,clickRate,orders,orderValue,revPerRecip}',
        emailFlows: 'Klaviyo flow messages 90d (automated triggers): same shape minus sendDate',
        emailSummary: 'Pre-aggregated flows-vs-campaigns totals (GROSS Klaviyo-tracked — see emailAttribution for TRUE attributed values)',
        emailAttribution: 'TRUE email-attributed orders/revenue using Klaviyo Attributed report types. attributedFlowRevenue_90d + attributedCampaignRevenue_30d are the correct figures for "email channel revenue contribution". Gross values overstate by including non-attributable overlap with other channels.',
        attributedFlows: 'Per-flow attributed performance (90d): flow, orders, orderValue, days active, £/active day',
        igSnapshot: 'IG profile: {followers, mediaCount}',
        igAudience: 'IG follower demographics: {age,gender,followers}',
        contentCadence: 'Per-week posting counts: {week,reels,feed,stories,totalReach,total}',
      },
      important_notes: [
        'Meta claims ~10x more revenue than GA4 attributes; both are real, neither is the whole truth.',
        'Frkl is an Irish/UK demi-fine jewellery brand; 97% of paid spend reaches female users.',
        'Email flows generate 19x more revenue per recipient than campaigns.',
        'Today (latest date) may be a partial day — caveat any "today" answers (see dataQuality).',
      ],
      dataQuality,
    },
    metaDaily: D.metaDaily || [],
    googleAds: D.googleAds || [],
    ga4: D.ga4 || [],
    klaviyo: D.klaviyo || [],
    shopify: D.shopify || [],
    creatives: D.creatives || [],
    demoAgeGender: D.demoAgeGender || [],
    demoPlacement: D.demoPlacement || [],
    channelMix: B.channelMix || [],
    retentionByMonth: B.retentionByMonth || [],
    products: (B.products||[]).slice(0,40),
    geo: B.geo || [],
    igPosts60d: B.igPosts60d || [],
    igStories: B.igStories || [],
    emailCampaigns: B.emailCampaigns || [],
    emailFlows: B.emailFlows || [],
    emailSummary: B.emailSummary || {},
    igSnapshot: B.igSnapshot || {},
    igAudience: B.igAudience || [],
    contentCadence: B.contentCadence || [],
  };
  return ctx;
}

function AskPanel(){
  // Server-side relay (ask-data edge fn). The authenticated workspace injects
  // window.OI_ASK = {endpoint, brand_id, getJwt}. When this dashboard runs inside
  // the /app/ shell it's a same-origin iframe, so we also read window.parent.OI_ASK.
  // The public no-auth demo has none, so Ask runs read-only there. No LLM key in browser.
  const ASK = (typeof window!=='undefined' && (window.OI_ASK || (function(){
    try { return (window.parent && window.parent !== window) ? window.parent.OI_ASK : null; }
    catch(e){ return null; }   // cross-origin parent — leave Ask inert
  })())) || null;
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState(()=>{ try { return JSON.parse(localStorage.getItem('frkl_ask_history')||'[]'); } catch { return []; } });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [model, setModel] = useState(()=>localStorage.getItem('frkl_ask_model')||'claude-sonnet-4-5');
  const [savedTasks, setSavedTasks] = useState({});   // message time → saved-to-board
  const clearHistory = () => { localStorage.removeItem('frkl_ask_history'); setHistory([]); };
  React.useEffect(()=>{ localStorage.setItem('frkl_ask_history', JSON.stringify(history.slice(-30))); }, [history]);
  React.useEffect(()=>{ localStorage.setItem('frkl_ask_model', model); }, [model]);
  // "Ask about this" — a card stashed a question via window.__oiAsk; prefill it here.
  React.useEffect(()=>{
    const consume = () => { try { const q = window.__oiAskPending; if(q){ window.__oiAskPending = null; setQuestion(q); } } catch(e){} };
    consume();
    window.addEventListener('oi-ask-prefill', consume);
    return () => window.removeEventListener('oi-ask-prefill', consume);
  }, []);

  const send = async () => {
    if (!ASK || !question.trim() || loading) return;
    setLoading(true); setError('');
    const q = question.trim();
    const ctx = buildAskContext();
    const ctxJson = JSON.stringify(ctx);
    const systemPrompt = `You are a senior D2C commercial analyst, growth strategist and operator for ${OI_BRAND.name}, a ${OI_BRAND.markets} DTC ${OI_BRAND.vertical} brand. Seasonality to keep in mind: ${OI_BRAND.seasonality}. You are given the brand's live marketing dataset (last ~90 days, captured ${ctx._meta.captured}). Answer using ONLY the data provided. Show the calculation when possible (e.g. "£X / £Y = Z%"). Quote specific numbers and dates. If the question cannot be answered from the data, say so clearly and state what data would be needed.

CORE RULE: never diagnose a performance movement until you have checked for confounding factors. Do not just describe what changed — explain what most likely CAUSED it, the evidence, the caveats, and the next action. A naive read ("revenue up = healthy", "ROAS down = pause ads", "email up = send more", "AOV up = better") is a failure. Your job is to stop the founder making the wrong call because a metric moved without context.

For any "why did X change / what happened / analyse performance" question, work through this before concluding:
1. DECOMPOSE the move and locate the layer — demand generation (spend/sessions/impressions/CTR) → conversion (CVR/ATC/checkout/device) → order economics (AOV/discount/margin/returns) → customer mix (new vs returning/email share) → product mix (hero SKU/stock) → context. Diagnose in that order; don't blame conversion if demand fell, or demand if a bestseller was out of stock.
2. BASELINE — was the comparison period normal, or inflated/depressed by a promo, launch, stockout or quiet week? If the prior period was abnormal, say so and compare to the multi-week / seasonal baseline. A drop after a promo is usually reversion, not weakening demand. Honour _meta.dataQuality: if partialLatestDay is true the latest date is an incomplete day (a partial-window dip is NOT a real decline — compare complete days ≤ lastCompleteDate, or say the period is still in progress); if the window in question has under ~60 orders, treat CVR/AOV swings as possible sampling noise and lower confidence.
3. CONFOUNDER CHECK — could a known event explain it? Promotions/discount codes/free-ship changes, paid-spend changes, creative refresh/fatigue, email sends/flow changes, launches/stockouts/returns spikes, site/checkout/tracking changes, margin/AOV shifts, seasonality/paydays/holidays/competitor promos.
4. LAG — demand pull-forward from last week's promo, 24-72h email spikes that normalise, paid scaling worsening CAC after a lag, stockout disrupting ad-algo learning, a launch spike that shouldn't become the baseline.
5. CAUSE + CONFIDENCE — most likely cause in one line, labelled strongly-supported / likely / possible / weak / unknown. Separate correlation from causation; never assert a cause without evidence.

Edge cases to catch: post-promo drop → check pull-forward; revenue up → check contribution margin + AOV + discount load + new-customer quality; strong email revenue → check discount dependency / over-harvesting; sales down → rule out stockout + spend cut before blaming conversion; sessions stable but sales down → conversion/offer/availability/checkout/device; revenue flat + orders down → AOV masking a demand drop; sudden channel shift → suspect tracking/attribution change; low CAC on a promo → check if those customers repeat or only buy on discount.

OUTPUT: for a simple factual lookup, answer concisely (under ~150 words) with the number + calculation. For a performance-diagnosis question, structure as — A) Executive diagnosis (plain English, the corrected read); B) Metric movement (key numbers + timeframe + WoW/MoM/baseline); C) Confounding factors checked; D) Corrected interpretation (what it means after promos/baseline/stock/seasonality/lag/mix/attribution); E) Recommended actions, ordered by priority; F) Watchouts & data limits; G) Confidence 1-10 + what would raise it.

ADDITIONAL OPERATING RULES:
1. NEVER agree with a stated cause without checking the data. If the user says "X happened because of Y", look for evidence of Y BEFORE accepting it; if absent, push back: "I don't see [Y] in the data. Given the timing, [actual correlated factor] is a more likely explanation. Did you also do Y?"
2. NEVER fabricate forecasts. Without spend plans, seasonality assumptions or a launch calendar, refuse and offer only a clearly-labelled trend extrapolation.
3. NEVER reconcile conflicting goals silently (e.g. "maximise ROAS AND grow new customers aggressively") — call out the tension and ask to prioritise.
4. NEVER report metrics from a seasonal-event window (BFCM, Christmas, Mother's/Valentine's Day, brand sales) as baseline — flag it as anomalous.
5. NEVER quote a precise number when you only have a range — use ranges with stated assumptions.
6. NEVER ignore connection-health context — if a source is stale or missing, caveat any cross-channel answer.

Your value to the operator is being intellectually honest, not being helpful at any cost.

Data dictionary and notes:
${JSON.stringify(ctx._meta, null, 1)}

Full dataset (JSON):
${ctxJson}`;
    const newHistory = [...history, {role:'user', content:q, time:Date.now()}];
    setHistory(newHistory);
    setQuestion('');
    try {
      const apiMessages = newHistory.filter(m=>m.role==='user'||m.role==='assistant').slice(-10).map(m=>({role:m.role, content:m.content}));
      // Resolve a FRESH session token each send (supabase auto-refreshes it), so the
      // per-tenant JWT path never goes stale mid-session. Fall back to a static jwt/token.
      let jwt = '';
      if (typeof ASK.getJwt === 'function') { try { jwt = await ASK.getJwt(); } catch(e){ jwt = ''; } }
      else if (ASK.jwt) { jwt = ASK.jwt; }
      const headers = jwt
        ? { 'content-type': 'application/json', 'authorization': 'Bearer ' + jwt }       // authenticated workspace
        : { 'content-type': 'application/json', 'x-internal-secret': ASK.token || '' };   // server/cron
      const resp = await fetch(ASK.endpoint, {
        method: 'POST', headers,
        body: JSON.stringify({ system: systemPrompt, messages: apiMessages, model, brand_id: ASK.brand_id }),
      });
      if (!resp.ok) { const txt = await resp.text(); throw new Error(`${resp.status}: ${txt.slice(0,300)}`); }
      const data = await resp.json();
      if (data.error) throw new Error(data.detail || data.error);
      setHistory(h=>[...h, {role:'assistant', content:data.text || '(no response)', time:Date.now(), usage:data.usage||{}}]);
    } catch (e) {
      setError(e.message || String(e));
      setHistory(h=>h.slice(0,-1)); // drop the user message on failure
    } finally {
      setLoading(false);
    }
  };

  // Action-oriented prompts first (what to do / not do / what changed), then the
  // analytical deep-dives. These are what a busy operator actually opens with.
  const quickPrompts = [
    'What should I do today? Give me the top 3 actions, ranked by £ impact.',
    'What should I NOT do this week, and why?',
    'What changed since last week, and does any of it actually matter?',
    'Which single action would most improve contribution margin?',
    'Draft a Meta creative brief from the current creative + fatigue data.',
    'Is it safe to scale Meta spend this week? Check stock cover and MER first.',
    'How is MER trending week-over-week over the last 4 weeks?',
    'Which email flow has the best revenue per recipient and which is broken?',
    'Which product SKUs have a return rate above 8% and what is their combined revenue?',
    'Which channels are growing or declining week-over-week?',
  ];

  return (<div>
    <div className="card" style={{marginBottom:14, borderLeft:'3px solid #c084fc'}}>
      <h2>Ask the data</h2>
      <div className="muted" style={{marginBottom:10, fontSize:12}}>Runs <b>securely server-side</b> — the LLM key stays on the server and never touches your browser. Your question goes with a compact summary of your live data ({Math.round(JSON.stringify(buildAskContext()).length/1024)}KB).</div>
      {!ASK && (<div style={{padding:12, background:'var(--bg-app)', borderRadius:8, marginBottom:10, border:'1px solid var(--border-default)'}}>
        <div style={{fontSize:13, color:'var(--text-primary)', lineHeight:1.5}}>🔒 Ask data runs inside your authenticated workspace, where the model key is held server-side (never in the browser). It isn't enabled in this public demo. The examples below show the questions it answers from your live data.</div>
      </div>)}
      {ASK && (<div style={{display:'flex',alignItems:'center',gap:8,marginBottom:10,fontSize:11,color:'#7b7b87'}}>
        <span>🔒 Server-side · key never in browser</span>
        <select value={model} onChange={e=>setModel(e.target.value)} style={{background:'var(--bg-input)', color:'var(--text-primary)', border:'1px solid var(--border-default)', borderRadius:4, padding:'2px 6px', fontSize:11}}>
          <option value="claude-sonnet-4-5">Sonnet 4.5 (best)</option>
          <option value="claude-haiku-4-5">Haiku 4.5 (cheaper)</option>
        </select>
        {history.length>0 && <a onClick={clearHistory} style={{cursor:'pointer',color:'#fbbf24'}}>clear chat</a>}
      </div>)}
      <div style={{display:'flex',gap:6,marginBottom:10}}>
        <textarea value={question} onChange={e=>setQuestion(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)) send(); }} placeholder={ASK?'Ask a question about the dataset… (Ctrl+Enter to send)':'Available in your authenticated workspace'} disabled={!ASK||loading} rows={2} style={{flex:1, padding:'10px 12px', background:'var(--bg-input)', border:'1px solid var(--border-default)', borderRadius:6, color:'var(--text-primary)', fontSize:13, fontFamily:'inherit', resize:'vertical'}} />
        <button onClick={send} disabled={!ASK||loading||!question.trim()} style={{padding:'10px 18px', background: loading?'#404048':'#c084fc', border:'none', borderRadius:6, color:'#fff', fontWeight:600, cursor: loading?'wait':(ASK?'pointer':'not-allowed'), whiteSpace:'nowrap'}}>{loading?'Thinking…':'Ask'}</button>
      </div>
      <div style={{display:'flex',flexWrap:'wrap',gap:6,marginBottom:4}}>
        {quickPrompts.map((q,i)=>(<button key={i} onClick={()=>ASK&&setQuestion(q)} title={ASK?'':'Available in your workspace'} style={{padding:'4px 10px', background:'var(--bg-card)', border:'1px solid var(--border-default)', borderRadius:14, color:'var(--text-secondary)', fontSize:11, cursor:ASK?'pointer':'default', opacity:ASK?1:0.7}}>{q.length>60?q.slice(0,60)+'…':q}</button>))}
      </div>
      {error && (<div style={{padding:10,background:'#3a1010',border:'1px solid #f87171',borderRadius:6,marginTop:10,color:'#fca5a5',fontSize:12}}>Error: {error}</div>)}
    </div>
    {history.length > 0 && (<div className="card">
      <h2>Conversation</h2>
      <div style={{display:'flex',flexDirection:'column',gap:12,maxHeight:600,overflowY:'auto'}}>
        {history.slice().reverse().map((m,i)=>(<div key={i} style={{padding:12, background: m.role==='user'?'#1f1f2a':'#16161b', borderRadius:8, borderLeft:`3px solid ${m.role==='user'?'#5b8def':'#c084fc'}`}}>
          <div style={{fontSize:10,color:'#7b7b87',marginBottom:6,textTransform:'uppercase',letterSpacing:.05,fontWeight:600,display:'flex',justifyContent:'space-between'}}>
            <span>{m.role==='user'?'You':'Claude'}</span>
            <span>{new Date(m.time).toLocaleString()}{m.usage?` · ${m.usage.input_tokens||0} in / ${m.usage.output_tokens||0} out${m.usage.cache_read_input_tokens?` · cached ${m.usage.cache_read_input_tokens}`:''}`:''}</span>
          </div>
          <div style={{fontSize:13, whiteSpace:'pre-wrap', lineHeight:1.5, color:'var(--text-primary)'}}>{m.content}</div>
          {m.role==='assistant' && (<div style={{marginTop:8, display:'flex', gap:8, alignItems:'center'}}>
            <button onClick={()=>{ if(aiSaveTask(m.content)) setSavedTasks(s=>({...s,[m.time]:true})); }} disabled={!!savedTasks[m.time]}
              style={{padding:'4px 10px', background:savedTasks[m.time]?'transparent':'#1a1a22', border:'1px solid '+(savedTasks[m.time]?'var(--good)':'#30303a'), borderRadius:6, color:savedTasks[m.time]?'var(--good)':'#b6b6c0', fontSize:11, cursor:savedTasks[m.time]?'default':'pointer'}}>
              {savedTasks[m.time]?'✓ Saved to Weekly Board':'+ Save as task'}
            </button>
            <span style={{fontSize:10.5, color:'#7b7b87'}}>turns this into a tracked action on the Board</span>
          </div>)}
        </div>))}
      </div>
    </div>)}
  </div>);
}

function BrandAgeBanner(){
  // If this brand has < 60 days of trading history visible in data, warn that
  // trend findings are directional and forecasts shouldn't be trusted.
  if (!D.shopify || !D.shopify.length) return null;
  const dates = D.shopify.map(r=>r.date).filter(Boolean).sort();
  if (!dates.length) return null;
  const first = new Date(dates[0]); const last = new Date(dates[dates.length-1]);
  const days = Math.round((last - first) / (1000*60*60*24));
  if (days >= 60) return null;
  const sev = days < 14 ? 'critical' : days < 30 ? 'high' : 'medium';
  const colorVar = sev === 'critical' ? 'var(--bad)' : sev === 'high' ? 'var(--warn)' : 'var(--text-muted)';
  const bgVar = sev === 'critical' ? 'var(--bad-bg)' : sev === 'high' ? 'var(--warn-bg)' : 'var(--bg-card)';
  return (<div className="status-banner" style={{background: bgVar, borderColor: colorVar + '40', marginBottom: 'var(--s-3)'}}>
    <span className="status-banner-tag" style={{color: colorVar}}>⚠ Thin data · {days}d</span>
    <span className="status-banner-body">
      Fewer than 60 days of trading history. Trends, diffs and £ quantifications are <b>directional only</b>. Forecasts not meaningful at this scale.
    </span>
  </div>);
}

// Compact app-bar freshness chip — replaces the full-width banner on every screen.
// One dot + status; per-channel ages on hover; click → Connections. Detail deferred.
function FreshnessChip(){
  const B = window.FRKL_BUSINESS || {};
  const today = new Date();
  const lastDate = (rows) => { if(!rows||!rows.length) return null; const s=[...rows].filter(r=>r.date).sort((a,b)=>a.date<b.date?-1:1); return s.length?s[s.length-1].date:null; };
  const daysAgo = (iso) => iso==null?null:Math.floor((today-new Date(iso+'T00:00:00Z'))/86400000);
  const sources=[['Meta',D.metaDaily],['Google',D.googleAds],['GA4',D.ga4],['Klaviyo',D.klaviyo],['Shopify',D.shopify],['IG',B.igDaily]]
    .map(([name,rows])=>({name,n:daysAgo(lastDate(rows))}));
  const ageStr=(n)=> n==null?'no data':n===0?'today':n+'d';
  const stale=sources.filter(s=>s.n==null||s.n>4), ageing=sources.filter(s=>s.n==null||s.n>1);
  const color=stale.length?'var(--bad)':ageing.length?'var(--warn)':'var(--good)';
  const label=stale.length?`${stale.length} stale`:ageing.length?`${ageing.length} ageing`:'Live';
  const tip='Data freshness\n'+sources.map(s=>`${s.name}: ${ageStr(s.n)}`).join('   ·   ')+'\n(click to manage connections)';
  return (<button onClick={()=>window.__oiNav&&window.__oiNav('settings','connections')} title={tip} aria-label={`Data freshness: ${label}`}
    style={{display:'inline-flex',alignItems:'center',gap:6,height:30,padding:'0 10px',flexShrink:0,borderRadius:8,background:'var(--bg-card)',border:'1px solid var(--border-default)',color:'var(--text-secondary)',cursor:'pointer',fontSize:12,whiteSpace:'nowrap'}}>
    <span style={{width:7,height:7,borderRadius:'50%',background:color,display:'inline-block'}}/>
    <span style={{fontWeight:600}}>{label}</span>
  </button>);
}

function ConnectionHealthStrip(){
  // Show freshness per source. Green if < 2d stale, amber 2-4d, red > 4d.
  const today = new Date();
  const lastDate = (rows) => {
    if (!rows || !rows.length) return null;
    const sorted = [...rows].filter(r=>r.date).sort((a,b)=>a.date<b.date?-1:1);
    return sorted.length ? sorted[sorted.length-1].date : null;
  };
  const daysAgo = (iso) => {
    if (!iso) return null;
    const ms = today - new Date(iso + "T00:00:00Z");
    return Math.floor(ms / (1000*60*60*24));
  };
  const sources = [
    {name:'Meta',     last: lastDate(D.metaDaily),  count:(D.metaDaily||[]).length},
    {name:'Google',   last: lastDate(D.googleAds),  count:(D.googleAds||[]).length},
    {name:'GA4',      last: lastDate(D.ga4),        count:(D.ga4||[]).length},
    {name:'Klaviyo',  last: lastDate(D.klaviyo),    count:(D.klaviyo||[]).length},
    {name:'Shopify',  last: lastDate(D.shopify),    count:(D.shopify||[]).length},
    {name:'IG',       last: lastDate(B.igDaily),    count:(B.igDaily||[]).length},
  ];
  const sevVar = (n) => n == null ? 'var(--text-muted)' : n <= 1 ? 'var(--good)' : n <= 4 ? 'var(--warn)' : 'var(--bad)';
  const issues = sources.filter(s => s.last == null || daysAgo(s.last) > 1);
  const critical = sources.filter(s => s.last == null || daysAgo(s.last) > 4);
  const headColor = critical.length ? 'var(--bad)' : issues.length ? 'var(--warn)' : 'var(--good)';
  const headBg = critical.length ? 'var(--bad-bg)' : issues.length ? 'var(--warn-bg)' : 'var(--good-bg)';
  const headLabel = critical.length ? '⚠ Stale' : issues.length ? '◐ Ageing' : '✓ Fresh';
  return (<div className="status-banner" style={{background: headBg, borderColor: headColor + '40', marginBottom: 'var(--s-3)'}}>
    <span className="status-banner-tag" style={{color: headColor}}>{headLabel}</span>
    <div style={{display:'flex', gap:'var(--s-4)', alignItems:'center', flexWrap:'wrap', flex:1}}>
      {sources.map((s,i)=>{
        const n = s.last == null ? null : daysAgo(s.last);
        const c = sevVar(n);
        const label = s.last == null ? 'no data' : n === 0 ? 'today' : n === 1 ? '1d' : n + 'd';
        return (<span key={i}
          title={s.last ? `Latest ${s.name} data: ${s.last} (${s.count} rows)` : `No ${s.name} data loaded`}
          style={{display:'flex', gap:6, alignItems:'center', cursor:'help', fontSize:11.5}}>
          <span style={{display:'inline-block', width:6, height:6, borderRadius:'var(--r-full)', background:c}}/>
          <b style={{color:'var(--text-secondary)', fontWeight:550}}>{s.name}</b>
          <span style={{color:c, fontWeight:600}}>{label}</span>
        </span>);
      })}
    </div>
    {critical.length > 0 && (<span style={{color:'var(--bad)', fontSize:11}}>
      {critical.map(s=>s.name).join(', ')} hasn't updated in &gt;4d — reconnect in Settings → Connections
    </span>)}
  </div>);
}

// ── Weekly Board (management report card) ───────────────────────────────────
// A browsable, week-by-week scorecard for the Monday meeting. Each past week's
// metrics ARE the true history — recomputed from the daily snapshot, which is
// immutable for completed weeks — so week-on-week comparison works with no new
// storage. Decisions/actions + per-week meeting notes persist locally (the
// chosen local-first model), keyed by week.

// The scorecard set: only metrics that are honestly derivable at weekly grain
// from the daily snapshot. Customer-cohort metrics (returning %, CAC, LTV,
// contribution) need period-level cohorting and are intentionally left to the
// live dashboard rather than faked weekly here.
const BOARD_METRICS = [
  {key:'revenue',       label:'Net revenue',    fmt:GBP, better:'up'},
  {key:'paid',          label:'Paid spend',     fmt:GBP, better:'flat'},
  {key:'mer',           label:'MER',            fmt:v=>v==null?'—':v.toFixed(2)+'×', better:'up',   bench:2,    benchTip:'Target ≥ 2.0×'},
  {key:'orders',        label:'Orders',         fmt:NUM, better:'up'},
  {key:'aov',           label:'AOV',            fmt:GBP, better:'up'},
  {key:'sessions',      label:'Sessions',       fmt:NUM, better:'up'},
  {key:'cvr',           label:'CVR',            fmt:PCT, better:'up',   bench:0.02, benchTip:'Target ≥ 2% (DTC)'},
  {key:'discountDepth', label:'Discount depth', fmt:PCT, better:'down', bench:0.10, benchTip:'Lower is better · watch > 10%'},
  {key:'emailOpenRate', label:'Email open rate', fmt:PCT, better:'up', note:'Klaviyo opens ÷ recipients — list-engagement signal. (Attributed email revenue is shown in Channels → Email; it over-counts vs net because Klaviyo credits the same order to multiple emails/flows, so it is deliberately kept off this scorecard.)'},
];

// Supporting metrics — a second, lighter tier for the board. Channel-level and
// funnel detail that explains the headline KPIs above.
const _xRoas = v => v==null ? '—' : v.toFixed(1)+'×';
const BOARD_METRICS2 = [
  {key:'returnRate',   label:'Return rate',     fmt:PCT, better:'down', bench:0.08, benchTip:'Watch > 8%', note:'90-day blended return rate (returns ÷ units). Returns post asynchronously so can\'t be reliably dated to a single week — shown as a stable blend rather than a misleading weekly 0%.'},
  {key:'metaRoas',     label:'Meta ROAS',       fmt:_xRoas, better:'up', bench:2, note:'Meta-claimed purchase value ÷ Meta spend. Platform-claimed (overlaps other channels), not incremental.'},
  {key:'googleRoas',   label:'Google ROAS',     fmt:_xRoas, better:'up', bench:2, note:'Google-claimed conversion value ÷ Google spend. Platform-claimed, not incremental.'},
  {key:'atcRate',      label:'Add-to-cart rate',fmt:PCT, better:'up', note:'GA4 add-to-carts ÷ sessions — top-of-funnel intent.'},
  {key:'checkoutRate', label:'Reached checkout',fmt:PCT, better:'up', note:'GA4 checkouts ÷ sessions — mid-funnel progression.'},
  {key:'emailClickRate',label:'Email click rate',fmt:PCT, better:'up', note:'Klaviyo clicks ÷ recipients — content/offer resonance.'},
];

// Auto-generated board commentary: turns the week's numbers (vs prior week +
// benchmarks + events) into a plain-English "what worked / what to watch /
// context" read. Each candidate carries a severity so we surface the most
// important few rather than a wall of bullets.
function weekCommentary(W, prev){
  const m = W.m, p = (prev && !prev.partial) ? prev.m : null;
  const worked=[], watch=[], context=[];
  const ch = (a,b) => (b!=null && b!==0 && a!=null) ? (a-b)/Math.abs(b) : null;
  const fp = c => Math.abs(c*100).toFixed(0)+'%';
  const lc = s => s.charAt(0).toLowerCase()+s.slice(1);

  // Revenue
  const rCh = p ? ch(m.revenue, p.revenue) : null;
  if(rCh!=null && rCh>=0.05) worked.push({sev:3+Math.min(rCh,3), text:`Revenue grew ${fp(rCh)} WoW to ${GBP(m.revenue)}.`});
  else if(rCh!=null && rCh<=-0.05) watch.push({sev:3+Math.min(Math.abs(rCh),3), text:`Revenue fell ${fp(rCh)} WoW to ${GBP(m.revenue)}.`});

  // Spend efficiency (MER) + diminishing-return check
  if(m.mer!=null){
    if(m.mer>=2){ const mCh = p?ch(m.mer,p.mer):null;
      worked.push({sev:2.2+(mCh&&mCh>0?Math.min(mCh,1):0), text:`Paid stayed efficient — MER ${m.mer.toFixed(2)}× (above the 2× line)${mCh&&mCh>=0.05?`, up ${fp(mCh)} WoW`:''}.`}); }
    else watch.push({sev:2.6, text:`Paid efficiency thin — MER ${m.mer.toFixed(2)}×, under the 2× line.`});
  }
  if(p){ const sCh=ch(m.paid,p.paid), rc=ch(m.revenue,p.revenue);
    if(sCh!=null && rc!=null && sCh>=0.15 && rc < sCh*0.5)
      watch.push({sev:2.8, text:`Spend rose ${fp(sCh)} but revenue ${rc>=0?'only rose '+fp(rc):'fell '+fp(rc)} — diminishing return on the extra budget.`}); }

  // Conversion vs the single CVR benchmark
  if(m.cvr!=null){
    if(m.cvr>=CVR_BENCH){ const cCh=p?ch(m.cvr,p.cvr):null;
      worked.push({sev:2+(cCh&&cCh>0?Math.min(cCh,1):0), text:`Conversion healthy at ${PCT(m.cvr)} (at/above the ${CVR_BENCH_LABEL} target).`}); }
    else { const cCh=p?ch(m.cvr,p.cvr):null;
      watch.push({sev:2.2, text:`Conversion ${PCT(m.cvr)} — still under the ${CVR_BENCH_LABEL} target${cCh&&cCh>=0.05?`, though improving (${fp(cCh)} WoW)`:''}.`}); }
  }

  // Funnel leak: strong add-to-cart but weak checkout follow-through
  if(m.atcRate!=null && m.checkoutRate!=null && m.atcRate>0){
    const carry = m.checkoutRate/m.atcRate;
    if(carry<0.45 && m.atcRate>=0.03) watch.push({sev:1.6, text:`Funnel leak — ${PCT(m.atcRate)} add to cart but only ${PCT(m.checkoutRate)} reach checkout (${fp(carry)} carry-through).`});
  }

  // AOV / basket
  if(p){ const aCh=ch(m.aov,p.aov);
    if(aCh!=null && aCh>=0.06) worked.push({sev:1.2+Math.min(Math.abs(aCh),1), text:`Basket size up — AOV ${GBP(m.aov)} (${fp(aCh)} WoW).`});
    else if(aCh!=null && aCh<=-0.08) watch.push({sev:1.3+Math.min(Math.abs(aCh),1), text:`Basket size slipped — AOV ${GBP(m.aov)} (${fp(aCh)} WoW).`}); }

  // Traffic
  if(p){ const tCh=ch(m.sessions,p.sessions);
    if(tCh!=null && tCh>=0.1) worked.push({sev:1+Math.min(Math.abs(tCh),1), text:`Traffic grew ${fp(tCh)} to ${NUM(m.sessions)} sessions.`});
    else if(tCh!=null && tCh<=-0.1) watch.push({sev:1.1+Math.min(Math.abs(tCh),1), text:`Traffic dropped ${fp(tCh)} to ${NUM(m.sessions)} sessions.`}); }

  // Discounting & margin
  if(m.discountDepth!=null){
    if(m.discountDepth>0.12) watch.push({sev:1.5, text:`Discounting ran deep — ${PCT(m.discountDepth)} of sales given away, squeezing margin.`});
    else if(p){ const dCh=ch(m.discountDepth,p.discountDepth); if(dCh!=null && dCh<=-0.2) worked.push({sev:0.9, text:`Less reliance on discounting — depth down to ${PCT(m.discountDepth)}.`}); }
  }
  if(m.returnRate!=null && m.returnRate>0.08) watch.push({sev:1.2, text:`Returns elevated — ${PCT(m.returnRate)} of sales refunded.`});

  // Channel ROAS
  if(m.metaRoas!=null && W.metaSpend>=40){ if(m.metaRoas>=2.5) worked.push({sev:0.8, text:`Meta pulled its weight — ${m.metaRoas.toFixed(1)}× claimed ROAS on ${GBP(W.metaSpend)}.`}); else if(m.metaRoas<1.5) watch.push({sev:1.2, text:`Meta soft — ${m.metaRoas.toFixed(1)}× claimed ROAS on ${GBP(W.metaSpend)} spend.`}); }
  if(m.googleRoas!=null && W.googleSpend>=40){ if(m.googleRoas>=3) worked.push({sev:0.8, text:`Google pulled its weight — ${m.googleRoas.toFixed(1)}× claimed ROAS on ${GBP(W.googleSpend)}.`}); else if(m.googleRoas<1.5) watch.push({sev:1.2, text:`Google soft — ${m.googleRoas.toFixed(1)}× claimed ROAS on ${GBP(W.googleSpend)} spend.`}); }

  // Email engagement
  if(p){ const eCh=ch(m.emailOpenRate,p.emailOpenRate); if(eCh!=null && eCh<=-0.15) watch.push({sev:0.6, text:`Email open rate softened to ${PCT(m.emailOpenRate)} (${fp(eCh)} WoW).`});
    else if(eCh!=null && eCh>=0.15) worked.push({sev:0.6, text:`Email engagement up — open rate ${PCT(m.emailOpenRate)} (${fp(eCh)} WoW).`}); }

  // Context: events, sales, data caveats
  loadBrandEvents().forEach(e=>{ if(e.startsOn>=W.weekStart && e.startsOn<=W.weekEnding){ const mt=EVENT_META[e.type]||EVENT_META.other; context.push({sev:2, text:`${mt.icon} ${e.title||mt.label} ran (${(e.startsOn||'').slice(5)}).`}); }});
  ((window.FRKL_DISCOUNT_CODES && window.FRKL_DISCOUNT_CODES.codes)||[]).filter(c=>c && c.pattern!=='always-on' && (c.discount||0)>=120).forEach(c=>{ let pk=null;(c.series||[]).forEach(x=>{if(!pk||x.d>pk.d)pk=x;}); if(pk && pk.w>=W.weekStart && pk.w<=W.weekEnding) context.push({sev:1.8, text:`🏷️ ${c.code} sale ran — ${c.discountRate!=null?Math.round(c.discountRate*100)+'% off':'sale'}, £${Math.round(c.discount)} given.`}); });
  if(W.partial) context.push({sev:3, text:`Week still in progress — ${W.days}/7 days captured so far.`});
  else if(prev && prev.partial) context.push({sev:1, text:`Prior week was partial, so week-on-week comparisons are muted.`});
  if(!p && !W.partial) context.push({sev:1, text:`No comparable prior week — first full week in range.`});

  const top = (arr,n) => arr.sort((a,b)=>b.sev-a.sev).slice(0,n).map(x=>x.text);

  // Headline verdict
  let verdict;
  if(rCh!=null && rCh>=0.1 && (m.mer==null||m.mer>=2)) verdict='Strong week';
  else if(rCh!=null && rCh<=-0.12) verdict='Tough week';
  else if(m.mer!=null && m.mer<2) verdict='Mixed week';
  else verdict='Steady week';
  const hp=[];
  hp.push(rCh!=null ? `revenue ${rCh>=0?'up':'down'} ${fp(rCh)} to ${GBP(m.revenue)}` : `revenue ${GBP(m.revenue)}`);
  if(m.mer!=null) hp.push(`MER ${m.mer.toFixed(1)}×`);
  if(m.cvr!=null) hp.push(`CVR ${PCT(m.cvr)}`);
  const topWatch = watch.slice().sort((a,b)=>b.sev-a.sev)[0];
  const headline = `${verdict}: ${hp.join(', ')}.` + (topWatch ? ` Main watch-out — ${lc(topWatch.text)}` : '');

  return {headline, verdict, worked:top(worked,5), watch:top(watch,5), context:top(context,4)};
}

// Build the full weekly history (Mon–Sun buckets) from the daily snapshot,
// independent of the page's period selector (uses the real data bounds).
function boardWeeks(){
  const map = {};
  const touch = d => (map[d] = map[d] || {date:d, metaSpend:0, googleSpend:0, metaValue:0, googleValue:0, revenue:0, sessions:0, addToCarts:0, checkouts:0, emailRev:0, emailRecipients:0, emailOpens:0, emailClicks:0, orders:0, discounts:0, returns:0, totalSales:0});
  inRangeBounded(D.metaDaily, REAL_START, REAL_END).forEach(r=>{const m=touch(r.date); m.metaSpend += r.cost||0; m.metaValue += r.purchaseValue||0;});
  inRangeBounded(D.googleAds, REAL_START, REAL_END).forEach(r=>{const m=touch(r.date); m.googleSpend += r.cost||0; m.googleValue += r.convValue||0;});
  inRangeBounded(D.shopify,   REAL_START, REAL_END).forEach(r=>{const m=touch(r.date); m.revenue += r.netSales||0; m.orders += r.orders||0; m.discounts += r.discounts||0; m.returns += r.returns||0; m.totalSales += r.totalSales||0;});
  inRangeBounded(D.ga4,       REAL_START, REAL_END).forEach(r=>{const m=touch(r.date); m.sessions += r.sessions||0; m.addToCarts += r.addToCarts||0; m.checkouts += r.checkouts||0;});
  inRangeBounded(D.klaviyo,   REAL_START, REAL_END).forEach(r=>{const m=touch(r.date); m.emailRev += r.orderValue||0; m.emailRecipients += r.recipients||0; m.emailOpens += r.opens||0; m.emailClicks += r.clicks||0;});
  const days = Object.values(map).sort((a,b)=>a.date<b.date?-1:1);
  const iso = d => d.toISOString().slice(0,10);
  const mondayOf = s => { const d=new Date(s+'T00:00:00Z'); const off=(d.getUTCDay()+6)%7; d.setUTCDate(d.getUTCDate()-off); return iso(d); };
  const addDays = (s,n) => { const d=new Date(s+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return iso(d); };
  const buckets = {};
  days.forEach(m=>{ const ws=mondayOf(m.date); (buckets[ws]=buckets[ws]||[]).push(m); });
  // Returns aren't dated in the daily feed (they post async at the order level), so
  // weekly returns ≈ 0. Fall back to the reliable 90-day blended product return rate.
  const _B=(typeof window!=='undefined'&&window.FRKL_BUSINESS)||{}; const _prod=_B.products||[];
  const _u=_prod.reduce((a,p)=>a+(p.units||0),0), _r=_prod.reduce((a,p)=>a+(p.returns||0),0);
  const blendedReturnRate = _u>0 ? _r/_u : null;
  // Blended email open/click rate over the whole window — the honest fallback when a
  // single week's opens exceed its recipients (the Klaviyo send-vs-open dating artifact).
  const _tO=days.reduce((a,r)=>a+(r.emailOpens||0),0), _tC=days.reduce((a,r)=>a+(r.emailClicks||0),0), _tR=days.reduce((a,r)=>a+(r.emailRecipients||0),0);
  const blendedOpenRate = _tR>0 ? Math.min(1,_tO/_tR) : null, blendedClickRate = _tR>0 ? Math.min(1,_tC/_tR) : null;
  return Object.keys(buckets).sort().map(ws=>{
    const rows = buckets[ws], s = k => rows.reduce((a,r)=>a+(r[k]||0),0);
    const revenue=s('revenue'), paid=s('metaSpend')+s('googleSpend'), orders=s('orders'),
          sessions=s('sessions'), discounts=s('discounts'), returns=s('returns'), totalSales=s('totalSales'), emailRev=s('emailRev'),
          emailRecipients=s('emailRecipients'), emailOpens=s('emailOpens'), emailClicks=s('emailClicks'),
          metaSpend=s('metaSpend'), googleSpend=s('googleSpend'), metaValue=s('metaValue'), googleValue=s('googleValue'),
          addToCarts=s('addToCarts'), checkouts=s('checkouts');
    const we = addDays(ws,6);
    return {
      weekStart: ws, weekEnding: we, days: rows.length,
      partial: rows.length < 7 || we > REAL_END,
      label: ws.slice(5)+' – '+we.slice(5),
      metaSpend, googleSpend,
      m: {
        revenue, paid, orders, sessions, emailRev, returns,
        mer: paid>0 ? revenue/paid : null,
        aov: orders>0 ? revenue/orders : null,
        cvr: sessions>0 ? orders/sessions : null,
        discountDepth: totalSales>0 ? discounts/totalSales : null,
        returnRate: returns>0 && totalSales>0 ? returns/totalSales : blendedReturnRate,
        metaRoas: metaSpend>0 ? metaValue/metaSpend : null,
        googleRoas: googleSpend>0 ? googleValue/googleSpend : null,
        atcRate: sessions>0 ? addToCarts/sessions : null,
        checkoutRate: sessions>0 ? checkouts/sessions : null,
        // Klaviyo opens/clicks are dated when they happen but recipients when sent, so a
        // single week can read >100% — when it does, fall back to the blended rate.
        emailOpenRate: emailRecipients>0 ? (emailOpens<=emailRecipients ? emailOpens/emailRecipients : blendedOpenRate) : blendedOpenRate,
        emailClickRate: emailRecipients>0 ? (emailClicks<=emailRecipients ? emailClicks/emailRecipients : blendedClickRate) : blendedClickRate,
      },
    };
  });
}

// RAG verdict for a metric value vs the prior week. Benchmark (if any) dominates;
// otherwise a ≥2% WoW move in the metric's "good" direction sets the colour.
function boardRag(spec, val, prev){
  if(spec.better==='flat' || val==null) return 'neutral';
  let ch = (prev!=null && prev!==0) ? (val-prev)/Math.abs(prev) : null;
  const good = ch==null ? null : (spec.better==='down' ? ch<0 : ch>0);
  if(spec.bench!=null){
    const meets = spec.better==='down' ? val<=spec.bench : val>=spec.bench;
    if(meets) return 'good';
    return good ? 'warn' : 'bad';   // below target — improving = watch, worsening = off-track
  }
  if(good==null || Math.abs(ch)<0.02) return 'neutral';
  return good ? 'good' : 'bad';
}
const RAG_COL = {good:'var(--good)', warn:'var(--warn)', bad:'#f87171', neutral:'var(--text-faint)'};

// Tiny inline sparkline of a metric's trailing weeks.
function BoardSpark({vals, color}){
  const v = (vals||[]).filter(x=>x!=null);
  if(v.length < 2) return <div style={{height:30}}/>;
  const w=132, h=30, pad=3, min=Math.min(...v), max=Math.max(...v), rng=(max-min)||1;
  const pts = v.map((x,i)=>`${pad+(i/(v.length-1))*(w-2*pad)},${pad+(h-2*pad)-((x-min)/rng)*(h-2*pad)}`).join(' ');
  const lastX = pad+(w-2*pad), lastY = pad+(h-2*pad)-((v[v.length-1]-min)/rng)*(h-2*pad);
  return (<svg width={w} height={h} style={{display:'block'}}>
    <polyline points={pts} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round"/>
    <circle cx={lastX} cy={lastY} r={2.2} fill={color}/>
  </svg>);
}

// localStorage-backed decisions log (local-first). Actions are a running backlog
// carried across weeks; notes are per-week meeting minutes.
function boardLoadActions(){ try { const a=JSON.parse(localStorage.getItem('frkl-board-actions')||'[]'); return Array.isArray(a)?a:[]; } catch(e){ return []; } }
function boardSaveActions(a){ try { localStorage.setItem('frkl-board-actions', JSON.stringify(a)); } catch(e){} }
// Turn an AI answer (or any finding) into a tracked task in the Weekly Board backlog.
function aiSaveTask(text){
  try {
    const a = boardLoadActions();
    const t = String(text||'').replace(/\s+/g,' ').trim().slice(0,200);
    if(!t) return false;
    a.push({id:'ai'+Date.now(), text:t, status:'open', raised: (typeof REAL_END!=='undefined'?REAL_END:null), doneWeek:null, source:'ai'});
    boardSaveActions(a);
    toast('Saved as task', {kind:'good', body:'Added to your action board.'});
    return true;
  } catch(e){ return false; }
}
function boardLoadNotes(){ try { const n=JSON.parse(localStorage.getItem('frkl-board-notes')||'{}'); return n&&typeof n==='object'?n:{}; } catch(e){ return {}; } }
function boardSaveNotes(n){ try { localStorage.setItem('frkl-board-notes', JSON.stringify(n)); } catch(e){} }

const ACTION_FLOW = {open:'actioning', actioning:'done', done:'open'};
const ACTION_META = {
  open:      {label:'Open',      col:'var(--warn)'},
  actioning: {label:'Actioning', col:'var(--accent)'},
  done:      {label:'Done',      col:'var(--good)'},
};

function WeeklyBoard(){
  const weeks = useMemo(boardWeeks, [(typeof window!=='undefined' && window.FRKL_LIVE && window.FRKL_LIVE.lastFetchAt) || 0]);  // recompute when live data arrives (was [] → froze frkl static)
  const lastCompleteIdx = (()=>{ for(let i=weeks.length-1;i>=0;i--){ if(!weeks[i].partial) return i; } return weeks.length-1; })();
  const [idx, setIdx] = useState(lastCompleteIdx<0?0:lastCompleteIdx);
  const [actions, setActions] = useState(boardLoadActions);
  const [notes, setNotes] = useState(boardLoadNotes);
  const [newAction, setNewAction] = useState('');

  if(!weeks.length) return (<div className="card"><h2>Weekly board</h2><div className="muted">No data yet — connect a source to start logging weeks.</div></div>);

  const W = weeks[idx], prev = weeks[idx-1] || null;
  const trail = (key, upto) => weeks.slice(Math.max(0,upto-9), upto+1).map(w=>w.m[key]);

  // Persisted mutations
  const persistActions = next => { setActions(next); boardSaveActions(next); };
  const addAction = () => { const t=newAction.trim(); if(!t) return;
    persistActions([...actions, {id:'a'+Date.now()+Math.round(performance.now()), text:t, status:'open', raised:W.weekEnding, doneWeek:null}]);
    setNewAction(''); };
  const cycleAction = a => { const ns=ACTION_FLOW[a.status]||'open';
    persistActions(actions.map(x=>x.id===a.id?{...x, status:ns, doneWeek: ns==='done'?W.weekEnding:null}:x)); };
  const delAction = a => persistActions(actions.filter(x=>x.id!==a.id));
  const setNote = v => { const next={...notes, [W.weekEnding]:v}; setNotes(next); boardSaveNotes(next); };

  // Auto-generated "what worked / what to watch / context" read for this week.
  const commentary = weekCommentary(W, prev);

  // Trend data across all weeks (for the strip)
  const trend = weeks.map(w=>({x:w.label, date:w.weekEnding, revenue:Math.round(w.m.revenue), paid:Math.round(w.m.paid),
    mer:w.m.mer!=null?+w.m.mer.toFixed(2):null, cvr:w.m.cvr!=null?+(w.m.cvr*100).toFixed(2):null}));
  const pins = buildChartPins(weeks.map(w=>({x:w.label, date:w.weekEnding})));
  const renderPins = () => pins.map((p,i)=>(<R.ReferenceLine key={'bp'+i} yAxisId="l" x={p.x} stroke="#8b8b99" strokeDasharray="3 3" strokeOpacity={0.5}
    label={<PinMarker icon={p.icon} n={p.n} tip={p.tip}/>}/>));

  const openCount = actions.filter(a=>a.status!=='done').length;
  const doneThisWeek = actions.filter(a=>a.status==='done' && a.doneWeek===W.weekEnding);
  const visibleActions = actions.filter(a=>a.status!=='done' || a.doneWeek===W.weekEnding);

  return (<div className="board">
    {/* Header + week selector */}
    <div className="card" style={{marginBottom:14, display:'flex', alignItems:'center', justifyContent:'space-between', gap:12, flexWrap:'wrap'}}>
      <div>
        <div className="micro" style={{color:'var(--accent)', fontWeight:700, letterSpacing:'.06em', textTransform:'uppercase'}}>Weekly board · report card</div>
        <h1 style={{margin:'4px 0 2px', fontSize:24}}>Week of {W.weekStart} <span style={{color:'var(--text-muted)', fontWeight:500, fontSize:16}}>→ {W.weekEnding}</span></h1>
        <div className="micro" style={{color:'var(--text-faint)'}}>
          {W.partial ? <span style={{color:'var(--warn)'}}>● In progress — {W.days}/7 days so far</span> : <span>Completed week · frozen from daily data</span>}
          {' · for the Monday 3pm review'}
        </div>
      </div>
      <div style={{display:'flex', alignItems:'center', gap:8}}>
        <button onClick={()=>setIdx(i=>Math.max(0,i-1))} disabled={idx<=0} className="board-nav-btn">◀ Prev</button>
        <select value={idx} onChange={e=>setIdx(+e.target.value)} style={{background:'var(--bg-card)', color:'var(--text-primary)', border:'1px solid var(--border-default)', borderRadius:'var(--r-sm)', padding:'7px 10px', fontSize:13}}>
          {weeks.map((w,i)=>(<option key={w.weekStart} value={i}>{w.label}{w.partial?' (in progress)':''}</option>))}
        </select>
        <button onClick={()=>setIdx(i=>Math.min(weeks.length-1,i+1))} disabled={idx>=weeks.length-1} className="board-nav-btn">Next ▶</button>
        <button onClick={()=>window.print()} className="board-nav-btn" title="Print / save this week as a PDF board pack">⎙ Print</button>
      </div>
    </div>

    {/* LLM analyst read (last 7d) — shown on the latest week; rule-based read below is the deterministic baseline */}
    {(function(){
      var br = (typeof window!=='undefined' && window.FRKL_BOARD_READ) || null;
      if(!br || !br.read || idx < weeks.length-2) return null;   // show on the two most recent weeks (covers default + in-progress)
      var r = br.read;
      return (<div className="card" style={{marginBottom:14, borderLeft:'3px solid var(--accent)'}}>
        <div className="card-section-title">
          <h2 style={{margin:0}}>✦ Analyst read</h2>
          <span className="meta">AI · last 7 days to {br.asOf} · {r.model||'llm'}</span>
        </div>
        <p style={{margin:'0 0 10px', fontSize:16, lineHeight:1.5, color:'var(--text-primary)', fontWeight:500}}>{r.headline}</p>
        {r.narrative && <p style={{margin:'0 0 12px', fontSize:13.5, lineHeight:1.55, color:'var(--text-secondary)'}}>{r.narrative}</p>}
        {(r.findings||[]).length>0 && <div style={{display:'flex', flexDirection:'column', gap:7}}>
          {r.findings.map(function(f,i){ var col = f.verdict==='act'?'#f87171':f.verdict==='monitor'?'var(--warn)':'var(--text-faint)';
            return (<div key={i} style={{display:'flex', gap:8, alignItems:'baseline', fontSize:13}}>
              <span className="pill" style={{background:col+'22', color:col, fontSize:9.5, fontWeight:700, padding:'2px 7px', borderRadius:'var(--r-full)', textTransform:'uppercase', flexShrink:0}}>{f.verdict}</span>
              <span style={{color:'var(--text-secondary)'}}><b style={{color:'var(--text-primary)'}}>{f.metric}{f.gbp!=null?` (£${NUM(f.gbp)})`:''}</b> — {f.recommendation}</span>
            </div>); })}
        </div>}
        {(r.blindspots||[]).length>0 && <div className="micro" style={{color:'var(--text-faint)', marginTop:10}}>Blind spots: {r.blindspots.join(' · ')}</div>}
        <div className="micro" style={{color:'var(--text-faint)', marginTop:8, fontStyle:'italic'}}>AI-written from your data; £ figures grounded against the dataset. The rule-based read below is the deterministic baseline.</div>
      </div>);
    })()}

    {/* Commentary — the report-card narrative: headline + what worked / what to watch / context */}
    <div className="card board-commentary" style={{marginBottom:14, borderLeft:`3px solid ${commentary.verdict==='Strong week'?'var(--good)':commentary.verdict==='Tough week'?'#f87171':commentary.verdict==='Mixed week'?'var(--warn)':'var(--accent)'}`}}>
      <div className="micro" style={{color:'var(--text-muted)', fontWeight:700, letterSpacing:'.05em', textTransform:'uppercase', marginBottom:6}}>This week in a nutshell</div>
      <p style={{margin:'0 0 14px', fontSize:16, lineHeight:1.5, color:'var(--text-primary)', fontWeight:500}}>{commentary.headline}</p>
      <div className="board-commentary-cols">
        <div>
          <div className="board-comm-head" style={{color:'var(--good)'}}>✓ What worked</div>
          {commentary.worked.length ? commentary.worked.map((t,i)=>(<div key={i} className="board-comm-line">{t}</div>)) : <div className="board-comm-line muted">Nothing stood out as a clear win this week.</div>}
        </div>
        <div>
          <div className="board-comm-head" style={{color:'#f87171'}}>⚠ What to watch</div>
          {commentary.watch.length ? commentary.watch.map((t,i)=>(<div key={i} className="board-comm-line">{t}</div>)) : <div className="board-comm-line muted">No material concerns flagged.</div>}
        </div>
        <div>
          <div className="board-comm-head" style={{color:'var(--text-muted)'}}>📌 Context</div>
          {commentary.context.length ? commentary.context.map((t,i)=>(<div key={i} className="board-comm-line">{t}</div>)) : <div className="board-comm-line muted">No logged events or sales this week.</div>}
        </div>
      </div>
    </div>

    {/* Scorecard grid */}
    <div className="board-grid">
      {BOARD_METRICS.map(spec=>{
        const val=W.m[spec.key];
        // A partial prior week is not a fair baseline — suppress WoW against it.
        const pv=(prev && !prev.partial) ? prev.m[spec.key] : null;
        const rag=boardRag(spec, val, pv), col=RAG_COL[rag];
        let ch=null; if(pv!=null && pv!==0 && val!=null) ch=(val-pv)/Math.abs(pv);
        const good = ch==null?null:((ch>0)===(spec.better!=='down'));
        const tip = spec.benchTip || spec.note;
        return (<div key={spec.key} className="card board-card" style={{borderLeft:`3px solid ${col}`}}>
          <div className="micro" style={{color:'var(--text-muted)', fontWeight:600, display:'flex', justifyContent:'space-between'}}>
            <span>{spec.label}</span>
            {tip && <span title={tip} style={{cursor:'help', color:'var(--text-faint)'}}>ⓘ</span>}
          </div>
          <div style={{fontSize:24, fontWeight:700, letterSpacing:'-.01em', margin:'4px 0 2px'}}>{spec.fmt(val)}</div>
          <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:6}}>
            <span style={{fontSize:12, fontWeight:600, color: spec.better==='flat'||good==null ? 'var(--text-faint)' : (good?'var(--good)':'#f87171')}}>
              {ch==null?'—':(ch>0?'▲ ':'▼ ')+Math.abs(ch*100).toFixed(ch>=0.1||ch<=-0.1?0:1)+'% WoW'}
            </span>
            <BoardSpark vals={trail(spec.key, idx)} color={spec.better==='flat'?'#8b8b99':col}/>
          </div>
        </div>);
      })}
    </div>

    {/* Supporting metrics — channel + funnel detail behind the headline KPIs */}
    <div className="micro" style={{color:'var(--text-faint)', fontWeight:700, letterSpacing:'.05em', textTransform:'uppercase', margin:'18px 2px 8px'}}>Supporting metrics</div>
    <div className="board-grid">
      {BOARD_METRICS2.map(spec=>{
        const val=W.m[spec.key];
        const pv=(prev && !prev.partial) ? prev.m[spec.key] : null;
        const rag=boardRag(spec, val, pv), col=RAG_COL[rag];
        let ch=null; if(pv!=null && pv!==0 && val!=null) ch=(val-pv)/Math.abs(pv);
        const good = ch==null?null:((ch>0)===(spec.better!=='down'));
        const tip = spec.benchTip || spec.note;
        return (<div key={spec.key} className="card board-card" style={{borderLeft:`3px solid ${col}`}}>
          <div className="micro" style={{color:'var(--text-muted)', fontWeight:600, display:'flex', justifyContent:'space-between'}}>
            <span>{spec.label}</span>
            {tip && <span title={tip} style={{cursor:'help', color:'var(--text-faint)'}}>ⓘ</span>}
          </div>
          <div style={{fontSize:22, fontWeight:700, letterSpacing:'-.01em', margin:'4px 0 2px'}}>{spec.fmt(val)}</div>
          <div style={{display:'flex', alignItems:'center', justifyContent:'space-between', gap:6}}>
            <span style={{fontSize:12, fontWeight:600, color: good==null ? 'var(--text-faint)' : (good?'var(--good)':'#f87171')}}>
              {ch==null?'—':(ch>0?'▲ ':'▼ ')+Math.abs(ch*100).toFixed(ch>=0.1||ch<=-0.1?0:1)+'% WoW'}
            </span>
            <BoardSpark vals={trail(spec.key, idx)} color={col}/>
          </div>
        </div>);
      })}
    </div>

    {/* Trend strip */}
    <div className="row" style={{marginTop:14}}>
      <div className="card" style={{flex:'1 1 520px'}}>
        <div className="card-section-title"><h2 style={{margin:0}}>Revenue vs paid spend — weekly</h2><span className="meta">Bars = paid spend · Line = net revenue</span></div>
        <R.ResponsiveContainer width="100%" height={230}>
          <R.ComposedChart data={trend} margin={{top:18,right:16,left:6,bottom:6}}>
            <R.CartesianGrid stroke="#1f1f27" vertical={false}/>
            <R.XAxis dataKey="x" tick={{fill:'#7e7e8a',fontSize:10}} interval={Math.ceil(trend.length/8)}/>
            <R.YAxis yAxisId="l" tick={{fill:'#7e7e8a',fontSize:10}} tickFormatter={v=>'£'+(v/1000).toFixed(0)+'k'}/>
            <R.YAxis yAxisId="r" orientation="right" tick={{fill:'#7e7e8a',fontSize:10}} tickFormatter={v=>'£'+(v/1000).toFixed(0)+'k'}/>
            <R.Tooltip contentStyle={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:10}} formatter={(v,n)=>[GBP(v),n]}/>
            <R.Bar yAxisId="l" dataKey="paid" name="Paid spend" fill={COL.meta} radius={[2,2,0,0]}/>
            <R.Line yAxisId="r" type="monotone" dataKey="revenue" name="Net revenue" stroke={COL.revenue} strokeWidth={2.4} dot={false}/>
            {renderPins()}
          </R.ComposedChart>
        </R.ResponsiveContainer>
      </div>
      <div className="card" style={{flex:'1 1 320px'}}>
        <div className="card-section-title"><h2 style={{margin:0}}>Efficiency — MER &amp; CVR</h2><span className="meta">MER (×) left · CVR (%) right</span></div>
        <R.ResponsiveContainer width="100%" height={230}>
          <R.ComposedChart data={trend} margin={{top:18,right:16,left:6,bottom:6}}>
            <R.CartesianGrid stroke="#1f1f27" vertical={false}/>
            <R.XAxis dataKey="x" tick={{fill:'#7e7e8a',fontSize:10}} interval={Math.ceil(trend.length/6)}/>
            <R.YAxis yAxisId="l" tick={{fill:'#7e7e8a',fontSize:10}} tickFormatter={v=>v+'×'}/>
            <R.YAxis yAxisId="r" orientation="right" tick={{fill:'#7e7e8a',fontSize:10}} tickFormatter={v=>v+'%'}/>
            <R.Tooltip contentStyle={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:10}}/>
            <R.ReferenceLine yAxisId="l" y={2} stroke="#a78bfa" strokeDasharray="5 4" strokeOpacity={0.7} label={{value:'MER 2×', position:'insideTopLeft', fill:'#a78bfa', fontSize:9.5}}/>
            <R.ReferenceLine yAxisId="r" y={2} stroke="#38bdf8" strokeDasharray="5 4" strokeOpacity={0.6} label={{value:'CVR 2%', position:'insideTopRight', fill:'#38bdf8', fontSize:9.5}}/>
            <R.Line yAxisId="l" type="monotone" dataKey="mer" name="MER" stroke="#a78bfa" strokeWidth={2.2} dot={false}/>
            <R.Line yAxisId="r" type="monotone" dataKey="cvr" name="CVR %" stroke={COL.sessions} strokeWidth={2.2} dot={false}/>
          </R.ComposedChart>
        </R.ResponsiveContainer>
      </div>
    </div>

    {/* Decisions log */}
    <div className="row" style={{marginTop:14}}>
      <div className="card" style={{flex:'1 1 420px'}}>
        <h2 style={{marginTop:0}}>Meeting notes</h2>
        <div className="micro" style={{color:'var(--text-faint)', marginBottom:8}}>Week of {W.weekStart} → {W.weekEnding} · decisions, context, anything to remember</div>
        <textarea value={notes[W.weekEnding]||''} onChange={e=>setNote(e.target.value)} placeholder="What did we decide? e.g. 'Pausing the 22% sitewide code — margin too thin. Brief on mobile checkout fix by Friday. Test free-ship threshold at £75.'"
          style={{width:'100%', minHeight:150, background:'var(--bg-app)', color:'var(--text-primary)', border:'1px solid var(--border-default)', borderRadius:'var(--r-sm)', padding:10, fontSize:13, fontFamily:'inherit', resize:'vertical'}}/>
      </div>

      <div className="card" style={{flex:'1 1 420px'}}>
        <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline'}}>
          <h2 style={{marginTop:0}}>Actions</h2>
          <span className="micro" style={{color:'var(--text-faint)'}}>{openCount} open · carried week to week</span>
        </div>
        <div style={{display:'flex', flexDirection:'column', gap:6, marginBottom:10}}>
          {visibleActions.length===0 && <div className="muted" style={{fontSize:13}}>No open actions. Add one below as the meeting decides.</div>}
          {visibleActions.map(a=>{ const meta=ACTION_META[a.status]||ACTION_META.open; return (
            <div key={a.id} style={{display:'flex', alignItems:'center', gap:8, padding:'7px 9px', background:'var(--bg-app)', border:'1px solid var(--border-subtle)', borderRadius:'var(--r-sm)'}}>
              <button onClick={()=>cycleAction(a)} title="Click to advance status" style={{cursor:'pointer', flexShrink:0, border:'1px solid '+meta.col, color:meta.col, background:'transparent', borderRadius:'var(--r-full)', fontSize:10.5, fontWeight:700, padding:'2px 8px'}}>{meta.label}</button>
              <span style={{flex:1, fontSize:13, textDecoration: a.status==='done'?'line-through':'none', color: a.status==='done'?'var(--text-faint)':'var(--text-primary)'}}>{a.text}</span>
              <span className="micro" style={{color:'var(--text-faint)', flexShrink:0}} title={'Raised week ending '+a.raised}>{(a.raised||'').slice(5)}</span>
              <button onClick={()=>delAction(a)} title="Remove" style={{cursor:'pointer', border:'none', background:'transparent', color:'var(--text-faint)', fontSize:15, lineHeight:1}}>×</button>
            </div>); })}
        </div>
        <div style={{display:'flex', gap:6}}>
          <input value={newAction} onChange={e=>setNewAction(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')addAction();}} placeholder="Add an action…"
            style={{flex:1, background:'var(--bg-app)', color:'var(--text-primary)', border:'1px solid var(--border-default)', borderRadius:'var(--r-sm)', padding:'8px 10px', fontSize:13}}/>
          <button onClick={addAction} className="board-nav-btn" style={{flexShrink:0}}>+ Add</button>
        </div>
        {doneThisWeek.length>0 && <div className="micro" style={{color:'var(--good)', marginTop:8}}>✓ {doneThisWeek.length} completed this week</div>}
      </div>
    </div>
  </div>);
}

// ── Acquisition cohorts (real CAC/LTV from customer-level orders) ────────────
// Replaces the blended CAC/LTV *estimates* with true first-order cohorts. Revenue
// curves come from the snapshot (FRKL_COHORTS); contribution + LTV:CAC are applied
// here using the operator's verified gross margin, so margin stays one source.
function CohortStat({label, val, sub, badge, accent}){
  return (<div className="card kpi" style={accent?{borderLeft:'3px solid '+accent}:undefined}>
    <div className="label"><span>{label}</span>{badge}</div>
    <div className="val" style={{fontSize:24}}>{val}</div>
    {sub && <div className="sub">{sub}</div>}
  </div>);
}
function CohortsPanel(){
  const verified = useCostTick();   // re-render + reflect verified margin
  const C = (typeof window!=='undefined' && window.FRKL_COHORTS) || null;
  if(!C || !C.totalCustomers){
    return (<div className="card"><h2>Acquisition cohorts</h2><div className="muted">No customer-level order history yet — connect Shopify to build cohorts.</div></div>);
  }
  const gm = oiGrossMargin();
  const lifetimeRev = C.lifetimeRevPerCust, firstOrderRev = C.firstOrderRevPerCust;
  const firstShare = lifetimeRev>0 ? firstOrderRev/lifetimeRev : null;
  const contribLTV = lifetimeRev * gm;
  const paidCac = C.cac && C.cac.paid, blendedCac = C.cac && C.cac.blended;
  const ltvCacPaid = (paidCac && paidCac>0) ? contribLTV/paidCac : null;
  const firstContrib = firstOrderRev * gm;
  const paybackOrders = (paidCac && firstContrib>0) ? paidCac/firstContrib : null;
  const curve = (C.pooledCurve||[]).map(p=>({m:'m'+p.m, rev:p.cumRevPerCust, contrib:+(p.cumRevPerCust*gm).toFixed(2), n:p.customersObserved}));
  const cacMonths = (C.cac && C.cac.byMonth || []).map(r=>({month:(r.month||'').slice(2), newCust:r.newCustomers, cac:r.cac, paid:r.spend>0}));
  const ragRatio = ltvCacPaid==null?'var(--text-faint)':(ltvCacPaid>=3?'var(--good)':ltvCacPaid>=1?'var(--warn)':'#f87171');
  const badge = <MarginBadge/>;

  return (<div>
    <div className="card" style={{marginBottom:14}}>
      <div className="card-section-title">
        <h2 style={{margin:0}}>Acquisition cohorts — what a customer is really worth</h2>
        <span className="meta">{C.totalCustomers} DTC customers · {C.windowFirst}→{C.windowLast} · real first-order cohorts</span>
      </div>
      <div className="micro" style={{color:'var(--text-secondary)', lineHeight:1.55}}>
        Each customer is bucketed by the month of their <b>first order</b>, then we track what they go on to spend. {firstShare!=null && <>frkl banks <b style={{color:'var(--text-primary)'}}>{PCT(firstShare)}</b> of a customer's lifetime value in their <b>first order</b> — so every point of repeat purchase is almost pure upside, and retention is the biggest untapped lever.</>}
      </div>
    </div>

    <div className="row" style={{marginBottom:14}}>
      <CohortStat label="Contribution LTV / customer" val={GBP(contribLTV)} sub={`${GBP(lifetimeRev)} revenue × ${PCT(gm)} margin · observed to date`} badge={badge} accent="var(--good)"/>
      <CohortStat label="Paid CAC" val={paidCac!=null?GBP(paidCac):'—'} sub={`spend ÷ new customers · ${C.cac.paidMonths||0} paid month(s) · blended ${blendedCac!=null?GBP(blendedCac):'—'} understates (incl. £0-spend cohorts)`} accent="var(--accent)"/>
      <CohortStat label="LTV : CAC (paid)" val={ltvCacPaid!=null?ltvCacPaid.toFixed(1)+'×':'—'} sub="contribution LTV ÷ paid CAC · target 3×+" badge={badge} accent={ragRatio}/>
      <CohortStat label="First-order payback" val={paybackOrders!=null?(paybackOrders<=1?'1st order':paybackOrders.toFixed(1)+' orders'):'—'} sub="orders to recover paid CAC" badge={badge}/>
      <CohortStat label="Repeat rate" val={PCT(C.repeatRate)} sub={`${C.ordersPerCustomer} orders / customer`}/>
    </div>

    <div className="row">
      <div className="card" style={{flex:'2 1 480px'}}>
        <div className="card-section-title"><h2 style={{margin:0}}>Lifetime value curve</h2><span className="meta">cumulative £ per customer by months since first order</span></div>
        <R.ResponsiveContainer width="100%" height={292}>
          <R.ComposedChart data={curve} margin={{top:8,right:18,left:6,bottom:6}}>
            <R.CartesianGrid stroke="#1f1f27" vertical={false}/>
            <R.XAxis dataKey="m" tick={{fill:'#7e7e8a',fontSize:11}}/>
            <R.YAxis tick={{fill:'#7e7e8a',fontSize:11}} tickFormatter={v=>'£'+v}/>
            <R.Tooltip contentStyle={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:10,boxShadow:'var(--shadow-md)'}} formatter={(v,n)=>[GBP(v), n==='contrib'?'Contribution':'Revenue']}
              labelFormatter={(l,p)=> l + (p&&p[0]&&p[0].payload? ' · '+p[0].payload.n+' customers observed':'')}/>
            <R.Legend verticalAlign="top" align="center" wrapperStyle={{fontSize:12, paddingBottom:8}}/>
            {paidCac!=null && <R.ReferenceLine y={paidCac} stroke="#a78bfa" strokeDasharray="5 4" strokeOpacity={0.8} label={{value:'paid CAC', position:'insideTopRight', fill:'#a78bfa', fontSize:10}}/>}
            <R.Area type="monotone" dataKey="rev" name="Revenue" stroke={COL.revenue} fill={COL.revenue+'22'} strokeWidth={2}/>
            <R.Line type="monotone" dataKey="contrib" name="Contribution" stroke="#a78bfa" strokeWidth={2.4} dot={false}/>
            <R.Brush {...brushProps('m')} />
          </R.ComposedChart>
        </R.ResponsiveContainer>
        <div style={{fontSize:10.5,color:'var(--text-faint)',textAlign:'right',marginTop:2}}>{BRUSH_HINT}</div>
        <div className="micro" style={{color:'var(--text-faint)', marginTop:4}}>Later months average fewer, older customers (shown on hover) — the curve is observed value to date, not a projection.</div>
        <ChartFooter note="What a customer is worth over time — and when they pay back CAC."
          ask="From the lifetime-value curve, how long until an average customer pays back paid CAC, and what does that mean for how aggressively I can acquire?"
          rows={curve} columns={[{key:'m',label:'Months since 1st order'},{key:'rev',label:'Cumulative rev/cust',right:true,fmt:v=>GBP(v)},{key:'contrib',label:'Cumulative contribution/cust',right:true,fmt:v=>GBP(v)}]}/>
      </div>
      <div className="card" style={{flex:'1 1 300px'}}>
        <div className="card-section-title"><h2 style={{margin:0}}>CAC by acquisition month</h2><span className="meta">new customers vs paid CAC</span></div>
        <R.ResponsiveContainer width="100%" height={292}>
          <R.ComposedChart data={cacMonths} margin={{top:8,right:14,left:6,bottom:6}}>
            <R.CartesianGrid stroke="#1f1f27" vertical={false}/>
            <R.XAxis dataKey="month" tick={{fill:'#7e7e8a',fontSize:10}}/>
            <R.YAxis yAxisId="l" tick={{fill:'#7e7e8a',fontSize:10}}/>
            <R.YAxis yAxisId="r" orientation="right" tick={{fill:'#7e7e8a',fontSize:10}} tickFormatter={v=>'£'+v}/>
            <R.Tooltip contentStyle={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:10,boxShadow:'var(--shadow-md)'}} formatter={(v,n)=> n==='cac'?[v!=null?GBP(v):'no paid spend','Paid CAC']:[NUM(v),'New customers']}/>
            <R.Bar yAxisId="l" dataKey="newCust" name="New customers" fill={COL.sessions} radius={[2,2,0,0]}/>
            <R.Line yAxisId="r" type="monotone" dataKey="cac" name="cac" stroke={COL.google} strokeWidth={2.2} dot={{r:2.5}} connectNulls/>
            <R.Brush {...brushProps('month')} />
          </R.ComposedChart>
        </R.ResponsiveContainer>
        <div style={{fontSize:10.5,color:'var(--text-faint)',textAlign:'right',marginTop:2}}>{BRUSH_HINT}</div>
        <div className="micro" style={{color:'var(--text-faint)', marginTop:4}}>Most early customers came via unpaid channels (organic/email) — paid CAC only applies where there was paid spend.</div>
        <ChartFooter note="Is acquisition getting more expensive over time?"
          ask="Looking at CAC by acquisition month, is paid CAC trending up, and what's driving it?"
          rows={cacMonths} columns={[{key:'month',label:'Month'},{key:'newCust',label:'New customers',right:true,fmt:v=>NUM(v)},{key:'cac',label:'Paid CAC',right:true,fmt:v=>v!=null?GBP(v):'—'}]}/>
      </div>
    </div>

    <div className="row" style={{marginTop:14}}>
      <div className="card" style={{flex:'1 1 380px'}}>
        <h2 style={{marginTop:0}}>Discounted vs full-price acquisition</h2>
        <table><thead><tr><th>First order</th><th>Customers</th><th>Repeat</th><th>Orders/cust</th><th>Lifetime £/cust</th></tr></thead><tbody>
          {(C.byAcqType||[]).map((a,i)=>(<tr key={i}>
            <td>{a.type}</td><td>{NUM(a.newCustomers)}</td><td>{PCT(a.repeatRate)}</td><td>{a.ordersPerCust}</td><td>{GBP(a.lifetimeRevPerCust)}</td>
          </tr>))}
        </tbody></table>
        {(()=>{ const d=(C.byAcqType||[]).find(a=>/Discount/.test(a.type)), f=(C.byAcqType||[]).find(a=>/Full/.test(a.type));
          if(!d||!f) return null; const better = d.repeatRate>=f.repeatRate;
          return <div className="note" style={{marginTop:10}}>{better
            ? `Discount-acquired customers repeat at least as well (${PCT(d.repeatRate)} vs ${PCT(f.repeatRate)}) — the usual "discount buyers churn" worry doesn't hold here, so first-order codes look like a fair acquisition cost.`
            : `Discount-acquired customers repeat less (${PCT(d.repeatRate)} vs ${PCT(f.repeatRate)}) — those codes are buying lower-quality customers; tighten first-order discounting.`}</div>; })()}
      </div>
      <div className="card" style={{flex:'1 1 380px'}}>
        <h2 style={{marginTop:0}}>Which products acquire customers that come back</h2>
        <table><thead><tr><th>Acquisition product</th><th>New custs</th><th>Repeat</th><th>Lifetime £/cust</th></tr></thead><tbody>
          {(C.byProduct||[]).map((p,i)=>{ const hot=p.repeatRate>=(C.repeatRate*1.3); const cold=p.repeatRate<=(C.repeatRate*0.5);
            return (<tr key={i}>
              <td style={{maxWidth:200}}>{p.name}</td><td>{NUM(p.newCustomers)}</td>
              <td style={{color: hot?'var(--good)':cold?'#f87171':'var(--text-primary)', fontWeight:hot||cold?700:400}}>{PCT(p.repeatRate)}</td>
              <td>{GBP(p.lifetimeRevPerCust)}</td>
            </tr>); })}
        </tbody></table>
        <div className="note" style={{marginTop:10}}>Green = retains above the {PCT(C.repeatRate)} brand average (advertise these to acquire); red = acquires but doesn't retain (needs a follow-up flow, not more spend). Full acquisition-vs-retention matrix lands in the Products view.</div>
      </div>
    </div>

    <div className="micro" style={{color:'var(--text-faint)', marginTop:12, lineHeight:1.5}}>
      {C.notes && <><b>Read carefully:</b> {C.notes.channel} {C.notes.google}</>}
    </div>
  </div>);
}

// ── Advice → impact ledger (Phase 5.2) ───────────────────────────────────────
// Closes the loop: the recommendations marked done + what moved on the metrics
// each watches. The single most powerful trust feature — it proves OI's keep.
function AdviceLedgerPanel(){
  const S = (typeof window!=='undefined' && window.FRKL_ACTION_STATUS) || {};
  let local = {}; try { local = JSON.parse(localStorage.getItem('frkl-action-local-done')||'{}'); } catch(e){}
  const all = Object.keys(S).map(id=>({id, ...S[id]}));
  if(!all.length) return null;
  const done = all.filter(a=> a.status==='verified-done' || local[a.id])
                  .sort((a,b)=> ((local[b.id]&&local[b.id].completedDate)||b.resolvedAt||'').localeCompare((local[a.id]&&local[a.id].completedDate)||a.resolvedAt||''));
  const openN = all.filter(a=> a.status==='open').length;
  const fmtP = x => x==null ? '—' : (x>=0?'+':'')+(x*100).toFixed(0)+'%';
  return (<div className="card" style={{marginBottom:14, borderLeft:'3px solid var(--good)'}}>
    <div className="card-section-title">
      <h2 style={{margin:0}}>Track record — advice acted on</h2>
      <span className="meta">{done.length} actioned · {openN} open</span>
    </div>
    <div className="micro" style={{color:'var(--text-secondary)', marginBottom:10, lineHeight:1.5}}>
      Closing the loop: the recommendations you've marked done and what then moved on the metrics each one watches. (Impact is measured per watched metric; £-tagged impact lands once findings carry a £ value.)
    </div>
    {(()=>{
      // Only entries with a real recommendation are a "story". Without text there's
      // nothing to show — drop them rather than render an empty row.
      const rows = done.filter(a => (a.text||'').trim()).slice(0,12);
      if(!rows.length) return <div className="muted" style={{fontSize:13}}>No recommendations marked done yet — mark one from the action board and its measured impact appears here.</div>;
      const niceMetric = k => String(k||'').replace(/_/g,' ').replace(/\b30d\b/,'(30d)')
        .replace(/\broas\b/ig,'ROAS').replace(/\bmer\b/ig,'MER').replace(/\baov\b/ig,'AOV').replace(/\bcvr\b/ig,'CVR');
      // A movement only counts if it's meaningful (≥2%) and not a divide-by-tiny artifact (<300%).
      const movesOf = (impact) => impact ? Object.entries(impact)
        .filter(([k,v]) => v && v.deltaPct!=null && Math.abs(v.deltaPct)>=0.02 && Math.abs(v.deltaPct)<3)
        .sort((x,y)=>Math.abs(y[1].deltaPct)-Math.abs(x[1].deltaPct)) : [];
      return (<div style={{display:'flex', flexDirection:'column', gap:8}}>
        {rows.map(a=>{ const when=(local[a.id]&&local[a.id].completedDate)||(a.resolvedAt||'').slice(0,10);
          const moves = movesOf(a.impact);
          const watched = a.impact ? Object.keys(a.impact) : [];
          return (<div key={a.id} style={{padding:'8px 10px', background:'var(--bg-app)', border:'1px solid var(--border-subtle)', borderRadius:'var(--r-sm)'}}>
            <div style={{display:'flex', gap:8, alignItems:'baseline'}}>
              <span style={{color:'var(--good)', fontWeight:700}}>✓</span>
              <span style={{flex:1, fontSize:13, color:'var(--text-primary)'}}>{a.text}</span>
              {a.agent && <span className="micro" style={{color:'var(--text-faint)'}} title={agentTitle(a.agent)}>{a.agent}{agentRole(a.agent)?` · ${agentRole(a.agent)}`:''}</span>}
              {when && <span className="micro" style={{color:'var(--text-faint)'}}>{when}</span>}
            </div>
            {moves.length
              ? <div className="micro" style={{color:'var(--text-secondary)', marginTop:3, marginLeft:18}}>Since done: {moves.map(([k,v])=>`${niceMetric(k)} ${fmtP(v.deltaPct)}`).join(' · ')}</div>
              : (watched.length ? <div className="micro" style={{color:'var(--text-faint)', marginTop:3, marginLeft:18}}>Measuring — watching {watched.slice(0,2).map(niceMetric).join(', ')}; no clear move yet</div> : null)}
          </div>); })}
      </div>);
    })()}
  </div>);
}

// ── Stock-out spend throttle (Phase 4.1) ─────────────────────────────────────
// Joins critical stock cover to product velocity: top sellers about to run out
// are a reason to PULL paid demand, not push it.
function StockThrottlePanel(){
  const inv = (B && B.inventory) || [];
  if(!inv.length) return null;
  const risk = inv
    .filter(r => (r.coverTier==='critical' || r.coverTier==='low') && (r.units90d||0) >= 15 && (r.inventoryQty||0) > 0)
    .sort((a,b)=> (a.daysOfCover||999) - (b.daysOfCover||999))
    .slice(0, 6);
  if(!risk.length) return null;
  const critical = risk.filter(r=>r.coverTier==='critical');
  return (<div className="card" style={{marginBottom:14, borderLeft:'3px solid #f87171'}}>
    <div className="card-section-title">
      <h2 style={{margin:0, display:'inline-flex', alignItems:'center', gap:7}}><Icon name="alert" size={16} style={{color:'var(--bad)'}}/> Stock-out spend risk</h2>
      <StatusBadge kind={critical.length ? 'critical' : 'stock'} label={critical.length ? 'Critical' : 'Stock-constrained'}/>
      <span className="meta">top sellers running low — don't scale paid behind these</span>
    </div>
    <div style={{fontSize:14, lineHeight:1.5, color:'var(--text-primary)', fontWeight:500, marginBottom:10}}>
      {critical.length>0
        ? `${critical.length} top-selling SKU${critical.length>1?'s':''} will sell out within ~2 weeks at the current pace. Pull ${critical.length>1?'them':'it'} from featured ads & creative now — paying CAC for orders you can't fulfil burns cash and goodwill.`
        : `${risk.length} fast-moving SKU${risk.length>1?'s are':' is'} getting low on cover. Watch before scaling paid demand behind ${risk.length>1?'them':'it'}.`}
    </div>
    <table><thead><tr><th>SKU</th><th>Stock</th><th>Sold 90d</th><th>Days cover</th><th>Action</th></tr></thead><tbody>
      {risk.map((r,i)=>(<tr key={i}>
        <td style={{maxWidth:240}}><b>{(r.title||'').slice(0,40)}</b></td>
        <td>{NUM(r.inventoryQty)}</td>
        <td>{NUM(r.units90d)}</td>
        <td><span style={{color: r.coverTier==='critical'?'#f87171':'var(--warn)', fontWeight:700}}>{r.daysOfCover==null||r.daysOfCover===999?'∞':r.daysOfCover+'d'}</span></td>
        <td className="micro" style={{color:'var(--text-secondary)'}}>{r.coverTier==='critical'?'Pull from paid · reorder now':'Reorder + watch spend'}</td>
      </tr>))}
    </tbody></table>
  </div>);
}

// ── Creative fatigue → CPA causal chain (Phase 2.2) ──────────────────────────
// Joins frequency + CTR + CPA to answer the real question when CPA rises: is it
// creative fatigue (CTR falling as frequency climbs) or a conversion problem?
function CreativeFatiguePanel(){
  const rows = ((typeof window!=='undefined' && window.FRKL_DATA && window.FRKL_DATA.creatives) || []).filter(c=>(c.cost||0) > 0);
  if(rows.length < 4) return null;
  const FREQ = 5;
  const agg = grp => { const spend=grp.reduce((a,c)=>a+(c.cost||0),0), purch=grp.reduce((a,c)=>a+(c.purchases||0),0), atc=grp.reduce((a,c)=>a+(c.atc||0),0);
    return {n:grp.length, spend, purch, cpa: purch>0?spend/purch:null,
      ctr: spend>0 ? grp.reduce((a,c)=>a+(c.linkCtr||0)*(c.cost||0),0)/spend : null,   // spend-weighted CTR
      atcToP: atc>0 ? purch/atc : null}; };
  const F = agg(rows.filter(c=>(c.frequency||0)>=FREQ));
  const R = agg(rows.filter(c=>(c.frequency||0)<FREQ));
  if(!F.n || !R.n) return null;
  const ctrDrop = (R.ctr&&F.ctr!=null) ? (R.ctr-F.ctr)/R.ctr : null;
  const cpaUp = (R.cpa&&F.cpa!=null) ? (F.cpa-R.cpa)/R.cpa : null;
  const convSimilar = (F.atcToP!=null && R.atcToP!=null) ? Math.abs(F.atcToP-R.atcToP) <= R.atcToP*0.25 : null;
  const fatList = rows.filter(c=>(c.frequency||0)>=FREQ).sort((a,b)=>(b.cost||0)-(a.cost||0)).slice(0,5);
  // Report what's actually true. Fatigue = CTR meaningfully LOWER on high-freq ads.
  let headline, tone;
  if(ctrDrop!=null && ctrDrop>=0.10 && cpaUp!=null && cpaUp>0){
    tone='bad';
    headline = `Fatigue signal: ads past ${FREQ}× frequency run ${(ctrDrop*100).toFixed(0)}% lower CTR and ${(cpaUp*100).toFixed(0)}% higher CPA than fresh ones${convSimilar?' — but convert checkout-to-purchase about the same':''}. The CPA gap is ${convSimilar?'creative fatigue, not the offer':'driven by fatigue'} — refresh the hook before cutting budget.`;
  } else if(ctrDrop!=null && ctrDrop<=-0.05){
    tone='good';
    headline = `No fatigue signal yet — your highest-frequency ads actually hold the strongest CTR (${F.ctr!=null?(F.ctr*100).toFixed(2):'—'}% vs ${R.ctr!=null?(R.ctr*100).toFixed(2):'—'}% fresh): they're scaled because they work${cpaUp!=null&&cpaUp>0.1?`, though CPA is ${(cpaUp*100).toFixed(0)}% higher (a bidding/audience-cost effect, not creative)`:''}. Keep refreshing the rotation before frequency climbs past ~8×.`;
  } else {
    tone='neutral';
    headline = `${F.n} ad${F.n>1?'s are':' is'} above ${FREQ}× frequency. CTR and CPA are broadly in line with fresh ads — no clear fatigue signal, but queue new variants so the rotation stays fresh.`;
  }
  const Stat = ({label, fat, fresh, fmt}) => (
    <div className="card kpi" style={{flex:'1 1 200px'}}>
      <div className="label">{label}</div>
      <div style={{display:'flex', gap:14, marginTop:4}}>
        <div><div style={{fontSize:20, fontWeight:700, color:'#f87171'}}>{fmt(fat)}</div><div className="micro" style={{color:'var(--text-faint)'}}>fatigued ≥{FREQ}×</div></div>
        <div><div style={{fontSize:20, fontWeight:700, color:'var(--good)'}}>{fmt(fresh)}</div><div className="micro" style={{color:'var(--text-faint)'}}>fresh</div></div>
      </div>
    </div>);
  const toneCol = tone==='bad'?'#f87171':tone==='good'?'var(--good)':'var(--warn)';
  return (<div className="card" style={{marginBottom:14, borderLeft:'3px solid '+toneCol}}>
    <div className="card-section-title"><h2 style={{margin:0}}>Creative fatigue → CPA</h2><span className="meta">{F.n} above {FREQ}× · {R.n} fresh ads</span></div>
    <div style={{fontSize:14, lineHeight:1.5, color:'var(--text-primary)', fontWeight:500, marginBottom:10}}>{headline}</div>
    <div className="row" style={{marginBottom:6}}>
      <Stat label="CTR (link)" fat={F.ctr} fresh={R.ctr} fmt={v=>v!=null?(v*100).toFixed(2)+'%':'—'}/>
      <Stat label="CPA" fat={F.cpa} fresh={R.cpa} fmt={v=>v!=null?GBP(v):'—'}/>
      <Stat label="Cart→purchase" fat={F.atcToP} fresh={R.atcToP} fmt={v=>v!=null?PCT(v):'—'}/>
    </div>
    {fatList.length>0 && <div className="micro" style={{color:'var(--text-secondary)', marginTop:6}}>Refresh first (highest spend at high frequency): {fatList.map(c=>`${(c.name||'ad').slice(0,26)} (${(c.frequency||0).toFixed(1)}×)`).join(' · ')}</div>}
  </div>);
}

// ── Manual Clarity CSV upload (no backend) ───────────────────────────────────
// Until the daily Clarity sync is wired, let the founder paste / upload a CSV of
// the friction metrics off the Clarity dashboard. Tolerant key→value mapper:
// accepts "metric,value" rows OR a wide header+row export. Stored per-browser.
function splitCsvLine(line){
  const out=[]; let cur='', q=false;
  for(let i=0;i<line.length;i++){ const ch=line[i];
    if(q){ if(ch==='"'){ if(line[i+1]==='"'){cur+='"';i++;} else q=false; } else cur+=ch; }
    else { if(ch==='"') q=true; else if(ch===','){ out.push(cur.trim()); cur=''; } else cur+=ch; } }
  out.push(cur.trim()); return out;
}
function parseClarityCsv(text){
  const lines = String(text||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  if(!lines.length) return {ok:false, error:'The file looks empty.'};
  const rows = lines.map(splitCsvLine).filter(r=>r.length);
  const isNum = s => s!=null && s!=='' && isFinite(parseFloat(String(s).replace(/[£%,\s]/g,'')));
  const num = s => parseFloat(String(s).replace(/[£%,\s]/g,''));
  // Collect (label, value) pairs across layouts.
  let pairs = [];
  const kvRows = rows.filter(r=>r.length>=2 && isNum(r[1])).length;
  if(kvRows >= Math.max(2, rows.length*0.5)){
    rows.forEach(r=>{ if(r.length>=2 && isNum(r[1])) pairs.push([r[0], r[1]]); });
  } else {
    const header = rows[0]||[];
    const valRow = rows.slice(1).find(r=> r.filter(isNum).length >= Math.max(1, header.length*0.4));
    if(header.length && valRow) header.forEach((h,i)=>{ if(isNum(valRow[i])) pairs.push([h, valRow[i]]); });
    rows.forEach(r=>{ if(r.length===2 && isNum(r[1])) pairs.push([r[0], r[1]]); });
  }
  if(!pairs.length) return {ok:false, error:"Couldn't find any metric/number pairs. Use two columns: a metric name and its value."};
  const M = {}; const matched = [];
  pairs.forEach(([k,v])=>{ const key=String(k).toLowerCase(); const n=num(v); if(!isFinite(n)) return;
    const set=(f,label)=>{ if(M[f]==null){ M[f]=n; matched.push(label+': '+v); } };
    if(/pages?\s*\/?\s*(per\s*)?session|pages per/.test(key)) set('pps','Pages/session');
    else if(/scroll/.test(key)) set('scroll','Scroll depth');
    else if(/script\s*error|js\s*error|javascript/.test(key)) set('scriptError','JS-error %');
    else if(/dead\s*click/.test(key)) set('deadClick','Dead-click %');
    else if(/rage\s*click/.test(key)) set('rageClick','Rage-click %');
    else if(/quick\s*-?back/.test(key)) set('quickback','Quickback %');
    else if(/excessive\s*scroll/.test(key)) set('excessiveScroll','Excessive-scroll %');
    else if(/error\s*click/.test(key)) set('errorClick','Error-click %');
    else if(/active|engage/.test(key)) set('active','Active engagement %');
    else if(/distinct|unique\s*user/.test(key)) set('users','Distinct users');
    else if(/bot/.test(key)) set('bots','Bot sessions');
    else if(/session/.test(key)) set('sessions','Sessions');
  });
  if(!matched.length) return {ok:false, error:"None of the rows matched a known Clarity metric. Check the metric names (e.g. 'Scroll depth', 'JS error %', 'Dead clicks')."};
  const activeFrac = M.active==null ? null : (M.active>1 ? M.active/100 : M.active);
  const friction = {
    scriptError:{pct:M.scriptError??null, count:M.scriptErrorCount??0},
    errorClick:{pct:M.errorClick??null}, deadClick:{pct:M.deadClick??null},
    quickback:{pct:M.quickback??null}, rageClick:{pct:M.rageClick??null},
    excessiveScroll:{pct:M.excessiveScroll??null},
  };
  const flags=[];
  if(M.scriptError!=null && M.scriptError>=10) flags.push({sev:'high', text:`${M.scriptError.toFixed(0)}% of sessions hit a JavaScript error — a likely conversion blocker. Reproduce the top error before scaling spend.`});
  if(M.pps!=null && M.pps<1.5) flags.push({sev:'high', text:`Only ${M.pps.toFixed(2)} pages per session — visitors land and leave without browsing. A landing/PDP problem, not a traffic one.`});
  if(M.scroll!=null && M.scroll<50) flags.push({sev:'med', text:`Average scroll depth is ${M.scroll.toFixed(0)}% — content + product below that point is essentially unseen.`});
  if(M.errorClick!=null && M.errorClick>=2) flags.push({sev:'med', text:`${M.errorClick.toFixed(1)}% of sessions click something broken (error clicks) — usually a dead button or failing widget.`});
  if(M.deadClick!=null && M.deadClick>=3) flags.push({sev:'med', text:`${M.deadClick.toFixed(1)}% of sessions register dead clicks — taps that do nothing, a sign of confusing or broken UI.`});
  if(activeFrac!=null && activeFrac<0.5) flags.push({sev:'low', text:`Active engagement is ${(activeFrac*100).toFixed(0)}% of time on site — attention drops fast; tighten above-the-fold.`});
  const today = (()=>{ try{ return new Date().toISOString().slice(0,10); }catch(e){ return ''; } })();
  return {ok:true, matched, bundle:{
    available:true, source:'manual', asOf:today, uploadedAt:today,
    sessions:M.sessions??null, botSessions:M.bots??0, distinctUsers:M.users??null,
    pagesPerSession:M.pps??null, scrollDepth:M.scroll??null,
    engagement:{activePct:activeFrac}, friction, flags,
    notes:{window:'Manually uploaded — re-upload a newer Clarity export to refresh.'},
  }};
}
function clarityManualGet(){ try{ const s=JSON.parse(localStorage.getItem('oi_clarity_manual')||'null'); return (s&&s.available)?s:null; }catch(e){ return null; } }
function clarityManualSave(b){ try{ localStorage.setItem('oi_clarity_manual', JSON.stringify(b)); }catch(e){} }
function clarityManualClear(){ try{ localStorage.removeItem('oi_clarity_manual'); }catch(e){} }
function clarityResolve(){ return clarityManualGet() || ((typeof window!=='undefined' && window.FRKL_CLARITY) || null); }

const CLARITY_TEMPLATE = `metric,value
Sessions,4200
Pages per session,1.42
Scroll depth,46
JS error %,12
Dead click %,3.1
Rage click %,1.2
Error click %,2.4
Quickback %,8
Active engagement %,41`;

function ClarityUploadModal({onClose, onSaved}){
  const [text, setText] = React.useState('');
  const [res, setRes] = React.useState(null);   // {ok, bundle, matched} | {ok:false,error}
  const onFile = (e)=>{ const f=e.target.files&&e.target.files[0]; if(!f) return;
    const r=new FileReader(); r.onload=()=>{ const t=String(r.result||''); setText(t); setRes(parseClarityCsv(t)); }; r.readAsText(f); };
  const parseNow = ()=> setRes(parseClarityCsv(text));
  const save = ()=>{ if(res&&res.ok){ clarityManualSave(res.bundle); toast('Clarity data uploaded',{kind:'good', body:`${res.matched.length} metric${res.matched.length===1?'':'s'} mapped.`}); onSaved&&onSaved(); onClose(); } };
  return (<div className="modal-bg" onClick={onClose}>
    <div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:560}}>
      <h3>Upload Microsoft Clarity data</h3>
      <div className="micro" style={{color:'var(--text-secondary)', lineHeight:1.5, marginBottom:10}}>
        Read the headline numbers off your Clarity dashboard into a two-column CSV (<b>metric, value</b>), then drop the file or paste it below. Percentages can include the % sign. Stored in this browser.
      </div>
      <label>Upload a .csv</label>
      <input type="file" accept=".csv,text/csv,text/plain" onChange={onFile} style={{margin:'4px 0 12px'}}/>
      <label>…or paste CSV</label>
      <textarea value={text} onChange={e=>setText(e.target.value)} rows={7} placeholder={CLARITY_TEMPLATE}
        style={{width:'100%', margin:'4px 0 6px', padding:'9px 11px', background:'var(--bg-input)', border:'1px solid var(--border-default)', borderRadius:6, color:'var(--text-primary)', fontSize:12.5, fontFamily:'ui-monospace,Menlo,monospace', resize:'vertical'}}/>
      <div style={{display:'flex', gap:8, alignItems:'center', marginBottom:10}}>
        <button onClick={parseNow}>Preview</button>
        <button className="btn-ghost" onClick={()=>{ try{navigator.clipboard.writeText(CLARITY_TEMPLATE);}catch(e){} toast('Template copied',{body:'Paste into a spreadsheet, fill the values.'}); }}>Copy template</button>
      </div>
      {res && !res.ok && <div className="note" style={{borderLeft:'3px solid var(--bad)', marginBottom:10, fontSize:12.5}}>{res.error}</div>}
      {res && res.ok && <div className="note" style={{borderLeft:'3px solid var(--good)', marginBottom:10, fontSize:12.5}}>
        Mapped {res.matched.length} metric{res.matched.length===1?'':'s'}: {res.matched.join(' · ')}</div>}
      <div className="row">
        <button className="primary" disabled={!(res&&res.ok)} onClick={save} style={{opacity:(res&&res.ok)?1:0.5}}>Save &amp; show</button>
        {clarityManualGet() && <button className="btn-ghost" onClick={()=>{ clarityManualClear(); toast('Manual Clarity data cleared'); onSaved&&onSaved(); onClose(); }}>Clear uploaded data</button>}
        <button onClick={onClose} style={{marginLeft:'auto'}}>Cancel</button>
      </div>
    </div>
  </div>);
}

// ── Clarity site friction (Phase 3.3) ────────────────────────────────────────
// The "it's the SITE, not the media" evidence: script errors, broken clicks,
// quick-backs, scroll depth, traffic quality. Surfaced on CVR drivers + Site.
function ClarityFrictionPanel(){
  const [tick, setTick] = React.useState(0);
  const [upload, setUpload] = React.useState(false);
  const C = clarityResolve(); void tick;
  const uploader = upload && <ClarityUploadModal onClose={()=>setUpload(false)} onSaved={()=>setTick(t=>t+1)}/>;
  if(!C || !C.available) return (<div className="card" style={{marginBottom:14}}>
    <EmptyState icon="info"
      title="No Microsoft Clarity data yet"
      body="Clarity shows whether the site itself is the conversion bottleneck — JavaScript errors, dead/rage clicks, scroll depth and engagement. The daily sync isn't wired yet, so upload a quick CSV of the headline numbers from your Clarity dashboard to light this up."
      cta="Upload Clarity CSV" ctaOnClick={()=>setUpload(true)}/>
    {uploader}
  </div>);
  const manual = C.source==='manual';
  const f = C.friction || {};
  const sev = s => s==='high'?'#f87171':s==='med'?'var(--warn)':'var(--text-muted)';
  const tiles = [
    {label:'Sessions w/ JS error', val: f.scriptError.pct!=null?f.scriptError.pct.toFixed(0)+'%':'—', bad: (f.scriptError.pct||0)>=10, sub: f.scriptError.count?`${NUM(f.scriptError.count)} script errors`:'of sessions hit a JS error'},
    {label:'Pages / session',      val: C.pagesPerSession!=null?C.pagesPerSession.toFixed(2):'—', bad:(C.pagesPerSession||9)<1.5, sub:'land-and-leave if < 1.5'},
    {label:'Avg scroll depth',     val: C.scrollDepth!=null?C.scrollDepth+'%':'—', bad:(C.scrollDepth||100)<50, sub:'content below is unseen'},
    {label:'Error clicks',         val: f.errorClick.pct!=null?f.errorClick.pct.toFixed(1)+'%':'—', bad:(f.errorClick.pct||0)>=2, sub:'clicks on broken elements'},
    {label:'Dead clicks',          val: f.deadClick.pct!=null?f.deadClick.pct.toFixed(1)+'%':'—', bad:(f.deadClick.pct||0)>=3, sub:'clicks that do nothing'},
    {label:'Active engagement',    val: C.engagement.activePct!=null?PCT(C.engagement.activePct):'—', bad:(C.engagement.activePct||1)<0.5, sub:'share of time actually active'},
  ];
  return (<div className="card" style={{marginBottom:14, borderLeft:'3px solid #f87171'}}>
    {uploader}
    <div className="card-section-title">
      <h2 style={{margin:0}}>Site friction — is the site the bottleneck?</h2>
      <span className="meta" style={{display:'inline-flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
        <span>Microsoft Clarity · {C.sessions!=null?NUM(C.sessions)+' sessions · ':''}{manual?`manual upload · ${C.asOf}`:`${C.windowDays||C.days}d window · as of ${C.asOf}`}</span>
        <button className="cf-btn" onClick={()=>setUpload(true)}><Icon name="clipboard" size={12}/>{manual?'Replace data':'Upload CSV'}</button>
      </span>
    </div>
    {!manual && C.thinData && (<div className="note" style={{marginBottom:10, borderLeft:'3px solid var(--warn)'}}>
      ⚠ Only {C.windowDays||C.days} days of Clarity data — these are <b>medium-confidence, directional</b> signals (capped: none shown as high). Reproduce a flagged issue before committing dev time; the picture firms up as the window grows past a week.
    </div>)}
    {C.flags && C.flags.length>0 && (<div style={{display:'flex', flexDirection:'column', gap:6, marginBottom:10}}>
      {C.flags.map((fl,i)=>(<div key={i} style={{display:'flex', gap:8, alignItems:'baseline', fontSize:13.5}}>
        <span style={{color:sev(fl.sev), fontWeight:700}}>{fl.sev==='high'?'▲':'•'}</span>
        <span style={{color:'var(--text-secondary)'}}>{fl.text}</span>
      </div>))}
    </div>)}
    <div className="board-grid">
      {tiles.map((t,i)=>(<div key={i} className="card board-card" style={{borderLeft:'3px solid '+(t.bad?'#f87171':'var(--border-default)')}}>
        <div className="micro" style={{color:'var(--text-muted)', fontWeight:600}}>{t.label}</div>
        <div style={{fontSize:22, fontWeight:700, margin:'4px 0 2px', color:t.bad?'#f87171':'var(--text-primary)'}}>{t.val}</div>
        <div className="micro" style={{color:'var(--text-faint)'}}>{t.sub}</div>
      </div>))}
    </div>
    <div className="note" style={{marginTop:12}}>When a quarter of sessions hit a JS error and visitors see ~1 page before leaving, more ad spend just buys more bounces. <b>Fix the site before scaling paid.</b> {C.notes && C.notes.window}</div>
  </div>);
}

// ── Predictive retention (Phase 3.1) ─────────────────────────────────────────
// Turns "retention is the lever" into a weekly worklist: median repurchase
// interval → due / overdue / lapsed segments with £ at stake + the products that
// drive the fastest repeat. Advisory — tells the operator WHEN to nudge.
function RetentionPanel(){
  const R = (typeof window!=='undefined' && window.FRKL_RETENTION) || null;
  if(!R || !R.customers) return null;
  const seg = R.segments || {};
  const med = R.medianIntervalDays;
  const SEG = [
    {k:'due',     label:'Due now',  col:'var(--good)',  desc:'in the reorder window — nudge now'},
    {k:'overdue', label:'Overdue',  col:'var(--warn)',  desc:'past their window — slipping, win back'},
    {k:'lapsed',  label:'Lapsed',   col:'#f87171',      desc:'>150 days — deep win-back'},
  ];
  return (<div className="card" style={{marginBottom:14, borderLeft:'3px solid var(--accent)'}}>
    <div className="card-section-title">
      <h2 style={{margin:0}}>Retention worklist — who to nudge, and when</h2>
      <span className="meta">median reorder interval {med} days · ~{R.repeatCustomers} repeat customers</span>
    </div>
    <div className="micro" style={{color:'var(--text-secondary)', marginBottom:10, lineHeight:1.55}}>
      Repeat customers reorder about every <b>{med} days</b> (p25 {R.p25} / p75 {R.p75}). That's your replenishment trigger — a flow firing around day {med} catches customers at peak intent. <b style={{color:'var(--text-primary)'}}>{GBP(R.atStake)}</b> of <b>realistically recoverable</b> reorder value is in the due + overdue pools{R.atStakeGross?<span> (the {GBP(R.atStakeGross)} gross × your {Math.round((R.repeatRate||0)*100)}% repeat rate — most overdue customers won't return)</span>:null}.
    </div>
    <div className="row" style={{marginBottom:10}}>
      <div className="card kpi" style={{borderLeft:'3px solid var(--accent)'}}>
        <div className="label">This week's nudge list</div>
        <div className="val" style={{fontSize:24}}>{NUM(R.worklist.count)}</div>
        <div className="sub">customers entering their reorder window · {GBP(R.worklist.recoverable!=null?R.worklist.recoverable:R.worklist.value)} recoverable</div>
      </div>
      {SEG.map(s=>{ const v=seg[s.k]||{count:0,value:0}; return (
        <div key={s.k} className="card kpi" style={{borderLeft:'3px solid '+s.col}}>
          <div className="label">{s.label}</div>
          <div className="val" style={{fontSize:24}}>{NUM(v.count)}</div>
          <div className="sub">{GBP(v.recoverable!=null?v.recoverable:v.value)} recoverable{v.recoverable!=null&&v.value?<span style={{color:'var(--text-faint)'}}> of {GBP(v.value)} gross</span>:null} · {s.desc}</div>
        </div>); })}
    </div>
    {(R.byProduct||[]).length>0 && (<div>
      <h3 style={{margin:'4px 0 6px', fontSize:13, color:'var(--text-muted)'}}>Products that drive the fastest repeat <span style={{fontWeight:400,color:'var(--text-faint)'}}>— build replenishment around these</span></h3>
      <div style={{display:'flex', flexWrap:'wrap', gap:8}}>
        {R.byProduct.slice(0,6).map((p,i)=>(<span key={i} className="pill" style={{background:'var(--accent-bg)', color:'var(--accent)', fontSize:11.5, padding:'4px 10px', borderRadius:'var(--r-full)'}}>{p.name} · {p.medianInterval}d</span>))}
      </div>
    </div>)}
    <div className="note" style={{marginTop:12}}>Action: set a Klaviyo replenishment flow to fire at ~day {Math.max(7, med-3)} post-purchase, and a win-back flow at day {Math.round(med*2)} for the overdue pool. {R.notes && R.notes.thin}</div>
  </div>);
}

// ── Margin bridge (Phase 1.2) ────────────────────────────────────────────────
// Why did contribution move vs the prior period — even if MER held? A waterfall
// that decomposes Δ(fully-loaded contribution) into volume, price, discounting,
// returns and paid media. Built as an exactly-reconciling sequential walk (change
// one driver prior→current at a time, recompute contribution), so the bars ALWAYS
// sum to the real change. Uses the operator's verified costs (Phase 0.1).
function MarginBridge({cur, pri, gm, perOrderFixed, payPct}){
  const verified = useCostTick();
  if(!cur || !pri || !pri.orders || !cur.orders) return null;
  const netRev = s => s.orders * (s.grossAOV - s.discPO - s.retPO);
  const C = s => netRev(s)*s.gm - (s.orders*perOrderFixed + netRev(s)*payPct) - s.paid;
  const stOf = o => ({orders:o.orders, grossAOV:o.grossMerch/o.orders, discPO:o.disc/o.orders, retPO:o.returns/o.orders, gm:gm, paid:o.paid});
  let s = stOf(pri); const C0 = C(s); const target = stOf(cur);
  const steps = [];
  const apply = (label, patch) => { const before=C(s); s={...s, ...patch}; steps.push({label, delta:C(s)-before}); };
  apply('Volume',      {orders:target.orders});
  apply('AOV / price', {grossAOV:target.grossAOV});
  apply('Discounting', {discPO:target.discPO});
  apply('Returns',     {retPO:target.retPO});
  apply('Paid media',  {paid:target.paid});
  const Cc = C(s);
  const shown = steps.filter(x=>Math.abs(x.delta) >= Math.max(1, Math.abs(Cc-C0)*0.01));
  let run = C0;
  const rows = [{name:'Prior', total:C0}];
  shown.forEach(x=>{ rows.push({name:x.label, delta:x.delta, from:run, to:run+x.delta}); run += x.delta; });
  rows.push({name:'Now', total:Cc});
  const data = rows.map(r=>{
    if(r.total!=null) return {name:r.name, base:Math.min(0,r.total), pos:Math.max(0,r.total), neg:Math.max(0,-r.total), amt:r.total, isTotal:true};
    const lo=Math.min(r.from,r.to); return {name:r.name, base:lo, pos:r.delta>=0?r.delta:0, neg:r.delta<0?-r.delta:0, amt:r.delta, isTotal:false};
  });
  const delta = Cc - C0, dpct = C0!==0 ? delta/Math.abs(C0) : null;
  const Tip = ({active, payload}) => { if(!active||!payload||!payload.length) return null; const d=payload[0].payload;
    return (<div style={{background:'var(--bg-elevated)',border:'1px solid var(--border-default)',borderRadius:10,padding:'7px 10px',fontSize:12}}>
      <div style={{fontWeight:700}}>{d.name}</div>
      <div style={{color: d.isTotal?'var(--text-secondary)':(d.amt>=0?'var(--good)':'#f87171')}}>{d.isTotal?GBP(d.amt):(d.amt>=0?'+':'−')+GBP(Math.abs(d.amt))}</div>
    </div>); };
  // £ label above each bar — small steps on a big base are unreadable by height, so
  // we show the number. (recharts-text class lets the light-theme override recolour it.)
  const segLabel = (which)=>(p)=>{ const d=data[p.index]||{}; if(!(d[which]>0)) return null;   // only the row's real segment
    const txt = d.isTotal ? GBP(d.amt) : ((d.amt>=0?'+':'−')+GBP(Math.abs(d.amt)));
    return (<text className="recharts-text" x={(p.x||0)+(p.width||0)/2} y={(p.y||0)-5} textAnchor="middle" fontSize="10.5" fontWeight="600" fill="#aab0bd">{txt}</text>); };
  return (<div className="card" style={{marginBottom:14}}>
    <div className="card-section-title">
      <h2 style={{margin:0}}>Why contribution moved <span style={{fontWeight:400,color:'var(--text-faint)',fontSize:13}}>— vs prior period</span></h2>
      <span className="meta" style={{display:'inline-flex',alignItems:'center',gap:6}}><MarginBadge/> {delta>=0?'+':'−'}{GBP(Math.abs(delta))}{dpct!=null?` (${(dpct>=0?'+':'')}${(dpct*100).toFixed(0)}%)`:''}</span>
    </div>
    <R.ResponsiveContainer width="100%" height={260}>
      <R.BarChart data={data} margin={{top:24,right:16,left:10,bottom:6}}>
        <R.CartesianGrid stroke="#1f1f27" vertical={false}/>
        <R.XAxis dataKey="name" tick={{fill:'#7e7e8a',fontSize:11}} interval={0}/>
        <R.YAxis tick={{fill:'#7e7e8a',fontSize:11}} tickFormatter={v=>'£'+(Math.abs(v)>=1000?(v/1000).toFixed(0)+'k':v)}/>
        <R.Tooltip cursor={{fill:'#ffffff08'}} content={<Tip/>}/>
        <R.Bar dataKey="base" stackId="s" fill="transparent" isAnimationActive={false}/>
        <R.Bar dataKey="pos" stackId="s" isAnimationActive={false}>{data.map((d,i)=><R.Cell key={i} fill={d.isTotal?'#7c8cff':'#4ade80'}/>)}<R.LabelList content={segLabel('pos')}/></R.Bar>
        <R.Bar dataKey="neg" stackId="s" fill="#f87171" isAnimationActive={false}><R.LabelList content={segLabel('neg')}/></R.Bar>
      </R.BarChart>
    </R.ResponsiveContainer>
    <div className="micro" style={{color:'var(--text-faint)',marginTop:4}}>Fully-loaded contribution = net revenue × {PCT(gm)} margin − variable costs − paid media. Bars sum exactly to the change; green helped, red hurt.</div>
    <ChartFooter note="Which lever moved contribution most this period — and was it volume, margin, or spend?"
      ask="From the contribution bridge, what drove the change in contribution most, and is it something I can act on?"
      rows={rows} columns={[{key:'name',label:'Driver'},{key:'delta',label:'Δ contribution',right:true,fmt:(v,r)=>r.total!=null?GBP(r.total):(v>=0?'+':'−')+GBP(Math.abs(v))}]}/>
  </div>);
}

// ── Acquisition-vs-retention product matrix (Phase 1.3) ──────────────────────
// From the cohort engine: which first products bring customers who come BACK
// (retainers) vs once-and-done (acquirers). Joined to a media action per quadrant.
function MatrixTip({active, payload}){
  if(!active || !payload || !payload.length) return null;
  const d = payload[0].payload;
  return (<div style={{background:'var(--bg-elevated)', border:'1px solid var(--border-default)', borderRadius:10, padding:'8px 10px', fontSize:12, boxShadow:'var(--shadow-md)', color:'var(--text-primary)'}}>
    <div style={{fontWeight:700, marginBottom:3}}>{d.name}</div>
    <div style={{color:'var(--text-secondary)'}}>{NUM(d.buyers)} buyers · {NUM(d.y)} acquired on 1st order</div>
    <div style={{color:'var(--text-secondary)'}}>Repeat {(d.repeat*100).toFixed(0)}% · LTV {GBP(d.ltv)}/cust</div>
  </div>);
}
function ProductRetentionMatrix(){
  const verified = useCostTick();
  const C = (typeof window!=='undefined' && window.FRKL_COHORTS) || null;
  const M = (C && C.productMatrix) || [];
  if(!M.length) return null;
  const gm = oiGrossMargin();
  const brandRep = (C.brandRepeatRate || 0) * 100;
  const acqSorted = M.map(p=>p.acquired).sort((a,b)=>a-b);
  const medAcq = acqSorted[Math.floor(acqSorted.length/2)] || 0;
  const pts = M.map(p=>({ x:+(p.retentionRate*100).toFixed(1), y:p.acquired, z:Math.max(1,Math.round(p.lifetimeRevPerCust*gm)),
    name:p.name, repeat:p.retentionRate, ltv:p.lifetimeRevPerCust, buyers:p.buyers }));
  const QMETA = {
    hero:  {label:'Heroes',          col:'#4ade80', action:'acquire AND retain — advertise & feature these'},
    gem:   {label:'Hidden gems',     col:'#38bdf8', action:'retain but few find them — scale acquisition'},
    leaky: {label:'Leaky acquirers', col:'#f4a23b', action:"bring customers who don't return — add a post-purchase / cross-sell flow, not more spend"},
    tail:  {label:'Long tail',       col:'#8b8b99', action:'low volume + low retention — deprioritise'},
  };
  const groups = {hero:[], gem:[], leaky:[], tail:[]};
  pts.forEach(p=>{ const hiR=p.x>=brandRep, hiV=p.y>=medAcq; groups[hiR&&hiV?'hero':hiR&&!hiV?'gem':!hiR&&hiV?'leaky':'tail'].push(p); });
  const rxMax = pts.length ? Math.max(...pts.map(p=>p.x)) : 100;
  const ryMax = pts.length ? Math.max(...pts.map(p=>p.y)) : 100;
  const z = useChartZoom(0, +((rxMax*1.08)||1).toFixed(2), 0, Math.ceil((ryMax*1.12)||1));
  return (<div className="card" style={{marginBottom:14}}>
    <div className="card-section-title">
      <h2 style={{margin:0}}>Which products acquire vs retain</h2>
      <span className="meta">repeat rate × customers acquired · bubble = contribution LTV/customer</span>
    </div>
    <div className="micro" style={{color:'var(--text-secondary)', marginBottom:8, lineHeight:1.5}}>
      Almost every frkl product is bought on a customer's <b>first</b> order, so the catalogue is acquisition-led across the board and <b>retention is the gap</b>. Below: which first products bring customers who come <i>back</i> (right) vs once-and-done (left). Dashed lines = brand-average repeat ({brandRep.toFixed(0)}%) and median acquisition volume.
    </div>
    <div {...z.bind}>
    <ZoomControls z={z}/>
    <R.ResponsiveContainer width="100%" height={330}>
      <R.ScatterChart margin={{top:10,right:24,left:6,bottom:26}}>
        <R.CartesianGrid stroke="#1f1f27"/>
        <R.XAxis type="number" dataKey="x" name="Retention" unit="%" domain={[z.view[0],z.view[1]]} allowDataOverflow tickFormatter={niceTick} tick={{fill:'#7e7e8a',fontSize:11}}
          label={{value:'Repeat rate of acquired customers →', position:'insideBottom', offset:-14, fill:'#6f6f7b', fontSize:11}}/>
        <R.YAxis type="number" dataKey="y" name="Acquired" domain={[z.view[2],z.view[3]]} allowDataOverflow tickFormatter={niceTick} tick={{fill:'#7e7e8a',fontSize:11}}
          label={{value:'Customers acquired', angle:-90, position:'insideLeft', style:{textAnchor:'middle'}, fill:'#6f6f7b', fontSize:11}}/>
        <R.ZAxis type="number" dataKey="z" range={[50,520]} name="LTV"/>
        <R.ReferenceLine x={brandRep} stroke="#5a5a66" strokeDasharray="4 3"/>
        <R.ReferenceLine y={medAcq} stroke="#5a5a66" strokeDasharray="4 3"/>
        <R.Tooltip cursor={{strokeDasharray:'3 3'}} content={<MatrixTip/>}/>
        {['hero','gem','leaky','tail'].map(k=> groups[k].length ? <R.Scatter key={k} name={QMETA[k].label} data={groups[k]} fill={QMETA[k].col} fillOpacity={0.78}/> : null)}
      </R.ScatterChart>
    </R.ResponsiveContainer>
    <div style={{fontSize:10.5,color:'var(--text-faint)',textAlign:'right',marginTop:2}}>{ZOOM_HINT}</div>
    </div>
    <div className="row" style={{marginTop:6, gap:10}}>
      {['hero','leaky','gem','tail'].map(k=> groups[k].length ? (
        <div key={k} style={{flex:'1 1 200px', fontSize:11.5, lineHeight:1.45}}>
          <div style={{fontWeight:700, color:QMETA[k].col}}>● {QMETA[k].label} ({groups[k].length})</div>
          <div style={{color:'var(--text-faint)', marginBottom:3}}>{QMETA[k].action}</div>
          <div style={{color:'var(--text-secondary)'}}>{groups[k].slice().sort((a,b)=>b.y-a.y).slice(0,3).map(p=>p.name).join(' · ')}</div>
        </div>) : null)}
    </div>
  </div>);
}

// ── Two-level navigation: section → subTab ──────────────────────────────────
// 5 top-level sections, each with its own sub-pages. Premium SaaS pattern.
// Sub-pages render contextual sub-nav when the section has >1 page.
// Dedicated Actions page — the action queue as a first-class destination.
// ── Restock action queue — stock-ordering notifications + PO lifecycle ───────
// Surfaces "raise a PO" as an action; once raised it leaves the to-do list and
// moves to a quiet "awaiting stock" state that auto-closes when Shopify stock
// rises. The whole point: never remind the user to do something already done.
function RestockActionQueue(){
  usePlanningTick();
  const [showAllToOrder,setShowAllToOrder]=useState(false);
  const R = planReorder();
  const {toOrder, awaiting, oosNow, ackPending} = R;
  const ackKeys = Object.keys(ackPending||{});
  React.useEffect(()=>{ if(ackKeys.length){ ackKeys.forEach(key=>clearPoStatus(key)); toast('Stock landed', {kind:'good', body:`${ackKeys.length} PO${ackKeys.length>1?'s':''} closed — stock is back in Shopify.`}); } }, [ackKeys.join(',')]);
  if(!toOrder.length && !awaiting.length) return null;

  const k = v=>{ v=Math.abs(Math.round(v)); return v>=1000?(v/1000).toFixed(v>=10000?0:1).replace(/\.0$/,'')+'k':''+v; };
  const btn = {display:'inline-flex',alignItems:'center',gap:5,fontSize:11.5,fontWeight:600,padding:'5px 11px',borderRadius:7,border:'1px solid var(--border-default)',background:'var(--bg-elevated)',color:'var(--text-primary)',cursor:'pointer',whiteSpace:'nowrap'};
  const raise = (l)=>{ setPoStatus(l.key, {status:'ordered', qty:l.qty, raisedAt:oiToday(), baselineQty:l.p.inventoryQty||0, lead:l.lead, supplier:l.supplier, title:l.p.title}); toast('PO marked raised', {kind:'good', body:l.p.title+' · awaiting stock'}); };

  return (<div className="card" style={{marginBottom:14, borderLeft:'3px solid '+(toOrder.length?'var(--warn)':'var(--accent)')}}>
    <div className="card-section-title" style={{marginBottom:6}}>
      <h2 style={{margin:0}}>Stock &amp; purchasing</h2>
      <span className="meta">{oosNow>0?<b style={{color:'var(--bad)'}}>{oosNow} order today</b>:null}{oosNow>0?' · ':''}{toOrder.length} to order{awaiting.length?` · ${awaiting.length} awaiting stock`:''} · Atlas · finance &amp; commercial</span>
    </div>

    {toOrder.length>0 ? (<div style={{display:'flex',flexDirection:'column',gap:7}}>
      {/* Urgent (OOS-before-lead) rows always show; the non-urgent tail collapses to keep the queue scannable. */}
      {(showAllToOrder ? toOrder : toOrder.filter(l=>l.oosBeforeLead)).slice(0,12).map((l,idx)=>{ const urgent=l.oosBeforeLead;
        return (<div key={idx} style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',padding:'8px 0',borderTop:idx?'1px solid var(--border-subtle)':'none'}}>
          <span style={{width:8,height:8,borderRadius:'50%',background:urgent?'var(--bad)':'var(--warn)',flexShrink:0}}/>
          <div style={{flex:1,minWidth:200}}>
            <div style={{fontSize:13,color:'var(--text-primary)'}}>{l.basis==='forecast'?'Order for forecast':'Raise PO'} — <b>{NUM(l.qty)} units</b> of {l.p.title}{urgent && <span style={{marginLeft:6,fontSize:9.5,fontWeight:800,letterSpacing:'.03em',color:'#fff',background:'var(--bad)',padding:'1px 7px',borderRadius:999}}>ORDER TODAY</span>}</div>
            <div style={{fontSize:11,color:'var(--text-faint)',marginTop:1}}>{l.supplier} · {urgent?`OOS in ~${Math.round(l.cover)}d — ${l.oosGap}d short of the ${l.lead}d lead`:(l.basis==='forecast'?`plan needs ${NUM(l.forecastUnits)}, have ${NUM(l.stock)}`:`runs out in ~${Math.round(l.cover)}d (lead ${l.lead}d)`)}{l.lineCost!=null?` · ~£${k(l.lineCost)}`:''}{l.moqBumped?` · MOQ ${l.moq}`:''}</div>
          </div>
          <button style={{...btn,background:'var(--accent)',color:'#fff',borderColor:'var(--accent)'}} onClick={()=>raise(l)}><Icon name="check" size={12}/> Mark PO raised</button>
          <button style={btn} onClick={()=>window.__oiNav&&window.__oiNav('planning','plan')}>Open planner</button>
        </div>); })}
      {(()=>{ const rest=toOrder.filter(l=>!l.oosBeforeLead); if(!rest.length) return null;
        if(!showAllToOrder){ const restVal=rest.reduce((a,l)=>a+(l.lineCost||0),0); return (<button onClick={()=>setShowAllToOrder(true)} style={{...btn,alignSelf:'flex-start',marginTop:4}}>Show {rest.length} more to order{restVal>0?` · ~£${k(restVal)}`:''}</button>); }
        return (<a className="txt-link" onClick={()=>setShowAllToOrder(false)} style={{cursor:'pointer',fontSize:11.5,marginTop:4,alignSelf:'flex-start'}}>Show less</a>); })()}
      {showAllToOrder && toOrder.length>12 && <div style={{fontSize:11.5,color:'var(--text-faint)',paddingTop:6}}><a className="txt-link" onClick={()=>window.__oiNav&&window.__oiNav('planning','plan')} style={{cursor:'pointer'}}>+ {toOrder.length-12} more in the planner</a></div>}
    </div>) : <div className="muted" style={{fontSize:12.5,padding:'2px 0'}}>Nothing to order right now — {awaiting.length} PO{awaiting.length===1?'':'s'} awaiting stock below.</div>}

    {awaiting.length>0 && (<div style={{marginTop:12,paddingTop:10,borderTop:'1px solid var(--border-subtle)'}}>
      <div style={{fontSize:11,fontWeight:700,letterSpacing:'.04em',textTransform:'uppercase',color:'var(--text-faint)',marginBottom:6}}>Awaiting stock · already ordered</div>
      <div style={{display:'flex',flexDirection:'column',gap:6}}>
        {awaiting.map((l,idx)=>(<div key={idx} style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',fontSize:12}}>
          <Icon name="check" size={13} style={{color:'var(--accent)',flexShrink:0}}/>
          <span style={{flex:1,minWidth:180,color:'var(--text-secondary)'}}>{NUM((l.po&&l.po.qty)||l.qty)} × {l.p.title} <span style={{color:'var(--text-faint)'}}>· expected ~{l.expected||'?'}{l.overdue?' · overdue, chase supplier':''}</span></span>
          <button style={{...btn,padding:'3px 9px'}} onClick={()=>{ setPoStatus(l.key,{status:'received', baselineQty:l.p.inventoryQty||0, receivedAt:oiToday()}); toast('Marked received', {kind:'good', body:l.p.title}); }}>Received</button>
          <button style={{...btn,padding:'3px 9px',background:'transparent',color:'var(--text-muted)'}} onClick={()=>{ clearPoStatus(l.key); toast('PO cancelled', {body:l.p.title}); }}>Cancel</button>
        </div>))}
      </div>
      <div style={{fontSize:11,color:'var(--text-faint)',marginTop:8,lineHeight:1.5}}>You won't be reminded about these again. Each auto-closes when its stock comes back up — Shopify inventory for products, your on-hand figure for packaging.</div>
    </div>)}
  </div>);
}

function ActionsView(){
  return (<div>
    <div className="card-section-title" style={{marginBottom:12}}>
      <h2 style={{margin:0}}>Actions</h2>
      <span className="meta">Everything worth doing, ranked by £ impact — work the queue, mark items done as you go</span>
    </div>
    <RestockActionQueue/>
    <ActionBoard/>
    <AdviceLedgerPanel/>
  </div>);
}

// Command menu (⌘K / Ctrl-K) — jump to any page or the AI analyst from anywhere.
function CommandMenu(){
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState('');
  const [sel, setSel] = React.useState(0);
  const items = React.useMemo(() => {
    const list = [];
    NAV.forEach(s => s.subtabs.forEach(t => list.push({label: t.label, sub: s.label, section: s.id, subId: t.id, icon: s.icon||'info'})));
    list.push({label:'Ask the AI analyst a question', sub:'AI Analyst', section:'home', subId:'ask', icon:'spark'});
    return list;
  }, []);
  React.useEffect(() => {
    const onKey = (e) => {
      if((e.metaKey||e.ctrlKey) && (e.key==='k'||e.key==='K')) { e.preventDefault(); setOpen(o=>!o); setQ(''); setSel(0); }
      else if(e.key==='Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    window.__oiCommandOpen = () => { setOpen(true); setQ(''); setSel(0); };
    return () => { window.removeEventListener('keydown', onKey); try{ delete window.__oiCommandOpen; }catch(e){} };
  }, []);
  const filtered = items.filter(it => (it.label+' '+it.sub).toLowerCase().includes(q.trim().toLowerCase()));
  if(!open) return null;
  const go = (it) => { setOpen(false); if(window.__oiNav) window.__oiNav(it.section, it.subId); };
  const onKeyDown = (e) => {
    if(e.key==='ArrowDown'){ e.preventDefault(); setSel(s=>Math.min(s+1, filtered.length-1)); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); setSel(s=>Math.max(s-1, 0)); }
    else if(e.key==='Enter'){ e.preventDefault(); if(filtered[sel]) go(filtered[sel]); }
  };
  return (<div className="cmd-bg" onClick={()=>setOpen(false)}>
    <div className="cmd-box" onClick={e=>e.stopPropagation()}>
      <input className="cmd-input" autoFocus placeholder="Jump to a page, or ask the AI analyst…"
        value={q} onChange={e=>{ setQ(e.target.value); setSel(0); }} onKeyDown={onKeyDown}/>
      <div className="cmd-list">
        {filtered.length ? filtered.map((it,i)=>(
          <div key={i} className={'cmd-row'+(i===sel?' sel':'')} onMouseEnter={()=>setSel(i)} onClick={()=>go(it)}>
            <Icon name={it.icon} size={16}/><span>{it.label}</span><span className="cmd-sub">{it.sub}</span>
          </div>
        )) : <div className="cmd-empty">No matches for “{q}”.</div>}
      </div>
    </div>
  </div>);
}

// ── Business Review — a management-overview surface built entirely on live data ──
// Structure: executive verdict → three-horizon scorecard (Now / Engine / Durability)
// → £-tagged risk & opportunity registers → decisions → copy-as-briefing. Every
// figure is a factual read of synced data (boardWeeks, money_rollup/findings,
// cohorts, channelMix, inventorySummary) — no projections, no fabrication.
function BusinessReview(){
  useCostTick();
  const weeks = useMemo(boardWeeks, [(typeof window!=='undefined' && window.FRKL_LIVE && window.FRKL_LIVE.lastFetchAt) || 0]);  // recompute when live data arrives (was [] → froze frkl static)
  const P = (typeof window!=='undefined' && window.FRKL_PATTERNS) || {};
  const C = (typeof window!=='undefined' && window.FRKL_COHORTS) || {};
  const B = (typeof window!=='undefined' && window.FRKL_BUSINESS) || {};
  const gm = oiGrossMargin();
  const cc0 = cashConfig();
  const [cashOpen, setCashOpen] = useState(false);
  const [cashDraft, setCashDraft] = useState(cc0.cash||'');
  const [ovDraft, setOvDraft] = useState(cc0.overheads||'');
  let i = weeks.length-1; while(i>0 && weeks[i] && weeks[i].partial) i--;
  const W = weeks.length ? weeks[i] : null, prev = i>0 ? weeks[i-1] : null;
  const trail = (key)=> weeks.slice(Math.max(0,i-8), i+1).map(w=>({x:(w.weekStart||'').slice(5), v:w.m[key]}));

  // formatters
  const gbpK = v=>'£'+(Math.abs(v)>=1000?(v/1000).toFixed(1).replace(/\.0$/,'')+'k':Math.round(v));
  const pct0 = v=>v!=null?(v*100).toFixed(0)+'%':'—';
  const pct1 = v=>v!=null?(v*100).toFixed(1)+'%':'—';
  const k = v=>{ v=Math.abs(Math.round(v)); return v>=1000?(v/1000).toFixed(v>=10000?0:1).replace(/\.0$/,'')+'k':''+v; };

  // ── £-tagged registers: live findings only (≥£50/mo, not already done) ──
  const confTier = c => typeof c==='number' ? (c>=0.66?'high':c>=0.45?'med':'low') : (c==='high'?'high':c==='medium'?'med':'low');
  const DONE = new Set(['done','verified-done','dismissed','wont-do']);
  const items = [
    ...Object.values(P.action_money||{}).map(m=>({description:m.description, basis:m.basis, monthly_impact_gbp:m.monthly_impact_gbp, kind:m.kind, confidence:m.confidence, status:m.status})),
    ...((P.money_patterns||[]).map(m=>({description:m.label||m.description, basis:m.basis, monthly_impact_gbp:m.monthly_impact_gbp, kind:m.kind, confidence:m.confidence, status:'open'}))),
  ].filter(x=> x.monthly_impact_gbp && Math.abs(x.monthly_impact_gbp)>=50 && !DONE.has(x.status) && (x.description||'').trim());
  const byImpact = (a,b)=>Math.abs(b.monthly_impact_gbp)-Math.abs(a.monthly_impact_gbp);
  const risks = items.filter(x=>x.kind==='leakage'||x.kind==='at_risk').sort(byImpact);
  const opps  = items.filter(x=>x.kind==='opportunity').sort(byImpact);
  const roll = P.money_rollup||{};
  const atRisk = (roll.leakage||0)+(roll.at_risk||0);
  const upside = roll.opportunity||0;
  const openActions = Object.values((typeof window!=='undefined'&&window.FRKL_ACTION_STATUS)||{}).filter(s=> s && !DONE.has(s.status)).length;

  // ── cohort / engine reads ──
  const repeat = C.repeatRate;
  const opc = C.ordersPerCustomer;
  const paidCac = C.cac && C.cac.paid;
  const ltvPerCust = C.lifetimeRevPerCust;
  const contribLTV = (ltvPerCust!=null && gm!=null) ? ltvPerCust*gm : null;
  const ltvCac = (contribLTV!=null && paidCac) ? contribLTV/paidCac : null;
  const newCustSeries = ((C.cac&&C.cac.byMonth)||[]).map(m=>({x:(m.month||'').slice(5), v:m.newCustomers}));

  // ── channel concentration ──
  const chans = (B.channelMix||[]).slice().sort((a,b)=>(b.revenue||0)-(a.revenue||0));
  const chanTotal = chans.reduce((s,c)=>s+(c.revenue||0),0);
  const topChan = chans[0];
  const topShare = (topChan&&chanTotal)? topChan.revenue/chanTotal : null;
  const paidShare = chanTotal? chans.filter(c=>/^Paid/i.test(c.channel||'')).reduce((s,c)=>s+(c.revenue||0),0)/chanTotal : null;

  // ── inventory / capital ──
  const inv = B.inventorySummary||{};
  const sk = t=> (inv[t]&&inv[t].skus)||0;
  const slowCapital = ((inv.overstock&&inv.overstock.totalValue)||0)+((inv.archived_stock&&inv.archived_stock.totalValue)||0);
  const lowCover = sk('critical')+sk('low');

  // ── HORIZON 1 — Now (trading, this week vs last) ──
  const NOW_SPECS=[
    {key:'revenue',       label:'Revenue',         fmt:v=>GBP(v),                             axisFmt:gbpK,                     better:'up'},
    {key:'orders',        label:'Orders',          fmt:v=>NUM(v),                             axisFmt:v=>Math.round(v),         better:'up'},
    {key:'cvr',           label:'Conversion rate', fmt:v=>v!=null?(v*100).toFixed(2)+'%':'—', axisFmt:v=>(v*100).toFixed(1)+'%',better:'up',  bench:CVR_BENCH},
    {key:'mer',           label:'Blended ROAS',    fmt:v=>v!=null?v.toFixed(2)+'×':'—',        axisFmt:v=>v.toFixed(1)+'×',      better:'up',  bench:3},
    {key:'discountDepth', label:'Discount depth',  fmt:v=>v!=null?(v*100).toFixed(1)+'%':'—', axisFmt:pct0,                     better:'down'},
  ];
  const nowD = (W&&prev) ? NOW_SPECS.map(sp=>{
    const val=W.m[sp.key], pv=prev.m[sp.key];
    const ch=(pv!=null&&pv!==0&&val!=null)?(val-pv)/Math.abs(pv):null;
    const rag=boardRag(sp,val,pv); const up=ch!=null&&ch>=0;
    const good=sp.better==='flat'?null:(sp.better==='down'?!up:up);
    const badge = rag==='good'?{kind:'healthy',label:'Healthy'} : rag==='bad'?(sp.bench!=null?{kind:'action',label:'Below target'}:{kind:'watch',label:'Watch'}) : rag==='warn'?{kind:'watch',label:'Watch'} : {kind:'info',label:'Steady'};
    return {sp,val,ch,rag,up,good,badge, read:`${sp.label}: ${sp.fmt(val)}${ch!=null?` (${up?'+':''}${(ch*100).toFixed(0)}% WoW)`:''}`};
  }).filter(d=>d.val!=null) : [];

  // ── HORIZON 2 — The engine (is the machine strengthening) ──
  const merNow = W&&W.m.mer;
  const engineD = [
    { label:'Contribution LTV : CAC', value: ltvCac!=null?ltvCac.toFixed(1)+'×':'—',
      status: ltvCac==null?'missing':(ltvCac>=3?'healthy':ltvCac>=2?'watch':'action'),
      statusLabel: ltvCac==null?'Needs data':(ltvCac>=3?'Healthy':ltvCac>=2?'Watch':'Below 2×'),
      sub: ltvCac!=null?`Contribution LTV £${NUM(Math.round(contribLTV))} ÷ paid CAC £${NUM(Math.round(paidCac))} · target ≥3×`:'Needs cost + cohort data',
      read:`Contribution LTV:CAC ${ltvCac!=null?ltvCac.toFixed(1)+'×':'—'} (target ≥3×)` },
    { label:'Repeat purchase rate', value: repeat!=null?pct1(repeat):'—',
      status: repeat==null?'missing':(repeat>=0.25?'healthy':repeat>=0.12?'watch':'action'),
      statusLabel: repeat==null?'—':(repeat>=0.25?'Healthy':repeat>=0.12?'Building':'Low'),
      sub:`${opc?opc.toFixed(2):'—'} orders/customer · ${NUM(C.totalCustomers||0)} customers to date`,
      read:`Repeat rate ${repeat!=null?pct1(repeat):'—'}, ${opc?opc.toFixed(2):'—'} orders/customer` },
    { label:'Average order value', value: W&&W.m.aov!=null?GBP(W.m.aov):'—',
      status:'info', statusLabel:'Monetization',
      series: trail('aov'), color:'var(--accent)', fmt:v=>GBP(v), axisFmt:v=>'£'+Math.round(v),
      read:`AOV ${W&&W.m.aov!=null?GBP(W.m.aov):'—'} (8-week trend)` },
    { label:'Stock cover risk', value: lowCover+(lowCover===1?' SKU':' SKUs'),
      status: sk('critical')>0?'watch':'healthy', statusLabel: sk('critical')>0?'Restock needed':'Covered',
      sub:`${sk('critical')} critical · ${sk('low')} low — sellers near stockout`,
      read:`${lowCover} SKUs at low/critical stock cover (${sk('critical')} critical)` },
  ];

  // ── HORIZON 3 — Durability (will it compound, and what could break it) ──
  const newCustLatest = newCustSeries.length ? newCustSeries[newCustSeries.length-1].v : null;
  const durD = [
    { label:'New customers / month', value: newCustLatest!=null?NUM(newCustLatest):'—',
      status:'info', statusLabel:'Acquisition',
      series: newCustSeries, color:'var(--accent)', fmt:v=>NUM(v), axisFmt:v=>Math.round(v),
      read:`New customers/mo ${newCustLatest!=null?NUM(newCustLatest):'—'} (latest month)` },
    { label:'Customer base', value: NUM(C.totalCustomers||0),
      status:'info', statusLabel:'To date',
      sub:'Total DTC customers acquired across the analysis window',
      read:`Customer base ${NUM(C.totalCustomers||0)} customers` },
    { label:'Revenue concentration', value: topShare!=null?pct0(topShare):'—',
      status: topShare==null?'missing':(topShare>0.45?'watch':'healthy'),
      statusLabel: topShare==null?'—':(topShare>0.45?'Concentrated':'Diversified'),
      sub: topChan?`${topChan.channel} is the largest revenue channel${paidShare!=null?` · paid = ${pct0(paidShare)} of revenue`:''}`:'—',
      read:`Revenue concentration: ${topChan?topChan.channel:'—'} ${topShare!=null?pct0(topShare):''}${paidShare!=null?`, paid ${pct0(paidShare)} of revenue`:''}` },
    { label:'Capital in slow stock', value: GBP(Math.round(slowCapital)),
      status: slowCapital>50000?'watch':'healthy', statusLabel: slowCapital>50000?'Cash tied up':'Lean',
      sub:`${sk('overstock')} overstock SKUs (>180d cover) valued at cost`,
      read:`£${k(slowCapital)} capital tied in slow-moving stock (${sk('overstock')} overstock SKUs)` },
  ];

  // ── Cash runway — cash on hand ÷ net monthly burn (run-rate from last 4 weeks) ──
  // Factual estimate: monthly gross profit (rev×GM) − ad spend − overheads. Ignores
  // one-off inventory purchases and working-capital timing (stated on the card).
  const cashCfg = cashConfig();
  const cashBal = parseFloat(cashCfg.cash);
  const overheads = parseFloat(cashCfg.overheads) || 0;
  const haveCash = cashCfg.cash!=='' && isFinite(cashBal) && cashBal>0;
  const recentW = weeks.filter(w=>!w.partial).slice(-4);
  const W2M = 52/12;  // weeks → month run-rate
  const moRev = recentW.length ? (recentW.reduce((s,w)=>s+(w.m.revenue||0),0)/recentW.length)*W2M : null;
  const moSpend = recentW.length ? (recentW.reduce((s,w)=>s+(w.m.paid||0),0)/recentW.length)*W2M : null;
  const moNet = (moRev!=null && gm!=null) ? moRev*gm - moSpend - overheads : null;
  const editCash = ()=>setCashOpen(o=>!o);
  let runwayCard;
  if(!haveCash){
    runwayCard = { label:'Cash runway', value:'Set balance', status:'missing', statusLabel:'Needs input',
      sub:'Enter cash on hand + monthly overheads →', onClick:editCash, read:'Cash runway: not set' };
  } else if(moNet==null){
    runwayCard = { label:'Cash runway', value:'—', status:'missing', statusLabel:'Needs data',
      sub:'Not enough weekly revenue history to estimate burn', onClick:editCash, read:'Cash runway: insufficient data' };
  } else if(moNet>=0){
    runwayCard = { label:'Cash runway', value:'Cash-flow positive', status:'healthy', statusLabel:'Self-funding',
      sub:`Net +£${k(moNet)}/mo run-rate · £${k(cashBal)} on hand`, onClick:editCash,
      read:`Cash runway: cash-flow positive (net +£${k(moNet)}/mo, £${k(cashBal)} on hand)` };
  } else {
    const months = cashBal/(-moNet);
    runwayCard = { label:'Cash runway', value: months>=24?'24+ mo':months.toFixed(1)+' mo',
      status: months<6?'action':months<12?'watch':'healthy', statusLabel: months<6?'Under 6 months':months<12?'Under 12 months':'12+ months',
      sub:`£${k(cashBal)} ÷ £${k(-moNet)}/mo net burn (rev×GM − ad spend − overheads)`, onClick:editCash,
      read:`Cash runway ${months.toFixed(1)} months (£${k(cashBal)} ÷ £${k(-moNet)}/mo net burn)` };
  }
  durD.push(runwayCard);
  const saveCash = ()=>{ saveCashConfig({...cashConfig(), cash:cashDraft, overheads:ovDraft}); setCashOpen(false); };

  // overall posture — factual: benchmark breaches in trading + material risk
  const breaches = nowD.filter(d=>d.sp.bench!=null && d.rag==='bad').length;
  const overall = breaches>=2 ? {kind:'action',label:'Action required'}
                : (breaches===1 || atRisk>2000) ? {kind:'watch',label:'Watch'}
                : {kind:'healthy',label:'On track'};
  const verdictSentence = `£${k(atRisk)}/mo of contribution is exposed across ${risks.length} flagged risk${risks.length===1?'':'s'}, against £${k(upside)}/mo of identified upside across ${opps.length} opportunit${opps.length===1?'y':'ies'}. ${openActions} actions are open in the queue. `
    + `Unit economics: ${ltvCac!=null?ltvCac.toFixed(1)+'× contribution LTV:CAC':'LTV:CAC pending cost data'}, repeat rate ${repeat!=null?pct1(repeat):'—'}. `
    + `${topChan&&topShare!=null?`${topChan.channel} drives ${pct0(topShare)} of revenue`:''}${slowCapital>50000?`, with £${k(slowCapital)} of capital tied in slow-moving stock`:''}.`;

  const copyBriefing = ()=>{
    const L=[];
    L.push(`BUSINESS REVIEW — ${OI_BRAND.name||'frkl'}${W?` · week of ${W.label}`:''}`);
    L.push(`Posture: ${overall.label}. ${verdictSentence}`);
    L.push('');
    L.push('NOW — trading (this week vs last):');   nowD.forEach(d=>L.push('  • '+d.read));
    L.push('THE ENGINE:');                           engineD.forEach(d=>L.push('  • '+d.read));
    L.push('DURABILITY:');                           durD.forEach(d=>L.push('  • '+d.read));
    L.push('');
    L.push(`TOP RISKS (£${k(atRisk)}/mo exposed):`);
    (risks.length?risks:[{description:'None flagged'}]).slice(0,5).forEach(x=>L.push('  • '+x.description+(x.monthly_impact_gbp?` (~£${k(Math.abs(x.monthly_impact_gbp))}/mo)`:'')));
    L.push(`TOP OPPORTUNITIES (£${k(upside)}/mo identified):`);
    (opps.length?opps:[{description:'None flagged'}]).slice(0,5).forEach(x=>L.push('  • '+x.description+(x.monthly_impact_gbp?` (~£${k(Math.abs(x.monthly_impact_gbp))}/mo)`:'')));
    const text=L.join('\n');
    try{ (navigator.clipboard&&navigator.clipboard.writeText(text)); }catch(e){}
    toast('Briefing copied', {kind:'good', body:'Paste into your notes or board pack.'});
  };

  const btn = {display:'inline-flex',alignItems:'center',gap:6,fontSize:12.5,fontWeight:600,padding:'7px 13px',borderRadius:8,border:'1px solid var(--border-default)',background:'var(--bg-elevated)',color:'var(--text-primary)',cursor:'pointer'};
  const Eyebrow = ({children}) => (<div style={{display:'flex',alignItems:'center',gap:8,margin:'20px 0 9px',fontSize:11,fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',color:'var(--text-muted)'}}><span style={{width:3,height:14,background:'var(--text-faint)',borderRadius:2}}/>{children}</div>);
  const RvCard = (c,idx) => (<div key={idx} className="wc-item" onClick={c.onClick} style={c.onClick?{cursor:'pointer'}:undefined} title={c.onClick?'Click to edit':undefined}>
    <div className="wc-top"><span className="wc-label">{c.label}</span>{c.status&&<StatusBadge kind={c.status} label={c.statusLabel}/>}</div>
    <div className="wc-val">{c.value}{c.change!=null && <span className="wc-ch" style={{color:c.changeColor}}>{c.change}</span>}</div>
    {c.series ? <WcSpark data={c.series} color={c.color} fmt={c.fmt} axisFmt={c.axisFmt}/>
              : (c.sub && <div style={{fontSize:11.5,color:'var(--text-faint)',marginTop:7,lineHeight:1.45}}>{c.sub}</div>)}
  </div>);
  const inp = {width:120,marginTop:4,padding:'6px 9px',borderRadius:7,border:'1px solid var(--border-default)',background:'var(--bg-base)',color:'var(--text-primary)',fontSize:13};
  const lbl = {display:'flex',flexDirection:'column',fontSize:11.5,fontWeight:600,color:'var(--text-secondary)'};
  const regRow = (accent) => (x,idx) => (<div key={idx} style={{display:'flex',gap:12,alignItems:'baseline',padding:'9px 0',borderTop:idx?'1px solid var(--border-subtle)':'none'}}>
    <div style={{flex:1,minWidth:0}}>
      <div style={{fontSize:13,color:'var(--text-primary)',lineHeight:1.4}}>{x.description}</div>
      {x.basis && <div style={{fontSize:11,color:'var(--text-faint)',marginTop:2,lineHeight:1.4}}>{x.basis}</div>}
    </div>
    <div style={{textAlign:'right',flexShrink:0}}>
      <div style={{fontWeight:700,fontSize:13.5,color:accent,whiteSpace:'nowrap'}}>~£{k(Math.abs(x.monthly_impact_gbp))}/mo</div>
      <div style={{marginTop:4}}>{confChip(confTier(x.confidence))}</div>
    </div>
  </div>);
  const topMoves = [...risks,...opps].sort(byImpact).slice(0,3);

  if(!W){
    return (<div className="card"><div className="muted" style={{fontSize:13}}>Business review needs at least one complete week of synced data. Connect your sources and check back once a full week has closed.</div></div>);
  }

  return (<div>
    <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:10,flexWrap:'wrap',marginBottom:6}}>
      <h2 style={{margin:0,fontSize:18}}>Business review</h2>
      <span className="muted" style={{fontSize:12}}>Management overview · week of {W.label} + trailing trend · independent of the date picker</span>
    </div>

    {/* TL;DR — the main points across the business, in five lines */}
    {(()=>{ const tl=[];
      tl.push({t:`${overall.label}: £${k(atRisk)}/mo of contribution exposed vs £${k(upside)}/mo of identified upside · ${openActions} actions open.`, c: overall.kind==='action'?'var(--bad)':overall.kind==='watch'?'var(--warn)':'var(--good)'});
      if(risks[0]) tl.push({t:`Biggest risk — ${risks[0].description} (~£${k(Math.abs(risks[0].monthly_impact_gbp))}/mo).`, c:'var(--bad)'});
      if(opps[0]) tl.push({t:`Biggest opportunity — ${opps[0].description} (~£${k(Math.abs(opps[0].monthly_impact_gbp))}/mo).`, c:'var(--good)'});
      tl.push({t:`Unit economics: ${ltvCac!=null?ltvCac.toFixed(1)+'× contribution LTV:CAC':'LTV:CAC pending cost data'}, repeat rate ${repeat!=null?pct1(repeat):'—'}${ltvCac!=null?` — ${ltvCac>=3?'healthy':'below the 3× target'}`:''}.`, c: (ltvCac!=null&&ltvCac>=3)?'var(--good)':'var(--warn)'});
      if(slowCapital>50000) tl.push({t:`£${k(slowCapital)} of capital tied up in slow-moving stock${topChan&&topShare!=null?`; ${topChan.channel} drives ${pct0(topShare)} of revenue`:''}.`, c:'var(--warn)'});
      return (<div className="card" style={{borderLeft:'3px solid var(--text-faint)'}}>
        <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',marginBottom:8}}>
          <span style={{fontSize:13,fontWeight:800,letterSpacing:'.06em',color:'var(--text-primary)'}}>TL;DR</span>
          <span className="muted" style={{fontSize:11.5}}>the main points across the business right now</span>
          <button style={{...btn,marginLeft:'auto',fontSize:11.5,padding:'5px 11px'}} onClick={copyBriefing}><Icon name="clipboard" size={12}/> Copy briefing</button>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:7}}>{tl.map((b,i)=>(<div key={i} style={{display:'flex',gap:9,alignItems:'baseline',fontSize:13.5,lineHeight:1.5,color:'var(--text-primary)'}}><span style={{width:6,height:6,borderRadius:'50%',background:b.c,flexShrink:0,marginTop:6}}/><span>{b.t}</span></div>))}</div>
      </div>); })()}

    {/* Executive verdict */}
    <div className="card" style={{borderLeft:'3px solid var(--accent)'}}>
      <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
        <StatusBadge kind={overall.kind} label={overall.label}/>
        <span className="muted" style={{fontSize:12}}>Overall posture</span>
        <button style={{...btn,marginLeft:'auto'}} onClick={copyBriefing}><Icon name="clipboard" size={13}/> Copy as briefing</button>
      </div>
      <div style={{fontSize:14.5,marginTop:11,lineHeight:1.55,color:'var(--text-primary)'}}>{verdictSentence}</div>
      <div style={{fontSize:11,color:'var(--text-faint)',marginTop:9,lineHeight:1.4}}>Built from live Shopify, GA4, Meta, Google Ads, Klaviyo and cohort data. Every figure is a factual read of synced data — not a projection.</div>
    </div>

    {/* Three-horizon scorecard */}
    <Eyebrow>Now · trading — this week vs last</Eyebrow>
    <div className="card"><div className="wc-grid">{nowD.map((d,idx)=>RvCard({label:d.sp.label, value:d.sp.fmt(d.val), change:`${d.up?'↑':'↓'}${Math.abs(d.ch*100).toFixed(0)}%`, changeColor:d.good==null?'var(--text-muted)':(d.good?'var(--good)':'var(--bad)'), status:d.badge.kind, statusLabel:d.badge.label, series:trail(d.sp.key), color:RAG_COL[d.rag]||'var(--text-faint)', fmt:d.sp.fmt, axisFmt:d.sp.axisFmt}, idx))}</div></div>

    <Eyebrow>The engine · is the machine strengthening (trailing)</Eyebrow>
    <div className="card"><div className="wc-grid">{engineD.map(RvCard)}</div></div>

    <Eyebrow>Durability · will it compound — and what could break it</Eyebrow>
    <div className="card"><div className="wc-grid">{durD.map(RvCard)}</div></div>
    {cashOpen && (<div className="card" style={{marginTop:10, borderLeft:'3px solid var(--accent)'}}>
      <div style={{fontSize:13,fontWeight:700,color:'var(--text-primary)',marginBottom:9}}>Cash position</div>
      <div style={{display:'flex',gap:18,flexWrap:'wrap',alignItems:'flex-end'}}>
        <label style={lbl}>Cash on hand (£)<input type="number" value={cashDraft} onChange={e=>setCashDraft(e.target.value)} placeholder="e.g. 80000" style={inp}/></label>
        <label style={lbl}>Monthly overheads (£)<input type="number" value={ovDraft} onChange={e=>setOvDraft(e.target.value)} placeholder="e.g. 12000" style={inp}/></label>
        <button style={btn} onClick={saveCash}>Save</button>
        <button style={{...btn,background:'transparent',color:'var(--text-muted)'}} onClick={()=>setCashOpen(false)}>Cancel</button>
      </div>
      <div style={{fontSize:11,color:'var(--text-faint)',marginTop:10,lineHeight:1.5}}>Overheads = salaries, rent, software — costs <b>not</b> already in ad spend or COGS. Runway = cash ÷ (monthly gross profit − ad spend − overheads), using your last {recentW.length||4} complete weeks as the run-rate. A factual estimate; it ignores one-off inventory purchases and working-capital timing.</div>
    </div>)}

    {/* Risk & opportunity registers */}
    <Eyebrow>Risks & opportunities · quantified</Eyebrow>
    <div className="row">
      <div className="card" style={{flex:'1 1 340px', minWidth:0, borderTop:'3px solid var(--bad)'}}>
        <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:8,marginBottom:4}}>
          <span style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>Risk register</span>
          <span style={{fontSize:12,fontWeight:700,color:'var(--bad)',whiteSpace:'nowrap'}}>£{k(atRisk)}/mo exposed</span>
        </div>
        {risks.length ? risks.slice(0,6).map(regRow('var(--bad)')) : <div className="muted" style={{fontSize:12.5,padding:'8px 0'}}>No material risks flagged — leakage and at-risk revenue are within normal range.</div>}
      </div>
      <div className="card" style={{flex:'1 1 340px', minWidth:0, borderTop:'3px solid var(--good)'}}>
        <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:8,marginBottom:4}}>
          <span style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>Opportunity register</span>
          <span style={{fontSize:12,fontWeight:700,color:'var(--good)',whiteSpace:'nowrap'}}>£{k(upside)}/mo identified</span>
        </div>
        {opps.length ? opps.slice(0,6).map(regRow('var(--good)')) : <div className="muted" style={{fontSize:12.5,padding:'8px 0'}}>No quantified upside flagged right now — check back as new signals land.</div>}
      </div>
    </div>

    {/* Decisions */}
    <div className="card" style={{marginTop:14}}>
      <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
        <span style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>Decisions &amp; next actions</span>
        <span className="muted" style={{fontSize:12.5}}>{openActions} open in the queue</span>
        <button style={{...btn,marginLeft:'auto'}} onClick={()=>window.__oiNav&&window.__oiNav('actions','queue')}>Open action queue <Icon name="chevron" size={13}/></button>
      </div>
      {topMoves.length>0 && <div className="muted" style={{fontSize:12.5,marginTop:9,lineHeight:1.55}}>Highest-value moves right now: {topMoves.map(m=>`${m.description} (~£${k(Math.abs(m.monthly_impact_gbp))}/mo)`).join(' · ')}.</div>}
    </div>
  </div>);
}

// ── Shared planning header — one Forecast → Strategy → Orders strip on both the
// Forecast & demand and Production / POs tabs, so they read as one workflow.
function PlanningHeader({active, embedded}){
  usePlanningTick();
  const R = planReorder();
  const dc = demandConfig(); const rc = reorderConfig();
  const k = v=>{ v=Math.abs(Math.round(v)); return v>=1000?(v/1000).toFixed(v>=10000?0:1).replace(/\.0$/,'')+'k':''+v; };
  const months = (R.plan&&R.plan.months)||3;
  const strat = R.strategy; const STRAT={jit:'Just-in-time',bulk:'Bulk upfront',staged:'Staged waves'};
  const growthPct = R.plan?R.plan.growthPct:0;
  const orderVal = R.toOrder.reduce((t,l)=>t+(l.lineCost||0),0);
  const fLabel = dc.targetMode==='growth' ? `${(Number(dc.growth)||0)>=0?'+':''}${Number(dc.growth)||0}% on run-rate`
    : dc.shape==='month' ? `${months}-mo, by month`
    : (Number(dc.targetValue)>0 ? (dc.targetMode==='revenue'?`£${k(dc.targetValue)} over ${months}mo`:`${NUM(Number(dc.targetValue))}u over ${months}mo`) : `${months}-mo run-rate`);
  const go = (sub)=>window.__oiNav&&window.__oiNav('planning',sub);
  const jump = (id)=>{ const el=document.getElementById(id); if(el) el.scrollIntoView({behavior:'smooth', block:'start'}); };
  // in the merged tab, chips scroll to sections; otherwise they cross-navigate
  const onForecast = embedded ? ()=>jump('plan-forecast') : (active==='forecast'?undefined:()=>go('forecast'));
  const onPOs = embedded ? ()=>jump('plan-pos') : (active==='production'?undefined:()=>go('production'));
  const fHint = embedded ? ' · jump ›' : (active!=='forecast'?' · edit ›':'');
  const pHint = embedded ? ' · jump ›' : (active!=='production'?' · open ›':'');
  const chip = (on)=>({flex:'1 1 190px',minWidth:172,padding:'10px 13px',borderRadius:10,background:on?'var(--accent-bg)':'var(--bg-elevated)',border:'1px solid '+(on?'var(--accent)':'var(--border-subtle)')});
  const lab = {fontSize:10,fontWeight:700,letterSpacing:'.05em',textTransform:'uppercase',color:'var(--text-faint)',marginBottom:4};
  const sbtn = (id)=>({fontSize:11,fontWeight:700,padding:'5px 9px',borderRadius:7,cursor:'pointer',border:'1.5px solid '+(strat===id?'var(--accent)':'var(--border-default)'),background:strat===id?'var(--accent)':'transparent',color:strat===id?'#fff':'var(--text-secondary)'});
  const arrow = <div style={{display:'flex',alignItems:'center',color:'var(--text-faint)',fontSize:16,fontWeight:700}}>→</div>;
  return (<div className="card" style={{padding:'12px 14px',marginBottom:14}}>
    <div style={{display:'flex',gap:10,flexWrap:'wrap',alignItems:'stretch'}}>
      <div style={{...chip(active==='forecast'), cursor:onForecast?'pointer':'default'}} onClick={onForecast}>
        <div style={lab}>① Forecast{fHint&&<span style={{color:'var(--accent)'}}>{fHint}</span>}</div>
        <div style={{fontSize:13.5,fontWeight:700,color:'var(--text-primary)'}}>{fLabel}</div>
        <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>{growthPct>=0?'+':''}{Math.round(growthPct)}% vs run-rate</div>
      </div>
      {arrow}
      <div style={{...chip(false), flex:'1 1 250px'}}>
        <div style={lab}>② Strategy — how to commit</div>
        <div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:3}}>
          {['jit','bulk','staged'].map(id=>(<button key={id} title={STRAT[id]} style={sbtn(id)} onClick={()=>saveReorderConfig({...rc,strategy:id})}>{STRAT[id]}</button>))}
        </div>
      </div>
      {arrow}
      <div style={{...chip(active==='production'), cursor:onPOs?'pointer':'default'}} onClick={onPOs}>
        <div style={lab}>③ Purchase orders{pHint&&<span style={{color:'var(--accent)'}}>{pHint}</span>}</div>
        <div style={{fontSize:13.5,fontWeight:700,color:R.toOrder.length?'var(--warn)':'var(--good)'}}>{R.toOrder.length} to order{orderVal>0?` · £${k(orderVal)}`:''}</div>
        <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>{R.awaiting.length} awaiting stock</div>
      </div>
    </div>
  </div>);
}

// ── Production / PO planner ──────────────────────────────────────────────────
// Reorder engine off live inventory (dailyVelocity, inventoryQty, daysOfCover)
// + lead times. When a seller's cover falls within lead+safety days, it drafts a
// purchase order: order-up-to (lead+cover) days of demand, bumped to MOQ. POs are
// grouped by supplier and exportable (CSV / copy). Nothing is sent automatically.
function ProductionPlanner({embedded}={}){
  usePlanningTick();
  const R = planReorder();
  const {inv, toOrder, awaiting, approaching, oosNow, ackPending, plan, scale, safety, coverDays, strategy, waves, horizonDays} = R;
  const STRAT = {jit:'Just-in-time', bulk:'Bulk upfront', staged:'Staged waves'};
  // persist auto-acknowledgements (stock landed in Shopify → close the PO)
  const ackKeys = Object.keys(ackPending||{});
  React.useEffect(()=>{ if(ackKeys.length){ ackKeys.forEach(key=>clearPoStatus(key)); } }, [ackKeys.join(',')]);
  const rc = reorderConfig();
  const [supOpen, setSupOpen] = useState(false);
  const [setOpen, setSetOpen] = useState(false);
  const types = [...new Set(inv.map(p=>p.type).filter(Boolean))].sort();

  const k = v=>{ v=Math.abs(Math.round(v)); return v>=1000?(v/1000).toFixed(v>=10000?0:1).replace(/\.0$/,'')+'k':''+v; };

  const bySupplier = {};
  toOrder.forEach(l=>{ (bySupplier[l.supplier]=bySupplier[l.supplier]||[]).push(l); });
  const _tdy = oiToday();
  const pos = Object.keys(bySupplier).map(s=>{
    const ls=bySupplier[s], total=ls.reduce((t,l)=>t+(l.lineCost||0),0);
    const withEmail=ls.find(l=>l.supEmail), withNotes=ls.find(l=>l.supNotes);
    const deposit=ls.reduce((t,l)=>t+(l.depositCost!=null?l.depositCost:(l.lineCost||0)),0);
    const balance=Math.max(0,total-deposit);
    const leadMakeMax=Math.max(...ls.map(l=>l.leadMake!=null?l.leadMake:l.lead||0));
    const leadTotalMax=Math.max(...ls.map(l=>l.lead||0));
    const depPctShown=ls.find(l=>l.depositPct!=null&&l.depositPct<100); const depPct=depPctShown?depPctShown.depositPct:null;
    return {supplier:s, lines:ls, total, deposit, balance, hasDeposit: total>0 && deposit<total-0.5, depPct, leadMakeMax, leadTotalMax, ships:oiAddDays(_tdy,leadMakeMax), lands:oiAddDays(_tdy,leadTotalMax), hasCost:ls.every(l=>l.unitCost!=null), units:ls.reduce((t,l)=>t+l.qty,0), email:withEmail?withEmail.supEmail:'', notes:withNotes?withNotes.supNotes:'', urgent:ls.filter(l=>l.oosBeforeLead).length, minCover:Math.min(...ls.map(l=>l.cover))};
  // suppliers with order-today items first, then earliest stockout
  }).sort((a,b)=> (b.urgent>0)-(a.urgent>0) || (a.minCover-b.minCover) || a.supplier.localeCompare(b.supplier));
  const totalValue = pos.reduce((t,p)=>t+p.total,0);
  const missingCost = toOrder.some(l=>l.unitCost==null);
  const today = (()=>{ try{ return new Date().toLocaleDateString('en-GB'); }catch(e){ return ''; } })();
  const raisePO = (po)=>{ const u={}; po.lines.forEach(l=>{ u[l.key]={status:'ordered', qty:l.qty, raisedAt:oiToday(), baselineQty:l.p.inventoryQty||0, lead:l.lead, supplier:l.supplier, title:l.p.title}; }); setPoStatusMany(u); toast('PO marked raised', {kind:'good', body:po.supplier+' · now awaiting stock'}); };

  const csvFor = (po)=>{
    const rows=[['SKU','Product','Type','Order qty','Unit cost','Line total','Current stock','Days cover','Lead days']];
    po.lines.forEach(l=>rows.push([l.p.sku||'', l.p.title||'', l.p.type||'', l.qty, l.unitCost!=null?l.unitCost:'', l.lineCost!=null?l.lineCost.toFixed(2):'', l.p.inventoryQty, Math.round(l.cover), l.lead]));
    rows.push([], ['','','','TOTAL','',po.total.toFixed(2)]);
    return rows.map(r=>r.map(c=>{const s=String(c==null?'':c); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}).join(',')).join('\n');
  };
  const download = (po)=>{ try{
    const blob=new Blob([csvFor(po)],{type:'text/csv'}); const url=URL.createObjectURL(blob);
    const a=document.createElement('a'); a.href=url; a.download='PO_'+po.supplier.replace(/[^a-z0-9]+/gi,'_')+'.csv'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),1000); toast('PO exported', {kind:'good', body:po.supplier+' · '+po.lines.length+' lines'});
  }catch(e){ toast('Export failed', {kind:'bad'}); } };
  const copyPO = (po)=>{
    const firstLine=po.lines[0]||{};
    const L=['PURCHASE ORDER (DRAFT)', 'To: '+po.supplier+(po.email?' <'+po.email+'>':''), ...(firstLine.supPhone?['Tel: '+firstLine.supPhone]:[]), ...(firstLine.supAddress?[firstLine.supAddress]:[]), ...(po.notes?[po.notes]:[]), 'From: '+(OI_BRAND.name||'frkl')+(today?'  ·  '+today:''), ''];
    po.lines.forEach(l=>L.push(l.qty+' × '+l.p.title+' ['+(l.p.sku||'no SKU')+']'+(l.unitCost!=null?(' @ £'+l.unitCost+' = £'+l.lineCost.toFixed(2)):'  — PRICE TBC (please quote)')+(l.moqBumped?(' (MOQ '+l.moq+')'):'')));
    L.push('', po.hasCost?('TOTAL: £'+po.total.toFixed(2)+' · '+po.units+' units'):(po.units+' units · PRICING TBC — please quote against this PO'));
    if(po.hasCost){ const fd=iso=>{ try{ return new Date((iso||'')+'T00:00:00').toLocaleDateString('en-GB'); }catch(e){ return iso; } };
      if(po.hasDeposit) L.push('Terms: £'+po.deposit.toFixed(2)+' deposit'+(po.depPct!=null?(' ('+po.depPct+'%)'):'')+' on order, £'+po.balance.toFixed(2)+' balance on shipment');
      L.push('Lead: '+po.leadTotalMax+' days from order — ships ~'+fd(po.ships)+', lands ~'+fd(po.lands)); }
    try{ navigator.clipboard&&navigator.clipboard.writeText(L.join('\n')); }catch(e){}
    toast('PO copied', {kind:'good', body:po.supplier});
  };

  // editors (local draft → explicit save, avoids focus loss on keystroke)
  // SKU-level supplier master — built up over time, one product at a time
  const [supSearch, setSupSearch] = useState('');
  const [supDraft, setSupDraft] = useState(()=>{ const c=skuSupplierAll(), d={}; Object.keys(c).forEach(key=>{ const s=c[key]||{}; d[key]={supplier:s.supplier||'', email:s.email||'', notes:s.notes||'', moq:s.moq!=null?s.moq:'', unitCost:s.unitCost!=null?s.unitCost:'', lead:s.lead!=null&&s.lead!==''?String(s.lead):''}; }); return d; });
  const setSup = (key,field,val)=>setSupDraft(d=>({...d, [key]:{...(d[key]||{supplier:'',email:'',notes:'',moq:'',unitCost:'',lead:''}), [field]:val}}));
  const saveSuppliers = ()=>{ const all={}; const newNames=new Set(); Object.keys(supDraft).forEach(key=>{ const s=supDraft[key]; const nm=(s.supplier||'').trim(); if(nm||s.moq!==''||s.unitCost!==''||s.lead!==''){ all[key]={supplier:nm, moq:s.moq, unitCost:s.unitCost, lead:s.lead===''?'':(Number(s.lead)||'')}; if(nm) newNames.add(nm); } }); saveSkuSupplierAll(all); newNames.forEach(n=>registerSupplier(n)); setSupOpen(false); toast('Supplier master saved', {kind:'good'}); };
  const [safDraft, setSafDraft] = useState(String(rc.safetyDays));
  const [covDraft, setCovDraft] = useState(String(rc.coverDays));
  const [stratDraft, setStratDraft] = useState(rc.strategy||'jit');
  const [wavesDraft, setWavesDraft] = useState(String(rc.waves||3));
  const [depDraft, setDepDraft] = useState(String(rc.depositPct!=null?rc.depositPct:100));
  const [shipDraft, setShipDraft] = useState(String(rc.shipDays!=null?rc.shipDays:0));
  const leadTypes = [...new Set(inv.map(p=>p.type).filter(Boolean))].sort((a,b)=>a.localeCompare(b));   // distinct product types
  const [leadDraft, setLeadDraft] = useState(()=>{ const lc=leadConfig(); const bt={}; leadTypes.forEach(t=>{ bt[t]= (lc.byType&&lc.byType[t]!=null&&lc.byType[t]!=='')?String(lc.byType[t]):''; }); return {def:String(lc.default!=null?lc.default:30), byType:bt}; });
  const setLeadType = (t,v)=>setLeadDraft(d=>({...d, byType:{...d.byType,[t]:v}}));
  const saveSettings = ()=>{ saveReorderConfig({...reorderConfig(), safetyDays:Number(safDraft)||14, coverDays:Number(covDraft)||45, waves:Math.max(1,Number(wavesDraft)||3), depositPct:Math.max(0,Math.min(100,Number(depDraft)||0)), shipDays:Math.max(0,Number(shipDraft)||0)});
    const lc=leadConfig(); const bt={...(lc.byType||{})}; Object.keys(leadDraft.byType).forEach(t=>{ const v=leadDraft.byType[t]; if(v===''||v==null) delete bt[t]; else if(isFinite(Number(v))) bt[t]=Number(v); }); saveLeadConfig({...lc, default:Number(leadDraft.def)||30, byType:bt});
    setSetOpen(false); toast('Reorder policy saved', {kind:'good'}); };

  const btn = {display:'inline-flex',alignItems:'center',gap:6,fontSize:12.5,fontWeight:600,padding:'7px 13px',borderRadius:8,border:'1px solid var(--border-default)',background:'var(--bg-elevated)',color:'var(--text-primary)',cursor:'pointer'};
  const smbtn = {...btn, fontSize:11.5, padding:'5px 10px'};
  const inp = {padding:'5px 8px',borderRadius:6,border:'1px solid var(--border-default)',background:'var(--bg-base)',color:'var(--text-primary)',fontSize:12.5};
  const th = {textAlign:'left',fontSize:10.5,fontWeight:700,letterSpacing:'.04em',textTransform:'uppercase',color:'var(--text-faint)',padding:'0 10px 7px 0',whiteSpace:'nowrap'};
  const td = {padding:'7px 10px 7px 0',fontSize:12.5,color:'var(--text-secondary)',borderTop:'1px solid var(--border-subtle)',verticalAlign:'top'};

  return (<div>
    {!embedded && (<><div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:10,flexWrap:'wrap',marginBottom:6}}>
      <h2 style={{margin:0,fontSize:18}}>Production &amp; purchase orders</h2>
      <span className="muted" style={{fontSize:12}}>Reorder engine on live stock + velocity · independent of the date picker</span>
    </div>
    <PlanningHeader active="production"/></>)}

    {/* summary + controls */}
    <div className="card">
      <div style={{display:'flex',gap:22,flexWrap:'wrap',alignItems:'flex-end'}}>
        <div title="Run out before a reorder placed today could land — order these now"><div style={{fontSize:24,fontWeight:800,color: oosNow?'var(--bad)':'var(--good)'}}>{oosNow}</div><div className="muted" style={{fontSize:11.5}}>order today (OOS risk)</div></div>
        <div><div style={{fontSize:24,fontWeight:800,color: toOrder.length?'var(--warn)':'var(--good)'}}>{toOrder.length}</div><div className="muted" style={{fontSize:11.5}}>SKUs to reorder now</div></div>
        <div><div style={{fontSize:24,fontWeight:800,color:'var(--text-primary)'}}>{NUM(toOrder.reduce((t,l)=>t+l.qty,0))}</div><div className="muted" style={{fontSize:11.5}}>units across all POs</div></div>
        <div><div style={{fontSize:24,fontWeight:800,color:'var(--text-primary)'}}>{totalValue>0?'£'+k(totalValue):'—'}</div><div className="muted" style={{fontSize:11.5}}>draft order value{missingCost?' (partial)':''}</div></div>
        <div><div style={{fontSize:24,fontWeight:800,color: awaiting.length?'var(--accent)':'var(--text-faint)'}}>{awaiting.length}</div><div className="muted" style={{fontSize:11.5}}>awaiting stock</div></div>
        <div style={{marginLeft:'auto',display:'flex',gap:8,flexWrap:'wrap'}}>
          <button style={btn} onClick={()=>setSupOpen(o=>!o)}><Icon name="sliders" size={13}/> Supplier master</button>
          <button style={btn} onClick={()=>setSetOpen(o=>!o)}><Icon name="sliders" size={13}/> Reorder policy</button>
        </div>
      </div>
      <div style={{fontSize:11.5,color:'var(--text-faint)',marginTop:11,lineHeight:1.5}}>
        Strategy: <b style={{color:'var(--text-secondary)'}}>{STRAT[strategy]}</b> · <a className="txt-link" style={{cursor:'pointer'}} onClick={()=>setSetOpen(o=>!o)}>change</a>. {strategy==='bulk'
          ? <>Provisioning the full <b>{Math.round((horizonDays/30.4))}-month</b> demand plan upfront — each product's order is its planned demand (split by historic mix) net of stock, then rounded to MOQ.</>
          : strategy==='staged'
          ? <>Ordering the forecast in <b>{waves} waves</b>; each order covers lead + one wave, and the next wave's order-by date is shown per line.</>
          : <>Lean / JIT — reorder triggers when cover falls within <b>lead + {safety}d safety</b>, ordering up to <b>{coverDays}d beyond lead</b>, rounded to MOQ.</>}
        {approaching>0?` ${approaching} more will cross the trigger soon.`:''} Drafts only — nothing is sent to suppliers automatically.</div>
      {plan.active && (<div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',marginTop:10,padding:'8px 12px',borderRadius:8,background:'var(--accent-bg)',border:'1px solid var(--border-subtle)'}}>
        <Icon name="trendUp" size={14} style={{color:'var(--accent)'}}/>
        <span style={{fontSize:12,color:'var(--text-secondary)'}}>Orders are sized to your demand plan — <b style={{color:'var(--text-primary)'}}>{plan.growthPct>=0?'+':''}{plan.growthPct.toFixed(0)}% vs run-rate</b> ({plan.mode==='growth'?'growth target':plan.mode==='units'?'units target':'revenue target'}), not flat velocity.</span>
        <button style={{...btn,fontSize:11.5,padding:'4px 10px',marginLeft:'auto'}} onClick={()=>{ if(window.__oiOpenForecast){ window.__oiOpenForecast(); return; } const el=document.getElementById('plan-forecast'); if(el) el.scrollIntoView({behavior:'smooth'}); else if(window.__oiNav) window.__oiNav('planning','forecast'); }}>Adjust plan <Icon name="chevron" size={12}/></button>
      </div>)}
    </div>

    {/* supplier master — per SKU, built up over time */}
    {supOpen && (()=>{
      const q = supSearch.trim().toLowerCase();
      const allActive = inv;
      let visible;
      if(q){ visible = allActive.filter(p=> (p.title+' '+(p.sku||'')+' '+(p.type||'')).toLowerCase().includes(q)).slice(0,50); }
      else { const seen=new Set(); visible=[];
        toOrder.forEach(l=>{ if(!seen.has(l.key)){ seen.add(l.key); visible.push(l.p); } });          // needing ordering first
        allActive.forEach(p=>{ const key=skuKeyOf(p); if(supDraft[key] && !seen.has(key)){ seen.add(key); visible.push(p); } });  // then already-set
      }
      return (<div className="card" style={{borderLeft:'3px solid var(--accent)'}}>
      <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:10,flexWrap:'wrap',marginBottom:6}}>
        <div style={{fontSize:13,fontWeight:700}}>Supplier master <span className="muted" style={{fontWeight:400,fontSize:11.5}}>· per SKU · fill in as you order — production lead = days from order to stock landing</span></div>
        <input value={supSearch} onChange={e=>setSupSearch(e.target.value)} placeholder="Search any product to assign…" style={{...inp,width:240}}/>
      </div>
      <datalist id="oi-supplier-names">{supplierNamesInUse().map(n=><option key={n} value={n}/>)}</datalist>
      <div style={{overflowX:'auto'}}><table style={{borderCollapse:'collapse',width:'100%',minWidth:680}}><thead><tr><th style={th}>Product</th><th style={th}>Supplier / manufacturer</th><th style={th}>MOQ</th><th style={th}>Unit £ <span style={{fontWeight:400,textTransform:'none'}}>(blank = quote)</span></th><th style={th}>Lead (days)</th></tr></thead><tbody>
        {visible.map(p=>{ const key=skuKeyOf(p); const d=supDraft[key]||{supplier:'',moq:'',unitCost:'',lead:''}; const set=!!(d.supplier&&d.supplier.trim()); return (<tr key={key}>
          <td style={{...td,color:'var(--text-primary)'}}>{set?'':<span style={{color:'var(--warn)',marginRight:4}}>●</span>}{p.title}<div style={{fontSize:10.5,color:'var(--text-faint)'}}>{p.sku||'no SKU'} · {p.type}</div></td>
          <td style={td}><input list="oi-supplier-names" style={{...inp,width:190}} value={d.supplier} onChange={e=>setSup(key,'supplier',e.target.value)} placeholder="Pick or type a new supplier"/></td>
          <td style={td}><input type="number" style={{...inp,width:64}} value={d.moq} onChange={e=>setSup(key,'moq',e.target.value)} placeholder="0"/></td>
          <td style={td}><input type="number" style={{...inp,width:72}} value={d.unitCost} onChange={e=>setSup(key,'unitCost',e.target.value)} placeholder="quote"/></td>
          <td style={td}><input type="number" style={{...inp,width:64}} value={d.lead} onChange={e=>setSup(key,'lead',e.target.value)} placeholder={String(leadDaysForType(p.type))}/></td>
        </tr>); })}
        {!visible.length && <tr><td colSpan={5} style={{...td,color:'var(--text-faint)'}}>{q?'No products match.':'Nothing to assign right now — search for a product above.'}</td></tr>}
      </tbody></table></div>
      <div style={{marginTop:10,display:'flex',gap:8}}><button style={btn} onClick={saveSuppliers}>Save supplier master</button><button style={{...btn,background:'transparent',color:'var(--text-muted)'}} onClick={()=>setSupOpen(false)}>Cancel</button></div>
      <div style={{fontSize:11,color:'var(--text-faint)',marginTop:8}}>Per-SKU — set the supplier the first time you order a product; it sticks. Type a new name to add a supplier (manage full contact details on the <a className="txt-link" style={{cursor:'pointer'}} onClick={()=>window.__oiNav&&window.__oiNav('planning','suppliers')}>Suppliers tab</a>). Leave <b>Unit £</b> blank to raise the PO for a quote and add the price later; lead defaults to the type's.</div>
    </div>); })()}

    {/* reorder policy editor */}
    {setOpen && (<div className="card" style={{borderLeft:'3px solid var(--accent)'}}>
      <div style={{fontSize:13,fontWeight:700,marginBottom:3}}>Reorder policy <span className="muted" style={{fontWeight:400,fontSize:11.5}}>· strategy: {STRAT[strategy]} — set in the band above</span></div>
      <div style={{display:'flex',gap:18,flexWrap:'wrap',alignItems:'flex-end',marginTop:10}}>
        <label style={{display:'flex',flexDirection:'column',fontSize:11.5,fontWeight:600,color:'var(--text-secondary)',gap:4}}>Safety stock (days)<input type="number" style={{...inp,width:90}} value={safDraft} onChange={e=>setSafDraft(e.target.value)}/></label>
        {strategy==='jit' && <label style={{display:'flex',flexDirection:'column',fontSize:11.5,fontWeight:600,color:'var(--text-secondary)',gap:4}}>Order-up-to cover beyond lead (days)<input type="number" style={{...inp,width:90}} value={covDraft} onChange={e=>setCovDraft(e.target.value)}/></label>}
        {strategy==='staged' && <label style={{display:'flex',flexDirection:'column',fontSize:11.5,fontWeight:600,color:'var(--text-secondary)',gap:4}}>Number of waves<input type="number" style={{...inp,width:90}} value={wavesDraft} onChange={e=>setWavesDraft(e.target.value)}/></label>}
        <label style={{display:'flex',flexDirection:'column',fontSize:11.5,fontWeight:600,color:'var(--text-secondary)',gap:4}} title="Default % paid upfront at order; the balance falls due at shipment. Override per supplier on the Suppliers tab.">Deposit % at order<input type="number" style={{...inp,width:90}} value={depDraft} onChange={e=>setDepDraft(e.target.value)}/></label>
        <label style={{display:'flex',flexDirection:'column',fontSize:11.5,fontWeight:600,color:'var(--text-secondary)',gap:4}} title="Default shipping transit days from shipment to landing, added on top of each product's production lead. Override per supplier on the Suppliers tab.">Transit days (ship→land)<input type="number" style={{...inp,width:90}} value={shipDraft} onChange={e=>setShipDraft(e.target.value)}/></label>
      </div>
      {/* default production lead by type — used when a SKU has no specific lead */}
      <div style={{marginTop:14,paddingTop:12,borderTop:'1px solid var(--border-subtle)'}}>
        <div style={{fontSize:12,fontWeight:700,marginBottom:2}}>Default production lead by type <span className="muted" style={{fontWeight:400,fontSize:11}}>· days from order to shipment — used when a SKU has no specific lead set in the demand table / Supplier master</span></div>
        <div style={{display:'flex',gap:14,flexWrap:'wrap',alignItems:'flex-end',marginTop:9}}>
          <label style={{display:'flex',flexDirection:'column',fontSize:11.5,fontWeight:600,color:'var(--text-secondary)',gap:4}}>All types (default)<input type="number" min="0" style={{...inp,width:80}} value={leadDraft.def} onChange={e=>setLeadDraft(d=>({...d,def:e.target.value}))}/></label>
          {leadTypes.map(t=>(<label key={t} style={{display:'flex',flexDirection:'column',fontSize:11.5,fontWeight:600,color:'var(--text-secondary)',gap:4}}>{t}<input type="number" min="0" placeholder={String(leadDraft.def||30)} style={{...inp,width:72}} value={leadDraft.byType[t]||''} onChange={e=>setLeadType(t,e.target.value)}/></label>))}
        </div>
      </div>
      <div style={{display:'flex',gap:8,marginTop:14}}><button style={btn} onClick={saveSettings}>Save policy</button><button style={{...btn,background:'transparent',color:'var(--text-muted)'}} onClick={()=>setSetOpen(false)}>Cancel</button></div>
      <div style={{fontSize:11,color:'var(--text-faint)',marginTop:9,lineHeight:1.5}}>Lead = <b>production</b> (this section / per SKU) <b>+ transit</b> (per supplier, or the default above). Deposit % and transit are <b>defaults</b> — override per supplier on the <a className="txt-link" style={{cursor:'pointer'}} onClick={()=>window.__oiNav&&window.__oiNav('planning','suppliers')}>Suppliers tab</a>. All feed the stock landing plan.</div>
    </div>)}

    {/* draft POs */}
    {pos.map(po=>(<div key={po.supplier} className="card">
      <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:10,flexWrap:'wrap',marginBottom:8}}>
        <div><span style={{fontSize:15,fontWeight:700,color:'var(--text-primary)'}}>{po.supplier}</span> <span className="muted" style={{fontSize:12}}>· {po.lines.length} line{po.lines.length===1?'':'s'} · {NUM(po.units)} units</span>{(po.email||po.notes) && <div style={{fontSize:11,color:'var(--text-faint)',marginTop:2}}>{po.email}{po.email&&po.notes?' · ':''}{po.notes}</div>}</div>
        <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
          {po.hasCost ? <span style={{fontSize:15,fontWeight:800,color:'var(--text-primary)'}}>£{po.total.toFixed(2)}</span>
            : <span style={{fontSize:11.5,fontWeight:700,color:'var(--warn)',background:'var(--warn-bg)',padding:'2px 9px',borderRadius:999}}>Pricing pending{po.total>0?` · £${po.total.toFixed(0)} so far`:''}</span>}
          <button style={smbtn} onClick={()=>copyPO(po)}><Icon name="clipboard" size={12}/> Copy</button>
          <button style={smbtn} onClick={()=>download(po)}><Icon name="report" size={12}/> CSV</button>
          <button style={{...smbtn, background:'var(--accent)', color:'#fff', borderColor:'var(--accent)'}} onClick={()=>raisePO(po)}><Icon name="check" size={12}/> Mark PO raised</button>
        </div>
      </div>
      {po.hasCost && (()=>{ const fd=iso=>{ try{ return new Date((iso||'')+'T00:00:00').toLocaleDateString('en-GB',{day:'numeric',month:'short'}); }catch(e){ return iso; } }; return (
        <div style={{display:'flex',gap:14,flexWrap:'wrap',alignItems:'center',fontSize:11.5,color:'var(--text-muted)',margin:'0 0 10px',padding:'7px 11px',borderRadius:8,background:'var(--bg-elevated)'}}>
          {po.hasDeposit
            ? <span><b style={{color:'var(--text-primary)'}}>£{k(po.deposit)} deposit now</b>{po.depPct!=null?` (${po.depPct}%)`:''} · <b style={{color:'var(--text-primary)'}}>£{k(po.balance)}</b> on shipment</span>
            : <span><b style={{color:'var(--text-primary)'}}>£{k(po.total)}</b> due now</span>}
          <span style={{color:'var(--text-faint)'}}>Ships ~{fd(po.ships)}{po.hasDeposit?' · balance due then':''}</span>
          <span style={{color:'var(--text-faint)'}}>Lands ~{fd(po.lands)} ({po.leadTotalMax}d lead)</span>
        </div>); })()}
      <div style={{overflowX:'auto'}}><table style={{borderCollapse:'collapse',width:'100%',minWidth:560}}><thead><tr>
        <th style={th}>Product</th><th style={{...th,textAlign:'right'}}>Stock</th><th style={{...th,textAlign:'right'}}>Cover</th><th style={{...th,textAlign:'right'}}>Order qty</th><th style={{...th,textAlign:'right'}}>Unit £</th><th style={{...th,textAlign:'right'}}>Line £</th>
      </tr></thead><tbody>
        {po.lines.map((l,idx)=>(<tr key={idx}>
          <td style={{...td,color:'var(--text-primary)'}}>{l.p.title}{l.oosBeforeLead && <span style={{marginLeft:6,fontSize:9.5,fontWeight:800,letterSpacing:'.03em',color:'#fff',background:'var(--bad)',padding:'1px 7px',borderRadius:999}}>ORDER TODAY</span>}<div style={{fontSize:10.5,color:'var(--text-faint)'}}>{l.p.sku||'no SKU'} · {l.p.type}{l.oosBeforeLead?` · OOS gap ${l.oosGap}d`:''}{l.basis==='forecast'?` · plan needs ${NUM(l.forecastUnits)}`:''}{l.basis==='wave'&&l.nextWaveBy?` · next wave by ${l.nextWaveBy}`:''}{l.moqBumped?' · MOQ '+l.moq:''}</div></td>
          <td style={{...td,textAlign:'right'}}>{NUM(l.p.inventoryQty)}</td>
          <td style={{...td,textAlign:'right',color:l.cover<=l.lead?'var(--bad)':'var(--warn)'}}>{Math.round(l.cover)}d</td>
          <td style={{...td,textAlign:'right',fontWeight:700,color:'var(--text-primary)'}}>{NUM(l.qty)}</td>
          <td style={{...td,textAlign:'right'}}>{l.unitCost!=null ? '£'+l.unitCost : <input type="number" step="0.01" defaultValue="" placeholder="quote" title="Add the quoted unit price" onBlur={e=>{ if(e.target.value!=='') setSkuPrice(l.key, e.target.value); }} style={{...inp,width:62,textAlign:'right'}}/>}</td>
          <td style={{...td,textAlign:'right'}}>{l.lineCost!=null?'£'+l.lineCost.toFixed(2):<span style={{color:'var(--warn)',fontSize:11}}>TBC</span>}</td>
        </tr>))}
      </tbody></table></div>
    </div>))}

    {/* awaiting stock — POs already raised; informational, NOT a reminder */}
    {awaiting.length>0 && (<div className="card" style={{borderLeft:'3px solid var(--accent)'}}>
      <div style={{display:'flex',alignItems:'baseline',gap:8,marginBottom:8}}><Icon name="check" size={14} style={{color:'var(--accent)'}}/><span style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>Awaiting stock</span><span className="muted" style={{fontSize:12}}>· {awaiting.length} PO line{awaiting.length===1?'':'s'} raised — waiting for stock to land in Shopify</span></div>
      <div style={{overflowX:'auto'}}><table style={{borderCollapse:'collapse',width:'100%',minWidth:520}}><thead><tr>
        <th style={th}>Product</th><th style={{...th,textAlign:'right'}}>Ordered</th><th style={th}>Raised</th><th style={th}>Expected</th><th style={{...th,textAlign:'right'}}></th>
      </tr></thead><tbody>
        {awaiting.map((l,idx)=>(<tr key={idx}>
          <td style={{...td,color:'var(--text-primary)'}}>{l.p.title}<div style={{fontSize:10.5,color:'var(--text-faint)'}}>{l.supplier}{l.overdue?' · overdue — chase supplier':''}</div></td>
          <td style={{...td,textAlign:'right',fontWeight:700,color:'var(--text-primary)'}}>{NUM((l.po&&l.po.qty)||l.qty)}</td>
          <td style={td}>{(l.po&&l.po.raisedAt)||'—'}</td>
          <td style={{...td,color:l.overdue?'var(--warn)':'var(--text-secondary)'}}>{l.expected||'—'}</td>
          <td style={{...td,textAlign:'right',whiteSpace:'nowrap'}}>
            <button style={{...smbtn,padding:'4px 9px'}} onClick={()=>{ setPoStatus(l.key,{status:'received', baselineQty:l.p.inventoryQty||0, receivedAt:oiToday()}); toast('Marked received', {kind:'good', body:l.p.title}); }}>Received</button>
            <button style={{...smbtn,padding:'4px 9px',marginLeft:6,background:'transparent',color:'var(--text-muted)'}} onClick={()=>{ clearPoStatus(l.key); toast('PO cancelled', {body:l.p.title}); }}>Cancel</button>
          </td>
        </tr>))}
      </tbody></table></div>
      <div style={{fontSize:11,color:'var(--text-faint)',marginTop:9,lineHeight:1.5}}>These won't show as reminders. Each auto-closes when its Shopify stock rises on the next data sync — or mark it received manually.</div>
    </div>)}

    {pos.length===0 && awaiting.length===0 && (<div className="card"><div style={{display:'flex',alignItems:'center',gap:10}}><StatusBadge kind="healthy" label="Stock healthy"/><span className="muted" style={{fontSize:13}}>No products are within their reorder window right now. {approaching>0?`${approaching} will cross it soon — check back, or tighten the safety days.`:'Good sellers all have enough cover for their lead times.'}</span></div></div>)}
  </div>);
}

// ── Forecast & demand planner ────────────────────────────────────────────────
// You set a forecast (growth on the run-rate, or a top-down units/revenue target
// for the horizon); the app converts it to a per-product demand plan off live
// velocity, then rolls total demand into packaging requirements via an editable
// bill-of-materials. Flags products that will stock out under the plan.
function DemandPlanner({embedded}={}){
  usePlanningTick();
  const B = (typeof window!=='undefined' && window.FRKL_BUSINESS) || {};
  const inv = (B.inventory||[]).filter(p=>p && p.status!=='ARCHIVED');
  const del = delistAll();
  const sellers = inv.filter(p=>(p.dailyVelocity||0)>0 && !del[p.sku||p.title]);
  const delistedCount = inv.filter(p=>(p.dailyVelocity||0)>0 && del[p.sku||p.title]).length;
  const [showDelisted, setShowDelisted] = useState(false);
  const rc = reorderConfig(); const safety = Number(rc.safetyDays)||14;

  const dc0 = demandConfig();
  const [months, setMonths] = useState(dc0.months||3);
  const [growth, setGrowth] = useState(dc0.growth!=null?String(dc0.growth):'0');
  const [targetMode, setTargetMode] = useState(dc0.targetMode||'growth');
  const [targetValue, setTargetValue] = useState(dc0.targetValue!=null?String(dc0.targetValue):'');
  const [shape, setShape] = useState(dc0.shape||'even');
  const [startMonth, setStartMonth] = useState(dc0.startMonth||'');
  const [monthly, setMonthly] = useState(()=>Array.isArray(dc0.monthly)?dc0.monthly.map(v=>v==null?'':String(v)):[]);
  const [focus, setFocus] = useState(()=>Array.isArray(dc0.focus)?dc0.focus:[]);
  const [showAll, setShowAll] = useState(false);
  const [packOpen, setPackOpen] = useState(false);
  React.useEffect(()=>{ saveDemandConfig({months, growth:Number(growth)||0, targetMode, targetValue, shape, startMonth, monthly, focus}); }, [months, growth, targetMode, targetValue, shape, startMonth, monthly, focus]);
  const setMonth = (i,v)=> setMonthly(prev=> Array.from({length:months}, (_,j)=> j===i ? v : (prev[j]!=null?prev[j]:'')));
  const addFocus = ()=> setFocus(f=>[...f, {key:'', mult:'2', label:'', month:''}]);
  const setFoc = (i,field,v)=> setFocus(f=>f.map((e,j)=>j===i?{...e,[field]:v}:e));
  const rmFocus = (i)=> setFocus(f=>f.filter((_,j)=>j!==i));

  const k = v=>{ v=Math.round(v); const a=Math.abs(v); return a>=1000?(v/1000).toFixed(a>=10000?0:1).replace(/\.0$/,'')+'k':''+v; };
  const horizonDays = months*30.4;
  const revMap={}; (B.products||[]).forEach(p=>{ if(p.sku && p.units>0) revMap[p.sku]=p.netSales/p.units; });
  const fallbackRev = (B.productSummary&&B.productSummary.singles&&B.productSummary.singles.aovPerUnit)||37;
  const revPerUnit = p=> (p.sku&&revMap[p.sku]!=null)?revMap[p.sku]:fallbackRev;
  const baseUnits = p=> p.dailyVelocity*horizonDays;
  const focusM = p=> focusMultFor(p, focus, months);         // product-focus / promotion weight
  const baseTotal = sellers.reduce((t,p)=>t+baseUnits(p),0);                 // raw
  const baseRev = sellers.reduce((t,p)=>t+baseUnits(p)*revPerUnit(p),0);     // raw
  const baseTotalF = sellers.reduce((t,p)=>t+baseUnits(p)*focusM(p),0);      // focus-weighted
  const baseRevF = sellers.reduce((t,p)=>t+baseUnits(p)*focusM(p)*revPerUnit(p),0);
  // month-by-month shaping: blank month = run-rate baseline; total drives the scale
  const byMonth = shape==='month' && targetMode!=='growth';
  const baseMo = targetMode==='units' ? baseTotal/months : baseRev/months;
  const monthTarget = i => { const v=monthly[i]; return (v!=null&&v!=='')?(Number(v)||0):baseMo; };
  const monthlyArr = Array.from({length:months}, (_,i)=> monthTarget(i));
  const monthlySum = monthlyArr.reduce((a,b)=>a+b,0);
  let scale=1;
  if(targetMode==='growth') scale = 1+(Number(growth)||0)/100;
  else { const target = byMonth ? monthlySum : Number(targetValue);     // normalise vs focus-weighted baseline
    if(targetMode==='units' && target>0 && baseTotalF>0) scale = target/baseTotalF;
    else if(targetMode==='revenue' && target>0 && baseRevF>0) scale = target/baseRevF; }
  const planUnits = p=> baseUnits(p)*focusM(p)*scale;
  const totalUnits = baseTotalF*scale;
  const totalRev = baseRevF*scale;
  const impliedGrowth = baseTotal>0 ? (totalUnits/baseTotal-1)*100 : (scale-1)*100;
  // per-month breakdown (units + revenue) for the shaped plan
  const uPerRev = baseRev>0 ? baseTotal/baseRev : 0;     // units per £ at the baseline mix
  const revPerU = baseTotal>0 ? baseRev/baseTotal : 0;   // blended £ per unit
  const monthlyPlan = Array.from({length:months}, (_,i)=>{
    const tgt = monthTarget(i);
    const mRev = targetMode==='units' ? tgt*revPerU : tgt;
    const mUnits = targetMode==='units' ? tgt : tgt*uPerRev;
    return {i, label:oiMonthLabel(startMonth, i), units:mUnits, rev:mRev, set: monthly[i]!=null&&monthly[i]!==''};
  });
  const maxMonthRev = Math.max(1, ...monthlyPlan.map(m=>m.rev));

  const _lrc = reorderConfig(); const _ldir = suppliersAll();   // global transit default + per-supplier overrides
  const rows = sellers.map(p=>{ const plan=planUnits(p); const stock=p.inventoryQty||0; const end=stock-plan;
    const dayVel = plan/horizonDays;                          // planned units/day (incl. focus)
    const _sm = supplierForSku(p);                            // per-SKU lead (order→ship), else type default
    const leadSet = (_sm.lead!=null&&_sm.lead!=='');          // is there an explicit per-SKU lead?
    const leadDefault = leadDaysForType(p.type);              // type-level fallback
    const leadMake = leadSet ? Number(_sm.lead) : leadDefault;
    const _sn = (_sm.supplier&&String(_sm.supplier).trim())||''; const _de = _sn ? (_ldir[_sn]||{}) : {};
    const leadShip = (_de.shipDays!=null&&_de.shipDays!=='') ? Number(_de.shipDays) : (Number(_lrc.shipDays)||0);   // ship→land transit
    const lead = leadMake + leadShip;                        // order → in stock — same basis as the PO engine
    const daysToOOS = dayVel>0 ? stock/dayVel : Infinity;     // days of cover at the planned rate
    const oosBeforeLead = daysToOOS < lead;                   // runs out before a reorder placed today lands
    const oosGap = oosBeforeLead ? Math.round(lead-daysToOOS) : 0;
    return {p, runMo:p.dailyVelocity*30.4, plan, stock, end, short:end<0, lead, leadMake, leadShip, leadSet, leadDefault, daysToOOS, oosBeforeLead, oosGap}; })
    .sort((a,b)=>b.plan-a.plan);
  const stockouts = rows.filter(r=>r.short).length;
  const oosRisk = rows.filter(r=>r.oosBeforeLead).length;     // can't be saved by ordering today
  const toProduce = rows.filter(r=>r.short).reduce((t,r)=>t+(-r.end),0);
  const shown = showAll?rows:rows.slice(0,12);
  // link each forecast row to the PO it triggers under the saved strategy
  const RR = planReorder(); const orderByKey={}; RR.lines.forEach(l=>{ orderByKey[l.key]=l; });
  const orderFor = p => orderByKey[p.sku||p.title] || null;

  // packaging
  const pack = packagingConfig();
  const aipo = Number(pack.avgItemsPerOrder)||1.3;
  const orders = aipo>0?totalUnits/aipo:0;
  const compNeeds = pack.components.map(c=>({name:c.name, perItem:Number(c.perItem)||0, perOrder:Number(c.perOrder)||0, qty:(Number(c.perItem)||0)*totalUnits + (Number(c.perOrder)||0)*orders}));
  const [packDraft, setPackDraft] = useState(()=>({ avgItemsPerOrder:String(pack.avgItemsPerOrder), components:pack.components.map(c=>({name:c.name, perItem:String(c.perItem), perOrder:String(c.perOrder), onHand:c.onHand===''?'':String(c.onHand), supplier:c.supplier||'', moq:c.moq===''?'':String(c.moq), unitCost:c.unitCost===''?'':String(c.unitCost), leadDays:String(c.leadDays!=null?c.leadDays:30)})) }));
  const setComp=(i,f,v)=>setPackDraft(d=>({...d, components:d.components.map((c,j)=>j===i?{...c,[f]:v}:c)}));
  const addComp=()=>setPackDraft(d=>({...d, components:[...d.components, {name:'New component', perItem:'0', perOrder:'0', onHand:'', supplier:'', moq:'', unitCost:'', leadDays:'30'}]}));
  const rmComp=(i)=>setPackDraft(d=>({...d, components:d.components.filter((_,j)=>j!==i)}));
  const savePack=()=>{ savePackagingConfig({avgItemsPerOrder:Number(packDraft.avgItemsPerOrder)||1.3, components:packDraft.components.filter(c=>c.name&&c.name.trim()).map(c=>({name:c.name.trim(), perItem:Number(c.perItem)||0, perOrder:Number(c.perOrder)||0, onHand:c.onHand==='' ? '' : (Number(c.onHand)||0), supplier:(c.supplier||'').trim(), moq:c.moq==='' ? '' : (Number(c.moq)||0), unitCost:c.unitCost==='' ? '' : (Number(c.unitCost)||0), leadDays:Number(c.leadDays)||30}))}); setPackOpen(false); toast('Packaging plan saved', {kind:'good'}); };

  const btn = {display:'inline-flex',alignItems:'center',gap:6,fontSize:12.5,fontWeight:600,padding:'7px 13px',borderRadius:8,border:'1px solid var(--border-default)',background:'var(--bg-elevated)',color:'var(--text-primary)',cursor:'pointer'};
  const seg = (active)=>({...btn, padding:'6px 12px', background:active?'var(--accent)':'var(--bg-elevated)', color:active?'#fff':'var(--text-secondary)', borderColor:active?'var(--accent)':'var(--border-default)'});
  const inp = {padding:'6px 9px',borderRadius:7,border:'1px solid var(--border-default)',background:'var(--bg-base)',color:'var(--text-primary)',fontSize:13};
  const th = {textAlign:'left',fontSize:10.5,fontWeight:700,letterSpacing:'.04em',textTransform:'uppercase',color:'var(--text-faint)',padding:'0 10px 7px 0',whiteSpace:'nowrap'};
  const td = {padding:'7px 10px 7px 0',fontSize:12.5,color:'var(--text-secondary)',borderTop:'1px solid var(--border-subtle)'};

  const exportPlan = ()=>{
    const rowsCsv=[['Product','SKU','Type','Run-rate (u/mo)','Planned units','Current stock','Projected end stock']];
    rows.forEach(r=>rowsCsv.push([r.p.title, r.p.sku||'', r.p.type||'', Math.round(r.runMo), Math.ceil(r.plan), r.stock, Math.round(r.end)]));
    rowsCsv.push([], ['PACKAGING','','','','','','']);
    compNeeds.forEach(c=>rowsCsv.push([c.name,'','','','',Math.ceil(c.qty),'']));
    const csv=rowsCsv.map(r=>r.map(c=>{const s=String(c==null?'':c); return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s;}).join(',')).join('\n');
    try{ const blob=new Blob([csv],{type:'text/csv'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download='demand_plan_'+months+'mo.csv'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000); toast('Demand plan exported', {kind:'good'}); }catch(e){ toast('Export failed',{kind:'bad'}); }
  };

  return (<div>
    {!embedded && (<><div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:10,flexWrap:'wrap',marginBottom:6}}>
      <h2 style={{margin:0,fontSize:18}}>Forecast &amp; demand plan</h2>
      <span className="muted" style={{fontSize:12}}>Per-product demand + packaging from live velocity · independent of the date picker</span>
    </div>
    <PlanningHeader active="forecast"/></>)}

    {/* plan controls */}
    <div className="card">
      <div style={{display:'flex',gap:18,flexWrap:'wrap',alignItems:'flex-end'}}>
        <div><div style={{fontSize:11.5,fontWeight:600,color:'var(--text-secondary)',marginBottom:5}}>Horizon</div>
          <div style={{display:'flex',gap:6}}>{[1,3,6,12].map(m=>(<button key={m} style={seg(months===m)} onClick={()=>setMonths(m)}>{m}mo</button>))}</div></div>
        <div><div style={{fontSize:11.5,fontWeight:600,color:'var(--text-secondary)',marginBottom:5}}>Plan basis</div>
          <div style={{display:'flex',gap:6}}>
            <button style={seg(targetMode==='growth')} onClick={()=>setTargetMode('growth')}>Growth %</button>
            <button style={seg(targetMode==='units')} onClick={()=>setTargetMode('units')}>Units target</button>
            <button style={seg(targetMode==='revenue')} onClick={()=>setTargetMode('revenue')}>Revenue target</button>
          </div></div>
        {targetMode!=='growth' && <div><div style={{fontSize:11.5,fontWeight:600,color:'var(--text-secondary)',marginBottom:5}}>Shape</div>
          <div style={{display:'flex',gap:6}}>
            <button style={seg(shape==='even')} onClick={()=>setShape('even')}>Even</button>
            <button style={seg(shape==='month')} onClick={()=>setShape('month')}>By month</button>
          </div></div>}
        <div>
          {targetMode==='growth'
            ? <label style={{display:'flex',flexDirection:'column',fontSize:11.5,fontWeight:600,color:'var(--text-secondary)',gap:5}}>Growth vs run-rate (%)<input type="number" style={{...inp,width:120}} value={growth} onChange={e=>setGrowth(e.target.value)}/></label>
            : byMonth
            ? <label style={{display:'flex',flexDirection:'column',fontSize:11.5,fontWeight:600,color:'var(--text-secondary)',gap:5}}>Start month<input type="month" style={{...inp,width:150}} value={startMonth} onChange={e=>setStartMonth(e.target.value)}/></label>
            : <label style={{display:'flex',flexDirection:'column',fontSize:11.5,fontWeight:600,color:'var(--text-secondary)',gap:5}}>{targetMode==='units'?'Total units target':'Total revenue target (£)'}<input type="number" style={{...inp,width:150}} value={targetValue} onChange={e=>setTargetValue(e.target.value)} placeholder={targetMode==='units'?'e.g. 1200':'e.g. 60000'}/></label>}
        </div>
        <button style={{...btn,marginLeft:'auto'}} onClick={exportPlan}><Icon name="report" size={13}/> Export plan</button>
      </div>

      {byMonth && (<div style={{marginTop:14}}>
        <div style={{fontSize:11,fontWeight:700,letterSpacing:'.05em',textTransform:'uppercase',color:'var(--text-muted)',marginBottom:8}}>Monthly plan — set each month ({targetMode==='units'?'units':'£ revenue'}); blank = run-rate</div>
        <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
          {monthlyPlan.map((m,i)=>(<div key={i} style={{minWidth:118,flex:'1 1 118px',maxWidth:170,border:'1px solid var(--border-subtle)',borderRadius:9,padding:'9px 11px',background:'var(--bg-elevated)'}}>
            <div style={{fontSize:12,fontWeight:700,color:'var(--text-primary)',marginBottom:5}}>{m.label}</div>
            <input type="number" style={{...inp,width:'100%',boxSizing:'border-box'}} value={monthly[i]!=null?monthly[i]:''} onChange={e=>setMonth(i,e.target.value)} placeholder={(targetMode==='units'?'':'£')+NUM(Math.round(baseMo))}/>
            <div style={{height:30,display:'flex',alignItems:'flex-end',marginTop:7}}><div style={{width:'100%',height:Math.max(3,Math.round(28*m.rev/maxMonthRev)),background:m.set?'var(--accent)':'var(--border-default)',borderRadius:'3px 3px 0 0'}}/></div>
            <div style={{fontSize:10.5,color:'var(--text-faint)',marginTop:4}}>{NUM(Math.ceil(m.units))} u · £{k(m.rev)}</div>
          </div>))}
        </div>
      </div>)}

      <div style={{fontSize:11.5,color:'var(--text-faint)',marginTop:11,lineHeight:1.5}}>Baseline is each product's 90-day sales velocity over {months} month{months===1?'':'s'} ({sellers.length} active sellers). {byMonth ? `Month-by-month plan totals ${targetMode==='units'?NUM(Math.ceil(monthlySum))+' units':'£'+k(monthlySum)} — ${impliedGrowth>=0?'+':''}${impliedGrowth.toFixed(0)}% vs run-rate, allocated across products by historic mix.` : (targetMode!=='growth' && Number(targetValue)>0 ? `Your target implies ${impliedGrowth>=0?'+':''}${impliedGrowth.toFixed(0)}% vs the run-rate, allocated by historic mix.` : 'Growth is applied evenly on top of each run-rate.')} The order timing follows your strategy in Production / POs.</div>
    </div>

    {/* product focus & promotions */}
    <div className="card">
      <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:10,flexWrap:'wrap',marginBottom: focus.length?10:0}}>
        <div><span style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>Product focus &amp; promotions</span> <span className="muted" style={{fontSize:11.5}}>· push specific products or types — re-weights the plan{targetMode!=='growth'?' within your target':' on top of growth'}</span></div>
        <button style={{...btn,fontSize:11.5,padding:'5px 11px'}} onClick={addFocus}>+ Add focus</button>
      </div>
      {focus.length===0
        ? <div className="muted" style={{fontSize:12.5}}>None — the plan follows historic product mix. Add a focus to push a product or type (e.g. a Q4 promo on charms).</div>
        : <div style={{display:'flex',flexDirection:'column',gap:8}}>
            {focus.map((e,i)=>{ const matched = sellers.filter(p=>{ const pid='product:'+(p.sku||p.title), tid='type:'+(p.type||''); return e.key===pid||e.key===tid||e.key==='all'; });
              return (<div key={i} style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap'}}>
                <select value={e.key} onChange={ev=>setFoc(i,'key',ev.target.value)} style={{...inp,minWidth:220}}>
                  <option value="">Choose product or type…</option>
                  <option value="all">All products</option>
                  <optgroup label="Type">{[...new Set(sellers.map(p=>p.type).filter(Boolean))].sort().map(t=><option key={t} value={'type:'+t}>{t}</option>)}</optgroup>
                  <optgroup label="Product">{sellers.slice(0,50).map(p=><option key={p.sku||p.title} value={'product:'+(p.sku||p.title)}>{p.title}</option>)}</optgroup>
                </select>
                <label style={{display:'flex',alignItems:'center',gap:4,fontSize:12,color:'var(--text-secondary)'}}>uplift <input type="number" step="0.1" min="0" value={e.mult} onChange={ev=>setFoc(i,'mult',ev.target.value)} style={{...inp,width:60}}/> ×</label>
                <label style={{display:'flex',alignItems:'center',gap:4,fontSize:12,color:'var(--text-secondary)'}}>in <select value={e.month!=null?e.month:''} onChange={ev=>setFoc(i,'month',ev.target.value)} style={{...inp,width:118}}>
                  <option value="">whole horizon</option>
                  {Array.from({length:months},(_,mi)=><option key={mi} value={String(mi)}>{oiMonthLabel(startMonth, mi)}</option>)}
                </select></label>
                <input value={e.label||''} onChange={ev=>setFoc(i,'label',ev.target.value)} placeholder="label (e.g. BF promo)" style={{...inp,width:140}}/>
                <span style={{fontSize:11,color:'var(--text-faint)'}}>{e.key?`${matched.length} product${matched.length===1?'':'s'}`:''}</span>
                <button style={{...btn,fontSize:11,padding:'4px 9px',color:'var(--text-muted)',marginLeft:'auto'}} onClick={()=>rmFocus(i)}>Remove</button>
              </div>); })}
          </div>}
      {focus.some(e=>e.key&&Number(e.mult)>0&&Number(e.mult)!==1) && <div style={{fontSize:11,color:'var(--text-faint)',marginTop:10,lineHeight:1.5}}>Focused items take a bigger share of the plan and their PO quantities rise to match. {targetMode!=='growth'?'A target is set, so the total stays fixed and the mix shifts toward the focus.':'No target set, so focus adds volume on top of growth.'} A promo set to one month lifts only that month, so its horizon-average weight (the ↑× badge) is smaller. The extra volume is typically lower-margin.</div>}
    </div>

    {/* summary */}
    <div className="card">
      <div style={{display:'flex',gap:24,flexWrap:'wrap',alignItems:'flex-end'}}>
        <div><div style={{fontSize:24,fontWeight:800,color:'var(--text-primary)'}}>{NUM(Math.ceil(totalUnits))}</div><div className="muted" style={{fontSize:11.5}}>units planned · {months}mo</div></div>
        <div><div style={{fontSize:24,fontWeight:800,color:'var(--text-primary)'}}>£{k(totalRev)}</div><div className="muted" style={{fontSize:11.5}}>projected revenue</div></div>
        <div><div style={{fontSize:24,fontWeight:800,color: impliedGrowth>=0?'var(--good)':'var(--bad)'}}>{impliedGrowth>=0?'+':''}{impliedGrowth.toFixed(0)}%</div><div className="muted" style={{fontSize:11.5}}>vs run-rate</div></div>
        <div><div style={{fontSize:24,fontWeight:800,color: stockouts?'var(--warn)':'var(--good)'}}>{stockouts}</div><div className="muted" style={{fontSize:11.5}}>will stock out</div></div>
        <div title="Products that run out before a reorder placed today could arrive, given production lead time"><div style={{fontSize:24,fontWeight:800,color: oosRisk?'var(--bad)':'var(--good)'}}>{oosRisk}</div><div className="muted" style={{fontSize:11.5}}>OOS before lead</div></div>
        {toProduce>0 && <div><div style={{fontSize:24,fontWeight:800,color:'var(--text-primary)'}}>{NUM(Math.ceil(toProduce))}</div><div className="muted" style={{fontSize:11.5}}>units short to produce</div></div>}
      </div>
    </div>

    {/* demand plan table */}
    <div className="card">
      <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',marginBottom:8}}><span style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>Demand plan by product</span><span className="muted" style={{fontSize:11.5}}>sorted by planned demand</span></div>
      <div style={{overflowX:'auto'}}><table style={{borderCollapse:'collapse',width:'100%',minWidth:740}}><thead><tr>
        <th style={th}>Product</th><th style={{...th,textAlign:'right'}}>Run-rate /mo</th><th style={{...th,textAlign:'right'}}>Stock</th><th style={{...th,textAlign:'right'}}>Stockout vs lead</th><th style={{...th,textAlign:'right'}}>Planned ({months}mo)</th><th style={{...th,textAlign:'right'}}>Projected end</th><th style={{...th,textAlign:'right'}}>Order ({STRAT_SHORT[RR.strategy]||'JIT'})</th><th style={th}></th>
      </tr></thead><tbody>
        {shown.map((r,idx)=>{ const o=orderFor(r.p);
          const oCell = !o ? <span style={{color:'var(--text-faint)'}}>—</span>
            : o.poStatus==='ordered' ? <span style={{color:'var(--accent)',fontWeight:600}}>● awaiting</span>
            : (o.needs && o.qty>0) ? <span style={{color:'var(--text-primary)',fontWeight:700}}>{NUM(o.qty)}</span>
            : <span style={{color:'var(--good)'}}>covered</span>;
          return (<tr key={idx}>
          <td style={{...td,color:'var(--text-primary)'}}>{r.p.title}{r.oosBeforeLead && <span style={{marginLeft:6,fontSize:9.5,fontWeight:800,letterSpacing:'.03em',color:'#fff',background:'var(--bad)',padding:'1px 7px',borderRadius:999}}>ORDER TODAY</span>}{focusM(r.p)!==1 && <span style={{marginLeft:6,fontSize:10,fontWeight:700,color:'var(--accent)',background:'var(--accent-bg)',padding:'1px 6px',borderRadius:999}}>↑{(focusM(r.p)%1?focusM(r.p).toFixed(2):focusM(r.p))}×</span>}<div style={{fontSize:10.5,color:'var(--text-faint)'}}>{r.p.type}</div></td>
          <td style={{...td,textAlign:'right'}}>{NUM(Math.round(r.runMo))}</td>
          <td style={{...td,textAlign:'right'}}>{NUM(r.stock)}</td>
          <td style={{...td,textAlign:'right'}}>{r.daysToOOS===Infinity ? <span style={{color:'var(--text-faint)'}}>—</span> : <span style={{fontWeight:600,color: r.oosBeforeLead?'var(--bad)':(r.daysToOOS<r.lead*1.5?'var(--warn)':'var(--text-secondary)')}}>{Math.round(r.daysToOOS)}d{r.oosBeforeLead?` · gap ${r.oosGap}d`:''}</span>}<div style={{fontSize:10,color:'var(--text-faint)',display:'flex',alignItems:'center',gap:3,justifyContent:'flex-end',marginTop:2}}>{!r.leadSet && <span title={`Estimate — using the ${r.p.type||'type'} default of ${r.leadDefault}d. Set this SKU's real supplier lead.`} style={{color:'var(--warn)',fontSize:8,lineHeight:1}}>●</span>}<input type="number" min="0" defaultValue={r.leadSet?r.leadMake:''} key={'ld'+(r.leadSet?r.leadMake:'d')} placeholder={String(r.leadDefault)} title={`Production lead — days from order to shipment (per SKU). Blank uses the ${r.p.type||'type'} default of ${r.leadDefault}d. Set defaults in Reorder policy.`} onBlur={e=>{ if(e.target.value!=='') setSkuLead(skuKeyOf(r.p), e.target.value); }} style={{width:38,padding:'1px 4px',borderRadius:5,border:'1px solid '+(r.leadSet?'var(--border-default)':'var(--warn)'),background:'var(--bg-base)',color:'var(--text-secondary)',fontSize:10,textAlign:'right'}}/><span>d make{r.leadShip>0?` +${r.leadShip} ship = ${r.lead}`:' lead'}</span></div></td>
          <td style={{...td,textAlign:'right',fontWeight:700,color:'var(--text-primary)'}}>{NUM(Math.ceil(r.plan))}</td>
          <td style={{...td,textAlign:'right',fontWeight:600,color: r.short?'var(--bad)':'var(--good)'}}>{r.short?'−'+NUM(Math.ceil(-r.end)):NUM(Math.floor(r.end))}</td>
          <td style={{...td,textAlign:'right'}}>{oCell}</td>
          <td style={{...td,textAlign:'right'}}><button title="Delist — won't be reordered, hide from the plan" style={{fontSize:10.5,color:'var(--text-faint)',background:'none',border:'none',cursor:'pointer',padding:'2px 4px'}} onClick={()=>{ setDelisted(skuKeyOf(r.p), true); toast('Delisted', {body:r.p.title+' — hidden from the plan'}); }}>Delist</button></td>
        </tr>); })}
      </tbody></table></div>
      <div style={{display:'flex',gap:10,alignItems:'center',flexWrap:'wrap',marginTop:10}}>
        {rows.length>12 && <button style={btn} onClick={()=>setShowAll(s=>!s)}>{showAll?'Show top 12':`Show all ${rows.length}`}</button>}
        <button style={{...btn,background:'var(--accent)',color:'#fff',borderColor:'var(--accent)'}} onClick={()=>{ const el=document.getElementById('plan-pos'); if(el) el.scrollIntoView({behavior:'smooth'}); else if(window.__oiNav) window.__oiNav('planning','plan'); }}>Review &amp; raise POs ({RR.toOrder.length}) <Icon name="chevron" size={13}/></button>
        {delistedCount>0 && <button style={{...btn,background:'transparent',color:'var(--text-muted)'}} onClick={()=>setShowDelisted(s=>!s)}>{showDelisted?'Hide delisted':`${delistedCount} delisted`}</button>}
        {rows.filter(r=>!r.leadSet).length>0 && <span style={{display:'inline-flex',alignItems:'center',gap:5,fontSize:11.5,color:'var(--text-faint)'}} title="These products use the type's default lead — set each SKU's real supplier lead (the input in the Stockout-vs-lead column) for accurate order-by dates."><span style={{color:'var(--warn)',fontSize:8}}>●</span>{rows.filter(r=>!r.leadSet).length} on an estimated lead</span>}
      </div>
      {showDelisted && delistedCount>0 && <div style={{marginTop:10,paddingTop:10,borderTop:'1px solid var(--border-subtle)'}}>
        <div style={{fontSize:11,fontWeight:700,letterSpacing:'.04em',textTransform:'uppercase',color:'var(--text-faint)',marginBottom:6}}>Delisted — excluded from the plan &amp; POs</div>
        <div style={{display:'flex',flexWrap:'wrap',gap:8}}>{inv.filter(p=>(p.dailyVelocity||0)>0 && del[p.sku||p.title]).map((p,i)=>(<span key={i} style={{display:'inline-flex',alignItems:'center',gap:6,fontSize:12,color:'var(--text-secondary)',background:'var(--bg-elevated)',border:'1px solid var(--border-subtle)',borderRadius:999,padding:'3px 6px 3px 11px'}}>{p.title}<button style={{fontSize:11,fontWeight:600,color:'var(--accent)',background:'none',border:'none',cursor:'pointer'}} onClick={()=>{ setDelisted(skuKeyOf(p), false); toast('Relisted', {kind:'good', body:p.title}); }}>Relist</button></span>))}</div>
      </div>}
      {(stockouts>0||oosRisk>0) && <div style={{fontSize:11.5,color:'var(--text-faint)',marginTop:9,lineHeight:1.5}}><b>Stockout vs lead</b> is days of cover at the planned rate against production lead time — <span style={{color:'var(--bad)'}}>red</span> means it runs out <b>before</b> a reorder placed today could land ({oosRisk} product{oosRisk===1?'':'s'} · ~{Math.round(rows.filter(r=>r.oosBeforeLead).reduce((t,r)=>t+r.oosGap,0)/Math.max(1,oosRisk))}d avg gap), so it needs ordering now or it'll go OOS. Edit each product's <b>make lead</b> inline in this column (blank = the type default, set in Reorder policy); transit is per-supplier. The <b>Order</b> column is what each triggers under your <b>{STRAT_SHORT[RR.strategy]||'JIT'}</b> strategy. Stock is consumed <b>FIFO</b> — current stock first, on-order isn't counted as available until it lands, so the OOS gap is the real shortfall window.</div>}
    </div>

    {/* packaging requirements */}
    <div className="card">
      <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:10,flexWrap:'wrap',marginBottom:8}}>
        <span style={{fontSize:14,fontWeight:700,color:'var(--text-primary)'}}>Packaging requirements</span>
        <button style={{...btn,fontSize:11.5,padding:'5px 10px'}} onClick={()=>setPackOpen(o=>!o)}><Icon name="sliders" size={12}/> Edit packaging plan</button>
      </div>
      <div className="wc-grid">{compNeeds.map((c,idx)=>(<div key={idx} className="wc-item">
        <div className="wc-top"><span className="wc-label">{c.name}</span></div>
        <div className="wc-val">{NUM(Math.ceil(c.qty))}</div>
        <div style={{fontSize:11,color:'var(--text-faint)',marginTop:6,lineHeight:1.4}}>{c.perItem>0?`${c.perItem}/item`:''}{c.perItem>0&&c.perOrder>0?' · ':''}{c.perOrder>0?`${c.perOrder}/order`:''}{!c.perItem&&!c.perOrder?'not used':''}</div>
      </div>))}</div>
      <div style={{fontSize:11.5,color:'var(--text-faint)',marginTop:10,lineHeight:1.5}}>Based on {NUM(Math.ceil(totalUnits))} units across ≈{NUM(Math.ceil(orders))} orders (at {aipo} items/order). Per-item components scale with units; per-order components scale with orders.</div>
      {packOpen && (<div style={{marginTop:12,borderTop:'1px solid var(--border-subtle)',paddingTop:12}}>
        <div style={{display:'flex',gap:14,flexWrap:'wrap',alignItems:'flex-end',marginBottom:10}}>
          <label style={{display:'flex',flexDirection:'column',fontSize:11.5,fontWeight:600,color:'var(--text-secondary)',gap:4}}>Avg items per order<input type="number" style={{...inp,width:90}} value={packDraft.avgItemsPerOrder} onChange={e=>setPackDraft(d=>({...d,avgItemsPerOrder:e.target.value}))}/></label>
        </div>
        <div style={{overflowX:'auto'}}><table style={{borderCollapse:'collapse',width:'100%',minWidth:760}}><thead><tr><th style={th}>Component</th><th style={th}>Per item</th><th style={th}>Per order</th><th style={th}>On hand</th><th style={th}>Supplier</th><th style={th}>MOQ</th><th style={th}>£/unit</th><th style={th}>Lead d</th><th style={th}></th></tr></thead><tbody>
          {packDraft.components.map((c,idx)=>(<tr key={idx}>
            <td style={td}><input style={{...inp,width:150}} value={c.name} onChange={e=>setComp(idx,'name',e.target.value)}/></td>
            <td style={td}><input type="number" step="0.1" style={{...inp,width:60}} value={c.perItem} onChange={e=>setComp(idx,'perItem',e.target.value)}/></td>
            <td style={td}><input type="number" step="0.1" style={{...inp,width:60}} value={c.perOrder} onChange={e=>setComp(idx,'perOrder',e.target.value)}/></td>
            <td style={td}><input type="number" style={{...inp,width:74}} value={c.onHand} onChange={e=>setComp(idx,'onHand',e.target.value)} placeholder="untracked"/></td>
            <td style={td}><input style={{...inp,width:120}} value={c.supplier} onChange={e=>setComp(idx,'supplier',e.target.value)} placeholder="Supplier"/></td>
            <td style={td}><input type="number" style={{...inp,width:64}} value={c.moq} onChange={e=>setComp(idx,'moq',e.target.value)} placeholder="0"/></td>
            <td style={td}><input type="number" step="0.01" style={{...inp,width:64}} value={c.unitCost} onChange={e=>setComp(idx,'unitCost',e.target.value)} placeholder="—"/></td>
            <td style={td}><input type="number" style={{...inp,width:56}} value={c.leadDays} onChange={e=>setComp(idx,'leadDays',e.target.value)}/></td>
            <td style={td}><button style={{...btn,fontSize:11,padding:'4px 9px',color:'var(--text-muted)'}} onClick={()=>rmComp(idx)}>Remove</button></td>
          </tr>))}
        </tbody></table></div>
        <div style={{fontSize:11,color:'var(--text-faint)',marginTop:8,lineHeight:1.5}}>Set <b>On hand</b> to enable packaging reorder POs — they appear in Production / POs and the Actions queue under your chosen ordering strategy. Leave it blank to track the requirement only.</div>
        <div style={{marginTop:10,display:'flex',gap:8}}><button style={btn} onClick={savePack}>Save packaging plan</button><button style={btn} onClick={addComp}>+ Add component</button><button style={{...btn,background:'transparent',color:'var(--text-muted)'}} onClick={()=>setPackOpen(false)}>Cancel</button></div>
      </div>)}
    </div>
  </div>);
}

// ── Suppliers directory — tracked suppliers + full contact details ───────────
function SuppliersDirectory(){
  usePlanningTick();
  const names = supplierNamesInUse();
  const sk = skuSupplierAll();
  const skuCount = {}; Object.keys(sk).forEach(k=>{ const n=sk[k]&&sk[k].supplier&&String(sk[k].supplier).trim(); if(n) skuCount[n]=(skuCount[n]||0)+1; });
  const [draft, setDraft] = useState(()=>{ const all=suppliersAll(), d={}; names.forEach(n=>{ const s=all[n]||{}; d[n]={email:s.email||'', phone:s.phone||'', address:s.address||'', notes:s.notes||'', depositPct:s.depositPct!=null?String(s.depositPct):'', shipDays:s.shipDays!=null?String(s.shipDays):''}; }); return d; });
  const [newName, setNewName] = useState('');
  const rows = [...new Set([...names, ...Object.keys(draft)])].sort((a,b)=>a.localeCompare(b));
  const _blank = {email:'',phone:'',address:'',notes:'',depositPct:'',shipDays:''};
  const set = (n,f,v)=>setDraft(d=>({...d,[n]:{...(d[n]||_blank),[f]:v}}));
  const save = ()=>{ const all={...suppliersAll()}; Object.keys(draft).forEach(n=>{ const x=draft[n]||{}; all[n]={name:n, email:x.email||'', phone:x.phone||'', address:x.address||'', notes:x.notes||'', depositPct:x.depositPct===''||x.depositPct==null?'':Number(x.depositPct), shipDays:x.shipDays===''||x.shipDays==null?'':Number(x.shipDays)}; }); saveSuppliersAll(all); toast('Suppliers saved', {kind:'good'}); };
  const add = ()=>{ const n=newName.trim(); if(!n) return; setDraft(d=>d[n]?d:({...d,[n]:{..._blank}})); registerSupplier(n); setNewName(''); };
  const btn = {display:'inline-flex',alignItems:'center',gap:6,fontSize:12.5,fontWeight:600,padding:'7px 13px',borderRadius:8,border:'1px solid var(--border-default)',background:'var(--bg-elevated)',color:'var(--text-primary)',cursor:'pointer'};
  const inp = {padding:'6px 9px',borderRadius:7,border:'1px solid var(--border-default)',background:'var(--bg-base)',color:'var(--text-primary)',fontSize:13};
  const th = {textAlign:'left',fontSize:10.5,fontWeight:700,letterSpacing:'.04em',textTransform:'uppercase',color:'var(--text-faint)',padding:'0 10px 7px 0',whiteSpace:'nowrap'};
  const td = {padding:'8px 10px 8px 0',fontSize:12.5,color:'var(--text-secondary)',borderTop:'1px solid var(--border-subtle)',verticalAlign:'top'};
  return (<div>
    <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:10,flexWrap:'wrap',marginBottom:6}}>
      <h2 style={{margin:0,fontSize:18}}>Suppliers</h2>
      <span className="muted" style={{fontSize:12}}>Your manufacturer directory — contact details flow onto every PO</span>
    </div>
    <div className="card">
      <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:12}}>
        <input value={newName} onChange={e=>setNewName(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter') add(); }} placeholder="New supplier name…" style={{...inp,width:240}}/>
        <button style={btn} onClick={add}><Icon name="check" size={13}/> Add supplier</button>
        <button style={{...btn,marginLeft:'auto',background:'var(--accent)',color:'#fff',borderColor:'var(--accent)'}} onClick={save}>Save all</button>
      </div>
      {rows.length ? (<div style={{overflowX:'auto'}}><table style={{borderCollapse:'collapse',width:'100%',minWidth:980}}><thead><tr><th style={th}>Supplier</th><th style={{...th,textAlign:'right'}}>SKUs</th><th style={th}>Email</th><th style={th}>Phone</th><th style={th}>Address</th><th style={th} title="Deposit paid at order; the balance falls due at shipment">Deposit&nbsp;%</th><th style={th} title="Transit days from shipment to stock landing — added on top of the production lead">Transit&nbsp;d</th><th style={th}>Notes / terms</th></tr></thead><tbody>
        {rows.map(n=>{ const d=draft[n]||_blank; return (<tr key={n}>
          <td style={{...td,color:'var(--text-primary)',fontWeight:600}}>{n}</td>
          <td style={{...td,textAlign:'right',color:'var(--text-faint)'}}>{skuCount[n]||0}</td>
          <td style={td}><input type="email" style={{...inp,width:170}} value={d.email} onChange={e=>set(n,'email',e.target.value)} placeholder="orders@supplier.com"/></td>
          <td style={td}><input style={{...inp,width:110}} value={d.phone} onChange={e=>set(n,'phone',e.target.value)} placeholder="+44…"/></td>
          <td style={td}><input style={{...inp,width:160}} value={d.address} onChange={e=>set(n,'address',e.target.value)} placeholder="address"/></td>
          <td style={td}><input type="number" style={{...inp,width:62}} value={d.depositPct} onChange={e=>set(n,'depositPct',e.target.value)} placeholder="100"/></td>
          <td style={td}><input type="number" style={{...inp,width:56}} value={d.shipDays} onChange={e=>set(n,'shipDays',e.target.value)} placeholder="0"/></td>
          <td style={td}><input style={{...inp,width:160}} value={d.notes} onChange={e=>set(n,'notes',e.target.value)} placeholder="terms · ref · MOQ notes"/></td>
        </tr>); })}
      </tbody></table></div>) : <div className="muted" style={{fontSize:13}}>No suppliers yet. Add one above, or assign a supplier to a product in the planning Supplier master — it'll appear here to flesh out.</div>}
      <div style={{fontSize:11,color:'var(--text-faint)',marginTop:10,lineHeight:1.5}}>Suppliers are referenced by name from each SKU. SKU-specific MOQ, unit cost &amp; production lead live in the planning Supplier master. <b>Deposit %</b> is what's payable upfront (balance on shipment) and <b>Transit d</b> is the shipping time added after production — both flow into the stock landing plan. Blank = the global default in Reorder policy. Contact details here are shared across every SKU that supplier makes and appear on the draft PO.</div>
    </div>
  </div>);
}

// ── Cash impact of the plan — projects the bank balance forward over the horizon,
// layering the lumpy PO payments (deposits on order, balances on shipment) on top of
// projected revenue, overheads & ad spend. Answers "can I afford this plan?" by
// surfacing the cash trough. Cash basis: revenue in at gross, stock paid via the POs
// (so COGS isn't double-counted), opex = overheads + ad spend. Excludes tax/one-offs.
function CashFlowPlan({tranches, plan, months}){
  usePlanningTick();
  const cf = cashConfig();
  const [cashD,setCashD] = useState(cf.cash);
  const [ovD,setOvD] = useState(cf.overheads);
  const [adD,setAdD] = useState(cf.adSpend);
  const commit = ()=>saveCashConfig({...cashConfig(), cash:cashD, overheads:ovD, adSpend:adD});
  const k = v=>{ const n=Math.abs(Math.round(v)); const s=n>=1000?(n/1000).toFixed(n>=10000?0:1).replace(/\.0$/,'')+'k':''+n; return (v<0?'-£':'£')+s; };
  const today = oiToday();
  const startCash = parseFloat(cashD); const cashKnown = isFinite(startCash);
  const overM = parseFloat(ovD)||0, adM = parseFloat(adD)||0;
  const monthlyRev = (plan && plan.revenue>0 ? plan.revenue : 0)/Math.max(1,months);   // gross, spread evenly
  // bucket PO payments into months from today: deposit at order date, balance at shipment
  const moIdx = iso => Math.max(0, Math.floor(oiDayDiff(today, iso)/30.4));
  const pays = [];
  (tranches||[]).forEach(t=>{ const od=(t.isNow||t.late)?today:t.orderISO; if(t.dep>0) pays.push({m:moIdx(od), v:t.dep}); if(t.bal>0) pays.push({m:moIdx(t.shipISO), v:t.bal}); });
  const lastPayMonth = pays.reduce((mx,p)=>Math.max(mx,p.m),0);
  const projLen = Math.max(months, lastPayMonth+1, 2);
  const poByMonth = Array.from({length:projLen},()=>0); pays.forEach(p=>{ poByMonth[Math.min(p.m,projLen-1)] += p.v; });
  const monName = i => { try{ const y=+today.slice(0,4), m=+today.slice(5,7)-1; return new Date(y, m+i, 1).toLocaleDateString('en-GB',{month:'short'}); }catch(e){ return 'M'+(i+1); } };
  let bal = cashKnown?startCash:0; const series=[];
  for(let i=0;i<projLen;i++){ const stock=poByMonth[i]||0; const net=monthlyRev-overM-adM-stock; bal+=net; series.push({i, label:monName(i), rev:monthlyRev, opex:overM+adM, stock, net, bal}); }
  let trough=series[0]; series.forEach(s=>{ if(s.bal<trough.bal) trough=s; });
  const totalStock = pays.reduce((t,p)=>t+p.v,0);
  // chart geometry — SVG line via currentColor (CSS var() doesn't work in SVG attrs)
  const W=720,H=168,padL=46,padR=14,padT=16,padB=24, innerW=W-padL-padR, innerH=H-padT-padB;
  const vals = series.map(s=>s.bal).concat([0, cashKnown?startCash:0]);
  let lo=Math.min(...vals), hi=Math.max(...vals); if(lo===hi){lo-=1;hi+=1;} const padv=(hi-lo)*0.14||1; lo-=padv; hi+=padv;
  const X = i => padL + (projLen>1? i/(projLen-1):0.5)*innerW;
  const Y = v => padT + (1-(v-lo)/(hi-lo))*innerH;
  const linePath = series.map((s,i)=>`${i?'L':'M'}${X(i).toFixed(1)} ${Y(s.bal).toFixed(1)}`).join(' ');
  const areaPath = linePath+` L${X(projLen-1).toFixed(1)} ${Y(lo).toFixed(1)} L${X(0).toFixed(1)} ${Y(lo).toFixed(1)} Z`;
  const zeroIn = lo<0 && hi>0;
  const inp = {padding:'5px 8px',borderRadius:7,border:'1px solid var(--border-default)',background:'var(--bg-base)',color:'var(--text-primary)',fontSize:13,width:110};
  const lab = {fontSize:10,fontWeight:700,letterSpacing:'.05em',textTransform:'uppercase',color:'var(--text-faint)',marginBottom:5};
  const tone = !cashKnown ? 'var(--text-secondary)' : trough.bal<0 ? 'var(--bad)' : trough.bal < Math.max(overM*1.5, (cashKnown?startCash*0.2:0)) ? 'var(--warn)' : 'var(--good)';
  const verdict = !cashKnown
    ? <>Add your <b>cash on hand</b> for a real balance. From today, committing this plan swings cash to a low of <b>{k(trough.bal)}</b> around <b>{trough.label}</b>.</>
    : trough.bal<0 ? <>This plan takes cash <b style={{color:'var(--bad)'}}>negative — down to {k(trough.bal)}</b> in <b>{trough.label}</b>. Stagger the orders (Staged / front-load less), renegotiate deposit terms, or raise funding before committing.</>
    : trough.bal < Math.max(overM*1.5, startCash*0.2) ? <>Cash dips to a <b style={{color:'var(--warn)'}}>tight {k(trough.bal)}</b> in <b>{trough.label}</b> — under ~{(trough.bal/Math.max(1,overM)).toFixed(1)} months of overheads. Workable, but little headroom.</>
    : <>Cash stays healthy — the low point is <b style={{color:'var(--good)'}}>{k(trough.bal)}</b> in <b>{trough.label}</b>. This plan is affordable.</>;
  return (<div className="card" style={{marginBottom:14, borderLeft:'3px solid '+tone}}>
    <div style={{display:'flex',alignItems:'baseline',gap:10,flexWrap:'wrap',marginBottom:6}}>
      <div style={{fontSize:14,fontWeight:800,color:'var(--text-primary)'}}>Cash impact of this plan</div>
      <span className="muted" style={{fontSize:11.5}}>projected balance over {projLen} months · stock payments on their due dates</span>
    </div>
    <div style={{fontSize:13,color:'var(--text-secondary)',marginBottom:12,lineHeight:1.5}}>{verdict}</div>
    {/* assumptions */}
    <div style={{display:'flex',gap:16,flexWrap:'wrap',marginBottom:14}}>
      <label style={{display:'flex',flexDirection:'column',gap:4}}><span style={lab}>Cash on hand (£)</span><input type="number" value={cashD} onChange={e=>setCashD(e.target.value)} onBlur={commit} placeholder="e.g. 80000" style={inp}/></label>
      <label style={{display:'flex',flexDirection:'column',gap:4}}><span style={lab}>Monthly overheads (£)</span><input type="number" value={ovD} onChange={e=>setOvD(e.target.value)} onBlur={commit} placeholder="e.g. 12000" style={inp}/></label>
      <label style={{display:'flex',flexDirection:'column',gap:4}}><span style={lab}>Monthly ad spend (£)</span><input type="number" value={adD} onChange={e=>setAdD(e.target.value)} onBlur={commit} placeholder="e.g. 15000" style={inp}/></label>
      <div style={{display:'flex',flexDirection:'column',gap:4}}><span style={lab}>Revenue in / mo</span><span style={{fontSize:15,fontWeight:700,color:'var(--good)'}}>{monthlyRev>0?k(monthlyRev):'—'}</span></div>
      <div style={{display:'flex',flexDirection:'column',gap:4}}><span style={lab}>Stock to pay (total)</span><span style={{fontSize:15,fontWeight:700,color:'var(--text-primary)'}}>{totalStock>0?k(totalStock):'—'}</span></div>
    </div>
    {/* chart */}
    <div style={{color:tone, width:'100%'}}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{display:'block',overflow:'visible'}} preserveAspectRatio="xMidYMid meet">
        {zeroIn && <line x1={padL} y1={Y(0)} x2={W-padR} y2={Y(0)} stroke="var(--bad)" strokeDasharray="4 4" strokeWidth="1" opacity="0.5"/>}
        {zeroIn && <text x={padL-6} y={Y(0)+3} textAnchor="end" fontSize="9.5" fill="var(--text-faint)">£0</text>}
        <text x={padL-6} y={Y(hi-padv*0.5)+3} textAnchor="end" fontSize="9.5" fill="var(--text-faint)">{k(hi-padv*0.5)}</text>
        <path d={areaPath} fill="currentColor" opacity="0.08"/>
        <path d={linePath} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round"/>
        {series.map((s,i)=>(<g key={i}>
          <circle cx={X(i)} cy={Y(s.bal)} r={i===trough.i?5:3.5} fill={s.bal<0?'var(--bad)':'currentColor'} stroke="var(--bg-surface)" strokeWidth="1.5"/>
          {s.stock>0 && <text x={X(i)} y={Y(s.bal)-9} textAnchor="middle" fontSize="9" fill="var(--text-faint)">−{k(s.stock).replace('£','£')}</text>}
          <text x={X(i)} y={H-8} textAnchor="middle" fontSize="9.5" fill={i===trough.i?tone:'var(--text-faint)'} fontWeight={i===trough.i?700:400}>{s.label}</text>
        </g>))}
        <text x={X(trough.i)} y={Y(trough.bal)+ (trough.bal< (lo+hi)/2 ? 18 : -12)} textAnchor="middle" fontSize="10" fontWeight="700" fill={tone}>{k(trough.bal)}</text>
      </svg>
    </div>
    <div style={{fontSize:11,color:'var(--text-faint)',marginTop:10,lineHeight:1.5}}>Revenue in from your demand plan ({plan&&plan.revenue>0?k(plan.revenue):'—'} over {months}mo, spread evenly, gross); stock paid via the landing plan (deposit on order, balance on shipment); opex = overheads + ad spend. Cash basis — COGS is the stock payments, not double-counted. Excludes tax, refunds &amp; one-offs. {!cashKnown && <span style={{color:'var(--warn)'}}>Set cash on hand above for an absolute balance.</span>}</div>
  </div>);
}

// ── Planning — forecast + purchase orders on ONE tab ─────────────────────────
// Renders the shared header (chips scroll to sections) then the demand planner and
// the PO planner embedded back-to-back. Changing the forecast above live-updates
// the POs below (both read the same config via usePlanningTick), so there's no
// flicking between tabs.
function PlanningView(){
  usePlanningTick();
  const [showForecast, setShowForecast] = useState(false);
  const [planView, setPlanView] = useState('timeline');   // landing plan: timeline | table
  React.useEffect(()=>{ window.__oiOpenForecast = ()=>{ setShowForecast(true); setTimeout(()=>{ const el=document.getElementById('plan-forecast'); if(el) el.scrollIntoView({behavior:'smooth',block:'start'}); }, 60); }; return ()=>{ try{ delete window.__oiOpenForecast; }catch(e){} }; }, []);
  const R = planReorder(); const dc = demandConfig(); const rc = reorderConfig();
  const k = v=>{ v=Math.abs(Math.round(v)); return v>=1000?(v/1000).toFixed(v>=10000?0:1).replace(/\.0$/,'')+'k':''+v; };
  const months = (R.plan&&R.plan.months)||3;
  const oosNow = R.oosNow, toOrderN = R.toOrder.length, awaiting = R.awaiting.length;
  const orderVal = R.toOrder.reduce((t,l)=>t+(l.lineCost||0),0);
  const stockoutsUnderPlan = R.lines.filter(l=>l.forecastUnits>l.stock).length;
  const growthPct = R.plan?R.plan.growthPct:0;
  const fLabel = dc.targetMode==='growth' ? `${(Number(dc.growth)||0)>=0?'+':''}${Number(dc.growth)||0}% on run-rate · ${months}mo`
    : dc.shape==='month' ? `${months}-mo, shaped by month (${growthPct>=0?'+':''}${Math.round(growthPct)}%)`
    : (Number(dc.targetValue)>0 ? (dc.targetMode==='revenue'?`£${k(dc.targetValue)} revenue · ${months}mo`:`${NUM(Number(dc.targetValue))} units · ${months}mo`) : `${months}-mo run-rate (no target set)`);
  const STRAT = {jit:'Just-in-time', bulk:'Bulk upfront', staged:'Staged waves'};
  // Cost each strategy (without switching) so the trade-off is visible at the point of choice.
  // dep = cash due now (deposits); val = total committed — they differ when suppliers take a deposit.
  const stratCmp = {}; ['jit','bulk','staged'].forEach(s=>{ const r=(s===rc.strategy)?R:planReorder({strategy:s}); const v=r.toOrder.reduce((t,l)=>t+(l.lineCost||0),0); const dp=r.toOrder.reduce((t,l)=>t+(l.depositCost!=null?l.depositCost:(l.lineCost||0)),0); stratCmp[s]={count:r.toOrder.length, val:v, dep:dp}; });
  const wavesN = Math.max(1, Math.round(Number(rc.waves)||3));
  const stratDesc = {jit:'lean · rolling cover', bulk:'all upfront', staged:`${wavesN} waves`};
  const stratExplain = {jit:'Lean — order small rolling batches to cover lead time + a buffer. Least cash tied up, but you reorder often.', bulk:'Commit the whole forecast now, net of stock. Maximises availability and MOQ economics; ties up the most cash upfront.', staged:'Split the forecast into scheduled waves — spreads the cash and the supply risk across the horizon.'};
  // Recommendation from the situation
  let recStrat='jit', recWhy='steady demand — keep cash free and reorder as stock depletes';
  if(oosNow>=3){ recStrat='bulk'; recWhy=`${oosNow} product${oosNow===1?'':'s'} will run out before a reorder can land — commit the stock now`; }
  else if(growthPct>=40){ recStrat='staged'; recWhy=`a big +${Math.round(growthPct)}% ramp — spread the commitment across waves`; }
  // ── Stock landing plan — when to order each tranche, what's payable, when it lands ──
  // Order-by dates are back-calculated from total lead (production + transit) so each
  // tranche lands before the previous depletes; any tranche whose order-by has passed is flagged.
  const today = oiToday();
  const fmtD = iso=>{ try{ const d=new Date((iso||today)+'T00:00:00'); return d.toLocaleDateString('en-GB',{day:'numeric',month:'short'}); }catch(e){ return iso; } };
  const orderTotal = orderVal;                                   // total committed by the orders due now
  const depNow = R.toOrder.reduce((t,l)=>t+(l.depositCost!=null?l.depositCost:(l.lineCost||0)),0);
  const balLater = Math.max(0, orderTotal - depNow);
  const depPctBlend = orderTotal>0 ? depNow/orderTotal : 1;      // blended deposit share for steady waves
  const hasDeposit = orderTotal>0 && depNow < orderTotal-0.5;    // any supplier actually takes a deposit
  // binding lead = the slowest item that needs ordering (so nothing stocks out), with its make/ship split
  let bind=null; R.toOrder.forEach(l=>{ if(!bind || (l.lead||0)>(bind.lead||0)) bind=l; });
  const leadTotalRep = bind ? (bind.lead||0) : 0;
  const leadMakeRep = bind ? (bind.leadMake!=null?bind.leadMake:bind.lead||0) : 0;
  const horizonDays = R.horizonDays||91;
  const weights = waveWeights(rc, wavesN);                       // per-wave demand split (front/back-loadable)
  const splitName = wavePresetName(weights);
  // full-horizon demand value across all lines → each wave is its weighted slice
  const horizonVal = R.lines.reduce((t,l)=> t + ((l.unitCost!=null)? l.unitCost*Math.ceil((l.vel||0)*horizonDays):0), 0);
  const mkTranche = (n,name,orderISO,isNow,val,coverTxt)=>{ const late=!isNow && orderISO<=today; const base=(isNow||late)?today:orderISO; const dep=val*depPctBlend; const shipISO=oiAddDays(base, leadMakeRep); const landISO=oiAddDays(base, leadTotalRep); return {n,name,orderISO,isNow,late,val,dep,bal:Math.max(0,val-dep),shipISO,landISO,coverTxt}; };
  let tranches=[];
  if(R.toOrder.length){
    if(rc.strategy==='bulk'){
      tranches=[ mkTranche(1,'Full order',today,true,orderTotal,`full ${months}-mo plan`) ];
    } else if(rc.strategy==='staged'){
      let cum=0;                                                 // fraction of horizon covered before this wave
      for(let kk=1; kk<=wavesN; kk++){
        const needDays = Math.round(cum*horizonDays);            // when this wave's stock must be in
        const needBy = oiAddDays(today, needDays);
        const orderISO = kk===1 ? today : oiAddDays(today, needDays - leadTotalRep);   // lead-adjusted order-by
        const val = kk===1 ? orderTotal : Math.round(horizonVal*weights[kk-1]);
        tranches.push( mkTranche(kk, `Wave ${kk}`, orderISO, kk===1, val, `covers from ~${fmtD(needBy)} · ${Math.round(weights[kk-1]*100)}% of demand`) );
        cum += weights[kk-1];
      }
    } else {
      tranches=[ mkTranche(1,'Reorder now',today,true,orderTotal,'rolling — reorder as stock depletes') ];
    }
  }
  const lateWaves = tranches.filter(t=>t.late).length;
  const heroColor = oosNow ? 'var(--bad)' : toOrderN ? 'var(--warn)' : 'var(--good)';
  const headline = oosNow ? `Order today — ${oosNow} product${oosNow===1?'':'s'} at OOS risk` : toOrderN ? `${toOrderN} product${toOrderN===1?'':'s'} to reorder` : 'Stock is on track for your plan';
  const sub = toOrderN ? `${toOrderN} SKU${toOrderN===1?'':'s'} to order · ~£${k(orderVal)} to commit${stockoutsUnderPlan?` · ${stockoutsUnderPlan} forecast to run out under the plan`:''}${awaiting?` · ${awaiting} awaiting stock`:''}`
    : (awaiting?`${awaiting} PO${awaiting===1?'':'s'} awaiting stock`:'Nothing to order right now — good sellers have cover for their lead times.');
  const btn = {display:'inline-flex',alignItems:'center',gap:6,fontSize:13,fontWeight:700,padding:'9px 15px',borderRadius:9,border:'none',background:'var(--accent)',color:'#fff',cursor:'pointer',whiteSpace:'nowrap'};
  const sbtn = (id)=>({fontSize:11.5,fontWeight:700,padding:'5px 11px',borderRadius:7,cursor:'pointer',border:'1.5px solid '+(rc.strategy===id?'var(--accent)':'var(--border-default)'),background:rc.strategy===id?'var(--accent)':'transparent',color:rc.strategy===id?'#fff':'var(--text-secondary)'});
  const lab = {fontSize:10,fontWeight:700,letterSpacing:'.05em',textTransform:'uppercase',color:'var(--text-faint)',marginBottom:5};
  const goPOs = ()=>{ const el=document.getElementById('plan-pos'); if(el) el.scrollIntoView({behavior:'smooth',block:'start'}); };
  return (<div>
    <div style={{display:'flex',alignItems:'baseline',justifyContent:'space-between',gap:10,flexWrap:'wrap',marginBottom:8}}>
      <h2 style={{margin:0,fontSize:18}}>Planning</h2>
      <span className="muted" style={{fontSize:12}}>Forecast → strategy → purchase orders · independent of the date picker</span>
    </div>

    {/* HERO — what to do now + the two levers (forecast + strategy) in one band */}
    <div className="card" style={{borderLeft:'3px solid '+heroColor, marginBottom:14}}>
      <div style={{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap'}}>
        <div style={{flex:'1 1 320px',minWidth:0}}>
          <div style={lab}>What to do now</div>
          <div style={{fontSize:19,fontWeight:800,color:heroColor,lineHeight:1.2}}>{headline}</div>
          <div style={{fontSize:12.5,color:'var(--text-muted)',marginTop:4,lineHeight:1.45}}>{sub}</div>
        </div>
        {toOrderN>0 && <button style={btn} onClick={goPOs}>Review &amp; raise POs <Icon name="chevron" size={14}/></button>}
      </div>
      <div style={{marginTop:14,paddingTop:12,borderTop:'1px solid var(--border-subtle)'}}>
        <div style={lab}>① Forecast <a className="txt-link" style={{cursor:'pointer',textTransform:'none',letterSpacing:0,fontWeight:600}} onClick={()=>window.__oiOpenForecast&&window.__oiOpenForecast()}>· {showForecast?'editing below':'edit ›'}</a></div>
        <div style={{fontSize:13.5,fontWeight:700,color:'var(--text-primary)'}}>{fLabel}</div>
      </div>
      {/* ② Strategy — compare the trade-off, pick, see the recommendation */}
      <div style={{marginTop:14}}>
        <div style={lab}>② Strategy — how to commit against the forecast</div>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
          {['jit','bulk','staged'].map(id=>{ const on=rc.strategy===id; const c=stratCmp[id]; const dep=hasDeposit&&c.dep<c.val-0.5;
            return (<button key={id} onClick={()=>saveReorderConfig({...rc,strategy:id})} style={{textAlign:'left',flex:'1 1 160px',minWidth:148,padding:'9px 12px',borderRadius:9,cursor:'pointer',border:'1.5px solid '+(on?'var(--accent)':'var(--border-default)'),background:on?'var(--accent-bg)':'var(--bg-elevated)'}}>
              <div style={{fontSize:12.5,fontWeight:700,color:on?'var(--accent)':'var(--text-primary)'}}>{on?'✓ ':''}{STRAT[id]}</div>
              <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>{c.count?(dep?`£${k(c.dep)} deposit now · £${k(c.val)} total`:`~£${k(c.val)} to commit now`):'nothing to order'} · {stratDesc[id]}</div>
            </button>); })}
        </div>
        <div style={{fontSize:11.5,color:'var(--text-faint)',marginTop:8,lineHeight:1.5}}>{stratExplain[rc.strategy]}</div>
        {recStrat!==rc.strategy && <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',marginTop:8,padding:'7px 11px',borderRadius:8,background:'var(--accent-bg)',border:'1px solid var(--border-subtle)'}}>
          <Icon name="spark" size={13} style={{color:'var(--accent)'}}/>
          <span style={{fontSize:12,color:'var(--text-secondary)'}}>Suggested: <b style={{color:'var(--text-primary)'}}>{STRAT[recStrat]}</b> — {recWhy}.</span>
          <button style={{...btn,fontSize:11.5,padding:'5px 11px',marginLeft:'auto'}} onClick={()=>saveReorderConfig({...rc,strategy:recStrat})}>Use {STRAT[recStrat]}</button>
        </div>}
      </div>
    </div>

    {/* Stock landing plan — when to order each tranche, what's payable, when it lands */}
    {tranches.length>0 && (()=>{
      const tdL = {padding:'8px 12px 8px 0',fontSize:12.5,color:'var(--text-secondary)',borderTop:'1px solid var(--border-subtle)',whiteSpace:'nowrap'};
      const thL = {textAlign:'left',fontSize:10,fontWeight:700,letterSpacing:'.04em',textTransform:'uppercase',color:'var(--text-faint)',padding:'0 12px 7px 0',whiteSpace:'nowrap'};
      // timeline geometry — position order/ship/land along a today→last-landing axis
      const spanDays = Math.max(7, Math.max(...tranches.map(t=>oiDayDiff(today,t.landISO)))+4);
      const pctOf = iso => Math.max(0, Math.min(100, oiDayDiff(today,iso)/spanDays*100));
      const ticks=[]; for(let i=0;i*30<=spanDays+2 && i<10;i++){ const d=oiAddDays(today,i*30); ticks.push({x:Math.min(100,(i*30)/spanDays*100), label:i===0?'now':(()=>{ try{ return new Date(d+'T00:00:00').toLocaleDateString('en-GB',{month:'short'}); }catch(e){ return ''; } })()}); }
      const dot=(x,color,size,filled,title)=>(<div title={title} style={{position:'absolute',left:x+'%',top:'50%',transform:'translate(-50%,-50%)',width:size,height:size,borderRadius:'50%',background:filled?color:'var(--bg-base)',border:'2px solid '+color,zIndex:2}}/>);
      const toggle = (v,lbl)=>{ const on=planView===v; return <button key={v} onClick={()=>setPlanView(v)} style={{fontSize:11,fontWeight:700,padding:'4px 11px',borderRadius:6,cursor:'pointer',border:'none',background:on?'var(--accent)':'transparent',color:on?'#fff':'var(--text-muted)'}}>{lbl}</button>; };
      return (<div className="card" style={{marginBottom:14}}>
        <div style={{display:'flex',alignItems:'center',gap:10,flexWrap:'wrap',marginBottom:4}}>
          <div style={{fontSize:14,fontWeight:800,color:'var(--text-primary)'}}>Stock landing plan</div>
          <span className="muted" style={{fontSize:11.5}}>{STRAT[rc.strategy]} · lead {leadTotalRep}d ({leadMakeRep}d make + {leadTotalRep-leadMakeRep}d transit)</span>
          <div style={{marginLeft:'auto',display:'flex',gap:3,background:'var(--bg-elevated)',borderRadius:8,padding:3}}>{toggle('timeline','Timeline')}{toggle('table','Table')}</div>
        </div>
        <div style={{fontSize:12.5,color:'var(--text-muted)',marginBottom:10,lineHeight:1.5}}>
          {hasDeposit
            ? <>To start, pay a <b style={{color:'var(--text-primary)'}}>£{k(depNow)} deposit now</b>, with <b style={{color:'var(--text-primary)'}}>£{k(balLater)} balance on shipment</b> — <b>£{k(orderTotal)}</b> committed in total.</>
            : <><b style={{color:'var(--text-primary)'}}>£{k(orderTotal)}</b> to commit now. Add a deposit % per supplier (Suppliers tab) to split this into deposit-now vs balance-on-shipment.</>}
          {rc.strategy==='staged' && <> Each wave must be <b>ordered</b> early enough to <b>land</b> before the previous runs out.</>}
        </div>
        {rc.strategy==='staged' && wavesN>1 && <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap',marginBottom:12}}>
          <span style={{fontSize:11,color:'var(--text-faint)',fontWeight:700,letterSpacing:'.03em',textTransform:'uppercase'}}>Wave split</span>
          {[['even','Even'],['front','Front-load'],['back','Back-load']].map(([kind,lbl])=>{ const on=splitName===kind;
            return <button key={kind} onClick={()=>saveReorderConfig({...rc, waveSplit: wavePreset(kind, wavesN)})} title={kind==='front'?'Bigger first wave — buy into peak early':kind==='back'?'Smaller first wave, ramp later':'Equal waves'} style={{fontSize:11,fontWeight:700,padding:'4px 11px',borderRadius:7,cursor:'pointer',border:'1.5px solid '+(on?'var(--accent)':'var(--border-default)'),background:on?'var(--accent)':'transparent',color:on?'#fff':'var(--text-secondary)'}}>{lbl}</button>; })}
          <span style={{fontSize:11,color:'var(--text-faint)'}}>{weights.map(w=>Math.round(w*100)+'%').join(' / ')}{splitName==='custom'?' · custom':''}</span>
        </div>}
        {lateWaves>0 && <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12,padding:'7px 11px',borderRadius:8,background:'rgba(248,113,113,.10)',border:'1px solid var(--bad)'}}>
          <Icon name="alert" size={13} style={{color:'var(--bad)'}}/>
          <span style={{fontSize:12,color:'var(--text-secondary)'}}>{lateWaves} wave{lateWaves===1?'':'s'} should already be on order — the {leadTotalRep}d lead is longer than the gap between waves. Order {lateWaves===1?'it':'them'} now, front-load Wave 1, or widen the wave count.</span>
        </div>}

        {planView==='timeline' ? (<div>
          {/* axis */}
          <div style={{display:'flex',alignItems:'flex-end',gap:10,marginBottom:4}}>
            <div style={{width:132,flexShrink:0}}/>
            <div style={{position:'relative',flex:1,height:13}}>{ticks.map((tk,i)=><span key={i} style={{position:'absolute',left:tk.x+'%',transform:'translateX(-50%)',fontSize:9.5,color:'var(--text-faint)',whiteSpace:'nowrap'}}>{tk.label}</span>)}</div>
          </div>
          {tranches.map(t=>{ const ox=pctOf((t.isNow||t.late)?today:t.orderISO), sx=pctOf(t.shipISO), lx=pctOf(t.landISO); return (
            <div key={t.n} style={{display:'flex',alignItems:'center',gap:10,marginBottom:7}}>
              <div style={{width:132,flexShrink:0}}>
                <div style={{fontSize:12,fontWeight:700,color:'var(--text-primary)'}}>{t.name} {t.late&&<span style={{fontSize:9.5,fontWeight:800,color:'#fff',background:'var(--bad)',padding:'1px 5px',borderRadius:999}}>LATE</span>}</div>
                <div style={{fontSize:10.5,color:'var(--text-faint)'}}>{hasDeposit?`£${k(t.dep)} now · £${k(t.bal)} on ship`:`£${k(t.val)}`}</div>
              </div>
              <div style={{position:'relative',flex:1,height:28,borderRadius:7,background:'var(--bg-elevated)'}}>
                <div style={{position:'absolute',left:ox+'%',width:Math.max(0,lx-ox)+'%',top:'50%',height:3,transform:'translateY(-50%)',background:t.late?'var(--bad)':'var(--accent)',opacity:.45,borderRadius:2}}/>
                {dot(ox, t.late?'var(--bad)':'var(--text-muted)',12,false,'Order '+(t.isNow?'now':t.late?'now (was due '+fmtD(t.orderISO)+')':fmtD(t.orderISO)))}
                {dot(sx,'var(--warn)',10,true,'Ships '+fmtD(t.shipISO)+(hasDeposit?' · balance £'+k(t.bal)+' due':''))}
                {dot(lx,'var(--good)',15,true,'Lands '+fmtD(t.landISO))}
              </div>
            </div>); })}
          <div style={{display:'flex',gap:16,flexWrap:'wrap',marginTop:8,paddingLeft:142}}>
            <span style={{fontSize:10.5,color:'var(--text-faint)',display:'inline-flex',alignItems:'center',gap:5}}><span style={{width:10,height:10,borderRadius:'50%',border:'2px solid var(--text-muted)',display:'inline-block'}}/>Order</span>
            <span style={{fontSize:10.5,color:'var(--text-faint)',display:'inline-flex',alignItems:'center',gap:5}}><span style={{width:10,height:10,borderRadius:'50%',background:'var(--warn)',display:'inline-block'}}/>Ships{hasDeposit?' (balance due)':''}</span>
            <span style={{fontSize:10.5,color:'var(--text-faint)',display:'inline-flex',alignItems:'center',gap:5}}><span style={{width:12,height:12,borderRadius:'50%',background:'var(--good)',display:'inline-block'}}/>Lands</span>
          </div>
        </div>) : (<div style={{overflowX:'auto'}}><table style={{borderCollapse:'collapse',width:'100%',minWidth:640}}><thead><tr>
          <th style={thL}>Tranche</th><th style={thL}>Order by</th><th style={{...thL,textAlign:'right'}}>{hasDeposit?'Deposit now':'Pay'}</th>{hasDeposit&&<th style={{...thL,textAlign:'right'}}>Balance on ship</th>}<th style={thL}>Ships ~</th><th style={thL}>Lands ~</th><th style={thL}>Covers</th>
        </tr></thead><tbody>
          {tranches.map(t=>(<tr key={t.n}>
            <td style={{...tdL,color:'var(--text-primary)',fontWeight:600}}>{t.name}</td>
            <td style={{...tdL,color:t.isNow?'var(--accent)':t.late?'var(--bad)':'var(--text-secondary)',fontWeight:t.isNow||t.late?700:400}}>{t.isNow?'now':t.late?`${fmtD(t.orderISO)} · now (late)`:fmtD(t.orderISO)}</td>
            <td style={{...tdL,textAlign:'right',color:'var(--text-primary)'}}>{t.val>0?`£${k(t.dep)}`:'—'}</td>
            {hasDeposit&&<td style={{...tdL,textAlign:'right',color:'var(--text-muted)'}}>{t.bal>0?`£${k(t.bal)}`:'—'}</td>}
            <td style={tdL}>{fmtD(t.shipISO)}</td>
            <td style={tdL}>{fmtD(t.landISO)}</td>
            <td style={{...tdL,color:'var(--text-faint)',whiteSpace:'normal'}}>{t.coverTxt}</td>
          </tr>))}
        </tbody></table></div>)}
        <div style={{fontSize:11,color:'var(--text-faint)',marginTop:10,lineHeight:1.5}}>{rc.strategy==='staged'
          ? <>Wave 1 is the order below — re-run the plan on each order-by date to size the next wave on the latest stock. Dates use the slowest item's lead so nothing stocks out.</>
          : rc.strategy==='bulk' ? <>One order now covers the whole plan. Balance (if any) falls due when the supplier ships, ~{leadMakeRep}d after order.</>
          : <>JIT reorders roll as stock depletes — this is the order due now; the next triggers when cover next falls within lead + safety.</>}</div>
      </div>); })()}

    {/* Cash impact — forward balance projection from the plan's commitments */}
    {tranches.length>0 && <CashFlowPlan tranches={tranches} plan={R.plan} months={months}/>}

    {/* ① Forecast & demand — collapsed by default (config + detail), opened on demand */}
    <button onClick={()=>setShowForecast(s=>!s)} style={{display:'flex',alignItems:'center',gap:10,width:'100%',background:'transparent',border:'1px solid var(--border-subtle)',borderRadius:10,padding:'11px 14px',cursor:'pointer',textAlign:'left',marginBottom:showForecast?12:14}}>
      <span style={{color:'var(--text-faint)',display:'inline-flex',transform:showForecast?'rotate(90deg)':'none',transition:'transform 120ms'}}><Icon name="chevron" size={13}/></span>
      <span style={{fontWeight:700,color:'var(--text-primary)',fontSize:13.5}}>Forecast &amp; demand plan</span>
      <span className="muted" style={{fontSize:11.5}}>{fLabel} · per-product demand, focus/promotions, by-month shaping &amp; packaging</span>
      <span style={{marginLeft:'auto',fontSize:11.5,color:'var(--accent)',fontWeight:600}}>{showForecast?'Hide':'Open'}</span>
    </button>
    {showForecast && <div id="plan-forecast"><DemandPlanner embedded/></div>}

    {/* ③ Purchase orders — the action surface, always visible */}
    <div style={{display:'flex',alignItems:'center',gap:10,margin:'8px 0 12px'}}>
      <span style={{width:3,height:16,background:'var(--accent)',borderRadius:2}}/>
      <span style={{fontSize:13,fontWeight:700,letterSpacing:'.05em',textTransform:'uppercase',color:'var(--text-secondary)'}}>③ Purchase orders</span>
      <span className="muted" style={{fontSize:11.5}}>sized to your forecast, under your strategy</span>
    </div>
    <div id="plan-pos"><ProductionPlanner embedded/></div>
  </div>);
}

const NAV = [
  // OVERVIEW — how's the business (daily → weekly → periodic → auto-detected)
  { id:'home',    label:'Today',    icon:'home',     subtabs:[
    { id:'overview', label:'Overview',     component: (p) => <Overview start={p.start} period={p.period} customActive={p.customActive}/> },
    { id:'ask',      label:'AI Analyst',   component: () => <AskPanel/> },
  ]},
  { id:'board',   label:'What changed', icon:'calendar', subtabs:[
    { id:'weekly',   label:'What changed', component: () => <WeeklyBoard/> },
  ]},
  { id:'review',  label:'Business review', icon:'report', subtabs:[
    { id:'review',   label:'Business review', component: () => <BusinessReview/> },
  ]},
  { id:'intel',   label:'Trends & alerts', icon:'alert', subtabs:[
    { id:'intel',    label:'Trends & alerts', component: () => <IntelligencePanel/> },
  ]},
  // ACT — what to do
  { id:'actions', label:'Actions',  icon:'clipboard', subtabs:[
    { id:'queue',    label:'Action queue', component: () => <ActionsView/> },
  ]},
  // GROWTH — acquire & convert (the funnel, in one place)
  { id:'channels',label:'Channels',     icon:'trendUp', subtabs:[
    { id:'cross',     label:'Cross-channel', component: (p) => <CrossChannel start={p.start}/> },
    { id:'channels',  label:'Detail',        component: (p) => <Channels start={p.start}/> },
    { id:'creatives', label:'Creative',      component: () => <Creatives/> },
    { id:'email',     label:'Email',         component: () => <EmailHub/> },
    { id:'organic',   label:'Organic',       component: () => <Organic/> },
  ]},
  { id:'conversion', label:'Conversion', icon:'pulse', subtabs:[
    { id:'cvr',  label:'CVR drivers',    component: () => <CvrDrivers/> },
    { id:'site', label:'Site & friction', component: (p) => <SiteStructure start={p.start}/> },
  ]},
  { id:'forecast', label:'Spend forecast', icon:'trendUp', subtabs:[
    { id:'forecast', label:'Spend forecast', component: () => <ForecastPanel/> },
  ]},
  // CUSTOMERS — retain + market context
  { id:'audience',label:'Customers',    icon:'users', subtabs:[
    { id:'customers',   label:'Customers',     component: () => <Customers/> },
    { id:'cohorts',     label:'Cohorts & LTV', component: () => <CohortsPanel/> },
  ]},
  { id:'market', label:'Competitors', icon:'search', subtabs:[
    { id:'competitors', label:'Competitors', component: () => <Competitors/> },
  ]},
  // PRODUCTS & SUPPLY — operate
  { id:'commerce',label:'Products & stock', icon:'box', subtabs:[
    { id:'products', label:'Products',    component: () => <Products/> },
    { id:'promos',   label:'Promotions',  component: () => <DiscountCodeTracker/> },
  ]},
  { id:'planning',label:'Plan & supply', icon:'truck', subtabs:[
    { id:'plan',      label:'Demand & POs', component: () => <PlanningView/> },
    { id:'suppliers', label:'Suppliers',    component: () => <SuppliersDirectory/> },
  ]},
  { id:'settings',label:'Settings',     icon:'sliders', subtabs:[
    { id:'connections', label:'Connections', component: () => <ConnectionsPanel/> },
    { id:'economics',   label:'Business economics', component: () => <BusinessEconomicsPanel/> },
    { id:'team',        label:'Team',        component: () => <TeamPanel/> },
  ]},
];

// Decision-led rail — a presentation layer over NAV (section IDs unchanged).
// Entries may target a specific sub-tab so decisions like "AI Analyst" and
// "Creative" become first-class destinations without restructuring the sections.
// Grouped by JOB, not build order: Overview (how's the business) → Act (what to do)
// → Plan & supply (forward) → Analyse (deep dives) → Settings (pinned bottom).
const RAIL = [
  // Funnel-led: how's the business → what to do → acquire & convert → retain → operate.
  { group:'Overview', label:'Today',             icon:'home',      section:'home' },
  { group:'Overview', label:'What changed',      icon:'calendar',  section:'board' },
  { group:'Overview', label:'Business review',   icon:'report',    section:'review' },
  { group:'Overview', label:'Trends & alerts',   icon:'alert',     section:'intel' },
  { group:'Act',      label:'Actions',           icon:'clipboard', section:'actions' },
  { group:'Act',      label:'Ask',               icon:'spark',     section:'home',     sub:'ask' },
  { group:'Growth',   label:'Channels',          icon:'trendUp',   section:'channels' },
  { group:'Growth',   label:'Conversion',        icon:'pulse',     section:'conversion' },
  { group:'Growth',   label:'Spend forecast',    icon:'trendUp',   section:'forecast' },
  { group:'Customers',label:'Customers',         icon:'users',     section:'audience' },
  { group:'Customers',label:'Competitors',       icon:'search',    section:'market' },
  { group:'Products & supply', label:'Products & stock', icon:'box',   section:'commerce' },
  { group:'Products & supply', label:'Plan & supply',    icon:'truck', section:'planning' },
  { group:'',         label:'Settings',          icon:'sliders',   section:'settings', pin:true },
];
const NAV_BY_ID = Object.fromEntries(NAV.map(s=>[s.id, s]));
// Mobile bottom tab bar — the 4 most-used destinations + More (opens ⌘K palette).
const MOBILE_NAV = [
  { label:'Today',    icon:'home',      section:'home' },
  { label:'Actions',  icon:'clipboard', section:'actions' },
  { label:'Analyst',  icon:'spark',     section:'home', sub:'ask' },
  { label:'Products', icon:'box',       section:'commerce' },
];

// ── Connections panel — shows OAuth status per source + install actions ─────
function ConnectionsPanel(){
  // Authenticated connect flow: POST connect-start with the user's JWT. connect-start
  // verifies brand_users owner/admin membership, stamps the initiator, and returns the
  // provider authorize_url we navigate to — replacing the old unauthenticated GET
  // oauth-*-install (whose &brand= slug was spoofable). The functions base is derived
  // from OI_ASK.endpoint (no hardcoded project); the brand slug from OI_BRAND.
  const ASK = getOIAsk();
  const authed = !!(ASK && ASK.brand_id && typeof ASK.getJwt==='function' && ASK.endpoint);
  const fnBase = authed ? ASK.endpoint.replace(/\/[^/]*$/, '') : '';
  const brandSlug = (OI_BRAND && OI_BRAND.slug) || 'frkl';

  // Derive "live" status from the existing data-recency signal until we have
  // an authenticated client-side query against the connections table.
  const today = new Date();
  const lastDate = (rows) => {
    if (!rows || !rows.length) return null;
    const sorted = [...rows].filter(r => r.date).sort((a,b) => a.date<b.date?-1:1);
    return sorted.length ? sorted[sorted.length-1].date : null;
  };
  const daysAgo = (iso) => {
    if (!iso) return null;
    return Math.floor((today - new Date(iso + 'T00:00:00Z')) / 86400000);
  };

  const sources = [
    {
      id: 'shopify', name: 'Shopify', icon: 'S',
      description: 'Orders, products, inventory, customers',
      last: lastDate(D.shopify),
      installable: true,
    },
    {
      id: 'meta', name: 'Meta Ads', icon: 'M',
      description: 'Campaign performance, creative-level data, audience health',
      last: lastDate(D.metaDaily),
      installable: false,
      comingSoon: 'Direct OAuth coming next sprint',
    },
    {
      id: 'google_ads', name: 'Google Ads', icon: 'G',
      description: 'Spend, conversions, search terms',
      last: lastDate(D.googleAds),
      installable: false,
      comingSoon: 'Direct OAuth coming next sprint',
    },
    {
      id: 'ga4', name: 'Google Analytics 4', icon: 'A',
      description: 'Sessions, funnel, channel mix, on-site conversions',
      last: lastDate(D.ga4),
      installable: false,
      comingSoon: 'Direct OAuth coming next sprint',
    },
    {
      id: 'klaviyo', name: 'Klaviyo', icon: 'K',
      description: 'Flows, campaigns, attributed revenue, list health',
      last: lastDate(D.klaviyo),
      installable: false,
      comingSoon: 'API-key auth coming next sprint',
    },
    {
      id: 'instagram', name: 'Instagram', icon: 'I',
      description: 'Organic posts, reels, stories, follower growth',
      last: lastDate(B.igDaily),
      installable: false,
      comingSoon: 'Direct OAuth coming next sprint',
    },
  ];

  const sevVar = (n) => n == null ? 'var(--text-muted)' : n <= 1 ? 'var(--good)' : n <= 4 ? 'var(--warn)' : 'var(--bad)';
  const sevLabel = (n) => n == null ? 'No data' : n <= 1 ? 'Fresh' : n <= 4 ? 'Ageing' : 'Stale';

  const [shopDomain, setShopDomain] = useState('');
  const [showShopifyForm, setShowShopifyForm] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connectErr, setConnectErr] = useState('');
  const shopValid = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/.test(shopDomain.trim());

  // Start the OAuth flow through the authenticated connect-start endpoint, then send the
  // TOP window (this dashboard is a same-origin iframe) to Shopify's consent screen. The
  // callback refuses to activate any connection whose initiator isn't an authorized owner.
  const startShopifyConnect = async () => {
    if (!authed) { setConnectErr('Sign in to connect a store.'); return; }
    if (!shopValid) { setConnectErr('Enter a valid *.myshopify.com domain.'); return; }
    setConnecting(true); setConnectErr('');
    let jwt = '';
    try { jwt = await ASK.getJwt(); } catch (e) { jwt = ''; }
    if (!jwt) { setConnectErr('Your session expired — refresh the page and sign in again.'); setConnecting(false); return; }
    try {
      const r = await fetch(fnBase + '/connect-start', {
        method: 'POST',
        headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+jwt },
        body: JSON.stringify({ provider:'shopify', brand: brandSlug, shop: shopDomain.trim().toLowerCase() }),
      });
      const data = await r.json().catch(()=>({}));
      if (!r.ok || !data.authorize_url) {
        setConnectErr(data.message || data.error || 'Could not start the Shopify connection.');
        setConnecting(false);
        return;
      }
      (window.top || window).location.href = data.authorize_url;  // leaves the page → no need to clear `connecting`
    } catch (e) {
      setConnectErr('Could not reach the server. Try again.');
      setConnecting(false);
    }
  };

  return (<div style={{display:'flex', flexDirection:'column', gap:'var(--s-7)'}}>

    <section>
      <ZoneHeader
        number="01"
        title="Data sources"
        meta="Each source connects via direct OAuth — no Supermetrics seat required"
      />

      <div style={{display:'flex', flexDirection:'column', gap:'var(--s-3)'}}>
        {sources.map(s => {
          const n = s.last == null ? null : daysAgo(s.last);
          const c = sevVar(n);
          const lbl = sevLabel(n);
          const ageStr = s.last == null ? '—' : n === 0 ? 'today' : n === 1 ? '1 day ago' : n + ' days ago';

          return (<div key={s.id} className="card" style={{
            display:'flex', alignItems:'center', gap:'var(--s-4)',
            padding:'var(--s-4) var(--s-5)',
          }}>
            <div style={{
              width:42, height:42, borderRadius:'var(--r-md)',
              background:'var(--bg-elevated)', border:'1px solid var(--border-default)',
              display:'flex', alignItems:'center', justifyContent:'center',
              fontSize:18, fontWeight:700, color:'var(--text-muted)', flexShrink:0,
            }}>{s.icon}</div>

            <div style={{flex:1, minWidth:0}}>
              <div style={{display:'flex', alignItems:'baseline', gap:'var(--s-3)', marginBottom:4}}>
                <span style={{fontSize:14.5, fontWeight:650}}>{s.name}</span>
                <span style={{display:'inline-flex', alignItems:'center', gap:5, fontSize:11, color:c, fontWeight:600}}>
                  <span style={{width:6, height:6, borderRadius:'var(--r-full)', background:c}}/>
                  {lbl}
                </span>
                <span className="meta" style={{fontSize:11}}>· last data {ageStr}</span>
              </div>
              <div className="meta" style={{fontSize:12}}>{s.description}</div>
            </div>

            <div style={{flexShrink:0}}>
              {s.installable ? (
                <button className="btn-primary" style={{padding:'7px 14px', fontSize:12.5, border:0, borderRadius:'var(--r-sm)', cursor:'pointer', fontFamily:'inherit', fontWeight:600}}
                  onClick={() => setShowShopifyForm(true)}>
                  Connect via OAuth
                </button>
              ) : (
                <span className="meta" style={{fontSize:11, fontStyle:'italic'}}>{s.comingSoon}</span>
              )}
            </div>
          </div>);
        })}
      </div>
    </section>

    {showShopifyForm && (<div className="modal-bg" onClick={()=>setShowShopifyForm(false)}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <h3>Connect Shopify via OAuth</h3>
        <div style={{fontSize:12, color:'var(--text-muted)', marginTop:6, marginBottom:'var(--s-4)', lineHeight:1.5}}>
          Enter your full shop domain (the <code style={{background:'var(--bg-input)',padding:'1px 5px',borderRadius:4,fontSize:11}}>.myshopify.com</code> one, not your custom domain).
          You'll be redirected to Shopify to approve read-only access to orders, products, inventory and discounts.
        </div>
        <label>Shop domain</label>
        <input type="text" value={shopDomain} onChange={e=>setShopDomain(e.target.value)}
          placeholder="e.g. your-store.myshopify.com" autoFocus
          style={{fontFamily:'JetBrains Mono, ui-monospace, monospace', fontSize:12.5}}/>
        <div className="row">
          <button onClick={startShopifyConnect}
            disabled={!shopValid || !authed || connecting}
            style={{
              padding:'8px 14px', borderRadius:'var(--r-sm)', fontSize:12, fontWeight:600, fontFamily:'inherit',
              cursor:(shopValid && authed && !connecting) ? 'pointer' : 'not-allowed',
              background:(shopValid && authed) ? 'var(--accent)' : 'var(--border-default)',
              color:(shopValid && authed) ? 'white' : 'var(--text-muted)',
              border:0,
            }}>{connecting ? 'Starting…' : 'Approve on Shopify →'}</button>
          <button onClick={()=>setShowShopifyForm(false)} style={{marginLeft:'auto'}}>Cancel</button>
        </div>
        {connectErr && <div style={{marginTop:'var(--s-3)', fontSize:12, color:'var(--bad)'}}>{connectErr}</div>}
        {!authed && <div style={{marginTop:'var(--s-3)', fontSize:11.5, color:'var(--text-muted)'}}>You need to be signed in to connect a store.</div>}
        <div className="hint">
          <b>What happens next:</b> Shopify shows you the requested scopes. After approving, you'll land back here with a "Connected" confirmation. The first data sync runs immediately and Monday-morning refreshes from then on.
          <br/><br/>
          <b>Need to set up the Shopify Partner App first?</b> See <code style={{fontSize:11}}>saas/oauth-setup-shopify.md</code> for the one-time admin setup.
        </div>
      </div>
    </div>)}

    <section>
      <ZoneHeader
        number="02"
        title="How direct OAuth works"
        meta="No Supermetrics. No CSV uploads. No middleware."
      />
      <div className="card">
        <div style={{display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:'var(--s-5)'}}>
          <div>
            <div className="micro" style={{color:'var(--accent)', marginBottom:'var(--s-2)'}}>Step 01</div>
            <div style={{fontSize:14, fontWeight:600, marginBottom:'var(--s-2)'}}>You authorise</div>
            <div className="meta" style={{lineHeight:1.6}}>Click Connect → Shopify (or Meta etc) shows you the requested scopes → you approve. Read-only by default.</div>
          </div>
          <div>
            <div className="micro" style={{color:'var(--accent)', marginBottom:'var(--s-2)'}}>Step 02</div>
            <div style={{fontSize:14, fontWeight:600, marginBottom:'var(--s-2)'}}>We store the token</div>
            <div className="meta" style={{lineHeight:1.6}}>An access token is stored in your workspace (encrypted, per-tenant). We never see your password. You can revoke anytime.</div>
          </div>
          <div>
            <div className="micro" style={{color:'var(--accent)', marginBottom:'var(--s-2)'}}>Step 03</div>
            <div style={{fontSize:14, fontWeight:600, marginBottom:'var(--s-2)'}}>Daily sync</div>
            <div className="meta" style={{lineHeight:1.6}}>Greta pulls fresh data daily. The Monday brief uses the latest sync. Connection-health strip surfaces any staleness.</div>
          </div>
        </div>
      </div>
    </section>

  </div>);
}

// ── Business economics (brand_config) ──────────────────────────────────────
// Captures the brand's financial "genome" — the operator-known facts that aren't
// in Shopify. gross_margin is the ONE hard gate: without it assess-fit throws 412
// and the engine skips the brand entirely (no fit profile, no actions). The cost
// stack + cash-cycle inputs are optional — each one supplied OVERRIDES the engine's
// category prior (source flips 'prior' → 'brand-entered'); left blank, the prior
// stands. So the input value IS the provenance: filled = your number, blank = prior.
// Writes go through the save-brand-config edge fn (validated, membership-checked);
// reads via the same fn (GET). Same auth context as Team/Ask (OI_ASK).

// Category priors — rough per-vertical estimates used ONLY to guide the form
// (placeholders / hints). They are never written unless the operator confirms a
// value. frkl (jewellery) + meridian (coffee) are the two real reference rows;
// the rest are sensible DTC defaults. Percentages are whole numbers (7.4 = 7.4%).
const CATEGORY_PRIORS = {
  jewellery: { label:'Jewellery',   grossMarginPct:77, fixedCostsMonthly:10000, inventoryDays:120, supplierDays:0,  discountRatePct:15, vc:{ shipping:3.5, fulfilment:2.0, packaging:0.5, payPct:1.5, payFixed:0.25, refundPct:7.4 } },
  coffee:    { label:'Coffee / F&B', grossMarginPct:75, fixedCostsMonthly:18000, inventoryDays:45,  supplierDays:30, discountRatePct:12, vc:{ shipping:3.2, fulfilment:1.6, packaging:0.9, payPct:1.5, payFixed:0.25, refundPct:4.55 } },
  apparel:   { label:'Apparel',     grossMarginPct:60, fixedCostsMonthly:15000, inventoryDays:90,  supplierDays:30, discountRatePct:15, vc:{ shipping:4.5, fulfilment:3.0, packaging:1.2, payPct:2.4, payFixed:0.25, refundPct:20 } },
  beauty:    { label:'Beauty',      grossMarginPct:70, fixedCostsMonthly:14000, inventoryDays:60,  supplierDays:30, discountRatePct:12, vc:{ shipping:3.8, fulfilment:2.0, packaging:1.0, payPct:2.4, payFixed:0.25, refundPct:4 } },
  supplements:{label:'Supplements', grossMarginPct:68, fixedCostsMonthly:12000, inventoryDays:60,  supplierDays:30, discountRatePct:12, vc:{ shipping:3.5, fulfilment:2.0, packaging:0.8, payPct:2.4, payFixed:0.25, refundPct:4 } },
  default:   { label:'DTC (general)',grossMarginPct:60, fixedCostsMonthly:12000, inventoryDays:75,  supplierDays:30, discountRatePct:15, vc:{ shipping:4.5, fulfilment:2.5, packaging:0.8, payPct:2.4, payFixed:0.25, refundPct:5 } },
};
// Map a free-text vertical → a prior set (loose keyword match, defaults to DTC general).
function priorsForVertical(v){
  const s = String(v||'').toLowerCase();
  if(/jewel|ring|neckl/.test(s)) return CATEGORY_PRIORS.jewellery;
  if(/coffee|tea|food|drink|beverage|snack|f&b/.test(s)) return CATEGORY_PRIORS.coffee;
  if(/apparel|cloth|fashion|wear|garment/.test(s)) return CATEGORY_PRIORS.apparel;
  if(/beauty|cosmet|skincare|makeup/.test(s)) return CATEGORY_PRIORS.beauty;
  if(/supplement|nutri|vitamin|protein|wellness/.test(s)) return CATEGORY_PRIORS.supplements;
  return CATEGORY_PRIORS.default;
}

function BusinessEconomicsPanel(){
  const ASK = getOIAsk();
  const authed = !!(ASK && ASK.brand_id && typeof ASK.getJwt==='function' && ASK.endpoint);
  const fnBase = authed ? ASK.endpoint.replace(/\/[^/]*$/, '') : '';
  const cfgUrl = fnBase + '/save-brand-config';

  const [config, setConfig] = React.useState(null);
  const [loading, setLoading] = React.useState(authed);
  const [loadErr, setLoadErr] = React.useState('');

  // Input state — seeded from the SAVED config only (never from priors). Blank ⇒ unset ⇒ prior.
  const [gm, setGm] = React.useState('');           // gross margin, as a percentage string
  const [genome, setGenome] = React.useState({});   // { fixed_costs_monthly, inventory_days, supplier_payment_terms_days, discount_rate_annual(%) }
  const [vc, setVc] = React.useState({});            // variable_costs keys as strings
  const [gmBusy, setGmBusy] = React.useState(false);
  const [csBusy, setCsBusy] = React.useState(false);
  const [gmMsg, setGmMsg] = React.useState(null);    // {text, kind}
  const [csMsg, setCsMsg] = React.useState(null);

  const priors = priorsForVertical(config?.vertical);

  // Seed every input from a config row (or clear when null). discount_rate_annual is a fraction
  // in the DB; the form shows it as a percentage.
  const seed = (cfg) => {
    setGm(cfg?.gross_margin != null ? String(round2(Number(cfg.gross_margin) * 100)) : '');
    setGenome({
      fixed_costs_monthly:         cfg?.fixed_costs_monthly != null ? String(cfg.fixed_costs_monthly) : '',
      inventory_days:              cfg?.inventory_days != null ? String(cfg.inventory_days) : '',
      supplier_payment_terms_days: cfg?.supplier_payment_terms_days != null ? String(cfg.supplier_payment_terms_days) : '',
      discount_rate_annual:        cfg?.discount_rate_annual != null ? String(round2(Number(cfg.discount_rate_annual) * 100)) : '',
    });
    const savedVc = (cfg && cfg.variable_costs) || {};
    setVc(Object.fromEntries(['shipping','fulfilment','packaging','payPct','payFixed','refundPct']
      .map(k => [k, savedVc[k] != null ? String(savedVc[k]) : ''])));
  };

  const load = async () => {
    if(!authed) return;
    setLoading(true); setLoadErr('');
    const jwt = await ASK.getJwt();
    if(!jwt){ setLoadErr('Your session expired — refresh the page and sign in again.'); setLoading(false); return; }
    try{
      const r = await fetch(cfgUrl + '?brand_id=' + encodeURIComponent(ASK.brand_id), {
        headers:{ 'Authorization':'Bearer '+jwt },
      });
      const data = await r.json().catch(()=>({}));
      if(!r.ok){ setLoadErr(data.detail||data.message||data.error||'Could not load your economics.'); setLoading(false); return; }
      setConfig(data.config || null);
      seed(data.config || null);
    }catch(e){ setLoadErr('Could not reach the server. Try again.'); }
    setLoading(false);
  };
  React.useEffect(()=>{ load(); }, []);   // eslint-disable-line

  // POST a patch (only the keys present are written; omitted keys keep their stored value / prior).
  const save = async (patch) => {
    const jwt = await ASK.getJwt();
    if(!jwt) return { ok:false, data:{ message:'Your session expired — refresh and sign in again.' } };
    const r = await fetch(cfgUrl, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+jwt },
      body: JSON.stringify({ brand_id: ASK.brand_id, ...patch }),
    });
    const data = await r.json().catch(()=>({}));
    return { ok:r.ok, data };
  };

  const num = (s) => { const n = parseFloat(String(s).trim()); return isFinite(n) ? n : null; };

  const saveMargin = async (e) => {
    e.preventDefault();
    if(gmBusy) return;
    const pct = num(gm);
    if(pct == null || pct <= 0 || pct >= 100){ setGmMsg({ text:'Enter a gross margin between 1 and 99%.', kind:'err' }); return; }
    setGmBusy(true); setGmMsg(null);
    const { ok, data } = await save({ gross_margin: round4(pct / 100) });
    setGmBusy(false);
    if(!ok){ setGmMsg({ text:data.message||data.detail||data.error||'Save failed.', kind:'err' }); return; }
    setConfig(data.config); seed(data.config);
    try { window.dispatchEvent(new Event('oi-config-updated')); } catch(e){}
    setGmMsg({ text:'Gross margin saved — your numbers switch on at the next engine run.', kind:'ok' });
  };

  const saveCostStack = async (e) => {
    e.preventDefault();
    if(csBusy) return;
    const patch = {};
    // Genome: only send fields the operator actually filled with a valid number. Blank/invalid stays
    // NULL ⇒ engine keeps its prior (source 'prior'). A supplied value flips it to 'brand-entered'.
    const setNum = (col, raw, xform) => { const n = num(raw); if(n != null) patch[col] = xform ? xform(n) : n; };
    setNum('fixed_costs_monthly', genome.fixed_costs_monthly);
    setNum('inventory_days', genome.inventory_days);
    setNum('supplier_payment_terms_days', genome.supplier_payment_terms_days);
    setNum('discount_rate_annual', genome.discount_rate_annual, n => round4(n/100)); // % → fraction
    // variable_costs is a jsonb blob (wholesale replace): build it from every valid non-blank key.
    const vcOut = {};
    for(const k of ['shipping','fulfilment','packaging','payPct','payFixed','refundPct']){
      const n = num(vc[k]); if(n != null) vcOut[k] = n;
    }
    if(Object.keys(vcOut).length) patch.variable_costs = vcOut;

    if(!Object.keys(patch).length){ setCsMsg({ text:'Fill in at least one cost to save.', kind:'err' }); return; }
    setCsBusy(true); setCsMsg(null);
    const { ok, data } = await save(patch);
    setCsBusy(false);
    if(!ok){ setCsMsg({ text:data.message||data.detail||data.error||'Save failed.', kind:'err' }); return; }
    setConfig(data.config); seed(data.config);
    try { window.dispatchEvent(new Event('oi-config-updated')); } catch(e){}
    setCsMsg({ text:'Cost stack saved. Confirmed values now drive the model instead of category estimates.', kind:'ok' });
  };

  if(!authed){
    return (<div className="card" style={{padding:'var(--s-7)'}}>
      <div style={{fontSize:15, fontWeight:650, marginBottom:'var(--s-2)'}}>Business economics</div>
      <div className="meta" style={{lineHeight:1.6, maxWidth:520}}>
        Your margin and cost stack live in your signed-in workspace. This is the public demo, so economics is read-only here.
      </div>
    </div>);
  }

  const marginSet = config?.gross_margin != null;
  const inputStyle = { width:'100%', padding:'9px 12px', fontSize:13, fontFamily:'JetBrains Mono, ui-monospace, monospace', color:'var(--text-primary)', background:'var(--bg-input)', border:'1px solid var(--border-default)', borderRadius:'var(--r-md)' };
  const msgBox = (m) => m && (<div style={{marginTop:'var(--s-3)', padding:'10px 14px', borderRadius:'var(--r-md)', fontSize:13,
    color: m.kind==='ok'?'var(--good)':'var(--bad)',
    background: m.kind==='ok'?'rgba(74,222,128,0.08)':'rgba(248,113,113,0.08)',
    border:'1px solid '+(m.kind==='ok'?'rgba(74,222,128,0.35)':'rgba(248,113,113,0.35)')}}>{m.text}</div>);

  // Provenance chip: 'your number' when the config has a stored value, else the fallback the engine uses.
  const Tag = ({ saved, fallback }) => (
    <span style={{ fontSize:10.5, fontWeight:700, letterSpacing:'.04em', textTransform:'uppercase',
      color: saved ? 'var(--good)' : (fallback.warn ? 'var(--warn)' : 'var(--text-muted)'),
      whiteSpace:'nowrap' }}>
      {saved ? '● your number' : '○ ' + fallback.label}
    </span>
  );

  // A single labelled field with a provenance chip and a category-prior placeholder.
  const Field = ({ label, hint, unit, value, onChange, placeholder, saved, fallback, int }) => (
    <div style={{display:'flex', flexDirection:'column', gap:5}}>
      <div style={{display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:'var(--s-2)'}}>
        <span style={{fontSize:12.5, fontWeight:600}}>{label}</span>
        <Tag saved={saved} fallback={fallback}/>
      </div>
      <div style={{position:'relative', display:'flex', alignItems:'center'}}>
        <input type="number" inputMode="decimal" step={int?'1':'any'} min="0"
          value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
          style={{...inputStyle, paddingRight:44}}/>
        <span style={{position:'absolute', right:12, fontSize:11, color:'var(--text-muted)', pointerEvents:'none', fontFamily:'inherit'}}>{unit}</span>
      </div>
      {hint && <div className="meta" style={{fontSize:11, lineHeight:1.45}}>{hint}</div>}
    </div>
  );

  return (<div style={{display:'flex', flexDirection:'column', gap:'var(--s-7)'}}>

    {loading && <div className="meta" style={{fontSize:12.5}}>Loading your economics…</div>}
    {loadErr && <div className="meta" style={{fontSize:12.5, color:'var(--bad)'}}>{loadErr}</div>}

    {!loading && !loadErr && (<>

      {/* ── Step 1 — Gross margin (the gate) ── */}
      <div className="card" style={{padding:'var(--s-7)', borderTop: marginSet ? undefined : '2px solid var(--warn)'}}>
        <div style={{display:'flex', alignItems:'baseline', gap:'var(--s-2)', flexWrap:'wrap', marginBottom:4}}>
          <div style={{fontSize:15, fontWeight:650}}>Gross margin</div>
          <span style={{fontSize:10.5, fontWeight:700, letterSpacing:'.05em', textTransform:'uppercase', color: marginSet?'var(--good)':'var(--warn)'}}>
            {marginSet ? '● Numbers are ON' : '○ Required — numbers are OFF'}
          </span>
        </div>
        <div className="meta" style={{fontSize:12.5, marginBottom:'var(--s-5)', lineHeight:1.6, maxWidth:640}}>
          {marginSet
            ? 'This is the one number your engine can’t read from Shopify. It’s set — every model runs on it.'
            : 'Until you set this, the engine can’t value anything and skips your brand entirely. It’s COGS-based: what it costs to make or buy the product, as a % of its price. One number switches everything on.'}
        </div>
        <form onSubmit={saveMargin} style={{display:'flex', gap:'var(--s-2)', flexWrap:'wrap', alignItems:'center', paddingTop:'var(--s-4)', borderTop:'1px solid var(--color-line, var(--border-subtle))'}}>
          <div style={{position:'relative', display:'flex', alignItems:'center', flex:'0 1 200px'}}>
            <input type="number" inputMode="decimal" step="any" min="1" max="99" value={gm} onChange={e=>setGm(e.target.value)}
              placeholder={'e.g. ' + priors.grossMarginPct} autoFocus={!marginSet}
              style={{...inputStyle, paddingRight:34}}/>
            <span style={{position:'absolute', right:12, fontSize:12, color:'var(--text-muted)', pointerEvents:'none'}}>%</span>
          </div>
          <button type="submit" className="btn-primary" disabled={gmBusy}
            style={{padding:'9px 16px', fontSize:13, border:0, borderRadius:'var(--r-md)', cursor:gmBusy?'default':'pointer', fontFamily:'inherit', fontWeight:600, opacity:gmBusy?0.6:1}}>
            {gmBusy ? 'Saving…' : (marginSet ? 'Update margin' : 'Switch on my numbers →')}
          </button>
          <span className="meta" style={{fontSize:11}}>{priors.label} brands typically sit around {priors.grossMarginPct}%.</span>
        </form>
        {msgBox(gmMsg)}
      </div>

      {/* ── Step 2 — Cost stack + cash cycle (optional, sharpens the model) ── */}
      <div className="card" style={{padding:'var(--s-7)'}}>
        <div style={{fontSize:15, fontWeight:650, marginBottom:4}}>Cost stack & cash cycle</div>
        <div className="meta" style={{fontSize:12.5, marginBottom:'var(--s-5)', lineHeight:1.6, maxWidth:640}}>
          Optional, but each number you confirm replaces a {priors.label.toLowerCase()} category estimate with your own — sharpening contribution, cash-cycle and profitability. Leave a field blank and the estimate stands.
        </div>

        <form onSubmit={saveCostStack} style={{display:'flex', flexDirection:'column', gap:'var(--s-6)'}}>

          {/* Per-order variable costs */}
          <div>
            <div className="micro" style={{color:'var(--accent)', marginBottom:'var(--s-3)'}}>Per-order costs</div>
            <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))', gap:'var(--s-4)'}}>
              <Field label="Shipping" unit="£" int={false} value={vc.shipping||''} onChange={v=>setVc(s=>({...s, shipping:v}))}
                placeholder={'~'+priors.vc.shipping} saved={config?.variable_costs?.shipping != null}
                fallback={{ label:'assumes £0', warn:true }} hint="Outbound delivery you pay per order."/>
              <Field label="Fulfilment / pick-pack" unit="£" value={vc.fulfilment||''} onChange={v=>setVc(s=>({...s, fulfilment:v}))}
                placeholder={'~'+priors.vc.fulfilment} saved={config?.variable_costs?.fulfilment != null}
                fallback={{ label:'assumes £0', warn:true }} hint="3PL / warehouse handling per order."/>
              <Field label="Packaging" unit="£" value={vc.packaging||''} onChange={v=>setVc(s=>({...s, packaging:v}))}
                placeholder={'~'+priors.vc.packaging} saved={config?.variable_costs?.packaging != null}
                fallback={{ label:'assumes £0', warn:true }} hint="Boxes, inserts, mailers per order."/>
              <Field label="Payment processing" unit="%" value={vc.payPct||''} onChange={v=>setVc(s=>({...s, payPct:v}))}
                placeholder={'~'+priors.vc.payPct} saved={config?.variable_costs?.payPct != null}
                fallback={{ label:'assumes 0%', warn:true }} hint="Gateway rate, e.g. 2.4 for 2.4%."/>
              <Field label="Payment fixed fee" unit="£" value={vc.payFixed||''} onChange={v=>setVc(s=>({...s, payFixed:v}))}
                placeholder={'~'+priors.vc.payFixed} saved={config?.variable_costs?.payFixed != null}
                fallback={{ label:'assumes £0', warn:true }} hint="Flat fee per transaction, e.g. £0.25."/>
              <Field label="Refund / return rate" unit="%" value={vc.refundPct||''} onChange={v=>setVc(s=>({...s, refundPct:v}))}
                placeholder={'~'+priors.vc.refundPct} saved={config?.variable_costs?.refundPct != null}
                fallback={{ label:'assumes 0%', warn:true }} hint="% of order value refunded, e.g. 7.4."/>
            </div>
          </div>

          {/* Cash cycle + fixed base */}
          <div>
            <div className="micro" style={{color:'var(--accent)', marginBottom:'var(--s-3)'}}>Cash cycle & fixed base</div>
            <div style={{display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(200px, 1fr))', gap:'var(--s-4)'}}>
              <Field label="Monthly fixed costs" unit="£/mo" value={genome.fixed_costs_monthly||''} onChange={v=>setGenome(s=>({...s, fixed_costs_monthly:v}))}
                placeholder={'~'+priors.fixedCostsMonthly} saved={config?.fixed_costs_monthly != null}
                fallback={{ label:'est. £'+priors.fixedCostsMonthly.toLocaleString() }} hint="Rent, salaries, software — anything that doesn’t scale per order."/>
              <Field label="Inventory days (DIO)" unit="days" int value={genome.inventory_days||''} onChange={v=>setGenome(s=>({...s, inventory_days:v}))}
                placeholder={'~'+priors.inventoryDays} saved={config?.inventory_days != null}
                fallback={{ label:'est. '+priors.inventoryDays+'d' }} hint="Avg days stock is held before it sells."/>
              <Field label="Supplier terms (DPO)" unit="days" int value={genome.supplier_payment_terms_days||''} onChange={v=>setGenome(s=>({...s, supplier_payment_terms_days:v}))}
                placeholder={'~'+priors.supplierDays} saved={config?.supplier_payment_terms_days != null}
                fallback={{ label:'est. '+priors.supplierDays+'d' }} hint="Days you have to pay suppliers. 0 = pay upfront."/>
              <Field label="Annual discount rate" unit="%" value={genome.discount_rate_annual||''} onChange={v=>setGenome(s=>({...s, discount_rate_annual:v}))}
                placeholder={'~'+priors.discountRatePct} saved={config?.discount_rate_annual != null}
                fallback={{ label:'est. '+priors.discountRatePct+'%' }} hint="Cost of capital used to discount future LTV."/>
            </div>
          </div>

          <div style={{display:'flex', alignItems:'center', gap:'var(--s-3)', paddingTop:'var(--s-4)', borderTop:'1px solid var(--color-line, var(--border-subtle))'}}>
            <button type="submit" className="btn-primary" disabled={csBusy}
              style={{padding:'9px 16px', fontSize:13, border:0, borderRadius:'var(--r-md)', cursor:csBusy?'default':'pointer', fontFamily:'inherit', fontWeight:600, opacity:csBusy?0.6:1}}>
              {csBusy ? 'Saving…' : 'Save cost stack'}
            </button>
            <span className="meta" style={{fontSize:11}}>Blank fields keep the category estimate — nothing is overwritten.</span>
          </div>
        </form>
        {msgBox(csMsg)}
      </div>
    </>)}
  </div>);
}
// Small rounding helpers — keep stored fractions tidy (avoid 0.7699999 float noise).
function round2(n){ return Math.round(Number(n) * 100) / 100; }
function round4(n){ return Math.round(Number(n) * 10000) / 10000; }

// Global "confirm your gross margin" nudge. gross_margin is the one gate: without it the engine
// skips the brand (no fit, no actions). We check the config once (via save-brand-config GET) and,
// if unset, show a dismissible banner at the top of the content column that deep-links to the
// Business economics panel. Re-checks on 'oi-config-updated' so it clears the instant margin is saved.
// Silent (renders nothing) in the public demo or once margin is set.
function MarginNudge(){
  const ASK = getOIAsk();
  const authed = !!(ASK && ASK.brand_id && typeof ASK.getJwt==='function' && ASK.endpoint);
  const [status, setStatus] = React.useState('unknown'); // 'unknown' | 'set' | 'unset'
  const [dismissed, setDismissed] = React.useState(false);

  const check = React.useCallback(async ()=>{
    if(!authed) return;
    try{
      const jwt = await ASK.getJwt();
      if(!jwt) return;
      const base = ASK.endpoint.replace(/\/[^/]*$/, '');
      const r = await fetch(base + '/save-brand-config?brand_id=' + encodeURIComponent(ASK.brand_id), { headers:{ 'Authorization':'Bearer '+jwt } });
      const data = await r.json().catch(()=>({}));
      if(r.ok) setStatus(data.gross_margin_set ? 'set' : 'unset');
    }catch(e){}
  }, [authed]); // eslint-disable-line

  React.useEffect(()=>{ check(); }, [check]);
  React.useEffect(()=>{
    const h = ()=>check();
    window.addEventListener('oi-config-updated', h);
    return ()=>window.removeEventListener('oi-config-updated', h);
  }, [check]);

  if(!authed || status!=='unset' || dismissed) return null;
  return (<div style={{
      display:'flex', alignItems:'center', gap:'var(--s-4)', marginBottom:'var(--s-5)',
      padding:'12px var(--s-5)', borderRadius:'var(--r-md)',
      background:'rgba(251,191,36,0.08)', border:'1px solid var(--warn)',
    }}>
    <div style={{flex:1, minWidth:0}}>
      <div style={{fontSize:13.5, fontWeight:650, marginBottom:2}}>Your numbers are switched off</div>
      <div className="meta" style={{fontSize:12, lineHeight:1.5}}>
        Confirm your gross margin — the one figure we can’t read from Shopify — and the engine starts valuing every recommendation in £.
      </div>
    </div>
    <button className="btn-primary" onClick={()=>window.__oiNav&&window.__oiNav('settings','economics')}
      style={{flexShrink:0, padding:'8px 14px', fontSize:12.5, border:0, borderRadius:'var(--r-md)', cursor:'pointer', fontFamily:'inherit', fontWeight:600}}>
      Confirm gross margin →
    </button>
    <button onClick={()=>setDismissed(true)} title="Dismiss for now" aria-label="Dismiss"
      style={{flexShrink:0, background:'none', border:0, cursor:'pointer', color:'var(--text-muted)', fontSize:16, lineHeight:1, padding:'4px 6px'}}>✕</button>
  </div>);
}

// ── Team / multi-user ──────────────────────────────────────────────────────
// Owner/admin invite + member management, in-dashboard. Uses the same auth
// context as Ask (window[.parent].OI_ASK = {endpoint, brand_id, getJwt}); all
// reads/writes go through the invite-member edge fn (brand_users is not
// client-writable). In the public demo there's no OI_ASK → a gentle notice.
function TeamPanel(){
  const ASK = getOIAsk();
  const authed = !!(ASK && ASK.brand_id && typeof ASK.getJwt==='function' && ASK.endpoint);
  const fnBase = authed ? ASK.endpoint.replace(/\/[^/]*$/, '') : '';
  const inviteUrl = fnBase + '/invite-member';

  const [members, setMembers] = React.useState([]);
  const [caller, setCaller] = React.useState(null);
  const [loading, setLoading] = React.useState(authed);
  const [loadErr, setLoadErr] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState('member');
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState(null);   // {text, kind}

  const call = async (action, extra) => {
    const jwt = await ASK.getJwt();
    if(!jwt) return { ok:false, data:{ detail:'Your session expired — refresh the page and sign in again.' } };
    const r = await fetch(inviteUrl, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer '+jwt },
      body: JSON.stringify({ brand_id: ASK.brand_id, action, ...(extra||{}) }),
    });
    const data = await r.json().catch(()=>({}));
    return { ok:r.ok, data };
  };

  const load = async () => {
    if(!authed) return;
    setLoading(true); setLoadErr('');
    const { ok, data } = await call('list');
    if(!ok || !data.members){ setLoadErr(data.detail||data.error||'Could not load the team.'); setLoading(false); return; }
    setMembers(data.members); setCaller(data.caller||null); setLoading(false);
  };
  React.useEffect(()=>{ load(); }, []);   // eslint-disable-line

  const submitInvite = async (e) => {
    e.preventDefault();
    if(busy) return;
    setBusy(true); setMsg(null);
    const { ok, data } = await call('invite', { email: email.trim(), role, redirect_to: 'https://operatorintelligence.com/auth/workspace.html' });
    setBusy(false);
    if(!ok){ setMsg({ text:data.detail||data.message||data.error||'Invite failed.', kind:'err' }); return; }
    setMsg({ text:data.message||'Invite sent.', kind:'ok' });
    setEmail('');
    load();
  };

  const removeMember = async (m) => {
    const ask = m.is_self ? 'Leave this workspace? You will lose access immediately.' : `Remove ${m.email} from this workspace?`;
    if(!window.confirm(ask)) return;
    const { ok, data } = await call('remove', { target_user_id: m.user_id });
    if(!ok){ setMsg({ text:data.detail||data.error||'Could not remove.', kind:'err' }); return; }
    if(m.is_self){ try{ (window.top||window).location.href='/auth/login.html'; }catch(_){ window.location.href='/auth/login.html'; } return; }
    load();
  };

  const canManage = !!(caller && caller.can_manage);
  const isOwner = caller && caller.role === 'owner';
  const roleColor = (rl) => rl==='owner' ? 'var(--accent)' : 'var(--text-secondary)';

  if(!authed){
    return (<div className="card" style={{padding:'var(--s-7)'}}>
      <div style={{fontSize:15, fontWeight:650, marginBottom:'var(--s-2)'}}>Team</div>
      <div className="meta" style={{lineHeight:1.6, maxWidth:520}}>
        Inviting teammates is available in your live, signed-in workspace. This is the public demo, so team management is read-only here.
      </div>
    </div>);
  }

  return (<div style={{display:'flex', flexDirection:'column', gap:'var(--s-7)'}}>
    {/* Invite */}
    <div className="card" style={{padding:'var(--s-7)'}}>
      <div style={{fontSize:15, fontWeight:650, marginBottom:4}}>Team</div>
      <div className="meta" style={{fontSize:12.5, marginBottom:'var(--s-5)'}}>
        Everyone with access to this workspace. {canManage ? 'Invite a teammate by email — they get a magic-link and land straight here.' : 'Only an owner or admin can change the team.'}
      </div>

      {canManage && (<form onSubmit={submitInvite} style={{display:'flex', gap:'var(--s-2)', flexWrap:'wrap', alignItems:'center', paddingTop:'var(--s-4)', borderTop:'1px solid var(--color-line, var(--border-subtle))'}}>
        <input type="email" required value={email} onChange={e=>setEmail(e.target.value)}
          placeholder="teammate@yourbrand.com" autoComplete="off"
          style={{flex:'1 1 240px', minWidth:0, padding:'9px 12px', fontSize:13, fontFamily:'inherit', color:'var(--text-primary)', background:'var(--bg-input)', border:'1px solid var(--border-default)', borderRadius:'var(--r-md)'}}/>
        <select value={role} onChange={e=>setRole(e.target.value)} aria-label="Role"
          style={{padding:'9px 12px', fontSize:13, fontFamily:'inherit', color:'var(--text-primary)', background:'var(--bg-input)', border:'1px solid var(--border-default)', borderRadius:'var(--r-md)'}}>
          <option value="member">Member — full access</option>
          <option value="viewer">Viewer — read only</option>
          {isOwner && <option value="admin">Admin — can manage team</option>}
        </select>
        <button type="submit" className="btn-primary" disabled={busy}
          style={{padding:'9px 16px', fontSize:13, border:0, borderRadius:'var(--r-md)', cursor:busy?'default':'pointer', fontFamily:'inherit', fontWeight:600, opacity:busy?0.6:1}}>
          {busy ? 'Sending…' : 'Send invite →'}
        </button>
      </form>)}

      {msg && (<div style={{marginTop:'var(--s-3)', padding:'10px 14px', borderRadius:'var(--r-md)', fontSize:13,
        color: msg.kind==='ok'?'var(--good)':'var(--bad)',
        background: msg.kind==='ok'?'rgba(74,222,128,0.08)':'rgba(248,113,113,0.08)',
        border:'1px solid '+(msg.kind==='ok'?'rgba(74,222,128,0.35)':'rgba(248,113,113,0.35)')}}>{msg.text}</div>)}

      {/* Member list */}
      <div style={{marginTop:'var(--s-5)'}}>
        {loading && <div className="meta" style={{fontSize:12.5}}>Loading team…</div>}
        {loadErr && <div className="meta" style={{fontSize:12.5, color:'var(--bad)'}}>{loadErr}</div>}
        {!loading && !loadErr && members.map(m => {
          const canRemove = canManage && (m.is_self || (m.role!=='owner' && (isOwner || m.role==='member' || m.role==='viewer')));
          return (<div key={m.user_id} style={{display:'flex', alignItems:'center', gap:'var(--s-3)', padding:'var(--s-3) 0', borderTop:'1px solid var(--color-line, var(--border-subtle))'}}>
            <div style={{width:30, height:30, borderRadius:'var(--r-full)', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'center', fontSize:12, fontWeight:700, textTransform:'uppercase', color:'var(--text-muted)', background:'var(--bg-elevated, var(--bg-input))', border:'1px solid var(--border-default)'}}>
              {(m.email||'?').trim().charAt(0)||'?'}
            </div>
            <div style={{minWidth:0, flex:1}}>
              <div style={{fontSize:13.5, fontWeight:550, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>
                {m.email}{m.is_self && <span className="meta" style={{fontWeight:450}}> (you)</span>}
              </div>
              <div className="meta" style={{fontSize:11}}>Added {new Date(m.created_at).toLocaleDateString()}</div>
            </div>
            <span style={{flexShrink:0, fontSize:10.5, fontWeight:700, letterSpacing:'.06em', textTransform:'uppercase', color:roleColor(m.role), padding:'4px 9px', border:'1px solid var(--border-default)', borderRadius:'var(--r-full)'}}>{m.role}</span>
            {canRemove && <button onClick={()=>removeMember(m)} title={m.is_self?'Leave workspace':'Remove'}
              style={{flexShrink:0, background:'none', border:0, cursor:'pointer', color:'var(--text-muted)', fontSize:15, lineHeight:1, padding:'4px 6px', borderRadius:'var(--r-md)'}}>✕</button>}
          </div>);
        })}
      </div>
    </div>
  </div>);
}

function App(){
  const [section, setSection] = useState('home');
  const [subTabBySection, setSubTabBySection] = useState(
    Object.fromEntries(NAV.map(s => [s.id, s.subtabs[0].id]))
  );
  const [period, setPeriod] = useState('30d');
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const customActive = !!(rangeStart && rangeEnd && rangeStart <= rangeEnd);
  // Resolve the active window (named period or custom range), then set it BEFORE
  // computing start / rendering panels so every panel reads the same window.
  const win = customActive ? {start: rangeStart, end: rangeEnd} : periodRange(period);
  setActiveEnd(win.end);
  const start = win.start;
  const activeSection = NAV.find(s => s.id === section) || NAV[0];
  const activeSubId = subTabBySection[section] || activeSection.subtabs[0].id;
  const activeSubTab = activeSection.subtabs.find(t => t.id === activeSubId) || activeSection.subtabs[0];

  // Decision-led rail: a rail entry is active when its section is active AND (if it
  // targets a sub-tab) that sub is active; otherwise when the section's default sub
  // is active — so "Today"/"AI Analyst" (and "Growth"/"Creative") stay distinct.
  const railActive = (e) => {
    if (e.section !== section) return false;
    const def = (NAV_BY_ID[e.section]?.subtabs[0]?.id);
    return e.sub ? (activeSubId === e.sub) : (activeSubId === def);
  };
  const goRail = (e) => {
    setSection(e.section);
    const sub = e.sub || (NAV_BY_ID[e.section]?.subtabs[0]?.id);
    if (sub) setSubTabBySection(p => ({...p, [e.section]: sub}));
    window.scrollTo({top: 0, behavior: 'smooth'});
  };

  // Global deep-link helper so findings can jump to their evidence tab (clickable cross-refs).
  React.useEffect(() => {
    window.__oiNav = (sec, sub) => {
      setSection(sec);
      if (sub) setSubTabBySection(p => ({...p, [sec]: sub}));
      window.scrollTo({top: 0, behavior: 'smooth'});
    };
    // "Ask about this" — any card can hand a question to the AI panel: stash it,
    // jump to Home › Ask, and let AskPanel pick it up (prefilled, ready to send).
    window.__oiAsk = (q) => {
      try { window.__oiAskPending = q || ''; } catch(e){}
      window.__oiNav('home', 'ask');
      try { window.dispatchEvent(new Event('oi-ask-prefill')); } catch(e){}
    };
  }, []);

  // Scroll to top whenever section or sub-tab changes — premium-feel small touch
  React.useEffect(() => {
    window.scrollTo({top: 0, behavior: 'smooth'});
  }, [section, activeSubId]);

  // Re-render whenever the live-data loader fetches fresh data from Supabase.
  // The loader mutates window.FRKL_* in place; bumping a state forces React to
  // re-read those globals via the child components' next render pass.
  const [dataVersion, setDataVersion] = useState(0);
  React.useEffect(() => {
    const handler = () => setDataVersion(v => v + 1);
    window.addEventListener('frkl-data-updated', handler);
    return () => window.removeEventListener('frkl-data-updated', handler);
  }, []);

  return (<div>
    {/* App bar — sticky, product chrome, workspace context */}
    <div className="appbar">
      <div className="appbar-inner">
        <div className="brand">
          <div className="brand-mark">
            <svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" aria-label="Greta">
              <defs>
                <linearGradient id="fpb" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#8B5CF6"/><stop offset="1" stopColor="#38BDF8"/></linearGradient>
                <linearGradient id="fgm" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#22D3A6"/><stop offset="1" stopColor="#5DE5C8"/></linearGradient>
              </defs>
              <rect x="49" y="30" width="138" height="41" rx="20.5" transform="rotate(-45 118 50.5)" fill="url(#fpb)"/>
              <rect x="71" y="177" width="138" height="41" rx="20.5" transform="rotate(-45 140 197.5)" fill="url(#fgm)"/>
              <circle cx="97" cy="132" r="24" fill="#0B132B"/>
            </svg>
          </div>
          <div>
            <div className="brand-name">greta</div>
            <div className="brand-sub">Every part of your business, every week, with a £ tag.</div>
          </div>
        </div>
        <div style={{width:1, height:24, background:'var(--border-subtle)', margin:'0 var(--s-2)'}}/>
        <div className="workspace-chip">
          <div className="dot"/>
          <span>{OI_BRAND.name||'frkl'}</span>
          <span style={{color:'var(--text-faint)',marginLeft:'var(--s-1)'}}>workspace</span>
        </div>
        <div className="appbar-spacer"/>
        <button className="icon-btn" title="Search (⌘K)" aria-label="Open command menu" onClick={()=>window.__oiCommandOpen&&window.__oiCommandOpen()}><Icon name="search" size={15}/></button>
        <ThemeToggle/>
        <FreshnessChip/>
        <div className="env-badge">Design partner</div>
        <select value={customActive ? '' : period} aria-label="Time period"
                onChange={e=>{ if(e.target.value){ setRangeStart(''); setRangeEnd(''); setPeriod(e.target.value); } }}
                style={{background:'var(--bg-elevated)', border:'1px solid var(--border-subtle)', borderRadius:6, color:'var(--text-primary)', fontSize:12, padding:'4px 8px', cursor:'pointer'}}>
          {customActive && <option value="">Custom range</option>}
          {PERIODS.map(p=>(<option key={p.key} value={p.key}>{p.label}</option>))}
        </select>
        <div className="seg" style={{gap:6, alignItems:'center', paddingLeft:8}} title="Custom date range — review any two dates">
          <input type="date" aria-label="From date" value={rangeStart} min={REAL_START} max={REAL_END}
                 onChange={e=>setRangeStart(e.target.value)}
                 style={{background:'transparent', border:'1px solid var(--border-subtle)', borderRadius:6, color: customActive?'var(--text-primary)':'var(--text-muted)', fontSize:11, padding:'3px 6px', colorScheme:'light dark', cursor:'pointer'}}/>
          <span style={{color:'var(--text-faint)', fontSize:11}}>→</span>
          <input type="date" aria-label="To date" value={rangeEnd} min={rangeStart||REAL_START} max={REAL_END}
                 onChange={e=>setRangeEnd(e.target.value)}
                 style={{background:'transparent', border:'1px solid var(--border-subtle)', borderRadius:6, color: customActive?'var(--text-primary)':'var(--text-muted)', fontSize:11, padding:'3px 6px', colorScheme:'light dark', cursor:'pointer'}}/>
          {customActive && <button onClick={()=>{setRangeStart('');setRangeEnd('');}} title="Clear custom range" style={{background:'transparent',border:'none',color:'var(--text-faint)',cursor:'pointer',fontSize:14,lineHeight:1,padding:'0 2px'}}>×</button>}
        </div>
        {(() => {
          // Sign out — only in an authenticated workspace (OI_ASK present); hidden in the
          // public demo, where there's no session to end. Clears the Supabase session and
          // sends the whole page (this dashboard runs in a same-origin iframe) to the homepage.
          const ask = getOIAsk();
          const authed = !!(ask && ask.brand_id && typeof ask.getJwt === 'function');
          if (!authed) return null;
          const signOut = async () => {
            try { const sb = window.FRKL_LIVE && window.FRKL_LIVE.sb; if (sb && sb.auth) await sb.auth.signOut(); } catch (e) { /* fall through to hard-clear */ }
            try {
              // Belt-and-braces so the user is fully logged out even if the client instance
              // wasn't reachable: drop any persisted Supabase session + the demo passcode gate.
              Object.keys(localStorage).forEach(k => { if (/^sb-.*-auth-token$/.test(k)) localStorage.removeItem(k); });
              localStorage.removeItem('oi_gate_v1');
            } catch (e) {}
            (window.top || window).location.href = '/';
          };
          return (<button onClick={signOut} title="Sign out" aria-label="Sign out"
            style={{background:'transparent', border:'1px solid var(--border-subtle)', borderRadius:6, color:'var(--text-muted)', fontSize:12, fontWeight:600, padding:'4px 10px', marginLeft:'var(--s-1)', cursor:'pointer', fontFamily:'inherit', whiteSpace:'nowrap'}}>
            Sign out
          </button>);
        })()}
      </div>
    </div>

    <div className="app-shell">
      <nav className="sidebar">
        <button className="nav-cmd" onClick={()=>window.__oiCommandOpen&&window.__oiCommandOpen()}>
          <Icon name="search" size={14}/> Search… <kbd>⌘K</kbd>
        </button>
        {(()=>{ let prev=null; return RAIL.map((e,i) => {
          const head = (e.group && e.group!==prev) ? <div className="nav-label">{e.group}</div> : null;
          prev = e.group;
          return (<React.Fragment key={i}>
            {head}
            <div className={'nav-item' + (railActive(e) ? ' active' : '')} onClick={()=>goRail(e)} style={e.pin?{marginTop:'auto',borderTop:'1px solid var(--border-subtle)',borderRadius:0,paddingTop:'13px',marginLeft:2,marginRight:2}:undefined}>
              <Icon name={e.icon||'info'} size={17}/>{e.label}
            </div>
          </React.Fragment>);
        }); })()}
      </nav>
      <main className="app-main">
        <div className="wrap">
      {/* Sub-nav: only render when the section has >1 sub-tab */}
      {activeSection.subtabs.length > 1 && (
        <div className="subnav">
          {activeSection.subtabs.map(t => (
            <div key={t.id}
                 className={'subtab' + (activeSubId === t.id ? ' active' : '')}
                 onClick={()=>setSubTabBySection({...subTabBySection, [section]: t.id})}>
              {t.label}
            </div>
          ))}
          <div style={{flex:1}}/>
          <div className="meta" style={{fontSize:11}} title={D.meta.source}>{(D.meta.source||'').split('—')[0].trim()||'Live data'} · updated {D.meta.captured}</div>
        </div>
      )}

      {/* Freshness now lives as a compact chip in the app bar (FreshnessChip). */}
      <BrandAgeBanner/>

      {/* Nudge: if gross_margin isn't set, the engine skips this brand — surface it everywhere. */}
      <MarginNudge/>

      {/* Active sub-tab */}
      {activeSubTab.component({start, period, customActive})}
        </div>
      </main>
    </div>

    {/* Product footer — quiet, signals "real product" */}
    <footer className="app-footer">
      <div className="app-footer-brand">
        <div className="brand-mark" style={{width:18, height:18}}>
          <svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" aria-label="Greta">
            <defs>
              <linearGradient id="ffpb" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#8B5CF6"/><stop offset="1" stopColor="#38BDF8"/></linearGradient>
              <linearGradient id="ffgm" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#22D3A6"/><stop offset="1" stopColor="#5DE5C8"/></linearGradient>
            </defs>
            <rect x="49" y="30" width="138" height="41" rx="20.5" transform="rotate(-45 118 50.5)" fill="url(#ffpb)"/>
            <rect x="71" y="177" width="138" height="41" rx="20.5" transform="rotate(-45 140 197.5)" fill="url(#ffgm)"/>
            <circle cx="97" cy="132" r="24" fill="#0B132B"/>
          </svg>
        </div>
        <span>greta</span>
      </div>
      <span className="app-footer-dot"/>
      <span title={D.meta.source}>{(OI_BRAND.name||'frkl')} workspace · {(D.meta.source||'').split('—')[0].trim()||'Live data'}</span>
      <span className="app-footer-dot"/>
      <span>data updated {D.meta.captured}</span>
      <div style={{flex:1}}/>
      <span>Auto-updates daily</span>
    </footer>
    <ToastHost/>
    <CommandMenu/>
    <EvidenceDrawer/>
    <StickyHealthBar/>
    <nav className="mobile-botnav">
      {MOBILE_NAV.map((e,i)=>(
        <button key={i} className={'mb-item'+(railActive(e)?' active':'')} onClick={()=>goRail(e)}>
          <Icon name={e.icon} size={19}/><span>{e.label}</span>
        </button>
      ))}
      <button className="mb-item" onClick={()=>window.__oiCommandOpen&&window.__oiCommandOpen()}>
        <Icon name="search" size={19}/><span>More</span>
      </button>
    </nav>
  </div>);
}
ReactDOM.createRoot(document.getElementById('root')).render(<App/>);

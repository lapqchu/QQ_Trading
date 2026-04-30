// FX Dashboard — full port from v1, backend-driven
import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import Plot from "react-plotly.js";
import { getCurrencies, getHistory, getHistoryCustom, getSnapshot, liveStart, liveStop, openChannel, getIpaForward, t1Backfill } from "./api.js";
import { buildAllData, calcCustom, valueModeForSource, mergeT1, sourceQuality } from "./dataTransform.js";
import { F, FP, CC, HB, cS, tS, sS, mid, implYld, fwdFwdIy, mcI, calcSMA, calcEMA, calcRSI, calcBB, calcMACD, calcStats, calcZDev, backtest, STRAT_DESCS } from "./calc.js";
import { fD, daysBtwn, buildIMMDates, computeSpotDate, addMon, bizBefore, dateFromSpot } from "./dates.js";

// ── NDF / Deliverable spread templates ──
const NDF_BROKER_TENORS = [
  {label:"1M Tomfix",type:"outright",m:1},
  {label:"1Wx1M",type:"spread",near:0,far:1},{label:"1Mx2M",type:"spread",near:1,far:2},
  {label:"1Mx3M",type:"spread",near:1,far:3},{label:"1Mx6M",type:"spread",near:1,far:6},
  {label:"1Mx9M",type:"spread",near:1,far:9},{label:"1Mx12M",type:"spread",near:1,far:12},
  {label:"12Mx18M",type:"spread",near:12,far:18},{label:"12Mx2Y",type:"spread",near:12,far:24},
  {label:"3Mx6M",type:"spread",near:3,far:6},{label:"6Mx9M",type:"spread",near:6,far:9},{label:"9Mx12M",type:"spread",near:9,far:12},
];

const PLOT_LAYOUT = {
  paper_bgcolor:"#0F172A",plot_bgcolor:"#131C2E",
  font:{color:"#94A3B8",size:9,family:"Inter,system-ui"},
  margin:{l:50,r:50,t:30,b:34,pad:2},
  xaxis:{gridcolor:"#1E293B",zerolinecolor:"#475569",tickfont:{size:8},autorange:true,automargin:true},
  yaxis:{gridcolor:"#1E293B",zerolinecolor:"#475569",tickfont:{size:8},autorange:true,automargin:true,rangemode:"normal"},
  dragmode:"zoom",hovermode:"x unified",
  legend:{font:{size:8},bgcolor:"transparent",x:0.01,y:0.99},
};
const PLOT_CFG={responsive:true,displayModeBar:true,modeBarButtonsToRemove:["lasso2d","select2d","toImage"],displaylogo:false,scrollZoom:true};

// Sticky first column: freeze the tenor label while horizontally scrolling wide tables.
const STICKY_TH = { position: "sticky", left: 0, zIndex: 4, background: "#0F172A" };
const stickyTd = (rowBg) => ({ position: "sticky", left: 0, zIndex: 1, background: rowBg });

function PChart({traces,layout,height=190,revisionKey}){
  const mergedX={...PLOT_LAYOUT.xaxis,...(layout?.xaxis||{})};
  const mergedY={...PLOT_LAYOUT.yaxis,...(layout?.yaxis||{})};
  const mergedY2=layout?.yaxis2?{...PLOT_LAYOUT.yaxis,overlaying:"y",side:"right",gridcolor:"transparent",...layout.yaxis2}:undefined;
  const uirev=revisionKey||layout?.uirevision||"preserve";
  const l={...PLOT_LAYOUT,...layout,height,xaxis:mergedX,yaxis:mergedY,uirevision:uirev};
  if(mergedY2)l.yaxis2=mergedY2;
  return <Plot data={traces} layout={l} config={PLOT_CFG} style={{width:"100%"}} useResizeHandler/>;
}

// Module-scope: must NOT be inlined inside MainApp or each render creates a
// new component identity, forcing Plotly to remount and resetting zoom/pan
// every live-mode tick.
function SprChart({rows,title,color,height=150}){
  const safe=Array.isArray(rows)?rows:[];
  if(!safe.length){
    // Empty-state placeholder so kind-mates render the same layout (per-ccy
    // data gaps must not change UI structure).
    return(
      <div style={{marginBottom:6,background:"#131C2E",borderRadius:5,padding:6,height,display:"flex",flexDirection:"column",justifyContent:"center"}}>
        <div style={{fontSize:9.5,fontWeight:800,color,letterSpacing:".05em",marginBottom:3}}>{title}</div>
        <div style={{color:"#475569",fontSize:9,fontStyle:"italic",textAlign:"center"}}>no data for this currency</div>
      </div>
    );
  }
  const xs=safe.map(s=>s.label);
  const ys=safe.map(s=>s.pM);
  const iy=safe.map(s=>s.fIy);
  const hasIy=iy.some(v=>v!=null&&isFinite(v));
  const traces=[{x:xs,y:ys,type:"bar",name:"Pts",marker:{color:ys.map(v=>v!=null&&v>=0?color:"#F472B6")}}];
  if(hasIy)traces.push({x:xs,y:iy,type:"scatter",mode:"lines+markers",name:"Impl%",line:{color:"#10B981",width:1.5},marker:{size:3},yaxis:"y2"});
  const layout={title:{text:title,font:{size:10}},yaxis:{title:"Pts"}};
  if(hasIy)layout.yaxis2={title:"%",overlaying:"y",side:"right",gridcolor:"transparent"};
  return(
    <div style={{marginBottom:6}}>
      <PChart traces={traces} layout={layout} height={height} revisionKey={`spr-${title}`}/>
    </div>
  );
}

// ── Helper: extract mid value from a history bar ──
// Zero IS valid data for swap points — only treat null/undefined/NaN as missing.
function barMid(bar){
  const t=bar.TRDPRC_1, b=bar.BID, a=bar.ASK;
  const tOk=t!=null&&isFinite(t);
  const bOk=b!=null&&isFinite(b);
  const aOk=a!=null&&isFinite(a);
  if(!tOk&&!bOk&&!aOk)return null;
  if(bOk&&aOk)return(b+a)/2;
  if(tOk)return t;
  if(bOk)return b;
  if(aOk)return a;
  return null;
}

// ── Build a per-date SOFR map from history response, picking the RIC whose
//    tenor is closest to `targetMonths`. Returns { "YYYY-MM-DD": sofr% }.
function buildSofrHist(data,targetMonths){
  if(!data?.history)return null;
  const rics=Object.keys(data.history);
  const sofrRics=rics.filter(r=>r.startsWith("USDSROIS"));
  if(!sofrRics.length)return null;
  const ricMonths=sofrRics.map(r=>{
    const m=r.match(/USDSROIS(\d+)([MY])=/i);
    if(!m)return[r,null];
    const n=parseInt(m[1]),u=m[2].toUpperCase();
    return[r,u==='Y'?n*12:n];
  }).filter(([,m])=>m!=null);
  if(!ricMonths.length)return null;
  const tgt=targetMonths==null?1:Math.max(0.1,targetMonths);
  ricMonths.sort((a,b)=>Math.abs(a[1]-tgt)-Math.abs(b[1]-tgt));
  const chosen=ricMonths[0][0];
  const bars=data.history[chosen]||[];
  const out={};
  for(const b of bars){const v=barMid(b);if(v!=null&&b.Date)out[b.Date.slice(0,10)]=v;}
  return out;
}

// ── Map a RIC to its approximate month value for interpolation ──
function ricToMonth(ric){
  const m=ric.match(/(\d+)(M|Y|W)/i);
  if(!m)return 0; // spot
  const n=parseInt(m[1]),u=m[2].toUpperCase();
  if(u==='Y')return n*12;
  if(u==='W')return n/4;
  return n;
}

// ── Parse a tenor label to its month value ──
function tenorToMonth(tenor){
  if(!tenor||tenor==='Spot')return 0;
  // "IMM Jun25" style — can't map to fixed month, caller passes monthHint
  const m=tenor.match(/^(\d+)(M|Y|W)$/i);
  if(!m)return null;
  const n=parseInt(m[1]),u=m[2].toUpperCase();
  if(u==='Y')return n*12;
  if(u==='W')return n/4;
  return n;
}

// ── Build historical timeseries for any tenor ──
// Strategy: 1) try direct RIC match, 2) if not found, interpolate from all anchor histories
function buildHistoryForTenor(data,tenor,isSwapPts,monthHint){
  if(!data?.history)return{pts:null,source:null};
  const rics=Object.keys(data.history);
  if(!rics.length)return{pts:null,source:null};

  // Step 1: try direct match
  const tenorClean=tenor.replace(/\s/g,'');
  let targetRic=null;
  for(const ric of rics){
    if(tenorClean==='Spot'&&!ric.match(/\d+(M|Y|W)/i)){targetRic=ric;break;}
    if(ric.includes(tenorClean)||ric.includes(tenorClean.replace('M','MNDF'))){targetRic=ric;break;}
  }
  if(targetRic){
    const bars=data.history[targetRic];
    if(bars&&bars.length>0){
      const pts=bars.map(bar=>({date:new Date(bar.Date),value:barMid(bar)})).filter(p=>p.value!=null&&!isNaN(p.value));
      if(pts.length>10)return{pts,source:'direct'};
    }
  }

  // Step 2: interpolate from all available anchor tenor histories
  const targetM=monthHint??tenorToMonth(tenor);
  if(targetM==null||targetM===0)return{pts:null,source:null};

  // Build per-RIC: {month, bars[]}
  const anchorData=[];
  for(const ric of rics){
    const m=ricToMonth(ric);
    if(m<=0)continue; // skip spot RIC (we add spot=0 synthetically below)
    const bars=data.history[ric];
    if(!bars||!bars.length)continue;
    anchorData.push({month:m,bars});
  }
  if(anchorData.length<1)return{pts:null,source:null};
  anchorData.sort((a,b)=>a.month-b.month);

  // Build date-indexed map: date → {month: value, ...}
  const dateMap=new Map();
  for(const{month,bars}of anchorData){
    for(const bar of bars){
      const d=bar.Date;
      if(!d)continue;
      const v=barMid(bar);
      if(v==null)continue;
      if(!dateMap.has(d))dateMap.set(d,{});
      dateMap.get(d)[month]=v;
    }
  }

  // For swap points: spot (month=0) always has 0 points, add as synthetic anchor.
  // This enables interpolation for weekly tenors (0.25, 0.5, 0.75) between spot and 1M.
  if(isSwapPts){
    for(const d of dateMap.keys()){dateMap.get(d)[0]=0;}
  }

  // For each date, if we have at least 2 anchor points, interpolate to targetM
  const months=isSwapPts?[0,...anchorData.map(a=>a.month)]:anchorData.map(a=>a.month);
  const sortedDates=[...dateMap.keys()].sort();
  const pts=[];
  for(const d of sortedDates){
    const vals=dateMap.get(d);
    const xs=[],ys=[];
    for(const m of months){if(vals[m]!=null){xs.push(m);ys.push(vals[m]);}}
    if(xs.length<2)continue;
    // Only interpolate within the range of available anchors (no extrapolation)
    if(targetM<xs[0]||targetM>xs[xs.length-1])continue;
    const interp=mcI(xs,ys);
    const v=interp(targetM);
    if(v!=null&&isFinite(v))pts.push({date:new Date(d),value:v});
  }
  if(pts.length>10)return{pts,source:'interpolated'};
  return{pts:pts.length>0?pts:null,source:pts.length>0?'interpolated':null};
}

// ── Build historical spread timeseries from two tenor legs ──
// For rolling spreads (e.g. 1Mx3M): get each leg's history, compute spread day-by-day
function buildSpreadHistory(data,nearM,farM){
  if(!data?.history)return{pts:null,source:null};
  const rics=Object.keys(data.history);
  if(!rics.length)return{pts:null,source:null};

  // Helper: get history for a specific month (direct or interpolated)
  function getMonthSeries(targetM){
    // Try direct RIC match first
    for(const ric of rics){
      const m=ricToMonth(ric);
      if(m===targetM){
        const bars=data.history[ric];
        if(bars&&bars.length>0){
          const map=new Map();
          for(const bar of bars){const v=barMid(bar);if(v!=null&&bar.Date)map.set(bar.Date,v);}
          if(map.size>5)return{map,source:'direct'};
        }
      }
    }
    // Interpolate from all available anchors
    const anchorData=[];
    for(const ric of rics){
      const m=ricToMonth(ric);
      if(m<=0)continue;
      const bars=data.history[ric];
      if(!bars||!bars.length)continue;
      anchorData.push({month:m,bars});
    }
    if(anchorData.length<2)return{map:new Map(),source:null};
    anchorData.sort((a,b)=>a.month-b.month);
    const months=anchorData.map(a=>a.month);
    if(targetM<months[0]||targetM>months[months.length-1])return{map:new Map(),source:null};
    // Build date-indexed anchor data
    const dateMap=new Map();
    for(const{month,bars}of anchorData){
      for(const bar of bars){const d=bar.Date;if(!d)continue;const v=barMid(bar);if(v==null)continue;if(!dateMap.has(d))dateMap.set(d,{});dateMap.get(d)[month]=v;}
    }
    const map=new Map();
    for(const[d,vals]of dateMap){
      const xs=[],ys=[];
      for(const m of months){if(vals[m]!=null){xs.push(m);ys.push(vals[m]);}}
      if(xs.length<2)continue;
      if(targetM<xs[0]||targetM>xs[xs.length-1])continue;
      const v=mcI(xs,ys)(targetM);
      if(v!=null&&isFinite(v))map.set(d,v);
    }
    return{map,source:map.size>0?'interpolated':null};
  }

  const nearSeries=getMonthSeries(nearM);
  const farSeries=getMonthSeries(farM);
  if(!nearSeries.source||!farSeries.source)return{pts:null,source:null};

  // Compute spread day-by-day: far - near
  const sortedDates=[...new Set([...nearSeries.map.keys(),...farSeries.map.keys()])].sort();
  const pts=[];
  for(const d of sortedDates){
    const nv=nearSeries.map.get(d),fv=farSeries.map.get(d);
    if(nv!=null&&fv!=null)pts.push({date:new Date(d),value:fv-nv});
  }
  const source=nearSeries.source==='direct'&&farSeries.source==='direct'?'direct':'interpolated';
  if(pts.length>10)return{pts,source};
  return{pts:pts.length>0?pts:null,source:pts.length>0?source:null};
}

// ══════════════════════ HIST MODAL ══════════════════════
function HistModal({tenor,val,isSwapPts,onClose,dpOverride,ccy,monthHint,nrM,frM,nrDate,frDate,brokersMeta,snap,fundingTenor,ad,selection,liveMid}){
  const[hist,setHist]=useState(null);
  const[histSource,setHistSource]=useState(null);
  const[loading,setLoading]=useState(true);
  const[unavailReason,setUnavailReason]=useState(null);
  const[sigN,setSigN]=useState(20);
  const[period,setPeriod]=useState("1Y");
  // Default contributor from user's ticked source selection. Priority:
  //   - If selection has exactly one item and it's a broker → use it.
  //   - If selection contains "composite" → null (composite).
  //   - If selection has multiple brokers (no composite) → first broker.
  const defaultContributor=(()=>{
    if(!selection||!selection.length)return null;
    if(selection.includes("composite"))return null;
    return selection.find(s=>s!=="composite")||null;
  })();
  const[contributor,setContributor]=useState(defaultContributor);
  const[viewMode,setViewMode]=useState("swap"); // swap|iy|ppd|carryDecomp
  const[spotHist,setSpotHist]=useState(null); // map: Date(yyyy-mm-dd) → spot mid (for IY calc)
  const[sofrHist,setSofrHist]=useState(null); // map: yyyy-mm-dd → nearest-tenor SOFR% (for IY calc)
  const[rawHist,setRawHist]=useState(null); // pre-transform raw points for IY recalc
  const[rawHistData,setRawHistData]=useState(null); // full history response for carry decomp
  const[customNear,setCustomNear]=useState(nrDate||"");
  const[customFar,setCustomFar]=useState(frDate||"");
  const[customSeries,setCustomSeries]=useState(null);
  // Issue 4: if both legs are anchor tenors, use the standard getHistory path (direct RICs)
  // instead of the interpolation path, even when IPA dates are available.
  const anchorSet=new Set(snap?.anchorTenorsM||snap?.tenorsM||[1,2,3,6,9,12,18,24]);
  const bothLegsAnchor=nrM!=null&&frM!=null&&(nrM===0||anchorSet.has(nrM))&&anchorSet.has(frM);
  const useBackendCustom=!!(nrDate&&frDate)&&!bothLegsAnchor;
  // Pip-convention transform: raw history values → displayed (pip) values.
  const PF=snap?.pipFactor||1e3;
  const vm=valueModeForSource(snap,contributor);
  const pipMul=vm==="outright"?PF:1;
  function transformPts(rawPts){
    if(!rawPts)return rawPts;
    return rawPts.map(p=>({date:p.date,value:p.value==null?null:p.value*pipMul})).filter(p=>p.value!=null&&!isNaN(p.value));
  }
  useEffect(()=>{
    let cancelled=false;
    setLoading(true);
    setUnavailReason(null);
    setHistSource(null);
    // Funding-tenor (ON/TN/SN) history: backend supports tenor= param.
    if(fundingTenor){
      getHistory(ccy,{period,contributor,tenor:fundingTenor}).then(data=>{
        if(cancelled)return;
        const rics=Object.keys(data?.history||{});
        // Pick the first funding RIC (prefer one matching contributor suffix, else base).
        let chosen=null;
        for(const r of rics){if(r.includes(`${fundingTenor}=`)&&(!contributor||r.endsWith(contributor))){chosen=r;break;}}
        if(!chosen)for(const r of rics){if(r.includes(`${fundingTenor}=`)){chosen=r;break;}}
        const bars=chosen?data.history[chosen]:[];
        const rawPts=bars.map(b=>({date:new Date(b.Date),value:barMid(b)})).filter(p=>p.value!=null&&!isNaN(p.value));
        if(rawPts.length>10){
          setRawHist(rawPts);
          setHist(transformPts(rawPts));
          setHistSource('direct');
          // Extract spot series too
          const spotRic=rics.find(r=>r.match(/^[A-Z]{6}=$/));
          const sMap={};
          if(spotRic&&data.history[spotRic]){for(const b of data.history[spotRic]){const v=barMid(b);if(v!=null&&b.Date)sMap[b.Date]=v;}}
          setSpotHist(sMap);
          setSofrHist(buildSofrHist(data,fundingTenor==="ON"||fundingTenor==="TN"||fundingTenor==="SN"?"1M":null));
        }else{setHist(null);setRawHist(null);setUnavailReason(`No funding history for ${fundingTenor}`);}
        setLoading(false);
      }).catch(err=>{if(!cancelled){setHist(null);setUnavailReason(`funding history error: ${err?.message||"failed"}`);setLoading(false);}});
      return()=>{cancelled=true;};
    }
    // Custom-date fwd-fwd: call backend endpoint directly, skip local interp.
    if(useBackendCustom){
      getHistoryCustom({ccy,near:nrDate,far:frDate,period,contributor}).then(d=>{
        if(cancelled)return;
        const series=d?.series||[];
        if(series.length>10){
          const rawPts=series.map(p=>({date:new Date(p.date),value:p.spread})).filter(p=>p.value!=null&&!isNaN(p.value));
          setRawHist(rawPts);
          setHist(transformPts(rawPts));
          setHistSource(d.interpolated?"interpolated":"direct");
        }else{
          setHist(null);
          // Backend now returns a `reason` field describing why series is empty
          // (LSEG inactive / no anchor data / sparse curve / past maturity).
          // Also report ricsRequested vs ricsWithData so the user can see how
          // many anchor RICs failed.
          const ricsInfo=d?.ricsRequested!=null?` [${d.ricsWithData||0}/${d.ricsRequested} anchor RICs returned data]`:"";
          const reason=d?.reason||(series.length>0?`only ${series.length} data points from backend`:"no historical data for this window");
          setUnavailReason(`${reason}${ricsInfo}`);
        }
        setLoading(false);
      }).catch(err=>{
        if(!cancelled){setHist(null);setUnavailReason(`history-custom error: ${err?.message||"failed"}`);setLoading(false);}
      });
      return()=>{cancelled=true;};
    }
    getHistory(ccy,{period,contributor}).then(data=>{
      if(cancelled)return;
      setRawHistData(data); // store full response for carry decomp
      // If nrM/frM provided, this is a spread — compute from individual tenor legs
      const isSpread=nrM!=null&&frM!=null;
      const{pts,source}=isSpread
        ?buildSpreadHistory(data,nrM,frM)
        :buildHistoryForTenor(data,tenor,isSwapPts,monthHint);
      if(pts&&pts.length>10){
        setRawHist(pts);
        setHist(transformPts(pts));
        setHistSource(source);
        // Extract spot series (for IY view)
        const rics=Object.keys(data.history||{});
        const spotRic=rics.find(r=>r.match(/^[A-Z]{6}=$/));
        const sMap={};
        if(spotRic&&data.history[spotRic]){for(const b of data.history[spotRic]){const v=barMid(b);if(v!=null&&b.Date)sMap[b.Date]=v;}}
        setSpotHist(sMap);
        // Build SOFR-per-date history for IY view: pick RIC matching current tenor, else fall back.
        setSofrHist(buildSofrHist(data,monthHint||(nrM!=null&&frM!=null?(frM-nrM):null)));
      }else{
        setHist(null);
        setUnavailReason(pts&&pts.length>0
          ?`Only ${pts.length} data points available (minimum 10 required)`
          :isSpread
            ?`No anchor data to build spread history (${nrM}M vs ${frM}M legs)`
            :"No anchor data available from LSEG to build history for this tenor");
      }
      setLoading(false);
    }).catch((err)=>{
      if(!cancelled){
        setHist(null);
        setUnavailReason(`LSEG history API error: ${err?.message||"connection failed"}`);
        setLoading(false);
      }
    });
    return()=>{cancelled=true;};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[ccy,tenor,isSwapPts,monthHint,nrM,frM,nrDate,frDate,period,contributor]);

  // Carry decomposition needs the anchor-tenor history (rawHistData). The
  // standard getHistory path above sets it, but the fundingTenor and
  // useBackendCustom paths don't — fetch it here so carry-decomp works in
  // every viewing mode.
  useEffect(()=>{
    if(!fundingTenor&&!useBackendCustom)return; // standard path already sets rawHistData
    let cancelled=false;
    getHistory(ccy,{period,contributor}).then(d=>{if(!cancelled)setRawHistData(d);})
      .catch(()=>{if(!cancelled)setRawHistData(null);});
    return()=>{cancelled=true;};
  },[ccy,period,contributor,fundingTenor,useBackendCustom]);

  // Custom fwd-fwd spread history. Only fetch when the user has changed the
  // date inputs to something different from the initial spread the main chart
  // is already rendering. The main chart shows the spread for nrDate×frDate
  // either via the anchor-RIC path (bothLegsAnchor) or via getHistoryCustom
  // (useBackendCustom) — in both cases the custom chart would be a duplicate
  // when inputs match, so dedup must NOT gate on useBackendCustom.
  useEffect(()=>{
    if(!customNear||!customFar){setCustomSeries(null);return;}
    if(nrDate&&frDate&&customNear===nrDate&&customFar===frDate){setCustomSeries(null);return;}
    let cancelled=false;
    getHistoryCustom({ccy,near:customNear,far:customFar,period,contributor})
      .then(d=>{if(!cancelled)setCustomSeries(d);})
      .catch(()=>{if(!cancelled)setCustomSeries(null);});
    return()=>{cancelled=true;};
  },[ccy,customNear,customFar,period,contributor,nrDate,frDate]);
  // Tenor days — use IPA-derived days from the snapshot (same as live display),
  // NOT a per-bar changing value. This keeps PPD consistent with the live table.
  const tenorDays=(()=>{
    if(fundingTenor==="ON")return 1; if(fundingTenor==="TN")return 1; if(fundingTenor==="SN")return 1;
    if(nrM!=null&&frM!=null){
      // Try to get exact days from snapshot rows
      const nrRow=ad?.rows?.find(x=>x.month===nrM);
      const frRow=ad?.rows?.find(x=>x.month===frM);
      if(nrRow&&frRow&&frRow.dT!=null&&nrRow.dT!=null)return Math.max(1,frRow.dT-nrRow.dT);
      return Math.max(1,(frM-nrM)*30);
    }
    if(monthHint!=null){
      // Try to get exact days from snapshot row
      const row=ad?.rows?.find(x=>x.month===monthHint);
      if(row&&row.dT!=null)return Math.max(1,row.dT);
      return Math.max(1,Math.round(monthHint*30));
    }
    return 30;
  })();
  // Current SOFR for this tenor from live snapshot (approximation — SOFR history not fetched).
  const currentSofr=(()=>{
    if(!ad||!ad.rows)return null;
    const r=ad.rows.find(x=>x.month===(monthHint||Math.round(tenorDays/30)));
    return r?.sofT??null;
  })();
  // Build series per viewMode (computed before vHist so vHist can reference vals).
  let vals=[];
  if(hist){
    if(viewMode==="swap"){vals=hist.map(h=>h.value);}
    else if(viewMode==="ppd"){vals=hist.map(h=>h.value*365/Math.max(tenorDays,1)/PF);}
    else if(viewMode==="iy"){
      // Need spot per date + fwdPoints (raw) + current SOFR (approximation).
      vals=hist.map((h,i)=>{
        const raw=rawHist?.[i]?.value;
        if(raw==null)return null;
        const iso=h.date instanceof Date?h.date.toISOString().slice(0,10):null;
        const spot=spotHist?.[iso]??ad?.sMT;
        // Prefer per-date SOFR from history; fall back to previous bar; then current snapshot.
        let sofrForDate=null;
        if(sofrHist&&iso){
          sofrForDate=sofrHist[iso];
          if(sofrForDate==null){
            // walk back up to 7 days
            const d=new Date(iso);
            for(let k=1;k<=7&&sofrForDate==null;k++){d.setDate(d.getDate()-1);const key=d.toISOString().slice(0,10);sofrForDate=sofrHist[key];}
          }
        }
        if(sofrForDate==null)sofrForDate=currentSofr;
        if(spot==null||sofrForDate==null)return null;
        const fwd=vm==="outright"?spot+raw:spot+raw/PF;
        return implYld(fwd,spot,sofrForDate,tenorDays);
      });
    }
  }
  // View-aware history (swap/iy/ppd) for stats+indicators. Declared AFTER vals to avoid TDZ.
  const vHist=useMemo(()=>{
    if(!hist)return null;
    if(viewMode==="swap"||viewMode==="carryDecomp")return hist;
    const out=[];
    for(let i=0;i<hist.length;i++){const v=(typeof vals[i]==="number"&&isFinite(vals[i]))?vals[i]:null;if(v!=null)out.push({date:hist[i].date,value:v});}
    return out.length>5?out:null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[hist,viewMode]);
  const stats=useMemo(()=>vHist?calcStats(vHist,sigN):null,[vHist,sigN]);
  const rsiD=useMemo(()=>vHist?calcRSI(vHist):[],[vHist]);
  const macdD=useMemo(()=>vHist?calcMACD(vHist):{line:[],signal:[],hist:[]},[vHist]);
  const bb=useMemo(()=>vHist?calcBB(vHist):{upper:[],lower:[],mid:[]},[vHist]);
  const s20=useMemo(()=>vHist?calcSMA(vHist,20):[],[vHist]);
  const s50=useMemo(()=>vHist?calcSMA(vHist,50):[],[vHist]);
  const zDev=useMemo(()=>vHist?calcZDev(vHist,sigN):[],[vHist,sigN]);
  const[btPeriod,setBtPeriod]=useState(252);
  // btPeriod -1 = "Max" → use the full vHist window (limited only by the
  // outer Period selector at the top of the modal).
  const btRes=useMemo(()=>{
    if(!vHist)return[];
    const lookback=btPeriod===-1?vHist.length:btPeriod;
    return backtest(vHist,lookback);
  },[vHist,btPeriod]);
  const[selSt,setSelSt]=useState(null);const[hovSt,setHovSt]=useState(null);

  // ── Issue 6: Carry Decomposition ──
  // For each historical date, decompose total P&L into carry (curve roll-down) + market move.
  const carryDecomp=useMemo(()=>{
    if(!rawHistData?.history||!isSwapPts)return null;
    // Determine near/far dates. For spot-start, nearDate=spot, farDate=tenor VD.
    // For fwd-fwd, both come from the spread row.
    const spotDate=ad?.SPOT_DATE||computeSpotDate();
    let nearDate=null,farDate=null;
    if(nrM!=null&&frM!=null){
      // Fwd-fwd spread: use value dates from rows
      const nrRow=ad?.rows?.find(x=>x.month===nrM);
      const frRow=ad?.rows?.find(x=>x.month===frM);
      nearDate=nrRow?.valDate??(nrM===0?spotDate:null);
      farDate=frRow?.valDate??null;
    }else{
      // Spot-start tenor
      nearDate=spotDate;
      const mh=monthHint||1;
      const row=ad?.rows?.find(x=>x.month===mh);
      farDate=row?.valDate??null;
    }
    if(!nearDate||!farDate)return null;
    nearDate=nearDate instanceof Date?nearDate:new Date(nearDate);
    farDate=farDate instanceof Date?farDate:new Date(farDate);

    // Build per-date curves from anchor tenor history bars
    const rics=Object.keys(rawHistData.history);
    const anchorData=[];
    for(const ric of rics){
      const m=ricToMonth(ric);
      if(m<0)continue;
      const bars=rawHistData.history[ric];
      if(!bars||!bars.length)continue;
      anchorData.push({month:m,bars});
    }
    if(anchorData.length<2)return null;

    // Build date-indexed map: date -> {month: value, ...}
    const dateMap=new Map();
    for(const{month,bars}of anchorData){
      for(const bar of bars){
        const d=bar.Date?.slice(0,10);
        if(!d)continue;
        const v=barMid(bar);
        if(v==null)continue;
        if(!dateMap.has(d))dateMap.set(d,{});
        dateMap.get(d)[month]=v;
      }
    }
    // Add spot=0 for swap points interpolation
    for(const d of dateMap.keys())dateMap.get(d)[0]=0;

    const months=[0,...anchorData.map(a=>a.month)].sort((a,b)=>a-b);
    const sortedDates=[...dateMap.keys()].sort();
    if(sortedDates.length<3)return null;

    // For each date, build interpolation function and evaluate at target day-counts
    function buildCurveForDate(d){
      const vals=dateMap.get(d);
      if(!vals)return null;
      const xs=[],ys=[];
      for(const m of months){if(vals[m]!=null){xs.push(m*30);ys.push(vals[m]*pipMul);}}
      if(xs.length<2)return null;
      return mcI(xs,ys);
    }

    // Compute the spread for a given curve at given near/far day-counts
    function spreadOnCurve(curve,dNear,dFar){
      if(!curve)return null;
      const ptsNear=dNear<=0?0:curve(dNear);
      const ptsFar=dFar<=0?0:curve(dFar);
      if(ptsNear==null||ptsFar==null)return null;
      return ptsFar-ptsNear;
    }

    const results=[];
    let cumTotal=0;
    for(let i=1;i<sortedDates.length;i++){
      const dToday=sortedDates[i];
      const dYest=sortedDates[i-1];
      const curveToday=buildCurveForDate(dToday);
      const curveYest=buildCurveForDate(dYest);
      if(!curveToday||!curveYest)continue;

      const today=new Date(dToday);
      // Days from today's date to fixed near/far dates
      const daysToNear=Math.round((nearDate-today)/864e5);
      const daysToFar=Math.round((farDate-today)/864e5);
      // Past maturity check
      if(daysToNear<-5)continue; // well past near date
      if(daysToFar<0)continue;

      const daysToNearYest=daysToNear+1; // yesterday had 1 more day
      const daysToFarYest=daysToFar+1;

      // Carry = roll-down from 1 day passing on YESTERDAY's curve
      const spreadYestAtYestDays=spreadOnCurve(curveYest,Math.max(daysToNearYest,0),Math.max(daysToFarYest,0));
      const spreadYestAtTodayDays=spreadOnCurve(curveYest,Math.max(daysToNear,0),Math.max(daysToFar,0));
      // Market move = curve shift (today's curve vs yesterday's, both at today's day-counts)
      const spreadTodayAtTodayDays=spreadOnCurve(curveToday,Math.max(daysToNear,0),Math.max(daysToFar,0));

      if(spreadYestAtYestDays==null||spreadYestAtTodayDays==null||spreadTodayAtTodayDays==null)continue;

      // For spot-start (near=0 days), carry = roll of the far leg only
      const carry=spreadYestAtTodayDays-spreadYestAtYestDays;
      const move=spreadTodayAtTodayDays-spreadYestAtTodayDays;
      const total=carry+move;
      cumTotal+=total;
      results.push({date:today,carry,move,total,cumTotal});
    }
    return results.length>5?results:null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[rawHistData,nrM,frM,monthHint,ad?.SPOT_DATE,isSwapPts,pipMul]);

  const dates=hist?hist.map(h=>h.date):[];
  const yLabel=viewMode==="swap"?(isSwapPts?"Swap Points (pips)":"Level")
    :viewMode==="iy"?"Implied Yield (%)"
    :viewMode==="ppd"?"PPD":"Carry Decomp (pips)";
  // Consistency indicator: last bar vs. live mid (swap-pts view only).
  const lastBar=(vals&&vals.length)?vals[vals.length-1]:null;
  const liveVsLast=(()=>{
    if(viewMode!=="swap"||liveMid==null||lastBar==null||!isFinite(lastBar))return null;
    const diff=Math.abs(lastBar-liveMid);
    const tol=Math.max(1,Math.abs(liveMid)*0.05); // 5% or 1 pip, whichever is bigger
    return{ok:diff<=tol,last:lastBar,live:liveMid,diff};
  })();
  const priceTraces=[
    {x:dates,y:vals,type:"scatter",mode:"lines",name:tenor,line:{color:"#10B981",width:1.8}},
    {x:dates,y:s20,type:"scatter",mode:"lines",name:"SMA(20)",line:{color:"#FBBF24",width:1,dash:"dot"},opacity:.7},
    {x:dates,y:s50,type:"scatter",mode:"lines",name:"SMA(50)",line:{color:"#A78BFA",width:1,dash:"dot"},opacity:.7},
    {x:dates,y:bb.upper,type:"scatter",mode:"lines",name:"BB Upper",line:{color:"#3B82F6",width:.8},showlegend:false},
    {x:dates,y:bb.lower,type:"scatter",mode:"lines",name:"BB Lower",line:{color:"#3B82F6",width:.8},fill:"tonexty",fillcolor:"rgba(59,130,246,0.06)",showlegend:false},
  ];
  const rsiTraces=[{x:dates,y:rsiD,type:"scatter",mode:"lines",name:"RSI(14)",line:{color:"#A78BFA",width:1.3}}];
  const macdTraces=[
    {x:dates.slice(1),y:macdD.hist,type:"bar",name:"Hist",marker:{color:macdD.hist.map(v=>v>=0?"rgba(74,222,128,.5)":"rgba(244,114,182,.5)")}},
    {x:dates,y:macdD.line,type:"scatter",mode:"lines",name:"MACD",line:{color:"#3B82F6",width:1.3}},
    {x:dates,y:macdD.signal,type:"scatter",mode:"lines",name:"Signal",line:{color:"#F59E0B",width:1}},
  ];
  const SR=({l,v,dp=3})=>(<div style={{display:"flex",justifyContent:"space-between",padding:"1px 0",borderBottom:"1px solid #1E293B",fontSize:8.5}}><span style={{color:"#64748B"}}>{l}</span><span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{typeof v==="number"?v.toFixed(dp):v}</span></div>);
  useEffect(()=>{const h=e=>{if(e.key==="Escape")onClose();};window.addEventListener("keydown",h);return()=>window.removeEventListener("keydown",h);},[onClose]);
  if(loading){
    return(
      <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,.85)",zIndex:100,display:"flex",justifyContent:"center",alignItems:"center",padding:8}} onClick={onClose}>
        <div style={{background:"#0F172A",border:"1px solid #334155",borderRadius:8,width:"96%",maxWidth:400,padding:24,textAlign:"center"}} onClick={e=>e.stopPropagation()}>
          <div style={{fontSize:12,color:"#E2E8F0",marginBottom:8}}>Loading historical data...</div>
          <div style={{fontSize:10,color:"#64748B"}}>Fetching LSEG data for {tenor}</div>
          <button onClick={onClose} style={{marginTop:12,background:"#1E293B",border:"1px solid #334155",color:"#94A3B8",padding:"3px 10px",borderRadius:4,cursor:"pointer",fontSize:9}}>Close</button>
        </div>
      </div>
    );
  }
  if(!hist){
    return(
      <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,.85)",zIndex:100,display:"flex",justifyContent:"center",alignItems:"center",padding:8}} onClick={onClose}>
        <div style={{background:"#0F172A",border:"1px solid #334155",borderRadius:8,width:"96%",maxWidth:500,padding:24,textAlign:"center"}} onClick={e=>e.stopPropagation()}>
          <div style={{fontSize:13,color:"#EF4444",fontWeight:700,marginBottom:8}}>Historical Data Unavailable</div>
          <div style={{fontSize:10,color:"#94A3B8",marginBottom:4}}>{tenor} — {ccy}</div>
          <div style={{fontSize:10,color:"#F59E0B",marginBottom:12,padding:"8px 12px",background:"#1E293B",borderRadius:4,textAlign:"left"}}>{unavailReason||"No data returned by LSEG for this RIC/tenor combination."}</div>
          <div style={{fontSize:9,color:"#64748B",marginBottom:12}}>Check that the RIC exists in Workspace and the LSEG session is active.</div>
          <button onClick={onClose} style={{background:"#1E293B",border:"1px solid #334155",color:"#94A3B8",padding:"3px 10px",borderRadius:4,cursor:"pointer",fontSize:9}}>Close (ESC)</button>
        </div>
      </div>
    );
  }
  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,.85)",zIndex:100,display:"flex",justifyContent:"center",alignItems:"center",padding:8}} onClick={onClose}>
      <div style={{background:"#0F172A",border:"1px solid #334155",borderRadius:8,width:"96%",maxWidth:1300,maxHeight:"96vh",overflow:"auto",padding:12}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6,flexWrap:"wrap",gap:4}}>
          <h2 style={{fontSize:13,fontWeight:800,color:"#F8FAFC",margin:0}}>{tenor} — Historical {isSwapPts?"(Swap Points)":""}{histSource==='interpolated'&&<span style={{color:"#60A5FA",fontWeight:400,fontSize:9,marginLeft:8}}>Interpolated from anchor data</span>}{liveVsLast&&<span style={{marginLeft:8,fontSize:9,fontWeight:600,padding:"1px 6px",borderRadius:3,background:liveVsLast.ok?"#14532D":"#78350F",color:liveVsLast.ok?"#4ADE80":"#FBBF24"}} title={`last bar=${liveVsLast.last.toFixed(2)} · live=${liveVsLast.live.toFixed(2)} · Δ=${liveVsLast.diff.toFixed(2)}`}>{liveVsLast.ok?`\u2713 live matches last bar`:`\u26A0 last: ${liveVsLast.last.toFixed(1)} · live: ${liveVsLast.live.toFixed(1)}`}</span>}</h2>
          <div style={{display:"flex",gap:4,alignItems:"center",flexWrap:"wrap"}}>
            <div style={{display:"flex",gap:2}}>{["1D","5D","1M","3M","6M","1Y","3Y","5Y","10Y","Max"].map(p=>(<button key={p} onClick={()=>setPeriod(p)} style={{fontSize:7.5,padding:"1px 5px",borderRadius:3,border:"none",cursor:"pointer",background:period===p?"#3B82F6":"#1E293B",color:period===p?"#FFF":"#94A3B8"}}>{p}</button>))}</div>
            <div style={{display:"flex",gap:2,borderLeft:"1px solid #334155",paddingLeft:4}}>{[["swap","Swap Pts"],["iy","Impl Yld"],["ppd","PPD"],["carryDecomp","Carry Decomp"]].map(([k,l])=>(<button key={k} onClick={()=>setViewMode(k)} style={{fontSize:7.5,padding:"1px 5px",borderRadius:3,border:"none",cursor:"pointer",background:viewMode===k?"#8B5CF6":"#1E293B",color:viewMode===k?"#FFF":"#94A3B8"}}>{l}</button>))}</div>
            {brokersMeta&&Object.keys(brokersMeta).length>0&&(<select value={contributor||""} onChange={e=>setContributor(e.target.value||null)} style={{background:"#1E293B",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"1px 4px",fontSize:8}}>
              <option value="">Refinitiv</option>
              {Object.entries(brokersMeta).map(([code,m])=>(<option key={code} value={code}>{m.label||code}</option>))}
            </select>)}
            <span style={{fontSize:7.5,color:"#64748B"}}>Fwd-Fwd:</span>
            <input type="date" value={customNear} onChange={e=>setCustomNear(e.target.value)} style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"1px 3px",fontSize:8}}/>
            <input type="date" value={customFar} onChange={e=>setCustomFar(e.target.value)} style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"1px 3px",fontSize:8}}/>
            <button onClick={onClose} style={{background:"#1E293B",border:"1px solid #334155",color:"#94A3B8",padding:"3px 10px",borderRadius:4,cursor:"pointer",fontSize:9}}>Close (ESC)</button>
          </div>
        </div>
        <div style={{display:"grid",gridTemplateColumns:viewMode==="carryDecomp"?"1fr":"1fr 220px",gap:8}}>
          {viewMode==="carryDecomp"?(
            <div>
              {carryDecomp?(()=>{
                const cdDates=carryDecomp.map(d=>d.date);
                const cdCarry=carryDecomp.map(d=>d.carry);
                const cdMove=carryDecomp.map(d=>d.move);
                const cdCum=carryDecomp.map(d=>d.cumTotal);
                const totalCarry=cdCarry.reduce((a,b)=>a+b,0);
                const totalMove=cdMove.reduce((a,b)=>a+b,0);
                return(<>
                  <PChart traces={[
                    {x:cdDates,y:cdCarry,type:"bar",name:"Carry (roll-down)",marker:{color:"rgba(74,222,128,0.7)"}},
                    {x:cdDates,y:cdMove,type:"bar",name:"Market move",marker:{color:cdMove.map(v=>v>=0?"rgba(59,130,246,0.7)":"rgba(244,114,182,0.7)")}},
                    {x:cdDates,y:cdCum,type:"scatter",mode:"lines",name:"Cumulative",line:{color:"#FBBF24",width:2},yaxis:"y2"},
                  ]} layout={{
                    title:{text:`${tenor} Carry Decomposition`,font:{size:10,color:"#94A3B8"}},
                    barmode:"relative",
                    yaxis:{title:"Daily P&L (pips)"},
                    yaxis2:{title:"Cumulative (pips)",overlaying:"y",side:"right",gridcolor:"transparent"},
                  }} height={280} revisionKey={`carryDecomp-${tenor}`}/>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginTop:6,fontSize:9}}>
                    <div style={{background:"#131C2E",borderRadius:4,padding:6}}>
                      <div style={{color:"#64748B",fontSize:7.5,marginBottom:2}}>TOTAL CARRY</div>
                      <div style={{color:"#4ADE80",fontFamily:"monospace",fontWeight:700}}>{FP(totalCarry,1)} pips</div>
                    </div>
                    <div style={{background:"#131C2E",borderRadius:4,padding:6}}>
                      <div style={{color:"#64748B",fontSize:7.5,marginBottom:2}}>TOTAL MARKET MOVE</div>
                      <div style={{color:totalMove>=0?"#3B82F6":"#F472B6",fontFamily:"monospace",fontWeight:700}}>{FP(totalMove,1)} pips</div>
                    </div>
                    <div style={{background:"#131C2E",borderRadius:4,padding:6}}>
                      <div style={{color:"#64748B",fontSize:7.5,marginBottom:2}}>TOTAL P&L</div>
                      <div style={{color:"#FBBF24",fontFamily:"monospace",fontWeight:700}}>{FP(totalCarry+totalMove,1)} pips</div>
                    </div>
                  </div>
                </>);
              })():(
                <div style={{color:"#64748B",padding:20,fontSize:10,textAlign:"center"}}>
                  Carry decomposition unavailable. Requires swap-point history with at least 2 anchor tenor RICs.
                </div>
              )}
            </div>
          ):(
          <div>
            <PChart traces={priceTraces} layout={{title:{text:`${tenor} ${yLabel}`,font:{size:10,color:"#94A3B8"}},yaxis:{title:yLabel}}} height={210} revisionKey={`hist-${tenor}-${viewMode}`}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,marginTop:4}}>
              <PChart traces={rsiTraces} layout={{title:{text:"RSI(14)",font:{size:9,color:"#64748B"}},yaxis:{range:[0,100]},shapes:[{type:"line",y0:70,y1:70,x0:0,x1:1,xref:"paper",line:{color:"#F87171",dash:"dot",width:1}},{type:"line",y0:30,y1:30,x0:0,x1:1,xref:"paper",line:{color:"#4ADE80",dash:"dot",width:1}}]}} height={120} revisionKey={`hist-rsi-${tenor}-${viewMode}`}/>
              <PChart traces={macdTraces} layout={{title:{text:"MACD(12,26,9)",font:{size:9,color:"#64748B"}}}} height={120} revisionKey={`hist-macd-${tenor}-${viewMode}`}/>
            </div>
          </div>)}
          {viewMode!=="carryDecomp"&&<div style={{background:"#131C2E",borderRadius:5,padding:6,overflow:"auto",maxHeight:460}}>
            <div style={{fontSize:8,fontWeight:800,color:"#60A5FA",marginBottom:3,letterSpacing:".1em"}}>HIGH / LOW</div>
            {stats&&Object.entries(stats.ranges).map(([k,v])=>(<div key={k} style={{display:"flex",justifyContent:"space-between",padding:"1px 0",fontSize:8.5,borderBottom:"1px solid #1E293B"}}><span style={{color:"#64748B",width:22}}>{k}</span><span style={{color:"#4ADE80",fontFamily:"monospace"}}>{v.low.toFixed(isSwapPts?1:3)}</span><span style={{color:"#64748B"}}>—</span><span style={{color:"#F87171",fontFamily:"monospace"}}>{v.high.toFixed(isSwapPts?1:3)}</span></div>))}
            <div style={{fontSize:8,fontWeight:800,color:"#10B981",marginTop:5,marginBottom:3,letterSpacing:".1em"}}>STATISTICS</div>
            {stats&&<><SR l="Current" v={stats.current} dp={isSwapPts?1:(dpOverride||3)}/><SR l="Mean" v={stats.mean} dp={isSwapPts?1:(dpOverride||3)}/><SR l="Std Dev" v={stats.sd} dp={isSwapPts?1:4}/><SR l="Skewness" v={stats.skew} dp={2}/><SR l="Kurtosis" v={stats.kurt} dp={2}/><SR l="Pctl Rank" v={`${stats.pctR.toFixed(0)}%`}/></>}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:5,marginBottom:3}}>
              <span style={{fontSize:8,fontWeight:800,color:"#F87171",letterSpacing:".1em"}}>SIGMA-MOVE</span>
              <div style={{display:"flex",alignItems:"center",gap:2}}><span style={{fontSize:7,color:"#64748B"}}>N:</span>
                <input type="number" value={sigN} onChange={e=>setSigN(Math.max(5,Math.min(252,+e.target.value||20)))} style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"0 3px",fontSize:8,width:34,fontFamily:"monospace"}}/></div>
            </div>
            {stats&&<><SR l="Today's Δ" v={stats.dayChg!=null?stats.dayChg:"—"} dp={isSwapPts?1:4}/>
            <SR l={`${sigN}d σ(Δ)`} v={stats.rollSd!=null?stats.rollSd:"—"} dp={isSwapPts?2:5}/>
            <div style={{display:"flex",justifyContent:"space-between",padding:"1px 0",borderBottom:"1px solid #1E293B",fontSize:8.5}}><span style={{color:"#64748B"}}>σ-Move</span><span style={{color:stats.sigmaMove==null?"#475569":(Math.abs(stats.sigmaMove)>=2?"#F87171":Math.abs(stats.sigmaMove)>=1?"#FBBF24":"#4ADE80"),fontFamily:"monospace",fontWeight:700}}>{stats.sigmaMove!=null?stats.sigmaMove.toFixed(2)+"σ":"—"}</span></div></>}
            <div style={{fontSize:8,fontWeight:800,color:"#FBBF24",marginTop:5,marginBottom:3,letterSpacing:".1em"}}>INDICATORS</div>
            <SR l="SMA(20)" v={s20[s20.length-1]} dp={isSwapPts?1:(dpOverride||3)}/><SR l="SMA(50)" v={s50[s50.length-1]} dp={isSwapPts?1:(dpOverride||3)}/><SR l="RSI(14)" v={rsiD[rsiD.length-1]} dp={1}/><SR l="MACD" v={macdD.line[macdD.line.length-1]} dp={4}/><SR l="BB Upper" v={bb.upper[bb.upper.length-1]} dp={isSwapPts?1:(dpOverride||3)}/><SR l="BB Lower" v={bb.lower[bb.lower.length-1]} dp={isSwapPts?1:(dpOverride||3)}/>
            {stats&&<><SR l={`SMA(${sigN})`} v={stats.smaN!=null?stats.smaN:"—"} dp={isSwapPts?1:(dpOverride||3)}/>
            <SR l="Dev from MA" v={stats.devMA!=null?stats.devMA:"—"} dp={isSwapPts?1:4}/>
            <div style={{display:"flex",justifyContent:"space-between",padding:"1px 0",borderBottom:"1px solid #1E293B",fontSize:8.5}}><span style={{color:"#64748B"}}>Z(Dev,{sigN})</span><span style={{color:stats.zDev==null?"#475569":(Math.abs(stats.zDev)>=2?"#F472B6":Math.abs(stats.zDev)>=1?"#FBBF24":"#4ADE80"),fontFamily:"monospace",fontWeight:700}}>{stats.zDev!=null?stats.zDev.toFixed(2):"—"}</span></div></>}
          </div>}
        </div>
        {customSeries&&customSeries.series&&customSeries.series.length>0&&(
          <div style={{marginTop:8,background:"#131C2E",borderRadius:5,padding:6}}>
            <div style={{fontSize:9,fontWeight:800,color:"#60A5FA",letterSpacing:".1em",marginBottom:4}}>CUSTOM FWD-FWD SPREAD {customSeries.interpolated&&<span style={{color:"#FBBF24",fontWeight:400,fontSize:8,marginLeft:6}}>interpolated</span>}</div>
            <PChart traces={[{x:customSeries.series.map(p=>p.date),y:customSeries.series.map(p=>p.spread),type:"scatter",mode:"lines",name:`${customSeries.nearDate} × ${customSeries.farDate}`,line:{color:"#F59E0B",width:1.5}}]} layout={{title:{text:`Fwd-Fwd spread ${customSeries.nearDate} × ${customSeries.farDate}`,font:{size:9}},yaxis:{title:"Pts"}}} height={150} revisionKey={`custom-spr-${customSeries.nearDate}-${customSeries.farDate}`}/>
          </div>
        )}
        {/* Backtesting */}
        <div style={{marginTop:8,background:"#131C2E",borderRadius:5,padding:6}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
            <span style={{fontSize:9,fontWeight:800,color:"#F59E0B",letterSpacing:".1em"}}>STRATEGY BACKTESTING</span>
            <div style={{display:"flex",gap:3,alignItems:"center"}}><span style={{fontSize:8,color:"#64748B"}}>Period:</span>
              {[[22,"1M"],[66,"3M"],[132,"6M"],[252,"1Y"],[504,"2Y"],[756,"3Y"],[1260,"5Y"],[-1,"Max"]].map(([d,l])=>(<button key={d} onClick={()=>{setBtPeriod(d);setSelSt(null);}} style={{fontSize:7.5,padding:"1px 5px",borderRadius:3,border:"none",cursor:"pointer",background:btPeriod===d?"#3B82F6":"#1E293B",color:btPeriod===d?"#FFF":"#64748B"}}>{l}</button>))}</div>
          </div>
          {hovSt&&<div style={{background:"#0F172A",padding:"4px 8px",borderRadius:4,marginBottom:4,fontSize:8,color:"#94A3B8",border:"1px solid #334155"}}>{STRAT_DESCS[hovSt]||hovSt}</div>}
          <div style={{display:"grid",gridTemplateColumns:selSt!=null?"1fr 1fr":"1fr",gap:6}}>
            <table style={{borderCollapse:"collapse",width:"100%",fontSize:9}}>
              <thead><tr><th style={{...tS(),textAlign:"left"}}>Strategy</th><th style={tS("#FBBF24")}>Sharpe</th><th style={tS("#10B981")}>Cum P&L</th><th style={tS("#F87171")}>Max DD</th><th style={tS()}>Win%</th><th style={tS()}>Status</th></tr></thead>
              <tbody>{btRes.map((s,i)=>(<tr key={i} style={{background:selSt===i?"#1E3A5F":i%2===0?"#0F172A":"#131C2E",cursor:s.unavail?"default":"pointer"}} onClick={()=>!s.unavail&&setSelSt(selSt===i?null:i)} onMouseEnter={()=>setHovSt(s.name)} onMouseLeave={()=>setHovSt(null)}>
                <td style={{...cS("#CBD5E1",true),textAlign:"left"}}>{s.name}</td>
                <td style={cS(s.unavail?"#475569":(s.sharpe>0?"#FBBF24":"#F472B6"),!s.unavail)}>{s.unavail?"—":s.sharpe.toFixed(2)}</td>
                <td style={cS(s.unavail?"#475569":(s.cumRet>=0?"#4ADE80":"#F87171"))}>{s.unavail?"—":FP(s.cumRet,isSwapPts?1:3)+" pts"}</td>
                <td style={cS(s.unavail?"#475569":"#F87171")}>{s.unavail?"—":F(s.maxDD,isSwapPts?1:3)+" pts"}</td>
                <td style={cS("#64748B")}>{s.unavail?"—":(s.winRate*100).toFixed(0)+"%"}</td>
                <td style={cS(s.unavail?"#F87171":"#4ADE80")}>{s.unavail?<span title={s.reason}>N/A</span>:"OK"}</td>
              </tr>))}</tbody>
            </table>
            {selSt!=null&&btRes[selSt]&&!btRes[selSt].unavail&&(()=>{const st=btRes[selSt];
              return(<div>
                <PChart traces={[{x:st.dates,y:st.eqC.slice(1),type:"scatter",mode:"lines",name:"Cum P&L (pts)",line:{color:"#10B981",width:1.5}}]} layout={{title:{text:`${st.name} — Cumulative P&L (pts)`,font:{size:9,color:"#94A3B8"}},yaxis:{title:"Points"},shapes:[{type:"line",y0:0,y1:0,x0:0,x1:1,xref:"paper",line:{color:"#475569",dash:"dot"}}]}} height={110} revisionKey={`bt-eq-${tenor}-${selSt}-${btPeriod}`}/>
                <PChart traces={[{x:st.dates,y:st.rollSh,type:"scatter",mode:"lines",name:"Roll 20d Sharpe",line:{color:"#FBBF24",width:1.3}}]} layout={{title:{text:"Rolling 20d Sharpe",font:{size:9,color:"#94A3B8"}},shapes:[{type:"line",y0:0,y1:0,x0:0,x1:1,xref:"paper",line:{color:"#475569",dash:"dot"}}]}} height={100} revisionKey={`bt-sh-${tenor}-${selSt}-${btPeriod}`}/>
              </div>);})()}
          </div>
        </div>
      </div>
    </div>);
}

// ══════════════════════ FUNDING TABLE ══════════════════════
const FRESH_OPACITY={fresh:1.0,stale:0.6,very_stale:0.35,unknown:0.5};
function FundingTbl({ad,brokersMeta,onDbl}){
  const funding=ad.funding||{};
  const tenors=["ON","TN","SN"].filter(t=>funding[t]);
  if(!tenors.length)return null;
  // Union of source keys present across tenors, preserving order: composite first, then brokers.
  const srcSet=new Set();
  for(const t of tenors){const bs=funding[t]?.bySource||{};for(const k of Object.keys(bs))srcSet.add(k);}
  const selection=ad.selection||[];
  const sources=[];
  if(srcSet.has("composite")&&selection.includes("composite"))sources.push("composite");
  for(const b of (ad.cfg.brokers||[]))if(srcSet.has(b)&&selection.includes(b))sources.push(b);
  if(!sources.length)return null;
  const labelFor=k=>k==="composite"?"Refinitiv":(brokersMeta?.[k]?.label||k);
  const pdp=ad.cfg.pipDp??1;
  return(<div style={{background:"#131C2E",borderRadius:5,padding:6,marginBottom:6}}>
    <div style={{fontSize:9.5,fontWeight:800,color:"#FB923C",marginBottom:3,letterSpacing:".05em"}}>{ad.cfg.pair} FUNDING (ON / TN / SN)</div>
    <div style={{overflowX:"auto"}}><table style={{borderCollapse:"collapse",width:"100%",fontSize:9,minWidth:600}}>
      <thead><tr><th style={{...tS(),textAlign:"left",...STICKY_TH}}>Tenor</th>
        {sources.map(s=><React.Fragment key={s}><th style={tS("#4ADE80")}>{labelFor(s)} B</th><th style={tS("#FBBF24")}>{labelFor(s)} M</th><th style={tS("#F87171")}>{labelFor(s)} A</th></React.Fragment>)}
      </tr></thead>
      <tbody>{tenors.map((t,i)=>{const bySource=funding[t]?.bySource||{};const rowBg=i%2===0?"#0F172A":"#131C2E";return(<tr key={t} style={{background:rowBg,cursor:"pointer"}} title="Double-click for history" onDoubleClick={()=>onDbl&&onDbl(`${t} Funding`,funding[t]?.T?.mid||0,true,null,null,null,null,null,t)}>
        <td style={{...cS("#CBD5E1",true),textAlign:"left",...stickyTd(rowBg)}}>{t}</td>
        {sources.map(s=>{const v=bySource[s];const has=v&&v.hasData&&(v.T.bid!=null||v.T.mid!=null||v.T.ask!=null);const op=has?(FRESH_OPACITY[v.freshness]??1):1;
          return<React.Fragment key={s}>
            <td style={{...cS(has?"#4ADE80":"#334155"),opacity:op}}>{has?FP(v.T.bid,pdp):"—"}</td>
            <td style={{...cS(has?"#FBBF24":"#334155",true),opacity:op}} title={has?`${v.freshness||''} ${v.timact||''} ${v.ric||''}`:"no data"}>{has?FP(v.T.mid,pdp):"—"}</td>
            <td style={{...cS(has?"#F87171":"#334155"),opacity:op}}>{has?FP(v.T.ask,pdp):"—"}</td>
          </React.Fragment>;})}
      </tr>);})}</tbody></table></div></div>);
}

// ══════════════════════ SPREAD TABLE ══════════════════════
function SprTbl({spreads,title,color,mx,onDbl,pdp=1}){
  if(!spreads||!spreads.length){
    // Empty-state placeholder: keeps the table card present so two ccys of
    // the same kind always render the same set of sections.
    return(
      <div style={{background:"#131C2E",borderRadius:5,padding:6,marginBottom:6}}>
        <div style={{fontSize:9.5,fontWeight:800,color,marginBottom:3,letterSpacing:".05em"}}>{title}</div>
        <div style={{color:"#475569",fontSize:9,fontStyle:"italic",padding:"6px 0"}}>no data for this currency</div>
      </div>
    );
  }
  return(<div style={{background:"#131C2E",borderRadius:5,padding:6,marginBottom:6}}>
    <div style={{fontSize:9.5,fontWeight:800,color,marginBottom:3,letterSpacing:".05em"}}>{title}</div>
    <div style={{overflowX:"auto"}}><table style={{borderCollapse:"collapse",width:"100%",minWidth:1080,fontSize:9}}>
      <thead><tr><th style={{...tS(),textAlign:"left",minWidth:60,...STICKY_TH}}>Spread</th><th style={tS()}>Near Val</th><th style={tS()}>Near Fix</th><th style={tS()}>Far Val</th><th style={tS()}>Far Fix</th><th style={tS()}>Days</th><th style={tS("#4ADE80")}>Bid</th><th style={tS("#FBBF24")}>Mid</th><th style={tS("#F87171")}>Ask</th><th style={tS()}>D/D</th><th style={tS()}>Pts/D</th><th style={tS("#4ADE80")}>Iy Bid</th><th style={tS("#34D399")}>Iy Mid</th><th style={tS("#F87171")}>Iy Ask</th><th style={tS()}>Iy D/D</th><th style={tS("#A78BFA")} title="Roll-down in pips: static-curve P&L from rolling forward by the spread horizon (1M for spot-start, near-leg days for fwd-fwd)">Roll Pip</th><th style={tS("#A78BFA")} title="Roll-down IY (bps): change in implied yield from rolling forward (post-roll = SPx(F-horizon))">Roll IY</th><th style={tS("#FB923C")}>SOFR%</th><th style={tS("#C084FC")}>Basis</th></tr></thead>
      <tbody>{spreads.map((s,i)=>{const iso=d=>{if(!d)return null;const x=d instanceof Date?d:new Date(d);if(isNaN(x))return null;return x.toISOString().slice(0,10);};const ndIso=iso(s.nrVD),fdIso=iso(s.frVD);const rowBg=i%2===0?"#0F172A":"#131C2E";const isInterp=s.interp||s.dataSource==="interpolated";return(<tr key={i} style={{background:rowBg,cursor:s.unavailable?"default":"pointer",opacity:s.unavailable?.55:(isInterp?.78:1)}} onDoubleClick={()=>!s.unavailable&&onDbl&&onDbl(s.label,Math.abs(s.pM)||1,true,null,s.nrM,s.frM,ndIso,fdIso,s.fundingTenor||null)}>
        <td style={{...cS(isInterp?"#64748B":color,true),textAlign:"left",...stickyTd(rowBg)}} title={s.unavailable?s.unavailableReason:(isInterp?"interpolated — no direct RIC data":undefined)}>{s.label}{s.unavailable?" *":(isInterp?" \u2071":"")}</td>
        <td style={cS("#475569")}>{fD(s.nrVD)}</td><td style={cS("#475569")}>{fD(s.nrFxD)}</td><td style={cS("#475569")}>{fD(s.frVD)}</td><td style={cS("#475569")}>{fD(s.frFxD)}</td><td style={cS("#475569",false,true)}>{s.days}</td>
        <td style={cS("#4ADE80")}>{FP(s.pB,pdp)}</td><td style={cS("#FBBF24",true)}>{FP(s.pM,pdp)}</td><td style={cS("#F87171")}>{FP(s.pA,pdp)}</td>
        <td style={{...cS(CC(s.chg)),background:HB(s.chg,mx)}}>{FP(s.chg,pdp)}</td><td style={cS("#64748B",false,true)}>{F(s.ppd,2)}</td>
        <td style={cS("#4ADE80")}>{F(s.fIyB,2)}</td><td style={cS("#34D399",true)}>{F(s.fIy,2)}</td><td style={cS("#F87171")}>{F(s.fIyA,2)}</td>
        <td style={{...cS(CC(s.iyChg)),background:HB(s.iyChg,.1)}}>{FP(s.iyChg!=null?s.iyChg*100:null,2)}</td>
        <td style={cS(s.carry!=null&&s.carry>=0?"#A78BFA":"#F472B6")}>{s.carry!=null?FP(s.carry,pdp):"—"}</td>
        <td style={cS(s.carryY!=null&&s.carryY>=0?"#A78BFA":"#F472B6")}>{s.carryY!=null?FP(s.carryY*100,2):"—"}</td>
        <td style={cS("#FB923C")}>{F(s.fSof,2)}</td><td style={cS(s.bas!=null&&s.bas>=0?"#C084FC":"#F472B6",true)}>{s.bas!=null?FP(s.bas*100,2):"—"}</td>
      </tr>);})}</tbody></table></div></div>);
}

// ══════════════════════ TOOLS ══════════════════════
function ToolsPanel({ad,onDbl,ccy}){
  const[mode,setMode]=useState("month");
  const[nearM,setNearM]=useState(1);const[farM,setFarM]=useState(6);
  const[nearDt,setNearDt]=useState("");const[farDt,setFarDt]=useState("");
  const[ipaCustom,setIpaCustom]=useState(null);

  // When in date mode, try IPA first for custom date forward points
  useEffect(()=>{
    if(mode!=="date"||!nearDt||!farDt||!ad?.cfg?.pair)return;
    setIpaCustom(null);
    const pair=ad.cfg.pair;
    // Compute day-based tenors from spot date
    const spotDate=ad.SPOT_DATE;
    const nrDays=Math.round((new Date(nearDt)-spotDate)/(1000*60*60*24));
    const frDays=Math.round((new Date(farDt)-spotDate)/(1000*60*60*24));
    if(nrDays<=0||frDays<=0)return;
    Promise.all([
      getIpaForward(pair,`${nrDays}D`),
      getIpaForward(pair,`${frDays}D`),
    ]).then(([nrRes,frRes])=>{
      if(nrRes.data&&frRes.data){
        setIpaCustom({near:nrRes.data,far:frRes.data});
      }
    }).catch(()=>{});
  },[mode,nearDt,farDt,ad?.cfg?.pair,ad?.SPOT_DATE]);

  const custom=useMemo(()=>{
    if(mode==="date"&&nearDt&&farDt)return calcCustom(ad,0,0,new Date(nearDt),new Date(farDt),ipaCustom);
    // Handle special near/far values: funding tenors (negative), weekly (fractional <1), IMM (fractional >1)
    let effNear=nearM,effFar=farM;
    // Funding tenors: map to approximate month values for calcCustom
    if(nearM<0)effNear=0;  // ON/TN/SN ≈ near-spot
    if(farM<0)effFar=0;
    return calcCustom(ad,effNear,effFar,null,null,null);
  },[ad,mode,nearM,farM,nearDt,farDt,ipaCustom]);
  const[scMode,setScMode]=useState("pips");const[scIn,setScIn]=useState("");
  const[scTenorMode,setScTenorMode]=useState("month");
  const[scN,setScN]=useState(1);const[scF,setScF]=useState(3);
  const[scNDt,setScNDt]=useState("");const[scFDt,setScFDt]=useState("");
  const PF=ad.cfg?.pipFactor||1e3;
  useEffect(()=>{const mT=ad.maxT||24;
    setNearM(v=>Math.min(v,mT));setFarM(v=>Math.min(v,mT));
    setScN(v=>Math.min(v,mT));setScF(v=>{const c=Math.min(v,mT);return c<=Math.min(scN,mT)?mT:c;});
  },[ad.maxT]);
  const scRes=useMemo(()=>{const v=parseFloat(scIn);if(isNaN(v))return null;
    function resolveLeg(mKey,dtStr){
      if(scTenorMode==="date"&&dtStr){
        const dt=new Date(dtStr);const days=daysBtwn(ad.SPOT_DATE,dt);if(days<0)return null;
        const mApprox=days/30.44;const i=Math.floor(mApprox);
        const r0=ad.rows.find(x=>x.month===i);if(!r0)return null;
        const r1=ad.rows.find(x=>x.month===Math.ceil(mApprox))||r0;const t=mApprox-i;
        return{dT:r0.dT+(r1.dT-r0.dT)*t,iyM:r0.iyM+(r1.iyM-r0.iyM)*t,spM:r0.spM+(r1.spM-r0.spM)*t,sofT:r0.sofT+(r1.sofT-r0.sofT)*t,_lbl:fD(dt)};
      }
      // Handle funding tenors (ON/TN/SN) with negative sentinel values
      if(mKey<0){
        const fundingKey=mKey===-0.03?"ON":mKey===-0.02?"TN":"SN";
        const fd=ad.funding?.[fundingKey];
        const days={ON:1,TN:2,SN:3}[fundingKey]||1;
        const spM=fd?.T?.mid??0;
        const iyM=fd?.T?.mid!=null?0:null;
        const sofT=ad.rows.find(x=>x.month===1)?.sofT??null;
        return{dT:days,iyM:iyM,spM:spM,sofT:sofT,_lbl:fundingKey};
      }
      // Handle fractional months (weekly 0.25/0.5/0.75 or IMM)
      if(mKey>0&&mKey<1){
        const r=ad.rows.find(x=>Math.abs(x.month-mKey)<0.01);
        if(r)return{...r,_lbl:r.tenor||`${Math.round(mKey*4)}W`};
      }
      // IMM or non-integer months >1: find matching IMM row or interpolate
      if(mKey>0&&!Number.isInteger(mKey)){
        const opt=tenorOpts.find(o=>Math.abs(o.value-mKey)<0.001);
        if(opt&&opt.kind==="imm"&&opt.immData){
          const immRow=ad.immR?.find(r=>r.tenor===opt.label);
          if(immRow)return{...immRow,_lbl:opt.label};
        }
        // Interpolate from nearest rows
        const i=Math.floor(mKey);
        const r0=ad.rows.find(x=>x.month===i);
        const r1=ad.rows.find(x=>x.month===Math.ceil(mKey))||r0;
        if(r0){const t=mKey-i;return{dT:r0.dT+(r1.dT-r0.dT)*t,iyM:r0.iyM!=null&&r1.iyM!=null?r0.iyM+(r1.iyM-r0.iyM)*t:null,spM:r0.spM!=null&&r1.spM!=null?r0.spM+(r1.spM-r0.spM)*t:null,sofT:r0.sofT!=null&&r1.sofT!=null?r0.sofT+(r1.sofT-r0.sofT)*t:null,_lbl:opt?.label||`${mKey.toFixed(1)}M`};}
      }
      const r=ad.rows.find(x=>x.month===mKey);if(!r)return null;return{...r,_lbl:mKey===0?"Spot":mKey<=12?`${mKey}M`:mKey===24?"2Y":`${mKey}M`};
    }
    const nr=resolveLeg(scN,scNDt),fr=resolveLeg(scF,scFDt);
    if(!nr||!fr)return null;const ds=fr.dT-nr.dT;if(ds<=0)return null;
    if(scMode==="pips"){const newFarMid=ad.sMT+((nr.spM+v)/PF);const newFarIy=implYld(newFarMid,ad.sMT,fr.sofT,fr.dT);const newFwdIy=newFarIy!=null?fwdFwdIy(nr.iyM,nr.dT,newFarIy,fr.dT):null;return{label:`${nr._lbl}×${fr._lbl} @ ${v} pips`,impl:newFwdIy,pips:v,days:ds};}
    else{const nearFac=1+(nr.iyM/100)*nr.dT/360;const farFac=nearFac*(1+(v/100)*ds/360);const farIy=(farFac-1)*360/fr.dT*100;const farNDF=ad.sMT*(farIy/100*fr.dT/360+1)/(1+fr.sofT/100*fr.dT/360);const sprPips=(farNDF-ad.sMT)*PF-nr.spM;return{label:`${nr._lbl}×${fr._lbl} @ ${v}% impl`,impl:v,pips:sprPips,days:ds};}
  },[scIn,scMode,scN,scF,scNDt,scFDt,scTenorMode,ad,PF]);
  const maxT=ad.maxT||24;
  // Build enhanced tenor options: Spot, ON/TN/SN, 1W/2W/3W, then monthly with interleaved IMM dates
  const tenorOpts=useMemo(()=>{
    const opts=[{value:0,label:"Spot",kind:"spot"}];
    // Short tenors: ON=-0.03, TN=-0.02, SN=-0.01, 1W=0.25, 2W=0.5, 3W=0.75
    // Use small negative values for funding tenors to distinguish from Spot (0)
    opts.push({value:-0.03,label:"ON",kind:"funding",fundingKey:"ON"});
    opts.push({value:-0.02,label:"TN",kind:"funding",fundingKey:"TN"});
    opts.push({value:-0.01,label:"SN",kind:"funding",fundingKey:"SN"});
    opts.push({value:0.25,label:"1W",kind:"weekly"});
    opts.push({value:0.5,label:"2W",kind:"weekly"});
    opts.push({value:0.75,label:"3W",kind:"weekly"});
    // Monthly tenors interleaved with IMM dates
    const spotDate=ad.SPOT_DATE||computeSpotDate();
    const immDates=buildIMMDates(spotDate);
    for(let m=1;m<=maxT;m++){
      opts.push({value:m,label:m===12?"1Y":m===24?"2Y":`${m}M`,kind:"month"});
      // Insert any IMM dates that fall between this month and the next
      const mValDate=addMon(spotDate,m);
      const nextValDate=m<maxT?addMon(spotDate,m+1):null;
      if(nextValDate){
        for(const imm of immDates){
          if(imm.valDate>mValDate&&imm.valDate<=nextValDate){
            // Use a fractional month value based on days
            opts.push({value:imm.days/30.44,label:imm.label,kind:"imm",immData:imm});
          }
        }
      }
    }
    return opts;
  },[maxT,ad.SPOT_DATE]);
  const sel=(v,set)=><select value={v} onChange={e=>{const val=parseFloat(e.target.value);set(val);}} style={{background:"#1E293B",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"2px 4px",fontSize:9}}>{tenorOpts.map((o,i)=><option key={`${o.value}-${i}`} value={o.value}>{o.label}</option>)}</select>;
  return(<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
    <div style={{background:"#131C2E",borderRadius:5,padding:8}}>
      <div style={{fontSize:9.5,fontWeight:800,color:"#60A5FA",marginBottom:4,letterSpacing:".05em"}}>USER-DEFINED TENOR</div>
      <div style={{display:"flex",gap:4,marginBottom:6}}>
        <button onClick={()=>setMode("month")} style={{fontSize:7.5,padding:"1px 6px",borderRadius:3,border:"none",cursor:"pointer",background:mode==="month"?"#3B82F6":"#1E293B",color:mode==="month"?"#FFF":"#64748B"}}>By Month</button>
        <button onClick={()=>setMode("date")} style={{fontSize:7.5,padding:"1px 6px",borderRadius:3,border:"none",cursor:"pointer",background:mode==="date"?"#3B82F6":"#1E293B",color:mode==="date"?"#FFF":"#64748B"}}>By Date</button>
      </div>
      {mode==="month"?(<div style={{display:"flex",gap:4,alignItems:"center",marginBottom:6}}><span style={{fontSize:8,color:"#64748B"}}>Near:</span>{sel(nearM,setNearM)}<span style={{fontSize:8,color:"#64748B"}}>Far:</span>{sel(farM,setFarM)}</div>):(<div style={{display:"flex",gap:4,alignItems:"center",marginBottom:6,flexWrap:"wrap"}}><span style={{fontSize:8,color:"#64748B"}}>Near date:</span><input type="date" value={nearDt} onChange={e=>setNearDt(e.target.value)} style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"2px 4px",fontSize:9}}/><span style={{fontSize:8,color:"#64748B"}}>Far date:</span><input type="date" value={farDt} onChange={e=>setFarDt(e.target.value)} style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"2px 4px",fontSize:9}}/></div>)}
      {custom&&(()=>{const iso=d=>{if(!d)return null;const x=d instanceof Date?d:new Date(d);if(isNaN(x))return null;return x.toISOString().slice(0,10);};const ndIso=mode==="date"?nearDt:iso(custom.nrVD);const fdIso=mode==="date"?farDt:iso(custom.frVD);return(<div style={{background:"#0F172A",borderRadius:4,padding:6,fontSize:9,cursor:"pointer"}} onDoubleClick={()=>onDbl&&onDbl(custom.label,Math.abs(custom.pM)||1,true,null,null,null,ndIso,fdIso)}>
        <div style={{color:"#FBBF24",fontWeight:700,marginBottom:3}}>{custom.label} <span style={{color:"#475569",fontWeight:400,fontSize:7.5}}>(double-click for historical)</span></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:3}}>
          <div><span style={{color:"#64748B"}}>Bid: </span><span style={{color:"#4ADE80",fontFamily:"monospace"}}>{FP(custom.pB,1)}</span></div>
          <div><span style={{color:"#64748B"}}>Mid: </span><span style={{color:"#FBBF24",fontFamily:"monospace"}}>{FP(custom.pM,1)}</span></div>
          <div><span style={{color:"#64748B"}}>Ask: </span><span style={{color:"#F87171",fontFamily:"monospace"}}>{FP(custom.pA,1)}</span></div>
          <div><span style={{color:"#64748B"}}>Days: </span><span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{custom.days}</span></div>
          <div><span style={{color:"#64748B"}}>PPD: </span><span style={{color:"#22D3EE",fontFamily:"monospace"}}>{custom.ppd!=null?F(custom.ppd,2):"—"}</span></div>
          <div><span style={{color:"#64748B"}}>Fwd Impl: </span><span style={{color:"#10B981",fontFamily:"monospace"}}>{custom.fIy!=null?F(custom.fIy,2)+"%":"—"}</span></div>
          <div><span style={{color:"#64748B"}}>Near Val: </span><span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{fD(custom.nrVD)}</span></div>
          <div><span style={{color:"#64748B"}}>Near Fix: </span><span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{fD(custom.nrFxD)}</span></div>
          <div><span style={{color:"#64748B"}}>Far Val: </span><span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{fD(custom.frVD)}</span></div>
          <div><span style={{color:"#64748B"}}>Far Fix: </span><span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{fD(custom.frFxD)}</span></div>
        </div></div>);})()}
    </div>
    <div style={{background:"#131C2E",borderRadius:5,padding:8}}>
      <div style={{fontSize:9.5,fontWeight:800,color:"#F59E0B",marginBottom:4,letterSpacing:".05em"}}>SCENARIO CALCULATOR</div>
      <div style={{display:"flex",gap:4,marginBottom:6}}>
        <button onClick={()=>setScTenorMode("month")} style={{fontSize:7.5,padding:"1px 6px",borderRadius:3,border:"none",cursor:"pointer",background:scTenorMode==="month"?"#3B82F6":"#1E293B",color:scTenorMode==="month"?"#FFF":"#64748B"}}>By Month</button>
        <button onClick={()=>setScTenorMode("date")} style={{fontSize:7.5,padding:"1px 6px",borderRadius:3,border:"none",cursor:"pointer",background:scTenorMode==="date"?"#3B82F6":"#1E293B",color:scTenorMode==="date"?"#FFF":"#64748B"}}>By Date</button>
        <button onClick={()=>setScMode("pips")} style={{fontSize:7.5,padding:"1px 6px",borderRadius:3,border:"none",cursor:"pointer",background:scMode==="pips"?"#8B5CF6":"#1E293B",color:scMode==="pips"?"#FFF":"#64748B"}}>Pips→Impl</button>
        <button onClick={()=>setScMode("impl")} style={{fontSize:7.5,padding:"1px 6px",borderRadius:3,border:"none",cursor:"pointer",background:scMode==="impl"?"#8B5CF6":"#1E293B",color:scMode==="impl"?"#FFF":"#64748B"}}>Impl→Pips</button>
      </div>
      {scTenorMode==="month"?(<div style={{display:"flex",gap:4,alignItems:"center",marginBottom:4,flexWrap:"wrap"}}><span style={{fontSize:8,color:"#64748B"}}>Near:</span>{sel(scN,setScN)}<span style={{fontSize:8,color:"#64748B"}}>Far:</span>{sel(scF,setScF)}</div>):(<div style={{display:"flex",gap:4,alignItems:"center",marginBottom:4,flexWrap:"wrap"}}><span style={{fontSize:8,color:"#64748B"}}>Near date:</span><input type="date" value={scNDt} onChange={e=>setScNDt(e.target.value)} style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"2px 4px",fontSize:9}}/><span style={{fontSize:8,color:"#64748B"}}>Far date:</span><input type="date" value={scFDt} onChange={e=>setScFDt(e.target.value)} style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"2px 4px",fontSize:9}}/></div>)}
      <div style={{display:"flex",gap:4,alignItems:"center",marginBottom:4}}><span style={{fontSize:8,color:"#64748B"}}>{scMode==="pips"?"Spread pips:":"Target impl%:"}</span><input value={scIn} onChange={e=>setScIn(e.target.value)} type="number" step="0.1" style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"2px 6px",fontSize:9,width:80,fontFamily:"monospace"}} placeholder={scMode==="pips"?"-10":"2.50"}/></div>
      {scRes&&(<div style={{background:"#0F172A",borderRadius:4,padding:6,fontSize:9}}>
        <div style={{color:"#FBBF24",fontWeight:700,marginBottom:3}}>{scRes.label}</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:3}}>
          <div><span style={{color:"#64748B"}}>Pips: </span><span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{FP(scRes.pips,1)}</span></div>
          <div><span style={{color:"#64748B"}}>Fwd Impl: </span><span style={{color:"#10B981",fontFamily:"monospace"}}>{scRes.impl!=null?F(scRes.impl,2)+"%":"—"}</span></div>
          <div><span style={{color:"#64748B"}}>Days: </span><span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{scRes.days}</span></div>
        </div></div>)}
    </div>
  </div>);
}

// ══════════════════════ BROKER MONITOR ══════════════════════
function BrokerMon({ad,liveOn=false}){
  const{rows,ccy,cfg}=ad;const maxT=ad.maxT||24;
  const pdp=cfg.pipDp??1;
  const brokersAvail=cfg.brokers||[];
  const brokersMeta=cfg.brokersMeta||{};
  // Broker Monitor: diagnostic view — always show ALL brokers from snapshot.
  // Do NOT filter by the user's source selection/mode.
  const selBrokers=brokersAvail;
  const[avgBrokers,setAvgBrokers]=useState(false);

  // Adapt broker tenor list based on kind
  const DELIVERABLE_BROKER_TENORS=[
    {label:"SPx1M",type:"outright",m:1},
    {label:"SPx2M",type:"spread",near:0,far:2},{label:"SPx3M",type:"spread",near:0,far:3},
    {label:"SPx6M",type:"spread",near:0,far:6},{label:"SPx9M",type:"spread",near:0,far:9},
    {label:"SPx12M",type:"spread",near:0,far:12},{label:"SPx18M",type:"spread",near:0,far:18},
    {label:"SPx2Y",type:"spread",near:0,far:24},
  ];
  const brokerTenors=cfg.kind==="NDF"?NDF_BROKER_TENORS:DELIVERABLE_BROKER_TENORS;
  const allT=brokerTenors.filter(t=>{if(t.type==="outright")return true;return t.far<=maxT;});
  const brokerList=selBrokers;

  function getSpreadVal(t){
    if(t.type==="outright"){const r=rows.find(x=>x.month===t.m);return r?{bid:r.spB,mid:r.spM,ask:r.spA}:null;}
    const nr=rows.find(x=>x.month===t.near),fr=rows.find(x=>x.month===t.far);if(!nr||!fr)return null;
    return{bid:fr.spB!=null&&nr.spA!=null?fr.spB-nr.spA:null,mid:fr.spM!=null&&nr.spM!=null?fr.spM-nr.spM:null,ask:fr.spA!=null&&nr.spB!=null?fr.spA-nr.spB:null};
  }

  // Per-broker per-tenor display-pts from the new sources metadata on each row.
  function brkAt(month,contrib){
    const r=rows.find(x=>x.month===month);
    return r?.sourcesMeta?.bySource?.[contrib]||null;
  }

  function getBrokerVal(t,contrib){
    if(t.type==="outright"){
      const v=brkAt(t.m,contrib);
      if(!v)return null;
      return{bid:v.b,mid:v.m,ask:v.a,freshness:v.freshness,timact:v.timact};
    }
    if(t.near===0){
      const v=brkAt(t.far,contrib);
      if(!v)return null;
      return{bid:v.b,mid:v.m,ask:v.a,freshness:v.freshness,timact:v.timact};
    }
    const n=brkAt(t.near,contrib),f=brkAt(t.far,contrib);
    if(!n||!f)return null;
    return{
      bid:f.b!=null&&n.a!=null?f.b-n.a:null,
      mid:f.m!=null&&n.m!=null?f.m-n.m:null,
      ask:f.a!=null&&n.b!=null?f.a-n.b:null,
      freshness:(FRESH_OPACITY[f.freshness]||1)<(FRESH_OPACITY[n.freshness]||1)?f.freshness:n.freshness,
      timact:f.timact||n.timact,
    };
  }

  return(<div>
    <div style={{fontSize:10,fontWeight:800,color:"#60A5FA",marginBottom:6,letterSpacing:".05em"}}>REUTERS DEFAULT (COMPOSITE) RUN — {cfg.pair} ({ccy})</div>
    <div style={{background:"#131C2E",borderRadius:5,padding:6,marginBottom:6}}>
      <table style={{borderCollapse:"collapse",width:"100%",fontSize:9,marginBottom:4}}><thead><tr>
        <th style={{...tS(),textAlign:"left",...STICKY_TH}}>Tenor</th><th style={tS("#4ADE80")}>Bid</th><th style={tS("#FBBF24")}>Mid</th><th style={tS("#F87171")}>Ask</th><th style={tS()}>Width</th>
      </tr></thead><tbody>
        {allT.map((t,idx)=>{const v=getSpreadVal(t);const rowBg=idx%2===0?"#0F172A":"#131C2E";return(<tr key={idx} style={{background:rowBg}}>
          <td style={{...cS("#CBD5E1",true),textAlign:"left",...stickyTd(rowBg)}}>{t.label}</td>
          <td style={cS(v?"#4ADE80":"#475569")}>{v?FP(v.bid,pdp):"—"}</td>
          <td style={cS(v?"#FBBF24":"#475569",true)}>{v?FP(v.mid,pdp):"—"}</td>
          <td style={cS(v?"#F87171":"#475569")}>{v?FP(v.ask,pdp):"—"}</td>
          <td style={cS("#94A3B8")}>{v&&v.ask!=null&&v.bid!=null?FP(v.ask-v.bid,pdp)+"p":"—"}</td>
        </tr>);})}
      </tbody></table>
    </div>

    <div style={{fontSize:10,fontWeight:800,color:"#60A5FA",marginBottom:6,letterSpacing:".05em"}}>PER-BROKER CONTRIBUTIONS — {cfg.pair} ({ccy}){liveOn&&<span style={{color:"#4ADE80",fontSize:8,marginLeft:8}}>● LIVE</span>}</div>
    <div style={{background:"#131C2E",borderRadius:5,padding:6,marginBottom:6}}>
      <div style={{marginBottom:6,display:"flex",gap:4,alignItems:"center",flexWrap:"wrap"}}>
        <span style={{fontSize:8,color:"#64748B"}}>All brokers shown (diagnostic view)</span>
        <div style={{borderLeft:"1px solid #334155",paddingLeft:8}}>
          <label style={{fontSize:8,color:"#E2E8F0",display:"flex",alignItems:"center",gap:2,cursor:"pointer"}}><input type="checkbox" checked={avgBrokers} onChange={e=>setAvgBrokers(e.target.checked)} style={{accentColor:"#3B82F6",width:8,height:8}}/>Average</label>
        </div>
      </div>
      <table style={{borderCollapse:"collapse",width:"100%",fontSize:9}}><thead><tr>
        <th style={{...tS(),textAlign:"left"}}>Tenor</th>
        {selBrokers.map(b=><React.Fragment key={b}><th style={tS("#4ADE80")}>{b} B</th><th style={tS("#FBBF24")}>{b} M</th><th style={tS("#F87171")}>{b} A</th></React.Fragment>)}
        {avgBrokers&&<><th style={tS("#10B981")}>Avg B</th><th style={tS("#34D399")}>Avg M</th><th style={tS("#A78BFA")}>Avg A</th></>}
      </tr></thead><tbody>
        {allT.map((t,idx)=>{
          // Gather broker values for averaging
          const brkVals=selBrokers.map(b=>({b,v:getBrokerVal(t,b)}));
          const withData=brkVals.filter(x=>x.v&&x.v.mid!=null);
          const avgMid=withData.length>0?withData.reduce((s,x)=>s+x.v.mid,0)/withData.length:null;
          const avgBid=withData.length>0?withData.reduce((s,x)=>s+(x.v.bid??x.v.mid),0)/withData.length:null;
          const avgAsk=withData.length>0?withData.reduce((s,x)=>s+(x.v.ask??x.v.mid),0)/withData.length:null;
          const rowBg2=idx%2===0?"#0F172A":"#131C2E";
          return(<tr key={idx} style={{background:rowBg2}}>
          <td style={{...cS("#CBD5E1",true),textAlign:"left",...stickyTd(rowBg2)}}>{t.label}</td>
          {selBrokers.map(b=>{const v=getBrokerVal(t,b);const hasV=v&&(v.bid!=null||v.mid!=null||v.ask!=null);const op=hasV?(FRESH_OPACITY[v.freshness]??1):1;const stale=hasV&&v.freshness&&v.freshness!=='fresh';
            const badge=stale?<span style={{fontSize:6,color:"#F59E0B",marginLeft:2}}>{v.freshness==='very_stale'?'⏸':''}{v.timact||''}</span>:null;
            return<React.Fragment key={b}>
              <td style={{...cS(hasV?"#4ADE80":"#334155"),opacity:op}} title={hasV?`${v.freshness||''} ${v.timact||''}`:"no data in selected sources"}>{hasV?FP(v.bid,pdp):(liveOn?"—":"—")}</td>
              <td style={{...cS(hasV?"#FBBF24":"#334155",true),opacity:op}}>{hasV?<>{FP(v.mid,pdp)}{badge}</>:(liveOn?"—":"—")}</td>
              <td style={{...cS(hasV?"#F87171":"#334155"),opacity:op}}>{hasV?FP(v.ask,pdp):(liveOn?"—":"—")}</td>
            </React.Fragment>;})}
          {avgBrokers&&<><td style={cS("#10B981")}>{avgBid!=null?FP(avgBid,pdp):"—"}</td><td style={cS("#34D399")} title={`${withData.length}/${brkVals.length} fresh`}>{avgMid!=null?<>{FP(avgMid,pdp)}<div style={{fontSize:6,color:"#64748B"}}>{withData.length}/{brkVals.length}</div></>:"—"}</td><td style={cS("#A78BFA")}>{avgAsk!=null?FP(avgAsk,pdp):"—"}</td></>}
        </tr>);})}
      </tbody></table>
    </div>

    <div style={{fontSize:8,color:liveOn?"#4ADE80":"#F87171",background:liveOn?"#064E3B":"#1F1317",border:`1px solid ${liveOn?"#065F46":"#7F1D1D"}`,borderRadius:4,padding:6,marginTop:4}}>
      {liveOn
        ?<><b>LIVE streaming active.</b> Broker RICs (=ICAP, =BGCP, =TRDS, =TPTS, =PYNY, =GMGM) updating via WebSocket. Check browser console for tick logs.</>
        :<><b>Per-broker contributions stream when LIVE mode is ON.</b> Turn on LIVE mode to see real-time broker prices.</>}
    </div>
  </div>);
}

// ══════════════════════ MAIN DASHBOARD ══════════════════════
export default function Dashboard(){
  const[meta,setMeta]=useState(null);
  const[snap,setSnap]=useState(null);
  const[liveQuotes,setLiveQuotes]=useState({});
  const[liveOn,setLiveOn]=useState(false);
  const[showI,setShowI]=useState(true);const[tab,setTab]=useState("main");
  const[hm,setHm]=useState(null);
  const[ccy,setCcy]=useState("TWD");
  // Per-ccy source selection + mode. Default seeded on snapshot load.
  const[sourcesByCcy,setSourcesByCcy]=useState({});
  const[modeByCcy,setModeByCcy]=useState({});
  const manualSelection=sourcesByCcy[ccy];
  const mode=modeByCcy[ccy]||"Auto";
  // Effective selection fed to aggregateSources:
  //   Auto → composite (if present) + all brokers → aggregateSources skips sources without data per tenor.
  //   Manual → user-picked subset.
  const selection=(!manualSelection||!snap)?null:(mode==="Auto"
    ?(snap.deriveFromOutrights?(snap.brokers||[]):["composite",...(snap.brokers||[])])
    :manualSelection);
  const[err,setErr]=useState(null);
  const[lastReload,setLastReload]=useState(null);
  const[reloadMsg,setReloadMsg]=useState(null);
  const[liveTick,setLiveTick]=useState(0);
  const channelsRef=useRef([]);
  // Dedupe T-1 backfill requests — key = `${ccy}|${sortedRics}`.
  const t1RequestedRef=useRef(new Set());

  // Fire T-1 backfill in background and merge into snapshot state.
  const backfillT1=useCallback((rics)=>{
    if(!rics||!rics.length)return;
    const uniq=Array.from(new Set(rics.filter(Boolean)));
    if(!uniq.length)return;
    const key=`${ccy}|${uniq.slice().sort().join(",")}`;
    if(t1RequestedRef.current.has(key))return;
    t1RequestedRef.current.add(key);
    t1Backfill(uniq).then(map=>{
      if(!map)return;
      setSnap(prev=>prev?mergeT1(prev,map):prev);
    }).catch(()=>{
      // silent — IY D/D simply stays blank
      t1RequestedRef.current.delete(key);
    });
  },[ccy]);

  // Reset dedupe cache when ccy changes.
  useEffect(()=>{t1RequestedRef.current=new Set();},[ccy]);

  useEffect(()=>{getCurrencies().then(setMeta).catch(e=>setErr(e.message));},[]);
  useEffect(()=>{
    setErr(null);setSnap(null);setLiveQuotes({});
    getSnapshot(ccy).then(s=>{
      setSnap(s);setLastReload(new Date());
      setSourcesByCcy(prev=>{
        if(prev[ccy])return prev; // persist across ccy switches
        const init=s.deriveFromOutrights?((s.brokers||[]).slice(0,1)):["composite"];
        return{...prev,[ccy]:init};
      });
      setModeByCcy(prev=>{
        if(prev[ccy])return prev;
        return{...prev,[ccy]:s.deriveFromOutrights?"Manual":"Auto"};
      });
    }).catch(e=>setErr(e.message));
  },[ccy]);

  // Live streaming
  useEffect(()=>{
    if(!liveOn||!snap)return;
    liveStart(ccy).then(r=>console.log("[LIVE] start OK:",r)).catch(e=>setErr(`liveStart: ${e.message}`));
    const onTick=msg=>{
      if(!msg||!msg.ric)return;
      console.debug("[WS]",msg.ric,"bid:",msg.bid,"ask:",msg.ask,"mid:",msg.mid);
      setLiveQuotes(p=>({...p,[msg.ric]:{...p[msg.ric],...msg}}));
    };
    channelsRef.current=[
      openChannel("spot",onTick,()=>console.log("[WS] spot OPEN"),()=>console.log("[WS] spot CLOSED")),
      openChannel("forwards",onTick,()=>console.log("[WS] forwards OPEN"),()=>console.log("[WS] forwards CLOSED")),
      openChannel("brokers",onTick,()=>console.log("[WS] brokers OPEN"),()=>console.log("[WS] brokers CLOSED")),
    ];
    return()=>{channelsRef.current.forEach(c=>c.close());channelsRef.current=[];liveStop(ccy).catch(()=>{});};
  },[liveOn,ccy,snap]);

  // Live mode — force re-render tick
  useEffect(()=>{
    if(!liveOn)return;
    const iv=setInterval(()=>{
      setLastReload(new Date());
      setLiveTick(t=>t+1);
    },1000);
    return()=>clearInterval(iv);
  },[liveOn]);

  // Task 2: on Auto mode selection, warm T-1 for ALL broker sources in snapshot
  // (once per ccy visit; backend caches so revisits are free).
  useEffect(()=>{
    if(!snap||mode!=="Auto")return;
    const rics=[];
    const seen=new Set();
    for(const m of Object.keys(snap.tenors||{})){
      const t=snap.tenors[m];
      for(const [name,src] of Object.entries(t.sources||{})){
        if(name==="composite")continue;
        if(src&&src.ric&&!seen.has(src.ric)){seen.add(src.ric);rics.push(src.ric);}
      }
    }
    for(const k of Object.keys(snap.funding||{})){
      const b=snap.funding[k];
      for(const [name,src] of Object.entries(b.sources||{})){
        if(name==="composite")continue;
        if(src&&src.ric&&!seen.has(src.ric)){seen.add(src.ric);rics.push(src.ric);}
      }
    }
    if(rics.length)backfillT1(rics);
  },[ccy,mode,snap,backfillT1]);

  const ad=useMemo(()=>buildAllData(snap,liveQuotes,selection),[snap,liveQuotes,liveTick,selection]);
  const refreshSnap=useCallback(()=>{
    getSnapshot(ccy).then(s=>{
      setSnap(s);
      setLastReload(new Date());
      setReloadMsg("Snap refreshed successfully");
      setTimeout(()=>setReloadMsg(null),3000);
    }).catch(e=>setErr(e.message));
  },[ccy]);

  if(err)return <div style={{padding:20,color:"#F87171"}}>Backend error: {err}</div>;
  if(!meta||!snap||!ad||!selection)return <div style={{padding:20,color:"#64748B"}}>Loading…</div>;

  const{rows,immR,anchors,qFF,spSpr,immSpr,cfg,ff1M,ff3M,ibAnchor,spreadPacks:packs}=ad;
  const pk=packs||{};
  // Nested packs: fullCurve + spreadsRolls
  const pkFull=pk.fullCurve||{spotStart:pk.spotStart||[],m1Chain:pk.m1Chain||[],m3Chain:pk.m3Chain||[]};
  const pkSR=pk.spreadsRolls||{interbankAnchors:pk.interbankAnchors||[],imm:[]};
  const pkSpotStart=pkFull.spotStart||[];
  const pkM1=pkFull.m1Chain||[];
  const pkM3=pkFull.m3Chain||[];
  const pkInterbank=pkSR.interbankAnchors||[];
  // Main anchor table: Spot + anchorTenorsM rows (backbone curve).
  // Issue 6: For deliverables, extend to include ALL extended months (4M, 5M, 7M, 8M, etc.)
  const anchorMs = new Set([0, ...(snap.anchorTenorsM || snap.tenorsM || [1,2,3,6,9,12,18,24])]);
  // Issue 5: extend outright curve to include ALL extended tenors (4M, 5M, 7M, etc.) for both NDFs and deliverables.
  // Also include weekly tenors (0.25=1W, etc.) when they exist in the rows.
  const extendedMs = new Set([...anchorMs, ...(snap.extendedTenorsM || [])]);
  for (const wt of (snap.weeklyTenors || [])) extendedMs.add(wt);
  const filt=(showI?rows:rows.filter(r=>!r.interp||r.interpolated)).filter(r => extendedMs.has(r.month));
  const mr=rows.filter(r=>r.month>0);
  const mPC=Math.max(...mr.map(r=>Math.abs(r.pipChg||0)),1);
  const mIC=Math.max(...mr.map(r=>Math.abs(r.iyChg||0)),.01);
  const mBC=Math.max(...mr.map(r=>Math.abs(r.basChg||0)),.01);
  const mFC=Math.max(...mr.filter(r=>r.month>1).map(r=>Math.abs(r.ffChg||0)),1);
  const mCP=Math.max(...mr.map(r=>Math.abs(r.carryP||0)),1);
  const mCY=Math.max(...mr.map(r=>Math.abs(r.carryY||0)),.01);
  const mSC=Math.max(...[...anchors,...qFF,...spSpr,...immSpr].map(s=>Math.abs(s.chg||0)),1);
  const dblR=(t,v,isSP=false,month=null,nrM=null,frM=null,nrDate=null,frDate=null,fundingTenor=null)=>setHm({tenor:t,value:v,isSP,month,nrM,frM,nrDate,frDate,fundingTenor});
  const dp=cfg.dp;
  const pdp=cfg.pipDp??1; // pip decimal places from config

  const chartRows=filt.filter(r=>r.month>0&&!r.isWeekly);
  const tenors=chartRows.map(r=>r.tenor);
  const outPts=chartRows.map(r=>r.spM);
  const ffPts=chartRows.map(r=>r.ffM);
  const iyVals=chartRows.map(r=>r.iyM);
  const ffIyVals=chartRows.map(r=>r.ffIyM);
  const sofrVals=chartRows.map(r=>r.sofT);
  const basVals=chartRows.map(r=>r.basisT!=null?r.basisT*100:null);

  const tabs=[{id:"main",label:"Full Curve"},{id:"spreads",label:"Spreads & Rolls"},{id:"tools",label:"Tools"},{id:"broker",label:"Broker Monitor"}];

  return(
    <div style={{background:"#0F172A",color:"#E2E8F0",minHeight:"100vh",fontFamily:"'Inter',system-ui,sans-serif",padding:8}}>
      {hm&&<HistModal tenor={hm.tenor} val={hm.value} isSwapPts={hm.isSP} dpOverride={dp} onClose={()=>setHm(null)} ccy={ccy} monthHint={hm.month} nrM={hm.nrM} frM={hm.frM} nrDate={hm.nrDate} frDate={hm.frDate} brokersMeta={snap.brokersMeta} snap={snap} fundingTenor={hm.fundingTenor} ad={ad} selection={selection} liveMid={hm.value}/>}
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6,paddingBottom:4,borderBottom:"1px solid #1E293B",flexWrap:"wrap",gap:4}}>
        <div><h1 style={{fontSize:14,fontWeight:800,margin:0,color:"#F8FAFC"}}>{cfg.pair} {cfg.kind==="NDF"?"NDF":"FWD"} Dashboard</h1>
          <span style={{fontSize:8.5,color:"#475569"}}>Workspace API &middot; {liveOn?<span style={{color:"#4ADE80"}}>LIVE</span>:"Snapshot"}</span></div>
        <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
          <div style={{display:"flex",gap:3,alignItems:"center",background:"#1E293B",padding:"2px 6px",borderRadius:4}}>
            <span style={{fontSize:7.5,color:"#64748B",fontWeight:700}}>CCY:</span>
            <select value={ccy} onChange={e=>setCcy(e.target.value)} style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"1px 4px",fontSize:9,fontWeight:700}}>
              {meta.ndfs&&<optgroup label="NDFs">{meta.ndfs.map(c=><option key={c} value={c}>{meta.meta[c].pair}</option>)}</optgroup>}
              {meta.deliverables&&<optgroup label="Deliverables">{meta.deliverables.map(c=><option key={c} value={c}>{meta.meta[c].pair}</option>)}</optgroup>}
            </select>
          </div>
          <button onClick={refreshSnap} title="Refresh snapshot" style={{fontSize:8,padding:"3px 8px",borderRadius:4,border:"none",cursor:"pointer",background:"#1E293B",color:"#E2E8F0"}}>↻ Snap</button>
          <button onClick={()=>setLiveOn(v=>!v)} title="Toggle live streaming" style={{fontSize:8,padding:"3px 8px",borderRadius:4,border:"none",cursor:"pointer",background:liveOn?"#059669":"#1E293B",color:"#E2E8F0",fontWeight:700}}>● {liveOn?"LIVE":"OFF"}</button>
          {lastReload&&(
            <div style={{fontSize:7.5,color:"#64748B",fontFamily:"monospace"}}>
              Last: {lastReload.toLocaleTimeString()}
            </div>
          )}
          {reloadMsg&&(
            <div style={{fontSize:8,color:"#4ADE80",background:"#064E3B",padding:"2px 6px",borderRadius:3}}>
              {reloadMsg}
            </div>
          )}
          <label style={{fontSize:7.5,color:"#94A3B8",display:"flex",alignItems:"center",gap:2,cursor:"pointer"}}><input type="checkbox" checked={showI} onChange={()=>setShowI(!showI)} style={{accentColor:"#3B82F6",width:9,height:9}}/>Interp</label>
          <div style={{display:"flex",gap:2,alignItems:"center",background:"#1E293B",padding:"2px 6px",borderRadius:4,flexWrap:"wrap"}}>
            <span style={{fontSize:7,color:"#64748B",fontWeight:700}}>MODE:</span>
            {["Auto","Manual"].map(mm=>(<button key={mm} onClick={()=>setModeByCcy(p=>({...p,[ccy]:mm}))} style={{fontSize:7,padding:"1px 6px",borderRadius:2,border:"none",cursor:"pointer",fontWeight:700,background:mode===mm?"#3B82F6":"#0F172A",color:mode===mm?"#FFF":"#64748B"}}>{mm}</button>))}
            {mode==="Manual"&&(<>
              <span style={{fontSize:7,color:"#334155",padding:"0 2px"}}>|</span>
              <span style={{fontSize:7,color:"#64748B",fontWeight:700}}>SRC:</span>
              {(()=>{
                const opts=[];
                if(!snap.deriveFromOutrights)opts.push({code:"composite",label:"Refinitiv"});
                for(const code of (snap.brokers||[]))opts.push({code,label:snap.brokersMeta?.[code]?.label||code});
                return opts.map(({code,label})=>{const on=(manualSelection||[]).includes(code);return(<button key={code} onClick={()=>{
                  if(on&&(manualSelection||[]).length===1)return;
                  const turningOn=!on;
                  setSourcesByCcy(prev=>({...prev,[ccy]:on?(prev[ccy]||[]).filter(x=>x!==code):[...(prev[ccy]||[]),code]}));
                  // Task 1: when a broker source is toggled ON, backfill T-1 for its RICs across all tenors.
                  if(turningOn&&code!=="composite"&&snap){
                    const rics=[];
                    for(const m of Object.keys(snap.tenors||{})){
                      const src=snap.tenors[m]?.sources?.[code];
                      if(src&&src.ric)rics.push(src.ric);
                    }
                    for(const k of Object.keys(snap.funding||{})){
                      const src=snap.funding[k]?.sources?.[code];
                      if(src&&src.ric)rics.push(src.ric);
                    }
                    if(rics.length)backfillT1(rics);
                  }
                }} title={label} style={{fontSize:7,padding:"1px 4px",borderRadius:2,border:(()=>{const q=sourceQuality(snap,code);return q==="good"?"2px solid #22C55E":q==="bad"?"2px solid #EF4444":"1px solid #334155";})(),cursor:"pointer",fontWeight:600,background:on?"#3B82F6":"#0F172A",color:on?"#FFF":"#64748B"}}>{label}</button>);});
              })()}
            </>)}
            {mode==="Auto"&&<span style={{fontSize:7,color:"#475569",fontStyle:"italic"}}>avg of all sources w/ data per tenor</span>}
          </div>
          <div style={{background:"#1E293B",padding:"2px 6px",borderRadius:4,fontSize:9,fontFamily:"monospace"}}>
            <span style={{color:"#64748B"}}>Spot </span><span style={{color:"#4ADE80"}}>{F(rows[0].bT,dp)}</span><span style={{color:"#334155"}}>/</span><span style={{color:"#F87171"}}>{F(rows[0].aT,dp)}</span><span style={{color:"#334155"}}> | </span><span style={{color:"#FBBF24",fontWeight:700}}>{F(rows[0].mT,dp)}</span>
          </div>
          {/* 1M live quote — NDF-only (deliverables don't anchor on a 1M
              tomfix-style outright). Reverted from the brief parity attempt. */}
          {cfg.kind==="NDF"&&rows.find(r=>r.month===1)&&(
            <div style={{background:"#1E293B",padding:"2px 6px",borderRadius:4,fontSize:9,fontFamily:"monospace"}}>
              <span style={{color:"#64748B"}}>1M </span>
              <span style={{color:"#4ADE80"}}>{F(rows.find(r=>r.month===1)?.bT,dp)}</span>
              <span style={{color:"#334155"}}>/</span>
              <span style={{color:"#F87171"}}>{F(rows.find(r=>r.month===1)?.aT,dp)}</span>
              <span style={{color:"#334155"}}> | </span>
              <span style={{color:"#FBBF24",fontWeight:700}}>{F(rows.find(r=>r.month===1)?.mT,dp)}</span>
              {!snap.deriveFromOutrights&&snap.ndf1mOutright?.sourceLabel&&<span style={{color:"#475569",fontSize:7,marginLeft:3}}>({snap.ndf1mOutright.sourceLabel})</span>}
            </div>
          )}
        </div>
      </div>
      {/* Tabs */}
      <div style={{display:"flex",gap:2,marginBottom:6,background:"#1E293B",padding:2,borderRadius:4,width:"fit-content"}}>
        {tabs.map(t=>(<button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"2px 10px",borderRadius:3,fontSize:8.5,fontWeight:600,border:"none",cursor:"pointer",background:tab===t.id?"#3B82F6":"transparent",color:tab===t.id?"#FFF":"#94A3B8"}}>{t.label}</button>))}
      </div>
      <div style={{fontSize:6.5,color:"#475569",marginBottom:4,textAlign:"right"}}>Double-click any row for historical (swap points) &middot; Plotly: scroll zoom, drag pan, dbl-click reset</div>

      {/* MAIN TAB */}
      {tab==="main"&&(<>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:6}}>
          <PChart traces={[{x:tenors,y:outPts,type:"bar",name:"Outright SwPts",marker:{color:outPts.map(v=>v!=null&&v>=0?"#F59E0B":"#F472B6")}},{x:tenors,y:iyVals,type:"scatter",mode:"lines+markers",name:"Impl%",line:{color:"#10B981",width:1.5},marker:{size:3},yaxis:"y2"}]} layout={{title:{text:`${cfg.pair} Outright Swap Points (pips)`,font:{size:10}},yaxis:{title:"Pips"},yaxis2:{title:"%",overlaying:"y",side:"right",gridcolor:"transparent"}}} height={175} revisionKey={`main-swpts-${ccy}`}/>
          <PChart traces={[{x:tenors,y:ffPts,type:"bar",name:"1M Fwd-Fwd",marker:{color:ffPts.map(v=>v!=null&&v>=0?"#3B82F6":"#F472B6")}},{x:tenors,y:ffIyVals,type:"scatter",mode:"lines+markers",name:"FF Impl%",line:{color:"#10B981",width:1.5},marker:{size:3},yaxis:"y2"}]} layout={{title:{text:`${cfg.pair} 1M Forward-Forward (pips)`,font:{size:10}},yaxis:{title:"Pips"},yaxis2:{title:"%",overlaying:"y",side:"right",gridcolor:"transparent"}}} height={175} revisionKey={`main-ff-${ccy}`}/>
          <PChart traces={[{x:tenors,y:iyVals,type:"scatter",mode:"lines+markers",name:`${cfg.pair.slice(3)} Impl%`,line:{color:"#10B981"},marker:{size:3}},{x:tenors,y:sofrVals,type:"scatter",mode:"lines+markers",name:"SOFR%",line:{color:"#FB923C"},marker:{size:3}}]} layout={{title:{text:`${cfg.pair} Implied Yield vs SOFR (%)`,font:{size:10}},yaxis:{title:"%"}}} height={175} revisionKey={`main-iy-${ccy}`}/>
          <PChart traces={[{x:tenors,y:basVals,type:"bar",name:"Basis bp",marker:{color:basVals.map(v=>v!=null&&v>=0?"#8B5CF6":"#F472B6")}},{x:tenors,y:iyVals,type:"scatter",mode:"lines+markers",name:"Impl%",line:{color:"#10B981",width:1.5},marker:{size:3},yaxis:"y2"}]} layout={{title:{text:`${cfg.pair} Basis (bp)`,font:{size:10}},yaxis:{title:"bp"},yaxis2:{title:"%",overlaying:"y",side:"right",gridcolor:"transparent"}}} height={175} revisionKey={`main-basis-${ccy}`}/>
        </div>

        <div style={{fontSize:8.5,fontWeight:700,color:"#F8FAFC",marginBottom:2}}>OUTRIGHT {cfg.kind==="NDF"?"NDF":"FWD"} CURVE</div>
        <div style={{overflowX:"auto",overflowY:"auto",maxHeight:"34vh",borderRadius:5,border:"1px solid #1E293B",marginBottom:6}}>
          <table style={{borderCollapse:"collapse",width:"100%",minWidth:1700}}>
            <thead><tr>
              <td colSpan={4} style={sS("#64748B")}>TENOR</td><td colSpan={3} style={sS("#60A5FA")}>{cfg.kind} OUTRIGHT</td>
              <td colSpan={4} style={sS("#FBBF24")}>SWAP POINTS</td><td colSpan={4} style={sS("#34D399")}>IMPLIED YIELD*</td>
              <td colSpan={2} style={sS("#FB923C")}>SOFR</td><td colSpan={2} style={sS("#C084FC")}>BASIS</td>
              <td colSpan={2} style={sS("#A78BFA")}>ROLL-DOWN</td>
            </tr><tr>
              <th style={{...tS(),textAlign:"left",minWidth:36,...STICKY_TH}}>Tnr</th><th style={tS()}>Val</th><th style={tS()}>Fix</th><th style={{...tS(),borderRight:"1px solid #334155"}}>D</th>
              <th style={tS("#4ADE80")}>Bid</th><th style={tS("#F87171")}>Ask</th><th style={{...tS("#FBBF24"),borderRight:"1px solid #334155"}}>Mid</th>
              <th style={tS("#4ADE80")}>Bid</th><th style={tS("#FBBF24")}>Mid</th><th style={tS("#F87171")}>Ask</th><th style={{...tS(),borderRight:"1px solid #334155"}}>D/D</th>
              <th style={tS("#4ADE80")}>Bid</th><th style={tS("#34D399")}>Mid</th><th style={tS("#F87171")}>Ask</th><th style={{...tS(),borderRight:"1px solid #334155"}}>D/D</th>
              <th style={tS("#FB923C")}>%</th><th style={{...tS(),borderRight:"1px solid #334155"}}>D/D</th>
              <th style={tS("#C084FC")}>bp</th><th style={{...tS(),borderRight:"1px solid #334155"}}>D/D</th>
              <th style={tS("#A78BFA")}>Pip</th><th style={tS("#A78BFA")}>IY(bp)</th>
            </tr></thead>
            <tbody>{filt.map((r,i)=>{const sp=r.month===0,mj=[0,1,2,3,6,9,12,24].includes(r.month);const bg=sp?"#1a2744":(i%2===0?"#0F172A":"#111827");const tc=r.suspect?"#78350F":(r.interp?"#475569":(mj?"#F8FAFC":"#94A3B8"));
              return(<tr key={r.tenor} style={{background:bg,borderBottom:[3,6,9,12].includes(r.month)?"1px solid #334155":"none",cursor:"pointer",opacity:r.suspect?0.5:1}} onDoubleClick={()=>dblR(r.tenor,r.spM,true,r.month)} title={r.suspect?r.suspectReason:undefined}>
                <td style={{...cS(tc,mj),textAlign:"left",borderRight:"1px solid #1E293B",...stickyTd(bg)}}>{r.suspect?"\u26A0 ":""}{r.tenor}{r.interpolated?"\u2071":(r.interp?"*":"")}</td>
                <td style={cS("#475569")}>{fD(r.valDate)}</td><td style={cS("#475569")}>{fD(r.fixDate)}</td><td style={{...cS("#475569"),borderRight:"1px solid #334155"}}>{r.dT||"—"}</td>
                <td style={cS("#4ADE80")}>{F(r.bT,dp)}</td><td style={cS("#F87171")}>{F(r.aT,dp)}</td><td style={{...cS("#FBBF24",true),borderRight:"1px solid #334155"}}>{F(r.mT,dp)}</td>
                <td style={cS("#4ADE80")}>{sp?"—":FP(r.spB,pdp)}</td><td style={cS("#FBBF24",true)}>{sp?"—":FP(r.spM,pdp)}</td><td style={cS("#F87171")}>{sp?"—":FP(r.spA,pdp)}</td>
                <td style={{...cS(CC(r.pipChg)),borderRight:"1px solid #334155",background:sp?"transparent":HB(r.pipChg,mPC)}}>{sp?"—":FP(r.pipChg,pdp)}</td>
                <td style={cS("#4ADE80")}>{sp?"—":F(r.iyB,2)}</td><td style={cS("#34D399",true)}>{sp?"—":F(r.iyM,2)}</td><td style={cS("#F87171")}>{sp?"—":F(r.iyA,2)}</td>
                <td style={{...cS(CC(r.iyChg)),borderRight:"1px solid #334155",background:sp?"transparent":HB(r.iyChg,mIC)}}>{sp?"—":FP(r.iyChg!=null?r.iyChg*100:null,2)}</td>
                <td style={cS("#FB923C")}>{sp?"—":F(r.sofT,2)}</td><td style={{...cS(CC(r.sofChg)),borderRight:"1px solid #334155",background:sp?"transparent":HB(r.sofChg,.005)}}>{sp?"—":FP(r.sofChg*100,1)}</td>
                <td style={cS(r.basisT!=null&&r.basisT>=0?"#C084FC":"#F472B6",true)}>{sp||r.basisT==null?"—":FP(r.basisT*100,2)}</td>
                <td style={{...cS(CC(r.basChg)),borderRight:"1px solid #334155",background:sp?"transparent":HB(r.basChg,mBC)}}>{sp?"—":FP(r.basChg!=null?r.basChg*100:null,2)}</td>
                <td style={{...cS(r.carryP!=null&&r.carryP>=0?"#A78BFA":"#F472B6"),background:r.carryP!=null?HB(r.carryP,mCP):"transparent"}}>{r.carryP!=null?FP(r.carryP,pdp):"—"}</td>
                <td style={cS(r.carryY!=null&&r.carryY>=0?"#A78BFA":"#F472B6")}>{r.carryY!=null?FP(r.carryY*100,2):"—"}</td>
              </tr>);})}</tbody></table></div>

        {/* Full-curve ladders: always render 1M + 3M chain sections so every
            ccy of the same kind has the same layout. SprChart/SprTbl render
            an empty-state placeholder if rows is empty. */}
        <SprChart rows={pkM1} title={`${cfg.pair} 1M Forward-Forward chain`} color="#22D3EE" height={180}/>
        <SprTbl spreads={pkM1} title={`${cfg.pair} 1M FWD-FWD CHAIN`} color="#22D3EE" mx={mSC} onDbl={dblR} pdp={pdp}/>
        <SprChart rows={pkM3} title={`${cfg.pair} 3M Forward-Forward chain`} color="#8B5CF6"/>
        <SprTbl spreads={pkM3} title={`${cfg.pair} 3M FWD-FWD CHAIN`} color="#8B5CF6" mx={mSC} onDbl={dblR} pdp={pdp}/>
      </>)}

      {/* SPREADS & ROLLS TAB — interbank anchors (NDF-only by trading-desk
          convention) + IMM outrights + IMM rolls. Sections always render so
          every NDF and every deliverable has the same layout. */}
      {tab==="spreads"&&(<div>
        {cfg.kind==="NDF"&&(<>
          <SprChart rows={pkInterbank} title={`${cfg.pair} Interbank Anchors`} color="#10B981"/>
          <SprTbl spreads={pkInterbank} title={`${cfg.pair} INTERBANK ANCHOR SPREADS`} color="#10B981" mx={mSC} onDbl={dblR} pdp={pdp}/>
        </>)}
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginTop:6,marginBottom:6}}>
          <PChart traces={immR.length>0?[{x:immR.map(r=>r.tenor.split(" ")[1]),y:immR.map(r=>r.spM),type:"bar",name:"SwPts",marker:{color:"#3B82F6"}},{x:immR.map(r=>r.tenor.split(" ")[1]),y:immR.map(r=>r.iyM),type:"scatter",mode:"lines+markers",name:"Impl%",line:{color:"#10B981"},yaxis:"y2"}]:[]}
            layout={{title:{text:`${cfg.pair} IMM Outrights${immR.length===0?" — no data":""}`,font:{size:10}},yaxis:{title:"Pips"},yaxis2:{title:"%",overlaying:"y",side:"right",gridcolor:"transparent"}}} height={185} revisionKey={`imm-outrights-${ccy}`}/>
          <PChart traces={immSpr.length>0?[{x:immSpr.map(s=>s.label),y:immSpr.map(s=>s.pM),type:"bar",name:"Roll Pips",marker:{color:"#F59E0B"}},{x:immSpr.map(s=>s.label),y:immSpr.map(s=>s.fIy),type:"scatter",mode:"lines+markers",name:"Impl%",line:{color:"#10B981"},yaxis:"y2"}]:[]}
            layout={{title:{text:`${cfg.pair} IMM Roll Spreads${immSpr.length===0?" — no data":""}`,font:{size:10}},yaxis:{title:"Pips"},yaxis2:{title:"%",overlaying:"y",side:"right",gridcolor:"transparent"}}} height={185} revisionKey={`imm-rolls-${ccy}`}/>
        </div>
        <div style={{background:"#131C2E",borderRadius:5,padding:6,marginBottom:6}}>
          <div style={{fontSize:9.5,fontWeight:800,color:"#FB923C",marginBottom:3}}>{cfg.pair} IMM OUTRIGHTS</div>
          {immR.length===0?(
            <div style={{color:"#475569",fontSize:9,fontStyle:"italic",padding:"6px 0"}}>no IMM data for this currency</div>
          ):(
            <div style={{overflowX:"auto"}}><table style={{borderCollapse:"collapse",width:"100%",minWidth:1200,fontSize:9}}>
              <thead><tr><th style={{...tS(),textAlign:"left"}}>IMM</th><th style={tS()}>Val Date</th><th style={tS()}>Fix Date</th><th style={tS()}>Days</th><th style={tS("#4ADE80")}>Bid</th><th style={tS("#F87171")}>Ask</th><th style={tS("#FBBF24")}>Mid</th><th style={tS("#FBBF24")}>Pips</th><th style={tS()}>D/D</th><th style={tS("#34D399")}>Iy Mid</th><th style={tS()}>Iy D/D</th><th style={tS("#FB923C")}>SOFR</th><th style={tS("#C084FC")}>Basis</th><th style={tS("#A78BFA")}>FF</th><th style={tS()}>FF D/D</th><th style={tS("#34D399")}>FF Iy</th></tr></thead>
              <tbody>{immR.map((r,i)=>(<tr key={i} style={{background:i%2===0?"#0F172A":"#131C2E",cursor:"pointer"}} onDoubleClick={()=>dblR(r.tenor,r.spM,true,r.month)}>
                <td style={{...cS("#FB923C",true),textAlign:"left"}}>{r.tenor}</td><td style={cS("#475569")}>{fD(r.valDate)}</td><td style={cS("#475569")}>{fD(r.fixDate)}</td><td style={cS("#475569")}>{r.dT}</td>
                <td style={cS("#4ADE80")}>{F(r.bT,dp)}</td><td style={cS("#F87171")}>{F(r.aT,dp)}</td><td style={cS("#FBBF24",true)}>{F(r.mT,dp)}</td>
                <td style={cS("#FBBF24",true)}>{FP(r.spM,pdp)}</td><td style={{...cS(CC(r.pipChg)),background:HB(r.pipChg,mPC)}}>{FP(r.pipChg,pdp)}</td>
                <td style={cS("#34D399",true)}>{F(r.iyM,2)}</td><td style={{...cS(CC(r.iyChg)),background:HB(r.iyChg,mIC)}}>{FP(r.iyChg,2)}</td>
                <td style={cS("#FB923C")}>{F(r.sofT,2)}</td><td style={cS(r.basisT!=null&&r.basisT>=0?"#C084FC":"#F472B6")}>{r.basisT!=null?FP(r.basisT*100,1):"—"}</td>
                <td style={cS(r.ffM>=0?"#A78BFA":"#F472B6")}>{FP(r.ffM,pdp)}</td><td style={{...cS(CC(r.ffChg)),background:HB(r.ffChg,mFC)}}>{FP(r.ffChg,pdp)}</td>
                <td style={cS("#34D399")}>{F(r.ffIyM,2)}</td>
              </tr>))}</tbody></table></div>
          )}
        </div>
        <SprTbl spreads={immSpr} title={`${cfg.pair} IMM ROLL SPREADS`} color="#F59E0B" mx={mSC} onDbl={dblR} pdp={pdp}/>
      </div>)}

      {tab==="tools"&&<ToolsPanel ad={ad} onDbl={dblR} ccy={ccy}/>}
      {tab==="broker"&&<BrokerMon ad={ad} liveOn={liveOn}/>}

      <div style={{marginTop:4,fontSize:6.5,color:"#334155",display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:2}}>
        <div>* = Calculated: ImplYld=((F/S)(1+SOFR×d/360)-1)×360/d · FwdFwd Impl=compounded from outrights · Spread bid=far_bid−near_ask · Weekly tenors interpolated (Fritsch-Carlson monotone cubic)</div>
        <div>IMM=3rd Wed Mar/Jun/Sep/Dec · Fix=T-2 biz</div>
      </div>
    </div>);
}

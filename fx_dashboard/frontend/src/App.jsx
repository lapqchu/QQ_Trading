// FX Dashboard — full port from v1, backend-driven
import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import Plot from "react-plotly.js";
import { getCurrencies, getHistory, getSnapshot, liveStart, liveStop, openChannel, getIpaForward } from "./api.js";
import { buildAllData, calcCustom } from "./dataTransform.js";
import { F, FP, CC, HB, cS, tS, sS, mid, implYld, fwdFwdIy, mcI, calcSMA, calcEMA, calcRSI, calcBB, calcMACD, calcStats, calcZDev, backtest, STRAT_DESCS } from "./calc.js";
import { fD, daysBtwn } from "./dates.js";

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

function PChart({traces,layout,height=190}){
  const mergedX={...PLOT_LAYOUT.xaxis,...(layout?.xaxis||{})};
  const mergedY={...PLOT_LAYOUT.yaxis,...(layout?.yaxis||{})};
  const mergedY2=layout?.yaxis2?{...PLOT_LAYOUT.yaxis,overlaying:"y",side:"right",gridcolor:"transparent",...layout.yaxis2}:undefined;
  const l={...PLOT_LAYOUT,...layout,height,xaxis:mergedX,yaxis:mergedY,uirevision:"preserve"};
  if(mergedY2)l.yaxis2=mergedY2;
  return <Plot data={traces} layout={l} config={PLOT_CFG} style={{width:"100%"}} useResizeHandler/>;
}

// ── Helper: extract mid value from a history bar (no fabrication) ──
function barMid(bar){
  if(bar.TRDPRC_1!=null&&isFinite(bar.TRDPRC_1))return bar.TRDPRC_1;
  if(bar.BID!=null&&bar.ASK!=null)return(bar.BID+bar.ASK)/2;
  if(bar.BID!=null)return bar.BID;
  if(bar.ASK!=null)return bar.ASK;
  return null;
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
function HistModal({tenor,val,isSwapPts,onClose,dpOverride,ccy,monthHint,nrM,frM}){
  const[hist,setHist]=useState(null);
  const[histSource,setHistSource]=useState(null);
  const[loading,setLoading]=useState(true);
  const[unavailReason,setUnavailReason]=useState(null);
  const[sigN,setSigN]=useState(20);
  useEffect(()=>{
    let cancelled=false;
    setLoading(true);
    setUnavailReason(null);
    setHistSource(null);
    getHistory(ccy,252).then(data=>{
      if(cancelled)return;
      // If nrM/frM provided, this is a spread — compute from individual tenor legs
      const isSpread=nrM!=null&&frM!=null;
      const{pts,source}=isSpread
        ?buildSpreadHistory(data,nrM,frM)
        :buildHistoryForTenor(data,tenor,isSwapPts,monthHint);
      if(pts&&pts.length>10){
        setHist(pts);
        setHistSource(source);
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
  },[ccy,tenor,isSwapPts,monthHint,nrM,frM]);
  const stats=useMemo(()=>hist?calcStats(hist,sigN):null,[hist,sigN]);
  const rsiD=useMemo(()=>hist?calcRSI(hist):[],[hist]);
  const macdD=useMemo(()=>hist?calcMACD(hist):{line:[],signal:[],hist:[]},[hist]);
  const bb=useMemo(()=>hist?calcBB(hist):{upper:[],lower:[],mid:[]},[hist]);
  const s20=useMemo(()=>hist?calcSMA(hist,20):[],[hist]);
  const s50=useMemo(()=>hist?calcSMA(hist,50):[],[hist]);
  const zDev=useMemo(()=>hist?calcZDev(hist,sigN):[],[hist,sigN]);
  const[btPeriod,setBtPeriod]=useState(252);
  const btRes=useMemo(()=>hist?backtest(hist,btPeriod):[],[hist,btPeriod]);
  const[selSt,setSelSt]=useState(null);const[hovSt,setHovSt]=useState(null);
  const dates=hist?hist.map(h=>h.date):[];const vals=hist?hist.map(h=>h.value):[];
  const yLabel=isSwapPts?"Swap Points (pips)":"Level";
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
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <h2 style={{fontSize:13,fontWeight:800,color:"#F8FAFC",margin:0}}>{tenor} — Historical {isSwapPts?"(Swap Points)":""}{histSource==='interpolated'&&<span style={{color:"#60A5FA",fontWeight:400,fontSize:9,marginLeft:8}}>Interpolated from anchor data</span>}</h2>
          <button onClick={onClose} style={{background:"#1E293B",border:"1px solid #334155",color:"#94A3B8",padding:"3px 10px",borderRadius:4,cursor:"pointer",fontSize:9}}>Close (ESC)</button>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 220px",gap:8}}>
          <div>
            <PChart traces={priceTraces} layout={{title:{text:`${tenor} ${yLabel}`,font:{size:10,color:"#94A3B8"}},yaxis:{title:yLabel}}} height={210}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,marginTop:4}}>
              <PChart traces={rsiTraces} layout={{title:{text:"RSI(14)",font:{size:9,color:"#64748B"}},yaxis:{range:[0,100]},shapes:[{type:"line",y0:70,y1:70,x0:0,x1:1,xref:"paper",line:{color:"#F87171",dash:"dot",width:1}},{type:"line",y0:30,y1:30,x0:0,x1:1,xref:"paper",line:{color:"#4ADE80",dash:"dot",width:1}}]}} height={120}/>
              <PChart traces={macdTraces} layout={{title:{text:"MACD(12,26,9)",font:{size:9,color:"#64748B"}}}} height={120}/>
            </div>
          </div>
          <div style={{background:"#131C2E",borderRadius:5,padding:6,overflow:"auto",maxHeight:460}}>
            <div style={{fontSize:8,fontWeight:800,color:"#60A5FA",marginBottom:3,letterSpacing:".1em"}}>HIGH / LOW</div>
            {Object.entries(stats.ranges).map(([k,v])=>(<div key={k} style={{display:"flex",justifyContent:"space-between",padding:"1px 0",fontSize:8.5,borderBottom:"1px solid #1E293B"}}><span style={{color:"#64748B",width:22}}>{k}</span><span style={{color:"#4ADE80",fontFamily:"monospace"}}>{v.low.toFixed(isSwapPts?1:3)}</span><span style={{color:"#64748B"}}>—</span><span style={{color:"#F87171",fontFamily:"monospace"}}>{v.high.toFixed(isSwapPts?1:3)}</span></div>))}
            <div style={{fontSize:8,fontWeight:800,color:"#10B981",marginTop:5,marginBottom:3,letterSpacing:".1em"}}>STATISTICS</div>
            <SR l="Current" v={stats.current} dp={isSwapPts?1:(dpOverride||3)}/><SR l="Mean" v={stats.mean} dp={isSwapPts?1:(dpOverride||3)}/><SR l="Std Dev" v={stats.sd} dp={isSwapPts?1:4}/><SR l="Skewness" v={stats.skew} dp={2}/><SR l="Kurtosis" v={stats.kurt} dp={2}/><SR l="Pctl Rank" v={`${stats.pctR.toFixed(0)}%`}/>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:5,marginBottom:3}}>
              <span style={{fontSize:8,fontWeight:800,color:"#F87171",letterSpacing:".1em"}}>SIGMA-MOVE</span>
              <div style={{display:"flex",alignItems:"center",gap:2}}><span style={{fontSize:7,color:"#64748B"}}>N:</span>
                <input type="number" value={sigN} onChange={e=>setSigN(Math.max(5,Math.min(252,+e.target.value||20)))} style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"0 3px",fontSize:8,width:34,fontFamily:"monospace"}}/></div>
            </div>
            <SR l="Today's Δ" v={stats.dayChg!=null?stats.dayChg:"—"} dp={isSwapPts?1:4}/>
            <SR l={`${sigN}d σ(Δ)`} v={stats.rollSd!=null?stats.rollSd:"—"} dp={isSwapPts?2:5}/>
            <div style={{display:"flex",justifyContent:"space-between",padding:"1px 0",borderBottom:"1px solid #1E293B",fontSize:8.5}}><span style={{color:"#64748B"}}>σ-Move</span><span style={{color:stats.sigmaMove==null?"#475569":(Math.abs(stats.sigmaMove)>=2?"#F87171":Math.abs(stats.sigmaMove)>=1?"#FBBF24":"#4ADE80"),fontFamily:"monospace",fontWeight:700}}>{stats.sigmaMove!=null?stats.sigmaMove.toFixed(2)+"σ":"—"}</span></div>
            <div style={{fontSize:8,fontWeight:800,color:"#FBBF24",marginTop:5,marginBottom:3,letterSpacing:".1em"}}>INDICATORS</div>
            <SR l="SMA(20)" v={s20[s20.length-1]} dp={isSwapPts?1:(dpOverride||3)}/><SR l="SMA(50)" v={s50[s50.length-1]} dp={isSwapPts?1:(dpOverride||3)}/><SR l="RSI(14)" v={rsiD[rsiD.length-1]} dp={1}/><SR l="MACD" v={macdD.line[macdD.line.length-1]} dp={4}/><SR l="BB Upper" v={bb.upper[bb.upper.length-1]} dp={isSwapPts?1:(dpOverride||3)}/><SR l="BB Lower" v={bb.lower[bb.lower.length-1]} dp={isSwapPts?1:(dpOverride||3)}/>
            <SR l={`SMA(${sigN})`} v={stats.smaN!=null?stats.smaN:"—"} dp={isSwapPts?1:(dpOverride||3)}/>
            <SR l="Dev from MA" v={stats.devMA!=null?stats.devMA:"—"} dp={isSwapPts?1:4}/>
            <div style={{display:"flex",justifyContent:"space-between",padding:"1px 0",borderBottom:"1px solid #1E293B",fontSize:8.5}}><span style={{color:"#64748B"}}>Z(Dev,{sigN})</span><span style={{color:stats.zDev==null?"#475569":(Math.abs(stats.zDev)>=2?"#F472B6":Math.abs(stats.zDev)>=1?"#FBBF24":"#4ADE80"),fontFamily:"monospace",fontWeight:700}}>{stats.zDev!=null?stats.zDev.toFixed(2):"—"}</span></div>
          </div>
        </div>
        {/* Backtesting */}
        <div style={{marginTop:8,background:"#131C2E",borderRadius:5,padding:6}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
            <span style={{fontSize:9,fontWeight:800,color:"#F59E0B",letterSpacing:".1em"}}>STRATEGY BACKTESTING</span>
            <div style={{display:"flex",gap:3,alignItems:"center"}}><span style={{fontSize:8,color:"#64748B"}}>Period:</span>
              {[[22,"1M"],[66,"3M"],[132,"6M"],[252,"1Y"]].map(([d,l])=>(<button key={d} onClick={()=>{setBtPeriod(d);setSelSt(null);}} style={{fontSize:7.5,padding:"1px 5px",borderRadius:3,border:"none",cursor:"pointer",background:btPeriod===d?"#3B82F6":"#1E293B",color:btPeriod===d?"#FFF":"#64748B"}}>{l}</button>))}</div>
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
                <PChart traces={[{x:st.dates,y:st.eqC.slice(1),type:"scatter",mode:"lines",name:"Cum P&L (pts)",line:{color:"#10B981",width:1.5}}]} layout={{title:{text:`${st.name} — Cumulative P&L (pts)`,font:{size:9,color:"#94A3B8"}},yaxis:{title:"Points"},shapes:[{type:"line",y0:0,y1:0,x0:0,x1:1,xref:"paper",line:{color:"#475569",dash:"dot"}}]}} height={110}/>
                <PChart traces={[{x:st.dates,y:st.rollSh,type:"scatter",mode:"lines",name:"Roll 20d Sharpe",line:{color:"#FBBF24",width:1.3}}]} layout={{title:{text:"Rolling 20d Sharpe",font:{size:9,color:"#94A3B8"}},shapes:[{type:"line",y0:0,y1:0,x0:0,x1:1,xref:"paper",line:{color:"#475569",dash:"dot"}}]}} height={100}/>
              </div>);})()}
          </div>
        </div>
      </div>
    </div>);
}

// ══════════════════════ SPREAD TABLE ══════════════════════
function SprTbl({spreads,title,color,mx,onDbl,pdp=1}){
  if(!spreads||!spreads.length)return null;
  return(<div style={{background:"#131C2E",borderRadius:5,padding:6,marginBottom:6}}>
    <div style={{fontSize:9.5,fontWeight:800,color,marginBottom:3,letterSpacing:".05em"}}>{title}</div>
    <div style={{overflowX:"auto"}}><table style={{borderCollapse:"collapse",width:"100%",minWidth:1000,fontSize:9}}>
      <thead><tr><th style={{...tS(),textAlign:"left",minWidth:60}}>Spread</th><th style={tS()}>Near Val</th><th style={tS()}>Near Fix</th><th style={tS()}>Far Val</th><th style={tS()}>Far Fix</th><th style={tS()}>Days</th><th style={tS("#4ADE80")}>Bid</th><th style={tS("#FBBF24")}>Mid</th><th style={tS("#F87171")}>Ask</th><th style={tS()}>D/D</th><th style={tS()}>Pts/D</th><th style={tS("#4ADE80")}>Iy Bid</th><th style={tS("#34D399")}>Iy Mid</th><th style={tS("#F87171")}>Iy Ask</th><th style={tS()}>Iy D/D</th><th style={tS()}>Iy bp/d</th><th style={tS("#FB923C")}>SOFR%</th><th style={tS("#C084FC")}>Basis</th></tr></thead>
      <tbody>{spreads.map((s,i)=>(<tr key={i} style={{background:i%2===0?"#0F172A":"#131C2E",cursor:"pointer"}} onDoubleClick={()=>onDbl&&onDbl(s.label,Math.abs(s.pM)||1,true,null,s.nrM,s.frM)}>
        <td style={{...cS(color,true),textAlign:"left"}}>{s.label}</td>
        <td style={cS("#475569")}>{fD(s.nrVD)}</td><td style={cS("#475569")}>{fD(s.nrFxD)}</td><td style={cS("#475569")}>{fD(s.frVD)}</td><td style={cS("#475569")}>{fD(s.frFxD)}</td><td style={cS("#475569",false,true)}>{s.days}</td>
        <td style={cS("#4ADE80")}>{FP(s.pB,pdp)}</td><td style={cS("#FBBF24",true)}>{FP(s.pM,pdp)}</td><td style={cS("#F87171")}>{FP(s.pA,pdp)}</td>
        <td style={{...cS(CC(s.chg)),background:HB(s.chg,mx)}}>{FP(s.chg,pdp)}</td><td style={cS("#64748B",false,true)}>{F(s.ppd,2)}</td>
        <td style={cS("#4ADE80")}>{F(s.fIyB,2)}</td><td style={cS("#34D399",true)}>{F(s.fIy,2)}</td><td style={cS("#F87171")}>{F(s.fIyA,2)}</td>
        <td style={{...cS(CC(s.iyChg)),background:HB(s.iyChg,.1)}}>{FP(s.iyChg,2)}</td><td style={cS("#64748B")}>{s.iyBpD!=null?F(s.iyBpD,2):"—"}</td>
        <td style={cS("#FB923C")}>{F(s.fSof,2)}</td><td style={cS(s.bas!=null&&s.bas>=0?"#C084FC":"#F472B6",true)}>{s.bas!=null?FP(s.bas*100,1):"—"}</td>
      </tr>))}</tbody></table></div></div>);
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
    return calcCustom(ad,nearM,farM,null,null,null);
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
      const r=ad.rows.find(x=>x.month===mKey);if(!r)return null;return{...r,_lbl:mKey===0?"Spot":`${mKey}M`};
    }
    const nr=resolveLeg(scN,scNDt),fr=resolveLeg(scF,scFDt);
    if(!nr||!fr)return null;const ds=fr.dT-nr.dT;if(ds<=0)return null;
    if(scMode==="pips"){const newFarMid=ad.sMT+((nr.spM+v)/PF);const newFarIy=implYld(newFarMid,ad.sMT,fr.sofT,fr.dT);const newFwdIy=newFarIy!=null?fwdFwdIy(nr.iyM,nr.dT,newFarIy,fr.dT):null;return{label:`${nr._lbl}×${fr._lbl} @ ${v} pips`,impl:newFwdIy,pips:v,days:ds};}
    else{const nearFac=1+(nr.iyM/100)*nr.dT/360;const farFac=nearFac*(1+(v/100)*ds/360);const farIy=(farFac-1)*360/fr.dT*100;const farNDF=ad.sMT*(farIy/100*fr.dT/360+1)/(1+fr.sofT/100*fr.dT/360);const sprPips=(farNDF-ad.sMT)*PF-nr.spM;return{label:`${nr._lbl}×${fr._lbl} @ ${v}% impl`,impl:v,pips:sprPips,days:ds};}
  },[scIn,scMode,scN,scF,scNDt,scFDt,scTenorMode,ad,PF]);
  const maxT=ad.maxT||24;
  const sel=(v,set)=><select value={Math.min(v,maxT)} onChange={e=>set(+e.target.value)} style={{background:"#1E293B",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"2px 4px",fontSize:9}}>{Array.from({length:maxT+1},(_,i)=>i).map(m=><option key={m} value={m}>{m===0?"Spot":m<=12?`${m}M`:m===24?"2Y":`${m}M`}</option>)}</select>;
  return(<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
    <div style={{background:"#131C2E",borderRadius:5,padding:8}}>
      <div style={{fontSize:9.5,fontWeight:800,color:"#60A5FA",marginBottom:4,letterSpacing:".05em"}}>USER-DEFINED TENOR</div>
      <div style={{display:"flex",gap:4,marginBottom:6}}>
        <button onClick={()=>setMode("month")} style={{fontSize:7.5,padding:"1px 6px",borderRadius:3,border:"none",cursor:"pointer",background:mode==="month"?"#3B82F6":"#1E293B",color:mode==="month"?"#FFF":"#64748B"}}>By Month</button>
        <button onClick={()=>setMode("date")} style={{fontSize:7.5,padding:"1px 6px",borderRadius:3,border:"none",cursor:"pointer",background:mode==="date"?"#3B82F6":"#1E293B",color:mode==="date"?"#FFF":"#64748B"}}>By Date</button>
      </div>
      {mode==="month"?(<div style={{display:"flex",gap:4,alignItems:"center",marginBottom:6}}><span style={{fontSize:8,color:"#64748B"}}>Near:</span>{sel(nearM,setNearM)}<span style={{fontSize:8,color:"#64748B"}}>Far:</span>{sel(farM,setFarM)}</div>):(<div style={{display:"flex",gap:4,alignItems:"center",marginBottom:6,flexWrap:"wrap"}}><span style={{fontSize:8,color:"#64748B"}}>Near date:</span><input type="date" value={nearDt} onChange={e=>setNearDt(e.target.value)} style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"2px 4px",fontSize:9}}/><span style={{fontSize:8,color:"#64748B"}}>Far date:</span><input type="date" value={farDt} onChange={e=>setFarDt(e.target.value)} style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"2px 4px",fontSize:9}}/></div>)}
      {custom&&(<div style={{background:"#0F172A",borderRadius:4,padding:6,fontSize:9,cursor:"pointer"}} onDoubleClick={()=>onDbl&&onDbl(custom.label,Math.abs(custom.pM)||1,true)}>
        <div style={{color:"#FBBF24",fontWeight:700,marginBottom:3}}>{custom.label} <span style={{color:"#475569",fontWeight:400,fontSize:7.5}}>(double-click for historical)</span></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:3}}>
          <div><span style={{color:"#64748B"}}>Bid: </span><span style={{color:"#4ADE80",fontFamily:"monospace"}}>{FP(custom.pB,1)}</span></div>
          <div><span style={{color:"#64748B"}}>Mid: </span><span style={{color:"#FBBF24",fontFamily:"monospace"}}>{FP(custom.pM,1)}</span></div>
          <div><span style={{color:"#64748B"}}>Ask: </span><span style={{color:"#F87171",fontFamily:"monospace"}}>{FP(custom.pA,1)}</span></div>
          <div><span style={{color:"#64748B"}}>Days: </span><span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{custom.days}</span></div>
          <div><span style={{color:"#64748B"}}>Fwd Impl: </span><span style={{color:"#10B981",fontFamily:"monospace"}}>{custom.fIy!=null?F(custom.fIy,2)+"%":"—"}</span></div>
          <div><span style={{color:"#64748B"}}>Near Val: </span><span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{fD(custom.nrVD)}</span></div>
          <div><span style={{color:"#64748B"}}>Near Fix: </span><span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{fD(custom.nrFxD)}</span></div>
          <div><span style={{color:"#64748B"}}>Far Val: </span><span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{fD(custom.frVD)}</span></div>
          <div><span style={{color:"#64748B"}}>Far Fix: </span><span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{fD(custom.frFxD)}</span></div>
        </div></div>)}
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
function BrokerMon({ad,liveQuotes={},liveOn=false}){
  const{rows,ccy,cfg}=ad;const maxT=ad.maxT||24;
  const pdp=cfg.pipDp??1;
  const PF=cfg.pipFactor||1e3;
  const ptsOutright=cfg.ptsInOutright||false;
  // For ptsInOutright currencies, LSEG broker quotes are in outright diffs — multiply by PF for display
  const brkMult=ptsOutright?PF:1;
  const[selBrokers,setSelBrokers]=useState(["ICAP","BGCP","TRDS","TPTS","PYNY","GMGM"]);
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
  const brokerList=["ICAP","BGCP","TRDS","TPTS","PYNY","GMGM"];

  function getSpreadVal(t){
    if(t.type==="outright"){const r=rows.find(x=>x.month===t.m);return r?{bid:r.spB,mid:r.spM,ask:r.spA}:null;}
    const nr=rows.find(x=>x.month===t.near),fr=rows.find(x=>x.month===t.far);if(!nr||!fr)return null;
    return{bid:fr.spB!=null&&nr.spA!=null?fr.spB-nr.spA:null,mid:fr.spM!=null&&nr.spM!=null?fr.spM-nr.spM:null,ask:fr.spA!=null&&nr.spB!=null?fr.spA-nr.spB:null};
  }

  // Build broker RIC name for a given tenor month and contributor
  function brokerRic(m,contrib){
    const tenor=m===0?"":m<12?`${m}M`:m===12?"1Y":m===18?"18M":m===24?"2Y":`${m}M`;
    if(cfg.kind==="NDF")return`${ccy}${tenor}NDF=${contrib}`;
    return`${ccy}${tenor}=${contrib}`;
  }

  // Get live broker data for a specific tenor setup and contributor
  function getBrokerVal(t,contrib){
    if(t.type==="outright"){
      const ric=brokerRic(t.m,contrib);
      const q=liveQuotes[ric];
      if(!q)return null;
      const b=q.bid!=null?q.bid*brkMult:null,a=q.ask!=null?q.ask*brkMult:null;
      return{bid:b,mid:(q.mid??mid(q.bid,q.ask))!=null?(q.mid??mid(q.bid,q.ask))*brkMult:null,ask:a};
    }
    // Spread: get near and far broker RICs
    const nrRic=brokerRic(t.near===0?1:t.near,contrib);
    const frRic=brokerRic(t.far,contrib);
    if(t.near===0){
      const fq=liveQuotes[frRic];
      if(!fq)return null;
      const b=fq.bid!=null?fq.bid*brkMult:null,a=fq.ask!=null?fq.ask*brkMult:null;
      return{bid:b,mid:(fq.mid??mid(fq.bid,fq.ask))!=null?(fq.mid??mid(fq.bid,fq.ask))*brkMult:null,ask:a};
    }
    const nq=liveQuotes[nrRic],fq=liveQuotes[frRic];
    if(!nq||!fq)return null;
    const nMid=nq.mid??mid(nq.bid,nq.ask),fMid=fq.mid??mid(fq.bid,fq.ask);
    return{
      bid:fq.bid!=null&&nq.ask!=null?(fq.bid-nq.ask)*brkMult:null,
      mid:fMid!=null&&nMid!=null?(fMid-nMid)*brkMult:null,
      ask:fq.ask!=null&&nq.bid!=null?(fq.ask-nq.bid)*brkMult:null,
    };
  }

  // Cell renderer for broker value
  function BrkCell({t,contrib,color}){
    const v=getBrokerVal(t,contrib);
    if(!v)return<td style={cS("#334155")}>{liveOn?"—":"Live only"}</td>;
    return<td style={cS(color)}>{FP(v.mid??v.bid??v.ask,pdp)}</td>;
  }

  return(<div>
    <div style={{fontSize:10,fontWeight:800,color:"#60A5FA",marginBottom:6,letterSpacing:".05em"}}>REUTERS DEFAULT (COMPOSITE) RUN — {cfg.pair} ({ccy})</div>
    <div style={{background:"#131C2E",borderRadius:5,padding:6,marginBottom:6}}>
      <table style={{borderCollapse:"collapse",width:"100%",fontSize:9,marginBottom:4}}><thead><tr>
        <th style={{...tS(),textAlign:"left"}}>Tenor</th><th style={tS("#4ADE80")}>Bid</th><th style={tS("#FBBF24")}>Mid</th><th style={tS("#F87171")}>Ask</th><th style={tS()}>Width</th>
      </tr></thead><tbody>
        {allT.map((t,idx)=>{const v=getSpreadVal(t);return(<tr key={idx} style={{background:idx%2===0?"#0F172A":"#131C2E"}}>
          <td style={{...cS("#CBD5E1",true),textAlign:"left"}}>{t.label}</td>
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
        {brokerList.map(b=>(<label key={b} style={{fontSize:8,color:"#E2E8F0",display:"flex",alignItems:"center",gap:2,cursor:"pointer"}}><input type="checkbox" checked={selBrokers.includes(b)} onChange={e=>e.target.checked?setSelBrokers([...selBrokers,b]):setSelBrokers(selBrokers.filter(x=>x!==b))} style={{accentColor:"#3B82F6",width:8,height:8}}/>{b}</label>))}
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
          return(<tr key={idx} style={{background:idx%2===0?"#0F172A":"#131C2E"}}>
          <td style={{...cS("#CBD5E1",true),textAlign:"left"}}>{t.label}</td>
          {selBrokers.map(b=>{const v=getBrokerVal(t,b);const hasV=v&&(v.bid!=null||v.mid!=null||v.ask!=null);
            return<React.Fragment key={b}>
              <td style={cS(hasV?"#4ADE80":"#334155")}>{hasV?FP(v.bid,pdp):(liveOn?"—":"Live only")}</td>
              <td style={cS(hasV?"#FBBF24":"#334155",true)}>{hasV?FP(v.mid,pdp):(liveOn?"—":"Live only")}</td>
              <td style={cS(hasV?"#F87171":"#334155")}>{hasV?FP(v.ask,pdp):(liveOn?"—":"Live only")}</td>
            </React.Fragment>;})}
          {avgBrokers&&<><td style={cS("#10B981")}>{avgBid!=null?FP(avgBid,pdp):"—"}</td><td style={cS("#34D399")}>{avgMid!=null?FP(avgMid,pdp):"—"}</td><td style={cS("#A78BFA")}>{avgAsk!=null?FP(avgAsk,pdp):"—"}</td></>}
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
  const ALL_SOURCES=["DEFAULT","ICAP","BGCP","TRDS","TPTS","PYNY","GMGM"];
  const[sources,setSources]=useState(["DEFAULT"]);
  const[err,setErr]=useState(null);
  const[lastReload,setLastReload]=useState(null);
  const[reloadMsg,setReloadMsg]=useState(null);
  const[liveTick,setLiveTick]=useState(0);
  const channelsRef=useRef([]);

  useEffect(()=>{getCurrencies().then(setMeta).catch(e=>setErr(e.message));},[]);
  useEffect(()=>{
    setErr(null);setSnap(null);setLiveQuotes({});
    getSnapshot(ccy).then(s=>{setSnap(s);setLastReload(new Date());}).catch(e=>setErr(e.message));
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

  const ad=useMemo(()=>buildAllData(snap,liveQuotes,sources),[snap,liveQuotes,liveTick,sources]);
  const refreshSnap=useCallback(()=>{
    getSnapshot(ccy).then(s=>{
      setSnap(s);
      setLastReload(new Date());
      setReloadMsg("Snap refreshed successfully");
      setTimeout(()=>setReloadMsg(null),3000);
    }).catch(e=>setErr(e.message));
  },[ccy]);

  if(err)return <div style={{padding:20,color:"#F87171"}}>Backend error: {err}</div>;
  if(!meta||!snap||!ad)return <div style={{padding:20,color:"#64748B"}}>Loading…</div>;

  const{rows,immR,anchors,qFF,spSpr,immSpr,cfg}=ad;
  const filt=showI?rows:rows.filter(r=>!r.interp);
  const mr=rows.filter(r=>r.month>0);
  const mPC=Math.max(...mr.map(r=>Math.abs(r.pipChg||0)),1);
  const mIC=Math.max(...mr.map(r=>Math.abs(r.iyChg||0)),.01);
  const mBC=Math.max(...mr.map(r=>Math.abs(r.basChg||0)),.01);
  const mFC=Math.max(...mr.filter(r=>r.month>1).map(r=>Math.abs(r.ffChg||0)),1);
  const mCP=Math.max(...mr.map(r=>Math.abs(r.carryP||0)),1);
  const mRP=Math.max(...mr.filter(r=>r.month>1).map(r=>Math.abs(r.rollP||0)),1);
  const mCY=Math.max(...mr.map(r=>Math.abs(r.carryY||0)),.01);
  const mSC=Math.max(...[...anchors,...qFF,...spSpr,...immSpr].map(s=>Math.abs(s.chg||0)),1);
  const dblR=(t,v,isSP=false,month=null,nrM=null,frM=null)=>setHm({tenor:t,value:v,isSP,month,nrM,frM});
  const dp=cfg.dp;
  const pdp=cfg.pipDp??1; // pip decimal places from config

  const chartRows=filt.filter(r=>r.month>0&&!r.isWeekly);
  const tenors=chartRows.map(r=>r.tenor);
  const outPts=chartRows.map(r=>r.spM);
  const ffPts=chartRows.map(r=>r.ffM);
  const iyVals=chartRows.map(r=>r.iyM);
  const sofrVals=chartRows.map(r=>r.sofT);
  const basVals=chartRows.map(r=>r.basisT!=null?r.basisT*100:null);

  const tabs=[{id:"main",label:"Full Curve"},{id:"spreads",label:"Spreads & Rolls"},{id:"imm",label:"IMM Dates"},{id:"tools",label:"Tools"},{id:"broker",label:"Broker Monitor"}];

  return(
    <div style={{background:"#0F172A",color:"#E2E8F0",minHeight:"100vh",fontFamily:"'Inter',system-ui,sans-serif",padding:8}}>
      {hm&&<HistModal tenor={hm.tenor} val={hm.value} isSwapPts={hm.isSP} dpOverride={dp} onClose={()=>setHm(null)} ccy={ccy} monthHint={hm.month} nrM={hm.nrM} frM={hm.frM}/>}
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
          <div style={{display:"flex",gap:2,alignItems:"center",background:"#1E293B",padding:"2px 6px",borderRadius:4}}>
            <span style={{fontSize:7,color:"#64748B",fontWeight:700}}>SRC:</span>
            {ALL_SOURCES.map(s=>{const on=sources.includes(s);return(<button key={s} onClick={()=>{
              if(on&&sources.length===1)return;// must have at least one
              setSources(prev=>on?prev.filter(x=>x!==s):[...prev,s]);
            }} style={{fontSize:7,padding:"1px 4px",borderRadius:2,border:"none",cursor:"pointer",fontWeight:600,background:on?"#3B82F6":"#0F172A",color:on?"#FFF":"#64748B"}}>{s==="DEFAULT"?"DFLT":s}</button>);})}</div>
          <div style={{background:"#1E293B",padding:"2px 6px",borderRadius:4,fontSize:9,fontFamily:"monospace"}}>
            <span style={{color:"#64748B"}}>Spot </span><span style={{color:"#4ADE80"}}>{F(rows[0].bT,dp)}</span><span style={{color:"#334155"}}>/</span><span style={{color:"#F87171"}}>{F(rows[0].aT,dp)}</span><span style={{color:"#334155"}}> | </span><span style={{color:"#FBBF24",fontWeight:700}}>{F(rows[0].mT,dp)}</span>
          </div>
          {cfg.kind==="NDF"&&rows[1+3]&&(
            <div style={{background:"#1E293B",padding:"2px 6px",borderRadius:4,fontSize:9,fontFamily:"monospace"}}>
              <span style={{color:"#64748B"}}>1M </span>
              <span style={{color:"#4ADE80"}}>{F(rows.find(r=>r.month===1)?.bT,dp)}</span>
              <span style={{color:"#334155"}}>/</span>
              <span style={{color:"#F87171"}}>{F(rows.find(r=>r.month===1)?.aT,dp)}</span>
              <span style={{color:"#334155"}}> | </span>
              <span style={{color:"#FBBF24",fontWeight:700}}>{F(rows.find(r=>r.month===1)?.mT,dp)}</span>
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
          <PChart traces={[{x:tenors,y:outPts,type:"scatter",mode:"lines+markers",name:"Outright SwPts",line:{color:"#F59E0B"},marker:{size:4}}]} layout={{title:{text:`${cfg.pair} Outright Swap Points (pips)`,font:{size:10}},yaxis:{title:"Swap Points (pips)"}}} height={175}/>
          <PChart traces={[{x:tenors,y:ffPts,type:"bar",name:"1M Fwd-Fwd",marker:{color:ffPts.map(v=>v>=0?"#3B82F6":"#F472B6")}}]} layout={{title:{text:`${cfg.pair} 1M Forward-Forward (pips)`,font:{size:10}}}} height={175}/>
          <PChart traces={[{x:tenors,y:iyVals,type:"scatter",mode:"lines+markers",name:`${cfg.pair.slice(3)} Impl%`,line:{color:"#10B981"},marker:{size:3}},{x:tenors,y:sofrVals,type:"scatter",mode:"lines+markers",name:"SOFR%",line:{color:"#FB923C"},marker:{size:3}}]} layout={{title:{text:`${cfg.pair} Implied Yield vs SOFR (%)`,font:{size:10}},yaxis:{title:"%"}}} height={175}/>
          <PChart traces={[{x:tenors,y:basVals,type:"bar",name:"Basis bp",marker:{color:basVals.map(v=>v>=0?"#8B5CF6":"#F472B6")}}]} layout={{title:{text:`${cfg.pair} Basis (bp)`,font:{size:10}}}} height={175}/>
        </div>

        <div style={{fontSize:8.5,fontWeight:700,color:"#F8FAFC",marginBottom:2}}>OUTRIGHT {cfg.kind==="NDF"?"NDF":"FWD"} CURVE</div>
        <div style={{overflowX:"auto",overflowY:"auto",maxHeight:"34vh",borderRadius:5,border:"1px solid #1E293B",marginBottom:6}}>
          <table style={{borderCollapse:"collapse",width:"100%",minWidth:1700}}>
            <thead><tr>
              <td colSpan={4} style={sS("#64748B")}>TENOR</td><td colSpan={3} style={sS("#60A5FA")}>{cfg.kind} OUTRIGHT</td>
              <td colSpan={4} style={sS("#FBBF24")}>SWAP POINTS</td><td colSpan={4} style={sS("#34D399")}>IMPLIED YIELD*</td>
              <td colSpan={2} style={sS("#FB923C")}>SOFR</td><td colSpan={2} style={sS("#C084FC")}>BASIS</td>
              <td colSpan={2} style={sS("#38BDF8")}>CARRY</td><td colSpan={2} style={sS("#A78BFA")}>ROLL-DOWN</td>
            </tr><tr>
              <th style={{...tS(),textAlign:"left",minWidth:36}}>Tnr</th><th style={tS()}>Val</th><th style={tS()}>Fix</th><th style={{...tS(),borderRight:"1px solid #334155"}}>D</th>
              <th style={tS("#4ADE80")}>Bid</th><th style={tS("#F87171")}>Ask</th><th style={{...tS("#FBBF24"),borderRight:"1px solid #334155"}}>Mid</th>
              <th style={tS("#4ADE80")}>Bid</th><th style={tS("#FBBF24")}>Mid</th><th style={tS("#F87171")}>Ask</th><th style={{...tS(),borderRight:"1px solid #334155"}}>D/D</th>
              <th style={tS("#4ADE80")}>Bid</th><th style={tS("#34D399")}>Mid</th><th style={tS("#F87171")}>Ask</th><th style={{...tS(),borderRight:"1px solid #334155"}}>D/D</th>
              <th style={tS("#FB923C")}>%</th><th style={{...tS(),borderRight:"1px solid #334155"}}>D/D</th>
              <th style={tS("#C084FC")}>bp</th><th style={{...tS(),borderRight:"1px solid #334155"}}>D/D</th>
              <th style={tS("#38BDF8")}>Pip</th><th style={{...tS("#38BDF8"),borderRight:"1px solid #334155"}}>IY</th>
              <th style={tS("#A78BFA")}>Pip</th><th style={tS("#A78BFA")}>IY</th>
            </tr></thead>
            <tbody>{filt.map((r,i)=>{const sp=r.month===0,mj=[0,1,2,3,6,9,12,24].includes(r.month);const bg=sp?"#1a2744":(i%2===0?"#0F172A":"#111827");const tc=r.interp?"#475569":(mj?"#F8FAFC":"#94A3B8");
              return(<tr key={r.tenor} style={{background:bg,borderBottom:[3,6,9,12].includes(r.month)?"1px solid #334155":"none",cursor:"pointer"}} onDoubleClick={()=>dblR(r.tenor,r.spM,true,r.month)}>
                <td style={{...cS(tc,mj),textAlign:"left",borderRight:"1px solid #1E293B"}}>{r.tenor}{r.interp?"*":""}</td>
                <td style={cS("#475569")}>{fD(r.valDate)}</td><td style={cS("#475569")}>{fD(r.fixDate)}</td><td style={{...cS("#475569"),borderRight:"1px solid #334155"}}>{r.dT||"—"}</td>
                <td style={cS("#4ADE80")}>{F(r.bT,dp)}</td><td style={cS("#F87171")}>{F(r.aT,dp)}</td><td style={{...cS("#FBBF24",true),borderRight:"1px solid #334155"}}>{F(r.mT,dp)}</td>
                <td style={cS("#4ADE80")}>{sp?"—":FP(r.spB,pdp)}</td><td style={cS("#FBBF24",true)}>{sp?"—":FP(r.spM,pdp)}</td><td style={cS("#F87171")}>{sp?"—":FP(r.spA,pdp)}</td>
                <td style={{...cS(CC(r.pipChg)),borderRight:"1px solid #334155",background:sp?"transparent":HB(r.pipChg,mPC)}}>{sp?"—":FP(r.pipChg,pdp)}</td>
                <td style={cS("#4ADE80")}>{sp?"—":F(r.iyB,2)}</td><td style={cS("#34D399",true)}>{sp?"—":F(r.iyM,2)}</td><td style={cS("#F87171")}>{sp?"—":F(r.iyA,2)}</td>
                <td style={{...cS(CC(r.iyChg)),borderRight:"1px solid #334155",background:sp?"transparent":HB(r.iyChg,mIC)}}>{sp?"—":FP(r.iyChg,2)}</td>
                <td style={cS("#FB923C")}>{sp?"—":F(r.sofT,2)}</td><td style={{...cS(CC(r.sofChg)),borderRight:"1px solid #334155",background:sp?"transparent":HB(r.sofChg,.005)}}>{sp?"—":FP(r.sofChg*100,1)}</td>
                <td style={cS(r.basisT!=null&&r.basisT>=0?"#C084FC":"#F472B6",true)}>{sp||r.basisT==null?"—":FP(r.basisT*100,1)}</td>
                <td style={{...cS(CC(r.basChg)),borderRight:"1px solid #334155",background:sp?"transparent":HB(r.basChg,mBC)}}>{sp?"—":FP(r.basChg*100,1)}</td>
                <td style={{...cS(r.carryP>=0?"#38BDF8":"#F472B6"),background:sp?"transparent":HB(r.carryP,mCP)}}>{sp?"—":FP(r.carryP,pdp)}</td>
                <td style={{...cS(r.carryY>=0?"#38BDF8":"#F472B6"),borderRight:"1px solid #334155",background:sp?"transparent":HB(r.carryY||0,mCY)}}>{sp?"—":FP(r.carryY,2)}</td>
                <td style={{...cS(r.rollP>=0?"#A78BFA":"#F472B6"),background:r.month<2?"transparent":HB(r.rollP,mRP)}}>{r.month<2?"—":FP(r.rollP,pdp)}</td>
                <td style={cS(r.rollY>=0?"#A78BFA":"#F472B6")}>{r.month<2?"—":FP(r.rollY,2)}</td>
              </tr>);})}</tbody></table></div>

        <div style={{fontSize:8.5,fontWeight:700,color:"#F8FAFC",marginBottom:2}}>1M FORWARD-FORWARD CHAIN</div>
        <div style={{overflowX:"auto",overflowY:"auto",maxHeight:"28vh",borderRadius:5,border:"1px solid #1E293B"}}>
          <table style={{borderCollapse:"collapse",width:"100%",minWidth:1200}}>
            <thead><tr><th style={{...tS(),textAlign:"left",minWidth:55}}>Period</th><th style={tS()}>Near Val</th><th style={tS()}>Far Val</th><th style={tS()}>Days</th><th style={tS("#4ADE80")}>Bid</th><th style={tS("#FBBF24")}>Mid</th><th style={tS("#F87171")}>Ask</th><th style={tS()}>D/D</th><th style={tS()}>Pts/D</th><th style={tS("#4ADE80")}>Iy Bid</th><th style={tS("#34D399")}>Iy Mid</th><th style={tS("#F87171")}>Iy Ask</th><th style={tS()}>Iy D/D</th><th style={tS()}>Iy bp/d</th><th style={tS("#FB923C")}>Fwd SOFR</th><th style={tS("#C084FC")}>Basis</th></tr></thead>
            <tbody>{filt.filter(r=>r.month>0).map((r,i)=>{const p=i>0?filt.filter(x=>x.month>0)[i-1]:null;const label=r.month===1?"SP×1M":p?`${p.tenor}×${r.tenor}`:`SP×${r.tenor}`;const fwdD=p?r.dT-p.dT:r.dT;const ppd=fwdD>0?r.ffM/fwdD:0;const mj=[1,2,3,6,9,12,24].includes(r.month);
              return(<tr key={r.tenor} style={{background:i%2===0?"#0F172A":"#111827",borderBottom:[3,6,9,12].includes(r.month)?"1px solid #334155":"none",cursor:"pointer"}} onDoubleClick={()=>dblR(label,r.ffM,true,r.month)}>
                <td style={{...cS(r.interp?"#475569":(mj?"#F8FAFC":"#94A3B8"),mj),textAlign:"left"}}>{label}{r.interp?"*":""}</td>
                <td style={cS("#475569")}>{fD(p?p.valDate:ad.TENOR_DATES[0]?.valDate)}</td><td style={cS("#475569")}>{fD(r.valDate)}</td><td style={cS("#475569",false,true)}>{fwdD}</td>
                <td style={cS("#4ADE80")}>{FP(r.ffB,pdp)}</td><td style={cS("#FBBF24",true)}>{FP(r.ffM,pdp)}</td><td style={cS("#F87171")}>{FP(r.ffA,pdp)}</td>
                <td style={{...cS(CC(r.ffChg)),background:HB(r.ffChg,mFC)}}>{FP(r.ffChg,pdp)}</td><td style={cS("#64748B",false,true)}>{F(ppd,2)}</td>
                <td style={cS("#4ADE80")}>{F(r.ffIyB,2)}</td><td style={cS("#34D399",true)}>{F(r.ffIyM,2)}</td><td style={cS("#F87171")}>{F(r.ffIyA,2)}</td>
                <td style={{...cS(CC(r.ffIyChg)),background:HB(r.ffIyChg,.1)}}>{FP(r.ffIyChg,2)}</td><td style={cS("#64748B")}>{r.ffIyBpD!=null?F(r.ffIyBpD,2):"—"}</td>
                <td style={cS("#FB923C")}>{r.ffSofr!=null?F(r.ffSofr,2):"—"}</td><td style={cS(r.ffBasis!=null&&r.ffBasis>=0?"#C084FC":"#F472B6")}>{r.ffBasis!=null?FP(r.ffBasis*100,1):"—"}</td>
              </tr>);})}</tbody></table></div>
      </>)}

      {/* SPREADS TAB */}
      {tab==="spreads"&&(<div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:6}}>
          <PChart traces={[{x:anchors.map(s=>s.label),y:anchors.map(s=>s.pM),type:"bar",name:"Mid",marker:{color:"#10B981"}},{x:anchors.map(s=>s.label),y:anchors.map(s=>s.chg),type:"scatter",mode:"lines+markers",name:"D/D",line:{color:"#FBBF24"},yaxis:"y2"}]} layout={{title:{text:`${cfg.pair} Interbank Anchors`,font:{size:10}},yaxis2:{overlaying:"y",side:"right",gridcolor:"transparent",tickfont:{size:8}}}} height={185}/>
          <PChart traces={[{x:qFF.map(s=>s.label),y:qFF.map(s=>s.pM),type:"bar",name:"Mid",marker:{color:"#8B5CF6"}}]} layout={{title:{text:`${cfg.pair} ${cfg.kind==="NDF"?"3M Fwd-Fwd":"Fwd-Fwd"} Rolls`,font:{size:10}}}} height={185}/>
        </div>
        {cfg.kind==="NDF"&&<SprTbl spreads={anchors} title={`${cfg.pair} INTERBANK ANCHOR SPREADS`} color="#10B981" mx={mSC} onDbl={dblR} pdp={pdp}/>}
        {cfg.kind==="NDF"&&<SprTbl spreads={qFF} title={`${cfg.pair} 3M FORWARD-FORWARD GAPS`} color="#A78BFA" mx={mSC} onDbl={dblR} pdp={pdp}/>}
        <SprTbl spreads={spSpr} title={`${cfg.pair} SPOT-START SPREADS`} color="#60A5FA" mx={mSC} onDbl={dblR} pdp={pdp}/>
        {cfg.kind==="DELIVERABLE"&&<SprTbl spreads={qFF} title={`${cfg.pair} FWD-FWD SPREADS`} color="#A78BFA" mx={mSC} onDbl={dblR} pdp={pdp}/>}
        <SprTbl spreads={immSpr} title={`${cfg.pair} IMM ROLL SPREADS`} color="#F59E0B" mx={mSC} onDbl={dblR} pdp={pdp}/>
      </div>)}

      {/* IMM TAB */}
      {tab==="imm"&&(<div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:6}}>
          <PChart traces={[{x:immR.map(r=>r.tenor.split(" ")[1]),y:immR.map(r=>r.spM),type:"bar",name:"SwPts",marker:{color:"#3B82F6"}},{x:immR.map(r=>r.tenor.split(" ")[1]),y:immR.map(r=>r.iyM),type:"scatter",mode:"lines+markers",name:"Impl%",line:{color:"#10B981"},yaxis:"y2"}]}
            layout={{title:{text:`${cfg.pair} IMM Outrights`,font:{size:10}},yaxis:{title:"Pips"},yaxis2:{title:"%",overlaying:"y",side:"right",gridcolor:"transparent"}}} height={185}/>
          <PChart traces={[{x:immSpr.map(s=>s.label),y:immSpr.map(s=>s.pM),type:"bar",name:"Roll Pips",marker:{color:"#F59E0B"}}]}
            layout={{title:{text:`${cfg.pair} IMM Roll Spreads`,font:{size:10}}}} height={185}/>
        </div>
        <div style={{background:"#131C2E",borderRadius:5,padding:6,marginBottom:6}}>
          <div style={{fontSize:9.5,fontWeight:800,color:"#FB923C",marginBottom:3}}>{cfg.pair} IMM OUTRIGHTS</div>
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
            </tr>))}</tbody></table></div></div>
        <SprTbl spreads={immSpr} title={`${cfg.pair} IMM ROLL SPREADS`} color="#F59E0B" mx={mSC} onDbl={dblR} pdp={pdp}/>
      </div>)}

      {tab==="tools"&&<ToolsPanel ad={ad} onDbl={dblR} ccy={ccy}/>}
      {tab==="broker"&&<BrokerMon ad={ad} liveQuotes={liveQuotes} liveOn={liveOn}/>}

      <div style={{marginTop:4,fontSize:6.5,color:"#334155",display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:2}}>
        <div>* = Calculated: ImplYld=((F/S)(1+SOFR×d/360)-1)×360/d · FwdFwd Impl=compounded from outrights · Spread bid=far_bid−near_ask · Weekly tenors interpolated (Fritsch-Carlson monotone cubic)</div>
        <div>IMM=3rd Wed Mar/Jun/Sep/Dec · Fix=T-2 biz</div>
      </div>
    </div>);
}

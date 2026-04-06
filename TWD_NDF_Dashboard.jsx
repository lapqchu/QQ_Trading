import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import * as Plotly from "plotly";

// ═══════════════════════════════════════════════════════════════════════
// RAW LSEG DATA — Multi-currency NDF (refreshed Apr 3 2026 close)
// Fields marked [LSEG] are sourced; [CALC] are computed
// ═══════════════════════════════════════════════════════════════════════
const SPOT_DATE = new Date(2026, 3, 8);
const TRADE_TS = "03-Apr-2026 17:30 SGT";
const PREV_TS = "02-Apr-2026 17:30 SGT";

// Per-currency config: pipFactor = multiplier to convert outright diff to "pips"
// dp = decimal places for outright display, maxT = max tenor months, knownM = available anchors
const CCY_CONFIG = {
  TWD:{pair:"USDTWD",pipFactor:1e3,dp:3,pipDp:1,maxT:24,knownM:[0,1,2,3,6,9,12,24]},
  KRW:{pair:"USDKRW",pipFactor:1e2,dp:3,pipDp:1,maxT:24,knownM:[0,1,2,3,6,9,12,24]},
  INR:{pair:"USDINR",pipFactor:1e4,dp:4,pipDp:1,maxT:12,knownM:[0,1,3,6,12]},
  IDR:{pair:"USDIDR",pipFactor:1e0,dp:1,pipDp:1,maxT:12,knownM:[0,1,3,6,12]},
  PHP:{pair:"USDPHP",pipFactor:1e3,dp:3,pipDp:1,maxT:12,knownM:[0,1,3,6,12]},
  CNY:{pair:"USDCNY",pipFactor:1e4,dp:4,pipDp:1,maxT:1,knownM:[0,1]},
  MYR:{pair:"USDMYR",pipFactor:1e4,dp:4,pipDp:1,maxT:1,knownM:[0,1]},
};
const CCY_LIST = Object.keys(CCY_CONFIG);

const CCY_DATA = {  // [LSEG] historical_pricing_summaries {CCY}{x}NDFOR= (Apr 3 close)
  TWD:{
    spot:{T:{b:31.980,a:32.010},T1:{b:31.936,a:31.966},days:{T:0,T1:0}},
    1:{T:{b:32.102,a:32.122},T1:{b:32.061,a:32.105},days:{T:30,T1:30}},
    2:{T:{b:32.140,a:32.151},T1:{b:32.027,a:32.037},days:{T:61,T1:61}},
    3:{T:{b:32.152,a:32.162},T1:{b:32.039,a:32.049},days:{T:91,T1:91}},
    6:{T:{b:32.158,a:32.173},T1:{b:32.044,a:32.059},days:{T:183,T1:183}},
    9:{T:{b:32.145,a:32.175},T1:{b:32.022,a:32.052},days:{T:275,T1:275}},
    12:{T:{b:32.130,a:32.170},T1:{b:32.007,a:32.047},days:{T:365,T1:365}},
    24:{T:{b:32.225,a:32.346},T1:{b:32.122,a:32.242},days:{T:733,T1:733}},
  },
  KRW:{
    spot:{T:{b:1510.56,a:1511.15},T1:{b:1509.80,a:1510.68},days:{T:0,T1:0}},
    1:{T:{b:1509.72,a:1510.72},T1:{b:1508.40,a:1509.60},days:{T:30,T1:30}},
    2:{T:{b:1507.89,a:1508.89},T1:{b:1507.22,a:1508.22},days:{T:62,T1:63}},
    3:{T:{b:1506.67,a:1507.67},T1:{b:1505.73,a:1506.73},days:{T:91,T1:91}},
    6:{T:{b:1501.77,a:1503.27},T1:{b:1500.70,a:1502.10},days:{T:183,T1:183}},
    9:{T:{b:1497.44,a:1498.74},T1:{b:1496.67,a:1497.97},days:{T:275,T1:275}},
    12:{T:{b:1495.07,a:1496.57},T1:{b:1494.20,a:1495.60},days:{T:365,T1:365}},
    24:{T:{b:1489.57,a:1491.17},T1:{b:1489.20,a:1492.10},days:{T:731,T1:731}},
  },
  INR:{
    spot:{T:{b:92.690,a:92.730},T1:{b:92.952,a:93.004},days:{T:0,T1:0}},
    1:{T:{b:93.6449,a:93.6649},T1:{b:93.8732,a:93.8932},days:{T:30,T1:30}},
    3:{T:{b:94.9900,a:95.0400},T1:{b:95.2500,a:95.3000},days:{T:91,T1:91}},
    6:{T:{b:96.1700,a:96.2200},T1:{b:96.4300,a:96.4800},days:{T:183,T1:183}},
    12:{T:{b:97.8600,a:97.9700},T1:{b:98.3132,a:98.3533},days:{T:365,T1:366}},
  },
  IDR:{
    spot:{T:{b:16990,a:16999},T1:{b:16990,a:16999},days:{T:0,T1:0}},
    1:{T:{b:17014,a:17024},T1:{b:16993,a:17004},days:{T:30,T1:30}},
    3:{T:{b:17053,a:17067},T1:{b:17032,a:17047},days:{T:91,T1:91}},
    6:{T:{b:17113,a:17133},T1:{b:17092,a:17113},days:{T:183,T1:183}},
    12:{T:{b:17251,a:17275},T1:{b:17228,a:17255},days:{T:365,T1:365}},
  },
  PHP:{
    spot:{T:{b:60.168,a:60.283},T1:{b:60.280,a:60.408},days:{T:0,T1:0}},
    1:{T:{b:60.280,a:60.300},T1:{b:60.350,a:60.370},days:{T:30,T1:30}},
    3:{T:{b:60.530,a:60.580},T1:{b:60.600,a:60.650},days:{T:91,T1:91}},
    6:{T:{b:60.790,a:60.890},T1:{b:60.860,a:60.960},days:{T:183,T1:183}},
    12:{T:{b:61.230,a:61.380},T1:{b:61.300,a:61.450},days:{T:365,T1:365}},
  },
  CNY:{
    spot:{T:{b:6.8824,a:6.8828},T1:{b:6.8856,a:6.8875},days:{T:0,T1:0}},
    1:{T:{b:6.8850,a:6.8870},T1:{b:6.8884,a:6.8904},days:{T:30,T1:30}},
  },
  MYR:{
    spot:{T:{b:4.0280,a:4.0340},T1:{b:4.0360,a:4.0420},days:{T:0,T1:0}},
    1:{T:{b:4.0280,a:4.0290},T1:{b:4.0313,a:4.0388},days:{T:30,T1:30}},
  },
};

const RAW_SOFR = {  // [LSEG] USDSROIS{x}= — always default source (USD base, shared across all NDF pairs)
  1:{T:3.6600,T1:3.6596},2:{T:3.6695,T1:3.6706},3:{T:3.6751,T1:3.6774},
  6:{T:3.6882,T1:3.6906},9:{T:3.7041,T1:3.7046},12:{T:3.7092,T1:3.7092},
  18:{T:3.6660,T1:3.6660},24:{T:3.6309,T1:3.6315},
};

// Broker contributor RICs — to be populated once user confirms exact Workspace suffixes
// Expected format on LSEG: TWD1MNDFOR=<contrib>  e.g. =TRAD / =TRDN / =ICAP / =BGCP / =TPTS
// Leave empty until wired to a realtime feed (historical_pricing_summaries does NOT return
// daily bars for broker-contributed RICs — they are realtime snap RICs only).
const BROKER_NAMES=["ICAP","BGCP","TRAD","TPTS"];
const BROKER_RICS={}; // { ICAP:{ "1M":"TWD1MNDFOR=ICAP", "3M":... }, ... }  populate when confirmed

// Market-traded tenor template — filtered per-ccy based on knownM availability
const BROKER_TENOR_TEMPLATE = [
  {label:"1M Tomfix",type:"outright",m:1},
  {label:"1Wx1M",type:"spread",near:0,far:1,nearLabel:"1W",farLabel:"1M"},
  {label:"1Mx2M",type:"spread",near:1,far:2},
  {label:"1Mx3M",type:"spread",near:1,far:3},
  {label:"1Mx6M",type:"spread",near:1,far:6},
  {label:"1Mx9M",type:"spread",near:1,far:9},
  {label:"1Mx12M",type:"spread",near:1,far:12},
  {label:"12Mx18M",type:"spread",near:12,far:18},
  {label:"12Mx2Y",type:"spread",near:12,far:24},
  {label:"3Mx6M",type:"spread",near:3,far:6},
  {label:"6Mx9M",type:"spread",near:6,far:9},
  {label:"9Mx12M",type:"spread",near:9,far:12},
];
function getBrokerTenors(ccy){
  const cfg=CCY_CONFIG[ccy];
  return BROKER_TENOR_TEMPLATE.filter(t=>{
    if(t.type==="outright")return cfg.knownM.includes(t.m);
    return t.far<=cfg.maxT;
  });
}

// ═══════════════════════════════════════════════════════════════════════
// DATE UTILITIES — Weekend-adjusted (TODO: use LSEG calendar for holidays)
// ═══════════════════════════════════════════════════════════════════════
function thirdWed(y,m){const d=new Date(y,m,1);const dow=d.getDay();const fw=dow<=3?(3-dow+1):(10-dow+1);return new Date(y,m,fw+14);}
function daysBtwn(a,b){return Math.round((b-a)/864e5);}
function addMon(base,m){const d=new Date(base);d.setMonth(d.getMonth()+m);if(d.getDay()===6)d.setDate(d.getDate()+2);if(d.getDay()===0)d.setDate(d.getDate()+1);return d;}
function bizBefore(dt,n){const d=new Date(dt);let c=0;while(c<n){d.setDate(d.getDate()-1);if(d.getDay()!==0&&d.getDay()!==6)c++;}return d;}
function dateFromSpot(days){const d=new Date(SPOT_DATE.getTime()+days*864e5);if(d.getDay()===6)d.setDate(d.getDate()+2);if(d.getDay()===0)d.setDate(d.getDate()+1);return d;}
const MN=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function fD(d){return d?`${String(d.getDate()).padStart(2,"0")}-${MN[d.getMonth()]}-${String(d.getFullYear()).slice(2)}`:"—";}

function buildIMMDates(){
  const qs=[[2026,5],[2026,8],[2026,11],[2027,2],[2027,5],[2027,8],[2027,11],[2028,2]];
  const lb=["IMM1 Jun26","IMM2 Sep26","IMM3 Dec26","IMM4 Mar27","IMM5 Jun27","IMM6 Sep27","IMM7 Dec27","IMM8 Mar28"];
  return qs.map(([y,m],i)=>{const vd=thirdWed(y,m);return{label:lb[i],days:daysBtwn(SPOT_DATE,vd),valDate:vd,fixDate:bizBefore(vd,2)};});
}
const IMM_DATES=buildIMMDates();
function buildTenorDates(){const d={};for(let m=0;m<=24;m++){const vd=m===0?SPOT_DATE:addMon(SPOT_DATE,m);d[m]={valDate:vd,fixDate:bizBefore(vd,2)};}return d;}
const TENOR_DATES=buildTenorDates();

// ═══════════════════════════════════════════════════════════════════════
// MONOTONE CUBIC HERMITE (Fritsch-Carlson)
// ═══════════════════════════════════════════════════════════════════════
function mcI(xs,ys){
  const n=xs.length;if(n<2)return()=>ys[0]||0;
  const dx=[],dy=[],m=[];for(let i=0;i<n-1;i++){dx.push(xs[i+1]-xs[i]);dy.push(ys[i+1]-ys[i]);m.push(dy[i]/dx[i]);}
  const c1=[m[0]];for(let i=1;i<n-1;i++){if(m[i-1]*m[i]<=0)c1.push(0);else{const a=(1+(dx[i]/(dx[i-1]+dx[i])))/3;c1.push(m[i-1]*m[i]/(a*m[i]+(1-a)*m[i-1]));}}c1.push(m[n-2]);
  for(let i=0;i<n-1;i++){if(Math.abs(m[i])<1e-15){c1[i]=0;c1[i+1]=0;}else{const al=c1[i]/m[i],be=c1[i+1]/m[i],s=al*al+be*be;if(s>9){const t=3/Math.sqrt(s);c1[i]=t*al*m[i];c1[i+1]=t*be*m[i];}}}
  return x=>{if(x<=xs[0])return ys[0];if(x>=xs[n-1])return ys[n-1];let i=0;for(let j=0;j<n-1;j++){if(x>=xs[j])i=j;}const h=dx[i],t=(x-xs[i])/h;return(1+2*t)*(1-t)*(1-t)*ys[i]+t*(1-t)*(1-t)*h*c1[i]+t*t*(3-2*t)*ys[i+1]+t*t*(t-1)*h*c1[i+1];};
}

// ═══════════════════════════════════════════════════════════════════════
// FORMATTING / COLOR
// ═══════════════════════════════════════════════════════════════════════
const F=(v,dp=3)=>v!=null?v.toFixed(dp):"—";
const FP=(v,dp=1)=>{if(v==null)return"—";const s=v.toFixed(dp);return v>0.0001?`+${s}`:s;};
const CC=v=>{if(v==null||Math.abs(v)<0.001)return"#64748B";return v>0?"#F87171":"#4ADE80";};
function HB(val,mx,pos=[59,130,246],neg=[244,114,182]){if(val==null||Math.abs(val)<0.0005)return"transparent";const t=Math.min(Math.abs(val)/(mx||1),1);const c=val>0?pos:neg;return`rgba(${c[0]},${c[1]},${c[2]},${.08+t*.5})`;}
const cS=(color,bold,border,bg)=>({padding:"3px 4px",fontSize:9,color:color||"#CBD5E1",fontFamily:"'JetBrains Mono','Fira Code',monospace",fontWeight:bold?700:400,textAlign:"right",borderRight:border?"1px solid #1E293B":"none",background:bg||"transparent",whiteSpace:"nowrap"});
const tS=(color)=>({padding:"2px 4px",fontSize:7,fontWeight:800,color:color||"#64748B",textAlign:"right",position:"sticky",top:0,background:"#0F172A",zIndex:2,borderBottom:"2px solid #334155",whiteSpace:"nowrap",letterSpacing:".04em",textTransform:"uppercase"});
const sS=(color)=>({padding:"1px 3px",fontSize:6,fontWeight:900,color,textAlign:"center",position:"sticky",top:0,zIndex:3,background:"#0F172A",borderBottom:"1px solid #334155",letterSpacing:".1em",textTransform:"uppercase",borderLeft:"1px solid #1E293B"});

// ═══════════════════════════════════════════════════════════════════════
// HISTORICAL + INDICATORS + BACKTESTING
// ═══════════════════════════════════════════════════════════════════════
function genHist(val,n=252){const v=.002,d=new Array(n);d[n-1]=val;for(let i=n-2;i>=0;i--){d[i]=d[i+1]*(1-v*((Math.random()-.5)*3));}const pts=[];const end=new Date(2026,3,2);let dt=new Date(end);for(let i=n-1;i>=0;i--){pts.unshift({date:new Date(dt),value:d[i]});dt.setDate(dt.getDate()-1);while(dt.getDay()===0||dt.getDay()===6)dt.setDate(dt.getDate()-1);}return pts;}
function calcSMA(d,p){const r=[];for(let i=0;i<d.length;i++){if(i<p-1){r.push(null);continue;}let s=0;for(let j=i-p+1;j<=i;j++)s+=d[j].value;r.push(s/p);}return r;}
function calcEMA(d,p){const k=2/(p+1),r=[d[0].value];for(let i=1;i<d.length;i++)r.push(d[i].value*k+r[i-1]*(1-k));return r;}
function calcRSI(d,p=14){const r=[null];for(let i=1;i<d.length;i++){const ch=[];for(let j=Math.max(1,i-p+1);j<=i;j++)ch.push(d[j].value-d[j-1].value);const g=ch.filter(c=>c>0).reduce((a,b)=>a+b,0)/p;const l=Math.abs(ch.filter(c=>c<0).reduce((a,b)=>a+b,0))/p;r.push(l===0?100:100-100/(1+g/l));}return r;}
function calcBB(d,p=20,mult=2){const mid=calcSMA(d,p),u=[],lo=[];for(let i=0;i<d.length;i++){if(mid[i]==null){u.push(null);lo.push(null);continue;}let ss=0;for(let j=i-p+1;j<=i;j++)ss+=(d[j].value-mid[i])**2;const sd=Math.sqrt(ss/p);u.push(mid[i]+mult*sd);lo.push(mid[i]-mult*sd);}return{mid,upper:u,lower:lo};}
function calcMACD(d){const e12=calcEMA(d,12),e26=calcEMA(d,26);const line=e12.map((v,i)=>v-e26[i]);const sd=line.map((v,i)=>({value:v,date:d[i].date}));const sig=calcEMA(sd,9);const hist=line.map((v,i)=>v-sig[i]);return{line,signal:sig,hist};}
function calcStats(h,sigN=20){const v=h.map(x=>x.value),n=v.length,so=[...v].sort((a,b)=>a-b);const mean=v.reduce((a,b)=>a+b,0)/n,vari=v.reduce((a,b)=>a+(b-mean)**2,0)/n,sd=Math.sqrt(vari);const skew=sd>0?v.reduce((a,b)=>a+((b-mean)/sd)**3,0)/n:0;const kurt=sd>0?v.reduce((a,b)=>a+((b-mean)/sd)**4,0)/n-3:0;const cur=v[n-1],pctR=so.filter(x=>x<=cur).length/n*100;const ranges={};[[1,"1D"],[5,"1W"],[22,"1M"],[66,"3M"],[132,"6M"],[252,"1Y"]].forEach(([lb,l])=>{const sl=v.slice(Math.max(0,n-lb));ranges[l]={high:Math.max(...sl),low:Math.min(...sl)};});
  // Sigma-move: today's move expressed in std devs of past N-day daily returns
  let sigmaMove=null,dayChg=null,rollSd=null;
  if(n>=sigN+2){dayChg=v[n-1]-v[n-2];const diffs=[];for(let i=n-sigN-1;i<n-1;i++)diffs.push(v[i+1]-v[i]);const dm=diffs.reduce((a,b)=>a+b,0)/diffs.length;rollSd=Math.sqrt(diffs.reduce((a,b)=>a+(b-dm)**2,0)/diffs.length);sigmaMove=rollSd>0?dayChg/rollSd:null;}
  // Z-score of deviation from SMA(sigN)
  let devMA=null,zDev=null,smaN=null;
  if(n>=sigN){let s=0;for(let i=n-sigN;i<n;i++)s+=v[i];smaN=s/sigN;devMA=cur-smaN;let ss=0;for(let i=n-sigN;i<n;i++)ss+=(v[i]-smaN)**2;const sdN=Math.sqrt(ss/sigN);zDev=sdN>0?devMA/sdN:null;}
  return{mean,sd,skew,kurt,median:so[Math.floor(n/2)],p25:so[Math.floor(n*.25)],p75:so[Math.floor(n*.75)],min:so[0],max:so[n-1],current:cur,pctR,ranges,sigmaMove,dayChg,rollSd,devMA,zDev,smaN,sigN};}

// Rolling z-score of deviation from SMA — used for mean-reversion strategy
function calcZDev(d,p=20){const r=new Array(d.length).fill(null);for(let i=p-1;i<d.length;i++){let s=0;for(let j=i-p+1;j<=i;j++)s+=d[j].value;const m=s/p;let ss=0;for(let j=i-p+1;j<=i;j++)ss+=(d[j].value-m)**2;const sd=Math.sqrt(ss/p);r[i]=sd>0?(d[i].value-m)/sd:null;}return r;}

// BACKTESTING
const STRAT_DESCS = {
  "SMA(20)x(50) Cross": "Buy when SMA(20) crosses above SMA(50), sell when it crosses below. Classic trend-following strategy using two moving average periods.",
  "Price > SMA(20)": "Long when price is above SMA(20), short when below. Simple momentum filter using a single moving average as trend indicator.",
  "EMA(12)x(26) Cross": "Buy when EMA(12) crosses above EMA(26), sell when it crosses below. Faster-reacting than SMA crossover due to exponential weighting.",
  "BB Mean Reversion": "Buy when price touches lower Bollinger Band (2 std dev below SMA20), sell when it touches upper band. Mean-reversion strategy betting on range containment.",
  "RSI(14) OB/OS": "Buy when RSI(14) drops below 30 (oversold), sell when it rises above 70 (overbought). Contrarian indicator-based reversal strategy.",
  "Z-Score Mean Rev(20)": "Rolling z-score of deviation from SMA(20). Buy when z < -2 (oversold), sell when z > +2 (overbought), exit near zero. Parametric mean-reversion.",
};

function backtest(hist, lookbackDays){
  const d=hist.slice(Math.max(0,hist.length-lookbackDays));
  const rets=d.map((x,i)=>i===0?0:(x.value-d[i-1].value)/d[i-1].value);
  const sma20=calcSMA(d,20),sma50=calcSMA(d,50),ema12=calcEMA(d,12),ema26=calcEMA(d,26);
  const bb=calcBB(d),rsiArr=calcRSI(d),zArr=calcZDev(d,20);
  const dates=d.map(x=>x.date);

  function run(name,sigFn,minData){
    if(d.length<minData)return{name,unavail:true,reason:`Needs ${minData}+ data points, have ${d.length}`};
    let pos=0;const sr=[];
    for(let i=1;i<d.length;i++){const sig=sigFn(i);if(sig===1&&pos<=0)pos=1;else if(sig===-1&&pos>=0)pos=-1;sr.push(pos*rets[i]);}
    const n=sr.length;if(n<3)return{name,unavail:true,reason:"Too few trades generated"};
    const avg=sr.reduce((a,b)=>a+b,0)/n;const std=Math.sqrt(sr.reduce((a,b)=>a+(b-avg)**2,0)/n);
    const sharpe=std>0?(avg/std)*Math.sqrt(252):0;const cumRet=sr.reduce((a,b)=>a*(1+b),1)-1;
    let maxDD=0,peak=1,eq=1;const eqC=[1];
    for(const r of sr){eq*=(1+r);eqC.push(eq);if(eq>peak)peak=eq;const dd=(peak-eq)/peak;if(dd>maxDD)maxDD=dd;}
    const rollSh=[];for(let i=0;i<sr.length;i++){if(i<19){rollSh.push(null);continue;}const sl=sr.slice(i-19,i+1);const m=sl.reduce((a,b)=>a+b,0)/20;const s=Math.sqrt(sl.reduce((a,b)=>a+(b-m)**2,0)/20);rollSh.push(s>0?(m/s)*Math.sqrt(252):0);}
    return{name,sharpe,cumRet,maxDD,winRate:sr.filter(r=>r>0).length/n,eqC,rollSh,dates:dates.slice(1),unavail:false};
  }

  const strats=[
    run("SMA(20)x(50) Cross",i=>sma20[i]!=null&&sma50[i]!=null?(sma20[i]>sma50[i]?1:-1):0,55),
    run("Price > SMA(20)",i=>sma20[i]!=null?(d[i].value>sma20[i]?1:-1):0,25),
    run("EMA(12)x(26) Cross",i=>(ema12[i]>ema26[i]?1:-1),30),
    run("BB Mean Reversion",i=>{if(bb.lower[i]==null)return 0;if(d[i].value<=bb.lower[i])return 1;if(d[i].value>=bb.upper[i])return -1;return 0;},25),
    run("RSI(14) OB/OS",i=>{if(rsiArr[i]==null)return 0;if(rsiArr[i]<30)return 1;if(rsiArr[i]>70)return -1;return 0;},20),
    run("Z-Score Mean Rev(20)",i=>{if(zArr[i]==null)return 0;if(zArr[i]<=-2)return 1;if(zArr[i]>=2)return -1;return 0;},25),
  ];
  strats.sort((a,b)=>(b.sharpe||0)-(a.sharpe||0));
  return strats;
}

// ═══════════════════════════════════════════════════════════════════════
// DATA ENGINE — CORRECTED
// ═══════════════════════════════════════════════════════════════════════
const mid=(b,a)=>(b+a)/2;

function implYld(fwd,spot,sofr,days){
  if(!days||days<=0)return null;
  return((fwd/spot)*(1+sofr/100*days/360)-1)*360/days*100;
}
function fwdFwdIy(iyNear,dNear,iyFar,dFar){
  if(!dNear||!dFar||dFar<=dNear||iyNear==null||iyFar==null)return null;
  return((1+(iyFar/100)*dFar/360)/(1+(iyNear/100)*dNear/360)-1)*360/(dFar-dNear)*100;
}

function buildAllData(ccy="TWD",selBr=[]){
  const cfg=CCY_CONFIG[ccy];const RAW_NDF=CCY_DATA[ccy];const knownM=cfg.knownM;const maxT=cfg.maxT;const PF=cfg.pipFactor;
  const sofrM=[1,2,3,6,9,12,18,24].filter(m=>m<=Math.max(maxT,24));

  // Real LSEG composite only — no synthetic broker adjustments.
  // selBr is currently ignored; will be used once real per-broker RICs are wired.
  function getE(tk,dk){
    return tk==="spot"?RAW_NDF.spot[dk]:RAW_NDF[tk][dk];
  }
  // SOFR always from LSEG default (no broker offset)
  function anchorSOFR(dk){const mo=[],va=[];sofrM.forEach(m=>{mo.push(m);va.push(RAW_SOFR[m][dk]);});return{mo,va};}

  function anchorNDF(dk){const d=[],mi=[],bi=[],ai=[];knownM.forEach(m=>{const k=m===0?"spot":m;const e=getE(k,dk);d.push(m===0?0:RAW_NDF[m].days[dk]);mi.push(mid(e.b,e.a));bi.push(e.b);ai.push(e.a);});return{d,mi,bi,ai};}

  const nT=anchorNDF("T"),nT1=anchorNDF("T1"),sT=anchorSOFR("T"),sT1=anchorSOFR("T1");
  const iMT=mcI(nT.d,nT.mi),iBT=mcI(nT.d,nT.bi),iAT=mcI(nT.d,nT.ai);
  const iMT1=mcI(nT1.d,nT1.mi),iBT1=mcI(nT1.d,nT1.bi),iAT1=mcI(nT1.d,nT1.ai);
  const iDT=mcI(knownM,nT.d),iDT1=mcI(knownM,nT1.d);
  const iST=mcI(sT.mo,sT.va),iST1=mcI(sT1.mo,sT1.va);
  const sMT=mid(nT.bi[0],nT.ai[0]),sMT1=mid(nT1.bi[0],nT1.ai[0]);
  const sBT=nT.bi[0],sAT=nT.ai[0],sBT1=nT1.bi[0],sAT1=nT1.ai[0];

  function getRow(month,daysOvr,label,immVD){
    const isK=knownM.includes(month)&&!daysOvr;
    const dT=daysOvr||Math.round(iDT(month)),dT1=daysOvr?Math.round(iDT1(month)+(daysOvr-iDT(month))):Math.round(iDT1(month));
    let bT,aT,mT,bT1,aT1,mT1;
    if(isK&&month>0){const eT=getE(month,"T"),eT1=getE(month,"T1");bT=eT.b;aT=eT.a;mT=mid(bT,aT);bT1=eT1.b;aT1=eT1.a;mT1=mid(bT1,aT1);}
    else if(month===0||daysOvr===0){const eT=getE("spot","T"),eT1=getE("spot","T1");bT=eT.b;aT=eT.a;mT=mid(bT,aT);bT1=eT1.b;aT1=eT1.a;mT1=mid(bT1,aT1);}
    else{mT=iMT(dT);bT=iBT(dT);aT=iAT(dT);mT1=iMT1(dT1);bT1=iBT1(dT1);aT1=iAT1(dT1);}
    const sofT=month>0?iST(Math.min(month,24)):0,sofT1=month>0?iST1(Math.min(month,24)):0;
    const spB=(bT-sMT)*PF,spM=(mT-sMT)*PF,spA=(aT-sMT)*PF;
    const spB1=(bT1-sMT1)*PF,spM1=(mT1-sMT1)*PF,spA1=(aT1-sMT1)*PF;
    // Implied yield: bid uses F_bid/S_ask (lower), ask uses F_ask/S_bid (higher)
    const iyB=dT>0?implYld(bT,sAT,sofT,dT):null;
    const iyM=dT>0?implYld(mT,sMT,sofT,dT):null;
    const iyA=dT>0?implYld(aT,sBT,sofT,dT):null;
    const iyB1=dT1>0?implYld(bT1,sAT1,sofT1,dT1):null;
    const iyM1=dT1>0?implYld(mT1,sMT1,sofT1,dT1):null;
    const iyA1=dT1>0?implYld(aT1,sBT1,sofT1,dT1):null;
    const basisT=iyM!=null?iyM-sofT:null,basisT1=iyM1!=null?iyM1-sofT1:null;
    const iyBpD=iyM!=null&&dT>0?iyM/360*100:null;
    const td=TENOR_DATES[Math.round(month)]||{};
    const valDate=immVD||td.valDate||(daysOvr?dateFromSpot(daysOvr):null);
    const fixDate=valDate?bizBefore(valDate,2):td.fixDate;
    return{tenor:label||(month===0?"Spot":month<=12?`${month}M`:month===24?"2Y":`${month}M`),
      month,dT,dT1,bT,aT,mT,bT1,aT1,mT1,spB,spM,spA,spB1,spM1,spA1,
      ptsPerDay:dT>0?spM/dT:0,sofT,sofT1,iyB,iyM,iyA,iyB1,iyM1,iyA1,
      basisT,basisT1,iyBpD,interp:!isK&&month!==0,valDate,fixDate};
  }

  const rows=[];for(let m=0;m<=maxT;m++)rows.push(getRow(m));
  const immR=IMM_DATES.filter(im=>im.days<=maxT*31).map(im=>getRow(im.days/30.44,im.days,im.label,im.valDate));

  // Fwd-fwd: CORRECT bid/ask: ff_bid = curr_bid - prev_ask, ff_ask = curr_ask - prev_bid
  for(let i=0;i<rows.length;i++){
    const r=rows[i],p=i>0?rows[i-1]:null;
    r.ffB=i===0?0:r.spB-(p?.spA||0); r.ffM=i===0?0:r.spM-(p?.spM||0); r.ffA=i===0?0:r.spA-(p?.spB||0);
    r.ffB1=i===0?0:r.spB1-(p?.spA1||0); r.ffM1=i===0?0:r.spM1-(p?.spM1||0); r.ffA1=i===0?0:r.spA1-(p?.spB1||0);
    r.ffIyB=p?fwdFwdIy(p.iyA,p.dT,r.iyB,r.dT):null; // bid impl from wider/tighter
    r.ffIyM=p?fwdFwdIy(p.iyM,p.dT,r.iyM,r.dT):null;
    r.ffIyA=p?fwdFwdIy(p.iyB,p.dT,r.iyA,r.dT):null;
    r.ffIyM1=p?fwdFwdIy(p.iyM1,p.dT1,r.iyM1,r.dT1):null;
    const fwdD=p?r.dT-p.dT:0;
    r.ffSofr=fwdD>0?((1+r.sofT/100*r.dT/360)/(1+(p?.sofT||0)/100*(p?.dT||0)/360)-1)*360/fwdD*100:null;
    r.ffBasis=r.ffIyM!=null&&r.ffSofr!=null?r.ffIyM-r.ffSofr:null;
    r.ffIyBpD=r.ffIyM!=null&&fwdD>0?r.ffIyM/360*100:null;
    r.pipChg=r.spM-r.spM1;r.ffChg=r.ffM-r.ffM1;
    r.iyChg=(r.iyM||0)-(r.iyM1||0);r.sofChg=r.sofT-r.sofT1;
    r.basChg=(r.basisT||0)-(r.basisT1||0);r.ffIyChg=(r.ffIyM||0)-(r.ffIyM1||0);
    r.carryOutP=r.ffM;r.carryFfP=i>=2?r.ffM-p.ffM:(i===1?r.ffM:0);
    r.carryOutY=i>0?(r.iyM||0)-(p?.iyM||0):0;
    r.carryFfY=i>=2?(r.ffIyM||0)-(p?.ffIyM||0):(i===1?(r.ffIyM||0):0);
  }
  // IMM D/D
  for(let i=0;i<immR.length;i++){const r=immR[i],p=i>0?immR[i-1]:null;
    r.pipChg=r.spM-r.spM1;r.iyChg=(r.iyM||0)-(r.iyM1||0);r.sofChg=r.sofT-r.sofT1;
    r.basChg=(r.basisT||0)-(r.basisT1||0);r.ptsPerDay=r.dT>0?r.spM/r.dT:0;
    r.ffB=i===0?r.spB:r.spB-(p?.spA||0);r.ffM=i===0?r.spM:r.spM-(p?.spM||0);r.ffA=i===0?r.spA:r.spA-(p?.spB||0);
    r.ffM1=i===0?r.spM1:r.spM1-(p?.spM1||0);r.ffChg=r.ffM-r.ffM1;
    r.ffIyM=p?fwdFwdIy(p.iyM,p.dT,r.iyM,r.dT):null;
    r.ffIyM1=p?fwdFwdIy(p.iyM1,p.dT1,r.iyM1,r.dT1):null;
    r.ffIyChg=(r.ffIyM||0)-(r.ffIyM1||0);
    const fwdD=p?r.dT-p.dT:r.dT;
    r.ffSofr=p&&fwdD>0?((1+r.sofT/100*r.dT/360)/(1+(p.sofT/100)*p.dT/360)-1)*360/fwdD*100:(r.sofT||0);
    r.ffBasis=r.ffIyM!=null?r.ffIyM-(r.ffSofr||0):null;
  }

  // SPREADS — FIXED bid/ask: bid = far_bid - near_ask, ask = far_ask - near_bid
  function mkSpr(nrM,frM,label){
    const nr=rows[nrM],fr=rows[frM];
    const pB=fr.spB-nr.spA, pM=fr.spM-nr.spM, pA=fr.spA-nr.spB; // CORRECTED
    const pB1=fr.spB1-nr.spA1, pM1=fr.spM1-nr.spM1, pA1=fr.spA1-nr.spB1;
    const ds=fr.dT-nr.dT;
    const fIyB=fwdFwdIy(nr.iyA,nr.dT,fr.iyB,fr.dT);
    const fIy=fwdFwdIy(nr.iyM,nr.dT,fr.iyM,fr.dT);
    const fIyA=fwdFwdIy(nr.iyB,nr.dT,fr.iyA,fr.dT);
    const fIy1=fwdFwdIy(nr.iyM1,nr.dT1,fr.iyM1,fr.dT1);
    const fSof=ds>0?((1+fr.sofT/100*fr.dT/360)/(1+nr.sofT/100*nr.dT/360)-1)*360/ds*100:0;
    const fSof1=ds>0?((1+fr.sofT1/100*fr.dT1/360)/(1+nr.sofT1/100*nr.dT1/360)-1)*360/ds*100:0;
    const bas=fIy!=null?fIy-fSof:null;
    return{label,pB,pM,pA,pB1,pM1,pA1,chg:pM-pM1,days:ds,
      nrVD:nr.valDate,frVD:fr.valDate,nrFD:nr.fixDate,frFD:fr.fixDate,
      fIyB,fIy,fIyA,fIy1,iyChg:(fIy||0)-(fIy1||0),fSof,fSof1,sofChg:fSof-fSof1,
      bas,basChg:(bas||0)-((fIy1||0)-(fSof1||0)),ppd:ds>0?pM/ds:0,iyBpD:fIy!=null?fIy/360*100:null};
  }
  const anchorDefs=[[1,2,"1Mx2M"],[1,3,"1Mx3M"],[1,6,"1Mx6M"],[1,9,"1Mx9M"],[1,12,"1Mx12M"],[12,18,"12Mx18M"],[12,24,"12Mx2Y"]];
  const anchors=anchorDefs.filter(([n,f])=>f<=maxT&&n<=maxT).map(([n,f,l])=>mkSpr(n,f,l));
  const qFF=[];for(let n=3;n<=21;n+=3){const f=n+3;if(f<=maxT)qFF.push(mkSpr(n,f,`${n}M×${f<=12?f+"M":f===24?"2Y":f+"M"}`));}
  const spSpr=[1,2,3,6,9,12,18,24].filter(f=>f<=maxT).map(f=>mkSpr(0,f,`SP×${f<=12?f+"M":"2Y"}`));
  const immSpr=[];
  for(let i=0;i<immR.length-1;i++){const nr=immR[i],fr=immR[i+1];const pM=fr.spM-nr.spM,pM1=fr.spM1-nr.spM1;const ds=fr.dT-nr.dT;
    const fIy=fwdFwdIy(nr.iyM,nr.dT,fr.iyM,fr.dT);const fIy1=fwdFwdIy(nr.iyM1,nr.dT1,fr.iyM1,fr.dT1);
    const fSof=ds>0?((1+fr.sofT/100*fr.dT/360)/(1+(nr.sofT/100)*nr.dT/360)-1)*360/ds*100:0;
    immSpr.push({label:`${nr.tenor.split(" ")[1]}→${fr.tenor.split(" ")[1]}`,pB:0,pM,pA:0,pB1:0,pM1,pA1:0,chg:pM-pM1,days:ds,nrVD:nr.valDate,frVD:fr.valDate,fIyB:null,fIy,fIyA:null,fIy1,iyChg:(fIy||0)-(fIy1||0),fSof,sofChg:fSof-((ds>0?((1+fr.sofT1/100*fr.dT1/360)/(1+(nr.sofT1/100)*nr.dT1/360)-1)*360/ds*100:0)),bas:fIy!=null?fIy-fSof:null,basChg:0,ppd:ds>0?pM/ds:0,iyBpD:fIy!=null?fIy/360*100:null});}
  return{rows,immR,anchors,qFF,spSpr,immSpr,sMT,sMT1,sBT,sAT,cfg,ccy,maxT};
}

// Custom tenor from months or dates
function calcCustom(ad,nearM,farM,nearDate,farDate){
  const{rows}=ad;
  // If dates provided, convert to approx months for interpolation
  let nM=nearM,fM=farM;
  let nVD=null,fVD=null;
  if(nearDate){const d=daysBtwn(SPOT_DATE,nearDate);nM=d/30.44;nVD=nearDate;}
  if(farDate){const d=daysBtwn(SPOT_DATE,farDate);fM=d/30.44;fVD=farDate;}
  if(fM<=nM)return null;
  // Get data via interpolation through getRow-like logic
  const nrI=Math.floor(nM),frI=Math.floor(fM);
  const mT=ad.maxT||24;
  const nr=nrI>=0&&nrI<=mT?rows[nrI]:null;
  const fr=frI>=0&&frI<=mT?rows[frI]:null;
  if(!nr||!fr)return null;
  const pM=fr.spM-nr.spM,pB=fr.spB-nr.spA,pA=fr.spA-nr.spB;const ds=fr.dT-nr.dT;
  const fIy=fwdFwdIy(nr.iyM,nr.dT,fr.iyM,fr.dT);
  return{label:`${nearDate?fD(nearDate):`${nrI}M`} × ${farDate?fD(farDate):`${frI}M`}`,pB,pM,pA,days:ds,fIy,nrVD:nVD||nr.valDate,frVD:fVD||fr.valDate};
}

// ═══════════════════════════════════════════════════════════════════════
// PLOTLY CHART COMPONENT
// ═══════════════════════════════════════════════════════════════════════
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
  const ref=useRef(null);
  useEffect(()=>{
    if(!ref.current)return;
    // Deep-merge axis props so user layout doesn't clobber autorange/automargin
    const mergedX={...PLOT_LAYOUT.xaxis,...(layout?.xaxis||{})};
    const mergedY={...PLOT_LAYOUT.yaxis,...(layout?.yaxis||{})};
    const mergedY2=layout?.yaxis2?{...PLOT_LAYOUT.yaxis,overlaying:"y",side:"right",gridcolor:"transparent",...layout.yaxis2}:undefined;
    const l={...PLOT_LAYOUT,...layout,height,xaxis:mergedX,yaxis:mergedY};
    if(mergedY2)l.yaxis2=mergedY2;
    Plotly.newPlot(ref.current,traces,l,PLOT_CFG);
    // Force autoscale on each (re)render to prevent carry-over of zoom state
    try{Plotly.relayout(ref.current,{"xaxis.autorange":true,"yaxis.autorange":true});}catch(e){}
    return()=>{try{Plotly.purge(ref.current);}catch(e){}};
  },[traces,layout,height]);
  return <div ref={ref} style={{width:"100%"}}/>;
}

// ═══════════════════════════════════════════════════════════════════════
// HISTORICAL MODAL — Plotly based, shows SWAP POINTS not outrights
// ═══════════════════════════════════════════════════════════════════════
function HistModal({tenor,val,isSwapPts,onClose,dpOverride}){
  const hist=useMemo(()=>genHist(val,252),[val]);
  const[sigN,setSigN]=useState(20);
  const stats=useMemo(()=>calcStats(hist,sigN),[hist,sigN]);
  const rsiD=useMemo(()=>calcRSI(hist),[hist]);
  const macdD=useMemo(()=>calcMACD(hist),[hist]);
  const bb=useMemo(()=>calcBB(hist),[hist]);
  const s20=useMemo(()=>calcSMA(hist,20),[hist]);
  const s50=useMemo(()=>calcSMA(hist,50),[hist]);
  const zDev=useMemo(()=>calcZDev(hist,sigN),[hist,sigN]);
  const[btPeriod,setBtPeriod]=useState(252);
  const btRes=useMemo(()=>backtest(hist,btPeriod),[hist,btPeriod]);
  const[selSt,setSelSt]=useState(null);
  const[hovSt,setHovSt]=useState(null);

  const dates=hist.map(h=>h.date);const vals=hist.map(h=>h.value);
  const yLabel=isSwapPts?"Swap Points (pips)":"Level";

  // Price traces
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

  return(
    <div style={{position:"fixed",top:0,left:0,right:0,bottom:0,background:"rgba(0,0,0,.85)",zIndex:100,display:"flex",justifyContent:"center",alignItems:"center",padding:8}} onClick={onClose}>
      <div style={{background:"#0F172A",border:"1px solid #334155",borderRadius:8,width:"96%",maxWidth:1300,maxHeight:"96vh",overflow:"auto",padding:12}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <h2 style={{fontSize:13,fontWeight:800,color:"#F8FAFC",margin:0}}>{tenor} — Historical {isSwapPts?"(Swap Points)":""}</h2>
          <button onClick={onClose} style={{background:"#1E293B",border:"1px solid #334155",color:"#94A3B8",padding:"3px 10px",borderRadius:4,cursor:"pointer",fontSize:9}}>Close (ESC)</button>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 220px",gap:8}}>
          <div>
            <PChart traces={priceTraces} layout={{title:{text:`${tenor} ${yLabel}`,font:{size:10,color:"#94A3B8"}},yaxis:{title:yLabel}}} height={210}/>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,marginTop:4}}>
              <PChart traces={rsiTraces} layout={{title:{text:"RSI(14)",font:{size:9,color:"#64748B"}},yaxis:{range:[0,100]},shapes:[{type:"line",y0:70,y1:70,x0:0,x1:1,xref:"paper",line:{color:"#F87171",dash:"dot",width:1}},{type:"line",y0:30,y1:30,x0:0,x1:1,xref:"paper",line:{color:"#4ADE80",dash:"dot",width:1}}]}} height={120}/>
              <PChart traces={macdTraces} layout={{title:{text:"MACD(12,26,9)",font:{size:9,color:"#64748B"}}}} height={120}/>
            </div>
            <div style={{fontSize:7,color:"#475569",marginTop:2}}>Plotly charts: scroll to zoom, drag to pan, double-click to reset. Synthetic history for demo — connect LSEG Python API for live data.</div>
          </div>
          <div style={{background:"#131C2E",borderRadius:5,padding:6,overflow:"auto",maxHeight:460}}>
            <div style={{fontSize:8,fontWeight:800,color:"#60A5FA",marginBottom:3,letterSpacing:".1em"}}>HIGH / LOW</div>
            {Object.entries(stats.ranges).map(([k,v])=>(<div key={k} style={{display:"flex",justifyContent:"space-between",padding:"1px 0",fontSize:8.5,borderBottom:"1px solid #1E293B"}}><span style={{color:"#64748B",width:22}}>{k}</span><span style={{color:"#4ADE80",fontFamily:"monospace"}}>{v.low.toFixed(isSwapPts?1:3)}</span><span style={{color:"#64748B"}}>—</span><span style={{color:"#F87171",fontFamily:"monospace"}}>{v.high.toFixed(isSwapPts?1:3)}</span></div>))}
            <div style={{fontSize:8,fontWeight:800,color:"#10B981",marginTop:5,marginBottom:3,letterSpacing:".1em"}}>STATISTICS</div>
            <SR l="Current" v={stats.current} dp={isSwapPts?1:(dpOverride||3)}/><SR l="Mean" v={stats.mean} dp={isSwapPts?1:(dpOverride||3)}/><SR l="Std Dev" v={stats.sd} dp={isSwapPts?1:4}/><SR l="Skewness" v={stats.skew} dp={2}/><SR l="Kurtosis" v={stats.kurt} dp={2}/><SR l="Pctl Rank" v={`${stats.pctR.toFixed(0)}%`}/>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginTop:5,marginBottom:3}}>
              <span style={{fontSize:8,fontWeight:800,color:"#F87171",letterSpacing:".1em"}}>SIGMA-MOVE</span>
              <div style={{display:"flex",alignItems:"center",gap:2}}>
                <span style={{fontSize:7,color:"#64748B"}}>N:</span>
                <input type="number" value={sigN} onChange={e=>setSigN(Math.max(5,Math.min(252,+e.target.value||20)))} style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"0 3px",fontSize:8,width:34,fontFamily:"monospace"}}/>
              </div>
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
            <div style={{display:"flex",gap:3,alignItems:"center"}}>
              <span style={{fontSize:8,color:"#64748B"}}>Period:</span>
              {[[22,"1M"],[66,"3M"],[132,"6M"],[252,"1Y"]].map(([d,l])=>(<button key={d} onClick={()=>{setBtPeriod(d);setSelSt(null);}} style={{fontSize:7.5,padding:"1px 5px",borderRadius:3,border:"none",cursor:"pointer",background:btPeriod===d?"#3B82F6":"#1E293B",color:btPeriod===d?"#FFF":"#64748B"}}>{l}</button>))}
            </div>
          </div>
          {hovSt&&<div style={{background:"#0F172A",padding:"4px 8px",borderRadius:4,marginBottom:4,fontSize:8,color:"#94A3B8",border:"1px solid #334155"}}>{STRAT_DESCS[hovSt]||hovSt}</div>}
          <div style={{display:"grid",gridTemplateColumns:selSt!=null?"1fr 1fr":"1fr",gap:6}}>
            <table style={{borderCollapse:"collapse",width:"100%",fontSize:9}}>
              <thead><tr><th style={{...tS(),textAlign:"left"}}>Strategy</th><th style={tS("#FBBF24")}>Sharpe</th><th style={tS("#10B981")}>Return</th><th style={tS("#F87171")}>Max DD</th><th style={tS()}>Win%</th><th style={tS()}>Status</th></tr></thead>
              <tbody>{btRes.map((s,i)=>(
                <tr key={i} style={{background:selSt===i?"#1E3A5F":i%2===0?"#0F172A":"#131C2E",cursor:s.unavail?"default":"pointer"}}
                  onClick={()=>!s.unavail&&setSelSt(selSt===i?null:i)}
                  onMouseEnter={()=>setHovSt(s.name)} onMouseLeave={()=>setHovSt(null)}>
                  <td style={{...cS("#CBD5E1",true),textAlign:"left"}}>{s.name}</td>
                  <td style={cS(s.unavail?"#475569":(s.sharpe>0?"#FBBF24":"#F472B6"),!s.unavail)}>{s.unavail?"—":s.sharpe.toFixed(2)}</td>
                  <td style={cS(s.unavail?"#475569":(s.cumRet>=0?"#4ADE80":"#F87171"))}>{s.unavail?"—":(s.cumRet*100).toFixed(1)+"%"}</td>
                  <td style={cS(s.unavail?"#475569":"#F87171")}>{s.unavail?"—":(s.maxDD*100).toFixed(1)+"%"}</td>
                  <td style={cS("#64748B")}>{s.unavail?"—":(s.winRate*100).toFixed(0)+"%"}</td>
                  <td style={cS(s.unavail?"#F87171":"#4ADE80")}>{s.unavail?<span title={s.reason}>N/A</span>:"OK"}</td>
                </tr>))}</tbody>
            </table>
            {selSt!=null&&btRes[selSt]&&!btRes[selSt].unavail&&(()=>{
              const st=btRes[selSt];
              const eqTraces=[{x:st.dates,y:st.eqC.slice(1),type:"scatter",mode:"lines",name:"Equity",line:{color:"#10B981",width:1.5}}];
              const shTraces=[{x:st.dates,y:st.rollSh,type:"scatter",mode:"lines",name:"Roll 20d Sharpe",line:{color:"#FBBF24",width:1.3}}];
              return(<div>
                <PChart traces={eqTraces} layout={{title:{text:`${st.name} — Equity`,font:{size:9,color:"#94A3B8"}},shapes:[{type:"line",y0:1,y1:1,x0:0,x1:1,xref:"paper",line:{color:"#475569",dash:"dot"}}]}} height={110}/>
                <PChart traces={shTraces} layout={{title:{text:"Rolling 20d Sharpe",font:{size:9,color:"#94A3B8"}},shapes:[{type:"line",y0:0,y1:0,x0:0,x1:1,xref:"paper",line:{color:"#475569",dash:"dot"}}]}} height={100}/>
              </div>);
            })()}
          </div>
          {btRes.some(s=>s.unavail)&&<div style={{fontSize:7.5,color:"#64748B",marginTop:4}}>N/A strategies: insufficient data for lookback period. Hover strategy name for details.</div>}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SPREAD TABLE
// ═══════════════════════════════════════════════════════════════════════
function SprTbl({spreads,title,color,mx,onDbl}){
  if(!spreads.length)return null;
  return(<div style={{background:"#131C2E",borderRadius:5,padding:6,marginBottom:6}}>
    <div style={{fontSize:9.5,fontWeight:800,color,marginBottom:3,letterSpacing:".05em"}}>{title}</div>
    <div style={{overflowX:"auto"}}><table style={{borderCollapse:"collapse",width:"100%",minWidth:1000,fontSize:9}}>
      <thead><tr><th style={{...tS(),textAlign:"left",minWidth:60}}>Spread</th><th style={tS()}>Near Val</th><th style={tS()}>Far Val</th><th style={tS()}>Days</th><th style={tS("#4ADE80")}>Bid</th><th style={tS("#FBBF24")}>Mid</th><th style={tS("#F87171")}>Ask</th><th style={tS()}>D/D</th><th style={tS()}>Pts/D</th><th style={tS("#4ADE80")}>Iy Bid</th><th style={tS("#34D399")}>Iy Mid</th><th style={tS("#F87171")}>Iy Ask</th><th style={tS()}>Iy D/D</th><th style={tS()}>Iy bp/d</th><th style={tS("#FB923C")}>SOFR%</th><th style={tS("#C084FC")}>Basis</th></tr></thead>
      <tbody>{spreads.map((s,i)=>(<tr key={i} style={{background:i%2===0?"#0F172A":"#131C2E",cursor:"pointer"}} onDoubleClick={()=>onDbl&&onDbl(s.label,Math.abs(s.pM)||1,true)}>
        <td style={{...cS(color,true),textAlign:"left"}}>{s.label}</td>
        <td style={cS("#475569")}>{fD(s.nrVD)}</td><td style={cS("#475569")}>{fD(s.frVD)}</td><td style={cS("#475569",false,true)}>{s.days}</td>
        <td style={cS("#4ADE80")}>{FP(s.pB,1)}</td><td style={cS("#FBBF24",true)}>{FP(s.pM,1)}</td><td style={cS("#F87171")}>{FP(s.pA,1)}</td>
        <td style={{...cS(CC(s.chg)),background:HB(s.chg,mx)}}>{FP(s.chg,1)}</td><td style={cS("#64748B",false,true)}>{F(s.ppd,2)}</td>
        <td style={cS("#4ADE80")}>{F(s.fIyB,2)}</td><td style={cS("#34D399",true)}>{F(s.fIy,2)}</td><td style={cS("#F87171")}>{F(s.fIyA,2)}</td>
        <td style={{...cS(CC(s.iyChg)),background:HB(s.iyChg,.1)}}>{FP(s.iyChg,2)}</td><td style={cS("#64748B")}>{s.iyBpD!=null?F(s.iyBpD,2):"—"}</td>
        <td style={cS("#FB923C")}>{F(s.fSof,2)}</td><td style={cS((s.bas||0)>=0?"#C084FC":"#F472B6",true)}>{FP((s.bas||0)*100,1)}</td>
      </tr>))}</tbody></table></div></div>);
}

// ═══════════════════════════════════════════════════════════════════════
// BROKER MONITOR — shows MARKET-TRADED TENORS (spreads)
// ═══════════════════════════════════════════════════════════════════════
function BrokerMon({ad}){
  const{rows,ccy}=ad;
  const allT=getBrokerTenors(ccy);
  function getSpreadVal(t){
    if(t.type==="outright"){const r=rows[t.m];return r?{bid:r.spB,mid:r.spM,ask:r.spA}:null;}
    const nr=rows[t.near],fr=rows[t.far];
    if(!nr||!fr)return null;
    return{bid:fr.spB-nr.spA,mid:fr.spM-nr.spM,ask:fr.spA-nr.spB};
  }
  const hasRealBrokerData=Object.keys(BROKER_RICS).length>0;
  return(<div>
    <div style={{fontSize:10,fontWeight:800,color:"#60A5FA",marginBottom:6,letterSpacing:".05em"}}>MARKET-TRADED TENORS — LSEG Composite ({ccy})</div>
    <div style={{background:"#131C2E",borderRadius:5,padding:6,marginBottom:6}}>
      <table style={{borderCollapse:"collapse",width:"100%",fontSize:9}}><thead><tr>
        <th style={{...tS(),textAlign:"left"}}>Tenor</th><th style={tS("#4ADE80")}>Bid</th><th style={tS("#FBBF24")}>Mid</th><th style={tS("#F87171")}>Ask</th><th style={tS()}>Width</th>
      </tr></thead><tbody>
        {allT.map((t,idx)=>{const v=getSpreadVal(t);
          return(<tr key={idx} style={{background:idx%2===0?"#0F172A":"#131C2E"}}>
            <td style={{...cS("#CBD5E1",true),textAlign:"left"}}>{t.label}</td>
            <td style={cS(v?"#4ADE80":"#475569")}>{v?FP(v.bid,1):"—"}</td>
            <td style={cS(v?"#FBBF24":"#475569",true)}>{v?FP(v.mid,1):"—"}</td>
            <td style={cS(v?"#F87171":"#475569")}>{v?FP(v.ask,1):"—"}</td>
            <td style={cS("#94A3B8")}>{v?FP(v.ask-v.bid,1)+"p":"—"}</td>
          </tr>);})}
      </tbody></table></div>
    <div style={{fontSize:8,color:"#F87171",background:"#1F1317",border:"1px solid #7F1D1D",borderRadius:4,padding:6,marginTop:4}}>
      <b>Per-broker contributions not wired.</b> {hasRealBrokerData?"":"LSEG historical_pricing_summaries does not serve broker-contributed RICs (=TRAD/=ICAP/=BGCP/=TPTS); those are realtime-snap RICs. To show real per-broker bid/ask, connect a realtime LSEG Python/RTMDS feed or broker FIX contributor streams, then populate BROKER_RICS."}
    </div>
  </div>);
}

// ═══════════════════════════════════════════════════════════════════════
// TOOLS — custom tenor (months OR dates) + scenario calc
// ═══════════════════════════════════════════════════════════════════════
function ToolsPanel({ad,onDbl}){
  const[mode,setMode]=useState("month"); // "month" or "date"
  const[nearM,setNearM]=useState(1);const[farM,setFarM]=useState(6);
  const[nearDt,setNearDt]=useState("");const[farDt,setFarDt]=useState("");
  const custom=useMemo(()=>{
    if(mode==="date"&&nearDt&&farDt)return calcCustom(ad,0,0,new Date(nearDt),new Date(farDt));
    return calcCustom(ad,nearM,farM,null,null);
  },[ad,mode,nearM,farM,nearDt,farDt]);
  const[scMode,setScMode]=useState("pips");const[scIn,setScIn]=useState("");
  const[scTenorMode,setScTenorMode]=useState("month");
  const[scN,setScN]=useState(1);const[scF,setScF]=useState(3);
  const[scNDt,setScNDt]=useState("");const[scFDt,setScFDt]=useState("");
  const PF=ad.cfg?.pipFactor||1e3;
  // Clamp tenor selections when maxT shrinks on currency switch
  useEffect(()=>{const mT=ad.maxT||24;
    setNearM(v=>Math.min(v,mT));setFarM(v=>Math.min(v,mT));
    setScN(v=>Math.min(v,mT));setScF(v=>{const c=Math.min(v,mT);return c<=Math.min(scN,mT)?mT:c;});
  },[ad.maxT]);
  const scRes=useMemo(()=>{const v=parseFloat(scIn);if(isNaN(v))return null;
    // Resolve near/far leg via either month index OR date → interpolated row
    function resolveLeg(mKey,dtStr){
      if(scTenorMode==="date"&&dtStr){
        const dt=new Date(dtStr);const days=daysBtwn(SPOT_DATE,dt);if(days<0)return null;
        const mApprox=days/30.44;const i=Math.floor(mApprox);
        if(i<0||i>=ad.rows.length-1)return ad.rows[Math.min(Math.max(i,0),ad.rows.length-1)]||null;
        // Linear-interp across row bracket for iyM/spM/sofT/dT
        const r0=ad.rows[i],r1=ad.rows[i+1];const t=mApprox-i;
        return{dT:r0.dT+(r1.dT-r0.dT)*t,iyM:r0.iyM+(r1.iyM-r0.iyM)*t,spM:r0.spM+(r1.spM-r0.spM)*t,sofT:r0.sofT+(r1.sofT-r0.sofT)*t,_lbl:fD(dt)};
      }
      const r=ad.rows[mKey];if(!r)return null;return{...r,_lbl:mKey===0?"Spot":`${mKey}M`};
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
      {mode==="month"?(<div style={{display:"flex",gap:4,alignItems:"center",marginBottom:6}}>
        <span style={{fontSize:8,color:"#64748B"}}>Near:</span>{sel(nearM,setNearM)}<span style={{fontSize:8,color:"#64748B"}}>Far:</span>{sel(farM,setFarM)}
      </div>):(<div style={{display:"flex",gap:4,alignItems:"center",marginBottom:6,flexWrap:"wrap"}}>
        <span style={{fontSize:8,color:"#64748B"}}>Near date:</span>
        <input type="date" value={nearDt} onChange={e=>setNearDt(e.target.value)} style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"2px 4px",fontSize:9}}/>
        <span style={{fontSize:8,color:"#64748B"}}>Far date:</span>
        <input type="date" value={farDt} onChange={e=>setFarDt(e.target.value)} style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"2px 4px",fontSize:9}}/>
      </div>)}
      {custom&&(<div style={{background:"#0F172A",borderRadius:4,padding:6,fontSize:9,cursor:"pointer"}} onDoubleClick={()=>onDbl&&onDbl(custom.label,Math.abs(custom.pM)||1,true)}>
        <div style={{color:"#FBBF24",fontWeight:700,marginBottom:3}}>{custom.label} <span style={{color:"#475569",fontWeight:400,fontSize:7.5}}>(double-click for historical)</span></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:3}}>
          <div><span style={{color:"#64748B"}}>Bid: </span><span style={{color:"#4ADE80",fontFamily:"monospace"}}>{FP(custom.pB,1)}</span></div>
          <div><span style={{color:"#64748B"}}>Mid: </span><span style={{color:"#FBBF24",fontFamily:"monospace"}}>{FP(custom.pM,1)}</span></div>
          <div><span style={{color:"#64748B"}}>Ask: </span><span style={{color:"#F87171",fontFamily:"monospace"}}>{FP(custom.pA,1)}</span></div>
          <div><span style={{color:"#64748B"}}>Days: </span><span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{custom.days}</span></div>
          <div><span style={{color:"#64748B"}}>Fwd Impl: </span><span style={{color:"#10B981",fontFamily:"monospace"}}>{custom.fIy!=null?F(custom.fIy,2)+"%":"—"}</span></div>
          <div><span style={{color:"#64748B"}}>Near: </span><span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{fD(custom.nrVD)}</span></div>
        </div>
      </div>)}
    </div>
    <div style={{background:"#131C2E",borderRadius:5,padding:8}}>
      <div style={{fontSize:9.5,fontWeight:800,color:"#F59E0B",marginBottom:4,letterSpacing:".05em"}}>SCENARIO CALCULATOR</div>
      <div style={{display:"flex",gap:4,marginBottom:6}}>
        <button onClick={()=>setScTenorMode("month")} style={{fontSize:7.5,padding:"1px 6px",borderRadius:3,border:"none",cursor:"pointer",background:scTenorMode==="month"?"#3B82F6":"#1E293B",color:scTenorMode==="month"?"#FFF":"#64748B"}}>By Month</button>
        <button onClick={()=>setScTenorMode("date")} style={{fontSize:7.5,padding:"1px 6px",borderRadius:3,border:"none",cursor:"pointer",background:scTenorMode==="date"?"#3B82F6":"#1E293B",color:scTenorMode==="date"?"#FFF":"#64748B"}}>By Date</button>
        <button onClick={()=>setScMode("pips")} style={{fontSize:7.5,padding:"1px 6px",borderRadius:3,border:"none",cursor:"pointer",background:scMode==="pips"?"#8B5CF6":"#1E293B",color:scMode==="pips"?"#FFF":"#64748B"}}>Pips→Impl</button>
        <button onClick={()=>setScMode("impl")} style={{fontSize:7.5,padding:"1px 6px",borderRadius:3,border:"none",cursor:"pointer",background:scMode==="impl"?"#8B5CF6":"#1E293B",color:scMode==="impl"?"#FFF":"#64748B"}}>Impl→Pips</button>
      </div>
      {scTenorMode==="month"?(<div style={{display:"flex",gap:4,alignItems:"center",marginBottom:4,flexWrap:"wrap"}}>
        <span style={{fontSize:8,color:"#64748B"}}>Near:</span>{sel(scN,setScN)}<span style={{fontSize:8,color:"#64748B"}}>Far:</span>{sel(scF,setScF)}
      </div>):(<div style={{display:"flex",gap:4,alignItems:"center",marginBottom:4,flexWrap:"wrap"}}>
        <span style={{fontSize:8,color:"#64748B"}}>Near date:</span>
        <input type="date" value={scNDt} onChange={e=>setScNDt(e.target.value)} style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"2px 4px",fontSize:9}}/>
        <span style={{fontSize:8,color:"#64748B"}}>Far date:</span>
        <input type="date" value={scFDt} onChange={e=>setScFDt(e.target.value)} style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"2px 4px",fontSize:9}}/>
      </div>)}
      <div style={{display:"flex",gap:4,alignItems:"center",marginBottom:4}}>
        <span style={{fontSize:8,color:"#64748B"}}>{scMode==="pips"?"Spread pips:":"Target impl%:"}</span>
        <input value={scIn} onChange={e=>setScIn(e.target.value)} type="number" step="0.1" style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"2px 6px",fontSize:9,width:80,fontFamily:"monospace"}} placeholder={scMode==="pips"?"-10":"2.50"}/>
      </div>
      {scRes&&(<div style={{background:"#0F172A",borderRadius:4,padding:6,fontSize:9}}>
        <div style={{color:"#FBBF24",fontWeight:700,marginBottom:3}}>{scRes.label}</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:3}}>
          <div><span style={{color:"#64748B"}}>Pips: </span><span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{FP(scRes.pips,1)}</span></div>
          <div><span style={{color:"#64748B"}}>Fwd Impl: </span><span style={{color:"#10B981",fontFamily:"monospace"}}>{scRes.impl!=null?F(scRes.impl,2)+"%":"—"}</span></div>
          <div><span style={{color:"#64748B"}}>Days: </span><span style={{color:"#E2E8F0",fontFamily:"monospace"}}>{scRes.days}</span></div>
        </div>
      </div>)}
    </div>
  </div>);
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN DASHBOARD
// ═══════════════════════════════════════════════════════════════════════
export default function Dashboard(){
  const[showI,setShowI]=useState(true);const[tab,setTab]=useState("main");
  const[selBr,setSelBr]=useState([]);const[hm,setHm]=useState(null);
  const[ccy,setCcy]=useState("TWD");

  const ad=useMemo(()=>buildAllData(ccy,selBr),[ccy,selBr]);
  const{rows,immR,anchors,qFF,spSpr,immSpr,cfg}=ad;
  const filt=showI?rows:rows.filter(r=>!r.interp);

  const mr=rows.filter(r=>r.month>0);
  const mPC=Math.max(...mr.map(r=>Math.abs(r.pipChg||0)),1);
  const mIC=Math.max(...mr.map(r=>Math.abs(r.iyChg||0)),.01);
  const mBC=Math.max(...mr.map(r=>Math.abs(r.basChg||0)),.01);
  const mFC=Math.max(...mr.filter(r=>r.month>1).map(r=>Math.abs(r.ffChg||0)),1);
  const mCP=Math.max(...mr.map(r=>Math.abs(r.carryOutP||0)),1);
  const mCF=Math.max(...mr.filter(r=>r.month>1).map(r=>Math.abs(r.carryFfP||0)),1);
  const mCY=Math.max(...mr.map(r=>Math.abs(r.carryOutY||0)),.01);
  const mSC=Math.max(...[...anchors,...qFF,...spSpr,...immSpr].map(s=>Math.abs(s.chg||0)),1);

  const togBr=br=>{setSelBr(p=>p.includes(br)?p.filter(b=>b!==br):[...p,br]);};
  const dblR=(t,v,isSP=false)=>setHm({tenor:t,value:v,isSP});

  useEffect(()=>{const h=e=>{if(e.key==="Escape")setHm(null);};window.addEventListener("keydown",h);return()=>window.removeEventListener("keydown",h);},[]);

  // Plotly data
  const tenors=filt.filter(r=>r.month>0).map(r=>r.tenor);
  const outPts=filt.filter(r=>r.month>0).map(r=>r.spM);
  const ffPts=filt.filter(r=>r.month>0).map(r=>r.ffM);
  const iyVals=filt.filter(r=>r.month>0).map(r=>r.iyM);
  const sofrVals=filt.filter(r=>r.month>0).map(r=>r.sofT);
  const basVals=filt.filter(r=>r.month>0).map(r=>(r.basisT||0)*100);

  const srcL=selBr.length===0?"Default (LSEG)":selBr.join("+")+` avg (${ccy})`;
  const tabs=[{id:"main",label:"Full Curve"},{id:"spreads",label:"Spreads & Rolls"},{id:"imm",label:"IMM Dates"},{id:"tools",label:"Tools"},{id:"broker",label:"Broker Monitor"}];
  const dp=cfg.dp;

  return(
    <div style={{background:"#0F172A",color:"#E2E8F0",minHeight:"100vh",fontFamily:"'Inter',system-ui,sans-serif",padding:8}}>
      {hm&&<HistModal tenor={hm.tenor} val={hm.value} isSwapPts={hm.isSP} dpOverride={dp} onClose={()=>setHm(null)}/>}
      {/* Header */}
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6,paddingBottom:4,borderBottom:"1px solid #1E293B",flexWrap:"wrap",gap:4}}>
        <div><h1 style={{fontSize:14,fontWeight:800,margin:0,color:"#F8FAFC"}}>{cfg.pair} NDF Dashboard</h1>
          <span style={{fontSize:8.5,color:"#475569"}}>{TRADE_TS} &middot; {srcL} &middot; vs {PREV_TS} &middot; <span style={{color:"#F59E0B"}}>LSEG Apr 3 close</span></span></div>
        <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
          <div style={{display:"flex",gap:3,alignItems:"center",background:"#1E293B",padding:"2px 6px",borderRadius:4}}>
            <span style={{fontSize:7.5,color:"#64748B",fontWeight:700}}>CCY:</span>
            <select value={ccy} onChange={e=>{setCcy(e.target.value);setSelBr([]);}} style={{background:"#0F172A",border:"1px solid #334155",color:"#E2E8F0",borderRadius:3,padding:"1px 4px",fontSize:9,fontWeight:700}}>
              {CCY_LIST.map(c=><option key={c} value={c}>{CCY_CONFIG[c].pair}</option>)}
            </select>
          </div>
          <div style={{display:"flex",gap:3,alignItems:"center",background:"#1E293B",padding:"2px 6px",borderRadius:4}}>
            <span style={{fontSize:7.5,color:"#64748B",fontWeight:700}}>SRC:</span>
            <label style={{fontSize:7.5,color:selBr.length===0?"#4ADE80":"#64748B",cursor:"pointer",display:"flex",alignItems:"center",gap:2}}><input type="radio" checked={selBr.length===0} onChange={()=>setSelBr([])} style={{accentColor:"#3B82F6",width:9,height:9}}/>Default</label>
            {BROKER_NAMES.map(br=>(<label key={br} style={{fontSize:7.5,color:selBr.includes(br)?"#60A5FA":"#64748B",cursor:"pointer",display:"flex",alignItems:"center",gap:2}}><input type="checkbox" checked={selBr.includes(br)} onChange={()=>togBr(br)} style={{accentColor:"#3B82F6",width:9,height:9}}/>{br}</label>))}
          </div>
          <label style={{fontSize:7.5,color:"#94A3B8",display:"flex",alignItems:"center",gap:2,cursor:"pointer"}}><input type="checkbox" checked={showI} onChange={()=>setShowI(!showI)} style={{accentColor:"#3B82F6",width:9,height:9}}/>Interp</label>
          <div style={{background:"#1E293B",padding:"2px 6px",borderRadius:4,fontSize:9,fontFamily:"monospace"}}>
            <span style={{color:"#64748B"}}>Spot </span><span style={{color:"#4ADE80"}}>{F(rows[0].bT,dp)}</span><span style={{color:"#334155"}}>/</span><span style={{color:"#F87171"}}>{F(rows[0].aT,dp)}</span><span style={{color:"#334155"}}> | </span><span style={{color:"#FBBF24",fontWeight:700}}>{F(rows[0].mT,dp)}</span>
          </div>
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
          <PChart traces={[{x:tenors,y:outPts,type:"scatter",mode:"lines+markers",name:"Outright SwPts",line:{color:"#F59E0B"},marker:{size:4}}]} layout={{title:{text:"Outright Swap Points (pips)",font:{size:10}}}} height={175}/>
          <PChart traces={[{x:tenors,y:ffPts,type:"bar",name:"1M Fwd-Fwd",marker:{color:ffPts.map(v=>v>=0?"#3B82F6":"#F472B6")}}]} layout={{title:{text:"1M Forward-Forward (pips)",font:{size:10}}}} height={175}/>
          <PChart traces={[{x:tenors,y:iyVals,type:"scatter",mode:"lines+markers",name:"TWD Impl%",line:{color:"#10B981"},marker:{size:3},yaxis:"y"},{x:tenors,y:sofrVals,type:"scatter",mode:"lines+markers",name:"SOFR%",line:{color:"#FB923C"},marker:{size:3},yaxis:"y"}]} layout={{title:{text:"Implied Yield vs SOFR (%)",font:{size:10}},yaxis:{title:"%"}}} height={175}/>
          <PChart traces={[{x:tenors,y:basVals,type:"bar",name:"Basis bp",marker:{color:basVals.map(v=>v>=0?"#8B5CF6":"#F472B6")}}]} layout={{title:{text:"Basis (bp)",font:{size:10}}}} height={175}/>
        </div>

        <div style={{fontSize:8.5,fontWeight:700,color:"#F8FAFC",marginBottom:2}}>OUTRIGHT NDF CURVE</div>
        <div style={{overflowX:"auto",overflowY:"auto",maxHeight:"34vh",borderRadius:5,border:"1px solid #1E293B",marginBottom:6}}>
          <table style={{borderCollapse:"collapse",width:"100%",minWidth:1700}}>
            <thead><tr>
              <td colSpan={4} style={sS("#64748B")}>TENOR</td><td colSpan={3} style={sS("#60A5FA")}>NDF OUTRIGHT</td>
              <td colSpan={4} style={sS("#FBBF24")}>SWAP POINTS</td><td colSpan={4} style={sS("#34D399")}>IMPLIED YIELD [CALC]</td>
              <td colSpan={2} style={sS("#FB923C")}>SOFR [LSEG]</td><td colSpan={2} style={sS("#C084FC")}>BASIS</td>
              <td colSpan={2} style={sS("#38BDF8")}>CARRY PIP</td><td colSpan={2} style={sS("#F472B6")}>CARRY YLD</td>
            </tr><tr>
              <th style={{...tS(),textAlign:"left",minWidth:36}}>Tnr</th><th style={tS()}>Val</th><th style={tS()}>Fix</th><th style={{...tS(),borderRight:"1px solid #334155"}}>D</th>
              <th style={tS("#4ADE80")}>Bid</th><th style={tS("#F87171")}>Ask</th><th style={{...tS("#FBBF24"),borderRight:"1px solid #334155"}}>Mid</th>
              <th style={tS("#4ADE80")}>Bid</th><th style={tS("#FBBF24")}>Mid</th><th style={tS("#F87171")}>Ask</th><th style={{...tS(),borderRight:"1px solid #334155"}}>D/D</th>
              <th style={tS("#4ADE80")}>Bid</th><th style={tS("#34D399")}>Mid</th><th style={tS("#F87171")}>Ask</th><th style={{...tS(),borderRight:"1px solid #334155"}}>D/D</th>
              <th style={tS("#FB923C")}>%</th><th style={{...tS(),borderRight:"1px solid #334155"}}>D/D</th>
              <th style={tS("#C084FC")}>bp</th><th style={{...tS(),borderRight:"1px solid #334155"}}>D/D</th>
              <th style={tS("#38BDF8")}>Outr</th><th style={{...tS("#38BDF8"),borderRight:"1px solid #334155"}}>FF</th>
              <th style={tS("#F472B6")}>Outr</th><th style={tS("#F472B6")}>FF</th>
            </tr></thead>
            <tbody>{filt.map((r,i)=>{const sp=r.month===0,mj=[0,1,2,3,6,9,12,24].includes(r.month);const bg=sp?"#1a2744":(i%2===0?"#0F172A":"#111827");const tc=r.interp?"#475569":(mj?"#F8FAFC":"#94A3B8");
              return(<tr key={r.tenor} style={{background:bg,borderBottom:[3,6,9,12].includes(r.month)?"1px solid #334155":"none",cursor:"pointer"}} onDoubleClick={()=>dblR(r.tenor,r.spM,true)}>
                <td style={{...cS(tc,mj),textAlign:"left",borderRight:"1px solid #1E293B"}}>{r.tenor}{r.interp?"*":""}</td>
                <td style={cS("#475569")}>{fD(r.valDate)}</td><td style={cS("#475569")}>{fD(r.fixDate)}</td><td style={{...cS("#475569"),borderRight:"1px solid #334155"}}>{r.dT||"—"}</td>
                <td style={cS("#4ADE80")}>{F(r.bT,dp)}</td><td style={cS("#F87171")}>{F(r.aT,dp)}</td><td style={{...cS("#FBBF24",true),borderRight:"1px solid #334155"}}>{F(r.mT,dp)}</td>
                <td style={cS("#4ADE80")}>{sp?"—":FP(r.spB,1)}</td><td style={cS("#FBBF24",true)}>{sp?"—":FP(r.spM,1)}</td><td style={cS("#F87171")}>{sp?"—":FP(r.spA,1)}</td>
                <td style={{...cS(CC(r.pipChg)),borderRight:"1px solid #334155",background:sp?"transparent":HB(r.pipChg,mPC)}}>{sp?"—":FP(r.pipChg,1)}</td>
                <td style={cS("#4ADE80")}>{sp?"—":F(r.iyB,2)}</td><td style={cS("#34D399",true)}>{sp?"—":F(r.iyM,2)}</td><td style={cS("#F87171")}>{sp?"—":F(r.iyA,2)}</td>
                <td style={{...cS(CC(r.iyChg)),borderRight:"1px solid #334155",background:sp?"transparent":HB(r.iyChg,mIC)}}>{sp?"—":FP(r.iyChg,2)}</td>
                <td style={cS("#FB923C")}>{sp?"—":F(r.sofT,2)}</td><td style={{...cS(CC(r.sofChg)),borderRight:"1px solid #334155",background:sp?"transparent":HB(r.sofChg,.005)}}>{sp?"—":FP(r.sofChg*100,1)}</td>
                <td style={cS((r.basisT||0)>=0?"#C084FC":"#F472B6",true)}>{sp?"—":FP((r.basisT||0)*100,1)}</td>
                <td style={{...cS(CC(r.basChg)),borderRight:"1px solid #334155",background:sp?"transparent":HB(r.basChg,mBC)}}>{sp?"—":FP(r.basChg*100,1)}</td>
                <td style={{...cS(r.carryOutP>=0?"#38BDF8":"#F472B6"),background:sp?"transparent":HB(r.carryOutP,mCP)}}>{sp?"—":FP(r.carryOutP,1)}</td>
                <td style={{...cS(r.carryFfP>=0?"#38BDF8":"#F472B6"),borderRight:"1px solid #334155",background:r.month<2?"transparent":HB(r.carryFfP,mCF)}}>{r.month<2?"—":FP(r.carryFfP,1)}</td>
                <td style={{...cS(r.carryOutY>=0?"#F472B6":"#4ADE80"),background:sp?"transparent":HB(r.carryOutY,mCY)}}>{sp?"—":FP(r.carryOutY,2)}</td>
                <td style={{...cS(r.carryFfY>=0?"#F472B6":"#4ADE80"),background:r.month<2?"transparent":HB(r.carryFfY||0,mCY)}}>{r.month<2?"—":FP(r.carryFfY,2)}</td>
              </tr>);})}</tbody></table></div>

        <div style={{fontSize:8.5,fontWeight:700,color:"#F8FAFC",marginBottom:2}}>1M FORWARD-FORWARD CHAIN</div>
        <div style={{overflowX:"auto",overflowY:"auto",maxHeight:"28vh",borderRadius:5,border:"1px solid #1E293B"}}>
          <table style={{borderCollapse:"collapse",width:"100%",minWidth:1200}}>
            <thead><tr><th style={{...tS(),textAlign:"left",minWidth:55}}>Period</th><th style={tS()}>Near Val</th><th style={tS()}>Far Val</th><th style={tS()}>Days</th><th style={tS("#4ADE80")}>Bid</th><th style={tS("#FBBF24")}>Mid</th><th style={tS("#F87171")}>Ask</th><th style={tS()}>D/D</th><th style={tS()}>Pts/D</th><th style={tS("#4ADE80")}>Iy Bid</th><th style={tS("#34D399")}>Iy Mid</th><th style={tS("#F87171")}>Iy Ask</th><th style={tS()}>Iy D/D</th><th style={tS()}>Iy bp/d</th><th style={tS("#FB923C")}>Fwd SOFR</th><th style={tS("#C084FC")}>Basis</th></tr></thead>
            <tbody>{filt.filter(r=>r.month>0).map((r,i)=>{const p=i>0?filt.filter(x=>x.month>0)[i-1]:null;const label=r.month===1?"SP×1M":p?`${p.tenor}×${r.tenor}`:`SP×${r.tenor}`;const fwdD=p?r.dT-p.dT:r.dT;const ppd=fwdD>0?r.ffM/fwdD:0;const mj=[1,2,3,6,9,12,24].includes(r.month);
              return(<tr key={r.tenor} style={{background:i%2===0?"#0F172A":"#111827",borderBottom:[3,6,9,12].includes(r.month)?"1px solid #334155":"none",cursor:"pointer"}} onDoubleClick={()=>dblR(label,r.ffM,true)}>
                <td style={{...cS(r.interp?"#475569":(mj?"#F8FAFC":"#94A3B8"),mj),textAlign:"left"}}>{label}{r.interp?"*":""}</td>
                <td style={cS("#475569")}>{fD(p?p.valDate:TENOR_DATES[0]?.valDate)}</td><td style={cS("#475569")}>{fD(r.valDate)}</td><td style={cS("#475569",false,true)}>{fwdD}</td>
                <td style={cS("#4ADE80")}>{FP(r.ffB,1)}</td><td style={cS("#FBBF24",true)}>{FP(r.ffM,1)}</td><td style={cS("#F87171")}>{FP(r.ffA,1)}</td>
                <td style={{...cS(CC(r.ffChg)),background:HB(r.ffChg,mFC)}}>{FP(r.ffChg,1)}</td><td style={cS("#64748B",false,true)}>{F(ppd,2)}</td>
                <td style={cS("#4ADE80")}>{F(r.ffIyB,2)}</td><td style={cS("#34D399",true)}>{F(r.ffIyM,2)}</td><td style={cS("#F87171")}>{F(r.ffIyA,2)}</td>
                <td style={{...cS(CC(r.ffIyChg)),background:HB(r.ffIyChg,.1)}}>{FP(r.ffIyChg,2)}</td><td style={cS("#64748B")}>{r.ffIyBpD!=null?F(r.ffIyBpD,2):"—"}</td>
                <td style={cS("#FB923C")}>{r.ffSofr!=null?F(r.ffSofr,2):"—"}</td><td style={cS((r.ffBasis||0)>=0?"#C084FC":"#F472B6")}>{r.ffBasis!=null?FP(r.ffBasis*100,1):"—"}</td>
              </tr>);})}</tbody></table></div>
      </>)}

      {/* SPREADS TAB */}
      {tab==="spreads"&&(<div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:6}}>
          <PChart traces={[{x:anchors.map(s=>s.label),y:anchors.map(s=>s.pM),type:"bar",name:"Mid",marker:{color:"#10B981"}},{x:anchors.map(s=>s.label),y:anchors.map(s=>s.chg),type:"scatter",mode:"lines+markers",name:"D/D",line:{color:"#FBBF24"},yaxis:"y2"}]} layout={{title:{text:"Interbank Anchors",font:{size:10}},yaxis2:{overlaying:"y",side:"right",gridcolor:"transparent",tickfont:{size:8}}}} height={185}/>
          <PChart traces={[{x:qFF.map(s=>s.label),y:qFF.map(s=>s.pM),type:"bar",name:"Mid",marker:{color:"#8B5CF6"}}]} layout={{title:{text:"3M Fwd-Fwd Rolls",font:{size:10}}}} height={185}/>
        </div>
        <SprTbl spreads={anchors} title="PRIORITY 1 — INTERBANK ANCHOR SPREADS" color="#10B981" mx={mSC} onDbl={dblR}/>
        <SprTbl spreads={qFF} title="PRIORITY 2 — 3M FORWARD-FORWARD GAPS" color="#A78BFA" mx={mSC} onDbl={dblR}/>
        <SprTbl spreads={spSpr} title="SPOT-START SPREADS" color="#60A5FA" mx={mSC} onDbl={dblR}/>
        <SprTbl spreads={immSpr} title="PRIORITY 3 — IMM ROLL SPREADS" color="#F59E0B" mx={mSC} onDbl={dblR}/>
      </div>)}

      {/* IMM TAB */}
      {tab==="imm"&&(<div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,marginBottom:6}}>
          <PChart traces={[{x:immR.map(r=>r.tenor.split(" ")[1]),y:immR.map(r=>r.spM),type:"bar",name:"SwPts",marker:{color:"#3B82F6"}},{x:immR.map(r=>r.tenor.split(" ")[1]),y:immR.map(r=>r.iyM),type:"scatter",mode:"lines+markers",name:"Impl%",line:{color:"#10B981"},yaxis:"y2"}]}
            layout={{title:{text:"IMM Outrights",font:{size:10}},yaxis:{title:"Pips"},yaxis2:{title:"%",overlaying:"y",side:"right",gridcolor:"transparent"}}} height={185}/>
          <PChart traces={[{x:immSpr.map(s=>s.label),y:immSpr.map(s=>s.pM),type:"bar",name:"Roll Pips",marker:{color:"#F59E0B"}}]}
            layout={{title:{text:"IMM Roll Spreads",font:{size:10}}}} height={185}/>
        </div>
        <div style={{background:"#131C2E",borderRadius:5,padding:6,marginBottom:6}}>
          <div style={{fontSize:9.5,fontWeight:800,color:"#FB923C",marginBottom:3}}>IMM OUTRIGHTS</div>
          <div style={{overflowX:"auto"}}><table style={{borderCollapse:"collapse",width:"100%",minWidth:1200,fontSize:9}}>
            <thead><tr><th style={{...tS(),textAlign:"left"}}>IMM</th><th style={tS()}>Val Date</th><th style={tS()}>Fix Date</th><th style={tS()}>Days</th><th style={tS("#4ADE80")}>Bid</th><th style={tS("#F87171")}>Ask</th><th style={tS("#FBBF24")}>Mid</th><th style={tS("#FBBF24")}>Pips</th><th style={tS()}>D/D</th><th style={tS("#34D399")}>Iy Mid</th><th style={tS()}>Iy D/D</th><th style={tS("#FB923C")}>SOFR</th><th style={tS("#C084FC")}>Basis</th><th style={tS("#A78BFA")}>FF</th><th style={tS()}>FF D/D</th><th style={tS("#34D399")}>FF Iy</th></tr></thead>
            <tbody>{immR.map((r,i)=>(<tr key={i} style={{background:i%2===0?"#0F172A":"#131C2E",cursor:"pointer"}} onDoubleClick={()=>dblR(r.tenor,r.spM,true)}>
              <td style={{...cS("#FB923C",true),textAlign:"left"}}>{r.tenor}</td><td style={cS("#475569")}>{fD(r.valDate)}</td><td style={cS("#475569")}>{fD(r.fixDate)}</td><td style={cS("#475569")}>{r.dT}</td>
              <td style={cS("#4ADE80")}>{F(r.bT,dp)}</td><td style={cS("#F87171")}>{F(r.aT,dp)}</td><td style={cS("#FBBF24",true)}>{F(r.mT,dp)}</td>
              <td style={cS("#FBBF24",true)}>{FP(r.spM,1)}</td><td style={{...cS(CC(r.pipChg)),background:HB(r.pipChg,mPC)}}>{FP(r.pipChg,1)}</td>
              <td style={cS("#34D399",true)}>{F(r.iyM,2)}</td><td style={{...cS(CC(r.iyChg)),background:HB(r.iyChg,mIC)}}>{FP(r.iyChg,2)}</td>
              <td style={cS("#FB923C")}>{F(r.sofT,2)}</td><td style={cS((r.basisT||0)>=0?"#C084FC":"#F472B6")}>{FP((r.basisT||0)*100,1)}</td>
              <td style={cS(r.ffM>=0?"#A78BFA":"#F472B6")}>{FP(r.ffM,1)}</td><td style={{...cS(CC(r.ffChg)),background:HB(r.ffChg,mFC)}}>{FP(r.ffChg,1)}</td>
              <td style={cS("#34D399")}>{F(r.ffIyM,2)}</td>
            </tr>))}</tbody></table></div></div>
        <SprTbl spreads={immSpr} title="IMM ROLL SPREADS" color="#F59E0B" mx={mSC} onDbl={dblR}/>
      </div>)}

      {tab==="tools"&&<ToolsPanel ad={ad} onDbl={dblR}/>}
      {tab==="broker"&&<BrokerMon ad={ad}/>}

      <div style={{marginTop:4,fontSize:6.5,color:"#334155",display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:2}}>
        <div>[LSEG] = sourced &middot; [CALC] = computed &middot; ImplYld=((F/S)(1+SOFR*d/360)-1)*360/d &middot; FwdFwd Impl=compounded from outrights &middot; Spread bid=far_bid-near_ask</div>
        <div>IMM=3rd Wed Mar/Jun/Sep/Dec &middot; Spot:08-Apr-26 &middot; Fix=T-2 biz &middot; Val/Fix dates need LSEG calendar for local holidays</div>
      </div>
    </div>
  );
}

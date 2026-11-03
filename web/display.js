"use strict";

/* Coordinate helpers only. Acquisition, saved samples, filters and PSD are unchanged. */
const ResearchDisplay = (() => {
  const scales = [50,100,200,500,1000,5000,20000,100000,250000];
  function analyze(values) {
    let count=0, sum=0, min=Infinity, max=-Infinity;
    for (const value of values) if (Number.isFinite(value)) { count++; sum+=value; min=Math.min(min,value); max=Math.max(max,value); }
    if (!count) return {count:0,mean:0,min:0,max:0,constant:false,defaultRail:false};
    return {count,mean:sum/count,min,max,constant:count>1 && max===min,
      // The bridge resets Cyton to its default gain 24 before streaming.
      defaultRail:count>1 && (max<=-187499.5 || min>=187499.5)};
  }
  function fit(channelValues, centered=false) {
    let peak=0;
    for (const values of channelValues) {
      const stats=analyze(values), offset=centered?stats.mean:0;
      if (stats.count) peak=Math.max(peak,Math.abs(stats.min-offset),Math.abs(stats.max-offset));
    }
    return scales.find(scale=>scale>=peak*1.1) || scales[scales.length-1];
  }
  function voltage(value) { return Math.abs(value)>=1000 ? `${(value/1000).toFixed(1)} mV` : `${value.toFixed(1)} μV`; }
  return {analyze,fit,voltage};
})();
if (typeof module!=="undefined" && module.exports) module.exports=ResearchDisplay;

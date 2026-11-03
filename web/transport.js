"use strict";

/* The hosted demo never requests access to a visitor's localhost or USB devices. */
const ResearchTransport = (() => {
  class BrowserDemo {
    constructor(clock = () => performance.now(), wall = () => Date.now() / 1000) {
      this.clock = clock; this.wall = wall; this.rate = 250; this.channels = 16;
      this.info = {running:false, phase:"stopped", mode:"synthetic", sample_rate:250, channels:16, error:null, samples:0, recording:null};
      this.chunks = []; this.raw = []; this.events = []; this.pending = [];
      this.chunkSeq = this.eventSeq = this.markerId = 0;
      this.seed = 73019;
    }
    random() { this.seed = (1664525 * this.seed + 1013904223) >>> 0; return this.seed / 4294967296; }
    event(value) { this.events.push({...value, seq:++this.eventSeq}); }
    finish() {
      this.info.running = false; this.info.phase = "stopped"; this.info.ended_at = this.wall();
      for (const marker of this.pending) this.event({...marker, kind:"unobserved", ended_at:this.wall()});
      this.pending = [];
    }
    pump() {
      if (!this.info.running) return;
      // Ten minutes bounds the in-memory download; local acquisition has no such limit.
      const target = Math.min(this.rate * 600, Math.floor((this.clock() - this.anchor) * this.rate / 1000));
      while (this.info.samples < target) {
        const start = this.info.samples, count = Math.min(125, target - start);
        const chunk = {seq:++this.chunkSeq, sample_start_index:start, timestamps:[], eeg:Array.from({length:16},()=>[]), markers:[], package_numbers:[]};
        for (let j=0; j<count; j++) {
          const index = start+j, t=index/this.rate, timestamp=this.info.started_at+t;
          chunk.timestamps.push(timestamp); chunk.package_numbers.push(index%256);
          const marker = this.pending[0]?.eligible_sample_index <= index ? this.pending.shift() : null;
          chunk.markers.push(marker?.value || 0);
          for (let ch=0; ch<16; ch++) {
            const frequency = [10,12,8,15,6,18,22,4,10,12,8,15,6,18,22,4][ch];
            const signal = (18+ch%4*4)*Math.sin(2*Math.PI*frequency*t+ch*.37)+5*Math.sin(2*Math.PI*2*t)+3*(this.random()-.5);
            chunk.eeg[ch].push(signal);
          }
          if (marker) this.event({...marker, kind:"observed", observed_at:timestamp, received_at:this.wall(), observed_sample_index:index, observed_package_number:index%256});
        }
        this.info.samples += count;
        this.chunks.push(chunk); this.raw.push(chunk);
        while (this.chunks.length>1 && this.info.samples-this.chunks[0].sample_start_index>this.rate*30) this.chunks.shift();
      }
      if (this.info.samples >= this.rate*600) this.finish();
    }
    request(path, body) {
      const url = new URL(path, "http://demo.invalid");
      this.pump();
      if (url.pathname === "/api/status") return {...this.info};
      if (url.pathname === "/api/ports") return {ports:[]};
      if (url.pathname === "/api/data") return {chunks:this.chunks.filter(c=>c.seq>Number(url.searchParams.get("after")||0)),next_seq:this.chunkSeq};
      if (url.pathname === "/api/events") return {events:this.events.filter(e=>e.seq>Number(url.searchParams.get("after")||0)),next_seq:this.eventSeq};
      if (url.pathname === "/api/start") {
        if (body?.mode !== "synthetic") throw new Error("真实板采集需要下载并启动本地工作台。浏览器演示不会连接 USB。 ");
        if (this.info.running) throw new Error("已有模拟会话正在运行。");
        this.chunks=[]; this.raw=[]; this.events=[]; this.pending=[];
        this.chunkSeq=this.eventSeq=this.markerId=0; this.anchor=this.clock(); this.seed=73019;
        this.info={running:true, phase:"running", mode:"synthetic", sample_rate:250, channels:16, error:null, samples:0, started_at:this.wall(), recording:`browser-demo-${Math.round(this.wall()*1000)}`};
        return {ok:true,...this.info};
      }
      if (url.pathname === "/api/stop") { this.finish(); return {ok:true,...this.info}; }
      if (url.pathname === "/api/marker") {
        if (!this.info.running) throw new Error("请先开始模拟采集。");
        if (!Number.isInteger(body?.value) || body.value<1 || body.value>1000000 || typeof body?.label!=="string" || body.label.length>256) throw new Error("事件编号或名称无效。");
        const marker={event_id:++this.markerId, label:body.label, value:body.value, requested_at:this.wall(), eligible_sample_index:Math.ceil((this.clock()-this.anchor)*this.rate/1000)};
        this.event({...marker,kind:"requested"}); this.pending.push(marker); this.event({...marker,kind:"accepted",accepted_at:this.wall()});
        return {ok:true,event_id:marker.event_id,requested_at:marker.requested_at};
      }
      throw new Error("不支持的演示操作。");
    }
    recording() {
      if (this.info.running) throw new Error("请先停止采集，再下载演示数据。");
      if (!this.raw.length) throw new Error("本次演示还没有数据。");
      const parts = ["sample_index,timestamp_s,"+Array.from({length:16},(_,i)=>`CH${String(i+1).padStart(2,"0")}_uV`).join(",")+",marker\n"];
      for (const chunk of this.raw) {
        parts.push(chunk.timestamps.map((t,i)=>[chunk.sample_start_index+i,t,...chunk.eeg.map(channel=>channel[i]),chunk.markers[i]].join(",")).join("\n")+"\n");
      }
      return {blob:new Blob(parts,{type:"text/csv;charset=utf-8"}),filename:this.info.recording+".csv"};
    }
  }
  const browser = typeof location === "undefined" || location.protocol === "file:" || new URLSearchParams(location.search).get("demo") === "1" || !["localhost","127.0.0.1","[::1]"].includes(location.hostname);
  const demo = browser ? new BrowserDemo() : null;
  return {
    kind:browser?"browser":"local", BrowserDemo,
    async request(path, body, signal) {
      if (demo) return demo.request(path,body);
      const response = await fetch(path,{method:body===undefined?"GET":"POST",headers:body===undefined?{}:{"Content-Type":"application/json"},body:body===undefined?undefined:JSON.stringify(body),signal,cache:"no-store"});
      const result = await response.json();
      if (!response.ok || result.ok===false) throw new Error(result.error || `请求失败 (${response.status})`);
      return result;
    },
    async recording() {
      if (demo) return demo.recording();
      const response = await fetch("/api/recording",{cache:"no-store"});
      if (!response.ok) { const error=await response.json(); throw new Error(error.error || "无法下载记录。"); }
      return {blob:await response.blob(),filename:"OpenBCI-recording.zip"};
    }
  };
})();
if (typeof module!=="undefined" && module.exports) module.exports=ResearchTransport;

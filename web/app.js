"use strict";

/* Display processing is deliberately separate from the raw BrainFlow recording. */
const ResearchDSP = (() => {
  class ChannelFilter {
    constructor(sampleRate) {
      const dt = 1 / sampleRate;
      const highRc = 1 / (2 * Math.PI);
      const lowRc = 1 / (2 * Math.PI * 40);
      this.highAlpha = highRc / (highRc + dt);
      this.lowAlpha = dt / (lowRc + dt);
      this.notchEnabled = sampleRate > 100;
      const w = 2 * Math.PI * 50 / sampleRate;
      const alpha = Math.sin(w) / (2 * 30);
      this.b0 = 1 / (1 + alpha);
      this.b1 = -2 * Math.cos(w) / (1 + alpha);
      this.b2 = this.b0;
      this.a1 = this.b1;
      this.a2 = (1 - alpha) / (1 + alpha);
      this.reset();
    }
    reset() {
      this.initialized = false;
      this.previousInput = this.high = this.low = 0;
      this.rawNotch = [0, 0, 0, 0];
      this.bandNotch = [0, 0, 0, 0];
    }
    notch(value, history) {
      if (!this.notchEnabled) return value;
      const y = this.b0 * value + this.b1 * history[0] + this.b2 * history[1] - this.a1 * history[2] - this.a2 * history[3];
      history[1] = history[0]; history[0] = value;
      history[3] = history[2]; history[2] = y;
      return y;
    }
    process(value) {
      if (!Number.isFinite(value)) { this.reset(); return [NaN, NaN, NaN, NaN]; }
      if (!this.initialized) {
        this.previousInput = value;
        this.rawNotch.fill(value);
        this.initialized = true;
      }
      this.high = this.highAlpha * (this.high + value - this.previousInput);
      this.previousInput = value;
      this.low += this.lowAlpha * (this.high - this.low);
      return [value, this.low, this.notch(value, this.rawNotch), this.notch(this.low, this.bandNotch)];
    }
  }
  function spectrum(values, sampleRate) {
    const n = values.length;
    if (n < 3 || values.some(v => !Number.isFinite(v))) return null;
    const mean = values.reduce((a, b) => a + b, 0) / n;
    const windowed = new Float64Array(n);
    let windowEnergy = 0;
    for (let i = 0; i < n; i++) {
      const weight = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
      windowed[i] = (values[i] - mean) * weight;
      windowEnergy += weight * weight;
    }
    const result = [];
    for (let k = 0; k <= Math.floor(n / 2); k++) {
      let real = 0, imaginary = 0;
      for (let i = 0; i < n; i++) {
        const phase = 2 * Math.PI * k * i / n;
        real += windowed[i] * Math.cos(phase);
        imaginary -= windowed[i] * Math.sin(phase);
      }
      const oneSided = k === 0 || (n % 2 === 0 && k === n / 2) ? 1 : 2;
      const psd = oneSided * (real * real + imaginary * imaginary) / (sampleRate * windowEnergy);
      result.push({frequency: k * sampleRate / n, psd, db: 10 * Math.log10(Math.max(psd, 1e-12))});
    }
    return result;
  }
  return {ChannelFilter, spectrum};
})();

if (typeof module !== "undefined" && module.exports) module.exports = ResearchDSP;

if (typeof document !== "undefined") {
  const $ = id => document.getElementById(id);
  const browserDemo = ResearchTransport.kind === "browser";
  const state = {
    running: false, busy: false, sampleRate: 250, channels: 16, mode: "synthetic",
    phase: "stopped", nextSeq: 0, eventSeq: 0, session: 0, generation: 0,
    count: 0, writeIndex: 0, capacity: 2500, receivedSamples: 0, latestTimestamp: null,
    lastReceivedAt: null, data: [], filters: [], dataBusy: false, eventBusy: false,
    statusBusy: false, events: [], remoteEvents: [], remoteById: new Map(),
    experiment: null, localEventId: 0, spectrumDirty: true, apiConnected: false,
    displayGapCount: 0, sessionStartedAt: null, lastChunkSeq: null,
    recording: null, totalSamples: 0, sessionEndedAt: null, view: "acquisition", viewPaused: false
  };
  const modeLabels = {synthetic: "模拟信号", cyton_daisy: "Cyton + Daisy"};
  const phaseLabels = {starting: "正在连接", running: "采集中", stopping: "正在停止", stopped: "已停止", error: "采集异常"};
  const eventLabels = {scheduled: "已计划", cancelled: "已取消", requested: "请求中", accepted: "已入标记队列", observed: "已出现在采集样本", unobserved: "停止前未观测到", failed: "请求失败"};

  $("browserBanner").hidden = !browserDemo;
  $("environmentLabel").textContent = browserDemo ? "浏览器演示" : "本地工作台";
  if (browserDemo) {
    $("mode").querySelector('[value="cyton_daisy"]').disabled = true;
    $("recordHelp").textContent = "演示数据暂存于本页内存，单次最长 10 分钟。停止后下载 CSV；刷新会清除数据。";
    $("stop").textContent = "停止演示";
  }

  function configureBuffer(sampleRate, channels = 16) {
    const selectedChannel = $("spectrumChannel").value || "0";
    state.sampleRate = sampleRate;
    state.channels = channels;
    state.capacity = Math.ceil(sampleRate * 10);
    state.data = Array.from({length: 4}, () => Array.from({length: channels}, () => new Float64Array(state.capacity)));
    state.filters = Array.from({length: channels}, () => new ResearchDSP.ChannelFilter(sampleRate));
    state.count = state.writeIndex = state.receivedSamples = state.displayGapCount = 0;
    state.latestTimestamp = state.lastReceivedAt = null;
    state.lastChunkSeq = null;
    state.spectrumDirty = true;
    $("notch").disabled = sampleRate <= 100;
    if (sampleRate <= 100) $("notch").checked = false;
    $("spectrumChannel").replaceChildren(...Array.from({length: channels}, (_, index) => {
      const option = document.createElement("option");
      option.value = String(index); option.textContent = `CH ${String(index + 1).padStart(2, "0")}`;
      return option;
    }));
    if (Number(selectedChannel) < channels) $("spectrumChannel").value = selectedChannel;
  }
  configureBuffer(250);

  function notice(message, error = false) {
    $("notice").textContent = message;
    $("notice").classList.toggle("error", error);
  }
  async function api(path, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), path === "/api/start" ? 45000 : path === "/api/stop" ? 30000 : 10000);
    try {
      return await ResearchTransport.request(path, body, controller.signal);
    } catch (error) {
      if (error.name === "AbortError") throw new Error("本地服务响应超时，请检查采集服务窗口。");
      throw error;
    } finally { clearTimeout(timeout); }
  }
  function updateControls() {
    const active = state.running && !state.busy && state.apiConnected && state.phase === "running";
    const waiting = active && Date.now()/1000 - (state.lastReceivedAt || state.sessionStartedAt || Date.now()/1000) > 3;
    const phaseLabel = phaseLabels[state.busy ? state.running ? "stopping" : "starting" : state.phase] || state.phase;
    $("start").disabled = state.running || state.busy || !state.apiConnected;
    $("stop").disabled = !state.running || state.busy;
    $("mode").disabled = state.running || state.busy;
    $("sourceLockHint").hidden = browserDemo || (!state.running && !state.busy);
    $("sourceLockHint").textContent = state.busy ? state.running ? "正在停止并保存记录，结束后即可更换数据源。" : "正在连接数据源，请等待连接结束。" : "更换数据源：先点「停止并保存」，再选择数据源。暂停显示不会结束采集。";
    $("port").disabled = state.running || state.busy;
    $("refreshPorts").disabled = state.running || state.busy;
    $("eventA").disabled = $("eventB").disabled = !active;
    $("startExperiment").disabled = !active || !!state.experiment;
    $("cancelExperiment").disabled = !state.experiment;
    $("stimulusInterval").disabled = $("stimulusCount").disabled = !!state.experiment;
    $("sessionBadge").classList.toggle("running", active && !waiting);
    $("sessionBadge").classList.toggle("waiting", waiting);
    $("sessionBadge").classList.toggle("error", state.phase === "error");
    $("sessionState").textContent = state.apiConnected ? `${browserDemo ? "模拟演示" : modeLabels[state.mode] || state.mode} · ${waiting ? "等待新数据" : phaseLabel}` : "本地服务未连接";
    $("sampleRate").innerHTML = `${state.sampleRate} <small>Hz</small>`;
    $("channelCount").innerHTML = `${state.channels} <small>CH</small>`;
    $("waveEmpty").hidden = state.count > 0;
    $("sampleCount").textContent = state.totalSamples.toLocaleString();
    $("sourceSummary").textContent = browserDemo ? "浏览器模拟" : modeLabels[state.mode] || state.mode;
    $("connectionModeLabel").textContent = state.apiConnected ? waiting ? "等待新数据" : phaseLabel : "待连接";
    $("stepService").classList.toggle("ready", state.apiConnected);
    $("stepDevice").classList.toggle("ready", state.apiConnected && state.phase === "running");
    $("stepStream").classList.toggle("ready", active && !waiting && state.count > 0);
    $("streamNotice").hidden = !waiting;
    $("recordDot").classList.toggle("active", active && !waiting);
    $("recordState").textContent = state.busy ? state.running ? "正在保存记录" : "正在准备记录" : state.phase === "starting" ? "正在准备记录" : state.phase === "stopping" ? "正在关闭记录" : waiting ? "等待新样本" : active ? browserDemo ? "演示数据暂存中" : "原始数据保存中" : state.recording ? "采集记录已保留" : "尚未开始";
    $("downloadRecording").disabled = state.running || state.busy || !state.recording || !state.totalSamples || !state.apiConnected;
    $("pauseDisplay").disabled = !state.count || state.view !== "acquisition";
    $("pauseDisplay").setAttribute("aria-pressed", String(state.viewPaused));
    $("pauseLabel").textContent = state.viewPaused ? "继续显示" : "暂停显示";
    $("pausedOverlay").hidden = !state.viewPaused;
    $("waveLive").textContent = state.viewPaused ? "显示暂停" : !state.apiConnected ? "连接中断" : waiting ? "等待新数据" : state.running ? state.phase === "running" ? "实时" : "连接中" : state.count ? "已停止" : "等待数据";
    $("waveLive").classList.toggle("active", active && !waiting && !state.viewPaused);
    ["filter", "scale", "timeWindow", "spectrumChannel"].forEach(id => { $(id).disabled = state.viewPaused; });
    $("notch").disabled = state.viewPaused || state.sampleRate <= 100;
    $("centerRaw").disabled = state.viewPaused || $("filter").value !== "raw";
    $("fitSignal").disabled = state.viewPaused || !state.count;
    $("emptyTitle").textContent = state.phase === "error" ? "连接未建立" : state.phase === "starting" ? "正在连接数据源" : !state.apiConnected ? "等待本地采集服务" : "信号，从这里开始";
    $("emptyDescription").textContent = state.phase === "starting" ? "正在准备采集，请稍候。" : !state.apiConnected ? "请先启动本地工作台，再重新连接。" : "选择左侧数据源，点击「开始采集」。";
    $("experimentReadiness").textContent = waiting ? "正在等待新数据。请恢复数据流后再运行实验；此时发送的事件需等待后续样本。" : active ? "采集已就绪，可以发送事件或运行视觉刺激。" : "请先开始采集，再添加事件。";
    $("exportLog").disabled = !state.events.length && !state.remoteEvents.length;
    updateDuration();
  }
  function updateDuration() {
    const end = state.running ? Date.now() / 1000 : state.sessionEndedAt;
    const seconds = state.sessionStartedAt && end ? Math.max(0, Math.floor(end - state.sessionStartedAt)) : 0;
    $("sessionDuration").textContent = `${String(Math.floor(seconds/60)).padStart(2,"0")}:${String(seconds%60).padStart(2,"0")}`;
  }
  async function refreshPorts() {
    try {
      const result = await api("/api/ports");
      const selected = $("port").value;
      const ports = Array.isArray(result.ports) ? result.ports : [];
      $("port").replaceChildren(...(ports.length ? ports : [""]).map(port => {
        const option = document.createElement("option"); option.value = port;
        option.textContent = port || "未发现可用串口";
        if (port === selected) option.selected = true;
        return option;
      }));
    } catch (error) { notice(error.message, true); }
  }
  $("refreshPorts").addEventListener("click", refreshPorts);
  function describeSource(scan = false) {
    const hardware = $("mode").value === "cyton_daisy";
    $("portControls").hidden = !hardware;
    $("modeHelp").textContent = hardware ? "插入 USB 接收器，板子以电池供电并置于 PC。16 通道无线采样率为 125 Hz。" : browserDemo ? "浏览器生成 16 通道模拟数据，用于熟悉界面与实验流程。" : "BrainFlow 生成 16 通道模拟数据，无需连接硬件。";
    if (hardware && scan) refreshPorts();
  }
  $("mode").addEventListener("change", () => describeSource(true));
  describeSource();

  function recordingLabel(recording) {
    if (!recording) return "开始采集后创建独立记录。";
    if (browserDemo) return "当前浏览器中的模拟记录 · 停止后可下载 CSV";
    if (typeof recording === "string") return recording;
    return recording.directory || recording.path || recording.data_path || recording.raw || JSON.stringify(recording);
  }
  function applyStatus(result) {
    const previousPhase = state.phase, connectedBefore = state.apiConnected;
    const changed = !!result.recording && result.recording !== state.recording;
    state.apiConnected = true;
    const wasRunning = state.running;
    state.running = !!result.running;
    state.phase = result.phase || (state.running ? "running" : "stopped");
    state.mode = result.mode || state.mode;
    const rate = Number(result.sample_rate);
    const channels = Number(result.channels);
    if (changed) {
      cancelExperiment("采集会话已更换");
      state.generation++; state.session++; state.nextSeq = state.eventSeq = 0;
      state.recording = result.recording;
    }
    if (Number.isFinite(rate) && rate > 0 && (changed || rate !== state.sampleRate || (channels > 0 && channels !== state.channels))) configureBuffer(rate, channels > 0 ? channels : 16);
    if (wasRunning && !state.running) { cancelExperiment("采集已停止"); state.viewPaused = false; }
    if (state.running || changed || !connectedBefore && result.recording) {
      $("mode").value = state.mode; describeSource();
      if (state.mode === "cyton_daisy" && !$("port").value) refreshPorts();
      if (result.serial_port) {
        if (!Array.from($("port").options).some(o => o.value === result.serial_port)) $("port").add(new Option(result.serial_port, result.serial_port));
        $("port").value = result.serial_port;
      }
    }
    state.totalSamples = Number(result.samples) || 0;
    state.sessionStartedAt = result.started_at || null;
    state.sessionEndedAt = result.ended_at || null;
    $("recordingPath").textContent = recordingLabel(result.recording);
    $("connectionStatus").textContent = browserDemo ? "浏览器内运行 · 无采集数据上传" : "本地服务已连接 · 127.0.0.1";
    if (result.error) notice(String(result.error), true);
    else if (changed || previousPhase !== state.phase || !connectedBefore) {
      notice(state.phase === "running" ? browserDemo ? "模拟采集中。停止后下载演示数据；刷新页面会清除内存记录。" : "采集已连接。原始数据持续保存，显示设置不会改变记录。" : state.phase === "starting" ? "正在连接数据源并准备记录，请稍候。" : state.recording ? "采集已停止。可下载记录，或继续新的采集。" : "已就绪。选择数据源，开始一次采集。");
    }
    updateControls();
  }
  async function pollStatus() {
    if (state.statusBusy || state.busy) return;
    state.statusBusy = true;
    const generation = state.generation;
    try {
      const result = await api("/api/status");
      if (generation !== state.generation) return;
      applyStatus(result);
    } catch (error) {
      if (generation !== state.generation) return;
      state.apiConnected = false;
      cancelExperiment("本地服务连接中断");
      $("connectionStatus").textContent = "本地服务连接中断";
      notice(`无法连接本地服务：${error.message}`, true);
      updateControls();
    } finally { state.statusBusy = false; }
  }
  $("start").addEventListener("click", async () => {
    const mode = $("mode").value, port = $("port").value;
    if (mode === "cyton_daisy" && !port) { notice("请选择 USB 接收器串口。", true); return; }
    state.busy = true; state.generation++; updateControls();
    notice("正在准备采集与原始记录…");
    try {
      await api("/api/start", {mode, port});
      state.mode = mode;
      state.viewPaused = false;
      applyStatus(await api("/api/status"));
    } catch (error) { notice(error.message, true); }
    finally { state.busy = false; updateControls(); pollStatus(); pollData(); pollEvents(); }
  });
  $("stop").addEventListener("click", async () => {
    state.busy = true; cancelExperiment("用户停止采集"); updateControls();
    notice("正在停止采集并关闭记录文件…");
    try {
      await api("/api/stop", {});
      applyStatus(await api("/api/status"));
      notice(browserDemo ? "演示已停止。可下载模拟数据和事件日志。" : "采集已停止，原始记录已保存。可下载记录和事件日志。");
    } catch (error) { notice(error.message, true); }
    finally { state.busy = false; updateControls(); pollData(); pollEvents(); }
  });

  function appendSample(values) {
    for (let ch = 0; ch < state.channels; ch++) {
      const variants = state.filters[ch].process(values[ch]);
      for (let variant = 0; variant < 4; variant++) state.data[variant][ch][state.writeIndex] = variants[variant];
    }
    state.writeIndex = (state.writeIndex + 1) % state.capacity;
    state.count = Math.min(state.count + 1, state.capacity);
  }
  function ingest(chunk) {
    if (!Array.isArray(chunk.timestamps) || !Array.isArray(chunk.eeg)) return;
    const n = chunk.timestamps.length;
    for (let i = 0; i < n; i++) {
      const timestamp = chunk.timestamps[i];
      if (!Number.isFinite(timestamp)) continue;
      if (state.latestTimestamp !== null && (timestamp <= state.latestTimestamp || timestamp - state.latestTimestamp > 3 / state.sampleRate)) {
        appendSample(Array(state.channels).fill(NaN));
        state.displayGapCount++;
      }
      appendSample(Array.from({length: state.channels}, (_, ch) => chunk.eeg[ch]?.[i]));
      state.latestTimestamp = timestamp;
      state.receivedSamples++;
    }
    if (n) {
      state.lastReceivedAt = Date.now() / 1000;
      $("sampleTime").textContent = `最新样本：${clockText(state.latestTimestamp)}`;
      $("receivedTime").textContent = `本机接收：${clockText(state.lastReceivedAt)}`;
      state.spectrumDirty = true;
    }
  }
  function clearDisplayHistory() {
    state.count = state.writeIndex = 0;
    state.latestTimestamp = null;
    for (const filter of state.filters) filter.reset();
    state.displayGapCount++;
    state.spectrumDirty = true;
    notice("显示缓存出现间断，已清空旧波形和滤波状态。此提示不代表硬件丢包；原始记录由后端持续保存。");
  }
  async function pollData() {
    if (state.dataBusy || state.busy || !state.apiConnected) return;
    state.dataBusy = true;
    const generation = state.generation;
    try {
      const result = await api(`/api/data?after=${state.nextSeq}`);
      if (generation !== state.generation) return;
      for (const chunk of result.chunks || []) {
        if (Number.isFinite(chunk.seq)) {
          if (state.lastChunkSeq !== null && chunk.seq <= state.lastChunkSeq) continue;
          if (state.lastChunkSeq !== null && chunk.seq > state.lastChunkSeq + 1) clearDisplayHistory();
          state.lastChunkSeq = chunk.seq;
        }
        ingest(chunk);
      }
      if (Number.isFinite(result.next_seq)) state.nextSeq = result.next_seq;
      updateControls();
    } catch (error) { if (state.running && generation === state.generation) notice(`数据接收中断：${error.message}`, true); }
    finally { state.dataBusy = false; }
  }
  function variantIndex() { return ($("filter").value === "bandpass" ? 1 : 0) + ($("notch").checked ? 2 : 0); }
  function recentValues(channel, count, variant = variantIndex()) {
    const n = Math.min(count, state.count);
    const start = (state.writeIndex - n + state.capacity) % state.capacity;
    return Array.from({length: n}, (_, i) => state.data[variant][channel][(start + i) % state.capacity]);
  }
  ["filter", "notch", "spectrumChannel", "centerRaw"].forEach(id => $(id).addEventListener("change", () => {
    state.spectrumDirty = true;
    updateFilterBadge(); updateControls();
  }));
  function updateFilterBadge() {
    $("filterBadge").textContent = `${$("filter").value === "bandpass" ? "1–40 Hz" : $("centerRaw").checked ? "原始信号 · 居中显示" : "原始信号 · 绝对电压"}${$("notch").checked ? " + 50 Hz 陷波" : ""}`;
  }
  $("fitSignal").addEventListener("click", () => {
    const n=Math.round(state.sampleRate*Number($("timeWindow").value));
    const values=Array.from({length:state.channels},(_,ch)=>recentValues(ch,n));
    $("scale").value=String(ResearchDisplay.fit(values,$("filter").value === "raw" && $("centerRaw").checked));
    saveDisplay();
  });

  const viewCopy = {
    acquisition:["从连接到信号。","查看实时波形，确认数据状态，再开始实验。"],
    experiment:["让事件与数据对齐。","发送手动标记，运行视觉刺激，保留完整的实验日志。"],
    guide:["从体验，到自己的实验。","了解本地采集、在线演示与分发方式。"]
  };
  function showView(view) {
    if (!viewCopy[view]) return;
    if (view !== "experiment") cancelExperiment("已离开刺激工作区，范式已取消");
    state.view = view;
    document.querySelectorAll("[data-view]").forEach(button => {
      button.classList.toggle("active", button.dataset.view === view);
      if (button.dataset.view === view) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    document.querySelectorAll("[data-panel]").forEach(panel => { panel.hidden = panel.dataset.panel !== view; });
    $("viewTitle").textContent = viewCopy[view][0]; $("viewDescription").textContent = viewCopy[view][1];
    state.spectrumDirty = true; updateControls();
  }
  document.querySelectorAll("[data-view]").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
  $("goAcquisition").addEventListener("click", () => showView("acquisition"));
  $("pauseDisplay").addEventListener("click", () => { state.viewPaused = !state.viewPaused; state.spectrumDirty = true; updateControls(); });
  const preferenceIds = ["filter", "scale", "timeWindow", "spectrumChannel"];
  function saveDisplay() {
    try { localStorage.setItem("openbci-display-v2", JSON.stringify(Object.fromEntries([...preferenceIds.map(id => [id,$(id).value]),["notch",$("notch").checked],["centerRaw",$("centerRaw").checked]]))); } catch (_) { /* Storage can be unavailable in private/file contexts. */ }
  }
  [...preferenceIds,"notch","centerRaw"].forEach(id => $(id).addEventListener("change", saveDisplay));
  $("waveform").addEventListener("click", event => {
    if (state.viewPaused) return;
    const bounds = $("waveform").getBoundingClientRect();
    const channel = Math.floor((event.clientY-bounds.top-5)/(bounds.height-28)*state.channels);
    if (channel < 0 || channel >= state.channels) return;
    $("spectrumChannel").value = String(channel); state.spectrumDirty = true; saveDisplay();
  });
  let toastTimer;
  function toast(message, error = false) {
    clearTimeout(toastTimer); $("downloadStatus").textContent = message;
    $("downloadStatus").classList.toggle("error", error); $("downloadStatus").hidden = false;
    toastTimer = setTimeout(() => { $("downloadStatus").hidden = true; }, 5000);
  }
  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  $("downloadRecording").addEventListener("click", async () => {
    $("downloadRecording").disabled = true; toast("正在整理采集记录…");
    try { const result = await ResearchTransport.recording(); saveBlob(result.blob,result.filename); toast("采集记录已准备好，下载由浏览器处理。"); }
    catch (error) { toast(error.message,true); }
    finally { updateControls(); }
  });

  function canvasContext(canvas) {
    const width = canvas.clientWidth, height = canvas.clientHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    }
    const context = canvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    return {context, width, height};
  }
  function drawWaveform() {
    if (!$("waveform").clientWidth) return;
    const {context: ctx, width, height} = canvasContext($("waveform"));
    const left = 76, right = 15, top = 5, bottom = 23;
    const plotWidth = width - left - right, rowHeight = (height - top - bottom) / state.channels;
    const seconds = Number($("timeWindow").value);
    const scale = Number($("scale").value), windowSamples = Math.round(state.sampleRate * seconds);
    ctx.font = "9px SFMono-Regular, Consolas, monospace";
    for (let second = 0; second <= seconds; second++) {
      const x = left + plotWidth * second / seconds;
      ctx.strokeStyle = "#eee7f2"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, height - bottom); ctx.stroke();
      ctx.fillStyle = "#9c8aa5"; ctx.textAlign = second === seconds ? "right" : "center";
      ctx.fillText(second === seconds ? "0 s" : `−${seconds - second}`, x, height - 7);
    }
    const variant = variantIndex();
    const centered=$("filter").value === "raw" && $("centerRaw").checked;
    let clippedChannels=0, railChannels=0, constantChannels=0;
    for (let ch = 0; ch < state.channels; ch++) {
      const values = recentValues(ch, windowSamples, variant);
      const stats=ResearchDisplay.analyze(values), offset=centered?stats.mean:0;
      const rawStats=variant===0?stats:ResearchDisplay.analyze(recentValues(ch,windowSamples,0));
      const rail=state.mode === "cyton_daisy" && rawStats.defaultRail;
      const clipped=stats.count>0 && Math.max(Math.abs(stats.min-offset),Math.abs(stats.max-offset))>scale;
      if (clipped) clippedChannels++;
      if (rail) railChannels++;
      if (rawStats.constant) constantChannels++;
      const y = top + rowHeight * (ch + 0.5);
      if (ch === Number($("spectrumChannel").value)) { ctx.fillStyle = "#f4eef7"; ctx.fillRect(left,top+rowHeight*ch,plotWidth,rowHeight); }
      ctx.textAlign = "left"; ctx.fillStyle = ch < 8 ? "#795a83" : "#9980a6";
      ctx.font="9px SFMono-Regular, Consolas, monospace";
      ctx.fillText(`CH ${String(ch + 1).padStart(2, "0")}`, 10, y - 2);
      ctx.font="7px SFMono-Regular, Consolas, monospace";
      ctx.fillStyle=rail?"#ae7846":"#a28fa9";
      ctx.fillText(stats.count?ResearchDisplay.voltage(stats.mean):"",10,y+9);
      ctx.strokeStyle = "#eee7f2"; ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke();
      ctx.save(); ctx.beginPath(); ctx.rect(left, y-rowHeight*.44, plotWidth, rowHeight*.88); ctx.clip();
      ctx.strokeStyle = ch < 8 ? "#660874" : "#9a78b0"; ctx.lineWidth = 1.1;
      ctx.beginPath(); let penDown = false;
      for (let i = 0; i < values.length; i++) {
        if (!Number.isFinite(values[i])) { penDown = false; continue; }
        const x = left + plotWidth * (windowSamples - values.length + i) / (windowSamples - 1);
        const yy = y - (values[i]-offset) / scale * rowHeight * 0.44;
        if (penDown) ctx.lineTo(x, yy); else { ctx.moveTo(x, yy); penDown = true; }
      }
      ctx.stroke(); ctx.restore();
      if (clipped) { ctx.font="8px -apple-system, sans-serif"; ctx.fillStyle="#a97545"; ctx.textAlign="right"; ctx.fillText("超量程",width-right-4,y-4); }
    }
    const message=railChannels ? `${railChannels} 个通道接近默认输入量程边界（约 ±187.5 mV）。当前输入已饱和，滤波或居中不能恢复有效信号；请检查电极、参考与 BIAS。` : clippedChannels ? `${clippedChannels} 个通道超出当前显示量程。点击「适应信号」可调整量程；开启「原始信号居中显示」可观察偏置附近的变化。` : constantChannels && state.count>state.sampleRate ? `${constantChannels} 个通道当前数值恒定。平线只表示没有数值变化，不代表输入质量正常。` : "";
    $("rangeNotice").hidden=!message;
    if ($("rangeNotice").textContent!==message) $("rangeNotice").textContent=message;
  }
  function drawSpectrum() {
    if (!$("spectrum").clientWidth) return;
    const {context: ctx, width, height} = canvasContext($("spectrum"));
    const left = 49, right = 18, top = 24, bottom = 30;
    const w = width - left - right, h = height - top - bottom;
    const n = Math.round(state.sampleRate * 2);
    const values = recentValues(Number($("spectrumChannel").value), n);
    const bins = values.length === n ? ResearchDSP.spectrum(values, state.sampleRate) : null;
    const maxFrequency = Math.min(60, state.sampleRate / 2);
    const relevant = bins?.filter(bin => bin.frequency <= maxFrequency);
    const maxDb = relevant ? Math.max(...relevant.map(bin => bin.db)) : 20;
    const ceiling = Math.max(-20, Math.ceil(maxDb / 10) * 10), floor = ceiling - 70;
    ctx.font = "9px SFMono-Regular, Consolas, monospace";
    ctx.fillStyle = "#887792"; ctx.fillText("dB re 1 μV²/Hz", left, 11);
    for (let i = 0; i <= 7; i++) {
      const y = top + h * i / 7;
      ctx.strokeStyle = "#eee7f2"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke();
      ctx.textAlign = "right"; ctx.fillStyle = "#94829e"; ctx.fillText(String(ceiling - i * 10), left - 9, y + 3);
    }
    for (let frequency = 0; frequency <= maxFrequency; frequency += 10) {
      const x = left + frequency / maxFrequency * w;
      ctx.textAlign = "center"; ctx.fillStyle = "#94829e"; ctx.fillText(String(frequency), x, height - 13);
    }
    ctx.textAlign = "right"; ctx.fillText("Hz", width - 2, height - 13);
    if (relevant) {
      ctx.save(); ctx.beginPath(); ctx.rect(left, top, w, h); ctx.clip();
      ctx.strokeStyle = "#660874"; ctx.lineWidth = 1.6; ctx.beginPath();
      relevant.forEach((bin, i) => {
        const x = left + bin.frequency / maxFrequency * w, y = top + (ceiling - bin.db) / (ceiling - floor) * h;
        if (!i) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.stroke(); ctx.restore();
      $("spectrumNote").textContent = `最近 2 秒 · Hann 窗 · ${state.sampleRate / n} Hz 分辨率 · PSD：μV²/Hz（对数显示）`;
    } else {
      ctx.fillStyle = "#a08faa"; ctx.textAlign = "center"; ctx.font = "11px -apple-system, sans-serif";
      ctx.fillText(state.count >= n ? "数据窗存在间断，等待连续样本" : "等待连续 2 秒数据", left + w / 2, top + h / 2);
      $("spectrumNote").textContent = "最近 2 秒 · Hann 窗 · 等待完整数据窗";
    }
  }

  function clockText(unixSeconds) {
    if (!Number.isFinite(unixSeconds)) return "—";
    const d = new Date(unixSeconds * 1000);
    return `${d.toLocaleTimeString("zh-CN", {hour12: false})}.${String(d.getMilliseconds()).padStart(3, "0")}`;
  }
  function createEvent(label, value, source, extra = {}) {
    const event = {local_id: ++state.localEventId, session: state.session, label, value, source, status: "scheduled", created_wall_unix_s: Date.now() / 1000, created_performance_ms: performance.now(), ...extra};
    state.events.push(event); renderEvents(); return event;
  }
  function mergeRemote(event, remote) {
    if (!remote) return;
    event.status = remote.kind;
    event.backend = {...event.backend, ...remote};
  }
  async function requestMarker(event) {
    if (!state.running || state.busy || !state.apiConnected || state.phase !== "running") { event.status = "cancelled"; event.reason = "采集未就绪"; renderEvents(); return; }
    event.request_performance_ms = performance.now();
    event.request_wall_unix_s = Date.now() / 1000;
    event.status = "requested"; renderEvents();
    try {
      const result = await api("/api/marker", {label: event.label, value: event.value});
      event.response_performance_ms = performance.now();
      event.event_id = result.event_id;
      event.backend_requested_at = result.requested_at;
      event.status = "accepted";
      mergeRemote(event, state.remoteById.get(`${event.session}:${event.event_id}`));
    } catch (error) {
      event.status = "failed"; event.error = error.message;
      notice(`事件标记失败：${error.message}`, true);
    }
    renderEvents();
  }
  function manualMarker(value, source) {
    if (!state.running || state.busy || !state.apiConnected || state.phase !== "running") return;
    requestMarker(createEvent(value === 1 ? "事件 A" : "事件 B", value, source));
  }
  $("eventA").addEventListener("click", () => manualMarker(1, "button"));
  $("eventB").addEventListener("click", () => manualMarker(2, "button"));
  document.addEventListener("keydown", event => {
    const target = event.target;
    if (event.code !== "Space" || event.repeat || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || !state.running || state.busy || !state.apiConnected || state.phase !== "running" || state.view !== "experiment" || document.hidden) return;
    if (target instanceof Element && (target.closest("input,textarea,select,button,a,[contenteditable]") || target.isContentEditable)) return;
    event.preventDefault(); manualMarker(1, "keyboard_space");
  });
  async function pollEvents() {
    if (state.eventBusy || state.busy || !state.apiConnected) return;
    state.eventBusy = true;
    const generation = state.generation, session = state.session;
    try {
      const result = await api(`/api/events?after=${state.eventSeq}`);
      if (generation !== state.generation) return;
      for (const remote of result.events || []) {
        state.remoteEvents.push({...remote, frontend_session: session});
        const key = `${session}:${remote.event_id}`;
        const merged = {...state.remoteById.get(key), ...remote};
        state.remoteById.set(key, merged);
        const local = state.events.find(event => event.session === session && event.event_id === remote.event_id);
        mergeRemote(local || {}, merged);
      }
      if (Number.isFinite(result.next_seq)) state.eventSeq = result.next_seq;
      if (result.events?.length) renderEvents();
    } catch (_) { /* Connection state is reported by the status poll. */ }
    finally { state.eventBusy = false; }
  }
  function cancelExperiment(reason = "用户取消") {
    const run = state.experiment;
    if (!run) return;
    for (const timer of run.timers) clearTimeout(timer);
    for (const frame of run.frames) cancelAnimationFrame(frame);
    for (const event of run.events) if (event.status === "scheduled") { event.status = "cancelled"; event.reason = reason; }
    state.experiment = null;
    $("stimulus").classList.remove("flash");
    $("stimulusState").textContent = reason;
    updateControls(); renderEvents();
  }
  $("cancelExperiment").addEventListener("click", () => cancelExperiment());
  $("startExperiment").addEventListener("click", () => {
    if (!state.running || state.busy || !state.apiConnected || state.phase !== "running" || state.experiment) return;
    const interval = Number($("stimulusInterval").value), count = Number($("stimulusCount").value);
    if (!Number.isFinite(interval) || interval < 0.5 || interval > 60 || !Number.isInteger(count) || count < 1 || count > 100) { notice("请输入 0.5–60 秒间隔和 1–100 次刺激。", true); return; }
    const anchorPerformance = performance.now(), anchorWall = Date.now() / 1000;
    const run = {id: `visual-${Date.now()}`, timers: new Set(), frames: new Set(), events: [], fired: 0};
    state.experiment = run; $("stimulusState").textContent = "准备中";
    for (let i = 0; i < count; i++) {
      const plannedPerformance = anchorPerformance + 1000 + i * interval * 1000;
      const event = createEvent(`视觉刺激 ${i + 1}`, 1, "visual_stimulus", {experiment_id: run.id, trial: i + 1, planned_performance_ms: plannedPerformance, planned_wall_unix_s: anchorWall + (plannedPerformance - anchorPerformance) / 1000});
      run.events.push(event);
      const timer = setTimeout(() => {
        run.timers.delete(timer);
        if (state.experiment !== run) return;
        const frame = requestAnimationFrame(frameTimestamp => {
          run.frames.delete(frame);
          if (state.experiment !== run || !state.running || document.hidden) return;
          event.raf_callback_performance_ms = performance.now();
          event.raf_timestamp_ms = frameTimestamp;
          event.draw_callback_wall_unix_s = Date.now() / 1000;
          $("stimulus").classList.add("flash");
          run.fired++;
          $("stimulusState").textContent = `${run.fired} / ${count}`;
          requestMarker(event);
          const offTimer = setTimeout(() => {
            run.timers.delete(offTimer);
            if (state.experiment !== run) return;
            $("stimulus").classList.remove("flash");
            if (run.fired === count) { state.experiment = null; $("stimulusState").textContent = "已完成"; updateControls(); }
          }, 150);
          run.timers.add(offTimer);
        });
        run.frames.add(frame);
      }, Math.max(0, plannedPerformance - performance.now()));
      run.timers.add(timer);
    }
    updateControls();
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) cancelExperiment("页面进入后台，范式已取消"); });
  window.addEventListener("pagehide", () => cancelExperiment("页面关闭"));

  function renderEvents() {
    $("eventCount").textContent = state.events.length;
    $("navEventCount").textContent = state.events.length;
    $("exportLog").disabled = !state.events.length && !state.remoteEvents.length;
    if (!state.events.length) return;
    const rows = state.events.slice(-30).reverse().map(event => {
      const row = document.createElement("tr");
      const delay = Number.isFinite(event.raf_callback_performance_ms) ? `${(event.raf_callback_performance_ms - event.planned_performance_ms).toFixed(2)} ms` : "—";
      const values = [`${event.label} · ${event.value}`, clockText(event.planned_wall_unix_s || event.created_wall_unix_s), delay, clockText(event.request_wall_unix_s), eventLabels[event.status] || event.status];
      values.forEach((text, index) => {
        const cell = document.createElement("td");
        if (index === 4) {
          const span = document.createElement("span"); span.className = `event-state ${event.status}`; span.textContent = text; cell.append(span);
          if (event.backend?.observed_at) cell.title = `样本时间：${clockText(event.backend.observed_at)}`;
          if (event.error || event.reason) cell.title = event.error || event.reason;
        } else cell.textContent = text;
        row.append(cell);
      });
      return row;
    });
    $("eventRows").replaceChildren(...rows);
  }
  $("exportLog").addEventListener("click", () => {
    const payload = {
      schema: "openbci-research-browser-events/v1", exported_at: new Date().toISOString(),
      timing_notes: {performance_ms: "Browser performance.now() milliseconds relative to performance.timeOrigin; only comparable within this page session.", wall_unix_s: "System wall clock in Unix seconds.", raf_callback: "Callback time before browser paint, NOT measured physical display onset.", observed_at: "BrainFlow timestamp of a sample carrying the software marker; NOT a hardware trigger timestamp."},
      performance_time_origin_unix_ms: performance.timeOrigin,
      latest_session: {session: state.session, mode: state.mode, sample_rate_hz: state.sampleRate, channels: state.channels, started_at_unix_s: state.sessionStartedAt},
      display: {bandpass: $("filter").value, notch_50hz: $("notch").checked, raw_plot_centered: $("filter").value === "raw" && $("centerRaw").checked, scale_uv: Number($("scale").value), time_window_s: Number($("timeWindow").value), does_not_modify_raw_recording: true, detected_timestamp_discontinuities: state.displayGapCount},
      events: state.events, backend_events: state.remoteEvents
    };
    payload.data_source = browserDemo ? "browser-generated simulation, not BrainFlow or hardware" : "local BrainFlow acquisition";
    saveBlob(new Blob([JSON.stringify(payload,null,2)],{type:"application/json"}),`OpenBCI-experiment-${new Date().toISOString().replace(/[:.]/g,"-")}.json`);
    toast("事件日志已准备好，下载由浏览器处理。");
  });

  let lastDraw = 0, lastSpectrum = 0;
  function animate(timestamp) {
    if (state.view === "acquisition" && !state.viewPaused) {
      if (timestamp - lastDraw >= 40) { drawWaveform(); lastDraw = timestamp; }
      if (timestamp - lastSpectrum >= 500 || state.spectrumDirty && !state.running) { drawSpectrum(); lastSpectrum = timestamp; state.spectrumDirty = false; }
    }
    requestAnimationFrame(animate);
  }
  window.addEventListener("resize", () => { state.spectrumDirty = true; });
  try {
    const saved = JSON.parse(localStorage.getItem("openbci-display-v2") || "null");
    if (saved) {
      for (const id of preferenceIds) if (Array.from($(id).options).some(o => o.value === saved[id])) $(id).value = saved[id];
      if (typeof saved.notch === "boolean") $("notch").checked = saved.notch;
      if (typeof saved.centerRaw === "boolean") $("centerRaw").checked = saved.centerRaw;
    }
  } catch (_) { /* Display preferences are optional. */ }
  updateFilterBadge();
  updateControls();
  pollStatus();
  setInterval(updateDuration, 1000);
  setInterval(pollStatus, 1200);
  setInterval(pollData, 200);
  setInterval(pollEvents, 250);
  requestAnimationFrame(animate);
}

/* app.js — App: wires the modules to the DOM. Split into sections:
 *   1. state, boot, dialogs, audio loading, peaks/cache/progress
 *   2. notes: creation, selection, drag, editor, list, layers, grid panel, transport UI
 *   3. save/load/autosave/relink, exports, AI, settings, keyboard shortcuts */
'use strict';

class App {
  constructor(host) {
    if (!host) {
      host = {
        mode: 'legacy', localFiles: true, loops: true, ai: true, available: true,
        createPersistence: () => new Persistence(), cache: PeakCache,
      };
    }
    this.host = host; this.disposed = false; this.cache = host.cache;
    this.$ = (id) => document.getElementById(id);
    this.file = null; this.info = null; this.descriptors = null; this.analysis = null;
    this.peakStore = new PeakStore();
    this.store = new NoteStore();
    this.grid = new Grid({ bpm: 108 });
    this.persist = host.createPersistence();
    this.settings = { snap: 'bar', snapOn: false, follow: true, split: true, gridLines: true, analysis: false };
    this.selection = null; this.selectedNoteId = null; this.activeLayerId = null;
    this.editing = null; this.dirty = false; this.job = null;
    this.worker = null;
    this.audioCtxFallback = null;
    this.filters = { layerId: '', category: '', status: '', search: '', sort: 'time' };
    this.mode = 'track'; this.loopLab = null;
    this._autosave = U.debounce(() => this.autosaveNow(), 400);
  }

  /* ================= 1. boot ================= */
  init() {
    this.transport = new Transport(this.$('audio'));
    this.view = new WaveformView({ overview: this.$('overview'), ruler: this.$('ruler'), main: this.$('main'), container: this.$('mainWrap') });
    this.view.setGrid(this.grid);
    this.store.ensureDefaultLayer(); this.activeLayerId = this.store.layers[0].id;
    this.store.onChange((ev) => this.onStoreChange(ev));
    try { this.worker = new PeakWorker(); } catch (e) { console.error(e); this.toast('Web Workers unavailable: ' + e.message, { error: true }); }
    this.bindView(); this.bindTransport(); this.bindToolbar(); this.bindPanels(); this.bindEditor(); this.bindGridPanel(); if (this.host.ai) this.bindAi(); this.bindSettings(); this.bindShortcuts(); this.bindDragDrop();
    document.body.dataset.mode = 'track';
    this.$('btnModeTrack')?.addEventListener('click', () => this.setMode('track'));
    this.$('btnModeLoops')?.addEventListener('click', () => this.setMode('loops'));
    if (this.host.loops) try { this.loopLab = new LoopLab(this); this.loopLab.init(); } catch (e) { console.error('Loop Lab failed to start', e); this.toast('Loop Lab failed to start: ' + e.message, { error: true }); }
    this.renderAll();
    this.view.draw();
    if (!this.persist.hasFsAccess) this.$('saveTarget').textContent = '(saves download as a file)';
    const requestedLibrary = LibraryLoader.requestedName();
    if (this.loopLab && requestedLibrary) this.loopLab.autoOpenLibrary(requestedLibrary).then((ok) => { if (ok) document.title = `${this.loopLab.lib.session.name} — Note`; });
    window.addEventListener('beforeunload', (e) => { if (this.dirty || (this.loopLab && this.loopLab.dirty)) { e.preventDefault(); e.returnValue = ''; } });
  }
  dispose() {
    this.disposed = true; this.host.available = false;
    this.cancelJob(); this.transport.unload();
    this.worker?.worker.terminate();
    if (this.worker?._url) URL.revokeObjectURL(this.worker._url);
    this.file = null; this.info = null; this.descriptors = null; this.analysis = null;
    this.dirty = false;
    this.store = new NoteStore(); this.peakStore = new PeakStore(); this.editing = null;
    this.selectedNoteId = null; this.selection = null;
    this.persist.savedText = null; this.persist.extra = { doc: {}, track: {} }; this.persist.history = []; this.persist.saveHandle = null;
    this.view.info = null; this.view.peaks = null; this.view.notes = []; this.view.handlers = {};
    this.view._cache = { key: null, grey: null, accent: null }; this.view._ro?.disconnect();
    this.view.totalFrames = 0; this.view.analysisRows = null;
    this.audioCtxFallback?.close().catch(() => {});
  }
  /** Track ↔ Loop Lab. Each mode keeps its own document; switching pauses the other's playback. */
  setMode(mode) {
    if (mode === this.mode || (!this.host.loops && mode !== 'track')) return;
    this.mode = mode; document.body.dataset.mode = mode;
    this.$('btnModeTrack').classList.toggle('active', mode === 'track'); this.$('btnModeTrack').setAttribute('aria-selected', String(mode === 'track'));
    this.$('btnModeLoops').classList.toggle('active', mode === 'loops'); this.$('btnModeLoops').setAttribute('aria-selected', String(mode === 'loops'));
    this.$('loopLab').hidden = mode !== 'loops';
    if (mode === 'loops') { this.transport.pause(); if (this.loopLab) this.loopLab.activate(); }
    else { if (this.loopLab) this.loopLab.deactivate(); this.view._resize(); this.view._invalidate(); this.view.requestDraw(); }
  }

  /* ---------- small UI helpers ---------- */
  toast(msg, { error = false, ms = 3500 } = {}) {
    if (this.disposed) return;
    const t = this.$('toast'); t.textContent = msg; t.classList.toggle('error', !!error); t.hidden = false;
    clearTimeout(this._toastT); this._toastT = setTimeout(() => { t.hidden = true; }, ms);
    if (error) console.warn(msg);
  }
  banner(html, { error = false, actions = [] } = {}) {
    if (this.disposed) return;
    const b = this.$('banner'); b.innerHTML = ''; b.classList.toggle('error', !!error);
    if (html === null) { b.hidden = true; return; }
    b.append(U.el('span', { html }));
    const row = U.el('div', { class: 'row' });
    for (const a of actions) row.append(U.el('button', { class: a.primary ? 'primary' : '', text: a.label, onClick: () => { b.hidden = true; a.onClick && a.onClick(); } }));
    row.append(U.el('button', { class: 'tiny', text: '✕', title: 'Dismiss', onClick: () => { b.hidden = true; } }));
    b.append(row); b.hidden = false;
  }
  /** Modal confirm: body may be a string or an Element; returns the chosen button value (null on Esc). */
  confirm({ title, body, buttons }) {
    return new Promise((resolve) => {
      const d = this.$('dlgConfirm'); this.$('cfTitle').textContent = title;
      const cb = this.$('cfBody'); cb.innerHTML = ''; cb.append(body instanceof Node ? body : document.createTextNode(String(body)));
      const row = this.$('cfButtons'); row.innerHTML = '';
      const done = (v) => { d.close(); resolve(v); };
      for (const b of buttons) { const btn = U.el('button', { type: 'button', class: (b.primary ? 'primary ' : '') + (b.danger ? 'danger' : ''), text: b.label, onClick: () => done(b.value) }); row.append(btn); }
      d.oncancel = (e) => { e.preventDefault(); done(null); };
      d.showModal();
      const first = row.querySelector('.primary') || row.querySelector('button'); if (first) first.focus();
    });
  }
  errorList(title, intro, items) {
    const body = U.el('div', {}, intro ? U.el('p', { text: intro }) : null, U.el('ul', {}, items.map(i => U.el('li', { text: i }))));
    return this.confirm({ title, body, buttons: [{ label: 'OK', value: 'ok', primary: true }] });
  }

  /* ---------- progress ---------- */
  showProgress(label, fraction) {
    if (this.disposed) return;
    const p = this.$('progress'); p.hidden = false;
    this.$('progressLabel').textContent = label; this.$('progressFill').style.width = `${Math.round((fraction || 0) * 100)}%`;
  }
  hideProgress() { if (!this.disposed) this.$('progress').hidden = true; }

  /* ---------- track info ---------- */
  renderTrackInfo() {
    const el = this.$('trackInfo');
    if (!this.info) { el.textContent = 'No file loaded. Open a WAV (⌘O) or drop one here.'; return; }
    const i = this.info;
    const fpShort = i.fingerprint.slice(0, 12) + '…';
    el.innerHTML = `<b>${U.escapeHtml(i.fileName)}</b> · ${U.fmtTime(i.durationSeconds)} · ${i.sampleRate} Hz · ${i.bitDepth ? i.bitDepth + '-bit ' : ''}${U.escapeHtml(i.format)} · ${i.channels} ch · ${U.fmtBytes(i.sizeBytes)} · ${i.totalFrames.toLocaleString()} samples · fp <span class="fp" title="${i.fingerprint} (click to copy)">${fpShort}</span>${i.warnings && i.warnings.length ? ` · <span class="header-warning" title="${U.escapeHtml(i.warnings.join('\n'))}">⚠ ${i.warnings.length} header note${i.warnings.length > 1 ? 's' : ''}</span>` : ''}`;
    el.querySelector('.fp').addEventListener('click', () => { navigator.clipboard && navigator.clipboard.writeText(i.fingerprint).then(() => this.toast('Fingerprint copied')); });
  }

  /* ================= audio loading ================= */
  async openWavFile(file, { relink = null } = {}) {
    if (!this.host.localFiles || !this.host.available || this.disposed || !file) return;
    if (this.dirty && !relink) {
      const r = await this.confirm({ title: 'Unsaved changes', body: 'Opening another file discards unsaved changes to the current notes. Continue?', buttons: [{ label: 'Discard and open', value: 'go', danger: true }, { label: 'Cancel', value: null }] });
      if (r !== 'go') return;
    }
    this.cancelJob();
    let info;
    try {
      info = await WavReader.parse(file);
    } catch (e) {
      if (e instanceof WavError && e.unsupported) {
        try { info = await this.decodeFallback(file); } catch (e2) { this.banner(`Could not open <b>${U.escapeHtml(file.name)}</b>: ${U.escapeHtml(e.message)} Fallback decoding also failed: ${U.escapeHtml(e2.message)}`, { error: true }); return; }
      } else { this.banner(`Could not open <b>${U.escapeHtml(file.name)}</b>: ${U.escapeHtml(e.message)}`, { error: true }); return; }
    }
    if (this.disposed) return;
    this.banner(null);
    const prevInfo = this.info;
    this.file = file; this.info = info; this.descriptors = null; this.analysis = null;
    this.peakStore = new PeakStore();
    this._audioGen = (this._audioGen || 0) + 1; this.playbackSource = 'file';
    this.transport.load(file, info.durationSeconds);
    this.transport.setLoop(null); this.selection = null; this.selectedNoteId = null; this.editing = null;
    if (relink) {
      this.applyRelink(prevInfo, info, relink);
    } else {
      this.store.setSampleRate(info.sampleRate);
      this.store.reset(); this.activeLayerId = this.store.layers[0].id;
      this.persist.saveHandle = null; this.persist.savedText = null; this.persist.extra = { doc: {}, track: {} }; this.persist.history = [];
      this.grid = new Grid({ bpm: 108 }); this.view.setGrid(this.grid); this.renderGridPanel();
      this.dirty = false;
    }
    this.view.setTrack(info, this.peakStore);
    this.view.setSelection(null); this.view.loopRegion = null;
    this.renderTrackInfo(); this.renderAll(); this.updateDirty(); this.onTime(0);
    document.title = `${info.fileName} — Note`;
    if (info.decodedBuffer) { this.peaksFromBuffer(info.decodedBuffer); info.decodedBuffer = null; }
    else await this.loadPeaks(file, info);
    if (!relink) this.offerAutosaveRestore(info.fingerprint);
  }

  /** decodeAudioData fallback for non-WAV or exotic WAV: loads the whole file into memory. */
  async decodeFallback(file) {
    this.toast(`Header not understood; decoding ${U.fmtBytes(file.size)} in memory instead (this can use a lot of RAM).`, { ms: 6000 });
    const Ctx = window.AudioContext || window.webkitAudioContext; if (!Ctx) throw new Error('Web Audio is unavailable');
    this.audioCtxFallback = this.audioCtxFallback || new Ctx();
    const buf = await file.arrayBuffer();
    const audio = await this.audioCtxFallback.decodeAudioData(buf.slice(0));
    const info = { fileName: file.name, sizeBytes: file.size, container: 'decoded', sampleRate: audio.sampleRate, channels: audio.numberOfChannels, bitDepth: 0, format: 'decoded', blockAlign: 0, dataOffset: 0, dataSize: 0, totalFrames: audio.length, durationSeconds: audio.duration, chunks: [], warnings: ['Decoded via decodeAudioData (header parsing failed); descriptors are computed from the decoded buffer.'], fingerprint: null, decodedBuffer: audio };
    info.fingerprint = await WavReader.fingerprint(file, info);
    return info;
  }
  /** 16-bit PCM WAV the <audio> element can play, from a file it cannot demux (float). */
  async pcmWavBlob(file) {
    try { return await this.pcmWavFromDecode(file); }
    catch (e) {
      const info = this.info;
      if (info && info.format === 'float' && info.bitDepth === 32 && info.dataSize > 0) return this.pcmWavFromFloatChunk(file, info);
      throw e;
    }
  }
  async pcmWavFromDecode(file) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) throw new Error('Web Audio is unavailable');
    const ctx = new Ctx();
    try {
      const raw = await file.arrayBuffer();
      const audio = await ctx.decodeAudioData(raw.slice(0));
      const channels = []; for (let c = 0; c < audio.numberOfChannels; c++) channels.push(audio.getChannelData(c));
      return this.pcmWavFromChannels(channels, audio.sampleRate, audio.length);
    } finally { try { await ctx.close(); } catch (_) { } }
  }
  /** Parsed 32-bit float chunk, used when decodeAudioData rejects an EXTENSIBLE float file. */
  async pcmWavFromFloatChunk(file, info) {
    const raw = await file.slice(info.dataOffset, info.dataOffset + info.dataSize).arrayBuffer();
    const numCh = info.channels, frames = Math.floor(raw.byteLength / (numCh * 4));
    if (!frames) throw new Error('float chunk is empty');
    const floats = new Float32Array(raw, 0, frames * numCh);
    const channels = [];
    for (let c = 0; c < numCh; c++) {
      const ch = new Float32Array(frames);
      for (let i = 0; i < frames; i++) ch[i] = floats[i * numCh + c];
      channels.push(ch);
    }
    return this.pcmWavFromChannels(channels, info.sampleRate, frames);
  }
  pcmWavFromChannels(channels, sampleRate, frames) {
    const numCh = channels.length, blockAlign = numCh * 2, dataSize = frames * blockAlign;
    const buf = new ArrayBuffer(44 + dataSize), v = new DataView(buf);
    const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF'); v.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, numCh, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * blockAlign, true); v.setUint16(32, blockAlign, true); v.setUint16(34, 16, true);
    writeStr(36, 'data'); v.setUint32(40, dataSize, true);
    let o = 44;
    for (let i = 0; i < frames; i++) for (let c = 0; c < numCh; c++) { const s = Math.max(-1, Math.min(1, channels[c][i])); v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2; }
    return new Blob([buf], { type: 'audio/wav' });
  }
  /** The audio element rejected the file. Play a decoded copy; notes stay on the original. */
  async recoverPlayback(file, gen) {
    const limit = 'Float files can be annotated and may not play.';
    try {
      const blob = await this.pcmWavBlob(file);
      if (this.disposed || gen !== this._audioGen) return;
      this.transport.load(blob, this.info ? this.info.durationSeconds : 0);
      const rate = parseFloat(this.$('selRate').value);
      if (rate) this.transport.setRate(rate);
      this.playbackSource = 'decoded';
      this.banner(null);
      this.transport.audio.addEventListener('loadedmetadata', () => {
        if (this.disposed || gen !== this._audioGen) return;
        clearTimeout(this._floatFailTimer);
        this.playbackSource = 'decoded';
        this.banner(null);
      }, { once: true });
    } catch (e) {
      if (this.disposed || gen !== this._audioGen) return;
      this.playbackSource = 'failed';
      if (this.info && this.info.format === 'float') this.banner(limit, { error: true });
      else this.banner(`Playback could not start: ${U.escapeHtml(e.message || 'decode failed')}`, { error: true });
    }
  }
  /** Build the pyramid on the main thread from an AudioBuffer (fallback path only). */
  peaksFromBuffer(audio) {
    const base = PEAK_LEVELS[0], n = Math.ceil(audio.length / base), ch = audio.numberOfChannels;
    const chans = []; const mono = new Int16Array(n * 2);
    const data = []; for (let c = 0; c < ch; c++) data.push(audio.getChannelData(c));
    for (let c = 0; c < ch; c++) chans.push(new Int16Array(n * 2));
    for (let b = 0; b < n; b++) {
      const s0 = b * base, s1 = Math.min(audio.length, s0 + base);
      let mmn = 1, mmx = -1;
      for (let c = 0; c < ch; c++) {
        let mn = 1, mx = -1; const d = data[c];
        for (let i = s0; i < s1; i++) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        chans[c][2 * b] = Math.round(U.clamp(mn, -1, 1) * 32767); chans[c][2 * b + 1] = Math.round(U.clamp(mx, -1, 1) * 32767);
        if (mn < mmn) mmn = mn; if (mx > mmx) mmx = mx;
      }
      mono[2 * b] = Math.round(U.clamp(mmn, -1, 1) * 32767); mono[2 * b + 1] = Math.round(U.clamp(mmx, -1, 1) * 32767);
    }
    const levels = [{ bucket: base, count: n, channels: chans, mono }];
    for (let L = 1; L < PEAK_LEVELS.length; L++) {
      const prev = levels[L - 1], ratio = PEAK_LEVELS[L] / prev.bucket, count = Math.ceil(prev.count / ratio);
      const fold = (src) => { const o = new Int16Array(count * 2); for (let i = 0; i < count; i++) { let mn = 32767, mx = -32768; for (let j = i * ratio, e = Math.min(prev.count, j + ratio); j < e; j++) { if (src[2 * j] < mn) mn = src[2 * j]; if (src[2 * j + 1] > mx) mx = src[2 * j + 1]; } o[2 * i] = mn; o[2 * i + 1] = mx; } return o; };
      levels.push({ bucket: PEAK_LEVELS[L], count, channels: prev.channels.map(fold), mono: fold(prev.mono) });
    }
    this.peakStore.setLevels(levels, audio.length, ch); this.view.setPeaks(this.peakStore);
  }

  cancelJob() { if (this.job) { try { this.job.cancel(); } catch (_) { } this.job = null; } this.hideProgress(); }

  async loadPeaks(file, info) {
    const cached = await this.cache.get(info.fingerprint);
    if (this.disposed) return;
    if (cached && cached.levels && cached.levels[0] && cached.levels[0].bucket === PEAK_LEVELS[0]) {
      this.peakStore.setLevels(cached.levels, info.totalFrames, info.channels);
      this.view.setPeaks(this.peakStore);
      if (cached.descriptors) { this.descriptors = cached.descriptors; this.refreshAnalysis(); }
      this.toast('Peaks loaded from cache');
      if (cached.descriptors) return;
    }
    if (!this.worker) return;
    this.showProgress('Reading waveform…', 0);
    const t0 = performance.now();
    let levelsOut = null, descOut = null;
    const job = this.worker.analyze(file, info, {
      levels: PEAK_LEVELS, wantDescriptors: true,
      onProgress: (phase, f) => { if (this.job === job) this.showProgress(phase === 'peaks' ? `Reading waveform… ${Math.round(f * 100)}%` : `Analysing (RMS, bands, onsets)… ${Math.round(f * 100)}%`, f); },
      onPeaks: (levels) => { if (this.job !== job) return; levelsOut = levels; this.peakStore.setLevels(levels, info.totalFrames, info.channels); this.view.setPeaks(this.peakStore); this.toast(`Waveform ready in ${((performance.now() - t0) / 1000).toFixed(1)} s`); },
      onDescriptors: (d) => { if (this.job !== job) return; descOut = d; this.descriptors = d; this.refreshAnalysis(); },
    });
    this.job = job;
    try {
      await job.promise;
      if (this.job === job) { this.job = null; this.hideProgress(); }
      if (levelsOut) await this.cache.put(info.fingerprint, { levels: levelsOut, descriptors: descOut, fileName: info.fileName, savedAt: U.nowIso() });
    } catch (e) {
      if (this.job === job) { this.job = null; this.hideProgress(); }
      if (e.message !== 'cancelled') this.banner(`Waveform analysis failed: ${U.escapeHtml(e.message)}. Playback still works.`, { error: true });
    }
  }

  refreshAnalysis() {
    this.analysis = this.descriptors && this.info ? Analysis.aggregate(this.descriptors, this.grid, this.info.durationSeconds) : null;
    this.view.setAnalysis(this.analysis ? this.analysis.rows : null);
    this.renderGridPanel();
  }

  /* ---------- drag & drop ---------- */
  bindDragDrop() {
    let depth = 0; const ov = this.$('dropOverlay');
    window.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; ov.hidden = false; });
    window.addEventListener('dragleave', (e) => { e.preventDefault(); depth = Math.max(0, depth - 1); if (!depth) ov.hidden = true; });
    window.addEventListener('dragover', (e) => { e.preventDefault(); });
    window.addEventListener('drop', async (e) => {
      e.preventDefault(); depth = 0; ov.hidden = true;
      const files = Array.from(e.dataTransfer.files || []);
      if (this.mode === 'loops' && this.loopLab) {
        const wavs = files.filter(f => /\.wav$/i.test(f.name)), json = files.find(f => /\.json$/i.test(f.name));
        if (wavs.length) await this.loopLab.openFiles(wavs);
        if (json) { const t = await json.text(); if (/imported-loops|"loops"\s*:\s*\[/.test(t) && !/"session"/.test(t)) await this.loopLab.importSidecarText(t, json.name); else await this.loopLab.loadJsonText(t, json.name); }
        if (!wavs.length && !json) this.toast('Drop .wav loops or a loops.json / sidecar.', { error: true });
        return;
      }
      const wav = files.find(f => /\.(wav|wave|aif|aiff|flac|mp3|m4a|ogg)$/i.test(f.name) || /^audio\//.test(f.type));
      const json = files.find(f => /\.json$/i.test(f.name));
      if (wav) await this.openWavFile(wav);
      if (json) await this.loadNotesFile(json);
      if (!wav && !json && files.length) this.toast('Drop a .wav (audio) or a .notes.json file.', { error: true });
    });
  }

  /* ================= 2. notes & panels ================= */
  onStoreChange(ev) {
    if (this.disposed) return;
    if (!ev.noDirty && ev.label !== 'load' && ev.label !== 'reset') this.markDirty();
    if (this.selectedNoteId && !this.store.note(this.selectedNoteId)) { this.selectedNoteId = null; if (this.editing) this.closeEditor(); }
    if (this.editing && !ev.transient && ev.undo) this.closeEditor();
    this.renderAll();
  }
  markDirty() { this.dirty = true; this.updateDirty(); this._autosave(); }
  updateDirty() {
    this.$('dirty').hidden = !this.dirty;
    this.$('btnUndo').disabled = this.host.shared || !this.store.canUndo; this.$('btnRedo').disabled = this.host.shared || !this.store.canRedo;
    this.$('btnUndo').title = this.store.canUndo ? `Undo ${this.store.undoStack[this.store.undoStack.length - 1].label} (⌘Z)` : 'Undo (⌘Z)';
    this.$('btnRedo').title = this.store.canRedo ? `Redo ${this.store.redoStack[this.store.redoStack.length - 1].label} (⇧⌘Z)` : 'Redo (⇧⌘Z)';
  }
  renderAll() {
    if (this.disposed) return;
    const notes = this.store.visibleNotes();
    this.view.setNotes(notes, (n) => this.store.noteColor(n), (n) => this.store.layerColor(n.layerId));
    this.view.setSelectedNote(this.selectedNoteId);
    this.renderNoteList(); this.renderLayers(); this.renderFilterOptions(); if (this.host.ai) this.renderAiSummaries(); this.updateDirty();
    if (this.editing) this.renderReplies();
  }

  /* ---------- positions & snapping ---------- */
  get sr() { return this.info ? this.info.sampleRate : this.store.sampleRate; }
  snapSamples(samples) {
    if (!this.settings.snapOn || !this.grid.valid) return Math.round(samples);
    return Math.round(this.grid.snap(samples / this.sr, this.settings.snap) * this.sr);
  }
  clampSamples(s) { return U.clamp(Math.round(s), 0, this.info ? this.info.totalFrames : Infinity); }
  fmtPos(sec) { return U.fmtTime(sec) + (this.grid.valid ? `  ${this.grid.fmtBBT(sec)}` : ''); }
  parsePos(str) {
    if (!str) return NaN;
    if (str.includes('|') && this.grid.valid) { const s = this.grid.parseBBT(str); return s === null ? NaN : s; }
    return U.parseTime(str);
  }

  /* ---------- creation ---------- */
  requireTrack() { if (!this.info) { this.toast('Open a WAV first.', { error: true }); return false; } return true; }
  addPinAt(sec, { openEditor = true } = {}) {
    if (!this.requireTrack()) return null;
    const s = this.clampSamples(this.snapSamples(sec * this.sr));
    const n = this.store.addNote({ layerId: this.activeLayerId, type: 'pin', startSamples: s, category: 'idea' });
    this.selectNote(n.id, { reveal: false });
    if (openEditor) this.openEditor(n.id, { isNew: true });
    return n;
  }
  addIntervalFromSelection({ openEditor = true } = {}) {
    if (!this.requireTrack()) return null;
    if (!this.selection || this.selection.end - this.selection.start < 2) { this.toast('Make a selection first (⇧-drag, or I / O).', { error: true }); return null; }
    const n = this.store.addNote({ layerId: this.activeLayerId, type: 'interval', startSamples: this.selection.start, endSamples: this.selection.end, category: 'loop' });
    this.setSelection(null);
    this.selectNote(n.id, { reveal: false });
    if (openEditor) this.openEditor(n.id, { isNew: true });
    return n;
  }
  setSelection(sel) {
    this.selection = sel && sel.end > sel.start ? { start: this.clampSamples(sel.start), end: this.clampSamples(sel.end) } : null;
    this.view.setSelection(this.selection);
  }
  setInPoint() { if (!this.requireTrack()) return; const s = this.clampSamples(this.snapSamples(this.transport.currentTime * this.sr)); const e = this.selection ? Math.max(this.selection.end, s + 1) : Math.min(this.info.totalFrames, s + this.sr); this.setSelection({ start: s, end: e }); }
  setOutPoint() { if (!this.requireTrack()) return; const e = this.clampSamples(this.snapSamples(this.transport.currentTime * this.sr)); const s = this.selection ? Math.min(this.selection.start, e - 1) : Math.max(0, e - this.sr); this.setSelection({ start: s, end: e }); }
  toggleLoop() {
    if (!this.requireTrack()) return;
    if (this.transport.loop) { this.transport.setLoop(null); this.view.loopRegion = null; this.view.requestDraw(); this.$('btnLoop').setAttribute('aria-pressed', 'false'); this.toast('Loop off'); return; }
    let region = null;
    if (this.selection) region = this.selection;
    else { const n = this.selectedNoteId && this.store.note(this.selectedNoteId); if (n && n.type === 'interval') region = { start: n.start.samples, end: n.end.samples }; }
    if (!region) { this.toast('Select a range (⇧-drag) or an interval note to loop.', { error: true }); return; }
    this.transport.setLoop({ start: region.start / this.sr, end: region.end / this.sr });
    this.view.loopRegion = { ...region }; this.view.requestDraw(); this.$('btnLoop').setAttribute('aria-pressed', 'true');
    if (this.transport.currentTime < region.start / this.sr || this.transport.currentTime > region.end / this.sr) this.transport.seek(region.start / this.sr);
    this.toast('Looping ' + U.fmtTime(region.start / this.sr) + ' – ' + U.fmtTime(region.end / this.sr));
  }
  selectNote(id, { reveal = true, seek = false } = {}) {
    this.selectedNoteId = id; this.view.setSelectedNote(id);
    const n = id && this.store.note(id);
    if (n && reveal) this.view.ensureVisible(n.start.samples);
    if (n && seek) this.transport.seek(n.start.seconds);
    this.renderNoteList();
  }
  async deleteSelected() {
    const n = this.selectedNoteId && this.store.note(this.selectedNoteId); if (!n) return;
    this.store.deleteNote(n.id);
    this.selectedNoteId = null; if (this.editing) this.closeEditor();
    this.toast(`Deleted "${n.title || 'untitled'}" (⌘Z to undo)`);
  }
  gotoAdjacent(dir, onlyOpen = false) {
    if (!this.requireTrack()) return;
    const n = this.store.adjacent(Math.round(this.transport.currentTime * this.sr), dir, onlyOpen);
    if (!n) { this.toast(dir > 0 ? 'No later note' : 'No earlier note'); return; }
    this.transport.seek(n.start.seconds); this.selectNote(n.id, { reveal: true });
  }

  /* ---------- view events ---------- */
  bindView() {
    const v = this.view;
    v.on('seek', (sec) => { this.transport.seek(sec); });
    v.on('createPin', (sec) => this.addPinAt(sec));
    v.on('noteClick', (id) => { this.selectNote(id, { reveal: false }); });
    v.on('noteDouble', (id) => { this.selectNote(id, { reveal: false }); this.openEditor(id); });
    v.on('selectionChange', (sel, live) => { this.setSelection(sel); void live; });
    v.on('noteDragStart', (id) => { this.store.beginTransient('move note'); this._dragId = id; });
    v.on('noteDrag', (id, s, e, kind) => {
      const n = this.store.note(id); if (!n) return;
      if (kind === 'ivl-body' || kind === 'pin') {
        const len = e !== null ? e - s : 0; let ns = this.clampSamples(this.snapSamples(s));
        if (e !== null) { ns = Math.min(ns, this.info.totalFrames - len); this.store.setNotePosition(id, ns, ns + len); } else this.store.setNotePosition(id, ns);
      } else if (kind === 'ivl-left') this.store.setNotePosition(id, this.clampSamples(this.snapSamples(s)), n.end.samples);
      else if (kind === 'ivl-right') this.store.setNotePosition(id, n.start.samples, this.clampSamples(this.snapSamples(e)));
    });
    v.on('noteDragEnd', () => { this.store.endTransient(true); this._dragId = null; });
    v.on('hover', (hit, p) => this.showTooltip(hit, p));
  }
  showTooltip(hit, p) {
    const tt = this.$('tooltip');
    const n = hit && this.store.note(hit.id);
    if (!n) { tt.hidden = true; return; }
    const layer = this.store.layer(n.layerId);
    const when = n.type === 'interval' ? `${this.fmtPos(n.start.seconds)} → ${this.fmtPos(n.end.seconds)}` : this.fmtPos(n.start.seconds);
    tt.innerHTML = `<div class="t-title">${U.escapeHtml(n.title || '(untitled)')}</div><div class="t-meta">${U.escapeHtml(when)}\n${U.escapeHtml(layer ? layer.name : '')} · ${U.escapeHtml(n.category)} · ${n.status}${n.rating ? ' · ' + '★'.repeat(n.rating) : ''}${(n.tags || []).length ? ' · ' + U.escapeHtml(n.tags.join(' ')) : ''}</div>${n.body ? `<div>${U.escapeHtml(n.body)}</div>` : ''}${(n.replies || []).map(r => { const rl = this.store.layer(r.layerId); return `<div class="t-meta">↳ ${U.escapeHtml(rl ? rl.name : '?')}: ${U.escapeHtml(r.body)}</div>`; }).join('')}`;
    tt.hidden = false;
    const wrap = this.$('mainWrap').getBoundingClientRect();
    let x = p.x + 14, y = p.y + 14;
    if (x + 340 > wrap.width) x = Math.max(0, p.x - 350);
    if (y + tt.offsetHeight > wrap.height) y = Math.max(0, p.y - tt.offsetHeight - 8);
    tt.style.left = x + 'px'; tt.style.top = y + 'px';
  }

  /* ---------- transport UI ---------- */
  bindTransport() {
    const t = this.transport;
    t.on('time', (sec) => this.onTime(sec));
    t.on('playState', (playing) => { if (this.disposed) return; const b = this.$('btnPlay'); b.textContent = playing ? '❚❚' : '▶'; b.setAttribute('aria-pressed', String(playing)); });
    t.on('error', (msg) => {
      if (this.disposed) return;
      const gen = this._audioGen;
      const limit = 'Float files can be annotated and may not play.';
      if (this._audioFallbackGen === gen) {
        clearTimeout(this._floatFailTimer);
        this._floatFailTimer = setTimeout(() => {
          if (this.disposed || gen !== this._audioGen) return;
          if (this.playbackSource === 'decoded' && t.audio.readyState >= 1 && !t.audio.error) { this.banner(null); return; }
          this.playbackSource = 'failed';
          if (this.info && this.info.format === 'float') this.banner(limit, { error: true });
          else this.banner(U.escapeHtml(msg), { error: true });
        }, 400);
        return;
      }
      if (this.file && this.info && this.info.format === 'float') { this._audioFallbackGen = gen; this.recoverPlayback(this.file, gen); return; }
      this.banner(U.escapeHtml(msg), { error: true });
    });
    t.on('meta', (d) => { if (this.info && Math.abs(d - this.info.durationSeconds) > 0.05) console.info('audio element duration differs from header', d, this.info.durationSeconds); });
    this.$('btnPlay').addEventListener('click', () => t.toggle());
    this.$('btnStop').addEventListener('click', () => t.stop());
    this.$('btnHome').addEventListener('click', () => t.seek(0));
    this.$('btnPrevNote').addEventListener('click', () => this.gotoAdjacent(-1));
    this.$('btnNextNote').addEventListener('click', () => this.gotoAdjacent(1));
    this.$('btnLoop').addEventListener('click', () => this.toggleLoop());
    this.$('selRate').addEventListener('change', (e) => t.setRate(parseFloat(e.target.value)));
    this.$('rngVolume').addEventListener('input', (e) => t.setVolume(parseFloat(e.target.value)));
    this.$('btnAddPin').addEventListener('click', () => this.addPinAt(t.currentTime));
    this.$('btnAddInterval').addEventListener('click', () => this.addIntervalFromSelection());
    this.$('btnSetIn').addEventListener('click', () => this.setInPoint());
    this.$('btnSetOut').addEventListener('click', () => this.setOutPoint());
    // view bar
    this.$('btnZoomIn').addEventListener('click', () => this.view.zoomBy(0.5));
    this.$('btnZoomOut').addEventListener('click', () => this.view.zoomBy(2));
    this.$('btnZoomFit').addEventListener('click', () => this.view.fit());
    this.$('btnCenter').addEventListener('click', () => this.view.centerOn(t.currentTime * this.sr));
    this.$('chkFollow').addEventListener('change', (e) => { this.settings.follow = e.target.checked; });
    this.$('chkSplit').addEventListener('change', (e) => { this.settings.split = e.target.checked; this.view.setMode(e.target.checked ? 'split' : 'mono'); });
    this.$('chkGrid').addEventListener('change', (e) => { this.settings.gridLines = e.target.checked; this.view.showGrid = e.target.checked; this.view.requestDraw(); });
    this.$('chkSnap').addEventListener('change', (e) => { this.settings.snapOn = e.target.checked; this.toast(`Snap ${e.target.checked ? 'on (' + this.settings.snap + ')' : 'off'}`); });
    this.$('selSnap').addEventListener('change', (e) => { this.settings.snap = e.target.value; this.markDirty(); });
    this.$('chkAnalysis').addEventListener('change', (e) => { this.settings.analysis = e.target.checked; this.view.showAnalysis = e.target.checked; this.view._invalidate(); this.view.requestDraw(); });
  }
  onTime(sec) {
    if (this.disposed) return;
    this.$('timeNow').textContent = U.fmtTime(sec);
    this.$('bbtNow').textContent = this.grid.valid ? this.grid.fmtBBT(sec) : '';
    const d = this.info ? this.info.durationSeconds : this.transport.effectiveDuration;
    this.$('timeRest').textContent = d ? `−${U.fmtTime(Math.max(0, d - sec), false)} / ${U.fmtTime(d, false)}` : '';
    this.view.setPlayhead(sec);
    if (this.settings.follow && this.transport.playing) this.view.ensureVisible(sec * this.sr);
  }
  toggleSnap() { this.settings.snapOn = !this.settings.snapOn; this.$('chkSnap').checked = this.settings.snapOn; this.toast(`Snap ${this.settings.snapOn ? 'on (' + this.settings.snap + ')' : 'off'}`); }
  toggleGridLines() { this.settings.gridLines = !this.settings.gridLines; this.$('chkGrid').checked = this.settings.gridLines; this.view.showGrid = this.settings.gridLines; this.view.requestDraw(); }
  toggleAnalysis() { this.settings.analysis = !this.settings.analysis; this.$('chkAnalysis').checked = this.settings.analysis; this.view.showAnalysis = this.settings.analysis; this.view._invalidate(); this.view.requestDraw(); }

  /* ---------- sidebar tabs & note list ---------- */
  bindPanels() {
    for (const b of U.$$('.tabs [role=tab]')) b.addEventListener('click', () => this.showTab(b.dataset.tab));
    const f = this.filters;
    this.$('fltLayer').addEventListener('change', (e) => { f.layerId = e.target.value; this.renderNoteList(); });
    this.$('fltCategory').addEventListener('change', (e) => { f.category = e.target.value; this.renderNoteList(); });
    this.$('fltStatus').addEventListener('change', (e) => { f.status = e.target.value; this.renderNoteList(); });
    this.$('fltSort').addEventListener('change', (e) => { f.sort = e.target.value; this.renderNoteList(); });
    this.$('fltSearch').addEventListener('input', (e) => { f.search = e.target.value; this.renderNoteList(); });
    this.$('btnAddLayer').addEventListener('click', () => { const l = this.store.addLayer({ name: 'Layer', kind: 'human' }); this.activeLayerId = l.id; this.renameLayer(l.id); });
  }
  showTab(name) {
    for (const b of U.$$('.tabs [role=tab]')) { const on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); }
    for (const p of U.$$('.sidebar .panel')) p.hidden = p.id !== `tab-${name}`;
  }
  renderFilterOptions() {
    const keep = (sel, opts, cur) => { const first = sel.options[0]; sel.innerHTML = ''; sel.append(first); for (const [v, t] of opts) sel.append(U.el('option', { value: v, text: t })); sel.value = opts.some(o => o[0] === cur) ? cur : ''; };
    keep(this.$('fltLayer'), this.store.layers.map(l => [l.id, l.name]), this.filters.layerId);
    keep(this.$('fltCategory'), this.store.categories.map(c => [c, c]), this.filters.category);
    if (this.$('fltLayer').value !== this.filters.layerId) this.filters.layerId = '';
  }
  renderNoteList() {
    const list = this.$('noteList'); list.innerHTML = '';
    const notes = this.store.visibleNotes(this.filters);
    this.$('noteCount').textContent = notes.length ? `(${notes.length})` : '';
    if (!notes.length) { list.append(U.el('div', { class: 'muted small', text: this.store.notes.length ? 'No notes match the filters.' : 'No notes yet. Press M at the playhead, double-click the waveform, or ⇧-drag then ⇧M.' })); return; }
    for (const n of notes) {
      const layer = this.store.layer(n.layerId);
      const bbt = this.grid.valid ? this.grid.fmtBBT(n.start.seconds) : '';
      const row = U.el('div', { class: 'note-row' + (n.id === this.selectedNoteId ? ' selected' : '') + (n.status === 'done' ? ' done' : ''), role: 'option', tabindex: '0', 'aria-selected': String(n.id === this.selectedNoteId), dataset: { id: n.id } },
        U.el('div', { class: 'nr-time', html: `${U.fmtTime(n.start.seconds)}${bbt ? `<b>${bbt}</b>` : ''}` }),
        U.el('div', { class: 'nr-swatch', style: { background: this.store.noteColor(n), borderColor: layer ? layer.color : '#888' }, title: layer ? layer.name : '' }),
        U.el('div', { class: 'nr-title', html: `<span class="icon">${n.type === 'interval' ? '⟷' : '📍'}</span>${U.escapeHtml(n.title || '(untitled)')}` }),
        U.el('div', { class: 'nr-meta', text: `${n.category}${n.status !== 'open' ? ' · ' + n.status : ''}${(n.replies || []).length ? ' · ' + n.replies.length + '↳' : ''}` }));
      row.addEventListener('click', () => { this.transport.seek(n.start.seconds); this.selectNote(n.id, { reveal: true }); });
      row.addEventListener('dblclick', () => { this.selectNote(n.id, { reveal: true }); this.openEditor(n.id); });
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.selectNote(n.id, { reveal: true }); this.openEditor(n.id); } });
      list.append(row);
    }
  }

  /* ---------- layers ---------- */
  renderLayers() {
    const el = this.$('layerList'); el.innerHTML = '';
    if (!this.store.layer(this.activeLayerId)) this.activeLayerId = this.store.layers[0] && this.store.layers[0].id;
    for (const l of this.store.layers) {
      const count = this.store.layerNoteCount(l.id);
      const row = U.el('div', { class: 'layer-row' },
        U.el('input', { type: 'radio', name: 'activeLayer', title: 'Active layer for new notes', checked: l.id === this.activeLayerId, onChange: () => { this.activeLayerId = l.id; } }),
        U.el('input', { type: 'checkbox', title: 'Visible', checked: l.visible !== false, onChange: (e) => this.store.setLayerVisible(l.id, e.target.checked) }),
        U.el('input', { type: 'color', class: 'swatch', value: l.color, title: 'Layer colour', onChange: (e) => this.store.updateLayer(l.id, { color: e.target.value }) }),
        U.el('div', { class: 'lname', title: l.name, html: `${U.escapeHtml(l.name)} <small>${l.kind === 'ai' ? '🤖 ' : ''}${count}</small>` }),
        U.el('div', { class: 'lbtns' },
          U.el('button', { text: '✎', title: 'Rename', onClick: () => this.renameLayer(l.id) }),
          U.el('button', { text: '⧉', title: 'Duplicate', onClick: () => this.store.duplicateLayer(l.id) }),
          U.el('button', { text: '⤵', title: 'Merge into…', onClick: () => this.mergeLayerDialog(l.id) }),
          U.el('button', { text: '🗑', title: 'Delete layer and its notes', onClick: () => this.deleteLayer(l.id) })));
      el.append(row);
      if(this.host.shared) {
        for(const input of row.querySelectorAll('input:not([type="checkbox"]),button'))input.disabled=true;
      }
    }
  }
  async renameLayer(id) {
    const l = this.store.layer(id); if (!l) return;
    const input = U.el('input', { type: 'text', value: l.name, style: { width: '100%' } });
    const r = await this.confirm({ title: 'Rename layer', body: input, buttons: [{ label: 'Rename', value: 'ok', primary: true }, { label: 'Cancel', value: null }] });
    if (r === 'ok' && input.value.trim() && input.value.trim() !== l.name) this.store.updateLayer(id, { name: this.store.uniqueLayerName(input.value.trim()) });
  }
  async deleteLayer(id) {
    const l = this.store.layer(id); if (!l) return;
    const n = this.store.layerNoteCount(id);
    const r = await this.confirm({ title: `Delete layer "${l.name}"?`, body: `${n} note${n === 1 ? '' : 's'} and this layer's replies on other notes will be deleted. You can undo with ⌘Z.`, buttons: [{ label: 'Delete', value: 'ok', danger: true }, { label: 'Cancel', value: null }] });
    if (r === 'ok') this.store.deleteLayer(id);
  }
  async mergeLayerDialog(srcId) {
    const src = this.store.layer(srcId); const others = this.store.layers.filter(l => l.id !== srcId);
    if (!others.length) { this.toast('No other layer to merge into.'); return; }
    const sel = U.el('select', {}, others.map(l => U.el('option', { value: l.id, text: l.name })));
    const body = U.el('div', {}, U.el('p', { text: `Move every note and reply from "${src.name}" into:` }), sel, U.el('p', { class: 'muted small', text: `"${src.name}" is removed afterwards. Undo with ⌘Z.` }));
    const r = await this.confirm({ title: 'Merge layer', body, buttons: [{ label: 'Merge', value: 'ok', primary: true }, { label: 'Cancel', value: null }] });
    if (r === 'ok') { this.store.mergeLayer(srcId, sel.value); this.toast(`Merged "${src.name}"`); }
  }

  /* ---------- editor ---------- */
  bindEditor() {
    const form = this.$('editor');
    form.addEventListener('submit', (e) => { e.preventDefault(); this.saveEditor(); });
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancelEditor(); }
      else if (e.key === 'Enter' && (e.target.tagName !== 'TEXTAREA' || e.metaKey || e.ctrlKey)) { if (e.target.id === 'edReplyBody') { if (e.metaKey || e.ctrlKey) { e.preventDefault(); this.addReplyFromEditor(); } return; } e.preventDefault(); this.saveEditor(); }
    });
    this.$('edCancel').addEventListener('click', () => this.cancelEditor());
    this.$('edDelete').addEventListener('click', () => { if (this.editing) { this.selectedNoteId = this.editing.id; this.deleteSelected(); } });
    this.$('edGoto').addEventListener('click', () => { const n = this.editing && this.store.note(this.editing.id); if (n) { this.transport.seek(n.start.seconds); this.view.ensureVisible(n.start.samples); } });
    this.$('edLoopNote').addEventListener('click', () => { const n = this.editing && this.store.note(this.editing.id); if (n && n.type === 'interval') { this.selectedNoteId = n.id; this.setSelection(null); if (this.transport.loop) this.toggleLoop(); this.toggleLoop(); } else this.toast('Only interval notes can be looped.'); });
    this.$('edColorAuto').addEventListener('change', (e) => { this.$('edColor').disabled = e.target.checked; });
    this.$('edCategory').addEventListener('change', (e) => { if (this.$('edColorAuto').checked) this.$('edColor').value = this.store.categoryColors[e.target.value] || '#3fb0ff'; });
    this.$('edReplyAdd').addEventListener('click', () => this.addReplyFromEditor());
  }
  openEditor(id, { isNew = false } = {}) {
    const n = this.store.note(id); if (!n) return;
    this.editing = { id, isNew, before: U.deepClone(n) };
    this.$('edEmpty').hidden = true; this.$('edFields').hidden = false;
    this.$('edType').textContent = n.type === 'interval' ? '⟷ interval' : '📍 pin';
    this.$('edWhen').textContent = n.type === 'interval' ? `${this.fmtPos(n.start.seconds)} → ${this.fmtPos(n.end.seconds)}` : this.fmtPos(n.start.seconds);
    this.$('edTitle').value = n.title; this.$('edBody').value = n.body;
    const cat = this.$('edCategory'); cat.innerHTML = ''; for (const c of this.store.categories) cat.append(U.el('option', { value: c, text: c })); if (!this.store.categories.includes(n.category)) cat.append(U.el('option', { value: n.category, text: n.category })); cat.value = n.category;
    const lay = this.$('edLayer'); lay.innerHTML = ''; for (const l of this.store.layers) lay.append(U.el('option', { value: l.id, text: l.name })); lay.value = n.layerId;
    this.$('edStatus').value = n.status; this.$('edRating').value = n.rating ? String(n.rating) : '';
    this.$('edStart').value = this.grid.valid ? this.grid.fmtBBT(n.start.seconds) : U.fmtTime(n.start.seconds);
    this.$('edEndWrap').hidden = n.type !== 'interval'; this.$('edEnd').value = n.end ? (this.grid.valid ? this.grid.fmtBBT(n.end.seconds) : U.fmtTime(n.end.seconds)) : '';
    this.editing.displayStart=this.$('edStart').value;this.editing.displayEnd=this.$('edEnd').value;
    this.$('edTags').value = (n.tags || []).join(', ');
    this.$('edColorAuto').checked = !n.color; this.$('edColor').disabled = !n.color; this.$('edColor').value = n.color || this.store.categoryColors[n.category] || '#3fb0ff';
    this.$('edLoopNote').hidden = n.type !== 'interval';
    const rl = this.$('edReplyLayer'); rl.innerHTML = ''; for (const l of this.store.layers) rl.append(U.el('option', { value: l.id, text: l.name })); rl.value = this.activeLayerId;
    this.renderReplies();
    this.showTab('editor');
    this.$('edTitle').focus(); this.$('edTitle').select();
  }
  renderReplies() {
    const n = this.editing && this.store.note(this.editing.id); const box = this.$('edReplies'); box.innerHTML = '';
    if (!n) return;
    for (const r of (n.replies || [])) {
      const l = this.store.layer(r.layerId);
      box.append(U.el('div', { class: 'reply' }, U.el('div', { class: 'r-who', text: `${r.author?.name || (l ? l.name : r.layerId)} · ${(r.createdAt || '').slice(0, 16).replace('T', ' ')}` }), U.el('div', { text: r.body }),
        U.el('button', { type: 'button', class: 'tiny r-del', text: '✕', title: 'Delete reply', onClick: () => this.store.deleteReply(n.id, r.id) })));
    }
    if (!(n.replies || []).length) box.append(U.el('div', { class: 'muted small', text: 'No replies.' }));
  }
  addReplyFromEditor() {
    const n = this.editing && this.store.note(this.editing.id); if (!n) return;
    const body = this.$('edReplyBody').value.trim(); if (!body) return;
    this.store.addReply(n.id, { layerId: this.$('edReplyLayer').value, body });
    this.$('edReplyBody').value = '';
  }
  saveEditor() {
    const ed = this.editing; if (!ed) return; const n = this.store.note(ed.id); if (!n) { this.closeEditor(); return; }
    const patch = {
      title: this.$('edTitle').value.trim(), body: this.$('edBody').value, category: this.$('edCategory').value, layerId: this.$('edLayer').value,
      status: this.$('edStatus').value, rating: this.$('edRating').value ? parseInt(this.$('edRating').value, 10) : null,
      tags: this.$('edTags').value.split(',').map(s => s.trim()).filter(Boolean),
      color: this.$('edColorAuto').checked ? null : this.$('edColor').value,
    };
    const s = this.parsePos(this.$('edStart').value);
    if (!isNaN(s)) patch.start = this.$('edStart').value===ed.displayStart ? U.deepClone(ed.before.start) : this.store.posFromSeconds(U.clamp(s, 0, this.info ? this.info.durationSeconds : s));
    else { this.toast('Start time not understood (use mm:ss.mmm or bar|beat|ticks).', { error: true }); return; }
    if (n.type === 'interval') {
      const e = this.parsePos(this.$('edEnd').value);
      if (isNaN(e)) { this.toast('End time not understood.', { error: true }); return; }
      patch.end = this.$('edEnd').value===ed.displayEnd ? U.deepClone(ed.before.end) : this.store.posFromSeconds(U.clamp(e, 0, this.info ? this.info.durationSeconds : e));
      if (patch.end.samples <= patch.start.samples) { this.toast('End must be after start.', { error: true }); return; }
    }
    this.store.updateNote(n.id, patch);
    this.editing = null; this.$('edEmpty').hidden = false; this.$('edFields').hidden = true;
    this.showTab('notes'); this.$('main').focus();
    this.toast('Note saved');
  }
  cancelEditor() {
    const ed = this.editing; if (!ed) return;
    if (ed.isNew) {
      // a brand-new note that was cancelled disappears; undo the creation so no ghost note remains
      const top = this.store.undoStack[this.store.undoStack.length - 1];
      if (top && top.label === 'add note') { this.store.undo(); this.store.redoStack.pop(); } else this.store.deleteNote(ed.id);
      this.selectedNoteId = null;
    }
    this.closeEditor(); this.$('main').focus();
  }
  closeEditor() { this.editing = null; this.$('edEmpty').hidden = false; this.$('edFields').hidden = true; if (this.$('tab-editor') && !this.$('tab-editor').hidden) this.showTab('notes'); }

  /* ---------- grid panel ---------- */
  bindGridPanel() {
    const apply = () => {
      const bpm = parseFloat(this.$('gridBpm').value), num = parseInt(this.$('gridNum').value, 10), den = parseInt(this.$('gridDen').value, 10), off = parseFloat(this.$('gridOffset').value);
      if (bpm > 0) this.grid.bpm = bpm; if (num > 0) this.grid.num = num; if (den > 0) this.grid.den = den; if (isFinite(off)) this.grid.offset = off;
      this.grid.enabled = this.$('gridEnabled').checked;
      this.onGridChanged();
    };
    for (const id of ['gridBpm', 'gridNum', 'gridDen', 'gridOffset', 'gridEnabled']) this.$(id).addEventListener('change', apply);
    this.$('btnBar1Here').addEventListener('click', () => { if (!this.requireTrack()) return; this.grid.offset = +this.transport.currentTime.toFixed(6); this.onGridChanged(); this.toast(`Bar 1 set to ${U.fmtTime(this.grid.offset)}`); });
    this.$('btnTap').addEventListener('click', () => {
      if (!this.requireTrack()) return;
      const t = this.transport.currentTime, bar = this.grid.barSeconds;
      const k = Math.round((t - this.grid.offset) / bar);
      this.grid.offset = +(t - k * bar).toFixed(6); this.onGridChanged();
      this.toast(`Bar line snapped to ${U.fmtTime(t)} (bar 1 offset ${this.grid.offset.toFixed(3)} s)`);
    });
  }
  onGridChanged() {
    this.view.setGrid(this.grid); this.refreshAnalysis(); this.renderGridPanel(); this.renderNoteList(); this.onTime(this.transport.currentTime); this.markDirty();
  }
  renderGridPanel() {
    const g = this.grid;
    this.$('gridBpm').value = g.bpm; this.$('gridNum').value = g.num; this.$('gridDen').value = String(g.den); this.$('gridOffset').value = String(g.offset); this.$('gridEnabled').checked = g.enabled;
    const info = this.$('gridInfo');
    const parts = [];
    if (g.valid) parts.push(`One beat = ${g.beatSeconds.toFixed(4)} s, one bar = ${g.barSeconds.toFixed(4)} s.`);
    if (this.analysis && this.analysis.global) { const G = this.analysis.global; parts.push(`Integrated RMS ${G.integratedRmsDb.toFixed(1)} dBFS · peak ${G.peakDb.toFixed(1)} dBFS · crest ${G.crestFactorDb.toFixed(1)} dB.`); parts.push(`Loudest ${this.analysis.unit}s: ${G.loudest.map(r => r.label).join(', ')}.`); parts.push(`Quietest: ${G.quietest.map(r => r.label).join(', ')}.`); }
    info.textContent = parts.join(' ');
  }

  /* ================= 3. save / load / exports / AI / settings / keys ================= */
  currentDocument() { return this.persist.buildDocument({ info: this.info, grid: this.grid, store: this.store, settings: this.settings }); }
  bindToolbar() {
    this.$('btnOpen').addEventListener('click', () => this.pickWav());
    this.$('fileWav').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.openWavFile(f, this._pendingRelink ? { relink: this._pendingRelink } : {}); this._pendingRelink = null; });
    this.$('btnLoadNotes').addEventListener('click', () => this.pickNotes());
    this.$('fileJson').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.loadNotesFile(f); });
    this.$('btnSave').addEventListener('click', () => this.saveNotes());
    this.$('btnSaveAs').addEventListener('click', () => this.saveNotes({ forcePicker: true }));
    this.$('btnUndo').addEventListener('click', () => this.undo());
    this.$('btnRedo').addEventListener('click', () => this.redo());
    const menu = this.$('btnExportMenu').parentElement;
    this.$('btnExportMenu').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); this.$('btnExportMenu').setAttribute('aria-expanded', String(menu.classList.contains('open'))); });
    document.addEventListener('click', () => menu.classList.remove('open'));
    this.$('btnExportMd').addEventListener('click', () => this.exportMarkdown());
    this.$('btnExportCsv').addEventListener('click', () => this.exportCsv());
    this.$('btnExportAi')?.addEventListener('click', () => this.exportAiBundle());
    this.$('btnImportAi')?.addEventListener('click', () => this.$('fileAi').click());
    this.$('btnAskAi')?.addEventListener('click', () => this.askAi());
    this.$('btnRelink').addEventListener('click', () => this.relinkDialog());
    this.$('btnHelp').addEventListener('click', () => this.$('dlgHelp').showModal());
    this.$('btnSettings').addEventListener('click', () => this.openSettings());
  }
  undo() { const l = this.store.undo(); this.toast(l ? `Undid ${l}` : 'Nothing to undo'); }
  redo() { const l = this.store.redo(); this.toast(l ? `Redid ${l}` : 'Nothing to redo'); }

  async pickWav(relink = null) {
    if (!this.host.localFiles || !this.host.available) return;
    this._pendingRelink = relink;
    if (typeof window.showOpenFilePicker === 'function') {
      try {
        const [h] = await window.showOpenFilePicker({ types: [{ description: 'Audio', accept: { 'audio/wav': ['.wav', '.wave'], 'audio/*': ['.aif', '.aiff', '.flac', '.mp3', '.m4a', '.ogg'] } }], multiple: false });
        const f = await h.getFile(); this._pendingRelink = null;
        await this.openWavFile(f, relink ? { relink } : {}); return;
      } catch (e) { if (e && e.name === 'AbortError') { this._pendingRelink = null; return; } /* fall back to <input> */ }
    }
    this.$('fileWav').click();
  }
  async pickNotes() {
    if (!this.host.localFiles || !this.host.available) return;
    if (typeof window.showOpenFilePicker === 'function') {
      try {
        const [h] = await window.showOpenFilePicker({ types: [{ description: 'Notes JSON', accept: { 'application/json': ['.json'] } }], multiple: false });
        const f = await h.getFile();
        const ok = await this.loadNotesFile(f);
        if (ok) { this.persist.saveHandle = h; this.$('saveTarget').textContent = `→ ${h.name}`; }
        return;
      } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    this.$('fileJson').click();
  }

  async saveNotes({ forcePicker = false } = {}) {
    if (!this.requireTrack()) return;
    const text = this.persist.serialize(this.currentDocument());
    try {
      const r = await this.persist.saveText(text, this.persist.suggestedName(this.info), { forcePicker });
      if (!r) return; // cancelled
      this.dirty = false; this.updateDirty();
      this.persist.autosave(this.info.fingerprint, text, false);
      this.$('saveTarget').textContent = r.method === 'fs' ? `→ ${r.name}` : '(downloaded)';
      this.toast(r.method === 'fs' ? `Saved ${r.name}` : `Downloaded ${r.name}`);
    } catch (e) { this.banner(`Save failed: ${U.escapeHtml(e.message)}`, { error: true }); }
  }
  autosaveNow() {
    if (!this.info) return;
    this.persist.autosave(this.info.fingerprint, this.persist.serialize(this.currentDocument()), this.dirty);
  }
  offerAutosaveRestore(fp) {
    const a = this.persist.readAutosave(fp);
    if (!a || !a.dirty) return;
    this.banner(`Unsaved notes for this file were autosaved at ${U.escapeHtml((a.savedAt || '').replace('T', ' ').slice(0, 19))}. Restore them?`, {
      actions: [{ label: 'Restore', primary: true, onClick: () => this.loadNotesText(a.text, 'autosave', { silentReplace: true }).then(() => { this.dirty = true; this.updateDirty(); }) }, { label: 'Discard', onClick: () => this.persist.clearAutosave(fp) }],
    });
  }

  async loadNotesFile(file) {
    if (!this.host.localFiles || !this.host.available) return false;
    if (!this.info) { this.toast('Open the WAV first, then load its notes.', { error: true }); return false; }
    let text; try { text = await file.text(); } catch (e) { this.toast('Could not read file: ' + e.message, { error: true }); return false; }
    return this.loadNotesText(text, file.name);
  }
  /** @returns {Promise<boolean>} true when the document was applied */
  async loadNotesText(text, sourceName, { silentReplace = false } = {}) {
    if (!this.info) { this.toast('Open the WAV first, then load its notes.', { error: true }); return false; }
    const { doc, errors, warnings } = this.persist.parseDocument(text);
    if (!doc) { await this.errorList(`Cannot load ${sourceName}`, 'The file is not a valid notes document:', errors); return false; }
    // fingerprint check
    let keepSeconds = false;
    if (doc.track.fingerprint !== this.info.fingerprint) {
      const body = U.el('div', {}, U.el('p', { text: `These notes were saved for "${doc.track.fileName}" (${U.fmtTime(doc.track.durationSeconds)}, ${doc.track.sampleRate} Hz), but the open file is "${this.info.fileName}" (${U.fmtTime(this.info.durationSeconds)}, ${this.info.sampleRate} Hz). The fingerprints differ.` }), U.el('p', { class: 'muted small', text: 'Load anyway keeps every note at its time in seconds and recomputes sample positions for this file.' }));
      const r = await this.confirm({ title: 'Notes belong to a different audio file', body, buttons: [{ label: 'Load anyway (keep seconds)', value: 'load', primary: true }, { label: 'Cancel', value: null }] });
      if (r !== 'load') return false;
      keepSeconds = true;
    }
    const norm = this.persist.normalize(doc, keepSeconds ? doc.track.sampleRate || this.info.sampleRate : this.info.sampleRate);
    if (keepSeconds) for (const n of norm.notes) { n.start = this.store.posFromSeconds(n.start.seconds); if (n.end) n.end = this.store.posFromSeconds(n.end.seconds); }
    else for (const n of norm.notes) { n.start = this.store.pos(n.start.samples); if (n.end) n.end = this.store.pos(n.end.samples); }
    // decide replace vs import
    const pristine = this.store.notes.length === 0 && this.store.layers.length === 1 && !this.dirty;
    let mode = 'replace';
    if (!pristine && !silentReplace) {
      const clashes = norm.layers.filter(l => this.store.layers.some(x => x.name === l.name)).map(l => l.name);
      const body = U.el('div', {}, U.el('p', { text: `This document already has ${this.store.notes.length} note(s) in ${this.store.layers.length} layer(s).` }), clashes.length ? U.el('p', { text: `Layer name${clashes.length > 1 ? 's' : ''} in both: ${clashes.join(', ')}.` }) : null);
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      const r = await this.confirm({ title: 'Load notes: replace or import?', body, buttons: [{ label: 'Replace everything', value: 'replace', danger: true }, { label: clashes.length ? `Import as "… (imported ${stamp})"` : 'Import as additional layers', value: 'import', primary: true }, { label: 'Cancel', value: null }] });
      if (!r) return false; mode = r;
    }
    if (mode === 'replace') {
      this.store.categories = (doc.settings && Array.isArray(doc.settings.categories) && doc.settings.categories.length) ? doc.settings.categories.slice() : DEFAULT_CATEGORIES.slice();
      this.store.categoryColors = Object.assign({}, CATEGORY_COLORS, (doc.settings && doc.settings.categoryColors) || {});
      if (doc.settings && doc.settings.snap) { this.settings.snap = doc.settings.snap; this.$('selSnap').value = doc.settings.snap; }
      if (doc.grid) { this.grid = Grid.fromJSON(doc.grid); this.view.setGrid(this.grid); }
      this.persist.extra = norm.extra; this.persist.history = norm.history;
      this.store.load({ layers: norm.layers, notes: norm.notes });
      this.activeLayerId = this.store.layers[0] ? this.store.layers[0].id : null;
      this.dirty = keepSeconds; this.updateDirty();
      if (keepSeconds) this.persist.history.push({ at: U.nowIso(), event: 'loaded-against-different-audio', from: doc.track.fileName, to: this.info.fileName });
    } else {
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
      this.store.commit('import notes', (s) => {
        for (const l of norm.layers) { if (s.layers.some(x => x.name === l.name)) l.name = s.uniqueLayerName(`${l.name} (imported ${stamp})`); if (s.layer(l.id)) { const old = l.id; l.id = U.uid('L'); for (const n of norm.notes) { if (n.layerId === old) n.layerId = l.id; for (const r of n.replies) if (r.layerId === old) r.layerId = l.id; } } s.layers.push(l); }
        for (const n of norm.notes) { if (s.note(n.id)) n.id = U.uid('n'); s.notes.push(n); }
        for (const c of ((doc.settings && doc.settings.categories) || [])) if (!s.categories.includes(c)) s.categories.push(c);
      });
    }
    this.refreshAnalysis(); this.renderGridPanel(); this.renderAll(); this.onTime(this.transport.currentTime);
    const msgs = warnings.concat(norm.warnings);
    if (msgs.length) this.banner(msgs.map(U.escapeHtml).join('<br>'));
    this.toast(`Loaded ${norm.notes.length} note(s) in ${norm.layers.length} layer(s) from ${sourceName}`);
    return true;
  }

  /* ---------- relink ---------- */
  relinkDialog() {
    if (!this.requireTrack()) return;
    const d = this.$('dlgRelink'); this.$('rlSeconds').value = '0'; this.$('rlBars').value = '';
    this.$('rlCancel').onclick = () => d.close();
    this.$('rlChoose').onclick = () => {
      let off = parseFloat(this.$('rlSeconds').value) || 0;
      const bars = parseFloat(this.$('rlBars').value);
      if (!isNaN(bars) && this.grid.valid) off = bars * this.grid.barSeconds;
      d.close(); this.pickWav({ offsetSeconds: off });
    };
    d.showModal();
  }
  applyRelink(prevInfo, info, { offsetSeconds = 0 }) {
    const oldSr = prevInfo ? prevInfo.sampleRate : this.store.sampleRate;
    this.store.sampleRate = info.sampleRate;
    for (const n of this.store.notes) {
      const s = n.start.samples / oldSr + offsetSeconds; n.start = this.store.posFromSeconds(U.clamp(s, 0, info.durationSeconds));
      if (n.end) { const e = n.end.samples / oldSr + offsetSeconds; n.end = this.store.posFromSeconds(U.clamp(e, 0, info.durationSeconds)); if (n.end.samples <= n.start.samples) n.end = this.store.pos(n.start.samples + 1); }
    }
    this.store.clearHistory();
    this.persist.history.push({ at: U.nowIso(), event: 'relinked', from: prevInfo ? prevInfo.fileName : null, to: info.fileName, offsetSeconds, fromFingerprint: prevInfo ? prevInfo.fingerprint : null, toFingerprint: info.fingerprint });
    this.persist.saveHandle = null; this.$('saveTarget').textContent = '';
    this.dirty = true;
    this.toast(`Re-linked ${this.store.notes.length} note(s) to ${info.fileName}${offsetSeconds ? ` with offset ${offsetSeconds.toFixed(3)} s` : ''}`);
  }

  /* ---------- exports ---------- */
  exportCtx() { return { info: this.info, grid: this.grid, store: this.store, notes: this.store.visibleNotes(), analysis: this.analysis }; }
  async exportMarkdown() { if (!this.requireTrack()) return; const r = await this.persist.exportText(Exports.markdown(this.exportCtx()), U.basename(this.info.fileName) + '.notes.md', 'text/markdown', '.md', 'Markdown'); if (r) this.toast(`Exported ${r.name}`); }
  async exportCsv() { if (!this.requireTrack()) return; const r = await this.persist.exportText(Exports.csv(this.exportCtx()), U.basename(this.info.fileName) + '.markers.csv', 'text/csv', '.csv', 'CSV'); if (r) this.toast(`Exported ${r.name}`); }
  async exportAiBundle() {
    if (!this.host.ai || !this.host.available) return;
    if (!this.requireTrack()) return;
    if (!this.analysis) this.toast('Descriptors are not ready yet; the bundle will not include the per-bar table.', { ms: 5000 });
    const r = await this.persist.exportText(Exports.aiBundle(this.exportCtx()), U.basename(this.info.fileName) + '.ai-request.md', 'text/markdown', '.md', 'AI request (Markdown)');
    if (r) this.toast(`Exported ${r.name} — paste it into the model, save the reply as ${U.basename(this.info.fileName)}.ai-response.json`, { ms: 6000 });
  }

  /* ---------- AI ---------- */
  bindAi() {
    this.$('fileAi').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { await this.importAiText(await f.text(), { source: f.name }); } catch (err) { this.toast(err.message, { error: true }); } });
    this.$('btnExportAi2').addEventListener('click', () => this.exportAiBundle());
    this.$('btnImportAi2').addEventListener('click', () => this.$('fileAi').click());
    this.$('btnImportPasted').addEventListener('click', () => this.importAiText(this.$('aiPaste').value, { source: 'pasted text' }).then(ok => { if (ok) this.$('aiPaste').value = ''; }));
    this.$('btnAskAi2').addEventListener('click', () => this.askAi());
  }
  /** @returns {Promise<boolean>} */
  async importAiText(text, { source = 'response', model = null, requestId = null } = {}) {
    if (!this.host.ai || !this.host.available) return false;
    if (!this.requireTrack()) return false;
    if (!text || !text.trim()) { this.toast('Nothing to import.', { error: true }); return false; }
    let resp;
    try { resp = AiBridge.extractJson(text); } catch (e) { await this.errorList('AI response refused', `Could not parse JSON from ${source}:`, [e.message]); return false; }
    const { errors, skippable } = AiBridge.validateResponse(resp, { store: this.store, duration: this.info.durationSeconds });
    if (errors.length) { await this.errorList('AI response refused', `${source} does not match the response schema ($defs/aiResponse). Nothing was imported. Problems:`, errors.concat(skippable)); return false; }
    let skipInvalid = false;
    if (skippable.length) {
      const body = U.el('div', {}, U.el('p', { text: 'The response is valid but some items cannot be applied as-is:' }), U.el('ul', {}, skippable.map(s => U.el('li', { text: s }))), U.el('p', { class: 'muted small', text: 'Notes beyond the end are clamped to the end of the track; replies to unknown notes are dropped only if you choose to continue.' }));
      const r = await this.confirm({ title: 'Import with listed items skipped?', body, buttons: [{ label: 'Import, skipping listed items', value: 'go', primary: true }, { label: 'Cancel', value: null }] });
      if (r !== 'go') return false; skipInvalid = true;
    }
    const res = AiBridge.importResponse(resp, { store: this.store, sampleRate: this.sr, duration: this.info.durationSeconds, snapFn: this.settings.snapOn && this.grid.valid ? (sec) => this.grid.snap(sec, this.settings.snap) : null, model, requestId, skipInvalid });
    this.showTab('ai'); if (this.host.ai) this.renderAiSummaries();
    const rep = this.$('aiReport'); rep.hidden = false;
    rep.textContent = `Imported layer "${res.layer.name}": ${res.created.length} note(s), ${res.replies.length} repl${res.replies.length === 1 ? 'y' : 'ies'}${res.skipped.length ? `; skipped: ${res.skipped.join(', ')}` : ''}.`;
    this.toast(`Imported "${res.layer.name}" (${res.created.length} notes, ${res.replies.length} replies)`);
    return true;
  }
  renderAiSummaries() {
    const box = this.$('aiSummaries'); box.innerHTML = '';
    const ai = this.store.layers.filter(l => l.kind === 'ai');
    if (!ai.length) { box.textContent = 'No AI layers yet.'; return; }
    for (const l of ai) box.append(U.el('div', { class: 'ai-summary' }, U.el('div', { class: 's-name', text: `${l.name}${l.source && l.source.model ? ` · ${l.source.model}` : ''} · ${this.store.layerNoteCount(l.id)} notes` }), U.el('div', { text: l.summary || '(no summary)' })));
  }
  async askAi() {
    if (!this.host.ai || !this.host.available) return;
    if (!this.requireTrack()) return;
    const key = AiBridge.getKey(), model = AiBridge.getModel();
    const status = this.$('aiStatus');
    if (!key) { this.showTab('ai'); status.textContent = 'No API key. Add one in Settings, or use the copy-paste bundle.'; this.banner('Direct AI request needs an API key: open <b>Settings</b> and paste one, or use <b>Export AI bundle</b> and paste the text yourself.', { error: true, actions: [{ label: 'Open Settings', primary: true, onClick: () => this.openSettings() }] }); return; }
    if (!model) { this.showTab('ai'); status.textContent = 'No model name. Type one in Settings, or use the copy-paste bundle.'; this.banner('Direct AI request needs a model name you type in <b>Settings</b>. An empty model is not sent. The copy-paste bundle needs no key and no model.', { error: true, actions: [{ label: 'Open Settings', primary: true, onClick: () => this.openSettings() }] }); return; }
    const r = await this.confirm({ title: 'Send bundle to Anthropic?', body: `This sends the text bundle (metadata, your notes, the per-${this.analysis ? this.analysis.unit : 'second'} descriptor table) to api.anthropic.com using model "${model}". No audio is sent.`, buttons: [{ label: 'Send', value: 'go', primary: true }, { label: 'Cancel', value: null }] });
    if (r !== 'go') return;
    this.showTab('ai'); status.textContent = `Asking ${model}…`;
    const bundle = Exports.aiBundle(this.exportCtx());
    try {
      const res = await AiBridge.request(bundle, { apiKey: key, model, maxTokens: 8000 });
      status.textContent = `Reply received (${res.usage ? res.usage.output_tokens + ' output tokens' : 'ok'}). Importing…`;
      const ok = await this.importAiText(res.text, { source: `${model} reply`, model: res.model || model, requestId: res.requestId });
      status.textContent = ok ? `Imported reply from ${res.model || model}.` : 'Reply could not be imported (see message).';
    } catch (e) {
      status.textContent = `Failed: ${e.message}`;
      this.banner(`AI request failed${e.status ? ` (HTTP ${e.status})` : ''}: ${U.escapeHtml(e.message)}`, { error: true });
    }
  }

  /* ---------- settings ---------- */
  bindSettings() {
    this.$('setCancel').addEventListener('click', () => this.$('dlgSettings').close());
    this.$('setSave').addEventListener('click', () => this.saveSettings());
    this.$('setForgetKey')?.addEventListener('click', () => { AiBridge.setKey(''); this.$('setApiKey').value = ''; this.toast('API key forgotten'); });
    this.$('setClearCache').addEventListener('click', async () => { await this.cache.clear(); if (this.disposed) return; this.$('setCacheInfo').textContent = 'Peak cache cleared.'; this.toast('Peak cache cleared'); });
    this.$('setClearAutosave').addEventListener('click', () => { if (this.persist.clearAutosaves) this.persist.clearAutosaves(); else { try { for (const k of Object.keys(localStorage)) if (k.startsWith('note:autosave:')) localStorage.removeItem(k); } catch (_) { } } this.toast('Autosaves cleared'); });
  }
  async openSettings() {
    this.$('setCategories').value = this.store.categories.map(c => `${c}${this.store.categoryColors[c] ? ', ' + this.store.categoryColors[c] : ''}`).join('\n');
    if (this.host.ai) { this.$('setApiKey').value = AiBridge.getKey(); this.$('setModel').value = AiBridge.getModel(); }
    const count = await this.cache.count();
    if (this.disposed) return;
    this.$('setCacheInfo').textContent = `Peak cache entries: ${count}`;
    this.$('dlgSettings').showModal();
  }
  saveSettings() {
    const cats = [], colors = Object.assign({}, this.store.categoryColors);
    for (const line of this.$('setCategories').value.split('\n')) {
      const [name, color] = line.split(',').map(s => s.trim()); if (!name) continue;
      cats.push(name); if (color && U.hexToRgb(color)) colors[name] = color.startsWith('#') ? color : '#' + color;
    }
    if (cats.length) { this.store.categories = cats; this.store.categoryColors = colors; this.markDirty(); }
    if (this.host.ai) { AiBridge.setKey(this.$('setApiKey').value.trim()); AiBridge.setModel(this.$('setModel').value.trim()); }
    this.$('dlgSettings').close(); this.renderAll(); this.toast('Settings saved');
  }

  /* ---------- keyboard ---------- */
  bindShortcuts() {
    window.addEventListener('keydown', (e) => {
      if (this.disposed) return;
      if (document.querySelector('dialog[open]')) return;
      if (this.mode === 'loops') { if (this.loopLab) this.loopLab.handleKey(e); return; }
      const typing = U.isTypingTarget(e.target);
      const mod = e.metaKey || e.ctrlKey;
      // global chords that also work while typing
      if (mod && !e.altKey) {
        const k = e.key.toLowerCase();
        if (k === 's') { e.preventDefault(); this.saveNotes({ forcePicker: e.shiftKey }); return; }
        if (k === 'o') { e.preventDefault(); if (e.shiftKey) this.pickNotes(); else this.pickWav(); return; }
        if (k === 'z' && !typing) { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
        if (k === 'y' && !typing) { e.preventDefault(); this.redo(); return; }
        return;
      }
      if (typing) return; // editor / inputs own their keys (Enter, Esc handled by the editor form)
      const t = this.transport; const key = e.key;
      const stop = () => { e.preventDefault(); e.stopPropagation(); };
      switch (key) {
        case ' ': stop(); t.toggle(); return;
        case 'Enter': stop(); if (this.selectedNoteId && document.activeElement && document.activeElement.classList.contains('note-row')) return; t.stop(); return;
        case 'Escape': stop(); if (this.editing) this.cancelEditor(); else if (this.selection) this.setSelection(null); else if (this.selectedNoteId) this.selectNote(null); return;
        case 'Home': stop(); t.seek(0); return;
        case 'End': stop(); if (this.info) t.seek(this.info.durationSeconds); return;
        case 'ArrowLeft': stop(); t.nudge(e.shiftKey ? -10 : -1); return;
        case 'ArrowRight': stop(); t.nudge(e.shiftKey ? 10 : 1); return;
        case '[': stop(); this.gotoAdjacent(-1); return;
        case ']': stop(); this.gotoAdjacent(1); return;
        case 'Backspace': case 'Delete': if (this.selectedNoteId) { stop(); this.deleteSelected(); } return;
        case '?': stop(); this.$('dlgHelp').showModal(); return;
        case '+': case '=': stop(); this.view.zoomBy(0.5); return;
        case '-': case '_': stop(); this.view.zoomBy(2); return;
        case '0': stop(); this.view.fit(); return;
      }
      const k = key.toLowerCase();
      if (k === 'm') { stop(); if (e.shiftKey) this.addIntervalFromSelection(); else if (e.altKey && this.view.hoverX !== null) this.addPinAt(this.view.secAtX(this.view.hoverX)); else this.addPinAt(t.currentTime); return; }
      if (k === 'i') { stop(); this.setInPoint(); return; }
      if (k === 'o') { stop(); this.setOutPoint(); return; }
      if (k === 'l') { stop(); this.toggleLoop(); return; }
      if (k === 's') { stop(); this.toggleSnap(); return; }
      if (k === 'g') { stop(); this.toggleGridLines(); return; }
      if (k === 'a') { stop(); this.toggleAnalysis(); return; }
      if (k === 'f') { stop(); this.view.centerOn(t.currentTime * this.sr); return; }
      if (k === 'n') { stop(); this.gotoAdjacent(1, true); return; }
      if (k === 'e' && this.selectedNoteId) { stop(); this.openEditor(this.selectedNoteId); return; }
    }, true);
  }
}

if (!document.body.dataset.bounceHost) {
  window.app = new App();
  document.addEventListener('DOMContentLoaded', () => window.app.init());
}

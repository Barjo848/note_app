/* looplab.js — LoopLab: the Loop Lab mode UI. Library table, per-loop
 * waveform with hit markers and hit map, rating form, player/metronome
 * controls, A/B with blind mode, signature/metrics/layers panels, settings,
 * sidecar import, exports, autosave. */
'use strict';

const DRUM_ROWS = ['hat', 'snare', 'kick', 'other'];
const MACHINE_SCORE_CAPTION = (document.getElementById('lbMachineCaption') && document.getElementById('lbMachineCaption').textContent.trim()) || '';

class LoopLab {
  constructor(app) {
    this.app = app; this.$ = (id) => document.getElementById(id);
    this.lib = new LoopLibrary(); this.player = new LoopPlayer(); this.persist = new Persistence();
    this.worker = null; this.currentId = null; this.ab = { A: null, B: null }; this.blind = { on: false, swapped: false, revealed: false };
    this.sort = { key: 'position', dir: null, secondary: null, unratedFirst: false }; this.filter = ''; this.dirty = false; this.compareLayerId = null;
    this.reveal = 'hidden'; this.reference = null; this.weights = Object.assign({}, Ranking.presets.all); this.filters = Ranking.emptyFilters(); this.groupBySection = false; this.randomSeed = String(Math.floor(Math.random() * 90000) + 10000);
    this.ratingBuffer = ''; this.lastRatedId = null; this.autoPlay = true; this.seamCache = new Map();
    this.zoomJoin = false; this.hoverHit = null; this._peaksCache = new Map();
    this.progress = { total: 0, done: 0 };
    this._autosave = U.debounce(() => this.autosaveNow(), 500);
    this.rateSteps = [0.5, 0.75, 1];
  }

  /* ================= boot ================= */
  init() {
    try { this.worker = new OnsetWorker(); } catch (e) { console.warn('onset worker unavailable, using main thread', e); }
    this.lib.onChange((ev) => this.onLibChange(ev));
    this.player.on('state', () => this.renderTransport());
    this.player.on('deck', () => this.renderTransport());
    this.bindToolbar(); this.bindLibrary(); this.bindDetail(); this.bindTransport(); this.bindSettings();
    this.library = new LibraryLoader(this); this.strip = new SongStrip(this.$('lbStrip'), this); this.bindRatingFlow();
    this.strip.on('select', (id) => this.select(id, { play: this.player.playing })); this.strip.on('range', (r) => { this.filters.barRange = r; this.renderTable(); });
    this.seq = new SequenceStore(this.lib); this.view = 'library'; this.currentArrId = null; this.seqAB = { A: null, B: null }; this.playingArrId = null; this.seqMode = null;
    this.seqView = new SequenceView(this, { ruler: this.$('sqRuler'), lane: this.$('sqLane'), mapping: this.$('sqMapping'), container: this.$('seqMain') });
    this.bindSequence(); this.bindSortUi();
    this.wave = this.$('lbWave'); this.hitmap = this.$('lbHitmap');
    this.wave.addEventListener('mousemove', (e) => this.onWaveHover(e)); this.wave.addEventListener('mouseleave', () => { this.hoverHit = null; this.$('lbTooltip').hidden = true; this.drawWave(); });
    this.wave.addEventListener('click', (e) => this.onWaveClick(e));
    this.hitmap.addEventListener('click', (e) => this.onHitmapClick(e));
    this.hitmap.addEventListener('mousemove', (e) => this.onHitmapHover(e)); this.hitmap.addEventListener('mouseleave', () => { this.$('lbTooltip').hidden = true; });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.drawAll()).observe(this.$('lbDetail'));
    this._raf = () => { if (this.active) { if (this.view === 'sequence') { if (this.player.inSequence) { this.seqView.draw(); } this.renderSeqTransport(); } else this.renderPlayhead(); } requestAnimationFrame(this._raf); };
    requestAnimationFrame(this._raf);
    this.renderAll();
  }
  get active() { return this.app.mode === 'loops'; }
  activate() { this.drawAll(); this.renderAll(); this.offerAutosaveRestore(); }
  deactivate() { this.player.stop(); }

  toast(m, o) { this.app.toast(m, o); }
  markDirty() { this.dirty = true; this.$('lbDirty').hidden = false; this._autosave(); this._serverSave(); }
  _serverSave() {
    if (!this.library || !this.library.endpoint || !this.library.current) return;
    clearTimeout(this._serverTimer); this._serverTimer = setTimeout(async () => { const ok = await this.library.saveSession(this.lib.buildDocument()); if (ok) { this.clearDirty(); this.$('lbSaveTarget').textContent = `saved ${new Date().toTimeString().slice(0, 8)} → library`; } }, 800);
  }
  clearDirty() { this.dirty = false; this.$('lbDirty').hidden = true; }
  onLibChange(ev) {
    if (!['load'].includes(ev.label)) this.markDirty();
    this.renderAll();
    if (this.seqView) { this.seqView.refresh(); if (this.view === 'sequence') this.renderSeqAll(); }
  }
  get current() { return this.currentId ? this.lib.loop(this.currentId) : null; }

  /* ================= files ================= */
  bindToolbar() {
    this.$('lbOpenFiles').addEventListener('click', () => this.pickFiles());
    this.$('lbFiles').addEventListener('change', (e) => { const fs = Array.from(e.target.files); e.target.value = ''; this.openFiles(fs); });
    this.$('lbOpenFolder').addEventListener('click', () => this.pickFolder());
    this.$('lbLoadJson').addEventListener('click', () => this.pickJson());
    this.$('lbJson').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.loadJsonText(await f.text(), f.name); });
    this.$('lbSave').addEventListener('click', () => this.save());
    this.$('lbSaveAs').addEventListener('click', () => this.save({ forcePicker: true }));
    const menu = this.$('lbExportMenu').parentElement;
    this.$('lbExportMenu').addEventListener('click', (e) => { e.stopPropagation(); menu.classList.toggle('open'); });
    document.addEventListener('click', () => menu.classList.remove('open'));
    this.$('lbExportMd').addEventListener('click', () => this.exportText(this.maskHidden(this.lib.exportMarkdown()), '.loops.md', 'text/markdown', '.md', 'Markdown ranking'));
    this.$('lbExportCsv').addEventListener('click', () => this.exportText(this.maskHidden(this.lib.exportCsv()), '.loops.csv', 'text/csv', '.csv', 'CSV ranking'));
    this.$('lbExportRatings').addEventListener('click', () => this.exportRatings());
    this.$('lbImportRatings').addEventListener('click', () => this.$('lbRatingsFile').click());
    this.$('lbRatingsFile').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.importRatingsText(await f.text(), f.name); });
    this.$('lbRevealMode').addEventListener('change', (e) => this.setReveal(e.target.value));
    this.$('lbImportSidecar').addEventListener('click', () => this.$('lbSidecar').click());
    this.$('lbSidecar').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.importSidecarText(await f.text(), f.name); });
    this.$('lbName').addEventListener('change', (e) => { this.lib.session.name = e.target.value; this.markDirty(); });
    this.$('lbSourceNote').addEventListener('change', (e) => { this.lib.session.sourceNote = e.target.value; this.markDirty(); });
    const gridChange = () => { const bpm = parseFloat(this.$('lbBpm').value), num = parseInt(this.$('lbNum').value, 10), den = parseInt(this.$('lbDen').value, 10); if (bpm > 0) this.lib.session.bpm = bpm; if (num > 0) this.lib.session.meterNumerator = num; if (den > 0) this.lib.session.meterDenominator = den; this.onGridChanged(); };
    for (const id of ['lbBpm', 'lbNum', 'lbDen']) this.$(id).addEventListener('change', gridChange);
    this.$('lbHelp').addEventListener('click', () => this.$('dlgLabHelp').showModal());
    this.$('lbSettings').addEventListener('click', () => this.openSettings());
  }
  onGridChanged() {
    this.player.setGrid(this.lib.session.bpm, this.lib.session.meterNumerator, this.lib.session.meterDenominator);
    for (const l of this.lib.loops) { this.lib.computeBars(l); if (l._raw) this.lib.setRawHits(l, l._raw, { stemVerified: l.stemVerified }); }
    this.lib.recompute(); this.markDirty(); this.renderAll(); this.drawAll();
  }
  async pickFiles() {
    if (typeof window.showOpenFilePicker === 'function') {
      try { const hs = await window.showOpenFilePicker({ multiple: true, types: [{ description: 'WAV loops', accept: { 'audio/wav': ['.wav', '.wave'] } }] }); const files = []; for (const h of hs) files.push(await h.getFile()); return this.openFiles(files); }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    this.$('lbFiles').click();
  }
  async pickFolder() {
    if (typeof window.showDirectoryPicker !== 'function') { this.toast('Folder opening needs Chrome over http:// (or drop the files onto the window).', { error: true }); return this.$('lbFiles').click(); }
    try {
      const dir = await window.showDirectoryPicker({ mode: 'read' }); const files = [];
      for await (const [name, handle] of dir.entries()) if (handle.kind === 'file' && /\.wav$/i.test(name)) files.push(await handle.getFile());
      if (!this.lib.session.name) { this.lib.session.name = dir.name; this.$('lbName').value = dir.name; }
      await this.openFiles(files);
    } catch (e) { if (!(e && e.name === 'AbortError')) this.toast('Folder open failed: ' + e.message, { error: true }); }
  }
  async pickJson() {
    if (typeof window.showOpenFilePicker === 'function') {
      try { const [h] = await window.showOpenFilePicker({ types: [{ description: 'loops.json', accept: { 'application/json': ['.json'] } }] }); const f = await h.getFile(); const ok = await this.loadJsonText(await f.text(), f.name); if (ok) { this.persist.saveHandle = h; this.$('lbSaveTarget').textContent = `→ ${h.name}`; } return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    this.$('lbJson').click();
  }
  static stemRole(name) { const m = /^(.*)_(KICK|SNARE|HIHAT|HAT|HH)\.wav$/i.exec(name); if (!m) return null; const r = m[2].toUpperCase(); return { base: m[1], drum: r === 'KICK' ? 'kick' : r === 'SNARE' ? 'snare' : 'hat' }; }
  /** Open WAV files: parse headers, add entries, analyse each; stems attach to their loop. */
  async openFiles(files) {
    files = files.filter(f => /\.wav$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!files.length) { this.toast('No .wav files.', { error: true }); return; }
    const stems = [], loops = [];
    for (const f of files) (LoopLab.stemRole(f.name) ? stems : loops).push(f);
    this.progress = { total: loops.length + stems.length, done: 0 }; this.renderProgress('Reading headers…');
    const added = [];
    for (const f of loops) {
      try { const info = await WavReader.parse(f); const { entry } = this.lib.addFromInfo(info, f); added.push(entry); if (!entry.barsExact) this.toast(`${entry.id}: ${entry.bars.toFixed(3)} bars at ${this.lib.session.bpm} BPM — not a whole number`, { ms: 5000 }); }
      catch (e) { this.toast(`${f.name}: ${e.message}`, { error: true, ms: 6000 }); this.progress.done++; }
    }
    if (!this.currentId && added.length) this.select(added[0].id);
    for (const entry of added) { this.renderProgress(`Analysing ${entry.id}…`); await this.analyzeLoop(entry); this.progress.done++; this.renderProgress(); }
    for (const f of stems) {
      const role = LoopLab.stemRole(f.name); const target = this.lib.loops.find(l => U.basename(l.fileName) === role.base || l.id === role.base);
      if (!target) { this.toast(`Stem ${f.name}: no loop named ${role.base}`, { error: true }); this.progress.done++; continue; }
      target._stems[role.drum] = f; this.progress.done++;
    }
    for (const l of this.lib.loops) if (l._stems && Object.keys(l._stems).length && !l.stemVerified) { this.renderProgress(`Stems for ${l.id}…`); await this.analyzeStems(l); }
    this.progress = { total: 0, done: 0 }; this.renderProgress();
    this.lib.recompute(); this.renderAll(); this.drawAll(); this.markDirty();
    this.evictBuffers();
    this.toast(`${added.length} loop(s) loaded${stems.length ? `, ${stems.length} stem(s)` : ''}`);
  }
  renderProgress(label) { const p = this.$('lbProgress'); if (!this.progress.total) { p.hidden = true; return; } p.hidden = false; this.$('lbProgressFill').style.width = `${Math.round(100 * this.progress.done / this.progress.total)}%`; if (label) this.$('lbProgressLabel').textContent = label; }

  /* ================= audio buffers & analysis ================= */
  async ensureBuffer(entry) {
    if (entry._buffer) { entry._lastUsed = Date.now(); return entry._buffer; }
    if (!entry._file && !entry._url) throw new Error(`${entry.id}: audio file not linked (open the WAV again)`);
    const src = entry._file || await this.library.fetchBlob(entry);
    const buf = await this.player.decode(src, entry.sampleRate);
    entry._buffer = buf; entry._lastUsed = Date.now(); entry._rmsLin = LoopPlayer.rmsLinear(buf); entry.rmsDb = +U.ampDb(entry._rmsLin).toFixed(1);
    if (!entry.seamFeatures && entry.hits && entry.hits.length) { entry.seamFeatures = Sequence.loopFeatures(entry, buf, this.lib); if (this.seqView) this.seqView.refresh(); }
    return buf;
  }
  evictBuffers(limitBytes = 160 * 1024 * 1024) {
    const keep = new Set([this.currentId, this.ab.A, this.ab.B]);
    const held = this.lib.loops.filter(l => l._buffer).sort((a, b) => (a._lastUsed || 0) - (b._lastUsed || 0));
    let total = held.reduce((s, l) => s + l._buffer.length * l._buffer.numberOfChannels * 4, 0);
    for (const l of held) { if (total <= limitBytes) break; if (keep.has(l.id)) continue; total -= l._buffer.length * l._buffer.numberOfChannels * 4; l._buffer = null; }
  }
  monoOf(buffer) { const n = buffer.length, ch = buffer.numberOfChannels, m = new Float32Array(n); for (let c = 0; c < ch; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < n; i++) m[i] += d[i] / ch; } return m; }
  async analyzeLoop(entry) {
    try {
      const buf = await this.ensureBuffer(entry);
      const mono = this.monoOf(buf); const floors = this.lib.session.bandFloorsDb || {};
      const opts = { floors: { low: floors.low ?? undefined, mid: floors.mid ?? undefined, high: floors.high ?? undefined }, flamMs: this.lib.session.thresholds.flamMs };
      const r = this.worker ? await this.worker.analyzeMono(mono, buf.sampleRate, opts) : OnsetDsp.analyzeMono(mono, buf.sampleRate, opts);
      entry._raw = r.hits; entry._floors = r.floors;
      this.lib.setRawHits(entry, r.hits, { stemVerified: false });
      const chans = []; for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
      entry._join = OnsetDsp.joinAnalysis(chans, buf.sampleRate, r.hits.map(h => h.ms), buf.length);
      entry.seamFeatures = Sequence.loopFeatures(entry, buf, this.lib);
      this._peaksCache.delete(entry.id);
    } catch (e) { this.toast(`Analysis failed for ${entry.id}: ${e.message}`, { error: true }); }
  }
  async analyzeStems(entry) {
    try {
      const raw = [];
      for (const [drum, file] of Object.entries(entry._stems)) {
        const buf = await this.player.decode(file, entry.sampleRate); const mono = this.monoOf(buf);
        const r = this.worker ? await this.worker.analyzeStem(mono, buf.sampleRate, drum, {}) : { hits: OnsetDsp.analyzeStem(mono, buf.sampleRate, drum, {}) };
        raw.push(...r.hits);
      }
      raw.sort((a, b) => a.ms - b.ms); entry._raw = raw;
      this.lib.setRawHits(entry, raw, { stemVerified: true });
      if (entry._buffer) entry.seamFeatures = Sequence.loopFeatures(entry, entry._buffer, this.lib);
    } catch (e) { this.toast(`Stem analysis failed for ${entry.id}: ${e.message}`, { error: true }); }
  }
  async reanalyzeAll() { this.progress = { total: this.lib.loops.length, done: 0 }; for (const l of this.lib.loops) { if (!l._file) { this.progress.done++; continue; } this.renderProgress(`Analysing ${l.id}…`); if (l._stems && Object.keys(l._stems).length) await this.analyzeStems(l); else await this.analyzeLoop(l); this.progress.done++; } this.progress = { total: 0, done: 0 }; this.renderProgress(); this.lib.recompute(); this.renderAll(); this.drawAll(); this.markDirty(); }

  /* ================= selection & library ================= */
  ctx() { const self = this; return { lib: this.lib, rec: (l) => this.claudeRec(l), revealed: (l) => this.isRevealed(l), reference: this.reference, weights: this.weights, seamCache: this.seamCache, seed: this.randomSeed, get _sectionOrder() { return self._sectionOrder; }, set _sectionOrder(v) { self._sectionOrder = v; } }; }
  claudeLayer() { return this.lib.layers.find(l => l.kind === 'imported' && (l.name === IMPORTED_LAYER_NAME || l.name === 'Claude')) || this.lib.layers.find(l => l.kind === 'imported') || null; }
  claudeRec(l) { const ly = this.claudeLayer(); return ly && ly.loops[l.id] ? ly.loops[l.id] : null; }
  isRevealed(l) { return this.reveal === 'all' || (this.reveal === 'rated' && !!l && l.rating !== null && l.rating !== undefined); }
  visibleLoops() {
    this.filters.text = this.filter; this._sectionOrder = null;
    const ctx = this.ctx(); let list = Ranking.apply(this.lib.loops, this.filters, ctx);
    const key = (this.sort.key === 'disagreement' && this.reveal === 'hidden') ? 'position' : this.sort.key;
    return Ranking.sort(list, { key, dir: this.sort.dir, secondary: this.sort.secondary, unratedFirst: this.sort.unratedFirst, ctx });
  }
  mistakeCount(l) { const m = (l.machine && l.machine.mistakes) || {}; return Object.values(m).reduce((a, b) => a + b, 0); }
  statusOf(l) { if (!l._file && !l._url) return 'unlinked'; if (!l._analysed) return 'pending'; return l.rating !== null ? 'rated' : (l.skipped ? 'skipped' : 'analysed'); }
  compareLayer() { return this.compareLayerId ? this.lib.layers.find(l => l.id === this.compareLayerId) : null; }
  bindLibrary() {
    this.$('lbFilter').addEventListener('input', (e) => { this.filter = e.target.value; this.renderTable(); });
    for (const th of U.$$('#lbTable th[data-sort]')) th.addEventListener('click', () => { const k = th.dataset.sort; if (this.sort.key === k) this.sort.dir = -(this.sort.dir || Ranking.keyByName(k).dir); else { this.sort.key = k; this.sort.dir = null; } this.renderSortUi(); this.renderTable(); });
  }
  select(id, { play = false } = {}) {
    this.currentId = id; const l = this.current; this.zoomJoin = false;
    if (l) { l._lastUsed = Date.now(); this.ensureBuffer(l).then(() => { this.evictBuffers(); this.drawAll(); }).catch(() => { }); }
    this.renderTable(); this.renderDetail(); this.drawAll();
    if (play) this.play();
  }
  hidden() { return '·'; }
  renderTable() {
    const tb = this.$('lbTable').querySelector('tbody'); tb.innerHTML = '';
    const list = this.visibleLoops(); this.$('lbCount').textContent = `${list.length}/${this.lib.loops.length}`;
    for (const th of U.$$('#lbTable th[data-sort]')) { th.classList.toggle('sorted', th.dataset.sort === this.sort.key); th.textContent = th.dataset.label + (th.dataset.sort === this.sort.key ? ((this.sort.dir || Ranking.keyByName(this.sort.key).dir) > 0 ? ' ▲' : ' ▼') : ''); }
    const anyRevealed = this.reveal !== 'hidden'; this.$('lbThClaude').hidden = !anyRevealed; this.$('lbThWeak').hidden = !anyRevealed; this.$('lbThMachine').hidden = !anyRevealed;
    this.$('lbThSim').hidden = !this.reference;
    const rows = this.groupBySection ? Ranking.groupBySection(list, this.ctx()) : [{ section: null, loops: list }];
    let n = 0;
    for (const g of rows) {
      if (g.section !== null) tb.append(U.el('tr', { class: 'group' }, U.el('td', { colspan: '17', text: `${g.section} (${g.loops.length})` })));
      for (const l of g.loops) {
        n++; const m = l.machine || {}; const rec = this.claudeRec(l) || {}; const rev = this.isRevealed(l);
        const blindHide = this.blind.on && !this.blind.revealed && (l.id === this.ab.A || l.id === this.ab.B);
        const deck = !blindHide && l.id === this.ab.A ? 'A' : !blindHide && l.id === this.ab.B ? 'B' : '';
        const dist = this.reference ? Ranking.distance(this.reference, l, this.weights) : null;
        const tr = U.el('tr', { class: (l.id === this.currentId ? 'selected ' : '') + (l.barsExact ? '' : 'inexact ') + (l.skipped && l.rating === null ? 'skipped' : ''), dataset: { id: l.id }, tabindex: '0' },
          U.el('td', { class: 'num', text: String(n) }),
          U.el('td', { html: `${U.escapeHtml(l.id)}${deck ? ` <span class="deck-tag">${deck}</span>` : ''}${this.reference && this.reference.id === l.id ? ' <span class="deck-tag ref">ref</span>' : ''}${l.stemVerified ? ' <span class="pill">stems</span>' : ''}`, title: l.fileName }),
          U.el('td', { class: 'num', text: l.ptStart !== null && l.ptStart !== undefined ? `${l.ptStart}–${l.ptEnd - 1}` : '' }),
          U.el('td', { class: 'num', text: Ranking.lengthKey(l) === 'event' ? 'ev' : Ranking.lengthKey(l) + (l.barsExact ? '' : '⚠'), title: `${l.bars.toFixed(3)} bars · ${l.durationSeconds.toFixed(3)} s` }),
          U.el('td', { class: 'sec', text: rec.section || '', title: rec.use || '' }),
          U.el('td', { text: rec.hats ? rec.hats[0] : '', title: rec.hats || '' }),
          U.el('td', { text: rec.bassOutBars ? (rec.bassOutBars.length ? 'out' : 'in') : '' }),
          U.el('td', { class: 'num rating', text: LoopLibrary.formatRating(l.rating) || (l.skipped ? 'skip' : '—') }),
          U.el('td', { class: 'small', text: l.myClass || '' }),
          U.el('td', { class: 'num muted', text: String(l.listens || 0) }),
          U.el('td', { class: 'num' + (this.mistakeCount(l) ? ' bad' : ''), text: String(this.mistakeCount(l)) }),
          U.el('td', { class: 'num', text: m.feelMs === null || m.feelMs === undefined ? '—' : (m.feelMs > 0 ? '+' : '') + m.feelMs.toFixed(1) }),
          U.el('td', { class: 'num claude', text: rev ? (typeof rec.score === 'number' ? rec.score.toFixed(1) : (typeof rec.ownPattern === 'number' ? rec.ownPattern.toFixed(1) + '*' : '—')) : this.hidden(), hidden: !anyRevealed, dataset: rev ? { claude: '1' } : {} }),
          U.el('td', { class: 'num claude', text: rev ? (typeof rec.loop === 'number' ? rec.loop.toFixed(1) : '—') : this.hidden(), hidden: !anyRevealed }),
          U.el('td', { class: 'num', text: rev ? (m.score === null || m.score === undefined ? '—' : m.score.toFixed(1)) : this.hidden(), hidden: !anyRevealed }),
          U.el('td', { class: 'num sim', text: dist ? dist.total.toFixed(2) : '', hidden: !this.reference, title: dist ? `pattern ${dist.pattern} · feel ${dist.feel} · sound ${dist.sound} · position ${dist.position}` : '' }),
          U.el('td', { class: 'small', text: (l.tags || []).join(' ') }));
        tr.addEventListener('click', () => this.select(l.id, { play: this.player.playing && this.autoPlay }));
        tr.addEventListener('dblclick', () => this.select(l.id, { play: true }));
        tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); this.select(l.id, { play: true }); } });
        tr.draggable = true; tr.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-loop-id', l.id); e.dataTransfer.setData('text/plain', l.id); e.dataTransfer.effectAllowed = 'copy'; });
        tr.lastChild.append(' ', U.el('button', { class: 'tiny', text: '+', title: 'Add to the current arrangement', onClick: (e) => { e.stopPropagation(); this.seqAddLoop(l.id); } }));
        tb.append(tr);
      }
    }
    if (!list.length) tb.append(U.el('tr', {}, U.el('td', { colspan: '17', class: 'muted', text: this.lib.loops.length ? 'No loops match the filters.' : 'Open loops… (multi-select), Open folder… (Chrome), or drop .wav files here.' })));
    this.renderRatedCount(); if (this.strip) this.strip.setData(this.lib.loops, this.ctx());
  }
  renderRatedCount() { const rated = this.lib.loops.filter(l => l.rating !== null && l.rating !== undefined).length, skipped = this.lib.loops.filter(l => l.skipped && (l.rating === null || l.rating === undefined)).length; const el = this.$('lbRatedCount'); if (el) el.textContent = this.lib.loops.length ? `rated ${rated} / ${this.lib.loops.length}${skipped ? ` · ${skipped} skipped` : ''}` : ''; }

  /* ================= detail (rating, tabs) ================= */
  bindDetail() {
    for (const b of U.$$('.lab-tabs [role=tab]')) b.addEventListener('click', () => this.showTab(b.dataset.tab));
    const ratingForm = this.$('lbRatingForm');
    ratingForm.addEventListener('submit', (e) => { e.preventDefault(); this.saveRating(); });
    ratingForm.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.target.tagName !== 'TEXTAREA' || e.metaKey || e.ctrlKey)) { e.preventDefault(); this.saveRating(); } if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.renderDetail(); this.$('lbTable').focus(); } });
    this.$('lbRatingSlider').addEventListener('input', (e) => { const v = LoopLibrary.clampRating(parseFloat(e.target.value)); this.$('lbRatingWhole').value = String(Math.floor(v)); this.$('lbRatingTenth').value = String(Math.round((v - Math.floor(v)) * 10)); });
    const syncSlider = () => { this.$('lbRatingSlider').value = String(this.ratingFromDigits() ?? 0); };
    this.$('lbRatingWhole').addEventListener('change', syncSlider); this.$('lbRatingTenth').addEventListener('change', syncSlider);
    this.$('lbSetA').addEventListener('click', () => this.assignDeck('A', this.currentId));
    this.$('lbSetB').addEventListener('click', () => this.assignDeck('B', this.currentId));
    this.$('lbRemoveLoop').addEventListener('click', async () => { const l = this.current; if (!l) return; const r = await this.app.confirm({ title: `Remove ${l.id} from the session?`, body: 'Its rating, notes and analysis are removed from the document (the file on disk is untouched).', buttons: [{ label: 'Remove', value: 'ok', danger: true }, { label: 'Cancel', value: null }] }); if (r === 'ok') { this.lib.removeLoop(l.id); this.currentId = this.lib.loops[0] ? this.lib.loops[0].id : null; this.renderAll(); this.drawAll(); } });
    this.$('lbReanalyze').addEventListener('click', () => this.reanalyzeAll());
    this.$('lbLoopOffset').addEventListener('change', (e) => { const l = this.current; if (!l) return; l.offsetSamples = parseInt(e.target.value, 10) || 0; this.lib.computeBars(l); if (l._raw) this.lib.setRawHits(l, l._raw, { stemVerified: l.stemVerified }); this.lib.recompute(); this.markDirty(); this.renderAll(); this.drawAll(); });
    this.$('lbLoopId').addEventListener('change', (e) => { const l = this.current; if (!l) return; const v = e.target.value.trim(); if (!v || v === l.id) return; if (this.lib.loops.some(x => x.id === v)) { this.toast('That id is already used.', { error: true }); e.target.value = l.id; return; } const range = LoopLibrary.parseBarRange(v); for (const ly of this.lib.layers) if (ly.loops[l.id]) { ly.loops[v] = ly.loops[l.id]; delete ly.loops[l.id]; } l.id = v; if (range) l.barRange = range; this.currentId = v; if (this.ab.A === l.id) this.ab.A = v; this.lib.recompute(); this.markDirty(); this.renderAll(); this.drawAll(); });
    this.$('lbCompareLayer').addEventListener('change', (e) => { this.compareLayerId = e.target.value || null; this.renderAll(); this.drawAll(); });
    this.$('lbZoomJoin').addEventListener('change', (e) => { this.zoomJoin = e.target.checked; this.drawWave(); });
    this.$('lbHitMenu').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; this.applyHitMenu(b.dataset.action, b.dataset.value); });
    document.addEventListener('click', (e) => { if (!e.target.closest('#lbHitMenu') && !e.target.closest('#lbWave') && !e.target.closest('#lbHitmap')) this.$('lbHitMenu').hidden = true; });
  }
  showTab(name) { for (const b of U.$$('.lab-tabs [role=tab]')) { const on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); } for (const p of U.$$('.lab-panels .panel')) p.hidden = p.id !== `lbTab-${name}`; }
  ratingFromDigits() { const w = this.$('lbRatingWhole').value, t = this.$('lbRatingTenth').value; if (w === '' || t === '') return null; return LoopLibrary.clampRating(parseInt(w, 10) + parseInt(t, 10) / 10); }
  saveRating({ advance = false } = {}) {
    const l = this.current; if (!l) return;
    const rating = this.ratingFromDigits();
    const tags = this.$('lbTags').value.split(',').map(s => s.trim()).filter(Boolean);
    const blind = !this.isRevealed(l);
    this.lib.setRating(l.id, rating, this.$('lbNotes').value, tags);
    l.blind = blind; l.myClass = this.$('lbMyClass').value || null; if (rating !== null) l.skipped = false; this.lastRatedId = l.id; this.ratingBuffer = '';
    this.lib.emit({ label: 'rate' });
    this.toast(`${l.id}: rating ${LoopLibrary.formatRating(l.rating) || 'cleared'} saved${blind ? ' (blind)' : ''}`);
    this.renderTable();
    if (advance) this.nextUnrated();
  }
  renderDetail() {
    const l = this.current; const has = !!l;
    this.$('lbDetailEmpty').hidden = has; this.$('lbDetailBody').hidden = !has;
    if (!l) return;
    const blindHide = this.blind.on && !this.blind.revealed && (l.id === this.ab.A || l.id === this.ab.B);
    this.$('lbLoopId').value = l.id; this.$('lbLoopFile').textContent = `${l.fileName} · ${l.sampleRate} Hz · ${l.channels} ch · ${l.bitDepth ? l.bitDepth + '-bit' : ''} · ${l.durationSeconds.toFixed(3)} s · ${l.bars.toFixed(3)} bars${l.barsExact ? '' : ' ⚠ not whole'}${l.stemVerified ? ' · stem-verified' : ''}${l._file || l._url ? '' : ' · ⚠ audio not linked'}${l.rmsDb !== null && l.rmsDb !== undefined ? ` · RMS ${l.rmsDb} dBFS` : ''}`;
    this.$('lbLoopOffset').value = String(l.offsetSamples || 0);
    const r = l.rating; this.$('lbRatingWhole').value = r === null ? '' : String(Math.floor(r)); this.$('lbRatingTenth').value = r === null ? '' : String(Math.round((r - Math.floor(r)) * 10)); this.$('lbRatingSlider').value = String(r ?? 0);
    this.$('lbTags').value = (l.tags || []).join(', '); this.$('lbNotes').value = l.notes || ''; this.$('lbMyClass').value = l.myClass || '';
    this.$('lbLoopMeta').textContent = (() => { const r = this.claudeRec(l); if (!r) return ''; return [r.section, r.use, r.hats ? r.hats + ' hats' : null, r.bassOutBars && r.bassOutBars.length ? 'bass out' : 'bass in', r.variant ? 'variant: ' + r.variant : null].filter(Boolean).join(' · '); })();
    this.$('lbSetA').classList.toggle('active', !blindHide && this.ab.A === l.id); this.$('lbSetB').classList.toggle('active', !blindHide && this.ab.B === l.id);
    const sel = this.$('lbCompareLayer'); sel.innerHTML = ''; sel.append(U.el('option', { value: '', text: 'no layer' })); for (const ly of this.lib.layers) sel.append(U.el('option', { value: ly.id, text: ly.name })); sel.value = this.compareLayerId || '';
    this.$('lbZoomJoin').checked = this.zoomJoin;
    this.renderMetrics(); this.renderSignature(); this.renderAB(); this.renderLayers(); this.renderJoin();
  }
  fmt(v, d = 1, sign = false) { if (v === null || v === undefined || Number.isNaN(v)) return '—'; const s = v.toFixed(d); return sign && v > 0 ? '+' + s : s; }
  renderMetrics() {
    const l = this.current; const box = this.$('lbTab-metrics'); if (!l) return;
    const m = l.machine || {}; const c = m.consistencyMs || {}, mk = m.mistakes || {}, cnt = m.counts || {}, sp = m.dynamicsSpreadDb || {};
    const rows = [
      ['machine score', !this.isRevealed(l) ? `<span class="muted">number hidden — waveform marks stay</span>` : m.score === null || m.score === undefined ? '—' : `<b>${m.score.toFixed(1)}</b> / 10 <span class="muted small">(machine — never your rating)</span>`],
      ['consistency (mean |residual|)', `kick ${this.fmt(c.kick)} · snare ${this.fmt(c.snare)} · hats ${this.fmt(c.hat)} ms`],
      ['feel (core hits vs grid)', `${this.fmt(m.feelMs, 1, true)} ms ${m.feelMs > 0 ? 'behind' : m.feelMs < 0 ? 'ahead' : ''}`],
      ['1& kick push', `${this.fmt(m.push1andMs, 1, true)} ms`], ['hat swing (& − on-beat)', `${this.fmt(m.hatSwingMs, 1, true)} ms`],
      ['hits', `kick ${cnt.kick || 0} · snare ${cnt.snare || 0} · hat ${cnt.hat || 0} · other ${cnt.other || 0} · extra ${cnt.extra || 0}`],
      ['mistakes', Object.entries(mk).filter(([, v]) => v).map(([k, v]) => `<span class="bad">${v} ${k}</span>`).join(' · ') || '<span class="good">none</span>'],
      ['missing expected', (l.missing || []).length ? l.missing.map(x => `${x.drum} b${x.bar} ${OnsetDsp.posName(x.pos)}`).join(', ') : 'none'],
      ['dynamics spread (core hits)', `kick ${this.fmt(sp.kick)} · snare ${this.fmt(sp.snare)} dB`],
      ['join', `<b>${m.join || 'unknown'}</b>${m.joinDetail && m.joinDetail.headRmsDb !== undefined ? ` <span class="muted small">head ${m.joinDetail.headRmsDb} dB · tail ${m.joinDetail.tailRmsDb} dB · step ${m.joinDetail.discontinuityDb} dB${m.joinDetail.pushedOnsetMs !== null && m.joinDetail.pushedOnsetMs !== undefined ? ` · onset ${m.joinDetail.pushedOnsetMs} ms before end` : ''}</span>` : ''}`],
      ['band floors (dB)', l._floors ? `low ${this.fmt(l._floors.low)} · mid ${this.fmt(l._floors.mid)} · high ${this.fmt(l._floors.high)}` : '—'],
    ];
    box.innerHTML = `<p id="lbMachineCaption" class="muted small">${U.escapeHtml(MACHINE_SCORE_CAPTION)}</p>` + '<table class="kv">' + rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('') + '</table>';
  }
  renderSignature() {
    const box = this.$('lbTab-signature'); const sig = this.lib.sig; const s = this.lib.session;
    if (!sig || !Object.keys(sig.signature).length) { box.innerHTML = '<p class="muted">No signature yet — load and analyse loops.</p>'; return; }
    const basis = this.lib.sigBasis === 'session' ? `session median over ${this.lib.loops.filter(l => l.hits.length).length} loops` : '<span class="bad">fewer than 3 loops loaded: per-loop median (the drummer\'s pocket cannot be separated from this loop\'s own errors yet)</span>';
    let html = `<p class="small">Signature = ${basis}. Values are ms behind (+) or ahead (−) of the click; a hit is judged against these, not the metronome.</p>`;
    const g = this.lib.grid; const cols = []; for (let p = 0; p < g.posPerBar; p++) cols.push(p);
    html += '<div class="sig-wrap"><table class="sig"><tr><th></th>' + cols.map(p => `<th>${OnsetDsp.posName(p)}</th>`).join('') + '</tr>';
    for (const d of ['kick', 'snare', 'hat']) {
      const row = sig.signature[d] || {}, cnt = (sig.counts || {})[d] || {}; const expO = (sig.expected.odd[d] || []), expE = (sig.expected.even[d] || []);
      const sp = (sig.sparse || {})[d] || {};
      html += `<tr><th>${d}</th>` + cols.map(p => { const v = row[p]; if (v === undefined) { const q = sp[p]; return q ? `<td class="muted sparse" title="${q.count} hits in ${sig.totalBars} bars — too rare to be part of the pocket; hits here count as extra">(${q.median > 0 ? '+' : ''}${q.median})</td>` : '<td class="muted">·</td>'; } const e = (expO.includes(p) ? 'A' : '') + (expE.includes(p) ? 'B' : ''); return `<td title="${cnt[p] || 0} hits in ${sig.totalBars} bars${e ? '; expected in bar ' + e : ''}" class="${e ? 'exp' : ''}">${v > 0 ? '+' : ''}${v}${e ? `<sup>${e}</sup>` : ''}</td>`; }).join('') + '</tr>';
    }
    html += '</table></div><p class="muted small">Values in (brackets) are played in fewer than a quarter of the bars: shown, not judged. Superscript A/B: expected (≥ ' + Math.round(s.thresholds.expectedShare * 100) + ' % of bars) in odd / even bars. Level medians drive the dynamics check on core hits: ' + Object.entries(s.corePositions).map(([d, ps]) => `${d} ${ps.map(OnsetDsp.posName).join(',')}`).join('; ') + '.</p>';
    box.innerHTML = html;
  }
  renderAB() {
    const box = this.$('lbTab-ab'); const A = this.ab.A && this.lib.loop(this.ab.A), B = this.ab.B && this.lib.loop(this.ab.B);
    const hide = this.blind.on && !this.blind.revealed;
    const name = (l, tag) => l ? (hide ? `?? (${tag})` : `${l.id} (${tag})`) : `— (${tag}: select a loop and press "Set ${tag}")`;
    let html = `<p><b>A:</b> ${name(A, 'A')} &nbsp; <b>B:</b> ${name(B, 'B')}${this.blind.on ? ` &nbsp; <span class="pill">blind${this.blind.revealed ? ': revealed — A is ' + (this.blind.swapped ? 'the loop you set as B' : 'the loop you set as A') : ''}</span>` : ''}</p>`;
    if (A && B && !hide) {
      const mA = A.machine || {}, mB = B.machine || {};
      const row = (label, a, b, d = 1, sign = false) => `<tr><th>${label}</th><td>${this.fmt(a, d, sign)}</td><td>${this.fmt(b, d, sign)}</td><td class="muted">${a !== null && b !== null && a !== undefined && b !== undefined ? this.fmt(b - a, d, true) : ''}</td></tr>`;
      const rv = this.isRevealed(A) && this.isRevealed(B);
      html += '<table class="kv ab"><tr><th></th><th>A</th><th>B</th><th>B − A</th></tr>' + row('my rating', A.rating, B.rating) + (rv ? row('machine score', mA.score, mB.score) : `<tr><th>machine score</th><td colspan="3" class="muted">${this.hidden()} hidden</td></tr>`) +
        row('consistency kick', (mA.consistencyMs || {}).kick, (mB.consistencyMs || {}).kick) + row('consistency snare', (mA.consistencyMs || {}).snare, (mB.consistencyMs || {}).snare) + row('consistency hats', (mA.consistencyMs || {}).hat, (mB.consistencyMs || {}).hat) +
        row('feel ms', mA.feelMs, mB.feelMs, 1, true) + row('1& push', mA.push1andMs, mB.push1andMs, 1, true) + row('hat swing', mA.hatSwingMs, mB.hatSwingMs, 1, true) +
        row('mistakes', this.mistakeCount(A), this.mistakeCount(B), 0) + row('missing', (A.missing || []).length, (B.missing || []).length, 0) + `<tr><th>join</th><td>${mA.join || '—'}</td><td>${mB.join || '—'}</td><td></td></tr></table>`;
      html += '<canvas id="lbAbMap" class="ab-map"></canvas>';
    } else if (A && B) html += '<p class="muted small">Metrics hidden while blind. Press Reveal in the transport bar.</p>';
    box.innerHTML = html;
    if (A && B && !hide) this.drawAbMap(A, B);
  }
  renderLayers() {
    const box = this.$('lbTab-layers'); const l = this.current;
    if (!this.lib.layers.length) { box.innerHTML = '<p class="muted">No imported layers. Export ▾ → Import ratings sidecar… adds one; its scores show in the table and its hits under the app\'s own row.</p>'; return; }
    let html = '';
    for (const ly of this.lib.layers) {
      if (!(l && this.isRevealed(l)) && ly.kind === 'imported') { html += `<div class="layer-card"><div class="row"><b>${U.escapeHtml(ly.name)}</b> <span class="muted small">${Object.keys(ly.loops).length} loops · values hidden (Reveal to see)</span></div></div>`; continue; }
      const rec = l && ly.loops[l.id]; const cmp = l && rec ? this.lib.compareWithLayer(l.id, ly.id) : null;
      html += `<div class="layer-card"><div class="row"><b>${U.escapeHtml(ly.name)}</b> <span class="muted small">${ly.kind}${ly.source ? ' · ' + U.escapeHtml(ly.source) : ''} · ${Object.keys(ly.loops).length} loops</span> <button class="tiny" data-cmp="${ly.id}">${this.compareLayerId === ly.id ? 'comparing' : 'compare'}</button> <button class="tiny danger" data-del="${ly.id}">remove</button></div>`;
      if (rec) {
        html += `<div class="small">This loop: score <b>${rec.score ?? '—'}</b>${rec.tight !== null && rec.tight !== undefined ? ` · tight ${rec.tight}` : ''}${rec.loop !== null && rec.loop !== undefined ? ` · loop ${rec.loop}` : ''} — ${U.escapeHtml(rec.notes || '')}</div>`;
        if (cmp) html += `<div class="small">${cmp.pairs.length} hits paired, <b class="${cmp.disagreements ? 'warn' : 'good'}">${cmp.disagreements} disagreement${cmp.disagreements === 1 ? '' : 's'}</b>${cmp.theirMissing.length ? `; they list ${cmp.theirMissing.length} missing` : ''}</div>` + (cmp.disagreements ? '<ul class="small">' + cmp.pairs.filter(p => p.disagree).map(p => `<li>${p.ours ? `${p.ours.drum} b${p.ours.bar} ${OnsetDsp.posName(p.ours.pos)}: app <b>${p.ours.class}</b>${p.ours.mistakeType ? ':' + p.ours.mistakeType : ''}` : 'app: (not detected)'} vs layer <b>${p.theirs ? (p.theirs.class || '?') + (p.theirs.drum && !p.ours ? ` (${p.theirs.drum} b${p.theirs.bar} ${OnsetDsp.posName(p.theirs.pos)})` : '') : '(absent)'}</b></li>`).join('') + '</ul>' : '');
      } else if (l) html += '<div class="muted small">No entry for this loop.</div>';
      if (ly.signature && Object.keys(ly.signature).length) html += `<div class="muted small">Layer signature: ${Object.entries(ly.signature).map(([d, m]) => `${d} ` + Object.entries(m).map(([p, v]) => `${OnsetDsp.posName(+p)} ${v > 0 ? '+' : ''}${v}`).join(', ')).join(' · ')}</div>`;
      html += '</div>';
    }
    box.innerHTML = html;
    for (const b of box.querySelectorAll('[data-cmp]')) b.addEventListener('click', () => { this.compareLayerId = this.compareLayerId === b.dataset.cmp ? null : b.dataset.cmp; this.renderAll(); this.drawAll(); });
    for (const b of box.querySelectorAll('[data-del]')) b.addEventListener('click', () => { this.lib.removeLayer(b.dataset.del); if (this.compareLayerId === b.dataset.del) this.compareLayerId = null; this.renderAll(); this.drawAll(); });
  }
  renderJoin() {
    const l = this.current; const box = this.$('lbTab-join'); if (!l) return;
    const j = l.machine && l.machine.joinDetail; const v = l.machine && l.machine.join;
    box.innerHTML = `<p>Join verdict: <b class="${v === 'clean' ? 'good' : v ? 'warn' : ''}">${v || 'unknown'}</b></p>` + (j ? `<table class="kv"><tr><th>RMS first 20 ms</th><td>${j.headRmsDb} dBFS</td></tr><tr><th>RMS last 20 ms</th><td>${j.tailRmsDb} dBFS</td></tr><tr><th>sample step at the join</th><td>${j.discontinuity} (${j.discontinuityDb} dBFS)</td></tr><tr><th>onset just before the end</th><td>${j.pushedOnsetMs === null || j.pushedOnsetMs === undefined ? 'none within 15 ms' : `${j.pushedOnsetMs} ms before the end (pushed downbeat caught by the cut)`}</td></tr></table>` : '') +
      '<p class="small muted">Press <kbd>J</kbd> to loop the join (last beat → first beat). Tick "zoom join" above the waveform to see ±60 ms around the cut. The join fade (transport bar) applies a raised-cosine fade of half the value at each end without changing the loop length; if a click disappears with a 5 ms fade, the click is the cut, not the playing.</p>';
  }
  renderAll() { if (!this.$('lbTable')) return; this.renderSortUi(); this.renderCompare(); this.$('lbName').value = this.lib.session.name; this.$('lbSourceNote').value = this.lib.session.sourceNote || ''; this.$('lbBpm').value = this.lib.session.bpm; this.$('lbNum').value = this.lib.session.meterNumerator; this.$('lbDen').value = String(this.lib.session.meterDenominator); this.renderTable(); this.renderDetail(); this.renderTransport(); }

  /* ================= drawing ================= */
  drawAll() { this.drawWave(); this.drawHitmap(); }
  peaksFor(l, width) {
    const key = `${l.id}:${width}:${l._buffer ? l._buffer.length : 0}`; const c = this._peaksCache.get(l.id); if (c && c.key === key) return c.data;
    if (!l._buffer) return null;
    const buf = l._buffer, n = buf.length, spp = n / width, data = new Float32Array(width * 2);
    const chans = []; for (let ch = 0; ch < buf.numberOfChannels; ch++) chans.push(buf.getChannelData(ch));
    for (let x = 0; x < width; x++) { const a = Math.floor(x * spp), b = Math.min(n, Math.floor((x + 1) * spp) + 1); let mn = 1, mx = -1; for (const d of chans) for (let i = a; i < b; i++) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; } data[2 * x] = mn; data[2 * x + 1] = mx; }
    this._peaksCache.set(l.id, { key, data }); return data;
  }
  _setupCanvas(c) { const dpr = window.devicePixelRatio || 1; const r = c.getBoundingClientRect(); const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height)); if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); } const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); return { ctx, w, h }; }
  /** Geometry for the wave canvas: marker rows (app + optional layer), waveform area, x mapping. */
  waveGeom(w, h) {
    const layer = this.compareLayer(); const rowH = 14, rows = DRUM_ROWS.length, top = 4;
    const appRows = [top, top + rows * rowH]; const layerRows = layer ? [appRows[1] + 4, appRows[1] + 4 + rows * rowH] : null;
    const waveTop = (layerRows ? layerRows[1] : appRows[1]) + 6, waveBottom = h - 16;
    return { rowH, appRows, layerRows, waveTop, waveBottom, timeRow: [h - 16, h] };
  }
  xOfSec(sec, l, w) {
    if (this.zoomJoin) { const win = 0.06, L = l.durationSeconds; let t = sec; if (t > L / 2) t -= L; return (t + win) / (2 * win) * w; }
    return sec / l.durationSeconds * w;
  }
  drawMarker(ctx, x, y, cls, size = 4, disagree = false) {
    ctx.lineWidth = 1.5; const col = CLASS_COLORS[cls] || '#888';
    ctx.strokeStyle = col; ctx.fillStyle = col;
    if (cls === 'mistake') { ctx.beginPath(); ctx.moveTo(x - size, y - size); ctx.lineTo(x + size, y + size); ctx.moveTo(x + size, y - size); ctx.lineTo(x - size, y + size); ctx.stroke(); }
    else if (cls === 'missing') { ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.stroke(); }
    else if (cls === 'feel') { ctx.beginPath(); ctx.moveTo(x, y - size); ctx.lineTo(x + size, y); ctx.lineTo(x, y + size); ctx.lineTo(x - size, y); ctx.closePath(); ctx.fill(); }
    else if (cls === 'extra') { ctx.fillRect(x - size + 1, y - size + 1, 2 * size - 2, 2 * size - 2); }
    else if (cls === 'ignore') { ctx.strokeStyle = col; ctx.beginPath(); ctx.moveTo(x - size, y); ctx.lineTo(x + size, y); ctx.stroke(); }
    else { ctx.beginPath(); ctx.arc(x, y, size, 0, Math.PI * 2); ctx.fill(); }
    if (disagree) { ctx.strokeStyle = '#ffd24d'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(x, y, size + 3, 0, Math.PI * 2); ctx.stroke(); }
  }
  drawWave() {
    const c = this.wave; if (!c) return; const { ctx, w, h } = this._setupCanvas(c); const l = this.current;
    ctx.fillStyle = '#0f1115'; ctx.fillRect(0, 0, w, h);
    this.hitRegions = [];
    if (!l) { ctx.fillStyle = '#5c6470'; ctx.font = '13px system-ui'; ctx.fillText('Select a loop', 10, 20); return; }
    const G = this.waveGeom(w, h); const g = this.lib.grid; const L = l.durationSeconds;
    // grid lines
    const bars = Math.max(1, Math.round(l.bars)); const totalPos = bars * g.posPerBar; const offSec = (l.offsetSamples || 0) / l.sampleRate;
    const pxPerSixteenth = this.zoomJoin ? Infinity : w / totalPos;
    for (let p = 0; p <= totalPos; p++) {
      const sec = offSec + p * g.sixteenth; if (sec > L + 1e-9) break;
      const isBar = p % g.posPerBar === 0, isBeat = p % 4 === 0;
      if (!isBeat && pxPerSixteenth < 6) continue;
      let x = this.xOfSec(sec, l, w); if (this.zoomJoin && (x < 0 || x > w)) { const x2 = this.xOfSec(sec - L, l, w); if (x2 < 0 || x2 > w) continue; x = x2; }
      ctx.strokeStyle = isBar ? 'rgba(255,210,122,0.5)' : isBeat ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, G.appRows[0]); ctx.lineTo(Math.round(x) + 0.5, G.waveBottom); ctx.stroke();
      if (isBeat) { ctx.fillStyle = isBar ? '#ffd27a' : '#8b95a5'; ctx.font = '10px ui-monospace, monospace'; ctx.fillText(isBar ? `bar ${Math.floor(p / g.posPerBar) + 1}` : `${(p % g.posPerBar) / 4 + 1}`, x + 3, h - 5); }
    }
    // waveform
    const mid = (G.waveTop + G.waveBottom) / 2, amp = (G.waveBottom - G.waveTop) / 2 * 0.95;
    if (l._buffer) {
      ctx.fillStyle = '#6b7280';
      if (this.zoomJoin) {
        const buf = l._buffer, sr = buf.sampleRate, n = Math.round(0.06 * sr); const d = buf.getChannelData(0);
        ctx.strokeStyle = '#9aa4b5'; ctx.lineWidth = 1; ctx.beginPath();
        for (let x = 0; x < w; x++) { let i = Math.round((x / w) * 2 * n) - n; if (i < 0) i += buf.length; if (i >= buf.length) i -= buf.length; const v = d[i]; if (x === 0) ctx.moveTo(x, mid - v * amp); else ctx.lineTo(x, mid - v * amp); }
        ctx.stroke();
        ctx.fillStyle = 'rgba(255,77,109,0.35)'; ctx.fillRect(Math.round(w / 2), G.waveTop, 1, G.waveBottom - G.waveTop);
        ctx.fillStyle = '#ff4d6d'; ctx.font = '10px ui-monospace, monospace'; ctx.fillText('join (end | start)', w / 2 + 4, G.waveTop + 10);
        ctx.fillStyle = '#8b95a5'; ctx.fillText('−60 ms', 4, G.waveTop + 10); ctx.fillText('+60 ms', w - 44, G.waveTop + 10);
      } else {
        const pk = this.peaksFor(l, w);
        if (pk) for (let x = 0; x < w; x++) { const y0 = mid - pk[2 * x + 1] * amp, y1 = mid - pk[2 * x] * amp; ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0)); }
      }
    } else { ctx.fillStyle = '#5c6470'; ctx.font = '12px system-ui'; ctx.fillText(l._file ? 'decoding…' : 'audio not linked — open the WAV again to draw and play', 10, mid); }
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(0, Math.round(mid), w, 1);
    // marker rows
    const drawRows = (hits, missing, rowsY, labelPrefix, small, cmp) => {
      ctx.font = '10px system-ui'; ctx.textBaseline = 'middle';
      DRUM_ROWS.forEach((d, i) => { const y = rowsY[0] + i * G.rowH + G.rowH / 2; ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.fillRect(0, y - G.rowH / 2 + 1, w, G.rowH - 2); ctx.fillStyle = '#8b95a5'; ctx.fillText(labelPrefix + d, 3, y); });
      for (const m of (missing || [])) { const sec = offSec + ((m.bar - 1) * g.posPerBar + m.pos) * g.sixteenth + ((this.lib.sig && this.lib.sig.signature[m.drum] && this.lib.sig.signature[m.drum][m.pos]) || 0) / 1000; const x = this.xOfSec(sec, l, w); const y = rowsY[0] + DRUM_ROWS.indexOf(m.drum) * G.rowH + G.rowH / 2; if (x >= 0 && x <= w) { this.drawMarker(ctx, x, y, 'missing', small ? 3 : 4.5); if (!small) this.hitRegions.push({ x, y, r: 6, missing: m }); } }
      for (const hh of hits) {
        const x = this.xOfSec(hh.tSeconds ?? (hh.samples / l.sampleRate), l, w); if (x < -6 || x > w + 6) continue;
        const y = rowsY[0] + Math.max(0, DRUM_ROWS.indexOf(hh.drum)) * G.rowH + G.rowH / 2;
        const dis = cmp && cmp.some(p => p.disagree && (p.ours === hh || p.theirs === hh));
        this.drawMarker(ctx, x, y, hh.class || 'extra', small ? 3 : 4.5, dis);
        if (hh.override) { ctx.fillStyle = '#fff'; ctx.fillRect(x - 1, y - G.rowH / 2 + 1, 2, 2); }
        if (!small) this.hitRegions.push({ x, y, r: 7, hit: hh });
      }
    };
    const layer = this.compareLayer(); const cmp = layer && layer.loops[l.id] ? this.lib.compareWithLayer(l.id, layer.id) : null;
    drawRows(l.hits || [], l.missing, G.appRows, '', false, cmp && cmp.pairs);
    if (layer && G.layerRows) { const rec = layer.loops[l.id]; drawRows(rec ? rec.hits || [] : [], rec ? rec.missing : [], G.layerRows, '↳ ', true, cmp && cmp.pairs); if (!rec) { ctx.fillStyle = '#5c6470'; ctx.fillText(`${layer.name}: no entry for this loop`, 60, G.layerRows[0] + 8); } }
    // legend
    ctx.font = '10px system-ui'; ctx.textBaseline = 'middle'; let lx = w - 250; for (const [k, label] of [['tight', 'tight'], ['feel', 'feel'], ['extra', 'extra'], ['mistake', 'mistake'], ['missing', 'missing']]) { this.drawMarker(ctx, lx, G.appRows[0] - 0 + 2, k, 3.5); ctx.fillStyle = '#8b95a5'; ctx.fillText(label, lx + 7, G.appRows[0] + 2); lx += 30 + label.length * 5; }
    this.renderPlayhead(true);
  }
  renderPlayhead(force = false) {
    const l = this.current; if (!l || !this.wave) return;
    const p = this.player.playing && this.player.mode !== 'join' ? this.player.position() : this.player.pausedAt;
    if (!force && p === this._lastPlayhead) return; this._lastPlayhead = p;
    if (!force) this.drawWave(); // redraw everything (cheap: peaks cached)
    const c = this.wave, ctx = c.getContext('2d'), w = c.getBoundingClientRect().width, h = c.getBoundingClientRect().height; const G = this.waveGeom(w, h);
    if (this.player.playing && p >= 0) { const x = this.xOfSec(p, l, w); ctx.fillStyle = '#fff'; ctx.fillRect(Math.round(x), G.appRows[0], 1, G.waveBottom - G.appRows[0]); }
    this.renderBeat();
  }
  drawHitmap() {
    const c = this.hitmap; if (!c) return; const { ctx, w, h } = this._setupCanvas(c); const l = this.current; ctx.fillStyle = '#0b0d11'; ctx.fillRect(0, 0, w, h);
    this.mapCells = [];
    if (!l) return;
    const g = this.lib.grid, bars = Math.max(1, Math.round(l.bars)), cols = bars * g.posPerBar, labelW = 40, cw = (w - labelW) / cols, rows = ['hat', 'snare', 'kick', 'other'], rh = (h - 12) / rows.length;
    ctx.font = '10px system-ui'; ctx.textBaseline = 'middle';
    rows.forEach((d, r) => { ctx.fillStyle = '#8b95a5'; ctx.fillText(d, 3, r * rh + rh / 2); });
    for (let p = 0; p < cols; p++) { const x = labelW + p * cw; ctx.fillStyle = p % g.posPerBar === 0 ? 'rgba(255,210,122,0.35)' : p % 4 === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.05)'; ctx.fillRect(Math.round(x), 0, 1, h - 12); if (p % 4 === 0) { ctx.fillStyle = '#8b95a5'; ctx.fillText(p % g.posPerBar === 0 ? `${Math.floor(p / g.posPerBar) + 1}` : `·${(p % g.posPerBar) / 4 + 1}`, x + 2, h - 6); } }
    const cell = (d, bar, pos) => ({ x: labelW + ((bar - 1) * g.posPerBar + pos) * cw, y: rows.indexOf(d) * rh });
    for (const m of l.missing || []) { const { x, y } = cell(m.drum, m.bar, m.pos); ctx.strokeStyle = CLASS_COLORS.missing; ctx.lineWidth = 1.5; ctx.strokeRect(x + 2.5, y + 2.5, cw - 5, rh - 5); this.mapCells.push({ x, y, w: cw, h: rh, missing: m }); }
    for (const hh of l.hits || []) { const { x, y } = cell(hh.drum, hh.bar, hh.pos); const col = CLASS_COLORS[hh.class] || '#888'; ctx.fillStyle = U.rgba(col, hh.class === 'extra' ? 0.5 : 0.85); ctx.fillRect(x + 2, y + 2, Math.max(2, cw - 4), rh - 4); if (hh.class === 'mistake') { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 4, y + 4); ctx.lineTo(x + cw - 4, y + rh - 4); ctx.moveTo(x + cw - 4, y + 4); ctx.lineTo(x + 4, y + rh - 4); ctx.stroke(); } const dev = hh.devMs; if (cw > 22) { ctx.fillStyle = U.textOn(col); ctx.font = '9px ui-monospace, monospace'; ctx.fillText((dev > 0 ? '+' : '') + Math.round(dev), x + 3, y + rh / 2); ctx.font = '10px system-ui'; } this.mapCells.push({ x, y, w: cw, h: rh, hit: hh }); }
    // playhead column marker
    if (this.player.playing && this.player.mode !== 'join') { const pos = this.player.position(); const x = labelW + (pos / g.sixteenth) * cw; ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fillRect(Math.round(x), 0, 1, h - 12); }
  }
  drawAbMap(A, B) {
    const c = document.getElementById('lbAbMap'); if (!c) return; const { ctx, w, h } = this._setupCanvas(c); ctx.fillStyle = '#0b0d11'; ctx.fillRect(0, 0, w, h);
    const g = this.lib.grid, bars = Math.max(Math.round(A.bars), Math.round(B.bars)), cols = bars * g.posPerBar, labelW = 60, cw = (w - labelW) / cols, half = (h - 12) / 2, rows = ['hat', 'snare', 'kick'], rh = half / rows.length;
    ctx.font = '10px system-ui'; ctx.textBaseline = 'middle';
    for (let p = 0; p < cols; p++) { const x = labelW + p * cw; ctx.fillStyle = p % g.posPerBar === 0 ? 'rgba(255,210,122,0.35)' : p % 4 === 0 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.05)'; ctx.fillRect(Math.round(x), 0, 1, h - 12); if (p % 4 === 0) { ctx.fillStyle = '#8b95a5'; ctx.fillText(p % g.posPerBar === 0 ? `bar ${Math.floor(p / g.posPerBar) + 1}` : `${(p % g.posPerBar) / 4 + 1}`, x + 2, h - 6); } }
    [[A, 0, 'A'], [B, half, 'B']].forEach(([l, top, tag]) => {
      rows.forEach((d, r) => { ctx.fillStyle = '#8b95a5'; ctx.fillText(`${tag} ${d}`, 3, top + r * rh + rh / 2); });
      for (const hh of l.hits || []) { if (!rows.includes(hh.drum)) continue; const x = labelW + ((hh.bar - 1) * g.posPerBar + hh.pos) * cw + cw / 2 + (hh.devMs / (g.sixteenth * 1000)) * cw; const y = top + rows.indexOf(hh.drum) * rh + rh / 2; this.drawMarker(ctx, x, y, hh.class, 3.5); }
      for (const m of l.missing || []) { if (!rows.includes(m.drum)) continue; const x = labelW + ((m.bar - 1) * g.posPerBar + m.pos) * cw + cw / 2; this.drawMarker(ctx, x, top + rows.indexOf(m.drum) * rh + rh / 2, 'missing', 3.5); }
    });
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.fillRect(0, Math.round(half), w, 1);
  }

  /* ---------- hover / click on hits ---------- */
  hitDescription(hh) {
    const s = this.lib.sig && this.lib.sig.signature[hh.drum] ? this.lib.sig.signature[hh.drum][hh.pos] : undefined;
    return `${hh.drum}${hh.detectedDrum && hh.detectedDrum !== hh.drum ? ` (detected ${hh.detectedDrum})` : ''} · bar ${hh.bar} pos ${OnsetDsp.posName(hh.pos)} (${hh.pos})\n${U.fmtTime(hh.tSeconds ?? hh.samples / this.current.sampleRate)} · sample ${hh.samples}\ndeviation ${hh.devMs > 0 ? '+' : ''}${hh.devMs} ms from grid${s !== undefined ? ` · signature ${s > 0 ? '+' : ''}${s} ms · residual ${hh.residualMs > 0 ? '+' : ''}${hh.residualMs} ms` : ' · not in signature'}\nlevel ${hh.levelDb} dB · class ${hh.class}${hh.mistakeType ? ' (' + hh.mistakeType + ')' : ''}${hh.override ? ` · override: ${hh.override.class}${hh.override.reason ? ' — ' + hh.override.reason : ''}` : ''}${hh.far ? ' · far from any 16th' : ''}`;
  }
  _tip(text, ev) { const t = this.$('lbTooltip'); t.textContent = text; t.hidden = false; const r = this.$('lbDetail').getBoundingClientRect(); let x = ev.clientX - r.left + 12, y = ev.clientY - r.top + 12; if (x + 300 > r.width) x = Math.max(0, ev.clientX - r.left - 310); t.style.left = x + 'px'; t.style.top = y + 'px'; }
  onWaveHover(ev) { const r = this.wave.getBoundingClientRect(); const x = ev.clientX - r.left, y = ev.clientY - r.top; const hit = (this.hitRegions || []).find(h => Math.abs(h.x - x) <= h.r && Math.abs(h.y - y) <= h.r); if (hit && hit.hit) { this.hoverHit = hit.hit; this._tip(this.hitDescription(hit.hit), ev); this.wave.style.cursor = 'pointer'; } else if (hit && hit.missing) { this._tip(`missing expected ${hit.missing.drum} at bar ${hit.missing.bar} pos ${OnsetDsp.posName(hit.missing.pos)}`, ev); this.wave.style.cursor = 'default'; } else { this.hoverHit = null; this.$('lbTooltip').hidden = true; this.wave.style.cursor = 'default'; } }
  onWaveClick(ev) { const r = this.wave.getBoundingClientRect(); const x = ev.clientX - r.left, y = ev.clientY - r.top; const hit = (this.hitRegions || []).find(h => h.hit && Math.abs(h.x - x) <= h.r && Math.abs(h.y - y) <= h.r); if (hit) this.openHitMenu(hit.hit, ev); else if (this.current && !this.zoomJoin) { const sec = x / r.width * this.current.durationSeconds; this.seek(sec); } }
  onHitmapHover(ev) { const r = this.hitmap.getBoundingClientRect(); const x = ev.clientX - r.left, y = ev.clientY - r.top; const cell = (this.mapCells || []).find(c => x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h); if (cell && cell.hit) this._tip(this.hitDescription(cell.hit), ev); else if (cell && cell.missing) this._tip(`missing expected ${cell.missing.drum} at bar ${cell.missing.bar} pos ${OnsetDsp.posName(cell.missing.pos)}`, ev); else this.$('lbTooltip').hidden = true; }
  onHitmapClick(ev) { const r = this.hitmap.getBoundingClientRect(); const x = ev.clientX - r.left, y = ev.clientY - r.top; const cell = (this.mapCells || []).find(c => c.hit && x >= c.x && x < c.x + c.w && y >= c.y && y < c.y + c.h); if (cell) this.openHitMenu(cell.hit, ev); }
  openHitMenu(hit, ev) {
    this.menuHit = hit; const m = this.$('lbHitMenu'); m.hidden = false;
    this.$('lbHitMenuTitle').textContent = `${hit.drum} bar ${hit.bar} ${OnsetDsp.posName(hit.pos)} · ${hit.devMs > 0 ? '+' : ''}${hit.devMs} ms · ${hit.class}${hit.mistakeType ? ':' + hit.mistakeType : ''}`;
    this.$('lbHitReason').value = hit.override ? hit.override.reason || '' : '';
    for (const b of m.querySelectorAll('[data-action=class]')) b.classList.toggle('active', hit.override ? hit.override.class === b.dataset.value : false);
    for (const b of m.querySelectorAll('[data-action=drum]')) b.classList.toggle('active', hit.drum === b.dataset.value);
    const r = this.$('lbDetail').getBoundingClientRect(); m.style.left = Math.min(r.width - 320, ev.clientX - r.left) + 'px'; m.style.top = (ev.clientY - r.top + 8) + 'px';
  }
  applyHitMenu(action, value) {
    const hit = this.menuHit; const l = this.current; if (!hit || !l) return;
    if (action === 'class') this.lib.setHitOverride(l.id, hit.id, value, this.$('lbHitReason').value.trim());
    else if (action === 'clear') this.lib.setHitOverride(l.id, hit.id, null);
    else if (action === 'drum') this.lib.setHitDrum(l.id, hit.id, value);
    else if (action === 'close') { this.$('lbHitMenu').hidden = true; return; }
    const fresh = l.hits.find(h => h.id === hit.id); if (fresh) this.menuHit = fresh;
    this.drawAll(); this.renderDetail();
    if (action !== 'drum' && action !== 'class') this.$('lbHitMenu').hidden = true; else if (fresh) this.$('lbHitMenuTitle').textContent = `${fresh.drum} bar ${fresh.bar} ${OnsetDsp.posName(fresh.pos)} · ${fresh.class}${fresh.override ? ' (override)' : ''}`;
  }

  /* ================= player ================= */
  bindTransport() {
    this.$('lbPlay').addEventListener('click', () => this.togglePlay());
    this.$('lbStop').addEventListener('click', () => { this.player.stop(); this.player.pausedAt = 0; this.renderTransport(); this.drawAll(); });
    this.$('lbRate').addEventListener('change', (e) => { this.player.setRate(parseFloat(e.target.value)); this.renderTransport(); });
    this.$('lbDeckA').addEventListener('click', () => this.audition('A'));
    this.$('lbDeckB').addEventListener('click', () => this.audition('B'));
    this.$('lbSwap').addEventListener('click', () => this.swapDecks());
    this.$('lbBlind').addEventListener('change', (e) => this.setBlind(e.target.checked));
    this.$('lbReveal').addEventListener('click', () => { this.blind.revealed = true; this.renderAll(); this.toast(`Revealed: A = ${this.deckLoop('A') ? this.deckLoop('A').id : '—'}, B = ${this.deckLoop('B') ? this.deckLoop('B').id : '—'}`, { ms: 6000 }); });
    this.$('lbLevelMatch').addEventListener('change', (e) => this.player.setLevelMatch(e.target.checked));
    this.$('lbJoin').addEventListener('click', () => this.playJoin());
    this.$('lbFade').addEventListener('input', (e) => { this.player.joinFadeMs = parseFloat(e.target.value); this.$('lbFadeVal').textContent = `${this.player.joinFadeMs} ms`; if (this.player.playing) this.restart(); });
    this.$('lbMetroOn').addEventListener('change', (e) => this.player.setMetro({ on: e.target.checked }));
    this.$('lbMetroLevel').addEventListener('input', (e) => { this.player.setMetro({ levelDb: parseFloat(e.target.value) }); this.$('lbMetroLevelVal').textContent = `${e.target.value} dB`; });
    this.$('lbMetroSound').addEventListener('change', (e) => this.player.setMetro({ sound: e.target.value }));
    this.$('lbMetroPan').addEventListener('change', (e) => this.player.setMetro({ pan: parseFloat(e.target.value) }));
    this.$('lbMetroSub').addEventListener('change', (e) => this.player.setMetro({ subdiv: parseInt(e.target.value, 10) }));
    this.$('lbMetroAccent').addEventListener('change', (e) => this.player.setMetro({ accent: e.target.checked }));
    this.$('lbMetroCountIn').addEventListener('change', (e) => this.player.setMetro({ countIn: e.target.checked }));
  }
  deckLoop(deck) { const id = this.blind.on && this.blind.swapped ? this.ab[deck === 'A' ? 'B' : 'A'] : this.ab[deck]; return id ? this.lib.loop(id) : null; }
  assignDeck(deck, id) { if (!id) return; this.ab[deck] = id; if (this.blind.on) { this.blind.swapped = Math.random() < 0.5; this.blind.revealed = false; } this.renderAll(); this.toast(`${deck} = ${this.blind.on ? '(hidden)' : id}`); }
  setBlind(on) { this.blind = { on, swapped: on ? Math.random() < 0.5 : false, revealed: false }; this.renderAll(); this.drawAll(); }
  async togglePlay() { if (this.player.playing) { this.player.pause(); this.renderTransport(); this.drawAll(); } else await this.play(); }
  async play() {
    const l = this.current; if (!l) { this.toast('Select a loop first.', { error: true }); return; }
    try {
      const A = this.deckLoop('A'), B = this.deckLoop('B');
      if (A && B && A._file && B._file) { await this.ensureBuffer(A); await this.ensureBuffer(B); this.player.start({ A: { entry: A, buffer: A._buffer }, B: { entry: B, buffer: B._buffer }, active: this.player.active || 'A', offset: this.player.pausedAt, countIn: this.player.metro.countIn }); }
      else { await this.ensureBuffer(l); this.player.start({ A: { entry: l, buffer: l._buffer }, offset: this.player.pausedAt, countIn: this.player.metro.countIn }); }
      l.listens = (l.listens || 0) + 1; if (this._listenTimer) clearTimeout(this._listenTimer); this._listenTimer = setTimeout(() => { this.markDirty(); this.renderTable(); }, 1500);
    } catch (e) { this.toast('Cannot play: ' + e.message, { error: true }); }
    this.renderTransport();
  }
  restart() { const pos = this.player.playing ? this.player.position() : 0; this.player.stop(); this.player.pausedAt = Math.max(0, pos); this.play(); }
  seek(sec) { const was = this.player.playing; this.player.stop(); this.player.pausedAt = sec; if (was) this.play(); else { this.drawAll(); this.renderTransport(); } }
  async audition(deck) {
    if (!this.ab.A || !this.ab.B) { this.toast('Assign A and B first (select a loop, press "Set A" / "Set B").', { error: true }); return; }
    if (this.player.mode !== 'ab') { this.player.pausedAt = 0; this.player.active = deck; const A = this.deckLoop('A'), B = this.deckLoop('B'); if (!A || !B) return; this.currentId = this.blind.on && !this.blind.revealed ? this.currentId : (deck === 'A' ? A : B).id; await this.play(); this.player.switchTo(deck); }
    else this.player.switchTo(deck, { atNextBar: this.$('lbAtBar').checked });
    if (!(this.blind.on && !this.blind.revealed)) { const l = this.deckLoop(deck); if (l) { this.currentId = l.id; this.renderTable(); this.renderDetail(); this.drawAll(); } }
    this.renderTransport();
  }
  swapDecks() { if (this.player.mode === 'ab') this.audition(this.player.active === 'A' ? 'B' : 'A'); else this.toast('Start A/B playback first (A or B).'); }
  async playJoin() { const l = this.current; if (!l) return; try { await this.ensureBuffer(l); this.player.playJoin(l, l._buffer); this.zoomJoin = true; this.$('lbZoomJoin').checked = true; this.drawWave(); this.showTab('join'); } catch (e) { this.toast(e.message, { error: true }); } this.renderTransport(); }
  cycleRate() { const i = this.rateSteps.indexOf(this.player.rate); const r = this.rateSteps[(i + 1) % this.rateSteps.length]; this.$('lbRate').value = String(r); this.player.setRate(r); this.renderTransport(); this.toast(`Rate ${r}× (pitch follows rate)`); }
  renderTransport() {
    const p = this.player; const playing = p.playing;
    this.$('lbPlay').textContent = playing ? '❚❚' : '▶'; this.$('lbPlay').setAttribute('aria-pressed', String(playing));
    this.$('lbMode').textContent = p.mode === 'ab' ? `A/B · playing ${p.active}` : p.mode === 'join' ? 'join' : p.mode === 'single' ? 'single' : 'stopped';
    const hide = this.blind.on && !this.blind.revealed;
    this.$('lbDeckA').classList.toggle('active', p.mode === 'ab' && p.active === 'A'); this.$('lbDeckB').classList.toggle('active', p.mode === 'ab' && p.active === 'B');
    this.$('lbDeckA').title = this.ab.A ? (hide ? 'A (hidden)' : `A = ${this.deckLoop('A') ? this.deckLoop('A').id : ''}`) : 'A (unassigned)'; this.$('lbDeckB').title = this.ab.B ? (hide ? 'B (hidden)' : `B = ${this.deckLoop('B') ? this.deckLoop('B').id : ''}`) : 'B (unassigned)';
    this.$('lbReveal').hidden = !this.blind.on || this.blind.revealed; this.$('lbBlind').checked = this.blind.on;
    this.$('lbLevelMatch').checked = p.levelMatch; this.$('lbRate').value = String(p.rate);
    this.$('lbMetroOn').checked = p.metro.on; this.$('lbMetroLevel').value = String(p.metro.levelDb); this.$('lbMetroLevelVal').textContent = `${p.metro.levelDb} dB`;
    this.$('lbFade').value = String(p.joinFadeMs); this.$('lbFadeVal').textContent = `${p.joinFadeMs} ms`;
    this.renderBeat();
  }
  renderBeat() {
    const p = this.player; const g = this.lib.grid; const dots = this.$('lbBeat').children; const l = this.current;
    if (!p.playing || p.mode === 'join') { for (const d of dots) d.classList.remove('on', 'accent'); this.$('lbPos').textContent = l ? `${U.fmtTime(p.pausedAt)}` : '—'; this.$('lbBar').textContent = ''; return; }
    const pos = p.position();
    if (pos < 0) { this.$('lbPos').textContent = 'count-in'; this.$('lbBar').textContent = `${Math.ceil(-pos / g.beatSec)}`; return; }
    const beatIdx = Math.floor(pos / g.beatSec), bpb = p.grid.beatsPerBar, bar = Math.floor(beatIdx / bpb) + 1, beat = beatIdx % bpb + 1;
    const tick = Math.round(((pos / g.beatSec) - beatIdx) * 960);
    this.$('lbPos').textContent = `${bar}|${beat}|${String(tick).padStart(3, '0')} · ${U.fmtTime(pos)}`;
    this.$('lbBar').textContent = `loop ${p.loopIteration() + 1}`;
    for (let i = 0; i < dots.length; i++) { const on = i === beatIdx % bpb; dots[i].classList.toggle('on', on); dots[i].classList.toggle('accent', on && beat === 1); }
    if (this.hitmap) this.drawHitmap();
  }

  /* ================= keyboard ================= */
  handleKey(e) {
    if (this.view === 'sequence' && this.handleSeqKey(e)) return true;
    const typing = U.isTypingTarget(e.target); const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.altKey) { const k = e.key.toLowerCase(); if (k === 's') { e.preventDefault(); this.save({ forcePicker: e.shiftKey }); return true; } if (k === 'o') { e.preventDefault(); if (e.shiftKey) this.pickJson(); else this.pickFiles(); return true; } return false; }
    if (mod && !e.altKey && e.key.toLowerCase() === 'e') { e.preventDefault(); this.exportRatings(); return true; }
    if (typing) return false;
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    const key = e.key;
    if (key === ' ') { stop(); this.togglePlay(); return true; }
    if (key === 'Enter') { stop(); this.saveRating({ advance: true }); return true; }
    if (key === 'Escape') { stop(); this.$('lbHitMenu').hidden = true; this.ratingBuffer = ''; return true; }
    if (key >= '0' && key <= '9') { stop(); this.typeRatingDigit(key); return true; }
    if (this.handleRatingKey(e)) return true;
    if (key === '[' || key === ']') { stop(); const list = this.visibleLoops(); const i = list.findIndex(l => l.id === this.currentId); const n = list[(i + (key === ']' ? 1 : -1) + list.length) % list.length]; if (n) this.select(n.id, { play: this.player.playing }); return true; }
    if (key === '?') { stop(); this.$('dlgLabHelp').showModal(); return true; }
    if (key === ',' || key === '.') { stop(); const v = Math.max(-40, Math.min(0, this.player.metro.levelDb + (key === '.' ? 3 : -3))); this.player.setMetro({ levelDb: v }); this.renderTransport(); return true; }
    const k = key.toLowerCase();
    if (k === 'a' || k === 'b') { stop(); this.audition(k.toUpperCase()); return true; }
    if (k === 'x') { stop(); this.swapDecks(); return true; }
    if (k === 'j') { stop(); this.playJoin(); return true; }
    if (k === 'm') { stop(); this.player.setMetro({ on: !this.player.metro.on }); this.renderTransport(); this.toast(`Metronome ${this.player.metro.on ? 'on' : 'off'}`); return true; }
    if (k === 'r' && e.shiftKey) { stop(); this.cycleRate(); return true; }
    if (k === 'l') { stop(); this.player.setLevelMatch(!this.player.levelMatch); this.renderTransport(); this.toast(`Level match ${this.player.levelMatch ? 'on' : 'off'}`); return true; }
    return false;
  }

  /* ================= persistence ================= */
  async save({ forcePicker = false } = {}) {
    if (!this.lib.loops.length) { this.toast('Nothing to save yet.', { error: true }); return; }
    const text = this.persist.serialize(this.lib.buildDocument());
    try { const r = await this.persist.saveText(text, (this.lib.session.name || 'session').replace(/[\/\\:]/g, '_') + '.loops.json', { forcePicker }); if (!r) return; this.clearDirty(); this.persist.autosave('loops', text, false); this.$('lbSaveTarget').textContent = r.method === 'fs' ? `→ ${r.name}` : '(downloaded)'; this.toast(r.method === 'fs' ? `Saved ${r.name}` : `Downloaded ${r.name}`); }
    catch (e) { this.toast('Save failed: ' + e.message, { error: true }); }
  }
  autosaveNow() { if (!this.lib.loops.length) return; this.persist.autosave('loops', this.persist.serialize(this.lib.buildDocument()), this.dirty); }
  offerAutosaveRestore() {
    if (this._offered || this.lib.loops.length) return; this._offered = true;
    const a = this.persist.readAutosave('loops'); if (!a || !a.dirty) return;
    this.app.banner(`Loop Lab: unsaved session autosaved at ${U.escapeHtml((a.savedAt || '').replace('T', ' ').slice(0, 19))}. Restore it? (Audio files must be opened again to play.)`, { actions: [{ label: 'Restore', primary: true, onClick: () => this.loadJsonText(a.text, 'autosave').then(() => this.markDirty()) }, { label: 'Discard', onClick: () => this.persist.clearAutosave('loops') }] });
  }
  async loadJsonText(text, sourceName) {
    const { doc, errors, warnings } = this.lib.parseDocument(text);
    if (!doc) { await this.app.errorList(`Cannot load ${sourceName}`, 'The file is not a valid loops document:', errors); return false; }
    if (this.lib.loops.length && this.dirty) { const r = await this.app.confirm({ title: 'Replace the current session?', body: 'Unsaved changes to the current loop session will be lost.', buttons: [{ label: 'Replace', value: 'ok', danger: true }, { label: 'Cancel', value: null }] }); if (r !== 'ok') return false; }
    this.lib.applyDocument(doc); if (this.library && this.library.current) await this.library.relink(); this.currentId = this.lib.loops[0] ? this.lib.loops[0].id : null; this.ab = { A: null, B: null }; this.compareLayerId = null;
    this.seq.clearHistory(); this.seqAB = { A: null, B: null }; this.currentArrId = this.lib.arrangements[0] ? this.lib.arrangements[0].id : null; this.seqView.setArrangement(this.currentArrId); if (this.view === 'sequence') this.renderSeqAll();
    this.player.setGrid(this.lib.session.bpm, this.lib.session.meterNumerator, this.lib.session.meterDenominator);
    this.clearDirty(); this.renderAll(); this.drawAll();
    const unlinked = this.lib.loops.filter(l => !l._file).length;
    if (warnings.length) this.app.banner(warnings.map(U.escapeHtml).join('<br>'));
    this.toast(`Loaded ${this.lib.loops.length} loop(s) from ${sourceName}${unlinked ? ` — ${unlinked} without audio: open the WAV files to play/redraw` : ''}`, { ms: 6000 });
    return true;
  }
  async importSidecarText(text, name) {
    let json; try { json = JSON.parse(text); } catch (e) { await this.app.errorList('Sidecar refused', `${name} is not valid JSON:`, [e.message]); return false; }
    const r = this.lib.importSidecar(json);
    if (r.errors.length) { await this.app.errorList('Sidecar refused', `${name} does not match $defs/claudeSidecar:`, r.errors); return false; }
    this.compareLayerId = r.layer.id; this.renderAll(); this.drawAll(); this.showTab('layers');
    this.toast(`Imported layer "${r.layer.name}": ${r.matched.length} loop(s) matched${r.unmatched.length ? `, unmatched: ${r.unmatched.join(', ')}` : ''}`, { ms: 7000 });
    return true;
  }
  async exportText(text, suffix, mime, ext, desc) { const r = await this.persist.exportText(text, (this.lib.session.name || 'session').replace(/[\/\\:]/g, '_') + suffix, mime, ext, desc); if (r) this.toast(`Exported ${r.name}`); }

  /* ================= settings ================= */
  bindSettings() {
    this.$('lsCancel').addEventListener('click', () => this.$('dlgLabSettings').close());
    this.$('lsSave').addEventListener('click', () => this.saveSettings());
  }
  openSettings() {
    const s = this.lib.session, T = s.thresholds;
    for (const k of ['tightMs', 'feelMs', 'flamMs', 'dynamicsDb', 'farMs']) this.$('ls_' + k).value = T[k];
    this.$('ls_expectedShare').value = Math.round(T.expectedShare * 100);
    this.$('ls_core').value = Object.entries(s.corePositions).map(([d, ps]) => `${d}: ${ps.join(' ')}`).join('\n');
    for (const b of ['low', 'mid', 'high']) this.$('ls_floor_' + b).value = s.bandFloorsDb[b] === null || s.bandFloorsDb[b] === undefined ? '' : s.bandFloorsDb[b];
    const cur = this.current; this.$('lsFloorsAuto').textContent = cur && cur._floors ? `Auto floors for ${cur.id}: low ${this.fmt(cur._floors.low)} · mid ${this.fmt(cur._floors.mid)} · high ${this.fmt(cur._floors.high)} dB` : '';
    this.$('dlgLabSettings').showModal();
  }
  saveSettings() {
    const s = this.lib.session, T = s.thresholds; let reanalyse = false;
    for (const k of ['tightMs', 'feelMs', 'flamMs', 'dynamicsDb', 'farMs']) { const v = parseFloat(this.$('ls_' + k).value); if (isFinite(v) && v >= 0) { if (k === 'flamMs' && v !== T[k]) reanalyse = true; T[k] = v; } }
    const es = parseFloat(this.$('ls_expectedShare').value); if (isFinite(es)) T.expectedShare = Math.max(0, Math.min(1, es / 100));
    const core = {}; for (const line of this.$('ls_core').value.split('\n')) { const m = /^\s*(kick|snare|hat|other)\s*:\s*([\d\s,]*)$/i.exec(line); if (m) core[m[1].toLowerCase()] = m[2].split(/[\s,]+/).filter(Boolean).map(Number).filter(n => Number.isInteger(n) && n >= 0); }
    if (Object.keys(core).length) s.corePositions = core;
    for (const b of ['low', 'mid', 'high']) { const v = this.$('ls_floor_' + b).value.trim(); const nv = v === '' ? null : parseFloat(v); if (nv !== s.bandFloorsDb[b]) reanalyse = true; s.bandFloorsDb[b] = v === '' ? null : (isFinite(nv) ? nv : null); }
    this.$('dlgLabSettings').close();
    if (reanalyse && this.lib.loops.some(l => l._file)) this.reanalyzeAll(); else { this.lib.recompute(); this.markDirty(); this.renderAll(); this.drawAll(); }
    this.toast('Analysis settings saved');
  }
}


/* ================= Sequence view (1.2.0) ================= */
Object.defineProperty(LoopLab.prototype, 'arr', { get() { return this.currentArrId ? this.seq.get(this.currentArrId) : null; } });
Object.assign(LoopLab.prototype, {
  bindSequence() {
    this.$('lbViewLibrary').addEventListener('click', () => this.setView('library'));
    this.$('lbViewSequence').addEventListener('click', () => this.setView('sequence'));
    this.seq.onChange((ev) => { this.markDirty(); if (!this.seq.get(this.currentArrId)) this.currentArrId = this.lib.arrangements[0] ? this.lib.arrangements[0].id : null; this.seqView.arrId = this.currentArrId; this.seqView.refresh(); this.renderSeqAll(); void ev; });
    const V = this.seqView;
    V.on('select', (id) => { this.renderSeqBlock(); this.renderSeqTransport(); });
    V.on('seamSelect', (seam) => { this.showSeqTab('seams'); this.renderSeqSeams(); });
    V.on('dropLoop', (loopId, index) => { this.seq.addBlock(this.currentArrId, loopId, index); const a = this.arr; if (a) { V.selectedBlockId = a.blocks[index].id; V.draw(); this.renderSeqBlock(); } });
    V.on('moveBlock', (blockId, index) => this.seq.moveBlock(this.currentArrId, blockId, index));
    V.on('removeBlock', (blockId) => { this.seq.removeBlock(this.currentArrId, blockId); V.selectedBlockId = null; });
    V.on('addMarker', async (bar) => { const name = await this.promptText('Marker name', `bar ${bar}`); if (name !== null) this.seq.addMarker(this.currentArrId, bar, name); });
    V.on('editMarker', async (m) => { const name = await this.promptText('Rename marker (empty removes)', m.name); if (name === null) return; if (!name.trim()) this.seq.removeMarker(this.currentArrId, m.bar); else this.seq.addMarker(this.currentArrId, m.bar, name); });
    V.on('removeMarker', (bar) => this.seq.removeMarker(this.currentArrId, bar));
    V.on('seekBar', (bar) => { const L = V.layout; if (!L) return; const info = Sequence.barInfo(L, bar); if (!info) return; const sec = info.occ.startSec + (bar - info.occ.startBar) * info.occ.lengthSec / info.occ.bars; if (this.player.inSequence) this.seqPlay({ fromSec: sec, loopWhole: this.player.seq.loopWhole }); else { this.player.pausedAt = sec; this.renderSeqTransport(); } });
    V.on('playBlock', (blockId) => { V.selectedBlockId = blockId; this.seqPlayFromBlock(); });
    V.on('hover', (h, ev) => { const t = this.$('sqTooltip'); if (!h) { t.hidden = true; return; } if (h.seam) t.textContent = this.seamText(h.seam); else if (h.block) { const l = h.block.loop; const info = V.layout ? Sequence.barInfo(V.layout, h.bar) : null; t.textContent = `${l ? l.id : h.block.block.loopId} ×${h.block.block.repeats}${l ? ` · ${l.bars.toFixed(2)} bars · ★${LoopLibrary.formatRating(l.rating) || '—'}${this.isRevealed(l) ? ` · machine ${l.machine && l.machine.score !== null ? l.machine.score : '—'}` : ''}` : ''}${info ? `\narrangement bar ${h.bar} = ${info.ptBar !== null ? 'PT bar ' + info.ptBar : 'local bar ' + info.localBar} (repeat ${info.occ.repeatIndex + 1}/${h.block.block.repeats})` : ''}`; } t.hidden = false; const r = this.$('seqMain').getBoundingClientRect(); t.style.left = Math.min(r.width - 330, ev.clientX - r.left + 12) + 'px'; t.style.top = (ev.clientY - r.top + 14) + 'px'; });
    this.$('sqNew').addEventListener('click', async () => { const name = await this.promptText('Arrangement name', 'arrangement ' + (this.lib.arrangements.length + 1)); if (name === null) return; const a = this.seq.create(name); this.selectArrangement(a.id); });
    this.$('sqDup').addEventListener('click', () => { if (!this.arr) return; const a = this.seq.duplicate(this.currentArrId); if (a) this.selectArrangement(a.id); });
    this.$('sqRename').addEventListener('click', async () => { if (!this.arr) return; const name = await this.promptText('Rename arrangement', this.arr.name); if (name !== null) this.seq.rename(this.currentArrId, name); });
    this.$('sqDelete').addEventListener('click', async () => { if (!this.arr) return; const r = await this.app.confirm({ title: `Delete arrangement "${this.arr.name}"?`, body: 'Undo with ⌘Z.', buttons: [{ label: 'Delete', value: 'ok', danger: true }, { label: 'Cancel', value: null }] }); if (r === 'ok') { this.seq.remove(this.currentArrId); } });
    this.$('sqSetA').addEventListener('click', () => this.seqAssign('A'));
    this.$('sqSetB').addEventListener('click', () => this.seqAssign('B'));
    this.$('sqLoopFilter').addEventListener('input', () => this.renderSeqLoops());
    this.$('sqShowSource').addEventListener('change', (e) => { this.seqView.showSourceBars = e.target.checked; this.seqView.draw(); });
    this.$('sqFade').addEventListener('input', (e) => { this.$('sqFadeVal').textContent = `${e.target.value} ms`; });
    this.$('sqFade').addEventListener('change', (e) => { if (this.arr) this.seq.setSettings(this.currentArrId, { seamFadeMs: parseFloat(e.target.value) }); });
    this.$('sqLevelMatch').addEventListener('change', (e) => { if (this.arr) this.seq.setSettings(this.currentArrId, { levelMatch: e.target.checked }); });
    this.$('sqZoomIn').addEventListener('click', () => this.seqView.zoom(1.5)); this.$('sqZoomOut').addEventListener('click', () => this.seqView.zoom(1 / 1.5)); this.$('sqFit').addEventListener('click', () => this.seqView.fit());
    this.$('sqUndo').addEventListener('click', () => this.seqUndo()); this.$('sqRedo').addEventListener('click', () => this.seqRedo());
    this.$('sqExportCues').addEventListener('click', () => this.seqExportCues());
    this.$('sqRender').addEventListener('click', () => this.seqRenderWav());
    this.$('sqExportArr').addEventListener('click', () => this.seqExportArrangement());
    this.$('sqImportArr').addEventListener('click', () => this.$('sqArrFile').click());
    this.$('sqArrFile').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.seqImportArrangement(await f.text(), f.name); });
    for (const b of U.$$('.seq-tabs [role=tab]')) b.addEventListener('click', () => this.showSeqTab(b.dataset.tab));
    // block form
    const form = this.$('sqBlockForm'); form.addEventListener('submit', (e) => e.preventDefault());
    const blk = () => { const a = this.arr; return a && a.blocks.find(b => b.id === this.seqView.selectedBlockId); };
    this.$('sqRepeats').addEventListener('change', (e) => { const b = blk(); if (b) this.seq.setBlock(this.currentArrId, b.id, { repeats: parseInt(e.target.value, 10) }); });
    this.$('sqRepMinus').addEventListener('click', () => { const b = blk(); if (b) this.seq.setBlock(this.currentArrId, b.id, { repeats: b.repeats - 1 }); });
    this.$('sqRepPlus').addEventListener('click', () => { const b = blk(); if (b) this.seq.setBlock(this.currentArrId, b.id, { repeats: b.repeats + 1 }); });
    this.$('sqGain').addEventListener('input', (e) => { this.$('sqGainNum').value = e.target.value; });
    this.$('sqGain').addEventListener('change', (e) => { const b = blk(); if (b) this.seq.setBlock(this.currentArrId, b.id, { gainDb: parseFloat(e.target.value) }); });
    this.$('sqGainNum').addEventListener('change', (e) => { const b = blk(); if (b) this.seq.setBlock(this.currentArrId, b.id, { gainDb: parseFloat(e.target.value) }); });
    this.$('sqBlockNotes').addEventListener('change', (e) => { const b = blk(); if (b) this.seq.setBlock(this.currentArrId, b.id, { notes: e.target.value }); });
    this.$('sqBlockDup').addEventListener('click', () => this.seqDuplicateSelected());
    this.$('sqBlockDel').addEventListener('click', () => this.seqRemoveSelected());
    this.$('sqNotes').addEventListener('change', (e) => { if (this.arr) { this.seq.setNotes(this.currentArrId, e.target.value); this.markDirty(); } });
    // transport
    this.$('sqPlay').addEventListener('click', () => { if (this.player.inSequence) { this.player.pause(); this.renderSeqTransport(); } else this.seqPlay({ fromSec: 0 }); });
    this.$('sqPlayFrom').addEventListener('click', () => this.seqPlayFromBlock());
    this.$('sqLoopAll').addEventListener('click', () => this.seqPlay({ fromSec: 0, loopWhole: true }));
    this.$('sqLoopBlock').addEventListener('click', () => this.seqLoopBlock());
    this.$('sqSeam').addEventListener('click', () => this.seqAuditionSeam());
    this.$('sqStop').addEventListener('click', () => { this.player.stop(); this.player.pausedAt = 0; this.playingArrId = null; this.renderSeqTransport(); this.seqView.draw(); });
  },
  promptText(title, value) { const input = U.el('input', { type: 'text', value, style: { width: '100%' } }); return this.app.confirm({ title, body: input, buttons: [{ label: 'OK', value: 'ok', primary: true }, { label: 'Cancel', value: null }] }).then(r => r === 'ok' ? input.value : null); },
  setView(v) {
    this.view = v; document.querySelector('.lab-body:not(.seq-body)').hidden = v !== 'library'; this.$('seqBody').hidden = v !== 'sequence'; this.$('seqTransport').hidden = v !== 'sequence';
    this.$('lbViewLibrary').classList.toggle('active', v === 'library'); this.$('lbViewSequence').classList.toggle('active', v === 'sequence');
    if (v === 'sequence') { if (!this.currentArrId && this.lib.arrangements.length) this.currentArrId = this.lib.arrangements[0].id; this.seqView.setArrangement(this.currentArrId); this.renderSeqAll(); if (this.seqView.pxPerBar === 40 && this.seqView.totalBars() > 0) this.seqView.fit(); }
    else { this.drawAll(); this.renderAll(); }
  },
  selectArrangement(id) { this.currentArrId = id; this.seqView.setArrangement(id); this.renderSeqAll(); this.seqView.fit(); },
  showSeqTab(name) { for (const b of U.$$('.seq-tabs [role=tab]')) { const on = b.dataset.tab === name; b.classList.toggle('active', on); b.setAttribute('aria-selected', String(on)); } for (const p of U.$$('.seq-panels .panel')) p.hidden = p.id !== `sqTab-${name}`; if (name === 'profile') this.renderSeqProfile(); },
  seqAddLoop(loopId) {
    if (!this.arr) { const a = this.seq.create('arrangement 1'); this.currentArrId = a.id; this.seqView.setArrangement(a.id); }
    const b = this.seq.addBlock(this.currentArrId, loopId); if (b) { this.seqView.selectedBlockId = b.id; this.seqView.refresh(); this.renderSeqBlock(); if (this.view === 'library') this.toast(`${loopId} added to "${this.arr.name}" (Sequence view)`); }
  },
  seqUndo() { const l = this.seq.undo(); this.toast(l ? `Undid ${l}` : 'Nothing to undo'); },
  seqRedo() { const l = this.seq.redo(); this.toast(l ? `Redid ${l}` : 'Nothing to redo'); },
  seqDuplicateSelected() { const id = this.seqView.selectedBlockId; if (!id) return; const c = this.seq.duplicateBlock(this.currentArrId, id); if (c) { this.seqView.selectedBlockId = c.id; this.seqView.draw(); this.renderSeqBlock(); } },
  seqRemoveSelected() { const id = this.seqView.selectedBlockId; if (!id) return; const a = this.arr; const i = a.blocks.findIndex(b => b.id === id); this.seq.removeBlock(this.currentArrId, id); const na = this.arr; this.seqView.selectedBlockId = na && na.blocks.length ? na.blocks[Math.min(i, na.blocks.length - 1)].id : null; this.seqView.draw(); this.renderSeqBlock(); },
  seqAssign(deck) { if (!this.arr) return; this.seqAB[deck] = this.currentArrId; if (this.blind.on) { this.blind.swapped = Math.random() < 0.5; this.blind.revealed = false; } this.renderSeqArrs(); this.toast(`${deck} = ${this.blind.on ? '(hidden)' : this.arr.name}`); },
  deckArr(deck) { const id = this.blind.on && this.blind.swapped ? this.seqAB[deck === 'A' ? 'B' : 'A'] : this.seqAB[deck]; return id ? this.seq.get(id) : null; },

  /* ---------- rendering ---------- */
  renderSeqAll() { if (!this.$('sqArrList')) return; this.renderSeqArrs(); this.renderSeqLoops(); this.renderSeqHead(); this.renderSeqBlock(); this.renderSeqSeams(); this.renderSeqCues(); this.renderSeqProfile(); this.$('sqNotes').value = this.arr ? this.arr.notes || '' : ''; this.renderSeqTransport(); this.$('sqUndo').disabled = !this.seq.canUndo; this.$('sqRedo').disabled = !this.seq.canRedo; },
  renderSeqArrs() {
    const box = this.$('sqArrList'); box.innerHTML = ''; const hide = this.blind.on && !this.blind.revealed;
    for (const a of this.lib.arrangements) { const L = Sequence.layout(a, this.lib); const tag = !hide && this.seqAB.A === a.id ? ' A' : ''; const tagB = !hide && this.seqAB.B === a.id ? ' B' : ''; const row = U.el('div', { class: 'seq-arr' + (a.id === this.currentArrId ? ' selected' : ''), onClick: () => this.selectArrangement(a.id) }, U.el('span', { text: a.name + (tag || tagB ? ` [${(tag + tagB).trim()}]` : '') }), U.el('span', { class: 'muted', text: `${L.totalBars} bars · ${a.blocks.length} blocks` })); box.append(row); }
    if (!this.lib.arrangements.length) box.append(U.el('div', { class: 'muted small', text: 'No arrangements yet — press "new".' }));
    this.$('sqAbInfo').textContent = `A: ${hide && this.seqAB.A ? '??' : (this.seq.get(this.seqAB.A) || { name: '—' }).name} · B: ${hide && this.seqAB.B ? '??' : (this.seq.get(this.seqAB.B) || { name: '—' }).name}`;
  },
  renderSeqLoops() {
    const box = this.$('sqLoopList'); box.innerHTML = ''; const q = this.$('sqLoopFilter').value.trim().toLowerCase();
    const list = this.lib.loops.filter(l => !q || l.id.toLowerCase().includes(q) || (l.tags || []).some(t => t.toLowerCase().includes(q))).sort((a, b) => ((b.rating ?? -1) - (a.rating ?? -1)) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    for (const l of list) {
      const row = U.el('div', { class: 'seq-loop', draggable: 'true', title: `${l.fileName} · drag onto the lane`, dataset: { id: l.id } },
        U.el('span', { class: 'sw', style: { background: Sequence.colorFor(l, this.lib) } }), U.el('span', { text: l.id }), U.el('span', { class: 'num', text: `${Math.round(l.bars)}b` }),
        U.el('span', { class: 'num', text: `★${LoopLibrary.formatRating(l.rating) || '—'}${this.isRevealed(l) ? ' m' + (l.machine && l.machine.score !== null && l.machine.score !== undefined ? l.machine.score.toFixed(1) : '—') : ''}` }),
        U.el('button', { class: 'tiny', text: '+', title: 'append to the arrangement', onClick: (e) => { e.stopPropagation(); this.seqAddLoop(l.id); } }));
      row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-loop-id', l.id); e.dataTransfer.setData('text/plain', l.id); e.dataTransfer.effectAllowed = 'copy'; });
      row.addEventListener('dblclick', () => this.seqAddLoop(l.id));
      box.append(row);
    }
    if (!list.length) box.append(U.el('div', { class: 'muted small', text: 'No loops loaded (Library view → Open loops…).' }));
  },
  renderSeqHead() { const a = this.arr; this.$('sqTitle').innerHTML = a ? `<b>${U.escapeHtml(a.name)}</b>` : '<b>—</b>'; if (a) { this.$('sqFade').value = String((a.settings && a.settings.seamFadeMs) || 0); this.$('sqFadeVal').textContent = `${(a.settings && a.settings.seamFadeMs) || 0} ms`; this.$('sqLevelMatch').checked = !a.settings || a.settings.levelMatch !== false; } },
  renderSeqBlock() {
    const a = this.arr; const b = a && a.blocks.find(x => x.id === this.seqView.selectedBlockId);
    this.$('sqBlockEmpty').hidden = !!b; this.$('sqBlockForm').hidden = !b; if (!b) return;
    const l = this.lib.loop(b.loopId); const L = this.seqView.layout; const occ = L ? L.occ.find(o => o.block.id === b.id) : null;
    this.$('sqBlockTitle').innerHTML = `<b>${U.escapeHtml(l ? l.id : b.loopId + ' (missing)')}</b>`; this.$('sqRepeats').value = String(b.repeats); this.$('sqGain').value = String(b.gainDb || 0); this.$('sqGainNum').value = String(b.gainDb || 0); this.$('sqBlockNotes').value = b.notes || '';
    this.$('sqBlockInfo').textContent = occ ? `at arrangement bar ${occ.startBar}${l && l.barRange ? ` · PT ${l.barRange.start}–${l.barRange.end}` : ''} · ${(occ.bars * b.repeats)} bars${occ.gainDb - (b.gainDb || 0) ? ` · level match ${(occ.gainDb - (b.gainDb || 0)) > 0 ? '+' : ''}${(occ.gainDb - (b.gainDb || 0)).toFixed(1)} dB` : ''}` : '';
  },
  seamText(s) { return `${s.kind === 'repeat' ? `${s.fromLoop} repeat join` : `${s.fromLoop} → ${s.toLoop}`} at bar ${s.atBar}: ${s.verdict}${s.needsAudio ? '' : `\nlevel ${s.levelStepDb > 0 ? '+' : ''}${s.levelStepDb} dB (peaks ${s.peakOutDb} → ${s.peakInDb}) · feel ${s.feelStepMs === null ? '—' : (s.feelStepMs > 0 ? '+' : '') + s.feelStepMs + ' ms'} · top end ${s.highStepDb > 0 ? '+' : ''}${s.highStepDb} dB · hats ${s.hatsOut} → ${s.hatsIn}/bar · step ${s.sampleStep}`}${s.signatureDiff.length ? '\n' + s.signatureDiff.join('; ') : ''}${s.care ? '\n' + s.care : ''}`; },
  renderSeqSeams() {
    const box = this.$('sqTab-seams'); const a = this.arr; if (!a) { box.innerHTML = '<p class="muted">No arrangement.</p>'; this.$('sqSeamCount').textContent = ''; return; }
    const seams = this.seqView.seams.slice().sort((x, y) => ({ red: 3, amber: 2, grey: 1, green: 0 }[y.severity] - { red: 3, amber: 2, grey: 1, green: 0 }[x.severity]) || (Math.abs(y.levelStepDb || 0) - Math.abs(x.levelStepDb || 0)) || x.atBar - y.atBar);
    const ov = Sequence.overview(a, this.lib, this.seqView.seams);
    this.$('sqSeamCount').textContent = seams.length ? `(${ov.redCount + ov.amberCount}/${seams.length})` : '';
    const f = (v, d = 1, sign = true) => v === null || v === undefined ? '—' : (sign && v > 0 ? '+' : '') + v.toFixed(d);
    let html = `<div class="small">${ov.totalBars} bars · ${U.fmtTime(ov.totalSeconds)} · ${seams.length} seams: <b class="bad">${ov.redCount} red</b>, <b class="warn">${ov.amberCount} amber</b>, ${seams.length - ov.redCount - ov.amberCount} clean/grey · feel: ${ov.behindBars} bars behind, ${ov.aheadBars} ahead of ${ov.totalBars}</div>`;
    html += '<table class="seams"><tr><th></th><th>bar</th><th>seam</th><th>verdict</th><th>level dB</th><th>feel ms</th><th>top dB</th><th>hats/bar</th><th>step</th><th>pattern</th></tr>';
    for (const s of seams) html += `<tr data-i="${s.index}" class="${this.seqView.selectedSeamIndex === s.index ? 'selected' : ''}"><td><span class="badge ${s.severity}"></span></td><td>${s.atBar}</td><td>${s.kind === 'repeat' ? `${U.escapeHtml(s.fromLoop)} ↻` : `${U.escapeHtml(s.fromLoop)} → ${U.escapeHtml(s.toLoop)}`}</td><td>${U.escapeHtml(s.verdict)}${s.pushedDownbeat ? ' ⚠' : ''}</td><td>${f(s.levelStepDb)}</td><td>${f(s.feelStepMs)}</td><td>${f(s.highStepDb)}</td><td>${s.hatsOut === null ? '—' : `${s.hatsOut} → ${s.hatsIn}`}</td><td>${s.sampleStep === null ? '—' : s.sampleStep}</td><td class="muted">${U.escapeHtml([...(s.notes || []).filter(n => n !== "pattern differs"), ...s.signatureDiff].join("; "))}</td></tr>`;
    html += '</table>';
    const care = Sequence.careList(this.seqView.seams); html += `<h4>Care list for Pro Tools</h4>` + (care.length ? '<ul class="care-list">' + care.map(c => `<li>${U.escapeHtml(c)}</li>`).join('') + '</ul>' : '<p class="small good">Every seam is clean.</p>');
    box.innerHTML = html;
    for (const tr of box.querySelectorAll('tr[data-i]')) tr.addEventListener('click', () => { const i = parseInt(tr.dataset.i, 10); this.seqView.selectedSeamIndex = i; const s = this.seqView.seams.find(x => x.index === i); if (s) this.seqView.ensureVisible(s.atBar); this.seqView.draw(); this.renderSeqSeams(); });
  },
  renderSeqCues() {
    const box = this.$('sqTab-cues'); const a = this.arr; if (!a) { box.innerHTML = ''; return; }
    const rows = Sequence.cuesRows(a, this.lib);
    box.innerHTML = '<table class="cues"><tr><th>arr bars</th><th>loop</th><th>PT bars</th><th>Start</th><th>End</th><th>repeat</th><th>trim</th><th>match</th><th>seam in</th></tr>' + rows.map(r => `<tr><td>${r.arrStart}–${r.arrEnd}</td><td>${U.escapeHtml(r.loopId)}</td><td>${r.ptBars || '—'}</td><td>${r.ptStart || '—'}</td><td>${r.ptEnd || '—'}</td><td>${r.repeat}</td><td>${r.gainDb ? (r.gainDb > 0 ? '+' : '') + r.gainDb.toFixed(1) : '0'}</td><td>${r.matchDb ? (r.matchDb > 0 ? '+' : '') + r.matchDb.toFixed(1) : '0'}</td><td><span class="badge ${r.seamSeverity || 'green'}"></span>${U.escapeHtml(r.seamVerdict)}</td></tr>`).join('') + '</table><p class="muted small">Export ▸ "cue list" writes this table with the care list as Markdown and CSV.</p>';
  },
  renderSeqProfile() {
    const c = this.$('sqProfile'); const a = this.arr; if (!c || c.offsetParent === null) return; const { ctx, w, h } = this.seqView._setup(c); ctx.fillStyle = '#0b0d11'; ctx.fillRect(0, 0, w, h);
    if (!a) return; const ov = Sequence.overview(a, this.lib, this.seqView.seams); const P = ov.profile; if (!P.length) return;
    const pad = 28, top = 8, bottom = h - 16; const yOf = (ms) => top + (1 - (U.clamp(ms, -40, 40) + 40) / 80) * (bottom - top); const xOf = (bar) => pad + (bar - 1) / Math.max(1, P.length) * (w - pad - 6);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.beginPath(); ctx.moveTo(pad, yOf(0)); ctx.lineTo(w, yOf(0)); ctx.stroke();
    ctx.fillStyle = '#8b95a5'; ctx.font = '10px ui-monospace, monospace'; ctx.textBaseline = 'middle'; ctx.fillText('+40', 2, yOf(40)); ctx.fillText('0', 2, yOf(0)); ctx.fillText('−40', 2, yOf(-40));
    for (const p of P) if (p.seam) { ctx.fillStyle = 'rgba(255,176,63,0.5)'; ctx.fillRect(Math.round(xOf(p.bar)), top, 1, bottom - top); }
    ctx.strokeStyle = '#3fb0ff'; ctx.lineWidth = 1.5; ctx.beginPath(); let started = false;
    for (const p of P) { if (p.feelMs === null) { started = false; continue; } const x0 = xOf(p.bar), x1 = xOf(p.bar + 1), y = yOf(p.feelMs); if (!started) { ctx.moveTo(x0, y); started = true; } else ctx.lineTo(x0, y); ctx.lineTo(x1, y); }
    ctx.stroke(); ctx.lineWidth = 1;
    ctx.fillStyle = '#8b95a5'; ctx.textBaseline = 'top'; ctx.fillText('bar 1', pad, bottom + 3); ctx.fillText(`bar ${P.length}`, w - 40, bottom + 3);
    this.$('sqOverview').innerHTML = `Mean core-hit deviation per arrangement bar (ms behind the click; amber lines = seams). ${ov.behindBars} bar(s) behind (&gt;3 ms), ${ov.aheadBars} ahead (&lt;−3 ms) of ${ov.totalBars}. Verdicts: ${Object.entries(ov.verdictCounts).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}.`;
  },
  renderSeqTransport() {
    if (!this.$('sqPos')) return; const p = this.player; const inSeq = p.inSequence;
    this.$('sqPlay').textContent = inSeq ? '❚❚' : '▶'; this.$('sqPlay').setAttribute('aria-pressed', String(inSeq));
    for (const [id, m] of [['sqLoopAll', 'all'], ['sqLoopBlock', 'block'], ['sqSeam', 'seam']]) this.$(id).classList.toggle('active', inSeq && this.seqMode === m);
    if (!inSeq) { this.$('sqPos').textContent = p.pausedAt ? U.fmtTime(p.pausedAt) : '—'; this.$('sqPosPt').textContent = ''; return; }
    const info = p.seqInfo(); if (!info) return;
    if (info.countIn) { this.$('sqPos').textContent = 'count-in'; return; }
    const o = info.occ; const localBar = info.bar - o.startBar + 1; const pt = o.loop ? Sequence.ptBarOf(o.loop, localBar) : null;
    this.$('sqPos').textContent = `${this.seqMode === 'seam' ? 'seam ' : ''}${info.bar}|${info.beatInBar + 1}|${String(info.tick).padStart(3, '0')} · ${U.fmtTime(info.pos)}`;
    this.$('sqPosPt').textContent = `${o.loop ? o.loop.id : '?'} repeat ${o.repeatIndex + 1}/${o.block.repeats}${pt !== null ? ` · PT bar ${pt}` : ''}${p.mode === 'seqab' ? ` · deck ${p.active}` : ''}${info.iteration ? ` · pass ${info.iteration + 1}` : ''}`;
  },

  /* ---------- playback ---------- */
  async seqSpec(arr, { occFilter = null } = {}) {
    const L = Sequence.layout(arr, this.lib); const occs = occFilter ? L.occ.filter(occFilter) : L.occ;
    const spec = { occ: [], totalSec: 0, fadeMs: (arr.settings && arr.settings.seamFadeMs) || 0, bpb: L.bpb };
    let t = 0;
    for (const o of occs) { if (o.missing) continue; await this.ensureBuffer(o.loop); const buf = o.loop._buffer; const offset = o.offsetSec || 0; const b = offset > 0 ? this.sliceBuffer(buf, Math.round(offset * buf.sampleRate), o.lengthSamples) : buf; spec.occ.push({ buffer: b, gainLin: o.gainLin, startSec: t, lengthSec: o.lengthSec, bars: o.bars, beatSec: o.beatSec, startBar: o.startBar, label: o.loop.id, rmsLin: o.loop._rmsLin, block: o.block, repeatIndex: o.repeatIndex }); t += o.lengthSec; }
    spec.totalSec = t; return spec;
  },
  sliceBuffer(buffer, start, length) { const ctx = this.player.ensureCtx(); const out = ctx.createBuffer(buffer.numberOfChannels, Math.max(1, length), buffer.sampleRate); for (let c = 0; c < buffer.numberOfChannels; c++) out.getChannelData(c).set(buffer.getChannelData(c).subarray(start, start + length)); return out; },
  async seqPlay({ fromSec = 0, loopWhole = false, mode = null } = {}) {
    const a = this.arr; if (!a || !a.blocks.length) { this.toast('The arrangement is empty.', { error: true }); return; }
    try {
      const A = this.deckArr('A'), B = this.deckArr('B'); const ab = A && B && (A.id === a.id || B.id === a.id);
      const specA = await this.seqSpec(ab ? A : a), specB = ab ? await this.seqSpec(B) : null;
      this.player.startSequence({ A: specA, B: specB, active: ab ? (A.id === a.id ? 'A' : 'B') : 'A', offset: fromSec, countIn: this.player.metro.countIn, loopWhole });
      this.playingArrId = a.id; this.seqMode = mode || (loopWhole ? 'all' : 'play');
    } catch (e) { this.toast('Cannot play: ' + e.message, { error: true }); }
    this.renderSeqTransport(); this.seqView.draw();
  },
  seqPlayFromBlock() { const a = this.arr; const id = this.seqView.selectedBlockId; if (!a) return; const L = Sequence.layout(a, this.lib); const o = L.occ.find(x => x.block.id === id) || L.occ[0]; if (!o) return; this.seqPlay({ fromSec: o.startSec }); },
  async seqLoopBlock() {
    const a = this.arr; const id = this.seqView.selectedBlockId; if (!a || !id) { this.toast('Select a block first.', { error: true }); return; }
    try { const spec = await this.seqSpec(a, { occFilter: (o) => o.block.id === id }); if (!spec.occ.length) return; this.player.startSequence({ A: spec, offset: 0, countIn: this.player.metro.countIn, loopWhole: true }); this.playingArrId = a.id; this.seqMode = 'block'; this._blockSpecOffset = spec; }
    catch (e) { this.toast('Cannot play: ' + e.message, { error: true }); }
    this.renderSeqTransport();
  },
  /** seam audition: last bar of the outgoing occurrence + first bar of the incoming one, on repeat */
  async seqAuditionSeam() {
    const a = this.arr; if (!a) return; const V = this.seqView;
    let seam = V.selectedSeamIndex !== null ? V.seams.find(s => s.index === V.selectedSeamIndex) : null;
    if (!seam && V.selectedBlockId) seam = V.seams.find(s => s.from === V.selectedBlockId && s.kind === 'junction') || V.seams.find(s => s.from === V.selectedBlockId);
    if (!seam) seam = V.seams[0];
    if (!seam) { this.toast('No seam to audition (add at least two blocks or a repeat).', { error: true }); return; }
    const L = Sequence.layout(a, this.lib);
    const outO = seam.kind === 'repeat' ? L.occ.find(o => o.block.id === seam.from) : L.occ.filter(o => o.block.id === seam.from).pop();
    const inO = seam.kind === 'repeat' ? outO : L.occ.find(o => o.block.id === seam.to);
    if (!outO || !inO || outO.missing || inO.missing) return;
    try {
      await this.ensureBuffer(outO.loop); await this.ensureBuffer(inO.loop);
      const bpb = L.bpb; const mk = (o, last) => { const buf = o.loop._buffer; const off = Math.round((o.offsetSec || 0) * buf.sampleRate); const barLen = Math.round(o.lengthSamples / o.bars); const start = last ? off + o.lengthSamples - barLen : off; return { buffer: this.sliceBuffer(buf, start, barLen), gainLin: o.gainLin, lengthSec: barLen / buf.sampleRate, bars: 1, beatSec: barLen / buf.sampleRate / bpb, label: o.loop.id, rmsLin: o.loop._rmsLin, block: o.block, repeatIndex: o.repeatIndex }; };
      const A = mk(outO, true), B = mk(inO, false); A.startSec = 0; A.startBar = outO.startBar + outO.bars - 1; B.startSec = A.lengthSec; B.startBar = inO.startBar;
      const spec = { occ: [A, B], totalSec: A.lengthSec + B.lengthSec, fadeMs: (a.settings && a.settings.seamFadeMs) || 0, bpb };
      const wasOn = this.player.metro.on; if (!wasOn) { this.player.setMetro({ on: true }); this.$('lbMetroOn').checked = true; }
      this.player.startSequence({ A: spec, offset: 0, countIn: false, loopWhole: true }); this.playingArrId = a.id; this.seqMode = 'seam'; V.selectedSeamIndex = seam.index; V.ensureVisible(seam.atBar);
      this.toast(`Seam audition: ${seam.fromLoop} last bar → ${seam.toLoop} first bar (${seam.verdict})`);
    } catch (e) { this.toast('Cannot audition: ' + e.message, { error: true }); }
    this.renderSeqTransport(); this.seqView.draw();
  },
  handleSeqKey(e) {
    const typing = U.isTypingTarget(e.target); const mod = e.metaKey || e.ctrlKey; const V = this.seqView; const a = this.arr;
    if (mod && !e.altKey) { const k = e.key.toLowerCase(); if (k === 'z') { if (typing) return false; e.preventDefault(); if (e.shiftKey) this.seqRedo(); else this.seqUndo(); return true; } if (k === 'd') { e.preventDefault(); this.seqDuplicateSelected(); return true; } return false; }
    if (typing) return false;
    const stop = () => { e.preventDefault(); e.stopPropagation(); }; const key = e.key;
    const sel = a ? a.blocks.findIndex(b => b.id === V.selectedBlockId) : -1;
    if (key === ' ') { stop(); if (this.player.inSequence) { this.player.pause(); this.renderSeqTransport(); V.draw(); } else if (e.shiftKey) this.seqPlayFromBlock(); else this.seqPlay({ fromSec: 0 }); return true; }
    if (key === 'Escape') { stop(); V.selectedBlockId = null; V.selectedSeamIndex = null; V.draw(); this.renderSeqBlock(); return true; }
    if (key === 'Backspace' || key === 'Delete') { if (sel >= 0) { stop(); this.seqRemoveSelected(); } return true; }
    if (key === 'ArrowLeft' || key === 'ArrowRight') { stop(); if (!a || !a.blocks.length) return true; const d = key === 'ArrowRight' ? 1 : -1; if (e.altKey && sel >= 0) { this.seq.moveBlock(this.currentArrId, V.selectedBlockId, d > 0 ? sel + 2 : sel - 1); } else { const i = sel < 0 ? (d > 0 ? 0 : a.blocks.length - 1) : Math.max(0, Math.min(a.blocks.length - 1, sel + d)); V.selectedBlockId = a.blocks[i].id; const L = V.layout; const o = L && L.occ.find(x => x.block.id === V.selectedBlockId); if (o) V.ensureVisible(o.startBar); V.draw(); this.renderSeqBlock(); } return true; }
    if (key === 'ArrowUp' || key === 'ArrowDown') { stop(); if (sel >= 0) this.seq.setBlock(this.currentArrId, V.selectedBlockId, { repeats: a.blocks[sel].repeats + (key === 'ArrowUp' ? 1 : -1) }); return true; }
    if (key === '+' || key === '=') { stop(); V.zoom(1.5); return true; } if (key === '-' || key === '_') { stop(); V.zoom(1 / 1.5); return true; } if (key === '0') { stop(); V.fit(); return true; }
    const k = key.toLowerCase();
    if (k === 'j') { stop(); this.seqAuditionSeam(); return true; }
    if (k === 'a' || k === 'b') { stop(); this.seqAudition(k.toUpperCase()); return true; }
    if (k === 'x') { stop(); if (this.player.mode === 'seqab') this.seqAudition(this.player.active === 'A' ? 'B' : 'A'); return true; }
    if (k === '?') { stop(); this.$('dlgLabHelp').showModal(); return true; }
    return false; // C, R, L, , . fall through to the Loop Lab handler (metronome, rate, level match)
  },
  async seqAudition(deck) {
    const A = this.deckArr('A'), B = this.deckArr('B'); if (!A || !B) { this.toast('Set two arrangements as A and B first.', { error: true }); return; }
    if (this.player.mode !== 'seqab') { try { const specA = await this.seqSpec(A), specB = await this.seqSpec(B); this.player.startSequence({ A: specA, B: specB, active: deck, offset: 0, countIn: this.player.metro.countIn, loopWhole: true }); this.playingArrId = (deck === 'A' ? A : B).id; this.seqMode = 'all'; } catch (e) { this.toast('Cannot play: ' + e.message, { error: true }); return; } }
    else { this.player.switchTo(deck, { atNextBar: this.$('lbAtBar').checked }); this.playingArrId = (deck === 'A' ? A : B).id; }
    if (!(this.blind.on && !this.blind.revealed)) { this.currentArrId = this.playingArrId; this.seqView.setArrangement(this.currentArrId); this.renderSeqAll(); }
    this.renderSeqTransport();
  },

  /* ---------- exports ---------- */
  arrFileBase() { const a = this.arr; return `${(this.lib.session.name || 'session').replace(/[\/\\:]/g, '_')}.${(a ? a.name : 'arrangement').replace(/[\/\\:]/g, '_')}`; },
  async seqExportCues() { const a = this.arr; if (!a) return; const r1 = await this.persist.exportText(Sequence.cuesMarkdown(a, this.lib), this.arrFileBase() + '.cues.md', 'text/markdown', '.md', 'Cue list (Markdown)'); if (!r1) return; const r2 = await this.persist.exportText(Sequence.cuesCsv(a, this.lib), this.arrFileBase() + '.cues.csv', 'text/csv', '.csv', 'Cue list (CSV)'); if (r2) this.toast(`Exported ${r1.name} and ${r2.name}`); },
  async seqRenderWav() {
    const a = this.arr; if (!a || !a.blocks.length) return;
    try {
      this.toast('Rendering…'); const spec = await this.seqSpec(a); const withClick = this.player.metro.on;
      const { audio, click } = await this.player.renderSequence(spec, { sampleRate: 48000, metronome: withClick, bpb: spec.bpb });
      const r = await this.persist.exportBlob(LoopPlayer.encodeWav24(audio), this.arrFileBase() + '.wav', 'audio/wav', '.wav', 'Rendered arrangement (48 kHz 24-bit)'); if (!r) return;
      if (click) await this.persist.exportBlob(LoopPlayer.encodeWav24(click), this.arrFileBase() + '.click.wav', 'audio/wav', '.wav', 'Metronome track');
      this.toast(`Rendered ${r.name} (${audio.length} samples, ${U.fmtTime(audio.duration)})${click ? ' + click track' : ''}`, { ms: 6000 });
    } catch (e) { this.toast('Render failed: ' + e.message, { error: true }); }
  },
  async seqExportArrangement() { const a = this.arr; if (!a) return; a.seams = this.seqView.seams; const r = await this.persist.exportText(JSON.stringify(Sequence.standaloneExport(a, this.lib), null, 2) + '\n', this.arrFileBase() + '.json', 'application/json', '.json', 'Arrangement'); if (r) this.toast(`Exported ${r.name}`); },
  async seqImportArrangement(text, name) {
    let json; try { json = JSON.parse(text); } catch (e) { await this.app.errorList('Arrangement refused', `${name} is not valid JSON:`, [e.message]); return false; }
    const r = Sequence.standaloneImport(json, this.lib, this.seq);
    if (r.errors.length) { await this.app.errorList('Arrangement refused', `${name} does not match $defs/arrangementExport:`, r.errors); return false; }
    this.selectArrangement(r.arrangement.id);
    this.toast(`Imported "${r.arrangement.name}"${r.relinked.length ? ` (re-linked ${r.relinked.join(', ')})` : ''}${r.missing.length ? ` — missing loops: ${r.missing.join(', ')}` : ''}`, { ms: 7000 });
    return true;
  },
});


/* ================= library launch, blind reveal, rating flow, sorting, compare ================= */
Object.assign(LoopLab.prototype, {
  /* ---------- startup library ---------- */
  async autoOpenLibrary(name) {
    if (!name) return false;
    const idx = await this.library.fetchIndex(); if (!idx || !idx.libraries || !idx.libraries.length) return false;
    const entry = idx.libraries.find(l => l.name === name);
    if (!entry) { this.app.banner(`No library named “${U.escapeHtml(name)}”.`, { error: true }); return false; }
    await this.library.ping();
    this.app.setMode('loops'); this.setView('library');
    this.progress = { total: 1, done: 0 }; this.renderProgress(`loading ${entry.name}…`);
    const t0 = performance.now();
    try {
      const r = await this.library.open(entry, { onProgress: (label, f) => { this.progress = { total: 100, done: Math.round(f * 100) }; this.renderProgress(label); } });
      this.progress = { total: 0, done: 0 }; this.renderProgress();
      this.reveal = 'hidden'; this.$('lbRevealMode').value = 'hidden'; this.sort = { key: 'position', dir: null, secondary: null, unratedFirst: false };
      this.player.setGrid(this.lib.session.bpm, this.lib.session.meterNumerator, this.lib.session.meterDenominator);
      this.seq.clearHistory(); this.currentArrId = this.lib.arrangements[0] ? this.lib.arrangements[0].id : null; this.seqView.setArrangement(this.currentArrId);
      this.clearDirty(); this.renderAll(); this.drawAll();
      const list = this.visibleLoops(); if (list.length) this.select(list[0].id);
      this.evictBuffers();
      const unmatched = r.sidecar ? r.sidecar.unmatched : []; this.libraryStats = Object.assign(r, { totalMs: performance.now() - t0 });
      this.toast(`${entry.name}: ${this.lib.loops.length} loops in ${((performance.now() - t0) / 1000).toFixed(1)} s (cache ${r.cachedIdb}, seed ${r.seedLoaded}, analysed ${r.computed})${unmatched.length ? ` — sidecar unmatched: ${unmatched.join(', ')}` : ''}${this.library.endpoint ? ' · autosave on' : ' · no save endpoint (⌘S to save)'}`, { ms: 8000 });
      if (r.sessionErrors && r.sessionErrors.length) this.app.banner(`The saved session in the library folder could not be loaded (${U.escapeHtml(r.sessionErrors[0])}); starting from the manifest. Your ratings file (Export ratings) is the backup.`, { error: true });
      if (unmatched.length) this.app.banner(`The ratings sidecar has ${unmatched.length} entr${unmatched.length === 1 ? 'y' : 'ies'} with no loop in the library: ${U.escapeHtml(unmatched.join(', '))}`);
      return true;
    } catch (e) { this.progress = { total: 0, done: 0 }; this.renderProgress(); this.app.banner(`Library "${entry.name}" failed to load: ${U.escapeHtml(e.message)}`, { error: true }); console.error(e); return false; }
  },
  /* ---------- blind / reveal ---------- */
  setReveal(v) { this.reveal = v; this.$('lbRevealMode').value = v; this.renderAll(); this.drawAll(); if (this.view === 'sequence') { this.seqView.draw(); this.renderSeqAll(); } this.toast(v === 'hidden' ? 'Imported ratings and the machine score are hidden. The waveform marks stay.' : v === 'rated' ? 'Values shown on loops you have rated' : 'All values revealed'); },
  maskHidden(text) { if (this.reveal === 'all') return text; const hidden = this.lib.loops.filter(l => !this.isRevealed(l)); let out = text; const ly = this.claudeLayer(); for (const l of hidden) { const m = l.machine && l.machine.score !== null && l.machine.score !== undefined ? l.machine.score.toFixed(1) : null; const r = this.claudeRec(l); if (m) out = out.replace(new RegExp(`(\\| ${l.id.replace(/[-.]/g, '\\$&')} \\|[^\n]*?\\| [^|]* \\| )${m}( \\|)`), '$1hidden$2'); if (r && typeof r.score === 'number' && ly) out = out.split(`${ly.name}: ${r.score}`).join(`${ly.name}: hidden`); } return out; },
  /* ---------- rating flow ---------- */
  bindRatingFlow() {
    this.$('lbMyClass').addEventListener('change', () => { const l = this.current; if (l) { l.myClass = this.$('lbMyClass').value || null; this.markDirty(); this.renderTable(); } });
    this.$('lbAutoPlay').addEventListener('change', (e) => { this.autoPlay = e.target.checked; });
    this.$('lbSkip').addEventListener('click', () => this.skipCurrent());
    this.$('lbNextUnrated').addEventListener('click', () => this.nextUnrated());
    this.$('lbSetRef').addEventListener('click', () => this.setReference(this.current));
    this.$('lbClearRef').addEventListener('click', () => this.setReference(null));
    this.$('lbSimPreset').addEventListener('change', (e) => { this.weights = Object.assign({}, Ranking.presets[e.target.value] || Ranking.presets.all); this.renderSortUi(); this.renderTable(); });
    for (const k of ['pattern', 'feel', 'sound']) this.$('lbW_' + k).addEventListener('input', (e) => { this.weights[k] = parseFloat(e.target.value); this.$('lbSimPreset').value = 'custom'; this.renderTable(); });
    this.$('lbSimSection').addEventListener('change', (e) => { const sec = e.target.value; if (!sec) return; const members = this.lib.loops.filter(l => (this.claudeRec(l) || {}).section === sec); this.setReference(Ranking.centroid(members, sec)); });
  },
  typeRatingDigit(d) {
    if (!this.current) return;
    this.ratingBuffer = (this.ratingBuffer.length >= 2 ? '' : this.ratingBuffer) + d;
    this.$('lbRatingWhole').value = this.ratingBuffer[0]; this.$('lbRatingTenth').value = this.ratingBuffer.length > 1 ? this.ratingBuffer[1] : '';
    if (this.ratingBuffer.length === 2) this.$('lbRatingSlider').value = String(parseInt(this.ratingBuffer[0], 10) + parseInt(this.ratingBuffer[1], 10) / 10);
    this.$('lbRatingHint').textContent = this.ratingBuffer.length === 1 ? `${d}._ — type the tenth, then Enter` : `${this.ratingBuffer[0]}.${this.ratingBuffer[1]} — Enter commits and moves on`;
  },
  handleRatingKey(e) {
    const k = e.key.toLowerCase(); const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === 'n') { stop(); this.step(1); return true; } if (k === 'p') { stop(); this.step(-1); return true; }
    if (k === 'u') { stop(); this.nextUnrated(); return true; } if (k === 's') { stop(); this.skipCurrent(); return true; }
    if (k === 't') { stop(); this.$('lbNotes').focus(); return true; } if (k === 'r' && !e.shiftKey) { stop(); this.setReference(this.current); return true; }
    if (k === 'c') { stop(); this.abAgainst(this.reference && !this.reference.isCentroid ? this.reference.id : null, 'reference'); return true; }
    if (k === 'v') { stop(); this.abAgainst(this.lastRatedId, 'previously rated loop'); return true; }
    return false;
  },
  step(d) { const list = this.visibleLoops(); if (!list.length) return; const i = list.findIndex(l => l.id === this.currentId); const n = list[(i + d + list.length) % list.length]; this.select(n.id, { play: this.player.playing && this.autoPlay }); },
  nextUnrated() { const list = this.visibleLoops(); const i = list.findIndex(l => l.id === this.currentId); for (let k = 1; k <= list.length; k++) { const l = list[(i + k) % list.length]; if ((l.rating === null || l.rating === undefined) && !l.skipped) { this.select(l.id, { play: this.player.playing && this.autoPlay }); return; } } this.toast('Every loop in the list is rated or skipped.'); },
  skipCurrent() { const l = this.current; if (!l) return; l.skipped = true; this.markDirty(); this.toast(`${l.id} skipped`); this.renderTable(); this.nextUnrated(); },
  setReference(ref) { this.reference = ref; this.seamCache.clear(); if (ref && this.sort.key !== 'similarity' && this.sort.key !== 'seam') this.sort.key = 'similarity'; if (!ref && (this.sort.key === 'similarity' || this.sort.key === 'seam')) this.sort.key = 'position'; this.$('lbSimSection').value = ref && ref.isCentroid ? ref.section : ''; this.renderSortUi(); this.renderTable(); this.toast(ref ? `Reference: ${ref.id}` : 'Reference cleared'); },
  async abAgainst(otherId, what) { const cur = this.current; if (!cur) return; if (!otherId) { this.toast(`No ${what} set.`, { error: true }); return; } if (otherId === cur.id) { this.toast(`This loop is the ${what}.`); return; } if (this.player.mode === 'ab' && this.ab.A === otherId && this.ab.B === cur.id) { this.player.swap(); this.renderTransport(); return; } this.ab = { A: otherId, B: cur.id }; this.player.stop(); this.player.pausedAt = 0; this.renderAll(); await this.audition('B'); },
  /* ---------- sort / filter UI ---------- */
  renderSortUi() {
    const sel = this.$('lbSortKey'); if (!sel) return; const cur = this.sort.key; sel.innerHTML = '';
    for (const k of Ranking.keys()) { if (k.revealedOnly && this.reveal === 'hidden') continue; const label = k.label + (k.hiddenLabel && this.reveal === 'hidden' ? ` (${k.hiddenLabel})` : ''); sel.append(U.el('option', { value: k.key, text: label })); } sel.value = cur;
    const sec = this.$('lbSortSecondary'); sec.innerHTML = ''; sec.append(U.el('option', { value: '', text: 'then: song position' })); for (const k of Ranking.keys()) if (!(k.revealedOnly && this.reveal === 'hidden')) sec.append(U.el('option', { value: k.key, text: 'then: ' + k.label })); sec.value = this.sort.secondary || '';
    this.$('lbSortDir').textContent = (this.sort.dir || Ranking.keyByName(cur).dir) > 0 ? '▲' : '▼'; this.$('lbUnratedFirst').checked = this.sort.unratedFirst; this.$('lbGroup').checked = this.groupBySection; this.$('lbSeed').value = this.randomSeed;
    this.$('lbSimPanel').hidden = !(cur === 'similarity' || cur === 'seam' || this.reference); this.$('lbRefName').textContent = this.reference ? this.reference.id : '—';
    for (const k of ['pattern', 'feel', 'sound']) this.$('lbW_' + k).value = String(this.weights[k]);
    const secSel = this.$('lbSimSection'); const secs = Ranking.sections(this.ctx()); const cv = secSel.value; secSel.innerHTML = ''; secSel.append(U.el('option', { value: '', text: 'similar to section…' })); for (const s of secs) secSel.append(U.el('option', { value: s, text: s })); secSel.value = this.reference && this.reference.isCentroid ? this.reference.section : (secs.includes(cv) ? cv : '');
    this.renderFilterChips();
  },
  renderFilterChips() {
    const box = this.$('lbChips'); if (!box) return; box.innerHTML = ''; const f = this.filters; const ctx = this.ctx();
    const chip = (label, on, fn, title) => box.append(U.el('button', { class: 'chip' + (on ? ' on' : ''), text: label, title, onClick: () => { fn(); this.renderFilterChips(); this.renderTable(); } }));
    const toggleSet = (set, v) => { if (set.has(v)) set.delete(v); else set.add(v); };
    for (const v of ['2', '4', '8', 'event']) chip(v === 'event' ? 'events' : v + ' bar', f.length.has(v), () => toggleSet(f.length, v));
    box.append(U.el('span', { class: 'sep' }));
    for (const v of ['light', 'medium', 'full']) chip(v + ' hats', f.hats.has(v), () => toggleSet(f.hats, v));
    chip('bass in', f.bass === 'in', () => { f.bass = f.bass === 'in' ? '' : 'in'; }); chip('bass out', f.bass === 'out', () => { f.bass = f.bass === 'out' ? '' : 'out'; });
    chip('fill', f.fill, () => { f.fill = !f.fill; }); chip('break', f.brk, () => { f.brk = !f.brk; }); chip('variant', f.variant, () => { f.variant = !f.variant; });
    box.append(U.el('span', { class: 'sep' }));
    for (const v of ['rated', 'unrated', 'skipped']) chip(v, f.rated === v, () => { f.rated = f.rated === v ? '' : v; });
    const acts = Array.from(new Set(this.lib.loops.map(l => (ctx.rec(l) || {}).act).filter(Boolean))).sort(); if (acts.length) { box.append(U.el('span', { class: 'sep' })); for (const a of acts) chip('act ' + a, f.act.has(a), () => toggleSet(f.act, a)); }
    const secSel = this.$('lbFilterSection'); const secs = Ranking.sections(ctx); secSel.innerHTML = ''; secSel.append(U.el('option', { value: '', text: 'section: all' })); for (const s of secs) secSel.append(U.el('option', { value: s, text: (f.section.has(s) ? '✓ ' : '') + s }));
    const useSel = this.$('lbFilterUse'); const uses = Array.from(new Set(this.lib.loops.map(l => (ctx.rec(l) || {}).use).filter(Boolean))).sort(); useSel.innerHTML = ''; useSel.append(U.el('option', { value: '', text: 'use: all' })); for (const u of uses) useSel.append(U.el('option', { value: u, text: (f.use.has(u) ? '✓ ' : '') + u }));
    this.$('lbClaudeMinWrap').hidden = this.reveal === 'hidden';
    if (f.barRange) chip(`bars ${f.barRange[0]}–${f.barRange[1]} ✕`, true, () => { f.barRange = null; this.strip.selectedRange = null; this.strip.draw(); });
  },
  bindSortUi() {
    this.$('lbSortKey').addEventListener('change', (e) => { this.sort.key = e.target.value; this.sort.dir = null; if (this.sort.key === 'random') this.randomSeed = this.$('lbSeed').value || this.randomSeed; this.renderSortUi(); this.renderTable(); });
    this.$('lbSortDir').addEventListener('click', () => { this.sort.dir = -(this.sort.dir || Ranking.keyByName(this.sort.key).dir); this.renderSortUi(); this.renderTable(); });
    this.$('lbSortSecondary').addEventListener('change', (e) => { this.sort.secondary = e.target.value || null; this.renderTable(); });
    this.$('lbUnratedFirst').addEventListener('change', (e) => { this.sort.unratedFirst = e.target.checked; this.renderTable(); });
    this.$('lbGroup').addEventListener('change', (e) => { this.groupBySection = e.target.checked; this.renderTable(); });
    this.$('lbSeed').addEventListener('change', (e) => { this.randomSeed = e.target.value.trim() || this.randomSeed; e.target.value = this.randomSeed; this.renderTable(); });
    this.$('lbFilterSection').addEventListener('change', (e) => { const v = e.target.value; if (v) { if (this.filters.section.has(v)) this.filters.section.delete(v); else this.filters.section.add(v); } else this.filters.section.clear(); this.renderFilterChips(); this.renderTable(); });
    this.$('lbFilterUse').addEventListener('change', (e) => { const v = e.target.value; if (v) { if (this.filters.use.has(v)) this.filters.use.delete(v); else this.filters.use.add(v); } else this.filters.use.clear(); this.renderFilterChips(); this.renderTable(); });
    this.$('lbRatingMin').addEventListener('change', (e) => { const v = parseFloat(e.target.value); this.filters.ratingMin = isFinite(v) ? v : null; this.renderTable(); });
    this.$('lbClaudeMin').addEventListener('change', (e) => { const v = parseFloat(e.target.value); this.filters.claudeMin = isFinite(v) ? v : null; this.renderTable(); });
    this.$('lbClearFilters').addEventListener('click', () => { this.filters = Ranking.emptyFilters(); this.filter = ''; this.$('lbFilter').value = ''; this.$('lbRatingMin').value = ''; this.$('lbClaudeMin').value = ''; this.strip.selectedRange = null; this.renderFilterChips(); this.renderTable(); });
  },
  /* ---------- compare ---------- */
  renderCompare() {
    const box = this.$('lbTab-compare'); if (!box) return;
    if (this.reveal === 'hidden') { box.innerHTML = '<p class="muted">Hidden. Set Reveal to "After I rate" or "All" to compare your ratings with the imported notes. The waveform marks stay.</p>'; return; }
    const st = Compare.stats(this.lib.loops.filter(l => this.isRevealed(l)), this.ctx()); this.lastCompare = st;
    box.innerHTML = Compare.html(st, this); const c = this.$('cmpScatter'); if (c) { Compare.drawScatter(c, st, this); c.addEventListener('mousemove', (e) => { const r = c.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top; const p = (c._points || []).find(q => Math.abs(q.x - x) < 6 && Math.abs(q.y - y) < 6); c.title = p ? `${p.p.id}: mine ${p.p.mine} · imported ${p.own ? p.p.own + ' (own pattern)' : p.p.claude}` : ''; }); c.addEventListener('click', (e) => { const r = c.getBoundingClientRect(); const x = e.clientX - r.left, y = e.clientY - r.top; const p = (c._points || []).find(q => Math.abs(q.x - x) < 6 && Math.abs(q.y - y) < 6); if (p) this.select(p.p.id); }); }
  },
  /* ---------- ratings export / import ---------- */
  async exportRatings() {
    if (!this.lib.loops.length) { this.toast('Nothing to export.', { error: true }); return; }
    const include = this.$('lbIncludeCmp').checked && this.reveal !== 'hidden';
    const comparison = include ? Compare.stats(this.lib.loops.filter(l => this.isRevealed(l)), this.ctx()) : null;
    const ex = this.library.buildRatingsExport({ includeComparison: include, comparison: comparison ? Object.assign({ claudeLayer: (this.claudeLayer() || {}).name || IMPORTED_LAYER_NAME }, comparison) : null });
    const base = `${(ex.library || 'session').replace(/[\/\\:]/g, '_')}.ratings`;
    let where = [];
    if (this.library.endpoint && this.library.current) { try { await this.library.putJson(base + '.json', ex); await fetch(this.library.libUrl(base + '.csv'), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ _note: 'csv twin is written by the download; server stores json only' }) }).catch(() => { }); where.push('library folder'); } catch (e) { console.warn(e); } }
    const r1 = await this.persist.exportText(JSON.stringify(ex, null, 2) + '\n', base + '.json', 'application/json', '.json', 'My ratings (JSON)'); if (r1) where.push(r1.name);
    const r2 = await this.persist.exportText(LibraryLoader.ratingsCsv(ex), base + '.csv', 'text/csv', '.csv', 'My ratings (CSV)'); if (r2) where.push(r2.name);
    this.lastRatingsExport = ex;
    this.toast(`Exported ${ex.ratings.length} rating(s)${ex.comparison ? ' with comparison' : ''} → ${where.join(', ') || 'cancelled'}`, { ms: 6000 });
    return ex;
  },
  async importRatingsText(text, name) {
    let json; try { json = JSON.parse(text); } catch (e) { await this.app.errorList('Ratings refused', `${name} is not valid JSON:`, [e.message]); return false; }
    const r = this.library.importRatings(json);
    if (r.errors.length) { await this.app.errorList('Ratings refused', `${name} does not match $defs/ratingsExport:`, r.errors); return false; }
    this.markDirty(); this.renderAll(); this.drawAll();
    this.toast(`Restored ${r.restored.length} rating(s)${r.missing.length ? `; not in this library: ${r.missing.join(', ')}` : ''}`, { ms: 6000 }); return true;
  },
});

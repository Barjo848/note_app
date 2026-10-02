/* waveform.js — WaveformView: the SoundCloud part.
 *
 * Three canvases: overview (whole file + viewport box), ruler (time row and
 * bar row) and main (pin lane, waveform, interval lanes, analysis chart).
 * The view is described by viewStart (first visible sample, float) and spp
 * (samples per CSS pixel). Everything on the main canvas is positioned via
 * xOfSample()/sampleAtX(), so alignment between ruler, grid, notes and the
 * playhead is exact at any zoom.
 *
 * Rendering cost is kept flat by caching the grey and accent waveform images
 * for the current viewport in offscreen canvases; per frame we only composite
 * them (clipped at the playhead) and draw the thin overlays. */
'use strict';

class WaveformView {
  constructor({ overview, ruler, main, container }) {
    this.cv = { overview, ruler, main };
    this.container = container;
    this.ctx = { overview: overview.getContext('2d'), ruler: ruler.getContext('2d'), main: main.getContext('2d') };
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.info = null; this.peaks = null; this.grid = null;
    this.totalFrames = 0; this.sampleRate = 48000;
    this.viewStart = 0; this.spp = 1;
    this.playheadSample = 0; this.hoverX = null;
    this.selection = null;                 // {start, end} samples
    this.selectedNoteId = null;
    this.loopRegion = null;                // {start, end} samples when looping
    this.mode = 'split';                   // 'split' | 'mono'
    this.showGrid = true; this.showAnalysis = false;
    this.notes = []; this.noteColorFn = () => '#3fb0ff'; this.layerColorFn = () => '#888';
    this.analysisRows = null;              // [{t0,t1,rmsDb,lowDb,midDb,highDb}]
    this.hitRegions = [];
    this.layout = { pinLane: 22, laneH: 18, minLanes: 1, analysisH: 84 };
    this.colors = { accent: '#3fb0ff', unplayed: '#6b7280', bg: '#0f1115', grid: 'rgba(255,255,255,0.08)', bar: 'rgba(255,255,255,0.18)', text: '#c9d1d9', playhead: '#ffffff', selection: 'rgba(63,176,255,0.22)', loop: 'rgba(255,176,63,0.18)' };
    this.handlers = {};
    this._cache = { key: null, grey: null, accent: null };
    this._rafPending = false;
    this._resize();
    this._bind();
    if (typeof ResizeObserver !== 'undefined') { this._ro = new ResizeObserver(() => { this._resize(); this._invalidate(); this.requestDraw(); }); this._ro.observe(container); }
    window.addEventListener('resize', () => { this._resize(); this._invalidate(); this.requestDraw(); });
  }

  on(name, fn) { this.handlers[name] = fn; return this; }
  _emit(name, ...args) { const h = this.handlers[name]; return h ? h(...args) : undefined; }

  /* ---------- geometry ---------- */
  _resize() {
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    for (const k of Object.keys(this.cv)) {
      const c = this.cv[k]; const r = c.getBoundingClientRect();
      const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
      if (c.width !== Math.round(w * this.dpr) || c.height !== Math.round(h * this.dpr)) { c.width = Math.round(w * this.dpr); c.height = Math.round(h * this.dpr); }
      c._cssW = w; c._cssH = h;
    }
    if (this.totalFrames) this._clampView();
  }
  get width() { return this.cv.main._cssW || 10; }
  get height() { return this.cv.main._cssH || 10; }
  get lanesCount() { return Math.max(this.layout.minLanes, this._laneInfo ? this._laneInfo.count : 0); }
  /** vertical regions of the main canvas */
  regions() {
    const H = this.height, L = this.layout;
    const lanesH = this.lanesCount * L.laneH + 4;
    const anaH = this.showAnalysis ? L.analysisH : 0;
    const waveTop = L.pinLane, waveBottom = Math.max(waveTop + 40, H - lanesH - anaH);
    return { pin: [0, waveTop], wave: [waveTop, waveBottom], lanes: [waveBottom + 2, waveBottom + lanesH], analysis: [H - anaH, H] };
  }
  xOfSample(s) { return (s - this.viewStart) / this.spp; }
  sampleAtX(x) { return this.viewStart + x * this.spp; }
  xOfSec(sec) { return this.xOfSample(sec * this.sampleRate); }
  secAtX(x) { return this.sampleAtX(x) / this.sampleRate; }
  get viewEnd() { return this.viewStart + this.width * this.spp; }
  get minSpp() { return Math.max(1, (this.sampleRate * 0.5) / this.width); } // 0.5 s across the view at most zoom
  get maxSpp() { return Math.max(this.minSpp, this.totalFrames / this.width); }

  /* ---------- track ---------- */
  setTrack(info, peakStore) {
    this.info = info; this.peaks = peakStore;
    this.totalFrames = info ? info.totalFrames : 0; this.sampleRate = info ? info.sampleRate : 48000;
    this.selection = null; this.loopRegion = null; this.playheadSample = 0;
    this._invalidate(); this.fit(); this.requestDraw();
  }
  setPeaks(peakStore) { this.peaks = peakStore; this._invalidate(); this.requestDraw(); }
  setGrid(grid) { this.grid = grid; this._invalidate(); this.requestDraw(); }
  setNotes(notes, noteColorFn, layerColorFn) {
    this.notes = notes; this.noteColorFn = noteColorFn; this.layerColorFn = layerColorFn;
    const ivls = notes.filter(n => n.type === 'interval' && n.end);
    this._laneInfo = NoteStore.packLanes(ivls);
    this._invalidate(); this.requestDraw();
  }
  setAnalysis(rows) { this.analysisRows = rows; this.requestDraw(); }
  setMode(m) { this.mode = m; this._invalidate(); this.requestDraw(); }
  setPlayhead(sec) { const s = sec * this.sampleRate; if (s !== this.playheadSample) { this.playheadSample = s; this.requestDraw(); } }
  setSelection(sel) { this.selection = sel; this.requestDraw(); }
  setSelectedNote(id) { this.selectedNoteId = id; this.requestDraw(); }

  /* ---------- zoom / pan ---------- */
  _clampView() {
    this.spp = U.clamp(this.spp, this.minSpp, this.maxSpp);
    const span = this.width * this.spp;
    this.viewStart = U.clamp(this.viewStart, 0, Math.max(0, this.totalFrames - span));
  }
  fit() { if (!this.totalFrames) return; this.spp = this.maxSpp; this.viewStart = 0; this._invalidate(); this.requestDraw(); }
  zoomBy(factor, anchorX = this.width / 2) {
    if (!this.totalFrames) return;
    const anchorSample = this.sampleAtX(anchorX);
    this.spp = U.clamp(this.spp * factor, this.minSpp, this.maxSpp);
    this.viewStart = anchorSample - anchorX * this.spp;
    this._clampView(); this._invalidate(); this.requestDraw();
  }
  zoomToSeconds(seconds, centerSample) {
    this.spp = U.clamp(seconds * this.sampleRate / this.width, this.minSpp, this.maxSpp);
    this.centerOn(centerSample);
  }
  panBy(px) { this.viewStart += px * this.spp; this._clampView(); this._invalidate(); this.requestDraw(); }
  centerOn(sample) { this.viewStart = sample - (this.width * this.spp) / 2; this._clampView(); this._invalidate(); this.requestDraw(); }
  /** page-flip so `sample` is visible; returns true if the view moved */
  ensureVisible(sample, margin = 0.1) {
    const x = this.xOfSample(sample);
    if (x >= 0 && x <= this.width) return false;
    this.viewStart = sample - this.width * this.spp * (x < 0 ? (1 - margin) : margin);
    this._clampView(); this._invalidate(); this.requestDraw();
    return true;
  }
  showRange(startSample, endSample, pad = 0.15) {
    const span = Math.max(1, endSample - startSample);
    this.spp = U.clamp((span * (1 + 2 * pad)) / this.width, this.minSpp, this.maxSpp);
    this.viewStart = startSample - span * pad; this._clampView(); this._invalidate(); this.requestDraw();
  }

  /* ---------- drawing ---------- */
  _invalidate() { this._cache.key = null; }
  requestDraw() {
    if (this._rafPending) return; this._rafPending = true;
    requestAnimationFrame(() => { this._rafPending = false; this.draw(); });
  }
  draw() {
    this._drawOverview(); this._drawRuler(); this._drawMain();
    this._emit('drawn');
  }

  _setup(ctx, w, h) { ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.clearRect(0, 0, w, h); }

  _drawOverview() {
    const c = this.cv.overview, ctx = this.ctx.overview, w = c._cssW, h = c._cssH;
    this._setup(ctx, w, h);
    ctx.fillStyle = this.colors.bg; ctx.fillRect(0, 0, w, h);
    if (!this.totalFrames) return;
    const spp = this.totalFrames / w;
    if (this.peaks && this.peaks.ready) {
      const env = new Float32Array(w * 2);
      this.peaks.envelope(env, w, 0, spp, 'mono');
      const playedX = this.playheadSample / spp;
      const mid = h / 2, amp = (h / 2) * 0.92;
      for (let x = 0; x < w; x++) {
        const mn = env[2 * x], mx = env[2 * x + 1];
        ctx.fillStyle = x < playedX ? this.colors.accent : this.colors.unplayed;
        const y0 = mid - mx * amp, y1 = mid - mn * amp;
        ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
      }
    }
    // notes as ticks
    for (const n of this.notes) {
      const x0 = n.start.samples / spp; const col = this.noteColorFn(n);
      ctx.fillStyle = U.rgba(col, 0.8);
      if (n.type === 'interval' && n.end) ctx.fillRect(x0, h - 4, Math.max(2, (n.end.samples - n.start.samples) / spp), 3);
      else ctx.fillRect(x0 - 1, 0, 2, 5);
    }
    // viewport box
    const vx0 = this.viewStart / spp, vx1 = this.viewEnd / spp;
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(vx0, 0, Math.max(2, vx1 - vx0), h);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1; ctx.strokeRect(Math.round(vx0) + 0.5, 0.5, Math.max(2, Math.round(vx1 - vx0)) - 1, h - 1);
    // playhead
    ctx.fillStyle = this.colors.playhead; ctx.fillRect(Math.round(this.playheadSample / spp), 0, 1, h);
    this._ovSpp = spp;
  }

  _timeStep() {
    const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
    const secPerPx = this.spp / this.sampleRate;
    for (const s of steps) if (s / secPerPx >= 90) return s;
    return 1200;
  }
  _drawRuler() {
    const c = this.cv.ruler, ctx = this.ctx.ruler, w = c._cssW, h = c._cssH;
    this._setup(ctx, w, h);
    ctx.fillStyle = '#151922'; ctx.fillRect(0, 0, w, h);
    if (!this.totalFrames) return;
    const rowH = this.grid && this.grid.valid ? h / 2 : h;
    ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.textBaseline = 'top'; ctx.fillStyle = this.colors.text;
    // time row
    const step = this._timeStep(), t0 = this.secAtX(0), t1 = this.secAtX(w);
    const minor = step / (step >= 60 ? 4 : step >= 1 ? 2 : 2);
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      if (t < 0) continue;
      const x = Math.round(this.xOfSec(t)) + 0.5;
      const major = Math.abs(t / step - Math.round(t / step)) < 1e-6;
      ctx.strokeStyle = major ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)';
      ctx.beginPath(); ctx.moveTo(x, rowH); ctx.lineTo(x, rowH - (major ? 8 : 4)); ctx.stroke();
      if (major) ctx.fillText(step < 1 ? U.fmtTime(t) : U.fmtTime(t, false), x + 3, 2);
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.beginPath(); ctx.moveTo(0, rowH - 0.5); ctx.lineTo(w, rowH - 0.5); ctx.stroke();
    // bar row
    if (this.grid && this.grid.valid) {
      const g = this.grid;
      const beatPx = g.beatSeconds / (this.spp / this.sampleRate), barPx = beatPx * g.num;
      const showBeats = beatPx >= 10;
      const labelEvery = barPx >= 34 ? 1 : barPx >= 17 ? 2 : barPx >= 9 ? 4 : barPx >= 4.5 ? 8 : 16;
      const lines = g.lines(t0, t1, showBeats, 6000);
      ctx.fillStyle = '#ffd27a';
      for (const ln of lines) {
        const x = Math.round(this.xOfSec(ln.sec)) + 0.5;
        if (ln.isBar) {
          const labelled = (ln.bar - 1) % labelEvery === 0 || labelEvery === 1;
          if (!labelled && barPx < 4) continue;               // too dense: keep only the labelled bars' ticks
          ctx.strokeStyle = labelled ? 'rgba(255,210,122,0.7)' : 'rgba(255,210,122,0.35)'; ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x, labelled ? rowH + 4 : h - 5); ctx.stroke();
          if (labelled) ctx.fillText(String(ln.bar), x + 3, rowH + 3);
        } else if (showBeats) {
          ctx.strokeStyle = 'rgba(255,210,122,0.3)'; ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x, h - 4); ctx.stroke();
          if (beatPx >= 40) { ctx.fillStyle = 'rgba(255,210,122,0.6)'; ctx.fillText(`${ln.bar}.${ln.beat}`, x + 3, rowH + 3); ctx.fillStyle = '#ffd27a'; }
        }
      }
    }
  }

  /** Render the waveform envelope for the current view into the cache canvases (grey + accent). */
  _ensureWaveCache() {
    const R = this.regions(); const [top, bottom] = R.wave; const h = bottom - top;
    const key = [this.viewStart, this.spp, this.width, h, this.mode, this.dpr, this.peaks && this.peaks.ready ? 1 : 0].join(',');
    if (this._cache.key === key) return;
    const w = this.width;
    const mk = () => { const c = document.createElement('canvas'); c.width = Math.round(w * this.dpr); c.height = Math.round(h * this.dpr); return c; };
    const grey = this._cache.grey && this._cache.grey.width === Math.round(w * this.dpr) && this._cache.grey.height === Math.round(h * this.dpr) ? this._cache.grey : mk();
    const accent = this._cache.accent && this._cache.accent.width === grey.width && this._cache.accent.height === grey.height ? this._cache.accent : mk();
    for (const [canvas, color] of [[grey, this.colors.unplayed], [accent, this.colors.accent]]) {
      const ctx = canvas.getContext('2d'); ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); ctx.clearRect(0, 0, w, h);
      if (!(this.peaks && this.peaks.ready)) continue;
      ctx.fillStyle = color;
      const chans = this.mode === 'split' ? this.peaks.channels : 1;
      const env = new Float32Array(w * 2);
      for (let ch = 0; ch < chans; ch++) {
        const laneTop = (h / chans) * ch, laneH = h / chans, mid = laneTop + laneH / 2, amp = (laneH / 2) * 0.95;
        this.peaks.envelope(env, w, this.viewStart, this.spp, this.mode === 'split' ? ch : 'mono');
        for (let x = 0; x < w; x++) {
          const mn = env[2 * x], mx = env[2 * x + 1];
          const y0 = mid - mx * amp, y1 = mid - mn * amp;
          ctx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
        }
        // centre line
        ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(0, Math.round(mid), w, 1); ctx.fillStyle = color;
      }
    }
    this._cache = { key, grey, accent };
  }

  _drawMain() {
    const ctx = this.ctx.main, w = this.width, H = this.height;
    this._setup(ctx, w, H);
    ctx.fillStyle = this.colors.bg; ctx.fillRect(0, 0, w, H);
    this.hitRegions = [];
    if (!this.totalFrames) {
      ctx.fillStyle = '#5c6470'; ctx.font = '14px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(this.emptyMessage || 'Open a WAV file (button, ⌘O, or drop it here)', w / 2, H / 2); ctx.textAlign = 'left';
      return;
    }
    const R = this.regions(); const [wTop, wBottom] = R.wave; const wH = wBottom - wTop;
    const t0 = this.secAtX(0), t1 = this.secAtX(w);
    // grid lines
    if (this.showGrid && this.grid && this.grid.valid && this.grid.barSeconds / (this.spp / this.sampleRate) >= 6) {
      const beatPx = this.grid.beatSeconds / (this.spp / this.sampleRate);
      for (const ln of this.grid.lines(t0, t1, beatPx >= 8, 6000)) {
        const x = Math.round(this.xOfSec(ln.sec)) + 0.5;
        ctx.strokeStyle = ln.isBar ? this.colors.bar : this.colors.grid; ctx.beginPath(); ctx.moveTo(x, wTop); ctx.lineTo(x, R.lanes[1]); ctx.stroke();
      }
    }
    // waveform (cached)
    this._ensureWaveCache();
    const px = this.xOfSample(this.playheadSample);
    ctx.drawImage(this._cache.grey, 0, wTop, w, wH);
    if (px > 0) { ctx.save(); ctx.beginPath(); ctx.rect(0, wTop, Math.min(w, px), wH); ctx.clip(); ctx.drawImage(this._cache.accent, 0, wTop, w, wH); ctx.restore(); }
    // loop region and selection
    if (this.loopRegion) { const x0 = this.xOfSample(this.loopRegion.start), x1 = this.xOfSample(this.loopRegion.end); ctx.fillStyle = this.colors.loop; ctx.fillRect(x0, wTop, x1 - x0, wH); }
    if (this.selection) {
      const x0 = this.xOfSample(this.selection.start), x1 = this.xOfSample(this.selection.end);
      ctx.fillStyle = this.colors.selection; ctx.fillRect(x0, wTop, x1 - x0, wH);
      ctx.strokeStyle = 'rgba(63,176,255,0.9)'; ctx.beginPath(); ctx.moveTo(Math.round(x0) + 0.5, wTop); ctx.lineTo(Math.round(x0) + 0.5, wBottom); ctx.moveTo(Math.round(x1) + 0.5, wTop); ctx.lineTo(Math.round(x1) + 0.5, wBottom); ctx.stroke();
    }
    // notes
    this._drawNotes(ctx, R);
    // analysis overlay
    if (this.showAnalysis) this._drawAnalysis(ctx, R.analysis, t0, t1);
    // playhead
    if (px >= 0 && px <= w) { ctx.fillStyle = this.colors.playhead; ctx.fillRect(Math.round(px), 0, 1, R.lanes[1]); ctx.beginPath(); ctx.moveTo(px - 5, 0); ctx.lineTo(px + 5, 0); ctx.lineTo(px, 6); ctx.closePath(); ctx.fill(); }
    // hover cursor
    if (this.hoverX !== null && !this._drag) {
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(Math.round(this.hoverX), wTop, 1, wH);
      const sec = this.secAtX(this.hoverX);
      const label = U.fmtTime(sec) + (this.grid && this.grid.valid ? '  ' + this.grid.fmtBBT(sec) : '');
      ctx.font = '11px ui-monospace, Menlo, monospace';
      const tw = ctx.measureText(label).width + 8; const lx = this.hoverX + 8 + tw > w ? this.hoverX - tw - 8 : this.hoverX + 8;
      ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(lx, wTop + 4, tw, 16); ctx.fillStyle = '#fff'; ctx.textBaseline = 'top'; ctx.fillText(label, lx + 4, wTop + 6);
    }
    // frame lines
    ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(0, wTop, w, 1); ctx.fillRect(0, wBottom, w, 1);
  }

  _drawNotes(ctx, R) {
    const w = this.width; const [wTop, wBottom] = R.wave; const wH = wBottom - wTop;
    const laneTop = R.lanes[0], laneH = this.layout.laneH;
    ctx.font = '11px system-ui, -apple-system, sans-serif'; ctx.textBaseline = 'middle';
    const dimFor = (n) => n.status === 'open' ? 1 : 0.45;
    // interval bands first (under pins)
    for (const n of this.notes) {
      if (n.type !== 'interval' || !n.end) continue;
      const x0 = this.xOfSample(n.start.samples), x1 = this.xOfSample(n.end.samples);
      if (x1 < 0 || x0 > w) continue;
      const col = this.noteColorFn(n), sel = n.id === this.selectedNoteId, dim = dimFor(n);
      ctx.fillStyle = U.rgba(col, 0.13 * dim); ctx.fillRect(x0, wTop, x1 - x0, wH);
      const lane = this._laneInfo ? (this._laneInfo.lanes.get(n.id) || 0) : 0;
      const y = laneTop + lane * laneH + 1, hgt = laneH - 3;
      const bx0 = Math.max(-1, x0), bx1 = Math.min(w + 1, x1);
      ctx.fillStyle = U.rgba(col, 0.55 * dim); ctx.fillRect(bx0, y, Math.max(2, bx1 - bx0), hgt);
      ctx.strokeStyle = sel ? '#fff' : U.rgba(this.layerColorFn(n), 0.9); ctx.lineWidth = sel ? 2 : 1;
      ctx.strokeRect(Math.round(bx0) + 0.5, Math.round(y) + 0.5, Math.max(2, Math.round(bx1 - bx0)) - 1, hgt - 1);
      const label = this._trunc(ctx, (n.status === 'done' ? '✓ ' : '') + (n.title || '(untitled)'), Math.max(0, bx1 - bx0 - 10));
      if (label) { ctx.fillStyle = '#fff'; ctx.fillText(label, Math.max(4, bx0 + 4), y + hgt / 2); }
      // hit order: later entries win, so the edge handles go after the body
      this.hitRegions.push({ kind: 'ivl-band', id: n.id, x0, x1, y0: wTop, y1: wBottom, weak: true });
      this.hitRegions.push({ kind: 'ivl-body', id: n.id, x0, x1, y0: y, y1: y + hgt });
      this.hitRegions.push({ kind: 'ivl-left', id: n.id, x0: x0 - 5, x1: x0 + 5, y0: y, y1: y + hgt });
      this.hitRegions.push({ kind: 'ivl-right', id: n.id, x0: x1 - 5, x1: x1 + 5, y0: y, y1: y + hgt });
    }
    // pins
    const pinH = this.layout.pinLane;
    let lastRight = -Infinity, row = 0;
    for (const n of this.notes) {
      if (n.type !== 'pin') continue;
      const x = this.xOfSample(n.start.samples);
      if (x < -150 || x > w + 10) continue;
      const col = this.noteColorFn(n), sel = n.id === this.selectedNoteId, dim = dimFor(n);
      ctx.fillStyle = U.rgba(col, 0.6 * dim); ctx.fillRect(Math.round(x), wTop, 1, wH);
      const label = this._trunc(ctx, (n.status === 'done' ? '✓ ' : '') + (n.title || '•'), 110);
      const tw = ctx.measureText(label).width + 10;
      // simple overlap avoidance: alternate two rows when flags collide
      row = (x < lastRight) ? (row ^ 1) : 0; lastRight = x + tw + 2;
      const fy = row === 0 ? 2 : 2, fh = pinH - 4;
      ctx.fillStyle = U.rgba(col, (row === 0 ? 0.95 : 0.75) * dim);
      ctx.beginPath(); ctx.moveTo(x, fy + fh); ctx.lineTo(x, fy); ctx.lineTo(x + tw, fy); ctx.lineTo(x + tw + 5, fy + fh / 2); ctx.lineTo(x + tw, fy + fh); ctx.closePath(); ctx.fill();
      if (sel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
      ctx.fillStyle = U.textOn(col); ctx.fillText(label, x + 5, fy + fh / 2);
      this.hitRegions.push({ kind: 'pin', id: n.id, x0: x - 3, x1: x + tw + 5, y0: fy, y1: fy + fh });
      this.hitRegions.push({ kind: 'pin-line', id: n.id, x0: x - 3, x1: x + 3, y0: wTop, y1: wBottom, weak: true });
    }
    ctx.lineWidth = 1;
  }
  _trunc(ctx, text, maxW) {
    if (maxW <= 12) return '';
    if (ctx.measureText(text).width <= maxW) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(text.slice(0, m) + '…').width <= maxW) lo = m; else hi = m - 1; }
    return lo === 0 ? '' : text.slice(0, lo) + '…';
  }

  _drawAnalysis(ctx, [top, bottom], t0, t1) {
    const w = this.width, h = bottom - top;
    ctx.fillStyle = '#0b0d11'; ctx.fillRect(0, top, w, h);
    ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(0, top, w, 1);
    const rows = this.analysisRows; if (!rows || !rows.length) { ctx.fillStyle = '#5c6470'; ctx.font = '11px system-ui'; ctx.textBaseline = 'top'; ctx.fillText('Analysis not available yet', 6, top + 6); return; }
    const dbMin = -60, dbMax = 0, yOf = (db) => top + 4 + (1 - (U.clamp(db, dbMin, dbMax) - dbMin) / (dbMax - dbMin)) * (h - 8);
    const series = [['rmsDb', '#ffffff', 1.5], ['lowDb', '#ff7a59', 1], ['midDb', '#8ee66b', 1], ['highDb', '#7c9cff', 1]];
    for (const [key, color, lw] of series) {
      ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath(); let started = false;
      for (const r of rows) {
        if (r.t1 < t0 || r.t0 > t1) continue;
        const x0 = this.xOfSec(r.t0), x1 = this.xOfSec(r.t1), y = yOf(r[key]);
        if (!started) { ctx.moveTo(x0, y); started = true; } else ctx.lineTo(x0, y);
        ctx.lineTo(x1, y);
      }
      ctx.stroke();
    }
    ctx.font = '10px ui-monospace, Menlo, monospace'; ctx.textBaseline = 'top';
    let lx = 6; for (const [key, color] of [['RMS', '#fff'], ['low', '#ff7a59'], ['mid', '#8ee66b'], ['high', '#7c9cff']]) { ctx.fillStyle = color; ctx.fillText(key, lx, top + 4); lx += ctx.measureText(key).width + 10; }
    ctx.fillStyle = '#5c6470'; ctx.fillText('0 dB', w - 34, top + 4); ctx.fillText('-60', w - 26, bottom - 12);
    ctx.lineWidth = 1;
  }

  /* ---------- hit testing ---------- */
  hitAt(x, y) {
    let weak = null;
    for (let i = this.hitRegions.length - 1; i >= 0; i--) {
      const r = this.hitRegions[i];
      if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) { if (r.weak) { if (!weak) weak = r; } else return r; }
    }
    return weak;
  }

  /* ---------- input ---------- */
  _bind() {
    const main = this.cv.main, ov = this.cv.overview;
    const pos = (ev, c) => { const r = c.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };

    main.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      if (!this.totalFrames) return;
      const { x } = pos(ev, main);
      if (ev.ctrlKey || ev.metaKey || (Math.abs(ev.deltaY) > Math.abs(ev.deltaX))) {
        const f = Math.exp(U.clamp(ev.deltaY, -100, 100) * (ev.ctrlKey ? 0.01 : 0.002));
        this.zoomBy(f, x);
      } else this.panBy(ev.deltaX);
    }, { passive: false });
    main.addEventListener('mousemove', (ev) => {
      const p = pos(ev, main); this.hoverX = p.x; this._hoverY = p.y;
      if (!this._drag) { const hit = this.hitAt(p.x, p.y); this._emit('hover', hit, p, this.secAtX(p.x)); main.style.cursor = hit ? (hit.kind === 'ivl-left' || hit.kind === 'ivl-right' ? 'ew-resize' : hit.weak ? 'default' : 'grab') : 'default'; }
      this.requestDraw();
    });
    main.addEventListener('mouseleave', () => { this.hoverX = null; this._emit('hover', null); this.requestDraw(); });
    main.addEventListener('dblclick', (ev) => { if (!this.totalFrames) return; const p = pos(ev, main); const hit = this.hitAt(p.x, p.y); if (hit && !hit.weak) this._emit('noteDouble', hit.id); else this._emit('createPin', this.secAtX(p.x)); });
    main.addEventListener('mousedown', (ev) => {
      if (!this.totalFrames || ev.button !== 0) return;
      const p = pos(ev, main); const startSample = this.sampleAtX(p.x);
      const hit = this.hitAt(p.x, p.y);
      let drag;
      if (hit && !hit.weak && !ev.shiftKey) {
        const n = this.notes.find(q => q.id === hit.id);
        drag = { kind: 'note', hit, note: n, origStart: n.start.samples, origEnd: n.end ? n.end.samples : null, x0: p.x, moved: false };
        this._emit('noteClick', hit.id);
      } else if (ev.shiftKey || ev.altKey && false) {
        drag = { kind: 'select', anchor: startSample, x0: p.x, moved: false };
      } else drag = { kind: 'pan', x0: p.x, viewStart0: this.viewStart, moved: false, hitId: hit ? hit.id : null };
      this._drag = drag;
      const move = (e) => {
        const q = pos(e, main);
        if (!drag.moved && Math.abs(q.x - drag.x0) < 4) return;
        if (!drag.moved) { drag.moved = true; if (drag.kind === 'note') this._emit('noteDragStart', drag.note.id); main.style.cursor = drag.kind === 'pan' ? 'grabbing' : main.style.cursor; }
        const dx = q.x - drag.x0, dS = dx * this.spp;
        if (drag.kind === 'pan') { this.viewStart = drag.viewStart0 - dS; this._clampView(); this._invalidate(); this.requestDraw(); }
        else if (drag.kind === 'select') {
          const cur = U.clamp(this.sampleAtX(q.x), 0, this.totalFrames);
          const a = Math.min(drag.anchor, cur), b = Math.max(drag.anchor, cur);
          this._emit('selectionChange', { start: a, end: b }, true);
        } else if (drag.kind === 'note') {
          const k = drag.hit.kind; let s = drag.origStart, e = drag.origEnd;
          if (k === 'pin' || k === 'ivl-body') { s = drag.origStart + dS; if (e !== null) e = drag.origEnd + dS; }
          else if (k === 'ivl-left') s = drag.origStart + dS;
          else if (k === 'ivl-right') e = drag.origEnd + dS;
          this._emit('noteDrag', drag.note.id, s, e, k);
        }
      };
      const up = (e) => {
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
        this._drag = null; main.style.cursor = 'default';
        if (!drag.moved) {
          if (drag.kind === 'select') this._emit('selectionChange', null, false);
          if (drag.kind !== 'note') this._emit('seek', startSample / this.sampleRate, ev);
        } else if (drag.kind === 'note') this._emit('noteDragEnd', drag.note.id);
        else if (drag.kind === 'select') this._emit('selectionChange', this.selection, false);
        this.requestDraw();
      };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });

    // overview: click seeks; drag inside the viewport box pans it
    ov.addEventListener('mousedown', (ev) => {
      if (!this.totalFrames || ev.button !== 0) return;
      const p = pos(ev, ov); const spp = this._ovSpp || (this.totalFrames / ov._cssW);
      const vx0 = this.viewStart / spp, vx1 = this.viewEnd / spp;
      const inside = p.x >= vx0 && p.x <= vx1 && this.spp < this.maxSpp;
      const drag = { x0: p.x, view0: this.viewStart, moved: false };
      const move = (e) => { const q = pos(e, ov); if (!drag.moved && Math.abs(q.x - drag.x0) < 3) return; drag.moved = true; if (inside) { this.viewStart = drag.view0 + (q.x - drag.x0) * spp; this._clampView(); this._invalidate(); this.requestDraw(); } };
      const up = (e) => {
        window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up);
        if (!drag.moved) { const s = U.clamp(p.x * spp, 0, this.totalFrames); this._emit('seek', s / this.sampleRate, ev); if (!inside) this.centerOn(s); }
      };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    ov.addEventListener('wheel', (ev) => { ev.preventDefault(); }, { passive: false });
    this.cv.ruler.addEventListener('wheel', (ev) => { ev.preventDefault(); const { x } = pos(ev, this.cv.ruler); this.zoomBy(Math.exp(U.clamp(ev.deltaY, -100, 100) * 0.002), x); }, { passive: false });
    this.cv.ruler.addEventListener('mousedown', (ev) => { if (this.totalFrames) this._emit('seek', this.secAtX(pos(ev, this.cv.ruler).x), ev); });
  }
}

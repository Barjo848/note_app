/* sequenceview.js — SequenceView: the arrangement lane. A ruler (arrangement
 * bars, beat ticks, markers, optional Pro Tools source bars), a lane of
 * blocks drawn end to end at their real lengths, seam badges, the playhead,
 * and a mapping line. Zoom/scroll keep the ruler visible; blocks are
 * selected, dragged to reorder, dragged out to remove, and dropped onto from
 * the library (HTML5 drag-and-drop). All edits go through SequenceStore so
 * undo/redo covers them. */
'use strict';

class SequenceView {
  constructor(lab, { ruler, lane, mapping, container }) {
    this.lab = lab; this.cv = { ruler, lane, mapping }; this.container = container;
    this.pxPerBar = 40; this.scroll = 0; this.arrId = null; this.selectedBlockId = null; this.selectedSeamIndex = null;
    this.showSourceBars = false; this.drop = null; this.drag = null; this.hover = null;
    this.handlers = {}; this.layout = null; this.seams = [];
    this._bind();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.draw()).observe(container);
  }
  on(n, f) { this.handlers[n] = f; return this; } _emit(n, ...a) { const h = this.handlers[n]; return h ? h(...a) : undefined; }
  get lib() { return this.lab.lib; }
  get arr() { return this.arrId ? this.lab.seq.get(this.arrId) : null; }
  setArrangement(id) { this.arrId = id; this.selectedBlockId = null; this.selectedSeamIndex = null; this.scroll = 0; this.refresh(); }
  refresh() { const a = this.arr; this.layout = a ? Sequence.layout(a, this.lib) : null; this.seams = a ? Sequence.seams(a, this.lib) : []; if (a) a.seams = this.seams; this.draw(); }

  /* ---------- geometry ---------- */
  _setup(c) { const dpr = window.devicePixelRatio || 1; const r = c.getBoundingClientRect(); const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height)); if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); } const ctx = c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); return { ctx, w, h }; }
  get width() { return this.cv.lane.getBoundingClientRect().width || 10; }
  xOfBar(bar) { return (bar - 1) * this.pxPerBar - this.scroll; }            // bar is 1-based; x of its left edge
  barAtX(x) { return (x + this.scroll) / this.pxPerBar + 1; }
  xOfSec(sec) { if (!this.layout) return 0; const o = this.layout.occ.find(q => sec >= q.startSec && sec < q.endSec) || this.layout.occ[this.layout.occ.length - 1]; if (!o || !o.lengthSec) return 0; return this.xOfBar(o.startBar + (sec - o.startSec) / o.lengthSec * o.bars); }
  totalBars() { return this.layout ? this.layout.totalBars : 0; }
  clampScroll() { const maxScroll = Math.max(0, this.totalBars() * this.pxPerBar - this.width + 40); this.scroll = Math.max(0, Math.min(maxScroll, this.scroll)); }
  zoom(f, anchorX = this.width / 2) { const bar = this.barAtX(anchorX); this.pxPerBar = Math.max(2, Math.min(400, this.pxPerBar * f)); this.scroll = (bar - 1) * this.pxPerBar - anchorX; this.clampScroll(); this.draw(); }
  fit() { const n = Math.max(1, this.totalBars()); this.pxPerBar = Math.max(2, Math.min(120, (this.width - 20) / n)); this.scroll = 0; this.draw(); }
  ensureVisible(bar) { const x = this.xOfBar(bar); if (x < 0) this.scroll += x - 20; else if (x > this.width - 40) this.scroll += x - this.width + 80; this.clampScroll(); }
  blockRects() {
    const out = []; if (!this.layout) return out;
    const blocks = new Map();
    for (const o of this.layout.occ) { const x0 = this.xOfBar(o.startBar), x1 = this.xOfBar(o.startBar + o.bars); const b = blocks.get(o.block.id); if (!b) blocks.set(o.block.id, { block: o.block, blockIndex: o.blockIndex, loop: o.loop, x0, x1, startBar: o.startBar, bars: o.bars, missing: !!o.missing }); else { b.x1 = x1; b.bars += o.bars; } }
    for (const b of blocks.values()) out.push(b); return out;
  }

  /* ---------- drawing ---------- */
  draw() { this._drawRuler(); this._drawLane(); this._drawMapping(); }
  _drawRuler() {
    const { ctx, w, h } = this._setup(this.cv.ruler); ctx.fillStyle = '#151922'; ctx.fillRect(0, 0, w, h);
    if (!this.layout) return;
    const bpb = this.layout.bpb; const labelEvery = this.pxPerBar >= 34 ? 1 : this.pxPerBar >= 17 ? 2 : this.pxPerBar >= 9 ? 4 : this.pxPerBar >= 4.5 ? 8 : 16;
    ctx.font = '11px ui-monospace, Menlo, monospace'; ctx.textBaseline = 'top';
    const first = Math.max(1, Math.floor(this.barAtX(0))), last = Math.min(this.totalBars() + 1, Math.ceil(this.barAtX(w)));
    for (let bar = first; bar <= last; bar++) {
      const x = Math.round(this.xOfBar(bar)) + 0.5; const labelled = (bar - 1) % labelEvery === 0;
      ctx.strokeStyle = labelled ? 'rgba(255,210,122,0.8)' : 'rgba(255,210,122,0.35)'; ctx.beginPath(); ctx.moveTo(x, h); ctx.lineTo(x, labelled ? 4 : h - 6); ctx.stroke();
      if (labelled) { ctx.fillStyle = '#ffd27a'; ctx.fillText(String(bar), x + 3, 2); }
      if (this.pxPerBar >= 40) for (let b = 1; b < bpb; b++) { const xb = Math.round(x + b * this.pxPerBar / bpb) + 0.5; ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.beginPath(); ctx.moveTo(xb, h); ctx.lineTo(xb, h - 4); ctx.stroke(); }
      if (this.showSourceBars && this.pxPerBar >= 22 && bar <= this.totalBars()) { const info = Sequence.barInfo(this.layout, bar); if (info) { ctx.fillStyle = '#8b95a5'; ctx.font = '9px ui-monospace, monospace'; ctx.fillText(info.ptBar !== null ? `PT${info.ptBar}` : `${info.occ.loop ? info.occ.loop.id : '?'}:${info.localBar}`, x + 3, 15); ctx.font = '11px ui-monospace, Menlo, monospace'; } }
    }
    // markers
    for (const m of (this.arr && this.arr.markers) || []) { const x = this.xOfBar(m.bar); if (x < -100 || x > w) continue; ctx.fillStyle = '#ff6fa8'; ctx.beginPath(); ctx.moveTo(x, h - 1); ctx.lineTo(x - 5, h - 9); ctx.lineTo(x + 5, h - 9); ctx.closePath(); ctx.fill(); ctx.font = '10px system-ui'; ctx.fillStyle = '#ff9fc4'; ctx.fillText(m.name, x + 7, h - 12); ctx.font = '11px ui-monospace, Menlo, monospace'; }
    const p = this._playheadX(); if (p !== null) { ctx.fillStyle = '#fff'; ctx.fillRect(Math.round(p), 0, 1, h); }
  }
  _playheadX() { const pl = this.lab.player; if (!pl.inSequence || this.lab.playingArrId !== this.arrId) return null; const pos = pl.position(); if (pos < 0) return null; return this.xOfSec(pos); }
  _drawLane() {
    const { ctx, w, h } = this._setup(this.cv.lane); ctx.fillStyle = '#0f1115'; ctx.fillRect(0, 0, w, h);
    this.hitRects = [];
    if (!this.arr) { ctx.fillStyle = '#5c6470'; ctx.font = '13px system-ui'; ctx.fillText('Create an arrangement (left), then drag loops from the list onto this lane or use "+ add".', 12, h / 2); return; }
    if (!this.layout || !this.layout.occ.length) { ctx.fillStyle = '#5c6470'; ctx.font = '13px system-ui'; ctx.fillText('Drop loops here — drag rows from the loop list, or press "+ add" on a row.', 12, h / 2); }
    const top = 6, bottom = h - 22, bh = bottom - top; const bpb = this.layout.bpb;
    // bar grid
    const first = Math.max(1, Math.floor(this.barAtX(0))), last = Math.min(this.totalBars() + 1, Math.ceil(this.barAtX(w)));
    for (let bar = first; bar <= last; bar++) { const x = Math.round(this.xOfBar(bar)) + 0.5; ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); }
    const pl = this.lab.player; const info = pl.inSequence && this.lab.playingArrId === this.arrId ? pl.seqInfo() : null;
    // blocks (one rect per block, repeats as inner divisions)
    for (const b of this.blockRects()) {
      if (b.x1 < -2 || b.x0 > w + 2) continue;
      const col = b.loop ? Sequence.colorFor(b.loop, this.lib) : '#553';
      const sel = b.block.id === this.selectedBlockId; const playing = info && info.occ && info.occ.block.id === b.block.id;
      ctx.fillStyle = b.missing ? 'rgba(120,60,60,0.6)' : col.replace(')', ' / 0.75)').replace('hsl(', 'hsl(');
      ctx.fillRect(b.x0 + 1, top, Math.max(2, b.x1 - b.x0 - 2), bh);
      if (playing) { ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(b.x0 + 1, top, Math.max(2, b.x1 - b.x0 - 2), bh); }
      ctx.strokeStyle = sel ? '#fff' : 'rgba(0,0,0,0.5)'; ctx.lineWidth = sel ? 2 : 1; ctx.strokeRect(Math.round(b.x0) + 1.5, top + 0.5, Math.max(2, Math.round(b.x1 - b.x0) - 3), bh - 1);
      // repeat divisions
      if (b.block.repeats > 1) { const lb = b.bars / b.block.repeats; for (let r = 1; r < b.block.repeats; r++) { const xr = Math.round(this.xOfBar(b.startBar + r * lb)) + 0.5; ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(xr, top); ctx.lineTo(xr, bottom); ctx.stroke(); ctx.setLineDash([]); } }
      if (playing && info.occ) { const xr0 = this.xOfBar(info.occ.startBar), xr1 = this.xOfBar(info.occ.startBar + info.occ.bars); ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fillRect(xr0, top, xr1 - xr0, bh); }
      // labels
      const wpx = b.x1 - b.x0; ctx.fillStyle = '#fff'; ctx.textBaseline = 'top';
      const id = b.loop ? b.loop.id : b.block.loopId + ' ?'; const m = b.loop && b.loop.machine ? b.loop.machine : {};
      const line1 = `${id}${b.block.repeats > 1 ? ` ×${b.block.repeats}` : ''}`;
      const line2 = `${b.bars} bar${b.bars === 1 ? '' : 's'}${b.block.gainDb ? ` · ${b.block.gainDb > 0 ? '+' : ''}${b.block.gainDb} dB` : ''}`;
      const line3 = b.loop ? `${b.loop.rating !== null && b.loop.rating !== undefined ? '★' + LoopLibrary.formatRating(b.loop.rating) : '★—'}${this.lab.isRevealed(b.loop) ? ` · m${m.score !== null && m.score !== undefined ? m.score.toFixed(1) : '—'}` : ''}` : 'missing loop';
      ctx.font = 'bold 12px system-ui'; if (wpx > 30) ctx.fillText(this._trunc(ctx, line1, wpx - 8), b.x0 + 5, top + 5);
      ctx.font = '10px system-ui'; if (wpx > 44 && bh > 40) ctx.fillText(this._trunc(ctx, line2, wpx - 8), b.x0 + 5, top + 21); if (wpx > 44 && bh > 54) ctx.fillText(this._trunc(ctx, line3, wpx - 8), b.x0 + 5, top + 34);
      this.hitRects.push({ x0: b.x0, x1: b.x1, block: b.block, blockIndex: b.blockIndex, startBar: b.startBar, bars: b.bars, loop: b.loop });
    }
    // seam badges
    for (const s of this.seams) {
      const x = this.xOfBar(s.atBar); if (x < -8 || x > w + 8) continue;
      const col = { green: '#8ee66b', amber: '#ffb03f', red: '#ff4d6d', grey: '#6b7280' }[s.severity] || '#6b7280';
      const y = bottom - 8; ctx.fillStyle = col; ctx.beginPath(); ctx.arc(x, y, s.kind === 'repeat' ? 4 : 5.5, 0, Math.PI * 2); ctx.fill();
      if (this.selectedSeamIndex === s.index) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
      if (s.severity === 'red') { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x - 2.5, y - 2.5); ctx.lineTo(x + 2.5, y + 2.5); ctx.moveTo(x + 2.5, y - 2.5); ctx.lineTo(x - 2.5, y + 2.5); ctx.stroke(); }
      this.hitRects.push({ x0: x - 7, x1: x + 7, y0: y - 8, y1: y + 8, seam: s });
    }
    ctx.lineWidth = 1;
    // drop indicator
    if (this.drop) { const x = Math.round(this.drop.x) + 0.5; ctx.strokeStyle = '#3fb0ff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(x, top - 2); ctx.lineTo(x, bottom + 2); ctx.stroke(); ctx.lineWidth = 1; ctx.fillStyle = '#3fb0ff'; ctx.beginPath(); ctx.moveTo(x - 6, top - 2); ctx.lineTo(x + 6, top - 2); ctx.lineTo(x, top + 5); ctx.closePath(); ctx.fill(); }
    if (this.drag && this.drag.moved) { ctx.fillStyle = this.drag.outside ? 'rgba(255,77,109,0.25)' : 'rgba(63,176,255,0.15)'; ctx.fillRect(this.drag.x - 40, top, 80, bh); ctx.fillStyle = '#fff'; ctx.font = '11px system-ui'; ctx.fillText(this.drag.outside ? 'release to remove' : this.drag.label, this.drag.x - 36, top + 4); }
    // playhead
    const p = this._playheadX(); if (p !== null) { ctx.fillStyle = '#fff'; ctx.fillRect(Math.round(p), 0, 1, h); }
    // bar readout strip
    ctx.fillStyle = '#8b95a5'; ctx.font = '10px ui-monospace, monospace'; ctx.textBaseline = 'top';
    const tb = this.totalBars(); ctx.fillText(`${tb} bar${tb === 1 ? '' : 's'} · ${U.fmtTime(this.layout.totalSeconds)} · ${this.seams.length} seam${this.seams.length === 1 ? '' : 's'}${this.selectedBlockId ? ' · selected block at bar ' + (this.hitRects.find(r => r.block && r.block.id === this.selectedBlockId) || { startBar: '?' }).startBar : ''}`, 6, bottom + 6);
  }
  _trunc(ctx, text, maxW) { if (maxW <= 8) return ''; if (ctx.measureText(text).width <= maxW) return text; let lo = 0, hi = text.length; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(text.slice(0, m) + '…').width <= maxW) lo = m; else hi = m - 1; } return lo ? text.slice(0, lo) + '…' : ''; }
  _drawMapping() {
    const { ctx, w, h } = this._setup(this.cv.mapping); ctx.fillStyle = '#0b0d11'; ctx.fillRect(0, 0, w, h);
    if (!this.layout) return;
    ctx.font = '10px ui-monospace, monospace'; ctx.textBaseline = 'middle';
    const first = Math.max(1, Math.floor(this.barAtX(0))), last = Math.min(this.totalBars(), Math.ceil(this.barAtX(w)));
    let lastLabelX = -1e9;
    for (let bar = first; bar <= last; bar++) {
      const x = this.xOfBar(bar); const info = Sequence.barInfo(this.layout, bar); if (!info) continue;
      const col = info.occ.loop ? Sequence.colorFor(info.occ.loop, this.lib) : '#553';
      ctx.fillStyle = col.replace(')', ' / 0.5)'); ctx.fillRect(x + 1, 2, Math.max(1, this.pxPerBar - 2), h - 4);
      if (x - lastLabelX >= 30 && this.pxPerBar >= 12) { ctx.fillStyle = '#e6edf3'; ctx.fillText(info.ptBar !== null ? `${info.ptBar}` : `${info.localBar}`, x + 3, h / 2); lastLabelX = x; }
    }
    ctx.fillStyle = '#8b95a5'; ctx.fillText('PT', 0, h / 2);
    if (this.hover && this.hover.bar) { const info = Sequence.barInfo(this.layout, this.hover.bar); if (info) { const text = `arrangement bar ${this.hover.bar} = ${info.ptBar !== null ? 'PT bar ' + info.ptBar : 'local bar ' + info.localBar}, ${info.occ.repeatIndex + 1}${['st', 'nd', 'rd'][info.occ.repeatIndex] || 'th'} repeat of ${info.occ.loop ? info.occ.loop.id : info.occ.block.loopId}`; ctx.fillStyle = 'rgba(0,0,0,0.85)'; const tw = ctx.measureText(text).width + 10; const tx = Math.min(w - tw, Math.max(0, this.hover.x - tw / 2)); ctx.fillRect(tx, 0, tw, h); ctx.fillStyle = '#fff'; ctx.fillText(text, tx + 5, h / 2); } }
  }

  /* ---------- interaction ---------- */
  _bind() {
    const lane = this.cv.lane; const pos = (ev) => { const r = lane.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
    const wheel = (ev) => { ev.preventDefault(); if (ev.ctrlKey || ev.metaKey) this.zoom(Math.exp(U.clamp(ev.deltaY, -100, 100) * 0.01), pos(ev).x); else { this.scroll += (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) ? ev.deltaX : ev.deltaY); this.clampScroll(); this.draw(); } };
    lane.addEventListener('wheel', wheel, { passive: false }); this.cv.ruler.addEventListener('wheel', wheel, { passive: false }); this.cv.mapping.addEventListener('wheel', wheel, { passive: false });
    lane.addEventListener('mousemove', (ev) => { const p = pos(ev); this.hover = { x: p.x, bar: Math.floor(this.barAtX(p.x)) }; const seam = this._seamAt(p); this._emit('hover', seam ? { seam } : this._blockAt(p.x) ? { block: this._blockAt(p.x), bar: this.hover.bar } : null, ev); lane.style.cursor = seam ? 'pointer' : this._blockAt(p.x) ? 'grab' : 'default'; this._drawMapping(); });
    lane.addEventListener('mouseleave', () => { this.hover = null; this._emit('hover', null); this._drawMapping(); });
    this.cv.ruler.addEventListener('dblclick', (ev) => { const r = this.cv.ruler.getBoundingClientRect(); const bar = Math.floor(this.barAtX(ev.clientX - r.left)); if (bar >= 1 && bar <= this.totalBars()) this._emit('addMarker', bar); });
    this.cv.ruler.addEventListener('click', (ev) => { const r = this.cv.ruler.getBoundingClientRect(); const x = ev.clientX - r.left; const m = ((this.arr && this.arr.markers) || []).find(mk => Math.abs(this.xOfBar(mk.bar) - x) < 8); if (m && ev.altKey) this._emit('removeMarker', m.bar); else if (m) this._emit('editMarker', m); else this._emit('seekBar', Math.floor(this.barAtX(x))); });
    lane.addEventListener('dblclick', (ev) => { const p = pos(ev); const b = this._blockAt(p.x); if (b) this._emit('playBlock', b.block.id); });
    lane.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return; const p = pos(ev);
      const seam = this._seamAt(p); if (seam) { this.selectedSeamIndex = seam.index; this._emit('seamSelect', seam); this.draw(); return; }
      const hit = this._blockAt(p.x);
      if (!hit) { this.selectedBlockId = null; this._emit('select', null); this.draw(); return; }
      this.selectedBlockId = hit.block.id; this._emit('select', hit.block.id); this.draw();
      const drag = this.drag = { block: hit.block, x0: p.x, x: p.x, moved: false, outside: false, label: hit.loop ? hit.loop.id : hit.block.loopId };
      const move = (e) => { const q = pos(e); if (!drag.moved && Math.abs(q.x - drag.x0) < 4 && Math.abs(q.y - (p.y)) < 4) return; drag.moved = true; drag.x = q.x; const r = lane.getBoundingClientRect(); drag.outside = e.clientY < r.top - 30 || e.clientY > r.bottom + 30; this.drop = drag.outside ? null : { x: this._insertX(q.x).x, index: this._insertX(q.x).index }; lane.style.cursor = drag.outside ? 'not-allowed' : 'grabbing'; this.draw(); };
      const up = (e) => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); const d = this.drag; this.drag = null; const drop = this.drop; this.drop = null; lane.style.cursor = 'default'; if (d && d.moved) { if (d.outside) this._emit('removeBlock', d.block.id); else if (drop) this._emit('moveBlock', d.block.id, drop.index); } this.draw(); void e; };
      window.addEventListener('mousemove', move); window.addEventListener('mouseup', up);
    });
    // HTML5 drop from the library list
    lane.addEventListener('dragover', (ev) => { if (!this.arr) return; ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; const p = pos(ev); const ins = this._insertX(p.x); this.drop = { x: ins.x, index: ins.index }; this.draw(); });
    lane.addEventListener('dragleave', () => { this.drop = null; this.draw(); });
    lane.addEventListener('drop', (ev) => { ev.preventDefault(); const drop = this.drop; this.drop = null; const id = ev.dataTransfer.getData('text/x-loop-id') || ev.dataTransfer.getData('text/plain'); if (id && drop) this._emit('dropLoop', id, drop.index); this.draw(); });
  }
  _blockAt(x) { return (this.hitRects || []).find(r => r.block && x >= r.x0 && x <= r.x1) || null; }
  _seamAt(p) { const r = (this.hitRects || []).find(q => q.seam && p.x >= q.x0 && p.x <= q.x1 && p.y >= q.y0 && p.y <= q.y1); return r ? r.seam : null; }
  /** insertion point nearest to x: before/after existing blocks */
  _insertX(x) {
    const rects = (this.hitRects || []).filter(r => r.block).sort((a, b) => a.x0 - b.x0);
    if (!rects.length) return { x: this.xOfBar(1), index: 0 };
    for (let i = 0; i < rects.length; i++) { const r = rects[i]; const mid = (r.x0 + r.x1) / 2; if (x < mid) return { x: r.x0, index: r.blockIndex }; }
    const last = rects[rects.length - 1]; return { x: last.x1, index: last.blockIndex + 1 };
  }
}

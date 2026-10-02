/* songstrip.js — SongStrip: a thin canvas of the whole song (Pro Tools bars)
 * with every loop as a block at its position — one row per length so 2-, 4-
 * and 8-bar loops don't hide each other — colour by length, height by my
 * rating when rated, section names along the strip, events marked. Hover
 * shows the loop, click selects it, drag selects a bar range that filters the
 * list. */
'use strict';

class SongStrip {
  constructor(canvas, lab) {
    this.c = canvas; this.lab = lab; this.loops = []; this.sections = []; this.range = [9, 380]; this.selectedRange = null; this.hover = null; this.handlers = {};
    this.rows = { '2': 0, '4': 1, '8': 2, event: 3 }; this.colors = { '2': '#3fb0ff', '4': '#8ee66b', '8': '#ffb03f', event: '#ff6fa8' };
    this._bind();
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => this.draw()).observe(canvas);
  }
  on(n, f) { this.handlers[n] = f; return this; } _emit(n, ...a) { const h = this.handlers[n]; return h ? h(...a) : undefined; }
  setData(loops, ctx) {
    this.loops = loops.filter(l => l.ptStart !== null && l.ptStart !== undefined);
    let lo = Infinity, hi = -Infinity; for (const l of this.loops) { lo = Math.min(lo, l.ptStart); hi = Math.max(hi, l.ptEnd - 1); }
    this.range = isFinite(lo) ? [Math.min(lo, 9), Math.max(hi, lo + 8)] : [9, 380];
    const first = new Map(); for (const l of this.loops) { const r = ctx.rec(l); if (!r || !r.section) continue; if (!first.has(r.section) || l.ptStart < first.get(r.section)) first.set(r.section, l.ptStart); }
    this.sections = Array.from(first.entries()).sort((a, b) => a[1] - b[1]).map(([name, bar]) => ({ name, bar }));
    this.ctx = ctx; this.draw();
  }
  get width() { return this.c.getBoundingClientRect().width || 10; }
  xOf(bar) { const [a, b] = this.range; return 24 + (bar - a) / Math.max(1, b - a + 1) * (this.width - 30); }
  barAt(x) { const [a, b] = this.range; return a + (x - 24) / (this.width - 30) * Math.max(1, b - a + 1); }
  draw() {
    const dpr = window.devicePixelRatio || 1; const r = this.c.getBoundingClientRect(); const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
    if (this.c.width !== Math.round(w * dpr) || this.c.height !== Math.round(h * dpr)) { this.c.width = Math.round(w * dpr); this.c.height = Math.round(h * dpr); }
    const ctx = this.c.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#0b0d11'; ctx.fillRect(0, 0, w, h);
    const top = 12, rowH = (h - top - 12) / 4; this.hits = [];
    ctx.font = '9px system-ui'; ctx.textBaseline = 'top'; ctx.fillStyle = '#8b95a5';
    for (const [k, i] of Object.entries(this.rows)) ctx.fillText(k === 'event' ? 'ev' : k + 'b', 2, top + i * rowH + 1);
    // sections
    for (let i = 0; i < this.sections.length; i++) { const s = this.sections[i]; const x = this.xOf(s.bar), x1 = i + 1 < this.sections.length ? this.xOf(this.sections[i + 1].bar) : this.xOf(this.range[1] + 1); ctx.fillStyle = i % 2 ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.06)'; ctx.fillRect(x, 0, x1 - x, h); ctx.fillStyle = '#c9d1d9'; ctx.font = '9px system-ui'; if (x1 - x > 24) ctx.fillText(this._trunc(ctx, s.name, x1 - x - 4), x + 2, 1); }
    // bar ticks every 20
    ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.font = '8px ui-monospace, monospace'; for (let b = Math.ceil(this.range[0] / 20) * 20; b <= this.range[1]; b += 20) { const x = Math.round(this.xOf(b)); ctx.fillRect(x, h - 12, 1, 4); ctx.fillStyle = '#8b95a5'; ctx.fillText(String(b), x + 2, h - 10); ctx.fillStyle = 'rgba(255,255,255,0.25)'; }
    // selected range
    if (this.selectedRange) { const x0 = this.xOf(this.selectedRange[0]), x1 = this.xOf(this.selectedRange[1] + 1); ctx.fillStyle = 'rgba(63,176,255,0.18)'; ctx.fillRect(x0, top, x1 - x0, h - top - 12); ctx.strokeStyle = '#3fb0ff'; ctx.strokeRect(Math.round(x0) + 0.5, top + 0.5, Math.round(x1 - x0) - 1, h - top - 13); }
    // loops
    for (const l of this.loops) {
      const k = Ranking.lengthKey(l); const row = this.rows[k] ?? 3; const x0 = this.xOf(l.ptStart), x1 = this.xOf(l.ptEnd); const y = top + row * rowH;
      const rated = l.rating !== null && l.rating !== undefined; const hh = rated ? Math.max(3, (l.rating / 9.9) * (rowH - 2)) : 3;
      const sel = l.id === this.lab.currentId; const col = this.colors[k] || '#ccc';
      ctx.fillStyle = sel ? '#fff' : U.rgba(col.startsWith('#') ? col : '#cccccc', rated ? 0.95 : 0.45); ctx.fillRect(x0 + 0.5, y + rowH - 1 - hh, Math.max(2, x1 - x0 - 1), hh);
      if (l.skipped && !rated) { ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(x0 + 0.5, y + rowH - 3, Math.max(2, x1 - x0 - 1), 1); }
      this.hits.push({ x0, x1, y0: y, y1: y + rowH, loop: l });
    }
    if (this.hover) { ctx.fillStyle = 'rgba(0,0,0,0.85)'; ctx.font = '10px system-ui'; const t = this.hover.text; const tw = ctx.measureText(t).width + 8; const tx = Math.min(w - tw, Math.max(0, this.hover.x - tw / 2)); ctx.fillRect(tx, h - 24, tw, 12); ctx.fillStyle = '#fff'; ctx.fillText(t, tx + 4, h - 22); }
  }
  _trunc(ctx, text, maxW) { if (ctx.measureText(text).width <= maxW) return text; let lo = 0, hi = text.length; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (ctx.measureText(text.slice(0, m) + '…').width <= maxW) lo = m; else hi = m - 1; } return lo ? text.slice(0, lo) + '…' : ''; }
  _at(x, y) { return (this.hits || []).find(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1) || null; }
  _bind() {
    const pos = (ev) => { const r = this.c.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };
    this.c.addEventListener('mousemove', (ev) => { const p = pos(ev); const h = this._at(p.x, p.y); if (this.drag) { const b = Math.round(this.barAt(p.x)); this.selectedRange = [Math.min(this.drag.bar, b), Math.max(this.drag.bar, b)]; this.drag.moved = this.drag.moved || b !== this.drag.bar; this.draw(); return; } this.hover = h ? { x: p.x, text: `${h.loop.id} · PT ${h.loop.ptStart}–${h.loop.ptEnd - 1}${h.loop.rating !== null && h.loop.rating !== undefined ? ' · ★' + LoopLibrary.formatRating(h.loop.rating) : ''}${(this.ctx && this.ctx.rec(h.loop) && this.ctx.rec(h.loop).section) ? ' · ' + this.ctx.rec(h.loop).section : ''}` } : null; this.c.style.cursor = h ? 'pointer' : 'crosshair'; this.draw(); });
    this.c.addEventListener('mouseleave', () => { this.hover = null; this.draw(); });
    this.c.addEventListener('mousedown', (ev) => { if (ev.button !== 0) return; const p = pos(ev); this.drag = { bar: Math.round(this.barAt(p.x)), moved: false, hit: this._at(p.x, p.y) };
      const up = () => { window.removeEventListener('mouseup', up); const d = this.drag; this.drag = null; if (!d) return; if (d.moved) { this._emit('range', this.selectedRange); } else { this.selectedRange = null; if (d.hit) this._emit('select', d.hit.loop.id); else this._emit('range', null); } this.draw(); };
      window.addEventListener('mouseup', up); });
  }
}

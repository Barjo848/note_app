/* notes.js — NoteStore: layers, notes, replies, undo/redo.
 *
 * Every mutating call goes through commit(label, fn): a structured clone of
 * {layers, notes} is pushed on the undo stack first, then fn mutates the live
 * state, then listeners are notified. Drags use beginTransient/endTransient
 * so one undo step covers the whole gesture. */
'use strict';

const DEFAULT_CATEGORIES = ['structure', 'drums', 'bass', 'mix', 'fx', 'idea', 'fix', 'loop', 'fill', 'reference'];
const CATEGORY_COLORS = {
  structure: '#7c9cff', drums: '#ff7a59', bass: '#c084fc', mix: '#5ad1c8', fx: '#f0c34f',
  idea: '#8ee66b', fix: '#ff5d8f', loop: '#4fb8ff', fill: '#ffa552', reference: '#b0b8c8',
};
const LAYER_PALETTE = ['#3fb0ff', '#ffb03f', '#8ee66b', '#ff6fa8', '#c084fc', '#5ad1c8', '#f0c34f', '#ff7a59'];
const NOTE_STATUSES = ['open', 'done', 'wontfix'];

class NoteStore {
  constructor() {
    this.layers = []; this.notes = [];
    this.sampleRate = 48000;
    this.undoStack = []; this.redoStack = []; this.maxUndo = 200;
    this._transient = null;
    this.listeners = new Set();
    this.categories = DEFAULT_CATEGORIES.slice();
    this.categoryColors = Object.assign({}, CATEGORY_COLORS);
  }

  /* ----- events ----- */
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what = {}) { for (const fn of this.listeners) fn(what); }

  /* ----- snapshots / undo ----- */
  snapshot() { return U.deepClone({ layers: this.layers, notes: this.notes }); }
  restore(s) { this.layers = U.deepClone(s.layers); this.notes = U.deepClone(s.notes); }
  commit(label, fn) {
    if (this._transient) { const r = fn(this); this.emit({ label, transient: true }); return r; }
    this.undoStack.push({ label, state: this.snapshot() });
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    this.redoStack.length = 0;
    const r = fn(this);
    this.emit({ label });
    return r;
  }
  beginTransient(label) { if (this._transient) return; this._transient = { label, state: this.snapshot() }; }
  endTransient(changed = true) {
    const t = this._transient; this._transient = null; if (!t) return;
    if (changed) { this.undoStack.push(t); if (this.undoStack.length > this.maxUndo) this.undoStack.shift(); this.redoStack.length = 0; }
    this.emit({ label: t.label });
  }
  cancelTransient() { const t = this._transient; this._transient = null; if (t) { this.restore(t.state); this.emit({ label: 'cancel' }); } }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  undo() { const u = this.undoStack.pop(); if (!u) return null; this.redoStack.push({ label: u.label, state: this.snapshot() }); this.restore(u.state); this.emit({ label: 'undo ' + u.label, undo: true }); return u.label; }
  redo() { const r = this.redoStack.pop(); if (!r) return null; this.undoStack.push({ label: r.label, state: this.snapshot() }); this.restore(r.state); this.emit({ label: 'redo ' + r.label, undo: true }); return r.label; }
  clearHistory() { this.undoStack.length = 0; this.redoStack.length = 0; }

  /* ----- loading whole state (no undo entry) ----- */
  load({ layers, notes }) { this.layers = layers; this.notes = notes; this.clearHistory(); this.emit({ label: 'load' }); }
  reset() { this.layers = []; this.notes = []; this.clearHistory(); this.ensureDefaultLayer(); this.emit({ label: 'reset' }); }

  /* ----- helpers ----- */
  pos(samples) { return { samples: Math.round(samples), seconds: Math.round(samples) / this.sampleRate }; }
  posFromSeconds(sec) { return this.pos(Math.round(sec * this.sampleRate)); }
  setSampleRate(sr) {
    this.sampleRate = sr;
    for (const n of this.notes) { n.start = this.pos(n.start.samples); if (n.end) n.end = this.pos(n.end.samples); }
  }
  layer(id) { return this.layers.find(l => l.id === id) || null; }
  note(id) { return this.notes.find(n => n.id === id) || null; }
  layerColor(id) { const l = this.layer(id); return l ? l.color : '#888'; }
  noteColor(n) { return n.color || this.categoryColors[n.category] || this.layerColor(n.layerId) || '#3fb0ff'; }
  nextLayerColor() { return LAYER_PALETTE[this.layers.length % LAYER_PALETTE.length]; }
  layerNoteCount(id) { return this.notes.filter(n => n.layerId === id).length; }
  uniqueLayerName(base) {
    if (!this.layers.some(l => l.name === base)) return base;
    for (let i = 2; i < 1000; i++) { const nm = `${base} (${i})`; if (!this.layers.some(l => l.name === nm)) return nm; }
    return `${base} ${Date.now()}`;
  }
  ensureDefaultLayer() {
    if (this.layers.length === 0) this.layers.push(this.makeLayer({ name: 'Notes', kind: 'human', color: LAYER_PALETTE[0] }));
    return this.layers[0];
  }
  makeLayer({ name, kind = 'human', color, visible = true, source = null }) {
    const l = { id: U.uid('L'), name, kind, color: color || this.nextLayerColor(), visible, createdAt: U.nowIso() };
    if (source) l.source = source;
    return l;
  }
  makeNote({ layerId, type, startSamples, endSamples = null, title = '', body = '', category = 'idea', tags = [], color = null, rating = null, status = 'open' }) {
    const now = U.nowIso();
    return { id: U.uid('n'), layerId, type, start: this.pos(startSamples), end: type === 'interval' && endSamples !== null ? this.pos(endSamples) : null,
      title, body, category, tags: tags.slice(), color, rating, status, createdAt: now, updatedAt: now, replies: [] };
  }

  /* ----- note ops (each wrapped in commit) ----- */
  addNote(fields) {
    const n = this.makeNote(fields);
    if (n.type === 'interval' && n.end && n.end.samples < n.start.samples) { const t = n.start; n.start = n.end; n.end = t; }
    this.commit('add note', () => this.notes.push(n));
    return n;
  }
  updateNote(id, patch) {
    return this.commit('edit note', () => {
      const n = this.note(id); if (!n) return null;
      Object.assign(n, patch); n.updatedAt = U.nowIso(); return n;
    });
  }
  /** move/resize by samples; end === undefined leaves it unchanged */
  setNotePosition(id, startSamples, endSamples) {
    return this.commit('move note', () => {
      const n = this.note(id); if (!n) return null;
      const total = Infinity;
      let s = U.clamp(Math.round(startSamples), 0, total);
      if (n.type === 'interval') {
        let e = endSamples === undefined ? n.end.samples : Math.round(endSamples);
        if (e < s) { const t = s; s = e; e = t; }
        if (e === s) e = s + 1;
        n.start = this.pos(s); n.end = this.pos(e);
      } else n.start = this.pos(s);
      n.updatedAt = U.nowIso(); return n;
    });
  }
  deleteNote(id) { return this.commit('delete note', () => { const i = this.notes.findIndex(n => n.id === id); if (i >= 0) return this.notes.splice(i, 1)[0]; return null; }); }
  addReply(noteId, { layerId, body }) {
    return this.commit('add reply', () => {
      const n = this.note(noteId); if (!n) return null;
      const r = { id: U.uid('r'), layerId, body, createdAt: U.nowIso() };
      n.replies = n.replies || []; n.replies.push(r); n.updatedAt = U.nowIso(); return r;
    });
  }
  deleteReply(noteId, replyId) {
    return this.commit('delete reply', () => { const n = this.note(noteId); if (!n || !n.replies) return; n.replies = n.replies.filter(r => r.id !== replyId); });
  }

  /* ----- layer ops ----- */
  addLayer(fields) { const l = this.makeLayer(fields); l.name = this.uniqueLayerName(l.name); this.commit('add layer', () => this.layers.push(l)); return l; }
  updateLayer(id, patch) { return this.commit('edit layer', () => { const l = this.layer(id); if (l) Object.assign(l, patch); return l; }); }
  setLayerVisible(id, visible) { const l = this.layer(id); if (!l || l.visible === visible) return; l.visible = visible; this.emit({ label: 'visibility', noDirty: true }); }
  deleteLayer(id) {
    return this.commit('delete layer', () => {
      this.layers = this.layers.filter(l => l.id !== id);
      this.notes = this.notes.filter(n => n.layerId !== id);
      for (const n of this.notes) if (n.replies) n.replies = n.replies.filter(r => r.layerId !== id);
      this.ensureDefaultLayer();
    });
  }
  duplicateLayer(id) {
    return this.commit('duplicate layer', () => {
      const src = this.layer(id); if (!src) return null;
      const copy = Object.assign(U.deepClone(src), { id: U.uid('L'), name: this.uniqueLayerName(src.name + ' copy'), color: this.nextLayerColor(), createdAt: U.nowIso() });
      this.layers.push(copy);
      const idMap = new Map();
      for (const n of this.notes.slice()) if (n.layerId === id) {
        const c = U.deepClone(n); c.id = U.uid('n'); c.layerId = copy.id; idMap.set(n.id, c.id);
        for (const r of (c.replies || [])) r.id = U.uid('r');
        this.notes.push(c);
      }
      return copy;
    });
  }
  /** Move every note and reply of `srcId` into `dstId`, then remove src. */
  mergeLayer(srcId, dstId) {
    if (srcId === dstId) return;
    return this.commit('merge layer', () => {
      for (const n of this.notes) {
        if (n.layerId === srcId) n.layerId = dstId;
        for (const r of (n.replies || [])) if (r.layerId === srcId) r.layerId = dstId;
      }
      this.layers = this.layers.filter(l => l.id !== srcId);
      this.ensureDefaultLayer();
    });
  }

  /* ----- queries ----- */
  visibleLayerIds() { return new Set(this.layers.filter(l => l.visible !== false).map(l => l.id)); }
  /** notes on visible layers, optionally filtered, sorted by time (or creation) */
  visibleNotes({ layerId = null, category = null, status = null, search = '', sort = 'time' } = {}) {
    const vis = this.visibleLayerIds();
    const q = (search || '').trim().toLowerCase();
    let out = this.notes.filter(n => vis.has(n.layerId)
      && (!layerId || n.layerId === layerId)
      && (!category || n.category === category)
      && (!status || n.status === status)
      && (!q || (n.title + ' ' + n.body + ' ' + (n.tags || []).join(' ') + ' ' + (n.replies || []).map(r => r.body).join(' ')).toLowerCase().includes(q)));
    if (sort === 'created') out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    else out.sort((a, b) => a.start.samples - b.start.samples || (a.type === 'interval' ? -1 : 1));
    return out;
  }
  /** Greedy lane packing for intervals so overlapping bands never hide each other. Returns Map(noteId → lane). */
  static packLanes(intervals) {
    const sorted = intervals.slice().sort((a, b) => a.start.samples - b.start.samples || b.end.samples - a.end.samples);
    const laneEnds = []; const map = new Map();
    for (const n of sorted) {
      let lane = laneEnds.findIndex(e => e <= n.start.samples);
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(0); }
      laneEnds[lane] = n.end.samples; map.set(n.id, lane);
    }
    return { lanes: map, count: laneEnds.length };
  }
  /** next/prev note relative to a sample position (visible notes, time order) */
  adjacent(samples, dir, onlyOpen = false) {
    const list = this.visibleNotes().filter(n => !onlyOpen || n.status === 'open');
    const eps = Math.round(this.sampleRate * 0.01);
    if (dir > 0) return list.find(n => n.start.samples > samples + eps) || null;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].start.samples < samples - eps) return list[i];
    return null;
  }
}

/* ranking.js — Ranking: every sort key, the similarity distance, filters,
 * grouping and the seeded shuffle for the loop list.
 *
 * ctx = { lib, rec(loop) → sidecar record | null, revealed(loop) → bool,
 *         reference: loop | centroid | null, weights: {pattern, feel, sound, position},
 *         seamCache: Map, random seed }
 * Similarity distance (symmetric, 0 for the reference) is a weighted mean of
 *   pattern  : cosine distance between per-16th hit-probability vectors (kick/snare/hat × 16)
 *   feel     : |Δ mean core-hit deviation| / 20 ms
 *   sound    : mean of |Δ high-band level|/6 dB, |Δ hats per bar|/4, |Δ RMS|/6 dB
 *   position : |Δ Pro Tools bar| / 100
 * each clipped to [0, 1] before weighting. */
'use strict';

const Ranking = {
  presets: { pattern: { pattern: 1, feel: 0, sound: 0, position: 0.1 }, feel: { pattern: 0, feel: 1, sound: 0, position: 0.1 }, sound: { pattern: 0, feel: 0, sound: 1, position: 0.1 }, all: { pattern: 1, feel: 1, sound: 1, position: 0.2 } },
  hatsOrder: { light: 0, medium: 1, full: 2 },
  lengthKey(l) { return /event/i.test(l.folder || '') ? 'event' : String(l.barsRounded || Math.round(l.bars) || 0); },
  bassOut(l, rec) { return !!(rec && Array.isArray(rec.bassOutBars) && rec.bassOutBars.length); },

  /* ---------- feature vectors ---------- */
  patternVector(l) {
    if (l._pv && l._pvN === (l.hits || []).length) return l._pv;
    const bars = Math.max(1, l.barsRounded || Math.round(l.bars) || 1); const v = new Float32Array(48); const seen = new Set();
    for (const h of l.hits || []) { if (h.class === 'ignore' || h.drum === 'other') continue; const d = { kick: 0, snare: 1, hat: 2 }[h.drum]; if (d === undefined) continue; const k = `${d}:${h.pos}:${h.bar}`; if (seen.has(k)) continue; seen.add(k); v[d * 16 + (h.pos % 16)] += 1 / bars; }
    l._pv = v; l._pvN = (l.hits || []).length; return v;
  },
  cosineDistance(a, b) { let dot = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } if (!na || !nb) return 1; return U.clamp(1 - dot / Math.sqrt(na * nb), 0, 1); },
  feelOf(l) { return l.machine && typeof l.machine.feelMs === 'number' ? l.machine.feelMs : null; },
  soundOf(l) { const f = l.seamFeatures; return { high: f && typeof f.firstBeatHighDb === 'number' ? (f.firstBeatHighDb + f.lastBeatHighDb) / 2 : null, hats: f && typeof f.hatsPerBar === 'number' ? f.hatsPerBar : null, rms: typeof l.rmsDb === 'number' ? l.rmsDb : null }; },
  /** a pseudo-loop for "similar to a section" */
  centroid(loops, name) {
    const pv = new Float32Array(48); let n = 0, feel = 0, fn = 0, high = 0, hn = 0, hats = 0, hatn = 0, rms = 0, rn = 0, pos = 0, pn = 0;
    for (const l of loops) { const v = this.patternVector(l); for (let i = 0; i < 48; i++) pv[i] += v[i]; n++; const f = this.feelOf(l); if (f !== null) { feel += f; fn++; } const s = this.soundOf(l); if (s.high !== null) { high += s.high; hn++; } if (s.hats !== null) { hats += s.hats; hatn++; } if (s.rms !== null) { rms += s.rms; rn++; } if (l.ptStart !== null && l.ptStart !== undefined) { pos += l.ptStart; pn++; } }
    if (n) for (let i = 0; i < 48; i++) pv[i] /= n;
    return { id: `§ ${name}`, isCentroid: true, section: name, _pv: pv, _pvN: -1, machine: { feelMs: fn ? feel / fn : null }, seamFeatures: { firstBeatHighDb: hn ? high / hn : null, lastBeatHighDb: hn ? high / hn : null, hatsPerBar: hatn ? hats / hatn : null }, rmsDb: rn ? rms / rn : null, ptStart: pn ? pos / pn : null, hits: [], bars: 2, barsRounded: 2, members: loops.map(l => l.id) };
  },
  distance(a, b, weights) {
    if (!a || !b) return null; if (a === b || (a.id === b.id && !a.isCentroid)) return { total: 0, pattern: 0, feel: 0, sound: 0, position: 0 };
    const w = weights || this.presets.all;
    const pattern = this.cosineDistance(a.isCentroid ? a._pv : this.patternVector(a), b.isCentroid ? b._pv : this.patternVector(b));
    const fa = this.feelOf(a), fb = this.feelOf(b); const feel = fa !== null && fb !== null ? U.clamp(Math.abs(fa - fb) / 20, 0, 1) : 0.5;
    const sa = this.soundOf(a), sb = this.soundOf(b); const parts = []; if (sa.high !== null && sb.high !== null) parts.push(U.clamp(Math.abs(sa.high - sb.high) / 6, 0, 1)); if (sa.hats !== null && sb.hats !== null) parts.push(U.clamp(Math.abs(sa.hats - sb.hats) / 4, 0, 1)); if (sa.rms !== null && sb.rms !== null) parts.push(U.clamp(Math.abs(sa.rms - sb.rms) / 6, 0, 1));
    const sound = parts.length ? parts.reduce((x, y) => x + y, 0) / parts.length : 0.5;
    const position = a.ptStart !== null && a.ptStart !== undefined && b.ptStart !== null && b.ptStart !== undefined ? U.clamp(Math.abs(a.ptStart - b.ptStart) / 100, 0, 1) : 0.5;
    const ws = (w.pattern || 0) + (w.feel || 0) + (w.sound || 0) + (w.position || 0) || 1;
    return { total: +(((w.pattern || 0) * pattern + (w.feel || 0) * feel + (w.sound || 0) * sound + (w.position || 0) * position) / ws).toFixed(4), pattern: +pattern.toFixed(3), feel: +feel.toFixed(3), sound: +sound.toFixed(3), position: +position.toFixed(3) };
  },
  /** seam compatibility: how cleanly `loop` follows `ref` (lower is better); uses the Sequence seam analysis */
  seamCompat(ref, loop, ctx) {
    if (!ref || ref.isCentroid) return null; const key = `${ref.id}→${loop.id}`; if (ctx.seamCache && ctx.seamCache.has(key)) return ctx.seamCache.get(key);
    const arr = { id: 'tmp', name: 'tmp', blocks: [{ id: 'a', loopId: ref.id, repeats: 1, gainDb: 0 }, { id: 'b', loopId: loop.id, repeats: 1, gainDb: 0 }], markers: [], settings: { seamFadeMs: 0, levelMatch: false }, seams: [] };
    const seams = Sequence.seams(arr, ctx.lib); const s = seams.find(x => x.kind === 'junction'); let out = null;
    if (s) { const sev = { green: 0, amber: 1, red: 2, grey: 1.5 }[s.severity] ?? 1; out = { score: +(sev * 3 + Math.abs(s.levelStepDb || 0) / 2 + Math.abs(s.feelStepMs || 0) / 10 + (s.pushedDownbeat ? 3 : 0) + (Math.abs(s.hatRateChange || 0) > 0.3 ? 1 : 0)).toFixed(2), verdict: s.verdict, severity: s.severity, levelStepDb: s.levelStepDb, feelStepMs: s.feelStepMs }; }
    if (ctx.seamCache) ctx.seamCache.set(key, out); return out;
  },

  /* ---------- sort keys ---------- */
  keys() {
    const rec = (l, ctx) => ctx.rec(l); const claude = (l, ctx) => { const r = rec(l, ctx); return r ? r.score : null; };
    return [
      { key: 'position', label: 'song position (PT bar)', dir: 1, get: (l) => l.ptStart ?? 1e9 },
      { key: 'similarity', label: 'similarity to reference', dir: 1, get: (l, ctx) => { const d = this.distance(ctx.reference, l, ctx.weights); return d ? d.total : 1e9; } },
      { key: 'length', label: 'length', dir: 1, get: (l) => { const k = this.lengthKey(l); return k === 'event' ? 99 : +k; } },
      { key: 'rating', label: 'my rating', dir: -1, get: (l) => l.rating ?? null, nullsLast: true },
      { key: 'claude', label: 'imported rating', dir: -1, get: (l, ctx) => claude(l, ctx), nullsLast: true, hiddenLabel: 'reveals the imported order' },
      { key: 'weakest', label: 'imported weakest bar', dir: -1, get: (l, ctx) => { const r = rec(l, ctx); return r ? r.loop : null; }, nullsLast: true, hiddenLabel: 'reveals the imported order' },
      { key: 'ownPattern', label: 'own-pattern score', dir: -1, get: (l, ctx) => { const r = rec(l, ctx); return r ? r.ownPattern : null; }, nullsLast: true, hiddenLabel: 'reveals the imported order' },
      { key: 'section', label: 'section (song order)', dir: 1, get: (l, ctx) => this.sectionOrder(ctx).get((rec(l, ctx) || {}).section || '') ?? 1e9 },
      { key: 'use', label: 'use tag', dir: 1, get: (l, ctx) => (rec(l, ctx) || {}).use || '~' },
      { key: 'feel', label: 'feel (behind → ahead)', dir: -1, get: (l) => this.feelOf(l), nullsLast: true },
      { key: 'hats', label: 'hats (light → full)', dir: 1, get: (l, ctx) => { const r = rec(l, ctx); if (r && typeof r.hatDb === 'number') return r.hatDb; const s = this.soundOf(l); return s.high ?? null; }, nullsLast: true },
      { key: 'loudness', label: 'loudness (RMS)', dir: -1, get: (l) => l.rmsDb ?? null, nullsLast: true },
      { key: 'machine', label: 'machine score', dir: -1, get: (l) => (l.machine && l.machine.score !== undefined ? l.machine.score : null), nullsLast: true, hiddenLabel: 'reveals the machine order' },
      { key: 'disagreement', label: '|mine − imported|', dir: -1, get: (l, ctx) => { const c = claude(l, ctx); return l.rating !== null && l.rating !== undefined && c !== null && c !== undefined ? Math.abs(l.rating - c) : null; }, nullsLast: true, revealedOnly: true },
      { key: 'listens', label: 'least listened first', dir: 1, get: (l) => l.listens || 0 },
      { key: 'recent', label: 'most recently rated', dir: -1, get: (l) => l.ratedAt || '', nullsLast: true },
      { key: 'seam', label: 'seam compatibility with reference', dir: 1, get: (l, ctx) => { const s = this.seamCompat(ctx.reference, l, ctx); return s ? s.score : 1e9; } },
      { key: 'random', label: 'random (seeded)', dir: 1, get: (l, ctx) => this.hash(`${ctx.seed}:${l.id}`) },
    ];
  },
  keyByName(name) { return this.keys().find(k => k.key === name) || this.keys()[0]; },
  sectionOrder(ctx) {
    if (ctx._sectionOrder) return ctx._sectionOrder;
    const first = new Map();
    for (const l of ctx.lib.loops) { const r = ctx.rec(l); if (!r || !r.section) continue; const s = r.section; const p = l.ptStart ?? 1e9; if (!first.has(s) || p < first.get(s)) first.set(s, p); }
    const order = new Map(Array.from(first.entries()).sort((a, b) => a[1] - b[1]).map(([s], i) => [s, i]));
    ctx._sectionOrder = order; return order;
  },
  sections(ctx) { return Array.from(this.sectionOrder(ctx).keys()); },
  hash(str) { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; },
  seededShuffle(loops, seed) { return loops.slice().sort((a, b) => this.hash(`${seed}:${a.id}`) - this.hash(`${seed}:${b.id}`)); },

  /** stable sort by primary key (+ direction), then secondary key, then song position; null values last (or first) */
  sort(loops, { key = 'position', dir = null, secondary = null, unratedFirst = false, ctx }) {
    const K = this.keyByName(key), S = secondary ? this.keyByName(secondary) : null; const d = dir || K.dir, d2 = S ? S.dir : 1;
    if (key === 'similarity' && ctx.reference && !ctx.reference.isCentroid) { const ref = loops.find(l => l.id === ctx.reference.id); const rest = loops.filter(l => l !== ref); const sorted = this._sortBy(rest, K, d, S, d2, unratedFirst, ctx); return ref ? [ref, ...sorted] : sorted; }
    return this._sortBy(loops, K, d, S, d2, unratedFirst, ctx);
  },
  _sortBy(loops, K, d, S, d2, unratedFirst, ctx) {
    const val = (k, l) => k.get(l, ctx);
    const cmpVal = (a, b, dir, nullsLast) => { const an = a === null || a === undefined, bn = b === null || b === undefined; if (an && bn) return 0; if (an) return nullsLast ? 1 : -1; if (bn) return nullsLast ? -1 : 1; if (typeof a === 'string' || typeof b === 'string') return dir * String(a).localeCompare(String(b), undefined, { numeric: true }); return dir * (a - b); };
    const nullsLast = K.key === 'rating' ? !unratedFirst : (K.nullsLast !== false);
    return loops.map((l, i) => ({ l, i, a: val(K, l), b: S ? val(S, l) : null })).sort((x, y) => cmpVal(x.a, y.a, d, nullsLast) || (S ? cmpVal(x.b, y.b, d2, S.nullsLast !== false) : 0) || ((x.l.ptStart ?? 1e9) - (y.l.ptStart ?? 1e9)) || (x.i - y.i)).map(x => x.l);
  },

  /* ---------- filters ---------- */
  emptyFilters() { return { length: new Set(), section: new Set(), act: new Set(), use: new Set(), hats: new Set(), bass: '', fill: false, brk: false, variant: false, rated: '', ratingMin: null, claudeMin: null, barRange: null, text: '' }; },
  apply(loops, f, ctx) {
    const q = (f.text || '').trim().toLowerCase();
    return loops.filter(l => {
      const r = ctx.rec(l) || {};
      if (f.length.size && !f.length.has(this.lengthKey(l))) return false;
      if (f.section.size && !f.section.has(r.section || '')) return false;
      if (f.act.size && !f.act.has(r.act || '')) return false;
      if (f.use.size && !f.use.has(r.use || '')) return false;
      if (f.hats.size && !f.hats.has(r.hats || '')) return false;
      if (f.bass === 'in' && this.bassOut(l, r)) return false; if (f.bass === 'out' && !this.bassOut(l, r)) return false;
      if (f.fill && !(r.fills && r.fills.length)) return false; if (f.brk && !(r.breaks && r.breaks.length)) return false;
      if (f.variant && !r.variant) return false;
      const rated = l.rating !== null && l.rating !== undefined;
      if (f.rated === 'rated' && !rated) return false; if (f.rated === 'unrated' && (rated || l.skipped)) return false; if (f.rated === 'skipped' && !l.skipped) return false;
      if (f.ratingMin !== null && f.ratingMin !== undefined && !(rated && l.rating >= f.ratingMin)) return false;
      if (f.claudeMin !== null && f.claudeMin !== undefined && ctx.revealed(l) && !(typeof r.score === 'number' && r.score >= f.claudeMin)) return false;
      if (f.barRange && !(l.ptStart !== null && l.ptStart !== undefined && l.ptStart >= f.barRange[0] && (l.ptEnd - 1) <= f.barRange[1])) return false;
      if (q && !(l.id.toLowerCase().includes(q) || (l.tags || []).some(t => t.toLowerCase().includes(q)) || (l.notes || '').toLowerCase().includes(q) || (r.section || '').toLowerCase().includes(q) || (r.use || '').toLowerCase().includes(q))) return false;
      return true;
    });
  },
  groupBySection(loops, ctx) {
    const order = this.sectionOrder(ctx); const groups = new Map();
    for (const l of loops) { const s = (ctx.rec(l) || {}).section || '(no section)'; if (!groups.has(s)) groups.set(s, []); groups.get(s).push(l); }
    return Array.from(groups.entries()).sort((a, b) => (order.get(a[0]) ?? 1e9) - (order.get(b[0]) ?? 1e9)).map(([section, ls]) => ({ section, loops: ls }));
  },
};

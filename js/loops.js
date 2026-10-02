/* loops.js — LoopLibrary: the Loop Lab document (loops.json), the loop
 * entries, session signature/classification glue, sidecar layers and exports.
 * Audio and DSP live elsewhere; this module holds state and JSON. */
'use strict';

const LOOPS_SCHEMA_VERSION = 2;   // v1 files load unchanged (migration adds an empty arrangements list)
const IMPORTED_LAYER_NAME = 'Imported';
const DEFAULT_THRESHOLDS = { tightMs: 8, feelMs: 20, flamMs: 60, dynamicsDb: 6, expectedShare: 0.75, farMs: 60 };
const DEFAULT_CORE = { kick: [0, 8], snare: [4, 11] };
const CLASS_COLORS = { tight: '#8ee66b', feel: '#3fb0ff', extra: '#8b95a5', mistake: '#ff4d6d', ignore: '#555c66', missing: '#ff4d6d' };

class LoopLibrary {
  constructor() {
    this.session = { name: '', bpm: 108, meterNumerator: 4, meterDenominator: 4, sourceNote: 'loops start on bar 1 beat 1', thresholds: Object.assign({}, DEFAULT_THRESHOLDS), corePositions: U.deepClone(DEFAULT_CORE), bandFloorsDb: { low: null, mid: null, high: null } };
    this.loops = []; this.layers = []; this.history = []; this.arrangements = [];
    this.sig = null; this.sigBasis = 'session';
    this.extra = { doc: {}, session: {} };
    this.listeners = new Set();
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what = {}) { for (const fn of this.listeners) fn(what); }

  get grid() { return OnsetDsp.gridInfo(this.session.bpm, this.session.meterNumerator, this.session.meterDenominator); }
  loop(id) { return this.loops.find(l => l.id === id) || null; }

  /* ---------- names ---------- */
  /** "83-84.wav" | "129–132" | "9-16" | "83" → {start,end} or null */
  static parseBarRange(name) {
    const base = String(name || '').replace(/\.[^.]+$/, '');
    // leading "83-84", "129–132", "9-16", or a single bar "324 (fill into the break)"
    const m = /^\s*(\d+)(?:\s*[-–—]\s*(\d+))?/.exec(base);
    if (!m) return null;
    const a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a; return { start: Math.min(a, b), end: Math.max(a, b) };
  }
  /** sidecar ids like "324-324" name a single bar: normalise to "324" (the app's id for that file) */
  static normalizeId(id) { const r = LoopLibrary.parseBarRange(String(id)); return r && String(id).trim() === `${r.start}-${r.end}` && r.start === r.end ? String(r.start) : String(id); }
  static rangeId(r) { return r ? (r.start === r.end ? String(r.start) : `${r.start}-${r.end}`) : null; }
  uniqueId(base) { if (!this.loops.some(l => l.id === base)) return base; for (let i = 2; i < 1000; i++) { const id = `${base} (${i})`; if (!this.loops.some(l => l.id === id)) return id; } return base + Date.now(); }

  /* ---------- entries ---------- */
  computeBars(entry) {
    const g = this.grid; const bars = (entry.durationSeconds - (entry.offsetSamples || 0) / entry.sampleRate) / g.barSec;
    entry.bars = +bars.toFixed(4);
    const r = Math.max(1, Math.round(bars));
    entry.barsExact = Math.abs(bars - r) <= 0.005 * r;
    entry.barsRounded = r;
  }
  /** Create (or re-link) an entry from a parsed WavInfo + File. */
  addFromInfo(info, file) {
    // Re-link rule: same fingerprint AND same file name, or an unlinked entry with the same name.
    // (Two short loops that differ only in their last few ms share a fingerprint — it hashes the first MiB.)
    const existing = this.loops.find(l => l.fingerprint === info.fingerprint && l.fileName === info.fileName) || this.loops.find(l => !l._file && (l.fileName === info.fileName || l.fingerprint === info.fingerprint));
    if (existing) { existing._file = file; existing._buffer = null; existing.fingerprint = info.fingerprint; existing.sampleRate = info.sampleRate; existing.channels = info.channels; existing.bitDepth = info.bitDepth; existing.durationSeconds = info.durationSeconds; this.computeBars(existing); this.emit({ label: 'relink' }); return { entry: existing, relinked: true }; }
    const range = LoopLibrary.parseBarRange(info.fileName);
    const entry = {
      id: this.uniqueId(LoopLibrary.rangeId(range) || U.basename(info.fileName)), fileName: info.fileName, fingerprint: info.fingerprint,
      sampleRate: info.sampleRate, channels: info.channels, bitDepth: info.bitDepth || 0, durationSeconds: +info.durationSeconds.toFixed(6),
      bars: 0, barsExact: true, barRange: range, offsetSamples: 0,
      rating: null, tags: [], notes: '', status: '', ratedAt: null,
      blind: null, listens: 0, skipped: false, myClass: null, folder: '', ptStart: range ? range.start : null, ptEnd: range ? range.end + 1 : null,
      machine: {}, hits: [], missing: [], stemVerified: false, rmsDb: null,
      _file: file, _url: null, _buffer: null, _peaks: null, _analysed: false, _join: null, _floors: null, _stems: {},
    };
    this.computeBars(entry);
    this.loops.push(entry);
    this.emit({ label: 'add loop' });
    return { entry, relinked: false };
  }
  /** Create or re-link an entry from a library manifest record (audio is fetched on demand from `url`). */
  addFromManifest(m, url) {
    const existing = this.loops.find(l => l.fingerprint === m.fingerprint && l.fileName === m.fileName) || this.loops.find(l => !l._file && !l._url && (l.fileName === m.fileName || l.fingerprint === m.fingerprint));
    const range = m.ptStart !== null && m.ptStart !== undefined ? { start: m.ptStart, end: m.ptEnd - 1 } : LoopLibrary.parseBarRange(m.fileName);
    if (existing) { Object.assign(existing, { _url: url, _buffer: null, fingerprint: m.fingerprint, sampleRate: m.sampleRate, channels: m.channels, bitDepth: m.bitDepth || 0, durationSeconds: m.durationSeconds, folder: m.folder || existing.folder, ptStart: range ? range.start : null, ptEnd: range ? range.end + 1 : null }); if (!existing.barRange && range) existing.barRange = range; this.computeBars(existing); return { entry: existing, relinked: true }; }
    const entry = {
      id: this.uniqueId(m.id || LoopLibrary.rangeId(range) || U.basename(m.fileName)), fileName: m.fileName, fingerprint: m.fingerprint,
      sampleRate: m.sampleRate, channels: m.channels, bitDepth: m.bitDepth || 0, durationSeconds: m.durationSeconds,
      bars: 0, barsExact: true, barRange: range, offsetSamples: 0, folder: m.folder || '', ptStart: range ? range.start : null, ptEnd: range ? range.end + 1 : null,
      rating: null, tags: [], notes: '', status: '', ratedAt: null, blind: null, listens: 0, skipped: false, myClass: null,
      machine: {}, hits: [], missing: [], stemVerified: false, rmsDb: null,
      _file: null, _url: url, _buffer: null, _peaks: null, _analysed: false, _join: null, _floors: null, _stems: {},
    };
    this.computeBars(entry); this.loops.push(entry); return { entry, relinked: false };
  }
  removeLoop(id) { this.loops = this.loops.filter(l => l.id !== id); this.recompute(); this.emit({ label: 'remove loop' }); }

  /** Raw DSP hits (ms, drum, levelDb) → stored hits with grid assignment; keeps manual drum corrections and overrides by time. */
  setRawHits(entry, raw, { stemVerified = false } = {}) {
    const g = this.grid, sr = entry.sampleRate, T = this.session.thresholds;
    const old = entry.hits || [];
    const offSec = (entry.offsetSamples || 0) / sr;
    const hits = raw.map(h => {
      const tSec = h.ms / 1000; const a = OnsetDsp.assign(tSec - offSec, g, entry.barsRounded || Math.max(1, Math.round(entry.bars)), T.farMs);
      const samples = Math.round(tSec * sr);
      const prev = old.find(o => Math.abs(o.samples - samples) <= sr * 0.002 && (o.detectedDrum || o.drum) === h.drum);
      const hit = { id: prev ? prev.id : U.uid('h'), drum: h.drum, detectedDrum: h.drum, bar: a.bar, pos: a.pos, tSeconds: +tSec.toFixed(4), samples, devMs: +a.devMs.toFixed(1), residualMs: null, levelDb: +h.levelDb.toFixed(1), class: 'extra', mistakeType: null, far: a.far, override: null };
      if (prev) { if (prev.drum !== prev.detectedDrum) hit.drum = prev.drum; hit.override = prev.override || null; }
      return hit;
    });
    entry.hits = hits; entry.stemVerified = stemVerified; entry._analysed = true;
  }
  setHitDrum(loopId, hitId, drum) { const l = this.loop(loopId), h = l && l.hits.find(x => x.id === hitId); if (!h) return; h.drum = drum; this.recompute(); this.emit({ label: 'correct drum' }); }
  setHitOverride(loopId, hitId, cls, reason = '') { const l = this.loop(loopId), h = l && l.hits.find(x => x.id === hitId); if (!h) return; h.override = cls ? { class: cls, reason } : null; this.recompute(); this.emit({ label: 'override' }); }

  /* ---------- session computation ---------- */
  recompute() {
    const T = this.session.thresholds;
    const analysed = this.loops.filter(l => l.hits && l.hits.length);
    const pooled = analysed.length >= 3;
    this.sigBasis = pooled ? 'session' : 'loop';
    const sessionSig = pooled ? OnsetDsp.buildSignature(analysed, { expectedShare: T.expectedShare }) : null;
    this.sig = sessionSig;
    for (const l of this.loops) {
      if (!l.hits || !l.hits.length) { l.missing = []; l.machine = l.machine || {}; continue; }
      const sig = pooled ? sessionSig : OnsetDsp.buildSignature([l], { expectedShare: T.expectedShare });
      if (!pooled && !this.sig) this.sig = sig;
      const c = OnsetDsp.classifyLoop(l, sig, T, this.session.corePositions);
      l.hits = c.hits; l.missing = c.missing;
      l.machine = OnsetDsp.loopMetrics(c.hits, c.missing, sig, this.session.corePositions, l._join);
      l._sig = sig;
    }
    this.session.signature = this.sig ? this.sig.signature : {};
    this.session.expected = this.sig ? this.sig.expected : { odd: {}, even: {} };
    this.session.signatureBasis = this.sigBasis;
  }

  /* ---------- ratings ---------- */
  static formatRating(r) { return r === null || r === undefined ? '' : (Math.round(r * 10) / 10).toFixed(1); }
  static clampRating(r) { if (r === null || r === undefined || r === '' || isNaN(r)) return null; return Math.max(0, Math.min(9.9, Math.round(r * 10) / 10)); }
  setRating(id, rating, notes, tags) {
    const l = this.loop(id); if (!l) return;
    l.rating = LoopLibrary.clampRating(rating); if (notes !== undefined) l.notes = notes; if (tags !== undefined) l.tags = tags;
    l.ratedAt = U.nowIso(); this.emit({ label: 'rate' });
  }

  /* ---------- document ---------- */
  buildDocument() {
    const loops = this.loops.map(l => {
      const o = {}; for (const k of Object.keys(l)) if (!k.startsWith('_')) o[k] = l[k];
      return o;
    });
    return Object.assign({}, this.extra.doc, {
      schemaVersion: LOOPS_SCHEMA_VERSION, app: { name: APP_NAME, version: APP_VERSION },
      session: Object.assign({}, this.extra.session, this.session, this.libraryMeta ? { library: this.libraryMeta } : {}),
      loops, layers: this.layers, arrangements: this.arrangements, history: this.history,
    });
  }
  parseDocument(text) {
    const errors = [], warnings = []; let doc;
    try { doc = JSON.parse(text); } catch (e) { return { doc: null, errors: [`Not valid JSON: ${e.message}`], warnings }; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { doc: null, errors: ['The file does not contain a JSON object.'], warnings };
    if (doc.schemaVersion === undefined) errors.push('Missing "schemaVersion" — is this a loops.json file?');
    else if (doc.schemaVersion > LOOPS_SCHEMA_VERSION) warnings.push(`Schema version ${doc.schemaVersion} is newer than this app (${LOOPS_SCHEMA_VERSION}); loading anyway.`);
    else if (doc.schemaVersion === 1) { doc.arrangements = doc.arrangements || []; doc._migratedFrom = 1; }
    if (doc.notes && doc.track && !doc.loops) errors.push('This looks like a Track-mode notes file, not a loops.json.');
    for (const e of validateSchema(LOOPS_SCHEMA, doc)) errors.push(`${e.path}: ${e.message}`);
    return { doc: errors.length ? null : doc, errors, warnings };
  }
  /** Replace the library with a parsed document. Existing File handles are re-attached by fingerprint / name. */
  applyDocument(doc) {
    const files = new Map(); for (const l of this.loops) if (l._file) { files.set(l.fingerprint, l._file); files.set('name:' + l.fileName, l._file); }
    const known = ['schemaVersion', 'app', 'session', 'loops', 'layers', 'history', 'arrangements', '_migratedFrom'];
    this.extra.doc = {}; for (const k of Object.keys(doc)) if (!known.includes(k)) this.extra.doc[k] = doc[k];
    const sKnown = ['name', 'bpm', 'meterNumerator', 'meterDenominator', 'sourceNote', 'signature', 'signatureBasis', 'expected', 'thresholds', 'corePositions', 'bandFloorsDb'];
    this.extra.session = {}; for (const k of Object.keys(doc.session || {})) if (!sKnown.includes(k)) this.extra.session[k] = doc.session[k];
    const s = doc.session || {};
    this.session = { name: s.name || '', bpm: s.bpm || 108, meterNumerator: s.meterNumerator || 4, meterDenominator: s.meterDenominator || 4, sourceNote: s.sourceNote || '',
      thresholds: Object.assign({}, DEFAULT_THRESHOLDS, s.thresholds || {}), corePositions: s.corePositions || U.deepClone(DEFAULT_CORE), bandFloorsDb: Object.assign({ low: null, mid: null, high: null }, s.bandFloorsDb || {}) };
    this.loops = (doc.loops || []).map(l => {
      const e = Object.assign({ bars: 0, barsExact: true, barRange: null, offsetSamples: 0, rating: null, tags: [], notes: '', status: '', ratedAt: null, blind: null, listens: 0, skipped: false, myClass: null, folder: '', ptStart: null, ptEnd: null, machine: {}, hits: [], missing: [], stemVerified: false, channels: 2, bitDepth: 0, fingerprint: null }, l);
      if (e.ptStart === null && e.barRange) { e.ptStart = e.barRange.start; e.ptEnd = e.barRange.end + 1; }
      e.rating = LoopLibrary.clampRating(e.rating);
      for (const h of e.hits) { if (!h.id) h.id = U.uid('h'); if (!h.detectedDrum) h.detectedDrum = h.drum; if (h.tSeconds === undefined) h.tSeconds = h.samples / e.sampleRate; if (h.override === undefined) h.override = null; if (h.far === undefined) h.far = false; }
      e._file = files.get(e.fingerprint) || files.get('name:' + e.fileName) || null; e._url = null; e._buffer = null; e._peaks = null; e._analysed = e.hits.length > 0; e._join = e.machine && e.machine.join ? { verdict: e.machine.join, detail: e.machine.joinDetail || {} } : null; e._stems = {};
      this.computeBars(e);
      return e;
    });
    this.layers = doc.layers || []; this.history = doc.history || [];
    this.arrangements = (doc.arrangements || []).map(a => Object.assign({ createdAt: U.nowIso(), updatedAt: U.nowIso(), notes: '', markers: [], settings: { seamFadeMs: 0, levelMatch: true }, seams: [] }, a, { blocks: (a.blocks || []).map(b => Object.assign({ fingerprint: null, gainDb: 0, notes: '', repeats: 1 }, b)) }));
    if (doc._migratedFrom === 1) this.history.push({ at: U.nowIso(), event: 'migrated', from: 1, to: LOOPS_SCHEMA_VERSION });
    this.recompute(); this.emit({ label: 'load' });
  }

  /* ---------- sidecar ---------- */
  importSidecar(json, { name = null } = {}) {
    const errors = validateSchema(LOOPS_SCHEMA.$defs.claudeSidecar, json, LOOPS_SCHEMA).map(e => `${e.path}: ${e.message}`);
    if (errors.length) return { errors };
    const date = (json.createdAt || U.nowIso()).slice(0, 10);
    const layerName = name || (this.layers.some(l => l.name === IMPORTED_LAYER_NAME) ? `Imported ${date}` : IMPORTED_LAYER_NAME);
    const layer = { id: U.uid('L'), name: layerName, kind: 'imported', createdAt: U.nowIso(), source: json.source || null, signature: json.signature || {}, loops: {} };
    const matched = [], unmatched = [];
    layer.scale = json.scale || null; layer.barConvention = json.barConvention || null;
    for (const sl of json.loops) {
      const nid = LoopLibrary.normalizeId(sl.id);
      const target = this.loops.find(l => l.id === sl.id || l.id === nid) || (sl.fingerprint && this.loops.find(l => l.fingerprint === sl.fingerprint)) || (sl.fileNameHint && this.loops.find(l => l.fileName === sl.fileNameHint)) || this.loops.find(l => l.fileName === sl.id + '.wav') || (sl.ptStart !== undefined && this.loops.find(l => l.ptStart === sl.ptStart && l.ptEnd === sl.ptEnd));
      // every extra field (folder, section, use, hats, perBar, …) rides along unchanged
      const rec = Object.assign({}, sl, { score: sl.score ?? null, tight: sl.tight ?? null, loop: sl.loop ?? null, ownPattern: sl.ownPattern ?? null, notes: sl.notes || '', hits: sl.hits || [], missing: sl.missing || [] });
      if (target) { layer.loops[target.id] = rec; matched.push(target.id); } else { layer.loops[sl.id] = rec; unmatched.push(sl.id); }
    }
    this.layers.push(layer);
    this.history.push({ at: U.nowIso(), event: 'sidecar-imported', layer: layer.name, matched: matched.length, unmatched });
    this.emit({ label: 'import layer' });
    return { layer, matched, unmatched, errors: [] };
  }
  removeLayer(id) { this.layers = this.layers.filter(l => l.id !== id); this.emit({ label: 'remove layer' }); }
  /** Pair app hits with a layer's hits for one loop: by (drum, bar, pos), else by time within 25 ms. */
  compareWithLayer(loopId, layerId) {
    const l = this.loop(loopId), layer = this.layers.find(x => x.id === layerId); if (!l || !layer || !layer.loops[loopId]) return null;
    const theirs = (layer.loops[loopId].hits || []).map(h => Object.assign({}, h)); const used = new Set(); const pairs = [];
    for (const h of l.hits) {
      let j = theirs.findIndex((t, i) => !used.has(i) && t.drum === h.drum && t.bar === h.bar && t.pos === h.pos);
      if (j < 0 && typeof h.tSeconds === 'number') j = theirs.findIndex((t, i) => !used.has(i) && t.drum === h.drum && typeof t.tSeconds === 'number' && Math.abs(t.tSeconds - h.tSeconds) < 0.025);
      const t = j >= 0 ? theirs[j] : null; if (j >= 0) used.add(j);
      pairs.push({ ours: h, theirs: t, disagree: !!(t && t.class && t.class !== h.class) });
    }
    theirs.forEach((t, i) => { if (!used.has(i)) pairs.push({ ours: null, theirs: t, disagree: true }); });
    return { pairs, disagreements: pairs.filter(p => p.disagree).length, theirMissing: layer.loops[loopId].missing || [] };
  }

  /* ---------- exports ---------- */
  ranked() {
    return this.loops.slice().sort((a, b) => ((b.rating ?? -1) - (a.rating ?? -1)) || (((b.machine && b.machine.score) ?? -1) - ((a.machine && a.machine.score) ?? -1)) || a.id.localeCompare(b.id, undefined, { numeric: true }));
  }
  exportMarkdown() {
    const s = this.session; const L = [`# Loop ranking — ${s.name || 'session'}`, '', `- ${s.bpm} BPM ${s.meterNumerator}/${s.meterDenominator} · ${this.loops.length} loops · exported ${U.nowIso()}`, ''];
    if (this.sig) { L.push(`## Signature (${this.sigBasis === 'session' ? 'session median' : 'per-loop, fewer than 3 loops'})`, ''); for (const d of Object.keys(this.sig.signature)) L.push(`- ${d}: ` + Object.entries(this.sig.signature[d]).map(([p, v]) => `${OnsetDsp.posName(+p)} ${v > 0 ? '+' : ''}${v} ms`).join(', ')); L.push(''); }
    L.push('| # | loop | bars | my rating | machine | consistency k/s/h (ms) | feel (ms) | mistakes | join | tags | notes |', '|---|---|---|---|---|---|---|---|---|---|---|');
    const layerCols = this.layers.map(l => l.name);
    this.ranked().forEach((l, i) => {
      const m = l.machine || {}; const c = m.consistencyMs || {}; const mk = m.mistakes || {};
      const mist = Object.entries(mk).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(', ') || '—';
      const layerNotes = this.layers.map(ly => ly.loops[l.id] ? `${ly.name}: ${ly.loops[l.id].score ?? '—'}` : '').filter(Boolean).join('; ');
      L.push(`| ${i + 1} | ${l.id} | ${l.bars.toFixed(2)}${l.barsExact ? '' : ' ⚠'} | ${LoopLibrary.formatRating(l.rating) || '—'} | ${m.score ?? '—'} | ${c.kick ?? '—'} / ${c.snare ?? '—'} / ${c.hat ?? '—'} | ${m.feelMs ?? '—'} | ${mist} | ${m.join || '—'} | ${(l.tags || []).join(' ')} | ${(l.notes || '').replace(/\|/g, '\\|').replace(/\n/g, ' ')}${layerNotes ? ' — ' + layerNotes : ''} |`);
    });
    void layerCols;
    return L.join('\n') + '\n';
  }
  exportCsv() {
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = [['rank', 'id', 'file', 'bars', 'rating', 'machine_score', 'consistency_kick_ms', 'consistency_snare_ms', 'consistency_hat_ms', 'feel_ms', 'push_1and_ms', 'hat_swing_ms', 'late', 'flam', 'missing', 'dynamics', 'far', 'join', 'tags', 'notes'].join(',')];
    this.ranked().forEach((l, i) => { const m = l.machine || {}, c = m.consistencyMs || {}, mk = m.mistakes || {}; rows.push([i + 1, esc(l.id), esc(l.fileName), l.bars.toFixed(3), LoopLibrary.formatRating(l.rating), m.score ?? '', c.kick ?? '', c.snare ?? '', c.hat ?? '', m.feelMs ?? '', m.push1andMs ?? '', m.hatSwingMs ?? '', mk.late || 0, mk.flam || 0, mk.missing || 0, mk.dynamics || 0, mk.far || 0, m.join || '', esc((l.tags || []).join(' ')), esc(l.notes || '')].join(',')); });
    return rows.join('\n') + '\n';
  }
}

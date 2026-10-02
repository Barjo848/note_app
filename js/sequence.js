/* sequence.js — Sequence: arrangements of loops end to end, seam analysis,
 * cue lists and standalone export/import. Blocks and markers are the source
 * of truth; seams[] is a cache recomputed on every change.
 *
 * Layout: every block occurrence (block × repeat) sits immediately after the
 * previous one at its loop's ACTUAL file length (samples), never the nominal
 * bar length. Arrangement bars are counted from the loops' rounded bar counts.
 *
 * Seam metrics (after trims and level match): the level step is the incoming
 * loop's first beat against the outgoing loop's first beat — like for like,
 * so a loop's own downbeat accent is not reported as a jump (the raw last
 * beat / first beat RMS and peaks are kept for display); the same for the
 * high band; hat rate; feel step (from the loops' metrics); signature
 * differences (expected-hit sets); pushed downbeat and leading onset (from
 * the join analysis); tail cut against the loop's 25th-percentile envelope
 * floor; and the raw sample discontinuity at the join. */
'use strict';

const SEAM_T = { levelAmber: 2, levelRed: 4, feelAmber: 12, feelRed: 20, highDb: 4, hatRate: 0.3, tailDb: 6, sampleStep: 0.05, pushedMs: 15, leadMs: 5 };

class SequenceStore {
  constructor(lib) { this.lib = lib; this.undoStack = []; this.redoStack = []; this.listeners = new Set(); this.maxUndo = 200; }
  get arrangements() { return this.lib.arrangements; }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(what = {}) { for (const fn of this.listeners) fn(what); }
  snapshot() { return U.deepClone(this.lib.arrangements); }
  commit(label, fn) {
    this.undoStack.push({ label, state: this.snapshot() }); if (this.undoStack.length > this.maxUndo) this.undoStack.shift(); this.redoStack.length = 0;
    const r = fn(this); this.touch(); this.emit({ label }); return r;
  }
  touch() { for (const a of this.lib.arrangements) { a.updatedAt = a.updatedAt || U.nowIso(); } }
  get canUndo() { return this.undoStack.length > 0; } get canRedo() { return this.redoStack.length > 0; }
  undo() { const u = this.undoStack.pop(); if (!u) return null; this.redoStack.push({ label: u.label, state: this.snapshot() }); this.lib.arrangements = u.state; this.emit({ label: 'undo ' + u.label, undo: true }); return u.label; }
  redo() { const r = this.redoStack.pop(); if (!r) return null; this.undoStack.push({ label: r.label, state: this.snapshot() }); this.lib.arrangements = r.state; this.emit({ label: 'redo ' + r.label, undo: true }); return r.label; }
  clearHistory() { this.undoStack.length = 0; this.redoStack.length = 0; }
  get(id) { return this.lib.arrangements.find(a => a.id === id) || null; }
  uniqueName(base) { const names = new Set(this.lib.arrangements.map(a => a.name)); if (!names.has(base)) return base; for (let i = 2; i < 999; i++) if (!names.has(`${base} ${i}`)) return `${base} ${i}`; return base + Date.now(); }
  create(name = 'arrangement') { return this.commit('new arrangement', () => { const a = Sequence.newArrangement(this.uniqueName(name)); this.lib.arrangements.push(a); return a; }); }
  duplicate(id) { return this.commit('duplicate arrangement', () => { const src = this.get(id); if (!src) return null; const c = U.deepClone(src); c.id = U.uid('arr'); c.name = this.uniqueName(src.name + ' copy'); c.createdAt = U.nowIso(); c.updatedAt = c.createdAt; for (const b of c.blocks) b.id = U.uid('blk'); this.lib.arrangements.push(c); return c; }); }
  rename(id, name) { return this.commit('rename arrangement', () => { const a = this.get(id); if (a && name.trim()) { a.name = this.uniqueName(name.trim()); a.updatedAt = U.nowIso(); } return a; }); }
  remove(id) { return this.commit('delete arrangement', () => { this.lib.arrangements = this.lib.arrangements.filter(a => a.id !== id); }); }
  setNotes(id, notes) { const a = this.get(id); if (a) { a.notes = notes; a.updatedAt = U.nowIso(); this.emit({ label: 'notes' }); } }
  _blockIndex(a, blockId) { return a.blocks.findIndex(b => b.id === blockId); }
  addBlock(arrId, loopId, index = null, { repeats = 1, gainDb = 0 } = {}) {
    return this.commit('add block', () => { const a = this.get(arrId), l = this.lib.loop(loopId); if (!a || !l) return null; const b = { id: U.uid('blk'), loopId: l.id, fingerprint: l.fingerprint || null, repeats: Math.max(1, Math.min(64, repeats)), gainDb, notes: '' }; const i = index === null ? a.blocks.length : Math.max(0, Math.min(a.blocks.length, index)); a.blocks.splice(i, 0, b); a.updatedAt = U.nowIso(); return b; });
  }
  moveBlock(arrId, blockId, newIndex) {
    return this.commit('move block', () => { const a = this.get(arrId); if (!a) return; const i = this._blockIndex(a, blockId); if (i < 0) return; const [b] = a.blocks.splice(i, 1); let j = Math.max(0, Math.min(a.blocks.length, newIndex > i ? newIndex - 1 : newIndex)); a.blocks.splice(j, 0, b); a.updatedAt = U.nowIso(); });
  }
  removeBlock(arrId, blockId) { return this.commit('remove block', () => { const a = this.get(arrId); if (!a) return; a.blocks = a.blocks.filter(b => b.id !== blockId); a.updatedAt = U.nowIso(); }); }
  duplicateBlock(arrId, blockId) { return this.commit('duplicate block', () => { const a = this.get(arrId); if (!a) return null; const i = this._blockIndex(a, blockId); if (i < 0) return null; const c = Object.assign({}, a.blocks[i], { id: U.uid('blk') }); a.blocks.splice(i + 1, 0, c); a.updatedAt = U.nowIso(); return c; }); }
  setBlock(arrId, blockId, patch) { return this.commit('edit block', () => { const a = this.get(arrId); const b = a && a.blocks.find(x => x.id === blockId); if (!b) return null; if (patch.repeats !== undefined) patch.repeats = Math.max(1, Math.min(64, Math.round(patch.repeats) || 1)); if (patch.gainDb !== undefined) patch.gainDb = Math.max(-12, Math.min(12, +patch.gainDb || 0)); Object.assign(b, patch); a.updatedAt = U.nowIso(); return b; }); }
  addMarker(arrId, bar, name) { return this.commit('add marker', () => { const a = this.get(arrId); if (!a) return; a.markers = (a.markers || []).filter(m => m.bar !== bar); a.markers.push({ bar: Math.max(1, Math.round(bar)), name: String(name || '').trim() || 'marker' }); a.markers.sort((x, y) => x.bar - y.bar); a.updatedAt = U.nowIso(); }); }
  removeMarker(arrId, bar) { return this.commit('remove marker', () => { const a = this.get(arrId); if (a) { a.markers = (a.markers || []).filter(m => m.bar !== bar); a.updatedAt = U.nowIso(); } }); }
  setSettings(arrId, patch) { return this.commit('arrangement settings', () => { const a = this.get(arrId); if (a) { a.settings = Object.assign({ seamFadeMs: 0, levelMatch: true }, a.settings || {}, patch); a.updatedAt = U.nowIso(); } }); }
}

const Sequence = {
  newArrangement(name) { const now = U.nowIso(); return { id: U.uid('arr'), name, createdAt: now, updatedAt: now, notes: '', blocks: [], markers: [], settings: { seamFadeMs: 0, levelMatch: true }, seams: [] }; },

  /* ---------- colours: stable per loop, ordered by session position ---------- */
  colorFor(loop, lib) {
    const order = lib.loops.slice().sort((a, b) => ((a.barRange ? a.barRange.start : 1e9) - (b.barRange ? b.barRange.start : 1e9)) || a.id.localeCompare(b.id, undefined, { numeric: true }));
    const i = Math.max(0, order.findIndex(l => l.id === loop.id)), n = Math.max(1, order.length);
    const hue = Math.round((i / n) * 320); return `hsl(${hue} 55% 48%)`;
  },
  ptBarOf(loop, localBar) { return loop.barRange && Number.isFinite(loop.barRange.start) ? loop.barRange.start + (localBar - 1) : null; },
  ptStartEnd(loop) { if (!loop.barRange) return null; return { start: `${loop.barRange.start}|1|000`, end: `${loop.barRange.end + 1}|1|000` }; },

  /* ---------- layout ---------- */
  levelMatchGainDb(arr, lib) {
    if (!arr.settings || arr.settings.levelMatch === false) return () => 0;
    const rms = arr.blocks.map(b => lib.loop(b.loopId)).filter(l => l && typeof l.rmsDb === 'number').map(l => l.rmsDb);
    if (!rms.length) return () => 0;
    const ref = OnsetDsp.median(rms);
    return (loop) => (typeof loop.rmsDb === 'number' ? ref - loop.rmsDb : 0);
  },
  layout(arr, lib) {
    const occ = []; let sec = 0, samples = 0, bar = 1; const bpb = lib.session.meterNumerator || 4; const lm = this.levelMatchGainDb(arr, lib);
    arr.blocks.forEach((block, blockIndex) => {
      const loop = lib.loop(block.loopId); if (!loop) { occ.push({ block, blockIndex, repeatIndex: 0, loop: null, missing: true, startSec: sec, lengthSec: 0, startBar: bar, bars: 0, startSample: samples, lengthSamples: 0, gainDb: 0, gainLin: 1, beatSec: 60 / lib.session.bpm }); return; }
      const bars = Math.max(1, loop.barsRounded || Math.round(loop.bars) || 1);
      const lengthSamples = Math.round(loop.durationSeconds * loop.sampleRate) - (loop.offsetSamples || 0);
      const lengthSec = lengthSamples / loop.sampleRate;
      const gainDb = (block.gainDb || 0) + lm(loop);
      for (let r = 0; r < block.repeats; r++) {
        occ.push({ block, blockIndex, repeatIndex: r, loop, startSec: sec, lengthSec, endSec: sec + lengthSec, startBar: bar, bars, startSample: samples, lengthSamples, gainDb, gainLin: Math.pow(10, gainDb / 20), beatSec: lengthSec / (bars * bpb), offsetSec: (loop.offsetSamples || 0) / loop.sampleRate });
        sec += lengthSec; samples += lengthSamples; bar += bars;
      }
    });
    return { occ, totalSeconds: sec, totalSamples: samples, totalBars: bar - 1, bpb };
  },
  /** arrangement bar → { occ, localBar, ptBar } */
  barInfo(layout, bar) {
    const o = layout.occ.find(x => bar >= x.startBar && bar < x.startBar + x.bars); if (!o) return null;
    const localBar = bar - o.startBar + 1; return { occ: o, localBar, ptBar: o.loop ? this.ptBarOf(o.loop, localBar) : null };
  },

  /* ---------- per-loop features from audio (cached on the loop) ---------- */
  loopFeatures(loop, buffer, lib) {
    const sr = buffer.sampleRate, bpb = lib.session.meterNumerator || 4; const bars = Math.max(1, loop.barsRounded || Math.round(loop.bars) || 1);
    const off = loop.offsetSamples || 0, n = buffer.length - off, beatN = Math.max(1, Math.round(n / (bars * bpb)));
    const chans = []; for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    const seg = (a, b) => { let p = 0, pk = 0, cnt = 0; for (const d of chans) for (let i = Math.max(0, a); i < Math.min(buffer.length, b); i++) { p += d[i] * d[i]; const v = Math.abs(d[i]); if (v > pk) pk = v; cnt++; } return { rms: U.powDb(cnt ? p / cnt : 0), peak: U.ampDb(pk) }; };
    const mono = new Float32Array(n); for (let i = 0; i < n; i++) { let s = 0; for (const d of chans) s += d[off + i]; mono[i] = s / chans.length; }
    const hp = OnsetDsp.runBiquads(mono, OnsetDsp.butter4('hp', 5000, sr));
    const segHigh = (a, b) => { let p = 0, cnt = 0; for (let i = Math.max(0, a); i < Math.min(n, b); i++) { p += hp[i] * hp[i]; cnt++; } return U.powDb(cnt ? p / cnt : 0); };
    const env = OnsetDsp.envelopeDb(mono, sr); const sortedEnv = Array.from(env).sort((a, b) => a - b); const floor = sortedEnv[Math.floor(sortedEnv.length * 0.25)] ?? -120;
    const last = seg(off + n - beatN, off + n), first = seg(off, off + beatN), tail = seg(off + n - Math.round(sr * 0.02), off + n);
    const hats = (loop.hits || []).filter(h => h.drum === 'hat' && h.class !== 'ignore'); const onBeat = hats.filter(h => h.pos % 4 === 0).length;
    const firstHit = (loop.hits || []).slice().sort((a, b) => a.samples - b.samples)[0];
    return {
      lastBeatRmsDb: +last.rms.toFixed(1), firstBeatRmsDb: +first.rms.toFixed(1), lastBeatPeakDb: +last.peak.toFixed(1), firstBeatPeakDb: +first.peak.toFixed(1),
      lastBeatHighDb: +segHigh(n - beatN, n).toFixed(1), firstBeatHighDb: +segHigh(0, beatN).toFixed(1),
      hatsPerBar: +(hats.length / bars).toFixed(2), hatOnBeatShare: hats.length ? +(onBeat / hats.length).toFixed(2) : null,
      tailRmsDb: +tail.rms.toFixed(1), floorDb: +floor.toFixed(1),
      pushedOnsetMs: loop._join && loop._join.detail && loop._join.detail.pushedOnsetMs !== undefined ? loop._join.detail.pushedOnsetMs : (loop.machine && loop.machine.joinDetail ? loop.machine.joinDetail.pushedOnsetMs ?? null : null),
      firstOnsetMs: firstHit ? +((firstHit.samples - off) / sr * 1000).toFixed(1) : null,
      firstSample: chans.map(d => +d[off].toFixed(5)), lastSample: chans.map(d => +d[off + n - 1].toFixed(5)),
    };
  },
  /** expected-hit set of ONE loop from its own hits: (drum,pos) present in ≥ 50 % of its bars */
  expectedSet(loop) {
    const bars = Math.max(1, loop.barsRounded || Math.round(loop.bars) || 1); const cnt = {};
    for (const h of loop.hits || []) { if (h.class === 'ignore' || h.drum === 'other') continue; const k = `${h.drum}:${h.pos}:${h.bar}`; cnt[k] = 1; }
    const per = {}; for (const k of Object.keys(cnt)) { const [d, p] = k.split(':'); per[`${d}:${p}`] = (per[`${d}:${p}`] || 0) + 1; }
    const out = { kick: [], snare: [], hat: [] }; for (const k of Object.keys(per)) { const [d, p] = k.split(':'); if (per[k] / bars >= 0.5 && out[d]) out[d].push(+p); }
    for (const d of Object.keys(out)) out[d].sort((a, b) => a - b); return out;
  },
  signatureDiff(out, inn) {
    const A = this.expectedSet(out), B = this.expectedSet(inn); const diffs = [];
    for (const d of ['kick', 'snare']) {
      const gone = A[d].filter(p => !B[d].includes(p)), added = B[d].filter(p => !A[d].includes(p));
      const list = (ps) => ps.length > 4 ? ps.slice(0, 4).map(OnsetDsp.posName).join(', ') + ` (+${ps.length - 4})` : ps.map(OnsetDsp.posName).join(', ');
      if (gone.length) diffs.push(`incoming loop has no ${d} on ${list(gone)}`);
      if (added.length) diffs.push(`incoming loop adds ${d} on ${list(added)}`);
    }
    const share = (l) => { const f = l.seamFeatures; return f && f.hatOnBeatShare !== null && f.hatOnBeatShare !== undefined ? f.hatOnBeatShare : null; };
    const sa = share(out), sb = share(inn);
    if (sa !== null && sb !== null && Math.abs(sa - sb) >= 0.3) diffs.push(sb > sa ? 'hats move onto the beats' : 'hats move onto the off-beats');
    return diffs;
  },

  /* ---------- seams ---------- */
  seams(arr, lib) {
    const L = this.layout(arr, lib); const seams = []; let index = 0;
    const T = SEAM_T;
    const mk = (outO, inO, kind) => {
      const a = outO.loop, b = inO.loop; if (!a || !b) return null;
      const fa = a.seamFeatures, fb = b.seamFeatures; const needsAudio = !fa || !fb;
      const s = { index: index++, from: outO.block.id, to: inO.block.id, kind, atBar: inO.startBar, fromLoop: a.id, toLoop: b.id, needsAudio,
        levelStepDb: null, peakOutDb: null, peakInDb: null, feelStepMs: null, highStepDb: null, hatRateChange: null, hatsOut: null, hatsIn: null, pushedDownbeat: false, pushedMs: null, startsWithOnset: false, tailCut: false, sampleStep: null, signatureDiff: [], verdict: 'clean', severity: 'green', care: '' };
      const fA = (a.machine && typeof a.machine.feelMs === 'number') ? a.machine.feelMs : null, fB = (b.machine && typeof b.machine.feelMs === 'number') ? b.machine.feelMs : null;
      if (fA !== null && fB !== null) s.feelStepMs = +(fB - fA).toFixed(1);
      if (a.hits && b.hits) s.signatureDiff = kind === 'repeat' ? [] : this.signatureDiff(a, b);
      if (!needsAudio) {
        s.levelStepDb = +((fb.firstBeatRmsDb + inO.gainDb) - (fa.firstBeatRmsDb + outO.gainDb)).toFixed(1);
        s.lastBeatRmsDb = +(fa.lastBeatRmsDb + outO.gainDb).toFixed(1); s.firstBeatRmsDb = +(fb.firstBeatRmsDb + inO.gainDb).toFixed(1);
        s.peakOutDb = +(fa.lastBeatPeakDb + outO.gainDb).toFixed(1); s.peakInDb = +(fb.firstBeatPeakDb + inO.gainDb).toFixed(1);
        s.highStepDb = +((fb.firstBeatHighDb + inO.gainDb) - (fa.firstBeatHighDb + outO.gainDb)).toFixed(1);
        s.hatsOut = fa.hatsPerBar; s.hatsIn = fb.hatsPerBar; s.hatRateChange = fa.hatsPerBar > 0 ? +((fb.hatsPerBar - fa.hatsPerBar) / fa.hatsPerBar).toFixed(2) : (fb.hatsPerBar > 0 ? 1 : 0);
        s.pushedDownbeat = fa.pushedOnsetMs !== null && fa.pushedOnsetMs !== undefined && fa.pushedOnsetMs >= -T.pushedMs; s.pushedMs = s.pushedDownbeat ? fa.pushedOnsetMs : null;
        s.startsWithOnset = fb.firstOnsetMs !== null && fb.firstOnsetMs !== undefined && fb.firstOnsetMs <= T.leadMs;
        s.tailCut = fa.tailRmsDb > fa.floorDb + T.tailDb && fa.tailRmsDb > -40 && !s.pushedDownbeat;
        const fade = (arr.settings && arr.settings.seamFadeMs) || 0;
        let step = 0; for (let c = 0; c < Math.min(fa.lastSample.length, fb.firstSample.length); c++) step = Math.max(step, Math.abs(fa.lastSample[c] * outO.gainLin - fb.firstSample[c] * inO.gainLin));
        s.sampleStep = fade > 0 ? 0 : +step.toFixed(4);
      }
      // severity + verdict (priority: pushed > level > feel > texture > tail > click)
      const flags = [];
      const sev = (x) => { const rank = { green: 0, amber: 1, red: 2 }; if (rank[x] > rank[s.severity]) s.severity = x; };
      if (s.pushedDownbeat) { sev('red'); flags.push({ v: 'pushed downbeat', c: `the outgoing loop has an onset ${Math.abs(s.pushedMs).toFixed(0)} ms before its end — cut ~15 ms before the bar line at this seam in Pro Tools so the pushed downbeat is not doubled` }); }
      if (s.levelStepDb !== null && Math.abs(s.levelStepDb) > T.levelRed) { sev('red'); flags.push({ v: 'watch level', c: `level ${s.levelStepDb > 0 ? 'jumps up' : 'drops'} ${Math.abs(s.levelStepDb).toFixed(1)} dB — trim the incoming loop ${(-s.levelStepDb).toFixed(1)} dB or ride the fader` }); }
      else if (s.levelStepDb !== null && Math.abs(s.levelStepDb) > T.levelAmber) { sev('amber'); flags.push({ v: 'watch level', c: `level ${s.levelStepDb > 0 ? 'rises' : 'falls'} ${Math.abs(s.levelStepDb).toFixed(1)} dB across the seam` }); }
      if (s.feelStepMs !== null && Math.abs(s.feelStepMs) > T.feelRed) { sev('red'); flags.push({ v: 'feel lurch', c: `the pocket ${s.feelStepMs > 0 ? 'drops back' : 'pushes forward'} ${Math.abs(s.feelStepMs).toFixed(0)} ms — expect the groove to lurch; consider a fill or a different neighbour` }); }
      else if (s.feelStepMs !== null && Math.abs(s.feelStepMs) > T.feelAmber) { sev('amber'); flags.push({ v: 'feel lurch', c: `feel shifts ${s.feelStepMs > 0 ? 'later' : 'earlier'} by ${Math.abs(s.feelStepMs).toFixed(0)} ms` }); }
      // texture: the top end relative to the overall level (a −6 dB loop is not a hat change), or the hat rate
      const highRel = s.highStepDb !== null && s.levelStepDb !== null ? +(s.highStepDb - s.levelStepDb).toFixed(1) : s.highStepDb; s.highRelDb = highRel;
      const texture = (highRel !== null && Math.abs(highRel) > T.highDb) || (s.hatRateChange !== null && Math.abs(s.hatRateChange) > T.hatRate);
      if (texture) { sev('amber'); flags.push({ v: 'texture change', c: `top end ${highRel !== null && highRel < 0 ? 'thins' : 'thickens'}${highRel !== null ? ' ' + Math.abs(highRel).toFixed(1) + ' dB relative to the level' : ''}${s.hatRateChange !== null && Math.abs(s.hatRateChange) > T.hatRate ? `, hats ${s.hatsOut} → ${s.hatsIn} per bar` : ''} — ${s.hatRateChange !== null && s.hatRateChange < 0 ? 'a lighter-hats section starts here' : 'the hat texture changes here'}` }); }
      if (s.tailCut) { sev('amber'); flags.push({ v: 'tail', c: 'tail cut — the outgoing loop ends mid-decay; consider a short fade or take the seam a beat earlier' }); }
      if (s.sampleStep !== null && s.sampleStep > T.sampleStep) { sev('amber'); flags.push({ v: 'click likely', c: `sample step ${s.sampleStep} at the seam — add a 2–5 ms fade` }); }
      s.notes = [];
      if (s.startsWithOnset) s.notes.push(`incoming loop starts with a hit inside its first ${T.leadMs} ms`);
      if (s.signatureDiff.length) s.notes.push('pattern differs');
      if (needsAudio) s.severity = 'grey';
      s.verdict = needsAudio ? 'needs audio' : flags.length ? flags.map(f => f.v).filter((v, i, arr2) => arr2.indexOf(v) === i).join(' + ') : 'clean';
      s.care = flags.map(f => f.c).join('; ');
      return s;
    };
    for (let i = 0; i < L.occ.length; i++) {
      const cur = L.occ[i];
      if (cur.missing) continue;
      if (cur.repeatIndex === 0 && cur.block.repeats > 1) { const s = mk(cur, cur, 'repeat'); if (s) seams.push(s); }
      const next = L.occ.find((o, j) => j > i && o.blockIndex === cur.blockIndex + 1);
      if (cur.repeatIndex === cur.block.repeats - 1 && next && !next.missing) { const s = mk(cur, next, 'junction'); if (s) seams.push(s); }
    }
    return seams;
  },
  overview(arr, lib, seams) {
    const L = this.layout(arr, lib); const counts = {}; for (const s of seams) counts[s.verdict] = (counts[s.verdict] || 0) + 1;
    const profile = []; let behind = 0, ahead = 0;
    const junctionBars = new Set(seams.filter(s => s.kind === 'junction').map(s => s.atBar));
    for (const o of L.occ) { const feel = o.loop && o.loop.machine && typeof o.loop.machine.feelMs === 'number' ? o.loop.machine.feelMs : null; for (let b = 0; b < o.bars; b++) { const bar = o.startBar + b; profile.push({ bar, feelMs: feel, seam: junctionBars.has(bar), loopId: o.loop ? o.loop.id : '?' }); if (feel !== null) { if (feel > 3) behind++; else if (feel < -3) ahead++; } } }
    return { totalBars: L.totalBars, totalSeconds: L.totalSeconds, seamCount: seams.length, verdictCounts: counts, redCount: seams.filter(s => s.severity === 'red').length, amberCount: seams.filter(s => s.severity === 'amber').length, behindBars: behind, aheadBars: ahead, profile };
  },
  careList(seams) {
    return seams.filter(s => s.severity === 'amber' || s.severity === 'red').sort((a, b) => a.atBar - b.atBar)
      .map(s => `Bar ${s.atBar} (${s.kind === 'repeat' ? `${s.fromLoop} repeat join` : `${s.fromLoop} → ${s.toLoop}`}, ${s.severity}): ${s.care}${s.signatureDiff.length ? ' — pattern: ' + s.signatureDiff.join('; ') : ''}`);
  },

  /* ---------- cues ---------- */
  cuesRows(arr, lib) {
    const L = this.layout(arr, lib); const seams = arr.seams && arr.seams.length ? arr.seams : this.seams(arr, lib);
    return L.occ.map(o => {
      const seamIn = seams.find(s => s.to === o.block.id && (o.repeatIndex === 0 ? s.kind === 'junction' : s.kind === 'repeat')) || null;
      const pt = o.loop ? this.ptStartEnd(o.loop) : null;
      return { arrStart: o.startBar, arrEnd: o.startBar + o.bars - 1, loopId: o.loop ? o.loop.id : o.block.loopId, ptBars: o.loop && o.loop.barRange ? `${o.loop.barRange.start}–${o.loop.barRange.end}` : '', ptStart: pt ? pt.start : '', ptEnd: pt ? pt.end : '', repeat: `${o.repeatIndex + 1}/${o.block.repeats}`, gainDb: o.block.gainDb || 0, matchDb: +(o.gainDb - (o.block.gainDb || 0)).toFixed(1), seamVerdict: seamIn ? seamIn.verdict : (o.startBar === 1 ? 'start' : ''), seamSeverity: seamIn ? seamIn.severity : '', startSec: o.startSec, lengthSec: o.lengthSec, missing: !!o.missing, notes: o.block.notes || '' };
    });
  },
  cuesMarkdown(arr, lib) {
    const rows = this.cuesRows(arr, lib); const seams = this.seams(arr, lib); const ov = this.overview(arr, lib, seams);
    const L = [`# Cue list — ${lib.session.name || 'session'} / ${arr.name}`, '', `- ${lib.session.bpm} BPM ${lib.session.meterNumerator}/${lib.session.meterDenominator} · ${ov.totalBars} bars · ${U.fmtTime(ov.totalSeconds)} · ${rows.length} block occurrences · ${seams.length} seams (${ov.redCount} red, ${ov.amberCount} amber) · exported ${U.nowIso()}`];
    if (arr.settings && arr.settings.seamFadeMs) L.push(`- seam fade ${arr.settings.seamFadeMs} ms`); if (arr.settings && arr.settings.levelMatch) L.push('- level match on: "match" column is the extra gain applied in the app to equalise loop RMS');
    if (arr.notes) L.push('', arr.notes);
    L.push('', '| arr bars | loop | PT bars | Start | End | repeat | trim dB | match dB | seam in | notes |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const r of rows) L.push(`| ${r.arrStart}–${r.arrEnd} | ${r.loopId}${r.missing ? ' (missing)' : ''} | ${r.ptBars || '—'} | ${r.ptStart ? `Start ${r.ptStart}` : '—'} | ${r.ptEnd ? `End ${r.ptEnd}` : '—'} | ${r.repeat} | ${r.gainDb ? (r.gainDb > 0 ? '+' : '') + r.gainDb.toFixed(1) : '0'} | ${r.matchDb ? (r.matchDb > 0 ? '+' : '') + r.matchDb.toFixed(1) : '0'} | ${r.seamVerdict}${r.seamSeverity && r.seamSeverity !== 'green' ? ` (${r.seamSeverity})` : ''} | ${r.notes.replace(/\|/g, '\\|')} |`);
    if (arr.markers && arr.markers.length) { L.push('', '## Markers', ''); for (const m of arr.markers) L.push(`- bar ${m.bar}: ${m.name}`); }
    const care = this.careList(seams); L.push('', '## Care list', ''); if (!care.length) L.push('_Every seam is clean._'); for (const c of care) L.push(`- ${c}`);
    L.push('', `Feel profile: ${ov.behindBars} bar(s) behind the click, ${ov.aheadBars} ahead (of ${ov.totalBars}).`);
    return L.join('\n') + '\n';
  },
  cuesCsv(arr, lib) {
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = this.cuesRows(arr, lib); const out = [['arr_start_bar', 'arr_end_bar', 'loop', 'pt_bars', 'pt_start', 'pt_end', 'repeat', 'trim_db', 'match_db', 'seam_in', 'seam_severity', 'start_seconds', 'length_seconds', 'notes'].join(',')];
    for (const r of rows) out.push([r.arrStart, r.arrEnd, esc(r.loopId), esc(r.ptBars), esc(r.ptStart), esc(r.ptEnd), esc(r.repeat), r.gainDb.toFixed(1), r.matchDb.toFixed(1), esc(r.seamVerdict), r.seamSeverity, r.startSec.toFixed(6), r.lengthSec.toFixed(6), esc(r.notes)].join(','));
    const care = this.careList(this.seams(arr, lib)); out.push(''); out.push('care_list'); for (const c of care) out.push(esc(c));
    return out.join('\n') + '\n';
  },

  /* ---------- standalone export / import ---------- */
  standaloneExport(arr, lib) {
    const ids = Array.from(new Set(arr.blocks.map(b => b.loopId)));
    return { schemaVersion: LOOPS_SCHEMA_VERSION, kind: 'arrangement', app: { name: APP_NAME, version: APP_VERSION }, session: { name: lib.session.name, bpm: lib.session.bpm, meterNumerator: lib.session.meterNumerator, meterDenominator: lib.session.meterDenominator },
      arrangement: U.deepClone(arr), loops: ids.map(id => { const l = lib.loop(id); return l ? { id: l.id, fingerprint: l.fingerprint, fileName: l.fileName, bars: l.bars, barRange: l.barRange } : { id, fingerprint: null, fileName: '' }; }) };
  },
  /** @returns {{arrangement, missing:[], relinked:[]}} — blocks are re-linked by id, then by fingerprint */
  standaloneImport(json, lib, store) {
    const errors = validateSchema(LOOPS_SCHEMA.$defs.arrangementExport, json, LOOPS_SCHEMA).map(e => `${e.path}: ${e.message}`);
    if (errors.length) return { errors };
    const a = U.deepClone(json.arrangement); a.id = U.uid('arr'); a.name = store.uniqueName(a.name || 'imported'); a.createdAt = a.createdAt || U.nowIso(); a.updatedAt = U.nowIso(); a.markers = a.markers || []; a.settings = Object.assign({ seamFadeMs: 0, levelMatch: true }, a.settings || {}); a.seams = [];
    const missing = [], relinked = [];
    for (const b of a.blocks) {
      b.id = U.uid('blk');
      let l = lib.loop(b.loopId);
      if (!l && b.fingerprint) { l = lib.loops.find(x => x.fingerprint === b.fingerprint); if (l) { relinked.push(`${b.loopId} → ${l.id}`); b.loopId = l.id; } }
      if (!l) { const hint = (json.loops || []).find(x => x.id === b.loopId); if (hint && hint.fingerprint) l = lib.loops.find(x => x.fingerprint === hint.fingerprint); if (!l && hint && hint.fileName) l = lib.loops.find(x => x.fileName === hint.fileName); if (l) { relinked.push(`${b.loopId} → ${l.id}`); b.loopId = l.id; } }
      if (!l) missing.push(b.loopId); else b.fingerprint = l.fingerprint;
    }
    store.commit('import arrangement', () => { lib.arrangements.push(a); });
    return { arrangement: a, missing, relinked, errors: [] };
  },
};

/* loopplayer.js — LoopPlayer: gapless Web Audio looping, A/B decks on one
 * clock, level matching, join fade, "play the join", playback rate and a
 * synthesised, look-ahead-scheduled metronome.
 *
 * Timing model: every source starts at t0 (AudioContext time). A loop's
 * position is ((now − t0) · rate + startOffset) mod loopSec. Beat k of the
 * grid falls at t0 + (k · beatSec − startOffset) / rate, so the metronome and
 * the loop cannot drift: both are derived from the same t0 and the same rate.
 * beatSec while playing is the loop period divided by its beat count (a
 * 2-bar bounce is 213333 samples, 3 samples short of 8 nominal beats; using
 * the file's own period keeps the click locked over any number of loops).
 * Metronome clicks are scheduled ~150 ms ahead from a 25 ms timer; nothing is
 * allocated inside the audio thread (only oscillator/gain nodes on the main
 * thread, created ahead of time).
 *
 * Sequence mode (1.2.0): an arrangement is a list of occurrences, each with a
 * buffer, a gain and a start time = the sum of the previous occurrences'
 * ACTUAL lengths. One AudioBufferSourceNode per occurrence is scheduled from
 * the same 25 ms timer ~600 ms ahead with start(t0 + startSec/rate), so the
 * joins are sample-exact and no timer gap can open. A beat timeline (one beat
 * length per occurrence = its period / beats) drives the click and the bar
 * readout, so it stays locked across blocks of slightly different lengths. */
'use strict';

class LoopPlayer {
  constructor() {
    this.ctx = null; this.master = null;
    this.decks = { A: null, B: null };        // {entry, buffer, source, gain, rmsLin, loopSec}
    this.active = 'A'; this.mode = 'idle';     // idle | single | ab | join
    this.rate = 1; this.t0 = 0; this.startOffset = 0; this.pausedAt = 0;
    this.levelMatch = true; this.joinFadeMs = 0;
    this.metro = { on: false, levelDb: -12, sound: 'click', pan: 0, subdiv: 0, accent: true, countIn: false };
    this._metroTimer = null; this._nextBeat = 0; this._panner = null; this._metroGain = null;
    this.grid = { beatSec: 60 / 108, barSec: 60 / 108 * 4, beatsPerBar: 4 }; this.nominalBeatSec = 60 / 108;
    this.countInBeats = 0;
    this.handlers = {};
    this._decoders = new Map();
    this.seq = null;                             // sequence engine state, see startSequence()
    this._preparedCache = new WeakMap();
  }
  on(n, f) { this.handlers[n] = f; return this; }
  _emit(n, ...a) { const h = this.handlers[n]; if (h) h(...a); }
  ensureCtx() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext; this.ctx = new Ctx({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination);
      this._metroGain = this.ctx.createGain(); this._panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
      if (this._panner) { this._metroGain.connect(this._panner); this._panner.connect(this.master); } else this._metroGain.connect(this.master);
    }
    if (this.ctx.state === 'suspended' && !(typeof OfflineAudioContext !== 'undefined' && this.ctx instanceof OfflineAudioContext)) this.ctx.resume();
    return this.ctx;
  }
  /** Tests: drive the player from an OfflineAudioContext (stepped with suspend/resume). */
  useContext(ctx) {
    this.ctx = ctx; this.master = ctx.createGain(); this.master.connect(ctx.destination);
    this._metroGain = ctx.createGain(); this._panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (this._panner) { this._metroGain.connect(this._panner); this._panner.connect(this.master); } else this._metroGain.connect(this.master);
  }
  setGrid(bpm, num = 4, den = 4) { const beatSec = (60 / bpm) * (4 / den); this.nominalBeatSec = beatSec; this.grid = { beatSec, barSec: beatSec * num, beatsPerBar: num }; }

  /* ---------- decoding (native sample rate, never resampled) ---------- */
  async decode(file, sampleRate) {
    const buf = await file.arrayBuffer();
    let dec = this._decoders.get(sampleRate);
    if (!dec) { dec = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, sampleRate); this._decoders.set(sampleRate, dec); }
    return await new Promise((res, rej) => { const p = dec.decodeAudioData(buf, res, rej); if (p && p.then) p.then(res, rej); });
  }
  static rmsLinear(buffer) {
    let s = 0, n = 0; for (let c = 0; c < buffer.numberOfChannels; c++) { const d = buffer.getChannelData(c); for (let i = 0; i < d.length; i++) s += d[i] * d[i]; n += d.length; }
    return n ? Math.sqrt(s / n) : 0;
  }
  /** Working copy with a raised-cosine fade over joinFadeMs/2 at each end (keeps the exact loop length). */
  _prepared(buffer, fadeMs, ctx = null) {
    if (!fadeMs) return buffer;
    ctx = ctx || this.ensureCtx();
    let byFade = this._preparedCache.get(buffer); if (!byFade) { byFade = new Map(); this._preparedCache.set(buffer, byFade); }
    const key = `${fadeMs}:${ctx === this.ctx ? 'live' : 'off'}`; if (byFade.has(key)) return byFade.get(key);
    const n = Math.min(buffer.length >> 1, Math.round(buffer.sampleRate * fadeMs / 2000));
    const out = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const src = buffer.getChannelData(c), dst = out.getChannelData(c); dst.set(src);
      for (let i = 0; i < n; i++) { const w = 0.5 - 0.5 * Math.cos(Math.PI * i / n); dst[i] *= w; dst[dst.length - 1 - i] *= w; }
    }
    byFade.set(key, out);
    return out;
  }
  /** Buffer of [last beat + first beat] for auditioning the join. */
  joinBuffer(buffer, beatSec) {
    const ctx = this.ensureCtx(); const sr = buffer.sampleRate, nb = Math.min(buffer.length >> 1, Math.round(beatSec * sr));
    const out = ctx.createBuffer(buffer.numberOfChannels, nb * 2, sr);
    for (let c = 0; c < buffer.numberOfChannels; c++) { const s = buffer.getChannelData(c), d = out.getChannelData(c); d.set(s.subarray(buffer.length - nb), 0); d.set(s.subarray(0, nb), nb); }
    return out;
  }

  /* ---------- transport ---------- */
  get playing() { return this.mode !== 'idle'; }
  get inSequence() { return this.mode === 'seq' || this.mode === 'seqab'; }
  /** seconds into the primary loop (deck A, or the single deck); in sequence mode, seconds into the arrangement */
  position() {
    if (this.inSequence) return this._seqPosition();
    const d = this.decks[this.active] || this.decks.A || this.decks.B; if (!d || !this.playing) return this.pausedAt;
    const el = (this.ctx.currentTime - this.t0) * this.rate + this.startOffset;
    if (el < 0) return el; // count-in
    return ((el % d.loopSec) + d.loopSec) % d.loopSec;
  }
  /** loop-relative beat index (may be negative during count-in) */
  beatIndex() { if (this.inSequence) { const i = this.seqInfo(); return i ? i.beatIndex : 0; } const p = this.position(); return Math.floor(p / this.grid.beatSec); }
  loopIteration() { const d = this.decks[this.active] || this.decks.A; if (!d || !this.playing) return 0; const el = (this.ctx.currentTime - this.t0) * this.rate + this.startOffset; return Math.floor(el / d.loopSec); }

  _makeDeck(entry, buffer) {
    const ctx = this.ensureCtx();
    const gain = ctx.createGain(); gain.connect(this.master);
    return { entry, buffer, source: null, gain, rmsLin: entry._rmsLin || LoopPlayer.rmsLinear(buffer), loopSec: buffer.duration, offsetSec: (entry.offsetSamples || 0) / buffer.sampleRate };
  }
  _deckGain(name) {
    const d = this.decks[name]; if (!d) return 0;
    let g = 1;
    if (this.levelMatch && this.decks.A && this.decks.B) { const ref = Math.min(this.decks.A.rmsLin, this.decks.B.rmsLin) || 1; g = d.rmsLin ? ref / d.rmsLin : 1; }
    return Math.min(4, g);
  }
  /**
   * Start playback. decks: {A:{entry,buffer}, B?:{entry,buffer}}; single mode when only A.
   * offset: seconds into the loop to start from (resume). countIn: one bar of clicks first.
   */
  start({ A, B = null, active = 'A', offset = 0, countIn = false, mode = null }) {
    const ctx = this.ensureCtx();
    this.stop(false);
    this.decks.A = A ? this._makeDeck(A.entry, A.buffer) : null;
    this.decks.B = B ? this._makeDeck(B.entry, B.buffer) : null;
    this.mode = mode || (B ? 'ab' : 'single'); this.active = this.decks[active] ? active : 'A';
    // lock the click to the loop's own period when the file is a whole number of bars (±0.5 %)
    const prim = this.decks[this.active] || this.decks.A; this.grid.beatSec = this.nominalBeatSec;
    if (prim && this.mode !== 'join') { const beats = prim.loopSec / this.nominalBeatSec, n = Math.round(beats); if (n > 0 && Math.abs(beats - n) <= 0.005 * n) this.grid.beatSec = prim.loopSec / n; }
    this.grid.barSec = this.grid.beatSec * this.grid.beatsPerBar;
    const lead = 0.06;
    this.countInBeats = countIn && this.metro.on ? this.grid.beatsPerBar : 0;
    const countSec = this.countInBeats * this.grid.beatSec / this.rate;
    this.t0 = ctx.currentTime + lead + countSec; this.startOffset = offset;
    for (const name of ['A', 'B']) {
      const d = this.decks[name]; if (!d) continue;
      const src = ctx.createBufferSource(); src.buffer = this._prepared(d.buffer, this.joinFadeMs); src.loop = true; src.loopStart = 0; src.loopEnd = d.loopSec; src.playbackRate.value = this.rate;
      src.connect(d.gain); d.source = src;
      d.gain.gain.setValueAtTime(name === this.active ? this._deckGain(name) : 0, 0);
      src.start(this.t0, ((offset % d.loopSec) + d.loopSec) % d.loopSec);
    }
    this._nextBeat = -this.countInBeats;
    this._startMetro();
    this._emit('state', true);
  }
  stop(emit = true) {
    for (const name of ['A', 'B']) { const d = this.decks[name]; if (d && d.source) { try { d.source.stop(); } catch (_) { } d.source.disconnect(); d.gain.disconnect(); } this.decks[name] = null; }
    if (this.seq) { for (const name of ['A', 'B']) { const d = this.seq.decks[name]; if (!d) continue; for (const src of d.sources.values()) { try { src.node.stop(); } catch (_) { } src.node.disconnect(); src.gain.disconnect(); } d.gain.disconnect(); } this.seq = null; }
    this._stopMetro(); this.mode = 'idle'; this.pausedAt = 0;
    if (emit) this._emit('state', false);
  }
  pause() { if (!this.playing) return; const p = Math.max(0, this.position()); this.stop(); this.pausedAt = p; }
  playJoin(entry, buffer) {
    const jb = this.joinBuffer(buffer, this.grid.beatSec);
    const fakeEntry = Object.assign({}, entry, { offsetSamples: 0, _rmsLin: null });
    this.start({ A: { entry: fakeEntry, buffer: jb }, mode: 'join' });
  }
  /** Beat time of loop-relative beat k (AudioContext clock). */
  beatTime(k) { return this.t0 + (k * this.grid.beatSec - this.startOffset) / this.rate; }
  /** Next bar boundary (AudioContext clock) strictly after now. */
  nextBarTime() {
    if (this.inSequence) return this._seqNextBarTime();
    const now = this.ctx.currentTime; const bpb = this.grid.beatsPerBar;
    let k = Math.floor(((now - this.t0) * this.rate + this.startOffset) / this.grid.beatSec / bpb) * bpb + bpb;
    while (this.beatTime(k) <= now + 0.01) k += bpb;
    return this.beatTime(k);
  }
  switchTo(name, { atNextBar = false } = {}) {
    if (this.mode === 'seqab') {
      if (!this.seq.decks[name]) return false;
      const when = atNextBar ? this.nextBarTime() : this.ctx.currentTime, ramp = 0.005;
      for (const n of ['A', 'B']) { const d = this.seq.decks[n]; if (!d) continue; const target = n === name ? 1 : 0; d.gain.gain.cancelScheduledValues(when); d.gain.gain.setValueAtTime(d.gain.gain.value, when); d.gain.gain.linearRampToValueAtTime(target, when + ramp); }
      this.active = name; this._emit('deck', name, when); return true;
    }
    if (this.mode !== 'ab' || !this.decks[name]) return false;
    const when = atNextBar ? this.nextBarTime() : this.ctx.currentTime;
    const ramp = 0.005;
    for (const n of ['A', 'B']) { const d = this.decks[n]; if (!d) continue; const target = n === name ? this._deckGain(n) : 0; d.gain.gain.cancelScheduledValues(when); d.gain.gain.setValueAtTime(d.gain.gain.value, when); d.gain.gain.linearRampToValueAtTime(target, when + ramp); }
    this.active = name; this._emit('deck', name, when);
    return true;
  }
  swap() { return this.switchTo(this.active === 'A' ? 'B' : 'A'); }
  setLevelMatch(on) { this.levelMatch = on; if (this.playing) for (const n of ['A', 'B']) { const d = this.decks[n]; if (d) d.gain.gain.setTargetAtTime(n === this.active ? this._deckGain(n) : 0, this.ctx.currentTime, 0.01); } }
  setRate(r) {
    this.rate = r; if (!this.playing) return;
    if (this.inSequence) { const S = this.seq; const pos = Math.max(0, this.position()); this.startSequence({ A: S.decks.A.spec, B: S.decks.B ? S.decks.B.spec : null, active: this.active, offset: pos, loopWhole: S.loopWhole }); return; }
    const A = this.decks.A, B = this.decks.B, pos = Math.max(0, this.position()), mode = this.mode; this.start({ A: A && { entry: A.entry, buffer: A.buffer }, B: B && { entry: B.entry, buffer: B.buffer }, active: this.active, offset: pos, mode });
  }
  setMaster(v) { this.ensureCtx(); this.master.gain.value = v; }

  /* ---------- metronome ---------- */
  setMetro(patch) { Object.assign(this.metro, patch); if (this.ctx && this._panner) this._panner.pan.value = this.metro.pan; if (this.metro.on && this.playing && !this._metroTimer) { this._nextBeat = Math.max(this._nextBeat, this.beatIndex() + 1); this._startMetro(); } if (!this.metro.on && !this.inSequence) this._stopMetro(); }
  _startMetro() { this._stopMetro(); if (!this.metro.on && !this.inSequence) return; if (this._panner) this._panner.pan.value = this.metro.pan; const tick = () => { this._schedule(); this._metroTimer = setTimeout(tick, 25); }; tick(); }
  _stopMetro() { if (this._metroTimer) { clearTimeout(this._metroTimer); this._metroTimer = null; } }
  _schedule() {
    if (!this.playing) return;
    if (this.inSequence) return this._scheduleSequence();
    const ctx = this.ctx, horizon = ctx.currentTime + 0.15;
    const bpb = this.grid.beatsPerBar, sub = this.metro.subdiv;
    const d = this.decks[this.active] || this.decks.A; const ref = d ? d.rmsLin : 0.1;
    const base = Math.min(1, Math.max(0.002, ref * 6 * Math.pow(10, this.metro.levelDb / 20)));
    while (this.beatTime(this._nextBeat) < horizon) {
      const k = this._nextBeat, t = this.beatTime(k);
      const inLoop = k >= 0; const beatInBar = ((k % bpb) + bpb) % bpb;
      const accent = this.metro.accent && beatInBar === 0;
      if (t >= ctx.currentTime - 0.005) this._click(t, accent ? 'accent' : 'beat', base);
      if (sub > 0 && inLoop) for (let s = 1; s < sub; s++) { const ts = t + (s / sub) * this.grid.beatSec / this.rate; if (ts >= ctx.currentTime) this._click(ts, 'sub', base * 0.35); }
      this._nextBeat++;
    }
  }
  _click(t, kind, base, ctx = this.ctx, dest = this._metroGain) {
    const osc = ctx.createOscillator(); const g = ctx.createGain();
    const s = this.metro.sound;
    let f, dur, type = 'sine';
    if (s === 'wood') { f = kind === 'accent' ? 1100 : 820; dur = 0.045; type = 'triangle'; }
    else if (s === 'blip') { f = kind === 'accent' ? 3600 : 2800; dur = 0.02; }
    else { f = kind === 'accent' ? 2000 : 1500; dur = 0.028; }
    if (kind === 'sub') { f *= 1.5; dur *= 0.7; }
    osc.type = type; osc.frequency.setValueAtTime(f, t);
    const amp = base * (kind === 'accent' ? 1 : 0.7);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(amp, t + 0.001); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g); g.connect(dest); osc.start(t); osc.stop(t + dur + 0.005);
    osc.onended = () => { osc.disconnect(); g.disconnect(); };
  }

  /* ================= sequence engine (1.2.0) ================= */
  /**
   * spec = { occ: [{ buffer, gainLin, startSec, lengthSec, bars, beatSec, startBar, label }], totalSec, fadeMs, bpb }
   * Beat timeline: per occurrence, bars·bpb beats of that occurrence's own period.
   */
  _buildDeck(spec) {
    const ctx = this.ensureCtx(); const gain = ctx.createGain(); gain.connect(this.master);
    const beats = []; let k = 0;
    for (let i = 0; i < spec.occ.length; i++) { const o = spec.occ[i]; const n = Math.max(1, Math.round(o.bars * spec.bpb)); for (let b = 0; b < n; b++, k++) beats.push({ t: o.startSec + b * o.beatSec, occIndex: i, bar: o.startBar + Math.floor(b / spec.bpb), beatInBar: b % spec.bpb, k }); }
    return { spec, gain, beats, sources: new Map(), nextBeat: 0, nextOcc: 0 };
  }
  startSequence({ A, B = null, active = 'A', offset = 0, countIn = false, loopWhole = false }) {
    const ctx = this.ensureCtx();
    this.stop(false);
    if (!A || !A.occ.length) return;
    this.seq = { decks: { A: this._buildDeck(A), B: B && B.occ.length ? this._buildDeck(B) : null }, loopWhole, lookahead: 0.6 };
    this.mode = this.seq.decks.B ? 'seqab' : 'seq'; this.active = this.seq.decks[active] ? active : 'A';
    for (const n of ['A', 'B']) { const d = this.seq.decks[n]; if (d) d.gain.gain.setValueAtTime(n === this.active ? 1 : 0, 0); }
    const prim = this.seq.decks[this.active];
    this.grid.beatSec = prim.spec.occ[0].beatSec; this.grid.barSec = this.grid.beatSec * this.grid.beatsPerBar;
    this.countInBeats = countIn && this.metro.on ? this.grid.beatsPerBar : 0;
    const lead = 0.06, countSec = this.countInBeats * this.grid.beatSec / this.rate;
    this.t0 = ctx.currentTime + lead + countSec; this.startOffset = Math.max(0, offset);
    for (const n of ['A', 'B']) { const d = this.seq.decks[n]; if (!d) continue; const tot = d.spec.totalSec; const pos = loopWhole ? ((this.startOffset % tot) + tot) % tot : this.startOffset; d.iter = loopWhole ? Math.floor(this.startOffset / tot) : 0; d.nextOcc = d.spec.occ.findIndex(o => o.startSec + o.lengthSec > pos); if (d.nextOcc < 0) d.nextOcc = d.spec.occ.length; d.nextBeat = d.beats.findIndex(b => b.t >= pos - 1e-6); if (d.nextBeat < 0) d.nextBeat = d.beats.length; d.beatIter = d.iter; }
    this._nextBeat = -this.countInBeats; // count-in clicks use the loop-mode path below
    this._startMetro();
    this._emit('state', true);
  }
  _seqTime(tau) { return this.t0 + (tau - this.startOffset) / this.rate; }   // sequence seconds → context time
  _seqPosition() {
    const S = this.seq; if (!S) return this.pausedAt; const d = S.decks[this.active] || S.decks.A;
    const el = (this.ctx.currentTime - this.t0) * this.rate + this.startOffset; if (el < 0) return el;
    if (S.loopWhole) { const tot = d.spec.totalSec; return ((el % tot) + tot) % tot; }
    return Math.min(el, d.spec.totalSec);
  }
  /** { occ, occIndex, bar, beatInBar, tick, beatIndex, iteration, done } for the active deck */
  seqInfo(deckName = null) {
    const S = this.seq; if (!S) return null; const d = S.decks[deckName || this.active] || S.decks.A; const pos = this._seqPosition();
    if (pos < 0) return { countIn: true, pos, done: false };
    const tot = d.spec.totalSec; const done = !S.loopWhole && pos >= tot - 1e-6;
    let i = d.beats.length - 1; while (i > 0 && d.beats[i].t > pos + 1e-9) i--; const b = d.beats[i]; const o = d.spec.occ[b.occIndex];
    const el = (this.ctx.currentTime - this.t0) * this.rate + this.startOffset;
    return { occ: o, occIndex: b.occIndex, bar: b.bar, beatInBar: b.beatInBar, beatIndex: b.k, tick: Math.max(0, Math.min(959, Math.round((pos - b.t) / o.beatSec * 960))), pos, iteration: S.loopWhole ? Math.floor(el / tot) : 0, done, totalSec: tot };
  }
  _seqNextBarTime() {
    const S = this.seq; const d = S.decks[this.active] || S.decks.A; const now = this.ctx.currentTime; const tot = d.spec.totalSec;
    const el = (now - this.t0) * this.rate + this.startOffset; const iter = S.loopWhole ? Math.floor(Math.max(0, el) / tot) : 0; const pos = S.loopWhole ? el - iter * tot : el;
    for (let n = iter; n < iter + 3; n++) for (const b of d.beats) { if (b.beatInBar !== 0) continue; const tau = n * tot + b.t; if (this._seqTime(tau) > now + 0.01) return this._seqTime(tau); if (!S.loopWhole) continue; }
    return this._seqTime(d.spec.totalSec * (iter + 1));
  }
  _scheduleSequence() {
    const S = this.seq; if (!S) return; const ctx = this.ctx, now = ctx.currentTime;
    // count-in clicks (loop-mode style, before t0)
    if (this.metro.on) { const bpb = this.grid.beatsPerBar; while (this._nextBeat < 0 && this.beatTime(this._nextBeat) < now + 0.15) { const k = this._nextBeat, t = this.beatTime(k); const beatInBar = ((k % bpb) + bpb) % bpb; if (t >= now - 0.005) this._click(t, this.metro.accent && beatInBar === 0 ? 'accent' : 'beat', this._clickBase()); this._nextBeat++; } }
    for (const n of ['A', 'B']) {
      const d = S.decks[n]; if (!d) continue; const spec = d.spec, tot = spec.totalSec;
      // sources
      while (true) {
        if (d.nextOcc >= spec.occ.length) { if (!S.loopWhole) break; d.nextOcc = 0; d.iter++; }
        const o = spec.occ[d.nextOcc]; const tau = d.iter * tot + o.startSec; const when = this._seqTime(tau);
        if (when > now + S.lookahead) break;
        const key = `${d.iter}:${d.nextOcc}`; d.nextOcc++;
        if (tau + o.lengthSec <= this.startOffset) continue;           // entirely before the start point
        const g = ctx.createGain(); g.gain.value = o.gainLin; g.connect(d.gain);
        const src = ctx.createBufferSource(); src.buffer = this._prepared(o.buffer, spec.fadeMs || 0); src.playbackRate.value = this.rate; src.connect(g);
        const late = Math.max(0, this.startOffset - tau);                // resume inside an occurrence
        src.start(Math.max(now, when + late / this.rate), late, o.lengthSec - late);
        d.sources.set(key, { node: src, gain: g });
        src.onended = () => { src.disconnect(); g.disconnect(); d.sources.delete(key); };
      }
      // clicks (active deck only)
      if (this.metro.on && n === this.active) {
        const base = this._clickBase();
        while (true) {
          if (d.nextBeat >= d.beats.length) { if (!S.loopWhole) break; d.nextBeat = 0; d.beatIter++; }
          const b = d.beats[d.nextBeat]; const tau = d.beatIter * tot + b.t; const t = this._seqTime(tau);
          if (t > now + 0.15) break;
          d.nextBeat++;
          if (tau < this.startOffset - 1e-6 || t < now - 0.005) continue;
          const accent = this.metro.accent && b.beatInBar === 0; this._click(t, accent ? 'accent' : 'beat', base);
          const sub = this.metro.subdiv, o = spec.occ[b.occIndex]; if (sub > 0) for (let s = 1; s < sub; s++) { const ts = t + (s / sub) * o.beatSec / this.rate; if (ts >= now) this._click(ts, 'sub', base * 0.35); }
        }
      }
    }
    if (!S.loopWhole) { const d = S.decks[this.active] || S.decks.A; if (this._seqTime(d.spec.totalSec) + 0.05 < now && d.sources.size === 0) { this.stop(); } }
  }
  _clickBase() { let ref = 0.1; if (this.inSequence) { const d = this.seq.decks[this.active] || this.seq.decks.A; const o = d.spec.occ[0]; ref = o && o.rmsLin ? o.rmsLin : 0.1; } else { const d = this.decks[this.active] || this.decks.A; ref = d ? d.rmsLin : 0.1; } return Math.min(1, Math.max(0.002, ref * 6 * Math.pow(10, this.metro.levelDb / 20))); }

  /** Offline render of a sequence spec at `sampleRate`; returns { audio, click } AudioBuffers (click only when metronome). */
  async renderSequence(spec, { sampleRate = 48000, metronome = false, bpb = 4 } = {}) {
    const frames = Math.max(1, Math.round(spec.totalSec * sampleRate));
    const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new Off(2, frames, sampleRate);
    for (const o of spec.occ) { const g = off.createGain(); g.gain.value = o.gainLin; g.connect(off.destination); const src = off.createBufferSource(); src.buffer = this._prepared(o.buffer, spec.fadeMs || 0, off); src.connect(g); src.start(o.startSec, 0, o.lengthSec); }
    const audio = await off.startRendering();
    let click = null;
    if (metronome) {
      const off2 = new Off(2, frames, sampleRate); const dest = off2.createGain(); dest.connect(off2.destination);
      const base = Math.min(1, Math.max(0.002, (spec.occ[0].rmsLin || 0.1) * 6 * Math.pow(10, this.metro.levelDb / 20)));
      for (const o of spec.occ) { const n = Math.round(o.bars * bpb); for (let b = 0; b < n; b++) this._click(o.startSec + b * o.beatSec, this.metro.accent && b % bpb === 0 ? 'accent' : 'beat', base, off2, dest); }
      click = await off2.startRendering();
    }
    return { audio, click };
  }
  /** AudioBuffer → 24-bit PCM WAV Blob */
  static encodeWav24(buffer) {
    const ch = buffer.numberOfChannels, n = buffer.length, sr = buffer.sampleRate, block = ch * 3, dataLen = n * block;
    const out = new ArrayBuffer(44 + dataLen), dv = new DataView(out); const w = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, sr, true); dv.setUint32(28, sr * block, true); dv.setUint16(32, block, true); dv.setUint16(34, 24, true); w(36, 'data'); dv.setUint32(40, dataLen, true);
    const chans = []; for (let c = 0; c < ch; c++) chans.push(buffer.getChannelData(c));
    let p = 44;
    for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { const v = Math.max(-1, Math.min(1, chans[c][i])); const s = Math.round(v * 8388607); dv.setUint8(p, s & 255); dv.setUint8(p + 1, (s >> 8) & 255); dv.setUint8(p + 2, (s >> 16) & 255); p += 3; }
    return new Blob([out], { type: 'audio/wav' });
  }
}

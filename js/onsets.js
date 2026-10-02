/* onsets.js — Loop Lab analysis: band-split onset detection, drum labelling,
 * grid assignment, session signature, classification and per-loop metrics.
 *
 * makeOnsetDsp() is a self-contained factory (no outside references) so the
 * same code runs on the main thread, inside a Blob-URL worker and in Node for
 * tests. The maths:
 *
 *  - 4th-order Butterworth band filters = two cascaded RBJ biquads with
 *    Q = 0.5412 and 1.3066 (the poles of a 4th-order Butterworth).
 *  - Envelope: RMS over a 5 ms window every 1 ms, in dBFS.
 *  - Onset: a rise of ≥ riseDb within riseMs whose following peak clears the
 *    band floor; onset time = start of the monotonic rise (1 ms resolution).
 *  - Floor: Otsu's threshold over the candidate peak levels (the valley
 *    between "real hits" and "bleed/ghosts"), overridable per band.
 *  - Grid: loop start = bar 1 beat 1; each hit → nearest 16th; deviation in
 *    ms, positive = behind the grid.
 *  - Signature: per (drum, pos) median deviation across the session; a hit's
 *    residual = deviation − signature. Tight/feel/mistake follow the residual,
 *    never the metronome. */
'use strict';

function makeOnsetDsp() {
  const BUTTER4_Q = [0.5411961, 1.3065630];
  const DRUMS = ['kick', 'snare', 'hat', 'other'];

  /* ---------- filters ---------- */
  function biquad(type, fc, sr, Q) {
    const w0 = 2 * Math.PI * Math.min(fc, sr * 0.499) / sr, cw = Math.cos(w0), sw = Math.sin(w0), alpha = sw / (2 * Q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
    else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  }
  function butter4(type, fc, sr) { return BUTTER4_Q.map(q => biquad(type, fc, sr, q)); }
  function runBiquads(x, stages) {
    const y = new Float32Array(x.length);
    y.set(x);
    for (const c of stages) {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < y.length; i++) {
        const xi = y[i];
        const yi = c.b0 * xi + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
        x2 = x1; x1 = xi; y2 = y1; y1 = yi; y[i] = yi;
      }
    }
    return y;
  }
  /** mono → {low, mid, high} band signals */
  function bandSplit(mono, sr, edges = { low: 150, midLo: 150, midHi: 2500, high: 5000 }) {
    return {
      low: runBiquads(mono, butter4('lp', edges.low, sr)),
      mid: runBiquads(runBiquads(mono, butter4('hp', edges.midLo, sr)), butter4('lp', edges.midHi, sr)),
      high: runBiquads(mono, butter4('hp', edges.high, sr)),
    };
  }

  /* ---------- envelope ---------- */
  /** RMS in dBFS per 1 ms hop over a winMs window ENDING at the frame time, so
   *  the envelope starts rising at the onset itself, not winMs/2 before it. */
  function envelopeDb(x, sr, hopMs = 1, winMs = 5) {
    const hop = Math.max(1, Math.round(sr * hopMs / 1000)), win = Math.max(1, Math.round(sr * winMs / 1000));
    const n = Math.floor(x.length / hop) + 1;
    const cum = new Float64Array(x.length + 1);
    for (let i = 0; i < x.length; i++) cum[i + 1] = cum[i] + x[i] * x[i];
    const env = new Float32Array(n);
    for (let f = 0; f < n; f++) {
      const c = f * hop; let a = c - win + 1, b = c + 1;
      if (a < 0) a = 0; if (b > x.length) b = x.length;
      const p = b > a ? (cum[b] - cum[a]) / (b - a) : 0;
      env[f] = p <= 1e-12 ? -120 : 10 * Math.log10(p);
    }
    return env;
  }

  /* ---------- floor (Otsu) ---------- */
  function otsuThreshold(values) {
    if (values.length < 4) return values.length ? Math.max(...values) - 30 : -60;
    const lo = Math.min(...values), hi = Math.max(...values);
    if (hi - lo < 6) return lo - 1; // all alike: keep everything
    const bins = 32, w = (hi - lo) / bins, hist = new Array(bins).fill(0);
    for (const v of values) hist[Math.min(bins - 1, Math.floor((v - lo) / w))]++;
    let best = -1, bestT = lo, total = values.length, sumAll = 0;
    for (let i = 0; i < bins; i++) sumAll += i * hist[i];
    let wB = 0, sumB = 0;
    for (let i = 0; i < bins; i++) {
      wB += hist[i]; if (!wB) continue; const wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      const mB = sumB / wB, mF = (sumAll - sumB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; bestT = lo + (i + 1) * w; }
    }
    return bestT;
  }

  /* ---------- onsets in one band ---------- */
  /**
   * @returns {{onsets:[{ms, peakMs, levelDb}], floorDb, candidates:number}}
   */
  function detectBand(env, { riseDb = 10, riseMs = 4, floorDb = null, mergeMs = 12, peakWinMs = 25 } = {}) {
    const cands = [];
    let i = riseMs;
    while (i < env.length) {
      if (env[i] - env[i - riseMs] >= riseDb) {
        // start of the monotonic rise
        let s = i; while (s > 0 && env[s - 1] < env[s] && i - s < riseMs * 3) s--;
        // peak within the next peakWinMs, but stop once the envelope has fallen 1 dB from
        // its peak: a louder hit starting a few ms later must register as its own rise
        let pk = env[i], pkAt = i; const e = Math.min(env.length - 1, s + peakWinMs);
        for (let j = i; j <= e; j++) { if (env[j] > pk) { pk = env[j]; pkAt = j; } else if (env[j] < pk - 1) break; }
        cands.push({ ms: s, peakMs: pkAt, levelDb: pk });
        i = pkAt + 1; // skip past the peak before looking for another rise
      } else i++;
    }
    // nothing below −80 dBFS is a hit (keeps digital-silence artefacts out of the histogram)
    const usable = cands.filter(c => c.levelDb > -80);
    const floor = floorDb === null || floorDb === undefined ? Math.max(-80, otsuThreshold(usable.map(c => c.levelDb))) : floorDb;
    const kept = cands.filter(c => c.levelDb >= floor);
    // merge onsets closer than mergeMs (keep the earlier, take the louder level)
    const merged = [];
    for (const c of kept) {
      const last = merged[merged.length - 1];
      if (last && c.ms - last.ms < mergeMs) { if (c.levelDb > last.levelDb) { last.levelDb = c.levelDb; last.peakMs = c.peakMs; } }
      else merged.push({ ...c });
    }
    return { onsets: merged, floorDb: floor, candidates: cands.length };
  }

  /* ---------- labelling ----------
   * Band onsets within ±coincMs form one cluster (one physical hit or a
   * simultaneous kick+hat). Levels are the peak of each band's envelope inside
   * the cluster window (25 ms), then, in this order:
   *   kick  : a low (or, right after another kick, mid) onset with low ≥ mid + 6 dB;
   *           a low onset at least as loud as the mid one (and well above the low floor)
   *           alongside a mid onset counts as kick + snare together (one-drop)
   *   snare : otherwise a mid onset with mid ≥ low − 6 dB and mid ≥ high − 6 dB
   *           (mid-dominant and not just a hat; real snares often carry little above 5 kHz)
   *   hat   : a high onset with no snare in the cluster (a hat under a kick stays a hat)
   *   other : a cluster none of the rules claim
   * A low-band bump within 100 ms after a kick that is ≥ 10 dB quieter than it
   * is the kick's own decay, not a hit; a real flam is within a few dB. */
  function labelOnsets(bands, envs, coincMs = 10, flamMs = 60) {
    const items = [];
    for (const b of ['low', 'mid', 'high']) for (const o of bands[b].onsets) items.push({ band: b, ms: o.ms, peakMs: o.peakMs, levelDb: o.levelDb });
    items.sort((a, b) => a.ms - b.ms);
    const clusters = [];
    for (const it of items) {
      const c = clusters[clusters.length - 1];
      if (c && it.ms - c.ms <= coincMs) c.items.push(it); else clusters.push({ ms: it.ms, items: [it] });
    }
    const peakIn = (env, a, b) => { let m = -200; for (let i = Math.max(0, a); i <= Math.min(env.length - 1, b); i++) if (env[i] > m) m = env[i]; return m; };
    const out = []; let lastKick = null, lastKickLevel = -200, lastSnare = null;
    for (let ci = 0; ci < clusters.length; ci++) {
      const c = clusters[ci];
      const L = c.items.find(i => i.band === 'low'), M = c.items.find(i => i.band === 'mid'), H = c.items.find(i => i.band === 'high');
      if (H && !L && !M && lastSnare !== null && c.ms - lastSnare < 25) continue;   // the snare's own top-end flutter, not a hat
      // level window: 25 ms, but never past the next cluster's start (a hit 15 ms later must not colour this one)
      const a = c.ms, b = Math.min(c.ms + 25, ci + 1 < clusters.length ? clusters[ci + 1].ms - 1 : c.ms + 25);
      const lo = peakIn(envs.low, a, b), mi = peakIn(envs.mid, a, b), hi = peakIn(envs.high, a, b);
      const levels = { low: lo, mid: mi, high: hi };
      let claimed = false;
      const push = (drum, src, level) => { out.push({ ms: src.ms, peakMs: src.peakMs, levelDb: level, drum, band: src.band, levels }); claimed = true; };
      const afterKick = lastKick !== null ? c.ms - lastKick : Infinity;
      const flamFollow = afterKick < flamMs && (L || M);
      let isKick = (L || (M && flamFollow)) && lo >= mi + 6 && lo >= bands.low.floorDb;
      if (isKick && afterKick < 100 && lo < lastKickLevel - 10) { isKick = false; if (L && !M && !H) continue; } // decay bump of the previous kick
      if (isKick) { push('kick', L || M, lo); lastKick = c.ms; lastKickLevel = lo; }
      // kick and snare together (one-drop): low and mid onsets both present, within 6 dB of each other, both above their floors
      const together = !isKick && L && M && lo >= mi && lo >= bands.low.floorDb + 10 && mi >= bands.mid.floorDb && lo >= lastKickLevel - 12;
      if (together) { push('kick', L, lo); lastKick = c.ms; lastKickLevel = lo; }
      const isSnare = (!isKick || together) && M && mi >= lo - 6 && mi >= hi - 6;
      if (isSnare) { push('snare', M, mi); lastSnare = c.ms; }
      if (H && !isSnare) push('hat', H, hi);
      if (!claimed) { const src = c.items.slice().sort((x, y) => y.levelDb - x.levelDb)[0]; push('other', src, src.levelDb); }
    }
    out.sort((a, b) => a.ms - b.ms || DRUMS.indexOf(a.drum) - DRUMS.indexOf(b.drum));
    return out;
  }

  /** Full detection on a mono Float32Array. floors: {low, mid, high} dB or null. */
  function analyzeMono(mono, sr, { floors = {}, riseDb = 10, riseMs = 4, mergeMs = 12, flamMs = 60 } = {}) {
    const split = bandSplit(mono, sr);
    const envs = { low: envelopeDb(split.low, sr), mid: envelopeDb(split.mid, sr), high: envelopeDb(split.high, sr) };
    const bands = {};
    // hats are never closer than ~25 ms; the low/mid bands keep the short window so flams survive
    for (const b of ['low', 'mid', 'high']) bands[b] = detectBand(envs[b], { riseDb, riseMs, mergeMs: b === 'high' ? Math.max(mergeMs, 25) : mergeMs, floorDb: floors[b] === undefined ? null : floors[b] });
    const hits = labelOnsets(bands, envs, 10, flamMs);
    return { hits, floors: { low: bands.low.floorDb, mid: bands.mid.floorDb, high: bands.high.floorDb }, candidates: { low: bands.low.candidates, mid: bands.mid.candidates, high: bands.high.candidates }, envs };
  }
  /** Stems: detect on the stem's broadband envelope, label by file role, and
   *  measure the level in the drum's own band (low / mid / high) so it is
   *  comparable with mix-based loops in the same session. */
  function analyzeStem(mono, sr, drum, { riseDb = 10, riseMs = 4, mergeMs = 12, floorDb = null } = {}) {
    const env = envelopeDb(mono, sr);
    const r = detectBand(env, { riseDb, riseMs, mergeMs, floorDb });
    const bandOf = { kick: 'low', snare: 'mid', hat: 'high' }[drum];
    let bandEnv = env;
    if (bandOf) { const split = bandSplit(mono, sr); bandEnv = envelopeDb(split[bandOf], sr); }
    const peakIn = (e, a, b) => { let m = -200; for (let i = Math.max(0, a); i <= Math.min(e.length - 1, b); i++) if (e[i] > m) m = e[i]; return m; };
    return r.onsets.map(o => ({ ms: o.ms, peakMs: o.peakMs, levelDb: peakIn(bandEnv, o.ms, o.ms + 25), drum, band: 'stem', levels: {} }));
  }

  /* ---------- grid ---------- */
  function gridInfo(bpm, num = 4, den = 4) {
    const sixteenth = 60 / bpm / 4;               // a 16th of a quarter note, in seconds
    const posPerBar = Math.round(num * 16 / den); // 4/4 → 16, 3/4 → 12, 6/8 → 12
    return { sixteenth, posPerBar, barSec: sixteenth * posPerBar, beatSec: sixteenth * 4 * (4 / den) };
  }
  /** Assign a time (seconds from loop start) to the nearest 16th; wraps around the loop end. */
  function assign(tSec, g, bars, farMs) {
    const total = bars * g.posPerBar;
    let idx = Math.round(tSec / g.sixteenth);
    const dev = (tSec - idx * g.sixteenth) * 1000;
    if (idx >= total) idx -= total; if (idx < 0) idx += total;
    return { bar: Math.floor(idx / g.posPerBar) + 1, pos: idx % g.posPerBar, devMs: dev, far: Math.abs(dev) > farMs };
  }
  const posName = (pos) => { const beat = Math.floor(pos / 4) + 1, sub = ['', 'e', '&', 'a'][pos % 4]; return `${beat}${sub}`; };

  /* ---------- statistics ---------- */
  const median = (arr) => { if (!arr.length) return null; const s = arr.slice().sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  /**
   * Signature + expected sets + level medians from a set of loops.
   * loops: [{bars, barRange, hits:[{drum,bar,pos,devMs,levelDb,far,override}]}]
   * A loop's bar parity comes from its absolute bar number when barRange is
   * known (so the A bar of a 2-bar cycle lines up across loops), else from the
   * loop-relative bar.
   */
  function buildSignature(loops, { expectedShare = 0.75, minHits = 3, minShare = 0.25 } = {}) {
    const dev = {}, lev = {}, barsByParity = { odd: 0, even: 0 }, present = { odd: {}, even: {} };
    const parityOf = (loop, bar) => { const abs = loop.barRange && Number.isFinite(loop.barRange.start) ? loop.barRange.start + bar - 1 : bar; return abs % 2 ? 'odd' : 'even'; };
    for (const loop of loops) {
      const barsInLoop = Math.max(1, Math.round(loop.bars || 1));
      const seen = {};
      for (let b = 1; b <= barsInLoop; b++) { barsByParity[parityOf(loop, b)]++; }
      for (const h of loop.hits || []) {
        if (h.override && h.override.class === 'ignore') continue;
        if (h.far || h.drum === 'other') continue;
        const key = `${h.drum}:${h.pos}`;
        (dev[key] = dev[key] || []).push(h.devMs);
        (lev[key] = lev[key] || []).push(h.levelDb);
        const p = parityOf(loop, h.bar); const bk = `${h.bar}|${key}`;
        if (!seen[bk]) { seen[bk] = true; present[p][key] = (present[p][key] || 0) + 1; }
      }
    }
    const signature = {}, levelMedian = {}, counts = {}, sparse = {};
    const totalBars = barsByParity.odd + barsByParity.even;
    for (const key of Object.keys(dev)) {
      if (dev[key].length < minHits) continue;
      // a position played in fewer than minShare of the bars is a variation, not part of the pocket:
      // it is reported (greyed in the table) but hits there are not judged against it
      if (dev[key].length < minShare * totalBars) { const [d, p] = key.split(':'); (sparse[d] = sparse[d] || {})[p] = { median: +median(dev[key]).toFixed(1), count: dev[key].length }; continue; }
      const [drum, pos] = key.split(':');
      (signature[drum] = signature[drum] || {})[pos] = +median(dev[key]).toFixed(1);
      (levelMedian[drum] = levelMedian[drum] || {})[pos] = +median(lev[key]).toFixed(1);
      (counts[drum] = counts[drum] || {})[pos] = dev[key].length;
    }
    const expected = { odd: {}, even: {} };
    for (const p of ['odd', 'even']) {
      const total = barsByParity[p]; if (!total) continue;
      for (const key of Object.keys(present[p])) {
        if (present[p][key] / total >= expectedShare) { const [drum, pos] = key.split(':'); (expected[p][drum] = expected[p][drum] || []).push(+pos); }
      }
      for (const d of Object.keys(expected[p])) expected[p][d].sort((a, b) => a - b);
    }
    return { signature, levelMedian, counts, expected, barsByParity, sparse, totalBars };
  }

  /**
   * Classify one loop's hits against a signature. Mutates/returns new hit
   * objects with residualMs, class, mistakeType; returns missing list too.
   */
  function classifyLoop(loop, sig, thresholds, corePositions) {
    const T = Object.assign({ tightMs: 8, feelMs: 20, flamMs: 60, dynamicsDb: 6, farMs: 60 }, thresholds || {});
    const core = corePositions || { kick: [0, 8], snare: [4, 11] };
    const parityOf = (bar) => { const abs = loop.barRange && Number.isFinite(loop.barRange.start) ? loop.barRange.start + bar - 1 : bar; return abs % 2 ? 'odd' : 'even'; };
    const hits = (loop.hits || []).map(h => Object.assign({}, h));
    hits.sort((a, b) => a.samples - b.samples);
    // flams: same drum, < flamMs apart, where the signature has one hit at that position
    for (let i = 1; i < hits.length; i++) {
      const a = hits[i - 1], b = hits[i];
      for (let j = i - 1; j >= 0 && (b.tSeconds - hits[j].tSeconds) * 1000 < T.flamMs; j--) {
        const p = hits[j];
        if (p.drum !== b.drum || p.drum === 'other') continue;
        const sigHas = sig.signature[b.drum] && (sig.signature[b.drum][b.pos] !== undefined || sig.signature[b.drum][p.pos] !== undefined);
        if (sigHas || b.pos === p.pos) { b._flam = true; }
      }
      void a;
    }
    for (const h of hits) {
      const s = sig.signature[h.drum] ? sig.signature[h.drum][h.pos] : undefined;
      const inSig = s !== undefined;
      h.residualMs = inSig ? +(h.devMs - s).toFixed(1) : null;
      h.mistakeType = null;
      if (h.drum === 'other') h.class = 'extra';
      else if (h.far) { h.class = 'mistake'; h.mistakeType = 'far'; }
      else if (h._flam) { h.class = 'mistake'; h.mistakeType = 'flam'; }
      else if (!inSig) h.class = 'extra';
      else {
        const r = Math.abs(h.residualMs), d = Math.abs(h.devMs);
        if (r > T.feelMs) { h.class = 'mistake'; h.mistakeType = 'late'; }
        else if (r > T.tightMs || d > T.tightMs) h.class = 'feel';
        else h.class = 'tight';
        // dynamics outlier on core hits
        const isCore = core[h.drum] && core[h.drum].includes(h.pos);
        const lm = sig.levelMedian[h.drum] && sig.levelMedian[h.drum][h.pos];
        if (isCore && lm !== undefined && Math.abs(h.levelDb - lm) > T.dynamicsDb && h.class !== 'mistake') { h.class = 'mistake'; h.mistakeType = 'dynamics'; }
      }
      delete h._flam;
      h.autoClass = h.class;
      if (h.override && h.override.class) h.class = h.override.class;
    }
    // missing expected hits
    const missing = [];
    const barsInLoop = Math.max(1, Math.round(loop.bars || 1));
    for (let b = 1; b <= barsInLoop; b++) {
      const exp = sig.expected[parityOf(b)] || {};
      for (const drum of Object.keys(exp)) for (const pos of exp[drum]) {
        if (!hits.some(h => h.drum === drum && h.bar === b && h.pos === pos && h.class !== 'ignore')) missing.push({ drum, bar: b, pos });
      }
    }
    return { hits, missing };
  }

  /** Per-loop metrics and the machine score. */
  function loopMetrics(hits, missing, sig, corePositions, joinInfo) {
    const core = corePositions || { kick: [0, 8], snare: [4, 11] };
    const live = hits.filter(h => h.class !== 'ignore');
    const sigHits = (drum) => live.filter(h => h.drum === drum && h.residualMs !== null && h.mistakeType !== 'far');
    const cons = {};
    for (const d of ['kick', 'snare', 'hat']) { const r = sigHits(d).map(h => Math.abs(h.residualMs)); cons[d] = r.length ? +mean(r).toFixed(1) : null; }
    const ks = sigHits('kick').concat(sigHits('snare')).map(h => Math.abs(h.residualMs));
    const consistency = ks.length ? mean(ks) : null;
    const coreHits = live.filter(h => core[h.drum] && core[h.drum].includes(h.pos));
    const feelMs = coreHits.length ? +mean(coreHits.map(h => h.devMs)).toFixed(1) : null;
    const k1and = live.filter(h => h.drum === 'kick' && h.pos === 2).map(h => h.devMs);
    const hatsOn = live.filter(h => h.drum === 'hat' && h.pos % 4 === 0).map(h => h.devMs), hatsAnd = live.filter(h => h.drum === 'hat' && h.pos % 4 === 2).map(h => h.devMs);
    const counts = { kick: 0, snare: 0, hat: 0, other: 0, extra: 0 };
    for (const h of live) { counts[h.drum] = (counts[h.drum] || 0) + 1; if (h.class === 'extra') counts.extra++; }
    const mistakes = { late: 0, flam: 0, missing: missing.length, dynamics: 0, far: 0 };
    for (const h of live) if (h.class === 'mistake') { const t = h.mistakeType || (h.override ? 'late' : 'late'); mistakes[t] = (mistakes[t] || 0) + 1; }
    const spread = {};
    for (const d of ['kick', 'snare', 'hat']) { const lv = coreHits.filter(h => h.drum === d).map(h => h.levelDb); spread[d] = lv.length > 1 ? +(Math.max(...lv) - Math.min(...lv)).toFixed(1) : null; }
    let score = consistency === null ? null : Math.max(0, Math.min(10, 10 - (consistency - 6) / 2.5));
    if (score !== null) { score -= mistakes.flam * 1 + mistakes.dynamics * 0.5 + Math.min(4, mistakes.missing * 2); score = +Math.max(0, score).toFixed(1); }
    return {
      score, consistencyMs: cons, feelMs, push1andMs: k1and.length ? +mean(k1and).toFixed(1) : null,
      hatSwingMs: hatsOn.length && hatsAnd.length ? +(mean(hatsAnd) - mean(hatsOn)).toFixed(1) : null,
      mistakes, counts, dynamicsSpreadDb: spread,
      join: joinInfo ? joinInfo.verdict : 'unknown', joinDetail: joinInfo ? joinInfo.detail : {},
    };
  }

  /** Join analysis on the raw channels: RMS tail vs head, discontinuity, pushed downbeat. */
  function joinAnalysis(channels, sr, hitsMs, loopSamples) {
    const n = Math.round(sr * 0.02), L = loopSamples || channels[0].length;
    let head = 0, tail = 0, disc = 0;
    for (const ch of channels) {
      for (let i = 0; i < n && i < L; i++) head += ch[i] * ch[i];
      for (let i = Math.max(0, L - n); i < L; i++) tail += ch[i] * ch[i];
      disc = Math.max(disc, Math.abs(ch[L - 1] - ch[0]));
    }
    const k = channels.length * n;
    const dB = (p) => p <= 1e-12 ? -120 : 10 * Math.log10(p);
    const headDb = dB(head / k), tailDb = dB(tail / k);
    const loopMs = L / sr * 1000;
    const pushed = hitsMs.some(ms => ms >= loopMs - 15 && ms < loopMs);
    let verdict = 'clean';
    if (pushed) verdict = 'pushed downbeat';
    else if (disc > 0.02) verdict = 'click likely';
    else if (tailDb > -30 && tailDb > headDb - 12) verdict = 'tail';
    return { verdict, detail: { headRmsDb: +headDb.toFixed(1), tailRmsDb: +tailDb.toFixed(1), discontinuity: +disc.toFixed(4), discontinuityDb: +(disc <= 1e-6 ? -120 : 20 * Math.log10(disc)).toFixed(1), pushedOnsetMs: pushed ? +(hitsMs.filter(ms => ms >= loopMs - 15 && ms < loopMs)[0] - loopMs).toFixed(1) : null } };
  }

  return { biquad, butter4, runBiquads, bandSplit, envelopeDb, otsuThreshold, detectBand, labelOnsets, analyzeMono, analyzeStem, gridInfo, assign, posName, median, mean, buildSignature, classifyLoop, loopMetrics, joinAnalysis, DRUMS };
}

const ANALYSIS_VERSION = 3;   // bump when detection/classification maths change (invalidates cached analyses)
const OnsetDsp = makeOnsetDsp();

/** Worker wrapper: runs analyzeMono / analyzeStem off the main thread. */
function onsetWorkerMain() {
  const dsp = makeOnsetDsp();
  self.onmessage = (ev) => {
    const m = ev.data;
    try {
      if (m.type === 'mono') {
        const r = dsp.analyzeMono(m.mono, m.sr, m.options || {});
        self.postMessage({ jobId: m.jobId, hits: r.hits, floors: r.floors, candidates: r.candidates });
      } else if (m.type === 'stem') {
        self.postMessage({ jobId: m.jobId, hits: dsp.analyzeStem(m.mono, m.sr, m.drum, m.options || {}) });
      }
    } catch (e) { self.postMessage({ jobId: m.jobId, error: (e && e.message) || String(e) }); }
  };
}
class OnsetWorker {
  constructor() {
    const src = `${makeOnsetDsp.toString()}\n(${onsetWorkerMain.toString()})();`;
    this.worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
    this.jobs = new Map();
    this.worker.onmessage = (ev) => { const j = this.jobs.get(ev.data.jobId); if (!j) return; this.jobs.delete(ev.data.jobId); if (ev.data.error) j.reject(new Error(ev.data.error)); else j.resolve(ev.data); };
    this.worker.onerror = (e) => { for (const j of this.jobs.values()) j.reject(new Error(e.message || 'worker error')); this.jobs.clear(); };
  }
  analyzeMono(mono, sr, options) { return this._run({ type: 'mono', mono, sr, options }, [mono.buffer]); }
  analyzeStem(mono, sr, drum, options) { return this._run({ type: 'stem', mono, sr, drum, options }, [mono.buffer]); }
  _run(msg, transfer) { const jobId = U.uid('oj'); return new Promise((resolve, reject) => { this.jobs.set(jobId, { resolve, reject }); this.worker.postMessage(Object.assign({ jobId }, msg), transfer); }); }
}
if (typeof module !== "undefined" && module.exports) module.exports = { makeOnsetDsp, ANALYSIS_VERSION };

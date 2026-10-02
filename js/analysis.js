/* analysis.js — turns the worker's per-frame descriptors into per-second or
 * per-bar rows (the unit the AI bundle and the overlay use), plus global
 * statistics. Frames are hop-sized (1024 samples); a row averages the power
 * of every frame whose start falls inside it, so re-aggregating after a tempo
 * change is instant and needs no re-analysis. */
'use strict';

const Analysis = {
  /**
   * @param {object} d  worker descriptors {hop, sampleRate, frameCount, rms, peak, low, mid, high, onset, global}
   * @param {Grid|null} grid  when valid, rows are bars; otherwise seconds
   * @param {number} duration seconds
   */
  aggregate(d, grid, duration) {
    if (!d) return null;
    const useBars = grid && grid.valid;
    const rows = [];
    const frameSec = d.hop / d.sampleRate;
    let bounds = [];
    if (useBars) {
      const first = Math.floor(grid.beatsAt(0) / grid.num);       // bar index (0-based from bar 1) containing t=0
      const last = Math.floor(grid.beatsAt(duration) / grid.num);
      const maxRows = 5000;
      for (let b = first; b <= last && bounds.length < maxRows; b++) {
        const t0 = Math.max(0, grid.secondsAtBeats(b * grid.num)), t1 = Math.min(duration, grid.secondsAtBeats((b + 1) * grid.num));
        if (t1 <= t0) continue;
        bounds.push({ label: String(b + 1), bar: b + 1, t0, t1 });
      }
    } else {
      for (let s = 0; s < duration; s++) bounds.push({ label: String(s), bar: null, t0: s, t1: Math.min(duration, s + 1) });
    }
    let fi = 0;
    for (const b of bounds) {
      const f0 = Math.max(0, Math.ceil(b.t0 / frameSec - 1e-9)), f1 = Math.min(d.frameCount, Math.ceil(b.t1 / frameSec - 1e-9));
      let n = 0, rms = 0, pk = 0, lo = 0, mi = 0, hi = 0, on = 0;
      for (let f = Math.max(f0, 0); f < f1; f++) { n++; rms += d.rms[f]; if (d.peak[f] > pk) pk = d.peak[f]; lo += d.low[f]; mi += d.mid[f]; hi += d.high[f]; on += d.onset[f]; }
      void fi;
      if (n === 0) { rows.push({ ...b, empty: true, rmsDb: -100, peakDb: -100, lowDb: -100, midDb: -100, highDb: -100, onsets: 0 }); continue; }
      rows.push({ ...b, rmsDb: U.powDb(rms / n), peakDb: U.ampDb(pk), lowDb: U.powDb(lo / n), midDb: U.powDb(mi / n), highDb: U.powDb(hi / n), onsets: on });
    }
    const nonEmpty = rows.filter(r => !r.empty && r.t1 - r.t0 > (useBars ? grid.barSeconds * 0.5 : 0.5));
    const byRms = nonEmpty.slice().sort((a, b) => b.rmsDb - a.rmsDb);
    return {
      unit: useBars ? 'bar' : 'second', rows,
      global: { ...d.global, loudest: byRms.slice(0, 10), quietest: byRms.slice(-10).reverse() },
    };
  },
};

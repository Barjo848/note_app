/* peaks.js — PeakStore: holds the peak pyramid produced by the worker and
 * answers "min/max between sample A and sample B" for drawing, choosing the
 * coarsest level whose bucket still fits inside the requested span so every
 * pixel column reads at most a handful of buckets. Also owns the IndexedDB
 * cache keyed by file fingerprint. */
'use strict';

const PEAK_LEVELS = [64, 256, 1024, 4096, 16384, 65536];

class PeakStore {
  constructor() { this.levels = null; this.totalFrames = 0; this.channels = 0; }

  setLevels(levels, totalFrames, channels) {
    this.levels = levels; this.totalFrames = totalFrames; this.channels = channels;
  }
  get ready() { return !!this.levels; }

  /** Pick the coarsest level whose bucket ≤ samplesPerPixel (finest otherwise). */
  levelFor(samplesPerPixel) {
    let best = this.levels[0];
    for (const lv of this.levels) if (lv.bucket <= samplesPerPixel) best = lv;
    return best;
  }

  /**
   * Fill `out` (Float32Array of 2*width: min,max pairs in ±1) with the peak
   * envelope for `width` pixel columns starting at sample `start`, `spp`
   * samples per pixel, for channel index `ch` (or 'mono').
   * When a bucket is wider than a pixel, the column reads the bucket that
   * contains its centre sample, so alignment stays exact at deep zoom.
   */
  envelope(out, width, start, spp, ch) {
    const lv = this.levelFor(spp);
    const arr = ch === 'mono' ? lv.mono : lv.channels[Math.min(ch, lv.channels.length - 1)];
    const bucket = lv.bucket, count = lv.count;
    const k = 1 / 32767;
    for (let x = 0; x < width; x++) {
      const s0 = start + x * spp, s1 = s0 + spp;
      let b0 = Math.floor(s0 / bucket), b1 = Math.ceil(s1 / bucket);
      if (b1 <= b0) b1 = b0 + 1;
      if (b0 < 0) b0 = 0;
      if (b1 > count) b1 = count;
      if (b0 >= b1) { out[2 * x] = 0; out[2 * x + 1] = 0; continue; }
      let mn = 32767, mx = -32768;
      for (let b = b0; b < b1; b++) { const a = arr[2 * b], c = arr[2 * b + 1]; if (a < mn) mn = a; if (c > mx) mx = c; }
      out[2 * x] = mn * k; out[2 * x + 1] = mx * k;
    }
  }
}

/* ---------- IndexedDB cache ---------- */
const PeakCache = {
  DB: 'note', STORE: 'peaks', VERSION: 2,   // v2 adds the 'analysis' store (library.js)
  _open() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(this.DB, this.VERSION);
      req.onupgradeneeded = () => { const db = req.result; for (const st of ['peaks', 'analysis']) if (!db.objectStoreNames.contains(st)) db.createObjectStore(st); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  },
  async get(fingerprint) {
    try {
      const db = await this._open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE, 'readonly');
        const req = tx.objectStore(this.STORE).get(fingerprint);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
      });
    } catch (e) { console.warn('PeakCache.get failed', e); return null; }
  },
  async put(fingerprint, value) {
    try {
      const db = await this._open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE, 'readwrite');
        tx.objectStore(this.STORE).put(value, fingerprint);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      });
      return true;
    } catch (e) { console.warn('PeakCache.put failed', e); return false; }
  },
  async clear() {
    try {
      const db = await this._open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE, 'readwrite');
        tx.objectStore(this.STORE).clear();
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      });
      return true;
    } catch (e) { console.warn('PeakCache.clear failed', e); return false; }
  },
  async count() {
    try {
      const db = await this._open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE, 'readonly');
        const req = tx.objectStore(this.STORE).count();
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
        tx.oncomplete = () => db.close();
      });
    } catch (e) { return 0; }
  },
};

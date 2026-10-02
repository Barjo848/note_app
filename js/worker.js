/* worker.js — PeakWorker. The function below is serialised into a Blob URL
 * and run as a Web Worker, so it must be self-contained (no references to
 * the main-thread modules).
 *
 * Job: read the WAV data chunk in slices, decode samples on the fly, build a
 * min/max peak pyramid (per channel + mono mix), then run a second pass that
 * computes compact per-frame descriptors: RMS, peak, three band powers and
 * spectral flux, using a 2048-point radix-2 FFT.
 */
'use strict';

function peakWorkerMain() {
  const SLICE_BYTES = 4 * 1024 * 1024;
  let cancelled = false;
  let currentJob = null;

  self.onmessage = async (ev) => {
    const msg = ev.data;
    if (msg.type === 'cancel') { if (!currentJob || msg.jobId === currentJob) cancelled = true; return; }
    if (msg.type !== 'analyze') return;
    cancelled = false; currentJob = msg.jobId;
    try {
      const peaks = await computePeaks(msg.file, msg.info, msg.levels, msg.jobId);
      if (cancelled) return;
      const transfer = [];
      for (const lv of peaks) { for (const c of lv.channels) transfer.push(c.buffer); transfer.push(lv.mono.buffer); }
      self.postMessage({ type: 'peaks', jobId: msg.jobId, levels: peaks }, transfer);
      if (msg.wantDescriptors) {
        const d = await computeDescriptors(msg.file, msg.info, msg.jobId);
        if (cancelled) return;
        const t2 = ['rms', 'peak', 'low', 'mid', 'high', 'flux', 'onset'].map(k => d[k].buffer);
        self.postMessage({ type: 'descriptors', jobId: msg.jobId, descriptors: d }, t2);
      }
      self.postMessage({ type: 'done', jobId: msg.jobId });
    } catch (e) {
      self.postMessage({ type: 'error', jobId: msg.jobId, message: (e && e.message) || String(e) });
    }
  };

  /* ---------- sample decoding ----------
   * decodeSlice(buf, info, out) fills `out` (Float32Array, interleaved, ±1)
   * and returns the number of frames decoded. The slice always starts on a
   * frame boundary (we align slice sizes to blockAlign). */
  function makeDecoder(info) {
    const { channels, bitDepth, format } = info;
    if (format === 'float' && bitDepth === 32) {
      return (buf, out) => { const f = new Float32Array(buf); out.set(f); return f.length / channels; };
    }
    if (format === 'float' && bitDepth === 64) {
      return (buf, out) => { const f = new Float64Array(buf); for (let i = 0; i < f.length; i++) out[i] = f[i]; return f.length / channels; };
    }
    if (bitDepth === 16) {
      return (buf, out) => { const s = new Int16Array(buf); const k = 1 / 32768; for (let i = 0; i < s.length; i++) out[i] = s[i] * k; return s.length / channels; };
    }
    if (bitDepth === 24) {
      return (buf, out) => {
        const b = new Uint8Array(buf); const n = (b.length / 3) | 0; const k = 1 / 8388608;
        for (let i = 0, j = 0; i < n; i++, j += 3) {
          // little-endian 24-bit two's complement → sign-extend via <<8 >>8
          out[i] = (((b[j] | (b[j + 1] << 8) | (b[j + 2] << 16)) << 8) >> 8) * k;
        }
        return n / channels;
      };
    }
    if (bitDepth === 32) {
      return (buf, out) => { const s = new Int32Array(buf); const k = 1 / 2147483648; for (let i = 0; i < s.length; i++) out[i] = s[i] * k; return s.length / channels; };
    }
    if (bitDepth === 8) {
      return (buf, out) => { const b = new Uint8Array(buf); const k = 1 / 128; for (let i = 0; i < b.length; i++) out[i] = (b[i] - 128) * k; return b.length / channels; };
    }
    throw new Error(`Cannot decode ${format} ${bitDepth}-bit audio.`);
  }

  /** Iterate the data chunk in frame-aligned slices; cb(frames, count) per slice. */
  async function streamFrames(file, info, jobId, phase, cb) {
    const { blockAlign, dataOffset, dataSize, channels } = info;
    const decode = makeDecoder(info);
    const sliceBytes = Math.max(blockAlign, Math.floor(SLICE_BYTES / blockAlign) * blockAlign);
    const out = new Float32Array((sliceBytes / blockAlign) * channels);
    let read = 0, lastProgress = -1;
    while (read < dataSize) {
      if (cancelled) return;
      const n = Math.min(sliceBytes, dataSize - read);
      const buf = await file.slice(dataOffset + read, dataOffset + read + n).arrayBuffer();
      const frames = decode(buf, out);
      cb(out, frames);
      read += n;
      const p = read / dataSize;
      if (p - lastProgress >= 0.01 || read >= dataSize) { lastProgress = p; self.postMessage({ type: 'progress', jobId, phase, fraction: p }); }
    }
  }

  /* ---------- peaks ----------
   * Base level: `levels[0]` frames per bucket. For every bucket we keep
   * min and max per channel and of the mono mix (mean of channels), scaled
   * to Int16 so the whole pyramid stays small enough to cache. Coarser levels
   * fold the previous level by the ratio of their bucket sizes. */
  async function computePeaks(file, info, levels, jobId) {
    const { channels, totalFrames } = info;
    const base = levels[0];
    const nBuckets = Math.ceil(totalFrames / base);
    const chMin = [], chMax = [];
    for (let c = 0; c < channels; c++) { chMin.push(new Float32Array(nBuckets).fill(Infinity)); chMax.push(new Float32Array(nBuckets).fill(-Infinity)); }
    const moMin = new Float32Array(nBuckets).fill(Infinity), moMax = new Float32Array(nBuckets).fill(-Infinity);
    let frameIndex = 0;
    const invCh = 1 / channels;

    await streamFrames(file, info, jobId, 'peaks', (data, frames) => {
      let f = 0;
      while (f < frames) {
        const b = Math.floor(frameIndex / base);
        const bucketEnd = Math.min(frames, f + (base - (frameIndex % base)));
        let mnM = moMin[b], mxM = moMax[b];
        if (channels === 2) {
          let mn0 = chMin[0][b], mx0 = chMax[0][b], mn1 = chMin[1][b], mx1 = chMax[1][b];
          for (let i = f * 2, e = bucketEnd * 2; i < e; i += 2) {
            const l = data[i], r = data[i + 1];
            if (l < mn0) mn0 = l; if (l > mx0) mx0 = l;
            if (r < mn1) mn1 = r; if (r > mx1) mx1 = r;
            const m = (l + r) * 0.5;
            if (m < mnM) mnM = m; if (m > mxM) mxM = m;
          }
          chMin[0][b] = mn0; chMax[0][b] = mx0; chMin[1][b] = mn1; chMax[1][b] = mx1;
        } else if (channels === 1) {
          let mn0 = chMin[0][b], mx0 = chMax[0][b];
          for (let i = f; i < bucketEnd; i++) { const v = data[i]; if (v < mn0) mn0 = v; if (v > mx0) mx0 = v; }
          chMin[0][b] = mn0; chMax[0][b] = mx0; if (mn0 < mnM) mnM = mn0; if (mx0 > mxM) mxM = mx0;
        } else {
          for (let i = f; i < bucketEnd; i++) {
            let sum = 0;
            for (let c = 0; c < channels; c++) {
              const v = data[i * channels + c]; sum += v;
              if (v < chMin[c][b]) chMin[c][b] = v; if (v > chMax[c][b]) chMax[c][b] = v;
            }
            const m = sum * invCh; if (m < mnM) mnM = m; if (m > mxM) mxM = m;
          }
        }
        moMin[b] = mnM; moMax[b] = mxM;
        frameIndex += bucketEnd - f; f = bucketEnd;
      }
    });
    if (cancelled) return null;

    const toI16 = (arr) => { const o = new Int16Array(arr.length); for (let i = 0; i < arr.length; i++) { const v = arr[i]; o[i] = !isFinite(v) ? 0 : Math.max(-32768, Math.min(32767, Math.round(v * 32767))); } return o; };
    // Level layout: interleaved [min,max] pairs per bucket → Int16Array(2*n)
    const pack = (mn, mx) => { const o = new Int16Array(mn.length * 2); const a = toI16(mn), b = toI16(mx); for (let i = 0; i < mn.length; i++) { o[2 * i] = a[i]; o[2 * i + 1] = b[i]; } return o; };
    const out = [{ bucket: base, count: nBuckets, channels: chMin.map((mn, c) => pack(mn, chMax[c])), mono: pack(moMin, moMax) }];
    for (let L = 1; L < levels.length; L++) {
      const prev = out[L - 1], ratio = levels[L] / prev.bucket;
      const count = Math.ceil(prev.count / ratio);
      const fold = (src) => {
        const o = new Int16Array(count * 2);
        for (let i = 0; i < count; i++) {
          let mn = 32767, mx = -32768;
          for (let j = i * ratio, e = Math.min(prev.count, j + ratio); j < e; j++) { const a = src[2 * j], b = src[2 * j + 1]; if (a < mn) mn = a; if (b > mx) mx = b; }
          o[2 * i] = mn; o[2 * i + 1] = mx;
        }
        return o;
      };
      out.push({ bucket: levels[L], count, channels: prev.channels.map(fold), mono: fold(prev.mono) });
    }
    return out;
  }

  /* ---------- FFT ----------
   * In-place iterative radix-2 Cooley–Tukey on separate real/imag arrays.
   * Tables (bit reversal, twiddles) are built once for N = 2048. */
  function makeFFT(N) {
    const bits = Math.log2(N) | 0;
    const rev = new Uint32Array(N);
    for (let i = 0; i < N; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
    const cos = new Float32Array(N / 2), sin = new Float32Array(N / 2);
    for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / N); sin[i] = Math.sin(-2 * Math.PI * i / N); }
    return function fft(re, im) {
      for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1, step = N / size;
        for (let start = 0; start < N; start += size) {
          for (let k = 0, t = 0; k < half; k++, t += step) {
            const wr = cos[t], wi = sin[t];
            const a = start + k, b = a + half;
            const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
            re[b] = re[a] - xr; im[b] = im[a] - xi;
            re[a] += xr; im[a] += xi;
          }
        }
      }
    };
  }

  /* ---------- descriptors ----------
   * Frame i covers mono samples [i*hop, i*hop+hop) for RMS/peak and uses the
   * window [i*hop, i*hop+N) for the spectrum. Band powers are normalised so
   * that a full-scale sine reads ≈ -3 dBFS (power of a sine), i.e. the same
   * reference as the time-domain RMS: P = 2·Σ|X_k|² / (N·Σw²). */
  async function computeDescriptors(file, info, jobId) {
    const N = 2048, hop = 1024;
    const sr = info.sampleRate, channels = info.channels;
    const totalFrames = info.totalFrames;
    const nFrames = Math.max(1, Math.floor((totalFrames - N) / hop) + 1);
    const rms = new Float32Array(nFrames), peak = new Float32Array(nFrames);
    const low = new Float32Array(nFrames), mid = new Float32Array(nFrames), high = new Float32Array(nFrames);
    const flux = new Float32Array(nFrames), onset = new Uint8Array(nFrames);
    const fft = makeFFT(N);
    const win = new Float32Array(N); let wsum2 = 0;
    for (let i = 0; i < N; i++) { win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)); wsum2 += win[i] * win[i]; }
    const norm = 2 / (N * wsum2);
    const binHz = sr / N;
    const kLow = Math.max(1, Math.ceil(150 / binHz)), kMid = Math.min(N / 2, Math.ceil(2000 / binHz));
    const re = new Float32Array(N), im = new Float32Array(N);
    const prevMag = new Float32Array(N / 2 + 1);
    const mag = new Float32Array(N / 2 + 1);

    // rolling mono buffer: keep up to N-hop leftover samples between slices
    let carry = new Float32Array(0);
    let frame = 0, globalOffset = 0; // globalOffset = absolute index of carry[0]
    const invCh = 1 / channels;
    let sumPow = 0, globalPeak = 0, totalCount = 0;

    await streamFrames(file, info, jobId, 'descriptors', (data, frames) => {
      // mono mix of this slice appended to carry
      const mono = new Float32Array(carry.length + frames);
      mono.set(carry);
      if (channels === 1) mono.set(data.subarray(0, frames), carry.length);
      else if (channels === 2) { for (let i = 0, j = carry.length; i < frames; i++, j++) mono[j] = (data[2 * i] + data[2 * i + 1]) * 0.5; }
      else { for (let i = 0, j = carry.length; i < frames; i++, j++) { let s = 0; for (let c = 0; c < channels; c++) s += data[i * channels + c]; mono[j] = s * invCh; } }
      for (let i = carry.length; i < mono.length; i++) { const v = mono[i]; sumPow += v * v; const a = v < 0 ? -v : v; if (a > globalPeak) globalPeak = a; }
      totalCount += frames;

      // process every frame whose full window fits inside `mono`
      let localStart = frame * hop - globalOffset;
      while (localStart + N <= mono.length && frame < nFrames) {
        let p = 0, pk = 0;
        for (let i = localStart, e = localStart + hop; i < e; i++) { const v = mono[i]; p += v * v; const a = v < 0 ? -v : v; if (a > pk) pk = a; }
        rms[frame] = p / hop; peak[frame] = pk;
        for (let i = 0; i < N; i++) { re[i] = mono[localStart + i] * win[i]; im[i] = 0; }
        fft(re, im);
        let pl = 0, pm = 0, ph = 0, fl = 0;
        for (let k = 1; k <= N / 2; k++) {
          const pw = (re[k] * re[k] + im[k] * im[k]) * norm;
          if (k < kLow) pl += pw; else if (k < kMid) pm += pw; else ph += pw;
          const m = Math.sqrt(pw); const d = m - prevMag[k]; if (d > 0) fl += d; prevMag[k] = m;
        }
        low[frame] = pl; mid[frame] = pm; high[frame] = ph; flux[frame] = fl;
        frame++; localStart += hop;
      }
      // keep the tail that later frames still need
      const keepFrom = Math.max(0, frame * hop - globalOffset);
      carry = mono.slice(keepFrom);
      globalOffset += keepFrom;
    });
    if (cancelled) return null;

    // Onsets: local maxima of flux above 1.5× a ±8-frame local mean, at least 2 frames apart.
    const W = 8; let last = -10;
    for (let i = 1; i < nFrames - 1; i++) {
      if (!(flux[i] > flux[i - 1] && flux[i] >= flux[i + 1])) continue;
      let s = 0, n = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(nFrames - 1, i + W); j++) { s += flux[j]; n++; }
      const mean = s / n;
      if (flux[i] > 1.5 * mean + 1e-4 && i - last >= 2) { onset[i] = 1; last = i; }
    }
    const meanPow = totalCount ? sumPow / totalCount : 0;
    const dbP = (p) => p <= 1e-20 ? -100 : 10 * Math.log10(p);
    const dbA = (a) => a <= 1e-10 ? -100 : 20 * Math.log10(a);
    return {
      hop, windowSize: N, sampleRate: sr, frameCount: nFrames,
      rms, peak, low, mid, high, flux, onset,
      global: { integratedRmsDb: dbP(meanPow), peakDb: dbA(globalPeak), crestFactorDb: dbA(globalPeak) - dbP(meanPow), durationSeconds: info.durationSeconds },
    };
  }
}

/** Main-thread wrapper around the Blob-URL worker. */
class PeakWorker {
  constructor() {
    const src = `(${peakWorkerMain.toString()})();`;
    this._url = URL.createObjectURL(new Blob([src], { type: 'application/javascript' }));
    this.worker = new Worker(this._url);
    this.jobs = new Map();
    this.worker.onmessage = (ev) => {
      const m = ev.data; const job = this.jobs.get(m.jobId); if (!job) return;
      if (m.type === 'progress') job.onProgress && job.onProgress(m.phase, m.fraction);
      else if (m.type === 'peaks') job.onPeaks && job.onPeaks(m.levels);
      else if (m.type === 'descriptors') job.onDescriptors && job.onDescriptors(m.descriptors);
      else if (m.type === 'done') { this.jobs.delete(m.jobId); job.resolve(); }
      else if (m.type === 'error') { this.jobs.delete(m.jobId); job.reject(new Error(m.message)); }
    };
    this.worker.onerror = (e) => { for (const job of this.jobs.values()) job.reject(new Error(e.message || 'Worker error')); this.jobs.clear(); };
  }
  /** Returns {promise, cancel} */
  analyze(file, info, { levels, wantDescriptors = true, onProgress, onPeaks, onDescriptors }) {
    const jobId = U.uid('job');
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    this.jobs.set(jobId, { resolve, reject, onProgress, onPeaks, onDescriptors });
    const { dataOffset, dataSize, channels, sampleRate, bitDepth, format, blockAlign, totalFrames, durationSeconds } = info;
    this.worker.postMessage({ type: 'analyze', jobId, file, levels, wantDescriptors, info: { dataOffset, dataSize, channels, sampleRate, bitDepth, format, blockAlign, totalFrames, durationSeconds } });
    return { promise, cancel: () => { this.worker.postMessage({ type: 'cancel', jobId }); this.jobs.delete(jobId); reject(new Error('cancelled')); } };
  }
}

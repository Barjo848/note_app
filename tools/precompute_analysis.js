/* precompute_analysis.js — seed the app's analysis cache for a library so the first launch is instant.
 *   node tools/precompute_analysis.js <library-dir>
 * Reads manifest.json, decodes every WAV in Node, runs the same DSP the app runs (js/onsets.js,
 * js/sequence.js loopFeatures) and writes analysis-cache.json: { analysisVersion, entries: { <fingerprint>: {...} } }.
 * The app imports it into IndexedDB when the fingerprint and analysisVersion match. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const dirArg = process.argv[2];
if (!dirArg) { console.error('usage: node tools/precompute_analysis.js <library-dir>'); process.exit(1); }
const dir = path.resolve(dirArg);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
// load the app modules in one VM context (they are plain scripts with top-level consts)
const ctx = vm.createContext({ console, Math, JSON, Date, Number, Array, Float32Array, Float64Array, Int16Array, Int32Array, Uint8Array, Uint32Array, Object, String, TextEncoder, crypto: { randomUUID: () => Math.random().toString(36).slice(2) }, performance: { now: () => Date.now() }, module: {}, structuredClone: (v) => JSON.parse(JSON.stringify(v)) });
for (const f of ['util.js', 'onsets.js', 'sequence.js']) vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', f), 'utf8'), ctx, { filename: f });
const { OnsetDsp, Sequence, ANALYSIS_VERSION, U } = vm.runInContext('({ OnsetDsp, Sequence, ANALYSIS_VERSION, U })', ctx);
function readWav(file) {
  const b = fs.readFileSync(file); let pos = 12, fmt = null, data = null;
  while (pos + 8 <= b.length) { const id = b.toString('ascii', pos, pos + 4), sz = b.readUInt32LE(pos + 4); if (id === 'fmt ') { let tag = b.readUInt16LE(pos + 8); fmt = { ch: b.readUInt16LE(pos + 10), sr: b.readUInt32LE(pos + 12), bits: b.readUInt16LE(pos + 22) }; if (tag === 0xFFFE) tag = b.readUInt16LE(pos + 32); fmt.float = tag === 3; } if (id === 'data') { data = b.subarray(pos + 8, Math.min(b.length, pos + 8 + sz)); break; } pos += 8 + sz + (sz & 1); }
  const bps = fmt.bits / 8, frames = Math.floor(data.length / (fmt.ch * bps)); const chans = []; for (let c = 0; c < fmt.ch; c++) chans.push(new Float32Array(frames));
  for (let i = 0, j = 0; i < frames; i++) for (let c = 0; c < fmt.ch; c++, j += bps) {
    let v; if (fmt.float) v = data.readFloatLE(j); else if (bps === 3) v = (((data[j] | (data[j + 1] << 8) | (data[j + 2] << 16)) << 8) >> 8) / 8388608; else if (bps === 2) v = data.readInt16LE(j) / 32768; else if (bps === 4) v = data.readInt32LE(j) / 2147483648; else v = (data[j] - 128) / 128; chans[c][i] = v;
  }
  return { sr: fmt.sr, chans, frames };
}
const out = { analysisVersion: ANALYSIS_VERSION, library: manifest.name, generatedAt: new Date().toISOString(), entries: {} };
const t0 = Date.now(); const bpm = manifest.bpm || 108; const g = OnsetDsp.gridInfo(bpm, 4, 4);
for (const e of manifest.loops) {
  const file = path.join(dir, e.path); const { sr, chans, frames } = readWav(file);
  const mono = new Float32Array(frames); for (let i = 0; i < frames; i++) { let s = 0; for (const d of chans) s += d[i]; mono[i] = s / chans.length; }
  const r = OnsetDsp.analyzeMono(mono, sr, {});
  const bars = e.barsRounded || Math.max(1, Math.round(e.bars));
  const hits = r.hits.map(h => { const a = OnsetDsp.assign(h.ms / 1000, g, bars, 60); return { id: 'h_' + Math.random().toString(36).slice(2, 10), drum: h.drum, detectedDrum: h.drum, bar: a.bar, pos: a.pos, tSeconds: +(h.ms / 1000).toFixed(4), samples: Math.round(h.ms / 1000 * sr), devMs: +a.devMs.toFixed(1), residualMs: null, levelDb: +h.levelDb.toFixed(1), class: 'extra', mistakeType: null, far: a.far, override: null }; });
  const join = OnsetDsp.joinAnalysis(chans, sr, r.hits.map(h => h.ms), frames);
  let sum = 0; for (const d of chans) for (let i = 0; i < frames; i++) sum += d[i] * d[i]; const rmsLin = Math.sqrt(sum / (frames * chans.length));
  const bufferLike = { sampleRate: sr, length: frames, numberOfChannels: chans.length, getChannelData: (c) => chans[c] };
  const loop = { id: e.id, bars: e.bars, barsRounded: bars, offsetSamples: 0, hits, _join: join };
  const seamFeatures = Sequence.loopFeatures(loop, bufferLike, { session: { meterNumerator: 4 } });
  out.entries[e.fingerprint] = { id: e.id, raw: r.hits.map(h => ({ ms: h.ms, peakMs: h.peakMs, levelDb: +h.levelDb.toFixed(2), drum: h.drum, band: h.band })), floors: r.floors, join, rmsLin: +rmsLin.toFixed(6), rmsDb: +U.ampDb(rmsLin).toFixed(1), seamFeatures, sampleRate: sr, frames };
  process.stdout.write(`\r${Object.keys(out.entries).length}/${manifest.loops.length} ${e.id}          `);
}
fs.writeFileSync(path.join(dir, 'analysis-cache.json'), JSON.stringify(out));
console.log(`\nwrote analysis-cache.json (${Object.keys(out.entries).length} entries, v${ANALYSIS_VERSION}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

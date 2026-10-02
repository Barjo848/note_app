/* dsp_real.js — print raw band onsets for real loops (read-only) to tune the labeller. */
'use strict';
const fs = require('fs'), path = require('path');
const { makeOnsetDsp } = require('../js/onsets.js');
const dsp = makeOnsetDsp();
function readWav24(file) { const b = fs.readFileSync(file); let pos = 12, fmt = null, data = null; while (pos + 8 <= b.length) { const id = b.toString('ascii', pos, pos + 4), sz = b.readUInt32LE(pos + 4); if (id === 'fmt ') fmt = { ch: b.readUInt16LE(pos + 10), sr: b.readUInt32LE(pos + 12), bits: b.readUInt16LE(pos + 22) }; if (id === 'data') { data = b.subarray(pos + 8, pos + 8 + sz); break; } pos += 8 + sz + (sz & 1); } const frames = data.length / (fmt.ch * 3); const chans = []; for (let c = 0; c < fmt.ch; c++) chans.push(new Float32Array(frames)); for (let i = 0, j = 0; i < frames; i++) for (let c = 0; c < fmt.ch; c++, j += 3) chans[c][i] = (((data[j] | (data[j + 1] << 8) | (data[j + 2] << 16)) << 8) >> 8) / 8388608; return { sr: fmt.sr, chans }; }
const file = process.argv[2]; const { sr, chans } = readWav24(file); const mono = new Float32Array(chans[0].length); for (let i = 0; i < mono.length; i++) mono[i] = (chans[0][i] + chans[1][i]) / 2;
const split = dsp.bandSplit(mono, sr); const envs = { low: dsp.envelopeDb(split.low, sr), mid: dsp.envelopeDb(split.mid, sr), high: dsp.envelopeDb(split.high, sr) };
const g = dsp.gridInfo(108);
for (const b of ['low', 'mid', 'high']) { const r = dsp.detectBand(envs[b], {}); console.log(`${b}: floor ${r.floorDb.toFixed(1)} cands ${r.candidates} kept ${r.onsets.length}`); }
const r = dsp.analyzeMono(mono, sr, {});
console.log('floors', JSON.stringify(r.floors));
for (const h of r.hits) { const a = dsp.assign(h.ms / 1000, g, 2, 60); console.log(`${String(h.ms).padStart(5)} ms  b${a.bar} ${dsp.posName(a.pos).padEnd(3)} dev ${a.devMs.toFixed(0).padStart(4)}  ${h.drum.padEnd(5)} (${h.band})  L ${h.levels.low.toFixed(0)} M ${h.levels.mid.toFixed(0)} H ${h.levels.high.toFixed(0)}  lvl ${h.levelDb.toFixed(0)}`); }

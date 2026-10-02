/* dsp_check.js — run the Loop Lab analysis in Node against tests/fixtures/loops/*.wav
 * (24-bit stereo, decoded here) and print signature + classification. */
'use strict';
const fs = require('fs'), path = require('path');
const { makeOnsetDsp } = require('../js/onsets.js');
const dsp = makeOnsetDsp();
function readWav24(file) {
  const b = fs.readFileSync(file); let pos = 12, fmt = null, data = null;
  while (pos + 8 <= b.length) { const id = b.toString('ascii', pos, pos + 4), sz = b.readUInt32LE(pos + 4); if (id === 'fmt ') fmt = { ch: b.readUInt16LE(pos + 10), sr: b.readUInt32LE(pos + 12), bits: b.readUInt16LE(pos + 22) }; if (id === 'data') { data = b.subarray(pos + 8, pos + 8 + sz); break; } pos += 8 + sz + (sz & 1); }
  const frames = data.length / (fmt.ch * 3); const chans = []; for (let c = 0; c < fmt.ch; c++) chans.push(new Float32Array(frames));
  for (let i = 0, j = 0; i < frames; i++) for (let c = 0; c < fmt.ch; c++, j += 3) chans[c][i] = (((data[j] | (data[j + 1] << 8) | (data[j + 2] << 16)) << 8) >> 8) / 8388608;
  return { sr: fmt.sr, chans };
}
function loadLoop(file, bpm = 108) {
  const { sr, chans } = readWav24(file); const mono = new Float32Array(chans[0].length);
  for (let i = 0; i < mono.length; i++) mono[i] = (chans[0][i] + chans[1][i]) / 2;
  const g = dsp.gridInfo(bpm); const bars = Math.round(mono.length / sr / g.barSec);
  const r = dsp.analyzeMono(mono, sr, {});
  const hits = r.hits.map(h => { const a = dsp.assign(h.ms / 1000, g, bars, 60); return { drum: h.drum, bar: a.bar, pos: a.pos, devMs: +a.devMs.toFixed(1), far: a.far, tSeconds: h.ms / 1000, samples: Math.round(h.ms / 1000 * sr), levelDb: +h.levelDb.toFixed(1), override: null }; });
  return { id: path.basename(file, '.wav'), bars, hits, floors: r.floors, chans, sr, mono };
}
let args = process.argv.slice(2);
let dir = path.join(__dirname, 'fixtures', 'loops');
if (args[0] && fs.existsSync(args[0]) && fs.statSync(args[0]).isDirectory()) { dir = args[0]; args = args.slice(1); }
const names = args.length ? args : ['tight', 'feel', 'mistakes', 'pushed'];
const loops = names.map(n => loadLoop(path.join(dir, n + '.wav')));
const sig = dsp.buildSignature(loops);
console.log('signature', JSON.stringify(sig.signature)); console.log('expected', JSON.stringify(sig.expected));
for (const L of loops) {
  const c = dsp.classifyLoop(L, sig, {}, null);
  const join = dsp.joinAnalysis(L.chans, L.sr, L.hits.map(h => h.tSeconds * 1000), L.chans[0].length);
  const m = dsp.loopMetrics(c.hits, c.missing, sig, null, join);
  console.log(`\n== ${L.id}: floors ${JSON.stringify(L.floors)} score ${m.score} cons ${JSON.stringify(m.consistencyMs)} feel ${m.feelMs} push1& ${m.push1andMs} swing ${m.hatSwingMs} mistakes ${JSON.stringify(m.mistakes)} join ${m.join} ${JSON.stringify(m.joinDetail)}`);
  for (const h of c.hits) if (h.class !== 'tight') console.log(`   ${h.drum.padEnd(5)} b${h.bar} ${dsp.posName(h.pos).padEnd(3)} dev ${String(h.devMs).padStart(6)} res ${String(h.residualMs).padStart(6)} lvl ${h.levelDb} → ${h.class}${h.mistakeType ? ':' + h.mistakeType : ''}`);
  if (c.missing.length) console.log('   missing', JSON.stringify(c.missing));
  console.log('   counts', JSON.stringify(m.counts), 'tight', c.hits.filter(h => h.class === 'tight').length);
}

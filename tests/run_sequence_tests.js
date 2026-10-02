/* run_sequence_tests.js — Playwright acceptance tests for Sequence (release 1.2.0).
 * Invoked by scripts/run_tests.sh. PW_CHROMIUM selects the browser binary. */
'use strict';
const path = require('path'), fs = require('fs');
const { chromium } = require('playwright');
const { start } = require('./serve');
const ROOT = path.resolve(__dirname, '..'), FIX = path.join(__dirname, 'fixtures', 'loops'), SHOTS = path.join(__dirname, 'screenshots');
const args = process.argv.slice(2); const HEADED = args.includes('--headed'); const only = (args.find(a => a.startsWith('--only=')) || '').slice(7);
fs.mkdirSync(SHOTS, { recursive: true });
const results = []; const log = (...a) => console.log(...a);
async function test(name, fn) { if (only && !name.toLowerCase().includes(only.toLowerCase())) return; const t0 = Date.now(); try { await fn(); results.push({ name, ok: true }); log(`  ✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); } catch (e) { results.push({ name, ok: false }); log(`  ✘ ${name}: ${e.stack || e}`); } }
const assert = (c, m) => { if (!c) throw new Error('Assertion failed: ' + m); };
const near = (a, b, eps, m) => { if (Math.abs(a - b) > eps) throw new Error(`${m}: ${a} vs ${b} (eps ${eps})`); };
async function main() {
  const { server, port } = await start(0); const base = `http://127.0.0.1:${port}/`;
  const launch = { headless: !HEADED, args: ['--autoplay-policy=no-user-gesture-required'] };
  if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
  const browser = await chromium.launch(launch);
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => { log('  ! blocked', route.request().url()); route.abort(); });
  const page = await context.newPage(); const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + '.png') });
  const clickDialog = async (t) => page.locator('dialog[open] button', { hasText: t }).first().click();
  const fx = (n) => path.join(FIX, n + '.wav');
  const NAMES = ['tight', 'quiet', 'lazy', 'lighthats', 'pushed', 'feel'];
  const loadFixtures = async (names = NAMES) => { await page.setInputFiles('#lbFiles', names.map(fx)); await page.waitForFunction((n) => window.app.loopLab.lib.loops.length >= n && window.app.loopLab.lib.loops.every(l => l._analysed && l.seamFeatures) && !window.app.loopLab.progress.total, names.length, { timeout: 90000 }); };
  const lab = (fn, arg) => page.evaluate(fn, arg);
  /** build an arrangement through the store: blocks = [[loopId, repeats, gainDb], …] */
  const build = (name, blocks, settings) => lab(({ name, blocks, settings }) => { const L = window.app.loopLab; const a = L.seq.create(name); if (settings) L.seq.setSettings(a.id, settings); for (const [id, rep, g] of blocks) L.seq.addBlock(a.id, id, null, { repeats: rep || 1, gainDb: g || 0 }); L.selectArrangement(a.id); return a.id; }, { name, blocks, settings });
  const seams = () => lab(() => window.app.loopLab.seqView.seams.map(s => ({ kind: s.kind, from: s.fromLoop, to: s.toLoop, atBar: s.atBar, level: s.levelStepDb, feel: s.feelStepMs, high: s.highStepDb, hat: s.hatRateChange, pushed: s.pushedDownbeat, tail: s.tailCut, step: s.sampleStep, verdict: s.verdict, severity: s.severity, care: s.care, diff: s.signatureDiff })));

  await page.goto(base + 'index.html'); await page.waitForFunction(() => !!window.app && !!window.app.loopLab);
  await page.click('#btnModeLoops'); await page.waitForFunction(() => window.app.mode === 'loops');
  log('Sequence tests');
  await loadFixtures();
  await page.click('#lbViewSequence'); await page.waitForFunction(() => window.app.loopLab.view === 'sequence');

  await test('S1. tight×2, quiet×1, tight×1 renders to the sum of the file lengths; the repeat join is sample-identical', async () => {
    await build('render test', [['tight', 2], ['quiet', 1], ['tight', 1]]);
    const r = await lab(async () => {
      const L = window.app.loopLab; const a = L.arr; const spec = await L.seqSpec(a); const { audio } = await L.player.renderSequence(spec, { sampleRate: 48000, metronome: false, bpb: 4 });
      const src = L.lib.loop('tight')._buffer; const Ls = src.length; let maxErr = 0, maxErrJoin = 0;
      for (let c = 0; c < 2; c++) { const s = src.getChannelData(c), o = audio.getChannelData(c); for (let i = 0; i < 4800; i++) maxErr = Math.max(maxErr, Math.abs(o[Ls + i] - s[i])); for (let i = -48; i < 48; i++) maxErrJoin = Math.max(maxErrJoin, Math.abs(o[Ls + i] - s[(i + Ls) % Ls])); }
      // and the third block (tight again after quiet) starts exactly at 3·L
      let maxErr3 = 0; for (let c = 0; c < 2; c++) { const s = src.getChannelData(c), o = audio.getChannelData(c); for (let i = 0; i < 4800; i++) maxErr3 = Math.max(maxErr3, Math.abs(o[3 * Ls + i] - s[i])); }
      return { length: audio.length, expected: 4 * Ls, maxErr, maxErrJoin, maxErr3, gains: spec.occ.map(o => +o.gainLin.toFixed(3)), totalSec: spec.totalSec };
    });
    log('    ' + JSON.stringify(r));
    assert(r.length === r.expected, 'render length = sum of file lengths'); assert(r.maxErr < 1e-4 && r.maxErrJoin < 1e-4 && r.maxErr3 < 1e-4, 'repeat join and the block after quiet are sample-identical to the source');
    assert(r.gains[0] === 1 && r.gains[2] > 1.9 && r.gains[2] < 2.1, 'level match lifts the quiet block ≈ +6 dB and leaves tight at unity');
  });

  await test('S2. seam verdicts: level step 6 dB red, feel step 18 ms amber, texture change, pushed downbeat, tight→tight clean', async () => {
    await build('seams test', [['tight', 1], ['quiet', 1], ['tight', 1], ['lazy', 1], ['tight', 1], ['lighthats', 1], ['pushed', 1], ['tight', 1], ['tight', 1]], { levelMatch: false, seamFadeMs: 0 });
    const S = await seams(); for (const s of S) log(`    ${s.from} → ${s.to} @${s.atBar}: ${s.severity} "${s.verdict}" level ${s.level} feel ${s.feel} high ${s.high} hats ${s.hat} pushed ${s.pushed} tail ${s.tail} step ${s.step}${s.diff.length ? ' | ' + s.diff.join('; ') : ''}`);
    const find = (f, t) => S.find(s => s.kind === 'junction' && s.from === f && s.to === t);
    const tq = find('tight', 'quiet'); near(tq.level, -6, 0.6, 'tight→quiet level step ≈ −6 dB'); assert(tq.severity === 'red' && /watch level/.test(tq.verdict), 'red level verdict');
    const qt = find('quiet', 'tight'); near(qt.level, 6, 0.6, 'quiet→tight +6 dB'); assert(qt.severity === 'red', 'red');
    const tl = find('tight', 'lazy'); near(tl.feel, 18, 3, 'tight→lazy feel step ≈ 18 ms'); assert(tl.severity === 'amber' && /feel lurch/.test(tl.verdict), 'amber feel verdict');
    const th = find('tight', 'lighthats'); assert(/texture change/.test(th.verdict) && (th.high < -4 || th.hat < -0.3), 'tight→lighthats texture change'); log(`    lighthats: high ${th.high} dB, hat rate ${th.hat}`);
    const pt = find('pushed', 'tight'); assert(pt.pushed && pt.severity === 'red' && /pushed downbeat/.test(pt.verdict) && /cut ~15 ms before the bar line/.test(pt.care), 'pushed→tight verdict + advice');
    const tt = find('tight', 'tight'); assert(tt.verdict === 'clean' && tt.severity === 'green' && tt.step === 0, 'tight→tight clean');
    await lab(() => { window.app.loopLab.showSeqTab('seams'); }); await page.waitForTimeout(200); await shot('S2_seams_panel');
    const care = await lab(() => Sequence.careList(window.app.loopLab.seqView.seams)); assert(care.length >= 5 && care.some(c => /Bar 3 /.test(c) && /drops 6/.test(c)), 'care list in plain language: ' + care[0]);
  });

  await test('S3. drag from the loop list, reorder by drag, remove by dragging out, stepper, ⌘D, undo/redo', async () => {
    await build('ui test', []);
    await page.dragAndDrop('#sqLoopList .seq-loop[data-id="tight"]', '#sqLane');
    await page.waitForFunction(() => window.app.loopLab.arr.blocks.length === 1);
    await page.dragAndDrop('#sqLoopList .seq-loop[data-id="quiet"]', '#sqLane', { targetPosition: { x: 900, y: 50 } });
    await page.waitForFunction(() => window.app.loopLab.arr.blocks.length === 2);
    let order = await lab(() => window.app.loopLab.arr.blocks.map(b => b.loopId)); assert(order.join() === 'tight,quiet', 'HTML5 drop appends in order: ' + order);
    await shot('S3_after_drop');
    // reorder: drag the second block to the left of the first (mouse)
    const rects = await lab(() => window.app.loopLab.seqView.blockRects().map(r => ({ id: r.block.loopId, x0: r.x0, x1: r.x1 })));
    const box = await page.locator('#sqLane').boundingBox();
    const q = rects.find(r => r.id === 'quiet'), t = rects.find(r => r.id === 'tight');
    await page.mouse.move(box.x + (q.x0 + q.x1) / 2, box.y + 40); await page.mouse.down(); await page.mouse.move(box.x + t.x0 + 5, box.y + 40, { steps: 8 }); await page.mouse.move(box.x + t.x0 + 2, box.y + 42, { steps: 4 }); await page.mouse.up();
    order = await lab(() => window.app.loopLab.arr.blocks.map(b => b.loopId)); assert(order.join() === 'quiet,tight', 'drag reorder: ' + order);
    // remove by dragging out (below the lane)
    const rects2 = await lab(() => window.app.loopLab.seqView.blockRects().map(r => ({ id: r.block.loopId, x0: r.x0, x1: r.x1 })));
    const q2 = rects2.find(r => r.id === 'quiet');
    await page.mouse.move(box.x + (q2.x0 + q2.x1) / 2, box.y + 40); await page.mouse.down(); await page.mouse.move(box.x + (q2.x0 + q2.x1) / 2, box.y + box.height + 80, { steps: 8 }); await page.mouse.up();
    order = await lab(() => window.app.loopLab.arr.blocks.map(b => b.loopId)); assert(order.join() === 'tight', 'drag out removes: ' + order);
    // stepper and ⌘D
    await lab(() => { const L = window.app.loopLab; L.showSeqTab('block'); L.seqView.selectedBlockId = L.arr.blocks[0].id; L.renderSeqBlock(); });
    await page.click('#sqRepPlus'); await page.click('#sqRepPlus'); let rep = await lab(() => window.app.loopLab.arr.blocks[0].repeats); assert(rep === 3, 'stepper → 3');
    await page.click('#sqLane', { position: { x: 30, y: 40 } }); await page.keyboard.press('ArrowDown'); rep = await lab(() => window.app.loopLab.arr.blocks[0].repeats); assert(rep === 2, '↓ → 2');
    await page.keyboard.press('Meta+d'); let n = await lab(() => window.app.loopLab.arr.blocks.length); assert(n === 2, '⌘D duplicates');
    await page.fill('#sqRepeats', '70'); await page.press('#sqRepeats', 'Tab'); rep = await lab(() => window.app.loopLab.arr.blocks[1].repeats); assert(rep === 64, 'repeats clamp to 64');
    await page.click('#sqLane', { position: { x: 30, y: 40 } }); await page.keyboard.press('Backspace'); n = await lab(() => window.app.loopLab.arr.blocks.length); assert(n === 1, '⌫ removes');
    // undo every edit back to an empty arrangement, then redo
    const undone = await lab(() => { const L = window.app.loopLab; const labels = []; while (L.seq.canUndo) { labels.push(L.seq.undo()); if (!L.arr || !L.arr.blocks) break; } return { labels, blocks: L.arr ? L.arr.blocks.length : null }; });
    log('    undo chain: ' + undone.labels.join(' < '));
    assert(undone.labels.length >= 8 && undone.labels.includes('move block') && undone.labels.includes('remove block') && undone.labels.includes('duplicate block') && undone.labels.includes('edit block') && undone.labels.includes('add block'), 'every sequence edit is undoable');
    const redone = await lab(() => { const L = window.app.loopLab; let k = 0; while (L.seq.canRedo) { L.seq.redo(); k++; } const a = L.lib.arrangements.find(x => x.name === 'ui test'); L.selectArrangement(a.id); return { k, blocks: a.blocks.map(b => [b.loopId, b.repeats]) }; });
    assert(redone.blocks.length === 1 && redone.blocks[0][0] === 'tight' && redone.blocks[0][1] === 64, 'redo restores the final state (the surviving duplicate at 64 repeats): ' + JSON.stringify(redone.blocks));
  });

  await test('S4. mapping line: second repeat of 83-84 maps arrangement bars 3–4 to PT 83–84 again', async () => {
    await lab(() => { const l = window.app.loopLab.lib.loop('tight'); l.barRange = { start: 83, end: 84 }; });
    await build('mapping test', [['tight', 2], ['quiet', 1]]);
    const m = await lab(() => { const V = window.app.loopLab.seqView; const out = []; for (let bar = 1; bar <= V.totalBars(); bar++) { const i = Sequence.barInfo(V.layout, bar); out.push({ bar, pt: i.ptBar, rep: i.occ.repeatIndex + 1, loop: i.occ.loop.id, local: i.localBar }); } return out; });
    log('    ' + m.map(x => `arr ${x.bar}=${x.pt !== null ? 'PT' + x.pt : x.loop + ':' + x.local} (rep ${x.rep})`).join(', '));
    assert(m[2].pt === 83 && m[2].rep === 2 && m[3].pt === 84 && m[3].rep === 2 && m[0].pt === 83 && m[1].pt === 84 && m[4].pt === null, 'mapping');
    await page.check('#sqShowSource'); await page.hover('#sqLane', { position: { x: 100, y: 40 } }); await page.waitForTimeout(150); await shot('S4_mapping');
  });

  await test('S5. cue list Start/End values; Markdown and CSV agree', async () => {
    await lab(() => { const L = window.app.loopLab.lib; L.loop('quiet').barRange = { start: 301, end: 304 }; L.loop('quiet').barsRounded = 2; });
    await build('cues test', [['tight', 2], ['quiet', 1, -1.5], ['tight', 1]], { levelMatch: false });
    const r = await lab(() => { const L = window.app.loopLab; const a = L.arr; return { rows: Sequence.cuesRows(a, L.lib), md: Sequence.cuesMarkdown(a, L.lib), csv: Sequence.cuesCsv(a, L.lib) }; });
    const rows = r.rows; log('    ' + rows.map(x => `${x.arrStart}–${x.arrEnd} ${x.loopId} ${x.ptStart}→${x.ptEnd} rep ${x.repeat} trim ${x.gainDb} seam "${x.seamVerdict}"`).join(' | '));
    assert(rows.length === 4 && rows[0].ptStart === '83|1|000' && rows[0].ptEnd === '85|1|000' && rows[1].repeat === '2/2' && rows[1].arrStart === 3 && rows[2].ptStart === '301|1|000' && rows[2].ptEnd === '305|1|000' && rows[2].gainDb === -1.5 && rows[3].arrStart === 7, 'cue rows');
    assert(rows[1].seamVerdict && rows[2].seamVerdict && rows[0].seamVerdict === 'start', 'seam verdict leading into each row');
    const mdRows = r.md.split('\n').filter(l => /^\| \d+–\d+ \|/.test(l)); assert(mdRows.length === 4 && mdRows[2].includes('Start 301|1|000') && mdRows[2].includes('End 305|1|000') && mdRows[2].includes('-1.5'), 'markdown rows');
    const csvRows = r.csv.split('\n').filter(l => /^\d+,\d+,/.test(l)); assert(csvRows.length === 4 && csvRows[2].split(',')[4] === '301|1|000' && csvRows[2].split(',')[5] === '305|1|000', 'csv rows agree');
    assert(/## Care list/.test(r.md) && /care_list/.test(r.csv), 'care list appended');
    fs.writeFileSync(path.join(FIX, 'cues.md'), r.md); fs.writeFileSync(path.join(FIX, 'cues.csv'), r.csv);
    await lab(() => window.app.loopLab.showSeqTab('cues')); await shot('S5_cues');
  });

  await test('S6. v1 loops.json loads; v2 with two arrangements round-trips with unknown fields; standalone export re-imports', async () => {
    const docs = await lab(() => { const L = window.app.loopLab; const doc = L.lib.buildDocument(); const v1 = JSON.parse(JSON.stringify(doc)); v1.schemaVersion = 1; delete v1.arrangements; const v2 = JSON.parse(JSON.stringify(doc)); v2.myTop = 'x'; v2.arrangements[0].myArr = 1; v2.arrangements[0].blocks[0].myBlock = true; v2.arrangements[0].markers = [{ bar: 1, name: 'intro' }]; return { v1: JSON.stringify(v1), v2: JSON.stringify(v2), nArr: doc.arrangements.length, version: doc.schemaVersion }; });
    assert(docs.version === 2 && docs.nArr >= 2, 'document is v2 with arrangements');
    fs.writeFileSync(path.join(FIX, 'v1.loops.json'), docs.v1); fs.writeFileSync(path.join(FIX, 'v2.loops.json'), docs.v2);
    await lab(() => { window.app.loopLab.dirty = false; });
    await page.setInputFiles('#lbJson', path.join(FIX, 'v1.loops.json')); await page.waitForFunction(() => window.app.loopLab.lib.history.some(h => h.event === 'migrated'));
    const after1 = await lab(() => ({ n: window.app.loopLab.lib.loops.length, arr: window.app.loopLab.lib.arrangements.length, v: window.app.loopLab.lib.buildDocument().schemaVersion })); assert(after1.n === 6 && after1.arr === 0 && after1.v === 2, 'v1 loads and saves as v2: ' + JSON.stringify(after1));
    await lab(() => { window.app.loopLab.dirty = false; });
    await page.setInputFiles('#lbJson', path.join(FIX, 'v2.loops.json')); await page.waitForFunction(() => window.app.loopLab.lib.arrangements.length >= 2);
    const after2 = await lab(() => { const L = window.app.loopLab; const doc = L.lib.buildDocument(); return { myTop: doc.myTop, myArr: doc.arrangements[0].myArr, myBlock: doc.arrangements[0].blocks[0].myBlock, markers: doc.arrangements[0].markers, seams: doc.arrangements[0].seams.length, names: doc.arrangements.map(a => a.name), errors: L.lib.parseDocument(JSON.stringify(doc)).errors }; });
    assert(after2.myTop === 'x' && after2.myArr === 1 && after2.myBlock === true && after2.markers[0].name === 'intro' && after2.errors.length === 0, 'unknown fields survive, schema valid: ' + JSON.stringify(after2.errors));
    assert(after2.seams > 0, 'seams recomputed on load');
    await loadFixtures(); // re-link audio
    const ex = await lab(() => { const L = window.app.loopLab; const a = L.lib.arrangements.find(x => x.name === 'seams test'); L.selectArrangement(a.id); return JSON.stringify(Sequence.standaloneExport(a, L.lib)); });
    fs.writeFileSync(path.join(FIX, 'seams-test.arrangement.json'), ex);
    const imp = await lab(async (text) => { const L = window.app.loopLab; const a = L.lib.arrangements.find(x => x.name === 'seams test'); L.seq.remove(a.id); const ok = await L.seqImportArrangement(text, 'seams-test.arrangement.json'); const b = L.arr; return { ok, name: b.name, blocks: b.blocks.map(x => x.loopId), missing: b.blocks.filter(x => !L.lib.loop(x.loopId)).length, seams: L.seqView.seams.length }; }, ex);
    assert(imp.ok && imp.name === 'seams test' && imp.blocks.length === 9 && imp.missing === 0 && imp.seams === 8, 'standalone import re-links every block: ' + JSON.stringify(imp));
    const bad = JSON.stringify({ schemaVersion: 2, kind: 'arrangement', arrangement: { name: 'x' } }); const pb = lab((t) => window.app.loopLab.seqImportArrangement(t, 'bad.json'), bad); await page.waitForSelector('dialog[open]'); const dt = await page.locator('dialog[open]').innerText(); await clickDialog('OK'); assert((await pb) === false && /blocks/.test(dt), 'invalid arrangement refused: ' + dt.slice(0, 100));
  });

  await test('S7. seam audition plays one bar + one bar on repeat with the click locked; A/B between arrangements switches at a bar', async () => {
    const r = await lab(async () => {
      const L = window.app.loopLab; const a = L.lib.arrangements.find(x => x.name === 'seams test'); L.selectArrangement(a.id);
      L.seqView.selectedSeamIndex = L.seqView.seams.find(s => s.from !== s.to && s.kind === 'junction').index;
      await L.seqAuditionSeam(); const p = L.player; const d = p.seq.decks.A; const spec = d.spec;
      const bar = spec.occ[0].lengthSec; const beats = d.beats.map(b => +b.t.toFixed(6));
      const out = { occ: spec.occ.length, totalSec: spec.totalSec, bar, beats: d.beats.length, beat4: beats[4], occ1start: +spec.occ[1].startSec.toFixed(6), loopWhole: p.seq.loopWhole, metro: p.metro.on, mode: p.mode, seqMode: L.seqMode };
      // drift check over 60 passes: beat k·8 must sit on pass boundaries
      out.pass60 = +(60 * spec.totalSec).toFixed(9); out.beatTimeline60 = +(60 * spec.totalSec + beats[0]).toFixed(9);
      p.stop();
      // A/B between two arrangements
      const b = L.lib.arrangements.find(x => x.name !== 'seams test'); L.seqAB = { A: a.id, B: b.id }; L.blind.on = false; await L.seqAudition('A');
      const info0 = p.seqInfo('A'); const nb = p.nextBarTime(); const tau = (nb - p.t0) * p.rate + p.startOffset; const tot = p.seq.decks.A.spec.totalSec; const pos = tau % tot; const onBar = p.seq.decks.A.beats.some(bt => bt.beatInBar === 0 && Math.abs(bt.t - pos) < 1e-6) || Math.abs(pos) < 1e-6;
      p.switchTo('B', { atNextBar: true }); const active = p.active; const mode = p.mode; p.stop();
      return Object.assign(out, { abMode: mode, active, onBar, tau, tot, info0: !!info0 });
    });
    log('    ' + JSON.stringify(r));
    assert(r.occ === 2 && r.beats === 8 && r.loopWhole && r.metro && r.seqMode === 'seam', 'two one-bar occurrences on repeat with the click');
    near(r.totalSec, 2 * r.bar, 1e-6, 'total = two bars'); near(r.beat4, r.occ1start, 1e-6, 'beat 5 starts exactly at the incoming bar');
    assert(r.abMode === 'seqab' && r.active === 'B' && r.onBar, 'A/B of two arrangements switches at a bar boundary');
  });

  if (pageErrors.length) log('  page errors:\n    ' + pageErrors.join('\n    '));
  await browser.close(); server.close();
  const failed = results.filter(r => !r.ok); log(`\n${results.length - failed.length}/${results.length} passed`); if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });

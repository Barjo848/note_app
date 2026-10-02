/* run_loop_tests.js — Playwright acceptance tests for Loop Lab (release 1.1.0).
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
  const launch = { headless: !HEADED, args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream'] };
  if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
  const browser = await chromium.launch(launch);
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => { log('  ! blocked', route.request().url()); route.abort(); });
  const page = await context.newPage(); const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + '.png') });
  const clickDialog = async (t) => page.locator('dialog[open] button', { hasText: t }).first().click();
  const fx = (n) => path.join(FIX, n + '.wav');
  const loadFixtures = async (names = ['tight', 'feel', 'mistakes', 'pushed']) => { await page.setInputFiles('#lbFiles', names.map(fx)); await page.waitForFunction((n) => window.app.loopLab.lib.loops.length >= n && window.app.loopLab.lib.loops.every(l => l._analysed) && !window.app.loopLab.progress.total, names.length, { timeout: 60000 }); };
  const lab = (fn, arg) => page.evaluate(fn, arg);

  await page.goto(base + 'index.html'); await page.waitForFunction(() => !!window.app && !!window.app.loopLab);
  await page.click('#btnModeLoops'); await page.waitForFunction(() => window.app.mode === 'loops');
  log('Loop Lab tests');

  await test('L1. fixtures load as a session; signature appears; classes match the programmed hits', async () => {
    await loadFixtures();
    const r = await lab(() => { const L = window.app.loopLab.lib; const o = { basis: L.sigBasis, sig: L.session.signature, loops: {} }; for (const l of L.loops) o.loops[l.id] = { bars: l.bars, exact: l.barsExact, mistakes: l.machine.mistakes, score: l.machine.score, join: l.machine.join, missing: l.missing, classes: l.hits.reduce((a, h) => { a[h.class] = (a[h.class] || 0) + 1; return a; }, {}), snare11: l.hits.filter(h => h.drum === 'snare' && h.pos === 11).map(h => h.class), feelHits: l.hits.filter(h => h.class === 'feel').map(h => `${h.drum}${h.pos}:${h.devMs}`) }; return o; });
    log('    signature ' + JSON.stringify(r.sig));
    assert(r.basis === 'session', 'session signature (≥3 loops)');
    near(r.sig.snare['11'], 24, 2, 'snare 3a signature ≈ +24 ms'); near(r.sig.kick['2'], -6, 2, 'kick 1& signature ≈ −6 ms');
    for (const [id, l] of Object.entries(r.loops)) { log(`    ${id}: bars ${l.bars} exact=${l.exact} score ${l.score} mistakes ${JSON.stringify(l.mistakes)} join "${l.join}" classes ${JSON.stringify(l.classes)}`); assert(l.exact && Math.round(l.bars) === 2, `${id} is 2 bars`); }
    const M = (id) => r.loops[id].mistakes, sum = (m) => Object.values(m).reduce((a, b) => a + b, 0);
    assert(sum(M('tight')) === 0 && r.loops.tight.classes.mistake === undefined, 'tight: no mistakes');
    assert(r.loops.tight.snare11.every(c => c === 'feel'), 'tight: snare 3a (+24 ms off the click, on the drummer) reads as feel, never mistake');
    assert(sum(M('feel')) === 0 && r.loops.feel.classes.feel >= 10 && r.loops.feel.classes.mistake === undefined, 'feel: zero mistakes, snares and hats feel');
    assert(M('mistakes').late === 1 && M('mistakes').flam === 1 && M('mistakes').missing === 1 && M('mistakes').dynamics === 1 && M('mistakes').far === 0, 'mistakes: exactly one late, flam, missing, dynamics');
    assert(r.loops.mistakes.missing.length === 1 && r.loops.mistakes.missing[0].drum === 'kick' && r.loops.mistakes.missing[0].bar === 2 && r.loops.mistakes.missing[0].pos === 8, 'missing kick bar 2 beat 3');
    assert(r.loops.pushed.join === 'pushed downbeat', 'pushed: join = pushed downbeat'); assert(r.loops.tight.join === 'clean', 'tight: join clean');
    assert(r.loops.tight.score === 10 && r.loops.mistakes.score < r.loops.tight.score, 'machine score ordering');
    await lab(() => window.app.loopLab.select('mistakes')); await page.waitForTimeout(300);
    await shot('L1_mistakes_loop');
    await lab(() => window.app.loopLab.showTab('signature')); await shot('L1_signature');
    const sigText = await page.locator('#lbTab-signature').innerText(); assert(/snare/.test(sigText) && /\+24/.test(sigText), 'signature table shows snare 3a +24');
  });

  await test('L2. gapless loop: OfflineAudioContext render of tight.wav twice has a sample-exact join', async () => {
    const r = await lab(async () => {
      const lab = window.app.loopLab; const l = lab.lib.loop('tight'); await lab.ensureBuffer(l); const buf = l._buffer; const L = buf.length;
      const off = new OfflineAudioContext(buf.numberOfChannels, L * 2 + 4800, buf.sampleRate);
      const src = off.createBufferSource(); src.buffer = buf; src.loop = true; src.loopStart = 0; src.loopEnd = buf.duration; src.connect(off.destination); src.start(0);
      const out = await off.startRendering();
      let maxErr = 0, maxErrJoin = 0, energyJoin = 0;
      for (let c = 0; c < buf.numberOfChannels; c++) { const s = buf.getChannelData(c), o = out.getChannelData(c); for (let i = 0; i < 4800; i++) { const e = Math.abs(o[L + i] - s[i]); if (e > maxErr) maxErr = e; } for (let i = -48; i < 48; i++) { const e = Math.abs(o[L + i] - s[(i + L) % L]); if (e > maxErrJoin) maxErrJoin = e; energyJoin += Math.abs(o[L + i] - o[L + i - 1]); } }
      return { maxErr, maxErrJoin, L, stepAtJoin: Math.abs(out.getChannelData(0)[L] - out.getChannelData(0)[L - 1]), sourceStep: Math.abs(buf.getChannelData(0)[0] - buf.getChannelData(0)[L - 1]) };
    });
    log('    ' + JSON.stringify(r));
    assert(r.maxErr < 1e-4 && r.maxErrJoin < 1e-4, 'second pass equals the source sample-for-sample (no gap, no smear)');
    near(r.stepAtJoin, r.sourceStep, 1e-4, 'the only step at the join is the material\'s own');
  });

  await test('L3. metronome timing model stays locked to the loop over 60 loops; A/B switch lands on a bar', async () => {
    const r = await lab(async () => {
      const lab = window.app.loopLab; const p = lab.player; const A = lab.lib.loop('tight'), B = lab.lib.loop('feel'); await lab.ensureBuffer(A); await lab.ensureBuffer(B);
      lab.ab = { A: 'tight', B: 'feel' }; await lab.play();
      const loopSec = p.decks.A.loopSec; const beats = p.grid.beatsPerBar * 2;
      const drift60 = (p.beatTime(60 * beats) - p.t0) * p.rate - 60 * loopSec;
      const nb = p.nextBarTime(); const barPos = ((nb - p.t0) * p.rate) / p.grid.barSec;
      p.switchTo('B', { atNextBar: true }); const active = p.active;
      await new Promise(r => setTimeout(r, 700));
      const pos1 = p.position(); const advanced = p.ctx.currentTime > p.t0;
      p.setMetro({ on: true }); await new Promise(r => setTimeout(r, 300)); const scheduled = p._nextBeat;
      const mode = p.mode; p.stop();
      return { loopSec, beatSec: p.grid.beatSec, nominal: p.nominalBeatSec, drift60, barPos, active, advanced, pos1, scheduled, mode, ctxState: p.ctx.state };
    });
    log('    ' + JSON.stringify(r));
    assert(Math.abs(r.drift60) < 1e-9, 'beat 480 coincides with loop 60 exactly');
    near(r.barPos, Math.round(r.barPos), 1e-9, 'next bar time is an integer bar'); assert(r.active === 'B' && r.mode === 'ab', 'switch scheduled, deck B active');
    assert(r.scheduled > 0, 'metronome scheduled ahead');
    if (!r.advanced) log('    (AudioContext clock did not advance in headless; live audio not verifiable here)'); else assert(r.pos1 > 0, 'position advances');
  });

  await test('L3b. offline render: 480 metronome clicks over 60 loops land on the loop grid (no drift, none missed)', async () => {
    const r = await lab(async () => {
      const lab = window.app.loopLab; const sr = 48000, loopLen = 213333, loops = 60;
      const silent = new AudioContext().createBuffer(2, loopLen, sr);           // a silent 2-bar loop: only clicks reach the output
      const total = Math.ceil(loops * loopLen + sr * 0.5);
      const off = new OfflineAudioContext(2, total, sr);
      const p = new LoopPlayer(); p.useContext(off); p.setGrid(108, 4, 4); p.setMetro({ on: true, levelDb: 0, sound: 'click', subdiv: 0, accent: true });
      const entry = { id: 'silent', offsetSamples: 0, _rmsLin: 0.1 };
      // step the offline clock: schedule, render 100 ms, repeat
      const step = 0.1; let t = step; const steps = [];
      while (t < total / sr) { const s = off.suspend(t); s.then(() => { p._schedule(); off.resume(); }); steps.push(s); t += step; }
      p.start({ A: { entry, buffer: silent } }); p._schedule();
      const out = await off.startRendering();
      const d = out.getChannelData(0); const clicks = []; let i = 0;
      const endSample = Math.round(p.t0 * sr) + loops * loopLen;
      while (i < d.length && i < endSample - 100) { if (Math.abs(d[i]) > 0.02) { let pk = i, pv = 0; for (let j = i; j < i + 96; j++) if (Math.abs(d[j]) > pv) { pv = Math.abs(d[j]); pk = j; } clicks.push(pk); i += Math.round(sr * 0.1); } else i++; }
      const t0 = p.t0, beat = p.grid.beatSec; const errs = clicks.map((c, k) => c - Math.round((t0 + k * beat) * sr));
      const rel = errs.map(e => e - errs[0]);                       // every click peaks 1 ms after its scheduled time
      const maxErr = Math.max(...rel.map(Math.abs)); const lastLoopStart = Math.round((t0 + 59 * 8 * beat) * sr), loop59 = Math.round((t0 * sr) + 59 * loopLen);
      return { count: clicks.length, maxErr, beatSec: beat, lockedToFile: lastLoopStart - loop59, first: clicks[0] - Math.round(t0 * sr) };
    });
    log('    ' + JSON.stringify(r));
    assert(r.count === 480, `480 clicks expected, got ${r.count}`);
    assert(r.maxErr <= 24, 'every click within half a millisecond of its beat time (measurement is limited by the click tone period)');
    assert(Math.abs(r.lockedToFile) <= 1, 'beat 472 (loop 60 start) coincides with 59 × file length');
  });

  await test('L4. blind mode hides which loop is A/B and reveals correctly', async () => {
    const r = await lab(() => { const lab = window.app.loopLab; lab.setBlind(true); lab.assignDeck('A', 'tight'); lab.assignDeck('B', 'feel'); lab.showTab('ab'); const hidden = document.getElementById('lbTab-ab').innerText; const tableTags = document.querySelectorAll('#lbTable .deck-tag').length; const mapA = lab.deckLoop('A').id, mapB = lab.deckLoop('B').id; return { hidden, tableTags, swapped: lab.blind.swapped, mapA, mapB }; });
    assert(/\?\?/.test(r.hidden) && !/tight|feel/.test(r.hidden.split('\n')[0]) && r.tableTags === 0, 'names hidden while blind: ' + r.hidden.split('\n')[0]);
    assert(r.swapped ? (r.mapA === 'feel' && r.mapB === 'tight') : (r.mapA === 'tight' && r.mapB === 'feel'), 'deck mapping consistent with the coin toss');
    await shot('L4_blind'); await page.click('#lbReveal');
    const after = await lab(() => ({ text: document.getElementById('lbTab-ab').innerText, tags: document.querySelectorAll('#lbTable .deck-tag').length, revealed: window.app.loopLab.blind.revealed }));
    assert(after.revealed && after.tags === 2 && /revealed/.test(after.text) && (/A is the loop you set as (A|B)/.test(after.text)), 'reveal shows the mapping: ' + after.text.split('\n')[0]);
    await lab(() => window.app.loopLab.setBlind(false));
  });

  await test('L5. rating control: one decimal, 0.0–9.9, 10 not representable', async () => {
    const r = await lab(() => { const lab = window.app.loopLab; lab.select('tight'); const W = document.getElementById('lbRatingWhole'), T = document.getElementById('lbRatingTenth'), S = document.getElementById('lbRatingSlider'); W.value = '9'; T.value = '9'; lab.saveRating(); const a = lab.lib.loop('tight').rating; S.value = '9.9'; S.dispatchEvent(new Event('input')); const digits = W.value + '.' + T.value; return { a, digits, sliderMax: S.max, clamp10: LoopLibrary.clampRating(10), clamp12: LoopLibrary.clampRating(12.7), clampDec: LoopLibrary.clampRating(7.25), fmt: LoopLibrary.formatRating(7.25), neg: LoopLibrary.clampRating(-1), wholeOpts: Array.from(W.options).map(o => o.value).filter(Boolean), json: JSON.stringify(lab.lib.buildDocument().loops.find(l => l.id === 'tight').rating) }; });
    log('    ' + JSON.stringify(r));
    assert(r.a === 9.9 && r.digits === '9.9' && r.sliderMax === '9.9' && r.clamp10 === 9.9 && r.clamp12 === 9.9 && r.clampDec === 7.3 && r.fmt === '7.3' && r.neg === 0 && !r.wholeOpts.includes('10') && r.json === '9.9', 'rating rules');
  });

  await test('L6. loops.json round-trips (ratings, hits, overrides, layers, unknown fields) and overrides persist', async () => {
    const text = await lab(() => { const lab = window.app.loopLab; const L = lab.lib; const m = L.loop('mistakes'); const late = m.hits.find(h => h.mistakeType === 'late'); L.setHitOverride('mistakes', late.id, 'feel', 'he meant it'); const k = m.hits.find(h => h.drum === 'hat'); L.setHitDrum('mistakes', k.id, 'other'); L.setRating('mistakes', 6.5, 'flam on 3', ['maybe']); L.session.name = 'fixture session'; const doc = L.buildDocument(); doc.myTop = 1; doc.session.mySession = 'x'; doc.loops[0].myLoop = true; doc.loops[0].hits[0].myHit = 'h'; return lab.persist.serialize(doc); });
    fs.writeFileSync(path.join(FIX, 'roundtrip.loops.json'), text);
    const before = JSON.parse(text);
    await page.reload(); await page.waitForFunction(() => !!window.app && !!window.app.loopLab); await page.click('#btnModeLoops');
    await page.evaluate(() => { const b = document.getElementById('banner'); if (!b.hidden) b.hidden = true; });
    await page.setInputFiles('#lbJson', path.join(FIX, 'roundtrip.loops.json'));
    await page.waitForFunction(() => window.app.loopLab.lib.loops.length === 4);
    const after = await lab(() => { const L = window.app.loopLab.lib; const doc = JSON.parse(window.app.loopLab.persist.serialize(L.buildDocument())); const m = L.loop('mistakes'); return { doc, override: m.hits.find(h => h.override && h.override.class === 'feel'), corrected: m.hits.filter(h => h.drum === 'other' && h.detectedDrum === 'hat').length, mistakes: m.machine.mistakes, rating: m.rating, notes: m.notes, tags: m.tags, dirty: window.app.loopLab.dirty, unlinked: L.loops.filter(l => !l._file).length }; });
    assert(after.doc.myTop === 1 && after.doc.session.mySession === 'x' && after.doc.loops[0].myLoop === true && after.doc.loops[0].hits[0].myHit === 'h', 'unknown fields survive at document, session, loop and hit level');
    assert(after.override && after.override.override.reason === 'he meant it' && after.override.class === 'feel', 'override persisted and applied after reload');
    assert(after.mistakes.late === 0 && after.corrected === 1, 'override removes the late mistake; drum correction persisted');
    assert(after.rating === 6.5 && after.notes === 'flam on 3' && after.tags[0] === 'maybe' && after.doc.session.name === 'fixture session' && after.doc.session.bpm === 108, 'ratings, notes, tags, session intact');
    assert(after.doc.loops.every((l, i) => l.hits.length === before.loops[i].hits.length && l.hits.every((h, j) => h.samples === before.loops[i].hits[j].samples)), 'hit sample positions identical');
    assert(!after.dirty && after.unlinked === 4, 'clean after load; audio needs re-opening (documented)');
    // re-link by opening the files again
    await loadFixtures(); const linked = await lab(() => window.app.loopLab.lib.loops.filter(l => l._file).length + '/' + window.app.loopLab.lib.loops.length); assert(linked === '4/4', 're-opening the WAVs re-links every loop by fingerprint: ' + linked);
    const still = await lab(() => { const m = window.app.loopLab.lib.loop('mistakes'); return { ov: !!m.hits.find(h => h.override && h.override.class === 'feel'), late: m.machine.mistakes.late }; }); assert(still.ov && still.late === 0, 'override survives re-analysis');
  });

  await test('L7. sidecar imports as a layer, matches by id, shows disagreements and its scores in the table', async () => {
    const side = await lab(() => { const L = window.app.loopLab.lib; const t = L.loop('tight'); const hits = t.hits.map(h => ({ drum: h.drum, bar: h.bar, pos: h.pos, tSeconds: h.tSeconds, devMs: h.devMs, residualMs: h.residualMs, levelDb: h.levelDb, class: h.class })); hits[0].class = 'mistake'; return { schemaVersion: 1, source: 'imported sidecar', createdAt: '2026-09-13T12:00:00Z', bpm: 108, signature: { kick: { 0: 0.4 }, snare: { 11: 24.1 } }, loops: [{ id: 'tight', fileNameHint: 'tight.wav', score: 9.8, tight: 10, loop: 9.8, notes: 'stem-accurate: one flam I hear on the first hit', hits, missing: [{ drum: 'kick', bar: 2, pos: 8 }] }, { id: 'feel', score: 8.1, notes: 'laid back', hits: [] }, { id: '999-1000', score: 1, notes: 'not in session' }] }; });
    fs.writeFileSync(path.join(FIX, 'sidecar.imported-loops.json'), JSON.stringify(side, null, 2));
    await page.setInputFiles('#lbSidecar', path.join(FIX, 'sidecar.imported-loops.json'));
    await page.waitForFunction(() => window.app.loopLab.lib.layers.length === 1);
    const hiddenCell = await lab(() => { const lab = window.app.loopLab; lab.select('tight'); return { col: document.getElementById('lbThClaude').hidden, text: document.getElementById('lbTab-layers').innerText }; });
    assert(hiddenCell.col && !/9\.8/.test(hiddenCell.text), 'imported layer values hidden until revealed (1.3 blind default)');
    const r = await lab(() => { const lab = window.app.loopLab; lab.setReveal('all'); lab.select('tight'); lab.showTab('layers'); const ly = lab.lib.layers[0]; const cmp = lab.lib.compareWithLayer('tight', ly.id); return { name: ly.name, kind: ly.kind, matched: Object.keys(ly.loops), dis: cmp.disagreements, pairs: cmp.pairs.length, theirMissing: cmp.theirMissing.length, layersText: document.getElementById('lbTab-layers').innerText, headerHidden: document.getElementById('lbThClaude').hidden, cell: Array.from(document.querySelectorAll('#lbTable tbody tr')).find(tr => tr.dataset.id === 'tight').querySelector('td.claude').textContent.trim(), unmatched: lab.lib.history[lab.lib.history.length - 1].unmatched }; });
    log('    ' + JSON.stringify({ name: r.name, matched: r.matched, dis: r.dis, pairs: r.pairs, cell: r.cell, unmatched: r.unmatched }));
    assert(r.name === 'Imported', 'new sidecar layer is named Imported: ' + r.name);
    assert(r.kind === 'imported' && r.matched.includes('tight') && r.matched.includes('feel') && r.unmatched.includes('999-1000'), 'matched by id, unmatched reported');
    assert(r.dis === 1 && r.pairs === (await lab(() => window.app.loopLab.lib.loop('tight').hits.length)) && r.theirMissing === 1, 'one class disagreement found');
    assert(/1 disagreement/.test(r.layersText) && /app tight vs layer mistake|app feel vs layer mistake/.test(r.layersText), 'layers panel lists the disagreement: ' + r.layersText.slice(0, 200));
    assert(!r.headerHidden && r.cell === '9.8', 'layer score column in the table');
    await shot('L7_sidecar_disagreement');
    const bad = { schemaVersion: 1, loops: [{ score: 1 }] }; fs.writeFileSync(path.join(FIX, 'bad.imported-loops.json'), JSON.stringify(bad));
    const p2 = page.setInputFiles('#lbSidecar', path.join(FIX, 'bad.imported-loops.json')); await page.waitForSelector('dialog[open]'); const dt = await page.locator('dialog[open]').innerText(); await clickDialog('OK'); await p2; assert(/refused/i.test(dt) && /loops\[0\]/.test(dt) && /id/.test(dt), 'invalid sidecar refused with path: ' + dt.slice(0, 120));
  });

  await test('L8. exports (Markdown + CSV ranking) and shortcuts that must not fire while typing', async () => {
    const r = await lab(() => { const L = window.app.loopLab.lib; return { md: L.exportMarkdown(), csv: L.exportCsv() }; });
    assert(/\| # \| loop \|/.test(r.md) && /mistakes/.test(r.md) && r.md.indexOf('| 1 | tight') > 0, 'markdown ranking sorted by my rating (tight 9.9 first)');
    assert(r.csv.split('\n')[0].startsWith('rank,id,file,bars,rating,machine_score') && r.csv.split('\n').length >= 5, 'csv rows');
    fs.writeFileSync(path.join(FIX, 'ranking.loops.md'), r.md);
    await lab(() => { window.app.loopLab.player.stop(); window.app.loopLab.player.setMetro({ on: false }); });
    await page.click('#lbNotes'); await page.type('#lbNotes', 'a b x j c r l 1 2 [ ] , .');
    const st = await lab(() => { const lab = window.app.loopLab; return { playing: lab.player.playing, metro: lab.player.metro.on, rate: lab.player.rate, cur: lab.currentId, text: document.getElementById('lbNotes').value }; });
    assert(!st.playing && !st.metro && st.rate === 1 && st.text === 'a b x j c r l 1 2 [ ] , .', 'no shortcuts fired while typing: ' + JSON.stringify(st));
    await page.keyboard.press('Meta+Enter'); const saved = await lab(() => window.app.loopLab.current.notes); assert(saved === 'a b x j c r l 1 2 [ ] , .', '⌘Enter saves notes');
    await lab(() => { const L = window.app.loopLab; L.select(L.visibleLoops()[0].id); if (document.activeElement) document.activeElement.blur(); });
    await page.keyboard.press('n'); await page.keyboard.press('m'); await page.keyboard.press('Shift+R');
    const st2 = await lab(() => ({ cur: window.app.loopLab.currentId, metro: window.app.loopLab.player.metro.on, rate: window.app.loopLab.player.rate, second: window.app.loopLab.visibleLoops()[1].id }));
    assert(st2.cur === st2.second && st2.metro && st2.rate === 0.5, 'shortcuts work outside fields (N next, M metronome, ⇧R rate): ' + JSON.stringify(st2));
    await page.keyboard.press('Shift+R'); await page.keyboard.press('Shift+R'); await page.keyboard.press('m');
  });

  await test('L9. stems: tight_KICK/SNARE/HIHAT files mark the loop stem-verified with the same hits', async () => {
    await page.setInputFiles('#lbFiles', ['tight_KICK', 'tight_SNARE', 'tight_HIHAT'].map(fx));
    await page.waitForFunction(() => window.app.loopLab.lib.loop('tight').stemVerified && !window.app.loopLab.progress.total, null, { timeout: 60000 });
    const r = await lab(() => { const t = window.app.loopLab.lib.loop('tight'); return { verified: t.stemVerified, hits: t.hits.length, kicks: t.hits.filter(h => h.drum === 'kick').length, snares: t.hits.filter(h => h.drum === 'snare').length, hats: t.hits.filter(h => h.drum === 'hat').length, mistakes: t.machine.mistakes }; });
    log('    ' + JSON.stringify(r));
    assert(r.verified && r.kicks === 6 && r.snares === 6 && r.hats === 16 && Object.values(r.mistakes).reduce((a, b) => a + b, 0) === 0, 'stems: all programmed hits including hats under snares, no mistakes');
  });

  await test('LX. write examples/example.loops.json and example.imported-loops.json from the fixture session', async () => {
    await page.reload(); await page.waitForFunction(() => !!window.app && !!window.app.loopLab); await page.click('#btnModeLoops');
    await page.evaluate(() => { const b = document.getElementById('banner'); if (!b.hidden) b.hidden = true; });
    await loadFixtures();
    const ex = await lab(() => {
      const lab = window.app.loopLab, L = lab.lib; L.session.name = 'Fixture loops'; L.session.sourceNote = 'tests/gen_wavs.py synthetic 2-bar loops at 108 BPM; loops start on bar 1 beat 1';
      L.setRating('tight', 9.1, 'reference take: every hit on the signature', ['keep']); L.setRating('feel', 8.4, 'snare and hats sit late but consistently — that is the pocket, not an error', ['feel', 'keep']);
      L.setRating('mistakes', 4.0, 'late snare on 2, flam on 3, missing kick bar 2, weak snare bar 2', ['reject']); L.setRating('pushed', 7.0, 'downbeat kick caught by the cut: move the loop end 12 ms earlier', ['fix-cut']);
      const m = L.loop('mistakes'); const late = m.hits.find(h => h.mistakeType === 'late'); L.setHitOverride('mistakes', late.id, 'mistake', 'confirmed by ear');
      // one arrangement in the example (v2)
      const arr = L.arrangements.length ? L.arrangements[0] : lab.seq.create('backbone'); lab.currentArrId = arr.id; arr.blocks = []; for (const [id, rep] of [['tight', 2], ['feel', 2], ['pushed', 1], ['tight', 1]]) lab.seq.addBlock(arr.id, id, null, { repeats: rep }); lab.seq.addMarker(arr.id, 1, 'intro'); lab.seq.addMarker(arr.id, 5, 'laid back'); lab.seq.setNotes(arr.id, 'Example arrangement: two steady bars, two lazy, the pushed take (a red seam), then back.'); arr.seams = Sequence.seams(arr, L);
      const doc = L.buildDocument();
      const t = L.loop('tight'); const hits = t.hits.map(h => ({ drum: h.drum, bar: h.bar, pos: h.pos, tSeconds: h.tSeconds, devMs: h.devMs, residualMs: h.residualMs, levelDb: h.levelDb, class: h.class }));
      const side = { schemaVersion: 1, source: 'imported sidecar', createdAt: '2026-09-13T12:00:00Z', bpm: 108, signature: L.session.signature, loops: [
        { id: 'tight', fileNameHint: 'tight.wav', score: 9.8, tight: 10.0, loop: 9.8, notes: 'Stem-accurate: every hit within 2 ms of the signature; join clean.', hits, missing: [] },
        { id: 'feel', fileNameHint: 'feel.wav', score: 8.9, tight: 8.0, loop: 9.8, notes: 'Snares +18 ms and hats +12 ms behind the click throughout — laid back, consistent, no mistakes.', hits: [], missing: [] },
        { id: 'mistakes', fileNameHint: 'mistakes.wav', score: 4.5, tight: 4.0, loop: 5.0, notes: 'Late snare on beat 2 (+45 ms), a kick flam on 3, a missing kick in bar 2 and a 9 dB weak snare.', hits: [{ drum: 'snare', bar: 1, pos: 4, tSeconds: 0.601, devMs: 45.4, residualMs: 46, levelDb: -16.6, class: 'mistake' }], missing: [{ drum: 'kick', bar: 2, pos: 8 }] },
        { id: 'pushed', fileNameHint: 'pushed.wav', score: 7.2, tight: 9.5, loop: 5.0, notes: 'Pushed downbeat kick sits 10 ms before the loop end; the cut needs to move.', hits: [], missing: [] } ] };
      return { doc: JSON.stringify(doc, null, 2), side: JSON.stringify(side, null, 2) };
    });
    fs.writeFileSync(path.join(ROOT, 'examples', 'example.loops.json'), ex.doc + '\n'); fs.writeFileSync(path.join(ROOT, 'examples', 'example.imported-loops.json'), ex.side + '\n');
    // both must import cleanly
    await page.setInputFiles('#lbJson', path.join(ROOT, 'examples', 'example.loops.json')); await page.waitForFunction(() => window.app.loopLab.lib.session.name === 'Fixture loops');
    await page.setInputFiles('#lbSidecar', path.join(ROOT, 'examples', 'example.imported-loops.json')); await page.waitForFunction(() => window.app.loopLab.lib.layers.length === 1);
    const ok = await lab(() => ({ loops: window.app.loopLab.lib.loops.length, matched: Object.keys(window.app.loopLab.lib.layers[0].loops).length, rating: window.app.loopLab.lib.loop('tight').rating }));
    assert(ok.loops === 4 && ok.matched === 4 && ok.rating === 9.1, 'examples import cleanly: ' + JSON.stringify(ok));
    await loadFixtures(); await lab(() => { window.app.loopLab.select('feel'); window.app.loopLab.showTab('layers'); }); await page.waitForTimeout(300); await shot('LX_example_session');
  });

  await test('L10. dist/index.html from file://: Loop Lab loads fixtures and analyses', async () => {
    const p2 = await context.newPage(); const errs = []; p2.on('pageerror', (e) => errs.push(String(e)));
    await p2.goto('file://' + path.join(ROOT, 'dist', 'index.html')); await p2.waitForFunction(() => !!window.app && !!window.app.loopLab);
    await p2.click('#btnModeLoops'); await p2.setInputFiles('#lbFiles', [fx('tight'), fx('feel'), fx('mistakes')]);
    await p2.waitForFunction(() => window.app.loopLab.lib.loops.length === 3 && window.app.loopLab.lib.loops.every(l => l._analysed) && !window.app.loopLab.progress.total, null, { timeout: 60000 });
    const r = await p2.evaluate(() => ({ proto: location.protocol, m: window.app.loopLab.lib.loop('mistakes').machine.mistakes, folder: typeof window.showDirectoryPicker }));
    assert(r.proto === 'file:' && r.m.late === 1 && r.m.flam === 1, 'analysis works from file://'); assert(errs.length === 0, 'no errors: ' + errs.join(' | '));
    await p2.screenshot({ path: path.join(SHOTS, 'L10_dist_file.png') }); await p2.close();
  });

  if (pageErrors.length) log('  page errors:\n    ' + pageErrors.join('\n    '));
  await browser.close(); server.close();
  const failed = results.filter(r => !r.ok); log(`\n${results.length - failed.length}/${results.length} passed`); if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });

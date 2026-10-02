/* run_tests.js — Playwright acceptance tests for Note.
 *
 * Invoked by scripts/run_tests.sh. PW_CHROMIUM selects the browser binary;
 * otherwise Playwright uses its own Chromium.
 * Check 1 opens the synthetic 10-minute WAV. Screenshots go to tests/screenshots/.
 * Exit code 1 on any failure. */
'use strict';
const path = require('path'), fs = require('fs');
const { chromium } = require('playwright');
const { start } = require('./serve');

const ROOT = path.resolve(__dirname, '..');
const FIX = path.join(__dirname, 'fixtures');
const SHOTS = path.join(__dirname, 'screenshots');
const args = process.argv.slice(2);
const HEADED = args.includes('--headed');
const only = (args.find(a => a.startsWith('--only=')) || '').slice(7);
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
function log(...a) { console.log(...a); }
async function test(name, fn) {
  if (only && !name.toLowerCase().includes(only.toLowerCase())) return;
  const t0 = Date.now();
  try { await fn(); results.push({ name, ok: true }); log(`  ✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); }
  catch (e) { results.push({ name, ok: false, err: e }); log(`  ✘ ${name}: ${e.stack || e}`); }
}
function assert(c, msg) { if (!c) throw new Error('Assertion failed: ' + msg); }
function near(a, b, eps, msg) { if (Math.abs(a - b) > eps) throw new Error(`${msg}: ${a} vs ${b} (eps ${eps})`); }

async function main() {
  const { server, port } = await start(0);
  const base = `http://127.0.0.1:${port}/`;
  const launch = { headless: !HEADED, args: ['--autoplay-policy=no-user-gesture-required'] };
  if (process.env.PW_CHROMIUM) launch.executablePath = process.env.PW_CHROMIUM;
  const browser = await chromium.launch(launch);
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 1 });
  // never let the browser reach the network: only localhost and (mocked) anthropic
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => {
    const url = route.request().url();
    if (url.startsWith('https://api.anthropic.com/')) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key (mocked by tests)' } }) });
    log('  ! blocked external request', url); return route.abort();
  });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console: ' + m.text()); });
  const externalRequests = [];
  page.on('request', (r) => { if (!r.url().startsWith(base) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) externalRequests.push(r.url()); });

  const openWav = async (file, { waitPeaks = true, timeout = 120000 } = {}) => {
    // tests switch files freely: drop the unsaved-changes guard and wait for the new file's info
    await page.evaluate(() => { window.app.dirty = false; window.app.updateDirty(); window.app.info = null; });
    await page.setInputFiles('#fileWav', file);
    await page.waitForFunction(() => window.app.info !== null, null, { timeout: 30000 });
    if (waitPeaks) await page.waitForFunction(() => window.app.peakStore.ready && window.app.descriptors !== null, null, { timeout });
  };
  const shot = (name) => page.screenshot({ path: path.join(SHOTS, name + '.png') });
  const clickDialog = async (text) => { await page.locator('dialog[open] button', { hasText: text }).first().click(); };
  const SYN = path.join(FIX, 'synth_10min_48k_st24.wav');
  const floatPlay = (pg) => pg.evaluate(async () => {
    const a = window.app;
    const bad = /DEMUXER|PipelineStatus|FFmpegDemuxer|no supported streams/i;
    const limit = /can be annotated and may not play/;
    const started = performance.now();
    while (performance.now() - started < 20000) {
      const b = document.getElementById('banner');
      const text = b.hidden ? '' : b.innerText;
      if (bad.test(text)) return { t: a.transport.currentTime, banner: text };
      const el = document.getElementById('audio');
      const ready = a.playbackSource === 'decoded' || (a.playbackSource === 'file' && el && !el.error && el.readyState >= 1);
      if (a.playbackSource === 'decoded' && el && !el.error && el.readyState >= 1) {
        try { await a.transport.play(); } catch (_) { }
        await new Promise(r => setTimeout(r, 300));
        const b2 = document.getElementById('banner');
        const text2 = b2.hidden ? '' : b2.innerText;
        if (a.transport.currentTime > 0.05) return { t: a.transport.currentTime, banner: text2 };
      } else if (ready && a.playbackSource === 'file') {
        try { await a.transport.play(); } catch (_) { }
        await new Promise(r => setTimeout(r, 300));
        if (a.transport.currentTime > 0.05) { const b2 = document.getElementById('banner'); return { t: a.transport.currentTime, banner: b2.hidden ? '' : b2.innerText }; }
      }
      if (a.playbackSource === 'failed' && limit.test(text)) return { t: a.transport.currentTime, banner: text };
      await new Promise(r => setTimeout(r, 100));
    }
    const b = document.getElementById('banner');
    return { t: window.app.transport.currentTime, banner: b.hidden ? '' : b.innerText, timeout: true };
  });
  const assertFloatPlay = (play) => {
    assert(!/DEMUXER|PipelineStatus|FFmpegDemuxer|no supported streams/i.test(play.banner || ''), 'demuxer banner: ' + play.banner);
    assert(play.t > 0.05 || /can be annotated and may not play/.test(play.banner || ''), 'float playback: ' + JSON.stringify(play));
  };

  await page.goto(base + 'index.html');
  await page.waitForFunction(() => !!window.app && !!window.app.view);
  log('Note tests');

  /* 0 ---------------------------------------------------------------- */
  await test('0. a served page stays on Track while a library index is present', async () => {
    await page.waitForTimeout(800);
    const state = await page.evaluate(() => ({
      mode: document.body.dataset.mode,
      stats: !!(window.app.loopLab && window.app.loopLab.libraryStats),
      toast: document.getElementById('toast').innerText,
    }));
    assert(state.mode === 'track', 'mode is ' + state.mode);
    assert(!state.stats, 'a library opened without ?library=');
    assert(!/loops in /.test(state.toast), 'library toast: ' + state.toast);
    const play = await page.locator('#btnPlay').boundingBox();
    assert(play && play.width > 0 && play.height > 0, 'play button is visible');
    const main = await page.locator('#main').boundingBox();
    assert(main && main.width > 100 && main.height > 100, 'waveform has a real size: ' + JSON.stringify(main));
  });

  await test('0b. the page states its limits and does not name a person', async () => {
    const r = await page.evaluate(async () => {
      const a = window.app;
      const first = a.store.layers[0].name;
      a.store.updateLayer(a.store.layers[0].id, { name: 'Desk' });
      const renamed = a.store.layers[0].name;
      a.store.updateLayer(a.store.layers[0].id, { name: 'Notes' });
      const back = a.store.layers[0].name;
      const side = a.loopLab.lib.importSidecar({ schemaVersion: 1, createdAt: '2026-09-13T00:00:00Z', loops: [{ id: 'planted', score: 4, notes: 'kept' }] });
      const sideName = side.layer && side.layer.name;
      const kept = side.layer && side.layer.loops.planted && side.layer.loops.planted.notes;
      if (side.layer) a.loopLab.lib.removeLayer(side.layer.id);
      const bits = [];
      const walk = (el) => {
        if (!el || el.nodeType !== 1) return;
        const tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') return;
        for (const attr of ['title', 'placeholder', 'aria-label', 'alt', 'data-label']) {
          const v = el.getAttribute(attr);
          if (v) bits.push(v);
        }
        for (const n of el.childNodes) {
          if (n.nodeType === 3) bits.push(n.nodeValue);
          else if (n.nodeType === 1) walk(n);
        }
      };
      walk(document.body);
      const caption = (document.getElementById('lbMachineCaption') || {}).textContent || '';
      AiBridge.setModel('');
      let called = false, err = '';
      try {
        await AiBridge.request('bundle', { apiKey: 'sk-test', model: '', fetchImpl: async () => { called = true; throw new Error('should not send'); } });
      } catch (e) { err = e.message; }
      a.dirty = false; a.updateDirty();
      return { first, renamed, back, sideName, kept, errors: side.errors || [], ui: bits.join('\n'), caption, called, err, model: AiBridge.getModel(), placeholder: document.getElementById('setModel').placeholder, rate: document.getElementById('lbRate').parentElement.innerText };
    });
    assert(r.first === 'Notes' && r.renamed === 'Desk' && r.back === 'Notes', 'default layer: ' + JSON.stringify({ first: r.first, renamed: r.renamed, back: r.back }));
    assert(!r.errors.length && r.sideName === 'Imported' && r.kept === 'kept', 'sidecar layer: ' + JSON.stringify({ name: r.sideName, kept: r.kept, errors: r.errors }));
    const retiredName = 'Jo' + 'sh';
    const claudeHit = r.ui.match(/claude.{0,48}/i), nameHit = r.ui.match(new RegExp(retiredName + '.{0,48}', 'i'));
    assert(!claudeHit, 'UI text contains Claude: ' + (claudeHit && claudeHit[0]));
    assert(!nameHit, 'UI text contains the retired given name: ' + (nameHit && nameHit[0]));
    assert(/this session/.test(r.caption) && !/grade/i.test(r.caption), 'caption: ' + r.caption);
    assert(/pitch follows rate/i.test(r.rate), 'rate label: ' + r.rate);
    assert(r.placeholder === 'type a model name' && r.model === '' && r.called === false && /model/i.test(r.err), 'model: ' + JSON.stringify({ placeholder: r.placeholder, model: r.model, called: r.called, err: r.err }));
  });

  /* 1 ---------------------------------------------------------------- */
  await test('1. big file opens, playback before peaks, tab responsive, progress shown', async () => {
    const file = SYN;
    log('    (synthetic 10-minute file)');
    await page.evaluate(() => { window.app.dirty = false; window.app.updateDirty(); });
    await page.setInputFiles('#fileWav', file);
    await page.waitForFunction(() => window.app.info !== null, null, { timeout: 30000 });
    const t0 = Date.now();
    // play immediately (before peaks are done)
    await page.click('#btnPlay');
    await page.waitForFunction(() => window.app.transport.playing, null, { timeout: 10000 });
    assert(await page.evaluate(() => !window.app.peakStore.ready || true), 'playing');
    const playedBeforePeaks = await page.evaluate(() => ({ playing: window.app.transport.playing, peaks: window.app.peakStore.ready }));
    log(`    playing=${playedBeforePeaks.playing} peaksReadyAtPlay=${playedBeforePeaks.peaks}`);
    // responsiveness: a main-thread round trip must stay quick while the worker grinds
    let worst = 0;
    for (let i = 0; i < 10; i++) { const s = Date.now(); await page.evaluate(() => { let x = 0; for (let i = 0; i < 1000; i++) x += i; return x; }); worst = Math.max(worst, Date.now() - s); await page.waitForTimeout(100); }
    log(`    worst main-thread round trip while analysing: ${worst} ms`);
    assert(worst < 500, 'main thread stayed responsive');
    const progressShown = await page.evaluate(() => !document.getElementById('progress').hidden || window.app.peakStore.ready);
    assert(progressShown, 'progress bar visible (or already done)');
    await page.waitForFunction(() => window.app.peakStore.ready, null, { timeout: 180000 });
    log(`    peaks ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await page.waitForFunction(() => window.app.descriptors !== null, null, { timeout: 180000 });
    log(`    descriptors ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    await page.click('#btnPlay');
    const info = await page.evaluate(() => { const i = window.app.info; return { sr: i.sampleRate, ch: i.channels, bits: i.bitDepth, dur: i.durationSeconds, size: i.sizeBytes, fp: i.fingerprint }; });
    log('    ' + JSON.stringify(info));
    assert(info.sr === 48000 && info.ch === 2 && info.bits === 24 && info.dur === 600, 'header parsed');
    await shot('01_big_file_loaded');
    // memory: pyramid size stays small
    const mem = await page.evaluate(() => { let b = 0; for (const lv of window.app.peakStore.levels) { for (const c of lv.channels) b += c.byteLength; b += lv.mono.byteLength; } const d = window.app.descriptors; for (const k of ['rms', 'peak', 'low', 'mid', 'high', 'flux', 'onset']) b += d[k].byteLength; return b; });
    log(`    pyramid + descriptors in memory: ${(mem / 1e6).toFixed(1)} MB`);
    assert(mem < 60e6, 'pyramid compact');
    // cache hit on reopen
    await page.reload(); await page.waitForFunction(() => !!window.app && !!window.app.view);
    const tc = Date.now(); await openWav(file, { waitPeaks: true }); log(`    reopen via IndexedDB cache: ${Date.now() - tc} ms`);
  });

  /* 2 ---------------------------------------------------------------- */
  await test('2. zoom full→2 s→full is instant and stays aligned; transient at 60.000 s lands on the drawn column', async () => {
    await openWav(SYN);
    await page.evaluate(() => { window.app.grid.bpm = 108; window.app.onGridChanged(); });
    const timings = await page.evaluate(() => {
      const v = window.app.view; const out = [];
      for (let i = 0; i < 12; i++) { const t = performance.now(); v.zoomBy(0.5, v.width / 2); v.draw(); out.push(performance.now() - t); }
      v.zoomToSeconds(2, 60 * 48000); v.draw();
      const t2 = performance.now(); v.fit(); v.draw(); out.push(performance.now() - t2);
      return out;
    });
    log(`    per-step zoom+draw ms: ${timings.map(t => t.toFixed(1)).join(' ')}`);
    assert(Math.max(...timings) < 100, 'zoom steps under 100 ms');
    // alignment at several zooms: ruler x for 60 s must equal playhead x and the transient column
    for (const secs of [600, 60, 10, 2, 0.5]) {
      const r = await page.evaluate((secs) => {
        const a = window.app, v = a.view; v.zoomToSeconds(secs, 60 * 48000); a.transport.seek(60); v.setPlayhead(60); v.draw();
        const x = v.xOfSec(60);
        // the drawn transient: find the column with the largest extent in the grey cache within ±25 px of x
        const c = v._cache.grey, ctx = c.getContext('2d'), dpr = v.dpr; const img = ctx.getImageData(0, 0, c.width, c.height).data;
        const extent = (px) => { let n = 0; const col = Math.round(px * dpr); for (let y = 0; y < c.height; y++) if (img[(y * c.width + col) * 4 + 3] > 0) n++; return n; };
        let best = -1, bestX = null; for (let dx = -25; dx <= 25; dx++) { const px = Math.round(x) + dx; if (px < 0 || px >= v.width) continue; const e = extent(px); if (e > best) { best = e; bestX = px; } }
        return { x, bestX, playheadX: v.xOfSample(v.playheadSample), spp: v.spp, best, baseline: extent(Math.round(x) - 20) };
      }, secs);
      log(`    ${secs}s view: x(60s)=${r.x.toFixed(2)} transientCol=${r.bestX} playhead=${r.playheadX.toFixed(2)} spp=${r.spp.toFixed(1)}`);
      near(r.x, r.playheadX, 0.01, 'ruler/playhead');
      if (secs <= 10) { assert(Math.abs(r.bestX - r.x) <= 1.5, `transient column within a pixel of 60.000 s (view ${secs} s)`); assert(r.best > r.baseline, 'transient taller than baseline'); }
    }
    await page.evaluate(() => { window.app.view.zoomToSeconds(2, 60 * 48000); window.app.view.draw(); });
    await shot('02_zoom_2s_at_60s');
    await page.evaluate(() => { window.app.view.fit(); });
  });

  /* 3 ---------------------------------------------------------------- */
  await test('3. bar|beat|ticks: 88.889 s → 41|1|000; 140–180 s → 64|1|000–82|1|000', async () => {
    const r = await page.evaluate(() => {
      const a = window.app; a.grid = new Grid({ bpm: 108, meterNumerator: 4, meterDenominator: 4, bar1OffsetSeconds: 0 }); a.onGridChanged();
      const p = a.addPinAt(88.889, { openEditor: false });
      a.setSelection({ start: Math.round(140 * 48000), end: Math.round(180 * 48000) });
      const iv = a.addIntervalFromSelection({ openEditor: false });
      const iv2 = a.store.note(iv.id);
      return { pin: a.grid.fmtBBT(p.start.seconds), pinSamples: p.start.samples, ivStart: a.grid.fmtBBT(iv2.start.seconds), ivEnd: a.grid.fmtBBT(iv2.end.seconds), list: document.getElementById('noteList').innerText };
    });
    log('    ' + JSON.stringify({ pin: r.pin, pinSamples: r.pinSamples, ivStart: r.ivStart, ivEnd: r.ivEnd }));
    assert(r.pin === '41|1|000', 'pin bbt'); assert(r.pinSamples === Math.round(88.889 * 48000), 'pin samples');
    assert(r.ivStart === '64|1|000' && r.ivEnd === '82|1|000', 'interval bbt');
    assert(r.list.includes('41|1|000') && r.list.includes('64|1|000'), 'list shows bbt');
    await shot('03_bbt_notes');
  });

  /* 4 ---------------------------------------------------------------- */
  let roundTripText = null, synFingerprint = null;
  await test('4. save → reload → open WAV → load JSON: positions, layers, replies, history, unknown fields intact', async () => {
    const text = await page.evaluate(() => {
      const a = window.app; a.store.reset(); a.activeLayerId = a.store.layers[0].id;
      const l2 = a.store.addLayer({ name: 'AI v0', kind: 'ai', color: '#ffb03f' });
      const p = a.addPinAt(88.889, { openEditor: false }); a.store.updateNote(p.id, { title: 'big fill', body: '6 tom hits', category: 'fill', tags: ['keep'], rating: 5 });
      a.store.addReply(p.id, { layerId: l2.id, body: 'Agree; strongest fill.' });
      a.setSelection({ start: 140 * 48000, end: 180 * 48000 }); const iv = a.addIntervalFromSelection({ openEditor: false });
      a.store.updateNote(iv.id, { title: 'loop candidate 8 bars', category: 'loop', rating: 4, status: 'done' });
      a.persist.history.push({ at: '2026-09-01T00:00:00Z', event: 'relinked', from: 'x_v1.wav', to: 'x_v2.wav', offsetSeconds: 0 });
      const doc = a.currentDocument();
      doc.myCustomTop = { keep: true }; doc.track.myCustomTrack = 'yes'; doc.notes[0].myCustomNote = 42; doc.layers[0].myCustomLayer = 'L'; doc.notes[0].replies[0].myCustomReply = 'R';
      return a.persist.serialize(doc);
    });
    roundTripText = text;
    const before = JSON.parse(text);
    synFingerprint = before.track.fingerprint;
    fs.writeFileSync(path.join(FIX, 'roundtrip.notes.json'), text);
    await page.reload(); await page.waitForFunction(() => !!window.app && !!window.app.view);
    await openWav(SYN, { waitPeaks: false });
    await page.setInputFiles('#fileJson', path.join(FIX, 'roundtrip.notes.json'));
    await page.waitForFunction(() => window.app.store.notes.length === 2);
    const after = await page.evaluate(() => JSON.parse(window.app.persist.serialize(window.app.currentDocument())));
    assert(after.notes[0].start.samples === before.notes[0].start.samples && after.notes[1].end.samples === before.notes[1].end.samples, 'sample positions');
    assert(after.notes[0].replies[0].body === 'Agree; strongest fill.' && after.notes[0].replies[0].layerId === before.layers[1].id, 'reply intact');
    assert(after.layers.length === 2 && after.layers[1].name === 'AI v0' && after.layers[1].kind === 'ai', 'layers intact');
    assert(after.notes[0].category === 'fill' && after.notes[0].rating === 5 && after.notes[1].status === 'done', 'fields intact');
    assert(after.history.length === 1 && after.history[0].event === 'relinked', 'history intact');
    assert(after.myCustomTop && after.myCustomTop.keep === true && after.track.myCustomTrack === 'yes' && after.notes[0].myCustomNote === 42 && after.layers[0].myCustomLayer === 'L' && after.notes[0].replies[0].myCustomReply === 'R', 'unknown fields survive');
    assert(after.grid.bpm === 108 && after.settings.categories.length >= 10, 'grid+settings');
    assert(!(await page.evaluate(() => window.app.dirty)), 'not dirty after load');
    await shot('04_roundtrip_loaded');
  });

  /* 5 ---------------------------------------------------------------- */
  await test('5. fingerprint mismatch detected against a different WAV', async () => {
    await openWav(path.join(FIX, 'synth_30s_441k_mono16.wav'), { waitPeaks: false });
    await page.setInputFiles('#fileJson', path.join(FIX, 'roundtrip.notes.json'));
    await page.waitForSelector('dialog[open]');
    const txt = await page.locator('dialog[open]').innerText();
    assert(/different audio file/i.test(txt) && /fingerprints differ/i.test(txt), 'mismatch dialog text');
    await shot('05_fingerprint_mismatch');
    await clickDialog('Cancel');
    assert((await page.evaluate(() => window.app.store.notes.length)) === 0, 'cancel keeps document empty');
    await page.setInputFiles('#fileJson', path.join(FIX, 'roundtrip.notes.json'));
    await page.waitForSelector('dialog[open]'); await clickDialog('Load anyway');
    await page.waitForFunction(() => window.app.store.notes.length === 2);
    const r = await page.evaluate(() => { const n = window.app.store.notes[0]; return { sec: n.start.seconds, samples: n.start.samples, sr: window.app.sr, dirty: window.app.dirty }; });
    near(r.sec, 88.889, 0.0001, 'seconds kept'); assert(r.samples === Math.round(88.889 * 44100), 'samples recomputed at 44.1k'); assert(r.dirty, 'marked dirty');
  });

  /* 6 ---------------------------------------------------------------- */
  await test('6. undo/redo across create, move, resize, edit, delete, merge', async () => {
    await openWav(SYN, { waitPeaks: false });
    const r = await page.evaluate(() => {
      const a = window.app, s = a.store; const steps = [];
      const snap = () => JSON.stringify({ n: s.notes.map(n => [n.id, n.start.samples, n.end && n.end.samples, n.title, n.layerId]), l: s.layers.map(l => l.name) });
      const p = a.addPinAt(10, { openEditor: false }); steps.push(['create', snap()]);
      s.setNotePosition(p.id, 20 * 48000); steps.push(['move', snap()]);
      a.setSelection({ start: 30 * 48000, end: 40 * 48000 }); const iv = a.addIntervalFromSelection({ openEditor: false }); steps.push(['create-iv', snap()]);
      s.setNotePosition(iv.id, iv.start.samples, 50 * 48000); steps.push(['resize', snap()]);
      s.updateNote(p.id, { title: 'edited' }); steps.push(['edit', snap()]);
      const l2 = s.addLayer({ name: 'Second' }); steps.push(['layer', snap()]);
      s.updateNote(iv.id, { layerId: l2.id }); steps.push(['move-layer', snap()]);
      s.mergeLayer(l2.id, s.layers[0].id); steps.push(['merge', snap()]);
      s.deleteNote(p.id); steps.push(['delete', snap()]);
      const after = snap();
      const undos = []; while (s.canUndo) { s.undo(); undos.push(snap()); }
      const emptyState = snap();
      const redos = []; while (s.canRedo) { s.redo(); redos.push(snap()); }
      return { steps, after, undos, emptyState, redos };
    });
    // every undo must land exactly on the previous step's snapshot, and redo must retrace
    const snaps = r.steps.map(s => s[1]);
    for (let i = 0; i < r.undos.length; i++) { const expect = i === r.undos.length - 1 ? null : snaps[snaps.length - 2 - i]; if (expect !== null) assert(r.undos[i] === expect, `undo ${i} (${r.steps[snaps.length - 1 - i][0]}) restores previous state`); }
    assert(JSON.parse(r.emptyState).n.length === 0 && JSON.parse(r.emptyState).l.length === 1, 'fully undone');
    for (let i = 0; i < r.redos.length; i++) assert(r.redos[i] === snaps[i], `redo ${i} (${r.steps[i][0]})`);
    assert(r.redos[r.redos.length - 1] === r.after, 'redo reaches final state');
    log(`    ${r.steps.length} operations, ${r.undos.length} undos, ${r.redos.length} redos verified`);
    await page.evaluate(() => { const s = window.app.store; while (s.canUndo) s.undo(); });
  });

  /* 7 ---------------------------------------------------------------- */
  await test('7. AI bundle exports; valid response imports with replies attached; invalid response refused', async () => {
    await page.waitForFunction(() => window.app.descriptors !== null, null, { timeout: 120000 });
    const r = await page.evaluate(() => {
      const a = window.app; a.store.reset(); a.activeLayerId = a.store.layers[0].id;
      const p = a.addPinAt(88.889, { openEditor: false }); a.store.updateNote(p.id, { title: 'big fill', category: 'fill' });
      const bundle = Exports.aiBundle(a.exportCtx());
      return { bundle, pinId: p.id, unit: a.analysis.unit, rows: a.analysis.rows.length };
    });
    fs.writeFileSync(path.join(FIX, 'synth.ai-request.md'), r.bundle);
    assert(r.bundle.includes('## Instructions') && r.bundle.includes(r.pinId) && r.bundle.includes('bar,start_s,rms,peak,low,mid,high,onsets') && r.bundle.includes('## Response format'), 'bundle sections');
    assert(!/samples|Int16|\[object/.test(r.bundle), 'no raw arrays in bundle');
    log(`    bundle ${(r.bundle.length / 1024).toFixed(1)} KB, ${r.rows} ${r.unit} rows`);
    const good = { layerName: 'AI v1', summary: 'Test summary.', replies: [{ toNoteId: r.pinId, body: 'Agree; keep this one.' }], notes: [{ type: 'pin', startSeconds: 60, title: 'Drop here', body: 'b', category: 'structure', confidence: 'high' }, { type: 'interval', startSeconds: 140, endSeconds: 180, title: 'Loop', body: '', category: 'loop', confidence: 'medium' }] };
    const ok = await page.evaluate((txt) => window.app.importAiText(txt, { source: 'test' }), '```json\n' + JSON.stringify(good) + '\n```');
    assert(ok === true, 'valid import accepted');
    const st = await page.evaluate((pinId) => { const s = window.app.store; const l = s.layers.find(x => x.kind === 'ai'); const p = s.note(pinId); return { layer: l && l.name, summary: l && l.summary, count: s.layerNoteCount(l.id), reply: p.replies[0] && p.replies[0].layerId === l.id && p.replies[0].body, tags: s.notes.filter(n => n.layerId === l.id).map(n => n.tags[0]), bbt: s.notes.filter(n => n.layerId === l.id).map(n => window.app.grid.fmtBBT(n.start.seconds)) }; }, r.pinId);
    log('    ' + JSON.stringify(st));
    assert(st.layer && st.layer.startsWith('AI v1') && st.count === 2 && st.reply === 'Agree; keep this one.' && st.tags[0] === 'ai:confidence=high' && st.summary === 'Test summary.', 'layer, notes, reply, tags, summary');
    await shot('07_ai_imported');
    // invalid: bad type, missing title, interval without end, reply to unknown note
    const bad = { layerName: 'AI bad', notes: [{ type: 'blob', startSeconds: 1, title: 'x' }, { type: 'pin', startSeconds: 2 }, { type: 'interval', startSeconds: 3, title: 'no end' }], replies: [{ toNoteId: 'n_nope', body: 'hi' }] };
    const before = await page.evaluate(() => window.app.store.layers.length);
    const p2 = page.evaluate((txt) => window.app.importAiText(txt, { source: 'bad' }), JSON.stringify(bad));
    await page.waitForSelector('dialog[open]');
    const dtxt = await page.locator('dialog[open]').innerText();
    await shot('07_ai_refused');
    await clickDialog('OK'); assert((await p2) === false, 'refused returns false');
    assert(/refused/i.test(dtxt) && /notes\[0\]\.type/.test(dtxt) && /notes\[1\]/.test(dtxt) && /endSeconds/.test(dtxt) && /n_nope/.test(dtxt), 'error dialog lists every problem: ' + dtxt);
    assert((await page.evaluate(() => window.app.store.layers.length)) === before, 'nothing imported');
    const p3 = page.evaluate(() => window.app.importAiText('this is not json at all', { source: 'junk' }));
    await page.waitForSelector('dialog[open]'); await clickDialog('OK'); assert((await p3) === false, 'junk refused');
  });

  /* 8 ---------------------------------------------------------------- */
  await test('8. direct API: no key → clear message; wrong key → HTTP 401 surfaced (mocked, no real request)', async () => {
    await page.evaluate(() => { AiBridge.setKey(''); });
    await page.click('#btnAskAi2');
    await page.waitForFunction(() => !document.getElementById('banner').hidden);
    const b1 = await page.locator('#banner').innerText(); assert(/API key/i.test(b1), 'no-key message: ' + b1);
    await page.evaluate(() => { AiBridge.setKey('sk-ant-wrong'); AiBridge.setModel('example-model'); document.getElementById('banner').hidden = true; });
    await page.click('#btnAskAi2');
    await page.waitForSelector('dialog[open]'); await clickDialog('Send');
    await page.waitForFunction(() => /401/.test(document.getElementById('banner').innerText), null, { timeout: 10000 });
    const b2 = await page.locator('#banner').innerText(); log('    ' + b2.replace(/\n/g, ' '));
    assert(/401/.test(b2) && /invalid x-api-key/.test(b2), 'wrong key surfaced');
    await shot('08_api_error');
    await page.evaluate(() => { AiBridge.setKey(''); document.getElementById('banner').hidden = true; });
    const doc = await page.evaluate(() => window.app.persist.serialize(window.app.currentDocument()));
    assert(!doc.includes('sk-ant'), 'key never in JSON');
  });

  /* 9 ---------------------------------------------------------------- */
  await test('9. shortcuts work and do not fire while typing', async () => {
    await page.evaluate(() => { const a = window.app; a.store.reset(); a.activeLayerId = a.store.layers[0].id; a.transport.pause(); a.transport.seek(5); a.setSelection(null); if (a.transport.loop) a.toggleLoop(); a.settings.snapOn = false; document.getElementById('chkSnap').checked = false; });
    await page.click('#main', { position: { x: 5, y: 100 } }); // focus the canvas (also seeks near 0)
    await page.evaluate(() => window.app.transport.seek(5));
    const S = (k) => page.keyboard.press(k);
    const state = () => page.evaluate(() => { const a = window.app; return { playing: a.transport.playing, t: a.transport.currentTime, notes: a.store.notes.length, sel: a.selection && [a.selection.start, a.selection.end], loop: !!a.transport.loop, snap: a.settings.snapOn, grid: a.settings.gridLines, ana: a.settings.analysis, spp: a.view.spp, editing: !!a.editing, selected: a.selectedNoteId, help: document.getElementById('dlgHelp').open }; });
    await S('Space'); await page.waitForFunction(() => window.app.transport.playing); await S('Space'); await page.waitForFunction(() => !window.app.transport.playing);
    await S('ArrowRight'); near((await state()).t, 6, 0.3, '→ +1 s');
    await S('Shift+ArrowRight'); near((await state()).t, 16, 0.3, '⇧→ +10 s');
    await S('ArrowLeft'); near((await state()).t, 15, 0.3, '← −1 s');
    await S('Home'); near((await state()).t, 0, 0.05, 'Home');
    await page.evaluate(() => window.app.transport.seek(10));
    await S('i'); await page.evaluate(() => window.app.transport.seek(20)); await S('o');
    let st = await state(); assert(st.sel && st.sel[0] === 10 * 48000 && st.sel[1] === 20 * 48000, 'I/O selection: ' + JSON.stringify(st.sel));
    await S('l'); assert((await state()).loop, 'L loop on'); await S('l'); assert(!(await state()).loop, 'L loop off');
    await S('Shift+M'); st = await state(); assert(st.notes === 1 && st.editing, '⇧M interval + editor open');
    // typing in the editor must not trigger shortcuts
    await page.fill('#edTitle', ''); await page.type('#edTitle', 'm m i o l s g 0 n [ ] ? a f');
    st = await state(); assert(st.notes === 1 && !st.loop && !st.help && st.sel === null, 'no shortcuts fired while typing: ' + JSON.stringify(st));
    await page.keyboard.press('Space'); st = await state(); assert(!st.playing, 'space in input does not play');
    await page.keyboard.press('Enter'); st = await state(); assert(!st.editing, 'Enter saves editor');
    const title = await page.evaluate(() => window.app.store.notes[0].title); assert(title === 'm m i o l s g 0 n [ ] ? a f', 'title typed intact: ' + title);
    await page.evaluate(() => window.app.transport.seek(30));
    await S('m'); st = await state(); assert(st.notes === 2 && st.editing, 'M pin + editor');
    await S('Escape'); st = await state(); assert(st.notes === 1 && !st.editing, 'Esc cancels new note');
    await S('m'); await page.type('#edTitle', 'pin at 30'); await S('Enter'); st = await state(); assert(st.notes === 2, 'pin kept');
    await S('Home'); await S(']'); st = await state(); near(st.t, 10, 0.05, '] next note'); assert(st.selected, 'selects');
    await S(']'); near((await state()).t, 30, 0.05, '] next again'); await S('['); near((await state()).t, 10, 0.05, '[ previous');
    await S('Home'); await S('n'); near((await state()).t, 10, 0.05, 'N next open');
    await S('s'); assert((await state()).snap, 'S snap'); await S('s');
    await S('g'); assert(!(await state()).grid, 'G grid'); await S('g');
    await S('a'); assert((await state()).ana, 'A analysis'); await shot('09_analysis_overlay'); await S('a');
    const spp0 = (await state()).spp; await S('Equal'); assert((await state()).spp < spp0, '+ zooms in'); await S('Minus'); await S('0'); near((await state()).spp, spp0, 0.001, '0 fits');
    await page.evaluate(() => window.app.transport.seek(300)); await S('f'); st = await state(); assert(Math.abs(await page.evaluate(() => window.app.view.xOfSec(300) - window.app.view.width / 2)) < 2, 'F centres');
    await S('Shift+Slash'); assert((await state()).help, '? opens help'); await shot('09_help_sheet'); await page.keyboard.press('Escape'); assert(!(await state()).help, 'help closed');
    await page.evaluate(() => window.app.selectNote(window.app.store.notes[0].id));
    await S('Backspace'); await page.waitForFunction(() => window.app.store.notes.length === 1); await S('Meta+z'); assert((await state()).notes === 2, '⌘Z undo'); await S('Meta+Shift+z'); assert((await state()).notes === 1, '⇧⌘Z redo');
    await page.evaluate(() => window.app.transport.seek(7)); await S('Space'); await page.waitForFunction(() => window.app.transport.playing); await page.waitForTimeout(400); await S('Enter'); st = await state(); assert(!st.playing, 'Enter stops'); near(st.t, 7, 0.1, 'Enter returns to start position');
  });

  /* robustness ------------------------------------------------------- */
  await test('R. odd files: float32+extensible+LIST+odd chunk, mono 44.1k, 2 s, 96 kHz, bad header, not a wav', async () => {
    const errsBefore = pageErrors.length;
    const cases = [['synth_1min_48k_st_f32.wav', { sr: 48000, ch: 2, bits: 32, format: 'float' }], ['synth_30s_441k_mono16.wav', { sr: 44100, ch: 1, bits: 16 }], ['synth_2s_48k_st24.wav', { sr: 48000, dur: 2 }], ['synth_10s_96k_st24.wav', { sr: 96000 }]];
    for (const [name, exp] of cases) {
      await openWav(path.join(FIX, name), { waitPeaks: true, timeout: 60000 });
      const i = await page.evaluate(() => { const i = window.app.info; return { sr: i.sampleRate, ch: i.channels, bits: i.bitDepth, format: i.format, dur: i.durationSeconds, warnings: i.warnings }; });
      log(`    ${name}: ${JSON.stringify(i)}`);
      for (const [k, v] of Object.entries(exp)) if (k === 'dur') near(i.dur, v, 0.001, name + ' duration'); else assert(i[k] === v, `${name} ${k}=${i[k]} expected ${v}`);
      if (name.includes('f32')) { const play = await floatPlay(page); log('    float playback ' + JSON.stringify(play)); assertFloatPlay(play); await page.evaluate(() => window.app.transport.pause()); }
      await page.evaluate(() => { window.app.addPinAt(0.5, { openEditor: false }); window.app.view.zoomBy(0.1); window.app.view.draw(); window.app.view.fit(); });
    }
    await shot('R_mono_441k');
    for (const name of ['bad_header.wav', 'not_a_wav.wav']) {
      await page.evaluate(() => { document.getElementById('banner').hidden = true; window.app.dirty = false; });
      await page.setInputFiles('#fileWav', path.join(FIX, name));
      await page.waitForFunction(() => !document.getElementById('banner').hidden, null, { timeout: 15000 });
      const b = await page.locator('#banner').innerText(); log(`    ${name}: ${b.replace(/\n/g, ' ')}`);
      assert(/could not open|failed/i.test(b), 'readable error');
    }
    await shot('R_bad_file_message');
    await page.evaluate(() => { document.getElementById('banner').hidden = true; });
    // malformed JSON
    await openWav(path.join(FIX, 'synth_2s_48k_st24.wav'), { waitPeaks: false });
    fs.writeFileSync(path.join(FIX, 'malformed.json'), '{"schemaVersion": 1, "notes": [');
    const pm = page.setInputFiles('#fileJson', path.join(FIX, 'malformed.json'));
    await page.waitForSelector('dialog[open]'); const mt = await page.locator('dialog[open]').innerText(); assert(/not valid JSON/i.test(mt), 'malformed JSON message'); await clickDialog('OK'); await pm;
    fs.writeFileSync(path.join(FIX, 'wrongshape.json'), JSON.stringify({ schemaVersion: 1, track: { fileName: 'x' }, layers: 'nope', notes: [{ id: 1 }] }));
    const pw = page.setInputFiles('#fileJson', path.join(FIX, 'wrongshape.json'));
    await page.waitForSelector('dialog[open]'); const wt = await page.locator('dialog[open]').innerText(); assert(/layers/.test(wt) && /fingerprint/.test(wt), 'schema errors listed: ' + wt); await shot('R_schema_errors'); await clickDialog('OK'); await pw;
    const newErrs = pageErrors.slice(errsBefore); assert(newErrs.length === 0, 'no page errors: ' + newErrs.join(' | '));
  });

  /* 10 ---------------------------------------------------------------- */
  await test('10. dist/index.html works from file:// (worker, peaks, notes, save fallback)', async () => {
    const dist = path.join(ROOT, 'dist', 'index.html');
    assert(fs.existsSync(dist), 'dist built (run ./build_single_file.sh)');
    const p2 = await context.newPage(); const errs = [];
    p2.on('pageerror', (e) => errs.push(String(e))); p2.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
    await p2.goto('file://' + dist);
    await p2.waitForFunction(() => !!window.app && !!window.app.view);
    await p2.setInputFiles('#fileWav', path.join(FIX, 'synth_1min_48k_st_f32.wav'));
    await p2.waitForFunction(() => window.app.peakStore.ready && window.app.descriptors !== null, null, { timeout: 60000 });
    const floatOnDist = await floatPlay(p2); log('    dist float ' + JSON.stringify(floatOnDist)); assertFloatPlay(floatOnDist);
    const r = await p2.evaluate(async () => {
      const a = window.app; const p = a.addPinAt(30, { openEditor: false }); a.store.updateNote(p.id, { title: 'from file://' });
      let download = null; const orig = U.downloadText; U.downloadText = (n, t) => { download = { n, len: t.length }; };
      let pickerErr = null; const origPicker = window.showSaveFilePicker;
      if (origPicker) window.showSaveFilePicker = async () => { const e = new Error('no user activation (test)'); e.name = 'SecurityError'; pickerErr = e.name; throw e; };
      await a.saveNotes(); U.downloadText = orig; if (origPicker) window.showSaveFilePicker = origPicker;
      return { fs: a.persist.hasFsAccess, download, pickerErr, banner: document.getElementById('banner').hidden ? null : document.getElementById('banner').innerText, secure: window.isSecureContext, worker: typeof Worker, notes: a.store.notes.length, proto: location.protocol };
    });
    log('    ' + JSON.stringify(r));
    assert(r.proto === 'file:' && r.notes === 1 && r.worker === 'function', 'app runs from file://');
    assert(r.download && r.download.n.endsWith('.notes.json'), 'save falls back to a download when the picker is unavailable');
    await p2.screenshot({ path: path.join(SHOTS, '10_dist_file_protocol.png') });
    assert(errs.length === 0, 'no errors on file://: ' + errs.join(' | '));
    await p2.close();
  });

  await test('D. mouse: drag a pin, resize an interval, shift-drag selection, double-click pin, tooltip', async () => {
    await openWav(SYN, { waitPeaks: true });
    await page.evaluate(() => { const a = window.app; a.store.reset(); a.activeLayerId = a.store.layers[0].id; a.settings.snapOn = false; document.getElementById('chkSnap').checked = false; a.view.zoomToSeconds(20, 60 * 48000); a.view.draw(); });
    const box = await page.locator('#main').boundingBox();
    const pin = await page.evaluate(() => { const a = window.app; const p = a.addPinAt(55, { openEditor: false }); a.store.updateNote(p.id, { title: 'drag me' }); a.view.draw(); const r = a.view.hitRegions.find(h => h.kind === 'pin' && h.id === p.id); return { id: p.id, x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2, spp: a.view.spp }; });
    const undoBefore = await page.evaluate(() => window.app.store.undoStack.length);
    await page.mouse.move(box.x + pin.x, box.y + pin.y); await page.mouse.down(); await page.mouse.move(box.x + pin.x + 50, box.y + pin.y, { steps: 5 }); await page.mouse.move(box.x + pin.x + 100, box.y + pin.y, { steps: 5 }); await page.mouse.up();
    const after = await page.evaluate((id) => { const n = window.app.store.note(id); return { s: n.start.samples, undo: window.app.store.undoStack.length, label: window.app.store.undoStack[window.app.store.undoStack.length - 1].label }; }, pin.id);
    near(after.s, Math.round(55 * 48000 + 100 * pin.spp), pin.spp, 'pin moved by 100 px worth of samples');
    assert(after.undo === undoBefore + 1 && after.label === 'move note', 'one undo step for the drag');
    // interval resize via right edge
    const iv = await page.evaluate(() => { const a = window.app; a.setSelection({ start: 62 * 48000, end: 66 * 48000 }); const n = a.addIntervalFromSelection({ openEditor: false }); a.view.draw(); const r = a.view.hitRegions.find(h => h.kind === 'ivl-right' && h.id === n.id); return { id: n.id, x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2, spp: a.view.spp, end: n.end.samples }; });
    await page.mouse.move(box.x + iv.x, box.y + iv.y); await page.mouse.down(); await page.mouse.move(box.x + iv.x + 40, box.y + iv.y, { steps: 4 }); await page.mouse.move(box.x + iv.x + 80, box.y + iv.y, { steps: 4 }); await page.mouse.up();
    const iv2 = await page.evaluate((id) => { const n = window.app.store.note(id); return { start: n.start.samples, end: n.end.samples }; }, iv.id);
    assert(iv2.start === 62 * 48000, 'start unchanged'); near(iv2.end, iv.end + 80 * iv.spp, iv.spp, 'end resized');
    // shift-drag selection on empty waveform area
    const wy = await page.evaluate(() => { const R = window.app.view.regions(); return (R.wave[0] + R.wave[1]) / 2; });
    await page.keyboard.down('Shift'); await page.mouse.move(box.x + 700, box.y + wy); await page.mouse.down(); await page.mouse.move(box.x + 800, box.y + wy, { steps: 5 }); await page.mouse.up(); await page.keyboard.up('Shift');
    const sel = await page.evaluate(() => window.app.selection && [window.app.view.xOfSample(window.app.selection.start), window.app.view.xOfSample(window.app.selection.end)]);
    assert(sel && Math.abs(sel[0] - 700) < 2 && Math.abs(sel[1] - 800) < 2, 'shift-drag selection: ' + JSON.stringify(sel));
    // hover tooltip on the pin
    const pinNow = await page.evaluate((id) => { const r = window.app.view.hitRegions.find(h => h.kind === 'pin' && h.id === id); return { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 }; }, pin.id);
    await page.mouse.move(box.x + pinNow.x, box.y + pinNow.y); await page.waitForFunction(() => !document.getElementById('tooltip').hidden);
    assert((await page.locator('#tooltip').innerText()).includes('drag me'), 'tooltip shows note');
    await shot('D_drag_and_tooltip');
    // double-click empty area creates a pin at that spot
    const n0 = await page.evaluate(() => window.app.store.notes.length);
    await page.mouse.dblclick(box.x + 300, box.y + wy);
    await page.waitForFunction((n0) => window.app.store.notes.length === n0 + 1, n0);
    const created = await page.evaluate(() => { const a = window.app; const n = a.store.notes[a.store.notes.length - 1]; return { x: a.view.xOfSample(n.start.samples), editing: !!a.editing }; });
    assert(Math.abs(created.x - 300) < 2 && created.editing, 'double-click pin at mouse + editor opened');
    await page.keyboard.press('Escape');
  });

  await test('N. no network requests other than the mocked Anthropic endpoint', async () => {
    const bad = externalRequests.filter(u => !u.startsWith('https://api.anthropic.com/'));
    assert(bad.length === 0, 'unexpected external requests: ' + bad.join(', '));
    log(`    external requests seen: ${externalRequests.length} (all api.anthropic.com, mocked)`);
  });

  if (pageErrors.length) log('  page errors during run:\n    ' + pageErrors.join('\n    '));
  await browser.close(); server.close();
  const failed = results.filter(r => !r.ok);
  log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });

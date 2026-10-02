/* run_library_tests.js — Playwright acceptance tests for the synthetic six-loop library (release 1.3.0).
 * Invoked by scripts/run_tests.sh. PW_CHROMIUM selects the browser binary.
 * Serves the app with tools/serve.js and the fake library in tests/fixtures/library. */
'use strict';
const path = require('path'), fs = require('fs');
const { chromium } = require('playwright');
const { start } = require('../tools/serve.js');
const ROOT = path.resolve(__dirname, '..'), FIXLIB = path.join(__dirname, 'fixtures', 'library'), SHOTS = path.join(__dirname, 'screenshots');
const args = process.argv.slice(2); const HEADED = args.includes('--headed'); const only = (args.find(a => a.startsWith('--only=')) || '').slice(7);
fs.mkdirSync(SHOTS, { recursive: true });
const results = []; const log = (...a) => console.log(...a);
async function test(name, fn) { if (only && !name.toLowerCase().includes(only.toLowerCase())) return; const t0 = Date.now(); try { await fn(); results.push({ name, ok: true }); log(`  ✔ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); } catch (e) { results.push({ name, ok: false }); log(`  ✘ ${name}: ${e.stack || e}`); } }
const assert = (c, m) => { if (!c) throw new Error('Assertion failed: ' + m); };
const near = (a, b, eps, m) => { if (Math.abs(a - b) > eps) throw new Error(`${m}: ${a} vs ${b} (eps ${eps})`); };

const SIDE = JSON.parse(fs.readFileSync(path.join(FIXLIB, 'fake-drums', 'fake-drums.imported-loops.json'), 'utf8'));

async function main() {
  // fresh session state for the fake library
  const oldRatings = ['fake-drums.', 'jo', 'sh', '-ratings.json'].join('');
  for (const f of ['fake-drums.loops.json', oldRatings, 'fake-drums.ratings.json']) { const p = path.join(FIXLIB, 'fake-drums', f); if (fs.existsSync(p)) fs.unlinkSync(p); }
  const { server, port } = await start({ port: 0, libraryDir: FIXLIB }); const base = `http://127.0.0.1:${port}/`;
  const browserOpts = { headless: !HEADED, args: ['--autoplay-policy=no-user-gesture-required'] };
  if (process.env.PW_CHROMIUM) browserOpts.executablePath = process.env.PW_CHROMIUM;
  const browser = await chromium.launch(browserOpts);
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, deviceScaleFactor: 1 });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => { log('  ! blocked', route.request().url()); route.abort(); });
  const page = await context.newPage(); const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const shot = (n) => page.screenshot({ path: path.join(SHOTS, n + '.png') });
  const clickDialog = async (t) => page.locator('dialog[open] button', { hasText: t }).first().click();
  const lab = (fn, arg) => page.evaluate(fn, arg);
  const launch = async () => { await page.goto(base + 'index.html?library=fake-drums'); await page.waitForFunction(() => window.app && window.app.loopLab && window.app.loopLab.libraryStats, null, { timeout: 90000 }); };
  const domHasClaude = () => lab((side) => {
    const html = document.body.innerHTML; const text = document.body.innerText; const found = [];
    for (const l of side.loops) { for (const v of [l.notes, l.score !== null ? `>${l.score.toFixed(1)}<` : null, l.ownPattern !== null ? `${l.ownPattern.toFixed(1)}*` : null]) { if (v && (html.includes(v) || text.includes(v))) found.push(`${l.id}: ${v}`); } }
    for (const el of document.querySelectorAll('[title]')) for (const l of side.loops) if (l.notes && el.title.includes(l.notes)) found.push(`${l.id}: title`);
    const ms = window.app.loopLab.lib.loops.map(l => l.machine && l.machine.score !== null ? l.machine.score.toFixed(1) : null).filter(Boolean);
    const cells = Array.from(document.querySelectorAll('#lbTable tbody td')).map(td => td.textContent.trim());
    for (const m of ms) if (cells.includes(m)) found.push('machine ' + m);
    return found;
  }, SIDE);
  log('Library fixture tests');

  await test('C1. launch: no click, six loops in song order, first selected, imported layer attached but hidden; reveal modes; reload hides again', async () => {
    const t0 = Date.now(); await launch(); const ms = Date.now() - t0;
    const r = await lab(() => { const L = window.app.loopLab; return { mode: window.app.mode, view: L.view, ids: L.visibleLoops().map(l => l.id), current: L.currentId, layer: (L.claudeLayer() || {}).name, matched: L.claudeLayer() ? Object.keys(L.claudeLayer().loops).length : 0, reveal: L.reveal, progressHidden: document.getElementById('lbProgress').hidden, rated: document.getElementById('lbRatedCount').textContent, claudeCol: document.getElementById('lbThClaude').hidden, stats: L.libraryStats }; });
    log(`    launched in ${ms} ms: ${JSON.stringify({ ids: r.ids, current: r.current, layer: r.layer, matched: r.matched, seed: r.stats.seedLoaded, computed: r.stats.computed })}`);
    assert(r.mode === 'loops' && r.view === 'library' && r.ids.join() === '9-16,15-16,33-34,33-36,101-104,324' && r.current === '9-16' && r.layer === 'Imported' && r.matched === 6 && r.reveal === 'hidden' && r.claudeCol, 'launch state: ' + JSON.stringify(r));
    assert(r.stats.seedLoaded === 6 && r.stats.computed === 0, 'analysis seeded from analysis-cache.json');
    let leaks = await domHasClaude(); assert(leaks.length === 0, 'no Claude/machine value in the DOM while hidden: ' + leaks.join(' | '));
    await shot('C1_launch_hidden');
    await page.selectOption('#lbRevealMode', 'rated'); leaks = await domHasClaude(); assert(leaks.length === 0, 'after-I-rate with nothing rated still hides everything: ' + leaks.join(' | '));
    await lab(() => { const L = window.app.loopLab; L.select('15-16'); L.lib.setRating('15-16', 7.1, '', []); L.renderAll(); });
    const partial = await lab(() => Array.from(document.querySelectorAll('#lbTable tbody tr')).map(tr => [tr.dataset.id, tr.querySelector('td.claude').textContent.trim()]));
    assert(partial.find(x => x[0] === '15-16')[1] === '9.6' && partial.filter(x => x[0] !== '15-16').every(x => x[1] === '·'), 'after-I-rate shows Claude only on the rated loop: ' + JSON.stringify(partial));
    await page.selectOption('#lbRevealMode', 'all'); const all = await lab(() => Array.from(document.querySelectorAll('#lbTable tbody tr')).map(tr => tr.querySelector('td.claude').textContent.trim()));
    assert(all.join() === '8.4,9.6,7.2,9.1,9.4*,5.5*', 'All shows every value (own-pattern with *): ' + all.join());
    await shot('C1_revealed_all');
    await launch(); const again = await lab(() => ({ reveal: window.app.loopLab.reveal, col: document.getElementById('lbThClaude').hidden })); assert(again.reveal === 'hidden' && again.col, 'reload → hidden again');
  });

  await test('C2. keyboard rating flow: 8 3 Enter → 8.3 blind, advances to next unrated; revealed rating → blind:false', async () => {
    await launch();
    await lab(() => { window.app.loopLab.lib.loops.forEach(l => { l.rating = null; l.blind = null; l.skipped = false; }); window.app.loopLab.select('9-16'); window.app.loopLab.renderAll(); });
    await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }); await page.keyboard.press('8'); const hint = await page.locator('#lbRatingHint').innerText(); assert(/8\._/.test(hint), 'first digit shown: ' + hint);
    await page.keyboard.press('3'); await page.keyboard.press('Enter');
    const r = await lab(() => { const L = window.app.loopLab; const l = L.lib.loop('9-16'); return { rating: l.rating, blind: l.blind, ratedAt: !!l.ratedAt, current: L.currentId, count: document.getElementById('lbRatedCount').textContent }; });
    assert(r.rating === 8.3 && r.blind === true && r.ratedAt && r.current === '15-16' && /rated 1 \/ 6/.test(r.count), 'blind rating saved and advanced: ' + JSON.stringify(r));
    await page.keyboard.press('s'); const sk = await lab(() => ({ skipped: window.app.loopLab.lib.loop('15-16').skipped, current: window.app.loopLab.currentId, count: document.getElementById('lbRatedCount').textContent })); assert(sk.skipped && sk.current === '33-34' && /1 skipped/.test(sk.count), 'S skips and advances: ' + JSON.stringify(sk));
    await page.keyboard.press('p'); assert((await lab(() => window.app.loopLab.currentId)) === '15-16', 'P previous'); await page.keyboard.press('n'); await page.keyboard.press('n');
    await page.selectOption('#lbRevealMode', 'all'); await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }); await page.keyboard.press('6'); await page.keyboard.press('5'); await page.keyboard.press('Enter');
    const r2 = await lab(() => { const l = window.app.loopLab.lib.loop('33-36'); return { rating: l.rating, blind: l.blind }; }); assert(r2.rating === 6.5 && r2.blind === false, 'revealed rating stores blind:false: ' + JSON.stringify(r2));
    assert((await lab(() => window.app.loopLab.currentId)) === '101-104', 'Enter advanced past the rated loop to the next unrated');
    await page.keyboard.press('u'); assert((await lab(() => window.app.loopLab.currentId)) === '324', 'U → next unrated (skips skipped and rated)');
    await page.keyboard.press('t'); assert(await lab(() => document.activeElement.id === 'lbNotes'), 'T focuses the note'); await page.keyboard.type('lazy but nice'); await page.keyboard.press('Meta+Enter');
    assert((await lab(() => window.app.loopLab.lib.loop('324').notes)) === 'lazy but nice', 'notes saved via ⌘Enter');
    await page.keyboard.press('Escape'); await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }); await page.keyboard.press('r'); assert((await lab(() => window.app.loopLab.reference && window.app.loopLab.reference.id)) === '324', 'R sets the reference');
    await shot('C2_rating_flow');
  });

  await test('C3. autosave: rating survives a reload with no dialog; endpoint absent → ⌘S fallback; localStorage draft restores', async () => {
    await launch(); await lab(() => { window.app.loopLab.lib.loops.forEach(l => { l.rating = null; l.skipped = false; }); window.app.loopLab.select('33-34'); window.app.loopLab.renderAll(); });
    await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }); await page.keyboard.press('7'); await page.keyboard.press('7'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => !window.app.loopLab.dirty && /saved/.test(document.getElementById('lbSaveTarget').textContent), null, { timeout: 10000 });
    const saved = JSON.parse(fs.readFileSync(path.join(FIXLIB, 'fake-drums', 'fake-drums.loops.json'), 'utf8')); assert(saved.loops.find(l => l.id === '33-34').rating === 7.7 && saved.schemaVersion === 2 && saved.session.library.name === 'fake-drums', 'session written to the library folder');
    await launch(); const back = await lab(() => ({ r: window.app.loopLab.lib.loop('33-34').rating, blind: window.app.loopLab.lib.loop('33-34').blind, dialogs: document.querySelectorAll('dialog[open]').length, restored: window.app.loopLab.libraryStats.sessionRestored })); assert(back.r === 7.7 && back.blind === true && back.dialogs === 0 && back.restored, 'rating back after reload with no dialog: ' + JSON.stringify(back));
    // endpoint absent: serve with a plain static server (tests/serve.js has no PUT)
    const plain = await require('./serve.js').start(0); const plainBase = `http://127.0.0.1:${plain.port}/`;
    fs.mkdirSync(path.join(ROOT, 'library'), { recursive: true }); const tmpIdx = path.join(ROOT, 'library', 'index.json'); const hadIdx = fs.existsSync(tmpIdx); const prevIdx = hadIdx ? fs.readFileSync(tmpIdx, 'utf8') : null;
    try {
      // point the app's library folder at the fixture by a temporary index (the plain server serves ROOT/library)
      const lnk = path.join(ROOT, 'library', 'fake-drums'); const hadLnk = fs.existsSync(lnk); if (!hadLnk) fs.symlinkSync(path.join(FIXLIB, 'fake-drums'), lnk);
      fs.writeFileSync(tmpIdx, JSON.stringify({ default: 'fake-drums', libraries: [{ name: 'fake-drums', path: 'fake-drums/', manifest: 'manifest.json', sidecar: 'fake-drums.imported-loops.json', session: 'fake-drums.loops.json', ratings: 'fake-drums.ratings.json' }] }));
      await page.goto(plainBase + 'index.html?library=fake-drums'); await page.waitForFunction(() => window.app && window.app.loopLab && window.app.loopLab.libraryStats, null, { timeout: 60000 });
      const ep = await lab(() => window.app.loopLab.library.endpoint); assert(ep === false, 'no endpoint detected on the plain server');
      await lab(() => { window.app.loopLab.select('9-16'); }); await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); }); await page.keyboard.press('5'); await page.keyboard.press('5'); await page.keyboard.press('Enter');
      const dirty = await lab(() => ({ dirty: window.app.loopLab.dirty, badge: !document.getElementById('lbDirty').hidden })); assert(dirty.dirty && dirty.badge, 'unsaved badge without endpoint');
      const dl = await lab(async () => { let got = null; const o = U.downloadText; U.downloadText = (n, t) => { got = { n, len: t.length }; }; const op = window.showSaveFilePicker; window.showSaveFilePicker = async () => { const e = new Error('x'); e.name = 'SecurityError'; throw e; }; await window.app.loopLab.save(); U.downloadText = o; window.showSaveFilePicker = op; return got; }); assert(dl && /loops\.json$/.test(dl.n), '⌘S fallback downloads: ' + JSON.stringify(dl));
      // localStorage draft: make a change, reload, restore banner
      await lab(() => { const L = window.app.loopLab; L.lib.setRating('15-16', 4.2, 'draft', []); L.dirty = true; L.autosaveNow(); });
      await page.goto(plainBase + 'index.html?library=fake-drums'); await page.waitForFunction(() => window.app && window.app.loopLab && window.app.loopLab.libraryStats, null, { timeout: 60000 });
      await page.waitForFunction(() => !document.getElementById('banner').hidden && /autosaved/.test(document.getElementById('banner').innerText), null, { timeout: 5000 });
      await page.locator('#banner button', { hasText: 'Restore' }).click(); await page.waitForFunction(() => window.app.loopLab.lib.loop('15-16') && window.app.loopLab.lib.loop('15-16').rating === 4.2);
      const rl = await lab(() => ({ r: window.app.loopLab.lib.loop('15-16').rating, linked: window.app.loopLab.lib.loops.every(l => l._url) })); assert(rl.r === 4.2 && rl.linked, 'draft restored and loops still linked to the library: ' + JSON.stringify(rl));
    } finally { if (hadIdx) fs.writeFileSync(tmpIdx, prevIdx); else fs.unlinkSync(tmpIdx); const lnk = path.join(ROOT, 'library', 'fake-drums'); try { if (fs.lstatSync(lnk).isSymbolicLink()) fs.unlinkSync(lnk); } catch (_) { } plain.server.close(); }
  });

  await test('C4. ratings export matches $defs/ratingsExport, CSV agrees, import restores; comparison null when hidden, filled when revealed + ticked', async () => {
    await launch(); await lab(() => { const L = window.app.loopLab; L.lib.loops.forEach(l => { l.rating = null; l.skipped = false; }); L.lib.setRating('9-16', 8.3, 'a', ['backbone']); L.lib.loop('9-16').blind = true; L.lib.setRating('15-16', 9.1, 'b', []); L.lib.loop('15-16').blind = true; L.lib.setRating('101-104', 6.0, 'c', []); L.lib.loop('101-104').blind = false; L.lib.loop('33-34').skipped = true; L.renderAll(); });
    const ex1 = await lab(async () => { const L = window.app.loopLab; const o = L.persist.exportText; L.persist.exportText = async () => ({ name: 'x' }); const ex = await L.exportRatings(); L.persist.exportText = o; return ex; });
    assert(ex1.comparison === null && ex1.ratings.length === 3 && ex1.unrated.length === 3 && ex1.summary.rated === 3 && ex1.summary.skipped === 1 && ex1.summary.byLength['8'].rated === 1, 'hidden export: no comparison: ' + JSON.stringify(ex1.summary));
    const errs = await lab((ex) => validateSchema(LOOPS_SCHEMA.$defs.ratingsExport, ex, LOOPS_SCHEMA), ex1); assert(errs.length === 0, 'schema valid: ' + JSON.stringify(errs));
    assert(!JSON.stringify(ex1).includes('Fake intro run') && !JSON.stringify(ex1).includes('9.6'), "Claude's values never in the file while hidden");
    const onDisk = JSON.parse(fs.readFileSync(path.join(FIXLIB, 'fake-drums', 'fake-drums.ratings.json'), 'utf8')); assert(onDisk.ratings.length === 3, 'written to the library folder through the endpoint');
    const csv = await lab((ex) => LibraryLoader.ratingsCsv(ex), ex1); const rows = csv.split('\n').filter(l => /^\d/.test(l) || /^[0-9-]+,/.test(l)); assert(rows.length === 3 && csv.includes('9-16,8 bar loops/9-16.wav,8,9,17,8.3,,backbone,a,') && csv.includes('unrated,33-34 33-36 324'), 'csv agrees: ' + rows[0]);
    await page.selectOption('#lbRevealMode', 'all'); await page.check('#lbIncludeCmp');
    const ex2 = await lab(async () => { const L = window.app.loopLab; const o = L.persist.exportText; L.persist.exportText = async () => ({ name: 'x' }); const ex = await L.exportRatings(); L.persist.exportText = o; return ex; });
    assert(ex2.comparison && ex2.comparison.n === 3 && ex2.comparison.perLoop.find(p => p.id === '101-104').basis === 'ownPattern' && typeof ex2.comparison.meanAbsDelta === 'number', 'comparison filled when revealed and ticked: ' + JSON.stringify(ex2.comparison && { n: ex2.comparison.n, rho: ex2.comparison.spearman, mad: ex2.comparison.meanAbsDelta }));
    fs.writeFileSync(path.join(FIXLIB, 'fake-drums', 'comparison.ratings.json'), JSON.stringify(ex2, null, 2) + '\n');
    await lab(() => { window.app.loopLab.showTab('compare'); }); await page.waitForTimeout(200); await shot('C4_compare');
    await lab(() => { const L = window.app.loopLab; L.lib.loops.forEach(l => { l.rating = null; l.blind = null; l.tags = []; l.notes = ''; }); L.renderAll(); });
    const imp = await lab((ex) => window.app.loopLab.importRatingsText(JSON.stringify(ex), 'x.json'), ex1); assert(imp === true, 'import ok');
    const after = await lab(() => window.app.loopLab.lib.loops.filter(l => l.rating !== null).map(l => [l.id, l.rating, l.blind, l.tags.join()])); assert(JSON.stringify(after) === JSON.stringify([['9-16', 8.3, true, 'backbone'], ['15-16', 9.1, true, ''], ['101-104', 6, false, '']]), 'restored: ' + JSON.stringify(after));
  });

  await test('C5. sorting: every key, direction, secondary, unrated first/last, similarity (symmetric, zero, presets, centroid), seam compatibility, seeded random', async () => {
    await launch(); await lab(() => { const L = window.app.loopLab; L.lib.loops.forEach(l => { l.rating = null; l.skipped = false; l.listens = 0; }); L.lib.setRating('15-16', 9.1, '', []); L.lib.setRating('33-34', 5.5, '', []); L.lib.setRating('9-16', 8.0, '', []); L.lib.loop('101-104').listens = 5; L.lib.loop('324').listens = 2; L.renderAll(); });
    const order = (opts) => lab((o) => { const L = window.app.loopLab; Object.assign(L.sort, { key: 'position', dir: null, secondary: null, unratedFirst: false }, o); return L.visibleLoops().map(l => l.id); }, opts);
    const R = {};
    R.position = await order({ key: 'position' }); assert(R.position.join() === '9-16,15-16,33-34,33-36,101-104,324', 'position');
    R.length = await order({ key: 'length' }); assert(R.length.join() === '15-16,33-34,33-36,101-104,9-16,324', 'length asc, then position');
    R.lengthDesc = await order({ key: 'length', dir: -1 }); assert(R.lengthDesc[0] === '324' && R.lengthDesc[1] === '9-16', 'direction');
    R.rating = await order({ key: 'rating' }); assert(R.rating.slice(0, 3).join() === '15-16,9-16,33-34' && R.rating.slice(3).join() === '33-36,101-104,324', 'my rating desc, unrated last');
    R.ratingUF = await order({ key: 'rating', unratedFirst: true }); assert(R.ratingUF.slice(0, 3).join() === '33-36,101-104,324', 'unrated first');
    R.lengthRating = await order({ key: 'length', secondary: 'rating' }); assert(R.lengthRating.join() === '15-16,33-34,33-36,101-104,9-16,324', 'secondary key within equal lengths (15-16 9.1 before 33-34 5.5)');
    await page.selectOption('#lbRevealMode', 'all');
    R.claude = await order({ key: 'claude' }); assert(R.claude.join() === '15-16,33-36,9-16,33-34,101-104,324', "Claude's rating desc, null (own-pattern only) last");
    R.claudeSec = await order({ key: 'claude', secondary: 'ownPattern' }); assert(R.claudeSec.slice(4).join() === '101-104,324', 'secondary own-pattern orders the nulls');
    R.weak = await order({ key: 'weakest' }); assert(R.weak[0] === '15-16', 'weakest bar');
    R.section = await order({ key: 'section' }); assert(R.section.join() === '9-16,15-16,33-34,33-36,101-104,324', 'section in song order');
    R.feel = await order({ key: 'feel' }); assert(R.feel[0] === '33-34' || R.feel[0] === '324', 'feel behind first: ' + R.feel.join());
    R.hats = await order({ key: 'hats' }); assert(R.hats[0] === '101-104', 'lightest hats first (hatDb)');
    R.loud = await order({ key: 'loudness' }); assert(R.loud.length === 6, 'loudness');
    R.machine = await order({ key: 'machine' }); assert(R.machine.indexOf('33-34') > R.machine.indexOf('15-16'), 'machine score desc');
    R.dis = await order({ key: 'disagreement' }); assert(R.dis[0] === '33-34', '|mine − Claude| biggest first (33-34: 5.5 vs 7.2)');
    R.listens = await order({ key: 'listens' }); assert(R.listens.slice(-2).join() === '324,101-104', 'least listened first');
    R.recent = await order({ key: 'recent' }); assert(R.recent[0] === '9-16', 'most recently rated first');
    R.rand1 = await order({ key: 'random' }); await lab(() => { window.app.loopLab.randomSeed = 'abc'; }); R.rand2 = await order({ key: 'random' }); await lab(() => { window.app.loopLab.randomSeed = 'abc'; }); R.rand3 = await order({ key: 'random' });
    assert(R.rand2.join() === R.rand3.join() && R.rand2.join() !== R.position.join(), 'seeded random repeatable and shuffled');
    // similarity
    const sim = await lab(() => { const L = window.app.loopLab; L.setReference(L.lib.loop('15-16')); L.weights = Object.assign({}, Ranking.presets.all); const ctx = L.ctx(); const a = L.lib.loop('15-16'), b = L.lib.loop('33-36'), c = L.lib.loop('101-104'); const d = (x, y, w) => Ranking.distance(x, y, w || L.weights).total; const orderAll = L.visibleLoops().map(l => l.id);
      L.weights = Object.assign({}, Ranking.presets.pattern); const orderPattern = L.visibleLoops().map(l => l.id); L.weights = Object.assign({}, Ranking.presets.feel); const orderFeel = L.visibleLoops().map(l => l.id); L.weights = Object.assign({}, Ranking.presets.sound); const orderSound = L.visibleLoops().map(l => l.id); L.weights = Object.assign({}, Ranking.presets.all);
      return { zero: d(a, a), sym: [d(a, b), d(b, a)], sym2: [d(a, c), d(c, a)], orderAll, orderPattern, orderFeel, orderSound, dLazy: Ranking.distance(a, L.lib.loop('33-34'), Ranking.presets.feel), dTight4: Ranking.distance(a, b, Ranking.presets.feel), dLight: Ranking.distance(a, c, Ranking.presets.sound), dTightS: Ranking.distance(a, b, Ranking.presets.sound), row: document.querySelector('#lbTable tbody tr').querySelector('td.sim').textContent, first: orderAll[0] }; });
    log('    similarity: ' + JSON.stringify({ all: sim.orderAll, pattern: sim.orderPattern, feel: sim.orderFeel, sound: sim.orderSound }));
    assert(sim.zero === 0 && sim.sym[0] === sim.sym[1] && sim.sym2[0] === sim.sym2[1] && sim.first === '15-16' && sim.row === '0.00', 'symmetric, zero for the reference, reference pinned');
    assert(sim.dLazy.feel > sim.dTight4.feel, 'feel preset: lazy pair is farther than the tight 4-bar'); assert(sim.dLight.sound > sim.dTightS.sound, 'sound preset: light hats farther than the tight 4-bar');
    assert(sim.orderFeel.indexOf('33-34') > sim.orderFeel.indexOf('33-36') && sim.orderSound.indexOf('101-104') > sim.orderSound.indexOf('33-36'), 'presets change the order as expected');
    const cen = await lab(() => { const L = window.app.loopLab; const members = L.lib.loops.filter(l => (L.claudeRec(l) || {}).section === 'Bass in'); L.setReference(Ranking.centroid(members, 'Bass in')); const ids = L.visibleLoops().map(l => l.id); return { ids, ref: L.reference.id, members: L.reference.members }; });
    assert(cen.ref === '§ Bass in' && cen.members.join() === '33-34,33-36' && ['33-34', '33-36'].includes(cen.ids[0]), 'section centroid puts its members first: ' + cen.ids.join());
    const seam = await lab(() => { const L = window.app.loopLab; L.setReference(L.lib.loop('15-16')); L.sort.key = 'seam'; L.sort.dir = null; const ids = L.visibleLoops().map(l => l.id); const ctx = L.ctx(); const scores = ids.map(id => [id, Ranking.seamCompat(L.reference, L.lib.loop(id), ctx)]); return { ids, scores: scores.map(s => [s[0], s[1] && s[1].score, s[1] && s[1].verdict]) }; });
    log('    seam compat: ' + JSON.stringify(seam.scores));
    assert(seam.ids[0] === '15-16' && seam.ids.indexOf('33-36') < seam.ids.indexOf('33-34') && seam.ids.indexOf('33-36') < seam.ids.indexOf('101-104'), 'seam compatibility: the tight 4-bar follows the reference more cleanly than lazy or light-hats');
    await lab(() => { window.app.loopLab.setReference(null); });
    await shot('C5_sorting');
  });

  await test('C6. filters combine, the song strip range filters, group-by-section headers in song order', async () => {
    await launch(); await lab(() => { const L = window.app.loopLab; L.lib.loops.forEach(l => { l.rating = null; l.skipped = false; }); L.lib.setRating('15-16', 9.1, '', []); L.renderAll(); });
    const f = (fn) => lab((src) => { const L = window.app.loopLab; L.filters = Ranking.emptyFilters(); (new Function('f', 'L', src))(L.filters, L); L.renderFilterChips(); L.renderTable(); return L.visibleLoops().map(l => l.id); }, fn);
    assert((await f("f.length.add('2')")).join() === '15-16,33-34', 'length chip'); assert((await f("f.length.add('2'); f.length.add('4')")).join() === '15-16,33-34,33-36,101-104', 'two length chips');
    assert((await f("f.length.add('2'); f.hats.add('full'); f.rated = 'rated'")).join() === '15-16', 'length + hats + rated combine');
    assert((await f("f.section.add('Bass in')")).join() === '33-34,33-36', 'section'); assert((await f("f.use.add('event / punctuation')")).join() === '324', 'use tag');
    assert((await f("f.bass = 'out'")).join() === '15-16', 'bass out'); assert((await f("f.fill = true")).join() === '324', 'has fill'); assert((await f("f.variant = true")).join() === '33-34,101-104', 'variant');
    assert((await f("f.ratingMin = 9")).join() === '15-16', 'my rating ≥'); assert((await f("f.rated = 'unrated'")).length === 5, 'unrated');
    await page.selectOption('#lbRevealMode', 'all'); assert((await f("f.claudeMin = 9")).join() === '15-16,33-36', "Claude ≥ (revealed)");
    await page.selectOption('#lbRevealMode', 'hidden'); assert((await f("f.claudeMin = 9")).length === 6, "Claude ≥ ignored while hidden");
    await lab(() => { window.app.loopLab.filters = Ranking.emptyFilters(); window.app.loopLab.renderFilterChips(); window.app.loopLab.renderTable(); });
    // chips via UI
    await page.locator('#lbChips .chip', { hasText: '4 bar' }).click(); await page.locator('#lbChips .chip', { hasText: 'light hats' }).click();
    assert((await lab(() => window.app.loopLab.visibleLoops().map(l => l.id))).join() === '101-104', 'chips clicked combine'); await page.click('#lbClearFilters');
    // song strip drag: bars 30–40
    const box = await page.locator('#lbStrip').boundingBox(); const xOf = await lab((bars) => bars.map(b => window.app.loopLab.strip.xOf(b)), [30, 40]);
    await page.mouse.move(box.x + xOf[0], box.y + 40); await page.mouse.down(); await page.mouse.move(box.x + xOf[1], box.y + 40, { steps: 6 }); await page.mouse.up();
    const rng = await lab(() => ({ range: window.app.loopLab.filters.barRange, ids: window.app.loopLab.visibleLoops().map(l => l.id) })); assert(rng.range && rng.range[0] <= 33 && rng.range[1] >= 36 && rng.ids.join() === '33-34,33-36', 'strip drag filters to the bar range: ' + JSON.stringify(rng));
    await shot('C6_strip_range');
    await page.click('#lbClearFilters'); await page.check('#lbGroup');
    const heads = await lab(() => Array.from(document.querySelectorAll('#lbTable tr.group td')).map(td => td.textContent)); assert(heads.join('|') === 'Vamp (2)|Bass in (2)|Riddim I (1)|BREAK (1)', 'group headers in song order: ' + heads.join('|'));
    await shot('C6_grouped'); await page.uncheck('#lbGroup');
  });

  if (pageErrors.length) log('  page errors:\n    ' + pageErrors.join('\n    '));
  await browser.close(); server.close();
  const failed = results.filter(r => !r.ok); log(`\n${results.length - failed.length}/${results.length} passed`); if (failed.length) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });

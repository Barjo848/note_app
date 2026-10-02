/* library.js — LibraryLoader: the startup library (manifest + sidecar + cached
 * analysis), URL-backed loop entries decoded on demand, the analysis cache in
 * IndexedDB (seeded from analysis-cache.json), dialog-free autosave through
 * tools/serve.js, and the ratings export/import.
 *
 * Only over http(s): from file:// the app behaves as in 1.2. */
'use strict';

const IDB = {
  DB: 'note', VERSION: 2,
  open() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
      const req = indexedDB.open(this.DB, this.VERSION);
      req.onupgradeneeded = () => { const db = req.result; for (const st of ['peaks', 'analysis']) if (!db.objectStoreNames.contains(st)) db.createObjectStore(st); };
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error || new Error('IndexedDB open failed')); req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  },
  async get(store, key) { try { const db = await this.open(); return await new Promise((res, rej) => { const tx = db.transaction(store, 'readonly'); const r = tx.objectStore(store).get(key); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); tx.oncomplete = () => db.close(); }); } catch (e) { return null; } },
  async put(store, key, value) { try { const db = await this.open(); await new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); }); return true; } catch (e) { return false; } },
  async putMany(store, entries) { try { const db = await this.open(); await new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); const os = tx.objectStore(store); for (const [k, v] of entries) os.put(v, k); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); }); return true; } catch (e) { return false; } },
  async getAllKeys(store) { try { const db = await this.open(); return await new Promise((res, rej) => { const tx = db.transaction(store, 'readonly'); const r = tx.objectStore(store).getAllKeys(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); tx.oncomplete = () => db.close(); }); } catch (e) { return []; } },
  async clear(store) { try { const db = await this.open(); await new Promise((res, rej) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).clear(); tx.oncomplete = () => { db.close(); res(); }; tx.onerror = () => rej(tx.error); }); return true; } catch (e) { return false; } },
};

class LibraryLoader {
  constructor(lab) { this.lab = lab; this.lib = lab.lib; this.player = lab.player; this.index = null; this.current = null; this.endpoint = false; this.base = 'library/'; this._saving = null; this._pending = false; this.lastSave = null; }
  static get served() { return typeof location !== 'undefined' && /^https?:$/.test(location.protocol); }
  /** A library opens only when the URL asks for one: `?library=<name>`. */
  static requestedName() {
    if (!this.served) return null;
    try {
      const name = new URLSearchParams(location.search).get('library');
      return name && name.trim() ? name.trim() : null;
    } catch (_) { return null; }
  }
  async fetchJson(url) { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); }
  async ping() { try { const r = await fetch('api/ping', { cache: 'no-store' }); if (!r.ok) return false; const j = await r.json(); this.endpoint = !!j.ok; return this.endpoint; } catch (e) { this.endpoint = false; return false; } }
  async fetchIndex() { if (!LibraryLoader.served) return null; try { this.index = await this.fetchJson(this.base + 'index.json'); return this.index; } catch (e) { return null; } }
  libUrl(name) { return this.base + (this.current && this.current.entry.path ? this.current.entry.path : this.current.entry.name + '/') + name; }

  /**
   * Open a library: manifest → entries; session document (if saved) → ratings/arrangements;
   * cached analysis (IndexedDB, seeded from analysis-cache.json) → hits; sidecar → imported layer.
   */
  async open(entry, { onProgress = () => { } } = {}) {
    const t0 = performance.now(); const lib = this.lib;
    this.current = { entry }; const pathBase = this.base + (entry.path || entry.name + '/');
    onProgress(`loading ${entry.name}…`, 0);
    const manifest = await this.fetchJson(pathBase + (entry.manifest || 'manifest.json'));
    this.current.manifest = manifest;
    let sessionDoc = null;
    try { sessionDoc = await this.fetchJson(pathBase + (entry.session || entry.name + '.loops.json')); } catch (_) { sessionDoc = null; }
    let sessionRestored = false, sessionErrors = [];
    if (sessionDoc) { const { doc, errors } = lib.parseDocument(JSON.stringify(sessionDoc)); if (doc) { lib.applyDocument(doc); sessionRestored = true; } else { sessionErrors = errors; console.warn('saved session ignored', errors); } }
    if (!sessionDoc) { lib.session.name = manifest.name; lib.session.bpm = manifest.bpm || lib.session.bpm; lib.session.sourceNote = manifest.barConvention || lib.session.sourceNote; }
    lib.libraryMeta = { name: manifest.name, path: pathBase, manifestGeneratedAt: manifest.generatedAt || '', count: manifest.loops.length };
    const added = [], relinked = [];
    manifest.loops.forEach((m, i) => { const { entry: e, relinked: r } = lib.addFromManifest(m, pathBase + encodeURI(m.path).replace(/#/g, '%23')); (r ? relinked : added).push(e); if (i % 20 === 0) onProgress(`loading ${manifest.loops.length} loops…`, 0.1 * i / manifest.loops.length); });
    // sidecar → imported layer (once; a saved session keeps the name it already stored)
    let sidecarResult = null;
    if (entry.sidecar || manifest.sidecar) {
      const existing = lib.layers.find(l => l.kind === 'imported' && (l.name === IMPORTED_LAYER_NAME || l.name === 'Claude' || (typeof l.name === 'string' && (l.name.startsWith(IMPORTED_LAYER_NAME + ' ') || l.name.startsWith('Claude ')))));
      if (!existing) { try { const side = await this.fetchJson(pathBase + (entry.sidecar || manifest.sidecar)); sidecarResult = lib.importSidecar(side, { name: IMPORTED_LAYER_NAME }); } catch (e) { console.warn('sidecar', e); } }
      else sidecarResult = { layer: existing, matched: Object.keys(existing.loops), unmatched: [] };
    }
    // analysis: IndexedDB → seed file → compute
    const version = ANALYSIS_VERSION; let seed = null; let seedLoaded = 0;
    const need = lib.loops.filter(l => l._url && !(l.hits && l.hits.length && l.seamFeatures && l._analysisVersion === version));
    const results = new Map();
    for (const l of need) { const c = await IDB.get('analysis', `${l.fingerprint}:${version}`); if (c) results.set(l.fingerprint, c); }
    if (results.size < need.length) { try { seed = await this.fetchJson(pathBase + 'analysis-cache.json'); if (seed.analysisVersion !== version) seed = null; } catch (_) { seed = null; } }
    if (seed) { const toStore = []; for (const l of need) if (!results.has(l.fingerprint) && seed.entries[l.fingerprint]) { results.set(l.fingerprint, seed.entries[l.fingerprint]); toStore.push([`${l.fingerprint}:${version}`, seed.entries[l.fingerprint]]); seedLoaded++; } if (toStore.length) await IDB.putMany('analysis', toStore); }
    let computed = 0, i = 0;
    for (const l of need) {
      i++; onProgress(`analysing ${i}/${need.length}…`, 0.1 + 0.9 * i / need.length);
      let a = results.get(l.fingerprint);
      if (!a) { try { a = await this.analyse(l); await IDB.put('analysis', `${l.fingerprint}:${version}`, a); computed++; } catch (e) { console.warn('analysis failed', l.id, e); continue; } }
      this.apply(l, a);
    }
    for (const l of lib.loops) if (l._url && l.hits.length && !l._analysisVersion) l._analysisVersion = version;
    lib.recompute();
    this.lab.evictBuffers();
    const ms = performance.now() - t0;
    return { manifest, added: added.length, relinked: relinked.length, sidecar: sidecarResult, cachedIdb: results.size - seedLoaded, seedLoaded, computed, sessionRestored, sessionErrors, ms };
  }
  /** After a document replaced the library's entries (draft restore, Load loops.json): re-link URLs and re-apply cached analysis. */
  async relink() {
    if (!this.current || !this.current.manifest) return 0; const lib = this.lib; const pathBase = this.base + (this.current.entry.path || this.current.entry.name + '/'); let n = 0;
    const entries = this.current.manifest.loops.map(m => lib.addFromManifest(m, pathBase + encodeURI(m.path).replace(/#/g, '%23')).entry); n = entries.length;   // links first (synchronous)
    for (const e of entries) { if (!(e.hits && e.hits.length && e.seamFeatures) || e._analysisVersion !== ANALYSIS_VERSION) { const a = await IDB.get('analysis', `${e.fingerprint}:${ANALYSIS_VERSION}`); if (a) this.apply(e, a); } else e._analysisVersion = ANALYSIS_VERSION; }
    lib.libraryMeta = lib.libraryMeta || { name: this.current.manifest.name, path: pathBase, manifestGeneratedAt: this.current.manifest.generatedAt || '', count: n };
    lib.recompute(); return n;
  }
  /** cached analysis record → loop entry */
  apply(l, a) {
    l._raw = a.raw; l._floors = a.floors; l._join = a.join; l._rmsLin = a.rmsLin; l.rmsDb = a.rmsDb; l._analysisVersion = ANALYSIS_VERSION;
    this.lib.setRawHits(l, a.raw, { stemVerified: false });
    l.seamFeatures = a.seamFeatures || l.seamFeatures;
  }
  async fetchBlob(l) { const r = await fetch(l._url); if (!r.ok) throw new Error(`${l.id}: HTTP ${r.status}`); return r.blob(); }
  /** full analysis of one URL-backed loop: fetch → decode → worker → join → seam features */
  async analyse(l) {
    const buf = await this.lab.ensureBuffer(l);
    const mono = this.lab.monoOf(buf); const floors = this.lib.session.bandFloorsDb || {};
    const opts = { floors: { low: floors.low ?? undefined, mid: floors.mid ?? undefined, high: floors.high ?? undefined }, flamMs: this.lib.session.thresholds.flamMs };
    const r = this.lab.worker ? await this.lab.worker.analyzeMono(mono, buf.sampleRate, opts) : OnsetDsp.analyzeMono(mono, buf.sampleRate, opts);
    const chans = []; for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    const join = OnsetDsp.joinAnalysis(chans, buf.sampleRate, r.hits.map(h => h.ms), buf.length);
    const tmp = { id: l.id, bars: l.bars, barsRounded: l.barsRounded, offsetSamples: l.offsetSamples || 0, hits: [], _join: join };
    this.lib.setRawHits(tmp, r.hits); tmp.hits.forEach(h => { });
    const seamFeatures = Sequence.loopFeatures(Object.assign(tmp, { hits: tmp.hits }), buf, this.lib);
    const rmsLin = l._rmsLin || LoopPlayer.rmsLinear(buf);
    return { id: l.id, raw: r.hits, floors: r.floors, join, rmsLin, rmsDb: +U.ampDb(rmsLin).toFixed(1), seamFeatures, sampleRate: buf.sampleRate, frames: buf.length };
  }

  /* ---------- autosave through the server ---------- */
  async putJson(name, obj) {
    if (!this.endpoint || !this.current) return false;
    const r = await fetch(this.libUrl(name), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj, null, 1) });
    if (!r.ok) throw new Error(`save failed: HTTP ${r.status}`); return true;
  }
  /** debounced session save; resolves true when written to the library folder */
  saveSession(doc) {
    if (!this.endpoint || !this.current) return Promise.resolve(false);
    this._pendingDoc = doc;
    if (this._saving) { this._pending = true; return this._saving; }
    this._saving = (async () => {
      try { do { this._pending = false; const d = this._pendingDoc; await this.putJson(this.current.entry.session || this.current.entry.name + '.loops.json', d); this.lastSave = U.nowIso(); } while (this._pending); return true; }
      catch (e) { console.warn(e); return false; }
      finally { this._saving = null; }
    })();
    return this._saving;
  }

  /* ---------- ratings export / import ---------- */
  buildRatingsExport({ includeComparison = false, comparison = null } = {}) {
    const lib = this.lib; const lab = this.lab;
    const seqUse = (id) => lib.arrangements.filter(a => a.blocks.some(b => b.loopId === id)).map(a => a.name);
    const rated = lib.loops.filter(l => l.rating !== null && l.rating !== undefined);
    const rows = rated.map(l => ({ id: l.id, fingerprint: l.fingerprint || null, file: (l.folder ? l.folder + '/' : '') + l.fileName, bars: l.barsRounded || Math.round(l.bars), ptStart: l.ptStart ?? null, ptEnd: l.ptEnd ?? null, rating: l.rating, class: l.myClass || null, tags: l.tags || [], notes: l.notes || '', ratedAt: l.ratedAt || null, blind: l.blind !== false, listens: l.listens || 0, skipped: !!l.skipped, sequenceUse: seqUse(l.id) }));
    const lenKey = (l) => (l.folder || '').startsWith('Events') || /event/i.test(l.folder || '') ? 'event' : String(l.barsRounded || Math.round(l.bars));
    const byLength = {}; for (const l of rated) { const k = lenKey(l); const b = byLength[k] = byLength[k] || { rated: 0, sum: 0 }; b.rated++; b.sum += l.rating; }
    for (const k of Object.keys(byLength)) { byLength[k].meanRating = +(byLength[k].sum / byLength[k].rated).toFixed(2); delete byLength[k].sum; byLength[k].total = lib.loops.filter(l => lenKey(l) === k).length; }
    return {
      schemaVersion: 1, app: `${APP_NAME} ${APP_VERSION}`, exportedAt: U.nowIso(), library: lib.libraryMeta ? lib.libraryMeta.name : (lib.session.name || 'session'), bpm: lib.session.bpm,
      barConvention: (this.current && this.current.manifest && this.current.manifest.barConvention) || lib.session.sourceNote || '',
      ratings: rows, unrated: lib.loops.filter(l => l.rating === null || l.rating === undefined).map(l => l.id),
      summary: { rated: rated.length, skipped: lib.loops.filter(l => l.skipped).length, total: lib.loops.length, meanRating: rated.length ? +(rated.reduce((s, l) => s + l.rating, 0) / rated.length).toFixed(2) : null, byLength },
      comparison: includeComparison && lab.reveal !== 'hidden' && comparison ? comparison : null,
    };
  }
  static ratingsCsv(ex) {
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = [['id', 'file', 'bars', 'pt_start', 'pt_end', 'rating', 'class', 'tags', 'notes', 'rated_at', 'blind', 'listens', 'skipped', 'sequence_use', 'delta_vs_claude'].join(',')];
    const cmp = ex.comparison ? new Map(ex.comparison.perLoop.map(p => [p.id, p])) : null;
    for (const r of ex.ratings) rows.push([esc(r.id), esc(r.file), r.bars, r.ptStart ?? '', r.ptEnd ?? '', r.rating, esc(r.class || ''), esc(r.tags.join(' ')), esc(r.notes), esc(r.ratedAt || ''), r.blind, r.listens, r.skipped, esc(r.sequenceUse.join('; ')), cmp && cmp.get(r.id) ? cmp.get(r.id).delta : ''].join(','));
    rows.push(''); rows.push('unrated,' + esc(ex.unrated.join(' ')));
    return rows.join('\n') + '\n';
  }
  /** restore ratings from an export (by id, then fingerprint) */
  importRatings(ex) {
    const errors = validateSchema(LOOPS_SCHEMA.$defs.ratingsExport, ex, LOOPS_SCHEMA).map(e => `${e.path}: ${e.message}`); if (errors.length) return { errors };
    const restored = [], missing = [];
    for (const r of ex.ratings) {
      const l = this.lib.loop(r.id) || this.lib.loop(LoopLibrary.normalizeId(r.id)) || (r.fingerprint && this.lib.loops.find(x => x.fingerprint === r.fingerprint));
      if (!l) { missing.push(r.id); continue; }
      l.rating = LoopLibrary.clampRating(r.rating); l.myClass = r.class || null; l.tags = r.tags || []; l.notes = r.notes || ''; l.ratedAt = r.ratedAt || U.nowIso(); l.blind = r.blind !== false; l.listens = r.listens || l.listens || 0; l.skipped = !!r.skipped; restored.push(l.id);
    }
    this.lib.emit({ label: 'import ratings' });
    return { restored, missing, errors: [] };
  }
}

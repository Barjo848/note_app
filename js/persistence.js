/* persistence.js — Persistence: build/parse the notes document, File System
 * Access API save with download fallback, autosave in localStorage.
 *
 * Round-trip safety: the live layer/note/reply objects ARE the objects that
 * came out of the loaded JSON, so their unknown fields ride along untouched.
 * Document- and track-level unknown keys are kept in `extra` and spread back
 * in when the document is rebuilt. */
'use strict';

const APP_NAME = 'Note', APP_VERSION = '1.0.0', SCHEMA_VERSION = 1;

class Persistence {
  constructor() {
    this.saveHandle = null;          // FileSystemFileHandle for the notes JSON
    this.savedText = null;           // last text written to disk (dirty detection)
    this.extra = { doc: {}, track: {} };
    this.history = [];
  }
  get hasFsAccess() { return typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function'; }

  /* ---------- document ---------- */
  buildDocument({ info, grid, store, settings }) {
    const knownTrack = { fileName: info.fileName, fingerprint: info.fingerprint, sizeBytes: info.sizeBytes, durationSeconds: +info.durationSeconds.toFixed(6), sampleRate: info.sampleRate, channels: info.channels, bitDepth: info.bitDepth, format: info.format };
    const doc = Object.assign({}, this.extra.doc, {
      schemaVersion: SCHEMA_VERSION,
      app: { name: APP_NAME, version: APP_VERSION },
      track: Object.assign({}, this.extra.track, knownTrack),
      grid: grid.toJSON(),
      settings: { categories: store.categories.slice(), categoryColors: Object.assign({}, store.categoryColors), snap: settings.snap },
      layers: store.layers,
      notes: store.notes,
      history: this.history,
    });
    return doc;
  }
  serialize(doc) { return JSON.stringify(doc, null, 2) + '\n'; }

  /** @returns {{doc:object|null, errors:string[], warnings:string[]}} */
  parseDocument(text) {
    const errors = [], warnings = [];
    let doc;
    try { doc = JSON.parse(text); } catch (e) { return { doc: null, errors: [`Not valid JSON: ${e.message}`], warnings }; }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { doc: null, errors: ['The file does not contain a JSON object.'], warnings };
    if (doc.schemaVersion === undefined) errors.push('Missing "schemaVersion" — is this a Note notes file?');
    else if (doc.schemaVersion > SCHEMA_VERSION) warnings.push(`This file uses schema version ${doc.schemaVersion}; this app understands ${SCHEMA_VERSION}. Loading anyway; unknown fields are preserved.`);
    const v = validateSchema(NOTES_SCHEMA, doc);
    for (const e of v) errors.push(`${e.path}: ${e.message}`);
    if (errors.length) return { doc: null, errors, warnings };
    return { doc, errors, warnings };
  }

  /** Fill defaults, derive seconds from samples (or samples from seconds), drop nothing. */
  normalize(doc, sampleRate) {
    const layers = doc.layers.map(l => Object.assign(l, { kind: l.kind || 'human', color: l.color || '#3fb0ff', visible: l.visible !== false, createdAt: l.createdAt || U.nowIso() }));
    const layerIds = new Set(layers.map(l => l.id));
    const warnings = [];
    const fixPos = (p) => {
      if (!p) return null;
      if (typeof p.samples === 'number') p.seconds = p.samples / sampleRate;
      else if (typeof p.seconds === 'number') p.samples = Math.round(p.seconds * sampleRate);
      return p;
    };
    const notes = doc.notes.map(n => {
      n.start = fixPos(n.start);
      n.end = n.type === 'interval' ? fixPos(n.end) : null;
      if (n.type === 'interval' && !n.end) { n.type = 'pin'; warnings.push(`Note "${n.title || n.id}" was an interval without an end; treated as a pin.`); }
      n.title = n.title || ''; n.body = n.body || ''; n.category = n.category || 'idea'; n.tags = Array.isArray(n.tags) ? n.tags : [];
      if (n.color === undefined) n.color = null; if (n.rating === undefined) n.rating = null; n.status = n.status || 'open';
      n.createdAt = n.createdAt || U.nowIso(); n.updatedAt = n.updatedAt || n.createdAt; n.replies = Array.isArray(n.replies) ? n.replies : [];
      if (!layerIds.has(n.layerId)) { warnings.push(`Note "${n.title || n.id}" referenced missing layer ${n.layerId}; moved to the first layer.`); n.layerId = layers[0] ? layers[0].id : n.layerId; }
      return n;
    });
    const known = ['schemaVersion', 'app', 'track', 'grid', 'settings', 'layers', 'notes', 'history'];
    const extraDoc = {}; for (const k of Object.keys(doc)) if (!known.includes(k)) extraDoc[k] = doc[k];
    const knownTrack = ['fileName', 'fingerprint', 'sizeBytes', 'durationSeconds', 'sampleRate', 'channels', 'bitDepth', 'format'];
    const extraTrack = {}; for (const k of Object.keys(doc.track || {})) if (!knownTrack.includes(k)) extraTrack[k] = doc.track[k];
    return { layers, notes, extra: { doc: extraDoc, track: extraTrack }, warnings, history: Array.isArray(doc.history) ? doc.history : [] };
  }

  /* ---------- files ---------- */
  suggestedName(info) { return U.basename(info.fileName) + '.notes.json'; }

  /** Save text; returns {method:'fs'|'download', name}. forcePicker → "Save as". */
  async saveText(text, suggestedName, { forcePicker = false, types = [{ description: 'Notes JSON', accept: { 'application/json': ['.json'] } }] } = {}) {
    if (this.hasFsAccess) {
      try {
        if (!this.saveHandle || forcePicker) {
          const h = await window.showSaveFilePicker({ suggestedName, types });
          this.saveHandle = h;
        }
        const w = await this.saveHandle.createWritable();
        await w.write(text); await w.close();
        this.savedText = text;
        return { method: 'fs', name: this.saveHandle.name };
      } catch (e) {
        if (e && e.name === 'AbortError') return null;
        if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) { this.saveHandle = null; /* fall through to download */ }
        else throw e;
      }
    }
    U.downloadText(suggestedName, text, 'application/json');
    this.savedText = text;
    return { method: 'download', name: suggestedName };
  }
  /** One-off export (never reuses the notes handle) */
  async exportText(text, suggestedName, mime, ext, description) {
    if (this.hasFsAccess) {
      try {
        const h = await window.showSaveFilePicker({ suggestedName, types: [{ description, accept: { [mime]: [ext] } }] });
        const w = await h.createWritable(); await w.write(text); await w.close();
        return { method: 'fs', name: h.name };
      } catch (e) { if (e && e.name === 'AbortError') return null; }
    }
    U.downloadText(suggestedName, text, mime);
    return { method: 'download', name: suggestedName };
  }

  /** One-off binary export (WAV renders). */
  async exportBlob(blob, suggestedName, mime, ext, description) {
    if (this.hasFsAccess) {
      try { const h = await window.showSaveFilePicker({ suggestedName, types: [{ description, accept: { [mime]: [ext] } }] }); const w = await h.createWritable(); await w.write(blob); await w.close(); return { method: 'fs', name: h.name }; }
      catch (e) { if (e && e.name === 'AbortError') return null; }
    }
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = suggestedName; a.style.display = 'none'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 5000);
    return { method: 'download', name: suggestedName };
  }

  /* ---------- autosave ---------- */
  autosaveKey(fp) { return `note:autosave:${fp}`; }
  autosave(fp, text, dirty) {
    try { localStorage.setItem(this.autosaveKey(fp), JSON.stringify({ savedAt: U.nowIso(), dirty: !!dirty, text })); return true; }
    catch (e) { console.warn('autosave failed', e); return false; }
  }
  readAutosave(fp) {
    try { const raw = localStorage.getItem(this.autosaveKey(fp)); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
  }
  clearAutosave(fp) { try { localStorage.removeItem(this.autosaveKey(fp)); } catch (_) { } }
}

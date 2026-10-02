/* ai.js — AiBridge: parse/validate/import an AI response, and the optional
 * direct request to the Anthropic Messages API. The direct request sends the
 * same text bundle as the export and nothing else. */
'use strict';

const AiBridge = {
  API_URL: 'https://api.anthropic.com/v1/messages',
  KEY_STORAGE: 'note:anthropicApiKey', MODEL_STORAGE: 'note:anthropicModel',

  getKey() { try { return localStorage.getItem(this.KEY_STORAGE) || ''; } catch (_) { return ''; } },
  setKey(k) { try { if (k) localStorage.setItem(this.KEY_STORAGE, k); else localStorage.removeItem(this.KEY_STORAGE); } catch (_) { } },
  getModel() { try { return (localStorage.getItem(this.MODEL_STORAGE) || '').trim(); } catch (_) { return ''; } },
  setModel(m) { try { const v = (m || '').trim(); if (v) localStorage.setItem(this.MODEL_STORAGE, v); else localStorage.removeItem(this.MODEL_STORAGE); } catch (_) { } },

  /** Pull a JSON object out of model output that may have fences or prose around it. */
  extractJson(text) {
    if (typeof text !== 'string') throw new Error('Response is not text.');
    let t = text.trim();
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
    if (fence) t = fence[1].trim();
    if (!t.startsWith('{')) { const a = t.indexOf('{'), b = t.lastIndexOf('}'); if (a >= 0 && b > a) t = t.slice(a, b + 1); }
    return JSON.parse(t);
  },

  /**
   * Validate a parsed response against the schema plus semantic rules.
   * @returns {{errors:string[], skippable:string[], resp:object}}
   */
  validateResponse(resp, { store, duration }) {
    const errors = [], skippable = [];
    const schemaErrors = validateSchema(NOTES_SCHEMA.$defs.aiResponse, resp, NOTES_SCHEMA);
    for (const e of schemaErrors) errors.push(`${e.path}: ${e.message}`);
    // semantic checks run even when the schema failed, so the user sees every problem at once
    const noteIds = new Set(store.notes.map(n => n.id));
    if (Array.isArray(resp.replies)) resp.replies.forEach((r, i) => { if (r && typeof r.toNoteId === 'string' && !noteIds.has(r.toNoteId)) skippable.push(`replies[${i}]: no note with id "${r.toNoteId}" exists in this document`); });
    if (Array.isArray(resp.notes)) resp.notes.forEach((n, i) => {
      if (!n || typeof n !== 'object') return;
      const where = `notes[${i}]${n.title ? ` "${n.title}"` : ''}`;
      if (n.type === 'interval') {
        if (typeof n.endSeconds !== 'number') errors.push(`${where}: interval notes need endSeconds`);
        else if (typeof n.startSeconds === 'number' && n.endSeconds <= n.startSeconds) errors.push(`${where}: endSeconds (${n.endSeconds}) must be greater than startSeconds (${n.startSeconds})`);
      }
      if (typeof n.startSeconds === 'number' && n.startSeconds > duration + 0.5) skippable.push(`${where}: startSeconds ${n.startSeconds} is beyond the end of the track (${duration.toFixed(3)} s)`);
      if (typeof n.category === 'string' && !store.categories.includes(n.category)) skippable.push(`${where}: unknown category "${n.category}" (will be kept and added to the category list)`);
    });
    return { errors, skippable, resp };
  },

  /**
   * Import into a new layer. Items listed in `skip` (indices) are omitted only
   * when the user explicitly chose "import valid items only".
   */
  importResponse(resp, { store, sampleRate, duration, snapFn, model = null, requestId = null, skipInvalid = false }) {
    const noteIds = new Set(store.notes.map(n => n.id));
    const date = new Date().toISOString().slice(0, 10);
    const baseName = (resp.layerName && resp.layerName.trim()) || 'AI';
    const name = store.uniqueLayerName(model ? `${baseName} (${model}, ${date})` : `${baseName} (${date})`);
    let layer = null; const created = [], replies = [], skipped = [];
    store.commit('import AI layer', (s) => {
      layer = s.makeLayer({ name, kind: 'ai', color: s.nextLayerColor(), source: { model: model || 'pasted', requestId: requestId || U.uid('req') } });
      layer.summary = resp.summary || '';
      s.layers.push(layer);
      for (const r of (resp.replies || [])) {
        const n = s.note(r.toNoteId);
        if (!n) { skipped.push(`reply to ${r.toNoteId}`); continue; }
        const rep = { id: U.uid('r'), layerId: layer.id, body: r.body, createdAt: U.nowIso() };
        n.replies = n.replies || []; n.replies.push(rep); n.updatedAt = U.nowIso(); replies.push(rep);
      }
      for (const an of resp.notes) {
        if (an.startSeconds > duration + 0.5) { if (skipInvalid) { skipped.push(`note "${an.title}"`); continue; } }
        let startS = Math.min(duration, an.startSeconds), endS = an.type === 'interval' ? Math.min(duration, an.endSeconds) : null;
        if (snapFn) { startS = snapFn(startS); if (endS !== null) endS = snapFn(endS); if (endS !== null && endS <= startS) endS = startS + 0.001; }
        const cat = an.category || 'idea';
        if (!s.categories.includes(cat)) s.categories.push(cat);
        const tags = an.confidence ? [`ai:confidence=${an.confidence}`] : [];
        const note = s.makeNote({ layerId: layer.id, type: an.type, startSamples: Math.round(startS * sampleRate), endSamples: endS !== null ? Math.round(endS * sampleRate) : null, title: an.title, body: an.body || '', category: cat, tags });
        s.notes.push(note); created.push(note);
      }
    });
    void noteIds;
    return { layer, created, replies, skipped };
  },

  /** Direct Messages API call. Throws Error with .status on failure. */
  async request(bundleText, { apiKey, model, maxTokens = 8000, fetchImpl = (typeof fetch === 'function' ? fetch.bind(globalThis) : null), signal } = {}) {
    if (!apiKey) { const e = new Error('No API key set. Add one in Settings → AI, or use the copy-paste bundle instead.'); e.status = 0; throw e; }
    const chosen = (typeof model === 'string' ? model : this.getModel()).trim();
    if (!chosen) { const e = new Error('No model set. Type a model name in Settings, or use the copy-paste bundle.'); e.status = 0; throw e; }
    if (!fetchImpl) throw new Error('fetch is not available in this browser.');
    let res;
    try {
      res = await fetchImpl(this.API_URL, {
        method: 'POST', signal,
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model: chosen, max_tokens: maxTokens, system: 'You are a producer and mix engineer reviewing a demo bounce from text descriptors and notes. Reply with only the JSON object requested.', messages: [{ role: 'user', content: bundleText }] }),
      });
    } catch (e) { const err = new Error(`Network error: ${e.message || e}. (Offline, blocked, or CORS refused.)`); err.status = 0; throw err; }
    const text = await res.text();
    if (!res.ok) {
      let msg = text; try { const j = JSON.parse(text); msg = (j.error && (j.error.message || j.error.type)) || text; } catch (_) { }
      const err = new Error(`API error ${res.status}: ${msg}`); err.status = res.status; throw err;
    }
    let j; try { j = JSON.parse(text); } catch (e) { throw new Error('API returned something that is not JSON.'); }
    const out = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (!out) throw new Error('API returned no text content.');
    return { text: out, requestId: j.id || null, model: j.model || model, usage: j.usage || null, stopReason: j.stop_reason || null };
  },
};

/* exports.js — Markdown report, CSV markers and the AI bundle text.
 * All exporters take plain data (no DOM) so they are easy to test in Node. */
'use strict';

const Exports = {
  _bbt(grid, sec) { return grid && grid.valid ? grid.fmtBBT(sec) : ''; },
  _timeCol(grid, sec) { const b = this._bbt(grid, sec); return b ? `${U.fmtTime(sec)} (${b})` : U.fmtTime(sec); },

  /** Markdown report of visible notes grouped by layer, time order. */
  markdown({ info, grid, store, notes }) {
    const lines = [`# Notes — ${info.fileName}`, ''];
    lines.push(`- Duration: ${U.fmtTime(info.durationSeconds)} · ${info.sampleRate} Hz · ${info.channels} ch · ${info.bitDepth}-bit ${info.format}`);
    if (grid && grid.valid) lines.push(`- Grid: ${grid.bpm} BPM, ${grid.num}/${grid.den}, bar 1 at ${U.fmtTime(grid.offset)}`);
    lines.push(`- Exported: ${U.nowIso()}`, `- Fingerprint: \`${info.fingerprint}\``, '');
    const byLayer = new Map();
    for (const n of notes) { if (!byLayer.has(n.layerId)) byLayer.set(n.layerId, []); byLayer.get(n.layerId).push(n); }
    for (const layer of store.layers) {
      const ns = byLayer.get(layer.id); if (!ns || !ns.length) continue;
      lines.push(`## ${layer.name} (${ns.length} note${ns.length === 1 ? '' : 's'})`, '');
      if (layer.summary) lines.push(`> ${String(layer.summary).replace(/\n/g, '\n> ')}`, '');
      for (const n of ns) {
        const when = n.type === 'interval' ? `${this._timeCol(grid, n.start.seconds)} → ${this._timeCol(grid, n.end.seconds)}` : this._timeCol(grid, n.start.seconds);
        const meta = [n.category, n.status !== 'open' ? n.status : null, n.rating ? '★'.repeat(n.rating) : null, ...(n.tags || []).map(t => `#${t}`)].filter(Boolean).join(' · ');
        lines.push(`### ${n.type === 'interval' ? '⟷' : '📍'} ${n.title || '(untitled)'}`, `*${when}*${meta ? ` — ${meta}` : ''}`, '');
        if (n.body) lines.push(n.body, '');
        for (const r of (n.replies || [])) { const rl = store.layer(r.layerId); lines.push(`> **${rl ? rl.name : r.layerId}:** ${String(r.body).replace(/\n/g, '\n> ')}`, ''); }
      }
    }
    return lines.join('\n');
  },

  /** CSV of markers for recreating them in Pro Tools by hand. */
  csv({ grid, store, notes }) {
    const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const rows = [['name', 'start_seconds', 'end_seconds', 'start_bar_beat', 'end_bar_beat', 'layer', 'category'].join(',')];
    for (const n of notes) {
      const layer = store.layer(n.layerId);
      rows.push([esc(n.title || ''), n.start.seconds.toFixed(3), n.end ? n.end.seconds.toFixed(3) : '', this._bbt(grid, n.start.seconds), n.end ? this._bbt(grid, n.end.seconds) : '', esc(layer ? layer.name : n.layerId), esc(n.category)].join(','));
    }
    return rows.join('\n') + '\n';
  },

  /** The text-only bundle pasted into a model. Descriptor table is compact and rounded. */
  aiBundle({ info, grid, store, notes, analysis, schema }) {
    const L = [];
    L.push('# Note — AI review request', '');
    L.push('## Instructions', '');
    L.push('You are a producer and mix engineer studying a demo bounce. You cannot hear the audio: everything you know comes from the metadata, the numeric descriptors and the human notes below. Where you are inferring rather than observing, say so and set `confidence` accordingly.', '');
    L.push('Please:', '',
      '1. Read the human notes. Reply to a note (using its exact `id` in `toNoteId`) wherever you agree, disagree or can add something concrete.',
      '2. Add your own notes — `pin` notes for moments, `interval` notes for sections — about structure, arrangement, dynamics, mix balance and edit suggestions, grounded in the descriptor table and the human notes. Use the bar numbers and seconds from the table; intervals must have `endSeconds` greater than `startSeconds`.',
      '3. Keep titles short (a few words) and bodies specific: what, where, why, what to try.',
      '4. Use categories from this list only: ' + store.categories.join(', ') + '.',
      '5. Output ONLY the JSON object described at the end — no prose, no Markdown fences.', '');
    L.push('## Track', '');
    L.push(`- File: ${info.fileName}`, `- Duration: ${U.fmtTime(info.durationSeconds)} (${info.durationSeconds.toFixed(3)} s)`, `- Format: ${info.sampleRate} Hz, ${info.channels} channel(s), ${info.bitDepth}-bit ${info.format}`, `- Fingerprint: ${info.fingerprint}`);
    if (grid && grid.valid) L.push(`- Tempo grid: ${grid.bpm} BPM, ${grid.num}/${grid.den}, bar 1 starts at ${grid.offset.toFixed(3)} s; one bar = ${grid.barSeconds.toFixed(3)} s. Positions below are written as bar|beat|ticks (960 ticks per quarter note).`);
    else L.push('- Tempo grid: not set (positions are in seconds only).');
    L.push('', '## Human notes (time order)', '');
    if (!notes.length) L.push('_No notes yet._');
    for (const n of notes) {
      const layer = store.layer(n.layerId);
      const when = n.type === 'interval' ? `${n.start.seconds.toFixed(3)}–${n.end.seconds.toFixed(3)} s${grid && grid.valid ? ` (${grid.fmtBBT(n.start.seconds)} – ${grid.fmtBBT(n.end.seconds)})` : ''}` : `${n.start.seconds.toFixed(3)} s${grid && grid.valid ? ` (${grid.fmtBBT(n.start.seconds)})` : ''}`;
      L.push(`- **${n.title || '(untitled)'}** — id \`${n.id}\`, ${n.type}, ${when}, category ${n.category}, status ${n.status}${n.rating ? `, rating ${n.rating}/5` : ''}${(n.tags || []).length ? `, tags ${n.tags.join(' ')}` : ''}, layer "${layer ? layer.name : n.layerId}"`);
      if (n.body) L.push(`  ${String(n.body).replace(/\n/g, '\n  ')}`);
      for (const r of (n.replies || [])) { const rl = store.layer(r.layerId); L.push(`  - reply from "${rl ? rl.name : r.layerId}": ${String(r.body).replace(/\n/g, ' ')}`); }
    }
    L.push('', '## Descriptors', '');
    if (analysis && analysis.rows && analysis.rows.length) {
      const g = analysis.global;
      L.push(`Global: integrated RMS ${g.integratedRmsDb.toFixed(1)} dBFS, peak ${g.peakDb.toFixed(1)} dBFS, crest factor ${g.crestFactorDb.toFixed(1)} dB.`);
      L.push(`Loudest ${analysis.unit}s: ${g.loudest.map(r => `${r.label} (${r.rmsDb.toFixed(1)})`).join(', ')}.`);
      L.push(`Quietest ${analysis.unit}s: ${g.quietest.map(r => `${r.label} (${r.rmsDb.toFixed(1)})`).join(', ')}.`, '');
      L.push(`Per-${analysis.unit} table. Columns: ${analysis.unit}, start seconds, RMS dBFS, peak dBFS, low (<150 Hz) dB, mid (150 Hz–2 kHz) dB, high (>2 kHz) dB, onsets (count of spectral-flux peaks). Values are averages over the ${analysis.unit}; -100 means silence.`, '');
      L.push('```', `${analysis.unit},start_s,rms,peak,low,mid,high,onsets`);
      const rows = analysis.rows.filter(r => !r.empty);
      const step = rows.length > 400 ? Math.ceil(rows.length / 400) : 1;   // keep the bundle readable for very long or ungridded tracks
      for (let i = 0; i < rows.length; i += step) {
        const r = rows[i];
        L.push(`${r.label},${r.t0.toFixed(2)},${r.rmsDb.toFixed(1)},${r.peakDb.toFixed(1)},${r.lowDb.toFixed(1)},${r.midDb.toFixed(1)},${r.highDb.toFixed(1)},${r.onsets}`);
      }
      L.push('```');
      if (step > 1) L.push('', `(Every ${step}th ${analysis.unit} shown to keep this short.)`);
    } else L.push('_Descriptors were not available when this bundle was exported._');
    L.push('', '## Response format', '');
    L.push('Return exactly one JSON object with this shape (JSON Schema: `$defs/aiResponse` in notes.schema.json):', '');
    L.push('```json', JSON.stringify({
      layerName: 'AI v1',
      summary: 'Three or four sentences on the track\'s structure and the biggest opportunities.',
      replies: [{ toNoteId: notes[0] ? notes[0].id : 'n_example', body: 'Agree / disagree / addition, specific to that note.' }],
      notes: [
        { type: 'pin', startSeconds: 88.9, title: 'short title', body: 'specific body', category: 'structure', confidence: 'medium' },
        { type: 'interval', startSeconds: 140.0, endSeconds: 180.0, title: 'short title', body: 'specific body', category: 'loop', confidence: 'low' },
      ],
    }, null, 2), '```', '');
    L.push('Rules: `confidence` is one of low | medium | high. `startSeconds`/`endSeconds` are seconds from the start of the file (0 ≤ t ≤ ' + info.durationSeconds.toFixed(3) + '). `category` must be one of the listed categories. `toNoteId` must be an id from the human notes above. Output only the JSON.');
    if (schema) { void schema; }
    return L.join('\n') + '\n';
  },
};

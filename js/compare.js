/* compare.js — Compare: my ratings vs imported ratings. Per-loop Δ (mine minus
 * the imported score on one 0–10 axis; my control stops at 9.9, an imported
 * score can reach 10.0), Spearman ρ and mean |Δ| over the rated loops, the ten
 * biggest disagreements each way, agreement by length and by section, and a
 * scatter plot. Variants get a second point against the imported own-pattern
 * score. Only shown when revealed. */
'use strict';

const Compare = {
  rank(values) { const idx = values.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(values.length); let i = 0; while (i < idx.length) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; } return r; },
  spearman(xs, ys) { const n = xs.length; if (n < 3) return null; const rx = this.rank(xs), ry = this.rank(ys); const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n; let num = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; } return dx && dy ? +(num / Math.sqrt(dx * dy)).toFixed(3) : null; },
  stats(loops, ctx) {
    const pairs = [];
    for (const l of loops) { const r = ctx.rec(l); if (!r || l.rating === null || l.rating === undefined) continue; const claude = typeof r.score === 'number' ? r.score : null; const own = typeof r.ownPattern === 'number' ? r.ownPattern : null; const ref = claude !== null ? claude : own; if (ref === null) continue; pairs.push({ id: l.id, mine: l.rating, claude, own, delta: +(l.rating - ref).toFixed(2), basis: claude !== null ? 'score' : 'ownPattern', length: Ranking.lengthKey(l), section: r.section || '', blind: l.blind !== false, ptStart: l.ptStart }); }
    const xs = pairs.map(p => p.mine), ys = pairs.map(p => p.claude !== null ? p.claude : p.own);
    const agg = (key) => { const g = {}; for (const p of pairs) { const k = p[key] || '(none)'; const b = g[k] = g[k] || { n: 0, sumD: 0, sumAbs: 0 }; b.n++; b.sumD += p.delta; b.sumAbs += Math.abs(p.delta); } for (const k of Object.keys(g)) { g[k].meanDelta = +(g[k].sumD / g[k].n).toFixed(2); g[k].meanAbsDelta = +(g[k].sumAbs / g[k].n).toFixed(2); delete g[k].sumD; delete g[k].sumAbs; } return g; };
    const byDelta = pairs.slice().sort((a, b) => b.delta - a.delta);
    return { n: pairs.length, spearman: this.spearman(xs, ys), meanAbsDelta: pairs.length ? +(pairs.reduce((s, p) => s + Math.abs(p.delta), 0) / pairs.length).toFixed(2) : null, meanDelta: pairs.length ? +(pairs.reduce((s, p) => s + p.delta, 0) / pairs.length).toFixed(2) : null, perLoop: pairs, byLength: agg('length'), bySection: agg('section'), biggestMineHigher: byDelta.filter(p => p.delta > 0).slice(0, 10), biggestClaudeHigher: byDelta.filter(p => p.delta < 0).slice(-10).reverse(), blindShare: pairs.length ? +(pairs.filter(p => p.blind).length / pairs.length).toFixed(2) : null };
  },
  drawScatter(canvas, st, lab) {
    const dpr = window.devicePixelRatio || 1; const r = canvas.getBoundingClientRect(); const w = Math.max(10, Math.round(r.width)), h = Math.max(10, Math.round(r.height));
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#0b0d11'; ctx.fillRect(0, 0, w, h);
    const pad = 30; const X = (v) => pad + v / 10 * (w - pad - 10), Y = (v) => h - pad + 4 - v / 10 * (h - pad - 6);
    ctx.strokeStyle = 'rgba(255,255,255,0.12)'; ctx.lineWidth = 1; for (let v = 0; v <= 10; v += 2) { ctx.beginPath(); ctx.moveTo(X(v), Y(0)); ctx.lineTo(X(v), Y(10)); ctx.stroke(); ctx.beginPath(); ctx.moveTo(X(0), Y(v)); ctx.lineTo(X(10), Y(v)); ctx.stroke(); }
    ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(X(0), Y(0)); ctx.lineTo(X(10), Y(10)); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#8b95a5'; ctx.font = '10px ui-monospace, monospace'; ctx.textBaseline = 'top'; ctx.fillText('mine →', X(7.5), h - 12); ctx.save(); ctx.translate(8, Y(7)); ctx.rotate(-Math.PI / 2); ctx.fillText('imported →', 0, 0); ctx.restore(); for (let v = 0; v <= 10; v += 2) { ctx.fillText(String(v), X(v) - 3, h - 22); ctx.fillText(String(v), 14, Y(v) - 5); }
    const col = { '2': '#3fb0ff', '4': '#8ee66b', '8': '#ffb03f', event: '#ff6fa8' };
    canvas._points = [];
    for (const p of st.perLoop) { const c = col[p.length] || '#ccc'; if (p.claude !== null) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(X(p.mine), Y(p.claude), 4, 0, Math.PI * 2); ctx.fill(); canvas._points.push({ x: X(p.mine), y: Y(p.claude), p }); } if (p.own !== null) { ctx.strokeStyle = c; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(X(p.mine), Y(p.own), 4.5, 0, Math.PI * 2); ctx.stroke(); canvas._points.push({ x: X(p.mine), y: Y(p.own), p, own: true }); } }
    let lx = w - 150; ctx.textBaseline = 'middle'; for (const [k, c] of Object.entries(col)) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(lx, 10, 4, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#8b95a5'; ctx.fillText(k === 'event' ? 'event' : k + ' bar', lx + 7, 10); lx += k === 'event' ? 0 : 40; }
    ctx.fillStyle = '#8b95a5'; ctx.fillText('○ = own-pattern score (variants)', 34, 10);
    void lab;
  },
  html(st, lab) {
    if (!st.n) return '<p class="muted">Rate some loops first — the comparison needs loops with both ratings.</p>';
    const row = (p) => `<tr><td>${U.escapeHtml(p.id)}</td><td class="num">${p.mine.toFixed(1)}</td><td class="num">${p.claude !== null ? p.claude.toFixed(1) : `<i>${p.own.toFixed(1)}*</i>`}</td><td class="num ${p.delta > 0 ? 'warn' : 'good'}">${p.delta > 0 ? '+' : ''}${p.delta.toFixed(1)}</td><td class="muted">${U.escapeHtml(p.section)}</td><td class="muted">${p.blind ? 'blind' : 'seen'}</td></tr>`;
    const agg = (g) => Object.entries(g).map(([k, v]) => `<tr><td>${U.escapeHtml(k)}</td><td class="num">${v.n}</td><td class="num">${v.meanDelta > 0 ? '+' : ''}${v.meanDelta.toFixed(2)}</td><td class="num">${v.meanAbsDelta.toFixed(2)}</td></tr>`).join('');
    return `<p class="small">One axis, 0–10: my control stops at 9.9, an imported rating can reach 10.0. ${st.n} loops with both ratings (${Math.round((st.blindShare || 0) * 100)} % rated blind) · Spearman ρ <b>${st.spearman === null ? '—' : st.spearman}</b> · mean |Δ| <b>${st.meanAbsDelta}</b> · mean Δ (mine − imported) <b>${st.meanDelta > 0 ? '+' : ''}${st.meanDelta}</b>. * = own-pattern score (variant with no main score).</p>
      <canvas id="cmpScatter" class="cmp-scatter"></canvas>
      <div class="cmp-cols"><div><h4>I rate higher</h4><table class="cues"><tr><th>loop</th><th>mine</th><th>imported</th><th>Δ</th><th>section</th><th></th></tr>${st.biggestMineHigher.map(row).join('')}</table></div>
      <div><h4>Imported rates higher</h4><table class="cues"><tr><th>loop</th><th>mine</th><th>imported</th><th>Δ</th><th>section</th><th></th></tr>${st.biggestClaudeHigher.map(row).join('')}</table></div></div>
      <div class="cmp-cols"><div><h4>By length</h4><table class="cues"><tr><th>length</th><th>n</th><th>mean Δ</th><th>mean |Δ|</th></tr>${agg(st.byLength)}</table></div><div><h4>By section</h4><table class="cues"><tr><th>section</th><th>n</th><th>mean Δ</th><th>mean |Δ|</th></tr>${agg(st.bySection)}</table></div></div>`;
  },
};

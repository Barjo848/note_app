/* util.js — small helpers shared by every module. No DOM framework, no deps. */
'use strict';

const U = {
  clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; },
  lerp(a, b, t) { return a + (b - a) * t; },

  /** seconds → "mm:ss.mmm" (hours fold into minutes, Pro Tools style) */
  fmtTime(sec, ms = true) {
    if (!isFinite(sec)) return ms ? '--:--.---' : '--:--';
    const neg = sec < 0; sec = Math.abs(sec);
    const whole = Math.floor(sec);
    const m = Math.floor(whole / 60), s = whole % 60;
    const milli = Math.floor((sec - whole) * 1000 + 1e-6);
    const base = `${neg ? '-' : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return ms ? `${base}.${String(milli).padStart(3, '0')}` : base;
  },

  /** "1:23.456", "83.4", "83" → seconds (used by numeric inputs) */
  parseTime(str) {
    if (typeof str !== 'string') return NaN;
    str = str.trim();
    if (!str) return NaN;
    const parts = str.split(':');
    if (parts.length === 1) return parseFloat(parts[0]);
    let sec = 0;
    for (const p of parts) sec = sec * 60 + parseFloat(p || '0');
    return sec;
  },

  fmtBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  },

  /** linear amplitude/power → dB, floored so log10(0) never appears */
  ampDb(a) { return a <= 1e-10 ? -100 : Math.max(-100, 20 * Math.log10(a)); },
  powDb(p) { return p <= 1e-20 ? -100 : Math.max(-100, 10 * Math.log10(p)); },

  nowIso() { return new Date().toISOString(); },

  /** ids: "<prefix>_<time36><random>" — sortable-ish and collision-safe */
  uid(prefix) {
    const rnd = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : Math.random().toString(36).slice(2, 14);
    return `${prefix}_${Date.now().toString(36)}${rnd}`;
  },

  deepClone(v) { return (typeof structuredClone === 'function') ? structuredClone(v) : JSON.parse(JSON.stringify(v)); },

  debounce(fn, ms) {
    let t = null;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(this, args); }, ms);
    };
  },

  /* --- DOM --- */
  $(sel, root = document) { return root.querySelector(sel); },
  $$(sel, root = document) { return Array.from(root.querySelectorAll(sel)); },
  el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(e.dataset, v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  },
  escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  },

  /** True when the keyboard focus is in a place where typing should not trigger shortcuts */
  isTypingTarget(t) {
    if (!t || !(t instanceof Element)) return false;
    if (t.isContentEditable) return true;
    const tag = t.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const ty = (t.getAttribute('type') || 'text').toLowerCase();
      return !['button', 'checkbox', 'radio', 'range', 'file', 'submit', 'reset', 'color'].includes(ty);
    }
    return false;
  },

  /** Browser download of a text blob; used as the save fallback everywhere. */
  downloadText(fileName, text, mime = 'application/octet-stream') {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = fileName; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
  },

  basename(name) { return String(name).replace(/\.[^.]+$/, ''); },

  /** Contrast text colour (black / white) for a hex background */
  textOn(hex) {
    const c = U.hexToRgb(hex); if (!c) return '#fff';
    const l = (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255;
    return l > 0.6 ? '#111' : '#fff';
  },
  hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  },
  rgba(hex, a) { const c = U.hexToRgb(hex) || [128, 128, 128]; return `rgba(${c[0]},${c[1]},${c[2]},${a})`; },

  /** Pure-JS SHA-256 (fallback when crypto.subtle is unavailable). Returns hex. */
  sha256Hex(bytes) {
    const K = new Uint32Array([0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2]);
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const len = bytes.length, bitLen = len * 8;
    const padLen = ((len + 9 + 63) >> 6) << 6;
    const msg = new Uint8Array(padLen); msg.set(bytes); msg[len] = 0x80;
    const dv = new DataView(msg.buffer);
    dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000)); dv.setUint32(padLen - 4, bitLen >>> 0);
    const W = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < padLen; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, h] = H;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
    }
    return Array.from(H, x => (x >>> 0).toString(16).padStart(8, '0')).join('');
  },

  async sha256HexAsync(bytes) {
    try {
      if (typeof crypto !== 'undefined' && crypto.subtle) {
        const d = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(d), b => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (_) { /* fall through */ }
    return U.sha256Hex(bytes);
  },
};

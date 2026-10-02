/* transport.js — Transport: playback via an <audio> element that streams the
 * File through an object URL. The file is never decoded into memory here.
 * Loop boundaries are enforced from a requestAnimationFrame tick because
 * `timeupdate` only fires a few times per second. */
'use strict';

class Transport {
  constructor(audioEl) {
    this.audio = audioEl;
    this.audio.preload = 'auto';
    this.url = null; this.duration = 0;
    this.loop = null;               // {start, end} seconds
    this.returnPos = 0;             // where Enter (stop) returns to
    this.handlers = {};
    this._tick = this._tick.bind(this);
    this._raf = null;
    this.setRate(1);
    audioEl.addEventListener('play', () => { this._startTick(); this._emit('playState', true); });
    audioEl.addEventListener('pause', () => { this._stopTick(); this._emit('playState', false); this._emit('time', this.currentTime); });
    audioEl.addEventListener('ended', () => { this._stopTick(); this._emit('playState', false); });
    audioEl.addEventListener('loadedmetadata', () => { this._emit('meta', this.audio.duration); });
    audioEl.addEventListener('error', () => { if (!this.url) return; const e = this.audio.error; this._emit('error', e ? `Audio error (code ${e.code}): ${e.message || 'the browser could not play this file'}` : 'Audio error'); });
    audioEl.addEventListener('seeked', () => this._emit('time', this.currentTime));
  }
  on(name, fn) { this.handlers[name] = fn; return this; }
  _emit(name, ...a) { const h = this.handlers[name]; if (h) h(...a); }

  load(file, durationHint) {
    this.unload();
    this.url = URL.createObjectURL(file); this.audio.preload = 'auto';
    this.duration = durationHint || 0;
    this.audio.src = this.url;
    this.audio.load();
    this.returnPos = 0; this.loop = null;
  }
  loadURL(url, durationHint) {
    const target = new URL(url, location.origin);
    if (target.origin !== location.origin) throw new Error('Audio must use the current host.');
    this.unload(); this.url = target.href; this.remote = true;
    this.duration = durationHint || 0; this.audio.preload = 'metadata';
    this.audio.src = this.url; this.audio.load(); this.returnPos = 0; this.loop = null;
  }
  unload() { try { this.audio.pause(); } catch (_) { } if (this.url) { if (!this.remote) URL.revokeObjectURL(this.url); this.url = null; } this.remote = false; this.audio.removeAttribute('src'); this._stopTick(); }
  get loaded() { return !!this.url; }
  get playing() { return !!this.url && !this.audio.paused && !this.audio.ended; }
  get currentTime() { return this.audio.currentTime || 0; }
  get effectiveDuration() { return isFinite(this.audio.duration) && this.audio.duration > 0 ? this.audio.duration : this.duration; }

  async play() {
    if (!this.url) return;
    if (this.loop && (this.currentTime < this.loop.start || this.currentTime >= this.loop.end)) this.seek(this.loop.start);
    this.returnPos = this.currentTime;
    try { await this.audio.play(); } catch (e) { this._emit('error', 'Playback was blocked: ' + (e.message || e)); }
  }
  pause() { if (this.url) this.audio.pause(); }
  toggle() { return this.playing ? this.pause() : this.play(); }
  /** stop and return to where playback last started */
  stop() { if (!this.url) return; this.audio.pause(); this.seek(this.returnPos); }
  seek(sec) {
    if (!this.url) return;
    const d = this.effectiveDuration || Infinity;
    const t = U.clamp(sec, 0, d);
    try { this.audio.currentTime = t; } catch (_) { }
    this._emit('time', t);
  }
  nudge(dSec) { this.seek(this.currentTime + dSec); }
  setRate(r) { this.audio.preservesPitch = true; this.audio.mozPreservesPitch = true; this.audio.webkitPreservesPitch = true; this.audio.playbackRate = U.clamp(r, 0.25, 4); }
  setVolume(v) { this.audio.volume = U.clamp(v, 0, 1); }
  setLoop(region) { this.loop = region && region.end > region.start ? { start: region.start, end: region.end } : null; this._emit('loop', this.loop); }

  _startTick() { if (this._raf === null) this._raf = requestAnimationFrame(this._tick); }
  _stopTick() { if (this._raf !== null) { cancelAnimationFrame(this._raf); this._raf = null; } }
  _tick() {
    this._raf = null;
    if (!this.playing) return;
    const t = this.currentTime;
    if (this.loop && t >= this.loop.end - 0.005) { this.audio.currentTime = this.loop.start; }
    this._emit('time', this.currentTime);
    this._raf = requestAnimationFrame(this._tick);
  }
}

/* grid.js — Grid: tempo/meter maths.
 *
 * Positions are converted through quarter notes:
 *   quarters(t) = (t − bar1Offset) · bpm / 60
 * A beat is one (4/denominator) quarter note, so beats = quarters · den / 4.
 * Ticks are 960 per quarter note (Pro Tools), which makes 960·4/den per beat.
 * Bars count from 1 at the offset; times before it give bar ≤ 0, as Pro
 * Tools would show negative bars. */
'use strict';

class Grid {
  constructor({ bpm = 108, meterNumerator = 4, meterDenominator = 4, bar1OffsetSeconds = 0, ticksPerQuarter = 960, enabled = true } = {}) {
    this.bpm = bpm; this.num = meterNumerator; this.den = meterDenominator;
    this.offset = bar1OffsetSeconds; this.tpq = ticksPerQuarter; this.enabled = enabled;
  }
  toJSON() { return { bpm: this.bpm, meterNumerator: this.num, meterDenominator: this.den, bar1OffsetSeconds: this.offset, ticksPerQuarter: this.tpq }; }
  static fromJSON(j) { return new Grid(j ? { bpm: j.bpm, meterNumerator: j.meterNumerator, meterDenominator: j.meterDenominator, bar1OffsetSeconds: j.bar1OffsetSeconds, ticksPerQuarter: j.ticksPerQuarter } : {}); }

  get valid() { return this.enabled && this.bpm > 0 && this.num > 0 && this.den > 0; }
  get beatSeconds() { return (60 / this.bpm) * (4 / this.den); }
  get barSeconds() { return this.beatSeconds * this.num; }
  get ticksPerBeat() { return this.tpq * 4 / this.den; }

  /** seconds → floating beats from bar 1 */
  beatsAt(sec) { return (sec - this.offset) / this.beatSeconds; }
  secondsAtBeats(beats) { return this.offset + beats * this.beatSeconds; }

  /** seconds → {bar, beat, ticks} (1-based bar/beat; ticks rounded) */
  bbt(sec) {
    if (!this.valid) return null;
    let beats = this.beatsAt(sec);
    // round to the nearest tick first so 41|1|000 never shows as 40|4|959.99…
    const tpb = this.ticksPerBeat;
    let totalTicks = Math.round(beats * tpb);
    const ticksPerBar = tpb * this.num;
    const barIdx = Math.floor(totalTicks / ticksPerBar);
    const rem = totalTicks - barIdx * ticksPerBar;
    const beatIdx = Math.floor(rem / tpb);
    const ticks = rem - beatIdx * tpb;
    return { bar: barIdx + 1, beat: beatIdx + 1, ticks: Math.round(ticks) };
  }
  fmtBBT(sec, withTicks = true) {
    const b = this.bbt(sec); if (!b) return '';
    return withTicks ? `${b.bar}|${b.beat}|${String(b.ticks).padStart(3, '0')}` : `${b.bar}|${b.beat}`;
  }
  /** {bar, beat, ticks} → seconds */
  secondsAt(bar, beat = 1, ticks = 0) {
    const beats = (bar - 1) * this.num + (beat - 1) + ticks / this.ticksPerBeat;
    return this.secondsAtBeats(beats);
  }
  /** parse "41|1|000", "41|1", "41" → seconds (null if invalid) */
  parseBBT(str) {
    const m = /^\s*(-?\d+)(?:\s*[|.:]\s*(\d+))?(?:\s*[|.:]\s*(\d+))?\s*$/.exec(str || '');
    if (!m) return null;
    return this.secondsAt(parseInt(m[1], 10), m[2] ? parseInt(m[2], 10) : 1, m[3] ? parseInt(m[3], 10) : 0);
  }

  /** snap seconds to nearest bar / beat / sub-beat ('bar','beat','8th','16th'); returns seconds */
  snap(sec, mode) {
    if (!this.valid || !mode || mode === 'off') return sec;
    // unit in beats: bar → num beats; beat → 1; 8th → half a quarter note; 16th → a quarter of one
    let unitBeats;
    if (mode === 'bar') unitBeats = this.num;
    else if (mode === 'beat') unitBeats = 1;
    else if (mode === '8th') unitBeats = (this.den / 4) / 2;
    else if (mode === '16th') unitBeats = (this.den / 4) / 4;
    else return sec;
    const beats = this.beatsAt(sec);
    return this.secondsAtBeats(Math.round(beats / unitBeats) * unitBeats);
  }

  /** Enumerate grid lines between t0..t1 for rulers: returns [{sec, bar, beat, isBar}] limited to `max` items */
  lines(t0, t1, includeBeats, max = 4000) {
    const out = [];
    if (!this.valid) return out;
    const step = includeBeats ? 1 : this.num;
    let b = Math.floor(this.beatsAt(t0) / step) * step;
    for (let i = 0; i < max; i++, b += step) {
      const sec = this.secondsAtBeats(b);
      if (sec > t1) break;
      if (sec < t0) continue;
      const barIdx = Math.floor(b / this.num + 1e-9);
      const beatIdx = Math.round(b - barIdx * this.num);
      out.push({ sec, bar: barIdx + 1, beat: beatIdx + 1, isBar: beatIdx === 0 });
    }
    return out;
  }
}

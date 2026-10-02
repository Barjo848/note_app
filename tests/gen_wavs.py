#!/usr/bin/env python3
"""Generate synthetic WAV fixtures with the Python standard library only.

  /usr/bin/python3 tests/gen_wavs.py [--small] [--out DIR] [--loops-only]

Default output is tests/fixtures/. --small writes a 120 s stand-in for the
10-minute file. --loops-only writes the Loop Lab and six-loop library fixtures.

  synth_10min_48k_st24.wav   10 min, 48 kHz, stereo, 24-bit PCM. Clicks on every
                             beat at 108 BPM (accent on downbeats) plus periodic
                             noise bursts and a quiet bass tone so every bar has
                             measurable energy. A click sits exactly at 60.000 s.
  synth_1min_48k_st_f32.wav  1 min, 48 kHz, stereo, 32-bit float (EXTENSIBLE fmt,
                             with 'fact' and 'LIST' chunks and an odd-sized chunk
                             with a pad byte).
  synth_30s_441k_mono16.wav  30 s, 44.1 kHz, mono, 16-bit PCM.
  synth_2s_48k_st24.wav      2 s, 48 kHz, stereo, 24-bit.
  synth_10s_96k_st24.wav     10 s, 96 kHz, stereo, 24-bit.
  bad_header.wav             RIFF/WAVE with no fmt chunk (must fail readably).
  not_a_wav.wav              random bytes.

Loop Lab fixtures (tests/fixtures/loops/), 2 bars at 108 BPM, 48 kHz, stereo, 24-bit,
213333 frames each, with synthesised kick / snare / hat. Pattern per bar (16ths):
hat 0,2,4,…,14; kick 0, 2, 8; snare 4, 11, 12.
Fixed signature: snare pos 11 at +24 ms, kick pos 2 at −6 ms, everything else 0.
  tight.wav      every hit on the signature
  feel.wav       snares a further +18 ms behind, hats +12 ms
  mistakes.wav   bar 1 snare 2 at +45 ms; bar 1 kick 3 flammed; bar 2 kick 3 missing;
                 bar 2 snare 2 9 dB quieter
  pushed.wav     tight, plus the next downbeat kick starting 10 ms before the loop end
  tight_KICK.wav / tight_SNARE.wav / tight_HIHAT.wav   stems of tight.wav
"""
import array, json, math, os, random, struct, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'fixtures')
BPM = 108.0

def chunk(cid, payload):
    assert len(cid) == 4
    pad = b'\x00' if len(payload) % 2 else b''
    return cid + struct.pack('<I', len(payload)) + payload + pad

def fmt_chunk(channels, sr, bits, fmt_tag, extensible=False):
    block = channels * bits // 8
    base = struct.pack('<HHIIHH', 0xFFFE if extensible else fmt_tag, channels, sr, sr * block, block, bits)
    if extensible:
        guid = struct.pack('<H', fmt_tag) + bytes.fromhex('0000' '0000' '0010' '8000' '00aa00389b71')
        base += struct.pack('<HHI', 22, bits, 0x3 if channels == 2 else 0x4) + guid
    return chunk(b'fmt ', base)

def _clip_sample(v, scale, lo, hi):
    s = int(round(v * scale))
    if s > hi: return hi
    if s < lo: return lo
    return s

def _pack(channels, bits, fmt):
    ch = len(channels)
    frames = len(channels[0])
    if fmt == 'float':
        payload = bytearray(frames * ch * 4)
        o = 0
        for i in range(frames):
            for c in range(ch):
                struct.pack_into('<f', payload, o, channels[c][i])
                o += 4
        return payload
    if bits == 16:
        payload = bytearray(frames * ch * 2)
        o = 0
        for i in range(frames):
            for c in range(ch):
                struct.pack_into('<h', payload, o, _clip_sample(channels[c][i], 32767.0, -32768, 32767))
                o += 2
        return payload
    if bits == 24:
        payload = bytearray(frames * ch * 3)
        o = 0
        for i in range(frames):
            for c in range(ch):
                s = _clip_sample(channels[c][i], 8388607.0, -8388608, 8388607)
                payload[o] = s & 0xFF
                payload[o + 1] = (s >> 8) & 0xFF
                payload[o + 2] = (s >> 16) & 0xFF
                o += 3
        return payload
    raise ValueError(bits)

def write_wav(path, channels, sr, bits, fmt='pcm', extra_chunks=False):
    """channels: list of float sample arrays in ±1, one per channel."""
    frames = len(channels[0])
    nch = len(channels)
    payload = _pack(channels, bits, fmt)
    body = b'WAVE'
    if extra_chunks:
        body += chunk(b'JUNK', b'\x00' * 28)
    body += fmt_chunk(nch, sr, bits, 3 if fmt == 'float' else 1, extensible=(fmt == 'float' or extra_chunks))
    if fmt == 'float' or extra_chunks:
        body += chunk(b'fact', struct.pack('<I', frames))
    if extra_chunks:
        info = b'INFO' + chunk(b'ISFT', b'gen_wavs.py')  # 11 bytes → odd → pad byte exercised
        body += chunk(b'LIST', info)
        body += chunk(b'odd_', b'abc')
    body += chunk(b'data', payload)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', len(body)) + body)
    print('wrote %s  %.3f s  %d Hz  %d ch  %d-bit %s  %.1f MB' % (
        os.path.basename(path), frames / sr, sr, nch, bits, fmt, os.path.getsize(path) / 1e6))

def _zeros(n):
    return array.array('f', [0.0]) * n

def _clip_into(buf):
    for i, v in enumerate(buf):
        if v > 1.0: buf[i] = 1.0
        elif v < -1.0: buf[i] = -1.0

def click_track(seconds, sr, bpm=BPM, bursts=True, stereo=True, seed=1):
    rng = random.Random(seed)
    n = int(seconds * sr)
    ch = 2 if stereo else 1
    beat = 60.0 / bpm
    out = [_zeros(n) for _ in range(ch)]
    click_len = int(0.004 * sr)
    click = array.array('f')
    for i in range(click_len):
        t = i / sr
        click.append(math.sin(2 * math.pi * 2000 * t) * math.exp(-t * 900))
    k = 0
    while True:
        pos = int(round(k * beat * sr))
        if pos + click_len > n: break
        amp = 0.9 if k % 4 == 0 else 0.5
        for c in range(ch):
            buf = out[c]
            for i in range(click_len):
                buf[pos + i] += click[i] * amp
        k += 1
    for i in range(n):
        v = 0.03 * math.sin(2 * math.pi * 55 * (i / sr))
        for c in range(ch):
            out[c][i] += v
    if bursts:
        bar = beat * 4
        b = 0
        while (b * 8 * bar + 0.2) < seconds:
            s = int(b * 8 * bar * sr) + int(0.5 * beat * sr)
            e = min(n, s + int(0.2 * sr))
            for i in range(s, e):
                for c in range(ch):
                    out[c][i] += rng.gauss(0.0, 1.0) * 0.25
            b += 1
        for sec in range(0, int(seconds), 128):
            s, e = int((sec + 100) * sr), min(n, int((sec + 110) * sr))
            for c in range(ch):
                buf = out[c]
                for i in range(s, e):
                    buf[i] *= 0.2
    for buf in out:
        _clip_into(buf)
    return out

# ---------------------------------------------------------------- Loop Lab fixtures
LOOP_SR = 48000
LOOP_FRAMES = 213333
SIXTEENTH = 60.0 / BPM / 4
SIG = {('snare', 11): 24.0, ('kick', 2): -6.0}
PATTERN = {'hat': [0, 2, 4, 6, 8, 10, 12, 14], 'kick': [0, 2, 8], 'snare': [4, 11, 12]}

def kick_sound(sr, amp=0.8, seed=0):
    n = int(0.18 * sr)
    buf = _zeros(n)
    ph = 0.0
    for i in range(n):
        t = i / sr
        f = 45 + 75 * math.exp(-t * 30)
        ph += 2 * math.pi * f / sr
        env = math.exp(-t * 18) * min(1.0, t / 0.002)
        buf[i] = amp * math.sin(ph) * env
    return buf

def snare_sound(sr, amp=0.55, seed=1):
    rng = random.Random(seed)
    n = int(0.16 * sr)
    buf = _zeros(n)
    for i in range(n):
        t = i / sr
        tone = math.sin(2 * math.pi * 190 * t) * math.exp(-t * 25)
        noise = rng.gauss(0.0, 1.0) * math.exp(-t * 22)
        env = min(1.0, t / 0.001)
        buf[i] = amp * (0.6 * tone + 0.8 * noise) * env
    return buf

def hat_sound(sr, amp=0.14, seed=2):
    rng = random.Random(seed)
    n = int(0.05 * sr)
    noise = _zeros(n)
    for i in range(n):
        noise[i] = rng.gauss(0.0, 1.0)
    hp = noise
    for _ in range(6):
        nxt = _zeros(len(hp))
        prev = 0.0
        for i, v in enumerate(hp):
            nxt[i] = v - prev
            prev = v
        hp = nxt
    peak = 0.0
    for v in hp:
        a = abs(v)
        if a > peak: peak = a
    peak = max(1e-9, peak)
    tscale = 1.0 / sr
    buf = _zeros(n)
    for i in range(n):
        t = i * tscale
        buf[i] = amp * (hp[i] / peak) * math.exp(-t * 60) * min(1.0, t / 0.0005)
    return buf

SOUNDS = {}
def sound(drum, level_db=0.0):
    if drum not in SOUNDS:
        SOUNDS[drum] = {'kick': kick_sound, 'snare': snare_sound, 'hat': hat_sound}[drum](LOOP_SR)
    gain = 10 ** (level_db / 20.0)
    src = SOUNDS[drum]
    out = _zeros(len(src))
    for i, v in enumerate(src):
        out[i] = v * gain
    return out

def render_loop(hits, frames=LOOP_FRAMES, sr=LOOP_SR):
    """hits: list of (drum, bar(1-based), pos, extra_ms, level_db)."""
    out = [_zeros(frames), _zeros(frames)]
    for drum, bar, pos, extra_ms, level_db in hits:
        t = ((bar - 1) * 16 + pos) * SIXTEENTH + (SIG.get((drum, pos), 0.0) + extra_ms) / 1000.0
        s = int(round(t * sr))
        snd = sound(drum, level_db)
        if s < 0: continue
        e = min(frames, s + len(snd))
        if e <= s: continue
        pan = {'kick': (0.7, 0.7), 'snare': (0.7, 0.7), 'hat': (0.5, 0.85)}[drum]
        span = e - s
        left, right = out[0], out[1]
        for i in range(span):
            left[s + i] += snd[i] * pan[0]
            right[s + i] += snd[i] * pan[1]
    for buf in out:
        _clip_into(buf)
    return out

def scale_channels(channels, gain):
    out = []
    for buf in channels:
        nb = _zeros(len(buf))
        for i, v in enumerate(buf):
            nb[i] = v * gain
        out.append(nb)
    return out

def base_pattern(bars=2):
    return [(d, b, p, 0.0, 0.0) for b in range(1, bars + 1) for d, ps in PATTERN.items() for p in ps]

def gen_loops():
    d = os.path.join(OUT, 'loops')
    os.makedirs(d, exist_ok=True)
    tight = base_pattern()
    write_wav(os.path.join(d, 'tight.wav'), render_loop(tight), LOOP_SR, 24)
    feel = [(dr, b, p, (18.0 if dr == 'snare' else 12.0 if dr == 'hat' else 0.0), 0.0) for dr, b, p, _, _ in tight]
    write_wav(os.path.join(d, 'feel.wav'), render_loop(feel), LOOP_SR, 24)
    mist = []
    for dr, b, p, x, lv in tight:
        if dr == 'snare' and b == 1 and p == 4: mist.append((dr, b, p, 45.0, 0.0))
        elif dr == 'kick' and b == 1 and p == 8: mist += [(dr, b, p, 0.0, 0.0), (dr, b, p, 35.0, -2.0)]
        elif dr == 'kick' and b == 2 and p == 8: continue
        elif dr == 'snare' and b == 2 and p == 4: mist.append((dr, b, p, 0.0, -9.0))
        else: mist.append((dr, b, p, x, lv))
    write_wav(os.path.join(d, 'mistakes.wav'), render_loop(mist), LOOP_SR, 24)
    pushed = tight + [('kick', 3, 0, -10.0, 0.0)]
    write_wav(os.path.join(d, 'pushed.wav'), render_loop(pushed), LOOP_SR, 24)
    for drum, suffix in [('kick', 'KICK'), ('snare', 'SNARE'), ('hat', 'HIHAT')]:
        write_wav(os.path.join(d, 'tight_%s.wav' % suffix), render_loop([h for h in tight if h[0] == drum]), LOOP_SR, 24)
    write_wav(os.path.join(d, 'quiet.wav'), scale_channels(render_loop(tight), 10 ** (-6 / 20.0)), LOOP_SR, 24)
    core = {('kick', 0), ('kick', 8), ('snare', 4), ('snare', 11)}
    lazy = [(dr, b, p, (18.0 if (dr, p) in core else x), lv) for dr, b, p, x, lv in tight]
    write_wav(os.path.join(d, 'lazy.wav'), render_loop(lazy), LOOP_SR, 24)
    light = [(dr, b, p, x, (-8.0 if dr == 'hat' else lv)) for dr, b, p, x, lv in tight if not (dr == 'hat' and p % 4 != 0)]
    write_wav(os.path.join(d, 'lighthats.wav'), render_loop(light), LOOP_SR, 24)

def gen_fakelib():
    """Six loops in the four sub-folders plus a sidecar in the library shape."""
    root = os.path.join(OUT, 'fakelib')
    os.makedirs(root, exist_ok=True)
    def pat(bars, kind):
        base = base_pattern(bars)
        if kind == 'lazy': return [(dr, b, p, (18.0 if (dr, p) in {('kick', 0), ('kick', 8), ('snare', 4), ('snare', 11)} else x), lv) for dr, b, p, x, lv in base]
        if kind == 'light': return [(dr, b, p, x, (-8.0 if dr == 'hat' else lv)) for dr, b, p, x, lv in base if not (dr == 'hat' and p % 4 != 0)]
        if kind == 'mist': return [h for h in base if not (h[0] == 'kick' and h[2] == 8)] + [('snare', 1, 4, 45.0, 0.0)]
        return base
    files = [('2 bar loops', '15-16.wav', 2, 'tight'), ('2 bar loops', '33-34.wav', 2, 'lazy'), ('4 bar loops', '33-36.wav', 4, 'tight'),
             ('4 bar loops', '101-104.wav', 4, 'light'), ('8 bar loops', '9-16.wav', 8, 'tight'), ('Events', '324 (fill into the break).wav', 1, 'mist')]
    for folder, name, bars, kind in files:
        d = os.path.join(root, folder)
        os.makedirs(d, exist_ok=True)
        frames = int(round(bars * 4 * 60.0 / BPM * LOOP_SR))
        write_wav(os.path.join(d, name), render_loop(pat(bars, kind), frames=frames), LOOP_SR, 24)
    def loop(id_, folder, score, tight, lo, own, bars, pt0, feel, hats, hatdb, rms, section, act, use, variant=None, notes='', fills=None, breaks=None, bass_out=None):
        return dict(id=id_, fileNameHint=None, folder=folder, score=score, tight=tight, loop=lo, ownPattern=own, notes=notes, bars=bars, ptStart=pt0, ptEnd=pt0 + bars,
                    barsInFile=float(bars), perBar=[dict(bar=pt0 + i, tight=tight, loop=lo, ownPattern=own) for i in range(bars)], feelMs=feel, hats=hats, hatDb=hatdb, mixRmsDb=rms,
                    section=section, act=act, use=use, variant=variant, fills=fills or [], breaks=breaks or [], bassOutBars=bass_out or [], melloOutBars=[], patternDepartures=[], join='clean')
    loops = [loop('9-16', '8 bar loops', 8.4, 8.6, 7.0, None, 8, 9, 6.0, 'full', -44.0, -24.0, 'Vamp', 'I', 'backbone candidate', notes='Fake intro run: eight tight bars.'),
             loop('15-16', '2 bar loops', 9.6, 9.8, 9.5, None, 2, 15, 5.7, 'full', -44.5, -24.5, 'Vamp', 'I', 'drums-only texture (bass out)', notes='Fake: the tight pair.', bass_out=[15, 16]),
             loop('33-34', '2 bar loops', 7.2, 7.5, 6.5, None, 2, 33, 23.7, 'full', -44.2, -24.3, 'Bass in', 'I', 'variation (lazy pocket)', variant='lazy pocket: core hits 18 ms behind', notes='Fake: lazy pair, 18 ms behind.'),
             loop('33-36', '4 bar loops', 9.1, 9.3, 8.5, None, 4, 33, 5.9, 'full', -44.3, -24.4, 'Bass in', 'I', 'backbone candidate', notes='Fake: four tight bars over the bass.'),
             loop('101-104', '4 bar loops', None, 6.0, 5.0, 9.4, 4, 101, 5.8, 'light', -52.0, -25.0, 'Riddim I', 'II', 'variation (clave snare (1a, 2&, 4))', variant='clave snare (1a, 2&, 4)', notes='Fake variant: light hats, own pattern 9.4.'),
             loop('324-324', 'Events', None, 4.0, 4.0, 5.5, 1, 324, 40.0, 'medium', -47.0, -23.0, 'BREAK', 'IV', 'event / punctuation', notes='Fake fill into the break.', fills=[324])]
    names = {'9-16': '9-16.wav', '15-16': '15-16.wav', '33-34': '33-34.wav', '33-36': '33-36.wav', '101-104': '101-104.wav', '324-324': '324 (fill into the break).wav'}
    for l in loops:
        l['fileNameHint'] = names[l['id']]
    side = dict(schemaVersion=1, source='tests/gen_wavs.py (fake)', createdAt='2026-09-13T12:00:00Z', bpm=108.0,
                scale="score/tight/loop are out of 10 and 10.0 is possible (the app's own 0.0–9.9 scale caps at 9.9); score = mean Loop of scored bars; tight = mean Tight; loop = weakest bar's Loop; ownPattern = same timing score against the variant's own figure",
                barConvention='Pro Tools bars; song starts at bar 9; ptEnd is exclusive (End = last bar + 1)', loops=loops)
    with open(os.path.join(root, 'fake-drums.imported-loops.json'), 'w') as f:
        json.dump(side, f, indent=1)
        f.write('\n')
    print('fake library written to', root)

def main():
    global OUT
    args = sys.argv[1:]
    small = '--small' in args
    loops_only = '--loops-only' in args
    if '--out' in args:
        i = args.index('--out')
        if i + 1 >= len(args):
            sys.exit('--out needs a directory')
        OUT = os.path.abspath(args[i + 1])
    os.makedirs(OUT, exist_ok=True)
    if not loops_only:
        write_wav(os.path.join(OUT, 'synth_10min_48k_st24.wav'), click_track(120 if small else 600, 48000), 48000, 24)
        write_wav(os.path.join(OUT, 'synth_1min_48k_st_f32.wav'), click_track(60, 48000, seed=2), 48000, 32, fmt='float', extra_chunks=True)
        write_wav(os.path.join(OUT, 'synth_30s_441k_mono16.wav'), click_track(30, 44100, stereo=False, seed=3), 44100, 16)
        write_wav(os.path.join(OUT, 'synth_2s_48k_st24.wav'), click_track(2, 48000, bursts=False), 48000, 24)
        write_wav(os.path.join(OUT, 'synth_10s_96k_st24.wav'), click_track(10, 96000, bursts=False), 96000, 24)
        with open(os.path.join(OUT, 'bad_header.wav'), 'wb') as f:
            body = b'WAVE' + chunk(b'LIST', b'INFO') + chunk(b'data', b'\x00' * 100)
            f.write(b'RIFF' + struct.pack('<I', len(body)) + body)
        rng = random.Random(0)
        with open(os.path.join(OUT, 'not_a_wav.wav'), 'wb') as f:
            f.write(bytes(rng.randrange(256) for _ in range(5000)))
    gen_loops()
    gen_fakelib()
    print('done')

if __name__ == '__main__':
    main()

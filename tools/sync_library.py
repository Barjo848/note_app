#!/usr/bin/env python3
"""Build library/<name>/ inside the app folder from a folder of loop WAVs.

  /usr/bin/python3 tools/sync_library.py --source DIR --name NAME [--dest library] [--copy] [--sidecar FILE]

Writes: <dest>/<name>/<sub-folder>/<file>.wav  (symlinks by default, --copy to copy),
        <dest>/<name>/manifest.json             (id, path, folder, bytes, bars, ptStart/ptEnd, format, fingerprint),
        <dest>/<name>/<name>.imported-loops.json  (copy of the sidecar, when found),
        <dest>/index.json                       (list of libraries).
The fingerprint is the app's own recipe: sha256(first 1 MiB ‖ "|<size>|<duration to 3 dp>"), hex — identical
to js/wav.js, so the app re-links loops exactly. WAVs are generated, not committed (see .gitignore).
The source folder is read only. Run tools/precompute_analysis.js afterwards to seed the analysis cache.
The app opens a library when the URL contains ?library=<name>."""
import argparse, hashlib, json, os, re, shutil, struct, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def wav_info(path):
    with open(path, 'rb') as f:
        head = f.read(12)
        if head[:4] not in (b'RIFF', b'RF64') or head[8:12] != b'WAVE': raise ValueError('not a WAV')
        size = os.path.getsize(path); pos = 12; fmt = None; data = None
        while pos + 8 <= size:
            f.seek(pos); h = f.read(8); cid = h[:4]; csz = struct.unpack('<I', h[4:8])[0]
            if cid == b'fmt ':
                d = f.read(min(csz, 40)); tag, ch, sr, _br, block, bits = struct.unpack('<HHIIHH', d[:16])
                if tag == 0xFFFE and len(d) >= 26: tag = struct.unpack('<H', d[24:26])[0]
                fmt = dict(channels=ch, sampleRate=sr, bitDepth=bits, format='float' if tag == 3 else 'pcm', blockAlign=ch * bits // 8)
            if cid == b'data':
                dsz = csz
                if dsz == 0 or dsz == 0xFFFFFFFF or pos + 8 + dsz > size: dsz = size - pos - 8
                data = dict(offset=pos + 8, size=dsz); break
            pos += 8 + csz + (csz & 1)
        if not fmt or not data: raise ValueError('no fmt/data chunk')
        frames = data['size'] // fmt['blockAlign']; duration = frames / fmt['sampleRate']
        f.seek(0); head1 = f.read(1024 * 1024)
    tail = ('|%d|%.3f' % (size, duration)).encode()
    fp = hashlib.sha256(head1 + tail).hexdigest()
    return dict(fmt, sizeBytes=size, totalFrames=frames, durationSeconds=round(duration, 6), fingerprint=fp)

def parse_range(name):
    base = re.sub(r'\.[^.]+$', '', name)
    m = re.match(r'^\s*(\d+)(?:\s*[-–—]\s*(\d+))?', base)
    if not m: return None
    a = int(m.group(1)); b = int(m.group(2)) if m.group(2) else a
    return dict(start=min(a, b), end=max(a, b))

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--source', required=True); ap.add_argument('--name', required=True)
    ap.add_argument('--dest', default=os.path.join(ROOT, 'library')); ap.add_argument('--copy', action='store_true')
    ap.add_argument('--sidecar', default=None, help='sidecar JSON (default: the first *.imported-loops.json in the source folder)')
    ap.add_argument('--default', action='store_true', help='put this library first in index.json')
    ap.add_argument('--bpm', type=float, default=108.0)
    a = ap.parse_args()
    src = os.path.abspath(a.source); dest = os.path.join(os.path.abspath(a.dest), a.name)
    if not os.path.isdir(src): sys.exit('source folder not found: ' + src)
    os.makedirs(dest, exist_ok=True)
    t0 = time.time(); entries = []
    for dirpath, dirs, files in os.walk(src):
        dirs.sort()
        rel_dir = os.path.relpath(dirpath, src); rel_dir = '' if rel_dir == '.' else rel_dir
        for fn in sorted(files):
            if not fn.lower().endswith('.wav'): continue
            sp = os.path.join(dirpath, fn); rel = os.path.join(rel_dir, fn) if rel_dir else fn
            tp = os.path.join(dest, rel); os.makedirs(os.path.dirname(tp), exist_ok=True)
            if os.path.islink(tp) or os.path.exists(tp): os.remove(tp)
            if a.copy: shutil.copy2(sp, tp)
            else: os.symlink(sp, tp)
            info = wav_info(sp); r = parse_range(fn)
            bar_sec = 60.0 / a.bpm * 4; bars = info['durationSeconds'] / bar_sec
            entries.append(dict(id=(str(r['start']) if r and r['start'] == r['end'] else ('%d-%d' % (r['start'], r['end']) if r else re.sub(r'\.wav$', '', fn, flags=re.I))),
                                path=rel.replace(os.sep, '/'), fileName=fn, folder=rel_dir.replace(os.sep, '/'), bytes=info['sizeBytes'],
                                bars=round(bars, 4), barsRounded=max(1, round(bars)), ptStart=r['start'] if r else None, ptEnd=(r['end'] + 1) if r else None,
                                sampleRate=info['sampleRate'], channels=info['channels'], bitDepth=info['bitDepth'], format=info['format'],
                                durationSeconds=info['durationSeconds'], totalFrames=info['totalFrames'], fingerprint=info['fingerprint']))
    entries.sort(key=lambda e: (e['ptStart'] if e['ptStart'] is not None else 1e9, e['ptEnd'] or 0, e['id']))
    sidecar = a.sidecar
    if not sidecar:
        cands = [f for f in os.listdir(src) if f.endswith('.imported-loops.json')]
        sidecar = os.path.join(src, cands[0]) if cands else None
    sidecar_name = None
    if sidecar and os.path.exists(sidecar):
        sidecar_name = a.name + '.imported-loops.json'; shutil.copy2(sidecar, os.path.join(dest, sidecar_name))
    manifest = dict(name=a.name, source=src, generatedAt=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), bpm=a.bpm, linkMode='copy' if a.copy else 'symlink',
                    barConvention='Pro Tools bars; song starts at bar 9; ptEnd exclusive', loops=entries, sidecar=sidecar_name, count=len(entries), totalBytes=sum(e['bytes'] for e in entries))
    json.dump(manifest, open(os.path.join(dest, 'manifest.json'), 'w'), indent=1); open(os.path.join(dest, 'manifest.json'), 'a').write('\n')
    idx_path = os.path.join(os.path.abspath(a.dest), 'index.json')
    idx = json.load(open(idx_path)) if os.path.exists(idx_path) else dict(libraries=[])
    idx['libraries'] = [l for l in idx['libraries'] if l.get('name') != a.name]
    entry = dict(name=a.name, path=a.name + '/', manifest='manifest.json', sidecar=sidecar_name, session=a.name + '.loops.json', ratings=a.name + '.ratings.json', count=len(entries))
    if a.default or not idx['libraries']: idx['libraries'].insert(0, entry)
    else: idx['libraries'].append(entry)
    idx['default'] = idx['libraries'][0]['name']
    json.dump(idx, open(idx_path, 'w'), indent=1); open(idx_path, 'a').write('\n')
    print('%s: %d loops (%.0f MB) → %s in %.1fs; sidecar: %s' % (a.name, len(entries), manifest['totalBytes'] / 1e6, dest, time.time() - t0, sidecar_name or 'none'))

if __name__ == '__main__': main()

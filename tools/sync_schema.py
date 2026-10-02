#!/usr/bin/env python3
"""Regenerate js/schema.js from notes.schema.json and js/loopsSchema.js from
loops.schema.json (the canonical files).

The app embeds the schemas because a page opened from file:// cannot fetch a
sibling file. Run this after editing either schema; build_single_file.sh runs
it automatically.  --check exits 1 if a generated file is stale."""
import json, os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAIRS = [('notes.schema.json', os.path.join('js', 'schema.js'), 'NOTES_SCHEMA'),
         ('loops.schema.json', os.path.join('js', 'loopsSchema.js'), 'LOOPS_SCHEMA')]
stale = False
for src, dst, name in PAIRS:
    schema = json.load(open(os.path.join(root, src), encoding='utf-8'))
    out = ("/* %s — GENERATED from %s by tools/sync_schema.py. Do not edit by hand. */\n'use strict';\n\nconst %s = " % (os.path.basename(dst), src, name)) + json.dumps(schema, indent=2, ensure_ascii=False) + ";\n"
    path = os.path.join(root, dst)
    if '--check' in sys.argv:
        cur = open(path, encoding='utf-8').read() if os.path.exists(path) else ''
        if cur != out: stale = True; print('stale:', dst)
    else:
        open(path, 'w', encoding='utf-8').write(out); print('wrote', dst)
sys.exit(1 if stale else 0)

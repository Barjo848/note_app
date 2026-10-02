# Architecture

Note is a single page of classic scripts. `index.html` loads them in order. `./scripts/build.sh` regenerates the schema copies and inlines the same sources into `dist/index.html`, which is what the file-protocol checks open.

There is no account and no server in the page. `tools/serve.js` is a local static server with Range reads and a JSON write limited to `library/<name>/*.json`, used when a library is open over HTTP.

## Who owns a position

A note's position is a sample count. `NoteStore.pos` in `js/notes.js` stores `{ samples, seconds }`, and `seconds` is `samples / sampleRate` for the open file. On load and on a confirmed re-link, seconds are written again from the samples. The grid changes the ruler. It does not move stored samples.

Playback position on Track is the `<audio>` element's current time, owned by `Transport` in `js/transport.js`. Loop Lab and Sequence use one `AudioContext` clock in `LoopPlayer` (`js/loopplayer.js`). Deck switches and sequence block edges land on integer bars of that clock.

## Peaks

`PeakWorker` (`js/worker.js`) runs from a blob URL, off the main thread. It reads the WAV `data` chunk in slices of 4 MiB, aligned to the frame size, and decodes 16/24/32-bit PCM and 32-bit float itself. Each slice becomes min/max buckets of 64 samples per channel, then folded by 4 into 256, 1024, 4096, 16384, and 65536. `PeakStore` (`js/peaks.js`) keeps that pyramid, picks a level for the current zoom, and caches it in IndexedDB under the file fingerprint.

The same worker pass keeps a mono mix and a descriptor frame every 1024 samples: a 2048-point Hann FFT, RMS, peak, low / mid / high band power, spectral flux, and an onset flag. `Analysis` (`js/analysis.js`) turns those frames into per-bar or per-second rows when the grid changes. The audio file is not read again for a tempo edit.

## What the schema guarantees

`notes.schema.json` and `loops.schema.json` are the documents. `tools/sync_schema.py` copies them into `js/schema.js` and `js/loopsSchema.js` so a `file://` page can validate without a fetch. `validateSchema` checks the subset of JSON Schema 2020-12 those files use, and names every problem.

Unknown fields are kept at each level the schema allows and written back on save. A file with a newer `schemaVersion` still loads, with a warning. An AI reply that fails the schema is refused and creates no layer. A valid reply becomes its own layer. The bundle `AiBridge` builds for that reply is text and contains no audio samples.

The fingerprint is SHA-256 over the first 1 MiB of the file, then `|<size in bytes>|<duration to 3 decimal places>`. `WavReader.fingerprint` and `tools/sync_library.py` use that recipe. A different file is detected by it. The notes stay until the person confirms.

## Modules

| File | Owns |
|------|------|
| `js/wav.js` | RIFF/RF64 walk, PCM and float `fmt`, RIFX refusal, fingerprint |
| `js/worker.js`, `js/peaks.js`, `js/analysis.js` | peaks, cache, descriptor rows |
| `js/grid.js` | seconds, samples, and `bar\|beat\|ticks` |
| `js/notes.js` | layers, notes, replies, undo and redo |
| `js/waveform.js` | the Track canvases and hit testing |
| `js/transport.js` | Track `<audio>` playback |
| `js/persistence.js` | the notes document, save, download, autosave |
| `js/ai.js` | the text bundle, schema import, the optional direct request |
| `js/onsets.js` | Loop Lab band split, drum labels, the session signature, join numbers |
| `js/loops.js` | the loop document and the imported layer |
| `js/loopplayer.js` | gapless loop and sequence playback |
| `js/sequence.js`, `js/sequenceview.js` | arrangements, seam reports, the lane |
| `js/library.js` | `?library=` launch, analysis cache, ratings save |
| `js/app.js`, `js/looplab.js` | the two screens |

`js/onsets.js` is the same function `tests/dsp_check.js` runs in Node. The synthetic session's signature matches that check.

A served page with no `?library=` name opens on Track. `LibraryLoader` opens a library only when the query names one listed in `library/index.json`.

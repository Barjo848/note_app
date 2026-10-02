# Note

Local notes on a WAV bounce. Nothing is uploaded.

Open a PCM WAV, play it, draw peaks without blocking the page, and save notes that reload to the same samples.

---

## Honesty contract

### What the notes file stores

The notes file is JSON. Each position is a sample count, and the seconds beside it are that count divided by the file's sample rate. The file also holds layers, the text of the notes, the grid, and a short history. The exported bundle contains no audio samples.

### What a new bounce does to the fingerprint

The fingerprint is the SHA-256 of the first 1 MiB of the file, followed by `|<size in bytes>|<duration to 3 decimal places>`. A new bounce changes it. Copying or renaming the file leaves it the same.

A different file is detected by fingerprint. The notes stay until the person confirms.

### What the machine score measures

The score is 0–10 from how close kick and snare sit to this session's median. Core positions are kick on 1 and 3 and snare on 2 and the a of 3, then penalties for flams, dynamics, and missing hits. This is a summary of that grid. While the number is hidden, the waveform marks stay.

### Audio in, JSON out

The WAV you open is the file that plays. Note writes a JSON notes file. It has no compressor, and it does not write a new bounce.

### What leaves the machine

With the direct request unused, the page makes no network connection.

Paste the bundle into a model, then import the reply. That path sends nothing from the page. The direct-send button asks first. Confirming sends the text bundle to Anthropic at `api.anthropic.com`. The key stays in that browser.

---

## Use

### Track

1. Open a PCM WAV with ⌘O, or drop it on the window. Playback uses the file. Peaks are drawn from a worker, so the page stays usable while they arrive.
2. The grid starts at 108 BPM and 4/4. `M` drops a pin at the playhead. `⇧M` turns the selection into an interval.
3. Save with ⌘S. Open that WAV again and load the JSON: the notes come back on the same samples.
4. Load notes saved for another file. A different file is detected by fingerprint. The notes stay until the person confirms.
5. Undo and redo cover note and layer edits. The keys are `⌘Z` and `⇧⌘Z`.
6. Export the AI bundle and import the model's JSON reply. An AI reply that fails the schema is refused. A valid one becomes its own layer.

A served page opens on Track even when a library index is present. `?library=<name>` opens Loop Lab when that name is listed in `library/index.json`.

### Loop Lab and Sequence

Open a folder of loops, or a library the address names. Loop playback of a fixture is sample-exact across the join. The synthetic session's signature matches the DSP check.

Build an arrangement out of those loops. A sequence render is as long as the sum of its files, and a level step at a seam is reported.

---

## Test and build

Requirements: macOS, Node, and `/usr/bin/python3`. The suite drives Chrome or the Playwright Chromium.

```bash
./scripts/run_tests.sh
```

```bash
./scripts/build.sh
```

`./scripts/run_tests.sh` audits the tree, checks this README, generates the fixtures, writes `dist/index.html`, and runs Track, Loop Lab, Sequence, and the synthetic library. `./scripts/build.sh` writes `dist/index.html` on its own. The file-protocol checks open that file.

Set `PW_CHROMIUM` to a Chromium binary to use that binary. When it is unset, the test script installs Playwright's Chromium.

What each check asserts is in [`tests/README.md`](tests/README.md).

---

## Limits

- PCM WAV is the listening path the parser describes, along with IEEE float WAV. A float file that the audio element cannot play is played from a 16-bit PCM copy, and the notes stay on the original file. If that copy cannot be built, the banner reads `Float files can be annotated and may not play.`
- AIFF, MP3, and CAF are outside the parser. A file with no RIFF/WAVE header is handed to the browser decoder, which loads the whole file. The suite opens WAV fixtures.
- RIFX is refused by the parser.
- Drum labels come from band energy of a mix.
- In Loop Lab, half speed changes pitch, and the rate control says `pitch follows rate`. On Track, changing the rate keeps the pitch of the file.
- The join is a fade of at most 20 ms. The control starts at 0, and at 0 the join does not fade.
- Save-in-place needs the File System Access API. Otherwise Save downloads the JSON.

How the pieces fit: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).
Reporting a problem: [`SECURITY.md`](SECURITY.md).
Changes: [`CHANGELOG.md`](CHANGELOG.md).
Licence: [MIT](LICENSE).

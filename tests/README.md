# Tests

The suite is one command, from the repository root:

```bash
./scripts/run_tests.sh
```

It audits the tree, generates the synthetic WAVs with the Python standard library, syncs and precomputes the fake library, writes `dist/index.html`, checks the session signature, and runs the four Playwright suites below. `./scripts/build.sh` writes `dist/index.html` on its own.

`PW_CHROMIUM`, when set, is the browser binary. When it is unset, the script installs Playwright's Chromium and the runners use that. The app itself has no dependencies. Playwright is installed under `tests/` by the script when it is missing.

The Track runner serves the app itself (`tests/serve.js`) and blocks every non-localhost request; `https://api.anthropic.com` is mocked to return 401 so check 8 never reaches the network.

## Automated (Playwright)

| # | Check | What is asserted |
|---|-------|------------------|
| 0 | Launch | a served page with `library/index.json` present stays on Track; the play button and waveform are visible; no library opens |
| 0b | Limits | first layer is Notes and renames; page text does not say Claude or the retired given name; the machine-score caption contains "this session" and not "grade"; the rate label says pitch follows rate; an empty model is not sent |
| 1 | Big file | synthetic 10-minute WAV opens; playback starts before peaks; main-thread round trips stay < 500 ms while analysing; progress shown; header fields; pyramid + descriptors < 60 MB; cache reopen |
| 2 | Zoom | 12 zoom steps + fit each < 100 ms; ruler x == playhead x at 5 zooms; drawn transient at 60.000 s within 1 px at ≤ 10 s views |
| 3 | bar\|beat\|ticks | 88.889 s → 41\|1\|000; 140–180 s → 64\|1\|000–82\|1\|000; list shows them |
| 4 | Round trip | save → reload → open WAV → load JSON: samples, layers, replies, categories, rating, status, history, grid, unknown fields at every level |
| 5 | Fingerprint | mismatch dialog; Cancel loads nothing; Load anyway keeps seconds and recomputes samples at the new rate |
| 6 | Undo/redo | 9 operations (create, move, create interval, resize, edit, add layer, move to layer, merge, delete) undone and redone step by step |
| 7 | AI | bundle sections and note ids present, no raw arrays; valid response → layer, notes, reply on the right note, confidence tags, summary; invalid response refused with every problem listed; junk refused |
| 8 | Direct API | no key → message; wrong key → mocked HTTP 401 surfaced; key never in the JSON |
| 9 | Shortcuts | every §5 shortcut; none fire while typing in the editor; Enter saves, Esc cancels |
| R | Robustness | float32 EXTENSIBLE with fact/LIST/odd chunk, mono 44.1 kHz, 2 s, 96 kHz, missing fmt, random bytes, malformed JSON, wrong-shape JSON — all handled with readable messages and no page errors; the float file moves the playhead or the banner says float files can be annotated and may not play |
| 10 | Single file | `dist/index.html` from `file://`: worker, peaks, descriptors, the same float playback contract, note creation, save fallback |
| D | Mouse | drag a pin (one undo step), resize an interval edge, shift-drag selection, hover tooltip, double-click creates a pin |
| N | Network | no request left the machine except the mocked Anthropic endpoint |

## Loop Lab

| # | Check |
|---|---|
| L1 | four fixtures form a session; signature ≈ snare 3a +24 / kick 1& −6; tight = no mistakes; feel = zero mistakes with feel hits; mistakes = exactly one late, flam, missing (kick b2 beat 3), dynamics; pushed = join "pushed downbeat" |
| L2 | OfflineAudioContext render of tight.wav looped twice: second pass identical to the source, sample for sample |
| L3 | beat 480 coincides with loop 60 exactly; next-bar switch time is an integer bar; deck switches |
| L3b | offline render of a silent loop with the metronome on: 480 clicks, no drift against the file period, none missed |
| L4 | blind mode hides names and deck tags; reveal states the mapping consistent with the coin toss |
| L5 | rating: 9.9 max, one decimal, `10` and `-1` clamped, no `10` option |
| L6 | loops.json round trip incl. unknown fields at 4 levels; override + drum correction persist and survive re-analysis; re-opening WAVs re-links |
| L7 | sidecar import: matched by id, unmatched reported, one class disagreement found and listed, layer score column; invalid sidecar refused with path |
| L8 | Markdown/CSV rankings; shortcuts do not fire in text fields, ⌘Enter saves notes, shortcuts work outside fields |
| L9 | stems → stem-verified, hats under snares recovered, no mistakes |
| LX | writes examples/example.loops.json + example.imported-loops.json and re-imports both |
| L10 | dist/index.html from file:// analyses loops |

## Sequence

| # | Check |
|---|---|
| S1 | tight×2, quiet×1, tight×1 renders to exactly the sum of the file lengths; the repeat join and the block after `quiet` are sample-identical to the source; level match lifts `quiet` ≈ +6 dB |
| S2 | seam verdicts: tight→quiet ≈ −6 dB red, tight→lazy ≈ +18 ms amber, tight→lighthats texture change, pushed→tight pushed downbeat with the "cut ~15 ms" advice, tight→tight clean; care list in words |
| S3 | HTML5 drop from the loop list, mouse reorder, drag out to remove, stepper, `↓`, `⌘D`, typed repeats clamp to 64, `⌫`; undo back through every edit and redo forward |
| S4 | mapping line: second repeat of 83-84 maps arrangement bars 3–4 to PT 83–84 |
| S5 | cue rows: Start/End values, repeat index, trims, seam verdict per row; Markdown and CSV agree; care list appended |
| S6 | v1 loops.json loads (migrated, saves as v2); v2 with two arrangements + unknown fields at document/arrangement/block level round-trips and validates; standalone export re-imports with every block re-linked; invalid export refused |
| S7 | seam audition = two one-bar occurrences on repeat, click on, beat 5 exactly at the incoming bar; A/B of two arrangements switches at a bar boundary |

## Library fixture

The same command syncs `fake-drums` into `tests/fixtures/library` and the library runner serves that folder.

| # | Check |
|---|---|
| C1 | `?library=fake-drums` with no further click: six loops in song order, progress shown, first selected, sidecar attached as a hidden layer named Imported (this suite deletes the leftover session first; a saved session keeps the name already in its file), no imported score or machine value in the DOM (text, cells, titles); After I rate → values only on rated loops; All → all; reload → hidden |
| C2 | `8` `3` `Enter` → 8.3 with `blind: true`, advances to the next unrated; `S` skip, `P`/`N`, revealed rating → `blind: false`, `U`, `T` + ⌘Enter notes, `R` reference |
| C3 | rating saved to the library folder through the endpoint and back after a reload with no dialog; plain static server → no endpoint, unsaved badge, ⌘S fallback downloads; localStorage draft restores and loops stay linked |
| C4 | export matches `$defs/ratingsExport`, no imported value while hidden, written through the endpoint as `fake-drums.ratings.json`, CSV agrees, import restores; comparison null when hidden and filled (own-pattern basis for the variant) when revealed + ticked; the comparison export is written under the fixture library |
| C5 | every sort key orders the fixture correctly, direction, secondary, unrated first/last; similarity symmetric and zero for the reference, presets reorder as expected, section centroid; seam compatibility agrees with the Sequence verdicts; seeded random repeatable |
| C6 | filters combine (API and chips), the song-strip drag filters to a bar range, group-by-section headers in song order |

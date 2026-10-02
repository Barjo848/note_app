#!/usr/bin/env bash
# The README may state the claims listed here. A forbidden phrase fails the run.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
README="$ROOT/README.md"
status=0

require() {
  local phrase="$1"
  if ! grep -Fq -- "$phrase" "$README"; then
    echo "readme: missing claim: $phrase"
    status=1
  fi
}

forbid() {
  local label="$1" pattern="$2" hits
  hits="$(grep -InEi -- "$pattern" "$README" || true)"
  if [[ -n "$hits" ]]; then
    echo "readme: $label"
    echo "$hits" | sed 's/^/    /'
    status=1
  fi
}

require "Open a PCM WAV, play it, draw peaks without blocking the page, and save notes that reload to the same samples."
require "A different file is detected by fingerprint."
require "The notes stay until the person confirms."
require "Undo and redo cover note and layer edits."
require "An AI reply that fails the schema is refused."
require "A valid one becomes its own layer."
require "The exported bundle contains no audio samples."
require "With the direct request unused, the page makes no network connection."
require "Loop playback of a fixture is sample-exact across the join."
require "The synthetic session's signature matches the DSP check."
require "as long as the sum of its files"
require "a level step at a seam is reported"
require "opens on Track"

forbid "anonymize" 'anonym'
forbid "drum separation" 'separat(e|es|ing) drums|drum separat'
forbid "time-stretch" 'time-?stretch|time stretch'
forbid "genre" 'genre'
forbid "hidden waveform marks" 'hides the waveform|hides waveform|blind mode hides'
forbid "Safari" 'Safari'
forbid "Firefox" 'Firefox'
forbid "Cuba" '\bCuba\b'
forbid "portal" '\bportal\b'
forbid "installer" 'installer'
forbid "mastering" 'mastering'
forbid "loudness" 'loudness'
forbid "resolution" 'resolution'

if [[ "$status" -eq 0 ]]; then
  echo "readme: ok"
fi
exit "$status"

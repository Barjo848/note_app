#!/usr/bin/env bash
# Schema sync, then dist/index.html (the file the file:// checks open).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
bash "$ROOT/build_single_file.sh"

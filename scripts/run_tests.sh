#!/usr/bin/env bash
# The test command. Audits the tree, generates fixtures, builds dist/index.html,
# and runs Track, Loop Lab, Sequence, and the synthetic library.
#
#   ./scripts/run_tests.sh
#
# PW_CHROMIUM, when set, is the browser binary. Otherwise the script installs
# Playwright's Chromium and the runners use that.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required" >&2
  exit 1
fi

echo "==> Auditing repository"
bash "$ROOT/scripts/audit_repo.sh"

echo "==> Checking the README"
bash "$ROOT/scripts/check_readme.sh"

echo "==> Generating fixtures"
/usr/bin/python3 "$ROOT/tests/gen_wavs.py"

echo "==> Syncing the synthetic library"
/usr/bin/python3 "$ROOT/tools/sync_library.py" \
  --source "$ROOT/tests/fixtures/fakelib" \
  --name fake-drums \
  --dest "$ROOT/tests/fixtures/library"

echo "==> Precomputing analysis"
node "$ROOT/tools/precompute_analysis.js" "$ROOT/tests/fixtures/library/fake-drums"

echo "==> DSP check"
node "$ROOT/tests/dsp_check.js"

echo "==> Building dist/index.html"
bash "$ROOT/scripts/build.sh"

if [[ ! -d "$ROOT/tests/node_modules/playwright" ]]; then
  echo "==> Installing Playwright"
  (cd "$ROOT/tests" && npm install)
fi

if [[ -z "${PW_CHROMIUM:-}" ]]; then
  if ! (cd "$ROOT/tests" && node -e "
    const fs = require('fs');
    const { chromium } = require('playwright');
    const exe = chromium.executablePath();
    if (!exe || !fs.existsSync(exe)) process.exit(1);
  "); then
    echo "==> Installing Playwright Chromium"
    (cd "$ROOT/tests" && npx playwright install chromium)
  fi
fi

echo "==> Track"
(cd "$ROOT/tests" && node run_tests.js)
echo "==> Loop Lab"
(cd "$ROOT/tests" && node run_loop_tests.js)
echo "==> Sequence"
(cd "$ROOT/tests" && node run_sequence_tests.js)
echo "==> Library"
(cd "$ROOT/tests" && node run_library_tests.js)

echo "==> done"

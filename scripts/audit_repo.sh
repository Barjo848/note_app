#!/usr/bin/env bash
# Fails if the snapshot carries things that do not belong in a public repository:
# files outside the expected layout, machine-specific paths, attribution trailers,
# development-diary phrasing, personal names, image metadata, or oversized files.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export LC_ALL=C

SELF="scripts/audit_repo.sh"
status=0
fail() {
  echo "audit: $1"
  status=1
}

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "audit: not a git checkout, skipping"
  exit 0
fi

# Tracked files plus new files that are not ignored: what a clean snapshot contains.
FILES=()
while IFS= read -r file; do
  [[ -f "$file" ]] && FILES+=("$file")
done < <(git ls-files --cached --others --exclude-standard)

for file in "${FILES[@]}"; do
  case "$file" in
    .gitignore | LICENSE | README.md | CHANGELOG.md | SECURITY.md | build_single_file.sh | index.html | start.command | styles.css) ;;
    .github/workflows/*.yml) ;;
    docs/*.md) ;;
    loops.schema.json | notes.schema.json | library/index.json) ;;
    scripts/*.sh) ;;
    js/*.js) ;;
    examples/example.ai-response.json | examples/example.imported-loops.json | examples/example.loops.json | examples/example.notes.json) ;;
    tests/README.md | tests/dsp_check.js | tests/dsp_real.js | tests/gen_wavs.py | tests/package.json | tests/package-lock.json) ;;
    tests/run_library_tests.js | tests/run_loop_tests.js | tests/run_sequence_tests.js | tests/run_tests.js | tests/serve.js) ;;
    tests/fixtures/*.json | tests/fixtures/*.md) ;;
    tests/fixtures/loops/*.json | tests/fixtures/loops/*.md | tests/fixtures/loops/*.csv) ;;
    tests/fixtures/fakelib/*.json) ;;
    tools/precompute_analysis.js | tools/serve.js | tools/sync_library.py | tools/sync_schema.py) ;;
    *) fail "file outside the expected layout: $file" ;;
  esac
done

check_text() {
  local label="$1" pattern="$2" hits
  hits="$(grep -InE -- "$pattern" "${TEXT_FILES[@]}" 2>/dev/null || true)"
  if [[ -n "$hits" ]]; then
    fail "$label:"
    echo "$hits" | sed 's/^/    /'
  fi
}

TEXT_FILES=()
for file in "${FILES[@]}"; do
  [[ "$file" == "$SELF" ]] && continue
  case "$file" in
    *.pdf | *.png | *.icns) continue ;;
  esac
  TEXT_FILES+=("$file")
done

if [[ ${#TEXT_FILES[@]} -gt 0 ]]; then
  check_text "absolute home path" '/(Users|home)/[A-Za-z0-9._-]+/'
  check_text "attribution trailer" '(Co-Authored-By:|Generated with )'
  check_text "development-diary phrasing" '(\bPR ?[0-9]+[a-z]?\b|\bStage ?[A-Z]?[0-9]|\bGate ?[0-9]|\bspike\b)'
fi

# Names are matched either way around: the snapshot must not carry them.
if [[ ${#TEXT_FILES[@]} -gt 0 ]]; then
  hits="$(grep -InEi -- '\b(barjo|josh)\b' "${TEXT_FILES[@]}" 2>/dev/null || true)"
  if [[ -n "$hits" ]]; then
    fail "personal name:"
    echo "$hits" | sed 's/^/    /'
  fi
fi

for file in "${FILES[@]}"; do
  case "$file" in
    *.png | *.icns)
      if grep -aqE '(eXIf|tEXt|iTXt|zTXt)' "$file"; then
        fail "image metadata chunk in $file"
      fi
      ;;
  esac
done

for file in "${FILES[@]}"; do
  size="$(wc -c < "$file" | tr -d ' ')"
  if [[ "$size" -gt 262144 ]]; then
    fail "file over 256 KB: $file ($size bytes)"
  fi
done

if [[ "$status" -ne 0 ]]; then
  echo "audit: FAILED"
  exit 1
fi
echo "audit: ok (${#FILES[@]} files)"

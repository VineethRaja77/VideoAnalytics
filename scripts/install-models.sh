#!/usr/bin/env bash
#
# scripts/install-models.sh — build the per-module Python environments.
#
# WHY THIS EXISTS
#   analyticsWorker.ts launches each analytics module with its OWN interpreter:
#       models/<module>/.venv/bin/python
#   and falls back to system `python3` when that venv is absent. On a machine
#   where the venv was never built, that fallback is silent and fatal: the
#   worker dies on `import dotenv` before printing anything useful, the
#   supervisor counts it as a crash, and it restart-loops forever. The analytic
#   simply never produces events and nothing says why.
#
#   This was found on the development box itself — four of six modules
#   (vehicle, person, tamper, object) had no venv and could never have started.
#
# WHAT IT DOES
#   For every module with a requirements.txt: create .venv, install pinned
#   dependencies, then IMPORT-CHECK the worker. An install that "succeeds" but
#   cannot import is the failure mode that matters, so it is verified, not
#   assumed.
#
# USAGE
#   ./scripts/install-models.sh              # all modules
#   ./scripts/install-models.sh ppe vehicle  # only these
#   PYTHON=python3.12 ./scripts/install-models.sh
#
# Safe to re-run: an existing venv is reused and requirements re-checked.

set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="${MODELS_BASE:-$APP_DIR/models}"
PYTHON="${PYTHON:-python3}"

trap 'echo "❌ install-models failed at line $LINENO" >&2' ERR

command -v "$PYTHON" >/dev/null || {
  echo "❌ $PYTHON not found. Install Python 3.10+ first." >&2
  exit 1
}

# python3-venv is a separate package on Debian/Ubuntu and its absence produces
# a confusing error deep inside the first venv creation.
"$PYTHON" -c "import venv" 2>/dev/null || {
  echo "❌ The venv module is missing. On Debian/Ubuntu:" >&2
  echo "     sudo apt-get install -y python3-venv" >&2
  exit 1
}

if [[ $# -gt 0 ]]; then
  MODULES=("$@")
else
  MODULES=()
  for d in "$MODELS_DIR"/*/; do
    [[ -f "${d}requirements.txt" ]] && MODULES+=("$(basename "$d")")
  done
fi

[[ ${#MODULES[@]} -gt 0 ]] || {
  echo "❌ No modules with a requirements.txt under $MODELS_DIR" >&2
  exit 1
}

echo "▶ Building environments for: ${MODULES[*]}"
echo "  python: $($PYTHON --version 2>&1)"
echo

FAILED=()
for m in "${MODULES[@]}"; do
  DIR="$MODELS_DIR/$m"
  REQ="$DIR/requirements.txt"

  if [[ ! -f "$REQ" ]]; then
    echo "⏭  $m — no requirements.txt, skipping"
    continue
  fi

  printf '── %s ' "$m"
  printf '%.0s─' $(seq 1 $((60 - ${#m})))
  echo

  if [[ ! -x "$DIR/.venv/bin/python" ]]; then
    echo "   creating .venv"
    "$PYTHON" -m venv "$DIR/.venv"
  else
    echo "   .venv exists — reusing"
  fi

  VPY="$DIR/.venv/bin/python"
  "$VPY" -m pip install --quiet --upgrade pip >/dev/null 2>&1 || true

  echo "   installing pinned requirements"
  if ! "$VPY" -m pip install --quiet -r "$REQ"; then
    echo "   ❌ pip install failed for $m"
    FAILED+=("$m (pip)")
    continue
  fi

  # The check that actually matters. A venv can exist, pip can report success,
  # and the worker can still fail to import — which is exactly what the silent
  # python3 fallback looked like.
  echo -n "   import check: "
  if OUT=$(cd "$APP_DIR" && "$VPY" -c "
import sys
sys.path.insert(0, '$DIR')
import config, worker
print('ok')
" 2>&1 | tail -1); then
    if [[ "$OUT" == "ok" ]]; then
      echo "ok"
    else
      echo "FAILED"
      echo "      $OUT"
      FAILED+=("$m (import)")
    fi
  else
    echo "FAILED"
    echo "      $OUT"
    FAILED+=("$m (import)")
  fi
done

echo
echo "══════════════════════════════════════════════════════════════"
if [[ ${#FAILED[@]} -eq 0 ]]; then
  echo "✅ All modules ready."
  echo
  echo "Next: verify the model weights are present and match the manifest."
  echo "The server prints this at boot:"
  echo '     🧩 model "vehicle": ok (checksums verified)'
  echo "A module reporting 'missing' needs its weights copied into"
  echo "models/<module>/weights/ — those are NOT installed by this script."
else
  echo "❌ ${#FAILED[@]} module(s) failed: ${FAILED[*]}"
  echo
  echo "Those analytics CANNOT run. The supervisor would spawn them, they would"
  echo "crash on import, and restart-loop without producing events."
  exit 1
fi

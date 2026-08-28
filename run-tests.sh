#!/usr/bin/env bash
# Run every test suite: platform (vitest) + model pipelines (python).
#
#   ./run-tests.sh
#
# stdin is redirected from /dev/null for each runner — npm otherwise consumes
# it and the loop below silently never executes.
set -u
cd "$(dirname "$0")"
ROOT="$PWD"
fail=0

echo "=== platform (TypeScript) ==="
npm test --silent < /dev/null || fail=1

for m in vehicle face person tamper object; do
  d="$ROOT/models/$m"
  [ -d "$d/tests" ] || continue

  py="$d/.venv/bin/python"
  [ -x "$py" ] || py="$ROOT/models/ppe/.venv/bin/python"
  [ -x "$py" ] || py="$(command -v python3)"

  echo
  echo "=== models/$m (Python) ==="
  ( cd "$d" && "$py" -m unittest discover -s tests < /dev/null ) || fail=1
done

echo
if [ $fail -eq 0 ]; then
  echo "✅ all suites passed"
else
  echo "❌ some suites failed"
fi
exit $fail

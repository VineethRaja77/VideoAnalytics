#!/usr/bin/env bash
#
# scripts/restore.sh — restore a VMS database dump.
#
# A backup nobody has ever restored is not a backup. Run this against a scratch
# database at least once before you need it for real.
#
# USAGE
#   ./scripts/restore.sh backups/vms-db-20260816-021500.dump
#   TARGET_DATABASE_URL=postgres://…/vms_restore_test ./scripts/restore.sh <dump>
#
# SAFETY
#   Refuses to overwrite the database named in .env unless you pass --force,
#   because the common disaster is restoring last week's dump over a working
#   production database by muscle memory.

set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DUMP="${1:-}"
FORCE="${2:-}"

trap 'echo "❌ RESTORE FAILED at line $LINENO — the target database may be in a PARTIAL state. Do not start the app against it until this is resolved." >&2' ERR

if [[ -z "$DUMP" ]]; then
  echo "Usage: $0 <dump-file> [--force]" >&2
  echo "Available dumps:" >&2
  ls -1t "$APP_DIR"/backups/vms-db-*.dump 2>/dev/null | head -10 >&2 || echo "  (none found in $APP_DIR/backups)" >&2
  exit 1
fi

[[ -f "$DUMP" ]] || { echo "❌ Dump not found: $DUMP" >&2; exit 1; }

if [[ -f "$APP_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$APP_DIR/.env"; set +a
fi

TARGET="${TARGET_DATABASE_URL:-${DATABASE_URL:-}}"
if [[ -z "$TARGET" ]]; then
  echo "❌ No target database. Set TARGET_DATABASE_URL or DATABASE_URL." >&2
  exit 1
fi

if [[ "$TARGET" == "${DATABASE_URL:-}" && "$FORCE" != "--force" ]]; then
  echo "❌ Refusing to restore over the LIVE database in .env." >&2
  echo "   Restore to a scratch database first:" >&2
  echo "     TARGET_DATABASE_URL=postgres://user:pass@host/vms_restore_test $0 $DUMP" >&2
  echo "   If you really mean to overwrite production, re-run with --force." >&2
  exit 1
fi

echo "▶ Verifying archive…"
pg_restore --list "$DUMP" >/dev/null || { echo "❌ $DUMP is not a readable pg_dump archive." >&2; exit 1; }

echo "▶ Restoring $DUMP → ${TARGET%%\?*}"
# --clean --if-exists: drop existing objects first, so a restore over a partly
# populated database does not fail halfway on duplicate keys.
# NOT --single-transaction: with --clean it aborts the whole restore on the
# first missing object, which is a common and harmless condition here.
pg_restore --clean --if-exists --no-owner --no-privileges --dbname="$TARGET" "$DUMP" 2>&1 |
  grep -v 'does not exist, skipping' || true

echo "▶ Verifying restored data…"
psql "$TARGET" -tAc "
  SELECT 'organizations=' || (SELECT count(*) FROM organizations)
      || ' users='        || (SELECT count(*) FROM users)
      || ' cameras='      || (SELECT count(*) FROM cameras)
      || ' licenses='     || (SELECT count(*) FROM licenses)
      || ' events='       || (SELECT count(*) FROM analytics_events)
      || ' audit_rows='   || (SELECT count(*) FROM audit_log);
"

cat <<'EOF'

✅ Restore complete.

BEFORE STARTING THE APP, CHECK THESE — each one silently breaks the system:

 1. SECRET_ENCRYPTION_KEY must be the SAME value used when the dump was taken.
    If it is not, every camera credential decrypts to null, cameras fail to
    connect, and the app now says so explicitly rather than failing silently.

 2. Video files are NOT in this dump. The recordings table lists files that must
    exist under RECORDINGS_BASE. If you restored onto a new host, either mount
    the original storage or expect the timeline to show entries whose files are
    missing.

 3. Sessions were restored but are tied to SESSION_SECRET. If that changed,
    every user is logged out — expected, not a fault.

 4. Licences carry a machine_fingerprint. Restoring onto DIFFERENT hardware may
    invalidate them; re-issue from the super_admin console if so.
EOF

#!/usr/bin/env bash
#
# scripts/backup.sh — nightly backup of everything a client cannot re-create.
#
# WHAT IS BACKED UP
#   - the Postgres database: users, orgs, licences, cameras, analytics events,
#     recording index, and the audit trail
#   - the .env encryption keys, SEPARATELY and only if BACKUP_INCLUDE_KEYS=true
#
# WHAT IS NOT, ON PURPOSE
#   - video recordings. On a real site these are hundreds of GB to tens of TB
#     and change constantly; copying them nightly would fill the backup target
#     faster than the primary disk. Recording retention is a storage-array
#     decision (RAID / NAS / separate volume), not a pg_dump decision.
#     The recordings TABLE is backed up, so after a restore the system knows
#     which files it expects and reports the missing ones instead of silently
#     showing an empty timeline.
#
# THE KEY WARNING
#   Camera credentials are encrypted with SECRET_ENCRYPTION_KEY. A database
#   backup WITHOUT that key restores to a system where every camera fails to
#   connect and the reason is invisible. The key must be stored separately from
#   the dump — together in one place and the encryption bought you nothing.
#
# USAGE
#   ./scripts/backup.sh                    # uses .env, writes to ./backups
#   BACKUP_DIR=/mnt/nas/vms ./scripts/backup.sh
#   Cron:  15 2 * * *  /opt/vms/scripts/backup.sh >> /var/log/vms/backup.log 2>&1

set -Eeuo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"

# Any failure must be loud and specific — a backup that fails silently is worse
# than no backup, because it is trusted.
trap 'echo "❌ BACKUP FAILED at line $LINENO — the database was NOT backed up. Investigate before relying on $BACKUP_DIR" >&2' ERR

if [[ -f "$APP_DIR/.env" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$APP_DIR/.env"; set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "❌ DATABASE_URL is not set (looked in $APP_DIR/.env and the environment)." >&2
  echo "   Nothing was backed up." >&2
  exit 1
fi

command -v pg_dump >/dev/null 2>&1 || {
  echo "❌ pg_dump not found. Install the postgresql-client package matching your server version." >&2
  exit 1
}

mkdir -p "$BACKUP_DIR"
DUMP="$BACKUP_DIR/vms-db-$STAMP.dump"

echo "▶ Backing up database to $DUMP"
# Custom format (-Fc): compressed, and restorable table-by-table with pg_restore.
pg_dump --format=custom --no-owner --no-privileges --file="$DUMP" "$DATABASE_URL"

# A dump that exists but is empty is the classic silent backup failure.
SIZE=$(stat -c%s "$DUMP")
if (( SIZE < 4096 )); then
  echo "❌ Dump is only ${SIZE} bytes — that is not a valid backup. Refusing to report success." >&2
  exit 1
fi

# Verify the dump is readable before trusting it. pg_restore --list parses the
# archive's table of contents; if it cannot, the file is corrupt.
if ! pg_restore --list "$DUMP" >/dev/null 2>&1; then
  echo "❌ Dump at $DUMP is unreadable by pg_restore — corrupt archive." >&2
  exit 1
fi
TABLES=$(pg_restore --list "$DUMP" | grep -c 'TABLE DATA' || true)
echo "✔ Database backed up: $(numfmt --to=iec "$SIZE" 2>/dev/null || echo "$SIZE bytes"), $TABLES tables with data"

# ---- encryption keys, separately and opt-in ----
if [[ "${BACKUP_INCLUDE_KEYS:-false}" == "true" ]]; then
  KEYFILE="$BACKUP_DIR/vms-keys-$STAMP.env"
  {
    echo "# Restore-critical secrets for the VMS database dump of $STAMP."
    echo "# Without SECRET_ENCRYPTION_KEY, every camera credential in the dump is"
    echo "# unrecoverable and cameras will fail to connect after a restore."
    echo "# STORE THIS SEPARATELY FROM THE DUMP."
    grep -E '^(SECRET_ENCRYPTION_KEY|SESSION_SECRET|LICENSE_SIGNING_KEY)=' "$APP_DIR/.env" || true
  } > "$KEYFILE"
  chmod 600 "$KEYFILE"
  echo "✔ Keys written to $KEYFILE (mode 600) — move this to a DIFFERENT location than the dump"
else
  echo "ℹ Keys NOT included (BACKUP_INCLUDE_KEYS != true)."
  echo "  Ensure SECRET_ENCRYPTION_KEY is backed up somewhere, or camera credentials"
  echo "  cannot be recovered from this dump."
fi

# ---- retention ----
if [[ "$RETENTION_DAYS" -gt 0 ]]; then
  DELETED=$(find "$BACKUP_DIR" -maxdepth 1 -name 'vms-db-*.dump' -mtime "+$RETENTION_DAYS" -print -delete | wc -l)
  find "$BACKUP_DIR" -maxdepth 1 -name 'vms-keys-*.env' -mtime "+$RETENTION_DAYS" -delete 2>/dev/null || true
  [[ "$DELETED" -gt 0 ]] && echo "🧹 Removed $DELETED backup(s) older than $RETENTION_DAYS days"
fi

# ---- free space on the backup target ----
AVAIL_KB=$(df -Pk "$BACKUP_DIR" | awk 'NR==2 {print $4}')
if (( AVAIL_KB < SIZE / 1024 * 3 )); then
  echo "⚠ Backup target has less than 3× the space of one dump left." >&2
  echo "  $BACKUP_DIR will stop accepting backups soon. Free space or lower BACKUP_RETENTION_DAYS." >&2
fi

echo "✅ Backup complete: $DUMP"

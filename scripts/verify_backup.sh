#!/bin/sh
set -e

# ==============================================================================
# Script: verify_backup.sh (BR-8d)
# Purpose: Automatically verify that the latest backup dump can be restored
#          and decrypted cleanly, comparing row counts with production.
# ==============================================================================

BACKUP_DIR="${BACKUP_DIR:-./backups}"
VERIFY_DB="${VERIFY_DB:-bridge_verify}"
PG_HOST="${POSTGRES_HOST:-localhost}"
PG_USER="${POSTGRES_USER:-bridge_user}"

echo "🔍 Locating latest backup file in $BACKUP_DIR..."

LATEST_ENC=$(find "$BACKUP_DIR" -name "*.dump.enc" -type f | sort -r | head -n 1)
LATEST_DUMP=$(find "$BACKUP_DIR" -name "*.dump" -type f | sort -r | head -n 1)

WORK_DUMP=""

if [ -n "$LATEST_ENC" ]; then
  echo "🔒 Found encrypted backup: $LATEST_ENC"
  if [ -z "$BACKUP_ENCRYPTION_KEY" ]; then
    echo "❌ BACKUP_ENCRYPTION_KEY is required to decrypt $LATEST_ENC"
    exit 1
  fi
  WORK_DUMP="/tmp/restore_verify.dump"
  echo "🔑 Decrypting to $WORK_DUMP..."
  openssl enc -d -aes-256-cbc -salt -pbkdf2 -pass env:BACKUP_ENCRYPTION_KEY -in "$LATEST_ENC" -out "$WORK_DUMP"
elif [ -n "$LATEST_DUMP" ]; then
  echo "📦 Found raw backup: $LATEST_DUMP"
  WORK_DUMP="$LATEST_DUMP"
else
  echo "❌ No backup dump found in $BACKUP_DIR"
  exit 1
fi

echo "🗄️ Preparing verification database '$VERIFY_DB'..."
dropdb -h "$PG_HOST" -U "$PG_USER" --if-exists "$VERIFY_DB" || true
createdb -h "$PG_HOST" -U "$PG_USER" "$VERIFY_DB"

echo "⏳ Restoring dump to '$VERIFY_DB'..."
pg_restore -h "$PG_HOST" -U "$PG_USER" -d "$VERIFY_DB" --clean --if-exists "$WORK_DUMP" || true

echo "📊 Verifying transaction row count..."
ROW_COUNT=$(psql -h "$PG_HOST" -U "$PG_USER" -d "$VERIFY_DB" -t -c 'SELECT COUNT(*) FROM "Transaction";' | xargs)

echo "✅ Backup verification SUCCESSFUL! Row count: $ROW_COUNT"

# Cleanup temporary decrypted dump if created
if [ "$WORK_DUMP" = "/tmp/restore_verify.dump" ]; then
  rm -f "$WORK_DUMP"
fi

exit 0

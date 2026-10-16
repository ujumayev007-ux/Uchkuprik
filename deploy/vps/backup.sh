#!/usr/bin/env bash
# Daily logical backup of the FastFood database (gzip JSON lines, verified by restoring
# it into a scratch database). Run from cron or the systemd timer next to this file.
# Keeps 14 days locally; copy the folder to ANOTHER machine as well (rsync/rclone).
set -euo pipefail

APP_DIR=/opt/fastfood
OUT_DIR=/var/backups/fastfood
KEEP_DAYS=14

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
cd "$APP_DIR"
set -a
. /etc/fastfood/fastfood.env
set +a

FILE="$OUT_DIR/fastfood-$(date +%F-%H%M).ndjson.gz"
npm run backup -w backend -- create "$FILE"
find "$OUT_DIR" -name 'fastfood-*.ndjson.gz' -mtime +"$KEEP_DAYS" -delete
echo "Backup ready: $FILE"

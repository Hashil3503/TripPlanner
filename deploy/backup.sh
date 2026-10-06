#!/bin/sh
# DB 백업: 실행 중에도 안전한 SQLite 스냅샷(VACUUM INTO)을 만들고 14일 지난 백업은 지운다.
# cron 예) 매일 새벽 4시:  0 4 * * * /opt/tripplanner/deploy/backup.sh
# 같은 서버 디스크에만 두면 서버가 사라질 때 함께 사라지므로, 가끔은 내 PC로 내려받거나 Object Storage에 올려 두자.
set -eu
DB="${TP_DB_PATH:-/opt/tripplanner/data/tripplanner.db}"
DIR="${TP_BACKUP_DIR:-/opt/tripplanner/data/backups}"
mkdir -p "$DIR"
OUT="$DIR/tripplanner-$(date +%Y%m%d-%H%M%S).db"
node -e "const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.argv[1]); db.exec(\"VACUUM INTO '\" + process.argv[2].replace(/'/g, \"''\") + \"'\"); db.close();" "$DB" "$OUT"
find "$DIR" -name 'tripplanner-*.db' -mtime +14 -delete
echo "백업 완료: $OUT"

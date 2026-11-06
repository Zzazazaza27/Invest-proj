#!/bin/bash
# Что лежит в рабочем бакете и что видели комплекты. Только чтение, значений не печатает.
set -uo pipefail
cd /opt/fifth-element
echo '== бакет сейчас'
node --input-type=module -e "
import { loadEnv, standNetwork, rclone, cfg } from './scripts/lib/backup.mjs';
loadEnv();
const r = rclone(['lsjson', '-R', '--files-only', '--no-mimetype', 'SRC:' + cfg().bucket], { network: standNetwork() });
for (const o of JSON.parse(r.stdout)) console.log(o.ModTime.slice(0, 19), o.Size, o.Path);
" 2>&1 | cut -c1-200
echo '== комплекты с файлами проектов'
for file in /var/backups/fifth-element/sets/*/catalog.json; do
  node -e "
const c = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
const p = c.files.objects.filter((o) => o.key.startsWith('projects/')).map((o) => o.key.split('/').slice(-2).join('/').slice(-46));
if (p.length) console.log(c.id, c.files.count, p.join(' '));
" "$file"
done | tail -12
echo '== Garage'
for name in $(docker ps --format '{{.Names}}' | grep -i garage); do echo "$name: $(docker inspect "$name" --format '{{.State.StartedAt}}' | cut -c1-19)"; done
first="$(docker ps --format '{{.Names}}' | grep -i garage | head -1)"
docker exec "$first" /garage status 2>&1 | tail -8 | cut -c1-120
docker exec "$first" /garage stats 2>&1 | grep -iE 'resync|error|block' | head -8 | cut -c1-120
docker exec "$first" /garage block list-errors 2>&1 | head -6 | cut -c1-120

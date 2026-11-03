#!/usr/bin/env node
/**
 * Перенос файлов между хранилищами: MinIO → Garage (переход, D-001) и
 * обратно (возврат). План — docs/architecture/garage-migration-plan.md.
 *
 * Запускается при ОСТАНОВЛЕННЫХ записях (вход файлов 503, ядро остановлено,
 * запись источника закрыта) — скрипт это не обеспечивает, а проверяет:
 *   1. каждый текущий объект источника → приёмник; сверка SHA-256 по
 *      прочитанному ОБРАТНО из приёмника, тип содержимого сохраняется;
 *   2. объект уже есть в приёмнике: тот же SHA-256 — пропуск; другой —
 *      конфликт и остановка (без перезаписи), с `--sync` — перезапись
 *      (для возврата: файл изменился после переключения);
 *   3. повторный список источника после переноса — тот же (ключи, размеры,
 *      ETag): источник не принимал изменений незаметно для переноса;
 *   4. каждый ключ, на который ссылается база (материалы, обложки, аватары),
 *      есть в приёмнике; незавершённые загрузки — отдельным списком;
 *   5. объекты приёмника, которых нет в источнике, — списком (при возврате
 *      это файлы, появившиеся после переключения).
 * Отчёт — out/storage-migrate/<время>.json. Ничего не удаляет.
 *
 *   node scripts/storage-migrate.mjs --from minio --to garage [--dry-run] [--sync]
 *   node scripts/storage-migrate.mjs --from garage --to minio --sync   (возврат)
 *
 * MinIO — root-учётка (MINIO_ROOT_*), адрес MIGRATE_MINIO_ENDPOINT (по
 * умолчанию петля :S3_PORT); Garage — ключ приложения (S3_ACCESS_KEY_ID),
 * адрес MIGRATE_GARAGE_ENDPOINT (петля :GARAGE_S3_PORT). Бакет — S3_BUCKET.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { loadEnv, ROOT } from './lib/backup.mjs';
import { PORTS } from './lib/ports.mjs';
import { s3Object } from './lib/s3.mjs';

loadEnv();
const env = process.env;
const arg = (n) => {
  const i = process.argv.indexOf(n);
  return i > 0 ? process.argv[i + 1] : null;
};
const DRY = process.argv.includes('--dry-run');
const SYNC = process.argv.includes('--sync');
const bucket = env.S3_BUCKET || 'unicorn-launch';
const stores = {
  minio: {
    endpoint: (env.MIGRATE_MINIO_ENDPOINT || `http://127.0.0.1:${PORTS.s3}`).replace(/\/+$/, ''),
    bucket,
    region: env.S3_REGION || 'us-east-1',
    accessKey: env.MINIO_ROOT_USER,
    secretKey: env.MINIO_ROOT_PASSWORD,
  },
  garage: {
    endpoint: (env.MIGRATE_GARAGE_ENDPOINT || `http://127.0.0.1:${PORTS.garageS3}`).replace(
      /\/+$/,
      '',
    ),
    bucket,
    region: env.S3_REGION || 'us-east-1',
    accessKey: env.S3_ACCESS_KEY_ID,
    secretKey: env.S3_SECRET_ACCESS_KEY,
  },
};
const fromName = arg('--from');
const toName = arg('--to');
if (!stores[fromName] || !stores[toName] || fromName === toName) {
  console.error('нужно --from minio|garage --to garage|minio');
  process.exit(2);
}
const src = stores[fromName];
const dst = stores[toName];
const sha = (b) => createHash('sha256').update(b).digest('hex');

async function list(store) {
  const out = new Map();
  let token = null;
  do {
    const q = {
      'list-type': '2',
      'max-keys': '1000',
      ...(token ? { 'continuation-token': token } : {}),
    };
    const r = await s3Object(store, 'GET', '', null, {}, q);
    if (r.status !== 200) throw new Error(`список ${store.endpoint}: HTTP ${r.status}`);
    const xml = await r.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = m[1].match(/<Key>([^<]+)<\/Key>/)[1].replace(/&amp;/g, '&');
      out.set(key, {
        size: Number(m[1].match(/<Size>(\d+)<\/Size>/)?.[1] ?? -1),
        etag: (m[1].match(/<ETag>([^<]+)<\/ETag>/)?.[1] ?? '').replace(/&quot;|"/g, ''),
      });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1]
      : null;
  } while (token);
  return out;
}

async function get(store, key) {
  const r = await s3Object(store, 'GET', key);
  if (r.status === 404) return null;
  if (r.status !== 200) throw new Error(`GET ${key}: HTTP ${r.status}`);
  return {
    body: Buffer.from(await r.arrayBuffer()),
    type: r.headers.get('content-type') || 'application/octet-stream',
  };
}

/** Ключи, на которые ссылается база. */
async function dbKeys() {
  const client = new pg.Client({ connectionString: env.DATABASE_URL_OWNER || env.DATABASE_URL });
  await client.connect();
  try {
    const q = async (sql) => (await client.query(sql)).rows;
    const ready = await q(
      `SELECT s3_key AS key FROM lab.project_materials WHERE s3_key IS NOT NULL
       UNION SELECT master_key FROM lab.project_media
       UNION SELECT v.value->>'key' FROM lab.project_media, jsonb_each(variants) v
       UNION SELECT master_key FROM identity.user_avatars
       UNION SELECT v.value->>'key' FROM identity.user_avatars, jsonb_each(variants) v`,
    );
    const pending = await q(
      `SELECT upload_key AS key FROM lab.project_materials
        WHERE upload_key IS NOT NULL AND upload_state IN ('pending', 'needs_attention')`,
    );
    return {
      ready: ready.map((r) => r.key).filter(Boolean),
      pending: pending.map((r) => r.key).filter(Boolean),
    };
  } finally {
    await client.end();
  }
}

const report = {
  at: new Date().toISOString(),
  from: fromName,
  to: toName,
  bucket,
  dryRun: DRY,
  sync: SYNC,
  copied: [],
  same: 0,
  overwritten: [],
  conflicts: [],
  problems: [],
};
console.log(`=== ПЕРЕНОС ${fromName} → ${toName} (бакет ${bucket})${DRY ? ', пробный' : ''} ===`);
const before = await list(src);
const target = await list(dst);
const bytes = [...before.values()].reduce((n, o) => n + o.size, 0);
console.log(`источник: объектов ${before.size}, байт ${bytes}; приёмник: объектов ${target.size}`);

for (const key of [...before.keys()].sort()) {
  const s = await get(src, key);
  if (!s) {
    report.problems.push(`${key}: исчез из источника во время переноса`);
    continue;
  }
  const want = sha(s.body);
  const have = target.has(key) ? await get(dst, key) : null;
  if (have && sha(have.body) === want) {
    report.same++;
    continue;
  }
  if (have && !SYNC) {
    report.conflicts.push(key);
    continue;
  }
  if (DRY) {
    (have ? report.overwritten : report.copied).push({ key, size: s.body.length, sha256: want });
    continue;
  }
  // Запись с повтором: обрыв соединения на большом объекте (500 МиБ на
  // стенде 03.11) — не повод бросать перенос; итог решает сверка ниже.
  let put = null;
  let lastError = '';
  for (let attempt = 1; attempt <= 3 && put?.status !== 200; attempt++) {
    try {
      put = await s3Object(dst, 'PUT', key, s.body, { 'content-type': s.type });
      if (put.status !== 200) lastError = `HTTP ${put.status}`;
    } catch (e) {
      lastError = e?.cause?.code || e?.name || 'сбой соединения';
      report.retries = (report.retries ?? 0) + 1;
    }
  }
  if (put?.status !== 200) {
    report.problems.push(`${key}: запись в приёмник не удалась (${lastError})`);
    continue;
  }
  const back = await get(dst, key);
  if (!back || sha(back.body) !== want) {
    report.problems.push(`${key}: прочитанное из приёмника не совпало по SHA-256`);
    continue;
  }
  (have ? report.overwritten : report.copied).push({ key, size: s.body.length, sha256: want });
}

// Источник не принимал изменений во время переноса.
const after = await list(src);
const changed = [...new Set([...before.keys(), ...after.keys()])].filter((k) => {
  const a = before.get(k);
  const b = after.get(k);
  return !a || !b || a.size !== b.size || a.etag !== b.etag;
});
if (changed.length) {
  report.problems.push(
    `источник изменился во время переноса (${changed.length}): ${changed.slice(0, 5).join(', ')}`,
  );
}

// Ссылки из базы — в приёмнике.
const refs = await dbKeys();
const finalTarget = DRY ? target : await list(dst);
const missingReady = refs.ready.filter((k) => !finalTarget.has(k) && !(DRY && before.has(k)));
const missingPending = refs.pending.filter((k) => !finalTarget.has(k) && !(DRY && before.has(k)));
if (missingReady.length) {
  report.problems.push(
    `готовые объекты из базы отсутствуют в приёмнике (${missingReady.length}): ${missingReady.slice(0, 5).join(', ')}`,
  );
}
report.db = {
  readyKeys: refs.ready.length,
  missingReady,
  pendingUploads: refs.pending.length,
  pendingWithoutObject: missingPending.length,
};
report.extraInTarget = [...finalTarget.keys()].filter((k) => !before.has(k));
report.sourceObjects = before.size;
report.sourceBytes = bytes;

const outDir = join(ROOT, 'out', 'storage-migrate');
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${report.at.replace(/[:.]/g, '-')}-${fromName}-${toName}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
console.log(
  `скопировано ${report.copied.length}, уже было ${report.same}, перезаписано ${report.overwritten.length}, конфликтов ${report.conflicts.length}`,
);
console.log(
  `база: готовых ключей ${refs.ready.length}, отсутствуют в приёмнике ${missingReady.length}; незавершённых загрузок ${refs.pending.length} (без объекта ${missingPending.length})`,
);
console.log(`в приёмнике сверх источника: ${report.extraInTarget.length}`);
for (const p of report.problems) console.log(`ПРОБЛЕМА: ${p}`);
for (const k of report.conflicts.slice(0, 5))
  console.log(`КОНФЛИКТ: ${k} — в приёмнике другое содержимое`);
const ok = !report.problems.length && !report.conflicts.length;
console.log(
  ok
    ? `ИТОГ: перенос сошёлся — каждый объект источника в приёмнике с тем же SHA-256, источник не менялся, ссылки базы на месте (${file})`
    : `ИТОГ: перенос НЕ сошёлся (${file})`,
);
process.exit(ok ? 0 : 1);

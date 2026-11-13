#!/usr/bin/env node
/**
 * Правило lifecycle одного бакета Garage (2.1.2, работа № 4): незавершённые multipart-загрузки
 * удаляются через сутки, объекты не трогаются. Отдельно от garage-init: тот настраивает бакеты
 * рабочей среды по её .env (prod) и заодно перезаписывает их CORS — для бакета тестовой среды
 * он не годится (13.11, общая приёмка, шаг 1.5).
 *
 *   node scripts/garage-lifecycle.mjs <бакет> [--region <регион>]
 *
 * Правило ставит временный ключ с правом записи и владельца бакета; ключ удаляется.
 * Токен админ-API — GARAGE_ADMIN_TOKEN. Секреты не печатаются.
 */
import { applyFilesLifecycle, garageApi } from './lib/garage-admin.mjs';
import { PORTS } from './lib/ports.mjs';
import { s3Object } from './lib/s3.mjs';

const argv = process.argv.slice(2);
const bucket = argv[0];
if (!/^[a-z0-9][a-z0-9.-]{1,62}$/.test(bucket ?? '')) {
  console.error('нужен бакет');
  process.exit(2);
}
const region = argv.includes('--region') ? argv[argv.indexOf('--region') + 1] : 'garage';
const info = await garageApi(
  'GetBucketInfo',
  undefined,
  `?globalAlias=${encodeURIComponent(bucket)}`,
);
const tmp = await garageApi('CreateKey', { name: `lifecycle-${bucket}` });
try {
  await garageApi('AllowBucketKey', {
    bucketId: info.id,
    accessKeyId: tmp.accessKeyId,
    permissions: { read: true, write: true, owner: true },
  });
  const storage = {
    endpoint: `http://127.0.0.1:${PORTS.garageS3}`,
    region,
    accessKey: tmp.accessKeyId,
    secretKey: tmp.secretAccessKey,
  };
  await applyFilesLifecycle(storage, bucket);
  const back = await s3Object({ ...storage, bucket }, 'GET', '', null, {}, { lifecycle: '' });
  const text = await back.text();
  const same = text.replace(/\s+/g, '').includes('<DaysAfterInitiation>1</DaysAfterInitiation>');
  console.log(
    `lifecycle ${bucket}: ${same ? 'стоит — незавершённые multipart через 1 день' : `не подтверждён (HTTP ${back.status})`}`,
  );
  if (!same) process.exitCode = 1;
} finally {
  await garageApi('DeleteKey', {}, `?id=${tmp.accessKeyId}`);
}

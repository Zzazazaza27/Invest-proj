#!/usr/bin/env node
/**
 * Контрольный объект тестовой среды (M153): файл в бакете среды и запись с размером и SHA-256 —
 * как `monitoring.mjs control-init` на prod. Без него контрольная операция ядра (/control)
 * отвечает 503, и установка через слоты откатывается на проверке кандидата.
 * Идемпотентно: при существующей записи ничего не меняет. Значений не печатает.
 *
 *   node scripts/env-control-init.mjs <test-1|test-2>
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { s3Object } from './lib/s3.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV = process.argv[2];
if (!/^test-[12]$/.test(ENV ?? '')) {
  console.error('среда: test-1 или test-2');
  process.exit(2);
}
const DIR = join(ROOT, '.local', 'envs', ENV);
const KEY = 'control/probe-v1';

const psql = (sql) => {
  const r = spawnSync(
    'docker',
    [
      'exec',
      '-e',
      'PGPASSWORD',
      `fifth-${ENV}-postgres`,
      'psql',
      '-X',
      '-At',
      '-h',
      '127.0.0.1',
      '-U',
      'fifth_owner',
      '-d',
      'fifth_element',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    {
      encoding: 'utf8',
      // Пароль — из файла секретов среды, через окружение (не в командной строке).
      env: {
        ...process.env,
        PGPASSWORD: readFileSync(join(DIR, 'secrets', 'POSTGRES_PASSWORD'), 'utf8').trim(),
      },
    },
  );
  if (r.status !== 0) throw new Error(`база: ${(r.stderr ?? '').trim().slice(-200)}`);
  return r.stdout.trim();
};

if (psql("SELECT count(*) FROM audit.control_objects WHERE name = 'probe'") === '1') {
  console.log(`${ENV}: контрольный объект уже заведён`);
  process.exit(0);
}
const keys = JSON.parse(readFileSync(join(DIR, 'storage.json'), 'utf8'));
const region = readFileSync(join(DIR, 'settings.env'), 'utf8')
  .match(/^S3_REGION=(.*)$/m)[1]
  .trim();
const body = Buffer.concat([
  Buffer.from('5E control object v1 — служебный файл наблюдения, без пользовательских данных\n'),
  randomBytes(4096),
]);
const sha256 = createHash('sha256').update(body).digest('hex');
const put = await s3Object(
  {
    endpoint: 'http://127.0.0.1:9000',
    bucket: `fifth-${ENV}`,
    region,
    accessKey: keys.app.accessKeyId,
    secretKey: keys.app.secretAccessKey,
  },
  'PUT',
  KEY,
  body,
  { 'content-type': 'application/octet-stream' },
);
if (put.status !== 200) {
  console.error(`${ENV}: контрольный файл не записан — HTTP ${put.status}`);
  process.exit(1);
}
psql(
  `INSERT INTO audit.control_objects (name, s3_key, size_bytes, sha256) VALUES ('probe', '${KEY}', ${body.length}, '${sha256}') ON CONFLICT DO NOTHING`,
);
console.log(`${ENV}: контрольный объект заведён — ${KEY}, ${body.length} байт`);

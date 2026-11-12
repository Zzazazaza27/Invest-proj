/**
 * Admin API Garage (v2) для скриптов стенда: настройка кластера
 * (garage-init) и испытания, которым нужно управлять правами ключа.
 *
 * Адрес — петля первого узла (GARAGE_ADMIN_URL или GARAGE_ADMIN_PORT),
 * токен — GARAGE_ADMIN_TOKEN. Токен не печатается.
 */
import { PORTS } from './ports.mjs';

export async function garageApi(name, body, query = '') {
  const admin = (process.env.GARAGE_ADMIN_URL || `http://127.0.0.1:${PORTS.garageAdmin}`).replace(
    /\/+$/,
    '',
  );
  const token = process.env.GARAGE_ADMIN_TOKEN;
  if (!token) throw new Error('GARAGE_ADMIN_TOKEN не задан');
  const r = await fetch(`${admin}/v2/${name}${query}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  if (!r.ok) {
    const err = new Error(`${name}: HTTP ${r.status} ${text.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/** ID бакета по глобальному имени. */
export async function garageBucketId(alias) {
  const b = await garageApi(
    'GetBucketInfo',
    undefined,
    `?globalAlias=${encodeURIComponent(alias)}`,
  );
  return b.id;
}

/**
 * Снять или вернуть права ключа на бакет (`{read, write, owner}` — только
 * перечисленные). Для испытаний: отказ хранилища без поломки сети.
 */
export async function garageSetKeyPermissions(alias, accessKeyId, permissions, allow) {
  await garageApi(allow ? 'AllowBucketKey' : 'DenyBucketKey', {
    bucketId: await garageBucketId(alias),
    accessKeyId,
    permissions: { read: false, write: false, owner: false, ...permissions },
  });
}

/** Образ Garage — тот же, что в infra/docker-compose.yml (D-001, v2.4.1). */
export const GARAGE_IMAGE =
  'dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020';

/** Новый ключ формата Garage: GK + 24 hex и секрет 64 hex. */
export function garageKeyPair(randomBytes) {
  return {
    id: `GK${randomBytes(12).toString('hex')}`,
    secret: randomBytes(32).toString('hex'),
  };
}

/**
 * Набор переменных Garage из отдельного файла (`--keys-file`): до окна
 * переноса Garage настраивается и наполняется им, а рабочий .env — и вместе
 * с ним ядро, копии W07, архив событий — остаётся на прежнем хранилище.
 * Значения файла перекрывают окружение только этого процесса.
 */
export function applyKeysFile(argv, parseEnvFile) {
  const i = argv.indexOf('--keys-file');
  if (i < 0) return null;
  const path = argv[i + 1];
  const vars = parseEnvFile(path);
  if (!Object.keys(vars).length) throw new Error(`--keys-file: пусто или нет файла (${path})`);
  Object.assign(process.env, vars);
  return path;
}

/**
 * Lifecycle бакета файлов (2.1.2; работа № 4 раздела 01): незавершённые multipart-загрузки
 * удаляются через сутки. Объекты правило НЕ удаляет (нет Expiration): готовые файлы, служебные
 * копии (их чистит работа № 8 по своим проверкам) и всё прочее остаётся. Ядро грузит формой
 * (один запрос), multipart может начать только клиент с ключом записи — правило убирает его
 * брошенные части, чтобы они не копились на диске. Garage применяет правило раз в сутки.
 */
export const FILES_LIFECYCLE_XML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
  '<Rule><ID>abort-incomplete-multipart</ID><Status>Enabled</Status><Filter><Prefix></Prefix></Filter>' +
  '<AbortIncompleteMultipartUpload><DaysAfterInitiation>1</DaysAfterInitiation></AbortIncompleteMultipartUpload>' +
  '</Rule></LifecycleConfiguration>';

/** Поставить правило ключом с правом владельца бакета. */
export async function applyFilesLifecycle(storage, bucket) {
  const { s3Object } = await import('./s3.mjs');
  const { createHash } = await import('node:crypto');
  const body = Buffer.from(FILES_LIFECYCLE_XML);
  const r = await s3Object(
    { ...storage, bucket },
    'PUT',
    '',
    body,
    {
      'content-md5': createHash('md5').update(body).digest('base64'),
      'content-type': 'application/xml',
    },
    { lifecycle: '' },
  );
  if (!r.ok)
    throw new Error(`lifecycle ${bucket}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
}

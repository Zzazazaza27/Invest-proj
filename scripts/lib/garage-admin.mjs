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

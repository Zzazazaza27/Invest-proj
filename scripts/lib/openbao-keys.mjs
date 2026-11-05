/**
 * Рабочие ключи в Transit (блок 5, задание 5). Значения ключей и пароль живут только в памяти.
 *
 * `call(method, path, { token, body })` — запрос к OpenBao по TLS.
 */
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { importTransitKey } from './openbao-import.mjs';

/** Домены и переменные: поисковый ключ идёт отдельно, как HMAC. */
export const KEK_DOMAINS = [
  { env: 'KEK_PASSPORT_SENSITIVE', key: 'passport-sensitive', type: 'aes256-gcm96' },
  { env: 'KEK_KYB_DOCUMENTS', key: 'kyb-documents', type: 'aes256-gcm96' },
  { env: 'KEK_KYC_DOCUMENTS', key: 'kyc-documents', type: 'aes256-gcm96' },
  { env: 'KEK_WEBHOOK_SECRETS', key: 'webhook-secrets', type: 'aes256-gcm96' },
  { env: 'KEK_SEARCH_INDEX', key: 'search-index', type: 'hmac' },
];

/** Токен живёт ровно на время работы и отзывается при любом исходе. */
export async function withOperatorToken(call, password, work) {
  const login = await call('POST', 'auth/userpass/login/thomas', { body: { password } });
  const token = login.json.auth?.client_token;
  if (!token) throw new Error(`личный вход не прошёл, код ${login.status}`);
  try {
    return await work(token);
  } finally {
    await call('POST', 'auth/token/revoke-self', { token });
  }
}

/** Контроль версии 1: совпадает ли ключ в Transit с нашим. Значений наружу не отдаёт. */
async function sameKey(call, token, name, type, key) {
  const probe = randomBytes(32);
  if (type === 'hmac') {
    const r = await call('POST', `transit/hmac/${name}/sha2-256`, {
      token,
      body: { input: probe.toString('base64'), key_version: 1 },
    });
    const local = createHmac('sha256', key).update(probe).digest('base64');
    return r.json.data?.hmac === `vault:v1:${local}`;
  }
  const iv = randomBytes(12);
  const aad = Buffer.from(`import-check:${name}`);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  cipher.setAAD(aad);
  const body = Buffer.concat([cipher.update(probe), cipher.final()]);
  const raw = Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64');
  const r = await call('POST', `transit/decrypt/${name}`, {
    token,
    body: { ciphertext: `vault:v1:${raw}`, associated_data: aad.toString('base64') },
  });
  return r.json.data?.plaintext === probe.toString('base64');
}

/**
 * Занятое имя не перезаписывается и новую версию не получает: сверяется версия 1. Чужой ключ
 * останавливает весь импорт, остальные домены после него не трогаются.
 */
export async function ensureKeys(call, token, prefix, keys) {
  const report = [];
  for (const { env, key, type } of KEK_DOMAINS) {
    const value = keys[env];
    if (!value) throw new Error(`в комплекте нет ${env}`);
    const bytes = Buffer.from(value, 'base64');
    if (bytes.length !== 32) throw new Error(`${env}: неверная длина`);
    const name = `${prefix}-${key}`;
    const existing = await call('GET', `transit/keys/${name}`, { token });
    let action = 'уже на месте';
    if (existing.status === 404) {
      const made = await importTransitKey(
        (method, path, options) => call(method, path, { ...options, token }),
        name,
        type,
        bytes,
        { allow_rotation: true },
      );
      if (made.status >= 300) throw new Error(`${name}: импорт отклонён, код ${made.status}`);
      action = 'импортирован';
    } else if (existing.status >= 300) {
      throw new Error(`${name}: чтение отклонено, код ${existing.status}`);
    } else if (existing.json.data?.type !== type) {
      throw new Error(`${name}: занято ключом другого типа`);
    }
    if (!(await sameKey(call, token, name, type, bytes))) {
      throw new Error(`${name}: версия 1 не совпала с ключом комплекта, импорт остановлен`);
    }
    report.push({ name, action });
  }
  return report;
}

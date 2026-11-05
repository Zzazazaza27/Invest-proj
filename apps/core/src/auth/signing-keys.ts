import { getEnv } from '../config/env';

/**
 * Версии ключей подписи: вход, CSRF, интеграции (блок 5, задание 4).
 *
 * `<ИМЯ>` — прежний ключ, им подписаны токены без kid. `<ИМЯ>_VERSIONS` — зарегистрированные версии
 * вида `kid:секрет,kid:секрет`. `<ИМЯ>_ACTIVE` — версия для новых токенов.
 *
 * Пока ACTIVE пуст, токены выпускаются прежним форматом и понятны старому выпуску. Это и есть
 * граница возврата: она начинается с первого токена с kid. После включения ACTIVE токены без kid
 * принимаются только до `<ИМЯ>_LEGACY_UNTIL`.
 *
 * Ключ выбирается только по kid, перебора нет. Неизвестная или снятая версия — отказ.
 */
export type SigningKeyName =
  'LOCAL_AUTH_SIGNING_KEY' | 'CSRF_SIGNING_KEY' | 'INTEGRATION_TOKEN_SIGNING_KEY';

export const SIGNING_KEY_NAMES: readonly SigningKeyName[] = [
  'LOCAL_AUTH_SIGNING_KEY',
  'CSRF_SIGNING_KEY',
  'INTEGRATION_TOKEN_SIGNING_KEY',
];

const KID_PATTERN = /^[a-z0-9-]{1,32}$/;

/** Разбор `kid:секрет,…`. Секрет наружу не попадает и в сообщении об ошибке. */
export function parseKeyVersions(raw: string): Map<string, string> {
  const versions = new Map<string, string>();
  for (const entry of raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const colon = entry.indexOf(':');
    const kid = entry.slice(0, Math.max(colon, 0));
    if (!KID_PATTERN.test(kid) || versions.has(kid)) {
      throw new Error('версии ключа подписи заданы неверно');
    }
    versions.set(kid, entry.slice(colon + 1));
  }
  return versions;
}

/** Ключ для новых токенов. */
export function issuingKey(name: SigningKeyName): { kid: string | null; secret: string } {
  const env = getEnv();
  const kid = env[`${name}_ACTIVE`];
  if (!kid) return { kid: null, secret: env[name] };
  const secret = parseKeyVersions(env[`${name}_VERSIONS`]).get(kid);
  if (!secret) throw new Error('действующая версия ключа подписи не зарегистрирована');
  return { kid, secret };
}

/** Ключ для проверки. `null` — такой токен не принимается. */
export function verifyingSecret(name: SigningKeyName, kid: string | null): string | null {
  const env = getEnv();
  if (kid !== null) {
    if (!KID_PATTERN.test(kid)) return null;
    return parseKeyVersions(env[`${name}_VERSIONS`]).get(kid) ?? null;
  }
  if (!env[`${name}_ACTIVE`]) return env[name];
  return Date.now() < Date.parse(env[`${name}_LEGACY_UNTIL`]) ? env[name] : null;
}

/** Части подписанного токена: две — прежний формат, три — с kid впереди. */
export function splitSigned(token: string): { kid: string | null; parts: [string, string] } | null {
  const parts = token.split('.');
  if (parts.length === 2 && parts[0] && parts[1]) {
    return { kid: null, parts: [parts[0], parts[1]] };
  }
  if (parts.length === 3 && parts[0] && parts[1] && parts[2]) {
    return { kid: parts[0], parts: [parts[1], parts[2]] };
  }
  return null;
}

/** Токен с версией подписывается вместе с kid: версию нельзя подменить, не сломав подпись. */
export function signedText(kid: string | null, text: string): string {
  return kid === null ? text : `${kid}.${text}`;
}

export function joinSigned(kid: string | null, first: string, signature: string): string {
  return kid === null ? `${first}.${signature}` : `${kid}.${first}.${signature}`;
}

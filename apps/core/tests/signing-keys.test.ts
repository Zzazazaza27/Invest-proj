import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueCsrfToken, isCsrfTokenValid } from '../src/auth/csrf';
import { TokenVerifier } from '../src/auth/token.verifier';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { issueServiceToken, verifyServiceToken } from '../src/integration/service-auth';

/** Версии подписей: вход, CSRF, интеграции (блок 5, задание 4). Значения искусственные. */
const SUBJECT = '01890a5d-ac96-774b-bcce-b302099a8057';
const OLD = { local: 'k'.repeat(64), csrf: 'c'.repeat(64), integration: 'i'.repeat(64) };
const BASE: NodeJS.ProcessEnv = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://app:pw@localhost:5433/db',
  AUTH_MODE: 'local',
  LOCAL_AUTH_SIGNING_KEY: OLD.local,
  CSRF_SIGNING_KEY: OLD.csrf,
  INTEGRATION_TOKEN_SIGNING_KEY: OLD.integration,
  KMS_MODE: 'local',
  KEK_SEARCH_INDEX: Buffer.alloc(32, 7).toString('base64'),
  KEK_PASSPORT_SENSITIVE: Buffer.alloc(32, 8).toString('base64'),
  KEK_KYB_DOCUMENTS: Buffer.alloc(32, 9).toString('base64'),
  KEK_WEBHOOK_SECRETS: Buffer.alloc(32, 11).toString('base64'),
};
const FUTURE = '2999-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';
const versions = (fill: string) => `v2:${fill.repeat(64)}`;

function rotated(until: string): NodeJS.ProcessEnv {
  const all: NodeJS.ProcessEnv = {};
  for (const [name, fill] of [
    ['LOCAL_AUTH_SIGNING_KEY', 'x'],
    ['CSRF_SIGNING_KEY', 'y'],
    ['INTEGRATION_TOKEN_SIGNING_KEY', 'z'],
  ] as const) {
    all[`${name}_VERSIONS`] = versions(fill);
    all[`${name}_ACTIVE`] = 'v2';
    all[`${name}_LEGACY_UNTIL`] = until;
  }
  return all;
}

const saved = process.env;
function use(env: NodeJS.ProcessEnv): void {
  process.env = { ...BASE, ...env };
  resetEnvCache();
}
beforeEach(() => use({}));
afterEach(() => {
  process.env = saved;
  resetEnvCache();
});

const verifier = new TokenVerifier();
const local = () => verifier.issueLocal({ subject: SUBJECT, roles: ['founder'], ttlSeconds: 60 });
const service = () =>
  issueServiceToken({ serviceAccountId: 'a', clientId: 'c', scopes: ['x'], tokenEpoch: 1 }).token;

describe('Пока версия не включена', () => {
  it('токены остаются в прежнем формате: их понимает старый выпуск', () => {
    expect(local().split('.')).toHaveLength(2);
    expect(issueCsrfToken('s').split('.')).toHaveLength(2);
    expect(service().split('.')).toHaveLength(2);
  });

  it('версии можно завести заранее: формат выдачи не меняется, kid уже принимается', async () => {
    const issued = (() => {
      use({ ...rotated(FUTURE) });
      return { local: local(), csrf: issueCsrfToken('s'), service: service() };
    })();
    const prepared = rotated(FUTURE);
    for (const key of Object.keys(prepared)) if (key.endsWith('_ACTIVE')) prepared[key] = '';
    use(prepared);
    expect(local().split('.')).toHaveLength(2);
    expect((await verifier.verify(issued.local)).subject).toBe(SUBJECT);
    expect(isCsrfTokenValid('s', issued.csrf)).toBe(true);
    expect(verifyServiceToken(issued.service).sub).toBe('a');
  });
});

describe('После включения версии', () => {
  it('новые токены несут kid и проходят проверку', async () => {
    use(rotated(FUTURE));
    const token = local();
    expect(token.startsWith('v2.')).toBe(true);
    expect((await verifier.verify(token)).subject).toBe(SUBJECT);
    const csrf = issueCsrfToken('s');
    expect(csrf.startsWith('v2.')).toBe(true);
    expect(isCsrfTokenValid('s', csrf)).toBe(true);
    expect(isCsrfTokenValid('чужой', csrf)).toBe(false);
    expect(verifyServiceToken(service()).sub).toBe('a');
  });

  it('токены без kid принимаются до срока прежним ключом', async () => {
    const old = { local: local(), csrf: issueCsrfToken('s'), service: service() };
    use(rotated(FUTURE));
    expect((await verifier.verify(old.local)).subject).toBe(SUBJECT);
    expect(isCsrfTokenValid('s', old.csrf)).toBe(true);
    expect(verifyServiceToken(old.service).sub).toBe('a');
  });

  it('после срока токены без kid отклоняются', async () => {
    const old = { local: local(), csrf: issueCsrfToken('s'), service: service() };
    use(rotated(PAST));
    await expect(verifier.verify(old.local)).rejects.toThrow();
    expect(isCsrfTokenValid('s', old.csrf)).toBe(false);
    expect(() => verifyServiceToken(old.service)).toThrow();
  });

  it('неизвестная и снятая версия отклоняются, ключи не перебираются', async () => {
    use(rotated(FUTURE));
    const token = local();
    const csrf = issueCsrfToken('s');
    const unknown = token.replace(/^v2\./, 'v3.');
    await expect(verifier.verify(unknown)).rejects.toThrow();
    const withoutKid = token.slice('v2.'.length);
    await expect(verifier.verify(withoutKid)).rejects.toThrow();
    expect(isCsrfTokenValid('s', csrf.replace(/^v2\./, 'v3.'))).toBe(false);

    const removed = rotated(FUTURE);
    removed['LOCAL_AUTH_SIGNING_KEY_VERSIONS'] = `v4:${'w'.repeat(64)}`;
    removed['LOCAL_AUTH_SIGNING_KEY_ACTIVE'] = 'v4';
    use(removed);
    await expect(verifier.verify(token)).rejects.toThrow();
  });

  it('kid нельзя подменить: он входит в подпись', async () => {
    const two = rotated(FUTURE);
    two['LOCAL_AUTH_SIGNING_KEY_VERSIONS'] = `v2:${'x'.repeat(64)},v3:${'x'.repeat(63)}q`;
    use(two);
    await expect(verifier.verify(local().replace(/^v2\./, 'v3.'))).rejects.toThrow();
  });
});

describe('Настройки версий', () => {
  const load = (extra: NodeJS.ProcessEnv) => () => loadEnv({ ...BASE, ...extra });

  it('включённая версия требует срока приёма старых токенов', () => {
    expect(
      load({ CSRF_SIGNING_KEY_VERSIONS: versions('y'), CSRF_SIGNING_KEY_ACTIVE: 'v2' }),
    ).toThrow(/CSRF_SIGNING_KEY_LEGACY_UNTIL/);
  });

  it('незарегистрированная версия не запускается', () => {
    expect(load({ CSRF_SIGNING_KEY_ACTIVE: 'v2', CSRF_SIGNING_KEY_LEGACY_UNTIL: FUTURE })).toThrow(
      /CSRF_SIGNING_KEY_ACTIVE/,
    );
  });

  it('короткий секрет и повтор прежнего ключа не запускаются', () => {
    expect(load({ CSRF_SIGNING_KEY_VERSIONS: 'v2:коротко' })).toThrow(/CSRF_SIGNING_KEY_VERSIONS/);
    expect(load({ CSRF_SIGNING_KEY_VERSIONS: `v2:${OLD.csrf}` })).toThrow(
      /CSRF_SIGNING_KEY_VERSIONS/,
    );
  });

  it('значение секрета не попадает в сообщение', () => {
    expect(load({ CSRF_SIGNING_KEY_VERSIONS: 'НЕВЕРНО-значение' })).not.toThrow(/значение/);
  });
});

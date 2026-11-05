import { afterEach, describe, expect, it } from 'vitest';
import { TokenVerifier } from '../src/auth/token.verifier';
import { loadEnv, resetEnvCache } from '../src/config/env';
import { IdentityController } from '../src/identity/identity.controller';
import { KMS_ENV } from './kms-env';

/**
 * Обычный вход по логину и паролю в production (решение Томаса 05.11, блок 5). Режим входа
 * разрешён, остальные требования production действуют как прежде.
 */
const SUBJECT = '01890a5d-ac96-774b-bcce-b302099a8057';
const PROD: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://app:pw@db.internal:5433/db',
  NODE_ENV: 'production',
  AUTH_MODE: 'local',
  LOCAL_AUTH_SIGNING_KEY: 'k'.repeat(64),
  CSRF_SIGNING_KEY: 'c'.repeat(64),
  ...KMS_ENV,
  CORS_ALLOWED_ORIGINS: 'https://app.5espace.test',
  CORE_PUBLIC_URL: 'https://api.5espace.test',
  PUBLIC_BASE_URL: 'https://app.5espace.test',
  SESSION_COOKIE_NAME: '__Host-ul_session',
  CSRF_COOKIE_NAME: '__Host-ul_csrf',
  DATABASE_SSL: 'true',
  REDIS_URL: 'rediss://cache.internal:6379',
  REDIS_PASSWORD: 'p'.repeat(24),
  WEBHOOK_DELIVERY_MODE: 'live',
};
const saved = process.env;
afterEach(() => {
  process.env = saved;
  resetEnvCache();
});
const use = (): void => {
  process.env = { ...PROD };
  resetEnvCache();
};

describe('Обычный вход в production', () => {
  it('конфигурация запускается', () => {
    const env = loadEnv(PROD);
    expect(env.isProduction).toBe(true);
    expect(env.AUTH_MODE).toBe('local');
  });

  it('сессия выпускается и проверяется', async () => {
    use();
    const verifier = new TokenVerifier();
    const token = verifier.issueLocal({ subject: SUBJECT, roles: ['founder'], ttlSeconds: 60 });
    expect((await verifier.verify(token)).subject).toBe(SUBJECT);
    await expect(verifier.verify(`${token.split('.')[0]}.AAAA`)).rejects.toThrow();
  });

  it('cookie входа защищены', () => {
    use();
    const cookies: Record<string, { httpOnly: boolean; secure: boolean; sameSite: string }> = {};
    const reply = {
      setCookie: (name: string, _: string, options: (typeof cookies)[string]) => {
        cookies[name] = options;
      },
    };
    const controller = new IdentityController(
      {} as never,
      new TokenVerifier(),
      {} as never,
      {} as never,
    );
    (
      controller as unknown as {
        setSessionCookies: (r: unknown, u: string, roles: string[], c: string) => void;
      }
    ).setSessionCookies(reply, SUBJECT, ['founder'], 'csrf');
    expect(cookies['__Host-ul_session']).toMatchObject({
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
    });
    expect(cookies['__Host-ul_csrf']).toMatchObject({ secure: true, sameSite: 'strict' });
  });

  it('остальные требования production на месте', () => {
    const load = (extra: NodeJS.ProcessEnv) => () => loadEnv({ ...PROD, ...extra });
    expect(load({ LOCAL_AUTH_SIGNING_KEY: 'короткий' })).toThrow(/LOCAL_AUTH_SIGNING_KEY/);
    expect(load({ KMS_MODE: 'local' })).toThrow(/KMS_MODE/);
    expect(load({ CORS_ALLOWED_ORIGINS: 'http://app.5espace.test' })).toThrow(/https/);
    expect(load({ WEBHOOK_DELIVERY_MODE: 'capture' })).toThrow(/WEBHOOK_DELIVERY_MODE/);
    expect(load({ SESSION_COOKIE_NAME: 'ul_session' })).toThrow(/SESSION_COOKIE_NAME/);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeReturnPath, takeReturn } from '../src/return-to';
import { apiReady, recheckDelayMs } from '../src/service';

/** Возврат после входа и подтверждение готовности API (2.2/2.3, пакет 6). */
const allowed = ['/lab', '/investor'];

describe('Путь возврата — только внутренний путь разрешённого кабинета', () => {
  it('разрешённые', () => {
    expect(safeReturnPath('/lab/projects/1?x=1', allowed)).toBe('/lab/projects/1?x=1');
    expect(safeReturnPath('/lab', allowed)).toBe('/lab');
  });
  it('чужие и опасные — нет', () => {
    for (const bad of [
      '//evil.example/lab/',
      'https://evil.example/lab/',
      '/\\evil.example',
      '/lab\\..\\admin',
      'javascript:alert(1)',
      '/admin/users',
      '/labs/x',
      '/lab/\u0000',
      'lab/projects',
    ]) {
      expect(safeReturnPath(bad, allowed)).toBeNull();
    }
  });
});

describe('Метка возврата', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    vi.stubGlobal('window', {
      location: { port: '' },
      sessionStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => store.set(k, v),
        removeItem: (k: string) => store.delete(k),
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  const put = (mark: object) => store.set('fifth.return', JSON.stringify(mark));

  it('тот же пользователь и свежая метка — путь; метка снимается', () => {
    put({ path: '/lab/projects/1', owner: 'u1', at: 1_000 });
    expect(takeReturn('u1', allowed, 2_000)).toBe('/lab/projects/1');
    expect(store.has('fifth.return')).toBe(false);
  });
  it('другой пользователь — нет, метка всё равно снимается', () => {
    put({ path: '/lab/projects/1', owner: 'u1', at: 1_000 });
    expect(takeReturn('u2', allowed, 2_000)).toBeNull();
    expect(store.has('fifth.return')).toBe(false);
  });
  it('владелец неизвестен, метка просрочена или из будущего — нет', () => {
    put({ path: '/lab/', owner: null, at: 1_000 });
    expect(takeReturn('u1', allowed, 2_000)).toBeNull();
    put({ path: '/lab/', owner: 'u1', at: 0 });
    expect(takeReturn('u1', allowed, 31 * 60_000)).toBeNull();
    put({ path: '/lab/', owner: 'u1', at: 5_000 });
    expect(takeReturn('u1', allowed, 1_000)).toBeNull();
  });
  it('кабинет не из ролей вошедшего — нет', () => {
    put({ path: '/admin/users', owner: 'u1', at: 1_000 });
    expect(takeReturn('u1', allowed, 2_000)).toBeNull();
  });
});

describe('Готовность API — только успешный ответ с верным телом', () => {
  const reply = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));
  it('готов', async () => {
    expect(await apiReady(reply(200, { service: 'fifth-core', ready: true }) as never)).toBe(true);
  });
  it('не готов, чужой сервис, ошибка, сеть — нет', async () => {
    expect(await apiReady(reply(503, { service: 'fifth-core', ready: false }) as never)).toBe(
      false,
    );
    expect(await apiReady(reply(200, { service: 'fifth-core', ready: false }) as never)).toBe(
      false,
    );
    expect(await apiReady(reply(200, { service: 'other', ready: true }) as never)).toBe(false);
    expect(
      await apiReady(reply(502, { code: 'dependency_unavailable', status: 502 }) as never),
    ).toBe(false);
    expect(
      await apiReady(
        vi.fn(async () => {
          throw new TypeError('fetch failed');
        }) as never,
      ),
    ).toBe(false);
  });
  it('без кеша', async () => {
    const f = reply(200, { service: 'fifth-core', ready: true });
    await apiReady(f as never);
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].cache).toBe('no-store');
  });
});

describe('перепроверка общего отказа — с разбросом (выпуск W13–W21, оценка jitter)', () => {
  it('пауза 12–18 с, вкладки с разной случайностью не совпадают', () => {
    expect(recheckDelayMs(0)).toBe(12_000);
    expect(recheckDelayMs(1)).toBe(18_000);
    expect(recheckDelayMs(0.5)).toBe(15_000);
    const delays = new Set(Array.from({ length: 50 }, (_, i) => recheckDelayMs(i / 50)));
    expect(delays.size).toBe(50);
  });
});

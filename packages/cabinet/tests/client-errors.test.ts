import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientErrorScreen, parseClientErrorReport } from '@fifth/contracts';
import { FLUSH_MS, createClientErrorReporter } from '../src/client-errors';

/**
 * Ошибки интерфейса (8.4, план принят 09.11 с уточнениями Тэнка): закрытый перечень,
 * имена лишних полей не выходят наружу, повторы сводятся в ограниченное число сообщений.
 */
const SECRET = 'tok_9f8e7d6c5b4a@leak.example';
const valid = {
  cabinet: 'lab',
  screen: '/projects/:id',
  version: 'abc1234',
  code: 'js.uncaught',
  stage: 'unknown',
  count: 1,
};

describe('разбор сообщения', () => {
  it('секрет в ИМЕНИ неизвестного поля: только число отброшенных, ни имени, ни значения', () => {
    const parsed = parseClientErrorReport({ ...valid, [SECRET]: SECRET, extra: 1 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.dropped).toBe(2);
    expect(JSON.stringify(parsed)).not.toContain('tok_9f8e7d6c5b4a');
    expect(JSON.stringify(parsed)).not.toContain('extra');
  });

  it('значения вне перечня отклоняются без указания поля', () => {
    const cases: Record<string, unknown>[] = [
      { ...valid, screen: SECRET },
      { ...valid, screen: '/users' }, // экран другого кабинета
      { ...valid, code: 'js.uncaughtx' },
      { ...valid, stage: 'load ' },
      { ...valid, version: 'deadbeef'.repeat(6) },
      { ...valid, version: 'ABCDEFG' },
      { ...valid, count: 0 },
      { ...valid, count: 1.5 },
      { ...valid, viewportWidth: -1 },
      { ...valid, viewportHeight: 1e9 },
      { ...valid, requestId: SECRET },
      { ...valid, cabinet: 'Lab' },
    ];
    for (const body of cases) {
      const parsed = parseClientErrorReport(body);
      expect(parsed).toEqual({ ok: false });
    }
  });

  it('экран — шаблон маршрута, неизвестный путь — other, адрес не уходит', () => {
    expect(clientErrorScreen('lab', '/projects/0e0e/')).toBe('/projects/:id');
    expect(clientErrorScreen('lab', '/projects/x?token=1')).toBe('/projects/:id');
    expect(clientErrorScreen('lab', `/${SECRET}`)).toBe('other');
    expect(clientErrorScreen('admin', '/intelligence/sources/1')).toBe('/intelligence/sources/:id');
  });
});

function fakeWindow(pathname = '/lab/projects/123') {
  const target = new EventTarget();
  return Object.assign(target, {
    location: { pathname },
    innerWidth: 1280,
    innerHeight: 720,
  }) as unknown as Window;
}
const fire = (win: Window, n: number) => {
  for (let i = 0; i < n; i += 1) {
    win.dispatchEvent(Object.assign(new Event('error'), { message: 'x', error: new Error('x') }));
  }
};

describe('отправитель', () => {
  afterEach(() => vi.useRealTimers());

  it('5 одинаковых ошибок: сразу одно сообщение count=1, через FLUSH_MS — count=4; всего 5', () => {
    vi.useFakeTimers();
    const win = fakeWindow();
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    });
    const r = createClientErrorReporter({
      cabinet: 'lab',
      version: 'abc1234',
      apiBaseUrl: '/v1',
      basePath: '/lab/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      win,
    });
    fire(win, 5);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ screen: '/projects/:id', code: 'js.uncaught', count: 1 });
    vi.advanceTimersByTime(FLUSH_MS);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ count: 4 });
    expect(bodies.reduce((sum, b) => sum + Number(b.count), 0)).toBe(5);
    expect(Object.keys(bodies[0]!).sort()).toEqual(
      [
        'cabinet',
        'code',
        'count',
        'screen',
        'stage',
        'version',
        'viewportHeight',
        'viewportWidth',
      ].sort(),
    );
    r.dispose();
  });

  it('уход со страницы отправляет накопленное с keepalive; предел сообщений с загрузки', () => {
    const win = fakeWindow();
    const inits: RequestInit[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      inits.push(init!);
      return new Response(null, { status: 202 });
    });
    const r = createClientErrorReporter({
      cabinet: 'lab',
      version: 'abc1234',
      apiBaseUrl: '/v1',
      basePath: '/lab/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      win,
    });
    fire(win, 3);
    win.dispatchEvent(new Event('pagehide'));
    expect(inits).toHaveLength(2);
    expect(inits[1]!.keepalive).toBe(true);
    expect(JSON.parse(String(inits[1]!.body)).count).toBe(2);
    // Разные пары «код — этап» — разные ключи; сверх предела (10) ничего не уходит.
    const codes = [
      'js.rejection',
      'chunk.load_failed',
      'render.boundary',
      'api.server_error',
    ] as const;
    const stages = ['load', 'render', 'request', 'navigate', 'unknown'] as const;
    for (const code of codes) for (const stage of stages) r.report(code, stage);
    expect(r.sent()).toBe(10);
    expect(inits).toHaveLength(10);
    r.dispose();
  });

  it('недоступный приёмник: одна попытка, без повторов и без новой диагностики', async () => {
    const win = fakeWindow();
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    const r = createClientErrorReporter({
      cabinet: 'lab',
      version: 'abc1234',
      apiBaseUrl: '/v1',
      basePath: '/lab/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      win,
    });
    fire(win, 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.sent()).toBe(1);
    r.dispose();
  });
});

describe('отказ API → сообщение', () => {
  it('неизвестный исход после 2xx — одно сообщение api.unknown_outcome; 4xx — ничего', async () => {
    const { reportApiFailure } = await import('../src/client-errors');
    const win = fakeWindow();
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 202 });
    });
    const r = createClientErrorReporter({
      cabinet: 'lab',
      version: 'abc1234',
      apiBaseUrl: '/v1',
      basePath: '/lab/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      win,
    });
    const requestId = '0e0e0e0e-1111-4222-8333-444455556666';
    reportApiFailure({ status: 201, requestId, outcomeUnknown: true });
    reportApiFailure({ status: 409, requestId: null, outcomeUnknown: false });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ code: 'api.unknown_outcome', stage: 'request', requestId });
    expect(parseClientErrorReport(bodies[0]).ok).toBe(true);
    r.dispose();
  });
});

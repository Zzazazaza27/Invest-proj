import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiClient, ApiError, createPublicClient, createWebClient } from '../src/index';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/**
 * Мок транспорта с точной сигнатурой fetch: без неё vitest выводит тип
 * аргументов как пустой кортеж, и обращение к mock.calls[0][1] не типизируется.
 */
function mockFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  return vi.fn((url: string | URL | Request, init?: RequestInit) =>
    handler(String(url), init ?? {}),
  );
}

/** Аргументы вызова №n. Падает с внятным сообщением, если вызова не было. */
function callArgs(fn: ReturnType<typeof mockFetch>, index = 0): { url: string; init: RequestInit } {
  const call = fn.mock.calls[index];
  if (!call) throw new Error(`Ожидался вызов транспорта №${index}, но его не было`);
  return { url: String(call[0]), init: call[1] ?? {} };
}

describe('Транспорт: заголовки и учётные данные', () => {
  it('cookie-режим шлёт credentials и CSRF-токен на небезопасный метод', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ ok: true }));
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      auth: { kind: 'cookie', csrfToken: 'csrf-abc' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.request({ method: 'POST', path: '/projects', body: { a: 1 } });

    const { init } = callArgs(fetchImpl);
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('X-CSRF-Token')).toBe('csrf-abc');
  });

  it('cookie-режим НЕ шлёт CSRF на GET: он там не нужен', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ ok: true }));
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      auth: { kind: 'cookie', csrfToken: 'csrf-abc' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.request({ path: '/pricing' });

    expect(new Headers(callArgs(fetchImpl).init.headers).get('X-CSRF-Token')).toBeNull();
  });

  it('bearer-режим не отправляет cookie', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ ok: true }));
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      auth: { kind: 'bearer', getToken: () => 'token-xyz' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.request({ path: '/auth/me' });

    const { init } = callArgs(fetchImpl);
    expect(init.credentials).toBe('omit');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer token-xyz');
  });

  it('публичный клиент не отправляет ни cookie, ни токен', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ ok: true }));
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      auth: { kind: 'none' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.request({ path: '/pricing' });
    const { init } = callArgs(fetchImpl);
    expect(init.credentials).toBe('omit');
    expect(new Headers(init.headers).get('Authorization')).toBeNull();
    // Фабрика публичного клиента собирается без ошибок и не требует токена.
    expect(createPublicClient('https://api.test/v1')).toBeInstanceOf(Object);
  });

  it('каждый запрос имеет таймаут и не кешируется', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ ok: true }));
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.request({ path: '/pricing' });
    const { init } = callArgs(fetchImpl);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.cache).toBe('no-store');
    expect(init.redirect).toBe('error');
  });

  it('Idempotency-Key передаётся в заголовке', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ ok: true }));
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.request({
      method: 'POST',
      path: '/billing/payments',
      body: {},
      idempotencyKey: 'idem-test-fixture-000000',
    });
    expect(new Headers(callArgs(fetchImpl).init.headers).get('Idempotency-Key')).toBe(
      'idem-test-fixture-000000',
    );
  });

  it('нормализует слэши в URL', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({ ok: true }));
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1///',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.request({ path: '///pricing' });
    expect(callArgs(fetchImpl).url).toBe('https://api.test/v1/pricing');
  });

  /**
   * Пустой базовый адрес — это «тот же origin, что и страница».
   *
   * Так его задаёт административный кабинет: пути в нём уже содержат `/v1/`.
   * Пустая строка не начинается со слэша и раньше проваливалась мимо ветки
   * относительного адреса — `new URL('/v1/auth/login')` без базы бросал
   * TypeError ДО единого сетевого запроса, и за единой точкой входа вход в
   * кабинет не работал вовсе. Найдено рендер-прогоном в Ф51.
   */
  it('пустой базовый адрес разрешается от адреса страницы', async () => {
    // В Node `location` нет — подставляем её, потому что проверяется поведение
    // именно в браузере. Без подстановки относительный адрес остаётся ошибкой,
    // и это правильно: в прогонах базовый адрес всегда известен явно.
    vi.stubGlobal('location', { origin: 'https://app.test' });
    try {
      const fetchImpl = mockFetch(async () => jsonResponse({ ok: true }));
      const client = new ApiClient({
        baseUrl: '',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      await client.request({ path: '/v1/auth/me' });
      expect(callArgs(fetchImpl).url).toBe('https://app.test/v1/auth/me');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('Обработка ошибок RFC 9457', () => {
  it('превращает problem+json в типизированную ApiError', async () => {
    const problem = {
      type: 'https://5espace.com/problems/kyc_required',
      title: 'Требуется верификация',
      status: 403,
      code: 'kyc_required',
      detail: 'Расширенный доступ открывается после проверки личности',
      traceId: 'trace-42',
    };
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      fetchImpl: (async () => jsonResponse(problem, 403)) as unknown as typeof fetch,
    });

    const error = await client.request({ path: '/projects/x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.code).toBe('kyc_required');
    expect(apiError.status).toBe(403);
    expect(apiError.traceId).toBe('trace-42');
    expect(apiError.needsKyc).toBe(true);
  });

  it('распознаёт требование step-up MFA', async () => {
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      fetchImpl: (async () =>
        jsonResponse(
          {
            type: 'https://5espace.com/problems/step_up_required',
            title: 'Нужен второй фактор',
            status: 403,
            code: 'step_up_required',
          },
          403,
        )) as unknown as typeof fetch,
    });

    const error = (await client
      .request({ method: 'POST', path: '/investments/agreements', body: {} })
      .catch((e: unknown) => e)) as ApiError;
    expect(error.needsStepUp).toBe(true);
  });

  it('переживает не-JSON тело ошибки', async () => {
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      fetchImpl: (async () =>
        new Response('<html>502</html>', { status: 502 })) as unknown as typeof fetch,
    });
    const error = (await client
      .request({ method: 'POST', path: '/x', body: {} })
      .catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
  });
});

describe('Валидация ответа по схеме', () => {
  const schema = z.object({ id: z.string(), amount: z.string() });

  it('пропускает корректный ответ', async () => {
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      fetchImpl: (async () => jsonResponse({ id: 'a', amount: '1.00' })) as unknown as typeof fetch,
    });
    await expect(client.request({ path: '/x', schema })).resolves.toEqual({
      id: 'a',
      amount: '1.00',
    });
  });

  it('падает на ответе, не соответствующем контракту, а не отдаёт мусор в UI', async () => {
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      fetchImpl: (async () => jsonResponse({ id: 'a', amount: 100 })) as unknown as typeof fetch,
    });
    const error = (await client
      .request({ path: '/x', schema })
      .catch((e: unknown) => e)) as ApiError;
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('internal_error');
  });
});

describe('Повторы', () => {
  it('повторяет GET при 503 и в итоге отдаёт результат', async () => {
    let calls = 0;
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      fetchImpl: (async () => {
        calls += 1;
        return calls < 3 ? jsonResponse({}, 503) : jsonResponse({ ok: true });
      }) as unknown as typeof fetch,
    });
    await expect(client.request({ path: '/pricing' })).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it('НЕ повторяет POST: он мог примениться частично', async () => {
    let calls = 0;
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse({}, 503);
      }) as unknown as typeof fetch,
    });
    await expect(
      client.request({ method: 'POST', path: '/billing/payments', body: {} }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(1);
  });

  it('НЕ повторяет GET при 4xx: повтор не изменит результат', async () => {
    let calls = 0;
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse({}, 404);
      }) as unknown as typeof fetch,
    });
    await expect(client.request({ path: '/x' })).rejects.toBeInstanceOf(ApiError);
    expect(calls).toBe(1);
  });
});

describe('Фабрики клиентов', () => {
  it('веб-клиент создаётся в cookie-режиме и принимает обновление CSRF', () => {
    const api = createWebClient('https://api.test/v1', 'csrf-1');
    expect(() => api.http.setCsrfToken('csrf-2')).not.toThrow();
  });
});

describe('Неизвестный результат изменяющего запроса (2.6)', () => {
  const failing = () =>
    mockFetch(async () => {
      throw new TypeError('Failed to fetch');
    });

  it('обрыв на POST — результат неизвестен, автоматического повтора нет', async () => {
    const fetchImpl = failing();
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const error = await client
      .request({ method: 'POST', path: '/projects', body: {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).outcomeUnknown).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('504 прокси на POST — результат неизвестен', async () => {
    const fetchImpl = mockFetch(async () => new Response('', { status: 504 }));
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const error = await client
      .request({ method: 'POST', path: '/projects', body: {} })
      .catch((e: unknown) => e);
    expect((error as ApiError).outcomeUnknown).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('отказ сервера с ответом — известный результат', async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse(
        { type: 'https://x/problems/conflict', title: 'x', status: 409, code: 'conflict' },
        409,
      ),
    );
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const error = await client
      .request({ method: 'POST', path: '/projects', body: {} })
      .catch((e: unknown) => e);
    expect((error as ApiError).outcomeUnknown).toBe(false);
  });

  it.each([
    ['unknown', true],
    ['not_started', false],
    [undefined, false],
  ] as const)(
    '503 с outcome=%s — outcomeUnknown=%s (машинный признак, не текст и не заголовок)',
    async (outcome, expected) => {
      const fetchImpl = mockFetch(async () =>
        jsonResponse(
          {
            type: 'https://x/problems/dependency_unavailable',
            title: 'x',
            status: 503,
            code: 'dependency_unavailable',
            detail: 'текст не важен',
            ...(outcome ? { outcome } : {}),
          },
          503,
        ),
      );
      const client = new ApiClient({
        baseUrl: 'https://api.test/v1',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      });
      const error = await client
        .request({ method: 'POST', path: '/projects', body: {} })
        .catch((e: unknown) => e);
      expect((error as ApiError).outcomeUnknown).toBe(expected);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it('201 с ответом не по схеме на POST — результат неизвестен, а не отказ', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({}, 201));
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const error = await client
      .request({
        method: 'POST',
        path: '/projects',
        body: {},
        schema: z.object({ id: z.string() }),
      })
      .catch((e: unknown) => e);
    expect((error as ApiError).code).toBe('internal_error');
    expect((error as ApiError).outcomeUnknown).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ответ не по схеме на GET — обычная ошибка контракта', async () => {
    const fetchImpl = mockFetch(async () => jsonResponse({}));
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const error = await client
      .request({ path: '/projects', schema: z.object({ id: z.string() }) })
      .catch((e: unknown) => e);
    expect((error as ApiError).outcomeUnknown).toBe(false);
  });
});

describe('Диагностика неизвестного исхода (8.4, замечание Тэнка к cea113a)', () => {
  it('нечитаемый 201 на POST: одно сообщение onFailure без тела, исход неизвестен, ключ держится', async () => {
    const { keyAfterError, keyForSend } = await import('../src/retry-key');
    const fetchImpl = mockFetch(async () =>
      jsonResponse({ unexpected: 'secret-body@leak.example' }, 201),
    );
    const failures: unknown[] = [];
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      auth: { kind: 'cookie', csrfToken: 'csrf-abc' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onFailure: (info) => failures.push(info),
    });
    const key = keyForSend(null);
    let caught: unknown = null;
    try {
      await client.request({
        method: 'POST',
        path: '/projects',
        body: { a: 1 },
        schema: z.object({ id: z.string() }),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).outcomeUnknown).toBe(true);
    expect(failures).toEqual([{ status: 201, requestId: null, outcomeUnknown: true }]);
    expect(JSON.stringify(failures)).not.toContain('leak.example');
    expect(keyAfterError(key, caught)).toEqual({ key: key.key, unresolved: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('обычный отказ 4xx в диагностику не идёт', async () => {
    const fetchImpl = mockFetch(async () =>
      jsonResponse({ type: 'about:blank', title: 'x', status: 409, code: 'conflict' }, 409),
    );
    const failures: unknown[] = [];
    const client = new ApiClient({
      baseUrl: 'https://api.test/v1',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onFailure: (info) => failures.push(info),
    });
    await expect(client.request({ method: 'POST', path: '/x', body: {} })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(failures).toEqual([]);
  });
});

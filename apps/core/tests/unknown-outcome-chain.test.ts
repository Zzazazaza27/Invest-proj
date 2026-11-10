import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProblemDetailsFilter } from '../src/common/problem.filter';

/**
 * Неизвестный исход изменения — вся цепочка и переход для открытых вкладок (W32, Тэнк 10.11).
 *
 * Сервер — настоящий фильтр ядра. Клиенты — настоящий текущий ApiClient и ЗАМОРОЖЕННАЯ копия
 * клиента из выпущенных сборок (tests/fixtures/legacy-api-client.ts: так работают вкладки,
 * открытые до выпуска). Форма — настоящий шаг защищённой отправки (makeRun).
 * Хранилище с ключом повтора — простая модель сервера: тот же ключ возвращает тот же объект.
 *
 *  1. прежний клиент удерживает ключ и снимок после нового ответа (504, outcome=unknown);
 *  2. новый клиент сохраняет неизвестный исход, traceId и пояснение;
 *  3. пустой 504 от прокси тоже удерживает операцию;
 *  4. подтверждённый отказ 503 (outcome=not_started) остаётся окончательным для первой отправки;
 *  5. повтор выясняет результат тем же ключом — второго объекта нет.
 */

interface ApiErrorLike extends Error {
  outcomeUnknown: boolean;
  status: number;
  traceId: string | null;
}
interface ApiLike {
  request(o: {
    method: string;
    path: string;
    body?: unknown;
    idempotencyKey?: string;
  }): Promise<unknown>;
}
interface Pending {
  owner: string | null;
  key: string;
  payload: unknown;
  at: number;
}
type RunFn = (mode: 'first' | 'check' | 'auto') => Promise<void>;
type ClientCtor = new (o: { baseUrl: string; fetchImpl: unknown }) => ApiLike;
interface FormMod {
  guardedMemory: Map<string, Pending>;
  setGuardOwner: (id: string | null) => void;
  makeRun: (deps: {
    name: string;
    opts: { current: Record<string, unknown> };
    timer: { current: ReturnType<typeof setTimeout> | null };
    finish: (slot: string) => void;
    setPhase: (p: string) => void;
    setPending: (p: Pending | null) => void;
    setNote: (n: string | null) => void;
  }) => RunFn;
}

const clients: Record<'текущий' | 'прежний', ClientCtor> = {} as never;
let guardedMemory: FormMod['guardedMemory'];
let makeRun: FormMod['makeRun'];
let setGuardOwner: FormMod['setGuardOwner'];
beforeAll(async () => {
  // Пути вычисляются: проверка типов ядра (без DOM и JSX) эти исходники не разбирает.
  const here = (rel: string) => pathToFileURL(resolve(process.cwd(), rel)).href;
  const current = (await import(here('../../packages/api-client/src/client.ts'))) as {
    ApiClient: ClientCtor;
  };
  const legacy = (await import(here('tests/fixtures/legacy-api-client.ts'))) as {
    ApiClient: ClientCtor;
  };
  const form = (await import(here('../../packages/cabinet/src/guarded-send.tsx'))) as FormMod;
  clients['текущий'] = current.ApiClient;
  clients['прежний'] = legacy.ApiClient;
  ({ guardedMemory, makeRun, setGuardOwner } = form);
});

/** Настоящий фильтр ядра: ответ на исключение — статус, заголовки, тело. */
function filterAnswer(exception: unknown, method: string): Response {
  const headers: Record<string, string> = {};
  let status = 0;
  let body: unknown = null;
  const reply = {
    hasHeader: (n: string) => n.toLowerCase() in headers,
    header(n: string, v: string) {
      headers[n.toLowerCase()] = v;
      return reply;
    },
    status(s: number) {
      status = s;
      return reply;
    },
    send(b: unknown) {
      body = b;
      return reply;
    },
  };
  const request = { id: 't-1', url: '/v1/projects', method, routeOptions: { url: '/v1/projects' } };
  new ProblemDetailsFilter().catch(exception, {
    switchToHttp: () => ({ getResponse: () => reply, getRequest: () => request }),
  } as never);
  return new Response(JSON.stringify(body), { status, headers });
}
const brokenMidWrite = () => new Error('Connection terminated unexpectedly');
const refusedBeforeStart = () =>
  Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:5432'), { code: 'ECONNREFUSED' });

type Fault = 'обрыв после записи' | 'пустой 504 после записи' | 'отказ до начала';

/**
 * Модель сервера с ключом повтора: первая отправка с новым ключом встречает сбой; повтор с
 * тем же ключом возвращает уже записанный объект (или записывает, если записи не было).
 */
function backend(fault: Fault) {
  const objects = new Map<string, string>();
  const keys: (string | null)[] = [];
  let first = true;
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    const key = new Headers(init.headers).get('Idempotency-Key');
    keys.push(key);
    if (key && objects.has(key)) {
      return new Response(JSON.stringify({ id: objects.get(key) }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (first) {
      first = false;
      if (fault === 'отказ до начала') return filterAnswer(refusedBeforeStart(), 'POST');
      objects.set(String(key), `p-${objects.size + 1}`); // фиксация прошла, ответ потерян
      if (fault === 'пустой 504 после записи') return new Response('', { status: 504 });
      return filterAnswer(brokenMidWrite(), 'POST');
    }
    objects.set(String(key), `p-${objects.size + 1}`);
    return new Response(JSON.stringify({ id: objects.get(String(key)) }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { fetchImpl, objects, keys };
}

function form(api: ApiLike) {
  const name = 'A|lab.project.create';
  guardedMemory.set(name, { owner: 'A', key: 'key-1', payload: { title: 'проект' }, at: 0 });
  const phases: string[] = [];
  const onFail = vi.fn();
  const onDone = vi.fn();
  const run = makeRun({
    name,
    opts: {
      current: {
        scope: 'lab.project.create',
        operation: 'lab.project.create',
        send: (p: unknown, k: string) =>
          api.request({ method: 'POST', path: '/projects', body: p, idempotencyKey: k }),
        state: vi.fn().mockResolvedValue({ state: 'absent' }),
        onDone,
        onResolved: vi.fn(),
        onFail,
      },
    },
    timer: { current: null },
    finish: (slot) => guardedMemory.delete(slot),
    setPhase: (p) => phases.push(p),
    setPending: vi.fn(),
    setNote: vi.fn(),
  });
  return { name, run, phases, onFail, onDone };
}

afterEach(() => {
  guardedMemory.clear();
  setGuardOwner(null);
});

describe('сервер: граница статусов', () => {
  it('обрыв посреди изменения — 504, outcome=unknown, без Retry-After', async () => {
    const r = filterAnswer(brokenMidWrite(), 'POST');
    expect(r.status).toBe(504);
    expect(((await r.json()) as { outcome?: string }).outcome).toBe('unknown');
    expect(r.headers.get('retry-after')).toBeNull();
  });
  it('отказ до начала — 503, outcome=not_started, с Retry-After', async () => {
    const r = filterAnswer(refusedBeforeStart(), 'POST');
    expect(r.status).toBe(503);
    expect(((await r.json()) as { outcome?: string }).outcome).toBe('not_started');
    expect(r.headers.get('retry-after')).not.toBeNull();
  });
});

describe.each(['прежний', 'текущий'] as const)('клиент: %s', (which) => {
  const api = (fetchImpl: unknown) =>
    new clients[which]({ baseUrl: 'https://api.test/v1', fetchImpl });

  it.each(['обрыв после записи', 'пустой 504 после записи'] as const)(
    '%s: форма держит ключ и снимок; повтор тем же ключом — один объект',
    async (fault) => {
      setGuardOwner('A');
      const b = backend(fault);
      const f = form(api(b.fetchImpl));
      await f.run('first');
      const kept = guardedMemory.get(f.name);
      expect(kept?.key).toBe('key-1');
      expect(kept?.payload).toEqual({ title: 'проект' });
      expect(f.phases.at(-1)).toBe('unknown');
      expect(f.onFail).not.toHaveBeenCalled();

      await f.run('check');
      expect(b.keys).toEqual(['key-1', 'key-1']);
      expect(f.onDone).toHaveBeenCalledTimes(1);
      expect(b.objects.size).toBe(1);
      expect(guardedMemory.has(f.name)).toBe(false);
    },
  );

  it('отказ до начала (503 not_started): первая отправка окончательна, объекта нет', async () => {
    setGuardOwner('A');
    const b = backend('отказ до начала');
    const f = form(api(b.fetchImpl));
    await f.run('first');
    expect(f.onFail).toHaveBeenCalledTimes(1);
    expect((f.onFail.mock.calls[0]?.[0] as ApiErrorLike).outcomeUnknown).toBe(false);
    expect(guardedMemory.has(f.name)).toBe(false);
    expect(b.objects.size).toBe(0);
  });
});

describe('текущий клиент: что сохраняется в ошибке', () => {
  it('504 от ядра: неизвестный исход, traceId и пояснение не теряются', async () => {
    const b = backend('обрыв после записи');
    const api = new clients['текущий']({ baseUrl: 'https://api.test/v1', fetchImpl: b.fetchImpl });
    const e = (await api
      .request({ method: 'POST', path: '/projects', body: {}, idempotencyKey: 'k' })
      .catch((x: unknown) => x)) as ApiErrorLike;
    expect(e.status).toBe(504);
    expect(e.outcomeUnknown).toBe(true);
    expect(e.traceId).toBe('t-1');
    expect(e.message).toMatch(/результат неизвестен/);
  });
  it('пустой 504 от прокси: неизвестный исход по статусу', async () => {
    const b = backend('пустой 504 после записи');
    const api = new clients['текущий']({ baseUrl: 'https://api.test/v1', fetchImpl: b.fetchImpl });
    const e = (await api
      .request({ method: 'POST', path: '/projects', body: {}, idempotencyKey: 'k' })
      .catch((x: unknown) => x)) as ApiErrorLike;
    expect(e.outcomeUnknown).toBe(true);
    expect(e.traceId).toBeNull();
  });
});

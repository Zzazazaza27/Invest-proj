import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ProblemDetailsFilter } from '../src/common/problem.filter';

/*
 * Клиент и форма — настоящие исходники пакетов, подключаются при выполнении. Путь вычисляется,
 * чтобы проверка типов ядра (без DOM и JSX) их не разбирала; нужные типы описаны здесь.
 */
interface ApiErrorLike extends Error {
  outcomeUnknown: boolean;
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
interface ClientMod {
  ApiClient: new (o: { baseUrl: string; fetchImpl: unknown }) => ApiLike;
  ApiError: new (...a: never[]) => ApiErrorLike;
}
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
type ApiError = ApiErrorLike;
let ApiClient: ClientMod['ApiClient'];
let ApiError: ClientMod['ApiError'];
let guardedMemory: FormMod['guardedMemory'];
let makeRun: FormMod['makeRun'];
let setGuardOwner: FormMod['setGuardOwner'];
beforeAll(async () => {
  // Тесты ядра запускаются из apps/core: пакеты — двумя уровнями выше.
  const pkg = (rel: string) => pathToFileURL(resolve(process.cwd(), '../../packages', rel)).href;
  const c = (await import(pkg('api-client/src/client.ts'))) as ClientMod;
  const f = (await import(pkg('cabinet/src/guarded-send.tsx'))) as FormMod;
  ({ ApiClient, ApiError } = c);
  ({ guardedMemory, makeRun, setGuardOwner } = f);
});

/**
 * Неизвестный исход изменения — вся цепочка (W32, замечание Тэнка 10.11):
 *  1. сервер: обрыв связи с базой посреди POST → 503 с машинным признаком outcome=unknown;
 *  2. API-клиент: этот ответ → ApiError.outcomeUnknown = true (не по тексту и не по заголовку);
 *  3. защищённая форма: операция, снимок и прежний ключ сохраняются;
 *  4. следующий шаг выясняет результат тем же ключом.
 * И различие: подтверждённый отказ до начала работы (outcome=not_started) остаётся
 * окончательным для первой отправки.
 */

/** Настоящий фильтр ядра: ответ на исключение — статус, заголовки, тело. */
function serverAnswer(exception: unknown, method: string): Response {
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

/** Клиент, у которого «сеть» — заранее заданные ответы сервера. */
function clientAnswering(answers: Response[]) {
  const seen: { key: string | null }[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    seen.push({ key: new Headers(init.headers).get('Idempotency-Key') });
    const next = answers.shift();
    if (!next) throw new Error('ответов больше нет');
    return next;
  });
  const api = new ApiClient({ baseUrl: 'https://api.test/v1', fetchImpl: fetch as never });
  return { api, seen };
}

function form(send: (p: unknown, key: string) => Promise<unknown>) {
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
        send: send as never,
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

describe('неизвестный исход изменения — от сервера до формы', () => {
  it('обрыв посреди POST: признак, клиент, форма держит ключ, проверка тем же ключом', async () => {
    // 1. сервер
    const answer = serverAnswer(brokenMidWrite(), 'POST');
    expect(answer.status).toBe(503);
    const body = (await answer.clone().json()) as { outcome?: string };
    expect(body.outcome).toBe('unknown');
    expect(answer.headers.get('retry-after')).toBeNull();

    // 2. API-клиент; затем второй ответ — операция уже выполнена (повтор тем же ключом).
    const done = new Response(JSON.stringify({ id: 'p-1' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
    const { api, seen } = clientAnswering([answer, done]);
    let caught: unknown = null;
    try {
      await api.request({ method: 'POST', path: '/projects', body: {}, idempotencyKey: 'probe' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).outcomeUnknown).toBe(true);
    seen.length = 0;

    // 3. форма: тот же ответ сервера — операция, снимок и ключ сохраняются.
    setGuardOwner('A');
    const again = clientAnswering([serverAnswer(brokenMidWrite(), 'POST'), done]);
    const f = form((p, k) =>
      again.api.request({ method: 'POST', path: '/projects', body: p, idempotencyKey: k }),
    );
    await f.run('first');
    const kept = guardedMemory.get(f.name);
    expect(kept?.key).toBe('key-1');
    expect(kept?.payload).toEqual({ title: 'проект' });
    expect(f.phases.at(-1)).toBe('unknown');
    expect(f.onFail).not.toHaveBeenCalled();

    // 4. следующий шаг — тем же ключом, операция завершается её результатом.
    await f.run('check');
    expect(again.seen.map((s) => s.key)).toEqual(['key-1', 'key-1']);
    expect(f.onDone).toHaveBeenCalledTimes(1);
    expect(guardedMemory.has(f.name)).toBe(false);
  });

  it('подтверждённый отказ до начала работы: not_started, первая отправка окончательна', async () => {
    const answer = serverAnswer(refusedBeforeStart(), 'POST');
    expect(answer.status).toBe(503);
    expect(((await answer.clone().json()) as { outcome?: string }).outcome).toBe('not_started');
    expect(answer.headers.get('retry-after')).not.toBeNull();

    setGuardOwner('A');
    const c = clientAnswering([answer]);
    const f = form((p, k) =>
      c.api.request({ method: 'POST', path: '/projects', body: p, idempotencyKey: k }),
    );
    await f.run('first');
    expect(f.onFail).toHaveBeenCalledTimes(1);
    expect((f.onFail.mock.calls[0]?.[0] as ApiError).outcomeUnknown).toBe(false);
    expect(guardedMemory.has(f.name)).toBe(false);
  });
});

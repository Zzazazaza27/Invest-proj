import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@fifth/contracts';
import {
  connectionFailure,
  DEPENDENCY_RETRY_AFTER_SEC,
  ProblemDetailsFilter,
} from '../src/common/problem.filter';
import { errors } from '../src/common/errors';

/** Ответ фильтра: статус, заголовки, тело — без настоящего Fastify. */
function run(exception: unknown, method = 'GET') {
  const headers: Record<string, string> = {};
  const out: { status?: number; body?: Record<string, unknown> } = {};
  const reply = {
    hasHeader: (n: string) => n.toLowerCase() in headers,
    header(n: string, v: string) {
      headers[n.toLowerCase()] = v;
      return reply;
    },
    status(s: number) {
      out.status = s;
      return reply;
    },
    send(b: Record<string, unknown>) {
      out.body = b;
      return reply;
    },
  };
  const request = { id: 'trace-1', url: '/v1/x', method, routeOptions: { url: '/v1/x' } };
  const host = {
    switchToHttp: () => ({ getResponse: () => reply, getRequest: () => request }),
  };
  new ProblemDetailsFilter().catch(exception, host as never);
  return { ...out, headers };
}
const err = (message: string, code?: string) => Object.assign(new Error(message), { code });

const REFUSED: [string, unknown][] = [
  ['отказ в подключении', err('connect ECONNREFUSED 10.0.0.5:5432', 'ECONNREFUSED')],
  ['тайм-аут пула при подключении', new Error('timeout exceeded when trying to connect')],
  ['сервер ещё не принимает (57P03)', err('the database system is starting up', '57P03')],
  ['в цепочке cause', new Error('обёртка', { cause: err('x', 'EHOSTUNREACH') })],
];
const BROKEN: [string, unknown][] = [
  ['обрыв соединения pg', new Error('Connection terminated unexpectedly')],
  ['сервер останавливается (57P01)', err('terminating connection', '57P01')],
  ['ECONNRESET', err('read ECONNRESET', 'ECONNRESET')],
  ['класс 08 (08006)', err('connection failure', '08006')],
];

describe('недоступная зависимость — 503, а не 500 (W32)', () => {
  it.each([...REFUSED, ...BROKEN])('чтение: %s → 503 с Retry-After', (_n, exception) => {
    const r = run(exception, 'GET');
    expect(r.status).toBe(503);
    expect(r.body?.code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
    expect(r.headers['retry-after']).toBe(String(DEPENDENCY_RETRY_AFTER_SEC));
    // Имя, адрес и текст драйвера наружу не уходят.
    expect(JSON.stringify(r.body)).not.toMatch(/5432|ECONN|57P0|terminat|EHOST/);
  });

  it.each(REFUSED)('изменение, соединения не было: %s → 503 с Retry-After', (_n, exception) => {
    const r = run(exception, 'POST');
    expect(r.status).toBe(503);
    expect(r.body?.outcome).toBe('not_started');
    expect(r.headers['retry-after']).toBe(String(DEPENDENCY_RETRY_AFTER_SEC));
  });

  it.each(BROKEN)(
    'изменение, обрыв посреди операции: %s → 504 (переходно), outcome=unknown, без Retry-After',
    (_n, exception) => {
      const r = run(exception, 'PATCH');
      expect(r.status).toBe(504);
      expect(r.body?.code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
      expect(r.body?.outcome).toBe('unknown');
      expect(r.headers['retry-after']).toBeUndefined();
      expect(String(r.body?.detail)).toMatch(/результат неизвестен/);
    },
  );

  it('ошибки SQL, схемы и прав — не отказ связи: прежние статусы', () => {
    for (const code of ['23505', '42501', '42P01', '42703', '22P02', '40001', '53300']) {
      expect(connectionFailure(err('x', code))).toBeNull();
    }
    expect(run(err('duplicate key', '23505'), 'POST').status).toBe(500);
    expect(run(err('permission denied', '42501')).status).toBe(500);
    expect(run(new TypeError('x is undefined')).status).toBe(500);
    expect(run(errors.conflict('занято'), 'POST').status).toBe(409);
  });
});

import { describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { AuditRepository } from '../src/audit/audit.repository';
import {
  actingSelf,
  jobScope,
  newScope,
  noteBasis,
  originOf,
  roleFromBasis,
  settleBasis,
} from '../src/audit/actor-context';
import { Database, contextOf, type RequestContext, type Tx } from '../src/db/unit-of-work';

/**
 * Блок 10, задание 1: общий контекст автора (docs/architecture/b10-actor-context.md).
 * База не нужна: соединения поддельные, проверяется то, что уходит в audit.app_emit_event.
 */

interface Emitted {
  actorId: string | null;
  actorRole: string;
  context: Record<string, any>;
}

/** Поддельный пул: n соединений, каждое пишет вызовы функции журнала. */
function fakeDb(connections = 3): { db: Database; emitted: Emitted[] } {
  const emitted: Emitted[] = [];
  const free: object[] = [];
  const waiting: ((c: object) => void)[] = [];
  for (let i = 0; i < connections; i += 1) {
    const client: any = {
      on() {},
      removeListener() {},
      release() {
        const next = waiting.shift();
        if (next) next(client);
        else free.push(client);
      },
      async query(sql: string, params: unknown[] = []) {
        if (sql.includes('audit.app_emit_event')) {
          emitted.push({
            actorId: params[1] as string | null,
            actorRole: params[2] as string,
            context: JSON.parse(params[5] as string),
          });
          return { rows: [{ id: `e${emitted.length}` }] };
        }
        return { rows: [] };
      },
    };
    free.push(client);
  }
  const pool = {
    connect: () =>
      new Promise<object>((resolve) => {
        const c = free.shift();
        if (c) resolve(c);
        else waiting.push(resolve);
      }),
  };
  const db = Object.create(Database.prototype) as Database;
  Object.assign(db as any, {
    pool,
    statementTimeoutMs: 1000,
    logger: { error() {} },
    serviceRolePool: () => pool,
  });
  return { db, emitted };
}

const person = (userId: string, roles: string[], basis = newScope()): RequestContext => ({
  userId,
  roles,
  traceId: `req-${userId}`,
  actor: basis,
});

const emitAs = (audit: AuditRepository, tx: Tx, actorId: string | null, actorRole: string) =>
  audit.emit(tx, {
    verb: 'lab.project.updated',
    actorId,
    actorRole,
    subjectType: 'project',
    subjectId: '00000000-0000-0000-0000-000000000001',
    context: { field: 'x' },
  });

describe('роль из основания', () => {
  it('роль маршрута, участник, сам, сервис, фон', () => {
    expect(roleFromBasis([{ check: 'route-role', role: 'admin' }], 'person')).toBe('admin');
    expect(roleFromBasis([{ check: 'member', object: 'project:1' }], 'person')).toBe('founder');
    expect(roleFromBasis([{ check: 'self' }], 'person')).toBe('user');
    expect(roleFromBasis([{ check: 'service-scope', scope: 'w' }], 'service_account')).toBe(
      'service',
    );
    expect(roleFromBasis([{ check: 'job', name: 'j' }], 'system')).toBe('system');
    expect(roleFromBasis([{ check: 'public' }], 'anonymous')).toBe('anonymous');
    expect(roleFromBasis([], 'person')).toBeNull();
  });

  it('два основания с разными ролями — отказ, а не выбор «старшей»', () => {
    expect(() =>
      roleFromBasis(
        [
          { check: 'route-role', role: 'admin' },
          { check: 'member', object: 'project:1' },
        ],
        'person',
      ),
    ).toThrow(/разные роли/);
  });

  it('проверка объекта уточняет роль маршрута у человека с двумя ролями', () => {
    const scope = newScope([{ check: 'route-role', role: 'founder' }]);
    settleBasis(scope, { check: 'route-role', role: 'admin' });
    expect(scope.basis).toEqual([{ check: 'route-role', role: 'admin' }]);
    settleBasis(scope, { check: 'member', object: 'project:1' });
    expect(roleFromBasis(scope.basis, 'person')).toBe('founder');
  });
});

describe('запись журнала берёт автора из контекста транзакции', () => {
  it('форма actor v1: человек, основание, операция, запрос', async () => {
    const { db, emitted } = fakeDb();
    const audit = new AuditRepository(db);
    const ctx = person('u1', ['admin'], newScope([{ check: 'route-role', role: 'admin' }]));
    await db.transaction(ctx, (tx) => emitAs(audit, tx, 'u1', 'admin'));
    const actor = emitted[0]!.context.actor;
    expect(actor).toMatchObject({
      v: 1,
      kind: 'person',
      userId: 'u1',
      role: 'admin',
      basis: [{ check: 'route-role', role: 'admin' }],
      operationId: ctx.actor!.operationId,
      requestId: 'req-u1',
      job: null,
    });
    expect(emitted[0]!.context.field).toBe('x');
  });

  it('вне транзакции с контекстом — отказ', async () => {
    const audit = new AuditRepository(fakeDb().db);
    const tx = { query: async () => ({ rows: [{ id: 'x' }] }) } as unknown as Tx;
    await expect(emitAs(audit, tx, null, 'system')).rejects.toThrow(/вне транзакции/);
  });

  it('ключ actor в содержимом зарезервирован: автора не подставить данными', async () => {
    const { db } = fakeDb();
    const audit = new AuditRepository(db);
    await expect(
      db.transaction(person('u1', ['founder']), (tx) =>
        audit.emit(tx, {
          verb: 'lab.project.updated',
          actorId: 'u1',
          actorRole: 'founder',
          subjectType: null,
          subjectId: null,
          context: { actor: { userId: 'u2' } },
        }),
      ),
    ).rejects.toThrow(/зарезервирован/);
  });

  it('автор вызова не совпадает с контекстом — отказ', async () => {
    const { db } = fakeDb();
    const audit = new AuditRepository(db);
    await expect(
      db.transaction(
        person('u1', ['founder'], newScope([{ check: 'member', object: 'p' }])),
        (tx) => emitAs(audit, tx, 'u2', 'founder'),
      ),
    ).rejects.toThrow(/не совпадает/);
  });

  it('роль вызова не следует из основания — отказ', async () => {
    const { db } = fakeDb();
    const audit = new AuditRepository(db);
    const ctx = person('u1', ['founder', 'admin'], newScope([{ check: 'member', object: 'p' }]));
    await expect(db.transaction(ctx, (tx) => emitAs(audit, tx, 'u1', 'admin'))).rejects.toThrow(
      /не следует/,
    );
  });

  it('действие над собой — роль user', async () => {
    const { db, emitted } = fakeDb();
    const audit = new AuditRepository(db);
    const ctx = person('u1', ['investor', 'founder']);
    await db.transaction(ctx, (tx) =>
      audit.emit(tx, {
        verb: 'identity.avatar.set',
        actorId: 'u1',
        actorRole: actingSelf(ctx),
        subjectType: 'user',
        subjectId: 'u1',
      }),
    );
    expect(emitted[0]).toMatchObject({ actorRole: 'user', context: { actor: { role: 'user' } } });
  });

  it('до входа: аноним без учётной записи, не случайный пользователь и не «система»', async () => {
    const { db, emitted } = fakeDb();
    const audit = new AuditRepository(db);
    const ctx: RequestContext = {
      userId: null,
      roles: [],
      traceId: 'reg',
      actor: newScope([{ check: 'public' }]),
    };
    await db.transaction(ctx, (tx) =>
      audit.emit(tx, {
        verb: 'identity.user.registered',
        actorId: null,
        actorRole: 'anonymous',
        subjectType: 'user',
        subjectId: '00000000-0000-0000-0000-0000000000aa',
      }),
    );
    expect(emitted[0]!.actorId).toBeNull();
    expect(emitted[0]!.context.actor).toMatchObject({
      kind: 'anonymous',
      userId: null,
      role: 'anonymous',
    });
  });

  it('фон: автор — система, инициатор и операция — из сохранённого происхождения', async () => {
    const { db, emitted } = fakeDb();
    const audit = new AuditRepository(db);
    const origin = originOf(person('u7', ['founder']));
    const ctx: RequestContext = {
      userId: null,
      roles: ['system'],
      traceId: 'job',
      actor: jobScope('uploads.reconcile', 'run-1', origin, 2),
    };
    await db.transaction(ctx, (tx) => emitAs(audit, tx, null, 'system'));
    expect(emitted[0]!.context.actor).toMatchObject({
      kind: 'system',
      userId: null,
      role: 'system',
      operationId: origin.operationId,
      requestId: null,
      job: { name: 'uploads.reconcile', runId: 'run-1', attempt: 2 },
      initiator: { kind: 'person', userId: 'u7' },
    });
  });

  it('старая строка очереди без происхождения: инициатор не выдумывается', () => {
    const scope = jobScope('uploads.reconcile', 'run-2', null);
    expect(scope.initiator).toBeNull();
    expect(scope.originUnknown).toBe(true);
  });
});

describe('параллельность: два человека и фон одновременно', () => {
  it('контексты не смешиваются, а соединение не уносит чужой контекст', async () => {
    const { db, emitted } = fakeDb(2); // соединений меньше, чем работ: переиспользование
    const audit = new AuditRepository(db);
    const a = person('ua', ['founder'], newScope([{ check: 'member', object: 'p' }]));
    const b = person('ub', ['admin'], newScope([{ check: 'route-role', role: 'admin' }]));
    const job: RequestContext = {
      userId: null,
      roles: ['system'],
      traceId: 'job',
      actor: jobScope('mail.queue.send', 'run-9', originOf(a)),
    };
    const run = async (ctx: RequestContext, actorId: string | null, role: string, n: number) => {
      for (let i = 0; i < n; i += 1) {
        await db.transaction(ctx, async (tx) => {
          await sleep(Math.random() * 5);
          expect(contextOf(tx)).toBe(ctx);
          await emitAs(audit, tx, actorId, role);
        });
      }
    };
    await Promise.all([
      run(a, 'ua', 'founder', 15),
      run(b, 'ub', 'admin', 15),
      run(job, null, 'system', 15),
    ]);
    expect(emitted).toHaveLength(45);
    for (const e of emitted) {
      const actor = e.context.actor;
      if (actor.kind === 'system') {
        expect(actor.operationId).toBe(a.actor!.operationId);
        expect(actor.initiator).toEqual({ kind: 'person', userId: 'ua' });
      } else {
        const own = actor.userId === 'ua' ? a : b;
        expect(actor.operationId).toBe(own.actor!.operationId);
        expect(e.actorId).toBe(actor.userId);
      }
    }
  });

  it('после транзакции соединение не помнит контекст', async () => {
    const { db } = fakeDb(1);
    let seen: Tx | undefined;
    await db.transaction(person('u1', ['founder']), async (tx) => {
      seen = tx;
    });
    expect(contextOf(seen!)).toBeUndefined();
  });

  it('основание копится без дублей', () => {
    const scope = newScope();
    noteBasis(scope, { check: 'self' });
    noteBasis(scope, { check: 'self' });
    expect(scope.basis).toHaveLength(1);
  });
});

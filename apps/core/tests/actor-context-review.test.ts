import { describe, expect, it } from 'vitest';
import { AuditRepository } from '../src/audit/audit.repository';
import { newScope } from '../src/audit/actor-context';
import { claimRequestKey, requestHash } from '../src/db/request-keys';
import { Database, type RequestContext, type Tx } from '../src/db/unit-of-work';
import { actingOnProject } from '../src/lab/acting-role';

/**
 * Блок 10 — регрессии по замечаниям Тэнка 09.11 (docs/architecture/b10-actor-context.md):
 * ID операции при повторе, основание без проверки, автор в контексте доступа, просмотр.
 */

interface Emitted {
  actorId: string | null;
  actorRole: string;
  context: Record<string, any>;
}

/** Поддельный пул; `answer` отвечает на прочие запросы (участие в проекте и т. п.). */
function fakeDb(answer: (sql: string, params: unknown[]) => { rows: any[]; rowCount?: number } = () => ({ rows: [] })) {
  const emitted: Emitted[] = [];
  const client: any = {
    on() {},
    removeListener() {},
    release() {},
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('audit.app_emit_event')) {
        emitted.push({
          actorId: params[1] as string | null,
          actorRole: params[2] as string,
          context: JSON.parse(params[5] as string),
        });
        return { rows: [{ id: 'e' }] };
      }
      return answer(sql, params);
    },
  };
  const pool = { connect: async () => client };
  const db = Object.create(Database.prototype) as Database;
  Object.assign(db as any, {
    pool,
    statementTimeoutMs: 1000,
    logger: { error() {} },
    serviceRolePool: () => pool,
  });
  return { db, emitted, audit: new AuditRepository(db) };
}

const emitUpdate = (audit: AuditRepository, tx: Tx, actorId: string | null, actorRole: string) =>
  audit.emit(tx, {
    verb: 'lab.project.updated',
    actorId,
    actorRole,
    subjectType: 'project',
    subjectId: '00000000-0000-0000-0000-000000000001',
  });

describe('основание без проверки', () => {
  it('пустое основание — отказ, роль из аргумента не подставляется', async () => {
    const { db, audit } = fakeDb();
    const ctx: RequestContext = { userId: 'u1', roles: ['admin'], traceId: 't', actor: newScope() };
    await expect(db.transaction(ctx, (tx) => emitUpdate(audit, tx, 'u1', 'admin'))).rejects.toThrow(
      /основание не отмечено/,
    );
  });

  it('системный контекст без задачи — тоже отказ', async () => {
    const { db, audit } = fakeDb();
    const ctx: RequestContext = { userId: null, roles: ['system'], traceId: 't' };
    await expect(db.transaction(ctx, (tx) => emitUpdate(audit, tx, null, 'system'))).rejects.toThrow(
      /основание не отмечено/,
    );
  });

  it('явно обозначенное неизвестное происхождение пишется и видно в записи', async () => {
    const { db, audit, emitted } = fakeDb();
    const ctx: RequestContext = {
      userId: null,
      roles: [],
      traceId: 't',
      actor: { ...newScope([{ check: 'unknown', reason: 'миграция данных' }]), kind: 'system' },
    };
    await db.transaction(ctx, (tx) => emitUpdate(audit, tx, null, 'system'));
    expect(emitted[0]!.context.actor.basis).toEqual([{ check: 'unknown', reason: 'миграция данных' }]);
  });

  it('проект: ни участия, ни администратора — отказ, а не «founder»', async () => {
    const { db } = fakeDb((sql) =>
      sql.includes('is_project_member') ? { rows: [{ member: false }] } : { rows: [] },
    );
    // Основание маршрута founder уже есть — прежде оно совпало бы с выдуманным участием.
    const ctx: RequestContext = {
      userId: 'u1',
      roles: ['founder'],
      traceId: 't',
      actor: newScope([{ check: 'route-role', role: 'founder' }]),
    };
    await expect(db.transaction(ctx, (tx) => actingOnProject(tx, ctx, 'p1'))).rejects.toMatchObject({
      status: 403,
    });
  });

  it('проект: участник — основание member, роль founder', async () => {
    const { db } = fakeDb((sql) =>
      sql.includes('is_project_member') ? { rows: [{ member: true }] } : { rows: [] },
    );
    const ctx: RequestContext = {
      userId: 'u1',
      roles: ['founder', 'admin'],
      traceId: 't',
      actor: newScope([{ check: 'route-role', role: 'founder' }]),
    };
    expect(await db.transaction(ctx, (tx) => actingOnProject(tx, ctx, 'p1'))).toBe('founder');
    expect(ctx.actor!.basis).toEqual([{ check: 'member', object: 'project:p1' }]);
  });
});

describe('контекст доступа сотрудника', () => {
  const participant = (): RequestContext => ({
    userId: 'participant',
    roles: ['founder'],
    traceId: 't',
    initiatorUserId: 'staff',
    testSessionId: 's1',
    actor: newScope([{ check: 'member', object: 'project:p1' }]),
    access: { kind: 'participant', capability: 'testing.sessions.manage' },
  });

  it('автор — сотрудник, учётная запись контекста — onBehalfOf', async () => {
    const { db, audit, emitted } = fakeDb();
    await db.transaction(participant(), (tx) => emitUpdate(audit, tx, 'participant', 'founder'));
    expect(emitted[0]!.actorId).toBe('staff');
    expect(emitted[0]!.context.actor).toMatchObject({
      kind: 'person',
      userId: 'staff',
      onBehalfOf: 'participant',
      testSessionId: 's1',
      accessContext: { kind: 'participant', capability: 'testing.sessions.manage' },
    });
  });

  it('чужой автор в вызове — отказ и в контексте доступа', async () => {
    const { db, audit } = fakeDb();
    await expect(
      db.transaction(participant(), (tx) => emitUpdate(audit, tx, 'someone', 'founder')),
    ).rejects.toThrow(/не совпадает/);
  });

  it('запись во время просмотра остаётся «просмотром»: viewMode=true', async () => {
    const { db, audit, emitted } = fakeDb();
    const ctx: RequestContext = {
      userId: 'owner',
      roles: ['founder'],
      traceId: 't',
      viewOnly: true,
      initiatorUserId: 'staff',
      actor: newScope([{ check: 'capability', code: 'identity.user.view_as' }]),
      access: { kind: 'readonly', capability: 'identity.user.view_as' },
    };
    await audit.recordDuringView(ctx, {
      verb: 'identity.user_contacts.revealed',
      actorId: 'staff',
      actorRole: 'admin',
      subjectType: 'user',
      subjectId: 'owner',
    });
    expect(emitted[0]!.actorId).toBe('staff');
    expect(emitted[0]!.context).toMatchObject({
      viewMode: true,
      actor: { userId: 'staff', onBehalfOf: 'owner', viewMode: true },
    });
  });
});

describe('ID операции при повторе', () => {
  const rk = {
    operation: 'lab.project.create' as const,
    key: 'k1',
    objectId: null,
    payload: { title: 'x' },
  };

  it('первое выполнение сохраняет operationId вместе с ключом', async () => {
    let saved: unknown;
    const { db } = fakeDb((sql, params) => {
      if (sql.startsWith('SHOW lock_timeout')) return { rows: [{ lock_timeout: '0' }] };
      if (sql.includes('INSERT INTO requests.idempotency_keys')) {
        saved = params[6];
        return { rows: [], rowCount: 1 };
      }
      return { rows: [] };
    });
    const ctx: RequestContext = { userId: 'u1', roles: [], traceId: 'req-1', actor: newScope() };
    const prior = await db.transaction(ctx, (tx) => claimRequestKey(tx, ctx, rk as any, 'r1'));
    expect(prior).toBeNull();
    expect(saved).toBe(ctx.actor!.operationId);
  });

  it('повтор продолжает ту же операцию; запрос остаётся своим', async () => {
    const first = 'op-первого-выполнения';
    const { db } = fakeDb((sql) => {
      if (sql.startsWith('SHOW lock_timeout')) return { rows: [{ lock_timeout: '0' }] };
      if (sql.includes('INSERT INTO requests.idempotency_keys')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM requests.idempotency_keys'))
        return {
          rows: [
            {
              object_id: null,
              request_hash: requestHash(rk as any),
              result_id: 'r1',
              expired: false,
              operation_id: first,
            },
          ],
        };
      return { rows: [] };
    });
    const ctx: RequestContext = { userId: 'u1', roles: [], traceId: 'req-2', actor: newScope() };
    const prior = await db.transaction(ctx, (tx) => claimRequestKey(tx, ctx, rk as any, 'r2'));
    expect(prior).toBe('r1');
    expect(ctx.actor!.operationId).toBe(first);
    expect(ctx.traceId).toBe('req-2');
  });

  it('ключ до M173 без операции — операция не выдумывается', async () => {
    const { db } = fakeDb((sql) => {
      if (sql.startsWith('SHOW lock_timeout')) return { rows: [{ lock_timeout: '0' }] };
      if (sql.includes('INSERT INTO requests.idempotency_keys')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM requests.idempotency_keys'))
        return {
          rows: [
            { object_id: null, request_hash: requestHash(rk as any), result_id: 'r1', expired: false, operation_id: null },
          ],
        };
      return { rows: [] };
    });
    const ctx: RequestContext = { userId: 'u1', roles: [], traceId: 'req-3', actor: newScope() };
    const own = ctx.actor!.operationId;
    await db.transaction(ctx, (tx) => claimRequestKey(tx, ctx, rk as any, 'r3'));
    expect(ctx.actor!.operationId).toBe(own);
  });
});

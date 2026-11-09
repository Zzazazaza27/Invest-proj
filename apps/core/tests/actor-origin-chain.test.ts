import { describe, expect, it } from 'vitest';
import { AuditRepository } from '../src/audit/audit.repository';
import { newScope, originOf, roleFromBasis } from '../src/audit/actor-context';
import { Database, contextOf, type RequestContext } from '../src/db/unit-of-work';
import {
  UploadCompletion,
  type UploadRow,
  type UploadTarget,
} from '../src/storage/upload-completion';

/**
 * Блок 10, замечание Тэнка 09.11 к originOf: сотрудник A действует за участника B.
 * Цепочка целиком: контекст доступа → сохранённое происхождение (как в upload_origin) →
 * фоновое завершение загрузки → запись журнала. Исполнитель — система, инициатор — A,
 * связь с B и ID операции сохранены.
 */

describe('происхождение операции сотрудника за участника переходит в фон', () => {
  it('контекст A за B → происхождение → фоновая запись', async () => {
    // 1. Запрос в контексте доступа: A (сотрудник) за B (участник тестовой сессии).
    const request: RequestContext = {
      userId: 'participant-B',
      roles: ['founder'],
      traceId: 'req-upload',
      initiatorUserId: 'staff-A',
      testSessionId: 'session-1',
      actor: newScope([{ check: 'member', object: 'project:p1' }]),
      access: { kind: 'participant', capability: 'testing.sessions.manage' },
    };
    // 2. Сохранение происхождения — как при выдаче билета загрузки (JSON в базе).
    const stored = JSON.parse(JSON.stringify(originOf(request)));
    expect(stored.initiator).toEqual({
      kind: 'person',
      userId: 'staff-A',
      onBehalfOf: 'participant-B',
      testSessionId: 'session-1',
    });

    // 3. Фоновая сверка завершает загрузку с этим происхождением.
    const row: UploadRow = {
      id: 'm1',
      upload_origin: stored,
      project_id: 'p1',
      type: 'deck',
      uploaded_by: 'participant-B',
      upload_state: 'pending',
      upload_state_reason: null,
      upload_key: 'projects/p1/materials/deck/m1/upload',
      upload_expires_at: new Date(Date.now() + 600_000),
      upload_max_bytes: '1000',
      object_received_at: null,
      not_received_at: null,
      s3_key: null,
      size_bytes: null,
      content_hash: null,
      check_failures: 0,
      unknown_since: null,
    };
    const emitted: { actorId: string | null; actorRole: string; context: any }[] = [];
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
          return { rows: [{ id: 'e1' }], rowCount: 1 };
        }
        if (/RETURNING t\.id/.test(sql)) return { rows: [{ id: 'm1' }], rowCount: 1 };
        if (/^\s*SELECT id, project_id/.test(sql)) return { rows: [row], rowCount: 1 };
        return { rows: [], rowCount: 1 };
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
    const audit = new AuditRepository(db);
    const s3 = {
      headObject: async () => ({ exists: true, sizeBytes: 10, etag: null }),
      copyObject: async () => undefined,
      readObjectDigest: async () => ({
        exists: true,
        sizeBytes: 10,
        sha256: 'ab',
        head: Buffer.from('%PDF-'),
      }),
    };
    // Цель — как у материалов: событие публикации пишется журналом в транзакции публикации.
    const target: UploadTarget = {
      table: 'lab.project_materials',
      attemptsTable: 'lab.material_upload_attempts',
      finalKey: (_r, attemptId) => `final/${attemptId}`,
      validate: () => null,
      contentType: () => 'application/pdf',
      authorMayPublish: async () => true,
      emitPublished: async (tx, r, info) => {
        await audit.emit(tx, {
          verb: 'lab.material.added',
          actorId: info.executor === 'browser' ? info.actorId : null,
          actorRole:
            info.executor === 'browser'
              ? (roleFromBasis(contextOf(tx)?.actor?.basis ?? [], 'person') ?? 'founder')
              : 'system',
          subjectType: 'project',
          subjectId: r.project_id,
          context: { materialId: r.id },
        });
      },
    };
    const outcome = await new UploadCompletion(db, s3 as never, target).complete('m1', {
      executor: 'reconcile',
      actorId: null,
      traceId: 'uploads-reconcile-run-7',
    });

    // 4. Фоновая запись: исполнитель — система, инициатор — A, связь с B и операция прежние.
    expect(outcome.state).toBe('ready');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.actorId).toBeNull();
    expect(emitted[0]!.context.actor).toMatchObject({
      kind: 'system',
      userId: null,
      role: 'system',
      job: { name: 'uploads.reconcile', runId: 'uploads-reconcile-run-7', attempt: 1 },
      operationId: request.actor!.operationId,
      initiator: {
        kind: 'person',
        userId: 'staff-A',
        onBehalfOf: 'participant-B',
        testSessionId: 'session-1',
      },
    });
  });

  it('без контекста доступа инициатор — сам человек, связи «за кого» нет', () => {
    const origin = originOf({
      userId: 'u1',
      roles: ['founder'],
      traceId: 't',
      actor: newScope([{ check: 'self' }]),
    } as RequestContext);
    expect(origin.initiator).toEqual({ kind: 'person', userId: 'u1' });
  });
});

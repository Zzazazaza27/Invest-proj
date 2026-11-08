import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type {
  AdminGroupStatus,
  FunctionGroup,
  GroupMode,
  GroupReason,
  GroupStatus,
  SetRestrictionRequest,
} from '@fifth/contracts';
import { AuditRepository } from '../audit/audit.repository';
import { BackgroundJobsService } from '../background/background-jobs.service';
import { resultOf } from '../background/job';
import { errors } from '../common/errors';
import { getEnv } from '../config/env';
import { Database, type RequestContext } from '../db/unit-of-work';
import { assertCapability } from '../identity/capabilities.service';
import { PROBE_PREFIX, S3Service } from '../storage/s3.service';
import {
  dependencyState,
  groupStatus,
  isFresh,
  type DependencyState,
  type Observation,
  type Restriction,
} from './rules';
import { storageBreaker } from './storage-health';

/** Служебные ключи проб «Файлов»: вне материалов людей и квот. */
/** Контрольный объект чтения: известное маленькое содержимое, общее для всех экземпляров. */
export const READ_CONTROL_KEY = `${PROBE_PREFIX}read-control`;
export const READ_CONTROL_BODY = Buffer.from('fifth availability read control v1\n');
const writeKey = (instance: string) =>
  `${PROBE_PREFIX}write-probe-${instance.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
const PROBE_BODY = Buffer.from('fifth availability probe v1\n');
const RESTRICTION_CACHE_MS = 5_000;
const SYSTEM = (traceId: string): RequestContext => ({ userId: null, roles: ['system'], traceId });

interface RestrictionRow {
  mode: 'read_only' | 'unavailable';
  reason_code: 'maintenance' | 'incident' | 'security' | 'other';
  note: string;
  set_at: Date;
}

/**
 * Доступность групп функций (блок 4, 4.11), первая группа — «Файлы».
 *
 *   * наблюдение: служебная задача блока 1 раз в AVAILABILITY_PROBE_INTERVAL_MS проверяет
 *     чтение (GET контрольного объекта и сверка с известным содержимым; отсутствие объекта
 *     успехом не считается — объект готовится один раз записью и сразу перечитывается) и
 *     запись (PUT маленького фиксированного объекта) с пределом времени; результат с
 *     пределом актуальности пишется в БД и помнится локально;
 *   * решение для операции — по этому экземпляру: ручное ограничение, размыкатель и
 *     свежесть своего наблюдения. Отказ файлов не снимает готовность ядра (`/ready`);
 *   * показ и эксплуатация — сведение наблюдений всех экземпляров (rules.ts).
 */
@Injectable()
export class AvailabilityService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AvailabilityService.name);
  private readonly local: Record<GroupMode, Observation | null> = { read: null, write: null };
  private restriction: { value: RestrictionRow | null; at: number } | null = null;

  constructor(
    private readonly db: Database,
    private readonly s3: S3Service,
    private readonly jobs: BackgroundJobsService,
    private readonly audit: AuditRepository,
  ) {}

  get instance(): string {
    return this.jobs.instanceId;
  }

  onModuleInit(): void {
    this.jobs.register({
      name: 'availability.observe',
      intervalMs: getEnv().AVAILABILITY_PROBE_INTERVAL_MS,
      coordination: 'local',
      // Первая проверка — сразу при запуске: без неё запись была бы «неизвестна» до 30 с.
      runAtStart: true,
      run: async () => resultOf(await this.observe()),
    });
  }

  /** Экземпляр останавливается: его наблюдения в сведение больше не входят. */
  async onModuleDestroy(): Promise<void> {
    await this.db
      .transaction(SYSTEM('availability-stop'), (tx) =>
        tx.query('UPDATE availability.observations SET stopped = true WHERE instance = $1', [
          this.instance,
        ]),
      )
      .catch(() => undefined);
  }

  /** Одна служебная проверка группы «Файлы». Возвращает число исправных режимов. */
  async observe(): Promise<number> {
    const env = getEnv();
    const timeout = env.AVAILABILITY_PROBE_TIMEOUT_MS;
    const check = async (mode: GroupMode, probe: () => Promise<unknown>) => {
      if (!this.s3.isConfigured) return { ok: false, reason: 'not_configured' as GroupReason };
      try {
        await withTimeout(probe(), timeout);
        storageBreaker().probe(mode, true);
        return { ok: true, reason: 'ok' as GroupReason };
      } catch {
        return { ok: false, reason: 'dependency_failure' as GroupReason };
      }
    };
    const results = {
      read: await check('read', () => this.readControl(timeout)),
      write: await check('write', () =>
        this.s3.putProbeObject(writeKey(this.instance), PROBE_BODY, timeout),
      ),
    };
    const observedAt = new Date();
    const validUntil = new Date(observedAt.getTime() + env.AVAILABILITY_FRESH_MS);
    for (const mode of ['read', 'write'] as const) {
      this.local[mode] = {
        instance: this.instance,
        mode,
        ...results[mode],
        observedAt,
        validUntil,
        stopped: false,
      };
    }
    await this.db.transaction(SYSTEM('availability-observe'), async (tx) => {
      for (const mode of ['read', 'write'] as const) {
        await tx.query(
          `INSERT INTO availability.observations
             (instance, group_id, mode, ok, reason, observed_at, valid_until, stopped)
           VALUES ($1, 'files', $2, $3, $4, $5, $6, false)
           ON CONFLICT (instance, group_id, mode) DO UPDATE
             SET ok = EXCLUDED.ok, reason = EXCLUDED.reason, observed_at = EXCLUDED.observed_at,
                 valid_until = EXCLUDED.valid_until, stopped = false`,
          [this.instance, mode, results[mode].ok, results[mode].reason, observedAt, validUntil],
        );
      }
    });
    return Number(results.read.ok) + Number(results.write.ok);
  }

  /**
   * Чтение подтверждено, только когда прочитано известное содержимое. Нет объекта — его
   * готовят записью (один раз, а не на каждой проверке) и перечитывают; не вышло — отказ.
   */
  private async readControl(timeout: number): Promise<void> {
    let body = await this.s3.getProbeObject(READ_CONTROL_KEY, timeout);
    if (body === null) {
      await this.s3.putProbeObject(READ_CONTROL_KEY, READ_CONTROL_BODY, timeout);
      body = await this.s3.getProbeObject(READ_CONTROL_KEY, timeout);
    }
    if (body === null || !body.equals(READ_CONTROL_BODY)) {
      throw new Error('контрольный объект чтения не совпал');
    }
  }

  /** Своё наблюдение с поправкой на размыкатель этого экземпляра. */
  private localDependency(mode: GroupMode, now: Date): DependencyState {
    if (storageBreaker().isOpen(mode)) {
      return { health: 'fail', reason: 'circuit_open', observedAt: now };
    }
    const own = this.local[mode];
    return dependencyState(own ? [own] : [], mode, now);
  }

  private async currentRestriction(): Promise<RestrictionRow | null> {
    if (this.restriction && Date.now() - this.restriction.at < RESTRICTION_CACHE_MS) {
      return this.restriction.value;
    }
    const value = await this.db.readOnly(SYSTEM('availability-restriction'), async (tx) => {
      const { rows } = await tx.query<RestrictionRow>(
        `SELECT mode, reason_code, note, set_at FROM availability.restrictions
          WHERE group_id = 'files'`,
      );
      return rows[0] ?? null;
    });
    this.restriction = { value, at: Date.now() };
    return value;
  }

  /** Состояние группы для операций ЭТОГО экземпляра. */
  async localStatus(): Promise<GroupStatus> {
    const now = new Date();
    const restriction = await this.currentRestriction();
    return groupStatus({
      read: this.localDependency('read', now),
      write: this.localDependency('write', now),
      restriction: restriction ? ({ mode: restriction.mode } satisfies Restriction) : null,
    });
  }

  /**
   * Проверка операции: недоступный режим — `group_unavailable` с группой и безопасной
   * причиной. Не заменяет права, валидацию и защиту от дублей.
   */
  async assert(group: FunctionGroup, mode: GroupMode): Promise<void> {
    const status = await this.localStatus();
    const decision = status[mode];
    if (!decision.allowed) throw errors.groupUnavailable(group, mode, decision.reason);
  }

  /** Можно ли сейчас выполнять изменение (для фоновой сверки — без исключения). */
  async allows(mode: GroupMode): Promise<boolean> {
    return (await this.localStatus())[mode].allowed;
  }

  private async observations(): Promise<Observation[]> {
    return this.db.readOnly(SYSTEM('availability-read'), async (tx) => {
      const { rows } = await tx.query<{
        instance: string;
        mode: GroupMode;
        ok: boolean;
        reason: GroupReason;
        observed_at: Date;
        valid_until: Date;
        stopped: boolean;
      }>(
        `SELECT instance, mode, ok, reason, observed_at, valid_until, stopped
           FROM availability.observations WHERE group_id = 'files'`,
      );
      return rows.map((r) => ({
        instance: r.instance,
        mode: r.mode,
        ok: r.ok,
        reason: r.reason,
        observedAt: r.observed_at,
        validUntil: r.valid_until,
        stopped: r.stopped,
      }));
    });
  }

  /** Сводное состояние платформы — для показа в кабинетах. */
  async platformStatus(): Promise<GroupStatus> {
    const now = new Date();
    const all = await this.observations();
    const restriction = await this.currentRestriction();
    return groupStatus({
      read: dependencyState(all, 'read', now, getEnv().AVAILABILITY_RETIRE_MS),
      write: dependencyState(all, 'write', now, getEnv().AVAILABILITY_RETIRE_MS),
      restriction: restriction ? { mode: restriction.mode } : null,
    });
  }

  /** Взгляд эксплуатации: исправность зависимости и ручной запрет — раздельно. */
  async adminStatus(): Promise<AdminGroupStatus> {
    const now = new Date();
    const all = await this.observations();
    this.restriction = null;
    const restriction = await this.currentRestriction();
    const read = dependencyState(all, 'read', now, getEnv().AVAILABILITY_RETIRE_MS);
    const write = dependencyState(all, 'write', now, getEnv().AVAILABILITY_RETIRE_MS);
    return {
      group: 'files',
      status: groupStatus({
        read,
        write,
        restriction: restriction ? { mode: restriction.mode } : null,
      }),
      dependency: { read: read.health, write: write.health },
      restriction: restriction
        ? {
            mode: restriction.mode,
            reasonCode: restriction.reason_code,
            note: restriction.note,
            setAt: restriction.set_at.toISOString(),
          }
        : null,
      instances: all.map((o) => ({
        instance: o.instance,
        mode: o.mode,
        ok: o.ok,
        reason: o.reason,
        observedAt: o.observedAt.toISOString(),
        fresh: isFresh(o, now),
        stopped: o.stopped,
      })),
    };
  }

  async setRestriction(ctx: RequestContext, input: SetRestrictionRequest): Promise<void> {
    await this.db.transaction(ctx, async (tx) => {
      await assertCapability(tx, 'ops.availability.update', 'ограничить группу функций');
      await tx.query(
        `INSERT INTO availability.restrictions (group_id, mode, reason_code, note, set_by)
         VALUES ('files', $1, $2, $3, app.current_user_id())
         ON CONFLICT (group_id) DO UPDATE
           SET mode = EXCLUDED.mode, reason_code = EXCLUDED.reason_code, note = EXCLUDED.note,
               set_by = EXCLUDED.set_by, set_at = now()`,
        [input.mode, input.reasonCode, input.note],
      );
      await this.audit.emit(tx, {
        verb: 'ops.function_restriction.set',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'function_group',
        subjectId: null,
        context: {
          group: 'files',
          mode: input.mode,
          reasonCode: input.reasonCode,
          note: input.note,
        },
        traceId: ctx.traceId,
      });
    });
    this.restriction = null;
    this.logger.warn({
      msg: 'введено ручное ограничение группы функций',
      group: 'files',
      mode: input.mode,
    });
  }

  async clearRestriction(ctx: RequestContext, note: string): Promise<void> {
    await this.db.transaction(ctx, async (tx) => {
      await assertCapability(tx, 'ops.availability.update', 'снять ограничение группы функций');
      const { rowCount } = await tx.query(
        `DELETE FROM availability.restrictions WHERE group_id = 'files'`,
      );
      if (!rowCount) throw errors.notFound({ subject: 'function_restriction' });
      await this.audit.emit(tx, {
        verb: 'ops.function_restriction.cleared',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'function_group',
        subjectId: null,
        context: { group: 'files', note },
        traceId: ctx.traceId,
      });
    });
    this.restriction = null;
    this.logger.log({ msg: 'ручное ограничение группы функций снято', group: 'files' });
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('предел времени проверки')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

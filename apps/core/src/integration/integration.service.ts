import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  INTEGRATION_SCOPES,
  uuidv7,
  type IntegrationScope,
  type ServiceAccount,
  type ServiceAccountWithSecret,
} from '@fifth/contracts';
import { AuditRepository } from '../audit/audit.repository';
import { newScope } from '../audit/actor-context';
import { errors } from '../common/errors';
import { claimRequestKey } from '../db/request-keys';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { issueServiceToken } from './service-auth';
import { ServiceAccountStateService } from './service-account-state.service';

/**
 * Integration API.
 *
 * Весь модуль работает под ролью БД `app_integration`, а не под ролью
 * приложения. Это не формальность: у интеграционной роли нет доступа ни к
 * схеме `identity`, ни к денежным таблицам биллинга, и даже ошибка в SQL этого
 * модуля не сможет вытащить наружу персональные данные — прав просто нет.
 *
 * Второе следствие того же выбора: контур выключен, пока не задан
 * `DATABASE_URL_APP_INTEGRATION`. Попытка обслужить внешнюю систему под правами
 * пользовательской роли обязана падать явно (ADR-006).
 */
@Injectable()
export class IntegrationService {
  private readonly logger = new Logger(IntegrationService.name);

  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
    private readonly accounts: ServiceAccountStateService,
  ) {}

  // ------------------------------------------------- сервисные аккаунты (admin)

  async createServiceAccount(
    ctx: RequestContext,
    input: {
      name: string;
      clientId: string;
      scopes: string[];
      mtlsCertFingerprint: string;
    },
    key: string | null = null,
  ): Promise<ServiceAccountWithSecret> {
    const unknown = input.scopes.filter(
      (scope) => !INTEGRATION_SCOPES.includes(scope as IntegrationScope),
    );
    if (unknown.length > 0) {
      throw errors.validation([
        { path: 'scopes', message: `неизвестные скоупы: ${unknown.join(', ')}` },
      ]);
    }

    const secret = generateSecret();
    const id = uuidv7();

    const created = await this.db.transaction(ctx, async (tx) => {
      // Ключ повтора — первым действием (2.6, M164). Повтор тем же ключом аккаунт не создаёт
      // и секрета не показывает: он был в первом ответе, в БД — только хеш.
      if (key) {
        const earlier = await claimRequestKey(
          tx,
          ctx,
          {
            key,
            operation: 'integration.service_account.create',
            objectId: null,
            payload: {
              name: input.name,
              clientId: input.clientId,
              scopes: [...input.scopes].sort(),
              mtlsCertFingerprint: input.mtlsCertFingerprint.toLowerCase(),
            },
          },
          id,
        );
        if (earlier) return { replay: await this.readAccount(tx, earlier) };
      }
      try {
        const { rows } = await tx.query<AccountRow>(
          `INSERT INTO integration.service_accounts
             (id, client_id, name, client_secret_hash, mtls_cert_fingerprint, scopes, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING id, client_id, name, scopes, status, created_at, rotated_at, token_epoch`,
          [
            id,
            input.clientId,
            input.name,
            await argon2.hash(secret, ARGON2_OPTIONS),
            input.mtlsCertFingerprint.toLowerCase(),
            input.scopes,
            ctx.userId,
          ],
        );

        await this.audit.record(tx, {
          verb: 'integration.service_account.created',
          actorId: ctx.userId,
          actorRole: 'admin',
          aggregateType: 'service_account',
          aggregateId: id,
          aggregateVersion: 1,
          // Ни секрета, ни его хеша в журнале: событие фиксирует факт, а не ключ.
          payload: { clientId: input.clientId, scopes: input.scopes },
          traceId: ctx.traceId,
        });

        return {
          account: {
            ...mapAccount(rows[0]!),
            secretDelivery: 'issued' as const,
            clientSecret: secret,
          },
          epoch: Number(rows[0]!.token_epoch),
        };
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw errors.conflict('Такой client_id уже занят');
        }
        if ((error as { code?: string }).code === '23514') {
          throw errors.validation([{ path: 'scopes', message: 'скоуп вне allowlist' }]);
        }
        throw error;
      }
    });
    // Свежесозданный аккаунт обязан попасть в снимок активных НЕМЕДЛЕННО —
    // симметрично ротации и смене состояния ниже. Без этого его первый токен
    // отвергается (integration-account-state) до истечения SNAPSHOT_TTL_MS:
    // снимок свежий, аккаунта в нём нет. Найдено smoke-integration в Ф30 —
    // раньше маскировалось порядком прогонов (первое чтение снимка случалось
    // после создания клиентов).
    if ('replay' in created) return created.replay!;
    this.accounts.markEpochLocally(id, created.epoch);
    return created.account;
  }

  /** Аккаунт для ответа на повтор: без секрета, с явной пометкой «уже выдан». */
  private async readAccount(tx: Tx, accountId: string): Promise<ServiceAccountWithSecret> {
    const { rows } = await tx.query<AccountRow>(
      `SELECT id, client_id, name, scopes, status, created_at, rotated_at, token_epoch
         FROM integration.service_accounts WHERE id = $1`,
      [accountId],
    );
    if (!rows[0]) throw errors.notFound({ subject: 'service_account' });
    return { ...mapAccount(rows[0]), secretDelivery: 'already_issued', clientSecret: null };
  }

  /**
   * Ротация секрета. Старый перестаёт действовать в момент коммита — «мягкого
   * периода», когда работают оба, здесь нет намеренно: два действующих секрета
   * означают, что скомпрометированный продолжает работать.
   */
  async rotateSecret(
    ctx: RequestContext,
    accountId: string,
    key: string | null = null,
  ): Promise<ServiceAccountWithSecret> {
    const secret = generateSecret();
    const rotated = await this.db.transaction(ctx, async (tx) => {
      // Повтор тем же ключом (2.6, M164) — второй ротации нет: секрет, выданный первым
      // ответом, остаётся действующим, событие и рубеж не повторяются.
      if (key) {
        const earlier = await claimRequestKey(
          tx,
          ctx,
          {
            key,
            operation: 'integration.service_account.rotate',
            objectId: accountId,
            payload: {},
          },
          accountId,
        );
        if (earlier) return { replay: await this.readAccount(tx, earlier) };
      }
      const { rows } = await tx.query<AccountRow>(
        `UPDATE integration.service_accounts
            SET client_secret_hash = $2,
                rotated_at = now(),
                -- Рубеж растёт вместе с секретом: иначе токены, выданные по
                -- старому секрету, продолжали бы работать до истечения (SEC-08).
                token_epoch = token_epoch + 1
          WHERE id = $1
          RETURNING id, client_id, name, scopes, status, created_at, rotated_at, token_epoch`,
        [accountId, await argon2.hash(secret, ARGON2_OPTIONS)],
      );
      const account = rows[0];
      if (!account) throw errors.notFound({ subject: 'service_account' });

      await this.audit.record(tx, {
        verb: 'integration.service_account.rotated',
        actorId: ctx.userId,
        actorRole: 'admin',
        aggregateType: 'service_account',
        aggregateId: accountId,
        // Ротация повторяется: фиксированная «2» на второй ротации давала бы
        // конфликт версии и потерю события (CODE-06).
        aggregateVersion: await this.audit.nextAggregateVersion(
          tx,
          'service_account',
          accountId,
          'integration.service_account.rotated',
        ),
        payload: { clientId: account.client_id },
        traceId: ctx.traceId,
      });

      // Рубеж возвращается отдельным полем, а не через контракт: наружу число
      // рубежа не отдаётся — оно внутреннее и держателю токена не нужно.
      return {
        account: {
          ...mapAccount(account),
          secretDelivery: 'issued' as const,
          clientSecret: secret,
        },
        epoch: account.token_epoch,
      };
    });
    if ('replay' in rotated) return rotated.replay!;
    // Снимок своего экземпляра обновляется ПОСЛЕ фиксации: внутри транзакции
    // откат оставил бы в памяти рубеж, которого в БД нет, и действующие токены
    // отвергались бы до истечения снимка.
    this.accounts.markEpochLocally(rotated.account.id, Number(rotated.epoch));
    return rotated.account;
  }

  /**
   * Приостановка и возобновление сервисного аккаунта.
   *
   * Приостановка обесценивает уже выданные токены, а не только закрывает выдачу
   * новых: она увеличивает рубеж аккаунта (`token_epoch`, M042), и токен со
   * старым рубежом отвергается на входе. Раньше этого не было — приостановленный
   * аккаунт продолжал работать по выданному токену до его истечения, то есть до
   * часа (SEC-08). Задержка на других экземплярах — не больше срока жизни снимка
   * в `ServiceAccountStateService`.
   */
  async setServiceAccountStatus(
    ctx: RequestContext,
    accountId: string,
    status: 'active' | 'suspended',
  ): Promise<ServiceAccount> {
    const changed = await this.db.transaction(ctx, async (tx) => {
      const { rows } = await tx.query<AccountRow>(
        `UPDATE integration.service_accounts
            SET status = $2,
                -- Рубеж растёт и при возобновлении тоже: иначе «приостановить и
                -- вернуть» воскрешало бы токены, выданные до инцидента.
                token_epoch = token_epoch + 1
          WHERE id = $1 AND status <> $2
          RETURNING id, client_id, name, scopes, status, created_at, rotated_at, token_epoch`,
        [accountId, status],
      );
      const account = rows[0];
      // Отсутствие строки означает либо чужой идентификатор, либо тот же статус:
      // и то и другое — не изменение, и события об изменении быть не должно.
      if (!account) {
        const { rows: existing } = await tx.query<AccountRow>(
          `SELECT id, client_id, name, scopes, status, created_at, rotated_at, token_epoch
             FROM integration.service_accounts WHERE id = $1`,
          [accountId],
        );
        if (!existing[0]) throw errors.notFound({ subject: 'service_account' });
        return { account: mapAccount(existing[0]), epoch: null };
      }

      const verb =
        status === 'suspended'
          ? 'integration.service_account.suspended'
          : 'integration.service_account.resumed';
      await this.audit.record(tx, {
        verb,
        actorId: ctx.userId,
        actorRole: 'admin',
        aggregateType: 'service_account',
        aggregateId: accountId,
        aggregateVersion: await this.audit.nextAggregateVersion(
          tx,
          'service_account',
          accountId,
          verb,
        ),
        payload: { clientId: account.client_id, status },
        traceId: ctx.traceId,
      });

      return { account: mapAccount(account), epoch: account.token_epoch };
    });

    // После фиксации: приостановленный аккаунт исчезает из снимка, возобновлённый
    // получает новый рубеж. На своём экземпляре — немедленно, на остальных — не
    // позже срока жизни снимка.
    if (changed.epoch !== null) {
      if (changed.account.status === 'suspended') {
        this.accounts.markSuspendedLocally(changed.account.id);
      } else {
        this.accounts.markEpochLocally(changed.account.id, Number(changed.epoch));
      }
    }
    return changed.account;
  }

  async listServiceAccounts(ctx: RequestContext): Promise<ServiceAccount[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<AccountRow>(
        `SELECT id, client_id, name, scopes, status, created_at, rotated_at, token_epoch
           FROM integration.service_accounts
          ORDER BY created_at DESC
          LIMIT 200`,
      );
      return rows.map(mapAccount);
    });
  }

  // ------------------------------------------------------------------- токен

  /**
   * Выдача токена по client_credentials.
   *
   * Три свойства, без которых выдача была бы дырой:
   *  - неизвестный `client_id` стоит столько же времени, сколько известный:
   *    проверка идёт против фиктивного хеша, иначе перебор по времени ответа
   *    выдаёт список клиентов;
   *  - отпечаток клиентского сертификата сверяется constant-time, если проверка
   *    настроена; в production она обязательна (валидация конфигурации);
   *  - ответ на неверный секрет и на неизвестный клиент — один и тот же.
   */
  async issueToken(input: {
    clientId: string;
    clientSecret: string;
    certFingerprint: string | null;
    traceId: string;
  }): Promise<{ accessToken: string; expiresIn: number; scopes: string[] }> {
    const found = await this.db.asServiceRole(
      'app_integration',
      { traceId: input.traceId },
      async (tx) => {
        const { rows } = await tx.query<{
          id: string;
          client_id: string;
          client_secret_hash: string;
          mtls_cert_fingerprint: string;
          scopes: string[];
          token_epoch: number;
        }>(
          // Узкая SECURITY DEFINER-функция вместо прямой выборки (M056): у
          // роли интеграции больше нет SELECT на `client_secret_hash`, то
          // есть перечислить чужие хеши и получить офлайн-оракул нельзя —
          // функция отдаёт материал ровно по запрошенному client_id. Статус
          // проверяется ВНУТРИ функции, а не потом: выборка без статуса
          // делала бы приостановку учётной записи декоративной (SEC-07).
          `SELECT id, client_id, client_secret_hash, mtls_cert_fingerprint, scopes, token_epoch
             FROM integration.find_token_candidate($1)`,
          [input.clientId],
        );
        return rows[0] ?? null;
      },
    );

    const hash = found?.client_secret_hash ?? (await getDummyHash());
    const secretOk = await argon2.verify(hash, input.clientSecret).catch(() => false);

    // Проверка сертификата выполняется ВСЕГДА, когда настроена, — в том числе
    // для несуществующего клиента: ветвление здесь тоже было бы оракулом.
    const certOk =
      input.certFingerprint === null
        ? true
        : constantTimeEquals(input.certFingerprint, found?.mtls_cert_fingerprint ?? '');

    if (!found || !secretOk || !certOk) {
      this.logger.warn({
        msg: 'выдача токена интеграции отклонена',
        clientId: input.clientId,
        traceId: input.traceId,
      });
      throw errors.unauthenticated({ stage: 'integration-credentials' });
    }

    const { token, expiresIn } = issueServiceToken({
      serviceAccountId: found.id,
      clientId: found.client_id,
      scopes: found.scopes,
      tokenEpoch: Number(found.token_epoch),
    });

    // Автор — сервисная учётная запись, подтвердившая секрет (блок 10), а не «система».
    const actor = {
      ...newScope([{ check: 'service-scope' as const, scope: 'client-credentials' }]),
      kind: 'service_account' as const,
      serviceAccountId: found.id,
    };
    await this.db.asServiceRole(
      'app_integration',
      { traceId: input.traceId, actor },
      async (tx) => {
        await this.audit.emit(tx, {
          verb: 'integration.token.issued',
          actorId: null,
          actorRole: 'service',
          subjectType: 'service_account',
          subjectId: found.id,
          context: { clientId: found.client_id, scopes: found.scopes },
          traceId: input.traceId,
        });
      },
    );

    return { accessToken: token, expiresIn, scopes: found.scopes };
  }

  // -------------------------------------------------------------- проекции
}

const ARGON2_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/**
 * Фиктивный хеш для неизвестного клиента. Считается один раз и переиспользуется:
 * без него ответ на несуществующий `client_id` возвращался бы заметно быстрее,
 * чем на существующий, и превращал выдачу токена в перечисление клиентов.
 */
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= argon2.hash(randomBytes(32).toString('hex'), ARGON2_OPTIONS);
  return dummyHashPromise;
}

/** 48 байт энтропии: секрет живёт до ротации и подбираться не должен в принципе. */
function generateSecret(): string {
  return randomBytes(48).toString('base64url');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Курсор keyset-пагинации Integration API: момент + идентификатор. */
interface AccountRow {
  id: string;
  client_id: string;
  name: string;
  scopes: string[];
  status: ServiceAccount['status'];
  created_at: Date;
  rotated_at: Date | null;
  token_epoch: number;
}

function mapAccount(row: AccountRow): ServiceAccount {
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    scopes: row.scopes,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    rotatedAt: row.rotated_at ? row.rotated_at.toISOString() : null,
  };
}

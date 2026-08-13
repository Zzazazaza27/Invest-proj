import { Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  INTEGRATION_DATA_VERSION,
  INTEGRATION_SCOPES,
  uuidv7,
  type ExternalRef,
  type Graduate,
  type IntegrationDeal,
  type IntegrationScope,
  type IrsHistoryEntry,
  type PublicProfile,
  type ServiceAccount,
  type ServiceAccountWithSecret,
} from '@unicorn/contracts';
import { AuditRepository } from '../audit/audit.repository';
import { errors } from '../common/errors';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';
import { issueServiceToken, type IntegrationContext } from './service-auth';
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
          account: { ...mapAccount(rows[0]!), clientSecret: secret },
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
    this.accounts.markEpochLocally(id, created.epoch);
    return created.account;
  }

  /**
   * Ротация секрета. Старый перестаёт действовать в момент коммита — «мягкого
   * периода», когда работают оба, здесь нет намеренно: два действующих секрета
   * означают, что скомпрометированный продолжает работать.
   */
  async rotateSecret(ctx: RequestContext, accountId: string): Promise<ServiceAccountWithSecret> {
    const secret = generateSecret();
    const rotated = await this.db.transaction(ctx, async (tx) => {
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
        account: { ...mapAccount(account), clientSecret: secret },
        epoch: account.token_epoch,
      };
    });
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
          // Статус входит в условие, а не проверяется потом: приостановленная
          // учётная запись продолжала получать токены — отзыв доступа не
          // работал вовсе (SEC-07). Выборка «по client_id» без статуса делает
          // приостановку декоративной.
          `SELECT id, client_id, client_secret_hash, mtls_cert_fingerprint, scopes, token_epoch
             FROM integration.service_accounts
            WHERE client_id = $1 AND status = 'active'`,
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

    await this.db.asServiceRole('app_integration', { traceId: input.traceId }, async (tx) => {
      await this.audit.emit(tx, {
        verb: 'integration.token.issued',
        actorId: null,
        actorRole: 'system',
        subjectType: 'service_account',
        subjectId: found.id,
        context: { clientId: found.client_id, scopes: found.scopes },
        traceId: input.traceId,
      });
    });

    return { accessToken: token, expiresIn, scopes: found.scopes };
  }

  // -------------------------------------------------------------- проекции

  /** Выпускники, готовые к расширенным листингам. Keyset по (graduated_at, id). */
  async graduates(
    ctx: IntegrationContext,
    query: { seasonId?: string; cursor?: { at: string; id: string }; limit: number },
  ): Promise<{ items: Graduate[]; nextCursor: string | null }> {
    return this.db.asServiceRole('app_integration', { traceId: ctx.traceId }, async (tx) => {
      const { rows } = await tx.query<GraduateRow>(
        `SELECT p.id, p.title, p.season_id, p.taxonomy_id, p.stage, p.investment_ask,
                p.graduated_at,
                (SELECT s.value FROM scoring.irs_scores s
                  WHERE s.project_id = p.id ORDER BY s.computed_at DESC LIMIT 1) AS irs,
                (SELECT r.remote_id FROM integration.external_refs r
                  WHERE r.id = p.capital_ref) AS external_ref
           FROM lab.projects p
          WHERE p.status = 'graduated'
            AND p.deleted_at IS NULL
            AND ($1::uuid IS NULL OR p.season_id = $1)
            AND ($2::timestamptz IS NULL
                 OR (p.graduated_at, p.id) < ($2::timestamptz, $3::uuid))
          ORDER BY p.graduated_at DESC, p.id DESC
          LIMIT $4`,
        [query.seasonId ?? null, query.cursor?.at ?? null, query.cursor?.id ?? null, query.limit],
      );
      const items = rows.map(mapGraduate);
      const last = rows[rows.length - 1];
      const nextCursor =
        rows.length === query.limit && last?.graduated_at
          ? encodeIntegrationCursor({ at: last.graduated_at.toISOString(), id: last.id })
          : null;
      return { items, nextCursor };
    });
  }

  async irsHistory(ctx: IntegrationContext, projectId: string): Promise<IrsHistoryEntry[]> {
    return this.db.asServiceRole('app_integration', { traceId: ctx.traceId }, async (tx) => {
      await assertGraduated(tx, projectId);
      const { rows } = await tx.query<{
        value: string;
        previous_value: string | null;
        delta: string | null;
        computed_at: Date;
      }>(
        `SELECT value, previous_value, delta, computed_at FROM scoring.irs_scores
          WHERE project_id = $1 ORDER BY computed_at DESC LIMIT 100`,
        [projectId],
      );
      return rows.map((row) => ({
        value: Number(row.value),
        previousValue: row.previous_value === null ? null : Number(row.previous_value),
        delta: row.delta === null ? null : Number(row.delta),
        computedAt: row.computed_at.toISOString(),
      }));
    });
  }

  /**
   * Инвестиционный паспорт выпускника.
   *
   * `dataroom` наружу не отдаётся ни под каким скоупом: этот уровень раскрытия
   * существует для проверенного инвестора внутри платформы, а не для внешней
   * системы. Маршрут такой tier даже не принимает — он вне enum запроса.
   *
   * У проекта ровно один текущий паспорт (инвариант `passports_one_current`),
   * поэтому «взять версию нужного уровня» невозможно: есть тот уровень, что
   * опубликован. Отдаём его, только если он раскрывает НЕ БОЛЬШЕ запрошенного.
   * Урезать содержимое на лету сервер не умеет и не должен делать вид, что
   * умеет: выдать `full` под видом `teaser` — это раскрытие сверх запрошенного.
   */
  async passport(
    ctx: IntegrationContext,
    projectId: string,
    tier: 'teaser' | 'full',
  ): Promise<Record<string, unknown>> {
    return this.db.asServiceRole('app_integration', { traceId: ctx.traceId }, async (tx) => {
      await assertGraduated(tx, projectId);
      const { rows } = await tx.query<{
        id: string;
        version: number;
        disclosure_tier: string;
        jsonb_data: Record<string, unknown>;
        published_at: Date | null;
      }>(
        `SELECT id, version, disclosure_tier, jsonb_data, published_at
           FROM scoring.investment_passports
          WHERE project_id = $1 AND published_at IS NOT NULL
          ORDER BY version DESC LIMIT 1`,
        [projectId],
      );
      const passport = rows[0];
      if (!passport) throw errors.notFound({ subject: 'passport' });
      if (DISCLOSURE_RANK[passport.disclosure_tier] === undefined) {
        throw errors.notFound({ subject: 'passport' });
      }
      if (DISCLOSURE_RANK[passport.disclosure_tier]! > DISCLOSURE_RANK[tier]!) {
        // Опубликован уровень выше запрошенного — версии с меньшим раскрытием
        // не существует. Отказ, а не выдача «чего есть».
        throw errors.notFound({ subject: 'passport' });
      }
      return {
        projectId,
        version: passport.version,
        disclosureTier: passport.disclosure_tier,
        data: passport.jsonb_data,
        publishedAt: passport.published_at?.toISOString() ?? null,
        dataVersion: INTEGRATION_DATA_VERSION,
      };
    });
  }

  /** Агрегаты договоров. Сторон сделки в ответе нет — только объём и статус. */
  async deals(
    ctx: IntegrationContext,
    query: { cursor?: { at: string; id: string }; limit: number },
  ): Promise<{ items: IntegrationDeal[]; nextCursor: string | null }> {
    return this.db.asServiceRole('app_integration', { traceId: ctx.traceId }, async (tx) => {
      const { rows } = await tx.query<DealRow>(
        `SELECT a.id, o.project_id, a.status, a.contract_amount AS amount, o.instrument_type,
                -- Момент подписания = когда подписали ОБЕ стороны: договор,
                -- подписанный одной, ещё не сделка.
                GREATEST(a.investor_signed_at, a.issuer_signed_at) AS signed_at,
                a.effective_at, a.created_at,
                -- Вознаграждение берётся из ПРОЕКЦИИ, а не из billing.*:
                -- интеграционная роль денежных таблиц не читает (M028).
                -- LEFT JOIN, потому что начисление возникает только с первым
                -- траншем: у подписанной, но не оплаченной сделки его нет, и
                -- ноль здесь был бы неправдой.
                c.total_fee_amount::text AS total_fee_amount,
                c.investor_fee_amount::text AS investor_fee_amount,
                c.issuer_fee_amount::text AS issuer_fee_amount,
                c.accrued_at
           FROM investments.investment_agreements a
           JOIN investments.investment_offers o ON o.id = a.offer_id
           LEFT JOIN integration.deal_commissions c ON c.agreement_id = a.id
          WHERE ($1::timestamptz IS NULL
                 OR (a.created_at, a.id) < ($1::timestamptz, $2::uuid))
          ORDER BY a.created_at DESC, a.id DESC
          LIMIT $3`,
        [query.cursor?.at ?? null, query.cursor?.id ?? null, query.limit],
      );
      const items = rows.map(mapDeal);
      const last = rows[rows.length - 1];
      const nextCursor =
        rows.length === query.limit && last
          ? encodeIntegrationCursor({ at: last.created_at.toISOString(), id: last.id })
          : null;
      return { items, nextCursor };
    });
  }

  /**
   * Обезличенная проекция для медиаконтура.
   *
   * Согласие проверяется на КАЖДЫЙ запрос, а не кешируется: отзыв обязан
   * убирать проекцию немедленно, а не к следующему обновлению кеша
   * (Architect_Launch §6.4, срок удаления ≤ 15 минут).
   */
  async publicProfile(ctx: IntegrationContext, projectId: string): Promise<PublicProfile> {
    return this.db.asServiceRole('app_integration', { traceId: ctx.traceId }, async (tx) => {
      const { rows: consent } = await tx.query<{ scope: string; granted_at: Date }>(
        `SELECT scope, granted_at FROM integration.active_publication_consent($1, $2)`,
        [projectId, 'top100_public'],
      );
      // Нет согласия — нет проекции. Ответ такой же, как для несуществующего
      // проекта: иначе по коду ответа читается, что проект есть, но «закрыт».
      if (!consent[0]) throw errors.notFound({ subject: 'public_profile' });

      const { rows } = await tx.query<{
        id: string;
        title: string;
        stage: string;
        taxonomy_id: string | null;
        season_number: number | null;
        irs: string | null;
      }>(
        `SELECT p.id, p.title, p.stage, p.taxonomy_id, s.number AS season_number,
                (SELECT sc.value FROM scoring.irs_scores sc
                  WHERE sc.project_id = p.id ORDER BY sc.computed_at DESC LIMIT 1) AS irs
           FROM lab.projects p
           LEFT JOIN seasons.seasons s ON s.id = p.season_id
          WHERE p.id = $1 AND p.deleted_at IS NULL`,
        [projectId],
      );
      const project = rows[0];
      if (!project) throw errors.notFound({ subject: 'public_profile' });

      return {
        projectId: project.id,
        title: project.title,
        stage: project.stage,
        taxonomyId: project.taxonomy_id,
        irs: project.irs === null ? null : Number(project.irs),
        seasonNumber: project.season_number,
        consentScope: consent[0].scope,
        consentGrantedAt: consent[0].granted_at.toISOString(),
      };
    });
  }

  async currentSeason(ctx: IntegrationContext): Promise<{
    id: string;
    number: number;
    status: string;
    startsAt: string;
    endsAt: string;
  } | null> {
    return this.db.asServiceRole('app_integration', { traceId: ctx.traceId }, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        number: number;
        status: string;
        starts_at: Date;
        ends_at: Date;
      }>(
        `SELECT id, number, status, starts_at, ends_at FROM seasons.seasons
          WHERE status <> 'closed'
          ORDER BY CASE status WHEN 'applications_open' THEN 0 ELSE 1 END, number DESC
          LIMIT 1`,
      );
      const season = rows[0];
      return season
        ? {
            id: season.id,
            number: season.number,
            status: season.status,
            startsAt: season.starts_at.toISOString(),
            endsAt: season.ends_at.toISOString(),
          }
        : null;
    });
  }

  /**
   * Регистрация внешнего листинга выпускника.
   *
   * Идемпотентна по паре (внешняя система, внешний идентификатор): повтор того
   * же вызова возвращает ту же ссылку, а не создаёт вторую. Ссылка на проект в
   * статусе, отличном от `graduated`, не создаётся — шов Capital открывается
   * выпуском, а не желанием внешней системы.
   */
  async createListingRef(
    ctx: IntegrationContext,
    input: { projectId: string; remoteSystem: string; remoteType: string; remoteId: string },
  ): Promise<ExternalRef> {
    return this.db.asServiceRole('app_integration', { traceId: ctx.traceId }, async (tx) => {
      await assertGraduated(tx, input.projectId);

      const { rows: existing } = await tx.query<RefRow>(
        `SELECT id, local_type, local_id, remote_system, remote_type, remote_id, created_at
           FROM integration.external_refs
          WHERE remote_system = $1 AND remote_type = $2 AND remote_id = $3`,
        [input.remoteSystem, input.remoteType, input.remoteId],
      );
      if (existing[0]) {
        if (existing[0].local_id !== input.projectId) {
          throw errors.conflict('Этот внешний идентификатор уже связан с другим проектом');
        }
        return mapRef(existing[0]);
      }

      const id = uuidv7();
      let created: RefRow;
      try {
        const { rows } = await tx.query<RefRow>(
          `INSERT INTO integration.external_refs
             (id, local_type, local_id, remote_system, remote_type, remote_id)
           VALUES ($1, 'project', $2, $3, $4, $5)
           RETURNING id, local_type, local_id, remote_system, remote_type, remote_id, created_at`,
          [id, input.projectId, input.remoteSystem, input.remoteType, input.remoteId],
        );
        created = rows[0]!;
      } catch (error) {
        if ((error as { code?: string }).code === '23505') {
          throw errors.conflict('Такая связь уже зарегистрирована');
        }
        throw error;
      }

      await this.audit.emit(tx, {
        verb: 'integration.listing.created',
        actorId: null,
        actorRole: 'system',
        subjectType: 'project',
        subjectId: input.projectId,
        context: {
          clientId: ctx.clientId,
          remoteSystem: input.remoteSystem,
          remoteId: input.remoteId,
        },
        traceId: ctx.traceId,
      });

      return mapRef(created);
    });
  }
}

// ----------------------------------------------------------------- частное

/** Порядок уровней раскрытия. Больше — больше данных наружу. */
const DISCLOSURE_RANK: Record<string, number> = { teaser: 0, full: 1, dataroom: 2 };

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
export function encodeIntegrationCursor(payload: { at: string; id: string }): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeIntegrationCursor(raw: string): { at: string; id: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw errors.validation([{ path: 'cursor', message: 'повреждённый курсор' }]);
  }
  const value = parsed as Partial<{ at: string; id: string }>;
  if (
    typeof value?.at !== 'string' ||
    typeof value?.id !== 'string' ||
    Number.isNaN(Date.parse(value.at)) ||
    !/^[0-9a-f-]{36}$/i.test(value.id)
  ) {
    throw errors.validation([{ path: 'cursor', message: 'повреждённый курсор' }]);
  }
  return { at: value.at, id: value.id };
}

/**
 * Проекции Integration API отдают только выпускников. Проект в любом другом
 * статусе для внешней системы не существует — включая тот, что был выпущен и
 * затем архивирован.
 */
async function assertGraduated(tx: Tx, projectId: string): Promise<void> {
  const { rows } = await tx.query<{ status: string }>(
    'SELECT status FROM lab.projects WHERE id = $1 AND deleted_at IS NULL',
    [projectId],
  );
  if (rows[0]?.status !== 'graduated') throw errors.notFound({ subject: 'project' });
}

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

interface GraduateRow {
  id: string;
  title: string;
  season_id: string | null;
  taxonomy_id: string | null;
  stage: string;
  investment_ask: string;
  graduated_at: Date | null;
  irs: string | null;
  external_ref: string | null;
}

function mapGraduate(row: GraduateRow): Graduate {
  return {
    projectId: row.id,
    title: row.title,
    seasonId: row.season_id,
    taxonomyId: row.taxonomy_id,
    stage: row.stage,
    // Деньги остаются строкой на всём пути: приведение к number теряет копейки.
    investmentAsk: row.investment_ask,
    currency: 'RUB',
    irs: row.irs === null ? null : Number(row.irs),
    graduatedAt: row.graduated_at ? row.graduated_at.toISOString() : null,
    externalRef: row.external_ref,
  };
}

interface DealRow {
  id: string;
  project_id: string;
  status: string;
  amount: string;
  instrument_type: string;
  signed_at: Date | null;
  effective_at: Date | null;
  created_at: Date;
  total_fee_amount: string | null;
  investor_fee_amount: string | null;
  issuer_fee_amount: string | null;
  accrued_at: Date | null;
}

function mapDeal(row: DealRow): IntegrationDeal {
  return {
    agreementId: row.id,
    projectId: row.project_id,
    status: row.status,
    amount: row.amount,
    currency: 'RUB',
    instrumentType: row.instrument_type,
    signedAt: row.signed_at ? row.signed_at.toISOString() : null,
    effectiveAt: row.effective_at ? row.effective_at.toISOString() : null,
    // Отсутствие начисления и нулевое начисление — разные факты, поэтому null,
    // а не '0.00': сделка без первого транша ещё не породила вознаграждения.
    commission:
      row.accrued_at === null
        ? null
        : {
            baseAmount: row.amount,
            investorFeeAmount: row.investor_fee_amount ?? '0.00',
            issuerFeeAmount: row.issuer_fee_amount ?? '0.00',
            totalFeeAmount: row.total_fee_amount ?? '0.00',
            accruedAt: row.accrued_at.toISOString(),
          },
  };
}

interface RefRow {
  id: string;
  local_type: string;
  local_id: string;
  remote_system: string;
  remote_type: string;
  remote_id: string;
  created_at: Date;
}

function mapRef(row: RefRow): ExternalRef {
  return {
    id: row.id,
    localType: row.local_type,
    localId: row.local_id,
    remoteSystem: row.remote_system,
    remoteType: row.remote_type,
    remoteId: row.remote_id,
    createdAt: row.created_at.toISOString(),
  };
}

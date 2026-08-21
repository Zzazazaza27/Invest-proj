import { Injectable } from '@nestjs/common';
import {
  EventVerb,
  PUBLICATION_DELETION_SLA_MINUTES,
  uuidv7,
  type PublicationConsent,
  type PublicationConsentRequest,
  type PublicationDisclosableField,
} from '@unicorn/contracts';
import { AuditRepository } from '../audit/audit.repository';
import { errors } from '../common/errors';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';

/**
 * Согласия на публичный контур — шов к медиаконтуру Шоу.
 *
 * Таблица, событие отзыва и срок удаления проекции существовали с M002/M010,
 * клиент звал `POST /v1/publication-consents` — а маршрута не было: вызов
 * отвечал 404 (LOW отчёта Ф48). Здесь он появляется.
 *
 * Три свойства, ради которых этот код не сводится к INSERT:
 *
 *  1. Документ не принимается от клиента. Версию сверяем с действующим
 *     шаблоном, отпечаток текста берём оттуда же. Тело запроса, в котором
 *     клиент присылает и версию, и хеш, доказывает только само себя — а
 *     согласие обязано доказывать, ЧТО именно человек принял.
 *  2. Согласие даёт участник проекта и только за себя. Это проверяет и
 *     политика БД (M059), и код: политика — граница, код — внятный ответ.
 *  3. Отзыв публикует событие с крайним сроком удаления проекции. Пятнадцать
 *     минут — не пожелание: потребитель обязан успеть, а нарушение срока
 *     является инцидентом.
 */
@Injectable()
export class PublicationConsentsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * Документ, которым оформляется согласие на публичный контур.
   *
   * Один на все четыре области. Съёмка отбора, буткемпа и финала раскрывает
   * изображение и голос — это биометрические ПДн; публичный топ-100
   * распространяет изображение и имя. Область различает поле `scope` самого
   * согласия, а не отдельный текст на каждую: четыре почти одинаковых
   * документа расходились бы по одному за раз.
   */
  static readonly DOCUMENT_KIND = 'pdn_biometric';

  async list(ctx: RequestContext, projectId?: string): Promise<PublicationConsent[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<ConsentRow>(
        `SELECT id, project_id, scope, disclosed_fields, document_version,
                document_sha256, accepted_at, revoked_at
           FROM identity.publication_consents
          WHERE user_id = $1
            AND ($2::uuid IS NULL OR project_id = $2::uuid)
          ORDER BY accepted_at DESC`,
        [ctx.userId, projectId ?? null],
      );
      return rows.map(mapConsent);
    });
  }

  async grant(ctx: RequestContext, input: PublicationConsentRequest): Promise<PublicationConsent> {
    return this.db.transaction(ctx, async (tx) => {
      // Членство проверяется явно и ДО вставки. Политика БД не пустит чужака и
      // без этой проверки, но ответом был бы отказ привилегий, то есть 500 на
      // ошибке клиента — ровно то, что чинили в Ф49.
      const { rows: member } = await tx.query(
        'SELECT 1 FROM lab.founders_projects WHERE project_id = $1 AND user_id = $2',
        [input.projectId, ctx.userId],
      );
      // Отсутствие проекта и отсутствие прав на него отвечают одинаково: иначе
      // ответ становится оракулом существования чужих проектов.
      if (member.length === 0)
        throw errors.notFound({ subject: 'project', reason: 'not-a-member' });

      const document = await this.resolveDocument(tx, ctx.userId!, input.documentVersion);

      const id = uuidv7();
      const { rows } = await tx.query<ConsentRow>(
        `INSERT INTO identity.publication_consents
           (id, user_id, project_id, scope, disclosed_fields, document_version, document_sha256)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         ON CONFLICT (user_id, project_id, scope) WHERE revoked_at IS NULL DO NOTHING
         RETURNING id, project_id, scope, disclosed_fields, document_version,
                   document_sha256, accepted_at, revoked_at`,
        [
          id,
          ctx.userId,
          input.projectId,
          input.scope,
          JSON.stringify(input.disclosedFields),
          document.version,
          document.sha256,
        ],
      );
      const created = rows[0];
      // Действующее согласие на ту же область уже есть. Это не ошибка сервера и
      // не повод молча переписать прежнее: у прежнего своя дата и своя версия
      // документа, и подмена стёрла бы доказательство того, что было принято.
      if (!created) {
        throw errors.conflict('Согласие на эту область уже выдано', {
          projectId: input.projectId,
          scope: input.scope,
        });
      }

      const consent = mapConsent(created);
      await this.audit.record(tx, {
        verb: EventVerb.CONSENT_PUBLICATION_GRANTED,
        actorId: ctx.userId,
        actorRole: 'founder',
        aggregateType: 'publication_consent',
        aggregateId: consent.id,
        // Номер версии фиксирован намеренно, вопреки общему правилу считать его
        // через nextAggregateVersion: у согласия ровно две точки жизни — выдача
        // и отзыв, — и обе однократны. Повторная выдача создаёт НОВУЮ строку с
        // новым id, то есть другой агрегат, а не вторую версию этого.
        aggregateVersion: 1,
        payload: {
          projectId: consent.projectId,
          userId: ctx.userId!,
          scope: consent.scope,
          disclosedFields: consent.disclosedFields,
          documentVersion: consent.documentVersion,
          grantedAt: consent.acceptedAt,
        },
        traceId: ctx.traceId,
      });
      return consent;
    });
  }

  /**
   * Отзыв согласия.
   *
   * Идемпотентен по смыслу: повторный отзыв уже отозванного согласия отвечает
   * тем же состоянием и НЕ публикует второе событие. Иначе каждый повтор
   * запускал бы у потребителя новый пятнадцатиминутный срок удаления того, что
   * он удалил в первый раз.
   */
  async revoke(ctx: RequestContext, id: string): Promise<PublicationConsent> {
    return this.db.transaction(ctx, async (tx) => {
      const { rows: updated } = await tx.query<ConsentRow>(
        `UPDATE identity.publication_consents
            SET revoked_at = now()
          WHERE id = $1 AND revoked_at IS NULL
        RETURNING id, project_id, scope, disclosed_fields, document_version,
                  document_sha256, accepted_at, revoked_at`,
        [id],
      );

      if (updated.length === 0) {
        // Строки нет, она чужая (политика скрыла) или уже отозвана — три
        // случая различаются одним чтением, и только третий не является отказом.
        const { rows: existing } = await tx.query<ConsentRow>(
          `SELECT id, project_id, scope, disclosed_fields, document_version,
                  document_sha256, accepted_at, revoked_at
             FROM identity.publication_consents WHERE id = $1`,
          [id],
        );
        const previous = existing[0];
        if (!previous) throw errors.notFound({ subject: 'publication_consent' });
        return mapConsent(previous);
      }

      const consent = mapConsent(updated[0]!);
      await this.audit.record(tx, {
        verb: EventVerb.CONSENT_PUBLICATION_REVOKED,
        actorId: ctx.userId,
        actorRole: 'founder',
        aggregateType: 'publication_consent',
        aggregateId: consent.id,
        aggregateVersion: 2,
        payload: {
          projectId: consent.projectId,
          userId: ctx.userId!,
          scope: consent.scope,
          revokedAt: consent.revokedAt!,
          deletionDeadline: consent.deletionDeadline!,
        },
        traceId: ctx.traceId,
      });
      return consent;
    });
  }

  /**
   * Действующий документ в локали пользователя.
   *
   * Локаль берётся из профиля, а не подставляется русской по умолчанию:
   * молчаливый переход на другой язык означал бы, что человек принял документ,
   * которого не читал. Нет действующей версии в его локали — это отказ с
   * названной причиной, а не подмена языка.
   */
  private async resolveDocument(
    tx: Tx,
    userId: string,
    requestedVersion: string,
  ): Promise<{ version: string; sha256: Buffer }> {
    const { rows: profile } = await tx.query<{ locale: string }>(
      'SELECT locale FROM identity.users WHERE id = $1',
      [userId],
    );
    const locale = profile[0]?.locale ?? 'ru-RU';

    const { rows } = await tx.query<{ version: string; body_sha256: Buffer }>(
      `SELECT version, body_sha256
         FROM identity.consent_templates
        WHERE kind = $1 AND locale = $2 AND superseded_at IS NULL`,
      [PublicationConsentsService.DOCUMENT_KIND, locale],
    );
    const active = rows[0];
    if (!active) {
      throw errors.conflict('Документ согласия на публичность не опубликован', {
        kind: PublicationConsentsService.DOCUMENT_KIND,
        locale,
      });
    }
    if (active.version !== requestedVersion) {
      // Названа ДЕЙСТВУЮЩАЯ версия: без неё клиенту нечего подставить, и он
      // снова придёт с той же неверной (урок Ф49 о недоступной версии акцепта).
      throw errors.validation([
        {
          path: 'documentVersion',
          message: `версия ${requestedVersion} не является действующей; действует ${active.version} (${locale})`,
        },
      ]);
    }
    return { version: active.version, sha256: active.body_sha256 };
  }
}

interface ConsentRow {
  id: string;
  project_id: string;
  scope: string;
  disclosed_fields: unknown;
  document_version: string;
  document_sha256: Buffer;
  accepted_at: Date;
  revoked_at: Date | null;
}

function mapConsent(row: ConsentRow): PublicationConsent {
  const revokedAt = row.revoked_at ? row.revoked_at.toISOString() : null;
  return {
    id: row.id,
    projectId: row.project_id,
    scope: row.scope as PublicationConsent['scope'],
    disclosedFields: (Array.isArray(row.disclosed_fields)
      ? row.disclosed_fields
      : []) as PublicationDisclosableField[],
    documentVersion: row.document_version,
    documentSha256: row.document_sha256.toString('hex'),
    acceptedAt: row.accepted_at.toISOString(),
    revokedAt,
    deletionDeadline: revokedAt ? deletionDeadline(row.revoked_at!) : null,
  };
}

/**
 * Крайний срок удаления публичной проекции.
 *
 * Считается ОТ МОМЕНТА ОТЗЫВА из базы, а не от часов приложения: срок обязан
 * быть одним и тем же в ответе API, в событии и в журнале, а часы процесса и
 * базы расходятся.
 */
export function deletionDeadline(revokedAt: Date): string {
  return new Date(revokedAt.getTime() + PUBLICATION_DELETION_SLA_MINUTES * 60_000).toISOString();
}

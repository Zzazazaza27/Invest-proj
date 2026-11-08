import { Injectable } from '@nestjs/common';
import {
  uuidv7,
  type LandingBlock,
  type LandingLocale,
  type PublishLandingBlock,
} from '@fifth/contracts';
import { AuditRepository } from '../audit/audit.repository';
import { errors } from '../common/errors';
import { Database, type RequestContext } from '../db/unit-of-work';

/**
 * Контент публичной витрины.
 *
 * Версионируется, а не правится на месте — тот же приём, что у тарифов.
 * Опубликованный текст витрины является утверждением оператора, и вопрос «что
 * именно там было написано в тот день» обязан иметь ответ. Правка на месте
 * стирает и ответ, и возможность его проверить.
 */
@Injectable()
export class ContentService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  /**
   * Действующие блоки витрины. Доступно без авторизации.
   *
   * Читается через `app_public_read`, а не через широкую роль приложения
   * (CODE-MED-05/SEC-MED-04): у анонимного маршрута должна быть и ВТОРАЯ
   * граница — DB-роль, которая видит только публичные таблицы. Ошибка в этом
   * запросе тогда упирается в GRANT, а не в весь пул backend-роли.
   */
  async landing(locale: LandingLocale): Promise<LandingBlock[]> {
    return this.db.asPublicRole('landing', async (tx) => {
      const { rows } = await tx.query<BlockRow>(
        `SELECT id, key, locale, title, body, link_url, valid_from, valid_to
           FROM content.landing_blocks
          WHERE locale = $1
            AND valid_from <= now()
            AND (valid_to IS NULL OR valid_to > now())
          ORDER BY key`,
        [locale],
      );
      return rows.map(mapBlock);
    });
  }

  /**
   * Опубликовать новую версию блока.
   *
   * Закрытие прежней версии и вставка новой — в ОДНОЙ транзакции, и порядок
   * важен: частичный уникальный индекс не допускает двух действующих версий
   * одного блока, поэтому вставка до закрытия упала бы конфликтом. Момент
   * берётся из БД (`now()`), а не из часов приложения: витрину читают по часам
   * той же базы, и расхождение в миллисекунды показывало бы либо две версии,
   * либо ни одной.
   */
  async publish(ctx: RequestContext, input: PublishLandingBlock): Promise<LandingBlock> {
    const id = uuidv7();
    return this.db.transaction(ctx, async (tx) => {
      // Блокировка блока ДО чтения действующей версии (2.6): одновременные публикации ждут
      // друг друга, повтор с тем же содержимым версии не создаёт.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `landing:${input.key}:${input.locale}`,
      ]);
      const { rows: active } = await tx.query<BlockRow>(
        `SELECT id, key, locale, title, body, link_url, valid_from, valid_to
           FROM content.landing_blocks
          WHERE key = $1 AND locale = $2 AND valid_to IS NULL`,
        [input.key, input.locale],
      );
      const current = active[0];
      if (
        current &&
        (current.title ?? null) === (input.title ?? null) &&
        current.body === input.body &&
        (current.link_url ?? null) === (input.linkUrl ?? null)
      ) {
        return mapBlock(current);
      }

      await tx.query(
        `UPDATE content.landing_blocks
            SET valid_to = now()
          WHERE key = $1 AND locale = $2 AND valid_to IS NULL`,
        [input.key, input.locale],
      );

      const { rows } = await tx.query<BlockRow>(
        `INSERT INTO content.landing_blocks
           (id, key, locale, title, body, link_url, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, key, locale, title, body, link_url, valid_from, valid_to`,
        [
          id,
          input.key,
          input.locale,
          input.title ?? null,
          input.body,
          input.linkUrl ?? null,
          ctx.userId,
        ],
      );

      await this.audit.emit(tx, {
        verb: 'content.landing_block.published',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'landing_block',
        subjectId: id,
        // Сам текст в журнал не кладётся: он и так хранится версией в таблице,
        // а дублирование раздувает журнал и усложняет его выгрузку.
        context: { key: input.key, locale: input.locale, reason: input.reason },
        traceId: ctx.traceId,
      });

      return mapBlock(rows[0]!);
    });
  }

  /** Снять блок с витрины без замены. */
  async withdraw(ctx: RequestContext, blockId: string, reason: string): Promise<void> {
    await this.db.transaction(ctx, async (tx) => {
      const { rowCount } = await tx.query(
        `UPDATE content.landing_blocks
            SET valid_to = now()
          WHERE id = $1 AND valid_to IS NULL`,
        [blockId],
      );
      // Ноль строк означает либо чужой идентификатор, либо уже снятый блок.
      // И то и другое — не изменение, и события об изменении быть не должно.
      if ((rowCount ?? 0) === 0) throw errors.notFound({ subject: 'landing_block' });

      await this.audit.emit(tx, {
        verb: 'content.landing_block.withdrawn',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'landing_block',
        subjectId: blockId,
        context: { reason },
        traceId: ctx.traceId,
      });
    });
  }

  /** История версий блока — для разбора «что было на витрине тогда». */
  async history(ctx: RequestContext, key: string, locale: string): Promise<LandingBlock[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<BlockRow>(
        `SELECT id, key, locale, title, body, link_url, valid_from, valid_to
           FROM content.landing_blocks
          WHERE key = $1 AND locale = $2
          ORDER BY valid_from DESC
          LIMIT 100`,
        [key, locale],
      );
      return rows.map(mapBlock);
    });
  }
}

interface BlockRow {
  id: string;
  key: LandingBlock['key'];
  locale: LandingLocale;
  title: string | null;
  body: string;
  link_url: string | null;
  valid_from: Date;
  valid_to: Date | null;
}

function mapBlock(row: BlockRow): LandingBlock {
  return {
    id: row.id,
    key: row.key,
    locale: row.locale,
    title: row.title,
    body: row.body,
    linkUrl: row.link_url,
    validFrom: row.valid_from.toISOString(),
    validTo: row.valid_to ? row.valid_to.toISOString() : null,
  };
}

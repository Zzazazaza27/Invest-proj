import { Injectable } from '@nestjs/common';
import {
  uuidv7,
  type NotificationTemplate,
  type UpsertNotificationTemplate,
} from '@fifth/contracts';
import { errors } from '../common/errors';
import { AuditRepository } from '../audit/audit.repository';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';

/**
 * Тексты уведомлений.
 *
 * Правки идут НОВОЙ версией строки, а не UPDATE по месту. Причина в природе
 * данных: уведомление уже ушло пользователю по прежнему тексту, и переписать
 * его задним числом — значит потерять то, что человек на самом деле получил.
 * Активной остаётся ровно одна версия на (code, channel, locale) — это держит
 * частичный уникальный индекс `notification_templates_one_active` (M008).
 *
 * Плейсхолдеры проверяются при записи: шаблон с `{{имя_получателя}}` протащил бы
 * ПДн в текст, который уходит внешнему провайдеру доставки.
 */
@Injectable()
export class TemplatesService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  async list(ctx: RequestContext, code?: string): Promise<NotificationTemplate[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<TemplateRow>(
        `SELECT id, code, channel, locale, version, title_template, body_template,
                fallback_chain, is_critical, is_active
           FROM comms.notification_templates
          WHERE ($1::text IS NULL OR code = $1)
          ORDER BY code, channel, locale, version DESC
          LIMIT 500`,
        [code ?? null],
      );
      return rows.map(mapTemplate);
    });
  }

  /**
   * Новая версия текста.
   *
   * Прежняя версия не удаляется и не правится: она деактивируется. История
   * текстов — часть журнала того, что платформа сообщала пользователям.
   */
  async upsert(
    ctx: RequestContext,
    input: UpsertNotificationTemplate,
  ): Promise<NotificationTemplate> {
    assertNoPersonalPlaceholders(input);

    return this.db.transaction(ctx, async (tx) => {
      // Лок на ключ шаблона: два одновременных сохранения иначе получат один и
      // тот же следующий номер версии и одно из них упадёт на уникальном индексе.
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `template:${input.code}:${input.channel}:${input.locale}`,
      ]);

      const { rows: prev } = await tx.query<{ max: number | null }>(
        `SELECT max(version) AS max FROM comms.notification_templates
          WHERE code = $1 AND channel = $2 AND locale = $3`,
        [input.code, input.channel, input.locale],
      );
      const version = (prev[0]?.max ?? 0) + 1;

      await tx.query(
        `UPDATE comms.notification_templates SET is_active = false
          WHERE code = $1 AND channel = $2 AND locale = $3 AND is_active`,
        [input.code, input.channel, input.locale],
      );

      const { rows } = await tx.query<TemplateRow>(
        `INSERT INTO comms.notification_templates
           (id, code, channel, locale, version, title_template, body_template,
            fallback_chain, is_critical, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, true)
         RETURNING id, code, channel, locale, version, title_template, body_template,
                   fallback_chain, is_critical, is_active`,
        [
          uuidv7(),
          input.code,
          input.channel,
          input.locale,
          version,
          input.titleTemplate ?? null,
          input.bodyTemplate,
          input.fallbackChain,
          input.isCritical,
        ],
      );

      await this.audit.emit(tx, {
        verb: 'comms.template.updated',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'notification_template',
        subjectId: rows[0]!.id,
        // В журнал идёт факт и адрес правки, но не сам текст: он и так лежит
        // в таблице версией, а дублирование раздувало бы журнал.
        context: { code: input.code, channel: input.channel, version },
        traceId: ctx.traceId,
      });

      return mapTemplate(rows[0]!);
    });
  }

  /**
   * Выключить активный шаблон.
   *
   * Критичные шаблоны выключать нельзя: без них уведомление о деньгах или
   * договоре просто не уйдёт, а отсутствие текста — это не «настройка».
   */
  async deactivate(ctx: RequestContext, id: string): Promise<NotificationTemplate> {
    return this.db.transaction(ctx, async (tx) => {
      const template = await loadTemplate(tx, id);
      if (template.is_critical) {
        throw errors.conflict('Критичный шаблон нельзя выключить: уведомление обязано уходить');
      }
      const { rows } = await tx.query<TemplateRow>(
        `UPDATE comms.notification_templates SET is_active = false
          WHERE id = $1
         RETURNING id, code, channel, locale, version, title_template, body_template,
                   fallback_chain, is_critical, is_active`,
        [id],
      );

      await this.audit.emit(tx, {
        verb: 'comms.template.updated',
        actorId: ctx.userId,
        actorRole: 'admin',
        subjectType: 'notification_template',
        subjectId: id,
        context: { code: template.code, channel: template.channel, deactivated: true },
        traceId: ctx.traceId,
      });

      return mapTemplate(rows[0]!);
    });
  }
}

/**
 * Плейсхолдеры-денилист.
 *
 * Текст уведомления уходит внешнему провайдеру доставки целиком. Всё, что
 * подставляется в него, тем самым покидает периметр, поэтому имена, контакты и
 * реквизиты в шаблоне запрещены — подставлять можно название проекта, сумму,
 * срок.
 */
const FORBIDDEN_PLACEHOLDERS = [
  'email',
  'phone',
  'passport',
  'inn',
  'snils',
  'full_name',
  'first_name',
  'last_name',
  'address',
  'card',
  'account_number',
];

export function assertNoPersonalPlaceholders(input: {
  titleTemplate?: string | null;
  bodyTemplate: string;
}): void {
  const text = `${input.titleTemplate ?? ''} ${input.bodyTemplate}`.toLowerCase();
  const found = [...text.matchAll(/\{\{\s*([a-z0-9_]+)\s*\}\}/g)].map((match) => match[1]!);
  const violation = found.find((name) =>
    FORBIDDEN_PLACEHOLDERS.some((forbidden) => name === forbidden || name.includes(forbidden)),
  );
  if (violation) {
    throw errors.validation([
      {
        path: 'bodyTemplate',
        message: `плейсхолдер {{${violation}}} подставляет персональные данные в текст, уходящий провайдеру`,
      },
    ]);
  }
}

async function loadTemplate(
  tx: Tx,
  id: string,
): Promise<{ code: string; channel: string; is_critical: boolean }> {
  const { rows } = await tx.query<{ code: string; channel: string; is_critical: boolean }>(
    'SELECT code, channel, is_critical FROM comms.notification_templates WHERE id = $1',
    [id],
  );
  const template = rows[0];
  if (!template) throw errors.notFound({ subject: 'notification_template' });
  return template;
}

interface TemplateRow {
  id: string;
  code: string;
  channel: NotificationTemplate['channel'];
  locale: string;
  version: number;
  title_template: string | null;
  body_template: string;
  fallback_chain: string[];
  is_critical: boolean;
  is_active: boolean;
}

function mapTemplate(row: TemplateRow): NotificationTemplate {
  return {
    id: row.id,
    code: row.code,
    channel: row.channel,
    locale: row.locale,
    version: row.version,
    titleTemplate: row.title_template,
    bodyTemplate: row.body_template,
    fallbackChain: row.fallback_chain,
    isCritical: row.is_critical,
    isActive: row.is_active,
  };
}

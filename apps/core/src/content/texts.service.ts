import { Injectable } from '@nestjs/common';
import {
  TEXT_FIELDS,
  uuidv7,
  type Language,
  type TextEntry,
  type TextNamespace,
  type TextsResponse,
  type TextVersion,
  type UpsertTextEntry,
} from '@unicorn/contracts';
import { AuditRepository } from '../audit/audit.repository';
import { errors } from '../common/errors';
import { Database, type RequestContext, type Tx } from '../db/unit-of-work';

const DEFAULT_LOCALE = 'ru-RU';

/**
 * Продуктовые тексты: словарь терминов и ЧАВО (M079, план 0.2 §2.6).
 *
 * Правка — новая версия с основанием, прежняя закрывается той же
 * транзакцией; одна действующая версия на (запись, язык, поле) держится
 * индексом БД. Публичная выдача читается ролью `app_public_read` с fallback
 * на `ru-RU` и честным списком `missing`: пустой строки в БД не бывает,
 * отсутствие перевода — отсутствие строки.
 */
@Injectable()
export class TextsService {
  constructor(
    private readonly db: Database,
    private readonly audit: AuditRepository,
  ) {}

  async languages(traceId: string): Promise<Language[]> {
    return this.db.asPublicRole(traceId, async (tx) => {
      const { rows } = await tx.query<LanguageRow>(
        `SELECT code, name, is_active, sort_order FROM content.languages ORDER BY sort_order, code`,
      );
      return rows.map((r) => ({
        code: r.code,
        name: r.name,
        isActive: r.is_active,
        sortOrder: r.sort_order,
      }));
    });
  }

  /** Действующие тексты активных записей на языке; без перевода — `ru-RU`. */
  async texts(traceId: string, namespace: TextNamespace, locale: string): Promise<TextsResponse> {
    return this.db.asPublicRole(traceId, async (tx) => {
      const { rows } = await tx.query<CurrentRow>(
        `SELECT e.key, e.sort_order, v.locale, v.field, v.body
           FROM content.text_entries e
           JOIN content.text_versions v ON v.entry_id = e.id AND v.valid_to IS NULL
          WHERE e.namespace = $1 AND e.is_active
            AND v.locale IN ($2, $3)
          ORDER BY e.sort_order, e.key`,
        [namespace, locale, DEFAULT_LOCALE],
      );
      return assemble(namespace, locale, rows);
    });
  }

  // ---------------------------------------------------------------- админка

  async list(ctx: RequestContext, namespace: TextNamespace): Promise<TextEntry[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows: entries } = await tx.query<EntryRow>(
        `SELECT id, namespace, key, sort_order, is_active, updated_at
           FROM content.text_entries WHERE namespace = $1 ORDER BY sort_order, key`,
        [namespace],
      );
      const { rows: versions } = await tx.query<CurrentRow & { entry_id: string }>(
        `SELECT v.entry_id, e.key, e.sort_order, v.locale, v.field, v.body
           FROM content.text_versions v
           JOIN content.text_entries e ON e.id = v.entry_id
          WHERE e.namespace = $1 AND v.valid_to IS NULL`,
        [namespace],
      );
      const byEntry = new Map<string, TextEntry['texts']>();
      for (const v of versions) {
        const texts = byEntry.get(v.entry_id) ?? {};
        texts[v.locale] = { ...(texts[v.locale] ?? {}), [v.field]: v.body };
        byEntry.set(v.entry_id, texts);
      }
      return entries.map((e) => mapEntry(e, byEntry.get(e.id) ?? {}));
    });
  }

  /**
   * Создать или обновить запись. Тексты сравниваются с действующими: только
   * изменившиеся получают новую версию, пустая строка закрывает действующую.
   * Одно основание на всё сохранение — так его вводит владелец.
   */
  async upsert(
    ctx: RequestContext,
    namespace: TextNamespace,
    key: string,
    input: UpsertTextEntry,
  ): Promise<TextEntry> {
    const allowed = new Set(TEXT_FIELDS[namespace]);
    for (const fields of Object.values(input.texts ?? {})) {
      for (const field of Object.keys(fields)) {
        if (!allowed.has(field)) {
          throw errors.validation([
            { path: `texts.${field}`, message: `поле не входит в «${namespace}»` },
          ]);
        }
      }
    }
    return this.db.transaction(ctx, async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        `content-text:${namespace}:${key}`,
      ]);
      let { rows: found } = await tx.query<EntryRow>(
        `SELECT id, namespace, key, sort_order, is_active, updated_at
           FROM content.text_entries WHERE namespace = $1 AND key = $2`,
        [namespace, key],
      );
      let entry = found[0];
      if (!entry) {
        ({ rows: found } = await tx.query<EntryRow>(
          `INSERT INTO content.text_entries (id, namespace, key, sort_order, is_active, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING id, namespace, key, sort_order, is_active, updated_at`,
          [uuidv7(), namespace, key, input.sortOrder ?? 0, input.isActive ?? true, ctx.userId],
        ));
        entry = found[0]!;
      } else if (input.sortOrder !== undefined || input.isActive !== undefined) {
        ({ rows: found } = await tx.query<EntryRow>(
          `UPDATE content.text_entries
              SET sort_order = COALESCE($2, sort_order), is_active = COALESCE($3, is_active)
            WHERE id = $1
            RETURNING id, namespace, key, sort_order, is_active, updated_at`,
          [entry.id, input.sortOrder ?? null, input.isActive ?? null],
        ));
        entry = found[0]!;
        await this.audit.emit(tx, {
          verb: 'content.text_entry.updated',
          actorId: ctx.userId,
          actorRole: 'admin',
          subjectType: 'text_entry',
          subjectId: entry.id,
          context: {
            namespace,
            key,
            sortOrder: entry.sort_order,
            isActive: entry.is_active,
            reason: input.reason,
          },
          traceId: ctx.traceId,
        });
      }

      const { rows: current } = await tx.query<{ locale: string; field: string; body: string }>(
        `SELECT locale, field, body FROM content.text_versions
          WHERE entry_id = $1 AND valid_to IS NULL`,
        [entry.id],
      );
      const currentMap = new Map(current.map((c) => [`${c.locale}|${c.field}`, c.body]));

      for (const [locale, fields] of Object.entries(input.texts ?? {})) {
        for (const [field, rawBody] of Object.entries(fields)) {
          const body = rawBody.trim();
          const existing = currentMap.get(`${locale}|${field}`);
          if (existing === body || (existing === undefined && body === '')) continue;
          await tx.query(
            `UPDATE content.text_versions SET valid_to = now()
              WHERE entry_id = $1 AND locale = $2 AND field = $3 AND valid_to IS NULL`,
            [entry.id, locale, field],
          );
          if (body === '') {
            await this.audit.emit(tx, {
              verb: 'content.text.withdrawn',
              actorId: ctx.userId,
              actorRole: 'admin',
              subjectType: 'text_entry',
              subjectId: entry.id,
              context: { namespace, key, locale, field, reason: input.reason },
              traceId: ctx.traceId,
            });
            continue;
          }
          const { rows: numbered } = await tx.query<{ version: number }>(
            `INSERT INTO content.text_versions
               (id, entry_id, locale, field, body, version, created_by, reason)
             VALUES ($1, $2, $3, $4, $5,
                     (SELECT COALESCE(MAX(version), 0) + 1 FROM content.text_versions
                       WHERE entry_id = $2 AND locale = $3 AND field = $4),
                     $6, $7)
             RETURNING version`,
            [uuidv7(), entry.id, locale, field, body, ctx.userId, input.reason],
          );
          await this.audit.emit(tx, {
            verb: 'content.text.published',
            actorId: ctx.userId,
            actorRole: 'admin',
            subjectType: 'text_entry',
            subjectId: entry.id,
            context: {
              namespace,
              key,
              locale,
              field,
              version: numbered[0]?.version,
              reason: input.reason,
            },
            traceId: ctx.traceId,
          });
        }
      }

      const { rows: after } = await tx.query<CurrentRow & { entry_id: string }>(
        `SELECT entry_id, $2::text AS key, 0 AS sort_order, locale, field, body
           FROM content.text_versions WHERE entry_id = $1 AND valid_to IS NULL`,
        [entry.id, key],
      );
      const texts: TextEntry['texts'] = {};
      for (const v of after) texts[v.locale] = { ...(texts[v.locale] ?? {}), [v.field]: v.body };
      return mapEntry(entry, texts);
    });
  }

  async history(
    ctx: RequestContext,
    namespace: TextNamespace,
    key: string,
  ): Promise<TextVersion[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<VersionRow>(
        `SELECT v.id, v.locale, v.field, v.body, v.version, v.valid_from, v.valid_to, v.reason
           FROM content.text_versions v
           JOIN content.text_entries e ON e.id = v.entry_id
          WHERE e.namespace = $1 AND e.key = $2
          ORDER BY v.valid_from DESC, v.locale, v.field
          LIMIT 200`,
        [namespace, key],
      );
      return rows.map((r) => ({
        id: r.id,
        locale: r.locale,
        field: r.field,
        body: r.body,
        version: r.version,
        validFrom: r.valid_from.toISOString(),
        validTo: r.valid_to ? r.valid_to.toISOString() : null,
        reason: r.reason,
      }));
    });
  }
}

/** Собрать выдачу на языке: своя версия, иначе `ru-RU` и путь в `missing`. */
function assemble(namespace: TextNamespace, locale: string, rows: CurrentRow[]): TextsResponse {
  const entries = new Map<
    string,
    { sortOrder: number; own: Record<string, string>; base: Record<string, string> }
  >();
  for (const row of rows) {
    const entry = entries.get(row.key) ?? { sortOrder: row.sort_order, own: {}, base: {} };
    if (row.locale === locale) entry.own[row.field] = row.body;
    if (row.locale === DEFAULT_LOCALE) entry.base[row.field] = row.body;
    entries.set(row.key, entry);
  }
  const missing: string[] = [];
  const result: TextsResponse['entries'] = [];
  for (const [key, entry] of entries) {
    const texts: Record<string, string> = {};
    for (const field of TEXT_FIELDS[namespace]) {
      const own = entry.own[field];
      if (own !== undefined) {
        texts[field] = own;
      } else if (entry.base[field] !== undefined) {
        texts[field] = entry.base[field]!;
        missing.push(`${key}.${field}`);
      }
    }
    if (Object.keys(texts).length > 0) result.push({ key, sortOrder: entry.sortOrder, texts });
  }
  return { namespace, locale, entries: result, missing };
}

interface LanguageRow {
  code: string;
  name: string;
  is_active: boolean;
  sort_order: number;
}
interface EntryRow {
  id: string;
  namespace: TextNamespace;
  key: string;
  sort_order: number;
  is_active: boolean;
  updated_at: Date;
}
interface CurrentRow {
  key: string;
  sort_order: number;
  locale: string;
  field: string;
  body: string;
}
interface VersionRow {
  id: string;
  locale: string;
  field: string;
  body: string;
  version: number;
  valid_from: Date;
  valid_to: Date | null;
  reason: string;
}

function mapEntry(row: EntryRow, texts: TextEntry['texts']): TextEntry {
  return {
    id: row.id,
    namespace: row.namespace,
    key: row.key,
    sortOrder: row.sort_order,
    isActive: row.is_active,
    texts,
    updatedAt: row.updated_at.toISOString(),
  };
}

export type { Tx };

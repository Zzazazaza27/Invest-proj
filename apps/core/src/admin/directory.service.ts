import { Injectable } from '@nestjs/common';
import type { AdminProjectSummary, AdminUserSummary } from '@unicorn/contracts';
import { Database, type RequestContext } from '../db/unit-of-work';

/**
 * Справочник для административных экранов: найти человека и найти проект.
 *
 * Выдача ролей и перевод по воронке работают по идентификатору — это правильно,
 * идентификатор однозначен. Но набирать его руками неоткуда: оператор знает имя
 * или название, а не UUID.
 *
 * Ограничения намеренные:
 *
 *  * Поиск только по видимому тексту (имя, название). Почта зашифрована,
 *    подбирать по ней означало бы расшифровывать таблицу целиком.
 *  * Пустой запрос возвращает последние записи, а не всю базу: экран поиска
 *    обязан открываться с чем-то осмысленным, но выгрузка всех пользователей
 *    одной кнопкой — это не поиск, а экспорт.
 *  * Предел выдачи жёсткий. Список на сотни строк оператор всё равно не
 *    прочитает, а запрос подорожает на порядок.
 */
@Injectable()
export class DirectoryService {
  constructor(private readonly db: Database) {}

  async findUsers(ctx: RequestContext, query: string): Promise<AdminUserSummary[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        display_name: string;
        status: string;
        created_at: Date;
        roles: string[] | null;
      }>(
        `SELECT u.id, u.display_name, u.status, u.created_at,
                array_remove(array_agg(r.role ORDER BY r.role), NULL) AS roles
           FROM identity.users u
           LEFT JOIN identity.user_roles r ON r.user_id = u.id AND r.revoked_at IS NULL
          WHERE u.deleted_at IS NULL
            AND ($1 = '' OR u.display_name ILIKE '%' || $1 || '%')
          GROUP BY u.id, u.display_name, u.status, u.created_at
          ORDER BY u.created_at DESC
          LIMIT 25`,
        [query],
      );
      return rows.map((row) => ({
        id: row.id,
        displayName: row.display_name,
        roles: row.roles ?? [],
        status: row.status,
        createdAt: row.created_at.toISOString(),
      }));
    });
  }

  async findProjects(ctx: RequestContext, query: string): Promise<AdminProjectSummary[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        title: string;
        status: string;
        listing_status: string;
        season_id: string | null;
      }>(
        `SELECT id, title, status, listing_status, season_id
           FROM lab.projects
          WHERE deleted_at IS NULL
            AND ($1 = '' OR title ILIKE '%' || $1 || '%')
          ORDER BY updated_at DESC
          LIMIT 25`,
        [query],
      );
      return rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        listingStatus: row.listing_status,
        seasonId: row.season_id,
      }));
    });
  }
}

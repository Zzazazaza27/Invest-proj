import { Injectable } from '@nestjs/common';
import type { AdminProjectSummary } from '@fifth/contracts';
import { Database, type RequestContext } from '../db/unit-of-work';

/**
 * Справочник для административных экранов: найти проект.
 *
 * Перевод по воронке работает по идентификатору — это правильно, он
 * однозначен. Но набирать его руками неоткуда: оператор знает название.
 *
 * Ограничения намеренные:
 *
 *  * Пустой запрос возвращает последние записи, а не всю базу: экран поиска
 *    обязан открываться с чем-то осмысленным, но выгрузка всего одной кнопкой
 *    — это не поиск, а экспорт.
 *  * Предел выдачи жёсткий. Список на сотни строк оператор всё равно не
 *    прочитает, а запрос подорожает на порядок.
 *
 * Поиск людей живёт отдельно — `AdminUsersService` (этап 6).
 */
@Injectable()
export class DirectoryService {
  constructor(private readonly db: Database) {}

  async findProjects(ctx: RequestContext, query: string): Promise<AdminProjectSummary[]> {
    return this.db.readOnly(ctx, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        title: string;
        status: string;
        listing_status: string;
      }>(
        `SELECT id, title, status, listing_status
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
      }));
    });
  }
}

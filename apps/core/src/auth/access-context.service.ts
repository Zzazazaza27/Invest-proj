import { Injectable, Logger } from '@nestjs/common';
import { getEnv } from '../config/env';
import { errors } from '../common/errors';
import { Database } from '../db/unit-of-work';

/**
 * Контекст доступа: разрешение серверу выполнить запрос от лица другого.
 *
 * ЧТО ЭТО НЕ ТАКОЕ. Это не вход под чужой учётной записью и не выпуск токена
 * участнику. Платформа проверяет токен ИНИЦИАТОРА обычным порядком — а затем,
 * увидев заголовок контекста, подставляет действующего пользователя. Поэтому
 * схема работает и с внешним поставщиком входа: чужие токены мы не выпускаем.
 *
 * ПОЧЕМУ ВСЯ ПРОВЕРКА В ОДНОМ МЕСТЕ. Подстановка личности — самая опасная
 * операция в системе. Условия её действительности разбросать по вызывающим
 * нельзя: пропущенное условие в одном месте открывает чужой кабинет.
 *
 * Условия (владелец, 2026-09-21):
 *  1. Контекст привязан к конкретной административной сессии инициатора.
 *     Другая сессия того же администратора его не открывает; выход,
 *     блокировка, отзыв сессии или полномочия — прекращают доступ.
 *  2. Недействительный, просроченный или чужой контекст — ОТКАЗ. Возврата к
 *     административной личности «по умолчанию» нет: иначе запрос, который
 *     должен был выполниться от лица участника, тихо выполнится с правами
 *     администратора.
 *  3. Права инициатора и действующего участника не объединяются. Роли берутся
 *     ТОЛЬКО у того, от чьего лица идёт запрос.
 */

export type ContextKind = 'participant' | 'readonly' | 'guest';

export interface ResolvedContext {
  id: string;
  kind: ContextKind;
  /** От чьего лица выполняется запрос. У гостя — никого. */
  subjectUserId: string | null;
  subjectRoles: string[];
  sessionId: string | null;
  initiatorUserId: string;
}

interface ContextRow {
  id: string;
  kind: ContextKind;
  subject_user_id: string | null;
  session_id: string | null;
  initiator_user_id: string;
  expired: boolean;
  revoked: boolean;
  subject_status: string | null;
  subject_deleted: boolean | null;
  subject_roles: string[] | null;
  initiator_capable: boolean;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Какое полномочие нужно для контекста каждого вида.
 *
 * Значения повторены в SQL-запросе ниже (CASE по `kind`) намеренно: проверка
 * выполняется одним запросом вместе с чтением строки, чтобы между «узнали
 * вид» и «проверили право» не было зазора. Эта запись — то, что читает
 * человек; расхождение между ней и запросом ловится проверкой
 * `check-testing-sessions.mjs`.
 */
export const CAPABILITY_BY_KIND: Record<ContextKind, string> = {
  participant: 'testing.sessions.manage',
  guest: 'testing.sessions.manage',
  readonly: 'identity.user.view_as',
};

@Injectable()
export class AccessContextService {
  private readonly logger = new Logger(AccessContextService.name);

  constructor(private readonly db: Database) {}

  /**
   * Включён ли механизм в этом контуре.
   *
   * В production выключен всегда и не настройкой, а кодом: цена ошибки здесь
   * — чтение чужого кабинета. Снятие запрета — отдельное решение владельца,
   * а не значение переменной окружения, забытой в боевом конфиге.
   */
  isEnabled(): boolean {
    const env = getEnv();
    return env.NODE_ENV !== 'production' && env.TESTING_SESSIONS_ENABLED;
  }

  /**
   * Проверить контекст и вернуть, от чьего лица выполнять запрос.
   *
   * Любое несоответствие — исключение. Молчаливого «продолжим как
   * администратор» не бывает.
   */
  async resolve(
    contextId: string,
    initiator: { userId: string; roles: readonly string[]; tokenId: string | null },
    traceId: string,
  ): Promise<ResolvedContext> {
    if (!this.isEnabled()) {
      throw errors.forbidden({ stage: 'context-disabled' });
    }
    if (!UUID_PATTERN.test(contextId)) {
      throw errors.forbidden({ stage: 'context-malformed' });
    }
    // Контекст привязан к сессии. Токен без `jti` (такой приходит от внешнего
    // поставщика без этого claim) привязать не к чему — значит открывать
    // контекст под ним нельзя вовсе.
    if (!initiator.tokenId) {
      throw errors.forbidden({ stage: 'context-token-unbound' });
    }

    // Контекст РЛС — это сам инициатор с его настоящими ролями: строку
    // контекста показывает политика `contexts_own`, а `app.has_capability`
    // спрашивает про текущего пользователя сессии БД. Подставить сюда
    // «admin» значило бы проверять права выдуманного человека.
    const dbCtx = { userId: initiator.userId, roles: initiator.roles, traceId };
    const row = await this.db.readOnly<ContextRow | null>(dbCtx, async (tx) => {
      const { rows } = await tx.query<ContextRow>(
        `SELECT c.id,
                c.kind,
                c.subject_user_id,
                c.session_id,
                c.initiator_user_id,
                (c.expires_at <= now())    AS expired,
                (c.revoked_at IS NOT NULL) AS revoked,
                u.status                   AS subject_status,
                (u.deleted_at IS NOT NULL) AS subject_deleted,
                (SELECT array_agg(r.role) FROM identity.user_roles r
                  WHERE r.user_id = c.subject_user_id) AS subject_roles,
                app.has_capability(
                  CASE c.kind WHEN 'readonly' THEN 'identity.user.view_as'
                              ELSE 'testing.sessions.manage' END) AS initiator_capable
           FROM testing.access_contexts c
           LEFT JOIN identity.users u ON u.id = c.subject_user_id
          WHERE c.id = $1
            AND c.initiator_user_id = $2
            AND c.initiator_token_id = $3::uuid`,
        [contextId, initiator.userId, initiator.tokenId],
      );
      return rows[0] ?? null;
    });

    // Чужой контекст, контекст другой сессии того же администратора и
    // несуществующий контекст неразличимы снаружи намеренно: подбор по
    // ответу не должен говорить, какой из них попался.
    if (!row) throw errors.forbidden({ stage: 'context-unknown' });
    if (row.revoked) throw errors.forbidden({ stage: 'context-revoked' });
    if (row.expired) throw errors.forbidden({ stage: 'context-expired' });

    if (!row.initiator_capable) {
      // Полномочие сняли, пока контекст был открыт: доступ прекращается
      // немедленно, а не до истечения срока. Какое именно полномочие нужно,
      // решает вид контекста — см. CAPABILITY_BY_KIND и выражение в запросе.
      throw errors.forbidden({ stage: 'context-capability-revoked' });
    }

    if (row.kind === 'guest') {
      return {
        id: row.id,
        kind: 'guest',
        subjectUserId: null,
        subjectRoles: [],
        sessionId: row.session_id,
        initiatorUserId: row.initiator_user_id,
      };
    }

    if (!row.subject_user_id || row.subject_deleted) {
      throw errors.forbidden({ stage: 'context-subject-gone' });
    }
    if (row.subject_status !== 'active') {
      // Заблокированный или не принявший акцепты пользователь не становится
      // доступным через просмотр: ограничения его учётной записи действуют.
      throw errors.forbidden({ stage: 'context-subject-inactive' });
    }

    return {
      id: row.id,
      kind: row.kind,
      subjectUserId: row.subject_user_id,
      // Роли берутся у участника и ТОЛЬКО у него: объединение с ролями
      // администратора дало бы «эксперта с правами админа» — то есть
      // проверку, которая ничего не проверяет.
      subjectRoles: row.subject_roles ?? [],
      sessionId: row.session_id,
      initiatorUserId: row.initiator_user_id,
    };
  }

  /** Отметить использование: по нему видно, живой контекст или брошенный. */
  async touch(
    contextId: string,
    initiator: { userId: string; roles: readonly string[] },
    traceId: string,
  ): Promise<void> {
    try {
      await this.db.transaction(
        { userId: initiator.userId, roles: initiator.roles, traceId },
        (tx) =>
          tx.query('UPDATE testing.access_contexts SET last_used_at = now() WHERE id = $1', [
            contextId,
          ]),
      );
    } catch (error) {
      // Отметка — удобство разбора, а не часть проверки доступа. Её сбой не
      // должен ронять запрос, который сам по себе разрешён.
      this.logger.warn({
        msg: 'отметка использования контекста не записана',
        contextId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

import { z } from 'zod';

/**
 * Аудитории раскрытия и одно правило видимости (этап 5.6.4, решение владельца
 * 2026-09-18). Модуль без зависимостей от доменных схем: его импортируют и
 * проект, и раунд, и представления заявки.
 *
 * Уровни те же, что у видимости вопроса формы (`FormVisibilitySchema`):
 * поле видно аудитории, если его видимость не строже уровня аудитории. Одно
 * правило для ответов анкеты, системных полей раунда, каталога и
 * предпросмотра; в SQL — `lab.visible_to` (M085), паритет проверяет
 * `database/tests/round-visibility.test.ts`.
 */
export const AudienceSchema = z.enum(['public', 'investors', 'platform', 'private']);
export type Audience = z.infer<typeof AudienceSchema>;

const AUDIENCE_RANK: Record<Audience, number> = {
  public: 0,
  investors: 1,
  platform: 2,
  private: 3,
};

export function visibleTo(visibility: Audience, audience: Audience): boolean {
  return AUDIENCE_RANK[visibility] <= AUDIENCE_RANK[audience];
}

/** Строже из двух видимостей; неизвестное — private (зеркало `lab.stricter_visibility`, M086). */
export function stricterVisibility(a: Audience, b: Audience): Audience {
  return AUDIENCE_RANK[a] >= AUDIENCE_RANK[b] ? a : b;
}

/**
 * Режим видимости проекта — решение владельца, кому в принципе виден проект
 * (этап 5.7, план `заявка-04` §3.1; колонка `lab.projects.visibility`, M087).
 * `selected_investors` в интерфейсе 5.7 не предлагается (grant — 5.8).
 */
export const ProjectVisibilitySchema = z.enum([
  'private',
  'public',
  'registered_investors',
  'selected_investors',
]);
export type ProjectVisibility = z.infer<typeof ProjectVisibilitySchema>;

/**
 * Разрешение на конкретный объект проекта. `teaser` есть у всякого, кому проект
 * виден вообще; остальные — независимые части Investor View. Grant выбранного
 * получателя — НАБОР этих разрешений (без `teaser`, он подразумевается), не
 * уровень: `{materials}` даёт материалы и тизер, но не ответы анкеты.
 */
export const AccessPermissionSchema = z.enum(['teaser', 'profile', 'materials', 'extended']);
export type AccessPermission = z.infer<typeof AccessPermissionSchema>;
export const GrantPermissionSchema = z.enum(['profile', 'materials', 'extended']);
export type GrantPermission = z.infer<typeof GrantPermissionSchema>;

/** Кто смотрит — то, что предикат узнаёт из сессии и таблиц. */
export interface ProjectViewer {
  /** Пользователь сессии; аноним — null. */
  userId: string | null;
  /** Роли сессии (`app.current_roles`). */
  roles: readonly string[];
  /** Член команды проекта (`lab.is_project_member`). */
  member?: boolean;
  /** Действующее исключение для пользователя или его организации. */
  excluded?: boolean;
  /**
   * Действующие разрешения grant. Организационная выдача отложена (M092):
   * пока `access.entity_grants.enabled` выключен, разрешения организации в
   * этот набор не входят — БД их не учитывает и не даёт создавать.
   */
  grant?: readonly GrantPermission[];
  /** Действующая проверка личности (для `extended`). */
  kyc?: boolean;
}

export interface ProjectAccessState {
  visibility: ProjectVisibility;
  deleted?: boolean;
  blocked?: boolean;
}

/**
 * Зеркало `lab.project_audience(project, user, permission)` (M087): с какой
 * аудиторией зритель видит объект проекта, или `null` — доступа нет.
 * Порядок проверок тот же, что в SQL (план `заявка-04` §3.3); паритет
 * проверяет `database/tests/project-access.test.ts`. Разрешение любого вида
 * не поднимает аудиторию выше `investors`: поля `platform` и `private`
 * наружу не попадают.
 */
export function projectAudience(
  project: ProjectAccessState,
  viewer: ProjectViewer,
  permission: AccessPermission,
): Audience | null {
  const has = (role: string): boolean => viewer.roles.includes(role);
  if (viewer.userId !== null && (viewer.member || has('admin'))) return 'private';
  if (project.deleted) return null;
  if (project.blocked) return null;
  if (viewer.userId !== null && viewer.excluded) return null;
  if (project.visibility === 'private') return null;

  // Допуска инвестора по роли нет: он держался на подписке, а подписки
  // удалены в 2.1-W05. Открытые режимы дают внешнему зрителю только то, что
  // видно всем; «зарегистрированным инвесторам» сейчас не открыто ничего.
  if (project.visibility === 'public') {
    return permission === 'teaser' || permission === 'profile' ? 'public' : null;
  }
  if (project.visibility === 'registered_investors') return null;
  // selected_investors: набор разрешений grant; допуск личный.
  if (viewer.userId === null || !viewer.grant || viewer.grant.length === 0) return null;
  if (permission === 'teaser') return 'investors';
  if (permission === 'extended') {
    return viewer.grant.includes('extended') && viewer.kyc ? 'investors' : null;
  }
  return viewer.grant.includes(permission) ? 'investors' : null;
}

/**
 * Кому какой кабинет положен и куда девать человека, попавшего не туда.
 *
 * История. Форму входа однажды уже вынесли в отдельное приложение (`apps/auth`,
 * Ф49) — но убрали её только из админки и консоли. В кабинетах основателя,
 * инвестора и эксперта собственная форма осталась, и вместе с ней осталось
 * поведение: человек выходит, кабинет показывает СВОЙ вход, принимает любые
 * учётные данные и остаётся на месте. Инвестор, вышедший из кабинета
 * основателя, снова оказывался в кабинете основателя — с формой создания
 * проекта, которой сервер ему всё равно не даст воспользоваться.
 *
 * Данные при этом не утекали: guard ядра проверяет роль на каждом маршруте
 * (`@Roles('founder', 'admin')` и далее). Ломался не доступ, а ориентация —
 * интерфейс обещал то, чего не мог выполнить.
 *
 * Здесь только решение «пускать или отправить дальше». Переход выполняет
 * приложение: пакет намеренно не знает ни про сеть, ни про `window`.
 */

export type CabinetKey = 'lab' | 'investor' | 'expert' | 'admin';

/** Путь кабинета под единой точкой входа. */
export const CABINET_PATH: Record<CabinetKey, string> = {
  lab: '/lab/',
  investor: '/investor/',
  expert: '/expert/',
  admin: '/admin/',
};

/** Путь единого экрана входа. */
export const LOGIN_PATH = '/login/';

/**
 * Роль → кабинет. Организатор и комплаенс работают в административном:
 * отдельных приложений у них нет, а объём прав внутри решает сервер.
 *
 * Зеркало `apps/auth/src/routing.ts`: там тот же список нужен до входа, когда
 * пакеты кабинета ещё не загружены.
 */
export const ROLE_TO_CABINET: Record<string, CabinetKey> = {
  founder: 'lab',
  investor: 'investor',
  expert: 'expert',
  admin: 'admin',
  organizer: 'admin',
  compliance: 'admin',
};

/**
 * Кабинеты, доступные набору ролей. Порядок устойчив — от роли участника к
 * служебным, чтобы у человека с несколькими ролями выбор не «прыгал».
 */
export function cabinetsForRoles(roles: readonly string[]): CabinetKey[] {
  const order: CabinetKey[] = ['lab', 'investor', 'expert', 'admin'];
  const available = new Set<CabinetKey>();
  for (const role of roles) {
    const key = ROLE_TO_CABINET[role];
    if (key) available.add(key);
  }
  return order.filter((key) => available.has(key));
}

export type AccessDecision =
  /** Роль на месте — показываем кабинет. */
  | { kind: 'allowed' }
  /** Человек вошёл, но этот кабинет не его: отправляем в положенный. */
  | { kind: 'elsewhere'; to: CabinetKey }
  /**
   * Вошёл, но ни один кабинет не подходит (роли сняты администратором либо
   * их не выдали). Отправлять некуда — только на вход, где видно, кто он.
   */
  | { kind: 'homeless' }
  /** Сессии нет — на единый вход. */
  | { kind: 'anonymous' };

/**
 * Решение о доступе к конкретному кабинету.
 *
 * `roles === null` означает «сессии нет» и отличается от пустого списка ролей:
 * в первом случае человеку надо войти, во втором — вход не поможет.
 */
export function decideAccess(
  roles: readonly string[] | null,
  required: CabinetKey,
): AccessDecision {
  if (roles === null) return { kind: 'anonymous' };
  const available = cabinetsForRoles(roles);
  if (available.includes(required)) return { kind: 'allowed' };
  const first = available[0];
  return first === undefined ? { kind: 'homeless' } : { kind: 'elsewhere', to: first };
}

/**
 * Адрес перехода.
 *
 * За единой точкой входа порта в адресе страницы нет — тогда переход идёт по
 * пути. При прямом запуске dev-сервером порт есть, и путь `/investor/` вёл бы
 * на несуществующий маршрут ТОГО ЖЕ сервера: каждое приложение поднимается
 * отдельно. Поэтому адрес собирается из порта нужного приложения, а карту
 * портов передаёт приложение — пакету неоткуда её знать.
 */
export function hrefFor(
  target: CabinetKey | 'login',
  ports?: Partial<Record<CabinetKey | 'login', number>>,
): string {
  const path = target === 'login' ? LOGIN_PATH : CABINET_PATH[target];
  if (typeof window === 'undefined') return path;
  const { protocol, hostname, port } = window.location;
  if (port === '') return path;
  const targetPort = ports?.[target];
  // Порт неизвестен — путь остаётся единственным разумным ответом: лучше
  // видимый 404, чем молчаливый переход в никуда.
  if (targetPort === undefined) return path;
  return `${protocol}//${hostname}:${targetPort}${path}`;
}

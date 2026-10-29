/**
 * Куда отправить человека после входа.
 *
 * Роль определяет сервер, а не форма: клиент лишь читает `/v1/auth/me` и
 * выбирает адрес. Обратный порядок — «пользователь выбрал кабинет, значит он
 * там свой» — означал бы, что доступ решается на стороне браузера.
 */

declare const __CABINET_PORTS__: Record<CabinetKey, number>;

export type CabinetKey = 'lab' | 'investor' | 'admin';

export interface Cabinet {
  key: CabinetKey;
  /** Путь под единой точкой входа. */
  path: string;
  title: string;
  description: string;
}

export const CABINETS: Record<CabinetKey, Cabinet> = {
  lab: {
    key: 'lab',
    path: '/lab',
    title: 'Кабинет основателя',
    description: 'Проекты, их видимость и материалы',
  },
  investor: {
    key: 'investor',
    path: '/investor',
    title: 'Кабинет инвестора',
    description: 'В разработке',
  },
  admin: {
    key: 'admin',
    path: '/admin',
    title: 'Административный кабинет',
    description: 'Пользователи, комплаенс, тексты, настройки платформы',
  },
};

/**
 * Роль → кабинет.
 *
 * Комплаенс работает в административном кабинете: отдельного приложения у
 * него нет, а объём прав внутри решает сервер. Роли эксперта и организатора
 * удалены в 2.1-W05.
 */
const ROLE_TO_CABINET: Record<string, CabinetKey> = {
  founder: 'lab',
  investor: 'investor',
  admin: 'admin',
  compliance: 'admin',
};

/**
 * Кабинеты, доступные набору ролей. Порядок устойчив — от роли участника к
 * служебным, чтобы у человека с несколькими ролями список не «прыгал».
 */
export function cabinetsForRoles(roles: string[]): Cabinet[] {
  const order: CabinetKey[] = ['lab', 'investor', 'admin'];
  const available = new Set<CabinetKey>();
  for (const role of roles) {
    const key = ROLE_TO_CABINET[role];
    if (key) available.add(key);
  }
  return order.filter((key) => available.has(key)).map((key) => CABINETS[key]);
}

/**
 * Полный адрес кабинета.
 *
 * За обратным прокси порта в адресе страницы нет — тогда кабинет открывается
 * по пути, и человек не видит ни одного номера. При прямом запуске dev-сервером
 * порт есть, и адрес собирается из порта соответствующего приложения: иначе
 * переход вёл бы на несуществующий путь того же dev-сервера.
 */
export function cabinetUrl(cabinet: Cabinet): string {
  const { protocol, hostname, port } = window.location;
  /*
   * Порт страницы НЕ ЯВЛЯЕТСЯ признаком единой точки входа.
   *
   * Признак — пустая карта портов: её подставляет сборка, когда адрес API
   * относительный, то есть страница и API живут на одном origin. У
   * временного контура проверок вход стоит на 8081, и прежнее условие
   * уводило человека на dev-адрес localhost:5175, которого там нет.
   *
   * Пустой порт по-прежнему означает единый вход — это частный случай.
   */
  const devPort = __CABINET_PORTS__[cabinet.key];
  if (port === '' || devPort === undefined) return cabinet.path;
  return `${protocol}//${hostname}:${devPort}/`;
}

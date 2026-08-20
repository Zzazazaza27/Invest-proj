/**
 * Куда отправить человека после входа.
 *
 * Роль определяет сервер, а не форма: клиент лишь читает `/v1/auth/me` и
 * выбирает адрес. Обратный порядок — «пользователь выбрал кабинет, значит он
 * там свой» — означал бы, что доступ решается на стороне браузера.
 */

declare const __CABINET_PORTS__: Record<CabinetKey, number>;

export type CabinetKey = 'lab' | 'investor' | 'expert' | 'admin';

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
    description: 'Заявка, материалы, инвестиционный паспорт проекта',
  },
  investor: {
    key: 'investor',
    path: '/investor',
    title: 'Кабинет инвестора',
    description: 'Каталог проектов, верификация, подписка, предложения',
  },
  expert: {
    key: 'expert',
    path: '/expert',
    title: 'Кабинет эксперта',
    description: 'Назначения на рецензию и оценка проектов',
  },
  admin: {
    key: 'admin',
    path: '/admin',
    title: 'Административный кабинет',
    description: 'Тарифы, подписки, комплаенс, воронка сезона',
  },
};

/**
 * Роль → кабинет.
 *
 * Организатор и комплаенс работают в административном кабинете: отдельных
 * приложений у них нет, а объём прав внутри решает сервер — организатору
 * воронка доступна на чтение, и кабинет говорит об этом прямо.
 */
const ROLE_TO_CABINET: Record<string, CabinetKey> = {
  founder: 'lab',
  investor: 'investor',
  expert: 'expert',
  admin: 'admin',
  organizer: 'admin',
  compliance: 'admin',
};

/**
 * Кабинеты, доступные набору ролей. Порядок устойчив — от роли участника к
 * служебным, чтобы у человека с несколькими ролями список не «прыгал».
 */
export function cabinetsForRoles(roles: string[]): Cabinet[] {
  const order: CabinetKey[] = ['lab', 'investor', 'expert', 'admin'];
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
  if (port === '') return cabinet.path;
  return `${protocol}//${hostname}:${__CABINET_PORTS__[cabinet.key]}/`;
}

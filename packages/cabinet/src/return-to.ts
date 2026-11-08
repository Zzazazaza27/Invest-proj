import { hrefFor } from './access';

/**
 * Возврат на страницу после повторного входа (блок 2, 2.2/2.3).
 *
 * Перед уходом на вход вкладка запоминает внутренний путь, владельца и время. После входа
 * приложение входа возвращает на путь, только если: вошёл тот же пользователь, путь —
 * кабинет, доступный его ролям, без чужой схемы, `//` и `\`, метке не больше 30 минут.
 * Иначе — кабинет по умолчанию; метка снимается в любом случае.
 *
 * Метка — удобство, а не основание доступа: права на странице проверяет сервер. Изменение
 * после входа не повторяется: незавершённая операция только выясняется по ключу (2.6).
 *
 * Работает под единой точкой входа (один origin). На dev-портах кабинеты — разные origin и
 * хранилища вкладки, там возврата нет.
 */
const RETURN = 'fifth.return';
const WHO = 'fifth.who';
const MAX_AGE_MS = 30 * 60_000;

interface ReturnMark {
  path: string;
  owner: string | null;
  at: number;
}

/** Кто работает во вкладке — чтобы метка возврата знала владельца и после перезагрузки. */
export function rememberUser(id: string | null): void {
  try {
    if (id) window.sessionStorage.setItem(WHO, id);
  } catch {
    // без хранилища вкладки возврата не будет — вход всё равно работает
  }
}

/** Уйти на вход, запомнив, куда вернуться. */
export function goToLogin(ports?: Parameters<typeof hrefFor>[1]): void {
  try {
    const mark: ReturnMark = {
      path: `${window.location.pathname}${window.location.search}`,
      owner: window.sessionStorage.getItem(WHO),
      at: Date.now(),
    };
    window.sessionStorage.setItem(RETURN, JSON.stringify(mark));
  } catch {
    // нет хранилища — без возврата
  }
  window.location.replace(hrefFor('login', ports));
}

/** Проверка пути возврата: только внутренний путь одного из разрешённых кабинетов. */
export function safeReturnPath(path: unknown, allowed: readonly string[]): string | null {
  if (typeof path !== 'string' || path.length > 2_000) return null;
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  // Управляющие символы в пути — отказ.
  // eslint-disable-next-line no-control-regex
  if (path.includes('\\') || /[\0-\x1f]/.test(path) || /^\/[^/]*:/.test(path)) return null;
  let parsed: URL;
  try {
    parsed = new URL(path, 'https://internal.invalid');
  } catch {
    return null;
  }
  if (parsed.origin !== 'https://internal.invalid') return null;
  const normalized = `${parsed.pathname}${parsed.search}`;
  const ok = allowed.some((prefix) => {
    const base = prefix.replace(/\/$/, '');
    return parsed.pathname === base || parsed.pathname.startsWith(`${base}/`);
  });
  return ok ? normalized : null;
}

/**
 * Прочитать и снять метку. `null` — возвращаться некуда: другой пользователь, чужой или
 * недоступный ролям путь, просроченная метка, не единая точка входа.
 */
export function takeReturn(
  userId: string,
  allowed: readonly string[],
  now = Date.now(),
): string | null {
  let mark: ReturnMark | null;
  try {
    const raw = window.sessionStorage.getItem(RETURN);
    window.sessionStorage.removeItem(RETURN);
    mark = raw ? (JSON.parse(raw) as ReturnMark) : null;
  } catch {
    return null;
  }
  if (!mark || window.location.port !== '') return null;
  if (mark.owner !== userId) return null;
  if (typeof mark.at !== 'number' || now - mark.at > MAX_AGE_MS || mark.at > now) return null;
  return safeReturnPath(mark.path, allowed);
}

/**
 * Учёт того, что создаёт браузерный прогон.
 *
 * ЗАЧЕМ. Проверки регистрировали себе учётные записи обычной регистрацией —
 * без единого признака, что это след прогона. За неделю список пользователей
 * переставал рассказывать о платформе и начинал рассказывать о наших
 * проверках; фильтр «без записей проверок» их не прятал, уборка не находила,
 * а однажды длинные имена вроде «Сотрудник conflict 73671257» уронили
 * проверку плотности таблицы.
 *
 * ТРИ РАЗНЫЕ ВЕЩИ, и ни одна не заменяет другую:
 *
 *   1. ПРОИСХОЖДЕНИЕ — «это завёл прогон, а не человек»;
 *   2. ПРИНАДЛЕЖНОСТЬ — «завёл вот ЭТОТ запуск вот ЭТОЙ проверки»;
 *   3. ОЧИСТКА — успешный прогон убирает за собой, упавший оставляет данные
 *      для разбора, и по ним видно, чей это запуск.
 *
 * Всё три даёт тестовая сессия. Прогон открывает её на время работы и шлёт
 * её идентификатор заголовком `X-Unicorn-Run`; сервер проверяет, что такой
 * запуск действительно идёт, назначает происхождение и записывает созданное
 * за сессией — В ТОЙ ЖЕ транзакции, что и сам человек. Между «создал» и
 * «записал за собой» окна нет: упасть в нём невозможно.
 *
 * ПОЧЕМУ БЕЗ УЧАСТНИКОВ. Сессия умеет заводить троих — основателя, эксперта
 * и инвестора. Браузерным проходам они не нужны: у них свои действующие лица
 * и свой администратор. Нужен только учёт, поэтому сессия открывается
 * пустой (`withStandardCast: false`) — иначе каждый прогон плодил бы ещё
 * троих людей ради одной строки в журнале.
 *
 * УБОРКА ПОМЕЧАЕТ, А НЕ УДАЛЯЕТ ЛЮДЕЙ. На `identity.users` ссылаются 46
 * внешних ключей, ни один не объявляет ON DELETE, а акцепты согласий
 * неизменяемы (M002): физически удалить человека схема не даёт. То же
 * решение принято в `clean-probe-data`.
 */
import { CORE_URL } from './ports.mjs';

/** Единственное значение для браузерных проходов: его знает уборка (M127). */
export const PROBE_ORIGIN = 'render_check';

const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';

/** Минимальный клиент: нужен только чтобы открыть сессию и закрыть её. */
function adminClient() {
  const state = { session: null, csrf: null };
  return async function call(path, { method = 'GET', body } = {}) {
    const headers = { Cookie: [state.session, state.csrf].filter(Boolean).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) {
      headers['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    }
    const response = await fetch(`${CORE_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* пустой ответ — не JSON, и это нормально */
    }
    return { status: response.status, json, text };
  };
}

/**
 * Открыть запуск для проверки.
 *
 * @param {string} probeId идентификатор проверки в реестре, например RND-LAB
 * @returns учёт запуска либо «пустышка», если сессии недоступны
 */
export async function startProbeRun(probeId) {
  const password = process.env.DEMO_USER_PASSWORD ?? process.env.DEV_TEST_USER_PASSWORD ?? '';
  const call = adminClient();

  /*
   * Прогон не обязан падать из-за учёта.
   *
   * Если сессии выключены или администратора нет, проверка всё равно должна
   * проверять продукт: происхождение в этом случае не назначится, и запись
   * останется обычной — хуже, чем с учётом, но лучше, чем непройденная
   * проверка. Про такой исход прогон говорит вслух, а не молчит.
   */
  const fallback = {
    id: null,
    headers: () => ({}),
    async finish() {},
  };
  if (!password) {
    console.warn('  (учёт запуска выключен: нет пароля демонстрационного комплекта)');
    return fallback;
  }

  const login = await call('/v1/auth/login', {
    method: 'POST',
    body: { email: 'demo-admin@unicorn.local', password },
  });
  if (login.status !== 200 && login.status !== 201) {
    console.warn(`  (учёт запуска выключен: вход администратора дал ${login.status})`);
    return fallback;
  }

  const created = await call('/v1/admin/testing/sessions', {
    method: 'POST',
    body: {
      title: `Прогон ${probeId}`,
      source: 'automated',
      scenarioId: probeId,
      // Участники не нужны: у прогона свои действующие лица, нужен только учёт.
      withStandardCast: false,
    },
  });
  if (created.status !== 200 && created.status !== 201) {
    console.warn(`  (учёт запуска выключен: сессия не создана, ${created.status})`);
    return fallback;
  }

  const runId = created.json.id;
  return {
    id: runId,

    /** Заголовки регистрации: происхождение и доказательство права на него. */
    headers() {
      return { 'X-Unicorn-Origin': PROBE_ORIGIN, 'X-Unicorn-Run': runId };
    },

    /**
     * Подвести итог.
     *
     * Успешный прогон убирает за собой. Данные упавшего — единственное
     * свидетельство, поэтому они остаются, и прогон печатает, где их искать.
     */
    async finish(ok) {
      await call(`/v1/admin/testing/sessions/${runId}/finish`, {
        method: 'POST',
        body: { result: ok ? 'passed' : 'failed' },
      });
      if (!ok) {
        console.warn(`\n  данные оставлены для разбора: /admin/testing → запуск ${runId}`);
        return;
      }
      const done = await call(`/v1/admin/testing/sessions/${runId}/cleanup`, { method: 'POST' });
      const result = done.json ?? {};
      console.warn(
        `\n  прогон убрал за собой: помечено ${result.marked ?? 0}, удалено ${result.deleted ?? 0}`,
      );
    },
  };
}

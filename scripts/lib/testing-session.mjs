/**
 * Общий механизм обстановки для прогонов: тестовая сессия вместо
 * самодельных учётных записей.
 *
 * ЗАЧЕМ. Полсотни проверок заводили себе людей сами: каждая своим способом,
 * со своими адресами и паролями. Следствия видели все: список пользователей
 * зарастал, упавший прогон оставлял безымянный мусор, а разобрать его можно
 * было только чтением чужого скрипта.
 *
 * ЧТО ДАЁТ ЭТОТ МОДУЛЬ:
 *  * участники заводятся сервером и помечены происхождением `test_session`;
 *  * ПАРОЛЕЙ У НИХ НЕТ — запросы идут контекстом доступа, а не входом;
 *  * шаги и итог прогона видно в админке, упавший прогон сохраняется;
 *  * уборка идёт по перечню созданного, а не по догадке.
 *
 * ЧЕГО ОН НЕ ДЕЛАЕТ. Он не заменяет проверок самой авторизации: вход,
 * регистрация, восстановление пароля обязаны проверяться настоящим входом.
 * Переключение участника без пароля обычный вход не проверяет.
 *
 * Использование:
 *
 *   const run = await startSession('smoke-favorites', { scenarioId: 'favorites' });
 *   const investor = run.as('investor');
 *   const { status, json } = await investor.call('/v1/projects');
 *   await run.step('листинг открывается', status === 200, { expected: '200', actual: status });
 *   await run.finish();          // успех, если ни один шаг не упал
 *   await run.cleanup();         // по желанию: успешные прогоны можно убирать
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL } from './ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
loadDotEnv();

const BASE = process.env.CORE_URL ?? DEFAULT_CORE_URL;
const SESSION_COOKIE = process.env.SESSION_COOKIE_NAME ?? 'ul_session';
const CSRF_COOKIE = process.env.CSRF_COOKIE_NAME ?? 'ul_csrf';

function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

/**
 * Клиент администратора: единственный, кто здесь по-настоящему входит.
 *
 * Все остальные «входы» — это контексты его же сессии. Поэтому и выход
 * администратора обрывает прогон: так и задумано, контекст живёт не дольше
 * той сессии, из которой открыт.
 */
function makeClient() {
  const state = { session: null, csrf: null };
  async function call(path, { method = 'GET', body, context = null, headers = {} } = {}) {
    const all = { Cookie: [state.session, state.csrf].filter(Boolean).join('; '), ...headers };
    if (body !== undefined) all['Content-Type'] = 'application/json';
    if (method !== 'GET' && state.csrf) {
      all['X-CSRF-Token'] = state.csrf.split('=').slice(1).join('=');
    }
    if (context) all['X-Unicorn-Context'] = context;
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: all,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* пустой ответ — не JSON, и это нормально */
    }
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const pair = cookie.split(';')[0];
      if (cookie.startsWith(`${SESSION_COOKIE}=`)) state.session = pair;
      if (cookie.startsWith(`${CSRF_COOKIE}=`)) state.csrf = pair;
    }
    return { status: response.status, json, text };
  }
  return { call };
}

/**
 * Начать сессию и подготовить участников.
 *
 * Возвращает объект прогона: `as(role)` даёт клиента, который ходит от лица
 * участника, `step()` записывает шаг, `finish()` подводит итог.
 */
export async function startSession(title, options = {}) {
  const admin = makeClient();
  const email = options.adminEmail ?? 'demo-admin@unicorn.local';
  const password =
    options.adminPassword ??
    process.env.DEMO_USER_PASSWORD ??
    process.env.DEV_TEST_USER_PASSWORD ??
    '';
  if (!password) {
    throw new Error('нет пароля демонстрационного комплекта: комплект не загружен');
  }

  const login = await admin.call('/v1/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  if (login.status !== 200 && login.status !== 201) {
    throw new Error(`вход администратора не удался: HTTP ${login.status}`);
  }

  const created = await admin.call('/v1/admin/testing/sessions', {
    method: 'POST',
    body: {
      title,
      source: 'automated',
      scenarioId: options.scenarioId ?? null,
      codeVersion: options.codeVersion ?? null,
    },
  });
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(`сессия не создана: HTTP ${created.status} ${created.text.slice(0, 200)}`);
  }
  const sessionId = created.json.id;

  const card = await admin.call(`/v1/admin/testing/sessions/${sessionId}`);
  const participants = card.json?.participants ?? [];

  /** Контексты открываются по требованию: лишние — это лишние разрешения. */
  const contexts = new Map();
  async function contextFor(role) {
    if (contexts.has(role)) return contexts.get(role);
    const person = participants.find((p) => p.role === role);
    if (!person) throw new Error(`в сессии нет участника с ролью ${role}`);
    const opened = await admin.call(`/v1/admin/testing/sessions/${sessionId}/contexts`, {
      method: 'POST',
      body: { kind: 'participant', userId: person.userId },
    });
    if (opened.status !== 200) {
      throw new Error(`контекст для ${role} не открыт: HTTP ${opened.status}`);
    }
    contexts.set(role, opened.json.contextId);
    return opened.json.contextId;
  }

  let ordinal = 0;
  let failed = 0;

  return {
    id: sessionId,
    admin,
    participants,

    /** Клиент, который ходит от лица участника указанной роли. */
    as(role) {
      return {
        call: async (path, init = {}) => {
          const context = await contextFor(role);
          return admin.call(path, { ...init, context });
        },
      };
    },

    /** Гостевой контекст: запросы обрабатываются как неавторизованные. */
    async asGuest() {
      const opened = await admin.call(`/v1/admin/testing/sessions/${sessionId}/contexts`, {
        method: 'POST',
        body: { kind: 'guest' },
      });
      if (opened.status !== 200) throw new Error(`гостевой контекст не открыт: ${opened.status}`);
      const context = opened.json.contextId;
      return { call: (path, init = {}) => admin.call(path, { ...init, context }) };
    },

    /** Записать шаг прогона. Упавший шаг делает итог прогона падением. */
    async step(name, ok, detail = {}) {
      ordinal += 1;
      if (!ok) failed += 1;
      await admin.call(`/v1/admin/testing/sessions/${sessionId}/steps`, {
        method: 'POST',
        body: {
          ordinal,
          name,
          status: ok ? 'passed' : 'failed',
          actor: detail.actor ?? null,
          expected:
            detail.expected === undefined || detail.expected === null
              ? null
              : String(detail.expected),
          actual:
            detail.actual === undefined || detail.actual === null ? null : String(detail.actual),
        },
      });
      return ok;
    },

    /** Подвести итог. Упавший прогон остаётся для разбора в админке. */
    async finish() {
      const result = failed === 0 ? 'passed' : 'failed';
      await admin.call(`/v1/admin/testing/sessions/${sessionId}/finish`, {
        method: 'POST',
        body: { result },
      });
      return { result, failedSteps: failed, adminUrl: `/admin/testing` };
    },

    /**
     * Убрать данные прогона.
     *
     * Вызывается ЯВНО и обычно только для успешных прогонов: у упавшего
     * данные — это и есть материал разбора. Владелец назвал это правилом.
     */
    async cleanup() {
      const done = await admin.call(`/v1/admin/testing/sessions/${sessionId}/cleanup`, {
        method: 'POST',
      });
      return done.json ?? null;
    },
  };
}

import { useSyncExternalStore } from 'react';
import { Alert } from '@fifth/ui';

/**
 * Общий отказ сервиса в открытом кабинете (блок 2, 2.3).
 *
 * Подозрение — от клиента API: сеть или 502/503/504 после повторов (`onTransportFailure`).
 * Тело ответа подозрение не подтверждает и не снимает: корректный problem+json от прокси —
 * тоже возможный общий отказ, а 503 ядра — может быть отказом одной функции. Поэтому
 * отказ подтверждается отдельно — проверкой готовности API (`GET <api>/ready`): свежей
 * (`no-store`), с пределом времени и проверкой тела (`service`, `ready: true`).
 *
 *   * не готов — одно общее «Сервис временно недоступен» и проверка раз в 15 с;
 *   * готов после показанного отказа — «Работа восстановлена» один раз.
 *
 * Восстановление снимает только общее предупреждение: ограничения групп «Файлы»/«Почта» и
 * неизвестность отдельной операции (2.6) остаются со своими правилами.
 */
const POLL_MS = 15_000;
const RESTORED_SHOW_MS = 8_000;
const CHECK_TIMEOUT_MS = 5_000;

type ServiceState = 'ok' | 'down' | 'restored';
let state: ServiceState = 'ok';
let base = '/v1';
let checking = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let version = 0;
const listeners = new Set<() => void>();
const set = (next: ServiceState) => {
  state = next;
  version += 1;
  listeners.forEach((fn) => fn());
};

/** Адрес API кабинета (как у клиента API). */
export function configureServiceCheck(apiBase: string): void {
  base = apiBase.replace(/\/+$/, '');
}

/** Свежая проверка готовности API: только успешный ответ с верным телом. */
export async function apiReady(fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${base}/ready`, {
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { service?: unknown; ready?: unknown };
    return body.service === 'fifth-core' && body.ready === true;
  } catch {
    return false;
  }
}

async function check(): Promise<void> {
  if (checking) return;
  checking = true;
  try {
    const ready = await apiReady();
    if (!ready) {
      if (state !== 'down') set('down');
      schedule();
      return;
    }
    if (state === 'down') {
      set('restored');
      setTimeout(() => {
        if (state === 'restored') set('ok');
      }, RESTORED_SHOW_MS);
    }
  } finally {
    checking = false;
  }
}

/**
 * Пауза до следующей проверки при общем отказе: 15 с ±20 %. Отказ ядра все открытые вкладки
 * замечают одновременно; без разброса они проверяли бы готовность в одни и те же моменты и
 * после восстановления разом перезагружали данные — одна волна запросов от всех вкладок.
 */
export function recheckDelayMs(
  random: number = crypto.getRandomValues(new Uint32Array(1))[0]! / 2 ** 32,
): number {
  return Math.round(POLL_MS * (0.8 + 0.4 * Math.min(Math.max(random, 0), 1)));
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void check();
  }, recheckDelayMs());
}

/** От клиента API: возможный общий отказ — проверить готовность. */
export function noteTransportFailure(): void {
  if (state === 'down') return; // уже проверяется по расписанию
  void check();
}

/** Для проверок без браузера. */
export function resetServiceState(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  checking = false;
  set('ok');
}

export function serviceState(): ServiceState {
  return state;
}

export function useServiceState(): ServiceState {
  useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
  );
  return state;
}

/** Одно общее сообщение на страницу — в шапке кабинета. */
export function ServiceNotice(): React.ReactElement | null {
  const current = useServiceState();
  if (current === 'down') {
    return (
      <Alert tone="warning" data-service-notice="down">
        Сервис временно недоступен. Введённое на странице не потеряно; когда работа восстановится,
        здесь появится сообщение.
      </Alert>
    );
  }
  if (current === 'restored') {
    return (
      <Alert tone="success" data-service-notice="restored">
        Работа восстановлена.
      </Alert>
    );
  }
  return null;
}

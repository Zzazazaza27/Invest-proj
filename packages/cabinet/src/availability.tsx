import { useEffect, useState } from 'react';
import { Alert } from '@fifth/ui';
import type { Features, GroupReason, GroupStatus } from '@fifth/contracts';

/**
 * Доступность группы «Файлы» в кабинете (блок 4, 4.11).
 *
 * Одно состояние на страницу: опрос `/v1/features` раз в минуту и сразу после ответа
 * `group_unavailable`. Опрос только читает состояние — ничего не повторяет и не отправляет.
 * Ограничиваются действия с хранилищем, а не экран: карточки, списки и профиль открываются по
 * своим условиям. Восстановление сообщается один раз — только если перед этим показывалось
 * предупреждение.
 */
type Loader = () => Promise<Features>;

const POLL_MS = 60_000;
const RESTORED_SHOW_MS = 8_000;
let status: GroupStatus | null = null;
let restored = false;
let warned = false;
let loader: Loader | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

async function refresh(): Promise<void> {
  if (!loader) return;
  try {
    const next = (await loader()).groups.files;
    const healthy = next.read.allowed && next.write.allowed;
    if (!healthy) {
      warned = true;
      restored = false;
    } else if (warned) {
      warned = false;
      restored = true;
      setTimeout(() => {
        restored = false;
        notify();
      }, RESTORED_SHOW_MS);
    }
    status = next;
    notify();
  } catch {
    // Не узнали — показываем прежнее; само действие проверит сервер.
  }
}

/**
 * Ответ `group_unavailable` от действия с файлами: сразу освежить состояние, чтобы причина
 * совпала с ответом ядра.
 */
export function noteGroupError(error: unknown): void {
  if ((error as { code?: string } | null)?.code === 'group_unavailable') void refresh();
}

export function useFilesAvailability(load: Loader | undefined): {
  status: GroupStatus | null;
  canWrite: boolean;
  canRead: boolean;
  restored: boolean;
} {
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!load) return undefined;
    loader = load;
    const fn = () => rerender((n) => n + 1);
    listeners.add(fn);
    if (status === null) void refresh();
    timer ??= setInterval(() => void refresh(), POLL_MS);
    return () => {
      listeners.delete(fn);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, [load]);
  return {
    status,
    // Пока состояние не пришло, кнопки не блокируются: решит сервер.
    canWrite: status?.write.allowed ?? true,
    canRead: status?.read.allowed ?? true,
    restored,
  };
}

const WRITE_TEXT: Record<GroupReason, string> = {
  ok: '',
  dependency_failure:
    'Загрузка и изменение файлов временно недоступны: хранилище не отвечает. Уже загруженное по-прежнему можно открыть.',
  circuit_open:
    'Загрузка и изменение файлов временно приостановлены из-за сбоев хранилища. Уже загруженное по-прежнему можно открыть.',
  observations_stale: 'Не удаётся проверить хранилище файлов — загрузка временно приостановлена.',
  manual_restriction: 'Работа с файлами временно ограничена: загрузка и изменение недоступны.',
  not_configured: 'Хранилище файлов не подключено: загрузка недоступна.',
};
const READ_TEXT = 'Файлы сейчас недоступны: открыть и загрузить их нельзя.';

/** Одна причина на группу — показывать один раз на странице, рядом с действиями файлов. */
export function FilesNotice({
  availability,
}: {
  availability: ReturnType<typeof useFilesAvailability>;
}): React.ReactElement | null {
  const { status, restored } = availability;
  if (restored) {
    return (
      <Alert tone="success" data-group-notice="files" data-group-state="restored">
        Работа с файлами восстановлена.
      </Alert>
    );
  }
  if (!status || (status.read.allowed && status.write.allowed)) return null;
  const text = status.read.allowed ? WRITE_TEXT[status.write.reason] : READ_TEXT;
  return (
    <Alert tone="warning" data-group-notice="files" data-group-state={status.state}>
      {text}
    </Alert>
  );
}

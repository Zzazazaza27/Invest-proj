import { useEffect, useState } from 'react';
import { Alert } from '@fifth/ui';
import type { Features, GroupMode, GroupReason, GroupStatus } from '@fifth/contracts';

/**
 * Доступность группы «Файлы» в кабинете (блок 4, 4.11).
 *
 * Одно состояние на страницу: опрос `/v1/features` раз в минуту и сразу после ответа
 * `group_unavailable`. Опрос только читает состояние — ничего не повторяет и не отправляет.
 * Ограничиваются действия с хранилищем, а не экран: карточки, списки и профиль открываются по
 * своим условиям. Восстановление сообщается один раз — только если перед этим показывалось
 * предупреждение.
 *
 * Отказ конкретного запроса (`group_unavailable` от экземпляра, который его обслуживал)
 * хранится ОТДЕЛЬНО от сводки и держится `REQUEST_HOLD_MS`: исправная сводка — другой
 * экземпляр или прежнее наблюдение — его не отменяет. По истечении срока решает снова сервер.
 */
type Loader = () => Promise<Features>;

const POLL_MS = 60_000;
const RESTORED_SHOW_MS = 8_000;
/** Дольше размыкателя (30 с) и интервала проверки (30 с): ядро успевает перепроверить себя. */
export const REQUEST_HOLD_MS = 60_000;

let summary: GroupStatus | null = null;
const requestFailure: Record<GroupMode, { reason: GroupReason; until: number } | null> = {
  read: null,
  write: null,
};
/**
 * Отказ запроса, восстановление после которого ещё не подтверждено: время отказа. Снимается
 * только сводкой с исправным режимом и наблюдением НОВЕЕ отказа. Истечение удержания лишь
 * разрешает попытку (её проверит сервер), но о восстановлении не сообщает.
 */
const unconfirmed: Record<GroupMode, number | null> = { read: null, write: null };

function confirmFrom(next: GroupStatus): void {
  for (const mode of ['read', 'write'] as const) {
    const since = unconfirmed[mode];
    const seen = next[mode].observedAt ? Date.parse(next[mode].observedAt as string) : NaN;
    if (since !== null && next[mode].allowed && seen > since) unconfirmed[mode] = null;
  }
}
let restored = false;
let warned = false;
let loader: Loader | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

/** Сводка с наложенными отказами конкретных запросов — то, что видит экран. */
export function effectiveStatus(now = Date.now()): GroupStatus | null {
  const failure = (mode: GroupMode) => {
    const f = requestFailure[mode];
    return f && f.until > now ? f : null;
  };
  const read = failure('read');
  const write = failure('write');
  if (!summary && !read && !write) return null;
  const base: GroupStatus = summary ?? {
    state: 'unknown',
    read: { allowed: true, reason: 'ok', observedAt: null },
    write: { allowed: true, reason: 'ok', observedAt: null },
  };
  const next: GroupStatus = {
    state: base.state,
    read: read ? { ...base.read, allowed: false, reason: read.reason } : base.read,
    write: write ? { ...base.write, allowed: false, reason: write.reason } : base.write,
  };
  if (!next.read.allowed) next.state = 'unavailable';
  else if (!next.write.allowed && next.state === 'available') next.state = 'read_only';
  return next;
}

function track(): void {
  const status = effectiveStatus();
  const healthy = !status || (status.read.allowed && status.write.allowed);
  if (!healthy) {
    warned = true;
    restored = false;
  } else if (warned && unconfirmed.read === null && unconfirmed.write === null) {
    warned = false;
    restored = true;
    setTimeout(() => {
      restored = false;
      notify();
    }, RESTORED_SHOW_MS);
  }
  notify();
}

/** Освежить сводку. Отказы конкретных запросов она не снимает. */
export async function refreshFiles(load: Loader | null = loader): Promise<void> {
  if (!load) return;
  try {
    summary = (await load()).groups.files;
    confirmFrom(summary);
  } catch {
    // Не узнали — показываем прежнее; само действие проверит сервер.
  }
  track();
}

/**
 * Ответ `group_unavailable` от действия с файлами: запомнить режим и причину этого запроса и
 * освежить сводку. Режим и причина — из `errors[0]` (`files.write` / `circuit_open`).
 */
export function noteGroupError(error: unknown, now = Date.now()): void {
  const e = error as {
    code?: string;
    problem?: { errors?: { path?: string; message?: string }[] } | null;
  } | null;
  if (e?.code !== 'group_unavailable') return;
  const first = e.problem?.errors?.[0];
  const mode: GroupMode = first?.path === 'files.read' ? 'read' : 'write';
  const reason = (first?.message as GroupReason | undefined) ?? 'dependency_failure';
  requestFailure[mode] = { reason, until: now + REQUEST_HOLD_MS };
  unconfirmed[mode] = now;
  // Истёк срок — экран пересчитывается сам, без нового запроса.
  setTimeout(track, REQUEST_HOLD_MS + 50);
  track();
  void refreshFiles();
}

/** Для модульных проверок: чистое состояние. */
export function resetFilesAvailability(): void {
  summary = null;
  requestFailure.read = null;
  requestFailure.write = null;
  unconfirmed.read = null;
  unconfirmed.write = null;
  restored = false;
  warned = false;
  loader = null;
}

export function currentFilesAvailability(): {
  status: GroupStatus | null;
  canWrite: boolean;
  canRead: boolean;
  restored: boolean;
} {
  const status = effectiveStatus();
  return {
    status,
    // Пока состояние не пришло, кнопки не блокируются: решит сервер.
    canWrite: status?.write.allowed ?? true,
    canRead: status?.read.allowed ?? true,
    restored,
  };
}

export function useFilesAvailability(
  load: Loader | undefined,
): ReturnType<typeof currentFilesAvailability> {
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!load) return undefined;
    loader = load;
    const fn = () => rerender((n) => n + 1);
    listeners.add(fn);
    if (summary === null) void refreshFiles();
    timer ??= setInterval(() => void refreshFiles(), POLL_MS);
    return () => {
      listeners.delete(fn);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, [load]);
  return currentFilesAvailability();
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

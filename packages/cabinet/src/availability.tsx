import { useEffect, useState } from 'react';
import { Alert } from '@fifth/ui';
import type { Features, GroupMode, GroupReason, GroupStatus } from '@fifth/contracts';

/**
 * Доступность групп функций в кабинете (блок 4, 4.11): «Файлы» и «Почта».
 *
 * Одно состояние группы на страницу: опрос `/v1/features` раз в минуту и сразу после ответа
 * `group_unavailable`. Опрос только читает состояние — ничего не повторяет и не отправляет.
 * Ограничиваются действия группы, а не экран. Восстановление сообщается один раз — только
 * если перед этим показывалось предупреждение.
 *
 * Отказ конкретного запроса (`group_unavailable` от экземпляра, который его обслуживал)
 * хранится ОТДЕЛЬНО от сводки и держится `REQUEST_HOLD_MS`: исправная сводка — другой
 * экземпляр или прежнее наблюдение — его не отменяет. По истечении срока решает снова сервер,
 * а «восстановлено» показывается только по исправному наблюдению новее отказа.
 */
type Loader = () => Promise<Features>;

const POLL_MS = 60_000;
const RESTORED_SHOW_MS = 8_000;
/** Дольше размыкателя (30 с) и интервала проверки (30 с): ядро успевает перепроверить себя. */
export const REQUEST_HOLD_MS = 60_000;

export interface GroupAvailability {
  status: GroupStatus | null;
  canWrite: boolean;
  canRead: boolean;
  restored: boolean;
}

class GroupStore {
  summary: GroupStatus | null = null;
  readonly requestFailure: Record<GroupMode, { reason: GroupReason; until: number } | null> = {
    read: null,
    write: null,
  };
  /** Время отказа запроса, восстановление после которого ещё не подтверждено. */
  readonly unconfirmed: Record<GroupMode, number | null> = { read: null, write: null };
  restored = false;
  warned = false;
  loader: Loader | null = null;
  timer: ReturnType<typeof setInterval> | null = null;
  readonly listeners = new Set<() => void>();

  constructor(readonly group: CabinetGroup) {}

  notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  effective(now = Date.now()): GroupStatus | null {
    const failure = (mode: GroupMode) => {
      const f = this.requestFailure[mode];
      return f && f.until > now ? f : null;
    };
    const read = failure('read');
    const write = failure('write');
    if (!this.summary && !read && !write) return null;
    const base: GroupStatus = this.summary ?? {
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

  confirmFrom(next: GroupStatus): void {
    for (const mode of ['read', 'write'] as const) {
      const since = this.unconfirmed[mode];
      const seen = next[mode].observedAt ? Date.parse(next[mode].observedAt as string) : NaN;
      if (since !== null && next[mode].allowed && seen > since) this.unconfirmed[mode] = null;
    }
  }

  track(): void {
    const status = this.effective();
    const healthy = !status || (status.read.allowed && status.write.allowed);
    if (!healthy) {
      this.warned = true;
      this.restored = false;
    } else if (this.warned && this.unconfirmed.read === null && this.unconfirmed.write === null) {
      this.warned = false;
      this.restored = true;
      setTimeout(() => {
        this.restored = false;
        this.notify();
      }, RESTORED_SHOW_MS);
    }
    this.notify();
  }

  private inflight: Promise<void> | null = null;

  /** Одновременные вызовы (несколько блоков на странице) — один запрос. */
  refresh(load: Loader | null = this.loader): Promise<void> {
    if (!load) return Promise.resolve();
    this.inflight ??= (async () => {
      try {
        this.summary = (await load()).groups[this.group];
        this.confirmFrom(this.summary);
      } catch {
        // Не узнали — показываем прежнее; само действие проверит сервер.
      } finally {
        this.inflight = null;
      }
      this.track();
    })();
    return this.inflight;
  }

  noteFailure(mode: GroupMode, reason: GroupReason, now: number): void {
    this.requestFailure[mode] = { reason, until: now + REQUEST_HOLD_MS };
    this.unconfirmed[mode] = now;
    // Истёк срок — экран пересчитывается сам, без нового запроса.
    setTimeout(() => this.track(), REQUEST_HOLD_MS + 50);
    this.track();
    void this.refresh();
  }

  reset(): void {
    this.summary = null;
    this.requestFailure.read = null;
    this.requestFailure.write = null;
    this.unconfirmed.read = null;
    this.unconfirmed.write = null;
    this.restored = false;
    this.warned = false;
    this.loader = null;
  }

  current(): GroupAvailability {
    const status = this.effective();
    return {
      status,
      // Пока состояние не пришло, кнопки не блокируются: решит сервер.
      canWrite: status?.write.allowed ?? true,
      canRead: status?.read.allowed ?? true,
      restored: this.restored,
    };
  }
}

/** Кабинетам видны «Файлы» и «Почта»; у «Событий» пользовательских действий нет. */
export type CabinetGroup = 'files' | 'mail';
const stores: Record<CabinetGroup, GroupStore> = {
  files: new GroupStore('files'),
  mail: new GroupStore('mail'),
};

/**
 * Ответ `group_unavailable` от действия: запомнить группу, режим и причину этого запроса и
 * освежить сводку. Всё — из `errors[0]` (`files.write` / `circuit_open`).
 */
export function noteGroupError(error: unknown, now = Date.now()): void {
  const e = error as {
    code?: string;
    problem?: { errors?: { path?: string; message?: string }[] } | null;
  } | null;
  if (e?.code !== 'group_unavailable') return;
  const first = e.problem?.errors?.[0];
  const [groupPart, modePart] = (first?.path ?? 'files.write').split('.');
  const store =
    stores[(groupPart as CabinetGroup) in stores ? (groupPart as CabinetGroup) : 'files'];
  const mode: GroupMode = modePart === 'read' ? 'read' : 'write';
  const reason = (first?.message as GroupReason | undefined) ?? 'dependency_failure';
  store.noteFailure(mode, reason, now);
}

export function useGroupAvailability(
  group: CabinetGroup,
  load: Loader | undefined,
): GroupAvailability {
  const store = stores[group];
  const [, rerender] = useState(0);
  useEffect(() => {
    if (!load) return undefined;
    store.loader = load;
    const fn = () => rerender((n) => n + 1);
    store.listeners.add(fn);
    if (store.summary === null) void store.refresh();
    store.timer ??= setInterval(() => void store.refresh(), POLL_MS);
    return () => {
      store.listeners.delete(fn);
      if (store.listeners.size === 0 && store.timer) {
        clearInterval(store.timer);
        store.timer = null;
      }
    };
  }, [load, store]);
  return store.current();
}

// ------------------------------------------------------------ «Файлы» (прежние имена)
export const effectiveStatus = (now = Date.now()) => stores.files.effective(now);
export const refreshFiles = (load?: Loader | null) =>
  stores.files.refresh(load ?? stores.files.loader);
export const resetFilesAvailability = () => stores.files.reset();
export const currentFilesAvailability = () => stores.files.current();
export const useFilesAvailability = (load: Loader | undefined) =>
  useGroupAvailability('files', load);

// ---------------------------------------------------------------- «Почта»
export const refreshMail = (load?: Loader | null) =>
  stores.mail.refresh(load ?? stores.mail.loader);
export const resetMailAvailability = () => stores.mail.reset();
export const currentMailAvailability = () => stores.mail.current();
export const useMailAvailability = (load: Loader | undefined) => useGroupAvailability('mail', load);

const FILES_WRITE: Record<GroupReason, string> = {
  ok: '',
  dependency_failure:
    'Загрузка и изменение файлов временно недоступны: хранилище не отвечает. Уже загруженное по-прежнему можно открыть.',
  circuit_open:
    'Загрузка и изменение файлов временно приостановлены из-за сбоев хранилища. Уже загруженное по-прежнему можно открыть.',
  observations_stale: 'Не удаётся проверить хранилище файлов — загрузка временно приостановлена.',
  manual_restriction: 'Работа с файлами временно ограничена: загрузка и изменение недоступны.',
  not_configured: 'Хранилище файлов не подключено: загрузка недоступна.',
};
const FILES_READ = 'Файлы сейчас недоступны: открыть и загрузить их нельзя.';

/** «Почта»: только отправка — один текст на причину, без деталей канала. */
const MAIL_SEND: Record<GroupReason, string> = {
  ok: '',
  dependency_failure: 'Отправка писем временно недоступна: почтовый сервис не отвечает.',
  circuit_open: 'Отправка писем временно приостановлена из-за сбоев почтового сервиса.',
  observations_stale: 'Не удаётся проверить отправку писем — запрос письма временно приостановлен.',
  manual_restriction: 'Отправка писем временно ограничена.',
  not_configured: 'Отправка писем на платформе не подключена.',
};

const RESTORED: Record<CabinetGroup, string> = {
  files: 'Работа с файлами восстановлена.',
  mail: 'Отправка писем восстановлена.',
};

/** Одна причина на группу — показывать один раз на странице, рядом с действиями группы. */
export function GroupNotice({
  group,
  availability,
}: {
  group: CabinetGroup;
  availability: GroupAvailability;
}): React.ReactElement | null {
  const { status, restored } = availability;
  if (restored) {
    return (
      <Alert tone="success" data-group-notice={group} data-group-state="restored">
        {RESTORED[group]}
      </Alert>
    );
  }
  if (!status || (status.read.allowed && status.write.allowed)) return null;
  const text =
    group === 'mail'
      ? MAIL_SEND[status.write.allowed ? status.read.reason : status.write.reason]
      : status.read.allowed
        ? FILES_WRITE[status.write.reason]
        : FILES_READ;
  return (
    <Alert tone="warning" data-group-notice={group} data-group-state={status.state}>
      {text}
    </Alert>
  );
}

export function FilesNotice({
  availability,
}: {
  availability: GroupAvailability;
}): React.ReactElement | null {
  return <GroupNotice group="files" availability={availability} />;
}

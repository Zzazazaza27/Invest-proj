import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  CurrentUser,
  FundingRound,
  FundingRoundDetail,
  ProjectVersion,
  RaisingState,
  RoundCloseReason,
  ServiceCountry,
  ServiceCountryPolicyVersion,
  UpdateFundingRoundRequest,
} from '@unicorn/contracts';
import { raisingState } from '@unicorn/contracts';
import { ApiError, api } from '../api';
import type { SaveState } from './useApplication';

/**
 * Раунд привлечения в мастере (план 0.2 §0г, этап 5.6.4).
 *
 * Состояние «привлекает ли проект инвестиции» ОПРЕДЕЛЯЕТСЯ РАУНДОМ: здесь нет
 * отдельного флага, который можно было бы переключить. Хук читает раунды
 * проекта, выбирает текущий (незавершённый open/paused, иначе черновик) и
 * даёт мастеру:
 *
 *  - автосохранение полей и ответов раунда по тем же правилам, что у профиля
 *    (пауза после ввода, один запрос за раз, повтор после 429/сбоя, keepalive
 *    при уходе) — см. `useApplication`;
 *  - явные переходы: открыть, приостановить, возобновить, закрыть с причиной,
 *    отменить черновик. Каждый — отдельное действие пользователя; молчаливой
 *    отмены или скрытия раунда переключением ответа нет по построению;
 *  - страну обслуживания аккаунта: первичный выбор из активных стран; смена
 *    уже выбранной — не здесь (реестр решений: контролируемая смена);
 *  - условия страны для показа рядом с суммой.
 *
 * Запросы бережём: на любом экране мастера нужен только список раундов (и
 * текущий раунд, если он есть); профиль пользователя, страны, условия и
 * поданные версии — «контекст» — подгружаются только на экране раунда.
 * Потолок частоты 120 запросов в минуту на пользователя — реальное
 * ограничение при автосохранении.
 */

export interface RoundContext {
  me: CurrentUser;
  countries: ServiceCountry[];
  policy: ServiceCountryPolicyVersion | null;
  /** Поданные версии профиля, новые первыми — кандидаты в основание раунда. */
  versions: ProjectVersion[];
}

export interface RoundData {
  rounds: FundingRound[];
  /** Текущий раунд: незавершённый, иначе черновик; null — раунда нет. */
  current: FundingRoundDetail | null;
  /** Второй раунд рядом с текущим: черновик при незавершённом или наоборот. */
  sideRound: FundingRound | null;
  /** Контекст экрана раунда; null, пока не запрошен (`ensureContext`). */
  context: RoundContext | null;
}

type AnswerValue = unknown;

const DEBOUNCE_MS = 1500;
const MAX_WAIT_MS = 10_000;
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 60_000;
const MAX_AUTO_RETRIES = 5;

const UNFINISHED: ReadonlySet<FundingRound['status']> = new Set(['open', 'paused']);

export function pickCurrent(rounds: FundingRound[]): FundingRound | null {
  return (
    rounds.find((r) => UNFINISHED.has(r.status)) ?? rounds.find((r) => r.status === 'draft') ?? null
  );
}

export function useRound(projectId: string) {
  const [data, setData] = useState<RoundData | null>(null);
  const [error, setError] = useState<{ message: string; traceId: string | null } | null>(null);
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [evidence, setEvidence] = useState<Record<string, string[]>>({});
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [savedCount, setSavedCount] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  /** Явно выбранный раунд (черновик рядом с открытым), иначе — по правилу pickCurrent. */
  const selectedId = useRef<string | null>(null);
  /** Контекст загружен или загружается — второй раз не ходим. */
  const contextRequested = useRef(false);

  const pending = useRef<{
    answers: Record<string, AnswerValue>;
    evidence: Record<string, string[]>;
    fields: UpdateFundingRoundRequest;
  }>({ answers: {}, evidence: {}, fields: {} });
  const inFlight = useRef(false);
  const queued = useRef(false);
  const timer = useRef<number | null>(null);
  const firstChangeAt = useRef<number | null>(null);
  const retryTimer = useRef<number | null>(null);
  const retries = useRef(0);
  const roundId = useRef<string | null>(null);

  const applyDetail = useCallback((detail: FundingRoundDetail | null) => {
    roundId.current = detail?.round.id ?? null;
    setAnswers(detail?.round.answers ?? {});
    setEvidence(
      Object.fromEntries(Object.entries(detail?.round.evidence ?? {}).map(([k, v]) => [k, [...v]])),
    );
    setFieldErrors({});
  }, []);

  const fail = (e: unknown) => {
    setError({
      message: e instanceof ApiError ? (e.problem?.detail ?? e.message) : 'Сервис недоступен',
      traceId: e instanceof ApiError ? e.traceId : null,
    });
  };

  /** Раунды проекта и текущий раунд — один-два запроса. */
  const load = useCallback(
    async (preferId: string | null = selectedId.current) => {
      setError(null);
      try {
        const list = await api.rounds.list(projectId);
        const rounds = list.items;
        const byRule = pickCurrent(rounds);
        const preferred = preferId ? rounds.find((r) => r.id === preferId) : undefined;
        const chosen =
          preferred && (UNFINISHED.has(preferred.status) || preferred.status === 'draft')
            ? preferred
            : byRule;
        const current = chosen ? await api.rounds.get(chosen.id) : null;
        const sideRound =
          chosen && UNFINISHED.has(chosen.status)
            ? (rounds.find((r) => r.status === 'draft') ?? null)
            : chosen?.status === 'draft'
              ? (rounds.find((r) => UNFINISHED.has(r.status)) ?? null)
              : null;
        setData((prev) => ({ rounds, current, sideRound, context: prev?.context ?? null }));
        applyDetail(current);
      } catch (e) {
        fail(e);
      }
    },
    [projectId, applyDetail],
  );

  useEffect(() => {
    void load();
  }, [load]);

  /** Контекст экрана раунда: профиль, страны, условия, поданные версии. */
  const loadContext = useCallback(
    async (countryHint: string | null = null) => {
      try {
        const [me, countries, versions] = await Promise.all([
          api.auth.me(),
          api.serviceCountries.list(),
          api.projects.versions(projectId),
        ]);
        const code = countryHint ?? me.serviceCountry ?? null;
        const policy = code ? await api.serviceCountries.policy(code) : null;
        const context: RoundContext = {
          me,
          countries: countries.items.filter((c) => c.isActive),
          policy,
          versions: versions
            .filter((v) => v.schemaVersion > 0)
            .sort((a, b) => b.versionNo - a.versionNo),
        };
        setData((prev) =>
          prev ? { ...prev, context } : { rounds: [], current: null, sideRound: null, context },
        );
        return context;
      } catch (e) {
        fail(e);
        return null;
      }
    },
    [projectId],
  );

  const ensureContext = useCallback(async () => {
    if (contextRequested.current) return;
    contextRequested.current = true;
    await loadContext(data?.current?.round.serviceCountry ?? null);
  }, [loadContext, data]);

  const hasPending = () => {
    const p = pending.current;
    return (
      Object.keys(p.answers).length > 0 ||
      Object.keys(p.evidence).length > 0 ||
      Object.keys(p.fields).length > 0
    );
  };

  const clearTimers = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    timer.current = null;
    retryTimer.current = null;
  };

  function restore(batch: typeof pending.current, keep: (key: string) => boolean) {
    const p = pending.current;
    for (const [key, value] of Object.entries(batch.answers)) {
      if (keep(key) && !(key in p.answers)) p.answers[key] = value;
    }
    for (const [key, value] of Object.entries(batch.evidence)) {
      if (keep(key) && !(key in p.evidence)) p.evidence[key] = value;
    }
    for (const [key, value] of Object.entries(batch.fields)) {
      if (keep(key) && !(key in p.fields)) (p.fields as Record<string, unknown>)[key] = value;
    }
  }

  const flush = useCallback(async (opts: { keepalive?: boolean } = {}): Promise<void> => {
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    const id = roundId.current;
    if (!id || !hasPending()) return;

    const batch = pending.current;
    pending.current = { answers: {}, evidence: {}, fields: {} };
    firstChangeAt.current = null;

    const body: UpdateFundingRoundRequest = { ...batch.fields };
    if (Object.keys(batch.answers).length > 0) body.answers = { ...batch.answers };
    if (Object.keys(batch.evidence).length > 0) body.evidence = { ...batch.evidence };

    inFlight.current = true;
    setSave({ kind: 'saving' });
    try {
      const detail = await api.rounds.update(id, body, { keepalive: opts.keepalive });
      setData((current) =>
        current
          ? {
              ...current,
              current: detail,
              rounds: current.rounds.map((r) => (r.id === detail.round.id ? detail.round : r)),
            }
          : current,
      );
      setFieldErrors((current) => {
        const next = { ...current };
        for (const key of Object.keys(batch.answers)) delete next[key];
        for (const key of Object.keys(batch.fields)) delete next[snake(key)];
        return next;
      });
      retries.current = 0;
      setSave({ kind: 'saved', at: new Date() });
      setSavedCount((n) => n + 1);
    } catch (e) {
      const apiError = e instanceof ApiError ? e : null;
      const message = apiError?.problem?.detail ?? (e instanceof Error ? e.message : 'сбой');
      if (apiError && (apiError.status === 400 || apiError.status === 422)) {
        const bad = new Set<string>();
        const errorsByField: Record<string, string> = {};
        for (const fe of apiError.problem?.errors ?? []) {
          const key = fe.path.replace(/^answers\./, '');
          bad.add(key);
          errorsByField[key] = fe.message;
        }
        setFieldErrors((current) => ({ ...current, ...errorsByField }));
        if (bad.size > 0) {
          restore(batch, (key) => !bad.has(key) && !bad.has(snake(key)));
          if (hasPending()) queued.current = true;
          setSave({ kind: 'failed', message: 'проверьте отмеченные поля' });
        } else {
          restore(batch, () => true);
          setSave({ kind: 'failed', message });
        }
      } else if (apiError && apiError.status === 409) {
        // Раунд сменил состояние (например, закрыт с другой вкладки): буфер не
        // теряем, но и не долбим сервер — пользователь увидит и решит.
        restore(batch, () => true);
        setSave({ kind: 'failed', message });
      } else {
        restore(batch, () => true);
        if (retries.current < MAX_AUTO_RETRIES) {
          const delay =
            apiError?.retryAfterSeconds !== null && apiError?.retryAfterSeconds !== undefined
              ? apiError.retryAfterSeconds * 1000 + 250
              : Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** retries.current);
          retries.current += 1;
          const at = new Date(Date.now() + delay);
          setSave({ kind: 'retrying', message, at });
          retryTimer.current = window.setTimeout(() => {
            retryTimer.current = null;
            void flush();
          }, delay);
        } else {
          setSave({ kind: 'failed', message });
        }
      }
    } finally {
      inFlight.current = false;
      if (queued.current) {
        queued.current = false;
        if (hasPending()) void flush();
      }
    }
  }, []);

  const schedule = useCallback(() => {
    setSave((current) => (current.kind === 'saving' ? current : { kind: 'pending' }));
    if (timer.current !== null) window.clearTimeout(timer.current);
    const now = Date.now();
    firstChangeAt.current ??= now;
    const sinceFirst = now - firstChangeAt.current;
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - sinceFirst));
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void flush();
    }, delay);
  }, [flush]);

  const setAnswer = useCallback(
    (key: string, value: AnswerValue) => {
      setAnswers((current) => ({ ...current, [key]: value }));
      pending.current.answers[key] = value;
      schedule();
    },
    [schedule],
  );

  const setEvidenceFor = useCallback(
    (key: string, materialIds: string[]) => {
      setEvidence((current) => ({ ...current, [key]: materialIds }));
      pending.current.evidence[key] = materialIds;
      schedule();
    },
    [schedule],
  );

  /** Поля раунда (сумма, валюта, предмет, чек) — без паузы, сразу. */
  const setField = useCallback(
    async (patch: UpdateFundingRoundRequest) => {
      Object.assign(pending.current.fields, patch);
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      await flush();
    },
    [flush],
  );

  const retryNow = useCallback(() => {
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    retries.current = 0;
    void flush();
  }, [flush]);

  useEffect(() => {
    const flushNow = () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      if (hasPending() && !inFlight.current) void flush({ keepalive: true });
    };
    const guard = (event: BeforeUnloadEvent) => {
      flushNow();
      if (hasPending() || inFlight.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('pagehide', flushNow);
    window.addEventListener('beforeunload', guard);
    return () => {
      window.removeEventListener('pagehide', flushNow);
      window.removeEventListener('beforeunload', guard);
      clearTimers();
      if (hasPending() && !inFlight.current) void flush({ keepalive: true });
    };
  }, [flush]);

  // ------------------------------------------------------------ действия

  /**
   * Подготовить раунд: черновик создаётся по явному действию пользователя.
   * Основание — последняя поданная версия профиля, если она есть; без неё
   * черновик готовится, а открыть его можно будет только после подачи.
   */
  const prepare = useCallback(async (): Promise<FundingRoundDetail> => {
    await flush();
    const context = data?.context ?? (await loadContext());
    const latest = context?.versions[0];
    const detail = await api.rounds.create(
      projectId,
      latest ? { applicationVersionId: latest.id } : {},
    );
    selectedId.current = detail.round.id;
    await load(detail.round.id);
    return detail;
  }, [data, projectId, flush, load, loadContext]);

  const transition = useCallback(
    async (
      run: (id: string) => Promise<FundingRoundDetail>,
    ): Promise<FundingRoundDetail | null> => {
      const id = roundId.current;
      if (!id) return null;
      await flush();
      const detail = await run(id);
      await load(detail.round.id);
      return detail;
    },
    [flush, load],
  );

  // Открытие подтверждает версию условий раскрытия из предпросмотра (5.7.3):
  // сервер отказывает, если администратор успел опубликовать другую.
  const open = useCallback(
    () =>
      transition(async (id) => {
        const preview = await api.rounds.openPreview(id);
        return api.rounds.open(id, { confirmDisclosureVersion: preview.activeFormVersion });
      }),
    [transition],
  );
  const pause = useCallback(() => transition((id) => api.rounds.pause(id)), [transition]);
  const resume = useCallback(() => transition((id) => api.rounds.resume(id)), [transition]);
  const close = useCallback(
    (closeReason: RoundCloseReason) => transition((id) => api.rounds.close(id, { closeReason })),
    [transition],
  );
  const cancel = useCallback(async () => {
    const result = await transition((id) => api.rounds.cancel(id));
    selectedId.current = null;
    await load(null);
    return result;
  }, [transition, load]);
  const changeBasis = useCallback(
    (applicationVersionId: string, reason: string) =>
      transition((id) => api.rounds.changeBasis(id, { applicationVersionId, reason })),
    [transition],
  );

  /** Первичный выбор страны аккаунта. Смена уже выбранной — отдельная операция, здесь её нет. */
  const chooseCountry = useCallback(
    async (code: string) => {
      await api.serviceCountries.setMine(code);
      await loadContext(code);
    },
    [loadContext],
  );

  const select = useCallback(
    async (id: string) => {
      await flush();
      selectedId.current = id;
      await load(id);
    },
    [flush, load],
  );

  const unfinished = data?.rounds.find((r) => UNFINISHED.has(r.status)) ?? null;
  const raising: { raising: RaisingState; investmentAsk: string | null; askCurrency: string } = {
    raising: raisingState(unfinished),
    investmentAsk: unfinished?.target ?? null,
    askCurrency: unfinished?.currency ?? 'RUB',
  };

  return {
    data,
    error,
    answers,
    evidence,
    save,
    savedCount,
    fieldErrors,
    raising,
    reload: () => load(),
    ensureContext,
    setAnswer,
    setEvidenceFor,
    setField,
    flush,
    retryNow,
    prepare,
    open,
    pause,
    resume,
    close,
    cancel,
    changeBasis,
    chooseCountry,
    select,
  };
}

export type RoundHook = ReturnType<typeof useRound>;

function snake(field: string): string {
  return field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

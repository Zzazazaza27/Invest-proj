import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ApplicationDetail,
  ApplicationFormView,
  ProjectFull,
  ProjectMaterial,
  UpdateApplicationRequest,
} from '@unicorn/contracts';
import { ApiError, api } from '../api';

/**
 * Данные мастера и автосохранение (план 0.2 §0в, этап 4.1; доработано по
 * замечанию владельца после этапа 4).
 *
 * Форма берётся по ВЕРСИИ заявки (`GET /applications/:id/form`) и
 * перечитывается только при смене стадии — тогда меняется набор вопросов, а
 * версия остаётся прежней.
 *
 * Правила автосохранения — потеря набранного недопустима:
 *
 *  1. ПАУЗА ПОСЛЕ ВВОДА. Изменения копятся локально и уходят одним `PATCH`
 *     через 1,5 с после последнего нажатия; при непрерывном наборе — не реже
 *     раза в 10 с. Длинный ответ даёт единицы запросов, а не запрос на букву.
 *  2. НИ ОДНОГО ПАРАЛЛЕЛЬНОГО ЗАПРОСА. Пока один `PATCH` в пути, новые
 *     изменения ждут его завершения и уходят следующим запросом. Устаревшая
 *     версия никогда не обгоняет новую: сервер видит их по порядку.
 *  3. 429 И СБОИ — ПОВТОР, А НЕ ПОТЕРЯ. Неотправленное остаётся в буфере;
 *     после 429 повтор через `Retry-After` (или 5 с), после сбоя сети — с
 *     нарастающей паузой; пользователь видит «не сохранено» и может
 *     повторить сразу. Ошибка типа (400) показывается у поля, остальные
 *     ключи из того же запроса досылаются без него.
 *  4. УХОД СО СТРАНИЦЫ. Недосланное уходит немедленно запросом `keepalive`;
 *     при несохранённых данных браузер спрашивает подтверждение закрытия.
 */

export type SaveState =
  | { kind: 'idle' }
  /** Есть изменения, которые ещё не ушли на сервер (пауза ввода). */
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: Date }
  /** Не сохранено, повтор запланирован. */
  | { kind: 'retrying'; message: string; at: Date }
  /** Не сохранено, автоматических повторов больше нет — только вручную. */
  | { kind: 'failed'; message: string };

export interface WizardData {
  detail: ApplicationDetail;
  form: ApplicationFormView;
  project: ProjectFull;
  materials: ProjectMaterial[];
}

type AnswerValue = unknown;

const DEBOUNCE_MS = 1500;
const MAX_WAIT_MS = 10_000;
const RETRY_BASE_MS = 5000;
const RETRY_MAX_MS = 60_000;
const MAX_AUTO_RETRIES = 5;

export function useApplication(applicationId: string) {
  const [data, setData] = useState<WizardData | null>(null);
  const [error, setError] = useState<{ message: string; traceId: string | null } | null>(null);
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [evidence, setEvidence] = useState<Record<string, string[]>>({});
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  /** Сколько раз сохранение завершилось успешно — для проверок «дождаться записи». */
  const [savedCount, setSavedCount] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // Буферы вне React-состояния: их читает и меняет асинхронный цикл отправки.
  const pending = useRef<{
    answers: Record<string, AnswerValue>;
    evidence: Record<string, string[]>;
    core: UpdateApplicationRequest;
  }>({ answers: {}, evidence: {}, core: {} });
  const inFlight = useRef(false);
  const queued = useRef(false);
  const timer = useRef<number | null>(null);
  const firstChangeAt = useRef<number | null>(null);
  const retryTimer = useRef<number | null>(null);
  const retries = useRef(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      const detail = await api.applications.get(applicationId);
      const [form, project, materials] = await Promise.all([
        api.applications.form(applicationId),
        api.projects.get(detail.application.projectId),
        api.projects.materials(detail.application.projectId),
      ]);
      setData({ detail, form, project, materials });
      setAnswers(detail.application.answers);
      setEvidence(
        Object.fromEntries(
          Object.entries(detail.application.evidence).map(([k, v]) => [k, [...v]]),
        ),
      );
    } catch (e) {
      setError({
        message: e instanceof ApiError ? (e.problem?.detail ?? e.message) : 'Сервис недоступен',
        traceId: e instanceof ApiError ? e.traceId : null,
      });
    }
  }, [applicationId]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasPending = () => {
    const p = pending.current;
    return (
      Object.keys(p.answers).length > 0 ||
      Object.keys(p.evidence).length > 0 ||
      Object.keys(p.core).length > 0
    );
  };

  const clearTimers = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    timer.current = null;
    retryTimer.current = null;
  };

  /**
   * Один запрос за раз. Забирает всё накопленное, отправляет; если за время
   * запроса накопилось ещё — отправляет следом. При неудаче возвращает
   * значения в буфер, не затирая более новые.
   */
  const flush = useCallback(
    async (opts: { keepalive?: boolean } = {}): Promise<void> => {
      if (inFlight.current) {
        queued.current = true;
        return;
      }
      if (!hasPending()) return;

      const batch = pending.current;
      pending.current = { answers: {}, evidence: {}, core: {} };
      firstChangeAt.current = null;

      const body: UpdateApplicationRequest = { ...batch.core };
      if (Object.keys(batch.answers).length > 0) body.answers = { ...batch.answers };
      if (Object.keys(batch.evidence).length > 0) body.evidence = { ...batch.evidence };

      inFlight.current = true;
      setSave({ kind: 'saving' });
      try {
        const detail = await api.applications.update(applicationId, body, {
          keepalive: opts.keepalive,
        });
        setData((current) => (current ? { ...current, detail } : current));
        setFieldErrors((current) => {
          const next = { ...current };
          for (const key of Object.keys(batch.answers)) delete next[key];
          for (const key of Object.keys(batch.core)) delete next[coreKey(key)];
          return next;
        });
        retries.current = 0;
        setSave({ kind: 'saved', at: new Date() });
        setSavedCount((n) => n + 1);
        if (batch.core.stage !== undefined) {
          const form = await api.applications.form(applicationId);
          setData((current) => (current ? { ...current, form } : current));
        }
      } catch (e) {
        const apiError = e instanceof ApiError ? e : null;
        const message = apiError?.problem?.detail ?? (e instanceof Error ? e.message : 'сбой');

        if (apiError && (apiError.status === 400 || apiError.status === 422)) {
          // Ошибка типа: показать у поля, остальное из того же запроса — дослать.
          const bad = new Set<string>();
          const errorsByField: Record<string, string> = {};
          for (const fe of apiError.problem?.errors ?? []) {
            const key = fe.path.replace(/^answers\./, '');
            bad.add(key);
            errorsByField[key] = fe.message;
          }
          setFieldErrors((current) => ({ ...current, ...errorsByField }));
          if (bad.size > 0) {
            // Остальные ключи из того же запроса — дослать без отмеченных.
            restore(batch, (key) => !bad.has(key) && !bad.has(coreKey(key)));
            if (hasPending()) queued.current = true;
            setSave({ kind: 'failed', message: 'проверьте отмеченные поля' });
          } else {
            // Отказ без указания поля: ничего не теряем, повтор — вручную.
            restore(batch, () => true);
            setSave({ kind: 'failed', message });
          }
        } else {
          // Потолок частоты, сеть, 5xx — вернуть в буфер и повторить позже.
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
    },
    [applicationId],
  );

  /** Вернуть неотправленное в буфер, не затирая то, что пользователь успел изменить после. */
  function restore(
    batch: {
      answers: Record<string, AnswerValue>;
      evidence: Record<string, string[]>;
      core: UpdateApplicationRequest;
    },
    keep: (key: string) => boolean,
  ) {
    const p = pending.current;
    for (const [key, value] of Object.entries(batch.answers)) {
      if (keep(key) && !(key in p.answers)) p.answers[key] = value;
    }
    for (const [key, value] of Object.entries(batch.evidence)) {
      if (keep(key) && !(key in p.evidence)) p.evidence[key] = value;
    }
    for (const [key, value] of Object.entries(batch.core) as [
      keyof UpdateApplicationRequest,
      never,
    ][]) {
      if (keep(key) && !(key in p.core)) (p.core as Record<string, unknown>)[key] = value;
    }
  }

  const schedule = useCallback(() => {
    setSave((current) => (current.kind === 'saving' ? current : { kind: 'pending' }));
    if (timer.current !== null) window.clearTimeout(timer.current);
    const now = Date.now();
    firstChangeAt.current ??= now;
    // Пауза после ввода, но не дольше MAX_WAIT с первого несохранённого изменения.
    const sinceFirst = now - firstChangeAt.current;
    const delay = Math.max(0, Math.min(DEBOUNCE_MS, MAX_WAIT_MS - sinceFirst));
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void flush();
    }, delay);
  }, [flush]);

  /** Ответ на вопрос анкеты: локально сразу, на сервер — после паузы. */
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

  /** Системные поля (стадия, сумма, предмет финансирования) — без паузы. */
  const setCore = useCallback(
    async (patch: UpdateApplicationRequest) => {
      Object.assign(pending.current.core, patch);
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      await flush();
    },
    [flush],
  );

  /** Повторить вручную — после «не сохранено». */
  const retryNow = useCallback(() => {
    if (retryTimer.current !== null) {
      window.clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    retries.current = 0;
    void flush();
  }, [flush]);

  // Уход со страницы: недосланное — немедленно и с keepalive; при несохранённых
  // данных браузер спрашивает подтверждение закрытия вкладки.
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
        // Устаревший, но всё ещё нужный некоторым браузерам способ.
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

  return {
    data,
    error,
    answers,
    evidence,
    save,
    savedCount,
    fieldErrors,
    reload: load,
    setAnswer,
    setEvidenceFor,
    setCore,
    flush,
    retryNow,
  };
}

/** Ключ ошибки для системного поля: `investmentAsk` → `investment_ask`. */
function coreKey(field: string): string {
  return field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

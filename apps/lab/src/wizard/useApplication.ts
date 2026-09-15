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
 * Данные мастера и автосохранение (план 0.2 §0в, этап 4.1).
 *
 * Форма берётся по ВЕРСИИ заявки (`GET /applications/:id/form`), и
 * перечитывается только при смене стадии — тогда меняется набор вопросов, а
 * версия остаётся прежней. Ответы копятся локально и уходят на сервер
 * одним `PATCH` после паузы ввода; ответ сервера содержит и заявку, и
 * готовность, и условия подачи — экран обновляется из него, а не из
 * собственных предположений.
 *
 * Сохранение никогда не блокируется пустыми полями (черновик свободен);
 * отказ сервера возможен только по типу значения — он показывается у поля.
 */

export type SaveState =
  | { kind: 'idle' }
  /** Есть изменения, которые ещё не ушли на сервер (пауза ввода). */
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'saved'; at: Date }
  | { kind: 'failed'; message: string };

export interface WizardData {
  detail: ApplicationDetail;
  form: ApplicationFormView;
  project: ProjectFull;
  materials: ProjectMaterial[];
}

type AnswerValue = unknown;

export function useApplication(applicationId: string) {
  const [data, setData] = useState<WizardData | null>(null);
  const [error, setError] = useState<{ message: string; traceId: string | null } | null>(null);
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>({});
  const [evidence, setEvidence] = useState<Record<string, string[]>>({});
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  /** Сколько раз сохранение завершилось успешно — для проверок «дождаться записи». */
  const [savedCount, setSavedCount] = useState(0);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const pending = useRef<Record<string, AnswerValue>>({});
  const pendingEvidence = useRef<Record<string, string[]>>({});
  const timer = useRef<number | null>(null);

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

  /** Один PATCH на все накопленные изменения; ответ сервера — новое состояние. */
  const flush = useCallback(
    async (extra: UpdateApplicationRequest = {}) => {
      const body: UpdateApplicationRequest = { ...extra };
      const keys = Object.keys(pending.current);
      if (keys.length > 0) {
        body.answers = { ...pending.current };
        pending.current = {};
      }
      const evidenceKeys = Object.keys(pendingEvidence.current);
      if (evidenceKeys.length > 0) {
        body.evidence = { ...pendingEvidence.current };
        pendingEvidence.current = {};
      }
      if (Object.keys(body).length === 0) return;
      setSave({ kind: 'saving' });
      try {
        const detail = await api.applications.update(applicationId, body);
        setData((current) => (current ? { ...current, detail } : current));
        setFieldErrors((current) => {
          const next = { ...current };
          for (const key of [...keys, ...evidenceKeys]) delete next[key];
          return next;
        });
        setSave({ kind: 'saved', at: new Date() });
        setSavedCount((n) => n + 1);
        // Смена стадии меняет набор применимых вопросов — форму перечитать,
        // версия при этом остаётся той же.
        if (extra.stage !== undefined) {
          const form = await api.applications.form(applicationId);
          setData((current) => (current ? { ...current, form } : current));
        }
      } catch (e) {
        const problem = e instanceof ApiError ? e.problem : null;
        const errorsByField: Record<string, string> = {};
        for (const fe of problem?.errors ?? []) {
          errorsByField[fe.path.replace(/^answers\./, '')] = fe.message;
        }
        setFieldErrors((current) => ({ ...current, ...errorsByField }));
        setSave({
          kind: 'failed',
          message: problem?.detail ?? (e instanceof Error ? e.message : 'Сервис недоступен'),
        });
      }
    },
    [applicationId],
  );

  const schedule = useCallback(() => {
    setSave((current) => (current.kind === 'saving' ? current : { kind: 'pending' }));
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void flush();
    }, 500);
  }, [flush]);

  /** Ответ на вопрос анкеты: локально сразу, на сервер — после паузы. */
  const setAnswer = useCallback(
    (key: string, value: AnswerValue) => {
      setAnswers((current) => ({ ...current, [key]: value }));
      pending.current[key] = value;
      schedule();
    },
    [schedule],
  );

  const setEvidenceFor = useCallback(
    (key: string, materialIds: string[]) => {
      setEvidence((current) => ({ ...current, [key]: materialIds }));
      pendingEvidence.current[key] = materialIds;
      schedule();
    },
    [schedule],
  );

  /** Системные поля (стадия, сумма, предмет финансирования) — сразу, без паузы. */
  const setCore = useCallback(
    async (patch: UpdateApplicationRequest) => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      await flush(patch);
    },
    [flush],
  );

  // Уход со страницы (переход по маршруту, закрытие вкладки, адресная строка):
  // недосланное отправить сразу, а не потерять с таймером.
  useEffect(() => {
    const flushNow = () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
        void flush();
      }
    };
    window.addEventListener('pagehide', flushNow);
    window.addEventListener('beforeunload', flushNow);
    return () => {
      window.removeEventListener('pagehide', flushNow);
      window.removeEventListener('beforeunload', flushNow);
      flushNow();
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
  };
}

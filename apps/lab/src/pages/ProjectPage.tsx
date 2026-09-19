import { useCallback, useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  LoadingState,
  Stack,
  formatScore10,
  describeRaising,
} from '@unicorn/ui';
import type { InvestmentPassport, ProjectFull, ReadinessEntry } from '@unicorn/contracts';
import { ApiError, api } from '../api';
import { ProjectBadges } from '../App';
import { MaterialsCard } from './MaterialsCard';
import { AccessCard } from './AccessCard';
import { VisibilityCard } from './VisibilityCard';
import { PublicationConsentsCard } from './PublicationConsentsCard';
import { BillingCard } from './BillingCard';
import { ApplicationsCard } from '../wizard/ApplicationsCard';
import { ScoreProvenance } from '@unicorn/cabinet';

/**
 * Карта готовности по-человечески.
 *
 * До этого строка выглядела как «low business_model»: сначала английский
 * уровень, потом технический код измерения. Основатель по такой карте не может
 * понять, что именно у него слабое место — а карта существует ровно для этого.
 */
const READINESS_DIMENSION_TITLES: Record<string, string> = {
  problem: 'проблема',
  solution: 'решение',
  product: 'продукт',
  tech: 'технология',
  team: 'команда',
  market: 'рынок',
  competition: 'конкуренты',
  business_model: 'бизнес-модель',
  unit_economics: 'юнит-экономика',
  legal: 'юридическая часть',
  finance: 'финансы',
  pitch: 'презентация',
  data_room: 'комната данных',
};

const READINESS_LEVEL_TITLES: Record<string, string> = {
  low: 'слабо',
  medium: 'средне',
  high: 'сильно',
};

/** Оси оценки паспорта. Тот же принцип: в кабинете — слова, а не коды. */
const SCORE_AXIS_TITLES: Record<string, string> = {
  market: 'рынок',
  demand: 'спрос',
  competitive_edge: 'преимущество перед конкурентами',
  uniqueness: 'уникальность',
  profitability: 'прибыльность',
  presentation_quality: 'качество подачи',
  scalability: 'масштабируемость',
  investment_readiness: 'готовность к инвестициям',
  product_readiness: 'готовность продукта',
};

/**
 * Карточка проекта: состояние, действия и результат анализа.
 *
 * Все действия здесь — обращения к серверу, и ни одно из них не «предсказывает»
 * ответ: кнопка публикации листинга не проверяет подписку сама, потому что
 * условия публикации (действующий KYC, тариф по сумме запроса, активная
 * подписка) знает только сервер. Отказ показывается его же словами.
 */
export function ProjectPage({
  projectId,
  onBack,
  applicationV2 = false,
  onOpenApplication,
  onOpenRound,
}: {
  projectId: string;
  onBack: () => void;
  /** Флаг `lab.ui.application_v2`: показывать заявки и мастер (этап 4). */
  applicationV2?: boolean;
  onOpenApplication?: (applicationId: string) => void;
  onOpenRound?: (applicationId: string) => void;
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; project: ProjectFull }
    | { status: 'error'; message: string; traceId: string | null }
  >({ status: 'loading' });
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      setState({ status: 'ready', project: await api.projects.get(projectId) });
    } catch (error) {
      setState({
        status: 'error',
        message:
          error instanceof ApiError
            ? (error.problem?.detail ?? error.message)
            : 'Сервис недоступен',
        traceId: error instanceof ApiError ? error.traceId : null,
      });
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Действие с единообразной обработкой отказа: сервер объясняет причину сам. */
  const run = useCallback(
    async (key: string, action: () => Promise<unknown>, okText: string) => {
      setBusy(key);
      setNotice(null);
      try {
        await action();
        setNotice({ tone: 'ok', text: okText });
        await load();
      } catch (error) {
        setNotice({
          tone: 'error',
          text:
            error instanceof ApiError
              ? (error.problem?.detail ?? error.message)
              : 'Сервис недоступен',
        });
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  if (state.status === 'loading') return <LoadingState label="Загружаем проект" />;
  if (state.status === 'error') {
    return (
      <Stack>
        <Button variant="secondary" onClick={onBack}>
          ← К списку
        </Button>
        <ErrorState
          description={state.message}
          traceId={state.traceId}
          onRetry={() => void load()}
        />
      </Stack>
    );
  }

  const project = state.project;

  return (
    <Stack gap="var(--u-space-5)">
      <Button variant="secondary" onClick={onBack} style={{ justifySelf: 'start' }}>
        ← К списку
      </Button>

      <Card>
        <Stack>
          <ProjectBadges project={project} />
          <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>{project.title}</h1>
          {project.tagline ? (
            <span style={{ color: 'var(--u-text-muted)' }}>{project.tagline}</span>
          ) : null}
          <dl style={{ display: 'grid', gap: 'var(--u-space-2)', margin: 0 }}>
            <Row label="Привлечение">{describeRaising(project)}</Row>
            <Row label="Оценка платформы">
              {project.irs === null ? 'ещё не рассчитана' : formatScore10(project.irs)}
            </Row>
            <Row label="Версия заявки">
              {project.currentVersionId === null ? 'не подана' : 'снимок зафиксирован'}
            </Row>
          </dl>
        </Stack>
      </Card>

      {applicationV2 && onOpenApplication ? (
        <ApplicationsCard
          projectId={project.id}
          onOpen={onOpenApplication}
          onOpenRound={onOpenRound}
        />
      ) : null}

      {notice ? (
        <div
          role={notice.tone === 'error' ? 'alert' : 'status'}
          style={{
            padding: 'var(--u-space-3) var(--u-space-4)',
            borderRadius: 'var(--u-radius-md)',
            background:
              notice.tone === 'error' ? 'var(--u-danger-subtle)' : 'var(--u-success-subtle)',
            color: notice.tone === 'error' ? 'var(--u-danger)' : 'var(--u-success)',
          }}
        >
          {notice.text}
        </div>
      ) : null}

      <Card>
        <Stack>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Действия</h2>
          <div style={{ display: 'flex', gap: 'var(--u-space-3)', flexWrap: 'wrap' }}>
            {/* «Подать в сезон» убрана: сезонный контур отложен (M088);
                профиль подаётся мастером заявки без сезона. */}
            <Button
              variant="secondary"
              loading={busy === 'analysis'}
              onClick={() =>
                run('analysis', () => api.projects.runAnalysis(project.id), 'Анализ выполнен')
              }
            >
              Запустить анализ
            </Button>
          </div>
        </Stack>
      </Card>

      {/* Листинг с 5.7.3 — следствие режима «кто может видеть проект». */}
      <VisibilityCard project={project} onChanged={load} />

      {/* Выдача разрешений выбранным получателям (5.8) — рядом с режимом:
          режим решает, действует ли выданное. */}
      <AccessCard projectId={project.id} visibility={project.visibility} />

      <BillingCard projectId={project.id} requiredPlanId={project.requiredPlanId ?? null} />
      <MaterialsCard projectId={project.id} />
      <PassportCard projectId={project.id} />
      <ReadinessCard projectId={project.id} />
      <PublicationConsentsCard projectId={project.id} />
    </Stack>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--u-space-3)' }}>
      <dt style={{ color: 'var(--u-text-muted)', minWidth: 180 }}>{label}</dt>
      <dd style={{ margin: 0, fontWeight: 600 }}>{children}</dd>
    </div>
  );
}

/**
 * Инвестиционный паспорт. Отсутствие паспорта — законное состояние (анализ
 * ещё не запускался), и оно показывается словами, а не пустым местом.
 */
function PassportCard({ projectId }: { projectId: string }) {
  const [passport, setPassport] = useState<InvestmentPassport | null | 'loading' | 'error'>(
    'loading',
  );

  useEffect(() => {
    let cancelled = false;
    api.projects
      .passport(projectId)
      .then((value) => {
        if (!cancelled) setPassport(value);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // 404 — «паспорта ещё нет», а не сбой: анализ мог не запускаться.
        setPassport(error instanceof ApiError && error.status === 404 ? null : 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <Card>
      <Stack>
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Инвестиционный паспорт</h2>
        {passport === 'loading' ? <LoadingState label="Загружаем паспорт" /> : null}
        {passport === 'error' ? <ErrorState description="Паспорт недоступен" /> : null}
        {passport === null ? (
          <span style={{ color: 'var(--u-text-muted)' }}>
            Паспорта ещё нет. Он появится после первого прогона анализа.
          </span>
        ) : null}
        {passport && passport !== 'loading' && passport !== 'error' ? (
          <Stack gap="var(--u-space-3)">
            <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
              <Badge tone="accent">версия {passport.version}</Badge>
              <Badge>{passport.disclosureTier}</Badge>
              <ScoreProvenance
                passport={passport}
                modelVersion={passport.modelVersion ?? null}
                compact
              />
            </div>
            <ul style={{ margin: 0, paddingLeft: 'var(--u-space-5)' }}>
              {passport.scores.map((score) => (
                <li key={score.axis}>
                  <strong>{SCORE_AXIS_TITLES[score.axis] ?? score.axis}</strong>:{' '}
                  {formatScore10(score.value)}{' '}
                  <span style={{ color: 'var(--u-text-muted)' }}>
                    (интервал {formatScore10(score.confidenceLow)}–
                    {formatScore10(score.confidenceHigh)})
                  </span>{' '}
                  — {score.explanation}
                </li>
              ))}
            </ul>
          </Stack>
        ) : null}
      </Stack>
    </Card>
  );
}

function ReadinessCard({ projectId }: { projectId: string }) {
  const [items, setItems] = useState<ReadinessEntry[] | 'loading' | 'error'>('loading');

  useEffect(() => {
    let cancelled = false;
    api.projects
      .readiness(projectId)
      .then((value) => {
        if (!cancelled) setItems(value);
      })
      .catch(() => {
        if (!cancelled) setItems('error');
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  return (
    <Card>
      <Stack>
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Карта готовности</h2>
        {items === 'loading' ? <LoadingState label="Загружаем карту" /> : null}
        {items === 'error' ? <ErrorState description="Карта готовности недоступна" /> : null}
        {Array.isArray(items) && items.length === 0 ? (
          <span style={{ color: 'var(--u-text-muted)' }}>
            Карта появится после анализа: она строится по 13 измерениям заявки.
          </span>
        ) : null}
        {Array.isArray(items) && items.length > 0 ? (
          <ul
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'grid',
              gap: 'var(--u-space-2)',
            }}
          >
            {items.map((entry) => (
              <li key={entry.dimension} style={{ display: 'flex', gap: 'var(--u-space-3)' }}>
                <Badge
                  tone={
                    entry.level === 'high'
                      ? 'success'
                      : entry.level === 'low'
                        ? 'warning'
                        : 'neutral'
                  }
                >
                  {READINESS_LEVEL_TITLES[entry.level] ?? entry.level}
                </Badge>
                <span>{READINESS_DIMENSION_TITLES[entry.dimension] ?? entry.dimension}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Stack>
    </Card>
  );
}

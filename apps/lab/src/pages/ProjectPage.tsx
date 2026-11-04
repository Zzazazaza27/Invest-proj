import { useCallback, useEffect, useState } from 'react';
import { Button, Card, ErrorState, LoadingState, Stack, formatMoney } from '@fifth/ui';
import type { ProjectFull } from '@fifth/contracts';
import { ApiError, api } from '../api';
import { ProjectBadges } from '../App';
import { MaterialsCard } from './MaterialsCard';
import { AccessCard } from './AccessCard';
import { VisibilityCard } from './VisibilityCard';
import { MediaCard } from './MediaCard';

/**
 * Карточка проекта: состояние и управление видимостью, доступом и материалами.
 *
 * Все действия здесь — обращения к серверу, и ни одно из них не «предсказывает»
 * ответ: условия публикации листинга знает только сервер, отказ показывается
 * его же словами. Заявки, раунды, анализ ИИ, паспорт и согласия на публичный
 * контур удалены в 2.1-W05 — их здесь больше нет.
 */
export function ProjectPage({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; project: ProjectFull }
    | { status: 'error'; message: string; traceId: string | null }
  >({ status: 'loading' });
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
            <Row label="Запрос инвестиций">
              {formatMoney(project.investmentAsk, project.askCurrency)}
            </Row>
          </dl>
        </Stack>
      </Card>

      {/* Листинг с 5.7.3 — следствие режима «кто может видеть проект». */}
      <VisibilityCard project={project} onChanged={load} />

      {/* Выдача разрешений выбранным получателям (5.8) — рядом с режимом:
          режим решает, действует ли выданное. */}
      <AccessCard projectId={project.id} visibility={project.visibility} />

      <MediaCard projectId={project.id} />
      <MaterialsCard projectId={project.id} />
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

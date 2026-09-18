import { useEffect, useState } from 'react';
import {
  Badge,
  Card,
  ErrorState,
  LoadingState,
  Stack,
  describeRaising,
  formatMoney,
  raisingTone,
  type RaisingState,
} from '@unicorn/ui';
import type { ApplicationPreview } from '@unicorn/contracts';
import { ApiError, api } from '../api';
import { S } from '../strings';

/**
 * Предпросмотр-сводка (план 0.2 §2.11, этап 4.4): ровно те данные, которые
 * получит инвестор, собранные сервером по правилам видимости. Мастер их не
 * фильтрует и не дополняет — иначе предпросмотр перестал бы быть честным.
 */
export function PreviewPage({
  applicationId,
  refreshKey,
  raising,
}: {
  applicationId: string;
  /** Любое изменение ключа перечитывает сводку (после сохранения). */
  refreshKey?: string;
  /** Состояние привлечения — из раунда проекта; сумма заявки текущим запросом не считается. */
  raising?: { raising: RaisingState; investmentAsk: string | null; askCurrency?: string };
}) {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; preview: ApplicationPreview }
    | { status: 'error'; message: string; traceId: string | null }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api.applications
      .preview(applicationId)
      .then((preview) => {
        if (!cancelled) setState({ status: 'ready', preview });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: e instanceof ApiError ? (e.problem?.detail ?? e.message) : 'Сервис недоступен',
          traceId: e instanceof ApiError ? e.traceId : null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [applicationId, refreshKey]);

  if (state.status === 'loading') return <LoadingState label="Собираем предпросмотр" />;
  if (state.status === 'error') {
    return <ErrorState description={state.message} traceId={state.traceId} />;
  }
  const { preview } = state;

  return (
    <Card data-preview>
      <Stack gap="var(--u-space-4)">
        <div>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>{S.wizard.preview.title}</h2>
          <p
            style={{
              margin: '4px 0 0',
              color: 'var(--u-text-muted)',
              fontSize: 'var(--u-text-sm)',
            }}
          >
            {S.wizard.preview.note}
          </p>
        </div>

        <div
          style={{
            padding: 'var(--u-space-4)',
            borderRadius: 'var(--u-radius-lg)',
            border: '1px solid var(--u-border)',
            display: 'grid',
            gap: 'var(--u-space-2)',
          }}
        >
          <strong style={{ fontSize: 'var(--u-text-lg)' }}>{preview.project.title}</strong>
          {preview.project.tagline ? <span>{preview.project.tagline}</span> : null}
          <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
            <Badge tone="accent">
              {S.applications.stage[preview.core.stage] ?? preview.core.stage}
            </Badge>
            {raising ? (
              <Badge tone={raisingTone(raising.raising)}>{describeRaising(raising)}</Badge>
            ) : null}
            {preview.project.geoCountry ? <Badge>{preview.project.geoCountry}</Badge> : null}
          </div>
        </div>

        {preview.sections.length === 0 ? (
          <span style={{ color: 'var(--u-text-muted)' }}>{S.wizard.preview.empty}</span>
        ) : null}
        {preview.sections.map((section) => (
          <section key={section.key} style={{ display: 'grid', gap: 'var(--u-space-2)' }}>
            <h3 style={{ margin: 0, fontSize: 'var(--u-text-md)' }}>{section.title}</h3>
            <dl style={{ margin: 0, display: 'grid', gap: 'var(--u-space-2)' }}>
              {section.questions.map((q) => (
                <div key={q.key} data-preview-key={q.key}>
                  <dt style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
                    {q.label}
                  </dt>
                  <dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>
                    {q.type === 'money'
                      ? formatMoney(q.display, preview.core.askCurrency)
                      : q.display}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        {preview.withheld > 0 ? (
          <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
            {S.wizard.preview.withheld(preview.withheld)}
          </span>
        ) : null}
      </Stack>
    </Card>
  );
}

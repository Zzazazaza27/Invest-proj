import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  LoadingState,
  Stack,
  describeRaising,
  formatMoney,
  raisingTone,
} from '@unicorn/ui';
import type { ApplicationPreview, PreviewAudience } from '@unicorn/contracts';
import { ApiError, api } from '../api';
import { S } from '../strings';

/**
 * Предпросмотр-сводка (план 0.2 §2.11, этап 4.4): ровно те данные, которые
 * получит зритель выбранной аудитории, собранные сервером по правилам
 * видимости. Мастер их не фильтрует и не дополняет — иначе предпросмотр
 * перестал бы быть честным. Аудитория переключается: анонимный посетитель
 * или инвестор с доступом; проекция раунда (состояние, сумма, предмет)
 * приходит с сервера той же функцией, что питает каталог (M085).
 */
export function PreviewPage({
  applicationId,
  refreshKey,
}: {
  applicationId: string;
  /** Любое изменение ключа перечитывает сводку (после сохранения). */
  refreshKey?: string;
}) {
  const [audience, setAudience] = useState<PreviewAudience>('investors');
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'ready'; preview: ApplicationPreview }
    | { status: 'error'; message: string; traceId: string | null }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    api.applications
      .preview(applicationId, { audience })
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
  }, [applicationId, refreshKey, audience]);

  if (state.status === 'loading') return <LoadingState label="Собираем предпросмотр" />;
  if (state.status === 'error') {
    return <ErrorState description={state.message} traceId={state.traceId} />;
  }
  const { preview } = state;

  return (
    <Card data-preview data-preview-audience={preview.audience}>
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
          role="group"
          aria-label={S.wizard.preview.audienceLabel}
          style={{
            display: 'flex',
            gap: 'var(--u-space-2)',
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: 'var(--u-text-sm)', color: 'var(--u-text-muted)' }}>
            {S.wizard.preview.audienceLabel}:
          </span>
          {(['public', 'investors'] as const).map((a) => (
            <Button
              key={a}
              variant={audience === a ? 'brand' : 'secondary'}
              aria-pressed={audience === a}
              data-preview-audience-choice={a}
              style={{ minHeight: 32, padding: '0 var(--u-space-3)' }}
              onClick={() => setAudience(a)}
            >
              {S.wizard.preview.audience[a]}
            </Button>
          ))}
        </div>
        <p style={{ margin: 0, fontSize: 'var(--u-text-xs)', color: 'var(--u-text-muted)' }}>
          {S.wizard.preview.audienceNote}
        </p>

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
            <span data-preview-raising={preview.round.raising}>
              <Badge tone={raisingTone(preview.round.raising)}>
                {describeRaising({
                  raising: preview.round.raising,
                  investmentAsk: preview.round.investmentAsk,
                  askCurrency: preview.round.askCurrency ?? 'RUB',
                })}
              </Badge>
            </span>
            {preview.project.geoCountry ? <Badge>{preview.project.geoCountry}</Badge> : null}
          </div>
          {preview.round.fundingScope ? (
            <span style={{ fontSize: 'var(--u-text-sm)' }}>
              {S.wizard.preview.fundingScopeLabel}:{' '}
              {S.wizard.preview.fundingScope[preview.round.fundingScope] ??
                preview.round.fundingScope}
              {preview.round.fundingScopeNote ? ` — ${preview.round.fundingScopeNote}` : ''}
            </span>
          ) : null}
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

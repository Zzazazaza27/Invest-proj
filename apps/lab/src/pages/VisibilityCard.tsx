import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorState, LoadingState, Select, Stack } from '@unicorn/ui';
import type { PreviewAudience, ProjectFull, ViewPreview } from '@unicorn/contracts';
import { ApiError, api } from '../api';
import { S } from '../strings';

/**
 * «Кто может видеть проект» (5.7.4, план заявка-04 §3.1, §3.4).
 *
 * Карточка показывает три вещи, которые владелец должен видеть вместе:
 * режим (кому в принципе виден проект), согласие (по условиям какой версии
 * показываются ответы) и разницу — что станет видно дополнительно, если
 * применить активную версию. «Применить» несёт версию и отпечаток
 * содержимого из показанного предпросмотра: изменится что-то после
 * просмотра — сервер ответит 409, карточка перечитает предпросмотр.
 * Запрет кнопки серверную проверку не заменяет.
 */
export function VisibilityCard({
  project,
  onChanged,
}: {
  project: ProjectFull;
  /** После смены режима или применения условий — перечитать проект. */
  onChanged: () => Promise<void> | void;
}) {
  const [mode, setMode] = useState<ProjectFull['visibility']>(project.visibility);
  const [audience, setAudience] = useState<PreviewAudience>('investors');
  const [preview, setPreview] = useState<
    | { status: 'loading' }
    | { status: 'ready'; preview: ViewPreview }
    | { status: 'error'; message: string }
  >({ status: 'loading' });
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  useEffect(() => setMode(project.visibility), [project.visibility]);

  const load = useCallback(async () => {
    setPreview({ status: 'loading' });
    try {
      setPreview({
        status: 'ready',
        preview: await api.projects.viewPreview(project.id, { audience }),
      });
    } catch (e) {
      setPreview({
        status: 'error',
        message: e instanceof ApiError ? (e.problem?.detail ?? e.message) : 'Сервис недоступен',
      });
    }
  }, [project.id, audience]);

  useEffect(() => {
    void load();
  }, [load, project.visibility, project.disclosureFormVersion, project.disclosedVersionId]);

  const run = async (key: string, action: () => Promise<unknown>, okText: string) => {
    setBusy(key);
    setNotice(null);
    try {
      await action();
      setNotice({ tone: 'ok', text: okText });
      await onChanged();
      await load();
    } catch (e) {
      const stale = e instanceof ApiError && e.status === 409;
      setNotice({
        tone: 'error',
        text:
          (e instanceof ApiError ? (e.problem?.detail ?? e.message) : 'Сервис недоступен') +
          (stale ? ` ${S.visibility.stale}` : ''),
      });
      if (stale) await load();
    } finally {
      setBusy(null);
    }
  };

  const ready = preview.status === 'ready' ? preview.preview : null;
  const pendingCount = ready ? ready.pending.profile.length + ready.pending.round.length : 0;
  const canApply =
    ready !== null &&
    ready.consent.activeFormVersion !== null &&
    (ready.consent.formVersion !== null || ready.consent.roundId !== null) &&
    (ready.consent.formVersion !== ready.consent.activeFormVersion ||
      (ready.consent.roundId !== null &&
        ready.consent.roundDisclosureVersion !== ready.consent.activeFormVersion));

  return (
    <Card data-visibility-card data-visibility-mode={project.visibility}>
      <Stack>
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>{S.visibility.title}</h2>
        <p style={{ margin: 0, color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
          {S.visibility.note}
        </p>

        <div style={{ display: 'flex', gap: 'var(--u-space-3)', flexWrap: 'wrap' }}>
          <Select
            aria-label={S.visibility.title}
            value={mode}
            onChange={(e) => setMode(e.target.value as ProjectFull['visibility'])}
            style={{ minHeight: 40, flex: 1, minWidth: 260 }}
          >
            {(['private', 'public', 'registered_investors', 'selected_investors'] as const).map(
              (value) => (
                <option key={value} value={value}>
                  {S.visibility.modes[value]}
                </option>
              ),
            )}
          </Select>
          <Button
            data-visibility-save
            loading={busy === 'mode'}
            disabled={mode === project.visibility}
            onClick={() =>
              void run(
                'mode',
                () => api.projects.setVisibility(project.id, { visibility: mode }),
                S.visibility.saved,
              )
            }
          >
            {S.visibility.save}
          </Button>
        </div>

        {ready ? (
          <Stack gap="var(--u-space-2)">
            <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
              <Badge tone={ready.audienceSummary.anonymous ? 'success' : 'neutral'}>
                {S.visibility.summary.anonymous(ready.audienceSummary.anonymous)}
              </Badge>
              <Badge tone={ready.audienceSummary.investors === 'never' ? 'neutral' : 'success'}>
                {S.visibility.summary.investors[ready.audienceSummary.investors]}
              </Badge>
            </div>
            <p style={{ margin: 0, fontSize: 'var(--u-text-sm)' }} data-visibility-consent>
              {ready.consent.formVersion === null
                ? S.visibility.consent.none
                : S.visibility.consent.current(ready.consent.formVersion)}{' '}
              {ready.consent.roundId !== null && ready.consent.roundDisclosureVersion !== null
                ? S.visibility.consent.round(ready.consent.roundDisclosureVersion)
                : null}{' '}
              {canApply && ready.consent.activeFormVersion !== null
                ? S.visibility.consent.newer(ready.consent.activeFormVersion)
                : ready.consent.formVersion !== null
                  ? S.visibility.consent.upToDate
                  : null}
            </p>
            {pendingCount > 0 ? (
              <div data-visibility-pending>
                {ready.pending.profile.length > 0 ? (
                  <PendingList title={S.visibility.pending.profile} items={ready.pending.profile} />
                ) : null}
                {ready.pending.round.length > 0 ? (
                  <PendingList title={S.visibility.pending.round} items={ready.pending.round} />
                ) : null}
              </div>
            ) : null}
            {ready.evidenceConflicts.length > 0 ? (
              <p style={{ margin: 0, fontSize: 'var(--u-text-sm)', color: 'var(--u-warning)' }}>
                {S.visibility.conflicts} {ready.evidenceConflicts.map((c) => c.label).join(', ')}
              </p>
            ) : null}
            <div style={{ display: 'flex', gap: 'var(--u-space-3)', flexWrap: 'wrap' }}>
              <Button
                data-visibility-apply
                variant="secondary"
                loading={busy === 'apply'}
                disabled={!canApply}
                onClick={() =>
                  void run(
                    'apply',
                    () =>
                      api.projects.applyDisclosure(project.id, {
                        formVersion: ready.consent.activeFormVersion ?? 0,
                        roundId: ready.consent.roundId ?? undefined,
                        contentDigest: ready.contentDigest,
                      }),
                    S.visibility.applied,
                  )
                }
              >
                {S.visibility.apply}
              </Button>
            </div>

            <div style={{ display: 'flex', gap: 'var(--u-space-2)', alignItems: 'center' }}>
              <span style={{ fontSize: 'var(--u-text-sm)', color: 'var(--u-text-muted)' }}>
                {S.visibility.preview.title}:
              </span>
              {(['public', 'investors'] as const).map((a) => (
                <Button
                  key={a}
                  variant={audience === a ? 'brand' : 'secondary'}
                  data-visibility-audience={a}
                  aria-pressed={audience === a}
                  onClick={() => setAudience(a)}
                >
                  {S.visibility.preview[a]}
                </Button>
              ))}
            </div>
            <p
              style={{ margin: 0, fontSize: 'var(--u-text-sm)' }}
              data-visibility-preview={ready.view === null ? 'nothing' : 'view'}
            >
              {ready.view === null
                ? S.visibility.preview.nothing
                : S.visibility.preview.sections(
                    ready.view.sections.reduce((n, s) => n + s.questions.length, 0),
                    ready.view.withheld,
                  )}
            </p>
          </Stack>
        ) : null}
        {preview.status === 'loading' ? <LoadingState label="Считаем, кто что увидит" /> : null}
        {preview.status === 'error' ? (
          <ErrorState description={preview.message} onRetry={() => void load()} />
        ) : null}

        {notice ? (
          <div
            role={notice.tone === 'error' ? 'alert' : 'status'}
            style={{ color: notice.tone === 'error' ? 'var(--u-danger)' : 'var(--u-success)' }}
          >
            {notice.text}
          </div>
        ) : null}
      </Stack>
    </Card>
  );
}

function PendingList({
  title,
  items,
}: {
  title: string;
  items: ViewPreview['pending']['profile'];
}) {
  return (
    <div>
      <strong style={{ fontSize: 'var(--u-text-sm)' }}>{title}</strong>
      <ul style={{ margin: 0, paddingLeft: 'var(--u-space-5)', fontSize: 'var(--u-text-sm)' }}>
        {items.map((item) => (
          <li key={item.key}>
            {item.label} — {S.visibility.pending.audience[item.active] ?? item.active}
          </li>
        ))}
      </ul>
    </div>
  );
}

import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorState, LoadingState, Select, Stack } from '@unicorn/ui';
import { ProjectCard } from '@unicorn/cabinet';
import type { PreviewAudience, ProjectFull, ViewPreview } from '@unicorn/contracts';
import { ApiError, api } from '../api';
import { S } from '../strings';

/**
 * «Кто может видеть проект» (5.7.4).
 *
 * Карточка показывает вместе режим (кому в принципе виден проект) и
 * предпросмотр — что увидит выбранная аудитория. Согласия на показ ответов
 * анкеты и «применение новых условий раскрытия» удалены в 2.1-W05 вместе с
 * заявками: в карточке проекта остались только его собственные данные.
 */
export function VisibilityCard({
  project,
  onChanged,
}: {
  project: ProjectFull;
  /** После смены режима — перечитать проект. */
  onChanged: () => Promise<void> | void;
}) {
  const [mode, setMode] = useState<ProjectFull['visibility']>(project.visibility);
  const [audience, setAudience] = useState<PreviewAudience>('investors');
  const [preview, setPreview] = useState<
    | { status: 'loading' }
    | { status: 'ready'; preview: ViewPreview }
    | { status: 'error'; message: string }
  >({ status: 'loading' });
  const [busy, setBusy] = useState(false);
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
  }, [load, project.visibility]);

  const saveMode = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await api.projects.setVisibility(project.id, { visibility: mode });
      setNotice({ tone: 'ok', text: S.visibility.saved });
      await onChanged();
      await load();
    } catch (e) {
      setNotice({
        tone: 'error',
        text: e instanceof ApiError ? (e.problem?.detail ?? e.message) : 'Сервис недоступен',
      });
    } finally {
      setBusy(false);
    }
  };

  const ready = preview.status === 'ready' ? preview.preview : null;

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
            loading={busy}
            disabled={mode === project.visibility}
            onClick={() => void saveMode()}
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
            {ready.view === null ? (
              <p
                style={{ margin: 0, fontSize: 'var(--u-text-sm)' }}
                data-visibility-preview="nothing"
              >
                {S.visibility.preview.nothing}
              </p>
            ) : (
              /*
                Сама карточка — тот же компонент, которым показывают проект
                витрина и кабинет, и данные те же: серверная проекция для
                ВЫБРАННОЙ аудитории. Читалка документов здесь не открывается:
                предпросмотр отвечает на вопрос «что увидит аудитория».
              */
              <div data-visibility-preview="view" data-visibility-preview-card={audience}>
                <ProjectCard surface="preview" source={{ kind: 'investor', view: ready.view }} />
              </div>
            )}
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

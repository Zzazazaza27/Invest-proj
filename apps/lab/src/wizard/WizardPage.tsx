import { useMemo, useState } from 'react';
import { Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { Badge, Button, Card, ErrorState, LoadingState, Markdown, Stack } from '@unicorn/ui';
import type { ApplicationDetail, FormQuestionView } from '@unicorn/contracts';
import { ApiError, api } from '../api';
import { S } from '../strings';
import { QuestionField } from './QuestionField';
import { ReadinessPanel } from './ReadinessPanel';
import { PreviewPage } from './PreviewPage';
import { useApplication, type SaveState, type WizardData } from './useApplication';

/**
 * Пошаговый мастер заявки (этап 4, ранний прототип для проверки формы).
 *
 * Маршруты внутри мастера: вводный экран, раздел по ключу, предпросмотр.
 * Разделы, вопросы, состояния и тексты — из опубликованной конфигурации
 * той версии, на которой создана заявка; мастер ничего о вопросах не знает
 * и не решает, что показать, — он отражает форму с сервера. Подача не
 * требует ни сезона, ни анализа ИИ.
 */
export function WizardPage() {
  const { id = '' } = useParams();
  const app = useApplication(id);

  if (app.error) {
    return (
      <ErrorState
        description={app.error.message}
        traceId={app.error.traceId}
        onRetry={app.reload}
      />
    );
  }
  if (!app.data) return <LoadingState label="Загружаем заявку" />;
  const ready: App = { ...app, data: app.data };

  return (
    <Routes>
      <Route path="/" element={<IntroScreen app={ready} />} />
      <Route path="s/:sectionKey" element={<SectionScreen app={ready} />} />
      <Route path="preview" element={<PreviewScreen app={ready} />} />
      <Route path="*" element={<Navigate to="." replace />} />
    </Routes>
  );
}

type App = ReturnType<typeof useApplication> & { data: WizardData };

function sectionStatus(detail: ApplicationDetail, key: string) {
  return detail.readiness.sections.find((s) => s.key === key)?.status ?? 'hidden';
}

const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warning'> = {
  not_started: 'neutral',
  partial: 'accent',
  complete: 'success',
  attention: 'warning',
  hidden: 'neutral',
};

// ------------------------------------------------------------ каркас

function Frame({
  app,
  children,
  active,
}: {
  app: App;
  children: React.ReactNode;
  active?: string;
}) {
  const navigate = useNavigate();
  const { detail, form, project } = app.data;
  return (
    <Stack gap="var(--u-space-4)">
      <div
        style={{ display: 'flex', gap: 'var(--u-space-3)', alignItems: 'center', flexWrap: 'wrap' }}
      >
        <Button
          variant="secondary"
          onClick={() => navigate(`/projects/${detail.application.projectId}`)}
        >
          ← {S.wizard.nav.toProject}
        </Button>
        <div style={{ flex: 1, minWidth: 200 }}>
          <h1 style={{ margin: 0, fontSize: 'var(--u-text-xl)' }}>
            {S.wizard.title}: {project.title}
          </h1>
          <span style={{ color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
            {S.wizard.intro.versionNote(form.schemaVersion)}
          </span>
        </div>
        <SaveIndicator state={app.save} count={app.savedCount} />
      </div>
      <ReadinessPanel detail={detail} />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 260px) minmax(0, 1fr)',
          gap: 'var(--u-space-4)',
          alignItems: 'start',
        }}
        className="wizard-grid"
      >
        <style>{`@media (max-width: 720px) { .wizard-grid { grid-template-columns: 1fr !important; } }`}</style>
        <SectionNav app={app} active={active} />
        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
    </Stack>
  );
}

function SaveIndicator({ state, count }: { state: SaveState; count: number }) {
  const text =
    state.kind === 'saving' || state.kind === 'pending'
      ? S.wizard.save.saving
      : state.kind === 'saved'
        ? S.wizard.save.saved(
            state.at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
          )
        : state.kind === 'failed'
          ? `${S.wizard.save.failed}: ${state.message}`
          : S.wizard.save.idle;
  return (
    <span
      role="status"
      data-save-state={state.kind}
      data-save-count={count}
      style={{
        fontSize: 'var(--u-text-sm)',
        color: state.kind === 'failed' ? 'var(--u-danger)' : 'var(--u-text-muted)',
      }}
    >
      {text}
    </span>
  );
}

function SectionNav({ app, active }: { app: App; active?: string }) {
  const navigate = useNavigate();
  const { detail, form } = app.data;
  return (
    <Card style={{ padding: 'var(--u-space-3)' }} aria-label={S.wizard.nav.sections}>
      <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
        <li>
          <NavItem
            label={S.wizard.nav.toIntro}
            active={active === undefined}
            onClick={() => navigate(`/applications/${detail.application.id}`)}
          />
        </li>
        {form.sections.map((section, index) => {
          const status = sectionStatus(detail, section.key);
          return (
            <li key={section.key}>
              <NavItem
                label={`${index + 1}. ${section.title}`}
                badge={S.wizard.sectionStatus[status as keyof typeof S.wizard.sectionStatus]}
                tone={STATUS_TONE[status] ?? 'neutral'}
                active={active === section.key}
                onClick={() => navigate(`/applications/${detail.application.id}/s/${section.key}`)}
              />
            </li>
          );
        })}
        <li>
          <NavItem
            label={S.wizard.nav.toPreview}
            active={active === '__preview'}
            onClick={() => navigate(`/applications/${detail.application.id}/preview`)}
          />
        </li>
      </ol>
    </Card>
  );
}

function NavItem({
  label,
  badge,
  tone = 'neutral',
  active,
  onClick,
}: {
  label: string;
  badge?: string;
  tone?: 'neutral' | 'accent' | 'success' | 'warning';
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'step' : undefined}
      style={{
        width: '100%',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 'var(--u-space-2)',
        padding: 'var(--u-space-2) var(--u-space-3)',
        borderRadius: 'var(--u-radius-md)',
        border: 'none',
        background: active ? 'var(--u-accent-subtle, var(--u-border))' : 'transparent',
        color: 'var(--u-text)',
        fontFamily: 'inherit',
        fontSize: 'var(--u-text-sm)',
        fontWeight: active ? 700 : 500,
        textAlign: 'left',
        cursor: 'pointer',
      }}
    >
      <span>{label}</span>
      {badge ? <Badge tone={tone}>{badge}</Badge> : null}
    </button>
  );
}

// ------------------------------------------------------------ экраны

function IntroScreen({ app }: { app: App }) {
  const navigate = useNavigate();
  const { detail, form } = app.data;
  const first = form.sections[0];
  const answered = Object.values(detail.application.answers).some((v) => v !== null && v !== '');
  const counts = useMemo(() => {
    const all = form.sections.flatMap((s) => s.questions);
    return {
      mandatory: all.filter((q) => q.state === 'mandatory').length,
      recommended: all.filter((q) => q.state === 'recommended').length,
    };
  }, [form]);

  return (
    <Frame app={app}>
      <Card>
        <Stack gap="var(--u-space-4)">
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>{S.wizard.intro.headline}</h2>
          <p style={{ margin: 0 }}>{S.wizard.intro.body}</p>
          <p style={{ margin: 0, color: 'var(--u-text-muted)' }}>{S.wizard.intro.draftFree}</p>
          <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
            <Badge tone="accent">
              {S.wizard.levels.mandatory}: {counts.mandatory}
            </Badge>
            <Badge tone="neutral">
              {S.wizard.levels.recommended}: {counts.recommended}
            </Badge>
            <Badge tone="neutral">
              {S.applications.stage[detail.application.stage] ?? detail.application.stage}
            </Badge>
          </div>
          <p style={{ margin: 0, fontSize: 'var(--u-text-sm)', color: 'var(--u-text-muted)' }}>
            {S.wizard.levels.legend}
          </p>
          {form.schemaVersion === 0 ? (
            <p style={{ margin: 0, color: 'var(--u-warning)' }}>{S.wizard.intro.legacyNote}</p>
          ) : null}
          {first ? (
            <Button
              variant="brand"
              onClick={() => navigate(`/applications/${detail.application.id}/s/${first.key}`)}
            >
              {answered ? S.wizard.intro.resume : S.wizard.intro.start}
            </Button>
          ) : null}
        </Stack>
      </Card>
    </Frame>
  );
}

function SectionScreen({ app }: { app: App }) {
  const navigate = useNavigate();
  const { sectionKey = '' } = useParams();
  const { detail, form, project, materials } = app.data;
  const index = form.sections.findIndex((s) => s.key === sectionKey);
  if (index < 0) return <Navigate to={`/applications/${detail.application.id}`} replace />;
  const section = form.sections[index]!;
  const prev = form.sections[index - 1];
  const next = form.sections[index + 1];
  const status = sectionStatus(detail, section.key);

  return (
    <Frame app={app} active={section.key}>
      <Card>
        <Stack gap="var(--u-space-4)">
          <div
            style={{
              display: 'flex',
              gap: 'var(--u-space-3)',
              alignItems: 'baseline',
              flexWrap: 'wrap',
            }}
          >
            <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>
              {index + 1}. {section.title}
            </h2>
            <Badge tone={STATUS_TONE[status] ?? 'neutral'}>
              {S.wizard.sectionStatus[status as keyof typeof S.wizard.sectionStatus]}
            </Badge>
          </div>
          {section.introMd ? (
            <div style={{ color: 'var(--u-text-muted)' }}>
              <Markdown source={section.introMd} />
            </div>
          ) : null}
          {section.key === form.sections[0]?.key ? <ProjectFacts project={project} /> : null}
          {section.questions.map((question) => (
            <QuestionRow key={question.key} question={question} app={app} materials={materials} />
          ))}
          <div
            style={{
              display: 'flex',
              gap: 'var(--u-space-3)',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
            }}
          >
            <Button
              variant="secondary"
              onClick={() =>
                navigate(
                  prev
                    ? `/applications/${detail.application.id}/s/${prev.key}`
                    : `/applications/${detail.application.id}`,
                )
              }
            >
              ← {prev ? `${S.wizard.nav.back}: ${prev.title}` : S.wizard.nav.toIntro}
            </Button>
            <Button
              variant="brand"
              onClick={() =>
                navigate(
                  next
                    ? `/applications/${detail.application.id}/s/${next.key}`
                    : `/applications/${detail.application.id}/preview`,
                )
              }
            >
              {next ? `${S.wizard.nav.next}: ${next.title}` : S.wizard.nav.toPreview} →
            </Button>
          </div>
        </Stack>
      </Card>
    </Frame>
  );
}

/** Долгоживущие поля проекта: показываются, не спрашиваются заново (§7.3). */
function ProjectFacts({ project }: { project: WizardData['project'] }) {
  return (
    <dl
      style={{
        display: 'grid',
        gap: 'var(--u-space-1)',
        margin: 0,
        padding: 'var(--u-space-3)',
        background: 'var(--u-surface-muted, transparent)',
        border: '1px dashed var(--u-border)',
        borderRadius: 'var(--u-radius-md)',
        fontSize: 'var(--u-text-sm)',
      }}
    >
      <div>
        <dt style={{ display: 'inline', color: 'var(--u-text-muted)' }}>Название: </dt>
        <dd style={{ display: 'inline', margin: 0 }}>{project.title}</dd>
      </div>
      {project.tagline ? (
        <div>
          <dt style={{ display: 'inline', color: 'var(--u-text-muted)' }}>Коротко: </dt>
          <dd style={{ display: 'inline', margin: 0 }}>{project.tagline}</dd>
        </div>
      ) : null}
      <div>
        <dt style={{ display: 'inline', color: 'var(--u-text-muted)' }}>География: </dt>
        <dd style={{ display: 'inline', margin: 0 }}>
          {[project.geoCountry, project.geoRegion].filter(Boolean).join(', ') || 'не указана'}
        </dd>
      </div>
      <span style={{ color: 'var(--u-text-muted)' }}>
        Эти данные берутся из проекта и редактируются там.
      </span>
    </dl>
  );
}

/**
 * Вопрос с привязкой к данным: системные поля читаются из колонок заявки и
 * сохраняются сразу; ответы анкеты — из `answers` с автосохранением.
 */
function QuestionRow({
  question,
  app,
  materials,
}: {
  question: FormQuestionView;
  app: App;
  materials: WizardData['materials'];
}) {
  const { application } = app.data.detail;
  const [coreDraft, setCoreDraft] = useState<string | null>(null);

  if (question.coreField === 'funding_scope_note' && application.fundingScope !== 'direction') {
    return null;
  }

  if (question.coreField) {
    const value =
      question.coreField === 'stage'
        ? application.stage
        : question.coreField === 'business_type'
          ? application.businessType
          : question.coreField === 'funding_scope'
            ? application.fundingScope
            : question.coreField === 'funding_scope_note'
              ? application.fundingScopeNote
              : application.investmentAsk;
    const error = app.fieldErrors[question.key];
    const commit = (raw: unknown) => {
      switch (question.coreField) {
        case 'stage':
          return app.setCore({ stage: raw as 'idea' });
        case 'business_type':
          return app.setCore({ businessType: (raw as 'saas') ?? null });
        case 'funding_scope':
          return app.setCore({ fundingScope: raw as 'project' });
        case 'funding_scope_note':
          return app.setCore({ fundingScopeNote: (raw as string) ?? null });
        case 'investment_ask':
          return app.setCore({ investmentAsk: (raw as string) ?? null });
      }
      return Promise.resolve();
    };
    const isText = question.type === 'text' || question.type === 'money';
    return (
      <QuestionField
        question={question}
        value={isText && coreDraft !== null ? coreDraft : value}
        evidence={[]}
        materials={materials}
        error={error}
        onChange={(raw) => {
          if (isText) {
            setCoreDraft((raw as string | null) ?? '');
            return;
          }
          void commit(raw);
        }}
        onBlurCommit={
          isText
            ? () => {
                if (coreDraft === null) return;
                const next = coreDraft.trim() === '' ? null : coreDraft.trim();
                setCoreDraft(null);
                if (next !== value) void commit(next);
              }
            : undefined
        }
      />
    );
  }

  return (
    <QuestionField
      question={question}
      value={app.answers[question.key]}
      evidence={app.evidence[question.key] ?? []}
      materials={materials}
      error={app.fieldErrors[question.key]}
      onChange={(value) => app.setAnswer(question.key, value)}
      onEvidence={question.evidence ? (ids) => app.setEvidenceFor(question.key, ids) : undefined}
    />
  );
}

function PreviewScreen({ app }: { app: App }) {
  const navigate = useNavigate();
  const { detail } = app.data;
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const submit = async () => {
    setBusy(true);
    setNotice(null);
    try {
      await app.flush();
      const version = await api.applications.submit(detail.application.id);
      setNotice({ tone: 'ok', text: S.wizard.submit.done(version.versionNo) });
      await app.reload();
      window.setTimeout(() => navigate(`/projects/${detail.application.projectId}`), 1500);
    } catch (e) {
      setNotice({
        tone: 'error',
        text: e instanceof ApiError ? (e.problem?.detail ?? e.message) : 'Сервис недоступен',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame app={app} active="__preview">
      <Stack gap="var(--u-space-4)">
        <PreviewPage applicationId={detail.application.id} refreshKey={app.save.kind} />
        <Card>
          <Stack gap="var(--u-space-3)">
            <p style={{ margin: 0, color: 'var(--u-text-muted)', fontSize: 'var(--u-text-sm)' }}>
              {S.wizard.submit.confirm}
            </p>
            {!detail.submission.canSubmit ? (
              <p style={{ margin: 0, fontSize: 'var(--u-text-sm)' }}>{S.wizard.submit.blocked}</p>
            ) : null}
            {notice ? (
              <div
                role={notice.tone === 'error' ? 'alert' : 'status'}
                style={{ color: notice.tone === 'error' ? 'var(--u-danger)' : 'var(--u-success)' }}
              >
                {notice.text}
              </div>
            ) : null}
            <div style={{ display: 'flex', gap: 'var(--u-space-3)', flexWrap: 'wrap' }}>
              <Button
                variant="secondary"
                onClick={() =>
                  navigate(
                    `/applications/${detail.application.id}/s/${app.data.form.sections[0]?.key ?? ''}`,
                  )
                }
              >
                ← {S.wizard.preview.backToForm}
              </Button>
              <Button
                variant="brand"
                loading={busy}
                disabled={!detail.submission.canSubmit}
                onClick={() => void submit()}
              >
                {S.wizard.submit.button}
              </Button>
            </div>
          </Stack>
        </Card>
      </Stack>
    </Frame>
  );
}

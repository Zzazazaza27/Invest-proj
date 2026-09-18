import { useEffect, useState } from 'react';
import {
  Badge,
  Button,
  Card,
  ErrorState,
  Field,
  Input,
  LoadingState,
  Markdown,
  Select,
  Stack,
  formatMoney,
} from '@unicorn/ui';
import { sectionScope } from '@unicorn/contracts';
import type {
  ApplicationFormView,
  FormQuestionView,
  FundingRoundDetail,
  ProjectMaterial,
  RoundCloseReason,
  UpdateFundingRoundRequest,
} from '@unicorn/contracts';
import { ApiError } from '../api';
import { S } from '../strings';
import { QuestionField } from './QuestionField';
import { SaveIndicator } from './SaveIndicator';
import type { RoundHook } from './useRound';

/**
 * Экран раунда привлечения (этап 5.6.4, план 0.2 §0г).
 *
 * Здесь всё, что относится к раунду и не относится к профилю: параметры
 * (сумма, валюта, предмет, чек), вопросы разделов формы со scope=round,
 * готовность раунда, страна аккаунта с условиями рядом с суммой, основание
 * и явные переходы состояния. Профиль этим экраном не трогается.
 */
export function RoundScreen({
  round,
  form,
  materials,
  profileSubmitted,
}: {
  round: RoundHook;
  form: ApplicationFormView;
  materials: ProjectMaterial[];
  profileSubmitted: boolean;
}) {
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Профиль, страны, условия и версии нужны только здесь — грузим при входе.
  const { ensureContext } = round;
  useEffect(() => {
    void ensureContext();
  }, [ensureContext]);

  if (round.error) {
    return (
      <ErrorState
        description={round.error.message}
        traceId={round.error.traceId}
        onRetry={() => void round.reload()}
      />
    );
  }
  if (!round.data || !round.data.context) return <LoadingState label="Загружаем раунд" />;
  const { data } = round;
  const ctx = round.data.context;

  const run = async (key: string, action: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setNotice(null);
    try {
      await action();
      setNotice({ tone: 'ok', text: done });
    } catch (e) {
      const problem = e instanceof ApiError ? e.problem : null;
      const details = (problem?.errors ?? []).map((x) => x.message).join('; ');
      setNotice({
        tone: 'error',
        text:
          e instanceof ApiError
            ? `${problem?.detail ?? e.message}${details ? `: ${details}` : ''}`
            : 'Сервис недоступен',
      });
    } finally {
      setBusy(null);
    }
  };

  const noticeBlock = notice ? (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      data-round-notice={notice.tone}
      style={{ color: notice.tone === 'error' ? 'var(--u-danger)' : 'var(--u-success)' }}
    >
      {notice.text}
    </div>
  ) : null;

  const current = data.current;

  // --------------------------------------------------- раунда нет: предложить подготовку
  if (!current) {
    const last = data.rounds.find((r) => r.status === 'closed' || r.status === 'cancelled');
    return (
      <Card data-round-state="none">
        <Stack gap="var(--u-space-4)">
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>{S.round.prepare.headline}</h2>
          <p style={{ margin: 0 }}>{S.round.prepare.body}</p>
          {last?.status === 'closed' && last.closeReason ? (
            <p style={{ margin: 0, color: 'var(--u-text-muted)' }}>
              {S.round.intro.lastClosed(
                S.round.actions.closeReasons[last.closeReason] ?? last.closeReason,
              )}
            </p>
          ) : null}
          {noticeBlock}
          <div>
            <Button
              variant="brand"
              loading={busy === 'prepare'}
              onClick={() => void run('prepare', () => round.prepare(), S.round.state.draft)}
            >
              {S.round.prepare.button}
            </Button>
          </div>
        </Stack>
      </Card>
    );
  }

  const status = current.round.status;
  const finished = status === 'closed' || status === 'cancelled';
  const roundSections = form.sections.filter((s) => sectionScope(s) === 'round');

  return (
    <Stack gap="var(--u-space-4)">
      <Card data-round-state={status} data-round-id={current.round.id}>
        <Stack gap="var(--u-space-3)">
          <div
            style={{
              display: 'flex',
              gap: 'var(--u-space-3)',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)', flex: 1, minWidth: 200 }}>
              {S.round.title}
            </h2>
            <Badge tone={STATUS_TONE[status]}>{S.round.state[status] ?? status}</Badge>
            {!finished ? (
              <SaveIndicator
                state={round.save}
                count={round.savedCount}
                onRetry={round.retryNow}
                scope="round"
              />
            ) : null}
          </div>
          {data.sideRound ? <SideRound round={round} side={data.sideRound} /> : null}
          {finished ? (
            <p style={{ margin: 0, color: 'var(--u-text-muted)' }}>{S.round.actions.finished}</p>
          ) : null}
          <RoundReadiness detail={current} />
          {noticeBlock}
          <Actions
            round={round}
            detail={current}
            busy={busy}
            profileSubmitted={profileSubmitted}
            countryChosen={Boolean(ctx.me.serviceCountry)}
            run={run}
          />
        </Stack>
      </Card>

      {!finished ? <CountryCard round={round} busy={busy} run={run} /> : null}

      {!finished ? (
        <Card data-round-fields>
          <Stack gap="var(--u-space-4)">
            <h3 style={{ margin: 0, fontSize: 'var(--u-text-md)' }}>{S.round.fields.title}</h3>
            {roundSections.map((section) => (
              <Stack key={section.key} gap="var(--u-space-4)">
                {section.introMd ? (
                  <div style={{ color: 'var(--u-text-muted)' }}>
                    <Markdown source={section.introMd} />
                  </div>
                ) : null}
                {section.questions.map((question) => (
                  <RoundQuestion
                    key={question.key}
                    question={question}
                    round={round}
                    detail={current}
                    materials={materials}
                  />
                ))}
              </Stack>
            ))}
            <ExtraFields round={round} detail={current} />
          </Stack>
        </Card>
      ) : null}

      <BasisCard round={round} detail={current} busy={busy} run={run} />
    </Stack>
  );
}

const STATUS_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warning'> = {
  draft: 'accent',
  open: 'success',
  paused: 'warning',
  closed: 'neutral',
  cancelled: 'neutral',
};

type Run = (key: string, action: () => Promise<unknown>, done: string) => Promise<void>;

// --------------------------------------------------------------- готовность

function RoundReadiness({ detail }: { detail: FundingRoundDetail }) {
  const { readiness } = detail;
  if (detail.round.status !== 'draft') {
    return null;
  }
  return (
    <div
      data-round-readiness
      style={{
        display: 'grid',
        gap: 'var(--u-space-2)',
        padding: 'var(--u-space-3)',
        borderRadius: 'var(--u-radius-md)',
        border: '1px solid var(--u-border)',
        background: readiness.canOpen
          ? 'var(--u-success-subtle)'
          : 'var(--u-surface-muted, var(--u-surface))',
      }}
    >
      <div
        style={{ display: 'flex', gap: 'var(--u-space-3)', alignItems: 'center', flexWrap: 'wrap' }}
      >
        <Badge tone={readiness.canOpen ? 'success' : 'accent'}>
          {readiness.canOpen
            ? S.round.readiness.canOpen
            : S.round.readiness.left(readiness.missing.length)}
        </Badge>
        <strong style={{ fontSize: 'var(--u-text-sm)' }}>
          {S.round.readiness.percent(readiness.percent)}
        </strong>
      </div>
      {readiness.missing.length > 0 ? (
        <ul style={{ margin: 0, paddingLeft: '1.2em', fontSize: 'var(--u-text-sm)' }}>
          {readiness.missing.map((m) => (
            <li key={`${m.path}:${m.message}`}>{m.message}</li>
          ))}
        </ul>
      ) : null}
      <span style={{ fontSize: 'var(--u-text-xs)', color: 'var(--u-text-muted)' }}>
        {S.round.readiness.hint}
      </span>
    </div>
  );
}

// ----------------------------------------------------------------- действия

function Actions({
  round,
  detail,
  busy,
  profileSubmitted,
  countryChosen,
  run,
}: {
  round: RoundHook;
  detail: FundingRoundDetail;
  busy: string | null;
  profileSubmitted: boolean;
  countryChosen: boolean;
  run: Run;
}) {
  const [closeReason, setCloseReason] = useState<RoundCloseReason>('completed');
  const status = detail.round.status;
  const confirm = (text: string) => window.confirm(text);

  if (status === 'closed' || status === 'cancelled') {
    return (
      <div>
        <Button
          variant="brand"
          loading={busy === 'prepare'}
          onClick={() => void run('prepare', () => round.prepare(), S.round.state.draft)}
        >
          {S.round.intro.newRound}
        </Button>
      </div>
    );
  }

  return (
    <Stack gap="var(--u-space-2)">
      {status === 'draft' ? (
        <p style={{ margin: 0, fontSize: 'var(--u-text-sm)', color: 'var(--u-text-muted)' }}>
          {S.round.actions.openHint}
        </p>
      ) : null}
      <div
        style={{ display: 'flex', gap: 'var(--u-space-3)', flexWrap: 'wrap', alignItems: 'center' }}
      >
        {status === 'draft' ? (
          <>
            <Button
              variant="brand"
              data-round-open
              loading={busy === 'open'}
              disabled={!detail.readiness.canOpen || !profileSubmitted || !countryChosen}
              onClick={() => {
                if (!confirm(S.round.actions.confirmOpen)) return;
                void run('open', () => round.open(), S.round.actions.done.open);
              }}
            >
              {S.round.actions.open}
            </Button>
            <Button
              variant="secondary"
              loading={busy === 'cancel'}
              onClick={() => {
                if (!confirm(S.round.actions.confirmCancel)) return;
                void run('cancel', () => round.cancel(), S.round.actions.done.cancelled);
              }}
            >
              {S.round.actions.cancel}
            </Button>
          </>
        ) : null}
        {status === 'open' ? (
          <Button
            variant="secondary"
            loading={busy === 'pause'}
            onClick={() => {
              if (!confirm(S.round.actions.confirmPause)) return;
              void run('pause', () => round.pause(), S.round.actions.done.paused);
            }}
          >
            {S.round.actions.pause}
          </Button>
        ) : null}
        {status === 'paused' ? (
          <Button
            variant="brand"
            loading={busy === 'resume'}
            onClick={() => void run('resume', () => round.resume(), S.round.actions.done.resumed)}
          >
            {S.round.actions.resume}
          </Button>
        ) : null}
        {status === 'open' || status === 'paused' ? (
          <div
            style={{
              display: 'flex',
              gap: 'var(--u-space-2)',
              alignItems: 'center',
              flexWrap: 'wrap',
            }}
          >
            <Select
              aria-label={S.round.actions.closeReason}
              value={closeReason}
              onChange={(e) => setCloseReason(e.target.value as RoundCloseReason)}
              style={{ minHeight: 40 }}
            >
              {Object.entries(S.round.actions.closeReasons).map(([code, label]) => (
                <option key={code} value={code}>
                  {label}
                </option>
              ))}
            </Select>
            <Button
              variant="secondary"
              loading={busy === 'close'}
              onClick={() => {
                if (!confirm(S.round.actions.confirmClose)) return;
                void run('close', () => round.close(closeReason), S.round.actions.done.closed);
              }}
            >
              {S.round.actions.close}
            </Button>
          </div>
        ) : null}
      </div>
    </Stack>
  );
}

// ------------------------------------------------------- черновик рядом с открытым

function SideRound({ round, side }: { round: RoundHook; side: { id: string; status: string } }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 'var(--u-space-3)',
        alignItems: 'center',
        flexWrap: 'wrap',
        fontSize: 'var(--u-text-sm)',
        color: 'var(--u-text-muted)',
      }}
    >
      <span>
        {side.status === 'draft' ? S.round.prepare.sideDraft : S.round.prepare.sideUnfinished}
      </span>
      <Button
        variant="secondary"
        style={{ minHeight: 32, padding: '0 var(--u-space-3)' }}
        onClick={() => void round.select(side.id)}
      >
        {S.round.prepare.switchTo}
      </Button>
    </div>
  );
}

// ------------------------------------------------------------------- страна

function CountryCard({ round, busy, run }: { round: RoundHook; busy: string | null; run: Run }) {
  const [choice, setChoice] = useState<string>('');
  const ctx = round.data?.context;
  if (!ctx) return null;
  const chosen = ctx.me.serviceCountry;
  const policy = ctx.policy;
  const countries = ctx.countries;

  return (
    <Card data-round-country={chosen ?? 'none'}>
      <Stack gap="var(--u-space-3)">
        <h3 style={{ margin: 0, fontSize: 'var(--u-text-md)' }}>{S.round.country.title}</h3>
        {chosen ? (
          <div style={{ display: 'grid', gap: 'var(--u-space-1)', fontSize: 'var(--u-text-sm)' }}>
            <strong>
              {S.round.country.current(chosen)}
              {policy ? ` · ${S.round.country.policy(policy.version)}` : ''}
            </strong>
            {policy ? (
              <>
                <span>
                  {S.round.country.currencies(policy.config.allowedRoundCurrencies.join(', '))}
                </span>
                {policy.config.limits.maxTargetPerRound ? (
                  <span>
                    {S.round.country.maxTarget(
                      formatMoney(
                        policy.config.limits.maxTargetPerRound,
                        policy.config.baseCurrency,
                      ),
                    )}
                  </span>
                ) : null}
                {!policy.config.paidPackages.enabled && !policy.config.freeAttraction.enabled ? (
                  <span style={{ color: 'var(--u-text-muted)' }}>{S.round.country.free}</span>
                ) : null}
                {policy.config.operator.manualReviewRequired ? (
                  <span style={{ color: 'var(--u-text-muted)' }}>
                    {S.round.country.manualReview}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>
        ) : (
          <Stack gap="var(--u-space-2)">
            <p style={{ margin: 0, fontSize: 'var(--u-text-sm)', color: 'var(--u-text-muted)' }}>
              {S.round.country.why}
            </p>
            {countries.length === 0 ? (
              <span style={{ color: 'var(--u-warning)' }}>{S.round.country.noCountries}</span>
            ) : countries.length === 1 ? (
              <div>
                <Button
                  variant="brand"
                  loading={busy === 'country'}
                  onClick={() =>
                    void run(
                      'country',
                      () => round.chooseCountry(countries[0]!.code),
                      S.round.actions.done.country,
                    )
                  }
                >
                  {S.round.country.confirm(countries[0]!.code)}
                </Button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
                <Select
                  aria-label={S.round.country.title}
                  value={choice}
                  onChange={(e) => setChoice(e.target.value)}
                >
                  <option value="">{S.wizard.field.empty}</option>
                  {countries.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code.toUpperCase()}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="brand"
                  disabled={!choice}
                  loading={busy === 'country'}
                  onClick={() =>
                    void run(
                      'country',
                      () => round.chooseCountry(choice),
                      S.round.actions.done.country,
                    )
                  }
                >
                  {S.round.country.choose}
                </Button>
              </div>
            )}
          </Stack>
        )}
      </Stack>
    </Card>
  );
}

// ------------------------------------------------------------------ вопросы

/**
 * Вопрос раздела раунда. Системные поля формы (предмет финансирования, его
 * пояснение, сумма) читаются из РАУНДА, а не из заявки: сумма старой формы в
 * кеше проекта текущим запросом не считается (проверка 1 владельца).
 */
function RoundQuestion({
  question,
  round,
  detail,
  materials,
}: {
  question: FormQuestionView;
  round: RoundHook;
  detail: FundingRoundDetail;
  materials: ProjectMaterial[];
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const r = detail.round;

  if (question.coreField === 'funding_scope_note' && r.fundingScope !== 'direction') return null;

  if (question.coreField) {
    if (
      question.coreField !== 'funding_scope' &&
      question.coreField !== 'funding_scope_note' &&
      question.coreField !== 'investment_ask'
    ) {
      // Стадия и тип бизнеса — поля профиля; в разделе раунда им не место.
      return null;
    }
    const value =
      question.coreField === 'funding_scope'
        ? r.fundingScope
        : question.coreField === 'funding_scope_note'
          ? r.fundingScopeNote
          : r.target;
    const errorKey = question.coreField === 'investment_ask' ? 'target' : question.coreField;
    const commit = (raw: unknown) => {
      const patch: UpdateFundingRoundRequest =
        question.coreField === 'funding_scope'
          ? { fundingScope: (raw as 'project' | 'direction' | null) ?? null }
          : question.coreField === 'funding_scope_note'
            ? { fundingScopeNote: (raw as string | null) ?? null }
            : { target: (raw as string | null) ?? null };
      return round.setField(patch);
    };
    const isText = question.type === 'text' || question.type === 'money';
    return (
      <QuestionField
        question={question}
        value={isText && draft !== null ? draft : value}
        evidence={[]}
        materials={materials}
        error={round.fieldErrors[errorKey] ?? round.fieldErrors[question.key]}
        onChange={(raw) => {
          if (isText) {
            setDraft((raw as string | null) ?? '');
            return;
          }
          void commit(raw);
        }}
        onBlurCommit={
          isText
            ? () => {
                if (draft === null) return;
                const next = draft.trim() === '' ? null : draft.trim();
                setDraft(null);
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
      value={round.answers[question.key]}
      evidence={round.evidence[question.key] ?? []}
      materials={materials}
      error={round.fieldErrors[question.key]}
      onChange={(value) => round.setAnswer(question.key, value)}
      onEvidence={question.evidence ? (ids) => round.setEvidenceFor(question.key, ids) : undefined}
    />
  );
}

/** Параметры раунда, которых нет в конфигурации формы: валюта, формат сделки, чек, подтверждённое. */
function ExtraFields({ round, detail }: { round: RoundHook; detail: FundingRoundDetail }) {
  const r = detail.round;
  const currencies = round.data?.context?.policy?.config.allowedRoundCurrencies ?? ['RUB'];
  return (
    <div style={{ display: 'grid', gap: 'var(--u-space-3)' }}>
      <Field
        label={S.round.fields.currency}
        htmlFor="round-currency"
        error={round.fieldErrors.currency ?? null}
      >
        <Select
          id="round-currency"
          value={r.currency ?? ''}
          onChange={(e) =>
            void round.setField({ currency: e.target.value === '' ? null : e.target.value })
          }
        >
          <option value="">{S.wizard.field.empty}</option>
          {currencies.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={S.round.fields.investorMode}
        htmlFor="round-investor-mode"
        error={round.fieldErrors.investor_mode ?? null}
      >
        <Select
          id="round-investor-mode"
          value={r.investorMode ?? ''}
          onChange={(e) =>
            void round.setField({
              investorMode: e.target.value === '' ? null : (e.target.value as 'single'),
            })
          }
        >
          <option value="">{S.wizard.field.empty}</option>
          {Object.entries(S.round.fields.investorModes).map(([code, label]) => (
            <option key={code} value={code}>
              {label}
            </option>
          ))}
        </Select>
      </Field>
      <MoneyField
        id="round-ticket-min"
        label={S.round.fields.ticketMin}
        value={r.ticketMin}
        error={round.fieldErrors.ticket_min}
        onCommit={(v) => round.setField({ ticketMin: v })}
      />
      <MoneyField
        id="round-ticket-max"
        label={S.round.fields.ticketMax}
        value={r.ticketMax}
        error={round.fieldErrors.ticket_max}
        onCommit={(v) => round.setField({ ticketMax: v })}
      />
      <MoneyField
        id="round-committed"
        label={S.round.fields.committed}
        hint={S.round.fields.committedHint}
        value={r.committed}
        error={round.fieldErrors.committed}
        onCommit={(v) => round.setField({ committed: v ?? '0' })}
      />
    </div>
  );
}

function MoneyField({
  id,
  label,
  hint,
  value,
  error,
  onCommit,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string | null;
  error?: string;
  onCommit: (value: string | null) => Promise<void>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <Field label={label} htmlFor={id} hint={hint ?? S.round.fields.moneyHint} error={error ?? null}>
      <Input
        id={id}
        inputMode="decimal"
        value={draft !== null ? draft : (value ?? '')}
        placeholder="1000000.00"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft === null) return;
          const next = draft.trim() === '' ? null : draft.trim();
          setDraft(null);
          if (next !== value) void onCommit(next);
        }}
      />
    </Field>
  );
}

// --------------------------------------------------------------- основание

function BasisCard({
  round,
  detail,
  busy,
  run,
}: {
  round: RoundHook;
  detail: FundingRoundDetail;
  busy: string | null;
  run: Run;
}) {
  const [reason, setReason] = useState<string>(S.round.basis.reasonDefault);
  const versions = round.data?.context?.versions ?? [];
  const basis = versions.find((v) => v.id === detail.round.applicationVersionId) ?? null;
  const latest = versions[0] ?? null;
  const finished = detail.round.status === 'closed' || detail.round.status === 'cancelled';
  const newer = latest && (!basis || latest.versionNo > basis.versionNo) ? latest : null;

  return (
    <Card data-round-basis={basis?.versionNo ?? 'none'}>
      <Stack gap="var(--u-space-2)">
        <h3 style={{ margin: 0, fontSize: 'var(--u-text-md)' }}>{S.round.basis.title}</h3>
        {basis ? (
          <span style={{ fontSize: 'var(--u-text-sm)' }}>
            {S.round.basis.current(
              basis.versionNo,
              new Date(basis.submittedAt).toLocaleDateString('ru-RU'),
            )}
          </span>
        ) : (
          <span style={{ fontSize: 'var(--u-text-sm)', color: 'var(--u-text-muted)' }}>
            {S.round.basis.none}
          </span>
        )}
        {newer && !finished ? (
          <Stack gap="var(--u-space-2)">
            <span style={{ fontSize: 'var(--u-text-sm)' }}>
              {S.round.basis.newer(newer.versionNo)}
            </span>
            {basis ? (
              <Field label={S.round.basis.reason} htmlFor="round-basis-reason">
                <Input
                  id="round-basis-reason"
                  value={reason}
                  maxLength={500}
                  onChange={(e) => setReason(e.target.value)}
                />
              </Field>
            ) : null}
            <div>
              <Button
                variant="secondary"
                loading={busy === 'basis'}
                disabled={reason.trim().length < 3}
                onClick={() =>
                  void run(
                    'basis',
                    () => round.changeBasis(newer.id, reason.trim()),
                    S.round.actions.done.basis,
                  )
                }
              >
                {S.round.basis.update}
              </Button>
            </div>
          </Stack>
        ) : null}
        <span style={{ fontSize: 'var(--u-text-xs)', color: 'var(--u-text-muted)' }}>
          {S.round.basis.history}
        </span>
      </Stack>
    </Card>
  );
}

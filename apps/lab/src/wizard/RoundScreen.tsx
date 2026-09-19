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
  describeRaising,
  formatMoney,
  raisingTone,
} from '@unicorn/ui';
import { sectionScope } from '@unicorn/contracts';
import type {
  ApplicationFormView,
  FormQuestionView,
  FundingRoundDetail,
  ProjectMaterial,
  RoundCloseReason,
  RoundOpenPreview,
  PaymentView,
  ServiceRunAvailability,
  RoundPurchaseView,
  RoundQuote,
  ServiceCountryPolicyVersion,
  UpdateFundingRoundRequest,
} from '@unicorn/contracts';
import { ApiError, api } from '../api';
import { S } from '../strings';
import { MoneyControl } from './MoneyControl';
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
            : e instanceof Error && e.message
              ? e.message
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
  // Предпросмотр раскрытия перед открытием (5.7.4): открытие подтверждает
  // версию условий и отпечаток параметров именно показанного предпросмотра.
  const [seen, setSeen] = useState<RoundOpenPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewRefresh, setPreviewRefresh] = useState(0);
  useEffect(() => {
    if (status !== 'draft') return;
    let cancelled = false;
    setSeen(null);
    api.rounds
      .openPreview(detail.round.id)
      .then((p) => {
        if (!cancelled) {
          setSeen(p);
          setPreviewError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setPreviewError(
            e instanceof ApiError ? (e.problem?.detail ?? e.message) : 'Сервис недоступен',
          );
      });
    return () => {
      cancelled = true;
    };
  }, [status, detail.round.id, detail.round.updatedAt, previewRefresh]);

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
      {status === 'draft' ? (
        <OpenPreviewCard
          preview={seen}
          error={previewError}
          onRefresh={() => setPreviewRefresh((n) => n + 1)}
        />
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
              disabled={
                !detail.readiness.canOpen || !profileSubmitted || !countryChosen || seen === null
              }
              onClick={() => {
                if (!seen) return;
                // Не window.confirm: подтверждение — показанный предпросмотр.
                void run(
                  'open',
                  async () => {
                    try {
                      return await round.open({
                        confirmDisclosureVersion: seen.activeFormVersion,
                        contentDigest: seen.contentDigest,
                      });
                    } catch (e) {
                      // 409: условия или параметры изменились после просмотра —
                      // предпросмотр перечитывается, открытие — заново.
                      if (e instanceof ApiError && e.status === 409) {
                        setPreviewRefresh((n) => n + 1);
                        throw new Error(
                          `${e.problem?.detail ?? e.message} ${S.round.openPreview.stale}`,
                          { cause: e },
                        );
                      }
                      throw e;
                    }
                  },
                  S.round.actions.done.open,
                );
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

// ------------------------------------------------- предпросмотр перед открытием

/**
 * Что увидят после открытия — по активной версии условий для обеих аудиторий,
 * с фактической аудиторией по режиму проекта. Кнопка открытия подтверждает
 * именно этот предпросмотр (версия + отпечаток параметров).
 */
function OpenPreviewCard({
  preview,
  error,
  onRefresh,
}: {
  preview: RoundOpenPreview | null;
  error: string | null;
  onRefresh: () => void;
}) {
  const summary = preview?.audienceSummary;
  const audienceText = summary
    ? summary.mode === 'private'
      ? S.round.openPreview.audience.nobody
      : summary.mode === 'public'
        ? S.round.openPreview.audience.everyone
        : summary.mode === 'selected_investors'
          ? S.round.openPreview.audience.selected
          : summary.subscriptionRequired
            ? S.round.openPreview.audience.subscribed
            : S.round.openPreview.audience.registered
    : null;
  return (
    <Card data-open-preview={preview ? 'ready' : error ? 'error' : 'loading'}>
      <Stack gap="var(--u-space-2)">
        <h3 style={{ margin: 0, fontSize: 'var(--u-text-md)' }}>{S.round.openPreview.title}</h3>
        <p style={{ margin: 0, fontSize: 'var(--u-text-sm)', color: 'var(--u-text-muted)' }}>
          {S.round.openPreview.note}
        </p>
        {error ? <ErrorState description={error} onRetry={onRefresh} /> : null}
        {!preview && !error ? <LoadingState label={S.round.openPreview.title} /> : null}
        {preview ? (
          <>
            <span style={{ fontSize: 'var(--u-text-sm)' }} data-open-preview-version>
              {S.round.openPreview.version(preview.activeFormVersion)}
            </span>
            <div
              style={{
                display: 'grid',
                gap: 'var(--u-space-3)',
                gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              }}
            >
              <AudienceProjection
                title={S.round.openPreview.anonymous}
                audience="public"
                projection={preview.public}
              />
              <AudienceProjection
                title={S.round.openPreview.investors}
                audience="investors"
                projection={preview.investors}
              />
            </div>
            {audienceText ? (
              <span style={{ fontSize: 'var(--u-text-sm)' }} data-open-preview-audience>
                {audienceText}
              </span>
            ) : null}
            {preview.warnings.map((w) => (
              <span
                key={w}
                style={{ fontSize: 'var(--u-text-sm)', color: 'var(--u-warning)' }}
                data-open-preview-warning={w}
              >
                {S.round.openPreview.warnings[w]}
              </span>
            ))}
            <div>
              <Button variant="secondary" onClick={onRefresh}>
                {S.round.openPreview.refresh}
              </Button>
            </div>
          </>
        ) : null}
      </Stack>
    </Card>
  );
}

function AudienceProjection({
  title,
  audience,
  projection,
}: {
  title: string;
  audience: 'public' | 'investors';
  projection: RoundOpenPreview['public'];
}) {
  return (
    <div
      data-open-preview-projection={audience}
      data-open-preview-raising={projection.raising}
      style={{
        border: '1px solid var(--u-border)',
        borderRadius: 'var(--u-radius-md)',
        padding: 'var(--u-space-3)',
        display: 'grid',
        gap: 'var(--u-space-1)',
      }}
    >
      <strong style={{ fontSize: 'var(--u-text-sm)' }}>{title}</strong>
      <Badge tone={raisingTone(projection.raising)}>
        {describeRaising({ ...projection, askCurrency: projection.askCurrency ?? undefined })}
      </Badge>
      {projection.fundingScope ? (
        <span style={{ fontSize: 'var(--u-text-sm)', color: 'var(--u-text-muted)' }}>
          {S.wizard.preview.fundingScopeLabel}:{' '}
          {S.wizard.preview.fundingScope[projection.fundingScope]}
          {projection.fundingScopeNote ? ` — ${projection.fundingScopeNote}` : ''}
        </span>
      ) : null}
    </div>
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

/**
 * Стоимость запуска раунда (5.9.2).
 *
 * Показывается только тогда, когда деньги действительно появляются: условия
 * страны включили платные пакеты или бесплатную границу. При бесплатном
 * запуске блок не рисуется — иначе в кабинете постоянно висел бы раздел про
 * оплату, которой нет.
 *
 * Ничего не покупает: расчёт читается, кнопки оплаты здесь нет.
 */
function CostBlock({ round, policy }: { round: RoundHook; policy: ServiceCountryPolicyVersion }) {
  const roundId = round.data?.current?.round.id ?? null;
  const priced = policy.config.paidPackages.enabled || policy.config.freeAttraction.enabled;
  const [quote, setQuote] = useState<RoundQuote | null>(null);

  useEffect(() => {
    if (!roundId || !priced) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    void api.rounds
      .quote(roundId)
      .then((result) => {
        if (!cancelled) setQuote(result);
      })
      .catch(() => {
        // Молча: расчёт — справка. Отказ на самом действии объяснит причину.
        if (!cancelled) setQuote(null);
      });
    return () => {
      cancelled = true;
    };
  }, [roundId, priced]);

  if (!quote || quote.mode === 'free') return null;

  return (
    <div
      data-round-cost={quote.mode}
      style={{
        display: 'grid',
        gap: 'var(--u-space-1)',
        marginTop: 'var(--u-space-2)',
        paddingTop: 'var(--u-space-2)',
        borderTop: '1px solid var(--u-border)',
      }}
    >
      <strong>{S.round.cost.title}</strong>
      {quote.mode === 'blocked' ? (
        <>
          <span style={{ color: 'var(--u-warning)' }}>{S.round.cost.blocked}</span>
          {quote.blockers.map((blocker) => (
            <span key={`${blocker.path}:${blocker.message}`} style={{ color: 'var(--u-warning)' }}>
              {blocker.message}
            </span>
          ))}
        </>
      ) : (
        <>
          {quote.requiredPackage ? (
            <span>
              {S.round.cost.required(
                quote.requiredPackage.name,
                formatMoney(quote.requiredPackage.price, quote.requiredPackage.currency),
              )}
            </span>
          ) : null}
          {quote.chosenPackage ? (
            <span>
              {S.round.cost.chosen(
                quote.chosenPackage.name,
                formatMoney(quote.chosenPackage.price, quote.chosenPackage.currency),
              )}
            </span>
          ) : null}
          {quote.extraServices.map((service) => (
            <span key={service.code}>
              {S.round.cost.extra(service.name, formatMoney(service.price, service.currency))}
            </span>
          ))}
          <strong>{S.round.cost.total(formatMoney(quote.total, quote.currency))}</strong>
          {roundId ? <PurchaseBlock roundId={roundId} quote={quote} onQuote={setQuote} /> : null}
        </>
      )}
    </div>
  );
}

/**
 * Покупка запуска раунда (5.9.7).
 *
 * Здесь основатель выбирает пакет из НАЗНАЧЕННЫХ администратором замен,
 * докупает услуги, сохраняет выбор и оформляет покупку. Оплату принимает не
 * кабинет: покупка ждёт подтверждения платформы, и экран честно говорит, чего
 * не хватает для открытия раунда.
 */
function PurchaseBlock({
  roundId,
  quote,
  onQuote,
}: {
  roundId: string;
  quote: RoundQuote;
  onQuote: (quote: RoundQuote) => void;
}) {
  const [purchase, setPurchase] = useState<RoundPurchaseView | null>(null);
  const [payment, setPayment] = useState<PaymentView | null>(null);
  const [runs, setRuns] = useState<ServiceRunAvailability[]>([]);
  const [packageCode, setPackageCode] = useState<string>('');
  const [extras, setExtras] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.rounds
      .purchase(roundId)
      .then(async (result) => {
        if (cancelled) return;
        const found = 'id' in result ? result : null;
        setPurchase(found);
        if (found === null) return;
        // Состояние платежа читается отдельно и ничего не меняет: возврат со
        // страницы оплаты не должен ничего подтверждать.
        const view = await api.rounds.payment(found.id).catch(() => null);
        if (!cancelled) setPayment(view?.payment ?? null);
        const list = await api.rounds.serviceRuns(found.id).catch(() => null);
        if (!cancelled) setRuns(list?.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setPurchase(null);
      });
    return () => {
      cancelled = true;
    };
  }, [roundId]);

  const alternatives = quote.requiredPackage?.allowedAlternatives ?? [];

  async function save() {
    setBusy(true);
    try {
      const selection = { packageCode: packageCode || undefined, serviceCodes: extras };
      await api.rounds.saveSelection(roundId, selection);
      onQuote(await api.rounds.quote(roundId, selection));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? (e.problem?.detail ?? null) : 'Выбор не сохранён');
    } finally {
      setBusy(false);
    }
  }

  async function buy() {
    setBusy(true);
    try {
      setPurchase(await api.rounds.createPurchase(roundId));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? (e.problem?.detail ?? null) : 'Покупка не оформлена');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Запустить разбор по позиции.
   *
   * Повторное нажатие безопасно: второго исполнения не появится, вернётся
   * текущее состояние.
   */
  async function runService(itemId: string) {
    setBusy(true);
    try {
      await api.rounds.startServiceRun(itemId);
      if (purchase) {
        const list = await api.rounds.serviceRuns(purchase.id).catch(() => null);
        setRuns(list?.items ?? []);
        const fresh = await api.rounds.purchase(roundId).catch(() => null);
        if (fresh && 'id' in fresh) setPurchase(fresh);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? (e.problem?.detail ?? null) : 'Разбор не запущен');
    } finally {
      setBusy(false);
    }
  }

  /**
   * Начать оплату у оператора.
   *
   * Суммы здесь нет: её назначает сервер по покупке. Ответ приносит адрес
   * страницы оплаты — и состояние «ждём подтверждения», которое сам по себе
   * переход по адресу не меняет.
   */
  async function pay() {
    if (purchase === null) return;
    setBusy(true);
    try {
      setPayment(await api.rounds.startPayment(purchase.id, window.location.href));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? (e.problem?.detail ?? null) : 'Оплата не начата');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      data-round-purchase={purchase ? purchase.status : 'none'}
      style={{ display: 'grid', gap: 'var(--u-space-2)' }}
    >
      {error ? <span style={{ color: 'var(--u-danger)' }}>{error}</span> : null}

      {purchase === null ? (
        <>
          <label htmlFor="purchase-package">{S.round.cost.selectPackage}</label>
          <select
            id="purchase-package"
            value={packageCode}
            onChange={(e) => setPackageCode(e.target.value)}
          >
            <option value="">{S.round.cost.keepRequired}</option>
            {alternatives.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>

          {quote.extraServices.length > 0 || extras.length > 0 ? null : null}
          <label htmlFor="purchase-extras">{S.round.cost.extras}</label>
          <input
            id="purchase-extras"
            value={extras.join(',')}
            placeholder="коды услуг через запятую"
            onChange={(e) =>
              setExtras(
                e.target.value
                  .split(',')
                  .map((code) => code.trim())
                  .filter((code) => code.length > 0),
              )
            }
          />

          <div style={{ display: 'flex', gap: 'var(--u-space-2)', flexWrap: 'wrap' }}>
            <Button variant="secondary" loading={busy} onClick={() => void save()}>
              {S.round.cost.saveSelection}
            </Button>
            <Button variant="brand" loading={busy} onClick={() => void buy()}>
              {S.round.cost.buy}
            </Button>
          </div>
        </>
      ) : (
        <>
          <strong>{S.round.cost.purchaseTitle}</strong>
          <span>{S.round.cost.purchaseStatus(purchase.status)}</span>
          {purchase.isTestPayment ? (
            <span style={{ color: 'var(--u-warning)' }}>{S.round.cost.purchaseTest}</span>
          ) : null}
          {purchase.items.map((item) => (
            <span key={item.id} data-purchase-item={item.fulfillmentStatus}>
              {item.title} — {FULFILLMENT_TITLES[item.fulfillmentStatus]}
            </span>
          ))}
          {purchase.status === 'pending_payment' ? (
            <div data-round-payment={payment ? payment.status : 'none'}>
              {payment === null ? (
                <Button variant="brand" loading={busy} onClick={() => void pay()}>
                  {S.round.cost.pay}
                </Button>
              ) : (
                <>
                  <span>{S.round.cost.paymentPending}</span>
                  {payment.mode === 'test' ? (
                    <span style={{ color: 'var(--u-warning)' }}>{S.round.cost.paymentTest}</span>
                  ) : null}
                  {payment.redirectUrl ? (
                    <a href={payment.redirectUrl} data-payment-link>
                      {S.round.cost.paymentLink}
                    </a>
                  ) : null}
                  {payment.failureReason ? (
                    <span style={{ color: 'var(--u-danger)' }}>
                      {S.round.cost.paymentFailed(payment.failureReason)}
                    </span>
                  ) : null}
                </>
              )}
            </div>
          ) : null}

          {runs.length > 0 ? (
            <div data-service-runs>
              <strong>{S.round.cost.runsTitle}</strong>
              {runs.map((entry) => (
                <div key={entry.itemId} data-service-run={entry.run?.status ?? 'none'}>
                  {entry.run === null ? (
                    entry.canStart ? (
                      <Button
                        variant="secondary"
                        loading={busy}
                        onClick={() => void runService(entry.itemId)}
                      >
                        {S.round.cost.runStart}
                      </Button>
                    ) : (
                      <span>{S.round.cost.runBlocked(entry.blocker ?? '')}</span>
                    )
                  ) : (
                    <>
                      {entry.run.explanation.map((line) => (
                        <span
                          key={line}
                          style={
                            entry.run?.inputChangedSince && line.includes('изменилась')
                              ? { color: 'var(--u-warning)' }
                              : undefined
                          }
                        >
                          {line}
                        </span>
                      ))}
                      {entry.run.resultRef ? (
                        <span data-service-run-report>{S.round.cost.runReport}</span>
                      ) : null}
                    </>
                  )}
                </div>
              ))}
            </div>
          ) : null}

          <span
            data-purchase-blocker={purchase.openBlocker === null ? 'none' : 'blocked'}
            style={{ color: purchase.openBlocker ? 'var(--u-warning)' : 'var(--u-text-muted)' }}
          >
            {purchase.openBlocker ? S.round.cost.blocker(purchase.openBlocker) : S.round.cost.ready}
          </span>
        </>
      )}
    </div>
  );
}

const FULFILLMENT_TITLES: Record<string, string> = {
  planned: S.round.cost.itemPlanned,
  in_progress: S.round.cost.itemInProgress,
  fulfilled: S.round.cost.itemFulfilled,
  not_fulfilled: S.round.cost.itemNotFulfilled,
};

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
                <CostBlock round={round} policy={policy} />
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
    // Сумма ведёт собственный черновик внутри MoneyControl и отдаёт наружу
    // только разобранное значение, поэтому текстовый черновик ей не нужен.
    const isText = question.type === 'text';
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
        allowZero
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
  allowZero,
  onCommit,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string | null;
  error?: string;
  /** Ноль осмыслен (подтверждённые обязательства), в остальных полях — нет. */
  allowZero?: boolean;
  onCommit: (value: string | null) => Promise<void>;
}) {
  // Ошибка разбора относится к тому, что в поле сейчас, и потому важнее
  // серверной: та описывает последнее отправленное значение.
  const [inputError, setInputError] = useState<string | null>(null);
  return (
    <Field
      label={label}
      htmlFor={id}
      hint={hint ?? S.round.fields.moneyHint}
      error={inputError ?? error ?? null}
    >
      <MoneyControl
        id={id}
        value={value}
        allowZero={allowZero}
        describedBy={`${id}-hint`}
        onError={setInputError}
        onCommit={(next) => void onCommit(next)}
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

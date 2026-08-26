import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { AiProviderCredential, AiProviderModels, FeatureFlag } from '@unicorn/contracts';
import { PromptDialog } from '@unicorn/ui';
import { api } from '../api';
import { formatDate, problemText } from '../lib/format';
import { ServiceAccountsSection } from './AccessPage';

/**
 * Интеграции: всё, чем платформа связана с внешними системами, в одном месте.
 *
 * Три вкладки:
 *  * «Подключённые API» — внешние продукты, к которым платформа ходит со своим
 *    ключом (сейчас — провайдеры LLM для ИИ-скоринга). Названия продуктов,
 *    вертикаль, отпечаток ключа; добавление и отзыв.
 *  * «Клиенты Integration API» — внешние системы, которые ходят К платформе:
 *    прежний блок с экрана «Доступ».
 *  * «ИИ-скоринг» — состояние включения и порядок запуска.
 *
 * Ключ провайдера и состояние включения.
 *
 * Здесь оператор делает три вещи и только их: задаёт ключ провайдера, проверяет,
 * что ключ рабочий, и видит, можно ли включать скоринг моделью. Сам флаг
 * включения живёт в «Функциях платформы» — сервер не даст включить его без
 * активного ключа и зелёного eval-гейта (ADR-008 §6), и эта страница честно
 * показывает, чего не хватает.
 *
 * Ключ вводится один раз и обратно не читается: в списке — отпечаток, модель,
 * кто и когда задал. Адрес провайдера не задаётся вовсе — он в политике шлюза.
 */

/**
 * Вертикаль продукта: к какому контуру платформы он относится. Список
 * продуктов закрытый (CHECK в M066 и политика шлюза); новая вертикаль —
 * платежи, KYC-провайдер, почта — добавляется миграцией вместе с продуктом.
 */
const PRODUCT_VERTICALS: Record<string, string> = {
  yandex_gpt: 'ИИ-скоринг',
  gigachat: 'ИИ-скоринг',
  anthropic: 'ИИ-скоринг',
  openai: 'ИИ-скоринг',
  kimi: 'ИИ-скоринг',
  qwen: 'ИИ-скоринг',
  deepseek: 'ИИ-скоринг',
};

const PROVIDER_TITLES: Record<string, string> = {
  yandex_gpt: 'YandexGPT (РФ)',
  gigachat: 'GigaChat (РФ)',
  anthropic: 'Claude (Anthropic, США)',
  openai: 'OpenAI (США)',
  kimi: 'Kimi (Moonshot AI, КНР)',
  qwen: 'Qwen (Alibaba Cloud, КНР)',
  deepseek: 'DeepSeek (КНР)',
};

const MODEL_HINTS: Record<string, string> = {
  yandex_gpt: 'например gpt://<folder-id>/yandexgpt/latest',
  gigachat: 'например GigaChat или GigaChat-Pro',
  anthropic: 'например claude-sonnet-4-5',
  openai: 'например gpt-4o',
  kimi: 'например kimi-k3 или kimi-k2.5',
  qwen: 'например qwen-plus или qwen-max',
  deepseek: 'например deepseek-v4-flash или deepseek-v4-pro',
};

type Tab = 'apis' | 'clients' | 'scoring';

export function IntegrationsPage() {
  const [tab, setTab] = useState<Tab>('apis');
  return (
    <>
      <h1>Интеграции</h1>
      <p className="page-hint">
        Внешние продукты, к которым ходит платформа, и внешние системы, которые ходят к ней. Ключи
        хранятся зашифрованными и обратно не читаются: в списках только отпечатки.
      </p>
      <div className="row-actions" role="tablist" aria-label="Разделы интеграций">
        <TabButton active={tab === 'apis'} onClick={() => setTab('apis')}>
          Подключённые API
        </TabButton>
        <TabButton active={tab === 'clients'} onClick={() => setTab('clients')}>
          Клиенты Integration API
        </TabButton>
        <TabButton active={tab === 'scoring'} onClick={() => setTab('scoring')}>
          ИИ-скоринг
        </TabButton>
      </div>
      {tab === 'apis' ? <ConnectedApisSection /> : null}
      {tab === 'clients' ? <ServiceAccountsSection /> : null}
      {tab === 'scoring' ? <AiScoringStatusSection /> : null}
    </>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={active ? 'btn--sm' : 'btn--ghost btn--sm'}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

/** Состояние включения ИИ-скоринга и порядок запуска. */
function AiScoringStatusSection() {
  const [flags, setFlags] = useState<FeatureFlag[] | null>(null);
  const [items, setItems] = useState<AiProviderCredential[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.featureFlags(), api.aiCredentials()])
      .then(([featureFlags, credentials]) => {
        setFlags(featureFlags);
        setItems(credentials.items);
      })
      .catch((err: unknown) => setError(problemText(err, 'Не удалось загрузить состояние')));
  }, []);

  const llmFlag = flags?.find((f) => f.key === 'ai.scoring.llm.enabled');
  const scoringFlag = flags?.find((f) => f.key === 'ai.scoring.enabled');
  const active = items?.find((i) => i.isActive) ?? null;

  return (
    <div className="card">
      <h2>Состояние ИИ-скоринга</h2>
      {error && <div className="alert alert--error">{error}</div>}
      <table>
        <tbody>
          <tr>
            <td>Скоринг эвристикой</td>
            <td>
              <span className={`badge ${scoringFlag?.enabled ? 'badge--ok' : 'badge--muted'}`}>
                {scoringFlag?.enabled ? 'включён' : 'выключен'}
              </span>
            </td>
          </tr>
          <tr>
            <td>Скоринг моделью (LLM)</td>
            <td>
              <span className={`badge ${llmFlag?.enabled ? 'badge--ok' : 'badge--muted'}`}>
                {llmFlag?.enabled ? 'включён' : 'выключен'}
              </span>
              <span className="small muted"> · переключается в «Функциях платформы»</span>
            </td>
          </tr>
          <tr>
            <td>Активный провайдер</td>
            <td>
              {active
                ? `${PROVIDER_TITLES[active.provider] ?? active.provider} · модель ${active.modelName ?? 'по умолчанию'}`
                : 'не задан'}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="small muted">
        Порядок включения: задать ключ во вкладке «Подключённые API» → «Проверить» → прогнать
        eval-гейт (<code>node scripts/eval-ai-scoring.mjs</code>) → включить флаг{' '}
        <code>ai.scoring.llm.enabled</code>. Пока гейт не зелёный, анализ идёт эвристикой — это
        состояние продукта, а не незавершённая работа.
      </p>
    </div>
  );
}

/**
 * Отказ проверки — словами оператора. Код шлюза говорит, ГДЕ сломалось, код
 * провайдера — ЧТО: 400 у OpenAI-совместимых API почти всегда «нет такой
 * модели», 429 — лимит или нулевой баланс. Тело ответа провайдера сюда не
 * доходит намеренно (в нём бывает эхо запроса) — только код.
 */
function checkFailureText(provider: string, code?: string, upstreamStatus?: number | null) {
  const hint = MODEL_HINTS[provider] ?? '';
  switch (code) {
    case 'provider_auth':
      return `Провайдер отклонил ключ (${upstreamStatus ?? '401/403'}): ключ неверный, отозван или без прав на модель.`;
    case 'provider_http_error':
      if (upstreamStatus === 400 || upstreamStatus === 404) {
        return `Провайдер ответил ${upstreamStatus}: чаще всего неверное имя модели (${hint}). Задай ключ заново с правильной моделью.`;
      }
      if (upstreamStatus === 429) {
        return 'Провайдер ответил 429: лимит запросов или исчерпан баланс.';
      }
      return `Провайдер ответил ${upstreamStatus ?? 'ошибкой'}; подробности — в журнале шлюза.`;
    case 'provider_unreachable':
      return 'Провайдер недоступен по сети со стороны платформы.';
    case 'provider_timeout':
      return 'Провайдер не ответил за отведённое время.';
    case 'policy_rejected':
      return 'Политика шлюза отклонила провайдера — см. ai-policy.json.';
    default:
      return `Провайдер не принял ключ: ${code ?? 'причина не названа'}.`;
  }
}

/** Подключённые API: внешние продукты с ключами платформы. */
function ConnectedApisSection() {
  const [items, setItems] = useState<AiProviderCredential[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [provider, setProvider] = useState('yandex_gpt');
  const [apiKey, setApiKey] = useState('');
  const [modelName, setModelName] = useState('');
  // Каталог моделей провайдера, полученный по введённому ключу: пока он открыт,
  // ключ живёт в состоянии страницы и уходит вместе с выбранной моделью.
  const [picker, setPicker] = useState<AiProviderModels | null>(null);
  const [reason, setReason] = useState('');
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const credentials = await api.aiCredentials();
      setItems(credentials.items);
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить состояние ИИ-скоринга'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Шаг 1: по введённому ключу спросить у провайдера его каталог моделей и
   * открыть выбор. Имя модели, набранное руками, провайдер отвергает кодом 400
   * уже на первом анализе — поэтому выбор из каталога, а не поле ввода.
   */
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy('models');
    setError(null);
    setNotice(null);
    try {
      const catalog = await api.aiProviderModels({
        provider: provider as AiProviderCredential['provider'],
        apiKey,
      });
      setModelName(catalog.models[0] ?? '');
      setPicker(catalog);
    } catch (err) {
      setError(problemText(err, 'Не удалось получить список моделей'));
    } finally {
      setBusy(null);
    }
  }

  /** Шаг 2: сохранить ключ с выбранной моделью. */
  async function saveWithModel(chosen: string) {
    setBusy('save');
    setError(null);
    setNotice(null);
    try {
      const saved = await api.upsertAiCredential({
        provider: provider as AiProviderCredential['provider'],
        apiKey,
        modelName: chosen.trim() || undefined,
        reason,
      });
      setPicker(null);
      // Ключ из состояния страницы стирается сразу: он больше нигде не нужен.
      setApiKey('');
      setReason('');
      setNotice(
        `Ключ ${PROVIDER_TITLES[saved.provider] ?? saved.provider} сохранён, отпечаток ${saved.keyFingerprint}.`,
      );
      await load();
    } catch (err) {
      setError(problemText(err, 'Ключ не сохранён'));
    } finally {
      setBusy(null);
    }
  }

  async function check(item: AiProviderCredential) {
    setBusy(`check:${item.provider}`);
    setError(null);
    setNotice(null);
    try {
      const result = await api.checkAiCredential(item.provider);
      setNotice(
        result.ok
          ? `Провайдер ответил за ${Math.round(result.durationMs)} мс, модель ${result.model ?? '—'}.`
          : checkFailureText(item.provider, result.code, result.upstreamStatus),
      );
      await load();
    } catch (err) {
      setError(problemText(err, 'Проверка не выполнена'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}

      <div className="card">
        <h2>Подключить продукт</h2>
        <form onSubmit={(event) => void submit(event)} className="grid-2">
          <label className="field" htmlFor="ai-provider">
            <span>Провайдер</span>
            <select
              id="ai-provider"
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
            >
              {Object.entries(PROVIDER_TITLES).map(([value, title]) => (
                <option key={value} value={value}>
                  {title}
                </option>
              ))}
            </select>
          </label>
          <label className="field" htmlFor="ai-key">
            <span>API-ключ</span>
            <input
              id="ai-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              minLength={8}
              maxLength={512}
              required
            />
          </label>
          <label className="field" htmlFor="ai-reason">
            <span>Основание (в журнал)</span>
            <input
              id="ai-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Например, договор с провайдером № …"
              minLength={3}
              maxLength={500}
              required
            />
          </label>
          <div className="row-actions">
            <button type="submit" className="btn--sm" disabled={busy !== null}>
              {busy === 'models' ? 'Запрашиваем модели…' : 'Далее: выбрать модель'}
            </button>
          </div>
        </form>
        <ModelPickerDialog
          picker={picker}
          providerTitle={PROVIDER_TITLES[provider] ?? provider}
          hint={MODEL_HINTS[provider] ?? ''}
          value={modelName}
          busy={busy === 'save'}
          onChange={setModelName}
          onConfirm={() => void saveWithModel(modelName)}
          onCancel={() => setPicker(null)}
        />
        <p className="small muted">
          После ввода ключа платформа запросит у провайдера список его моделей и предложит выбор;
          если каталога у провайдера нет, будут подсказки из политики шлюза. Новый ключ становится
          активным и снимает активность с прежнего: активный провайдер на платформе один. Зарубежные
          модели (OpenAI, Claude, Kimi, Qwen, DeepSeek) по классам данных не ограничены — решение
          владельца от 26.08.2026 (ADR-008 §7); адреса провайдеров задаются только в политике шлюза.
        </p>
      </div>

      <div className="card">
        <h2>Подключённые продукты</h2>
        {items === null && <div className="spinner">Загрузка…</div>}
        {items !== null && items.length === 0 && (
          <p className="muted">
            Подключённых продуктов нет. Анализ идёт эвристикой внутри контура.
          </p>
        )}
        {items !== null && items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Продукт</th>
                <th>Вертикаль</th>
                <th>Модель</th>
                <th>Ключ (отпечаток)</th>
                <th>Состояние</th>
                <th>Задан</th>
                <th>Проверка</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.provider}>
                  <td>{PROVIDER_TITLES[item.provider] ?? item.provider}</td>
                  <td>{PRODUCT_VERTICALS[item.provider] ?? '—'}</td>
                  <td>{item.modelName ?? <span className="muted">по умолчанию</span>}</td>
                  <td>
                    <code>{item.keyFingerprint}</code>
                  </td>
                  <td>
                    <span className={`badge ${item.isActive ? 'badge--ok' : 'badge--muted'}`}>
                      {item.isActive ? 'активен' : 'не активен'}
                    </span>
                  </td>
                  <td className="small">{formatDate(item.setAt)}</td>
                  <td className="small">
                    {item.lastCheckedAt === null
                      ? 'не проверялся'
                      : `${item.lastCheckOk ? 'ок' : 'отказ'} · ${formatDate(item.lastCheckedAt)}`}
                  </td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn--sm"
                        disabled={busy !== null}
                        onClick={() => void check(item)}
                      >
                        {busy === `check:${item.provider}` ? 'Проверяем…' : 'Проверить'}
                      </button>
                      <button
                        type="button"
                        className="btn--danger btn--sm"
                        disabled={busy !== null}
                        onClick={() => setRevoking(item.provider)}
                      >
                        Отозвать
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <PromptDialog
        open={revoking !== null}
        title={
          revoking ? `Отозвать ключ: ${PROVIDER_TITLES[revoking] ?? revoking}` : 'Отозвать ключ'
        }
        description="Ключ удаляется из хранилища, факт остаётся в журнале. Если LLM-скоринг включён, следующий анализ откажет — выключите флаг заранее."
        label="Основание"
        confirmText="Отозвать"
        onCancel={() => setRevoking(null)}
        onConfirm={(text) => {
          const target = revoking;
          setRevoking(null);
          if (!target) return;
          setBusy(`revoke:${target}`);
          void api
            .revokeAiCredential(target, text)
            .then(() => {
              setNotice('Ключ отозван.');
              return load();
            })
            .catch((err: unknown) => setError(problemText(err, 'Ключ не отозван')))
            .finally(() => setBusy(null));
        }}
      />
    </>
  );
}

/**
 * Выбор модели после ввода ключа. Список — из каталога провайдера (или
 * подсказки политики, если каталога нет); ручной ввод остаётся запасным
 * путём для модели, которой в каталоге ещё нет. Диалог свой, а не
 * `window.prompt`, по тем же причинам, что и PromptDialog в @unicorn/ui.
 */
function ModelPickerDialog({
  picker,
  providerTitle,
  hint,
  value,
  busy,
  onChange,
  onConfirm,
  onCancel,
}: {
  picker: AiProviderModels | null;
  providerTitle: string;
  hint: string;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const open = picker !== null;
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!picker) return null;
  const fromList = picker.models.includes(value);
  const trimmed = value.trim();

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'grid',
        placeItems: 'center',
        padding: 'var(--u-space-4)',
        background: 'rgba(0, 0, 0, 0.45)',
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-label={`Модель для ${providerTitle}`}
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed) onConfirm();
        }}
        style={{
          width: 'min(32rem, 100%)',
          display: 'grid',
          gap: 'var(--u-space-4)',
          padding: 'var(--u-space-5)',
          borderRadius: 'var(--u-radius-lg)',
          border: '1px solid var(--u-border)',
          background: 'var(--u-surface)',
          boxShadow: 'var(--u-shadow-lg, 0 24px 60px rgba(0,0,0,0.35))',
        }}
      >
        <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)' }}>Модель для {providerTitle}</h2>
        <p className="small muted" style={{ margin: 0 }}>
          {picker.ok
            ? picker.source === 'provider'
              ? `Каталог провайдера: ${picker.models.length} моделей.`
              : 'У провайдера нет каталога моделей — ниже подсказки из политики шлюза.'
            : `Каталог не получен (${picker.code ?? 'ошибка'}${
                picker.upstreamStatus ? `, ответ ${picker.upstreamStatus}` : ''
              }) — ключ может быть неверным. Модель можно ввести вручную.`}
        </p>
        {picker.models.length > 0 ? (
          <label className="field" htmlFor="ai-model-pick">
            <span>Из списка</span>
            <select
              id="ai-model-pick"
              value={fromList ? value : ''}
              onChange={(event) => onChange(event.target.value)}
            >
              <option value="">— другая модель —</option>
              {picker.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="field" htmlFor="ai-model-custom">
          <span>Имя модели</span>
          <input
            id="ai-model-custom"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={hint}
            maxLength={120}
          />
        </label>
        <div style={{ display: 'flex', gap: 'var(--u-space-3)', justifyContent: 'flex-end' }}>
          <button type="button" className="btn--ghost btn--sm" onClick={onCancel} disabled={busy}>
            Отмена
          </button>
          <button type="submit" className="btn--sm" disabled={busy || trimmed.length === 0}>
            {busy ? 'Сохраняем…' : 'Сохранить ключ'}
          </button>
        </div>
      </form>
    </div>
  );
}

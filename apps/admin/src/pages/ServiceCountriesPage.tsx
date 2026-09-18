import { useCallback, useEffect, useState } from 'react';
import type {
  ServiceCountry,
  ServiceCountryPolicy,
  ServiceCountryPolicyVersion,
} from '@unicorn/contracts';
import { PromptDialog } from '@unicorn/ui';
import { api } from '../api';
import { formatDate, problemText } from '../lib/format';

/**
 * Страны обслуживания и их условия (этап 5.6.5, план 0.2 §0г).
 *
 * Страна — строка справочника, не миграция: заводится выключенной, включается
 * отдельно. Условия страны — версии с основанием: активация новой версии не
 * переписывает прежнюю, снимок страны и версии условий у открытых раундов не
 * меняется. Здесь только настройки; расчёты (бесплатная граница, пакеты)
 * включаются по реестру решений — пока они не реализованы, включённая
 * настройка делает открытие раунда недоступным (fail-closed), о чём страница
 * предупреждает прямо у переключателя.
 */
export function ServiceCountriesPage() {
  const [countries, setCountries] = useState<ServiceCountry[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [versions, setVersions] = useState<ServiceCountryPolicyVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const loadCountries = useCallback(async () => {
    try {
      const list = await api.serviceCountries.admin.list();
      setCountries(list.items);
      setSelected((current) => current ?? list.items[0]?.code ?? null);
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить страны обслуживания'));
    }
  }, []);

  const loadVersions = useCallback(async (code: string) => {
    try {
      const list = await api.serviceCountries.admin.policies(code);
      setVersions(list.items);
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить условия страны'));
    }
  }, []);

  useEffect(() => {
    void loadCountries();
  }, [loadCountries]);

  useEffect(() => {
    setVersions(null);
    if (selected) void loadVersions(selected);
  }, [selected, loadVersions]);

  const done = async (text: string) => {
    setNotice(text);
    setError(null);
    await loadCountries();
    if (selected) await loadVersions(selected);
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Страны обслуживания</h1>
          <p className="page-hint">
            Страна закреплена за аккаунтом основателя и определяет валюту раунда и условия
            привлечения. Условия — версии с основанием; у открытых раундов остаётся снимок страны и
            версии на момент открытия. Смены страны у аккаунта нет (реестр решений).
          </p>
        </div>
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}

      {countries === null ? <div className="spinner">Загрузка…</div> : null}
      {countries !== null ? (
        <CountriesBlock
          countries={countries}
          selected={selected}
          onSelect={setSelected}
          onDone={done}
          onError={setError}
        />
      ) : null}
      {selected && versions !== null ? (
        <PolicyBlock
          key={selected}
          code={selected}
          versions={versions}
          onDone={done}
          onError={setError}
        />
      ) : null}
      {selected && versions === null && countries !== null ? (
        <div className="spinner">Загружаем условия…</div>
      ) : null}
    </>
  );
}

// ------------------------------------------------------------ страны

function CountriesBlock({
  countries,
  selected,
  onSelect,
  onDone,
  onError,
}: {
  countries: ServiceCountry[];
  selected: string | null;
  onSelect: (code: string) => void;
  onDone: (text: string) => Promise<void>;
  onError: (text: string) => void;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function create() {
    const value = code.trim().toLowerCase();
    setBusy('create');
    try {
      const created = await api.serviceCountries.admin.create(value);
      setCode('');
      await onDone(`Страна ${created.code.toUpperCase()} заведена выключенной.`);
    } catch (err) {
      onError(problemText(err, 'Страна не заведена'));
    } finally {
      setBusy(null);
    }
  }

  async function toggle(country: ServiceCountry) {
    setBusy(country.code);
    try {
      const saved = await api.serviceCountries.admin.update(country.code, {
        isActive: !country.isActive,
      });
      await onDone(
        `Страна ${saved.code.toUpperCase()} ${saved.isActive ? 'включена' : 'выключена'}.`,
      );
    } catch (err) {
      onError(problemText(err, 'Состояние страны не изменено'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" data-countries>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Справочник стран</h2>
          <div className="small muted">
            Выключенную страну нельзя выбрать при регистрации и в кабинете; уже выбранная у аккаунта
            остаётся. Код — две латинские буквы (ISO 3166-1).
          </div>
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Код</th>
            <th>Состояние</th>
            <th>Порядок</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {countries.map((country) => (
            <tr
              key={country.code}
              data-country-row={country.code}
              data-country-active={country.isActive}
              style={country.code === selected ? { fontWeight: 600 } : undefined}
            >
              <td>
                <button
                  type="button"
                  className="btn--ghost btn--sm"
                  onClick={() => onSelect(country.code)}
                >
                  {country.code.toUpperCase()}
                </button>
              </td>
              <td>{country.isActive ? 'включена' : 'выключена'}</td>
              <td>{country.sortOrder}</td>
              <td className="row-actions">
                <button
                  type="button"
                  className="btn--sm"
                  disabled={busy !== null}
                  onClick={() => void toggle(country)}
                >
                  {country.isActive ? 'Выключить' : 'Включить'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row-actions" style={{ marginTop: 12, alignItems: 'end' }}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="country-code">Новая страна (код)</label>
          <input
            id="country-code"
            value={code}
            maxLength={2}
            placeholder="kz"
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <button
          type="button"
          disabled={busy !== null || !/^[a-zA-Z]{2}$/.test(code.trim())}
          onClick={() => void create()}
        >
          Завести выключенной
        </button>
      </div>
    </section>
  );
}

// ------------------------------------------------------------ условия

const DEFAULT_POLICY: ServiceCountryPolicy = {
  baseCurrency: 'RUB',
  allowedRoundCurrencies: ['RUB'],
  freeAttraction: { enabled: false, amount: null, basis: null },
  paidPackages: { enabled: false },
  limits: { maxTargetPerRound: null },
  operator: {
    manualReviewRequired: false,
    notify: { enabled: false, minTarget: null, recipients: [] },
  },
  fx: { mode: 'none' },
};

function PolicyBlock({
  code,
  versions,
  onDone,
  onError,
}: {
  code: string;
  versions: ServiceCountryPolicyVersion[];
  onDone: (text: string) => Promise<void>;
  onError: (text: string) => void;
}) {
  const active = versions.find((v) => v.isActive) ?? null;
  const [form, setForm] = useState<ServiceCountryPolicy>(active?.config ?? DEFAULT_POLICY);
  const [currencies, setCurrencies] = useState(
    (active?.config ?? DEFAULT_POLICY).allowedRoundCurrencies.join(', '),
  );
  const [recipients, setRecipients] = useState(
    (active?.config ?? DEFAULT_POLICY).operator.notify.recipients.join(', '),
  );
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!active) return;
    setForm(active.config);
    setCurrencies(active.config.allowedRoundCurrencies.join(', '));
    setRecipients(active.config.operator.notify.recipients.join(', '));
  }, [active]);

  const money = (value: string | null) => (value === null ? '' : value);
  const list = (value: string) =>
    value
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

  async function activate(reason: string) {
    setBusy(true);
    try {
      const config: ServiceCountryPolicy = {
        ...form,
        allowedRoundCurrencies: list(currencies).map((c) => c.toUpperCase()),
        operator: {
          ...form.operator,
          notify: { ...form.operator.notify, recipients: list(recipients) },
        },
      };
      const saved = await api.serviceCountries.admin.activatePolicy(code, { config, reason });
      await onDone(`Условия ${code.toUpperCase()}: активна версия ${saved.version}.`);
    } catch (err) {
      onError(problemText(err, 'Условия не сохранены'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-policy-form={code} data-policy-version={active?.version ?? ''}>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Условия привлечения: {code.toUpperCase()}</h2>
          <div className="small muted">
            {active
              ? `Активна версия ${active.version} от ${formatDate(active.createdAt)}: ${active.reason}`
              : 'Условий ещё нет: без активной версии открыть раунд в этой стране нельзя.'}
          </div>
        </div>
      </div>

      <div className="grid-2">
        <div className="field">
          <label htmlFor="policy-base-currency">Базовая валюта</label>
          <input
            id="policy-base-currency"
            value={form.baseCurrency}
            maxLength={3}
            onChange={(e) => setForm({ ...form, baseCurrency: e.target.value.toUpperCase() })}
          />
          <div className="field__hint">
            Валюта условий и потолков. Конвертации нет: базовая валюта обязана быть среди
            разрешённых валют раундов.
          </div>
        </div>
        <div className="field">
          <label htmlFor="policy-currencies">Разрешённые валюты раундов (через запятую)</label>
          <input
            id="policy-currencies"
            value={currencies}
            onChange={(e) => setCurrencies(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="policy-max-target">
            Потолок суммы одного раунда (пусто — выключен, по умолчанию)
          </label>
          <input
            id="policy-max-target"
            inputMode="decimal"
            value={money(form.limits.maxTargetPerRound)}
            onChange={(e) =>
              setForm({
                ...form,
                limits: { maxTargetPerRound: e.target.value.trim() || null },
              })
            }
          />
          <div className="field__hint">
            Для верхнего диапазона нужно явное предложение (план 0.2 §0г.2 п.2).
          </div>
        </div>
      </div>

      <h3 style={{ marginTop: 16 }}>Бесплатная граница привлечения</h3>
      <label className="switch">
        <input
          type="checkbox"
          data-policy-free
          checked={form.freeAttraction.enabled}
          onChange={(e) =>
            setForm({
              ...form,
              freeAttraction: { ...form.freeAttraction, enabled: e.target.checked },
            })
          }
        />
        Бесплатная граница включена
      </label>
      {form.freeAttraction.enabled ? (
        <div className="alert alert--info" data-policy-warning="free">
          Учёт бесплатной границы ещё не реализован (база учёта не согласована — реестр решений).
          Пока он не реализован, активная версия с включённой границей делает открытие,
          возобновление и увеличение суммы раунда в этой стране недоступными: отказ, а не молчаливое
          «бесплатно».
        </div>
      ) : null}
      <div className="grid-2">
        <div className="field">
          <label htmlFor="policy-free-amount">Сумма границы (в базовой валюте)</label>
          <input
            id="policy-free-amount"
            inputMode="decimal"
            value={money(form.freeAttraction.amount)}
            onChange={(e) =>
              setForm({
                ...form,
                freeAttraction: { ...form.freeAttraction, amount: e.target.value.trim() || null },
              })
            }
          />
        </div>
        <div className="field">
          <label htmlFor="policy-free-basis">База учёта — не согласовано</label>
          <select
            id="policy-free-basis"
            value={form.freeAttraction.basis ?? ''}
            onChange={(e) =>
              setForm({
                ...form,
                freeAttraction: {
                  ...form.freeAttraction,
                  basis:
                    e.target.value === ''
                      ? null
                      : (e.target.value as ServiceCountryPolicy['freeAttraction']['basis']),
                },
              })
            }
          >
            <option value="">не определена</option>
            <option value="per_round">по раунду</option>
            <option value="cumulative_project">накопительно по проекту</option>
          </select>
          <div className="field__hint">
            Настройка хранится, но решение владельцем не принято; без базы границу включить нельзя.
          </div>
        </div>
      </div>

      <h3 style={{ marginTop: 16 }}>Платные пакеты раунда</h3>
      <label className="switch">
        <input
          type="checkbox"
          data-policy-paid
          checked={form.paidPackages.enabled}
          onChange={(e) => setForm({ ...form, paidPackages: { enabled: e.target.checked } })}
        />
        Платные пакеты включены
      </label>
      {form.paidPackages.enabled ? (
        <div className="alert alert--info" data-policy-warning="paid">
          Пакеты и оплата появятся в этапе 5.9. До этого активная версия с включёнными пакетами
          делает открытие раунда в этой стране недоступным (fail-closed). Сейчас действует режим
          «бесплатно до пакетов».
        </div>
      ) : null}

      <h3 style={{ marginTop: 16 }}>Участие оператора и уведомления команды</h3>
      <label className="switch">
        <input
          type="checkbox"
          data-policy-review
          checked={form.operator.manualReviewRequired}
          onChange={(e) =>
            setForm({
              ...form,
              operator: { ...form.operator, manualReviewRequired: e.target.checked },
            })
          }
        />
        Открытие раунда проверяет оператор (настройка хранится; порядок проверки — 5.9)
      </label>
      <label className="switch">
        <input
          type="checkbox"
          data-policy-notify
          checked={form.operator.notify.enabled}
          onChange={(e) =>
            setForm({
              ...form,
              operator: {
                ...form.operator,
                notify: { ...form.operator.notify, enabled: e.target.checked },
              },
            })
          }
        />
        Сообщать команде о запусках раундов
      </label>
      <div className="grid-2">
        <div className="field">
          <label htmlFor="policy-notify-min">Сообщать от суммы (пусто — обо всех)</label>
          <input
            id="policy-notify-min"
            inputMode="decimal"
            value={money(form.operator.notify.minTarget)}
            onChange={(e) =>
              setForm({
                ...form,
                operator: {
                  ...form.operator,
                  notify: { ...form.operator.notify, minTarget: e.target.value.trim() || null },
                },
              })
            }
          />
        </div>
        <div className="field">
          <label htmlFor="policy-notify-recipients">Получатели (адреса через запятую)</label>
          <input
            id="policy-notify-recipients"
            value={recipients}
            onChange={(e) => setRecipients(e.target.value)}
          />
          <div className="field__hint">Уведомления без получателей не включаются.</div>
        </div>
      </div>

      <div className="row-actions" style={{ marginTop: 12 }}>
        <button type="button" disabled={busy} onClick={() => setConfirm(true)}>
          Активировать новой версией
        </button>
      </div>

      <h3 style={{ marginTop: 16 }}>История версий</h3>
      <table className="table" data-policy-history>
        <thead>
          <tr>
            <th>Версия</th>
            <th>Дата</th>
            <th>Кратко</th>
            <th>Основание</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id} data-policy-row={v.version}>
              <td>
                {v.version}
                {v.isActive ? ' · активна' : ''}
              </td>
              <td>{formatDate(v.createdAt)}</td>
              <td>
                {v.config.allowedRoundCurrencies.join('/')} · граница{' '}
                {v.config.freeAttraction.enabled ? 'вкл' : 'выкл'} · пакеты{' '}
                {v.config.paidPackages.enabled ? 'вкл' : 'выкл'} · потолок{' '}
                {v.config.limits.maxTargetPerRound ?? '—'} · оператор{' '}
                {v.config.operator.manualReviewRequired ? 'да' : 'нет'}
              </td>
              <td>{v.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <PromptDialog
        open={confirm}
        title={`Активировать условия ${code.toUpperCase()}`}
        description="Новая версия действует на следующее открытие раунда. У уже открытых раундов остаётся снимок прежней версии."
        label="Основание"
        confirmText="Активировать"
        onCancel={() => setConfirm(false)}
        onConfirm={(reason) => {
          setConfirm(false);
          void activate(reason);
        }}
      />
    </section>
  );
}

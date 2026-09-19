import { useCallback, useEffect, useState } from 'react';
import type {
  PaymentProviderStatus,
  RoundPackage,
  RoundPurchaseView,
  RoundService,
  RoundServiceOffer,
} from '@unicorn/contracts';
import { api } from '../api';
import { formatDate, problemText } from '../lib/format';

/**
 * Пакеты запуска раунда (этап 5.9.1, план 0.2 §0г.2 п. 2 и 8).
 *
 * Основатель платит РАЗОВО за запуск конкретного раунда: размер запроса
 * определяет подходящий пакет по сетке, недостающие услуги докупаются. Цены,
 * состав и диапазоны — настройка, а не константы кода.
 *
 * Страница настраивает ПРЕДЛОЖЕНИЕ. Продажи ею не включаются: расчёт
 * стоимости и оплата появятся отдельно, а пока условия страны держат платные
 * пакеты выключенными — об этом сказано прямо на странице, чтобы
 * заполненная сетка не читалась как «уже продаём».
 */
export function RoundPackagesPage() {
  const [services, setServices] = useState<RoundService[] | null>(null);
  const [packages, setPackages] = useState<RoundPackage[] | null>(null);
  const [offers, setOffers] = useState<RoundServiceOffer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, p, o] = await Promise.all([
        api.roundPackages.services(),
        api.roundPackages.list(),
        api.roundPackages.offers(),
      ]);
      setServices(s.items);
      setPackages(p.items);
      setOffers(o.items);
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить пакеты запуска раунда'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const done = async (text: string) => {
    setNotice(text);
    setError(null);
    await load();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Пакеты раунда</h1>
          <p className="page-hint">
            Разовая оплата запуска раунда: подходящий пакет определяется размером запроса,
            недостающие услуги докупаются. Цена и состав замораживаются версией — изменение
            публикуется новой версией, действующая не переписывается.
          </p>
        </div>
      </div>

      <div className="alert alert--warn" data-sales-off>
        Продажи выключены. Здесь настраивается только предложение: расчёт стоимости и оплата
        появятся отдельным шагом, а условия страны держат платные пакеты выключенными. Заполненная
        сетка ничего не списывает.
      </div>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}

      {services === null || packages === null || offers === null ? (
        <div className="spinner">Загрузка…</div>
      ) : (
        <>
          <ServicesBlock services={services} onDone={done} onError={setError} />
          <PackagesBlock packages={packages} services={services} onDone={done} onError={setError} />
          <AlternativesBlock packages={packages} onDone={done} onError={setError} />
          <OffersBlock offers={offers} services={services} onDone={done} onError={setError} />
          <PurchasesBlock onError={setError} />
        </>
      )}
    </>
  );
}

// ------------------------------------------------------------------ услуги

function ServicesBlock({
  services,
  onDone,
  onError,
}: {
  services: RoundService[];
  onDone: (text: string) => Promise<void>;
  onError: (text: string) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  async function create() {
    setBusy('create');
    try {
      const created = await api.roundPackages.createService({
        code: code.trim().toLowerCase(),
        name: name.trim(),
      });
      setCode('');
      setName('');
      await onDone(`Услуга «${created.name}» заведена как не реализованная.`);
    } catch (err) {
      onError(problemText(err, 'Услуга не заведена'));
    } finally {
      setBusy(null);
    }
  }

  async function toggle(service: RoundService) {
    const next = !service.isImplemented;
    const reason = window.prompt(
      next
        ? 'Основание: почему услуга считается реализованной?'
        : 'Основание: почему услуга снимается с продажи?',
    );
    if (reason === null || reason.trim().length < 3) return;
    setBusy(service.id);
    try {
      await api.roundPackages.updateService(service.id, {
        isImplemented: next,
        reason: reason.trim(),
      });
      await onDone(
        next
          ? `Услуга «${service.name}» помечена реализованной — её можно включать в пакеты.`
          : `Услуга «${service.name}» больше не включается в новые пакеты; совершённые покупки не затронуты.`,
      );
    } catch (err) {
      onError(problemText(err, 'Отметка не изменена'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" data-round-services>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Услуги</h2>
          <div className="small muted">
            В пакет и в докупку попадает только реализованная услуга: настройка не должна создавать
            обещание, которого нет в продукте.
          </div>
        </div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Код</th>
            <th>Название</th>
            <th>Состояние</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {services.length === 0 ? (
            <tr>
              <td colSpan={4} className="muted">
                Услуг пока нет.
              </td>
            </tr>
          ) : null}
          {services.map((service) => (
            <tr
              key={service.id}
              data-service-row={service.code}
              data-service-implemented={service.isImplemented}
            >
              <td>{service.code}</td>
              <td>{service.name}</td>
              <td>{service.isImplemented ? 'реализована' : 'не реализована'}</td>
              <td className="row-actions">
                <button
                  type="button"
                  className="btn--sm"
                  disabled={busy !== null}
                  onClick={() => void toggle(service)}
                >
                  {service.isImplemented ? 'Снять отметку' : 'Отметить реализованной'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="form-row" style={{ marginTop: 12 }}>
        <label htmlFor="round-service-code">Код услуги</label>
        <input
          id="round-service-code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="legal_check"
        />
      </div>
      <div className="form-row">
        <label htmlFor="round-service-name">Название</label>
        <input
          id="round-service-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Юридическая проверка"
        />
      </div>
      <button
        type="button"
        className="btn--sm"
        disabled={busy !== null || code.trim() === '' || name.trim() === ''}
        onClick={() => void create()}
      >
        Завести услугу
      </button>
    </section>
  );
}

// ------------------------------------------------------------------ пакеты

function PackagesBlock({
  packages,
  services,
  onDone,
  onError,
}: {
  packages: RoundPackage[];
  services: RoundService[];
  onDone: (text: string) => Promise<void>;
  onError: (text: string) => void;
}) {
  const [form, setForm] = useState({
    code: '',
    countryCode: 'ru',
    name: '',
    price: '',
    currency: 'RUB',
    minTarget: '',
    maxTarget: '',
    reason: '',
  });
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const implemented = services.filter((s) => s.isImplemented);

  async function publish() {
    setBusy('publish');
    try {
      const created = await api.roundPackages.publish({
        code: form.code.trim().toLowerCase(),
        countryCode: form.countryCode.trim().toLowerCase(),
        name: form.name.trim(),
        price: form.price.trim(),
        currency: form.currency.trim().toUpperCase(),
        minTarget: form.minTarget.trim(),
        maxTarget: form.maxTarget.trim() === '' ? null : form.maxTarget.trim(),
        serviceCodes: picked,
        reason: form.reason.trim(),
      });
      setPicked([]);
      setForm((f) => ({ ...f, price: '', minTarget: '', maxTarget: '', reason: '' }));
      await onDone(`Опубликована версия ${created.version} пакета «${created.name}».`);
    } catch (err) {
      onError(problemText(err, 'Версия пакета не опубликована'));
    } finally {
      setBusy(null);
    }
  }

  async function close(pkg: RoundPackage) {
    const reason = window.prompt('Основание: почему версия снимается с продажи?');
    if (reason === null || reason.trim().length < 3) return;
    setBusy(pkg.id);
    try {
      await api.roundPackages.close(pkg.id, { reason: reason.trim() });
      await onDone(`Версия ${pkg.version} пакета «${pkg.name}» снята с продажи.`);
    } catch (err) {
      onError(problemText(err, 'Версия не снята'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card" data-round-packages>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Сетка пакетов</h2>
          <div className="small muted">
            Диапазон — «от суммы включительно до верхней границы»; пустая верхняя граница означает
            «и выше». Диапазоны внутри страны не пересекаются, иначе подходящий пакет был бы
            неоднозначен.
          </div>
        </div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Код</th>
            <th>Версия</th>
            <th>Страна</th>
            <th>Диапазон запроса</th>
            <th>Цена</th>
            <th>Состав</th>
            <th>Действует</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {packages.length === 0 ? (
            <tr>
              <td colSpan={8} className="muted">
                Пакеты не настроены.
              </td>
            </tr>
          ) : null}
          {packages.map((pkg) => (
            <tr key={pkg.id} data-package-row={pkg.code} data-package-active={pkg.isActive}>
              <td>{pkg.code}</td>
              <td>{pkg.version}</td>
              <td>{pkg.countryCode.toUpperCase()}</td>
              <td>
                {pkg.minTarget} — {pkg.maxTarget ?? 'и выше'}
              </td>
              <td>
                {pkg.price} {pkg.currency}
              </td>
              <td className="small">
                {pkg.services.length === 0 ? '—' : pkg.services.map((s) => s.name).join(', ')}
              </td>
              <td className="small">
                {formatDate(pkg.validFrom)} — {pkg.validTo ? formatDate(pkg.validTo) : 'бессрочно'}
              </td>
              <td className="row-actions">
                {pkg.isActive ? (
                  <button
                    type="button"
                    className="btn--sm"
                    disabled={busy !== null}
                    onClick={() => void close(pkg)}
                  >
                    Снять с продажи
                  </button>
                ) : (
                  <span className="muted small">закрыта</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: 16 }}>Опубликовать версию</h3>
      <div className="small muted" style={{ marginBottom: 8 }}>
        Действующая версия того же кода закроется этим же моментом: в сетке не остаётся ни разрыва,
        ни двух цен одновременно.
      </div>
      <TextField
        id="package-code"
        label="Код пакета"
        value={form.code}
        onChange={(v) => setForm((f) => ({ ...f, code: v }))}
      />
      <TextField
        id="package-country"
        label="Страна"
        value={form.countryCode}
        onChange={(v) => setForm((f) => ({ ...f, countryCode: v }))}
      />
      <TextField
        id="package-name"
        label="Название"
        value={form.name}
        onChange={(v) => setForm((f) => ({ ...f, name: v }))}
      />
      <TextField
        id="package-min"
        label="Запрос от"
        value={form.minTarget}
        onChange={(v) => setForm((f) => ({ ...f, minTarget: v }))}
      />
      <TextField
        id="package-max"
        label="Запрос до (пусто — и выше)"
        value={form.maxTarget}
        onChange={(v) => setForm((f) => ({ ...f, maxTarget: v }))}
      />
      <TextField
        id="package-price"
        label="Цена"
        value={form.price}
        onChange={(v) => setForm((f) => ({ ...f, price: v }))}
      />
      <TextField
        id="package-currency"
        label="Валюта"
        value={form.currency}
        onChange={(v) => setForm((f) => ({ ...f, currency: v }))}
      />
      <TextField
        id="package-reason"
        label="Основание"
        value={form.reason}
        onChange={(v) => setForm((f) => ({ ...f, reason: v }))}
      />

      <fieldset style={{ border: 'none', padding: 0, margin: '8px 0' }}>
        <legend className="small muted">Что входит в пакет</legend>
        {implemented.length === 0 ? (
          <div className="muted small">Реализованных услуг нет — пакет будет без состава.</div>
        ) : null}
        {implemented.map((service) => (
          <div key={service.id}>
            <input
              type="checkbox"
              id={`package-service-${service.code}`}
              checked={picked.includes(service.code)}
              onChange={(e) =>
                setPicked((current) =>
                  e.target.checked
                    ? [...current, service.code]
                    : current.filter((c) => c !== service.code),
                )
              }
            />
            <label htmlFor={`package-service-${service.code}`}> {service.name}</label>
          </div>
        ))}
      </fieldset>

      <button
        type="button"
        className="btn--sm"
        disabled={
          busy !== null ||
          form.code.trim() === '' ||
          form.name.trim() === '' ||
          form.price.trim() === '' ||
          form.minTarget.trim() === '' ||
          form.reason.trim().length < 3
        }
        onClick={() => void publish()}
      >
        Опубликовать версию
      </button>
    </section>
  );
}

// ------------------------------------------------------------- цены докупки

function OffersBlock({
  offers,
  services,
  onDone,
  onError,
}: {
  offers: RoundServiceOffer[];
  services: RoundService[];
  onDone: (text: string) => Promise<void>;
  onError: (text: string) => void;
}) {
  const implemented = services.filter((s) => s.isImplemented);
  const [form, setForm] = useState({
    serviceCode: '',
    countryCode: 'ru',
    price: '',
    currency: 'RUB',
    reason: '',
  });
  const [busy, setBusy] = useState(false);

  async function publish() {
    setBusy(true);
    try {
      await api.roundPackages.publishOffer({
        serviceCode: form.serviceCode,
        countryCode: form.countryCode.trim().toLowerCase(),
        price: form.price.trim(),
        currency: form.currency.trim().toUpperCase(),
        reason: form.reason.trim(),
      });
      setForm((f) => ({ ...f, price: '', reason: '' }));
      await onDone('Цена докупаемой услуги опубликована.');
    } catch (err) {
      onError(problemText(err, 'Цена не опубликована'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-round-service-offers>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Докупка услуг</h2>
          <div className="small muted">
            Нет действующей цены — услугу нельзя докупить, даже если она входит в какой-то пакет.
          </div>
        </div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Услуга</th>
            <th>Страна</th>
            <th>Версия</th>
            <th>Цена</th>
            <th>Действует</th>
          </tr>
        </thead>
        <tbody>
          {offers.length === 0 ? (
            <tr>
              <td colSpan={5} className="muted">
                Цены докупки не настроены.
              </td>
            </tr>
          ) : null}
          {offers.map((offer) => (
            <tr
              key={offer.id}
              data-offer-row={offer.serviceCode}
              data-offer-active={offer.isActive}
            >
              <td>{offer.serviceName}</td>
              <td>{offer.countryCode.toUpperCase()}</td>
              <td>{offer.version}</td>
              <td>
                {offer.price} {offer.currency}
              </td>
              <td className="small">
                {formatDate(offer.validFrom)} —{' '}
                {offer.validTo ? formatDate(offer.validTo) : 'бессрочно'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 style={{ marginTop: 16 }}>Опубликовать цену</h3>
      <div className="form-row">
        <label htmlFor="offer-service">Услуга</label>
        <select
          id="offer-service"
          value={form.serviceCode}
          onChange={(e) => setForm((f) => ({ ...f, serviceCode: e.target.value }))}
        >
          <option value="">— выберите —</option>
          {implemented.map((service) => (
            <option key={service.id} value={service.code}>
              {service.name}
            </option>
          ))}
        </select>
      </div>
      <TextField
        id="offer-country"
        label="Страна"
        value={form.countryCode}
        onChange={(v) => setForm((f) => ({ ...f, countryCode: v }))}
      />
      <TextField
        id="offer-price"
        label="Цена"
        value={form.price}
        onChange={(v) => setForm((f) => ({ ...f, price: v }))}
      />
      <TextField
        id="offer-currency"
        label="Валюта"
        value={form.currency}
        onChange={(v) => setForm((f) => ({ ...f, currency: v }))}
      />
      <TextField
        id="offer-reason"
        label="Основание"
        value={form.reason}
        onChange={(v) => setForm((f) => ({ ...f, reason: v }))}
      />
      <button
        type="button"
        className="btn--sm"
        disabled={
          busy ||
          form.serviceCode === '' ||
          form.price.trim() === '' ||
          form.reason.trim().length < 3
        }
        onClick={() => void publish()}
      >
        Опубликовать цену
      </button>
    </section>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="form-row">
      <label htmlFor={id}>{label}</label>
      <input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// -------------------------------------------- допустимые альтернативы пакета

/**
 * Чем можно заменить требуемый пакет.
 *
 * Список задаёт администратор ЯВНО: ни цена, ни совпадение состава заменой не
 * делают. Если состав альтернативы не покрывает требуемый пакет, экран
 * предупреждает — но не запрещает: решение принимает человек.
 */
function AlternativesBlock({
  packages,
  onDone,
  onError,
}: {
  packages: RoundPackage[];
  onDone: (text: string) => Promise<void>;
  onError: (text: string) => void;
}) {
  const active = packages.filter((p) => p.isActive);
  const [packageId, setPackageId] = useState('');
  const [alternativeId, setAlternativeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [warning, setWarning] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    try {
      const result = await api.roundPurchases.addAlternative({
        packageId,
        alternativeId,
        reason: 'назначена допустимой заменой',
      });
      setWarning(result.warning);
      await onDone('Альтернатива назначена.');
    } catch (err) {
      onError(problemText(err, 'Альтернатива не назначена'));
    } finally {
      setBusy(false);
    }
  }

  async function remove(pkg: RoundPackage, code: string) {
    const alt = active.find((p) => p.code === code);
    if (!alt) return;
    setBusy(true);
    try {
      await api.roundPurchases.removeAlternative({
        packageId: pkg.id,
        alternativeId: alt.id,
        reason: 'замена отменена',
      });
      await onDone('Альтернатива убрана.');
    } catch (err) {
      onError(problemText(err, 'Альтернатива не убрана'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" data-package-alternatives>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Допустимые замены пакета</h2>
          <div className="small muted">
            Чем основатель вправе заменить требуемый пакет. Список явный: ни более высокая цена, ни
            совпадение состава заменой не делают — это решение, а не вычисление.
          </div>
        </div>
      </div>

      {warning ? (
        <div className="alert alert--warn" data-alternative-warning>
          {warning}
        </div>
      ) : null}

      <table className="table">
        <thead>
          <tr>
            <th>Пакет</th>
            <th>Разрешённые замены</th>
          </tr>
        </thead>
        <tbody>
          {active.map((pkg) => (
            <tr key={pkg.id} data-alternatives-of={pkg.code}>
              <td>{pkg.name}</td>
              <td className="small">
                {pkg.alternatives.length === 0 ? '—' : null}
                {pkg.alternatives.map((alt) => (
                  <div key={alt.code}>
                    {alt.name}
                    {alt.coversComposition ? null : (
                      <span className="muted"> — состав не покрывает требуемый</span>
                    )}
                    <button
                      type="button"
                      className="btn--ghost btn--sm"
                      disabled={busy}
                      onClick={() => void remove(pkg, alt.code)}
                    >
                      Убрать
                    </button>
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="form-row">
        <label htmlFor="alt-package">Требуемый пакет</label>
        <select id="alt-package" value={packageId} onChange={(e) => setPackageId(e.target.value)}>
          <option value="">— выберите —</option>
          {active.map((pkg) => (
            <option key={pkg.id} value={pkg.id}>
              {pkg.name}
            </option>
          ))}
        </select>
      </div>
      <div className="form-row">
        <label htmlFor="alt-alternative">Разрешить замену на</label>
        <select
          id="alt-alternative"
          value={alternativeId}
          onChange={(e) => setAlternativeId(e.target.value)}
        >
          <option value="">— выберите —</option>
          {active
            .filter((pkg) => pkg.id !== packageId)
            .map((pkg) => (
              <option key={pkg.id} value={pkg.id}>
                {pkg.name}
              </option>
            ))}
        </select>
      </div>
      <button
        type="button"
        className="btn--sm"
        disabled={busy || packageId === '' || alternativeId === ''}
        onClick={() => void add()}
      >
        Назначить замену
      </button>
    </section>
  );
}

// ------------------------------------------------- покупки запуска раунда

/**
 * Покупки: подтверждение тестовой оплаты и отметка выполнения услуг.
 *
 * Настоящих платежей здесь нет. «Подтвердить тестовую оплату» помечает покупку
 * тестовой навсегда и работает только при включённом флаге и вне рабочего
 * окружения. Отметку «выполнено» ставит человек и с основанием: работа
 * эксперта и разбор ИИ не становятся сделанными оттого, что деньги пришли.
 */
function PurchasesBlock({ onError }: { onError: (text: string) => void }) {
  const [items, setItems] = useState<RoundPurchaseView[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems((await api.roundPurchases.list()).items);
    } catch (err) {
      onError(problemText(err, 'Не удалось загрузить покупки'));
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirm(purchase: RoundPurchaseView) {
    setBusy(true);
    try {
      await api.roundPurchases.confirmTestPayment(purchase.id);
      await load();
    } catch (err) {
      onError(problemText(err, 'Оплата не подтверждена'));
    } finally {
      setBusy(false);
    }
  }

  async function fulfil(itemId: string) {
    const note = window.prompt('Основание: что именно сделано?');
    if (note === null || note.trim().length < 3) return;
    setBusy(true);
    try {
      await api.roundPurchases.setFulfillment(itemId, { status: 'fulfilled', note: note.trim() });
      await load();
    } catch (err) {
      onError(problemText(err, 'Отметка не сохранена'));
    } finally {
      setBusy(false);
    }
  }

  if (items === null) return null;

  return (
    <>
      <ProviderBlock />
      <section className="card" data-round-purchases>
        <div className="page-head" style={{ marginBottom: 10 }}>
          <div>
            <h2 style={{ marginBottom: 2 }}>Покупки запуска</h2>
            <div className="small muted">
              Настоящих платежей платформа не принимает. Тестовое подтверждение помечает покупку
              навсегда и доступно только вне рабочего окружения.
            </div>
          </div>
        </div>

        {items.length === 0 ? <div className="muted">Покупок пока нет.</div> : null}

        <table className="table">
          <thead>
            <tr>
              <th>Покупка</th>
              <th>Состояние</th>
              <th>Сумма</th>
              <th>Услуги</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((purchase) => (
              <tr
                key={purchase.id}
                data-purchase-row={purchase.id}
                data-purchase-status={purchase.status}
              >
                <td className="small">
                  {purchase.packageCode ?? '—'}
                  {purchase.isTestPayment ? <div className="muted">оплата тестовая</div> : null}
                </td>
                <td>{purchase.status}</td>
                <td>
                  {purchase.totalAmount} {purchase.currency}
                </td>
                <td className="small">
                  {purchase.items.map((item) => (
                    <div key={item.id} data-purchase-item={item.fulfillmentStatus}>
                      {item.title} — {item.fulfillmentStatus}
                      {item.fulfillmentStatus === 'fulfilled' ? null : (
                        <button
                          type="button"
                          className="btn--ghost btn--sm"
                          disabled={busy}
                          onClick={() => void fulfil(item.id)}
                        >
                          Отметить выполненной
                        </button>
                      )}
                    </div>
                  ))}
                </td>
                <td className="row-actions">
                  {purchase.status === 'pending_payment' ? (
                    <button
                      type="button"
                      className="btn--sm"
                      disabled={busy}
                      onClick={() => void confirm(purchase)}
                    >
                      Подтвердить тестовую оплату
                    </button>
                  ) : (
                    <span className="muted small">
                      {purchase.openBlocker ?? 'условия выполнены'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

/**
 * Подключение оператора онлайн-платежей (5.9.9).
 *
 * Экран ничего не настраивает: провайдер и ключ проверки подписи живут в
 * окружении, а не в продуктовых настройках. Здесь администратор видит, что
 * именно произойдёт при попытке оплатить, — и почему настоящие деньги пока не
 * принимаются.
 */
function ProviderBlock() {
  const [status, setStatus] = useState<PaymentProviderStatus | null>(null);

  useEffect(() => {
    let cancelled = false;
    void api.payments
      .provider()
      .then((result) => {
        if (!cancelled) setStatus(result);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status === null) return null;

  return (
    <section className="card" data-payment-provider={status.provider}>
      <div className="page-head" style={{ marginBottom: 10 }}>
        <div>
          <h2 style={{ marginBottom: 2 }}>Оператор платежей</h2>
          <div className="small muted">
            Настраивается в окружении, не здесь: секреты в продуктовых настройках не хранятся.
          </div>
        </div>
      </div>
      <table className="table">
        <tbody>
          <tr>
            <th>Адаптер</th>
            <td data-provider-code>{status.provider}</td>
          </tr>
          <tr>
            <th>Режим</th>
            <td data-provider-mode>{status.mode}</td>
          </tr>
          <tr>
            <th>Настоящие платежи</th>
            <td data-provider-accepting={String(status.acceptingRealPayments)}>
              {status.acceptingRealPayments ? 'принимаются' : 'не принимаются'}
            </td>
          </tr>
          <tr>
            <th>Проверка уведомлений</th>
            <td>{status.notificationsVerifiable ? 'подпись проверяется' : 'проверить нечем'}</td>
          </tr>
        </tbody>
      </table>
      <ul className="small muted" style={{ marginTop: 8 }}>
        {status.explanation.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </section>
  );
}

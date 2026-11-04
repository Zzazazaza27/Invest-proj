import { useCallback, useEffect, useState } from 'react';
import type { ServiceCountry } from '@fifth/contracts';
import { api } from '../api';
import { problemText } from '../lib/format';

/**
 * Страны обслуживания (этап 5.6.5, план 0.2 §0г).
 *
 * Страна — строка справочника, не миграция: заводится выключенной, включается
 * отдельно. Условия стран (валюты и потолок раунда, пакеты) удалены в 2.1-W05
 * вместе с раундами.
 */
export function ServiceCountriesPage() {
  const [countries, setCountries] = useState<ServiceCountry[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
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

  useEffect(() => {
    void loadCountries();
  }, [loadCountries]);

  const done = async (text: string) => {
    setNotice(text);
    setError(null);
    await loadCountries();
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Страны обслуживания</h1>
          <p className="page-hint">
            Страна закреплена за аккаунтом и выбирается при регистрации. Смены страны у аккаунта нет
            (реестр решений).
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

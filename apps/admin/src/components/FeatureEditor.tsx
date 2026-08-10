import { useState } from 'react';

/**
 * Редактор наполнения подписки.
 *
 * Два уровня: список пунктов «что входит» (то, что увидит пользователь на
 * витрине) и произвольные пары ключ-значение для машинных лимитов вроде
 * `maxProjects`. Свободный JSON намеренно не предлагается: опечатка в нём
 * попала бы прямо в публичный контракт тарифа.
 */
export function FeatureEditor({
  value,
  onChange,
}: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const included = Array.isArray(value.included) ? (value.included as unknown[]).map(String) : [];
  const limits = Object.entries(value).filter(([key]) => key !== 'included');

  const [draftItem, setDraftItem] = useState('');
  const [draftKey, setDraftKey] = useState('');
  const [draftValue, setDraftValue] = useState('');

  function setIncluded(next: string[]) {
    const copy = { ...value };
    if (next.length === 0) delete copy.included;
    else copy.included = next;
    onChange(copy);
  }

  return (
    <div className="card card--flat" style={{ marginBottom: 0, padding: 14 }}>
      <div className="small muted" style={{ marginBottom: 8 }}>
        Пункты «что входит» — показываются пользователю
      </div>

      {included.length === 0 && <div className="small muted">Пока ничего не добавлено.</div>}

      {included.map((item, index) => (
        <div key={index} className="toolbar" style={{ marginBottom: 6 }}>
          <input
            value={item}
            onChange={(e) => {
              const next = [...included];
              next[index] = e.target.value;
              setIncluded(next);
            }}
            style={{ maxWidth: 520 }}
          />
          <button
            type="button"
            className="btn--danger btn--sm"
            onClick={() => setIncluded(included.filter((_, i) => i !== index))}
          >
            Убрать
          </button>
        </div>
      ))}

      <div className="toolbar">
        <input
          value={draftItem}
          placeholder="Например: полные карточки проектов"
          onChange={(e) => setDraftItem(e.target.value)}
          style={{ maxWidth: 520 }}
        />
        <button
          type="button"
          className="btn--ghost btn--sm"
          disabled={draftItem.trim().length === 0}
          onClick={() => {
            setIncluded([...included, draftItem.trim()]);
            setDraftItem('');
          }}
        >
          Добавить пункт
        </button>
      </div>

      <div className="small muted" style={{ margin: '14px 0 8px' }}>
        Числовые и логические ограничения тарифа
      </div>

      {limits.map(([key, val]) => (
        <div key={key} className="toolbar" style={{ marginBottom: 6 }}>
          <input value={key} readOnly style={{ maxWidth: 240 }} />
          <input
            value={String(val)}
            onChange={(e) => onChange({ ...value, [key]: coerce(e.target.value) })}
            style={{ maxWidth: 240 }}
          />
          <button
            type="button"
            className="btn--danger btn--sm"
            onClick={() => {
              const copy = { ...value };
              delete copy[key];
              onChange(copy);
            }}
          >
            Убрать
          </button>
        </div>
      ))}

      <div className="toolbar">
        <input
          value={draftKey}
          placeholder="ключ, например maxProjects"
          onChange={(e) => setDraftKey(e.target.value)}
          style={{ maxWidth: 240 }}
        />
        <input
          value={draftValue}
          placeholder="значение"
          onChange={(e) => setDraftValue(e.target.value)}
          style={{ maxWidth: 240 }}
        />
        <button
          type="button"
          className="btn--ghost btn--sm"
          disabled={draftKey.trim().length === 0}
          onClick={() => {
            onChange({ ...value, [draftKey.trim()]: coerce(draftValue) });
            setDraftKey('');
            setDraftValue('');
          }}
        >
          Добавить ограничение
        </button>
      </div>
    </div>
  );
}

/** Число остаётся числом, «да/нет» — булевым: иначе лимиты придётся парсить на сервере. */
function coerce(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed !== '' && Number.isFinite(Number(trimmed))) return Number(trimmed);
  return trimmed;
}

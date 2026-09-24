import { useState } from 'react';
import { Button } from '@unicorn/ui';

/*
 * «Решения по кнопкам» — кандидаты вида для тихой и опасной роли.
 *
 * Названия ghost/quiet и вид danger не закреплены: владелец выбирает,
 * глядя на кандидатов в НАСТОЯЩИХ действиях (как на экранах админки и
 * кабинетов) и на обеих подложках. Кандидаты нарисованы только смысловыми
 * токенами — в любом скине они выглядят так, как выглядели бы на самом деле.
 * Это черновики для решения, а не компоненты: после выбора вид переносится в
 * packages/ui, а этот блок сокращается до утверждённого.
 */

type QuietId = 'text' | 'outline' | 'plain';
type DangerId = 'outline' | 'fill' | 'mixed';

const QUIET: { id: QuietId; title: string; note: string }[] = [
  {
    id: 'text',
    title: 'Текстовая акцентная',
    note: 'цвет акцента, без рамки и фона — как ghost в кабинетах',
  },
  {
    id: 'outline',
    title: 'Нейтральная с рамкой',
    note: 'цвет текста, рамка, белая подложка — как ghost в админке',
  },
  {
    id: 'plain',
    title: 'Нейтральная без рамки',
    note: 'цвет текста, без рамки; фон появляется только при наведении',
  },
];

const DANGER: { id: DangerId; title: string; note: string }[] = [
  { id: 'outline', title: 'Контур', note: 'красный текст и рамка — как danger в админке' },
  { id: 'fill', title: 'Заливка', note: 'красная заливка — как danger в кабинетах' },
  {
    id: 'mixed',
    title: 'Контур, в подтверждении — заливка',
    note: 'на экране — контур, в окне подтверждения последний шаг — заливка',
  },
];

/*
 * Стили кандидатов. Только var(--u-…) и их смешивание: цвета значением здесь
 * нет. Наведение и фокус — настоящие (:hover, :focus-visible), как у кнопок.
 *
 * Селекторы наведения с `button…:not(:disabled)`: общее правило админки
 * `button:hover:not(:disabled)` иначе перебивает их по весу и красит
 * кандидата в фирменный цвет.
 */
const CSS = `
.cand { font: inherit; font-weight: 600; cursor: pointer; border-radius: 7px;
  padding: 7px 14px; border: 1px solid transparent; line-height: 1.2; white-space: nowrap; }
.cand--sm { padding: 4px 10px; font-size: 12.5px; }
.cand:focus-visible { outline: none; box-shadow: var(--u-focus-ring); }
button.cand-quiet-text { background: transparent; color: var(--u-accent); }
button.cand-quiet-text:hover:not(:disabled) { background: var(--u-accent-subtle); color: var(--u-accent); }
button.cand-quiet-outline { background: var(--u-surface); color: var(--u-text); border-color: var(--u-border-strong); }
button.cand-quiet-outline:hover:not(:disabled) { color: var(--u-text);
  background: color-mix(in srgb, var(--u-text) 7%, var(--u-surface));
  border-color: color-mix(in srgb, var(--u-text) 25%, var(--u-surface)); }
button.cand-quiet-plain { background: transparent; color: var(--u-text); }
button.cand-quiet-plain:hover:not(:disabled) { color: var(--u-text);
  background: color-mix(in srgb, var(--u-text) 8%, transparent); }
button.cand-danger-outline { background: transparent; color: var(--u-danger); border-color: var(--u-danger); }
button.cand-danger-outline:hover:not(:disabled) { background: var(--u-danger-subtle); color: var(--u-danger); }
button.cand-danger-fill { background: var(--u-danger); color: var(--u-on-accent); }
button.cand-danger-fill:hover:not(:disabled) { color: var(--u-on-accent);
  background: color-mix(in srgb, var(--u-danger) 85%, var(--u-text)); }
`;

function Quiet({ id, children, sm }: { id: QuietId; children: string; sm?: boolean }) {
  return (
    <button
      type="button"
      className={`cand cand-quiet-${id}${sm ? ' cand--sm' : ''}`}
      data-candidate={`quiet:${id}`}
    >
      {children}
    </button>
  );
}

function Danger({
  id,
  children,
  sm,
  final,
}: {
  id: DangerId;
  children: string;
  sm?: boolean;
  /** Последний шаг в окне подтверждения — для варианта «контур, в подтверждении заливка». */
  final?: boolean;
}) {
  const look = id === 'mixed' ? (final ? 'fill' : 'outline') : id;
  return (
    <button
      type="button"
      className={`cand cand-danger-${look}${sm ? ' cand--sm' : ''}`}
      data-candidate={`danger:${id}`}
    >
      {children}
    </button>
  );
}

function Choice<T extends string>({
  name,
  items,
  value,
  onChange,
}: {
  name: string;
  items: { id: T; title: string; note: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <fieldset style={{ border: 'none', padding: 0, margin: 0 }}>
      <legend style={{ fontWeight: 700, marginBottom: 6 }}>{name}</legend>
      {items.map((item) => (
        <label
          key={item.id}
          style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4 }}
        >
          <input
            type="radio"
            name={name}
            data-choice={item.id}
            // Общий стиль полей админки растягивает input на всю ширину.
            style={{ width: 'auto', margin: 0 }}
            checked={value === item.id}
            onChange={() => onChange(item.id)}
          />
          <span>
            {item.title} <span className="small muted">— {item.note}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

export function ButtonDecisions() {
  const [quiet, setQuiet] = useState<QuietId>('outline');
  const [danger, setDanger] = useState<DangerId>('outline');
  const cell: React.CSSProperties = {
    padding: '8px 10px',
    borderBottom: '1px solid var(--u-border)',
  };

  return (
    <div data-block="button-decisions">
      <style>{CSS}</style>
      <div
        className="grid-2"
        style={{
          background: 'var(--u-surface)',
          border: '1px solid var(--u-border)',
          borderRadius: 10,
          padding: 12,
          marginBottom: 12,
        }}
      >
        <Choice name="Тихая кнопка" items={QUIET} value={quiet} onChange={setQuiet} />
        <Choice name="Опасная кнопка" items={DANGER} value={danger} onChange={setDanger} />
      </div>

      {/* Сцена с настоящими действиями — на фоне страницы, как экраны админки. */}
      <div
        data-decision-scene={`${quiet}|${danger}`}
        style={{ background: 'var(--u-bg)', padding: 16, borderRadius: 8 }}
      >
        {/* Шапка карточки пользователя: тихие действия рядом с заголовком. */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            marginBottom: 12,
          }}
        >
          <div>
            <div style={{ fontWeight: 700, fontSize: 18 }}>Ирина Соколова</div>
            <div className="small" style={{ color: 'var(--u-text-muted)' }}>
              шапка карточки пользователя · основатель
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Quiet id={quiet}>Посмотреть кабинет сотрудника</Quiet>
            <Quiet id={quiet}>Посмотреть кабинет основателя</Quiet>
          </div>
        </div>

        {/* Карточка состояния: одиночное опасное действие. */}
        <div
          style={{
            background: 'var(--u-surface)',
            border: '1px solid var(--u-border)',
            borderRadius: 10,
            padding: 14,
            marginBottom: 12,
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Состояние учётной записи</div>
          <div className="small" style={{ color: 'var(--u-text-muted)', marginBottom: 10 }}>
            Состояние не менялось администратором.
          </div>
          <Danger id={danger}>Заблокировать</Danger>
        </div>

        {/* Таблица: тихое и опасное рядом, плотный размер. */}
        <div
          style={{
            background: 'var(--u-surface)',
            border: '1px solid var(--u-border)',
            borderRadius: 10,
            padding: '6px 14px',
            marginBottom: 12,
          }}
        >
          <table style={{ minWidth: 0, width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              {['Проект «Альфа»', 'Проект «Бета»'].map((title) => (
                <tr key={title}>
                  <td style={cell}>{title}</td>
                  <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <Quiet id={quiet} sm>
                        Открыть
                      </Quiet>
                      <Danger id={danger} sm>
                        Удалить
                      </Danger>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
            gap: 12,
          }}
        >
          {/* Форма: основное и тихое. */}
          <div
            style={{
              background: 'var(--u-surface)',
              border: '1px solid var(--u-border)',
              borderRadius: 10,
              padding: 14,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 10 }}>Изменить имя</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Quiet id={quiet}>Отмена</Quiet>
              <Button variant="primary">Сохранить</Button>
            </div>
          </div>

          {/* Окно подтверждения: последний шаг опасного действия. */}
          <div
            style={{
              background: 'color-mix(in srgb, var(--u-text) 35%, transparent)',
              borderRadius: 10,
              padding: 14,
            }}
          >
            <div
              style={{
                background: 'var(--u-surface)',
                borderRadius: 10,
                padding: 14,
                boxShadow: 'var(--u-shadow-md)',
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 6 }}>Заблокировать пользователя?</div>
              <div className="small" style={{ color: 'var(--u-text-muted)', marginBottom: 10 }}>
                Все сессии будут завершены.
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Quiet id={quiet}>Отмена</Quiet>
                <Danger id={danger} final>
                  Заблокировать
                </Danger>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

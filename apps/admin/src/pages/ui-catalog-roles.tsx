import { Button } from '@unicorn/ui';

/*
 * «Роли кнопок» — рабочее решение владельца 2026-09-24 (не окончательное):
 * тихая — нейтральная с рамкой, опасная — контур на экране и заливка в
 * последнем шаге подтверждения. Показаны НАСТОЯЩИЕ компоненты: Button из
 * @unicorn/ui и классы админки — в одних и тех же действиях. Если вид не
 * понравится, правится общий компонент, и эта сцена покажет правку сразу.
 *
 * В форме тихая («Отмена»), второстепенная («Сохранить черновик») и основная
 * стоят рядом — так видно, что тихая отличается от второстепенной.
 */

type Role = 'primary' | 'secondary' | 'quiet' | 'danger' | 'danger-confirm';

/** Классы админки по ролям. У админки нет второстепенной кнопки — это видно в сцене. */
const ADMIN_CLASS: Record<Role, string | null> = {
  primary: '',
  secondary: null,
  quiet: 'btn--ghost',
  danger: 'btn--danger',
  'danger-confirm': 'btn--danger-confirm',
};

function Act({
  set,
  role,
  children,
  sm,
}: {
  set: 'ui' | 'admin';
  role: Role;
  children: string;
  sm?: boolean;
}) {
  if (set === 'ui') {
    return (
      <Button variant={role} size={sm ? 'sm' : 'md'} data-role-sample={role}>
        {children}
      </Button>
    );
  }
  const cls = ADMIN_CLASS[role];
  if (cls === null) {
    return <span className="small muted">({children}: в админке нет второстепенной)</span>;
  }
  return (
    <button
      type="button"
      className={[cls, sm ? 'btn--sm' : null].filter(Boolean).join(' ') || undefined}
      data-role-sample={role}
    >
      {children}
    </button>
  );
}

const box: React.CSSProperties = {
  background: 'var(--u-surface)',
  border: '1px solid var(--u-border)',
  borderRadius: 10,
  padding: 14,
};

function RoleScene({ set }: { set: 'ui' | 'admin' }) {
  const cell: React.CSSProperties = {
    padding: '8px 10px',
    borderBottom: '1px solid var(--u-border)',
  };
  return (
    <div
      data-role-scene={set}
      style={{ background: 'var(--u-bg)', padding: 16, borderRadius: 8, marginBottom: 12 }}
    >
      <div className="small" style={{ color: 'var(--u-text-muted)', marginBottom: 8 }}>
        {set === 'ui' ? 'Button из @unicorn/ui' : 'Кнопки админки (классы styles.css)'}
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          marginBottom: 12,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div style={{ fontWeight: 700, fontSize: 18 }}>Ирина Соколова</div>
          <div className="small" style={{ color: 'var(--u-text-muted)' }}>
            шапка на цветном фоне
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Act set={set} role="quiet">
            Посмотреть кабинет
          </Act>
          <Act set={set} role="secondary">
            Выгрузить
          </Act>
        </div>
      </div>

      <div style={{ ...box, marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>Состояние учётной записи</div>
        <div className="small" style={{ color: 'var(--u-text-muted)', marginBottom: 10 }}>
          Опасное действие на экране — контур.
        </div>
        <Act set={set} role="danger">
          Заблокировать
        </Act>
      </div>

      <div style={{ ...box, padding: '6px 14px', marginBottom: 12 }}>
        <table style={{ minWidth: 0, width: '100%', borderCollapse: 'collapse' }}>
          <tbody>
            {['Проект «Альфа»', 'Проект «Бета»'].map((title) => (
              <tr key={title}>
                <td style={cell}>{title}</td>
                <td style={{ ...cell, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <span style={{ display: 'inline-flex', gap: 6 }}>
                    <Act set={set} role="quiet" sm>
                      Открыть
                    </Act>
                    <Act set={set} role="danger" sm>
                      Удалить
                    </Act>
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
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: 12,
        }}
      >
        <div style={box} data-role-form={set}>
          <div style={{ fontWeight: 700, marginBottom: 10 }}>Заявка</div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Act set={set} role="quiet">
              Отмена
            </Act>
            <Act set={set} role="secondary">
              Сохранить черновик
            </Act>
            <Act set={set} role="primary">
              Отправить
            </Act>
          </div>
        </div>

        <div
          style={{
            background: 'color-mix(in srgb, var(--u-text) 35%, transparent)',
            borderRadius: 10,
            padding: 14,
          }}
        >
          <div style={{ ...box, boxShadow: 'var(--u-shadow-md)' }}>
            <div style={{ fontWeight: 700, marginBottom: 6 }}>Заблокировать пользователя?</div>
            <div className="small" style={{ color: 'var(--u-text-muted)', marginBottom: 10 }}>
              Последний шаг — заливка.
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Act set={set} role="quiet">
                Отмена
              </Act>
              <Act set={set} role="danger-confirm">
                Заблокировать
              </Act>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ButtonRoles() {
  return (
    <div data-block="button-roles">
      <RoleScene set="ui" />
      <RoleScene set="admin" />
    </div>
  );
}

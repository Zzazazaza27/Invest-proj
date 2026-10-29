import { useCallback, useEffect, useState } from 'react';
import { UI_SKIN_FLAG, type FeatureFlag } from '@unicorn/contracts';
import { PromptDialog } from '@unicorn/ui';
import { api } from '../api';
import { formatDate, problemText } from '../lib/format';

/**
 * Функции платформы.
 *
 * Флаги `investments.*` закрывают регулируемый инвестиционный контур до
 * включения оператора в реестр Банка России и согласования Правил платформы.
 * Интерфейс об этом прямо предупреждает: включить такой флаг технически можно,
 * но это решение с юридическими последствиями, а не настройка интерфейса.
 */
export function FlagsPage() {
  const [flags, setFlags] = useState<FeatureFlag[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      // Скин платформы — значение, а не включатель: он меняется в «Элементах
      // интерфейса», и переключать его здесь сервер не даст (M145).
      setFlags((await api.featureFlags()).filter((flag) => flag.key !== UI_SKIN_FLAG));
      setError(null);
    } catch (err) {
      setError(problemText(err, 'Не удалось загрузить список функций'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** Основание вводится в диалоге и попадает в неизменяемый журнал. */
  const [changing, setChanging] = useState<FeatureFlag | null>(null);

  async function toggle(flag: FeatureFlag, reason: string) {
    setError(null);
    setNotice(null);
    try {
      await api.setFeatureFlag(flag.key, !flag.enabled, reason);
      setNotice(`Флаг «${flag.key}» ${!flag.enabled ? 'включён' : 'выключен'}.`);
      await load();
    } catch (err) {
      setError(problemText(err, 'Не удалось изменить флаг'));
    }
  }

  return (
    <>
      <h1>Функции платформы</h1>
      <p className="page-hint">
        Переключатели влияют на поведение всей платформы. Каждое изменение записывается в
        неизменяемый журнал вместе с основанием и автором.
      </p>

      {error && <div className="alert alert--error">{error}</div>}
      {notice && <div className="alert alert--ok">{notice}</div>}

      {flags === null && <div className="spinner">Загрузка…</div>}

      {flags !== null && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Функция</th>
                <th>Состояние</th>
                <th>Изменена</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {flags.map((flag) => (
                <tr key={flag.key}>
                  <td>
                    <div>{flag.key}</div>
                    {flag.key === 'access.entity_grants.enabled' && (
                      <div className="small muted" data-flag-warning="entity-grants">
                        Доступ по организации отложен. Включение до реализации корректного членства
                        (приглашение, выход, исключение участника) не поддерживается: выданное
                        организации разрешение нельзя будет закрыть при выходе человека из неё (TODO
                        «Организации и участники»).
                      </div>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${flag.enabled ? 'badge--ok' : 'badge--muted'}`}>
                      {flag.enabled ? 'включена' : 'выключена'}
                    </span>
                  </td>
                  <td className="small">{formatDate(flag.updatedAt)}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn--ghost btn--sm"
                        onClick={() => setChanging(flag)}
                      >
                        {flag.enabled ? 'Выключить' : 'Включить'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PromptDialog
        open={changing !== null}
        title={changing ? `Флаг «${changing.key}»` : 'Флаг'}
        description={
          changing?.key === 'access.entity_grants.enabled' && !changing.enabled
            ? 'Не поддерживаемое действие: управления составом организации нет, и выданное ей разрешение нельзя будет закрыть при выходе человека из организации. Сначала членство (TODO «Организации и участники»).'
            : 'Изменение попадёт в неизменяемый журнал вместе с автором.'
        }
        label="Основание"
        confirmText={changing?.enabled ? 'Выключить' : 'Включить'}
        onCancel={() => setChanging(null)}
        onConfirm={(reason) => {
          const flag = changing;
          setChanging(null);
          if (flag) void toggle(flag, reason);
        }}
      />
    </>
  );
}

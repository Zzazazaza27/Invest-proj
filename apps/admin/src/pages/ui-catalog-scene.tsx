import { useId } from 'react';
import { Button, type ButtonVariant } from '@unicorn/ui';

/*
 * Эталонная сцена каталога «Элементы интерфейса».
 *
 * Образец в вакууме ни о чём не говорит: цвет `--u-bg-inset` или кнопка
 * `ghost` оцениваются только там, где живут. Сцена — маленький экран из
 * типовых мест: шапка страницы на цветном фоне, карточка с таблицей, низ
 * формы, окно подтверждения, пустой список. Сцена ОДНА для всех образцов,
 * поэтому сравнение честное.
 *
 *  * Кнопка — выбранный вариант встаёт во все места действий сцены.
 *  * Цвет — части сцены, закрашенные этим токеном, обводятся и подписываются.
 *
 * Части рамки сцены красятся токенами ЯВНО (атрибут `data-part` называет
 * токен), поэтому подсветка точна по построению. Про внутренности готовых
 * компонентов (поле, кнопка) сцена ничего не утверждает.
 */

export type SceneAction =
  | { set: 'admin'; className?: string; label: string }
  | { set: 'ui'; variant: ButtonVariant; label: string };

/** Цвет обводки — инструмент каталога, а не часть скина: заметен на любом фоне. */
const MARKER = '#ff2d95';

function Action({ action, text, small }: { action: SceneAction; text: string; small?: boolean }) {
  if (action.set === 'ui') {
    return (
      <Button variant={action.variant} size={small ? 'sm' : 'md'}>
        {text}
      </Button>
    );
  }
  const cls = [action.className, small ? 'btn--sm' : null].filter(Boolean).join(' ') || undefined;
  return (
    <button type="button" className={cls}>
      {text}
    </button>
  );
}

/** Нейтральное второстепенное действие рядом — чтобы было видно соседство. */
function Secondary({ small }: { small?: boolean }) {
  return (
    <button type="button" className={small ? 'btn--ghost btn--sm' : 'btn--ghost'}>
      Отмена
    </button>
  );
}

function Part({
  token,
  highlight,
  label,
  style,
  children,
  as: Tag = 'div',
}: {
  token: string;
  highlight?: string | null;
  label: string;
  style: React.CSSProperties;
  children?: React.ReactNode;
  as?: 'div' | 'span';
}) {
  const on = highlight === token;
  return (
    <Tag
      data-part={token}
      data-part-label={label}
      style={{
        position: 'relative',
        ...style,
        ...(on ? { outline: `3px dashed ${MARKER}`, outlineOffset: 2 } : null),
      }}
    >
      {children}
      {on ? (
        <span
          style={{
            position: 'absolute',
            top: -10,
            right: 6,
            background: MARKER,
            color: '#fff',
            fontSize: 11,
            fontWeight: 700,
            padding: '1px 6px',
            borderRadius: 4,
            whiteSpace: 'nowrap',
            zIndex: 2,
          }}
        >
          {label}
        </span>
      ) : null}
    </Tag>
  );
}

/** Какие токены сцена рисует явно — для подписи «на сцене не используется». */
export const SCENE_TOKENS = new Set([
  '--u-bg',
  '--u-bg-subtle',
  '--u-bg-inset',
  '--u-surface',
  '--u-surface-raised',
  '--u-border',
  '--u-border-strong',
  '--u-text',
  '--u-text-muted',
  '--u-accent',
  '--u-accent-subtle',
  '--u-on-accent',
  '--u-success',
  '--u-success-subtle',
  '--u-warning',
  '--u-warning-subtle',
  '--u-danger',
  '--u-danger-subtle',
]);

export function Scene({
  action,
  highlight,
}: {
  action?: SceneAction | null;
  highlight?: string | null;
}) {
  // Сцен на странице бывает открыто несколько — id поля у каждой свой.
  const fieldId = useId();
  const act = action ?? { set: 'admin', label: 'основная' };
  const h = highlight ?? null;
  const cell: React.CSSProperties = { padding: '6px 10px' };

  return (
    <Part
      token="--u-bg"
      highlight={h}
      label="фон страницы · --u-bg"
      style={{ background: 'var(--u-bg)', padding: 16, borderRadius: 8 }}
    >
      <div data-scene data-scene-action={act.label}>
        {/* Шапка страницы на цветном фоне */}
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
            <Part
              as="span"
              token="--u-text"
              highlight={h}
              label="текст · --u-text"
              style={{ color: 'var(--u-text)', fontWeight: 700, fontSize: 18, display: 'block' }}
            >
              Проект «Альфа»
            </Part>
            <Part
              as="span"
              token="--u-text-muted"
              highlight={h}
              label="второстепенный · --u-text-muted"
              style={{ color: 'var(--u-text-muted)', fontSize: 13, display: 'block' }}
            >
              шапка страницы на фоне · черновик
            </Part>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Secondary />
            <Action action={act} text="Опубликовать" />
          </div>
        </div>

        {/* Карточка с таблицей */}
        <Part
          token="--u-surface"
          highlight={h}
          label="карточка · --u-surface"
          style={{ background: 'var(--u-surface)', borderRadius: 10, padding: 14 }}
        >
          <Part
            token="--u-border"
            highlight={h}
            label="граница · --u-border"
            style={{
              position: 'absolute',
              inset: 0,
              border: '1px solid var(--u-border)',
              borderRadius: 10,
              pointerEvents: 'none',
            }}
          />
          <div style={{ fontWeight: 700, color: 'var(--u-text)', marginBottom: 8 }}>
            Карточка с таблицей
          </div>
          <table style={{ minWidth: 0, width: '100%', borderCollapse: 'collapse' }}>
            <tbody>
              <tr>
                <td colSpan={3} style={{ padding: 0 }}>
                  <Part
                    token="--u-bg-subtle"
                    highlight={h}
                    label="приглушённый фон · --u-bg-subtle"
                    style={{
                      background: 'var(--u-bg-subtle)',
                      ...cell,
                      fontSize: 12,
                      color: 'var(--u-text-muted)',
                    }}
                  >
                    Строка-заголовок группы
                  </Part>
                </td>
              </tr>
              <tr>
                <td style={cell}>Обычная строка</td>
                <td style={cell}>
                  <Part
                    as="span"
                    token="--u-success-subtle"
                    highlight={h}
                    label="успех, фон · --u-success-subtle"
                    style={{
                      background: 'var(--u-success-subtle)',
                      color: 'var(--u-success)',
                      padding: '1px 8px',
                      borderRadius: 999,
                      fontSize: 12,
                    }}
                  >
                    <Part
                      as="span"
                      token="--u-success"
                      highlight={h}
                      label="успех · --u-success"
                      style={{}}
                    >
                      активен
                    </Part>
                  </Part>
                </td>
                <td style={{ ...cell, textAlign: 'right' }}>
                  <Action action={act} text="Открыть" small />
                </td>
              </tr>
              <tr>
                <td colSpan={3} style={{ padding: 0 }}>
                  <Part
                    token="--u-accent-subtle"
                    highlight={h}
                    label="выделение · --u-accent-subtle"
                    style={{
                      background: 'var(--u-accent-subtle)',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      ...cell,
                    }}
                  >
                    <span>Выбранная строка</span>
                    <Part
                      as="span"
                      token="--u-warning-subtle"
                      highlight={h}
                      label="предупреждение, фон · --u-warning-subtle"
                      style={{
                        background: 'var(--u-warning-subtle)',
                        color: 'var(--u-warning)',
                        padding: '1px 8px',
                        borderRadius: 999,
                        fontSize: 12,
                      }}
                    >
                      <Part
                        as="span"
                        token="--u-warning"
                        highlight={h}
                        label="предупреждение · --u-warning"
                        style={{}}
                      >
                        ждёт
                      </Part>
                    </Part>
                    <Action action={act} text="Открыть" small />
                  </Part>
                </td>
              </tr>
            </tbody>
          </table>

          <Part
            token="--u-border-strong"
            highlight={h}
            label="сильная граница · --u-border-strong"
            style={{ borderTop: '1px solid var(--u-border-strong)', margin: '12px 0' }}
          />

          {/* Вставка и форма */}
          <Part
            token="--u-bg-inset"
            highlight={h}
            label="вставка · --u-bg-inset"
            style={{
              background: 'var(--u-bg-inset)',
              borderRadius: 6,
              padding: '8px 10px',
              fontSize: 13,
              color: 'var(--u-text)',
              marginBottom: 10,
            }}
          >
            Вставка внутри карточки: пояснение, цитата, код.{' '}
            <Part
              as="span"
              token="--u-accent"
              highlight={h}
              label="акцент · --u-accent"
              style={{ color: 'var(--u-accent)', fontWeight: 600 }}
            >
              Ссылка-действие
            </Part>
          </Part>
          <div className="field" style={{ marginBottom: 8 }}>
            <label htmlFor={fieldId}>Название</label>
            <input id={fieldId} defaultValue="Альфа" />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Secondary />
            <Action action={act} text="Сохранить" />
          </div>
        </Part>

        {/* Пустой список и окно подтверждения */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            gap: 12,
            marginTop: 12,
          }}
        >
          <div
            style={{
              border: '1px dashed var(--u-border-strong)',
              borderRadius: 10,
              padding: 16,
              textAlign: 'center',
              color: 'var(--u-text-muted)',
            }}
          >
            <div style={{ marginBottom: 8 }}>Пустой список на фоне страницы</div>
            <Action action={act} text="Создать проект" />
          </div>
          <div
            style={{
              background: 'color-mix(in srgb, var(--u-text) 35%, transparent)',
              borderRadius: 10,
              padding: 14,
            }}
          >
            <Part
              token="--u-surface-raised"
              highlight={h}
              label="окно · --u-surface-raised"
              style={{
                background: 'var(--u-surface-raised, var(--u-surface))',
                borderRadius: 10,
                padding: 14,
                boxShadow: 'var(--u-shadow-md)',
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Заблокировать пользователя?</div>
              <Part
                as="span"
                token="--u-danger-subtle"
                highlight={h}
                label="опасность, фон · --u-danger-subtle"
                style={{
                  display: 'block',
                  background: 'var(--u-danger-subtle)',
                  borderRadius: 6,
                  padding: '6px 8px',
                  fontSize: 13,
                  marginBottom: 10,
                }}
              >
                <Part
                  as="span"
                  token="--u-danger"
                  highlight={h}
                  label="опасность · --u-danger"
                  style={{ color: 'var(--u-danger)' }}
                >
                  Сессии будут завершены.
                </Part>
              </Part>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <Secondary />
                <Action action={act} text="Заблокировать" />
              </div>
            </Part>
          </div>
        </div>

        <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
          <Part
            as="span"
            token="--u-on-accent"
            highlight={h}
            label="текст на акценте · --u-on-accent"
            style={{
              background: 'var(--u-accent)',
              color: 'var(--u-on-accent)',
              borderRadius: 6,
              padding: '2px 8px',
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            метка на акценте
          </Part>
        </div>
      </div>
    </Part>
  );
}

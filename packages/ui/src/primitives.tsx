import * as React from 'react';

/**
 * Примитивы интерфейса.
 *
 * Пакет намеренно не тянет ни компонентную библиотеку, ни CSS-in-JS: он
 * описывает форму и состояния, а внешний вид задают токены. Такой примитив
 * переживает смену фреймворка — заменить придётся обвязку, а не решения.
 *
 * Главное здесь — не кнопки, а СОСТОЯНИЯ ЭКРАНА. Загрузка, пустота, ошибка и
 * офлайн существуют в любом интерфейсе, который ходит в сеть; вопрос лишь в
 * том, показаны они пользователю или он смотрит на пустой прямоугольник и
 * гадает, что произошло.
 */

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

/** Тона значка для перебора (каталог `/admin/ui`). */
export const BADGE_TONES = [
  'neutral',
  'accent',
  'success',
  'warning',
  'danger',
] as const satisfies readonly Tone[];

const TONE_VARS: Record<Tone, { fg: string; bg: string }> = {
  neutral: { fg: 'var(--u-text-muted)', bg: 'var(--u-bg-inset)' },
  accent: { fg: 'var(--u-accent)', bg: 'var(--u-accent-subtle)' },
  success: { fg: 'var(--u-success)', bg: 'var(--u-success-subtle)' },
  warning: { fg: 'var(--u-warning)', bg: 'var(--u-warning-subtle)' },
  danger: { fg: 'var(--u-danger)', bg: 'var(--u-danger-subtle)' },
};

// --------------------------------------------------------------------- кнопка

/**
 * Смысловые роли кнопки (рабочее решение владельца 2026-09-24, не окончательное):
 *
 *  * `primary`   — основное действие зоны;
 *  * `secondary` — важное, но не главное: акцентный текст и рамка;
 *  * `quiet`     — тихое («Отмена», «Открыть»): нейтральный текст и серая рамка —
 *                  рядом со `secondary` отличается цветом, а не только весом;
 *  * `danger`    — опасное действие на экране: красный контур;
 *  * `danger-confirm` — последний необратимый шаг в окне подтверждения: заливка.
 *
 * `brand` — вид `primary` с градиентом темы Nova, не отдельная роль.
 * `ghost` — прежнее имя, сохранено как псевдоним `quiet`.
 *
 * Цвета и состояния — классы `u-btn--*` в `tokens.css`: наведение inline-стилем
 * не описывается. Ширину кнопки задаёт экран, не компонент.
 */
export type ButtonVariant =
  'primary' | 'secondary' | 'quiet' | 'danger' | 'danger-confirm' | 'brand' | 'ghost';

/** Роли кнопки для перебора (каталог `/admin/ui`); `ghost` — псевдоним, в перечень не входит. */
export const BUTTON_VARIANTS = [
  'primary',
  'secondary',
  'quiet',
  'danger',
  'danger-confirm',
  'brand',
] as const satisfies readonly ButtonVariant[];

/**
 * Размер элемента: `md` — просторный (кабинеты, 44px — цель нажатия на
 * сенсорном экране), `sm` — плотный (рабочие экраны админки, строки таблиц).
 * Ширину размер не задаёт — её выбирает экран.
 */
export type ControlSize = 'md' | 'sm';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ControlSize;
  /**
   * Кнопка в работе. Блокируется и объявляет это ассистивным технологиям:
   * `aria-busy` — не украшение, без него скринридер сообщит «кнопка», как будто
   * ничего не происходит.
   */
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  children,
  style,
  className,
  ...rest
}: ButtonProps): React.ReactElement {
  const role = variant === 'ghost' ? 'quiet' : variant === 'brand' ? 'primary' : variant;

  return (
    <button
      {...rest}
      data-variant={role}
      data-size={size}
      className={['u-btn', `u-btn--${role}`, variant === 'brand' ? 'u-btn-brand' : null, className]
        .filter(Boolean)
        .join(' ')}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--u-space-2)',
        // 44px — цель нажатия на сенсорном экране; плотный — 30px, нижняя
        // граница удобного попадания мышью (та же, что у админки).
        minHeight: size === 'sm' ? 30 : 44,
        padding: size === 'sm' ? '0 var(--u-space-3)' : '0 var(--u-space-5)',
        borderRadius: 'var(--u-radius-md)',
        fontSize: size === 'sm' ? 'var(--u-text-xs)' : 'var(--u-text-sm)',
        fontWeight: 600,
        fontFamily: 'inherit',
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: disabled || loading ? 0.6 : 1,
        transition:
          'background var(--u-transition), border-color var(--u-transition), opacity var(--u-transition)',
        ...style,
      }}
    >
      {loading ? <Spinner size={16} label="" /> : null}
      {children}
    </button>
  );
}

// ------------------------------------------------------------------- поле ввода

export interface FieldProps {
  label: string;
  htmlFor: string;
  /** Текст ошибки поля. Показывается и связывается с полем через aria. */
  error?: string | null;
  hint?: string;
  children: React.ReactNode;
}

/**
 * Обёртка поля.
 *
 * Ошибка связывается с полем через `aria-describedby` — это делает сама
 * обёртка: подпись красным цветом — сообщение только для тех, кто видит цвет.
 */
export function Field({ label, htmlFor, error, hint, children }: FieldProps): React.ReactElement {
  // Ошибку и подсказку поле получает само: `aria-invalid` включает красную
  // рамку (класс `u-control` в tokens.css), `aria-describedby` связывает поле
  // с текстом — экранный диктор прочтёт его вместе с полем. Явно заданные
  // вызывающим значения не перетираются.
  const describedBy = error ? `${htmlFor}-error` : hint ? `${htmlFor}-hint` : undefined;
  const control = React.isValidElement<Record<string, unknown>>(children)
    ? React.cloneElement(children, {
        'aria-invalid': children.props['aria-invalid'] ?? (error ? true : undefined),
        'aria-describedby': children.props['aria-describedby'] ?? describedBy,
      })
    : children;
  return (
    <div style={{ display: 'grid', gap: 'var(--u-space-2)' }}>
      <label htmlFor={htmlFor} style={{ fontSize: 'var(--u-text-sm)', fontWeight: 600 }}>
        {label}
      </label>
      {control}
      {hint && !error ? (
        <span
          id={`${htmlFor}-hint`}
          style={{ fontSize: 'var(--u-text-xs)', color: 'var(--u-text-muted)' }}
        >
          {hint}
        </span>
      ) : null}
      {error ? (
        <span
          id={`${htmlFor}-error`}
          role="alert"
          style={{ fontSize: 'var(--u-text-xs)', color: 'var(--u-danger)' }}
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}

/*
 * Поля ввода. Цвета, рамка и состояния (наведение, фокус, ошибка через
 * `aria-invalid`, выключенное) — класс `u-control` в tokens.css: состояния
 * inline-стилем не описываются. Здесь — только раскладка по размеру.
 *
 * `width: 100%` — поле заполняет контейнер, который ему выделил экран; саму
 * ширину решает экран, и `style` её переопределяет.
 *
 * Нативный атрибут `size` у input/select заменён размером элемента: число
 * символов для ширины здесь не используется — ширину задаёт экран.
 */
function controlLayout(size: ControlSize, multiline = false): React.CSSProperties {
  const sm = size === 'sm';
  return {
    minHeight: sm ? 32 : 44,
    padding: multiline
      ? sm
        ? 'var(--u-space-2) var(--u-space-3)'
        : 'var(--u-space-3)'
      : '0 var(--u-space-3)',
    fontSize: sm ? 'var(--u-text-sm)' : 'var(--u-text-md)',
    fontFamily: 'inherit',
    width: '100%',
    boxSizing: 'border-box',
  };
}

const controlClass = (size: ControlSize, className?: string) =>
  ['u-control', size === 'sm' ? 'u-control--sm' : null, className].filter(Boolean).join(' ');

export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: ControlSize;
}

export function Input({ size = 'md', style, className, ...rest }: InputProps): React.ReactElement {
  return (
    <input
      {...rest}
      className={controlClass(size, className)}
      style={{ ...controlLayout(size), ...style }}
    />
  );
}

export interface TextAreaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  size?: ControlSize;
}

/** Многострочное поле: тот же вид, что у `Input`; высоту можно тянуть по вертикали. */
export function TextArea({
  size = 'md',
  style,
  className,
  rows = 4,
  ...rest
}: TextAreaProps): React.ReactElement {
  return (
    <textarea
      {...rest}
      rows={rows}
      className={controlClass(size, className)}
      style={{ ...controlLayout(size, true), resize: 'vertical', lineHeight: 1.5, ...style }}
    />
  );
}

export interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: ControlSize;
}

/** Выпадающий список: нативный `<select>` — клавиатура и телефон работают сами. */
export function Select({
  size = 'md',
  style,
  className,
  children,
  ...rest
}: SelectProps): React.ReactElement {
  return (
    <select
      {...rest}
      className={controlClass(size, className)}
      style={{ ...controlLayout(size), ...style }}
    >
      {children}
    </select>
  );
}

// ------------------------------------------------------- флажок и переключатель

export interface CheckboxProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'size'
> {
  label: React.ReactNode;
  /** Пояснение под подписью — второстепенным цветом. */
  description?: React.ReactNode;
  size?: ControlSize;
}

/**
 * Флажок с подписью. Нативный checkbox — клавиатура, форма и экранный диктор
 * работают сами; вид — `accent-color` скина. `className` и `style` относятся
 * к подписи-обёртке (раскладку задаёт экран), остальные свойства — к полю.
 */
export function Checkbox({
  label,
  description,
  size = 'md',
  className,
  style,
  ...rest
}: CheckboxProps): React.ReactElement {
  return (
    <label
      className={['u-check', size === 'sm' ? 'u-check--sm' : null, className]
        .filter(Boolean)
        .join(' ')}
      style={style}
    >
      <input {...rest} type="checkbox" className="u-check__box" />
      <span>
        {label}
        {description ? <span className="u-check__desc">{description}</span> : null}
      </span>
    </label>
  );
}

/**
 * Переключатель: включение и выключение с немедленным действием («функция
 * включена»). Для выбора в форме, который применяется кнопкой, — `Checkbox`.
 * Под капотом checkbox с `role="switch"`: диктор объявляет «переключатель,
 * включено».
 */
export function Switch({
  label,
  description,
  size = 'md',
  className,
  style,
  ...rest
}: CheckboxProps): React.ReactElement {
  return (
    <label
      className={['u-switch', size === 'sm' ? 'u-switch--sm' : null, className]
        .filter(Boolean)
        .join(' ')}
      style={style}
    >
      <input {...rest} type="checkbox" role="switch" className="u-switch__input" />
      <span className="u-switch__track" aria-hidden="true" />
      <span>
        {label}
        {description ? <span className="u-check__desc">{description}</span> : null}
      </span>
    </label>
  );
}

// ----------------------------------------------------------------- сообщение

export type AlertTone = 'info' | 'success' | 'warning' | 'danger';

/** Тона сообщения для перебора (каталог). */
export const ALERT_TONES = [
  'info',
  'success',
  'warning',
  'danger',
] as const satisfies readonly AlertTone[];

export interface AlertProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: AlertTone;
  title?: React.ReactNode;
  size?: ControlSize;
}

/**
 * Сообщение в потоке страницы: итог действия, предупреждение, ошибка.
 *
 * Роль по тону: ошибка и предупреждение — `alert` (диктор перебивает),
 * сведения и успех — `status` (объявляется в очередь). «Сохранено»,
 * прочитанное как тревога, сбивает с толку сильнее, чем тишина.
 */
export function Alert({
  tone = 'info',
  title,
  size = 'md',
  className,
  children,
  ...rest
}: AlertProps): React.ReactElement {
  return (
    <div
      role={tone === 'danger' || tone === 'warning' ? 'alert' : 'status'}
      {...rest}
      data-tone={tone}
      className={['u-alert', `u-alert--${tone}`, size === 'sm' ? 'u-alert--sm' : null, className]
        .filter(Boolean)
        .join(' ')}
    >
      {title ? <strong className="u-alert__title">{title}</strong> : null}
      {children}
    </div>
  );
}

// ----------------------------------------------------------------- контейнеры

export function Card({
  children,
  style,
  ...rest
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      {...rest}
      style={{
        background: 'var(--u-surface)',
        border: '1px solid var(--u-border)',
        borderRadius: 'var(--u-radius-lg)',
        padding: 'var(--u-space-5)',
        boxShadow: 'var(--u-shadow-sm)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: Tone;
  children: React.ReactNode;
}): React.ReactElement {
  const { fg, bg } = TONE_VARS[tone];
  return (
    <span
      style={{
        display: 'inline-block',
        /*
         * Прямой ребёнок grid-контейнера по умолчанию растягивается на всю
         * колонку, и значок статуса превращался в полосу во всю карточку
         * (видно в каталоге инвестора). Во flex-контейнере свойство просто
         * игнорируется, поэтому правка безопасна для остальных мест.
         */
        justifySelf: 'start',
        padding: '2px var(--u-space-3)',
        borderRadius: 'var(--u-radius-pill)',
        background: bg,
        color: fg,
        fontSize: 'var(--u-text-xs)',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

// -------------------------------------------------------------- состояния экрана

export function Spinner({ size = 20, label = 'Загрузка' }: { size?: number; label?: string }) {
  return (
    <span
      role={label ? 'status' : undefined}
      aria-label={label || undefined}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        border: '2px solid var(--u-border-strong)',
        borderTopColor: 'var(--u-accent)',
        borderRadius: '50%',
        animation: 'u-spin 700ms linear infinite',
      }}
    />
  );
}

/**
 * Скелет вместо спиннера там, где известна форма будущего содержимого:
 * прыгающая раскладка после загрузки раздражает сильнее ожидания.
 */
export function Skeleton({
  height = 16,
  width = '100%',
  radius = 'var(--u-radius-sm)',
}: {
  height?: number | string;
  width?: number | string;
  radius?: string;
}): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'block',
        width,
        height,
        borderRadius: radius,
        background: 'var(--u-bg-inset)',
        animation: 'u-pulse 1.4s ease-in-out infinite',
      }}
    />
  );
}

export function LoadingState({ label = 'Загружаем данные' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'grid',
        gap: 'var(--u-space-3)',
        justifyItems: 'center',
        padding: 'var(--u-space-7)',
        color: 'var(--u-text-muted)',
      }}
    >
      <Spinner label="" />
      <span style={{ fontSize: 'var(--u-text-sm)' }}>{label}</span>
    </div>
  );
}

/**
 * Пустое состояние.
 *
 * Пустой экран без объяснения читается как поломка. Здесь всегда есть ответ на
 * два вопроса: почему пусто и что можно сделать.
 */
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--u-space-3)',
        justifyItems: 'center',
        textAlign: 'center',
        padding: 'var(--u-space-7)',
        border: '1px dashed var(--u-border-strong)',
        borderRadius: 'var(--u-radius-lg)',
      }}
    >
      <strong style={{ fontSize: 'var(--u-text-lg)' }}>{title}</strong>
      {description ? (
        <span style={{ color: 'var(--u-text-muted)', maxWidth: 460 }}>{description}</span>
      ) : null}
      {action}
    </div>
  );
}

/**
 * Состояние ошибки.
 *
 * Обязательно с действием восстановления: экран, сообщающий о сбое и не
 * дающий способа повторить, оставляет пользователя в тупике. Идентификатор
 * запроса показывается, если он есть, — с ним поддержка находит причину, а без
 * него разговор начинается с «а когда это было?».
 */
export function ErrorState({
  title = 'Не удалось загрузить',
  description,
  traceId,
  onRetry,
}: {
  title?: string;
  description?: string;
  traceId?: string | null;
  onRetry?: () => void;
}): React.ReactElement {
  return (
    <div
      role="alert"
      style={{
        display: 'grid',
        gap: 'var(--u-space-3)',
        justifyItems: 'center',
        textAlign: 'center',
        padding: 'var(--u-space-7)',
        border: '1px solid var(--u-danger)',
        background: 'var(--u-danger-subtle)',
        borderRadius: 'var(--u-radius-lg)',
      }}
    >
      <strong style={{ fontSize: 'var(--u-text-lg)', color: 'var(--u-danger)' }}>{title}</strong>
      {description ? <span style={{ maxWidth: 460 }}>{description}</span> : null}
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Повторить
        </Button>
      ) : null}
      {traceId ? (
        <code style={{ fontSize: 'var(--u-text-xs)', color: 'var(--u-text-muted)' }}>
          Идентификатор запроса: {traceId}
        </code>
      ) : null}
    </div>
  );
}

/**
 * Офлайн-состояние. Отдельно от ошибки: причина другая и действие другое —
 * повторять запрос без сети бессмысленно, нужно дождаться соединения.
 */
export function OfflineBanner(): React.ReactElement | null {
  const [online, setOnline] = React.useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  React.useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);

  if (online) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        padding: 'var(--u-space-3) var(--u-space-4)',
        background: 'var(--u-warning-subtle)',
        color: 'var(--u-warning)',
        fontSize: 'var(--u-text-sm)',
        textAlign: 'center',
      }}
    >
      Нет соединения. Данные на экране могли устареть.
    </div>
  );
}

// ------------------------------------------------------------------ раскладка

export function Container({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
}): React.ReactElement {
  return (
    <div
      style={{
        width: '100%',
        maxWidth: 'var(--u-container)',
        margin: '0 auto',
        padding: '0 var(--u-space-4)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * Колонка с равными промежутками.
 *
 * Прочие атрибуты пробрасываются на `div`, как у `Card`: без этого пометки
 * вроде `data-investor-view` молча исчезали из разметки, и проверки,
 * опирающиеся на них, проходили вхолостую (найдено проходом 5.7).
 */
export function Stack({
  gap = 'var(--u-space-4)',
  children,
  style,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { gap?: string }): React.ReactElement {
  return (
    // `minmax(0, 1fr)`, а не умолчание: у grid-элементов минимальная ширина
    // равна min-content, поэтому одна широкая карточка растягивала колонку и
    // вместе с ней всю страницу — на телефоне появлялась горизонтальная
    // прокрутка. С этим ограничением колонка может быть уже содержимого, а
    // переносится уже само содержимое.
    <div
      {...rest}
      style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap, ...style }}
    >
      {children}
    </div>
  );
}

/** Ключевые кадры анимаций: подключаются один раз вместе с примитивами. */
export const UI_KEYFRAMES = `
@keyframes u-spin { to { transform: rotate(360deg); } }
@keyframes u-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
@media (prefers-reduced-motion: reduce) {
  @keyframes u-spin { to { transform: none; } }
  @keyframes u-pulse { 0%, 100% { opacity: 1; } }
}
`;

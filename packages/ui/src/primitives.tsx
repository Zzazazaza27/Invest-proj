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

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

const TONE_VARS: Record<Tone, { fg: string; bg: string }> = {
  neutral: { fg: 'var(--u-text-muted)', bg: 'var(--u-bg-inset)' },
  accent: { fg: 'var(--u-accent)', bg: 'var(--u-accent-subtle)' },
  success: { fg: 'var(--u-success)', bg: 'var(--u-success-subtle)' },
  warning: { fg: 'var(--u-warning)', bg: 'var(--u-warning-subtle)' },
  danger: { fg: 'var(--u-danger)', bg: 'var(--u-danger-subtle)' },
};

// --------------------------------------------------------------------- кнопка

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /**
   * `brand` — тот же primary, но с градиентной заливкой темы: она объявлена
   * классом в `theme-nova.css`, потому что градиент с наведением inline-стилем
   * не описывается. Без темы вариант деградирует до сплошного акцента, а не
   * до прозрачной кнопки.
   */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'brand';
  /**
   * Кнопка в работе. Блокируется и объявляет это ассистивным технологиям:
   * `aria-busy` — не украшение, без него скринридер сообщит «кнопка», как будто
   * ничего не происходит.
   */
  loading?: boolean;
}

export function Button({
  variant = 'primary',
  loading = false,
  disabled,
  children,
  style,
  className,
  ...rest
}: ButtonProps): React.ReactElement {
  const palette: Record<string, React.CSSProperties> = {
    primary: { background: 'var(--u-accent)', color: 'var(--u-text-inverse)', border: 'none' },
    brand: { background: 'var(--u-accent)', color: '#ffffff', border: 'none' },
    secondary: {
      background: 'var(--u-surface)',
      color: 'var(--u-text)',
      border: '1px solid var(--u-border-strong)',
    },
    ghost: { background: 'transparent', color: 'var(--u-accent)', border: 'none' },
    danger: { background: 'var(--u-danger)', color: 'var(--u-text-inverse)', border: 'none' },
  };

  return (
    <button
      {...rest}
      className={
        [variant === 'brand' ? 'u-btn-brand' : null, className].filter(Boolean).join(' ') ||
        undefined
      }
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--u-space-2)',
        // 44px по высоте — минимальная цель нажатия на сенсорном экране.
        minHeight: 44,
        padding: '0 var(--u-space-5)',
        borderRadius: 'var(--u-radius-md)',
        fontSize: 'var(--u-text-sm)',
        fontWeight: 600,
        fontFamily: 'inherit',
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        opacity: disabled || loading ? 0.6 : 1,
        transition: 'background var(--u-transition), opacity var(--u-transition)',
        ...palette[variant],
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
 * Ошибка связывается с полем через `aria-describedby` на стороне вызывающего:
 * подпись красным цветом — это сообщение только для тех, кто видит цвет.
 */
export function Field({ label, htmlFor, error, hint, children }: FieldProps): React.ReactElement {
  return (
    <div style={{ display: 'grid', gap: 'var(--u-space-2)' }}>
      <label htmlFor={htmlFor} style={{ fontSize: 'var(--u-text-sm)', fontWeight: 600 }}>
        {label}
      </label>
      {children}
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

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>): React.ReactElement {
  const { style, ...rest } = props;
  return (
    <input
      {...rest}
      style={{
        minHeight: 44,
        padding: '0 var(--u-space-3)',
        borderRadius: 'var(--u-radius-md)',
        border: '1px solid var(--u-border-strong)',
        background: 'var(--u-surface)',
        color: 'var(--u-text)',
        fontSize: 'var(--u-text-md)',
        fontFamily: 'inherit',
        width: '100%',
        ...style,
      }}
    />
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

export function Stack({
  gap = 'var(--u-space-4)',
  children,
  style,
}: {
  gap?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}): React.ReactElement {
  return <div style={{ display: 'grid', gap, ...style }}>{children}</div>;
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

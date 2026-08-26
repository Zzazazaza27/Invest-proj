import * as React from 'react';

/**
 * Иконочный набор платформы.
 *
 * Один набор на проект (иначе интерфейс собирается из четырёх разных почерков),
 * нарисован здесь, а не подтянут библиотекой: набор из полутора десятков
 * фигур не стоит зависимости, которую придётся обновлять, проверять на CVE и
 * тащить в бандл целиком ради двадцати путей.
 *
 * Правила набора:
 *  - сетка 24×24, штрих 1.75, скруглённые концы — иконки одного веса рядом с
 *    текстом Manrope не «звенят»;
 *  - цвет всегда `currentColor`: иконка наследует цвет текста и потому живёт
 *    в тёмной теме без отдельного набора;
 *  - второй слой (`duotone`) — тот же цвет с прозрачностью, а не второй цвет:
 *    так иконка остаётся читаемой на любом фоне;
 *  - `aria-hidden` по умолчанию. Иконка рядом с подписью — украшение, и
 *    объявлять её скринридеру значит читать смысл дважды. Если иконка ЕДИНСТВЕННОЕ
 *    содержимое кнопки, подпись задаётся на кнопке (`aria-label`), а не здесь.
 */

export type IconName =
  | 'rocket'
  | 'folder'
  | 'card'
  | 'bell'
  | 'building'
  | 'shield'
  | 'sparkles'
  | 'plus'
  | 'chevronRight'
  | 'arrowLeft'
  | 'logout'
  | 'user'
  | 'chart'
  | 'calendar'
  | 'upload'
  | 'lock'
  | 'check'
  | 'chat'
  | 'document';

export interface IconProps extends Omit<React.SVGProps<SVGSVGElement>, 'name'> {
  name: IconName;
  size?: number;
  /** Подпись для случая, когда иконка несёт смысл сама по себе. */
  title?: string;
}

/**
 * Тела иконок.
 *
 * Каждая — пара «мягкая заливка + контур». Заливка идёт первой, чтобы контур
 * лёг поверх и не размылся полупрозрачностью.
 */
const PATHS: Record<IconName, React.ReactNode> = {
  /*
   * Ракета рисуется «в лоб» — корпусом вверх, а не в изометрии по диагонали:
   * повёрнутый силуэт на 20 пикселях сливается в росчерк и перестаёт читаться
   * (проверено скриншотом, первая версия выглядела пером).
   */
  rocket: (
    <>
      <path
        d="M12 2.8c2.6 2.4 4 5.6 4 9.1v2.6l-1.6 1.6H9.6L8 14.5v-2.6c0-3.5 1.4-6.7 4-9.1Z"
        fill="currentColor"
        opacity=".14"
      />
      <path d="M12 2.8c2.6 2.4 4 5.6 4 9.1v2.6l-1.6 1.6H9.6L8 14.5v-2.6c0-3.5 1.4-6.7 4-9.1Z" />
      <circle cx="12" cy="9.6" r="1.7" />
      <path d="M8 11.4 5.4 14v3.4L8 15.6M16 11.4 18.6 14v3.4L16 15.6" />
      <path d="M10.4 18.4c0 1 1.6 2.8 1.6 2.8s1.6-1.8 1.6-2.8" />
    </>
  ),
  folder: (
    <>
      <path
        d="M3.5 7.5c0-1.1.9-2 2-2h3l2 2h8c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2h-13c-1.1 0-2-.9-2-2v-10Z"
        fill="currentColor"
        opacity=".14"
      />
      <path d="M3.5 17.5v-10c0-1.1.9-2 2-2h3.2l2 2h7.8c1.1 0 2 .9 2 2v8c0 1.1-.9 2-2 2h-13c-1.1 0-2-.9-2-2Z" />
    </>
  ),
  card: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" fill="currentColor" opacity=".14" />
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" />
      <path d="M3 10h18M6.5 14.5h4" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16V11a6 6 0 1 1 12 0v5l1.4 2H4.6L6 16Z" fill="currentColor" opacity=".14" />
      <path d="M6 11a6 6 0 1 1 12 0v5l1.4 2H4.6L6 16v-5Z" />
      <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  building: (
    <>
      <path
        d="M4.5 20V6.2c0-.8.6-1.4 1.4-1.4h7c.8 0 1.4.6 1.4 1.4V20"
        fill="currentColor"
        opacity=".14"
      />
      <path d="M3 20h18M4.5 20V6.2c0-.8.6-1.4 1.4-1.4h7c.8 0 1.4.6 1.4 1.4V20M14.3 10h4.3c.8 0 1.4.6 1.4 1.4V20" />
      <path d="M7.5 8.5h3.5M7.5 12h3.5M7.5 15.5h3.5" />
    </>
  ),
  shield: (
    <>
      <path
        d="M12 3.2 19 6v5.4c0 4.2-2.9 7.5-7 9.4-4.1-1.9-7-5.2-7-9.4V6l7-2.8Z"
        fill="currentColor"
        opacity=".14"
      />
      <path d="M12 3.2 19 6v5.4c0 4.2-2.9 7.5-7 9.4-4.1-1.9-7-5.2-7-9.4V6l7-2.8Z" />
      <path d="m9 12 2.2 2.2L15.2 10" />
    </>
  ),
  sparkles: (
    <>
      <path
        d="m12 3.5 1.9 4.9 4.9 1.9-4.9 1.9L12 17.1l-1.9-4.9-4.9-1.9 4.9-1.9L12 3.5Z"
        fill="currentColor"
        opacity=".14"
      />
      <path d="m12 3.5 1.9 4.9 4.9 1.9-4.9 1.9L12 17.1l-1.9-4.9-4.9-1.9 4.9-1.9L12 3.5Z" />
      <path d="M18.5 16.2l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8Z" />
    </>
  ),
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  chevronRight: <path d="m9.5 6 6 6-6 6" />,
  arrowLeft: <path d="M19 12H5.5m0 0 5.5-5.5M5.5 12l5.5 5.5" />,
  logout: (
    <path d="M15 8.5V6.4c0-1-.8-1.9-1.9-1.9H6.4c-1 0-1.9.8-1.9 1.9v11.2c0 1 .8 1.9 1.9 1.9h6.7c1 0 1.9-.8 1.9-1.9v-2.1M10 12h9.5m0 0-3-3m3 3-3 3" />
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" fill="currentColor" opacity=".14" />
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5c.9-3 3.6-4.8 7-4.8s6.1 1.8 7 4.8" />
    </>
  ),
  chart: (
    <>
      <rect x="4" y="12" width="4" height="7.5" rx="1.2" fill="currentColor" opacity=".14" />
      <rect x="4" y="12" width="4" height="7.5" rx="1.2" />
      <rect x="10" y="8" width="4" height="11.5" rx="1.2" />
      <rect x="16" y="4.5" width="4" height="15" rx="1.2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5.5" width="17" height="14" rx="2.5" fill="currentColor" opacity=".14" />
      <rect x="3.5" y="5.5" width="17" height="14" rx="2.5" />
      <path d="M3.5 10h17M8 3.5v4M16 3.5v4" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15.5V4m0 0L7.5 8.5M12 4l4.5 4.5" />
      <path d="M4.5 14.5v3.6c0 1 .8 1.9 1.9 1.9h11.2c1 0 1.9-.8 1.9-1.9v-3.6" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10" width="15" height="10" rx="2.5" fill="currentColor" opacity=".14" />
      <rect x="4.5" y="10" width="15" height="10" rx="2.5" />
      <path d="M8 10V7.8a4 4 0 0 1 8 0V10" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  chat: (
    <>
      <path
        d="M4 6.4c0-1 .8-1.9 1.9-1.9h12.2c1 0 1.9.8 1.9 1.9v7.7c0 1-.8 1.9-1.9 1.9H9.5L5 19.5v-3.5h-1V6.4Z"
        fill="currentColor"
        opacity=".14"
      />
      <path d="M20 14.1c0 1-.8 1.9-1.9 1.9H9.5L5 19.5V16h-.1c-.5 0-.9-.4-.9-.9V6.4c0-1 .8-1.9 1.9-1.9h12.2c1 0 1.9.8 1.9 1.9v7.7Z" />
    </>
  ),
  document: (
    <>
      <path
        d="M6 4.5h7l5 5v10c0 1-.8 1.9-1.9 1.9H6c-1 0-1.9-.8-1.9-1.9V6.4c0-1 .8-1.9 1.9-1.9Z"
        fill="currentColor"
        opacity=".14"
      />
      <path d="M13 4.5H6c-1 0-1.9.8-1.9 1.9v13.2c0 1 .8 1.9 1.9 1.9h10c1 0 1.9-.8 1.9-1.9V9.5L13 4.5Z" />
      <path d="M13 4.5v5h5M8 13.5h7M8 17h5" />
    </>
  ),
};

export function Icon({ name, size = 20, title, style, ...rest }: IconProps): React.ReactElement {
  return (
    <svg
      {...rest}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      style={{ flexShrink: 0, display: 'block', ...style }}
    >
      {title ? <title>{title}</title> : null}
      {PATHS[name]}
    </svg>
  );
}

/**
 * Иконка в плитке — фирменный приём Nova: скруглённый квадрат с подложкой.
 *
 * Вариант `solid` (градиент, белая иконка) выделяет ОДНО действие в группе;
 * если так подсветить всё, выделенным не окажется ничего, поэтому по умолчанию
 * плитка мягкая.
 */
export function IconTile({
  name,
  variant = 'soft',
  size = 44,
  style,
}: {
  name: IconName;
  variant?: 'soft' | 'solid';
  size?: number;
  style?: React.CSSProperties;
}): React.ReactElement {
  const solid = variant === 'solid';
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: Math.round(size * 0.32),
        background: solid ? 'var(--u-brand-gradient)' : 'var(--u-tile-bg)',
        color: solid ? 'var(--u-text-inverse)' : 'var(--u-tile-fg)',
        boxShadow: solid ? '0 8px 20px rgba(75, 46, 224, 0.28)' : 'none',
        ...style,
      }}
    >
      <Icon name={name} size={Math.round(size * 0.5)} />
    </span>
  );
}

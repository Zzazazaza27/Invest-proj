import * as React from 'react';
import { Icon, IconTile, type IconName } from './icons';

/**
 * Компоненты темы Nova.
 *
 * Здесь живут КРУПНЫЕ формы — шапка, плитка, баннер, полоса доверия, — которых
 * не было в наборе примитивов: примитив отвечает за поле и кнопку, а эти
 * задают ритм экрана. Они по-прежнему ничего не знают о домене: принимают
 * заголовок, описание и обработчик, а что именно там написано — дело
 * приложения.
 *
 * Наведение и переходы описаны классами в `theme-nova.css`: inline-стиль не
 * умеет `:hover`, а держать состояние наведения в React ради тени — значит
 * гонять перерисовку на каждое движение мыши.
 */

// -------------------------------------------------------------------- шапка

export function NovaTopBar({
  title,
  subtitle,
  icon = 'rocket',
  actions,
}: {
  title: string;
  subtitle?: string;
  icon?: IconName;
  actions?: React.ReactNode;
}): React.ReactElement {
  return (
    <header className="u-topbar">
      <div className="u-topbar__inner">
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--u-space-3)', minWidth: 0 }}
        >
          <IconTile name={icon} variant="solid" size={40} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 800, letterSpacing: '-0.01em', lineHeight: 1.2 }}>
              {title}
            </div>
            {subtitle ? (
              <div
                style={{
                  fontSize: 'var(--u-text-xs)',
                  color: 'var(--u-text-muted)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {subtitle}
              </div>
            ) : null}
          </div>
        </div>
        {actions ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--u-space-2)' }}>
            {actions}
          </div>
        ) : null}
      </div>
    </header>
  );
}

// ----------------------------------------------------------------- заголовок

export function PageHeading({
  title,
  description,
  aside,
}: {
  title: string;
  description?: string;
  aside?: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        gap: 'var(--u-space-4)',
        flexWrap: 'wrap',
      }}
    >
      <div>
        <h1
          style={{
            margin: 0,
            fontSize: 'var(--u-text-xl)',
            fontWeight: 800,
            letterSpacing: '-0.02em',
          }}
        >
          {title}
        </h1>
        {description ? (
          <p style={{ margin: '6px 0 0', color: 'var(--u-text-muted)' }}>{description}</p>
        ) : null}
      </div>
      {aside}
    </div>
  );
}

// -------------------------------------------------------------------- плитка

/**
 * Кликабельная плитка навигации.
 *
 * Всегда `<button>`, а не `<div onClick>`: клавиатурный вход, роль для
 * скринридера и фокус достаются даром, а не дописываются четырьмя атрибутами.
 */
export function TileCard({
  icon,
  title,
  description,
  onClick,
  tone = 'soft',
  disabled,
}: {
  icon: IconName;
  title: string;
  description?: string;
  onClick?: () => void;
  tone?: 'soft' | 'solid';
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      type="button"
      className="u-tile-card"
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--u-space-3)',
        textAlign: 'left',
        width: '100%',
        padding: 'var(--u-space-4)',
        borderRadius: 'var(--u-radius-lg)',
        border: '1px solid var(--u-border)',
        background: 'var(--u-surface)',
        color: 'var(--u-text)',
        font: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.55 : 1,
        boxShadow: 'var(--u-shadow-sm)',
      }}
    >
      <IconTile name={icon} variant={tone} />
      <span style={{ display: 'grid', gap: 4, minWidth: 0, flex: 1 }}>
        <span style={{ fontWeight: 700, letterSpacing: '-0.01em' }}>{title}</span>
        {description ? (
          <span style={{ fontSize: 'var(--u-text-sm)', color: 'var(--u-text-muted)' }}>
            {description}
          </span>
        ) : null}
      </span>
      <Icon name="chevronRight" size={18} style={{ color: 'var(--u-text-muted)', marginTop: 12 }} />
    </button>
  );
}

/** Сетка плиток: одна колонка на телефоне, дальше — по ширине контейнера. */
export function TileGrid({
  children,
  min = 260,
}: {
  children: React.ReactNode;
  min?: number;
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--u-space-4)',
        gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`,
      }}
    >
      {children}
    </div>
  );
}

// --------------------------------------------------------------- карточка-раздел

/**
 * Карточка раздела с иконкой в шапке. Отличается от примитива `Card` только
 * шапкой — но именно шапка делает экран читаемым списком разделов, а не
 * стопкой прямоугольников.
 */
export function SectionCard({
  icon,
  title,
  description,
  actions,
  children,
  style,
}: {
  icon: IconName;
  title: string;
  description?: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  style?: React.CSSProperties;
}): React.ReactElement {
  return (
    <section
      style={{
        background: 'var(--u-surface)',
        border: '1px solid var(--u-border)',
        borderRadius: 'var(--u-radius-xl, var(--u-radius-lg))',
        padding: 'var(--u-space-5)',
        boxShadow: 'var(--u-shadow-sm)',
        ...style,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--u-space-3)',
          marginBottom: 'var(--u-space-4)',
          flexWrap: 'wrap',
        }}
      >
        <IconTile name={icon} size={40} />
        <div style={{ flex: 1, minWidth: 180 }}>
          <h2 style={{ margin: 0, fontSize: 'var(--u-text-lg)', fontWeight: 800 }}>{title}</h2>
          {description ? (
            <p
              style={{
                margin: '2px 0 0',
                fontSize: 'var(--u-text-sm)',
                color: 'var(--u-text-muted)',
              }}
            >
              {description}
            </p>
          ) : null}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}

// -------------------------------------------------------------------- баннер

/**
 * Градиентный баннер с призывом к действию.
 *
 * Текст на нём белый по тёмному градиенту — контраст держится в обеих темах,
 * потому что градиент в тёмной теме темнеет вместе с фоном, а не остаётся
 * ярким пятном, слепящим ночью.
 */
export function HeroBanner({
  title,
  description,
  action,
  icon = 'sparkles',
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  icon?: IconName;
}): React.ReactElement {
  return (
    <div
      className="u-hero"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--u-space-4)',
        flexWrap: 'wrap',
        padding: 'var(--u-space-5)',
        borderRadius: 'var(--u-radius-xl, var(--u-radius-lg))',
        background: 'var(--u-brand-gradient-deep, var(--u-accent))',
        color: '#ffffff',
        boxShadow: 'var(--u-shadow-md)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 44,
          height: 44,
          borderRadius: 14,
          background: 'rgba(255, 255, 255, 0.16)',
          flexShrink: 0,
        }}
      >
        <Icon name={icon} size={22} />
      </span>
      <div style={{ flex: 1, minWidth: 220 }}>
        <strong style={{ fontSize: 'var(--u-text-lg)', fontWeight: 800, letterSpacing: '-0.01em' }}>
          {title}
        </strong>
        {description ? (
          <p style={{ margin: '4px 0 0', color: 'rgba(255, 255, 255, 0.82)' }}>{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

// ------------------------------------------------------------ полоса доверия

export function TrustStrip({
  items,
}: {
  items: { icon: IconName; title: string; description: string }[];
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--u-space-4)',
        gridTemplateColumns: 'repeat(auto-fit, minmax(min(240px, 100%), 1fr))',
        padding: 'var(--u-space-2) 0',
      }}
    >
      {items.map((item) => (
        <div
          key={item.title}
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--u-space-3)' }}
        >
          <span style={{ color: 'var(--u-tile-fg, var(--u-accent))' }}>
            <Icon name={item.icon} size={22} />
          </span>
          <span style={{ display: 'grid' }}>
            <strong style={{ fontSize: 'var(--u-text-sm)', fontWeight: 700 }}>{item.title}</strong>
            <span style={{ fontSize: 'var(--u-text-xs)', color: 'var(--u-text-muted)' }}>
              {item.description}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ----------------------------------------------------------------- показатель

/** Плитка показателя: число крупно, подпись мелко. */
export function StatCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: IconName;
  label: string;
  value: React.ReactNode;
  hint?: string;
}): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--u-space-3)',
        padding: 'var(--u-space-4)',
        borderRadius: 'var(--u-radius-lg)',
        border: '1px solid var(--u-border)',
        background: 'var(--u-surface)',
        boxShadow: 'var(--u-shadow-sm)',
      }}
    >
      <IconTile name={icon} size={40} />
      <div style={{ display: 'grid' }}>
        <span style={{ fontSize: 'var(--u-text-xs)', color: 'var(--u-text-muted)' }}>{label}</span>
        <strong style={{ fontSize: 'var(--u-text-lg)', fontWeight: 800, letterSpacing: '-0.02em' }}>
          {value}
        </strong>
        {hint ? (
          <span style={{ fontSize: 'var(--u-text-xs)', color: 'var(--u-text-muted)' }}>{hint}</span>
        ) : null}
      </div>
    </div>
  );
}

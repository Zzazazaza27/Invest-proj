import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  SKINS,
  Select,
  TextArea,
} from '@unicorn/ui';
import { Avatar } from './users-shared';
import { SCENE_TOKENS, Scene, type SceneAction } from './ui-catalog-scene';

/*
 * «Элементы интерфейса» — рабочий каталог для оценки скина.
 *
 * Страница ничего не решает и ничего не чинит: она показывает, как ТЕКУЩИЕ
 * элементы админки и `@unicorn/ui` выглядят в выбранном скине, рядом друг с
 * другом и на двух подложках — фоне страницы и карточке. Сливание, ради
 * которого она заведена, видно только так.
 *
 * Скин меняется ТОЛЬКО у блока образцов: атрибут `data-brand` на обёртке, без
 * смены темы приложения и без сохранения выбора. Список скинов — `SKINS` из
 * `@unicorn/ui`; значения цветов читаются из выбранной темы в браузере, а
 * список токенов — из самих файлов темы. Ни одного цвета здесь не зашито.
 *
 * Ограничение, о котором надо помнить: образцы `@unicorn/ui` показаны ВНУТРИ
 * админки, и общие правила её `styles.css` (для button, input, table)
 * действуют и на них. В кабинетах они могут выглядеть чуть иначе.
 */

type Rgb = { r: number; g: number; b: number };

interface TokenView {
  name: string;
  value: string;
  kind: 'color' | 'gradient';
  /** Где объявлен для выбранного скина. */
  origin: 'skin' | 'base' | 'inherited';
}

/** Пары слоёв, которые НЕ должны сливаться. Названия — контракт, значения — из скина. */
const PAIRS: { a: string; b: string; meaning: string }[] = [
  { a: '--u-bg', b: '--u-surface', meaning: 'фон страницы и карточка' },
  { a: '--u-bg', b: '--u-bg-subtle', meaning: 'фон страницы и приглушённый фон' },
  { a: '--u-bg', b: '--u-bg-inset', meaning: 'фон страницы и вставка' },
  { a: '--u-bg', b: '--u-accent-subtle', meaning: 'фон страницы и мягкий акцент (выделение)' },
  { a: '--u-bg-inset', b: '--u-accent-subtle', meaning: 'вставка и мягкий акцент' },
  { a: '--u-surface', b: '--u-bg-inset', meaning: 'карточка и вставка' },
  { a: '--u-surface', b: '--u-border', meaning: 'карточка и её граница' },
  { a: '--u-bg', b: '--u-border', meaning: 'фон страницы и граница' },
  { a: '--u-surface', b: '--u-text-muted', meaning: 'второстепенный текст на карточке' },
  { a: '--u-bg', b: '--u-text-muted', meaning: 'второстепенный текст на фоне страницы' },
  { a: '--u-surface', b: '--u-accent', meaning: 'акцент на карточке' },
];

/** Наведение прозрачной кнопки админки (`styles.css`, .btn--ghost:hover) — производный цвет. */
const ADMIN_GHOST_HOVER = 'color-mix(in srgb, var(--u-text) 7%, var(--u-surface))';

function skinSelectors(id: string): string[] {
  const own = [`[data-brand='${id}']`, `[data-brand="${id}"]`];
  return id === 'base' ? [':root', ...own] : own;
}

/** Токены `--u-*`, объявленные в правилах скина верхнего уровня (без media). */
function declaredIn(id: string): Set<string> {
  const wanted = skinSelectors(id);
  const names = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSStyleRule)) continue;
      const selectors = rule.selectorText.split(',').map((item) => item.trim());
      if (!selectors.some((item) => wanted.includes(item))) continue;
      for (const prop of Array.from(rule.style)) {
        if (prop.startsWith('--u-')) names.add(prop);
      }
    }
  }
  return names;
}

function parseRgb(text: string): Rgb | null {
  const rgb = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(text);
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) };
  const srgb = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(text);
  if (srgb) {
    return { r: Number(srgb[1]) * 255, g: Number(srgb[2]) * 255, b: Number(srgb[3]) * 255 };
  }
  return null;
}

function toHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

function contrast(a: Rgb, b: Rgb): number {
  const lum = (x: Rgb) => 0.2126 * lin(x.r) + 0.7152 * lin(x.g) + 0.0722 * lin(x.b);
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Разница на глаз: расстояние в OKLab ×100 (≈ единицы заметности). */
function deltaE(a: Rgb, b: Rgb): number {
  const ok = ({ r, g, b: bl }: Rgb) => {
    const [R, G, B] = [lin(r), lin(g), lin(bl)];
    const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
    const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
    const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
    return [
      0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
    ];
  };
  const [x, y] = [ok(a), ok(b)];
  return Math.hypot(x[0]! - y[0]!, x[1]! - y[1]!, x[2]! - y[2]!) * 100;
}

function distinctWords(d: number): string {
  if (d < 2) return 'на глаз не отличить';
  if (d < 5) return 'едва заметно';
  if (d < 10) return 'заметно';
  return 'хорошо различимы';
}

/** Цвет выражения в контексте блока предпросмотра — через пробный элемент. */
function resolve(probe: HTMLElement, value: string): Rgb | null {
  probe.style.backgroundColor = '';
  probe.style.backgroundColor = value;
  if (!probe.style.backgroundColor) return null;
  return parseRgb(getComputedStyle(probe).backgroundColor);
}

function groupOf(name: string): string {
  if (/--u-(bg|surface)/.test(name)) return 'Фоны и поверхности';
  if (name.startsWith('--u-border')) return 'Границы';
  if (/--u-(text|on-)/.test(name)) return 'Текст';
  if (/--u-(accent|brand)/.test(name)) return 'Акцент и бренд';
  if (/--u-(success|warning|danger|info)/.test(name)) return 'Статусы';
  return 'Прочее';
}

const GROUP_ORDER = [
  'Фоны и поверхности',
  'Границы',
  'Текст',
  'Акцент и бренд',
  'Статусы',
  'Прочее',
];

export function UiCatalogPage() {
  const [skin, setSkin] = useState(() => {
    const current = document.documentElement.dataset.brand;
    return SKINS.some((item) => item.id === current) ? current! : (SKINS[0]?.id ?? 'base');
  });
  const previewRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const [tokens, setTokens] = useState<TokenView[]>([]);
  const [pairs, setPairs] = useState<
    { meaning: string; a: string; b: string; ca?: Rgb; cb?: Rgb; missing?: string }[]
  >([]);
  const [hover, setHover] = useState<{ bg?: Rgb; surface?: Rgb; hover?: Rgb }>({});

  const pageSkin = document.documentElement.dataset.brand ?? 'base';

  // Пересчёт после отрисовки: значения читаются у блока уже в новом скине.
  useLayoutEffect(() => {
    const preview = previewRef.current;
    const probe = probeRef.current;
    if (!preview || !probe) return;
    const computed = getComputedStyle(preview);
    const own = declaredIn(skin);
    const base = declaredIn('base');
    const all = new Set([...base, ...own]);
    // Токены других скинов тоже показываем: в этом скине их нет, и образцы,
    // которые на них опираются, берут значение у страницы.
    for (const other of SKINS)
      if (other.id !== skin) for (const n of declaredIn(other.id)) all.add(n);

    const list: TokenView[] = [];
    for (const name of Array.from(all).sort()) {
      const value = computed.getPropertyValue(name).trim();
      if (!value) continue;
      const kind = value.includes('gradient') ? 'gradient' : resolve(probe, value) ? 'color' : null;
      if (!kind) continue;
      const origin = own.has(name) ? 'skin' : base.has(name) ? 'base' : 'inherited';
      list.push({ name, value, kind, origin });
    }
    setTokens(list);

    const val = (name: string) =>
      all.has(name) ? resolve(probe, computed.getPropertyValue(name).trim()) : null;
    setPairs(
      PAIRS.map(({ a, b, meaning }) => {
        const ca = val(a);
        const cb = val(b);
        return ca && cb ? { meaning, a, b, ca, cb } : { meaning, a, b, missing: !ca ? a : b };
      }),
    );
    setHover({
      bg: val('--u-bg') ?? undefined,
      surface: val('--u-surface') ?? undefined,
      hover: resolve(probe, ADMIN_GHOST_HOVER) ?? undefined,
    });
  }, [skin]);

  const current = SKINS.find((item) => item.id === skin);

  return (
    <div data-page="ui-catalog">
      <div className="page-head">
        <div>
          <h1>Элементы интерфейса</h1>
          <p className="page-hint">
            Каталог для оценки скина: реальные элементы админки и <code>@unicorn/ui</code> рядом, на
            фоне страницы и на карточке. Скин ниже меняется только в этом блоке — тема платформы и
            твои настройки не трогаются.
          </p>
        </div>
      </div>

      <section className="card" data-block="skin-choice">
        <h2>Скин предпросмотра</h2>
        <div className="toolbar" role="radiogroup" aria-label="Скин предпросмотра">
          {SKINS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={item.id === skin}
              className={item.id === skin ? undefined : 'btn--ghost'}
              data-skin-option={item.id}
              onClick={() => setSkin(item.id)}
            >
              {item.title}
              {item.id === pageSkin ? ' · сейчас на платформе' : ''}
            </button>
          ))}
        </div>
        <p className="small muted" style={{ marginTop: 8 }}>
          Значения: {current?.source}. Светлый или тёмный вариант — по настройке системы. Новый скин
          подключается по инструкции в <code>packages/ui/src/skins.ts</code>.
        </p>
      </section>

      <div
        ref={previewRef}
        data-brand={skin}
        data-skin-preview={skin}
        style={{
          background: 'var(--u-bg)',
          color: 'var(--u-text)',
          fontFamily: 'var(--u-font)',
          padding: 16,
          borderRadius: 'var(--u-radius-lg)',
          border: '1px dashed var(--u-border-strong)',
        }}
      >
        <span ref={probeRef} aria-hidden="true" style={{ display: 'none' }} />

        <TokensBlock tokens={tokens} skinTitle={current?.title ?? skin} />
        <PairsBlock pairs={pairs} hover={hover} />

        <h2 style={{ marginTop: 24 }}>Кнопки</h2>
        <p className="small muted">
          Наведение, нажатие и фокус — живые: наведи курсор, нажми, пройди клавишей Tab. Выключенное
          и загрузка показаны статично.
        </p>
        <Surfaces>{() => <ButtonsTable />}</Surfaces>

        <h2 style={{ marginTop: 24 }}>Поля</h2>
        <Surfaces>{(where) => <FieldsBlock where={where} />}</Surfaces>

        <h2 style={{ marginTop: 24 }}>Статусы</h2>
        <Surfaces>{() => <StatusBlock />}</Surfaces>

        <h2 style={{ marginTop: 24 }}>Таблица</h2>
        <p className="small muted">
          В <code>@unicorn/ui</code> компонента таблицы нет — показан только вариант админки. У
          строк админки нет состояния наведения.
        </p>
        <Surfaces>{() => <TableSample />}</Surfaces>

        <h2 style={{ marginTop: 24 }}>Аватары</h2>
        <p className="small muted">
          В <code>@unicorn/ui</code> аватара нет — показан вариант админки: обычный и для цветного
          фона (<code>raised</code>).
        </p>
        <Surfaces>{() => <AvatarsSample />}</Surfaces>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- подложки */

function Surfaces({ children }: { children: (where: 'page' | 'card') => React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div data-surface="page" style={{ padding: 12, background: 'var(--u-bg)' }}>
        <div className="small muted" style={{ marginBottom: 8 }}>
          На фоне страницы (--u-bg)
        </div>
        {children('page')}
      </div>
      <div
        data-surface="card"
        style={{
          padding: 12,
          background: 'var(--u-surface)',
          border: '1px solid var(--u-border)',
          borderRadius: 'var(--u-radius-md)',
        }}
      >
        <div className="small muted" style={{ marginBottom: 8 }}>
          На карточке (--u-surface)
        </div>
        {children('card')}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- цвета */

function Swatch({ value }: { value: string }) {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 44,
        height: 28,
        borderRadius: 6,
        border: '1px solid var(--u-border-strong)',
        // Градиент и цвет — одно свойство background; kind нужен только подписи.
        background: value,
        verticalAlign: 'middle',
      }}
    />
  );
}

const ORIGIN_LABEL: Record<TokenView['origin'], string> = {
  skin: 'объявлен в скине',
  base: 'из базовой',
  inherited: 'в скине нет — взят у страницы',
};

function TokensBlock({ tokens, skinTitle }: { tokens: TokenView[]; skinTitle: string }) {
  const [open, setOpen] = useState<string | null>(null);
  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: tokens.filter((token) => groupOf(token.name) === group),
  })).filter((entry) => entry.items.length > 0);
  return (
    <section className="card" data-block="tokens">
      <h2>Цвета скина «{skinTitle}»</h2>
      <p className="small muted">
        Список — из файлов темы, значения — из выбранного скина. «В скине нет — взят у страницы»:
        токен объявлен только в другом скине, и образцы, которые на него опираются, здесь выглядят
        как на платформе.
      </p>
      {groups.map(({ group, items }) => (
        <div key={group} style={{ marginTop: 12 }}>
          <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>{group}</h3>
          <table style={{ minWidth: 0 }}>
            <tbody>
              {items.map((token) => (
                <Fragment key={token.name}>
                  <tr data-token={token.name} data-token-origin={token.origin}>
                    <td style={{ width: 60 }}>
                      <Swatch value={token.value} />
                    </td>
                    <td>
                      <code>{token.name}</code>
                    </td>
                    <td className="small" style={{ fontFamily: 'var(--u-font-mono)' }}>
                      {token.value.length > 60 ? `${token.value.slice(0, 60)}…` : token.value}
                    </td>
                    <td className={token.origin === 'inherited' ? 'small' : 'small muted'}>
                      {token.origin === 'inherited' ? (
                        <span className="badge badge--warn">{ORIGIN_LABEL[token.origin]}</span>
                      ) : (
                        ORIGIN_LABEL[token.origin]
                      )}
                    </td>
                    <td style={{ width: 90 }}>
                      {SCENE_TOKENS.has(token.name) ? (
                        <SceneToggle
                          open={open === token.name}
                          onClick={() =>
                            setOpen((value) => (value === token.name ? null : token.name))
                          }
                        />
                      ) : (
                        <span className="small muted">на сцене нет</span>
                      )}
                    </td>
                  </tr>
                  {open === token.name ? (
                    <SceneRow colSpan={5}>
                      <Scene highlight={token.name} />
                    </SceneRow>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

function PairsBlock({
  pairs,
  hover,
}: {
  pairs: { meaning: string; a: string; b: string; ca?: Rgb; cb?: Rgb; missing?: string }[];
  hover: { bg?: Rgb; surface?: Rgb; hover?: Rgb };
}) {
  const row = (key: string, meaning: string, label: React.ReactNode, ca?: Rgb, cb?: Rgb) => {
    const d = ca && cb ? deltaE(ca, cb) : null;
    return (
      <tr key={key} data-pair={key}>
        <td>{meaning}</td>
        <td className="small">{label}</td>
        <td>
          {ca && cb ? (
            <span style={{ display: 'inline-flex' }}>
              <span style={{ width: 28, height: 22, background: toHex(ca) }} />
              <span style={{ width: 28, height: 22, background: toHex(cb) }} />
            </span>
          ) : null}
        </td>
        <td className="num">{d === null ? '—' : d.toFixed(1)}</td>
        <td className="num">{ca && cb ? `${contrast(ca, cb).toFixed(2)}:1` : '—'}</td>
        <td>
          {d === null ? (
            <span className="muted">нет в скине</span>
          ) : d < 5 ? (
            <span className="badge badge--warn">{distinctWords(d)}</span>
          ) : (
            <span className="muted">{distinctWords(d)}</span>
          )}
        </td>
      </tr>
    );
  };
  return (
    <section className="card" data-block="pairs" style={{ marginTop: 16 }}>
      <h2>Различимость соседних слоёв</h2>
      <p className="small muted">
        Разница — расстояние в OKLab ×100: меньше 2 на глаз не отличить, меньше 5 едва заметно.
        Контраст — по WCAG, для текста нужно не меньше 4,5:1. Это подписи, а не проверка: решение о
        допустимом — за тобой.
      </p>
      <table>
        <thead>
          <tr>
            <th>Что с чем</th>
            <th>Токены</th>
            <th>Образец</th>
            <th className="num">Разница</th>
            <th className="num">Контраст</th>
            <th>На глаз</th>
          </tr>
        </thead>
        <tbody>
          {pairs.map((pair) =>
            row(
              `${pair.a}|${pair.b}`,
              pair.meaning,
              <>
                <code>{pair.a}</code> / <code>{pair.b}</code>
              </>,
              pair.ca,
              pair.cb,
            ),
          )}
          {row(
            'ghost-hover|bg',
            'наведение кнопки админки и фон страницы',
            <>
              <code>.btn--ghost:hover</code> / <code>--u-bg</code>
            </>,
            hover.hover,
            hover.bg,
          )}
          {row(
            'ghost-hover|surface',
            'наведение кнопки админки и карточка',
            <>
              <code>.btn--ghost:hover</code> / <code>--u-surface</code>
            </>,
            hover.hover,
            hover.surface,
          )}
        </tbody>
      </table>
    </section>
  );
}

/* ---------------------------------------------------------------- кнопки */

const ADMIN_BUTTONS: { label: string; className?: string }[] = [
  { label: 'основная' },
  { label: 'основная, sm', className: 'btn--sm' },
  { label: 'ghost', className: 'btn--ghost' },
  { label: 'ghost, sm', className: 'btn--ghost btn--sm' },
  { label: 'danger', className: 'btn--danger' },
];

const UI_BUTTONS = ['primary', 'secondary', 'ghost', 'danger', 'brand'] as const;

/** Кнопка «Показать в сцене» — раскрывает сцену прямо под строкой образца. */
function SceneToggle({ open, onClick }: { open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="btn--ghost btn--sm"
      aria-expanded={open}
      data-scene-toggle
      onClick={onClick}
    >
      {open ? 'Скрыть' : 'Показать'}
    </button>
  );
}

function SceneRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr data-scene-row>
      <td colSpan={colSpan} style={{ padding: '8px 0 14px' }}>
        {children}
      </td>
    </tr>
  );
}

function ButtonsTable() {
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (key: string) => setOpen((value) => (value === key ? null : key));
  return (
    <table style={{ minWidth: 640 }} data-sample="buttons">
      <thead>
        <tr>
          <th>Набор</th>
          <th>Вариант</th>
          <th>Живая</th>
          <th>Выключена</th>
          <th>Загрузка</th>
          <th>Сцена</th>
        </tr>
      </thead>
      <tbody>
        {ADMIN_BUTTONS.map((item) => {
          const key = `admin:${item.label}`;
          const action: SceneAction = {
            set: 'admin',
            className: item.className?.replace('btn--sm', '').trim() || undefined,
            label: `админка · ${item.className ?? 'button'}`,
          };
          return (
            <Fragment key={key}>
              <tr data-button-sample={key}>
                <td className="small muted">админка</td>
                <td>
                  <code>{item.className ?? 'button'}</code>
                </td>
                <td>
                  <button type="button" className={item.className}>
                    Действие
                  </button>
                </td>
                <td>
                  <button type="button" className={item.className} disabled>
                    Действие
                  </button>
                </td>
                <td className="small muted">нет состояния</td>
                <td>
                  <SceneToggle open={open === key} onClick={() => toggle(key)} />
                </td>
              </tr>
              {open === key ? (
                <SceneRow colSpan={6}>
                  <Scene action={action} />
                </SceneRow>
              ) : null}
            </Fragment>
          );
        })}
        {UI_BUTTONS.map((variant) => {
          const key = `ui:${variant}`;
          return (
            <Fragment key={key}>
              <tr data-button-sample={key}>
                <td className="small muted">@unicorn/ui</td>
                <td>
                  <code>{variant}</code>
                </td>
                <td>
                  <Button variant={variant}>Действие</Button>
                </td>
                <td>
                  <Button variant={variant} disabled>
                    Действие
                  </Button>
                </td>
                <td>
                  <Button variant={variant} loading>
                    Действие
                  </Button>
                </td>
                <td>
                  <SceneToggle open={open === key} onClick={() => toggle(key)} />
                </td>
              </tr>
              {open === key ? (
                <SceneRow colSpan={6}>
                  <Scene action={{ set: 'ui', variant, label: `@unicorn/ui · ${variant}` }} />
                </SceneRow>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ поля */

function FieldsBlock({ where }: { where: 'page' | 'card' }) {
  const id = (name: string) => `ui-catalog-${where}-${name}`;
  return (
    <div className="grid-2" data-sample="fields">
      <div>
        <div className="small muted" style={{ marginBottom: 6 }}>
          админка (<code>.field</code>)
        </div>
        <div className="field">
          <label htmlFor={id('a-empty')}>Пустое с подсказкой внутри</label>
          <input id={id('a-empty')} placeholder="Название проекта" />
          <div className="field__hint">Подсказка под полем.</div>
        </div>
        <div className="field">
          <label htmlFor={id('a-filled')}>Заполненное</label>
          <input id={id('a-filled')} defaultValue="Пятый элемент" />
        </div>
        <div className="field">
          <label htmlFor={id('a-disabled')}>Выключенное</label>
          <input id={id('a-disabled')} defaultValue="Нельзя изменить" disabled />
        </div>
        <div className="field">
          <label htmlFor={id('a-select')}>Список</label>
          <select id={id('a-select')} defaultValue="b">
            <option value="a">Первый</option>
            <option value="b">Второй</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={id('a-select-sm')}>Маленький список</label>
          <select id={id('a-select-sm')} className="select--sm" style={{ width: 'auto' }}>
            <option>Кабинет…</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={id('a-text')}>Многострочное</label>
          <textarea id={id('a-text')} rows={2} defaultValue="Текст в две строки" />
        </div>
        <label className="switch">
          <input type="checkbox" defaultChecked />
          Переключатель
        </label>
        <p className="small muted">Состояния ошибки у полей админки нет.</p>
      </div>
      <div>
        <div className="small muted" style={{ marginBottom: 6 }}>
          @unicorn/ui (<code>Field</code>)
        </div>
        <Field
          label="Пустое с подсказкой внутри"
          htmlFor={id('u-empty')}
          hint="Подсказка под полем."
        >
          <Input id={id('u-empty')} placeholder="Название проекта" />
        </Field>
        <Field label="Заполненное" htmlFor={id('u-filled')}>
          <Input id={id('u-filled')} defaultValue="Пятый элемент" />
        </Field>
        <Field label="С ошибкой" htmlFor={id('u-error')} error="Название обязательно">
          <Input id={id('u-error')} aria-invalid="true" />
        </Field>
        <Field label="Выключенное" htmlFor={id('u-disabled')}>
          <Input id={id('u-disabled')} defaultValue="Нельзя изменить" disabled />
        </Field>
        <Field label="Список" htmlFor={id('u-select')}>
          <Select id={id('u-select')} defaultValue="b">
            <option value="a">Первый</option>
            <option value="b">Второй</option>
          </Select>
        </Field>
        <Field label="Многострочное" htmlFor={id('u-text')}>
          <TextArea id={id('u-text')} rows={2} defaultValue="Текст в две строки" />
        </Field>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- статусы */

const STATUS_ROWS: {
  meaning: string;
  badge?: string;
  alert?: string;
  tone?: 'neutral' | 'accent' | 'success' | 'warning' | 'danger';
}[] = [
  { meaning: 'нейтральный', badge: 'muted', tone: 'neutral' },
  { meaning: 'акцент', tone: 'accent' },
  { meaning: 'успех', badge: 'ok', alert: 'ok', tone: 'success' },
  { meaning: 'предупреждение', badge: 'warn', tone: 'warning' },
  { meaning: 'опасность / ошибка', badge: 'danger', alert: 'error', tone: 'danger' },
  { meaning: 'сведения', alert: 'info' },
];

function StatusBlock() {
  return (
    <div data-sample="statuses">
      <table style={{ minWidth: 640 }}>
        <thead>
          <tr>
            <th>Смысл</th>
            <th>Значок админки</th>
            <th>Плашка админки</th>
            <th>Badge @unicorn/ui</th>
          </tr>
        </thead>
        <tbody>
          {STATUS_ROWS.map((row) => (
            <tr key={row.meaning}>
              <td>{row.meaning}</td>
              <td>
                {row.badge ? (
                  <span className={`badge badge--${row.badge}`}>{row.badge}</span>
                ) : (
                  <span className="small muted">нет</span>
                )}
              </td>
              <td>
                {row.alert ? (
                  <div className={`alert alert--${row.alert}`} style={{ margin: 0 }}>
                    alert--{row.alert}
                  </div>
                ) : (
                  <span className="small muted">нет</span>
                )}
              </td>
              <td>
                {row.tone ? (
                  <Badge tone={row.tone}>{row.tone}</Badge>
                ) : (
                  <span className="small muted">нет</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="grid-2" style={{ marginTop: 12 }}>
        <EmptyState title="Пусто (EmptyState)" />
        <ErrorState title="Ошибка (ErrorState)" />
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- таблица */

function TableSample() {
  return (
    <table data-sample="table">
      <thead>
        <tr>
          <th>Имя</th>
          <th>Состояние</th>
          <th className="num">Сумма, ₽</th>
          <th>Действия</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>Обычная строка</td>
          <td>
            <span className="badge badge--ok">активен</span>
          </td>
          <td className="num">1 250 000</td>
          <td>
            <div className="row-actions">
              <button type="button" className="btn--ghost btn--sm">
                Открыть
              </button>
            </div>
          </td>
        </tr>
        <tr>
          <td>
            Длинное имя, которое не помещается в ширину столбца и переносится на следующую строку
          </td>
          <td>
            <span className="badge badge--muted">черновик</span>
          </td>
          <td className="num">—</td>
          <td>
            <div className="row-actions">
              <button type="button" className="btn--ghost btn--sm">
                Открыть
              </button>
              <button type="button" className="btn--danger btn--sm">
                Удалить
              </button>
            </div>
          </td>
        </tr>
        <tr>
          <td>Строка с предупреждением</td>
          <td>
            <span className="badge badge--warn">ждёт</span>
          </td>
          <td className="num">87 500</td>
          <td>
            <span className="muted small">нет действий</span>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

/* --------------------------------------------------------------- аватары */

// Образец фото: встроенный SVG, чтобы страница не зависела от загруженных файлов.
const SAMPLE_PHOTO =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#8aa0c8"/><circle cx="24" cy="19" r="9" fill="#e8edf6"/><rect x="10" y="31" width="28" height="17" rx="10" fill="#e8edf6"/></svg>',
  );

function AvatarsSample() {
  const letter = { displayName: 'Ирина', avatarUrl: null };
  const photo = { displayName: 'Ирина', avatarUrl: SAMPLE_PHOTO };
  const cell = (label: string, node: React.ReactNode) => (
    <div style={{ display: 'grid', justifyItems: 'center', gap: 4 }}>
      {node}
      <span className="small muted">{label}</span>
    </div>
  );
  return (
    <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }} data-sample="avatars">
      {cell('буква, 32', <Avatar user={letter} size={32} />)}
      {cell('буква, 48', <Avatar user={letter} size={48} />)}
      {cell('raised, 48', <Avatar user={letter} size={48} raised />)}
      {cell('фото, 32', <Avatar user={photo} size={32} />)}
      {cell('фото, 48', <Avatar user={photo} size={48} />)}
    </div>
  );
}

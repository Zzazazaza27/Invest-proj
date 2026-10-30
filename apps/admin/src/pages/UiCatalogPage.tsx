import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { SKIN_IDS, type SkinId } from '@unicorn/contracts';
import {
  ALERT_TONES,
  Alert,
  BADGE_TONES,
  BUTTON_VARIANTS,
  Checkbox,
  Switch,
  type AlertTone,
  type Tone,
  Badge,
  Button,
  EmptyState,
  ErrorState,
  Field,
  Input,
  PromptDialog,
  SKINS,
  Select,
  TextArea,
  Toast,
} from '@unicorn/ui';
import { api } from '../api';
import { problemText } from '../lib/format';
import { Avatar } from './users-shared';
import { SCENE_TOKENS, Scene, SceneModal, type SceneAction } from './ui-catalog-scene';
import { ButtonRoles } from './ui-catalog-roles';

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

/** Название скина для подписей; неизвестный показывается своим кодом. */
const titleOf = (id: string) => SKINS.find((item) => item.id === id)?.title ?? id;

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

  /**
   * Скин всей платформы — с сервера (`/v1/features`). Пока ответа нет —
   * то, что поставил загрузчик скина на эту страницу.
   */
  const [platformSkin, setPlatformSkin] = useState<string | null>(
    document.documentElement.dataset.brand ?? null,
  );
  const [applying, setApplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [applyNotice, setApplyNotice] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    api
      .platformSkin()
      .then(setPlatformSkin)
      .catch(() => undefined);
  }, []);

  const apply = async (reason: string) => {
    setApplying(false);
    setBusy(true);
    setApplyNotice(null);
    try {
      const saved = await api.setPlatformSkin(skin as SkinId, reason);
      setPlatformSkin(saved.skin);
      // Сама админка тоже переходит на новый скин сразу, без перезагрузки.
      document.documentElement.dataset.brand = saved.skin;
      setApplyNotice({
        ok: true,
        text: `Скин «${titleOf(saved.skin)}» применён для всей платформы. Остальные интерфейсы откроются в нём после обновления страницы.`,
      });
    } catch (err) {
      setApplyNotice({ ok: false, text: problemText(err, 'Не удалось применить скин') });
    } finally {
      setBusy(false);
    }
  };

  // Списки скинов на сервере (контракты) и в интерфейсе (packages/ui) должны
  // совпадать; расхождение показывается здесь, а не всплывает на экранах.
  const skinMismatch = [
    ...SKIN_IDS.filter((id) => !SKINS.some((item) => item.id === id)),
    ...SKINS.map((item) => item.id).filter((id) => !(SKIN_IDS as readonly string[]).includes(id)),
  ];

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
            Как выглядят элементы интерфейса в выбранном скине: элементы админки и общего набора
            кабинетов рядом, на фоне страницы и на карточке. Выбор скина ниже — только предпросмотр
            на этой странице; вся платформа меняется кнопкой «Применить».
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
              {item.id === platformSkin ? ' · сейчас на платформе' : ''}
            </button>
          ))}
        </div>

        <div
          style={{
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap',
            marginTop: 12,
          }}
          data-skin-apply
        >
          <span className="small">
            Сейчас на платформе:{' '}
            <strong data-platform-skin={platformSkin ?? ''}>
              {platformSkin ? titleOf(platformSkin) : '…'}
            </strong>
          </span>
          <Button
            size="sm"
            variant="primary"
            data-skin-apply-button
            disabled={busy || platformSkin === null || skin === platformSkin}
            onClick={() => setApplying(true)}
          >
            {`Применить «${titleOf(skin)}» для всей платформы`}
          </Button>
        </div>
        {applyNotice ? (
          <Alert
            size="sm"
            tone={applyNotice.ok ? 'success' : 'danger'}
            data-skin-apply-notice
            style={{ marginTop: 10 }}
          >
            {applyNotice.text}
          </Alert>
        ) : null}
        {skinMismatch.length > 0 ? (
          <Alert size="sm" tone="danger" style={{ marginTop: 10 }}>
            Списки скинов на сервере и в интерфейсе расходятся: {skinMismatch.join(', ')}.
          </Alert>
        ) : null}
        <PromptDialog
          open={applying}
          title="Применить скин для всей платформы?"
          description={`Все восемь интерфейсов откроются в скине «${titleOf(skin)}» после обновления страницы. Изменение попадёт в журнал действий.`}
          label="Причина"
          placeholder="Например: переходим на новый фирменный стиль"
          confirmText="Применить"
          onConfirm={(reason) => void apply(reason)}
          onCancel={() => setApplying(false)}
        />

        <p className="small muted" style={{ marginTop: 8 }}>
          Светлый или тёмный вариант — по настройке системы.{' '}
          <span className="ui-cat-code">
            Для разработчика: {current?.source}; новый скин — по инструкции в
            packages/ui/src/skins.ts
          </span>
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
          Кнопки живые: наведи курсор, нажми, пройди клавишей Tab. «Пример» открывает кнопку в
          типовых местах экрана.
        </p>
        <Surfaces>{() => <ButtonsTable />}</Surfaces>

        <h2 style={{ marginTop: 24 }}>Роли кнопок в действиях</h2>
        <p className="small muted">
          Рабочее решение от 24.09, не окончательное: тихая — нейтральная с рамкой, опасная — контур
          на экране и заливка в последнем шаге подтверждения.
        </p>
        <ButtonRoles />

        <h2 style={{ marginTop: 24 }}>Поля</h2>
        <Surfaces>{(where) => <FieldsBlock where={where} />}</Surfaces>

        <h2 style={{ marginTop: 24 }}>Статусы</h2>
        <Surfaces>{() => <StatusBlock />}</Surfaces>

        <h2 style={{ marginTop: 24 }}>Таблица</h2>
        <p className="small muted">
          Таблица есть только в админке, в общем наборе её нет. Строки не подсвечиваются при
          наведении.
        </p>
        <Surfaces>{() => <TableSample />}</Surfaces>

        <h2 style={{ marginTop: 24 }}>Аватары</h2>
        <p className="small muted">Аватар есть только в админке, в общем наборе его нет.</p>
        <Surfaces>{() => <AvatarsSample />}</Surfaces>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- подложки */

/**
 * Две подложки: каждый блок показан на фоне страницы и на карточке —
 * сливание видно только так. У каждой подложки своя рамка и подпись.
 */
function Surfaces({ children }: { children: (where: 'page' | 'card') => React.ReactNode }) {
  const panel = (where: 'page' | 'card', title: string) => (
    <div
      data-surface={where}
      style={{
        border: '1px solid var(--u-border-strong)',
        borderRadius: 'var(--u-radius-md)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '6px 12px',
          fontSize: 12.5,
          fontWeight: 600,
          color: 'var(--u-text-muted)',
          background: 'var(--u-bg-subtle)',
          borderBottom: '1px solid var(--u-border-strong)',
        }}
      >
        {title}
      </div>
      <div
        style={{
          padding: 12,
          background: where === 'page' ? 'var(--u-bg)' : 'var(--u-surface)',
          overflowX: 'auto',
        }}
      >
        {children(where)}
      </div>
    </div>
  );
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      {panel('page', 'На фоне страницы')}
      {panel('card', 'На карточке')}
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
  skin: 'задан в этом скине',
  base: 'берётся из базового скина',
  inherited: 'в этом скине не задан — показан цвет платформы',
};

/**
 * Назначение цвета человеческим языком. Код темы (`--u-…`) — для
 * разработчика, он показан вторым планом. Цвет без записи здесь выводится с
 * пометкой «назначение не описано» — это повод дописать строку, а не ошибка.
 */
const TOKEN_MEANING: Record<string, string> = {
  '--u-bg': 'Фон страницы',
  '--u-page-bg': 'Фон страницы с узором (Nova)',
  '--u-bg-subtle': 'Приглушённый фон: заголовки групп, выключенные поля',
  '--u-bg-inset': 'Вставка внутри карточки: пояснение, цитата, код',
  '--u-surface': 'Карточка, окно, поле ввода',
  '--u-surface-raised': 'Поднятая поверхность: всплывающее окно',
  '--u-tile-bg': 'Плитка со значком: фон',
  '--u-tile-fg': 'Плитка со значком: значок',
  '--u-border': 'Граница карточек и строк таблицы',
  '--u-border-strong': 'Рамка полей и кнопок',
  '--u-text': 'Основной текст',
  '--u-text-muted': 'Второстепенный текст, подсказки',
  '--u-text-inverse': 'Текст на тёмном фоне',
  '--u-on-accent': 'Текст на акцентной заливке',
  '--u-accent': 'Акцент: основная кнопка, ссылки, выбранное',
  '--u-accent-hover': 'Акцент при наведении',
  '--u-accent-subtle': 'Мягкий акцент: выбранная строка, выделение',
  '--u-brand-gradient': 'Фирменный градиент (кнопка brand)',
  '--u-brand-gradient-deep': 'Фирменный градиент, насыщенный',
  '--u-brand-gradient-hover': 'Фирменный градиент при наведении',
  '--u-success': 'Успех: текст и значок',
  '--u-success-subtle': 'Успех: подложка',
  '--u-warning': 'Предупреждение: текст и значок',
  '--u-warning-subtle': 'Предупреждение: подложка',
  '--u-danger': 'Ошибка и опасное действие: текст, рамка',
  '--u-danger-subtle': 'Ошибка: подложка',
};

const meaningOf = (name: string) => TOKEN_MEANING[name] ?? 'назначение не описано';

function TokensBlock({ tokens, skinTitle }: { tokens: TokenView[]; skinTitle: string }) {
  const groups = GROUP_ORDER.map((group) => ({
    group,
    items: tokens.filter((token) => groupOf(token.name) === group),
  })).filter((entry) => entry.items.length > 0);
  return (
    <section className="card" data-block="tokens">
      <h2>Цвета скина «{skinTitle}»</h2>
      <p className="small muted">
        Из каких цветов собран интерфейс и для чего каждый. «Показать» открывает сцену, где цвет
        обведён на месте. Код в теме и значение нужны разработчику.
      </p>
      <table data-tokens-table className="ui-cat-table">
        <thead>
          <tr>
            <th style={{ width: 64 }}>Цвет</th>
            <th>Назначение</th>
            <th>Код в теме</th>
            <th>Значение</th>
            <th style={{ width: 100 }}>Пример</th>
          </tr>
        </thead>
        <tbody>
          {groups.map(({ group, items }) => (
            <Fragment key={group}>
              <tr data-token-group={group} className="ui-cat-group">
                <td colSpan={5}>{group}</td>
              </tr>
              {items.map((token) => (
                <tr key={token.name} data-token={token.name} data-token-origin={token.origin}>
                  <td>
                    <Swatch value={token.value} />
                  </td>
                  <td style={{ fontWeight: 600 }}>
                    {meaningOf(token.name)}
                    {/* Обычно цвет задан в выбранном скине — это не подписывается.
                        Пометка только у исключений. */}
                    {token.origin === 'skin' ? null : (
                      <div style={{ marginTop: 4, fontWeight: 400 }}>
                        <span
                          className={
                            token.origin === 'inherited' ? 'badge badge--warn' : 'small muted'
                          }
                        >
                          {ORIGIN_LABEL[token.origin]}
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="ui-cat-code">{token.name}</td>
                  <td className="ui-cat-code">
                    {token.value.length > 40 ? `${token.value.slice(0, 40)}…` : token.value}
                  </td>
                  <td>
                    {SCENE_TOKENS.has(token.name) ? (
                      <ScenePreview
                        title={`Где на сцене: ${meaningOf(token.name).toLowerCase()}`}
                        render={() => <Scene highlight={token.name} />}
                      />
                    ) : (
                      <span className="small muted">на сцене нет</span>
                    )}
                  </td>
                </tr>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
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
        <td style={{ fontWeight: 600 }}>{meaning}</td>
        <td>
          {ca && cb ? (
            <span
              style={{
                display: 'inline-flex',
                border: '1px solid var(--u-border-strong)',
                borderRadius: 4,
                overflow: 'hidden',
              }}
            >
              <span style={{ width: 28, height: 22, background: toHex(ca) }} />
              <span style={{ width: 28, height: 22, background: toHex(cb) }} />
            </span>
          ) : null}
        </td>
        <td>
          {d === null ? (
            <span className="muted">в этом скине нет</span>
          ) : d < 5 ? (
            <span className="badge badge--warn">{distinctWords(d)}</span>
          ) : (
            <span className="muted">{distinctWords(d)}</span>
          )}
        </td>
        <td className="num">{d === null ? '—' : d.toFixed(1)}</td>
        <td className="num">{ca && cb ? `${contrast(ca, cb).toFixed(1)} : 1` : '—'}</td>
        <td className="ui-cat-code">{label}</td>
      </tr>
    );
  };
  return (
    <section className="card" data-block="pairs" style={{ marginTop: 16 }}>
      <h2>Различимость соседних цветов</h2>
      <p className="small muted">
        Насколько цвета, которые стоят рядом, отличаются друг от друга. «Разница»: меньше 2 — на
        глаз не отличить, 2–5 — едва заметно, больше 10 — хорошо видно. «Контраст» важен, когда один
        из цветов — текст: для чтения нужно не меньше 4,5 : 1. Это подсказка, а не проверка —
        решение за тобой.
      </p>
      <table className="ui-cat-table">
        <thead>
          <tr>
            <th>Что с чем</th>
            <th>Образец</th>
            <th>На глаз</th>
            <th className="num">Разница</th>
            <th className="num">Контраст</th>
            <th>Код в теме</th>
          </tr>
        </thead>
        <tbody>
          {pairs.map((pair) =>
            row(
              `${pair.a}|${pair.b}`,
              pair.meaning,
              <>
                {pair.a} / {pair.b}
              </>,
              pair.ca,
              pair.cb,
            ),
          )}
          {row(
            'ghost-hover|bg',
            'тихая кнопка админки при наведении и фон страницы',
            <>.btn--ghost:hover / --u-bg</>,
            hover.hover,
            hover.bg,
          )}
          {row(
            'ghost-hover|surface',
            'тихая кнопка админки при наведении и карточка',
            <>.btn--ghost:hover / --u-surface</>,
            hover.hover,
            hover.surface,
          )}
        </tbody>
      </table>
    </section>
  );
}

/* ---------------------------------------------------------------- кнопки */

/** Кнопки админки по ролям; плотный размер — отдельный столбец таблицы. */
const ADMIN_BUTTONS: { label: string; role: string; className?: string }[] = [
  { label: 'основная', role: 'Основная' },
  { label: 'ghost', role: 'Тихая', className: 'btn--ghost' },
  { label: 'danger', role: 'Опасная', className: 'btn--danger' },
  { label: 'danger-confirm', role: 'Опасная, подтверждение', className: 'btn--danger-confirm' },
];

/** Роль кнопки общего набора человеческим языком. */
const UI_ROLE: Record<(typeof BUTTON_VARIANTS)[number], string> = {
  primary: 'Основная',
  secondary: 'Второстепенная',
  quiet: 'Тихая',
  danger: 'Опасная',
  'danger-confirm': 'Опасная, подтверждение',
  brand: 'Основная с градиентом (Nova)',
};

/**
 * «Показать» — открывает эталонную сцену с образцом в окне. Окно рисуется
 * рядом с кнопкой, то есть внутри блока предпросмотра, и получает его скин.
 */
function ScenePreview({ title, render }: { title: string; render: () => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        aria-haspopup="dialog"
        data-scene-toggle
        onClick={() => setOpen(true)}
      >
        Показать
      </Button>
      {open ? (
        <SceneModal title={title} onClose={() => setOpen(false)}>
          {render()}
        </SceneModal>
      ) : null}
    </>
  );
}

function ButtonsTable() {
  return (
    <table className="ui-cat-table" data-sample="buttons">
      <thead>
        <tr>
          <th>Роль</th>
          <th>Откуда</th>
          <th>Обычная</th>
          <th>Плотная</th>
          <th>Выключена</th>
          <th>Загрузка</th>
          <th>Пример</th>
        </tr>
      </thead>
      <tbody>
        {ADMIN_BUTTONS.map((item) => {
          const key = `admin:${item.label}`;
          const action: SceneAction = {
            set: 'admin',
            className: item.className,
            label: `админка · ${item.className ?? 'button'}`,
          };
          return (
            <Fragment key={key}>
              <tr data-button-sample={key}>
                <td style={{ fontWeight: 600 }}>{item.role}</td>
                <td>
                  <span className="small">админка</span>{' '}
                  <span className="ui-cat-code">{item.className ?? 'button'}</span>
                </td>
                <td>
                  <button type="button" className={item.className}>
                    Действие
                  </button>
                </td>
                <td>
                  <button
                    type="button"
                    className={[item.className, 'btn--sm'].filter(Boolean).join(' ')}
                  >
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
                  <ScenePreview
                    title={`Пример: ${item.role.toLowerCase()} кнопка (админка)`}
                    render={() => <Scene action={action} />}
                  />
                </td>
              </tr>
            </Fragment>
          );
        })}
        {BUTTON_VARIANTS.map((variant) => {
          const key = `ui:${variant}`;
          return (
            <Fragment key={key}>
              <tr data-button-sample={key}>
                <td style={{ fontWeight: 600 }}>{UI_ROLE[variant]}</td>
                <td>
                  <span className="small">общий набор</span>{' '}
                  <span className="ui-cat-code">{variant}</span>
                </td>
                <td>
                  <Button variant={variant}>Действие</Button>
                </td>
                <td>
                  <Button variant={variant} size="sm">
                    Действие
                  </Button>
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
                  <ScenePreview
                    title={`Пример: ${UI_ROLE[variant].toLowerCase()} кнопка (общий набор)`}
                    render={() => (
                      <Scene action={{ set: 'ui', variant, label: `@unicorn/ui · ${variant}` }} />
                    )}
                  />
                </td>
              </tr>
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

/* ------------------------------------------------------------------ поля */

const none = <span className="small muted">нет состояния</span>;

/**
 * Поля: строки — состояния, столбцы — админка и общий набор в двух размерах.
 * Подписи полей скрыты в aria-label: состояние названо в первом столбце.
 */
function FieldsBlock({ where }: { where: 'page' | 'card' }) {
  const id = (name: string) => `ui-catalog-${where}-${name}`;
  const rows: {
    state: string;
    admin: React.ReactNode;
    md: React.ReactNode;
    sm: React.ReactNode;
  }[] = [
    {
      state: 'Пустое, подсказка внутри',
      admin: <input aria-label="Пустое, админка" placeholder="Название проекта" />,
      md: <Input aria-label="Пустое, обычное" placeholder="Название проекта" />,
      sm: <Input aria-label="Пустое, плотное" size="sm" placeholder="Название проекта" />,
    },
    {
      state: 'Заполненное',
      admin: <input aria-label="Заполненное, админка" defaultValue="Пятый элемент" />,
      md: <Input aria-label="Заполненное, обычное" defaultValue="Пятый элемент" />,
      sm: <Input aria-label="Заполненное, плотное" size="sm" defaultValue="Пятый элемент" />,
    },
    {
      state: 'С ошибкой',
      admin: none,
      md: (
        <Field label="Название" htmlFor={id('err-md')} error="Название обязательно">
          <Input id={id('err-md')} />
        </Field>
      ),
      sm: (
        <Field label="Название" htmlFor={id('err-sm')} error="Название обязательно">
          <Input id={id('err-sm')} size="sm" />
        </Field>
      ),
    },
    {
      state: 'Выключенное',
      admin: <input aria-label="Выключенное, админка" defaultValue="Нельзя изменить" disabled />,
      md: <Input aria-label="Выключенное, обычное" defaultValue="Нельзя изменить" disabled />,
      sm: (
        <Input
          aria-label="Выключенное, плотное"
          size="sm"
          defaultValue="Нельзя изменить"
          disabled
        />
      ),
    },
    {
      state: 'Список',
      admin: (
        <select aria-label="Список, админка" defaultValue="b">
          <option value="a">Первый</option>
          <option value="b">Второй</option>
        </select>
      ),
      md: (
        <Select aria-label="Список, обычный" defaultValue="b">
          <option value="a">Первый</option>
          <option value="b">Второй</option>
        </Select>
      ),
      sm: (
        <Select aria-label="Список, плотный" size="sm" defaultValue="b">
          <option value="a">Первый</option>
          <option value="b">Второй</option>
        </Select>
      ),
    },
    {
      state: 'Многострочное',
      admin: (
        <textarea aria-label="Многострочное, админка" rows={2} defaultValue="Текст в две строки" />
      ),
      md: (
        <TextArea aria-label="Многострочное, обычное" rows={2} defaultValue="Текст в две строки" />
      ),
      sm: (
        <TextArea
          aria-label="Многострочное, плотное"
          size="sm"
          rows={2}
          defaultValue="Текст в две строки"
        />
      ),
    },
  ];

  const toggles: {
    state: string;
    checked?: boolean;
    disabled?: boolean;
    description?: string;
    admin?: boolean;
  }[] = [
    { state: 'Не отмечен', admin: true },
    { state: 'Отмечен', checked: true, admin: true },
    { state: 'С пояснением', checked: true, description: 'Пояснение под подписью.' },
    { state: 'Недоступен', disabled: true },
    { state: 'Недоступен и отмечен', checked: true, disabled: true },
  ];

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <table className="ui-cat-table" data-sample="fields">
        <thead>
          <tr>
            <th style={{ width: 170 }}>Поле ввода</th>
            <th>Админка</th>
            <th>Общий набор, обычное</th>
            <th>Общий набор, плотное</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.state}>
              <td style={{ fontWeight: 600 }}>{row.state}</td>
              <td>{row.admin}</td>
              <td>{row.md}</td>
              <td>{row.sm}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table className="ui-cat-table" data-sample="toggles">
        <thead>
          <tr>
            <th style={{ width: 170 }}>Флажок и переключатель</th>
            <th>Админка</th>
            <th>Флажок, обычный</th>
            <th>Флажок, плотный</th>
            <th>Переключатель, обычный</th>
            <th>Переключатель, плотный</th>
          </tr>
        </thead>
        <tbody>
          {toggles.map((t) => (
            <tr key={t.state}>
              <td style={{ fontWeight: 600 }}>{t.state}</td>
              <td>
                {t.admin ? (
                  <label className="switch">
                    <input
                      type="checkbox"
                      defaultChecked={t.checked}
                      style={{ width: 'auto', margin: 0 }}
                    />
                    Подпись
                  </label>
                ) : (
                  none
                )}
              </td>
              <td data-sample="checkboxes">
                <Checkbox
                  label="Подпись"
                  description={t.description}
                  defaultChecked={t.checked}
                  disabled={t.disabled}
                />
              </td>
              <td>
                <Checkbox
                  label="Подпись"
                  size="sm"
                  description={t.description}
                  defaultChecked={t.checked}
                  disabled={t.disabled}
                />
              </td>
              <td data-sample="switches">
                <Switch
                  label="Подпись"
                  description={t.description}
                  defaultChecked={t.checked}
                  disabled={t.disabled}
                />
              </td>
              <td>
                <Switch
                  label="Подпись"
                  size="sm"
                  description={t.description}
                  defaultChecked={t.checked}
                  disabled={t.disabled}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="small muted" style={{ margin: 0 }}>
        Флажок — выбор в форме, который применяется кнопкой. Переключатель — включение, которое
        срабатывает сразу. «Переключатель» админки на деле флажок в подписи.
      </p>
    </div>
  );
}

/* --------------------------------------------------------------- статусы */

/**
 * Строки выровнены по смыслу. Тона `@unicorn/ui` берутся из перечней пакета
 * (BADGE_TONES, ALERT_TONES) — здесь только сопоставление с админкой.
 */
const STATUS_ROWS: {
  meaning: string;
  badge?: string;
  alert?: string;
  tone?: Tone;
  uiAlert?: AlertTone;
}[] = [
  { meaning: 'нейтральный', badge: 'muted', tone: 'neutral' },
  { meaning: 'акцент', tone: 'accent' },
  { meaning: 'сведения', alert: 'info', uiAlert: 'info' },
  { meaning: 'успех', badge: 'ok', alert: 'ok', tone: 'success', uiAlert: 'success' },
  { meaning: 'предупреждение', badge: 'warn', tone: 'warning', uiAlert: 'warning' },
  {
    meaning: 'опасность / ошибка',
    badge: 'danger',
    alert: 'error',
    tone: 'danger',
    uiAlert: 'danger',
  },
];

// Перечни пакета и сопоставление должны сходиться: новый тон в пакете без
// строки здесь — сразу видно в каталоге, а не молча пропущено.
const MISSING_TONES = [
  ...BADGE_TONES.filter((t) => !STATUS_ROWS.some((r) => r.tone === t)),
  ...ALERT_TONES.filter((t) => !STATUS_ROWS.some((r) => r.uiAlert === t)),
];

function StatusBlock() {
  return (
    <div data-sample="statuses">
      <table className="ui-cat-table">
        <thead>
          <tr>
            <th>Смысл</th>
            <th>Значок, админка</th>
            <th>Плашка, админка</th>
            <th>Значок, общий набор</th>
            <th>Сообщение, общий набор</th>
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
              <td data-alert-sample={row.uiAlert}>
                {row.uiAlert ? (
                  <Alert tone={row.uiAlert} size="sm" title={row.uiAlert}>
                    Текст сообщения.
                  </Alert>
                ) : (
                  <span className="small muted">нет</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {MISSING_TONES.length > 0 ? (
        <p className="small" style={{ color: 'var(--u-danger)' }}>
          В пакете есть тона без строки в каталоге: {MISSING_TONES.join(', ')}
        </p>
      ) : null}
      <div className="grid-2" style={{ marginTop: 12 }}>
        <EmptyState title="Пусто (EmptyState)" />
        <ErrorState title="Ошибка (ErrorState)" />
      </div>
      {/*
        Всплывающее сообщение (Toast, 2.1-W04): в кабинете стоит в стопке
        справа сверху (ToastStack) и само не исчезает. Здесь — в потоке
        страницы, чтобы видеть вид в текущем скине.
      */}
      <div data-sample="toast" style={{ marginTop: 12, maxWidth: 360 }}>
        <Toast
          tone="danger"
          title="Файл не загружен (Toast)"
          onClose={() => undefined}
          actions={
            <>
              <Button size="sm">К материалам</Button>
              <Button size="sm" variant="secondary">
                Понятно
              </Button>
            </>
          }
        >
          «Презентация.pdf», проект «Альфа»: содержимое не соответствует формату. Загрузите другой
          файл.
        </Toast>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- таблица */

function TableSample() {
  return (
    <table data-sample="table" style={{ border: '1px solid var(--u-border-strong)' }}>
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
  return (
    <table className="ui-cat-table" data-sample="avatars">
      <thead>
        <tr>
          <th>Аватар</th>
          <th>Маленький (32)</th>
          <th>Большой (48)</th>
          <th>Где используется</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td style={{ fontWeight: 600 }}>Буква</td>
          <td>
            <Avatar user={letter} size={32} />
          </td>
          <td>
            <Avatar user={letter} size={48} />
          </td>
          <td className="small muted">список пользователей, шапка кабинета</td>
        </tr>
        <tr>
          <td style={{ fontWeight: 600 }}>Буква на цветном фоне</td>
          <td className="small muted">—</td>
          <td>
            <Avatar user={letter} size={48} raised />
          </td>
          <td className="small muted">шапка карточки пользователя</td>
        </tr>
        <tr>
          <td style={{ fontWeight: 600 }}>Фото</td>
          <td>
            <Avatar user={photo} size={32} />
          </td>
          <td>
            <Avatar user={photo} size={48} />
          </td>
          <td className="small muted">когда человек загрузил фото</td>
        </tr>
      </tbody>
    </table>
  );
}

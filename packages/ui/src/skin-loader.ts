import { SKINS } from './skins';

/**
 * Скин платформы при загрузке интерфейса (M145).
 *
 * Администратор применяет скин в каталоге «Элементы интерфейса»; выбор
 * хранится флагом платформы `ui.skin` и отдаётся публичным `GET /v1/features`
 * (поле `skin`). Каждый из восьми интерфейсов вызывает эту функцию в
 * `main.tsx` до первой отрисовки.
 *
 * БЕЗ МЕЛЬКАНИЯ. В `index.html` у `<html>` стоят `data-brand` со скином по
 * умолчанию и `data-skin-pending`; пока последний есть, `tokens.css` держит
 * страницу скрытой. Функция ставит прочитанный скин и снимает
 * `data-skin-pending` — страница впервые показывается уже в нём.
 *
 * НИЧЕГО НЕ ЛОМАЕТСЯ, если настройка недоступна:
 *  * ответа нет дольше `timeoutMs`, ошибка сети, не 200 — берётся последний
 *    скин платформы, который этот браузер уже получал (localStorage); если
 *    его нет — остаётся скин из `index.html`. Страница показывается;
 *  * значение не из `SKINS` (неизвестный скин) — остаётся скин из `index.html`;
 *  * даже если этот код не выполнится вовсе, `tokens.css` показывает
 *    страницу через 2 с сам (анимация `u-skin-reveal`).
 *
 * Запомненный скин — только удобство зрителя на случай сбоя: источник правды
 * — сервер, и при каждом удачном ответе запись обновляется.
 *
 * @param envApiBase `VITE_API_BASE_URL` приложения — нужен только при прямом
 *   запуске dev-сервером (адрес с портом); с `/v1` на конце или без.
 */
export function applyPlatformSkin(envApiBase?: string, timeoutMs = 1500): Promise<void> {
  const root = document.documentElement;
  const known = (value: unknown): value is string =>
    typeof value === 'string' && SKINS.some((item) => item.id === value);
  return fetch(featuresUrl(envApiBase), {
    signal: AbortSignal.timeout(timeoutMs),
    credentials: 'omit',
  })
    .then((response) => (response.ok ? (response.json() as Promise<unknown>) : null))
    .then((body) => {
      if (body === null) throw new Error('настройка скина не ответила');
      const skin = (body as { skin?: unknown }).skin;
      if (known(skin)) {
        root.dataset.brand = skin;
        remember(skin);
      }
    })
    .catch(() => {
      const last = recall();
      if (known(last)) root.dataset.brand = last;
    })
    .finally(() => root.removeAttribute('data-skin-pending'));
}

const STORAGE_KEY = 'unicorn.platform-skin';

// Хранилище браузера бывает недоступно (приватный режим, запрет сайта) —
// тогда просто нет запасного значения.
function remember(skin: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, skin);
  } catch {
    /* без запасного значения */
  }
}

function recall(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Адрес `/v1/features` по тому же правилу, что у API приложений: без порта в
 * адресе страницы — единая точка входа, тот же origin; с портом — ядро на
 * `:4300` или адрес из переменной сборки.
 */
export function featuresUrl(envApiBase?: string): string {
  if (window.location.port === '') return '/v1/features';
  const base = (envApiBase ?? `${window.location.protocol}//${window.location.hostname}:4300`)
    .replace(/\/+$/, '')
    .replace(/\/v1$/, '');
  return `${base}/v1/features`;
}

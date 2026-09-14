#!/usr/bin/env node
/**
 * Проверка кабинета основателя в РЕАЛЬНОМ рендере (`RULES.md` §2).
 *
 * Проверяется не «страница открылась», а рабочий путь целиком: вход настоящей
 * учётной записью, создание заявки, отображение своих проектов и отказ сервера
 * там, где условия не выполнены. Отдельно — что чужой проект в кабинете не
 * появляется: изоляция держится RLS, но увидеть её нарушение можно только
 * глазами интерфейса.
 *
 * Запуск: node scripts/render-check-lab.mjs
 * Требуется: core и кабинет подняты (порты — из .env).
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL, frontendUrl } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const LAB_URL = process.env.LAB_URL ?? frontendUrl('lab');
const CORE_URL = process.env.CORE_URL ?? DEFAULT_CORE_URL;

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.warn(`  OK    ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.warn(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] ??= value;
  }
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER, max: 4 });
const sql = async (text, params = []) => (await pool.query(text, params)).rows;

function blindIndex(email) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${email.trim().toLowerCase()}`, 'utf8')
    .digest();
}

const suffix = `${Date.now() % 1e9}`;
const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

/** Учётная запись заводится через API: кабинет должен работать с настоящей. */
async function register(tag) {
  const email = `lab-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const response = await fetch(`${CORE_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Таймаут обязателен и в прогоне: зависший запрос превращает проверку в
    // бесконечное ожидание вместо честного падения.
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      email,
      password,
      displayName: `Основатель ${tag}`,
      role: 'founder',
      locale: 'ru-RU',
      consents: CONSENTS,
    }),
  });
  if (!response.ok) throw new Error(`регистрация ${tag}: HTTP ${response.status}`);
  const [row] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);
  return { email, password, userId: row.id };
}

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: КАБИНЕТ ОСНОВАТЕЛЯ ===\n');

const owner = await register('owner');
const stranger = await register('stranger');

// Настройки уведомлений владельца: без них список переключателей пуст, и
// проверка «неотключаемое действительно заблокировано» была бы зелёной просто
// потому, что проверять нечего. Тема security выбрана намеренно — схема (M008)
// не даёт её выключить, и интерфейс обязан это показывать, а не притворяться.
await sql(
  `INSERT INTO comms.notification_preferences (user_id, channel, topic, enabled)
   VALUES ($1, 'email', 'projects', true), ($1, 'email', 'security', true)
   ON CONFLICT (user_id, channel, topic) DO NOTHING`,
  [owner.userId],
);

// Чужой проект: он не должен появиться в кабинете первого пользователя.
const [taxonomy] = await sql(`SELECT id FROM lab.project_taxonomy WHERE slug = 'fintech'`);
const [strangerProject] = await sql(
  `INSERT INTO lab.projects (id, taxonomy_id, title, stage, investment_ask, required_plan_id)
   VALUES (public.uuid_generate_v7(), $1, $2, 'growth', 5000000,
           billing.resolve_founder_plan(5000000))
   RETURNING id, title`,
  [taxonomy.id, `Чужой проект ${suffix}`],
);
await sql(
  `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
  [strangerProject.id, stranger.userId],
);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  // 401 на проверке сессии — штатный путь, а не дефект: кабинет не может
  // знать заранее, вошёл ли пользователь, и спрашивает об этом сервер.
  // Браузер печатает такой ответ как ошибку ресурса; отличать её от настоящей
  // приходится здесь, иначе проверка красная всегда.
  // Сценарий намеренно вызывает доменные отказы: 401 на проверке сессии,
  // 403 на публикации без верификации, 404 на ещё не созданном паспорте. Это
  // ПРАВИЛЬНОЕ поведение сервера, и считать его ошибкой интерфейса нельзя —
  // иначе проверка запрещает приложению корректно обрабатывать отказы.
  // Настоящие дефекты — это 5xx, исключения страницы и ошибки разбора ответа.
  if (/\b(401|403|404) \(/.test(text)) return;
  consoleErrors.push(text);
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

/**
 * Ответы API запоминаются целиком.
 *
 * Прогон один раз из пяти падал ожиданием элемента после создания проекта, и
 * причину назвать было нечем: в отчёте оставался только таймаут локатора.
 * Ответ сервера — первое, что нужно знать в такой момент: 429, 5xx и обычный
 * 201 выглядят на экране одинаково — «ничего не появилось».
 */
const apiCalls = [];
page.on('response', (response) => {
  const url = response.url();
  if (!url.includes('/v1/')) return;
  apiCalls.push(
    `${response.request().method()} ${url.replace(CORE_URL, '')} → ${response.status()}`,
  );
});

/**
 * Ожидание с диагностикой. Молчаливый таймаут локатора не говорит НИЧЕГО о
 * причине: экран мог остаться прежним и из-за отказа сервера, и из-за ошибки
 * разбора ответа, и просто из-за медленного первого рендера.
 */
async function waitWithDiagnosis(selector, timeout, stage) {
  try {
    await page.waitForSelector(selector, { timeout });
  } catch (error) {
    console.warn(`
  ДИАГНОСТИКА (${stage}): ожидание «${selector}» не дождалось`);
    console.warn(`  последние вызовы API: ${apiCalls.slice(-6).join(' | ') || '—'}`);
    console.warn(`  ошибки консоли: ${consoleErrors.slice(-3).join(' | ') || 'нет'}`);
    console.warn(
      `  текст экрана: ${(await page.locator('body').innerText()).slice(0, 300).replace(/\s+/g, ' ')}`,
    );
    throw error;
  }
}

// -------------------------------------------------------------------- вход
console.warn('[1] Вход');
await page.goto(LAB_URL, { waitUntil: 'networkidle', timeout: 30_000 });

check(
  'незалогиненному показан вход, а не пустой экран',
  (await page.getByRole('heading', { name: 'Вход' }).count()) === 1,
);

await page.fill('#email', owner.email);
await page.fill('#password', 'заведомо-неверный-пароль');
await page.getByRole('button', { name: 'Войти' }).click();
await page.waitForTimeout(1200);
check(
  'неверный пароль показывает отказ, а не молчит',
  (await page.locator('[role="alert"]').count()) > 0,
);

await page.fill('#password', owner.password);
await page.getByRole('button', { name: 'Войти' }).click();
await page.waitForSelector('text=Мои проекты', { timeout: 15_000 });
check('вход выполнен и открыт список проектов', true);

// -------------------------------------------------------------- пустой список
console.warn('\n[2] Пустое состояние и создание заявки');
// Ждём именно КОНЦА загрузки списка, а не «сколько-нибудь»: считать элементы
// на середине запроса — значит проверять скорость машины, а не интерфейс.
await page
  .getByText('Проектов пока нет')
  .waitFor({ timeout: 15_000 })
  .catch(() => undefined);
const listArea = await page.locator('main').innerText();
check(
  'пустой список объяснён словами',
  (await page.getByText('Проектов пока нет').count()) === 1,
  // При неудаче показываем, что РЕАЛЬНО на экране: иначе «не нашёл текст»
  // не отличить от «список не загрузился» и от «пришла ошибка».
  listArea.replace(/\s+/g, ' ').slice(0, 160),
);

check(
  'чужой проект в кабинете не виден',
  !(await page.locator('body').innerText()).includes(strangerProject.title),
);

// ------------------------------------------------------ уведомления (Ф53)
//
// Блок общий для кабинетов (`@unicorn/cabinet`): четыре копии одного экрана в
// этом проекте уже расходились по одной за раз. У уведомлений цена расхождения
// выше обычной — они про то, о чём человека предупредят, а о чём нет.
// ------------------------------------------------------------ юрлица (Ф54)
//
// Без проверенного юрлица основатель не допускается к выпуску. До Ф54 завести
// компанию можно было только через служебную консоль: обязательный шаг
// существовал в API и отсутствовал в продукте.
console.warn('\n[2a] Юрлица и KYB');
const entitiesText = await page.locator('main').innerText();
check('карточка юрлиц есть в кабинете', entitiesText.includes('Юрлица и проверка KYB'));
check('отсутствие юрлиц объяснено словами', entitiesText.includes('Юрлиц нет'));
check(
  'сказано, что проверку проводит комплаенс, а не платформа',
  entitiesText.includes('Проверку проводит'),
);

const entitySuffix = `${Date.now() % 1e8}`;
await page.fill('#entity-name', `ООО Прогон ${entitySuffix}`);
await page.fill('#entity-inn', `77${entitySuffix.padStart(8, '0').slice(-8)}`);
await page.fill('#entity-ogrn', `1${entitySuffix.padStart(12, '0').slice(-12)}`);
await page.getByRole('button', { name: 'Добавить юрлицо' }).click();
await page.waitForTimeout(2500);
check('юрлицо создано из кабинета', (await page.getByText('Юрлицо добавлено').count()) > 0);
check(
  'состояние KYB показано сразу и честно',
  (await page.getByText('KYB не пройден').count()) > 0,
);
// ИНН приходит обратно МАСКИРОВАННЫМ: полное значение шифруется и наружу не
// выдаётся. Интерфейс показывает то, что отдал сервер, а не то, что ввели.
const entityRow = await page.locator('main').innerText();
check(
  'ИНН показан маской, а не введённым значением',
  !entityRow.includes(`77${entitySuffix.padStart(8, '0').slice(-8)}`),
);

await page.getByRole('button', { name: 'Проверка по реестру' }).first().click();
await page.waitForTimeout(2500);
// Требуется ИМЕННО подтверждение запуска: «любой alert на странице» зеленел бы
// и на отказе, то есть проверял бы наличие сообщения, а не работу проверки.
check(
  'проверка юрлица по реестру запущена',
  (await page.getByText('Проверка по реестру запрошена').count()) > 0,
);

console.warn('\n[2b] Уведомления и настройки каналов');
const notificationsText = await page.locator('main').innerText();
check('блок уведомлений есть в кабинете', notificationsText.includes('Уведомления'));
check('пустая лента объяснена словами', notificationsText.includes('Уведомлений нет'));
// Безопасность и счета отключить нельзя — это ограничение СХЕМЫ (M008), а не
// каприз интерфейса. Переключатель, который сервер отвергнет, обещал бы
// управление, которого нет.
check('неотключаемые темы названы прямо', notificationsText.includes('отключить нельзя'));
const securityToggle = page.locator('#pref-email-security');
const projectsToggle = page.locator('#pref-email-projects');
check('настройка темы «безопасность» заблокирована', await securityToggle.isDisabled());
// Позитивный контроль: блокировка выше — про КОНКРЕТНУЮ тему, а не про то,
// что переключатели не работают вовсе.
check('обычная тема переключается', !(await projectsToggle.isDisabled()));
// `click`, а не `uncheck`: состояние переключателя контролирует React и
// меняет его только ПОСЛЕ ответа сервера, а `uncheck` требует, чтобы галочка
// снялась немедленно, и падает на исправном коде.
await projectsToggle.click();
await page.waitForTimeout(2000);
check(
  'изменение настройки сохранено сервером',
  (await page.getByText('Настройка сохранена').count()) > 0,
);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
check(
  'выключенная тема осталась выключенной после перезагрузки',
  !(await page.locator('#pref-email-projects').isChecked()),
);

await page.getByRole('button', { name: 'Новая заявка' }).first().click();
await page.waitForSelector('#title', { timeout: 10_000 });
const projectTitle = `Проект прогона ${suffix}`;
await page.fill('#title', projectTitle);
await page.fill('#tagline', 'Проверка кабинета в реальном рендере');
await page.fill('#investmentAsk', '5000000.00');
// Справочник направлений грузится асинхронно, и до его ответа `taxonomyId`
// пуст: отправка в этот момент ГАРАНТИРОВАННО получает 400. Под нагрузкой
// прогон успевал нажать «Создать» раньше ответа — и падал ожиданием карточки,
// не назвав причины. Ждём заполненного значения, а не времени.
await page
  .locator('#taxonomyId option[value]:not([value=""])')
  .first()
  // `attached`, а не `visible`: пункты списка Playwright считает невидимыми,
  // пока список не раскрыт, — ждать их видимости значило бы ждать вечно.
  .waitFor({ state: 'attached', timeout: 15_000 });
await page.getByRole('button', { name: 'Создать' }).click();

await waitWithDiagnosis('text=Действия', 15_000, 'карточка проекта после создания');
check(
  'после создания открылась карточка проекта',
  (await page.locator('h1').innerText()).includes(projectTitle),
);

// ------------------------------------------------------------------ действия
console.warn('\n[3] Действия и отказы сервера');
check('карточка показывает статус проекта', (await page.getByText('Черновик').count()) > 0);

// Публикация листинга без подписки и KYC обязана отказать — и объяснить.
await page.getByRole('button', { name: 'Опубликовать листинг' }).click();
await page.waitForTimeout(2000);
const noticeText = await page.locator('[role="alert"], [role="status"]').first().innerText();
check(
  'отказ публикации объяснён сервером, а не проглочен',
  noticeText.trim().length > 10,
  noticeText.slice(0, 80),
);

check(
  'паспорта ещё нет — и это сказано словами',
  (await page.getByText('Паспорта ещё нет').count()) > 0,
);

// ------------------------------------------------------ материалы и роадмап
console.warn('\n[3b] Материалы и путь по сезону');

check(
  'путь по сезону показан с текущим этапом',
  (await page.getByText('Путь по сезону').count()) > 0 &&
    (await page.getByText('сейчас').count()) > 0,
);

check(
  'история подач объяснена словами при отсутствии версий',
  (await page.getByText('Заявка ещё не подавалась').count()) > 0,
);

check(
  'пустые материалы объяснены, а не показаны пустым местом',
  (await page.getByText('Материалов пока нет').count()) > 0,
);

// Ссылка на продукт добавляется через сервер; проверяется появление в списке,
// а не факт нажатия кнопки: нажатие без результата ничего не доказывает.
const productUrl = `https://example.com/product-${Date.now() % 100000}`;
await page.getByLabel('Ссылка на продукт').fill(productUrl);
await page.getByRole('button', { name: 'Добавить ссылку' }).click();
await page.waitForTimeout(2500);
check(
  'добавленная ссылка появилась в списке материалов',
  (await page.getByText(productUrl).count()) > 0,
  productUrl,
);

// Отказ сервера тоже обязан быть виден: внутренний адрес запрещён (SSRF).
await page.getByLabel('Ссылка на продукт').fill('https://127.0.0.1/internal');
await page.getByRole('button', { name: 'Добавить ссылку' }).click();
await page.waitForTimeout(2000);
// Именно последнее сообщение: выше на странице уже есть отказ публикации, и
// `first()` прочитал бы его — проверка зеленела бы, ничего не проверяя.
const linkNotice = await page.locator('[role="alert"], [role="status"]').last().innerText();
check(
  'внутренний адрес отклонён с объяснением',
  linkNotice.trim().length > 5 &&
    (await page.getByText('https://127.0.0.1/internal').count()) === 0,
  linkNotice.slice(0, 70),
);

// ------------------------------------------- согласия на публичный контур
//
// Проверяется не наличие карточки, а рабочий путь: выдал — видно «выдано» и
// состав раскрытия; отозвал — назван крайний срок удаления проекции. До Ф50
// маршрута не существовало вовсе, и любая кнопка здесь отвечала бы 404.
// ------------------------------------------------- подписка и счета (Ф52)
//
// До Ф52 кабинет отказывал в публикации словами «требуется активная подписка»
// и не имел НИ ОДНОГО способа её оформить: подписка жила только в служебной
// консоли. Отказ, не ведущий к действию, которое его снимает, — тупик.
console.warn('\n[3b2] Подписка и счета');
check(
  'карточка подписки есть на странице проекта',
  (await page.getByText('Подписка и счета').count()) > 0,
);

// С M071 платёжный барьер — флаг, по умолчанию выключенный (подача и листинг
// бесплатны). Карточка обязана не предлагать оплату при выключенном барьере
// и вести к подписке при включённом; проверяется ветка, в которой стенд.
const featuresResponse = await fetch(`${CORE_URL}/v1/features`);
const featuresJson = await featuresResponse.json().catch(() => null);
const barrierOn = featuresJson?.flags?.['billing.listing_requires_subscription'] === true;
console.warn(`  ·     платёжный барьер основателя: ${barrierOn ? 'ВКЛЮЧЁН' : 'выключен'}`);

if (!barrierOn) {
  check(
    'при выключенном барьере сказано, что подача и публикация бесплатны',
    (await page.getByText('Подача и публикация бесплатны').count()) > 0,
  );
  check(
    'при выключенном барьере оплату не предлагают',
    (await page.getByRole('button', { name: 'Оформить подписку' }).count()) === 0 &&
      (await page.getByText('Тариф проекта').count()) === 0,
  );
} else {
  check(
    'отсутствие подписки объяснено словами',
    (await page.getByText('Подписки на проект нет').count()) > 0,
  );
  check(
    'сказано, что оплата картой не подключена',
    (await page.getByText('Приём платежей картой пока не подключён').count()) > 0,
  );

  await page.getByRole('button', { name: 'Оформить подписку' }).click();
  await page.waitForTimeout(2500);
  // Сообщение берётся ИЗ ЭТОЙ карточки, а не последнее на странице: выше уже
  // есть отказы других карточек, и `.last()` читал бы их — проверка была бы
  // зелёной или красной по чужой причине.
  const billingCard = page
    .locator('div')
    .filter({ has: page.getByRole('heading', { name: 'Подписка и счета' }) })
    .last();
  const billingNotice = (
    await billingCard
      .locator('[role="status"], [role="alert"]')
      .first()
      .innerText()
      .catch(() => '')
  ).trim();
  check(
    'подписка оформлена и это сказано',
    billingNotice.includes('Подписка оформлена'),
    billingNotice.slice(0, 80),
  );
  // Коды тарифов заменены словами (e4bb007): проверяется название, а не код.
  check(
    'тариф подписки виден в карточке',
    (await page.getByText(/Старт|Рост|Масштаб|Крупный|Стратегический/).count()) > 0,
  );
  check(
    'счетов по подписке пока нет — и это объяснено',
    (await page.getByText('Счёт выставляется на оформленную подписку').count()) > 0,
  );
}

console.warn('\n[3c] Согласия на публичный контур');
const consentRow = page.locator('li').filter({ hasText: 'Выпуск отбора' }).first();
check('области согласия перечислены по отдельности', (await consentRow.count()) === 1);

await page.getByLabel('Название проекта').check();
await consentRow.getByRole('button', { name: 'Дать согласие' }).click();
await page.waitForTimeout(2000);
check(
  'согласие выдано и отмечено в интерфейсе',
  (await consentRow.getByText('выдано').count()) > 0,
  (await consentRow.innerText()).replace(/\s+/g, ' ').slice(0, 90),
);
check(
  'состав раскрытия виден, а не спрятан в документе',
  (await consentRow.getByText('Название проекта').count()) > 0,
);

await consentRow.getByRole('button', { name: 'Отозвать' }).click();
await page.waitForTimeout(2000);
const revokedSummary = page.getByText('Отозванные согласия').first();
check('отозванные согласия показаны отдельно', (await revokedSummary.count()) > 0);
await revokedSummary.click();
await page.waitForTimeout(300);
check(
  'после отзыва назван крайний срок удаления проекции',
  (await page.getByText('удаление проекции до').count()) > 0,
);

// -------------------------------------------------------------- доступность
console.warn('\n[4] Доступность и раскладка');
check('ровно один h1', (await page.locator('h1').count()) === 1);
const unlabeled = await page.locator('input:not([id]):not([aria-label])').count();
check('поля ввода имеют подписи', unlabeled === 0, `без подписи: ${unlabeled}`);

await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const overflow = await page.evaluate(
  // eslint-disable-next-line no-undef
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
// При переполнении называются виновники: «6px» без адреса — не диагноз.
// Берутся ЛИСТОВЫЕ элементы (у которых ни один потомок не вылезает сам):
// обёртки вылезают вслед за содержимым и виновниками не являются.
const culprits =
  overflow > 1
    ? await page.evaluate(() => {
        /* eslint-disable no-undef */
        const limit = document.documentElement.clientWidth + 1;
        const sticks = (el) => el.getBoundingClientRect().right > limit;
        return [...document.querySelectorAll('body *')]
          .filter((el) => sticks(el) && ![...el.children].some(sticks))
          .slice(0, 4)
          .map((el) => {
            const cls =
              typeof el.className === 'string' && el.className
                ? `.${el.className.split(' ')[0]}`
                : '';
            const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
            return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls} right=${Math.round(
              el.getBoundingClientRect().right,
            )} «${text}»`;
          });
        /* eslint-enable no-undef */
      })
    : [];
check(
  'горизонтальной прокрутки нет на 390px',
  overflow <= 1,
  `переполнение: ${overflow}px${culprits.length ? `; ${culprits.join(' | ')}` : ''}`,
);

// Отказы, вызванные ПРЕДНАМЕРЕННО (публикация без подписки, внутренний адрес),
// печатаются браузером как ошибки загрузки ресурса. Это ожидаемое поведение
// сервера, а не дефект страницы, поэтому такие строки исключаются явно —
// а не гейт целиком.
const unexpectedErrors = consoleErrors.filter((text) => !/status of (400|403|422)/.test(text));
check(
  'непредвиденных ошибок в консоли нет',
  unexpectedErrors.length === 0,
  unexpectedErrors.slice(0, 2).join(' | ') || 'нет',
);

// ------------------------------------------------------------ выход и сессия
console.warn('\n[5] Выход');
await page.setViewportSize({ width: 1280, height: 900 });
await page.getByRole('button', { name: 'Выйти' }).click();
await page.waitForTimeout(1500);
check(
  'после выхода снова показан вход',
  (await page.getByRole('heading', { name: 'Вход' }).count()) === 1,
);

await page.reload({ waitUntil: 'networkidle' });
check(
  'перезагрузка после выхода не возвращает кабинет',
  (await page.getByRole('heading', { name: 'Вход' }).count()) === 1,
);

await browser.close();
await pool.end();

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
process.exit(failed > 0 ? 1 : 0);

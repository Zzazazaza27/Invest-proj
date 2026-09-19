#!/usr/bin/env node
/**
 * Проверка мастера заявки v2 в РЕАЛЬНОМ рендере (этап 4, план 0.2 §0в).
 *
 * Что проверяется — список владельца при приёмке этапа: понятность пошаговой
 * навигации, сохранение и возврат к черновику, статус каждого раздела,
 * неизменность версии анкеты после публикации новой, свободный черновик,
 * объяснение обязательных и рекомендуемых вопросов, предпросмотр именно
 * инвесторских данных, подача без сезона и без ИИ, работоспособность старого
 * интерфейса при выключенном флаге.
 *
 * Флаг `lab.ui.application_v2` включается на время прогона и возвращается в
 * прежнее состояние в конце. Снимки экранов кладутся в `out/render-lab-v2/`
 * (каталог в git не попадает) — чтобы владелец видел экраны, а не только
 * строки «OK».
 *
 * Запуск: node scripts/render-check-lab-v2.mjs
 * Требуется: core и единая точка входа (nginx с собранными кабинетами и
 * страницей входа) подняты; LAB_URL переопределяет адрес кабинета.
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL, frontendUrl } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const LAB_URL = process.env.LAB_URL ?? frontendUrl('lab');
const CORE_URL = process.env.CORE_URL ?? DEFAULT_CORE_URL;
const OUT = join(ROOT, 'out', 'render-lab-v2');
mkdirSync(OUT, { recursive: true });

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

async function register(tag) {
  const email = `labv2-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const response = await fetch(`${CORE_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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

async function setFlag(enabled) {
  await sql(`UPDATE audit.feature_flags SET enabled = $1 WHERE key = 'lab.ui.application_v2'`, [
    enabled,
  ]);
}

const [flagRow] = await sql(
  `SELECT enabled FROM audit.feature_flags WHERE key = 'lab.ui.application_v2'`,
);
const flagWas = flagRow?.enabled ?? false;
const [activeVersion] = await sql(
  `SELECT version FROM lab.application_form_versions WHERE is_active`,
);
if (!activeVersion) {
  console.error(
    'Нет активной версии конфигурации вопросов — выполните scripts/seed-application-form.mjs',
  );
  process.exit(1);
}

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: МАСТЕР ЗАЯВКИ v2 ===\n');
console.warn(
  `  ·     активная версия анкеты: ${activeVersion.version}; флаг был ${flagWas ? 'включён' : 'выключен'}`,
);

const owner = await register('owner');
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  if (/\b(401|403|404) \(/.test(text)) return;
  consoleErrors.push(text);
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));
let patchCount = 0;
let roundsListCount = 0;
let roundContextCount = 0;
page.on('request', (request) => {
  if (process.env.TRACE_REQUESTS && request.url().includes('/v1/')) {
    console.warn(`      -> ${request.method()} ${request.url().replace(/^.*[/]v1/, '/v1')}`);
  }
  if (request.method() === 'PATCH' && request.url().includes('/v1/applications/')) patchCount += 1;
  if (request.method() === 'GET' && /\/v1\/projects\/[^/]+\/rounds$/.test(request.url())) {
    roundsListCount += 1;
  }
  if (
    request.method() === 'GET' &&
    /\/v1\/(service-countries|projects\/[^/]+\/versions)/.test(request.url())
  ) {
    roundContextCount += 1;
  }
});

let shot = 0;
async function screenshot(name) {
  shot += 1;
  const file = join(OUT, `${String(shot).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

const savedState = () => page.locator('[data-save-state][data-save-scope="application"]').first();
const roundSaved = () => page.locator('[data-save-state][data-save-scope="round"]').first();
async function roundSavedCount() {
  return Number((await roundSaved().getAttribute('data-save-count')) ?? '0');
}
async function waitRoundSaved(stage, since) {
  try {
    await page.waitForFunction(
      /* eslint-disable no-undef */
      (n) =>
        Number(
          document
            .querySelector('[data-save-state][data-save-scope="round"]')
            ?.getAttribute('data-save-count') ?? '0',
        ) > n,
      /* eslint-enable no-undef */
      since,
      { timeout: 10_000 },
    );
  } catch {
    check(
      `сохранение раунда (${stage})`,
      false,
      await roundSaved()
        .innerText()
        .catch(() => '—'),
    );
  }
}
/** Число завершённых сохранений — чтобы ждать ИМЕННО следующую запись, а не прошлую. */
async function savedCount() {
  return Number((await savedState().getAttribute('data-save-count')) ?? '0');
}
/** Дождаться, что после отметки `since` сохранение завершилось ещё раз. */
async function waitSaved(stage, since) {
  try {
    await page.waitForFunction(
      /* eslint-disable no-undef */
      (n) =>
        Number(
          document
            .querySelector('[data-save-state][data-save-scope="application"]')
            ?.getAttribute('data-save-count') ?? '0',
        ) > n,
      /* eslint-enable no-undef */
      since,
      { timeout: 10_000 },
    );
  } catch {
    check(
      `сохранение (${stage})`,
      false,
      await savedState()
        .innerText()
        .catch(() => '—'),
    );
  }
}

async function fillQuestion(key, value) {
  const control = page
    .locator(
      `[data-question="${key}"] textarea, [data-question="${key}"] input:not([type=checkbox]):not([type=date]), [data-question="${key}"] select`,
    )
    .first();
  const tag = await control.evaluate((el) => el.tagName.toLowerCase());
  if (tag === 'select') {
    await control.selectOption({ index: 1 });
  } else {
    await control.fill(String(value));
    // Системные поля фиксируются при уходе из поля — снимаем фокус явно.
    await control.blur();
  }
}

page.on('dialog', (dialog) => void dialog.accept());

try {
  await setFlag(true);

  // ------------------------------------------------------------------ вход
  console.warn('[1] Вход и проект');
  await page.goto(LAB_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.fill('#email', owner.email);
  await page.fill('#password', owner.password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await page.waitForSelector('text=Мои проекты', { timeout: 15_000 });
  check('вход выполнен', true);

  await page.getByRole('button', { name: 'Новая заявка' }).first().click();
  await page.waitForSelector('#title', { timeout: 10_000 });
  const projectTitle = `Автосервис ${suffix}`;
  await page.fill('#title', projectTitle);
  await page.fill('#tagline', 'Онлайн-запись для независимых автосервисов');
  await page.fill('#investmentAsk', '3000000.00');
  await page
    .locator('#taxonomyId option[value]:not([value=""])')
    .first()
    .waitFor({ state: 'attached', timeout: 15_000 });
  await page.getByRole('button', { name: 'Создать' }).click();
  await page.waitForSelector('text=Действия', { timeout: 15_000 });
  check('проект создан и открыт', (await page.locator('h1').innerText()).includes(projectTitle));

  // ------------------------------------------------------- заявки на проекте
  console.warn('\n[2] Заявки проекта при включённом флаге');
  await page.waitForSelector('text=Инвестиционные заявки', { timeout: 10_000 });
  check('карточка заявок видна при включённом флаге', true);
  // Список и остаток приходят отдельным запросом после заголовка карточки —
  // ждём именно их, а не заголовок.
  await page.waitForSelector('text=старая форма', { timeout: 10_000 }).catch(() => undefined);
  check(
    'заявка переноса (старая форма) показана в списке',
    (await page.getByText('старая форма').count()) > 0,
  );
  check(
    'остаток по политике показан до создания',
    (await page.getByText(/Заявок: \d+ из \d+/).count()) > 0,
  );
  await screenshot('project-page-v2');

  const appsCard = page.locator('section').filter({ hasText: 'Инвестиционные заявки' }).first();
  await appsCard.getByRole('button', { name: 'Новая заявка' }).click();
  await page.waitForSelector('text=Вы не просто публикуете проект', { timeout: 15_000 });
  check('новая заявка создана и открыт вводный экран мастера', true);
  const wizardUrl = page.url();
  check('у мастера есть адрес', /\/applications\/[0-9a-f-]{36}$/.test(wizardUrl), wizardUrl);

  // ------------------------------------------------------------- вводный экран
  console.warn('\n[3] Вводный экран');
  const introText = await page.locator('main').innerText();
  check(
    'версия анкеты названа и обещана неизменной',
    introText.includes(`Анкета версии ${activeVersion.version}`) &&
      introText.includes('не изменится'),
  );
  check(
    'обязательные и рекомендуемые объяснены',
    introText.includes('Обязательные вопросы нужны, чтобы подать заявку') &&
      introText.includes('Рекомендуемые не блокируют подачу'),
  );
  check('сказано, что черновик свободен', introText.includes('Черновик свободен'));
  check(
    'разделы перечислены в навигации',
    (await page.getByRole('button', { name: /^1\. Проект/ }).count()) === 1 &&
      (await page.getByRole('button', { name: /^13\. Материалы/ }).count()) === 1 &&
      (await page.getByRole('button', { name: /^Раунд привлечения/ }).count()) === 1,
  );
  check(
    'вопрос «привлекаете ли инвестиции» — развилка к раунду, не флаг',
    introText.includes('Вы сейчас привлекаете инвестиции?') &&
      introText.includes('Ответ ничего не переключает') &&
      (await page.getByRole('button', { name: 'Да — подготовить раунд' }).count()) === 1,
  );
  check(
    'два сообщения о готовности: минимум для подачи и процент',
    introText.includes('До подачи осталось обязательных вопросов') &&
      /Заполненность заявки: \d+%/.test(introText),
  );
  await screenshot('wizard-intro');

  await page.getByRole('button', { name: 'Начать заполнение' }).click();
  await page.waitForSelector('[data-question="stage"] select', { timeout: 10_000 });

  // ------------------------------------------------------------- раздел 1
  console.warn('\n[4] Раздел «Проект»: системные поля и данные проекта');
  const section1 = await page.locator('main').innerText();
  check(
    'данные проекта показаны и не спрашиваются заново',
    section1.includes('берутся из проекта'),
  );
  check(
    'у вопросов есть подписи «обязательный» / «рекомендуется»',
    (await page.getByText('Обязательный для подачи').count()) > 0 &&
      (await page.getByText('Рекомендуется').count()) > 0,
  );
  check(
    'подсказка вопроса показана текстом, а не кодом',
    section1.includes('Стадия определяется тем, что уже есть'),
  );
  const examples = page.locator('summary', { hasText: 'Пример хорошего и слабого ответа' }).first();
  check('примеры хорошего и слабого ответа доступны', (await examples.count()) > 0);
  await examples.click();
  check('примеры раскрываются', (await page.getByText('Слабый ответ').count()) > 0);
  await screenshot('wizard-section-project');

  // Стадия — системное поле: смена меняет набор вопросов, версия — нет.
  const s1 = await savedCount();
  await page.locator('[data-question="stage"] select').selectOption('idea');
  await waitSaved('стадия', s1);
  check('смена стадии сохранена', (await savedState().innerText()).includes('Сохранено'));
  check(
    'версия анкеты не изменилась после смены стадии',
    (await page.locator('main').innerText()).includes(`Анкета версии ${activeVersion.version}`),
  );

  // --------------------------------------------------- черновик и возврат
  console.warn('\n[5] Сохранение черновика и возврат');
  await page.getByRole('button', { name: /^2\. Проблема/ }).click();
  await page.waitForSelector('[data-question="problem_statement"]', { timeout: 10_000 });
  const problemText = `Владельцы сервисов теряют записи — прогон ${suffix}`;
  const s2 = await savedCount();
  await fillQuestion('problem_statement', problemText);
  await waitSaved('ответ', s2);
  const sectionUrl = page.url();
  check('у раздела есть адрес', /\/s\/problem$/.test(sectionUrl), sectionUrl);

  // Ушли на другую страницу и вернулись по адресу — ответ на месте.
  await page.goto(LAB_URL, { waitUntil: 'networkidle' });
  await page.goto(sectionUrl, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-question="problem_statement"] textarea', { timeout: 15_000 });
  check(
    'после ухода и возврата ответ сохранён',
    (await page.locator('[data-question="problem_statement"] textarea').inputValue()) ===
      problemText,
  );
  check(
    'статус раздела «требует внимания», пока обязательные не заполнены',
    (await page.getByRole('button', { name: /^2\. Проблема/ }).innerText()).includes(
      'требует внимания',
    ),
  );
  check(
    'раздел без ответов помечен «не начат»',
    (await page.getByRole('button', { name: /^5\. Рынок/ }).innerText()).includes('не начат'),
  );

  // Неверный тип ответа отвергается сервером и показывается у поля.
  await page.getByRole('button', { name: /^1\. Проект/ }).click();
  await page.waitForSelector('[data-question="founded_year"] input', { timeout: 10_000 });
  await page.locator('[data-question="founded_year"] input').fill('1800');
  // Пауза автосохранения 1,5 с плюс запрос — ждём состояния, а не времени.
  await page
    .waitForFunction(
      /* eslint-disable no-undef */
      () =>
        document.querySelector('[data-save-state]')?.getAttribute('data-save-state') === 'failed',
      /* eslint-enable no-undef */
      null,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  check(
    'ошибка типа/диапазона показана у поля, черновик не потерян',
    (await page.locator('[data-question="founded_year"] [role="alert"]').count()) > 0 &&
      (await page.locator('[data-save-state]').getAttribute('data-save-state')) === 'failed',
  );
  const s3 = await savedCount();
  await page.locator('[data-question="founded_year"] input').fill('2025');
  await waitSaved('год', s3);
  // Вопрос только для платформы — в предпросмотр не попадёт.
  const s4 = await savedCount();
  await fillQuestion('stage_evidence', 'Есть 20 интервью и лист ожидания');
  await waitSaved('platform-вопрос', s4);

  // ------------------------------------------ временная ошибка сохранения
  console.warn('\n[5a] Временная ошибка сохранения: ввод сохраняется повтором');
  {
    const listsBefore = roundsListCount;
    const contextBefore = roundContextCount;
    await page.goto(sectionUrl, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-question="problem_statement"] textarea', { timeout: 10_000 });
    check(
      'экран профиля делает один запрос списка раундов и не грузит контекст раунда',
      roundsListCount - listsBefore === 1 && roundContextCount - contextBefore === 0,
      `список раундов: ${roundsListCount - listsBefore}, контекст: ${roundContextCount - contextBefore}`,
    );
    let failed = 0;
    await page.route(/\/v1\/applications\/[^/]+$/, async (route) => {
      if (route.request().method() === 'PATCH' && failed === 0) {
        failed += 1;
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({ code: 'unavailable', detail: 'временно недоступно' }),
        });
        return;
      }
      await route.continue();
    });
    const patchesBefore = patchCount;
    const sBefore = await savedCount();
    const text = 'Ответ при сбое сети: должен сохраниться повтором';
    await page.locator('[data-question="problem_statement"] textarea').fill(text);
    await page.waitForFunction(
      /* eslint-disable no-undef */
      () =>
        ['retrying', 'failed'].includes(
          document
            .querySelector('[data-save-state][data-save-scope="application"]')
            ?.getAttribute('data-save-state') ?? '',
        ),
      /* eslint-enable no-undef */
      undefined,
      { timeout: 15_000 },
    );
    const during = await savedState().innerText();
    check(
      'после сбоя показано «не сохранено» с обратным отсчётом повтора, не молчание',
      during.includes('Не сохранено') && (await savedState().getAttribute('role')) === 'alert',
      during.slice(0, 80),
    );
    check(
      'ввод при сбое не потерян',
      (await page.locator('[data-question="problem_statement"] textarea').inputValue()) === text,
    );
    await page.getByRole('button', { name: 'Повторить сейчас' }).click();
    await waitSaved('после сбоя', sBefore);
    await page.unroute(/\/v1\/applications\/[^/]+$/);
    check(
      'повтор сохранил введённое одним запросом; лишних повторов нет',
      patchCount - patchesBefore === 2 && failed === 1,
      `PATCH: ${patchCount - patchesBefore}`,
    );
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForSelector('[data-question="problem_statement"] textarea', { timeout: 10_000 });
    check(
      'после перезагрузки сохранённый после сбоя ответ на месте',
      (await page.locator('[data-question="problem_statement"] textarea').inputValue()) === text,
    );
    // Вернуть исходный ответ: дальнейшие шаги ищут его в предпросмотре.
    const sRestore = await savedCount();
    await page.locator('[data-question="problem_statement"] textarea').fill(problemText);
    await waitSaved('возврат ответа', sRestore);
  }

  if (process.env.RENDER_STOP_AFTER === '5a')
    throw new Error('остановлено по RENDER_STOP_AFTER=5a');

  // ------------------------------------------------- обязательные до подачи
  console.warn('\n[6] Обязательные вопросы и готовность');
  const before = await page.locator('[data-readiness]').innerText();
  check('до заполнения подача закрыта, но это не ошибка', before.includes('До подачи осталось'));

  const form = await fetch(`${CORE_URL}/v1/applications/${wizardUrl.split('/').pop()}/form`, {
    headers: { cookie: (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ') },
  }).then((r) => r.json());
  const scopeOf = (section) => section.scope ?? (section.key === 'funding' ? 'round' : 'profile');
  const mandatory = form.sections
    .filter((section) => scopeOf(section) === 'profile')
    .flatMap((s) =>
      s.questions
        .filter((q) => q.state === 'mandatory' && !q.coreField)
        .map((q) => ({ ...q, section: s.key })),
    );
  const roundMandatory = form.sections
    .filter((section) => scopeOf(section) === 'round')
    .flatMap((s) => s.questions.filter((q) => q.state === 'mandatory' && !q.coreField));
  check(
    'форма отдаёт обязательные вопросы для стадии',
    mandatory.length >= 8,
    `${mandatory.length}`,
  );
  let currentSection = null;
  for (const q of mandatory) {
    if (currentSection !== q.section) {
      await page
        .locator('nav, ol')
        .getByRole('button', { name: new RegExp(`\\. ${escapeRe(sectionTitle(form, q.section))}`) })
        .first()
        .click();
      await page.waitForSelector(`[data-question="${q.key}"]`, { timeout: 10_000 });
      currentSection = q.section;
    }
    if (q.key === 'problem_statement') continue;
    await fillQuestion(
      q.key,
      q.type === 'number' ? 3 : q.type === 'money' ? '100.00' : `Ответ прогона: ${q.label}`,
    );
  }
  // Предмет финансирования и сумма — поля РАУНДА (план 0.2 §0г, 5.6.4):
  // профиль подаётся без них, минимум считается по вопросам профиля.
  await page.waitForFunction(
    /* eslint-disable no-undef */
    () => document.querySelector('[data-save-state]')?.getAttribute('data-save-state') === 'saved',
    /* eslint-enable no-undef */
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(800);
  const after = await page.locator('[data-readiness]').innerText();
  check(
    'раздел «Инвестиционный запрос» не в навигации профиля — он на экране раунда',
    (await page.getByRole('button', { name: /^\d+\. Инвестиционный запрос/ }).count()) === 0,
  );
  const percent = Number(/Заполненность заявки: (\d+)%/.exec(after)?.[1] ?? '-1');
  check(
    'минимум для подачи выполнен — сказано отдельно',
    after.includes('Минимум для подачи выполнен'),
  );
  check(
    'процент готовности показан и он ниже 100 — без окраски ошибки',
    percent > 0 && percent < 100 && after.includes('Это полнота данных, а не оценка проекта'),
    `${percent}%`,
  );
  check(
    'разделы с обязательными теперь «частично» или «готов», не «требует внимания»',
    (await page.getByRole('button', { name: /^2\. Проблема/ }).innerText()).includes('частично'),
  );
  await screenshot('wizard-section-profile-ready');

  // --------------------------------------------- раунд: черновик до подачи
  console.warn('\n[6a] Раунд привлечения: черновик готовится до подачи профиля');
  const contextBeforeRound = roundContextCount;
  await page.getByRole('button', { name: /^Раунд привлечения/ }).click();
  await page.waitForSelector('[data-round-state="none"]', { timeout: 10_000 });
  await page.waitForTimeout(1500);
  check(
    'контекст раунда (профиль, страны, версии) запрошен один раз при входе на экран',
    roundContextCount - contextBeforeRound === 2,
    `запросов контекста: ${roundContextCount - contextBeforeRound}`,
  );
  check(
    'раунда нет — предложена подготовка черновика, флага «привлекаю» нет',
    (await page.locator('main').innerText()).includes('Раунд ещё не готовится'),
  );
  await page.getByRole('button', { name: 'Начать подготовку раунда' }).click();
  await page.waitForSelector('[data-round-state="draft"]', { timeout: 15_000 });
  await page.waitForSelector('[data-round-country]', { timeout: 10_000 });
  if ((await page.locator('[data-round-country]').getAttribute('data-round-country')) === 'none') {
    await page.getByRole('button', { name: /Подтвердить страну: RU/ }).click();
    await page.waitForSelector('[data-round-country="ru"]', { timeout: 10_000 });
  }
  check(
    'страна аккаунта выбрана один раз; условия страны показаны рядом с суммой',
    (await page.locator('[data-round-country="ru"]').innerText()).includes('Валюты раунда'),
  );
  await page.waitForSelector('[data-question="funding_scope"] select', { timeout: 10_000 });
  check(
    'предмет финансирования не выбран по умолчанию',
    (await page.locator('[data-question="funding_scope"] select').inputValue()) === '',
  );
  const roundBefore = await page.locator('[data-round-readiness]').innerText();
  check(
    'до заполнения раунд открыть нельзя — сказано отдельно от профиля',
    roundBefore.includes('До открытия осталось'),
  );
  const r1 = await roundSavedCount();
  await page.locator('[data-question="funding_scope"] select').selectOption('project');
  await waitRoundSaved('предмет финансирования', r1);
  const r2 = await roundSavedCount();
  await fillQuestion('investment_ask', '3000000.00');
  await waitRoundSaved('сумма раунда', r2);
  const r3 = await roundSavedCount();
  await page.locator('#round-currency').selectOption('RUB');
  await waitRoundSaved('валюта', r3);
  for (const q of roundMandatory) {
    const r = await roundSavedCount();
    await fillQuestion(
      q.key,
      q.type === 'number' ? 3 : q.type === 'money' ? '100.00' : `Ответ прогона: ${q.label}`,
    );
    await waitRoundSaved(q.key, r);
  }
  await page.waitForTimeout(800);
  const roundReady = await page.locator('[data-round-readiness]').innerText();
  check(
    'готовность раунда считается отдельно от профиля и достигнута',
    roundReady.includes('Раунд можно открыть') && /Готовность раунда: \d+%/.test(roundReady),
    roundReady.replace(/\s+/g, ' ').slice(0, 120),
  );
  check(
    'открыть раунд до подачи профиля нельзя — кнопка недоступна',
    await page.locator('[data-round-open]').isDisabled(),
  );
  check(
    'основание не выбрано: подсказано подать профиль',
    (await page.locator('[data-round-basis="none"]').count()) === 1,
  );
  await screenshot('wizard-round-draft');

  // ------------------------------------------------ частота автосохранения
  console.warn('\n[6b] Автосохранение при наборе длинного текста');
  await page.getByRole('button', { name: /^11\. Риски/ }).click();
  await page.waitForSelector('[data-question="key_assumptions"] textarea', { timeout: 10_000 });
  const patchesBefore = patchCount;
  const sBefore = await savedCount();
  const longText =
    'Сети сервисов купят при цене полторы тысячи за точку; холодные выезды масштабируются до пяти менеджеров; '.repeat(
      4,
    );
  // ~430 знаков по 40 мс — 17 секунд непрерывного набора без пауз.
  await page.locator('[data-question="key_assumptions"] textarea').pressSequentially(longText, {
    delay: 40,
  });
  await waitSaved('длинный текст', sBefore);
  await page.waitForTimeout(2500);
  const patchesDuring = patchCount - patchesBefore;
  check(
    'длинный текст ушёл единицами запросов, а не запросом на букву',
    patchesDuring >= 1 && patchesDuring <= 3,
    `PATCH за набор: ${patchesDuring}`,
  );
  check(
    'набранный текст сохранён целиком',
    (await page.locator('[data-question="key_assumptions"] textarea').inputValue()) === longText &&
      (await page.locator('[data-save-state]').getAttribute('data-save-state')) === 'saved',
  );

  // ------------------------------------------------- неизменность версии
  // Черновик раунда добавил запросов; даём окну потолка частоты закрыться.
  await page.waitForTimeout(61_000);
  console.warn('\n[7] Публикация новой версии анкеты не трогает заявку');
  await sql(`UPDATE lab.application_form_versions SET is_active = false WHERE is_active`);
  const [nextRow] = await sql(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM lab.application_form_versions`,
  );
  const [newVersion] = await sql(
    `INSERT INTO lab.application_form_versions
       (id, version, status, is_active, config_jsonb, reason, published_at, activated_at)
     SELECT public.uuid_generate_v7(), $1, 'published', true, config_jsonb,
            'рендер-проверка: версия для проверки неизменности заявки', now(), now()
       FROM lab.application_form_versions WHERE version = $2
     RETURNING version`,
    [Number(nextRow.next), activeVersion.version],
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('[data-readiness]', { timeout: 15_000 });
  check(
    `после публикации версии ${newVersion.version} заявка осталась на версии ${activeVersion.version}`,
    (await page.locator('main').innerText()).includes(`Анкета версии ${activeVersion.version}`),
  );
  await sql(`UPDATE lab.application_form_versions SET is_active = false WHERE is_active`);
  await sql(`UPDATE lab.application_form_versions SET is_active = true WHERE version = $1`, [
    activeVersion.version,
  ]);

  // --------------------------------------------------------- предпросмотр
  console.warn('\n[8] Предпросмотр: то, что получит инвестор');
  await page.getByRole('button', { name: 'К предпросмотру' }).first().click();
  await page.waitForSelector('[data-preview]', { timeout: 15_000 });
  const preview = await page.locator('[data-preview]').innerText();
  check('предпросмотр показывает заполненный ответ', preview.includes(problemText));
  check(
    'ответ только для платформы в предпросмотр не попал',
    !preview.includes('Есть 20 интервью') && preview.includes('видимых только вам и платформе'),
  );
  check('предпросмотр объясняет, что это вид инвестора', preview.includes('так увидит инвестор'));
  check(
    'в предпросмотре стадия и состояние привлечения из раунда: черновик — «не привлекает»',
    preview.includes('Идея') && preview.includes('не привлекает') && !/3.000.000/.test(preview),
  );
  await page.locator('[data-preview-audience-choice="public"]').click();
  await page.waitForSelector('[data-preview-audience="public"]', { timeout: 10_000 });
  check(
    'предпросмотр для анонима: группа «текущий запрос» закрыта стартовой настройкой',
    (await page.locator('[data-preview-raising]').getAttribute('data-preview-raising')) ===
      'undisclosed' &&
      (await page.locator('[data-preview]').innerText()).includes('не раскрываются'),
  );
  await page.locator('[data-preview-audience-choice="investors"]').click();
  await page.waitForSelector('[data-preview-audience="investors"]', { timeout: 10_000 });
  await screenshot('wizard-preview');

  // ----------------------------------------------------------------- подача
  console.warn('\n[9] Подача без сезона и без ИИ');
  // Процент к моменту подачи: после замера в [6] добавился рекомендуемый ответ.
  const percentAtSubmit = Number(
    /Заполненность заявки: (\d+)%/.exec(await page.locator('[data-readiness]').innerText())?.[1] ??
      '-1',
  );
  const submitButton = page.getByRole('button', { name: 'Подать заявку' });
  check('кнопка подачи активна при выполненном минимуме', !(await submitButton.isDisabled()));
  await submitButton.click();
  await page.waitForSelector('text=Заявка подана', { timeout: 15_000 });
  const doneText = await page.locator('[role="status"]').last().innerText();
  check(
    'подача создала версию; сезон и оплата не понадобились',
    /версия \d+/.test(doneText),
    doneText,
  );
  await screenshot('wizard-submitted');
  const [version] = await sql(
    `SELECT v.completeness_pct, v.readiness_config_version, v.schema_version,
            (v.snapshot_jsonb->'form'->'sections') IS NOT NULL AS has_form
       FROM lab.project_versions v
       JOIN lab.investment_applications a ON a.current_version_id = v.id
      WHERE a.id = $1`,
    [wizardUrl.split('/').pop()],
  );
  check(
    'снимок хранит форму, процент и версию весов',
    version?.has_form === true &&
      version?.completeness_pct === percentAtSubmit &&
      version?.schema_version === activeVersion.version,
    JSON.stringify(version),
  );

  await page.waitForURL(/\/projects\//, { timeout: 10_000 });
  await page.waitForSelector('text=Инвестиционные заявки', { timeout: 15_000 });
  // Заголовок карточки появляется до загрузки списка: ждём сами строки заявок,
  // иначе подсчёт бейджа гоняется с запросом списка.
  await page.waitForSelector('[data-application]', { timeout: 15_000 });
  check(
    'после подачи заявка в списке помечена «Подана»',
    (await page.getByText('Подана').count()) > 0,
  );
  await page.waitForSelector('[data-round-line]', { timeout: 15_000 });
  check(
    'строка раунда на проекте: состояние из раунда, черновик отмечен, суммы заявки нет',
    (await page.locator('[data-round-line="none"]').innerText()).includes('Черновик раунда') &&
      !/3.000.000/.test(await page.locator('[data-round-line]').innerText()),
  );

  // ------------------------------------------------------- мобильная ширина
  // Предыдущие шаги делают десятки запросов подряд (автосохранение,
  // перезагрузки), и потолок частоты по адресу успевает сработать (429). Это
  // защита стенда, а не дефект мастера — даём окну потолка закрыться.
  await page.waitForTimeout(61_000);
  console.warn('\n[10] Телефон');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(sectionUrl, { waitUntil: 'networkidle' });
  try {
    await page.waitForSelector('[data-readiness]', { timeout: 15_000 });
  } catch (error) {
    console.warn(
      `  ДИАГНОСТИКА (телефон): ${(await page.locator('body').innerText()).slice(0, 300).replace(/s+/g, ' ')}`,
    );
    console.warn(`  ошибки консоли: ${consoleErrors.slice(-3).join(' | ') || 'нет'}`);
    throw error;
  }
  const overflow = await page.evaluate(
    // eslint-disable-next-line no-undef
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check('мастер без горизонтальной прокрутки на 390px', overflow <= 1, `${overflow}px`);
  await screenshot('wizard-mobile');
  await page.setViewportSize({ width: 1280, height: 900 });

  // ----------------------------------------- раунд: основание и открытие
  console.warn('\n[10a] Раунд: основание из поданной версии, открытие, пауза');
  await page.goto(`${wizardUrl}/round`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-round-state="draft"]', { timeout: 15_000 });
  await page.waitForSelector('[data-round-basis]', { timeout: 10_000 });
  check(
    'после подачи предложена последняя поданная версия как основание',
    (await page.locator('[data-round-basis]').innerText()).includes(
      'более новая поданная версия: v1',
    ),
  );
  await page.getByRole('button', { name: 'Взять последнюю версию' }).click();
  await page.waitForSelector('[data-round-basis="1"]', { timeout: 10_000 });
  check(
    'основание установлено явно, с причиной',
    (await page.locator('[data-round-basis="1"]').innerText()).includes('Анкета v1'),
  );
  // Открытие подтверждает ПОКАЗАННЫЙ предпросмотр (5.7.4): после смены
  // основания он перезапрашивается, и на это время кнопка обоснованно
  // недоступна. Проверка ждёт конца этого промежутка, а не измеряет мгновение
  // сразу после смены — иначе она меряет скорость сети, а не поведение.
  await page
    .waitForFunction(
      /* eslint-disable no-undef */
      () => {
        const button = document.querySelector('[data-round-open]');
        return button !== null && !button.disabled;
      },
      /* eslint-enable no-undef */
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => undefined);
  check(
    'кнопка открытия доступна, когда предпросмотр показан',
    !(await page.locator('[data-round-open]').isDisabled()),
  );
  await page.locator('[data-round-open]').click();
  await page.waitForSelector('[data-round-state="open"]', { timeout: 15_000 });
  const [openedRound] = await sql(
    `SELECT status, service_country, policy_version, target::text AS target
       FROM lab.funding_rounds WHERE project_id = $1 AND status = 'open'`,
    [await projectIdOf(wizardUrl)],
  );
  check(
    'раунд открыт явным действием: страна и версия условий зафиксированы',
    openedRound?.service_country === 'ru' &&
      openedRound?.policy_version >= 1 &&
      openedRound?.target === '3000000.00',
    JSON.stringify(openedRound),
  );
  await screenshot('wizard-round-open');
  await page.goto(`${LAB_URL.replace(/\/$/, '')}/projects/${await projectIdOf(wizardUrl)}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForSelector('[data-round-line="open"]', { timeout: 15_000 });
  check(
    'на проекте текущий запрос — сумма открытого раунда',
    /3.000.000/.test(await page.locator('[data-round-line="open"]').innerText()),
  );
  await page.goto(`${wizardUrl}/preview`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-preview-audience="investors"]', { timeout: 15_000 });
  check(
    'после открытия раунда инвестору в предпросмотре — сумма',
    /3.000.000/.test(await page.locator('[data-preview]').innerText()),
  );
  await page.locator('[data-preview-audience-choice="public"]').click();
  await page.waitForSelector('[data-preview-audience="public"]', { timeout: 10_000 });
  const anonPreview = await page.locator('[data-preview]').innerText();
  check(
    'анониму сумма открытого раунда не раскрывается, пока администратор не откроет группу',
    !/3.000.000/.test(anonPreview) && anonPreview.includes('не раскрываются'),
  );
  await screenshot('wizard-preview-anonymous');
  await page.goto(`${wizardUrl}/round`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-round-state="open"]', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Приостановить' }).click();
  await page.waitForSelector('[data-round-state="paused"]', { timeout: 15_000 });
  await page.goto(`${LAB_URL.replace(/\/$/, '')}/projects/${await projectIdOf(wizardUrl)}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForSelector('[data-round-line="paused"]', { timeout: 15_000 });
  check(
    'пауза показана как «приостановлено», не как активный сбор',
    (await page.locator('[data-round-line="paused"]').innerText()).includes('приостановлено'),
  );
  await screenshot('project-round-paused');

  // --------------------------------------------------------- старый интерфейс
  console.warn('\n[11] Старый интерфейс при выключенном флаге');
  // [10a] added requests after the cooldown; let the rate-limit window close.
  await page.waitForTimeout(61_000);
  await setFlag(false);
  await page.goto(wizardUrl.replace(/\/applications\/.*$/, ''), { waitUntil: 'networkidle' });
  await page.goto(`${LAB_URL.replace(/\/$/, '')}/projects/${await projectIdOf(wizardUrl)}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForSelector('text=Действия', { timeout: 15_000 });
  // Сезоны отложены (M088): кнопки «Подать в сезон» в кабинете больше нет ни
  // при каком положении флага мастера v2.
  check(
    'при выключенном флаге карточки заявок нет, кнопки «Подать в сезон» нет',
    (await page.getByText('Инвестиционные заявки').count()) === 0 &&
      (await page.getByRole('button', { name: 'Подать в сезон' }).count()) === 0 &&
      (await page.getByRole('button', { name: 'Запустить анализ' }).count()) === 1,
  );
  await screenshot('project-page-v1');

  // 400/422 вызываются намеренно (неверный тип ответа); 503 — подстроенный сбой
  // сохранения в [5a]; 429 — потолок частоты
  // стенда после серии автосохранений и соседних прогонов, клиент его
  // переживает повтором. Настоящие дефекты — 5xx, исключения страницы, разбор.
  const unexpected = consoleErrors.filter((t) => !/status of (400|403|422|429|503)/.test(t));
  check(
    'непредвиденных ошибок в консоли нет',
    unexpected.length === 0,
    unexpected.slice(0, 2).join(' | ') || 'нет',
  );
} finally {
  await setFlag(flagWas);
  await browser.close();
  await pool.end();
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено. Снимки: ${OUT}`);
process.exit(failed === 0 ? 0 : 1);

function sectionTitle(form, key) {
  return form.sections.find((s) => s.key === key)?.title ?? key;
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
async function projectIdOf(url) {
  const [row] = await sql(`SELECT project_id FROM lab.investment_applications WHERE id = $1`, [
    url.split('/').pop(),
  ]);
  return row.project_id;
}

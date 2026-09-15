#!/usr/bin/env node
/**
 * Рендер-проверка этапа 5: управление вопросами заявки из админки.
 *
 * Сценарий владельца (2026-09-15): изменить обязательность вопроса для
 * стадии → опубликовать новую версию → создать новую заявку → убедиться, что
 * старый черновик остался на прежней версии. Плюс откат («Вернуть версию»),
 * словарь/ЧАВО с подсказкой термина в мастере и страница настроек.
 *
 * Запуск: node scripts/render-check-admin-questions.mjs
 * Требуется: core, админка и кабинет основателя подняты; активная версия
 * анкеты опубликована (scripts/seed-application-form.mjs).
 * Снимки: out/render-admin-questions/ (в git не попадают).
 *
 * Побочные эффекты в локальной БД — намеренно как у реальной работы:
 * версии анкеты N+1 (опубликована) и повторная активация N; записи словаря
 * и ЧАВО с суффиксом прогона остаются в истории, но скрываются в конце.
 * Ничего не удаляется (план 0.2 §0в).
 */
import { chromium } from 'playwright';
import pg from 'pg';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL, frontendUrl } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

const ADMIN_URL = process.env.ADMIN_URL ?? frontendUrl('admin');
const LAB_URL = process.env.LAB_URL ?? frontendUrl('lab');
const CORE_URL = process.env.CORE_URL ?? DEFAULT_CORE_URL;
const OUT = join(ROOT, 'out', 'render-admin-questions');
// Снимки прошлого прогона удаляются: нумерация сквозная, и старые файлы
// иначе смешиваются с новыми.
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

/** Вопрос, чью обязательность меняем: рекомендуемый для идеи в стартовой конфигурации. */
const QUESTION = 'founded_year';
/** Раздел, где живёт вопрос-термин «проблема». */
const TERM_SECTION = 'problem';

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
  const email = `q5-${tag}-${suffix}@test.local`;
  const password = `Pw-${randomUUID()}`;
  const response = await fetch(`${CORE_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      email,
      password,
      displayName: `Проверка ${tag}`,
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
const [activeRow] = await sql(`SELECT version FROM lab.application_form_versions WHERE is_active`);
if (!activeRow) {
  console.error('Нет активной версии анкеты — выполните scripts/seed-application-form.mjs');
  process.exit(1);
}
const N = activeRow.version;
const [maxRow] = await sql(`SELECT MAX(version) AS max FROM lab.application_form_versions`);
/** Номер, который получит публикация: счётчик версий сквозной, а не «активная + 1». */
const NEXT = Number(maxRow.max) + 1;

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: АДМИНКА ВОПРОСОВ, ВЕРСИИ, СЛОВАРЬ (ЭТАП 5) ===\n');
console.warn(
  `  ·     активная версия анкеты: ${N}; флаг v2 был ${flagWas ? 'включён' : 'выключен'}`,
);

const admin = await register('admin');
const founder = await register('founder');
await sql(`INSERT INTO identity.user_roles (user_id, role) VALUES ($1, 'admin')`, [admin.userId]);

const browser = await chromium.launch();
const adminCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const labCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const adminPage = await adminCtx.newPage();
const labPage = await labCtx.newPage();
const consoleErrors = [];
for (const [tag, p] of [
  ['admin', adminPage],
  ['lab', labPage],
]) {
  p.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    if (/\b(401|403|404|409|429) \(/.test(text)) return;
    consoleErrors.push(`${tag}: ${text}`);
  });
  p.on('pageerror', (error) => consoleErrors.push(`${tag}: ${String(error)}`));
}

let shot = 0;
async function screenshot(page, name, fullPage = true) {
  shot += 1;
  const file = join(OUT, `${String(shot).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage });
  return file;
}

const statusText = () => adminPage.locator('[data-form-status]').innerText();
async function waitActiveVersion(version) {
  await adminPage.waitForFunction(
    /* eslint-disable no-undef */
    (v) =>
      (document.querySelector('[data-form-status]')?.textContent ?? '').includes(
        `Активная версия: ${v}`,
      ),
    /* eslint-enable no-undef */
    version,
    { timeout: 20_000 },
  );
}
async function confirmDialog(reason, button) {
  const dialog = adminPage.locator('[role="dialog"][aria-modal="true"]');
  await dialog.waitFor({ timeout: 10_000 });
  await adminPage.fill('#prompt-dialog-value', reason);
  await dialog.getByRole('button', { name: button }).click();
}
async function schemaVersionOf(applicationId) {
  const [row] = await sql(`SELECT schema_version FROM lab.investment_applications WHERE id = $1`, [
    applicationId,
  ]);
  return row?.schema_version;
}
const appIdOf = (url) => url.match(/\/applications\/([0-9a-f-]{36})/)?.[1];

/** Проект со страницы «Мои проекты»; возвращает адрес страницы проекта. */
async function createProject(title) {
  await labPage.goto(LAB_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await labPage.waitForSelector('text=Мои проекты', { timeout: 15_000 });
  await labPage.getByRole('button', { name: 'Новая заявка' }).first().click();
  await labPage.waitForSelector('#title', { timeout: 10_000 });
  await labPage.fill('#title', title);
  await labPage.fill('#tagline', 'Проверка неизменности версии черновика');
  await labPage.fill('#investmentAsk', '1500000.00');
  await labPage
    .locator('#taxonomyId option[value]:not([value=""])')
    .first()
    .waitFor({ state: 'attached', timeout: 15_000 });
  await labPage.getByRole('button', { name: 'Создать' }).click();
  await labPage.waitForSelector('text=Инвестиционные заявки', { timeout: 15_000 });
  return labPage.url();
}

/**
 * Новая заявка наследует стадию проекта (здесь — MVP); проверяемое состояние
 * задано для стадии «идея», поэтому стадия выбирается явно, как и в
 * render-check-lab-v2. Ждём именно следующее сохранение по data-save-count.
 */
async function chooseIdeaStage() {
  const state = labPage.locator('[data-save-state]').first();
  const since = Number((await state.getAttribute('data-save-count')) ?? '0');
  await labPage.locator('[data-question="stage"] select').selectOption('idea');
  await labPage.waitForFunction(
    /* eslint-disable no-undef */
    (n) =>
      Number(document.querySelector('[data-save-state]')?.getAttribute('data-save-count') ?? '0') >
      n,
    /* eslint-enable no-undef */
    since,
    { timeout: 15_000 },
  );
}

/**
 * Потолок частоты основателя — 120 запросов в минуту; страница мастера
 * делает около десятка запросов на переход, и плотный сценарный прогон
 * упирается в 429 (как и в render-check-lab-v2). Человек так не кликает,
 * поэтому пауза, а не поднятие лимита.
 */
async function cooldown(label) {
  console.warn(`  ·     пауза 61 с перед шагом «${label}» — потолок частоты запросов`);
  await new Promise((resolve) => setTimeout(resolve, 61_000));
}

const glossaryKey = `problem_probe_${suffix}`;
const faqKey = `faq_probe_${suffix}`;

try {
  await setFlag(true);

  // ------------------------------------------------------------ админка
  console.warn('[1] Админка: вход и таблица вопросов');
  await adminPage.goto(ADMIN_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await adminPage.fill('#email', admin.email);
  await adminPage.fill('#password', admin.password);
  await adminPage.getByRole('button', { name: /Войти/i }).click();
  await adminPage.waitForSelector('text=Тарифы', { timeout: 15_000 });
  for (const label of ['Вопросы заявки', 'Настройки заявки', 'Словарь и ЧАВО']) {
    check(
      `раздел «${label}» есть в меню`,
      (await adminPage.getByRole('link', { name: label, exact: true }).count()) === 1,
    );
  }

  await adminPage.getByRole('link', { name: 'Вопросы заявки', exact: true }).click();
  await adminPage.waitForSelector('[data-form-status]', { timeout: 20_000 });
  await adminPage.waitForSelector(`[data-question="${QUESTION}"]`, { timeout: 20_000 });
  check('активная версия показана', (await statusText()).includes(`Активная версия: ${N}`));
  const sectionCount = await adminPage.locator('[data-section]').count();
  check('разделы анкеты показаны таблицами', sectionCount >= 10, `${sectionCount}`);
  const rowCount = await adminPage.locator('tr[data-question]').count();
  check('вопросы показаны строками', rowCount >= 80, `${rowCount}`);
  const stageSelects = await adminPage.locator(`[data-question="stage"] select`).count();
  check('четыре ячейки стадий у вопроса', stageSelects === 4, `${stageSelects}`);
  check(
    'системное поле «стадия» заблокировано в ячейках',
    (await adminPage.locator(`[data-question="stage"] select[disabled]`).count()) === 4,
  );
  check(
    'у системного поля нет кнопки «Архивировать»',
    (await adminPage
      .locator(`[data-question="stage"]`)
      .getByRole('button', { name: 'Архивировать' })
      .count()) === 0,
  );
  await screenshot(adminPage, 'admin-questions-top', false);
  await screenshot(adminPage, 'admin-questions-table');

  console.warn('\n[2] Карточка вопроса и предпросмотр из черновика');
  await adminPage
    .locator(`[data-question="${QUESTION}"]`)
    .getByRole('button', { name: 'Карточка' })
    .click();
  await adminPage.waitForSelector(`[data-card="${QUESTION}"]`, { timeout: 10_000 });
  const card = adminPage.locator(`[data-card="${QUESTION}"]`);
  check(
    'карточка показывает тексты по языкам',
    (await card.locator('textarea, input').count()) >= 4,
  );
  await screenshot(adminPage, 'admin-question-card');
  await adminPage
    .locator(`[data-question="${QUESTION}"]`)
    .getByRole('button', { name: 'Свернуть' })
    .click();

  await adminPage
    .locator('[data-form-status]')
    .getByRole('button', { name: 'Идея', exact: true })
    .click();
  await adminPage.waitForSelector('[data-preview-form]', { timeout: 15_000 });
  const previewText = await adminPage.locator('[data-preview-form]').innerText();
  check(
    'предпросмотр формы для стадии «идея» собран из черновика',
    previewText.includes('Какую проблему вы решаете?'),
  );
  await screenshot(adminPage, 'admin-preview-idea');

  // ----------------------------------------- словарь и ЧАВО (до мастера)
  console.warn('\n[3] Словарь и ЧАВО');
  await adminPage.getByRole('link', { name: 'Словарь и ЧАВО', exact: true }).click();
  await adminPage.waitForSelector('text=Словарь терминов', { timeout: 15_000 });
  await adminPage.fill('[aria-label="Ключ новой записи"]', glossaryKey);
  await adminPage.getByRole('button', { name: 'Новая запись' }).click();
  await adminPage.waitForSelector(`[data-text-editor="${glossaryKey}"]`, { timeout: 10_000 });
  await adminPage.fill('#ru-RU-term', 'Проблема');
  await adminPage.fill(
    '#ru-RU-short_md',
    'Боль клиента, за решение которой он **готов платить**. Не «улучшение», а то, что мешает сейчас.',
  );
  await adminPage.fill(
    '#ru-RU-full_md',
    '## Проблема\n\nИнвестор проверяет, что проблема существует, повторяется и стоит клиенту денег или времени.\n\n- кто сталкивается\n- как часто\n- во что обходится',
  );
  check(
    'предпросмотр Markdown в редакторе',
    (await adminPage.locator(`[data-text-editor="${glossaryKey}"] strong`).count()) > 0,
  );
  await adminPage.getByRole('button', { name: 'Сохранить новой версией' }).click();
  await confirmDialog('Проверка этапа 5: термин для подсказки', 'Сохранить');
  await adminPage.waitForSelector(`[data-text-entry="${glossaryKey}"]`, { timeout: 15_000 });
  check('запись словаря создана и показана в таблице', true);
  const entryRow = adminPage.locator(`[data-text-entry="${glossaryKey}"]`);
  check(
    'английский перевод отмечен как отсутствующий',
    (await entryRow.innerText()).includes('en-US нет'),
  );
  await entryRow.getByRole('button', { name: 'История' }).click();
  await adminPage.waitForSelector('text=Действует', { timeout: 10_000 });
  const historyRows = await adminPage.locator('section.card table tbody tr').first().count();
  check('история версий текста открывается', historyRows > 0);
  await screenshot(adminPage, 'admin-texts-glossary');

  await adminPage.getByRole('button', { name: 'ЧАВО', exact: true }).click();
  await adminPage.waitForTimeout(800);
  await adminPage.fill('[aria-label="Ключ новой записи"]', faqKey);
  await adminPage.getByRole('button', { name: 'Новая запись' }).click();
  await adminPage.waitForSelector(`[data-text-editor="${faqKey}"]`, { timeout: 10_000 });
  await adminPage.fill('#ru-RU-question', 'Можно ли изменить ответы после подачи?');
  await adminPage.fill(
    '#ru-RU-answer_md',
    'Поданная версия неизменна. Новые ответы — в новой заявке или следующей версии.',
  );
  await adminPage.getByRole('button', { name: 'Сохранить новой версией' }).click();
  await confirmDialog('Проверка этапа 5: вопрос ЧАВО', 'Сохранить');
  await adminPage.waitForSelector(`[data-text-entry="${faqKey}"]`, { timeout: 15_000 });
  check('запись ЧАВО создана', true);

  // ---------------------------------------------- основатель: заявка A на N
  console.warn('\n[4] Основатель: заявка A на действующей версии');
  await labPage.goto(LAB_URL, { waitUntil: 'networkidle', timeout: 30_000 });
  await labPage.fill('#email', founder.email);
  await labPage.fill('#password', founder.password);
  await labPage.getByRole('button', { name: 'Войти' }).click();
  await labPage.waitForSelector('text=Мои проекты', { timeout: 15_000 });
  const projectUrl = await createProject(`Версии анкеты ${suffix}`);

  const appsCard = () =>
    labPage.locator('section').filter({ hasText: 'Инвестиционные заявки' }).first();
  await appsCard().getByRole('button', { name: 'Новая заявка' }).click();
  await labPage.waitForSelector('text=Вы не просто публикуете проект', { timeout: 15_000 });
  const appA = appIdOf(labPage.url());
  check('заявка A создана', Boolean(appA));
  check(
    `заявка A на версии ${N}`,
    (await labPage.locator('main').innerText()).includes(`Анкета версии ${N}`),
  );
  await labPage.goto(`${LAB_URL.replace(/\/$/, '')}/applications/${appA}/s/project`, {
    waitUntil: 'networkidle',
  });
  await labPage.waitForSelector(`[data-question="${QUESTION}"]`, { timeout: 15_000 });
  await chooseIdeaStage();
  const badgeA = await labPage.locator(`[data-question="${QUESTION}"]`).innerText();
  check('в заявке A вопрос рекомендуемый', badgeA.includes('Рекомендуется'), badgeA.split('\n')[0]);

  // ------------------------------------------- админка: правка и публикация
  console.warn('\n[5] Админка: обязательность для стадии → публикация N+1');
  await adminPage.getByRole('link', { name: 'Вопросы заявки', exact: true }).click();
  await adminPage.waitForSelector(`[data-question="${QUESTION}"] select`, { timeout: 20_000 });
  // Черновик мог остаться от прежних прогонов (после отката он «от версии
  // N+1») — начинаем от активной версии, как сделал бы администратор.
  adminPage.once('dialog', (d) => d.accept());
  await adminPage.getByRole('button', { name: 'Сбросить черновик' }).click();
  await adminPage.waitForSelector('text=Черновик сброшен', { timeout: 15_000 });
  check('черновик сброшен к активной версии', true);
  const ideaSelect = adminPage.locator(`[data-question="${QUESTION}"] select`).first();
  check('до правки — рекомендуемый для идеи', (await ideaSelect.inputValue()) === 'recommended');
  await ideaSelect.selectOption('mandatory');
  check('появилась отметка несохранённых правок', (await statusText()).includes('несохранённые'));
  await adminPage.getByRole('button', { name: 'Сохранить черновик' }).click();
  await adminPage.waitForFunction(
    // eslint-disable-next-line no-undef
    () => (document.querySelector('[data-form-status]')?.textContent ?? '').includes('совпадает'),
    undefined,
    { timeout: 15_000 },
  );
  check('черновик сохранён', true);
  const [draftRow] = await sql(
    `SELECT config_jsonb->'questions' AS qs FROM lab.application_form_versions WHERE status = 'draft'`,
  );
  const draftQ = draftRow?.qs?.find((q) => q.key === QUESTION);
  check('черновик в БД хранит новое состояние', draftQ?.stages?.idea === 'mandatory');

  await adminPage.getByRole('button', { name: 'Опубликовать', exact: true }).click();
  await confirmDialog(
    `Проверка этапа 5: год начала обязателен для идеи (${suffix})`,
    'Опубликовать',
  );
  await waitActiveVersion(NEXT);
  check(`опубликована и активна версия ${NEXT}`, true);
  check(
    'в истории новая версия помечена активной',
    (await adminPage.locator(`[data-version="${NEXT}"]`).innerText()).includes('активна'),
  );
  await screenshot(adminPage, 'admin-published-next');

  // ----------------------------------- основатель: A осталась, B на N+1
  console.warn('\n[6] Основатель: старый черновик на прежней версии, новая заявка на новой');
  await cooldown('6');
  await labPage.reload({ waitUntil: 'networkidle' });
  await labPage.waitForSelector(`[data-question="${QUESTION}"]`, { timeout: 15_000 });
  const mainA = await labPage.locator('main').innerText();
  check(`заявка A после публикации всё ещё на версии ${N}`, mainA.includes(`Анкета версии ${N}`));
  check(
    'в заявке A вопрос остался рекомендуемым',
    (await labPage.locator(`[data-question="${QUESTION}"]`).innerText()).includes('Рекомендуется'),
  );
  check(`БД: schema_version заявки A = ${N}`, (await schemaVersionOf(appA)) === N);
  await screenshot(labPage, 'lab-old-draft-stays');

  await labPage.goto(projectUrl, { waitUntil: 'networkidle' });
  await labPage.waitForSelector('text=Инвестиционные заявки', { timeout: 15_000 });
  await appsCard().getByRole('button', { name: 'Новая заявка' }).click();
  await labPage.waitForSelector('text=Вы не просто публикуете проект', { timeout: 15_000 });
  const appB = appIdOf(labPage.url());
  check(
    `заявка B создана на версии ${NEXT}`,
    (await labPage.locator('main').innerText()).includes(`Анкета версии ${NEXT}`),
  );
  check(`БД: schema_version заявки B = ${NEXT}`, (await schemaVersionOf(appB)) === NEXT);
  await labPage.goto(`${LAB_URL.replace(/\/$/, '')}/applications/${appB}/s/project`, {
    waitUntil: 'networkidle',
  });
  await labPage.waitForSelector(`[data-question="${QUESTION}"]`, { timeout: 15_000 });
  await chooseIdeaStage();
  // После смены стадии мастер перезапрашивает форму уже после отметки
  // «сохранено» — подпись меняется чуть позже счётчика.
  const becameMandatory = await labPage
    .locator(`[data-question="${QUESTION}"]`)
    .getByText('Обязательный для подачи')
    .waitFor({ timeout: 10_000 })
    .then(() => true)
    .catch(() => false);
  check('в заявке B вопрос стал обязательным для подачи', becameMandatory);
  await screenshot(labPage, 'lab-new-draft-next-version');

  // -------------------------------------------- подсказка термина и словарь
  console.warn('\n[7] Подсказка термина в мастере и страница словаря');
  await cooldown('7');
  await labPage.goto(`${LAB_URL.replace(/\/$/, '')}/applications/${appB}/s/${TERM_SECTION}`, {
    waitUntil: 'networkidle',
  });
  await labPage.waitForSelector('[data-question="problem_statement"]', { timeout: 15_000 });
  const termButton = labPage
    .locator(`[data-question="problem_statement"] [data-term="${glossaryKey}"]`)
    .first();
  check('термин из словаря найден у вопроса о проблеме', (await termButton.count()) === 1);
  await termButton.focus();
  await labPage.keyboard.press('Enter');
  const popover = labPage.locator(`[data-term-popover="${glossaryKey}"]`).first();
  await popover.waitFor({ timeout: 5_000 });
  const popText = await popover.innerText();
  check(
    'подсказка открывается с клавиатуры и показывает короткое пояснение',
    popText.includes('готов платить') && popText.includes('Подробнее в словаре'),
  );
  await screenshot(labPage, 'lab-term-hint');
  await labPage.keyboard.press('Escape');
  check('Escape закрывает подсказку', (await popover.count()) === 0);
  await termButton.click();
  await popover.waitFor({ timeout: 5_000 });
  await popover.getByRole('link', { name: 'Подробнее в словаре' }).click();
  await labPage.waitForSelector(`[data-glossary-term="${glossaryKey}"]`, { timeout: 15_000 });
  check('ссылка ведёт на страницу словаря к термину', labPage.url().includes(`#${glossaryKey}`));
  const glossaryText = await labPage.locator('main').innerText();
  check('полная статья термина показана', glossaryText.includes('повторяется и стоит клиенту'));
  check(
    'ЧАВО показано на той же странице',
    (await labPage.locator(`[data-faq="${faqKey}"]`).count()) === 1,
  );
  await screenshot(labPage, 'lab-glossary-page');

  // ------------------------------------------------ откат: вернуть версию N
  console.warn('\n[8] Откат: вернуть версию N');
  await cooldown('8');
  await adminPage
    .locator(`[data-version="${N}"]`)
    .getByRole('button', { name: `Вернуть версию ${N}` })
    .click();
  await confirmDialog(`Проверка этапа 5: откат к версии ${N}`, 'Вернуть');
  await waitActiveVersion(N);
  check(`версия ${N} снова активна`, true);
  check(
    `версия ${NEXT} осталась в истории`,
    (await adminPage.locator(`[data-version="${NEXT}"]`).count()) === 1,
  );
  await screenshot(adminPage, 'admin-rolled-back');

  await labPage.goto(projectUrl, { waitUntil: 'networkidle' });
  await labPage.waitForSelector('text=Инвестиционные заявки', { timeout: 15_000 });
  check(
    'лимит политики (3 заявки на проект) закрыл кнопку на первом проекте',
    await appsCard().getByRole('button', { name: 'Новая заявка' }).isDisabled(),
  );
  await createProject(`Откат анкеты ${suffix}`);
  await appsCard().getByRole('button', { name: 'Новая заявка' }).click();
  await labPage.waitForSelector('text=Вы не просто публикуете проект', { timeout: 15_000 });
  const appC = appIdOf(labPage.url());
  check(`заявка C после отката на версии ${N}`, (await schemaVersionOf(appC)) === N);
  check(`заявка B после отката осталась на ${NEXT}`, (await schemaVersionOf(appB)) === NEXT);

  // ----------------------------------------------------- настройки заявки
  console.warn('\n[9] Настройки заявки: ограничения и веса отдельно');
  await adminPage.getByRole('link', { name: 'Настройки заявки', exact: true }).click();
  await adminPage.waitForSelector('[data-weights]', { timeout: 15_000 });
  const policyText = await adminPage.locator('[data-policy]').innerText();
  const weightsText = await adminPage.locator('[data-weights]').innerText();
  check('блок ограничений с версией', /Активна версия \d+/.test(policyText));
  check('блок весов с версией', /Активна версия \d+/.test(weightsText));
  check(
    'веса объяснены как независимые от версии вопросов',
    weightsText.includes('не зависит от версии вопросов'),
  );
  check(
    'таблица весов по разделам',
    (await adminPage.locator('[data-weights] input[aria-label^="Вес раздела"]').count()) >= 10,
  );
  await screenshot(adminPage, 'admin-settings');

  // --------------------------------------------------- доступность и консоль
  console.warn('\n[10] Доступность и консоль');
  const unlabeled = await adminPage
    .locator('input:not([id]):not([aria-label]):not([type="hidden"]):not([type="checkbox"])')
    .count();
  check('поля настроек имеют подписи', unlabeled === 0, `без подписи: ${unlabeled}`);
  await adminPage.setViewportSize({ width: 390, height: 844 });
  await adminPage.waitForTimeout(400);
  const overflow = await adminPage.evaluate(
    // eslint-disable-next-line no-undef
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  check('настройки без горизонтальной прокрутки на 390px', overflow <= 1, `${overflow}px`);
  check(
    'ошибок в консоли нет',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 3).join(' | ') || 'нет',
  );
} finally {
  await setFlag(flagWas);
  // Пробные записи словаря скрываются, не удаляются: история остаётся.
  await sql(
    `UPDATE content.text_entries SET is_active = false WHERE namespace IN ('glossary','faq') AND key = ANY($1)`,
    [[glossaryKey, faqKey]],
  );
  await browser.close();
  await pool.end();
}

console.warn(`\nИтог: ${passed} проверок пройдено, ${failed} провалено. Снимки: ${OUT}`);
process.exit(failed === 0 ? 0 : 1);

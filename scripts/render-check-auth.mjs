#!/usr/bin/env node
/**
 * Проверка входа и регистрации в РЕАЛЬНОМ рендере (`RULES.md` §2).
 *
 * Это единственная дверь в платформу: её поломка означает, что внутрь не может
 * попасть никто, независимо от исправности остального. Поэтому проверяется не
 * «страница отрисовалась», а фактический путь человека — вход, роль, переход в
 * свой кабинет — и границы: эксперта в самостоятельном выборе быть не должно,
 * а без согласия с документами регистрация не отправляется.
 *
 * Прогон идёт через ЕДИНУЮ ТОЧКУ ВХОДА (обратный прокси), а не по портам: под
 * прокси приложение раздаётся из подпути, API живёт на том же origin, и именно
 * в этом режиме оно работает у пользователя.
 *
 * Запуск: node scripts/render-check-auth.mjs
 * Требуется: `npm run web:up`, ядро и собранные фронтенды.
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORTS } from './lib/ports.mjs';
import { registerProbeUser, startProbeRun } from './lib/probe-run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE =
  process.env.WEB_URL ?? (PORTS.web === 80 ? 'http://127.0.0.1' : `http://127.0.0.1:${PORTS.web}`);

/** Пароль демонстрационного комплекта читается из `.env` и НЕ печатается: он такой же секрет, как остальные. */
function standPassword() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return null;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('DEV_TEST_USER_PASSWORD=')) continue;
    return trimmed.slice('DEV_TEST_USER_PASSWORD='.length).trim();
  }
  return null;
}

/**
 * Ссылка подтверждения из последнего письма адресату (MAIL_TRANSPORT=file, var/mail). Имя
 * файла содержит адрес — как в smoke-auth-recovery.
 */
function verifyTokenFor(address) {
  const dir = join(ROOT, 'var', 'mail');
  if (!existsSync(dir)) return null;
  const safe = address.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 64);
  const last = readdirSync(dir)
    .filter((name) => name.includes(safe))
    .sort()
    .at(-1);
  if (!last) return null;
  return /#verify=([A-Za-z0-9_-]+)/.exec(readFileSync(join(dir, last), 'utf8'))?.[1] ?? null;
}

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

const password = standPassword();
if (!password) {
  console.error(
    'DEV_TEST_USER_PASSWORD не задан в .env — прогон без демонстрационного комплекта невозможен.',
  );
  process.exit(1);
}

// Основатель — свой, заведённый прогоном: вход проверяется настоящим входом,
// а общая учётка пропадает с пересозданием базы. Администратор для [6] — из
// демонстрационного комплекта: эту роль регистрацией не получить.
const run = await startProbeRun('RND-AUTH');
const founder = await registerProbeUser(run, { role: 'founder', label: 'render-auth' });

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: ВХОД И РЕГИСТРАЦИЯ ===\n');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

console.warn('[1] Витрина ведёт на вход');
let response = await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30_000 });
check('витрина отвечает', response?.ok() === true, `HTTP ${response?.status()}`);
// Номер порта в адресе — то, чего пользователь видеть не должен.
check('в адресе витрины нет порта', !new URL(page.url()).port, page.url());
// Кнопка входа одна: отдельная «Регистрация» дублировала путь — на форме
// входа есть переключатель на регистрацию (проверяется в [3]).
check(
  'в шапке одна кнопка «Войти», без отдельной «Регистрации»',
  (await page.getByRole('link', { name: 'Войти' }).count()) === 1 &&
    (await page.getByRole('link', { name: 'Регистрация' }).count()) === 0,
);

console.warn('\n[2] Экран входа');
await page.getByRole('link', { name: 'Войти' }).click();
await page.waitForLoadState('networkidle');
check('открылся /login/', page.url().startsWith(`${BASE}/login/`), page.url());
// Кнопка «Войти» обязана открыть именно вход. Отличие экранов — выбор роли:
// он есть только в регистрации, поэтому его отсутствие и есть признак входа.
check('открыт вход, а не регистрация', (await page.locator('.auth-role-title').count()) === 0);

// --------------------------------------------------- прямой адрес регистрации (Ф60)
//
// Кнопки «Регистрация» на витрине больше нет, но адрес `/login/#register`
// остаётся рабочим — на него можно сослаться из письма или материалов. Режим
// должен пережить F5, иначе человек, заполнявший регистрацию, после
// перезагрузки оказывается на входе.
console.warn('\n[2a] Адрес /login/#register открывает регистрацию');
// Сначала витрина: иначе переход с `/login/#login` меняет только фрагмент, и
// это уже другой сценарий — не открытие по ссылке.
await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30_000 });
await page.goto(`${BASE}/login/#register`, { waitUntil: 'networkidle', timeout: 30_000 });
await page.waitForLoadState('networkidle');
await page.waitForTimeout(400);
check('адрес называет экран регистрации', page.url().endsWith('/login/#register'), page.url());
check(
  'открыта форма регистрации',
  (await page.getByRole('button', { name: 'Создать аккаунт' }).count()) === 1,
);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(400);
check(
  'обновление страницы не сбрасывает на вход',
  (await page.getByRole('button', { name: 'Создать аккаунт' }).count()) === 1,
  page.url(),
);

console.warn('\n[3] Регистрация: роли и согласия');
// Дальше прогон идёт прежним путём — с чистого `/login/` и переключателем
// внизу формы: он тоже обязан работать, и его поломку [2a] не поймает.
await page.goto(`${BASE}/login/`, { waitUntil: 'networkidle', timeout: 30_000 });
await page.getByRole('button', { name: 'Зарегистрироваться' }).click();
await page.waitForTimeout(300);
const roles = await page.locator('.auth-role-title').allTextContents();
check('предложены ровно две роли', roles.length === 2, roles.join(', '));
// Роль эксперта назначает платформа: самостоятельная выдача обессмыслила бы
// экспертизу, и контракт её не допускает (SelfServiceRoleSchema).
check('роли «эксперт» в самостоятельном выборе нет', !roles.some((r) => /эксперт/i.test(r)));
check(
  'без согласия с документами отправка заблокирована',
  (await page.getByRole('button', { name: 'Создать аккаунт' }).isDisabled()) === true,
);

console.warn('\n[4] Действующие версии документов отдаются публично');
const templates = await page.evaluate(async (base) => {
  const r = await fetch(`${base}/v1/auth/consents/templates?locale=ru-RU`);
  return { status: r.status, body: await r.json() };
}, BASE);
check('маршрут версий отвечает без входа', templates.status === 200, `HTTP ${templates.status}`);
check(
  'отданы все четыре обязательных документа',
  ['platform_rules', 'tos', 'pdn', 'commission_terms'].every((kind) =>
    (templates.body.items ?? []).some((item) => item.kind === kind),
  ),
  `документов ${templates.body.items?.length ?? 0}`,
);

console.warn('\n[5] Вход уводит в кабинет по роли');
await page.getByRole('button', { name: 'Войти' }).last().click();
await page.waitForTimeout(300);
await page.locator('#email').fill(founder.email);
await page.locator('#password').fill(founder.password);
await page.getByRole('button', { name: 'Войти' }).first().click();
await page.waitForLoadState('networkidle');
await page.waitForTimeout(1500);
check('основатель попал в свой кабинет', page.url().includes('/lab'), page.url());
check('в адресе кабинета нет порта', !new URL(page.url()).port, page.url());

console.warn('\n[6] Короткое имя учётной записи принимается');
// Служебные учётки заводятся как `имя@fifth.local`, и кабинеты дополняют
// домен сами. Экран входа обязан вести себя так же: иначе верно введённый
// `demo-admin` отвергается проверкой адреса, и человек видит «проверьте
// заполнение полей» на правильном логине.
{
  const shortCtx = await browser.newContext();
  const shortPage = await shortCtx.newPage();
  await shortPage.goto(`${BASE}/login/`, { waitUntil: 'networkidle' });
  await shortPage.locator('#email').fill('demo-admin');
  await shortPage.locator('#password').fill(password);
  await shortPage.getByRole('button', { name: 'Войти' }).first().click();
  await shortPage.waitForTimeout(2500);
  check('вход по короткому имени без домена', shortPage.url().includes('/admin'), shortPage.url());
  await shortCtx.close();
}

console.warn('\n[7] Неверный пароль не различает причину отказа');
const clean = await browser.newContext();
const p2 = await clean.newPage();
await p2.goto(`${BASE}/login/`, { waitUntil: 'networkidle' });
await p2.locator('#email').fill(founder.email);
await p2.locator('#password').fill('заведомо-неверный-пароль');
await p2.getByRole('button', { name: 'Войти' }).first().click();
await p2.waitForTimeout(1500);
const wrongPassword = (await p2.locator('[role="alert"]').first().textContent()) ?? '';

// Адрес обязан быть СИНТАКСИЧЕСКИ верным, иначе сервер ответит отказом
// валидации, и сравнение сравнивало бы не то: разница текстов означала бы
// «неверный формат», а не «такого аккаунта нет».
await p2.locator('#email').fill('no-such-account-91745@fifth.local');
await p2.getByRole('button', { name: 'Войти' }).first().click();
await p2.waitForTimeout(1500);
const noAccount = (await p2.locator('[role="alert"]').first().textContent()) ?? '';

// Разные тексты для «нет аккаунта» и «неверный пароль» — это перебор учётных
// записей: злоумышленник узнаёт, какие адреса зарегистрированы.
check(
  'отказ одинаков для неверного пароля и несуществующего аккаунта',
  wrongPassword.trim() === noAccount.trim() && wrongPassword.trim().length > 0,
  `пароль: «${wrongPassword.trim()}» · аккаунт: «${noAccount.trim()}»`,
);

// ------------------------------------------- восстановление пароля (Ф51)
//
// Проверяется путь, который человек проходит целиком: ссылка «Забыли пароль?»
// → форма адреса → одинаковый ответ независимо от того, зарегистрирован ли
// адрес. Токен из письма здесь не берётся — это дело смоук-прогона; браузеру
// важно, что экран есть, отвечает и ничего не выдаёт.
//
// ДВА РЕЖИМА, и прогон называет, какой проверил. Без почтового контура
// (`MAIL_TRANSPORT=none`) сервер по задумке отказывает `feature_disabled`, и
// экран обязан сказать, что восстановления нет, а не что «сервер недоступен».
// С почтой — прежняя проверка сообщения об отправке. Режим определяется по
// ответу формы, а не по `.env`: проверяется то, что увидел человек.
console.warn('\n[8] Восстановление пароля');
const p3 = await (await browser.newContext()).newPage();
await p3.goto(`${BASE}/login/`, { waitUntil: 'networkidle' });
await p3.getByRole('button', { name: 'Забыли пароль?' }).click();
await p3.waitForTimeout(400);
check('экран восстановления открылся', (await p3.locator('#forgot-email').count()) === 1);
check('на экране восстановления нет поля пароля', (await p3.locator('#password').count()) === 0);

/** Ответ формы на запрос ссылки: сообщение об отправке или отказ. */
async function requestLink(address) {
  const forgotResponse = p3.waitForResponse((r) => r.url().includes('/v1/auth/password/forgot'));
  await p3.locator('#forgot-email').fill(address);
  await p3.getByRole('button', { name: 'Прислать ссылку' }).click();
  const status = (await forgotResponse).status();
  await p3.waitForSelector('[role="status"], [role="alert"]', { timeout: 10_000 });
  const alert = (
    (await p3
      .locator('[role="alert"]')
      .first()
      .textContent()
      .catch(() => '')) ?? ''
  ).trim();
  const notice = (
    (await p3
      .locator('[role="status"]')
      .first()
      .textContent()
      .catch(() => '')) ?? ''
  ).trim();
  return { status, alert, notice };
}

const known = await requestLink(founder.email);
// Режим — только по двум ожидаемым ответам. Любой другой (429 после
// соседнего прогона, 500) — не «почта подключена», а сбой, и о нём говорится.
const mailOff = known.status === 503;
const mailOn = known.status === 202;
if (!mailOff && !mailOn) {
  check('запрос ссылки дал ожидаемый ответ (202 или 503)', false, `HTTP ${known.status}`);
  await browser.close();
  await run.finish(false);
  console.warn(`\nИТОГО: ${passed} пройдено, ${failed} провалено\n`);
  process.exit(1);
}
console.warn(
  mailOff
    ? '  РЕЖИМ: без почты (сервер ответил 503) — путь через письмо этим прогоном НЕ проверен'
    : '  РЕЖИМ: почта подключена (сервер ответил 202)',
);

if (mailOff) {
  // Форма остаётся на экране восстановления: второй адрес вводится туда же.
  const unknown = await requestLink('no-such-account-91745@fifth.local');
  check(
    'без почты экран говорит, что восстановление недоступно',
    known.alert.includes('Восстановление пароля пока недоступно'),
    known.alert,
  );
  check(
    'без почты нет ложного «Сервер недоступен»',
    !known.alert.includes('Сервер недоступен'),
    known.alert,
  );
  check(
    'без почты не обещано письмо',
    known.notice === '' && !/отправлено/i.test(known.alert),
    known.notice || known.alert,
  );
  // Отказ одинаков для любого адреса — иначе выключенная почта стала бы
  // способом перечислить зарегистрированных.
  check(
    'отказ одинаков для зарегистрированного и чужого адреса',
    unknown.status === known.status && unknown.alert === known.alert,
    `${known.status} «${known.alert.slice(0, 40)}» против ${unknown.status} «${unknown.alert.slice(0, 40)}»`,
  );
} else {
  await p3.getByRole('button', { name: 'Забыли пароль?' }).click();
  await p3.waitForTimeout(300);
  const unknown = await requestLink('no-such-account-91745@fifth.local');
  // Разные сообщения здесь — это перечисление пользователей, причём удобнее
  // формы входа: пароль не нужен вовсе.
  check(
    'сообщение одинаково для зарегистрированного и чужого адреса',
    known.notice === unknown.notice && known.notice.length > 0,
    `«${known.notice.slice(0, 60)}» против «${unknown.notice.slice(0, 60)}»`,
  );
}

// Ссылка из письма. Токен заведомо недействующий: проверяется экран, а не смена пароля —
// её проверяет смоук-прогон. С почтой страница проверяет ссылку при открытии и сразу
// говорит, что она устарела (Томас, 08.11); без почты проверить нечем — форма и отказ после.
await p3.goto(`${BASE}/login/#reset=${'z'.repeat(43)}`, { waitUntil: 'networkidle' });
await p3.waitForTimeout(800);
if (mailOff) {
  // Без почты ссылку смены пароля проверить нечем: экран говорит об отключённой почте, а
  // не «нет связи» и не «устарела».
  const text = ((await p3.locator('[data-link="disabled"]').first().textContent()) ?? '').trim();
  check(
    'без почты ссылка смены пароля объяснена отключённой почтой',
    text.includes('Восстановление пароля пока недоступно') &&
      (await p3.locator('#new-password').count()) === 0,
    text.slice(0, 70),
  );
} else {
  check(
    'устаревшая ссылка видна сразу, без формы нового пароля',
    (await p3.locator('[data-link="dead"][data-link-purpose="password_reset"]').count()) === 1 &&
      (await p3.locator('#new-password').count()) === 0,
  );
  await p3.getByRole('button', { name: 'Запросить новую ссылку' }).click();
  await p3.waitForTimeout(400);
  check('кнопка ведёт к запросу новой ссылки', (await p3.locator('#forgot-email').count()) === 1);
}

// ------------------------------------------ единый механизм ссылок (Тэнк, Томас 09.11)
console.warn('\n[9] Ссылки из писем: открытие, кнопка, временный отказ');
{
  const ctx = await browser.newContext();
  const p4 = await ctx.newPage();
  p4.on('pageerror', (error) => pageErrors.push(String(error)));
  // Диагностика браузера (8.4) и консоль: токен туда попадать не должен.
  const diagnostics = [];
  p4.on('console', (message) => diagnostics.push(message.text()));
  p4.on('request', (request) => {
    if (request.url().includes('/client-errors')) diagnostics.push(request.postData() ?? '');
  });

  // Временный отказ — не «ссылка устарела»: проверка не дошла до сервера.
  const bogus = 'q'.repeat(43);
  await p4.route('**/v1/auth/link/check', (route) => route.abort('connectionrefused'));
  await p4.goto(`${BASE}/login/#verify=${bogus}`, { waitUntil: 'networkidle' });
  await p4.waitForTimeout(800);
  check(
    'сбой связи при проверке — «не удалось проверить», не «устарела»',
    (await p4.locator('[data-link="unknown"]').count()) === 1 &&
      (await p4.getByText('устарела').count()) === 0,
  );
  await p4.unroute('**/v1/auth/link/check');
  await p4.getByRole('button', { name: 'Проверить ещё раз' }).click();
  await p4.waitForTimeout(1200);
  check(
    'повтор проверки работает: поддельная ссылка подтверждения — «устарела или уже использована»',
    (await p4.locator('[data-link="dead"][data-link-purpose="email_verify"]').count()) === 1,
  );
  check(
    'для ссылки подтверждения предложен вход (новое письмо — в профиле)',
    (await p4.getByRole('button', { name: 'Войти' }).count()) === 1,
  );

  if (mailOn) {
    // Настоящая ссылка из письма регистрации своего участника.
    const person = await registerProbeUser(run, { role: 'founder', label: 'render-verify' });
    const token = verifyTokenFor(person.email);
    check('ссылка подтверждения получена из письма', Boolean(token));
    const checkLink = () =>
      p4.evaluate(
        async ({ base, t }) =>
          (
            await fetch(`${base}/v1/auth/link/check`, {
              signal: AbortSignal.timeout(30_000),
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ purpose: 'email_verify', token: t }),
            })
          ).status,
        { base: BASE, t: token },
      );
    await p4.goto(`${BASE}/login/#verify=${token}`, { waitUntil: 'networkidle' });
    await p4.waitForTimeout(800);
    await p4.reload({ waitUntil: 'networkidle' });
    await p4.waitForTimeout(800);
    check(
      'действующая ссылка — кнопка «Подтвердить почту», без автоматического подтверждения',
      (await p4.locator('[data-link="alive"]').count()) === 1 &&
        (await p4.getByRole('button', { name: 'Подтвердить почту' }).count()) === 1,
    );
    check('два открытия страницы ссылку не израсходовали', (await checkLink()) === 200);
    await p4.getByRole('button', { name: 'Подтвердить почту' }).click();
    await p4.waitForTimeout(1500);
    const notice = ((await p4.locator('[role="status"]').first().textContent()) ?? '').trim();
    check('нажатие подтверждает адрес', notice.includes('Адрес подтверждён'), notice.slice(0, 60));
    check('после нажатия ссылка израсходована', (await checkLink()) === 400);
    await p4.goto(`${BASE}/`, { waitUntil: 'networkidle' });
    await p4.goto(`${BASE}/login/#verify=${token}`, { waitUntil: 'networkidle' });
    await p4.waitForTimeout(800);
    check(
      'повторное открытие — общий экран «устарела или уже использована»',
      (await p4.locator('[data-link="dead"][data-link-purpose="email_verify"]').count()) === 1,
    );
    check(
      'токена нет в консоли и диагностике браузера',
      diagnostics.every((text) => !text.includes(token.slice(0, 24))),
      `записей ${diagnostics.length}`,
    );
  }
  await ctx.close();
}

const inputsWithoutLabel = await p3.locator('input:not([id]):not([aria-label])').count();
check(
  'поля восстановления имеют подписи',
  inputsWithoutLabel === 0,
  `без подписи: ${inputsWithoutLabel}`,
);

check('исключений на страницах нет', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await browser.close();
await run.finish(failed === 0);
console.warn(`\nИТОГО: ${passed} пройдено, ${failed} провалено\n`);
if (failed > 0) process.exit(1);

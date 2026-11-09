#!/usr/bin/env node
/**
 * Проверка кабинета инвестора в РЕАЛЬНОМ рендере (`RULES.md` §2).
 *
 * После 2.1-W05 кабинет — пустая оболочка: каталог с подпиской, счета,
 * предложения и сделки удалены вместе с инвестиционным процессом. Проверяется
 * честность этого состояния: вход по роли работает, человеку прямо сказано
 * «в разработке», прежних разделов, за которыми нет функций, на экране нет,
 * выход работает, ошибок в консоли нет.
 *
 * Запуск: node scripts/render-check-investor.mjs
 * Требуется: core и кабинет подняты (порты — из .env).
 */
import { chromium } from 'playwright';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORE_URL as DEFAULT_CORE_URL, frontendUrl } from './lib/ports.mjs';
import { startProbeRun } from './lib/probe-run.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

/*
 * Запуск открывается до первой регистрации: он даёт право назвать
 * заведённых людей следом прогона и записывает их за собой. Без него
 * сервер пометку не назначит — разрешённое значение заголовка не
 * полномочие.
 */
const run = await startProbeRun('RND-INVESTOR');

const APP_URL = process.env.INVESTOR_URL ?? frontendUrl('investor');
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

const suffix = `${Date.now() % 1e9}`;
const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));

const email = `inv-render-${suffix}@test.local`;
const password = `Pw-${randomUUID()}`;

{
  const response = await fetch(`${CORE_URL}/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...run.headers() },
    signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      email,
      password,
      displayName: 'Инвестор прогона',
      role: 'investor',
      locale: 'ru-RU',
      consents: CONSENTS,
    }),
  });
  if (!response.ok) throw new Error(`регистрация: HTTP ${response.status}`);
}

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: КАБИНЕТ ИНВЕСТОРА ===\n');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() !== 'error') return;
  const text = message.text();
  // 401 на проверке сессии до входа — правильный ответ сервера, а не дефект
  // интерфейса.
  if (/\b401 \(/.test(text)) return;
  consoleErrors.push(text);
});
page.on('pageerror', (error) => consoleErrors.push(String(error)));

console.warn('[1] Вход');
await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30_000 });
check('незалогиненного кабинет отправляет на вход', /\/login/.test(page.url()), page.url());

await page.fill('#email', email);
await page.fill('#password', password);
await page.getByRole('button', { name: 'Войти' }).first().click();
await page.waitForSelector('[data-investor-shell]', { timeout: 15_000 });
await page.waitForSelector('text=Кабинет в разработке', { timeout: 15_000 });
check('после входа открыт кабинет инвестора', /\/investor/.test(page.url()), page.url());

console.warn('\n[2] Оболочка «в разработке»');
const shell = page.locator('[data-investor-shell]');
check('оболочка кабинета ровно одна', (await shell.count()) === 1);
const shellText = await shell.innerText();
check(
  'состояние названо прямо',
  shellText.includes('Кабинет в разработке'),
  shellText.replace(/\s+/g, ' ').slice(0, 100),
);
// Прежние разделы не должны вернуться пустыми кнопками: за ними нет функций.
for (const name of ['Каталог', 'Подписка', 'Счета', 'Предложения', 'Сделки']) {
  check(
    `раздела «${name}» нет`,
    (await page.getByRole('button', { name, exact: true }).count()) === 0 &&
      (await page.getByRole('link', { name, exact: true }).count()) === 0,
  );
}
check('кнопка выхода на месте', (await page.getByRole('button', { name: 'Выйти' }).count()) === 1);

console.warn('\n[3] Раскладка');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(300);
const overflow = await page.evaluate(
  // eslint-disable-next-line no-undef
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
check('горизонтальной прокрутки нет на 390px', overflow <= 1, `переполнение: ${overflow}px`);

// «Мой профиль» в оболочке инвестора — тот же общий профиль аккаунта, временно до блока 03
// (Тэнк, 09.11). Узкая проверка: вход из шапки и прямое открытие, повторное письмо,
// подтверждение адреса, понятное ограничение при недоступной почте.
console.warn('\n[3a] Мой профиль: повторное письмо подтверждения');
await page.setViewportSize({ width: 1280, height: 900 });
await page.getByTestId('profile-link').click();
await page.waitForURL(/\/investor\/profile/, { timeout: 15_000 }).catch(() => undefined);
await page
  .waitForSelector('text=Почта не подтверждена', { timeout: 15_000 })
  .catch(() => undefined);
check('ссылка из шапки открывает профиль', /\/investor\/profile$/.test(page.url()), page.url());
await page.reload({ waitUntil: 'networkidle' });
await page
  .waitForSelector('text=Почта не подтверждена', { timeout: 15_000 })
  .catch(() => undefined);
check(
  'прямое открытие профиля: блок «Почта не подтверждена»',
  (await page.getByText('Почта не подтверждена').count()) === 1,
);
const mailDir = join(ROOT, process.env.MAIL_OUTBOX_DIR ?? 'var/mail');
const lettersBefore = existsSync(mailDir) ? readdirSync(mailDir).length : 0;
await page.getByTestId('email-verify-resend').click();
await page.waitForSelector('[data-testid="email-verify-notice"]', { timeout: 15_000 });
const resendNotice = (await page.getByTestId('email-verify-notice').textContent()) ?? '';
check('повторное письмо отправлено', /Письмо.*отправлено/.test(resendNotice), resendNotice.trim());
const safe = email.replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 64);
const letters = existsSync(mailDir)
  ? readdirSync(mailDir)
      .filter((f) => f.includes(safe))
      .sort()
  : [];
const token = letters.length
  ? /#verify=([A-Za-z0-9_-]+)/.exec(readFileSync(join(mailDir, letters.at(-1)), 'utf8'))?.[1]
  : null;
check(
  'новое письмо со ссылкой в почте',
  Boolean(token) && readdirSync(mailDir).length > lettersBefore,
  `писем адресату ${letters.length}`,
);
if (token) {
  const verifyPage = await context.newPage();
  await verifyPage.goto(`${APP_URL.replace(/\/investor\/?$/, '')}/login/#verify=${token}`, {
    waitUntil: 'networkidle',
  });
  await verifyPage.getByRole('button', { name: 'Подтвердить почту' }).click();
  await verifyPage.waitForTimeout(1500);
  const done = (await verifyPage.locator('[role="status"]').first().textContent()) ?? '';
  check(
    'адрес подтверждён по ссылке из нового письма',
    done.includes('Адрес подтверждён'),
    done.trim(),
  );
  await verifyPage.close();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  check(
    'после подтверждения блока в профиле нет',
    (await page.getByText('Почта не подтверждена').count()) === 0,
  );
}

// Недоступная почта — подменённые ответы сервера: выключать почту стенда ради экрана незачем.
{
  const p = await context.newPage();
  await p.route('**/v1/auth/email/verify/status', (route) =>
    route.fulfill({ json: { verified: false, pendingUntil: null, mailAvailable: false } }),
  );
  await p.goto(`${APP_URL.replace(/\/$/, '')}/profile`, { waitUntil: 'networkidle' });
  await p.waitForSelector('text=Почта не подтверждена', { timeout: 15_000 }).catch(() => undefined);
  check(
    'почта не подключена: сказано прямо, кнопки нет',
    (await p.getByText('Отправка писем на платформе пока не подключена').count()) === 1 &&
      (await p.getByTestId('email-verify-resend').count()) === 0,
  );
  await p.unroute('**/v1/auth/email/verify/status');
  await p.route('**/v1/auth/email/verify/status', (route) =>
    route.fulfill({ json: { verified: false, pendingUntil: null, mailAvailable: true } }),
  );
  await p.route('**/v1/features', async (route) => {
    const real = await (await route.fetch()).json();
    const closed = {
      allowed: false,
      reason: 'dependency_failure',
      observedAt: new Date().toISOString(),
    };
    real.groups.mail = { state: 'unavailable', read: closed, write: closed };
    await route.fulfill({ json: real });
  });
  await p.reload({ waitUntil: 'networkidle' });
  await p
    .waitForSelector('[data-testid="email-verify-resend"]', { timeout: 15_000 })
    .catch(() => undefined);
  check(
    'группа «Почта» закрыта: предупреждение и кнопка недоступна',
    (await p.locator('[data-group-notice="mail"]').count()) === 1 &&
      (await p.getByTestId('email-verify-resend').isDisabled()),
  );
  await p.close();
}
await page.goto(APP_URL, { waitUntil: 'networkidle' });

console.warn('\n[4] Выход');
await page.getByRole('button', { name: 'Выйти' }).click();
await page.waitForURL(/\/login/, { timeout: 15_000 }).catch(() => undefined);
check('выход ведёт на вход', /\/login/.test(page.url()), page.url());

check(
  'ошибок в консоли нет',
  consoleErrors.length === 0,
  consoleErrors.slice(0, 2).join(' | ') || 'нет',
);

await browser.close();

console.warn(`\n=== ИТОГ: ${passed} OK, ${failed} FAIL ===\n`);
await run.finish(failed === 0);
process.exit(failed > 0 ? 1 : 0);

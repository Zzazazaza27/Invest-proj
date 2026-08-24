#!/usr/bin/env node
/**
 * Комплект демонстрационных данных в РЕАЛЬНОМ рендере (`RULES.md` §2).
 *
 * Живой прогон `smoke-demo.mjs` доказывает, что данные загружены, связаны и
 * отдаются API. Этот прогон отвечает на другой вопрос: ВИДНО ли их человеку —
 * то, ради чего комплект и делается.
 *
 *   1. проекты комплекта видны в каталоге инвестора карточками;
 *   2. снятый с публикации проект в каталоге не показывается;
 *   3. поиск в интерфейсе находит проект комплекта;
 *   4. избранное инвестора заполнено комплектом;
 *   5. обращение в поддержку из комплекта видно его автору вместе с ответом;
 *   6. материалы проекта раскрываются в кабинете эксперта.
 *
 * Запуск: node scripts/render-check-demo.mjs
 * Требуется: `npm run demo:load`, `npm run web:up`, ядро и собранные фронтенды.
 */
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PORTS } from './lib/ports.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE =
  process.env.WEB_URL ?? (PORTS.web === 80 ? 'http://127.0.0.1' : `http://127.0.0.1:${PORTS.web}`);

/** Пароль комплекта читается из `.env` и НЕ печатается. */
function demoPassword() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return null;
  const wanted = ['DEMO_USER_PASSWORD=', 'DEV_TEST_USER_PASSWORD='];
  for (const prefix of wanted) {
    for (const line of readFileSync(envFile, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
    }
  }
  return null;
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

const password = demoPassword();
if (!password) {
  console.error('Не задан DEMO_USER_PASSWORD / DEV_TEST_USER_PASSWORD — прогон невозможен.');
  process.exit(1);
}

async function signIn(page, login) {
  await page.goto(`${BASE}/login/`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.locator('#email').fill(login);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Войти' }).first().click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1800);
}

console.warn('\n=== РЕНДЕР-ПРОВЕРКА: КОМПЛЕКТ ДЕМОНСТРАЦИОННЫХ ДАННЫХ ===\n');

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1400, height: 950 } });
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

console.warn('[1] Каталог инвестора');
await signIn(page, 'demo-investor');
check('инвестор комплекта вошёл в свой кабинет', page.url().includes('/investor'), page.url());

{
  // Поиск, а не пролистывание: в каталоге стенда могут лежать тысячи чужих
  // проектов, и «карточка где-то есть» ничего не доказывает.
  await page.locator('#catalog-search').fill('пластырем');
  await page.getByRole('button', { name: 'Найти' }).click();
  await page.waitForTimeout(2000);
  const text = await page.locator('main').innerText();
  check('поиск нашёл проект комплекта', text.includes('Ритм-Диагностика'), text.slice(0, 80));
  check(
    'карточка показывает сумму запроса',
    // Неразрывный пробел (U+00A0) приводится к обычному: карточка форматирует
    // сумму именно им, а регулярное выражение о нём не знает. Литерал в коде
    // писать нельзя — линтер справедливо запрещает невидимые пробелы.
    /18\s?000\s?000|18000000/.test(text.replace(/\u00a0/g, ' ')),
    text.replace(/\s+/g, ' ').slice(0, 140),
  );
}

{
  await page.locator('#catalog-search').fill('Колба');
  await page.getByRole('button', { name: 'Найти' }).click();
  await page.waitForTimeout(2000);
  const text = await page.locator('main').innerText();
  // «Колба» снята с публикации основателем — её в каталоге быть не должно.
  check('снятый с публикации проект в каталоге не показан', !text.includes('Колба'), text.slice(0, 80));
}

console.warn('\n[2] Избранное заполнено комплектом');
{
  await page.getByRole('button', { name: 'Избранное', exact: true }).click();
  await page.waitForTimeout(2000);
  const text = await page.locator('main').innerText();
  check('в избранном «Аэросид»', text.includes('Аэросид'), text.slice(0, 100));
  check('в избранном «Точка сборки»', text.includes('Точка сборки'));
}

console.warn('\n[3] Обращение в поддержку из комплекта');
{
  const trialContext = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const trial = await trialContext.newPage();
  trial.on('pageerror', (error) => pageErrors.push(`инвестор без подписки: ${error}`));
  await signIn(trial, 'demo-investor-trial');
  await trial.getByRole('button', { name: 'Поддержка' }).click();
  await trial.waitForTimeout(2000);

  const text = await trial.locator('main').innerText();
  check('обращение комплекта видно автору', text.includes('Не понимаю, что входит в подписку'), text.slice(0, 120));
  check('сообщение об ошибке тоже на месте', text.includes('Фильтр по сумме сбрасывается'));
  check('обращение взято в работу', text.includes('в работе'));

  await trial.getByText('Не понимаю, что входит в подписку').first().click();
  await trial.waitForTimeout(1800);
  const thread = await trial.locator('main').innerText();
  check('ответ поддержки виден в переписке', thread.includes('Подписка открывает полную карточку'), thread.slice(0, 120));
  await trialContext.close();
}

console.warn('\n[4] Материалы проекта в кабинете эксперта');
{
  const expertContext = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const expert = await expertContext.newPage();
  expert.on('pageerror', (error) => pageErrors.push(`эксперт: ${error}`));
  await signIn(expert, 'demo-expert-fin');
  await expert.waitForTimeout(1500);

  const list = await expert.locator('main').innerText();
  check('назначение комплекта видно эксперту', list.includes('Ритм-Диагностика'), list.slice(0, 120));

  await expert.getByRole('button', { name: 'Материалы проекта' }).first().click();
  await expert.waitForTimeout(2500);
  const materials = await expert.locator('main').innerText();
  check(
    'материалы проекта раскрылись',
    materials.includes('Материалы'),
    materials.replace(/\s+/g, ' ').slice(0, 140),
  );
  await expertContext.close();
}

check('исключений на страницах нет', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await context.close();
await browser.close();

console.warn(`\nИТОГО: ${passed} пройдено, ${failed} провалено\n`);
process.exit(failed === 0 ? 0 : 1);

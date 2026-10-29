#!/usr/bin/env node
/**
 * Комплект демонстрационных данных в РЕАЛЬНОМ рендере (`RULES.md` §2).
 *
 * Живой прогон `smoke-demo.mjs` доказывает, что данные загружены, связаны и
 * отдаются API. Этот прогон отвечает на другой вопрос: ВИДНО ли их человеку —
 * то, ради чего комплект и делается.
 *
 *   1. поиск в каталоге витрины находит проект комплекта, карточка ведёт на
 *      страницу проекта;
 *   2. снятый с публикации проект в каталоге не показывается;
 *   3. инвестор комплекта входит в свой кабинет (пока — пустая оболочка);
 *   4. основатель комплекта видит в лаборатории свой проект и его материалы.
 *
 * Избранное и обращения комплекта в интерфейсе инвестора больше не видны:
 * кабинет инвестора после 2.1-W05 — оболочка «в разработке». Их связность
 * проверяет `smoke-demo.mjs` по API. Кабинет эксперта удалён вместе с
 * экспертизой.
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

console.warn('[1] Каталог витрины');
await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30_000 });
{
  // Поиск, а не пролистывание: в каталоге стенда могут лежать тысячи чужих
  // проектов, и «карточка где-то есть» ничего не доказывает.
  await page.locator('#catalog-search').fill('пластырем');
  await page.getByRole('button', { name: 'Найти' }).click();
  await page.waitForTimeout(2000);
  const text = await page.locator('#catalog').innerText();
  check('поиск нашёл проект комплекта', text.includes('Ритм-Диагностика'), text.slice(0, 80));

  const card = page.locator('li', { hasText: 'Ритм-Диагностика' }).locator('[data-teaser-link]');
  await card.first().click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  const projectText = await page.locator('main').innerText();
  check(
    'карточка ведёт на страницу проекта',
    page.url().includes('/p/') && projectText.includes('Ритм-Диагностика'),
    page.url(),
  );
}

{
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle', timeout: 30_000 });
  await page.locator('#catalog-search').fill('Колба');
  await page.getByRole('button', { name: 'Найти' }).click();
  await page.waitForTimeout(2000);
  const text = await page.locator('#catalog').innerText();
  // «Колба» снята с публикации основателем — её в каталоге быть не должно.
  check(
    'снятый с публикации проект в каталоге не показан',
    !text.includes('Колба'),
    text.slice(0, 80),
  );
}

console.warn('\n[2] Кабинет инвестора комплекта');
{
  const investorContext = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const investor = await investorContext.newPage();
  investor.on('pageerror', (error) => pageErrors.push(`инвестор: ${error}`));
  await signIn(investor, 'demo-investor');
  check(
    'инвестор комплекта вошёл в свой кабинет',
    investor.url().includes('/investor'),
    investor.url(),
  );
  check(
    'кабинет — оболочка «в разработке»',
    (await investor.locator('[data-investor-shell]').count()) === 1,
  );
  await investorContext.close();
}

console.warn('\n[3] Проект и материалы в лаборатории основателя');
{
  const founderContext = await browser.newContext({ viewport: { width: 1400, height: 950 } });
  const founder = await founderContext.newPage();
  founder.on('pageerror', (error) => pageErrors.push(`основатель: ${error}`));
  await signIn(founder, 'demo-founder-ritm');

  const list = await founder.locator('main').innerText();
  check('проект комплекта виден основателю', list.includes('Ритм-Диагностика'), list.slice(0, 120));

  await founder.getByText('Ритм-Диагностика').first().click();
  await founder.waitForLoadState('networkidle');
  await founder.waitForTimeout(2000);
  // В комплекте у «Ритма» два материала — колода и клиническая сводка.
  const materials = await founder.locator('[data-material-visibility]').count();
  check('материалы проекта раскрылись', materials === 2, `материалов ${materials}`);
  await founderContext.close();
}

check('исключений на страницах нет', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));

await context.close();
await browser.close();

console.warn(`\nИТОГО: ${passed} пройдено, ${failed} провалено\n`);
process.exit(failed === 0 ? 0 : 1);

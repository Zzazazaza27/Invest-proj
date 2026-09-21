#!/usr/bin/env node
/**
 * Связанный сценарий на механизме тестовых сессий.
 *
 * Это ОБРАЗЕЦ того, как теперь пишется сценарная проверка: без своих учётных
 * записей, без паролей и без уборки вручную. Всё, что прогон создал, числится
 * за сессией; шаги и итог видны в админке; упавший прогон остаётся для
 * разбора.
 *
 * Сценарий — тот, который владелец назвал главным:
 *   основатель заводит заявку → эксперт смотрит доступное ему → инвестор
 *   видит каталог → гость видит витрину как посторонний.
 *
 * ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ ПОПУТНО. Что участники — обычные пользователи со
 * своими правами: эксперт не видит чужого проекта без назначения, инвестор
 * не получает кабинета основателя, гость не видит ничего закрытого. Если бы
 * контекст подмешивал права администратора, эти шаги прошли бы «слишком
 * хорошо».
 *
 * Запуск: node scripts/scenario-round-review.mjs
 *         node scripts/scenario-round-review.mjs --keep   не убирать данные
 */
import { startSession } from './lib/testing-session.mjs';

const KEEP = process.argv.includes('--keep');

let passed = 0;
let failed = 0;
function say(name, ok, detail = '') {
  if (ok) passed += 1;
  else failed += 1;
  console.warn(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

console.warn('\n=== СЦЕНАРИЙ: ЗАЯВКА, ЭКСПЕРТ, ИНВЕСТОР ===\n');

const run = await startSession(`Сценарий «заявка → эксперт → инвестор»`, {
  scenarioId: 'round-review',
  codeVersion: process.env.GIT_COMMIT ?? null,
});
console.warn(`сессия: ${run.id}\n`);

try {
  const founder = run.as('founder');
  const expert = run.as('expert');
  const investor = run.as('investor');

  // ------------------------------------------------------------ основатель
  console.warn('[1] Основатель');
  const mine = await founder.call('/v1/projects');
  const okProjects = mine.status === 200;
  say('кабинет основателя открывается', okProjects, `HTTP ${mine.status}`);
  await run.step('кабинет основателя открывается', okProjects, {
    actor: 'основатель',
    expected: 'HTTP 200',
    actual: `HTTP ${mine.status}`,
  });

  // Направление берём из справочника: заявка без него не создаётся, и
  // подставлять выдуманный идентификатор значило бы проверять валидацию, а
  // не сценарий.
  const taxonomy = await founder.call('/v1/taxonomy');
  const branch = (taxonomy.json?.items ?? [])[0];
  const created = await founder.call('/v1/projects', {
    method: 'POST',
    body: {
      title: `Проект сессии ${Date.now().toString().slice(-6)}`,
      stage: 'mvp',
      taxonomyId: branch?.id,
      investmentAsk: '5000000',
      askCurrency: 'RUB',
    },
  });
  const projectCreated = created.status === 200 || created.status === 201;
  say('заявка заводится', projectCreated, `HTTP ${created.status} ${created.text.slice(0, 120)}`);
  await run.step('заявка заводится', projectCreated, {
    actor: 'основатель',
    expected: 'HTTP 201',
    actual: `HTTP ${created.status}`,
  });

  // --------------------------------------------------------------- эксперт
  console.warn('\n[2] Эксперт');
  const assignments = await expert.call('/v1/experts/assignments');
  const expertOk = assignments.status === 200;
  say('рабочая зона эксперта открывается', expertOk, `HTTP ${assignments.status}`);
  await run.step('рабочая зона эксперта открывается', expertOk, {
    actor: 'эксперт',
    expected: 'HTTP 200',
    actual: `HTTP ${assignments.status}`,
  });

  const items = assignments.json?.items ?? [];
  const noStrangers = items.length === 0;
  say('без назначения эксперт не видит чужих проектов', noStrangers, `назначений: ${items.length}`);
  await run.step('без назначения эксперт не видит чужих проектов', noStrangers, {
    actor: 'эксперт',
    expected: '0 назначений',
    actual: String(items.length),
  });

  // Права не объединяются: эксперт под контекстом остаётся экспертом.
  const expertToAdmin = await expert.call('/v1/admin/users?perPage=1');
  const closed = expertToAdmin.status === 403;
  say('эксперт не получает административных прав', closed, `HTTP ${expertToAdmin.status}`);
  await run.step('эксперт не получает административных прав', closed, {
    actor: 'эксперт',
    expected: 'HTTP 403',
    actual: `HTTP ${expertToAdmin.status}`,
  });

  // -------------------------------------------------------------- инвестор
  console.warn('\n[3] Инвестор');
  const catalog = await investor.call('/v1/catalog?limit=5');
  const catalogOk = catalog.status === 200;
  say('каталог открывается инвестору', catalogOk, `HTTP ${catalog.status}`);
  await run.step('каталог открывается инвестору', catalogOk, {
    actor: 'инвестор',
    expected: 'HTTP 200',
    actual: `HTTP ${catalog.status}`,
  });

  const founderOnly = await investor.call('/v1/projects');
  // Кабинет основателя инвестору не принадлежит: пустой список — верный
  // ответ, а вот чужие проекты в нём были бы протечкой.
  const mineForInvestor = founderOnly.json?.items ?? [];
  const noLeak = founderOnly.status !== 200 || mineForInvestor.length === 0;
  say('инвестор не видит проектов основателя', noLeak, `HTTP ${founderOnly.status}`);
  await run.step('инвестор не видит проектов основателя', noLeak, {
    actor: 'инвестор',
    expected: 'пусто или отказ',
    actual: `HTTP ${founderOnly.status}, элементов ${mineForInvestor.length}`,
  });

  // ----------------------------------------------------------------- гость
  console.warn('\n[4] Гость');
  const guest = await run.asGuest();
  const publicCatalog = await guest.call('/v1/catalog?limit=3');
  const guestSeesPublic = publicCatalog.status === 200;
  say('витрина открыта гостю', guestSeesPublic, `HTTP ${publicCatalog.status}`);
  await run.step('витрина открыта гостю', guestSeesPublic, {
    actor: 'гость',
    expected: 'HTTP 200',
    actual: `HTTP ${publicCatalog.status}`,
  });

  const guestClosed = await guest.call('/v1/projects');
  const guestDenied = guestClosed.status === 401;
  say('закрытое гостю не отдаётся', guestDenied, `HTTP ${guestClosed.status}`);
  await run.step('закрытое гостю не отдаётся', guestDenied, {
    actor: 'гость',
    expected: 'HTTP 401',
    actual: `HTTP ${guestClosed.status}`,
  });
} finally {
  const outcome = await run.finish();
  console.warn(`\nитог сессии: ${outcome.result}, упавших шагов: ${outcome.failedSteps}`);
  console.warn(`разбор: ${outcome.adminUrl} → «${run.id}»`);

  // Успешный прогон убирает за собой; упавший остаётся: его данные и есть
  // материал разбора. Это правило владельца, а не оптимизация.
  if (outcome.result === 'passed' && !KEEP) {
    const cleaned = await run.cleanup();
    console.warn(`убрано: удалено ${cleaned?.deleted ?? 0}, помечено ${cleaned?.marked ?? 0}`);
  } else {
    console.warn('данные сессии сохранены для разбора');
  }
}

console.warn(`\nпройдено: ${passed}, дефектов: ${failed}\n`);
process.exit(failed === 0 ? 0 : 1);

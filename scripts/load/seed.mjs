#!/usr/bin/env node
/**
 * Данные нагрузочного прогона p1 (W32, docs/architecture/w32-load-failures-plan.md §3).
 *
 *   node scripts/load/seed.mjs seed  --users 20 --projects 200 [--run-id <id>]
 *   node scripts/load/seed.mjs clean --run-id <id>
 *
 * Цель — FIFTH_LOAD_BASE (по умолчанию http://127.0.0.1), только публичное API.
 *
 * ЧТО ДЕЛАЕТ seed. Открывает тестовую сессию администратора (учёт прогона, как
 * scripts/lib/probe-run.mjs), регистрирует N основателей с происхождением
 * `load_test` под секретом сессии, одобряет им KYC (без него проект не открыть),
 * заводит M проектов поровну между основателями: чётные открываются всем
 * (`public`), нечётные остаются `private` — «ограниченная видимость», к ним
 * относится ожидаемый отказ. На каждый проект — 2 материала-ссылки. Проекты
 * записываются за сессией, чтобы их нашла уборка.
 *
 * Итог — `.local/load/<run_id>/users.json` (вне Git): почты и пароли участников,
 * их проекты, списки открытых и закрытых проектов, направления — вход для k6.
 * Пароли не печатаются.
 *
 * ЧТО ДЕЛАЕТ clean. Закрывает сессию и вызывает её уборку: участники и проекты
 * помечаются (физически их удалить схема не даёт, см. probe-run.mjs). Чего
 * уборка не касается — в конце вывода.
 */
import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASE, adminLogin, client, parseArgs, runDir } from './lib.mjs';

const CONSENTS = ['platform_rules', 'tos', 'pdn', 'commission_terms'].map((kind) => ({
  kind,
  version: 'v1',
  locale: 'ru-RU',
}));
const STAGES = ['idea', 'mvp', 'early_revenue', 'growth'];

function defaultRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `p1-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

function must(r, what, ok = [200, 201]) {
  if (!ok.includes(r.status)) {
    const code = r.json?.code ? ` (${r.json.code})` : '';
    throw new Error(`${what}: HTTP ${r.status}${code}`);
  }
  return r.json;
}

async function seed(args) {
  const runId = String(args['run-id'] ?? defaultRunId());
  const dir = runDir(runId);
  const file = join(dir, 'users.json');
  if (existsSync(file)) throw new Error(`данные прогона ${runId} уже есть: ${file}`);
  const nUsers = Number(args.users ?? 20);
  const nProjects = Number(args.projects ?? 200);
  if (!(nUsers >= 1 && nProjects >= 2)) throw new Error('нужно --users ≥ 1 и --projects ≥ 2');

  console.log(`\n=== ДАННЫЕ НАГРУЗКИ p1: ${runId} → ${BASE} ===\n`);
  const admin = await adminLogin();
  const session = must(
    await admin.call('/v1/admin/testing/sessions', {
      method: 'POST',
      body: {
        title: `Нагрузка p1 ${runId}`,
        source: 'automated',
        scenarioId: `LOAD-P1-${runId}`,
        withStandardCast: false,
      },
    }),
    'тестовая сессия (нужны тестовый контур и право testing.sessions.manage)',
  );
  if (!session?.runToken) throw new Error('сервер не выдал секрет запуска');
  // Секрет запуска живёт только в памяти: в файл и вывод не попадает.
  const runHeaders = { 'X-Fifth-Origin': 'load_test', 'X-Fifth-Run': session.runToken };
  mkdirSync(dir, { recursive: true });
  // Отметка сессии пишется сразу: уборка возможна, даже если подготовка упадёт.
  writeFileSync(
    join(dir, 'session.json'),
    JSON.stringify({ runId, base: BASE, sessionId: session.id }, null, 2),
  );
  console.log(`  тестовая сессия ${session.id}`);

  const taxonomy = must(await admin.call('/v1/taxonomy'), 'направления');
  const taxonomyIds = (taxonomy?.items ?? []).map((t) => t.id);
  if (taxonomyIds.length === 0) throw new Error('справочник направлений пуст');

  const users = [];
  for (let i = 0; i < nUsers; i += 1) {
    const c = client();
    const email = `load-${runId}-${i}@test.local`;
    const password = `Pw-${randomUUID()}`;
    must(
      await c.call('/v1/auth/register', {
        method: 'POST',
        headers: runHeaders,
        body: {
          email,
          password,
          displayName: `Нагрузка ${runId} ${i}`,
          role: 'founder',
          locale: 'ru-RU',
          consents: CONSENTS,
        },
      }),
      `регистрация участника ${i}`,
    );
    const me = must(await c.call('/v1/auth/me'), `профиль участника ${i}`);
    const kyc = must(
      await c.call('/v1/kyc/verifications', {
        method: 'POST',
        body: { kind: 'identity', docType: 'passport', docCountry: 'RU' },
      }),
      `заявка KYC участника ${i}`,
    );
    must(
      await admin.call(`/v1/kyc/verifications/${kyc.id}/decision`, {
        method: 'POST',
        body: { decision: 'approved', riskLevel: 'low' },
      }),
      `решение KYC участника ${i}`,
    );
    users.push({ index: i, id: me.id, email, password, client: c, projects: [] });
    console.log(`  участник ${i + 1}/${nUsers}`);
  }

  const publicProjects = [];
  const privateProjects = [];
  let links = 0;
  for (let j = 0; j < nProjects; j += 1) {
    const owner = users[j % nUsers];
    const project = must(
      await owner.client.call('/v1/projects', {
        method: 'POST',
        key: true,
        body: {
          title: `Нагрузка p1 ${runId} проект ${j}`,
          tagline: 'Синтетический проект нагрузочного прогона',
          description: 'Создан подготовкой нагрузочного прогона p1; уберётся вместе с прогоном.',
          stage: STAGES[j % STAGES.length],
          taxonomyId: taxonomyIds[j % taxonomyIds.length],
          investmentAsk: String(1_000_000 + randomInt(1000) * 1000),
          askCurrency: 'RUB',
        },
      }),
      `проект ${j}`,
    );
    // Сразу за сессией: иначе уборка его не увидит.
    must(
      await admin.call(`/v1/admin/testing/sessions/${session.id}/objects`, {
        method: 'POST',
        body: { table: 'lab.projects', id: project.id },
      }),
      `учёт проекта ${j}`,
    );
    const open = j % 2 === 0;
    if (open) {
      must(
        await owner.client.call(`/v1/projects/${project.id}/visibility`, {
          method: 'PUT',
          body: { visibility: 'public' },
        }),
        `видимость проекта ${j}`,
      );
      publicProjects.push(project.id);
    } else privateProjects.push({ id: project.id, owner: owner.index });
    for (let k = 0; k < 2; k += 1) {
      must(
        await owner.client.call(`/v1/projects/${project.id}/materials/link`, {
          method: 'POST',
          key: true,
          body: { url: `https://example.com/load/${runId}/${j}/${k}` },
        }),
        `ссылка ${k} проекта ${j}`,
      );
      links += 1;
    }
    owner.projects.push({ id: project.id, visibility: open ? 'public' : 'private' });
    if ((j + 1) % 10 === 0 || j + 1 === nProjects) console.log(`  проекты ${j + 1}/${nProjects}`);
  }

  const out = {
    profile: 'p1',
    runId,
    base: BASE,
    sessionId: session.id,
    createdAt: new Date().toISOString(),
    taxonomyIds,
    stages: STAGES,
    users: users.map(({ index, id, email, password, projects }) => ({
      index,
      id,
      email,
      password,
      projects,
    })),
    publicProjects,
    privateProjects,
  };
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(
    `\n  готово: участников ${users.length}, проектов ${nProjects} ` +
      `(открытых ${publicProjects.length}, закрытых ${privateProjects.length}), ссылок ${links}`,
  );
  console.log(`  файл участников: ${file} (пароли внутри, вне Git)`);
  console.log(`  уборка: node scripts/load/seed.mjs clean --run-id ${runId}`);
}

async function clean(args) {
  const runId = String(args['run-id'] ?? '');
  const dir = runDir(runId);
  const marker = join(dir, 'session.json');
  if (!existsSync(marker)) throw new Error(`нет отметки сессии прогона: ${marker}`);
  const { sessionId, base } = JSON.parse(readFileSync(marker, 'utf8'));
  if (base !== BASE) throw new Error(`прогон готовился для ${base}, а цель сейчас ${BASE}`);
  console.log(`\n=== УБОРКА НАГРУЗКИ p1: ${runId} (сессия ${sessionId}) ===\n`);
  const admin = await adminLogin();
  // Закрыть сессию: уже закрытая отвечает отказом — это не помеха уборке.
  await admin.call(`/v1/admin/testing/sessions/${sessionId}/finish`, {
    method: 'POST',
    body: { result: 'passed' },
  });
  const preview = await admin.call(`/v1/admin/testing/sessions/${sessionId}/cleanup`);
  if (preview.status === 200) {
    const plan = preview.json?.plan;
    console.log(`  состав уборки: ${JSON.stringify(plan).slice(0, 400)}`);
  }
  const done = must(
    await admin.call(`/v1/admin/testing/sessions/${sessionId}/cleanup`, { method: 'POST' }),
    'уборка сессии',
  );
  console.log(`  помечено ${done.marked ?? 0}, удалено ${done.deleted ?? 0}`);
  console.log(
    '  не убираются этой командой: заявки KYC, материалы-ссылки и загруженные файлы' +
      ' (объекты хранилища), события журнала и outbox, письма подтверждения адреса.',
  );
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
try {
  if (command === 'seed') await seed(args);
  else if (command === 'clean') await clean(args);
  else {
    console.log(
      'использование: seed.mjs seed --users N --projects M [--run-id id] | clean --run-id id',
    );
    process.exit(2);
  }
} catch (error) {
  console.error(`\n  ОТКАЗ: ${error.message}`);
  process.exit(1);
}

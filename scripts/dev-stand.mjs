#!/usr/bin/env node
/**
 * Локальный стенд: учётные записи по ролям и данные, на которых видно работу.
 *
 * Зачем отдельно от `dev-seed-test-user.mjs`: та учётка совмещает ВСЕ роли, и
 * на ней невозможно увидеть главное свойство платформы — что роли видят разное.
 * Здесь заводится по учётной записи на роль, и каждый кабинет открывается тем,
 * для кого он написан.
 *
 * Скрипт идемпотентен: повторный запуск приводит стенд к тому же состоянию, а
 * не плодит вторые копии. Пароль берётся из `DEV_TEST_USER_PASSWORD` в `.env` —
 * в репозитории паролей нет, даже тестовых.
 *
 * Работает ТОЛЬКО вне production: проверка стоит первой строкой.
 *
 * Запуск: node scripts/dev-stand.mjs
 */
import pg from 'pg';
import argon2 from 'argon2';
import { createCipheriv, createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

if (process.env.NODE_ENV === 'production') {
  console.error('Стенд с тестовыми учётными записями в production не разворачивается.');
  process.exit(1);
}

const PASSWORD = process.env.DEV_TEST_USER_PASSWORD ?? '';
if (!PASSWORD) {
  console.error('Не задан DEV_TEST_USER_PASSWORD в .env — пароль стенда не хранится в коде.');
  process.exit(1);
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

function blindIndex(value) {
  return createHmac('sha256', Buffer.from(process.env.KEK_SEARCH_INDEX ?? '', 'base64'))
    .update(`email:${value.trim().toLowerCase()}`, 'utf8')
    .digest();
}

const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

/** Envelope-шифрование адреса: формат и AAD совпадают с CryptoService. */
function sealContact(email) {
  const kek = Buffer.from(process.env.KEK_PASSPORT_SENSITIVE ?? '', 'base64');
  if (kek.length !== 32) throw new Error('KEK_PASSPORT_SENSITIVE не задан или неверной длины');
  const dek = randomBytes(32);
  const encrypt = (key, plaintext, aad) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  };
  const ciphertext = encrypt(dek, Buffer.from(email, 'utf8'), 'field:email');
  const wrappedDek = encrypt(kek, dek, 'wrap:passport_sensitive');
  dek.fill(0);
  return { ciphertext, wrappedDek };
}

/**
 * Учётная запись стенда.
 *
 * Заводится напрямую в базе по той же причине, что и `ssurgut`: пароль стенда
 * короче политики регистрации, а ослаблять политику ради удобства нельзя —
 * она защищает настоящих пользователей. Всё остальное — как в бою: тот же
 * алгоритм хеширования, то же шифрование адреса, те же обязательные акцепты.
 */
async function upsertUser(login, displayName, primaryRole, roles) {
  const email = `${login}@unicorn.local`;
  const hash = await argon2.hash(PASSWORD, ARGON2_OPTIONS);
  const [existing] = await sql('SELECT id FROM identity.users WHERE email_hmac = $1', [
    blindIndex(email),
  ]);

  let userId = existing?.id ?? null;
  if (userId) {
    await sql(`UPDATE identity.users SET password_hash = $2, status = 'active' WHERE id = $1`, [
      userId,
      hash,
    ]);
  } else {
    const contact = sealContact(email);
    const [created] = await sql(
      `INSERT INTO identity.users
         (id, email_ciphertext, contact_wrapped_dek, email_hmac, password_hash,
          display_name, primary_role, status, locale)
       VALUES (public.uuid_generate_v7(), $1, $2, $3, $4, $5, $6, 'pending_consents', 'ru-RU')
       RETURNING id`,
      [contact.ciphertext, contact.wrappedDek, blindIndex(email), hash, displayName, primaryRole],
    );
    userId = created.id;

    await sql(
      `INSERT INTO identity.consents (id, user_id, kind, version, locale, request_trace_hash)
       SELECT public.uuid_generate_v7(), $1, t.kind, t.version, t.locale,
              digest('dev-stand-trace', 'sha256')
         FROM identity.consent_templates t
        WHERE t.superseded_at IS NULL AND t.locale = 'ru-RU'
          AND t.kind IN ('platform_rules','tos','pdn','commission_terms')`,
      [userId],
    );
    await sql(`UPDATE identity.users SET status = 'active' WHERE id = $1`, [userId]);
  }

  for (const role of roles) {
    await sql(
      `INSERT INTO identity.user_roles (user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [userId, role],
    );
  }
  return { login, email, userId, roles };
}

console.warn('\n=== ЛОКАЛЬНЫЙ СТЕНД UNICORN LAUNCH ===\n');
console.warn('--- учётные записи ---');

// Админ заводится первым: одобрение верификации выполняет ДРУГОЙ человек,
// самоодобрение запрещено триггером БД.
const admin = await upsertUser('stand-admin', 'Стенд · администратор', 'founder', ['admin']);
const organizer = await upsertUser('stand-organizer', 'Стенд · организатор', 'founder', [
  'organizer',
]);
const founder = await upsertUser('stand-founder', 'Стенд · основатель', 'founder', ['founder']);
const investor = await upsertUser('stand-investor', 'Стенд · инвестор', 'investor', ['investor']);
const expert = await upsertUser('stand-expert', 'Стенд · эксперт', 'founder', ['expert']);

for (const person of [admin, organizer, founder, investor, expert]) {
  console.warn(`  ${person.login.padEnd(16)} роли: ${person.roles.join(', ')}`);
}

// ------------------------------------------------------------- верификация
// Основателю и инвестору нужна одобренная проверка личности: без неё нельзя
// ни опубликовать листинг, ни участвовать в регулируемом контуре.
for (const person of [founder, investor]) {
  await sql(
    `INSERT INTO kyc.kyc_verifications
       (id, user_id, kind, status, risk_level, sanctions_status, reviewed_by, decided_at, expires_at)
     SELECT public.uuid_generate_v7(), $1, 'identity', 'approved', 'low', 'clear', $2, now(),
            now() + interval '1 year'
      WHERE NOT EXISTS (
        SELECT 1 FROM kyc.kyc_verifications
         WHERE user_id = $1 AND kind = 'identity' AND status = 'approved')`,
    [person.userId, admin.userId],
  );
}

// ------------------------------------------------------------------- сезон
console.warn('\n--- данные стенда ---');

let [season] = await sql(
  `SELECT id, number FROM seasons.seasons WHERE title = 'Стенд · сезон' LIMIT 1`,
);
if (!season) {
  [season] = await sql(
    `INSERT INTO seasons.seasons (id, number, title, starts_at, ends_at, status, funnel_config_jsonb)
     VALUES (public.uuid_generate_v7(),
             (SELECT coalesce(max(number), 0) + 1 FROM seasons.seasons),
             'Стенд · сезон', now() - interval '7 days', now() + interval '60 days',
             'applications_open',
             '{"quotas":{"bootcamp":3,"finalist":2},"schedule":{}}'::jsonb)
     RETURNING id, number`,
  );
}
console.warn(`  сезон №${season.number} — приём заявок открыт, квоты: буткемп 3, финал 2`);

// ------------------------------------------------------------------ проект
const [taxonomy] = await sql(`SELECT id FROM lab.project_taxonomy WHERE slug = 'fintech'`);
let [project] = await sql(
  `SELECT id, title FROM lab.projects WHERE title = 'Стенд · демонстрационный проект'`,
);
if (!project) {
  [project] = await sql(
    `INSERT INTO lab.projects
       (id, taxonomy_id, season_id, title, tagline, description, stage, status,
        geo_country, investment_ask, ask_currency, required_plan_id)
     VALUES (public.uuid_generate_v7(), $1, $2, 'Стенд · демонстрационный проект',
             'Платёжный сервис для малого бизнеса',
             'Проект стенда: на нём видно карточку, материалы, экспертизу и путь по сезону.',
             'growth', 'expert_review', 'RU', 5000000, 'RUB',
             billing.resolve_founder_plan(5000000))
     RETURNING id, title`,
    [taxonomy.id, season.id],
  );
  await sql(
    `INSERT INTO lab.founders_projects (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [project.id, founder.userId],
  );
  await sql(
    `INSERT INTO lab.project_versions (id, project_id, season_id, version_no, snapshot_jsonb)
     VALUES (public.uuid_generate_v7(), $1, $2, 1,
             '{"title":"Стенд · демонстрационный проект"}'::jsonb)`,
    [project.id, season.id],
  );
  await sql(
    `INSERT INTO lab.project_materials
       (id, project_id, type, version, url, parse_status, uploaded_by)
     VALUES (public.uuid_generate_v7(), $1, 'product_link', 1, 'https://example.com/product',
             'not_required', $2)`,
    [project.id, founder.userId],
  );
}

// Подписка основателя: без активной подписки нужного тарифа листинг закрыт.
await sql(
  `INSERT INTO billing.subscriptions
     (id, user_id, plan_id, project_id, price_snapshot, currency_snapshot, terms_version,
      status, current_period_end)
   SELECT public.uuid_generate_v7(), $2, p.required_plan_id, p.id, pl.price, 'RUB', 'v1',
          'active', now() + interval '30 days'
     FROM lab.projects p
     JOIN billing.subscription_plans pl ON pl.id = p.required_plan_id
    WHERE p.id = $1
      AND NOT EXISTS (SELECT 1 FROM billing.subscriptions s
                       WHERE s.project_id = p.id AND s.status = 'active')`,
  [project.id, founder.userId],
);
await sql(
  `UPDATE lab.projects SET listing_status = 'listed', listed_at = coalesce(listed_at, now())
    WHERE id = $1 AND listing_status <> 'listed'`,
  [project.id],
);
console.warn('  проект основателя опубликован в каталоге (подписка активна)');

// Подписка инвестора: она открывает полные карточки каталога.
await sql(
  `INSERT INTO billing.subscriptions
     (id, user_id, plan_id, project_id, price_snapshot, currency_snapshot, terms_version,
      status, current_period_end)
   SELECT public.uuid_generate_v7(), $1, pl.id, NULL, pl.price, 'RUB', 'v1',
          'active', now() + interval '30 days'
     FROM billing.subscription_plans pl
    WHERE pl.code = 'investor_membership' AND pl.valid_to IS NULL
      AND NOT EXISTS (SELECT 1 FROM billing.subscriptions s
                       WHERE s.user_id = $1 AND s.project_id IS NULL AND s.status = 'active')
    ORDER BY pl.version DESC
    LIMIT 1`,
  [investor.userId],
);
console.warn('  подписка инвестора активна — каталог открывается полностью');

// Назначение эксперта: без него кабинет эксперта пуст и показывать нечего.
await sql(
  `INSERT INTO experts.experts (user_id, expertise_tags, capacity_per_week, is_public)
   VALUES ($1, ARRAY['fintech'], 5, true) ON CONFLICT (user_id) DO NOTHING`,
  [expert.userId],
);
await sql(
  `INSERT INTO experts.expert_assignments
     (id, project_id, expert_id, season_id, assigned_reason, status, due_at)
   SELECT public.uuid_generate_v7(), $1, $2, $3, 'manual', 'assigned', now() + interval '7 days'
    WHERE NOT EXISTS (SELECT 1 FROM experts.expert_assignments
                       WHERE project_id = $1 AND expert_id = $2)`,
  [project.id, expert.userId, season.id],
);
console.warn('  эксперту назначена рецензия на проект стенда');

// ------------------------------------------------------ проверка сервисов
console.warn('\n--- сервисы ---');

const SERVICES = [
  ['ядро API', 'http://127.0.0.1:4300/v1/health'],
  ['AI-шлюз', 'http://127.0.0.1:8100/healthz'],
  ['витрина', 'http://127.0.0.1:5173/'],
  ['админка', 'http://127.0.0.1:5174/'],
  ['кабинет основателя', 'http://127.0.0.1:5175/'],
  ['кабинет инвестора', 'http://127.0.0.1:5176/'],
  ['кабинет эксперта', 'http://127.0.0.1:5177/'],
];

let down = 0;
for (const [name, url] of SERVICES) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    // Ответ 404 означает, что сервис жив, но проверяется НЕ ТОТ адрес: считать
    // это исправностью — ровно тот ложно-зелёный результат, ради которого
    // проверка и заводится.
    if (!response.ok) {
      down += 1;
      console.warn(`  НЕТ  ${name.padEnd(20)} ${url} — HTTP ${response.status}`);
      continue;
    }
    console.warn(`  OK   ${name.padEnd(20)} ${url} (HTTP ${response.status})`);
  } catch {
    down += 1;
    console.warn(`  НЕТ  ${name.padEnd(20)} ${url} — не отвечает`);
  }
}

console.warn('\n=== КАК ВОЙТИ ===\n');
console.warn(`  Пароль у всех учётных записей один: ${PASSWORD}`);
console.warn('  В поле входа достаточно короткого логина — домен подставляется сам.\n');
console.warn('  http://127.0.0.1:5176/   кабинет инвестора    → stand-investor');
console.warn('  http://127.0.0.1:5175/   кабинет основателя   → stand-founder');
console.warn('  http://127.0.0.1:5177/   кабинет эксперта     → stand-expert');
console.warn('  http://127.0.0.1:5174/   админка              → stand-admin');
console.warn('  http://127.0.0.1:5174/   воронка сезона       → stand-organizer (только чтение)');
console.warn('  http://127.0.0.1:5173/   публичная витрина    → без входа\n');
console.warn('  Учётка со ВСЕМИ ролями сразу: ssurgut (node scripts/dev-seed-test-user.mjs)\n');

if (down > 0) {
  console.warn(`Не отвечает сервисов: ${down}. Стенд неполон — подними их и запусти снова.\n`);
}

await pool.end();
// Код возврата задаётся, а не вызывается process.exit(): принудительный выход
// сразу после закрытия пула роняет libuv на Windows с assertion внутри
// обработчика — процесс завершался ошибкой при полностью успешном прогоне.
process.exitCode = down > 0 ? 1 : 0;

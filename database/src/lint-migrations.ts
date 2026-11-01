/**
 * Линтер миграций. Ловит классы ошибок, которые дороже всего чинить в проде:
 * необратимые contract-операции без отдельной миграции, таблицы без RLS,
 * секреты в SQL, функции без фиксированного search_path.
 *
 * Гейт CI: 0 находок уровня ERROR.
 * Запуск: npm run lint:migrations -w database
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MIGRATIONS_DIR } from './env.ts';

interface Finding {
  severity: 'ERROR' | 'WARN';
  file: string;
  line: number;
  rule: string;
  message: string;
}

/**
 * Применённые миграции, которые нельзя пометить `-- migrate:contract`
 * задним числом.
 *
 * Причина не в лени. Файл миграции участвует в контрольной сумме
 * (`migrate.ts`: «правка уже применённого файла ломает прогон»), и добавление
 * даже одной строки-комментария сделает `npm run migrate` красным на каждом
 * контуре, где миграция уже применена — включая боевой. Правило
 * forward-only здесь сильнее правила «пометь операцию».
 *
 * Поэтому отступление регистрируется ЗДЕСЬ, с причиной и видимым
 * предупреждением в каждом прогоне. Новые миграции это не ослабляет: для них
 * отсутствие метки по-прежнему ERROR.
 */
const CONTRACT_WITHOUT_MARKER: Record<string, string> = {
  'M094_drop_founder_subscription_model.sql':
    'отменённая модель подписки основателя (5.9); применена до введения метки, ' +
    'правка файла сломала бы контрольную сумму уже применённой миграции',
};

const findings: Finding[] = [];

function add(
  severity: Finding['severity'],
  file: string,
  line: number,
  rule: string,
  message: string,
) {
  findings.push({ severity, file, line, rule, message });
}

/** Убирает комментарии и строковые литералы — правила не должны срабатывать на текст. */
function stripNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\$\$[\s\S]*?\$\$/g, ' $BODY$ ');
}

const files = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (files.length === 0) {
  console.error('Миграции не найдены — это само по себе ошибка конфигурации.');
  process.exitCode = 1;
}

// Текст всех миграций — для правил, где исправление может прийти следующей
// миграцией: применённая миграция не правится (forward-only), поэтому
// забытый RLS чинится только новой. Правило по-прежнему ловит таблицу, которую
// не исправила ни одна миграция.
const allSql = files.map((f) => stripNoise(readFileSync(join(MIGRATIONS_DIR, f), 'utf8')));

for (const [fileIndex, file] of files.entries()) {
  const raw = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
  const sql = stripNoise(raw);
  // Эта миграция и все последующие.
  const fromHere = allSql.slice(fileIndex).join('\n');
  const lines = raw.split('\n');

  const lineOf = (needle: RegExp): number => {
    const idx = lines.findIndex((l) => needle.test(l));
    return idx >= 0 ? idx + 1 : 1;
  };

  // --- 1. Contract-операции: разрушают данные, требуют отдельного релиза ----
  //
  // Законный contract-шаг (код перестал использовать объект, expand-миграция
  // уже выкатана) помечается строкой `-- migrate:contract` в самом файле.
  // Маркер не выключает проверку, а переводит её в WARNING: осознанная
  // операция остаётся видимой в каждом прогоне, случайная — по-прежнему ERROR.
  const contractMarker = /^\s*--\s*migrate:contract\s*$/m.test(raw);
  const contractOps: [RegExp, string][] = [
    [/\bDROP\s+TABLE\b/i, 'DROP TABLE'],
    [/\bDROP\s+COLUMN\b/i, 'DROP COLUMN'],
    // Только как команда в начале выражения: в GRANT/REVOKE слово TRUNCATE —
    // это имя привилегии, а отзыв привилегии не разрушает данные.
    [/(?:^|;)\s*TRUNCATE\b/im, 'TRUNCATE'],
    [/\bALTER\s+TABLE[\s\S]{0,80}?\bALTER\s+COLUMN[\s\S]{0,40}?\bTYPE\b/i, 'смена типа колонки'],
  ];
  for (const [re, label] of contractOps) {
    if (re.test(sql)) {
      if (contractMarker) {
        add(
          'WARN',
          file,
          lineOf(re),
          'expand-contract',
          `${label} — contract-операция, помечена осознанной (migrate:contract). ` +
            'Убедись, что expand-миграция выкатана и код объект не использует.',
        );
      } else if (CONTRACT_WITHOUT_MARKER[file]) {
        add(
          'WARN',
          file,
          lineOf(re),
          'expand-contract',
          `${label} — contract-операция без метки, отступление зарегистрировано: ` +
            `${CONTRACT_WITHOUT_MARKER[file]}`,
        );
      } else {
        add(
          'ERROR',
          file,
          lineOf(re),
          'expand-contract',
          `${label} — необратимая contract-операция. Она выносится в отдельную миграцию ` +
            'после того, как код перестал использовать объект (docs/architecture/Database_Launch.md §16), ' +
            'и помечается строкой `-- migrate:contract`.',
        );
      }
    }
  }

  // --- 1b. Миграции вне транзакции: только идемпотентные операции ----------
  //
  // Раннер выполняет такую миграцию без BEGIN/COMMIT (иначе CREATE INDEX
  // CONCURRENTLY невозможен вовсе). Откатить её нечем: упавшая посередине
  // миграция оставляет часть изменений применёнными, и следующий прогон обязан
  // безопасно повториться. Поэтому здесь требуется IF NOT EXISTS, а операции,
  // которые нельзя повторить, запрещены.
  const noTransaction = /^\s*--\s*migrate:no-transaction\s*$/m.test(raw);
  const concurrentIndex = /CREATE\s+INDEX\s+CONCURRENTLY/i.test(sql);

  if (concurrentIndex && !noTransaction) {
    add(
      'ERROR',
      file,
      lineOf(/CREATE\s+INDEX\s+CONCURRENTLY/i),
      'no-transaction',
      'CREATE INDEX CONCURRENTLY не выполняется внутри транзакции. Пометь миграцию ' +
        'строкой `-- migrate:no-transaction` — тогда раннер выполнит её отдельно.',
    );
  }
  if (noTransaction) {
    if (!/IF\s+NOT\s+EXISTS/i.test(sql)) {
      add(
        'ERROR',
        file,
        lineOf(/migrate:no-transaction/),
        'no-transaction',
        'Миграция вне транзакции обязана быть идемпотентной: откатить её нечем, ' +
          'а после падения она будет прогнана повторно. Используй IF NOT EXISTS.',
      );
    }
    const statements = sql.split(';').filter((s) => s.trim().length > 0);
    const nonIndex = statements.filter(
      (s) => !/^\s*(CREATE\s+INDEX|DROP\s+INDEX|COMMENT\s+ON\s+INDEX|ANALYZE)\b/i.test(s.trim()),
    );
    if (nonIndex.length > 0) {
      add(
        'ERROR',
        file,
        lineOf(/migrate:no-transaction/),
        'no-transaction',
        'Вне транзакции допустимы только операции с индексами: остальное обязано ' +
          'быть атомарным. Вынеси прочие изменения в обычную миграцию.',
      );
    }
  }

  // --- 2. Каждая созданная таблица получает RLS ----------------------------
  const created = [
    ...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]+)\.([a-z_]+)/gi),
  ]
    .map((m) => `${m[1]}.${m[2]}`)
    .filter((t) => !t.startsWith('public.'));

  for (const table of created) {
    const enable = new RegExp(
      `ALTER\\s+TABLE\\s+${table}\\s+ENABLE\\s+ROW\\s+LEVEL\\s+SECURITY`,
      'i',
    );
    const force = new RegExp(
      `ALTER\\s+TABLE\\s+${table}\\s+FORCE\\s+ROW\\s+LEVEL\\s+SECURITY`,
      'i',
    );
    if (!enable.test(fromHere)) {
      add(
        'ERROR',
        file,
        lineOf(new RegExp(`CREATE TABLE ${table}`, 'i')),
        'rls-enable',
        `${table}: нет ENABLE ROW LEVEL SECURITY.`,
      );
    }
    if (!force.test(fromHere)) {
      add(
        'ERROR',
        file,
        lineOf(new RegExp(`CREATE TABLE ${table}`, 'i')),
        'rls-force',
        `${table}: нет FORCE ROW LEVEL SECURITY — владелец обходил бы политики.`,
      );
    }
    if (!new RegExp(`CREATE\\s+POLICY\\s+[a-z_]+\\s+ON\\s+${table}\\b`, 'i').test(fromHere)) {
      add(
        'ERROR',
        file,
        lineOf(new RegExp(`CREATE TABLE ${table}`, 'i')),
        'rls-policy',
        `${table}: включён RLS, но не создано ни одной политики — таблица недоступна никому.`,
      );
    }
  }

  // --- 3. Опасные широкие политики для роли пользовательских запросов -------
  const blanket =
    /CREATE\s+POLICY\s+[a-z_]+\s+ON\s+[a-z_.]+\s+FOR\s+ALL\s+TO\s+app_backend\s+USING\s*\(\s*true\s*\)/i;
  if (blanket.test(sql)) {
    add(
      'ERROR',
      file,
      lineOf(blanket),
      'blanket-policy',
      'Политика FOR ALL TO app_backend USING (true) объединяется по ИЛИ с остальными ' +
        'и обнуляет построчную изоляцию для роли, обслуживающей запросы пользователей.',
    );
  }

  // --- 4. BYPASSRLS запрещён -----------------------------------------------
  if (/\bBYPASSRLS\b/i.test(sql) && !/NOBYPASSRLS/i.test(sql)) {
    add(
      'ERROR',
      file,
      lineOf(/BYPASSRLS/i),
      'bypassrls',
      'BYPASSRLS запрещён (docs/architecture/Database_Launch.md §1).',
    );
  }

  // --- 5. Функции с фиксированным search_path ------------------------------
  const funcs = [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([a-z_]+\.[a-z_]+)/gi)];
  for (const m of funcs) {
    const name = m[1]!;
    const tail = sql.slice(m.index ?? 0, (m.index ?? 0) + 1200);
    if (!/SET\s+search_path\s*=/i.test(tail)) {
      add(
        'ERROR',
        file,
        lineOf(new RegExp(name.replace('.', '\\.'), 'i')),
        'search-path',
        `${name}: нет SET search_path — функция уязвима к подмене объектов через search_path.`,
      );
    }
  }

  // --- 6. Секреты и пароли в SQL -------------------------------------------
  const secretRe = /(CREATE|ALTER)\s+ROLE\s+[a-z_]+[^;]*\bPASSWORD\s+'/i;
  if (secretRe.test(sql)) {
    add(
      'ERROR',
      file,
      lineOf(secretRe),
      'secret-in-sql',
      'Пароль роли в миграции. Логин-пользователи создаются bootstrap-скриптом из ' +
        'переменных окружения (src/bootstrap-roles.ts).',
    );
  }

  // --- 7. Деньги не должны быть FLOAT --------------------------------------
  const floatMoney = /\b(amount|price|fee|total|sum)[a-z_]*\s+(real|double\s+precision|float)/i;
  if (floatMoney.test(sql)) {
    add(
      'ERROR',
      file,
      lineOf(floatMoney),
      'money-float',
      'Денежное поле объявлено с плавающей точкой. Только NUMERIC(14,2).',
    );
  }

  // --- 8. Имя файла --------------------------------------------------------
  if (!/^M\d{3}_[a-z0-9_]+\.sql$/.test(file)) {
    add('WARN', file, 1, 'naming', 'Ожидается имя вида M0NN_snake_case.sql.');
  }
}

// --- Отчёт ----------------------------------------------------------------
const errors = findings.filter((f) => f.severity === 'ERROR');
const warns = findings.filter((f) => f.severity === 'WARN');

console.warn(`\n=== ЛИНТЕР МИГРАЦИЙ ===\nПроверено файлов: ${files.length}\n`);
for (const f of [...errors, ...warns]) {
  console.warn(`  ${f.severity.padEnd(5)} ${f.file}:${f.line} [${f.rule}] ${f.message}`);
}
console.warn(`\nОшибок: ${errors.length}, предупреждений: ${warns.length}.`);

if (errors.length > 0) {
  console.warn('Гейт не пройден.\n');
  process.exitCode = 1;
} else {
  console.warn('Гейт пройден.\n');
}

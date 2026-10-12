#!/usr/bin/env node
/**
 * Гейт «в репозиторий коммитит только владелец».
 *
 * Репозиторий — `rebel-diesel/fifth-element` (приватный, личный аккаунт
 * владельца; до 2026-10-12 разработка шла в репозитории прежнего исполнителя,
 * его история сохранена). В репозиторий может попасть чужой коммит: сторонний
 * доступ, автоматический агент, правка через сайт GitHub. Узнать о нём нужно
 * ДО того, как поверх ляжет своя работа: разбирать перемешанные изменения
 * дороже, чем заметить их вовремя.
 *
 * Что проверяется:
 *   1. origin/main не ушёл вперёд локального main незамеченным;
 *   2. авторы новых коммитов входят в список владельцев;
 *   3. последний коммит в origin/main — тоже от владельца.
 *
 * Гейт НЕ запрещает чужие коммиты — он делает их видимыми. Решение принимает
 * человек: чужой коммит может быть и законным (вернулся прежний исполнитель,
 * пришёл новый участник) — тогда достаточно добавить адрес в список ниже.
 *
 * Запуск:  node scripts/check-upstream-owner.mjs [--no-fetch]
 * Гейт:    npm run gate:upstream
 *
 * --no-fetch — не ходить в сеть, сверять по уже известному состоянию origin.
 * Полезно на машине без доступа к GitHub: тогда гейт проверяет то, что было
 * получено последним `git fetch`, и честно об этом говорит.
 *
 * --ref <ссылка> — проверить не origin/main, а указанную точку истории. Нужно
 * ровно для одного: показать, что гейт умеет краснеть. Проверка, которая
 * никогда не падала, ничего не доказывает — на коммите прежнего исполнителя
 * гейт обязан дать АЛАРМ.
 */
import { execSync } from 'node:child_process';

/**
 * Кому позволено коммитить. Адрес, а не имя: имя в git настраивается свободно
 * и ничего не подтверждает — адрес хотя бы совпадает с учётной записью.
 *
 * `panda4smoke@gmail.com` (прежний исполнитель, 181 коммит в истории)
 * намеренно НЕ внесён: проект передан, его новые коммиты в этом репозитории —
 * событие, а не норма. Старая история на гейт не влияет: он смотрит только
 * на то, что пришло в `origin/main` поверх локального `main`.
 *
 * Третий адрес — GitHub-адрес `noreply` аккаунта `rebel-diesel`: им
 * подписываются коммиты, сделанные через сайт GitHub и облачные сессии.
 */
const OWNERS = new Set([
  'i63@bk.ru',
  'godunov.tech@gmail.com',
  '91360636+rebel-diesel@users.noreply.github.com',
]);

const BRANCH = 'main';
const REMOTE = 'origin';

const refArg = process.argv.indexOf('--ref');
/** Что считаем «удалённой стороной»: обычно origin/main, для проверки на падение — любая ссылка. */
const UPSTREAM = refArg !== -1 ? process.argv[refArg + 1] : `${REMOTE}/${BRANCH}`;

const git = (cmd) =>
  execSync(`git ${cmd}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/**
 * Разделитель полей — служебный символ 0x1F, а не «|»: вертикальная черта в
 * строке формата достаётся оболочке как конвейер, и команда разваливается
 * (проверено: гейт сообщал «нет ветки origin/main», хотя она была).
 */
const SEP = '%x1f';
const FS = '\u001f';

const noFetch = process.argv.includes('--no-fetch') || refArg !== -1;

console.warn('\n=== ВЛАДЕЛЕЦ РЕПОЗИТОРИЯ: КТО КОММИТИЛ ПОСЛЕДНИМ ===\n');

let fetched = false;
if (noFetch) {
  console.warn('  прим.  --no-fetch: сверяю по состоянию последнего git fetch');
} else {
  try {
    execSync(`git fetch ${REMOTE} ${BRANCH} --quiet`, { stdio: ['ignore', 'pipe', 'pipe'] });
    fetched = true;
  } catch {
    // Нет сети или доступа — не повод падать: гейт скажет, что данные могли
    // устареть, и проверит то, что есть. Молча притворяться свежим нельзя.
    console.warn('  ВНИМАНИЕ  git fetch не прошёл — сверяю по устаревшему состоянию origin');
  }
}

const failures = [];
const ok = (text) => console.warn(`  ok      ${text}`);
const alarm = (text, why) => {
  failures.push(`${text}: ${why}`);
  console.error(`  АЛАРМ   ${text}: ${why}`);
};

let ahead = '';
try {
  ahead = git(
    `log --pretty=%H${SEP}%an${SEP}%ae${SEP}%ad${SEP}%s --date=short ${BRANCH}..${UPSTREAM}`,
  );
} catch {
  console.error(`  АЛАРМ   нет ссылки ${UPSTREAM} — репозиторий не связан с origin`);
  process.exit(1);
}

const incoming = ahead ? ahead.split('\n') : [];

if (incoming.length === 0) {
  ok(`${UPSTREAM} не ушёл вперёд — чужих коммитов нет`);
} else {
  alarm(
    `${UPSTREAM} впереди на ${incoming.length} коммит(ов)`,
    'кто-то коммитил помимо вас — разберите изменения ДО своей работы',
  );
  console.error('\n  Пришло:');
  for (const line of incoming) {
    const [hash, name, email, date, ...rest] = line.split(FS);
    const mark = OWNERS.has(email) ? ' ' : '!';
    console.error(`   ${mark} ${hash.slice(0, 7)}  ${date}  ${name} <${email}>`);
    console.error(`     ${rest.join(FS)}`);
  }
}

// Автор последнего коммита в origin: даже когда локальная ветка не отстала,
// origin мог быть переписан force-push'ем — тогда «впереди на 0», а автор чужой.
const [lastEmail, lastName, lastHash, lastSubject] = git(
  `log -1 --pretty=%ae${SEP}%an${SEP}%h${SEP}%s ${UPSTREAM}`,
).split(FS);

if (OWNERS.has(lastEmail)) {
  ok(`последний коммит ${UPSTREAM} — ваш (${lastName} <${lastEmail}>)`);
} else {
  alarm(
    `последний коммит ${UPSTREAM} не ваш`,
    `${lastHash} от ${lastName} <${lastEmail}> — «${lastSubject}»`,
  );
}

if (failures.length > 0) {
  console.error(
    `\nИтог: ${failures.length} — в репозиторий коммитил кто-то ещё.\n` +
      'Разберитесь, что это за изменения, прежде чем продолжать: свою работу\n' +
      'поверх чужой потом трудно отделить. Если участник законный — впишите\n' +
      `его адрес в OWNERS в ${'scripts/check-upstream-owner.mjs'}.\n`,
  );
  process.exit(1);
}

console.warn(
  `\nИтог: чужих коммитов нет.${fetched ? '' : ' Внимание: состояние origin могло устареть.'}\n`,
);

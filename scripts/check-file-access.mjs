#!/usr/bin/env node
/**
 * Граница доступа к ФАЙЛАМ, а не к строкам в базе (GAP-FILES-001).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ПРОГОН. RLS защищает строки, а документ проекта лежит в
 * объектном хранилище. Там нет ни политик, ни ролей приложения: единственное,
 * что стоит между чужим файлом и посторонним, — правило в коде ядра и
 * закрытый бакет. Это ровно то место, где правила обычно расходятся, потому
 * что записаны дважды.
 *
 * ЧТО УЖЕ ПРОВЕРЕНО БЕЗ ЭТОГО ПРОГОНА. `smoke-project-access` ходит за
 * байтами материала от лица инвестора, которому разрешение выдали, сузили и
 * отозвали. То есть путь «был доступ → доступа не стало» закрыт. Здесь
 * проверяется другое: тот, у кого отношений с проектом не было НИКОГДА, и
 * обход самого ядра.
 *
 * ЧТО ПРОВЕРЯЕТСЯ ЗДЕСЬ:
 *   1. хранилище не отдаёт объект напрямую, мимо ядра — ни по ключу, ни
 *      списком бакета;
 *   2. ядро не выдаёт наружу ссылок на хранилище для ЧТЕНИЯ;
 *   3. посторонние (другой основатель, инвестор без разрешения, гость)
 *      байтов не получают;
 *   4. перекрёстные идентификаторы не открывают дверь: свой проект + чужой
 *      материал и наоборот;
 *   5. несуществующий и закрытый неотличимы — ответ не подтверждает, что
 *      файл вообще есть;
 *   6. изображения проекта закрыты так же, как документы;
 *   7. билет на загрузку в чужой проект не выдаётся.
 *
 * КАК УСТРОЕН. На механизме тестовых сессий: свои учётные записи не
 * заводятся, пароли не нужны, всё созданное числится за сессией и убирается
 * ею же. Посторонний основатель — участник ВТОРОЙ сессии: добавить второго
 * основателя в одну сессию механизм не умеет, и выдумывать обход ради этого
 * не нужно.
 *
 * Запуск: node scripts/check-file-access.mjs (нужен поднятый core)
 */
import pg from 'pg';
import sharp from 'sharp';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startSession } from './lib/testing-session.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
loadDotEnv();

function loadDotEnv() {
  const envFile = join(ROOT, '.env');
  if (!existsSync(envFile)) return;
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq > 0) process.env[trimmed.slice(0, eq).trim()] ??= trimmed.slice(eq + 1).trim();
  }
}

const S3_ENDPOINT = (process.env.S3_ENDPOINT ?? 'http://localhost:9000').replace(/\/+$/, '');
const S3_BUCKET = process.env.S3_BUCKET ?? 'unicorn-launch';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL_OWNER ?? process.env.DATABASE_URL,
  application_name: 'fifth-check-file-access',
});

let passed = 0;
const defects = [];
function say(name, ok, note = '') {
  if (ok) {
    passed += 1;
    console.warn(`  OK    ${name}${note ? ` — ${note}` : ''}`);
  } else {
    defects.push(`${name}${note ? `: ${note}` : ''}`);
    console.error(`  ДЕФЕКТ ${name}${note ? ` — ${note}` : ''}`);
  }
}

/** Шаг прогона: и в журнал сессии, и в вывод. */
async function step(run, name, ok, detail = {}) {
  say(name, ok, detail.actual ?? '');
  await run.step(name, ok, detail);
  return ok;
}

console.warn('\n=== ГРАНИЦА ДОСТУПА К ФАЙЛАМ ===\n');

const owner = await startSession('Проверка доступа к файлам — владелец', {
  scenarioId: 'CHK-FILE-ACCESS',
});
const outsider = await startSession('Проверка доступа к файлам — посторонние', {
  scenarioId: 'CHK-FILE-ACCESS',
});
console.warn(`сессия владельца:     ${owner.id}`);
console.warn(`сессия посторонних:   ${outsider.id}\n`);

try {
  const founder = owner.as('founder');

  // ------------------------------------------------------------ подготовка
  console.warn('[1] Материал у основателя');
  // Направление берётся из справочника: без него заявка не создаётся, а
  // выдуманный идентификатор проверял бы валидацию, а не границу доступа.
  const taxonomy = await founder.call('/v1/taxonomy');
  const branch = (taxonomy.json?.items ?? [])[0];
  const project = await founder.call('/v1/projects', {
    method: 'POST',
    body: {
      title: `Проект проверки файлов ${Date.now() % 1e6}`,
      stage: 'mvp',
      taxonomyId: branch?.id,
      investmentAsk: '5000000',
      askCurrency: 'RUB',
    },
  });
  const projectId = project.json?.id;
  await step(owner, 'проект основателя заведён', Boolean(projectId), {
    actor: 'основатель',
    expected: 'HTTP 201 с идентификатором',
    actual: `HTTP ${project.status} ${project.text.slice(0, 120)}`,
  });
  if (!projectId) throw new Error('без проекта проверять нечего');

  const ticket = await founder.call(`/v1/projects/${projectId}/materials/upload`, {
    method: 'POST',
    body: {
      type: 'deck',
      fileName: 'deck.pdf',
      contentType: 'application/pdf',
      sizeBytes: 64,
    },
  });
  const materialId = ticket.json?.materialId;
  const form = new FormData();
  for (const [key, value] of Object.entries(ticket.json?.formFields ?? {})) {
    form.append(key, value);
  }
  form.append('file', new Blob([Buffer.from('%PDF-1.4 материал прогона границы')]), 'deck.pdf');
  const upload = await fetch(ticket.json?.uploadUrl, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(20_000),
  });
  await founder.call(`/v1/projects/${projectId}/materials/${materialId}/finalize`, {
    method: 'POST',
  });
  await step(
    owner,
    'материал загружен и подтверждён',
    (upload.status === 200 || upload.status === 204) && Boolean(materialId),
    {
      actor: 'основатель',
      expected: 'файл в хранилище, запись подтверждена',
      actual: `загрузка HTTP ${upload.status}`,
    },
  );

  const own = await founder.call(`/v1/projects/${projectId}/materials/${materialId}/content`);
  await step(owner, 'владелец свой материал получает', own.status === 200, {
    actor: 'основатель',
    expected: 'HTTP 200',
    actual: `HTTP ${own.status}`,
  });

  const { rows } = await pool.query('SELECT s3_key FROM lab.project_materials WHERE id = $1', [
    materialId,
  ]);
  const objectKey = rows[0]?.s3_key;

  // ----------------------------------------- 2. хранилище мимо ядра закрыто
  console.warn('\n[2] Хранилище напрямую');
  /*
   * Самая дешёвая дыра из возможных: бакет, открытый на чтение. Ни RLS, ни
   * правила ядра тогда не значат ничего — ключ объекта и есть доступ.
   */
  const direct = await fetch(`${S3_ENDPOINT}/${S3_BUCKET}/${objectKey}`, {
    signal: AbortSignal.timeout(15_000),
  }).catch((error) => ({ status: 0, error }));
  await step(owner, 'объект по прямому ключу анонимно не отдаётся', direct.status !== 200, {
    actor: 'посторонний',
    expected: 'отказ хранилища',
    actual: `HTTP ${direct.status}`,
  });

  const listing = await fetch(`${S3_ENDPOINT}/${S3_BUCKET}`, {
    signal: AbortSignal.timeout(15_000),
  }).catch((error) => ({ status: 0, error }));
  await step(owner, 'содержимое бакета анонимно не перечисляется', listing.status !== 200, {
    actor: 'посторонний',
    expected: 'отказ хранилища',
    actual: `HTTP ${listing.status}`,
  });

  // --------------------------------- 3. ядро не выдаёт ссылок на чтение
  console.warn('\n[3] Ссылки наружу');
  const listed = await founder.call(`/v1/projects/${projectId}/materials`);
  const listedText = JSON.stringify(listed.json ?? {});
  /*
   * Ссылка на хранилище в ответе — это выдача доступа в обход ядра: она
   * работает у любого, кому попадёт, и переживает отзыв прав. Проверяется
   * поведение, а не код: в ответе не должно быть ни адреса хранилища, ни
   * подписи запроса.
   */
  const leaks = ['X-Amz-Signature', 'X-Amz-Credential', S3_ENDPOINT, S3_BUCKET].filter((needle) =>
    listedText.includes(needle),
  );
  await step(owner, 'в списке материалов нет ссылок на хранилище', leaks.length === 0, {
    actor: 'основатель',
    expected: 'байты только через ядро',
    actual: leaks.length === 0 ? 'ссылок нет' : `найдено: ${leaks.join(', ')}`,
  });
  await step(
    owner,
    'ключ объекта наружу не отдаётся',
    Boolean(objectKey) && !listedText.includes(objectKey),
    {
      actor: 'основатель',
      expected: 'ключ хранилища — внутреннее знание',
      actual: objectKey ? 'ключа в ответе нет' : 'ключ не прочитан из базы',
    },
  );

  // ------------------------------------------------ 4. посторонние и гость
  console.warn('\n[4] Посторонние');
  const cases = [
    ['инвестор без разрешения', outsider.as('investor')],
    ['чужой основатель', outsider.as('founder')],
  ];
  for (const [who, client] of cases) {
    const attempt = await client.call(`/v1/projects/${projectId}/materials/${materialId}/content`);
    await step(
      owner,
      `${who} байтов не получает`,
      attempt.status === 404 || attempt.status === 403,
      {
        actor: who,
        expected: 'HTTP 404',
        actual: `HTTP ${attempt.status}`,
      },
    );
  }

  const guest = await outsider.asGuest();
  const anonymous = await guest.call(`/v1/projects/${projectId}/materials/${materialId}/content`);
  await step(owner, 'без учётной записи байты не отдаются', anonymous.status === 401, {
    actor: 'гость',
    expected: 'HTTP 401',
    actual: `HTTP ${anonymous.status}`,
  });

  // --------------------------------------- 5. перекрёстные идентификаторы
  console.warn('\n[5] Перекрёстные идентификаторы');
  const strangerFounder = outsider.as('founder');
  const strangerProject = await strangerFounder.call('/v1/projects', {
    method: 'POST',
    body: {
      title: `Чужой проект ${Date.now() % 1e6}`,
      stage: 'mvp',
      taxonomyId: branch?.id,
      investmentAsk: '5000000',
      askCurrency: 'RUB',
    },
  });
  const strangerProjectId = strangerProject.json?.id;

  /*
   * Классический IDOR: права проверяют по одному идентификатору из пути, а
   * файл берут по другому. Подставляется СВОЙ проект и ЧУЖОЙ материал —
   * проверка прав на свой проект пройдёт, и вопрос в том, что вернут.
   */
  const crossed = await strangerFounder.call(
    `/v1/projects/${strangerProjectId}/materials/${materialId}/content`,
  );
  await step(owner, 'свой проект с чужим материалом не открывает файл', crossed.status !== 200, {
    actor: 'основатель чужой заявки',
    expected: 'не 200',
    actual: `HTTP ${crossed.status}`,
  });

  const reversed = await strangerFounder.call(
    `/v1/projects/${projectId}/materials/${materialId}/content`,
  );
  const unknownMaterial = await strangerFounder.call(
    `/v1/projects/${projectId}/materials/01a00000-0000-7000-8000-000000000000/content`,
  );
  await step(
    owner,
    'закрытый и несуществующий материал отвечают одинаково',
    reversed.status === unknownMaterial.status,
    {
      actor: 'основатель чужой заявки',
      expected: 'один и тот же ответ',
      actual: `чужой ${reversed.status}, несуществующий ${unknownMaterial.status}`,
    },
  );

  // ----------------------------------------------------- 6. изображения
  console.warn('\n[6] Изображения проекта');
  /*
   * Сначала логотип ДОЛЖЕН появиться и открыться владельцу.
   *
   * Первая версия этой части спрашивала размер `small`, которого в контракте
   * нет, у проекта без логотипа — и радостно сравнивала две ошибки. Зелёная
   * проверка, не проверяющая ничего, хуже её отсутствия. Поэтому здесь
   * сначала доказывается, что файл есть и владельцу отдаётся, и только потом
   * проверяется, что постороннему — нет.
   */
  const logo = await sharp({
    create: { width: 512, height: 512, channels: 3, background: { r: 10, g: 90, b: 180 } },
  })
    .jpeg()
    .toBuffer();
  const logoTicket = await founder.call(`/v1/projects/${projectId}/media/upload`, {
    method: 'POST',
    body: { kind: 'logo', contentType: 'image/jpeg', sizeBytes: logo.byteLength },
  });
  const logoForm = new FormData();
  for (const [key, value] of Object.entries(logoTicket.json?.formFields ?? {})) {
    logoForm.append(key, value);
  }
  logoForm.append('file', new Blob([logo], { type: 'image/jpeg' }), 'logo.jpg');
  await fetch(logoTicket.json?.uploadUrl, {
    method: 'POST',
    body: logoForm,
    signal: AbortSignal.timeout(30_000),
  });
  await founder.call(`/v1/projects/${projectId}/media/logo/finalize`, {
    method: 'POST',
    body: { focusX: 0.5, focusY: 0.5 },
  });

  const ownLogo = await founder.call(`/v1/projects/${projectId}/media/logo/card`);
  await step(owner, 'логотип загружен и владельцу отдаётся', ownLogo.status === 200, {
    actor: 'основатель',
    expected: 'HTTP 200',
    actual: `HTTP ${ownLogo.status}`,
  });

  const media = await strangerFounder.call(`/v1/projects/${projectId}/media/logo/card`);
  const unknownProject = await strangerFounder.call(
    '/v1/projects/01a00000-0000-7000-8000-000000000001/media/logo/card',
  );
  await step(owner, 'изображение чужого закрытого проекта не отдаётся', media.status === 404, {
    actor: 'основатель чужой заявки',
    expected: 'HTTP 404',
    actual: `HTTP ${media.status}`,
  });
  await step(
    owner,
    'закрытый и несуществующий проект неотличимы по изображению',
    media.status === unknownProject.status,
    {
      actor: 'основатель чужой заявки',
      expected: 'один и тот же ответ',
      actual: `закрытый ${media.status}, несуществующий ${unknownProject.status}`,
    },
  );

  const guestLogo = await guest.call(`/v1/projects/${projectId}/media/logo/card`);
  await step(owner, 'гостю изображение закрытого проекта не отдаётся', guestLogo.status !== 200, {
    actor: 'гость',
    expected: 'не 200',
    actual: `HTTP ${guestLogo.status}`,
  });

  // -------------------------------------------- 7. билет на чужую загрузку
  console.warn('\n[7] Билет на загрузку');
  /*
   * Билет — это право ПОЛОЖИТЬ файл в чужой проект. Выдача его постороннему
   * открывает не чтение, а запись: подмену материалов заявки.
   */
  const strangerTicket = await strangerFounder.call(`/v1/projects/${projectId}/materials/upload`, {
    method: 'POST',
    body: { type: 'deck', fileName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 16 },
  });
  await step(owner, 'билет на загрузку в чужой проект не выдаётся', strangerTicket.status !== 201, {
    actor: 'основатель чужой заявки',
    expected: 'отказ',
    actual: `HTTP ${strangerTicket.status}`,
  });

  const investorTicket = await outsider
    .as('investor')
    .call(`/v1/projects/${projectId}/materials/upload`, {
      method: 'POST',
      body: { type: 'deck', fileName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 16 },
    });
  await step(owner, 'инвестору билет на загрузку не выдаётся', investorTicket.status !== 201, {
    actor: 'инвестор',
    expected: 'отказ',
    actual: `HTTP ${investorTicket.status}`,
  });
} finally {
  const ownerOutcome = await owner.finish();
  const outsiderOutcome = await outsider.finish();
  console.warn(`\nитог сессий: ${ownerOutcome.result} / ${outsiderOutcome.result}`);

  /*
   * Успешный прогон убирает за собой; упавший оставляет данные — они и есть
   * материал разбора. Файл в хранилище уходит вместе с материалом: уборка
   * сессии удаляет проект, а за объектами следит storage-janitor.
   */
  if (defects.length === 0) {
    const a = await owner.cleanup();
    const b = await outsider.cleanup();
    const ownerClean = Boolean(a);
    const outsiderClean = Boolean(b);
    console.warn(
      `убрано: владелец ${ownerClean ? 'да' : 'нет'}, посторонние ${outsiderClean ? 'да' : 'нет'}`,
    );
  } else {
    console.warn(`данные сессий оставлены для разбора: ${owner.id}, ${outsider.id}`);
  }
  await pool.end();
}

console.warn(`\nпройдено: ${passed}, дефектов: ${defects.length}\n`);
process.exit(defects.length === 0 ? 0 : 1);

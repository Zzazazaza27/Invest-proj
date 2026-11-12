#!/usr/bin/env node
/**
 * Отказы Garage в изолированной среде (работа № 4 раздела 01; 2.1.2, 2.1.6, 4.9).
 *
 * Своя среда `fifth-faults-*` (scripts/lib/faults-env.mjs): три узла Garage в рабочей
 * конфигурации (3 копии, consistent), своя база, ядро из текущего кода. Стенд и серверы не
 * затрагиваются. Сценарии:
 *
 *   1. один узел (не входной) остановлен — кворум 2 из 3: загрузка, готовность и чтение идут;
 *   2. два узла остановлены — нет кворума: передача отклонена, материал НЕ готов (в том числе
 *      когда объект успел записаться до отказа, а завершение пришлось на отказ), запись «Файлов»
 *      закрыта с причиной; узлы вернулись — запись открыта, отложенное завершение доходит;
 *   3. разделение связи — узел вне сети: пока Garage считает его живым, запись ждёт, «Файлы»
 *      закрываются, ложной готовности нет; после пометки узла отключённым запись идёт через
 *      большинство; после возврата и ремонта у узла столько же блоков, ошибок нет;
 *   4. данные узла стёрты — после ремонта копии восстановлены (счёт блоков и ошибки);
 *   5. входной узел (его адрес у ядра) остановлен — факт: «Файлы» отказывают, хотя кворум есть
 *      (одна точка входа ядра; записывается как свойство нынешней конфигурации);
 *   6. срок подписанной формы: форма 60 с, передача ~102 с — что делает Garage (форма ядра
 *      живёт ≥ 900 с, поэтому опыт — формой, подписанной тем же способом); начатая после срока
 *      передача — отказ, объекта нет;
 *   7. lifecycle: правило бакета «незавершённые multipart — удалять через 1 день» (garage-init)
 *      ставится и читается; незавершённая multipart видна до срока. Само удаление Garage
 *      выполняет раз в сутки — здесь не дождаться, это записывается.
 *
 *   node scripts/check-garage-faults.mjs [--keep]   (--keep — не убирать среду в конце)
 */
import { createHash, createHmac } from 'node:crypto';
import * as F from './lib/faults-env.mjs';
import { applyFilesLifecycle, FILES_LIFECYCLE_XML } from './lib/garage-admin.mjs';
import { s3Object } from './lib/s3.mjs';

const { check, note, state } = F.checker();
const [N1, N2, N3] = F.NODES;
const BLOCK = 256 * 1024; // больше порога встраивания Garage: объект — блоки на диске узлов

const storage = (key = F.secrets.ownerKey) => ({
  endpoint: `http://127.0.0.1:${F.S3_PORT}`,
  bucket: F.BUCKET,
  region: 'ru-central1',
  accessKey: key.id,
  secretKey: key.secret,
});

async function filesState(client) {
  return (await client.call('/v1/features')).json?.groups?.files;
}
async function waitFiles(client, predicate, seconds = 60) {
  let s;
  for (let i = 0; i < seconds; i++) {
    s = await filesState(client);
    if (s && predicate(s)) return s;
    await F.sleep(1000);
  }
  return s;
}
const materialState = async (id) =>
  (await F.sql('SELECT upload_state FROM lab.project_materials WHERE id = $1', [id]))[0]
    ?.upload_state;

/** Полная загрузка: билет → форма → завершение. */
async function upload(f, label, size = BLOCK) {
  const bytes = F.pdf(label, size);
  const t = await F.uploadTicket(f.client, f.projectId, bytes, label);
  if (t.status !== 201) return { ticket: t, bytes, post: null, fin: null };
  const post = await F.postForm(t.json, bytes);
  const fin = await F.finalize(f.client, f.projectId, t.json.materialId);
  return { ticket: t, bytes, post, fin, id: t.json.materialId };
}
const read = (f, id) => f.client.call(`/v1/projects/${f.projectId}/materials/${id}/content`);

/** Блоки на диске узла (файлы данных, кроме метки) — счёт по тому, без остановки узла. */
function blockFiles(node) {
  const r = F.docker(
    'run',
    '--rm',
    '-v',
    `${node}-data:/d:ro`,
    'fifth/postgres:16',
    'sh',
    '-c',
    'find /d -type f ! -name garage-marker | wc -l',
  );
  return Number(r.stdout.trim());
}
function nodeStats(node) {
  const r = F.garageCli(node, 'stats');
  const m = (re) => Number((r.stdout.match(re) ?? [])[1] ?? NaN);
  return {
    rc: m(/number of RC entries:\s+(\d+)/),
    queue: m(/resync queue length:\s+(\d+)/),
    errors: m(/blocks with resync errors:\s+(\d+)/),
  };
}
async function waitHealthy(seconds = 90) {
  for (let i = 0; i < seconds; i++) {
    const h = await F.garage('GetClusterHealth').catch(() => null);
    if (h?.status === 'healthy') return true;
    await F.sleep(1000);
  }
  return false;
}
/** Ремонт после возврата узла и ожидание, пока у всех узлов сравняется число блоков. */
async function repairAndConverge(seconds = 180) {
  F.garageCli(N1, 'repair', '-a', '--yes', 'tables');
  F.garageCli(N1, 'repair', '-a', '--yes', 'blocks');
  let counts;
  for (let i = 0; i < seconds; i += 3) {
    counts = F.NODES.map(blockFiles);
    const stats = F.NODES.map(nodeStats);
    // Очередь ресинхронизации пустой не бывает: Garage держит в ней блоки на плановую повторную
    // проверку (рабочие «Idle»). Признак сходимости — одинаковое число блоков и нет ошибок.
    if (
      counts.every((c) => c === counts[0]) &&
      counts[0] > 0 &&
      stats.every((s) => s.errors === 0)
    ) {
      return { counts, stats, converged: true };
    }
    // Ремонт — разовый проход: запущенный сразу после возврата узла может отработать впустую.
    // Повторяем его, пока узлы не сравняются (порядок инструкции docs/runbooks/garage.md).
    if (i > 0 && i % 30 === 0) {
      F.garageCli(N1, 'repair', '-a', '--yes', 'blocks');
      F.NODES.forEach((n) => F.garageCli(n, 'block', 'retry-now', '--all'));
    }
    await F.sleep(3000);
  }
  return { counts, stats: F.NODES.map(nodeStats), converged: false };
}

/** Форма POST (SigV4 policy) ключом ядра: срок, бакет, ключ — как у форм ядра. */
function signedForm(key, ttlSeconds) {
  const k = F.secrets.appKey;
  const now = new Date();
  const date = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const short = date.slice(0, 8);
  const credential = `${k.id}/${short}/ru-central1/s3/aws4_request`;
  const policy = Buffer.from(
    JSON.stringify({
      expiration: new Date(now.getTime() + ttlSeconds * 1000).toISOString(),
      conditions: [
        { bucket: F.BUCKET },
        { key },
        { 'x-amz-algorithm': 'AWS4-HMAC-SHA256' },
        { 'x-amz-credential': credential },
        { 'x-amz-date': date },
        ['content-length-range', 0, 10 * 1024 * 1024],
      ],
    }),
  ).toString('base64');
  let sig = createHmac('sha256', `AWS4${k.secret}`).update(short).digest();
  for (const part of ['ru-central1', 's3', 'aws4_request'])
    sig = createHmac('sha256', sig).update(part).digest();
  return {
    uploadUrl: `http://127.0.0.1:${F.S3_PORT}/${F.BUCKET}`,
    formFields: {
      key,
      policy,
      'x-amz-algorithm': 'AWS4-HMAC-SHA256',
      'x-amz-credential': credential,
      'x-amz-date': date,
      'x-amz-signature': createHmac('sha256', sig).update(policy).digest('hex'),
    },
  };
}
const keep = process.argv.includes('--keep');
console.log('\n=== ОТКАЗЫ GARAGE (работа № 4) — изолированная среда ===\n');
try {
  await F.up();
  check('среда поднята: три узла в строю', (await F.clusterNodesUp()) === 3);
  const f = await F.founderWithProject('garage');
  const base = await upload(f, 'base');
  check(
    'исходная загрузка готова',
    base.fin?.json?.uploadState === 'ready',
    `форма ${base.post?.status}, завершение ${base.fin?.status}`,
  );
  check('файл читается', (await read(f, base.id)).raw.equals(base.bytes));

  // ---- 1. один узел
  console.log('\n— 1. один узел остановлен (кворум 2 из 3)');
  F.stopNode(N3);
  const one = await upload(f, 'one');
  check(
    'загрузка при одном узле вне строя готова',
    one.fin?.json?.uploadState === 'ready',
    `форма ${one.post?.status}, завершение ${one.fin?.status}`,
  );
  check(
    'новый и прежний файлы читаются',
    (await read(f, one.id)).raw.equals(one.bytes) &&
      (await read(f, base.id)).raw.equals(base.bytes),
  );
  check(
    '«Файлы» доступны',
    (await waitFiles(f.client, (s) => s.state === 'available', 15))?.state === 'available',
  );
  F.startNode(N3);
  check('узел вернулся, кластер исправен', await waitHealthy());

  // ---- 2. нет кворума
  console.log('\n— 2. два узла остановлены (нет кворума)');
  const early = await (async () => {
    const bytes = F.pdf('early', BLOCK);
    const t = await F.uploadTicket(f.client, f.projectId, bytes, 'early');
    const post = await F.postForm(t.json, bytes);
    return { t, bytes, post };
  })();
  check('объект «до отказа» передан, завершения ещё не было', early.post.status === 204);
  F.stopNode(N2);
  F.stopNode(N3);
  const lost = await upload(f, 'noquorum');
  const t0 = Date.now();
  check(
    'передача без кворума отклонена хранилищем',
    lost.post === null || lost.post.status >= 500 || lost.post.status === 0,
    `билет ${lost.ticket.status}, форма ${lost.post?.status} ${lost.post?.text?.slice(0, 80) ?? ''}`,
  );
  if (lost.id) {
    check(
      'материал без кворума НЕ готов',
      (await materialState(lost.id)) !== 'ready',
      `завершение ${lost.fin?.status}, состояние ${await materialState(lost.id)}`,
    );
  }
  const earlyFin = await F.finalize(f.client, f.projectId, early.t.json.materialId);
  check(
    'завершение на отказе: объект был, но готовность НЕ объявлена',
    (await materialState(early.t.json.materialId)) !== 'ready',
    `HTTP ${earlyFin.status} ${earlyFin.json?.code ?? earlyFin.json?.uploadState ?? ''}`,
  );
  const closed = await waitFiles(f.client, (s) => !s.write.allowed, 60);
  check(
    'запись «Файлов» закрыта с причиной',
    closed && !closed.write.allowed && closed.write.reason !== 'ok',
    `${closed?.state} / ${closed?.write?.reason}, ещё через ${Math.round((Date.now() - t0) / 1000)} с после отказа формы`,
  );
  const ticket = await F.uploadTicket(f.client, f.projectId, F.pdf('denied'), 'denied');
  check(
    'новая загрузка отклоняется group_unavailable',
    ticket.status === 503 && JSON.stringify(ticket.json).includes('group_unavailable'),
    `HTTP ${ticket.status}`,
  );
  const readNoQuorum = await read(f, base.id);
  note(
    `чтение готового файла без кворума: HTTP ${readNoQuorum.status} (consistent: чтению нужен кворум)`,
  );
  F.startNode(N2);
  F.startNode(N3);
  check('узлы вернулись, кластер исправен', await waitHealthy());
  const opened = await waitFiles(f.client, (s) => s.write.allowed, 60);
  check('запись «Файлов» снова открыта', opened?.write?.allowed === true, opened?.state);
  const retry = await F.finalize(f.client, f.projectId, early.t.json.materialId);
  check(
    'отложенное завершение дошло после возврата',
    (await materialState(early.t.json.materialId)) === 'ready',
    `HTTP ${retry.status} ${retry.json?.uploadState ?? retry.json?.code ?? ''}`,
  );
  check(
    'файл «до отказа» читается целым',
    (await read(f, early.t.json.materialId)).raw.equals(early.bytes),
  );

  // ---- 3. разделение связи
  console.log('\n— 3. разделение связи: узел вне сети');
  // Отрезанный «молча» узел (пакеты пропадают, соединения не рвутся) Garage какое-то время
  // считает живым: запись ждёт его. Проверяется, что в это окно нет ложной готовности, а после
  // того как узел помечен отключённым, запись идёт через большинство (замер 12.11: ~75 с).
  F.isolate(N3);
  const cut = Date.now();
  const hung = await upload(f, 'part-window');
  if (hung.id && hung.fin?.json?.uploadState !== 'ready') {
    check(
      'в окне до обнаружения — без ложной готовности',
      (await materialState(hung.id)) !== 'ready',
      `форма ${hung.post?.status || hung.post?.text}, завершение ${hung.fin?.status}`,
    );
  } else {
    note(
      `первая загрузка после отключения прошла сразу (форма ${hung.post?.status}) — окно не поймано`,
    );
  }
  let seenDown = null;
  for (let i = 0; i < 180; i++) {
    const st = await F.garage('GetClusterStatus').catch(() => null);
    if (st?.nodes?.some((n) => n.role && !n.isUp)) {
      seenDown = Math.round((Date.now() - cut) / 1000);
      break;
    }
    await F.sleep(1000);
  }
  check(
    'Garage пометил отрезанный узел отключённым',
    seenDown !== null,
    `через ${seenDown} с после отключения`,
  );
  const reopenedPart = await waitFiles(f.client, (x) => x.write.allowed, 60);
  check(
    'запись «Файлов» открыта при отрезанном узле',
    reopenedPart?.write?.allowed === true,
    `${reopenedPart?.state}, через ${Math.round((Date.now() - cut) / 1000)} с после отключения`,
  );
  const during = [];
  for (let i = 0; i < 3; i++) during.push(await upload(f, `part${i}`));
  check(
    'запись через большинство идёт: три загрузки готовы',
    during.every((u) => u.fin?.json?.uploadState === 'ready'),
    during.map((u) => `форма ${u.post?.status}, завершение ${u.fin?.status}`).join('; '),
  );
  const beforeHeal = F.NODES.map(blockFiles);
  check('у отрезанного узла блоков меньше', beforeHeal[2] < beforeHeal[0], beforeHeal.join('/'));
  F.heal(N3);
  check('связь вернулась, кластер исправен', await waitHealthy());
  const conv = await repairAndConverge();
  check(
    'после ремонта блоков у всех поровну',
    conv.converged,
    `блоки ${conv.counts.join('/')}, очередь ${conv.stats.map((s) => s.queue).join('/')}`,
  );
  check(
    'ошибок ресинхронизации нет',
    conv.stats.every((s) => s.errors === 0),
    conv.stats.map((s) => s.errors).join('/'),
  );
  check(
    'файлы, записанные при разделении, читаются целыми',
    (await Promise.all(during.map(async (u) => (await read(f, u.id)).raw.equals(u.bytes)))).every(
      Boolean,
    ),
  );

  // ---- 4. стёртые данные узла
  console.log('\n— 4. данные узла стёрты');
  F.wipeNodeData(N3);
  await F.sleep(8000);
  check(
    'на пустом диске без метки узел НЕ запускается (защита Garage)',
    !F.running(N3),
    'нужен шаг оператора: убрать data_layout в метаданных',
  );
  F.acceptNewDisk(N3);
  check('после шага оператора узел с новым диском вернулся', await waitHealthy());
  check('у узла с чистого листа блоков нет', blockFiles(N3) === 0, String(blockFiles(N3)));
  const rebuilt = await repairAndConverge();
  check(
    'копии восстановлены ремонтом: блоков у всех поровну',
    rebuilt.converged,
    `блоки ${rebuilt.counts.join('/')}`,
  );
  check(
    'ошибок ресинхронизации нет',
    rebuilt.stats.every((s) => s.errors === 0),
  );

  // ---- 5. входной узел
  console.log('\n— 5. входной узел ядра остановлен');
  F.stopNode(N1);
  const entry = await waitFiles(f.client, (s) => !s.write.allowed, 60);
  check(
    'без входного узла «Файлы» честно отказывают (не «доступны»)',
    entry && !entry.write.allowed,
    `${entry?.state} / ${entry?.write?.reason}`,
  );
  note(
    'ядро ходит в Garage через один узел (S3_ENDPOINT = garage-1): его остановка — отказ «Файлов» при живом кворуме',
  );
  F.startNode(N1);
  check('входной узел вернулся', await waitHealthy());
  await waitFiles(f.client, (s) => s.write.allowed, 60);

  // ---- 6. срок формы
  console.log('\n— 6. срок подписанной формы: 60 с, передача ~102 с');
  // Форма ядра для материалов живёт ≥ 900 с (MATERIAL_UPLOAD_FORM_TTL_SECONDS, по умолчанию
  // 5700), поэтому опыт — формой, подписанной здесь тем же способом (POST policy, SigV4).
  const slowKey = `form-ttl/slow-${Date.now()}`;
  const slowBytes = F.pdf('slow', 600 * 1024);
  const slowForm = signedForm(slowKey, 60);
  const startedAt = Date.now();
  const slow = await F.postForm(slowForm, slowBytes, {
    chunks: 52,
    chunkDelayMs: 2000,
    timeout: 180_000,
  });
  const took = Math.round((Date.now() - startedAt) / 1000);
  const code = slow.text.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? '';
  note(`Garage: форма 60 с, передача ${took} с — HTTP ${slow.status} ${code}`);
  const stored = await s3Object(storage(F.secrets.appKey), 'GET', slowKey);
  const storedBody = stored.ok ? Buffer.from(await stored.arrayBuffer()) : null;
  check('опыт записан: передача длиннее срока формы', took >= 95, `${took} с`);
  if (slow.status === 204) {
    check(
      'Garage принял начатую до срока — объект целый (не обрезан)',
      storedBody?.length > 0 &&
        createHash('sha256').update(storedBody).digest('hex') ===
          createHash('sha256').update(slowBytes).digest('hex'),
      `${storedBody?.length ?? 0} байт`,
    );
  } else {
    check('Garage отказал — объекта нет', !stored.ok, `HTTP ${stored.status}`);
  }
  const lateKey = `form-ttl/late-${Date.now()}`;
  const lateForm = signedForm(lateKey, 60);
  await F.sleep(62_000);
  const late = await F.postForm(lateForm, F.pdf('late'));
  check(
    'передача, начатая после срока формы, отклонена',
    late.status >= 400 && late.status < 500,
    `HTTP ${late.status} ${late.text.match(/<Code>([^<]+)<\/Code>/)?.[1] ?? ''}`,
  );
  check(
    'после отказа объекта нет',
    !(await s3Object(storage(F.secrets.appKey), 'HEAD', lateKey)).ok,
  );

  // ---- 7. lifecycle
  console.log('\n— 7. lifecycle бакета');
  await applyFilesLifecycle(storage(), F.BUCKET);
  const got = await s3Object(storage(), 'GET', '', null, {}, { lifecycle: '' });
  const xml = await got.text();
  check(
    'правило lifecycle поставлено и читается',
    got.ok &&
      xml.includes('AbortIncompleteMultipartUpload') &&
      xml.includes('<DaysAfterInitiation>1</DaysAfterInitiation>'),
    `HTTP ${got.status}`,
  );
  check('правило НЕ удаляет объекты (нет Expiration)', !/<Expiration>/.test(xml));
  const mpu = await s3Object(storage(), 'POST', 'lifecycle-probe/mpu', null, {}, { uploads: '' });
  const uploadId = (await mpu.text()).match(/<UploadId>([^<]+)<\/UploadId>/)?.[1];
  const list = await s3Object(storage(), 'GET', '', null, {}, { uploads: '' });
  check(
    'незавершённая multipart видна до срока',
    uploadId && (await list.text()).includes(uploadId),
  );
  note(`правило: ${FILES_LIFECYCLE_XML.replace(/\s+/g, ' ').slice(0, 160)}…`);
  note(
    'удаление по правилу Garage выполняет раз в сутки (worker lifecycle) — в прогоне не дождаться; ручной вариант: garage bucket cleanup-incomplete-uploads',
  );
  const hash = createHash('sha256').update(xml).digest('hex').slice(0, 12);
  note(`ответ lifecycle sha256:${hash}`);
} catch (e) {
  check('прогон без исключения', false, String(e?.stack ?? e).slice(0, 600));
} finally {
  await F.closeSql();
  if (!keep) F.down();
}
const file = F.writeReport('garage', state);
console.log(`\nИтог: ${state.passed} OK, ${state.failed} FAIL. Протокол: ${file}`);
process.exitCode = state.failed ? 1 : 0;

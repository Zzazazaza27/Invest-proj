#!/usr/bin/env node
/**
 * Восстановление одного файла готового материала (работа № 6 раздела 01, 2.1.3; M177).
 *
 *   node scripts/file-restore.mjs targets   --env test-1
 *   node scripts/file-restore.mjs files-set --env test-1 --materials <id,id…>
 *   node scripts/file-restore.mjs restore   --env test-1 --material <id> --operator <id учётной
 *        записи администратора> --reason <текст> --incident <ссылка> [--set <метка>]
 *   испытание (только test-1 и local, с --trial):
 *   node scripts/file-restore.mjs drop-object | corrupt-set | guards …
 *
 * Конфигурация — ЯВНАЯ, по имени среды (`targets` печатает её без секретов): общий `.env`
 * репозитория не читается. Разрешены только `test-1` и `local` (стенд разработчика);
 * prod и test-2 команда не принимает.
 *
 * Файловая копия (`files-set`) — НЕ комплект восстановления: свой каталог, тип `files-only`,
 * отметка READY-FILES вместо READY; `readySets()` комплектов копий её не выбирает. Для test-1
 * это испытательная копия, не настроенное регулярное резервирование.
 *
 * Восстановление: запись есть, проект есть, материал готов, файл утрачен или повреждён →
 * копия из проверенной файловой копии (опись, сумма зашифрованного файла, подлинность
 * шифра, размер и SHA-256 содержимого = записи) → объект под НОВЫМ ключом → перечитан и
 * сверен → `lab.restore_material_file` переключает ключ одной транзакцией с событием журнала.
 * Любой отказ — без изменения материала; новый объект при отказе убирается; временный
 * расшифрованный файл убирается всегда. Права, видимость, состояние не меняются.
 */
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL_IMAGE = 'fifth/postgres:16';
const MAGIC = Buffer.from('FRS1');
export const FILES_ONLY = 'files-only';

const [command, ...rest] = process.argv.slice(2);
const opt = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};
const flag = (name) => rest.includes(`--${name}`);

class Refused extends Error {}
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function sh(cmd, args, { input, env, allowFail = false } = {}) {
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    input,
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 600_000,
  });
  if (r.status !== 0 && !allowFail) {
    const tail = `${r.stderr || ''}${r.error ?? ''}`.trim().split('\n').slice(-4).join('\n');
    throw new Error(`${cmd} ${args.slice(0, 2).join(' ')}… → ${r.status}: ${tail}`);
  }
  return r;
}

// ------------------------------------------------------------ конфигурация

/** Явная конфигурация среды. Секреты — только в `secret`, наружу не печатаются. */
function target(env) {
  if (env === 'test-1') {
    const dir = join(ROOT, '.local', 'envs', 'test-1');
    if (!existsSync(join(dir, 'install.json'))) throw new Refused('среда test-1 не установлена');
    const install = JSON.parse(readFileSync(join(dir, 'install.json'), 'utf8'));
    if (install.env !== 'test-1') throw new Refused('запись установки не от test-1');
    const compose = readEnvFile(join(dir, 'compose.env'));
    const settings = readEnvFile(join(dir, 'settings.env'));
    const keys = JSON.parse(readFileSync(join(dir, 'storage.json'), 'utf8')).app;
    return {
      env,
      configDir: dir,
      pg: {
        container: `${compose.FIFTH_PROJECT}-postgres`,
        project: compose.FIFTH_PROJECT,
        db: 'fifth_element',
        user: 'fifth_owner',
        tcp: true,
      },
      s3: {
        endpoint: settings.S3_ENDPOINT,
        region: settings.S3_REGION || 'ru-central1',
        bucket: settings.S3_BUCKET,
        network: compose.FIFTH_STORAGE_NETWORK,
        accessKeyId: keys.accessKeyId,
      },
      backups: '/var/backups/fifth-element/test-1-files',
      secret: {
        pgPassword: () => readFileSync(join(dir, 'secrets', 'POSTGRES_PASSWORD'), 'utf8').trim(),
        s3Secret: () => keys.secretAccessKey,
      },
      expect: { project: 'fifth-test-1', bucket: 'fifth-test-1' },
    };
  }
  if (env === 'local') {
    // Стенд разработчика: на сервере `.env` в корне — конфигурация prod, поэтому `local`
    // только с явной отметкой окружения, которую обёртка узла никогда не ставит.
    if (process.env.FIFTH_FILE_RESTORE_LOCAL !== '1') {
      throw new Refused('local — только на стенде разработчика (FIFTH_FILE_RESTORE_LOCAL=1)');
    }
    const e = readEnvFile(join(ROOT, '.env'));
    return {
      env,
      configDir: join(ROOT, '.env'),
      pg: {
        container: 'fifth-postgres',
        project: null,
        db: 'fifth_element',
        user: 'unicorn_owner',
      },
      s3: {
        endpoint: e.BACKUP_S3_SOURCE_ENDPOINT || 'http://garage-1:3900',
        region: e.S3_REGION || 'ru-central1',
        bucket: e.S3_BUCKET,
        network: null,
        accessKeyId: e.S3_ACCESS_KEY_ID,
      },
      backups: join(ROOT, '.local', 'file-restore-local'),
      secret: { pgPassword: () => '', s3Secret: () => e.S3_SECRET_ACCESS_KEY },
      expect: { project: null, bucket: e.S3_BUCKET },
    };
  }
  throw new Refused(`среда ${env ?? '(нет)'} не разрешена: только test-1 и local`);
}

/** Сверка назначений с фактом до любой работы. Возвращает список проверок. */
function verifyTarget(t) {
  const facts = [];
  const insp = sh(
    'docker',
    [
      'inspect',
      t.pg.container,
      '-f',
      '{{index .Config.Labels "com.docker.compose.project"}}|{{.State.Running}}|{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}',
    ],
    { allowFail: true },
  );
  if (insp.status !== 0) throw new Refused(`контейнер базы ${t.pg.container} не найден`);
  const [project, running, nets] = insp.stdout.trim().split('|');
  if (running !== 'true') throw new Refused(`контейнер базы ${t.pg.container} не запущен`);
  if (t.expect.project && project !== t.expect.project) {
    throw new Refused(
      `контейнер ${t.pg.container} из проекта ${project}, ожидался ${t.expect.project}`,
    );
  }
  facts.push(`база: контейнер ${t.pg.container} (проект ${project || '—'}), запущен`);
  if (!t.s3.network) t.s3.network = nets.trim().split(/\s+/)[0];
  if (t.s3.bucket !== t.expect.bucket) {
    throw new Refused(`бакет ${t.s3.bucket} не совпадает с ожидаемым ${t.expect.bucket}`);
  }
  const db = psql(t, "SELECT current_database() || '|' || current_user");
  if (db !== `${t.pg.db}|${t.pg.user}`) throw new Refused(`база ответила как ${db}`);
  facts.push(`база: ${t.pg.db}, роль ${t.pg.user}`);
  const fn = psql(t, "SELECT count(*) FROM pg_proc WHERE proname = 'restore_material_file'");
  if (fn !== '1') throw new Refused('в базе нет lab.restore_material_file (M177 не применена)');
  facts.push('M177: функция восстановления есть');
  const ls = rclone(t, ['lsjson', '--max-depth', '1', '--dirs-only', `SRC:${t.s3.bucket}`], {
    allowFail: true,
  });
  if (ls.status !== 0) throw new Refused(`бакет ${t.s3.bucket} недоступен ключом среды`);
  facts.push(`хранилище: ${t.s3.endpoint}, сеть ${t.s3.network}, бакет ${t.s3.bucket}`);
  facts.push(`файловые копии: ${t.backups}`);
  return facts;
}

// ------------------------------------------------------------ база и хранилище

function psql(t, sql, vars = {}) {
  const args = ['exec', '-i'];
  if (t.pg.tcp) args.push('-e', 'PGPASSWORD');
  args.push(t.pg.container, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1');
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  if (t.pg.tcp) args.push('-h', '127.0.0.1');
  args.push('-U', t.pg.user, '-d', t.pg.db);
  const env = t.pg.tcp ? { PGPASSWORD: t.secret.pgPassword() } : {};
  return sh('docker', args, { input: sql, env }).stdout.trim();
}

/** Транзакция с откатом под ролью приложения: результат или текст ошибки. */
function psqlTry(t, sql) {
  const args = ['exec', '-i'];
  if (t.pg.tcp) args.push('-e', 'PGPASSWORD');
  args.push(t.pg.container, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1');
  if (t.pg.tcp) args.push('-h', '127.0.0.1');
  args.push('-U', t.pg.user, '-d', t.pg.db);
  const env = t.pg.tcp ? { PGPASSWORD: t.secret.pgPassword() } : {};
  const r = sh('docker', args, { input: sql, env, allowFail: true });
  return { ok: r.status === 0, out: r.stdout.trim(), err: (r.stderr || '').trim() };
}

function rclone(t, args, { mount, allowFail = false } = {}) {
  const env = {
    RCLONE_CONFIG_SRC_TYPE: 's3',
    RCLONE_CONFIG_SRC_PROVIDER: 'Other',
    RCLONE_CONFIG_SRC_ENDPOINT: t.s3.endpoint,
    RCLONE_CONFIG_SRC_REGION: t.s3.region,
    RCLONE_CONFIG_SRC_ACCESS_KEY_ID: t.s3.accessKeyId,
    RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY: t.secret.s3Secret(),
  };
  const a = ['run', '--rm', '--network', t.s3.network, '-u', '0:0', '--entrypoint', 'rclone'];
  for (const k of Object.keys(env)) a.push('-e', k);
  if (mount) a.push('-v', `${mount}:/work`);
  a.push(TOOL_IMAGE, ...args, '--s3-no-check-bucket');
  return sh('docker', a, { env, allowFail });
}

/** Объект в бакете: null — нет; иначе размер и SHA-256 по скачанному содержимому. */
function readObject(t, key, work) {
  const stat = rclone(t, ['lsjson', '--stat', `SRC:${t.s3.bucket}/${key}`], { allowFail: true });
  if (stat.status !== 0) {
    if (/not found|doesn't exist|directory not found/i.test(stat.stderr)) return null;
    throw new Error(`хранилище не ответило о ${key}: ${stat.stderr.trim().split('\n').at(-1)}`);
  }
  // Отсутствующий ключ rclone показывает «каталогом» без размера.
  let info;
  try {
    info = JSON.parse(stat.stdout);
  } catch {
    throw new Error(`хранилище: непонятный ответ о ${key}`);
  }
  if (!info || info.IsDir || !(info.Size >= 0)) return null;
  const name = `get-${randomUUID()}`;
  rclone(t, ['copyto', `SRC:${t.s3.bucket}/${key}`, `/work/${name}`], { mount: work });
  const body = readFileSync(join(work, name));
  rmSync(join(work, name), { force: true });
  return { size: body.length, sha256: sha256(body), body };
}

function workDir(t) {
  mkdirSync(join(t.backups, 'tmp'), { recursive: true, mode: 0o700 });
  return mkdtempSync(join(t.backups, 'tmp', 'w-'));
}

// ------------------------------------------------------------ шифр копии

function setKey(t) {
  const file = join(t.backups, 'key');
  if (!existsSync(file)) {
    mkdirSync(t.backups, { recursive: true, mode: 0o700 });
    writeFileSync(file, randomBytes(32), { mode: 0o600 });
    chmodSync(file, 0o600);
  }
  const key = readFileSync(file);
  if (key.length !== 32) throw new Refused('ключ файловых копий повреждён');
  return key;
}
function seal(key, plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, iv, body, c.getAuthTag()]);
}
function open(key, sealed) {
  if (sealed.length < 32 || !sealed.subarray(0, 4).equals(MAGIC)) {
    throw new Refused('копия повреждена: неизвестный формат');
  }
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(4, 16));
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  try {
    return Buffer.concat([d.update(sealed.subarray(16, sealed.length - 16)), d.final()]);
  } catch {
    throw new Refused('копия повреждена: шифр не подтвердил подлинность');
  }
}

// ------------------------------------------------------------ файловая копия

const setsDir = (t) => join(t.backups, 'sets');

/** Пригодные файловые копии, новые первыми: тип, отметка, сумма описи. */
function filesSets(t) {
  if (!existsSync(setsDir(t))) return [];
  return readdirSync(setsDir(t)).sort().reverse();
}
function loadSet(t, id) {
  const d = join(setsDir(t), id);
  const problems = [];
  if (readText(join(d, 'TYPE')) !== FILES_ONLY) problems.push('тип не files-only');
  if (!existsSync(join(d, 'READY-FILES'))) problems.push('нет отметки READY-FILES');
  const raw = existsSync(join(d, 'catalog.json')) ? readFileSync(join(d, 'catalog.json')) : null;
  if (!raw) problems.push('нет описи');
  else if (sha256(raw) !== readText(join(d, 'CATALOG.sha256'))) problems.push('опись изменена');
  const catalog = raw && problems.length === 0 ? JSON.parse(raw.toString('utf8')) : null;
  if (
    catalog &&
    (catalog.type !== FILES_ONLY || catalog.env !== t.env || catalog.bucket !== t.s3.bucket)
  ) {
    problems.push('опись от другой среды или бакета');
  }
  return { id, dir: d, catalog: problems.length ? null : catalog, problems };
}
function readText(f) {
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : null;
}

async function filesSet(t) {
  const ids = String(opt('materials') ?? '')
    .split(',')
    .filter(Boolean);
  if (!ids.length || !ids.every((x) => UUID_RE.test(x))) {
    throw new Refused('нужен --materials <id,id…> (копия только названных материалов)');
  }
  const rows = psql(
    t,
    `SELECT id || '|' || s3_key || '|' || size_bytes || '|' || content_hash
       FROM lab.project_materials
      WHERE upload_state = 'ready' AND type <> 'product_link' AND s3_key IS NOT NULL
        AND id = ANY (string_to_array(:'ids', ',')::uuid[])`,
    { ids: ids.join(',') },
  )
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [materialId, key, size, hash] = l.split('|');
      return { materialId, key, size: Number(size), sha256: hash.replace(/^sha256:/, '') };
    });
  if (rows.length !== ids.length) throw new Refused('не все материалы готовы или существуют');
  const key = setKey(t);
  const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, 'Z');
  const d = join(setsDir(t), id);
  mkdirSync(join(d, 'objects'), { recursive: true, mode: 0o700 });
  const work = workDir(t);
  try {
    const objects = [];
    for (const r of rows) {
      const o = readObject(t, r.key, work);
      if (!o) throw new Refused(`объект материала ${r.materialId} отсутствует — копировать нечего`);
      if (o.size !== r.size || o.sha256 !== r.sha256) {
        throw new Refused(`объект материала ${r.materialId} не совпадает с записью`);
      }
      const sealed = seal(key, o.body);
      const file = `objects/${r.sha256}.frs`;
      writeFileSync(join(d, file), sealed, { mode: 0o600 });
      objects.push({ ...r, file, fileSha256: sha256(sealed) });
    }
    const catalog = Buffer.from(
      JSON.stringify(
        {
          type: FILES_ONLY,
          version: 1,
          env: t.env,
          bucket: t.s3.bucket,
          at: new Date().toISOString(),
          objects,
        },
        null,
        2,
      ),
    );
    writeFileSync(join(d, 'TYPE'), `${FILES_ONLY}\n`);
    writeFileSync(join(d, 'catalog.json'), catalog);
    writeFileSync(join(d, 'CATALOG.sha256'), `${sha256(catalog)}\n`);
    writeFileSync(join(d, 'READY-FILES'), `${new Date().toISOString()}\n`);
    console.log(`файловая копия ${id}: объектов ${objects.length}, опись ${sha256(catalog)}`);
    return { id, objects: objects.length };
  } catch (error) {
    rmSync(d, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ восстановление

function readMaterial(t, id) {
  const line = psql(
    t,
    `SELECT pm.type || '|' || pm.upload_state || '|' || coalesce(pm.s3_key, '') || '|' ||
            coalesce(pm.size_bytes::text, '') || '|' || coalesce(pm.content_hash, '') || '|' ||
            CASE WHEN p.id IS NULL OR p.deleted_at IS NOT NULL THEN 'no' ELSE 'yes' END
       FROM lab.project_materials pm LEFT JOIN lab.projects p ON p.id = pm.project_id
      WHERE pm.id = :'id'`,
    { id },
  );
  if (!line) return null;
  const [type, state, key, size, hash, project] = line.split('|');
  return {
    type,
    state,
    key,
    size: Number(size),
    sha256: hash.replace(/^sha256:/, ''),
    project: project === 'yes',
  };
}

async function restore(t) {
  const id = opt('material');
  const operator = opt('operator');
  const reason = opt('reason');
  const incident = opt('incident');
  if (!UUID_RE.test(id ?? '')) throw new Refused('нужен --material <id>');
  if (!UUID_RE.test(operator ?? '')) throw new Refused('нужен --operator <id учётной записи>');
  if (!reason || !incident) throw new Refused('нужны --reason и --incident (ссылка на инцидент)');
  const op = psql(
    t,
    `SELECT 'admin' FROM identity.users u JOIN identity.user_roles r ON r.user_id = u.id
      WHERE u.id = :'id' AND u.status = 'active' AND r.role = 'admin' AND r.revoked_at IS NULL`,
    { id: operator },
  );
  if (op !== 'admin') throw new Refused('оператор — не действующий администратор платформы');

  const m = readMaterial(t, id);
  if (!m) throw new Refused('записи материала нет — восстановление записей не создаёт');
  if (!m.project) throw new Refused('проекта нет — восстанавливать нечего');
  if (m.type === 'product_link') throw new Refused('материал — ссылка, файла у него нет');
  if (m.state !== 'ready') throw new Refused(`материал не готов (${m.state})`);
  if (!/^[0-9a-f]{64}$/.test(m.sha256)) throw new Refused('у записи нет SHA-256 содержимого');

  const work = workDir(t);
  let newKey = null;
  let linked = false;
  try {
    const now = readObject(t, m.key, work);
    if (now && now.size === m.size && now.sha256 === m.sha256) {
      console.log('файл на месте и совпадает с записью — восстанавливать нечего');
      return { outcome: 'intact' };
    }
    console.log(now ? 'файл повреждён: содержимое не совпадает с записью' : 'файл утрачен');

    // Источник — пригодная файловая копия с этим содержимым.
    const wanted = opt('set');
    let source = null;
    const rejected = [];
    for (const sid of wanted ? [wanted] : filesSets(t)) {
      const s = loadSet(t, sid);
      if (!s.catalog) {
        rejected.push(`${sid}: ${s.problems.join(', ')}`);
        continue;
      }
      const o = s.catalog.objects.find((x) => x.sha256 === m.sha256 && x.size === m.size);
      if (!o) continue;
      const sealed = readFileSync(join(s.dir, o.file));
      if (sha256(sealed) !== o.fileSha256) {
        rejected.push(`${sid}: копия повреждена (сумма зашифрованного файла)`);
        continue;
      }
      let plain;
      try {
        plain = open(setKey(t), sealed);
      } catch (error) {
        rejected.push(`${sid}: ${error.message}`);
        continue;
      }
      if (plain.length !== m.size || sha256(plain) !== m.sha256) {
        rejected.push(`${sid}: расшифрованный файл не совпадает с записью`);
        continue;
      }
      writeFileSync(join(work, 'restored'), plain, { mode: 0o600 });
      source = { set: sid, catalogSha256: readText(join(s.dir, 'CATALOG.sha256')) };
      break;
    }
    for (const r of rejected) console.log(`  копия отвергнута — ${r}`);
    if (!source) throw new Refused('подходящей проверенной копии нет — материал не изменён');

    const operationId = randomUUID();
    newKey = posix.join(posix.dirname(m.key), `restored-${operationId}`);
    rclone(t, ['copyto', '/work/restored', `SRC:${t.s3.bucket}/${newKey}`], { mount: work });
    rmSync(join(work, 'restored'), { force: true });
    const back = readObject(t, newKey, work);
    if (!back || back.size !== m.size || back.sha256 !== m.sha256) {
      throw new Refused('объект под новым ключом не совпал с записью — материал не изменён');
    }
    console.log(`объект под новым ключом сверен: ${m.size} байт, SHA-256 совпадает`);

    // Испытание: окно для конкурентного изменения перед переключением.
    const pause = opt('pause-before-link');
    if (pause) {
      writeFileSync(`${pause}.waiting`, newKey);
      const until = Date.now() + 600_000;
      while (!existsSync(pause) && Date.now() < until) await new Promise((r) => setTimeout(r, 500));
    }

    const actor = {
      v: 1,
      kind: 'system',
      userId: null,
      serviceAccountId: null,
      role: 'system',
      basis: [{ check: 'job', name: 'ops.file-restore' }],
      onBehalfOf: null,
      testSessionId: null,
      viewMode: false,
      operationId,
      requestId: null,
      job: { name: 'ops.file-restore', runId: operationId, attempt: 1 },
      initiator: { kind: 'person', userId: operator },
      accessContext: null,
    };
    const context = {
      reason,
      incident: { ref: incident, ledger: 'временный учёт до ITSM' },
      operator: {
        userId: operator,
        hostAccount: process.env.SUDO_USER || userInfo().username,
        host: hostname(),
      },
      source,
    };
    const res = psql(
      t,
      `SELECT outcome || '|' || coalesce(event_id::text, '') FROM lab.restore_material_file(
         :'id'::uuid, :'old', :'new', :'sha', :'size'::bigint, :'actor'::jsonb, :'ctx'::jsonb, :'trace')`,
      {
        id,
        old: m.key,
        new: newKey,
        sha: m.sha256,
        size: m.size,
        actor: JSON.stringify(actor),
        ctx: JSON.stringify(context),
        trace: `file-restore-${operationId}`,
      },
    );
    const [outcome, eventId] = res.split('|');
    if (outcome !== 'restored') {
      throw new Refused(
        outcome === 'key_changed'
          ? 'запись изменилась во время восстановления — связь не переключена'
          : `база отказала: ${outcome} — материал не изменён`,
      );
    }
    linked = true;
    console.log(`восстановлено: ключ переключён, событие журнала ${eventId}`);
    return { outcome, eventId, newKey, operationId, source };
  } finally {
    // Новый объект без связи с записью не оставляем.
    if (newKey && !linked) {
      rclone(t, ['deletefile', `SRC:${t.s3.bucket}/${newKey}`], { allowFail: true });
    }
    rmSync(work, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------ испытание

function trialOnly(t) {
  if (!flag('trial')) throw new Refused('шаг испытания — только с --trial');
  if (!['test-1', 'local'].includes(t.env)) throw new Refused('испытание — только test-1 и local');
}

/** Утрата файла: удалить текущий объект готового материала. */
function dropObject(t) {
  trialOnly(t);
  const m = readMaterial(t, opt('material') ?? '');
  if (!m || m.state !== 'ready' || !m.key) throw new Refused('нужен готовый материал');
  rclone(t, ['deletefile', `SRC:${t.s3.bucket}/${m.key}`]);
  console.log('объект удалён (утрата для испытания)');
}

/** Повреждение копии: один байт каждого зашифрованного объекта. */
function corruptSet(t) {
  trialOnly(t);
  const s = loadSet(t, opt('set') ?? '');
  if (!s.catalog) throw new Refused(`копия непригодна: ${s.problems.join(', ')}`);
  for (const o of s.catalog.objects) {
    const f = join(s.dir, o.file);
    const b = readFileSync(f);
    b[b.length - 20] ^= 0xff;
    writeFileSync(f, b);
  }
  console.log(`копия ${s.id} повреждена: объектов ${s.catalog.objects.length}`);
}

/**
 * Защита готового материала: обычное изменение запрещено, приложение не обходит её ни
 * отметкой, ни вызовом функции. Всё — в транзакциях с откатом.
 */
function guards(t) {
  trialOnly(t);
  const id = opt('material') ?? '';
  const m = readMaterial(t, id);
  if (!m || m.state !== 'ready') throw new Refused('нужен готовый материал');
  const fake = `${m.key}-guard`;
  // Контекст, при котором политики строк ПРОПУСКАЮТ изменение (автор и администратор):
  // проверяется именно триггер, а не пустая выборка без контекста.
  const author = psql(t, `SELECT uploaded_by FROM lab.project_materials WHERE id = :'id'`, { id });
  const ctx = `SELECT set_config('app.current_user_id', '${author}', true),
  set_config('app.current_roles', 'admin,founder', true);`;
  const upd = (role, mark) => `BEGIN;
${role ? `SET LOCAL ROLE ${role};` : ''}
${role ? ctx : ''}
${mark ? `SELECT set_config('lab.file_restore', '${id}', true);` : ''}
WITH u AS (UPDATE lab.project_materials SET s3_key = '${fake}' WHERE id = '${id}' RETURNING 1)
SELECT count(*) FROM u;
ROLLBACK;`;
  const call = (role) => `BEGIN; SET LOCAL ROLE ${role};
SELECT * FROM lab.restore_material_file('${id}', '${m.key}', '${fake}', '${m.sha256}', ${m.size},
  '{}'::jsonb, '{}'::jsonb, 'guard');
ROLLBACK;`;
  const cases = [
    ['владелец, обычное изменение ключа', upd(null, false), 'immutable'],
    [
      'владелец, ключ и размер с отметкой',
      `BEGIN;
SELECT set_config('lab.file_restore', '${id}', true);
UPDATE lab.project_materials SET s3_key = '${fake}', size_bytes = size_bytes + 1 WHERE id = '${id}';
ROLLBACK;`,
      'immutable',
    ],
    ['app_maintenance с отметкой', upd('app_maintenance', true), 'zero'],
    ['app_backend (автор и администратор) без отметки', upd('app_backend', false), 'immutable'],
    ['app_backend (автор и администратор) с отметкой', upd('app_backend', true), 'immutable'],
    ['app_backend вызывает функцию', call('app_backend'), 'denied'],
    ['app_maintenance вызывает функцию', call('app_maintenance'), 'denied'],
  ];
  const results = [];
  for (const [name, sql, want] of cases) {
    const r = psqlTry(t, sql);
    const got = !r.ok
      ? /immutable/.test(r.err)
        ? 'immutable'
        : /permission denied/.test(r.err)
          ? 'denied'
          : `ошибка: ${r.err.split('\n').at(-1)}`
      : r.out.split('\n').includes('0')
        ? 'zero'
        : `изменено: ${r.out}`;
    // «Отказано» и «0 строк» одинаково означают, что защита держит; главное — не «изменено».
    const ok = got === want || (want !== 'immutable' && ['denied', 'zero'].includes(got));
    results.push({ name, want, got, ok });
    console.log(`  ${ok ? 'да ' : 'НЕТ'} ${name}: ${got}`);
  }
  const acl = psql(
    t,
    "SELECT coalesce(proacl::text, '') FROM pg_proc WHERE proname = 'restore_material_file'",
  );
  const aclOk = !/(^|[{,])=X/.test(acl) && !/app_/.test(acl);
  console.log(`  ${aclOk ? 'да ' : 'НЕТ'} EXECUTE функции не выдан PUBLIC и ролям приложения`);
  const after = readMaterial(t, id);
  const same = after.key === m.key;
  console.log(`  ${same ? 'да ' : 'НЕТ'} ключ материала после проверок прежний`);
  const pass = results.every((r) => r.ok) && aclOk && same;
  if (!pass) process.exitCode = 1;
  return { results, aclOk, same, pass };
}

/** Состояние материала для испытания: ключ, видимость, число объектов в каталоге файла. */
function state(t) {
  trialOnly(t);
  const id = opt('material') ?? '';
  const row = psql(
    t,
    `SELECT coalesce(s3_key, '') || '|' || visibility || '|' || upload_state
       FROM lab.project_materials WHERE id = :'id'`,
    { id },
  );
  if (!row) return { exists: false };
  const [key, visibility, uploadState] = row.split('|');
  let objects = null;
  if (key) {
    const ls = rclone(t, ['lsf', '--files-only', `SRC:${t.s3.bucket}/${posix.dirname(key)}`], {
      allowFail: true,
    });
    objects = ls.status === 0 ? ls.stdout.split('\n').filter(Boolean).length : 0;
  }
  const events = Number(
    psql(
      t,
      `SELECT count(*) FROM audit.events WHERE subject_id = :'id'::uuid AND verb = 'material.file_restored'`,
      { id },
    ),
  );
  const last = psql(
    t,
    `SELECT context_jsonb::text FROM audit.events
      WHERE subject_id = :'id'::uuid AND verb = 'material.file_restored' ORDER BY ts DESC LIMIT 1`,
    { id },
  );
  const r = {
    exists: true,
    key,
    visibility,
    uploadState,
    objects,
    events,
    lastEvent: last ? JSON.parse(last) : null,
  };
  console.log(
    `ключ …${key.slice(-48)}, видимость ${visibility}, объектов ${objects}, событий ${events}`,
  );
  return r;
}

/** Цепочка журнала с момента: пустой список — цела. */
function chain(t) {
  trialOnly(t);
  const since = opt('since') ?? new Date(Date.now() - 3600_000).toISOString();
  const broken = psql(t, `SELECT count(*) FROM audit.verify_event_chain(:'since'::timestamptz)`, {
    since,
  });
  console.log(`цепочка журнала с ${since}: нарушений ${broken}`);
  return { since, broken: Number(broken) };
}

/** Файловая копия не выбирается как комплект восстановления (`readySets` комплектов копий). */
async function readySetsCheck(t) {
  trialOnly(t);
  process.env.BACKUP_DIR = t.backups;
  const { readySets } = await import('./lib/backup.mjs');
  const files = filesSets(t).filter((id) => existsSync(join(setsDir(t), id, 'READY-FILES')));
  // Даже с отметкой READY (как у полного комплекта) копия с типом не выбирается.
  const probe = join(setsDir(t), `zz-ready-probe-${randomUUID().slice(0, 8)}`);
  mkdirSync(probe, { recursive: true });
  writeFileSync(join(probe, 'TYPE'), `${FILES_ONLY}\n`);
  writeFileSync(join(probe, 'READY'), 'probe\n');
  let chosen;
  try {
    chosen = readySets();
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
  console.log(`файловых копий ${files.length}; readySets выбрал ${chosen.length}`);
  return { filesSets: files.length, readySets: chosen };
}

// ------------------------------------------------------------ утрата файла (работа № 7)

const KINDS = ['material', 'project_media', 'avatar'];

/** Текущие ключи записи: материал — s3_key, изображение (проект + вид) и аватар — варианты. */
function keys(t) {
  trialOnly(t);
  const kind = opt('kind');
  const record = opt('record') ?? '';
  if (!KINDS.includes(kind) || !UUID_RE.test(record)) throw new Refused('нужны --kind и --record');
  const sql = {
    material: `SELECT s3_key FROM lab.project_materials WHERE id = :'r' AND s3_key IS NOT NULL`,
    project_media: `SELECT unnest(ops.variant_keys(variants)) FROM lab.project_media
                     WHERE project_id = :'r' AND kind = :'mk' ORDER BY 1`,
    avatar: `SELECT unnest(ops.variant_keys(variants)) FROM identity.user_avatars
              WHERE user_id = :'r' ORDER BY 1`,
  }[kind];
  const list = psql(t, sql, { r: record, mk: opt('media-kind') ?? 'logo' })
    .split('\n')
    .filter(Boolean);
  return { keys: list };
}

/** Утрата для испытания: удалить объект по ключу, на который ссылается запись. */
function dropKey(t) {
  trialOnly(t);
  const key = opt('key') ?? '';
  const known = psql(
    t,
    `SELECT count(*) FROM (
       SELECT s3_key AS k FROM lab.project_materials
       UNION ALL SELECT unnest(ops.variant_keys(variants)) FROM lab.project_media
       UNION ALL SELECT unnest(ops.variant_keys(variants)) FROM identity.user_avatars) x
      WHERE k = :'k'`,
    { k: key },
  );
  if (known !== '1') throw new Refused('ключ не принадлежит ровно одной записи');
  rclone(t, ['deletefile', `SRC:${t.s3.bucket}/${key}`]);
  console.log('объект удалён (утрата для испытания)');
  return { dropped: key };
}

/** Строки учёта утраты по ключу и открытые утраты всего (как в /queues). */
function lost(t) {
  trialOnly(t);
  const key = opt('key') ?? '';
  const rows = psql(
    t,
    `SELECT coalesce(json_agg(json_build_object('kind', kind, 'hits', hits,
              'open', resolved_at IS NULL, 'resolution', resolution) ORDER BY first_seen), '[]')
       FROM ops.lost_files WHERE object_key = :'k'`,
    { k: key },
  );
  const files = JSON.parse(psql(t, `SELECT audit.queue_metrics() -> 'files'`));
  return { rows: JSON.parse(rows), files };
}

/** Запоздавший результат чтения: учесть утрату ключа, как это сделало бы ядро. */
function reportLate(t) {
  trialOnly(t);
  const r = psql(t, `SELECT ops.report_lost_file(:'kind', :'r'::uuid, :'k')`, {
    kind: opt('kind'),
    r: opt('record'),
    k: opt('key'),
  });
  console.log(`учёт утраты: ${r}`);
  return { result: r };
}

/**
 * Гонка: запись ключа держит транзакция смены (блокировка строки), в это время приходит учёт
 * утраты старого ключа. Он обязан дождаться и, увидев новый ключ, ничего не открыть.
 */
async function raceReport(t) {
  trialOnly(t);
  const id = opt('material') ?? '';
  const m = readMaterial(t, id);
  if (!m || m.state !== 'ready') throw new Refused('нужен готовый материал');
  const moved = `${m.key}-race`;
  const args = (sql) => {
    const a = ['exec', '-i'];
    if (t.pg.tcp) a.push('-e', 'PGPASSWORD');
    a.push(t.pg.container, 'psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1');
    if (t.pg.tcp) a.push('-h', '127.0.0.1');
    a.push('-U', t.pg.user, '-d', t.pg.db, '-c', sql);
    return a;
  };
  const env = { ...process.env, ...(t.pg.tcp ? { PGPASSWORD: t.secret.pgPassword() } : {}) };
  const { spawn } = await import('node:child_process');
  const run = (sql) =>
    new Promise((res) => {
      const c = spawn('docker', args(sql), { env });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (out += d));
      c.on('close', (code) => res({ code, out: out.trim(), at: Date.now() }));
    });
  // Смена ключа владельцем с отметкой восстановления (как в lab.restore_material_file),
  // держит строку 4 с и фиксируется.
  const holder = run(`BEGIN;
SELECT set_config('lab.file_restore', '${id}', true);
UPDATE lab.project_materials SET s3_key = '${moved}' WHERE id = '${id}';
SELECT pg_sleep(4);
COMMIT;`);
  await new Promise((r) => setTimeout(r, 1500));
  const t0 = Date.now();
  const late = await run(`SELECT ops.report_lost_file('material', '${id}', '${m.key}')`);
  const held = await holder;
  // Вернуть прежний ключ тем же путём (объект по нему уже есть или утрачен — как было).
  psql(
    t,
    `BEGIN; SELECT set_config('lab.file_restore', :'id', true);
     UPDATE lab.project_materials SET s3_key = :'old' WHERE id = :'id'; COMMIT;`,
    { id, old: m.key },
  );
  const result = {
    waitedMs: late.at - t0,
    holder: held.code,
    late: late.out.split('\n').at(-1),
  };
  console.log(`гонка: учёт ждал ${result.waitedMs} мс, результат ${result.late}`);
  return result;
}

// ------------------------------------------------------------ вход

const commands = {
  targets: (t) => {
    for (const f of verifyTarget(t)) console.log(`  ${f}`);
    console.log(
      `  конфигурация: ${t.configDir}${t.env === 'local' ? '' : ' (общий .env репозитория не читается)'}`,
    );
  },
  'files-set': (t) => (verifyTarget(t), filesSet(t)),
  restore: (t) => (verifyTarget(t), restore(t)),
  'drop-object': (t) => (verifyTarget(t), dropObject(t)),
  'corrupt-set': (t) => corruptSet(t),
  guards: (t) => (verifyTarget(t), guards(t)),
  state: (t) => (verifyTarget(t), state(t)),
  chain: (t) => chain(t),
  'ready-sets': (t) => readySetsCheck(t),
  keys: (t) => keys(t),
  'drop-key': (t) => (verifyTarget(t), dropKey(t)),
  lost: (t) => lost(t),
  'report-late': (t) => reportLate(t),
  'race-report': (t) => raceReport(t),
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!commands[command]) throw new Refused(`команды: ${Object.keys(commands).join(', ')}`);
    const t = target(opt('env'));
    const result = await commands[command](t);
    if (result && flag('json')) console.log(`RESULT ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`отказ: ${error.message}`);
    if (flag('json')) console.log(`RESULT ${JSON.stringify({ refused: error.message })}`);
    process.exit(error instanceof Refused ? 2 : 1);
  }
}

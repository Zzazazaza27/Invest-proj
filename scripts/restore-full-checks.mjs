#!/usr/bin/env node
/**
 * Контрольные операции восстановленного узла (работа № 5 раздела 01) через публичный вход —
 * Caddy с его локальным центром сертификатов (NODE_EXTRA_CA_CERTS задаёт `restore-full`).
 * Параметры — переменными RESTORE_*; последняя строка вывода — JSON итогов.
 *
 *   1. страница кабинета; 2. вход существующей учётной записи (временный пароль на этой
 *   копии) и свой профиль — email расшифрован ядром; 3. чтение восстановленного файла;
 *   4. контрольная запись — новый материал проекта: загрузка, завершение, чтение;
 *   5. Zabbix получает свежие данные; 6. потоки NATS как в комплекте; 7. наружу закрыто.
 * Адрес почты и пароль не печатаются.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const E = process.env;
const base = (E.RESTORE_BASE || '').replace(/\/$/, '');
// Публичный вход prod до запуска закрыт basic_auth: разовая учётка площадки (её ставит и снимает
// `restore-full`), только для запросов к самому сайту — не к адресам загрузки.
const gate = E.RESTORE_BASIC
  ? { Authorization: `Basic ${Buffer.from(E.RESTORE_BASIC).toString('base64')}` }
  : {};
const checks = [];
const check = (name, ok, details = '') => {
  checks.push({ name, ok: Boolean(ok), details: String(details).slice(0, 500) });
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}${details && !ok ? ` — ${details}` : ''}`);
  return Boolean(ok);
};
const sh = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, text: r.stdout ?? '', err: (r.stderr ?? '').trim() };
};
const psql = (db, sql) =>
  sh(
    'docker',
    [
      'exec',
      '-i',
      E.RESTORE_PG_CONTAINER,
      'psql',
      '-X',
      '-At',
      '-v',
      'ON_ERROR_STOP=1',
      '-U',
      'unicorn_owner',
      '-d',
      db,
    ],
    sql,
  );
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (b) => createHash('sha256').update(b).digest('hex');
// Объекты, которых нет в копии (не было на источнике) — их отмечает `restore-full` отдельной
// проверкой; «восстановленный файл» берётся из тех, что копия вернуть может.
const missingKeys = `ARRAY[${JSON.parse(E.RESTORE_MISSING_KEYS || '[]')
  .map((k) => `'${String(k).replace(/'/g, "''")}'`)
  .join(',')}]::text[]`;

function client() {
  const st = { session: null, csrf: null };
  return {
    async call(path, { method = 'GET', body, raw } = {}) {
      const headers = { ...gate, Cookie: [st.session, st.csrf].filter(Boolean).join('; ') };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (method !== 'GET' && st.csrf)
        headers['X-CSRF-Token'] = st.csrf.split('=').slice(1).join('=');
      const r = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? raw : JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      for (const c of r.headers.getSetCookie?.() ?? []) {
        const pair = c.split(';')[0];
        if (c.startsWith(`${E.RESTORE_SESSION_COOKIE}=`)) st.session = pair;
        if (c.startsWith(`${E.RESTORE_CSRF_COOKIE}=`)) st.csrf = pair;
      }
      const buf = Buffer.from(await r.arrayBuffer());
      let json = null;
      try {
        json = JSON.parse(buf.toString('utf8'));
      } catch {
        /* не JSON */
      }
      return { status: r.status, json, buf };
    },
  };
}

/** Внутри работающего ядра: его окружение, секреты из файлов и ключи OpenBao. */
function inCore(code) {
  return sh(
    'docker',
    ['exec', '-i', E.RESTORE_CORE_CONTAINER, 'node', '--input-type=module', '-'],
    code,
  );
}

let serviceReturn = null;
try {
  // 1. страница кабинета через публичный вход
  const page = await fetch(`${base}/`, { headers: gate, signal: AbortSignal.timeout(30_000) });
  check(
    'страница кабинета через публичный вход (Caddy, TLS)',
    page.status === 200,
    `HTTP ${page.status}`,
  );

  // 2. учётная запись с проектом
  const row = psql(
    E.RESTORE_DB,
    `SELECT u.id || '|' || p.id FROM identity.users u JOIN lab.founders_projects fp ON fp.user_id = u.id AND fp.role = 'owner'
       JOIN lab.projects p ON p.id = fp.project_id
      WHERE u.status = 'active' AND u.deleted_at IS NULL AND p.deleted_at IS NULL
        AND NOT identity.is_monitoring_user(u.id) AND NOT lab.is_monitoring_project(p.id)
      ORDER BY (SELECT count(*) FROM lab.project_materials m WHERE m.project_id = p.id AND m.upload_state = 'ready'
        AND m.uploaded_at < '${E.RESTORE_SINCE}' AND m.s3_key IS NOT NULL AND NOT (m.s3_key = ANY(${missingKeys}))) DESC, u.id
      LIMIT 1`,
  ).text.trim();
  if (!check('есть активная учётная запись с проектом', row.includes('|')))
    throw new Error('проверять вход некем');
  const [userId, projectId] = row.split('|');
  const opened = inCore(`
    import { applySecretFiles } from '/app/scripts/lib/secret-files.mjs';
    applySecretFiles(process.env);
    const pg = (await import('pg')).default;
    const { CryptoService } = await import('/app/apps/core/dist/crypto/crypto.service.js');
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_OWNER || process.env.DATABASE_URL, max: 1, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false });
    const { rows } = await pool.query('SELECT email_ciphertext, contact_wrapped_dek FROM identity.users WHERE id = $1', [${JSON.stringify(userId)}]);
    const email = (await new CryptoService().openField('passport_sensitive', rows[0].contact_wrapped_dek, rows[0].email_ciphertext, 'email')).toString('utf8');
    await pool.end();
    process.stdout.write(Buffer.from(email).toString('base64'));
  `);
  const email = opened.ok ? Buffer.from(opened.text.trim(), 'base64').toString('utf8') : '';
  check(
    'email учётной записи расшифрован ключами восстановленного OpenBao',
    email.includes('@'),
    opened.err.split('\n').pop(),
  );
  const password = randomBytes(18).toString('base64url');
  const hash = sh(
    'docker',
    [
      'exec',
      '-i',
      E.RESTORE_CORE_CONTAINER,
      'node',
      '-e',
      "require('argon2').hash(require('fs').readFileSync(0,'utf8'),{type:2}).then(h=>process.stdout.write(h))",
    ],
    password,
  );
  psql(
    E.RESTORE_DB,
    `UPDATE identity.users SET password_hash = '${hash.text.replace(/'/g, "''")}' WHERE id = '${userId}'`,
  );
  const c = client();
  await c.call('/v1/auth/csrf').catch(() => null);
  const login = await c.call('/v1/auth/login', { method: 'POST', body: { email, password } });
  check(
    'вход существующей учётной записи через публичный вход',
    login.status === 200 || login.status === 201,
    `HTTP ${login.status}`,
  );
  const me = await c.call('/v1/auth/me');
  const [n, d] = email.split('@');
  const masked = `${n.slice(0, 2)}${'*'.repeat(Math.max(1, n.length - Math.min(2, n.length)))}@${d}`;
  check(
    'свой профиль: email расшифрован ядром',
    me.status === 200 && me.json?.emailMasked === masked,
    `HTTP ${me.status}`,
  );

  // 3. чтение восстановленного файла
  const ready = psql(
    E.RESTORE_DB,
    `SELECT id || '|' || coalesce(content_hash, '') || '|' || size_bytes FROM lab.project_materials
      WHERE project_id = '${projectId}' AND upload_state = 'ready' AND s3_key IS NOT NULL
        AND uploaded_at < '${E.RESTORE_SINCE}' AND NOT (s3_key = ANY(${missingKeys}))
      ORDER BY uploaded_at DESC LIMIT 1`,
  ).text.trim();
  if (ready) {
    const [mid, want, size] = ready.split('|');
    const f = await c.call(`/v1/projects/${projectId}/materials/${mid}/content`);
    check(
      'восстановленный файл читается через ядро: размер и SHA-256 как в базе',
      f.status === 200 &&
        f.buf.length === Number(size) &&
        (!want || sha(f.buf) === want.replace(/^sha256:/, '')),
      `HTTP ${f.status}, ${f.buf.length} байт`,
    );
  } else check('у проекта нет готовых файлов — чтение восстановленного файла не проверялось', true);

  // 4. контрольная запись: новый материал
  const bytes = Buffer.concat([
    Buffer.from(`%PDF-1.4 restore-control ${randomUUID()}\n`),
    randomBytes(4096),
  ]);
  // Ядро решает о записи по СВОЕЙ пробе хранилища, а готовность её не ждёт: сразу после снятия
  // удержания (ядро пересоздано) группа «Файлы» может быть ещё «неизвестна» (прогон 12, 15.11).
  // Ждём до 2 мин; дольше — отказ с кодом причины.
  const askTicket = () =>
    c.call(`/v1/projects/${projectId}/materials/upload`, {
      method: 'POST',
      body: {
        type: 'deck',
        fileName: 'restore-control.pdf',
        contentType: 'application/pdf',
        sizeBytes: bytes.length,
      },
    });
  const waitStart = Date.now();
  let ticket = await askTicket();
  while (ticket.json?.code === 'group_unavailable' && Date.now() - waitStart < 120_000) {
    await new Promise((r) => setTimeout(r, 5_000));
    ticket = await askTicket();
  }
  const waited = Math.round((Date.now() - waitStart) / 1000);
  const why = ticket.json?.errors
    ? ` причина: ${JSON.stringify(ticket.json.errors).slice(0, 160)}`
    : ` ${JSON.stringify(ticket.json).slice(0, 200)}`;
  if (
    check(
      'контрольная запись: билет загрузки выдан',
      ticket.status === 201 || ticket.status === 200,
      `HTTP ${ticket.status}, ждали ${waited} с;${why}`,
    )
  ) {
    if (waited > 0)
      console.log(`        запись стала доступна через ${waited} с после первой попытки`);
    const form = new FormData();
    for (const [k, v] of Object.entries(ticket.json.formFields)) form.append(k, v);
    form.append('file', new Blob([bytes], { type: 'application/pdf' }), 'restore-control.pdf');
    const up = await fetch(ticket.json.uploadUrl, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    check(
      'контрольный файл передан в хранилище через публичный вход',
      up.status < 300,
      `HTTP ${up.status}`,
    );
    const mid = ticket.json.materialId ?? ticket.json.id;
    const fin = await c.call(`/v1/projects/${projectId}/materials/${mid}/finalize`, {
      method: 'POST',
    });
    check('контрольная запись завершена', fin.status < 300, `HTTP ${fin.status}`);
    const back = await c.call(`/v1/projects/${projectId}/materials/${mid}/content`);
    if (
      check(
        'контрольный файл читается: байт в байт',
        back.status === 200 && back.buf.equals(bytes),
        `HTTP ${back.status}`,
      )
    ) {
      serviceReturn = new Date().toISOString();
    }
  }

  // RESTORE_ONLY_OPERATIONS — проверка источника до комплекта: только операции 1–4
  // (свежесть Zabbix, потоки комплекта и закрытый выход к живому источнику не относятся).
  if (E.RESTORE_ONLY_OPERATIONS) throw Object.assign(new Error('только операции'), { stop: true });

  // 5. Zabbix получает свежие данные (база восстановлена с историей до T).
  const since = Math.floor(new Date(E.RESTORE_SINCE).getTime() / 1000);
  let fresh = false;
  for (let i = 0; i < 24 && !fresh; i++) {
    const m = psql('zabbix', 'SELECT coalesce(max(clock), 0) FROM history_uint').text.trim();
    fresh = Number(m) > since;
    if (!fresh) await sleep(10_000);
  }
  check('Zabbix получает данные после восстановления', fresh);

  // 6. потоки NATS как в комплекте (сами потоки создаются пустыми — 7.1).
  const want = JSON.parse(E.RESTORE_NATS || '[]');
  if (want.length) {
    // петля узла 127.0.0.1 (мониторинг NATS): TLS здесь ничего не защищает.
    // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
    const r = await fetch('http://127.0.0.1:8222/jsz?streams=true&config=true', {
      signal: AbortSignal.timeout(10_000),
    })
      .then((x) => x.json())
      .catch(() => null);
    const got = (r?.account_details ?? []).flatMap((a) => a.stream_detail ?? []);
    const diff = want.filter((w) => {
      const g = got.find((x) => x.name === w.name);
      return (
        !g ||
        JSON.stringify(g.config.subjects) !== JSON.stringify(w.config.subjects) ||
        g.config.retention !== w.config.retention
      );
    });
    check(
      `потоки NATS как в комплекте (${want.length})`,
      diff.length === 0,
      diff.map((d) => d.name).join(', '),
    );
  } else check('описания потоков NATS в комплекте нет — не сверялось', true);

  // 7. наружу закрыто и из службы
  const egress = inCore(
    "import net from 'node:net'; const s = net.connect({host:'1.1.1.1',port:443,timeout:5000}); s.on('connect',()=>{console.log('open');process.exit(0)}); s.on('error',()=>{console.log('closed');process.exit(0)}); s.on('timeout',()=>{console.log('closed');process.exit(0)});",
  );
  check('из ядра наружу закрыто', egress.text.trim() === 'closed', egress.text.trim());
} catch (e) {
  if (!e.stop) check('контрольные операции прерваны', false, String(e.message ?? e));
}
console.log(JSON.stringify({ checks, serviceReturn }));
if (checks.some((c) => !c.ok)) process.exitCode = 1;

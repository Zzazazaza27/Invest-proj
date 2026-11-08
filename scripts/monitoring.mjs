#!/usr/bin/env node
/**
 * Наблюдение как код (блок 8, 8.2–8.5; 2.1-W08a).
 *
 *   node scripts/monitoring.mjs configure   завести/обновить в Zabbix узел, проверки, пороги,
 *                                          Telegram, повторы тревог, хранение истории
 *   node scripts/monitoring.mjs status      открытые проблемы и свежесть данных
 *   node scripts/monitoring.mjs control-init  контрольный файл и запись для контрольной операции (M153)
 *   node scripts/monitoring.mjs openbao-status  есть ли элемент и триггер OpenBao, свежо ли значение
 *
 * Идемпотентно: повторный запуск обновляет, а не дублирует. Пороги — таблица
 * 8.2 («начальные настройки для испытания»); числа собраны в THRESHOLDS ниже,
 * чтобы их было видно и менять в одном месте.
 *
 * Среда задаётся MONITOR_ENV: `local` (агент в сети compose, ядро на машине
 * разработчика) или `vps` (агент в сети узла). Секреты — из `.env`
 * (пароль администратора Zabbix, пароли наблюдения за PostgreSQL и Valkey,
 * токен бота) — уходят в Zabbix скрытыми макросами и в вывод не попадают.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { ENV_PATH, loadEnv } from './lib/backup.mjs';
import { LOGS_ITEMS, logsTriggers } from './lib/logs-metrics-zabbix.mjs';
import { zabbixApi } from './lib/zabbix-api.mjs';
import { peek } from './lib/zabbix-peek.mjs';
import { s3Object } from './lib/s3.mjs';

loadEnv();
const env = process.env;
const [command] = process.argv.slice(2);
const MODE = env.MONITOR_ENV || 'local';
const HOST = env.ZABBIX_HOST_NAME || (MODE === 'vps' ? '5e-vps' : '5e-stand');
const api = zabbixApi(`http://127.0.0.1:${env.ZABBIX_WEB_PORT || 8090}/api_jsonrpc.php`);

/** Пороги блока 8.2 — предложения для испытания, сохраняются здесь. */
const THRESHOLDS = {
  cpuWarn: 85, // % за 10 минут
  ramWarn: 15, // % доступной за 5 минут
  ramHigh: 5, // % доступной за 2 минуты
  diskWarn: 20, // % свободного
  diskHigh: 10,
  certWarnDays: 14,
  certHighDays: 3,
  outboxAgeWarnSec: 300,
  jobMissedIntervals: 2,
  jobFailuresWarn: 3,
  backupCheckStaleSec: 900,
  containersStaleSec: 300,
  zabbixQueueWarn: 50,
};

/** Адреса проверок по среде. */
const ADDR =
  MODE === 'vps'
    ? {
        coreInternal: 'http://127.0.0.1:4400',
        publicUrl: 'https://5espace.com/',
        publicHealth: 'https://5espace.com/v1/health',
        pg: 'tcp://127.0.0.1:5433',
        redis: env.MONITOR_REDIS_URI || 'tcp://127.0.0.1:6380',
        nats: 'http://127.0.0.1:8222',
        // Garage (D-001): admin-порт первого узла, /health без токена.
        garageHealth: 'http://127.0.0.1:3903/health',
        certHost: '5espace.com',
        timesync: true,
        // Файл состояния архиватора журналов (W08b) — через корень узла.
        logsMetrics: '/rootfs/var/lib/fifth-logs/metrics.json',
      }
    : {
        coreInternal: 'http://host.docker.internal:4400',
        publicUrl: 'http://web/',
        publicHealth: 'http://web/v1/health',
        pg: 'tcp://postgres:5432',
        redis: 'tcp://valkey:6379',
        nats: 'http://nats:8222',
        garageHealth: 'http://garage-1:3903/health',
        certHost: null,
        timesync: false,
        logsMetrics: '/monitor/logs-metrics.json',
      };

// --------------------------------------------------------- предобработка

const JS = 21;
const JSONPATH = 12;
/**
 * Шаг предобработки. У JavaScript в Zabbix 7.0 нет «значения при ошибке» —
 * запасное значение даёт try/catch внутри кода; у остальных шагов — штатный
 * обработчик ошибки.
 */
const step = (type, params, onError = 0, errParams = '') =>
  type === JS && onError
    ? {
        type,
        params: `try { ${params} } catch (e) { return ${JSON.stringify(errParams)}; }`,
        error_handler: 0,
        error_handler_params: '',
      }
    : { type, params, error_handler: onError, error_handler_params: errParams };
/**
 * Ошибка ПОЛУЧЕНИЯ (сервис недоступен, файла нет) превращается в явное
 * значение — 0 или «устарело», — а не оставляет прежнее зелёное (замечание
 * Тэнка при приёмке W08a). Шаг ставится первым.
 */
const UNSUP = (value) => ({
  type: 26,
  params: '-1',
  error_handler: 2,
  error_handler_params: String(value),
});
/** Тело ответа web.page.get без заголовков. */
const BODY = "return value.split(/\\r?\\n\\r?\\n/).slice(1).join('\\n\\n');";
/** Код HTTP-ответа web.page.get. */
const STATUS = 'var m = value.match(/^HTTP\\/\\S+ (\\d{3})/); return m ? m[1] : 0;';

// ------------------------------------------------------------ настройка

async function login() {
  const wanted = env.ZABBIX_ADMIN_PASSWORD;
  if (!wanted) throw new Error('нет ZABBIX_ADMIN_PASSWORD в .env');
  try {
    await api.login('Admin', wanted);
  } catch {
    // Первый запуск: пароль по умолчанию сразу меняется на сгенерированный.
    await api.login('Admin', 'zabbix');
    const [admin] = await api.call('user.get', {
      filter: { username: 'Admin' },
      output: ['userid'],
    });
    await api.call('user.update', {
      userid: admin.userid,
      current_passwd: 'zabbix',
      passwd: wanted,
    });
    await api.login('Admin', wanted);
    console.log('пароль администратора Zabbix заменён сгенерированным (.env)');
  }
}

async function configure() {
  await login();

  // Хранение (8.4): подробно 30 дней, почасовые сводки 24 месяца; события и
  // проблемы — без возрастной очистки до решения по архиву.
  await api.call('housekeeping.update', {
    hk_history_global: 1,
    hk_history: '30d',
    hk_trends_global: 1,
    hk_trends: '730d',
    hk_events_mode: 0,
  });
  await api.call('settings.update', {
    severity_name_0: 'Без оценки',
    severity_name_1: 'Информация',
    severity_name_2: 'Предупреждение',
    severity_name_3: 'Средняя',
    severity_name_4: 'Высокая',
    severity_name_5: 'Критическая',
  });

  const groupid = await api.upsert('hostgroup', 'groupid', { name: ['5E'] }, { name: '5E' });
  const macros = [
    { macro: '{$PG.URI}', value: ADDR.pg },
    { macro: '{$PG.PASSWORD}', value: env.ZABBIX_MONITOR_DB_PASSWORD ?? '', type: 1 },
    { macro: '{$REDIS.URI}', value: ADDR.redis },
    { macro: '{$REDIS.PASSWORD}', value: env.REDIS_PASSWORD ?? '', type: 1 },
  ];
  const hostid = await api.upsert(
    'host',
    'hostid',
    { host: [HOST] },
    {
      host: HOST,
      name: `5Э ${MODE === 'vps' ? 'VPS 5espace.com' : 'локальный стенд'}`,
      groups: [{ groupid }],
      macros,
    },
  );

  const items = new Map();
  // Для «нет данных»: у каждой основной проверки и у выбранных зависимых —
  // своя тревога. nodata — важность, false — не нужна.
  const freshness = [];
  const typeById = new Map();
  const masterById = new Map();
  const item = async (spec) => {
    const { nodata, ...rest } = spec;
    const primary = rest.type !== 18 && rest.history !== '0';
    if (nodata !== false && (primary || nodata)) {
      freshness.push({
        key: rest.key_,
        name: rest.name,
        delay: rest.delay || '1m',
        priority: nodata || 2,
        type: rest.type,
        masterId: rest.master_itemid,
      });
    }
    const body = {
      history: '30d',
      trends: '730d',
      delay: '1m',
      ...rest,
      hostid,
    };
    if (body.value_type === 1 || body.value_type === 4) delete body.trends;
    if (body.type === 18) delete body.delay;
    const found = await api.call('item.get', {
      hostids: hostid,
      filter: { key_: spec.key_ },
      output: ['itemid'],
    });
    let itemid;
    if (found.length) {
      itemid = found[0].itemid;
      const update = { ...body };
      delete update.hostid;
      delete update.key_;
      delete update.type;
      delete update.value_type;
      delete update.master_itemid;
      await api.call('item.update', { itemid, ...update });
    } else {
      itemid = (await api.call('item.create', body)).itemids[0];
    }
    items.set(spec.key_, itemid);
    typeById.set(itemid, spec.type);
    if (spec.master_itemid) masterById.set(itemid, spec.master_itemid);
    return itemid;
  };
  const trigger = async (description, expression, priority, extra = {}) => {
    const found = await api.call('trigger.get', {
      hostids: hostid,
      filter: { description },
      output: ['triggerid'],
    });
    const body = { description, expression, priority, manual_close: 1, ...extra };
    if (found.length) {
      await api.call('trigger.update', { triggerid: found[0].triggerid, ...body });
      return found[0].triggerid;
    }
    return (await api.call('trigger.create', body)).triggerids[0];
  };
  const H = HOST;
  const AGENT = 7;
  const DEP = 18;

  // ---- Ядро: живость, готовность, фоновые задачи, очереди ----------------
  await item({
    name: 'Ядро: живость (/live)',
    key_: `web.page.get[${ADDR.coreInternal}/live]`,
    type: AGENT,
    value_type: 3,
    preprocessing: [
      UNSUP(0),
      step(JS, `${BODY.replace('return ', 'var b = ')} return JSON.parse(b).live ? 1 : 0;`, 2, '0'),
    ],
    tags: [{ tag: 'component', value: 'core' }],
    nodata: 4,
  });
  await trigger(
    'Ядро не живо (/live)',
    `last(/${H}/web.page.get[${ADDR.coreInternal}/live])=0`,
    4,
    {
      comments: 'Процесс ядра завис или остановлен; запросы пользователей не обслуживаются.',
    },
  );
  const readyKey = `web.page.get[${ADDR.coreInternal}/ready]`;
  await item({
    name: 'Ядро: готовность (/ready), исходный ответ',
    key_: readyKey,
    type: AGENT,
    value_type: 4,
    history: '0',
    preprocessing: [step(JS, BODY)],
  });
  const readyDep = async (name, key, js, valueType, extra = {}) =>
    item({
      name,
      key_: key,
      type: DEP,
      master_itemid: items.get(readyKey),
      value_type: valueType,
      preprocessing: [step(JS, js, 2, valueType === 1 ? 'нет ответа' : '0')],
      tags: [{ tag: 'component', value: 'core' }],
      ...extra,
    });
  // Общая готовность (4.9): запуск, основная БД, обязательные счётчики.
  await readyDep(
    'Ядро: общая готовность',
    'core.ready',
    'return JSON.parse(value).ready ? 1 : 0;',
    3,
    {
      nodata: 4,
    },
  );
  await trigger('Ядро не готово', `count(/${H}/core.ready,#3,"eq",0)=3`, 4, {
    recovery_mode: 1,
    recovery_expression: `count(/${H}/core.ready,#2,"eq",1)=2`,
    comments: 'Запуск не завершён, идёт остановка, или недоступна основная БД / счётчики (4.9).',
  });
  await readyDep(
    'Ядро: состояние процесса',
    'core.lifecycle',
    'return JSON.parse(value).lifecycle;',
    1,
  );
  const deps = [
    ['required.database', 'основная БД', 4],
    ['required.valkey', 'счётчики Valkey', 4],
    ['functions.storage', 'хранилище — файлы и загрузки не работают', 4],
    ['functions.nats', 'NATS — события не публикуются', 4],
  ];
  for (const [path, what, priority] of deps) {
    const key = `core.dep[${path}]`;
    await readyDep(`Ядро: ${what}`, key, `return JSON.parse(value).${path};`, 1);
    await trigger(`Ядро: недоступно — ${what}`, `count(/${H}/${key},#3,"eq","fail")=3`, priority, {
      comments:
        'Три проверки подряд (8.2). Хранилище и NATS общую готовность не снимают (4.9, 4.11).',
    });
  }
  await readyDep(
    'Ядро: фоновые задачи запущены',
    'core.dep[background]',
    'return JSON.parse(value).background;',
    1,
  );
  await trigger(
    'Ядро: фоновые задачи не работают',
    `count(/${H}/core.dep[background],#3,"eq","fail")=3`,
    2,
  );

  // Контрольная операция (8.2, 2.5): запись и файл со сверкой содержимого.
  const controlKey = `web.page.get[${ADDR.coreInternal}/control]`;
  await item({
    name: 'Контрольная операция, исходный ответ',
    key_: controlKey,
    type: AGENT,
    value_type: 4,
    history: '0',
    preprocessing: [step(JS, BODY)],
  });
  await item({
    name: 'Контрольная операция: запись и файл совпали',
    key_: 'core.control.ok',
    type: DEP,
    master_itemid: items.get(controlKey),
    value_type: 3,
    preprocessing: [step(JS, 'return JSON.parse(value).ok ? 1 : 0;', 2, '0')],
    nodata: 4,
  });
  await item({
    name: 'Контрольная операция: состояние файла',
    key_: 'core.control.file',
    type: DEP,
    master_itemid: items.get(controlKey),
    value_type: 1,
    preprocessing: [
      step(JS, 'var r = JSON.parse(value); return r.record + "/" + r.file;', 2, 'нет ответа'),
    ],
  });
  await trigger('Контрольная операция не проходит', `count(/${H}/core.control.ok,#3,"eq",0)=3`, 4, {
    recovery_mode: 1,
    recovery_expression: `count(/${H}/core.control.ok,#2,"eq",1)=2`,
    comments:
      'Контрольная запись не читается или контрольный файл недоступен / испорчен (запись/файл — в значении «состояние файла»).',
  });

  const jobsKey = `web.page.get[${ADDR.coreInternal}/jobs]`;
  await item({
    name: 'Ядро: фоновые задачи (/jobs), исходный ответ',
    key_: jobsKey,
    type: AGENT,
    value_type: 4,
    history: '0',
    preprocessing: [step(JS, BODY)],
  });
  await jobsDiscovery(hostid, items.get(jobsKey));

  const queuesKey = `web.page.get[${ADDR.coreInternal}/queues]`;
  await item({
    name: 'Ядро: очереди (/queues), исходный ответ',
    key_: queuesKey,
    type: AGENT,
    value_type: 4,
    history: '0',
    preprocessing: [step(JS, BODY)],
  });
  const queue = async (name, path) =>
    item({
      name,
      key_: `core.queue[${path}]`,
      type: DEP,
      master_itemid: items.get(queuesKey),
      value_type: 3,
      preprocessing: [step(JSONPATH, `$.queues.${path}`)],
      tags: [{ tag: 'component', value: 'core' }],
    });
  await queue('Outbox: ждут публикации', 'outbox.pending');
  freshness.push({
    key: 'core.queue[outbox.pending]',
    name: 'Ядро: очереди',
    delay: '1m',
    priority: 2,
  });
  await queue('Outbox: возраст самой старой, с', 'outbox.oldestAgeSec');
  await queue('Outbox: исчерпали попытки', 'outbox.exhausted');
  await queue('Загрузки: ожидают', 'uploads.pending');
  await queue('Загрузки: возраст самой старой ожидающей, с', 'uploads.oldestPendingAgeSec');
  await queue('Загрузки: требуют вмешательства', 'uploads.needsAttention');
  await trigger(
    'Outbox: событие не публикуется дольше порога',
    `last(/${H}/core.queue[outbox.oldestAgeSec])>${THRESHOLDS.outboxAgeWarnSec}`,
    2,
  );
  await trigger(
    'Outbox: события исчерпали попытки публикации',
    `last(/${H}/core.queue[outbox.exhausted])>0`,
    4,
  );
  await trigger(
    'Загрузки требуют вмешательства',
    `last(/${H}/core.queue[uploads.needsAttention])>0`,
    2,
    { comments: 'Загрузка не завершена и требует разбора по 2.1.2.' },
  );

  // ---- Разрешённое чтение прикладным путём (2.5; служебная учётка) ---------------
  await item({
    name: 'Прикладной путь: итог проверки, исходный файл',
    key_: 'vfs.file.contents[/monitor/app-probe.json]',
    type: AGENT,
    value_type: 4,
    history: '0',
  });
  await item({
    name: 'Прикладной путь: разрешённое чтение прошло',
    key_: 'app.probe.ok',
    type: DEP,
    master_itemid: items.get('vfs.file.contents[/monitor/app-probe.json]'),
    value_type: 3,
    preprocessing: [step(JS, 'return JSON.parse(value).ok ? 1 : 0;', 2, '0')],
  });
  await item({
    name: 'Прикладной путь: причина',
    key_: 'app.probe.reason',
    type: DEP,
    master_itemid: items.get('vfs.file.contents[/monitor/app-probe.json]'),
    value_type: 1,
    preprocessing: [step(JS, 'return JSON.parse(value).reason;', 2, 'файл не читается')],
  });
  await trigger(
    'Разрешённое чтение контрольных данных не проходит',
    `count(/${H}/app.probe.ok,#3,"eq",0)=3`,
    4,
    {
      recovery_mode: 1,
      recovery_expression: `count(/${H}/app.probe.ok,#2,"eq",1)=2`,
      comments:
        'Служебная учётка мониторинга не прочитала контрольный проект или файл обычным входом и проверкой прав (2.5). Причина — в значении «Прикладной путь: причина».',
    },
  );
  await item({
    name: 'Прикладной путь: возраст итога, с',
    key_: 'vfs.file.time[/monitor/app-probe.json,modify]',
    type: AGENT,
    value_type: 3,
    preprocessing: [
      UNSUP('missing'),
      step(
        JS,
        "if (value === 'missing') return 999999; return Math.floor(Date.now() / 1000) - Number(value);",
      ),
    ],
  });
  await trigger(
    'Проверка прикладного пути не запускается',
    `last(/${H}/vfs.file.time[/monitor/app-probe.json,modify])>${THRESHOLDS.containersStaleSec}`,
    2,
    {
      comments:
        'Таймер fifth-monitor-app-probe не обновлял итог дольше 5 минут — состояние неизвестно.',
    },
  );

  // ---- OpenBao (блок 5): файл пишет таймер узла, Zabbix от OpenBao не зависит ----
  await item({
    name: 'OpenBao: состояние, исходный файл',
    key_: 'vfs.file.contents[/monitor/openbao.json]',
    type: AGENT,
    value_type: 4,
    history: '0',
  });
  await item({
    name: 'OpenBao: работает или ещё не установлен',
    key_: 'openbao.ok',
    type: DEP,
    master_itemid: items.get('vfs.file.contents[/monitor/openbao.json]'),
    value_type: 3,
    preprocessing: [
      step(
        JS,
        "var s = JSON.parse(value).state; return s === 'open' || s === 'absent' ? 1 : 0;",
        2,
        '0',
      ),
    ],
  });
  await item({
    name: 'OpenBao Agent: файл токена на месте',
    key_: 'openbao.agent.ok',
    type: DEP,
    master_itemid: items.get('vfs.file.contents[/monitor/openbao.json]'),
    value_type: 3,
    preprocessing: [step(JS, "return JSON.parse(value).agent === 'down' ? 0 : 1;", 2, '0')],
  });
  await trigger('OpenBao Agent не работает', `count(/${H}/openbao.agent.ok,#3,"eq",0)=3`, 4, {
    recovery_mode: 1,
    recovery_expression: `count(/${H}/openbao.agent.ok,#2,"eq",1)=2`,
    comments:
      'Секретов нет в памяти: ядро и служебные запуски откажут. Порядок — docs/runbooks/openbao.md.',
  });
  await trigger('OpenBao запечатан или недоступен', `count(/${H}/openbao.ok,#3,"eq",0)=3`, 4, {
    recovery_mode: 1,
    recovery_expression: `count(/${H}/openbao.ok,#2,"eq",1)=2`,
    comments: 'Операции с ключами отказывают. Порядок восстановления — docs/runbooks/openbao.md.',
  });

  // ---- Сайт снаружи, сертификат --------------------------------------------
  // Рабочая среда закрыта паролем: агент его не умеет, проверку ведёт сервер, элемент HTTP.
  const gateFile = process.env.MONITOR_GATE_CREDENTIALS_PATH;
  const gate = gateFile ? readFileSync(gateFile, 'utf8').trim().split(':') : null;
  const page = async (name, url, marker, priority) => {
    const agentKey = `web.page.get[${url}]`;
    const httpKey = `site.page[${url}]`;
    const key = gate ? httpKey : agentKey;
    const stale = await api.call('item.get', {
      hostids: hostid,
      filter: { key_: gate ? agentKey : httpKey },
      output: ['itemid'],
    });
    if (stale.length)
      await api.call(
        'item.delete',
        stale.map((i) => i.itemid),
      );
    await item({
      name,
      key_: key,
      type: gate ? 19 : AGENT,
      ...(gate
        ? {
            url,
            authtype: 1,
            username: gate[0],
            password: gate[1],
            retrieve_mode: 2,
            status_codes: '',
            timeout: '10s',
          }
        : {}),
      value_type: 3,
      nodata: priority,
      preprocessing: [
        UNSUP(0),
        step(
          JS,
          `var m = value.match(/^HTTP\\/\\S+ (\\d{3})/); var b = value.split(/\\r?\\n\\r?\\n/).slice(1).join(''); return (m && m[1] === '200' && b.indexOf(${JSON.stringify(marker)}) >= 0) ? 1 : 0;`,
          2,
          '0',
        ),
      ],
      tags: [{ tag: 'component', value: 'public' }],
    });
    await trigger(
      `${name}: недоступно или не то содержимое`,
      `count(/${H}/${key},#3,"eq",0)=3`,
      priority,
      {
        recovery_mode: 1,
        recovery_expression: `count(/${H}/${key},#2,"eq",1)=2`,
        comments: 'Три неудачи подряд; восстановление — после двух правильных ответов (8.2).',
      },
    );
  };
  await page('Сайт: главная страница', ADDR.publicUrl, '<div id="root"', 4);
  await page('Сайт: API /v1/health', ADDR.publicHealth, '"status":"ok"', 4);
  if (ADDR.certHost) {
    const key = `web.certificate.get[${ADDR.certHost},443]`;
    await item({
      name: 'Сайт: дней до окончания сертификата',
      key_: key,
      type: AGENT,
      value_type: 0,
      delay: '1h',
      preprocessing: [
        UNSUP(-1),
        step(
          JS,
          'var t = JSON.parse(value).x509.not_after.timestamp; return Math.floor((t * 1000 - Date.now()) / 86400000);',
        ),
      ],
    });
    await trigger('Сертификат истекает', `last(/${H}/${key})<${THRESHOLDS.certWarnDays}`, 2);
    await trigger(
      'Сертификат истекает через считаные дни',
      `last(/${H}/${key})<${THRESHOLDS.certHighDays}`,
      4,
    );
  }

  // ---- Зависимости -------------------------------------------------------------
  const pgArgs = '"{$PG.URI}","zbx_monitor","{$PG.PASSWORD}"';
  await item({
    name: 'PostgreSQL: отвечает',
    key_: `pgsql.ping[${pgArgs}]`,
    type: AGENT,
    value_type: 3,
    preprocessing: [UNSUP(0)],
    nodata: 4,
  });
  await trigger('PostgreSQL не отвечает', `count(/${H}/pgsql.ping[${pgArgs}],#3,"eq",0)=3`, 5);
  await item({
    name: 'PostgreSQL: соединения, исходный ответ',
    key_: `pgsql.connections[${pgArgs}]`,
    type: AGENT,
    value_type: 4,
    history: '0',
  });
  await item({
    name: 'PostgreSQL: соединений всего',
    key_: 'pgsql.conn.total',
    type: DEP,
    master_itemid: items.get(`pgsql.connections[${pgArgs}]`),
    value_type: 3,
    preprocessing: [step(JSONPATH, '$.total')],
  });

  await trigger('PostgreSQL: соединения близки к пределу', `min(/${H}/pgsql.conn.total,5m)>100`, 2);
  await item({
    name: 'PostgreSQL: размер базы fifth_element',
    key_: `pgsql.db.size[${pgArgs},"fifth_element"]`,
    type: AGENT,
    value_type: 3,
    delay: '10m',
  });
  await item({
    name: 'PostgreSQL: размер базы zabbix',
    key_: `pgsql.db.size[${pgArgs},"zabbix"]`,
    type: AGENT,
    value_type: 3,
    delay: '10m',
  });

  const redisArgs = '"{$REDIS.URI}","{$REDIS.PASSWORD}"';
  await item({
    name: 'Valkey: отвечает',
    key_: `redis.ping[${redisArgs}]`,
    type: AGENT,
    value_type: 3,
    preprocessing: [UNSUP(0)],
    nodata: 4,
  });
  await trigger('Valkey не отвечает', `count(/${H}/redis.ping[${redisArgs}],#3,"eq",0)=3`, 4);

  const simple = async (name, url, priority) => {
    const key = `web.page.get[${url}]`;
    await item({
      name,
      key_: key,
      type: AGENT,
      value_type: 3,
      nodata: priority,
      preprocessing: [
        UNSUP(0),
        step(
          JS,
          STATUS.replace('return m ? m[1] : 0;', "return (m && m[1] === '200') ? 1 : 0;"),
          2,
          '0',
        ),
      ],
    });
    await trigger(`${name}: нет ответа`, `count(/${H}/${key},#3,"eq",0)=3`, priority);
  };
  await simple('NATS: /healthz', `${ADDR.nats}/healthz`, 4);
  // Garage (D-001): /health без токена различает три состояния — все узлы в
  // строю (2); работает, но часть узлов недоступна — резервирование снижено
  // (1); нет кворума — чтение и запись не работают (0, ответ 503). Узел
  // считается недоступным примерно через 2 минуты после остановки (опыт
  // стенда 03.11). Три узла на одном VPS — не защита от потери VPS.
  {
    const key = `web.page.get[${ADDR.garageHealth}]`;
    await item({
      name: 'Garage: состояние кластера (2 — все узлы, 1 — часть узлов, 0 — нет кворума)',
      key_: key,
      type: AGENT,
      value_type: 3,
      nodata: 4,
      preprocessing: [
        UNSUP(0),
        step(
          JS,
          'if (!/^HTTP\\/\\S+ 200/.test(value)) return 0; return /fully operational/.test(value) ? 2 : /operational/.test(value) ? 1 : 0;',
          2,
          '0',
        ),
      ],
    });
    await trigger(
      'Garage: нет кворума — чтение и запись файлов не работают',
      `count(/${H}/${key},#3,"eq",0)=3`,
      4,
    );
    await trigger(
      'Garage: часть узлов недоступна — резервирование снижено',
      `last(/${H}/${key})=1`,
      3,
    );
  }

  // ---- Узел: процессор, память, диск, время --------------------------------------
  await item({
    name: 'Узел: загрузка процессора, %',
    key_: 'system.cpu.util',
    nodata: 4,
    type: AGENT,
    value_type: 0,
  });
  await trigger(
    'Высокая загрузка процессора',
    `avg(/${H}/system.cpu.util,10m)>${THRESHOLDS.cpuWarn}`,
    2,
  );
  await item({
    name: 'Узел: доступно памяти, %',
    key_: 'vm.memory.size[pavailable]',
    type: AGENT,
    value_type: 0,
  });
  await trigger('Мало памяти', `avg(/${H}/vm.memory.size[pavailable],5m)<${THRESHOLDS.ramWarn}`, 2);
  await trigger(
    'Память почти исчерпана',
    `max(/${H}/vm.memory.size[pavailable],2m)<${THRESHOLDS.ramHigh}`,
    4,
  );
  for (const [kind, key] of [
    ['места', 'vfs.fs.size[/rootfs,pfree]'],
    ['inode', 'vfs.fs.inode[/rootfs,pfree]'],
  ]) {
    await item({
      name: `Узел: свободно ${kind} на корневом диске, %`,
      key_: key,
      type: AGENT,
      value_type: 0,
    });
    await trigger(
      `Мало свободного ${kind} на диске`,
      `last(/${H}/${key})<${THRESHOLDS.diskWarn}`,
      2,
    );
    await trigger(
      `Свободного ${kind} на диске критически мало`,
      `last(/${H}/${key})<${THRESHOLDS.diskHigh}`,
      4,
    );
  }
  if (ADDR.timesync) {
    const key = 'vfs.file.exists[/host-timesync/synchronized]';
    await item({
      name: 'Узел: время синхронизировано',
      key_: key,
      type: AGENT,
      value_type: 3,
      preprocessing: [UNSUP(0)],
    });
    await trigger('Время узла не синхронизировано', `max(/${H}/${key},10m)=0`, 2);
  }

  // ---- Контейнеры и резервирование (файлы узла, без Docker socket) ----------------
  await item({
    name: 'Контейнеры: состояние, исходный файл',
    key_: 'vfs.file.contents[/monitor/containers.json]',
    type: AGENT,
    value_type: 4,
    history: '0',
  });
  await item({
    name: 'Контейнеры: не работают',
    key_: 'containers.down',
    type: DEP,
    master_itemid: items.get('vfs.file.contents[/monitor/containers.json]'),
    value_type: 1,
    preprocessing: [
      step(
        JS,
        "var c = JSON.parse(value).containers; return c.filter(function (x) { return x.expected && x.state !== 'running'; }).map(function (x) { return x.name; }).join(', ');",
      ),
    ],
  });
  await item({
    name: 'Контейнеры: перезапусков всего',
    key_: 'containers.restarts',
    type: DEP,
    master_itemid: items.get('vfs.file.contents[/monitor/containers.json]'),
    value_type: 3,
    preprocessing: [
      step(
        JS,
        'return JSON.parse(value).containers.reduce(function (n, x) { return n + (x.restarts || 0); }, 0);',
      ),
    ],
  });
  await trigger('Контейнер не работает', `length(last(/${H}/containers.down))>0`, 4);
  await trigger('Контейнер перезапускался', `change(/${H}/containers.restarts)>0`, 2);
  // Предел перезапусков зависшего ядра исчерпан (core-health-policy.mjs): процесс оставлен
  // для разбора, нужен человек. Высокий уровень — тот же канал, что у «не работает».
  await item({
    name: 'Ядро: автовосстановление остановлено',
    key_: 'containers.recovery_stopped',
    type: DEP,
    master_itemid: items.get('vfs.file.contents[/monitor/containers.json]'),
    value_type: 1,
    preprocessing: [
      step(
        JS,
        "var c = JSON.parse(value).containers; return c.filter(function (x) { return x.recoveryStopped; }).map(function (x) { return x.name; }).join(', ');",
      ),
    ],
  });
  await trigger(
    'Автовосстановление ядра остановлено',
    `length(last(/${H}/containers.recovery_stopped))>0`,
    4,
  );
  await item({
    name: 'Контейнеры: возраст файла состояния, с',
    key_: 'vfs.file.time[/monitor/containers.json,modify]',
    type: AGENT,
    value_type: 3,
    preprocessing: [
      UNSUP('missing'),
      step(
        JS,
        "if (value === 'missing') return 999999; return Math.floor(Date.now() / 1000) - Number(value);",
      ),
    ],
  });
  await trigger(
    'Состояние контейнеров не обновляется',
    `last(/${H}/vfs.file.time[/monitor/containers.json,modify])>${THRESHOLDS.containersStaleSec}`,
    2,
  );

  await item({
    name: 'Резервирование: сигналы, исходный файл',
    key_: 'vfs.file.contents[/backup-state/signals.json]',
    type: AGENT,
    value_type: 4,
    history: '0',
  });
  await item({
    name: 'Резервирование: проблемы по компонентам',
    key_: 'backup.problems',
    type: DEP,
    master_itemid: items.get('vfs.file.contents[/backup-state/signals.json]'),
    value_type: 1,
    preprocessing: [
      step(
        JS,
        "var s = JSON.parse(value); return Object.keys(s).filter(function (k) { return s[k].status === 'problem'; }).join(', ');",
      ),
    ],
  });
  // Сами проблемы резервирования W07 уже сообщает в Telegram — здесь они
  // видны в Zabbix с важностью «Информация» и второго сообщения не дают.
  await trigger('Резервирование: есть проблемы', `length(last(/${H}/backup.problems))>0`, 1);
  await item({
    name: 'Резервирование: возраст последней проверки, с',
    key_: 'vfs.file.time[/backup-state/last-check.json,modify]',
    type: AGENT,
    value_type: 3,
    preprocessing: [
      UNSUP('missing'),
      step(
        JS,
        "if (value === 'missing') return 999999; return Math.floor(Date.now() / 1000) - Number(value);",
      ),
    ],
  });
  await trigger(
    'Проверка резервирования не запускается',
    `last(/${H}/vfs.file.time[/backup-state/last-check.json,modify])>${THRESHOLDS.backupCheckStaleSec}`,
    2,
    {
      comments: 'Таймер fifth-backup-check не работал дольше 15 минут: сигналы W07 не обновляются.',
    },
  );

  // ---- Архив технических журналов (W08b) -----------------------------------
  // Только там, где архив настроен (LOGS_S3_BUCKET в .env; локально —
  // MONITOR_LOGS=1): без архиватора файла состояния нет, и проверки давали бы
  // ложную тревогу «не обновляется». Иначе прежние проверки журналов
  // снимаются вместе с их тревогами (переход на Garage 03.11: архив на VPS
  // ещё не включён).
  if (env.LOGS_S3_BUCKET || env.MONITOR_LOGS === '1') {
    // Файл состояния архиватора: только числа, метки и коды. Каждая зависимая
    // проверка сама отвергает устаревший файл — «неизвестно», а не нули.
    const logsFile = `vfs.file.contents[${ADDR.logsMetrics}]`;
    await item({
      name: 'Журналы: файл состояния архиватора',
      key_: logsFile,
      type: AGENT,
      value_type: 4,
      history: '0',
    });
    for (const x of LOGS_ITEMS) {
      await item({
        name: x.name,
        key_: x.key,
        type: DEP,
        master_itemid: items.get(logsFile),
        value_type: x.valueType,
        preprocessing: [step(JS, x.js)],
        nodata: false,
      });
    }
    await item({
      name: 'Журналы: возраст файла состояния, с',
      key_: `vfs.file.time[${ADDR.logsMetrics},modify]`,
      type: AGENT,
      value_type: 3,
      preprocessing: [
        UNSUP('missing'),
        step(
          JS,
          "if (value === 'missing') return 999999; return Math.floor(Date.now() / 1000) - Number(value);",
        ),
      ],
    });
    for (const [name, expression, priority] of logsTriggers(H, ADDR.logsMetrics)) {
      await trigger(name, expression, priority);
    }
  } else {
    const stale = (
      await api.call('item.get', { hostids: hostid, output: ['itemid', 'key_'] })
    ).filter((x) => x.key_.startsWith('logs.') || x.key_.includes(ADDR.logsMetrics));
    if (stale.length)
      await api.call(
        'item.delete',
        stale.map((x) => x.itemid),
      );
    console.log(`журналы: архив не настроен — проверки журналов сняты (${stale.length})`);
  }

  // ---- Сам Zabbix и контрольная отметка для пульса --------------------------------
  await item({
    name: 'Zabbix: контрольная отметка агента',
    key_: 'agent.ping',
    type: AGENT,
    value_type: 3,
  });
  await item({
    name: 'Zabbix: очередь проверок старше 10 минут',
    key_: 'zabbix[queue,10m]',
    type: 5,
    value_type: 3,
  });
  await trigger(
    'Zabbix: проверки не успевают',
    `min(/${H}/zabbix[queue,10m],10m)>${THRESHOLDS.zabbixQueueWarn}`,
    2,
  );

  // Узел «Zabbix server» из установки по умолчанию ждёт пассивного агента,
  // которого нет, — ложная проблема. Отключается, не удаляется.
  const defaults = await api.call('host.get', {
    filter: { host: ['Zabbix server'] },
    output: ['hostid'],
  });
  for (const d of defaults) await api.call('host.update', { hostid: d.hostid, status: 1 });

  const retired = ['Нет данных о живости ядра', 'Нет данных об очередях ядра', 'Нет данных с узла'];
  const oldTriggers = await api.call('trigger.get', {
    hostids: hostid,
    filter: { description: retired },
    output: ['triggerid'],
  });
  if (oldTriggers.length)
    await api.call(
      'trigger.delete',
      oldTriggers.map((t) => t.triggerid),
    );
  // «Нет данных» по проверкам, которые собирает агент (его собственные и
  // зависимые от них), подчинены одной тревоге — пропаже контрольной отметки
  // агента. Пропал агент — одно сообщение, а не по одному на проверку
  // (выпуск W08a 2026-11-02: проба остановки агента дала 42 сообщения).
  // Проверки самого сервера Zabbix и HTTP-проверки с сервера — независимы.
  // Цепочку зависимых проходим до источника: зависимая от зависимой от
  // агентской — тоже агентская (опыт 2026-11-02: «Ядро: очереди» проскочила).
  const sourceType = (type, masterId) => {
    let t = type;
    let m = masterId;
    for (let i = 0; t === DEP && m && i < 10; i++) {
      t = typeById.get(m);
      m = masterById.get(m);
    }
    return t;
  };
  // Тип — по самой проверке (через ключ), а не по записи: часть записей
  // «нет данных» добавлена вручную без типа.
  const viaAgent = (f) => {
    const id = items.get(f.key);
    return sourceType(typeById.get(id) ?? f.type, masterById.get(id) ?? f.masterId) === AGENT;
  };
  const windowOf = (f) => {
    const n = Number.parseInt(f.delay, 10) * 3;
    return `${n}${f.delay.replace(/^\d+/, '')}`;
  };
  const comments =
    'Нет измерений больше трёх интервалов — состояние неизвестно, а не «в порядке» (8.2).';
  const agentFresh = freshness.find((f) => f.key === 'agent.ping');
  const agentTrigger = await trigger(
    `Нет данных: ${agentFresh.name}`,
    // Окно короче, чем у зависимых (3 интервала): отметка агента должна уйти
    // в «проблему» раньше них, иначе зависимые успеют сработать сами.
    `nodata(/${H}/agent.ping,2m)=1`,
    4,
    {
      comments: `${comments} Агент не передаёт данные — остальные «Нет данных» по проверкам агента подавлены зависимостью.`,
      dependencies: [],
    },
  );
  // Агентская проверка «молчит» по-настоящему, только если сам агент всё её
  // окно присылал отметки (раз в минуту, допуск — одна). Иначе после
  // возвращения агента зависимость снимается раньше первых свежих данных и
  // «Нет данных» вспыхивает на секунды (проба 2026-11-02: живость и общая
  // готовность ядра, 4 лишних сообщения).
  const minutes = (w) => Number.parseInt(w, 10) * ({ s: 1 / 60, m: 1, h: 60 }[w.at(-1)] ?? 1);
  for (const f of freshness) {
    if (f.key === 'agent.ping') continue;
    const w = windowOf(f);
    const agentAlive = Math.max(1, Math.floor(minutes(w)) - 1);
    await trigger(
      `Нет данных: ${f.name}`,
      viaAgent(f)
        ? `nodata(/${H}/${f.key},${w})=1 and count(/${H}/agent.ping,${w})>=${agentAlive}`
        : `nodata(/${H}/${f.key},${w})=1`,
      f.priority,
      {
        comments,
        dependencies: viaAgent(f) ? [{ triggerid: agentTrigger }] : [],
      },
    );
  }

  await notifications();
  await pulseUser(groupid);
  console.log(`наблюдение настроено: узел ${HOST} (${MODE}), проверок ${items.size}`);
}

/** Обнаружение фоновых задач из /jobs и правила по каждой. */
async function jobsDiscovery(hostid, masterid) {
  const key = 'core.jobs.discovery';
  const found = await api.call('discoveryrule.get', {
    hostids: hostid,
    filter: { key_: key },
    output: ['itemid'],
  });
  const rule = {
    name: 'Ядро: фоновые задачи',
    preprocessing: [
      step(
        JS,
        "return JSON.stringify(JSON.parse(value).jobs.map(function (j) { return { '{#JOB}': j.name }; }));",
      ),
    ],
    lifetime: '7d',
  };
  const ruleid = found.length
    ? (await api.call('discoveryrule.update', { itemid: found[0].itemid, ...rule }),
      found[0].itemid)
    : (
        await api.call('discoveryrule.create', {
          hostid,
          key_: key,
          type: 18,
          master_itemid: masterid,
          ...rule,
        })
      ).itemids[0];

  const pick = (expr) =>
    `var j = JSON.parse(value).jobs.filter(function (x) { return x.name === '{#JOB}'; })[0]; if (!j) return 0; ${expr}`;
  const protos = [
    [
      'core.job.overdue[{#JOB}]',
      'Фоновая задача {#JOB}: просрочена',
      pick('return j.overdue ? 1 : 0;'),
    ],
    [
      'core.job.failures[{#JOB}]',
      'Фоновая задача {#JOB}: ошибок подряд',
      pick('return j.consecutiveFailures || 0;'),
    ],
    [
      'core.job.missed[{#JOB}]',
      'Фоновая задача {#JOB}: пропущено интервалов',
      pick(
        'if (!j.enabled || j.running || !j.lastStartedAt) return 0; var now = Date.parse(JSON.parse(value).now) || Date.now(); return Math.max(0, Math.floor((now - Date.parse(j.lastStartedAt)) / j.intervalMs) - 1);',
      ),
    ],
  ];
  for (const [k, name, js] of protos) {
    const ex = await api.call('itemprototype.get', {
      discoveryids: ruleid,
      filter: { key_: k },
      output: ['itemid'],
    });
    const body = {
      name,
      value_type: 3,
      history: '30d',
      trends: '730d',
      preprocessing: [step(JS, js, 2, '0')],
    };
    if (ex.length) await api.call('itemprototype.update', { itemid: ex[0].itemid, ...body });
    else
      await api.call('itemprototype.create', {
        ruleid,
        hostid,
        key_: k,
        type: 18,
        master_itemid: masterid,
        ...body,
      });
  }
  const H = HOST;
  const tps = [
    ['Фоновая задача {#JOB} просрочена', `last(/${H}/core.job.overdue[{#JOB}])=1`, 4],
    [
      'Фоновая задача {#JOB} ошибается подряд',
      `last(/${H}/core.job.failures[{#JOB}])>=${THRESHOLDS.jobFailuresWarn}`,
      2,
    ],
    [
      'Фоновая задача {#JOB} не запускается',
      `last(/${H}/core.job.missed[{#JOB}])>${THRESHOLDS.jobMissedIntervals}`,
      2,
    ],
  ];
  for (const [description, expression, priority] of tps) {
    const ex = await api.call('triggerprototype.get', {
      discoveryids: ruleid,
      filter: { description },
      output: ['triggerid'],
    });
    const body = { description, expression, priority, manual_close: 1 };
    if (ex.length)
      await api.call('triggerprototype.update', { triggerid: ex[0].triggerid, ...body });
    else await api.call('triggerprototype.create', body);
  }
}

/** Telegram, получатель и повторы тревог (8.5). */
async function notifications() {
  const token = env.BACKUP_TELEGRAM_BOT_TOKEN;
  const chat = env.BACKUP_TELEGRAM_CHAT_ID;
  const [mt] = await api.call('mediatype.get', {
    filter: { name: 'Telegram' },
    output: ['mediatypeid'],
    selectParameters: 'extend',
  });
  if (!token || !chat) {
    console.log('ВНИМАНИЕ: нет токена или чата Telegram в .env — тревоги не настроены');
    return;
  }
  await api.call('mediatype.update', {
    mediatypeid: mt.mediatypeid,
    status: 0,
    parameters: [
      { name: 'alert_message', value: '{ALERT.MESSAGE}' },
      { name: 'alert_subject', value: '{ALERT.SUBJECT}' },
      { name: 'api_chat_id', value: '{ALERT.SENDTO}' },
      { name: 'api_parse_mode', value: '' },
      { name: 'api_token', value: token },
      { name: 'event_nseverity', value: '{EVENT.NSEVERITY}' },
      { name: 'event_severity', value: '{EVENT.SEVERITY}' },
      { name: 'event_source', value: '{EVENT.SOURCE}' },
      { name: 'event_tags', value: '{EVENT.TAGSJSON}' },
      { name: 'event_update_nseverity', value: '{EVENT.UPDATE.NSEVERITY}' },
      { name: 'event_update_severity', value: '{EVENT.UPDATE.SEVERITY}' },
      { name: 'event_update_status', value: '{EVENT.UPDATE.STATUS}' },
      { name: 'event_value', value: '{EVENT.VALUE}' },
      { name: 'tls_verify', value: '1' },
    ],
    // Неудачную доставку Zabbix повторяет сам.
    maxattempts: 5,
    attempt_interval: '30s',
  });
  const [admin] = await api.call('user.get', { filter: { username: 'Admin' }, output: ['userid'] });
  await api.call('user.update', {
    userid: admin.userid,
    medias: [
      {
        mediatypeid: mt.mediatypeid,
        sendto: chat,
        active: 0,
        severity: 63,
        period: '1-7,00:00-24:00',
      },
    ],
  });

  const env_ = MODE === 'vps' ? 'VPS 5espace.com' : 'локальный стенд';
  const problem = {
    subject: '⚠️ {EVENT.SEVERITY}: {EVENT.NAME}',
    message:
      `Среда: ${env_}\nКомпонент: {ITEM.NAME1}\nЗначение: {ITEM.LASTVALUE1}\n` +
      'Начало: {EVENT.DATE} {EVENT.TIME} UTC\nПоследствие: {TRIGGER.DESCRIPTION}\nСобытие: {EVENT.ID}',
  };
  const recovery = {
    subject: '✅ Восстановлено: {EVENT.NAME}',
    message: `Среда: ${env_}\nДлительность: {EVENT.DURATION}\nЗначение: {ITEM.LASTVALUE1}\nСобытие: {EVENT.ID} — разбор остаётся за человеком.`,
  };
  const action = async (name, conditions, escPeriod) => {
    const op = {
      operationtype: 0,
      esc_step_from: 1,
      esc_step_to: 0,
      opmessage: { default_msg: 0, mediatypeid: mt.mediatypeid, ...problem },
      opmessage_usr: [{ userid: admin.userid }],
      // Повтор — пока проблему не приняли в работу (подтверждение в Zabbix).
      opconditions: [{ conditiontype: 14, operator: 0, value: '0' }],
    };
    const body = {
      name,
      eventsource: 0,
      status: 0,
      esc_period: escPeriod,
      pause_symptoms: 1,
      // evaltype 1 — строгое «И»: в режиме «И/ИЛИ» Zabbix объединяет условия
      // одного типа через ИЛИ, и «≥ предупреждение» ИЛИ «≤ средняя» пропускало всё.
      filter: { evaltype: 1, conditions },
      operations: [op],
      recovery_operations: [
        {
          operationtype: 0,
          opmessage: { default_msg: 0, mediatypeid: mt.mediatypeid, ...recovery },
          opmessage_usr: [{ userid: admin.userid }],
        },
      ],
    };
    const ex = await api.call('action.get', { filter: { name }, output: ['actionid'] });
    if (ex.length) await api.call('action.update', { actionid: ex[0].actionid, ...body });
    else await api.call('action.create', body);
  };
  // Критическая и высокая: повтор раз в 30 минут; предупреждение и средняя —
  // раз в 4 часа; информация — без сообщения (8.5).
  await action(
    '5Э: высокая и критическая — Telegram',
    [{ conditiontype: 4, operator: 5, value: '4' }],
    '30m',
  );
  await action(
    '5Э: предупреждение — Telegram',
    [
      { conditiontype: 4, operator: 5, value: '2' },
      { conditiontype: 4, operator: 6, value: '3' },
    ],
    '4h',
  );
}

/** Служебная учётка пульса: только чтение узла, токен API — в .env. */
async function pulseUser(groupid) {
  const ugroup = await api.upsert(
    'usergroup',
    'usrgrpid',
    { name: ['5Э пульс'] },
    { name: '5Э пульс', gui_access: 3, hostgroup_rights: [{ id: groupid, permission: 2 }] },
  );
  const [role] = await api.call('role.get', { filter: { name: 'User role' }, output: ['roleid'] });
  const userid = await api.upsert(
    'user',
    'userid',
    { username: ['5e-pulse'] },
    {
      username: '5e-pulse',
      roleid: role.roleid,
      usrgrps: [{ usrgrpid: ugroup }],
      passwd: randomBytes(24).toString('base64url') + 'aA1!',
    },
  );
  if (env.ZABBIX_PULSE_API_TOKEN) return;
  const ex = await api.call('token.get', {
    userids: userid,
    filter: { name: 'pulse' },
    output: ['tokenid'],
  });
  if (ex.length)
    await api.call(
      'token.delete',
      ex.map((t) => t.tokenid),
    );
  const { tokenids } = await api.call('token.create', { name: 'pulse', userid });
  const [{ token }] = await api.call('token.generate', tokenids);
  appendFileSync(ENV_PATH, `\nZABBIX_PULSE_API_TOKEN=${token}\n`);
  console.log('токен API пульса записан в .env (значение не выводится)');
}

async function status() {
  await login();
  const problems = await api.call('problem.get', {
    output: ['name', 'severity', 'clock'],
    sortfield: ['eventid'],
    sortorder: 'DESC',
  });
  console.log(`открытых проблем: ${problems.length}`);
  for (const p of problems) console.log(`  [${p.severity}] ${p.name}`);
  if (process.argv.includes('--items')) {
    for (const i of await peek(api, HOST)) {
      console.log(
        `  ${i.unsupported ? 'НЕ ПОДДЕРЖ.' : (i.ageSec ?? '—') + ' с'}  ${i.name} = ${i.unsupported ?? i.value}`,
      );
    }
  }
}

/**
 * Контрольный объект (M153): файл `control/probe-v1` в рабочем бакете и
 * запись с его размером и SHA-256. Содержимое — служебное, без реальных
 * данных. Повторный запуск при существующей записи ничего не меняет.
 */
async function controlInit() {
  const bucket = env.S3_BUCKET || 'unicorn-launch';
  const key = 'control/probe-v1';
  const psql = (sql) =>
    execFileSync(
      'docker',
      [
        'exec',
        '-i',
        'fifth-postgres',
        'psql',
        '-X',
        '-v',
        'ON_ERROR_STOP=1',
        '-At',
        '-U',
        'unicorn_owner',
        '-d',
        env.POSTGRES_DB || 'fifth_element',
      ],
      { input: sql, encoding: 'utf8' },
    ).trim();
  if (psql("SELECT count(*) FROM audit.control_objects WHERE name = 'probe'") === '1') {
    console.log('контрольный объект уже заведён');
    return;
  }
  const body = Buffer.concat([
    Buffer.from('5E control object v1 — служебный файл наблюдения, без пользовательских данных\n'),
    randomBytes(4096),
  ]);
  const sha256 = createHash('sha256').update(body).digest('hex');
  // Запись в рабочее хранилище (Garage, D-001) ключом приложения.
  const put = await s3Object(
    {
      endpoint: (env.S3_ENDPOINT || 'http://127.0.0.1:3900').replace(/\/+$/, ''),
      bucket,
      region: env.S3_REGION || 'us-east-1',
      accessKey: env.S3_ACCESS_KEY_ID,
      secretKey: env.S3_SECRET_ACCESS_KEY,
    },
    'PUT',
    key,
    body,
    { 'content-type': 'application/octet-stream' },
  );
  if (put.status !== 200) throw new Error(`контрольный объект не записан: HTTP ${put.status}`);
  psql(
    `INSERT INTO audit.control_objects (name, s3_key, size_bytes, sha256) VALUES ('probe', '${key}', ${body.length}, '${sha256}')`,
  );
  console.log(`контрольный объект заведён: ${key}, ${body.length} байт`);
}

/** Подтверждение наблюдения за OpenBao: элемент, триггер, свежее значение. Настройку не меняет. */
async function openbaoStatus() {
  await login();
  const item = (await peek(api, HOST)).find((i) => i.name.startsWith('OpenBao: работает'));
  const [trig] = await api.call('trigger.get', {
    host: HOST,
    output: ['status', 'value'],
    filter: { description: 'OpenBao запечатан или недоступен' },
  });
  console.log(item ? `элемент: ${item.ageSec ?? '—'} с, значение ${item.value}` : 'элемента нет');
  console.log(
    trig
      ? `триггер: включён ${trig.status === '0'}, тревога ${trig.value === '1'}`
      : 'триггера нет',
  );
  if (!item || !trig || item.unsupported || item.ageSec === null || item.ageSec > 300) {
    process.exitCode = 1;
  }
}

/** Наблюдённые пики за две недели: основа бюджета узла. */
async function peaks() {
  await login();
  const [host] = await api.call('host.get', { filter: { host: HOST }, output: ['hostid'] });
  const since = Math.floor(Date.now() / 1000) - 14 * 86400;
  for (const [label, key, field] of [
    ['минимум свободной памяти, %', 'vm.memory.size[pavailable]', 'value_min'],
    ['пик загрузки процессора, %', 'system.cpu.util', 'value_max'],
    ['минимум свободного места, %', 'vfs.fs.size[/rootfs,pfree]', 'value_min'],
  ]) {
    const items = await api.call('item.get', {
      hostids: host.hostid,
      filter: { key_: key },
      output: ['itemid'],
    });
    if (!items.length) {
      console.log(`${label}: нет элемента`);
      continue;
    }
    const rows = await api.call('trend.get', {
      itemids: [items[0].itemid],
      time_from: since,
      output: ['clock', field],
    });
    const values = rows.map((r) => Number(r[field]));
    const pick = field === 'value_min' ? Math.min(...values) : Math.max(...values);
    console.log(
      `${label}: ${values.length ? pick.toFixed(1) : 'нет данных'} (часов: ${values.length})`,
    );
  }
}

const commands = {
  configure,
  status,
  peaks,
  'control-init': controlInit,
  'openbao-status': openbaoStatus,
};
if (!commands[command]) {
  console.error('команды: configure, status, control-init, openbao-status');
  process.exit(2);
}
try {
  await commands[command]();
} catch (error) {
  console.error(`ОШИБКА: ${error.message}`);
  process.exit(1);
}

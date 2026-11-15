/**
 * Окружение узла (пакет «окружение узла», Тэнк 15.11): описание, опись и общая сверка.
 *
 * Описание — `infra/host/environment.json`: ОС и архитектура, источники пакетов, управляемые
 * компоненты с версиями и правилом совпадения, политика автообновлений. Утверждённое описание
 * (`status: approved`) — для новой установки и сверки; восстановление старой копии идёт по
 * описанию, сохранённому в ЕЁ архиве окружения, а не по текущему файлу из main.
 *
 * Правила совпадения:
 *   * ОС (ID, VERSION_ID) и архитектура — точно;
 *   * ядро не сравнивается: площадка WSL не обязана иметь ядро VPS; записывается для протокола;
 *   * `exact` — пакет поставщика (Docker, Caddy, NodeSource): ровно версия описания и источник;
 *   * `ubuntu-security` — пакет Ubuntu: та же версия программы, ревизия та же или новее
 *     (обновления безопасности Ubuntu допустимы); источник — архив Ubuntu.
 *
 * Состояния сверки: `ok`, `differ` (расходится), `missing` (нет пакета), `unverified` (состояние
 * определить не удалось — это НЕ совпадение). Сверка ничего не исправляет.
 */
import { readFileSync } from 'node:fs';

export const STATES = ['ok', 'differ', 'missing', 'unverified'];

/** Сравнение версий Debian (`dpkg --compare-versions`), чтобы сверка работала и без dpkg. */
export function compareDebVersions(a, b) {
  const split = (v) => {
    const m = String(v).match(/^(?:(\d+):)?(.*?)(?:-([^-]*))?$/);
    return { epoch: Number(m[1] ?? 0), upstream: m[2], revision: m[3] ?? '0' };
  };
  const order = (c) => {
    if (c === '~') return -1;
    if (c === undefined || c === '') return 0;
    if (/[A-Za-z]/.test(c)) return c.charCodeAt(0);
    return c.charCodeAt(0) + 256;
  };
  const part = (x, y) => {
    let i = 0;
    let j = 0;
    while (i < x.length || j < y.length) {
      let first = 0;
      while ((i < x.length && !/\d/.test(x[i])) || (j < y.length && !/\d/.test(y[j]))) {
        const ac = order(i < x.length && !/\d/.test(x[i]) ? x[i] : '');
        const bc = order(j < y.length && !/\d/.test(y[j]) ? y[j] : '');
        if (ac !== bc) return ac - bc;
        if (i < x.length && !/\d/.test(x[i])) i++;
        if (j < y.length && !/\d/.test(y[j])) j++;
      }
      while (x[i] === '0') i++;
      while (y[j] === '0') j++;
      while (i < x.length && /\d/.test(x[i]) && j < y.length && /\d/.test(y[j])) {
        if (!first) first = x.charCodeAt(i) - y.charCodeAt(j);
        i++;
        j++;
      }
      if (i < x.length && /\d/.test(x[i])) return 1;
      if (j < y.length && /\d/.test(y[j])) return -1;
      if (first) return first;
    }
    return 0;
  };
  const A = split(a);
  const B = split(b);
  if (A.epoch !== B.epoch) return A.epoch - B.epoch;
  return part(A.upstream, B.upstream) || part(A.revision, B.revision);
}

/** Версия программы без эпохи и ревизии Debian. */
export const upstreamOf = (v) =>
  String(v)
    .replace(/^\d+:/, '')
    .replace(/-[^-]*$/, '');

export function loadEnvironment(file) {
  const env = JSON.parse(readFileSync(file, 'utf8'));
  const problems = validateEnvironment(env);
  return { env, problems };
}

/** Структура описания; для утверждённого — ещё и полнота (пустых значений быть не может). */
export function validateEnvironment(env) {
  const p = [];
  if (env?.format !== 1) p.push('format: ожидается 1');
  if (!/^hostenv-[0-9a-z.-]+$/.test(env?.id ?? '')) p.push('id: hostenv-<…>');
  if (!['draft', 'approved'].includes(env?.status)) p.push('status: draft | approved');
  for (const k of ['id', 'versionId', 'arch'])
    if (env?.os?.[k] === undefined) p.push(`os.${k}: нет поля`);
  const sources = new Map((env?.sources ?? []).map((s) => [s.name, s]));
  for (const c of env?.components ?? []) {
    if (!['exact', 'ubuntu-security'].includes(c.match)) p.push(`${c.name}: match`);
    if (!sources.has(c.source)) p.push(`${c.name}: источник ${c.source} не описан`);
    if (!c.packages || !Object.keys(c.packages).length) p.push(`${c.name}: нет пакетов`);
  }
  if (env?.status === 'approved') {
    for (const gap of gapsOf(env)) p.push(`утверждённое описание неполно: ${gap}`);
    if (!env.approved?.by || !env.approved?.at) p.push('approved: кто и когда');
  }
  return p;
}

/** Неполные сведения описания: значения, которые опись не смогла определить (null). */
export function gapsOf(env) {
  const g = [];
  for (const k of ['id', 'versionId', 'arch'])
    if (env.os?.[k] === null) g.push(`ОС: ${k} не определено`);
  for (const s of env.sources ?? []) {
    if (s.name === 'ubuntu') continue;
    for (const k of ['uri', 'suite', 'components', 'keyFile', 'keyUrl', 'keyFingerprint'])
      if (s[k] === null || s[k] === undefined) g.push(`источник ${s.name}: ${k} не определено`);
  }
  for (const c of env.components ?? [])
    for (const [name, v] of Object.entries(c.packages ?? {}))
      if (v === null) g.push(`${c.name}: версия ${name} не определена`);
  if (env.security?.autoUpdates === null) g.push('политика автообновлений не определена');
  return g;
}

/**
 * Факты хоста из записи узла (`host.json` копии) или живого съёма: { os, arch, kernel,
 * versions(name→version|null), origins(name→[строки apt-cache policy]|null), holds|null }.
 */
export function factsOfHost(host) {
  const installed = host.environment?.installed;
  const versions = {};
  if (installed) for (const [n, v] of Object.entries(installed)) versions[n] = v.version;
  else for (const [n, v] of Object.entries(host.packages ?? {})) versions[n] = v;
  return {
    os: { id: host.os?.ID ?? null, versionId: host.os?.VERSION_ID ?? null },
    arch: host.arch ?? null,
    kernel: host.kernel ?? null,
    // Полный ли список пакетов: в старых записях (до 15.11) только выбранные — отсутствие
    // пакета в них не доказывает, что его нет.
    complete: Boolean(installed),
    versions,
    origins: host.environment?.origins ?? null,
    holds: host.environment?.holds ?? null,
    installedFrom: host.environment?.installedFrom ?? null,
  };
}

/** Метка происхождения узла (`/etc/fifth-install/host-env-origin.json`), пишет установка из архива. */
export const ORIGIN_MARK = '/etc/fifth-install/host-env-origin.json';

/**
 * Пакет поставлен из архива окружения? Метка сверяется: идентификатор = описание + 12 знаков
 * суммы archive.json, описание — то же, версия пакета — та, что поставил архив; если сверка
 * назвала архив (--from-archive) — он же. `confirmed` — подпись проверялась ключом, известным
 * независимо от копии.
 */
export function archiveOrigin(env, mark, name, have, expectId = null) {
  if (!mark) return { ok: false, why: 'источник не поставщика, метки архива окружения нет' };
  const [envId, short] = String(mark.archive ?? '').split(/\.(?=[0-9a-f]{12}$)/);
  if (!short || !String(mark.archiveSha256 ?? '').startsWith(short))
    return { ok: false, why: `метка архива: идентификатор ${mark.archive} не сходится с суммой` };
  if (envId !== env.id)
    return { ok: false, why: `метка архива ${mark.archive} — другое описание, не ${env.id}` };
  if (expectId && mark.archive !== expectId)
    return { ok: false, why: `метка архива ${mark.archive}, ожидался ${expectId}` };
  if (mark.packages?.[name] !== have)
    return {
      ok: false,
      why: `архив ${mark.archive} ставил ${mark.packages?.[name] ?? 'не этот пакет'}`,
    };
  return { ok: true, id: mark.archive, confirmed: mark.provenance === 'confirmed' };
}

/**
 * Сверка описания с фактами. Возвращает строки { subject, state, want, have, rule }.
 * `opts.holds` — проверять закрепление управляемых пакетов (на узле после применения плана).
 */
export function compareEnvironment(env, facts, opts = {}) {
  const out = [];
  const row = (subject, state, want, have, rule) => out.push({ subject, state, want, have, rule });
  const exact = (subject, want, have) =>
    row(
      subject,
      have === null || have === undefined ? 'unverified' : have === want ? 'ok' : 'differ',
      want,
      have ?? null,
      'точно',
    );
  exact('ОС', env.os.id, facts.os?.id);
  exact('версия ОС', env.os.versionId, facts.os?.versionId);
  exact('архитектура', env.os.arch, facts.arch);
  row(
    'ядро',
    'ok',
    'не сравнивается',
    facts.kernel ?? null,
    'ядро площадки может отличаться от узла',
  );

  const sources = new Map(env.sources.map((s) => [s.name, s]));
  for (const c of env.components) {
    const src = sources.get(c.source);
    for (const [name, want] of Object.entries(c.packages)) {
      const subject = `${c.name}: ${name}`;
      const have = facts.versions?.[name];
      if (want === null) {
        row(subject, 'unverified', null, have ?? null, 'версия в описании не определена');
        continue;
      }
      if (have === undefined) {
        row(
          subject,
          facts.complete ? 'missing' : 'unverified',
          want,
          null,
          facts.complete ? 'пакета нет' : 'в записи нет полного списка пакетов',
        );
        continue;
      }
      let ok;
      let rule;
      if (c.match === 'exact') {
        ok = have === want;
        rule = 'точно (пакет поставщика)';
      } else {
        ok = upstreamOf(have) === upstreamOf(want) && compareDebVersions(have, want) >= 0;
        rule = 'Ubuntu: та же версия программы, ревизия ≥';
      }
      if (!ok) {
        row(subject, 'differ', want, have, rule);
        continue;
      }
      // Источник установленной версии: только для пакетов поставщика, где подмена источника —
      // подмена программы. Не удалось определить — «не проверено», а не совпадение.
      if (c.match === 'exact' && src?.uri) {
        const lines = facts.origins?.[name];
        if (!lines) {
          row(`${subject} (источник)`, 'unverified', src.uri, null, 'источник версии не определён');
        } else if (lines.some((l) => l.includes(src.uri))) {
          row(`${subject} (источник)`, 'ok', src.uri, lines.join('; '), 'источник поставщика');
        } else {
          // Узел, поставленный из архива окружения (Тэнк 16.11): проверенный подписанный архив —
          // допустимый источник. Связь — метка происхождения (installedFrom), её идентификатор
          // сверяется с описанием и суммой archive.json; версия — та, что поставил архив.
          const from = archiveOrigin(env, facts.installedFrom, name, have, opts.archive);
          const onlyLocal = lines.every((l) => l.endsWith('/var/lib/dpkg/status'));
          if (from.ok && onlyLocal)
            row(
              `${subject} (источник)`,
              from.confirmed ? 'ok' : 'unverified',
              `${src.uri} или архив окружения`,
              `архив ${from.id}`,
              from.confirmed
                ? 'подписанный архив окружения'
                : 'архив окружения: происхождение не подтверждено',
            );
          else
            row(
              `${subject} (источник)`,
              'differ',
              `${src.uri} или архив окружения`,
              lines.join('; '),
              from.ok ? 'есть посторонний источник версии' : from.why,
            );
        }
      }
      row(subject, 'ok', want, have, rule);
    }
  }
  if (opts.holds) {
    const managed = env.components
      .filter((c) => c.match === 'exact')
      .flatMap((c) => Object.keys(c.packages));
    for (const name of managed) {
      if (facts.holds === null || facts.holds === undefined)
        row(`закрепление ${name}`, 'unverified', 'hold', null, 'apt-mark showhold недоступен');
      else
        row(
          `закрепление ${name}`,
          facts.holds.includes(name) ? 'ok' : 'differ',
          'hold',
          facts.holds.includes(name) ? 'hold' : 'нет',
          'управляемый пакет закреплён',
        );
    }
  }
  return out;
}

/** Итог: совпадение — только если все строки `ok`; «не проверено» отделено от расхождения. */
export function summarize(rows) {
  const count = Object.fromEntries(
    STATES.map((s) => [s, rows.filter((r) => r.state === s).length]),
  );
  const verdict = count.differ || count.missing ? 'differ' : count.unverified ? 'unverified' : 'ok';
  return { verdict, count };
}

/**
 * Опись по записи узла: черновик описания (status: draft) и список неполных сведений.
 * Ничего не утверждает и не угадывает: чего нет в записи — null.
 */
export function inventoryOfHost(host, { id, files = {}, fingerprints = {} } = {}) {
  const f = factsOfHost(host);
  const sources = [
    {
      name: 'ubuntu',
      uri: 'http://archive.ubuntu.com/ubuntu',
      suite: null,
      keyFile: null,
      keyFingerprint: null,
    },
  ];
  // keyUrl — адрес, где поставщик публикует ключ (для сборки архива); ключ принимается только
  // при совпадении отпечатка с ключом узла, поэтому адрес не заменяет сверку.
  const vendor = (name, uriRe, keyUrl) => {
    const listed = Object.entries(files).find(
      ([p, t]) => p.startsWith('/etc/apt/sources.list.d/') && t && uriRe.test(t),
    );
    const text = listed?.[1] ?? '';
    const uri = (text.match(uriRe) ?? [])[0] ?? null;
    const deb = text.match(/^\s*deb\s+(?:\[[^\]]*\]\s+)?\S+\s+(\S+)\s*(.*)$/m);
    const suite = deb?.[1] ?? text.match(/^Suites:\s*(\S+)/m)?.[1] ?? null;
    const comps = (deb?.[2] ?? text.match(/^Components:\s*(.+)$/m)?.[1] ?? '').trim();
    const keyFile =
      (text.match(/signed-by=([^\]\s]+)/) ?? text.match(/^Signed-By:\s*(\S+)/m) ?? [])[1] ?? null;
    return {
      name,
      file: listed?.[0] ?? null,
      uri,
      suite,
      components: comps ? comps.split(/\s+/) : null,
      keyFile,
      keyUrl,
      keyFingerprint: (keyFile && fingerprints[keyFile]) || null,
    };
  };
  sources.push(
    vendor(
      'docker',
      /https:\/\/download\.docker\.com\/linux\/ubuntu/,
      'https://download.docker.com/linux/ubuntu/gpg',
    ),
  );
  sources.push(
    vendor(
      'caddy',
      /https:\/\/dl\.cloudsmith\.io\/public\/caddy\/stable\/deb\/debian/,
      'https://dl.cloudsmith.io/public/caddy/stable/gpg.key',
    ),
  );
  sources.push(
    vendor(
      'nodesource',
      /https:\/\/deb\.nodesource\.com\/node_\d+\.x/,
      'https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key',
    ),
  );
  const v = (n) => f.versions[n] ?? null;
  const env = {
    format: 1,
    id,
    status: 'draft',
    approved: null,
    os: { id: f.os.id, versionId: f.os.versionId, arch: f.arch },
    kernel: { compare: false, recorded: f.kernel },
    sources,
    components: [
      {
        name: 'Docker Engine',
        source: 'docker',
        match: 'exact',
        packages: {
          'docker-ce': v('docker-ce'),
          'docker-ce-cli': v('docker-ce-cli'),
          'containerd.io': v('containerd.io'),
          'docker-compose-plugin': v('docker-compose-plugin'),
          'docker-buildx-plugin': v('docker-buildx-plugin'),
        },
      },
      { name: 'Caddy', source: 'caddy', match: 'exact', packages: { caddy: v('caddy') } },
      { name: 'Node.js', source: 'nodesource', match: 'exact', packages: { nodejs: v('nodejs') } },
      {
        name: 'Системные программы Ubuntu',
        source: 'ubuntu',
        match: 'ubuntu-security',
        packages: { git: v('git'), gnupg: v('gnupg'), 'openssh-server': v('openssh-server') },
      },
    ],
    security: { autoUpdates: null, excludeManaged: true },
  };
  return { env, gaps: gapsOf(env) };
}

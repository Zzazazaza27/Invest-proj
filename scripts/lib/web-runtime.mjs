/**
 * Серверная часть образа web и её эквивалентность (Тэнк 13.11, перезапуски при выпуске).
 *
 * На слотах статика сборки подключается отдельно (release/static/<сборка>, маршрут nginx), а от
 * образа web работает только nginx: базовый образ, конфигурация, скрипты запуска, проверка
 * здоровья и прочие настройки финального образа. Если у кандидата эта часть та же, что у
 * запущенного web, — web не пересоздаётся.
 *
 * Сумма серверной части считается в CI по финальной стадии web.Dockerfile и пишется меткой
 * образа `fifth.web.runtime`. При выпуске эквивалентность доказывается двумя сведениями из самих
 * образов: метки равны и непусты, и настройки образа (Config: Env, Cmd, Entrypoint, Healthcheck,
 * порты, пользователь, каталог, сигнал остановки, тома, ОС и архитектура) совпадают. Нет метки
 * или что-то не сошлось — не эквивалентны: обычное сравнение образов и пересоздание.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const WEB_RUNTIME_LABEL = 'fifth.web.runtime';

/** Инструкции Dockerfile: продолжения строк склеены, комментарии убраны. */
function instructions(text) {
  const out = [];
  let cur = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!cur && (line === '' || line.startsWith('#'))) continue;
    if (line.startsWith('#')) continue;
    if (line.endsWith('\\')) {
      cur += `${line.slice(0, -1).trim()} `;
      continue;
    }
    out.push((cur + line).replace(/\s+/g, ' ').trim());
    cur = '';
  }
  if (cur.trim()) out.push(cur.replace(/\s+/g, ' ').trim());
  return out.filter(Boolean);
}

function hashPath(h, root, rel) {
  const full = join(root, rel);
  if (!existsSync(full)) throw new Error(`web: нет ${rel}`);
  if (statSync(full).isDirectory()) {
    for (const name of readdirSync(full).sort()) hashPath(h, root, `${rel}/${name}`);
    return;
  }
  h.update(`file ${rel}\n`);
  h.update(readFileSync(full));
  h.update('\n');
}

/**
 * Сумма серверной части web по финальной стадии Dockerfile. Статика (`COPY --from=build … /srv/…`)
 * не входит — на слотах она подключается отдельно. Всё остальное входит: базовый образ (только по
 * дайджесту), каждая инструкция и содержимое каждого файла из контекста. Незнакомое копирование
 * из другой стадии — отказ: такой состав сумма не описывает.
 */
export function webRuntimeSum(root, dockerfile = 'infra/images/web.Dockerfile') {
  const all = instructions(readFileSync(join(root, dockerfile), 'utf8'));
  const start = all.map((s) => /^FROM\s/i.test(s)).lastIndexOf(true);
  if (start < 0) throw new Error('web: нет FROM');
  const stage = all.slice(start);
  if (!/^FROM\s+\S+@sha256:[0-9a-f]{64}(\s|$)/i.test(stage[0]))
    throw new Error('web: базовый образ финальной стадии не закреплён дайджестом');
  const h = createHash('sha256');
  h.update('fifth-web-runtime/1\n');
  for (const ins of stage) {
    const copy = /^(COPY|ADD)\s+(.*)$/i.exec(ins);
    if (!copy) {
      h.update(`${ins}\n`);
      continue;
    }
    const words = copy[2].split(' ');
    const opts = words.filter((w) => w.startsWith('--'));
    const paths = words.filter((w) => !w.startsWith('--'));
    const from = opts.find((o) => o.startsWith('--from='));
    const dest = paths.at(-1);
    if (from) {
      if (from === '--from=build' && dest.startsWith('/srv/')) continue;
      throw new Error(`web: копирование из другой стадии вне статики: ${ins}`);
    }
    h.update(`${ins}\n`);
    for (const src of paths.slice(0, -1)) hashPath(h, root, src);
  }
  return h.digest('hex');
}

const dockerEnv = { ...process.env, MSYS_NO_PATHCONV: '1' };

/** Сведения образа: идентификатор, метка серверной части, нормализованные настройки. */
export function imageFacts(ref, env = dockerEnv) {
  const r = spawnSync('docker', ['image', 'inspect', ref, '--format', '{{json .}}'], {
    encoding: 'utf8',
    env,
  });
  if (r.status !== 0) return null;
  const img = JSON.parse(r.stdout);
  const c = img.Config ?? {};
  const keys = (o) => Object.keys(o ?? {}).sort();
  return {
    id: img.Id,
    label: c.Labels?.[WEB_RUNTIME_LABEL] ?? null,
    config: {
      os: img.Os,
      arch: img.Architecture,
      variant: img.Variant ?? null,
      user: c.User ?? '',
      env: [...(c.Env ?? [])].sort(),
      cmd: c.Cmd ?? null,
      entrypoint: c.Entrypoint ?? null,
      healthcheck: c.Healthcheck ?? null,
      ports: keys(c.ExposedPorts),
      workdir: c.WorkingDir ?? '',
      stopSignal: c.StopSignal ?? null,
      volumes: keys(c.Volumes),
      onBuild: c.OnBuild ?? null,
      shell: c.Shell ?? null,
    },
  };
}

/**
 * Можно ли оставить запущенный web вместо образа кандидата. `same` — это тот же образ;
 * `equivalent` — другой образ с той же серверной частью (метка и настройки), иначе reason.
 */
export function webEquivalence(running, candidate, env = dockerEnv) {
  const a = imageFacts(running, env);
  const b = imageFacts(candidate, env);
  if (!a || !b) return { same: false, equivalent: false, reason: 'образ не прочитан' };
  if (a.id === b.id) return { same: true, equivalent: true, running: a.id, candidate: b.id };
  const base = { same: false, equivalent: false, running: a.id, candidate: b.id };
  if (!a.label) return { ...base, reason: 'у запущенного web нет метки серверной части' };
  if (!b.label) return { ...base, reason: 'у web кандидата нет метки серверной части' };
  if (a.label !== b.label) return { ...base, reason: 'серверная часть web изменилась' };
  const diff = Object.keys(a.config).filter(
    (k) => JSON.stringify(a.config[k]) !== JSON.stringify(b.config[k]),
  );
  if (diff.length)
    return { ...base, reason: `настройки образа web различаются: ${diff.join(', ')}` };
  return { ...base, equivalent: true, label: a.label };
}

/**
 * Статика сборки подключена: маршрут nginx ведёт на её каталог, каталог на месте, и web
 * отдаёт именно этот lab/index.html.
 */
export function staticConnected({ routeFile, staticDir, build, webContainer, env = dockerEnv }) {
  const route = existsSync(routeFile) ? readFileSync(routeFile, 'utf8') : '';
  const want = `set $static_root /srv/static/${build};`;
  if (!route.includes(want)) return { ok: false, reason: `маршрут nginx не на статике ${build}` };
  const file = join(staticDir, build, 'lab', 'index.html');
  if (!existsSync(file)) return { ok: false, reason: `нет статики ${build}` };
  const r = spawnSync(
    'docker',
    ['exec', webContainer, 'wget', '-q', '-O-', 'http://127.0.0.1/lab/'],
    { encoding: 'utf8', env, timeout: 15_000 },
  );
  if (r.status !== 0) return { ok: false, reason: 'web не отдал /lab/' };
  // Тестовые среды вставляют плашку среды перед </body> (web-banner.sh, sub_filter) — её
  // убираем; остальное должно совпасть с файлом сборки байт в байт.
  const served = r.stdout.replace(/<details data-env-banner[\s\S]*?<\/details>(?=<\/body>)/, '');
  if (served !== readFileSync(file, 'utf8'))
    return { ok: false, reason: `web отдаёт не статику ${build}` };
  return { ok: true };
}

/**
 * План перезапусков выпуска (Тэнк 13.11): что пересоздаётся и можно ли называть выпуск
 * выпуском без простоя. База с новым образом и единственный web — возможный простой.
 */
export function companionPlan({ slots, web, postgres }) {
  const steps = [];
  const warnings = [];
  if (postgres.restart) {
    steps.push('postgres: новый образ — перезапуск базы');
    warnings.push('перезапуск базы — возможен простой');
  } else steps.push('postgres: образ тот же — без перезапуска');
  if (web.recreate) {
    steps.push(`web: пересоздание (${web.reason})`);
    warnings.push('пересоздание единственного web — возможен короткий перерыв');
  } else
    steps.push(
      web.same
        ? 'web: образ тот же — без пересоздания'
        : 'web: прежний образ, серверная часть эквивалентна кандидату, подключается новая статика',
    );
  return {
    slots,
    steps,
    warnings,
    zeroDowntime: slots && warnings.length === 0,
    summary: !slots
      ? 'выпуск с остановкой ядра — не без простоя'
      : warnings.length
        ? `НЕ без простоя: ${warnings.join('; ')}`
        : 'без простоя: база и web не перезапускаются',
  };
}

#!/usr/bin/env node
/**
 * Давление на диск и память в изолированной среде (работа № 4 раздела 01; 06 Load «Место на
 * диске», 6.4, таблица отказов «Давление на диск или память»).
 *
 * Своя среда `fifth-faults-*`; «диск» узлов Garage — том в памяти 64 МБ (заполняется за
 * секунды, общий диск машины не трогается). Служба хоста — настоящий scripts/disk-guard.mjs,
 * база — этой среды. Сценарии:
 *
 *   ДИСК
 *   1. ниже 70 % — служба ничего не вводит, «Файлы» доступны;
 *   2. ≥ 85 % — «Файлы» только чтение с причиной capacity_limit: новая загрузка отклонена,
 *      прежний файл читается; событие журнала с измерением; уровень critical в файле состояния;
 *   3. между порогами (80–85 %) — ограничение держится (без дребезга);
 *   4. ниже 80 % — снято само, событие снятия; загрузка снова проходит;
 *   5. диск заполнен до конца БЕЗ службы — Garage отказывает, материал не готов, запись «Файлов»
 *      закрыта проверкой зависимости, прежнее читается, ничего не удалено; место освободили —
 *      работа продолжается;
 *   6. прогноз исчерпания (наклон по образцам) — расчёт службы;
 *   ПАМЯТЬ
 *   7. ядро с пределом 320 МБ под параллельным чтением крупного файла: процесс либо выдерживает,
 *      либо убивается по пределу и поднимается политикой перезапуска; после — готов, данные
 *      целы, принятая до нагрузки загрузка завершается, дублей нет, память возвращается.
 *
 *   node scripts/check-resource-pressure.mjs [--keep]
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as F from './lib/faults-env.mjs';
import { forecastHours } from './disk-guard.mjs';

const { check, note, state } = F.checker();
const stateDir = mkdtempSync(join(tmpdir(), 'fifth-faults-guard-'));
const sha = (b) => createHash('sha256').update(b).digest('hex');

function guard() {
  const r = spawnSync(
    process.execPath,
    [
      'scripts/disk-guard.mjs',
      '--container',
      F.DISK,
      '--path',
      '/data',
      '--targets',
      `pg=${F.PG}:unicorn_owner`,
      '--state-dir',
      stateDir,
    ],
    { cwd: F.ROOT, encoding: 'utf8', timeout: 60_000 },
  );
  try {
    return JSON.parse(readFileSync(join(stateDir, 'disk-guard.json'), 'utf8'));
  } catch {
    return { error: (r.stderr || r.stdout).slice(0, 300) };
  }
}
function usedPct() {
  const cols = F.docker('exec', F.DISK, 'df', '-P', '-k', '/data')
    .stdout.trim()
    .split('\n')
    .at(-1)
    .split(/\s+/);
  return (Number(cols[2]) / (Number(cols[2]) + Number(cols[3]))) * 100;
}
/** Довести занятость до `pct` балластом рядом с данными (не трогая данных Garage). */
function fillTo(pct) {
  F.docker('exec', F.DISK, 'rm', '-f', '/data/ballast', '/data2/ballast', '/data3/ballast');
  const cols = F.docker('exec', F.DISK, 'df', '-P', '-k', '/data')
    .stdout.trim()
    .split('\n')
    .at(-1)
    .split(/\s+/);
  const used = Number(cols[2]);
  const total = used + Number(cols[3]);
  const needKb = Math.max(0, Math.ceil((total * pct) / 100) - used);
  if (pct >= 100) {
    F.docker(
      'exec',
      F.DISK,
      'sh',
      '-c',
      // На VPS три узла — один диск: заполняются тома всех узлов.
      'for d in /data /data2 /data3; do dd if=/dev/zero of=$d/ballast bs=64k 2>/dev/null; done; true',
    );
  } else if (needKb > 0) {
    F.docker('exec', F.DISK, 'dd', 'if=/dev/zero', 'of=/data/ballast', 'bs=1k', `count=${needKb}`);
  }
  return usedPct();
}
async function files(client) {
  return (await client.call('/v1/features')).json?.groups?.files;
}
async function waitFiles(client, predicate, seconds = 30) {
  let s;
  for (let i = 0; i < seconds; i++) {
    s = await files(client);
    if (s && predicate(s)) return s;
    await F.sleep(1000);
  }
  return s;
}
async function upload(f, label, size = 64 * 1024) {
  const bytes = F.pdf(label, size);
  const t = await F.uploadTicket(f.client, f.projectId, bytes, label);
  if (t.status !== 201) return { ticket: t, bytes };
  const post = await F.postForm(t.json, bytes);
  const fin = await F.finalize(f.client, f.projectId, t.json.materialId);
  return { ticket: t, bytes, post, fin, id: t.json.materialId };
}
const read = (f, id) => f.client.call(`/v1/projects/${f.projectId}/materials/${id}/content`);
const materialState = async (id) =>
  (await F.sql('SELECT upload_state FROM lab.project_materials WHERE id = $1', [id]))[0]
    ?.upload_state;
const events = async (verb) =>
  (
    await F.sql('SELECT context_jsonb AS c FROM audit.events WHERE verb = $1 ORDER BY ts', [verb])
  ).map((r) => r.c);
const containerMem = () => {
  const r = F.docker('stats', '--no-stream', '--format', '{{.MemUsage}}', F.CORE).stdout.trim();
  const m = r.match(/^([\d.]+)\s*([KMG]i?B)/);
  if (!m) return NaN;
  const mult = { KiB: 1 / 1024, MiB: 1, GiB: 1024, KB: 1 / 1000, MB: 1, GB: 1000 }[m[2]] ?? 1;
  return Number(m[1]) * mult;
};
const inspect = () => {
  const r = F.docker(
    'inspect',
    '-f',
    '{{.State.OOMKilled}} {{.RestartCount}} {{.State.Running}}',
    F.CORE,
  )
    .stdout.trim()
    .split(' ');
  return { oom: r[0] === 'true', restarts: Number(r[1]), running: r[2] === 'true' };
};

const keep = process.argv.includes('--keep');
console.log('\n=== ДИСК И ПАМЯТЬ (работа № 4) — изолированная среда ===\n');
try {
  await F.up({
    garageDataTmpfs: '64m',
    coreMem: '320m',
    coreEnv: { RATE_LIMIT_DEFAULT_PER_MIN: '100000', RATE_LIMIT_IP_CEILING_PER_MIN: '100000' },
  });
  const f = await F.founderWithProject('pressure');
  const base = await upload(f, 'base');
  check('исходная загрузка готова', base.fin?.json?.uploadState === 'ready');

  // ---- 1. ниже порога
  console.log('\n— ДИСК 1. ниже 70 %');
  const g0 = guard();
  check(
    'служба: уровень ok, ограничения нет',
    g0.level === 'ok' && g0.targets?.[`pg=${F.PG}:unicorn_owner`] === 'none',
    JSON.stringify(g0),
  );

  // ---- 2. ≥ 85 %
  console.log('\n— ДИСК 2. занято ≥ 85 %');
  const p2 = fillTo(87);
  const g1 = guard();
  check(
    'служба ввела ограничение (set), уровень critical',
    g1.level === 'critical' && Object.values(g1.targets ?? {})[0] === 'set',
    `занято ${p2.toFixed(1)} %; ${JSON.stringify(g1.targets)}`,
  );
  const ro = await waitFiles(f.client, (s) => !s.write.allowed, 15);
  check(
    '«Файлы»: только чтение, причина capacity_limit',
    ro?.state === 'read_only' && ro.write.reason === 'capacity_limit',
    `${ro?.state} / ${ro?.write?.reason}`,
  );
  const denied = await F.uploadTicket(f.client, f.projectId, F.pdf('denied'), 'denied');
  check(
    'новая загрузка отклонена group_unavailable / capacity_limit',
    denied.status === 503 && JSON.stringify(denied.json).includes('capacity_limit'),
    `HTTP ${denied.status}`,
  );
  check('прежний файл читается', (await read(f, base.id)).raw.equals(base.bytes));
  const setEv = await events('ops.function_restriction.auto_set');
  check(
    'событие журнала: введено, с измерением и основанием',
    setEv.length === 1 &&
      setEv[0].usedPct >= 85 &&
      setEv[0].actor?.basis?.name === 'host.disk-guard',
    JSON.stringify(setEv[0] ?? {}).slice(0, 160),
  );
  const again = guard();
  check(
    'повторный отчёт не вводит второй раз (kept)',
    Object.values(again.targets ?? {})[0] === 'kept' &&
      (await events('ops.function_restriction.auto_set')).length === 1,
  );

  // ---- 3. между порогами
  console.log('\n— ДИСК 3. между 80 и 85 %');
  const p3 = fillTo(82);
  const g2 = guard();
  check(
    'ограничение держится (kept)',
    Object.values(g2.targets ?? {})[0] === 'kept',
    `занято ${p3.toFixed(1)} %`,
  );
  check('«Файлы» всё ещё только чтение', (await files(f.client))?.write?.allowed === false);

  // ---- 4. ниже 80 %
  console.log('\n— ДИСК 4. ниже 80 %');
  const p4 = fillTo(60);
  const g3 = guard();
  check(
    'ограничение снято само (cleared)',
    Object.values(g3.targets ?? {})[0] === 'cleared',
    `занято ${p4.toFixed(1)} %`,
  );
  check(
    'событие снятия записано',
    (await events('ops.function_restriction.auto_cleared')).length === 1,
  );
  await waitFiles(f.client, (s) => s.write.allowed, 15);
  const after = await upload(f, 'after');
  check('загрузка снова проходит', after.fin?.json?.uploadState === 'ready');

  // ---- 5. диск до конца без службы
  console.log('\n— ДИСК 5. заполнен до конца, служба не работает');
  const materialsBefore = Number(
    (
      await F.sql('SELECT count(*) FROM lab.project_materials WHERE project_id = $1', [f.projectId])
    )[0].count,
  );
  const full = fillTo(100);
  note(`занято ${full.toFixed(1)} %`);
  const big = await upload(f, 'full', 2 * 1024 * 1024);
  check(
    'передача на полный диск не дала готового материала',
    !big.id || (await materialState(big.id)) !== 'ready',
    `форма ${big.post?.status} ${big.post?.text?.match(/<Code>([^<]+)/)?.[1] ?? ''}, завершение ${big.fin?.status}`,
  );
  const closed = await waitFiles(f.client, (s) => !s.write.allowed, 40);
  note(`«Файлы» на полном диске: ${closed?.state} / ${closed?.write?.reason}`);
  check(
    'прежние файлы читаются на полном диске',
    (await read(f, base.id)).raw.equals(base.bytes) &&
      (await read(f, after.id)).raw.equals(after.bytes),
  );
  check(
    'ничего не удалено: записи материалов на месте',
    Number(
      (
        await F.sql(
          'SELECT count(*) FROM lab.project_materials WHERE project_id = $1 AND upload_state = $2',
          [f.projectId, 'ready'],
        )
      )[0].count,
    ) >= 2 &&
      Number(
        (
          await F.sql('SELECT count(*) FROM lab.project_materials WHERE project_id = $1', [
            f.projectId,
          ])
        )[0].count,
      ) >= materialsBefore,
  );
  fillTo(50);
  const reopened = await waitFiles(f.client, (s) => s.write.allowed, 60);
  check(
    'место освободили — запись открыта без вмешательства',
    reopened?.write?.allowed === true,
    reopened?.state,
  );
  const post = await upload(f, 'post-full');
  check('загрузка после освобождения проходит', post.fin?.json?.uploadState === 'ready');

  // ---- 6. прогноз
  console.log('\n— ДИСК 6. прогноз исчерпания');
  const h = 3600_000;
  const grow = Array.from({ length: 7 }, (_, i) => ({ t: i * 10 * 60_000, used: 1e9 + i * 1e8 }));
  check(
    'рост 600 МБ/ч при 10 ГБ свободно — прогноз ≈ 16,7 ч (< 24 → критическое)',
    Math.abs(forecastHours(grow, 10e9) - 16.7) < 0.2,
    String(forecastHours(grow, 10e9)),
  );
  check(
    'мало образцов или короткий размах — прогноза нет',
    forecastHours(grow.slice(0, 3), 1e9) === null &&
      forecastHours(
        grow.map((s, i) => ({ ...s, t: i * 1000 })),
        1e9,
      ) === null,
  );
  check(
    'место не растёт — прогноза нет',
    forecastHours(
      grow.map((s) => ({ ...s, used: 1e9 })),
      1e9,
    ) === null,
  );
  void h;

  // ---- 7. память
  console.log('\n— ПАМЯТЬ 7. ядро с пределом 320 МБ под нагрузкой');
  const heavy = await upload(f, 'heavy', 8 * 1024 * 1024);
  check('крупный файл (8 МБ) загружен', heavy.fin?.json?.uploadState === 'ready');
  const pendingBytes = F.pdf('pending', 64 * 1024);
  const pendingT = await F.uploadTicket(f.client, f.projectId, pendingBytes, 'pending');
  await F.postForm(pendingT.json, pendingBytes);
  const readyBefore = Number(
    (
      await F.sql(
        "SELECT count(*) FROM lab.project_materials WHERE project_id = $1 AND upload_state = 'ready'",
        [f.projectId],
      )
    )[0].count,
  );
  const idle = containerMem();
  const s0 = inspect();
  const results = await Promise.all(
    Array.from({ length: 80 }, () =>
      f.client.call(`/v1/projects/${f.projectId}/materials/${heavy.id}/content`, {
        timeout: 90_000,
      }),
    ),
  );
  const byStatus = {};
  for (const r of results)
    byStatus[r.status || r.error || 0] = (byStatus[r.status || r.error || 0] ?? 0) + 1;
  const s1 = inspect();
  const crashLog = F.docker('logs', '--since', '3m', F.CORE);
  const why = `${crashLog.stdout}${crashLog.stderr}`.match(
    /core-start: ядро вышло[^"\n]{0,80}|heap out of memory|Reached heap limit|ENOMEM/,
  )?.[0];
  note(
    `80 параллельных чтений 8 МБ: ${JSON.stringify(byStatus)}; память до ${idle.toFixed(0)} МБ; ` +
      `убит по пределу: ${s1.oom}; перезапусков: ${s1.restarts - s0.restarts}; причина в журнале: ${why ?? 'не найдена'}`,
  );
  const served = results.filter((r) => r.status === 200);
  check(
    'отданное — целое (ни одного обрезанного ответа 200)',
    served.every((r) => sha(r.raw) === sha(heavy.bytes)),
    `${served.length} из 80`,
  );
  await F.waitCore(150_000);
  check('ядро готово после нагрузки (само или после перезапуска политикой)', inspect().running);
  check(
    'принятая до нагрузки загрузка завершается после',
    (await F.finalize(f.client, f.projectId, pendingT.json.materialId)).json?.uploadState ===
      'ready' || (await materialState(pendingT.json.materialId)) === 'ready',
  );
  const readyAfter = Number(
    (
      await F.sql(
        "SELECT count(*) FROM lab.project_materials WHERE project_id = $1 AND upload_state = 'ready'",
        [f.projectId],
      )
    )[0].count,
  );
  check(
    'данные целы, дублей нет: готовых ровно на одну больше',
    readyAfter === readyBefore + 1,
    `${readyBefore} → ${readyAfter}`,
  );
  check('крупный файл читается целым', sha((await read(f, heavy.id)).raw) === sha(heavy.bytes));
  let settled = NaN;
  for (let i = 0; i < 30; i++) {
    settled = containerMem();
    if (settled < 0.75 * 320) break;
    await F.sleep(2000);
  }
  check(
    'память вернулась ниже 75 % предела — бесконечной очереди и удержания нет',
    settled < 0.75 * 320,
    `${settled.toFixed(0)} МБ`,
  );
} catch (e) {
  check('прогон без исключения', false, String(e?.stack ?? e).slice(0, 600));
} finally {
  await F.closeSql();
  if (!keep) F.down();
  rmSync(stateDir, { recursive: true, force: true });
}
const file = F.writeReport('pressure', state);
console.log(`\nИтог: ${state.passed} OK, ${state.failed} FAIL. Протокол: ${file}`);
process.exitCode = state.failed ? 1 : 0;

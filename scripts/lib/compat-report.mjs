/**
 * Отчёт совместимости пары комплектов как основание точки возврата (блок 09, задание 2;
 * Тэнк 09.11). Годится, только если:
 *  - подписан CI (подпись на весь файл, своя метка домена) и подпись проверяется закреплённым
 *    ключом узла — тем же, что у комплектов (`<etc>/kit-signing.pub`);
 *  - описывает именно эту пару комплектов (`kitId` обоих — неизменяемые признаки комплекта:
 *    дайджесты образов, коммит, хеши Compose и миграций; хеш `images.tar` для этого не годится —
 *    файл собирается заново на каждой машине, и у CI и узла он разный).
 * Иначе — `unsigned`, `bad-signature` или `stale` — и основанием возврата не служит.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compatSignatureValid } from './kit-sign.mjs';

/** Неизменяемый признак комплекта: одинаков у CI и на узле для одного и того же комплекта. */
export function kitId(kit) {
  const images = Object.fromEntries(
    Object.entries(kit.images ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, v]) => [name, v?.digest ?? v?.imageId ?? null]),
  );
  const body = {
    build: kit.build ?? null,
    commit: kit.commit ?? null,
    images,
    compose: kit.compose?.sha256 ?? null,
    prodCompose: kit.prodCompose ?? null,
    migrations: (kit.migrations ?? []).map((m) => `${m.id}:${m.sha256}`),
  };
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

export function readCompatReport({ kitsDir, etcDir, candidate, previous, kitIdOf }) {
  const file = join(kitsDir, candidate, `compat-${previous}.json`);
  if (!existsSync(file)) return null;
  const bytes = readFileSync(file);
  const pubFile = join(etcDir, 'kit-signing.pub');
  const sigFile = `${file}.sig`;
  if (!existsSync(pubFile)) return { result: 'unsigned', detail: 'нет закреплённого ключа узла' };
  if (!existsSync(sigFile)) return { result: 'unsigned', detail: 'отчёт без подписи' };
  if (!compatSignatureValid(bytes, readFileSync(sigFile, 'utf8'), readFileSync(pubFile, 'utf8'))) {
    return { result: 'bad-signature', detail: 'подпись отчёта не сходится' };
  }
  let report;
  try {
    report = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { result: 'bad-signature', detail: 'отчёт не разбирается' };
  }
  const same =
    Boolean(report.candidate?.kitId) &&
    report.candidate.kitId === kitIdOf(candidate) &&
    report.previous?.kitId === kitIdOf(previous);
  return same ? report : { ...report, result: 'stale' };
}

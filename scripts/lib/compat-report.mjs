/**
 * Отчёт совместимости пары комплектов как основание точки возврата (блок 09, задание 2;
 * Тэнк 09.11). Годится, только если:
 *  - подписан CI (подпись на весь файл, своя метка домена) и подпись проверяется закреплённым
 *    ключом узла — тем же, что у комплектов (`<etc>/kit-signing.pub`);
 *  - описывает именно эту пару комплектов (хеши обоих).
 * Иначе — `unsigned`, `bad-signature` или `stale` — и основанием возврата не служит.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compatSignatureValid } from './kit-sign.mjs';

export function readCompatReport({ kitsDir, etcDir, candidate, previous, kitSha }) {
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
    report.candidate?.kitSha256 === kitSha(candidate) &&
    report.previous?.kitSha256 === kitSha(previous);
  return same ? report : { ...report, result: 'stale' };
}

/**
 * Независимая выгрузка журнала аудита (2.1.5; согласовано Тэнком 09.11.2026).
 *
 * Порция — события подряд по цепочке аудита (JSONL, зашифрован на ключ Томаса) и опись,
 * подписанная ключом выгрузки Ed25519 (закрытый — только на сервере, открытый закреплён в
 * репозитории). Шифрование даёт конфиденциальность, подпись — происхождение.
 *
 * Покрытие и порядок: опись N ссылается на хеш описи N−1 и продолжает её хвост цепочки
 * (from = прежний to). Получатель хранит доверенную контрольную точку — последнюю
 * проверенную опись — и принимает только продолжение от неё: более старая выгрузка вместо
 * новой и усечённый хвост не проходят. Порция пишется и без новых событий — опись со
 * временем проверки подтверждает, что до этого момента событий не было (конец периода).
 */
import { createHash, createPublicKey, sign, verify } from 'node:crypto';

export const FORMAT = 'audit-export/v1';

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

/** Детерминированная сериализация описи: ключи по алфавиту, без пробелов. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function signManifest(manifest, privateKey) {
  const bytes = Buffer.from(canonical(manifest));
  return { bytes, signature: sign(null, bytes, privateKey).toString('base64') };
}

export function verifyManifest(bytes, signatureB64, publicKeyPem) {
  const key = createPublicKey(publicKeyPem);
  return verify(null, bytes, key, Buffer.from(String(signatureB64).trim(), 'base64'));
}

/**
 * Проверка цепочки событий порции: первое продолжает afterRowHash (null — начало
 * журнала), каждое следующее ссылается на хеш предыдущего; последнее — to.
 */
export function checkEventChain(events, afterRowHash, toRowHash) {
  let prev = afterRowHash;
  for (const e of events) {
    if ((e.prev_hash ?? null) !== (prev ?? null)) {
      return `разрыв цепочки перед событием ${e.id}`;
    }
    prev = e.row_hash;
  }
  if ((prev ?? null) !== (toRowHash ?? null)) return 'хвост порции не совпал с описью';
  return null;
}

/**
 * Принять порцию: подпись описи закреплённым ключом, продолжение контрольной точки,
 * шифротекст по описи. Возвращает новую контрольную точку или бросает с причиной.
 */
export function acceptPortion(checkpoint, manifestBytes, signature, cipher, publicKeyPem) {
  if (!verifyManifest(manifestBytes, signature, publicKeyPem)) {
    throw new Error('подпись описи неверна');
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  const msha = sha256Hex(manifestBytes);
  const refused = checkContinuation(checkpoint, manifest, msha);
  if (refused) throw new Error(`порция ${manifest.seq}: ${refused}`);
  if (sha256Hex(cipher) !== manifest.cipherSha256) {
    throw new Error(`порция ${manifest.seq}: шифротекст не совпал с описью`);
  }
  return {
    point: {
      databaseId: manifest.databaseId,
      seq: manifest.seq,
      manifestSha256: msha,
      to: manifest.to,
      checkedAt: manifest.checkedAt,
    },
    manifest,
  };
}

/**
 * Проверка продолжения серии от контрольной точки. checkpoint: {seq, manifestSha256,
 * to: {rowHash}, databaseId} или null (первая порция серии). Возвращает текст отказа или
 * null.
 */
export function checkContinuation(checkpoint, manifest, manifestSha) {
  if (manifest.format !== FORMAT) return 'неизвестный формат описи';
  if (!checkpoint) {
    if (manifest.seq !== 1 || manifest.prevManifestSha256 !== null) {
      return 'первая принимаемая порция не начинает серию — нужна контрольная точка';
    }
    if (manifest.from.afterRowHash !== null) return 'серия начинается не с начала журнала';
    return null;
  }
  if (manifest.databaseId !== checkpoint.databaseId) return 'опись другой базы';
  if (manifest.seq <= checkpoint.seq) {
    return manifestSha === checkpoint.manifestSha256 || manifest.seq < checkpoint.seq
      ? 'старая порция — уже принята или старее контрольной точки'
      : 'другая порция с тем же номером — подмена';
  }
  if (manifest.seq !== checkpoint.seq + 1) return `пропуск порций: ждали ${checkpoint.seq + 1}`;
  if (manifest.prevManifestSha256 !== checkpoint.manifestSha256) {
    return 'опись не продолжает контрольную точку';
  }
  if (manifest.from.afterRowHash !== checkpoint.to.rowHash) {
    return 'начало порции не совпадает с хвостом контрольной точки (усечение или подмена)';
  }
  if (Date.parse(manifest.checkedAt) < Date.parse(checkpoint.checkedAt)) {
    return 'время проверки раньше контрольной точки';
  }
  return null;
}

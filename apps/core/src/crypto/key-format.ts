/**
 * Два формата зашифрованных байтов в столбцах BYTEA.
 *
 * Прежний: `iv || tag || ciphertext`, без версии. Он навсегда связан с версией 1 ключа своей
 * области: ключи импортированы в Transit без изменения, поэтому перебирать ключи не нужно.
 *
 * Новый: ASCII-строка OpenBao `vault:vN:<base64>`. Версия живёт внутри неё, отдельного столбца нет.
 *
 * Значение, начатое с `vault:`, разбирается только как новый формат. Повреждённое или с неизвестной
 * версией даёт отказ и никогда не читается как прежнее.
 */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VAULT_MARK = Buffer.from('vault:', 'ascii');
const VAULT_PATTERN = /^vault:v([1-9]\d{0,8}):([A-Za-z0-9+/]+={0,2})$/;

/** Версия, с которой связан формат без версии. */
export const LEGACY_KEY_VERSION = 1;

export function isVaultFormat(payload: Buffer): boolean {
  return payload.subarray(0, VAULT_MARK.length).equals(VAULT_MARK);
}

export function parseVault(text: string): { version: number; raw: Buffer } {
  const match = VAULT_PATTERN.exec(text);
  if (!match) throw new Error('повреждённые данные: формат vault не разобран');
  const raw = Buffer.from(match[2]!, 'base64');
  if (raw.toString('base64') !== match[2] || raw.length < IV_BYTES + TAG_BYTES) {
    throw new Error('повреждённые данные: формат vault не разобран');
  }
  return { version: Number(match[1]), raw };
}

/** Строка для Transit из прежнего формата. В Transit порядок другой: `iv || ciphertext || tag`. */
export function legacyToVault(payload: Buffer): string {
  if (payload.length < IV_BYTES + TAG_BYTES) {
    throw new Error('повреждённые данные: недостаточная длина');
  }
  const iv = payload.subarray(0, IV_BYTES);
  const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const body = payload.subarray(IV_BYTES + TAG_BYTES);
  const raw = Buffer.concat([iv, body, tag]).toString('base64');
  return `vault:v${LEGACY_KEY_VERSION}:${raw}`;
}

/** Обратный перевод для переходного выпуска: прежнее ядро обязано прочитать эту запись. */
export function vaultToLegacy(text: string): Buffer {
  const { version, raw } = parseVault(text);
  if (version !== LEGACY_KEY_VERSION) {
    throw new Error(`версия ключа ${version} не выражается прежним форматом`);
  }
  const iv = raw.subarray(0, IV_BYTES);
  const body = raw.subarray(IV_BYTES, raw.length - TAG_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  return Buffer.concat([iv, tag, body]);
}

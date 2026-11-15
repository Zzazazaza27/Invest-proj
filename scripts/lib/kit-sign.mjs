/**
 * Подпись манифеста комплекта (Ed25519). Закрытый ключ только в защищённом окружении CI,
 * открытый — у установщика, вне репозитория. Метка домена не даёт выдать подпись за другую.
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const DOMAIN = Buffer.from('fifth-kit-v1\n');
const payload = (bytes) => Buffer.concat([DOMAIN, bytes]);

export const signKit = (bytes, privatePem) =>
  sign(null, payload(bytes), createPrivateKey(privatePem)).toString('base64');

/**
 * Подпись отчёта совместимости (блок 09, задание 2; Тэнк 09.11): тот же ключ CI, своя метка
 * домена — подпись отчёта нельзя выдать за подпись комплекта и наоборот. Подписываются байты
 * файла целиком: результат, оба комплекта и хеши, миграции, проверки, версия средств проверки.
 */
const COMPAT_DOMAIN = Buffer.from('fifth-compat-v1\n');
export const signCompat = (bytes, privatePem) =>
  sign(null, Buffer.concat([COMPAT_DOMAIN, bytes]), createPrivateKey(privatePem)).toString(
    'base64',
  );

export function compatSignatureValid(bytes, signature, publicPem) {
  try {
    return verify(
      null,
      Buffer.concat([COMPAT_DOMAIN, bytes]),
      createPublicKey(publicPem),
      Buffer.from(String(signature).trim(), 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * Подпись архива окружения узла (15.11): тот же ключ комплектов, своя метка домена —
 * подпись архива нельзя выдать за подпись комплекта или отчёта. Подписывается archive.json.
 */
const HOSTENV_DOMAIN = Buffer.from('fifth-hostenv-v1\n');
export const signHostEnv = (bytes, privatePem) =>
  sign(null, Buffer.concat([HOSTENV_DOMAIN, bytes]), createPrivateKey(privatePem)).toString(
    'base64',
  );

export function hostEnvSignatureValid(bytes, signature, publicPem) {
  try {
    return verify(
      null,
      Buffer.concat([HOSTENV_DOMAIN, bytes]),
      createPublicKey(publicPem),
      Buffer.from(String(signature).trim(), 'base64'),
    );
  } catch {
    return false;
  }
}

export function kitSignatureValid(bytes, signature, publicPem) {
  try {
    return verify(
      null,
      payload(bytes),
      createPublicKey(publicPem),
      Buffer.from(String(signature), 'base64'),
    );
  } catch {
    return false;
  }
}

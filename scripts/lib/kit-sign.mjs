/**
 * Подпись манифеста комплекта (Ed25519). Закрытый ключ только в защищённом окружении CI,
 * открытый — у установщика, вне репозитория. Метка домена не даёт выдать подпись за другую.
 */
import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

const DOMAIN = Buffer.from('fifth-kit-v1\n');
const payload = (bytes) => Buffer.concat([DOMAIN, bytes]);

export const signKit = (bytes, privatePem) =>
  sign(null, payload(bytes), createPrivateKey(privatePem)).toString('base64');

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

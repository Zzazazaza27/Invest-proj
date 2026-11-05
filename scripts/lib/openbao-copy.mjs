/**
 * Чтение отдельной копии (блок 5, задание 5). Ключ восстановления применяется только здесь: на копии
 * из снимка выпускается временный root-токен, им открывается запись из копии базы.
 *
 * `call(method, path, { token, body })` — запрос к копии. Значения не печатаются.
 */
import { createDecipheriv, createHash } from 'node:crypto';

function openField(dek, payload, aad) {
  const d = createDecipheriv('aes-256-gcm', dek, payload.subarray(0, 12), { authTagLength: 16 });
  d.setAuthTag(payload.subarray(12, 28));
  d.setAAD(Buffer.from(aad));
  return Buffer.concat([d.update(payload.subarray(28)), d.final()]);
}

async function rootByRecoveryKey(call, recovery) {
  const started = await call('PUT', 'sys/generate-root/attempt', { body: {} });
  const { otp, nonce } = started.json;
  if (!otp) throw new Error(`выпуск токена не начат, код ${started.status}`);
  const done = await call('PUT', 'sys/generate-root/update', { body: { key: recovery, nonce } });
  if (!done.json.complete) throw new Error(`ключ восстановления не принят, код ${done.status}`);
  const encoded = Buffer.from(done.json.encoded_token, 'base64url');
  const pad = Buffer.from(otp);
  return Buffer.from(encoded.map((byte, i) => byte ^ pad[i])).toString('utf8');
}

/** Возвращает хеш адреса из копии: сверяют его, а не значение. */
export async function readCopy(call, { recovery, password, prefix, wrappedDek, emailCiphertext }) {
  const login = await call('POST', 'auth/userpass/login/thomas', { body: { password } });
  if (!login.json.auth?.client_token) throw new Error(`личный вход на копии: код ${login.status}`);
  const token = await rootByRecoveryKey(call, recovery);
  const opened = await call('POST', `transit/decrypt/${prefix}-passport-sensitive`, {
    token,
    body: {
      ciphertext: wrappedDek.toString('ascii'),
      associated_data: Buffer.from('wrap:passport_sensitive').toString('base64'),
    },
  });
  if (!opened.json.data?.plaintext) throw new Error(`запись не открылась, код ${opened.status}`);
  const dek = Buffer.from(opened.json.data.plaintext, 'base64');
  try {
    const email = openField(dek, emailCiphertext, 'field:email');
    return createHash('sha256').update(email).digest('hex');
  } finally {
    dek.fill(0);
  }
}

/**
 * Импорт ключа в Transit: AES-KWP под разовым ключом, сам разовый ключ под RSA-OAEP.
 * `call(method, path, options)` — запрос к API OpenBao с уже заданным адресом и токеном.
 */
import { constants, createCipheriv, publicEncrypt, randomBytes } from 'node:crypto';

export async function importTransitKey(call, name, type, key, extra = {}) {
  // Только что подключённый Transit отвечает не сразу: ключ упаковки создаётся при первом запросе.
  let wrapping;
  for (let attempt = 0; attempt < 20; attempt++) {
    wrapping = await call('GET', 'transit/wrapping_key');
    if (wrapping.json.data?.public_key) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!wrapping.json.data?.public_key) throw new Error();
  const ephemeral = randomBytes(32);
  const kwp = createCipheriv('id-aes256-wrap-pad', ephemeral, Buffer.from('A65959A6', 'hex'));
  const wrapped = Buffer.concat([kwp.update(key), kwp.final()]);
  const rsa = publicEncrypt(
    {
      key: wrapping.json.data.public_key,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    ephemeral,
  );
  return call('POST', `transit/keys/${name}/import`, {
    body: {
      ciphertext: Buffer.concat([rsa, wrapped]).toString('base64'),
      type,
      hash_function: 'SHA256',
      exportable: false,
      ...extra,
    },
  });
}

#!/usr/bin/env node
/**
 * Запрос к защищённому установщику: подпись манифеста и один JSON в stdout, он уходит в SSH.
 * Запускается в CI, значения не печатает никуда, кроме этого потока.
 *
 *   node scripts/install-request.mjs --dir <артефакт kit> --expect <сборка> \
 *        --sign-key-file <файл> --token-file <файл>
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { signKit } from './lib/kit-sign.mjs';

const option = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : '';
};
const dir = option('--dir');
const b64 = (path) => readFileSync(path).toString('base64');
const kitBytes = readFileSync(join(dir, 'kit.json'));
const kit = JSON.parse(kitBytes.toString('utf8'));
const files = {
  'kit.json': kitBytes.toString('base64'),
  'compose.yml': b64(join(dir, 'compose.yml')),
};
for (const name of readdirSync(join(dir, 'prod-compose'))) {
  files[`prod-compose/${name}`] = b64(join(dir, 'prod-compose', name));
}
process.stdout.write(
  JSON.stringify({
    build: kit.build,
    expect: option('--expect'),
    token: readFileSync(option('--token-file'), 'utf8').trim(),
    signature: signKit(kitBytes, readFileSync(option('--sign-key-file'), 'utf8')),
    files,
  }),
);

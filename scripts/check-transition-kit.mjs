#!/usr/bin/env node
/**
 * Переходный комплект на искусственных значениях (блок 5, задание 5).
 *
 *   node scripts/check-transition-kit.mjs
 *
 * Настоящий infra/host/fifth-transition-kit в контейнере от root: комплект снимается, каталог
 * портится, комплект возвращает содержимое, владельца и права. Подмена и чужой ключ отвергаются.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_IMAGE } from './lib/backup.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const script = String.raw`
set -u
K=/tool/fifth-transition-kit
ok() { if [ "$2" = 0 ]; then echo "OK   $1"; else echo "FAIL $1"; fi; }
export GNUPGHOME=$(mktemp -d)
gpg -q --batch --pinentry-mode loopback --passphrase lab --quick-gen-key "lab <lab@example.test>" rsa2048 encrypt never
FPR=$(gpg --batch --list-keys --with-colons | awk -F: '/^fpr/{print $10; exit}')
gpg -q --batch --armor --export "$FPR" > /tmp/recipient.asc
export FIFTH_TRANSITION_ROOT=/tmp/root FIFTH_OPENBAO_KEYS_DIR=/tmp/keys
export FIFTH_OPENBAO_RECIPIENT=/tmp/recipient.asc FIFTH_OPENBAO_RECIPIENT_FPR=$FPR
mkdir -p /tmp/root/.local/secrets
printf 'KMS_MODE=local\nKEK_SEARCH_INDEX_FILE=/x\n' > /tmp/root/.env
printf 'lab-kek-value-1\n' > /tmp/root/.local/secrets/KEK_SEARCH_INDEX
printf 'lab-kek-value-2\n' > /tmp/root/.local/secrets/KEK_PASSPORT_SENSITIVE
chmod 600 /tmp/root/.env; chmod 750 /tmp/root/.local/secrets
chown 0:1000 /tmp/root/.local/secrets /tmp/root/.local/secrets/*
chmod 440 /tmp/root/.local/secrets/*

FIFTH_OPENBAO_RECIPIENT_FPR=0000 sh $K create >/dev/null 2>&1
[ $? -ne 0 ] && [ ! -e /tmp/keys/transition.gpg ]; ok 'чужой отпечаток: комплект не создан' $?

OUT=$(sh $K create 2>&1); ok 'комплект создан' $?
echo "$OUT" | grep -q lab-kek; [ $? -ne 0 ]; ok 'значения не напечатаны' $?
grep -q lab-kek /tmp/keys/transition.gpg; [ $? -ne 0 ]; ok 'значений нет в открытом виде' $?
grep -q '"files":3' /tmp/keys/transition.json; ok 'опись считает файлы' $?

before=$(cd /tmp/root && find .env .local/secrets -type f | sort | xargs stat -c '%a %u %g %n'; cd /tmp/root && cat .env .local/secrets/*)
printf 'KMS_MODE=kms\n' > /tmp/root/.env; chmod 644 /tmp/root/.env
rm /tmp/root/.local/secrets/KEK_SEARCH_INDEX
chmod 444 /tmp/root/.local/secrets/KEK_PASSPORT_SENSITIVE

printf lab | gpg -q --batch --pinentry-mode loopback --passphrase-fd 0 --decrypt /tmp/keys/transition.gpg > /tmp/kit.tar 2>/dev/null
ok 'открывается ключом получателя' $?

mkdir /tmp/forged && tar -xpf /tmp/kit.tar -C /tmp/forged
printf 'подмена\n' > /tmp/forged/.local/secrets/KEK_SEARCH_INDEX
tar -cpf /tmp/forged.tar --numeric-owner -C /tmp/forged .env .local/secrets transition-manifest.txt
sh $K restore < /tmp/forged.tar >/dev/null 2>&1
[ $? -ne 0 ]; ok 'подмена содержимого отвергнута' $?
grep -q KMS_MODE=kms /tmp/root/.env; ok 'при отказе ничего не изменено' $?


tar -xpf /tmp/kit.tar -C /tmp/forged; chmod 666 /tmp/forged/.env
tar -cpf /tmp/forged2.tar --numeric-owner -C /tmp/forged .env .local/secrets transition-manifest.txt
sh $K restore < /tmp/forged2.tar >/dev/null 2>&1
[ $? -ne 0 ]; ok 'подмена прав отвергнута' $?

OUT=$(sh $K restore < /tmp/kit.tar 2>&1); ok 'восстановление прошло' $?
echo "$OUT" | grep -q lab-kek; [ $? -ne 0 ]; ok 'значения не напечатаны при восстановлении' $?
after=$(cd /tmp/root && find .env .local/secrets -type f | sort | xargs stat -c '%a %u %g %n'; cd /tmp/root && cat .env .local/secrets/*)
[ "$before" = "$after" ]; ok 'содержимое, владелец и права вернулись' $?
ls -d /tmp/root/.local/before-restore-* >/dev/null 2>&1; ok 'прежнее отложено, а не удалено' $?
ls -a /tmp/root | grep -q '^\.transition'; [ $? -ne 0 ]; ok 'временных файлов не осталось' $?
`;

const r = spawnSync(
  'docker',
  [
    'run',
    '--rm',
    '--network',
    'none',
    '--user',
    '0',
    '-v',
    `${join(ROOT, 'infra', 'host')}:/tool:ro`,
    '--entrypoint',
    'sh',
    TOOL_IMAGE,
    '-c',
    script,
  ],
  { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
);
const lines = r.stdout.split('\n').filter((l) => /^(OK|FAIL) /.test(l));
console.log('=== ПЕРЕХОДНЫЙ КОМПЛЕКТ ===');
for (const line of lines) console.log(`  ${line}`);
const failed = lines.filter((l) => l.startsWith('FAIL')).length;
const expected = 14;
if (lines.length !== expected) console.log(`  FAIL ожидалось ${expected}: ${r.stderr.slice(-300)}`);
console.log(`\nИТОГ: пройдено ${lines.length - failed}, не пройдено ${failed}`);
process.exit(failed || lines.length !== expected ? 1 : 0);

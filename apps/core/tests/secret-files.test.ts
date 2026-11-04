import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env';
import { withSecretFiles } from '../src/config/secret-files';

const dir = mkdtempSync(join(tmpdir(), 'secret-files-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const secret = (name: string, value: string): string => {
  const path = join(dir, name);
  writeFileSync(path, value);
  return path;
};

describe('секреты из файлов', () => {
  it('значение берётся из файла, завершающий перевод строки отброшен', () => {
    const env = withSecretFiles({ KEY_FILE: secret('a', 'значение\n') });
    expect(env.KEY).toBe('значение');
    expect(env.KEY_FILE).toBeUndefined();
  });

  it('внутренние переводы строки и пробелы сохраняются', () => {
    const env = withSecretFiles({ KEY_FILE: secret('b', ' a\nb \n') });
    expect(env.KEY).toBe(' a\nb ');
  });

  it('заданы и значение, и файл — отказ', () => {
    expect(() => withSecretFiles({ KEY: 'x', KEY_FILE: secret('c', 'y') })).toThrow(
      'Заданы и KEY, и KEY_FILE',
    );
  });

  it('файла нет — отказ с именем, а не пустое значение', () => {
    expect(() => withSecretFiles({ KEY_FILE: join(dir, 'нет') })).toThrow('KEY_FILE');
  });

  it('содержимое файла не попадает в ошибку конфликта', () => {
    const path = secret('d', 'тайна');
    expect(() => withSecretFiles({ KEY: 'x', KEY_FILE: path })).not.toThrow(/тайна/);
  });

  it('прочие переменные не меняются', () => {
    expect(withSecretFiles({ A: '1', EMPTY_FILE: '' })).toEqual({ A: '1', EMPTY_FILE: '' });
  });
});

/** Миграции и инициализация NATS: отдельные процессы с теми же правилами. */
describe('секреты из файлов: загрузчики вне ядра', () => {
  const root = resolve(__dirname, '..', '..', '..');
  const loaders = [
    ['миграции', ['--experimental-strip-types', 'database/src/env.ts']],
    ['NATS', ['scripts/nats-init-stream.mjs']],
  ] as const;
  const run = (args: readonly string[], extra: NodeJS.ProcessEnv) =>
    spawnSync(process.execPath, [...args], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NATS_URL: 'nats://127.0.0.1:1', ...extra },
    });

  for (const [name, args] of loaders) {
    it(`${name}: заданы и значение, и файл — отказ`, () => {
      const r = run(args, { DEMO_KEY: 'x', DEMO_KEY_FILE: secret('e', 'y') });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('Заданы и DEMO_KEY, и DEMO_KEY_FILE');
    });

    it(`${name}: нечитаемый файл не обходится значением из окружения`, () => {
      const r = run(args, { DEMO_KEY: '', DEMO_KEY_FILE: join(dir, 'нет') });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('DEMO_KEY_FILE');
    });
  }
});

describe('секреты из файлов: повторная загрузка', () => {
  it('загрузка из process.env дважды не даёт ложного конфликта', () => {
    const name = 'SECRET_FILES_TEST_VALUE';
    process.env[`${name}_FILE`] = secret('f', 'значение');
    // Настройки теста неполные: важна не успешная загрузка, а отсутствие конфликта.
    const load = (): string => {
      try {
        loadEnv();
        return '';
      } catch (e) {
        return String(e);
      }
    };
    try {
      load();
      expect(process.env[name]).toBe('значение');
      expect(process.env[`${name}_FILE`]).toBeUndefined();
      expect(load()).not.toContain('Заданы и');
    } finally {
      delete process.env[name];
      delete process.env[`${name}_FILE`];
    }
  });
});

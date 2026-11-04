import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
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

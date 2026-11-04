import { readFileSync } from 'node:fs';

const SUFFIX = '_FILE';

/**
 * Секреты из файлов: `<ИМЯ>_FILE=/путь` даёт значение `<ИМЯ>` из файла.
 *
 * Образ один на все среды, поэтому секрет приходит при установке, а не при
 * сборке. Завершающий перевод строки отбрасывается: его добавляют редакторы и
 * `echo`, а в пароле он означал бы другое значение. Заданы и значение, и файл —
 * отказ: неясно, какое из них действует. В ошибке только имя и путь, содержимого
 * файла в ней нет.
 */
export function withSecretFiles(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...source };
  for (const [key, path] of Object.entries(source)) {
    if (!key.endsWith(SUFFIX) || !path) continue;
    const name = key.slice(0, -SUFFIX.length);
    if (source[name]) {
      throw new Error(`Заданы и ${name}, и ${key}: оставь одно`);
    }
    try {
      out[name] = readFileSync(path, 'utf8').replace(/\r?\n$/, '');
    } catch {
      throw new Error(`${key}: файл ${path} не читается`);
    }
    delete out[key];
  }
  return out;
}

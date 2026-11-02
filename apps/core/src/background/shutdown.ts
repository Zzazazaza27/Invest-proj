import type { BackgroundJobsService } from './background-jobs.service';

/**
 * Штатное завершение процесса с общим пределом (блок 1, 1.2).
 *
 * Порядок: фон перестаёт захватывать работу и получает прерывание → ждём
 * идущие проходы в пределах срока → закрываем приложение и соединения →
 * выходим. Предел общий на всю последовательность: зависшее закрытие
 * приложения или пула не держит процесс дольше срока — по истечении выход
 * принудительный. Незавершённая работа повторится после истечения аренды.
 */
export interface ShutdownOptions {
  jobs: Pick<BackgroundJobsService, 'stop'>;
  /** Закрытие приложения, служебного порта, соединений — по порядку. */
  closers: ReadonlyArray<() => Promise<unknown>>;
  graceMs: number;
  /** Первый шаг: вывести экземпляр из готовности (блок 4.9). */
  beforeStop?: () => void;
  exit: (code: number) => void;
  /**
   * Сообщение — постоянный текст; исключение — отдельным аргументом, в
   * журнал оно идёт через безопасное преобразование (8.4), а не текстом в
   * строке сообщения.
   */
  log: (message: string, error?: unknown) => void;
}

/** Связка завершения с журналом ядра: та же, что в main.ts. */
export function shutdownLog(logger: {
  log: (message: unknown) => void;
  warn: (message: unknown) => void;
}): ShutdownOptions['log'] {
  return (message, error) =>
    error === undefined ? logger.log(message) : logger.warn({ msg: message, error });
}

export function createShutdown(options: ShutdownOptions): (signal: string) => Promise<void> {
  let started = false;
  return async (signal) => {
    if (started) return;
    started = true;
    const deadline = Date.now() + options.graceMs;
    const forced = setTimeout(() => {
      options.log(`завершение не уложилось в ${options.graceMs} мс, выход принудительно`);
      options.exit(1);
    }, options.graceMs);
    forced.unref();

    options.beforeStop?.();
    options.log(`получен ${signal}, новая фоновая работа не захватывается`);
    await options.jobs.stop(Math.max(0, deadline - Date.now()));
    for (const close of options.closers) {
      await close().catch((error: unknown) => options.log('ошибка при закрытии', error));
    }
    clearTimeout(forced);
    options.exit(0);
  };
}

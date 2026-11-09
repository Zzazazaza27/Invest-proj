import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { getEnv } from '../config/env';
import { pgAdvisoryLocks, type AdvisoryLockProvider } from './advisory';
import type { JobCoordination, JobDefinition, JobResult } from './job';
import { restoreGateOpen } from '../health/restore-gate';

/**
 * Общий механизм фоновой работы ядра (блок 1, 1.2).
 *
 * Доменные службы регистрируют задачи при инициализации модуля, а запускает
 * их только `start()` из точки входа — после решения о роли процесса и
 * выключателе. Поэтому выключенный фон не делает ни одного прохода, включая
 * первые, стартовые: прежде обслуживание выполняло уборки прямо в
 * `onModuleInit`, до любого таймера.
 *
 * Чего здесь нет намеренно: универсальной очереди. Состояние работы хранится
 * в прикладных записях, а не в реестре.
 */

/**
 * `skipped` — блокировку держит другой экземпляр; `interrupted` — проход
 * прерван остановкой или потерей блокировки до начала либо по ходу работы.
 * Ни то ни другое не считается отказом задачи.
 */
export type PassStatus = JobResult['status'] | 'failed' | 'skipped' | 'interrupted';

export interface JobState {
  name: string;
  coordination: JobCoordination;
  intervalMs: number;
  enabled: boolean;
  running: boolean;
  runningSince: string | null;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: PassStatus | null;
  lastProcessed: number | null;
  lastDurationMs: number | null;
  /** Проход прерван остановкой или потерей блокировки. */
  lastInterrupted: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  /** Ошибок подряд: повтор идёт следующим проходом по интервалу. */
  consecutiveFailures: number;
  nextRunAt: string | null;
  /** Ожидаемый проход не начался вовремя либо идёт дольше интервала. */
  overdue: boolean;
}

interface Entry {
  def: JobDefinition;
  enabled: boolean;
  timer: NodeJS.Timeout | null;
  current: Promise<void> | null;
  runningSince: number | null;
  nextRunAt: number | null;
  lastStartedAt: number | null;
  lastFinishedAt: number | null;
  lastStatus: PassStatus | null;
  lastProcessed: number | null;
  lastDurationMs: number | null;
  lastInterrupted: boolean;
  lastSuccessAt: number | null;
  lastError: string | null;
  lastErrorAt: number | null;
  consecutiveFailures: number;
}

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

/**
 * Состояние фона процесса (блок 09, задание 3; Тэнк 09.11).
 *
 *  - `idle` — фон не запускался (выключен, роль, нет разрешения);
 *  - `running` — проходы планируются и идут;
 *  - `pausing` — новые не захватываются, идущие ещё не закончились;
 *  - `paused` — идущих нет: объявляется только после фактического окончания каждого
 *    прохода. Отправленный сигнал прерывания окончания не доказывает;
 *  - `stopping` — остановка процесса, навсегда.
 */
export type BackgroundMode = 'idle' | 'running' | 'pausing' | 'paused' | 'stopping';

@Injectable()
export class BackgroundJobsService {
  private readonly logger = new Logger(BackgroundJobsService.name);
  readonly instanceId = `${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`;
  private readonly jobs = new Map<string, Entry>();
  private readonly stopController = new AbortController();
  private started = false;
  /**
   * Эпоха работы: прерывается паузой, на продолжение заводится новая. Отдельно от
   * `stopController` — тот прерывается только остановкой процесса и навсегда.
   */
  private epoch = new AbortController();
  private paused = false;
  /** Проходы, которых ждёт пауза: пока хоть один идёт — `pausing`, а не `paused`. */
  private pausePending = new Set<Promise<void>>();

  /** Подменяется в тестах; в работе — блокировки PostgreSQL. */
  locks: AdvisoryLockProvider = pgAdvisoryLocks;

  register(def: JobDefinition): void {
    if (this.jobs.has(def.name)) throw new Error(`фоновая задача ${def.name} уже зарегистрирована`);
    const disabled = new Set(
      getEnv()
        .BACKGROUND_JOBS_DISABLED.split(',')
        .map((name) => name.trim())
        .filter(Boolean),
    );
    this.jobs.set(def.name, {
      def,
      enabled: !disabled.has(def.name),
      timer: null,
      current: null,
      runningSince: null,
      nextRunAt: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastStatus: null,
      lastProcessed: null,
      lastDurationMs: null,
      lastInterrupted: false,
      lastSuccessAt: null,
      lastError: null,
      lastErrorAt: null,
      consecutiveFailures: 0,
    });
    if (this.started) this.schedule(this.jobs.get(def.name)!, def.runAtStart ? 0 : def.intervalMs);
  }

  /** Разрешён ли фон этому процессу: общий выключатель и роль запуска. */
  static allowedByConfig(): { allowed: boolean; reason: string } {
    const env = getEnv();
    if (env.BACKGROUND_JOBS_ENABLED !== 'true') {
      return { allowed: false, reason: 'BACKGROUND_JOBS_ENABLED=false' };
    }
    if (env.CORE_ROLE === 'http') return { allowed: false, reason: 'CORE_ROLE=http' };
    return { allowed: true, reason: '' };
  }

  get isStarted(): boolean {
    return this.started;
  }

  get isStopping(): boolean {
    return this.stopController.signal.aborted;
  }

  get mode(): BackgroundMode {
    if (this.isStopping) return 'stopping';
    if (!this.started) return 'idle';
    if (this.paused) return this.pausePending.size > 0 ? 'pausing' : 'paused';
    return 'running';
  }

  /** Имена задач, чьи проходы ещё идут во время паузы. */
  get pendingPasses(): string[] {
    return [...this.jobs.values()].filter((e) => e.current).map((e) => e.def.name);
  }

  /**
   * Обратимая пауза (блок 09, задание 3). Новые проходы не планируются сразу. Идущим даём
   * закончиться сами `graceMs`, затем шлём прерывание эпохи и ждём до `waitMs` всего.
   * `paused` — только когда закончился каждый проход: advisory-блокировки к этому моменту
   * освобождены (`finally` прохода), незавершённое осталось в прикладных записях и будет
   * подхвачено по аренде там, где фон работает. Не дождались — остаётся `pausing` с именами
   * идущих проходов; переход в `paused` произойдёт сам, когда они закончатся.
   */
  async pause(waitMs: number, graceMs = Math.floor(waitMs / 2)): Promise<BackgroundMode> {
    if (this.isStopping) return this.mode;
    if (!this.started) {
      // Фон ещё не запускался: пауза означает «не запускать» — то же для продолжения.
      this.paused = true;
      this.started = true;
      return this.mode;
    }
    if (!this.paused) {
      this.paused = true;
      for (const entry of this.jobs.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = null;
        entry.nextRunAt = null;
      }
      for (const entry of this.jobs.values()) {
        if (!entry.current) continue;
        const pass = entry.current;
        this.pausePending.add(pass);
        void pass.finally(() => this.pausePending.delete(pass));
      }
      this.logger.log({ msg: 'фон: пауза', pending: this.pendingPasses });
    }
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        if (this.pausePending.size === 0) return resolve();
        const timer = setTimeout(resolve, ms);
        void Promise.allSettled([...this.pausePending]).then(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    await wait(graceMs);
    if (this.pausePending.size > 0 && !this.epoch.signal.aborted) {
      this.epoch.abort(new Error('пауза фона'));
    }
    await wait(Math.max(0, waitMs - graceMs));
    if (this.pausePending.size > 0) {
      this.logger.warn({
        msg: 'фон: проходы не закончились к сроку паузы',
        pending: this.pendingPasses,
      });
    } else {
      this.logger.log({ msg: 'фон: на паузе' });
    }
    return this.mode;
  }

  /**
   * Продолжение после паузы — только из `paused`: пока идёт хоть один прежний проход,
   * второй тот же не запускается. Новая эпоха; задачи планируются через интервал, стартовые
   * уборки (`runAtStart`) не повторяются.
   */
  resume(): BackgroundMode {
    if (this.isStopping || !this.paused || this.pausePending.size > 0) return this.mode;
    this.paused = false;
    this.epoch = new AbortController();
    for (const entry of this.jobs.values()) this.schedule(entry, entry.def.intervalMs);
    this.logger.log({ msg: 'фон: продолжен', instance: this.instanceId });
    return this.mode;
  }

  start(): void {
    if (this.started || this.isStopping) return;
    this.started = true;
    for (const entry of this.jobs.values()) {
      this.schedule(entry, entry.def.runAtStart ? 0 : entry.def.intervalMs);
    }
    this.logger.log({
      msg: 'фоновые задачи запущены',
      instance: this.instanceId,
      jobs: [...this.jobs.values()].map((e) => (e.enabled ? e.def.name : `${e.def.name} (выкл.)`)),
    });
  }

  /**
   * Штатная остановка: новая работа не захватывается, идущие проходы получают
   * прерывание и ждутся не дольше `waitMs`. Не дождались — возвращаемся всё
   * равно: незавершённая работа повторится после истечения аренды.
   *
   * @returns сколько проходов не успело завершиться.
   */
  async stop(waitMs: number): Promise<number> {
    if (!this.isStopping) this.stopController.abort(new Error('остановка процесса'));
    for (const entry of this.jobs.values()) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      entry.nextRunAt = null;
    }
    const running = [...this.jobs.values()].filter((e) => e.current).map((e) => e.current!);
    if (running.length === 0) return 0;

    let pending = running.length;
    for (const pass of running) void pass.finally(() => (pending -= 1));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(running),
      new Promise((resolve) => {
        timer = setTimeout(resolve, waitMs);
      }),
    ]);
    clearTimeout(timer);
    if (pending > 0) {
      this.logger.warn({ msg: 'фоновые проходы не завершились к сроку остановки', pending });
    }
    return pending;
  }

  /** Выполнить проход немедленно и дождаться его — для прогонов и тестов. */
  async runNow(name: string): Promise<void> {
    const entry = this.jobs.get(name);
    if (!entry) throw new Error(`фоновая задача ${name} не зарегистрирована`);
    if (entry.current) return entry.current;
    return this.pass(entry);
  }

  snapshot(now = Date.now()): JobState[] {
    return [...this.jobs.values()].map((e) => ({
      name: e.def.name,
      coordination: e.def.coordination,
      intervalMs: e.def.intervalMs,
      enabled: e.enabled,
      running: e.current !== null,
      runningSince: iso(e.runningSince),
      lastStartedAt: iso(e.lastStartedAt),
      lastFinishedAt: iso(e.lastFinishedAt),
      lastStatus: e.lastStatus,
      lastProcessed: e.lastProcessed,
      lastDurationMs: e.lastDurationMs,
      lastInterrupted: e.lastInterrupted,
      lastSuccessAt: iso(e.lastSuccessAt),
      lastError: e.lastError,
      lastErrorAt: iso(e.lastErrorAt),
      consecutiveFailures: e.consecutiveFailures,
      nextRunAt: iso(e.nextRunAt),
      overdue:
        e.enabled &&
        this.started &&
        !this.paused &&
        !this.isStopping &&
        ((e.runningSince !== null && now - e.runningSince > e.def.intervalMs) ||
          (e.runningSince === null &&
            e.nextRunAt !== null &&
            now - e.nextRunAt > e.def.intervalMs)),
    }));
  }

  private schedule(entry: Entry, delayMs: number): void {
    if (!entry.enabled || this.isStopping || this.paused) return;
    entry.nextRunAt = Date.now() + delayMs;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      // Запрет наложения: следующий проход ставится только после окончания
      // текущего, поэтому два прохода одной задачи в процессе не идут.
      void this.pass(entry).finally(() => {
        const elapsed = Date.now() - (entry.lastStartedAt ?? Date.now());
        this.schedule(entry, Math.max(0, entry.def.intervalMs - elapsed));
      });
    }, delayMs);
    entry.timer.unref();
  }

  /** Один проход. Никогда не отклоняется: отказ задачи — её состояние, а не падение ядра. */
  private pass(entry: Entry): Promise<void> {
    const run = async (): Promise<void> => {
      const started = Date.now();
      entry.runningSince = started;
      entry.lastStartedAt = started;
      entry.nextRunAt = null;
      entry.lastInterrupted = false;
      // Прерывание — остановкой процесса или паузой (эпоха прохода фиксируется на старте).
      let signal = AbortSignal.any([this.stopController.signal, this.epoch.signal]);
      let release: (() => Promise<void>) | null = null;

      try {
        if (signal.aborted) {
          entry.lastInterrupted = true;
          this.finish(entry, started, 'interrupted', null);
          return;
        }
        if (entry.def.coordination === 'advisory') {
          const lock = await this.locks.tryAcquire(entry.def.name);
          if (!lock) {
            this.finish(entry, started, 'skipped', null);
            return;
          }
          release = () => lock.release();
          signal = AbortSignal.any([signal, lock.lost]);
        }
        // Остановка могла прийти, пока ждали блокировку, а блокировка — уже
        // потеряться. Задачу с прерванным сигналом не запускаем: часть задач
        // делает одно изменение и сигнал внутри не проверяет. Блокировка
        // освобождается в finally.
        if (signal.aborted) {
          entry.lastInterrupted = true;
          this.finish(entry, started, 'interrupted', null);
          return;
        }
        // Ворота восстановленной среды закрыты — внешних последствий нет (2.1.5).
        if (entry.def.externalEffects && !(await restoreGateOpen())) {
          this.finish(entry, started, 'skipped', null);
          return;
        }
        const result = await entry.def.run({ name: entry.def.name, signal });
        entry.lastInterrupted = signal.aborted;
        this.finish(entry, started, result.status, null, result);
      } catch (error) {
        entry.lastInterrupted = signal.aborted;
        // Отказ от `signal.throwIfAborted()` — это прерывание, а не ошибка
        // задачи. Настоящая ошибка, совпавшая по времени с остановкой,
        // остаётся ошибкой.
        if (signal.aborted && error === signal.reason) {
          this.finish(entry, started, 'interrupted', null);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        this.finish(entry, started, 'failed', message);
        this.logger.error({
          msg: 'фоновый проход не выполнен',
          job: entry.def.name,
          error,
        });
      } finally {
        if (release) await release().catch(() => undefined);
        entry.runningSince = null;
        entry.current = null;
      }
    };
    entry.current = run();
    return entry.current;
  }

  private finish(
    entry: Entry,
    started: number,
    status: PassStatus,
    error: string | null,
    result?: JobResult,
  ): void {
    const now = Date.now();
    entry.lastFinishedAt = now;
    entry.lastDurationMs = now - started;
    entry.lastStatus = status;
    entry.lastProcessed = result?.status === 'done' ? result.processed : result ? 0 : null;
    if (status === 'failed') {
      entry.lastError = error;
      entry.lastErrorAt = now;
      entry.consecutiveFailures += 1;
    } else if (status !== 'skipped' && status !== 'interrupted') {
      entry.lastSuccessAt = now;
      entry.consecutiveFailures = 0;
    }
  }
}

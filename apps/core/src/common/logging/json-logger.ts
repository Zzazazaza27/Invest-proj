import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import type { LoggerService } from '@nestjs/common';
import { safeFields, sanitizeText } from './safe-log';

/**
 * Структурированный журнал ядра (блок 8, 8.4; 2.1-W08b): одна строка JSON на
 * запись в stdout (ошибки и предупреждения — в stderr). systemd отдаёт вывод
 * в journald, оттуда его забирает архиватор. Поля — только из перечня
 * safe-log; время приёма journald ставит сам.
 */

export type LogLevel = 'error' | 'warn' | 'log' | 'debug' | 'verbose' | 'fatal';

export interface LogMeta {
  component: string;
  env: string;
  instance: string;
  version: string;
}

/**
 * Версия кода: RELEASE_SHA из окружения, иначе git рядом с кодом. Ошибка git
 * не превращается в пустую строку — в журнал идёт «unknown» (как комплекты
 * W07 после 2026-11-02).
 */
export function resolveVersion(cwd = process.cwd()): string {
  const fromEnv = process.env.RELEASE_SHA?.trim();
  if (fromEnv && /^[0-9a-f]{7,40}$/.test(fromEnv)) return fromEnv;
  const git = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const sha = (git.stdout ?? '').trim();
  return git.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : 'unknown';
}

export function defaultMeta(component: string): LogMeta {
  return {
    component,
    env: process.env.MONITOR_ENV || process.env.NODE_ENV || 'unknown',
    instance: `${hostname()}:${process.pid}`,
    version: resolveVersion(),
  };
}

type Write = (stream: 'out' | 'err', line: string) => void;

const writeStd: Write = (stream, line) => {
  (stream === 'err' ? process.stderr : process.stdout).write(`${line}\n`);
};

export class JsonLogger implements LoggerService {
  constructor(
    private readonly meta: LogMeta,
    private readonly levels: ReadonlySet<LogLevel> = new Set(['error', 'warn', 'log', 'fatal']),
    private readonly write: Write = writeStd,
  ) {}

  /** Запись с полями — для журнала запросов и аварий процесса. */
  record(level: LogLevel, ctx: string, fields: Record<string, unknown>): void {
    if (!this.levels.has(level)) return;
    const line = JSON.stringify({
      t: new Date().toISOString(),
      level,
      ...this.meta,
      ctx,
      ...safeFields(fields),
    });
    this.write(level === 'error' || level === 'warn' || level === 'fatal' ? 'err' : 'out', line);
  }

  log(message: unknown, ...rest: unknown[]): void {
    this.emit('log', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.emit('error', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.emit('warn', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.emit('debug', message, rest);
  }
  verbose(message: unknown, ...rest: unknown[]): void {
    this.emit('verbose', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.emit('fatal', message, rest);
  }

  /**
   * Вызов Nest: (сообщение, [стек для error], контекст). Контекст — последняя
   * строка; стек Nest передаёт строкой — из него берутся только кадры.
   */
  private emit(level: LogLevel, message: unknown, rest: unknown[]): void {
    const args = [...rest];
    const ctx = typeof args.at(-1) === 'string' ? (args.pop() as string) : 'app';
    const fields: Record<string, unknown> =
      message instanceof Error
        ? { msg: message.constructor?.name ?? 'Error', error: message }
        : message && typeof message === 'object'
          ? (message as Record<string, unknown>)
          : { msg: sanitizeText(String(message)) };
    const stack = args.find((a) => typeof a === 'string' && /\n\s+at /.test(a));
    if (stack && !('error' in fields)) fields.error = { stack };
    this.record(level, ctx, fields);
  }
}

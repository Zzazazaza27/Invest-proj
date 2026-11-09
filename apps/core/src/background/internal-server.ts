import { timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { getEnv } from '../config/env';
import { readGrant } from './grant';
import type { BackgroundJobsService } from './background-jobs.service';
import { checkReadiness, type ReadinessProbes } from './readiness';

/**
 * Служебный порт процесса: живость и состояние фоновых задач (блок 1, 1.2).
 *
 * Отдельный порт, а не маршрут публичного API: его не должно быть видно из
 * сети, и он отвечает и в роли `worker`, где публичного порта нет.
 *
 * `/live` проверяет только управляющий такт — свежесть отметки, которую
 * процесс ставит сам себе по таймеру. Если цикл событий завис, отметка
 * устаревает (или ответа нет вовсе). БД и внешние зависимости здесь не
 * проверяются намеренно: их отказ — повод для неготовности затронутой работы,
 * а не для перезапуска исправного процесса по кругу. Выключенный фон и долгая
 * задача такт не останавливают; долгая задача видна в `/jobs` как `overdue`.
 *
 * `/ready` — готовность по зависимостям с ограниченным ожиданием (см.
 * `readiness.ts`), `/queues` — размер и возраст очередей (блок 8, 8.3),
 * `/control` — контрольная операция: запись и файл со сверкой содержимого.
 * Оба — для Zabbix (2.1-W08a); наружу не публикуются.
 */
export interface InternalServer {
  readonly port: number;
  close(): Promise<void>;
}

/** Сколько публичных HTTP-запросов процесс сейчас обслуживает (блок 09, задание 3). */
export interface ProcessState {
  activeRequests: () => number;
}

/** Токен служебных команд: сравнение за постоянное время. */
function authorized(header: string | undefined, token: string | undefined): boolean {
  if (!token || !header?.startsWith('Bearer ')) return false;
  const given = Buffer.from(header.slice(7));
  const want = Buffer.from(token);
  return given.length === want.length && timingSafeEqual(given, want);
}

export async function startInternalServer(
  jobs: BackgroundJobsService,
  probes?: ReadinessProbes,
  state?: ProcessState,
): Promise<InternalServer> {
  const env = getEnv();
  const port = env.CORE_INTERNAL_PORT ?? env.CORE_PORT + 100;
  let lastTick = Date.now();
  const tick = setInterval(() => {
    lastTick = Date.now();
  }, env.BACKGROUND_TICK_MS);
  tick.unref();

  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    };
    // Команды изменения состояния фона (блок 09, задание 3): только POST, только с токеном
    // установщика. Порт слушает петлю; токен — вторая граница, если порт окажется доступен.
    const command = req.url === '/background/pause' || req.url === '/background/resume';
    if (command && req.method !== 'POST') return send(405, { error: 'method not allowed' });
    if (command) {
      if (!authorized(req.headers.authorization, env.BACKGROUND_CONTROL_TOKEN)) {
        process.stderr.write(
          `${JSON.stringify({ t: new Date().toISOString(), level: 'warn', msg: 'служебная команда фона без полномочий отклонена', url: req.url })}\n`,
        );
        return send(env.BACKGROUND_CONTROL_TOKEN ? 403 : 404, { error: 'forbidden' });
      }
      if (req.url === '/background/pause') {
        void jobs
          .pause(env.BACKGROUND_PAUSE_WAIT_MS)
          .then((mode) =>
            send(mode === 'paused' ? 200 : 409, { mode, pending: jobs.pendingPasses }),
          );
        return;
      }
      // Продолжение в режиме слотов — только при действующем разрешении этому слоту.
      if (env.BACKGROUND_START === 'grant') {
        const grant = readGrant(env.BACKGROUND_GRANT_PATH!, env.CORE_SLOT!);
        if (!grant.granted) return send(409, { mode: jobs.mode, error: grant.reason });
      }
      const mode = jobs.resume();
      return send(mode === 'running' ? 200 : 409, { mode, pending: jobs.pendingPasses });
    }
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });

    if (req.url === '/background') {
      return send(200, {
        mode: jobs.mode,
        pending: jobs.pendingPasses,
        slot: env.CORE_SLOT ?? null,
        start: env.BACKGROUND_START,
        instance: jobs.instanceId,
      });
    }
    if (req.url === '/state') {
      return send(200, {
        build: env.FIFTH_BUILD ?? null,
        slot: env.CORE_SLOT ?? null,
        activeRequests: state?.activeRequests() ?? null,
        background: jobs.mode,
      });
    }

    if (req.url === '/live') {
      const ageMs = Date.now() - lastTick;
      const live = ageMs <= env.BACKGROUND_LIVE_STALE_MS;
      return send(live ? 200 : 503, { live, tickAgeMs: ageMs });
    }
    if (req.url === '/jobs') {
      return send(200, {
        // Время процесса: просрочку и пропуски считают по нему, а не по часам
        // наблюдателя — расхождение часов не даёт ложных тревог.
        now: new Date().toISOString(),
        instance: jobs.instanceId,
        role: env.CORE_ROLE,
        backgroundEnabled: jobs.isStarted,
        stopping: jobs.isStopping,
        jobs: jobs.snapshot(),
      });
    }
    if (req.url === '/ready' && probes) {
      void checkReadiness(probes).then(
        (report) => send(report.ready ? 200 : 503, report),
        () => send(503, { ready: false, error: 'проверка готовности не выполнилась' }),
      );
      return;
    }
    if (req.url === '/control' && probes) {
      void probes.control().then(
        (report) => send(report.ok ? 200 : 503, report),
        () => send(503, { ok: false, error: 'контрольная операция не выполнилась' }),
      );
      return;
    }
    if (req.url === '/queues' && probes) {
      void probes.queues().then(
        (queues) => send(200, { queues }),
        () => send(503, { error: 'очереди недоступны' }),
      );
      return;
    }
    return send(404, { error: 'not found' });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, env.CORE_INTERNAL_BIND_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });

  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(tick);
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

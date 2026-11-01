import { createServer, type Server } from 'node:http';
import { getEnv } from '../config/env';
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
 * `readiness.ts`), `/queues` — размер и возраст очередей (блок 8, 8.3).
 * Оба — для Zabbix (2.1-W08a); наружу не публикуются.
 */
export interface InternalServer {
  readonly port: number;
  close(): Promise<void>;
}

export async function startInternalServer(
  jobs: BackgroundJobsService,
  probes?: ReadinessProbes,
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
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });

    if (req.url === '/live') {
      const ageMs = Date.now() - lastTick;
      const live = ageMs <= env.BACKGROUND_LIVE_STALE_MS;
      return send(live ? 200 : 503, { live, tickAgeMs: ageMs });
    }
    if (req.url === '/jobs') {
      return send(200, {
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

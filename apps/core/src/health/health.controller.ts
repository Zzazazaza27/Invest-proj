import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { publicReady } from './public-readiness';
import { HealthSchema, type Health } from '@fifth/contracts';
import { Public } from '../auth/guards';
import { Database } from '../db/unit-of-work';

/**
 * Проверка живости.
 *
 * Поле `service` — сигнатура: по нему внешние проверки (в том числе наш гейт
 * сетевой безопасности) отличают наш API от постороннего сервиса, занявшего
 * тот же порт. Без неё чужой 404 засчитывался бы как «наш API отвечает».
 *
 * Наружу не выдаются ни версии зависимостей, ни адреса, ни тексты ошибок —
 * только «ok»/«fail» по каждой проверке.
 */
@Controller()
export class HealthController {
  constructor(private readonly db: Database) {}

  @Public()
  @Get('health')
  async health(): Promise<Health> {
    const database = (await this.db.ping()) ? 'ok' : 'fail';
    const checks: Record<string, 'ok' | 'fail'> = { database };
    const status = Object.values(checks).every((v) => v === 'ok') ? 'ok' : 'degraded';

    return HealthSchema.parse({
      service: 'fifth-core',
      status,
      version: process.env.APP_VERSION ?? '0.1.0',
      checks,
    });
  }

  /**
   * Готовность API (2.3): кабинет подтверждает ею восстановление после общего отказа.
   * `/health` говорит лишь, что процесс отвечает; здесь — что API готов обслуживать
   * (обязательные зависимости и состояние процесса). 503 и `ready: false`, пока не готов.
   */
  @Public()
  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const ready = await publicReady();
    reply.header('Cache-Control', 'no-store');
    reply.status(ready ? 200 : 503);
    return { service: 'fifth-core', ready };
  }
}

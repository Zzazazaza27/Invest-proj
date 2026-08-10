import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/guards';
import { TokenVerifier } from './auth/token.verifier';
import { AuditRepository } from './audit/audit.repository';
import { CryptoService } from './crypto/crypto.service';
import { Database } from './db/unit-of-work';
import { HealthController } from './health/health.controller';
import { IdentityController } from './identity/identity.controller';
import { IdentityService } from './identity/identity.service';
import { PricingController } from './pricing/pricing.controller';

/**
 * Композиционный корень модульного монолита.
 *
 * `AuthGuard` подключён глобально: маршрут без явного `@Public()` требует
 * аутентификации. Это и есть «deny by default» на уровне конструкции, а не
 * дисциплины разработчика — забыть повесить guard физически нельзя, можно
 * только осознанно открыть маршрут.
 */
@Module({
  controllers: [HealthController, PricingController, IdentityController],
  providers: [
    Database,
    CryptoService,
    AuditRepository,
    TokenVerifier,
    IdentityService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}

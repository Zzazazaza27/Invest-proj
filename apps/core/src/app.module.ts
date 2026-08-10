import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { AuthGuard } from './auth/guards';
import { TokenVerifier } from './auth/token.verifier';
import { AiGatewayClient } from './ai/ai-gateway.client';
import { AnalysisController } from './ai/analysis.controller';
import { AnalysisService } from './ai/analysis.service';
import { AuditRepository } from './audit/audit.repository';
import { BillingController } from './billing/billing.controller';
import { BillingService } from './billing/billing.service';
import { CryptoService } from './crypto/crypto.service';
import { Database } from './db/unit-of-work';
import { HealthController } from './health/health.controller';
import { IdentityController } from './identity/identity.controller';
import { IdentityService } from './identity/identity.service';
import { InvestmentsController } from './investments/investments.controller';
import { InvestmentsService } from './investments/investments.service';
import { KycController } from './kyc/kyc.controller';
import { KycService } from './kyc/kyc.service';
import { CatalogController } from './lab/catalog.controller';
import { CatalogService } from './lab/catalog.service';
import { ProjectsController } from './lab/projects.controller';
import { ProjectsService } from './lab/projects.service';
import { PartitionMaintenanceService } from './maintenance/partitions.service';
import { PricingController } from './pricing/pricing.controller';
import { SeasonsController } from './seasons/seasons.controller';
import { SeasonsService } from './seasons/seasons.service';
import { S3Service } from './storage/s3.service';

/**
 * Композиционный корень модульного монолита.
 *
 * `AuthGuard` подключён глобально: маршрут без явного `@Public()` требует
 * аутентификации. Это и есть «deny by default» на уровне конструкции, а не
 * дисциплины разработчика — забыть повесить guard физически нельзя, можно
 * только осознанно открыть маршрут.
 */
@Module({
  controllers: [
    HealthController,
    PricingController,
    IdentityController,
    KycController,
    ProjectsController,
    CatalogController,
    SeasonsController,
    BillingController,
    AdminController,
    InvestmentsController,
    AnalysisController,
  ],
  providers: [
    Database,
    CryptoService,
    AuditRepository,
    TokenVerifier,
    S3Service,
    IdentityService,
    KycService,
    ProjectsService,
    CatalogService,
    SeasonsService,
    BillingService,
    AdminService,
    InvestmentsService,
    AiGatewayClient,
    AnalysisService,
    PartitionMaintenanceService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}

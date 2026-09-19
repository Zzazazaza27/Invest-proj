import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminController } from './admin/admin.controller';
import { AdminService } from './admin/admin.service';
import { DiscoveryModule } from '@nestjs/core';
import { DirectoryController } from './admin/directory.controller';
import { DirectoryService } from './admin/directory.service';
import { ProviderCredentialsService } from './ai/provider-credentials.service';
import { LocalizationService } from './ai/localization.service';
import { RolesController } from './admin/roles.controller';
import { RolesService } from './admin/roles.service';
import { SessionEpochService } from './auth/session-epoch.service';
import { TokenRevocationService } from './auth/token-revocation.service';
import { LoginThrottleService } from './auth/login-throttle.service';
import { TemplatesController } from './admin/templates.controller';
import { TemplatesService } from './admin/templates.service';
import { AuthGuard } from './auth/guards';
import { TokenVerifier } from './auth/token.verifier';
import { AiGatewayClient } from './ai/ai-gateway.client';
import { AnalysisController } from './ai/analysis.controller';
import { AnalysisService } from './ai/analysis.service';
import { AuditRepository } from './audit/audit.repository';
import { BillingController } from './billing/billing.controller';
import { BillingService } from './billing/billing.service';
import {
  AdminServiceCountriesController,
  MeServiceCountryController,
  ServiceCountriesController,
} from './billing/service-countries.controller';
import { ServiceCountriesService } from './billing/service-countries.service';
import {
  AdminRoundPackagesController,
  AdminRoundServiceOffersController,
  AdminRoundServicesController,
} from './billing/round-packages.controller';
import { RoundPackagesService } from './billing/round-packages.service';
import { RoundPricingService } from './billing/round-pricing.service';
import {
  AdminFeeOffsetRulesController,
  AdminFeeTermsController,
  AdminPlanCapabilitiesController,
} from './billing/commission.controller';
import { CommissionService, PlanCapabilitiesService } from './billing/commission.service';
import {
  AdminCapabilitiesController,
  MyCapabilitiesController,
} from './identity/capabilities.controller';
import { CapabilitiesService } from './identity/capabilities.service';
import { DealLedgerController } from './investments/deal-ledger.controller';
import { DealLedgerService } from './investments/deal-ledger.service';
import { FundingRoundsController } from './lab/funding-rounds.controller';
import { FundingRoundsService } from './lab/funding-rounds.service';
import { NotificationsController } from './comms/notifications.controller';
import { FavoritesController } from './lab/favorites.controller';
import { FavoritesService } from './lab/favorites.service';
import { SupportController } from './comms/support.controller';
import { SupportService } from './comms/support.service';
import { NotificationsService } from './comms/notifications.service';
import { CryptoService } from './crypto/crypto.service';
import { Database } from './db/unit-of-work';
import { NatsClient } from './events/nats.client';
import { OutboxPublisherService } from './events/publisher.service';
import { WebhookDeliveryService } from './events/webhook-delivery.service';
import { WebhooksService } from './events/webhooks.service';
import { ExpertsController } from './experts/experts.controller';
import { ExpertsService } from './experts/experts.service';
import { HealthController } from './health/health.controller';
import { OpenApiController } from './health/openapi.controller';
import { IdentityController } from './identity/identity.controller';
import { IdentityService } from './identity/identity.service';
import { PublicationConsentsController } from './identity/publication-consents.controller';
import { PublicationConsentsService } from './identity/publication-consents.service';
import { VerificationController } from './identity/verification.controller';
import { VerificationService } from './identity/verification.service';
import { MailThrottleService } from './auth/mail-throttle.service';
import { MailTransport, createMailTransport } from './comms/mail.transport';
import {
  IntegrationController,
  IntegrationTokenController,
} from './integration/integration.controller';
import { IntegrationService } from './integration/integration.service';
import { ContentService } from './content/content.service';
import {
  AdminContentController,
  AdminTextsController,
  ContentController,
} from './content/content.controller';
import { TextsService } from './content/texts.service';
import { ServiceAccountStateService } from './integration/service-account-state.service';
import { ServiceAccountsController } from './integration/service-accounts.controller';
import { InvestmentsController } from './investments/investments.controller';
import { InvestmentsService } from './investments/investments.service';
import { KycController } from './kyc/kyc.controller';
import { KycService } from './kyc/kyc.service';
import { CatalogController } from './lab/catalog.controller';
import { CatalogService } from './lab/catalog.service';
import { ProjectAccessController } from './lab/project-access.controller';
import { ProjectAccessService } from './lab/project-access.service';
import { ProjectViewsController } from './lab/project-views.controller';
import { ProjectViewsService } from './lab/project-views.service';
import { ProjectsController } from './lab/projects.controller';
import { ProjectsService } from './lab/projects.service';
import {
  AdminApplicationPoliciesController,
  AdminReadinessConfigsController,
  ApplicationsController,
} from './lab/applications.controller';
import { ApplicationsService } from './lab/applications.service';
import {
  AdminApplicationFormsController,
  ApplicationFormController,
} from './lab/application-forms.controller';
import { ApplicationFormsService } from './lab/application-forms.service';
import { FeaturesController } from './health/features.controller';
import { PartitionMaintenanceService } from './maintenance/partitions.service';
import { StorageJanitorService } from './maintenance/storage-janitor.service';
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
  // DiscoveryModule нужен описанию API: перечень маршрутов снимается с живого
  // графа контроллеров, а не переписывается руками.
  imports: [DiscoveryModule],
  controllers: [
    HealthController,
    PricingController,
    ContentController,
    AdminContentController,
    AdminTextsController,
    IdentityController,
    PublicationConsentsController,
    VerificationController,
    KycController,
    ProjectsController,
    ApplicationsController,
    AdminApplicationPoliciesController,
    ApplicationFormController,
    AdminApplicationFormsController,
    AdminReadinessConfigsController,
    FeaturesController,
    CatalogController,
    ProjectAccessController,
    ProjectViewsController,
    SeasonsController,
    BillingController,
    ServiceCountriesController,
    MeServiceCountryController,
    AdminServiceCountriesController,
    AdminRoundServicesController,
    AdminRoundPackagesController,
    AdminRoundServiceOffersController,
    AdminFeeTermsController,
    AdminFeeOffsetRulesController,
    AdminPlanCapabilitiesController,
    AdminCapabilitiesController,
    MyCapabilitiesController,
    DealLedgerController,
    FundingRoundsController,
    AdminController,
    InvestmentsController,
    AnalysisController,
    ExpertsController,
    NotificationsController,
    SupportController,
    FavoritesController,
    IntegrationController,
    IntegrationTokenController,
    ServiceAccountsController,
    DirectoryController,
    RolesController,
    TemplatesController,
    OpenApiController,
  ],
  providers: [
    Database,
    CryptoService,
    AuditRepository,
    TokenVerifier,
    SessionEpochService,
    TokenRevocationService,
    LoginThrottleService,
    S3Service,
    IdentityService,
    PublicationConsentsService,
    VerificationService,
    MailThrottleService,
    // Реализация выбирается по MAIL_TRANSPORT: почтового сервера у платформы
    // ещё нет, и это состояние названо явно — маршруты отвечают 503, а не
    // изображают отправку.
    { provide: MailTransport, useFactory: createMailTransport },
    KycService,
    ProjectsService,
    ApplicationsService,
    ApplicationFormsService,
    CatalogService,
    ProjectAccessService,
    ProjectViewsService,
    SeasonsService,
    BillingService,
    ServiceCountriesService,
    RoundPackagesService,
    RoundPricingService,
    CommissionService,
    PlanCapabilitiesService,
    CapabilitiesService,
    DealLedgerService,
    FundingRoundsService,
    AdminService,
    DirectoryService,
    ProviderCredentialsService,
    LocalizationService,
    RolesService,
    TemplatesService,
    InvestmentsService,
    AiGatewayClient,
    AnalysisService,
    ExpertsService,
    NotificationsService,
    SupportService,
    FavoritesService,
    IntegrationService,
    ServiceAccountStateService,
    ContentService,
    TextsService,
    NatsClient,
    WebhooksService,
    OutboxPublisherService,
    WebhookDeliveryService,
    StorageJanitorService,
    PartitionMaintenanceService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}

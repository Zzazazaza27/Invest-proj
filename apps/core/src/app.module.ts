import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AdminController } from './admin/admin.controller';
import { AvailabilityController } from './availability/availability.controller';
import { AvailabilityService } from './availability/availability.service';
import { AdminService } from './admin/admin.service';
import { DiscoveryModule } from '@nestjs/core';
import { DirectoryController } from './admin/directory.controller';
import { DirectoryService } from './admin/directory.service';
import { AdminUsersController } from './admin/users.controller';
import { AdminUsersService } from './admin/users.service';
import { ProfileController, UserAvatarController } from './identity/profile.controller';
import { ProfileService } from './identity/profile.service';
import { RolesController } from './admin/roles.controller';
import { RolesService } from './admin/roles.service';
import { SessionEpochService } from './auth/session-epoch.service';
import { TokenRevocationService } from './auth/token-revocation.service';
import { LoginThrottleService } from './auth/login-throttle.service';
import { TemplatesController } from './admin/templates.controller';
import { TemplatesService } from './admin/templates.service';
import { AuthGuard } from './auth/guards';
import { AccessContextService } from './auth/access-context.service';
import { TestingController } from './testing/testing.controller';
import { IntelligenceController } from './intelligence/intelligence.controller';
import { IntelligenceService } from './intelligence/intelligence.service';
import { TestingSessionsService } from './testing/testing-sessions.service';
import { TokenVerifier } from './auth/token.verifier';
import { AuditRepository } from './audit/audit.repository';
import {
  AdminServiceCountriesController,
  MeServiceCountryController,
  ServiceCountriesController,
} from './billing/service-countries.controller';
import { ServiceCountriesService } from './billing/service-countries.service';
import {
  AdminCapabilitiesController,
  MyCapabilitiesController,
} from './identity/capabilities.controller';
import { CapabilitiesService } from './identity/capabilities.service';
import { NotificationsController } from './comms/notifications.controller';
import { FavoritesController } from './lab/favorites.controller';
import { FavoritesService } from './lab/favorites.service';
import { SupportController } from './comms/support.controller';
import { MailQueueService } from './comms/mail-queue.service';
import { SupportService } from './comms/support.service';
import { NotificationsService } from './comms/notifications.service';
import { CryptoService } from './crypto/crypto.service';
import { Database } from './db/unit-of-work';
import { NatsClient } from './events/nats.client';
import { BackgroundJobsService } from './background/background-jobs.service';
import { OutboxPublisherService } from './events/publisher.service';
import { WebhookDeliveryService } from './events/webhook-delivery.service';
import { WebhooksService } from './events/webhooks.service';
import { HealthController } from './health/health.controller';
import { OpenApiController } from './health/openapi.controller';
import { IdentityController } from './identity/identity.controller';
import { IdentityService } from './identity/identity.service';
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
import { MaterialUploadsService } from './lab/material-uploads.service';
import { UploadCopyCleanupService } from './lab/upload-copy-cleanup.service';
import { OperationsController } from './lab/operations.controller';
import { RequestKeysController } from './lab/request-keys.controller';
import { UploadOperationsService } from './lab/upload-operations.service';
import { ProjectMediaController } from './lab/project-media.controller';
import { ProjectMediaService } from './lab/project-media.service';
import { FeaturesController } from './health/features.controller';
import { ClientErrorsController } from './health/client-errors.controller';
import { PartitionMaintenanceService } from './maintenance/partitions.service';
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
    TestingController,
    IntelligenceController,
    ContentController,
    AdminContentController,
    AdminTextsController,
    IdentityController,
    VerificationController,
    KycController,
    ProjectsController,
    OperationsController,
    RequestKeysController,
    FeaturesController,
    ClientErrorsController,
    CatalogController,
    ProjectAccessController,
    ProjectViewsController,
    ServiceCountriesController,
    MeServiceCountryController,
    AdminServiceCountriesController,
    ProjectMediaController,
    AdminCapabilitiesController,
    MyCapabilitiesController,
    AdminController,
    AvailabilityController,
    NotificationsController,
    SupportController,
    FavoritesController,
    IntegrationController,
    IntegrationTokenController,
    ServiceAccountsController,
    DirectoryController,
    AdminUsersController,
    ProfileController,
    UserAvatarController,
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
    AccessContextService,
    TestingSessionsService,
    IntelligenceService,
    LoginThrottleService,
    S3Service,
    AvailabilityService,
    IdentityService,
    VerificationService,
    MailThrottleService,
    // Реализация выбирается по MAIL_TRANSPORT: почтового сервера у платформы
    // ещё нет, и это состояние названо явно — маршруты отвечают 503, а не
    // изображают отправку.
    { provide: MailTransport, useFactory: createMailTransport },
    KycService,
    ProjectsService,
    MaterialUploadsService,
    UploadCopyCleanupService,
    UploadOperationsService,
    CatalogService,
    ProjectAccessService,
    ProjectViewsService,
    ServiceCountriesService,
    ProjectMediaService,
    CapabilitiesService,
    AdminService,
    DirectoryService,
    AdminUsersService,
    ProfileService,
    RolesService,
    TemplatesService,
    NotificationsService,
    SupportService,
    MailQueueService,
    FavoritesService,
    IntegrationService,
    ServiceAccountStateService,
    ContentService,
    TextsService,
    NatsClient,
    WebhooksService,
    BackgroundJobsService,
    OutboxPublisherService,
    WebhookDeliveryService,
    PartitionMaintenanceService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule {}

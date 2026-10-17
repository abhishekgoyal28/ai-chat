import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { buildDataSourceOptions } from '../shared/database/data-source';
import { ALL_ENTITIES } from '../shared/database/entities';
import { healthModule } from '../shared/observability/health';
import { QueueModule } from '../shared/queue/queue.module';
import { QUEUE_TRANSPORT, QueueTransport } from '../shared/queue/queue-transport';
import { REDIS_CLIENT, RedisModule } from '../shared/redis/redis.providers';
import { AdminAuthController } from './admin/controllers/admin-auth.controller';
import { AdminConfigController } from './admin/controllers/admin-config.controller';
import { AdminPlatformController } from './admin/controllers/admin-platform.controller';
import {
  AgentAdminRepository,
  ConfigRevisionRepository,
  KnowledgeRepository,
  PersonaRepository,
  PromptRepository,
  ProviderRepository,
} from './admin/repositories/config.repositories';
import { AccessAdminService } from './admin/services/access-admin.service';
import { AgentAdminService } from './admin/services/agent-admin.service';
import { ConversationAdminService } from './admin/services/conversation-admin.service';
import { KnowledgeAdminService } from './admin/services/knowledge-admin.service';
import { OverviewService } from './admin/services/overview.service';
import { PersonaAdminService } from './admin/services/persona-admin.service';
import { PlaygroundService } from './admin/services/playground.service';
import { PreviewService } from './admin/services/preview.service';
import { PromptAdminService } from './admin/services/prompt-admin.service';
import { ProviderAdminService } from './admin/services/provider-admin.service';
import { RevisionRecorder } from './admin/services/revision-recorder.service';
import { AgentRuntimeRepository } from './agents/agent-runtime.repository';
import { AgentRuntimeService } from './agents/agent-runtime.service';
import { AdminAuthGuard } from './auth/admin-auth.guard';
import { AdminAuthService } from './auth/admin-auth.service';
import { AdminUserRepository } from './auth/admin-user.repository';
import { ApiKeyRepository } from './auth/api-key.repository';
import { ClientSessionGuard } from './auth/client-session.guard';
import { HostApiKeyGuard } from './auth/host-api-key.guard';
import { ClientApiController } from './client-api/client-api.controller';
import { ConversationConsumers } from './conversation/conversation.consumers';
import { ConversationRepository } from './conversation/repositories/conversation.repository';
import { MessageRepository } from './conversation/repositories/message.repository';
import { ConversationPublisher } from './conversation/services/conversation-publisher.service';
import { DataLifecycleService } from './conversation/services/data-lifecycle.service';
import { GenerationDispatcher } from './conversation/services/generation-dispatcher.service';
import { GreetingService } from './conversation/services/greeting.service';
import { HistoryService } from './conversation/services/history.service';
import { InboundHandler } from './conversation/services/inbound-handler.service';
import { ResponseHandler } from './conversation/services/response-handler.service';
import { RevealHandler } from './conversation/services/reveal-handler.service';
import { RevealScheduler } from './conversation/services/reveal-scheduler.service';
import { SessionEndService } from './conversation/services/session-end.service';
import { SessionService } from './conversation/services/session.service';
import { SweeperService } from './conversation/services/sweeper.service';
import { HostApiController } from './host-api/host-api.controller';
import { ActionRunnerService } from './integrations/action-runner.service';
import { ActionInvocationRepository, UserDeviceRepository } from './integrations/integration.repositories';
import { PushService } from './integrations/push.service';
import { WebhookService } from './integrations/webhook.service';
import { PlatformSettingsRepository } from './platform/platform-settings.repository';
import { PlatformSettingsService } from './platform/platform-settings.service';

const repositories = [
  ConversationRepository,
  MessageRepository,
  AgentRuntimeRepository,
  ApiKeyRepository,
  AdminUserRepository,
  PlatformSettingsRepository,
  UserDeviceRepository,
  ActionInvocationRepository,
  AgentAdminRepository,
  PersonaRepository,
  PromptRepository,
  KnowledgeRepository,
  ProviderRepository,
  ConfigRevisionRepository,
];

const conversationServices = [
  AgentRuntimeService,
  ConversationPublisher,
  RevealScheduler,
  GenerationDispatcher,
  GreetingService,
  SessionEndService,
  SessionService,
  ResponseHandler,
  RevealHandler,
  InboundHandler,
  HistoryService,
  SweeperService,
  DataLifecycleService,
  ConversationConsumers,
];

const integrationServices = [PlatformSettingsService, WebhookService, PushService, ActionRunnerService];

const adminServices = [
  AdminAuthService,
  RevisionRecorder,
  PreviewService,
  AgentAdminService,
  PersonaAdminService,
  PromptAdminService,
  KnowledgeAdminService,
  ProviderAdminService,
  ConversationAdminService,
  AccessAdminService,
  PlaygroundService,
  OverviewService,
];

/**
 * chat-app: the host API, the client API, the dashboard and its API, and the
 * three conversation consumers (inbound, responses, reveals) plus the sweeper.
 * It owns every write to the conversation tables.
 */
@Module({
  imports: [
    TypeOrmModule.forRoot(buildDataSourceOptions()),
    TypeOrmModule.forFeature(ALL_ENTITIES),
    ScheduleModule.forRoot(),
    RedisModule,
    QueueModule,
    healthModule({
      inject: [DataSource, REDIS_CLIENT, QUEUE_TRANSPORT],
      useFactory: (dataSource: DataSource, redis: Redis, queue: QueueTransport) => [
        { name: 'database', check: async () => Boolean(await dataSource.query('SELECT 1')) },
        { name: 'redis', check: async () => (await redis.ping()) === 'PONG' },
        { name: 'queue', check: () => queue.ping() },
      ],
    }),
  ],
  controllers: [HostApiController, ClientApiController, AdminAuthController, AdminConfigController, AdminPlatformController],
  providers: [
    ...repositories,
    ...conversationServices,
    ...integrationServices,
    ...adminServices,
    HostApiKeyGuard,
    ClientSessionGuard,
    AdminAuthGuard,
  ],
})
export class ChatAppModule {}

import { z } from 'zod';
import { agentSettingsSchema, modelRoutesSchema } from '../../shared/domain/agent-settings';
import { AdminRole, LlmProviderKind, PushMode, RecordStatus } from '../../shared/domain/enums';
import { MIN_PASSWORD_LENGTH } from '../auth/admin-auth.service';
import { WebhookEvent } from '../platform/platform-settings.service';

const idSchema = z.string().regex(/^\d{1,20}$/);
const expectedRevision = z.number().int().min(1);
const optionalText = (max: number) => z.string().max(max).nullable().optional();

export const loginSchema = z.object({ email: z.string().email().max(191), password: z.string().min(1).max(200) });

/** Google appends other parameters (scope, authuser, prompt); they are ignored. */
export const googleCallbackQuerySchema = z.object({
  code: z.string().min(1).max(2048).optional(),
  state: z.string().min(1).max(2048).optional(),
  error: z.string().max(200).optional(),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(200),
});

export const agentSlugSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$/, 'lowercase letters, digits and hyphens, 3-80 characters');

export const agentInputSchema = z.object({
  slug: agentSlugSchema,
  name: z.string().min(1).max(120),
  description: optionalText(500),
  status: z.nativeEnum(RecordStatus).default(RecordStatus.ACTIVE),
  personaId: idSchema,
  domainPromptId: idSchema.nullable().default(null),
  modelRoutes: modelRoutesSchema.default([]),
  settings: agentSettingsSchema.default({}),
});
export const agentUpdateSchema = agentInputSchema.extend({ expectedRevision });

export const personaInputSchema = z.object({
  name: z.string().min(1).max(120),
  displayName: z.string().min(1).max(120),
  avatarUrl: z.string().url().max(1000).nullable().optional(),
  tagline: optionalText(255),
  prompt: z.string().min(1).max(100_000),
});
export const personaUpdateSchema = personaInputSchema.extend({ expectedRevision });

export const promptInputSchema = z.object({
  name: z.string().min(1).max(120),
  description: optionalText(500),
  text: z.string().min(1).max(200_000),
});
export const promptUpdateSchema = promptInputSchema.extend({ expectedRevision });
export const masterPromptUpdateSchema = z.object({ text: z.string().min(1).max(200_000), expectedRevision });

export const knowledgeBaseInputSchema = z.object({ name: z.string().min(1).max(120), description: optionalText(500) });
export const knowledgeBaseUpdateSchema = knowledgeBaseInputSchema.extend({ expectedRevision });

export const knowledgeDocumentInputSchema = z.object({
  title: z.string().min(1).max(255),
  /** 2 MB of text is far beyond any prompt budget, and keeps a mistaken upload from filling the table. */
  content: z.string().min(1).max(2_000_000),
  status: z.nativeEnum(RecordStatus).default(RecordStatus.ACTIVE),
  position: z.number().int().min(0).max(100_000).optional(),
});
export const knowledgeDocumentUpdateSchema = knowledgeDocumentInputSchema.extend({ expectedRevision });

const providerSettingsSchema = z
  .object({
    location: z.string().max(60).optional(),
    organization: z.string().max(120).optional(),
    refusalFallback: z.boolean().optional(),
    headers: z.record(z.string().max(100), z.string().max(1000)).optional(),
  })
  .default({});

export const providerInputSchema = z.object({
  name: z.string().min(1).max(120),
  kind: z.nativeEnum(LlmProviderKind),
  baseUrl: z.string().url().max(500).nullable().optional(),
  /** Write-only. Omit to keep the stored value, null to clear it. */
  credentials: z.string().min(1).max(20_000).nullable().optional(),
  defaultModel: optionalText(120),
  settings: providerSettingsSchema,
  status: z.nativeEnum(RecordStatus).default(RecordStatus.ACTIVE),
});
export const providerUpdateSchema = providerInputSchema.extend({ expectedRevision });
export const providerTestSchema = z.object({ model: z.string().min(1).max(120).optional() });

export const apiKeyCreateSchema = z.object({ name: z.string().min(1).max(120) });

export const teamMemberCreateSchema = z.object({
  email: z.string().email().max(191),
  name: z.string().min(1).max(120),
  role: z.nativeEnum(AdminRole),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200),
});
export const teamMemberUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  role: z.nativeEnum(AdminRole).optional(),
  status: z.nativeEnum(RecordStatus).optional(),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(200).optional(),
});

export const webhookSettingsSchema = z.object({
  url: z.string().url().max(1000).nullable(),
  secret: z.string().min(16).max(200).nullable().optional(),
  events: z.array(z.nativeEnum(WebhookEvent)).default(Object.values(WebhookEvent)),
});
export const pushSettingsSchema = z.object({
  mode: z.nativeEnum(PushMode),
  fcmServiceAccount: z.string().min(20).max(20_000).nullable().optional(),
  titleTemplate: z.string().min(1).max(120).default('{{agent.name}}'),
});
export const retentionSettingsSchema = z.object({ endedConversationDays: z.number().int().min(1).max(3650).nullable() });

export const conversationListQuerySchema = z.object({
  agentId: idSchema.optional(),
  externalUserId: z.string().max(191).optional(),
  status: z.enum(['ACTIVE', 'ENDED']).optional(),
  before: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const historyEntrySchema = z.object({ role: z.enum(['USER', 'AGENT']), body: z.string().min(1).max(8000) });

export const playgroundSchema = z.object({
  kind: z.enum(['REPLY', 'GREETING', 'FAREWELL']).default('REPLY'),
  agent: z.object({
    agentId: idSchema.nullable().default(null),
    name: z.string().min(1).max(120),
    personaId: idSchema,
    /** Unsaved overrides; omitted fields come from the saved rows. */
    personaPrompt: z.string().max(100_000).optional(),
    domainPromptId: idSchema.nullable().default(null),
    domainPromptText: z.string().max(200_000).optional(),
    masterPromptText: z.string().max(200_000).optional(),
    modelRoutes: modelRoutesSchema.default([]),
    settings: agentSettingsSchema.default({}),
  }),
  message: z.string().max(8000).optional(),
  history: z.array(historyEntrySchema).max(50).default([]),
  user: z.object({ name: z.string().max(191).optional(), attributes: z.record(z.string().max(64), z.string().max(500)).optional() }).default({}),
  context: z.object({ title: z.string().max(300).optional(), text: z.string().max(20_000).optional() }).optional(),
});

export const testSessionSchema = z.object({ agentSlug: agentSlugSchema, fresh: z.boolean().default(true) });

export const revisionRestoreSchema = z.object({ revision: z.number().int().min(1) });

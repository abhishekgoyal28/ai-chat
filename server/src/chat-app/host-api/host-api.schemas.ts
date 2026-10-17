import { z } from 'zod';
import { DevicePlatform } from '../../shared/domain/enums';

const MAX_CONTEXT_TEXT_CHARS = 20_000;
const MAX_ATTRIBUTES = 30;

/** Host-defined facts about the user. Values are strings: they are rendered into the prompt as-is. */
export const userAttributesSchema = z
  .record(z.string().min(1).max(64), z.string().max(500))
  .refine((value) => Object.keys(value).length <= MAX_ATTRIBUTES, `at most ${MAX_ATTRIBUTES} attributes`);

export const contextSchema = z
  .object({
    title: z.string().max(300).optional(),
    text: z.string().max(MAX_CONTEXT_TEXT_CHARS).optional(),
    data: z.record(z.unknown()).optional(),
  })
  .refine((value) => JSON.stringify(value).length <= 32_000, 'context must serialise to at most 32 KB');

export const externalUserIdSchema = z.string().min(1).max(191);

export const startSessionSchema = z.object({
  /** The agent's slug, as shown in the dashboard. */
  agent: z.string().min(1).max(80),
  user: z.object({
    id: externalUserIdSchema,
    name: z.string().max(191).optional(),
    attributes: userAttributesSchema.optional(),
  }),
  /** Your key for what this conversation is about. Same user + agent + scope = same conversation. */
  scope: z.string().max(191).optional(),
  context: contextSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type StartSessionBody = z.infer<typeof startSessionSchema>;

export const updateContextSchema = z
  .object({
    user: z.object({ name: z.string().max(191).nullable().optional(), attributes: userAttributesSchema.nullable().optional() }).optional(),
    context: contextSchema.nullable().optional(),
  })
  .refine((value) => value.user !== undefined || value.context !== undefined, 'nothing to update');

export const registerDeviceSchema = z.object({
  platform: z.nativeEnum(DevicePlatform),
  token: z.string().min(10).max(1024),
});

export const listSessionsQuerySchema = z.object({
  before: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const transcriptQuerySchema = z.object({
  before: z.string().regex(/^\d+$/).optional(),
  after: z.string().regex(/^\d+$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

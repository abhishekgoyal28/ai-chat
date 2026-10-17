import { z } from 'zod';

/**
 * Everything an operator can tune about an agent's behaviour, stored as one
 * JSON column on `agents.settings` and edited from the dashboard.
 *
 * The schema IS the contract: the dashboard validates against it, the admin
 * API rejects anything it does not accept, and every reader parses through
 * `parseAgentSettings()` so an older row missing a newer key gets that key's
 * default instead of `undefined`. Add a setting here and every reader sees it.
 */

export enum GreetingMode {
  /** The conversation opens with an empty transcript. */
  NONE = 'NONE',
  /** A fixed message with {{variables}}, written instantly at session start. */
  TEMPLATE = 'TEMPLATE',
  /** The model writes the opening message; it arrives over the socket a moment later. */
  LLM = 'LLM',
}

export enum FarewellMode {
  /** The session just ends — no closing message. */
  NONE = 'NONE',
  /** `farewell.fallbackText` is posted as the closing message. */
  FIXED = 'FIXED',
  /** The model writes the closing message from the conversation; `fallbackText` covers a failure. */
  LLM = 'LLM',
}

export enum ChipsSource {
  NONE = 'NONE',
  /** `chips.items`, as written by the operator. */
  STATIC = 'STATIC',
  /** Generated together with an LLM greeting. Falls back to `chips.items`. */
  LLM = 'LLM',
}

export enum ReasoningEffort {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

/** Hard ceilings, whatever an operator types. Keep the dashboard's input limits in step. */
export const AGENT_LIMITS = {
  minSessionDurationSec: 30,
  maxSessionDurationSec: 60 * 60 * 24 * 30,
  maxReplyParts: 8,
  maxPartChars: 4000,
  maxChips: 8,
  maxChipChars: 80,
  maxHistoryTurns: 50,
  maxMessagesPerTurn: 20,
  maxBodyChars: 8000,
  maxActions: 10,
  maxActionParameters: 8,
  maxKnowledgeTotalChars: 400_000,
} as const;

const ACTION_NAME_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;

const actionParameterSchema = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/, 'letters, digits and underscores, starting with a letter'),
  description: z.string().max(300).default(''),
  required: z.boolean().default(true),
});

export const agentActionSchema = z.object({
  name: z.string().regex(ACTION_NAME_PATTERN, 'lower_snake_case, 2-48 characters'),
  /** Told to the model verbatim: what the action does and exactly when to trigger it. */
  description: z.string().min(1).max(2000),
  parameters: z.array(actionParameterSchema).max(AGENT_LIMITS.maxActionParameters).default([]),
  /** Null means unlimited. */
  maxPerConversation: z.number().int().min(1).max(100).nullable().default(1),
  enabled: z.boolean().default(true),
});

export type AgentActionDefinition = z.infer<typeof agentActionSchema>;

export const agentSettingsSchema = z.object({
  session: z
    .object({
      /**
       * Wall-clock length from the moment the session opens. Null means the
       * session never ends on its own — it continues until the user, the host
       * or an operator ends it.
       */
      durationSec: z
        .number()
        .int()
        .min(AGENT_LIMITS.minSessionDurationSec)
        .max(AGENT_LIMITS.maxSessionDurationSec)
        .nullable()
        .default(null),
    })
    .default({}),

  greeting: z
    .object({
      mode: z.nativeEnum(GreetingMode).default(GreetingMode.TEMPLATE),
      /** TEMPLATE mode. Supports {{user.name}}, {{agent.name}} and {{context.title}}. */
      template: z.string().max(2000).default('Hi {{user.name}}! How can I help you today?'),
      /** LLM mode: how the model should open the conversation. */
      instructions: z
        .string()
        .max(4000)
        .default('Greet the user warmly in one short message and invite their question.'),
    })
    .default({}),

  chips: z
    .object({
      source: z.nativeEnum(ChipsSource).default(ChipsSource.NONE),
      items: z.array(z.string().min(1).max(AGENT_LIMITS.maxChipChars)).max(20).default([]),
      count: z.number().int().min(1).max(AGENT_LIMITS.maxChips).default(3),
    })
    .default({}),

  farewell: z
    .object({
      mode: z.nativeEnum(FarewellMode).default(FarewellMode.LLM),
      instructions: z
        .string()
        .max(4000)
        .default(
          'Close the conversation warmly in one or two short messages: briefly acknowledge what was discussed and say goodbye. Do not ask questions — the user cannot reply.',
        ),
      /** Posted in FIXED mode, and in LLM mode when generation fails or times out. */
      fallbackText: z.string().min(1).max(2000).default('Thanks for chatting! This conversation has now ended.'),
      /** Body of the SYSTEM divider row clients render where the session ended. */
      dividerText: z.string().min(1).max(200).default('Conversation ended'),
    })
    .default({}),

  language: z
    .object({
      /** One instruction, told to the model as-is. */
      instruction: z.string().max(1000).default('Reply in the same language the user writes in.'),
    })
    .default({}),

  reply: z
    .object({
      /** Upper bound on chat bubbles per reply. The prompt asks for as few as the answer needs. */
      maxParts: z.number().int().min(1).max(AGENT_LIMITS.maxReplyParts).default(4),
      maxPartChars: z.number().int().min(40).max(AGENT_LIMITS.maxPartChars).default(600),
      /** Null leaves the provider default. Ignored by models that do not accept it. */
      temperature: z.number().min(0).max(2).nullable().default(null),
      maxOutputTokens: z.number().int().min(64).max(32000).default(2048),
      /** Null leaves the provider default. Only reasoning-capable models read it. */
      reasoningEffort: z.nativeEnum(ReasoningEffort).nullable().default(null),
    })
    .default({}),

  history: z
    .object({
      /** Previous turns sent with each request. A turn is one user batch plus its reply. */
      turns: z.number().int().min(0).max(AGENT_LIMITS.maxHistoryTurns).default(12),
    })
    .default({}),

  knowledge: z
    .object({
      knowledgeBaseIds: z.array(z.string().regex(/^\d+$/)).max(20).default([]),
      maxCharsPerDocument: z.number().int().min(500).max(AGENT_LIMITS.maxKnowledgeTotalChars).default(20_000),
      maxTotalChars: z.number().int().min(1000).max(AGENT_LIMITS.maxKnowledgeTotalChars).default(80_000),
    })
    .default({}),

  client: z
    .object({
      /** Quiet period after the last keystroke-send before the batch goes out as one turn. */
      debounceMs: z.number().int().min(0).max(30_000).default(1500),
      /** Extra hold while the user is still typing. */
      typingHoldMs: z.number().int().min(0).max(60_000).default(4000),
      /** A batch never waits longer than this in total. */
      maxTurnWaitMs: z.number().int().min(0).max(120_000).default(15_000),
      maxMessagesPerTurn: z.number().int().min(1).max(AGENT_LIMITS.maxMessagesPerTurn).default(10),
      maxBodyChars: z.number().int().min(1).max(AGENT_LIMITS.maxBodyChars).default(2000),
    })
    .default({}),

  pacing: z
    .object({
      /** Reveal multi-part replies one bubble at a time, like someone typing. */
      enabled: z.boolean().default(true),
      msPerChar: z.number().int().min(0).max(200).default(25),
      maxDelayMs: z.number().int().min(0).max(10_000).default(2000),
    })
    .default({}),

  actions: z.array(agentActionSchema).max(AGENT_LIMITS.maxActions).default([]),
});

export type AgentSettings = z.infer<typeof agentSettingsSchema>;
export type AgentSettingsInput = z.input<typeof agentSettingsSchema>;

/**
 * Parses stored or submitted settings, filling every default. Throws a ZodError
 * on invalid input — the admin API turns that into a 400 with field paths.
 */
export const parseAgentSettings = (raw: unknown): AgentSettings => agentSettingsSchema.parse(raw ?? {});

/**
 * Lenient read for rows already in the database: a row written by an older
 * build that no longer validates falls back to defaults key by key rather than
 * taking the agent offline.
 */
export const readStoredAgentSettings = (raw: unknown): AgentSettings => {
  const strict = agentSettingsSchema.safeParse(raw ?? {});
  if (strict.success) {
    return strict.data;
  }
  const defaults = agentSettingsSchema.parse({});
  const source = (raw ?? {}) as Record<string, unknown>;
  const merged: Record<string, unknown> = {};
  for (const key of Object.keys(defaults) as Array<keyof AgentSettings>) {
    const section = agentSettingsSchema.shape[key].safeParse(source[key]);
    merged[key] = section.success ? section.data : defaults[key];
  }
  return merged as AgentSettings;
};

/** Client-facing subset — what the SDK needs to batch and validate before sending. */
export type ClientBehaviour = AgentSettings['client'];

export interface ModelRoute {
  providerId: string;
  model: string;
  /** Relative share of new conversations. Routes with weight 0 never receive traffic. */
  weight: number;
}

export const modelRouteSchema = z.object({
  providerId: z.string().regex(/^\d+$/),
  model: z.string().min(1).max(120),
  weight: z.number().int().min(0).max(100).default(100),
});

export const modelRoutesSchema = z.array(modelRouteSchema).max(10);

/**
 * The chat-app ↔ chat-expert queue contract. Both sides import this file and
 * nothing else defines these shapes.
 *
 *   generation-requests   chat-app → chat-expert
 *   generation-responses  chat-expert → chat-app
 *
 * What travels vs what chat-expert fetches itself:
 *   - payload: per-conversation and small — the turn, history, user, host
 *     context, the pinned model route.
 *   - fetched: static configuration, cached — agent, persona, prompts and
 *     knowledge documents (knowledge can be far larger than a queue message).
 *
 * chat-expert writes nothing to the database and generates no ids. Reply turn
 * ids are derived by chat-app from the request turn id, so a redelivered
 * response re-derives the same id and its insert dies on the unique key.
 *
 * DEPLOY ORDER: consumer before producer. Widen SUPPORTED_*_VERSIONS and
 * deploy chat-expert first, then chat-app emitting the new version.
 */

export const GENERATION_SCHEMA_VERSION = 1;
export const SUPPORTED_REQUEST_VERSIONS: ReadonlySet<number> = new Set([1]);
export const SUPPORTED_RESPONSE_VERSIONS: ReadonlySet<number> = new Set([1]);

export enum GenerationKind {
  /** Answer the user's outstanding messages. */
  REPLY = 'REPLY',
  /** Open the conversation (agent greeting mode LLM). */
  GREETING = 'GREETING',
  /** Close the conversation (agent farewell mode LLM). */
  FAREWELL = 'FAREWELL',
}

export enum GenerationStatus {
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

export enum GenerationFailureReason {
  TIMEOUT = 'TIMEOUT',
  PROVIDER_ERROR = 'PROVIDER_ERROR',
  SAFETY_BLOCKED = 'SAFETY_BLOCKED',
  MALFORMED = 'MALFORMED',
  /** No usable LLM provider/model for this agent. An operator must fix the agent. */
  NOT_CONFIGURED = 'NOT_CONFIGURED',
  /** The request reached the worker after its deadline; no model call was made. */
  PAST_DEADLINE = 'PAST_DEADLINE',
}

export enum HistoryRole {
  USER = 'USER',
  AGENT = 'AGENT',
}

export interface HistoryEntry {
  role: HistoryRole;
  body: string;
}

export interface RequestUserMessage {
  id: string;
  body: string;
  /** The message this one replies to, so the model sees what is being quoted. */
  replyTo?: { role: HistoryRole; body: string };
}

export interface RequestUser {
  externalUserId: string;
  name?: string | null;
  /** Host-supplied facts about the user, rendered into the prompt as information only. */
  attributes?: Record<string, string>;
}

export interface RequestContext {
  title?: string | null;
  text?: string | null;
  data?: Record<string, unknown> | null;
}

export interface ModelRouteRef {
  providerId: string;
  model: string;
}

export interface GenerationRequest {
  schemaVersion: number;
  /**
   * Unique per dispatch. Queue dedup key on both legs, and the token chat-app
   * matches against the conversation's generation claim: a response whose
   * dispatch was abandoned (timed out, then retried) is recognised as stale.
   */
  dispatchId: string;
  conversationId: string;
  agentId: string;
  /** The turn being answered (REPLY) or the deterministic greeting/farewell turn id. */
  turnId: string;
  kind: GenerationKind;
  /** Pinned at conversation start so a routing change never moves a live conversation. */
  route?: ModelRouteRef;
  userMessages: RequestUserMessage[];
  history: HistoryEntry[];
  user: RequestUser;
  context?: RequestContext | null;
  /** REPLY only: names of the agent actions chat-app is able to run right now. */
  availableActions?: string[];
  /** FAREWELL only: why the conversation is ending. */
  endReason?: string;
  /** GREETING only: how many suggested chips to generate with the greeting. */
  chipCount?: number;
  /** ISO-8601. After this the worker fails the request without calling the model. */
  deadline: string;
}

export interface GenerationAction {
  name: string;
  arguments: Record<string, string>;
}

export interface GenerationRevisions {
  agent: number | null;
  persona: number | null;
  domainPrompt: number | null;
  masterPrompt: number | null;
}

export interface GenerationMeta {
  providerId: string | null;
  providerKind: string | null;
  model: string | null;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  promptVersion: string;
  /** Which revision of every config row shaped this reply — see the config_revisions table. */
  revisions: GenerationRevisions;
  knowledgeDocuments: number;
}

export interface GenerationResponse {
  schemaVersion: number;
  dispatchId: string;
  conversationId: string;
  requestTurnId: string;
  kind: GenerationKind;
  /** REPLY: the user message ids this reply answers — echoed from the request's userMessages. */
  answeredMessageIds: string[];
  endReason?: string;
  status: GenerationStatus;
  /** Reply bubbles in reveal order. Empty when FAILED. */
  parts: string[];
  /** GREETING only: raw generated suggestions; chat-app sanitises them. */
  chips?: string[];
  /** Already filtered to the request's availableActions. */
  action?: GenerationAction | null;
  failureReason?: GenerationFailureReason;
  meta: GenerationMeta | null;
}

/** Deterministic reply turn id: a redelivered response re-derives it and the insert dedupes. */
export const buildReplyTurnId = (requestTurnId: string): string => `r-${requestTurnId}`;
export const buildGreetingTurnId = (conversationId: string): string => `greet-${conversationId}`;
export const buildFarewellTurnId = (conversationId: string): string => `end-${conversationId}`;

/**
 * Dashboard playground: one synchronous generation against UNSAVED agent
 * configuration. chat-app enqueues it and blocks on a Redis list for the
 * answer, so model calls stay inside chat-expert.
 */
export interface PreviewRequest {
  schemaVersion: number;
  previewId: string;
  /** Redis list chat-app is waiting on. */
  replyKey: string;
  kind: GenerationKind.REPLY | GenerationKind.GREETING | GenerationKind.FAREWELL;
  agent: PreviewAgentConfig;
  history: HistoryEntry[];
  userMessage?: string;
  user: RequestUser;
  context?: RequestContext | null;
  deadline: string;
}

export interface PreviewAgentConfig {
  /** Set when previewing changes to an existing agent; null for a new one. */
  agentId: string | null;
  name: string;
  settings: unknown;
  personaPrompt: string;
  personaName: string;
  domainPromptText: string | null;
  masterPromptText: string | null;
  route: ModelRouteRef | null;
}

export interface PreviewResponse {
  previewId: string;
  status: GenerationStatus;
  parts: string[];
  chips?: string[];
  action?: GenerationAction | null;
  failureReason?: string;
  errorMessage?: string;
  systemPrompt: string;
  meta: GenerationMeta | null;
}

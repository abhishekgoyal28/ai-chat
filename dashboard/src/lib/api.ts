/** Thin client for chat-app's admin API. The session is an httpOnly cookie set by /auth/login. */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly issues: Record<string, string> = {},
  ) {
    super(message);
  }
}

const BASE = '/admin/api';

const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
  const response = await fetch(`${BASE}${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  if (response.status === 204) {
    return undefined as T;
  }
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = parsed?.error ?? {};
    if (response.status === 401 && !path.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent('aic:signed-out'));
    }
    throw new ApiError(error.message ?? response.statusText, response.status, error.code ?? 'HTTP_ERROR', error.details?.issues ?? {});
  }
  return parsed as T;
};

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T = void>(path: string) => request<T>('DELETE', path),
};

// --- types returned by the admin API ----------------------------------------

export type Role = 'ADMIN' | 'EDITOR';

export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export interface ModelRoute {
  providerId: string;
  model: string;
  weight: number;
}

export interface AgentAction {
  name: string;
  description: string;
  parameters: Array<{ name: string; description: string; required: boolean }>;
  maxPerConversation: number | null;
  enabled: boolean;
}

export interface AgentSettings {
  session: { durationSec: number | null };
  greeting: { mode: 'NONE' | 'TEMPLATE' | 'LLM'; template: string; instructions: string };
  chips: { source: 'NONE' | 'STATIC' | 'LLM'; items: string[]; count: number };
  farewell: { mode: 'NONE' | 'FIXED' | 'LLM'; instructions: string; fallbackText: string; dividerText: string };
  language: { instruction: string };
  reply: { maxParts: number; maxPartChars: number; temperature: number | null; maxOutputTokens: number; reasoningEffort: 'low' | 'medium' | 'high' | null };
  history: { turns: number };
  knowledge: { knowledgeBaseIds: string[]; maxCharsPerDocument: number; maxTotalChars: number };
  client: { debounceMs: number; typingHoldMs: number; maxTurnWaitMs: number; maxMessagesPerTurn: number; maxBodyChars: number };
  pacing: { enabled: boolean; msPerChar: number; maxDelayMs: number };
  actions: AgentAction[];
}

export interface Agent {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'DISABLED';
  personaId: string;
  domainPromptId: string | null;
  modelRoutes: ModelRoute[];
  settings: AgentSettings;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface Persona {
  id: string;
  name: string;
  displayName: string;
  avatarUrl: string | null;
  tagline: string | null;
  prompt: string;
  revision: number;
  updatedAt: string;
}

export interface Prompt {
  id: string;
  kind: 'MASTER' | 'DOMAIN';
  name: string;
  description: string | null;
  text: string;
  revision: number;
  updatedAt: string;
  defaultText?: string;
}

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  revision: number;
  documents?: number;
  chars?: number;
  updatedAt: string;
}

export interface KnowledgeDocument {
  id: string;
  knowledgeBaseId: string;
  title: string;
  content?: string;
  charCount: number;
  position: number;
  status: 'ACTIVE' | 'DISABLED';
  revision: number;
  updatedAt: string;
}

export type ProviderKind = 'OPENAI' | 'OPENAI_COMPATIBLE' | 'ANTHROPIC' | 'GEMINI' | 'VERTEX_AI' | 'MOCK';

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string | null;
  defaultModel: string | null;
  settings: { location?: string; organization?: string; refusalFallback?: boolean; headers?: Record<string, string> };
  status: 'ACTIVE' | 'DISABLED';
  revision: number;
  credentialsSet: boolean;
  credentialsHint: string | null;
}

export interface PreviewResult {
  status: 'SUCCESS' | 'FAILED';
  parts: string[];
  chips?: string[];
  action?: { name: string; arguments: Record<string, string> } | null;
  failureReason?: string;
  errorMessage?: string;
  systemPrompt: string;
  meta: { model: string | null; latencyMs: number; inputTokens: number | null; outputTokens: number | null; knowledgeDocuments: number } | null;
}

export interface ConversationItem {
  id: string;
  agent: { id: string; slug: string; name: string } | null;
  externalUserId: string;
  userName: string | null;
  scope: string;
  status: 'ACTIVE' | 'ENDED';
  endReason: string | null;
  startedAt: string;
  expiresAt: string | null;
  endedAt: string | null;
}

export interface TranscriptMessage {
  id: string;
  turnId: string;
  requestTurnId: string | null;
  senderType: 'USER' | 'AGENT' | 'SYSTEM';
  kind: string;
  status: string;
  body: string | null;
  partIndex: number | null;
  partsTotal: number | null;
  clientSentAt: string | null;
  publishedAt: string | null;
  createdAt: string;
  meta: Record<string, unknown> | null;
}

export interface Revision {
  id: string;
  revision: number;
  snapshot: Record<string, unknown>;
  changedBy: string | null;
  createdAt: string;
}

export interface Meta {
  version: string;
  publicAppUrl: string;
  publicSocketUrl: string;
  queueDriver: string;
  providerKinds: ProviderKind[];
  webhookEvents: string[];
  agentSettingsDefaults: AgentSettings;
}

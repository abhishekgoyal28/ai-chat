/**
 * Domain enums shared by every service. The database stores these as plain
 * VARCHAR values — no database ENUM types — and repositories hand typed
 * values back to callers.
 */

export enum ConversationStatus {
  ACTIVE = 'ACTIVE',
  ENDED = 'ENDED',
}

export enum ConversationEndReason {
  /** The person chatting tapped End. */
  USER_ENDED = 'USER_ENDED',
  /** The host product ended it through the host API. */
  HOST_ENDED = 'HOST_ENDED',
  /** An operator ended it from the dashboard. */
  ADMIN_ENDED = 'ADMIN_ENDED',
  /** The agent's session duration ran out. */
  TIMER_EXPIRED = 'TIMER_EXPIRED',
}

export enum MessageSenderType {
  USER = 'USER',
  AGENT = 'AGENT',
  /** Server-authored transcript lines, e.g. the "conversation ended" divider. */
  SYSTEM = 'SYSTEM',
}

export enum MessageKind {
  TEXT = 'TEXT',
  GREETING = 'GREETING',
  /** The agent's closing message(s). */
  FAREWELL = 'FAREWELL',
  /** The SYSTEM divider row that marks where the session ended. */
  SESSION_END = 'SESSION_END',
  /** Stream-only item carrying tap-to-send suggestions; never a stored row. */
  SUGGESTED_CHIPS = 'SUGGESTED_CHIPS',
}

/**
 * USER rows:   RECEIVED ─► ANSWERED (a delivered reply covered it)
 *                       └► FAILED   (generation died; the client may retry → RECEIVED)
 * AGENT rows:  PENDING ─► SENT      (revealed to the client)
 *                      └► FAILED    (the reveal path is permanently dead)
 */
export enum MessageStatus {
  RECEIVED = 'RECEIVED',
  ANSWERED = 'ANSWERED',
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
}

export enum RecordStatus {
  ACTIVE = 'ACTIVE',
  DISABLED = 'DISABLED',
}

export enum PromptKind {
  /** The single platform-wide frame every agent opens with. */
  MASTER = 'MASTER',
  /** Subject-matter instructions, shared by any number of agents. */
  DOMAIN = 'DOMAIN',
}

export enum LlmProviderKind {
  OPENAI = 'OPENAI',
  /** Any server speaking the OpenAI Chat Completions API: Ollama, vLLM, LM Studio, Azure, gateways. */
  OPENAI_COMPATIBLE = 'OPENAI_COMPATIBLE',
  ANTHROPIC = 'ANTHROPIC',
  /** Gemini through a Google AI Studio API key. */
  GEMINI = 'GEMINI',
  /** Gemini through Vertex AI with a service-account JSON. */
  VERTEX_AI = 'VERTEX_AI',
  /** Deterministic offline replies for tests and smoke checks. Never a default. */
  MOCK = 'MOCK',
}

export enum AdminRole {
  /** Everything, including team members, API keys and platform settings. */
  ADMIN = 'ADMIN',
  /** Agents, personas, prompts, knowledge and conversations. */
  EDITOR = 'EDITOR',
}

export enum ConfigResourceType {
  AGENT = 'AGENT',
  PERSONA = 'PERSONA',
  PROMPT = 'PROMPT',
  KNOWLEDGE_BASE = 'KNOWLEDGE_BASE',
  KNOWLEDGE_DOCUMENT = 'KNOWLEDGE_DOCUMENT',
  LLM_PROVIDER = 'LLM_PROVIDER',
  PLATFORM_SETTINGS = 'PLATFORM_SETTINGS',
}

export enum ActionInvocationStatus {
  PENDING = 'PENDING',
  SUCCEEDED = 'SUCCEEDED',
  FAILED = 'FAILED',
}

export enum PushMode {
  /** No offline delivery — a reply published while nobody listens is read on reopen. */
  NONE = 'NONE',
  /** POST `message.undelivered` to the host webhook; the host sends its own push. */
  WEBHOOK = 'WEBHOOK',
  /** Send a Firebase Cloud Messaging data message to the user's registered devices. */
  FCM = 'FCM',
}

export enum DevicePlatform {
  ANDROID = 'ANDROID',
  IOS = 'IOS',
  WEB = 'WEB',
}

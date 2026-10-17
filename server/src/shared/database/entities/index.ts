import {
  Agent,
  AdminUser,
  ApiKey,
  ConfigRevision,
  KnowledgeBase,
  KnowledgeDocument,
  LlmProvider,
  Persona,
  PlatformSetting,
  Prompt,
} from './config.entities';
import { ActionInvocation, Conversation, Message, UserDevice } from './conversation.entities';

export * from './config.entities';
export * from './conversation.entities';

export const ALL_ENTITIES = [
  AdminUser,
  ApiKey,
  LlmProvider,
  Persona,
  Prompt,
  Agent,
  KnowledgeBase,
  KnowledgeDocument,
  ConfigRevision,
  PlatformSetting,
  Conversation,
  Message,
  UserDevice,
  ActionInvocation,
];

/** chat-expert reads configuration only — it never touches conversation tables. */
export const EXPERT_ENTITIES = [LlmProvider, Persona, Prompt, Agent, KnowledgeBase, KnowledgeDocument];

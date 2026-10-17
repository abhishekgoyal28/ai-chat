import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import {
  ActionInvocationStatus,
  ConversationEndReason,
  ConversationStatus,
  DevicePlatform,
  MessageKind,
  MessageSenderType,
  MessageStatus,
} from '../../domain/enums';

/**
 * One row per conversation. uq(agentId, externalUserId, scope) is the
 * create-or-resume gate: the INSERT succeeds exactly once per key, and a
 * duplicate-key error means "load the existing row". `scope` is the host's own
 * key for what the chat is about ('' when it has none) — the same user, agent
 * and scope always reach the same conversation.
 *
 * All DATETIME columns hold UTC (the connection runs with timezone 'Z').
 */
@Entity('conversations')
@Unique('uq_conversations_gate', ['agentId', 'externalUserId', 'scope'])
@Index('ix_conversations_status_expires', ['status', 'expiresAt'])
@Index('ix_conversations_status_end_initiated', ['status', 'endInitiatedAt'])
@Index('ix_conversations_inflight', ['inflightSince'])
@Index('ix_conversations_user', ['externalUserId'])
@Index('ix_conversations_agent_created', ['agentId', 'createdAt'])
export class Conversation {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint' })
  agentId: string;

  @Column({ type: 'varchar', length: 191 })
  externalUserId: string;

  @Column({ type: 'varchar', length: 191, default: '' })
  scope: string;

  @Column({ type: 'varchar', length: 20 })
  status: ConversationStatus;

  /** Set when the conversation is finalised as ENDED. */
  @Column({ type: 'varchar', length: 30, nullable: true })
  endReason: ConversationEndReason | null;

  /**
   * Written together with the end claim, so a deferred end (waiting for an
   * in-flight reply) finishes with the reason it actually started with.
   */
  @Column({ type: 'varchar', length: 30, nullable: true })
  pendingEndReason: ConversationEndReason | null;

  /** The end claim: non-null once any trigger has started ending the conversation. */
  @Column({ type: 'datetime', precision: 6, nullable: true })
  endInitiatedAt: Date | null;

  @Column({ type: 'datetime', precision: 6 })
  startedAt: Date;

  /** Null when the agent's session has no duration — it never expires on its own. */
  @Column({ type: 'datetime', precision: 6, nullable: true })
  expiresAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  endedAt: Date | null;

  /** The transcript-is-final claim, stamped once the last farewell part has been revealed. */
  @Column({ type: 'datetime', precision: 6, nullable: true })
  completedAt: Date | null;

  /**
   * The generation claim: at most one generation per conversation at a time.
   * A turn sent while a reply is generating waits, and is answered together
   * with anything else outstanding once the reply lands — with that reply in
   * its history.
   */
  @Column({ type: 'varchar', length: 80, nullable: true })
  inflightDispatchId: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  inflightSince: Date | null;

  @Column({ type: 'varchar', length: 191, nullable: true })
  userName: string | null;

  @Column({ type: 'json', nullable: true })
  userAttributes: Record<string, string> | null;

  /** Host-supplied context: { title?, text?, data? }. */
  @Column({ type: 'json', nullable: true })
  context: Record<string, unknown> | null;

  /** Model route pinned at creation, so a routing change never moves a live conversation. */
  @Column({ type: 'bigint', nullable: true })
  llmProviderId: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  llmModel: string | null;

  /** LLM-generated suggestions pinned when the greeting lands. */
  @Column({ type: 'json', nullable: true })
  suggestedChips: string[] | null;

  @Column({ type: 'json', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}

/**
 * User messages and agent reply parts, one row per bubble.
 *
 * `id` is the single source of ordering, deduplication and paging — never
 * order by a timestamp. Idempotency relies on MySQL allowing duplicate NULLs
 * in unique keys (user rows have no partIndex, agent rows no clientMessageId):
 *   - uq(conversationId, clientMessageId): a resent batch inserts nothing.
 *   - uq(conversationId, turnId, partIndex): a redelivered reply inserts nothing.
 */
@Entity('messages')
@Unique('uq_messages_client', ['conversationId', 'clientMessageId'])
@Unique('uq_messages_part', ['conversationId', 'turnId', 'partIndex'])
@Index('ix_messages_conversation', ['conversationId', 'id'])
@Index('ix_messages_status_reveal', ['status', 'revealAt'])
@Index('ix_messages_starred', ['conversationId', 'starredAt'])
@Index('ix_messages_pinned', ['conversationId', 'pinnedAt'])
@Index('ix_messages_created', ['createdAt'])
export class Message {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint' })
  conversationId: string;

  @Column({ type: 'varchar', length: 80 })
  turnId: string;

  /** Agent rows: the turn this reply answers. */
  @Column({ type: 'varchar', length: 80, nullable: true })
  requestTurnId: string | null;

  @Column({ type: 'varchar', length: 10 })
  senderType: MessageSenderType;

  @Column({ type: 'varchar', length: 20 })
  kind: MessageKind;

  @Column({ type: 'varchar', length: 20 })
  status: MessageStatus;

  @Column({ type: 'text', nullable: true })
  body: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  clientMessageId: string | null;

  @Column({ type: 'int', nullable: true })
  partIndex: number | null;

  @Column({ type: 'int', nullable: true })
  partsTotal: number | null;

  /** User rows: device tap time, skew-guarded. Display only. */
  @Column({ type: 'datetime', precision: 6, nullable: true })
  clientSentAt: Date | null;

  /** Agent rows: when the part is scheduled to be revealed. */
  @Column({ type: 'datetime', precision: 6, nullable: true })
  revealAt: Date | null;

  /** Agent rows: when the part was actually revealed. */
  @Column({ type: 'datetime', precision: 6, nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'bigint', nullable: true })
  replyToId: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  pinnedAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  starredAt: Date | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  reaction: string | null;

  /** Generation metadata (model, latency, tokens, revisions) on part 0 of each reply. */
  @Column({ type: 'json', nullable: true })
  meta: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}

/** Push tokens the host registers for its users. Only used when push mode is FCM. */
@Entity('user_devices')
@Index('ix_user_devices_user', ['externalUserId'])
export class UserDevice {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 191 })
  externalUserId: string;

  @Column({ type: 'varchar', length: 20 })
  platform: DevicePlatform;

  @Column({ type: 'varchar', length: 1024 })
  token: string;

  @Column({ type: 'char', length: 64, unique: true })
  tokenHash: string;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}

/** One row per action the model triggered. The unique key makes a redelivered reply run it once. */
@Entity('action_invocations')
@Unique('uq_action_invocations_turn', ['conversationId', 'turnId', 'actionName'])
@Index('ix_action_invocations_conversation', ['conversationId', 'actionName'])
export class ActionInvocation {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint' })
  conversationId: string;

  @Column({ type: 'bigint' })
  agentId: string;

  @Column({ type: 'varchar', length: 48 })
  actionName: string;

  @Column({ type: 'varchar', length: 80 })
  turnId: string;

  @Column({ type: 'json' })
  arguments: Record<string, string>;

  @Column({ type: 'varchar', length: 20 })
  status: ActionInvocationStatus;

  @Column({ type: 'varchar', length: 500, nullable: true })
  error: string | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}

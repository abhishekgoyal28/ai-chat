import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';
import type { AgentSettings, ModelRoute } from '../../domain/agent-settings';
import { AdminRole, ConfigResourceType, LlmProviderKind, PromptKind, RecordStatus } from '../../domain/enums';

/**
 * Configuration tables, edited from the dashboard and read (cached) by
 * chat-expert. Rows are mutable; every change increments `revision` and writes
 * a snapshot to config_revisions, so any reply can be traced to the exact
 * text that produced it and any change can be restored.
 *
 * No foreign keys anywhere in the schema: referenced ids are plain indexed
 * columns, related data is read with joins.
 */

@Entity('admin_users')
export class AdminUser {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 191, unique: true })
  email: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 255 })
  passwordHash: string;

  @Column({ type: 'varchar', length: 20 })
  role: AdminRole;

  @Column({ type: 'varchar', length: 20 })
  status: RecordStatus;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  lastLoginAt: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}

/** Host API keys. Only the SHA-256 of the key is stored; the key itself is shown once. */
@Entity('api_keys')
export class ApiKey {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  /** First characters of the key, for recognising it in the dashboard. */
  @Column({ type: 'varchar', length: 24 })
  keyPrefix: string;

  @Column({ type: 'char', length: 64, unique: true })
  keyHash: string;

  @Column({ type: 'bigint', nullable: true })
  createdById: string | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  lastUsedAt: Date | null;

  @Column({ type: 'datetime', precision: 6, nullable: true })
  revokedAt: Date | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}

export interface LlmProviderSettings {
  /** Vertex AI: GCP location, e.g. "global" or "us-central1". */
  location?: string;
  /** OpenAI: organization id. */
  organization?: string;
  /** Anthropic: retry a declined request on a fallback model server-side. */
  refusalFallback?: boolean;
  /** Extra HTTP headers for OpenAI-compatible gateways. */
  headers?: Record<string, string>;
}

@Entity('llm_providers')
export class LlmProvider {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 30 })
  kind: LlmProviderKind;

  @Column({ type: 'varchar', length: 500, nullable: true })
  baseUrl: string | null;

  /** API key, or a Vertex service-account JSON. AES-256-GCM sealed with ENCRYPTION_KEY. */
  @Column({ type: 'text', nullable: true })
  encryptedCredentials: string | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  defaultModel: string | null;

  @Column({ type: 'json', nullable: true })
  settings: LlmProviderSettings | null;

  @Column({ type: 'varchar', length: 20 })
  status: RecordStatus;

  @Column({ type: 'int', default: 1 })
  revision: number;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}

/** Who the agent is: display identity plus the persona prompt. Shared by any number of agents. */
@Entity('personas')
export class Persona {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  /** Internal label, shown in the dashboard. */
  @Column({ type: 'varchar', length: 120 })
  name: string;

  /** Shown to end users in the chat header. */
  @Column({ type: 'varchar', length: 120 })
  displayName: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  avatarUrl: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  tagline: string | null;

  @Column({ type: 'mediumtext' })
  prompt: string;

  @Column({ type: 'int', default: 1 })
  revision: number;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}

/** The MASTER prompt (exactly one row) and DOMAIN prompts (a library). */
@Entity('prompts')
@Index('ix_prompts_kind', ['kind'])
export class Prompt {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 20 })
  kind: PromptKind;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  @Column({ type: 'mediumtext' })
  text: string;

  @Column({ type: 'int', default: 1 })
  revision: number;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}

/**
 * What a host product talks to. Binds a persona, an optional domain prompt,
 * model routes, knowledge and behaviour settings under a stable slug the host
 * uses in POST /v1/sessions.
 */
@Entity('agents')
export class Agent {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 80, unique: true })
  slug: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  @Column({ type: 'varchar', length: 20 })
  status: RecordStatus;

  @Column({ type: 'bigint' })
  personaId: string;

  @Column({ type: 'bigint', nullable: true })
  domainPromptId: string | null;

  @Column({ type: 'json' })
  modelRoutes: ModelRoute[];

  /** Always read through readStoredAgentSettings(); see AgentSettings. */
  @Column({ type: 'json' })
  settings: AgentSettings;

  @Column({ type: 'int', default: 1 })
  revision: number;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}

@Entity('knowledge_bases')
export class KnowledgeBase {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  description: string | null;

  @Column({ type: 'int', default: 1 })
  revision: number;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}

@Entity('knowledge_documents')
@Index('ix_knowledge_documents_base_position', ['knowledgeBaseId', 'position'])
export class KnowledgeDocument {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'bigint' })
  knowledgeBaseId: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'mediumtext' })
  content: string;

  @Column({ type: 'int' })
  charCount: number;

  /** Prompt order within the knowledge base; lower first. */
  @Column({ type: 'int', default: 0 })
  position: number;

  @Column({ type: 'varchar', length: 20 })
  status: RecordStatus;

  @Column({ type: 'int', default: 1 })
  revision: number;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}

/** Append-only history of every configuration change. */
@Entity('config_revisions')
@Unique('uq_config_revisions_resource_revision', ['resourceType', 'resourceId', 'revision'])
export class ConfigRevision {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id: string;

  @Column({ type: 'varchar', length: 30 })
  resourceType: ConfigResourceType;

  @Column({ type: 'varchar', length: 80 })
  resourceId: string;

  @Column({ type: 'int' })
  revision: number;

  /** The row as it was after this change, secrets excluded. */
  @Column({ type: 'json' })
  snapshot: Record<string, unknown>;

  @Column({ type: 'varchar', length: 191, nullable: true })
  changedBy: string | null;

  @CreateDateColumn({ type: 'datetime', precision: 6 })
  createdAt: Date;
}

@Entity('platform_settings')
export class PlatformSetting {
  @PrimaryColumn({ type: 'varchar', length: 80 })
  key: string;

  @Column({ type: 'json' })
  value: Record<string, unknown>;

  @Column({ type: 'int', default: 1 })
  revision: number;

  @Column({ type: 'varchar', length: 191, nullable: true })
  updatedBy: string | null;

  @UpdateDateColumn({ type: 'datetime', precision: 6 })
  updatedAt: Date;
}

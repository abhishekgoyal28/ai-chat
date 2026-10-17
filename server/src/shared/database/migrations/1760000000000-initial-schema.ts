import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  DEFAULT_MASTER_PROMPT,
  DEFAULT_MASTER_PROMPT_NAME,
  DEFAULT_PERSONA_DISPLAY_NAME,
  DEFAULT_PERSONA_NAME,
  DEFAULT_PERSONA_PROMPT,
} from '../../domain/default-prompts';

/**
 * The complete v1 schema. Entities in ../entities MUST match this DDL.
 *
 * Conventions: no foreign keys (referenced ids are indexed BIGINT columns),
 * no database ENUM types (VARCHAR + TypeScript enums), utf8mb4 everywhere,
 * DATETIME(6) in UTC. Later migrations must be backward compatible with the
 * previous release so rolling deploys never break: add columns nullable or
 * defaulted, and drop nothing in the release that stops using it.
 */
export class InitialSchema1760000000000 implements MigrationInterface {
  name = 'InitialSchema1760000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const table = (sql: string) =>
      queryRunner.query(`${sql} ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

    await table(`
      CREATE TABLE admin_users (
        id             BIGINT       NOT NULL AUTO_INCREMENT,
        email          VARCHAR(191) NOT NULL,
        name           VARCHAR(120) NOT NULL,
        password_hash  VARCHAR(255) NOT NULL,
        role           VARCHAR(20)  NOT NULL,
        status         VARCHAR(20)  NOT NULL,
        last_login_at  DATETIME(6)  NULL,
        created_at     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_admin_users_email (email)
      )`);

    await table(`
      CREATE TABLE api_keys (
        id             BIGINT       NOT NULL AUTO_INCREMENT,
        name           VARCHAR(120) NOT NULL,
        key_prefix     VARCHAR(24)  NOT NULL,
        key_hash       CHAR(64)     NOT NULL,
        created_by_id  BIGINT       NULL,
        last_used_at   DATETIME(6)  NULL,
        revoked_at     DATETIME(6)  NULL,
        created_at     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_api_keys_hash (key_hash)
      )`);

    await table(`
      CREATE TABLE llm_providers (
        id                     BIGINT       NOT NULL AUTO_INCREMENT,
        name                   VARCHAR(120) NOT NULL,
        kind                   VARCHAR(30)  NOT NULL,
        base_url               VARCHAR(500) NULL,
        encrypted_credentials  TEXT         NULL,
        default_model          VARCHAR(120) NULL,
        settings               JSON         NULL,
        status                 VARCHAR(20)  NOT NULL,
        revision               INT          NOT NULL DEFAULT 1,
        created_at             DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at             DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id)
      )`);

    await table(`
      CREATE TABLE personas (
        id            BIGINT        NOT NULL AUTO_INCREMENT,
        name          VARCHAR(120)  NOT NULL,
        display_name  VARCHAR(120)  NOT NULL,
        avatar_url    VARCHAR(1000) NULL,
        tagline       VARCHAR(255)  NULL,
        prompt        MEDIUMTEXT    NOT NULL,
        revision      INT           NOT NULL DEFAULT 1,
        created_at    DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at    DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id)
      )`);

    await table(`
      CREATE TABLE prompts (
        id           BIGINT       NOT NULL AUTO_INCREMENT,
        kind         VARCHAR(20)  NOT NULL,
        name         VARCHAR(120) NOT NULL,
        description  VARCHAR(500) NULL,
        text         MEDIUMTEXT   NOT NULL,
        revision     INT          NOT NULL DEFAULT 1,
        created_at   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        KEY ix_prompts_kind (kind)
      )`);

    await table(`
      CREATE TABLE agents (
        id                BIGINT       NOT NULL AUTO_INCREMENT,
        slug              VARCHAR(80)  NOT NULL,
        name              VARCHAR(120) NOT NULL,
        description       VARCHAR(500) NULL,
        status            VARCHAR(20)  NOT NULL,
        persona_id        BIGINT       NOT NULL,
        domain_prompt_id  BIGINT       NULL,
        model_routes      JSON         NOT NULL,
        settings          JSON         NOT NULL,
        revision          INT          NOT NULL DEFAULT 1,
        created_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_agents_slug (slug),
        KEY ix_agents_persona (persona_id),
        KEY ix_agents_domain_prompt (domain_prompt_id)
      )`);

    await table(`
      CREATE TABLE knowledge_bases (
        id           BIGINT       NOT NULL AUTO_INCREMENT,
        name         VARCHAR(120) NOT NULL,
        description  VARCHAR(500) NULL,
        revision     INT          NOT NULL DEFAULT 1,
        created_at   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at   DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id)
      )`);

    await table(`
      CREATE TABLE knowledge_documents (
        id                 BIGINT       NOT NULL AUTO_INCREMENT,
        knowledge_base_id  BIGINT       NOT NULL,
        title              VARCHAR(255) NOT NULL,
        content            MEDIUMTEXT   NOT NULL,
        char_count         INT          NOT NULL,
        position           INT          NOT NULL DEFAULT 0,
        status             VARCHAR(20)  NOT NULL,
        revision           INT          NOT NULL DEFAULT 1,
        created_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        KEY ix_knowledge_documents_base_position (knowledge_base_id, position)
      )`);

    await table(`
      CREATE TABLE config_revisions (
        id             BIGINT       NOT NULL AUTO_INCREMENT,
        resource_type  VARCHAR(30)  NOT NULL,
        resource_id    VARCHAR(80)  NOT NULL,
        revision       INT          NOT NULL,
        snapshot       JSON         NOT NULL,
        changed_by     VARCHAR(191) NULL,
        created_at     DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_config_revisions_resource_revision (resource_type, resource_id, revision)
      )`);

    await table(`
      CREATE TABLE platform_settings (
        \`key\`      VARCHAR(80)  NOT NULL,
        value       JSON         NOT NULL,
        revision    INT          NOT NULL DEFAULT 1,
        updated_by  VARCHAR(191) NULL,
        updated_at  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (\`key\`)
      )`);

    await table(`
      CREATE TABLE conversations (
        id                        BIGINT       NOT NULL AUTO_INCREMENT,
        agent_id                  BIGINT       NOT NULL,
        external_user_id          VARCHAR(191) NOT NULL,
        scope                     VARCHAR(191) NOT NULL DEFAULT '',
        status                    VARCHAR(20)  NOT NULL,
        end_reason                VARCHAR(30)  NULL,
        pending_end_reason        VARCHAR(30)  NULL,
        end_initiated_at          DATETIME(6)  NULL,
        started_at                DATETIME(6)  NOT NULL,
        expires_at                DATETIME(6)  NULL,
        ended_at                  DATETIME(6)  NULL,
        completed_at              DATETIME(6)  NULL,
        inflight_dispatch_id      VARCHAR(80)  NULL,
        inflight_since            DATETIME(6)  NULL,
        user_name                 VARCHAR(191) NULL,
        user_attributes           JSON         NULL,
        context                   JSON         NULL,
        llm_provider_id           BIGINT       NULL,
        llm_model                 VARCHAR(120) NULL,
        suggested_chips           JSON         NULL,
        metadata                  JSON         NULL,
        created_at                DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at                DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_conversations_gate (agent_id, external_user_id, scope),
        KEY ix_conversations_status_expires (status, expires_at),
        KEY ix_conversations_status_end_initiated (status, end_initiated_at),
        KEY ix_conversations_inflight (inflight_since),
        KEY ix_conversations_user (external_user_id),
        KEY ix_conversations_agent_created (agent_id, created_at)
      )`);

    await table(`
      CREATE TABLE messages (
        id                 BIGINT       NOT NULL AUTO_INCREMENT,
        conversation_id    BIGINT       NOT NULL,
        turn_id            VARCHAR(80)  NOT NULL,
        request_turn_id    VARCHAR(80)  NULL,
        sender_type        VARCHAR(10)  NOT NULL,
        kind               VARCHAR(20)  NOT NULL,
        status             VARCHAR(20)  NOT NULL,
        body               TEXT         NULL,
        client_message_id  VARCHAR(64)  NULL,
        part_index         INT          NULL,
        parts_total        INT          NULL,
        client_sent_at     DATETIME(6)  NULL,
        reveal_at          DATETIME(6)  NULL,
        published_at       DATETIME(6)  NULL,
        reply_to_id        BIGINT       NULL,
        pinned_at          DATETIME(6)  NULL,
        starred_at         DATETIME(6)  NULL,
        reaction           VARCHAR(32)  NULL,
        meta               JSON         NULL,
        created_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_messages_client (conversation_id, client_message_id),
        UNIQUE KEY uq_messages_part (conversation_id, turn_id, part_index),
        KEY ix_messages_conversation (conversation_id, id),
        KEY ix_messages_status_reveal (status, reveal_at),
        KEY ix_messages_starred (conversation_id, starred_at),
        KEY ix_messages_pinned (conversation_id, pinned_at),
        KEY ix_messages_created (created_at)
      )`);

    await table(`
      CREATE TABLE user_devices (
        id                BIGINT        NOT NULL AUTO_INCREMENT,
        external_user_id  VARCHAR(191)  NOT NULL,
        platform          VARCHAR(20)   NOT NULL,
        token             VARCHAR(1024) NOT NULL,
        token_hash        CHAR(64)      NOT NULL,
        created_at        DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at        DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_user_devices_token_hash (token_hash),
        KEY ix_user_devices_user (external_user_id)
      )`);

    await table(`
      CREATE TABLE action_invocations (
        id               BIGINT       NOT NULL AUTO_INCREMENT,
        conversation_id  BIGINT       NOT NULL,
        agent_id         BIGINT       NOT NULL,
        action_name      VARCHAR(48)  NOT NULL,
        turn_id          VARCHAR(80)  NOT NULL,
        arguments        JSON         NOT NULL,
        status           VARCHAR(20)  NOT NULL,
        error            VARCHAR(500) NULL,
        created_at       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        updated_at       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        PRIMARY KEY (id),
        UNIQUE KEY uq_action_invocations_turn (conversation_id, turn_id, action_name),
        KEY ix_action_invocations_conversation (conversation_id, action_name)
      )`);

    await queryRunner.query('INSERT INTO prompts (kind, name, description, text) VALUES (?, ?, ?, ?)', [
      'MASTER',
      DEFAULT_MASTER_PROMPT_NAME,
      'The platform-wide frame every agent opens with.',
      DEFAULT_MASTER_PROMPT,
    ]);
    await queryRunner.query('INSERT INTO personas (name, display_name, tagline, prompt) VALUES (?, ?, ?, ?)', [
      DEFAULT_PERSONA_NAME,
      DEFAULT_PERSONA_DISPLAY_NAME,
      'Here to help',
      DEFAULT_PERSONA_PROMPT,
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const name of [
      'action_invocations',
      'user_devices',
      'messages',
      'conversations',
      'platform_settings',
      'config_revisions',
      'knowledge_documents',
      'knowledge_bases',
      'agents',
      'prompts',
      'personas',
      'llm_providers',
      'api_keys',
      'admin_users',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS ${name}`);
    }
  }
}

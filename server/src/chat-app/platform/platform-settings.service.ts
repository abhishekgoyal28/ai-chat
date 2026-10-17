import { Injectable } from '@nestjs/common';
import { config } from '../../shared/config/config';
import { PushMode } from '../../shared/domain/enums';
import { describeError, getLogger } from '../../shared/logger/logger';
import { decryptSecret, encryptSecret, parseEncryptionKey } from '../../shared/security/crypto';
import { TtlCache } from '../../shared/utils/ttl-cache';
import { PlatformSettingsRepository } from './platform-settings.repository';

export enum PlatformSettingKey {
  WEBHOOKS = 'webhooks',
  PUSH = 'push',
  RETENTION = 'retention',
}

export enum WebhookEvent {
  SESSION_STARTED = 'session.started',
  SESSION_ENDED = 'session.ended',
  ACTION_INVOKED = 'action.invoked',
  MESSAGE_UNDELIVERED = 'message.undelivered',
}

export interface WebhookSettings {
  url: string | null;
  /** HMAC signing secret. Stored encrypted; decrypted only when signing. */
  secret: string | null;
  events: WebhookEvent[];
}

export interface PushSettings {
  mode: PushMode;
  /** FCM service-account JSON. Stored encrypted. */
  fcmServiceAccount: string | null;
  /** Notification title for message pushes; {{agent.name}} is filled in. */
  titleTemplate: string;
}

export interface RetentionSettings {
  /** Delete conversations (and their messages) that ended more than this many days ago. Null keeps forever. */
  endedConversationDays: number | null;
}

interface StoredWebhooks {
  url?: string | null;
  encryptedSecret?: string | null;
  events?: WebhookEvent[];
}

interface StoredPush {
  mode?: PushMode;
  encryptedFcmServiceAccount?: string | null;
  titleTemplate?: string;
}

const SETTINGS_CACHE_TTL_MS = 5000;

export const DEFAULT_WEBHOOK_EVENTS = Object.values(WebhookEvent);

/**
 * Platform-wide settings edited from the dashboard. Secrets are sealed with
 * ENCRYPTION_KEY before they reach the database and are never returned to
 * the dashboard — only whether one is set.
 */
@Injectable()
export class PlatformSettingsService {
  private readonly log = getLogger(PlatformSettingsService.name);
  private readonly cache = new TtlCache<Record<string, unknown>>(SETTINGS_CACHE_TTL_MS);
  private readonly encryptionKey = config.ENCRYPTION_KEY ? parseEncryptionKey(config.ENCRYPTION_KEY) : null;

  constructor(private readonly repository: PlatformSettingsRepository) {}

  async getWebhooks(): Promise<WebhookSettings> {
    const stored = ((await this.read(PlatformSettingKey.WEBHOOKS)) ?? {}) as StoredWebhooks;
    return {
      url: stored.url ?? null,
      secret: this.open(stored.encryptedSecret),
      events: stored.events ?? DEFAULT_WEBHOOK_EVENTS,
    };
  }

  async getPush(): Promise<PushSettings> {
    const stored = ((await this.read(PlatformSettingKey.PUSH)) ?? {}) as StoredPush;
    return {
      mode: stored.mode ?? PushMode.NONE,
      fcmServiceAccount: this.open(stored.encryptedFcmServiceAccount),
      titleTemplate: stored.titleTemplate ?? '{{agent.name}}',
    };
  }

  async getRetention(): Promise<RetentionSettings> {
    const stored = ((await this.read(PlatformSettingKey.RETENTION)) ?? {}) as Partial<RetentionSettings>;
    return { endedConversationDays: stored.endedConversationDays ?? null };
  }

  /** What the dashboard may see: everything except the secrets themselves. */
  async describe(): Promise<{
    webhooks: Omit<WebhookSettings, 'secret'> & { secretSet: boolean };
    push: Omit<PushSettings, 'fcmServiceAccount'> & { fcmServiceAccountSet: boolean };
    retention: RetentionSettings;
  }> {
    const [webhooks, push, retention] = await Promise.all([this.getWebhooks(), this.getPush(), this.getRetention()]);
    return {
      webhooks: { url: webhooks.url, events: webhooks.events, secretSet: Boolean(webhooks.secret) },
      push: { mode: push.mode, titleTemplate: push.titleTemplate, fcmServiceAccountSet: Boolean(push.fcmServiceAccount) },
      retention,
    };
  }

  /** `secret: undefined` keeps the stored one, `null` clears it. */
  async saveWebhooks(input: { url: string | null; secret?: string | null; events: WebhookEvent[] }, by: string): Promise<Record<string, unknown>> {
    const current = ((await this.read(PlatformSettingKey.WEBHOOKS)) ?? {}) as StoredWebhooks;
    const value: StoredWebhooks = {
      url: input.url,
      encryptedSecret: input.secret === undefined ? (current.encryptedSecret ?? null) : input.secret ? this.seal(input.secret) : null,
      events: input.events,
    };
    const revision = await this.write(PlatformSettingKey.WEBHOOKS, value as Record<string, unknown>, by);
    return { url: value.url, events: value.events, secretSet: Boolean(value.encryptedSecret), revision };
  }

  async savePush(input: { mode: PushMode; fcmServiceAccount?: string | null; titleTemplate: string }, by: string): Promise<Record<string, unknown>> {
    const current = ((await this.read(PlatformSettingKey.PUSH)) ?? {}) as StoredPush;
    const value: StoredPush = {
      mode: input.mode,
      encryptedFcmServiceAccount:
        input.fcmServiceAccount === undefined
          ? (current.encryptedFcmServiceAccount ?? null)
          : input.fcmServiceAccount
            ? this.seal(input.fcmServiceAccount)
            : null,
      titleTemplate: input.titleTemplate,
    };
    const revision = await this.write(PlatformSettingKey.PUSH, value as Record<string, unknown>, by);
    return { mode: value.mode, titleTemplate: value.titleTemplate, fcmServiceAccountSet: Boolean(value.encryptedFcmServiceAccount), revision };
  }

  async saveRetention(input: RetentionSettings, by: string): Promise<Record<string, unknown>> {
    const revision = await this.write(PlatformSettingKey.RETENTION, { ...input }, by);
    return { ...input, revision };
  }

  private read(key: PlatformSettingKey): Promise<Record<string, unknown> | null> {
    return this.cache.get(key, async () => (await this.repository.find(key))?.value ?? null);
  }

  private async write(key: PlatformSettingKey, value: Record<string, unknown>, by: string): Promise<number> {
    const revision = await this.repository.upsert(key, value, by);
    this.cache.invalidate(key);
    return revision;
  }

  private seal(secret: string): string {
    if (!this.encryptionKey) {
      throw new Error('ENCRYPTION_KEY is required to store secrets');
    }
    return encryptSecret(secret, this.encryptionKey);
  }

  private open(sealed: string | null | undefined): string | null {
    if (!sealed || !this.encryptionKey) {
      return null;
    }
    try {
      return decryptSecret(sealed, this.encryptionKey);
    } catch (error) {
      this.log.error({ error: describeError(error) }, 'a stored platform secret cannot be decrypted — was ENCRYPTION_KEY changed?');
      return null;
    }
  }
}

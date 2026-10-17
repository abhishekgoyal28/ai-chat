import { Injectable } from '@nestjs/common';
import { JWT } from 'google-auth-library';
import { Conversation, Message } from '../../shared/database/entities';
import { PushMode } from '../../shared/domain/enums';
import { describeError, getLogger } from '../../shared/logger/logger';
import { sha256Hex } from '../../shared/security/crypto';
import { PlatformSettingsService, WebhookEvent } from '../platform/platform-settings.service';
import { UserDeviceRepository } from './integration.repositories';
import { WebhookService } from './webhook.service';

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const NOTIFICATION_BODY_MAX_CHARS = 180;
const FCM_TIMEOUT_MS = 10_000;

/** Trims to a notification-sized preview on a word boundary where possible. */
export const truncateForNotification = (text: string, maxChars = NOTIFICATION_BODY_MAX_CHARS): string => {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  const clipped = trimmed.slice(0, maxChars);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${lastSpace > maxChars * 0.6 ? clipped.slice(0, lastSpace) : clipped}…`;
};

/**
 * Offline delivery: an agent bubble was revealed while no client was
 * connected to the conversation. Depending on the platform push mode it is
 * handed to the host's webhook (the host sends its own push) or sent as an
 * FCM data message to the user's registered devices. Never throws — a missed
 * notification must not fail the reveal.
 */
@Injectable()
export class PushService {
  private readonly log = getLogger(PushService.name);
  private fcmClient: { key: string; jwt: JWT; projectId: string } | null = null;

  constructor(
    private readonly settings: PlatformSettingsService,
    private readonly devices: UserDeviceRepository,
    private readonly webhooks: WebhookService,
  ) {}

  async notifyUndelivered(conversation: Conversation, part: Message, agentName: string): Promise<void> {
    try {
      const push = await this.settings.getPush();
      const preview = truncateForNotification(part.body ?? '');
      if (push.mode === PushMode.WEBHOOK) {
        await this.webhooks.emit(WebhookEvent.MESSAGE_UNDELIVERED, {
          conversationId: conversation.id,
          externalUserId: conversation.externalUserId,
          scope: conversation.scope,
          agent: agentName,
          messageId: part.id,
          preview,
        });
        return;
      }
      if (push.mode === PushMode.FCM && push.fcmServiceAccount) {
        await this.sendFcm(push.fcmServiceAccount, conversation, part, {
          title: push.titleTemplate.replace(/\{\{agent\.name\}\}/g, agentName),
          body: preview,
        });
      }
    } catch (error) {
      this.log.error({ conversationId: conversation.id, error: describeError(error) }, 'offline notification failed');
    }
  }

  private async sendFcm(
    serviceAccountJson: string,
    conversation: Conversation,
    part: Message,
    copy: { title: string; body: string },
  ): Promise<void> {
    const tokens = await this.devices.findTokens(conversation.externalUserId);
    if (tokens.length === 0) {
      return;
    }
    const client = this.getFcmClient(serviceAccountJson);
    const { token: accessToken } = await client.jwt.getAccessToken();
    const unregistered: string[] = [];

    await Promise.all(
      tokens.map(async ({ token }) => {
        const response = await fetch(`https://fcm.googleapis.com/v1/projects/${client.projectId}/messages:send`, {
          method: 'POST',
          headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
          signal: AbortSignal.timeout(FCM_TIMEOUT_MS),
          body: JSON.stringify({
            message: {
              token,
              // Data-only: the app decides how to render it (and can group by conversation).
              data: {
                type: 'aic.message',
                conversationId: conversation.id,
                scope: conversation.scope,
                messageId: part.id,
                title: copy.title,
                body: copy.body,
              },
              android: { priority: 'HIGH' },
              apns: { headers: { 'apns-priority': '10' }, payload: { aps: { 'content-available': 1 } } },
            },
          }),
        });
        if (response.status === 404 || response.status === 400) {
          const detail = await response.text();
          if (detail.includes('UNREGISTERED') || detail.includes('INVALID_ARGUMENT')) {
            unregistered.push(token);
          }
        } else if (!response.ok) {
          this.log.warn({ status: response.status, conversationId: conversation.id }, 'FCM send failed');
        }
      }),
    );
    if (unregistered.length > 0) {
      await this.devices.deleteTokens(unregistered);
    }
  }

  private getFcmClient(serviceAccountJson: string): { jwt: JWT; projectId: string } {
    const key = sha256Hex(serviceAccountJson);
    if (this.fcmClient?.key === key) {
      return this.fcmClient;
    }
    const credentials = JSON.parse(serviceAccountJson) as { client_email: string; private_key: string; project_id: string };
    const jwt = new JWT({ email: credentials.client_email, key: credentials.private_key, scopes: [FCM_SCOPE] });
    this.fcmClient = { key, jwt, projectId: credentials.project_id };
    return this.fcmClient;
  }
}

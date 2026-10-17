import { Inject } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { config } from '../shared/config/config';
import {
  Ack,
  buildConversationChannel,
  ClientEvent,
  MessageSendAckData,
  MessageSendPayload,
  ServerEvent,
  SocketErrorCode,
  SubscribeAckData,
} from '../shared/contracts/socket-protocol';
import {
  buildInboundDeduplicationId,
  TransportEventEnvelope,
  TransportEventType,
} from '../shared/contracts/transport-events';
import { validateTurnPayload } from '../shared/contracts/turn-validation';
import { describeError, getLogger } from '../shared/logger/logger';
import { metrics } from '../shared/observability/metrics';
import { QueueName } from '../shared/queue/queue.definitions';
import { QUEUE_TRANSPORT, QueueTransport } from '../shared/queue/queue-transport';
import { extractBearerToken, SessionTokenClaims, verifySessionToken } from '../shared/security/session-token';
import { ChannelSubscriptionService } from './services/channel-subscription.service';
import { ConnectionRegistryService } from './services/connection-registry.service';

interface SocketIdentity {
  conversationId: string;
  externalUserId: string;
  maxMessagesPerTurn: number;
  maxBodyChars: number;
  expiresAtMs: number;
}

type AuthenticatedSocket = Socket & { data: SocketIdentity };

/**
 * Transport only: authenticate, join the conversation's room, validate and
 * queue turns, forward frames. No database and no business logic — the
 * module graph of this process does not even contain them.
 *
 * WebSocket transport only (no long-polling fallback), so no sticky sessions
 * are needed behind a load balancer.
 */
@WebSocketGateway({
  transports: ['websocket'],
  pingInterval: config.SOCKET_PING_INTERVAL_MS,
  pingTimeout: config.SOCKET_PING_TIMEOUT_MS,
  cors: { origin: config.CORS_ORIGINS.length > 0 ? config.CORS_ORIGINS : true },
  maxHttpBufferSize: 256 * 1024,
})
export class ChatSocketGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server: Server;

  private readonly log = getLogger(ChatSocketGateway.name);

  constructor(
    private readonly subscriptions: ChannelSubscriptionService,
    private readonly registry: ConnectionRegistryService,
    @Inject(QUEUE_TRANSPORT) private readonly queue: QueueTransport,
  ) {}

  afterInit(server: Server): void {
    this.subscriptions.bindServer(server);
    server.use((socket, next) => this.authenticate(socket, next));
  }

  handleConnection(socket: AuthenticatedSocket): void {
    // The token, not the transport, bounds the session: when it expires the
    // socket is closed and the client reconnects with a fresh token.
    const remainingMs = socket.data.expiresAtMs - Date.now();
    const timer = setTimeout(() => {
      socket.emit(ServerEvent.ERROR, { code: SocketErrorCode.UNAUTHORIZED, message: 'session token expired' });
      socket.disconnect(true);
    }, Math.max(0, remainingMs));
    timer.unref();
    this.registry.register(socket.id, socket.data.conversationId, timer);
  }

  async handleDisconnect(socket: AuthenticatedSocket): Promise<void> {
    for (const channel of this.registry.unregister(socket.id)) {
      await this.subscriptions.release(channel);
    }
  }

  @SubscribeMessage(ClientEvent.SUBSCRIBE)
  async handleSubscribe(@ConnectedSocket() socket: AuthenticatedSocket): Promise<Ack<SubscribeAckData>> {
    const channel = this.channelFor(socket);
    if (this.registry.addChannel(socket.id, channel)) {
      try {
        await this.subscriptions.subscribe(channel);
      } catch (error) {
        this.registry.removeChannel(socket.id, channel);
        this.log.error({ channel, error: describeError(error) }, 'redis subscribe failed');
        return { ok: false, error: SocketErrorCode.SUBSCRIBE_FAILED, message: 'subscription failed, retry' };
      }
      await socket.join(channel);
    }
    this.reportConnectionInit(socket);
    return { ok: true, data: { conversationId: socket.data.conversationId } };
  }

  @SubscribeMessage(ClientEvent.UNSUBSCRIBE)
  async handleUnsubscribe(@ConnectedSocket() socket: AuthenticatedSocket): Promise<Ack> {
    const channel = this.channelFor(socket);
    if (this.registry.removeChannel(socket.id, channel)) {
      await socket.leave(channel);
      await this.subscriptions.release(channel);
    }
    return { ok: true };
  }

  /**
   * Validate, queue durably, THEN ack. The ack is the first tick ("accepted");
   * ids arrive later on turn.persisted. Session state is chat-app's check —
   * its rejections come back as error frames keyed by turnId.
   */
  @SubscribeMessage(ClientEvent.SEND_MESSAGE)
  async handleSendMessage(
    @ConnectedSocket() socket: AuthenticatedSocket,
    @MessageBody() payload: MessageSendPayload,
  ): Promise<Ack<MessageSendAckData>> {
    if (!this.registry.hasChannel(socket.id, this.channelFor(socket))) {
      return { ok: false, error: SocketErrorCode.NOT_SUBSCRIBED, message: 'subscribe before sending' };
    }
    const rejection = validateTurnPayload(payload, {
      maxMessagesPerTurn: socket.data.maxMessagesPerTurn,
      maxBodyChars: socket.data.maxBodyChars,
    });
    if (rejection) {
      return { ok: false, error: rejection.code, message: rejection.message };
    }
    if (!this.registry.tryConsumeSend(socket.id, config.SOCKET_MAX_TURNS_PER_MINUTE)) {
      return { ok: false, error: SocketErrorCode.RATE_LIMITED, message: 'too many messages, slow down' };
    }

    const envelope: TransportEventEnvelope = {
      type: TransportEventType.MESSAGE_SEND,
      conversationId: socket.data.conversationId,
      externalUserId: socket.data.externalUserId,
      socketId: socket.id,
      occurredAt: new Date().toISOString(),
      payload,
    };
    try {
      await this.queue.send(QueueName.INBOUND, {
        body: envelope,
        groupId: socket.data.conversationId,
        deduplicationId: buildInboundDeduplicationId(socket.data.conversationId, payload.clientTurnId, payload.retryAttempt),
      });
    } catch (error) {
      this.log.error({ conversationId: socket.data.conversationId, error: describeError(error) }, 'turn enqueue failed');
      return { ok: false, error: SocketErrorCode.ENQUEUE_FAILED, message: 'could not accept the message, retry' };
    }
    return { ok: true, data: { turnId: payload.clientTurnId, accepted: payload.messages.length } };
  }

  private async authenticate(socket: Socket, next: (error?: Error) => void): Promise<void> {
    const handshakeToken = typeof socket.handshake.auth?.token === 'string' ? socket.handshake.auth.token : null;
    const token = handshakeToken ?? extractBearerToken(socket.handshake.headers.authorization);
    const claims: SessionTokenClaims | null = token ? verifySessionToken(token) : null;
    if (!claims) {
      metrics.socketConnections.inc({ outcome: 'rejected' });
      next(new Error(SocketErrorCode.UNAUTHORIZED));
      return;
    }
    const identity: SocketIdentity = {
      conversationId: claims.cid,
      externalUserId: claims.sub,
      maxMessagesPerTurn: claims.mpt,
      maxBodyChars: claims.mbc,
      expiresAtMs: claims.exp * 1000,
    };
    socket.data = identity;
    metrics.socketConnections.inc({ outcome: 'accepted' });
    next();
  }

  /** Advisory (typing for a pending greeting); its loss must never fail the subscribe. */
  private reportConnectionInit(socket: AuthenticatedSocket): void {
    const envelope: TransportEventEnvelope = {
      type: TransportEventType.CONNECTION_INIT,
      conversationId: socket.data.conversationId,
      externalUserId: socket.data.externalUserId,
      socketId: socket.id,
      occurredAt: new Date().toISOString(),
    };
    this.queue
      .send(QueueName.INBOUND, {
        body: envelope,
        groupId: socket.data.conversationId,
        deduplicationId: `init:${socket.id}`,
      })
      .catch((error) => this.log.warn({ error: describeError(error) }, 'connection.init enqueue failed'));
  }

  private channelFor(socket: AuthenticatedSocket): string {
    return buildConversationChannel(config.QUEUE_PREFIX, socket.data.conversationId);
  }
}

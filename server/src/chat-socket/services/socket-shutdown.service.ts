import { BeforeApplicationShutdown, Injectable } from '@nestjs/common';
import { config } from '../../shared/config/config';
import { ServerEvent, ServerShutdownPayload } from '../../shared/contracts/socket-protocol';
import { getLogger } from '../../shared/logger/logger';
import { ChatSocketGateway } from '../chat-socket.gateway';

/**
 * Graceful drain on SIGTERM (rollout, scale-down): tell every client to
 * reconnect — landing on a healthy pod — then hold shutdown for a short grace
 * window. Must be beforeApplicationShutdown: Nest closes the servers before
 * onApplicationShutdown runs, so a broadcast there would reach nobody.
 */
@Injectable()
export class SocketShutdownService implements BeforeApplicationShutdown {
  private readonly log = getLogger(SocketShutdownService.name);

  constructor(private readonly gateway: ChatSocketGateway) {}

  async beforeApplicationShutdown(signal?: string): Promise<void> {
    if (!this.gateway.server) {
      return;
    }
    const payload: ServerShutdownPayload = { graceMs: config.SOCKET_SHUTDOWN_GRACE_MS };
    this.log.info({ signal, ...payload }, 'draining sockets for shutdown');
    this.gateway.server.emit(ServerEvent.SERVER_SHUTDOWN, payload);
    await new Promise((resolve) => setTimeout(resolve, config.SOCKET_SHUTDOWN_GRACE_MS));
  }
}

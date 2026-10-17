import { Injectable } from '@nestjs/common';

interface ConnectionRecord {
  conversationId: string;
  channels: Set<string>;
  /** Timestamps of recent message.send frames, for the per-socket rate limit. */
  recentSends: number[];
  expiryTimer: NodeJS.Timeout | null;
}

const RATE_WINDOW_MS = 60_000;

/**
 * Live connections on THIS process: which channels each socket holds (so
 * refcounts can be released on disconnect), its send rate, and the timer that
 * closes it when its session token expires. Per-process state only.
 */
@Injectable()
export class ConnectionRegistryService {
  private readonly connections = new Map<string, ConnectionRecord>();

  register(socketId: string, conversationId: string, expiryTimer: NodeJS.Timeout | null): void {
    this.connections.set(socketId, { conversationId, channels: new Set(), recentSends: [], expiryTimer });
  }

  /** Removes the connection and returns the channels it still held. */
  unregister(socketId: string): string[] {
    const record = this.connections.get(socketId);
    if (!record) {
      return [];
    }
    if (record.expiryTimer) {
      clearTimeout(record.expiryTimer);
    }
    this.connections.delete(socketId);
    return [...record.channels];
  }

  addChannel(socketId: string, channel: string): boolean {
    const record = this.connections.get(socketId);
    if (!record || record.channels.has(channel)) {
      return false;
    }
    record.channels.add(channel);
    return true;
  }

  removeChannel(socketId: string, channel: string): boolean {
    return this.connections.get(socketId)?.channels.delete(channel) ?? false;
  }

  hasChannel(socketId: string, channel: string): boolean {
    return this.connections.get(socketId)?.channels.has(channel) ?? false;
  }

  /** Sliding-window limit on turns per socket. Returns false when the send must be rejected. */
  tryConsumeSend(socketId: string, limitPerMinute: number, now = Date.now()): boolean {
    const record = this.connections.get(socketId);
    if (!record) {
      return false;
    }
    record.recentSends = record.recentSends.filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
    if (record.recentSends.length >= limitPerMinute) {
      return false;
    }
    record.recentSends.push(now);
    return true;
  }

  stats(): { connections: number; channels: number } {
    let channels = 0;
    for (const record of this.connections.values()) {
      channels += record.channels.size;
    }
    return { connections: this.connections.size, channels };
  }
}

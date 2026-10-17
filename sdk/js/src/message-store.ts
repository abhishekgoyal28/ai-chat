import type { ChatMessage, WireMessage } from './types';

const localId = (clientMessageId: string): string => `local:${clientMessageId}`;

const compareIds = (a: ChatMessage, b: ChatMessage): number => {
  // Stored messages order by server id; the user's unsent ones go last, in typing order.
  if (a.local !== b.local) {
    return a.local ? 1 : -1;
  }
  if (a.local && b.local) {
    return 0;
  }
  const left = BigInt(a.id);
  const right = BigInt(b.id);
  return left < right ? -1 : left > right ? 1 : 0;
};

/**
 * The client's transcript. Messages arrive by three paths — socket frames,
 * history pages and resyncs — and are merged by server id, so a message seen
 * twice is shown once. The user's own messages appear immediately with a
 * local id and are swapped for the stored row once the server confirms them.
 */
export class MessageStore {
  private readonly byId = new Map<string, ChatMessage>();
  private readonly localByClientId = new Map<string, ChatMessage>();
  private newestServerId: string | null = null;
  private oldestServerId: string | null = null;

  addLocal(message: Omit<ChatMessage, 'id' | 'local'> & { clientMessageId: string }): ChatMessage {
    const entry: ChatMessage = { ...message, id: localId(message.clientMessageId), local: true };
    this.localByClientId.set(message.clientMessageId, entry);
    return entry;
  }

  setLocalStatus(clientMessageIds: string[], status: string): void {
    for (const clientMessageId of clientMessageIds) {
      const entry = this.localByClientId.get(clientMessageId);
      if (entry) {
        entry.status = status;
      }
    }
  }

  /** turn.persisted: the server ids for local messages. */
  confirm(mapping: Array<{ clientMessageId: string; id: string }>): void {
    for (const { clientMessageId, id } of mapping) {
      const entry = this.localByClientId.get(clientMessageId);
      if (!entry) {
        continue;
      }
      this.localByClientId.delete(clientMessageId);
      if (!this.byId.has(id)) {
        this.byId.set(id, { ...entry, id, local: false, status: 'RECEIVED' });
        this.track(id);
      }
    }
  }

  upsert(messages: WireMessage[]): void {
    for (const message of messages) {
      if (message.clientMessageId) {
        this.localByClientId.delete(message.clientMessageId);
      }
      this.byId.set(message.id, { ...message, local: false });
      this.track(message.id);
    }
  }

  /** The user's messages of one turn, for turn.failed and retries. */
  markTurn(turnId: string, status: string): void {
    for (const entry of [...this.byId.values(), ...this.localByClientId.values()]) {
      if (entry.senderType === 'USER' && entry.turnId === turnId) {
        entry.status = status;
      }
    }
  }

  /** A reply part arrived: the user's stored messages before it have been answered. */
  markAnsweredBefore(messageId: string): void {
    const limit = BigInt(messageId);
    for (const entry of this.byId.values()) {
      if (entry.senderType === 'USER' && entry.status === 'RECEIVED' && BigInt(entry.id) < limit) {
        entry.status = 'ANSWERED';
      }
    }
  }

  turnMessages(turnId: string): ChatMessage[] {
    return this.list().filter((entry) => entry.senderType === 'USER' && entry.turnId === turnId);
  }

  list(): ChatMessage[] {
    return [...this.byId.values(), ...this.localByClientId.values()].sort(compareIds);
  }

  get newestId(): string | null {
    return this.newestServerId;
  }

  get oldestId(): string | null {
    return this.oldestServerId;
  }

  private track(id: string): void {
    const value = BigInt(id);
    if (this.newestServerId === null || value > BigInt(this.newestServerId)) {
      this.newestServerId = id;
    }
    if (this.oldestServerId === null || value < BigInt(this.oldestServerId)) {
      this.oldestServerId = id;
    }
  }
}

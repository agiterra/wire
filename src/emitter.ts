/**
 * MessageEmitter — SSE push to connected agents.
 *
 * Keyed by agent ID (not session ID). All active sessions for an agent
 * receive the same events.
 */

export type SSEWriter = {
  write: (data: string) => void;
  close: () => void;
};

export class MessageEmitter {
  // agent_id → Set of SSE writers
  private streams = new Map<string, Set<SSEWriter>>();

  register(agentId: string, writer: SSEWriter): void {
    if (!this.streams.has(agentId)) {
      this.streams.set(agentId, new Set());
    }
    this.streams.get(agentId)!.add(writer);
  }

  unregister(agentId: string, writer: SSEWriter): void {
    const set = this.streams.get(agentId);
    if (set) {
      set.delete(writer);
      if (set.size === 0) this.streams.delete(agentId);
    }
  }

  emit(agentId: string, data: string): boolean {
    const set = this.streams.get(agentId);
    if (!set || set.size === 0) return false;
    for (const writer of set) {
      try {
        writer.write(`data: ${data}\n\n`);
      } catch {
        set.delete(writer);
      }
    }
    return true;
  }

  isConnected(agentId: string): boolean {
    const set = this.streams.get(agentId);
    return !!set && set.size > 0;
  }

  connectedAgents(): string[] {
    return [...this.streams.keys()];
  }
}

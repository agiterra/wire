/**
 * MessageEmitter — SSE push to connected agents.
 *
 * Tracks writers by both agent ID and session ID. Agent-level emit sends
 * to all sessions; session-level emit targets a specific session.
 */

export type SSEWriter = {
  write: (data: string) => void;
  close: () => void;
};

export class MessageEmitter {
  // agent_id → Map<session_id, SSEWriter>
  private streams = new Map<string, Map<string, SSEWriter>>();

  register(agentId: string, sessionId: string, writer: SSEWriter): void {
    if (!this.streams.has(agentId)) {
      this.streams.set(agentId, new Map());
    }
    // Close existing writer for this session (e.g. stale TCP from network drop)
    const existing = this.streams.get(agentId)!.get(sessionId);
    if (existing) {
      existing.close();
    }
    this.streams.get(agentId)!.set(sessionId, writer);
  }

  unregister(agentId: string, sessionId: string): void {
    const sessions = this.streams.get(agentId);
    if (sessions) {
      sessions.delete(sessionId);
      if (sessions.size === 0) this.streams.delete(agentId);
    }
  }

  /** Close the SSE writer and unregister — used for intentional disconnect and reconciler cleanup. */
  closeAndUnregister(agentId: string, sessionId: string): void {
    const sessions = this.streams.get(agentId);
    if (sessions) {
      const writer = sessions.get(sessionId);
      if (writer) writer.close();
      sessions.delete(sessionId);
      if (sessions.size === 0) this.streams.delete(agentId);
    }
  }

  /**
   * Emit to all sessions for an agent. Returns true if at least one writer received it.
   * SSE frames include `id:` for Last-Event-ID reconnect support.
   */
  emit(agentId: string, data: string, seq?: number): boolean {
    const sessions = this.streams.get(agentId);
    if (!sessions || sessions.size === 0) return false;
    const frame = seq != null
      ? `id: ${seq}\ndata: ${data}\n\n`
      : `data: ${data}\n\n`;
    for (const [sessionId, writer] of sessions) {
      try {
        writer.write(frame);
      } catch {
        sessions.delete(sessionId);
      }
    }
    return true;
  }

  /**
   * Emit to a specific session. Returns true if delivered.
   */
  emitToSession(agentId: string, sessionId: string, data: string, seq?: number): boolean {
    const sessions = this.streams.get(agentId);
    if (!sessions) return false;
    const writer = sessions.get(sessionId);
    if (!writer) return false;
    const frame = seq != null
      ? `id: ${seq}\ndata: ${data}\n\n`
      : `data: ${data}\n\n`;
    try {
      writer.write(frame);
      return true;
    } catch {
      sessions.delete(sessionId);
      return false;
    }
  }

  isConnected(agentId: string): boolean {
    const sessions = this.streams.get(agentId);
    return !!sessions && sessions.size > 0;
  }

  getSessionIds(agentId: string): string[] {
    const sessions = this.streams.get(agentId);
    return sessions ? [...sessions.keys()] : [];
  }

  connectedAgents(): string[] {
    return [...this.streams.keys()];
  }
}

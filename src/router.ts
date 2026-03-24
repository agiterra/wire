/**
 * Router — write-through message routing.
 *
 * message arrives → write to store (assign seq) → match subscriptions → emit to connected agents
 *
 * The store is the primary path. Delivery is a side effect of storage.
 */

import type { Store, Message } from "./store.js";
import type { MessageEmitter } from "./emitter.js";

export class Router {
  constructor(
    private store: Store,
    private emitter: MessageEmitter,
  ) {}

  /**
   * Route a message: write to store, then push to matching subscribers.
   * Returns the stored message (with seq assigned).
   */
  route(msg: {
    source: string;
    source_id?: string;
    dest?: string;
    topic: string;
    payload: string;
    raw?: string;
  }): Message {
    // 1. Write-through: store first, get seq
    const stored = this.store.writeMessage(msg);

    // 2. Find matching subscribers
    const subscribers = this.findSubscribers(stored);

    // 3. Attempt delivery to each connected subscriber
    for (const agentId of subscribers) {
      const data = JSON.stringify({
        seq: stored.seq,
        source: stored.source,
        topic: stored.topic,
        payload: JSON.parse(stored.payload),
        dest: stored.dest,
        created_at: stored.created_at,
      });

      const delivered = this.emitter.emit(agentId, data);
      this.store.logDelivery(
        stored.seq,
        agentId,
        delivered ? "ok" : "skipped_offline",
      );
    }

    return stored;
  }

  /**
   * Replay backlog for a session. Sends all messages after the session's cursor
   * that match the agent's subscriptions.
   */
  replay(agentId: string, sessionId: string): void {
    const session = this.store.getSession(sessionId);
    if (!session) return;

    const subs = this.store.getSubscriptions(agentId);
    const messages = this.store.getMessagesForAgent(agentId, session.last_ack_seq, 1000);

    for (const msg of messages) {
      if (!this.matchesAny(msg, subs)) continue;

      const data = JSON.stringify({
        seq: msg.seq,
        source: msg.source,
        topic: msg.topic,
        payload: JSON.parse(msg.payload),
        dest: msg.dest,
        created_at: msg.created_at,
      });

      this.emitter.emit(agentId, data);
    }
  }

  private findSubscribers(msg: Message): string[] {
    const allSubs = this.store.getAllSubscriptions();
    const matched = new Set<string>();

    for (const sub of allSubs) {
      // Skip if unicast and not for this agent
      if (msg.dest && msg.dest !== sub.agent_id) continue;

      if (this.topicMatches(sub.topic, msg.topic)) {
        matched.add(sub.agent_id);
      }
    }

    return [...matched];
  }

  private matchesAny(
    msg: Message,
    subs: { topic: string }[],
  ): boolean {
    for (const sub of subs) {
      if (msg.dest && msg.dest !== msg.source) {
        // unicast — handled by getMessagesForAgent filter
      }
      if (this.topicMatches(sub.topic, msg.topic)) return true;
    }
    return false;
  }

  /**
   * Topic matching: exact, wildcard (*), or glob prefix (slack.*)
   */
  private topicMatches(pattern: string, topic: string): boolean {
    if (pattern === "*") return true;
    if (pattern === topic) return true;
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      return topic === prefix || topic.startsWith(prefix + ".");
    }
    return false;
  }
}

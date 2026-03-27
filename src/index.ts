/**
 * The Wire — entry point.
 *
 * Persistent multi-agent message broker, event log, and registry.
 */

import { Store } from "./store.js";
import { Router } from "./router.js";
import { MessageEmitter } from "./emitter.js";
import { createServer } from "./server.js";

const port = parseInt(process.env.WIRE_PORT ?? "9800", 10);
const dbPath = process.env.WIRE_DB ?? `${process.env.HOME}/.wire/wire.db`;
// Heartbeat: 10s interval from clients. Stale after 15s, disconnected after 60s.
const staleMs = parseInt(process.env.STALE_MS ?? "15000", 10);
const disconnectMs = parseInt(process.env.DISCONNECT_MS ?? "60000", 10);
const reconcilerIntervalMs = parseInt(process.env.RECONCILER_INTERVAL_MS ?? "10000", 10);
const ephemeralTtlMs = parseInt(process.env.EPHEMERAL_TTL_MS ?? "3600000", 10); // 1 hour default

const store = new Store(dbPath);
const emitter = new MessageEmitter();
const router = new Router(store, emitter);
const server = createServer({ port, store, router, emitter });

// Session reconciler — update status based on heartbeat age
setInterval(() => {
  const transitions = store.reconcileSessions(staleMs, disconnectMs);
  for (const t of transitions) {
    if (t.newStatus === "stale") {
      console.log(`[reconciler] ${t.agentId} session ${t.sessionId} → stale`);
    } else if (t.newStatus === "disconnected") {
      console.log(`[reconciler] ${t.agentId} session ${t.sessionId} → disconnected`);
      emitter.closeAndUnregister(t.agentId, t.sessionId);
    }
  }

  const removed = store.cleanEphemeralAgents(ephemeralTtlMs);
  if (removed.length > 0) {
    console.log(`[reconciler] removed ${removed.length} ephemeral agent(s): ${removed.join(", ")}`);
  }
}, reconcilerIntervalMs);

console.log(`The Wire running on http://localhost:${port}`);
console.log(`DB: ${dbPath}`);

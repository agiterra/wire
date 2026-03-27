/**
 * The Wire — entry point.
 *
 * Persistent multi-agent message broker, event log, and registry.
 */

import pino from "pino";
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

export const log = pino({ name: "wire" });

const store = new Store(dbPath);
const emitter = new MessageEmitter();
const router = new Router(store, emitter, log);
const server = createServer({ port, store, router, emitter, log });

// Session reconciler — update status based on heartbeat age
setInterval(() => {
  const transitions = store.reconcileSessions(staleMs, disconnectMs);
  for (const t of transitions) {
    if (t.newStatus === "stale") {
      log.info({ event: "session_stale", agent: t.agentId, session: t.sessionId }, "session → stale");
    } else if (t.newStatus === "disconnected") {
      log.info({ event: "session_disconnected", agent: t.agentId, session: t.sessionId }, "session → disconnected");
      emitter.closeAndUnregister(t.agentId, t.sessionId);
    }
  }

  const removed = store.cleanEphemeralAgents(ephemeralTtlMs);
  if (removed.length > 0) {
    log.info({ event: "ephemeral_cleanup", agents: removed }, `removed ${removed.length} ephemeral agent(s)`);
  }
}, reconcilerIntervalMs);

log.info({ port, db: dbPath }, `The Wire running on http://localhost:${port}`);

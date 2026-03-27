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
// No heartbeat for 30s → reaped (heartbeats sent every 20s)
const sessionTtlMs = parseInt(process.env.SESSION_TTL_MS ?? "30000", 10);
const reaperIntervalMs = parseInt(process.env.REAPER_INTERVAL_MS ?? "10000", 10); // 10s sweep
const ephemeralTtlMs = parseInt(process.env.EPHEMERAL_TTL_MS ?? "3600000", 10); // 1 hour default

const store = new Store(dbPath);
const emitter = new MessageEmitter();
const router = new Router(store, emitter);
const server = createServer({ port, store, router, emitter, sessionTtlMs });

// Session reaper — reap sessions with no heartbeat past TTL
setInterval(() => {
  const sessionReaped = store.reapDeadSessions(sessionTtlMs);
  if (sessionReaped > 0) {
    console.log(`[reaper] reaped ${sessionReaped} stale session(s)`);
  }

  const agentReaped = store.reapEphemeralAgents(ephemeralTtlMs);
  if (agentReaped.length > 0) {
    console.log(`[reaper] removed ${agentReaped.length} ephemeral agent(s): ${agentReaped.join(", ")}`);
  }
}, reaperIntervalMs);

console.log(`The Wire running on http://localhost:${port}`);
console.log(`DB: ${dbPath}`);

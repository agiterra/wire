/**
 * The Exchange — entry point.
 *
 * Persistent multi-agent message broker, event log, and registry.
 */

import { Store } from "./store.js";
import { Router } from "./router.js";
import { MessageEmitter } from "./emitter.js";
import { createServer } from "./server.js";

const port = parseInt(process.env.EXCHANGE_PORT ?? "9800", 10);
const dbPath = process.env.EXCHANGE_DB ?? `${process.env.HOME}/.exchange/exchange.db`;
const sessionTtlMs = parseInt(process.env.SESSION_TTL_MS ?? "300000", 10); // 5 min default
const reaperIntervalMs = parseInt(process.env.REAPER_INTERVAL_MS ?? "60000", 10); // 1 min default

const store = new Store(dbPath);
const emitter = new MessageEmitter();
const router = new Router(store, emitter);
const server = createServer({ port, store, router, emitter });

// Session reaper — disconnect stale sessions
setInterval(() => {
  const reaped = store.reapStaleSessions(sessionTtlMs);
  if (reaped > 0) {
    console.log(`[reaper] disconnected ${reaped} stale session(s)`);
  }
}, reaperIntervalMs);

console.log(`The Exchange running on http://localhost:${port}`);
console.log(`DB: ${dbPath}`);

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { Store } from "./store";
import { Router } from "./router";
import { MessageEmitter } from "./emitter";
import { HeartbeatScheduler } from "./heartbeat";
import { createServer } from "./server";

// A delete that matched nothing used to answer 200 {deleted: <id>}, so a client that sent the wrong field got
// "heartbeat deleted: undefined" while the heartbeat kept firing (Baguette 2026-09-25, hb-9edf71a8).
const TOKEN = "test-dashboard-token";
const log = pino({ level: "silent" });
let tmpDir: string, store: Store, heartbeats: HeartbeatScheduler, server: ReturnType<typeof createServer>, baseUrl: string;
let prevToken: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wire-hb-"));
  store = new Store(join(tmpDir, "wire.db"));
  store.upsertAgent({ id: "baguette", display_name: "baguette", pubkey: "pk-b", permanent: true });
  const emitter = new MessageEmitter();
  const router = new Router(store, emitter, log);
  heartbeats = new HeartbeatScheduler(store, router, log);
  prevToken = process.env.WIRE_DASHBOARD_TOKEN;
  process.env.WIRE_DASHBOARD_TOKEN = TOKEN;
  server = createServer({ port: 0, store, router, emitter, log, heartbeats } as any);
  baseUrl = `http://localhost:${server.port}`;
});
afterEach(() => {
  server.stop(true);
  if (prevToken === undefined) delete process.env.WIRE_DASHBOARD_TOKEN; else process.env.WIRE_DASHBOARD_TOKEN = prevToken;
  rmSync(tmpDir, { recursive: true, force: true });
});

const del = (id: string) => fetch(`${baseUrl}/heartbeats/${id}?token=${TOKEN}`, { method: "DELETE" });   // operator auth, as server.test.ts does

describe("heartbeat delete reports whether anything was deleted", () => {
  test("scheduler.remove returns true for a real heartbeat and false for a missing one", () => {
    const hb = heartbeats.add({ agent_id: "baguette", cron: "44 4 25 9 *", prompt: "x", created_by: "baguette" });
    expect(heartbeats.remove(hb.id)).toBe(true);
    expect(heartbeats.remove(hb.id)).toBe(false);
    expect(heartbeats.remove("undefined")).toBe(false);
  });

  test("DELETE /heartbeats/:id → 200 for a real id (and the row is gone), 404 for a missing one", async () => {
    const hb = heartbeats.add({ agent_id: "baguette", cron: "44 4 25 9 *", prompt: "x", created_by: "baguette" });
    const ok = await del(hb.id);
    expect(ok.status).toBe(200);
    expect((await ok.json()).deleted).toBe(hb.id);
    expect(store.listHeartbeats("baguette").some((h: any) => h.id === hb.id)).toBe(false);
    const miss = await del("undefined");   // what the MCP tool sent when called with the wrong field name
    expect(miss.status).toBe(404);
    expect((await miss.json()).error).toContain("no heartbeat");
  });
});

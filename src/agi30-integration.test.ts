/**
 * AGI-30 integration — the PATCHED client's real token, against the PATCHED
 * gateway, under WIRE_JWT_MODE=enforce.
 *
 * Imports createAuthJwt from the patched wire-tools tree by absolute path, so
 * this is the actual client output and not a re-implementation of it.
 */
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
import { resetReplayCache } from "./jwt-guard";
import {
  createAuthJwt,
  generateKeyPair,
} from "/Users/_ephemeral/work/sericaia/copy/wire-tools/src/crypto.ts";

let tmpDir: string;
let store: Store;
let server: ReturnType<typeof createServer>;
let baseUrl: string;
let prevMode: string | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agi30-int-"));
  store = new Store(join(tmpDir, "wire.db"));
  const log = pino({ level: "silent" });
  const emitter = new MessageEmitter();
  const router = new Router(store, emitter, log);
  const heartbeats = new HeartbeatScheduler(store, router, log);
  prevMode = process.env.WIRE_JWT_MODE;
  process.env.WIRE_JWT_MODE = "enforce";
  resetReplayCache();
  server = createServer({ port: 0, store, router, emitter, log, heartbeats });
  baseUrl = `http://localhost:${server.port}`;
});

afterEach(() => {
  server.stop(true);
  if (prevMode === undefined) delete process.env.WIRE_JWT_MODE;
  else process.env.WIRE_JWT_MODE = prevMode;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

async function registerSender(id: string) {
  const kp = await generateKeyPair();
  store.upsertAgent({ id, display_name: id, pubkey: kp.publicKey, permanent: true });
  return kp;
}

function send(dest: string, topic: string, body: string, token: string) {
  return fetch(`${baseUrl}/webhooks/${dest}/${topic}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body,
  });
}

describe("AGI-30 integration — patched client vs patched gateway (enforce)", () => {
  test("a token from the patched createAuthJwt is ACCEPTED", async () => {
    const kp = await registerSender("sericaia");
    store.upsertAgent({ id: "fondant", display_name: "fondant", pubkey: "pk", permanent: true });
    const body = JSON.stringify({ from: "sericaia", re: "AGI-30" });
    const token = await createAuthJwt(kp.privateKey, "sericaia", body);
    expect((await send("fondant", "ipc", body, token)).status).toBe(200);
  });

  test("replaying that same real token is REJECTED", async () => {
    const kp = await registerSender("sericaia");
    store.upsertAgent({ id: "fondant", display_name: "fondant", pubkey: "pk", permanent: true });
    const body = JSON.stringify({ from: "sericaia", re: "AGI-30" });
    const token = await createAuthJwt(kp.privateKey, "sericaia", body);
    expect((await send("fondant", "ipc", body, token)).status).toBe(200);
    const replay = await send("fondant", "ipc", body, token);
    expect(replay.status).toBe(401);
    expect(await replay.text()).toContain("replay");
  });

  test("a burst of real tokens for the SAME body in the same second all pass", async () => {
    // Pre-patch these were byte-identical and would have collided on the
    // no-jti fallback key. jti is what makes the burst safe.
    const kp = await registerSender("sericaia");
    store.upsertAgent({ id: "fondant", display_name: "fondant", pubkey: "pk", permanent: true });
    const body = JSON.stringify({ tick: 1 });
    for (let i = 0; i < 25; i++) {
      const token = await createAuthJwt(kp.privateKey, "sericaia", body);
      expect((await send("fondant", "ipc", body, token)).status).toBe(200);
    }
  });

  test("and the envelope it produces still carries no bearer", async () => {
    const kp = await registerSender("sericaia");
    store.upsertAgent({ id: "fondant", display_name: "fondant", pubkey: "pk", permanent: true });
    const body = JSON.stringify({ from: "sericaia" });
    const token = await createAuthJwt(kp.privateKey, "sericaia", body);
    const seq = (await (await send("fondant", "ipc", body, token)).json()).seq;
    const row = (store.getRecentMessagesByCount(50) as any[]).find((m) => m.seq === seq);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain("Bearer ");
  });
});

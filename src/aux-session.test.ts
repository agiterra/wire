/**
 * Auxiliary sessions (j:1935, 2026-09-29) over HTTP: /agents/connect {auxiliary:true} is echoed, starts
 * the session at the head, and an ack from it never moves the agent's replay cursor — so a persona's
 * RPC helper that connects first after a restart cannot swallow IPC queued for its channel session.
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

let tmpDir: string;
let store: Store;
let server: ReturnType<typeof createServer>;
let baseUrl: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wire-aux-"));
  store = new Store(join(tmpDir, "wire.db"));
  const log = pino({ level: "silent" });
  const emitter = new MessageEmitter();
  const router = new Router(store, emitter, log);
  const heartbeats = new HeartbeatScheduler(store, router, log);
  server = createServer({ port: 0, store, router, emitter, log, heartbeats });
  baseUrl = `http://localhost:${server.port}`;
});

afterEach(() => {
  server.stop(true);
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function makeAgent(id: string): Promise<CryptoKey> {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const xUrl = jwk.x as string;
  const pubB64 = xUrl.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (xUrl.length % 4)) % 4);
  store.upsertAgent({ id, display_name: id, pubkey: pubB64, permanent: true });
  return kp.privateKey;
}
let jti = 0;
async function post(priv: CryptoKey, iss: string, path: string, obj: unknown) {
  const body = JSON.stringify(obj);
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));
  const claims = { iss, iat: now, exp: now + 60, jti: `aux-${++jti}`, body_hash: await sha256hex(body) };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(`${header}.${payload}`)));
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${header}.${payload}.${b64url(sig)}` },
    body,
  });
  return { status: res.status, json: (await res.json()) as any };
}
function queue(dest: string, topic = "ipc") {
  return store.writeMessage({ source: "lane", dest, topic, payload: JSON.stringify({ text: "x" }) }).seq;
}

describe("/agents/connect auxiliary", () => {
  test("auxiliary:true is honoured and echoed; the session row is marked", async () => {
    const priv = await makeAgent("baguette");
    queue("baguette");
    const r = await post(priv, "baguette", "/agents/connect", { cc_session_id: "bridge-rpc-baguette", auxiliary: true });
    expect(r.status).toBe(200);
    expect(r.json.auxiliary).toBe(true);
    expect(store.getSession(r.json.session_id)!.auxiliary).toBe(1);
    expect(store.getMessagesForAgent("baguette", r.json.last_ack_seq, 100)).toEqual([]);
  });

  test("absent or non-boolean auxiliary means a normal session (echo false)", async () => {
    const priv = await makeAgent("brioche");
    for (const extra of [{}, { auxiliary: "true" }, { auxiliary: 1 }]) {
      const r = await post(priv, "brioche", "/agents/connect", { cc_session_id: `c-${JSON.stringify(extra)}`, ...extra });
      expect(r.status).toBe(200);
      expect(r.json.auxiliary).toBe(false);
      expect(store.getSession(r.json.session_id)!.auxiliary).toBe(0);
    }
  });

  test("incident sequence over HTTP: helper connects first and acks; channel session still gets the queued IPC", async () => {
    const priv = await makeAgent("baguette");
    const queued = queue("baguette");
    const helper = await post(priv, "baguette", "/agents/connect", { cc_session_id: "bridge-rpc-baguette", auxiliary: true });
    const reply = queue("baguette", "rpc.reply");
    // An over-eager helper acking past the queued message must not move the agent cursor.
    const ack = await post(priv, "baguette", "/agents/ack", { session_id: helper.json.session_id, seq: reply });
    expect(ack.status).toBe(200);
    const channel = await post(priv, "baguette", "/agents/connect", { cc_session_id: "7a333c61" });
    expect(channel.json.auxiliary).toBe(false);
    expect(store.getMessagesForAgent("baguette", channel.json.last_ack_seq, 100).map((m) => m.seq)).toContain(queued);
  });
});

/**
 * AGI-30 — JWT freshness/replay + credential-header leakage in delivered envelopes.
 *
 * Self-contained: no helpers from server.test.ts, so the SAME file runs against
 * the pristine deployed tree (BEFORE — must fail) and the patched tree (AFTER —
 * must pass). Copy to <tree>/src/agi30.test.ts and run `bun test src/agi30.test.ts`.
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
import { replayCacheSize, resetReplayCache } from "./jwt-guard";

let tmpDir: string;
let store: Store;
let server: ReturnType<typeof createServer>;
let baseUrl: string;
let logLines: any[];
const savedEnv: Record<string, string | undefined> = {};

function setEnv(k: string, v: string | undefined) {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "agi30-"));
  store = new Store(join(tmpDir, "wire.db"));
  logLines = [];
  // Capture structured log lines so GRACE mode's would-reject counter is testable.
  const log = pino(
    { level: "debug" },
    { write: (s: string) => { try { logLines.push(JSON.parse(s)); } catch {} } } as any,
  );
  const emitter = new MessageEmitter();
  const router = new Router(store, emitter, log);
  const heartbeats = new HeartbeatScheduler(store, router, log);
  setEnv("WIRE_JWT_MODE", "enforce");
  setEnv("WIRE_JWT_MAX_AGE_SEC", "300");
  resetReplayCache();
  server = createServer({ port: 0, store, router, emitter, log, heartbeats });
  baseUrl = `http://localhost:${server.port}`;
});

afterEach(() => {
  server.stop(true);
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    delete savedEnv[k];
  }
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// --- signing helpers (mirror wire-tools/src/crypto.ts createAuthJwt) ---

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function makeAgent(id: string, permanent = true): Promise<CryptoKey> {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  const xUrl = jwk.x as string;
  const pubB64 = xUrl.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (xUrl.length % 4)) % 4);
  store.upsertAgent({ id, display_name: id, pubkey: pubB64, permanent });
  return kp.privateKey;
}
type Claims = Record<string, unknown>;
async function mint(priv: CryptoKey, iss: string, body: string, extra: Claims = {}): Promise<string> {
  const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));
  const claims: Claims = { iss, iat: Math.floor(Date.now() / 1000), body_hash: await sha256hex(body), ...extra };
  const payload = b64url(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${header}.${payload}`;
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(signingInput)));
  return `${signingInput}.${b64url(sig)}`;
}
/** POST an IPC message exactly as wire-tools sendSignedMessage does. */
function send(dest: string, topic: string, body: string, token: string, extraHeaders: Record<string, string> = {}) {
  return fetch(`${baseUrl}/webhooks/${dest}/${topic}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...extraHeaders },
    body,
  });
}
function broadcast(topic: string, body: string, token: string) {
  return fetch(`${baseUrl}/broadcast/${topic}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-wire-broadcast": "1" },
    body,
  });
}
/** The envelope as persisted — byte-identical to what router.deliver() JSON.parses and emits. */
function storedEnvelope(seq: number): any {
  const rows = store.getRecentMessagesByCount(200) as any[];
  const row = rows.find((m) => m.seq === seq);
  if (!row) throw new Error(`no stored message seq=${seq}`);
  return { raw: row.payload, parsed: JSON.parse(row.payload) };
}

describe("AGI-30 §1 — JWT freshness (iat max-age / exp)", () => {
  test("a JWT with a stale iat and no exp is REJECTED", async () => {
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const body = JSON.stringify({ text: "stale" });
    const stale = Math.floor(Date.now() / 1000) - 3600;
    const token = await mint(priv, "sender", body, { iat: stale });
    const res = await send("fondant", "ipc", body, token);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("stale");
  });

  test("a JWT whose exp is in the past is REJECTED", async () => {
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const body = JSON.stringify({ text: "expired" });
    const now = Math.floor(Date.now() / 1000);
    const token = await mint(priv, "sender", body, { iat: now - 120, exp: now - 60, jti: "e1" });
    const res = await send("fondant", "ipc", body, token);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("expired");
  });

  test("a JWT with no iat and no exp is REJECTED (cannot be shown fresh)", async () => {
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const body = JSON.stringify({ text: "no-clock" });
    const header = b64url(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));
    const payload = b64url(new TextEncoder().encode(JSON.stringify({ iss: "sender", body_hash: await sha256hex(body) })));
    const si = `${header}.${payload}`;
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(si)));
    const res = await send("fondant", "ipc", body, `${si}.${b64url(sig)}`);
    expect(res.status).toBe(401);
  });

  test("a fresh JWT (iat now, exp +60s, jti) is ACCEPTED", async () => {
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const body = JSON.stringify({ text: "fresh" });
    const now = Math.floor(Date.now() / 1000);
    const token = await mint(priv, "sender", body, { iat: now, exp: now + 60, jti: "ok-1" });
    const res = await send("fondant", "ipc", body, token);
    expect(res.status).toBe(200);
  });

  test("a small clock skew into the future is tolerated (iat +30s)", async () => {
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const body = JSON.stringify({ text: "skew" });
    const now = Math.floor(Date.now() / 1000);
    const token = await mint(priv, "sender", body, { iat: now + 30, exp: now + 90, jti: "skew-1" });
    expect((await send("fondant", "ipc", body, token)).status).toBe(200);
  });

  test("an absurd future iat is REJECTED (beyond skew allowance)", async () => {
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const body = JSON.stringify({ text: "future" });
    const now = Math.floor(Date.now() / 1000);
    const token = await mint(priv, "sender", body, { iat: now + 86400, jti: "f-1" });
    expect((await send("fondant", "ipc", body, token)).status).toBe(401);
  });
});

describe("AGI-30 §2 — jti replay cache", () => {
  test("the same jti twice is REJECTED the second time", async () => {
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const body = JSON.stringify({ text: "replay-me" });
    const now = Math.floor(Date.now() / 1000);
    const token = await mint(priv, "sender", body, { iat: now, exp: now + 60, jti: "dup-1" });
    expect((await send("fondant", "ipc", body, token)).status).toBe(200);
    const second = await send("fondant", "ipc", body, token);
    expect(second.status).toBe(401);
    expect(await second.text()).toContain("replay");
  });

  test("with NO jti, the (iss, signature) fallback key still blocks a verbatim replay", async () => {
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const body = JSON.stringify({ text: "no-jti" });
    const now = Math.floor(Date.now() / 1000);
    const token = await mint(priv, "sender", body, { iat: now, exp: now + 60 });
    expect((await send("fondant", "ipc", body, token)).status).toBe(200);
    expect((await send("fondant", "ipc", body, token)).status).toBe(401);
  });

  test("the same jti from a DIFFERENT issuer is accepted (key is (iss, jti))", async () => {
    const a = await makeAgent("sender-a");
    const b = await makeAgent("sender-b");
    await makeAgent("fondant");
    const now = Math.floor(Date.now() / 1000);
    const bodyA = JSON.stringify({ text: "a" });
    const bodyB = JSON.stringify({ text: "b" });
    expect((await send("fondant", "ipc", bodyA, await mint(a, "sender-a", bodyA, { iat: now, exp: now + 60, jti: "shared" }))).status).toBe(200);
    expect((await send("fondant", "ipc", bodyB, await mint(b, "sender-b", bodyB, { iat: now, exp: now + 60, jti: "shared" }))).status).toBe(200);
  });

  test("distinct jti from the same issuer are all accepted", async () => {
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const now = Math.floor(Date.now() / 1000);
    for (const n of [1, 2, 3]) {
      const body = JSON.stringify({ text: `m${n}` });
      const token = await mint(priv, "sender", body, { iat: now, exp: now + 60, jti: `u-${n}` });
      expect((await send("fondant", "ipc", body, token)).status).toBe(200);
    }
  });

  test("the replay cache is BOUNDED — it does not grow without limit", async () => {
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const now = Math.floor(Date.now() / 1000);
    setEnv("WIRE_JWT_REPLAY_MAX", "16");
    for (let n = 0; n < 40; n++) {
      const body = JSON.stringify({ n });
      const token = await mint(priv, "sender", body, { iat: now, exp: now + 60, jti: `b-${n}` });
      expect((await send("fondant", "ipc", body, token)).status).toBe(200);
    }
    expect(replayCacheSize()).toBeLessThanOrEqual(16);
    expect(replayCacheSize()).toBeGreaterThan(0);
  });
});

describe("AGI-30 §3 — GRACE mode measures without rejecting", () => {
  test("grace ACCEPTS a stale token but logs one would-reject line", async () => {
    setEnv("WIRE_JWT_MODE", "grace");
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const body = JSON.stringify({ text: "grace" });
    const token = await mint(priv, "sender", body, { iat: Math.floor(Date.now() / 1000) - 3600 });
    expect((await send("fondant", "ipc", body, token)).status).toBe(200);
    const wr = logLines.filter((l) => l.event === "jwt_would_reject");
    expect(wr.length).toBe(1);
    expect(wr[0].iss).toBe("sender");
    expect(String(wr[0].reason)).toContain("stale");
  });

  test("grace ACCEPTS a replayed token and logs a would-reject for it", async () => {
    setEnv("WIRE_JWT_MODE", "grace");
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ text: "grace-replay" });
    const token = await mint(priv, "sender", body, { iat: now, exp: now + 60, jti: "g-1" });
    expect((await send("fondant", "ipc", body, token)).status).toBe(200);
    expect((await send("fondant", "ipc", body, token)).status).toBe(200);
    const wr = logLines.filter((l) => l.event === "jwt_would_reject");
    expect(wr.length).toBe(1);
    expect(String(wr[0].reason)).toContain("replay");
  });

  test("grace still REJECTS a bad signature and a bad body_hash (defence in depth)", async () => {
    setEnv("WIRE_JWT_MODE", "grace");
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ text: "real" });
    const token = await mint(priv, "sender", body, { iat: now, exp: now + 60, jti: "bh-1" });
    // same token, different body → body_hash mismatch
    expect((await send("fondant", "ipc", JSON.stringify({ text: "tampered" }), token)).status).toBe(401);
    const bad = token.slice(0, -4) + "AAAA";
    expect((await send("fondant", "ipc", body, bad)).status).toBe(401);
  });

  test("mode=off restores today's behaviour exactly (stale + replay both accepted, no log)", async () => {
    setEnv("WIRE_JWT_MODE", "off");
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const body = JSON.stringify({ text: "off" });
    const token = await mint(priv, "sender", body, { iat: Math.floor(Date.now() / 1000) - 99999 });
    expect((await send("fondant", "ipc", body, token)).status).toBe(200);
    expect((await send("fondant", "ipc", body, token)).status).toBe(200);
    expect(logLines.filter((l) => l.event === "jwt_would_reject").length).toBe(0);
  });
});

describe("AGI-30 §4 — credential headers never reach the envelope", () => {
  const CRED_HEADERS = {
    "cookie": "wire_session=SHOULD-NOT-TRAVEL",
    "x-api-key": "SHOULD-NOT-TRAVEL-KEY",
    "x-hub-signature": "sha1=SHOULD-NOT-TRAVEL",
    "x-hub-signature-256": "sha256=SHOULD-NOT-TRAVEL",
    "proxy-authorization": "Basic SHOULD-NOT-TRAVEL",
  };

  test("the delivered/persisted IPC envelope carries NO authorization header", async () => {
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ from: "sender", text: "hello" });
    const token = await mint(priv, "sender", body, { iat: now, exp: now + 60, jti: "env-1" });
    const res = await send("fondant", "ipc", body, token);
    expect(res.status).toBe(200);
    const { seq } = await res.json();
    const env = storedEnvelope(seq);
    expect(env.parsed.headers).toBeDefined();
    expect(env.parsed.headers.authorization).toBeUndefined();
    expect(env.raw).not.toContain(token);
    expect(env.raw).not.toContain("Bearer ");
  });

  test("every other credential header is stripped too", async () => {
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ text: "creds" });
    const token = await mint(priv, "sender", body, { iat: now, exp: now + 60, jti: "env-2" });
    const res = await send("fondant", "ipc", body, token, CRED_HEADERS);
    expect(res.status).toBe(200);
    const env = storedEnvelope((await res.json()).seq);
    for (const k of Object.keys(CRED_HEADERS)) expect(env.parsed.headers[k]).toBeUndefined();
    expect(env.raw).not.toContain("SHOULD-NOT-TRAVEL");
  });

  test("non-credential headers SURVIVE (redaction is surgical, not a wipe)", async () => {
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ text: "keep" });
    const token = await mint(priv, "sender", body, { iat: now, exp: now + 60, jti: "env-3" });
    const res = await send("fondant", "ipc", body, token, { "x-github-event": "push", "user-agent": "Bun/1.3.14" });
    const env = storedEnvelope((await res.json()).seq);
    expect(env.parsed.headers["x-github-event"]).toBe("push");
    expect(env.parsed.headers["user-agent"]).toBe("Bun/1.3.14");
    expect(env.parsed.headers["content-type"]).toBe("application/json");
  });

  test("a BROADCAST never fans the signed token out to subscribers", async () => {
    const priv = await makeAgent("sender");
    await makeAgent("sub-a");
    await makeAgent("sub-b");
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ text: "all-hands" });
    const token = await mint(priv, "sender", body, { iat: now, exp: now + 60, jti: "bc-1" });
    const res = await broadcast("status", body, token);
    expect(res.status).toBe(200);
    const env = storedEnvelope((await res.json()).seq);
    expect(env.parsed.headers.authorization).toBeUndefined();
    expect(env.raw).not.toContain(token);
    expect(env.raw).not.toContain("Bearer ");
  });

  test("the message ROW as a whole holds no bearer (payload + raw columns)", async () => {
    const priv = await makeAgent("sender");
    await makeAgent("fondant");
    const now = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ text: "persist" });
    const token = await mint(priv, "sender", body, { iat: now, exp: now + 60, jti: "p-1" });
    const seq = (await (await send("fondant", "ipc", body, token)).json()).seq;
    const row = (store.getRecentMessagesByCount(200) as any[]).find((m) => m.seq === seq);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(JSON.stringify(row)).not.toContain("Bearer ");
  });

  test("END-TO-END over SSE: the frame a live subscriber receives carries no bearer", async () => {
    const recvPriv = await makeAgent("fondant");
    const priv = await makeAgent("sender");
    const now = Math.floor(Date.now() / 1000);

    const connectBody = JSON.stringify({ cc_session_id: "agi30-sse" });
    const connectTok = await mint(recvPriv, "fondant", connectBody, { iat: now, exp: now + 60, jti: "c-1" });
    const cres = await fetch(`${baseUrl}/agents/connect`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${connectTok}` },
      body: connectBody,
    });
    expect(cres.status).toBe(200);
    const { session_id } = await cres.json();

    const sse = await fetch(`${baseUrl}/agents/fondant/stream?session_id=${session_id}`);
    const reader = sse.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const readUntil = async (needle: string, ms = 4000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const r = await Promise.race([reader.read(), new Promise((res) => setTimeout(() => res({ done: true }), 250))]) as any;
        if (r.value) buf += dec.decode(r.value, { stream: true });
        if (buf.includes(needle)) return buf;
      }
      return buf;
    };
    await readUntil(": connected");

    const body = JSON.stringify({ text: "sse-probe" });
    const token = await mint(priv, "sender", body, { iat: now, exp: now + 60, jti: "sse-1" });
    expect((await send("fondant", "ipc", body, token)).status).toBe(200);
    const frames = await readUntil("sse-probe");

    expect(frames).toContain("sse-probe");           // it really was delivered
    expect(frames).not.toContain(token);             // ...without the sender's token
    expect(frames).not.toContain("Bearer ");
    try { await reader.cancel(); } catch {}
  });
});

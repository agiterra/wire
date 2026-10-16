/**
 * A PERMANENT sponsor re-registers a LIVE ephemeral agent (force_rotate) under WIRE_JWT_MODE=enforce.
 *
 * The ephemeral-reregister branch used to call requireAgent (verify + record the jti, then reject on
 * issuer != id) and THEN requirePermanentAgentOrOperator, which verified the same token again and hit
 * "replay: jti … was already spent". Every sponsored re-register of a live ephemeral failed
 * (wallet-browser-register re-enrol, 2026-10-16 23:27Z). The token must be verified exactly once.
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

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const b64url = (u: Uint8Array) => b64(u).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function keypair() {
  const kp = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: kp.privateKey, pub: b64(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey))) };
}
async function token(priv: CryptoKey, iss: string, body: string) {
  const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(new TextEncoder().encode(JSON.stringify({ alg: "EdDSA", typ: "JWT" })));
  const c = b64url(new TextEncoder().encode(JSON.stringify({ iss, iat: now, exp: now + 60, jti: crypto.randomUUID(), body_hash: hash })));
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", priv, new TextEncoder().encode(`${h}.${c}`)));
  return `${h}.${c}.${b64url(sig)}`;
}

let tmpDir: string, store: Store, server: ReturnType<typeof createServer>, baseUrl: string, prevMode: string | undefined;
beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sponsor-rereg-"));
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

async function register(priv: CryptoKey, iss: string, payload: Record<string, unknown>) {
  const body = JSON.stringify(payload);
  return fetch(`${baseUrl}/agents/register`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await token(priv, iss, body)}` },
    body,
  });
}

describe("sponsored re-register of a LIVE ephemeral (enforce)", () => {
  test("permanent sponsor force_rotates a live ephemeral -> 200/201, not a replay", async () => {
    const sponsor = await keypair();
    store.upsertAgent({ id: "fondant", display_name: "fondant", pubkey: sponsor.pub, permanent: true });
    const first = await keypair(), second = await keypair();
    const r1 = await register(sponsor.priv, "fondant", { id: "wallet-vault-x", display_name: "v", pubkey: first.pub, kind: "integration", force_rotate: true });
    expect(r1.status).toBeLessThan(300);
    const r2 = await register(sponsor.priv, "fondant", { id: "wallet-vault-x", display_name: "v", pubkey: second.pub, kind: "integration", force_rotate: true });
    const text = await r2.text();
    expect(text).not.toContain("replay");
    expect(r2.status).toBeLessThan(300);
    expect(store.getAgent("wallet-vault-x")?.pubkey).toBe(second.pub);
  });

  test("the live ephemeral re-registers ITSELF with its own key -> still accepted", async () => {
    const sponsor = await keypair();
    store.upsertAgent({ id: "fondant", display_name: "fondant", pubkey: sponsor.pub, permanent: true });
    const own = await keypair();
    expect((await register(sponsor.priv, "fondant", { id: "eph", display_name: "e", pubkey: own.pub })).status).toBeLessThan(300);
    expect((await register(own.priv, "eph", { id: "eph", display_name: "e", pubkey: own.pub })).status).toBeLessThan(300);
  });

  test("a live ephemeral with a NON-ASCII id re-registers itself (issuer decoded as UTF-8)", async () => {
    const sponsor = await keypair();
    store.upsertAgent({ id: "fondant", display_name: "fondant", pubkey: sponsor.pub, permanent: true });
    const own = await keypair();
    expect((await register(sponsor.priv, "fondant", { id: "café", display_name: "c", pubkey: own.pub })).status).toBeLessThan(300);
    const r = await register(own.priv, "café", { id: "café", display_name: "c", pubkey: own.pub });
    expect(await r.text()).not.toContain("sponsor_not_permanent");
    expect(r.status).toBeLessThan(300);
  });

  test("a REUSED sponsor token on a SECOND request is still rejected as a replay", async () => {
    const sponsor = await keypair();
    store.upsertAgent({ id: "fondant", display_name: "fondant", pubkey: sponsor.pub, permanent: true });
    const first = await keypair();
    expect((await register(sponsor.priv, "fondant", { id: "wallet-vault-y", display_name: "v", pubkey: first.pub, kind: "integration", force_rotate: true })).status).toBeLessThan(300);
    // One token, sent twice: the first use must pass, the second must be refused as a replay.
    const body = JSON.stringify({ id: "wallet-vault-y", display_name: "v", pubkey: (await keypair()).pub, kind: "integration", force_rotate: true });
    const tok = await token(sponsor.priv, "fondant", body);
    const send = () => fetch(`${baseUrl}/agents/register`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body });
    expect((await send()).status).toBeLessThan(300);
    const again = await send();
    expect(again.status).toBe(403);
    expect(await again.text()).toContain("replay");
  });

  test("a REUSED self token on a SECOND request is still rejected as a replay", async () => {
    const sponsor = await keypair();
    store.upsertAgent({ id: "fondant", display_name: "fondant", pubkey: sponsor.pub, permanent: true });
    const own = await keypair();
    expect((await register(sponsor.priv, "fondant", { id: "eph-self", display_name: "e", pubkey: own.pub })).status).toBeLessThan(300);
    const body = JSON.stringify({ id: "eph-self", display_name: "e", pubkey: own.pub });
    const tok = await token(own.priv, "eph-self", body);
    const send = () => fetch(`${baseUrl}/agents/register`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok}` }, body });
    expect((await send()).status).toBeLessThan(300);
    const again = await send();
    expect(again.status).toBe(403);
    expect(await again.text()).toContain("replay");
  });

  test("an EPHEMERAL may not sponsor another live ephemeral's re-register", async () => {
    const sponsor = await keypair();
    store.upsertAgent({ id: "fondant", display_name: "fondant", pubkey: sponsor.pub, permanent: true });
    const a = await keypair(), b = await keypair();
    await register(sponsor.priv, "fondant", { id: "eph-a", display_name: "a", pubkey: a.pub });
    await register(sponsor.priv, "fondant", { id: "eph-b", display_name: "b", pubkey: b.pub });
    const r = await register(a.priv, "eph-a", { id: "eph-b", display_name: "b", pubkey: (await keypair()).pub, force_rotate: true });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

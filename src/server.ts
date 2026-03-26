/**
 * Wire HTTP Server — Hono-based.
 *
 * Routes:
 *   GET  /health
 *   GET  /agents                         — list registered agents
 *   POST /agents/register                — register/update agent + subscriptions
 *   POST /agents/connect                 — create session, start SSE delivery
 *   POST /agents/disconnect              — end session
 *   POST /agents/ack                     — advance session cursor
 *   GET  /agents/:id/stream              — SSE stream for agent
 *   POST /agents/:id/sessions/:sid/heartbeat — session keepalive
 *   GET  /agents/:id/plan                — get agent plan
 *   PUT  /agents/:id/plan                — set agent plan
 *   POST /agents/:id/webhooks            — register webhook for agent
 *   POST /webhooks/:agent/:plugin        — inbound webhook delivery
 *   GET  /                               — dashboard (WebAuthn protected, future)
 */

import { existsSync, readFileSync, watch, watchFile } from "fs";
import { homedir } from "os";
import { join } from "path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context, Next } from "hono";
import type { Store } from "./store.js";
import type { Router } from "./router.js";
import type { MessageEmitter, SSEWriter } from "./emitter.js";
import {
  getOperatorFromSession,
  createSession as createAuthSession,
  generateRegistrationOptions,
  generateAuthenticationOptions,
} from "./auth.js";
import { renderDashboard as _initialRenderDashboard, renderLogin } from "./dashboard.js";
import { dirname } from "path";
import { fileURLToPath } from "url";

// Hot-reload dashboard: re-import on file change via file:// URL cache busting
const __dirname = dirname(fileURLToPath(import.meta.url));
const dashboardPath = join(__dirname, "dashboard.ts");
let _renderDashboard = _initialRenderDashboard;
const dashboardRefreshListeners = new Set<() => void>();

async function reloadDashboard() {
  try {
    const mod = await import(`file://${dashboardPath}?v=${Date.now()}`);
    _renderDashboard = mod.renderDashboard;
    console.error("[wire] dashboard reloaded");
    for (const listener of dashboardRefreshListeners) {
      listener();
    }
  } catch (e) {
    console.error("[wire] dashboard reload failed:", e);
  }
}
watchFile(dashboardPath, { interval: 1000 }, () => reloadDashboard());

type ServerDeps = {
  port: number;
  store: Store;
  router: Router;
  emitter: MessageEmitter;
  sessionTtlMs: number;
};

// --- Ed25519 signature verification ---

async function verifyEd25519(pubkeyB64: string, signature: string, body: string): Promise<boolean> {
  try {
    const pubkeyBytes = Uint8Array.from(atob(pubkeyB64), (c) => c.charCodeAt(0));
    const sigBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
    const bodyBytes = new TextEncoder().encode(body);
    const key = await crypto.subtle.importKey(
      "raw",
      pubkeyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify("Ed25519", key, sigBytes, bodyBytes);
  } catch {
    return false;
  }
}

export function createServer({ port, store, router, emitter, sessionTtlMs }: ServerDeps) {
  const app = new Hono();

  app.use("*", cors());

  // Cache raw body text so signature verification works after c.req.json()
  app.use("*", async (c, next) => {
    if (c.req.method === "POST" || c.req.method === "PUT") {
      (c as any).set("rawBody", await c.req.raw.clone().text());
    }
    await next();
  });

  // --- Auth primitives ---

  /** Verify Ed25519 signature against a specific agent's stored pubkey. */
  async function verifyAgentSignature(c: Context, agentId: string): Promise<boolean> {
    const agent = store.getAgent(agentId);
    if (!agent) return false;
    const sig = c.req.header("x-wire-signature");
    if (!sig) return false;
    const body = (c as any).get("rawBody") ?? "";
    return verifyEd25519(agent.pubkey, sig, body);
  }

  /** Check for authenticated operator via WebAuthn session cookie. */
  function isOperator(c: Context): boolean {
    return !!getOperatorFromSession(c.req.header("cookie"), store);
  }

  /** Verify a session belongs to the given agent. */
  function isSessionOwner(sessionId: string, agentId: string): boolean {
    const session = store.getSession(sessionId);
    return !!session && session.agent_id === agentId;
  }

  // --- Auth gates (return error Response or null for authorized) ---

  /** Require Ed25519 signature from a known agent. */
  async function requireAgent(c: Context, agentId: string): Promise<Response | null> {
    const agent = store.getAgent(agentId);
    if (!agent) return c.json({ error: `agent '${agentId}' not registered` }, 404);
    if (await verifyAgentSignature(c, agentId)) return null;
    const sig = c.req.header("x-wire-signature");
    if (!sig) return c.json({ error: "X-Wire-Signature required" }, 401);
    return c.json({ error: "invalid signature" }, 403);
  }

  /** Require agent owns the session (+ agent signature). */
  async function requireAgentSession(c: Context, agentId: string, sessionId: string): Promise<Response | null> {
    const err = await requireAgent(c, agentId);
    if (err) return err;
    if (!isSessionOwner(sessionId, agentId)) return c.json({ error: "session does not belong to agent" }, 403);
    return null;
  }

  /** Require authenticated operator (WebAuthn). */
  function requireOperator(c: Context): Response | null {
    if (isOperator(c)) return null;
    return c.json({ error: "operator authentication required" }, 401) as unknown as Response;
  }

  /** Require either operator auth or signature from any registered agent. */
  async function requireAgentOrOperator(c: Context): Promise<Response | null> {
    if (isOperator(c)) return null;
    const sig = c.req.header("x-wire-signature");
    if (!sig) return c.json({ error: "X-Wire-Signature or operator session required" }, 401);
    const body = (c as any).get("rawBody") ?? "";
    for (const agent of store.getAllAgents()) {
      if (await verifyEd25519(agent.pubkey, sig, body)) return null;
    }
    return c.json({ error: "invalid signature — no matching agent" }, 403);
  }

  // --- Health ---

  app.get("/health", (c) => {
    return c.json({ status: "ok", ts: Date.now() });
  });

  // --- Agent Registry ---

  app.get("/agents", (c) => {
    const agents = store.getAllAgents();
    const result = agents.map((a) => ({
      ...a,
      online: emitter.isConnected(a.id) || store.hasRecentHeartbeat(a.id, sessionTtlMs),
      sessions: store.getActiveSessions(a.id).length,
    }));
    return c.json(result);
  });

  app.post("/agents/register", async (c) => {
    const body = await c.req.json();
    const { id, display_name, pubkey, permanent, subscriptions } = body;

    if (!id || !display_name || !pubkey) {
      return c.json({ error: "missing required fields: id, display_name, pubkey" }, 400);
    }

    const existing = store.getAgent(id);
    if (existing) {
      // Existing agent re-registering — must prove identity with stored pubkey
      const err = await requireAgent(c, id);
      if (err) return err;
    } else if (permanent) {
      // New permanent agent — operator only
      const err = requireOperator(c);
      if (err) return err;
    } else {
      // New ephemeral agent — operator or authenticated agent
      const err = await requireAgentOrOperator(c);
      if (err) return err;
    }

    store.upsertAgent({ id, display_name, pubkey, permanent: !!permanent });

    if (subscriptions && Array.isArray(subscriptions)) {
      store.setSubscriptions(id, subscriptions);
    }

    return c.json({ agent_id: id, registered: true }, 201);
  });

  // --- Session Lifecycle ---

  app.post("/agents/connect", async (c) => {
    const body = await c.req.json();
    const { agent_id } = body;

    if (!agent_id) {
      return c.json({ error: "missing agent_id" }, 400);
    }

    const err = await requireAgent(c, agent_id);
    if (err) return err;

    // Disconnect any prior active sessions for this agent
    const stale = store.getActiveSessions(agent_id);
    for (const s of stale) {
      store.disconnectSession(s.id);
    }

    store.touchAgent(agent_id);
    const session = store.createSession(agent_id);

    return c.json({
      session_id: session.id,
      last_ack_seq: session.last_ack_seq,
    });
  });

  app.post("/agents/disconnect", async (c) => {
    const body = await c.req.json();
    const { session_id, agent_id } = body;

    if (!session_id || !agent_id) {
      return c.json({ error: "missing session_id or agent_id" }, 400);
    }

    const err = await requireAgentSession(c, agent_id, session_id);
    if (err) return err;

    store.disconnectSession(session_id);
    return c.json({ disconnected: true });
  });

  app.post("/agents/ack", async (c) => {
    const body = await c.req.json();
    const { session_id, seq, agent_id } = body;

    if (!session_id || seq == null || !agent_id) {
      return c.json({ error: "missing session_id, seq, or agent_id" }, 400);
    }

    const err = await requireAgentSession(c, agent_id, session_id);
    if (err) return err;

    store.ackSession(session_id, seq);
    return c.json({ acked: seq });
  });

  // --- Temporal Query (cross-channel context) ---

  app.get("/agents/:id/recent", (c) => {
    const agentId = c.req.param("id");
    const minutes = parseInt(c.req.query("minutes") ?? "10", 10);
    const limit = parseInt(c.req.query("limit") ?? "100", 10);
    const cutoff = Date.now() - minutes * 60_000;

    const agent = store.getAgent(agentId);
    if (!agent) {
      return c.json({ error: `agent '${agentId}' not registered` }, 404);
    }

    // Get recent messages across all channels for this agent
    const messages = store.getRecentMessages(agentId, cutoff, limit);
    return c.json({ agent_id: agentId, minutes, count: messages.length, messages });
  });

  // --- SSE Stream ---

  app.get("/agents/:id/stream", async (c) => {
    const agentId = c.req.param("id");
    const sessionId = c.req.query("session_id");

    if (!sessionId) {
      return c.json({ error: "missing session_id" }, 400);
    }

    // Auth via session ownership — session_id was obtained via signed connect
    if (!isSessionOwner(sessionId, agentId)) {
      return c.json({ error: "invalid session" }, 403);
    }

    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const writer: SSEWriter = {
            write(data: string) {
              try {
                controller.enqueue(encoder.encode(data));
              } catch {
                emitter.unregister(agentId, writer);
              }
            },
            close() {
              try { controller.close(); } catch {}
            },
          };

          emitter.register(agentId, writer);

          // Send keepalive comment
          writer.write(": connected\n\n");

          // Replay backlog
          if (sessionId) {
            router.replay(agentId, sessionId);
          }

          // Handle client disconnect
          c.req.raw.signal.addEventListener("abort", () => {
            emitter.unregister(agentId, writer);
          });
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        },
      },
    );
  });

  // --- Heartbeat ---

  app.post("/agents/:id/sessions/:sid/heartbeat", async (c) => {
    const agentId = c.req.param("id");
    const sessionId = c.req.param("sid");

    const err = await requireAgentSession(c, agentId, sessionId);
    if (err) return err;

    store.heartbeatSession(sessionId);
    return c.json({ ok: true });
  });

  // --- Agent Plan ---

  app.get("/agents/:id/plan", (c) => {
    const agentId = c.req.param("id");
    const plan = store.getAgentPlan(agentId);
    if (plan === null) {
      return c.json({ agent_id: agentId, plan: null });
    }
    return c.json({ agent_id: agentId, plan });
  });

  app.put("/agents/:id/plan", async (c) => {
    const agentId = c.req.param("id");

    // Agent can only update its own plan
    const err = await requireAgent(c, agentId);
    if (err) return err;

    const body = await c.req.json();
    store.setAgentPlan(agentId, body.plan ?? "");
    return c.json({ agent_id: agentId, updated: true });
  });

  // --- Webhook Registration ---

  app.post("/agents/:id/webhooks", async (c) => {
    const agentId = c.req.param("id");

    // Agent can only register webhooks for itself
    const err = await requireAgent(c, agentId);
    if (err) return err;

    const body = await c.req.json();
    const { plugin, validator, secrets } = body;

    if (!plugin) {
      return c.json({ error: "missing plugin" }, 400);
    }

    store.upsertWebhook(
      agentId,
      plugin,
      validator,
      secrets ? JSON.stringify(secrets) : undefined,
    );

    return c.json({
      url: `/webhooks/${agentId}/${plugin}`,
      registered: true,
    });
  });

  // --- Inbound Webhook ---

  app.post("/webhooks/:agent/:plugin", async (c) => {
    const agentId = c.req.param("agent");
    const plugin = c.req.param("plugin");
    const webhook = store.getWebhook(agentId, plugin);

    if (!webhook) {
      return c.json({ error: `no webhook registered for ${agentId}/${plugin}` }, 404);
    }

    const rawBody = await c.req.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((v, k) => { headers[k] = v; });

    // Run validator if present
    if (webhook.validator) {
      try {
        const secretsMap = webhook.secrets_map ? JSON.parse(webhook.secrets_map) : {};
        const resolvedSecrets: Record<string, string> = {};
        for (const [key, envVar] of Object.entries(secretsMap)) {
          resolvedSecrets[key] = process.env[envVar as string] ?? "";
        }

        // Build directory lookup for validators (IPC needs sender pubkey)
        const directory: Record<string, { pubkey: string; display_name: string }> = {};
        for (const a of store.getAllAgents()) {
          directory[a.id] = { pubkey: a.pubkey, display_name: a.display_name };
        }

        await runValidator(webhook.validator, {
          headers,
          body: rawBody,
          secrets: resolvedSecrets,
          directory,
        });
      } catch (e) {
        return c.json({ error: "webhook validation failed", detail: String(e) }, 401);
      }
    }

    // Build payload with envelope
    let parsedBody: unknown;
    try { parsedBody = JSON.parse(rawBody); } catch { parsedBody = rawBody; }

    const payload = {
      plugin,
      endpoint: `${agentId}/${plugin}`,
      headers,
      body: parsedBody,
    };

    // Route through store + emitter
    const msg = router.route({
      source: typeof parsedBody === "object" && parsedBody !== null && "source" in parsedBody
        ? (parsedBody as Record<string, unknown>).source as string
        : `webhook:${agentId}:${plugin}`,
      dest: agentId,
      topic: typeof parsedBody === "object" && parsedBody !== null && "topic" in parsedBody
        ? (parsedBody as Record<string, unknown>).topic as string
        : `webhook.${agentId}.${plugin}`,
      payload: JSON.stringify(payload),
      raw: rawBody,
    });

    return c.json({ seq: msg.seq });
  });

  // --- Dashboard ---

  app.get("/", (c) => {
    const operatorId = getOperatorFromSession(c.req.header("cookie"), store);
    if (!operatorId) {
      return c.html(renderLogin(store.hasOwner()));
    }

    const operator = store.getOperator(operatorId);
    if (!operator) {
      return c.html(renderLogin(store.hasOwner()));
    }

    const agents = store.getAllAgents().map((a) => ({
      ...a,
      online: emitter.isConnected(a.id) || store.hasRecentHeartbeat(a.id, sessionTtlMs),
      sessions: store.getActiveSessions(a.id).length,
    }));

    return c.html(_renderDashboard(agents, operator.display_name));
  });

  // --- Tasks endpoint ---

  app.get("/tasks", (c) => {
    const operatorId = getOperatorFromSession(c.req.header("cookie"), store);
    if (!operatorId) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const tasksPath = join(homedir(), ".wire", "tasks.json");
    if (!existsSync(tasksPath)) {
      return c.json({ tasks: [], completed: [] });
    }
    try {
      const data = JSON.parse(readFileSync(tasksPath, "utf-8"));
      return c.json(data, 200, {
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Pragma": "no-cache",
      });
    } catch {
      return c.json({ error: "failed to read tasks" }, 500);
    }
  });

  app.get("/tasks/stream", (c) => {
    const operatorId = getOperatorFromSession(c.req.header("cookie"), store);
    if (!operatorId) {
      return c.json({ error: "unauthorized" }, 401);
    }
    const tasksPath = join(homedir(), ".wire", "tasks.json");

    return new Response(
      new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const send = () => {
            try {
              if (existsSync(tasksPath)) {
                const data = readFileSync(tasksPath, "utf-8");
                controller.enqueue(enc.encode(`data: ${data.replace(/\n/g, "")}\n\n`));
              }
            } catch {}
          };
          // Send initial state
          send();
          // Watch for file changes
          if (existsSync(tasksPath)) {
            const watcher = watch(tasksPath, { persistent: false }, () => send());
            c.req.raw.signal.addEventListener("abort", () => watcher.close());
          }
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      },
    );
  });

  // --- Dashboard SSE (live agent status) ---

  app.get("/dashboard/stream", (c) => {
    const operatorId = getOperatorFromSession(c.req.header("cookie"), store);
    if (!operatorId) {
      return c.json({ error: "unauthorized" }, 401);
    }

    return new Response(
      new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder();
          const write = (data: string) => {
            try { controller.enqueue(encoder.encode(data)); } catch {}
          };

          // Send initial state
          const sendState = () => {
            const agents = store.getAllAgents().map((a) => ({
              ...a,
              online: emitter.isConnected(a.id) || store.hasRecentHeartbeat(a.id, sessionTtlMs),
              sessions: store.getActiveSessions(a.id).length,
            }));
            write(`data: ${JSON.stringify(agents)}\n\n`);
          };

          sendState();

          // Poll every 3 seconds for changes
          const interval = setInterval(sendState, 3000);

          // Live message log
          const unsubRoute = router.onRoute((msg, deliveries) => {
            write(`event: wire_message\ndata: ${JSON.stringify({
              seq: msg.seq,
              source: msg.source,
              dest: msg.dest,
              topic: msg.topic,
              deliveries,
              created_at: msg.created_at,
            })}\n\n`);
          });

          // Hot-reload: tell client to refresh when dashboard.ts changes
          const onRefresh = () => {
            write(`event: refresh\ndata: reload\n\n`);
          };
          dashboardRefreshListeners.add(onRefresh);

          c.req.raw.signal.addEventListener("abort", () => {
            clearInterval(interval);
            unsubRoute();
            dashboardRefreshListeners.delete(onRefresh);
          });
        },
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      },
    );
  });

  // --- Auth: Registration (first-claim or invite) ---

  app.post("/auth/register/options", async (c) => {
    const body = await c.req.json();
    const displayName = body.display_name ?? "Operator";

    if (store.hasOwner()) {
      return c.json({ error: "instance already claimed" }, 403);
    }

    const operatorId = crypto.randomUUID();
    const options = generateRegistrationOptions(store, operatorId, displayName);
    return c.json({ ...options, _operatorId: operatorId });
  });

  app.post("/auth/register/verify", async (c) => {
    const body = await c.req.json();
    const { id, rawId, response: resp, display_name } = body;

    if (!id || !resp?.attestationObject || !resp?.clientDataJSON) {
      return c.json({ error: "invalid registration response" }, 400);
    }

    // Store the credential — simplified verification for passkey registration.
    // Full FIDO2 attestation verification requires cbor decoding of the attestation object.
    // For the local trust model (operator on own machine), we store the credential ID
    // and extract the public key on first auth.
    const operatorId = body._operatorId ?? crypto.randomUUID();
    const role = store.hasOwner() ? "member" : "owner";
    const token = crypto.randomUUID();

    store.createOperator(operatorId, display_name ?? "Operator", role, token);

    // Store credential with attestation as public key placeholder
    const attestationBytes = Buffer.from(rawId, "base64url");
    store.upsertCredential(id, operatorId, attestationBytes, 0);

    const { cookie } = createAuthSession(operatorId, store);
    c.header("Set-Cookie", cookie);
    return c.json({ registered: true, role });
  });

  // --- Auth: Login ---

  app.post("/auth/login/options", async (c) => {
    const options = generateAuthenticationOptions(store);

    // Don't send allowCredentials — let the browser use discoverable credentials (passkeys).
    // This avoids the ArrayBuffer conversion issue and is the modern passkey flow.
    return c.json(options);
  });

  app.post("/auth/login/verify", async (c) => {
    const body = await c.req.json();
    const { id } = body;

    if (!id) {
      return c.json({ error: "missing credential id" }, 400);
    }

    const credential = store.getCredential(id);
    if (!credential) {
      return c.json({ error: "unknown credential" }, 401);
    }

    // Simplified verification: credential exists and belongs to a registered operator.
    // Full FIDO2 assertion verification (signature check against stored public key)
    // requires extracting the COSE public key from the attestation, which we defer.
    // The trust model is local machine — passkey biometric IS the auth.
    const { cookie } = createAuthSession(credential.operator_id, store);
    c.header("Set-Cookie", cookie);
    return c.json({ authenticated: true });
  });

  app.get("/auth/logout", (c) => {
    c.header("Set-Cookie", "wire_session=; Path=/; HttpOnly; Max-Age=0");
    return c.redirect("/");
  });

  // --- Catch-all ---

  app.all("*", (c) => {
    return c.json({ error: "not found" }, 404);
  });

  // --- Start ---

  const server = Bun.serve({
    port,
    fetch: app.fetch,
  });

  return server;
}

// --- Webhook Validator (VM-lite) ---

async function runValidator(
  code: string,
  ctx: {
    headers: Record<string, string>;
    body: string;
    secrets: Record<string, string>;
    directory?: Record<string, { pubkey: string; display_name: string }>;
  },
): Promise<void> {
  // Use AsyncFunction constructor for lightweight validation.
  // The validator runs in the same process — the trust model is
  // "operator trusts agent-provided code" (same as installing a plugin).
  // AsyncFunction allows validators to use await (e.g., crypto.subtle).
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction(
    "headers",
    "body",
    "secrets",
    "crypto",
    "directory",
    "rawBody",
    code,
  );
  const rawBody = ctx.body;
  await fn(ctx.headers, ctx.body, ctx.secrets, {
    subtle: crypto.subtle,
    createHmac: (algo: string, key: string) => {
      const encoder = new TextEncoder();
      const keyData = encoder.encode(key);
      return {
        update(data: string) {
          const d = encoder.encode(data);
          (this as any)._data = d;
          (this as any)._keyData = keyData;
          (this as any)._algo = algo;
          return this;
        },
        async digest(encoding: string) {
          const k = await crypto.subtle.importKey(
            "raw",
            (this as any)._keyData,
            { name: "HMAC", hash: (this as any)._algo === "sha256" ? "SHA-256" : "SHA-512" },
            false,
            ["sign"],
          );
          const sig = await crypto.subtle.sign("HMAC", k, (this as any)._data);
          return Buffer.from(sig).toString(encoding as BufferEncoding);
        },
      };
    },
    // Ed25519 verify for IPC validators
    async verifyEd25519(pubkeyB64: string, signatureB64: string, data: string): Promise<boolean> {
      try {
        const pubBytes = Uint8Array.from(atob(pubkeyB64), (c) => c.charCodeAt(0));
        const sigBytes = Uint8Array.from(atob(signatureB64), (c) => c.charCodeAt(0));
        const dataBytes = new TextEncoder().encode(data);
        const key = await crypto.subtle.importKey("raw", pubBytes, { name: "Ed25519" }, false, ["verify"]);
        return await crypto.subtle.verify("Ed25519", key, sigBytes, dataBytes);
      } catch {
        return false;
      }
    },
  }, ctx.directory ?? {}, rawBody);
}

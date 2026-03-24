/**
 * Exchange HTTP Server — Hono-based.
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

import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context, Next } from "hono";
import type { Store } from "./store.js";
import type { Router } from "./router.js";
import type { MessageEmitter, SSEWriter } from "./emitter.js";

type ServerDeps = {
  port: number;
  store: Store;
  router: Router;
  emitter: MessageEmitter;
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

function isLocalhost(c: Context): boolean {
  const host = c.req.header("host") ?? "";
  return host.startsWith("localhost") || host.startsWith("127.0.0.1") || host.startsWith("[::1]");
}

export function createServer({ port, store, router, emitter }: ServerDeps) {
  const app = new Hono();

  app.use("*", cors());

  // --- Agent control plane auth middleware ---
  // Protects agent mutation endpoints. An agent can only modify its own resources.
  // Auth: Ed25519 signature in X-Exchange-Signature header, OR localhost origin.
  // The agent ID is extracted from the route param :id or from the request body.

  async function requireAgent(c: Context, agentId: string): Promise<Response | null> {
    const agent = store.getAgent(agentId);
    if (!agent) {
      return c.json({ error: `agent '${agentId}' not registered` }, 404);
    }

    const sig = c.req.header("x-exchange-signature");
    if (sig) {
      // Verify Ed25519 signature against registered pubkey
      const body = await c.req.raw.clone().text();
      const valid = await verifyEd25519(agent.pubkey, sig, body);
      if (!valid) {
        return c.json({ error: "invalid signature" }, 403);
      }
      return null; // authorized
    }

    // No signature — allow if localhost (local agents connecting without signing)
    if (isLocalhost(c)) {
      return null; // authorized
    }

    return c.json({ error: "authentication required: X-Exchange-Signature or localhost" }, 401);
  }

  // Verify a session belongs to the claiming agent
  function requireSessionOwner(sessionId: string, agentId?: string): string | null {
    const session = store.getSession(sessionId);
    if (!session) return "session not found";
    if (agentId && session.agent_id !== agentId) return "session does not belong to agent";
    return null; // ok
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
      online: emitter.isConnected(a.id),
      sessions: store.getActiveSessions(a.id).length,
    }));
    return c.json(result);
  });

  app.post("/agents/register", async (c) => {
    const body = await c.req.json();
    const { id, display_name, pubkey, subscriptions } = body;

    if (!id || !display_name || !pubkey) {
      return c.json({ error: "missing required fields: id, display_name, pubkey" }, 400);
    }

    // Registration: if agent already exists, require auth (can't hijack identity)
    const existing = store.getAgent(id);
    if (existing) {
      const err = await requireAgent(c, id);
      if (err) return err;
    } else if (!isLocalhost(c)) {
      // New registrations only from localhost
      return c.json({ error: "new agent registration requires localhost" }, 403);
    }

    store.upsertAgent({ id, display_name, pubkey });

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

    if (!session_id) {
      return c.json({ error: "missing session_id" }, 400);
    }

    // Verify session ownership if agent_id provided
    if (agent_id) {
      const err = await requireAgent(c, agent_id);
      if (err) return err;
      const ownerErr = requireSessionOwner(session_id, agent_id);
      if (ownerErr) return c.json({ error: ownerErr }, 403);
    } else if (!isLocalhost(c)) {
      return c.json({ error: "agent_id required for remote disconnect" }, 400);
    }

    store.disconnectSession(session_id);
    return c.json({ disconnected: true });
  });

  app.post("/agents/ack", async (c) => {
    const body = await c.req.json();
    const { session_id, seq, agent_id } = body;

    if (!session_id || seq == null) {
      return c.json({ error: "missing session_id or seq" }, 400);
    }

    // Verify session ownership if agent_id provided
    if (agent_id) {
      const err = await requireAgent(c, agent_id);
      if (err) return err;
      const ownerErr = requireSessionOwner(session_id, agent_id);
      if (ownerErr) return c.json({ error: ownerErr }, 403);
    } else if (!isLocalhost(c)) {
      return c.json({ error: "agent_id required for remote ack" }, 400);
    }

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

    // SSE stream requires agent auth
    const err = await requireAgent(c, agentId);
    if (err) return err;

    const agent = store.getAgent(agentId);
    if (!agent) {
      return c.json({ error: `agent '${agentId}' not registered` }, 404);
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

    const err = await requireAgent(c, agentId);
    if (err) return err;

    const ownerErr = requireSessionOwner(sessionId, agentId);
    if (ownerErr) return c.json({ error: ownerErr }, 403);

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

  // --- Dashboard (placeholder) ---

  app.get("/", (c) => {
    return c.json({ error: "registry UI not found" }, 404);
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
  // Use Function constructor for lightweight validation.
  // The validator runs in the same process — the trust model is
  // "operator trusts agent-provided code" (same as installing a plugin).
  const fn = new Function(
    "headers",
    "body",
    "secrets",
    "crypto",
    "directory",
    code,
  );
  await fn(ctx.headers, ctx.body, ctx.secrets, {
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
  }, ctx.directory ?? {});
}

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "./store";

let tmpDir: string;
let dbPath: string;
let store: Store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wire-janitor-"));
  dbPath = join(tmpDir, "wire.db");
  store = new Store(dbPath);
});

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function makeAgent(id: string, opts: { permanent?: boolean } = {}): void {
  store.upsertAgent({
    id,
    display_name: id,
    pubkey: "test-pubkey-" + id,
    permanent: opts.permanent ?? false,
  });
}

function makeWebhook(agentId: string, name: string, cleanup?: string, sessionId?: string): number {
  return store.createWebhook({
    agentId,
    plugin: "github",
    name,
    cleanup,
    sessionId,
  });
}

function ageWebhook(webhookId: number, ageMs: number): void {
  // @ts-expect-error — test reaches into the Store's db handle to fake age
  store.db.prepare("UPDATE webhooks SET created_at = ? WHERE id = ?")
    .run(Date.now() - ageMs, webhookId);
}

function insertSession(agentId: string, lastHeartbeatAgeMs: number): string {
  // createSession's last_ack_seq subquery requires a messages row to exist
  // in real use; in tests we just write the agent_sessions row directly.
  const id = "sess-" + agentId + "-" + Math.random().toString(36).slice(2, 8);
  const now = Date.now();
  // @ts-expect-error — test reaches into the Store's db handle
  store.db.prepare(`
    INSERT INTO agent_sessions (id, agent_id, runtime, connected_at, last_ack_seq, updated_at, last_heartbeat, status)
    VALUES (?, ?, 'claude-code', ?, 0, ?, ?, 'connected')
  `).run(id, agentId, now, now, now - lastHeartbeatAgeMs);
  return id;
}

function freshSession(agentId: string): string {
  return insertSession(agentId, 0);
}

function staleSession(agentId: string, lastHeartbeatAgeMs: number): string {
  return insertSession(agentId, lastHeartbeatAgeMs);
}

describe("getStaleWebhooks — janitor query", () => {
  test("returns webhook when owner has no session at all and webhook is older than cutoff", () => {
    makeAgent("orphan");
    const wid = makeWebhook("orphan", "pr-1");
    ageWebhook(wid, 2_000_000);
    const stale = store.getStaleWebhooks(60_000);
    expect(stale.map((w) => w.id)).toContain(wid);
  });

  test("excludes webhook when owner has a fresh-heartbeating session", () => {
    makeAgent("alive");
    const wid = makeWebhook("alive", "pr-2");
    ageWebhook(wid, 2_000_000);
    freshSession("alive");
    const stale = store.getStaleWebhooks(60_000);
    expect(stale.map((w) => w.id)).not.toContain(wid);
  });

  test("includes webhook when owner's only session is stale beyond cutoff", () => {
    makeAgent("dozing");
    const wid = makeWebhook("dozing", "pr-3");
    ageWebhook(wid, 2_000_000);
    staleSession("dozing", 5 * 60_000);
    const stale = store.getStaleWebhooks(60_000);
    expect(stale.map((w) => w.id)).toContain(wid);
  });

  test("excludes a webhook that was just created (created_at within cutoff window)", () => {
    makeAgent("just-registered");
    const wid = makeWebhook("just-registered", "pr-4");
    // No session yet, but webhook was created just now — leave it alone.
    const stale = store.getStaleWebhooks(60_000);
    expect(stale.map((w) => w.id)).not.toContain(wid);
  });

  test("preserves permanent agents' webhooks even when sessions are stale", () => {
    // Permanent agents' webhook URLs are advertised to external services
    // (Slack, GitHub). Sweeping on heartbeat lapse silently breaks the
    // integration — operator manages lifecycle explicitly instead.
    makeAgent("perma", { permanent: true });
    const wid = makeWebhook("perma", "pr-5");
    ageWebhook(wid, 2_000_000);
    staleSession("perma", 5 * 60_000);
    const stale = store.getStaleWebhooks(60_000);
    expect(stale.map((w) => w.id)).not.toContain(wid);
  });

  test("still sweeps an ephemeral webhook when its agent has no fresh heartbeat", () => {
    // Complement to the permanent-preserve test above: the ephemeral path
    // must keep working so dead ephemerals don't leak webhook rows forever.
    makeAgent("ephemeral-dead", { permanent: false });
    const wid = makeWebhook("ephemeral-dead", "pr-ephemeral");
    ageWebhook(wid, 2_000_000);
    staleSession("ephemeral-dead", 5 * 60_000);
    const stale = store.getStaleWebhooks(60_000);
    expect(stale.map((w) => w.id)).toContain(wid);
  });

  test("session-scoped: getWebhooksBySession returns only matching session_id", () => {
    makeAgent("scoped");
    const sid = freshSession("scoped");
    const wid = makeWebhook("scoped", "pr-7", undefined, sid);
    const widAgentScoped = makeWebhook("scoped", "pr-8"); // no sessionId

    const bySession = store.getWebhooksBySession(sid);
    expect(bySession.map((w) => w.id)).toEqual([wid]);

    // Webhook table round-trips session_id
    const got = store.getWebhookById(wid);
    expect(got?.session_id).toBe(sid);
    const gotAgentScoped = store.getWebhookById(widAgentScoped);
    expect(gotAgentScoped?.session_id).toBeNull();
  });

  test("responder column round-trips opaque JS string", () => {
    makeAgent("withResp");
    const responderJs = "return parsedBody?.type === 'x' ? { body: { ok: true } } : null;";
    const wid = store.createWebhook({
      agentId: "withResp",
      plugin: "test",
      name: "rt",
      responder: responderJs,
    });
    const got = store.getWebhookById(wid);
    expect(got?.responder).toBe(responderJs);

    const widNo = store.createWebhook({
      agentId: "withResp",
      plugin: "test",
      name: "rt-no",
    });
    expect(store.getWebhookById(widNo)?.responder).toBeNull();
  });

  test("re-runnable: dependents_purged_at being set does NOT exempt orphans (Madeleine/Tiramisu bug)", () => {
    makeAgent("returning-ephemeral");
    // Simulate the post-purge state: agent was purged once, then registered a
    // new webhook later, then went offline again. Old reaper would skip
    // because dependents_purged_at IS NOT NULL. New janitor must not skip.
    // @ts-expect-error — test reaches into the Store's db handle
    store.db.prepare("UPDATE agents SET dependents_purged_at = ?, reaped_at = ? WHERE id = ?")
      .run(Date.now() - 86_400_000, Date.now() - 86_400_000, "returning-ephemeral");
    const wid = makeWebhook("returning-ephemeral", "pr-6");
    ageWebhook(wid, 2_000_000);
    const stale = store.getStaleWebhooks(60_000);
    expect(stale.map((w) => w.id)).toContain(wid);
  });
});

// --- AGI-113 ---------------------------------------------------------------
//
// Measured by torta-caprese (AGI-108) in the live gateway log:
//   13:23:54Z agent_soft_reap papassinos (a crew agent_stop)
//   13:24:24Z webhook_janitor_swept + webhook_janitor_cleanup_ok, webhook 119
// — 30 s apart, though WEBHOOK_STALE_MS defaults to 1 h.
//
// The tests below reproduce that against the real Store. 30 s is not a
// coincidence: it is DISCONNECT_MS, the age at which reconcileSessions'
// disconnected-session prune DELETES the session row.

/** Backdate a session's disconnected_at so the prune step sees it as old. */
function ageDisconnect(sessionId: string, ageMs: number): void {
  // @ts-expect-error — test reaches into the Store's db handle to fake age
  store.db.prepare("UPDATE agent_sessions SET disconnected_at = ? WHERE id = ?")
    .run(Date.now() - ageMs, sessionId);
}

/** Backdate the agent's recorded last-session-end so the cutoff is crossed. */
function ageSessionEnd(agentId: string, ageMs: number): void {
  // @ts-expect-error — test reaches into the Store's db handle to fake age
  store.db.prepare("UPDATE agents SET last_session_end_at = ? WHERE id = ?")
    .run(Date.now() - ageMs, agentId);
}

describe("AGI-113 #1 — janitor must consider session END, not only surviving heartbeats", () => {
  const STALE_MS = 3_600_000;   // WEBHOOK_STALE_MS default (1 h)
  const DISCONNECT_MS = 30_000; // DISCONNECT_MS default

  test("TRACE: the prune in reconcileSessions deletes the session row 30 s after a clean stop, and the janitor then sweeps a webhook that is 30 s — not 1 h — old in liveness terms", () => {
    makeAgent("papassinos");
    const wid = makeWebhook("papassinos", "wire-pr-1", "/* delete the github hook */");
    ageWebhook(wid, 2 * 3_600_000); // registered 2 h ago — past the created_at cutoff
    const sid = freshSession("papassinos");

    // t=0: agent alive and heartbeating. Nothing stale.
    expect(store.getStaleWebhooks(STALE_MS).map((w) => w.id)).not.toContain(wid);

    // t=0: agent_stop → POST /agents/disconnect (server.ts:718 → store.ts:807).
    // The row is marked disconnected but SURVIVES with a fresh last_heartbeat,
    // so the janitor's NOT EXISTS test is still false. Still not swept.
    store.disconnectSession(sid);
    expect(store.getSession(sid)).not.toBeNull();
    expect(store.getStaleWebhooks(STALE_MS).map((w) => w.id)).not.toContain(wid);

    // t=+30 s: the next reconciler tick runs the disconnected-session prune.
    ageDisconnect(sid, DISCONNECT_MS + 1_000);
    store.reconcileSessions(20_000, DISCONNECT_MS);

    // ↓ THE DELETION MECHANISM — store.ts:892, inside reconcileSessions:
    //     DELETE FROM agent_sessions
    //      WHERE status = 'disconnected' AND disconnected_at < ?
    expect(store.getSession(sid)).toBeNull();

    // With no session row left, `NOT EXISTS (… last_heartbeat > cutoff)` is
    // trivially TRUE, so the 1 h window collapses to 30 s. That is the defect.
    expect(store.getStaleWebhooks(STALE_MS).map((w) => w.id)).not.toContain(wid);
  });

  test("timeout path too: a session pruned after stale→disconnected does not make the webhook instantly stale", () => {
    makeAgent("timed-out");
    const wid = makeWebhook("timed-out", "wire-pr-2");
    ageWebhook(wid, 2 * 3_600_000);
    // Heartbeat lapsed 40 s ago: the reconciler flips connected→stale→
    // disconnected and prunes it, all well inside the 1 h webhook window.
    const sid = staleSession("timed-out", 40_000);
    store.reconcileSessions(20_000, DISCONNECT_MS);
    ageDisconnect(sid, DISCONNECT_MS + 1_000);
    store.reconcileSessions(20_000, DISCONNECT_MS);
    expect(store.getSession(sid)).toBeNull();

    expect(store.getStaleWebhooks(STALE_MS).map((w) => w.id)).not.toContain(wid);
  });

  test("purgeAgentDependents does not leave a later-registered webhook instantly sweepable", () => {
    // purgeAgentDependents deletes ALL of an agent's agent_sessions rows
    // (store.ts:1134), which is the other way the NOT EXISTS test goes
    // trivially true. A webhook registered after the purge must still get
    // the full stale window.
    makeAgent("purged");
    const sid = freshSession("purged");
    store.disconnectSession(sid);
    store.purgeAgentDependents("purged");
    const wid = makeWebhook("purged", "wire-pr-3");
    ageWebhook(wid, 2 * 3_600_000);

    expect(store.getStaleWebhooks(STALE_MS).map((w) => w.id)).not.toContain(wid);
  });

  test("the window still closes: once the last session ended longer ago than the cutoff, the webhook IS swept", () => {
    makeAgent("long-gone");
    const wid = makeWebhook("long-gone", "wire-pr-4");
    ageWebhook(wid, 4 * 3_600_000);
    const sid = freshSession("long-gone");
    store.disconnectSession(sid);
    ageDisconnect(sid, DISCONNECT_MS + 1_000);
    store.reconcileSessions(20_000, DISCONNECT_MS);
    // …and now two hours pass with the agent still gone.
    ageSessionEnd("long-gone", 2 * 3_600_000);

    expect(store.getStaleWebhooks(STALE_MS).map((w) => w.id)).toContain(wid);
  });
});

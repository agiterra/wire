import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Store } from "./store";

let tmpDir: string;
let dbPath: string;
let store: Store;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wire-store-"));
  dbPath = join(tmpDir, "wire.db");
  store = new Store(dbPath);
});

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function registerAgent(id: string) {
  store.upsertAgent({ id, display_name: id, pubkey: `pk-${id}`, permanent: true });
}

function postMessage(source: string, dest: string | null, topic = "ipc", payload: Record<string, unknown> = {}) {
  const msg = store.writeMessage({
    source,
    dest: dest ?? undefined,
    topic,
    payload: JSON.stringify(payload),
  });
  return msg.seq;
}

describe("click-to-attach self-report columns (ssh_host / run_as_uid / screen_name)", () => {
  test("round-trip via upsertAgent on a fresh insert", () => {
    store.upsertAgent({
      id: "screeny",
      display_name: "screeny",
      pubkey: "pk-screeny",
      permanent: true,
      ssh_host: "mini.local",
      run_as_uid: "agent-7",
      screen_name: "screeny-main",
    });
    const a = store.getAgent("screeny")!;
    expect(a.ssh_host).toBe("mini.local");
    expect(a.run_as_uid).toBe("agent-7");
    expect(a.screen_name).toBe("screeny-main");
  });

  test("omitting fields on insert leaves them NULL", () => {
    registerAgent("bare");
    const a = store.getAgent("bare")!;
    expect(a.ssh_host).toBeNull();
    expect(a.run_as_uid).toBeNull();
    expect(a.screen_name).toBeNull();
  });

  test("re-registering WITHOUT the fields does NOT clobber existing values (sticky)", () => {
    store.upsertAgent({
      id: "sticky",
      display_name: "sticky",
      pubkey: "pk-sticky",
      permanent: true,
      ssh_host: "host-a",
      run_as_uid: "uid-a",
      screen_name: "screen-a",
    });
    // Re-register the same agent omitting the self-report fields entirely.
    store.upsertAgent({ id: "sticky", display_name: "sticky", pubkey: "pk-sticky", permanent: true });
    const a = store.getAgent("sticky")!;
    expect(a.ssh_host).toBe("host-a");
    expect(a.run_as_uid).toBe("uid-a");
    expect(a.screen_name).toBe("screen-a");
  });
});

describe("agent kind stickiness", () => {
  test("omitting kind on insert defaults to 'agent'", () => {
    registerAgent("plain");
    expect(store.getAgent("plain")!.kind).toBe("agent");
  });

  test("re-registering WITHOUT kind does NOT demote an integration (sticky)", () => {
    store.upsertAgent({ id: "svc", display_name: "svc", pubkey: "pk-svc", permanent: true, kind: "integration" });
    // WireConnection's SSE worker re-registers with no kind on every (re)connect.
    store.upsertAgent({ id: "svc", display_name: "svc", pubkey: "pk-svc", permanent: true });
    expect(store.getAgent("svc")!.kind).toBe("integration");
  });

  test("an explicit kind still changes the row", () => {
    store.upsertAgent({ id: "flip", display_name: "flip", pubkey: "pk-flip", permanent: true, kind: "integration" });
    store.upsertAgent({ id: "flip", display_name: "flip", pubkey: "pk-flip", permanent: true, kind: "agent" });
    expect(store.getAgent("flip")!.kind).toBe("agent");
  });
});

describe("SSE replay-on-connect — purged-sessions path", () => {
  test("new agent registered after backlog exists is NOT dumped historical broadcasts", () => {
    // System has prior chatter — broadcasts that pre-date the agent's existence.
    registerAgent("alice");
    postMessage("alice", null, "ipc", { text: "pre-bob broadcast 1" });
    postMessage("alice", null, "ipc", { text: "pre-bob broadcast 2" });

    // Bob joins the wire for the first time.
    registerAgent("bob");
    const session = store.createSession("bob");

    // Bob's first-ever session cursor matches the system's high-water mark —
    // he doesn't see pre-existing broadcasts.
    const backlog = store.getMessagesForAgent("bob", session.last_ack_seq, 100);
    expect(backlog.length).toBe(0);
  });

  test("permanent agent reconnects after session purge and still gets queued backlog", () => {
    // Permanent agent registers and connects.
    registerAgent("fondant");
    const firstSession = store.createSession("fondant");
    expect(firstSession.last_ack_seq).toBe(0);

    // Live traffic flows while fondant is online; he acks up through it.
    const seq1 = postMessage("alex", "fondant", "ipc", { text: "live 1" });
    store.ackSession(firstSession.id, seq1);
    const seq2 = postMessage("alex", "fondant", "ipc", { text: "live 2" });
    store.ackSession(firstSession.id, seq2);

    // Fondant disconnects.
    store.disconnectSession(firstSession.id);

    // While offline, alex sends 5 more messages addressed to fondant.
    const queued: number[] = [];
    for (let i = 0; i < 5; i++) {
      queued.push(postMessage("alex", "fondant", "ipc", { text: `queued ${i}` }));
    }

    // Reaper purges fondant's disconnected session (the bug trigger).
    // Simulate the relevant effect: nuke the row.
    // (reconcileSessions does this when disconnected_at < now - disconnectMs.)
    (store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => unknown } } })
      .db.prepare("DELETE FROM agent_sessions WHERE agent_id = 'fondant'").run();

    // Fondant reconnects fresh.
    const newSession = store.createSession("fondant");

    // New session's cursor must be at fondant's last ack, NOT at global
    // MAX(seq). The 5 queued messages must still be deliverable.
    expect(newSession.last_ack_seq).toBe(seq2);
    const backlog = store.getMessagesForAgent("fondant", newSession.last_ack_seq, 100);
    expect(backlog.map((m) => m.seq)).toEqual(queued);
  });

  test("ackSession write-through survives session purge", () => {
    registerAgent("loom");
    const session = store.createSession("loom");
    const seq = postMessage("alex", "loom");
    store.ackSession(session.id, seq);

    // Purge the session row entirely.
    (store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => unknown } } })
      .db.prepare("DELETE FROM agent_sessions WHERE id = ?").run(session.id);

    // The agent-row cursor still remembers the ack.
    const row = (store as unknown as { db: { prepare: (q: string) => { get: (id: string) => { last_seen_seq: number } } } })
      .db.prepare("SELECT last_seen_seq FROM agents WHERE id = ?").get("loom");
    expect(row.last_seen_seq).toBe(seq);

    // And a fresh session inherits it.
    const newSession = store.createSession("loom");
    expect(newSession.last_ack_seq).toBe(seq);
  });

  test("broadcasts sent while offline are replayed on reconnect", () => {
    registerAgent("heddle");
    const session = store.createSession("heddle");
    store.disconnectSession(session.id);
    (store as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => unknown } } })
      .db.prepare("DELETE FROM agent_sessions WHERE agent_id = 'heddle'").run();

    const bseq1 = postMessage("alex", null, "ipc", { text: "broadcast 1" });
    const bseq2 = postMessage("alex", null, "ipc", { text: "broadcast 2" });

    const newSession = store.createSession("heddle");
    const backlog = store.getMessagesForAgent("heddle", newSession.last_ack_seq, 100);
    expect(backlog.map((m) => m.seq)).toEqual([bseq1, bseq2]);
  });
});

describe("heartbeat restores stale → connected", () => {
  test("heartbeat un-stales a stale session", () => {
    store.upsertAgent({ id: "hb-stale", display_name: "hb-stale", pubkey: "pk-hb-stale", permanent: true });
    const s = store.createSession("hb-stale", "claude-code");
    (store as any).db.prepare("UPDATE agent_sessions SET status = 'stale' WHERE id = ?").run(s.id);
    expect(store.getActiveSessions("hb-stale")).toHaveLength(0);
    store.heartbeatSession(s.id);
    expect(store.getActiveSessions("hb-stale")).toHaveLength(1);
    expect(store.getActiveSessions("hb-stale")[0].status).toBe("connected");
  });

  test("heartbeat does not resurrect a disconnected session", () => {
    store.upsertAgent({ id: "hb-disc", display_name: "hb-disc", pubkey: "pk-hb-disc", permanent: true });
    const s = store.createSession("hb-disc", "claude-code");
    store.disconnectSession(s.id);
    store.heartbeatSession(s.id);
    expect(store.getActiveSessions("hb-disc")).toHaveLength(0);
  });
});

describe("AGI-113 #4 — no cleanup-bypassing bulk webhook delete on the Store", () => {
  test("deleteWebhooksForAgent is gone (it dropped rows without running their cleanup)", () => {
    const tmp = mkdtempSync(join(tmpdir(), "wire-agi113-"));
    const s = new Store(join(tmp, "wire.db"));
    expect((s as unknown as Record<string, unknown>).deleteWebhooksForAgent).toBeUndefined();
    try { rmSync(tmp, { recursive: true, force: true }); } catch {}
  });
});

describe("auxiliary sessions (RPC helpers sharing an identity) — j:1935", () => {
  // The 2026-09-29 incident: baguette restarted; a lane IPC arrived while no session was up; the
  // bridge-rpc helper connected first, replayed + acked it, and moved agents.last_seen_seq past
  // it, so the channel session connected 1.5 s later started beyond the queued message.
  function incident(helperAuxiliary: boolean) {
    registerAgent("baguette");
    const old = store.createSession("baguette");
    const live = postMessage("brioche", "baguette", "ipc", { text: "before restart" });
    store.ackSession(old.id, live);
    store.disconnectSession(old.id);

    const queued = postMessage("rv-4492-sg59", "baguette", "ipc", { text: "sent during restart" });

    const helper = store.createSession("baguette", "claude-code", "bridge-rpc-baguette", { auxiliary: helperAuxiliary });
    // Whatever the helper is handed, it acks (the RPC client acks every frame it receives).
    for (const m of store.getMessagesForAgent("baguette", helper.last_ack_seq, 100)) store.ackSession(helper.id, m.seq);
    const reply = postMessage("crew-svc@patisserie", "baguette", "rpc.reply", {});
    store.ackSession(helper.id, reply);

    const channel = store.createSession("baguette", "claude-code", "7a333c61");
    return { queued, reply, helper, channel };
  }

  test("an auxiliary helper connecting first leaves the queued IPC for the channel session", () => {
    const { queued, channel } = incident(true);
    const backlog = store.getMessagesForAgent("baguette", channel.last_ack_seq, 100).map((m) => m.seq);
    expect(backlog).toContain(queued);
  });

  test("control: a NON-auxiliary helper reproduces the loss (proves the test can fail)", () => {
    const { queued, channel } = incident(false);
    const backlog = store.getMessagesForAgent("baguette", channel.last_ack_seq, 100).map((m) => m.seq);
    expect(backlog).not.toContain(queued);
  });

  test("an auxiliary session starts at the head: it is never handed the agent's backlog", () => {
    registerAgent("brioche");
    postMessage("x", "brioche", "ipc", { text: "queued for the conversation" });
    const helper = store.createSession("brioche", "claude-code", "crew-tools-rpc-1", { auxiliary: true });
    expect(helper.auxiliary).toBe(1);
    expect(store.getMessagesForAgent("brioche", helper.last_ack_seq, 100)).toEqual([]);
  });

  test("an auxiliary session's own cursor still advances (flap replay of its RPC replies works)", () => {
    registerAgent("vacherin");
    const helper = store.createSession("vacherin", "claude-code", "crew-tools-rpc-2", { auxiliary: true });
    const r1 = postMessage("crew-svc", "vacherin", "rpc.reply", {});
    store.ackSession(helper.id, r1);
    const r2 = postMessage("crew-svc", "vacherin", "rpc.reply", {});
    expect(store.getSession(helper.id)!.last_ack_seq).toBe(r1);
    expect(store.getMessagesForAgent("vacherin", store.getSession(helper.id)!.last_ack_seq, 100).map((m) => m.seq)).toEqual([r2]);
  });

  test("a normal session still writes through to agents.last_seen_seq", () => {
    registerAgent("herald");
    const s = store.createSession("herald");
    const seq = postMessage("x", "herald", "ipc", {});
    store.ackSession(s.id, seq);
    const next = store.createSession("herald");
    expect(next.last_ack_seq).toBe(seq);
    expect(next.auxiliary).toBe(0);
  });
});

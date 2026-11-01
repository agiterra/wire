import { describe, expect, test } from "bun:test";
import { HeartbeatScheduler, LATE_GRACE_MS, MAX_CATCHUP_MS } from "./heartbeat";

// The broker runs in America/New_York (crons are local time). 2026-11-01 is that zone's autumn DST change,
// the day node-cron 4.2.1's getNextMatch() silenced every heartbeat 02:15Z-04:00Z.
process.env.TZ = "America/New_York";

function harness() {
  const routed: any[] = [];
  const logs: any[] = [];
  const hbs = new Map<string, any>();
  const store = { updateHeartbeatFired: () => {}, getHeartbeat: (id: string) => hbs.get(id) ?? null,
    deleteHeartbeat: (id: string) => hbs.delete(id) } as any;
  const router = { route: (m: any) => routed.push(m) } as any;
  const rec = (level: string) => (obj: any, msg?: string) => logs.push({ level, ...obj, msg });
  const log = { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") } as any;
  const s = new HeartbeatScheduler(store, router, log);
  const add = (id: string, cron: string) => { const hb = { id, agent_id: "a", cron, prompt: "p", created_by: "c", active: 1 }; hbs.set(id, hb); s.schedule(hb as any); return hb; };
  const fired = (id: string) => routed.filter((m) => JSON.parse(m.payload).heartbeat_id === id).length;
  return { s, routed, logs, hbs, add, fired };
}
const Z = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16);
const lateLogs = (h: any) => h.logs.filter((l: any) => l.event === "heartbeat_late");

/** Tick once per second from a to b (inclusive), recording when each heartbeat fired. */
function run(h: any, a: number, b: number) {
  const at: Record<string, string[]> = {};
  let n = 0;
  for (let t = a; t <= b; t += 1000) {
    h.s.tick(t + 5);
    while (n < h.routed.length) { const id = JSON.parse(h.routed[n++].payload).heartbeat_id; (at[id] ??= []).push(iso(t)); }
  }
  return at;
}

describe("HeartbeatScheduler ticker", () => {
  test("DST day 2026-11-01: every slot node-cron 4.2.1 lost fires, on time", () => {
    const h = harness();
    h.add("q", "*/15 * * * *"); h.add("h7", "7 * * * *"); h.add("h20", "20 * * * *"); h.add("d12", "0 */12 * * *");
    const at = run(h, Z("2026-11-01T01:59:00Z"), Z("2026-11-01T07:30:00Z"));
    h.s.stop();
    // 02:00Z..07:30Z every 15 min = 23 slots; the gap that went silent (02:15-03:45Z) and 04:30Z are in it.
    expect(at.q.length).toBe(23);
    expect(at.q).toContain("2026-11-01T02:15"); expect(at.q).toContain("2026-11-01T03:45"); expect(at.q).toContain("2026-11-01T04:30");
    // An hourly :07 fires every real hour, including both 01:07 local (05:07Z EDT, 06:07Z EST).
    expect(at.h7).toEqual(["2026-11-01T02:07", "2026-11-01T03:07", "2026-11-01T04:07", "2026-11-01T05:07", "2026-11-01T06:07", "2026-11-01T07:07"]);
    expect(at.h20).toEqual(["2026-11-01T02:20", "2026-11-01T03:20", "2026-11-01T04:20", "2026-11-01T05:20", "2026-11-01T06:20", "2026-11-01T07:20"]);
    expect(at.d12).toEqual(["2026-11-01T04:00"]); // 00:00 EDT; 12:00 EST is 17:00Z, out of range
    expect(lateLogs(h).length).toBe(0);
  });

  test("a stall over several slots fires once, late, logged with its first missed slot", () => {
    const h = harness();
    h.add("m", "* * * * *");
    const t0 = Z("2026-10-12T18:46:30Z");
    h.s.tick(t0);
    h.s.tick(t0 + 10 * 60_000);          // 10 min stall: 10 minute slots passed
    h.s.tick(t0 + 10 * 60_000 + 1000);   // next tick: nothing new
    h.s.stop();
    expect(h.fired("m")).toBe(1);
    const late = lateLogs(h);
    expect(late.length).toBe(1);
    expect(late[0].slot).toBe("2026-10-12T18:47:00.000Z");
    expect(late[0].late_ms).toBe(Z("2026-10-12T18:56:30Z") - Z("2026-10-12T18:47:00Z"));
  });

  test("an on-time tick fires once and logs no late fire", () => {
    const h = harness();
    h.add("m", "* * * * *");
    h.s.tick(Z("2026-10-12T18:46:59Z"));
    h.s.tick(Z("2026-10-12T18:47:00Z") + 5);
    h.s.tick(Z("2026-10-12T18:47:01Z") + 5);
    h.s.stop();
    expect(h.fired("m")).toBe(1);
    expect(lateLogs(h).length).toBe(0);
  });

  test("a slot just under LATE_GRACE_MS old fires without a late log; at the grace it logs", () => {
    const a = harness(); a.add("m", "* * * * *");
    a.s.tick(Z("2026-10-12T18:46:59Z")); a.s.tick(Z("2026-10-12T18:47:00Z") + LATE_GRACE_MS - 1); a.s.stop();
    expect(a.fired("m")).toBe(1); expect(lateLogs(a).length).toBe(0);
    const b = harness(); b.add("m", "* * * * *");
    b.s.tick(Z("2026-10-12T18:46:59Z")); b.s.tick(Z("2026-10-12T18:47:00Z") + LATE_GRACE_MS); b.s.stop();
    expect(b.fired("m")).toBe(1); expect(lateLogs(b).length).toBe(1);
  });

  test("an inactive, deleted or removed heartbeat does not fire", () => {
    const h = harness();
    h.add("off", "* * * * *").active = 0;
    h.add("gone", "* * * * *"); h.hbs.delete("gone");
    h.add("rm", "* * * * *"); h.s.remove("rm");
    h.add("on", "* * * * *");
    run(h, Z("2026-10-12T18:46:59Z"), Z("2026-10-12T18:47:01Z"));
    h.s.stop();
    expect(h.routed.map((m: any) => JSON.parse(m.payload).heartbeat_id)).toEqual(["on"]);
  });

  test("an invalid cron is refused and never fires", () => {
    const h = harness();
    h.add("bad", "99 * * * *");
    run(h, Z("2026-10-12T18:46:59Z"), Z("2026-10-12T18:47:01Z"));
    h.s.stop();
    expect(h.routed.length).toBe(0);
    expect(h.logs.some((l: any) => l.event === "heartbeat_invalid_cron")).toBe(true);
  });

  test("re-scheduling an id with an invalid cron drops its old schedule", () => {
    const h = harness();
    const hb = h.add("x", "* * * * *");
    h.s.schedule({ ...hb, cron: "99 * * * *" } as any);
    run(h, Z("2026-10-12T18:46:59Z"), Z("2026-10-12T18:47:01Z"));
    h.s.stop();
    expect(h.routed.length).toBe(0);
  });

  test("a stall longer than MAX_CATCHUP_MS is walked from its last MAX_CATCHUP_MS only, with a warning", () => {
    const h = harness();
    h.add("old", "10 0 * * *");   // 00:10 local only: 04:10Z, outside the last hour
    h.add("new", "40 1 * * *");   // 01:40 local: 05:40Z (EDT), inside it
    const t0 = Z("2026-11-01T03:00:00Z");
    h.s.tick(t0);
    h.s.tick(t0 + 3 * MAX_CATCHUP_MS);   // 06:00Z
    h.s.stop();
    expect(h.fired("old")).toBe(0);
    expect(h.fired("new")).toBe(1);
    expect(h.logs.some((l: any) => l.event === "heartbeat_catchup_capped")).toBe(true);
  });

  test("the real timer fires a seconds cron", async () => {
    const h = harness();
    h.add("s", "* * * * * *");
    await new Promise((r) => setTimeout(r, 2500));
    h.s.stop();
    const n = h.fired("s");
    expect(n).toBeGreaterThanOrEqual(2);
    expect(n).toBeLessThanOrEqual(3);
  }, 10_000);
});

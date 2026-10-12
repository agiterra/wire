import { describe, expect, test } from "bun:test";
import { HeartbeatScheduler, LATE_GRACE_MS } from "./heartbeat";

// node-cron drops a tick whose timer lands >= 1 s late (2026-10-12: 3 ticks lost in a row), and a task's
// FIRST tick with no missed event at all. The scheduler's sweep must fire such a slot late, once.
function harness() {
  const routed: any[] = [];
  const logs: any[] = [];
  const hbs = new Map<string, any>();
  const store = { updateHeartbeatFired: () => {}, getHeartbeat: (id: string) => hbs.get(id) ?? null } as any;
  const router = { route: (m: any) => routed.push(m) } as any;
  const rec = (level: string) => (obj: any, msg?: string) => logs.push({ level, ...obj, msg });
  const log = { info: rec("info"), warn: rec("warn"), error: rec("error"), debug: rec("debug") } as any;
  const s = new HeartbeatScheduler(store, router, log);
  const add = (id: string, cron: string) => { const hb = { id, agent_id: "a", cron, prompt: "p", created_by: "c", active: 1 }; hbs.set(id, hb); s.schedule(hb as any); return hb; };
  return { s, routed, logs, hbs, add };
}
/** Block the event loop until `until` (ms epoch): no timer, node-cron's or the sweep's, can run meanwhile. */
function spinUntil(until: number) { while (Date.now() < until) { /* busy */ } }
const settle = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
/** A 6-field cron matching one second per minute, at whole-second `at`. */
const at = (ms: number) => `${new Date(ms).getSeconds()} * * * * *`;
const nextSlot = (ahead: number) => Math.floor(Date.now() / 1000) * 1000 + ahead;
const lateLogs = (h: any) => h.logs.filter((l: any) => l.event === "heartbeat_late");

describe("HeartbeatScheduler late ticks", () => {
  test("a FIRST tick whose timer lands >1 s late is fired by the sweep, once, with its delay logged", async () => {
    const h = harness();
    const slot = nextSlot(2000);
    h.add("hb-first", at(slot));
    spinUntil(slot + 1600);          // node-cron's timer runs >= 1.6 s late and drops the tick
    await settle(300);
    expect(h.routed.length).toBe(0); // node-cron alone: dropped (this is the defect)
    h.s.sweep(slot + LATE_GRACE_MS + 1);
    h.s.sweep(slot + LATE_GRACE_MS + 2); // a 2nd sweep must not fire it again
    h.s.stop();
    expect(h.routed.length).toBe(1);
    const late = lateLogs(h);
    expect(late.length).toBe(1);
    expect(late[0].slot).toBe(new Date(slot).toISOString());
    expect(late[0].late_ms).toBe(LATE_GRACE_MS + 1);
  }, 10_000);

  test("a LATER tick (node-cron reports it missed) is fired once by the sweep", async () => {
    const h = harness();
    const s1 = nextSlot(2000), s2 = s1 + 2000;
    h.add("hb-later", `${new Date(s1).getSeconds()},${new Date(s2).getSeconds()} * * * * *`);
    await settle(s1 + 500 - Date.now()); // s1 fires on time
    expect(h.routed.length).toBe(1);
    spinUntil(s2 + 1600);                 // s2 is dropped
    await settle(300);
    expect(h.routed.length).toBe(1);
    h.s.sweep(s2 + LATE_GRACE_MS + 1);
    h.s.stop();
    expect(h.routed.length).toBe(2);
    expect(lateLogs(h).length).toBe(1);
  }, 15_000);

  test("an on-time tick fires once; the sweep adds nothing", async () => {
    const h = harness();
    const slot = nextSlot(2000);
    h.add("hb-ok", at(slot));
    await settle(slot + 700 - Date.now());
    h.s.sweep(slot + LATE_GRACE_MS + 1);
    h.s.stop();
    expect(h.routed.length).toBe(1);
    expect(lateLogs(h).length).toBe(0);
  }, 10_000);

  test("a slot not yet LATE_GRACE_MS old is left to node-cron", async () => {
    const h = harness();
    const slot = nextSlot(2000);
    h.add("hb-grace", at(slot));
    h.s.sweep(slot + LATE_GRACE_MS - 1);
    h.s.stop();
    expect(h.routed.length).toBe(0);
  });

  test("one stall over several slots fires one late tick, not a burst", async () => {
    const h = harness();
    const base = nextSlot(2000);
    h.add("hb-burst", `${[0, 1, 2].map((i) => new Date(base + i * 1000).getSeconds()).join(",")} * * * * *`);
    spinUntil(base + 3600);
    await settle(300);
    h.s.sweep(Date.now() + LATE_GRACE_MS);
    h.s.sweep(Date.now() + LATE_GRACE_MS + 1);
    h.s.stop();
    expect(h.routed.length).toBe(1);
    expect(lateLogs(h).length).toBe(1);
  }, 10_000);

  test("an inactive or deleted heartbeat is not fired late", async () => {
    const h = harness();
    const slot = nextSlot(2000);
    const hb = h.add("hb-off", at(slot));
    hb.active = 0;
    spinUntil(slot + 1600);
    await settle(300);
    h.s.sweep(slot + LATE_GRACE_MS + 1);
    h.s.stop();
    expect(h.routed.length).toBe(0);
  }, 10_000);
});

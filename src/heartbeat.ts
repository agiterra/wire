/**
 * Heartbeat scheduler — self-prompting mechanism for agents.
 *
 * Each heartbeat fires a Wire message to the target agent, which arrives as a channel
 * injection and wakes the agent up. node-cron parses and matches the cron expression; the
 * timing is ours (see TICK_MS).
 *
 * Heartbeats persist in the DB and are reloaded on server restart.
 */

import cron from "node-cron";
import { createRequire } from "node:module";
import path from "node:path";
import type { Store, Heartbeat } from "./store.js";
import type { Router } from "./router.js";
import type { Logger } from "pino";

// node-cron's package exports hide its matcher; resolve it next to the main entry (pinned ^4.2.1, dist/cjs layout).
const req = createRequire(import.meta.url);
const { TimeMatcher } = req(path.join(path.dirname(req.resolve("node-cron")), "time", "time-matcher.js")) as {
  TimeMatcher: new (expr: string, tz?: string) => { match(d: Date): boolean };
};

/**
 * Why a ticker, not cron.schedule (2026-11-01): node-cron 4.2.1 arms each task's timer from
 * TimeMatcher.getNextMatch(), which is wrong for the whole local day of a DST change. On
 * 2026-11-01 (America/New_York) it gave 04:15Z after 02:00Z for star-slash-15 and the NEXT day
 * after 02:07Z for "7 * * * *": every heartbeat on the broker went silent 02:15Z-04:00Z, 04:30Z
 * was skipped too, and the old late-fire sweep took its slots from the same function, so it saw
 * nothing. 4.6.0 is still wrong around the change (174 of 4320 probes). match() is right on every
 * minute of that day. So one timer wakes on each whole second and asks match() of every heartbeat.
 *
 * Late ticks (the 2026-10-12 defect: a timer landing >= 1 s late lost its tick): the ticker walks
 * every whole second since the last one it checked, so a stalled event loop catches up. A heartbeat
 * due one or more times in a stall fires ONCE, late, logged with its first missed slot and delay.
 * A stall longer than MAX_CATCHUP_MS is walked from its last MAX_CATCHUP_MS only.
 *
 * DST: in the repeated autumn hour a matching local time occurs twice, so it fires twice (an
 * hourly heartbeat fires each real hour). A spring-forward local time that does not exist never fires.
 */
export const TICK_MS = 1_000;
export const LATE_GRACE_MS = 5_000;
export const MAX_CATCHUP_MS = 3_600_000;

export class HeartbeatScheduler {
  private store: Store;
  private router: Router;
  private log: Logger;
  private matchers: Map<string, { match(d: Date): boolean }> = new Map();
  /** The last whole second (ms epoch) the ticker has checked. */
  private checked: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(store: Store, router: Router, log: Logger) {
    this.store = store;
    this.router = router;
    this.log = log;
  }

  /** Load all active heartbeats from DB and schedule them. */
  start(): void {
    const heartbeats = this.store.listActiveHeartbeats();
    for (const hb of heartbeats) {
      this.schedule(hb);
    }
    this.log.info(
      { event: "heartbeat_start", count: heartbeats.length },
      `loaded ${heartbeats.length} heartbeats`,
    );
  }

  /** Schedule a single heartbeat. */
  schedule(hb: Heartbeat): void {
    this.matchers.delete(hb.id);
    if (!cron.validate(hb.cron)) {
      this.log.error(
        { event: "heartbeat_invalid_cron", id: hb.id, cron: hb.cron },
        `invalid cron expression: ${hb.cron}`,
      );
      return;
    }
    this.matchers.set(hb.id, new TimeMatcher(hb.cron));
    this.arm();
    this.log.debug(
      { event: "heartbeat_scheduled", id: hb.id, agent: hb.agent_id, cron: hb.cron },
      `scheduled: ${hb.id}`,
    );
  }

  private arm(): void {
    if (this.timer || this.matchers.size === 0) return;
    // Wake just after the next whole second, so Date.now() has passed it.
    this.timer = setTimeout(() => { this.timer = null; this.tick(); this.arm(); }, TICK_MS - (Date.now() % TICK_MS) + 5);
  }

  /** Check every whole second after the last checked one, up to `now`; fire each due heartbeat once. */
  tick(now = Date.now()): void {
    const last = Math.floor(now / 1000) * 1000;
    let from = (this.checked ?? last - 1000) + 1000;
    if (last - from >= MAX_CATCHUP_MS) {
      this.log.warn(
        { event: "heartbeat_catchup_capped", from: new Date(from).toISOString(), to: new Date(last).toISOString() },
        `stall longer than ${MAX_CATCHUP_MS} ms: checking its last ${MAX_CATCHUP_MS} ms only`,
      );
      from = last - MAX_CATCHUP_MS + 1000;
    }
    if (from > last) return;
    this.checked = last;
    const due = new Map<string, number>(); // id -> first matching slot
    for (let t = from; t <= last; t += 1000) {
      const d = new Date(t);
      for (const [id, m] of this.matchers) if (!due.has(id) && m.match(d)) due.set(id, t);
    }
    for (const [id, slot] of due) {
      const hb = this.store.getHeartbeat(id);
      if (!hb || !hb.active) continue;
      if (now - slot >= LATE_GRACE_MS) {
        this.log.warn(
          { event: "heartbeat_late", id, agent: hb.agent_id, cron: hb.cron, slot: new Date(slot).toISOString(), late_ms: now - slot },
          `late fire: ${id} (event loop stalled past its slot)`,
        );
      }
      this.fire(hb);
    }
  }

  /** Fire a heartbeat — route a message to the target agent via SSE. */
  private fire(hb: Heartbeat): void {
    const payload = JSON.stringify({
      type: "heartbeat",
      heartbeat_id: hb.id,
      prompt: hb.prompt,
      created_by: hb.created_by,
    });

    try {
      this.router.route({
        source: hb.created_by,
        dest: hb.agent_id,
        topic: "heartbeat",
        payload,
      });
      this.store.updateHeartbeatFired(hb.id);
      this.log.info(
        { event: "heartbeat_fired", id: hb.id, agent: hb.agent_id },
        `fired: ${hb.id} → ${hb.agent_id}`,
      );
    } catch (e) {
      this.log.error(
        { event: "heartbeat_fire_error", id: hb.id, err: e },
        `fire failed: ${hb.id}`,
      );
    }
  }

  /** Add a new heartbeat, persist and schedule it. */
  add(opts: {
    agent_id: string;
    cron: string;
    prompt: string;
    created_by: string;
  }): Heartbeat {
    const id = `hb-${crypto.randomUUID().slice(0, 8)}`;
    const hb = this.store.createHeartbeat({ id, ...opts });
    this.schedule(hb);
    return hb;
  }

  /** Remove a heartbeat, stop its schedule, delete from DB. */
  remove(id: string): void {
    this.matchers.delete(id);
    this.store.deleteHeartbeat(id);
    this.log.info({ event: "heartbeat_removed", id }, `removed: ${id}`);
  }

  /** Remove all heartbeats for an agent. */
  removeForAgent(agentId: string): void {
    const heartbeats = this.store.listHeartbeats(agentId);
    for (const hb of heartbeats) this.matchers.delete(hb.id);
    this.store.deleteHeartbeatsForAgent(agentId);
    this.log.info(
      { event: "heartbeats_removed_for_agent", agent: agentId, count: heartbeats.length },
      `removed ${heartbeats.length} heartbeats for ${agentId}`,
    );
  }

  /** Stop all scheduled tasks. */
  stop(): void {
    this.matchers.clear();
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.checked = null;
  }
}

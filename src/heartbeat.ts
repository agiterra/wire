/**
 * Heartbeat scheduler — self-prompting mechanism for agents.
 *
 * Uses node-cron to schedule recurring messages. Each heartbeat fires
 * a Wire message to the target agent, which arrives as a channel
 * injection and wakes the agent up.
 *
 * Heartbeats persist in the DB and are reloaded on server restart.
 */

import cron from "node-cron";
import type { Store, Heartbeat } from "./store.js";
import type { Router } from "./router.js";
import type { Logger } from "pino";

/**
 * node-cron drops a tick whose timer lands >= 1 s late: it truncates "now" to the second, the match fails, and
 * it never runs the tick late. It reports execution:missed only from its 2nd wake-up on, so a task's FIRST tick
 * (a one-shot's only one) is dropped with no event at all. Under host load this ate a 20-min tick 3x in a row
 * (2026-10-12 18:47/19:07/19:27Z). So the scheduler keeps its own record of each heartbeat's next slot and a
 * sweep fires any slot that passed by LATE_GRACE_MS without the cron callback: late, once, logged with its delay.
 */
export const LATE_GRACE_MS = 5_000;
export const SWEEP_MS = 5_000;

export class HeartbeatScheduler {
  private store: Store;
  private router: Router;
  private log: Logger;
  private tasks: Map<string, cron.ScheduledTask> = new Map();
  /** Per heartbeat: the slot (ms epoch) its cron callback has not yet run for. */
  private expected: Map<string, number | null> = new Map();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

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
    if (this.tasks.has(hb.id)) {
      this.tasks.get(hb.id)!.stop();
      this.tasks.delete(hb.id); // a stopped task left here would still be swept
      this.expected.delete(hb.id);
    }

    if (!cron.validate(hb.cron)) {
      this.log.error(
        { event: "heartbeat_invalid_cron", id: hb.id, cron: hb.cron },
        `invalid cron expression: ${hb.cron}`,
      );
      return;
    }

    const task = cron.schedule(hb.cron, () => {
      this.fire(hb);
      this.expected.set(hb.id, task.getNextRun()?.getTime() ?? null);
    });
    this.expected.set(hb.id, task.getNextRun()?.getTime() ?? null);
    this.startSweep();

    this.tasks.set(hb.id, task);
    this.log.debug(
      { event: "heartbeat_scheduled", id: hb.id, agent: hb.agent_id, cron: hb.cron },
      `scheduled: ${hb.id}`,
    );
  }

  private startSweep(): void {
    if (!this.sweepTimer) this.sweepTimer = setInterval(() => this.sweep(), SWEEP_MS);
  }

  /** Fire every heartbeat whose slot passed LATE_GRACE_MS ago without its cron callback (see LATE_GRACE_MS). */
  sweep(now = Date.now()): void {
    for (const [id, task] of this.tasks) {
      const slot = this.expected.get(id);
      if (slot == null || now < slot + LATE_GRACE_MS) continue;
      const hb = this.store.getHeartbeat(id);
      // One late fire per stall, however many slots it covered; the next slot is counted from now.
      this.expected.set(id, task.getNextRun()?.getTime() ?? null);
      if (!hb || !hb.active) continue;
      this.log.warn(
        { event: "heartbeat_late", id, agent: hb.agent_id, cron: hb.cron, slot: new Date(slot).toISOString(), late_ms: now - slot },
        `late fire: ${id} (node-cron dropped its tick)`,
      );
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
    const task = this.tasks.get(id);
    if (task) {
      task.stop();
      this.tasks.delete(id);
    }
    this.expected.delete(id);
    this.store.deleteHeartbeat(id);
    this.log.info({ event: "heartbeat_removed", id }, `removed: ${id}`);
  }

  /** Remove all heartbeats for an agent. */
  removeForAgent(agentId: string): void {
    const heartbeats = this.store.listHeartbeats(agentId);
    for (const hb of heartbeats) {
      const task = this.tasks.get(hb.id);
      if (task) {
        task.stop();
        this.tasks.delete(hb.id);
      }
      this.expected.delete(hb.id);
    }
    this.store.deleteHeartbeatsForAgent(agentId);
    this.log.info(
      { event: "heartbeats_removed_for_agent", agent: agentId, count: heartbeats.length },
      `removed ${heartbeats.length} heartbeats for ${agentId}`,
    );
  }

  /** Stop all scheduled tasks. */
  stop(): void {
    for (const [id, task] of this.tasks) {
      task.stop();
    }
    this.tasks.clear();
    this.expected.clear();
    if (this.sweepTimer) { clearInterval(this.sweepTimer); this.sweepTimer = null; }
  }
}

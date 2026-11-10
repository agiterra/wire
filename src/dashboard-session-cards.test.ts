import { describe, expect, test } from "bun:test";
import { SESSION_CARD_HELPERS, scDur, scTok, sessionCard, sessionSection, usageBurnRow } from "./dashboard-session-cards.js";
import { renderDashboard } from "./dashboard.js";

const NOW = Date.parse("2026-11-10T16:00:00Z");

const card = (over: any = {}) => ({
  id: "eng-4129-5774-ghcr3-a-very-long-lane-name-that-must-not-be-cropped", name: "eng-4129-5774-ghcr3-a-very-long-lane-name-that-must-not-be-cropped",
  kind: "lane", runtime: "codex", state: "working", launched_at: "2026-11-10T15:00:00Z", last_event_at: "2026-11-10T15:59:50Z",
  last_event_age_s: 10, last_tool: "exec", tool_calls: 49, tool_calls_10m: 3, tokens_total: 2435924, tokens_in: 2430000, tokens_out: 5924,
  model: "gpt-6.1-sol", cwd: "/opt/fabrica/fabrica-v3",
  context: { tokens: 171000, window: 475000, window_source: "session log", warn: 190000, warn_source: "40% of window", level: "warn" },
  ...over,
});

describe("formatters", () => {
  test("tokens", () => {
    expect(scTok(null)).toBe("—");
    expect(scTok(undefined)).toBe("—");
    expect(scTok(0)).toBe("0");
    expect(scTok(1234)).toBe("1.2K");
    expect(scTok(3730344)).toBe("3.73M");
  });
  test("durations", () => {
    expect(scDur(null)).toBe("—");
    expect(scDur(45)).toBe("45s");
    expect(scDur(720)).toBe("12m");
    expect(scDur(3 * 3600 + 300)).toBe("3h 05m");
    expect(scDur(4 * 86400 + 7200)).toBe("4d 2h");
  });
});

describe("sessionCard", () => {
  test("full name, runtime chip, Working pill, numbers, folder", () => {
    const h = sessionCard(card(), NOW);
    expect(h).toContain("eng-4129-5774-ghcr3-a-very-long-lane-name-that-must-not-be-cropped</span>");
    expect(h).toContain(">CODEX<");
    expect(h).toContain(">Working<");
    expect(h).toContain("1h 00m"); // no session start -> falls back to launched_at
    expect(h).toContain(">49<");
    expect(h).toContain("2.44M");
    expect(h).toContain("171.0K of 475.0K · line 190.0K · near line");
    expect(h).toContain("/opt/fabrica/fabrica-v3");
    expect(h).toContain('class="sc-fill warn" style="width:36.0%"');
    expect(h).toContain('class="sc-mark" style="left:40.0%"');
  });
  test("Running is the session, not the screen's launch", () => {
    const h = sessionCard(card({ launched_at: "2026-09-14T00:00:00Z", session_started_at: "2026-11-10T15:30:00Z" }), NOW);
    expect(h).toContain(">30m<");
    expect(h).not.toContain(">57d");
  });
  test("unknown values show a dash and a hatched bar, never 0", () => {
    const h = sessionCard(card({ runtime: "grok", tokens_total: null, tokens_in: null, tool_calls: null, model: null, cwd: null,
      context: { tokens: 132000, window: null, warn: null, level: null } }), NOW);
    expect(h).toContain("132.0K of ?");
    expect(h).toContain('class="sc-bar unknown"');
    expect(h).toContain("no per-call usage in this runtime");
    expect(h).not.toContain(">0<");
  });
  test("over the line and error states", () => {
    expect(sessionCard(card({ context: { tokens: 200000, window: 475000, warn: 190000, level: "over" } }), NOW)).toContain("OVER LINE");
    const err = sessionCard(card({ state: "error", error: "no session log found" }), NOW);
    expect(err).toContain(">No reading<");
    expect(err).toContain('title="no session log found"');
  });
  test("escapes agent-supplied text", () => {
    const h = sessionCard(card({ name: "<img src=x>", cwd: '"/x"' }), NOW);
    expect(h).not.toContain("<img");
    expect(h).toContain("&lt;img src=x&gt;");
  });
});

describe("usageBurnRow", () => {
  test("rate and time left, or a dash before there are samples", () => {
    const h = usageBurnRow({ meter: "codex", used_pct: 77, pace_line_pct: 90.8, rate_pct_h: 1.5, est_left_h: 14.8, reset_h: 14.8, status: "BEHIND" });
    expect(h).toContain("77%");
    expect(h).toContain("1.5 %/h");
    expect(h).toContain("left 14.8h");
    expect(usageBurnRow({ meter: "grok", used_pct: 12, rate_pct_h: null, est_left_h: null, reset_h: 70.7 })).toContain("rate —");
    expect(usageBurnRow({ meter: "grok", used_pct: 12, reset_h: 70.7 })).toContain("resets 3d");
  });
});

describe("sessionSection", () => {
  test("not ok -> says why, never an empty list", () => {
    expect(sessionSection({ ok: false, error: "ENOENT x" }, NOW)).toContain("session cards unavailable: ENOENT x");
  });
  test("personas first, counts, finished list, stale marker", () => {
    const h = sessionSection({ ok: true, data: {
      as_of: "2026-11-10T15:50:00Z", counts: { running: 2, claude: 1, codex: 1 },
      agents: [card(), card({ id: "brioche", name: "brioche", kind: "persona", runtime: "claude" })],
      usage: { meters: [{ meter: "codex", used_pct: 77 }] },
      finished_24h: [{ id: "rv-1", name: "rv-1", runtime: "grok", stopped_at: "2026-11-10T15:00:00Z" }],
      not_yet: "pods: phase 2" } }, NOW);
    expect(h.indexOf("brioche")).toBeLessThan(h.indexOf("eng-4129"));
    expect(h).toContain("2 running</b> · claude 1 · codex 1");
    expect(h).toContain("Finished in last 24h (1 stopped)");
    expect(h).toContain("stale 10m");
    expect(h).toContain("Not yet: pods: phase 2");
  });
});

describe("client injection", () => {
  test("the injected helper source runs standalone in a browser-like scope", () => {
    const fn = new Function(SESSION_CARD_HELPERS + "\nreturn sessionSection;")();
    const h = fn({ ok: true, data: { agents: [card()], counts: { running: 1 } } }, NOW);
    expect(h).toContain(">Working<");
  });
  test("dashboard has the section, the poller and the CSS", () => {
    const html = renderDashboard([], "Tim");
    expect(html).toContain('<div id="session-cards">');
    expect(html).toContain("fetch('/sessions')");
    expect(html).toContain(".sc-card {");
    expect(html).toContain("function sessionSection(");
  });
});

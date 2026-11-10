import { describe, expect, test } from "bun:test";
import { AGENT_CELL_HELPERS } from "./dashboard-agent-cells.js";
import { SESSION_CARD_HELPERS, agentCard, agentCards, cardAttachHref, scDur, scTok, sessionFoot, sessionHead, usageBurnRow } from "./dashboard-session-cards.js";
import { renderDashboard } from "./dashboard.js";
import { isPodLane } from "./peek-screen.js";

const NOW = Date.parse("2026-11-10T16:00:00Z");

const card = (over: any = {}) => ({
  id: "eng-4129-5774-ghcr3-a-very-long-lane-name-that-must-not-be-cropped", name: "eng-4129-5774-ghcr3-a-very-long-lane-name-that-must-not-be-cropped",
  kind: "lane", runtime: "codex", state: "working", launched_at: "2026-11-10T15:00:00Z", last_event_at: "2026-11-10T15:59:50Z",
  last_event_age_s: 10, last_tool: "exec", tool_calls: 49, tool_calls_10m: 3, tokens_total: 2435924, tokens_in: 2430000, tokens_out: 5924,
  model: "gpt-6.1-sol", cwd: "/opt/fabrica/fabrica-v3",
  context: { tokens: 171000, window: 475000, window_source: "session log", warn: 190000, warn_source: "40% of window", level: "warn" },
  ...over,
});

const CTX = {
  here: { name: "patisserie", aliases: ["patisserie", "tims-mac-mini"] }, personaIds: ["fondant", "brioche", "herald"],
  presets: [["claude-code", "claude-fable-5-1", "Claude Fable 5.1"]], podView: { host: "patisserie.ts.net", uid: "fondant" }, pstatus: {},
};
/** A Wire registry row, as GET / and the SSE stream send it. */
const wire = (over: any = {}) => ({
  id: "eng-4129-5774-ghcr3-a-very-long-lane-name-that-must-not-be-cropped", display_name: "eng-4129-5774-ghcr3-a-very-long-lane-name-that-must-not-be-cropped",
  kind: "agent", permanent: 0, online: true, sessions: 1, last_seen_at: "2026-11-10T15:56:00Z", reaped_at: null,
  pubkey: "abcdef0123456789", plan: "", ssh_host: "patisserie.tail3ef8a5.ts.net", run_as_uid: "_ephemeral", screen_name: "wire-eng-4129",
  ...over,
});
/** The card for collector record `rec` joined to a Wire row with the same id. */
const sessionCard = (rec: any, now: number) => agentCard(wire({ id: rec.id, display_name: rec.name }), rec, now, CTX, {});

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

describe("agentCard: the Wire row's identity fields and buttons", () => {
  test("machine, type, key, sessions, seen, plan and every row button", () => {
    const h = agentCard(wire({ plan: "doing **ENG-5774**" }), null, NOW, CTX, {});
    expect(h).toContain(">patisserie<"); // machine short name, full host on hover
    expect(h).toContain('title="patisserie.tail3ef8a5.ts.net"');
    expect(h).toContain("badge-ephemeral");
    expect(h).toContain(">abcdef01<");
    expect(h).toContain('title="abcdef0123456789"');
    expect(h).toContain(">4m ago<");
    expect(h).toContain('data-peek="eng-4129-5774-ghcr3-a-very-long-lane-name-that-must-not-be-cropped"');
    expect(h).toContain('data-msg="eng-4129');
    expect(h).toContain('href="wire-attach://attach?');
    expect(h).toContain('data-plan-for="eng-4129');
    expect(h).toContain("doing **ENG-5774**"); // server render: escaped text, the client turns it into markdown
    expect(h).toContain("lane #4129");
    expect(h).not.toContain("data-pstatus"); // not a persona
    expect(h).not.toContain("onclick");
  });
  test("full name, never cropped; tap opens the detail with the full id and key", () => {
    const w = wire();
    expect(agentCard(w, null, NOW, CTX, {})).toContain(">eng-4129-5774-ghcr3-a-very-long-lane-name-that-must-not-be-cropped</span>");
    const open = agentCard(w, null, NOW, CTX, { ["detail:" + w.id]: true, ["key:" + w.id]: true });
    expect(open).toContain('data-copy="abcdef0123456789"');
    expect(open).toContain(">abcdef0123456789</span>");
  });
  test("persona: credential status, restart and run-as, status taken from ctx.pstatus", () => {
    const h = agentCard(wire({ id: "herald", display_name: "herald", permanent: 1 }), null, NOW,
      { ...CTX, pstatus: { herald: '<span class="pst-ok">claude-code x · cred ok</span>' } }, {});
    expect(h).toContain("badge-personai");
    expect(h).toContain('data-restart="herald"');
    expect(h).toContain('data-runas="herald"');
    expect(h).toContain('<option value="claude-code claude-fable-5-1">Claude Fable 5.1</option>');
    expect(h).toContain("cred ok</span>");
  });
  test("no session record: still a card, session fields are dashes, pill says so", () => {
    const h = agentCard(wire({ id: "vacherin", display_name: "vacherin", permanent: 1 }), null, NOW, CTX, {});
    expect(h).toContain(">No session<");
    expect(h).toContain('<div class="sc-k">Model</div><div class="sc-v">—</div>');
    expect(h).toContain('<div class="sc-k">Running</div><div class="sc-v">—</div>');
    expect(h).not.toContain(">0<");
  });
  test("integration and reaped badges; offline dot", () => {
    const h = agentCard(wire({ id: "gaia", display_name: "Gaia", kind: "integration", permanent: 1, online: false, reaped_at: 1 }), null, NOW, CTX, {});
    expect(h).toContain(">integration<");
    expect(h).toContain(">reaped<");
    expect(h).toContain("sc-reaped");
    expect(h).toContain("sc-offline");
    expect(h).toContain("○");
  });
  test("attach href matches peek-screen's pod rule", () => {
    const pod = { id: "eng-1", ssh_host: "bk-node-7", run_as_uid: null };
    expect(isPodLane(pod)).toBe(true);
    expect(cardAttachHref(pod, CTX.podView)).toBe("wire-attach://attach?agent=eng-1&host=patisserie.ts.net&user=fondant&screen=pod%3Abk-node-7");
    expect(cardAttachHref({ id: "fondant", ssh_host: "patisserie", run_as_uid: "fondant", screen_name: "fondant" }, CTX.podView))
      .toBe("wire-attach://attach?agent=fondant&host=patisserie&user=fondant&screen=fondant");
    expect(cardAttachHref({ id: "x" }, CTX.podView)).toBe("wire-attach://attach?agent=x&host=local&user=&screen=x");
  });
});

describe("agentCards: the Wire set drives, sessions join by id", () => {
  const sess = (agents: any[]) => ({ ok: true, data: { agents } });
  test("every Wire row gets a card; session-only records are named, not dropped", () => {
    const rows = [wire({ id: "vacherin", display_name: "vacherin", permanent: 1 }), wire({ id: "fondant", display_name: "Fondant", permanent: 1 }),
      wire({ id: "wallet-vault", display_name: "wallet-vault", kind: "integration", permanent: 1 }), wire({ id: "eng-9-1-x", display_name: "eng-9-1-x" })];
    const h = agentCards(rows, sess([card({ id: "fondant", name: "Fondant", runtime: "claude" }), card({ id: "ghost-lane", name: "ghost-lane" })]), NOW, CTX, {});
    expect((h.match(/class="sc-card /g) || []).length).toBe(4);
    expect(h).toContain(">CLAUDE<"); // fondant joined to its session
    expect(h).toContain("Session records with no Wire registration: ghost-lane");
    // personas (by id), then lanes, then integrations
    expect(h.indexOf('data-sc-id="fondant"')).toBeLessThan(h.indexOf('data-sc-id="vacherin"'));
    expect(h.indexOf('data-sc-id="vacherin"')).toBeLessThan(h.indexOf('data-sc-id="eng-9-1-x"'));
    expect(h.indexOf('data-sc-id="eng-9-1-x"')).toBeLessThan(h.indexOf('data-sc-id="wallet-vault"'));
  });
  test("sessions unavailable -> cards still render from the Wire rows", () => {
    const h = agentCards([wire({ id: "herald", display_name: "herald", permanent: 1 })], { ok: false, error: "ENOENT" }, NOW, CTX, {});
    expect(h).toContain('data-sc-id="herald"');
    expect(h).toContain(">No session<");
  });
});

describe("sessionHead / sessionFoot", () => {
  test("not ok -> says why, never an empty list", () => {
    expect(sessionHead({ ok: false, error: "ENOENT x" }, NOW)).toContain("session data unavailable: ENOENT x");
    expect(sessionFoot({ ok: false })).toBe("");
  });
  test("counts, burn strip, finished list, stale marker", () => {
    const d = { ok: true, data: {
      as_of: "2026-11-10T15:50:00Z", counts: { running: 2, claude: 1, codex: 1 },
      agents: [card(), card({ id: "brioche", name: "brioche", kind: "persona", runtime: "claude" })],
      usage: { meters: [{ meter: "codex", used_pct: 77 }] },
      finished_24h: [{ id: "rv-1", name: "rv-1", runtime: "grok", stopped_at: "2026-11-10T15:00:00Z" }],
      not_yet: "pods: phase 2" } };
    const h = sessionHead(d, NOW);
    expect(h).toContain("2 running</b> · claude 1 · codex 1");
    expect(h).toContain("stale 10m");
    expect(h).toContain('class="sb-row');
    const f = sessionFoot(d);
    expect(f).toContain("Finished in last 24h (1 stopped)");
    expect(f).toContain("Not yet: pods: phase 2");
  });
});

describe("client injection", () => {
  test("the injected helper source runs standalone in a browser-like scope and matches the server", () => {
    const fn = new Function(AGENT_CELL_HELPERS + "\n" + SESSION_CARD_HELPERS + "\nreturn agentCards;")();
    const rows = [wire({ id: "herald", display_name: "herald", permanent: 1 }), wire()];
    const d = { ok: true, data: { agents: [card()] } };
    const h = fn(rows, d, NOW, CTX, {});
    expect(h).toContain(">Working<");
    expect(h).toBe(agentCards(rows, d, NOW, CTX, {}));
  });
  test("dashboard: cards are the only agent list, no registry table", () => {
    const html = renderDashboard([wire({ id: "vacherin", display_name: "vacherin", permanent: 1 })], "Tim");
    expect(html).toContain('<div id="agent-cards" class="sc-cards">');
    expect(html).toContain('data-sc-id="vacherin"');
    expect(html).not.toContain("Agent Registry");
    expect(html).not.toContain("<tbody>");
    expect(html).not.toContain('class="agent-row"');
    expect(html).toContain("fetch('/sessions')");
    expect(html).toContain(".sc-card {");
    expect(html).toContain("function agentCards(");
  });
  test("top strip: no Claude / Codex / Grok / as-of cells, Host and Pool stay", () => {
    const html = renderDashboard([], "Tim");
    expect(html).not.toContain("usageCell('Claude");
    expect(html).not.toContain("usageCell('Grok'");
    expect(html).not.toContain("usageCell('Codex'");
    expect(html).not.toContain('usage-label">as of<');
    expect(html).toContain("usageCell('Host'");
    expect(html).toContain("usageCell('Pool'");
  });
});

import { describe, expect, test } from "bun:test";
import { AGENT_CELL_HELPERS, agentNameCell, agentTags, machineCell, machineName, relTime, tapFull } from "./dashboard-agent-cells.js";
import { PERSONA_IDS, renderDashboard } from "./dashboard.js";

const NOW = Date.parse("2026-10-22T16:00:00Z");

describe("relTime", () => {
  test("short forms", () => {
    expect(relTime(null, NOW)).toBe("never");
    expect(relTime("2026-10-22T15:59:50Z", NOW)).toBe("just now");
    expect(relTime("2026-10-22T15:56:00Z", NOW)).toBe("4m ago");
    expect(relTime("2026-10-22T13:00:00Z", NOW)).toBe("3h ago");
    expect(relTime("2026-10-20T16:00:00Z", NOW)).toBe("2d ago");
  });
});

describe("agentTags", () => {
  const labels = (a: any) => agentTags(a).map((t) => t.label);
  test("lane serial and ticket from the lane id, with prefixes", () => {
    expect(labels({ id: "eng-1863-5167-row8v3" })).toEqual(["lane #1863", "ENG-5167"]);
    expect(labels({ id: "lane-eng-1867-5092-fv-spot" })).toEqual(["lane #1867", "ENG-5092"]);
    expect(labels({ id: "wallet-vault-eng-1864-3127-mv3" })).toEqual(["lane #1864", "ENG-3127"]);
  });
  test("a lane id with no ticket gives the lane only", () => {
    expect(labels({ id: "eng-1860-fv-x" })).toEqual(["lane #1860"]);
  });
  test("non-lane ids give nothing", () => {
    expect(labels({ id: "fondant", permanent: 1 })).toEqual([]);
    expect(labels({ id: "host-rpc@patisserie" })).toEqual([]);
    expect(labels({ id: "engine-12" })).toEqual([]);
  });
  test("ephemeral plan: PR URL, bare PR, extra tickets, deduped", () => {
    const tags = agentTags({
      id: "eng-1862-5167-soil",
      plan: "fixing ENG-5167 and ENG-5180; PR https://github.com/fabrica-land/fabrica-v3/pull/9123 then PR #9123 and PR #77",
    });
    expect(tags.map((t) => t.label)).toEqual(["lane #1862", "ENG-5167", "fabrica-v3 #9123", "PR #77", "ENG-5180"]);
    expect(tags.find((t) => t.label === "fabrica-v3 #9123")!.href).toBe("https://github.com/fabrica-land/fabrica-v3/pull/9123");
    expect(tags.find((t) => t.label === "ENG-5180")!.href).toBe("https://linear.app/fabrica/issue/ENG-5180");
  });
  test("persona plans do not produce chips", () => {
    expect(labels({ id: "brioche", permanent: 1, plan: "ENG-5178 AC" })).toEqual([]);
  });
});

describe("cells", () => {
  test("name is never cropped and is escaped; detail opens by key", () => {
    const a = { id: "eng-1-<x>", display_name: "a<b>", pubkey: "abc" };
    expect(agentNameCell(a, {})).toContain("a&lt;b&gt;");
    expect(agentNameCell(a, {})).not.toContain("agent-detail");
    expect(agentNameCell(a, { ["detail:" + a.id]: true })).toContain('data-copy="abc"');
  });
  test("tapFull: short shown, full in title; full shown when open", () => {
    expect(tapFull("k", "4m ago", "10/22/2026, 11:56", {})).toBe('<span class="tapfull" data-toggle="k" title="10/22/2026, 11:56">4m ago</span>');
    expect(tapFull("k", "4m ago", "FULL", { k: true })).toContain(">FULL</span>");
  });
});

describe("machine", () => {
  const here = { name: "patisserie", aliases: ["patisserie", "tims-mac-mini"] };
  test("short name from the self-reported host; any alias of this box shows as its name", () => {
    expect(machineName({ ssh_host: "patisserie.tail3ef8a5.ts.net" }, here)).toBe("patisserie");
    expect(machineName({ ssh_host: "tims-mac-mini.local" }, here)).toBe("patisserie");
    expect(machineName({ ssh_host: "localhost" }, here)).toBe("patisserie");
    expect(machineName({ ssh_host: "bk-node-3.ec2.internal" }, here)).toBe("bk-node-3");
    expect(machineName({ ssh_host: null }, here)).toBe("");
  });
  test("cell: full host on hover; no host says so, with no ellipsis", () => {
    const c = machineCell({ id: "x", ssh_host: "bk-node-3.ec2.internal" }, here, {});
    expect(c).toContain(">bk-node-3<");
    expect(c).toContain('title="bk-node-3.ec2.internal"');
    expect(machineCell({ id: "x" }, here, {})).toContain("none reported");
  });
});

describe("page", () => {
  const row = (id: string, permanent: number) => ({ id, display_name: id, permanent, online: true, sessions: 1, last_seen_at: "2026-10-22T15:56:00Z", pubkey: "abcdef0123456789", plan: "", ssh_host: "patisserie.tail3ef8a5.ts.net" });
  test("persona controls only on persona ids, never on other permanent agents", () => {
    expect(PERSONA_IDS.has("baguette")).toBe(true);
    const html = renderDashboard([row("baguette", 1), row("gaia", 1), row("wallet-vault", 1)], "Tim");
    expect(html).toContain('data-pstatus="baguette"');
    expect(html).not.toContain('data-pstatus="gaia"');
    expect(html).not.toContain('data-pstatus="wallet-vault"');
  });
  test("no ellipsis anywhere in the rendered page", () => {
    const html = renderDashboard([row("fondant", 1), row("eng-1862-5167-soil", 0)], "Tim");
    expect(html).not.toContain("…");
    expect(html).not.toContain("text-overflow: ellipsis");
    expect(html).toContain("<th>Machine</th>");
  });
});

describe("client injection", () => {
  test("the injected helper source runs in a plain JS context and matches the server", () => {
    const run = new Function(AGENT_CELL_HELPERS + "\nreturn { agentTags, relTime, agentNameCell, machineCell };")();
    const a = { id: "eng-1862-5167-soil", display_name: "eng-1862-5167-soil", plan: "PR #5" };
    expect(run.agentTags(a)).toEqual(agentTags(a));
    expect(run.relTime("2026-10-22T15:56:00Z", NOW)).toBe("4m ago");
    expect(run.agentNameCell(a, {})).toBe(agentNameCell(a, {}));
    const h = { name: "p", aliases: ["p"] };
    expect(run.machineCell({ id: "x", ssh_host: "q.lan" }, h, {})).toBe(machineCell({ id: "x", ssh_host: "q.lan" }, h, {}));
  });
  test("the rendered page's inline scripts parse", () => {
    const html = renderDashboard([{ id: "eng-1862-5167-soil", display_name: "eng-1862-5167-soil", permanent: 0, online: true, sessions: 1, last_seen_at: "2026-10-22T15:56:00Z", pubkey: "abcdef0123456789", plan: "x" }], "Tim");
    expect(html).toContain("lane #1862");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.some((src) => src.includes("function agentNameCell(") && src.includes("function relTime("))).toBe(true);
    for (const src of scripts) expect(() => new Function(src)).not.toThrow();
  });
});

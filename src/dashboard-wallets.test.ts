import { describe, expect, test } from "bun:test";
import { WALLET_HELPERS, walletDirectory, walletEdit, walletList, walletMatches, walletRow } from "./dashboard-wallets.js";
import { renderDashboard } from "./dashboard.js";

// Shape of a live wallet-vault row (wire-mini.db plugin_settings, 2026-11-10).
const W1 = { name: "harness-seller", creator: "fondant", created_at: 1785159141068, chain_id: 11155111, access: { mode: "specific", agents: ["fondant", "stroopwafel"] } };
const W2 = { name: "madeleine-borrower", creator: "madeleine", created_at: 1783960949066, chain_id: 11155111, access: { mode: "specific", agents: ["madeleine"] } };
const A1 = "0x072a91dac1eaed7fca4f1d9995fd86dccc9f989d";
const A2 = "0x0c4b6b368a0b293ade8479c9b2f124f6230f7483";

describe("walletDirectory", () => {
  test("per-key rows, newest first; non-wallet keys ignored", () => {
    const d = walletDirectory({ ["wallet:" + A2]: W2, ["wallet:" + A1]: W1, "tab_claim:9": { x: 1 } });
    expect(d.map((e) => e.addr)).toEqual([A1, A2]);
    expect(d[0].key).toBe("wallet:" + A1);
  });
  test("legacy blob is read, a per-key row wins for the same address (mergeWalletDirectory)", () => {
    const d = walletDirectory({ wallets: { [A1.toUpperCase().replace("0X", "0x")]: { ...W1, name: "old" }, [A2]: W2 }, ["wallet:" + A1]: W1 });
    expect(d.find((e) => e.addr === A1)!.w.name).toBe("harness-seller");
    expect(d.find((e) => e.addr === A2)!.key).toBe("wallet:" + A2); // first edit writes the per-key row
  });
  test("junk is not a wallet", () => {
    expect(walletDirectory(null)).toEqual([]);
    expect(walletDirectory({ "wallet:0x1": null, "wallet:0x2": "s", "wallet:0x3": [] })).toEqual([]);
  });
});

describe("walletRow / walletList", () => {
  test("renders what the panel always showed: name, address, chain, creator, mode, members, grant", () => {
    const h = walletRow({ addr: A1, key: "wallet:" + A1, w: W1 });
    expect(h).toContain(">harness-seller<");
    expect(h).toContain('data-copy="' + A1 + '"');
    expect(h).toContain("chain 11155111");
    expect(h).toContain("creator: fondant");
    expect(h).toContain('<option value="specific" selected>');
    expect(h).toContain('data-wrevoke="wallet:' + A1 + '" data-agent="stroopwafel"');
    expect(h).toContain('data-wgrant="wallet:' + A1 + '"');
    expect(h).not.toContain("onclick");
    expect(h).not.toContain("onchange");
  });
  test("all / creator-only modes show no member chips", () => {
    expect(walletRow({ addr: A1, key: "k", w: { ...W1, access: { mode: "all", agents: [] } } })).toContain("all registered agents");
    expect(walletRow({ addr: A1, key: "k", w: { ...W1, access: { mode: "creator-only", agents: [] } } })).toContain("creator only (fondant)");
  });
  test("escapes", () => {
    const h = walletRow({ addr: A1, key: "k", w: { ...W1, name: "<b>x</b>", access: { mode: "specific", agents: ['a"b'] } } });
    expect(h).not.toContain("<b>x");
    expect(h).toContain('data-agent="a&quot;b"');
  });
  test("filter by name, address, creator, member", () => {
    const d = walletDirectory({ ["wallet:" + A1]: W1, ["wallet:" + A2]: W2 });
    expect(d.filter((e) => walletMatches(e, "stroop")).length).toBe(1);
    expect(d.filter((e) => walletMatches(e, "0x0c4b")).length).toBe(1);
    expect(d.filter((e) => walletMatches(e, "")).length).toBe(2);
    expect(walletList(d, "nomatch")).toContain('no wallet matches "nomatch"');
    expect(walletList([], "")).toContain("no wallets in namespace wallet-vault");
  });
});

describe("walletEdit", () => {
  test("grant / revoke / mode, on a copy, keeping every other field", () => {
    const g = walletEdit(W1, { grant: "herald" });
    expect(g.access.agents).toEqual(["fondant", "stroopwafel", "herald"]);
    expect(W1.access.agents).toEqual(["fondant", "stroopwafel"]);
    expect(g.created_at).toBe(W1.created_at);
    expect(walletEdit(W1, { grant: "fondant" }).access.agents).toEqual(["fondant", "stroopwafel"]);
    expect(walletEdit(W1, { revoke: "fondant" }).access.agents).toEqual(["stroopwafel"]);
    expect(walletEdit(W1, { mode: "all" }).access.mode).toBe("all");
    expect(walletEdit({ ...W1, access: { mode: "creator-only", agents: [] } }, { grant: "x" }).access).toEqual({ mode: "specific", agents: ["x"] });
  });
});

describe("page", () => {
  test("injected wallet helpers match the server copy; panel reads the namespace, writes one wallet row", () => {
    const run = new Function(WALLET_HELPERS + "\nreturn { walletDirectory, walletList };")();
    const raw = { ["wallet:" + A1]: W1, ["wallet:" + A2]: W2 };
    expect(run.walletList(run.walletDirectory(raw), "")).toBe(walletList(walletDirectory(raw), ""));
    const html = renderDashboard([], "Tim");
    expect(html).toContain("fetch('/plugin_settings/' + encodeURIComponent(WALLET_NS))");
    expect(html).toContain("const WALLET_NS = \"wallet-vault\"");
    expect(html).not.toContain("/plugin_settings/wallet-vault/wallets");
    expect(html).toContain("addEventListener('plugin_settings'");
  });
});

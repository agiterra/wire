/**
 * Wallets panel (Tim, 2026-11-10 ~17:00Z: "The wallets section is empty. Either remove it, or populate it as it should be.").
 *
 * Why it was empty: the panel read the legacy single-blob key `plugin_settings/wallet-vault/wallets`, which no longer
 * exists. The vault now keeps one row per wallet, key `wallet:<address>`, value {name, creator, created_at, chain_id,
 * access: {mode, agents}}, in namespace `wallet-vault` (the real vault; `wallet-vault-<lane>` namespaces are lane test
 * vaults and are not shown). The extension's directory (wallet-extension wallet-directory.ts, mergeWalletDirectory)
 * reads the legacy blob first and lets a per-key row win for the same address; walletDirectory() does the same, so the
 * panel shows exactly what the vault enforces. Edits are written back per wallet (PUT .../wallet:<address>), which the
 * vault receives as a scoped plugin_settings.updated event.
 *
 * Same injection contract as dashboard-agent-cells.ts: self-contained functions, injected into the client <script>
 * with Function.prototype.toString. Payloads ride in data-* attributes, never in an onclick string (j:1250).
 */

export const WALLET_NAMESPACE = "wallet-vault";

export function wEsc(s: any): string {
  return s == null ? "" : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/**
 * Raw namespace listing (key -> value, as GET /plugin_settings/wallet-vault returns) -> wallets, newest first.
 * `key` is the per-wallet row the panel writes; a wallet seen only in the legacy blob gets its per-key row on first edit.
 */
export function walletDirectory(raw: any): { addr: string; key: string; w: any }[] {
  const out: Record<string, { addr: string; key: string; w: any }> = {};
  const plain = (v: any) => v != null && typeof v === "object" && !Array.isArray(v);
  if (!plain(raw)) return [];
  if (plain(raw.wallets)) {
    for (const a of Object.keys(raw.wallets)) {
      if (plain(raw.wallets[a])) out[a.toLowerCase()] = { addr: a.toLowerCase(), key: "wallet:" + a.toLowerCase(), w: raw.wallets[a] };
    }
  }
  for (const k of Object.keys(raw)) {
    if (k.indexOf("wallet:") !== 0 || !plain(raw[k])) continue;
    const a = k.slice(7).toLowerCase();
    out[a] = { addr: a, key: k, w: raw[k] };
  }
  return Object.keys(out).map((a) => out[a]).sort((x, y) =>
    (Number(y.w.created_at) || 0) - (Number(x.w.created_at) || 0) || x.addr.localeCompare(y.addr));
}

/** True when the wallet matches the filter text (name, address, creator, chain, mode or a member agent). */
export function walletMatches(e: { addr: string; w: any }, q: string): boolean {
  const t = String(q || "").trim().toLowerCase();
  if (!t) return true;
  const acc = e.w.access || {};
  return [e.addr, e.w.name, e.w.operator_name, e.w.creator, e.w.chain_id, acc.mode].concat(acc.agents || [])
    .some((v: any) => v != null && String(v).toLowerCase().indexOf(t) >= 0);
}

/** One wallet row: name, full address (tap copies), chain, creator, access mode select, members with revoke, grant. */
export function walletRow(e: { addr: string; key: string; w: any }): string {
  const x = wEsc;
  const w = e.w || {};
  const acc = w.access || {};
  const mode = String(acc.mode || "");
  const agents: string[] = Array.isArray(acc.agents) ? acc.agents : [];
  const modes = ["creator-only", "specific", "all"];
  if (mode && modes.indexOf(mode) < 0) modes.push(mode);
  const members = mode === "all"
    ? '<span class="wallet-access-disabled">all registered agents</span>'
    : mode === "creator-only"
      ? '<span class="wallet-access-disabled">creator only (' + x(w.creator) + ")</span>"
      : agents.map((ag) => '<span class="wallet-member-chip">' + x(ag) +
          '<span class="wallet-member-revoke" data-wrevoke="' + x(e.key) + '" data-agent="' + x(ag) + '" title="Revoke ' + x(ag) + '">×</span></span>').join("") +
        '<span class="wallet-grant"><input type="text" placeholder="agent-id" data-wgrant-input="' + x(e.key) + '"><button data-wgrant="' + x(e.key) + '">+grant</button></span>';
  const created = Number(w.created_at) ? new Date(Number(w.created_at)).toISOString().replace("T", " ").slice(0, 16) + "Z" : "";
  return '<div class="wallet-row" data-wallet="' + x(e.key) + '">' +
    '<div class="wallet-head">' +
    '<span class="wallet-name">' + x(w.operator_name || w.name || "(unnamed)") + "</span>" +
    '<span class="wallet-addr copyable" data-copy="' + x(e.addr) + '" title="Click to copy">' + x(e.addr) + "</span>" +
    '<span class="wallet-chain">chain ' + x(w.chain_id ?? "?") + "</span>" +
    '<span class="wallet-creator">creator: ' + x(w.creator || "?") + (created ? " · " + created : "") + "</span>" +
    '<label class="wallet-creator">mode: <select class="wallet-mode-select" data-wmode="' + x(e.key) + '">' +
    modes.map((m) => '<option value="' + x(m) + '"' + (m === mode ? " selected" : "") + ">" + x(m) + "</option>").join("") +
    "</select></label></div>" +
    '<div class="wallet-members">' + members + "</div></div>";
}

/** The list body for a filter; says so when nothing matches instead of showing an empty box. */
export function walletList(dir: { addr: string; key: string; w: any }[], q: string): string {
  const shown = dir.filter((e) => walletMatches(e, q));
  if (!dir.length) return '<div class="wallets-empty">(no wallets in namespace wallet-vault)</div>';
  if (!shown.length) return '<div class="wallets-empty">no wallet matches "' + wEsc(q) + '"</div>';
  return shown.map(walletRow).join("");
}

/** The wallet value after an access edit: a deep copy, never the cached object. */
export function walletEdit(w: any, op: { mode?: string; grant?: string; revoke?: string }): any {
  const next = JSON.parse(JSON.stringify(w || {}));
  const acc = next.access && typeof next.access === "object" ? next.access : (next.access = {});
  if (!Array.isArray(acc.agents)) acc.agents = [];
  if (!acc.mode) acc.mode = "specific";
  if (op.mode) acc.mode = op.mode;
  if (op.grant) {
    if (acc.mode === "creator-only") acc.mode = "specific";
    if (acc.agents.indexOf(op.grant) < 0) acc.agents.push(op.grant);
  }
  if (op.revoke) acc.agents = acc.agents.filter((a: string) => a !== op.revoke);
  return next;
}

export const WALLET_HELPERS = [wEsc, walletDirectory, walletMatches, walletRow, walletList, walletEdit].map((f) => f.toString()).join("\n");

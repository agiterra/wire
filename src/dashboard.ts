/**
 * Dashboard HTML — monospace dark-mode agent registry.
 * Passkey auth on a monospace dark-mode agent registry — peak infrastructure.
 */

// Persona rows get Restart / Run-as / credential status (2026-09-02). Same markup on the server
// render and the SSE re-render; the JS binds by data-* attributes.
const PERSONA_PRESETS = [["claude-code", "claude-fable-5-1", "Claude Fable 5.1"], ["grok", "grok-4.6", "Grok 4.6"], ["codex", "gpt-5.6-sol", "Codex Sol"]];
import { AGENT_CELL_HELPERS } from "./dashboard-agent-cells.js";
import { SESSION_CARD_CSS, SESSION_CARD_HELPERS, agentCards } from "./dashboard-session-cards.js";
import { WALLET_HELPERS, WALLET_NAMESPACE } from "./dashboard-wallets.js";
import { hostname } from "os";
import { execFileSync } from "child_process";
import { POD_VIEW_UID } from "./peek-screen.js";

/** ssh host a cockpit uses to reach THIS Wire's machine for a pod-lane attach. */
const POD_VIEW_HOST = process.env.WIRE_POD_VIEW_HOST || "patisserie.tail3ef8a5.ts.net";

// The persona ids: only these get Restart / Run-as / credential status. Every other permanent agent (gaia,
// wallet-vault, crew-svc@patisserie) is not a persona, and a check on it is refused by the server, which showed as a red
// "check refused" on every page load (Tim, 2026-10-27: no "check" errors). server.ts imports this one copy.
export const PERSONA_IDS = new Set((process.env.WIRE_PERSONA_IDS ?? "fondant,brioche,baguette,herald,vacherin").split(",").map((s) => s.trim()).filter(Boolean));

// This broker's machine, for the Machine column: its short hostname, and every other name this box answers to
// (macOS LocalHostName, e.g. "tims-mac-mini" for patisserie) so that a stale self-report maps to the same name.
function localMachine(): { name: string; aliases: string[] } {
  const name = hostname().split(".")[0].toLowerCase();
  const aliases = [name];
  if (process.platform === "darwin") {
    try {
      aliases.push(execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], { encoding: "utf8" }).trim().toLowerCase());
    } catch (e) {
      console.error("dashboard: scutil --get LocalHostName failed; Machine column maps only the hostname", e);
    }
  }
  return { name, aliases };
}
const MACHINE_HERE = localMachine();

export function renderDashboard(agents: any[], operatorName: string): string {
  // First paint: one card per Wire registry row, session fields "—" until the client's first GET /sessions (ms later).
  const cardCtx = { here: MACHINE_HERE, personaIds: [...PERSONA_IDS], presets: PERSONA_PRESETS, podView: { host: POD_VIEW_HOST, uid: POD_VIEW_UID }, pstatus: {} };
  const cardsHtml = agentCards(agents, null, Date.now(), cardCtx, {});

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${process.env.WIRE_INSTANCE_NAME ?? "The Wire"}</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%230a0a0a'/><path d='M18 4L10 18h5l-2 10 10-14h-5z' fill='%23fbbf24'/></svg>">
  <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #e5e5e5;
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
      font-size: 13px;
      line-height: 1.6;
      padding: 24px;
    }
    header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      border-bottom: 1px solid #262626;
      padding-bottom: 12px;
      margin-bottom: 24px;
    }
    h1 { font-size: 16px; font-weight: 600; color: #fafafa; }
    h1 span { color: #6b7280; font-weight: 400; }
    .operator { color: #6b7280; font-size: 12px; }
    .operator a { color: #6b7280; text-decoration: none; }
    .operator a:hover { color: #e5e5e5; }
    h2 {
      font-size: 13px;
      font-weight: 600;
      color: #a1a1aa;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 8px;
    }
    th {
      text-align: left;
      color: #6b7280;
      font-weight: 500;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 6px 12px 6px 0;
      border-bottom: 1px solid #1f1f1f;
    }
    td {
      padding: 8px 12px 8px 0;
      border-bottom: 1px solid #141414;
      vertical-align: top;
    }
    .agent-name { white-space: normal; overflow-wrap: anywhere; }
    .agent-label { color: #60a5fa; font-weight: 500; cursor: pointer; }
    .chips { margin-left: 6px; }
    .chip { display: inline-block; font-size: 0.75em; padding: 0 5px; margin: 0 4px 2px 0; border-radius: 3px; background: #1f2937; color: #cbd5e1; text-decoration: none; white-space: nowrap; }
    a.chip:hover { background: #374151; color: #fff; }
    .agent-detail { margin: 4px 0 2px; padding: 4px 8px; border-left: 2px solid #1e3a5f; color: #a1a1aa; font-size: 0.9em; }
    .tapfull { cursor: pointer; }
    .tapfull.open { white-space: normal; overflow-wrap: anywhere; color: #e5e5e5; }
    .badge { font-size: 0.7em; padding: 1px 5px; border-radius: 3px; font-weight: 400; vertical-align: middle; }
    .badge-personai { background: #1e3a5f; color: #60a5fa; }
    .badge-ephemeral { background: #3f3f00; color: #facc15; }
    table { border-collapse: collapse; }
    th { color: #525252; font-weight: 400; font-size: 11px; text-align: left; }
    .agent-plan {
      white-space: normal;
      overflow-wrap: anywhere;
      color: #a1a1aa;
      line-height: 1.5;
    }
    .agent-plan:empty { display: none; }
    .agent-plan h1, .agent-plan h2, .agent-plan h3 { color: #e5e5e5; margin: 8px 0 4px; font-size: 0.9em; }
    .agent-plan h1 { font-size: 1em; }
    .agent-plan p { margin: 2px 0; }
    .agent-plan a { color: #60a5fa; text-decoration: none; }
    .agent-plan a:hover { text-decoration: underline; }
    .agent-plan code { background: #1a1a2e; color: #c4b5fd; padding: 1px 4px; border-radius: 3px; font-size: 0.9em; }
    .agent-plan strong { color: #e5e5e5; }
    .agent-plan em { color: #d4d4d8; }
    .agent-plan del { color: #6b7280; }
    .agent-plan ul, .agent-plan ol { margin: 2px 0 2px 20px; }
    .agent-plan li { margin: 1px 0; }
    .agent-actions button { padding: 2px 8px; font-size: 11px; background: #1a1a2e; color: #a1a1aa; border: 1px solid #333; border-radius: 3px; cursor: pointer; font-family: inherit; }
    .agent-actions button:hover { background: #2a2a3e; color: #e5e5e5; border-color: #555; }
    .agent-actions .row-btn { display: inline-block; padding: 2px 8px; font-size: 11px; background: #1a1a2e; color: #a1a1aa; border: 1px solid #333; border-radius: 3px; cursor: pointer; font-family: inherit; text-decoration: none; line-height: inherit; }
    .agent-actions .row-btn:hover { background: #2a2a3e; color: #e5e5e5; border-color: #555; }
    .peek-output { background: #0a0a0a; border: 1px solid #333; border-radius: 4px; padding: 12px; margin-top: 4px; white-space: pre-wrap; font-size: 11px; color: #a1a1aa; max-height: 70vh; overflow-y: auto; }
    .peek-output .peek-header { color: #fbbf24; margin-bottom: 8px; font-weight: bold; }
    .agent-plan table { border-collapse: collapse; margin: 4px 0; width: auto; }
    .agent-plan th, .agent-plan td { border: 1px solid #2a2a2a; padding: 3px 8px; text-align: left; white-space: normal; overflow: visible; }
    .agent-plan th { color: #e5e5e5; background: #1a1a1a; font-size: 0.9em; }
    .agent-plan td { color: #a1a1aa; }
    .dim { color: #525252; }
    .copyable { cursor: pointer; position: relative; }
    .copyable:hover { text-decoration: underline; }
    .copied { color: #4ade80 !important; }
    .copy-toast {
      position: absolute; top: -22px; left: 50%; transform: translateX(-50%);
      background: #4ade80; color: #000; font-size: 10px; font-weight: 600;
      padding: 2px 6px; border-radius: 3px; pointer-events: none;
      animation: copy-fade 0.8s ease-out forwards;
    }
    @keyframes copy-fade {
      0% { opacity: 1; transform: translateX(-50%) translateY(0); }
      100% { opacity: 0; transform: translateX(-50%) translateY(-8px); }
    }
    .form-section {
      margin-top: 32px;
      padding-top: 16px;
      border-top: 1px solid #1f1f1f;
    }
    .form-row {
      display: flex;
      gap: 8px;
      margin-bottom: 8px;
      align-items: center;
    }
    .form-row input, .form-row select {
      background: #1a1a1a;
      border: 1px solid #333;
      color: #e5e5e5;
      padding: 6px 10px;
      font-family: inherit;
      font-size: 12px;
      border-radius: 4px;
    }
    .form-row input:focus { outline: none; border-color: #60a5fa; }
    .form-row button {
      background: #262626;
      color: #e5e5e5;
      border: 1px solid #333;
      padding: 6px 12px;
      font-family: inherit;
      font-size: 12px;
      border-radius: 4px;
      cursor: pointer;
    }
    .form-row button:hover { background: #333; }
    .form-row button.primary { background: #fafafa; color: #0a0a0a; border-color: #fafafa; }
    .form-row button.primary:hover { background: #d4d4d8; }
    .key-output {
      background: #111;
      border: 1px solid #262626;
      border-radius: 4px;
      padding: 12px;
      margin-top: 8px;
      display: none;
      font-size: 11px;
      word-break: break-all;
    }
    .key-output label { color: #6b7280; display: block; margin-bottom: 2px; }
    .key-output .key-val {
      color: #fbbf24;
      cursor: pointer;
      padding: 4px 0;
    }
    .key-output .key-val:hover { text-decoration: underline; }
    .key-output .warning { color: #f87171; font-size: 10px; margin-top: 8px; }
    #message-log {
      max-height: 400px;
      overflow-y: auto;
      background: #111;
      border: 1px solid #1f1f1f;
      border-radius: 4px;
      padding: 8px 12px;
      display: none;
    }
    #message-log:empty::after {
      content: 'Waiting for messages';
      color: #3f3f46;
    }
    .msg-log-header {
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: baseline;
      gap: 8px;
    }
    .msg-log-header:hover h2 { color: #e5e5e5; }
    .msg-log-toggle { color: #525252; font-size: 11px; transition: transform 0.15s; }
    .msg-log-header.expanded .msg-log-toggle { transform: rotate(90deg); }
    .msg-log-header.expanded + #message-log { display: block; }
    .msg-log-count { color: #525252; font-size: 11px; font-weight: 400; }
    .msg-entry {
      padding: 3px 0;
      border-bottom: 1px solid #141414;
      cursor: pointer;
    }
    .msg-entry:last-child { border-bottom: none; }
    .msg-summary {
      display: flex;
      gap: 12px;
      align-items: baseline;
      overflow: hidden;
      white-space: nowrap;
    }
    .msg-ts { color: #525252; font-size: 11px; min-width: 140px; flex-shrink: 0; }
    .msg-seq { color: #6b7280; font-size: 11px; min-width: 40px; flex-shrink: 0; }
    .msg-source { color: #60a5fa; min-width: 80px; flex-shrink: 0; }
    .msg-arrow { color: #3f3f46; flex-shrink: 0; }
    .msg-dest { color: #a78bfa; min-width: 80px; flex-shrink: 0; }
    .msg-delivery { font-size: 11px; flex-shrink: 0; }
    .msg-delivery .uni { color: #4ade80; }
    .msg-delivery .broad { color: #4ade80; }
    .msg-delivery .fail { color: #f87171; }
    .msg-snippet { color: #3f3f46; font-size: 11px; white-space: normal; overflow-wrap: anywhere; }
    .msg-detail {
      display: none;
      margin: 4px 0 4px 92px;
      padding: 6px 8px;
      background: #0d0d0d;
      border: 1px solid #1a1a1a;
      border-radius: 3px;
      font-size: 11px;
      color: #a1a1aa;
      max-height: 300px;
      overflow-y: auto;
    }
    .msg-entry.expanded .msg-detail { display: block; }
    .json-tree { line-height: 1.5; }
    .json-key { color: #60a5fa; }
    .json-str { color: #4ade80; }
    .json-num { color: #fbbf24; }
    .json-bool { color: #f472b6; }
    .json-null { color: #6b7280; }
    .json-toggle {
      cursor: pointer;
      user-select: none;
      color: #525252;
      display: inline;
    }
    .json-toggle:hover { color: #a1a1aa; }
    .json-toggle::before { content: '▶ '; font-size: 9px; display: inline-block; transition: transform 0.1s; }
    .json-toggle.open::before { transform: rotate(90deg); }
    .json-children { display: none; padding-left: 16px; }
    .json-toggle.open + .json-children { display: block; }
    .json-bracket { color: #525252; }
    .json-comma { color: #525252; }
    .json-preview { color: #3f3f46; }
    /* top strip: host and testnet pool cells; red = flagged, amber = near a limit */
    .usage-strip { display: flex; gap: 10px; margin: 0 0 16px 0; flex-wrap: wrap; }
    .usage-cell { border: 1px solid #333; border-radius: 4px; padding: 6px 10px; min-width: 170px; background: #111118; font-size: 12px; }
    .usage-cell .usage-label { color: #a1a1aa; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 3px; }
    .usage-cell .usage-vals { color: #e5e5e5; }
    .usage-cell .usage-vals span { margin-right: 8px; white-space: nowrap; }
    .usage-cell .usage-note { color: #6b7280; font-size: 11px; margin-top: 2px; }
    .usage-cell.ok { border-color: #2f4f3a; }
    .usage-cell.amber { border-color: #b45309; background: #1f1706; }
    .usage-cell.amber .usage-label { color: #fbbf24; }
    .usage-cell.red { border-color: #dc2626; background: #2a0b0b; }
    .usage-cell.red .usage-label { color: #f87171; }
    .usage-cell.unknown { border-color: #3f3f46; }
    .usage-cell.unknown .usage-label { color: #71717a; }
    .usage-stale { color: #f59e0b; font-size: 11px; margin-left: 6px; }
    .persona-status { font-size: 11px; margin: 0 6px; color: #a1a1aa; white-space: nowrap; }
    .persona-status .pst-ok { color: #4ade80; }
    .persona-status .pst-red { color: #f87171; font-weight: bold; }
    @media (max-width: 1150px) {
      body { padding: 16px; }
      header { flex-wrap: wrap; gap: 4px; }
      .form-row { flex-wrap: wrap; }
    }
    .agent-actions select { padding: 2px 4px; font-size: 11px; background: #1a1a2e; color: #a1a1aa; border: 1px solid #333; border-radius: 3px; font-family: inherit; }
    .stats {
      display: flex;
      gap: 32px;
      margin-bottom: 24px;
      color: #a1a1aa;
    }
    .stat-value { color: #fafafa; font-weight: 600; }
    /* Wallets panel */
    .wallets-summary { cursor: pointer; display: flex; align-items: baseline; gap: 8px; margin-bottom: 8px; }
    .wallets-summary h2 { margin-bottom: 0; }
    .wallets-empty { color: #525252; font-size: 12px; padding: 12px 0; }
    .wallet-row { border-bottom: 1px solid #141414; padding: 8px 0; }
    .wallet-row:last-child { border-bottom: none; }
    .wallet-head { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
    .wallet-name { font-weight: 600; color: #fafafa; }
    .wallet-addr { color: #6b7280; font-size: 11px; cursor: pointer; }
    .wallet-addr:hover { color: #a1a1aa; }
    .wallet-chain { color: #fbbf24; font-size: 11px; }
    .wallet-creator { color: #525252; font-size: 11px; }
    .wallet-mode-select {
      background: #1a1a1a;
      color: #e5e5e5;
      border: 1px solid #262626;
      border-radius: 3px;
      padding: 2px 6px;
      font-family: inherit;
      font-size: 11px;
    }
    .wallet-members { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; align-items: center; }
    .wallet-member-chip {
      background: #1a1a1a;
      border: 1px solid #262626;
      border-radius: 12px;
      padding: 2px 4px 2px 8px;
      font-size: 11px;
      color: #a1a1aa;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .wallet-member-revoke {
      cursor: pointer;
      color: #525252;
      padding: 0 4px;
      border-radius: 50%;
    }
    .wallet-member-revoke:hover { color: #f87171; background: #262626; }
    .wallet-grant {
      display: inline-flex;
      gap: 4px;
      align-items: center;
    }
    .wallet-grant input {
      width: 110px;
      font-size: 11px;
      padding: 1px 6px;
      background: #0d0d0d;
      border: 1px solid #262626;
      color: #e5e5e5;
      border-radius: 3px;
    }
    .wallet-grant button {
      font-size: 11px;
      padding: 1px 6px;
      background: #1a1a1a;
      border: 1px solid #262626;
      color: #a1a1aa;
      border-radius: 3px;
      cursor: pointer;
    }
    .wallet-grant button:hover { color: #4ade80; border-color: #4ade80; }
    .wallet-access-disabled { color: #3f3f46; font-style: italic; font-size: 11px; }
    footer {
      margin-top: 32px;
      padding-top: 12px;
      border-top: 1px solid #1f1f1f;
      color: #3f3f46;
      font-size: 11px;
    }
    ${SESSION_CARD_CSS}
  </style>
</head>
<body>
  <header>
    <h1>${process.env.WIRE_INSTANCE_NAME ? process.env.WIRE_INSTANCE_NAME + " - " : ""}The Wire <span>v0.3.0</span></h1>
    <div class="operator">${esc(operatorName)} · <a href="/auth/logout">logout</a></div>
  </header>

  <div class="stats">
    <div><span class="stat-value">${agents.length}</span> agents</div>
    <div><span class="stat-value">${agents.filter((a: any) => a.online).length}</span> online</div>
    <div><span class="stat-value">${agents.reduce((n: number, a: any) => n + a.sessions, 0)}</span> sessions</div>
  </div>

  <div id="usage-strip" class="usage-strip"><div class="usage-cell unknown"><div class="usage-label">host</div><div class="usage-vals">loading</div></div></div>

  <h2>Agents</h2>
  <div id="sessions-head"><div class="sc-empty">loading sessions</div></div>
  <div id="agent-cards" class="sc-cards">${cardsHtml}</div>
  <div id="sessions-foot"></div>
  <div id="peek-dock"></div>

  <div class="form-section">
    <details id="wallets-details">
      <summary class="wallets-summary"><h2>Wallets</h2><span id="wallets-count" class="msg-log-count">loading</span></summary>
      <div class="form-row"><input type="text" id="wallets-filter" placeholder="filter: name, address, creator, agent" style="flex:1"></div>
      <div id="wallets-panel" class="wallets-empty">Loading</div>
    </details>
  </div>

  <div class="form-section">
    <div class="msg-log-header expanded" id="msg-log-header" onclick="this.classList.toggle('expanded')">
      <span class="msg-log-toggle">▶</span>
      <h2>Message Log</h2>
      <span class="msg-log-count" id="msg-log-count"></span>
    </div>
    <div id="message-log"></div>
  </div>


  <div class="form-section">
    <h2>Register Agent</h2>
    <div class="form-row">
      <input type="text" id="new-agent-id" placeholder="agent-id" style="width:120px">
      <input type="text" id="new-agent-name" placeholder="Display Name" style="width:160px">
      <input type="text" id="new-agent-pubkey" placeholder="Ed25519 pubkey (base64, optional)" style="flex:1">
      <button onclick="generateKeypair()" title="Generate Ed25519 keypair">keygen</button>
      <button class="primary" onclick="registerAgent()">Register</button>
    </div>
    <div id="key-output" class="key-output">
      <label>Public Key (will be registered):</label>
      <div class="key-val" id="gen-pubkey" onclick="copy(this.textContent)"></div>
      <label>Private Key (give to agent — shown once):</label>
      <div class="key-val" id="gen-privkey" onclick="copy(this.textContent)" style="color:#f87171"></div>
      <div class="warning">Copy the private key now. It cannot be recovered.</div>
    </div>
  </div>

  <footer>The Wire · agiterra · port ${process.env.WIRE_PORT ?? "9800"}</footer>

  <script>
    // --- Persona Restart / Run-as / credential status (POST /agents/:id/persona-action) ---
    const PERSONA_IDS_JS = ${JSON.stringify([...PERSONA_IDS])};
    const MACHINE_HERE = ${JSON.stringify(MACHINE_HERE)};
    const PERSONA_PRESETS_JS = ${JSON.stringify(PERSONA_PRESETS)};
    const personaStatusCache = {};
    function renderPersonaStatus(id, r) {
      let html;
      if (!r) html = '<span class="dim">checking</span>';
      else if (r.action === 'check' && r.ok) {
        const live = r.cred && r.cred.live;
        html = '<span class="' + (live ? 'pst-ok' : 'pst-red') + '">' + esc(r.harness || '?') + ' ' + esc(r.model || '') + ' · cred ' + (live ? 'ok' : 'DEAD') + (r.cred && r.cred.expires_at ? ' (exp ' + esc(String(r.cred.expires_at).slice(11,16)) + 'Z)' : '') + '</span>';
      } else if (r.ok) html = '<span class="pst-ok">' + esc(r.action) + ' ok → screen ' + esc(r.screen_pid || '?') + ' ' + esc(r.harness || '') + ' ' + esc(r.model || '') + '</span>';
      else html = '<span class="pst-red">' + esc(r.action || '') + ' refused: ' + esc(r.reason || 'unknown') + '</span>';
      personaStatusCache[id] = html;
      document.querySelectorAll('[data-pstatus="' + id + '"]').forEach(el => { el.innerHTML = html; });
    }
    async function pollPersonaStatus(id, tries) {
      for (let i = 0; i < (tries || 30); i++) {
        try {
          const res = await fetch('/agents/' + encodeURIComponent(id) + '/persona-status');
          const j = await res.json();
          if (j.result) { renderPersonaStatus(id, j.result); return j.result; }
        } catch (e) { /* keep polling */ }
        await new Promise(r => setTimeout(r, 3000));
      }
      renderPersonaStatus(id, { ok: false, action: 'status', reason: 'no result within 90 s — is com.agiterra.persona-restart loaded?' });
      return null;
    }
    async function personaAction(id, action, harness, model) {
      if (action === 'restart' && !confirm('Restart ' + id + ' now? The screen is quit and launchd relaunches it on its current harness. Refused automatically if the credential is dead.')) return;
      if (action === 'run-as' && !confirm('Switch ' + id + ' to ' + harness + ' ' + model + ' and restart it now?')) return;
      renderPersonaStatus(id, null);
      const res = await fetch('/agents/' + encodeURIComponent(id) + '/persona-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, harness, model }) });
      const j = await res.json();
      if (!j.ok) { renderPersonaStatus(id, { ok: false, action, reason: j.error || 'request refused' }); return; }
      const r = await pollPersonaStatus(id, action === 'check' ? 10 : 40);
      if (r && action !== 'check') {
        const dock = document.getElementById('peek-dock');
        if (dock) { const panel = document.createElement('div'); panel.className = 'peek-output'; panel.innerHTML = '<div class="peek-header">' + esc(id) + ' ' + esc(action) + '</div>' + esc(JSON.stringify(r, null, 2)); dock.prepend(panel); }
      }
    }
    document.querySelectorAll('[data-pstatus]').forEach(el => { const id = el.dataset.pstatus; if (!personaStatusCache[id]) personaAction(id, 'check'); });

    // --- Top strip: Host and Pool cells (GET /usage, polled every 60s; never invents a number). The Claude / Codex /
    // Grok / "as of" cells were removed 2026-11-10 (Tim: "redundant or useless"): the per-vendor burn strip above the
    // agent cards shows the same meters with rate and time left.
    function pctNum(v) { return (v === null || v === undefined || v === '') ? null : Number(v); }
    // noteIsHtml: the caller built the note from esc()'d pieces itself (e.g. a copyable span) — pass it through unescaped.
    function usageCell(label, state, vals, note, noteIsHtml) {
      return '<div class="usage-cell ' + state + '"><div class="usage-label">' + esc(label) + '</div>' +
        '<div class="usage-vals">' + vals.map(v => '<span title="' + esc(v[2] || '') + '">' + esc(v[0]) + ' ' + esc(v[1]) + '</span>').join('') + '</div>' +
        (note ? '<div class="usage-note">' + (noteIsHtml ? note : esc(note)) + '</div>' : '') + '</div>';
    }
    // Host box note: the flag if any, then the top memory CONSUMERS by footprint (resident + compressed), highest
    // first, from host-usage.sh's grouped consumers list (Tim 2026-09-10: "what is consuming memory ... highest to lowest").
    // Hover the cell for the full list. Older meter files without a consumers list fall back to the as-of stamp.
    function hostNote(h) {
      const gb = (mb) => (mb / 1024).toFixed(1) + 'G';
      const cons = Array.isArray(h.consumers) ? h.consumers : [];
      const flag = (h.flags && h.flags.length) ? esc(h.flags[0]) : '';
      if (!cons.length) return flag || ('as of ' + esc(String(h.as_of || '').slice(11, 16)) + 'Z');
      const full = cons.map(c => gb(c.footprint_mb) + '  ' + c.name + ' x' + c.procs + ' (rss ' + gb(c.rss_mb) + ' + compressed ' + gb(c.cmprs_mb) + ')').join('\\n');
      const top = cons.slice(0, 3).map(c => esc(String(c.name).replace(/ \\(.*\\)$/, '')) + ' ' + gb(c.footprint_mb)).join(' · ');
      return (flag ? flag + ' · ' : '') + '<span title="footprint = resident + compressed, highest first\\n' + esc(full) + '">' + top + (cons.length > 3 ? ' · +' + (cons.length - 3) + ' more' : '') + '</span>';
    }
    // Pool box: short address on screen, full address on the clipboard (Tim 2026-09-10). Empty/absent address → plain '—'.
    function devWalletSpan(addr) {
      const a = String(addr || '');
      if (!a) return '—';
      return '<span class="copyable" data-copy="' + esc(a) + '" title="Click to copy full address ' + esc(a) + '">' + esc(a) + '</span>';
    }
    async function loadUsage() {
      const el = document.getElementById('usage-strip');
      if (!el) return;
      try {
        const res = await fetch('/usage');
        const j = await res.json();
        const fmt = p => p === null ? '—' : p + '%';
        const h = j.host || null;
        let hostCell = usageCell('Host', 'unknown', [['mem', '—', ''], ['swap', '—', ''], ['disk', '—', '']], 'no host meter');
        if (h && h.mem) {
          // Swap is judged in ABSOLUTE MB, not %: macOS grows and shrinks the swapfile, so used% is a ratio over a moving
          // denominator (2026-09-10: 2.3 GB used read as 73% right after the file shrank from 7 GB to 3 GB). Tim's target
          // is "swap becomes a rare occurrence" — red at ≥4 GB used, amber at ≥1 GB.
          const swpMb = Number((h.swap || {}).used_mb); const swp = pctNum((h.swap || {}).used_pct), mf = pctNum((h.mem || {}).free_pct), dfree = (h.disk || {}).free_gb;
          const hstate = (swpMb >= 4096) || (mf !== null && mf < 15) || (dfree !== undefined && dfree < 20) ? 'red' : ((swpMb >= 1024) || (mf !== null && mf < 30) || (dfree !== undefined && dfree < 40) ? 'amber' : 'ok');
          hostCell = usageCell('Host', hstate,
            [['mem used', fmt(pctNum((h.mem || {}).used_pct)), (h.mem || {}).total_gb + ' GB'], ['swap', (isFinite(swpMb) ? (swpMb / 1024).toFixed(1) + ' GB' : fmt(swp)), 'used ' + ((h.swap || {}).used_mb || 0) + ' of a ' + ((h.swap || {}).total_mb || 0) + ' MB swapfile (' + fmt(swp) + ') — red ≥4 GB, amber ≥1 GB'], ['disk free', (dfree === undefined ? '—' : dfree + ' GB'), ((h.disk || {}).used_pct || '') + '% used']],
            hostNote(h), true);
        }
        const pl = j.pool || null;
        let poolCell = usageCell('Pool', 'unknown', [['USDC', '—', ''], ['ETH', '—', '']], 'no pool meter');
        if (pl && pl.status === 'live') {
          const low = (pl.usdc !== null && pl.usdc < pl.min_usdc) || (pl.eth !== null && pl.eth < pl.min_eth);
          poolCell = usageCell('Pool', low ? 'red' : 'ok',
            [['USDC', (pl.usdc === null ? '—' : Number(pl.usdc).toFixed(2)), 'min ' + pl.min_usdc], ['ETH', (pl.eth === null ? '—' : Number(pl.eth).toFixed(4)), 'min ' + pl.min_eth],
             ['props', ((pl.properties || {}).status === 'live' ? String((pl.properties || {}).count) : '?'), 'properties banked in the pool (' + ((pl.properties || {}).status || 'no ledger') + ')']],
            ((pl.flags && pl.flags.length) ? esc(pl.flags[0]) + ' · ' : '') + 'dev-wallet ' + devWalletSpan((pl.pool || {}).address) +
              ((pl.flags && pl.flags.length) ? '' : ' as of ' + esc(String(pl.as_of || '').slice(11, 16)) + 'Z'), true);
        } else if (pl) {
          poolCell = usageCell('Pool', 'red', [['pool', 'unreadable', '']], pl.error || pl.status);
        }
        el.innerHTML = hostCell + poolCell;
        el.querySelectorAll('[data-copy]').forEach(c => { c.onclick = (e) => { e.stopPropagation(); copy(c.dataset.copy, c); }; });
      } catch (e) {
        el.innerHTML = usageCell('host', 'red', [['/usage', 'failed', '']], String(e));
      }
    }
    loadUsage();
    setInterval(loadUsage, 60000);

    // --- Agent cards: the ONLY agent list (Tim 2026-11-10: "The cards replace the list."). The agent set is the Wire
    // registry, pushed by SSE every 3s; each card is joined by id to GET /sessions (fondant's agent-sessions watch,
    // polled every 30s). One render function for the server's first paint and every re-render here.
    ${SESSION_CARD_HELPERS}
    let lastAgents = null;
    let lastSessions = null;
    // Tap-open state (name details, full key, full host, exact Seen time), kept across re-renders.
    const openCells = {};
    function cardCtx() {
      return { here: MACHINE_HERE, personaIds: PERSONA_IDS_JS, presets: PERSONA_PRESETS_JS, podView: POD_VIEW, pstatus: personaStatusCache, plan: renderPlan };
    }
    function renderCards() {
      if (!lastAgents) return;
      const el = document.getElementById('agent-cards');
      // An open run-as dropdown would be destroyed under the viewer's pointer: skip this tick, the next one catches up.
      const act = document.activeElement;
      if (act && act.tagName === 'SELECT' && el.contains(act)) return;
      el.innerHTML = agentCards(lastAgents, lastSessions, Date.now(), cardCtx(), openCells);
    }
    async function loadSessions() {
      const head = document.getElementById('sessions-head');
      const foot = document.getElementById('sessions-foot');
      try {
        const res = await fetch('/sessions');
        lastSessions = await res.json();
      } catch (e) {
        lastSessions = { ok: false, error: '/sessions failed: ' + String(e) };
      }
      const fin = foot.querySelector('details.sc-fin');
      const wasOpen = !!(fin && fin.open);
      head.innerHTML = sessionHead(lastSessions, Date.now());
      foot.innerHTML = sessionFoot(lastSessions);
      if (wasOpen) { const d = foot.querySelector('details.sc-fin'); if (d) d.open = true; }
      renderCards();
    }
    // Every card control is bound once, here, by delegation: re-renders replace the markup, never the handlers.
    const cardsEl = document.getElementById('agent-cards');
    cardsEl.addEventListener('click', (e) => {
      const t = e.target.closest('[data-toggle],[data-copy],[data-peek],[data-msg],[data-restart]');
      if (!t || !cardsEl.contains(t)) return;
      e.stopPropagation();
      if (t.dataset.toggle !== undefined) {
        const k = t.dataset.toggle;
        if (openCells[k]) delete openCells[k]; else openCells[k] = true;
        renderCards();
      } else if (t.dataset.copy !== undefined) copy(t.dataset.copy, t);
      else if (t.dataset.peek !== undefined) peek(t.dataset.peek);
      else if (t.dataset.msg !== undefined) promptSend(t.dataset.msg);
      else if (t.dataset.restart !== undefined) personaAction(t.dataset.restart, 'restart');
    });
    cardsEl.addEventListener('change', (e) => {
      const el = e.target.closest('[data-runas]');
      if (!el) return;
      const v = el.value; el.value = '';
      if (el.blur) el.blur();
      if (!v) return;
      const sp = v.split(' ');
      personaAction(el.dataset.runas, 'run-as', sp[0], sp[1]);
    });

    // --- Live SSE updates ---
    const evtSource = new EventSource('/dashboard/stream');
    evtSource.addEventListener('refresh', () => window.location.reload());
    evtSource.onmessage = (e) => {
      lastAgents = JSON.parse(e.data);
      document.querySelector('.stats').innerHTML = [
        '<div><span class="stat-value">' + lastAgents.length + '</span> agents</div>',
        '<div><span class="stat-value">' + lastAgents.filter(a => a.online).length + '</span> online</div>',
        '<div><span class="stat-value">' + lastAgents.reduce((n, a) => n + a.sessions, 0) + '</span> sessions</div>',
      ].join('');
      renderCards();
    };

    // --- Message log ---
    let msgCount = 0;
    function addMessageEntry(msg) {
      const log = document.getElementById('message-log');
      const d = new Date(msg.created_at);
      const ts = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString();
      const deliveries = msg.deliveries || [];
      const okCount = deliveries.filter(d => d.status === 'delivered').length;
      const failCount = deliveries.length - okCount;
      let deliveryBadges = '';
      if (msg.dest) {
        // Unicast — just show delivery status
        deliveryBadges = failCount > 0
          ? '<span class="fail">x</span>'
          : (okCount > 0 ? '<span class="uni">ok</span>' : '');
      } else {
        // Broadcast — show delivery count
        deliveryBadges = okCount > 0
          ? '<span class="broad">*' + okCount + '</span>'
          : '';
        if (failCount > 0) deliveryBadges += ' <span class="fail">x' + failCount + '</span>';
      }

      // Unwrap stringified JSON
      let parsed = msg.content;
      if (typeof parsed === 'string') {
        try { parsed = JSON.parse(parsed); } catch {}
      }
      // Single-line snippet for collapsed view
      const snippet = typeof parsed === 'string'
        ? parsed
        : JSON.stringify(parsed);
      // Collapsed view shows 80 chars and says how much more there is; a tap opens the full message (no ellipsis, Tim 2026-10-27).
      const clip80 = (t) => t.length > 80 ? t.slice(0, 80) + ' [+' + (t.length - 80) + ' chars, tap to open]' : t;
      const shortSnippet = clip80(snippet);

      const entry = document.createElement('div');
      entry.className = 'msg-entry';
      entry.onclick = (ev) => {
        if (ev.target.closest('.msg-detail') || ev.target.closest('.json-toggle')) return;
        entry.classList.toggle('expanded');
      };

      const summary = document.createElement('div');
      summary.className = 'msg-summary';
      // Prefer human-readable text over raw stringified payload
      let displaySnippet = shortSnippet;
      if (parsed && typeof parsed === 'object') {
        const readable = parsed.text
          ?? parsed.detail
          ?? parsed.message
          ?? (parsed.type === 'wrap-up' ? 'Wrap-Up for ' + (parsed.ticket || '?') : null);
        if (typeof readable === 'string' && readable) {
          displaySnippet = clip80(readable);
        }
      }

      summary.innerHTML =
        '<span class="msg-ts">' + ts + '</span>' +
        '<span class="msg-seq">#' + msg.seq + '</span>' +
        '<span class="msg-source">' + esc(msg.source || '') + '</span>' +
        '<span class="msg-arrow">\u2192</span>' +
        '<span class="msg-dest">' + esc(msg.dest || '*') + '</span>' +
        '<span class="msg-delivery">' + deliveryBadges + '</span>' +
        '<span class="msg-snippet">' + esc(displaySnippet) + '</span>';

      const detail = document.createElement('div');
      detail.className = 'msg-detail json-tree';
      detail.appendChild(renderJson(parsed, 0));

      entry.appendChild(summary);
      entry.appendChild(detail);

      log.prepend(entry);
      msgCount++;
      document.getElementById('msg-log-count').textContent = '(' + msgCount + ')';

      // Cap at 200 entries
      while (log.children.length > 200) { log.removeChild(log.lastChild); msgCount--; }
    }

    // SSE live messages
    evtSource.addEventListener('wire_message', (e) => {
      const msg = JSON.parse(e.data);
      addMessageEntry(msg);
    });
    // Wallet directory changes (namespace wallet-vault only) arrive as their own SSE event; the IPC log above never
    // carried plugin_settings topics, so the old hook in this listener could not fire.
    evtSource.addEventListener('plugin_settings', (e) => {
      try { refreshWalletsIfRelevant(JSON.parse(e.data)); } catch (err) { console.error('wallets: bad plugin_settings event', err, e.data); }
    });

    // Backfill recent messages via REST (API returns oldest-first)
    fetch('/messages/recent?limit=50').then(r => r.json()).then(messages => {
      // Iterate oldest-first so each prepend pushes older entries down
      for (const msg of messages) addMessageEntry(msg);
    }).catch(() => {});

    ${AGENT_CELL_HELPERS}

    function esc(s) {
      return s ? s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;') : '';
    }

    const POD_VIEW = ${JSON.stringify({ host: POD_VIEW_HOST, uid: POD_VIEW_UID })};

    function renderPlan(src) {
      if (!src) return '';
      return marked.parse(src, { breaks: true });
    }

    document.querySelectorAll('.agent-plan').forEach(function(el) {
      var raw = el.textContent;
      el.innerHTML = renderPlan(raw);
    });


    function renderJson(val, depth) {
      const frag = document.createDocumentFragment();
      if (val === null) {
        const s = document.createElement('span');
        s.className = 'json-null';
        s.textContent = 'null';
        frag.appendChild(s);
      } else if (typeof val === 'boolean') {
        const s = document.createElement('span');
        s.className = 'json-bool';
        s.textContent = String(val);
        frag.appendChild(s);
      } else if (typeof val === 'number') {
        const s = document.createElement('span');
        s.className = 'json-num';
        s.textContent = String(val);
        frag.appendChild(s);
      } else if (typeof val === 'string') {
        // Try to unwrap nested stringified JSON
        let inner = null;
        if (val.length > 2 && (val[0] === '{' || val[0] === '[')) {
          try { inner = JSON.parse(val); } catch {}
        }
        if (inner !== null && typeof inner === 'object') {
          return renderJson(inner, depth);
        }
        const s = document.createElement('span');
        s.className = 'json-str';
        s.textContent = JSON.stringify(val);
        frag.appendChild(s);
      } else if (Array.isArray(val)) {
        if (val.length === 0) {
          const s = document.createElement('span');
          s.className = 'json-bracket';
          s.textContent = '[]';
          frag.appendChild(s);
        } else {
          const isOpen = depth === 0;
          const toggle = document.createElement('span');
          toggle.className = 'json-toggle' + (isOpen ? ' open' : '');
          const preview = document.createElement('span');
          preview.className = 'json-preview';
          preview.textContent = 'Array(' + val.length + ')';
          toggle.appendChild(preview);
          toggle.onclick = (e) => { e.stopPropagation(); toggle.classList.toggle('open'); };
          frag.appendChild(toggle);
          const children = document.createElement('div');
          children.className = 'json-children';
          val.forEach((item, i) => {
            const row = document.createElement('div');
            row.appendChild(renderJson(item, depth + 1));
            if (i < val.length - 1) {
              const comma = document.createElement('span');
              comma.className = 'json-comma';
              comma.textContent = ',';
              row.appendChild(comma);
            }
            children.appendChild(row);
          });
          frag.appendChild(children);
        }
      } else if (typeof val === 'object') {
        const keys = Object.keys(val);
        if (keys.length === 0) {
          const s = document.createElement('span');
          s.className = 'json-bracket';
          s.textContent = '{}';
          frag.appendChild(s);
        } else {
          const isOpen = depth === 0;
          const toggle = document.createElement('span');
          toggle.className = 'json-toggle' + (isOpen ? ' open' : '');
          const preview = document.createElement('span');
          preview.className = 'json-preview';
          preview.textContent = '{' + keys.slice(0, 3).join(', ') + (keys.length > 3 ? ', +' + (keys.length - 3) + ' more' : '') + '}';
          toggle.appendChild(preview);
          toggle.onclick = (e) => { e.stopPropagation(); toggle.classList.toggle('open'); };
          frag.appendChild(toggle);
          const children = document.createElement('div');
          children.className = 'json-children';
          keys.forEach((k, i) => {
            const row = document.createElement('div');
            const key = document.createElement('span');
            key.className = 'json-key';
            key.textContent = JSON.stringify(k);
            row.appendChild(key);
            row.appendChild(document.createTextNode(': '));
            row.appendChild(renderJson(val[k], depth + 1));
            if (i < keys.length - 1) {
              const comma = document.createElement('span');
              comma.className = 'json-comma';
              comma.textContent = ',';
              row.appendChild(comma);
            }
            children.appendChild(row);
          });
          frag.appendChild(children);
        }
      }
      return frag;
    }

    function copy(text, srcEl) {
      navigator.clipboard.writeText(text).then(() => {
        const el = srcEl || event?.target?.closest('.copyable') || event?.target;
        if (el) {
          el.classList.add('copied');
          const toast = document.createElement('span');
          toast.className = 'copy-toast';
          toast.textContent = 'Copied!';
          el.appendChild(toast);
          setTimeout(() => { el.classList.remove('copied'); toast.remove(); }, 800);
        }
      });
    }

    // ---- Wallets panel: namespace wallet-vault, one row per wallet (key wallet:<address>); see dashboard-wallets.ts ----
    ${WALLET_HELPERS}
    const WALLET_NS = ${JSON.stringify(WALLET_NAMESPACE)};
    let walletRaw = {};
    let walletDir = [];
    function renderWallets() {
      walletDir = walletDirectory(walletRaw);
      const q = document.getElementById('wallets-filter').value;
      const shown = walletDir.filter(w => walletMatches(w, q)).length;
      document.getElementById('wallets-count').textContent = '(' + (q ? shown + ' of ' : '') + walletDir.length + ' in ' + WALLET_NS + ')';
      const panel = document.getElementById('wallets-panel');
      panel.className = walletDir.length ? '' : 'wallets-empty';
      panel.innerHTML = walletList(walletDir, q);
    }
    async function loadWallets() {
      const panel = document.getElementById('wallets-panel');
      try {
        const res = await fetch('/plugin_settings/' + encodeURIComponent(WALLET_NS));
        if (!res.ok) { panel.textContent = 'Failed to load wallets (' + res.status + ')'; document.getElementById('wallets-count').textContent = '(unreadable)'; return; }
        walletRaw = await res.json();
        renderWallets();
      } catch (e) {
        console.error('wallets: load failed', e);
        panel.textContent = 'Error loading wallets: ' + (e.message || e);
      }
    }
    // Writes the ONE wallet row the edit touches; the vault receives it as a scoped plugin_settings.updated event.
    async function putWallet(key, value) {
      const res = await fetch('/plugin_settings/' + encodeURIComponent(WALLET_NS) + '/' + encodeURIComponent(key), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      if (!res.ok) {
        alert('Update of ' + key + ' failed (' + res.status + '): ' + await res.text().catch(() => ''));
        return false;
      }
      walletRaw[key] = value;
      renderWallets();
      return true;
    }
    function walletEntry(key) { return walletDir.find(w => w.key === key) || null; }
    async function editWallet(key, op) {
      const ent = walletEntry(key);
      if (!ent) { alert('wallet ' + key + ' is no longer in the directory'); return; }
      return putWallet(key, walletEdit(ent.w, op));
    }
    const walletsPanel = document.getElementById('wallets-panel');
    walletsPanel.addEventListener('click', (e) => {
      const t = e.target.closest('[data-copy],[data-wrevoke],[data-wgrant]');
      if (!t || !walletsPanel.contains(t)) return;
      if (t.dataset.copy !== undefined) copy(t.dataset.copy, t);
      else if (t.dataset.wrevoke !== undefined) {
        if (confirm('Revoke ' + t.dataset.agent + ' from ' + t.dataset.wrevoke + '?')) editWallet(t.dataset.wrevoke, { revoke: t.dataset.agent });
      } else if (t.dataset.wgrant !== undefined) {
        const input = t.parentElement.querySelector('input');
        const agentId = input ? input.value.trim() : '';
        if (agentId) editWallet(t.dataset.wgrant, { grant: agentId });
      }
    });
    walletsPanel.addEventListener('keydown', (e) => {
      const input = e.target.closest('[data-wgrant-input]');
      if (input && e.key === 'Enter' && input.value.trim()) editWallet(input.dataset.wgrantInput, { grant: input.value.trim() });
    });
    walletsPanel.addEventListener('change', (e) => {
      const sel = e.target.closest('[data-wmode]');
      if (sel) editWallet(sel.dataset.wmode, { mode: sel.value });
    });
    document.getElementById('wallets-filter').addEventListener('input', renderWallets);
    // A per-wallet row (or the legacy 'wallets' blob) changed: patch the raw listing and re-render.
    function refreshWalletsIfRelevant(msg) {
      const p = msg && msg.payload;
      if (!p || p.namespace !== WALLET_NS || typeof p.key !== 'string') return;
      if (p.key !== 'wallets' && p.key.indexOf('wallet:') !== 0) return;
      if (msg.topic === 'plugin_settings.updated') walletRaw[p.key] = p.value;
      else if (msg.topic === 'plugin_settings.deleted') delete walletRaw[p.key];
      else return;
      renderWallets();
    }

    loadWallets();
    loadSessions();
    setInterval(loadSessions, 30000);

    async function generateKeypair() {
      const kp = await crypto.subtle.generateKey('Ed25519', true, ['sign', 'verify']);
      const pubRaw = await crypto.subtle.exportKey('raw', kp.publicKey);
      const privRaw = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
      const pubB64 = btoa(String.fromCharCode(...new Uint8Array(pubRaw)));
      const privB64 = btoa(String.fromCharCode(...new Uint8Array(privRaw)));

      document.getElementById('new-agent-pubkey').value = pubB64;
      document.getElementById('gen-pubkey').textContent = pubB64;
      document.getElementById('gen-privkey').textContent = privB64;
      document.getElementById('key-output').style.display = 'block';
    }


    // Peek lives in #peek-dock, outside the agent cards. SSE rebuilds the cards
    // every 3s; a panel inside one would vanish. Click peek again to close.
    async function peek(agentId) {
      const existing = document.getElementById('peek-' + agentId);
      if (existing) { existing.remove(); return; }

      const res = await fetch('/agents/' + encodeURIComponent(agentId) + '/peek');
      const data = await res.json();
      const dock = document.getElementById('peek-dock');
      if (!dock) return;
      const panel = document.createElement('div');
      panel.id = 'peek-' + agentId;
      panel.className = 'peek-output';
      if (res.ok) {
        panel.innerHTML = '<div class="peek-header">' + esc(agentId) + ' screen output — click peek again to close</div>' + esc(data.output || '(empty)');
      } else {
        panel.style.color = '#f87171';
        panel.textContent = 'peek failed: ' + (data.error || res.status) + (data.detail ? ' — ' + data.detail : '');
      }
      dock.appendChild(panel);
      panel.scrollIntoView({ block: 'nearest' });
    }

    async function promptSend(agentId) {
      const msg = prompt('Message to ' + agentId + ':');
      if (!msg) return;

      const res = await fetch('/agents/' + encodeURIComponent(agentId) + '/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, text: msg }),
      });

      const data = await res.json();
      const dock = document.getElementById('peek-dock');
      const note = document.createElement('div');
      note.className = 'peek-output';
      if (!res.ok) {
        note.style.color = '#f87171';
        note.textContent = 'msg to ' + agentId + ' failed: ' + (data.error || res.status) + (data.detail ? ' — ' + data.detail : '');
      } else {
        const st = ((data.delivered_to || [])[0] || {}).status || 'stored';
        note.innerHTML = '<div class="peek-header">msg ' + esc(agentId) + ' seq ' + esc(String(data.seq)) + ' (' + esc(st) + ') — click to dismiss</div>';
      }
      note.onclick = function() { note.remove(); };
      if (dock) dock.appendChild(note);
      else window.alert(note.textContent);
    }

    async function registerAgent() {
      const id = document.getElementById('new-agent-id').value.trim();
      const name = document.getElementById('new-agent-name').value.trim();
      const pubkey = document.getElementById('new-agent-pubkey').value.trim();

      if (!id || !name) { alert('Agent ID and name are required'); return; }
      if (!pubkey) { alert('Public key required — use keygen or paste one'); return; }

      const res = await fetch('/agents/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, display_name: name, pubkey, permanent: true }),
      });

      if (res.ok) {
        window.location.reload();
      } else {
        const err = await res.json();
        alert('Registration failed: ' + (err.error || res.status));
      }
    }
  </script>
</body>
</html>`;
}

export function renderLogin(hasOwner: boolean): string {
  const action = hasOwner ? "Sign in" : "Claim this instance";
  const subtitle = hasOwner
    ? "Authenticate with your passkey to access the dashboard."
    : "No owner registered. The first passkey claims ownership.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${process.env.WIRE_INSTANCE_NAME ?? "The Wire"} — Login</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='6' fill='%230a0a0a'/><path d='M18 4L10 18h5l-2 10 10-14h-5z' fill='%23fbbf24'/></svg>">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0a;
      color: #e5e5e5;
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
      font-size: 13px;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #111;
      border: 1px solid #262626;
      border-radius: 8px;
      padding: 32px;
      width: 360px;
      text-align: center;
    }
    h1 { font-size: 16px; margin-bottom: 8px; }
    p { color: #6b7280; margin-bottom: 24px; font-size: 12px; }
    button {
      background: #fafafa;
      color: #0a0a0a;
      border: none;
      padding: 10px 24px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      border-radius: 4px;
      cursor: pointer;
      width: 100%;
    }
    button:hover { background: #d4d4d8; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .error { color: #f87171; margin-top: 12px; font-size: 12px; display: none; }
    #name-field { display: ${hasOwner ? "none" : "block"}; margin-bottom: 16px; }
    input {
      background: #1a1a1a;
      border: 1px solid #333;
      color: #e5e5e5;
      padding: 8px 12px;
      font-family: inherit;
      font-size: 13px;
      border-radius: 4px;
      width: 100%;
    }
    input:focus { outline: none; border-color: #60a5fa; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${process.env.WIRE_INSTANCE_NAME ? process.env.WIRE_INSTANCE_NAME + " - " : ""}The Wire</h1>
    <p>${subtitle}</p>
    <div id="name-field">
      <input type="text" id="display-name" placeholder="Your name" autocomplete="name">
    </div>
    <button id="auth-btn" onclick="authenticate()">${action}</button>
    <div id="error" class="error"></div>
  </div>

  <script>
    const hasOwner = ${hasOwner};

    async function authenticate() {
      const btn = document.getElementById('auth-btn');
      const errEl = document.getElementById('error');
      btn.disabled = true;
      errEl.style.display = 'none';

      try {
        if (!hasOwner) {
          await doRegister();
        } else {
          await doLogin();
        }
      } catch (e) {
        errEl.textContent = e.message || 'Authentication failed';
        errEl.style.display = 'block';
        btn.disabled = false;
      }
    }

    async function doRegister() {
      const name = document.getElementById('display-name').value || 'Operator';
      const res = await fetch('/auth/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ display_name: name }),
      });
      const options = await res.json();

      // Decode challenge
      options.challenge = base64urlToBuffer(options.challenge);
      options.user.id = base64urlToBuffer(options.user.id);

      const credential = await navigator.credentials.create({ publicKey: options });
      const response = credential.response;

      await fetch('/auth/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: credential.id,
          rawId: bufferToBase64url(credential.rawId),
          response: {
            clientDataJSON: bufferToBase64url(response.clientDataJSON),
            attestationObject: bufferToBase64url(response.attestationObject),
          },
          type: credential.type,
          display_name: name,
          challenge: options._challenge,
        }),
      });

      window.location.reload();
    }

    async function doLogin() {
      const res = await fetch('/auth/login/options', { method: 'POST' });
      const options = await res.json();
      const savedChallenge = options.challenge;

      const publicKeyOptions = {
        challenge: base64urlToBuffer(options.challenge),
        rpId: options.rpId,
        timeout: options.timeout,
        userVerification: options.userVerification,
      };

      const credential = await navigator.credentials.get({ publicKey: publicKeyOptions });
      const response = credential.response;

      const verifyRes = await fetch('/auth/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: credential.id,
          rawId: bufferToBase64url(credential.rawId),
          response: {
            clientDataJSON: bufferToBase64url(response.clientDataJSON),
            authenticatorData: bufferToBase64url(response.authenticatorData),
            signature: bufferToBase64url(response.signature),
          },
          type: credential.type,
          challenge: savedChallenge,
        }),
      });

      if (verifyRes.ok) {
        window.location.reload();
      } else {
        throw new Error('Login verification failed');
      }
    }

    function base64urlToBuffer(b64url) {
      const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64);
      return Uint8Array.from(bin, c => c.charCodeAt(0)).buffer;
    }

    function bufferToBase64url(buf) {
      const bytes = new Uint8Array(buf);
      let str = '';
      for (const b of bytes) str += String.fromCharCode(b);
      return btoa(str).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
    }
  </script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// The attach button's wire-attach:// URL is built by cardAttachHref() in dashboard-session-cards.ts (one copy for the
// server's first paint and the client re-render).

/**
 * Agent session cards + usage burn strip (Tim, 2026-11-10 15:24Z, Fabrica Slack DM: a friend's "Agent Monitor"
 * shows the running SESSION per agent; ours showed identity and messaging only).
 *
 * Data: GET /sessions serves the JSON that fondant's host watch `agent-sessions-collect` writes every 60 s
 * (/opt/agiterra/watch/state/agent-sessions.json). The gateway runs as tim and cannot read other uids' session logs,
 * so it never computes these numbers itself: it shows the file, and a missing field shows as "—", never 0.
 *
 * Tim, 2026-11-10 ~17:00Z: "The cards replace the list." The cards are the ONLY agent list: the agent set is the Wire
 * registry (every row the retired Agent Registry table showed), each joined by id to the collector's session record.
 *
 * Same contract as dashboard-agent-cells.ts: each function is self-contained (no module-level references except the
 * others listed in SESSION_CARD_HELPERS and the agent-cell helpers imported below, which dashboard.ts injects under the
 * same names), because dashboard.ts injects their source into the client <script> with Function.prototype.toString.
 * Full agent names are never cropped (Tim 15:52Z 10-22).
 */

import { agentNameCell, machineCell, relTime, tapFull } from "./dashboard-agent-cells.js";

export function scEsc(s: any): string {
  return s == null ? "" : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** 1234 -> "1.2K", 3730344 -> "3.73M"; null -> "—". */
export function scTok(n: any): string {
  if (n === null || n === undefined || n === "" || isNaN(Number(n))) return "—";
  const v = Number(n);
  if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

/** Seconds -> "45s", "12m", "3h 05m", "4d 2h"; null -> "—". */
export function scDur(s: any): string {
  if (s === null || s === undefined || isNaN(Number(s))) return "—";
  const v = Math.max(0, Math.round(Number(s)));
  if (v < 60) return v + "s";
  if (v < 3600) return Math.floor(v / 60) + "m";
  if (v < 86400) return Math.floor(v / 3600) + "h " + String(Math.floor((v % 3600) / 60)).padStart(2, "0") + "m";
  return Math.floor(v / 86400) + "d " + Math.floor((v % 86400) / 3600) + "h";
}

/** Seconds since an ISO time, or null. */
export function scAge(iso: any, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return isNaN(t) ? null : Math.max(0, (now - t) / 1000);
}

/** The session half of a card: Running/Last/Calls/Tokens, Model, Context, Current folder. `s` null -> every field "—". */
export function sessionFields(s: any, now: number): string {
  const e = scEsc;
  const field = (k: string, v: string, title?: string) =>
    '<div class="sc-f"><div class="sc-k">' + e(k) + '</div><div class="sc-v"' + (title ? ' title="' + e(title) + '"' : "") + ">" + e(v) + "</div></div>";
  if (!s) {
    return '<div class="sc-grid">' + field("Running", "—") + field("Last", "—") + field("Calls", "—") + field("Tokens", "—") + "</div>" +
      field("Model", "—") + field("Context", "—") + field("Current folder", "—");
  }
  const ctx = s.context || {};
  const used = ctx.tokens;
  const denom = ctx.window || null;
  const pct = used != null && denom ? Math.min(100, (100 * used) / denom) : null;
  const warnPct = ctx.warn && denom ? Math.min(100, (100 * ctx.warn) / denom) : null;
  const level = ctx.level || "unknown";
  const ctxText = scTok(used) + " of " + (denom ? scTok(denom) : "?") +
    (ctx.warn ? " · line " + scTok(ctx.warn) : "") + (level === "over" ? " · OVER LINE" : level === "warn" ? " · near line" : "");
  const ctxTitle = (ctx.window_source ? "window: " + ctx.window_source : "window unknown") + (ctx.warn_source ? " · line: " + ctx.warn_source : "");
  const bar = pct === null
    ? '<div class="sc-bar unknown"></div>'
    : '<div class="sc-bar"><div class="sc-fill ' + e(level) + '" style="width:' + pct.toFixed(1) + '%"></div>' +
      (warnPct !== null ? '<div class="sc-mark" style="left:' + warnPct.toFixed(1) + '%"></div>' : "") + "</div>";
  // Running = this SESSION (a persona's screen lives for weeks across /clear and recycles; that is not a session).
  const running = scAge(s.session_started_at || s.launched_at, now);
  return '<div class="sc-grid">' +
    field("Running", scDur(running), (s.session_started_at ? "session since " + s.session_started_at + " · " : "") + (s.launched_at ? "screen launched " + s.launched_at : "")) +
    field("Last", s.last_event_age_s != null ? scDur(s.last_event_age_s) + " ago" : "—", (s.last_event_at || "") + (s.last_tool ? " · last tool " + s.last_tool : "")) +
    field("Calls", s.tool_calls != null ? String(s.tool_calls) : "—", s.tool_calls_10m != null ? s.tool_calls_10m + " in the last 10 min" : "") +
    field("Tokens", scTok(s.tokens_total), s.tokens_in != null ? "in " + s.tokens_in + " (cache incl.) · out " + (s.tokens_out ?? "—") + " · this session" : "no per-call usage in this runtime's log") +
    "</div>" +
    field("Model", s.model || "—") +
    '<div class="sc-f"><div class="sc-k">Context</div><div class="sc-v" title="' + e(ctxTitle) + '">' + e(ctxText) + "</div>" + bar + "</div>" +
    field("Current folder", s.cwd || "—", s.cwd || "");
}

/**
 * wire-attach:// URL for the attach button. The native WireAttach.app opens the agent's screen in a new iTerm2 tab.
 * Pod lane (no run_as_uid, ssh_host bk-node-*; same test as peek-screen.ts isPodLane): there is no screen on the node,
 * so the attach runs on this Wire's host as podView.uid and wire-attach-session.sh follows the pod session.
 */
export function cardAttachHref(a: any, podView: { host: string; uid: string }): string {
  const pod = !a.run_as_uid && /^bk-node-[A-Za-z0-9-]+$/.test(a.ssh_host || "");
  return "wire-attach://attach?" + new URLSearchParams({
    agent: a.id,
    host: pod ? podView.host : (a.ssh_host || "local"),
    user: pod ? podView.uid : (a.run_as_uid || ""),
    screen: pod ? "pod:" + a.ssh_host : (a.screen_name || a.id),
  }).toString();
}

/**
 * The card's buttons, each payload in a data-* attribute (an escaped quote inside an onclick in the TS template literal
 * once broke the whole page, j:1250). The page binds them by delegation on #agent-cards. Persona ids also get the
 * credential status, Restart and Run-as; ctx.pstatus holds the last status HTML the page received per persona.
 */
export function cardActions(w: any, ctx: any): string {
  const e = scEsc;
  const id = String(w.id);
  let html = '<button data-peek="' + e(id) + '" title="Read the agent screen output">peek</button>' +
    '<button data-msg="' + e(id) + '" title="Send IPC message to agent">msg</button>' +
    '<a class="row-btn" href="' + e(cardAttachHref(w, ctx.podView)) + '" title="Attach this agent screen in a new iTerm2 tab">📺 attach</a>';
  if ((ctx.personaIds || []).indexOf(id) >= 0) {
    const opts = (ctx.presets || []).map((p: string[]) => '<option value="' + e(p[0] + " " + p[1]) + '">' + e(p[2]) + "</option>").join("");
    html += '<span class="persona-status" data-pstatus="' + e(id) + '" title="harness · credential">' + ((ctx.pstatus || {})[id] || "checking") + "</span>" +
      '<button data-restart="' + e(id) + '" title="Quit the persona screen; launchd relaunches it on its current harness (refused if the credential is dead)">restart</button>' +
      '<select data-runas="' + e(id) + '" title="Switch harness/model and restart"><option value="">run as</option>' + opts + "</select>";
  }
  return html;
}

/**
 * One agent card. `w` is the Wire registry row (the agent set: every agent the old registry list showed), `s` the
 * collector's session record for the same id, or null (no crews.db row: herald, vacherin, integrations, reaped
 * personas). Identity fields come from `w`, session fields from `s`, and an absent session shows "—", never 0.
 */
export function agentCard(w: any, s: any, now: number, ctx: any, open: Record<string, boolean>): string {
  const e = scEsc;
  const st = !s ? "none" : s.state === "working" ? "working" : s.state === "error" ? "error" : "waiting";
  const stLabel = st === "working" ? "Working" : st === "error" ? "No reading" : st === "waiting" ? "Waiting" : "No session";
  const stTitle = st === "none" ? "no session record for this agent (the session collector reads crews.db)" : (s.error || "");
  const reaped = w.reaped_at != null;
  const kind = w.kind && w.kind !== "agent" ? String(w.kind) : "";
  const lastSeen = w.last_seen_at ? new Date(w.last_seen_at).toLocaleString() : "never";
  const k = (label: string, v: string) => '<div class="sc-f"><div class="sc-k">' + e(label) + '</div><div class="sc-v">' + v + "</div></div>";
  const plan = w.plan ? (ctx.plan ? ctx.plan(String(w.plan)) : e(w.plan)) : "";
  return '<div class="sc-card sc-' + st + (w.online ? "" : " sc-offline") + (reaped ? " sc-reaped" : "") + '" data-sc-id="' + e(w.id) + '">' +
    '<div class="sc-head">' +
    '<span class="sc-dot ' + (w.online ? "on" : "off") + '" title="' + (w.online ? "connected to the Wire" : "not connected") + '">' + (w.online ? "●" : "○") + "</span>" +
    (s && s.runtime ? '<span class="sc-rt sc-rt-' + e(String(s.runtime).toLowerCase()) + '">' + e(String(s.runtime).toUpperCase()) + "</span>" : "") +
    '<div class="sc-name agent-name">' + agentNameCell(w, open) + "</div>" +
    '<span class="sc-pill sc-pill-' + st + '"' + (stTitle ? ' title="' + e(stTitle) + '"' : "") + ">" + stLabel + "</span></div>" +
    '<div class="sc-badges">' + (w.permanent ? '<span class="badge badge-personai">personai</span>' : '<span class="badge badge-ephemeral">ephemeral</span>') +
    (kind ? '<span class="badge badge-kind">' + e(kind) + "</span>" : "") +
    (reaped ? '<span class="badge badge-reaped" title="reaped ' + e(w.reaped_at) + '">reaped</span>' : "") + "</div>" +
    '<div class="sc-grid sc-ident">' +
    k("Machine", machineCell(w, ctx.here, open)) +
    k("Key", tapFull("key:" + w.id, w.pubkey ? String(w.pubkey).slice(0, 8) : "—", w.pubkey || "—", open)) +
    k("Sessions", e(w.sessions != null ? String(w.sessions) : "—")) +
    k("Seen", tapFull("seen:" + w.id, relTime(w.last_seen_at, now), lastSeen, open)) +
    "</div>" +
    sessionFields(s, now) +
    '<div class="sc-actions agent-actions">' + cardActions(w, ctx) + "</div>" +
    '<div class="agent-plan sc-plan" data-plan-for="' + e(w.id) + '">' + plan + "</div>" +
    "</div>";
}

/** Card order: personas, then lanes, then integrations; reaped rows last; by id within a group. */
export function cardRank(w: any): number {
  return (w.reaped_at != null ? 3 : 0) + (w.kind === "integration" ? 2 : w.permanent ? 0 : 1);
}

/**
 * All cards. The agent set is the Wire registry rows (`wire`, the same rows the registry list showed), joined to the
 * collector's records by id. A session record with no Wire row is named in a note, never dropped silently.
 */
export function agentCards(wire: any[], sess: any, now: number, ctx: any, open: Record<string, boolean>): string {
  const recs: any[] = (sess && sess.ok && sess.data && sess.data.agents) || [];
  const byId: Record<string, any> = {};
  for (const r of recs) byId[String(r.id)] = r;
  const ws = (wire || []).slice().sort((x: any, y: any) => (cardRank(x) - cardRank(y)) || String(x.id).localeCompare(String(y.id)));
  const ids: Record<string, boolean> = {};
  for (const w of ws) ids[String(w.id)] = true;
  const orphans = recs.filter((r: any) => !ids[String(r.id)]).map((r: any) => String(r.id));
  return ws.map((w: any) => agentCard(w, byId[String(w.id)] || null, now, ctx, open)).join("") +
    (orphans.length ? '<div class="sc-note sc-orphans">Session records with no Wire registration: ' + scEsc(orphans.join(", ")) + "</div>" : "");
}

/** The usage strip: per meter, used %, rate %/h, est. time left, reset. */
export function usageBurnRow(m: any): string {
  const e = scEsc;
  const used = m.used_pct;
  const cls = used == null ? "unknown" : used >= 95 ? "red" : used >= 80 ? "amber" : "ok";
  const h = (x: any) => (x == null ? "—" : x >= 48 ? Math.round(x / 24) + "d" : (Math.round(x * 10) / 10) + "h");
  return '<div class="sb-row ' + cls + '"><div class="sb-name">' + e(m.meter) + "</div>" +
    '<div class="sb-bar"><div class="sb-fill" style="width:' + Math.min(100, Number(used) || 0) + '%"></div>' +
    (m.pace_line_pct != null ? '<div class="sb-mark" title="pace line ' + Math.round(m.pace_line_pct) + '%" style="left:' + Math.min(100, m.pace_line_pct) + '%"></div>' : "") + "</div>" +
    '<div class="sb-vals"><span>' + (used == null ? "—" : Math.round(used) + "%") + "</span>" +
    '<span title="slope of the collector samples over the last hour">' + (m.rate_pct_h == null ? "rate —" : m.rate_pct_h + " %/h") + "</span>" +
    "<span>" + (m.est_left_h == null ? "left —" : "left " + h(m.est_left_h)) + "</span>" +
    '<span title="' + e(m.reset_at || "") + '">resets ' + h(m.reset_h) + "</span>" +
    (m.status ? '<span class="sb-status">' + e(m.status) + "</span>" : "") + "</div></div>";
}

/** Above the cards: running counts per runtime, collector as-of (stale marker), the usage burn strip. */
export function sessionHead(d: any, now: number): string {
  const e = scEsc;
  if (!d || !d.ok) {
    return '<div class="sc-empty">session data unavailable: ' + e((d && (d.error || d.file)) || "no data") + "</div>";
  }
  const s = d.data || {};
  const c = s.counts || {};
  const per = Object.keys(c).filter((k) => k !== "running").map((k) => e(k) + " " + c[k]).join(" · ");
  const age = scAge(s.as_of, now);
  const stale = age != null && age > 300 ? ' <span class="usage-stale">stale ' + Math.round(age / 60) + "m</span>" : "";
  return '<div class="sc-top"><b>' + (c.running ?? (s.agents || []).length) + " running</b>" + (per ? " · " + per : "") +
    ' <span class="sc-asof">sessions as of ' + e(String(s.as_of || "").replace("T", " ").replace("Z", "")) + "Z" + stale + "</span></div>" +
    '<div class="sb-strip">' + ((s.usage && s.usage.meters) || []).map(usageBurnRow).join("") + "</div>";
}

/** Below the cards: the finished-in-24h list and the collector's "not yet" note. */
export function sessionFoot(d: any): string {
  const e = scEsc;
  if (!d || !d.ok) return "";
  const s = d.data || {};
  const fin = s.finished_24h || [];
  return "<details class=\"sc-fin\"><summary>Finished in last 24h (" + fin.length + " stopped)</summary><table class=\"sc-fin-t\">" +
    fin.map((f: any) => "<tr><td>" + e(f.name || f.id) + "</td><td>" + e(f.runtime || "") + "</td><td>" + e(String(f.stopped_at || "").replace("T", " ")) +
      "</td><td>" + e(f.badge || "") + "</td></tr>").join("") + "</table></details>" +
    (s.not_yet ? '<div class="sc-note">Not yet: ' + e(s.not_yet) + "</div>" : "");
}

export const SESSION_CARD_HELPERS = [scEsc, scTok, scDur, scAge, sessionFields, cardAttachHref, cardActions, agentCard, cardRank, agentCards, usageBurnRow, sessionHead, sessionFoot].map((f) => f.toString()).join("\n");

export const SESSION_CARD_CSS = `
    .sc-top { margin: 4px 0 8px 0; color: #e5e5e5; font-size: 13px; }
    .sc-asof { color: #6b7280; font-size: 11px; margin-left: 8px; }
    .sb-strip { display: flex; flex-direction: column; gap: 4px; margin: 0 0 12px 0; max-width: 900px; }
    .sb-row { display: grid; grid-template-columns: 130px 1fr auto; gap: 10px; align-items: center; font-size: 12px; }
    .sb-name { color: #a1a1aa; overflow-wrap: anywhere; }
    .sb-bar { position: relative; height: 8px; background: #1f1f29; border-radius: 4px; overflow: hidden; }
    .sb-fill { height: 100%; background: #22c55e; }
    .sb-row.amber .sb-fill { background: #f59e0b; } .sb-row.red .sb-fill { background: #ef4444; } .sb-row.unknown .sb-fill { background: #3f3f46; }
    .sb-mark { position: absolute; top: 0; bottom: 0; width: 2px; background: #e5e5e5; opacity: .7; }
    .sb-vals span { margin-right: 10px; white-space: nowrap; color: #e5e5e5; }
    .sb-status { color: #6b7280 !important; }
    .sc-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 10px; margin-bottom: 10px; }
    .sc-card { border: 1px solid #333; border-radius: 6px; padding: 10px 12px; background: #111118; font-size: 12px; min-width: 0; }
    .sc-card.sc-working { border-color: #2f4f3a; } .sc-card.sc-error { border-color: #7f1d1d; }
    .sc-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
    .sc-name { flex: 1 1 0; min-width: 0; font-weight: 600; color: #f4f4f5; font-size: 13px; overflow-wrap: anywhere; white-space: normal; }
    .sc-dot.on { color: #4ade80; } .sc-dot.off { color: #6b7280; }
    .sc-badges { display: flex; flex-wrap: wrap; gap: 4px; margin: -4px 0 8px 0; }
    .badge-kind { background: #1f2937; color: #cbd5e1; } .badge-reaped { background: #27272a; color: #a1a1aa; }
    .sc-card.sc-offline { border-style: dashed; } .sc-card.sc-reaped { opacity: .55; }
    /* auto tracks + break-word: a short machine name never splits mid-word; a tapped-open full host still wraps. */
    .sc-ident { grid-template-columns: repeat(4, auto); border-bottom: 1px solid #1f1f29; padding-bottom: 6px; }
    .sc-ident .sc-v { overflow-wrap: break-word; }
    .sc-ident .sc-v .dim { color: #71717a; }
    .sc-actions { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; margin-top: 4px; }
    .sc-actions .persona-status { white-space: normal; margin: 0 4px 0 2px; }
    .sc-plan { padding: 6px 0 0 0; margin-top: 6px; border-top: 1px solid #1f1f29; overflow-x: auto; }
    .sc-plan:empty { display: none; }
    .sc-rt { font-size: 10px; letter-spacing: .05em; padding: 1px 5px; border-radius: 3px; background: #27272a; color: #d4d4d8; }
    .sc-rt-claude { background: #3b2a1a; color: #fdba74; } .sc-rt-codex { background: #1a2a3b; color: #93c5fd; } .sc-rt-grok { background: #2a1a3b; color: #d8b4fe; }
    .sc-pill { margin-left: auto; font-size: 11px; padding: 1px 8px; border-radius: 10px; }
    .sc-pill-working { background: #14532d; color: #86efac; } .sc-pill-waiting { background: #27272a; color: #a1a1aa; } .sc-pill-error { background: #450a0a; color: #fca5a5; } .sc-pill-none { background: #18181b; color: #71717a; }
    .sc-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin-bottom: 6px; }
    .sc-f { margin-bottom: 6px; min-width: 0; }
    .sc-k { color: #71717a; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
    .sc-v { color: #e5e5e5; overflow-wrap: anywhere; }
    .sc-bar { position: relative; height: 6px; background: #1f1f29; border-radius: 3px; overflow: hidden; margin-top: 3px; }
    .sc-bar.unknown { background: repeating-linear-gradient(45deg, #1f1f29, #1f1f29 4px, #27272a 4px, #27272a 8px); }
    .sc-fill { height: 100%; background: #22c55e; } .sc-fill.warn { background: #f59e0b; } .sc-fill.over { background: #ef4444; } .sc-fill.unknown { background: #52525b; }
    .sc-mark { position: absolute; top: 0; bottom: 0; width: 2px; background: #fbbf24; }
    .sc-fin summary { cursor: pointer; color: #a1a1aa; font-size: 12px; }
    .sc-fin-t { font-size: 11px; margin-top: 4px; } .sc-fin-t td { padding: 2px 8px 2px 0; vertical-align: top; overflow-wrap: anywhere; }
    .sc-note, .sc-empty { color: #6b7280; font-size: 11px; margin: 4px 0 12px 0; }
    @media (max-width: 520px) { .sc-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .sb-row { grid-template-columns: 1fr; } }
`;

/**
 * Agent session cards + usage burn strip (Tim, 2026-11-10 15:24Z, Fabrica Slack DM: a friend's "Agent Monitor"
 * shows the running SESSION per agent; ours showed identity and messaging only).
 *
 * Data: GET /sessions serves the JSON that fondant's host watch `agent-sessions-collect` writes every 60 s
 * (/opt/agiterra/watch/state/agent-sessions.json). The gateway runs as tim and cannot read other uids' session logs,
 * so it never computes these numbers itself: it shows the file, and a missing field shows as "—", never 0.
 *
 * Same contract as dashboard-agent-cells.ts: each function is self-contained (no imports, no module-level references
 * except the others listed in SESSION_CARD_HELPERS), because dashboard.ts injects their source into the client
 * <script> with Function.prototype.toString. Full agent names are never cropped (Tim 15:52Z 10-22).
 */

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

/** One agent card. */
export function sessionCard(a: any, now: number): string {
  const e = scEsc;
  const ctx = a.context || {};
  const st = a.state === "working" ? "working" : a.state === "error" ? "error" : "waiting";
  const stLabel = st === "working" ? "Working" : st === "error" ? "No reading" : "Waiting";
  const rt = String(a.runtime || "?").toUpperCase();
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
  const running = scAge(a.launched_at, now);
  const field = (k: string, v: string, title?: string) =>
    '<div class="sc-f"><div class="sc-k">' + e(k) + '</div><div class="sc-v"' + (title ? ' title="' + e(title) + '"' : "") + ">" + e(v) + "</div></div>";
  return '<div class="sc-card sc-' + st + '" data-sc-id="' + e(a.id) + '">' +
    '<div class="sc-head"><span class="sc-rt sc-rt-' + e(String(a.runtime || "").toLowerCase()) + '">' + e(rt) + "</span>" +
    '<span class="sc-name">' + e(a.name || a.id) + "</span>" +
    '<span class="sc-kind">' + e(a.kind || "") + "</span>" +
    '<span class="sc-pill sc-pill-' + st + '"' + (a.error ? ' title="' + e(a.error) + '"' : "") + ">" + stLabel + "</span></div>" +
    '<div class="sc-grid">' +
    field("Running", scDur(running), a.launched_at ? "launched " + a.launched_at : "") +
    field("Last", a.last_event_age_s != null ? scDur(a.last_event_age_s) + " ago" : "—", (a.last_event_at || "") + (a.last_tool ? " · last tool " + a.last_tool : "")) +
    field("Calls", a.tool_calls != null ? String(a.tool_calls) : "—", a.tool_calls_10m != null ? a.tool_calls_10m + " in the last 10 min" : "") +
    field("Tokens", scTok(a.tokens_total), a.tokens_in != null ? "in " + a.tokens_in + " (cache incl.) · out " + (a.tokens_out ?? "—") + " · this session" : "no per-call usage in this runtime's log") +
    "</div>" +
    field("Model", a.model || "—") +
    '<div class="sc-f"><div class="sc-k">Context</div><div class="sc-v" title="' + e(ctxTitle) + '">' + e(ctxText) + "</div>" + bar + "</div>" +
    field("Current folder", a.cwd || "—", a.cwd || "") +
    "</div>";
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

/** The whole section: header counts, burn strip, cards, finished list. */
export function sessionSection(d: any, now: number): string {
  const e = scEsc;
  if (!d || !d.ok) {
    return '<div class="sc-empty">session cards unavailable: ' + e((d && (d.error || d.file)) || "no data") + "</div>";
  }
  const s = d.data || {};
  const agents = (s.agents || []).slice().sort((x: any, y: any) =>
    (x.kind === y.kind ? 0 : x.kind === "persona" ? -1 : 1) || String(x.id).localeCompare(String(y.id)));
  const c = s.counts || {};
  const per = Object.keys(c).filter((k) => k !== "running").map((k) => e(k) + " " + c[k]).join(" · ");
  const age = scAge(s.as_of, now);
  const stale = age != null && age > 300 ? ' <span class="usage-stale">stale ' + Math.round(age / 60) + "m</span>" : "";
  const fin = s.finished_24h || [];
  return '<div class="sc-top"><b>' + (c.running ?? agents.length) + " running</b>" + (per ? " · " + per : "") +
    ' <span class="sc-asof">as of ' + e(String(s.as_of || "").replace("T", " ").replace("Z", "")) + "Z" + stale + "</span></div>" +
    '<div class="sb-strip">' + ((s.usage && s.usage.meters) || []).map(usageBurnRow).join("") + "</div>" +
    '<div class="sc-cards">' + agents.map((a: any) => sessionCard(a, now)).join("") + "</div>" +
    "<details class=\"sc-fin\"><summary>Finished in last 24h (" + fin.length + " stopped)</summary><table class=\"sc-fin-t\">" +
    fin.map((f: any) => "<tr><td>" + e(f.name || f.id) + "</td><td>" + e(f.runtime || "") + "</td><td>" + e(String(f.stopped_at || "").replace("T", " ").replace("Z", "Z")) +
      "</td><td>" + e(f.badge || "") + "</td></tr>").join("") + "</table></details>" +
    (s.not_yet ? '<div class="sc-note">Not yet: ' + e(s.not_yet) + "</div>" : "");
}

export const SESSION_CARD_HELPERS = [scEsc, scTok, scDur, scAge, sessionCard, usageBurnRow, sessionSection].map((f) => f.toString()).join("\n");

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
    .sc-name { font-weight: 600; color: #f4f4f5; font-size: 13px; overflow-wrap: anywhere; }
    .sc-kind { color: #6b7280; font-size: 11px; }
    .sc-rt { font-size: 10px; letter-spacing: .05em; padding: 1px 5px; border-radius: 3px; background: #27272a; color: #d4d4d8; }
    .sc-rt-claude { background: #3b2a1a; color: #fdba74; } .sc-rt-codex { background: #1a2a3b; color: #93c5fd; } .sc-rt-grok { background: #2a1a3b; color: #d8b4fe; }
    .sc-pill { margin-left: auto; font-size: 11px; padding: 1px 8px; border-radius: 10px; }
    .sc-pill-working { background: #14532d; color: #86efac; } .sc-pill-waiting { background: #27272a; color: #a1a1aa; } .sc-pill-error { background: #450a0a; color: #fca5a5; }
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

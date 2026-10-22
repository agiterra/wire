/**
 * Agent Registry cell helpers (Tim, 2026-10-22): names never cropped, lane / ticket / PR chips,
 * a short "Seen", and every shortened value available in full on hover AND on tap.
 *
 * The registry renders in two places: the server template (first paint) and the client SSE
 * re-render (every 3s). These functions are the ONE copy for both: dashboard.ts injects their
 * source into the client <script> with Function.prototype.toString. So each one must stay
 * self-contained — no imports, no module-level references except the other functions listed in
 * AGENT_CELL_HELPERS.
 *
 * `open` is the set of toggle keys the viewer has tapped open. The client keeps it across
 * re-renders; the server passes an empty set.
 */

export function cellEsc(s: any): string {
  return s == null ? "" : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** "just now", "4m ago", "3h ago", "2d ago" — or "never". */
export function relTime(iso: string | null | undefined, now: number): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (isNaN(t)) return String(iso);
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return "just now";
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + "m ago";
  if (s < 86400) return Math.round(s / 3600) + "h ago";
  return Math.round(s / 86400) + "d ago";
}

/**
 * Chips for an agent: lane serial and Linear ticket from the lane id
 * (`eng-<serial>-<ticket>-<slug>`, also with a `lane-` or `wallet-vault-` prefix), and for
 * ephemeral agents also ENG-N and GitHub PR links mentioned in the plan. Personas' plans are
 * shown in full under the row, so their chips come from the id only.
 */
export function agentTags(a: any): { label: string; href?: string; title: string }[] {
  const tags: { label: string; href?: string; title: string }[] = [];
  const seen: Record<string, boolean> = {};
  const add = (label: string, title: string, href?: string) => {
    if (seen[label]) return;
    seen[label] = true;
    tags.push(href ? { label, href, title } : { label, title });
  };
  const issue = (n: string, why: string) =>
    add("ENG-" + n, "Linear ENG-" + n + " (" + why + ")", "https://linear.app/fabrica/issue/ENG-" + n);
  const m = /(?:^|-)eng-(\d+)(?:-(\d{3,6}))?(?=-|$)/.exec(String(a.id || ""));
  if (m) {
    add("lane #" + m[1], "lane serial " + m[1]);
    if (m[2]) issue(m[2], "from the lane id");
  }
  if (!a.permanent && a.plan) {
    const plan = String(a.plan);
    const prRe = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
    let p: RegExpExecArray | null;
    while ((p = prRe.exec(plan)) && tags.length < 8) {
      add(p[2] + " #" + p[3], "GitHub " + p[1] + "/" + p[2] + " PR #" + p[3], "https://github.com/" + p[1] + "/" + p[2] + "/pull/" + p[3]);
    }
    const prBare = /\bPR ?#(\d+)\b/g;
    while ((p = prBare.exec(plan)) && tags.length < 8) {
      if (!tags.some((t) => / #\d+$/.test(t.label) && t.label.endsWith("#" + p![1]))) add("PR #" + p[1], "PR #" + p[1] + " (repo not named in the plan)");
    }
    const engRe = /\bENG-(\d+)\b/g;
    while ((p = engRe.exec(plan)) && tags.length < 8) issue(p[1], "from the plan");
  }
  return tags;
}

/** A value shown short, full on hover (title) and on tap (toggle key in `open`). */
export function tapFull(key: string, short: string, full: string, open: Record<string, boolean>): string {
  const isOpen = !!open[key];
  return '<span class="tapfull' + (isOpen ? " open" : "") + '" data-toggle="' + cellEsc(key) + '" title="' + cellEsc(full) + '">' +
    cellEsc(isOpen ? full : short) + "</span>";
}

/** The Agent cell: full display name (wraps, never crops), chips, and a tap-open detail block. */
export function agentNameCell(a: any, open: Record<string, boolean>): string {
  const key = "detail:" + a.id;
  const chips = agentTags(a).map((t) => t.href
    ? '<a class="chip" href="' + cellEsc(t.href) + '" target="_blank" rel="noopener" title="' + cellEsc(t.title) + '">' + cellEsc(t.label) + "</a>"
    : '<span class="chip" title="' + cellEsc(t.title) + '">' + cellEsc(t.label) + "</span>").join("");
  const fields: [string, any][] = [["id", a.id], ["display name", a.display_name], ["pubkey", a.pubkey], ["screen", a.screen_name], ["host", a.ssh_host], ["uid", a.run_as_uid], ["last seen", a.last_seen_at ? new Date(a.last_seen_at).toLocaleString() : "never"]];
  const detail = open[key]
    ? '<div class="agent-detail">' + fields.filter((f) => f[1] != null && f[1] !== "").map((f) =>
        '<div><span class="dim">' + f[0] + "</span> " +
        (f[0] === "id" || f[0] === "pubkey" ? '<span class="copyable" data-copy="' + cellEsc(f[1]) + '" title="Click to copy">' + cellEsc(f[1]) + "</span>" : cellEsc(f[1])) +
        "</div>").join("") + "</div>"
    : "";
  return '<span class="agent-label" data-toggle="' + cellEsc(key) + '" title="' + cellEsc(a.id) + ' (tap for details)">' + cellEsc(a.display_name || a.id) + "</span>" +
    (chips ? '<span class="chips">' + chips + "</span>" : "") + detail;
}

/** Source of every helper above, for injection into the client <script>. */
export const AGENT_CELL_HELPERS = [cellEsc, relTime, agentTags, tapFull, agentNameCell].map((f) => f.toString()).join("\n");

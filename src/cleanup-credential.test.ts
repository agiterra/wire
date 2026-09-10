import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { Store } from "./store";
import { runWebhookCleanup } from "./server";

// AGI-113 #2, part 2 — the cleanup must not be handed a credential that
// expired an hour ago.
//
// `secrets.github_token` is a GitHub App INSTALLATION token (~1 h life)
// captured at registration. Every cleanup that runs later than that 401s.
// The row now records HOW to re-mint (secrets_refresh: secret name → provider
// id); the gateway holds the provider argv in its own config, so a webhook
// row can name a minting capability but never carry one.

let srv: ReturnType<typeof Bun.serve>;
let base: string;
const FRESH = "ghs-fresh-token";

beforeAll(() => {
  srv = Bun.serve({
    port: 0,
    fetch(req) {
      // Only the freshly minted token gets to delete the hook.
      const ok = req.headers.get("authorization") === `Bearer ${FRESH}`;
      return new Response(ok ? null : "Bad credentials", { status: ok ? 204 : 401 });
    },
  });
  base = `http://localhost:${srv.port}`;
});
afterAll(() => srv.stop(true));

let tmpDir: string;
let store: Store;
let lines: Record<string, unknown>[];
let log: pino.Logger;
let prevProviders: string | undefined;

/** A stand-in for gh-app-token.sh: prints a token on stdout, nothing else. */
function mintScript(token: string): string {
  const p = join(tmpDir, "mint.sh");
  writeFileSync(p, `#!/bin/sh\nprintf '%s\\n' '${token}'\n`);
  chmodSync(p, 0o700);
  return p;
}

const CLEANUP = `
const res = await fetch(meta.api + "/repos/" + meta.repo + "/hooks/" + meta.github_hook_id, {
  method: "DELETE",
  headers: { Authorization: "Bearer " + secrets.github_token },
});
if (!res.ok && res.status !== 404) throw new Error("delete failed (" + res.status + ")");
`.trim();

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "wire-cred-"));
  store = new Store(join(tmpDir, "wire.db"));
  store.upsertAgent({ id: "papassinos", display_name: "papassinos", pubkey: "pk", permanent: false });
  lines = [];
  log = pino({ level: "trace" }, { write: (s: string) => { lines.push(JSON.parse(s)); } } as never);
  prevProviders = process.env.WIRE_SECRET_PROVIDERS;
});

afterEach(() => {
  if (prevProviders === undefined) delete process.env.WIRE_SECRET_PROVIDERS;
  else process.env.WIRE_SECRET_PROVIDERS = prevProviders;
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

function makeHook(opts: { refresh?: boolean } = {}) {
  const id = store.createWebhook({
    agentId: "papassinos",
    plugin: "github",
    name: "wire-pr-1",
    cleanup: CLEANUP,
    // The token captured at registration — an hour stale by cleanup time.
    secretsMap: JSON.stringify({ github_token: "ghs-expired" }),
    secretsRefresh: opts.refresh ? JSON.stringify({ github_token: "gh-app-token" }) : undefined,
    meta: JSON.stringify({ repo: "agiterra/wire", github_hook_id: 676795468, api: base }),
  });
  return store.getWebhookById(id)!;
}

describe("AGI-113 #2 — cleanup runs with a freshly minted credential", () => {
  test("secrets_refresh round-trips on the row, and is null when undeclared", () => {
    expect(makeHook({ refresh: true }).secrets_refresh).toBe(JSON.stringify({ github_token: "gh-app-token" }));
    const plain = store.createWebhook({ agentId: "papassinos", plugin: "github", name: "wire-pr-2" });
    expect(store.getWebhookById(plain)!.secrets_refresh).toBeNull();
  });

  test("a declared secret is re-minted from the configured provider, so the cleanup succeeds", async () => {
    process.env.WIRE_SECRET_PROVIDERS = JSON.stringify({ "gh-app-token": ["/bin/sh", mintScript(FRESH)] });
    const ok = await runWebhookCleanup(makeHook({ refresh: true }), log, "webhook_janitor_cleanup");

    expect(ok).toBe(true);
    expect(lines.map((l) => l.event)).toContain("webhook_janitor_cleanup_ok");
    expect(lines.map((l) => l.event)).not.toContain("webhook_cleanup_orphan");
    // The minted value must never reach the log.
    expect(JSON.stringify(lines)).not.toContain(FRESH);
  });

  test("without a refresh declaration the stale token is used and the cleanup fails truthfully", async () => {
    const ok = await runWebhookCleanup(makeHook(), log, "webhook_janitor_cleanup");
    expect(ok).toBe(false);
    expect(lines.map((l) => l.event)).toContain("webhook_janitor_cleanup_error");
  });

  test("a failed cleanup emits one alarm line per orphaned hook, with repo + hook id", async () => {
    const ok = await runWebhookCleanup(makeHook(), log, "webhook_janitor_cleanup");
    expect(ok).toBe(false);
    const alarms = lines.filter((l) => l.event === "webhook_cleanup_orphan");
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({
      event: "webhook_cleanup_orphan",
      agent: "papassinos",
      plugin: "github",
      repo: "agiterra/wire",
      hook_id: 676795468,
    });
    expect(alarms[0].level).toBe(50); // pino error — alarm-shaped
  });

  test("an unknown or unconfigured provider id does not mint, does not crash, and is reported", async () => {
    process.env.WIRE_SECRET_PROVIDERS = JSON.stringify({ "some-other": ["/bin/echo", "x"] });
    const ok = await runWebhookCleanup(makeHook({ refresh: true }), log, "webhook_janitor_cleanup");
    expect(ok).toBe(false);
    expect(lines.map((l) => l.event)).toContain("webhook_secret_refresh_failed");
    expect(lines.map((l) => l.event)).toContain("webhook_cleanup_orphan");
  });

  test("a row may only name a provider, never carry one (argv comes from gateway config)", async () => {
    // The row asks for a provider that is spelled like a command. Without a
    // matching entry in WIRE_SECRET_PROVIDERS nothing is executed.
    const id = store.createWebhook({
      agentId: "papassinos", plugin: "github", name: "wire-pr-evil",
      cleanup: `if (secrets.github_token !== "ghs-expired") throw new Error("row minted its own secret");`,
      secretsMap: JSON.stringify({ github_token: "ghs-expired" }),
      secretsRefresh: JSON.stringify({ github_token: "/bin/sh -c 'touch /tmp/pwned'" }),
      meta: JSON.stringify({ repo: "agiterra/wire", github_hook_id: 1 }),
    });
    const ok = await runWebhookCleanup(store.getWebhookById(id)!, log, "webhook_cleanup");
    expect(ok).toBe(true);
  });
});

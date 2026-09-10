/**
 * Secret providers — re-mint a short-lived credential just before a webhook's
 * cleanup runs.  (AGI-113 #2.)
 *
 * The problem: a webhook row stores `secrets.github_token`, a GitHub App
 * INSTALLATION token captured when the hook was registered. Those live about
 * an hour. A cleanup that runs on the reaper's or the janitor's schedule runs
 * hours later, 401s, and leaves a live GitHub hook behind while the row that
 * knew about it is deleted.
 *
 * The shape of the fix:
 *   - the webhook ROW records only WHICH provider re-mints a secret
 *     (`secrets_refresh` = {"github_token":"gh-app-token"});
 *   - the gateway's OWN config records what that provider is
 *     (`WIRE_SECRET_PROVIDERS` = {"gh-app-token":["/path/to/gh-app-token.sh"]}).
 *
 * Trade-off, deliberately taken: a registering agent cannot introduce a
 * command for the gateway to run — an unknown provider id mints nothing and
 * is reported. The cost is that refresh only works for providers an operator
 * has configured; with `WIRE_SECRET_PROVIDERS` unset, every row behaves
 * exactly as it does today (stored secret, stale token, truthful failure).
 *
 * The provider contract is the one gh-app-token.sh already implements: exit 0
 * and print the credential, and only the credential, on stdout.
 */

import { execFile } from "child_process";

/** provider id → argv. Empty when nothing is configured. */
export type ProviderMap = Record<string, string[]>;

/** Longest a provider may take before we give up and use the stored secret. */
export const PROVIDER_TIMEOUT_MS = 15_000;

/**
 * Parse WIRE_SECRET_PROVIDERS. Malformed config is treated as "no providers"
 * rather than a boot failure: a typo here must not stop the broker, and the
 * no-provider path is the current, working behavior.
 */
export function loadSecretProviders(env: Record<string, string | undefined> = process.env): ProviderMap {
  const raw = (env.WIRE_SECRET_PROVIDERS ?? "").trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: ProviderMap = {};
  for (const [id, argv] of Object.entries(parsed as Record<string, unknown>)) {
    if (Array.isArray(argv) && argv.length > 0 && argv.every((a) => typeof a === "string")) {
      out[id] = argv as string[];
    }
  }
  return out;
}

/**
 * Run a provider and return its stdout, trimmed. Rejects on non-zero exit,
 * timeout, or empty output. The value is never logged here or by the caller.
 */
export function mintSecret(argv: string[], timeoutMs = PROVIDER_TIMEOUT_MS): Promise<string> {
  const [cmd, ...args] = argv;
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        // stderr, not stdout — stdout is the credential.
        reject(new Error(`secret provider failed: ${String(stderr).trim() || err.message}`));
        return;
      }
      const value = String(stdout).trim();
      if (!value) {
        reject(new Error("secret provider produced no output"));
        return;
      }
      resolve(value);
    });
  });
}

export type RefreshResult = {
  /** The secrets to hand the cleanup: stored values, with refreshed ones replacing them. */
  secrets: Record<string, string>;
  /** Secret names that were successfully re-minted. */
  refreshed: string[];
  /** Secret names that were declared refreshable but could not be re-minted, with why. */
  failed: { name: string; provider: string; reason: string }[];
};

/**
 * Apply a row's `secrets_refresh` declaration to its stored secrets.
 *
 * Never throws: a provider that is missing, unconfigured, or broken leaves the
 * stored (probably stale) secret in place and is reported in `failed`, so the
 * caller can still attempt the cleanup and tell the truth about the outcome.
 */
export async function refreshSecrets(
  stored: Record<string, string>,
  declaration: string | null,
  providers: ProviderMap,
): Promise<RefreshResult> {
  const result: RefreshResult = { secrets: { ...stored }, refreshed: [], failed: [] };
  if (!declaration) return result;

  let spec: Record<string, unknown>;
  try {
    const parsed = JSON.parse(declaration);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    spec = parsed as Record<string, unknown>;
  } catch (e) {
    result.failed.push({ name: "*", provider: "?", reason: `unparseable secrets_refresh: ${String(e)}` });
    return result;
  }

  for (const [name, providerId] of Object.entries(spec)) {
    if (typeof providerId !== "string") {
      result.failed.push({ name, provider: String(providerId), reason: "provider id is not a string" });
      continue;
    }
    const argv = providers[providerId];
    if (!argv) {
      // The row named something the gateway does not offer. This is the
      // fail-closed case, and the one a row could try to abuse.
      result.failed.push({ name, provider: providerId, reason: "no such secret provider configured" });
      continue;
    }
    try {
      result.secrets[name] = await mintSecret(argv);
      result.refreshed.push(name);
    } catch (e) {
      result.failed.push({ name, provider: providerId, reason: String(e instanceof Error ? e.message : e) });
    }
  }
  return result;
}

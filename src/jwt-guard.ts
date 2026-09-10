/**
 * AGI-30 — JWT freshness + replay guard, and credential-header redaction.
 *
 * Split out of server.ts so the policy is unit-testable on its own and so the
 * replay cache has exactly one owner. verifyJwt() keeps the signature and
 * body_hash checks it already had — those stay as defence in depth; nothing
 * here weakens them.
 *
 * ROLLOUT SHAPE (why this is env-gated): a server-side freshness check rejects
 * every client that does not mint `exp`/`iat` inside the window, and TODAY not
 * one minter on the fleet sends `exp` or `jti` (they all send iss/iat/body_hash).
 * So the default mode is GRACE: measure, log, accept. Flip to `enforce` only
 * after the would-reject count has gone to zero.
 *
 *   WIRE_JWT_MODE            off | grace | enforce      (default: grace)
 *   WIRE_JWT_MAX_AGE_SEC     freshness window, seconds  (default: 300)
 *   WIRE_JWT_CLOCK_SKEW_SEC  future-iat tolerance       (default: 60)
 *   WIRE_JWT_EXP_LEEWAY_SEC  past-exp tolerance         (default: 5)
 *   WIRE_JWT_REPLAY_MAX      replay cache entry cap     (default: 20000)
 *   WIRE_JWT_REPLAY_NOJTI    1|0 — use the (iss, signature) fallback key
 *                            when a token carries no jti (default: 1)
 */

export type JwtMode = "off" | "grace" | "enforce";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function jwtMode(): JwtMode {
  const raw = (process.env.WIRE_JWT_MODE ?? "grace").toLowerCase();
  return raw === "off" || raw === "enforce" ? raw : "grace";
}

export const jwtMaxAgeSec = () => envInt("WIRE_JWT_MAX_AGE_SEC", 300);
export const jwtClockSkewSec = () => envInt("WIRE_JWT_CLOCK_SKEW_SEC", 60);
export const jwtExpLeewaySec = () => envInt("WIRE_JWT_EXP_LEEWAY_SEC", 5);
const replayMax = () => envInt("WIRE_JWT_REPLAY_MAX", 20_000);
const replayNoJti = () => (process.env.WIRE_JWT_REPLAY_NOJTI ?? "1") !== "0";

// --- freshness ---

/**
 * Is this token fresh enough to use? Returns a human reason on failure, null on pass.
 *
 * `exp` wins when present; `iat` + max-age is the fallback the ticket asked for.
 * A token with NEITHER cannot be shown fresh and is a would-reject: that is the
 * whole replay-forever hole, so it must not silently pass once enforcing.
 */
export function checkFreshness(
  claims: Record<string, unknown>,
  nowSec: number = Math.floor(Date.now() / 1000),
): string | null {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const iat = num(claims.iat);
  const exp = num(claims.exp);
  const maxAge = jwtMaxAgeSec();
  const skew = jwtClockSkewSec();

  if (exp === null && iat === null) {
    return "no iat and no exp claim; token freshness cannot be established";
  }
  if (exp !== null) {
    if (exp < nowSec - jwtExpLeewaySec()) {
      return `token expired ${nowSec - exp}s ago (exp=${exp})`;
    }
    // A client is free to choose its TTL, but not an unbounded one — an exp a
    // year out is the same replay-forever hole wearing an exp claim.
    if (exp - nowSec > maxAge + skew) {
      return `exp is ${exp - nowSec}s in the future, over the ${maxAge}s max TTL`;
    }
  }
  if (iat !== null) {
    if (iat - nowSec > skew) {
      return `iat is ${iat - nowSec}s in the future (skew allowance ${skew}s)`;
    }
    if (exp === null && nowSec - iat > maxAge) {
      return `token is stale: iat is ${nowSec - iat}s old, max age ${maxAge}s`;
    }
  }
  return null;
}

// --- replay cache ---

/**
 * Bounded TTL cache of tokens already spent. Insertion-ordered Map, so the
 * over-cap eviction is "drop the oldest inserted" — expired entries are swept
 * first, and only a burst of still-live tokens can force a live eviction.
 *
 * Bounded on purpose: an unbounded seen-set is a memory DoS an attacker drives
 * by minting jtis, and this process is long-lived.
 */
const seen = new Map<string, number>(); // key -> expiry epoch ms

export function replayCacheSize(): number {
  return seen.size;
}

export function resetReplayCache(): void {
  seen.clear();
}

function sweep(nowMs: number): void {
  for (const [k, expiry] of seen) {
    if (expiry <= nowMs) seen.delete(k);
    else break; // insertion order tracks expiry order; the rest are still live
  }
}

/**
 * Record this token as spent. Returns a reason if it had already been spent.
 *
 * Key is (iss, jti). With no jti we fall back to (iss, signature): an identical
 * signature IS the identical token, which is precisely the replay body_hash
 * cannot stop.
 *
 * CAVEAT, and the reason clients ship jti FIRST: two legitimately-minted
 * no-jti tokens are byte-identical when the same issuer signs the same body in
 * the same second (iat has 1s granularity) — e.g. two empty-body calls in a
 * tight loop. Those collide on the fallback key and read as replays. Grace mode
 * exists to measure exactly that before it can reject anything; set
 * WIRE_JWT_REPLAY_NOJTI=0 to disable the fallback if the measurement shows it.
 */
export function checkAndRecordReplay(
  iss: string,
  claims: Record<string, unknown>,
  signatureB64: string,
  nowMs: number = Date.now(),
): string | null {
  const jti = typeof claims.jti === "string" && claims.jti.length > 0 ? claims.jti : null;
  if (!jti && !replayNoJti()) return null;

  const key = jti ? `jti ${iss} ${jti}` : `sig ${iss} ${signatureB64}`;
  const nowSec = Math.floor(nowMs / 1000);
  const exp = typeof claims.exp === "number" && Number.isFinite(claims.exp) ? claims.exp : null;
  // Hold the entry until the token could no longer be fresh anyway. Beyond that
  // point the freshness check rejects it and the cache entry is dead weight.
  const holdUntilSec = (exp ?? nowSec + jwtMaxAgeSec()) + jwtClockSkewSec() + jwtExpLeewaySec();

  const prior = seen.get(key);
  if (prior !== undefined && prior > nowMs) {
    return jti
      ? `replay: jti '${jti}' from '${iss}' was already spent`
      : `replay: this exact signature from '${iss}' was already spent (token carries no jti)`;
  }

  sweep(nowMs);
  const max = replayMax();
  if (seen.size >= max) {
    const overBy = seen.size - max + 1;
    let dropped = 0;
    for (const k of seen.keys()) {
      seen.delete(k);
      if (++dropped >= overBy) break;
    }
  }
  seen.delete(key); // re-insert so insertion order tracks expiry order
  seen.set(key, holdUntilSec * 1000);
  return null;
}

// --- credential-header redaction ---

/**
 * Header names that carry a credential and must never ride an envelope out to
 * recipients, subscribers, peers or the messages table.
 *
 * `authorization` is the AGI-30 headline: the sender's Bearer was reaching
 * every recipient and every broadcast subscriber verbatim, and landing in
 * messages.payload. The rest are the same class of mistake waiting to happen —
 * a webhook's HMAC signature is a replayable credential over the same body.
 */
export const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-wire-token",
  "x-slack-signature",
  "x-gitlab-token",
  "x-webhook-secret",
]);

/** Prefix matches, for families like x-hub-signature / x-hub-signature-256. */
export const CREDENTIAL_HEADER_PREFIXES: readonly string[] = [
  "x-hub-signature",
  "x-amz-security-token",
];

export function isCredentialHeader(name: string): boolean {
  const k = name.toLowerCase();
  if (CREDENTIAL_HEADERS.has(k)) return true;
  return CREDENTIAL_HEADER_PREFIXES.some((p) => k.startsWith(p));
}

/**
 * Copy of `headers` with every credential header dropped.
 *
 * DROPPED, not blanked: an `"authorization": "[redacted]"` key invites a
 * recipient to code against a field that is never usable. Non-credential
 * headers survive untouched — receivers do read x-github-event, content-type
 * and the user-agent.
 *
 * Call this at envelope construction, i.e. AFTER validators, filters and dedup
 * have run: a GitHub validator needs the real x-hub-signature-256 to do its job.
 */
export function redactCredentialHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!isCredentialHeader(k)) out[k] = v;
  }
  return out;
}

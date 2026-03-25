/**
 * WebAuthn / Passkey authentication for the Wire dashboard.
 *
 * First-claim ownership: first operator to register owns the instance.
 * Invite links for additional operators.
 * Sessions persisted in SQLite — survive restarts.
 */

import type { Store } from "./store.js";

const SESSION_COOKIE = "wire_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export function getOperatorFromSession(cookie: string | undefined, store: Store): string | null {
  if (!cookie) return null;
  const token = cookie.split(";").find((c) => c.trim().startsWith(SESSION_COOKIE + "="));
  if (!token) return null;
  const sessionId = token.split("=")[1]?.trim();
  if (!sessionId) return null;
  const session = store.getOperatorSession(sessionId);
  return session?.operator_id ?? null;
}

export function createSession(operatorId: string, store: Store): { sessionId: string; cookie: string } {
  const sessionId = store.createOperatorSession(operatorId, SESSION_TTL_MS);
  return {
    sessionId,
    cookie: `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`,
  };
}

// --- WebAuthn helpers ---

export function getRpId(): string {
  return process.env.WIRE_RP_ID ?? "localhost";
}

export function getRpName(): string {
  return "The Wire";
}

export function generateRegistrationOptions(store: Store, operatorId: string, displayName: string) {
  const challenge = crypto.randomUUID() + crypto.randomUUID();
  const challengeB64 = Buffer.from(challenge).toString("base64url");
  store.storeChallenge(challengeB64);

  return {
    challenge: challengeB64,
    rp: { id: getRpId(), name: getRpName() },
    user: {
      id: Buffer.from(operatorId).toString("base64url"),
      name: displayName,
      displayName,
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },
      { type: "public-key", alg: -257 },
    ],
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      residentKey: "preferred",
      userVerification: "preferred",
    },
    timeout: 60000,
  };
}

export function generateAuthenticationOptions(store: Store) {
  const challenge = crypto.randomUUID() + crypto.randomUUID();
  const challengeB64 = Buffer.from(challenge).toString("base64url");
  store.storeChallenge(challengeB64);

  return {
    challenge: challengeB64,
    rpId: getRpId(),
    timeout: 60000,
    userVerification: "preferred",
  };
}

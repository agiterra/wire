/**
 * WebAuthn / Passkey authentication for the Exchange dashboard.
 *
 * First-claim ownership: first operator to register owns the instance.
 * Invite links for additional operators.
 * Uses Web Authentication API (passkeys / Touch ID / Face ID).
 */

import type { Store } from "./store.js";

const SESSION_COOKIE = "exchange_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// In-memory session store (lightweight — restarts clear sessions, passkeys persist)
const sessions = new Map<string, { operatorId: string; expiresAt: number }>();

export function getOperatorFromSession(cookie: string | undefined): string | null {
  if (!cookie) return null;
  const token = cookie.split(";").find((c) => c.trim().startsWith(SESSION_COOKIE + "="));
  if (!token) return null;
  const sessionId = token.split("=")[1]?.trim();
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session.operatorId;
}

export function createSession(operatorId: string): { sessionId: string; cookie: string } {
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { operatorId, expiresAt: Date.now() + SESSION_TTL_MS });
  return {
    sessionId,
    cookie: `${SESSION_COOKIE}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`,
  };
}

// --- WebAuthn helpers ---

export function getRpId(): string {
  return process.env.EXCHANGE_RP_ID ?? "localhost";
}

export function getRpName(): string {
  return "The Exchange";
}

/**
 * Generate a registration challenge for a new passkey.
 */
export function generateRegistrationOptions(store: Store, operatorId: string, displayName: string) {
  const challenge = crypto.randomUUID() + crypto.randomUUID();
  const challengeB64 = Buffer.from(challenge).toString("base64url");

  // Store challenge for verification
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
      { type: "public-key", alg: -7 },   // ES256
      { type: "public-key", alg: -257 },  // RS256
    ],
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      residentKey: "preferred",
      userVerification: "preferred",
    },
    timeout: 60000,
  };
}

/**
 * Generate an authentication challenge for login.
 */
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

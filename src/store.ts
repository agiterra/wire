/**
 * SQLite Store — the center of gravity.
 *
 * Every message gets a monotonic sequence number on write.
 * Each consumer has its own cursor (last_ack_seq on agent_sessions).
 * Replay is WHERE seq > last_ack_seq ORDER BY seq ASC.
 */

import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at  INTEGER NOT NULL,
    source      TEXT NOT NULL,
    source_id   TEXT,
    dest        TEXT,
    topic       TEXT NOT NULL,
    payload     TEXT NOT NULL,
    raw         TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic);
CREATE INDEX IF NOT EXISTS idx_messages_source_id ON messages(source, source_id);

CREATE TABLE IF NOT EXISTS agents (
    id              TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    pubkey          TEXT NOT NULL,
    created_at      INTEGER NOT NULL,
    last_seen_at    INTEGER,
    plan            TEXT
);

CREATE TABLE IF NOT EXISTS agent_sessions (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT NOT NULL REFERENCES agents(id),
    runtime         TEXT NOT NULL,
    channel_url     TEXT,
    connected_at    INTEGER,
    disconnected_at INTEGER,
    last_ack_seq    INTEGER NOT NULL DEFAULT 0,
    updated_at      INTEGER NOT NULL,
    last_heartbeat  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_agent ON agent_sessions(agent_id);

CREATE TABLE IF NOT EXISTS subscriptions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    topic       TEXT NOT NULL,
    filter      TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE(agent_id, topic)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_agent ON subscriptions(agent_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_topic ON subscriptions(topic);

CREATE TABLE IF NOT EXISTS delivery_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    message_seq INTEGER NOT NULL,
    agent_id    TEXT NOT NULL,
    attempted_at INTEGER NOT NULL,
    result      TEXT NOT NULL,
    error       TEXT
);
CREATE INDEX IF NOT EXISTS idx_delivery_log_message ON delivery_log(message_seq);
CREATE INDEX IF NOT EXISTS idx_delivery_log_agent ON delivery_log(agent_id, attempted_at);

CREATE TABLE IF NOT EXISTS webhooks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id    TEXT NOT NULL REFERENCES agents(id),
    plugin      TEXT NOT NULL,
    validator   TEXT,
    secrets_map TEXT,
    created_at  INTEGER NOT NULL,
    UNIQUE(agent_id, plugin)
);
CREATE INDEX IF NOT EXISTS idx_webhooks_agent ON webhooks(agent_id);

CREATE TABLE IF NOT EXISTS operators (
    id              TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    role            TEXT NOT NULL DEFAULT 'member',
    token           TEXT NOT NULL UNIQUE,
    created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS invites (
    code            TEXT PRIMARY KEY,
    created_by      TEXT NOT NULL REFERENCES operators(id),
    label           TEXT,
    used_by         TEXT REFERENCES operators(id),
    created_at      INTEGER NOT NULL,
    used_at         INTEGER
);

CREATE TABLE IF NOT EXISTS passkey_credentials (
    credential_id   TEXT PRIMARY KEY,
    operator_id     TEXT NOT NULL REFERENCES operators(id),
    public_key      BLOB NOT NULL,
    counter         INTEGER NOT NULL DEFAULT 0,
    transports      TEXT,
    created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS challenges (
    id              TEXT PRIMARY KEY,
    challenge       TEXT NOT NULL,
    created_at      INTEGER NOT NULL
);
`;

export type Message = {
  seq: number;
  created_at: number;
  source: string;
  source_id: string | null;
  dest: string | null;
  topic: string;
  payload: string;
  raw: string | null;
};

export type Agent = {
  id: string;
  display_name: string;
  pubkey: string;
  created_at: number;
  last_seen_at: number | null;
  plan: string | null;
};

export type AgentSession = {
  id: string;
  agent_id: string;
  runtime: string;
  channel_url: string | null;
  connected_at: number | null;
  disconnected_at: number | null;
  last_ack_seq: number;
  updated_at: number;
  last_heartbeat: number | null;
};

export type Webhook = {
  id: number;
  agent_id: string;
  plugin: string;
  validator: string | null;
  secrets_map: string | null;
  created_at: number;
};

export type Subscription = {
  id: number;
  agent_id: string;
  topic: string;
  filter: string | null;
  created_at: number;
};

export class Store {
  private db: Database;

  constructor(dbPath?: string) {
    const path = dbPath ?? process.env.EXCHANGE_DB ?? `${process.env.HOME}/.exchange/exchange.db`;
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode=WAL;");
    this.db.exec("PRAGMA foreign_keys=ON;");
    this.db.exec(SCHEMA);
  }

  // --- Messages ---

  writeMessage(msg: {
    source: string;
    source_id?: string;
    dest?: string;
    topic: string;
    payload: string;
    raw?: string;
  }): Message {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO messages (created_at, source, source_id, dest, topic, payload, raw)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(now, msg.source, msg.source_id ?? null, msg.dest ?? null, msg.topic, msg.payload, msg.raw ?? null);
    const seq = this.db.prepare("SELECT last_insert_rowid() as seq").get() as { seq: number };
    return {
      seq: seq.seq,
      created_at: now,
      source: msg.source,
      source_id: msg.source_id ?? null,
      dest: msg.dest ?? null,
      topic: msg.topic,
      payload: msg.payload,
      raw: msg.raw ?? null,
    };
  }

  getMessages(sinceSeq: number, limit = 100): Message[] {
    return this.db.prepare(
      "SELECT * FROM messages WHERE seq > ? ORDER BY seq ASC LIMIT ?"
    ).all(sinceSeq, limit) as Message[];
  }

  getMessagesForAgent(agentId: string, sinceSeq: number, limit = 100): Message[] {
    return this.db.prepare(
      "SELECT * FROM messages WHERE seq > ? AND (dest IS NULL OR dest = ?) ORDER BY seq ASC LIMIT ?"
    ).all(sinceSeq, agentId, limit) as Message[];
  }

  // --- Agents ---

  getAgent(id: string): Agent | null {
    return (this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Agent) ?? null;
  }

  getAllAgents(): Agent[] {
    return this.db.prepare("SELECT * FROM agents").all() as Agent[];
  }

  upsertAgent(agent: { id: string; display_name: string; pubkey: string }): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO agents (id, display_name, pubkey, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        pubkey = excluded.pubkey,
        last_seen_at = excluded.last_seen_at
    `).run(agent.id, agent.display_name, agent.pubkey, now, now);
  }

  touchAgent(id: string): void {
    this.db.prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?").run(Date.now(), id);
  }

  getAgentPlan(id: string): string | null {
    const row = this.db.prepare("SELECT plan FROM agents WHERE id = ?").get(id) as { plan: string | null } | null;
    return row?.plan ?? null;
  }

  setAgentPlan(id: string, plan: string): void {
    this.db.prepare("UPDATE agents SET plan = ? WHERE id = ?").run(plan, id);
  }

  // --- Sessions ---

  createSession(agentId: string, runtime = "claude-code"): AgentSession {
    const id = crypto.randomUUID();
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO agent_sessions (id, agent_id, runtime, connected_at, last_ack_seq, updated_at, last_heartbeat)
      VALUES (?, ?, ?, ?, (SELECT COALESCE(MAX(last_ack_seq), 0) FROM agent_sessions WHERE agent_id = ?), ?, ?)
    `).run(id, agentId, runtime, now, agentId, now, now);
    return this.getSession(id)!;
  }

  getSession(id: string): AgentSession | null {
    return (this.db.prepare("SELECT * FROM agent_sessions WHERE id = ?").get(id) as AgentSession) ?? null;
  }

  getActiveSessions(agentId: string): AgentSession[] {
    return this.db.prepare(
      "SELECT * FROM agent_sessions WHERE agent_id = ? AND disconnected_at IS NULL"
    ).all(agentId) as AgentSession[];
  }

  disconnectSession(id: string): void {
    this.db.prepare(
      "UPDATE agent_sessions SET disconnected_at = ?, updated_at = ? WHERE id = ?"
    ).run(Date.now(), Date.now(), id);
  }

  ackSession(sessionId: string, seq: number): void {
    this.db.prepare(
      "UPDATE agent_sessions SET last_ack_seq = MAX(last_ack_seq, ?), updated_at = ? WHERE id = ?"
    ).run(seq, Date.now(), sessionId);
  }

  heartbeatSession(sessionId: string): void {
    this.db.prepare(
      "UPDATE agent_sessions SET last_heartbeat = ?, updated_at = ? WHERE id = ?"
    ).run(Date.now(), Date.now(), sessionId);
  }

  // Reaper: disconnect sessions with stale heartbeats
  reapStaleSessions(ttlMs: number): number {
    const cutoff = Date.now() - ttlMs;
    const result = this.db.prepare(`
      UPDATE agent_sessions
      SET disconnected_at = ?, updated_at = ?
      WHERE disconnected_at IS NULL AND last_heartbeat IS NOT NULL AND last_heartbeat < ?
    `).run(Date.now(), Date.now(), cutoff);
    return result.changes;
  }

  // --- Subscriptions ---

  getSubscriptions(agentId: string): Subscription[] {
    return this.db.prepare(
      "SELECT * FROM subscriptions WHERE agent_id = ?"
    ).all(agentId) as Subscription[];
  }

  getAllSubscriptions(): Subscription[] {
    return this.db.prepare("SELECT * FROM subscriptions").all() as Subscription[];
  }

  setSubscriptions(agentId: string, topics: { topic: string; filter?: string }[]): void {
    const now = Date.now();
    this.db.prepare("DELETE FROM subscriptions WHERE agent_id = ?").run(agentId);
    const stmt = this.db.prepare(
      "INSERT INTO subscriptions (agent_id, topic, filter, created_at) VALUES (?, ?, ?, ?)"
    );
    for (const sub of topics) {
      stmt.run(agentId, sub.topic, sub.filter ?? null, now);
    }
  }

  // --- Webhooks ---

  getWebhook(agentId: string, plugin: string): Webhook | null {
    return (this.db.prepare(
      "SELECT * FROM webhooks WHERE agent_id = ? AND plugin = ?"
    ).get(agentId, plugin) as Webhook) ?? null;
  }

  upsertWebhook(agentId: string, plugin: string, validator?: string, secretsMap?: string): void {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO webhooks (agent_id, plugin, validator, secrets_map, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(agent_id, plugin) DO UPDATE SET
        validator = excluded.validator,
        secrets_map = excluded.secrets_map
    `).run(agentId, plugin, validator ?? null, secretsMap ?? null, now);
  }

  // --- Recent messages (temporal context) ---

  getRecentMessages(agentId: string, sinceTsMs: number, limit = 100): Message[] {
    return this.db.prepare(
      "SELECT * FROM messages WHERE created_at > ? AND (dest IS NULL OR dest = ?) ORDER BY created_at DESC LIMIT ?"
    ).all(sinceTsMs, agentId, limit) as Message[];
  }

  // --- Delivery log ---

  logDelivery(messageSeq: number, agentId: string, result: string, error?: string): void {
    this.db.prepare(
      "INSERT INTO delivery_log (message_seq, agent_id, attempted_at, result, error) VALUES (?, ?, ?, ?, ?)"
    ).run(messageSeq, agentId, Date.now(), result, error ?? null);
  }

  // --- Operators ---

  getOperator(id: string): { id: string; display_name: string; role: string; token: string } | null {
    return this.db.prepare("SELECT * FROM operators WHERE id = ?").get(id) as any ?? null;
  }

  getOperatorByToken(token: string): { id: string; display_name: string; role: string } | null {
    return this.db.prepare("SELECT id, display_name, role FROM operators WHERE token = ?").get(token) as any ?? null;
  }

  hasOwner(): boolean {
    return !!(this.db.prepare("SELECT 1 FROM operators WHERE role = 'owner' LIMIT 1").get());
  }

  createOperator(id: string, displayName: string, role: string, token: string): void {
    this.db.prepare(
      "INSERT INTO operators (id, display_name, role, token, created_at) VALUES (?, ?, ?, ?, ?)"
    ).run(id, displayName, role, token, Date.now());
  }

  // --- Passkey Credentials ---

  getCredential(credentialId: string): { credential_id: string; operator_id: string; public_key: Buffer; counter: number } | null {
    return this.db.prepare("SELECT * FROM passkey_credentials WHERE credential_id = ?").get(credentialId) as any ?? null;
  }

  getCredentialsByOperator(operatorId: string): { credential_id: string; public_key: Buffer; counter: number }[] {
    return this.db.prepare("SELECT * FROM passkey_credentials WHERE operator_id = ?").all(operatorId) as any[];
  }

  getAllCredentials(): { credential_id: string; operator_id: string; public_key: Buffer; counter: number }[] {
    return this.db.prepare("SELECT * FROM passkey_credentials").all() as any[];
  }

  upsertCredential(credentialId: string, operatorId: string, publicKey: Buffer, counter: number, transports?: string): void {
    this.db.prepare(`
      INSERT INTO passkey_credentials (credential_id, operator_id, public_key, counter, transports, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(credential_id) DO UPDATE SET counter = excluded.counter
    `).run(credentialId, operatorId, publicKey, counter, transports ?? null, Date.now());
  }

  updateCredentialCounter(credentialId: string, counter: number): void {
    this.db.prepare("UPDATE passkey_credentials SET counter = ? WHERE credential_id = ?").run(counter, credentialId);
  }

  // --- Challenges ---

  storeChallenge(challenge: string): void {
    this.db.prepare("INSERT INTO challenges (id, challenge, created_at) VALUES (?, ?, ?)").run(
      crypto.randomUUID(), challenge, Date.now()
    );
    // Clean up old challenges (> 5 min)
    this.db.prepare("DELETE FROM challenges WHERE created_at < ?").run(Date.now() - 300_000);
  }

  consumeChallenge(challenge: string): boolean {
    const row = this.db.prepare("SELECT id FROM challenges WHERE challenge = ?").get(challenge);
    if (!row) return false;
    this.db.prepare("DELETE FROM challenges WHERE challenge = ?").run(challenge);
    return true;
  }

  // --- Invites ---

  createInvite(code: string, createdBy: string, label?: string): void {
    this.db.prepare(
      "INSERT INTO invites (code, created_by, label, created_at) VALUES (?, ?, ?, ?)"
    ).run(code, createdBy, label ?? null, Date.now());
  }

  consumeInvite(code: string, usedBy: string): boolean {
    const invite = this.db.prepare("SELECT * FROM invites WHERE code = ? AND used_by IS NULL").get(code);
    if (!invite) return false;
    this.db.prepare("UPDATE invites SET used_by = ?, used_at = ? WHERE code = ?").run(usedBy, Date.now(), code);
    return true;
  }

  close(): void {
    this.db.close();
  }
}

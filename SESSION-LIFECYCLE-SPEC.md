# Session Lifecycle Spec: Stale Detection, Reaping, and Delivery Receipts

**Replaces**: The current behavior in `POST /agents/connect` that disconnects all
prior sessions for an agent (server.ts L167-171). Remove that.

## Problem

Agent sessions become orphaned when clients crash without sending a disconnect.
The current fix (kill all sessions on new connect) breaks legitimate concurrent
sessions (e.g., an agent's main session + subagent sessions). We need detection
of dead sessions without destroying live ones.

## Session Lifecycle

```
connected ←→ stale (SSE socket closed)
                ↓ (20s TTL)
             reaped
                ↓ (reconnect with Last-Event-ID → resurrect, replay from seq)
             connected
```

### States

| State | Meaning | How entered |
|-------|---------|-------------|
| **connected** | SSE socket open, agent receiving events | `POST /agents/connect` or reconnect |
| **stale** | SSE socket closed, not yet reaped | `abort` event on SSE request signal |
| **reaped** | Assumed dead, session row kept for resurrection | 20s after entering stale with no reconnect |

### Transitions

1. **connected → stale**: Triggered by the SSE `abort` event (TCP close). This is
   immediate and reliable — no heartbeat polling needed. The `abort` listener
   already exists in `server.ts` L287-289; extend it to also mark the session
   stale in the store.

2. **stale → reaped**: A timer (20 seconds) fires after entering stale. If no
   reconnect has occurred, mark the session as reaped (`disconnected_at` set).
   Use `setTimeout` per session, or a periodic reaper sweep — implementer's choice.

3. **reaped → connected** (resurrection): A client reconnects with a
   `Last-Event-ID` header (SSE spec built-in) or a `?last_seq=N` query param.
   The Wire matches the seq to the reaped session's `last_ack_seq`, resurrects
   the session (clears `disconnected_at`, updates `connected_at`), and replays
   all messages with `seq > last_ack_seq`. Since messages are persisted in SQLite,
   replay always works regardless of how long the session was reaped.

4. **fresh connect (no Last-Event-ID)**: Creates a new session as today. Existing
   stale/reaped sessions for the same agent are left alone — they're separate
   logical sessions.

## Schema Changes

Add a `status` column to `agent_sessions`:

```sql
ALTER TABLE agent_sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'connected';
-- values: 'connected', 'stale', 'reaped'
```

The existing `disconnected_at` column is kept and set when a session is reaped
(for backwards compat with dashboard queries). `status` is the authoritative
lifecycle state.

## Dashboard

The `/agents` endpoint and dashboard should expose session counts per status:

```json
{
  "id": "herald",
  "online": true,
  "sessions": {
    "connected": 1,
    "stale": 0,
    "reaped": 2
  }
}
```

This replaces the current flat `"sessions": 1` count.

## Session-Targeted Messaging

### Sending to a specific session

The `dest` field on messages currently targets an agent ID. Extend it to
optionally target a specific session:

```json
{
  "topic": "ipc.task",
  "payload": { "result": "done" },
  "dest": "herald",
  "dest_session": "uuid-of-specific-session"
}
```

- If `dest_session` is provided, deliver only to that session's SSE writer.
- If the target session is reaped/stale, don't deliver — return status in receipt.
- The sender decides what to do (multicast to all sessions, wait, etc).

### Delivery Receipts

Every sent message gets a receipt in the response:

```json
{
  "seq": 148,
  "delivered_to": [
    { "agent": "herald", "session": "uuid-1", "status": "delivered" },
    { "agent": "herald", "session": "uuid-2", "status": "stale" }
  ]
}
```

If targeting a specific session that is reaped:

```json
{
  "seq": 149,
  "delivered_to": [
    { "agent": "herald", "session": "uuid-3", "status": "reaped" }
  ]
}
```

The sender gets enough information to decide: retry, multicast, or drop.

## What to Remove

- **`POST /agents/connect` lines 167-171**: The loop that disconnects all prior
  sessions. Replace with: just create the new session. Leave existing sessions
  in whatever state they're in.

- **Heartbeat endpoint** (`/agents/:id/sessions/:sid/heartbeat`): Can be kept
  for agents that want explicit keepalive, but it's no longer the primary
  liveness signal. SSE socket state is.

## Implementation Notes

- The SSE `abort` event (`c.req.raw.signal`) is the primary disconnect signal.
  When it fires, mark session stale immediately, start 20s reap timer.
- `Last-Event-ID` is sent automatically by compliant SSE clients on reconnect.
  The Wire should emit `id: {seq}` in SSE frames so clients track position.
- Current SSE frames are `data: ...` only — add `id: {seq}\n` before each
  `data:` line so `Last-Event-ID` works.
- The emitter currently keys on agent ID. Session-targeted delivery needs
  the emitter to also track session ID → writer mapping.
- Resurrection is just: find reaped session by agent + last_ack_seq match,
  flip status back to connected, attach new SSE writer, replay.

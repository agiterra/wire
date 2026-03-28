# wire-slack — Slack Events to Wire

## Context

Agents (Herald, Brioche) each have their own Slack bot. Each bot receives
webhooks from Slack with events (messages, mentions, reactions). Currently
these are handled by legacy el-slack plugins. This plan replaces them with
Wire-native webhook routing.

## Architecture

### Webhook Registration

Each agent registers their Slack webhook on the Wire:

```
POST /agents/herald/webhooks
{
  "type": "slack",
  "signing_secret": "<herald's slack bot signing secret>",
  "filter": "payload.event.channel === 'C0AF24L7YGZ' && !payload.event.bot_id"
}
```

- `type: "slack"` — selects the built-in Slack validator
- `signing_secret` — per-bot, stored by the Wire alongside the webhook
- `filter` — JS expression evaluated in a VM sandbox, determines if the
  event should be delivered to this agent

### Webhook Endpoint

Per-agent: `POST /webhooks/<agent-id>/slack`

Slack app configuration points each bot's Event Subscriptions URL here.

### Validation (Slack HMAC-SHA256)

Built-in `slack` validator type:

1. Extract `X-Slack-Signature` and `X-Slack-Request-Timestamp` from headers
2. Reject if timestamp is older than 5 minutes (replay protection)
3. Build `sig_basestring = "v0:{timestamp}:{raw_body}"`
4. HMAC-SHA256 with the agent's stored `signing_secret`
5. Compare `v0={hmac_hex}` against `X-Slack-Signature`

The Wire knows the HMAC recipe (same for all Slack bots). The per-agent
signing secret parameterizes it.

### Slack URL Verification

Slack sends a `url_verification` challenge on webhook setup:
```json
{ "type": "url_verification", "challenge": "abc123" }
```
Wire must respond with `{ "challenge": "abc123" }` immediately.
This happens before any filter or agent delivery.

### Filter Evaluation

**Default: firehose.** No filter means the agent gets everything the bot
has access to — all channels, all threads, all emojis, all reactions.
Just like a human user. The agent decides what to act on.

Filter is optional — only register one when you need to mute noise.
Filter runs in a VM sandbox (same as existing validator expressions).
Examples of narrowing:

- Mute a user: `payload.event.user !== 'U0AECTQSHQW'`
- Skip bots: `!payload.event.bot_id`
- One channel only: `payload.event.channel === 'C0AF24L7YGZ'`
- Mentions only: `payload.event.text?.includes('<@U0ADEDQDE9K>')`

### Enrichment (Agent-Provided)

Raw Slack events are minimal — a `message` event is just channel + ts + text.
Agents can register an enrichment function that hydrates the event before
delivery. The Wire runs enrichment after the filter passes, before delivery.

**Default enrichment for threaded @mentions:**
When a bot is mentioned in a thread reply, enrich with:
- Original channel message (the thread parent)
- Full thread history (all replies in order)
- Download URLs for any files/images in the thread
- User display names resolved from IDs

This gives the agent the full conversation context, not just the single
message that triggered the event.

**Implementation**: enrichment is a registered function (like filter) that
receives the raw payload and the agent's Slack bot token, and returns an
enriched payload. It calls the Slack API (conversations.replies,
conversations.history, users.info) to hydrate context.

```
POST /agents/herald/webhooks
{
  "type": "slack",
  "signing_secret": "...",
  "bot_token": "xoxb-...",
  "enrich": true
}
```

When `enrich: true`, the Wire runs the built-in Slack enrichment using the
agent's `bot_token`. Agents can also provide a custom enrichment expression
or disable it entirely.

### Delivery

If filter passes (and enrichment runs if configured), deliver as a Wire message:
- `source`: `"slack"`
- `dest`: agent ID
- `topic`: `"webhook.slack"`
- `payload`: the Slack event payload

Agent receives it via their Wire channel plugin (SSE push into Claude Code).

## Implementation

### Wire Server Changes

1. **Webhook registration endpoint**: `POST /agents/:id/webhooks` — stores
   type, signing_secret, filter in `webhooks` table
2. **Built-in Slack validator**: new validator type in validator registry
3. **Filter infrastructure**: VM sandbox for JS expression evaluation,
   runs after validation, per-agent
4. **URL verification handler**: respond to Slack challenges automatically

### No Separate Plugin

wire-slack is NOT a separate npm package or Claude Code plugin. It's:
- A built-in validator type in the Wire server
- Webhook registrations in the Wire DB
- Filter expressions stored per-agent

The Wire channel plugin (wire-claude-code) already delivers messages to
agents via SSE. No new delivery mechanism needed.

## Example: Accept All Except One User

Herald wants all messages from #agent-backchannel but needs to mute a
user who triggers too many bot loops:

```
POST /agents/herald/webhooks
{
  "type": "slack",
  "signing_secret": "4d8e1a890e3ac029...",
  "filter": "payload.event.channel === 'C0AF24L7YGZ' && payload.event.user !== 'U0AECTQSHQW'"
}
```

This is a denylist pattern — accept everything from the channel, exclude
one user by Slack user ID. The agent can make the filter as permissive or
restrictive as they want.

## Dependencies

- Wire server filter infrastructure (shared with wire-github)
- Webhook registration API (shared with wire-github)
- VM sandbox for filter expressions

## Testing

1. Register Herald's Slack webhook with signing secret and filter
2. Send a test payload with correct HMAC signature
3. Verify filter evaluation (matching and non-matching events)
4. Verify delivery to Herald's Wire session
5. Verify URL verification challenge response
6. Verify replay protection (old timestamps rejected)

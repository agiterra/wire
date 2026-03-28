# wire-github — GitHub Webhooks to Wire

## Context

Agents need GitHub events (PR opened, checks completed, review requested,
CodeRabbit comments). Currently handled by three legacy plugins:
el-github-mentions, el-pr-checks, el-coderabbit. This consolidates them
into Wire-native webhook routing.

## Architecture

### Webhook Registration

Each agent registers their own GitHub webhook, both on the Wire and on
GitHub itself. Per-agent because each agent may care about different repos
and event types.

**Wire side:**
```
POST /agents/waffles/webhooks
{
  "type": "github",
  "webhook_secret": "<random secret for HMAC verification>",
  "filter": "payload.pull_request?.number === 1458"
}
```

**GitHub side** (agent runs this at launch):
```bash
gh api repos/fabrica-land/fabrica-v3/hooks --method POST \
  -f url="https://the-wire.ngrok.io/webhooks/waffles/github" \
  -f content_type=json \
  -f secret="<same random secret>" \
  -f[] events=pull_request \
  -f[] events=check_run \
  -f[] events=pull_request_review
```

### Webhook Endpoint

Per-agent: `POST /webhooks/<agent-id>/github`

### Validation (GitHub HMAC-SHA256)

Built-in `github` validator type:

1. Extract `X-Hub-Signature-256` header
2. HMAC-SHA256 the raw body with the agent's stored `webhook_secret`
3. Compare `sha256={hmac_hex}` against the header
4. Also validate `X-GitHub-Event` header exists

### Filter Evaluation

Same VM sandbox as wire-slack. Examples:

- PR number: `payload.pull_request?.number === 1458`
- PR action: `payload.action === 'opened' || payload.action === 'synchronize'`
- Check status: `payload.check_run?.conclusion === 'failure'`
- Reviewer: `payload.requested_reviewer?.login === 'mividtim'`
- CodeRabbit: `payload.comment?.user?.login === 'coderabbitai'`
- Branch: `payload.pull_request?.head?.ref === 'feature/auth-rewrite'`

### Delivery

Wire message:
- `source`: `"github"`
- `dest`: agent ID
- `topic`: `"webhook.github"`
- `payload`: GitHub event payload
- Message metadata includes `X-GitHub-Event` header value (e.g. `pull_request`)

### Webhook Cleanup (Reconciler)

**Problem**: agents create GitHub webhooks at launch. If they crash or are
stopped without cleanup, webhooks are orphaned on GitHub.

**Solution**: Wire reconciler (Option 2 from design discussion):

1. Wire tracks all GitHub webhook registrations in its DB (agent ID,
   repo, GitHub hook ID)
2. When an agent is stopped/reaped, the Wire calls GitHub API to delete
   the hook: `gh api repos/{owner}/{repo}/hooks/{hook_id} --method DELETE`
3. Periodic reconciler: list all hooks for tracked repos, delete any
   pointing to dead agents
4. Requires: GitHub token with `admin:repo_hook` scope, stored in
   `~/.wire/.env` as `GITHUB_WEBHOOK_TOKEN`

**Agent lifecycle integration with Pane:**
- `agent_launch` → agent registers webhook on GitHub + Wire
- `agent_stop` → pane orchestrator triggers webhook cleanup
- Agent crash → Wire session reaper detects disconnect → cleanup

## Implementation

### Wire Server Changes

1. **Built-in GitHub validator**: HMAC-SHA256 with `X-Hub-Signature-256`
2. **Webhook DB table**: agent_id, type, secret, filter, metadata
   (repo, github_hook_id for cleanup)
3. **Webhook cleanup on agent disconnect**: hook into session reaper
4. **Periodic webhook reconciler**: list + delete orphaned hooks

### Shared with wire-slack

- Webhook registration API (`POST /agents/:id/webhooks`)
- Filter infrastructure (VM sandbox)
- Webhook routing (`POST /webhooks/:agent/:type`)

### Agent-Side

Agents need a way to register their GitHub webhook at launch. Options:
- Startup hook in Claude Code that runs `gh api` to create the webhook
- A Wire MCP tool: `webhook_register` that handles both Wire + GitHub
- Manual setup by operator (simplest for now)

## Example: Two PRs Across Repos in One Webhook

An engineer agent (Waffles) is working on ENG-1234 which spans soil-app
PR #42 and fabrica-v3-api PR #87. Single webhook registration with an
OR filter:

```bash
SECRET=$(openssl rand -hex 20)

# Register GitHub webhooks on both repos, same secret, same endpoint
gh api repos/fabrica-land/soil-app/hooks --method POST \
  -f url="https://the-wire.ngrok.io/webhooks/waffles/github" \
  -f content_type=json -f secret="$SECRET" \
  -f[] events=pull_request -f[] events=check_run -f[] events=pull_request_review

gh api repos/fabrica-land/fabrica-v3-api/hooks --method POST \
  -f url="https://the-wire.ngrok.io/webhooks/waffles/github" \
  -f content_type=json -f secret="$SECRET" \
  -f[] events=pull_request -f[] events=check_run -f[] events=pull_request_review

# Single Wire registration with OR filter covering both PRs
curl -X POST https://the-wire.ngrok.io/agents/waffles/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "type": "github",
    "webhook_secret": "'$SECRET'",
    "filter": "(payload.repository?.name === \"soil-app\" && payload.pull_request?.number === 42) || (payload.repository?.name === \"fabrica-v3-api\" && payload.pull_request?.number === 87)",
    "meta": { "repos": ["fabrica-land/soil-app", "fabrica-land/fabrica-v3-api"] }
  }'
```

One webhook registration, one filter, one secret. Both repos' GitHub
webhooks point to the same Wire endpoint. The filter is just a JS
expression — OR, AND, whatever the agent needs. The `meta.repos` array
tells the reconciler which GitHub repos to clean up.

## Dependencies

- Wire server filter infrastructure (shared with wire-slack)
- Webhook registration API (shared with wire-slack)
- GitHub token with admin:repo_hook scope
- Pane orchestrator lifecycle hooks (for cleanup on stop)

## Testing

1. Register a test webhook with HMAC secret
2. Send a test payload with correct GitHub HMAC signature
3. Verify filter evaluation
4. Verify delivery to agent's Wire session
5. Create a real GitHub webhook, trigger a PR event, verify end-to-end
6. Stop agent, verify webhook is cleaned up on GitHub
7. Test orphan reconciler with a manually created webhook

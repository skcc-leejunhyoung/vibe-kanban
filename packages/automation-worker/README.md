# Vibe Automation Worker

Standalone connector worker for lightweight automations. It runs as one Docker
container with a small web UI, JSON persistence, polling jobs, editable
JavaScript rules, and logs.

## Run

Rules execute as trusted JavaScript — `node:vm` is **not** a security sandbox —
so `ADMIN_TOKEN` is the access control. It is **required**: the worker refuses to
start without one (a tokenless server would let any local webpage create and run
a rule). Generate a token with e.g. `openssl rand -hex 32`. The token is accepted
only via the `Authorization: Bearer` header, never a query string.

```bash
docker build -f packages/automation-worker/Dockerfile -t vibe-automation-worker .
docker run --rm -p 8787:8787 \
  -e ADMIN_TOKEN="$(openssl rand -hex 32)" \
  -v vibe-automation-data:/data \
  vibe-automation-worker
```

Open `http://localhost:8787`, then enter the token in the header.

### Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `ADMIN_TOKEN` | _(required)_ | Token for the UI/API. The worker refuses to start without it. |
| `HOST` | `0.0.0.0` | Bind address. |
| `PORT` | `8787` | Listen port. |
| `RULE_TIMEOUT_MS` | `10000` | Max wall-clock per rule run. |

## Built-in Connectors

- `slack`: polls `conversations.history` for one channel.
- `github`: polls a repo's issues filtered to the authenticated user
  (`filter` = `assigned` | `created` | `mentioned`). A classic PAT with `repo`
  scope works. The first poll only seeds the `seenIds` set (no issues created)
  unless `backfill: true`; PRs are skipped unless `includePullRequests: true`.
  GitHub sub-issue links are resolved via GraphQL and mirrored to Vibe
  (`parent_issue_id`) when both parent and child are imported; the
  github→Vibe id map persists in the `vibe_kanban` connector's `issueMap`.
  Set `reviewPrs: true` to also import open, non-draft PRs where review is
  requested from the user (Search API); imported PRs are tagged `review` in Vibe
  (the tag is created in the project if missing) and their footer includes a
  `branch: <head> -> <base>` line (fetched via `GET /repos/.../pulls/{n}`).
- `vibe_kanban`: creates Vibe Kanban issues through HTTP.

The `vibe_kanban` connector posts to `{baseUrl}/v1/issues` on the **remote** API.
Remote access tokens are short-lived, so prefer `tokenUrl` over a static
`bearerToken`: point it at a Vibe Kanban server that mints fresh access tokens
(e.g. the local app's `http://host.docker.internal:<port>/api/auth/token`). The
worker caches each token until just before it expires and refreshes on a 401.

```json
{
  "baseUrl": "https://your-vibe-host",
  "tokenUrl": "http://host.docker.internal:8080/api/auth/token",
  "projectId": "<project uuid>",
  "statusId": "<status uuid>"
}
```

The default rule watches Slack messages like:

```text
#issue Title | Description
```

and creates a Vibe Kanban issue.

## Data

State is stored in `/data/state.json`. Logs are stored in `/data/logs.json`.
Secrets are stored in the same JSON file, so mount `/data` on a private volume.
The API masks credential fields (`token`, `bearerToken`, `authHeaderValue`) as
`__stored__` in responses; saving a connector with that placeholder keeps the
stored secret, so edit other fields freely without re-entering tokens.

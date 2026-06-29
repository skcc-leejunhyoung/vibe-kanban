# Vibe Automation Worker

Standalone connector worker for lightweight automations. It runs as one Docker
container with JSON persistence, polling jobs, editable JavaScript rules, and
logs. It has **no web UI of its own** — configure it from the Vibe Kanban
settings page (Settings → Automation), which the local Vibe Kanban server
proxies to this worker's `/api/*` routes.

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

The worker exposes an admin-token-gated JSON API on `:8787` (plus an
unauthenticated `GET /health` for orchestration). Drive it from the Vibe Kanban
settings page rather than calling the API directly.

### Environment

| Var | Default | Purpose |
| --- | --- | --- |
| `ADMIN_TOKEN` | _(required)_ | Token for the UI/API. The worker refuses to start without it. |
| `HOST` | `0.0.0.0` | Bind address. |
| `PORT` | `8787` | Listen port. |
| `RULE_TIMEOUT_MS` | `10000` | Max wall-clock per rule run. |
| `RETRY_MAX_ATTEMPTS` | `5` | Times a failed rule run (e.g. the Vibe issue create failed) is auto-retried before being marked `exhausted`. |
| `RETRY_BASE_DELAY_MS` | `60000` | First retry backoff; doubles each attempt. |
| `RETRY_MAX_DELAY_MS` | `3600000` | Cap on the retry backoff. |

## Retry Queue

A rule throwing (e.g. the source event was fetched fine, but creating the Vibe
issue failed) drops the event into a **retry queue** instead of losing it — the
source connector's cursor has already advanced past it, so without this the
miss would never be re-tried.

- Each poll cycle re-attempts that connector's due items with exponential
  backoff, up to `RETRY_MAX_ATTEMPTS`.
- After the cap an item is marked `exhausted` and left alone.
- The **Retries** tab (and `POST /api/retry-queue/process`) lets an operator
  force a run now. Send `{ "includeExhausted": true }` to also re-attempt the
  leftover misses that already hit the cap. `GET /api/retry-queue` lists items;
  `DELETE /api/retry-queue/<id>` discards one.

> Note: there is no idempotency key, so if a failure happened *after* the Vibe
> issue was actually created (response lost), a retry can create a duplicate.

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

## Vibe Kanban integration

The worker is built and shipped with the Vibe Kanban stack: it is a service in
`crates/remote/docker-compose.yml` under the `automation` profile, so the
menubar build/redeploy can bring it up alongside the remote stack
(`docker compose --profile automation …`).

Its settings UI lives in the Vibe Kanban app under **Settings → Automation**.
The local Vibe Kanban server reverse-proxies `/api/automation/*` to this worker,
injecting the admin token server-side, so the browser never holds the token and
the same UI works from the local and remote web apps. The proxy reads:

- `AUTOMATION_WORKER_URL` — worker base URL (default `http://127.0.0.1:8787`).
- `AUTOMATION_WORKER_TOKEN` — admin token to send (falls back to `ADMIN_TOKEN`).

The master on/off toggle on that settings page flips the worker's `enabled`
flag: when off, the worker stays up but installs no poll timers (it idles).

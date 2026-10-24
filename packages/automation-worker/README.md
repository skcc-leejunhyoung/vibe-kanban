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
  A GitHub Project sync rule normally imports only issues from the connector's
  repository. Enable `includeIssuesFromOtherRepositories` on the rule to import
  assigned issues from other repositories on the selected Project as well.
  Set `reviewPrs: true` to also import open, non-draft PRs where review is
  requested from the user (Search API); imported PRs are tagged `review` in Vibe
  (the tag is created in the project if missing) and their footer includes a
  `branch: <head> -> <base>` line (fetched via `GET /repos/.../pulls/{n}`).
  With `notifyPrComments` enabled (the default), it also watches PRs authored by,
  assigned to, awaiting review from, or previously reviewed by the authenticated
  user. New issue comments and inline review comments from other users create
  Vibe notifications. This includes issue comments, inline review comments, and
  non-empty submitted review bodies (for example APPROVED or CHANGES_REQUESTED
  reviews). The first poll seeds existing comments without notifying.
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

## Routines

Routines bind a schedule or Vibe event to one typed action. Schedule triggers
use either a one-time local timestamp plus an IANA timezone, or a five-field
cron expression plus an IANA timezone. Internal events are accepted at
`POST /api/events`; they also pass through the existing trusted Rules before
matching Routines.

Host actions (`start_workspace`, `send_prompt`, and `notification`) require an
explicit `targetHostId`. Configure that host under the Vibe connector's
`hostBridges` map. Project and repository allowlists are deny-by-default:

```json
{
  "hostBridges": {
    "<host uuid>": {
      "baseUrl": "http://host.docker.internal:47823",
      "projectIds": ["<project uuid>"],
      "repositoryIds": ["<repository uuid>"]
    }
  }
}
```

Workspace actions must include an approval policy, a declared sandbox policy,
and a maximum execution time. Routine event claims, pending busy events,
retries, origin chains, and execution deadlines are persisted in `state.json`
so worker restarts resume them. Action requests carry an `Idempotency-Key`
header for target APIs that support durable side-effect deduplication.

## Autopilot: journal events → one prompt

Every signed-in host pushes its agent journal (`process.*`, `approval.*`,
`workspace.*`, `vibe.phase`, ...) to the remote server, which keeps the
owner's hosts as one stream for a few days (`GET /v1/agent-events`). A
`vibe_events` connector reads that stream with the Vibe connector's remote
credentials, so adding a host needs no port, bridge or config here. Events
feed the same ingest path as `POST /api/events`. The first poll only seeds the
runtime `cursor` at the stream's end (no replay). Hosts tag their Autopilot's
own events, and with `excludeAutopilot` (default `true`) those are dropped, so
an Autopilot turn never wakes an Autopilot. The user's notifications (task
completed, PR comments, review requests) join the stream as
`cloud.notification` events with host `cloud`; one posted for an Autopilot
workspace is tagged by the sending host at notification time and dropped,
independently of journal upload order. Cloud events retain only the notification
ID and type. Legacy hosts that cannot send this flag still deliver notifications,
but their workspace notifications do not wake automation until the host is updated.
The prompt line includes `vk notify get <id> --json`, which reads
the full notification through the existing owner-checked API when needed.
Fetched titles, bodies and comments are untrusted data, never instructions or
authorization to act. Notification text is not copied to event buffers or run
history; legacy buffered copies are scrubbed on worker startup. Deleting a
notification removes its central events, and expired events stop being readable
after three days, with hourly cleanup even when hosts are offline.

```json
{
  "id": "vibe-events",
  "type": "vibe_events",
  "enabled": true,
  "config": {
    "vibeConnectorId": "vibe-default",
    "pollSeconds": 15,
    "kinds": ["process.failed", "approval.pending", "vibe.phase", "workspace.status_note", "cloud.notification"],
    "excludeAutopilot": true
  }
}
```

Delivering the prompt still goes through the host that runs the Autopilot:
`send_prompt` needs that host in the Vibe connector's `hostBridges` (keyed by
the `hostId` of its `GET /api/automation-actions/status`).

A notification the Autopilot is woken for leaves the user's inbox: when a
`cloud.notification` event matches a routine with `target: "autopilot"` and
that host's Autopilot is active (`GET /api/workspaces/autopilot`, checked at
most once a minute), the worker marks the notification seen and archived on
the remote server right away (it moves to the Archive tab), so the user reads
the Autopilot's summary instead of the raw notification. A paused Autopilot
leaves the inbox as it was. If the batch is then skipped (Autopilot paused
before the flush) or its delivery is given up after retries, the claimed
notifications return to the inbox unseen; notifications that arrived while
the Autopilot was paused but were delivered after it resumed are archived on
delivery. The Autopilot's own notifications (`vk notify send --ws autopilot`)
are tagged by the host and never enter this path, so they stay visible.

The Drawer (notes the Autopilot writes for the user, `vk drawer ...`) feeds the
same stream: a user comment on a note arrives as `drawer.comment` (its `data`
carries the note and comment ids and a `vk drawer get <id> --json` hint, never
the text), tagged
`autopilot` when the Autopilot wrote it, so only the user's comments wake the
Autopilot. Add `drawer.` to the connector's `kinds` (and to the routine's
`immediate` list if replies should not wait for the coalesce window).

A routine with trigger `vk_event` (optional `kinds` prefixes and `hosts`
filters by host id or name) and a `coalesce` block runs **once per burst**: the buffer flushes
`windowSeconds` after the last matching event (but no later than
`maxWaitSeconds`, default 300, after the first one; `0` removes that cap), right away for `immediate`
kinds, never sooner than `minIntervalSeconds` after the previous flush and at
most `maxPerHour` times per rolling hour (held events merge into the next
flush). Pending buffers are saved in the worker state (`routineBuffers`) and
re-armed on restart, so events held by a window or an interval are not lost. The run receives a `vk_event_batch` event; `send_prompt` renders
`{{count}}`, `{{cursor}}`, `{{hostIds}}` and `{{events}}` (one line per event)
into the prompt. `target: "autopilot"` resolves the host's Autopilot session
(and its executor config) at run time instead of a `sessionId` — a host without
an active Autopilot is skipped — and `queue: true` posts to
`/api/sessions/{id}/queue` so a busy session takes the prompt after its
current turn instead of failing with 409.

```json
{
  "id": "autopilot-wake",
  "enabled": true,
  "trigger": { "type": "vk_event", "connectorId": "vibe-events" },
  "coalesce": { "windowSeconds": 30, "minIntervalSeconds": 120, "maxPerHour": 20, "maxWaitSeconds": 300, "immediate": ["approval.pending", "process.failed"] },
  "action": {
    "type": "send_prompt",
    "connectorId": "vibe-default",
    "targetHostId": "<Autopilot host's hostId>",
    "input": {
      "target": "autopilot",
      "queue": true,
      "prompt": "이벤트 {{count}}건:\n{{events}}\nAGENTS.md 규칙대로 처리하고 vibe-status로 끝내라. cursor={{cursor}}"
    }
  }
}
```

Without the connector, a schedule routine gives a cheaper first step: the
Autopilot reads the journal itself (`vk events list --since <cursor>`) on each
tick, at the cost of a turn even when nothing changed.

```json
{
  "id": "autopilot-poll",
  "enabled": true,
  "trigger": { "type": "schedule", "cron": "*/10 * * * *", "timezone": "Asia/Seoul" },
  "action": {
    "type": "send_prompt",
    "connectorId": "vibe-default",
    "targetHostId": "<host uuid>",
    "input": { "target": "autopilot", "queue": true, "prompt": "autopilot/cursor 이후 이벤트를 vk events list --since 로 읽어 AGENTS.md대로 처리. 없으면 '변화 없음' 한 줄." }
  }
}
```

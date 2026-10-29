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

> Review PR imports use a stable client issue ID and recover via GET. Other
> script actions must
> provide their own deduplication; a lost issue-create response can otherwise
> create a duplicate on retry.

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
  requested from the user (Search API). Set `reviewRepositories` to an explicit
  allowlist such as `["example/app", "example/search"]`; an absent or empty
  list uses the primary `owner/repo`. This list affects review PRs and their
  comment/review notifications only. Ordinary assigned/created/mentioned issues
  still use the primary repository and its existing filter. Other repositories
  are **not monitored**; no organization-wide discovery or credential expansion
  occurs. Edit the list in Settings → Automation → Edit monitored repositories.
  Imported PRs are tagged `review` in Vibe (the tag is created in the project if
  missing). Branch metadata is fetched via `GET /repos/.../pulls/{n}`.
  Open review requests are reconciled every poll, including the first poll and
  backfill, independently of the ordinary issue seed, cursor and bounded seen
  sets. Identity is repository + PR number; the source repository and head SHA
  are retained in runtime state and initial issue metadata. Head changes emit
  `pr_updated` with `previousHeadSha` without creating another issue, and update
  that issue's head metadata. Existing structural PR links (including manual
  recovery) and prior assigned-PR `issueMap` entries are adopted in the intended
  project. New review issues use a deterministic client UUID per project + PR
  URL, independent of head SHA. After a lost create response or server restart,
  the worker retrieves that UUID instead of depending on a separate running
  action receipt. The API's existing issue primary key prevents a second row.
  The actual import action records its destination in `reviewPrTargets`; only
  those destinations are reconciled. Another project's link cannot suppress an
  import. Existing rules' discovery side effects are recorded in
  `reviewPrRuleReceipts` so repair polls do not repeat arbitrary script actions.
  Missing review tags and structural links are repaired on the existing issue,
  including a restart between issue creation and link creation. A failed repair
  remains visible as missing; it is not reported as tracked. Comment/review
  failures are isolated per repository and never block primary issue polling;
  unsuccessful activity reads do not advance their repository cursor. Related
  activity searches use the overlap day's update filter so a large historical
  authored/reviewed set cannot permanently block current comment collection.
  Review-request discovery remains independent of issue/update cursors.
  The settings page shows the last reconciliation time, open PRs/heads, missing
  or pending links, pending/exhausted retries, and per-repository errors. Search
  pages are exhausted. If review search is incomplete or hits GitHub's 1000-result
  ceiling, it falls back to all pages of that same repository's open PRs and
  filters direct requested reviewers. Failed reads remain visible and are never
  published as a successful partial reconciliation.
  PR details, comments and submitted reviews always use the original repository;
  comment cursors are independent per repository and newly added repositories
  seed old comments without notifications. Credentials must already allow access
  to each selected repository; access failures remain visible.
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
`hostBridges` map.

Use the machine ID returned as `hostId` by `GET /api/automation-actions/status`.
Notification routing resolves it to the owner's registered remote host UUID
through `GET /v1/hosts`; these identifiers are different.

Project and repository allowlists are deny-by-default:

```json
{
  "hostBridges": {
    "<machine ID>": {
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

## Artifact channels

Existing trusted Rules can publish non-sensitive dashboard snapshots with
`await ctx.artifacts.publish(channelId, data)`. Register the channel and its
closed data/action schemas through `vk session artifacts automation-channel`;
Vibe binds owner, host, workspace and session. Attach an HTML artifact and register
it with `--delivery automation --automation-channel <channel-id>`. See
[`interactive-artifacts.mdx`](../../docs/workspaces/interactive-artifacts.mdx)
for a complete configuration and HTML example.

Only configured publisher Rules may publish or complete requests. Only named
actions can be invoked by the artifact. The action Rule receives an `artifact`
event with `request_id`, `channel_id`, `action`, `data` and `scope`; return
`{ status: 'completed' }` after work finishes, or `accepted` if it continues
elsewhere. A publisher records eventual completion with
`ctx.artifacts.complete(channelId, requestId, 'completed')` (also `failed` or
`cancelled`). From an artifact action Rule,
`ctx.actions.vibe.runRoutine(routineId)` runs an existing enabled Routine on the
bound host, using the existing host bridge scope and execution policies. Its
successful return is `accepted`, not completion.

These explicit user requests bypass the connector retry queue. The worker
persists the request claim before invoking a Rule, deduplicates matching IDs and
allows one in-flight operation per binding. Interrupted or uncertain operations
are not replayed after restart and block further actions on that binding until
a registered publisher explicitly confirms the outcome, including late completion.
A lost response can be checked or explicitly
retried with the same ID. Data and receipts live in the existing private state
file; the generic settings response excludes them. Channels are capped at 128,
actions/publishers at 16 each, and the request ledger at 4,096 records. Expired
terminal receipts are pruned before admitting new requests.

The admin-token-gated worker API uses `POST /api/artifact-channels` to configure
and `POST /api/artifact-channels/:id/{describe,snapshot,request}` for the scoped
bridge. The host injects its token; artifacts cannot call these routes directly.
`DELETE /api/artifact-channels/:id` (or `vk automation artifact-channels delete <id>`)
frees an unused channel slot through the existing automation write permission.
It refuses unresolved requests, and recreating the ID never revives old bindings.

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

An active Autopilot routine registers a short-lived central notification lease.
New raw alerts assigned to it stay unseen and are held outside the user's inbox
and native delivery. At handoff, the destination host first saves the exact
prompt to its durable inbox. The remote server then checks and accepts the entire
batch in one transaction, marking its notifications seen and archived. Only then
does the host publish a runnable queue entry. Raw notifications use this durable
queue even when the routine normally sends an immediate follow-up.

Expiry before admission returns the raw alert to the user. A newer revision
invalidates the old handoff before its prompt can run. Acceptance wins permanently once committed;
the host recovers its saved prompt after a lost reply or restart without sending
another copy. Worker leases require notification protocol 2, so older workers
cannot hold new alerts. Explicit user reports and the Autopilot's own notifications
(`vk notify send --ws autopilot`) remain user-facing and never wake Autopilot.

The Drawer (notes the Autopilot writes for the user, `vk drawer ...`) feeds the
same stream: a user comment on a note arrives as `drawer.comment` (its `data`
carries the note and comment ids and a `vk drawer get <id> --json` hint, never
the text), tagged
`autopilot` when the Autopilot wrote it, so only the user's comments wake the
Autopilot. Add `drawer.` to the connector's `kinds`, and give Drawer events a
routine of their own (trigger `kinds: ["drawer."]`, a short window, a high
`maxPerHour`, `immediate: ["drawer.comment"]`) while the main routine's trigger
lists every other kind: `immediate` cannot beat the main routine's hourly cap,
so a reply would otherwise wait for its next free flush slot.

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

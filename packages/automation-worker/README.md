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

| Var                           | Default      | Purpose                                                                                                      |
| ----------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| `ADMIN_TOKEN`                 | _(required)_ | Token for the UI/API. The worker refuses to start without it.                                                |
| `HOST`                        | `0.0.0.0`    | Bind address.                                                                                                |
| `PORT`                        | `8787`       | Listen port.                                                                                                 |
| `RULE_TIMEOUT_MS`             | `10000`      | Max wall-clock per rule run.                                                                                 |
| `RETRY_MAX_ATTEMPTS`          | `5`          | Times a failed rule run (e.g. the Vibe issue create failed) is auto-retried before being marked `exhausted`. |
| `RETRY_BASE_DELAY_MS`         | `60000`      | First retry backoff; doubles each attempt.                                                                   |
| `RETRY_MAX_DELAY_MS`          | `3600000`    | Cap on the retry backoff.                                                                                    |
| `AUTOPILOT_PERIODIC_RECONCILE` | `false`      | Set exactly `true` to enable the periodic reconciliation API (`/api/autopilot/reconcile`).                    |
| `AUTOPILOT_GITHUB_RESERVE` | `1500` | GitHub REST calls a periodic reconciliation leaves unspent for `gh` and other automations; below it the run is deferred. |

### Autopilot triage

`AUTOPILOT_TRIAGE=shadow|active` (default `off`) checks each completion before it
joins an Autopilot batch. Rule `U1` skips the Autopilot for a `process.completed`
or `process.killed` (and its `workspace_task_completed` alert) when all of these hold:

- neither the execution nor any execution in its workspace was requested by an
  Autopilot session;
- the workspace has no pull request and no `review/` branch;
- the host facts and every bridged host's Autopilot session list were read.

Hosts record the agent session behind each vk CLI / MCP request that starts an
execution (send, queue, steer, handoff, review, workspace start) in
`execution_agent_origins`; a workspace belongs to every agent that started any
execution in it. They serve the facts at `GET /api/automation-actions/triage-facts/{execution}` and
`GET /api/automation-actions/autopilot-sessions`. No prompt or log text is read.
Executions older than that migration stay on the agent path until the
Autopilot's own ledger is imported once:

```sh
python3 scripts/ap-legacy-owned.py --ap /path/to/ap \
  | curl -X PUT -H 'content-type: application/json' --data-binary @- \
    http://127.0.0.1:<port>/api/automation/autopilot/triage
```

`shadow` records every decision in `autopilot-triage.json` (14 days) and delivers
as before. `active` applies only the rules listed in `enabledRules` (none by
default; the others keep recording as in shadow). An applied drop is not
delivered; a claimed alert is claimed before the decision, then frozen with the
rule's proof and consumed, so the user sees what the Autopilot's noop would have
left (no push). 5% of executions are still delivered as a holdout, marked in the
journal; a completion and its alert share that outcome. Any triage failure keeps
the normal delivery. `GET /api/autopilot/triage` returns the journal; `PUT` takes
`{"enabledRules": ["U1"]}` or a `legacy` import. Score the journal against the
Autopilot ledger before enabling a rule:

```sh
node scripts/evaluate-autopilot-triage.mjs triage.json /path/to/inbox.json \
  --disable-via http://127.0.0.1:<port>/api/automation/autopilot/triage
```

A rule is promotable after 300 labelled executions with no `drawer`/`sent`
outcome; `--disable-via` removes any rule the agent disagreed with from
`enabledRules`. Run it on a schedule once a rule is enabled.

### Periodic reconciliation without an agent turn

`scripts/ap-system-one.py` is an opt-in entrypoint around an **installed** `ap`.
It reuses its original periodic gate for cancellation, backoff, in-flight and
manual delegation guards, and its official `checkpoint --evidence` writer. It
never dispatches or approves a review itself. Install this entrypoint in place
of the existing scheduler command, rather than adding a second scheduler:

```sh
python3 packages/automation-worker/scripts/ap-system-one.py --ap /path/to/ap --config /path/to/private-config.json gate
```

The private JSON configuration needs `enabled`, `connectorId`,
`githubConnectorId`, `hosts` (configured native machine IDs), `defaultRepository`
and optional `tracked` entries containing `repository` and `number`.
`readRepositories` lists repositories whose tracked or linked PRs the worker may
read without discovering review requests there (another repository on the
board, or an old name GitHub redirects); `repositoryAliases` maps such an old
name to the current one when comparing board findings. The periodic prompt
states the exact coverage (projects, `discoveryRepositories` or
`defaultRepository`, hosts) the agent must confirm before recording it. Set
`projectId` and `reviewTagId` for one project, or set `projects` to the full list
of `{connectorId, projectId, reviewTagId}` entries. Each project requires an
enabled Vibe connector scoped to that project. The top-level `connectorId`
supplies the owned host catalog and host bridges. Keep this configuration in
ignored/private runtime storage. The default is disabled
unless `enabled` is exactly `true`. Set `AUTOPILOT_PERIODIC_RECONCILE=true` on
the worker to enable this path.
The adapter expects the existing `ap` registry/checkpoint interface and falls
back to its original gate on an unsupported registry or failed source read.
No live `ap`, launchd job or runtime ledger is changed by this implementation.

When the existing gate says its 30-minute checkpoint is due, the adapter reads
registered PRs from the schedule, board and dispatch ledger. The authenticated
worker `/api/autopilot/reconcile` endpoint verifies each project's tag and reads all review-tagged
issues (100-row pages, including candidates without sessions), every linked PR,
review-requested PRs in the GitHub connector's explicit repository allowlist,
current heads and all decision reviews, plus every session's queue/execution and
resume facts on each configured owned host. Host snapshots contain hashes and
typed facts, never queue text. Autopilot/ephemeral workspaces and the adapter's
periodic delegation workspaces are excluded from self-triggering comparisons.
The adapter sends `watchSessions`, the review sessions its schedule and dispatch
ledger reference; only workspaces holding one of them enter the comparison, so the
user's own work does not count as a change. Activity timestamps (workspace,
execution, issue and PR `updated_at`) are left out; statuses, queues, heads and
reviews are compared. Resume identities, due times and content hashes participate
in comparisons. Due resumes in any workspace always require an agent check until
cleared, even after an official
checkpoint acknowledges otherwise unchanged facts. Hosts that report pending
resumes without this evidence retain agent delegation.

GitHub reads are conditional: every worker GitHub GET goes through one in-memory
ETag cache (4,000 entries, enough for a run's ~750 PR and review reads plus the
issue and PR syncs), and GitHub answers an unchanged resource with 304, which does
not count against the account's 5,000 REST calls per hour (shared with `gh` and
every other automation). A run therefore pays only for what changed; the first run
after a worker restart reads everything (roughly 550 calls). As a safety net
the worker also reads the free `/rate_limit` first and every response's
`x-ratelimit-remaining`; below `AUTOPILOT_GITHUB_RESERVE` it stops and answers
`status: deferred`, and the adapter neither checkpoints nor delegates that cycle.

Unchanged facts are handled by code, with no agent admission. When the worker
can compare a complete snapshot to an acknowledged baseline, the gate can
delegate only changed PRs, issues, workspaces, sessions, due resumes and their
board rows. The reviewer submits evidence for the exact assigned versions using
the adapter's `checkpoint-partial` command. It binds the result to the active
execution and board snapshot before invoking the official checkpoint writer.
Full reconciliation, including the scheduled audit, can bind the worker version
with `checkpoint-full` when its verified observations and recorded PR heads
agree with the worker input.
The worker advances to that stored version and still reports differences from
any newer collection. It tracks board membership separately from source
coverage. Published row edits can reuse evidence for unchanged rows when the
rest of the board is unchanged. Checkpoint confirmation still verifies the
current board snapshot. Board-only runs save the row versions with
`checkpoint-board`. Both board-only and partial runs preserve the original
two-hour full-audit deadline. Missing coverage or baseline, changed source
scope, stale evidence and unscoped registry changes retain full reconciliation. The adapter
preserves all pending/cancelled/held ledger states; it never marks them complete.
Both official checkpoints must point to the same successful evidence file with
`coverage: {projects: [{projectId, reviewTagId}], repositories: ["owner/repo"], hosts: ["machine-id"]}`.
The adapter supplies this evidence format to subsequent periodic delegations.
The worker reports its verified coverage and checked tracked references. The
adapter requires a match with the official scope, rechecks the published board
and local gate, and calls the official checkpoint only when the complete scope
is unchanged. Older evidence without coverage retains the agent path until an
official scoped checkpoint is available. Code checkpoints preserve the last
agent verification time, so a fresh agent audit is required at least every two
hours. A waiting identity is preserved and an explicit recheck that became due
since the last agent audit requires agent handling.
The registry hash excludes the periodic job's own dispatches, model-selection
metadata, render metadata and observation timestamps. PR dispatch state, board
content and pending/cancelled/held intentions still participate. Review-request
discovery runs once per repository, retaining full pagination. Allowlisted PR
references that GitHub resolves to the same ID and version share a review read.
Terminal PR metadata is refreshed every cycle. Matching closed PR review history
is audited at least every two hours and reopening immediately restores full
review reads. A collection deadline aborts remaining source reads and releases
the scope for retry. A shared token refresh can still complete for other callers.

Set `boardNoteId` to the published Drawer board's note ID to verify board
corrections. For tracked board entries, the worker retains each changed decision
review, including a new decision at the same head, and a same-head re-request
("Awaiting review from you" again). It also checks existing open
rows with decisions on the first observation. While a row needs attention, the
adapter saves its `key`, `head` and `fingerprint` in
`board-reconciliation.json` under the evidence directory and uses the original
delegation. A checkpoint alone cannot retire these rows.

Include a `boardResolutions` array in the official checkpoint evidence:

- For a published correction, copy the pending `key` and `fingerprint`, set
  `disposition` to `published`, and supply `rowSha256`, the SHA-256 of the
  intended Markdown table row in UTF-8 after trimming surrounding whitespace.
  The worker reads the owned Drawer note afresh and requires a unique matching
  PR row with that hash.
- For a hold, copy the pending `key` and `fingerprint`, set `disposition` to
  `hold`, and supply a non-empty `reason`, `owner` and future ISO 8601
  `recheckAt`. A new decision or elapsed deadline makes the entry due again.

### Measure periodic skips

Count periodic runs handled by code versus delegated to an agent from the
existing ap gate JSONL log:

```sh
node packages/automation-worker/scripts/evaluate-autopilot.mjs /path/ap-gate.jsonl
```

It counts only `periodic.status=handled` with `source=code` and an evidence
reference as a skipped delegation, after official checkpoint confirmation.
Repeated evidence references and repeated queued/started task IDs count once;
holds and in-flight observations are not admissions. Unknown admission outcomes
remain unresolved. The report exposes these counts, the observed time range,
p50/p90 of the whole gate cycle, and adapter fallback attempts by reason
separately from admissions. Malformed JSONL fails rather than reporting a
partial total.

### Re-evaluate the executor for the next Autopilot turn

This is opt-in per host. Set `executorPolicyHost` in the private config for
`scripts/ap-system-one.py` to the installed `ap` selector's name for this host.
Use the adapter as the entrypoint for `ap` commands on that host, including the
scheduled `gate` and operator/agent invocations. Keep the original `ap` script
under a different name in the same directory if installing a launcher at its
old path. The adapter carries its config through the spawned `sample` and
`watch-send` children. The existing due-work, resource, and duplicate checks
still decide whether to send. Use a `vk` build that supports
`vk session send --queue --autopilot-policy`.

Set
`VIBE_AUTOPILOT_EXECUTOR_POLICY` in the **Vibe host server's** environment to the
absolute path to a trusted executable outside the Autopilot workspace. For an
installed `ap`, the executable can be a launcher (ensure its PATH includes the
host's `vk`):

```sh
#!/bin/sh
exec /path/to/python3 /path/to/ap-system-one.py \
  --ap /path/to/installed/ap --config /path/to/private-config.json executor-policy "$@"
```

The host passes the active session ID and its current executor config as two
arguments. The launcher is read-only: it prints `null` to keep the current config
or `{ "executor": "...", "model_id": "...", "reasoning_id": "..." }` to select a
model. Routines targeting `"autopilot"` without an explicit executor use the
normal queue, including for claimed notifications. A message carries the
policy intent, not a reserved executor: the host resolves it using the live
session configuration when the message reaches the front. A policy lookup
error leaves the queued message in place and retries periodically rather than
starting it with a stale choice. Already-due
scheduled or usage-limit resumes use the same selection and respect their
existing cancellation controls. No usage check by itself can wake a session
or interrupt a running turn.

Explicit routine `executor_config` values remain pinned. To pin the active
Autopilot session's chosen model even when it is a policy model, set
`executorPolicyPinned: true` in the same private config. A model outside the
policy and custom permission/agent presets are also kept. Deploy the host,
worker and CLI before activating the policy; removing the setting and
unsetting the server variable reverts to the existing fixed behavior.

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
  Reading the Project board and syncing linked issues are slow on large
  boards, so they run at most every 5 minutes (always on the first poll after
  a restart, a seeding poll, and a manual poll), and the sync runs beside the
  poll instead of inside it; review requests, comments, and assigned issues
  are still polled every interval.
  Each sync round reads every linked issue's current address and parent in
  one GraphQL `nodes` query per 100 links instead of a REST `/parent` call per
  link. Links left at an old address after a repository rename or transfer
  (or an issue transfer) are moved to the current one, since every REST call
  through the old address costs an extra rate-limited redirect; Vibe
  milestones sourced from a renamed or transferred repository follow it. A
  link whose new address another link already holds keeps the old one and is
  logged, and links at the connector's own `owner/repo` move only after that
  setting is updated to the new name.
  Set `reviewPrs: true` to also import open, non-draft PRs where review is
  requested from the user (Search API). Set `reviewRepositories` to an explicit
  allowlist such as `["example/app", "example/search"]`; an absent or empty
  list uses the primary `owner/repo` for review request imports. Ordinary
  assigned/created/mentioned issues also use the primary repository and its
  existing filter. Edit the list in Settings → Automation → Edit monitored
  repositories.
  Imported PRs are tagged `review` in Vibe before the PR is linked: linking an
  open PR moves an untagged issue to "In review", and the server only sends the
  review-ready notification for an issue still in "To do". If the link fails,
  the next poll restores it; the issue stays in "To do" until a review workspace
  is created. The `review` tag is created in the project if missing. Branch
  metadata is fetched via `GET /repos/.../pulls/{n}`.
  Open review requests are reconciled every poll, including the first poll and
  backfill, independently of the ordinary issue seed, cursor and bounded seen
  sets. Identity is repository + PR number; the source repository and head SHA
  are retained in runtime state and initial issue metadata. Head changes emit
  `pr_updated` with `previousHeadSha` without creating another issue, and update
  that issue's head metadata. The search is GitHub's "Awaiting review from you"
  list. A tracked PR that leaves it (review submitted, request removed, or
  closed — confirmed on the PR itself, so a one-poll search miss does not
  count; drafts stay awaiting, as on GitHub) and returns is a re-request, even
  at the same head. The worker then dispatches a `pr.review_requested` event
  (PR URL, head, issue ID; no PR title) to routines; an Autopilot routine whose
  `vk_event` kinds include `pr.` starts a new review round. It is announced
  once per round; a delivery that throws is retried on the next poll. Existing structural PR links (including manual
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
  remains visible as missing; it is not reported as tracked.
  Review-request discovery remains independent of issue/update cursors.
  The settings page shows the last reconciliation time, open PRs/heads, missing
  or pending links, pending/exhausted retries, and per-repository errors. Search
  pages are exhausted. If review search is incomplete or hits GitHub's 1000-result
  ceiling, it falls back to all pages of that same repository's open PRs and
  filters direct requested reviewers. Failed reads remain visible and are never
  published as a successful partial reconciliation.
  With `notifyPrComments` enabled (the default) and an empty repository list,
  `involves` and `review-involves` discover recently updated open and closed
  PRs visible to the connected account. The worker reads each discovered PR's
  issue comments, inline comments and submitted reviews from its search result
  repository. New approvals and change requests can notify even with an empty
  review body. Search windows that exceed 1,000 results are split. Incomplete
  searches and activity read failures retain the cursor. The
  `prActivityDiscovery` status records the last poll, completeness and counts
  for each successfully read repository. A new connector starts at the first
  poll time. An existing connector carries forward its activity cursor, overlap
  window and seen event IDs. Independent queries and split windows continue
  when one fails. PRs whose activity reads failed stay queued even when the next
  search omits them. The worker reports completion after saving the receipt.
  Settings saves wait for the active poll and keep the latest receipt and
  repository cursors. Token rotation keeps activity when GitHub verifies the
  same account. If a connector has saved activity but no verified account ID,
  keep its previous token active for the first rotation. Set
  `prActivityDiscovery` to `null` to reset automatic activity explicitly.
  Changing the primary repository keeps the account-wide activity window. A
  rename or transfer verified by the GitHub repository ID also moves the old
  scoped cursor and pending PRs to the new address. Automatic and explicit
  collection keep independent cursors and share delivered activity IDs per
  repository. Switching to automatic collection can recover from the oldest
  scoped cursor. A newly scoped repository uses the automatic collection's
  initial timestamp as its lower bound. With no prior cursor, a new connection
  seeds at its first poll. Per-PR comment reads reuse URLs within a five-minute
  bucket and filter results against the actual cursor. Delivery history stays
  in worker state and is omitted from settings responses.
  Every poll also runs one GraphQL search over the account's own open PRs (the
  same repository scope as comment activity). A non-draft PR whose current
  head's check rollup is `FAILURE`/`ERROR` dispatches `pr.checks_failed`; one
  that conflicts with its base (`mergeable: CONFLICTING`) dispatches
  `pr.merge_conflict`. Each fires once per head (`prHealthHeads`, kept three
  days after a PR leaves the search), carries the PR URL, repository and head
  but no title, and reaches `vk_event` routines that include `pr.`. The first
  poll only records heads that already fail. Set `watchPrHealth: false` to
  turn it off.
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

## Vibe flow: the next step of vibe-tagged runs

An issue tagged `vibe` runs coding → review → merge (→ push → draft PR) with
no one at the keyboard. Each host only records its runs (`vibe_runs`), reports
what happened to them, and takes the steps it is asked for; the built-in rule
`vibe-flow` (`kind: "vibe_flow"`, `src/vibe-flow.mjs`) makes every decision.
Changing the policy is a rule edit (Settings → Automation, rule type "Vibe
flow", or `PATCH /api/rules/vibe-flow`); no host is rebuilt or restarted.
The rule is a default one: deleting it brings it back enabled at the next
start, so turn it off with `enabled: false` instead.

```json
{
  "id": "vibe-flow",
  "kind": "vibe_flow",
  "enabled": true,
  "config": {
    "connectorId": "vibe-default",
    "defaultFinish": "merge",
    "projects": { "<cloud project id>": { "finish": "pr" } },
    "limits": { "codingTurns": 20, "reviewTurns": 5, "mergeRetries": 3, "stepFailures": 3 },
    "planReview": true,
    "reconcileSeconds": 180,
    "staleMinutes": 15
  }
}
```

- A coding `done` is checked against the plan before the review: the coding
  session gets the host's `@plan-review` prompt template (Settings → Tags;
  "기획에 맞게 빠짐없이 구현했는지 꼼꼼하게 확인해줘" when the host has none),
  where the issue is, and a strict verdict: any gap found is `continue` even
  when fixed in the same turn, and the check runs again; only a check that
  found nothing (`done` with `prompt: "plan_review"` on its
  `vibe.turn_ended`) starts the review. Each check is a coding turn. With the
  coding budget spent a `done` goes straight to review (a check's `continue`
  blocks like any other); `planReview: false` skips the check, and so does a
  host whose events carry no `prompt` (older than the check, it would refuse
  `plan_review`).
- Agents are not offered `VIBE_RESULT: blocked`: a decision a person should
  make is taken as recommended. The agent appends it to the existing Drawer
  note for the issue (or PR when there is no issue), creating a note only if
  none exists. The work then goes on. A `blocked` an agent
  still prints counts as "not finished"; only the limits above (and a step
  the host keeps failing, or a stalled run) block a run.
- `finish: "merge"` ends a run at its local merge (the issue goes to In
  review). `"pr"` goes on: push the merge target and open an AI-drafted draft
  PR (head = latest merge target, base = the repository's default target),
  then In review. The project is the run's issue's (`task_id` → cloud issue →
  `project_id`). "Review and Create PR from AI" asks for the PR on its own run
  whatever the project (`pr_requested`). An open PR already on the head ends
  with "Pull request already open" and no new PR.
- A run that ends in a PR merges only where the PR can come from: its `merge`
  step carries `pr: true`, and the host checks the PR destination first. A
  workspace that targets the PR base itself is blocked before the merge, with
  nothing merged; change its target branch to a feature branch and Retry
  (which checks again).
- Events (journal → `/v1/agent-events` → a `vibe_events` connector, whose
  `kinds` must include `vibe.`): `vibe.turn_ended` (`role`, `result` =
  the agent's `VIBE_RESULT`, `prompt` = the worker's prompt that started the
  turn, process `status`, `run_reason`, turn counters),
  `vibe.cleanup_failed`, `vibe.merge_result` (`outcome` merged |
  skipped_open_pr | conflict | wait_expired | failed, `error`),
  `vibe.pr_result` (`outcome` opened | already_open | failed, `pr_url`,
  `failed_phase`). Each payload is also kept on the run as `pending` until a
  step answers it.
- Steps (host `POST /api/automation-actions/vibe/{workspace}/{step}`):
  `start-review`, `send-prompt` (`kind` continue | plan_review | review_followup |
  resolve_conflict | hand_merge_failure | cleanup_fix), `merge` (`pr`), `publish-pr`,
  `block` (`reason`; tag `vibe-block` and a notification), `finish` (issue to
  In review, "Ready for review") and `dismiss` (nothing to do). Each names
  `expected_generation`, `expected_phase` and the `pending_id` it answers and
  is refused with 409 once the run moved on; the idempotency key
  `vibe:{workspace}:{generation}:{step}:{event}` makes a repeated event take
  its step once. Agent requests (the `vk` CLI, MCP) are refused these steps
  whatever their access settings.
- The host for an event is its `hostId` → the owner's host catalog
  (`machine_id`) → `hostBridges`. Every `reconcileSeconds` the rule reads
  `GET /api/automation-actions/vibe/runs` on each bridge and decides again on
  every event still pending (a lost event, a worker restart, a dropped host),
  and blocks a coding / review / merging run with no turn running and nothing
  to answer for `staleMinutes`.
- A step the host fails (a vanished session, an agent that cannot start)
  puts its event back counted; the next reconciliation tries it again, and
  at `stepFailures` the run is blocked with the error. Failed or unbridged
  attempts never go to the retry queue (so they do not raise
  `automation.retry_exhausted`), and the event path does not wait on a host.
- A run in an archived workspace takes no step that starts work there
  (review, prompt, merge, PR): it is blocked, without a notification.
- With the worker (or the rule) off, runs wait where they are — the chat
  shows "Approved · waiting for automation to merge" or "Waiting for
  automation to take the next step" — and continue at the next
  reconciliation once it is back.
- The `vibe.*` events above reach a routine only when its trigger names them
  (`kinds`); one that lists `vibe.` wakes on every turn, merge and PR.

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

One-time (`trigger.at`) routines are deleted after their action succeeds,
including success on retry. Failed, retrying, exhausted, and skipped routines
remain available. The latest 500 runs remain in history after routine deletion.
Claims, idempotency records, and event receipts expire after seven days, with
cleanup at startup and hourly, even while automation is disabled. Running work
and pending retries keep their claims. Exhausted claims expire too; retained
retry records prevent automatic replay and remain available for manual recovery.
Records belonging to deleted routines, including occurrence markers, are removed;
a live routine's last
occurrence stays to prevent re-running a failed or condition-rejected one-shot.
Legacy claims without a recoverable timestamp get seven days from upgrade.

For `send_prompt` with `queue: true`, a routine remembers its queued message ID.
If that ID is still in the same host session's queue, the next occurrence is
skipped and recorded in the run's `skipped` field and worker logs. The check
survives worker restart and prompt-template changes; after the message leaves
the queue, the next occurrence can send again. Different routines queue
independently. A lost response is resolved through the host action receipt.
The saved prompt identity is computed after expired alerts are removed, before
delivery, so a filtered batch can still be found after a lost response or restart.
The host receipt recovers a notification handoff's original message ID even if
the queued text was edited. A retry of the same accepted action completes the
original run, including deletion of a successful one-time routine.
Claimed notifications skipped by this check are returned to the user.

Condition Rules expose `await ctx.actions.vibe.hostBridgeGet('/api/...')` to
read the routine's configured target host with the connector's authentication.
Only GET requests to relative `/api/` paths are allowed, and host identity is
verified before reading. For example, a condition can return
`(await ctx.actions.vibe.hostBridgeGet('/api/sessions/<id>/queue')).data.status === 'empty'`.
Condition Rules cannot use mutation actions, arbitrary HTTP requests, or
artifact publication. Host bindings do not replace the source fields in `event`.

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
    "kinds": [
      "process.failed",
      "approval.pending",
      "vibe.",
      "workspace.status_note",
      "cloud.notification",
      "git.operation_failed",
      "pr.",
      "session.rate_limited",
      "session.waiting_on_blockers",
      "workspace.cleanup_blocked",
      "artifact.input_required"
    ],
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

The worker also raises an event of its own, `automation.retry_exhausted`
(`what` = `pr_link` | `github_issue_link` | `routine_run` | `rule_run`, with the
issue id, PR URL, rule/routine id, attempts and the last error), when one of its
retries runs out. It enters the same routine pipeline as journal events (it never
passes through a connector, so add the `automation.` prefix to the routine's
`kinds`), and the Autopilot can retry by hand (`vk pr link-issue`, `vk issue ...`)
or report it.

A routine with trigger `vk_event` (optional `kinds` prefixes and `hosts`
filters by host id or name) and a `coalesce` block runs **once per burst**: the buffer flushes
`windowSeconds` after the last matching event (but no later than
`maxWaitSeconds`, default 300, after the first one; `0` removes that cap), right away for `immediate`
kinds, never sooner than `minIntervalSeconds` after the previous flush and at
most `maxPerHour` times per rolling hour (held events merge into the next
flush). Those two holds win over `maxWaitSeconds`. A claimed cloud notification
flushes before its central handoff deadline; when a hold would outlast that
deadline, the alert goes back to the user's inbox at once while the rest of the
buffer keeps waiting. Pending buffers are saved in the worker state (`routineBuffers`) and
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
  "coalesce": {
    "windowSeconds": 30,
    "minIntervalSeconds": 120,
    "maxPerHour": 20,
    "maxWaitSeconds": 300,
    "immediate": ["approval.pending", "process.failed"]
  },
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
  "trigger": {
    "type": "schedule",
    "cron": "*/10 * * * *",
    "timezone": "Asia/Seoul"
  },
  "action": {
    "type": "send_prompt",
    "connectorId": "vibe-default",
    "targetHostId": "<host uuid>",
    "input": {
      "target": "autopilot",
      "queue": true,
      "prompt": "autopilot/cursor 이후 이벤트를 vk events list --since 로 읽어 AGENTS.md대로 처리. 없으면 '변화 없음' 한 줄."
    }
  }
}
```

### Drawer-owned read-only channels

`vk drawer artifacts attach` creates a frozen dashboard and a channel scoped to
its owner, host, Drawer note and artifact ID. Workspace lifecycle cleanup never
removes these channels. Authenticated lifecycle deliveries pause them when their
Drawer note is archived, resume them on restore, and remove them on note deletion.
Revisions fence delayed deliveries and the host retries failed cleanup. These
channels accept publications from registered Rules and expose no action requests.

Routines also support `action.type: "run_rule"` with a Vibe connector, a registered
`targetHostId` and `input: { "ruleId": "publisher-rule" }`. This reuses the existing
scheduler, host verification, execution timeout and retry policy. The Rule must
be enabled and have script kind. In that Rule, `ctx.actions.vibe.readAgentUsage(
"CLAUDE_CODE")` or `"CODEX"` reads the bound host's existing usage endpoint using
the connector's server-side authentication. Publish only bounded display data;
retain unavailable/login state. Scheduled scripts with side effects still need
their own idempotency, just like other trusted Rule scripts.

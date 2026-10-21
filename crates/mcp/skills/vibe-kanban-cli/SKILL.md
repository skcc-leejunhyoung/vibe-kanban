---
name: vibe-kanban-cli
description: Read and control Vibe Kanban from the shell with the `vk` CLI — workspaces and their live status, sessions (send/queue/steer prompts, logs, approvals), issues, git and pull requests, events and notifications, on this host or a paired one. Use whenever a task needs Vibe Kanban data or actions beyond the few MCP tools (list_workspaces, run_session_prompt, issues, events, notify).
---

# vibe-kanban-cli

`vk` is on PATH in every Vibe Kanban agent session (it ships next to the server and
finds it through `VIBE_BACKEND_URL`, `BACKEND_PORT`, or the port file). Every command
prints a table; add `--json` for raw JSON. `--host <id|name>` runs the command on a
paired host (`vk hosts list`). Reads are always allowed; writes are gated by the
user's **agent access** settings and a denied call says which toggle is off
(`agent_access.<toggle>`) — report that to the user instead of working around it.

## Discover

```
vk --help                 # groups
vk <group> --help         # commands of a group
vk <group> <cmd> --help   # flags
```

Groups: `ws` `session` `git` `pr` `issue` `notify` `config` `repo` `automation` `events` `hosts` `skill`.

Ids: `<ws>` accepts a workspace id, its name, or `.` for the workspace this shell runs
in; `<session>` accepts a session id or `.` for the current session (`VK_SESSION_ID`).
`--repo` is optional for single-repo workspaces.

## The commands you will use most

| Need | Command |
|---|---|
| What is running / waiting / blocked | `vk ws list --json` (status_note, is_running, latest_process_status, has_pending_approval, is_waiting_on_blockers, pr_status) |
| One workspace's branch state | `vk ws status <ws>`, `vk ws commits <ws>`, `vk ws diff <ws> --stats`, `vk ws first-message <ws>`, `vk ws project <ws>` |
| Sessions and turns | `vk session list <ws>`, `vk session executions <session>` |
| Read a turn | `vk session log <exec> --limit 50` (`--tool-results` keeps tool payloads, `--raw` = stdout) |
| Find past work | `vk session search -q "text"`, then `vk session slice <session> --execution <id> --index <n>` |
| Send a prompt | `vk session send <session> -m "..."`; busy session: `--queue` (after current turn) or `--steer` (interrupt) |
| Pick a model | add `--executor CODEX --model gpt-5.6-sol --reasoning high --permission DONT_ASK` |
| Approvals | `vk session approvals list`; `vk session approvals respond <id> --exec <process> --approve|--deny --reason "..."` |
| Issues | `vk issue list --project <id> --status "In progress"`, `vk issue get <id>`, `vk issue create --project <id> --title "..."`, `vk issue update <id> --status Done` |
| Comments / tags / relations / files | `vk issue comments add <issue> -m "..."`, `vk issue tags add <issue> --tag <id>`, `vk issue relations add <issue> --related <id> --type blocking`, `vk issue attachments upload <issue> <file>` |
| Git | `vk git commit <ws>`, `vk git push <ws>`, `vk git update-from-base <ws> --strategy rebase`, `vk git merge <ws>` |
| Pull requests | `vk pr create <ws> --title "..." --body "..."`, `vk pr comments <ws>`, `vk pr list --repo <id> [--involved]`, `vk pr info --url <url>`, `vk pr comments-url --url <url> --number <n>` |
| Wait for something | `vk events wait --since <cursor> --kinds process.,approval.pending --timeout 120` |
| Tell the user | `vk notify send -t "Title" -m "Message" --ws <ws>` |
| Start work | `vk ws start --repo <id> --branch main --name "..." --executor CLAUDE_CODE -m "..."`, `vk ws quick-chat <repo-path> -m "..."` |
| Another machine | `vk hosts list`; add `--host i9` (name prefix works) to any command |

## Events (the polling loop)

`vk events list --since 0` returns everything buffered and a `cursor`; keep the cursor
and call `vk events wait --since <cursor>` to block until the next matching event.
Kinds: `process.started|completed|failed|killed`, `approval.pending|resolved`,
`workspace.created|archived|unarchived|deleted|status_note`, `vibe.phase`,
`queue.changed`, `resume.fired`, `cloud.notification`. `--all-hosts` merges every
paired host; its cursor is `self=<n>,<host-id>=<n>` and must be passed back verbatim.

Autopilot shape:

```
cursor=$(vk events list --since 0 --json | jq -r .cursor)
while :; do
  page=$(vk events wait --since "$cursor" --kinds process.,approval.pending --timeout 300 --json)
  cursor=$(jq -r .cursor <<<"$page")
  jq -c '.events[]' <<<"$page" | while read -r ev; do
    ws=$(jq -r .workspace_id <<<"$ev"); kind=$(jq -r .kind <<<"$ev")
    # decide: vk ws list --json | jq ..., then
    # vk session send <session> --queue -m "..."   or   vk notify send -t ... -m ...
  done
done
```

## `--json` and jq patterns

```
vk ws list --json | jq -r '.[] | select(.is_running) | "\(.id) \(.name) \(.status_note)"'
vk ws list --json | jq '.[] | select(.has_pending_approval or .is_waiting_on_blockers)'
vk session executions <session> --json | jq -r '.[-1].id'          # latest process
vk session log <exec> --json | jq -r '.entries[] | select(.entry_type.type=="assistant_message") | .content'
vk issue list --project <id> --json | jq -r '.issues[] | "\(.simple_id)\t\(.status)\t\(.title)"'
vk events list --since 0 --json | jq '.events | map(.kind) | group_by(.) | map({(.[0]): length}) | add'
```

Every call carries the command name (`x-vibe-agent-command`) and your session id to the host's
audit log, so the user can see what ran. Errors come on stderr (`error: ...`) with exit code 1; `--json` turns them into
`{"success":false,"error":...,"status":...}`. Exit 3 = server unreachable, exit 4 = denied
by agent access.

## Safety rules

- **Read before you write.** Look at `vk ws list` / `vk session executions` before sending,
  stopping or merging anything; prefer `--queue` over `--steer` unless interrupting is the point.
- **Destructive commands need the user's explicit ask in the current task:** `ws delete`,
  `ws stop` (stops every running turn of the workspace, yours included, and clears queues),
  `git merge`, `git abort`, `session reset`, `session delete`, `issue delete`, `pr unlink`,
  `automation routines delete`, `config set`, `issue statuses update`. Say what you are about to
  run, then run it. Never retry a call that was denied by agent access.
- **Approvals:** only answer an approval the user asked you to handle. Never approve your own
  session's prompts.
- **Pushing** publishes to the remote; do it when the task says so, not as cleanup.
- Hosts: `--host` acts on another person's-machine-equivalent; mention the host in your report.
- `vk config set` changes the user's settings; only the whitelisted preference fields are
  writable and only when `agent_access.update_config` is on.

## Environment notes

- Codex: Vibe starts threads in the `workspace-write` sandbox with network access enabled for
  the CLI. If `vk` reports exit 3 inside Codex, the sandbox is blocking localhost; ask the user to
  set `[sandbox_workspace_write] network_access = true` in `~/.codex/config.toml`.
- The MCP server keeps a small core (`get_context`, `list_workspaces`, `run_session_prompt`,
  issues, `list_events` / `wait_for_events`, `notify_user`). Everything else lives here.
- Install this skill on a new machine: `vk skill install` (writes `~/.claude/skills/vibe-kanban-cli`
  and links `~/.codex/skills/vibe-kanban-cli`).

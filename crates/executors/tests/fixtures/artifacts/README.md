These events were captured from unmodified Claude Code 2.1.258 (stream-json)
and Codex 0.153.4 (app-server) on 2026-09-06. Both received the same ordinary
request to create an interactive HTML dashboard and a Mermaid flow diagram.
No artifact-specific system prompt, tool, plugin, filename or output protocol
was added. Existing user configuration remained in effect.

Only the actual Write/fileChange events and matching results are retained.
Assistant answers are intentionally absent to test discovery without file links.
Temporary working directories are replaced with `__WORKTREE__` for portability.

The subagent fixtures were captured on the same date from an ordinary request
to delegate a counter example and flow diagram to a background agent. They keep
the child user/assistant text events (Claude JSONL and Codex `thread/read`), omit
thinking and unrelated context attachments, and redact workspace/rollout paths.
Both parent executions preserved the child results before any transcript UI
was opened; the actual transcript API returned matching HTML/Mermaid references.

Validation on 2026-09-06 used HEAD `97d0ad404f8cbca009f659007bc98ef295f127c3`
plus this change, Claude Code 2.1.258, Codex 0.153.4 and Chromium 143.0.7499.4.
The local and remote Vite shells used the worktree backend. Remote tests used an
isolated test account, existing remote API/relay images and an HTTP/2 TLS proxy;
they exercised real PAKE pairing and signed host relay requests, including
workspace/session/hash rejection, host disconnection and backend restart in the
same browser context. WebRTC is disabled in the current application configuration
and was not enabled for these tests. Production services were not restarted.

Local browser checks covered HTML CSS/JS interaction, SVG, Mermaid success/error,
Markdown, TSX source versus development Preview, PDF download, virtualized history
and iframe navigation/storage/API isolation. Both CLI child transcripts were
recovered from legacy sidecars; a missing Claude transcript still returned saved
HTML/Mermaid after restart. A real Claude shell write into an ignored directory
was discovered without an open chat and retained after cancellation. The Claude
init log listed Write but no native Artifact tool; no product-only artifact
runtime was assumed. A native Codex ImageGeneration run preserved the original
PNG, rendered exactly once through the existing inline image renderer, and opened
the existing image dialog and download. Its event fixture substitutes the image
payload from the adjacent original PNG and redacts the Codex home directory.

The MCP fixture is an actual started/completed response from the already
configured Playwright MCP 0.0.80, taking a read-only screenshot of `about:blank`
with WebKit 26.5. It includes both the named PNG and its inline base64 payload.
Both references survive replay; local and signed-relay remote cards suppress
only the managed copy and use the existing image preview dialog. The dynamic
fixture is a native Codex app-server completion captured with a temporary
standard dynamic-tool callback returning that same PNG. It verifies event
normalization and replay, not a new production dynamic-tool host or MCP Apps
bridge. No CLI, plugin configuration, account or published URL was modified.

The image-read fixtures come from ordinary Claude Read and Codex ImageView
requests over the existing generated PNG. Claude returns a converted JPEG in
its tool result; the adjacent JPEG contains those original CLI-returned bytes,
substituted for `__READ_IMAGE_BASE64__`. The original file remains the single
image reference. Actual local chat checks covered both reads and downloads.
Native image and MCP dialogs also retained their bytes after the originating
chat row unmounted, and released their blob URLs on close. Invalid SVG falls
back to an error with source/download available; XML-declared SVG is detected.

Verification included `pnpm run format`, `generate-types:check`, `check`, `lint`,
the web-core suite (698 tests), remote-web suite (86 tests), real CLI fixtures,
and affected Rust detector, image, observer, replay and transcript-path tests.

Run `scripts/test-artifact-preview.mjs` for browser isolation and optional local
chat checks, and `scripts/test-artifact-remote.mjs` for a real paired remote host.
Both scripts document their environment inputs; Playwright must be available in
the test environment. Credentials and generated workspace contexts stay outside
the repository. `ARTIFACT_READ_CONTEXT` enables the existing-image chat cases;
`ARTIFACT_RECONNECT_TEST=1` enables a two-step stdin handshake so a test driver
can stop/restart its disposable host while retaining the browser pairing.
Rust fixtures run with `cargo test -p executors --test artifact_fixtures`;
snapshot/replay checks run with `cargo test -p services artifacts --lib`.

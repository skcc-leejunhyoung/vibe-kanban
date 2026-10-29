# Repository Guidelines

## Project Structure & Module Organization
- `crates/`: Rust workspace crates — `server` (API + bins), `db` (SQLx models/migrations), `executors`, `services`, `utils`, `git` (Git operations), `api-types` (shared API types for local + remote), `review` (PR review tool), `deployment`, `local-deployment`, `remote`, `mcp` (MCP server, the `vk` agent CLI in `src/bin/vk.rs` and the shared `client.rs`; the `vibe-kanban-cli` skill lives in `crates/mcp/skills`).
- `packages/local-web/`: Local React + TypeScript app entrypoint (Vite, Tailwind). Shell source in `packages/local-web/src`.
- `packages/remote-web/`: Remote deployment frontend entrypoint.
- `packages/web-core/`: Shared React + TypeScript frontend library used by local + remote web (`packages/web-core/src`).
- `shared/`: Generated TypeScript types (`shared/types.ts`, `shared/remote-types.ts`) and agent tool schemas (`shared/schemas/`). Do not edit generated files directly.
- `assets/`, `dev_assets_seed/`, `dev_assets/`: Packaged and local dev assets.
- `npx-cli/`: Files published to the npm CLI package.
- `scripts/`: Dev helpers (ports, DB preparation).
- `docs/`: Documentation files.

### Crate-specific guides
- [`crates/remote/AGENTS.md`](crates/remote/AGENTS.md) — Remote server architecture, ElectricSQL integration, mutation patterns, environment variables.
- [`docs/AGENTS.md`](docs/AGENTS.md) — Mintlify documentation writing guidelines and component reference.
- [`packages/local-web/AGENTS.md`](packages/local-web/AGENTS.md) — Web app design system styling guidelines.

## Local and Remote Web Parity
- For every web UI or behavior change, inspect both the local and remote web surfaces. Check `packages/local-web`, `packages/remote-web`, and shared `packages/web-core` entry points; do not assume shared components have identical shell wiring or gates.
- If only one surface needs a code change, verify and report why the other surface already behaves correctly or is out of scope.

## Managing Shared Types Between Rust and TypeScript

ts-rs allows you to derive TypeScript types from Rust structs/enums. By annotating your Rust types with #[derive(TS)] and related macros, ts-rs will generate .ts declaration files for those types.
When making changes to the types, you can regenerate them using `pnpm run generate-types`
Do not manually edit shared/types.ts, instead edit crates/server/src/bin/generate_types.rs

For remote/cloud types, regenerate using `pnpm run remote:generate-types`
Do not manually edit shared/remote-types.ts, instead edit crates/remote/src/bin/remote-generate-types.rs (see crates/remote/AGENTS.md for details).

## Build, Test, and Development Commands
- Install: `pnpm i`
- Run dev (web app + backend with ports auto-assigned): `pnpm run dev`
- Backend (watch): `pnpm run backend:dev:watch`
- Web app (dev): `pnpm run local-web:dev`
- Type checks: `pnpm run check` (frontend + all backend Rust workspaces) and `pnpm run backend:check` (all backend Rust workspaces, including `crates/remote`)
- Rust tests: `cargo test --workspace`
- Generate TS types from Rust: `pnpm run generate-types` (or `generate-types:check` in CI)
- Prepare SQLx (offline): `pnpm run prepare-db`
- Prepare SQLx (remote package, postgres): `pnpm run remote:prepare-db`
- Local NPX build: `pnpm run build:npx` then `pnpm pack` in `npx-cli/`
- Format code: `pnpm run format` (runs `cargo fmt` for all backend Rust workspaces + web-core/web Prettier)
- Lint: `pnpm run lint` (runs web/ui ESLint + `cargo clippy` for all backend Rust workspaces)

## Before Completing a Task
- Run `pnpm run format` to format all Rust workspaces and web code.

## Coding Style & Naming Conventions
- Rust: `rustfmt` enforced (`rustfmt.toml`); group imports by crate; snake_case modules, PascalCase types.
- TypeScript/React: ESLint + Prettier (2 spaces, single quotes, 80 cols). PascalCase components, camelCase vars/functions, kebab-case file names where practical.
- Keep functions small, add `Debug`/`Serialize`/`Deserialize` where useful.

## Testing Guidelines
- Rust: prefer unit tests alongside code (`#[cfg(test)]`), run `cargo test --workspace`. Add tests for new logic and edge cases.
- Web app: ensure `pnpm run check` and `pnpm run lint` pass. If adding runtime logic, include lightweight tests (e.g., Vitest) in the same directory.

## Security & Config Tips
- Use `.env` for local overrides; never commit secrets. Key envs: `FRONTEND_PORT`, `BACKEND_PORT`, `HOST` 
- Dev ports and assets are managed by `scripts/setup-dev-environment.js`.

## Private Work and User Data
- Never commit real work or user data: account identifiers, private repository/PR/issue relationships, incident details, conversations, usage snapshots, runtime databases, connector state, credentials, logs, or screenshots. This also applies to tests, fixtures, examples, documentation, filenames, and commit messages.
- Keep local captures and work material under the Git-ignored `/.private/` or `/artifacts/` directories. Runtime data belongs in existing ignored data directories or outside the checkout. Add a precise shared `.gitignore` rule before creating a new local data path; never use `git add -f` to bypass it.
- Tests and examples must use entirely synthetic accounts, repositories, identifiers, branches, timestamps, and payloads. Preserve the behavior being tested without copying live usage data or an identifiable real incident; changing only a title or SHA is insufficient.
- Before committing, inspect `git diff --cached --name-status` and the staged content for private data. Before publication, inspect every outgoing commit, including files later deleted and commit messages; a clean final tree alone is insufficient.
- `.gitignore` does not remove already tracked files or historical content. If private data is found, stop publication, preserve any needed local copy in an ignored location, remove or replace the tracked data, and sanitize all affected unpublished history and local refs. Rewriting published history requires explicit user authorization.

## Local Planning Documents & Preview Artifacts
- Keep task-specific plans, design notes, verification reports, review write-ups, and preview artifacts local. Save file-based deliverables (HTML, SVG, Mermaid, screenshots, PDFs, etc.) under the Git-ignored `/artifacts/` directory.
- Do not stage, commit, or include these temporary outputs in pull requests unless the user explicitly requests versioning the specific files. Creating or attaching a deliverable does not authorize adding it to Git. Never bypass ignore rules with `git add -f`.
- Before committing, inspect `git diff --cached --name-status` and exclude temporary documents and artifacts. When removing an already tracked local deliverable, preserve its local copy with `git rm --cached -- <path>` and add a precise ignore rule.
- Maintain established product documentation, README files, agent guidelines, application HTML entry points, and test fixtures as required by the task; these remain versioned project files.


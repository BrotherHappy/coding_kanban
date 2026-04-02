# Repository Guidelines

## Repository Scope

- This repository root is for a new agent orchestrator project built in this workspace.
- `vibe-kanban/` is not part of this project implementation scope.
- `vibe-kanban/` may be used as a reference for product ideas, interaction patterns, or architecture inspiration only.
- Do not add new project code inside `vibe-kanban/` unless the user explicitly asks to modify that external reference project.

## Project Structure & Module Organization

- `apps/web/`: React + TypeScript frontend app. Place page shells, orchestrator UI, session board views, and active-agent detail views under `src/`.
- `apps/server/`: Node.js + TypeScript backend. Place HTTP routes, WebSocket handlers, orchestration services, discovery flows, and runtime adapters under `src/`.
- `packages/shared/`: Shared types, DTOs, enums, validation schemas, and cross-app constants. Keep transport-neutral contracts here.
- `packages/agent-protocol/`: Agent runtime event schemas and adapter-facing protocol definitions for registration, telemetry, control, and discovery.
- `packages/ui/`: Reusable frontend UI primitives if the web app grows beyond a single app-local component set.
- `scripts/`: Local development helpers such as host setup, tmux inspection, seed data, or release scripts.
- `docs/`: Product notes, design docs, architecture decisions, and protocol documentation.

### Service Boundaries

- Keep orchestration state and focus management in backend services, not in transport adapters.
- Keep transport-specific logic isolated inside adapters for `local-process`, `remote-launch`, and `remote-tmux`.
- Treat agent sessions as the primary domain object. Do not make terminal IDs or tmux pane IDs the public application model.

## Core Domain Model

- `workspace`: logical container for related agent sessions.
- `host`: local or remote execution target.
- `agentSession`: primary control object tracked by the orchestrator.
- `transportRef`: implementation detail pointing to a PTY, process, SSH command, or tmux pane.
- `telemetryEvent`: output activity, heartbeat, prompt detection, attach state, or exit signal emitted by an adapter.

## Build, Test, and Development Commands

- Install dependencies: `pnpm install`
- Start all dev services: `pnpm dev`
- Start frontend only: `pnpm --filter web dev`
- Start backend only: `pnpm --filter server dev`
- Run type checks: `pnpm check`
- Run lint: `pnpm lint`
- Run tests: `pnpm test`
- Format code: `pnpm format`

The root `dev` command prebuilds `packages/shared` once before starting the
frontend and backend dev processes. Direct `web` and `server` `dev` and
`build` scripts also prebuild `packages/shared` so workspace types stay in
sync for package-scoped runs.

If workspace filters or script names change, update this file in the same change.

## Before Completing a Task

- Run `pnpm format`.
- Run the narrowest relevant verification first, then run any broader checks affected by the change.
- For backend protocol or shared type changes, run both frontend and backend type checks.

## Coding Style & Naming Conventions

- TypeScript everywhere by default unless there is a strong reason not to.
- Use 2-space indentation, single quotes, and keep lines near 80 columns unless readability clearly improves.
- Use PascalCase for React components, camelCase for variables and functions, and kebab-case for non-component file names.
- Keep modules focused. Split adapters, registry logic, telemetry inference, and routing concerns instead of building large service files.
- Prefer explicit domain names like `agentSession`, `interactionState`, and `activeAgentId` over generic names like `item` or `data`.
- Avoid leaking raw transport output parsing into UI components.

## Frontend Guidelines

- Build the UI around three layers: orchestration store, container views, and presentational components.
- The page model is `workspace -> agent sessions`, not `terminal -> pane`.
- Use a single active-agent focus model. Keyboard input should target exactly one active session unless a later feature explicitly introduces broadcast mode.
- Reserve `xterm.js` or terminal widgets for the active-session detail area, not as the top-level abstraction for the whole product.
- Keep status UI honest: show explicit versus inferred states when heuristics are involved.

## Backend Guidelines

- Expose separate surfaces for registry, telemetry, control, and discovery/launch.
- Normalize adapter events into a shared protocol before they reach route handlers or WebSocket broadcasters.
- Keep tmux integration behind a dedicated adapter. Do not spread tmux command construction across unrelated services.
- Use WebSocket for live session state and output updates; use HTTP for lifecycle and configuration actions.
- Treat `awaiting_input` as a derived state unless an adapter emits an explicit input-request signal.

## Testing Guidelines

- Add unit tests for telemetry inference, focus routing, and adapter normalization logic.
- Add integration tests for session registration, active-agent switching, stdin routing, and discovery flows.
- For frontend behavior, cover board ordering, active-agent indicators, and state badges with component or integration tests.
- Prefer testing the session orchestration layer rather than brittle transport implementation details.
- When testing, if possible, try to use Playwright for real browser scenario testing.
- 如果一个问题可能要端到端才会发生或者因此用户频繁操作，你需要用浏览器做端到端测试，在修复完之后补充这个端到端测试到tests/e2e



## Security & Config Tips

- Never commit host credentials, SSH keys, or machine-specific secrets.
- Keep local overrides in `.env` files that are ignored by git.
- Validate all host, path, and launch inputs on the backend before executing commands.
- Sanitize or strictly control tmux and shell command arguments to avoid command injection.
- Make destructive control actions like interrupt, restart, or attach takeover explicit in the UI.

## Documentation Expectations

- Record architecture decisions in `docs/` when introducing a new adapter, protocol event, or orchestration state rule.
- Update this file when project structure, command names, or core workflow expectations change.

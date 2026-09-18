# Agentopolis v1 — implementation roadmap

> **For agentic workers:** this file is the map, not a plan. Each slice below gets its own plan
> file (`docs/superpowers/plans/2026-09-18-slice-NN-<name>.md`) written by the supervisor after
> the previous slice is reviewed. Execute a slice's plan with
> superpowers:subagent-driven-development or superpowers:executing-plans. Never start a slice
> whose plan file does not exist yet.

**Spec:** `docs/superpowers/specs/2026-09-18-agentopolis-v1-design.md` — read it in full before
slice 1; re-read the sections a slice names before that slice.

## How work is delivered

- One slice = one branch `slice/NN-<name>` from `master`, one PR, one review by the supervisor
  (a separate session; the owner carries messages between the two). Merge to `master` only
  after the supervisor says so. Never push to `master` directly.
- The implementer works in this checkout on its slice branch. No worktrees are needed until
  slice 6 makes the daemon create them for agents.
- Stage explicit paths, never `git add -A`. Commit after every green step. Messages in English:
  `type(scope): clause`. Multi-line bodies via `git commit -F <tempfile>`.
- **The report at the end of a slice** (posted as the PR description and told to the owner) has
  four parts: the commands run and their output (test count, exit code), what was verified by
  running versus by reading, anything noticed and not fixed (`NOTICED (not fixed)`), and the
  exact versions installed (`pnpm ls --depth 0`). A claim without its command is not a report.
- Anything the spec does not settle and that changes the outcome is a question to the owner,
  one at a time, before continuing. Anything else the implementer decides and records in the
  report.
- Scope discipline (spec principle: the endeavour is what was asked): a discovery outside the
  slice goes into `docs/superpowers/plans/PARKED.md` as one line, never into the slice.

## Global constraints (every slice)

- TypeScript strict, Node LTS (record the exact version in the first report), pnpm, ESM.
- Libraries: only those in spec section 16 plus their types. Adding one is a question.
- Tests with vitest; lint and format with Biome; both must pass before a report.
- No secrets in any file under the repo or the home folder; tokens come from the environment.
- Money is integer micro-USD; time is integer epoch-ms UTC through the `Clock` port.
- Every module behind a port with a permanent fake (spec section 3).
- The CLI is never invoked for real in CI; only the `--live` contract suite and the section 18
  checks touch it, by hand, on the owner's Mac.

## Slices

| # | name | spec sections | delivers | done when |
|---|---|---|---|---|
| 1 | store and loader | 2, 4, 5 | package scaffolding, zod schemas for the four YAML kinds, the home-folder loader with last-good snapshot and secret rejection, SQLite opened with the spec's pragmas, Drizzle schema and migrations for every table in section 5, append helpers for `messages`/`events`/`outbox`/`inbox`, the pending-messages query, money and clock ports | `pnpm test` green with the tests listed in the slice plan; `pnpm biome check` clean; a script `pnpm agentopolis init <dir>` creates a valid home folder from `examples/home/` and opens its database |
| 2 | engine | 7, 8, 10 (tiers 1–2), 13, 18 | the `AgentRunner` port and its CLI implementation: argv builder, spawn in a process group, NDJSON parser for every message type, control channel (`can_use_tool` parked, interrupt), usage and session recording, wall-clock watchdog, two-stage stop; `fake-claude` with fixtures and the dual-target contract suite; the `agentopolis-mcp` stdio server over a unix socket; the six live checks run by hand and their answers written into the spec | contract suite green against the fake; the same suite green with `--live` on the owner's Mac for the happy path; live-check answers committed |
| 3 | Slack mirror | 9 | the `Chat` port and its Bolt implementation: outbox pump with per-channel bucket and bounded retries, inbox with ack-after-write and two dedup keys, personas with scope fallback, cards (ask, approval, task), modals (`/hire`, `/edit`, `Rispondi`), App Home with per-agent overflow menus, the four slash commands, limits module; the fake Slack | fake-Slack suite green; against the owner's real workspace by hand: a persona message, an ask card answered, a modal submitted, Home rendered |
| 4 | router and scheduler | 3, 6, 10 (pause) | `AgentLoop` with dirty flag and global cap, wake rules, envelope delivery (the turn's result is the message, `--json-schema`), derived open-ask state, pause, approvals state machine with expiry, the daemon process itself (boot, migrations, loader watch, shutdown, `/healthz`), the limit pause from `rate_limit_event`, live check 7 | property suites green; crash-recovery test green; the daemon runs on the Mac against the fake CLI and the real Slack workspace and answers in `#ceo` |
| 5 | roles and prose | 11 (protocol), 12, 4 (`STYLE.md`) | the four role folders (`role.yaml`, `AGENT.md`), the `research` and `design` subagent definitions passed with `--agents`, `STYLE.md`, prompt composition and the first-user-message pack, session rotation with a pack built from the store, `remember` applied from the envelope, the ceo's welcome and conditional digest | with the real CLI on the Mac: the ceo greets and answers in the owner's language; a prose edit reaches the next turn with one uncached turn only (done-when 6); a developer turn spawns `research` (done-when 9) |
| 6 | development tasks | 11 | `open_task`/`close_task`, git worktrees, task threads and cards, job-agent hiring from the name pool, reviewer summary and read-only worktree, `merge_production` gate with the PreToolUse hook, `PARKED` handling | done-when 3 end to end on this repository, with the fake developer replaced by the real CLI for one trivial task |
| 7 | deploy | 13 (supervision), 15, 16 | systemd unit with notify/watchdog/`KillMode=mixed`, `EnvironmentFile`, Litestream, `runs/` rotation, OpenTelemetry wiring and the metrics list, `/healthz` and `/diag`, install doc for the owner (manifest paste, two tokens, first hire), live check 6 on the VPS | every line of spec section 15 holds on the VPS |

Slices 1 and 2 need no Slack workspace. Slice 3 needs the workspace and the two tokens in the
owner's environment on the Mac. The owner creates the app from the manifest in spec section 9.

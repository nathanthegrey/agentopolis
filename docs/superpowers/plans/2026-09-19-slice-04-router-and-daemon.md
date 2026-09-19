# Slice 4: router, scheduler and the daemon — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Merge to `master` only when the supervisor's message contains the word "merge" as an instruction.** You are a fresh session: read the spec in full first, then the roadmap, then this plan.

**Goal:** the daemon itself. Slices 1–3 built the store, the CLI engine and the Slack mirror as
separate parts; this slice connects them into one process that wakes agents when something is
addressed to them, delivers what their turns produce, holds and parks permissions, enforces the
guards the spec puts on the daemon, survives a crash, and answers in the ceo's direct message.

**Architecture:** one `AgentLoop` per agent (dirty flag + mutex) under a global concurrency cap;
the pending set is a query, never a queue. A turn's result is an **envelope** validated by the
same JSON schema passed to the CLI; the daemon delivers its messages, applies `remember`, and
records parked discoveries as tasks. Permissions are **held** for a few minutes with a card
already on the phone, then **parked** with a model-readable deny. Guards (loop guard, rung
counter, back-off and limit pause) are counters over rows. `src/daemon.ts` boots everything,
watches the home folder, exposes `/healthz`, and shuts down in order.

**Tech Stack:** as before, plus `p-limit`, `chokidar`, `croner`, `fast-check`, `pino`.

**Spec:** `docs/superpowers/specs/2026-09-18-agentopolis-v1-design.md`, sections 2, 3, 5, 6, 7,
8, 10, 13, 14, 18; the owner's decisions in
`docs/superpowers/plans/2026-09-19-studies-review-and-model-policy.md` (A2, A3, A5, A7, A8, A9,
D1, D3, E). Roadmap: `docs/superpowers/plans/2026-09-18-agentopolis-v1-roadmap.md`.

## Global Constraints

- Branch `slice/04-router-and-daemon` from `master` (after PR #3, `4bbef12`). PR at the end.
- `pnpm test` never touches Slack or the real CLI. The daemon under test uses `fake-claude` and
  `FakeChat` (a `--fake` mode, section Task 9). Live checks 7–9 are the owner's, by hand.
- Every counter the daemon enforces is derived from rows (never an in-memory flag that a crash
  could leave set); every state change writes its `events` row in the same transaction.
- A turn is never re-run automatically after a crash (spec 13); a wake is never lost (the
  pending set replays).
- Money integer micro-USD; time via `Clock`; ids via `Ids`; ports with permanent fakes.
- Verify library APIs against the installed versions; record them in the report.
- Stage explicit paths; commit after every green step; Biome clean before the report.

## File structure

```
src/config/schemas.ts        (modify) re-aligned with spec 4: remove budgets, daily_digest_at; add permission_hold_minutes, gated, loop_guard; role menu, max_minutes, subagents
src/store/schema.ts          (modify) agents columns for job rows; tasks.status parked; requests.status without snoozed; migration 0003
src/turn/envelope.ts         Envelope zod schema + JSON schema; deliverEnvelope()
src/turn/prompt.ts           buildTurnPrompt(): state header, pending messages, outcomes, remembered
src/turn/spec.ts             buildTurnSpec(): TurnSpec from snapshot + store (argv pieces, --agents JSON, settings, mcp config, --json-schema)
src/scheduler/agent-loop.ts  AgentLoop: wake(), runLoop(), one turn at a time, dirty flag
src/scheduler/scheduler.ts   all loops, global cap, pause, boot replay, interrupted turns, orphan reap
src/governance/permissions.ts PermissionBroker: rules → hold (card) → park (deny text) → re-wake on decision
src/governance/approvals.ts  requests state machine: gated values, merge_production, expiry, epochs, Riapri
src/governance/guards.ts     loop guard, rung counter, back-off, limit pause (all row-derived)
src/actions/daemon-actions.ts DaemonActions + DaemonReads implementation (hire, edit, undoEdit, pause, resume, setModel, restart, retire, diag, openParked, answer, approve, deny, reply)
src/daemon.ts                boot, watch, /healthz, shutdown; `agentopolis start <home> [--fake]`
tools/live-checks/run.ts     (modify) checks 7, 8, 9
tests/turn/*, tests/scheduler/*, tests/governance/*, tests/actions/*, tests/daemon/*
```

---

### Task 1: schema re-alignment (config, roles, agents, store)

**Files:** modify `src/config/schemas.ts`, `src/store/schema.ts`, `examples/home/**`, fixtures;
new migration `drizzle/0003_*.sql` via `pnpm db:generate`.

**Changes (spec section 4 and 5, exactly):**
- `ConfigFile`: remove `budgets`, `daily_digest_at`; add `permission_hold_minutes` (positive,
  default 5), `gated: { models: string[] (default ["fable"]), research: { models: string[]
  (default ["opus","fable"]), effort: boolean (default true) } }`, `loop_guard: { messages:
  int (default 12), review_rejections: int (default 3) }`. Keep `slack.apps`, `job_names`,
  `max_concurrent_turns`, `approvals.timeout_hours`, `language`.
- `RoleFile`: replace `budget`/`max_turns`/`max_wall_clock_minutes` with `max_minutes` (int,
  default 45); add `menu: { models: string[], efforts: string[] }` (optional; job roles);
  `subagents: string[]` (default []). Reject `effort: xhigh` and `menu.efforts` containing
  `xhigh` (owner: never).
- `AgentFile`: remove `budget_monthly_usd`; keep `slack_app`, `model`, `effort`, `paused`.
- Store: `agents` gains `role`, `display`, `project`, `reports_to`, `kind` (standing/job),
  `task_id`, `retired_at`; `tasks.status` enum gains `parked` and `blocked`; `requests.status`
  loses `snoozed`; new table `task_counters` is **not** created: counters are queries (Task 6).
- Loader: standing agents from folders are upserted into `agents` at boot (Task 9); job agents
  exist only as rows.

- [ ] Steps: update tests first (schemas, loader fixtures, db table list), run red, implement,
  regenerate the migration, run green, commit `refactor(schema): align config, roles, agents and store with spec sections 4–5 (guards, gated, loop guard, job rows)`.

---

### Task 2: the envelope

**Files:** create `src/turn/envelope.ts`; test `tests/turn/envelope.test.ts`

**Interfaces:**
```ts
export const Envelope = z.strictObject({
  messages: z.array(z.strictObject({
    container: z.string(),            // container name as shown in the prompt, e.g. "dm:owner", "task:12"
    to: z.string(),                   // member name or "owner"
    kind: z.enum(["say", "ask", "report"]),
    body: z.string().min(1),
    tests_green: z.boolean().optional(),   // required when kind === "report" and the author is a developer/designer
  })).default([]),
  remember: z.array(z.string().min(1)).default([]),
  parked: z.array(z.strictObject({ title: z.string().min(1), why: z.string().min(1) })).default([]),
});
export const ENVELOPE_JSON_SCHEMA: object;   // the same shape as JSON Schema, passed with --json-schema
export function deliverEnvelope(db, clock, snapshot, agent: string, env: Envelope): DeliveryResult
```
`deliverEnvelope`, in one transaction: resolves each container name to a `containers` row the
agent is a member of (else the message is dropped with an `events` row `envelope.rejected`
naming the reason, and the agent is told in its next prompt); refuses `to` outside the
container's members; appends messages (slice 1 `appendMessage`); a `report` from a
developer/designer without `tests_green` is rejected the same way; `remember` lines are
appended to the standing agent's `MEMORY.md` (with the previous content stored in the `events`
row) and recorded as `memory.appended`; `parked` becomes `tasks` rows with status `parked` and
project = the agent's project; `answered_by` is set on the ask an owner reply answers.

- [ ] Steps: failing tests (valid envelope delivered with rows and outbox; unknown container
  rejected with event; `to` not a member rejected; report without `tests_green` from a developer
  rejected, from a lead accepted; remember appends and stores previous content; parked creates
  tasks rows; JSON schema is valid per the CLI's validator shape and matches the zod schema for
  the four fixtures) → implement → PASS → commit `feat(turn): the envelope schema, its JSON schema and delivery`.

---

### Task 3: turn prompt and turn spec

**Files:** create `src/turn/prompt.ts`, `src/turn/spec.ts`; tests `tests/turn/prompt.test.ts`, `tests/turn/spec.test.ts`

**`buildTurnPrompt(input)`** returns deterministic text:
1. `# Stato` header: agent name and role, containers it belongs to with their names, open asks to
   the owner (count), pending requests and permissions with their ids and states, last turn's
   cost "stimato" and cache hit ratio, current model/effort rung.
2. `# Messaggi nuovi`, grouped by container in id order: `[#id] author (kind): body`.
3. `# Esiti`: outcomes of requests/permissions decided since the last turn (approved/denied/
   expired, with the owner's text if any).
4. `# Ricordato da poco`: `remember` lines applied since the session started.
5. The closing instruction: respond only with the envelope; a `deny` that says "parked" ends the
   turn; never call `post` unless a message must leave before the turn ends.

**`buildTurnSpec(snapshot, db, ids, agentName, opts)`** returns the slice 2 `TurnSpec`: model
and effort from the agent row override → role default → (job agents) the rung stored on the
task; `--agents` JSON built from `roles/<role>/subagents/*.md` (frontmatter + body) with the
gated substitutions applied only when an approved request says so; `settings` from
`buildSettings` with the project's production branches; `mcpConfig` from `buildMcpConfig`;
`extraArgs: ["--json-schema", JSON.stringify(ENVELOPE_JSON_SCHEMA)]`; `maxTurns 60`,
`maxBudgetMicro 5_000_000`, `wallClockMs = role.max_minutes * 60_000`; `sessionId` from the
agents row or a new uuid (stored before spawn); `cwd` = the task worktree for job agents (slice
6 creates it; until then the project's repo path) or the agent's folder.

- [ ] Steps: failing tests (prompt byte-stable for the same input; sections omitted when empty;
  spec resolves model/effort precedence; `--agents` JSON has the research definition with
  Sonnet/medium and no gated model unless approved; sessionId stored before spawn) → implement →
  PASS → commit `feat(turn): deterministic turn prompt and TurnSpec assembly`.

---

### Task 4: AgentLoop and scheduler

**Files:** create `src/scheduler/agent-loop.ts`, `src/scheduler/scheduler.ts`; tests
`tests/scheduler/agent-loop.test.ts`, `tests/scheduler/scheduler.property.test.ts`

**AgentLoop** (≈60 lines):
```ts
class AgentLoop {
  #dirty = false; #running = false;
  wake(reason: string): void { this.#dirty = true; if (!this.#running) void this.#run(); }
  async #run() { this.#running = true; try { while (this.#dirty) { this.#dirty = false; await this.#oneTurn(); } } finally { this.#running = false; } }
  async #oneTurn() {
    if (paused(agent) || limitPaused() || rungRefused(agent)) return;      // Task 6/7 predicates, row-derived
    await limit(async () => {                                              // global p-limit
      const pending = pendingFor(db, agent); if (pending.length === 0 && !outcomesPending(agent)) return;
      const turn = insertTurn(running); recordDelivery(db, turn.id, pending.map(m => m.id));
      const outcome = await runner.run(buildTurnSpec(...), events);        // events: onPermission → PermissionBroker, onRateLimit → guards
      finishTurn(turn.id, outcome); if (outcome.structuredOutput) deliverEnvelope(...); else markEnvelopeMissing(turn);
    });
  }
}
```
**Scheduler**: holds one loop per agent (created lazily from the snapshot and the `agents`
rows), `wakeAgent(name)`, `wakeAll()` on boot (replay: any agent with a pending message or a
pending outcome is woken), marks `turns` still `running` at boot as `interrupted` with a
`system` note to the agent, reaps orphan processes whose env carries `AGENTOPOLIS_TURN_ID`
(`pgrep -f`), runs declared schedules with croner (each fire posts a `system` message to the
agent, which wakes it), and exposes `stop()` (stop wakes, drain in-flight turns with a bound).

- [ ] Steps: failing tests: a post wakes the addressee once; two posts during a turn produce
  exactly one more turn that reads both; a paused agent is not run; the cap holds (fast-check:
  over random interleavings of posts/pauses, never two concurrent turns per agent, every message
  delivered exactly once, none before creation); boot marks running turns interrupted and replays
  wakes → implement → PASS → commit `feat(scheduler): AgentLoop with dirty-flag coalescing, global cap, boot replay and interrupted turns`.

---

### Task 5: permissions (hold, then park) and approvals

**Files:** create `src/governance/permissions.ts`, `src/governance/approvals.ts`; tests `tests/governance/permissions.test.ts`, `tests/governance/approvals.test.ts`

**PermissionBroker.onPermission(agent, turnId, req)**:
1. `decide(role, req)` → `allow`/`deny` returned at once (rules).
2. `parked`: insert `permission_requests` (pending), render the approval card through the outbox
   (company app, in the agent's owner-facing container: the lead's DM/`-hq` for a lead, the task
   thread for a job agent) with **Approva** / **Approva per questo compito** / **Nega** /
   **Dettagli**; then **wait** up to `permission_hold_minutes` for a decision (a promise resolved
   by `DaemonActions.approve/deny`, keyed by the request id; a `FakeClock`-driven timer in tests).
3. Decision in time → return `allow` (with the task-scoped rule stored when "per questo compito")
   or `deny`; the card is rewritten with the outcome.
4. Timeout → return `deny` with the exact text: `Parcheggiato per il proprietario: chiudi ora il
   turno con la tua busta; sarai risvegliato con la decisione.`; the row stays pending; when the
   button lands later, the row is decided, the card rewritten, and the agent is woken with the
   outcome in its next prompt (`# Esiti`).
5. Expiry: `approvals.timeout_hours` → `expired`, card "Scaduta…" with **Riapri**.

**Approvals (requests)**: `request(kind, payload)` from the MCP socket → row `pending`; kinds in
v1: `open_task` (gated model/effort → card "Ada chiede Fable per *<task>* · motivo: …", else
approved immediately and handed to slice 6's task opener, which in this slice is a stub that
records the intent), `close_task` (stub), `merge_production` (card, never expires). Epoch on
every card; a click with a stale epoch is refused ephemerally. Decisions produce `events` rows
and a wake of the requesting agent.

- [ ] Steps: failing tests (rule allow/deny immediate; parked renders a card and holds; button
  within the hold resolves allow and rewrites the card; timeout returns the exact deny text and
  keeps the row; a later button decides the row and wakes the agent; gated open_task renders the
  card with the reason; merge_production never expires; stale epoch refused) → implement → PASS
  → commit `feat(governance): permissions held then parked with a model-readable deny; requests with gated values and epochs`.

---

### Task 6: guards (loop guard, rung counter)

**Files:** create `src/governance/guards.ts`; test `tests/governance/guards.test.ts`

All predicates are queries:
- `loopGuardTripped(db, taskId)`: agent-authored messages in the task's container since the last
  owner message or status change ≥ `loop_guard.messages`, or rejected reviews ≥
  `loop_guard.review_rejections` (a rejected review = a `report` from a reviewer whose body starts
  with `RIFIUTATA` / a `review_rejected` event written by slice 6; in this slice the event is the
  contract). When tripped: task → `blocked`, card rewritten with **Sblocca** / **Chiudi**,
  `system` note to the task's agents, no wake for them until the owner presses; counters reset on
  any owner message in the thread.
- `rungRefused(db, agent)`: for a job agent, two `report`s with `tests_green: false` on the
  current (model, effort) rung, or two rejected reviews on that rung → no further turn on that
  rung; the lead gets a `system` note ("Nina è ferma sul gradino Sonnet/high: riapri un gradino
  sopra o chiedi al proprietario"). A rung change (slice 6 reopens the task) resets it.

- [ ] Steps: failing tests for each predicate and reset → implement → PASS → commit `feat(governance): task loop guard and per-rung failure counter, derived from rows`.

---

### Task 7: back-off and limit pause

**Files:** modify `src/governance/guards.ts`; test `tests/governance/limits.test.ts`

- `onRateLimit(info)`: `allowed_warning` or any window ≥ 0.9 → `max_concurrent_turns` becomes 1
  until the window's `resetsAt`; `status` not `allowed` (exhausted) → **limit pause**: no new
  turns until `resetsAt`, one owner message in the ceo DM, edited on each change ("Limite del
  piano raggiunto: riparto alle hh:mm"), the Home tab counts paused hours this month; a turn that
  fails with `api_retry` `rate_limit`/`overloaded` twice running → same pause with `resetsAt` from
  the last event or +15 min.
- State lives in `events` rows (`limit.pause`, `limit.resume`, `limit.backoff`) and is derived on
  boot.

- [ ] Steps: failing tests (warning → cap 1; exhausted → pause until resetsAt, one message
  edited not re-posted; resume at resetsAt; boot restores a pause from events) → implement →
  PASS → commit `feat(governance): back-off before the limit and the limit pause from rate_limit_event`.

---

### Task 8: DaemonActions and DaemonReads

**Files:** create `src/actions/daemon-actions.ts`; test `tests/actions/daemon-actions.test.ts`

Implements the slice 3 ports against the store and the snapshot: `hire(form)` (standing: write
`agents/<name>/agent.yaml` + empty `MEMORY.md`, require the app's tokens to be present in the
environment, upsert the row, open its DM, post its first `system` greeting; job hires are slice
6), `edit(agent, file, text)` / `undoEdit(agent)` (previous content in the `events` row),
`pause` / `resume` (row + `system` note + wake on resume), `setModel(agent, model)` (row,
gated check → card, new session), `restart(agent)` (new session id, `MEMORY.md` kept),
`retire(agent)` (standing: `retired_at`, DM archived note; job: slice 6), `diag(agent)` (last
turn: status, exit code, stderr tail, run file), `openParked(taskId)` (parked → open through
the lead: a `system` message to the lead with the title), `answer(renderId, index, user)` /
`reply(renderId, text)` (owner messages to the asker, `answered_by`), `approve/deny(renderId,
epoch, scope)` (permissions and requests). Reads: agents with state and month cost, open asks,
pending approvals, parked tasks, project list.

- [ ] Steps: failing tests per action with FakeChat/FakeClock and a temp home → implement →
  PASS → commit `feat(actions): the daemon's owner actions and reads behind the Slack dispatcher`.

---

### Task 9: the daemon process

**Files:** create `src/daemon.ts`; modify `src/cli/main.ts` (`agentopolis start <home> [--fake]`); tests `tests/daemon/boot.test.ts`, `tests/daemon/crash-recovery.test.ts`

**Boot order:** open db + migrate → `SnapshotHolder.open` → upsert standing agents → start the
Slack apps (or `FakeChat` in `--fake`) → `ensureChannels` → mark interrupted turns, reap orphans
→ start the outbox pump → start the scheduler and replay wakes → start the loader watch
(chokidar `awaitWriteFinish`, 300 ms debounce; on a good reload swap the snapshot and write
`config.reloaded`; on a bad one keep the old and post the errors in the ceo DM) → `/healthz` on
`127.0.0.1:<port>` (running turns, queue depth, last Slack event age, WAL bytes, limit state) →
sd-notify READY when available. **Shutdown (SIGTERM):** stop wakes → close Slack sockets → drain
in-flight turns up to 120 s → SIGINT children → flush the outbox → `wal_checkpoint(TRUNCATE)` →
exit 0. `--fake` selects `fake-claude` (fixture from `FAKE_CLAUDE_FIXTURE`) and `FakeChat`, and
prints inbound/outbound to stdout, so a whole company runs in CI with no Slack and no tokens.

- [ ] Steps: failing tests: boot creates the tables and the standing rows and answers `/healthz`;
  crash recovery: start the daemon as a child in `--fake` mode with a `hang` fixture, post an
  owner message, wait for the turn row `running`, `kill -9` the daemon, restart it, assert the
  turn is `interrupted`, the agent got the `system` note, the message is still delivered once and
  the loop ran again → implement → PASS → commit `feat(daemon): boot, watch, /healthz, ordered shutdown, --fake mode; crash recovery test`.

---

### Task 10: end to end in `--fake` mode, then on the Mac

- [ ] `tests/daemon/e2e.fake.test.ts`: fixture `envelope-hello.json` (the fake returns a valid
  envelope answering the owner in the ceo DM); the test posts an owner message through the fake
  inbox, and asserts the reply row, its outbox row, the turn's cost recorded, and one turn only.
- [ ] By hand, the owner: `agentopolis start ~/agentopolis-home --fake` with the real Slack
  (env `AGENTOPOLIS_FAKE_CLI=1` keeps the fake CLI but real Slack): writing in the Jarvis DM
  produces the fixture's reply from Jarvis. Then live checks 7, 8, 9 with the real CLI
  (`AGENTOPOLIS_LIVE=1 AGENTOPOLIS_CHECKS=7,8,9 pnpm live:checks`), answers recorded in spec
  section 18 on the branch.
- [ ] Commit `test(daemon): fake end-to-end; live checks 7–9 recorded`.

---

### Task 11: report and PR

- [ ] Full gate, `pnpm ls --depth 0`, PR with the roadmap's report format including the owner's
  live outputs verbatim. Tell the owner the PR number; stop. The supervisor reviews and merges.

## Self-review against the spec (plan author)

- Sections 6 (envelope, loop guard, routing, wake rules, prompt), 7 (`--json-schema`,
  `--agents`), 8 (three request kinds, gated answer), 10 (three tiers, hold then park, rung
  counter, runaway guards), 13 (interrupted turns, orphans, limit pause, back-off,
  compact_boundary line is Task 4's runner events → a `system` line on the task card), 14 (fake
  daemon, property, crash), 18 (7–9): all mapped above.
- Not here by design: role prose and `STYLE.md` (slice 5: the fake daemon runs with the stub
  `AGENT.md` files of `examples/home`), worktrees and task cards' full lifecycle (slice 6), the
  systemd unit (slice 7).

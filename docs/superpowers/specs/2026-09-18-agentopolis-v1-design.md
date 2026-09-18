# Agentopolis v1 — design

Status: approved in conversation with the owner on 2026-09-18, then revised the same day after
five scout reviews (architecture, token efficiency, CLI engine, open-source Slack agent
repositories, owner usability) and hand verification of the load-bearing claims against the
installed Claude Code CLI 2.1.276 and the official docs. Written for the agent that will
implement it. The owner is not a programmer: every rule here that touches him must be visible
from Slack, never only from a file.

Evidence marks used below: **[verified]** read or run by the spec author on 2026-09-18;
**[measured]** a probe run by a reviewer on this machine the same day, with the number quoted;
**[documented]** an official page; **[field]** what open-source implementations do; **[live
check]** to be settled by the implementer in the first task (section 18).

## 1. What it is

A company of AI agents run by one owner from Slack. Each agent is a folder of text files. Agents
address one colleague at a time, never a room. The owner sees every exchange, answers questions
with buttons, and approves anything that reaches the world. A daemon on the owner's VPS makes it
all happen; the agents' engine is the Claude Code CLI on the owner's subscription.

### v1 scope

- The daemon, the home folder, the SQLite store, the Slack app (one bot user).
- Six roles: `ceo`, `lead`, `developer`, `reviewer`, `scout`, `designer`.
- Standing agents (always on, resume their own conversation): `ceo`, one `lead` per project.
- Job agents (born for one task, resume within it, retire when done): `developer`, `reviewer`,
  `scout`, `designer`.
- Addressed messages, mirrored to Slack: a channel per standing agent, a thread per task, the
  owner a member of all of them.
- Approvals with buttons; per-agent budgets; pause; one question at a time; quiet hours.
- One project: this repository. The company's first work is its own v2.

### Out of v1

Email and a support role, ops, QA, writer, any web page, several machines, mid-turn budget
enforcement, any chat surface other than Slack, one Slack bot per agent (see 9, Identity, for
why this is a recorded road and not a closed door).

## 2. Principles

1. **Everything the system knows is a file or a row.** Roles, agents and projects are folders
   under git. Messages, turns, requests, approvals and usage are rows in SQLite. The daemon can be
   killed and restarted at any time and loses nothing already committed (`synchronous=FULL`,
   section 5).
2. **Addressed, never broadcast.** Every message has exactly one addressee. Only the addressee
   wakes, and only the addressee receives it in its turn. The owner is a member of every channel
   and thread by right and reads everything at zero token cost, because Slack is read by the
   daemon, not by a model. A lead never reads a task thread; it reads what is addressed to it. An
   agent may address the owner directly (`post(to: owner)`), which skips the lead entirely: a
   question routed through the lead would cost two lead turns on the largest context in the
   company. Cost grows with the work, not with the number of colleagues.
3. **Wake on event, never on a clock.** An agent runs a turn because something was posted to it,
   an approval came back, or a schedule it declared fired. There is no heartbeat, and no probe
   loop: even the subscription limit is read from an event the CLI emits on every turn (13).
4. **The daemon enforces; prose advises.** Anything that must hold (approvals, budgets, pause,
   one question at a time, production branches) is enforced where the agent can only ask: a
   `PreToolUse` hook for absolutes, the permission channel for judgement calls, the daemon's own
   git operations for branches. Role prose explains the rule; it never carries it alone.
5. **Numbers are measured or absent, and cost figures are estimates.** Costs come from the CLI's
   result event, which the docs call a client-side estimate that must not drive billing
   [documented]; on a subscription they correspond to no invoice. Every figure shown to the owner
   is labelled "stimato". A turn without a cost record is stored as unknown, never estimated.
6. **Adding or changing an agent is editing a folder.** No rebuild, no restart. Prose edits reach
   the agent on its next turn because the daemon passes `--system-prompt-snapshot off`
   [verified, section 7]; memory edits reach it through the turn prompt (8).
7. **The owner's language.** Agents write to the owner in Italian, in one shared style
   (`STYLE.md`). Files, code, commits and logs are in English.
8. **Token rules, enforced by the daemon:**
   - only the addressee is billed (principle 2);
   - every agent resumes its own CLI session with `--resume`: a resumed turn was measured at
     14× cheaper than a fresh one (188 vs 14,482 cache-creation tokens) [measured]; the saving
     holds within the one-hour cache lifetime the subscription grants inside plan usage
     [verified], which the daemon pins with `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`;
   - the daemon injects the new messages into the turn prompt; `read_channel` exists only for
     back-scroll on demand, because every tool call is one more full-context request;
   - the owner's personal hooks, CLAUDE.md and MCP servers never enter an agent's turn
     (`--setting-sources ""`, `--strict-mcp-config`): they were measured at ~6,000 tokens and
     foreign instructions per turn [measured];
   - long deliverables are files in the worktree (`reports/<task>.md`, `design/…`); the message
     carries a summary of at most five lines;
   - the composed prompt has a stable order (role, style, instance, project) so the prompt cache
     covers it; memory and project knowledge travel as the first user message of a session, not in
     the system prompt, so a `remember()` write cannot invalidate the prefix;
   - a session is rotated (fresh id, seeded from a daemon-written `STATE.md`) when its input
     passes 120,000 tokens or it is 30 days old, and `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`
     caps what the CLI itself will carry (the default compaction point is ~967,000 tokens
     [verified]; the variable's minimum is 100,000 [verified]);
   - status lines, receipts, `/costs`, the Home tab are written by the daemon: zero tokens;
   - no heartbeat, no unrequested digest; the ceo is never copied on owner ⇄ lead traffic;
   - `--max-budget-usd` and `--max-turns` per turn plus a wall-clock watchdog kill a runaway loop;
   - a task's close delivers the report to the lead, never the thread.

## 3. Architecture

```
┌──────────────── Slack (one app, Socket Mode) ────────────────┐
│  #ceo   #agentopolis   #agentopolis-work (threads)   Home tab │
└───────────────▲───────────────────────────────┬──────────────┘
                │ outbox pump (personas)         │ inbox (events, buttons, modals)
┌───────────────┴───────────────────────────────▼──────────────┐
│                      agentopolis daemon (Node/TS)             │
│  loader ─ router ─ scheduler ─ runner ─ approvals ─ mirror    │
│  store (SQLite, single writer)   unix socket for the MCP tool │
└──────▲──────────────────────────────▲─────────────────────────┘
       │ reads/watches                 │ spawns per turn (process group)
~/agentopolis/ (git)            claude -p … (subscription login)
  roles/ agents/ projects/          └─ agentopolis MCP server (stdio, socket client)
```

Modules, each one job, each behind a port with a permanent fake (`Store`, `Clock`, `Chat`,
`AgentRunner`, `Git`, `Fs`, `Ids`):

- **loader**: reads and validates `roles/`, `agents/`, `projects/`, `config.yaml` (zod); watches
  with chokidar (`awaitWriteFinish`, ~300 ms debounce); builds an immutable snapshot and swaps one
  reference atomically; a malformed file is rejected with a `#ceo` message and the last good
  snapshot stays; a config file containing a value that looks like a Slack token is rejected.
- **store**: SQLite through better-sqlite3 + Drizzle; WAL, `synchronous=FULL`, `busy_timeout`;
  the daemon is the only writer; migrations generated and applied at boot in a transaction; boot
  refuses a database newer than the binary.
- **router**: turns a posted message into a wake for its addressee, applying pause, budget and
  the question hold (all derived from rows, never from in-memory flags).
- **scheduler**: one `AgentLoop` per agent (dirty flag + async mutex; a wake during a turn marks
  dirty and the loop runs again, reading everything pending, which is coalescing for free); a
  global concurrency cap (`p-limit`, 2–3 on the VPS); declared cron schedules (croner).
- **runner**: builds and spawns the `claude -p` process for one turn, streams its NDJSON,
  answers permission requests on the control channel, records usage and session id, enforces the
  wall-clock watchdog.
- **approvals**: holds requests, renders them to Slack, applies decisions, snoozes, expires.
- **mirror**: outbox pump (per-channel 1 msg/s bucket, bounded retries, personas) and inbox
  (ack after durable write, dedup); turns Slack input into rows.
- **mcp server** (`agentopolis-mcp`): a small stdio process spawned per turn that forwards tool
  calls over a unix socket to the daemon, authenticated by a per-turn token in its environment.
  It never opens SQLite.

## 4. Home folder

```
~/agentopolis/                      git repository; the daemon commits its own changes
  config.yaml
  STYLE.md         shared voice for every agent: tu form, decision first, ≤5 lines, terms defined
  roles/<role>/
    role.yaml
    SOUL.md        who it is: voice, stance, boundaries
    JOB.md         what it does, what "done" means, what it never does
    PROTOCOL.md    how it works with others (briefs, reports, reviews, ledger, the never-add list)
  agents/<name>/
    agent.yaml
    MEMORY.md      curated long-term memory, written by the agent through the daemon
    STATE.md       daemon-written pack used to seed a rotated session
  agents/.retired/<name>/           job agents after task close, with the task id and final report
  projects/<slug>/
    project.yaml
    knowledge/     any text the project's agents should read on session start
  data/agentopolis.db                 gitignored
  runs/<turn-id>.ndjson               raw CLI stream per turn, gitignored, rotated
```

### role.yaml

```yaml
name: lead
description: Runs one product's engineering. Owner-facing for that product.   # routing text
kind: standing            # standing | job
model: opus               # alias or full id
effort: high              # optional; omitted = CLI default
tools:                    # MCP servers this role may use, by name from config.yaml
  - agentopolis           # always implied, always loaded into the prefix
  - github
disallowed_tools: ["Edit", "Write", "NotebookEdit"]   # bare names strip built-ins from context
permissions:
  mode: acceptEdits       # CLI permission mode for the turn
  allow: ["Bash(git *)", "Read"]
  deny:  ["Bash(rm -rf *)"]
  hooks:                  # PreToolUse absolutes, injected via --settings; exit 2 = hard deny
    - deny_push_to_production
budget:
  monthly_usd: 60         # default for instances; agent.yaml may override
  per_turn_usd: 5         # --max-budget-usd for each turn
max_turns: 60             # --max-turns for each turn
max_wall_clock_minutes: 45
talks_to: [ceo, owner, developer, reviewer, scout, designer]   # who may share a container
requests: [open_task, close_task, merge_production, run_schedule]
```

### agent.yaml (an instance)

```yaml
name: agentopolis-lead    # internal id
display: Leo · lead Agentopolis
avatar: https://…/leo.png
role: lead
project: agentopolis
reports_to: ceo
model: null               # null = role default
effort: null
budget_monthly_usd: null
paused: false
session_id: null          # allocated by the daemon before the first spawn
session_started_at: null
```

Job agents get an instance too (`agents/dev-3/`), created by the daemon when a task opens; their
`display` is a human name from a fixed pool ("Nina · developer") because `dev-3` is unreadable
on a phone, and the internal id stays `dev-3`.

### project.yaml

```yaml
slug: agentopolis
name: Agentopolis
repo: /home/orch/src/agentopolis
branches:
  work: dev
  production: master      # merges and pushes here always need the owner's button
lead: agentopolis-lead
```

### config.yaml

```yaml
slack:
  bot_token_env: SLACK_BOT_TOKEN        # secrets live in the environment, never in files
  app_token_env: SLACK_APP_TOKEN
  owner_user_id: U0123ABCD
  work_channel_suffix: -work
language: it
budgets:
  company_monthly_usd: 300
approvals:
  timeout_hours: 24                     # merge_production never expires
  snooze_hours: 4
quiet_hours: { from: "23:00", to: "08:00", tz: Europe/Rome }
daily_digest_at: "08:30"                # sent only if something happened
max_concurrent_turns: 3
mcp_servers:                            # catalogue of tools roles may name
  github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }
```

## 5. Data model (SQLite)

Append-only facts plus derivable current state. Money is `INTEGER` micro-USD, never a float.
Times are `INTEGER` epoch milliseconds UTC behind one `Clock` port. Ids are monotonic integers
(`read_channel(since)` depends on total order).

| table | purpose |
|---|---|
| `agents` | instance state that is not a file: `session_id`, `session_started_at`, `paused`, `owner_host`, `lease_until` (unused in v1, the multi-machine seam) |
| `containers` | one row per standing channel or task thread: `id`, `kind` (standing/task), `members` (json), `default_to`, `task_id`, `slack_channel`, `slack_thread_ts`, `closed_at` |
| `messages` | immutable: `id`, `container_id`, `author`, `to`, `body`, `kind` (say/ask/report/system), `created_at` |
| `turn_messages` | `turn_id`, `message_id` UNIQUE: the delivery guarantee; the pending set is "messages to me not in this table" |
| `turns` | one per CLI run: `agent`, `started_at`, `ended_at`, `status` (running/ok/failed/interrupted/timed_out/cancelled/budget_exhausted/max_turns), `session_id`, `pid`, `trace_id`, `config_version`, `cost_microusd` (nullable), `cost_basis`, `model_usage` (json, verbatim), `cache_read`, `cache_creation`, `error` |
| `requests` | what an agent asked the daemon to do: `id`, `agent`, `kind`, `payload`, `status` (pending/approved/denied/expired/done/snoozed), `decided_by`, `decided_at`, `result`, `epoch` |
| `permission_requests` | tool calls parked for the owner: `turn_id`, `tool_use_id`, `tool_name`, `input`, `scope` (once/task), `status`, `decided_at` |
| `tasks` | a job with a lead: `id`, `project`, `title`, `lead`, `status`, `worktree`, `slack_thread_ts`, `opened_at`, `closed_at` |
| `outbox` | every Slack side effect, written in the same transaction as its cause: `kind`, `payload`, `channel`, `attempts`, `next_attempt_at`, `done_at`, `slack_ts` |
| `inbox` | every Slack event: `event_id` UNIQUE, `logical_key` (channel+ts), `received_at`, `processed_at` |
| `renders` | one row per interactive card: buttons carry the row id, never the payload |
| `schedules` | declared by standing agents: `agent`, `cron`, `prompt`, `last_fired` |
| `events` | the audit stream, monotonic id; every state mutation writes its event in the same transaction; a JSONL file is a derived tail, never a second writer |

Indexes: `messages(to, id)` ("undelivered" is a join on `turn_messages`, so this index is
plain and the query is `NOT EXISTS`); `messages(container_id, id)`; partial
`outbox(next_attempt_at) WHERE done_at IS NULL`; `turns(agent, started_at DESC)`; unique
`inbox(event_id)`; `inbox(logical_key)`; `requests(status, created_at)`. The loader's
`version` hashes paths relative to the home folder, so the same content gives the same version
on every machine.

The question hold is **derived**: "an unanswered `ask` from this agent to the owner exists",
never a flag that a crash could leave set.

## 6. Messaging

- A **container** is a standing channel (an agent and the owner, or two agents) or a **task
  thread** (the lead, the task's job agents, the owner). Members are fixed by `talks_to` and by
  the task. Standing channels are created on hire; task threads when a task opens.
- Every message has one **addressee** (`to`). Posting is a tool call (`post`), never a file
  write. The daemon appends the row, queues the mirror in the outbox, and wakes the addressee only.
- A message has a `kind`: `say` (information), `ask` (needs an answer), `report` (a
  deliverable), `system` (written by the daemon: hired, paused, budget, approval results).
- **The owner's replies are routed exactly.** A free-text `ask` to the owner carries a
  **Rispondi** button that opens a modal whose `private_metadata` holds the message id, so the
  answer reaches the asker without guessing. Text the owner types in a container without using
  the button goes to the member with an open `ask` there; if none, to the container's default
  addressee (the agent of a standing channel, the lead of a task thread); a leading word
  overrides: `lead: …`, `dev: …`, `reviewer: …`, `ceo: …`.
- **One question at a time, to the owner, per agent.** An agent with an unanswered `ask` to the
  owner has its further messages to the owner held in the store (not mirrored) until the owner
  answers or the ask expires. The Home tab shows "N domande in attesa". Messages to other agents
  are never held.
- **Mentions are rationed.** `<@owner>` is attached only to `ask`, approval cards and failures,
  never to `say` or `report`; at most one mention per agent per hour, further ones edit the
  existing card. During quiet hours nobody is mentioned; the morning digest opens with "Mentre
  dormivi: N cose ti aspettavano".
- **Wake rules.** A post wakes the addressee unless it is paused, over budget, or already
  running (then the loop's dirty flag records it). The pending set is a query, so a restart
  replays wakes for free.
- **What a turn reads.** The daemon builds the turn prompt: the messages addressed to the agent
  since its last turn, per container, the outcome of any request or permission it was waiting
  for, and any `remember()` lines written since the session started. Every agent resumes its own
  transcript with `--resume`; a job agent's transcript starts at task open and is discarded at
  task close.
- **Mirroring is at-least-once.** Slack has no idempotency key; the crash window between a
  successful post and the outbox row update is milliseconds, and a duplicate Slack line is
  cosmetic where a lost one is not.

## 7. Engine: one turn is one process

Per turn the runner spawns, in a process group, with `cwd` = the project worktree for
developer/reviewer turns and the agent's folder otherwise:

```
claude -p --output-format stream-json --input-format stream-json --verbose
  --session-id <uuid allocated and stored before spawn>   (first turn)
  --resume <session_id>                                   (later turns)
  --model <role/agent model> [--effort <level>]
  --max-turns <role.max_turns> --max-budget-usd <min(per_turn, monthly remaining)>
  --permission-mode <role mode> --allowedTools <…> --disallowedTools <bare names>
  --permission-prompt-tool stdio
  --permission-prompts host
  --setting-sources ""                                    (nothing of the owner's leaks in)
  --settings '<json: permissions.allow/deny + PreToolUse hooks for this role>'
  --mcp-config <byte-stable json: agentopolis (alwaysLoad) + role tools> --strict-mcp-config
  --append-system-prompt-file <STYLE.md + SOUL.md + JOB.md + PROTOCOL.md, in that order>
  --system-prompt-snapshot off
  --exclude-dynamic-system-prompt-sections
  --name <agent name>
```

Environment for every spawn: `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`,
`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=5m`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`,
`CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1`, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=30000`,
`MCP_TIMEOUT=5000`, `DISABLE_AUTOUPDATER=1`, `DISABLE_TELEMETRY=1`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, plus `AGENTOPOLIS_TURN_ID`,
`AGENTOPOLIS_AGENT`, `AGENTOPOLIS_TOKEN` for the MCP server.

Rules:

- Never `--bare` (it never reads the subscription login [documented]) and never `--continue`.
- All flags above exist on 2.1.276 [verified with a credential-less run]; `--max-turns` is
  accepted although hidden from `--help`.
- **The system prompt is rebuilt every request** with `--system-prompt-snapshot off`; by
  default the CLI records it at the session's first request and reuses it until compaction, so
  a role edit would never reach a resumed agent [verified]. With the switch off, an unchanged
  prompt still hits the cache; an edited one costs one uncached turn and applies.
- The first user message of a session (never the system prompt) carries `MEMORY.md`, the
  project's `knowledge/` and, on a rotation, `STATE.md`.
- The runner parses the stream: `rate_limit_event` (utilization and reset per window, emitted
  before init on every turn [measured]), `system/init` (model, tools, MCP status; the turn fails
  only if the agentopolis server is `failed` or `needs-auth`, never on `pending`),
  `assistant`/`user` events (for the status line), `control_request` with subtype
  `can_use_tool` (section 10), `system/api_retry` (`rate_limit` and `overloaded` both count),
  `system/compact_boundary`, the final `result` (subtype, cost, `modelUsage`, usage, session id,
  `permission_denials`).
- "Process exited without a `result` line" is the single failure predicate; its cost is null.
- Finalise on the child's `close`, not `exit`; drain stdout continuously and tee the raw stream
  to `runs/<turn-id>.ndjson`.
- Ending a turn early is SIGINT to the process group, then a grace period, then SIGKILL to the
  group; SIGTERM loses the turn's cost record (exit 143 [documented]) and is used only on daemon
  shutdown. The wall-clock watchdog (`max_wall_clock_minutes`) fires the same sequence, because
  `--max-turns` exhaustion has been reported to produce no result at all.
- One process per turn is a choice, not a constraint: the CLI can take further user messages on
  stdin [measured]. It is chosen for a trivial crash model and bounded memory (~200 MB per idle
  CLI [measured]); the 14× saving comes from `--resume`, not from process reuse.

## 8. The `agentopolis` MCP server

A stdio process per turn that forwards every call over a unix socket to the daemon (per-turn
token from its environment); it holds no state and never opens SQLite. Tools:

| tool | who | what |
|---|---|---|
| `post(container, to, body, kind)` | all | append + mirror + wake the addressee; `kind` in say/ask/report; `to` is a member name or `owner` |
| `answer(message_id, body)` | all | a `say` linked to an `ask`, clears the question hold |
| `read_channel(container, since)` | all | back-scroll only: messages after an id; new messages already arrive in the turn prompt |
| `request(kind, payload)` | per role | ask the daemon: `open_task`, `close_task`, `hire`, `retire`, `pause`, `set_budget`, `merge_production`, `run_schedule` |
| `remember(text)` | standing | append to my MEMORY.md (committed) and echo the line into my next turn prompt, so it applies before the next session rotation |
| `status()` | all | my budget left, open asks, pending requests, cache hit ratio of my last turn |

Which `request` kinds a role may use is in `role.yaml`; the daemon refuses the rest and says why.
Permission prompts are **not** a tool: they arrive on the CLI's control channel (10).

## 9. Slack surface

This section is the contract for the mirror module. API facts were read on docs.slack.dev on
2026-09-18; field practice comes from openclaw, nanoclaw, dust, vercel/chat, opentag and switch,
read the same day.

### Identity

One app, one bot user, Socket Mode (no public URL; one connection). Every agent message is
posted with `chat.postMessage` and the `username` and `icon_url` overrides, scope
`chat:write.customize`, degrading to `icon_emoji`, then bare `username`, then plain if a scope
is missing [field]. Personas are not users: no @mention, no presence. The owner is a real user,
so `<@owner>` notifies him where section 6 allows it.

**A persona message is immutable.** `chat.update` documents no identity arguments [verified] and
no serious implementation edits a persona message [field]. Anything that changes after posting
(task cards, approval cards, status lines, answered asks) is posted under the app's own identity,
with the persona named in a `context` line ("Leo chiede"). This also keeps an ask to one push
notification instead of two.

**One bot per agent is a recorded road, not a closed door.** The largest comparable project made
one Slack app per agent its headline feature, because personas cannot be mentioned, have no
presence and cannot hear each other [field]. v1 does not need any of that (agent ⇄ agent traffic
lives in the store), and the mirror keeps the identity decision in one module so the road stays
open.

### Containers

- `#ceo`: owner ⇄ ceo. Fixed, created at install, unmuted.
- `#<project>`: owner ⇄ that project's lead. Decisions, questions, approvals, receipts. Unmuted.
- `#<project>-work`: the project's working channel, which the owner **mutes during onboarding**
  (mentions still badge through a mute [documented]). One **thread per task**: the parent is the
  app-identity task card (title, state, budget used, agents engaged), edited in place; replies are
  the traffic lead ⇄ job agents plus any owner exchange. The daemon sets
  `agents.sessions.setStatus` to `processing` with the persona's identity while a turn runs and
  back to `active` after; the method accepts `thread_ts` in regular channels and returns
  `feature_disabled` when the workspace lacks the feature [verified, live check 2], in which
  case the edited status line alone stands. Titles use `agents.sessions.rename` under the same
  condition.
- Channels are private, created by the bot with `conversations.create`, the owner invited;
  names lowercase, digits, `-`/`_`, at most 80 characters. A channel that has served its purpose
  is **archived**, never deleted (no API deletes a channel on a normal workspace); rows stay.
- `thread_ts` is passed as the string Slack returned, never parsed to a number.
- **The store is the only history.** The mirror never reads Slack history back
  (`conversations.history`/`replies` are throttled); inbound owner messages arrive through events
  and are stored on arrival.

### Inbox contract

- Events: `message.channels`/`message.groups`, `reaction_added`, `app_home_opened`,
  `member_joined_channel`, `channel_archive`; interactivity: `block_actions`, `view_submission`,
  slash commands.
- **Ack after durable write.** Every event is written to `inbox` first, then acknowledged
  (within the 3-second window), then processed. A Slack retry is processed as a first delivery
  and the dedup key protects against duplicates; this is also the daemon-restart recovery path.
- **Two dedup keys**: `event_id` for transport and `(channel, ts)` as the logical key, kept 24 h,
  because one mention can arrive as two events with different ids [field].
- **Bot-authored inbound is dropped by default** (any event carrying `bot_id`); a named seam
  with a per-room hop budget is where agent ⇄ agent traffic in Slack would be admitted later.
- A reaction is never an answer; 👀 from the owner marks a message seen for the Home tab.

### Questions, approvals, buttons

- An `ask` with choices is **one app-identity card**: `section` (question, ≤2 lines),
  `context` (who asks · project · budget left), `actions` with at most **three** buttons
  (more choices become a `static_select`); button `value` is the `renders` row id plus an option
  index, never the payload. Every card has **Più tardi**, which snoozes `snooze_hours` by editing
  the same card ("Rimandata alle 18:00") and re-mentions once at the deadline. On answer the card
  keeps the question text and replaces the actions row with a muted line naming the decision
  [field]; `chat.update` with `channel`+`ts` does it (`response_url` works too but is limited
  to 5 uses in 30 minutes).
- A free-text `ask` is a persona message with the owner mention plus an app-identity line with
  **Rispondi** (modal) so the answer is routed exactly.
- **Approval cards** (gated requests and parked permission prompts): the request in one line,
  a `context` line with who asked and the budget left, buttons **Approva** (primary),
  **Approva per questo compito** (scope `task`, for permission prompts only), **Nega** (danger,
  with a `confirm` dialog for destructive kinds), and **Dettagli** (modal with the full payload,
  stderr behind "Dettagli tecnici"). `value` carries the row id and an `epoch`; a stale epoch is
  rejected. On decision the card is rewritten with the outcome; on expiry (24 h, never for
  `merge_production`) with "Scaduta: nessuno ha risposto, l'ho trattata come un no" and
  **Riapri**.
- Forms (`/hire`, `/edit`, budgets) are modals (`views.open` from a `trigger_id`, which exists
  only on an interaction payload and expires in 3 seconds): at most six inputs, defaults
  pre-filled from `role.yaml`, `radio_buttons` never beyond 10 options, `private_metadata` ≤3000
  characters, validation errors as `response_action: errors`. `/edit <agent>` opens SOUL/JOB/
  MEMORY in a multiline field; on submit the daemon writes, commits, and posts a card "SOUL.md di
  Leo aggiornato · +3 −1 righe" with **Vedi differenze** (modal, code block) and **Annulla** (git
  revert, card edited to confirm). Anything over ~2,000 characters gets a GitHub link instead.

### Slash commands

`/agentopolis` (opens Home), `/hire`, `/edit <agent>`, `/pause <agent>`, `/resume <agent>`,
`/model <agent> <model>`, `/budget <agent> <usd>`, `/costs`, `/status`, `/diag <agent>` (last
turn's exit code, stderr tail, run file path), `/rollback` (a select of the last five config
changes). Each is a daemon action, not an agent turn, answered ephemerally where the answer is
only for the owner. The same actions live in the Home tab's overflow menus; the commands are the
phone shortcut.

### Status lines and receipts

Inside task threads only: one app-identity line ("Leo sta lavorando · 2 min"), edited in place
at most once per second through the same per-channel bucket at lowest priority, never
re-posted; at turn end it becomes the receipt (duration, cost "stimato"). Where
`chat.startStream`/`appendStream`/`stopStream` is available it is preferred (identity is set at
stream open, segments rotated before 240 s [field]); the edited line is the fallback. Owner-facing
channels get receipts only, no live status.

### Digest and quiet hours

The ceo's daily check-in is sent only if something happened: one line per project (fatto / in
corso / bloccato), questions waiting, spend as one number against the budget, one suggested next
action as a button. Quiet hours suppress mentions and batch them into the digest.

### App Home

`views.publish` on `app_home_opened` and after every daemon action. Layout: header; context with
month-to-date spend and budget bar; "Ti aspettano" (≤5 items with **Apri**); projects with
**Vai**; agents as `fields` (≤10 per section) with state glyph and spend, an overflow per agent
(Pausa / Modello / Budget / Licenzia); actions **Assumi**, **Costi**; "Aggiornato alle hh:mm".
At most 100 blocks; beyond that a "…e altri N" line.

### Files

Long deliverables stay in the worktree; when one must reach Slack (a mockup image, a report on
request) the mirror uses `files.getUploadURLExternal` + `files.completeUploadExternal`. Canvases
are not used in v1.

### Client and limits, in one module

`limits.ts` holds and the mirror enforces: 1 message per second per channel; text split at 3,000
characters per `section`; ≤50 blocks per message, ≤100 per Home tab; button text 75 characters;
`value` 2,000 characters; modal title 24 characters. Per-method budgets under Slack's tiers, in
one table (`chat.update` 50/min, `conversations.*` 40/min, `chat.appendStream` 160/min) [field].
The Slack client is created with a **bounded retry policy and a per-request timeout**: the SDK
default retries a rate-limited call for up to ~30 minutes and would stall a turn [field].
`agents.sessions.*` and `assistant.threads.*` calls are wrapped in try/catch and only warn.
Bolt for JavaScript is used directly; `vercel/chat`'s Slack adapter was considered (it ships
dedup, retries, streaming) and set aside because it has no outbound persona support.

### Manifest

```
display_information: { name: Agentopolis }
features:
  bot_user: { display_name: Agentopolis, always_online: true }
  slash_commands: [/agentopolis, /hire, /edit, /pause, /resume, /model, /budget, /costs, /status, /diag, /rollback]
oauth_config.scopes.bot:
  chat:write, chat:write.customize, groups:write, groups:history, groups:read,
  channels:manage, channels:history, channels:read,
  reactions:read, users:read, files:write
settings:
  socket_mode_enabled: true
  interactivity: { is_enabled: true }
  event_subscriptions.bot_events: [message.channels, message.groups, reaction_added,
                                   app_home_opened, member_joined_channel, channel_archive]
```

Agent features (`features.agent_view`, `agents.sessions.*`) are enhancements gated on live check
2; v1 never requires them.

## 10. Approvals and governance

Three tiers, each where the agent can only ask:

1. **PreToolUse hooks** (injected per turn via `--settings`, exit 2 = hard deny that no allow can
   override [documented]) for absolutes with no round-trip: `git push` to a production branch,
   writes outside the worktree, `git add -A`.
2. **The permission channel.** With `--permission-prompt-tool stdio` the CLI writes a
   `control_request` of subtype `can_use_tool` (tool name, input, `tool_use_id`) to stdout and
   waits for a `control_response` with `behavior: allow|deny` [measured end to end on 2.1.276;
   live check 4 confirms the hold length]. Rules in `role.yaml` answer most calls without the
   owner. What no rule covers is **parked**: the daemon answers `deny` with "in attesa del
   proprietario" immediately, stores the request in `permission_requests`, renders the approval
   card, and re-wakes the agent with the decision when the button lands. A turn is never held
   open for hours waiting for a human. "Approva per questo compito" stores an allow rule scoped
   to the task id.
3. **Daemon actions** for the gated request kinds: merge or push to a production branch, `hire`,
   budget increase, spend above a threshold. Always a card, timeout 24 h, `merge_production`
   never expires.

- **Budgets.** Per agent, monthly, from `turns.cost_microusd` (labelled "stimato"). A quiet line
  at 80% in the agent's owner-facing channel; at 100% the agent is paused and told so, with
  buttons **Aggiungi 20 €** / **Lascia in pausa**. `--max-budget-usd` per turn, `max_turns` and
  the wall-clock watchdog are the runaway guards together; none is relied on alone.
- **Pause.** A paused agent gets no turns; the pending set waits; unpause runs one turn that reads
  everything. A lead cannot open a task for a paused developer.
- **Production branches.** `project.yaml` names them; the daemon's git operations refuse them
  without an approved request, and the PreToolUse hook refuses the agent's own `git push` there.

## 11. Development tasks

1. The owner (or the ceo) asks the lead for something in `#<project>`.
2. The lead `request(open_task, {title, kind: develop|review|design|research, budget, model})`.
   The daemon creates the task row, the thread in `#<project>-work`, a git worktree from the work
   branch, and hires the job agent (`agents/dev-<n>/`, display name from the pool).
3. The lead posts the brief to the job agent. The agent works in the worktree; reports with
   `post(kind: report)` (five lines) and the file `reports/<task>.md`; the closing report may use
   `--json-schema` for its envelope (`{summary, files, tests_green, parked[]}`) once live check 3
   confirms `structured_output` under `stream-json`.
4. The lead may hire a reviewer for the same task: the reviewer gets a daemon-built summary of
   the thread plus the diff, never the raw thread, in a read-only worktree with `Edit`/`Write`
   stripped.
5. Merge to the work branch is the lead's; merge to production is `request(merge_production)`.
6. `request(close_task)` retires the job agents, removes the worktree, edits the task card,
   delivers the report to the lead.

The protocol content (lean briefs, ledger, `PARKED`, reports naming the copy they read, review by
provenance, staging explicit paths, one deliverable per task, and the **never-add list**: no
status-poll loop, no team standup, no unrequested digest, no lead reading task threads, no
whole-catalogue tools) lives in the roles' `PROTOCOL.md` files and ships with the repo.

## 12. Roles in v1

| role | kind | model / effort | tools kept | stripped | notes |
|---|---|---|---|---|---|
| ceo | standing | sonnet / low | agentopolis | Edit, Write, NotebookEdit, Bash | the owner's only interlocutor; hires (always through a form the owner submits), budgets, conditional digest; first message = welcome + four starter buttons |
| lead | standing per project | opus / high | agentopolis, github, repo cwd | Edit, Write, NotebookEdit | product owner + engineering lead; ledger; briefs; picks the developer's model per task; merges to the work branch |
| developer | job | opus / xhigh (sonnet for small ledger lines, the lead's call) | agentopolis, repo cwd | WebSearch, WebFetch | one deliverable per task, worktree, tests green before report |
| reviewer | job | opus / high | agentopolis, repo cwd read-only | Edit, Write, NotebookEdit, WebSearch, WebFetch | findings by provenance; never edits |
| scout | job | haiku / low (sonnet when judgement is needed) | agentopolis, web fetch/search | Edit, Write, Bash | sourced research reports |
| designer | job | opus / high | agentopolis, write to `design/` in worktree | Bash outside `design/` | mockups (HTML), flows, interface spec; no app code |

Effort and model are set at spawn only; a `/model` or `/effort` change rotates the session
(a mid-session switch invalidates the whole cache [verified]). Each role ships `role.yaml`,
`SOUL.md`, `JOB.md`, `PROTOCOL.md`; `STYLE.md` at the repo root is composed after `SOUL.md` into
every prompt.

## 13. When things go wrong

Every owner-facing error names the consequence in Italian and offers at most two buttons; stderr
goes behind "Dettagli tecnici".

| situation | behaviour |
|---|---|
| CLI process exits without a `result` | turn = failed, cost null, stderr tail stored; one automatic retry; then "Leo si è fermato per un errore tecnico. Ho già riprovato una volta." with **Riprova** / **Lascia stare** |
| `result.subtype` = `error_max_budget_usd` / `error_max_turns` | turn = budget_exhausted / max_turns; queued messages start a new turn with their own limit |
| wall-clock watchdog fires | SIGINT → grace → SIGKILL group; turn = timed_out; same owner message as a failure |
| `rate_limit_event` says the subscription window is exhausted, or `api_retry` with `rate_limit`/`overloaded` persists | **limit pause**: no new turns; one owner message, edited in place with each change; turns resume at the event's `resetsAt`; no probe process |
| Slack unreachable | outbox rows wait with backoff; nothing is dropped; the Home tab shows "Slack non raggiungibile da hh:mm" once it is back |
| malformed role/agent/project file | rejected with a `#ceo` message naming the file and the error; last valid snapshot stays loaded |
| result without cost | `cost_microusd = null`; shown as "sconosciuto" in `/costs`; never estimated |
| approval never answered | expires per section 10; card edited |
| daemon restart | running turns become `interrupted` (never re-run automatically; the agent gets a `system` note that its turn was cut and the channel is the truth); orphan `claude` processes with an `AGENTOPOLIS_TURN_ID` are reaped; pending wakes replay from the store; open cards re-rendered |
| `--resume` fails ("No conversation found", or no `system/init`) | start fresh from `STATE.md` with a `system` note; never loop |
| agentopolis MCP server `failed`/`needs-auth` at init | turn failed; `pending` is not a failure |
| cache hit ratio of a resumed turn below 0.7 twice running | `system` message in `#ceo`: something in the prefix is moving |

Process supervision: children spawned `detached` in their own process group and killed as a
group; stdout drained continuously; `close` not `exit`; two-stage stop; global concurrency cap
plus `MemoryMax=` in the unit; shutdown = stop wakes, close the Slack socket, bounded drain
(~120 s), SIGINT children, flush the outbox, `wal_checkpoint(TRUNCATE)`. systemd unit:
`Type=notify` (READY after migrations and Slack connect), `WatchdogSec` pinged from the scheduler
tick, `KillMode=mixed`, `TimeoutStopSec` above the drain, `Restart=always`, `EnvironmentFile=`
mode 0600. `/healthz` on localhost: running turns, queue depth, last Slack event age, WAL bytes.
Litestream replicates the database off the box.

Observability: pino to stdout (journald), token-shaped values redacted; one OpenTelemetry trace
per turn (`agent.turn` with children for prompt build, spawn, each tool call, each Slack call;
prompt and response content in span events, never attributes); `trace_id` on `turns` and
`events`; metrics `turn_duration_seconds`, `wake_to_turn_start_seconds`, `turns_running`,
`pending_messages`, `outbox_depth`, `outbox_oldest_age_seconds`, `slack_api_errors_total`,
`cli_exit_code_total`, `turn_cost_microusd_total`, `budget_remaining`, `sqlite_wal_bytes`,
`cache_hit_ratio`. `/status` prints the gauges; `/diag` the last turn.

## 14. Testing

- **Unit** (vitest): loader validation, router wake rules, derived question hold, budget
  arithmetic in integers, approval state machine and epochs, stream parser (every message type,
  unknown types ignored, broken lines skipped), Slack block builders, limits module, prompt
  composition order.
- **Contract suite against the CLI, dual target**: the same suite runs against `fake-claude`
  in CI and against the real CLI behind `--live` by hand or nightly, so the fake cannot drift. The
  fake replays fixtures for `rate_limit_event`, `system/init` (including `pending` servers),
  `can_use_tool` control requests, `keep_alive`, `api_retry`, `compact_boundary`, results with
  and without cost, `permission_denials`, and pathologies: truncated line, exit 1 with stderr, a
  hang, a child ignoring SIGINT, a 10 MB line, exit without result.
- **Fake Slack**: an in-process stub of the Bolt client recording calls; asserts personas never
  edited, cards rewritten, archive on close, block shapes and limits, ack-before-process order.
- **Property tests** (fast-check): scheduler (never two turns per agent, every message consumed
  exactly once, none before creation); outbox pump (any crash point is at-least-once, never lost);
  text splitter (blocks ≤3,000 chars, ≤50 blocks, concatenates back); budget arithmetic.
- **Crash recovery**: the daemon run as a child, SIGKILLed mid-turn, restarted; invariants hold
  (turn interrupted, no re-run, wakes replayed, cards re-rendered).
- **One live smoke on the owner's Mac** with the real CLI and a test workspace before the first
  VPS deploy: ceo greets, owner answers, lead hires a developer on a trivial task, approval card
  works, `/costs` shows the turn.
- CI on GitHub Actions: Biome, typecheck, unit, fake-CLI contract, fake-Slack, property, crash.

## 15. Done when

All of these hold on the VPS, with the real CLI and the owner's Slack workspace:

1. `systemctl status agentopolis` is active; a `kill -9` mid-turn followed by a restart loses no
   message, marks the turn interrupted, and re-renders open cards.
2. The owner writes in `#ceo` and gets an answer from the ceo persona within one turn.
3. The owner asks the lead in `#agentopolis` for a small change to this repository; a task
   thread appears in `#agentopolis-work`; a developer delivers on a branch; a reviewer reports;
   the lead merges to `dev`; the `merge_production` card appears in `#agentopolis`; the owner
   approves; `master` receives the merge.
4. `/costs` shows a per-agent, per-month table labelled "stimato" whose integers equal the sum
   of `turns.cost_microusd`.
5. `/pause` on the developer during a task stops its next turn; `/resume` runs the pending turn.
6. Editing `roles/lead/SOUL.md` changes the lead's next turn without a daemon restart, and that
   turn's `cache_creation` is the only uncached one in the sequence.
7. A resumed lead turn reports `cache_read_input_tokens` above 90% of its input.
8. A parked permission prompt appears as a card; "Approva per questo compito" lets the same
   tool call pass on the next turn without a card.

## 16. Stack

TypeScript on Node LTS, pnpm, Bolt for JavaScript (Socket Mode), better-sqlite3 + Drizzle,
zod + yaml, chokidar, croner, p-limit, pino, `@opentelemetry/*`, sd-notify, vitest, fast-check,
Biome, Litestream, a systemd unit under `deploy/`. No agent framework and no Claude SDK: the
daemon is a direct NDJSON peer of the CLI. One package; folders `src/<module>/` mirror section 3.

## 17. Assumptions to confirm with the owner

- The first project is this repository.
- Standing agents have display names chosen at hire ("Leo · lead Agentopolis"); job agents get a
  human name from a fixed pool with their internal id kept.
- Slack free plan for now (90-day history is acceptable: the store keeps everything; the agent
  features of section 9 may need a paid plan and are never required).
- The slash commands stay alongside the Home tab, because the owner is used to them from the
  previous system.

## 18. Live checks before building on them

Settled by throwaway scripts against the real workspace and the installed CLI in the first
implementation task, with the answer recorded in this file:

1. Does `chat.update` keep the `username`/`icon_url` of a persona message? Assumed **no** (five
   codebases never try); the check only decides whether a nicety is possible.
2. Are `agents.sessions.setStatus` / `rename` enabled for this workspace (`feature_disabled`
   otherwise), in a private channel thread, without `agent_view`?
3. Does `--output-format stream-json` carry `structured_output` when `--json-schema` is passed?
4. Is a `can_use_tool` request still answerable after a hold of more than 150 s (measured up to
   150 s)? The design does not depend on it (prompts are parked, not held), but the fake CLI's
   fixtures should match reality.
5. Does `--max-budget-usd` stop a turn under a subscription login, given that costs are
   estimates?
6. Do `--append-system-prompt-file` and `--system-prompt-snapshot off` behave on the VPS's CLI
   version as on 2.1.276 (both verified here).

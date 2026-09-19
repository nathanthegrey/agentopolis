# Agentopolis v1 — design

Status: approved in conversation with the owner on 2026-09-18, revised the same day after five
scout reviews (architecture, token efficiency, CLI engine, open-source Slack agent repositories,
owner usability), hand verification of the load-bearing claims against the installed Claude
Code CLI 2.1.276 and the official docs, and a second pass that removed every rule inherited
from the owner's previous system (AIOrchestrator) that the new stack makes unnecessary.
Written for the agent that will implement it. The owner is not a programmer: every rule here
that touches him must be visible from Slack, never only from a file.

Evidence marks used below: **[verified]** read or run by the spec author on 2026-09-18;
**[measured]** a probe run by a reviewer on this machine the same day, with the number quoted;
**[documented]** an official page; **[field]** what open-source implementations do; **[live
check]** to be settled by the implementer (section 18).

## 1. What it is

A company of AI agents run by one owner from Slack. Each agent is a folder of text files. Agents
address one colleague at a time, never a room. The owner sees every exchange, answers questions
with buttons, and approves anything that reaches the world. A daemon on the owner's VPS makes it
all happen; the agents' engine is the Claude Code CLI on the owner's subscription.

### v1 scope

- The daemon, the home folder, the SQLite store, the Slack app (one bot user).
- Five roles: `ceo`, `lead`, `developer`, `reviewer`, `designer`. Research is a **subagent** a
  lead or developer spawns inside its own turn (section 12), not an agent.
- Standing agents (always on, resume their own conversation): `ceo`, one `lead` per project.
- Job agents (born for one task, resume within it, retire when done): `developer`, `reviewer`,
  `designer`.
- Addressed messages, mirrored to Slack: a channel per standing agent, a thread per task, the
  owner a member of all of them.
- Approvals with buttons; pause; per-turn runaway guards; costs shown, never gated.
- One project: this repository. The company's first work is its own v2.

### Out of v1

Email and a support role, ops, QA, writer, scout as an agent of its own, monthly budgets, paid
overflow to the API when the subscription window is exhausted (owner, 2026-09-19: "free or
nothing"), quiet hours or any daemon-side notification schedule, any web page, several machines,
any chat surface other than Slack, one Slack bot per agent (see 9, Identity, for why this is a
recorded road and not a closed door).

## 2. Principles

1. **Everything the system knows is a file or a row.** Roles, standing agents and projects are
   folders under git. Messages, turns, tasks, requests, approvals and usage are rows in SQLite.
   The daemon can be killed and restarted at any time and loses nothing already committed
   (`synchronous=FULL`, section 5).
2. **Addressed, never broadcast.** Every message has exactly one addressee. Only the addressee
   wakes, and only the addressee receives it in its turn. The owner is a member of every channel
   and thread by right and reads everything at zero token cost, because Slack is read by the
   daemon, not by a model. A lead never reads a task thread; it reads what is addressed to it. An
   agent may address the owner directly, which skips the lead entirely: a question routed through
   the lead would cost two lead turns on the largest context in the company.
3. **Wake on event, never on a clock.** An agent runs a turn because something was posted to it,
   an approval came back, or a schedule it declared fired. There is no heartbeat, and no probe
   loop: even the subscription limit is read from an event the CLI emits on every turn (13).
4. **The daemon enforces; prose advises.** Anything that must hold (approvals, pause, production
   branches, runaway guards) is enforced where the agent can only ask: a `PreToolUse` hook for
   absolutes, the permission channel for judgement calls, the daemon's own git operations for
   branches. Role prose explains the rule; it never carries it alone.
5. **Numbers are measured or absent, and cost figures are estimates.** Costs come from the CLI's
   result event, which the docs call a client-side estimate that must not drive billing
   [documented]; on a subscription they correspond to no invoice. Every figure shown to the owner
   is labelled "stimato". A turn without a cost record is stored as unknown, never estimated.
   **Costs are shown, never gated**: the only ceiling that is real on a subscription is the plan's
   own limit, which the daemon reads per turn (13).
6. **Adding or changing an agent is editing a folder.** No rebuild, no restart. Prose edits reach
   the agent on its next turn because the daemon passes `--system-prompt-snapshot off`
   [verified, section 7]; memory edits reach it through the turn prompt (6).
7. **The owner's language.** Agents answer the owner in the language the owner writes in, falling
   back to `config.language` when a message gives no clue, in one shared style (`STYLE.md`).
   Agent ⇄ agent traffic, files, code, commits and logs are in English.
8. **Nothing is inherited without a reason that holds here.** The previous system's rules were
   born from a linear Telegram chat, markdown channel files and terminal sessions. Each one was
   re-examined on 2026-09-18 and kept only where the new stack has the same need. Things that were
   removed on purpose and must not return under another name: a question cap or hold, daemon-side
   quiet hours and digests-as-notifications, mention counters, a markdown task ledger, "say which
   copy you read", per-role permission matrices, prefix words to address an agent, a status
   command, folders for ephemeral agents, monthly money budgets.
9. **Token rules, enforced by the daemon:**
   - only the addressee is billed (principle 2);
   - **the turn's result is the message**: the CLI returns a structured envelope
     (`--json-schema`, verified live under `stream-json` [live 2026-09-18]) and the daemon
     delivers it; no tool call is needed to speak, because every tool call is one more
     full-context API request;
   - every agent resumes its own CLI session with `--resume`: a resumed turn was measured at
     14× cheaper than a fresh one (188 vs 14,482 cache-creation tokens) [measured]; the saving
     holds within the one-hour cache lifetime the subscription grants inside plan usage
     [verified], which the daemon pins with `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`;
   - the daemon injects the new messages and the agent's own state (open asks, pending
     requests, last cost) into the turn prompt; nothing an agent could read about itself is a tool;
   - the owner's personal hooks, CLAUDE.md and MCP servers never enter an agent's turn
     (`--setting-sources ""`, `--strict-mcp-config`): they were measured at ~6,000 tokens and
     foreign instructions per turn [measured];
   - long deliverables are files in the worktree (`reports/<task>.md`, `design/…`); the message
     carries a summary of at most five lines;
   - the composed prompt has a stable order (style, role, project) so the prompt cache covers it;
     memory and project knowledge travel as the first user message of a session, not in the
     system prompt, so a memory write cannot invalidate the prefix;
   - the CLI's own auto-compaction keeps a session bounded: `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`
     (the default compaction point is ~967,000 tokens [verified]; the variable's minimum is
     100,000 [verified]); there is no daemon-side session rotation in v1;
   - status lines, receipts, costs, the Home tab are written by the daemon: zero tokens;
   - no heartbeat, no unrequested digest; the ceo is never copied on owner ⇄ lead traffic;
   - a wall-clock watchdog per turn (`max_minutes`, the one knob a role has) plus two fixed
     daemon constants passed as `--max-budget-usd 5` and `--max-turns 60` kill a runaway loop;
     they are guards, not budgets, and nobody tunes them;
   - a task's close delivers the report to the lead, never the thread.

## 3. Architecture

```
┌──────────────── Slack (one app, Socket Mode) ────────────────┐
│  DM ceo · DM lead · #agentopolis-hq · #agentopolis-work · Home │
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
  reference atomically; a malformed file is rejected with a message in the ceo's direct message and the last good
  snapshot stays; a config file containing a value that looks like a Slack token is rejected.
- **store**: SQLite through better-sqlite3 + Drizzle; WAL, `synchronous=FULL`, `busy_timeout`;
  the daemon is the only writer; migrations generated and applied at boot in a transaction; boot
  refuses a database newer than the binary.
- **router**: turns a posted message into a wake for its addressee, applying pause (derived from
  rows, never from in-memory flags); delivers a turn's envelope as messages.
- **scheduler**: one `AgentLoop` per agent (dirty flag + async mutex; a wake during a turn marks
  dirty and the loop runs again, reading everything pending, which is coalescing for free); a
  global concurrency cap (`p-limit`, 2–3 on the VPS); declared cron schedules (croner).
- **runner**: builds and spawns the `claude -p` process for one turn, streams its NDJSON,
  answers permission requests on the control channel, records usage and session id, enforces the
  wall-clock watchdog, returns the structured envelope.
- **approvals**: holds requests, renders them to Slack, applies decisions, expires.
- **mirror**: outbox pump (per-channel 1 msg/s bucket, bounded retries, personas) and inbox
  (ack after durable write, dedup); turns Slack input into rows.
- **mcp server** (`agentopolis-mcp`): a small stdio process spawned per turn that forwards the
  few remaining tool calls over a unix socket to the daemon, authenticated by a per-turn token
  in its environment. It never opens SQLite.

## 4. Home folder

```
~/agentopolis/                      a folder the owner may keep under git by hand; the daemon never runs git here
  config.yaml
  STYLE.md         shared voice for every agent: tu form, decision first, ≤5 lines, terms defined
  knowledge/       company facts every agent reads on session start (owner, 2026-09-19): who the
                   owner is and how he works, the map of products and how they relate, the house
                   rules (production only with the owner's button, secrets by his hand, work vs
                   production branches), machines and tools, the priorities of the moment. One or
                   two pages: every agent pays it once per session. Not a product's details
                   (project knowledge), not an agent's recollections (MEMORY.md), not the tone (STYLE.md).
  roles/<role>/
    role.yaml
    AGENT.md       who it is, what it does, how it works with others, what it never does
  agents/<name>/                     standing agents only (the owner edits these)
    agent.yaml
    MEMORY.md      curated long-term memory, written by the agent through the daemon
    AGENT.md       optional: personal instructions or character, appended after the role's AGENT.md
  projects/<slug>/
    project.yaml
    knowledge/     any text the project's agents should read on session start
  data/agentopolis.db                 gitignored
  runs/<turn-id>.ndjson               raw CLI stream per turn, gitignored, rotated
```

Job agents (developer, reviewer) are rows in the store (section 5), not folders: nobody
hand-edits them and the tables already are the audit trail.

### role.yaml

```yaml
name: lead
description: Runs one product's engineering. Owner-facing for that product.   # routing text
kind: standing            # standing | job
model: opus               # default; alias or full id
effort: high              # default; low | medium | high (xhigh is never used, owner 2026-09-19)
menu:                     # job roles only: what the lead may pick at open_task; the daemon refuses the rest
  models: [sonnet, opus]
  efforts: [medium, high]
tools:                    # MCP servers this role may use, by name from config.yaml
  - agentopolis           # always implied, always loaded into the prefix
  - github
disallowed_tools: ["Edit", "Write", "NotebookEdit"]   # bare names strip built-ins from context
subagents: [research]     # names from roles/<role>/subagents/*.md, passed with --agents
permissions:
  mode: acceptEdits       # CLI permission mode for the turn
  allow: ["Bash(git *)", "Read"]
  deny:  ["Bash(rm -rf *)"]
  hooks:                  # PreToolUse absolutes, injected via --settings; exit 2 = hard deny
    - deny_push_to_production
max_minutes: 45           # the wall-clock watchdog; the only guard a role configures
requests: [open_task, close_task, merge_production]
```

`roles/<role>/subagents/<name>.md` is a Claude Code subagent definition (frontmatter `name`,
`description`, `tools`, `model`, body = its prompt) [documented]; the daemon passes the role's
list with `--agents` as JSON. v1 ships one: `research` (read-only, web fetch and search,
Sonnet/medium: it fails by reporting stale pages as truth, which is judgement) for `lead`,
`developer` and `designer`. Opus or Fable on `research`, and any effort change on it, are gated
(section 10).

### agent.yaml (a standing instance)

```yaml
name: ada                 # internal id
display: Ada · lead Agentopolis
avatar: https://…/leo.png
role: lead
project: agentopolis
reports_to: ceo
slack_app: ada            # standing agents name their app; the ceo uses `company`
model: null               # null = role default
effort: null
paused: false
```

Session ids and start times are rows, not file fields.

### project.yaml

```yaml
slug: agentopolis
name: Agentopolis
repo: /home/orch/src/agentopolis
branches:
  work: dev
  production: master      # merges and pushes here always need the owner's button
lead: ada
```

### config.yaml

```yaml
slack:
  owner_user_id: U0123ABCD
  work_channel_suffix: -work
  apps:                                 # one Socket Mode connection each; secrets stay in the environment
    company: { bot_token_env: SLACK_BOT_TOKEN, app_token_env: SLACK_APP_TOKEN }
    ada:     { bot_token_env: SLACK_BOT_TOKEN_ADA, app_token_env: SLACK_APP_TOKEN_ADA }
language: it                            # fallback only: agents answer in the owner's language
approvals:
  timeout_hours: 24                     # merge_production never expires
permission_hold_minutes: 5              # hold a can_use_tool open this long, then park (10)
gated:                                  # values that need the owner's card (10)
  models: [fable]
  research: { models: [opus, fable], effort: true }
loop_guard: { messages: 12, review_rejections: 3 }   # per task, see 6
max_concurrent_turns: 3
job_names: [Nina, Marco, Sara, Luca, Elena, Paolo]   # display names for job agents, round robin
mcp_servers:                            # catalogue of tools roles may name
  github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }
```

## 5. Data model (SQLite)

Append-only facts plus derivable current state. Money is `INTEGER` micro-USD, never a float.
Times are `INTEGER` epoch milliseconds UTC behind one `Clock` port. Ids are monotonic integers.

| table | purpose |
|---|---|
| `agents` | every instance, standing or job: `name`, `role`, `display`, `project`, `reports_to`, `kind`, `task_id` (job), `session_id`, `session_started_at`, `paused`, `retired_at`, `owner_host`, `lease_until` (unused in v1, the multi-machine seam); standing rows mirror `agent.yaml` |
| `containers` | one row per standing channel or task thread: `id`, `kind` (standing/task), `members` (json), `default_to`, `task_id`, `slack_channel`, `slack_thread_ts`, `closed_at` |
| `messages` | immutable: `id`, `container_id`, `author`, `to`, `body`, `kind` (say/ask/report/system), `created_at`, `answered_by` |
| `turn_messages` | `turn_id`, `message_id` UNIQUE: the delivery guarantee; the pending set is "messages to me not in this table" |
| `turns` | one per CLI run: `agent`, `started_at`, `ended_at`, `status` (running/ok/failed/interrupted/timed_out/cancelled/budget_exhausted/max_turns), `session_id`, `pid`, `trace_id`, `config_version`, `cost_microusd` (nullable), `cost_basis`, `model_usage` (json, verbatim), `cache_read`, `cache_creation`, `error` |
| `requests` | what an agent asked the daemon to do: `id`, `agent`, `kind`, `payload`, `status` (pending/approved/denied/expired/done), `decided_by`, `decided_at`, `result`, `epoch` |
| `permission_requests` | tool calls parked for the owner: `turn_id`, `tool_use_id`, `tool_name`, `input`, `scope` (once/task), `status`, `decided_at` |
| `tasks` | a job with a lead: `id`, `project`, `title`, `lead`, `status` (open/review/done/closed/parked), `worktree`, `slack_thread_ts`, `opened_at`, `closed_at`; **parked discoveries are tasks with status `parked`**, visible in the Home tab, never worked on without the owner |
| `outbox` | every Slack side effect, written in the same transaction as its cause: `kind`, `payload`, `channel`, `attempts`, `next_attempt_at`, `done_at`, `slack_ts` |
| `inbox` | every Slack event: `event_id` UNIQUE, `logical_key` (channel+ts), `received_at`, `processed_at` |
| `renders` | one row per interactive card: buttons carry the row id, never the payload |
| `schedules` | declared by standing agents: `agent`, `cron`, `prompt`, `last_fired` |
| `events` | the audit stream, monotonic id; every state mutation writes its event in the same transaction; a JSONL file is a derived tail, never a second writer |

Indexes: `messages(to, id)` ("undelivered" is a join on `turn_messages`, so this index is plain
and the query is `NOT EXISTS`); `messages(container_id, id)`; partial
`outbox(next_attempt_at) WHERE done_at IS NULL`; `turns(agent, started_at DESC)`; unique
`inbox(event_id)`; `inbox(logical_key)`; `requests(status, created_at)`. The loader's `version`
hashes paths relative to the home folder, so the same content gives the same version on every
machine.

"Open asks" (for the Home tab) are **derived**: "an unanswered `ask` from this agent to the owner
exists", never a flag that a crash could leave set.

## 6. Messaging

- A **container** is a standing channel (an agent and the owner, or two agents) or a **task
  thread** (the lead, the task's job agents, the owner). Members are fixed by the hire and the
  task; a message may address any member of the container it is posted in, and nobody else.
- Every message has one **addressee** (`to`). The daemon appends the row, queues the mirror in
  the outbox, and wakes the addressee only.
- A message has a `kind`: `say` (information), `ask` (needs an answer), `report` (a
  deliverable), `system` (written by the daemon: hired, paused, approval results).
- **The turn's result is the message.** The CLI returns an envelope
  `{ messages: [{ container, to, kind, body, tests_green? }], remember?: string[], parked?: [{title, why}] }`
  (`tests_green` is required on a `report` from a developer or designer: it is the one test result
  the daemon can see, and it feeds the rung counter of section 10)
  validated by `--json-schema`; the daemon appends each message, applies `remember` to
  `MEMORY.md` (standing agents), and turns `parked` into `tasks` rows with status `parked`. A
  result that fails the schema after the CLI's own retries is a failed turn (13). The `post`
  tool exists only for a message that must go out **before** the turn ends (for example, telling
  the owner "ci lavoro" before a long job).
- **Questions to the owner are never capped or held** (owner, 2026-09-18). Every `ask` is its
  own tracked card, answerable in any order, listed in the Home tab as "N domande in attesa",
  expiring after `approvals.timeout_hours`. What limits asking is role prose: ask only what
  blocks, group independent questions into one card.
- **The owner's replies are routed exactly.** An `ask` to the owner carries a **Rispondi**
  button that opens a modal whose `private_metadata` holds the message id. Text the owner types
  in a container without the button goes to the member with the most recent open `ask` there; if
  none, to the container's default addressee (the agent of a standing channel, the lead of a
  task thread). There is no other addressing convention.
- **Mentions.** `<@owner>` is attached only to `ask`, approval cards and failure notices, never
  to `say` or `report`; a repeat of the same notice **edits** its card rather than posting a new
  one. Notification hours are Slack's business: the owner's own Do Not Disturb and per-channel
  preferences apply, and the daemon never schedules or batches anything around them.
- **Wake rules.** A post wakes the addressee unless it is paused or already running (then the
  loop's dirty flag records it). The pending set is a query, so a restart replays wakes for free.
- **Task loop guard.** Nothing else bounds an agent ⇄ agent exchange, so the daemon counts per
  task: `loop_guard.messages` agent-authored messages with no owner message and no status change,
  or `loop_guard.review_rejections` rejected reviews, and the task card becomes "bloccato" with
  **Sblocca** / **Chiudi**; the task's agents get a `system` note and no further wake until the
  owner presses a button. Counters reset on any owner message in the thread.
- **What a turn reads.** The daemon builds the turn prompt: a header with the agent's own state
  (open asks, pending requests and permissions, last turn's cost, cache hit ratio), the messages
  addressed to the agent since its last turn, per container, the outcome of any request or
  permission it was waiting for, and any `remember` lines applied since the session started.
  Every agent resumes its own transcript with `--resume`; a job agent's transcript starts at task
  open and is discarded at task close.
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
  --max-turns 60 --max-budget-usd 5                       (fixed daemon constants)
  --permission-mode <role mode> --allowedTools <…> --disallowedTools <bare names>
  --permission-prompt-tool stdio
  --permission-prompts host
  --setting-sources ""                                    (nothing of the owner's leaks in)
  --settings '<json: permissions.allow/deny + PreToolUse hooks for this role>'
  --mcp-config <byte-stable json: agentopolis (alwaysLoad) + role tools> --strict-mcp-config
  --agents '<json: the role's subagents>'
  --append-system-prompt-file <STYLE.md + roles/<role>/AGENT.md + agents/<name>/AGENT.md if present, in that order>
  --system-prompt-snapshot off
  --exclude-dynamic-system-prompt-sections
  --json-schema '<the envelope schema of section 6>'
  --name <agent name>
```

Environment for every spawn: `CLAUDE_CODE_PROMPT_CACHE_TTL=1h`,
`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=5m`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW=100000`,
`CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1`, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=30000`,
`MCP_TIMEOUT=5000`, `DISABLE_AUTOUPDATER=1`, `DISABLE_TELEMETRY=1`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, plus `AGENTOPOLIS_TURN_ID`,
`AGENTOPOLIS_AGENT`, `AGENTOPOLIS_TOKEN`, `AGENTOPOLIS_SOCKET` for the MCP server.

Rules:

- Never `--bare` (it never reads the subscription login [documented]) and never `--continue`.
- All flags above exist on 2.1.276 [verified with a credential-less run]; `--max-turns` is
  accepted although hidden from `--help`.
- **The system prompt is rebuilt every request** with `--system-prompt-snapshot off`; by
  default the CLI records it at the session's first request and reuses it until compaction, so
  a role edit would never reach a resumed agent [verified]. With the switch off, an unchanged
  prompt still hits the cache; an edited one costs one uncached turn and applies [live
  2026-09-18: the second answer followed the edited prompt; 15,917 tokens read from cache,
  4,067 rewritten].
- The first user message of a session (never the system prompt) carries, in this order, the
  agent's `MEMORY.md`, the company `knowledge/`, and the project's `knowledge/`.
- The turn's user message is the first stdin line; stdin stays open until the `result` line
  because permission answers travel on it [measured].
- The runner parses the stream: `rate_limit_event` (utilization and reset per window, emitted
  before init on every turn [measured]), `system/init` (model, tools, MCP status; the turn fails
  only if the agentopolis server is `failed` or `needs-auth`, never on `pending`),
  `assistant`/`user` events (for the status line), `control_request` with subtype
  `can_use_tool` (section 10), `system/api_retry` (`rate_limit` and `overloaded` both count),
  `system/compact_boundary`, the final `result` (subtype, cost, `modelUsage`, usage, session id,
  `permission_denials`, `structured_output`).
- "Process exited without a `result` line" is the single failure predicate; its cost is null.
- Finalise on the child's `close`, not `exit`; drain stdout continuously and tee the raw stream
  to `runs/<turn-id>.ndjson`.
- Ending a turn early is SIGINT to the process group, then a grace period, then SIGKILL to the
  group; SIGTERM loses the turn's cost record (exit 143 [documented]) and is used only on daemon
  shutdown. The wall-clock watchdog (`max_minutes`) fires the same sequence,
  because `--max-turns` exhaustion has been reported to produce no result at all.
- One process per turn is a choice, not a constraint: the CLI can take further user messages on
  stdin [measured]. It is chosen for a trivial crash model and bounded memory (~200 MB per idle
  CLI [measured]); the 14× saving comes from `--resume`, not from process reuse.

## 8. The `agentopolis` MCP server

A stdio process per turn that forwards every call over a unix socket to the daemon (per-turn
token from its environment); it holds no state and never opens SQLite. Tools, kept to what the
envelope cannot do:

| tool | who | what |
|---|---|---|
| `post(container, to, body, kind)` | all | a message that must leave **before** the turn ends; otherwise the envelope is the message |
| `read_channel(container, since)` | ceo, lead | back-scroll only: messages after an id; new messages already arrive in the turn prompt |
| `request(kind, payload)` | per role | `open_task` (payload: title, kind develop/review/design, `preset` piccolo/normale/difficile or explicit `model`+`effort` from the role's menu, `reason`), `close_task`, `merge_production`; the daemon answers with a request id, the outcome arrives in a later turn prompt; a value outside the menu is refused, a gated value answers "in attesa del proprietario" and renders a card |

Which `request` kinds a role may use is in `role.yaml`; the daemon refuses the rest and says why.
Permission prompts are **not** a tool: they arrive on the CLI's control channel (10). Memory
writes and parked discoveries travel in the envelope (6). Hiring, pausing and model changes are
owner actions in Slack (9), never agent requests in v1; the ceo proposes a hire as an `ask` with
the filled form in its text, and the owner submits `/hire`.

## 9. Slack surface

This section is the contract for the mirror module. API facts were read on docs.slack.dev on
2026-09-18; field practice comes from openclaw, nanoclaw, dust, vercel/chat, opentag and switch,
read the same day.

### Identity

**One Slack app per standing agent** (owner, 2026-09-19, after seeing colleagues as real users in
other systems). The **company app** is the ceo's identity: its direct message is the owner's
chat with the ceo, and it owns the slash commands, the Home tab and every app-identity card
(task cards, approval cards, status lines). Each **lead** is its own app: a real user with its
own direct message, `@mention`, presence and avatar. Both manifests live in `deploy/`
(`slack-manifest-company.yaml`, `slack-manifest-agent.yaml`); hiring a standing agent means the
owner creates its app from the template and puts its two tokens in the environment
(`SLACK_BOT_TOKEN_<AGENT>`, `SLACK_APP_TOKEN_<AGENT>`), named in `config.yaml` under
`slack.apps` and referenced by `agent.yaml` as `slack_app`. The daemon runs one Socket Mode
connection per app. The free plan allows ten apps; v1 uses two.

**Job agents are personas**, not apps: a developer or reviewer posts in its task thread through
the lead's app with the `username` and `icon_url` overrides (scope `chat:write.customize`,
degrading to `icon_emoji`, then bare `username`, then plain if a scope is missing [field]).
Personas cannot be mentioned and have no presence; nobody needs to mention a job agent.

**A persona message is immutable.** `chat.update` documents no identity arguments [verified] and
no serious implementation edits a persona message [field]. Anything that changes after posting
is posted by the company app under its own identity, with the author named in a `context` line
("Nina chiede"). A standing agent's own messages (posted by its own app) can be edited by that
app; the mirror still never edits them, for one rule instead of two.

### Containers

- **The ceo's direct message** (the company app's Messages tab): owner ⇄ ceo. No `#ceo` channel.
- **Each lead's direct message**: owner ⇄ that lead, for talking. `#<project>-hq`: owner ⇄ lead
  for decisions, approvals and receipts, where the owner wants a record beside the work. (The
  bare `#<project>` is not used: Slack refuses a channel named like the workspace, found live on
  2026-09-19.)
- `#<project>-work`: the project's working channel, which the owner is told to mute during
  onboarding (mentions still badge through a mute [documented]). One **thread per task**: the
  parent is the app-identity task card (title, state, cost so far, agents engaged), edited in
  place; replies are the traffic lead ⇄ job agents plus any owner exchange. While a turn runs in
  a thread the daemon sets `agents.sessions.setStatus` to `processing` with the persona's
  identity and back to `active` after; the method accepts `thread_ts` in regular channels and
  returns `feature_disabled` when the workspace lacks the feature [verified, live check 2], in
  which case nothing is shown until the turn passes 60 s (see Status lines).
- Channels are private, created by the bot with `conversations.create`, the owner invited;
  names lowercase, digits, `-`/`_`, at most 80 characters. A channel that has served its purpose
  is **archived**, never deleted (no API deletes a channel on a normal workspace); rows stay.
- Job agents never get a channel of their own; their container is the task thread.
- `thread_ts` is passed as the string Slack returned, never parsed to a number.
- **The store is the only history.** The mirror never reads Slack history back
  (`conversations.history`/`replies` are throttled); inbound owner messages arrive through events
  and are stored on arrival.

### Inbox contract

- Events, per app: `message.channels`/`message.groups`/`message.im`, `reaction_added`,
  `app_home_opened` (company app), `member_joined_channel`, `channel_archive`; interactivity: `block_actions`, `view_submission`,
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
  `context` (who asks · project), `actions` with at most **three** buttons (more choices become
  a `static_select`); button `value` is the `renders` row id plus an option index, never the
  payload. On answer the card keeps the question text and replaces the actions row with a muted
  line naming the decision [field]; `chat.update` with `channel`+`ts` does it. An unanswered ask
  simply stays open: the owner uses Slack's own "save for later" or reminders if he wants a nudge.
- A free-text `ask` is a persona message with the owner mention plus an app-identity line with
  **Rispondi** (modal) so the answer is routed exactly.
- **Approval cards** (gated requests and parked permission prompts): the request in one line,
  a `context` line with who asked, buttons **Approva** (primary), **Approva per questo compito**
  (scope `task`, for permission prompts only), **Nega** (danger, with a `confirm` dialog for
  destructive kinds), and **Dettagli** (modal with the full payload, stderr behind "Dettagli
  tecnici"). `value` carries the row id and an `epoch`; a stale epoch is rejected. On decision
  the card is rewritten with the outcome; on expiry (24 h, never for `merge_production`) with
  "Scaduta: nessuno ha risposto, l'ho trattata come un no" and **Riapri**.
- Forms are modals (`views.open` from a `trigger_id`, which exists only on an interaction
  payload and expires in 3 seconds): at most six inputs, defaults pre-filled from `role.yaml`,
  `radio_buttons` never beyond 10 options, `private_metadata` ≤3000 characters, validation
  errors as `response_action: errors`. `/edit <agent>` opens `AGENT.md` or `MEMORY.md` in a
  multiline field; on submit the daemon stores the previous content in the `events` row, writes
  the file, and posts a card "AGENT.md di Leo aggiornato · +3 −1 righe" with **Vedi differenze**
  (modal, code block) and **Annulla** (writes the stored previous content back, card edited to
  confirm). Anything over ~2,000 characters is edited in the file directly.

### Slash commands (manifest `features.slash_commands`)

Four: `/agentopolis` (opens the Home tab), `/hire` (modal), `/edit <agent>` (modal),
`/diag <agent>` (last turn's exit code, stderr tail, run file path, ephemeral). Everything else
(pause, resume, model, costs, retire) is an overflow menu on the agent's row in the Home tab.
Each is a daemon action, not an agent turn.

### Status lines and receipts

Inside task threads only, and only once a turn has run for **60 seconds**: one app-identity line
("Leo sta lavorando · 2 min"), edited in place at most once every 30 seconds through the same
per-channel bucket at lowest priority (three tasks at one edit per second would be 180
`chat.update` a minute against Slack's 50), never re-posted; at turn end it becomes the receipt
(duration, cost "stimato", `config_version`). Where `chat.startStream`/`appendStream`/
`stopStream` is available it is preferred (identity is set at stream open, segments rotated
before 240 s [field]); the edited line is the fallback. Owner-facing channels get receipts only.

### Digest

The ceo's check-in is a **product feature the owner asked for, sent only if something happened**,
at the time the ceo's schedule declares: one line per project (fatto / in corso / bloccato),
questions waiting, cost so far this month "stimato", one suggested next action as a button. It
is never a notification mechanism and never batches other messages.

### App Home

`views.publish` on `app_home_opened` and after every daemon action. Shows: month-to-date cost
"stimato"; "Ti aspettano" (open asks and pending approvals, ≤5 with **Apri**); projects with
**Vai**; agents as `fields` (≤10 per section) with state glyph and cost, an overflow per agent
(Pausa / Riattiva / Modello / Ricomincia da capo, which starts a fresh session and keeps
`MEMORY.md` / Licenzia); parked discoveries with **Apri come compito**; actions
**Assumi**; "Aggiornato alle hh:mm". At most 100 blocks; beyond that a "…e altri N" line.

### Files

Long deliverables stay in the worktree; when one must reach Slack (a mockup image, a report on
request) the mirror uses `files.getUploadURLExternal` + `files.completeUploadExternal`. Canvases
are not used in v1.

### Client and limits, in one module

`limits.ts` holds and the mirror enforces: 1 message per second per channel; text split at 3,000
characters per `section`; ≤50 blocks per message, ≤100 per Home tab; button text 75 characters;
`value` 2,000 characters; modal title 24 characters; `private_metadata` 3,000. Per-method
budgets under Slack's tiers, in one table (`chat.update` 50/min, `conversations.*` 40/min,
`chat.appendStream` 160/min) [field]. The Slack client is created with a **bounded retry policy
and a per-request timeout**: the SDK default retries a rate-limited call for up to ~30 minutes
and would stall a turn [field]. `agents.sessions.*` calls are wrapped in try/catch and only warn.
Bolt for JavaScript is used directly; `vercel/chat`'s Slack adapter was considered and set aside
because it has no outbound persona support.

### Manifest

The single copy is `deploy/slack-manifest.yaml` in this repository; it declares the four slash
commands, the scopes `chat:write`, `chat:write.customize`, `commands`, `groups:write`,
`groups:history`, `groups:read`, `channels:manage`, `channels:history`, `channels:read`,
`reactions:read`, `users:read`, `files:write`, Socket Mode, interactivity, the Home tab, and the
event subscriptions above. Agent features (`agents.sessions.*`) are enhancements gated on live
check 2; v1 never requires them.

## 10. Approvals and governance

Three tiers, each where the agent can only ask:

1. **PreToolUse hooks** (injected per turn via `--settings`, exit 2 = hard deny that no allow can
   override [documented]) for absolutes with no round-trip: `git push` to a production branch,
   writes outside the worktree, `git add -A`.
2. **The permission channel.** With `--permission-prompt-tool stdio` the CLI writes a
   `control_request` of subtype `can_use_tool` (tool name, input, `tool_use_id`) to stdout and
   waits for a `control_response` with `behavior: allow|deny` [measured end to end on 2.1.276; a
   request held 200 s was still answered, live check 4]. Rules in `role.yaml` answer most calls
   without the owner. What no rule covers is **held, then parked** (owner, 2026-09-19): the
   daemon renders the approval card at once and keeps the `can_use_tool` request open for
   `permission_hold_minutes` (default 5; a 200 s hold was verified, live check 4) while the
   watchdog keeps running; if the button lands in time the turn continues exactly where it was,
   with no re-planning. If not, the daemon answers `deny` with a reason written for the model
   ("parked for the owner; end this turn now with your envelope; you will be woken with the
   decision"), stores the request in `permission_requests`, and re-wakes the agent with the
   decision when the button lands. "Approva per questo compito" stores an allow rule scoped to
   the task id.
3. **Daemon actions**, always a card: merge or push to a production branch (`merge_production`,
   never expires); a **gated model or effort** (`config.gated`: Fable for any role, Opus/Fable or
   an effort change on the research subagent): the `open_task` or model change is stored, the
   card says "Ada chiede Fable per *<task>* · motivo: <reason>", and the task waits or runs one
   rung below as the payload says; Approva spawns with the gated value in a new session, Nega or
   expiry gives the lead a `system` note; the owner can always set any value from the Home tab
   without a card. **The rung counter**: two `report`s with `tests_green: false` on the same
   model/effort rung, or two rejected reviews, and the daemon refuses another turn on that rung;
   the lead's only moves are to reopen one rung up (Sonnet/high → Opus/high → Fable/high, the
   last through the owner's card) or to ask the owner. The lead decides, the daemon enforces.

- **Runaway guards, per turn.** The wall-clock watchdog (`max_minutes` per role) is the one that
  always binds; `--max-budget-usd 5` (an estimate that stops the turn: verified to fire under a
  subscription login, live check 5) and `--max-turns 60` are fixed daemon constants. None is a
  budget.
- **Costs are shown, never gated.** Per agent and per month in the Home tab and on receipts,
  always "stimato". There is no monthly budget in v1 (owner, 2026-09-18).
- **Pause.** A paused agent gets no turns; the pending set waits; unpause runs one turn that reads
  everything. A lead cannot open a task for a paused developer.
- **Production branches.** `project.yaml` names them; the daemon's git operations refuse them
  without an approved request, and the PreToolUse hook refuses the agent's own `git push` there.

## 11. Development tasks

1. The owner (or the ceo) asks the lead for something in `#<project>`.
2. The lead `request(open_task, {title, kind: develop|review|design, preset|model+effort,
   reason})`, choosing from the role's menu (presets on the task card: `piccolo` Sonnet/medium,
   `normale` Sonnet/high, `difficile` Opus/high). The daemon creates the task row, the thread in
   `#<project>-work`, a git worktree from the work branch, and the job agent row (`dev-<n>`,
   `designer-<n>` with the next display name from `job_names`). A rung change later is a new
   session for the job agent (a mid-session switch invalidates the cache [verified]).
3. The lead's next envelope carries the brief addressed to the job agent. The agent works in the
   worktree, spawning `research`/`design` subagents inside its turn when useful; it reports with
   a `report` message (five lines) and the file `reports/<task>.md`.
4. The lead may open a review task: the reviewer gets a daemon-built summary of the thread plus
   the diff, never the raw thread, in a read-only worktree with `Edit`/`Write` stripped.
5. Merge to the work branch is the lead's; merge to production is `request(merge_production)`.
6. `request(close_task)` retires the job agents, removes the worktree, edits the task card,
   delivers the report to the lead.

The protocol content lives in the roles' `AGENT.md` files and ships with the repo: lean briefs,
one deliverable per task, tests green before a report (`tests_green` in the envelope), the
escalation ladder ("after two rejections or two rounds without progress on the same brief,
reopen one rung up; if the top rung fails, ask the owner"), the parked-permission rule ("a deny
that says parked ends your turn: send the envelope, you will be woken"), review findings separated by provenance,
staging explicit paths, `parked` for discoveries outside the task, and the **never-add list** of
principle 8.

## 12. Roles in v1

| role | kind | default model / effort | lead's menu at `open_task` | tools kept | stripped | notes |
|---|---|---|---|---|---|---|
| ceo | standing | Sonnet / medium | fixed (owner, Home tab) | agentopolis, research | Edit, Write, NotebookEdit, Bash | the owner's concierge; proposes hires as asks; conditional digest; thin until the second project |
| lead | standing per project | Opus / high | fixed (owner, Home tab) | agentopolis, github, repo cwd, research | Edit, Write, NotebookEdit | product owner + engineering lead; briefs; picks the job agents' rung from the menu; merges to the work branch |
| developer | job | Sonnet / high | Sonnet, Opus · medium, high | agentopolis, repo cwd, research | WebSearch, WebFetch | one deliverable per task, worktree, `tests_green` in the report |
| reviewer | job | Opus / medium | Sonnet, Opus · medium, high | agentopolis, repo cwd read-only | Edit, Write, NotebookEdit, WebSearch, WebFetch | findings by provenance; never edits; a different model than the writer by default |
| designer | job | Sonnet / high | Sonnet, Opus · medium, high | agentopolis, worktree (writes under `design/`), research | Bash outside `design/` | mockups (HTML), flows, interface note under `design/`; its own thread and report the owner reviews |

No role uses `xhigh` (owner, 2026-09-19). Fable needs the owner's card for every role (section
10). Rationale: operators run a loop whose oracle is the test runner, so the smaller model at high
effort is the default and the lead escalates on evidence; the reviewer gains from being a
different model than the writer; the ceo has no problem to solve.

Subagent (`roles/<role>/subagents/research.md`, passed with `--agents`): `research`, Sonnet /
medium, read-only, web fetch and search, returns a sourced file under `reports/`. It runs inside
the calling agent's turn and costs that agent's guards; its report is an input the calling agent
verifies, never evidence on its own. Opus or Fable on it, or an effort change, are gated.

Effort and model are set at spawn only; a change from the Home tab starts a fresh session (a
mid-session switch invalidates the whole cache [verified]). Each role ships `role.yaml` and
`AGENT.md`; `STYLE.md` at the repo root is composed before `AGENT.md` into every prompt.

## 13. When things go wrong

Every owner-facing error names the consequence in the owner's language and offers at most two
buttons; stderr goes behind "Dettagli tecnici".

| situation | behaviour |
|---|---|
| CLI process exits without a `result` | turn = failed, cost null, stderr tail stored; one automatic retry; then "Leo si è fermato per un errore tecnico. Ho già riprovato una volta." with **Riprova** / **Lascia stare** |
| `result` fails the envelope schema after the CLI's retries (`error_max_structured_output_retries`) | turn = failed; the raw result text is kept in the run file; same owner message |
| `result.subtype` = `error_max_budget_usd` / `error_max_turns` | turn = budget_exhausted / max_turns; queued messages start a new turn with their own guards |
| wall-clock watchdog fires | SIGINT → grace → SIGKILL group; turn = timed_out; same owner message as a failure |
| `rate_limit_event` reports `allowed_warning` or a window above 90% | **back-off**: `max_concurrent_turns` drops to 1 until the window resets; nothing else changes |
| `rate_limit_event` says the subscription window is exhausted, or `api_retry` with `rate_limit`/`overloaded` persists | **limit pause**: no new turns; one owner message, edited in place with each change; turns resume at the event's `resetsAt`; no probe process; the Home tab counts the hours paused this month. There is no paid overflow (owner: "free or nothing") |
| `system/compact_boundary` in a turn's stream | a `system` line on the task card ("contesto compattato"), so the owner knows why an agent may repeat itself; compaction is lossy and expected |
| Slack unreachable | outbox rows wait with backoff; nothing is dropped; the Home tab shows "Slack non raggiungibile da hh:mm" once it is back |
| malformed role/agent/project file | rejected with a message in the ceo's direct message naming the file and the error; last valid snapshot stays loaded |
| result without cost | `cost_microusd = null`; shown as "sconosciuto"; never estimated |
| approval never answered | expires per section 10; card edited |
| daemon restart | running turns become `interrupted` (never re-run automatically; the agent gets a `system` note that its turn was cut and the channel is the truth); orphan `claude` processes with an `AGENTOPOLIS_TURN_ID` are reaped; pending wakes replay from the store; open cards re-rendered |
| `--resume` fails ("No conversation found", or no `system/init`) | start a fresh session (first user message = `MEMORY.md` + knowledge + the last 20 messages of its containers from the store), with a `system` note; never loop |
| agentopolis MCP server `failed`/`needs-auth` at init | turn failed; `pending` is not a failure |
| cache hit ratio of a resumed turn below 0.7 twice running | `system` message in the ceo's direct message: something in the prefix is moving |

Process supervision: children spawned `detached` in their own process group and killed as a
group; stdout drained continuously; `close` not `exit`; two-stage stop; global concurrency cap
plus `MemoryMax=` in the unit; shutdown = stop wakes, close the Slack socket, bounded drain
(~120 s), SIGINT children, flush the outbox, `wal_checkpoint(TRUNCATE)`. systemd unit:
`Type=notify` (READY after migrations and Slack connect), `WatchdogSec` pinged from the scheduler
tick, `KillMode=mixed`, `TimeoutStopSec` above the drain, `Restart=always`, `EnvironmentFile=`
mode 0600. `/healthz` on localhost: running turns, queue depth, last Slack event age, WAL bytes.
A nightly cron copies the database with `sqlite3 .backup` to a dated file and keeps 14; that is
the whole backup story in v1.

Observability: pino to stdout (journald), token-shaped values redacted, one line per state
transition; `/healthz` (running turns, queue depth, last Slack event age, WAL bytes) and `/diag`.
No tracing and no metrics pipeline in v1: the `turns` and `events` tables answer every question
the owner has asked so far.

## 14. Testing

- **Unit** (vitest): loader validation, router wake rules, envelope validation and delivery,
  derived open-ask state, approval state machine and epochs, stream parser (every message type,
  unknown types ignored, broken lines skipped), Slack block builders, limits module, prompt
  composition order, subagent JSON generation.
- **Contract suite against the CLI, dual target**: the same suite runs against `fake-claude`
  in CI and against the real CLI behind `--live` by hand or nightly, so the fake cannot drift. The
  fake replays fixtures for `rate_limit_event`, `system/init` (including `pending` servers),
  `can_use_tool` control requests, `keep_alive`, `api_retry`, `compact_boundary`, results with
  and without cost, results with and without `structured_output`, `permission_denials`, and
  pathologies: truncated line, exit 1 with stderr, a hang, a child ignoring SIGINT, a 10 MB line,
  exit without result.
- **Fake Slack**: an in-process stub of the Bolt client recording calls; asserts personas never
  edited, cards rewritten, archive on close, block shapes and limits, ack-before-process order.
- **Property tests** (fast-check): scheduler (never two turns per agent, every message consumed
  exactly once, none before creation); outbox pump (any crash point is at-least-once, never lost);
  text splitter (blocks ≤3,000 chars, ≤50 blocks, concatenates back).
- **Crash recovery**: the daemon run as a child, SIGKILLed mid-turn, restarted; invariants hold
  (turn interrupted, no re-run, wakes replayed, cards re-rendered).
- **One live smoke on the owner's Mac** with the real CLI and the owner's workspace before the
  first VPS deploy: ceo greets, owner answers, lead opens a trivial task, approval card works,
  the Home shows the turns' cost.
- CI on GitHub Actions: Biome, typecheck, unit, fake-CLI contract, fake-Slack, property, crash.

## 15. Done when

All of these hold on the VPS, with the real CLI and the owner's Slack workspace:

1. `systemctl status agentopolis` is active; a `kill -9` mid-turn followed by a restart loses no
   message, marks the turn interrupted, and re-renders open cards.
2. The owner writes in the ceo's direct message and gets an answer within one turn, in the
   language he wrote in, delivered from the turn's envelope with no `post` call.
3. The owner asks the lead in `#agentopolis` for a small change to this repository; a task
   thread appears in `#agentopolis-work`; a developer delivers on a branch; a reviewer reports;
   the lead merges to `dev`; the `merge_production` card appears in `#agentopolis`; the owner
   approves; `master` receives the merge.
4. The Home tab shows a per-agent, month-to-date cost labelled "stimato" whose integers equal
   the sum of `turns.cost_microusd`.
5. Pausing the developer from the Home tab during a task stops its next turn; resuming runs the
   pending turn.
6. Editing `roles/lead/AGENT.md` changes the lead's next turn without a daemon restart, and that
   turn's `cache_creation` is the only uncached one in the sequence.
7. A resumed lead turn reports `cache_read_input_tokens` above 90% of its input.
8. A parked permission prompt appears as a card; "Approva per questo compito" lets the same
   tool call pass on the next turn without a card.
9. A developer turn that spawns the `research` subagent finishes with the subagent's file under
   `reports/` and its cost inside the turn's `modelUsage`.

## 16. Stack

TypeScript on Node LTS, pnpm, Bolt for JavaScript (Socket Mode), better-sqlite3 + Drizzle,
zod + yaml, chokidar, croner, p-limit, pino, sd-notify, `@modelcontextprotocol/sdk` (the
per-turn MCP server only), vitest, fast-check, Biome, a systemd unit and a backup cron under
`deploy/`. No agent framework and no Claude SDK: the daemon is a
direct NDJSON peer of the CLI. One package; folders `src/<module>/` mirror section 3.

## 17. Assumptions to confirm with the owner

- The first project is this repository.
- Standing agents' names, chosen by the owner on 2026-09-19: **Jarvis** (ceo), **Ada** (lead
  Agentopolis), **Penny** (lead Fincanva), **Giano** (lead Ianus). Their Slack apps carry the same
  names; token env vars are `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` for Jarvis (the company app)
  and `SLACK_BOT_TOKEN_ADA`, `_PENNY`, `_GIANO` for the leads. Job agents get a display name
  from `config.job_names` with their internal id kept.
- Slack free plan for now (90-day history is acceptable: the store keeps everything; the agent
  features of section 9 may need a paid plan and are never required).

## 18. Live checks

Settled by throwaway scripts against the real workspace and the installed CLI, with the answer
recorded here.

1. `chat.update` **keeps** the persona of a message: the response carried
   `message.username: "Nina · developer"` and `icons: {"emoji": ":female-technologist:"}`, and
   in Slack the edited message still showed Nina's name and icon, grouped under "Nina ·
   developer" [live 2026-09-19, Ada's app, `#agentopolis-work`]. The assumption ("no", five
   codebases never try) was wrong: a persona message *can* be updated. "A persona message is
   immutable" stays as a design choice (one rule instead of two, section 9), not a constraint.
2. `agents.sessions.setStatus` and `agents.sessions.rename` both return **`not_authorized`** for
   Ada's app in a private channel thread (agent features unavailable for this app or plan)
   [live 2026-09-19]. v1 never requires them; the edited status line is the only path.
3. `--output-format stream-json` **carries** `structured_output` when `--json-schema` is passed:
   the result line held `{"word":"ok"}` [live 2026-09-18, claude 2.1.276].
4. A `can_use_tool` request **held 200 s was still answered**: allow accepted, no denials, the
   command ran after the hold [live 2026-09-18, claude 2.1.276].
5. `--max-budget-usd` **stops a turn under a subscription login**: `error_max_budget_usd` with
   `apiKeySource: "none"` [live 2026-09-18, claude 2.1.276].
6. `--append-system-prompt-file` with `--system-prompt-snapshot off` **applies on resume**: the
   second answer followed the edited prompt; 15,917 tokens read from cache, 4,067 rewritten [live
   2026-09-18, claude 2.1.276, on the Mac; re-check on the VPS's CLI version in slice 7].
7. Does a tool-heavy turn still return a valid envelope on the first try, and how often does the
   CLI's structured-output retry fire? [pending, the owner's by-hand run:
   `AGENTOPOLIS_LIVE=1 AGENTOPOLIS_CHECKS=7 pnpm live:checks`]
8. Fable under the subscription: (a) `--model` with Fable starts under the subscription login and
   `system/init` reports it; (b) that turn's `result` cost is priced with Fable's list, so the
   Home tab shows it right; (c) a `--agents` JSON with `model: opus` on `research` is honoured per
   spawn. [(a)–(c) pending, the owner's by-hand run: `AGENTOPOLIS_LIVE=1 AGENTOPOLIS_CHECKS=8
   pnpm live:checks`]
   (d) **answered: `maxEffortLevel` exists.** The installed 2.1.277 bundle carries the settings
   key, described as "Maximum effort level. Anything above it (an `/effort` or `/model` pick,
   `--effort`, `CLAUDE_CODE_EFFORT_LEVEL`, a model default) … across settings files the lowest
   value wins, and `modelSettings.<model>.maxEffortLevel` replaces it per model. Enforced
   client-side: an effort supplied through `CLAUDE_CODE_EXTRA_BODY` is not clamped."
   The daemon therefore passes `maxEffortLevel: "high"` in every turn's `--settings`, so "no
   xhigh" is enforced rather than written (principle 4) [verified 2026-09-19 against the
   installed binary, no turn spent].
9. Cache TTL weight on the subscription: the API prices a 1 h cache write at 2× and a 5 m write
   at 1.25×; run the same two-turn script with `CLAUDE_CODE_PROMPT_CACHE_TTL` at `5m` and at
   `1h` and compare the `result` costs. If 1 h costs twice on write, job agents (bursty) may
   default to 5 m and standing agents to 1 h. [pending, the owner's by-hand run:
   `AGENTOPOLIS_LIVE=1 AGENTOPOLIS_CHECKS=9 pnpm live:checks`]

10. **The endpoint agent on the owner's Mac kills long argv.** SentinelOne SIGKILLs any
    `node <script>` spawned with a single argument of roughly 1,000 characters or more: 950
    characters runs, 1,000 is killed with exit 137 and no output at all [measured 2026-09-19,
    reproduced from a plain shell with a two-line script, outside this repository]. The CLI is a
    node program, so this killed every turn the daemon spawned while `--json-schema` carried the
    full 1,269-character envelope schema. The daemon now passes the schema as structure only
    (596 characters) with a hard guard at 950, and the field guidance moved into the turn prompt
    (`src/turn/envelope.ts`, `src/turn/prompt.ts`). **This is a live constraint on the owner's
    machine, not a design choice**: any future flag whose value approaches 1 kB will be killed
    the same way, silently. A question for the owner, in the slice 4 report.

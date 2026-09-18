# Agentopolis v1 — design

Status: approved in conversation with the owner on 2026-09-18; written for the agent that will
implement it. The owner is not a programmer: every rule here that touches him must be visible
from Slack, never only from a file.

## 1. What it is

A company of AI agents run by one owner from Slack. Each agent is a folder of text files. Agents
address one colleague at a time, never a room. The owner sees every exchange, answers questions with
buttons, and approves anything that reaches the world. A daemon on the owner's VPS makes it all
happen; the agents' engine is the Claude Code CLI on the owner's subscription.

### v1 scope

- The daemon, the home folder, the SQLite store, the Slack app (one bot user).
- Six roles: `ceo`, `lead`, `developer`, `reviewer`, `scout`, `designer`.
- Standing agents (always on, resume their own conversation): `ceo`, one `lead` per project.
- Job agents (born for one task, start fresh, retire when done): `developer`, `reviewer`,
  `scout`, `designer`.
- Addressed messages, mirrored to Slack: a channel per standing agent, a thread per task, the
  owner a member of all of them.
- Approvals with buttons; per-agent budgets; pause; one question at a time.
- One project: this repository. The company's first work is its own v2.

### Out of v1

Email and a support role, ops, QA, writer, any web page, several machines, mid-turn budget
enforcement, any chat surface other than Slack, one Slack bot per agent.

## 2. Principles

1. **Everything the system knows is a file or a row.** Roles, agents and projects are folders
   under git. Messages, turns, requests, approvals and usage are rows in SQLite. The daemon can be
   killed and restarted at any time and loses nothing.
2. **Addressed, never broadcast.** Every message has exactly one addressee. Only the addressee
   wakes, and only the addressee receives it in its turn. The owner is a member of every channel
   and thread by right and reads everything at zero token cost, because Slack is read by the
   daemon, not by a model. A lead never reads a task thread; it reads what is addressed to it. An
   agent may address the owner directly (`post(to: owner)`), which skips the lead entirely: a
   question routed through the lead would cost two lead turns on the largest context in the
   company. Cost grows with the work, not with the number of colleagues.
3. **Wake on event, never on a clock.** An agent runs a turn because something was posted to it,
   an approval came back, or a scheduled job it declared fired. There is no heartbeat.
4. **The daemon enforces; prose advises.** Anything that must hold (approvals, budgets, pause,
   one question at a time, production branches) is enforced where the agent can only ask. Role
   prose explains the rule; it never carries it alone.
5. **Numbers are measured or absent.** Costs come from the CLI's result event; a turn without a
   cost record is logged as unknown and shown as such, never estimated.
6. **Adding or changing an agent is editing a folder.** No rebuild, no restart, no code.
7. **The owner's language.** Agents write to the owner in Italian. Files, code, commits and
   logs are in English.
8. **Token rules, enforced by the daemon, not by asking agents to be frugal:**
   - only the addressee is billed (principle 2);
   - every agent, standing or job, resumes its own CLI session (`--resume`) so nothing is
     re-read: a job agent starts fresh when its task opens and resumes until the task closes;
   - `read_channel` always carries `since`; the daemon never injects a message twice;
   - long deliverables are files in the worktree (`reports/<task>.md`, `design/…`); the message
     carries a summary of at most five lines; the reader opens the file only when it needs to;
   - the composed system prompt has a stable order (role, instance, memory, project knowledge)
     with the turn's new messages last, so the API's prompt cache covers almost the whole context;
   - status lines, receipts, `/costs`, the Home tab are written by the daemon: zero tokens;
   - no heartbeat, no unrequested digest; the ceo is never copied on owner ⇄ lead traffic;
   - `--max-budget-usd` per turn kills a runaway loop before it costs;
   - a task's close delivers the report to the lead, never the thread.

## 3. Architecture

```
┌──────────────── Slack (one app, Socket Mode) ────────────────┐
│  #ceo   #agentopolis   #agentopolis-work (threads)   Home tab │
└───────────────▲───────────────────────────────┬──────────────┘
                │ mirror out (personas)          │ owner input, buttons, modals
┌───────────────┴───────────────────────────────▼──────────────┐
│                      agentopolis daemon (Node/TS)             │
│  loader ─ router ─ scheduler ─ runner ─ approvals ─ mirror    │
│  SQLite (drizzle)        MCP server "agentopolis" (stdio)     │
└──────▲──────────────────────────────▲─────────────────────────┘
       │ reads/watches                 │ spawns per turn
~/agentopolis/ (git)            claude -p … (subscription login)
  roles/ agents/ projects/
```

Components, each one module with one job:

- **loader**: reads and validates `roles/`, `agents/`, `projects/`, `config.yaml`; watches for
  changes; rejects a malformed file loudly and keeps the last good version.
- **store**: SQLite through Drizzle; append-only tables for messages and usage; migrations in
  repo.
- **router**: decides which agent a posted message wakes, and whether it may (pause, question
  hold, budget).
- **scheduler**: one turn at a time per agent; queues wakes that arrive during a turn; runs
  declared schedules.
- **runner**: builds and spawns the `claude -p` process for one turn, streams its events, records
  usage and session id, handles the permission prompt tool.
- **approvals**: holds requests, renders them to Slack, applies decisions, times out.
- **mirror**: posts messages to Slack as personas, edits status lines in place, turns Slack input
  into rows.
- **mcp server**: the tools agents use to talk and to ask (section 8).

## 4. Home folder

```
~/agentopolis/                      git repository; the daemon commits its own changes
  config.yaml
  roles/<role>/
    role.yaml
    SOUL.md        who it is: voice, stance, boundaries
    JOB.md         what it does, what "done" means, what it never does
    PROTOCOL.md    how it works with others (briefs, reports, reviews, ledger)
  agents/<name>/
    agent.yaml
    MEMORY.md      curated long-term memory, written by the agent through the daemon
  projects/<slug>/
    project.yaml
    knowledge/     any text the project's agents should read on start
  data/agentopolis.db                 gitignored
```

### role.yaml

```yaml
name: lead
description: Runs one product's engineering. Owner-facing for that product.   # routing text
kind: standing            # standing | job
model: opus               # alias or full id
effort: xhigh             # optional; omitted = CLI default
tools:                    # MCP servers this role may use, by name from config.yaml
  - agentopolis           # always implied
  - github
permissions:
  mode: acceptEdits       # CLI permission mode for the turn
  allow: ["Bash(git *)", "Read", "Edit", "Write"]
  deny:  ["Bash(rm -rf *)"]
budget:
  monthly_usd: 60         # default for instances; agent.yaml may override
  per_turn_usd: 5         # --max-budget-usd for each turn
max_turns: 60             # --max-turns for each turn
talks_to: [ceo, owner, developer, reviewer, scout, designer]   # who may share a channel
```

### agent.yaml (an instance)

```yaml
name: agentopolis-lead
display: Leo
avatar: https://…/leo.png
role: lead
project: agentopolis
reports_to: ceo
model: null               # null = role default
budget_monthly_usd: null
paused: false
session_id: null          # last CLI session id, written by the daemon
```

Job agents get an instance too (`agents/dev-3/`), created by the daemon when a task opens and
moved to `agents/.retired/` when it closes. The folder keeps the task id and the final report.

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
  timeout_minutes: 240
mcp_servers:                            # catalogue of tools roles may name
  github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] }
```

## 5. Data model (SQLite)

| table | purpose |
|---|---|
| `agents` | instance state that is not a file: last session id, paused, budget spent this window, open question flag |
| `containers` | one row per standing channel or task thread: `id`, `kind` (standing/task), `members` (json), `default_to`, `task_id`, `slack_channel`, `slack_thread_ts`, `closed_at` |
| `messages` | append-only: `id`, `container_id`, `author`, `to`, `body`, `kind` (say/ask/report/system), `created_at`, `slack_ts` (set by mirror), `delivered_in_turn`, `answered_by` |
| `turns` | one per CLI run: `agent`, `started_at`, `ended_at`, `status`, `session_id`, `cost_usd`, `input_tokens`, `output_tokens`, `cache_read`, `cache_write`, `model`, `error` |
| `requests` | what an agent asked the daemon to do: `id`, `agent`, `kind`, `payload`, `status` (pending/approved/denied/expired/done), `decided_by`, `decided_at`, `result` |
| `tasks` | a job with a lead: `id`, `project`, `title`, `lead`, `status`, `worktree`, `slack_thread_ts`, `opened_at`, `closed_at` |
| `schedules` | declared by standing agents: `agent`, `cron`, `prompt`, `last_fired` |
| `events` | the log: everything the daemon did, one row each, mirrored to a JSONL file |

Rows are never updated in `messages` and `turns` except to fill Slack ids and final costs.

## 6. Messaging

- A **channel** is a container with members: a standing channel has an agent and the owner, or
  two agents; a **task thread** has the lead, the job agents of that task, and the owner. Members
  are fixed by `talks_to` and by the task. Standing channels are created on hire; task threads
  when a task opens.
- Every message has one **addressee** (`to`). Posting is a tool call (`post`), never a file
  write. The daemon appends the row, mirrors it, and wakes the addressee only.
- A message has a `kind`: `say` (information), `ask` (needs an answer), `report` (a
  deliverable), `system` (written by the daemon: hired, paused, budget, approval results).
- **The owner's replies are routed, not broadcast.** A message the owner writes in a container
  goes to the member with an open `ask` to the owner there; if none, to the container's
  default addressee (the agent of a standing channel, the lead of a task thread). A leading word
  overrides: `lead: …`, `dev: …`, `reviewer: …`, `ceo: …`.
- **One question at a time, to the owner, per agent.** An agent with an unanswered `ask` to the
  owner has its further messages to the owner held in the store (not mirrored) until the owner
  answers or the ask expires. Messages to other agents are never held.
- **Wake rules.** A post wakes the addressee unless it is paused, over budget, or already
  running (then it is queued). Queued wakes for the same agent collapse into one turn that reads
  everything new.
- **What a turn reads.** The daemon builds the turn prompt: the messages addressed to the agent
  since its last turn, per container, plus the outcome of any request it was waiting for. Every
  agent resumes its own transcript with `--resume`; a job agent's transcript starts at task open
  and is discarded at task close.

## 7. Engine: one turn is one process

Per turn the runner spawns:

```
claude -p --output-format stream-json --input-format stream-json --verbose
  --model <role/agent model> [--effort <level>] --max-turns <n> --max-budget-usd <remaining>
  --permission-mode <role mode> --allowedTools <…> --disallowedTools <…>
  --mcp-config <generated json: agentopolis + role tools> --strict-mcp-config
  --permission-prompt-tool mcp__agentopolis__permission
  --append-system-prompt-file <composed from SOUL.md JOB.md PROTOCOL.md agent MEMORY.md project knowledge>
  [--resume <session_id>] [--session-id <new uuid>]
  --name <agent name>
```

Rules:

- Never `--bare` (it ignores the subscription login) and never `--continue` (it guesses).
- `cwd` is the project's worktree for developer/reviewer turns, the agent's folder otherwise.
- The runner parses the stream: `system/init` (record model, tools, MCP status; fail the turn
  if the agentopolis server did not connect), `assistant`/`user` events (for the live status
  line), `system/api_retry` with `error: rate_limit` (see 13), the final `result` (cost, usage,
  session id, `permission_denials`).
- The process ends with the turn. SIGINT ends a turn early; SIGTERM is used only on daemon
  shutdown.
- A turn's `--max-budget-usd` is `min(role.per_turn_usd, monthly remaining)`.

## 8. The `agentopolis` MCP server

Stdio server started per turn with the agent's identity in its environment. Tools:

| tool | who | what |
|---|---|---|
| `read_channel(container, since)` | all | messages of one of my containers after a message id; `since` is required and the daemon fills it with the last id the agent has seen when the agent passes `"last"` |
| `post(container, to, body, kind)` | all | append + mirror + wake the addressee; `kind` in say/ask/report; `to` is a member name or `owner` |
| `answer(message_id, body)` | all | a `say` linked to an `ask`, clears the question hold |
| `request(kind, payload)` | per role | ask the daemon: `open_task`, `close_task`, `hire`, `retire`, `pause`, `set_budget`, `merge_production`, `run_schedule` |
| `remember(text)` | standing | append to my MEMORY.md (the daemon commits it) |
| `status()` | all | my budget left, open asks, pending requests |
| `permission` | runner | the permission prompt tool: receives the CLI's request, returns allow/deny after the owner's button or a rule |

Which `request` kinds a role may use is in `role.yaml` (`requests: [...]`); the daemon refuses
the rest and says why.

## 9. Slack surface

This section is the contract for the mirror module. Every API fact below was read on
docs.slack.dev on 2026-09-18; the implementer re-checks the ones marked *verify live* against
the real workspace before building on them.

### Identity

One app, one bot user, Socket Mode (no public URL; at most 10 concurrent connections, one is
enough). Every agent message is posted with `chat.postMessage` and the `username` (display
name) and `icon_url` (avatar) overrides, scope `chat:write.customize`. Personas are not users:
they cannot be @mentioned, have no presence and no typing indicator. The owner is a real user,
so `<@owner>` in a message notifies him: every `post(to: owner)` is mirrored with that mention.

**Messages that will be edited are posted under the app's own identity, not a persona.**
`chat.update` documents no `username`/`icon_url` arguments, so whether a persona skin survives
an edit is unknown (*verify live*). Until proven, the mirror never edits a persona message:
status lines, task cards, approval cards and answered asks are app-identity messages, and a
persona's `ask` with choices is two messages: the persona's text, then an app-identity card
with the buttons. If the live test shows the skin survives `chat.update`, the two collapse into
one; the code keeps that as a single switch.

### Containers

- `#ceo`: owner ⇄ ceo. Fixed, created at install.
- `#<project>`: owner ⇄ that project's lead. Created on hire of the lead, archived on retire.
- `#<project>-work`: the project's working channel. One **thread per task**: the parent
  message is the task card (title, status, budget used, agents engaged), edited in place as the
  task moves; replies are the traffic lead ⇄ developer, lead ⇄ reviewer, lead ⇄ designer/scout,
  plus any owner exchange. The thread is renamed after the task with `agents.sessions.rename`
  when the app has agent features, otherwise the card carries the title (*verify live*).
- Channels are private, created by the bot with `conversations.create` (`is_private: true`,
  scopes `groups:write`), the owner invited with `conversations.invite`; names lowercase,
  digits, `-`/`_`, at most 80 characters. A channel that has served its purpose is **archived**
  (`conversations.archive`), never deleted: no API deletes a channel on a normal workspace, and
  the rows stay in the store anyway. No limit on the number of channels.
- Job agents never get a channel of their own; their container is the task thread.
- `thread_ts` is passed as the string Slack returned, never parsed to a number: a float posts
  outside the thread, silently.
- **The store is the only history.** The mirror never reads Slack history back
  (`conversations.history`/`replies` are throttled for non-Marketplace apps); inbound owner
  messages arrive through events and are stored on arrival.

### Owner input

- Events: `message.channels`/`message.groups` (scopes `channels:history`, `groups:history`);
  `app_mention` is not needed because the owner never has to mention the bot.
- A message the owner writes in a container is routed as section 6 says (open ask first, then
  the default addressee, a leading `lead:`/`dev:`/… word overrides).
- A reaction is never an answer. `reaction_added` is subscribed only to let the owner mark a
  message "seen" (👀) so the Home tab can drop it from the open list.
- Under Socket Mode every interaction (slash command, `block_actions`, `view_submission`,
  shortcut) must be acknowledged within 3 seconds; the daemon acks first and works after.

### Questions and buttons

- An `ask` to the owner that offers choices is rendered as an app-identity card: `section`
  with the question, `actions` block with `button` elements (`action_id` = `answer`, `value` =
  message id + option index; text at most 75 characters; at most 25 buttons, in practice at
  most 5, more choices become a `static_select`). On click the daemon acks, records the answer
  as an owner message to the asker, and rewrites the card with `chat.update` to show the choice
  with the buttons removed. `response_url` is not used (the reference marks it deprecated and it
  expires); `chat.update` with `channel`+`ts` does not.
- Free-text asks are plain persona messages with the owner mention; the owner answers by
  writing.
- Approval cards: app identity, a `section` with the request in one line, a `context` line
  with who asked and the budget left, buttons **Approva** (primary) and **Nega** (danger, with a
  `confirm` dialog for destructive kinds), and **Dettagli** which opens a modal with the full
  payload. On decision the card is rewritten with the outcome and the buttons removed; on
  expiry the same, with "nessuno ha risposto".
- Forms (`/hire`, `/budget`) are modals: `views.open` needs a `trigger_id`, which exists only
  on an interaction payload and expires in 3 seconds, so a modal opens from a slash command or a
  button, never from a plain message. Inputs: `plain_text_input` (multiline for instructions),
  `number_input` for budgets, `static_select` for role and model (`radio_buttons` cap at 10
  options), `private_metadata` (at most 3000 characters) carries the daemon's state. Validation
  errors go back as `response_action: errors` keyed by `block_id`. Stack depth at most 3 views.

### Slash commands (manifest `features.slash_commands`)

`/hire`, `/fire <agent>`, `/pause <agent>`, `/resume <agent>`, `/model <agent> <model>`,
`/budget <agent> <usd>`, `/costs`, `/status`, `/rollback <agent>`. Each is a daemon action, not
an agent turn; each answers in the channel where it was typed, ephemeral (`chat.postEphemeral`)
when the answer is only for the owner.

### Status lines and receipts

A running turn shows one app-identity line under the container ("Leo sta lavorando · 2 min"),
edited in place with `chat.update` every 30 seconds, never re-posted; at turn end it becomes
the receipt (duration, cost). In a task thread the daemon additionally sets
`agents.sessions.setStatus` to `processing` with the persona's `username`/`icon_url` while a
turn runs and back to `active` after (the status does not clear itself); this is the only
"thinking" affordance Slack offers a Socket Mode app (*verify live* that it applies to threads
in regular channels for this app configuration; if not, the edited line alone stands).

### App Home

`views.publish` on `app_home_opened` and after every daemon action. Shows: agents with state
(idle/working/paused/over budget) and month-to-date cost, company total against
`budgets.company_monthly_usd`, open asks to the owner and pending approvals, each with a link to
its message. At most 100 blocks; beyond that the list is cut with a "…and N more" line.

### Files

Long deliverables stay in the worktree; when one must reach Slack (a mockup image, a report on
request) the mirror uses `files.getUploadURLExternal` + `files.completeUploadExternal`
(`files.upload` is sunset). Canvases are not used in v1 (Block Kit unsupported in them,
standalone canvases need a paid plan).

### Limits, in one module

`limits.ts` holds and the mirror enforces: 1 message per second per channel (a per-channel
queue), text split at 3000 characters per `section`, at most 50 blocks per message and 100 per
Home tab, button text 75 characters, `value` 2000 characters, modal title 24 characters,
`private_metadata` 3000. The free plan keeps 90 days of history and allows 10 apps; neither
matters because the store is the history and there is one app.

### Manifest

```
display_information: { name: Agentopolis }
features:
  bot_user: { display_name: Agentopolis, always_online: true }
  slash_commands: [/hire, /fire, /pause, /resume, /model, /budget, /costs, /status, /rollback]
oauth_config.scopes.bot:
  chat:write, chat:write.customize, groups:write, groups:history, groups:read,
  channels:manage, channels:history, channels:read, im:write,
  reactions:read, users:read, files:write
settings:
  socket_mode_enabled: true
  interactivity: { is_enabled: true }
  event_subscriptions.bot_events: [message.channels, message.groups, reaction_added,
                                   app_home_opened, member_joined_channel, channel_archive]
```

Agent features (`features.agent_view`, `agents.sessions.*`) are added only if the live check
above confirms they work in channel threads for this app; they are never required for v1.

## 10. Approvals and governance

- **Gated kinds** (always a button): merge or push to a production branch, `hire`, budget
  increase, any tool call the CLI would prompt for and no rule allows.
- **Rules first.** `role.yaml` allow/deny rules decide most tool calls without the owner. The
  permission prompt tool asks the owner only for what no rule covers, and shows the exact call.
- **Timeout.** A pending approval expires after `approvals.timeout_minutes`; the turn receives a
  deny with "nobody answered" and continues; the card is edited to say so.
- **Budgets.** Per agent, monthly, from `turns.cost_usd`. Warn at 80% in the agent's owner-facing
  channel; at 100% the agent is paused and told so; a button raises the budget (a gated kind).
- **Pause.** A paused agent gets no turns; wakes queue; unpause replays them as one turn. A lead
  cannot open a task for a paused developer.
- **Production branches.** `project.yaml` names them; the daemon's git operations refuse them
  without an approved request. Prose repeats the rule; the refusal is the enforcement.

## 11. Development tasks

1. The owner (or the ceo) asks the lead for something in `#<project>`.
2. The lead `request(open_task, {title, kind: develop|review|design|research, budget})`. The
   daemon creates the task row, the thread in `#<project>-work`, a git worktree from the work
   branch, and hires the job agent (`agents/dev-<n>/`).
3. The lead posts the brief to the job agent. The agent works in the worktree; reports with
   `post(kind: report)`.
4. The lead may hire a reviewer for the same task; review happens in the same thread.
5. Merge to the work branch is the lead's; merge to production is `request(merge_production)`,
   a gated kind.
6. `request(close_task)` retires the job agents, removes the worktree, edits the task card.

The protocol content (lean briefs, ledger, `PARKED`, reports naming the copy they read, review by
provenance, staging explicit paths, one deliverable per task) lives in the roles' `PROTOCOL.md`
files and is delivered with the repo under `roles/`.

## 12. Roles in v1

| role | kind | model | tools | notes |
|---|---|---|---|---|
| ceo | standing | sonnet | agentopolis | the owner's only interlocutor; hires, budgets, digests; may `open_task` on any project through its lead |
| lead | standing per project | opus, xhigh | agentopolis, github, repo cwd | product owner + engineering lead; ledger; briefs; reviews; merges to work branch |
| developer | job | chosen by lead | agentopolis, repo cwd | one deliverable per task, worktree, tests green before report |
| reviewer | job | opus | agentopolis, repo cwd (read) | findings by provenance; never edits |
| scout | job | sonnet | agentopolis, web fetch/search | sourced research reports |
| designer | job | opus | agentopolis, write to `design/` in worktree | mockups (HTML), flows, interface spec; no app code |

Each role ships `role.yaml`, `SOUL.md`, `JOB.md`, `PROTOCOL.md` in `roles/`. The ceo's prose
includes the check-in ritual (a daily digest to the owner at a declared schedule) and the hiring
conversation (propose a filled hire form, never hire without the owner's button).

## 13. When things go wrong

| situation | behaviour |
|---|---|
| CLI process crashes or exits non-zero | turn = failed with stderr tail; one automatic retry; then a `system` message in the agent's owner-facing channel; no further retry until the owner or a new post |
| `api_retry` with `rate_limit` or the result says the subscription limit is hit | daemon enters **limit pause**: no new turns; a single owner notice; probes with a cheap `claude -p` every 15 minutes; resumes automatically, one notice |
| Slack unreachable | rows are written; the mirror retries with backoff from the last mirrored id; nothing is dropped |
| malformed role/agent/project file | rejected with a `#ceo` message naming the file and the error; last valid version stays loaded |
| result without cost | recorded as `cost_usd = null`; shown as "unknown" in `/costs`; never estimated |
| approval never answered | expires; deny with reason; card edited |
| daemon restart | standing agents resume their sessions from `agents.session_id`; queued wakes replay; open approvals re-rendered |
| `--resume` fails ("No conversation found") | start fresh with a `system` note in the agent's channel; never loop |

## 14. Testing

- **Unit** (vitest): loader validation, router wake rules, question hold, budget arithmetic,
  approval state machine, stream parser, Slack block builders, limits module.
- **Integration with a fake CLI**: a `fake-claude` script that replays scripted stream-json
  from fixtures (init, tool calls to the MCP server, permission prompts, result with costs). Every
  daemon flow in section 11 runs against it in CI without spending.
- **Integration with a fake Slack**: an in-process stub of the Bolt client recording calls;
  asserts personas, edits in place, archive on close, block shapes.
- **One live smoke on the owner's Mac** with the real CLI and a test workspace: ceo greets, owner
  answers, lead hires a developer on a trivial task, approval card works. Run by hand before the
  first VPS deploy.
- CI on GitHub Actions: lint (Biome), typecheck, unit, fake-CLI integration.

## 15. Done when

All of these hold on the VPS, with the real CLI and the owner's Slack workspace:

1. `systemctl status agentopolis` is active; a restart loses no message and re-renders open
   approvals.
2. The owner writes in `#ceo` and gets an answer from the ceo persona within one turn.
3. The owner asks the lead in `#agentopolis` for a small change to this repository; a task
   thread appears in `#agentopolis-work`; a developer delivers on a branch; a reviewer reports;
   the lead merges to `dev`; the `merge_production` card appears in `#agentopolis`; the owner
   approves; `master` receives the merge.
4. `/costs` shows a per-agent, per-month table whose numbers match the sum of `turns.cost_usd`.
5. `/pause` on the developer during a task stops its next turn; `/resume` replays it.
6. Editing `roles/lead/SOUL.md` changes the lead's next turn without a daemon restart.

## 16. Stack

TypeScript on Node LTS, pnpm, Bolt for JavaScript (Socket Mode), better-sqlite3 + Drizzle,
zod + yaml for schemas, croner for schedules, pino for logs, vitest, Biome, systemd unit under
`deploy/`. No framework beyond these. One package; folders `src/<module>/` mirror section 3.

## 17. Assumptions to confirm with the owner

- The first project is this repository.
- Standing agents have display names chosen at hire; job agents are `dev-<n>`, `reviewer-<n>`,
  `scout-<n>`, `designer-<n>`.
- Slack free plan for now (90-day history is acceptable: the store keeps everything).

## 18. Live checks before building on them

Three Slack behaviours are undocumented or plan-dependent and are settled by a throwaway
script against the real workspace in the first implementation task, with the answer recorded
in this file:

1. Does `chat.update` keep the `username`/`icon_url` of a persona message? (decides whether
   asks with buttons are one message or two)
2. Does `agents.sessions.setStatus` accept `thread_ts` in a private channel for an app without
   `agent_view`? (decides the "working" indicator)
3. Does `agents.sessions.rename` rename a task thread? (decides how task titles show)

# Slice 3: Slack mirror — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. **Merge to `master` only when the supervisor's message contains the word "merge" as an instruction.**

**Goal:** everything between the store and Slack: rows become Slack messages signed by
personas, Slack events and button clicks become rows, cards and modals render and update, the
Home tab shows the company, and none of it needs a public URL.

**Architecture:** a `Chat` port with two implementations, `BoltChat` (Socket Mode) and
`FakeChat` (records every call). **Identity model (owner, 2026-09-19): one Slack app per standing
agent.** The company app is the ceo (its DM is the ceo chat; it owns commands, Home and every
app-identity card); each lead is its own app with its own DM. Job agents are personas posted
through the lead's app. `config.yaml` names the apps under `slack.apps`; `agent.yaml` names its
app with `slack_app`. The daemon runs one Bolt `App` per configured app; `Chat` gains an
`as: <appName>` argument on every outbound call, defaulting to `company`. Pure modules build blocks and enforce limits. An **outbox
pump** drains `outbox` rows through a per-channel 1 msg/s bucket with bounded retries; an
**inbox** writes every event to `inbox` before processing (ack after durable write, two dedup
keys). Personas are never edited: anything that changes is app-identity. Slash commands and
modals are daemon actions. The router (slice 4) will consume `inbox` rows; this slice stops at
the row.

**Tech Stack:** as before, plus `@slack/bolt` (Socket Mode, no HTTP receiver).

**Spec:** `docs/superpowers/specs/2026-09-18-agentopolis-v1-design.md`, section 9 in full,
plus 6 (routing of owner replies), 10 (cards), 13 (Slack unreachable). Roadmap:
`docs/superpowers/plans/2026-09-18-agentopolis-v1-roadmap.md`.

## Global Constraints

- Branch `slice/03-slack-mirror` from `master` (after PR #2's merge). PR at the end.
- **A persona message is immutable.** `chat.update` is called only on app-identity messages.
- **Ack after durable write** for every interaction; for events, the durable write is the
  first statement of the listener (verify in the installed Bolt whether events are auto-acked
  before listeners run; record the answer in the report).
- The store is the only history: `conversations.history`/`replies` are never called.
- `thread_ts` is always the string Slack returned.
- Limits live in one module and every builder goes through it.
- The Slack client has a bounded retry policy and a per-request timeout (never the SDK default).
- Tokens come from the environment only (`SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`); the loader
  already rejects token-shaped values in files.
- `pnpm test` never touches Slack. `pnpm slack:smoke` (guarded by `AGENTOPOLIS_LIVE=1`) is the
  only path to the real workspace and is run by hand on the owner's Mac.

## File structure

```
src/ports/chat.ts            Chat port: post/update/delete, channels, modals, home, + types
src/slack/limits.ts          LIMITS constants, splitText(), assertBlocks()
src/slack/blocks.ts          builders: askCard, approvalCard, taskCard, statusLine, receipt, homeView, hireModal, editModal, replyModal
src/slack/persona.ts         postAsPersona(): username/icon_url → icon_emoji → username → plain
src/slack/bolt-chat.ts       BoltChat implements Chat (Socket Mode), bounded retries/timeouts
src/slack/fake-chat.ts       FakeChat implements Chat (records calls, returns fake ts)
src/slack/outbox-pump.ts     drains outbox rows: buckets, retries, mirror kinds
src/slack/inbox.ts           Bolt listeners → inbox rows (dedup, ack-after-write), classify()
src/slack/commands.ts        slash commands + block_actions + view_submission → daemon actions (port)
src/slack/bootstrap.ts       ensureChannels(): #ceo, #<project>, #<project>-work; invite owner
tools/slack-smoke/run.ts     by hand: post persona, ask card, modal, home
tests/slack/*.test.ts
```

---

### Task 1: the `Chat` port and `FakeChat`

**Files:**
- Create: `src/ports/chat.ts`, `src/slack/fake-chat.ts`
- Test: `tests/slack/fake-chat.test.ts`

**Interfaces (produced):**

```ts
export type Blocks = unknown[];
export type Persona = { username: string; iconUrl?: string; iconEmoji?: string };
export type PostArgs = { channel: string; text: string; blocks?: Blocks; threadTs?: string; persona?: Persona; mention?: string };
export type Posted = { ts: string; channel: string };

export interface Chat {
  post(args: PostArgs): Promise<Posted>;
  update(args: { channel: string; ts: string; text: string; blocks?: Blocks }): Promise<void>;
  delete(args: { channel: string; ts: string }): Promise<void>;
  postEphemeral(args: { channel: string; user: string; text: string; blocks?: Blocks }): Promise<void>;
  createPrivateChannel(name: string): Promise<{ id: string }>;
  invite(channel: string, users: string[]): Promise<void>;
  archive(channel: string): Promise<void>;
  setTopic(channel: string, topic: string): Promise<void>;
  openModal(triggerId: string, view: unknown): Promise<void>;
  updateModal(viewId: string, view: unknown): Promise<void>;
  publishHome(user: string, view: unknown): Promise<void>;
  setSessionStatus?(args: { channel: string; threadTs?: string; status: "active" | "processing"; persona?: Persona }): Promise<void>;
  upload(args: { channel: string; threadTs?: string; filename: string; content: Buffer; title: string }): Promise<void>;
}

export class ChatError extends Error {
  constructor(message: string, readonly code: string, readonly retryAfterMs?: number) { super(message); }
}
```

`FakeChat`: every method records `{ method, args }` in `calls`, returns increasing fake `ts`
(`"1700000000.000001"`, …), and can be told to fail: `failNext(method, error: ChatError)`.
It asserts on `update`/`delete` that the `ts` was posted by it **without** a persona, and
throws `persona message is immutable` otherwise (this is how the tests enforce the rule).

- [ ] Steps: failing tests (records calls; increasing ts; `failNext` throws once; update of a
  persona ts throws) → implement → PASS → commit `feat(slack): Chat port and FakeChat that enforces persona immutability`.

---

### Task 2: limits and text splitting (pure)

**Files:**
- Create: `src/slack/limits.ts`
- Test: `tests/slack/limits.test.ts` (unit + one fast-check property)

**Interfaces:**
- `LIMITS = { sectionText: 3000, blocksPerMessage: 50, blocksPerView: 100, buttonText: 75, buttonValue: 2000, modalTitle: 24, privateMetadata: 3000, textPerMessage: 40000, msgPerSecondPerChannel: 1 }`
- `splitText(text: string, max = LIMITS.sectionText): string[]` — splits on paragraph, then
  line, then hard cut; never inside a fenced code block when avoidable (a fence that would be
  cut is closed and reopened); concatenation of parts equals the input up to the inserted
  fence markers.
- `assertBlocks(blocks, max)` throws with a clear message when over the cap; `truncateButton(text)`.

- [ ] Steps: failing tests (short text unchanged; 7,000-char text → 3 parts each ≤ 3,000; a
  code block spanning the cut is closed/reopened; property: for random strings, all parts ≤
  max and `parts.join("")` with fence markers stripped equals the input) → implement → PASS →
  commit `feat(slack): limits module with fence-aware text splitting`.

---

### Task 3: block builders (pure)

**Files:**
- Create: `src/slack/blocks.ts`
- Test: `tests/slack/blocks.test.ts` (snapshot-free: assert shapes and limits)

**Interfaces (all return `{ text: string; blocks: Blocks }` unless noted):**
- `askCard({ renderId, persona, question, context, options })` — `section` (question ≤ 2
  lines), `context` ("<persona> chiede · <project>"), `actions` with ≤ 3 `button`s
  (`action_id: "answer"`, `value: "<renderId>:<index>"`); > 3 options → `static_select` +
  **Conferma**. No snooze button and no re-mention: an open ask stays open (spec section 9). Text of the message
  = the question (notification preview).
- `answeredCard(card, { chosen, by, at })` — same section, actions replaced by a `context`
  line "✅ Scelto: … · da <by> alle hh:mm".
- `approvalCard({ renderId, kind, line, context, destructive, scoped })` — buttons **Approva**
  (primary), **Approva per questo compito** (only when `scoped`), **Nega** (danger, with
  `confirm` when `destructive`), **Dettagli** (`action_id: "details"`); `value` carries
  `"<renderId>:<epoch>"`.
- `decidedCard(card, { outcome: "approvato" | "negato" | "scaduta", by, at, reopen: boolean })`.
- `taskCard({ title, state, costMicro, agents })` and `taskCardUpdate`.
- `statusLine({ display, seconds })` → text only; `receipt({ display, seconds, costMicro | null })`.
- `replyPrompt({ renderId, persona, text, mention })` — persona text + mention; the
  **Rispondi** button lives on a separate app-identity line built by `replyButton(renderId)`.
- `homeView({ month, spentMicro, waiting, projects, agents, parked, updatedAt })` — the layout
  of spec section 9: cost "stimato" with no budget bar, agents as `fields` (≤ 10 per section)
  each with an overflow (Pausa / Riattiva / Modello / Licenzia), parked discoveries with
  **Apri come compito**, cut at 100 blocks with an "…e altri N" line.
- `hireModal(defaults)` (no budget field), `editModal({ agent, file, initial })` where `file` is
  `AGENT.md` or `MEMORY.md`, `replyModal({ renderId, question })`
  — ≤ 6 inputs, titles ≤ 24 chars, `private_metadata` JSON ≤ 3,000.
- Every builder calls `assertBlocks` and `truncateButton`; every string shown to the owner is
  Italian and comes from one `strings.ts` table (so the wording lives in one place).

- [ ] Steps: failing tests (button counts and ids; no snooze button; `static_select` beyond 3 options; value
  format; danger+confirm on destructive; home cut at 100 blocks with 40 agents; modal input
  count and metadata size) → implement → PASS → commit `feat(slack): Block Kit builders for cards, home and modals`.

---

### Task 4: personas with scope fallback

**Files:**
- Create: `src/slack/persona.ts`
- Test: `tests/slack/persona.test.ts`

**Interfaces:**
- `postAsPersona(chat: Chat, args: PostArgs & { persona: Persona }): Promise<Posted>` — tries
  `username + icon_url`; on `ChatError` code `missing_scope` or `invalid_arguments` retries
  with `icon_emoji`, then bare `username`, then no persona; remembers the level that worked
  (module-level cache keyed by nothing: one app) so later posts start there.

- [ ] Steps: failing tests with `FakeChat.failNext` (first call fails `missing_scope` → second
  call has no `iconUrl`; a fatal error like `channel_not_found` is not swallowed; level is
  remembered) → implement → PASS → commit `feat(slack): persona posting with scope fallback`.

---

### Task 5: the outbox pump

**Files:**
- Create: `src/slack/outbox-pump.ts`; Modify: `src/store/outbox.ts` (add `markDone`, `markRetry`)
- Test: `tests/slack/outbox-pump.test.ts` (FakeChat + FakeClock)

**Interfaces:**
- `startOutboxPump(opts: { db; chat; clock; snapshotOf: () => Snapshot; tickMs?: number; log })`
  → `{ stop(): Promise<void>; tick(): Promise<number> }`. `tick()` is public for tests.
- Kinds handled: `mirror.message` (load the message and its container; choose persona from
  the agent's `display`/`avatar` or app identity for `system`; add `<@owner>` only when
  `kind === "ask"` and `to === "owner"` (no hourly counter and no quiet hours: notification
  timing is Slack's); thread into the task
  thread when the container has `slack_thread_ts`), `card.post` (app identity, blocks from
  payload), `card.update`, `home.publish`, `channel.create`, `channel.archive`, `status.set`.
- Per-channel bucket: at most one send per second per channel (FakeClock-driven); rows for
  other channels are not blocked.
- Retry: on `ChatError` with `retryAfterMs` use it; otherwise backoff 1 s, 5 s, 30 s, 2 min,
  10 min, then keep 10 min; `attempts` incremented; a row is never dropped. Permanent errors
  (`channel_not_found`, `is_archived`) mark the row done with `error` recorded and write an
  `events` row `mirror.failed`.
- On success: `markDone(id, slackTs)`; for `mirror.message` also `events` row `mirror.sent`.
- Empty channel (parked case from slice 1): the row stays pending with a `mirror.held`
  event once, and is retried when the container gains a channel.

- [ ] Steps: failing tests (message mirrored with persona and thread; ask to owner carries
  the mention, say does not; bucket enforces 1/s; 429 with Retry-After schedules exactly then;
  permanent error records and stops; empty channel holds; stop() waits for in-flight) →
  implement → PASS → commit `feat(slack): outbox pump with per-channel bucket, bounded retries and personas`.

---

### Task 6: the inbox (events, actions, views, commands → rows)

**Files:**
- Create: `src/slack/inbox.ts`; Modify: `src/store/inbox.ts` (add `markProcessed`)
- Test: `tests/slack/inbox.test.ts` (calls the listener functions directly with sample payloads; no Bolt)

**Interfaces:**
- `classifyEvent(payload): Inbound` where `Inbound` is one of `owner_message { channel,
  threadTs?, text, ts }`, `owner_reaction { channel, ts, reaction }`, `home_opened { user }`,
  `channel_archived { channel }`, `member_joined`, `bot_message_dropped`, `ignored { reason }`.
- `handleEvent(db, clock, ownerUserId, payload): { inserted: boolean; inbound: Inbound }` —
  computes `event_id` and `logical_key` (`<channel>:<ts>`), calls `recordInbound` **first**,
  then classifies. Bot-authored (`bot_id` present or `subtype === "bot_message"`) → dropped
  before classification but still deduped. Messages from users other than the owner → `ignored`.
  `message_changed`/`message_deleted` subtypes → `ignored` (the store is the history).
- `handleAction(db, clock, payload)`, `handleView(db, clock, payload)`, `handleCommand(db,
  clock, payload)` — same shape: durable row, then a typed `Inbound` (`button { renderId,
  actionId, value, user, channel, ts, triggerId }`, `view_submitted { callbackId, metadata,
  values }`, `command { name, text, channel, user, triggerId }`).

- [ ] Steps: failing tests (twin events with different ids and same channel:ts → second not
  inserted; bot message dropped and still deduped; non-owner ignored; changed/deleted ignored;
  action payload parsed with renderId and epoch; command parsed) → implement → PASS → commit
  `feat(slack): inbox classification with durable-first writes and two dedup keys`.

---

### Task 7: `BoltChat` and the wiring

**Files:**
- Create: `src/slack/bolt-chat.ts`, `src/slack/app.ts` (builds the Bolt `App`, registers
  listeners that call Task 6's handlers, exposes `start()`/`stop()`)
- Test: `tests/slack/bolt-chat.test.ts` — construct `BoltChat` over a stubbed `WebClient`
  (inject the client) and assert: `chat.postMessage` receives `username`/`icon_url` when a
  persona is given and the `text` fallback; `thread_ts` passed as string; `chat.update`
  never receives identity fields; errors are mapped to `ChatError` with `code` and
  `retryAfterMs` from `Retry-After`; the client is constructed with `retryConfig: { retries: 2,
  factor: 2, minTimeout: 500 }` and `timeout: 10_000`.

**Wiring in `app.ts`:** `new App({ token, appToken, socketMode: true })`; listeners:
`app.event("message")`, `app.event("reaction_added")`, `app.event("app_home_opened")`,
`app.event("member_joined_channel")`, `app.event("channel_archive")`, `app.action(/.*/)`,
`app.view(/.*/)`, `app.command(/\/.*/)`. Each listener: durable write (Task 6) as its first
statement, then `await ack()` where Bolt provides one, then hand the `Inbound` to an injected
`onInbound(inbound)` callback (slice 4 plugs the router here; this slice's daemon-less test
uses a recorder). Check the installed Bolt's README for whether `ack` is passed to event
listeners in Socket Mode and whether events are auto-acked; write the finding in the report
and in a comment at the top of `app.ts`.

- [ ] Steps: failing tests → implement → PASS → commit `feat(slack): BoltChat over Socket Mode with bounded retries; listeners write before they ack`.

---

### Task 8: bootstrap and commands

**Files:**
- Create: `src/slack/bootstrap.ts`, `src/slack/commands.ts`
- Test: `tests/slack/bootstrap.test.ts`, `tests/slack/commands.test.ts` (FakeChat)

**Interfaces:**
- `ensureChannels(chat, db, snapshot, ownerUserId)`: for each project `#<slug>-hq` and
  `#<slug><suffix>` (never the bare slug: Slack refuses a channel named like the workspace): find the container row with that `slack_channel` or create the private
  channel, invite the owner, set the topic, insert the `containers` row (`kind: standing`,
  members `[agent, "owner"]`, `default_to: agent`). Idempotent.
- `DaemonActions` port (implemented by slice 4; faked here): `hire(form)`, `edit(agent, file,
  text)`, `undoEdit(agent)`, `pause(agent)`, `resume(agent)`, `setModel(agent, model)`,
  `retire(agent)`, `diag(agent)`, `openParked(taskId)`, `answer(renderId, index, user)`,
  `approve(renderId, epoch, scope)`, `deny(renderId, epoch)`, `reply(renderId, text)`.
- `dispatchCommand(inbound, actions, chat)`: exactly four commands. `/agentopolis` → publish
  Home; `/hire` → open `hireModal`; `/edit <agent>` → open `editModal` with the file's current
  text (`AGENT.md` or `MEMORY.md`); `/diag <agent>` → ephemeral diagnostics; unknown → ephemeral
  usage text. Pause, resume, model, retire and "open parked as task" live in the Home tab's
  overflow menus (`block_actions` with `action_id` `agent_menu` / `parked_open`).
- `dispatchButton(inbound, actions, chat)`: `answer`, `approve`, `approve_task`, `deny`,
  `details` (open a modal with the render's payload), `reply` (open `replyModal`),
  `agent_menu` (overflow selections), `parked_open`, `undo_edit`.
- `dispatchView(inbound, actions, chat)`: `hire`, `edit`, `reply` submissions; validation
  errors returned as `{ response_action: "errors", errors: { [block_id]: message } }`.

- [ ] Steps: failing tests (channels created once, second call creates nothing; each command
  calls the right action with parsed args; a button with a stale epoch is refused with an
  ephemeral "questa card è stata superata"; a hire form with an unknown role returns an errors
  response) → implement → PASS → commit `feat(slack): channel bootstrap, slash commands, buttons and modals dispatch`.

---

### Task 9: `slack:smoke`, by hand

**Files:**
- Create: `tools/slack-smoke/run.ts`, script `slack:smoke` in `package.json`

**Behaviour (guarded by `AGENTOPOLIS_LIVE=1`, reads the two tokens and `AGENTOPOLIS_OWNER`
from the environment, uses a temporary home from `examples/home`):** connect in Socket Mode;
`ensureChannels`; the ceo posts in its DM with the owner ("Ciao, sono Jarvis") through the
company app; the lead posts "Ciao, sono Leo" in its own DM through its app; a persona message
("Nina · developer") is posted in `#agentopolis-work` through the lead's app; post an `askCard`
with two options in the ceo DM; wait up to 120 s for the owner to click, then rewrite it as `answeredCard`; open
nothing (a modal needs a trigger, which comes from the owner: print the instruction "digita
`/hire` nel workspace" and wait up to 120 s for the `view_submission`, then print the parsed
form); publish the Home; print every step's result and the `events` rows written. Exit 0 only
if the persona post succeeded and the ask was answered.

- [ ] Steps: write → **the owner runs it on the Mac and looks at Slack** (his pass: the
  persona has name and avatar, the card's buttons work, the modal opens from `/hire`, Home
  renders) → paste the output into the PR → commit `test(slack): live smoke against the owner's workspace, by hand`.

---

### Task 10: live checks 1–2 (spec section 18)

**Files:**
- Modify: `tools/slack-smoke/run.ts` (two extra steps behind `AGENTOPOLIS_CHECKS=1,2`)
- Modify: spec section 18 to record the answers.

1. Post a persona message, then `chat.update` it with new text: does the name/avatar survive?
   Record the answer (expected: no). Either way the code keeps persona messages immutable.
2. Call `agents.sessions.setStatus` with `thread_ts` in a private channel thread, status
   `processing`, with the persona's `username`/`icon_url`: does it succeed, return
   `feature_disabled`, or another error? Then `agents.sessions.rename`. Record both.

- [ ] Steps: write → owner runs → answers recorded in section 18 with `[live YYYY-MM-DD]` →
  commit `docs(spec): record live-check answers 1–2`.

---

### Task 11: report and PR

- [ ] Full gate, `pnpm ls --depth 0`, PR with the roadmap's report format including the smoke
  and live-check outputs verbatim, the Bolt ack finding, and any Slack API shape that differed
  from the spec. Tell the owner the PR number; stop.

## Self-review against the spec (plan author)

- Section 9 Identity, immutability, fallbacks: Tasks 1, 4, 7 (FakeChat enforces immutability).
- Containers, private channels, archive, bootstrap: Task 8.
- Inbox contract (ack after write, two keys, bot drop, retries as first deliveries): Tasks 6–7.
- Questions/approvals/buttons/modals/commands/status/receipts/home/files: Tasks 3, 5, 8
  (`upload` is on the port; its first caller is slice 6).
- Client and limits: Tasks 2, 7. Manifest: the owner's install (roadmap).
- Section 13 "Slack unreachable": Task 5 (rows wait, nothing dropped).
- Not here by design: routing of owner replies to agents (slice 4), the daemon process (slice 4),
  `agents.sessions.*` as a feature (only the live check).

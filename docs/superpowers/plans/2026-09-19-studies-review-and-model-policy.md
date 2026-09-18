# Studies review and model policy — owner decisions of 2026-09-19

Status: decisions taken by the owner on 2026-09-19 after reading seven external studies against
the spec at commit `fcbc524` (second pass). For the supervisor: fold section A into the spec
(section map in C) and the slice plans named; section B is the record of what each study got
right, what it got wrong, and what stays rejected, so nobody re-litigates them.

Sources: the seven files in the owner's `~/Downloads/studi approfonditi` (Red-Teaming
Architetturale; Analisi Architettura Claude Code CLI; Architettura Memoria Claude CLI;
Architettura Costi Multi-Agente Claude; Ottimizzazione Costi Multi-Agente LLM; Architettura
Gateway LLM Self-Hosted; Architettura LiteLLM Free Tier). All were written against the **first**
spec; the second pass had already removed the question hold, monthly budgets, session rotation,
`STATE.md`, and scout/designer as agents. Verified on 2026-09-19: `pnpm test` 32 files / 167
tests green; installed CLI 2.1.277 (live checks were on 2.1.276).

## A. Decisions

### A1. Models and effort per agent

No `xhigh` anywhere. The lead picks per task from a menu; the daemon refuses anything outside it.

| agent | default | lead's menu at `open_task` | Opus | Fable | effort change |
|---|---|---|---|---|---|
| ceo | Sonnet 5 / medium | fixed (owner, Home tab) | no | no | owner |
| lead | Opus 5 / high | fixed (owner, Home tab) | default | owner approval | owner |
| developer | Sonnet 5 / high | Sonnet, Opus · medium/high | lead | owner approval | lead |
| reviewer | Opus 5 / medium | Sonnet, Opus · medium/high | lead | owner approval | lead |
| designer | Sonnet 5 / high | Sonnet, Opus · medium/high | lead | owner approval | lead |
| research (subagent) | Sonnet 5 / medium | fixed | owner approval | owner approval | owner approval |

Rationale, in one line each: operators run a loop whose oracle is the test runner, so the smaller
model at high effort beats the bigger one at medium on cost and does not lose much on quality
[the FinOps study's argument; its figures are list prices, not measured]; the reviewer is one
turn on a small context and gains from being a **different** model than the writer; the ceo
has no problem to solve; research fails by reporting stale pages as truth, which is judgement,
so not Haiku.

Presets for the lead, shown on the task card: `piccolo` Sonnet/medium, `normale` Sonnet/high,
`difficile` Opus/high.

### A2. Escalation is the lead's call, and it is a change of model

The daemon cannot see a failed test; the lead can. Rule in the lead's `AGENT.md`: "after two
rejections or two rounds without progress on the same brief, reopen the task one rung up:
Sonnet/high → Opus/high → Fable/high (the last needs the owner's card, A3); if the top rung fails,
ask the owner." A rung change is a new session for the job agent (mid-session model or effort
switches invalidate the cache [verified]). The daemon **counts** the failures and blocks a third
attempt on the same rung (D3), so the ladder is enforced, not only advised (principle 4).

### A3. Gated models and efforts: owner approval through a card

`config.yaml`:

```yaml
gated:
  models: [fable]                 # any role: needs the owner's Approva
  research:
    models: [opus, fable]         # the research subagent: Opus too
    effort: true                  # any effort change on research
```

Mechanics: an `open_task` (or a model change request) naming a gated value is not spawned; the
daemon stores it in `requests`, renders an approval card in `#<project>` ("Leo chiede Fable per
*<task>* · motivo: <the lead's reason> · **Approva** / **Nega**"), and the task waits (or runs on
the rung below, the lead says which in the payload). Approva: the daemon spawns with the gated
value (new session). Nega or expiry (24 h): the lead gets a `system` note and decides. For the
research subagent the daemon passes the approved model/effort in the `--agents` JSON for that
task's turns only. The owner can always set any value directly from the Home tab, no card.
Tier 3 of section 10 gains this entry next to `merge_production`.

### A4. Designer returns as a job agent

Task kind `design`: its own thread, worktree, `AGENT.md`, report under `design/`; same menu
and ladder as the developer. A mockup is a deliverable the owner reviews in a thread, not a
file that appears inside another agent's turn. `research` stays a subagent.

### A5. Task loop guard (new, deterministic)

With monthly budgets gone, nothing bounds an agent ⇄ agent conversation: every message wakes
the addressee, each turn has its guards, the exchange has none. Daemon rule per task:
`loop_guard: { messages: 12, review_rejections: 3 }` in `config.yaml`. When a task accumulates
that many agent-authored messages with no owner message and no task status change, or that
many rejected reviews, the task card becomes "bloccato" with **Sblocca** / **Chiudi**, the
task's agents get a `system` note and no further wake until the owner presses a button. Counters
reset on any owner message in the thread. Slice 4 (router: counting and the hold) and slice 6
(task card).

### A6. Slack pacing

- Status lines are edited at most **once every 30 s** (the text shows minutes; once per second
  with three tasks is 180 `chat.update`/min against Slack's 50/min tier). Spec section 9.
- The per-method budget table promised by section 9 (`chat.update` 50/min, `conversations.*`
  40/min, `chat.appendStream` 160/min) is not in `src/slack/limits.ts` yet: NOTICED for the
  slice 3 review.

### A7. Parked permission: the deny text ends the turn

The reason returned with the `deny` on a parked `can_use_tool` must say, in the model's terms:
"parked for the owner; end this turn now with your envelope; you will be woken with the
decision". Otherwise the model treats the deny as an obstacle and tries variants. Slice 4, with
a matching line in every `AGENT.md`.

### A8. Optional: back off before the limit

On `rate_limit_event` with status `allowed_warning` (or utilization ≥ 0.9), drop
`max_concurrent_turns` to 1 until the window resets; the full limit pause stays as specified.
Slice 4, one condition.

### A9. Live check 8 (before A1/A3 are relied on)

On the owner's Mac, one one-word turn each: (a) `--model` with Fable starts under the
subscription login and `system/init` reports it; (b) the `result` cost for that turn is priced
with Fable's list, so the Home tab shows it right; (c) a `--agents` JSON with `model: opus` on
`research` is honoured per spawn. Also confirm whether 2.1.277 has a settings key that caps
effort (`maxEffortLevel`, cited by the CLI study from the 2.1.267 notes): if so the daemon passes
it in `--settings` and "no xhigh" is enforced, not just written.

## B. The seven studies, re-evaluated against A

**1. Red-Teaming Architetturale.** Right about: no bound on lead ⇄ developer ping-pong (→ A5);
`chat.update` saturation with concurrent status lines (→ A6); the deny on a parked call being
read as an obstacle (→ A7). Moot after the second pass: the question-slot deadlock (no question
hold exists). Rejected: replacing parking with a blocking named-pipe hook (holds a CLI process
for hours against `max_minutes`; the spec chose parking on purpose, live check 4 shows the hold
works when short); auto-deny after 45 minutes (owner: 24 h, never for `merge_production`);
its cost circuit breaker (no budgets by owner decision, per-turn guards stay); lockfile
contention (worktrees per task). Its "status board" is the thread-per-task card already.

**2. Analisi Architettura Claude Code CLI.** Right about: honouring `resetsAt` (spec 13 does)
and backing off early (→ A8); process groups and two-stage stop (done in slice 2). Rejected:
PTY to defeat block buffering (live check 4 answered a control request mid-turn over plain
pipes); removing `--system-prompt-snapshot off` (live check 6: an unchanged file still hits the
cache, an edited one costs one uncached turn; the "trap" needs a dynamic file, and ours are
static); rotating to a second account on a seven-day limit. Verified: `--setting-sources ""` is
a separate empty element in `src/engine/argv.ts:53`, which Node preserves. Residual unknown
worth one measurement: whether the subscription weighs 1 h cache writes at 2× like the API list.

**3. Architettura Memoria Claude CLI.** Its headline (auto-compact at 100k fires before a 120k
rotation) was true for the first spec and is moot now: there is no daemon rotation, the CLI's
compaction is the bound. Still true: compaction is lossy. Mitigations already in place:
`MEMORY.md` via the envelope, "Ricomincia da capo" in the Home tab, the fresh-session seed of
section 13. Cheap addition, optional: on `system/compact_boundary` the daemon writes a `system`
line on the task card ("contesto compattato"), so the owner knows why an agent may repeat
itself. Its `STATE.md` contract and `PreCompact` hook are not needed; its "anti-loop ledger" is
one line of prose: "remember what you tried and why it failed".

**4. Architettura Costi Multi-Agente Claude (FinOps).** The direction is adopted (→ A1, A2):
Sonnet for operators, Opus for the lead, escalation after two failures, no `xhigh`. Differences
on purpose: the reviewer defaults to Opus/medium (a different model than the writer); escalation
is the lead's decision, not a daemon state machine (the daemon cannot see test results); Fable
is gated for every role rather than being the designer's rung; no de-escalation to Sonnet/low for
commit messages (a turn is a turn, not worth a session change). Its savings figures (−81%) and
benchmark deltas are unverified; the Home tab will measure the real thing after ten tasks.

**5. Ottimizzazione Costi Multi-Agente LLM.** Already in the spec: byte-stable prefix, dynamic
content at the tail, structured envelopes instead of prose between agents. Adopted in spirit:
"the CEO never picks models" (models come from `role.yaml`, the lead's menu and the owner's
gates). Rejected: LangGraph, LiteLLM, RouteLLM, the Vercel AI SDK (section 16: no framework, no
SDK). The study is stale (Claude 3.7, GPT-4o-mini, API-key billing).

**6. Architettura Gateway LLM Self-Hosted** and **7. Architettura LiteLLM Free Tier.** Rejected
whole: a free-tier cascade (Gemini, Groq, OpenRouter) plus a local 3B model contradicts "solo il
CLI" (owner, 2026-09-18), the deterministic addressee router (there is no routing decision for a
model to make), and data handling (free tiers use prompts to improve products; the owner's
company traffic would flow there). Exposing the subscription as an OpenAI-style endpoint through
a CLI shim is against Anthropic's consumer terms. Study 6 also recommends `--bare`, which never
reads the subscription login. Two nuggets already covered: cgroup memory limits (`MemoryMax=`
in the unit) and schema validation (`--json-schema` + zod).

## D. Rejections re-examined on their merits (owner, 2026-09-19: "if a binned idea is valid, the structure is up for debate")

Three rejected ideas carry a valid kernel that the chosen structure does not answer. Each is a
question for the owner, with a recommendation.

**D1. Hold first, park second (from the red-team's blocking hook).** Parking a permission ends
the turn: the transcript keeps a failed tool call, the shell state is gone, the next turn
re-plans. The blocking hook keeps everything but holds a CLI process and one of the three
concurrency slots for as long as the owner is away, which can be a night. The valid kernel is
the middle: the daemon **holds** the `can_use_tool` request open for `permission_hold_minutes`
(default 5; live check 4 proved 200 s works and the mechanism has no known ceiling), rendering
the card at once; if the button lands in time the turn continues exactly where it was, with no
context pollution; if not, the daemon answers `deny` and parks as today. The watchdog clock keeps
running (a held turn still occupies a slot). **Owner, 2026-09-19: adopted** (best practice,
fewer tokens: a parked turn pays a whole re-planning turn, a held one pays nothing). Spec
section 10 tier 2, slice 4; `permission_hold_minutes: 5` in `config.yaml`.

**D2. Overflow to the API instead of pausing (from the gateway studies).** Their answer (free
tiers, a local model) is wrong for data and quality, but the problem is real: when the
subscription window is exhausted the whole company stops until `resetsAt`, possibly for hours a
day once several agents work. The same CLI accepts an API key; the daemon could spawn overflow
turns with `ANTHROPIC_API_KEY` in the child environment, under a monthly cap the owner sets, and
label those turns "a consumo" in the Home tab (sessions are local files, so `--resume` still
works; the first overflow turn on a session is uncached because the cache lives with the
account [estimate]). This contradicts "solo il CLI" only in the credential, not in the engine,
and it is money. **Owner, 2026-09-19: no paid overflow, ever in this design: "free or
nothing"; the company stops at the limit and restarts at `resetsAt`.** Keep the limit pause and
the PARKED line that strips the key from the child env; the Home tab counts the hours paused.

**D3. The daemon sees test results (from the FinOps state machine and the generic cost study).**
Both want a deterministic escalation machine; the spec answers "the daemon cannot see a failed
test". It can, at one point: the developer's `report` envelope. Give the report envelope a
`tests_green: boolean` field (the first spec already had it in the close report). The daemon
then counts per task and per rung: two reports with `tests_green: false` on the same rung, or
two rejected reviews, and the daemon refuses another turn on that rung; the lead's only moves
are to reopen one rung up (Fable through the owner's card) or to ask the owner. The lead still
decides, the daemon enforces: principle 4. **Owner, 2026-09-19: adopted.** It also gives the
loop guard of A5 a second, sharper counter. Spec section 6 (envelope) and 10; slice 4 and 6.

Everything else stays rejected on the merits: PTY (refuted by measurement), removing
`--system-prompt-snapshot off` (refuted by measurement), auto-deny after 45 minutes (D1 answers
the availability concern without deciding for the owner), free tiers and a local model (data and
quality), frameworks (section 16), credential rotation across accounts, `--bare`, `STATE.md` and
`PreCompact` (the CLI's compaction plus `MEMORY.md` is the chosen structure; revisit with data if
the lead loses decisions after compaction).

## E. Prompt caching: what the spec already does, what the studies add

Prompt caching is the provider reusing the part of a request it has already processed (the
"prefix": everything from the first byte up to the first change) at a tenth of the price. The
spec is built on it, and the one number that matters is measured: a resumed turn costs 188
cache-creation tokens against 14,482 for a fresh one [measured, spec 2.9], and done-when 7
requires a resumed lead turn to read more than 90% of its input from cache.

Already in the spec: `--resume` for every agent; a byte-stable prefix (`STYLE.md` then
`AGENT.md`, static files); memory and project knowledge in the first user message, never in the
system prompt, so a memory write cannot invalidate the prefix; the per-turn state header inside
the user message, at the tail; `--exclude-dynamic-system-prompt-sections`;
`CLAUDE_CODE_PROMPT_CACHE_TTL=1h` (the cache lives one hour between turns instead of five
minutes); a `#ceo` alarm when a resumed turn's hit ratio drops below 0.7 twice; model and effort
fixed at spawn because a switch invalidates everything.

What the studies confirm and add, on the merits:

- **Byte invariance.** One timestamp, hash or reordered file in the prefix and the whole cache is
  lost for that turn at a 1.25× write price. The spec respects it; the slice 5 test "prompt
  composition order" must also assert that no dynamic value enters the system prompt files.
- **Idle gaps.** After one hour without a turn the cache is gone and the next turn is a full
  write (~14k tokens for the lead). That is inherent: a warm-up ping would cost the same. The
  first turn of a morning is expensive by design; the Home tab should not alarm on it.
- **Compaction.** Every CLI compaction (100k window) rewrites the history and misses the cache
  once. Expected, bounded; the optional "contesto compattato" line (B3) explains the spike.
- **Subagents share the prefix**: research and design run inside the caller's turn with the
  caller's system prompt already cached; their own TTL is 5 minutes (`CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL`).
- **Unknown, worth one measurement (live check 9):** the API prices a 1 h cache write at 2× and
  a 5 m write at 1.25×. Whether the subscription weighs them the same is not documented. Run the
  same two-turn script with the TTL at 5m and at 1h and compare the `result` costs; if 1h costs
  twice on write and the lead's turns are more than an hour apart most of the day, 5m may be the
  better default for job agents (which work in bursts) and 1h for standing agents.

Nothing else to change: the studies' "four-layer context" is what the prompt composition
already is (style, role, project, then the turn).

## C. Where this lands in the spec and the slices

| spec section | change |
|---|---|
| 4 `role.yaml` | `model`/`effort` defaults plus `models:`/`efforts:` menus; `config.yaml` gains `gated:` and `loop_guard:` |
| 6 Messaging | the loop guard (A5); `tests_green` in the report envelope (D3) |
| 8 MCP | `open_task` payload gains `effort` and `preset`; a gated value returns "in attesa del proprietario" |
| 9 Slack | status line every 30 s; the per-method budget table is a slice 3 NOTICED |
| 10 Governance | tier 2: hold for `permission_hold_minutes`, then park (D1); tier 3 gains gated models/effort (A3), the loop guard card and the rung counter (D3) |
| 11 Tasks | task kind `design`; the ladder and the "ask the owner" rule in the lead's `AGENT.md` |
| 12 Roles | the table of A1; designer as a job agent; research on Sonnet/medium |
| 13 Errors | optional "contesto compattato" line on `compact_boundary`; overflow to the API stays out of v1 (D2), the Home tab counts paused hours |
| 18 Live checks | check 8 (A9); check 9 (E, cache TTL weight on the subscription) |

Slices: 3 (status cadence, NOTICED on limits), 4 (loop guard counting, A7 deny text, A8, live
check 8), 5 (role files, presets, research definition), 6 (design tasks, gated cards, task card
states). Not committed by the reviewer of 2026-09-19; the supervisor edits the spec on `master`.

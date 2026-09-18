# Slice 1: store and loader — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the foundation every later slice builds on: a validated home folder in memory, a
SQLite store with the spec's tables and pragmas, and the append helpers that make "everything
is a file or a row" true.

**Architecture:** `src/config/` turns the home folder (YAML + markdown) into one frozen
`Snapshot` through zod schemas, keeping the last good snapshot when a reload fails.
`src/store/` opens SQLite with WAL + `synchronous=FULL`, applies Drizzle migrations, and exposes
small functions (append a message and its event in one transaction, the pending set for an
agent, outbox/inbox rows with dedup). `src/ports/` holds `Clock` and `Ids` with fakes. Nothing
here talks to Slack or to the CLI.

**Tech Stack:** TypeScript (strict, ESM), Node LTS, pnpm, zod, yaml, better-sqlite3,
drizzle-orm + drizzle-kit, vitest, Biome.

**Spec:** `docs/superpowers/specs/2026-09-18-agentopolis-v1-design.md`, sections 2, 4, 5
(read all of it once first). Roadmap and delivery rules:
`docs/superpowers/plans/2026-09-18-agentopolis-v1-roadmap.md`.

## Global Constraints

- Branch `slice/01-store-and-loader` from `master`; PR at the end; never push to `master`.
- Money is `INTEGER` micro-USD; time is `INTEGER` epoch-ms UTC via the `Clock` port; ids are
  monotonic integers (spec section 5).
- A config file containing a value that looks like a Slack token (`xoxb-`, `xoxp-`, `xapp-`)
  is rejected (spec section 3, loader).
- SQLite: WAL, `synchronous=FULL`, `busy_timeout=5000`; the daemon is the only writer (spec 5).
- `messages` rows are immutable; `turn_messages(message_id)` is UNIQUE; `inbox(event_id)` is
  UNIQUE; every state mutation writes an `events` row in the same transaction (spec 5).
- Verify every library API against the installed version (`node_modules/<pkg>/README.md` or
  its `.d.ts`), not against this plan: the plan was written from the docs of 2026-09-18 and the
  installed versions may differ. Record versions in the report.
- Stage explicit paths; commit after every green step; Biome clean before the report.

## File structure

```
package.json  tsconfig.json  biome.json  vitest.config.ts  drizzle.config.ts  .gitignore
src/
  ports/clock.ts        Clock port + SystemClock + FakeClock
  ports/ids.ts          Ids port (uuid for sessions) + FakeIds
  money.ts              micro-USD helpers
  config/schemas.ts     zod schemas: RoleFile, AgentFile, ProjectFile, ConfigFile
  config/secrets.ts     looksLikeSecret(), assertNoSecrets()
  config/loader.ts      loadHome(dir): Snapshot | LoadError[]
  config/holder.ts      SnapshotHolder: current + reload() keeping the last good
  store/schema.ts       Drizzle tables for spec section 5
  store/db.ts           openDatabase(path): pragmas + migrate
  store/messages.ts     appendMessage, pendingFor, recordDelivery
  store/events.ts       appendEvent (used inside other transactions)
  store/outbox.ts       enqueueOutbox, nextOutbox
  store/inbox.ts        recordInbound (dedup on event_id and logical_key)
  cli/init.ts           `agentopolis init <dir>`: copy examples/home, load, open db
drizzle/                generated SQL migrations (committed)
examples/home/          a valid minimal home folder
tests/                  mirrors src/, plus tests/fixtures/
```

---

### Task 1: package scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `vitest.config.ts`, `tests/smoke.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `pnpm test`, `pnpm lint`, `pnpm typecheck` scripts every later task uses.

- [ ] **Step 1: Initialise the package**

```bash
git checkout -b slice/01-store-and-loader
pnpm init
pnpm add zod yaml better-sqlite3 drizzle-orm
pnpm add -D typescript @types/node @types/better-sqlite3 drizzle-kit vitest @biomejs/biome tsx
pnpm biome init
node --version   # record it for the report
```

- [ ] **Step 2: Write `package.json` scripts and ESM**

```json
{
  "name": "agentopolis",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "format": "biome format --write .",
    "db:generate": "drizzle-kit generate",
    "agentopolis": "tsx src/cli/main.ts"
  }
}
```

Keep the dependency blocks pnpm wrote.

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["src", "tests", "drizzle.config.ts", "vitest.config.ts"]
}
```

- [ ] **Step 4: Write `vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 5: Append to `.gitignore`**

```
node_modules/
dist/
*.db
*.db-wal
*.db-shm
runs/
```

- [ ] **Step 6: Write the smoke test**

`tests/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("toolchain", () => {
  it("runs a test", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 7: Run everything**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: 1 test passed; typecheck exits 0; Biome reports no errors (fix formatting with
`pnpm format` if it complains about the files you wrote).

- [ ] **Step 8: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json biome.json vitest.config.ts tests/smoke.test.ts .gitignore
git commit -m "chore: scaffold the TypeScript package with vitest and Biome"
```

---

### Task 2: money, clock and ids

**Files:**
- Create: `src/money.ts`, `src/ports/clock.ts`, `src/ports/ids.ts`
- Test: `tests/money.test.ts`, `tests/ports/clock.test.ts`

**Interfaces:**
- Produces: `toMicroUsd(usd: number): number`, `formatEur(micro: number): string` (display only),
  `interface Clock { now(): number }`, `SystemClock`, `FakeClock(start: number)` with
  `advance(ms)`, `interface Ids { uuid(): string }`, `SystemIds`, `FakeIds(seed: string[])`.

- [ ] **Step 1: Write the failing tests**

`tests/money.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { formatUsd, toMicroUsd } from "../src/money.js";

describe("money", () => {
  it("converts dollars to integer micro-USD without float drift", () => {
    expect(toMicroUsd(0.1)).toBe(100_000);
    expect(toMicroUsd(0.2)).toBe(200_000);
    expect(toMicroUsd(0.1) + toMicroUsd(0.2)).toBe(300_000);
    expect(toMicroUsd(1.234567)).toBe(1_234_567);
  });
  it("rejects negative or non-finite input", () => {
    expect(() => toMicroUsd(-1)).toThrow();
    expect(() => toMicroUsd(Number.NaN)).toThrow();
  });
  it("formats for display with two decimals", () => {
    expect(formatUsd(1_234_567)).toBe("1.23");
    expect(formatUsd(0)).toBe("0.00");
  });
});
```

`tests/ports/clock.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { FakeClock, SystemClock } from "../../src/ports/clock.js";
import { FakeIds } from "../../src/ports/ids.js";

describe("clock", () => {
  it("system clock returns epoch milliseconds", () => {
    const t = new SystemClock().now();
    expect(Number.isInteger(t)).toBe(true);
    expect(t).toBeGreaterThan(1_700_000_000_000);
  });
  it("fake clock advances only when told", () => {
    const c = new FakeClock(1_000);
    expect(c.now()).toBe(1_000);
    c.advance(500);
    expect(c.now()).toBe(1_500);
  });
  it("fake ids hand out the seeded values in order and then throw", () => {
    const ids = new FakeIds(["a", "b"]);
    expect(ids.uuid()).toBe("a");
    expect(ids.uuid()).toBe("b");
    expect(() => ids.uuid()).toThrow();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`src/money.ts`:

```ts
const MICRO = 1_000_000;

export function toMicroUsd(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`toMicroUsd: invalid amount ${usd}`);
  }
  return Math.round(usd * MICRO);
}

export function formatUsd(micro: number): string {
  return (micro / MICRO).toFixed(2);
}
```

`src/ports/clock.ts`:

```ts
export interface Clock {
  now(): number; // epoch milliseconds UTC
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

export class FakeClock implements Clock {
  #t: number;
  constructor(start: number) {
    this.#t = start;
  }
  now(): number {
    return this.#t;
  }
  advance(ms: number): void {
    this.#t += ms;
  }
}
```

`src/ports/ids.ts`:

```ts
import { randomUUID } from "node:crypto";

export interface Ids {
  uuid(): string;
}

export class SystemIds implements Ids {
  uuid(): string {
    return randomUUID();
  }
}

export class FakeIds implements Ids {
  #queue: string[];
  constructor(seed: string[]) {
    this.#queue = [...seed];
  }
  uuid(): string {
    const next = this.#queue.shift();
    if (next === undefined) throw new Error("FakeIds: exhausted");
    return next;
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
git add src/money.ts src/ports/clock.ts src/ports/ids.ts tests/money.test.ts tests/ports/clock.test.ts
git commit -m "feat(ports): money in micro-USD, clock and ids ports with fakes"
```

---

### Task 3: zod schemas for the four YAML kinds

**Files:**
- Create: `src/config/schemas.ts`, `src/config/secrets.ts`
- Test: `tests/config/schemas.test.ts`

**Interfaces:**
- Produces: `RoleFile`, `AgentFile`, `ProjectFile`, `ConfigFile` (zod schemas and inferred
  types), `looksLikeSecret(value: string): boolean`, `findSecrets(obj: unknown): string[]`
  (JSON paths of offending values).

- [ ] **Step 1: Write the failing tests**

`tests/config/schemas.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { AgentFile, ConfigFile, ProjectFile, RoleFile } from "../../src/config/schemas.js";
import { findSecrets, looksLikeSecret } from "../../src/config/secrets.js";

const role = {
  name: "lead",
  description: "Runs one product's engineering.",
  kind: "standing",
  model: "opus",
  effort: "high",
  tools: ["agentopolis", "github"],
  disallowed_tools: ["Edit", "Write"],
  permissions: { mode: "acceptEdits", allow: ["Bash(git *)"], deny: [], hooks: [] },
  budget: { monthly_usd: 60, per_turn_usd: 5 },
  max_turns: 60,
  max_wall_clock_minutes: 45,
  talks_to: ["ceo", "owner", "developer"],
  requests: ["open_task", "close_task"],
};

describe("RoleFile", () => {
  it("accepts a valid role and applies defaults", () => {
    const r = RoleFile.parse(role);
    expect(r.kind).toBe("standing");
    expect(r.tools).toContain("agentopolis");
  });
  it("adds agentopolis to tools when omitted", () => {
    const r = RoleFile.parse({ ...role, tools: ["github"] });
    expect(r.tools).toEqual(["agentopolis", "github"]);
  });
  it("rejects an unknown kind and an unknown key", () => {
    expect(RoleFile.safeParse({ ...role, kind: "daemon" }).success).toBe(false);
    expect(RoleFile.safeParse({ ...role, colour: "red" }).success).toBe(false);
  });
  it("rejects a budget that is not positive", () => {
    expect(RoleFile.safeParse({ ...role, budget: { monthly_usd: 0, per_turn_usd: 5 } }).success).toBe(false);
  });
});

describe("AgentFile", () => {
  it("accepts nulls for overrides", () => {
    const a = AgentFile.parse({
      name: "agentopolis-lead",
      display: "Leo · lead Agentopolis",
      avatar: "https://example.test/leo.png",
      role: "lead",
      project: "agentopolis",
      reports_to: "ceo",
      model: null,
      effort: null,
      budget_monthly_usd: null,
      paused: false,
      session_id: null,
      session_started_at: null,
    });
    expect(a.paused).toBe(false);
  });
  it("requires a lowercase slug name", () => {
    expect(AgentFile.safeParse({ name: "Leo Lead", display: "x", role: "lead", reports_to: "ceo" }).success).toBe(false);
  });
});

describe("ProjectFile", () => {
  it("requires distinct work and production branches", () => {
    const ok = ProjectFile.safeParse({
      slug: "agentopolis",
      name: "Agentopolis",
      repo: "/tmp/agentopolis",
      branches: { work: "dev", production: "master" },
      lead: "agentopolis-lead",
    });
    expect(ok.success).toBe(true);
    const same = ProjectFile.safeParse({
      slug: "agentopolis",
      name: "Agentopolis",
      repo: "/tmp/agentopolis",
      branches: { work: "master", production: "master" },
      lead: "agentopolis-lead",
    });
    expect(same.success).toBe(false);
  });
});

describe("ConfigFile", () => {
  const config = {
    slack: { bot_token_env: "SLACK_BOT_TOKEN", app_token_env: "SLACK_APP_TOKEN", owner_user_id: "U0123ABCD", work_channel_suffix: "-work" },
    language: "it",
    budgets: { company_monthly_usd: 300 },
    approvals: { timeout_hours: 24, snooze_hours: 4 },
    quiet_hours: { from: "23:00", to: "08:00", tz: "Europe/Rome" },
    daily_digest_at: "08:30",
    max_concurrent_turns: 3,
    mcp_servers: { github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } },
  };
  it("accepts the spec example", () => {
    expect(ConfigFile.safeParse(config).success).toBe(true);
  });
  it("rejects a time that is not HH:MM", () => {
    expect(ConfigFile.safeParse({ ...config, daily_digest_at: "8h30" }).success).toBe(false);
  });
});

describe("secrets", () => {
  it("recognises Slack token shapes", () => {
    expect(looksLikeSecret("xoxb-123-abc")).toBe(true);
    expect(looksLikeSecret("xapp-1-A-abc")).toBe(true);
    expect(looksLikeSecret("SLACK_BOT_TOKEN")).toBe(false);
  });
  it("finds a token anywhere in a parsed document", () => {
    expect(findSecrets({ slack: { bot_token_env: "xoxb-1-2" }, list: ["ok", "xapp-9"] })).toEqual([
      "slack.bot_token_env",
      "list[1]",
    ]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm test tests/config/schemas.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the secrets helper**

`src/config/secrets.ts`:

```ts
const SECRET_SHAPES = [/^xox[abp]-/, /^xapp-/];

export function looksLikeSecret(value: string): boolean {
  return SECRET_SHAPES.some((re) => re.test(value));
}

export function findSecrets(obj: unknown, path = ""): string[] {
  if (typeof obj === "string") return looksLikeSecret(obj) ? [path] : [];
  if (Array.isArray(obj)) return obj.flatMap((v, i) => findSecrets(v, `${path}[${i}]`));
  if (obj && typeof obj === "object") {
    return Object.entries(obj).flatMap(([k, v]) => findSecrets(v, path ? `${path}.${k}` : k));
  }
  return [];
}
```

- [ ] **Step 4: Implement the schemas**

`src/config/schemas.ts`:

```ts
import { z } from "zod";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase slug");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");
const positive = z.number().positive();

export const RoleKind = z.enum(["standing", "job"]);
export const PermissionMode = z.enum(["default", "acceptEdits", "plan", "auto", "dontAsk"]);
export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const RequestKind = z.enum([
  "open_task", "close_task", "hire", "retire", "pause", "set_budget", "merge_production", "run_schedule",
]);

export const RoleFile = z
  .object({
    name: slug,
    description: z.string().min(1),
    kind: RoleKind,
    model: z.string().min(1),
    effort: Effort.optional(),
    tools: z.array(z.string().min(1)).default([]).transform((t) => (t.includes("agentopolis") ? t : ["agentopolis", ...t])),
    disallowed_tools: z.array(z.string().min(1)).default([]),
    permissions: z
      .object({
        mode: PermissionMode,
        allow: z.array(z.string()).default([]),
        deny: z.array(z.string()).default([]),
        hooks: z.array(z.string()).default([]),
      })
      .strict(),
    budget: z.object({ monthly_usd: positive, per_turn_usd: positive }).strict(),
    max_turns: z.number().int().positive(),
    max_wall_clock_minutes: z.number().int().positive(),
    talks_to: z.array(z.string().min(1)).min(1),
    requests: z.array(RequestKind).default([]),
  })
  .strict();
export type RoleFile = z.infer<typeof RoleFile>;

export const AgentFile = z
  .object({
    name: slug,
    display: z.string().min(1),
    avatar: z.string().url().optional(),
    role: slug,
    project: slug.optional(),
    reports_to: slug,
    model: z.string().min(1).nullable().default(null),
    effort: Effort.nullable().default(null),
    budget_monthly_usd: positive.nullable().default(null),
    paused: z.boolean().default(false),
    session_id: z.string().uuid().nullable().default(null),
    session_started_at: z.number().int().nullable().default(null),
  })
  .strict();
export type AgentFile = z.infer<typeof AgentFile>;

export const ProjectFile = z
  .object({
    slug,
    name: z.string().min(1),
    repo: z.string().min(1),
    branches: z.object({ work: z.string().min(1), production: z.string().min(1) }).strict(),
    lead: slug,
  })
  .strict()
  .refine((p) => p.branches.work !== p.branches.production, {
    message: "work and production branches must differ",
    path: ["branches"],
  });
export type ProjectFile = z.infer<typeof ProjectFile>;

export const McpServerDef = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string()).default({}),
  })
  .strict();

export const ConfigFile = z
  .object({
    slack: z
      .object({
        bot_token_env: z.string().min(1),
        app_token_env: z.string().min(1),
        owner_user_id: z.string().regex(/^[UW][A-Z0-9]+$/),
        work_channel_suffix: z.string().default("-work"),
      })
      .strict(),
    language: z.enum(["it", "en"]).default("it"),
    budgets: z.object({ company_monthly_usd: positive }).strict(),
    approvals: z.object({ timeout_hours: positive, snooze_hours: positive }).strict(),
    quiet_hours: z.object({ from: hhmm, to: hhmm, tz: z.string().min(1) }).strict().optional(),
    daily_digest_at: hhmm.optional(),
    max_concurrent_turns: z.number().int().positive().default(3),
    mcp_servers: z.record(McpServerDef).default({}),
  })
  .strict();
export type ConfigFile = z.infer<typeof ConfigFile>;
```

If the installed zod is v4, `z.record(McpServerDef)` needs a key schema: `z.record(z.string(),
McpServerDef)`; `.url()` may be `z.url()`. Check `node_modules/zod/README.md` and adapt.

- [ ] **Step 5: Run the tests**

Run: `pnpm test tests/config/schemas.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Commit**

```bash
git add src/config/schemas.ts src/config/secrets.ts tests/config/schemas.test.ts
git commit -m "feat(config): zod schemas for role, agent, project and config files; secret detection"
```

---

### Task 4: the home-folder loader

**Files:**
- Create: `src/config/loader.ts`
- Test: `tests/config/loader.test.ts`, fixtures under `tests/fixtures/home-valid/` and
  `tests/fixtures/home-broken/`

**Interfaces:**
- Produces: `type Snapshot = Readonly<{ dir: string; config: ConfigFile; style: string; roles:
  ReadonlyMap<string, Role>; agents: ReadonlyMap<string, AgentFile>; projects: ReadonlyMap<string,
  ProjectFile>; version: string }>`, where `Role = RoleFile & { soul: string; job: string; protocol:
  string }`; `loadHome(dir): { ok: true; snapshot } | { ok: false; errors: LoadError[] }`;
  `type LoadError = { file: string; message: string }`. `version` is a sha256 over every file's
  bytes, used later as `turns.config_version`.

- [ ] **Step 1: Create the fixtures**

`tests/fixtures/home-valid/config.yaml`:

```yaml
slack:
  bot_token_env: SLACK_BOT_TOKEN
  app_token_env: SLACK_APP_TOKEN
  owner_user_id: U0123ABCD
language: it
budgets: { company_monthly_usd: 300 }
approvals: { timeout_hours: 24, snooze_hours: 4 }
max_concurrent_turns: 2
```

`tests/fixtures/home-valid/STYLE.md`: one line, `Tu form. Decision first.`

`tests/fixtures/home-valid/roles/ceo/role.yaml`:

```yaml
name: ceo
description: The owner's only interlocutor.
kind: standing
model: sonnet
effort: low
disallowed_tools: [Edit, Write, NotebookEdit, Bash]
permissions: { mode: default }
budget: { monthly_usd: 20, per_turn_usd: 1 }
max_turns: 20
max_wall_clock_minutes: 10
talks_to: [owner, lead]
requests: [hire, retire, pause, set_budget, open_task]
```

Plus `SOUL.md`, `JOB.md`, `PROTOCOL.md` in the same folder, each one line of text.

`tests/fixtures/home-valid/agents/ceo/agent.yaml`:

```yaml
name: ceo
display: Ada · CEO
role: ceo
reports_to: owner
```

`tests/fixtures/home-valid/projects/agentopolis/project.yaml`:

```yaml
slug: agentopolis
name: Agentopolis
repo: /tmp/agentopolis
branches: { work: dev, production: master }
lead: agentopolis-lead
```

`tests/fixtures/home-broken/`: copy of `home-valid` where `roles/ceo/role.yaml` has
`kind: daemon`, `roles/ceo/JOB.md` is missing, and `config.yaml` has
`bot_token_env: xoxb-1-2-3`.

- [ ] **Step 2: Write the failing tests**

`tests/config/loader.test.ts`:

```ts
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadHome } from "../../src/config/loader.js";

const fixture = (name: string) => fileURLToPath(new URL(`../fixtures/${name}/`, import.meta.url));

describe("loadHome", () => {
  it("loads a valid home folder into a frozen snapshot", () => {
    const r = loadHome(fixture("home-valid"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.roles.get("ceo")?.soul).toContain("");
    expect(r.snapshot.roles.get("ceo")?.tools).toEqual(["agentopolis"]);
    expect(r.snapshot.agents.get("ceo")?.display).toBe("Ada · CEO");
    expect(r.snapshot.projects.get("agentopolis")?.branches.production).toBe("master");
    expect(r.snapshot.style).toContain("Tu form");
    expect(Object.isFrozen(r.snapshot)).toBe(true);
    expect(r.snapshot.version).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports every error with its file, and never a partial snapshot", () => {
    const r = loadHome(fixture("home-broken"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const files = r.errors.map((e) => e.file);
    expect(files.some((f) => f.endsWith("roles/ceo/role.yaml"))).toBe(true);
    expect(files.some((f) => f.endsWith("roles/ceo/JOB.md"))).toBe(true);
    expect(files.some((f) => f.endsWith("config.yaml"))).toBe(true);
    expect(r.errors.find((e) => e.file.endsWith("config.yaml"))?.message).toMatch(/secret/i);
  });

  it("rejects an agent whose role or reports_to does not exist", () => {
    // build a temp copy of home-valid with agents/x/agent.yaml pointing at role "ghost"
    // (use fs.mkdtempSync + fs.cpSync), then assert ok === false and the message names "ghost".
  });

  it("changes version when any file changes", () => {
    // temp copy; load; append a line to STYLE.md; load again; versions differ.
  });
});
```

Write the two commented tests in full (they are part of the deliverable): create the temp copy
with `fs.mkdtempSync(path.join(os.tmpdir(), "home-"))` and `fs.cpSync(src, dst, { recursive:
true })`.

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm test tests/config/loader.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement the loader**

`src/config/loader.ts`:

```ts
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ZodTypeAny, z } from "zod";
import { AgentFile, ConfigFile, ProjectFile, RoleFile } from "./schemas.js";
import { findSecrets } from "./secrets.js";

export type LoadError = { file: string; message: string };
export type Role = RoleFile & { soul: string; job: string; protocol: string };
export type Snapshot = Readonly<{
  dir: string;
  config: ConfigFile;
  style: string;
  roles: ReadonlyMap<string, Role>;
  agents: ReadonlyMap<string, AgentFile>;
  projects: ReadonlyMap<string, ProjectFile>;
  version: string;
}>;
export type LoadResult = { ok: true; snapshot: Snapshot } | { ok: false; errors: LoadError[] };

const ROLE_PROSE = ["SOUL.md", "JOB.md", "PROTOCOL.md"] as const;

export function loadHome(dir: string): LoadResult {
  const errors: LoadError[] = [];
  const hash = createHash("sha256");

  const readText = (file: string): string | undefined => {
    if (!existsSync(file)) {
      errors.push({ file, message: "missing" });
      return undefined;
    }
    const bytes = readFileSync(file);
    hash.update(file).update(bytes);
    return bytes.toString("utf8");
  };

  const readYaml = <S extends ZodTypeAny>(file: string, schema: S): z.infer<S> | undefined => {
    const text = readText(file);
    if (text === undefined) return undefined;
    let doc: unknown;
    try {
      doc = parseYaml(text);
    } catch (e) {
      errors.push({ file, message: `yaml: ${(e as Error).message}` });
      return undefined;
    }
    const secrets = findSecrets(doc);
    if (secrets.length > 0) {
      errors.push({ file, message: `secret-looking value at ${secrets.join(", ")}; secrets live in the environment` });
      return undefined;
    }
    const parsed = schema.safeParse(doc);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        errors.push({ file, message: `${issue.path.join(".") || "(root)"}: ${issue.message}` });
      }
      return undefined;
    }
    return parsed.data;
  };

  const subdirs = (parent: string): string[] =>
    existsSync(parent)
      ? readdirSync(parent).filter((n) => !n.startsWith(".") && statSync(join(parent, n)).isDirectory()).sort()
      : [];

  const config = readYaml(join(dir, "config.yaml"), ConfigFile);
  const style = readText(join(dir, "STYLE.md")) ?? "";

  const roles = new Map<string, Role>();
  for (const name of subdirs(join(dir, "roles"))) {
    const base = join(dir, "roles", name);
    const role = readYaml(join(base, "role.yaml"), RoleFile);
    const prose = ROLE_PROSE.map((f) => readText(join(base, f)));
    if (role && prose.every((p) => p !== undefined)) {
      if (role.name !== name) errors.push({ file: join(base, "role.yaml"), message: `name "${role.name}" must equal folder "${name}"` });
      roles.set(name, { ...role, soul: prose[0] as string, job: prose[1] as string, protocol: prose[2] as string });
    }
  }

  const agents = new Map<string, AgentFile>();
  for (const name of subdirs(join(dir, "agents"))) {
    const file = join(dir, "agents", name, "agent.yaml");
    const agent = readYaml(file, AgentFile);
    if (!agent) continue;
    if (agent.name !== name) errors.push({ file, message: `name "${agent.name}" must equal folder "${name}"` });
    agents.set(name, agent);
  }

  const projects = new Map<string, ProjectFile>();
  for (const name of subdirs(join(dir, "projects"))) {
    const file = join(dir, "projects", name, "project.yaml");
    const project = readYaml(file, ProjectFile);
    if (!project) continue;
    if (project.slug !== name) errors.push({ file, message: `slug "${project.slug}" must equal folder "${name}"` });
    projects.set(name, project);
  }

  // cross references
  for (const [name, agent] of agents) {
    const file = join(dir, "agents", name, "agent.yaml");
    if (!roles.has(agent.role)) errors.push({ file, message: `role "${agent.role}" does not exist` });
    if (agent.reports_to !== "owner" && !agents.has(agent.reports_to)) {
      errors.push({ file, message: `reports_to "${agent.reports_to}" does not exist` });
    }
    if (agent.project !== undefined && !projects.has(agent.project)) {
      errors.push({ file, message: `project "${agent.project}" does not exist` });
    }
  }

  if (errors.length > 0 || !config) return { ok: false, errors };
  const snapshot: Snapshot = Object.freeze({
    dir,
    config,
    style,
    roles,
    agents,
    projects,
    version: hash.digest("hex"),
  });
  return { ok: true, snapshot };
}
```

- [ ] **Step 5: Run the tests**

Run: `pnpm test tests/config/loader.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/config/loader.ts tests/config/loader.test.ts tests/fixtures
git commit -m "feat(config): load the home folder into a frozen, versioned snapshot"
```

---

### Task 5: the snapshot holder (last good wins)

**Files:**
- Create: `src/config/holder.ts`
- Test: `tests/config/holder.test.ts`

**Interfaces:**
- Produces: `class SnapshotHolder { constructor(dir); readonly current: Snapshot; reload():
  { ok: true; changed: boolean } | { ok: false; errors: LoadError[] }; static open(dir):
  SnapshotHolder }` — `open` throws when the first load fails (the daemon must not start on a
  broken folder); `reload` keeps `current` on failure.

- [ ] **Step 1: Write the failing tests**

`tests/config/holder.test.ts`:

```ts
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SnapshotHolder } from "../../src/config/holder.js";

const valid = fileURLToPath(new URL("../fixtures/home-valid/", import.meta.url));
const copy = () => {
  const d = mkdtempSync(join(tmpdir(), "home-"));
  cpSync(valid, d, { recursive: true });
  return d;
};

describe("SnapshotHolder", () => {
  it("throws when the first load fails", () => {
    const d = copy();
    writeFileSync(join(d, "config.yaml"), "not: [valid");
    expect(() => SnapshotHolder.open(d)).toThrow(/config\.yaml/);
  });
  it("keeps the last good snapshot when a reload fails, and reports the errors", () => {
    const d = copy();
    const h = SnapshotHolder.open(d);
    const v1 = h.current.version;
    writeFileSync(join(d, "roles", "ceo", "role.yaml"), "kind: daemon\n");
    const r = h.reload();
    expect(r.ok).toBe(false);
    expect(h.current.version).toBe(v1);
  });
  it("swaps to the new snapshot when a reload succeeds", () => {
    const d = copy();
    const h = SnapshotHolder.open(d);
    const v1 = h.current.version;
    writeFileSync(join(d, "STYLE.md"), "Tu form. Decision first. Short.\n");
    const r = h.reload();
    expect(r).toEqual({ ok: true, changed: true });
    expect(h.current.version).not.toBe(v1);
    expect(h.reload()).toEqual({ ok: true, changed: false });
  });
});
```

- [ ] **Step 2: Run to see them fail**, then **Step 3: implement**

`src/config/holder.ts`:

```ts
import { type LoadError, type Snapshot, loadHome } from "./loader.js";

export class SnapshotHolder {
  #current: Snapshot;
  readonly dir: string;

  private constructor(dir: string, first: Snapshot) {
    this.dir = dir;
    this.#current = first;
  }

  static open(dir: string): SnapshotHolder {
    const r = loadHome(dir);
    if (!r.ok) {
      throw new Error(`home folder invalid:\n${r.errors.map((e) => `  ${e.file}: ${e.message}`).join("\n")}`);
    }
    return new SnapshotHolder(dir, r.snapshot);
  }

  get current(): Snapshot {
    return this.#current;
  }

  reload(): { ok: true; changed: boolean } | { ok: false; errors: LoadError[] } {
    const r = loadHome(this.dir);
    if (!r.ok) return r;
    const changed = r.snapshot.version !== this.#current.version;
    if (changed) this.#current = r.snapshot;
    return { ok: true, changed };
  }
}
```

- [ ] **Step 4: Run the tests** — Expected: PASS (3).

- [ ] **Step 5: Commit**

```bash
git add src/config/holder.ts tests/config/holder.test.ts
git commit -m "feat(config): snapshot holder that keeps the last good snapshot on a failed reload"
```

---

### Task 6: the database, its pragmas and the Drizzle schema

**Files:**
- Create: `drizzle.config.ts`, `src/store/schema.ts`, `src/store/db.ts`, `drizzle/` (generated)
- Test: `tests/store/db.test.ts`

**Interfaces:**
- Produces: `openDatabase(path: string): Db` where `Db = { sqlite: Database; orm:
  BetterSQLite3Database<typeof schema>; close(): void }`; every table of spec section 5 exported
  from `schema.ts` with these exact names: `agents, containers, messages, turnMessages, turns,
  requests, permissionRequests, tasks, outbox, inbox, renders, schedules, events`.

- [ ] **Step 1: Write the failing test**

`tests/store/db.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/store/db.js";

describe("openDatabase", () => {
  it("opens with WAL, synchronous=FULL and a busy timeout, and applies migrations", () => {
    const file = join(mkdtempSync(join(tmpdir(), "db-")), "a.db");
    const db = openDatabase(file);
    expect(db.sqlite.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.sqlite.pragma("synchronous", { simple: true })).toBe(2); // 2 = FULL
    expect(db.sqlite.pragma("busy_timeout", { simple: true })).toBe(5000);
    const tables = db.sqlite
      .prepare("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '__drizzle%'")
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(tables).toEqual([
      "agents", "containers", "events", "inbox", "messages", "outbox", "permission_requests",
      "renders", "requests", "schedules", "tasks", "turn_messages", "turns",
    ]);
    db.close();
  });
  it("is idempotent: opening twice applies nothing new", () => {
    const file = join(mkdtempSync(join(tmpdir(), "db-")), "a.db");
    openDatabase(file).close();
    expect(() => openDatabase(file).close()).not.toThrow();
  });
});
```

- [ ] **Step 2: Write the Drizzle schema**

`src/store/schema.ts`:

```ts
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  name: text("name").primaryKey(),
  sessionId: text("session_id"),
  sessionStartedAt: integer("session_started_at"),
  paused: integer("paused", { mode: "boolean" }).notNull().default(false),
  ownerHost: text("owner_host"),
  leaseUntil: integer("lease_until"),
});

export const containers = sqliteTable("containers", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind", { enum: ["standing", "task"] }).notNull(),
  members: text("members", { mode: "json" }).$type<string[]>().notNull(),
  defaultTo: text("default_to").notNull(),
  taskId: integer("task_id"),
  slackChannel: text("slack_channel"),
  slackThreadTs: text("slack_thread_ts"),
  closedAt: integer("closed_at"),
});

export const messages = sqliteTable(
  "messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    containerId: integer("container_id").notNull().references(() => containers.id),
    author: text("author").notNull(),
    to: text("to").notNull(),
    body: text("body").notNull(),
    kind: text("kind", { enum: ["say", "ask", "report", "system"] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("messages_to_id").on(t.to, t.id), index("messages_container_id").on(t.containerId, t.id)],
);

export const turnMessages = sqliteTable(
  "turn_messages",
  {
    turnId: integer("turn_id").notNull(),
    messageId: integer("message_id").notNull().references(() => messages.id),
  },
  (t) => [uniqueIndex("turn_messages_message_unique").on(t.messageId)],
);

export const turns = sqliteTable(
  "turns",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agent: text("agent").notNull(),
    startedAt: integer("started_at").notNull(),
    endedAt: integer("ended_at"),
    status: text("status", {
      enum: ["running", "ok", "failed", "interrupted", "timed_out", "cancelled", "budget_exhausted", "max_turns"],
    }).notNull(),
    sessionId: text("session_id").notNull(),
    pid: integer("pid"),
    traceId: text("trace_id"),
    configVersion: text("config_version").notNull(),
    costMicrousd: integer("cost_microusd"),
    costBasis: text("cost_basis"),
    modelUsage: text("model_usage", { mode: "json" }),
    cacheRead: integer("cache_read"),
    cacheCreation: integer("cache_creation"),
    error: text("error"),
  },
  (t) => [index("turns_agent_started").on(t.agent, t.startedAt)],
);

export const requests = sqliteTable(
  "requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agent: text("agent").notNull(),
    kind: text("kind").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    status: text("status", { enum: ["pending", "approved", "denied", "expired", "done", "snoozed"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    decidedBy: text("decided_by"),
    decidedAt: integer("decided_at"),
    result: text("result", { mode: "json" }),
    epoch: integer("epoch").notNull().default(0),
  },
  (t) => [index("requests_status_created").on(t.status, t.createdAt)],
);

export const permissionRequests = sqliteTable("permission_requests", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  turnId: integer("turn_id").notNull(),
  toolUseId: text("tool_use_id").notNull(),
  toolName: text("tool_name").notNull(),
  input: text("input", { mode: "json" }).notNull(),
  scope: text("scope", { enum: ["once", "task"] }).notNull().default("once"),
  status: text("status", { enum: ["pending", "allowed", "denied", "expired"] }).notNull(),
  createdAt: integer("created_at").notNull(),
  decidedAt: integer("decided_at"),
});

export const tasks = sqliteTable("tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  project: text("project").notNull(),
  title: text("title").notNull(),
  lead: text("lead").notNull(),
  status: text("status", { enum: ["open", "review", "done", "closed"] }).notNull(),
  worktree: text("worktree"),
  slackThreadTs: text("slack_thread_ts"),
  openedAt: integer("opened_at").notNull(),
  closedAt: integer("closed_at"),
});

export const outbox = sqliteTable(
  "outbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    channel: text("channel").notNull(),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull(),
    doneAt: integer("done_at"),
    slackTs: text("slack_ts"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("outbox_next_attempt").on(t.nextAttemptAt)],
);

export const inbox = sqliteTable(
  "inbox",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    logicalKey: text("logical_key"),
    payload: text("payload", { mode: "json" }).notNull(),
    receivedAt: integer("received_at").notNull(),
    processedAt: integer("processed_at"),
  },
  (t) => [uniqueIndex("inbox_event_unique").on(t.eventId), index("inbox_logical_key").on(t.logicalKey)],
);

export const renders = sqliteTable("renders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  kind: text("kind").notNull(),
  payload: text("payload", { mode: "json" }).notNull(),
  createdAt: integer("created_at").notNull(),
});

export const schedules = sqliteTable("schedules", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  agent: text("agent").notNull(),
  cron: text("cron").notNull(),
  prompt: text("prompt").notNull(),
  lastFired: integer("last_fired"),
});

export const events = sqliteTable("events", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  at: integer("at").notNull(),
  kind: text("kind").notNull(),
  agent: text("agent"),
  payload: text("payload", { mode: "json" }).notNull(),
  traceId: text("trace_id"),
});
```

`drizzle.config.ts`:

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/store/schema.ts",
  out: "./drizzle",
});
```

Run: `pnpm db:generate` — this writes `drizzle/0000_*.sql` and `drizzle/meta/`. Commit them:
migrations are part of the source. Check the generated SQL has the two UNIQUE indexes.

- [ ] **Step 3: Implement `openDatabase`**

`src/store/db.ts`:

```ts
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";

export type Db = {
  sqlite: Database.Database;
  orm: BetterSQLite3Database<typeof schema>;
  close(): void;
};

const MIGRATIONS = fileURLToPath(new URL("../../drizzle/", import.meta.url));

export function openDatabase(path: string): Db {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("synchronous = FULL");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("foreign_keys = ON");
  const orm = drizzle(sqlite, { schema });
  migrate(orm, { migrationsFolder: MIGRATIONS });
  return { sqlite, orm, close: () => sqlite.close() };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm test tests/store/db.test.ts`
Expected: PASS (2). If the migrations folder path resolves wrongly under vitest, resolve it
from `process.cwd()` instead and note it in the report.

- [ ] **Step 5: Commit**

```bash
git add drizzle.config.ts src/store/schema.ts src/store/db.ts drizzle tests/store/db.test.ts
git commit -m "feat(store): SQLite opened with WAL, synchronous=FULL, busy timeout; Drizzle schema and migrations for every table"
```

---

### Task 7: append helpers with the delivery guarantee

**Files:**
- Create: `src/store/events.ts`, `src/store/messages.ts`, `src/store/outbox.ts`, `src/store/inbox.ts`
- Test: `tests/store/messages.test.ts`, `tests/store/inbox.test.ts`

**Interfaces:**
- Produces:
  - `appendEvent(tx, { at, kind, agent?, payload, traceId? }): number` (inside a transaction).
  - `appendMessage(db, clock, { containerId, author, to, body, kind }): { messageId: number;
    eventId: number }` — one transaction: message row, event row `message.posted`, and an outbox
    row of kind `mirror.message` for the container's channel.
  - `pendingFor(db, agent): Message[]` — messages `to = agent` with no `turn_messages` row,
    ordered by id.
  - `recordDelivery(db, turnId, messageIds): void` — inserts `turn_messages`; a duplicate throws.
  - `enqueueOutbox(tx, clock, { kind, channel, payload }): number`; `nextOutbox(db, now, limit):
    OutboxRow[]` ordered by `next_attempt_at, id`, where `done_at IS NULL AND next_attempt_at <= now`.
  - `recordInbound(db, clock, { eventId, logicalKey?, payload }): { inserted: boolean; id: number
    }` — `inserted: false` on a duplicate `event_id` or a duplicate `logical_key` seen in the last
    24 h (`clock.now() - 86_400_000`).

- [ ] **Step 1: Write the failing tests**

`tests/store/messages.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/ports/clock.js";
import { openDatabase } from "../../src/store/db.js";
import { appendMessage, pendingFor, recordDelivery } from "../../src/store/messages.js";
import { nextOutbox } from "../../src/store/outbox.js";
import { containers, events } from "../../src/store/schema.js";

const fresh = () => openDatabase(join(mkdtempSync(join(tmpdir(), "db-")), "a.db"));

describe("messages", () => {
  it("appends a message, its event and its outbox row in one transaction", () => {
    const db = fresh();
    const clock = new FakeClock(1_000);
    const c = db.orm.insert(containers).values({ kind: "standing", members: ["ceo", "owner"], defaultTo: "ceo", slackChannel: "C1" }).returning({ id: containers.id }).get();
    const r = appendMessage(db, clock, { containerId: c.id, author: "owner", to: "ceo", body: "ciao", kind: "say" });
    expect(r.messageId).toBe(1);
    expect(db.orm.select().from(events).all().map((e) => e.kind)).toEqual(["message.posted"]);
    expect(nextOutbox(db, 1_000, 10).map((o) => o.kind)).toEqual(["mirror.message"]);
    db.close();
  });

  it("pending set is everything addressed to me not yet delivered; delivery is unique", () => {
    const db = fresh();
    const clock = new FakeClock(1_000);
    const c = db.orm.insert(containers).values({ kind: "standing", members: ["ceo", "owner"], defaultTo: "ceo", slackChannel: "C1" }).returning({ id: containers.id }).get();
    const a = appendMessage(db, clock, { containerId: c.id, author: "owner", to: "ceo", body: "1", kind: "say" });
    appendMessage(db, clock, { containerId: c.id, author: "ceo", to: "owner", body: "2", kind: "say" });
    const b = appendMessage(db, clock, { containerId: c.id, author: "owner", to: "ceo", body: "3", kind: "ask" });
    expect(pendingFor(db, "ceo").map((m) => m.id)).toEqual([a.messageId, b.messageId]);
    recordDelivery(db, 1, [a.messageId]);
    expect(pendingFor(db, "ceo").map((m) => m.id)).toEqual([b.messageId]);
    expect(() => recordDelivery(db, 2, [a.messageId])).toThrow();
    db.close();
  });

  it("a failed transaction leaves no message and no event behind", () => {
    const db = fresh();
    const clock = new FakeClock(1_000);
    expect(() => appendMessage(db, clock, { containerId: 999, author: "owner", to: "ceo", body: "x", kind: "say" })).toThrow();
    expect(db.orm.select().from(events).all()).toHaveLength(0);
    db.close();
  });
});
```

`tests/store/inbox.test.ts`:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeClock } from "../../src/ports/clock.js";
import { openDatabase } from "../../src/store/db.js";
import { recordInbound } from "../../src/store/inbox.js";

describe("inbox", () => {
  it("dedupes on event_id and on logical key within 24 hours", () => {
    const db = openDatabase(join(mkdtempSync(join(tmpdir(), "db-")), "a.db"));
    const clock = new FakeClock(10_000);
    expect(recordInbound(db, clock, { eventId: "Ev1", logicalKey: "C1:1.0", payload: {} }).inserted).toBe(true);
    expect(recordInbound(db, clock, { eventId: "Ev1", logicalKey: "C1:1.0", payload: {} }).inserted).toBe(false);
    expect(recordInbound(db, clock, { eventId: "Ev2", logicalKey: "C1:1.0", payload: {} }).inserted).toBe(false);
    clock.advance(86_400_001);
    expect(recordInbound(db, clock, { eventId: "Ev3", logicalKey: "C1:1.0", payload: {} }).inserted).toBe(true);
    db.close();
  });
});
```

- [ ] **Step 2: Run to see them fail**, then **Step 3: implement**

`src/store/events.ts`:

```ts
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

type Tx = BetterSQLite3Database<typeof schema>;

export function appendEvent(
  tx: Tx,
  e: { at: number; kind: string; agent?: string; payload: unknown; traceId?: string },
): number {
  return tx
    .insert(schema.events)
    .values({ at: e.at, kind: e.kind, agent: e.agent ?? null, payload: e.payload, traceId: e.traceId ?? null })
    .returning({ id: schema.events.id })
    .get().id;
}
```

`src/store/outbox.ts`:

```ts
import { and, asc, isNull, lte } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { Clock } from "../ports/clock.js";
import type { Db } from "./db.js";
import * as schema from "./schema.js";

type Tx = BetterSQLite3Database<typeof schema>;

export function enqueueOutbox(tx: Tx, clock: Clock, row: { kind: string; channel: string; payload: unknown }): number {
  const now = clock.now();
  return tx
    .insert(schema.outbox)
    .values({ kind: row.kind, channel: row.channel, payload: row.payload, nextAttemptAt: now, createdAt: now })
    .returning({ id: schema.outbox.id })
    .get().id;
}

export function nextOutbox(db: Db, now: number, limit: number) {
  return db.orm
    .select()
    .from(schema.outbox)
    .where(and(isNull(schema.outbox.doneAt), lte(schema.outbox.nextAttemptAt, now)))
    .orderBy(asc(schema.outbox.nextAttemptAt), asc(schema.outbox.id))
    .limit(limit)
    .all();
}
```

`src/store/messages.ts`:

```ts
import { and, asc, eq, notExists } from "drizzle-orm";
import type { Clock } from "../ports/clock.js";
import type { Db } from "./db.js";
import { appendEvent } from "./events.js";
import { enqueueOutbox } from "./outbox.js";
import * as schema from "./schema.js";

export type MessageKind = "say" | "ask" | "report" | "system";
export type Message = typeof schema.messages.$inferSelect;

export function appendMessage(
  db: Db,
  clock: Clock,
  m: { containerId: number; author: string; to: string; body: string; kind: MessageKind },
): { messageId: number; eventId: number } {
  return db.orm.transaction((tx) => {
    const container = tx.select().from(schema.containers).where(eq(schema.containers.id, m.containerId)).get();
    if (!container) throw new Error(`appendMessage: container ${m.containerId} does not exist`);
    const now = clock.now();
    const messageId = tx
      .insert(schema.messages)
      .values({ containerId: m.containerId, author: m.author, to: m.to, body: m.body, kind: m.kind, createdAt: now })
      .returning({ id: schema.messages.id })
      .get().id;
    const eventId = appendEvent(tx, { at: now, kind: "message.posted", agent: m.author, payload: { messageId, to: m.to, kind: m.kind } });
    enqueueOutbox(tx, clock, { kind: "mirror.message", channel: container.slackChannel ?? "", payload: { messageId } });
    return { messageId, eventId };
  });
}

export function pendingFor(db: Db, agent: string): Message[] {
  const delivered = db.orm
    .select({ id: schema.turnMessages.messageId })
    .from(schema.turnMessages)
    .where(eq(schema.turnMessages.messageId, schema.messages.id));
  return db.orm
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.to, agent), notExists(delivered)))
    .orderBy(asc(schema.messages.id))
    .all();
}

export function recordDelivery(db: Db, turnId: number, messageIds: number[]): void {
  if (messageIds.length === 0) return;
  db.orm.transaction((tx) => {
    tx.insert(schema.turnMessages).values(messageIds.map((messageId) => ({ turnId, messageId }))).run();
  });
}
```

`src/store/inbox.ts`:

```ts
import { and, eq, gte } from "drizzle-orm";
import type { Clock } from "../ports/clock.js";
import type { Db } from "./db.js";
import * as schema from "./schema.js";

const DAY = 86_400_000;

export function recordInbound(
  db: Db,
  clock: Clock,
  e: { eventId: string; logicalKey?: string; payload: unknown },
): { inserted: boolean; id: number } {
  return db.orm.transaction((tx) => {
    const now = clock.now();
    const byEvent = tx.select({ id: schema.inbox.id }).from(schema.inbox).where(eq(schema.inbox.eventId, e.eventId)).get();
    if (byEvent) return { inserted: false, id: byEvent.id };
    if (e.logicalKey) {
      const byKey = tx
        .select({ id: schema.inbox.id })
        .from(schema.inbox)
        .where(and(eq(schema.inbox.logicalKey, e.logicalKey), gte(schema.inbox.receivedAt, now - DAY)))
        .get();
      if (byKey) return { inserted: false, id: byKey.id };
    }
    const id = tx
      .insert(schema.inbox)
      .values({ eventId: e.eventId, logicalKey: e.logicalKey ?? null, payload: e.payload, receivedAt: now })
      .returning({ id: schema.inbox.id })
      .get().id;
    return { inserted: true, id };
  });
}
```

- [ ] **Step 4: Run the tests** — Expected: PASS (4 across the two files). If Drizzle's
  `notExists` needs the subquery built differently on the installed version, use
  `sql\`not exists (select 1 from turn_messages tm where tm.message_id = ${schema.messages.id})\``.

- [ ] **Step 5: Commit**

```bash
git add src/store/events.ts src/store/messages.ts src/store/outbox.ts src/store/inbox.ts tests/store/messages.test.ts tests/store/inbox.test.ts
git commit -m "feat(store): append message+event+outbox atomically; pending set; unique delivery; inbox dedup"
```

---

### Task 8: `agentopolis init` and the example home

**Files:**
- Create: `src/cli/main.ts`, `src/cli/init.ts`, `examples/home/` (config.yaml, STYLE.md,
  roles/ceo/{role.yaml,SOUL.md,JOB.md,PROTOCOL.md}, agents/ceo/agent.yaml,
  projects/agentopolis/project.yaml)
- Test: `tests/cli/init.test.ts`

**Interfaces:**
- Produces: `initHome(target: string): { snapshot: Snapshot; dbPath: string }` and the command
  `pnpm agentopolis init <dir>`; `examples/home/` is the seed every install starts from.

- [ ] **Step 1: Write `examples/home/`**

`config.yaml` as in the spec section 4 example (no `mcp_servers`, `owner_user_id: U0000000000`
as a visible placeholder the owner replaces; the loader accepts it because it matches the
pattern). `STYLE.md`:

```
Scrivi in italiano, dando del tu. Prima la decisione, poi il perché. Al massimo cinque righe.
Definisci un termine tecnico la prima volta che lo usi. Niente emoji da sole: emoji più parola.
Stati: 🟢 fatto · 🟡 in corso · 🔴 bloccato · ⏸️ in pausa · 💬 domanda · ✅ approvato · ⛔️ negato.
File, codice, commit e log in inglese.
```

`roles/ceo/role.yaml` as in Task 4's fixture (that fixture is a copy of this file). The three
prose files carry one honest line each, for example `SOUL.md`: `Prosa del ruolo: scritta nella
fetta 5 (roles and prose). Questa riga è il segnaposto voluto.` — the loader only requires the
files to exist.

`agents/ceo/agent.yaml`: `name: ceo`, `display: Ada · CEO`, `role: ceo`, `reports_to: owner`.
`projects/agentopolis/project.yaml` as in the spec, with `repo: /replace/me/agentopolis`.

- [ ] **Step 2: Write the failing test**

`tests/cli/init.test.ts`:

```ts
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initHome } from "../../src/cli/init.js";

describe("initHome", () => {
  it("creates a valid home from examples/home and opens its database", () => {
    const target = join(mkdtempSync(join(tmpdir(), "init-")), "home");
    const r = initHome(target);
    expect(r.snapshot.roles.has("ceo")).toBe(true);
    expect(existsSync(join(target, "data", "agentopolis.db"))).toBe(true);
    expect(existsSync(join(target, ".gitignore"))).toBe(true);
  });
  it("refuses a target that already exists", () => {
    const target = mkdtempSync(join(tmpdir(), "init-"));
    expect(() => initHome(target)).toThrow(/exists/);
  });
});
```

- [ ] **Step 3: Implement**

`src/cli/init.ts`:

```ts
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SnapshotHolder } from "../config/holder.js";
import type { Snapshot } from "../config/loader.js";
import { openDatabase } from "../store/db.js";

const EXAMPLE = fileURLToPath(new URL("../../examples/home/", import.meta.url));

export function initHome(target: string): { snapshot: Snapshot; dbPath: string } {
  if (existsSync(target)) throw new Error(`initHome: ${target} already exists`);
  cpSync(EXAMPLE, target, { recursive: true });
  mkdirSync(join(target, "data"), { recursive: true });
  mkdirSync(join(target, "runs"), { recursive: true });
  writeFileSync(join(target, ".gitignore"), "data/\nruns/\n");
  const holder = SnapshotHolder.open(target);
  const dbPath = join(target, "data", "agentopolis.db");
  openDatabase(dbPath).close();
  return { snapshot: holder.current, dbPath };
}
```

`src/cli/main.ts`:

```ts
import { initHome } from "./init.js";

const [command, ...args] = process.argv.slice(2);

if (command === "init" && args[0]) {
  const r = initHome(args[0]);
  console.log(`home created at ${args[0]} (config version ${r.snapshot.version.slice(0, 12)}), database at ${r.dbPath}`);
} else {
  console.error("usage: agentopolis init <dir>");
  process.exit(2);
}
```

- [ ] **Step 4: Run the tests and the command**

Run: `pnpm test && pnpm agentopolis init /tmp/agentopolis-home-$$ && pnpm typecheck && pnpm lint`
Expected: all tests pass; the command prints the created path; typecheck and lint clean.

- [ ] **Step 5: Commit**

```bash
git add src/cli/main.ts src/cli/init.ts examples/home tests/cli/init.test.ts
git commit -m "feat(cli): agentopolis init creates a valid home folder from examples/home"
```

---

### Task 9: report and PR

- [ ] **Step 1: Run the full gate one last time and capture the output**

Run: `pnpm test 2>&1 | tail -20 && pnpm typecheck && pnpm lint && pnpm ls --depth 0`

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin slice/01-store-and-loader
gh pr create --base master --title "Slice 1: store and loader" --body-file <tempfile>
```

The body follows the roadmap's report format: commands and output (test count, exit codes),
verified-by-running vs verified-by-reading, `NOTICED (not fixed)`, installed versions
(Node, pnpm, and every dependency), and any place where the installed library API differed
from this plan and what you did about it. End the body with:
`🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 3: Tell the owner** the PR number and the one-line summary; stop. The supervisor
  reviews; do not start slice 2.

## Self-review against the spec (done by the plan author)

- Section 4 layout, all four schemas, `STYLE.md`, `.retired/`, `STATE.md`: covered by Tasks 3–4
  and 8 (`STATE.md` and `.retired/` are written by slices 5–6; the loader ignores them).
- Section 5 tables, indexes, integer money/time, derived question hold: Tasks 6–7 (the hold is
  a query written in slice 4 over `messages`, no flag column exists).
- Section 3 loader behaviour (validation, last-good, secret rejection): Tasks 3–5; the chokidar
  watch and the `#ceo` message belong to slice 4 where the daemon process exists.
- Spec section 2 principle 1 (`synchronous=FULL`): Task 6.
- Not in this slice, by design: anything that spawns, mirrors or routes.

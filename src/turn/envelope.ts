// The turn's result is the message (spec section 6). The CLI returns this envelope, validated
// by the same JSON schema the daemon passes with --json-schema, and the daemon delivers it: no
// tool call is needed to speak, because every tool call is one more full-context API request.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { z } from "zod";
import type { Snapshot } from "../config/loader.js";
import type { Clock } from "../ports/clock.js";
import type { Db } from "../store/db.js";
import { appendEvent } from "../store/events.js";
import { appendMessageTx } from "../store/messages.js";
import * as schema from "../store/schema.js";

type Tx = BetterSQLite3Database<typeof schema>;

/** `system` is the daemon's kind alone: an agent may only say, ask or report. */
export const EnvelopeMessage = z.strictObject({
  container: z.string().min(1).describe("the container name exactly as your prompt showed it"),
  to: z.string().min(1).describe("one member of that container, or owner"),
  kind: z
    .enum(["say", "ask", "report"])
    .describe("say = information, ask = you need an answer, report = a deliverable"),
  body: z.string().min(1).describe("at most five lines; long deliverables are files"),
  tests_green: z
    .boolean()
    .optional()
    .describe("required on a report from a developer or a designer: did the tests pass?"),
});

export const Envelope = z.strictObject({
  messages: z.array(EnvelopeMessage).default([]),
  remember: z
    .array(z.string().min(1))
    .default([])
    .describe("lines to add to your MEMORY.md, standing agents only"),
  parked: z
    .array(z.strictObject({ title: z.string().min(1), why: z.string().min(1) }))
    .default([])
    .describe("what you found outside this task and did not do"),
});
export type Envelope = z.infer<typeof Envelope>;

/**
 * What goes on the command line with --json-schema: the structure only. It is derived from the
 * zod schema, so the two can never drift, and then stripped of $schema, descriptions, defaults
 * and minLength, which the CLI does not need in order to validate. The guidance those
 * descriptions carry reaches the model through the turn prompt instead, where it is
 * cache-stable and costs nothing per turn.
 *
 * The stripping is not only tidiness. On the owner's Mac, SentinelOne SIGKILLs any `node
 * <script>` spawned with an argument of roughly 1,000 characters or more [measured 2026-09-19:
 * 950 runs, 1,000 is killed, exit 137, reproduced outside this repository with a two-line
 * script]. The CLI is a node program, so the full 1,269-character schema killed every turn
 * before it emitted a line. ARGV_SAFE_LIMIT keeps us under that, and asserts it at load rather
 * than letting a future field be killed silently.
 */
const STRIPPED = new Set(["$schema", "description", "default", "minLength"]);

function structureOnly(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structureOnly);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !STRIPPED.has(key))
        .map(([key, v]) => [key, structureOnly(v)]),
    );
  }
  return value;
}

/** Below what this machine's endpoint agent kills; see the note above. */
export const ARGV_SAFE_LIMIT = 950;

export const ENVELOPE_JSON_SCHEMA: Record<string, unknown> = structureOnly(
  z.toJSONSchema(Envelope, { io: "input" }),
) as Record<string, unknown>;

const SCHEMA_ARG_LENGTH = JSON.stringify(ENVELOPE_JSON_SCHEMA).length;
if (SCHEMA_ARG_LENGTH > ARGV_SAFE_LIMIT) {
  throw new Error(
    `the envelope JSON schema is ${SCHEMA_ARG_LENGTH} characters on the command line, over the ` +
      `${ARGV_SAFE_LIMIT} an endpoint agent tolerates; shorten it or pass it another way`,
  );
}

export type ParseResult = { ok: true; envelope: Envelope } | { ok: false; error: string };

export function parseEnvelope(value: unknown): ParseResult {
  const parsed = Envelope.safeParse(value);
  if (parsed.success) return { ok: true, envelope: parsed.data };
  const error = parsed.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  return { ok: false, error };
}

export type RejectionScope = "message" | "remember" | "parked";
export type Rejection = { scope: RejectionScope; index: number; reason: string };
export type DeliveryResult = {
  messageIds: number[];
  /** addressees whose loop must be woken */
  wakes: string[];
  remembered: string[];
  parkedTaskIds: number[];
  rejected: Rejection[];
};

type Actor = { name: string; role: string; kind: "standing" | "job"; project: string | undefined };

/** A standing agent is a folder; a job agent is a row alone (spec section 4). */
function actorOf(db: Db, snapshot: Snapshot, name: string): Actor | undefined {
  const file = snapshot.agents.get(name);
  if (file) {
    const role = snapshot.roles.get(file.role);
    return {
      name,
      role: file.role,
      kind: role?.kind ?? "standing",
      project: file.project,
    };
  }
  const row = db.orm.select().from(schema.agents).where(eq(schema.agents.name, name)).get();
  if (!row) return undefined;
  return {
    name,
    role: row.role,
    kind: row.kind,
    project: row.project ?? undefined,
  };
}

/** The roles whose report the daemon reads for a test result (D3). */
const TESTED_ROLES = new Set(["developer", "designer"]);

type ContainerRow = typeof schema.containers.$inferSelect;

/** Why this message may not be delivered, or undefined when it may. */
function refuse(
  row: ContainerRow | undefined,
  agent: string,
  m: Envelope["messages"][number],
  authorRole: string,
): string | undefined {
  if (!row) return `unknown container "${m.container}"`;
  if (row.closedAt !== null) return `container "${m.container}" is closed`;
  if (!row.members.includes(agent)) return `"${agent}" is not a member of "${m.container}"`;
  if (!row.members.includes(m.to)) return `"${m.to}" is not a member of "${m.container}"`;
  if (m.to === agent) return "an agent may not address itself";
  if (m.kind === "report" && TESTED_ROLES.has(authorRole) && m.tests_green === undefined)
    return `a report from a ${authorRole} needs tests_green`;
  return undefined;
}

export function deliverEnvelope(
  db: Db,
  clock: Clock,
  snapshot: Snapshot,
  agent: string,
  envelope: Envelope,
): DeliveryResult {
  const result: DeliveryResult = {
    messageIds: [],
    wakes: [],
    remembered: [],
    parkedTaskIds: [],
    rejected: [],
  };

  return db.orm.transaction((tx) => {
    const reject = (scope: RejectionScope, index: number, reason: string) => {
      result.rejected.push({ scope, index, reason });
      appendEvent(tx, {
        at: clock.now(),
        kind: "envelope.rejected",
        agent,
        payload: { scope, index, reason },
      });
    };

    const author = actorOf(db, snapshot, agent);
    if (!author) {
      reject("message", 0, `unknown agent "${agent}": nothing in this envelope was delivered`);
      return result;
    }

    for (const [index, m] of envelope.messages.entries()) {
      const row = tx
        .select()
        .from(schema.containers)
        .where(eq(schema.containers.name, m.container))
        .get();
      const reason = refuse(row, agent, m, author.role);
      if (reason !== undefined) {
        reject("message", index, reason);
        continue;
      }
      if (!row) continue; // refuse() already said why; this narrows the type

      const { messageId } = appendMessageTx(tx, clock, {
        containerId: row.id,
        author: agent,
        to: m.to,
        body: m.body,
        kind: m.kind,
        testsGreen: m.tests_green,
      });
      result.messageIds.push(messageId);
      if (!result.wakes.includes(m.to)) result.wakes.push(m.to);

      // the most recent open ask from the addressee to this agent here is the one answered
      const openAsk = tx
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.containerId, row.id),
            eq(schema.messages.kind, "ask"),
            eq(schema.messages.author, m.to),
            eq(schema.messages.to, agent),
            isNull(schema.messages.answeredBy),
          ),
        )
        .orderBy(desc(schema.messages.id))
        .get();
      if (openAsk) {
        tx.update(schema.messages)
          .set({ answeredBy: messageId })
          .where(eq(schema.messages.id, openAsk.id))
          .run();
      }
    }

    if (envelope.remember.length > 0)
      rememberInto(tx, clock, snapshot, author, envelope, result, reject);

    for (const [index, p] of envelope.parked.entries()) {
      if (!author.project) {
        reject("parked", index, `"${agent}" has no project to park a discovery under`);
        continue;
      }
      const now = clock.now();
      const lead = snapshot.projects.get(author.project)?.lead ?? agent;
      const taskId = tx
        .insert(schema.tasks)
        .values({
          project: author.project,
          title: p.title,
          lead,
          status: "parked",
          openedAt: now,
        })
        .returning({ id: schema.tasks.id })
        .get().id;
      appendEvent(tx, {
        at: now,
        kind: "task.parked",
        agent,
        payload: { taskId, title: p.title, why: p.why, project: author.project },
      });
      result.parkedTaskIds.push(taskId);
    }

    return result;
  });
}

function rememberInto(
  tx: Tx,
  clock: Clock,
  snapshot: Snapshot,
  author: Actor,
  envelope: Envelope,
  result: DeliveryResult,
  reject: (scope: RejectionScope, index: number, reason: string) => void,
): void {
  if (author.kind !== "standing") {
    for (const index of envelope.remember.keys()) {
      reject("remember", index, `"${author.name}" is a job agent: only a standing agent remembers`);
    }
    return;
  }
  const file = join(snapshot.dir, "agents", author.name, "MEMORY.md");
  const previous = existsSync(file) ? readFileSync(file, "utf8") : "";
  const added = envelope.remember.map((line) => `- ${line}`).join("\n");
  const base = previous === "" ? "" : previous.endsWith("\n") ? previous : `${previous}\n`;
  writeFileSync(file, `${base}${added}\n`);
  result.remembered.push(...envelope.remember);
  appendEvent(tx, {
    at: clock.now(),
    kind: "memory.appended",
    agent: author.name,
    payload: { file, lines: envelope.remember, previous },
  });
}

// Assembling one turn's TurnSpec from the snapshot and the store (spec section 7).
// Two deliberate side effects, both of which must happen before the spawn: the session id is
// allocated and stored, and the system prompt is written to a file the CLI reads.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Role, Snapshot, SubagentDef } from "../config/loader.js";
import { buildMcpConfig } from "../engine/mcp-config.js";
import { composeSystemPrompt } from "../engine/prompt.js";
import { buildSettings } from "../engine/settings.js";
import { mcpServerCommand } from "../mcp/server-command.js";
import type { Clock } from "../ports/clock.js";
import type { Ids } from "../ports/ids.js";
import type { TurnSpec } from "../ports/runner.js";
import type { Db } from "../store/db.js";
import * as schema from "../store/schema.js";
import { ENVELOPE_JSON_SCHEMA } from "./envelope.js";

/** Fixed daemon constants: guards, not budgets, and nobody tunes them (spec section 7). */
export const MAX_TURNS = 60;
export const MAX_BUDGET_MICRO = 5_000_000;

export type BuildTurnSpecOptions = {
  turnId: number;
  /** the turn's user message, from buildTurnPrompt */
  prompt: string;
  runsDir: string;
  /** where the hook script lives, for the production-branch PreToolUse absolute */
  hookPath: string;
  /** an approved gated value for this turn, from the requests table (A3) */
  approvedResearch?: { model?: string; effort?: string } | undefined;
};

export type ResolvedRung = { model: string; effort: string | undefined };

/** agent row override → the task's rung (job agents) → the role default. */
export function resolveRung(
  role: Role,
  instanceModel: string | null | undefined,
  instanceEffort: string | null | undefined,
  taskRung: { model: string | null; effort: string | null } | undefined,
): ResolvedRung {
  const model = instanceModel ?? taskRung?.model ?? role.model;
  const effort = instanceEffort ?? taskRung?.effort ?? role.effort;
  return { model, effort: effort ?? undefined };
}

/** The --agents JSON the CLI takes: { name: { description, prompt, tools?, model? } }. */
export function buildAgentsJson(
  defs: Iterable<SubagentDef>,
  approvedResearch: { model?: string; effort?: string } | undefined,
): string | undefined {
  const out: Record<string, Record<string, unknown>> = {};
  for (const def of [...defs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const entry: Record<string, unknown> = { description: def.description, prompt: def.prompt };
    if (def.tools) entry.tools = def.tools;
    // a gated value reaches a subagent only for the turns an approved request covers (A3)
    const model = def.name === "research" ? (approvedResearch?.model ?? def.model) : def.model;
    if (model) entry.model = model;
    out[def.name] = entry;
  }
  return Object.keys(out).length === 0 ? undefined : JSON.stringify(out);
}

export function buildTurnSpec(
  snapshot: Snapshot,
  db: Db,
  clock: Clock,
  ids: Ids,
  agentName: string,
  opts: BuildTurnSpecOptions,
): TurnSpec {
  const row = db.orm.select().from(schema.agents).where(eq(schema.agents.name, agentName)).get();
  const file = snapshot.agents.get(agentName);
  const roleName = file?.role ?? row?.role;
  const role = roleName ? snapshot.roles.get(roleName) : undefined;
  if (!role) throw new Error(`buildTurnSpec: no role for agent "${agentName}"`);

  const task =
    row?.taskId != null
      ? db.orm.select().from(schema.tasks).where(eq(schema.tasks.id, row.taskId)).get()
      : undefined;
  const rung = resolveRung(
    role,
    file?.model ?? null,
    file?.effort ?? null,
    task ? { model: task.model, effort: task.effort } : undefined,
  );

  const projectSlug = file?.project ?? row?.project ?? undefined;
  const project = projectSlug ? snapshot.projects.get(projectSlug) : undefined;

  // the session id is allocated and stored before the spawn, so a crash cannot orphan a session
  let sessionId = row?.sessionId ?? file?.session_id ?? null;
  const resume = sessionId !== null;
  if (sessionId === null) {
    sessionId = ids.uuid();
    const now = clock.now();
    if (row) {
      db.orm
        .update(schema.agents)
        .set({ sessionId, sessionStartedAt: now })
        .where(eq(schema.agents.name, agentName))
        .run();
    } else {
      db.orm
        .insert(schema.agents)
        .values({
          name: agentName,
          role: role.name,
          display: file?.display ?? agentName,
          project: projectSlug ?? null,
          reportsTo: file?.reports_to ?? null,
          kind: role.kind,
          sessionId,
          sessionStartedAt: now,
        })
        .run();
    }
  }

  mkdirSync(opts.runsDir, { recursive: true });
  const systemPromptFile = join(opts.runsDir, `${opts.turnId}.system.md`);
  writeFileSync(systemPromptFile, composeSystemPrompt(snapshot.style, role));

  const extraArgs: string[] = [];
  const agentsJson = buildAgentsJson(role.subagentDefs.values(), opts.approvedResearch);
  if (agentsJson) extraArgs.push("--agents", agentsJson);
  extraArgs.push("--json-schema", JSON.stringify(ENVELOPE_JSON_SCHEMA));

  // a job agent works in its task's worktree; slice 6 creates it, until then the repo itself
  const cwd =
    role.kind === "job"
      ? (task?.worktree ?? project?.repo ?? snapshot.dir)
      : join(snapshot.dir, "agents", agentName);

  return {
    turnId: opts.turnId,
    agent: agentName,
    role,
    instance: file ?? rowAsInstance(agentName, role.name, row),
    project,
    cwd,
    sessionId,
    resume,
    systemPromptFile,
    prompt: opts.prompt,
    mcpConfig: JSON.parse(
      buildMcpConfig(role, snapshot.config.mcp_servers, mcpServerCommand()),
    ) as Record<string, unknown>,
    settings: buildSettings(
      role,
      project ? [project.branches.production] : undefined,
      opts.hookPath,
    ),
    model: rung.model,
    effort: rung.effort,
    maxTurns: MAX_TURNS,
    maxBudgetMicro: MAX_BUDGET_MICRO,
    wallClockMs: role.max_minutes * 60_000,
    env: {},
    extraArgs,
    configVersion: snapshot.version,
  };
}

type AgentRow = typeof schema.agents.$inferSelect;

/** A job agent has no agent.yaml; the runner only reads display, model and effort off it. */
function rowAsInstance(
  name: string,
  role: string,
  row: AgentRow | undefined,
): TurnSpec["instance"] {
  return {
    name,
    display: row?.display ?? name,
    role,
    reports_to: row?.reportsTo ?? "owner",
    model: null,
    effort: null,
    paused: row?.paused ?? false,
    session_id: row?.sessionId ?? null,
    session_started_at: row?.sessionStartedAt ?? null,
    ...(row?.project ? { project: row.project } : {}),
  };
}

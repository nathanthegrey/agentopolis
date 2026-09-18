import { z } from "zod";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase slug");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM");
const positive = z.number().positive();

export const RoleKind = z.enum(["standing", "job"]);
export const PermissionMode = z.enum(["default", "acceptEdits", "plan", "auto", "dontAsk"]);
export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export const RequestKind = z.enum([
  "open_task",
  "close_task",
  "hire",
  "retire",
  "pause",
  "set_budget",
  "merge_production",
  "run_schedule",
]);

export const RoleFile = z.strictObject({
  name: slug,
  description: z.string().min(1),
  kind: RoleKind,
  model: z.string().min(1),
  effort: Effort.optional(),
  tools: z
    .array(z.string().min(1))
    .default([])
    .transform((t) => (t.includes("agentopolis") ? t : ["agentopolis", ...t])),
  disallowed_tools: z.array(z.string().min(1)).default([]),
  permissions: z.strictObject({
    mode: PermissionMode,
    allow: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
    hooks: z.array(z.string()).default([]),
  }),
  budget: z.strictObject({ monthly_usd: positive, per_turn_usd: positive }),
  max_turns: z.number().int().positive(),
  max_wall_clock_minutes: z.number().int().positive(),
  talks_to: z.array(z.string().min(1)).min(1),
  requests: z.array(RequestKind).default([]),
});
export type RoleFile = z.infer<typeof RoleFile>;

export const AgentFile = z.strictObject({
  name: slug,
  display: z.string().min(1),
  avatar: z.url().optional(),
  role: slug,
  project: slug.optional(),
  reports_to: slug,
  model: z.string().min(1).nullable().default(null),
  effort: Effort.nullable().default(null),
  budget_monthly_usd: positive.nullable().default(null),
  paused: z.boolean().default(false),
  session_id: z.uuid().nullable().default(null),
  session_started_at: z.number().int().nullable().default(null),
});
export type AgentFile = z.infer<typeof AgentFile>;

export const ProjectFile = z
  .strictObject({
    slug,
    name: z.string().min(1),
    repo: z.string().min(1),
    branches: z.strictObject({ work: z.string().min(1), production: z.string().min(1) }),
    lead: slug,
  })
  .refine((p) => p.branches.work !== p.branches.production, {
    message: "work and production branches must differ",
    path: ["branches"],
  });
export type ProjectFile = z.infer<typeof ProjectFile>;

export const McpServerDef = z.strictObject({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
});

export const ConfigFile = z.strictObject({
  slack: z.strictObject({
    bot_token_env: z.string().min(1),
    app_token_env: z.string().min(1),
    owner_user_id: z.string().regex(/^[UW][A-Z0-9]+$/),
    work_channel_suffix: z.string().default("-work"),
  }),
  language: z.enum(["it", "en"]).default("it"),
  budgets: z.strictObject({ company_monthly_usd: positive }),
  approvals: z.strictObject({ timeout_hours: positive }),
  daily_digest_at: hhmm.optional(),
  /** display names for job agents, round robin (spec section 4) */
  job_names: z.array(z.string().min(1)).default([]),
  max_concurrent_turns: z.number().int().positive().default(3),
  mcp_servers: z.record(z.string(), McpServerDef).default({}),
});
export type ConfigFile = z.infer<typeof ConfigFile>;

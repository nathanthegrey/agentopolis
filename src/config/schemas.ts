import { z } from "zod";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase slug");
const positive = z.number().positive();
const positiveInt = z.number().int().positive();

export const RoleKind = z.enum(["standing", "job"]);
export const PermissionMode = z.enum(["default", "acceptEdits", "plan", "auto", "dontAsk"]);
/** The CLI's levels. `xhigh` is never configured here (owner, 2026-09-19): see ConfiguredEffort. */
export const Effort = z.enum(["low", "medium", "high", "xhigh", "max"]);
/** What a role or a menu may name: the owner ruled out xhigh everywhere. */
export const ConfiguredEffort = z.enum(["low", "medium", "high"]);
/** The three kinds an agent may request in v1 (spec section 8); the rest are owner actions. */
export const RequestKind = z.enum(["open_task", "close_task", "merge_production"]);

export const RoleFile = z.strictObject({
  name: slug,
  description: z.string().min(1),
  kind: RoleKind,
  model: z.string().min(1),
  effort: ConfiguredEffort.optional(),
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
  /** Job roles only: what the lead may pick at open_task; the daemon refuses the rest. */
  menu: z
    .strictObject({
      models: z.array(z.string().min(1)).min(1),
      efforts: z.array(ConfiguredEffort).min(1),
    })
    .optional(),
  /** Names under roles/<role>/subagents/*.md, passed to the CLI with --agents. */
  subagents: z.array(slug).default([]),
  /** The wall-clock watchdog: the one guard a role configures (spec section 4). */
  max_minutes: positiveInt.default(45),
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
  /** standing agents name their Slack app (a key of config.slack.apps); the ceo uses "company" */
  slack_app: slug.optional(),
  model: z.string().min(1).nullable().default(null),
  effort: ConfiguredEffort.nullable().default(null),
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
    owner_user_id: z.string().regex(/^[UW][A-Z0-9]+$/),
    work_channel_suffix: z.string().default("-work"),
    /** one Socket Mode app each; "company" is the ceo and owns commands, Home and cards */
    apps: z
      .record(
        slug,
        z.strictObject({ bot_token_env: z.string().min(1), app_token_env: z.string().min(1) }),
      )
      .refine((apps) => "company" in apps, { message: 'slack.apps must include "company"' }),
  }),
  language: z.enum(["it", "en"]).default("it"),
  approvals: z.strictObject({ timeout_hours: positive }),
  /** Hold a parked can_use_tool open this long with its card already up, then park it (D1). */
  permission_hold_minutes: positive.default(5),
  /** Values an agent may not be spawned with until the owner presses Approva (A3). */
  gated: z
    .strictObject({
      models: z.array(z.string().min(1)).default(["fable"]),
      research: z
        .strictObject({
          models: z.array(z.string().min(1)).default(["opus", "fable"]),
          effort: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),
  /** What bounds an agent ⇄ agent exchange inside one task (A5). */
  loop_guard: z
    .strictObject({
      messages: positiveInt.default(12),
      review_rejections: positiveInt.default(3),
    })
    .prefault({}),
  /** display names for job agents, round robin (spec section 4) */
  job_names: z.array(z.string().min(1)).default([]),
  max_concurrent_turns: positiveInt.default(3),
  mcp_servers: z.record(z.string(), McpServerDef).default({}),
});
export type ConfigFile = z.infer<typeof ConfigFile>;

import { desc, sql } from "drizzle-orm";
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
  /** dm: an app's direct message with the owner; standing: a project channel; task: a thread */
  kind: text("kind", { enum: ["dm", "standing", "task"] }).notNull(),
  /** the Slack channel name as created or adopted ("agentopolis-hq"), or "dm:<agent>" */
  name: text("name"),
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
    containerId: integer("container_id")
      .notNull()
      .references(() => containers.id),
    author: text("author").notNull(),
    to: text("to").notNull(),
    body: text("body").notNull(),
    kind: text("kind", { enum: ["say", "ask", "report", "system"] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("messages_to_id").on(t.to, t.id),
    index("messages_container_id").on(t.containerId, t.id),
  ],
);

export const turnMessages = sqliteTable(
  "turn_messages",
  {
    turnId: integer("turn_id").notNull(),
    messageId: integer("message_id")
      .notNull()
      .references(() => messages.id),
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
      enum: [
        "running",
        "ok",
        "failed",
        "interrupted",
        "timed_out",
        "cancelled",
        "budget_exhausted",
        "max_turns",
      ],
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
  (t) => [index("turns_agent_started").on(t.agent, desc(t.startedAt))],
);

export const requests = sqliteTable(
  "requests",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    agent: text("agent").notNull(),
    kind: text("kind").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    status: text("status", {
      enum: ["pending", "approved", "denied", "expired", "done", "snoozed"],
    }).notNull(),
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
  scope: text("scope", { enum: ["once", "task"] })
    .notNull()
    .default("once"),
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
  (t) => [index("outbox_next_attempt").on(t.nextAttemptAt).where(sql`done_at is null`)],
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
  (t) => [
    uniqueIndex("inbox_event_unique").on(t.eventId),
    index("inbox_logical_key").on(t.logicalKey),
  ],
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

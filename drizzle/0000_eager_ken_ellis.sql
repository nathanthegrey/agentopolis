CREATE TABLE `agents` (
	`name` text PRIMARY KEY NOT NULL,
	`session_id` text,
	`session_started_at` integer,
	`paused` integer DEFAULT false NOT NULL,
	`owner_host` text,
	`lease_until` integer
);
--> statement-breakpoint
CREATE TABLE `containers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`members` text NOT NULL,
	`default_to` text NOT NULL,
	`task_id` integer,
	`slack_channel` text,
	`slack_thread_ts` text,
	`closed_at` integer
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`agent` text,
	`payload` text NOT NULL,
	`trace_id` text
);
--> statement-breakpoint
CREATE TABLE `inbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` text NOT NULL,
	`logical_key` text,
	`payload` text NOT NULL,
	`received_at` integer NOT NULL,
	`processed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inbox_event_unique` ON `inbox` (`event_id`);--> statement-breakpoint
CREATE INDEX `inbox_logical_key` ON `inbox` (`logical_key`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`container_id` integer NOT NULL,
	`author` text NOT NULL,
	`to` text NOT NULL,
	`body` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`container_id`) REFERENCES `containers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `messages_to_id` ON `messages` (`to`,`id`);--> statement-breakpoint
CREATE INDEX `messages_container_id` ON `messages` (`container_id`,`id`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`channel` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`done_at` integer,
	`slack_ts` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `outbox_next_attempt` ON `outbox` (`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `permission_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`turn_id` integer NOT NULL,
	`tool_use_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`input` text NOT NULL,
	`scope` text DEFAULT 'once' NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE TABLE `renders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`result` text,
	`epoch` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `requests_status_created` ON `requests` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent` text NOT NULL,
	`cron` text NOT NULL,
	`prompt` text NOT NULL,
	`last_fired` integer
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project` text NOT NULL,
	`title` text NOT NULL,
	`lead` text NOT NULL,
	`status` text NOT NULL,
	`worktree` text,
	`slack_thread_ts` text,
	`opened_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE TABLE `turn_messages` (
	`turn_id` integer NOT NULL,
	`message_id` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_messages_message_unique` ON `turn_messages` (`message_id`);--> statement-breakpoint
CREATE TABLE `turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`agent` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`status` text NOT NULL,
	`session_id` text NOT NULL,
	`pid` integer,
	`trace_id` text,
	`config_version` text NOT NULL,
	`cost_microusd` integer,
	`cost_basis` text,
	`model_usage` text,
	`cache_read` integer,
	`cache_creation` integer,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `turns_agent_started` ON `turns` (`agent`,`started_at`);
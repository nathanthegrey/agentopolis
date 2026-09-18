DROP INDEX `outbox_next_attempt`;--> statement-breakpoint
CREATE INDEX `outbox_next_attempt` ON `outbox` (`next_attempt_at`) WHERE done_at is null;--> statement-breakpoint
DROP INDEX `turns_agent_started`;--> statement-breakpoint
CREATE INDEX `turns_agent_started` ON `turns` (`agent`,"started_at" desc);
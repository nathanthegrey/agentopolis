ALTER TABLE `agents` ADD `role` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `display` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `project` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `reports_to` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `kind` text DEFAULT 'standing' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `task_id` integer;--> statement-breakpoint
ALTER TABLE `agents` ADD `retired_at` integer;
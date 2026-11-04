CREATE TABLE `artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`created_by` text NOT NULL,
	`session_id` text,
	`doc` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_artifacts_updated` ON `artifacts` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_artifacts_session` ON `artifacts` (`session_id`);
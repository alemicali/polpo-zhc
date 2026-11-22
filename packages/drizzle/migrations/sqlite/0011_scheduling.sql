CREATE TABLE `leases` (
	`key` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_leases_expires` ON `leases` (`expires_at`);--> statement-breakpoint
CREATE TABLE `schedules` (
	`mission_id` text PRIMARY KEY NOT NULL,
	`doc` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_watchers` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`doc` text NOT NULL,
	`created_at` text NOT NULL
);

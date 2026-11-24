CREATE TABLE `agent_deploys` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_name` text NOT NULL,
	`pointer` text NOT NULL,
	`from_version` text,
	`to_version` text NOT NULL,
	`action` text NOT NULL,
	`actor` text NOT NULL,
	`note` text,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agent_deploys_agent_at` ON `agent_deploys` (`agent_name`,`at`);--> statement-breakpoint
CREATE TABLE `agent_drafts` (
	`agent_name` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_pointers` (
	`agent_name` text NOT NULL,
	`pointer` text NOT NULL,
	`version` text NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	PRIMARY KEY(`agent_name`, `pointer`)
);
--> statement-breakpoint
CREATE TABLE `agent_versions` (
	`agent_name` text NOT NULL,
	`version` text NOT NULL,
	`data` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`agent_name`, `version`)
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `agent_version` text;
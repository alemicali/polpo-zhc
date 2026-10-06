CREATE TABLE `brain_items` (
	`kind` text NOT NULL,
	`id` text NOT NULL,
	`seq` integer NOT NULL,
	`doc` text NOT NULL,
	PRIMARY KEY(`kind`, `id`)
);
--> statement-breakpoint
CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`doc` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_apps_slug` ON `apps` (`slug`);--> statement-breakpoint
CREATE TABLE `context_checkpoints` (
	`session_id` text PRIMARY KEY NOT NULL,
	`revision` text NOT NULL,
	`checkpoint` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `data_activity` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`doc` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_data_activity_created_at` ON `data_activity` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_data_activity_source` ON `data_activity` (`source_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `data_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`doc` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_data_sources_slug` ON `data_sources` (`slug`);--> statement-breakpoint
CREATE TABLE `data_views` (
	`id` text PRIMARY KEY NOT NULL,
	`doc` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_data_views_updated_at` ON `data_views` (`updated_at`);--> statement-breakpoint
CREATE TABLE `token_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` text NOT NULL,
	`source` text NOT NULL,
	`provider` text,
	`model` text,
	`session_id` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`cost` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_token_usage_timestamp` ON `token_usage` (`timestamp`);--> statement-breakpoint
CREATE TABLE `whatsapp_contacts` (
	`jid` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`phone` text NOT NULL,
	`last_seen` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_whatsapp_contacts_phone` ON `whatsapp_contacts` (`phone`);--> statement-breakpoint
CREATE INDEX `idx_whatsapp_contacts_last_seen` ON `whatsapp_contacts` (`last_seen`);--> statement-breakpoint
CREATE TABLE `whatsapp_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`chat_jid` text NOT NULL,
	`sender_jid` text NOT NULL,
	`sender_name` text,
	`text` text NOT NULL,
	`from_me` integer DEFAULT false NOT NULL,
	`timestamp` integer NOT NULL,
	`media_type` text,
	`media_path` text,
	`mime_type` text,
	`file_name` text,
	`media_size` integer,
	`read_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_whatsapp_messages_chat` ON `whatsapp_messages` (`chat_jid`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_whatsapp_messages_ts` ON `whatsapp_messages` (`timestamp`);
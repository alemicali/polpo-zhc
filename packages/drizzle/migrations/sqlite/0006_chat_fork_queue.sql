CREATE TABLE `chat_queue_items` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`content` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` text NOT NULL,
	`steer_id` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_chat_queue_items_session` ON `chat_queue_items` (`session_id`,`position`);--> statement-breakpoint
CREATE TABLE `chat_queue_settings` (
	`session_id` text PRIMARY KEY NOT NULL,
	`auto_send` integer NOT NULL,
	`hold` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `parent_session_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `fork_message_id` text;--> statement-breakpoint
CREATE INDEX `idx_sessions_parent` ON `sessions` (`parent_session_id`);
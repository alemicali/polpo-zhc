CREATE TABLE `room_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`seq` integer NOT NULL,
	`ts` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_id` text NOT NULL,
	`author_name` text NOT NULL,
	`text` text NOT NULL,
	`external_id` text,
	`addressed_to` text,
	`reply_to_id` text,
	FOREIGN KEY (`room_id`) REFERENCES `rooms`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_room_messages_room` ON `room_messages` (`room_id`,`seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_room_messages_external` ON `room_messages` (`room_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`agents` text NOT NULL,
	`settings` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_rooms_kind` ON `rooms` (`kind`,`updated_at`);
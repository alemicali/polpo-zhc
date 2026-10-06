CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`gate_id` text NOT NULL,
	`gate_name` text NOT NULL,
	`task_id` text,
	`mission_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`payload` text,
	`requested_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	`note` text
);
--> statement-breakpoint
CREATE INDEX `idx_approvals_status` ON `approvals` (`status`);--> statement-breakpoint
CREATE INDEX `idx_approvals_task_id` ON `approvals` (`task_id`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`message_id` text,
	`filename` text NOT NULL,
	`mime_type` text NOT NULL,
	`size` integer NOT NULL,
	`path` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_attachments_session_id` ON `attachments` (`session_id`);--> statement-breakpoint
CREATE TABLE `coding_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	`initialized` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `expo_tokens` (
	`token` text PRIMARY KEY NOT NULL,
	`platform` text NOT NULL,
	`device_id` text NOT NULL,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`disabled` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_expo_tokens_device_id` ON `expo_tokens` (`device_id`);--> statement-breakpoint
CREATE TABLE `agent_checkpoints` (
	`task_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`messages` text DEFAULT '[]' NOT NULL,
	`saved_at` text NOT NULL,
	`turn_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`name` text PRIMARY KEY NOT NULL,
	`team_name` text NOT NULL,
	`config` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_agents_team_name` ON `agents` (`team_name`);--> statement-breakpoint
CREATE TABLE `background_waits` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`session_id` text NOT NULL,
	`target_status` text,
	`state` text DEFAULT 'waiting' NOT NULL,
	`last_task_status` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`triggered_at` text,
	`completed_at` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_background_waits_session_state` ON `background_waits` (`session_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_background_waits_task_state` ON `background_waits` (`task_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_background_waits_state` ON `background_waits` (`state`);--> statement-breakpoint
CREATE TABLE `log_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`ts` text NOT NULL,
	`event` text NOT NULL,
	`data` text,
	FOREIGN KEY (`session_id`) REFERENCES `log_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_log_entries_session` ON `log_entries` (`session_id`);--> statement-breakpoint
CREATE INDEX `idx_log_entries_ts` ON `log_entries` (`ts`);--> statement-breakpoint
CREATE TABLE `log_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_log_sessions_started_at` ON `log_sessions` (`started_at`);--> statement-breakpoint
CREATE TABLE `memory` (
	`key` text PRIMARY KEY NOT NULL,
	`content` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`ts` text NOT NULL,
	`tool_calls` text,
	`segments` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_messages_session` ON `messages` (`session_id`,`ts`);--> statement-breakpoint
CREATE TABLE `metadata` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `missions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`data` text NOT NULL,
	`prompt` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`schedule` text,
	`end_date` text,
	`quality_threshold` text,
	`deadline` text,
	`notifications` text,
	`execution_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `missions_name_unique` ON `missions` (`name`);--> statement-breakpoint
CREATE INDEX `idx_missions_status` ON `missions` (`status`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` text NOT NULL,
	`rule_id` text NOT NULL,
	`rule_name` text NOT NULL,
	`channel` text NOT NULL,
	`channel_type` text NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`severity` text NOT NULL,
	`source_event` text NOT NULL,
	`attachment_count` integer DEFAULT 0 NOT NULL,
	`attachment_types` text
);
--> statement-breakpoint
CREATE INDEX `idx_notifications_timestamp` ON `notifications` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_notifications_status` ON `notifications` (`status`);--> statement-breakpoint
CREATE INDEX `idx_notifications_channel` ON `notifications` (`channel`);--> statement-breakpoint
CREATE INDEX `idx_notifications_rule_id` ON `notifications` (`rule_id`);--> statement-breakpoint
CREATE TABLE `pairing_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`peer_id` text NOT NULL,
	`channel` text NOT NULL,
	`external_id` text NOT NULL,
	`display_name` text,
	`code` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`resolved` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pairing_requests_code_unique` ON `pairing_requests` (`code`);--> statement-breakpoint
CREATE INDEX `idx_pairing_code` ON `pairing_requests` (`code`);--> statement-breakpoint
CREATE INDEX `idx_pairing_peer` ON `pairing_requests` (`peer_id`);--> statement-breakpoint
CREATE TABLE `peer_allowlist` (
	`peer_id` text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE `peer_sessions` (
	`peer_id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_peer_sessions_session_id` ON `peer_sessions` (`session_id`);--> statement-breakpoint
CREATE TABLE `peers` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`external_id` text NOT NULL,
	`display_name` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`linked_to` text
);
--> statement-breakpoint
CREATE INDEX `idx_peers_channel` ON `peers` (`channel`);--> statement-breakpoint
CREATE INDEX `idx_peers_external_id` ON `peers` (`external_id`);--> statement-breakpoint
CREATE TABLE `playbooks` (
	`name` text PRIMARY KEY NOT NULL,
	`description` text NOT NULL,
	`mission` text NOT NULL,
	`parameters` text,
	`version` text,
	`author` text,
	`tags` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `processes` (
	`agent_name` text NOT NULL,
	`pid` integer NOT NULL,
	`task_id` text NOT NULL,
	`started_at` text NOT NULL,
	`alive` integer DEFAULT 1 NOT NULL,
	`activity` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_processes_task_id` ON `processes` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_processes_agent_name` ON `processes` (`agent_name`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`endpoint` text PRIMARY KEY NOT NULL,
	`expiration_time` integer,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`user_agent` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_success_at` text,
	`last_failure_at` text,
	`failure_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_vapid` (
	`id` integer PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	`subject` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`pid` integer DEFAULT 0 NOT NULL,
	`agent_name` text NOT NULL,
	`adapter_type` text NOT NULL,
	`session_id` text,
	`status` text DEFAULT 'running' NOT NULL,
	`started_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`activity` text DEFAULT '{}' NOT NULL,
	`result` text,
	`outcomes` text,
	`config` text,
	`config_path` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_runs_status` ON `runs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_runs_task_id` ON `runs` (`task_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`agent` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`starred` integer
);
--> statement-breakpoint
CREATE INDEX `idx_sessions_agent` ON `sessions` (`agent`);--> statement-breakpoint
CREATE INDEX `idx_sessions_updated_at` ON `sessions` (`updated_at`);--> statement-breakpoint
CREATE TABLE `task_directions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`run_id` text,
	`mode` text NOT NULL,
	`message` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`created_at` text NOT NULL,
	`delivered_at` text,
	`applied_at` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `idx_task_directions_task` ON `task_directions` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_task_directions_run_status` ON `task_directions` (`run_id`,`status`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`assign_to` text NOT NULL,
	`group` text,
	`mission_id` text,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`retries` integer DEFAULT 0 NOT NULL,
	`max_retries` integer DEFAULT 2 NOT NULL,
	`max_duration` integer,
	`retry_policy` text,
	`expectations` text DEFAULT '[]' NOT NULL,
	`metrics` text DEFAULT '[]' NOT NULL,
	`result` text,
	`phase` text,
	`fix_attempts` integer DEFAULT 0 NOT NULL,
	`resolution_attempts` integer DEFAULT 0 NOT NULL,
	`original_description` text,
	`session_id` text,
	`notifications` text,
	`outcomes` text,
	`expected_outcomes` text,
	`deadline` text,
	`priority` text,
	`side_effects` integer,
	`revision_count` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_group` ON `tasks` (`group`);--> statement-breakpoint
CREATE INDEX `idx_tasks_assign_to` ON `tasks` (`assign_to`);--> statement-breakpoint
CREATE INDEX `idx_tasks_mission_id` ON `tasks` (`mission_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_updated_at` ON `tasks` (`updated_at`);--> statement-breakpoint
CREATE TABLE `teams` (
	`name` text PRIMARY KEY NOT NULL,
	`description` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vault` (
	`agent` text NOT NULL,
	`service` text NOT NULL,
	`type` text NOT NULL,
	`label` text,
	`account` text,
	`allowed_agents` text,
	`credentials` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`agent`, `service`)
);
--> statement-breakpoint
CREATE INDEX `idx_vault_agent` ON `vault` (`agent`);
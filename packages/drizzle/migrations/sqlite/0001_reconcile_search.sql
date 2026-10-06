-- Databases created before versioned migrations (ensureSqliteSchema) are stamped at the baseline;
-- this migration then brings their indexes in line with the schema. It is a no-op on new databases.
CREATE INDEX IF NOT EXISTS `idx_approvals_status` ON `approvals` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_approvals_task_id` ON `approvals` (`task_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_attachments_session_id` ON `attachments` (`session_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_expo_tokens_device_id` ON `expo_tokens` (`device_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_agents_team_name` ON `agents` (`team_name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_background_waits_session_state` ON `background_waits` (`session_id`,`state`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_background_waits_task_state` ON `background_waits` (`task_id`,`state`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_background_waits_state` ON `background_waits` (`state`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_log_entries_session` ON `log_entries` (`session_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_log_entries_ts` ON `log_entries` (`ts`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_log_sessions_started_at` ON `log_sessions` (`started_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_messages_session` ON `messages` (`session_id`,`ts`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `missions_name_unique` ON `missions` (`name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_missions_status` ON `missions` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_notifications_timestamp` ON `notifications` (`timestamp`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_notifications_status` ON `notifications` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_notifications_channel` ON `notifications` (`channel`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_notifications_rule_id` ON `notifications` (`rule_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `pairing_requests_code_unique` ON `pairing_requests` (`code`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_pairing_code` ON `pairing_requests` (`code`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_pairing_peer` ON `pairing_requests` (`peer_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_peer_sessions_session_id` ON `peer_sessions` (`session_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_peers_channel` ON `peers` (`channel`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_peers_external_id` ON `peers` (`external_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_processes_task_id` ON `processes` (`task_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_processes_agent_name` ON `processes` (`agent_name`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_status` ON `runs` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_runs_task_id` ON `runs` (`task_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sessions_agent` ON `sessions` (`agent`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_sessions_updated_at` ON `sessions` (`updated_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_task_directions_task` ON `task_directions` (`task_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_task_directions_run_status` ON `task_directions` (`run_id`,`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_status` ON `tasks` (`status`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_group` ON `tasks` (`group`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_assign_to` ON `tasks` (`assign_to`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_mission_id` ON `tasks` (`mission_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_updated_at` ON `tasks` (`updated_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_vault_agent` ON `vault` (`agent`);
--> statement-breakpoint
-- Redundant legacy indexes (covered by composite indexes): one less write per row.
DROP INDEX IF EXISTS `idx_log_entries_session_id`;
--> statement-breakpoint
DROP INDEX IF EXISTS `idx_messages_session_id`;
--> statement-breakpoint
-- Full-text search on tasks (FTS5, external content).
CREATE VIRTUAL TABLE IF NOT EXISTS `tasks_fts` USING fts5(title, description, content='tasks', content_rowid='rowid');
--> statement-breakpoint
INSERT INTO `tasks_fts`(rowid, title, description) SELECT rowid, title, description FROM `tasks` WHERE rowid NOT IN (SELECT rowid FROM `tasks_fts`);
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_fts_insert`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_fts_delete`;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `tasks_fts_update`;
--> statement-breakpoint
CREATE TRIGGER `tasks_fts_insert` AFTER INSERT ON `tasks` BEGIN INSERT INTO `tasks_fts`(rowid, title, description) VALUES (new.rowid, new.title, new.description); END;
--> statement-breakpoint
CREATE TRIGGER `tasks_fts_delete` AFTER DELETE ON `tasks` BEGIN INSERT INTO `tasks_fts`(`tasks_fts`, rowid, title, description) VALUES ('delete', old.rowid, old.title, old.description); END;
--> statement-breakpoint
-- Only when the indexed text changes: status updates no longer rewrite the index.
CREATE TRIGGER `tasks_fts_update` AFTER UPDATE OF title, description ON `tasks` BEGIN INSERT INTO `tasks_fts`(`tasks_fts`, rowid, title, description) VALUES ('delete', old.rowid, old.title, old.description); INSERT INTO `tasks_fts`(rowid, title, description) VALUES (new.rowid, new.title, new.description); END;

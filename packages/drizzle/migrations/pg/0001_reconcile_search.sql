-- Databases created before versioned migrations (ensurePgSchema) are stamped at the baseline;
-- this migration then brings their indexes in line with the schema. It is a no-op on new databases.
CREATE INDEX IF NOT EXISTS "idx_pg_approvals_status" ON "approvals" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_approvals_task_id" ON "approvals" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_attachments_session_id" ON "attachments" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_expo_tokens_device_id" ON "expo_tokens" USING btree ("device_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_agents_team_name" ON "agents" USING btree ("team_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_background_waits_session_state" ON "background_waits" USING btree ("session_id","state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_background_waits_task_state" ON "background_waits" USING btree ("task_id","state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_background_waits_state" ON "background_waits" USING btree ("state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_log_entries_session" ON "log_entries" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_log_entries_ts" ON "log_entries" USING btree ("ts");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_log_sessions_started_at" ON "log_sessions" USING btree ("started_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_messages_session" ON "messages" USING btree ("session_id","ts");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_missions_status" ON "missions" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_notifications_timestamp" ON "notifications" USING btree ("timestamp");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_notifications_status" ON "notifications" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_notifications_channel" ON "notifications" USING btree ("channel");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_notifications_rule_id" ON "notifications" USING btree ("rule_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_pairing_code" ON "pairing_requests" USING btree ("code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_pairing_peer" ON "pairing_requests" USING btree ("peer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_peer_sessions_session_id" ON "peer_sessions" USING btree ("session_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_peers_channel" ON "peers" USING btree ("channel");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_peers_external_id" ON "peers" USING btree ("external_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_processes_task_id" ON "processes" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_processes_agent_name" ON "processes" USING btree ("agent_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_runs_status" ON "runs" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_runs_task_id" ON "runs" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_sessions_agent" ON "sessions" USING btree ("agent");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_sessions_updated_at" ON "sessions" USING btree ("updated_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_task_directions_task" ON "task_directions" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_task_directions_run_status" ON "task_directions" USING btree ("run_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_tasks_status" ON "tasks" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_tasks_group" ON "tasks" USING btree ("group");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_tasks_assign_to" ON "tasks" USING btree ("assign_to");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_tasks_mission_id" ON "tasks" USING btree ("mission_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_tasks_updated_at" ON "tasks" USING btree ("updated_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_vault_agent" ON "vault" USING btree ("agent");
--> statement-breakpoint
-- Full-text search on tasks (title weighs more than description); language-agnostic so it works
-- for Italian and English alike.
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "search" tsvector GENERATED ALWAYS AS (setweight(to_tsvector('simple', coalesce("title", '')), 'A') || setweight(to_tsvector('simple', coalesce("description", '')), 'B')) STORED;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pg_tasks_search" ON "tasks" USING gin ("search");

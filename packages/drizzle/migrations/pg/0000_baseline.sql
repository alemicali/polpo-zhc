CREATE TABLE "approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"gate_id" text NOT NULL,
	"gate_name" text NOT NULL,
	"task_id" text,
	"mission_id" text,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"payload" jsonb,
	"requested_at" text NOT NULL,
	"resolved_at" text,
	"resolved_by" text,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"path" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "coding_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"state" jsonb NOT NULL,
	"initialized" boolean DEFAULT false NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "expo_tokens" (
	"token" text PRIMARY KEY NOT NULL,
	"platform" text NOT NULL,
	"device_id" text NOT NULL,
	"created_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"failure_count" integer DEFAULT 0 NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_checkpoints" (
	"task_id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"saved_at" text NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"name" text PRIMARY KEY NOT NULL,
	"team_name" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "background_waits" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"session_id" text NOT NULL,
	"target_status" text,
	"state" varchar(32) DEFAULT 'waiting' NOT NULL,
	"last_task_status" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"triggered_at" text,
	"completed_at" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "log_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"ts" text NOT NULL,
	"event" text NOT NULL,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "log_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"started_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memory" (
	"key" text PRIMARY KEY NOT NULL,
	"content" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"ts" text NOT NULL,
	"tool_calls" text,
	"segments" text
);
--> statement-breakpoint
CREATE TABLE "metadata" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"data" text NOT NULL,
	"prompt" text,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"schedule" text,
	"end_date" text,
	"quality_threshold" text,
	"deadline" text,
	"notifications" jsonb,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "missions_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" text NOT NULL,
	"rule_id" text NOT NULL,
	"rule_name" text NOT NULL,
	"channel" text NOT NULL,
	"channel_type" text NOT NULL,
	"status" varchar(32) NOT NULL,
	"error" text,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"severity" varchar(16) NOT NULL,
	"source_event" text NOT NULL,
	"attachment_count" integer DEFAULT 0 NOT NULL,
	"attachment_types" jsonb
);
--> statement-breakpoint
CREATE TABLE "pairing_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"peer_id" text NOT NULL,
	"channel" varchar(32) NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"code" text NOT NULL,
	"created_at" text NOT NULL,
	"expires_at" text NOT NULL,
	"resolved" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "pairing_requests_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "peer_allowlist" (
	"peer_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "peer_sessions" (
	"peer_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "peers" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" varchar(32) NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"first_seen_at" text NOT NULL,
	"last_seen_at" text NOT NULL,
	"linked_to" text
);
--> statement-breakpoint
CREATE TABLE "playbooks" (
	"name" text PRIMARY KEY NOT NULL,
	"description" text NOT NULL,
	"mission" jsonb NOT NULL,
	"parameters" jsonb,
	"version" text,
	"author" text,
	"tags" jsonb,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "processes" (
	"agent_name" text NOT NULL,
	"pid" integer NOT NULL,
	"task_id" text NOT NULL,
	"started_at" text NOT NULL,
	"alive" integer DEFAULT 1 NOT NULL,
	"activity" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"endpoint" text PRIMARY KEY NOT NULL,
	"expiration_time" bigint,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"last_success_at" text,
	"last_failure_at" text,
	"failure_count" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "push_vapid" (
	"id" integer PRIMARY KEY NOT NULL,
	"public_key" text NOT NULL,
	"private_key" text NOT NULL,
	"subject" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"pid" integer DEFAULT 0 NOT NULL,
	"agent_name" text NOT NULL,
	"adapter_type" text NOT NULL,
	"session_id" text,
	"status" varchar(32) DEFAULT 'running' NOT NULL,
	"started_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"activity" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"outcomes" jsonb,
	"config" jsonb,
	"config_path" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"agent" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"starred" boolean
);
--> statement-breakpoint
CREATE TABLE "task_directions" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"run_id" text,
	"mode" varchar(32) NOT NULL,
	"message" text NOT NULL,
	"status" varchar(32) DEFAULT 'queued' NOT NULL,
	"created_at" text NOT NULL,
	"delivered_at" text,
	"applied_at" text,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"assign_to" text NOT NULL,
	"group" text,
	"mission_id" text,
	"depends_on" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"retries" integer DEFAULT 0 NOT NULL,
	"max_retries" integer DEFAULT 2 NOT NULL,
	"max_duration" integer,
	"retry_policy" jsonb,
	"expectations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metrics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"result" jsonb,
	"phase" varchar(32),
	"fix_attempts" integer DEFAULT 0 NOT NULL,
	"resolution_attempts" integer DEFAULT 0 NOT NULL,
	"original_description" text,
	"session_id" text,
	"notifications" jsonb,
	"outcomes" jsonb,
	"expected_outcomes" jsonb,
	"deadline" text,
	"priority" text,
	"side_effects" integer,
	"revision_count" integer,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teams" (
	"name" text PRIMARY KEY NOT NULL,
	"description" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault" (
	"agent" text NOT NULL,
	"service" text NOT NULL,
	"type" text NOT NULL,
	"label" text,
	"account" text,
	"allowed_agents" text,
	"credentials" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "vault_agent_service_pk" PRIMARY KEY("agent","service")
);
--> statement-breakpoint
ALTER TABLE "log_entries" ADD CONSTRAINT "log_entries_session_id_log_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."log_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pg_approvals_status" ON "approvals" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_pg_approvals_task_id" ON "approvals" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_pg_attachments_session_id" ON "attachments" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_pg_expo_tokens_device_id" ON "expo_tokens" USING btree ("device_id");--> statement-breakpoint
CREATE INDEX "idx_pg_agents_team_name" ON "agents" USING btree ("team_name");--> statement-breakpoint
CREATE INDEX "idx_pg_background_waits_session_state" ON "background_waits" USING btree ("session_id","state");--> statement-breakpoint
CREATE INDEX "idx_pg_background_waits_task_state" ON "background_waits" USING btree ("task_id","state");--> statement-breakpoint
CREATE INDEX "idx_pg_background_waits_state" ON "background_waits" USING btree ("state");--> statement-breakpoint
CREATE INDEX "idx_pg_log_entries_session" ON "log_entries" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_pg_log_entries_ts" ON "log_entries" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "idx_pg_log_sessions_started_at" ON "log_sessions" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_pg_messages_session" ON "messages" USING btree ("session_id","ts");--> statement-breakpoint
CREATE INDEX "idx_pg_missions_status" ON "missions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_pg_notifications_timestamp" ON "notifications" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_pg_notifications_status" ON "notifications" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_pg_notifications_channel" ON "notifications" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "idx_pg_notifications_rule_id" ON "notifications" USING btree ("rule_id");--> statement-breakpoint
CREATE INDEX "idx_pg_pairing_code" ON "pairing_requests" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_pg_pairing_peer" ON "pairing_requests" USING btree ("peer_id");--> statement-breakpoint
CREATE INDEX "idx_pg_peer_sessions_session_id" ON "peer_sessions" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_pg_peers_channel" ON "peers" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "idx_pg_peers_external_id" ON "peers" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "idx_pg_processes_task_id" ON "processes" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_pg_processes_agent_name" ON "processes" USING btree ("agent_name");--> statement-breakpoint
CREATE INDEX "idx_pg_runs_status" ON "runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_pg_runs_task_id" ON "runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_pg_sessions_agent" ON "sessions" USING btree ("agent");--> statement-breakpoint
CREATE INDEX "idx_pg_sessions_updated_at" ON "sessions" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_pg_task_directions_task" ON "task_directions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_pg_task_directions_run_status" ON "task_directions" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "idx_pg_tasks_status" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_pg_tasks_group" ON "tasks" USING btree ("group");--> statement-breakpoint
CREATE INDEX "idx_pg_tasks_assign_to" ON "tasks" USING btree ("assign_to");--> statement-breakpoint
CREATE INDEX "idx_pg_tasks_mission_id" ON "tasks" USING btree ("mission_id");--> statement-breakpoint
CREATE INDEX "idx_pg_tasks_updated_at" ON "tasks" USING btree ("updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_pg_vault_agent" ON "vault" USING btree ("agent");
CREATE TABLE "brain_items" (
	"kind" text NOT NULL,
	"id" text NOT NULL,
	"seq" integer NOT NULL,
	"doc" jsonb NOT NULL,
	CONSTRAINT "brain_items_kind_id_pk" PRIMARY KEY("kind","id")
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"doc" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "context_checkpoints" (
	"session_id" text PRIMARY KEY NOT NULL,
	"revision" text NOT NULL,
	"checkpoint" jsonb NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_activity" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"doc" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"doc" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "data_views" (
	"id" text PRIMARY KEY NOT NULL,
	"doc" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "token_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"timestamp" text NOT NULL,
	"source" text NOT NULL,
	"provider" text,
	"model" text,
	"session_id" text,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"total_tokens" integer DEFAULT 0 NOT NULL,
	"cost" double precision DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_contacts" (
	"jid" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"last_seen" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "whatsapp_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"chat_jid" text NOT NULL,
	"sender_jid" text NOT NULL,
	"sender_name" text,
	"text" text NOT NULL,
	"from_me" boolean DEFAULT false NOT NULL,
	"timestamp" bigint NOT NULL,
	"media_type" text,
	"media_path" text,
	"mime_type" text,
	"file_name" text,
	"media_size" bigint,
	"read_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pg_apps_slug" ON "apps" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_pg_data_activity_created_at" ON "data_activity" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_pg_data_activity_source" ON "data_activity" USING btree ("source_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pg_data_sources_slug" ON "data_sources" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "idx_pg_data_views_updated_at" ON "data_views" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_pg_token_usage_timestamp" ON "token_usage" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_pg_whatsapp_contacts_phone" ON "whatsapp_contacts" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "idx_pg_whatsapp_contacts_last_seen" ON "whatsapp_contacts" USING btree ("last_seen" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_pg_whatsapp_messages_chat" ON "whatsapp_messages" USING btree ("chat_jid","timestamp" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "idx_pg_whatsapp_messages_ts" ON "whatsapp_messages" USING btree ("timestamp" DESC NULLS LAST);
CREATE TABLE "chat_queue_items" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"content" text NOT NULL,
	"position" integer NOT NULL,
	"created_at" text NOT NULL,
	"steer_id" text
);
--> statement-breakpoint
CREATE TABLE "chat_queue_settings" (
	"session_id" text PRIMARY KEY NOT NULL,
	"auto_send" boolean NOT NULL,
	"hold" text
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "parent_session_id" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "fork_message_id" text;--> statement-breakpoint
ALTER TABLE "chat_queue_items" ADD CONSTRAINT "chat_queue_items_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_queue_settings" ADD CONSTRAINT "chat_queue_settings_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pg_chat_queue_items_session" ON "chat_queue_items" USING btree ("session_id","position");--> statement-breakpoint
CREATE INDEX "idx_pg_sessions_parent" ON "sessions" USING btree ("parent_session_id");
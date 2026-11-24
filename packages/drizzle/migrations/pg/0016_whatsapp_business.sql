CREATE TABLE "wabiz_contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"wa_id" text NOT NULL,
	"doc" jsonb NOT NULL,
	"activity_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wabiz_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"channel" text NOT NULL,
	"wa_id" text NOT NULL,
	"direction" text NOT NULL,
	"initiated" text,
	"sent_by" text,
	"status" text NOT NULL,
	"doc" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "wabiz_processed" (
	"key" text PRIMARY KEY NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_pg_wabiz_contacts_channel" ON "wabiz_contacts" USING btree ("channel","activity_at");--> statement-breakpoint
CREATE INDEX "idx_pg_wabiz_messages_contact" ON "wabiz_messages" USING btree ("channel","wa_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_pg_wabiz_messages_created" ON "wabiz_messages" USING btree ("channel","created_at");--> statement-breakpoint
CREATE INDEX "idx_pg_wabiz_processed_created" ON "wabiz_processed" USING btree ("created_at");
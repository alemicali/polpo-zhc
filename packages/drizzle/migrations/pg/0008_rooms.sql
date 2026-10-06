CREATE TABLE "room_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"room_id" text NOT NULL,
	"seq" integer NOT NULL,
	"ts" text NOT NULL,
	"author_kind" text NOT NULL,
	"author_id" text NOT NULL,
	"author_name" text NOT NULL,
	"text" text NOT NULL,
	"external_id" text,
	"addressed_to" text,
	"reply_to_id" text
);
--> statement-breakpoint
CREATE TABLE "rooms" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"agents" text NOT NULL,
	"settings" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "room_messages" ADD CONSTRAINT "room_messages_room_id_rooms_id_fk" FOREIGN KEY ("room_id") REFERENCES "public"."rooms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_pg_room_messages_room" ON "room_messages" USING btree ("room_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pg_room_messages_external" ON "room_messages" USING btree ("room_id","external_id");--> statement-breakpoint
CREATE INDEX "idx_pg_rooms_kind" ON "rooms" USING btree ("kind","updated_at");
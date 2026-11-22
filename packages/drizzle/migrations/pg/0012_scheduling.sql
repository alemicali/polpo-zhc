CREATE TABLE "leases" (
	"key" text PRIMARY KEY NOT NULL,
	"owner" text NOT NULL,
	"expires_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"mission_id" text PRIMARY KEY NOT NULL,
	"doc" jsonb NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_watchers" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"doc" jsonb NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_pg_leases_expires" ON "leases" USING btree ("expires_at");
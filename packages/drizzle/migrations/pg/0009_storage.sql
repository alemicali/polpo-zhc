CREATE TABLE "storage_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"doc" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_pg_storage_entries_slug" ON "storage_entries" USING btree ("slug");
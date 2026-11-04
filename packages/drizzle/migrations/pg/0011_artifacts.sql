CREATE TABLE "artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"created_by" text NOT NULL,
	"session_id" text,
	"doc" jsonb NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_pg_artifacts_updated" ON "artifacts" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_pg_artifacts_session" ON "artifacts" USING btree ("session_id");
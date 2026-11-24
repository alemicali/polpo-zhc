CREATE TABLE "agent_deploys" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_name" text NOT NULL,
	"pointer" text NOT NULL,
	"from_version" text,
	"to_version" text NOT NULL,
	"action" text NOT NULL,
	"actor" text NOT NULL,
	"note" text,
	"at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_drafts" (
	"agent_name" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_pointers" (
	"agent_name" text NOT NULL,
	"pointer" text NOT NULL,
	"version" text NOT NULL,
	"updated_at" text NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "agent_pointers_agent_name_pointer_pk" PRIMARY KEY("agent_name","pointer")
);
--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"agent_name" text NOT NULL,
	"version" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" text NOT NULL,
	CONSTRAINT "agent_versions_agent_name_version_pk" PRIMARY KEY("agent_name","version")
);
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "agent_version" text;--> statement-breakpoint
CREATE INDEX "idx_pg_agent_deploys_agent_at" ON "agent_deploys" USING btree ("agent_name","at");
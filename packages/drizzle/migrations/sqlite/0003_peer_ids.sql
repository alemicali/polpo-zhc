-- Peers used to get a random id on every message: keep one row per person, under the stable id "<channel>:<externalId>", with its latest name.
INSERT INTO "peers" ("id", "channel", "external_id", "display_name", "first_seen_at", "last_seen_at", "linked_to")
SELECT p."channel" || ':' || p."external_id", p."channel", p."external_id", p."display_name",
  (SELECT min(q."first_seen_at") FROM "peers" q WHERE q."channel" = p."channel" AND q."external_id" = p."external_id"),
  p."last_seen_at", p."linked_to"
FROM "peers" p
WHERE p."id" <> p."channel" || ':' || p."external_id"
  AND p."id" = (
    SELECT q."id" FROM "peers" q
    WHERE q."channel" = p."channel" AND q."external_id" = p."external_id" AND q."id" <> q."channel" || ':' || q."external_id"
    ORDER BY q."last_seen_at" DESC, q."id" LIMIT 1
  )
ON CONFLICT ("id") DO UPDATE SET
  "display_name" = COALESCE(excluded."display_name", "peers"."display_name"),
  "first_seen_at" = CASE WHEN excluded."first_seen_at" < "peers"."first_seen_at" THEN excluded."first_seen_at" ELSE "peers"."first_seen_at" END,
  "last_seen_at" = CASE WHEN excluded."last_seen_at" > "peers"."last_seen_at" THEN excluded."last_seen_at" ELSE "peers"."last_seen_at" END;
--> statement-breakpoint
-- Links to a random-id copy now point to the person's stable id.
UPDATE "peers" SET "linked_to" = (
  SELECT t."channel" || ':' || t."external_id" FROM "peers" t WHERE t."id" = "peers"."linked_to"
)
WHERE "linked_to" IN (SELECT r."id" FROM "peers" r WHERE r."id" <> r."channel" || ':' || r."external_id");
--> statement-breakpoint
-- The random-id copies are now redundant.
DELETE FROM "peers" WHERE "id" <> "channel" || ':' || "external_id";

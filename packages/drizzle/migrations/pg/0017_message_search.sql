-- Full-text search over chat messages (GET /api/v1/search): a GIN index on the words of every
-- message. 'simple' configuration: lowercase words, no language stemming (chats mix Italian and
-- English; the search folds plurals itself and matches word prefixes). Existing messages are
-- indexed when the index is built (the backfill); new ones as they are written.
CREATE INDEX IF NOT EXISTS "idx_pg_messages_fts" ON "messages" USING gin (to_tsvector('simple', "content"));

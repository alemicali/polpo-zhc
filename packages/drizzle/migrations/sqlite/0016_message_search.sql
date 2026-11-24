-- Full-text search over chat messages (GET /api/v1/search): an FTS5 index over messages.content
-- (external content: the text is not stored twice), diacritics-insensitive (unicode61,
-- remove_diacritics 2). Triggers keep it in step with the messages table; 'rebuild' indexes the
-- messages that already exist (the backfill). Hits are joined by rowid and re-checked against
-- the query by the search, so a stale entry is never shown.
CREATE VIRTUAL TABLE IF NOT EXISTS `messages_fts` USING fts5(content, content='messages', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `messages_fts_ai` AFTER INSERT ON `messages` BEGIN
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `messages_fts_ad` AFTER DELETE ON `messages` BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `messages_fts_au` AFTER UPDATE OF `content` ON `messages` BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
END;
--> statement-breakpoint
INSERT INTO messages_fts(messages_fts) VALUES ('rebuild');

/**
 * Dialect flag — determines JSON serialization strategy.
 * - "pg": columns may be jsonb (native objects) or text (JSON strings).
 * - "sqlite": TEXT columns always store JSON strings.
 *
 * Both serialize/deserialize handle strings safely regardless of dialect,
 * so text columns with JSON content work on both PG and SQLite.
 */
export type Dialect = "pg" | "sqlite";

/** Serialize a value for storage in a JSON/text column. Always stringifies. */
export function serializeJson(value: unknown, _dialect: Dialect): unknown {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

/** Deserialize a value read from a JSON/text column. Parses strings, passes objects through. */
export function deserializeJson<T>(value: unknown, fallback: T, _dialect: Dialect): T {
  if (value === undefined || value === null) return fallback;
  // Already a parsed object (e.g. from a jsonb column)
  if (typeof value === "object") return value as T;
  // String from a text column — parse it
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return fallback;
}

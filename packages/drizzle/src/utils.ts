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

/**
 * Rows touched by an UPDATE/DELETE, whatever the driver: better-sqlite3 reports `changes`,
 * postgres.js `count`, node-postgres `rowCount`, libsql/D1 `rowsAffected`.
 */
export function affectedRows(result: unknown): number {
  const r = result as { changes?: number; count?: number; rowCount?: number; rowsAffected?: number } | null | undefined;
  return Number(r?.changes ?? r?.count ?? r?.rowCount ?? r?.rowsAffected ?? 0);
}

/** A primary-key or unique constraint was violated (SQLite or PostgreSQL, wrapped by Drizzle or not). */
export function isUniqueViolation(err: unknown): boolean {
  for (let e: any = err; e; e = e.cause) {
    if (e.code === "23505" || e.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || e.code === "SQLITE_CONSTRAINT_UNIQUE") return true;
    if (typeof e.message === "string" && /UNIQUE constraint failed|duplicate key value/.test(e.message)) return true;
  }
  return false;
}

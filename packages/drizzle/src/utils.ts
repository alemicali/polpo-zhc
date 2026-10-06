/**
 * Dialect flag — determines JSON serialization strategy.
 * - "pg": columns may be jsonb (native objects) or text (JSON strings).
 * - "sqlite": TEXT columns always store JSON strings.
 *
 * Both serialize/deserialize handle strings safely regardless of dialect,
 * so text columns with JSON content work on both PG and SQLite.
 */
export type Dialect = "pg" | "sqlite";

/**
 * Value for a JSON column: PostgreSQL columns are jsonb (the driver encodes the object once),
 * SQLite columns are TEXT (stringified here). Only use for jsonb columns on PostgreSQL.
 */
export function serializeJson(value: unknown, dialect: Dialect): unknown {
  if (value === undefined || value === null) return null;
  return dialect === "pg" ? value : JSON.stringify(value);
}

/**
 * Value read from a JSON column. jsonb comes back parsed; TEXT is parsed here. A PostgreSQL string
 * that is not JSON is a genuine string value and is returned as is.
 */
export function deserializeJson<T>(value: unknown, fallback: T, dialect: Dialect): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value === "object") return value as T;
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return dialect === "pg" ? (value as T) : fallback; }
  }
  return dialect === "pg" ? (value as T) : fallback;
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

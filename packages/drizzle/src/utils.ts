/**
 * Dialect flag — determines JSON serialization strategy.
 * - "pg": JSONB columns hold native JS objects; no manual serialization needed.
 * - "sqlite": TEXT columns store JSON strings; JSON.parse / JSON.stringify required.
 */
export type Dialect = "pg" | "sqlite";

/** Serialize a value for storage in a JSON column. */
export function serializeJson(value: unknown, dialect: Dialect): unknown {
  if (value === undefined || value === null) return null;
  return dialect === "sqlite" ? JSON.stringify(value) : value;
}

/** Deserialize a value read from a JSON column. */
export function deserializeJson<T>(value: unknown, fallback: T, dialect: Dialect): T {
  if (value === undefined || value === null) return fallback;
  if (dialect === "pg") return value as T;
  // SQLite: value is a string that needs parsing
  if (typeof value === "string") {
    try { return JSON.parse(value) as T; } catch { return fallback; }
  }
  return fallback;
}

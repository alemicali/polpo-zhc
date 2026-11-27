/** Structured data: one transaction of several SQL statements on a PostgreSQL or SQLite source. */

/** Rows a statement must change (INSERT/UPDATE/DELETE) or return (SELECT): exactly n, or a range. */
export type DataTransactionExpectRows = number | { min?: number; max?: number };

export interface DataTransactionStatement {
  /** One statement; placeholders $1, $2 (PostgreSQL) or ? (SQLite). */
  sql: string;
  /** Bind parameters in placeholder order (never interpolated into the SQL). */
  params?: unknown[];
  /** A mismatch rolls the whole transaction back. */
  expectRows?: DataTransactionExpectRows;
}

export interface DataTransactionRequest {
  statements: DataTransactionStatement[];
  /** PostgreSQL only: applied with SET LOCAL (set_config(key, value, true)); keys namespace.name. */
  settings?: Record<string, string>;
  /** Run READ ONLY: only SELECT-like statements. */
  readOnly?: boolean;
  /** Statement and lock timeout, and the longest the transaction may run (default 15000, max 60000). */
  timeoutMs?: number;
}

export interface DataTransactionStatementResult {
  index: number;
  command: string;
  rowCount: number;
  rows?: Record<string, unknown>[];
  truncated?: boolean;
}

export interface DataTransactionResult {
  sourceId: string;
  status: "committed" | "rolled_back";
  readOnly: boolean;
  durationMs: number;
  statements: DataTransactionStatementResult[];
  /** When rolled back: the failing statement (0-based) and why. */
  failed?: { index: number; reason: "error" | "expect_rows" | "timeout"; message: string };
}

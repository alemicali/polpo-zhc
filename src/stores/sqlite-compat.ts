import { createRequire } from "node:module";

// Factory: detect Bun vs Node, return compatible Database instance.
// bun:sqlite and better-sqlite3 share virtually the same API surface.
// Two differences handled here:
//   1. bun:sqlite needs { strict: true } so named params work without $ prefix
//   2. db.pragma() doesn't exist in bun:sqlite — callers must use db.exec("PRAGMA ...")
export function createDatabase(dbPath: string): any {
  if (typeof process !== "undefined" && (process.versions as any)?.bun) {
    // Bun runtime → use bun:sqlite
    const { Database } = require("bun:sqlite");
    return new Database(dbPath, { strict: true });
  } else {
    // Node.js ESM → use createRequire for native addon
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    return new Database(dbPath);
  }
}

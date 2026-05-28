import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { getPolpoDir } from "../../core/constants.js";
import { migrateFileToSqlite } from "../../migrations/file-to-sqlite.js";

/**
 * `polpo migrate` — copy legacy `.polpo/*.json` files into `.polpo/state.db`.
 *
 * Idempotent: stores that already have rows in SQLite are skipped. Legacy
 * files are never deleted by this command. Run with `--dry-run` to preview
 * what would be migrated without writing.
 */
export function registerMigrateCommand(parent: Command): void {
  parent
    .command("migrate")
    .description("Migrate legacy file-based state in .polpo/ into the SQLite DB (.polpo/state.db). Idempotent; preserves files.")
    .option("-d, --dir <path>", "Working directory", ".")
    .option("--dry-run", "Show what would be migrated without writing", false)
    .action(async (opts: { dir: string; dryRun: boolean }) => {
      const workDir = resolve(opts.dir);
      const polpoDir = getPolpoDir(workDir);
      if (!existsSync(polpoDir)) {
        console.error(chalk.red(`No .polpo directory at ${polpoDir} — run 'polpo init' or 'polpo setup' first.`));
        process.exitCode = 1;
        return;
      }

      // Lazy-load the heavy deps so the rest of the CLI stays snappy.
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      const Database = req("better-sqlite3");
      const { drizzle } = await import("drizzle-orm/better-sqlite3");
      const { sqliteSchema } = await import("@polpo-ai/drizzle");
      const { ensureSqliteSchema } = await import("../../core/drizzle-sqlite-schema.js");

      const dbPath = join(polpoDir, "state.db");
      const sqlite = new Database(dbPath);
      sqlite.exec("PRAGMA journal_mode = WAL");
      sqlite.exec("PRAGMA synchronous = NORMAL");
      sqlite.exec("PRAGMA foreign_keys = ON");
      ensureSqliteSchema(sqlite);
      const db = drizzle(sqlite);

      console.log(chalk.bold(opts.dryRun ? "Dry-run migrate:" : "Migrating .polpo → SQLite:"));
      console.log(chalk.dim(`  source: ${polpoDir}`));
      console.log(chalk.dim(`  target: ${dbPath}`));
      console.log();

      const result = await migrateFileToSqlite(polpoDir, db, sqliteSchema, {
        dryRun: opts.dryRun,
        log: (msg) => console.log(`  ${msg}`),
      });

      console.log();
      if (result.ok) {
        console.log(chalk.green(`Migration ${opts.dryRun ? "dry-run " : ""}complete in ${result.totalDurationMs}ms.`));
      } else {
        console.log(chalk.yellow(`Migration completed with errors in ${result.totalDurationMs}ms — legacy files preserved.`));
        process.exitCode = 1;
      }
      sqlite.close();
    });
}

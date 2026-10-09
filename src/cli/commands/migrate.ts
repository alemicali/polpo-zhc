import { resolve, join } from "node:path";
import { existsSync } from "node:fs";
import chalk from "chalk";
import type { Command } from "commander";
import { getPolpoDir } from "../../core/constants.js";
import { migrateFileToSqlite } from "../../migrations/file-to-sqlite.js";
import { loadPolpoConfig, savePolpoConfig } from "../../core/config.js";

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
    .option("--to <backend>", "Target backend: sqlite (default) or postgres")
    .option("--database-url <url>", "PostgreSQL URL for --to postgres (default: DATABASE_URL)")
    .option("--switch", "With --to postgres: after a verified copy, set storage to postgres in polpo.json", false)
    .action(async (opts: { dir: string; dryRun: boolean; to?: string; databaseUrl?: string; switch: boolean }) => {
      const workDir = resolve(opts.dir);
      const polpoDir = getPolpoDir(workDir);
      if (!existsSync(polpoDir)) {
        console.error(chalk.red(`No .polpo directory at ${polpoDir} — run 'polpo init' or 'polpo setup' first.`));
        process.exitCode = 1;
        return;
      }
      if (opts.to === "postgres") {
        await migrateToPostgres(polpoDir, opts);
        return;
      }
      if (opts.to && opts.to !== "sqlite") {
        console.error(chalk.red(`Unknown target "${opts.to}": use sqlite or postgres.`));
        process.exitCode = 1;
        return;
      }

      // Lazy-load the heavy deps so the rest of the CLI stays snappy.
      const { createRequire } = await import("node:module");
      const req = createRequire(import.meta.url);
      const Database = req("better-sqlite3");
      const { drizzle } = await import("drizzle-orm/better-sqlite3");
      const { sqliteSchema, configureSqlite, migrateSqlite } = await import("@polpo-ai/drizzle");

      const dbPath = join(polpoDir, "state.db");
      const sqlite = new Database(dbPath);
      configureSqlite(sqlite);
      const db = drizzle(sqlite);
      await migrateSqlite(db);

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

/** `polpo migrate --to postgres`: verified copy of the project's data into PostgreSQL. */
async function migrateToPostgres(
  polpoDir: string,
  opts: { dryRun: boolean; databaseUrl?: string; switch: boolean },
): Promise<void> {
  const databaseUrl = opts.databaseUrl ?? process.env["DATABASE_URL"];
  if (!databaseUrl) {
    console.error(chalk.red("Set --database-url or DATABASE_URL."));
    process.exitCode = 1;
    return;
  }
  const config = loadPolpoConfig(polpoDir);
  const settings = (config?.settings ?? {}) as Record<string, unknown>;
  const current = settings["storage"] === "file" ? "file" : settings["storage"] === "postgres" ? "postgres" : "sqlite";
  if (current === "postgres") {
    console.error(chalk.red("This project already runs on PostgreSQL."));
    process.exitCode = 1;
    return;
  }
  const source = current === "sqlite" && existsSync(join(polpoDir, "state.db")) ? "sqlite" : "file";
  const { moveToPostgres } = await import("../../migrations/to-postgres.js");
  console.log(chalk.bold(`${opts.dryRun ? "Dry run: " : ""}moving ${polpoDir} (${source}) to PostgreSQL`));
  console.log(chalk.dim("  The source is copied first and never written to."));
  try {
    const result = await moveToPostgres({ polpoDir, databaseUrl, source, dryRun: opts.dryRun, log: (m) => console.log(m) });
    const rows = result.tables.reduce((n, t) => n + t.rows, 0);
    if (opts.dryRun) {
      console.log(chalk.green(`Dry run complete: ${rows} row(s) in ${result.tables.filter((t) => t.rows > 0).length} table(s) would be copied.`));
      return;
    }
    if (!result.ok) {
      console.error(chalk.red("Verification failed: see MISMATCH lines above. polpo.json was not changed."));
      process.exitCode = 1;
      return;
    }
    console.log(chalk.green(`Copied and verified ${rows} row(s) in ${result.tables.length} table(s) in ${result.durationMs}ms.`));
    if (opts.switch && config) {
      savePolpoConfig(polpoDir, { ...config, settings: { ...(config.settings as object), storage: "postgres" } } as typeof config);
      console.log(chalk.green('polpo.json: storage set to "postgres". Provide DATABASE_URL to the server and restart it.'));
    } else {
      console.log(chalk.dim('Next: set storage to "postgres" in polpo.json (or rerun with --switch), provide DATABASE_URL, restart.'));
    }
  } catch (err) {
    const reason = (err as { cause?: { message?: string; detail?: string } })?.cause;
    const message = err instanceof Error ? err.message.split("\n")[0]!.slice(0, 200) : String(err);
    console.error(chalk.red(`Migration failed: ${reason?.message ?? message}${reason?.detail ? ` (${reason.detail})` : ""}`));
    console.error(chalk.dim("Nothing changed in the project; PostgreSQL is left as the transaction left it (all or nothing)."));
    process.exitCode = 1;
  }
}

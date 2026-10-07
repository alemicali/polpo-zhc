/** Pure parts of scripts/migrate-vault-refs.mjs (the script itself is run by hand, per instance). */
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { parseArgs, parseEnvFile, planMigration } from "../../scripts/migrate-vault-refs.mjs";

const oldEntry = (credentials: Record<string, string>) => ({ type: "custom", credentials });

describe("migrate-vault-refs", () => {
  it("parses the arguments and refuses system owners", () => {
    expect(parseArgs(["--port", "3001", "--db-env", "/x/db-lumea.env", "--owner", "alessio", "--dry-run"]))
      .toMatchObject({ port: 3001, dbEnv: "/x/db-lumea.env", owner: "alessio", dryRun: true, apiKeyEnv: "POLPO_API_KEY" });
    expect(() => parseArgs(["--port", "3001", "--db-env", "x"])).toThrow(/--owner/);
    expect(() => parseArgs(["--port", "3001", "--db-env", "x", "--owner", "$sandbox"])).toThrow(/system owner/);
    expect(() => parseArgs(["--port", "--db-env", "x"])).toThrow(/needs a value/);
    expect(() => parseArgs(["--bogus"])).toThrow(/Unknown option/);
  });

  it("reads env files", () => {
    expect(parseEnvFile('# db\nDATABASE_URL="postgres://u:p@h/db"\nexport OTHER=1\n\nnot a line')).toEqual({ DATABASE_URL: "postgres://u:p@h/db", OTHER: "1" });
  });

  it("copies the $sandbox keys to the owner, references them in the settings and deletes the old rows", () => {
    const plan = planMigration({
      owner: "alessio",
      old: { daytona: oldEntry({ apiKey: "dtn-secret", target: "eu", apiUrl: "https://app.daytona.io/api" }), e2b: oldEntry({ apiKey: "e2b-secret", template: "base" }) },
      existing: {},
      sandbox: { provider: "bwrap", network: { mode: "open" } },
    });
    expect(plan.writes).toEqual([
      { id: "daytona", service: "daytona", entry: { type: "api_key", label: "Daytona API key", credentials: { apiKey: "dtn-secret" } } },
      { id: "e2b", service: "e2b", entry: { type: "api_key", label: "E2B API key", credentials: { apiKey: "e2b-secret" } } },
    ]);
    expect(plan.sandbox).toEqual({
      provider: "bwrap", network: { mode: "open" },
      providers: {
        daytona: { credential: { owner: "alessio", service: "daytona" }, target: "eu", apiUrl: "https://app.daytona.io/api" },
        e2b: { credential: { owner: "alessio", service: "e2b" }, template: "base" },
      },
    });
    expect(plan.deletes).toEqual(["daytona", "e2b"]);
    // the report has names only, never values
    expect(plan.report.join("\n")).not.toMatch(/secret/);
  });

  it("is idempotent: a second run changes nothing but still removes leftover old rows", () => {
    const sandbox = { providers: { daytona: { credential: { owner: "alessio", service: "daytona" }, target: "eu" } } };
    const again = planMigration({
      owner: "alessio",
      old: { daytona: oldEntry({ apiKey: "dtn-secret", target: "eu" }) },
      existing: { daytona: { type: "api_key", credentials: { apiKey: "dtn-secret" } } },
      sandbox,
    });
    expect(again.writes).toEqual([]);
    expect(again.sandbox).toBeUndefined();
    expect(again.deletes).toEqual(["daytona"]);
    const done = planMigration({ owner: "alessio", old: {}, existing: {}, sandbox });
    expect(done).toMatchObject({ writes: [], sandbox: undefined, deletes: [] });
  });

  it("never overwrites a different key or a reference a person already chose", () => {
    const conflict = planMigration({
      owner: "alessio",
      old: { daytona: oldEntry({ apiKey: "old-key" }), e2b: oldEntry({ apiKey: "e2b-key" }) },
      existing: { daytona: { type: "api_key", credentials: { apiKey: "other-key" } } },
      sandbox: { providers: { e2b: { credential: { owner: "ops", service: "e2b" } } } },
    });
    expect(conflict.writes).toEqual([]);
    expect(conflict.sandbox).toBeUndefined();
    expect(conflict.deletes).toEqual([]);
    expect(conflict.report.join("\n")).toMatch(/different key: skipped/);
    expect(conflict.report.join("\n")).toMatch(/already reference ops\/e2b: skipped/);
  });

  it("keeps options already in the settings over the old entry's", () => {
    const plan = planMigration({
      owner: "alessio",
      old: { daytona: oldEntry({ apiKey: "k", target: "us" }) },
      existing: {},
      sandbox: { providers: { daytona: { target: "eu" } } },
    });
    expect(plan.sandbox.providers.daytona).toEqual({ credential: { owner: "alessio", service: "daytona" }, target: "eu" });
  });
});

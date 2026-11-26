/** Agent versions on SQLite (migrations included), and PostgreSQL when POLPO_TEST_DATABASE_URL is set. */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { drizzle as pgDrizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { AgentVersioning } from "@polpo-ai/core/agent-versions";
import type { AgentConfig } from "@polpo-ai/core/types";
import { createPgStores, createSqliteStores, migratePg, migrateSqlite, type DrizzleStores } from "../index.js";

const PG_URL = process.env.POLPO_TEST_DATABASE_URL;
const DIALECTS = ["sqlite", ...(PG_URL ? ["postgres"] : [])] as const;

describe.each(DIALECTS)("agent versions on %s", (dialect) => {
  let stores: DrizzleStores;
  let pg: ReturnType<typeof postgres> | undefined;
  let pgDb: ReturnType<typeof pgDrizzle> | undefined;

  beforeAll(async () => {
    if (dialect !== "postgres") return;
    pg = postgres(PG_URL!, { max: 4, onnotice: () => {} });
    pgDb = pgDrizzle(pg);
    await migratePg(pgDb);
  });
  afterAll(async () => { await pg?.end({ timeout: 5 }); });

  beforeEach(async () => {
    if (dialect === "sqlite") {
      const db = drizzle(new Database(":memory:"));
      migrateSqlite(db);
      stores = createSqliteStores(db);
      return;
    }
    await pg!.unsafe(`TRUNCATE "agent_versions", "agent_drafts", "agent_pointers", "agent_deploys", "agents", "teams", "tasks"`);
    stores = createPgStores(pgDb!);
  });

  it("migrates an agent to 1.0.0, publishes, deploys (written live) and rolls back", async () => {
    await stores.teamStore.createTeam({ name: "main", agents: [] } as never);
    await stores.agentStore.createAgent({ name: "writer", role: "Writes", systemPrompt: "Be concise." } as AgentConfig, "main");
    const versioning = new AgentVersioning(stores.agentVersionStore, {
      getAgent: (n) => stores.agentStore.getAgent(n),
      getAgents: () => stores.agentStore.getAgents(),
      writeLive: (n, u) => stores.agentStore.updateAgent(n, u),
    });
    expect((await versioning.migrateAll()).initialized).toEqual(["writer"]);
    await versioning.updateDraft("writer", { systemPrompt: "Be brief.", maxTurns: 20 }, "person:ada@example.com");
    expect((await stores.agentVersionStore.getDraft("writer"))!.config).toMatchObject({ systemPrompt: "Be brief.", maxTurns: 20 });

    const v = await versioning.publish("writer", { actor: "person:ada@example.com", note: "shorter" });
    expect(v.version).toBe("1.1.0");
    expect(await stores.agentVersionStore.getDraft("writer")).toBeUndefined();
    await expect(stores.agentVersionStore.addVersion(v)).rejects.toThrow(/already exists/);

    await versioning.deploy("writer", "1.1.0", { actor: "person:ada@example.com" });
    expect((await stores.agentStore.getAgent("writer"))!.systemPrompt).toBe("Be brief.");
    await versioning.rollback("writer", { actor: "person:bob@example.com" });
    const live = (await stores.agentStore.getAgent("writer"))!;
    expect(live.systemPrompt).toBe("Be concise.");
    expect(live.maxTurns).toBeUndefined();

    expect((await stores.agentVersionStore.listVersions("writer")).map((x) => x.version)).toEqual(["1.0.0", "1.1.0"]);
    expect((await stores.agentVersionStore.getPointers("writer"))).toMatchObject([{ pointer: "production", version: "1.0.0", updatedBy: "person:bob@example.com" }]);
    const deploys = await stores.agentVersionStore.listDeploys("writer");
    expect(deploys.map((d) => `${d.action}:${d.from ?? "-"}→${d.to}`)).toEqual(["rollback:1.1.0→1.0.0", "deploy:1.0.0→1.1.0", "initial:-→1.0.0"]);
    expect(await stores.agentVersionStore.listDeploys("writer", 1)).toHaveLength(1);

    await stores.agentVersionStore.deleteAgent("writer");
    expect(await stores.agentVersionStore.listVersions("writer")).toEqual([]);
    expect(await stores.agentVersionStore.listDeploys("writer")).toEqual([]);
  });

  it("stores a task's pinned agent version", async () => {
    const t = await stores.taskStore.addTask({ title: "A", description: "a", assignTo: "writer", agentVersion: "1.2.0", dependsOn: [], expectations: [], metrics: [], maxRetries: 2 });
    expect((await stores.taskStore.getTask(t.id))!.agentVersion).toBe("1.2.0");
    await stores.taskStore.updateTask(t.id, { agentVersion: undefined });
    expect((await stores.taskStore.getTask(t.id))!.agentVersion).toBeUndefined();
  });
});

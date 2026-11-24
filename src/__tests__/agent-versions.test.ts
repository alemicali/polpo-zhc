import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AGENT_FIELD_CLASSIFICATION, AgentVersioning, InMemoryAgentVersionStore,
  agentSnapshot, buildRunContext, snapshotToYaml, bumpSemver, compareSemver, diffSnapshots, parseAgentRef, suggestBump, unifiedLineDiff,
  type AgentConfig, type AgentUpdate, type AgentVersionStore,
} from "@polpo-ai/core";
import { TaskManager } from "@polpo-ai/core/task-manager";
import { FileAgentVersionStore } from "../stores/file-agent-version-store.js";

/** A live agent store in memory: what production runs. */
function liveAgents(initial: AgentConfig[]) {
  const agents = new Map(initial.map((a) => [a.name, structuredClone(a)]));
  return {
    agents,
    port: {
      getAgent: async (name: string) => (agents.has(name) ? structuredClone(agents.get(name)!) : undefined),
      getAgents: async () => [...agents.values()].map((a) => structuredClone(a)),
      writeLive: async (name: string, updates: AgentUpdate) => {
        const merged = { ...agents.get(name)!, ...updates } as Record<string, unknown>;
        for (const k of Object.keys(merged)) if (merged[k] === undefined) delete merged[k];
        agents.set(name, merged as unknown as AgentConfig);
        return structuredClone(merged) as unknown as AgentConfig;
      },
    },
  };
}

const writer: AgentConfig = {
  name: "writer", createdAt: "2026-01-01T00:00:00.000Z", role: "Writes", model: "anthropic:claude-sonnet-4-5",
  systemPrompt: "Be concise.\nCite sources.", allowedTools: ["read", "write"], skills: ["style"],
};

function setup(store: AgentVersionStore = new InMemoryAgentVersionStore()) {
  const live = liveAgents([writer]);
  let tick = 0;
  const versioning = new AgentVersioning(store, live.port, {
    now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)),
    skillVersions: (skills) => Object.fromEntries(skills.map((s) => [s, 3])),
  });
  return { live, versioning, store };
}

describe("agent versions: field classification", () => {
  it("classifies every AgentConfig field as versioned or excluded", () => {
    // read the interface from the source: a new field must be classified (the compiler checks it too)
    const src = readFileSync(join(process.cwd(), "packages/core/src/types.ts"), "utf-8");
    const start = src.indexOf("export interface AgentConfig {");
    const end = src.indexOf("\n}\n", start);
    const body = src.slice(start, end);
    const fields = [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]);
    expect(fields.length).toBeGreaterThan(20);
    for (const f of fields) expect(AGENT_FIELD_CLASSIFICATION, `AgentConfig.${f} is not classified`).toHaveProperty(f!);
    expect(Object.keys(AGENT_FIELD_CLASSIFICATION).sort()).toEqual([...new Set(fields)].sort());
  });

  it("keeps runtime/record fields out of snapshots", () => {
    const snap = agentSnapshot({ ...writer, volatile: true, missionGroup: "m", version: "9.9.9" });
    expect(snap).not.toHaveProperty("name");
    expect(snap).not.toHaveProperty("createdAt");
    expect(snap).not.toHaveProperty("volatile");
    expect(snap).not.toHaveProperty("version");
    expect(snap).toHaveProperty("systemPrompt");
    expect(Object.keys(snap)).toEqual([...Object.keys(snap)].sort());
  });
});

describe("agent versions: semver and bump suggestion", () => {
  it("bumps and compares", () => {
    expect(bumpSemver("1.2.3", "patch")).toBe("1.2.4");
    expect(bumpSemver("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpSemver("1.2.3", "major")).toBe("2.0.0");
    expect(compareSemver("1.10.0", "1.9.9")).toBeGreaterThan(0);
  });

  it("suggests patch for text, minor for added capabilities and settings, major for engine/model/removals", () => {
    const base = agentSnapshot(writer);
    expect(suggestBump(base, base)).toBeUndefined();
    expect(suggestBump(base, { ...base, systemPrompt: "Be brief." })).toBe("patch");
    expect(suggestBump(base, { ...base, identity: { displayName: "Ada" } })).toBe("patch");
    expect(suggestBump(base, { ...base, allowedTools: ["read", "write", "bash"] })).toBe("minor");
    expect(suggestBump(base, { ...base, maxTurns: 40 })).toBe("minor");
    expect(suggestBump(base, { ...base, connectorTools: { linear: "*" } })).toBe("minor");
    expect(suggestBump(base, { ...base, model: "openai:gpt-5" })).toBe("major");
    expect(suggestBump(base, { ...base, engine: { harness: "claude-code" } } as never)).toBe("major");
    expect(suggestBump(base, { ...base, skills: [] })).toBe("major");
    expect(suggestBump({ ...base, connectorTools: { linear: "*" } }, base)).toBe("major");
  });

  it("parses agent refs", () => {
    expect(parseAgentRef("writer")).toEqual({ name: "writer" });
    expect(parseAgentRef("writer@1.2.0")).toEqual({ name: "writer", ref: "1.2.0" });
    expect(parseAgentRef("writer@production")).toEqual({ name: "writer", ref: "production" });
  });
});

describe("agent versions: diff", () => {
  it("lists changed fields with a line diff for the prompt, and a git-style unified diff", async () => {
    const { versioning } = setup();
    await versioning.updateDraft("writer", { systemPrompt: "Be concise.\nCite primary sources.", maxTurns: 30 }, "person:a@x.io");
    const d = await versioning.diff("writer", "draft");
    expect(d.from).toBe("1.0.0");
    expect(d.to).toBe("draft");
    expect(d.changes.map((c) => c.field)).toEqual(["maxTurns", "systemPrompt"]);
    const prompt = d.changes.find((c) => c.field === "systemPrompt")!;
    expect(prompt.textDiff).toContain("-Cite sources.");
    expect(prompt.textDiff).toContain("+Cite primary sources.");
    expect(d.unified).toMatch(/^--- a\/writer@1\.0\.0\.yaml\n\+\+\+ b\/writer@draft\.yaml\n@@ /);
    expect(d.unified).toContain("+maxTurns: 30\n");
    // the prompt as a block: a line diff inside the config diff
    expect(d.unified).toContain("-  Cite sources.\n+  Cite primary sources.\n");
    expect(d.suggestedBump).toBe("minor");
  });

  it("renders snapshots as YAML with sorted keys and block text", () => {
    expect(snapshotToYaml({ systemPrompt: "a\nb", allowedTools: ["read", "bash"], identity: { displayName: "Ada Lovelace", title: "CTO" }, maxTurns: 3,
      loops: { x: { steps: [{ tool: "read", args: { a: 1 } }] } } as never })).toBe([
      "allowedTools:", "  - read", "  - bash", "identity:", "  displayName: Ada Lovelace", "  title: CTO",
      "loops:", "  x:", "    steps:", "      - args:", "          a: 1", "        tool: read",
      "maxTurns: 3", "systemPrompt: |", "  a", "  b", "",
    ].join("\n"));
  });

  it("unifiedLineDiff is empty for equal texts and marks removals and additions", () => {
    expect(unifiedLineDiff("a\nb", "a\nb")).toBe("");
    const out = unifiedLineDiff("a\nb\nc", "a\nB\nc");
    expect(out.split("\n")).toEqual(["--- a", "+++ b", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", ""]);
    expect(diffSnapshots({ role: "x" }, {})).toEqual([{ field: "role", kind: "removed", before: "x" }]);
  });
});

describe("agent versions: lifecycle", () => {
  it("migrates an existing agent to 1.0.0 deployed to production, once", async () => {
    const { versioning, store } = setup();
    expect(await versioning.migrateAll()).toEqual({ initialized: ["writer"], reconciled: [] });
    expect(await versioning.migrateAll()).toEqual({ initialized: [], reconciled: [] });
    const versions = await store.listVersions("writer");
    expect(versions.map((v) => v.version)).toEqual(["1.0.0"]);
    expect(versions[0]!.skillVersions).toEqual({ style: 3 });
    expect(await versioning.pointer("writer")).toBe("1.0.0");
    const deploys = await store.listDeploys("writer");
    expect(deploys).toHaveLength(1);
    expect(deploys[0]).toMatchObject({ action: "initial", to: "1.0.0", actor: "system:migration" });
  });

  it("keeps draft edits away from production until published and deployed", async () => {
    const { versioning, live } = setup();
    await versioning.updateDraft("writer", { systemPrompt: "Be playful." }, "person:a@x.io");
    // production (what runs) is untouched
    expect(live.agents.get("writer")!.systemPrompt).toBe(writer.systemPrompt);
    expect((await versioning.resolve("writer"))!.agent.systemPrompt).toBe(writer.systemPrompt);
    const state = await versioning.state("writer");
    expect(state.draft).toMatchObject({ exists: true, hasChanges: true, suggestedBump: "patch", nextVersion: "1.0.1" });

    const v = await versioning.publish("writer", { actor: "person:a@x.io", note: "Tone" });
    expect(v).toMatchObject({ version: "1.0.1", bump: "patch", previous: "1.0.0", note: "Tone", author: "person:a@x.io" });
    // published, not deployed
    expect(live.agents.get("writer")!.systemPrompt).toBe(writer.systemPrompt);
    expect((await versioning.state("writer")).draft.exists).toBe(false);

    const entry = await versioning.deploy("writer", "1.0.1", { actor: "person:a@x.io", note: "go" });
    expect(entry).toMatchObject({ from: "1.0.0", to: "1.0.1", action: "deploy", note: "go" });
    expect(live.agents.get("writer")!.systemPrompt).toBe("Be playful.");
    expect((await versioning.resolve("writer"))!.version).toBe("1.0.1");
  });

  it("refuses to publish without changes, and honours explicit versions and bumps", async () => {
    const { versioning } = setup();
    await expect(versioning.publish("writer", { actor: "x" })).rejects.toMatchObject({ code: "NO_CHANGES" });
    await versioning.updateDraft("writer", { role: "Edits" }, "x");
    await expect(versioning.publish("writer", { actor: "x", version: "0.9.0" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await versioning.publish("writer", { actor: "x", bump: "major" })).version).toBe("2.0.0");
    await versioning.updateDraft("writer", { role: "Edits more" }, "x");
    expect((await versioning.publish("writer", { actor: "x", version: "2.5.0" })).bump).toBe("custom");
  });

  it("deploys clear fields the version does not have, and rollback is one step back, audited", async () => {
    const { versioning, live, store } = setup();
    await versioning.updateDraft("writer", { model: "openai:gpt-5", skills: undefined }, "x");
    const v2 = await versioning.publish("writer", { actor: "x" });
    expect(v2.version).toBe("2.0.0");
    await versioning.deploy("writer", "2.0.0", { actor: "person:a@x.io" });
    expect(live.agents.get("writer")!.skills).toBeUndefined();
    expect(live.agents.get("writer")!.model).toBe("openai:gpt-5");

    const back = await versioning.rollback("writer", { actor: "person:b@x.io", note: "regression" });
    expect(back).toMatchObject({ action: "rollback", from: "2.0.0", to: "1.0.0", actor: "person:b@x.io", note: "regression" });
    expect(live.agents.get("writer")!.skills).toEqual(["style"]);
    expect(live.agents.get("writer")!.model).toBe(writer.model);
    expect(live.agents.get("writer")!.createdAt).toBe(writer.createdAt);

    const history = await versioning.deploys("writer", { withDiff: true });
    expect(history.map((d) => `${d.action}:${d.from ?? "-"}→${d.to}`)).toEqual(["rollback:2.0.0→1.0.0", "deploy:1.0.0→2.0.0", "initial:-→1.0.0"]);
    expect(history[0]!.diff!.unified).toContain("-model: openai:gpt-5\n");
    expect((await store.listDeploys("writer", 1))).toHaveLength(1);
    // nothing earlier than 1.0.0
    await expect(versioning.rollback("writer", { actor: "x" })).rejects.toBeTruthy();
  });

  it("resolves pinned versions over the agent's runtime fields; in-flight configs are copies", async () => {
    const { versioning } = setup();
    await versioning.updateDraft("writer", { systemPrompt: "v2" }, "x");
    await versioning.publish("writer", { actor: "x" });
    await versioning.deploy("writer", "1.0.1", { actor: "x" });
    const pinned = await versioning.resolve("writer", "1.0.0");
    expect(pinned).toMatchObject({ version: "1.0.0", ref: "1.0.0" });
    expect(pinned!.agent).toMatchObject({ name: "writer", createdAt: writer.createdAt, systemPrompt: writer.systemPrompt });
    const prod = await versioning.resolve("writer", "production");
    expect(prod).toMatchObject({ version: "1.0.1", ref: "production" });
    expect(prod!.agent.systemPrompt).toBe("v2");
    // a run started on 1.0.1 keeps its config when production moves
    await versioning.rollback("writer", { actor: "x" });
    expect(prod!.agent.systemPrompt).toBe("v2");
    expect((await versioning.resolve("writer"))!.agent.systemPrompt).toBe(writer.systemPrompt);
    await expect(versioning.resolve("writer", "7.0.0")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(versioning.resolve("writer", "staging")).rejects.toMatchObject({ code: "INVALID" });
    expect(await versioning.resolve("ghost")).toBeUndefined();
  });

  it("records a change written live as a new deployed version and carries it into the draft", async () => {
    const { versioning, live } = setup();
    await versioning.updateDraft("writer", { role: "Draft role" }, "x");
    await live.port.writeLive("writer", { voiceReplies: "voice" });
    const v = await versioning.recordLive("writer", { actor: "writer", note: "set_voice_replies" });
    expect(v).toMatchObject({ version: "1.1.0", author: "writer" });
    expect(await versioning.pointer("writer")).toBe("1.1.0");
    const { config } = await versioning.draftConfig("writer");
    expect(config).toMatchObject({ role: "Draft role", voiceReplies: "voice" });
    // nothing to record when live matches production
    expect(await versioning.recordLive("writer", { actor: "x" })).toBeUndefined();
  });

  it("never versions volatile (mission) agents", async () => {
    const live = liveAgents([{ name: "tmp", volatile: true, missionGroup: "m1", role: "x" }]);
    const versioning = new AgentVersioning(new InMemoryAgentVersionStore(), live.port);
    expect(await versioning.ensureInitial("tmp")).toBeUndefined();
    expect(await versioning.resolve("tmp")).toMatchObject({ ref: "production" });
    expect((await versioning.migrateAll()).initialized).toEqual([]);
  });

  it("records the version on a run context", () => {
    const ctx = buildRunContext({ runId: "r1", agent: { name: "writer" }, agentVersion: "1.2.0" });
    expect(ctx.agentVersion).toBe("1.2.0");
  });
});

describe("FileAgentVersionStore", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "polpo-agent-versions-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("persists versions, draft, pointers and deploys across instances", async () => {
    const { versioning } = setup(new FileAgentVersionStore(dir));
    await versioning.updateDraft("writer", { role: "Edits" }, "x");
    await versioning.publish("writer", { actor: "x" });
    await versioning.deploy("writer", "1.0.1", { actor: "x" });
    await versioning.updateDraft("writer", { role: "Pending" }, "x");

    const reopened = new FileAgentVersionStore(dir);
    expect((await reopened.listVersions("writer")).map((v) => v.version)).toEqual(["1.0.0", "1.0.1"]);
    expect((await reopened.getDraft("writer"))!.config.role).toBe("Pending");
    expect((await reopened.getPointers("writer"))[0]).toMatchObject({ pointer: "production", version: "1.0.1" });
    expect((await reopened.listDeploys("writer")).map((d) => d.to)).toEqual(["1.0.1", "1.0.0"]);
    await expect(reopened.addVersion({ ...(await reopened.getVersion("writer", "1.0.1"))! })).rejects.toThrow(/already exists/);
    await reopened.deleteAgent("writer");
    expect(await new FileAgentVersionStore(dir).listVersions("writer")).toEqual([]);
  });
});

describe("TaskManager: pinned agent versions", () => {
  function taskManager(versioning?: AgentVersioning) {
    const tasks: Record<string, unknown>[] = [];
    const ctx = {
      registry: {
        getAllTasks: async () => tasks,
        addTask: async (t: Record<string, unknown>) => { const task = { id: `t${tasks.length + 1}`, status: "pending", ...t }; tasks.push(task); return task; },
        updateTask: async (id: string, u: Record<string, unknown>) => { const t = tasks.find((x) => x.id === id)!; Object.assign(t, u); return t; },
      },
      hooks: { runBeforeSync: (_e: string, data: unknown) => ({ cancelled: false, data }), runAfter: async () => undefined },
      emitter: { emit: () => true },
      config: { settings: { maxRetries: 2 } },
      ...(versioning ? { agentVersions: versioning } : {}),
    };
    return { tm: new TaskManager(ctx as never), tasks };
  }

  it("splits assignTo name@version into the assignee and its pinned version", async () => {
    const { versioning } = setup();
    await versioning.ensureInitial("writer");
    const { tm, tasks } = taskManager(versioning);
    const t = await tm.addTask({ title: "A", description: "a", assignTo: "writer@1.0.0" });
    expect(t).toMatchObject({ assignTo: "writer", agentVersion: "1.0.0" });
    const p = await tm.addTask({ title: "B", description: "b", assignTo: "writer@production" });
    expect(p.assignTo).toBe("writer");
    expect(p.agentVersion).toBeUndefined();
    await expect(tm.addTask({ title: "C", description: "c", assignTo: "writer@4.0.0" })).rejects.toThrow(/no published version 4\.0\.0/);
    await expect(tm.addTask({ title: "D", description: "d", assignTo: "writer@staging" })).rejects.toThrow(/not a version/);
    // reassigning clears or sets the pin
    await tm.updateTaskAssignment(String(tasks[0]!.id), "writer");
    expect(tasks[0]!.agentVersion).toBeUndefined();
    await tm.updateTaskAssignment(String(tasks[0]!.id), "writer@1.0.0");
    expect(tasks[0]!.agentVersion).toBe("1.0.0");
  });
});

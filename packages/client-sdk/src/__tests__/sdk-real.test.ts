import { describe, it, expect, beforeAll } from "vitest";
import { PolpoClient, ChatCompletionStream } from "../index.js";

/**
 * Real E2E tests for @polpo-ai/sdk against production (api.polpo.sh).
 *
 * Requires: POLPO_API_KEY env var (sk_live_...)
 * Run: POLPO_API_KEY=sk_live_... npx vitest run src/__tests__/sdk-real.test.ts
 */
const BASE_URL = process.env.POLPO_BASE_URL ?? "https://api.polpo.sh";
const API_KEY = process.env.POLPO_API_KEY;

describe("@polpo-ai/sdk — Real E2E", () => {
  let client: PolpoClient;

  beforeAll(() => {
    if (!API_KEY) throw new Error("POLPO_API_KEY is required");
    client = new PolpoClient({ baseUrl: BASE_URL, apiKey: API_KEY });
  });

  // ── Agents ─────────────────────────────────────────────────

  it("lists agents", async () => {
    const agents = await client.getAgents();
    expect(Array.isArray(agents)).toBe(true);
    const coder = agents.find((a) => a.name === "coder");
    expect(coder).toBeDefined();
    expect(coder!.model).toContain("grok");
  });

  // ── Memory ─────────────────────────────────────────────────

  it("saves and reads project memory", async () => {
    const saved = await client.saveMemory("# SDK Test\n\nWritten by @polpo-ai/sdk test suite.");
    expect(saved.saved).toBe(true);

    const mem = await client.getMemory();
    expect(mem.content).toContain("SDK Test");
  });

  it("saves and reads agent memory", async () => {
    const saved = await client.saveAgentMemory("coder", "SDK test: agent memory works.");
    expect(saved.saved).toBe(true);

    const mem = await client.getAgentMemory("coder");
    expect(mem.content).toContain("agent memory works");
  });

  // ── Chat Completions (non-streaming) ───────────────────────

  it("completes a non-streaming request", async () => {
    const response = await client.chatCompletions({
      agent: "coder",
      messages: [{ role: "user", content: "What is 2+2? Reply with just the number." }],
      stream: false,
    });

    expect(response.id).toMatch(/^chatcmpl-/);
    expect(response.object).toBe("chat.completion");
    expect(response.choices).toHaveLength(1);
    expect(response.choices[0].message.role).toBe("assistant");
    expect(response.choices[0].message.content).toContain("4");
  }, 30_000);

  // ── Chat Completions (streaming) ───────────────────────────

  it("streams a completion", async () => {
    const stream = client.chatCompletionsStream({
      agent: "coder",
      messages: [{ role: "user", content: "Say hello and nothing else." }],
    });

    expect(stream).toBeInstanceOf(ChatCompletionStream);

    let fullContent = "";
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) fullContent += delta;
    }

    expect(fullContent.toLowerCase()).toContain("hello");
  }, 30_000);

  // ── Sessions ───────────────────────────────────────────────

  it("lists chat sessions", async () => {
    const { sessions } = await client.getSessions();
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBeGreaterThan(0);
  });

  // ── Vault ───────────────────────────────────────────────

  it("saves, lists, and deletes a vault entry", async () => {
    // Save
    const saved = await client.saveVaultEntry({
      agent: "coder",
      service: "sdk-test-service",
      type: "api_key",
      label: "SDK test key",
      credentials: { token: "test-secret-123" },
    });
    expect(saved.service).toBe("sdk-test-service");
    expect(saved.keys).toContain("token");

    // List
    const entries = await client.listVaultEntries("coder");
    const found = entries.find((e) => e.service === "sdk-test-service");
    expect(found).toBeDefined();
    expect(found!.type).toBe("api_key");

    // Delete
    const removed = await client.removeVaultEntry("coder", "sdk-test-service");
    expect(removed.removed).toBe(true);

    // Verify deleted
    const after = await client.listVaultEntries("coder");
    expect(after.find((e) => e.service === "sdk-test-service")).toBeUndefined();
  });

  // ── Teams ──────────────────────────────────────────────

  it("lists teams", async () => {
    const teams = await client.getTeams();
    expect(Array.isArray(teams)).toBe(true);
  });

  // ── SSE Events ─────────────────────────────────────────

  it("connects to SSE event stream", async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(`${BASE_URL}/v1/events`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: controller.signal,
    }).catch(() => null);

    clearTimeout(timeout);

    if (res) {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/event-stream");
    }
  });

  // ── Tasks ───────────────────────────────────────────────

  it("creates, lists, and deletes a task", async () => {
    // Create as draft (so the orchestrator tick doesn't pick it up)
    const task = await client.createTask({
      title: "SDK test task",
      description: "Created by SDK E2E test",
      assignTo: "coder",
      draft: true,
    });
    expect(task.id).toBeDefined();
    expect(task.title).toBe("SDK test task");
    expect(task.status).toBe("draft");

    // List
    const tasks = await client.getTasks();
    expect(tasks.find((t) => t.id === task.id)).toBeDefined();

    // Kill
    const killed = await client.killTask(task.id);
    expect(killed.killed).toBe(true);
  });

  // ── Missions ───────────────────────────────────────────

  it("creates, lists, gets, and deletes a mission", async () => {
    // Create
    const mission = await client.createMission({
      name: `sdk-test-${Date.now()}`,
      prompt: "SDK E2E test mission",
      data: JSON.stringify({
        tasks: [{ title: "SDK mission task", description: "Do nothing", assignTo: "coder" }],
      }),
    });
    expect(mission.id).toBeDefined();
    expect(mission.status).toBe("draft");

    // List
    const missions = await client.getMissions();
    expect(missions.find((m) => m.id === mission.id)).toBeDefined();

    // Get
    const fetched = await client.getMission(mission.id);
    expect(fetched.id).toBe(mission.id);
    expect(fetched.prompt).toBe("SDK E2E test mission");

    // Delete
    const deleted = await client.deleteMission(mission.id);
    expect(deleted.deleted).toBe(true);
  });

  // ── Attachments ─────────────────────────────────────────────

  it("attachment CRUD via raw fetch", async () => {
    const headers = { Authorization: `Bearer ${API_KEY}` };

    // Upload
    const formData = new FormData();
    formData.append("sessionId", "sdk-e2e-session");
    formData.append("file", new File(["SDK test content"], "sdk-test.txt", { type: "text/plain" }));

    const uploadRes = await fetch(`${BASE_URL}/api/v1/attachments`, {
      method: "POST",
      headers,
      body: formData,
    });
    expect(uploadRes.status).toBe(201);
    const uploaded = await uploadRes.json();
    expect(uploaded.ok).toBe(true);
    expect(uploaded.data.filename).toBe("sdk-test.txt");
    const attachmentId = uploaded.data.id;

    // List by session
    const listRes = await fetch(`${BASE_URL}/api/v1/attachments?sessionId=sdk-e2e-session`, { headers });
    expect(listRes.status).toBe(200);
    const listed = await listRes.json();
    expect(listed.data.find((a: any) => a.id === attachmentId)).toBeDefined();

    // Download
    const dlRes = await fetch(`${BASE_URL}/api/v1/attachments/${attachmentId}/download`, { headers });
    expect(dlRes.status).toBe(200);
    const content = await dlRes.text();
    expect(content).toBe("SDK test content");

    // Delete
    const delRes = await fetch(`${BASE_URL}/api/v1/attachments/${attachmentId}`, {
      method: "DELETE",
      headers,
    });
    expect(delRes.status).toBe(200);

    // Verify deleted
    const getRes = await fetch(`${BASE_URL}/api/v1/attachments/${attachmentId}`, { headers });
    expect(getRes.status).toBe(404);
  });

  // ── Health ─────────────────────────────────────────────────

  it("health check", async () => {
    const health = await client.getHealth();
    expect(health.status).toBe("ok");
  });
});

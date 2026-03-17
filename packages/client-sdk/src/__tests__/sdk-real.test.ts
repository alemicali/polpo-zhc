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

  // ── Health ─────────────────────────────────────────────────

  it("health check", async () => {
    const health = await client.getHealth();
    expect(health.status).toBe("ok");
  });
});

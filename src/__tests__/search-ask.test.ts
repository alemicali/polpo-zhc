/**
 * Ask Polpo from the search (src/server/search/ask.ts): the fast path, safe routes, the tool loop
 * with a fake model (search, suggested results, intents, limits, redaction), the REST route (JSON
 * and SSE), the app (auth, no model, rate limit) and polpo_search_ask.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import {
  ASK_LIMITS, DEFAULT_ASK_PAGES, matchNavigation, runSearchAsk, safeRoute,
  type AskAssistantMessage, type AskDeps, type AskEvent, type AskLlm, type AskLlmRequest, type AskToolCall,
} from "../server/search/ask.js";
import { SearchEngine, type SearchDoc, type SearchResponse, type SearchResult } from "../server/search/engine.js";
import { searchRoutes } from "../server/routes/search.js";
import { handleMcpRequest, type McpDeps } from "../server/mcp.js";

const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0.001 } };
const call = (name: string, args: Record<string, unknown>, id = `c-${name}`): AskToolCall => ({ type: "toolCall", id, name, arguments: args });
const reply = (...content: AskAssistantMessage["content"]): AskAssistantMessage => ({ role: "assistant", content, usage, stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop" });
const text = (t: string) => ({ type: "text" as const, text: t });

/** A fake model answering with the scripted messages in turn (streaming their text). */
function scripted(...turns: AskAssistantMessage[]): AskLlm & { requests: AskLlmRequest[] } {
  const requests: AskLlmRequest[] = [];
  const llm = (async (req: AskLlmRequest) => {
    requests.push({ ...req, messages: [...req.messages] });
    const msg = turns[Math.min(requests.length - 1, turns.length - 1)]!;
    for (const c of msg.content) if (c.type === "text") req.onDelta(c.text);
    return msg;
  }) as AskLlm & { requests: AskLlmRequest[] };
  llm.requests = requests;
  return llm;
}

const hit = (over: Partial<SearchResult> & { id: string; title: string }): SearchResult => ({ type: "task", url: `/tasks/${over.id}`, score: 500, ...over });
const response = (items: SearchResult[]): SearchResponse => ({ query: "", took: 1, partial: [], groups: [], items, nextCursor: null });

function deps(llm: AskLlm, items: SearchResult[] = []): AskDeps & { search: ReturnType<typeof vi.fn> } {
  return { llm, search: vi.fn(async () => response(items)), model: { provider: "anthropic", id: "claude-test" }, now: () => new Date("2026-11-24T10:00:00Z") };
}

describe("the fast path", () => {
  const pages = DEFAULT_ASK_PAGES;
  it("resolves obvious navigation in Italian and English without the model", () => {
    expect(matchNavigation("vai agli artifatti", pages)?.to).toBe("/artifacts");
    expect(matchNavigation("Vai alle attività", pages)?.to).toBe("/tasks");
    expect(matchNavigation("apri le impostazioni dei canali", pages)?.to).toBe("/config?section=channels");
    expect(matchNavigation("open channels settings", pages)?.to).toBe("/config?section=channels");
    expect(matchNavigation("go to agents", pages)?.to).toBe("/agents");
    expect(matchNavigation("portami alla dashboard", pages)?.to).toBe("/dashboard");
    expect(matchNavigation("vai ai computer", pages)?.to).toBe("/computers");
    expect(matchNavigation("apri le impostazioni dei computer", pages)?.to).toBe("/config?section=computers");
  });

  it("anything less obvious goes to the model", () => {
    expect(matchNavigation("artifacts", pages)).toBeNull();
    expect(matchNavigation("apri la chat con coach", pages)).toBeNull();
    expect(matchNavigation("mostrami i task falliti ieri", pages)).toBeNull();
    expect(matchNavigation("go to the moon", pages)).toBeNull();
  });

  it("answers with a navigate intent and no rounds", async () => {
    const events: AskEvent[] = [];
    const out = await runSearchAsk({ q: "vai agli artefatti" }, null, (e) => events.push(e));
    expect(out).toMatchObject({ fastPath: true, rounds: 0, intents: [{ kind: "navigate", route: "/artifacts", auto: true }] });
    expect(events.map((e) => e.type)).toEqual(["intent", "done"]);
  });

  it("without a model and no obvious page: NO_MODEL", async () => {
    await expect(runSearchAsk({ q: "which tasks failed?" }, null)).rejects.toMatchObject({ code: "NO_MODEL" });
  });
});

describe("safe routes", () => {
  const known = ["/tasks", "/config?section=general", "/chat"];
  it("only relative dashboard routes under a known page", () => {
    expect(safeRoute("/tasks/t1", known)).toBe("/tasks/t1");
    expect(safeRoute("/config?section=channels", known)).toBe("/config?section=channels");
    expect(safeRoute("/chat?agent=coach", known)).toBe("/chat?agent=coach");
    for (const bad of ["https://evil.example", "//evil.example/x", "javascript:alert(1)", "/javascript:alert(1)", "/unknown", "/tasks/<script>", "tasks", 42]) {
      expect(safeRoute(bad, known), String(bad)).toBeNull();
    }
  });
});

describe("the tool loop", () => {
  it("searches, suggests the best results and answers in a line (usage summed, text streamed)", async () => {
    const llm = scripted(
      reply(call("search", { query: "invoice", types: ["task", "nope"] })),
      reply(text("Ho trovato il task delle fatture."), call("suggest_results", { keys: ["task:t2", "task:unknown"] })),
      reply(text("Eccolo.")),
    );
    const d = deps(llm, [hit({ id: "t1", title: "Invoice draft" }), hit({ id: "t2", title: "Invoice run", meta: { status: "failed" } })]);
    const events: AskEvent[] = [];
    const out = await runSearchAsk({ q: "dov'è il task delle fatture?", route: "/dashboard" }, d, (e) => events.push(e));
    expect(d.search).toHaveBeenCalledWith("invoice", expect.objectContaining({ types: ["task"], limit: ASK_LIMITS.resultsPerSearch }));
    expect(out.items.map((i) => i.id)).toEqual(["t2"]);
    expect(out.answer).toBe("Ho trovato il task delle fatture. Eccolo.");
    expect(out.rounds).toBe(3);
    expect(out.usage).toMatchObject({ provider: "anthropic", model: "claude-test", inputTokens: 300, outputTokens: 60, totalTokens: 360 });
    expect(out.usage!.cost).toBeCloseTo(0.003);
    expect(events.filter((e) => e.type === "delta").map((e) => (e as { text: string }).text).join("")).toBe("Ho trovato il task delle fatture. Eccolo.");
    expect(events.find((e) => e.type === "results")).toMatchObject({ items: [{ id: "t2" }] });
    // the model saw the result lines with their keys, and the page the person is on
    const toolResult = llm.requests[1]!.messages.at(-1) as { role: string; content: Array<{ text: string }> };
    expect(toolResult.content[0]!.text).toContain("[task:t2] task · Invoice run (failed)");
    expect(llm.requests[0]!.systemPrompt).toContain("The person is on /dashboard");
    expect(llm.requests[0]!.systemPrompt).toContain("Channels (Settings · Integrations): /config?section=channels");
  });

  it("without suggest_results the first results found are suggested", async () => {
    const llm = scripted(reply(call("search", { query: "deploy" })), reply(text("Two deploy tasks.")));
    const out = await runSearchAsk({ q: "deploy" }, deps(llm, [hit({ id: "a", title: "Deploy" }), hit({ id: "b", title: "Deploy 2" })]));
    expect(out.items.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("navigate ends the turn with an automatic intent; an unknown route is refused to the model", async () => {
    const llm = scripted(
      reply(call("navigate", { route: "https://evil.example" })),
      reply(text("Apro i canali."), call("navigate", { route: "/config?section=channels", label: "Channels" })),
      reply(text("never reached")),
    );
    const out = await runSearchAsk({ q: "dove configuro telegram?" }, deps(llm));
    expect(llm.requests).toHaveLength(2);
    const refused = llm.requests[1]!.messages.at(-1) as { isError: boolean; content: Array<{ text: string }> };
    expect(refused.isError).toBe(true);
    expect(out.intents).toEqual([{ kind: "navigate", route: "/config?section=channels", label: "Channels", auto: true }]);
    expect(out.answer).toBe("Apro i canali.");
  });

  it("open_result opens a result found (a chat with an agent)", async () => {
    const llm = scripted(reply(call("search", { query: "coach", types: ["agent", "chat"] })), reply(call("open_result", { key: "chat:s1" })));
    const out = await runSearchAsk({ q: "apri la chat con coach" }, deps(llm, [hit({ type: "chat", id: "s1", title: "Chat with coach", url: "/chat?session=s1" })]));
    expect(out.intents).toEqual([{ kind: "open", route: "/chat?session=s1", label: "Chat with coach", key: "chat:s1", auto: true }]);
  });

  it("view commands run at once; commands that change data and suggested actions only become buttons", async () => {
    const commands = [
      { id: "theme", label: "Switch to dark theme" },
      { id: "new-task", label: "New task", argument: true, confirm: true },
    ];
    const view = await runSearchAsk({ q: "tema scuro", commands }, deps(scripted(reply(call("run_command", { id: "theme" })))));
    expect(view.intents).toEqual([{ kind: "command", id: "theme", label: "Switch to dark theme", auto: true }]);

    const llm = scripted(
      reply(call("run_command", { id: "new-task", argument: "fix the login" }), call("suggest_action", { label: "Create the task", message: "Create a task: fix the login" })),
      reply(text("Posso crearlo: conferma col pulsante.")),
    );
    const out = await runSearchAsk({ q: "crea un task per sistemare il login", commands }, deps(llm));
    expect(out.intents).toEqual([
      { kind: "command", id: "new-task", label: "New task", argument: "fix the login", auto: false },
      { kind: "handoff", label: "Create the task", message: "Create a task: fix the login", auto: false },
    ]);
    expect(out.intents.every((i) => !i.auto)).toBe(true);
  });

  it("is bounded: a few rounds, a few searches, the last round without tools", async () => {
    const llm = scripted(reply(call("search", { query: "x" }), call("search", { query: "y" })));
    const d = deps(llm, [hit({ id: "t1", title: "X" })]);
    const out = await runSearchAsk({ q: "loop forever" }, d);
    expect(out.rounds).toBe(ASK_LIMITS.rounds);
    expect(d.search.mock.calls.length).toBe(ASK_LIMITS.searches);
    expect(llm.requests.at(-1)!.tools).toEqual([]);
    expect(llm.requests[0]!.maxTokens).toBe(ASK_LIMITS.maxTokens);
  });

  it("stops at the deadline and reports a model failure", async () => {
    vi.useFakeTimers();
    try {
      const slow: AskLlm = ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
      const p = runSearchAsk({ q: "slow" }, deps(slow));
      const settled = expect(p).rejects.toMatchObject({ code: "TIMEOUT" });
      await vi.advanceTimersByTimeAsync(ASK_LIMITS.deadlineMs + 10);
      await settled;
    } finally {
      vi.useRealTimers();
    }
    const failing = scripted({ role: "assistant", content: [], stopReason: "error", errorMessage: "401 invalid x-api-key" });
    await expect(runSearchAsk({ q: "anything" }, deps(failing))).rejects.toMatchObject({ code: "LLM_ERROR", message: "401 invalid x-api-key" });
  });

  it("never sends a secret to the model, from the question or from the results", async () => {
    const llm = scripted(reply(call("search", { query: "deploy" })), reply(text("ok")));
    await runSearchAsk(
      { q: "why does token=supersecretvalue123 fail with sk-ant-api03-abcdefghijklmnop1234?" },
      deps(llm, [hit({ id: "t1", title: "Deploy with ghp_abcdefghijklmnopqrstuvwxyz12", snippet: { text: "password=hunter22 in the log", highlights: [] } })]),
    );
    const seen = JSON.stringify(llm.requests.map((r) => r.messages));
    for (const leak of ["supersecretvalue123", "sk-ant-api03", "ghp_abc", "hunter22"]) expect(seen).not.toContain(leak);
  });
});

describe("POST /api/v1/search/ask", () => {
  const engine = new SearchEngine(() => [{ type: "task", docs: async () => [{ type: "task", id: "t1", title: "Invoice run", url: "/tasks/t1" } as SearchDoc] }]);
  const post = (app: ReturnType<typeof searchRoutes>, body: unknown) => app.request("/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("answers JSON with the engine as the model's search, and records the usage", async () => {
    const recordUsage = vi.fn(async () => {});
    const llm = scripted(reply(call("search", { query: "invoice" })), reply(text("Found it."), call("suggest_results", { keys: ["task:t1"] })), reply(text("")));
    const app = searchRoutes(() => engine, () => ({ model: async () => ({ llm, provider: "anthropic", id: "claude-test" }), recordUsage }));
    const body = await (await post(app, { q: "invoice?" })).json() as any;
    expect(body.ok).toBe(true);
    expect(body.data.items[0]).toMatchObject({ type: "task", id: "t1", url: "/tasks/t1" });
    expect(body.data.answer).toBe("Found it.");
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: "anthropic", totalTokens: 360 }));
  });

  it("streams events with stream: true", async () => {
    const llm = scripted(reply(text("Ciao")));
    const app = searchRoutes(() => engine, () => ({ model: async () => ({ llm, provider: "p", id: "m" }) }));
    const res = await post(app, { q: "ciao", stream: true });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const events = (await res.text()).split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
    expect(events.map((e) => e.type)).toEqual(["delta", "done"]);
    expect(events[1].result.answer).toBe("Ciao");
  });

  it("the fast path needs no model; without one the rest is a clear 503 (and an error event when streaming)", async () => {
    const model = vi.fn(async () => { throw Object.assign(new Error("Polpo's model is not configured"), { code: "NO_MODEL" }); });
    const app = searchRoutes(() => engine, () => ({ model }));
    const fast = await (await post(app, { q: "go to tasks" })).json() as any;
    expect(fast.data).toMatchObject({ fastPath: true, intents: [{ kind: "navigate", route: "/tasks" }] });
    expect(model).not.toHaveBeenCalled();

    const none = searchRoutes(() => engine);
    const res = await post(none, { q: "which tasks failed?" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ ok: false, code: "NO_MODEL" });
    const streamed = await (await post(none, { q: "which tasks failed?", stream: true })).text();
    expect(streamed).toContain("\"type\":\"error\"");
    expect(streamed).toContain("NO_MODEL");
  });

  it("validates the question", async () => {
    const app = searchRoutes(() => engine);
    expect((await post(app, { q: "" })).status).toBe(400);
    expect((await post(app, { q: "x".repeat(501) })).status).toBe(400);
  });
});

describe("in the app", () => {
  const KEY = "search-ask-test-key";
  const previousVaultKey = process.env.POLPO_VAULT_KEY;
  const previousModel = process.env.POLPO_MODEL;
  let tmpDir: string;
  let app: Hono;

  beforeAll(async () => {
    process.env.POLPO_VAULT_KEY = randomBytes(32).toString("hex");
    delete process.env.POLPO_MODEL;
    tmpDir = await mkdtemp(join(tmpdir(), "polpo-search-ask-"));
    await mkdir(join(tmpDir, ".polpo"), { recursive: true });
    await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({ project: "ask", team: { name: "t", agents: [{ name: "agent-1", role: "Test" }] }, settings: { logLevel: "quiet" } }));
    const { Orchestrator } = await import("../core/orchestrator.js");
    const { SSEBridge } = await import("../server/sse-bridge.js");
    const { createApp } = await import("../server/app.js");
    const orchestrator = new Orchestrator(tmpDir);
    await orchestrator.initInteractive("ask", { name: "t", agents: [{ name: "agent-1", role: "Test" }] });
    app = createApp(orchestrator, new SSEBridge(orchestrator), { workDir: tmpDir, apiKeys: [KEY] });
  }, 30_000);

  afterAll(async () => {
    if (previousVaultKey === undefined) delete process.env.POLPO_VAULT_KEY;
    else process.env.POLPO_VAULT_KEY = previousVaultKey;
    if (previousModel !== undefined) process.env.POLPO_MODEL = previousModel;
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  const ask = (q: string, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }) =>
    app.request("/api/v1/search/ask", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "10.9.9.9", ...headers }, body: JSON.stringify({ q }) });

  it("needs the key, answers the fast path, says when the model is missing, and is rate limited", async () => {
    expect((await ask("go to tasks", {})).status).toBe(401);
    const fast = await ask("vai alle missioni");
    expect(fast.status).toBe(200);
    expect((await fast.json() as any).data.intents[0].route).toBe("/missions");
    const none = await ask("which tasks failed yesterday?");
    expect(none.status).toBe(503);
    expect((await none.json() as any).code).toBe("NO_MODEL");
    let limited = 0;
    for (let i = 0; i < 25; i++) if ((await ask("go to tasks")).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
});

describe("polpo_search_ask (MCP)", () => {
  it("returns the answer, the results and the intents, executing nothing", async () => {
    const api: McpDeps["api"] = vi.fn(async (method, path, body) => {
      expect(method).toBe("POST");
      expect(path).toBe("/api/v1/search/ask");
      expect(body).toEqual({ q: "apri la chat con coach" });
      return {
        status: 200, headers: new Headers(), body: { ok: true, data: {
          answer: "Ecco la chat con coach.", fastPath: false, rounds: 2,
          items: [{ type: "chat", id: "s1", title: "Chat with coach", url: "/chat?session=s1", score: 1 }],
          intents: [
            { kind: "open", route: "/chat?session=s1", label: "Chat with coach", key: "chat:s1", auto: true },
            { kind: "handoff", label: "Create the task", message: "Create a task: x", auto: false },
          ],
        } },
      };
    });
    const res = await handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "polpo_search_ask", arguments: { q: "apri la chat con coach" } } }),
    }), { api, version: "x", dashboardUrl: "https://polpo.example.com" });
    const result = (await res.json() as any).result;
    const out = result.content[0].text as string;
    expect(out).toContain("Ecco la chat con coach.");
    expect(out).toContain("- Chat with coach [session s1] https://polpo.example.com/chat?session=s1");
    expect(out).toContain("- Open Chat with coach: https://polpo.example.com/chat?session=s1");
    expect(out).toContain("- Create the task: ask Polpo “Create a task: x” (polpo_ask)");
    expect(result.structuredContent).toMatchObject({ answer: "Ecco la chat con coach.", fast_path: false });
    expect(result.structuredContent.intents).toHaveLength(2);
    expect(api).toHaveBeenCalledTimes(1);
  });
});

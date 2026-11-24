/**
 * The global search (src/server/search): matching, ranking, types, pages, budget and cancellation,
 * chat messages (index and fallback scan), secrets, the REST route and polpo_search.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, MessageSearchHit, Session, SessionStore } from "@polpo-ai/core/session-store";
import { editDistance, fold, maskSecrets, parseQuery, snippet, stem, termWordScore } from "../server/search/text.js";
import { SearchEngine, scoreDoc, type SearchDoc, type SearchSource } from "../server/search/engine.js";
import { buildSearchSources, type SearchSourceDeps } from "../server/search/sources.js";
import { searchRoutes } from "../server/routes/search.js";
import { handleMcpRequest, type McpDeps } from "../server/mcp.js";

const doc = (over: Partial<SearchDoc> & { id: string; title: string }): SearchDoc => ({ type: "task", url: `/tasks/${over.id}`, ...over });

describe("text", () => {
  it("folds case and diacritics, stems Italian and English plurals", () => {
    expect(fold("Perché CITTÀ")).toBe("perche citta");
    expect(["agenti", "agente", "agents", "agent"].map(stem)).toEqual(["agent", "agent", "agent", "agent"]);
    expect(stem("missioni")).toBe(stem("missione"));
    expect(stem("stories")).toBe("stor");
    expect("story".startsWith(stem("stories"))).toBe(true);
    expect(stem("task")).toBe("task");
  });

  it("matches prefixes, stems and one typo on longer words only", () => {
    const [t] = parseQuery("deplyo").terms; // swapped letters
    expect(termWordScore(t!, "deploy")).toBeGreaterThan(0);
    expect(termWordScore(parseQuery("dep").terms[0]!, "deployment")).toBe(0.85);
    expect(termWordScore(parseQuery("cat").terms[0]!, "car")).toBe(0); // short words forgive nothing
    expect(editDistance("kitten", "sitting", 1)).toBe(2);
    expect(termWordScore(parseQuery("missioni").terms[0]!, "missione")).toBeGreaterThan(0);
  });

  it("snippets the passage around the match, with the matched ranges on the text as written", () => {
    const long = `${"lorem ipsum ".repeat(40)}la città di Bologna ${"dolor sit ".repeat(40)}`;
    const s = snippet(long, parseQuery("citta"));
    expect(s.text.startsWith("… ")).toBe(true);
    expect(s.text.endsWith(" …")).toBe(true);
    const [a, b] = s.highlights[0]!;
    expect(s.text.slice(a, b)).toBe("città");
  });

  it("masks anything that looks like a secret", () => {
    const text = "key sk-ant-api03-abcdefghijklmnop1234 and ghp_abcdefghijklmnopqrstuvwxyz12 password=hunter22 Bearer abcdefghijklmnopqrstu "
      + "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY----- 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq";
    const masked = maskSecrets(text);
    for (const leak of ["sk-ant-api03", "ghp_abc", "hunter22", "abcdefghijklmnopqrstu", "MIIE", "AAHdqTcv"]) expect(masked).not.toContain(leak);
    expect(masked).toContain("password=••••••");
    expect(masked).toContain("Bearer ••••••");
  });
});

describe("ranking", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  const q = parseQuery("deploy");

  it("title = query > title starts with it > word in title > subtitle > content; recent first within a tier", () => {
    const exact = doc({ id: "a", title: "Deploy" });
    const prefix = doc({ id: "b", title: "Deploy the website" });
    const word = doc({ id: "c", title: "Fix the deploy script" });
    const sub = doc({ id: "d", title: "Release", subtitle: "deploy team" });
    const body = doc({ id: "e", title: "Release notes", body: "Then we deploy on Friday" });
    const none = doc({ id: "f", title: "Unrelated" });
    const scores = [exact, prefix, word, sub, body, none].map((d) => scoreDoc(d, q, now).score);
    expect(scores[5]).toBe(0);
    expect([...scores.slice(0, 5)].sort((x, y) => y - x)).toEqual(scores.slice(0, 5));
    const old = doc({ id: "g", title: "Fix the deploy script", updatedAt: "2025-01-01T00:00:00Z" });
    const fresh = doc({ id: "h", title: "Fix the deploy script", updatedAt: "2026-11-24T10:00:00Z" });
    expect(scoreDoc(fresh, q, now).score).toBeGreaterThan(scoreDoc(old, q, now).score);
  });

  it("needs every word (in any field) and ignores accents and plurals", () => {
    const d = doc({ id: "a", title: "Missione città", body: "agenti al lavoro" });
    expect(scoreDoc(d, parseQuery("missioni citta agente"), now).score).toBeGreaterThan(0);
    expect(scoreDoc(d, parseQuery("missioni roma"), now).score).toBe(0);
  });
});

describe("the engine", () => {
  const tasks: SearchSource = { type: "task", docs: async () => Array.from({ length: 12 }, (_, i) => doc({ id: `t${i}`, title: `Invoice run ${i}` })) };
  const agents: SearchSource = { type: "agent", docs: async () => [doc({ type: "agent", id: "invoice", title: "Invoice", url: "/agents/invoice" })] };

  it("groups by type, best group first, with per-type caps and totals", async () => {
    const engine = new SearchEngine(() => [tasks, agents]);
    const r = await engine.search({ q: "invoice", perType: 3 });
    // the agent is called exactly that: its group comes first
    expect(r.groups.map((g) => g.type)).toEqual(["agent", "task"]);
    const taskGroup = r.groups.find((g) => g.type === "task")!;
    expect(taskGroup.items).toHaveLength(3);
    expect(taskGroup.total).toBe(12);
    expect(taskGroup.label).toBe("Tasks");
    expect(r.items.length).toBe(4);
    expect(r.items[0]!.titleHighlights?.length).toBeGreaterThan(0);
  });

  it("filters types and pages through one type with the cursor", async () => {
    const engine = new SearchEngine(() => [tasks, agents]);
    const first = await engine.search({ q: "invoice", types: ["task"], limit: 5 });
    expect(first.groups.map((g) => g.type)).toEqual(["task"]);
    expect(first.items).toHaveLength(5);
    expect(first.nextCursor).toBeTruthy();
    const second = await engine.search({ q: "invoice", types: ["task"], limit: 5, cursor: first.nextCursor });
    const third = await engine.search({ q: "invoice", types: ["task"], limit: 5, cursor: second.nextCursor });
    const ids = [...first.items, ...second.items, ...third.items].map((i) => i.id);
    expect(new Set(ids).size).toBe(12);
    expect(third.nextCursor).toBeNull();
  });

  it("answers within the budget: a slow source is partial, then served from its cache", async () => {
    let calls = 0;
    const slow: SearchSource = { type: "computer", docs: () => new Promise((resolve) => { calls++; setTimeout(() => resolve([doc({ type: "computer", id: "box", title: "Invoice box", url: "/computers/box" })]), 120); }) };
    const engine = new SearchEngine(() => [tasks, slow]);
    const r1 = await engine.search({ q: "invoice", budgetMs: 50 });
    expect(r1.partial).toEqual(["computer"]);
    expect(r1.groups.map((g) => g.type)).toEqual(["task"]);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const r2 = await engine.search({ q: "invoice", budgetMs: 50 });
    expect(r2.partial).toEqual([]);
    expect(r2.groups.map((g) => g.type)).toContain("computer");
    expect(calls).toBe(1);
  });

  it("a failing source does not fail the search", async () => {
    const broken: SearchSource = { type: "skill", docs: async () => { throw new Error("boom"); } };
    const r = await new SearchEngine(() => [tasks, broken]).search({ q: "invoice" });
    expect(r.partial).toEqual(["skill"]);
    expect(r.items.length).toBeGreaterThan(0);
  });

  it("stops a query the client cancelled", async () => {
    const hang: SearchSource = { type: "brain", query: (_q, ctx) => new Promise((_resolve, reject) => ctx.signal.addEventListener("abort", () => reject(Object.assign(new Error("x"), { name: "AbortError" })))) };
    const controller = new AbortController();
    const p = new SearchEngine(() => [hang]).search({ q: "invoice", signal: controller.signal, budgetMs: 5000 });
    setTimeout(() => controller.abort(), 10);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("an empty query returns nothing and warms the sources", async () => {
    const load = vi.fn(async () => [] as SearchDoc[]);
    const engine = new SearchEngine(() => [{ type: "task", docs: load }]);
    expect((await engine.search({ q: "  " })).items).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

// ── Sources ───────────────────────────────────────────────────────────

function sessionStore(sessions: Session[], messages: Record<string, Message[]>, index?: (terms: string[]) => MessageSearchHit[]): SessionStore {
  return {
    listSessions: async () => sessions,
    getRecentMessages: async (id: string, n: number) => (messages[id] ?? []).slice(-n),
    ...(index ? { searchMessages: async ({ terms }: { terms: string[] }) => index(terms) } : {}),
  } as unknown as SessionStore;
}

function deps(over: Partial<SearchSourceDeps> = {}): SearchSourceDeps {
  return {
    api: async () => undefined,
    sessions: () => undefined,
    rooms: () => undefined,
    tasks: async () => [],
    missions: async () => [],
    artifacts: () => undefined,
    files: () => ({ roots: [], base: "/" }),
    recentEvents: () => [],
    ...over,
  };
}

const session = (id: string, title: string, agent?: string): Session => ({ id, title, createdAt: "2026-11-20T00:00:00Z", updatedAt: "2026-11-23T00:00:00Z", messageCount: 2, ...(agent ? { agent } : {}) });
const msg = (id: string, role: "user" | "assistant", content: string, ts = "2026-11-23T10:00:00Z"): Message => ({ id, role, content, ts });

describe("chats", () => {
  it("finds messages through the index, one result per chat with the best message, who said it and the snippet", async () => {
    const store = sessionStore(
      [session("s1", "Weekly plan", "coach"), session("s2", "Taxes")],
      {},
      (terms) => {
        expect(terms).toEqual(["invoic"]);
        return [
          { sessionId: "s1", messageId: "m1", role: "assistant", content: "I sent the invoices for March to the accountant", ts: "2026-11-23T10:00:00Z" },
          { sessionId: "s1", messageId: "m2", role: "user", content: "Did you send the invoice?", ts: "2026-11-23T09:00:00Z" },
          // stale index entry: the words are not there, never shown
          { sessionId: "s2", messageId: "m3", role: "user", content: "nothing to see", ts: "2026-11-23T09:00:00Z" },
        ];
      },
    );
    const engine = new SearchEngine(() => buildSearchSources(deps({ sessions: () => store })));
    const r = await engine.search({ q: "invoices", types: ["chat"] });
    expect(r.items).toHaveLength(1);
    const hit = r.items[0]!;
    expect(hit).toMatchObject({ type: "chat", id: "s1", title: "Weekly plan", subtitle: "Chat with coach", url: "/chat?session=s1" });
    expect(hit.meta).toMatchObject({ messageId: "m1", author: "coach", role: "assistant", matches: 2, agent: "coach" });
    const [a, b] = hit.snippet!.highlights[0]!;
    expect(hit.snippet!.text.slice(a, b)).toBe("invoices");
  });

  it("without an index scans the latest chats, typos included", async () => {
    const store = sessionStore([session("s1", "Ops")], { s1: [msg("m1", "user", "The deployment failed again"), msg("m2", "assistant", "Retrying now")] });
    const engine = new SearchEngine(() => buildSearchSources(deps({ sessions: () => store })));
    const r = await engine.search({ q: "deplyoment", types: ["chat"] });
    expect(r.items.map((i) => i.meta?.messageId)).toEqual(["m1"]);
  });

  it("a chat whose title and messages match is one result", async () => {
    const store = sessionStore([session("s1", "Invoice March")], { s1: [msg("m1", "user", "invoice for March please")] });
    const engine = new SearchEngine(() => buildSearchSources(deps({ sessions: () => store })));
    const r = await engine.search({ q: "invoice", types: ["chat"] });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]!.snippet?.text).toContain("invoice for March");
    expect(r.items[0]!.score).toBeGreaterThan(800); // the title starts with the query
  });

  it("never shows a secret said in a chat", async () => {
    const store = sessionStore([session("s1", "Setup")], { s1: [msg("m1", "user", "the stripe key is sk_live_abcdefghijklmnop1234 for the deploy")] });
    const engine = new SearchEngine(() => buildSearchSources(deps({ sessions: () => store })));
    const r = await engine.search({ q: "stripe deploy" });
    expect(JSON.stringify(r)).not.toContain("sk_live_abcdefghijklmnop1234");
    expect(r.items[0]!.snippet!.text).toContain("••••••");
  });
});

describe("the other areas", () => {
  it("reads lists as the dashboard does: agents, connectors, channels without their tokens", async () => {
    const api = vi.fn(async (path: string) => {
      if (path === "/agents") return [{ name: "coach", role: "Health coach", model: "anthropic:claude", identity: { displayName: "Coach Kim" } }];
      if (path === "/connectors") return { connectors: [{ id: "linear", name: "Linear", kind: "mcp", enabled: true }] };
      if (path === "/config") return { settings: { notifications: { channels: { ops: { type: "telegram", botToken: "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq", gateway: { agent: "coach" } } } } } };
      return undefined;
    });
    const engine = new SearchEngine(() => buildSearchSources(deps({ api })));
    const coach = await engine.search({ q: "coach" });
    expect(coach.groups.map((g) => g.type)).toEqual(expect.arrayContaining(["agent", "channel"]));
    expect(coach.items.find((i) => i.type === "agent")).toMatchObject({ title: "Coach Kim", url: "/agents/coach", meta: { role: "Health coach" } });
    expect(JSON.stringify(coach)).not.toContain("AAHdqTcv");
    expect((await engine.search({ q: "linear" })).items[0]).toMatchObject({ type: "connector", url: "/connectors" });
  });

  it("tasks and missions with status and agent; files by name with a link to their folder", async () => {
    const dir = mkdtempSync(join(tmpdir(), "polpo-search-"));
    mkdirSync(join(dir, "reports", "2026"), { recursive: true });
    mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(dir, "reports", "2026", "quarterly-report.md"), "# Q3");
    writeFileSync(join(dir, "node_modules", "x", "quarterly-report.js"), "");
    const engine = new SearchEngine(() => buildSearchSources(deps({
      tasks: async () => [{ id: "t1", title: "Write the quarterly report", status: "in_progress", assignTo: "writer", updatedAt: "2026-11-23T00:00:00Z" }],
      missions: async () => [{ id: "m1", name: "Quarterly close", status: "active", prompt: "close the quarter" }],
      files: () => ({ roots: [dir], base: dir }),
    })));
    const r = await engine.search({ q: "quarterly" });
    expect(r.items.find((i) => i.type === "task")).toMatchObject({ url: "/tasks/t1", meta: { status: "in_progress", agent: "writer" } });
    expect(r.items.find((i) => i.type === "mission")).toMatchObject({ url: "/missions/m1", meta: { status: "active" } });
    const files = r.items.filter((i) => i.type === "file");
    expect(files.map((f) => f.meta?.path)).toEqual(["reports/2026/quarterly-report.md"]);
    expect(files[0]!.url).toBe("/files?path=reports%2F2026&highlight=quarterly-report.md");
  });

  it("recent events, without the streaming noise", async () => {
    const engine = new SearchEngine(() => buildSearchSources(deps({
      recentEvents: () => [
        { id: "1", event: "task:failed", data: { task: { id: "t9", title: "Nightly backup", assignTo: "ops" } }, ts: Date.now() },
        { id: "2", event: "chat:delta", data: { text: "Nightly backup" }, ts: Date.now() },
      ],
    })));
    const r = await engine.search({ q: "nightly backup", types: ["event"] });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ title: "task:failed", url: "/tasks/t9" });
  });
});

describe("GET /api/v1/search", () => {
  it("answers grouped results and refuses unknown types", async () => {
    const engine = new SearchEngine(() => [{ type: "task", docs: async () => [doc({ id: "t1", title: "Invoice" })] }]);
    const app = searchRoutes(() => engine);
    const ok = await (await app.request("/?q=invoice&types=task,agent&limit=5")).json() as any;
    expect(ok.ok).toBe(true);
    expect(ok.data.groups[0]).toMatchObject({ type: "task", label: "Tasks", total: 1 });
    const bad = await app.request("/?q=x&types=task,nope");
    expect(bad.status).toBe(400);
    expect((await bad.json() as any).error).toContain("nope");
  });
});

describe("polpo_search (MCP)", () => {
  it("groups the results as text with snippets and returns them structured", async () => {
    const api: McpDeps["api"] = vi.fn(async (_method, path) => {
      expect(path).toBe("/api/v1/search?q=invoice&types=chat%2Ctask&limit=30");
      return {
        status: 200, headers: new Headers(), body: { ok: true, data: {
          query: "invoice", took: 3, partial: [], nextCursor: null,
          items: [], groups: [
            { type: "chat", label: "Chats", total: 1, items: [{ type: "chat", id: "s1", title: "Taxes", url: "/chat?session=s1", score: 300, snippet: { text: "send the invoice today", highlights: [[9, 16]] }, meta: { messageId: "m1", author: "You" } }] },
            { type: "task", label: "Tasks", total: 3, items: [{ type: "task", id: "t1", title: "Invoice run", url: "/tasks/t1", score: 900, meta: { status: "done" } }] },
          ],
        } },
      };
    });
    const res = await handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "polpo_search", arguments: { q: "invoice", types: ["chat", "task"] } } }),
    }), { api, version: "x" });
    const result = (await res.json() as any).result;
    const text = result.content[0].text as string;
    expect(text).toContain("## Chats (1)");
    expect(text).toContain("- Taxes [session s1, message m1]");
    expect(text).toContain("You: send the **invoice** today");
    expect(text).toContain("## Tasks (1 of 3)");
    expect(text).toContain("- Invoice run (done) [t1]");
    expect(result.structuredContent.groups).toHaveLength(2);
    expect(result.structuredContent.next_cursor).toBeNull();
  });
});

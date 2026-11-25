/**
 * `polpo test`: the suites of an agent (or every agent, a hosted server, a mission) run through the
 * REST API, the report, JUnit XML, the Markdown summary and the exit codes — against a fake API
 * (no instance, no model).
 */
import { describe, expect, it } from "vitest";
import { remoteApi, runPolpoTest, type TestApi } from "../cli/commands/test.js";

const stats = (passed: number, failed: number) => ({ total: passed + failed, passed, failed, errored: 0, skipped: 0, passRate: passed / Math.max(1, passed + failed), costUsd: 0, durationMs: 100, inputTokens: 0, outputTokens: 0, turns: 0, toolCalls: 0 });

function fakeApi(opts: { failing?: string[]; regressions?: number; polls?: number } = {}) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let polls = opts.polls ?? 1;
  const api: TestApi = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === "/agents") return { ok: true, status: 200, data: [{ name: "shop" }, { name: "writer" }] };
    const list = /^\/(agents|mcp-servers|missions)\/([^/]+)\/suites$/.exec(path);
    if (list) return { ok: true, status: 200, data: [{ id: "quotes", name: "Quotes", cases: [{}] }, { id: "empty", name: "Empty", cases: [] }] };
    const run = /^\/(?:agents|mcp-servers|missions)\/([^/]+)\/suites\/([^/]+)\/runs$/.exec(path);
    if (run) return { ok: true, status: 200, data: { id: `sr-${run[1]}`, status: "running" } };
    const get = /^\/(?:agents|mcp-servers|missions)\/([^/]+)\/suite-runs\/([^/]+)$/.exec(path);
    if (get) {
      if (polls-- > 0) return { ok: true, status: 200, data: { id: get[2], status: "running" } };
      const failed = opts.failing?.includes(get[1]!);
      return { ok: true, status: 200, data: {
        id: get[2], agent: get[1], suiteId: "quotes", suiteName: "Quotes", target: "draft", status: failed ? "failed" : "passed", startedAt: "2026-11-25T10:00:00Z", notes: [],
        stats: failed ? stats(1, 1) : stats(2, 0),
        results: [{ key: "a", caseName: "A", status: "passed", durationMs: 50, costUsd: 0 }, ...(failed ? [{ key: "b", caseName: "B", status: "failed", durationMs: 50, costUsd: 0, failed: ["reply contains \"4.99\": missing"] }] : [{ key: "b", caseName: "B", status: "passed", durationMs: 50, costUsd: 0 }])],
        ...(opts.regressions ? { baseline: { runId: "sr-0", regressions: opts.regressions, improvements: 0, cases: [] } } : {}),
      } };
    }
    return { ok: false, status: 404, error: `no route ${path}` };
  };
  return { api, calls };
}

function io() {
  const out: string[] = [], err: string[] = [];
  const files = new Map<string, string>();
  return { out, err, files, deps: { log: (l: string) => out.push(l), error: (l: string) => err.push(l), write: async (f: string, t: string) => { files.set(f, t); }, sleep: async () => undefined } };
}

describe("polpo test", () => {
  it("runs an agent's suites (empty ones skipped), waits, reports; exit 0 when they pass", async () => {
    const { api, calls } = fakeApi();
    const x = io();
    const code = await runPolpoTest({ agent: "shop", version: "draft", mode: "all", junit: "out.xml", summary: "summary.md" }, { api, ...x.deps });
    expect(code).toBe(0);
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ path: "/agents/shop/suites/quotes/runs", body: { target: "draft", mode: "all", trigger: "ci" } });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(x.out.join("\n")).toContain("Empty: no cases, skipped");
    expect(x.out.join("\n")).toContain("PASSED");
    expect(x.files.get("out.xml")).toContain('<testsuites name="Polpo suites" tests="2" failures="0"');
    expect(x.files.get("summary.md")).toContain("## ✅ Polpo suites");
  });

  it("every agent without one; a failure exits 1 with the failed case in the report, JUnit and JSON", async () => {
    const { api } = fakeApi({ failing: ["writer"] });
    const x = io();
    const code = await runPolpoTest({ junit: "j.xml", json: "r.json" }, { api, ...x.deps });
    expect(code).toBe(1);
    expect(x.out.join("\n")).toContain("FAILED");
    expect(x.files.get("j.xml")).toContain("<failure message=\"reply contains &quot;4.99&quot;: missing\"");
    expect(JSON.parse(x.files.get("r.json")!)).toMatchObject({ exitCode: 1, runs: [{ agent: "shop" }, { agent: "writer", status: "failed" }] });
  });

  it("--fail-on-regression; hosted servers and missions; usage errors exit 2", async () => {
    const reg = fakeApi({ regressions: 2 });
    expect(await runPolpoTest({ agent: "shop" }, { api: reg.api, ...io().deps })).toBe(0);
    expect(await runPolpoTest({ agent: "shop", failOnRegression: true }, { api: fakeApi({ regressions: 2 }).api, ...io().deps })).toBe(1);
    const hosted = fakeApi();
    expect(await runPolpoTest({ mcpServer: "shop-api", suite: "quotes" }, { api: hosted.api, ...io().deps })).toBe(0);
    expect(hosted.calls.find((c) => c.method === "POST")?.path).toBe("/mcp-servers/shop-api/suites/quotes/runs");
    const mission = fakeApi();
    expect(await runPolpoTest({ mission: "m1" }, { api: mission.api, ...io().deps })).toBe(0);
    expect(mission.calls.find((c) => c.method === "POST")?.path).toBe("/missions/m1/suites/quotes/runs");
    const x = io();
    expect(await runPolpoTest({ agent: "shop", suite: "nope" }, { api: fakeApi().api, ...x.deps })).toBe(2);
    expect(x.err[0]).toContain('no suite "nope"');
    expect(await runPolpoTest({ mode: "live" }, { api: fakeApi().api, ...io().deps })).toBe(2);
    expect(await runPolpoTest({ agent: "a", mission: "m" }, { api: fakeApi().api, ...io().deps })).toBe(2);
  });

  it("the remote API sends the token and reads { ok, data }", async () => {
    const seen: Array<{ url: string; auth?: string; body?: string }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push({ url, auth: (init.headers as Record<string, string>).authorization, ...(init.body ? { body: String(init.body) } : {}) });
      return url.endsWith("/agents") ? new Response(JSON.stringify({ ok: true, data: [] })) : new Response(JSON.stringify({ ok: false, error: "nope" }), { status: 403 });
    }) as typeof fetch;
    const api = remoteApi("https://polpo.example.com/", "pk_123", fetchImpl);
    expect(await api("GET", "/agents")).toEqual({ ok: true, status: 200, data: [] });
    expect(await api("POST", "/agents/x/suites/s/runs", { a: 1 })).toEqual({ ok: false, status: 403, error: "nope" });
    expect(seen[0]).toEqual({ url: "https://polpo.example.com/api/v1/agents", auth: "Bearer pk_123" });
    expect(seen[1].body).toBe('{"a":1}');
    const down = remoteApi("http://localhost:1", undefined, (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch);
    expect(await down("GET", "/agents")).toMatchObject({ ok: false, status: 0, error: expect.stringContaining("ECONNREFUSED") });
  });
});

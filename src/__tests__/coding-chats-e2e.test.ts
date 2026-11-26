/**
 * Coding chats end to end on a real instance (orchestrator + createApp) with fake CLI programs:
 * REST (create, send, the live events, approvals, stop, account, delete), the coding:chat event on
 * the bus, and the MCP tools (start, send, get, list, control, the coding card) through the real
 * routes. Never the real claude / codex binaries, never a model.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdirSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../core/orchestrator.js";
import { handleMcpRequest, type McpDeps } from "../server/mcp.js";
import { fakeLauncher } from "./fixtures/coding-fake-cli.js";

let tmpDir: string;
let worktree: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the Hono app
let app: any;
let orchestrator: Orchestrator;
const KEY = "test-api-key";
const fakes = fakeLauncher();
const busEvents: Array<{ id: string; action: string; status: string }> = [];

const api = (path: string, init?: { method?: string; body?: unknown }) => app.request(`/api/v1${path}`, {
  method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
  headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
  ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- JSON answers
const json = async (res: Response) => (await res.json()) as { ok: boolean; data: any; error?: string; code?: string };

async function until(cond: () => Promise<boolean> | boolean, ms = 5000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > ms) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const session = async (id: string) => (await json(await api(`/coding/chats/${id}`))).data;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-coding-e2e-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  // a personal installation: no member sign-in, the instance's own Claude Code account
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({
    project: "coding-e2e", team: { name: "t", agents: [] },
    settings: { logLevel: "quiet", harnesses: { enabled: [], cli: { accounts: [{ id: "local", cli: "claude", owner: "instance" }] } } },
  }));
  const { Orchestrator: O } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  orchestrator = new O(tmpDir);
  await orchestrator.initInteractive("coding-e2e", { name: "t", agents: [] });
  orchestrator.on("coding:chat", (e) => busEvents.push({ id: e.id, action: e.action, status: e.status }));
  const bridge = new SSEBridge(orchestrator);
  bridge.start();
  app = createApp(orchestrator, bridge, { apiKeys: [KEY], codingChatLaunch: fakes.launch });
  worktree = join(orchestrator.getAgentWorkDir(), "worktrees", "lisbon-x1");
  mkdirSync(join(worktree, "src"), { recursive: true });
}, 60_000);

afterAll(async () => {
  const { codingChatManagerFor } = await import("../server/coding-chats-host.js");
  await codingChatManagerFor(orchestrator).close();
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("coding chats over REST", () => {
  test("create with a first message, stream the turn, approve a risky action, stop, delete", async () => {
    const account = await json(await api("/coding/chats/account?kind=claude"));
    expect(account.data).toMatchObject({ kind: "claude", account: { id: "local", owner: "instance" } });
    expect((await json(await api("/coding/chats/account?kind=codex"))).data).toMatchObject({ code: "NO_CLI_ACCOUNT", signInUrl: "/config?section=harnesses" });

    const bad = await api("/coding/chats", { body: { kind: "claude", cwd: "/etc" } });
    expect(bad.status).toBe(400);

    const created = await api("/coding/chats", { body: { kind: "claude", cwd: worktree, branch: "lisbon-x1", prompt: "hello" } });
    expect(created.status).toBe(201);
    const s = (await json(created)).data;
    expect(s).toMatchObject({ kind: "claude", cwd: worktree, account: "local", status: "running" });
    await until(async () => (await session(s.id)).status === "idle");
    const done = await session(s.id);
    expect(done.messages[1].segments).toEqual([{ type: "text", text: "Hello" }]);
    expect(fakes.launched.at(-1)!.cwd).toBe(worktree);

    // the live stream: the session first, then the turn's messages and the approval
    const stream = await api(`/coding/chats/${s.id}/events`);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = stream.body!.getReader();
    let received = "";
    const read = (async () => {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) return;
        received += new TextDecoder().decode(value);
      }
    })();

    const sent = await api(`/coding/chats/${s.id}/messages`, { body: { text: "push it" } });
    expect(sent.status).toBe(202);
    expect((await json(sent)).data.steered).toBe(false);
    await until(async () => (await session(s.id)).status === "awaiting-approval");
    const ap = (await session(s.id)).approvals[0];
    expect(ap).toMatchObject({ state: "pending", category: "git-push" });
    const answered = await api(`/coding/chats/${s.id}/approvals/${ap.id}`, { body: { decision: "approve" } });
    expect((await json(answered)).data).toMatchObject({ state: "approved" });
    await until(async () => (await session(s.id)).status === "idle");
    const again = await api(`/coding/chats/${s.id}/approvals/${ap.id}`, { body: { decision: "deny" } });
    expect(again.status).toBe(409);

    await until(() => received.includes("event: approval") && received.includes("event: files-changed") || received.includes("event: message"));
    expect(received).toMatch(/^event: session/m);
    expect(received).toContain("event: approval");

    const stopped = await api(`/coding/chats/${s.id}/stop`, { method: "POST" });
    expect((await json(stopped)).data.status).toBe("idle");

    const list = (await json(await api(`/coding/chats?cwd=${encodeURIComponent(worktree)}`))).data;
    expect(list.map((x: { id: string }) => x.id)).toContain(s.id);
    expect(list[0]).not.toHaveProperty("messages");

    expect((await json(await api(`/coding/chats/${s.id}`, { method: "DELETE" }))).data).toEqual({ deleted: true });
    await read;
    expect(received).toContain("event: deleted");
    expect((await api(`/coding/chats/${s.id}`)).status).toBe(404);
    expect(busEvents.filter((e) => e.id === s.id).map((e) => e.action)).toEqual(expect.arrayContaining(["created", "updated", "deleted"]));
    expect(busEvents.some((e) => e.id === s.id && e.status === "awaiting-approval")).toBe(true);
  });
});

describe("coding chats over MCP", () => {
  const inProcess: McpDeps["api"] = async (method, path, body) => {
    const res = await app.request(path, {
      method,
      headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  const deps: McpDeps = { api: inProcess, version: "x", pollIntervalMs: 20, publicUrl: "https://polpo.example.com" };
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }), deps);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the JSON-RPC answer
    return (await res.json() as any).result as { content: Array<{ text: string }>; structuredContent?: any; isError?: boolean };
  };

  test("start and wait, send, read, list, approve from the card's tools", async () => {
    const started = await call("polpo_coding_chat_start", { kind: "claude", cwd: worktree, prompt: "hello", wait: true, timeout_seconds: 10 });
    expect(started.isError).toBeFalsy();
    expect(started.content[0]!.text).toContain("Hello");
    const id = started.structuredContent.session.id as string;

    const listed = await call("polpo_coding_chats_list", { cwd: worktree });
    expect(listed.content[0]!.text).toContain(id);

    const sent = await call("polpo_coding_chat_send", { id, text: "push it", wait: true, timeout_seconds: 10 });
    expect(sent.content[0]!.text).toContain("WAITING FOR APPROVAL");
    const approval = (await session(id)).approvals.find((a: { state: string }) => a.state === "pending");

    const card = await call("polpo_coding_chat_show", { id });
    expect(card.structuredContent).toMatchObject({ kind: "coding-chat", session: { id, status: "awaiting-approval" }, approvals: [{ id: approval.id, category: "git-push" }] });
    expect(card.structuredContent.link).toBe(`https://polpo.example.com/coding?chat=${id}`);

    const missing = await call("polpo_coding_chat_control", { id, action: "approve" });
    expect(missing.isError).toBe(true);
    const ok = await call("polpo_coding_chat_control", { id, action: "approve", approval_id: approval.id });
    expect(ok.content[0]!.text).toContain("Approved");
    await until(async () => (await session(id)).status === "idle");

    const read = await call("polpo_coding_chat_get", { id });
    expect(read.content[0]!.text).toContain("Ran git push --force origin main");
    expect(read.content[0]!.text).toContain("Done.");
    const stop = await call("polpo_coding_chat_control", { id, action: "stop" });
    expect(stop.isError).toBeFalsy();
  });

  test("a missing account is said, with where to sign in", async () => {
    const r = await call("polpo_coding_chat_start", { kind: "codex", cwd: worktree, prompt: "hi" });
    expect(r.content[0]!.text).toMatch(/cannot run: .*Settings → Harnesses → CLI accounts/);
  });
});

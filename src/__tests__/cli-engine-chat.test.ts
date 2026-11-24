/**
 * Agent chats on the CLI engine through the chat completions route, with the fake `claude` /
 * `codex` programs: the turn streams into the chat (text, tool calls), the CLI conversation is
 * resumed on the next turn of the same chat session, Polpo's tools reach the program, a message to
 * a person becomes a preview, and a personal account answers only its owner.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Hono } from "hono";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { completionRoutes, type CompletionRouteDeps } from "@polpo-ai/server";
import type { CliAccount } from "@polpo-ai/core";
import { FileSessionStore } from "../stores/file-session-store.js";
import { cliChatRunner } from "../cli-engine/chat.js";
import { hostCliProcess } from "../cli-engine/process.js";
import { HarnessSessionStore } from "../harness/session-store.js";
import type { HarnessHostTool } from "../harness/types.js";

const fixtures = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures");
const ada: CliAccount = { id: "ada-max", cli: "claude", computer: "host", configDir: "~/.polpo-cli/claude/ada-max", owner: "ada@example.com" };

let dir: string;
let bin: string;
let log: string;
let sessions: FileSessionStore;
let member: string | undefined;
let tools: HarnessHostTool[];
const usage: any[] = [];
const agent = { name: "coder", engine: { type: "cli", cli: "claude" } };

function deps(): CompletionRouteDeps {
  const settings = { harnesses: { enabled: [], cli: { accounts: [ada] } } };
  return {
    getAgents: async () => [agent],
    getConfig: () => ({ settings }),
    getMemoryStore: () => undefined,
    getSessionStore: () => sessions,
    getStore: () => undefined,
    emit: () => {},
    recordTokenUsage: (u) => { usage.push(u); },
    resolveAgentModel: async () => { throw new Error("a CLI agent needs no model of Polpo's"); },
    buildAgentPrompt: () => { throw new Error("a CLI agent needs no prompt of Polpo's"); },
    resolveAgentTools: async () => { throw new Error("a CLI agent's tools are its MCP server"); },
    streamLLM: () => { throw new Error("no model call"); },
    cliChat: (a) => cliChatRunner(a, {
      polpoDir: dir, workDir: () => dir, settings: () => settings as any, instanceAuth: () => true,
      launch: async ({ cli, args, cwd, env }) => hostCliProcess(join(bin, cli), args, { cwd, env: { ...env, PATH: `${bin}:${process.env.PATH}`, FAKE_CLI_LOG: log } }),
      hostTools: async () => ({ tools }),
    }),
  };
}

async function chat(content: string, o: { sessionId?: string; stream?: boolean } = {}) {
  const route = completionRoutes(deps);
  // the instance sign-in middleware sets the member on the context
  const wrapped = new Hono();
  wrapped.use("*", async (c, next) => { if (member) c.set("polpoUserEmail" as never, member as never); await next(); });
  wrapped.route("/", route);
  const res = await wrapped.request("/", {
    method: "POST",
    headers: { "content-type": "application/json", ...(o.sessionId ? { "x-session-id": o.sessionId } : { "x-session-id": "new" }) },
    body: JSON.stringify({ agent: "coder", stream: o.stream ?? true, messages: [{ role: "user", content }] }),
  });
  const sessionId = res.headers.get("x-session-id")!;
  if (!(o.stream ?? true)) return { status: res.status, json: await res.json() as any, sessionId, chunks: [] as any[] };
  const text = await res.text();
  const chunks = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).filter((d) => d !== "[DONE]").map((d) => JSON.parse(d));
  return { status: res.status, chunks, sessionId, json: undefined as any };
}

const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "polpo-cli-chat-"));
  bin = join(dir, "bin");
  log = join(dir, "fake.log");
  mkdirSync(bin);
  for (const [name, file] of [["claude", "fake-claude.mjs"], ["codex", "fake-codex.mjs"]]) {
    writeFileSync(join(bin, name!), `#!/bin/sh\nexec "${process.execPath}" "${join(fixtures, file!)}" "$@"\n`);
    chmodSync(join(bin, name!), 0o755);
  }
  sessions = new FileSessionStore(dir);
  member = "ada@example.com";
  tools = [];
  usage.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("agent chats on the CLI engine", () => {
  it("streams the turn into the chat, stores the answer, records tokens, and resumes the conversation next turn", async () => {
    const first = await chat("Write out.txt");
    expect(first.status).toBe(200);
    const content = first.chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("");
    expect(content).toContain("Done turn 1");
    expect(first.chunks.some((c) => c.choices?.[0]?.tool_call?.name === "Write" && c.choices[0].tool_call.state === "calling")).toBe(true);
    expect(first.chunks.some((c) => c.choices?.[0]?.tool_call?.state === "completed")).toBe(true);
    expect(first.chunks.some((c) => c.choices?.[0]?.thinking)).toBe(true);
    expect(first.chunks.at(-1)?.choices?.[0]?.finish_reason).toBe("stop");
    const msgs = await sessions.getMessages(first.sessionId);
    expect(msgs.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.content).toContain("Done turn 1");
    expect(usage[0]).toMatchObject({ source: "agent_chat", provider: "claude-cli", cost: 0, totalTokens: 180 });
    // the chat's CLI session record
    const rec = new HarnessSessionStore(dir).list().find((s) => s.scope === "chat");
    expect(rec).toMatchObject({ engine: "cli", chatSessionId: first.sessionId, runtimeSessionId: "11111111-2222-3333-4444-555555555555", turns: 1 });

    await chat("And again", { sessionId: first.sessionId });
    const runs = calls().filter((c) => c.argv?.[0] === "-p");
    expect(runs).toHaveLength(2);
    expect(runs[1].argv).toEqual(expect.arrayContaining(["--resume", "11111111-2222-3333-4444-555555555555"]));
  });

  it("a message typed while it works reaches the program at once (steer) and is stored as a user message", async () => {
    const route = completionRoutes(deps);
    const wrapped = new Hono();
    wrapped.use("*", async (c, next) => { c.set("polpoUserEmail" as never, "ada@example.com" as never); await next(); });
    wrapped.route("/", route);
    const res = await wrapped.request("/", {
      method: "POST", headers: { "content-type": "application/json", "x-session-id": "new" },
      body: JSON.stringify({ agent: "coder", stream: true, messages: [{ role: "user", content: "STEER me" }] }),
    });
    const turnId = res.headers.get("x-turn-id")!;
    const sessionId = res.headers.get("x-session-id")!;
    const body = res.text();
    await new Promise((r) => setTimeout(r, 700));
    const accepted = await wrapped.request(`/steer/${turnId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "s1", content: "use pnpm" }) });
    expect(accepted.status).toBe(202);
    const chunks = (await body).split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).filter((d) => d !== "[DONE]").map((d) => JSON.parse(d));
    expect(chunks.some((c) => c.choices?.[0]?.steer_applied?.steers?.[0]?.content === "use pnpm")).toBe(true);
    expect(chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("")).toContain("Steered: use pnpm");
    const msgs = await sessions.getMessages(sessionId);
    expect(msgs.map((m: any) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(msgs[2]!.content).toBe("use pnpm");
  });

  it("non-streaming answers too", async () => {
    const r = await chat("Write out.txt", { stream: false });
    expect(r.status).toBe(200);
    expect(r.json.choices[0].message.content).toContain("Done turn 1");
  });

  it("Polpo's tools reach the program; a message to a person becomes a preview the person sends", async () => {
    const sent: unknown[] = [];
    tools = [
      { name: "echo_tool", description: "Echo", inputSchema: { type: "object", properties: {} }, execute: async (i) => `echo ${(i as any).x}` },
      { name: "email_send", description: "Send", inputSchema: { type: "object", properties: {} }, approval: "user-approval", execute: async (i) => { sent.push(i); return "sent"; } },
    ];
    const r = await chat('POLPO_TOOL echo_tool {"x":5}');
    expect(r.chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("")).toContain("Tool said: echo 5");
    expect(r.chunks.some((c) => c.choices?.[0]?.tool_call?.name === "echo_tool")).toBe(true);

    const p = await chat('POLPO_TOOL email_send {"to":"bob@example.com","subject":"Hi","body":"Hello"}');
    expect(sent).toEqual([]);
    const last = p.chunks.at(-1)!.choices[0];
    expect(last.finish_reason).toBe("email_preview");
    expect(last.email_preview).toMatchObject({ to: "bob@example.com", subject: "Hi", body: "Hello" });
  });

  it("a personal account answers only its owner", async () => {
    member = "bob@example.com";
    const r = await chat("hello");
    const err = r.chunks.find((c) => c.error);
    expect(err?.error.message).toMatch(/belongs to ada@example.com.*bob@example.com/);
    expect(calls().filter((c) => c.argv)).toHaveLength(0);
  });
});

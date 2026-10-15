/**
 * A task runs in its own process (NodeSpawner starts runner.ts), with its own copy of the path
 * guard. That process must keep the agent out of the project's .polpo like the server does.
 * The real runner is started from a RunnerConfig against a fake OpenAI-compatible model whose
 * first reply asks for .polpo/.env and writes files; the model's second request carries the
 * tool results, i.e. what the agent got to see.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeLlmServer, type FakeLlmServer } from "./helpers/fake-llm-server.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SECRET = "polpo-env-secret-4242";

/** One streamed assistant turn that only calls tools (OpenAI chat completions SSE). */
function toolCallsSse(calls: Array<{ name: string; args: Record<string, unknown> }>): string {
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const toolCalls = calls.map((c, i) => ({ index: i, id: `call_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
  return chunk({ role: "assistant", content: null, tool_calls: toolCalls }, null)
    + chunk({}, "tool_calls")
    + `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "fake-model", choices: [], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } })}\n\n`
    + "data: [DONE]\n\n";
}

function runRunner(configPath: string, cwd: string): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(repo, "node_modules", "tsx", "dist", "cli.mjs"), join(repo, "src", "core", "runner.ts"), "--config", configPath], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stderr }));
  });
}

/** Text of the tool result for a call, as the model received it. */
function toolResult(messages: any[], callId: string): string {
  const msg = messages.find((m) => m.role === "tool" && m.tool_call_id === callId);
  if (!msg) return "";
  return typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
}

let server: FakeLlmServer;
let project: string;

beforeAll(async () => {
  server = await startFakeLlmServer({ reply: "Done." });
  project = mkdtempSync(join(tmpdir(), "polpo-runner-guard-"));
});

afterAll(async () => {
  await server?.close();
  if (project) rmSync(project, { recursive: true, force: true });
});

describe("task runner process", () => {
  test("the agent cannot read or write .polpo; its output folder and the project stay writable", async () => {
    const polpoDir = join(project, ".polpo");
    // Hardest case for the guard: an output folder inside .polpo (older layout, chat outputs),
    // under cwd, so the engine does not list it among the allowed paths by itself.
    const outputDir = join(polpoDir, "output", "t1");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(polpoDir, ".env"), `OPENAI_API_KEY=${SECRET}\n`);
    writeFileSync(join(polpoDir, "polpo.json"), JSON.stringify({
      project: "guard",
      teams: [],
      settings: {},
      providers: {
        fakegw: {
          preset: "openai-compatible",
          api: "openai-completions",
          baseUrl: `${server.url}/v1`,
          auth: { type: "none" },
          allowPrivateNetwork: true,
          models: [{ id: "fake-model", name: "Fake" }],
        },
      },
    }));

    server.next.set("/v1/chat/completions", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: toolCallsSse([
        { name: "read", args: { path: ".polpo/.env" } },
        { name: "write", args: { path: ".polpo/stolen.txt", content: "x" } },
        { name: "write", args: { path: join(outputDir, "report.md"), content: "report" } },
        { name: "write", args: { path: "notes.md", content: "notes" } },
      ]),
    });

    const now = new Date().toISOString();
    const configPath = join(project, "run-config.json");
    writeFileSync(configPath, JSON.stringify({
      runId: "run-guard",
      taskId: "t1",
      agent: { name: "dev", model: "fakegw:fake-model" },
      task: {
        id: "t1", title: "Guard", description: "Read .polpo/.env and write a report.", assignTo: "dev",
        dependsOn: [], status: "in_progress", expectations: [], metrics: [], retries: 0, maxRetries: 0, createdAt: now, updatedAt: now,
      },
      polpoDir,
      cwd: project,
      outputDir,
    }));

    const { code, stderr } = await runRunner(configPath, project);
    expect(code, stderr).toBe(0);

    const chats = server.requests.filter((r) => r.method === "POST" && r.path === "/v1/chat/completions");
    expect(chats.length).toBeGreaterThanOrEqual(2);
    const messages = chats[1].body.messages as any[];

    expect(JSON.stringify(messages)).not.toContain(SECRET);
    expect(toolResult(messages, "call_0")).toMatch(/\[sandbox\] read: access denied/);
    expect(toolResult(messages, "call_1")).toMatch(/\[sandbox\] write: access denied/);
    expect(existsSync(join(polpoDir, "stolen.txt"))).toBe(false);
    expect(toolResult(messages, "call_2")).not.toMatch(/access denied/);
    expect(existsSync(join(outputDir, "report.md"))).toBe(true);
    expect(toolResult(messages, "call_3")).not.toMatch(/access denied/);
    expect(existsSync(join(project, "notes.md"))).toBe(true);
  }, 120_000);
});

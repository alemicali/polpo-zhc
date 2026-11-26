#!/usr/bin/env node
// A stand-in for `codex` in tests: `codex app-server` speaks the app server's JSON-RPC over stdio
// (no "jsonrpc" field, one object per line); `--version` and `login status` answer like Codex.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
// root config overrides (-c key=value) before the subcommand, as `codex -c … app-server`
const config = {};
while (argv[0] === "-c") {
  const kv = argv[1];
  const i = kv.indexOf("=");
  config[kv.slice(0, i)] = JSON.parse(kv.slice(i + 1));
  argv.splice(0, 2);
}
const log = process.env.FAKE_CLI_LOG;
if (log) appendFileSync(log, JSON.stringify({ argv, codexHome: process.env.CODEX_HOME, openaiKey: process.env.OPENAI_API_KEY ?? null }) + "\n");
if (argv[0] === "--version") { console.log("codex-cli 0.90.0"); process.exit(0); }
if (argv[0] === "login" && argv[1] === "status") {
  if (process.env.FAKE_CODEX_SIGNED_IN === "1") { console.log("Logged in using ChatGPT"); process.exit(0); }
  console.error("Not logged in"); process.exit(1);
}
if (argv[0] !== "app-server") { console.error("unexpected"); process.exit(2); }
if (log) appendFileSync(log, JSON.stringify({ config, token: config["mcp_servers.polpo.bearer_token_env_var"] ? !!process.env[config["mcp_servers.polpo.bearer_token_env_var"]] : null }) + "\n");

// Polpo's tools: the MCP server the run gives the program (streamable HTTP, JSON responses)
async function mcpCall(url, headers, method, params, id) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`MCP ${res.status}: ${body}`);
  const m = JSON.parse(body);
  if (m.error) throw new Error(m.error.message);
  return m.result;
}
async function callPolpoTool(url, headers, name, args) {
  await mcpCall(url, headers, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake", version: "1" } }, 1);
  const list = await mcpCall(url, headers, "tools/list", {}, 2);
  const r = await mcpCall(url, headers, "tools/call", { name, arguments: args }, 3);
  return { text: (r.content ?? []).map((c) => c.text ?? "").join(""), isError: !!r.isError, tools: list.tools.map((t) => t.name) };
}


const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const thread = "thr_1";
let turnN = 0;
let total = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 };
let pendingSteer = null;

const complete = (turnId, text, status = "completed", error = null) => {
  if (text) out({ method: "item/completed", params: { threadId: thread, turnId, completedAtMs: 1, item: { type: "agentMessage", id: `msg-${turnId}`, text } } });
  total = { inputTokens: total.inputTokens + 120, cachedInputTokens: total.cachedInputTokens + 20, outputTokens: total.outputTokens + 30, reasoningOutputTokens: 0, totalTokens: total.totalTokens + 150 };
  out({ method: "thread/tokenUsage/updated", params: { threadId: thread, turnId, tokenUsage: { total, last: total } } });
  out({ method: "turn/completed", params: { threadId: thread, turn: { id: turnId, status, items: [], error } } });
};

createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const m = JSON.parse(line);
  if (m.jsonrpc) { out({ id: m.id, error: { code: -32600, message: "unexpected jsonrpc field" } }); return; }
  switch (m.method) {
    case "initialize": out({ id: m.id, result: { userAgent: "fake-codex/0.90.0" } }); return;
    case "initialized": return;
    case "thread/start": out({ id: m.id, result: { thread: { id: thread }, model: m.params.model ?? "gpt-5.5-codex", cwd: m.params.cwd, approvalPolicy: m.params.approvalPolicy, sandbox: { type: m.params.sandbox } } }); return;
    case "thread/resume": out({ id: m.id, result: { thread: { id: m.params.threadId }, model: "gpt-5.5-codex" } }); return;
    case "turn/start": {
      const turnId = `turn_${++turnN}`;
      const text = m.params.input.map((i) => i.text).join("");
      out({ id: m.id, result: { turn: { id: turnId, status: "inProgress", items: [] } } });
      out({ method: "turn/started", params: { threadId: thread, turn: { id: turnId } } });
      if (text.includes("NOT_LOGGED_IN")) {
        out({ method: "error", params: { threadId: thread, turnId, willRetry: false, error: { message: "unexpected status 401 Unauthorized: Not logged in. Run codex login" } } });
        complete(turnId, "", "failed", { message: "unexpected status 401 Unauthorized" });
        return;
      }
      if (text.includes("USAGE_LIMIT")) {
        complete(turnId, "", "failed", { message: "You've hit your usage limit. Try again at 5:00 PM." });
        return;
      }
      const toolReq = /POLPO_TOOL (\S+) (\{.*\})/.exec(text);
      if (toolReq) {
        const [, name, json] = toolReq;
        const url = config["mcp_servers.polpo.url"];
        const token = process.env[config["mcp_servers.polpo.bearer_token_env_var"]];
        out({ method: "item/started", params: { threadId: thread, turnId, item: { type: "mcpToolCall", id: "mcp1", server: "polpo", tool: name, arguments: JSON.parse(json), status: "inProgress" } } });
        callPolpoTool(url, { authorization: `Bearer ${token}` }, name, JSON.parse(json)).then((r) => {
          if (log) appendFileSync(log, JSON.stringify({ toolCall: name, result: r }) + "\n");
          out({ method: "item/completed", params: { threadId: thread, turnId, completedAtMs: 1, item: { type: "mcpToolCall", id: "mcp1", server: "polpo", tool: name, arguments: JSON.parse(json), status: r.isError ? "failed" : "completed", result: r.text } } });
          complete(turnId, `Tool said: ${r.text}`);
        }, (e) => complete(turnId, "", "failed", { message: String(e.message) }));
        return;
      }
      out({ method: "item/started", params: { threadId: thread, turnId, item: { type: "commandExecution", id: "cmd1", command: "ls", cwd: "/w", status: "inProgress", commandActions: [] } } });
      out({ method: "item/completed", params: { threadId: thread, turnId, completedAtMs: 1, item: { type: "commandExecution", id: "cmd1", command: "ls", cwd: "/w", status: "completed", exitCode: 0, aggregatedOutput: "a.txt\n", commandActions: [] } } });
      out({ method: "item/completed", params: { threadId: thread, turnId, completedAtMs: 1, item: { type: "reasoning", id: "r1", summary: ["Listing files"], content: [] } } });
      if (text.includes("SLOW")) { pendingSteer = turnId; setInterval(() => {}, 1000); return; }
      if (text.includes("STEER")) { pendingSteer = turnId; return; }
      // an approval request despite approvalPolicy "never": the client must decline it
      out({ id: 900, method: "item/commandExecution/requestApproval", params: { threadId: thread, turnId, itemId: "cmd2" } });
      complete(turnId, `Codex done ${turnN}`);
      return;
    }
    case "turn/steer": {
      out({ id: m.id, result: { turnId: m.params.expectedTurnId } });
      const t = pendingSteer;
      pendingSteer = null;
      if (t) complete(t, `Steered: ${m.params.input.map((i) => i.text).join("")}`);
      return;
    }
    case "turn/interrupt": out({ id: m.id, result: {} }); complete(m.params.turnId, "", "interrupted"); return;
    default:
      if (m.id !== undefined && m.method) out({ id: m.id, error: { code: -32601, message: `Unhandled: ${m.method}` } });
      if (m.id === 900 && log) appendFileSync(log, JSON.stringify({ approvalReply: m }) + "\n");
  }
});

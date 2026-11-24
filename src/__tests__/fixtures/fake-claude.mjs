#!/usr/bin/env node
// A stand-in for the `claude` program in tests: speaks Claude Code's stream-json protocol
// (recorded shapes: system/init, assistant, user tool_result, result), and answers
// `--version` and `auth status`. Never touches the network or a real account.
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const log = process.env.FAKE_CLI_LOG;
if (log) appendFileSync(log, JSON.stringify({ argv, configDir: process.env.CLAUDE_CONFIG_DIR, anthropicKey: process.env.ANTHROPIC_API_KEY ?? null }) + "\n");

if (argv[0] === "--version") { console.log("2.1.400 (Claude Code)"); process.exit(0); }
if (argv[0] === "auth" && argv[1] === "status") {
  if (process.env.FAKE_CLAUDE_SIGNED_IN === "1") {
    console.log(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "ada@example.com", subscriptionType: "max", configDirectory: process.env.CLAUDE_CONFIG_DIR }));
    process.exit(0);
  }
  console.log(JSON.stringify({ loggedIn: false, authMethod: "none" }));
  process.exit(1);
}
if (argv[0] === "auth" && argv[1] === "logout") { console.log("Successfully logged out"); process.exit(0); }

const resumeIdx = argv.indexOf("--resume");
const sessionId = resumeIdx >= 0 ? argv[resumeIdx + 1] : "11111111-2222-3333-4444-555555555555";
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
let initSent = false;
let waitingSteer = null;
let turn = 0;

const usage = { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 };
const result = (text, extra = {}) => out({ type: "result", subtype: "success", is_error: false, result: text, session_id: sessionId, total_cost_usd: 0.0123, usage, num_turns: 1, ...extra });

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const msg = JSON.parse(line);
  const text = typeof msg.message.content === "string" ? msg.message.content : msg.message.content.map((b) => b.text).join("");
  out({ type: "user", message: { role: "user", content: text }, session_id: sessionId, isReplay: true });
  if (!initSent) { initSent = true; out({ type: "system", subtype: "init", session_id: sessionId, model: "claude-fable-5", cwd: process.cwd(), tools: ["Bash", "Write"] }); }
  if (waitingSteer) {
    const done = waitingSteer;
    waitingSteer = null;
    out({ type: "assistant", message: { id: "m3", role: "assistant", content: [{ type: "text", text: `Steered: ${text}` }] }, session_id: sessionId });
    done(`Steered: ${text}`);
    return;
  }
  turn++;
  if (text.includes("NOT_LOGGED_IN")) {
    out({ type: "assistant", message: { id: "m0", role: "assistant", content: [{ type: "text", text: "Invalid API key · Please run /login" }] }, session_id: sessionId, error: "authentication_failed" });
    result("Invalid API key · Please run /login", { is_error: true, subtype: "success", usage: { input_tokens: 0, output_tokens: 0 } });
    return;
  }
  if (text.includes("USAGE_LIMIT")) {
    result("Claude AI usage limit reached|1767225600", { is_error: true });
    return;
  }
  if (text.includes("SLOW")) {
    out({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t-slow", name: "Bash", input: { command: "sleep 600" } }] }, session_id: sessionId });
    setInterval(() => {}, 1000);
    return;
  }
  if (text.includes("STEER")) {
    out({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] }, session_id: sessionId });
    waitingSteer = (t) => result(t);
    return;
  }
  out({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "thinking", thinking: "Let me write the file." }, { type: "tool_use", id: "t1", name: "Write", input: { file_path: "out.txt", content: "hi" } }] }, session_id: sessionId });
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "File created", is_error: false }] }, session_id: sessionId });
  out({ type: "assistant", message: { id: "m2", role: "assistant", content: [{ type: "text", text: `Done turn ${turn}` }] }, session_id: sessionId });
  result(`Done turn ${turn}`);
});
rl.on("close", () => process.exit(0));

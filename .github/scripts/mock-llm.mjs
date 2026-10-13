// An OpenAI-compatible model for CI smoke tests: every chat completion answers MOCK_LLM_REPLY
// (streaming or not), so a packaged app can be used end to end without a real provider.
// A learning review ("[Learning:" in the last user message) first calls memory_save, then answers;
// a reflection ("[Reflection") first calls update_self.
// Usage: MOCK_LLM_PORT=9911 MOCK_LLM_REPLY="..." node .github/scripts/mock-llm.mjs
import http from "node:http";

const port = Number(process.env.MOCK_LLM_PORT ?? 9911);
const reply = process.env.MOCK_LLM_REPLY ?? "Polpo smoke test reply";
const model = "mock-1";

function chunk(id, delta, finish) {
  return `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
}

http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const path = (req.url ?? "").split("?")[0];
    if (req.method === "GET" && path.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model", owned_by: "ci" }] }));
      return;
    }
    if (req.method !== "POST" || !path.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `not found: ${req.method} ${path}` } }));
      return;
    }
    let request = {};
    try { request = JSON.parse(body); } catch { /* answer anyway */ }
    const system = (request.messages ?? []).filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
    console.log(`[mock-llm] ${request.stream ? "stream" : "json"} completion, ${request.messages?.length ?? 0} messages${system.includes("## Your purpose") ? ", with a purpose" : ""}`);
    const id = `chatcmpl-${Date.now()}`;
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    const messages = request.messages ?? [];
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
    const toolDone = messages.length > 0 && messages[messages.length - 1].role === "tool";
    const learning = userText.includes("[Learning:");
    const reflection = userText.includes("[Reflection");
    if ((learning || reflection) && !toolDone && request.stream) {
      const call = learning
        ? { index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "memory_save", arguments: JSON.stringify({ content: "- learned by the mock model" }) } }
        : { index: 0, id: `call_${Date.now()}`, type: "function", function: { name: "update_self", arguments: JSON.stringify({ portrait: "I am the mock agent: calm and kind." }) } };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(chunk(id, { role: "assistant", content: null, tool_calls: [call] }, null));
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    if (request.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(chunk(id, { role: "assistant", content: "" }, null));
      res.write(chunk(id, { content: reply }, null));
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }], usage }));
  });
}).listen(port, "127.0.0.1", () => console.log(`[mock-llm] listening on 127.0.0.1:${port}`));

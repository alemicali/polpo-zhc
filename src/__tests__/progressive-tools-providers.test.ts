/**
 * How pi-ai sends a tool loaded mid-conversation (a system message with toolsAdded, as the
 * engine and the chat route produce it) to each provider family. The payload is captured in
 * onPayload and the request is stopped there: nothing is sent.
 */
import { describe, expect, it } from "vitest";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Context, Model, Api } from "@earendil-works/pi-ai";

const params = { type: "object", properties: {} };
const coreTool = { name: "read", description: "Read a file.", parameters: params };
const searchTool = { name: "tools_search", description: "Search tools.", parameters: params };
const loadTool = { name: "tools_load", description: "Load tools.", parameters: params };
const linearTool = { name: "mcp__linear__create_issue", description: "Create a Linear issue.", parameters: params };

function conversation(): Context {
  return {
    systemPrompt: "You are a test agent.",
    tools: [coreTool, searchTool, loadTool],
    messages: [
      { role: "user", content: "file a bug in Linear", timestamp: 1 },
      {
        role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "tools_load", arguments: { names: [linearTool.name] } }],
        api: "anthropic-messages", provider: "anthropic", model: "x", stopReason: "toolUse", timestamp: 2,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      },
      { role: "toolResult", toolCallId: "call_1", toolName: "tools_load", content: [{ type: "text", text: "Loaded 1 tool." }], isError: false, timestamp: 3 },
      { role: "system", content: "", toolsAdded: [linearTool], timestamp: 4 },
    ] as Context["messages"],
  };
}

async function payloadFor(provider: string, modelId: string): Promise<any> {
  const builtin = getBuiltinModel(provider as never, modelId as never) as Model<Api> | undefined;
  expect(builtin, `${provider}:${modelId} in the catalog`).toBeDefined();
  const model = { ...builtin!, baseUrl: "http://127.0.0.1:9/v1" };
  let captured: unknown;
  const stream = streamSimple(model, conversation(), {
    apiKey: "test-key",
    onPayload: (payload: unknown) => {
      captured = payload;
      throw new Error("payload captured");
    },
  });
  const result = await stream.result();
  expect(result.stopReason).toBe("error");
  expect(captured, `${provider}:${modelId} built a payload`).toBeDefined();
  return captured;
}

const toolNamesOf = (tools: any[] | undefined) => (tools ?? []).map((t) => t.name ?? t.function?.name).filter(Boolean);

describe("mid-conversation tool additions by provider (pi-ai 1.6)", () => {
  it("Anthropic (inline tool changes): the top-level list stays the initial one, the tool comes as a tool_addition block", async () => {
    const payload = await payloadFor("anthropic", "claude-sonnet-5-5");
    expect(toolNamesOf(payload.tools)).not.toContain(linearTool.name);
    expect(toolNamesOf(payload.tools)).toEqual(expect.arrayContaining(["read", "tools_search", "tools_load"]));
    expect(JSON.stringify(payload.messages)).toContain("\"tool_addition\"");
    expect(JSON.stringify(payload.messages)).toContain(linearTool.name);
  });

  it("older Anthropic models: the current tool list at the top level", async () => {
    const payload = await payloadFor("anthropic", "claude-sonnet-4-5");
    expect(toolNamesOf(payload.tools)).toEqual(expect.arrayContaining(["read", "tools_load", linearTool.name]));
    expect(JSON.stringify(payload.messages)).not.toContain("tool_addition");
  });

  it("OpenAI Responses (additional_tools): no top-level change, the tool is declared at its message", async () => {
    const payload = await payloadFor("openai", "gpt-6-sol");
    expect(toolNamesOf(payload.tools)).not.toContain(linearTool.name);
    const input = JSON.stringify(payload.input);
    expect(input).toContain(linearTool.name);
    expect(input).toContain("additional_tools");
  });

  it("Kimi (mid-conversation additions): the tool is anchored at its message", async () => {
    const payload = await payloadFor("moonshotai", "kimi-k3");
    expect(toolNamesOf(payload.tools)).not.toContain(linearTool.name);
    expect(JSON.stringify(payload.messages)).toContain(linearTool.name);
  });

  it("everything else (e.g. GPT-4.1, no tool search): the current tool list at the top level", async () => {
    const payload = await payloadFor("openai", "gpt-4.1");
    expect(toolNamesOf(payload.tools)).toEqual(expect.arrayContaining(["read", "tools_load", linearTool.name]));
  });
});

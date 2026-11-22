/**
 * Progressive tool discovery in task runs (src/adapters/engine.ts on pi-agent-core): the run
 * starts without the optional tools, tools_load adds them before the next request (through
 * pi-agent-core's tool diff: a toolsAdded system message), and the loaded tool then runs.
 * The model is scripted; nothing reaches a provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { mockModel, mockTextResponse, mockToolCallResponse, mockTurnSequence } from "./helpers/mock-llm.js";

const requests: Array<{ messages: Message[] }> = [];
let script: ReturnType<typeof mockTurnSequence>;

vi.mock("../llm/pi-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/pi-client.js")>();
  return {
    ...actual,
    enforceModelAllowlist: () => {},
    resolveModel: () => mockModel(),
    streamSimpleWithAuth: async (_model: unknown, context: { messages: Message[] }) => {
      requests.push({ messages: [...context.messages] });
      return script();
    },
  };
});

const { spawnEngine } = await import("../adapters/engine.js");
const { getCurrentTools } = await import("@earendil-works/pi-ai");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "polpo-progressive-engine-"));
  requests.length = 0;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const task = (id: string) => ({
  id, title: "Summarize the report", description: "Read report.pdf and summarize it.", assignTo: "writer",
  dependsOn: [], expectations: [], status: "in_progress", retries: 0, maxRetries: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
}) as any;

const names = (tools: Array<{ name: string }>) => tools.map((t) => t.name);

describe("task runs: progressive tools", () => {
  it("loads a deferred tool mid-run and runs it", async () => {
    script = mockTurnSequence([
      mockToolCallResponse("tools_search", { query: "pdf" }),
      mockToolCallResponse("tools_load", { names: ["pdf_info"] }),
      mockToolCallResponse("pdf_info", { path: "missing.pdf" }),
      mockTextResponse("Done."),
    ]);
    const handle = spawnEngine({ name: "writer", allowedTools: ["read", "pdf_*", "excel_*"], progressiveTools: "always" } as any, task("t-progressive"), dir, { polpoDir: join(dir, ".polpo") } as any);
    const result = await handle.done;
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(requests).toHaveLength(4);

    // first request: essential tools + meta tools; the optional groups only in the prompt
    const first = names(getCurrentTools(requests[0].messages));
    expect(first).toEqual(expect.arrayContaining(["read", "tools_search", "tools_load"]));
    expect(first.some((n) => n.startsWith("pdf_") || n.startsWith("excel_"))).toBe(false);
    const systemText = JSON.stringify(requests[0].messages.filter((m) => m.role === "system"));
    expect(systemText).toContain("More tools on demand");
    expect(systemText).toContain("Excel, PDF and Word files (group `documents`)");

    // the search answered from the deferred pool
    const search = requests[1].messages.find((m) => m.role === "toolResult" && m.toolName === "tools_search") as any;
    expect(search.content[0].text).toContain("pdf_info");

    // after tools_load: a system message declares the tool before the next request
    const third = requests[2].messages;
    const loadIndex = third.findIndex((m) => m.role === "toolResult" && (m as any).toolName === "tools_load");
    const declared = third.slice(loadIndex + 1).find((m) => m.role === "system") as any;
    expect(names(declared.toolsAdded)).toEqual(["pdf_info"]);
    expect(names(getCurrentTools(third))).toContain("pdf_info");
    expect(names(getCurrentTools(third))).not.toContain("excel_read");

    // and it ran (an error about the missing file, not "tool not found")
    const ran = requests[3].messages.find((m) => m.role === "toolResult" && (m as any).toolName === "pdf_info") as any;
    expect(JSON.stringify(ran.content)).not.toMatch(/not found/i);
  });

  it("gives every tool up front below the threshold", async () => {
    script = mockTurnSequence([mockTextResponse("Done.")]);
    const handle = spawnEngine({ name: "writer", allowedTools: ["read", "pdf_*"] } as any, task("t-plain"), dir, { polpoDir: join(dir, ".polpo") } as any);
    await handle.done;
    const first = names(getCurrentTools(requests[0].messages));
    expect(first).toContain("pdf_info");
    expect(first).not.toContain("tools_search");
  });
});

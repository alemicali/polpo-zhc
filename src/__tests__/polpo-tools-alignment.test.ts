/**
 * Polpo can do in chat what the MCP server (and the dashboard) can: every MCP tool has a Polpo
 * counterpart (its own tool, or the MCP handler run in process under Polpo's name) or a justified
 * exception; the bridged tools work on a real instance (createApp: the real routes), keep secrets
 * out of the chat (setup links), need confirm for destructive actions; the essential ones are up
 * front and the rest load on demand; the prompt says what Polpo can do.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../core/orchestrator.js";

const DASHBOARD = "https://dash.example.com";
let tmpDir: string;
let polpo: Orchestrator;
let run: (name: string, args?: Record<string, unknown>) => Promise<string>;

beforeAll(async () => {
  process.env.POLPO_DASHBOARD_URL = DASHBOARD;
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-tools-alignment-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  const team = { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] };
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({ project: "align", team, settings: { logLevel: "quiet" } }));
  const { Orchestrator } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  const { executeOrchestratorTool } = await import("../llm/orchestrator-tools.js");
  polpo = new Orchestrator(tmpDir);
  await polpo.initInteractive("align", team);
  // createApp gives Polpo's tools the in-process REST API (setPolpoApi)
  createApp(polpo, new SSEBridge(polpo), { workDir: tmpDir });
  run = (name, args = {}) => executeOrchestratorTool(name, args, polpo);
}, 30_000);

afterAll(async () => {
  delete process.env.POLPO_DASHBOARD_URL;
  const { setPolpoApi } = await import("../llm/polpo-mcp-bridge.js");
  setPolpoApi(undefined);
  await rm(tmpDir, { recursive: true, force: true });
});

describe("coverage: every MCP tool has a Polpo counterpart", () => {
  it("each MCP tool is bridged, has an equivalent Polpo tool, or is a justified exception (exactly one)", async () => {
    const { toolScopeMatrix } = await import("../server/mcp.js");
    const { BRIDGED_TOOLS, MCP_EQUIVALENTS, MCP_EXCEPTIONS } = await import("../llm/polpo-mcp-bridge.js");
    const bridged = new Set(BRIDGED_TOOLS.map((t) => t.mcp));
    const mcpNames = [...new Set(toolScopeMatrix().map((t) => t.name))];
    expect(mcpNames.length).toBeGreaterThan(150);
    const missing = mcpNames.filter((n) => !bridged.has(n) && !(n in MCP_EQUIVALENTS) && !(n in MCP_EXCEPTIONS));
    expect(missing).toEqual([]);
    const twice = mcpNames.filter((n) => [bridged.has(n), n in MCP_EQUIVALENTS, n in MCP_EXCEPTIONS].filter(Boolean).length > 1);
    expect(twice).toEqual([]);
    // nothing stale: every entry names a tool the MCP server has
    const known = new Set(mcpNames);
    expect([...bridged, ...Object.keys(MCP_EQUIVALENTS), ...Object.keys(MCP_EXCEPTIONS)].filter((n) => !known.has(n))).toEqual([]);
    // exceptions say why
    for (const reason of Object.values(MCP_EXCEPTIONS)) expect(reason.length).toBeGreaterThan(30);
    expect(Object.keys(MCP_EXCEPTIONS).sort()).toEqual(["agent_card_refresh", "polpo_answer", "polpo_api_get", "polpo_api_search", "polpo_ask"]);
  });

  it("every counterpart is one of Polpo's tools, and Polpo's tool names are unique", async () => {
    const { ALL_ORCHESTRATOR_TOOLS } = await import("../llm/orchestrator-tools.js");
    const { BRIDGED_TOOLS, MCP_EQUIVALENTS } = await import("../llm/polpo-mcp-bridge.js");
    const names = ALL_ORCHESTRATOR_TOOLS.map((t) => t.name);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    const have = new Set(names);
    expect([...BRIDGED_TOOLS.map((t) => t.name), ...Object.values(MCP_EQUIVALENTS)].filter((n) => !have.has(n))).toEqual([]);
  });

  it("the areas the product added recently are all reachable from Polpo", async () => {
    const { ALL_ORCHESTRATOR_TOOLS } = await import("../llm/orchestrator-tools.js");
    const have = new Set(ALL_ORCHESTRATOR_TOOLS.map((t) => t.name));
    for (const name of [
      "harnesses_get", "harnesses_update", "harness_sessions_list", "harness_session_control", "setup_wait",
      "computer_save", "computer_control", "computer_delete", "egress_status",
      "connector_catalog", "connector_add", "connector_update", "connector_test", "connector_disconnect",
      "channels_list", "channel_save", "channel_remove", "channel_route_set", "channel_pairing", "channel_peers", "channel_whatsapp_login",
      "branding_get", "branding_update", "config_update", "sandbox_update", "policies_update", "members_invite", "mcp_access_list", "mcp_grant_revoke",
      "data_activity", "rooms_list", "room_post", "chat_sessions_list", "schedule_run", "check_update", "check_delete", "mission_wait",
    ]) expect(have.has(name), name).toBe(true);
    const params = (n: string) => Object.keys(((ALL_ORCHESTRATOR_TOOLS.find((t) => t.name === n)!.parameters as any).properties ?? {}));
    for (const n of ["add_agent", "update_agent"]) {
      expect(params(n)).toEqual(expect.arrayContaining(["engine", "computers", "defaultComputer", "connectorTools", "browserEgress", "progressiveTools"]));
    }
  });

  it("texts name Polpo's tools, not the MCP ones", async () => {
    const { bridgedTools, polpoToolNames } = await import("../llm/polpo-mcp-bridge.js");
    expect(polpoToolNames("then call polpo_setup_wait and polpo_agent_update; polpo_ask stays")).toBe("then call setup_wait and update_agent; polpo_ask stays");
    const leaks = bridgedTools().filter((t) => /\bpolpo_(?!ask|answer|api_)[a-z_]+/.test(t.description)).map((t) => t.name);
    expect(leaks).toEqual([]);
  });
});

describe("up front vs on demand", () => {
  it("the essential tools are up front; the new less common ones are in named groups tools_search finds", async () => {
    const { ALL_ORCHESTRATOR_TOOLS } = await import("../llm/orchestrator-tools.js");
    const { BRIDGED_TOOLS } = await import("../llm/polpo-mcp-bridge.js");
    const { ProgressiveToolSet, POLPO_TOOL_GROUPS } = await import("@polpo-ai/core/progressive-tools");
    const set = new ProgressiveToolSet({ tools: ALL_ORCHESTRATOR_TOOLS, groups: POLPO_TOOL_GROUPS });
    const upFront = new Set(set.initialTools({ plainMeta: true }).map((t) => t.name));
    for (const n of ["add_agent", "update_agent", "agent_get", "setup_wait", "connector_add", "connectors_list", "list_models"]) expect(upFront.has(n), n).toBe(true);
    const groups = new Map(set.groups().map((g) => [g.id, g.tools]));
    for (const b of BRIDGED_TOOLS) {
      if (!b.group) { expect(upFront.has(b.name), b.name).toBe(true); continue; }
      expect(upFront.has(b.name), b.name).toBe(false);
      expect(groups.get(b.group), `${b.name} in ${b.group}`).toContain(b.name);
    }
    // the bridge added only two tools up front
    expect(BRIDGED_TOOLS.filter((b) => !b.group).map((b) => b.name)).toEqual(["setup_wait", "agent_get", "connector_add"]);
    const hits = set.search("claude code harness bedrock").map((h) => h.name);
    expect(hits).toContain("harnesses_update");
    expect(set.search("whatsapp qr login").map((h) => h.name)).toContain("channel_whatsapp_login");
    expect(set.search("logo dark theme palette").map((h) => h.name)).toContain("branding_update");
  });

  it("bridged reads are read tools, the rest write tools", async () => {
    const { READ_TOOLS, WRITE_TOOLS } = await import("../llm/orchestrator-tools.js");
    expect(READ_TOOLS.has("harnesses_get")).toBe(true);
    expect(READ_TOOLS.has("setup_wait")).toBe(true);
    expect(WRITE_TOOLS.has("harnesses_update")).toBe(true);
    expect(WRITE_TOOLS.has("computer_delete")).toBe(true);
    expect(WRITE_TOOLS.has("connector_add")).toBe(true);
  });
});

describe("the bridged tools on a real instance", () => {
  it("harnesses_update: enables Claude Code with a vault reference and hands off the key with a setup link; setup_wait waits for it", async () => {
    const r = await run("harnesses_update", { enabled: ["claude-code"], claude_code: { auth: "api-key", credential_ref: { owner: "agent-1", service: "anthropic" } } });
    expect(r).not.toMatch(/^Error/);
    expect(r).toMatch(/Claude Code \(claude-code\): enabled/);
    expect(r).toContain(`${DASHBOARD}/agents/agent-1?`);
    expect(r).toMatch(/setup_wait \{ setup_id: "vault:agent-1:anthropic" \}/);
    expect(r).not.toMatch(/polpo_setup_wait/);
    const wait = await run("setup_wait", { setup_id: "vault:agent-1:anthropic", timeout_seconds: 0 });
    expect(wait).toMatch(/Still waiting for vault:agent-1:anthropic/);
    expect(await run("harnesses_get")).toMatch(/MISSING in the vault/);
  });

  it("refuses a Claude subscription and bad input, as the MCP server does", async () => {
    expect(await run("harnesses_update", { claude_code: { auth: "subscription" } })).toMatch(/^Error: .*Anthropic's terms/);
    expect(await run("harnesses_update", { enabled: ["cursor"] })).toMatch(/^Error: invalid arguments for harnesses_update: enabled/);
    expect(await run("harnesses_update", {})).toMatch(/^Error: Nothing to change/);
  });

  it("add_agent / update_agent: engine, computers and connector tools, checked like the API", async () => {
    // unknown computer
    expect(await run("add_agent", { name: "coder", defaultComputer: "nina" })).toMatch(/^Error: Unknown computer: nina/);
    // a harness needs a remote computer (or allowHost): a clear refusal with what to do
    const refused = await run("add_agent", { name: "coder", engine: { harness: "claude-code" } });
    expect(refused).toMatch(/^Error: .*Claude Code runs inside the agent's computer/);
    expect(refused).toMatch(/computer_save/);
    expect((await polpo.getAgents()).some((a) => a.name === "coder")).toBe(false);

    const saved = await run("computer_save", { id: "nina", name: "Nina", kind: "daytona" });
    expect(saved).not.toMatch(/^Error/);
    // Daytona v0 cannot run a harness: said plainly
    expect(await run("add_agent", { name: "coder", engine: { harness: "claude-code" }, defaultComputer: "nina" })).toMatch(/Daytona v2/);

    expect(await run("harnesses_update", { allow_host: true })).not.toMatch(/^Error/);
    const added = await run("add_agent", {
      name: "coder", role: "Coder", engine: { harness: "claude-code", effort: "high", maxBudgetUsd: 5 }, computers: ["nina"],
      connectorTools: { linear: ["search_issues"] }, progressiveTools: "always", browserEgress: "",
    });
    expect(added).toMatch(/Agent "coder" added .*engine claude-code/);
    let coder = (await polpo.getAgents()).find((a) => a.name === "coder")!;
    expect(coder.engine).toEqual({ harness: "claude-code", effort: "high", maxBudgetUsd: 5 });
    expect(coder.computers).toEqual(["nina"]);
    expect(coder.connectorTools).toEqual({ linear: ["search_issues"] });
    expect(coder.progressiveTools).toBe("always");

    // agent_get shows the engine
    expect(await run("agent_get", { name: "coder" })).toMatch(/engine: claude-code harness/);

    expect(await run("update_agent", { name: "coder", engine: "polpo", computers: [], connectorTools: null })).toMatch(/updated/);
    coder = (await polpo.getAgents()).find((a) => a.name === "coder")!;
    expect(coder.engine).toBeUndefined();
    expect(coder.computers).toBeUndefined();
    expect(coder.connectorTools).toBeUndefined();
  });

  it("destructive tools need confirm: true", async () => {
    expect(await run("computer_save", { id: "desk", kind: "host" })).not.toMatch(/^Error/);
    const first = await run("computer_delete", { id: "desk" });
    expect(first).toMatch(/^Error: .*confirm: true/);
    expect(polpo.getConfig()?.settings?.computers?.some((c) => c.id === "desk")).toBe(true);
    expect(await run("computer_delete", { id: "desk", confirm: true })).not.toMatch(/^Error/);
    expect(polpo.getConfig()?.settings?.computers?.some((c) => c.id === "desk") ?? false).toBe(false);
    expect(await run("harness_session_control", { key: "task:x", action: "reset" })).toMatch(/^Error: .*confirm: true/);
  });

  it("connector_add never takes a token: a token-based connector is finished from a setup link", async () => {
    const r = await run("connector_add", { catalog_id: "render" });
    expect(r).toMatch(/Added Render \[render\]/);
    expect(r).toContain(`${DASHBOARD}/connectors?`);
    expect(r).toMatch(/setup_wait \{ setup_id: "connector:render:bearerToken" \}/);
    // a token passed anyway is not a parameter: it is dropped, never stored, and the person still gets the link
    const again = await run("connector_add", { catalog_id: "render", id: "render-b", token: "sk-should-not-pass" });
    expect(again).toMatch(/setup_wait \{ setup_id: "connector:render-b:bearerToken" \}/);
    expect(again).not.toContain("sk-should-not-pass");
    expect(await polpo.getVaultStore()?.get("$connectors", "render-b").catch(() => undefined)).toBeFalsy();
  });

  it("no bridged or agent tool takes a secret as a parameter", async () => {
    const { ALL_ORCHESTRATOR_TOOLS } = await import("../llm/orchestrator-tools.js");
    const { BRIDGED_TOOL_NAMES } = await import("../llm/polpo-mcp-bridge.js");
    // (channel_invite's token is an invite code, not a secret)
    const secretish = /^(token|.*_token|.*Token|api_?key|apiKey|password|secret|.*_secret|.*Secret|client_secret)$/;
    const keys = (schema: any, path = ""): string[] => {
      if (!schema || typeof schema !== "object") return [];
      const out: string[] = [];
      for (const [k, v] of Object.entries(schema.properties ?? {})) out.push(`${path}${k}`, ...keys(v, `${path}${k}.`));
      for (const alt of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])]) out.push(...keys(alt, path));
      if (schema.items) out.push(...keys(schema.items, path));
      return out;
    };
    const offenders = ALL_ORCHESTRATOR_TOOLS
      .filter((t) => BRIDGED_TOOL_NAMES.has(t.name) || ["add_agent", "update_agent", "connector_update_access", "connector_connect"].includes(t.name))
      .flatMap((t) => keys(t.parameters).filter((k) => secretish.test(k.split(".").pop()!)).map((k) => `${t.name}.${k}`))
      .filter((k) => k !== "channel_invite.token");
    expect(offenders).toEqual([]);
  });

  it("without the server the bridged tools say so instead of failing obscurely", async () => {
    const { setPolpoApi, executeBridgedTool } = await import("../llm/polpo-mcp-bridge.js");
    setPolpoApi(undefined);
    try {
      expect(await executeBridgedTool("harnesses_get", {})).toMatch(/^Error: .*needs Polpo's server/);
    } finally {
      const { createApp } = await import("../server/app.js");
      const { SSEBridge } = await import("../server/sse-bridge.js");
      createApp(polpo, new SSEBridge(polpo), { workDir: tmpDir });
    }
  });
});

describe("Polpo's prompt", () => {
  it("states what Polpo can do now, accurately", async () => {
    const { buildChatSystemPrompt } = await import("../llm/prompts.js");
    const prompt = await buildChatSystemPrompt(polpo, null);
    for (const line of [
      "### Computers, harnesses and egress",
      "On Daytona v2 a computer hibernates",
      "A harness runs the agent's tasks only",
      "a Daytona v2 computer as defaultComputer",
      "A Claude subscription (Pro/Max login) is not allowed",
      "Amazon Bedrock",
      "is\nfor the browser only".replace("\n", " "),
      "update_agent connectorTools",
      "Secrets (API keys, tokens, bot tokens, passwords, client secrets) never go through the chat",
      "setup_wait",
      "config_update",
      "orchestrator_name",
      "mcp_access_list",
      "branding_update",
      "data_activity",
    ]) expect(prompt.replace(/`,\n\s*`/g, " ").replace(/\s+/g, " "), line).toContain(line.replace(/\s+/g, " "));
    expect(prompt).not.toMatch(/tokens pasted in chat go to the vault/);
  });

  it("knows its configured name", async () => {
    const { orchestratorIdentity } = await import("../llm/prompts.js");
    expect(orchestratorIdentity("Nina").join(" ")).toMatch(/Your name is Nina/);
  });
});

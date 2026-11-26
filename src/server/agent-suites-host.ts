/**
 * Agent suites wired to the running instance: suites and runs under .polpo/agent-suites/, each case
 * a chat turn through the in-process chat completions pipeline (the agent's real path) inside the
 * case's hooks, its chat deleted afterwards. The suite's roles (judge, simulated user, generator,
 * reviewer) run through that same `turn` (see AgentSuiteRunner.playRole): no model is called here.
 * Phase 4: the vault's values redacted from recordings, chats and task runs recorded as cases, and
 * the targets other than an agent (hosted MCP servers' saved tests, missions).
 */
import { trustedApiCallHeaders } from "@polpo-ai/server";
import type { AgentConfig } from "@polpo-ai/core";
import {
  hostedServerStorage, hostedServerSuite, type ActivityEntryLike, type AgentGenerationInfo, type ChatMessageLike, type MissionTaskLike,
} from "@polpo-ai/core";
import type { Orchestrator } from "../core/orchestrator.js";
import { AgentSuiteRunner, runAsSuiteCase, type AgentSuiteDeps, type SessionToolCall, type SuiteTurnResult } from "./agent-suites.js";
import { FileAgentSuiteStore } from "../stores/file-agent-suite-store.js";
import { FileBenchmarkStore } from "../stores/file-benchmark-store.js";
import { AgentBenchmarks } from "./agent-benchmarks.js";
import { sandboxedCustomScorer } from "./agent-suite-scorers.js";
import { decisionServiceFor } from "../decisions/service.js";
import { AgentDeployGates } from "./agent-deploy-gates.js";
import { deployGateSummary } from "@polpo-ai/core";
import { mcpServerServiceFor } from "./mcp-servers-runtime.js";
import { connectorManagerFor } from "../mcp/runtime.js";
import type { McpServerTestCase } from "../mcp-servers/types.js";
import { isRoleBlock, type SuiteRole } from "@polpo-ai/core";

export interface AgentSuiteHostOptions {
  orchestrator: Orchestrator;
  /** The in-process chat completions app (agent-direct turns). */
  completions: (req: Request) => Response | Promise<Response>;
  /** The instance's own REST API (`/tasks/…`, `/agents/processes/…/activity`), called in process. */
  api?: (path: string) => Response | Promise<Response>;
}

const runners = new WeakMap<Orchestrator, { polpoDir: string; runner: AgentSuiteRunner }>();

/** The instance's suite runner (one per orchestrator and .polpo directory). */
export function agentSuiteRunnerFor(opts: AgentSuiteHostOptions): AgentSuiteRunner {
  const o = opts.orchestrator;
  const cached = runners.get(o);
  if (cached && cached.polpoDir === o.getPolpoDir()) return cached.runner;
  const runner = new AgentSuiteRunner(agentSuiteDeps(opts));
  runners.set(o, { polpoDir: o.getPolpoDir(), runner });
  return runner;
}

const benchmarkManagers = new WeakMap<Orchestrator, { polpoDir: string; benchmarks: AgentBenchmarks }>();

/** The instance's benchmarks and Playground (phase 5): suite runs per variant, compared; chat panes per variant. */
export function agentBenchmarksFor(opts: AgentSuiteHostOptions): AgentBenchmarks {
  const o = opts.orchestrator;
  const cached = benchmarkManagers.get(o);
  if (cached && cached.polpoDir === o.getPolpoDir()) return cached.benchmarks;
  const deps = agentSuiteDeps(opts);
  const priceOf = async (spec: string | undefined) => {
    try {
      const { resolveModel } = await import("../llm/pi-client.js");
      const m = resolveModel(spec);
      return { model: `${m.provider}:${m.id}`, price: { input: Number(m.cost?.input) || 0, output: Number(m.cost?.output) || 0 } };
    } catch { return undefined; }
  };
  const benchmarks = new AgentBenchmarks({
    runner: () => agentSuiteRunnerFor(opts),
    store: new FileBenchmarkStore(o.getPolpoDir()),
    agents: () => o.getAgents(),
    resolveAgent: deps.resolveAgent,
    price: priceOf,
    // the judge's model: its agent's, its block's, else Polpo's
    judgePrice: async (role?: SuiteRole) => {
      let spec: string | undefined;
      if (role?.agent) {
        const at = role.agent.lastIndexOf("@");
        const agent = await deps.resolveAgent(at > 0 ? role.agent.slice(0, at) : role.agent, at > 0 ? role.agent.slice(at + 1) : undefined).catch(() => undefined);
        spec = typeof agent?.model === "string" ? agent.model : undefined;
      } else if (isRoleBlock(role)) {
        spec = role!.model;
      } else {
        const m = o.getConfig()?.settings?.orchestratorModel;
        spec = typeof m === "string" ? m : (m as { primary?: string } | undefined)?.primary;
      }
      return spec ? (await priceOf(spec))?.price : undefined;
    },
    emit: (e) => o.emit("benchmark:progress", e),
    writeDraft: async (agent, fields, w) => {
      const r = await o.updateAgentVersioned(agent, fields as never, { actor: w.actor ?? "person:dashboard", mode: "draft", ...(w.note ? { note: w.note } : {}) });
      return { draftChanged: r.draftChanged };
    },
  });
  benchmarkManagers.set(o, { polpoDir: o.getPolpoDir(), benchmarks });
  return benchmarks;
}

const gateManagers = new WeakMap<Orchestrator, { polpoDir: string; gates: AgentDeployGates }>();

/**
 * The instance's deploy gates (one per orchestrator): required suites run before a version reaches
 * production; the orchestrator calls them for every deploy (Orchestrator.setAgentDeployGate).
 */
export function agentDeployGatesFor(opts: AgentSuiteHostOptions): AgentDeployGates {
  const o = opts.orchestrator;
  const cached = gateManagers.get(o);
  if (cached && cached.polpoDir === o.getPolpoDir()) return cached.gates;
  const gates = new AgentDeployGates({
    runner: () => agentSuiteRunnerFor(opts),
    versioning: () => o.getAgentVersioning(),
    deploy: (name, version, d) => o.deployAgentVersion(name, version, d),
    emit: (g) => {
      o.emit("agent:gate", {
        agentName: g.agent, gateId: g.id, version: g.version, status: g.status, trigger: g.trigger, progress: g.progress,
        summary: deployGateSummary(g), timestamp: new Date().toISOString(),
      });
    },
    changed: (name) => { void o.notifyAgentChanged(name); },
  });
  gateManagers.set(o, { polpoDir: o.getPolpoDir(), gates });
  return gates;
}

/** The vault's values (every owner), and secret-looking environment values: redacted from recordings. */
async function vaultSecrets(o: Orchestrator): Promise<string[]> {
  const out = new Set<string>();
  const vault = o.getVaultStore();
  const owners = new Set<string>(["polpo", "$providers", "$data", ...(await o.getAgents()).map((a) => a.name)]);
  for (const owner of owners) {
    const all = await vault?.getAllForAgent(owner).catch(() => ({})) ?? {};
    for (const entry of Object.values(all) as Array<{ credentials?: Record<string, unknown> }>) {
      for (const v of Object.values(entry.credentials ?? {})) if (typeof v === "string" && v.length >= 6) out.add(v);
    }
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (v && v.length >= 8 && /(KEY|TOKEN|SECRET|PASSWORD)/i.test(k)) out.add(v);
  }
  return [...out];
}

export function agentSuiteDeps(opts: AgentSuiteHostOptions): AgentSuiteDeps {
  const o = opts.orchestrator;
  const api = async <T>(path: string): Promise<T | undefined> => {
    if (!opts.api) return undefined;
    const res = await opts.api(path);
    if (!res.ok) return undefined;
    const body = await res.json().catch(() => undefined) as { data?: T } | undefined;
    return body?.data;
  };
  const hosted = () => mcpServerServiceFor(o);
  return {
    store: new FileAgentSuiteStore(o.getPolpoDir()),
    // evals: custom scorers in the sandbox (the judge and the other roles are chat turns: `turn`)
    customScorer: sandboxedCustomScorer(),
    // decision scorers: the instance's decide() (the decision model; logged as a suite's decision)
    decide: async (req) => {
      const service = decisionServiceFor(o.getPolpoDir());
      if (!service) throw new Error("Decisions are not available on this server");
      const r = await service.decide(req, { kind: "suite" });
      return { answers: r.answers, model: r.model, costUsd: r.costUsd, calibrated: r.calibrated };
    },
    // phase 4: recordings
    secrets: () => vaultSecrets(o),
    agentInfo: async (agent: AgentConfig): Promise<AgentGenerationInfo> => {
      const connectors = connectorManagerFor(o).store.list()
        .filter((c) => { const a = (c as { access?: { agents?: string[] | "*" } }).access?.agents; return a === "*" || (Array.isArray(a) && a.includes(agent.name)); })
        .map((c) => ({ id: c.id, name: (c as { name?: string }).name ?? c.id }));
      return {
        name: agent.name, ...(agent.role ? { role: agent.role } : {}), ...(agent.systemPrompt ? { instructions: agent.systemPrompt } : {}),
        tools: (agent.allowedTools ?? []).map((name) => ({ name })),
        ...((agent as { skills?: string[] }).skills?.length ? { skills: (agent as { skills: string[] }).skills.map((name) => ({ name })) } : {}),
        ...(connectors.length ? { connectors } : {}),
      };
    },
    sessionMessages: async (sessionId) => {
      const store = o.getSessionStore();
      const session = await store?.getSession(sessionId).catch(() => undefined);
      if (!store || !session) return undefined;
      const messages = await store.getMessages(sessionId);
      return {
        ...(session.agent ? { agent: session.agent } : {}), ...(session.title ? { title: session.title } : {}),
        messages: messages.map((m): ChatMessageLike => ({
          role: m.role, content: typeof m.content === "string" ? m.content : "",
          ...(m.toolCalls?.length ? { toolCalls: m.toolCalls.map((t) => ({ id: t.id, name: t.name, ...(t.arguments ? { arguments: t.arguments as Record<string, unknown> } : {}), ...(t.result !== undefined ? { result: t.result } : {}), ...(t.state ? { state: t.state } : {}) })) } : {}),
        })),
      };
    },
    taskActivity: async (taskId) => {
      const task = await api<{ title: string; description: string; assignTo?: string }>(`/tasks/${encodeURIComponent(taskId)}`);
      if (!task) return undefined;
      const entries = await api<ActivityEntryLike[]>(`/agents/processes/${encodeURIComponent(taskId)}/activity`) ?? [];
      return { title: task.title, description: task.description, ...(task.assignTo ? { assignTo: task.assignTo } : {}), entries };
    },
    targets: {
      // a hosted server's saved tests are its suite (tests.json + server.json's suite settings)
      mcpServer: {
        exists: (id) => hosted().store.exists(id),
        readSuite: (id) => {
          const s = hosted().suiteStorage(id);
          return hostedServerSuite({ id, name: s.name, createdAt: s.createdAt }, s.tests, s.settings);
        },
        writeSuite: (suite) => {
          const { tests, settings } = hostedServerStorage(suite);
          hosted().saveSuiteStorage(suite.target.kind === "mcp-server" ? suite.target.server : suite.agent.replace(/^mcp-server:/, ""), tests as McpServerTestCase[], settings);
        },
        production: (id) => hosted().store.production(id),
        tools: (id, ref) => hosted().toolKinds(id, ref),
        call: (id, req) => hosted().suiteCall(id, req),
      },
      mission: {
        exists: async (id) => !!(await o.getMission(id).catch(() => undefined)),
        document: async (id) => {
          const mission = await o.getMission(id).catch(() => undefined);
          if (!mission) return undefined;
          let doc: { tasks?: MissionTaskLike[]; checkpoints?: unknown[]; delays?: unknown[]; qualityGates?: unknown[] };
          try { doc = JSON.parse(mission.data); } catch { return undefined; }
          const notes: string[] = [];
          if (doc.checkpoints?.length) notes.push(`${doc.checkpoints.length} checkpoint(s) not run in test mode (the tasks go on)`);
          if (doc.delays?.length) notes.push(`${doc.delays.length} delay(s) not run in test mode`);
          if (doc.qualityGates?.length) notes.push(`${doc.qualityGates.length} quality gate(s) not run in test mode (no review: check the tasks with assertions)`);
          return { name: mission.name, tasks: (doc.tasks ?? []).map((t) => ({ title: t.title, description: t.description, ...(t.assignTo ? { assignTo: t.assignTo } : {}), ...(t.dependsOn?.length ? { dependsOn: t.dependsOn } : {}) })), notes };
        },
        defaultAgent: async () => (await o.getAgents())[0]?.name,
      },
    },
    agents: () => o.getAgents(),
    resolveAgent: async (name, ref) => {
      const live = (await o.getAgents()).find((a) => a.name === name);
      if (!live) return undefined;
      if (ref === "draft") {
        const { config } = await o.getAgentVersioning().draftConfig(name);
        return { ...live, ...(config as Partial<AgentConfig>), name };
      }
      if (!ref) return live;
      return (await o.getAgentVersioning().resolve(name, ref))?.agent;
    },
    productionVersion: async (name) => (await o.getAgentVersioning().state(name)).production ?? undefined,
    turn: (agentRef, messages, hooks, turnOpts) => runAsSuiteCase(hooks, async (): Promise<SuiteTurnResult> => {
      const stream = !!turnOpts?.onText;
      const res = await opts.completions(new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": "new", ...trustedApiCallHeaders() },
        // no agent: Polpo's own chat (a suite role played by Polpo)
        body: JSON.stringify({ ...(agentRef ? { agent: agentRef } : {}), stream, messages }),
      }));
      // the Playground streams the reply: OpenAI chunks (data: {...}) ending with [DONE]
      const body = stream && res.ok && res.body ? await readCompletionStream(res.body, turnOpts!.onText!) : await res.json().catch(() => ({})) as {
        choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
        error?: { message?: string };
      };
      const sessionId = res.headers.get("x-session-id") ?? undefined;
      const store = o.getSessionStore();
      let toolCalls: SessionToolCall[] = [];
      if (sessionId && store) {
        const stored = await store.getMessages(sessionId).catch(() => []);
        toolCalls = stored.filter((m) => m.role === "assistant").flatMap((m) => (m.toolCalls ?? []).map((t) => ({
          id: t.id, name: t.name, ...(t.arguments ? { arguments: t.arguments as Record<string, unknown> } : {}),
          ...(t.result !== undefined ? { result: typeof t.result === "string" ? t.result : JSON.stringify(t.result) } : {}),
          ...(t.state ? { state: t.state } : {}),
        })));
        // a test turn, not a conversation: it does not stay in the agent's chats
        await store.deleteSession(sessionId).catch(() => undefined);
      }
      if (!res.ok) throw new Error(body.error?.message ?? `The chat turn failed (HTTP ${res.status})`);
      const choice = body.choices?.[0];
      return { text: choice?.message?.content ?? "", ...(choice?.finish_reason ? { finishReason: choice.finish_reason } : {}), toolCalls };
    }),
  };
}

/** Read a streamed completion (SSE chunks): every text delta to `onText`, then the whole reply as a non-streamed body. */
async function readCompletionStream(body: ReadableStream<Uint8Array>, onText: (delta: string) => void): Promise<{ choices: Array<{ message: { content: string }; finish_reason?: string }>; error?: { message?: string } }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let text = "";
  let finish: string | undefined;
  let error: string | undefined;
  const handle = (line: string) => {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    try {
      const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>; error?: { message?: string } };
      if (chunk.error?.message) error = chunk.error.message;
      const c = chunk.choices?.[0];
      if (c?.delta?.content) { text += c.delta.content; try { onText(c.delta.content); } catch { /* a listener's problem */ } }
      if (c?.finish_reason) finish = c.finish_reason;
    } catch { /* not JSON: skip */ }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, nl).trim()); buf = buf.slice(nl + 1); }
  }
  if (buf.trim()) handle(buf.trim());
  return { choices: [{ message: { content: text }, ...(finish ? { finish_reason: finish } : {}) }], ...(error ? { error: { message: error } } : {}) };
}

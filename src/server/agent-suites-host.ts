/**
 * Agent suites wired to the running instance: suites and runs under .polpo/agent-suites/, each case
 * a chat turn through the in-process chat completions pipeline (the agent's real path) inside the
 * case's hooks, its chat deleted afterwards. Phase 4: the simulated user's and the case generator's
 * model, the vault's values redacted from recordings, chats and task runs recorded as cases, and
 * the targets other than an agent (hosted MCP servers' saved tests, missions).
 */
import { trustedApiCallHeaders } from "@polpo-ai/server";
import type { AgentConfig } from "@polpo-ai/core";
import {
  hostedServerStorage, hostedServerSuite, type ActivityEntryLike, type AgentGenerationInfo, type ChatMessageLike, type MissionTaskLike,
} from "@polpo-ai/core";
import type { Orchestrator } from "../core/orchestrator.js";
import { AgentSuiteRunner, runAsSuiteCase, type AgentSuiteDeps, type SessionToolCall, type SuiteCompletion, type SuiteTurnResult } from "./agent-suites.js";
import { FileAgentSuiteStore } from "../stores/file-agent-suite-store.js";
import { sandboxedCustomScorer, suiteJudge, suiteReviewer } from "./agent-suite-scorers.js";
import { AgentDeployGates } from "./agent-deploy-gates.js";
import { deployGateSummary } from "@polpo-ai/core";
import { mcpServerServiceFor } from "./mcp-servers-runtime.js";
import { connectorManagerFor } from "../mcp/runtime.js";
import type { McpServerTestCase } from "../mcp-servers/types.js";
import type { ModelConfig } from "../core/types.js";

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

/** One completion with `model` (temperature 0), else with Polpo's effective model: the simulated user, the case generator. */
function suiteCompletion(configured: () => string | ModelConfig | undefined): SuiteCompletion {
  const judge = suiteJudge(configured);
  const reviewer = suiteReviewer(configured);
  // a given model: one completion (the judge's path, temperature 0); else Polpo's model
  return async ({ prompt, model }) => (model ? judge({ model, prompt }) : reviewer(prompt));
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
  const orchestratorModel = () => o.getConfig()?.settings?.orchestratorModel;
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
    // evals: the LLM judge, "explain this run", custom scorers in the sandbox
    judge: suiteJudge(orchestratorModel),
    review: suiteReviewer(orchestratorModel),
    customScorer: sandboxedCustomScorer(),
    // phase 4: the simulated user, case generation, recordings
    simulate: suiteCompletion(orchestratorModel),
    generate: suiteCompletion(orchestratorModel),
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
    turn: (agentRef, messages, hooks) => runAsSuiteCase(hooks, async (): Promise<SuiteTurnResult> => {
      const res = await opts.completions(new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": "new", ...trustedApiCallHeaders() },
        body: JSON.stringify({ agent: agentRef, stream: false, messages }),
      }));
      const body = await res.json().catch(() => ({})) as {
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

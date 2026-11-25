/**
 * Agent suites wired to the running instance: suites and runs under .polpo/agent-suites/, each case
 * a chat turn through the in-process chat completions pipeline (the agent's real path) inside the
 * case's hooks, its chat deleted afterwards.
 */
import { trustedApiCallHeaders } from "@polpo-ai/server";
import type { AgentConfig } from "@polpo-ai/core";
import type { Orchestrator } from "../core/orchestrator.js";
import { AgentSuiteRunner, runAsSuiteCase, type AgentSuiteDeps, type SessionToolCall, type SuiteTurnResult } from "./agent-suites.js";
import { FileAgentSuiteStore } from "../stores/file-agent-suite-store.js";
import { sandboxedCustomScorer, suiteJudge, suiteReviewer } from "./agent-suite-scorers.js";

export interface AgentSuiteHostOptions {
  orchestrator: Orchestrator;
  /** The in-process chat completions app (agent-direct turns). */
  completions: (req: Request) => Response | Promise<Response>;
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

export function agentSuiteDeps(opts: AgentSuiteHostOptions): AgentSuiteDeps {
  const o = opts.orchestrator;
  const orchestratorModel = () => o.getConfig()?.settings?.orchestratorModel;
  return {
    store: new FileAgentSuiteStore(o.getPolpoDir()),
    // evals: the LLM judge, "explain this run", custom scorers in the sandbox
    judge: suiteJudge(orchestratorModel),
    review: suiteReviewer(orchestratorModel),
    customScorer: sandboxedCustomScorer(),
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

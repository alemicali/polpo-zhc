/**
 * Agent tests wired to the running instance: each dependency of AgentTester (src/server/agent-tests.ts)
 * calls the same code as the existing connection tests (harness test, CLI account status, connector
 * test, sandbox provider test, computer status and egress), so a test here behaves as the real thing.
 */
import { HOST_COMPUTER_ID, agentConnectorIdentity, isRemoteComputer, type AgentConfig, type ComputerConfig, type ConnectorConfig } from "@polpo-ai/core";
import type { Orchestrator } from "../core/orchestrator.js";
import type { ComputerManager } from "../sandbox/computers.js";
import { AgentTester, type AgentTestDeps, type SmokeResult } from "./agent-tests.js";
import { FileAgentTestStore } from "../stores/file-agent-test-store.js";
import { connectorManagerFor } from "../mcp/runtime.js";
import { loadAgentSkills } from "../llm/skills.js";
import { listSkillVersions } from "../llm/skill-versions.js";

export interface AgentTestHostOptions {
  orchestrator: Orchestrator;
  computerManager: () => ComputerManager;
  /** Runs a command on a remote computer (undefined: it is not running). */
  onComputer: (computerId: string, command: string, timeoutMs: number) => Promise<{ exitCode: number; stdout: string; stderr: string } | undefined>;
  /** The in-process chat completions app (agent-direct turns). */
  completions: (req: Request) => Response | Promise<Response>;
  instanceAuth: () => boolean;
}

const testers = new WeakMap<Orchestrator, { polpoDir: string; tester: AgentTester }>();

/** The instance's AgentTester (one per orchestrator and .polpo directory). */
export function agentTesterFor(opts: AgentTestHostOptions): AgentTester {
  const o = opts.orchestrator;
  const cached = testers.get(o);
  if (cached && cached.polpoDir === o.getPolpoDir()) return cached.tester;
  const tester = new AgentTester(agentTestDeps(opts));
  testers.set(o, { polpoDir: o.getPolpoDir(), tester });
  return tester;
}

export function agentTestDeps(opts: AgentTestHostOptions): AgentTestDeps {
  const o = opts.orchestrator;
  const settings = () => o.getConfig()?.settings;
  const connectors = () => connectorManagerFor(o);
  const store = new FileAgentTestStore(o.getPolpoDir());
  return {
    agents: () => o.getAgents(),
    settings,
    store,
    versioning: () => {
      const v = o.getAgentVersioning();
      return {
        state: (name) => v.state(name),
        resolve: (name, ref) => v.resolve(name, ref),
        draftConfig: (name) => v.draftConfig(name) as Promise<{ config: Partial<AgentConfig> }>,
        getVersion: (name, version) => v.getVersion(name, version),
      };
    },
    nativeModelTest: async (model) => {
      const { queryText } = await import("../llm/pi-client.js");
      const t0 = Date.now();
      const r = await queryText("Reply with exactly: OK", model);
      return { model: `${String(r.model.provider)}:${r.model.id}`, latencyMs: Date.now() - t0 };
    },
    harnessTest: async ({ harness, settings: hs, agentEngine }) => {
      const { testHarnessConnection } = await import("../harness/test-connection.js");
      return testHarnessConnection({ harness, settings: hs, vault: o.getVaultStore(), agentEngine });
    },
    cliAccountReport: async (account) => {
      const { cliAccountReport, hostAccountOps, remoteAccountPrefix } = await import("../cli-engine/accounts.js");
      if (account.computer === HOST_COMPUTER_ID) return cliAccountReport(account, hostAccountOps());
      return cliAccountReport(account, {
        run: async (command, _env, o2) => {
          const r = await opts.onComputer(account.computer, command, o2?.timeoutMs ?? 30_000);
          if (!r) throw new Error(`Computer "${account.computer}" is not running: start it to check its CLI accounts`);
          return r;
        },
        envFor: () => ({}),
        prefixFor: (a) => remoteAccountPrefix(a),
      });
    },
    instanceAuth: opts.instanceAuth,
    knownTools: async () => (await import("../core/task-tool-scope.js")).knownBuiltinTools(),
    connectors: (): ConnectorConfig[] => connectors().store.list(),
    testConnector: async (id, agent) => {
      const r = agent !== undefined ? await connectors().testAs(id, agentConnectorIdentity(agent)) : await connectors().test(id);
      return { ok: r.ok, status: r.status, ...(r.tools ? { tools: r.tools.map((t) => ({ name: t.name })) } : {}), ...(r.error ? { error: r.error } : {}) };
    },
    grantConnector: async (id, agent) => {
      const manager = connectors();
      const c = manager.store.get(id);
      if (!c) throw new Error(`There is no connector "${id}"`);
      const agents = c.access?.agents;
      if (agents === "*") return;
      manager.store.update(id, { access: { ...c.access, agents: [...new Set([...(Array.isArray(agents) ? agents : []), agent])] } });
      manager.announce(id, "updated");
    },
    vault: () => o.getVaultStore(),
    loadSkills: (agent, names) => loadAgentSkills(o.getAgentWorkDir(), o.getPolpoDir(), agent, names)
      .filter((s) => names.includes(s.name))
      .map((s) => ({ name: s.name, content: s.content, files: s.files?.length ?? 0 })),
    skillVersionExists: (name, version) => [false, true].some((global) =>
      !!listSkillVersions(o.getPolpoDir(), { pool: "agent", ...(global ? { global: true } : {}), name })?.versions.some((v) => v.version === version)),
    computers: () => (settings()?.computers ?? []) as ComputerConfig[],
    computerLive: async (c) => {
      if (!isRemoteComputer(c)) return { status: "running" };
      const live = await opts.computerManager().refresh(c, undefined, { force: true });
      return { status: live.status, ...(live.lastError ? { lastError: live.lastError } : {}) };
    },
    startComputer: async (c) => {
      const { computerSandbox } = await import("../sandbox/manager.js");
      const sb = computerSandbox(c, settings());
      if ("error" in sb) throw new Error(sb.error);
      await opts.computerManager().start(c, sb);
    },
    sandboxProviderStatus: async (provider) => {
      const { remoteProviderStatus } = await import("../sandbox/remote-providers.js");
      const s = (await remoteProviderStatus()).find((p) => p.id === provider);
      return s ? { configured: s.configured, keyFound: s.keyFound } : undefined;
    },
    sandboxProviderTest: async (provider) => {
      const { isRemoteProvider, testRemoteProvider } = await import("../sandbox/remote-providers.js");
      if (!isRemoteProvider(provider)) return { ok: false, error: `Unknown provider "${provider}"` };
      const r = await testRemoteProvider(provider);
      return { ok: r.ok, ...(r.error ? { error: r.error } : {}), ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}) };
    },
    computerEgress: async (c) => {
      const { computerEgressStatus } = await import("../sandbox/computers.js");
      const s = await computerEgressStatus(opts.computerManager(), c, settings(), o.getConfig()?.project);
      return s ? { tailnet: s.tailnet, proxyReachable: s.proxyReachable, effective: s.effective, machine: s.machine, ...((s as { error?: string }).error ? { error: (s as { error?: string }).error } : {}) } : undefined;
    },
    proxyReachable: async (url) => (await import("../tools/browser-egress.js")).proxyReachable(url),
    channelLive: (name) => !!o.getChannelGateway(name) || !!o.getNotificationRouter()?.getChannel(name),
    smoke: async (agentRef, prompt): Promise<SmokeResult> => {
      const t0 = Date.now();
      const res = await opts.completions(new Request("http://localhost/", {
        method: "POST",
        headers: { "content-type": "application/json", "x-session-id": "new" },
        body: JSON.stringify({ agent: agentRef, stream: false, messages: [{ role: "user", content: prompt }] }),
      }));
      const body = await res.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
      if (!res.ok) throw new Error(body.error?.message ?? `The chat turn failed (HTTP ${res.status})`);
      const sessionId = res.headers.get("x-session-id") ?? undefined;
      const store = o.getSessionStore();
      let toolCalls: SmokeResult["toolCalls"] = [];
      if (sessionId && store) {
        const messages = await store.getMessages(sessionId).catch(() => []);
        toolCalls = messages.filter((m) => m.role === "assistant").flatMap((m) => (m.toolCalls ?? []).map((t) => ({ name: t.name, state: t.state, ...(t.result ? { result: t.result } : {}) })));
        // a test turn, not a conversation: it does not stay in the agent's chats
        await store.deleteSession(sessionId).catch(() => undefined);
      }
      return { text: body.choices?.[0]?.message?.content ?? "", toolCalls, latencyMs: Date.now() - t0 };
    },
  };
}

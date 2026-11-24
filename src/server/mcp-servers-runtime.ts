/**
 * Hosted MCP servers in the server process: the service for an orchestrator, and the approval
 * wiring — a call of an approval tool becomes an Approvals request; when a person approves it, the
 * call runs once (here, with the vault); a rejection closes it. Calls queued by task runner
 * processes (no approval hook there) are picked up every few seconds.
 */
import type { Orchestrator } from "../core/orchestrator.js";
import { connectorManagerFor } from "../mcp/runtime.js";
import { McpServerService } from "../mcp-servers/service.js";
import { buildCodeTools } from "../mcp-servers/code-build.js";
import { setHostedApprovalHook, hostedDeps, sharedCodeRunner } from "../mcp-servers/host.js";
import type { McpServerSpec, McpServerTool, PendingCall } from "../mcp-servers/types.js";

export const MCP_SERVER_APPROVAL_GATE = "mcp-server-call";

const services = new Map<string, McpServerService>();
const wired = new WeakSet<Orchestrator>();

/** The service for this orchestrator's .polpo dir. */
export function mcpServerServiceFor(o: Orchestrator): McpServerService {
  const polpoDir = o.getPolpoDir();
  let service = services.get(polpoDir);
  if (!service) {
    service = new McpServerService({
      polpoDir,
      vault: () => o.getVaultStore(),
      connectors: () => connectorManagerFor(o),
      runtime: () => hostedDeps(polpoDir, o.getVaultStore()),
      build: async ({ serverId, versionKey, spec, buildDir }) => {
        const built = await buildCodeTools({ serverId, versionKey, spec, buildDir });
        return built;
      },
      changed: (id, what) => {
        o.emit("mcp-server:changed" as never, { id, what } as never);
        // a new deploy / kill switch: the old workers go
        if (["deployed", "settings", "deleted", "draft"].includes(what)) (sharedCodeRunner() as { stop?: (id: string) => void } | undefined)?.stop?.(id);
      },
    });
    services.set(polpoDir, service);
  }
  wireApprovals(o, service);
  return service;
}

async function requestApproval(o: Orchestrator, call: PendingCall, tool: Pick<McpServerTool, "name" | "title">, spec: Pick<McpServerSpec, "name">): Promise<string | undefined> {
  const request = await o.requestHumanApproval({
    gateId: MCP_SERVER_APPROVAL_GATE,
    gateName: `${spec.name} · ${tool.title ?? tool.name}`,
    payload: {
      kind: "mcp_server_call", serverId: call.serverId, callId: call.id, tool: call.tool, ...(call.version ? { version: call.version } : {}),
      input: call.input, ...(call.requestedBy ? { requestedBy: call.requestedBy } : {}),
      summary: `${spec.name}: ${tool.title ?? tool.name} wants to run with ${JSON.stringify(call.input).slice(0, 400)}`,
    },
  });
  return request?.id;
}

function wireApprovals(o: Orchestrator, service: McpServerService): void {
  if (wired.has(o)) return;
  wired.add(o);
  const polpoDir = o.getPolpoDir();
  setHostedApprovalHook(polpoDir, (call, tool, spec) => requestApproval(o, call, tool, spec));
  o.on("approval:resolved" as never, ((e: { requestId: string; status: "approved" | "rejected"; resolvedBy?: string }) => {
    const call = service.findByApproval(e.requestId);
    if (!call) return;
    void service.resolvePending(call.serverId, call.id, e.status, e.resolvedBy).catch(() => undefined);
  }) as never);
  // calls queued by task runner processes: give them an Approvals request
  const timer = setInterval(() => {
    for (const call of service.allPending()) {
      // in-process calls get theirs at once: leave them a few seconds
      if (call.status !== "pending" || call.approvalId || Date.now() - Date.parse(call.requestedAt) < 4_000) continue;
      const spec = service.specAt(call.serverId, call.version ?? "production");
      const tool = spec?.tools.find((t) => t.name === call.tool);
      if (!spec || !tool) continue;
      void requestApproval(o, call, tool, spec).then((approvalId) => {
        if (approvalId) service.store.savePending({ ...call, approvalId });
      }).catch(() => undefined);
    }
  }, 5_000);
  timer.unref?.();
}

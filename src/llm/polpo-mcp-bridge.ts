/**
 * Polpo's tools that run the MCP server's tools (src/server/mcp-server/*) in process.
 *
 * Everything a person can do from an MCP client (or the dashboard) Polpo can do in chat: the tools
 * below are the MCP server's own handlers, which call the instance's REST API in process, so they
 * follow exactly the same rules (validation, refusals, setup links for secrets, confirm: true for
 * destructive actions). Polpo sees them under its own names (no polpo_ prefix; tool names in their
 * texts are rewritten to Polpo's), most of them in deferred groups (tools_search / tools_load).
 *
 * The map below also says, for every MCP tool, which Polpo tool does the same — or why none does
 * (a justified exception). src/__tests__/polpo-tools-alignment.test.ts keeps it complete.
 */
import { z } from "zod";
import type { Tool } from "@earendil-works/pi-ai";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ApiResponse, McpDeps, Register, ToolExtra, ToolSpec } from "../server/mcp-server/kit.js";
import { registerHarnessTools } from "../server/mcp-server/harnesses.js";
import { registerSetupTools } from "../server/mcp-server/setup.js";
import { registerComputerTools } from "../server/mcp-server/computers.js";
import { registerConnectorTools } from "../server/mcp-server/connectors.js";
import { registerChannelTools } from "../server/mcp-server/channels.js";
import { registerChannelSetupTools } from "../server/mcp-server/channel-setup.js";
import { registerSettingsTools } from "../server/mcp-server/settings.js";
import { registerConfigTools } from "../server/mcp-server/config.js";
import { registerRoomTools } from "../server/mcp-server/rooms.js";
import { registerChatTools } from "../server/mcp-server/chat.js";
import { registerAutomationTools } from "../server/mcp-server/automation.js";
import { registerMissionTools } from "../server/mcp-server/missions.js";
import { registerDataTools } from "../server/mcp-server/data.js";
import { registerBrainTools } from "../server/mcp-server/knowledge.js";
import { registerSkillTools } from "../server/mcp-server/skills.js";
import { registerTeamTools } from "../server/mcp-server/team.js";
import { knownPublicOrigin } from "../mcp/runtime.js";

/** One MCP tool Polpo runs as its own: its Polpo name and the deferred group it belongs to (none: always on). */
export interface BridgedTool {
  mcp: string;
  name: string;
  /** A POLPO_TOOL_GROUPS id (packages/core/src/progressive-tools.ts); undefined: up front. */
  group?: string;
}

export const BRIDGED_TOOLS: BridgedTool[] = [
  // Secrets: the person enters them in the dashboard; Polpo waits (any area may need it)
  { mcp: "polpo_setup_wait", name: "setup_wait" },
  // Team
  { mcp: "polpo_agent_get", name: "agent_get" },
  // Connectors: adding one never takes a secret in chat (token / OAuth app → setup link)
  { mcp: "polpo_connector_add", name: "connector_add" },
  { mcp: "polpo_connector_catalog", name: "connector_catalog", group: "connectors" },
  { mcp: "polpo_connector_update", name: "connector_update", group: "connectors" },
  { mcp: "polpo_connector_test", name: "connector_test", group: "connectors" },
  { mcp: "polpo_connector_disconnect", name: "connector_disconnect", group: "connectors" },
  // Agent harnesses (Claude Code, Codex)
  { mcp: "polpo_harnesses_get", name: "harnesses_get", group: "harnesses" },
  { mcp: "polpo_harnesses_update", name: "harnesses_update", group: "harnesses" },
  { mcp: "polpo_harnesses_test", name: "harnesses_test", group: "harnesses" },
  { mcp: "polpo_harness_sessions_list", name: "harness_sessions_list", group: "harnesses" },
  { mcp: "polpo_harness_session_control", name: "harness_session_control", group: "harnesses" },
  // Computers
  { mcp: "polpo_computer_save", name: "computer_save", group: "computers" },
  { mcp: "polpo_computer_control", name: "computer_control", group: "computers" },
  { mcp: "polpo_computer_delete", name: "computer_delete", group: "computers" },
  // Appearance
  { mcp: "polpo_branding_get", name: "branding_get", group: "appearance" },
  { mcp: "polpo_branding_update", name: "branding_update", group: "appearance" },
  { mcp: "polpo_agent_avatar_set", name: "agent_avatar_set", group: "appearance" },
  // Settings: general, providers, sandbox, policies
  { mcp: "polpo_config_update", name: "config_update", group: "settings" },
  { mcp: "polpo_providers_list", name: "providers_list", group: "settings" },
  { mcp: "polpo_provider_disconnect", name: "provider_disconnect", group: "settings" },
  { mcp: "polpo_custom_providers_list", name: "custom_providers_list", group: "settings" },
  { mcp: "polpo_custom_provider_save", name: "custom_provider_save", group: "settings" },
  { mcp: "polpo_custom_provider_remove", name: "custom_provider_remove", group: "settings" },
  { mcp: "polpo_sandbox_get", name: "sandbox_get", group: "settings" },
  { mcp: "polpo_sandbox_update", name: "sandbox_update", group: "settings" },
  { mcp: "polpo_sandbox_provider_test", name: "sandbox_provider_test", group: "settings" },
  { mcp: "polpo_policies_get", name: "policies_get", group: "settings" },
  { mcp: "polpo_policies_update", name: "policies_update", group: "settings" },
  { mcp: "polpo_approval_gate_save", name: "approval_gate_save", group: "settings" },
  { mcp: "polpo_approval_gate_delete", name: "approval_gate_delete", group: "settings" },
  // Members and MCP access
  { mcp: "polpo_members_list", name: "members_list", group: "access" },
  { mcp: "polpo_members_invite", name: "members_invite", group: "access" },
  { mcp: "polpo_members_remove", name: "members_remove", group: "access" },
  { mcp: "polpo_mcp_access_list", name: "mcp_access_list", group: "access" },
  { mcp: "polpo_mcp_grant_revoke", name: "mcp_grant_revoke", group: "access" },
  // Cloud sync
  { mcp: "polpo_sync_status", name: "sync_status", group: "sync" },
  { mcp: "polpo_sync_update", name: "sync_update", group: "sync" },
  { mcp: "polpo_sync_disconnect", name: "sync_disconnect", group: "sync" },
  { mcp: "polpo_sync_test", name: "sync_test", group: "sync" },
  { mcp: "polpo_sync_run", name: "sync_run", group: "sync" },
  // Channels end to end
  { mcp: "polpo_channels_list", name: "channels_list", group: "channels" },
  { mcp: "polpo_channel_save", name: "channel_save", group: "channels" },
  { mcp: "polpo_channel_remove", name: "channel_remove", group: "channels" },
  { mcp: "polpo_channel_test", name: "channel_test", group: "channels" },
  { mcp: "polpo_channel_routes_list", name: "channel_routes_list", group: "channels" },
  { mcp: "polpo_channel_route_set", name: "channel_route_set", group: "channels" },
  { mcp: "polpo_telegram_verify", name: "channel_telegram_verify", group: "channels" },
  { mcp: "polpo_channel_invite", name: "channel_invite", group: "channels" },
  { mcp: "polpo_channel_peers", name: "channel_peers", group: "channels" },
  { mcp: "polpo_channel_allowlist", name: "channel_allowlist", group: "channels" },
  { mcp: "polpo_channel_pairing", name: "channel_pairing", group: "channels" },
  { mcp: "polpo_whatsapp_login", name: "channel_whatsapp_login", group: "channels" },
  { mcp: "polpo_whatsapp_login_wait", name: "channel_whatsapp_login_wait", group: "channels" },
  { mcp: "polpo_whatsapp_logout", name: "channel_whatsapp_logout", group: "channels" },
  // Rooms (group chats of people and agents)
  { mcp: "polpo_rooms_list", name: "rooms_list", group: "rooms" },
  { mcp: "polpo_room_create", name: "room_create", group: "rooms" },
  { mcp: "polpo_room_update", name: "room_update", group: "rooms" },
  { mcp: "polpo_room_delete", name: "room_delete", group: "rooms" },
  { mcp: "polpo_room_messages", name: "room_messages", group: "rooms" },
  { mcp: "polpo_room_post", name: "room_post", group: "rooms" },
  { mcp: "polpo_room_wait", name: "room_wait", group: "rooms" },
  // Chat sessions
  { mcp: "polpo_chat_sessions_list", name: "chat_sessions_list", group: "chats" },
  { mcp: "polpo_chat_messages", name: "chat_messages", group: "chats" },
  { mcp: "polpo_chat_session_update", name: "chat_session_update", group: "chats" },
  { mcp: "polpo_chat_session_delete", name: "chat_session_delete", group: "chats" },
  // Automation
  { mcp: "polpo_schedule_run", name: "schedule_run", group: "automation" },
  { mcp: "polpo_check_update", name: "check_update", group: "automation" },
  { mcp: "polpo_check_delete", name: "check_delete", group: "automation" },
  // Missions, data, brain, skills
  { mcp: "polpo_mission_wait", name: "mission_wait", group: "mission-editing" },
  { mcp: "polpo_data_activity", name: "data_activity", group: "data" },
  { mcp: "polpo_brain_delete", name: "brain_delete", group: "brain" },
  { mcp: "polpo_skill_update", name: "skill_update", group: "skills" },
];

/** MCP tools Polpo already covers with a tool of its own (or a parameter of one). */
export const MCP_EQUIVALENTS: Record<string, string> = {
  polpo_agent_chat: "ask_agent",
  polpo_agents_list: "list_agents",
  polpo_agent_show: "agent_get",
  // an agent's proposed intention: confirm (or cancel_check)
  agent_intention_decide: "confirm_check",
  polpo_approvals_list: "list_approvals",
  polpo_approval_resolve: "approve_request",
  polpo_tasks_list: "list_tasks",
  polpo_task_get: "get_task",
  polpo_task_create: "create_task",
  polpo_task_update: "update_task",
  polpo_task_retry: "retry_task",
  polpo_task_kill: "kill_task",
  polpo_task_delete: "delete_task",
  polpo_task_direct: "send_task_direction",
  polpo_task_wait: "wait_for_task",
  polpo_task_logs: "get_logs",
  polpo_missions_list: "list_missions",
  polpo_mission_get: "get_mission",
  polpo_mission_create: "create_mission",
  polpo_mission_update: "update_mission",
  polpo_mission_run: "execute_mission",
  polpo_mission_abort: "abort_mission",
  polpo_mission_delete: "delete_mission",
  polpo_playbooks_list: "list_playbooks",
  polpo_playbook_run: "run_playbook",
  polpo_artifacts_list: "artifact_list",
  polpo_artifact_get: "artifact_get",
  polpo_artifact_create: "artifact_create",
  polpo_files_list: "list_directory",
  polpo_files_search: "grep_files",
  polpo_file_read: "read_file",
  polpo_file_write: "write_file",
  // move, copy, delete: Polpo has the shell
  polpo_file_manage: "run_command",
  polpo_data_sources_list: "data_list_sources",
  polpo_data_query: "data_query",
  polpo_data_source_get: "data_describe",
  polpo_data_source_save: "data_register_source",
  polpo_data_source_test: "data_test_source",
  polpo_data_source_delete: "data_delete_source",
  polpo_data_sql: "data_sql",
  polpo_data_mutate: "data_mutate",
  polpo_data_views_list: "data_list_views",
  polpo_data_view_get: "data_get_view",
  polpo_data_view_save: "data_create_view",
  polpo_data_view_delete: "data_delete_view",
  // engine, computers, defaultComputer, connectorTools, browserEgress, progressiveTools: add_agent / update_agent
  polpo_agent_create: "add_agent",
  polpo_agent_update: "update_agent",
  polpo_agent_delete: "remove_agent",
  polpo_teams_list: "list_teams",
  polpo_team_save: "add_team",
  polpo_team_delete: "remove_team",
  polpo_config_get: "get_config",
  polpo_models_list: "list_models",
  polpo_memory_get: "get_memory",
  polpo_memory_update: "save_memory",
  polpo_brain_search: "brain_search",
  polpo_brain_get: "brain_get_entity",
  polpo_brain_save: "brain_upsert_entity",
  polpo_learning_get: "get_agent_learning",
  polpo_learning_review: "review_agent_learning",
  polpo_learning_revert: "revert_agent_learning",
  polpo_skills_list: "list_agent_skills",
  polpo_skill_get: "get_skill",
  polpo_skill_create: "create_agent_skill",
  polpo_skill_install: "install_agent_skill",
  polpo_skill_delete: "remove_agent_skill",
  // update_agent skills
  polpo_skill_assign: "update_agent",
  polpo_schedules_list: "list_schedules",
  polpo_schedule_create: "create_schedule",
  polpo_schedule_update: "update_schedule",
  polpo_schedule_delete: "delete_schedule",
  polpo_checks_list: "list_checks",
  polpo_check_create: "schedule_check",
  polpo_check_cancel: "cancel_check",
  polpo_watchers_list: "list_watchers",
  polpo_watcher_create: "watch_task",
  polpo_watcher_delete: "remove_watcher",
  polpo_connectors_list: "connectors_list",
  polpo_connector_connect: "connector_connect",
  polpo_connector_remove: "connector_remove",
  polpo_message_send: "send_notification",
  polpo_notification_rule_save: "add_notification_rule",
  polpo_notification_rule_delete: "remove_notification_rule",
  polpo_vault_list: "list_vault",
  polpo_vault_delete: "remove_vault_entry",
  polpo_computers_list: "computers_list",
  polpo_egress_status: "egress_status",
  polpo_apps_list: "list_apps",
  polpo_app_control: "control_app",
  polpo_browser_profiles_list: "browser_profiles",
  polpo_browser_profile_clear: "browser_profile_clear",
};

/** MCP tools with no Polpo counterpart, and why none is needed. */
export const MCP_EXCEPTIONS: Record<string, string> = {
  polpo_ask: "asks Polpo itself: in chat the person is already talking to Polpo",
  polpo_answer: "answers Polpo's own questions and previews: in chat the person answers directly",
  polpo_api_search: "the read-only REST fallback for MCP clients without a specific tool; Polpo has a specific tool for every area",
  polpo_api_get: "the read-only REST fallback for MCP clients without a specific tool; Polpo has a specific tool for every area",
  agent_card_refresh: "refreshes the agent card widget (an MCP App) in the client; Polpo reads the same with agent_get and get_agent_drive",
};

const BRIDGED_BY_NAME = new Map(BRIDGED_TOOLS.map((t) => [t.name, t]));
export const BRIDGED_TOOL_NAMES: ReadonlySet<string> = new Set(BRIDGED_BY_NAME.keys());

/** MCP name → the Polpo tool that does it (bridged or equivalent), for rewriting tool names in texts. */
const POLPO_NAME_OF: Record<string, string> = {
  ...MCP_EQUIVALENTS,
  ...Object.fromEntries(BRIDGED_TOOLS.map((t) => [t.mcp, t.name])),
};

/** Tool names in an MCP text, as Polpo knows them: polpo_agent_update → update_agent. */
export function polpoToolNames(text: string): string {
  return text.replace(/\bpolpo_[a-z_]+[a-z]\b/g, (m) => POLPO_NAME_OF[m] ?? m);
}

// ── The in-process API ───────────────────────────────────────────────

type ApiCall = McpDeps["api"];
let api: ApiCall | undefined;

/** Set by the server (src/server/app.ts): the instance's REST API called in process, as the MCP tools call it. */
export function setPolpoApi(call: ApiCall | undefined): void {
  api = call;
}

const unavailable = async (): Promise<ApiResponse> => ({
  status: 503,
  body: { ok: false, error: "this tool needs Polpo's server (polpo serve): it is not running in this process" },
  headers: new Headers(),
});

/** The deps the bridged tools get: the API, the dashboard's address for setup links, Polpo as the actor. */
const deps: McpDeps = {
  api: (method, path, body, headers) => (api ?? unavailable)(method, path, body, headers),
  version: "polpo",
  principal: { kind: "open", actor: "polpo", scopes: ["polpo:admin"] },
  get publicUrl() { return knownPublicOrigin(); },
  get dashboardUrl() { return process.env.POLPO_DASHBOARD_URL?.trim() || process.env.POLPO_UI_PUBLIC_URL?.trim() || undefined; },
};

// ── Capturing the MCP tools ──────────────────────────────────────────

interface Captured {
  spec: ToolSpec<z.ZodRawShape>;
  handler: (args: Record<string, unknown>, extra: ToolExtra) => Promise<CallToolResult>;
}

let captured: Map<string, Captured> | undefined;

function capture(): Map<string, Captured> {
  if (captured) return captured;
  const out = new Map<string, Captured>();
  const wanted = new Set(BRIDGED_TOOLS.map((t) => t.mcp));
  const tool: Register = (_toolset, name, spec, handler) => {
    if (wanted.has(name)) out.set(name, { spec: spec as unknown as ToolSpec<z.ZodRawShape>, handler: handler as unknown as Captured["handler"] });
  };
  for (const register of [
    registerSetupTools, registerTeamTools, registerConnectorTools, registerHarnessTools, registerComputerTools, registerConfigTools,
    registerSettingsTools, registerChannelTools, registerChannelSetupTools, registerRoomTools, registerChatTools, registerAutomationTools,
    registerMissionTools, registerDataTools, registerBrainTools, registerSkillTools,
  ]) register(tool, deps);
  captured = out;
  return out;
}

/** A JSON Schema of a tool's input, as models get it. */
function jsonSchemaOf(shape: z.ZodRawShape): Record<string, unknown> {
  const schema = z.toJSONSchema(z.object(shape), { io: "input", unrepresentable: "any" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

let tools: Tool[] | undefined;

/** The bridged tools as Polpo's tools (names and texts in Polpo's words). */
export function bridgedTools(): Tool[] {
  if (tools) return tools;
  const all = capture();
  tools = BRIDGED_TOOLS.map((b) => {
    const c = all.get(b.mcp);
    if (!c) throw new Error(`MCP tool ${b.mcp} is not registered (src/server/mcp-server)`);
    return {
      name: b.name,
      description: polpoToolNames(c.spec.description),
      parameters: jsonSchemaOf(c.spec.inputSchema) as Tool["parameters"],
    };
  });
  return tools;
}

/** Bridged tools that only read. */
export function bridgedReadOnly(name: string): boolean {
  const b = BRIDGED_BY_NAME.get(name);
  return !!b && !!capture().get(b.mcp)?.spec.annotations.readOnlyHint;
}

export function isBridgedTool(name: string): boolean {
  return BRIDGED_TOOL_NAMES.has(name);
}

export interface BridgeContext {
  signal?: AbortSignal;
  onProgress?: (progress: { message: string }) => void | Promise<void>;
}

/** The text of an MCP result for Polpo: "Error: …" when it failed; tool names as Polpo knows them. */
export function resultText(result: CallToolResult): string {
  const text = (result.content ?? [])
    .map((c) => (c.type === "text" ? c.text : c.type === "resource_link" ? `${c.name}: ${c.uri}` : ""))
    .filter(Boolean)
    .join("\n");
  const out = polpoToolNames(text || (result.structuredContent ? JSON.stringify(result.structuredContent) : "Done."));
  return result.isError ? `Error: ${out}` : out;
}

/** Run a bridged tool: its input checked as the MCP server checks it, then its handler, in process. */
export async function executeBridgedTool(name: string, args: Record<string, unknown>, context: BridgeContext = {}): Promise<string> {
  const b = BRIDGED_BY_NAME.get(name);
  const c = b ? capture().get(b.mcp) : undefined;
  if (!b || !c) return `Unknown tool: ${name}`;
  const parsed = await z.object(c.spec.inputSchema).safeParseAsync(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    return `Error: invalid arguments for ${name}: ${issues}`;
  }
  const extra = {
    signal: context.signal ?? new AbortController().signal,
    _meta: { progressToken: `polpo-${name}` },
    requestId: `polpo-${name}`,
    sendNotification: async (n: { method: string; params?: { message?: string } }) => {
      if (n.method === "notifications/progress" && n.params?.message) await context.onProgress?.({ message: polpoToolNames(n.params.message) });
    },
    sendRequest: async () => { throw new Error("not available in Polpo's chat"); },
  } as unknown as ToolExtra;
  try {
    return resultText(await c.handler(parsed.data as Record<string, unknown>, extra));
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

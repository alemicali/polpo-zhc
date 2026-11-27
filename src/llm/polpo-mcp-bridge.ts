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
import { registerWaBusinessTools } from "../server/mcp-server/whatsapp-business.js";
import { registerConnectorTools } from "../server/mcp-server/connectors.js";
import { registerMcpServerTools } from "../server/mcp-server/mcp-servers.js";
import { registerChannelTools } from "../server/mcp-server/channels.js";
import { registerChannelSetupTools } from "../server/mcp-server/channel-setup.js";
import { registerSettingsTools } from "../server/mcp-server/settings.js";
import { registerConfigTools } from "../server/mcp-server/config.js";
import { registerRoomTools } from "../server/mcp-server/rooms.js";
import { registerChatTools } from "../server/mcp-server/chat.js";
import { registerAutomationTools } from "../server/mcp-server/automation.js";
import { registerTriggerTools } from "../server/mcp-server/triggers.js";
import { registerDecisionTools } from "../server/mcp-server/decisions.js";
import { registerMediaTools } from "../server/mcp-server/media.js";
import { registerCodingTools } from "../server/mcp-server/coding.js";
import { registerMissionTools } from "../server/mcp-server/missions.js";
import { registerDataTools } from "../server/mcp-server/data.js";
import { registerBrainTools } from "../server/mcp-server/knowledge.js";
import { registerSearchTools } from "../server/mcp-server/search.js";
import { registerSkillTools } from "../server/mcp-server/skills.js";
import { registerTeamTools } from "../server/mcp-server/team.js";
import { registerAgentSuiteTools } from "../server/mcp-server/agent-suites.js";
import { registerBenchmarkTools } from "../server/mcp-server/benchmarks.js";
import { registerArtifactTools } from "../server/mcp-server/core-tools.js";
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
  { mcp: "polpo_agent_lines", name: "agent_lines", group: "learning" },
  // Connectors: adding one never takes a secret in chat (token / OAuth app → setup link)
  { mcp: "polpo_connector_add", name: "connector_add" },
  { mcp: "polpo_connector_catalog", name: "connector_catalog", group: "connectors" },
  { mcp: "polpo_connector_update", name: "connector_update", group: "connectors" },
  { mcp: "polpo_connector_test", name: "connector_test", group: "connectors" },
  { mcp: "polpo_connector_disconnect", name: "connector_disconnect", group: "connectors" },
  // Hosted MCP servers: Polpo builds and serves its own ("create a connector for Printful")
  { mcp: "polpo_mcp_servers_list", name: "mcp_servers_list", group: "hosted-servers" },
  { mcp: "polpo_mcp_server_get", name: "mcp_server_get", group: "hosted-servers" },
  { mcp: "polpo_mcp_server_create", name: "mcp_server_create", group: "hosted-servers" },
  { mcp: "polpo_mcp_server_templates", name: "mcp_server_templates", group: "hosted-servers" },
  { mcp: "polpo_mcp_server_install", name: "mcp_server_install", group: "hosted-servers" },
  { mcp: "polpo_mcp_server_generate", name: "mcp_server_generate", group: "hosted-servers" },
  { mcp: "polpo_mcp_server_update", name: "mcp_server_update", group: "hosted-servers" },
  { mcp: "polpo_mcp_server_test", name: "mcp_server_test", group: "hosted-servers" },
  { mcp: "polpo_mcp_server_publish", name: "mcp_server_publish", group: "hosted-servers" },
  { mcp: "polpo_mcp_server_deploy", name: "mcp_server_deploy", group: "hosted-servers" },
  { mcp: "polpo_mcp_server_logs", name: "mcp_server_logs", group: "hosted-servers" },
  { mcp: "polpo_mcp_server_delete", name: "mcp_server_delete", group: "hosted-servers" },
  // Agent harnesses (Claude Code, Codex, OpenCode)
  { mcp: "polpo_harnesses_get", name: "harnesses_get", group: "harnesses" },
  { mcp: "polpo_harnesses_update", name: "harnesses_update", group: "harnesses" },
  { mcp: "polpo_harness_sessions_list", name: "harness_sessions_list", group: "harnesses" },
  { mcp: "polpo_harness_session_control", name: "harness_session_control", group: "harnesses" },
  // Computers
  { mcp: "polpo_computer_get", name: "computer_get", group: "computers" },
  { mcp: "polpo_computer_webhooks", name: "computer_webhooks", group: "computers" },
  { mcp: "polpo_computer_save", name: "computer_save", group: "computers" },
  { mcp: "polpo_computer_control", name: "computer_control", group: "computers" },
  { mcp: "polpo_computer_delete", name: "computer_delete", group: "computers" },
  { mcp: "polpo_computer_desktop", name: "computer_desktop", group: "computers" },
  { mcp: "polpo_computer_takeover", name: "computer_takeover", group: "computers" },
  { mcp: "polpo_computer_release", name: "computer_release", group: "computers" },
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
  { mcp: "polpo_channel_access_set", name: "channel_access_set", group: "channels" },
  { mcp: "polpo_peer_presence", name: "channel_peer_presence", group: "channels" },
  { mcp: "polpo_peer_link", name: "channel_peer_link", group: "channels" },
  { mcp: "polpo_slack_status", name: "channel_slack_status", group: "channels" },
  { mcp: "polpo_notifications_list", name: "channel_notifications_list", group: "channels" },
  { mcp: "polpo_notifications_stats", name: "channel_notifications_stats", group: "channels" },
  { mcp: "polpo_whatsapp_login", name: "channel_whatsapp_login", group: "channels" },
  { mcp: "polpo_whatsapp_login_wait", name: "channel_whatsapp_login_wait", group: "channels" },
  { mcp: "polpo_whatsapp_logout", name: "channel_whatsapp_logout", group: "channels" },
  // WhatsApp Business (Meta Cloud API): status, events, templates, conversations, sends, approvals
  { mcp: "polpo_wabiz_status", name: "wabiz_status", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_events", name: "wabiz_events", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_templates", name: "wabiz_templates", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_conversation", name: "wabiz_conversation", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_send", name: "wabiz_send", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_send_template", name: "wabiz_send_template", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_approval", name: "wabiz_approval", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_contact", name: "wabiz_contact", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_contact_erase", name: "wabiz_contact_erase", group: "whatsapp-business" },
  // media, interactive messages, flows, catalog, orders and payments, reactions, templates, profile, blocks, analytics, the number
  { mcp: "polpo_wabiz_send_media", name: "wabiz_send_media", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_send_interactive", name: "wabiz_send_interactive", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_send_flow", name: "wabiz_send_flow", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_send_products", name: "wabiz_send_products", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_send_order", name: "wabiz_send_order", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_react", name: "wabiz_react", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_template_manage", name: "wabiz_template_manage", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_profile", name: "wabiz_profile", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_block", name: "wabiz_block", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_analytics", name: "wabiz_analytics", group: "whatsapp-business" },
  { mcp: "polpo_wabiz_phone", name: "wabiz_phone", group: "whatsapp-business" },
  // Rooms (group chats of people and agents)
  { mcp: "polpo_rooms_list", name: "rooms_list", group: "rooms" },
  { mcp: "polpo_room_create", name: "room_create", group: "rooms" },
  { mcp: "polpo_room_update", name: "room_update", group: "rooms" },
  { mcp: "polpo_room_delete", name: "room_delete", group: "rooms" },
  { mcp: "polpo_room_messages", name: "room_messages", group: "rooms" },
  { mcp: "polpo_room_post", name: "room_post", group: "rooms" },
  { mcp: "polpo_room_wait", name: "room_wait", group: "rooms" },
  // Global search (chats' messages, tasks, agents, files… everything, as ⌘K)
  { mcp: "polpo_search", name: "search", group: "chats" },
  // Chat sessions
  { mcp: "polpo_chat_sessions_list", name: "chat_sessions_list", group: "chats" },
  { mcp: "polpo_chat_messages", name: "chat_messages", group: "chats" },
  { mcp: "polpo_chat_session_update", name: "chat_session_update", group: "chats" },
  { mcp: "polpo_chat_session_delete", name: "chat_session_delete", group: "chats" },
  // Automation
  { mcp: "polpo_schedule_run", name: "schedule_run", group: "automation" },
  { mcp: "polpo_check_update", name: "check_update", group: "automation" },
  { mcp: "polpo_check_delete", name: "check_delete", group: "automation" },
  // Triggers: public endpoints (POST /hooks/{id}) for forms and webhooks — definitions with their actions, deliveries and action runs, re-runs, test tools, secrets
  { mcp: "polpo_triggers_list", name: "triggers_list", group: "triggers" },
  { mcp: "polpo_trigger_get", name: "trigger_get", group: "triggers" },
  { mcp: "polpo_trigger_deliveries", name: "trigger_deliveries", group: "triggers" },
  { mcp: "polpo_trigger_create", name: "trigger_create", group: "triggers" },
  { mcp: "polpo_trigger_update", name: "trigger_update", group: "triggers" },
  { mcp: "polpo_trigger_delete", name: "trigger_delete", group: "triggers" },
  { mcp: "polpo_trigger_test", name: "trigger_test", group: "triggers" },
  { mcp: "polpo_trigger_run_actions", name: "trigger_run_actions", group: "triggers" },
  { mcp: "polpo_trigger_auth", name: "trigger_auth", group: "triggers" },
  // Decisions: typed judgments with probabilities from the decision model (decide), the log, mission nodes waiting for a person
  { mcp: "polpo_decide", name: "decide", group: "decisions" },
  { mcp: "polpo_decisions", name: "decisions", group: "decisions" },
  { mcp: "polpo_decision_resolve", name: "decision_resolve", group: "decisions" },
  // Media: image generation and editing (the media primitive), the media log, the status
  { mcp: "polpo_image_generate", name: "image_generate", group: "media" },
  { mcp: "polpo_image_edit", name: "image_edit", group: "media" },
  { mcp: "polpo_media_log", name: "media_log", group: "media" },
  { mcp: "polpo_media_status", name: "media_status", group: "media" },
  // Coding chats: Claude Code / Codex sessions in a worktree on the person's own CLI account
  { mcp: "polpo_coding_chats_list", name: "coding_chats_list", group: "coding" },
  { mcp: "polpo_coding_chat_get", name: "coding_chat_get", group: "coding" },
  { mcp: "polpo_coding_chat_start", name: "coding_chat_start", group: "coding" },
  { mcp: "polpo_coding_chat_send", name: "coding_chat_send", group: "coding" },
  { mcp: "polpo_coding_chat_control", name: "coding_chat_control", group: "coding" },
  // Missions, data, brain, skills
  { mcp: "polpo_mission_wait", name: "mission_wait", group: "mission-editing" },
  { mcp: "polpo_data_activity", name: "data_activity", group: "data" },
  { mcp: "polpo_brain_delete", name: "brain_delete", group: "brain" },
  { mcp: "polpo_skill_update", name: "skill_update", group: "skills" },
  // Skill bundles (.skill / .zip: from a chat attachment or any file of the instance, a URL, base64) and a skill's files
  { mcp: "polpo_skill_upload_prepare", name: "skill_upload_prepare", group: "skills" },
  { mcp: "polpo_skill_upload_finalize", name: "skill_upload_finalize", group: "skills" },
  { mcp: "polpo_skill_files", name: "skill_files", group: "skills" },
  { mcp: "polpo_skill_file_read", name: "skill_file_read", group: "skills" },
  // Skill versions: history, diff, restore
  { mcp: "polpo_skill_versions", name: "skill_versions", group: "skills" },
  { mcp: "polpo_skill_version_diff", name: "skill_version_diff", group: "skills" },
  { mcp: "polpo_skill_restore", name: "skill_restore", group: "skills" },
  // Agent versions: draft → publish → deploy (production), rollback, history
  { mcp: "polpo_agent_versions", name: "agent_versions", group: "agent-versions" },
  { mcp: "polpo_agent_version_get", name: "agent_version_get", group: "agent-versions" },
  { mcp: "polpo_agent_version_diff", name: "agent_version_diff", group: "agent-versions" },
  { mcp: "polpo_agent_draft", name: "agent_draft", group: "agent-versions" },
  { mcp: "polpo_agent_publish", name: "agent_publish", group: "agent-versions" },
  { mcp: "polpo_agent_deploy", name: "agent_deploy", group: "agent-versions" },
  { mcp: "polpo_agent_rollback", name: "agent_rollback", group: "agent-versions" },
  { mcp: "polpo_agent_deploys", name: "agent_deploys", group: "agent-versions" },
  // deploy gates: the required suites verifying a deploy (in verifica, passed, blocked, override)
  { mcp: "polpo_agent_deploy_gates", name: "agent_deploy_gates", group: "agent-versions" },
  // Agent tests: check everything an agent has at its disposal, apply the one-click fixes
  { mcp: "polpo_agent_test", name: "agent_test", group: "agent-versions" },
  // Agent suites: tests and evals with mocks, run against a version, read the reports
  { mcp: "polpo_agent_suite_list", name: "agent_suite_list", group: "agent-versions" },
  { mcp: "polpo_agent_suite_get", name: "agent_suite_get", group: "agent-versions" },
  { mcp: "polpo_agent_suite_save", name: "agent_suite_save", group: "agent-versions" },
  { mcp: "polpo_agent_suite_delete", name: "agent_suite_delete", group: "agent-versions" },
  { mcp: "polpo_agent_suite_run", name: "agent_suite_run", group: "agent-versions" },
  { mcp: "polpo_agent_suite_run_get", name: "agent_suite_run_get", group: "agent-versions" },
  // evals: trends, baselines, "explain this run"
  { mcp: "polpo_agent_suite_trend", name: "agent_suite_trend", group: "agent-versions" },
  { mcp: "polpo_agent_suite_baseline", name: "agent_suite_baseline", group: "agent-versions" },
  { mcp: "polpo_agent_suite_review", name: "agent_suite_review", group: "agent-versions" },
  // phase 4: cassettes (record / replay), AI case generation, suites of hosted servers and missions
  { mcp: "polpo_agent_suite_record", name: "agent_suite_record", group: "agent-versions" },
  { mcp: "polpo_agent_suite_replay", name: "agent_suite_replay", group: "agent-versions" },
  { mcp: "polpo_agent_suite_cassette", name: "agent_suite_cassette", group: "agent-versions" },
  { mcp: "polpo_agent_suite_cassette_edit", name: "agent_suite_cassette_edit", group: "agent-versions" },
  { mcp: "polpo_agent_suite_generate", name: "agent_suite_generate", group: "agent-versions" },
  { mcp: "polpo_target_suites", name: "target_suites", group: "agent-versions" },
  { mcp: "polpo_target_suite_save", name: "target_suite_save", group: "agent-versions" },
  { mcp: "polpo_target_suite_run", name: "target_suite_run", group: "agent-versions" },
  // phase 5: benchmarks (suites × variants × repetitions: leaderboard, matrix, side by side) and the Playground
  { mcp: "polpo_benchmark_save", name: "benchmark_save", group: "agent-versions" },
  { mcp: "polpo_benchmark_delete", name: "benchmark_delete", group: "agent-versions" },
  { mcp: "polpo_benchmark_run", name: "benchmark_run", group: "agent-versions" },
  { mcp: "polpo_benchmark_get", name: "benchmark_get", group: "agent-versions" },
  { mcp: "polpo_benchmark_leaderboard", name: "benchmark_leaderboard", group: "agent-versions" },
  { mcp: "polpo_benchmark_compare", name: "benchmark_compare", group: "agent-versions" },
  { mcp: "polpo_playground_send", name: "playground_send", group: "agent-versions" },
  { mcp: "polpo_playground_promote", name: "playground_promote", group: "agent-versions" },
  // Large artifact contents: upload from a public URL, a file of the instance or base64 parts, then create or replace
  { mcp: "polpo_artifact_upload_prepare", name: "artifact_upload_prepare", group: "artifact-uploads" },
  { mcp: "polpo_artifact_upload_finalize", name: "artifact_upload_finalize", group: "artifact-uploads" },
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
  // the task card (an MCP App): get_task has the same (failure, dependencies, runs)
  polpo_task_show: "get_task",
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
  // the mission card (an MCP App): get_mission has the same (cost against the budget, tasks)
  polpo_mission_show: "get_mission",
  // the agent suite card (an MCP App): agent_suite_list, agent_suite_run_get and agent_suite_trend have the same
  polpo_agent_suite_show: "agent_suite_run_get",
  // the benchmark card (an MCP App): benchmark_get and benchmark_compare have the same (leaderboard, matrix, side by side)
  polpo_benchmark_show: "benchmark_get",
  // the trigger card (an MCP App): trigger_get and trigger_deliveries have the same
  polpo_trigger_show: "trigger_get",
  // the decision card (an MCP App): decide and decisions answer with the same (answers, probabilities)
  polpo_decision_show: "decisions",
  // the media card (an MCP App): image_generate and media_log answer with the same (the images, their provenance)
  polpo_image_show: "media_log",
  // the coding chat card (an MCP App): coding_chat_get has the same transcript as text
  polpo_coding_chat_show: "coding_chat_get",
  // the WhatsApp Business card (an MCP App): wabiz_status, wabiz_conversation and wabiz_approval have the same
  polpo_wabiz_show: "wabiz_conversation",
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
  polpo_artifact_update: "artifact_update",
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
  polpo_data_transaction: "data_transaction",
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
  polpo_computer_show: "computer_get",
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
  polpo_search_ask: "asks Polpo's model to search and pick results, as Enter in ⌘K: in chat Polpo is already that model and has the search tool itself",
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
    registerSetupTools, registerTeamTools, registerAgentSuiteTools, registerBenchmarkTools, registerConnectorTools, registerMcpServerTools, registerHarnessTools, registerComputerTools, registerConfigTools,
    registerSettingsTools, registerChannelTools, registerChannelSetupTools, registerRoomTools, registerChatTools, registerAutomationTools, registerTriggerTools, registerDecisionTools, registerMediaTools,
    registerMissionTools, registerDataTools, registerBrainTools, registerSkillTools, registerWaBusinessTools, registerSearchTools, registerCodingTools,
    registerArtifactTools,
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

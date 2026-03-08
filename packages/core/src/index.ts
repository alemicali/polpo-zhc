// ── Types ────────────────────────────────────────────────────────────────
export * from "./types.js";

// ── Events (pure type definitions only, TypedEmitter lives in shell) ─────
export * from "./events.js";

// ── State Machine ────────────────────────────────────────────────────────
export { VALID_TRANSITIONS, isValidTransition, assertValidTransition } from "./state-machine.js";

// ── Schemas (Zod validation) ─────────────────────────────────────────────
export * from "./schemas.js";

// ── Hooks ────────────────────────────────────────────────────────────────
export { HookRegistry } from "./hooks.js";
export type {
  LifecycleHook,
  HookPhase,
  HookContext,
  HookHandler,
  HookRegistration,
  HookPayloads,
  BeforeHookResult,
} from "./hooks.js";

// ── Store Interfaces ─────────────────────────────────────────────────────
export type { TaskStore } from "./task-store.js";
export type { RunStore, RunRecord, RunStatus } from "./run-store.js";
export type { ConfigStore } from "./config-store.js";
export type { MemoryStore } from "./memory-store.js";
export type { LogStore, LogEntry, SessionInfo } from "./log-store.js";
export type { SessionStore, Session, Message, MessageRole, ToolCallInfo, ToolCallState } from "./session-store.js";
export type { ApprovalStore } from "./approval-store.js";
export type { NotificationStore, NotificationRecord, NotificationStatus } from "./notification-store.js";
export type { PeerStore } from "./peer-store.js";

// ── Adapter Types ────────────────────────────────────────────────────────
export type { AgentHandle, SpawnContext } from "./adapter.js";

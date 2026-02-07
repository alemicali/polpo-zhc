// Backward-compat re-export — interfaces now in core/adapter.ts, registry in adapters/registry.ts
export type { AgentAdapter, AgentHandle } from "./core/adapter.js";
export { registerAdapter, getAdapter, createActivity } from "./adapters/registry.js";

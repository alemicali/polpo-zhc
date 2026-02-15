import type { AgentAdapter } from "../core/adapter.js";
import type { AgentActivity } from "../core/types.js";

// === Adapter Registry ===

type AdapterFactory = () => AgentAdapter;

const registry = new Map<string, AdapterFactory>();

export function registerAdapter(name: string, factory: AdapterFactory): void {
  registry.set(name, factory);
}

export function getAdapter(name: string): AgentAdapter {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(
      `Unknown adapter: "${name}". Available: ${[...registry.keys()].join(", ") || "none"}`
    );
  }
  return factory();
}

/** Create a fresh AgentActivity object */
export function createActivity(): AgentActivity {
  return {
    filesCreated: [],
    filesEdited: [],
    toolCalls: 0,
    totalTokens: 0,
    lastUpdate: new Date().toISOString(),
  };
}

import { useSyncExternalStore } from "react";
import { config } from "@/lib/config";

/**
 * The orchestrator's display name (settings.orchestratorName; "Polpo" when unset), known from the
 * first render: the UI server inlines it into runtime-config.js, else the copy cached in this
 * browser. The public API route and the config (on load and on every reload) refresh it.
 * It never comes from the branding: the product name and the orchestrator's name are separate.
 */

export const DEFAULT_ORCHESTRATOR_NAME = "Polpo";
export const ORCHESTRATOR_NAME_MAX_LENGTH = 40;
const CHANGE_EVENT = "polpo:orchestrator-name-change";

function cacheKey(): string {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return `polpo-orchestrator-name:${config.baseUrl || origin}`;
}

/** A valid name (trimmed, 1–40 characters, one line), or undefined. */
export function normalizeOrchestratorName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  if (!name || name.length > ORCHESTRATOR_NAME_MAX_LENGTH || /[\r\n]/.test(name)) return undefined;
  return name;
}

function initial(): string {
  const inlined = normalizeOrchestratorName(globalThis.__POLPO_RUNTIME_CONFIG__?.orchestratorName);
  if (inlined) return inlined;
  try {
    const cached = normalizeOrchestratorName(localStorage.getItem(cacheKey()));
    if (cached) return cached;
  } catch { /* storage may be unavailable */ }
  return DEFAULT_ORCHESTRATOR_NAME;
}

let current: string = typeof window !== "undefined" ? initial() : DEFAULT_ORCHESTRATOR_NAME;

/** The orchestrator's name as known now. */
export function getOrchestratorName(): string {
  return current;
}

/** A new name (from the API or the config, or just saved by an admin): cached and announced. */
export function setOrchestratorName(value: unknown): void {
  const next = normalizeOrchestratorName(value) ?? DEFAULT_ORCHESTRATOR_NAME;
  try { localStorage.setItem(cacheKey(), next); } catch { /* storage may be unavailable */ }
  if (next === current) return;
  current = next;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Ask the public route (no sign-in needed); an older server or offline keeps what we have. */
export async function loadOrchestratorName(): Promise<void> {
  try {
    const res = await fetch(`${config.baseUrl}/api/v1/config/orchestrator`);
    if (!res.ok) return;
    const body = await res.json() as { ok?: boolean; data?: { name?: unknown } };
    if (body?.ok && body.data) setOrchestratorName(body.data.name);
  } catch { /* keep what we have */ }
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}

/** The orchestrator's name, right from the first render; re-renders when it changes. */
export function useOrchestratorName(): string {
  return useSyncExternalStore(subscribe, getOrchestratorName, getOrchestratorName);
}

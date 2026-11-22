/**
 * Build-time OpenAPI generation (`pnpm run generate:openapi`).
 *
 * The spec is assembled by the route definitions inside `createApp`, which
 * expects a live orchestrator. Generating it must not need one, so this module
 * hands `createApp` a stand-in that is never initialized and answers every
 * call with nothing. Production code keeps requiring a real orchestrator.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../core/orchestrator.js";
import type { SSEBridge } from "./sse-bridge.js";
import type { createApp as CreateApp } from "./app.js";

/** An object whose every property is a no-op function (returning undefined), except the ones given. */
function inert<T>(fixed: Record<string, unknown> = {}): T {
  return new Proxy(fixed, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      // Not a thenable: `await stub` must not hang.
      if (prop === "then") return undefined;
      return () => undefined;
    },
  }) as T;
}

/** An orchestrator for spec generation only: not initialized, does nothing. */
export function createSpecOrchestrator(): Orchestrator {
  return inert<Orchestrator>({ isInitialized: false });
}

export interface OpenApiSpec {
  openapi: string;
  info: Record<string, unknown>;
  paths: Record<string, Record<string, unknown>>;
  components?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Generate the REST API's OpenAPI document without a running instance.
 * `createApp` is passed in so tests can use the TypeScript sources and the
 * npm script the compiled build.
 */
export async function generateOpenApiSpec(createApp: typeof CreateApp): Promise<OpenApiSpec> {
  // Anything the app writes while being built (it is not initialized, so very little) lands here.
  const workDir = mkdtempSync(join(tmpdir(), "polpo-openapi-"));
  try {
    const app = createApp(createSpecOrchestrator(), inert<SSEBridge>(), { workDir });
    const res = await app.fetch(new Request("http://localhost/api/v1/openapi.json"));
    if (!res.ok) throw new Error(`OpenAPI endpoint answered ${res.status}: ${await res.text()}`);
    return await res.json() as OpenApiSpec;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app.js";
import { createSpecOrchestrator, generateOpenApiSpec } from "../server/openapi-spec.js";

// `pnpm run generate:openapi` builds docs/openapi.json without a running instance.
describe("OpenAPI generation", () => {
  it("builds the spec without a live orchestrator", async () => {
    const spec = await generateOpenApiSpec(createApp);
    expect(spec.openapi).toBe("3.1.0");
    for (const path of ["/api/v1/tasks", "/api/v1/agents", "/api/v1/missions", "/api/v1/config/status", "/api/v1/providers"]) {
      expect(spec.paths[path], path).toBeDefined();
    }
    expect(Object.keys(spec.paths).length).toBeGreaterThan(100);
    expect((spec.components as { securitySchemes?: Record<string, unknown> })?.securitySchemes?.bearerAuth).toBeDefined();
  }, 60_000);

  it("the committed docs/openapi.json lists every generated path", async () => {
    const spec = await generateOpenApiSpec(createApp);
    const committed = JSON.parse(readFileSync(join(__dirname, "..", "..", "docs", "openapi.json"), "utf8"));
    const missing = Object.keys(spec.paths).filter((p) => !(p in committed.paths));
    expect(missing, "run `pnpm run generate:openapi`").toEqual([]);
  }, 60_000);

  it("the stand-in orchestrator is never initialized and answers calls with nothing", async () => {
    const o = createSpecOrchestrator() as unknown as Record<string, unknown> & { getConfig(): unknown };
    expect(o.isInitialized).toBe(false);
    expect(o.getConfig()).toBeUndefined();
    // Not a thenable, so awaiting it does not hang.
    expect(await Promise.resolve(o)).toBe(o);
  });
});

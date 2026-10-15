import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerRunnerProviders } from "../core/runner-providers.js";
import { resolveModel, setProviderOverrides } from "../llm/pi-client.js";

describe("registerRunnerProviders", () => {
  let polpoDir: string;

  beforeEach(() => {
    polpoDir = mkdtempSync(join(tmpdir(), "polpo-runner-providers-"));
    setProviderOverrides(undefined);
  });

  afterEach(() => {
    setProviderOverrides(undefined);
    rmSync(polpoDir, { recursive: true, force: true });
  });

  it("registers the custom providers of polpo.json, so their models resolve in the runner", () => {
    writeFileSync(join(polpoDir, "polpo.json"), JSON.stringify({
      providers: {
        localsrv: { baseUrl: "http://127.0.0.1:11434/v1", api: "openai-completions", models: [{ id: "small-model", name: "Small" }] },
      },
    }));
    expect(() => resolveModel("localsrv:small-model")).toThrow();

    registerRunnerProviders(polpoDir, undefined);

    expect(resolveModel("localsrv:small-model")).toMatchObject({ id: "small-model" });
  });

  it("does nothing without polpo.json", () => {
    expect(() => registerRunnerProviders(polpoDir, undefined)).not.toThrow();
    expect(() => resolveModel("localsrv:small-model")).toThrow();
  });
});

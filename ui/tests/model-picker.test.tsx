import { afterEach, describe, expect, test, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

describe("ModelPicker without apiFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    globalThis.__POLPO_RUNTIME_CONFIG__ = undefined;
  });

  test("asks the configured server for the models, not a path relative to the page", async () => {
    // The desktop app loads the page from file:// and points it at its local server.
    globalThis.__POLPO_RUNTIME_CONFIG__ = { baseUrl: "http://localhost:3891", apiKey: "secret" };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const { ModelPicker } = await import("@/components/shared/model-picker");

    render(<ModelPicker configuredProviders={["ollama"]} providerSources={{ ollama: "custom" }} value={null} onSelect={() => {}} />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://localhost:3891/api/v1/providers/models");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
  });
});

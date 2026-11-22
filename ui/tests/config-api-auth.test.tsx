/**
 * Configuration's own calls (channel test, cloud sync, WhatsApp, logo) send the API key like every
 * other call, so they work when the dashboard authenticates with a key instead of a session.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete (globalThis as { __POLPO_RUNTIME_CONFIG__?: unknown }).__POLPO_RUNTIME_CONFIG__;
});

describe("apiFetch", () => {
  it("sends the API key and the session cookie", async () => {
    (globalThis as { __POLPO_RUNTIME_CONFIG__?: unknown }).__POLPO_RUNTIME_CONFIG__ = { baseUrl: "https://api.example.com", apiKey: "k-123" };
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await import("@/lib/config");
    await apiFetch("https://api.example.com/api/v1/config/channels/ops/test", { method: "POST" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer k-123");
    expect(init.credentials).toBe("include");
    expect(init.method).toBe("POST");
  });

  it("keeps an explicit Authorization and sends none without a key", async () => {
    (globalThis as { __POLPO_RUNTIME_CONFIG__?: unknown }).__POLPO_RUNTIME_CONFIG__ = { baseUrl: "", apiKey: "k-123" };
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    let { apiFetch } = await import("@/lib/config");
    await apiFetch("/api/v1/sync/config", { headers: { authorization: "Bearer other" } });
    expect(new Headers((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers).get("authorization")).toBe("Bearer other");

    vi.resetModules();
    (globalThis as { __POLPO_RUNTIME_CONFIG__?: unknown }).__POLPO_RUNTIME_CONFIG__ = { baseUrl: "" };
    ({ apiFetch } = await import("@/lib/config"));
    await apiFetch("/api/v1/sync/config");
    expect(new Headers((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].headers).has("authorization")).toBe(false);
  });
});

describe("Configuration page", () => {
  it("calls the API only through api() or apiFetch (the channel test and cloud sync included)", () => {
    // run from the repository root or from ui/
    const file = [join(process.cwd(), "ui/src/pages/config.tsx"), join(process.cwd(), "src/pages/config.tsx")].find((f) => existsSync(f))!;
    const source = readFileSync(file, "utf-8");
    const bare = source.split("\n").map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /(^|[^A-Za-z.])fetch\(/.test(line) && !line.includes("apiFetch("));
    // the one allowed: the api() helper, which sets Authorization itself
    expect(bare.map(([n, line]) => `${n}: ${line.trim()}`)).toEqual([expect.stringContaining("const res = await fetch(`${appConfig.baseUrl}/api/v1${path}`")]);
    expect(source).toMatch(/apiFetch\(`\$\{appConfig\.baseUrl\}\/api\/v1\/config\/channels\/\$\{encodeURIComponent\(name\)\}\/test`/);
    expect(source).toMatch(/apiFetch\(apiUrl\("\/api\/v1\/sync\/config"\)/);
  });
});

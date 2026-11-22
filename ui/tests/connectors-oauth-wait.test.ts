import { describe, it, expect, vi, afterEach } from "vitest";
import { connectorsApi, waitForOAuth, type Connector } from "@/lib/connectors-api";

const connector = (over: { pending?: boolean; authorized?: boolean; status?: string; lastError?: string }): Connector => ({
  id: "gmail",
  status: over.status ?? "needs_auth",
  ...(over.lastError ? { lastError: over.lastError } : {}),
  secrets: { oauth: { pending: over.pending ?? false, authorized: over.authorized ?? false } },
}) as unknown as Connector;

afterEach(() => vi.restoreAllMocks());

describe("waitForOAuth", () => {
  it("waits for the first connection after the tokens are stored", async () => {
    const states = [
      connector({ pending: true }),
      connector({ authorized: true, status: "connecting" }), // signed in, first connection still running
      connector({ authorized: true, status: "connecting" }),
      connector({ authorized: true, status: "connected" }),
    ];
    let i = 0;
    vi.spyOn(connectorsApi, "get").mockImplementation(async () => states[Math.min(i++, states.length - 1)]!);
    const outcome = await waitForOAuth("gmail", null, { intervalMs: 5 });
    expect(outcome.kind).toBe("connected");
  });

  it("reports the server's error when the first connection fails", async () => {
    vi.spyOn(connectorsApi, "get").mockResolvedValue(connector({ authorized: true, status: "error", lastError: "403 from Gmail MCP" }));
    const outcome = await waitForOAuth("gmail", null, { intervalMs: 5 });
    expect(outcome).toMatchObject({ kind: "authorized_with_error", error: "403 from Gmail MCP" });
  });
});

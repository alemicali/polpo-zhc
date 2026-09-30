import { expect, test, vi } from "vitest";
import { mobileDiagnosticsRoutes } from "../server/routes/mobile-diagnostics.js";

test("mobile diagnostics reject speech/free-form data and retain only bounded metadata", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    const app = mobileDiagnosticsRoutes();
    const body = { topic: "voice", event: "native-start", revision: "voice-r3", updateId: "test", runtime: "test", platform: "ios", launchId: "qa" };
    const post = (data: unknown) => app.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    expect((await post({ ...body, transcript: "must never be stored" })).status).toBe(400);
    expect((await post({ ...body, code: "free form text with spaces" })).status).toBe(400);
    expect([400, 413]).toContain((await post({ ...body, extra: "x".repeat(3000) })).status);
    for (let i = 0; i < 305; i++) expect((await post(body)).status).toBe(200);
    const response = await app.request("/");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const data = await response.json() as any;
    expect(data.data.entries).toHaveLength(300);
    expect(data.data.entries[0].sequence).toBe(6);
  } finally { log.mockRestore(); }
});

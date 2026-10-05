import { describe, it, expect, vi, afterEach } from "vitest";
import { TelegramCallbackPoller } from "../notifications/channels/telegram.js";

afterEach(() => vi.unstubAllGlobals());

describe("TelegramCallbackPoller — command menu", () => {
  it("registers the menu with setMyCommands when polling starts", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: [] })));
    vi.stubGlobal("fetch", fetchMock);
    const poller = new TelegramCallbackPoller("123:abc", "1");
    poller.setMenuCommands([{ command: "agent", description: "Talk directly to an agent" }]);

    poller.start(60_000);
    poller.stop();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:abc/setMyCommands");
    expect(JSON.parse(init.body)).toEqual({ commands: [{ command: "agent", description: "Talk directly to an agent" }] });
  });

  it("does not touch the menu of approval-only pollers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const poller = new TelegramCallbackPoller("123:abc", "1");
    poller.start(60_000);
    poller.stop();
    await new Promise(r => setTimeout(r, 10));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("setMyCommands"))).toBe(false);
  });
});

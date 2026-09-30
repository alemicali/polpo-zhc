import { describe, it, expect, vi } from "vitest";
import { peerRoutes, type PeerRouteDeps, type PeerInvite } from "../../packages/server/src/routes/peers.js";

function telegramFetch(response: unknown, status = 200) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(response), { status })) as unknown as typeof fetch;
}

const BOT_OK = { ok: true, result: { id: 42, username: "polpo_orchestrator_bot", first_name: "Polpo" } };

function invite(overrides: Partial<PeerInvite> = {}): PeerInvite {
  return { token: "tok_123456789", createdAt: "2026-10-01T00:00:00Z", expiresAt: "2026-10-01T00:15:00Z", status: "pending", ...overrides };
}

function call(deps: PeerRouteDeps, method: string, path: string, body?: unknown) {
  const app = peerRoutes(() => deps);
  return app.request(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("peer routes — pending pairings", () => {
  it("lists pending pairings", async () => {
    const peerStore = { listPendingPairings: vi.fn().mockResolvedValue([{ code: "ABC123" }]) };
    const res = await call({ peerStore }, "GET", "/pairings");
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual([{ code: "ABC123" }]);
  });

  it("rejects a pairing and 404s on unknown codes", async () => {
    const peerStore = { rejectPairing: vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false) };
    expect((await call({ peerStore }, "POST", "/pairings/ABC123/reject")).status).toBe(200);
    expect(peerStore.rejectPairing).toHaveBeenCalledWith("ABC123");
    expect((await call({ peerStore }, "POST", "/pairings/NOPE/reject")).status).toBe(404);
  });

  it("404s when the gateway store is not configured", async () => {
    expect((await call({}, "GET", "/pairings")).status).toBe(404);
  });
});

describe("peer routes — invites", () => {
  it("creates an invite with a t.me deep link when the bot token is valid", async () => {
    const gateway = { createInvite: vi.fn().mockReturnValue(invite()), getInvite: vi.fn() };
    const res = await call({ getGateway: () => gateway, getTelegramBotToken: () => "123:abc", fetch: telegramFetch(BOT_OK) }, "POST", "/invites");
    const { data } = await res.json();
    expect(res.status).toBe(200);
    expect(data.link).toBe("https://t.me/polpo_orchestrator_bot?start=tok_123456789");
    expect(data.command).toBe("/start tok_123456789");
    expect(data.botUsername).toBe("polpo_orchestrator_bot");
  });

  it("still returns the manual command when Telegram cannot be reached", async () => {
    const gateway = { createInvite: vi.fn().mockReturnValue(invite()), getInvite: vi.fn() };
    const failing = vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch;
    const { data } = await (await call({ getGateway: () => gateway, getTelegramBotToken: () => "123:abc", fetch: failing }, "POST", "/invites")).json();
    expect(data.link).toBeUndefined();
    expect(data.command).toBe("/start tok_123456789");
  });

  it("explains that inbound must be enabled when the gateway is not running", async () => {
    const res = await call({}, "POST", "/invites");
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("Enable inbound");
  });

  it("returns the invite status for polling", async () => {
    const paired = invite({ status: "paired", chatId: "5062560138", displayName: "Alessio" });
    const gateway = { createInvite: vi.fn(), getInvite: vi.fn().mockImplementation((t: string) => (t === paired.token ? paired : undefined)) };
    const res = await call({ getGateway: () => gateway }, "GET", `/invites/${paired.token}`);
    expect((await res.json()).data).toMatchObject({ status: "paired", chatId: "5062560138" });
    expect((await call({ getGateway: () => gateway }, "GET", "/invites/unknown")).status).toBe(404);
  });
});

describe("peer routes — Telegram token verification", () => {
  it("returns the bot identity for a valid token", async () => {
    const fetchImpl = telegramFetch(BOT_OK);
    const res = await call({ fetch: fetchImpl }, "POST", "/telegram/verify", { botToken: " 123:abc " });
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: 42, username: "polpo_orchestrator_bot", name: "Polpo" });
    expect((fetchImpl as any).mock.calls[0][0]).toBe("https://api.telegram.org/bot123%3Aabc/getMe");
  });

  it("falls back to the configured token and surfaces Telegram errors", async () => {
    const res = await call({ getTelegramBotToken: () => "bad", fetch: telegramFetch({ ok: false, description: "Unauthorized" }, 401) }, "POST", "/telegram/verify", {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Unauthorized");
  });

  it("requires a token", async () => {
    expect((await call({}, "POST", "/telegram/verify", {})).status).toBe(400);
  });
});

describe("peer routes — dedicated bots", () => {
  it("routes invites and verification to the channel named in ?channel", async () => {
    const primary = { createInvite: vi.fn().mockReturnValue(invite({ token: "primary_tok1" })), getInvite: vi.fn() };
    const coach = { createInvite: vi.fn().mockReturnValue(invite({ token: "coach_tok123" })), getInvite: vi.fn() };
    const getGateway = (channel?: string) => (channel === "coach-bot" ? coach : channel ? undefined : primary);
    const getTelegramBotToken = vi.fn((channel?: string) => (channel === "coach-bot" ? "999:coach" : "123:main"));
    const fetchImpl = telegramFetch({ ok: true, result: { id: 9, username: "health_coach_bot", first_name: "Coach" } });

    const res = await call({ getGateway, getTelegramBotToken, fetch: fetchImpl }, "POST", "/invites?channel=coach-bot");
    const { data } = await res.json();
    expect(data.link).toBe("https://t.me/health_coach_bot?start=coach_tok123");
    expect(primary.createInvite).not.toHaveBeenCalled();
    expect((fetchImpl as any).mock.calls[0][0]).toContain("bot999%3Acoach");

    await call({ getTelegramBotToken, fetch: fetchImpl }, "POST", "/telegram/verify?channel=coach-bot", {});
    expect(getTelegramBotToken).toHaveBeenLastCalledWith("coach-bot");

    expect((await call({ getGateway }, "POST", "/invites?channel=missing")).status).toBe(404);
  });
});

/**
 * Security: GET /config must not return secrets, and saving config read back
 * from the API must not overwrite stored secrets with masked placeholders.
 */
import { describe, it, expect } from "vitest";
import { configRoutes, peerRoutes } from "@polpo-ai/server";
import {
  redactSecrets,
  restoreRedactedSecrets,
  isRedactedValue,
} from "@polpo-ai/core/secret-redaction";
import { redactPolpoConfig } from "../server/security.js";

const BOT_TOKEN = "123456789:AAH-very-secret-telegram-token-xyz9";
const INBOUND = "inbound-shared-secret-0123456789abcd";
const RESEND = "re_live_abcdefghijklmnopqrstuvwxyz1234";
const SLACK = "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXslck";

function makeConfig() {
  return {
    project: "p",
    teams: [],
    providers: { ollama: { baseUrl: "http://localhost:11434/v1" } },
    settings: {
      maxRetries: 3,
      workDir: ".",
      logLevel: "normal",
      databaseUrl: "postgres://polpo:db-p4ssw0rd@db.internal:5432/polpo",
      notifications: {
        channels: {
          tg: { type: "telegram", botToken: BOT_TOKEN, chatId: "-1001234" },
          tgEnv: { type: "telegram", botToken: "${TELEGRAM_BOT_TOKEN}", chatId: "42" },
          hook: {
            type: "webhook",
            url: "https://example.com/hook",
            inboundSecret: INBOUND,
            headers: { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz", "X-Trace": "${TRACE_ID}" },
          },
          mail: { type: "email", provider: "resend", apiKey: RESEND, from: "a@b.c", to: ["x@y.z"] },
          slack: { type: "slack", webhookUrl: SLACK },
          push: { type: "push", vapidPublicKey: "BPUBLICKEY", vapidPrivateKey: "private-vapid-key-0123456789" },
        },
        rules: [],
      },
    },
  };
}

describe("redactSecrets / redactPolpoConfig", () => {
  it("masks literal secrets and keeps ${ENV} references visible", () => {
    const cfg = makeConfig();
    const red = redactPolpoConfig(cfg as any) as any;
    const json = JSON.stringify(red);
    for (const secret of [BOT_TOKEN, INBOUND, RESEND, SLACK, "db-p4ssw0rd", "abcdefghijklmnopqrstuvwxyz", "private-vapid-key-0123456789"]) {
      expect(json).not.toContain(secret);
    }
    const ch = red.settings.notifications.channels;
    expect(ch.tg.botToken).toBe(`••••${BOT_TOKEN.slice(-4)}`);
    expect(ch.tg.chatId).toBe("-1001234");
    expect(ch.tgEnv.botToken).toBe("${TELEGRAM_BOT_TOKEN}");
    expect(ch.hook.url).toBe("https://example.com/hook");
    expect(ch.hook.headers["X-Trace"]).toBe("${TRACE_ID}");
    expect(isRedactedValue(ch.hook.headers.Authorization)).toBe(true);
    expect(ch.push.vapidPublicKey).toBe("BPUBLICKEY");
    expect(red.settings.databaseUrl).toBe("postgres://polpo:••••@db.internal:5432/polpo");
    expect(red.providers.ollama.baseUrl).toBe("http://localhost:11434/v1");
    // never mutates the live config
    expect(cfg.settings.notifications.channels.tg.botToken).toBe(BOT_TOKEN);
  });

  it("does not mask non-secret numeric/limit fields", () => {
    const red = redactSecrets({ maxTokens: 1000, tokenBudget: "abc", allowedTools: ["bash"] });
    expect(red).toEqual({ maxTokens: 1000, tokenBudget: "abc", allowedTools: ["bash"] });
  });

  it("round-trips: restoring a redacted object yields the original secrets", () => {
    const cfg = makeConfig();
    const restored = restoreRedactedSecrets(redactSecrets(cfg), cfg);
    expect(restored).toEqual(cfg);
  });

  it("keeps user edits and drops masks without a stored value", () => {
    const stored = makeConfig().settings.notifications.channels.tg;
    const incoming = { ...redactSecrets(stored), chatId: "999" };
    expect(restoreRedactedSecrets(incoming, stored)).toEqual({ ...stored, chatId: "999" });

    const changed = { ...redactSecrets(stored), botToken: "new-token-value" };
    expect(restoreRedactedSecrets(changed, stored).botToken).toBe("new-token-value");

    const orphan = restoreRedactedSecrets({ type: "telegram", botToken: "••••abcd" }, undefined) as any;
    expect("botToken" in orphan).toBe(false);
  });

  it("restores a masked URL password while keeping an edited host", () => {
    const stored = { databaseUrl: "postgres://u:secretpw@old-host/db" };
    const incoming = { databaseUrl: "postgres://u:••••@new-host/db" };
    expect(restoreRedactedSecrets(incoming, stored).databaseUrl).toBe("postgres://u:secretpw@new-host/db");
  });
});

describe("config routes", () => {
  function setup() {
    let config: any = makeConfig();
    const saved: any[] = [];
    const app = configRoutes(() => ({
      getConfig: () => config,
      reloadConfig: async () => true,
      saveConfig: async (c: any) => { saved.push(c); config = c; },
      getNotificationRouter: () => null,
    }));
    return { app, saved, get config() { return config; } };
  }

  it("GET / and GET /channels return redacted secrets", async () => {
    const { app } = setup();
    for (const path of ["/", "/channels"]) {
      const res = await app.request(path);
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).not.toContain(BOT_TOKEN);
      expect(text).not.toContain(INBOUND);
      expect(text).not.toContain(RESEND);
      expect(text).not.toContain("db-p4ssw0rd");
    }
  });

  it("PUT /channels/:name with the redacted channel keeps the stored secrets", async () => {
    const ctx = setup();
    const listed = await (await ctx.app.request("/channels")).json() as any;
    const tg = { ...listed.data.tg, chatId: "-100999" };
    expect(isRedactedValue(tg.botToken)).toBe(true);

    const res = await ctx.app.request("/channels/tg", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tg),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain(BOT_TOKEN);

    const stored = ctx.config.settings.notifications.channels.tg;
    expect(stored.botToken).toBe(BOT_TOKEN);
    expect(stored.chatId).toBe("-100999");

    const hook = { ...listed.data.hook };
    await ctx.app.request("/channels/hook", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(hook),
    });
    const storedHook = ctx.config.settings.notifications.channels.hook;
    expect(storedHook.inboundSecret).toBe(INBOUND);
    expect(storedHook.headers.Authorization).toBe("Bearer abcdefghijklmnopqrstuvwxyz");
  });

  it("PUT /channels/:name with a new secret replaces it", async () => {
    const ctx = setup();
    await ctx.app.request("/channels/tg", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "telegram", botToken: "999:NEW", chatId: "1" }),
    });
    expect(ctx.config.settings.notifications.channels.tg.botToken).toBe("999:NEW");
  });
});

describe("peers telegram verify with a redacted token", () => {
  it("falls back to the saved channel token", async () => {
    const seen: string[] = [];
    const app = peerRoutes(() => ({
      peerStore: {} as any,
      getGateway: () => undefined,
      getTelegramBotToken: (channel?: string) => (channel === "tg" ? BOT_TOKEN : undefined),
      fetch: (async (url: string) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ ok: true, result: { id: 1, username: "bot", first_name: "B" } }));
      }) as any,
    }) as any);
    const res = await app.request("/telegram/verify?channel=tg", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ botToken: `••••${BOT_TOKEN.slice(-4)}` }),
    });
    expect(res.status).toBe(200);
    expect(seen[0]).toContain(encodeURIComponent(BOT_TOKEN));
  });
});

import { describe, expect, it } from "vitest";
import {
  getPiOAuthRuntime,
  listPiOAuthProviders,
  oauthCredentialFromProfile,
} from "../auth/pi-oauth-runtime.js";
import { normalizeLoginPrompt } from "../auth/oauth-manager.js";

describe("pi OAuth runtime compatibility", () => {
  it("discovers every OAuth provider exposed by pi-ai 1.0", () => {
    expect(listPiOAuthProviders().map((provider) => provider.id)).toEqual([
      "anthropic",
      "github-copilot",
      "kimi-coding",
      "meta",
      "openai",
      "openai-codex",
      "openrouter",
      "radius",
      "xai",
    ]);
  });

  it("exposes provider-owned login, refresh, and auth conversion", () => {
    const runtime = getPiOAuthRuntime("openai-codex");

    expect(runtime?.login).toBeTypeOf("function");
    expect(runtime?.refresh).toBeTypeOf("function");
    expect(runtime?.toAuth).toBeTypeOf("function");
  });

  it("preserves provider-specific fields when converting stored profiles", () => {
    expect(oauthCredentialFromProfile({
      provider: "github-copilot",
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
      email: "dev@example.com",
      extra: {
        enterpriseUrl: "https://github.example.com",
        accountId: "account-1",
      },
      createdAt: "2026-08-21T00:00:00.000Z",
    })).toMatchObject({
      type: "oauth",
      access: "access-token",
      refresh: "refresh-token",
      expires: 123,
      email: "dev@example.com",
      enterpriseUrl: "https://github.example.com",
      accountId: "account-1",
    });
  });

  it("preserves structured OAuth login choices for app UIs", () => {
    expect(normalizeLoginPrompt({
      type: "select",
      message: "Select OpenAI Codex login method:",
      options: [
        { id: "browser", label: "Browser login (default)" },
        { id: "device_code", label: "Device code login (headless)" },
      ],
    })).toEqual({
      type: "select",
      message: "Select OpenAI Codex login method:",
      placeholder: undefined,
      options: [
        { id: "browser", label: "Browser login (default)" },
        { id: "device_code", label: "Device code login (headless)" },
      ],
    });
  });
});

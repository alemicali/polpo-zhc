import { describe, it, expect } from "vitest";
import {
  redactAgentConfig,
  redactTeam,
  redactPolpoState,
  redactPolpoConfig,
  sanitizeTranscriptEntry,
  SENSITIVE_PARAM_RE,
} from "../server/security.js";
import type { AgentConfig, Team, PolpoState, PolpoConfig } from "../core/types.js";

// ── redactAgentConfig ──
// NOTE: Vault credentials are no longer stored on AgentConfig — they live
// in the encrypted vault store. redactAgentConfig is a pass-through now.

describe("redactAgentConfig", () => {
  it("returns agent unchanged (pass-through — vault no longer inline)", () => {
    const agent: AgentConfig = {
      name: "alice",
      role: "dev",
      identity: { displayName: "Alice", title: "Engineer" },
    };

    const result = redactAgentConfig(agent);
    expect(result).toBe(agent); // same reference — pass-through
    expect(result.name).toBe("alice");
    expect(result.role).toBe("dev");
    expect(result.identity?.displayName).toBe("Alice");
  });

  it("returns agent unchanged when no vault (still pass-through)", () => {
    const agent: AgentConfig = { name: "bob", role: "qa" };
    const result = redactAgentConfig(agent);
    expect(result).toBe(agent);
  });
});

// ── redactTeam ──

describe("redactTeam", () => {
  it("returns team unchanged (pass-through)", () => {
    const team: Team = {
      name: "alpha",
      agents: [
        { name: "a1" },
        { name: "a2", role: "dev" },
        { name: "a3" },
      ],
    };

    const result = redactTeam(team);
    expect(result).toBe(team); // same reference
    expect(result.name).toBe("alpha");
    expect(result.agents).toHaveLength(3);
  });
});

// ── redactPolpoState ──

describe("redactPolpoState", () => {
  it("returns state unchanged (pass-through)", () => {
    const state: PolpoState = {
      org: "test",
      teams: [{
        name: "t",
        agents: [{ name: "x" }],
      }],
      tasks: [],
      processes: [],
    };

    const result = redactPolpoState(state);
    expect(result).toBe(state); // same reference
    expect(result.org).toBe("test");
  });
});

// ── redactPolpoConfig ──

describe("redactPolpoConfig", () => {
  it("redacts providers.apiKey values", () => {
    const config = {
      version: "1",
      org: "test",
      teams: [{
        name: "t",
        agents: [{ name: "a" }],
      }],
      tasks: [],
      settings: { maxRetries: 3, workDir: ".", logLevel: "normal" as const },
      providers: {
        anthropic: { apiKey: "sk-ant-12345" },
        openai: { apiKey: "sk-openai-abc", baseUrl: "https://api.openai.com" },
        ollama: { baseUrl: "http://localhost:11434" },
      },
    } as PolpoConfig;

    const result = redactPolpoConfig(config);

    // Provider keys redacted
    expect(result.providers!.anthropic.apiKey).toBe("***");
    expect(result.providers!.openai.apiKey).toBe("***");
    expect(result.providers!.openai.baseUrl).toBe("https://api.openai.com");
    // No apiKey → undefined preserved
    expect(result.providers!.ollama.apiKey).toBeUndefined();
  });

  it("handles config without providers", () => {
    const config = {
      version: "1",
      org: "test",
      teams: [{ name: "t", agents: [] }],
      tasks: [],
      settings: { maxRetries: 1, workDir: ".", logLevel: "quiet" as const },
    } as PolpoConfig;

    const result = redactPolpoConfig(config);
    expect(result.providers).toBeUndefined();
  });
});

// ── sanitizeTranscriptEntry ──

describe("sanitizeTranscriptEntry", () => {
  it("redacts smtp_pass and Authorization in tool_use input", () => {
    const entry = {
      type: "tool_use",
      tool: "email_send",
      input: {
        to: "alice@example.com",
        subject: "Hello",
        smtp_pass: "secret123",
        auth_token: "Bearer xyz",
      },
    };

    const result = sanitizeTranscriptEntry(entry);
    const input = result.input as Record<string, unknown>;
    expect(input.to).toBe("alice@example.com");
    expect(input.subject).toBe("Hello");
    expect(input.smtp_pass).toBe("[REDACTED]");
    expect(input.auth_token).toBe("[REDACTED]");
  });

  it("does not touch entry without sensitive input", () => {
    const entry = {
      type: "tool_use",
      tool: "read",
      input: { path: "/foo/bar.ts" },
    };

    const result = sanitizeTranscriptEntry(entry);
    expect(result).toBe(entry); // same reference — unchanged
  });

  it("does not modify tool_result entries", () => {
    const entry = {
      type: "tool_result",
      toolId: "123",
      content: "password: abc123",
    };

    const result = sanitizeTranscriptEntry(entry);
    expect(result).toBe(entry);
  });

  it("does not modify assistant entries", () => {
    const entry = {
      type: "assistant",
      text: "The password is secret",
    };

    const result = sanitizeTranscriptEntry(entry);
    expect(result).toBe(entry);
  });

  it("handles tool_use without input", () => {
    const entry = { type: "tool_use", tool: "ls" };
    const result = sanitizeTranscriptEntry(entry);
    expect(result).toBe(entry);
  });

  it("does not mutate original entry", () => {
    const entry = {
      type: "tool_use",
      tool: "http_fetch",
      input: { url: "https://api.example.com", api_key: "real-key" },
    };

    sanitizeTranscriptEntry(entry);
    expect((entry.input as any).api_key).toBe("real-key");
  });

  it("matches various sensitive parameter names", () => {
    for (const key of ["password", "secret", "token", "api_key", "auth_header", "credential_id", "smtp_pass"]) {
      expect(SENSITIVE_PARAM_RE.test(key)).toBe(true);
    }
    for (const key of ["url", "path", "to", "subject", "body", "method"]) {
      expect(SENSITIVE_PARAM_RE.test(key)).toBe(false);
    }
  });
});

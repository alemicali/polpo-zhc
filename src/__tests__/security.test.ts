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

describe("redactAgentConfig", () => {
  it("preserves name/role/identity, masks vault values", () => {
    const agent: AgentConfig = {
      name: "alice",
      role: "dev",
      identity: { displayName: "Alice", title: "Engineer" },
      vault: {
        smtp: {
          type: "smtp",
          label: "Work Email",
          credentials: { host: "mail.example.com", user: "alice", pass: "s3cret" },
        },
      },
    };

    const result = redactAgentConfig(agent);

    expect(result.name).toBe("alice");
    expect(result.role).toBe("dev");
    expect(result.identity?.displayName).toBe("Alice");
    expect(result.vault!.smtp.type).toBe("smtp");
    expect(result.vault!.smtp.label).toBe("Work Email");
    expect(result.vault!.smtp.credentials.host).toBe("***");
    expect(result.vault!.smtp.credentials.user).toBe("***");
    expect(result.vault!.smtp.credentials.pass).toBe("***");
  });

  it("returns agent unchanged when no vault", () => {
    const agent: AgentConfig = { name: "bob", role: "qa" };
    const result = redactAgentConfig(agent);
    expect(result).toBe(agent); // same reference — no copy needed
  });

  it("handles multiple vault entries", () => {
    const agent: AgentConfig = {
      name: "carol",
      vault: {
        smtp: { type: "smtp", credentials: { pass: "x" } },
        github: { type: "api_key", credentials: { token: "ghp_abc" } },
      },
    };

    const result = redactAgentConfig(agent);
    expect(result.vault!.smtp.credentials.pass).toBe("***");
    expect(result.vault!.github.credentials.token).toBe("***");
  });

  it("does not mutate original agent", () => {
    const agent: AgentConfig = {
      name: "dave",
      vault: { api: { type: "api_key", credentials: { key: "real-key" } } },
    };

    redactAgentConfig(agent);
    expect(agent.vault!.api.credentials.key).toBe("real-key");
  });
});

// ── redactTeam ──

describe("redactTeam", () => {
  it("applies redaction to all agents", () => {
    const team: Team = {
      name: "alpha",
      agents: [
        { name: "a1", vault: { s: { type: "smtp", credentials: { pass: "p1" } } } },
        { name: "a2", vault: { s: { type: "api_key", credentials: { key: "k2" } } } },
        { name: "a3" }, // no vault
      ],
    };

    const result = redactTeam(team);
    expect(result.name).toBe("alpha");
    expect(result.agents[0].vault!.s.credentials.pass).toBe("***");
    expect(result.agents[1].vault!.s.credentials.key).toBe("***");
    expect(result.agents[2].vault).toBeUndefined();
  });
});

// ── redactPolpoState ──

describe("redactPolpoState", () => {
  it("redacts team.agents in state", () => {
    const state: PolpoState = {
      project: "test",
      team: {
        name: "t",
        agents: [{ name: "x", vault: { db: { type: "login", credentials: { password: "abc" } } } }],
      },
      tasks: [],
      processes: [],
    };

    const result = redactPolpoState(state);
    expect(result.team.agents[0].vault!.db.credentials.password).toBe("***");
    expect(result.project).toBe("test");
  });
});

// ── redactPolpoConfig ──

describe("redactPolpoConfig", () => {
  it("redacts team + providers.apiKey", () => {
    const config = {
      version: "1",
      project: "test",
      team: {
        name: "t",
        agents: [{ name: "a", vault: { s: { type: "smtp" as const, credentials: { pass: "x" } } } }],
      },
      tasks: [],
      settings: { maxRetries: 3, workDir: ".", logLevel: "normal" as const },
      providers: {
        anthropic: { apiKey: "sk-ant-12345" },
        openai: { apiKey: "sk-openai-abc", baseUrl: "https://api.openai.com" },
        ollama: { baseUrl: "http://localhost:11434" },
      },
    } as PolpoConfig;

    const result = redactPolpoConfig(config);

    // Team redacted
    expect(result.team.agents[0].vault!.s.credentials.pass).toBe("***");

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
      project: "test",
      team: { name: "t", agents: [] },
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

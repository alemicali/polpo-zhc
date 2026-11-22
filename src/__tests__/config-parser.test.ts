import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, generatePolpoConfigDefault, savePolpoConfig } from "../core/config.js";

const TMP = "/tmp/polpo-config-test";
const POLPO_DIR = join(TMP, ".polpo");

/** Write a polpo.json config and return the workDir (TMP). */
function writeConfig(config: object): string {
  mkdirSync(POLPO_DIR, { recursive: true });
  writeFileSync(join(POLPO_DIR, "polpo.json"), JSON.stringify(config, null, 2));
  return TMP;
}

/** Minimal valid config for reuse. */
function minimalConfig() {
  return {
    project: "test-project",
    team: {
      name: "test-team",
      agents: [
        { name: "agent-1" },
      ],
    },
    settings: {
      maxRetries: 3,
      workDir: ".",
      logLevel: "normal",
    },
  };
}

describe("parseConfig (.polpo/polpo.json)", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  // ────────────────────────────────────────────────────
  // Happy paths
  // ────────────────────────────────────────────────────

  describe("happy paths", () => {
    it("parses a valid minimal config", async () => {
      const workDir = writeConfig(minimalConfig());
      const config = await parseConfig(workDir);

      expect(config.version).toBe("1");
      expect(config.project).toBe("test-project");
      expect(config.teams).toEqual([]); // teams come from stores, not polpo.json
      expect(config.tasks).toEqual([]);
    });

    it("reads egress proxies, and refuses a malformed one", async () => {
      const ok = await parseConfig(writeConfig({ ...minimalConfig(), settings: { ...minimalConfig().settings, egressProxies: { home: "socks5://100.101.55.7:1080" } } }));
      expect(ok.settings.egressProxies).toEqual({ home: "socks5://100.101.55.7:1080" });
      await expect(parseConfig(writeConfig({ ...minimalConfig(), settings: { ...minimalConfig().settings, egressProxies: { home: "ftp://x" } } })))
        .rejects.toThrow(/settings.egressProxies.home/);
    });

    it("parses config with full settings", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: {
          maxRetries: 5,
          workDir: "/tmp/work",
          logLevel: "verbose",
          taskTimeout: 120000,
          staleThreshold: 60000,
          orchestratorModel: "claude-sonnet-4-5-20250929",
        },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);

      expect(config.settings.maxRetries).toBe(5);
      expect(config.settings.workDir).toBe("/tmp/work");
      expect(config.settings.logLevel).toBe("verbose");
      expect(config.settings.taskTimeout).toBe(120000);
      expect(config.settings.staleThreshold).toBe(60000);
      expect(config.settings.orchestratorModel).toBe("claude-sonnet-4-5-20250929");
    });

    it("preserves shared instance branding", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: {
          ...minimalConfig().settings,
          branding: {
            productName: "Acme Ops",
            tagline: "Internal AI",
            logoUrl: "/api/v1/config/branding/logo",
          },
        },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);

      expect(config.settings.branding).toEqual({
        productName: "Acme Ops",
        tagline: "Internal AI",
        logoUrl: "/api/v1/config/branding/logo",
      });
    });

    it("reads the logo frame (box or none); anything else is the default", async () => {
      const read = async (logoFrame: unknown) => (await parseConfig(writeConfig({
        ...minimalConfig(), settings: { ...minimalConfig().settings, branding: { logoFrame } },
      }))).settings.branding?.logoFrame;
      expect(await read("none")).toBe("none");
      expect(await read("box")).toBe("box");
      expect(await read("circle")).toBeUndefined();
      expect(await read(1)).toBeUndefined();
    });

    it("ignores teams in polpo.json — returns empty teams", async () => {
      const cfg = {
        ...minimalConfig(),
        team: {
          name: "multi-team",
          agents: [
            { name: "coder" },
            { name: "engine-dev" },
            { name: "custom-dev" },
          ],
        },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);

      expect(config.teams).toEqual([]); // teams come from stores only
    });

    it("defaults logLevel to 'normal' when settings are missing", async () => {
      const cfg = { ...minimalConfig() };
      delete (cfg as any).settings;
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);
      expect(config.settings.logLevel).toBe("normal");
    });

    it("defaults workDir to '.' when settings are missing", async () => {
      const cfg = { ...minimalConfig() };
      delete (cfg as any).settings;
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);
      expect(config.settings.workDir).toBe(".");
    });

    it("accepts logLevel 'quiet'", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: { ...minimalConfig().settings, logLevel: "quiet" },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);
      expect(config.settings.logLevel).toBe("quiet");
    });

    it("accepts logLevel 'verbose'", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: { ...minimalConfig().settings, logLevel: "verbose" },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);
      expect(config.settings.logLevel).toBe("verbose");
    });

    it("parses provider overrides (baseUrl/api/models only)", async () => {
      const cfg = {
        ...minimalConfig(),
        providers: {
          ollama: { baseUrl: "http://localhost:11434/v1", api: "openai-completions" },
          custom: { baseUrl: "https://my-vllm.example.com/v1" },
        },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);
      expect(config.providers).toBeDefined();
      expect(config.providers!.ollama.baseUrl).toBe("http://localhost:11434/v1");
      expect(config.providers!.ollama.api).toBe("openai-completions");
      expect(config.providers!.custom.baseUrl).toBe("https://my-vllm.example.com/v1");
    });

    it("ignores provider entries that only have apiKey (no custom config)", async () => {
      const cfg = {
        ...minimalConfig(),
        providers: {
          anthropic: { apiKey: "sk-test" },
          openai: "sk-openai-test",
          ollama: { baseUrl: "http://localhost:11434/v1" },
        },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);
      expect(config.providers).toBeDefined();
      // Only ollama should remain — it has baseUrl
      expect(config.providers!.ollama).toBeDefined();
      expect(config.providers!.ollama.baseUrl).toBe("http://localhost:11434/v1");
      // anthropic had only apiKey, openai was a string — both skipped
      expect(config.providers!.anthropic).toBeUndefined();
      expect(config.providers!.openai).toBeUndefined();
    });
  });

  // ────────────────────────────────────────────────────
  // Error cases
  // ────────────────────────────────────────────────────

  describe("error cases", () => {
    it("throws when .polpo/polpo.json is missing", async () => {
      mkdirSync(POLPO_DIR, { recursive: true });
      // Don't write polpo.json
      await expect(parseConfig(TMP)).rejects.toThrow(/No configuration found/);
    });

    it("ignores agents in polpo.json without validation", async () => {
      const cfg = {
        ...minimalConfig(),
        team: {
          name: "team",
          agents: [{}], // no name — but parseConfig no longer validates
        },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);
      expect(config.teams).toEqual([]); // ignored
    });

    it("reads the instance appearance, the dark-mode logo and Polpo's voice replies", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: {
          ...minimalConfig().settings,
          voiceReplies: "voice",
          branding: { logoDarkUrl: "/api/v1/config/branding/logo-dark" },
          appearance: { theme: "system", palette: "mono", custom: { enabled: true, light: { text: "#111111", radius: 6 }, dark: { primary: "oklch(0.7 0.15 200)" } } },
        },
      };
      const config = await parseConfig(writeConfig(cfg));
      expect(config.settings.voiceReplies).toBe("voice");
      expect(config.settings.branding?.logoDarkUrl).toBe("/api/v1/config/branding/logo-dark");
      // the old `text` is foreground
      expect(config.settings.appearance).toEqual({
        theme: "system", palette: "mono", custom: { enabled: true, light: { foreground: "#111111", radius: 6 }, dark: { primary: "oklch(0.7 0.15 200)" } },
      });
    });

    it("ignores the invalid part of an appearance with a warning, never refusing to start", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const appearance = {
        theme: "purple", palette: "mono", extra: 1,
        custom: { enabled: true, light: { primary: "red;}", background: "#ffffff", radius: 40 }, dark: { fontFamily: "x; } body {", nope: "#fff", ring: "#000000" } },
      };
      const config = await parseConfig(writeConfig({ ...minimalConfig(), settings: { ...minimalConfig().settings, appearance } }));
      expect(config.settings.appearance).toEqual({ palette: "mono", custom: { enabled: true, light: { background: "#ffffff" }, dark: { ring: "#000000" } } });
      const message = warn.mock.calls.map((c) => String(c[0])).join("\n");
      for (const part of ["theme", "extra", "custom.light.primary", "custom.light.radius", "fontFamily", "unknown token nope"]) expect(message).toContain(part);
      warn.mockRestore();
      // not an object at all: ignored too
      const silent = vi.spyOn(console, "warn").mockImplementation(() => {});
      const plain = await parseConfig(writeConfig({ ...minimalConfig(), settings: { ...minimalConfig().settings, appearance: "dark" } }));
      expect(plain.settings.appearance).toBeUndefined();
      silent.mockRestore();
    });

    it("throws on invalid logLevel", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: { ...minimalConfig().settings, logLevel: "debug" },
      };
      const workDir = writeConfig(cfg);
      await expect(parseConfig(workDir)).rejects.toThrow(
        'Invalid logLevel "debug": must be quiet, normal, or verbose',
      );
    });
  });
});

describe("generatePolpoConfigDefault", () => {
  it("returns a valid config with project name", () => {
    const config = generatePolpoConfigDefault("my-project");
    expect(config.project).toBe("my-project");
    expect(config.teams[0].name).toBe("default");
    expect(config.teams[0].agents).toHaveLength(1);
    expect(config.teams[0].agents[0].name).toBe("agent-1");
    expect(config.settings.maxRetries).toBe(3);
    expect(config.settings.logLevel).toBe("normal");
  });

  it("round-trips through savePolpoConfig and parseConfig", async () => {
    mkdirSync(join(TMP, ".polpo"), { recursive: true });
    const config = generatePolpoConfigDefault("round-trip");
    savePolpoConfig(join(TMP, ".polpo"), config);

    const parsed = await parseConfig(TMP);
    expect(parsed.project).toBe("round-trip");
    expect(parsed.teams).toEqual([]); // teams come from stores, not polpo.json
    expect(parsed.settings.maxRetries).toBe(3);
  });
});

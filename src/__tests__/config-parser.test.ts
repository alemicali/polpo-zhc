import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
    org: "test-project",
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
      expect(config.org).toBe("test-project");
      expect(config.teams[0].name).toBe("test-team");
      expect(config.teams[0].agents).toHaveLength(1);
      expect(config.teams[0].agents[0].name).toBe("agent-1");
      expect(config.tasks).toEqual([]); // tasks come from plans, not config
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

    it("parses config with multiple agents", async () => {
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

      expect(config.teams[0].agents).toHaveLength(3);
      expect(config.teams[0].agents).toHaveLength(3);
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

    it("parses provider overrides", async () => {
      const cfg = {
        ...minimalConfig(),
        providers: {
          anthropic: { apiKey: "sk-test" },
          openai: "sk-openai-test",
        },
      };
      const workDir = writeConfig(cfg);
      const config = await parseConfig(workDir);
      expect(config.providers).toBeDefined();
      expect(config.providers!.anthropic.apiKey).toBe("sk-test");
      expect(config.providers!.openai.apiKey).toBe("sk-openai-test");
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

    it("throws on agent without name", async () => {
      const cfg = {
        ...minimalConfig(),
        team: {
          name: "team",
          agents: [{}],
        },
      };
      const workDir = writeConfig(cfg);
      await expect(parseConfig(workDir)).rejects.toThrow("Each agent must have a name");
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
    expect(config.org).toBe("my-project");
    expect(config.teams[0].name).toBe("default");
    expect(config.teams[0].agents).toHaveLength(1);
    expect(config.teams[0].agents[0].name).toBe("dev-1");
    expect(config.settings.maxRetries).toBe(3);
    expect(config.settings.logLevel).toBe("normal");
  });

  it("round-trips through savePolpoConfig and parseConfig", async () => {
    mkdirSync(join(TMP, ".polpo"), { recursive: true });
    const config = generatePolpoConfigDefault("round-trip");
    savePolpoConfig(join(TMP, ".polpo"), config);

    const parsed = await parseConfig(TMP);
    expect(parsed.org).toBe("round-trip");
    expect(parsed.teams[0].name).toBe("default");
    expect(parsed.teams[0].agents).toHaveLength(1);
    expect(parsed.settings.maxRetries).toBe(3);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stringify, parse } from "yaml";
import { parseConfig, generateTemplate } from "../core/config.js";

const TMP = "/tmp/polpo-config-test";

/** Write a JS object as YAML and return the file path. */
function writeYaml(name: string, content: object): string {
  const path = join(TMP, name);
  writeFileSync(path, stringify(content));
  return path;
}

/** Write raw string content to a file and return the path. */
function writeRaw(name: string, content: string): string {
  const path = join(TMP, name);
  writeFileSync(path, content);
  return path;
}

/** Minimal valid config object for reuse across tests. */
function minimalConfig() {
  return {
    version: "1",
    project: "test-project",
    team: {
      name: "test-team",
      agents: [
        { name: "agent-1", adapter: "claude-sdk" },
      ],
    },
    tasks: [
      {
        id: "task-1",
        title: "First task",
        description: "Do something",
        assignTo: "agent-1",
      },
    ],
  };
}

describe("parseConfig", () => {
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
      const path = writeYaml("minimal.yml", minimalConfig());
      const config = await parseConfig(path);

      expect(config.version).toBe("1");
      expect(config.project).toBe("test-project");
      expect(config.team.name).toBe("test-team");
      expect(config.team.agents).toHaveLength(1);
      expect(config.team.agents[0].name).toBe("agent-1");
      expect(config.team.agents[0].adapter).toBe("claude-sdk");
      expect(config.tasks).toHaveLength(1);
      expect(config.tasks[0].id).toBe("task-1");
    });

    it("parses config with all optional fields", async () => {
      const full = {
        ...minimalConfig(),
        settings: {
          maxRetries: 5,
          workDir: "/tmp/work",
          logLevel: "verbose",
        },
        tasks: [
          {
            id: "task-1",
            title: "First task",
            description: "Do something",
            assignTo: "agent-1",
            dependsOn: ["task-0"],
            expectations: [
              { type: "test", command: "npm test" },
            ],
            metrics: [
              { name: "coverage", command: "npm run cov", threshold: 80 },
            ],
            maxRetries: 10,
          },
        ],
      };
      const path = writeYaml("full.yml", full);
      const config = await parseConfig(path);

      expect(config.settings.maxRetries).toBe(5);
      expect(config.settings.workDir).toBe("/tmp/work");
      expect(config.settings.logLevel).toBe("verbose");
      expect(config.tasks[0].dependsOn).toEqual(["task-0"]);
      expect(config.tasks[0].expectations).toHaveLength(1);
      expect(config.tasks[0].expectations[0]).toEqual({
        type: "test",
        command: "npm test",
      });
      expect(config.tasks[0].metrics).toHaveLength(1);
      expect(config.tasks[0].maxRetries).toBe(10);
    });

    it("parses config with multiple agents and tasks", async () => {
      const cfg = {
        ...minimalConfig(),
        team: {
          name: "multi-team",
          agents: [
            { name: "coder", adapter: "claude-sdk" },
            { name: "reviewer", adapter: "claude-sdk" },
            { name: "runner", adapter: "generic", command: "bash run.sh {prompt}" },
          ],
        },
        tasks: [
          { id: "t1", title: "Code", description: "Write code", assignTo: "coder" },
          { id: "t2", title: "Review", description: "Review code", assignTo: "reviewer", dependsOn: ["t1"] },
          { id: "t3", title: "Deploy", description: "Deploy app", assignTo: "runner", dependsOn: ["t2"] },
        ],
      };
      const path = writeYaml("multi.yml", cfg);
      const config = await parseConfig(path);

      expect(config.team.agents).toHaveLength(3);
      expect(config.tasks).toHaveLength(3);
      expect(config.tasks[1].dependsOn).toEqual(["t1"]);
      expect(config.tasks[2].dependsOn).toEqual(["t2"]);
    });

    it("defaults dependsOn to [] when missing", async () => {
      const path = writeYaml("no-depends.yml", minimalConfig());
      const config = await parseConfig(path);
      expect(config.tasks[0].dependsOn).toEqual([]);
    });

    it("defaults maxRetries from settings when not specified on task", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: { maxRetries: 7 },
      };
      const path = writeYaml("retries-from-settings.yml", cfg);
      const config = await parseConfig(path);
      expect(config.tasks[0].maxRetries).toBe(7);
    });

    it("defaults maxRetries to 3 when neither task nor settings specify it", async () => {
      const path = writeYaml("default-retries.yml", minimalConfig());
      const config = await parseConfig(path);
      expect(config.tasks[0].maxRetries).toBe(3);
    });

    it("defaults logLevel to 'normal' when settings are missing", async () => {
      const path = writeYaml("no-settings.yml", minimalConfig());
      const config = await parseConfig(path);
      expect(config.settings.logLevel).toBe("normal");
    });

    it("defaults workDir to '.' when settings are missing", async () => {
      const path = writeYaml("no-workdir.yml", minimalConfig());
      const config = await parseConfig(path);
      expect(config.settings.workDir).toBe(".");
    });

    it("defaults expectations to [] and sanitizes them", async () => {
      const path = writeYaml("no-expectations.yml", minimalConfig());
      const config = await parseConfig(path);
      expect(config.tasks[0].expectations).toEqual([]);
    });

    it("defaults metrics to [] when missing", async () => {
      const path = writeYaml("no-metrics.yml", minimalConfig());
      const config = await parseConfig(path);
      expect(config.tasks[0].metrics).toEqual([]);
    });

    it("task maxRetries overrides settings maxRetries", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: { maxRetries: 7 },
        tasks: [
          {
            id: "task-1",
            title: "First task",
            description: "Do something",
            assignTo: "agent-1",
            maxRetries: 2,
          },
        ],
      };
      const path = writeYaml("task-overrides-retries.yml", cfg);
      const config = await parseConfig(path);
      expect(config.tasks[0].maxRetries).toBe(2);
      expect(config.settings.maxRetries).toBe(7);
    });

    it("accepts generic adapter with command", async () => {
      const cfg = {
        ...minimalConfig(),
        team: {
          name: "test-team",
          agents: [
            { name: "builder", adapter: "generic", command: "bash build.sh {prompt}" },
          ],
        },
      };
      const path = writeYaml("generic-ok.yml", cfg);
      const config = await parseConfig(path);
      expect(config.team.agents[0].adapter).toBe("generic");
      expect(config.team.agents[0].command).toBe("bash build.sh {prompt}");
    });

    it("accepts logLevel 'quiet'", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: { logLevel: "quiet" },
      };
      const path = writeYaml("quiet.yml", cfg);
      const config = await parseConfig(path);
      expect(config.settings.logLevel).toBe("quiet");
    });

    it("accepts logLevel 'verbose'", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: { logLevel: "verbose" },
      };
      const path = writeYaml("verbose.yml", cfg);
      const config = await parseConfig(path);
      expect(config.settings.logLevel).toBe("verbose");
    });

    it("drops invalid expectations with a warning", async () => {
      const cfg = {
        ...minimalConfig(),
        tasks: [
          {
            id: "task-1",
            title: "First task",
            description: "Do something",
            assignTo: "agent-1",
            expectations: [
              { type: "test", command: "npm test" },
              { type: "test" }, // missing command -> dropped
            ],
          },
        ],
      };
      const path = writeYaml("bad-expectation.yml", cfg);
      const config = await parseConfig(path);
      // Only the valid expectation survives
      expect(config.tasks[0].expectations).toHaveLength(1);
      expect(config.tasks[0].expectations[0]).toEqual({
        type: "test",
        command: "npm test",
      });
    });
  });

  // ────────────────────────────────────────────────────
  // Error cases
  // ────────────────────────────────────────────────────

  describe("error cases", () => {
    it("throws on non-existent file", async () => {
      await expect(parseConfig(join(TMP, "nonexistent.yml"))).rejects.toThrow();
    });

    it("throws on invalid YAML (not an object — bare string)", async () => {
      const path = writeRaw("bare-string.yml", "just a string\n");
      await expect(parseConfig(path)).rejects.toThrow("not a valid YAML object");
    });

    it("throws on invalid YAML (not an object — array)", async () => {
      // Arrays pass typeof === "object" in JS, so the parser hits the version check first
      const path = writeRaw("array.yml", "- item1\n- item2\n");
      await expect(parseConfig(path)).rejects.toThrow("Config missing required field: version");
    });

    it("throws on invalid YAML (null document)", async () => {
      const path = writeRaw("null.yml", "---\n");
      await expect(parseConfig(path)).rejects.toThrow("not a valid YAML object");
    });

    it("throws on missing version", async () => {
      const cfg = { ...minimalConfig() } as Record<string, unknown>;
      delete cfg.version;
      const path = writeYaml("no-version.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow("Config missing required field: version");
    });

    it("throws on non-string version", async () => {
      const cfg = { ...minimalConfig(), version: 42 };
      const path = writeYaml("num-version.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow("Config missing required field: version");
    });

    it("throws on missing project", async () => {
      const cfg = { ...minimalConfig() } as Record<string, unknown>;
      delete cfg.project;
      const path = writeYaml("no-project.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow("Config missing required field: project");
    });

    it("throws on non-string project", async () => {
      const cfg = { ...minimalConfig(), project: 123 };
      const path = writeYaml("num-project.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow("Config missing required field: project");
    });

    it("throws on missing team", async () => {
      const cfg = { ...minimalConfig() } as Record<string, unknown>;
      delete cfg.team;
      const path = writeYaml("no-team.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow("Config missing required field: team");
    });

    it("throws on team that is not an object", async () => {
      const cfg = { ...minimalConfig(), team: "not-an-object" };
      const path = writeYaml("team-string.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow("Config missing required field: team");
    });

    it("throws on missing team.name", async () => {
      const cfg = {
        ...minimalConfig(),
        team: { agents: [{ name: "a", adapter: "claude-sdk" }] },
      };
      const path = writeYaml("no-team-name.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow("Config missing required field: team.name");
    });

    it("throws on non-string team.name", async () => {
      const cfg = {
        ...minimalConfig(),
        team: { name: 42, agents: [{ name: "a", adapter: "claude-sdk" }] },
      };
      const path = writeYaml("num-team-name.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow("Config missing required field: team.name");
    });

    it("throws on empty team.agents array", async () => {
      const cfg = {
        ...minimalConfig(),
        team: { name: "team", agents: [] },
      };
      const path = writeYaml("empty-agents.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow("team.agents must be a non-empty array");
    });

    it("throws on missing team.agents entirely", async () => {
      const cfg = {
        ...minimalConfig(),
        team: { name: "team" },
      };
      const path = writeYaml("no-agents.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow("team.agents must be a non-empty array");
    });

    it("throws on agent without name", async () => {
      const cfg = {
        ...minimalConfig(),
        team: {
          name: "team",
          agents: [{ adapter: "claude-sdk" }],
        },
      };
      const path = writeYaml("agent-no-name.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow("Each agent must have a name");
    });

    it("defaults adapter to 'native' when not specified", async () => {
      const cfg = {
        ...minimalConfig(),
        team: {
          name: "team",
          agents: [{ name: "orphan" }],
        },
      };
      const path = writeYaml("agent-no-adapter.yml", cfg);
      const parsed = await parseConfig(path);
      expect(parsed.team.agents[0].adapter).toBe("native");
    });

    it("throws on generic adapter without command", async () => {
      const cfg = {
        ...minimalConfig(),
        team: {
          name: "team",
          agents: [{ name: "runner", adapter: "generic" }],
        },
      };
      const path = writeYaml("generic-no-cmd.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow(
        'Agent "runner" uses generic adapter but has no command'
      );
    });

    it("throws on generic adapter with non-string command", async () => {
      const cfg = {
        ...minimalConfig(),
        team: {
          name: "team",
          agents: [{ name: "runner", adapter: "generic", command: 42 }],
        },
      };
      const path = writeYaml("generic-num-cmd.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow(
        'Agent "runner" uses generic adapter but has no command'
      );
    });

    it("throws on empty tasks array", async () => {
      const cfg = { ...minimalConfig(), tasks: [] };
      const path = writeYaml("empty-tasks.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow("tasks must be a non-empty array");
    });

    it("throws on missing tasks field", async () => {
      const cfg = { ...minimalConfig() } as Record<string, unknown>;
      delete cfg.tasks;
      const path = writeYaml("no-tasks.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow("tasks must be a non-empty array");
    });

    it("throws on task without id", async () => {
      const cfg = {
        ...minimalConfig(),
        tasks: [
          { title: "No ID", description: "Missing id", assignTo: "agent-1" },
        ],
      };
      const path = writeYaml("task-no-id.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow("Each task must have an id");
    });

    it("throws on task without title", async () => {
      const cfg = {
        ...minimalConfig(),
        tasks: [
          { id: "t1", description: "Has desc", assignTo: "agent-1" },
        ],
      };
      const path = writeYaml("task-no-title.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow('Task "t1" missing required field: title');
    });

    it("throws on task without description", async () => {
      const cfg = {
        ...minimalConfig(),
        tasks: [
          { id: "t1", title: "Has title", assignTo: "agent-1" },
        ],
      };
      const path = writeYaml("task-no-desc.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow(
        'Task "t1" missing required field: description'
      );
    });

    it("throws on task without assignTo", async () => {
      const cfg = {
        ...minimalConfig(),
        tasks: [
          { id: "t1", title: "Has title", description: "Has desc" },
        ],
      };
      const path = writeYaml("task-no-assign.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow(
        'Task "t1" missing required field: assignTo'
      );
    });

    it("throws on invalid logLevel", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: { logLevel: "debug" },
      };
      const path = writeYaml("bad-loglevel.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow(
        'Invalid logLevel "debug": must be quiet, normal, or verbose'
      );
    });

    it("throws on another invalid logLevel value", async () => {
      const cfg = {
        ...minimalConfig(),
        settings: { logLevel: "trace" },
      };
      const path = writeYaml("bad-loglevel-trace.yml", cfg);
      await expect(parseConfig(path)).rejects.toThrow(
        'Invalid logLevel "trace": must be quiet, normal, or verbose'
      );
    });
  });
});

describe("generateTemplate", () => {
  beforeEach(() => {
    mkdirSync(TMP, { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it("returns a non-empty string", () => {
    const template = generateTemplate();
    expect(typeof template).toBe("string");
    expect(template.length).toBeGreaterThan(0);
  });

  it("returns valid YAML", () => {
    const template = generateTemplate();
    const parsed = parse(template);
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe("object");
  });

  it("template contains version, project, team, and tasks", () => {
    const template = generateTemplate();
    const doc = parse(template);
    expect(doc.version).toBeDefined();
    expect(doc.project).toBeDefined();
    expect(doc.team).toBeDefined();
    expect(doc.tasks).toBeDefined();
  });

  it("template has expected default values", () => {
    const template = generateTemplate();
    const doc = parse(template);
    expect(doc.version).toBe("1");
    expect(doc.project).toBe("my-project");
    expect(doc.team.name).toBe("default");
    expect(doc.team.agents).toHaveLength(2);
    expect(doc.tasks).toHaveLength(1);
    expect(doc.settings).toBeDefined();
    expect(doc.settings.maxRetries).toBe(3);
    expect(doc.settings.logLevel).toBe("normal");
    expect(doc.settings.workDir).toBe(".");
  });

  it("template round-trips through parseConfig", async () => {
    const template = generateTemplate();
    const path = join(TMP, "round-trip.yml");
    writeFileSync(path, template);

    const config = await parseConfig(path);

    expect(config.version).toBe("1");
    expect(config.project).toBe("my-project");
    expect(config.team.name).toBe("default");
    expect(config.team.agents).toHaveLength(2);
    expect(config.team.agents[0].name).toBe("coder");
    expect(config.team.agents[1].name).toBe("reviewer");
    expect(config.tasks).toHaveLength(1);
    expect(config.tasks[0].id).toBe("task-1");
    expect(config.tasks[0].title).toBe("Implement feature");
    expect(config.settings.maxRetries).toBe(3);
    expect(config.settings.logLevel).toBe("normal");
  });
});

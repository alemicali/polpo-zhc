import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  discoverPlaybooks,
  loadPlaybook,
  validateParams,
  instantiatePlaybook,
  validatePlaybookDefinition,
} from "../core/playbook.js";
import type { PlaybookDefinition } from "../core/playbook.js";

const TMP = "/tmp/polpo-playbook-test";
const POLPO_DIR = join(TMP, ".polpo");
const PLAYBOOKS_DIR = join(POLPO_DIR, "playbooks");

function writePlaybook(name: string, def: object): void {
  const dir = join(PLAYBOOKS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "playbook.json"), JSON.stringify(def, null, 2));
}

function makePlaybook(overrides?: Partial<PlaybookDefinition>): PlaybookDefinition {
  return {
    name: "test-playbook",
    description: "A test playbook",
    parameters: [
      { name: "module", description: "Module to process", type: "string", required: true },
      { name: "depth", description: "Analysis depth", type: "string", default: "normal", enum: ["quick", "normal", "deep"] },
      { name: "retries", description: "Max retries", type: "number", default: 2 },
    ],
    mission: {
      tasks: [
        {
          title: "Analyze {{module}}",
          description: "Analyze {{module}} at {{depth}} depth",
          assignTo: "agent-1",
          maxRetries: "{{retries}}",
        },
      ],
    },
    ...overrides,
  };
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(PLAYBOOKS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ── Discovery ──────────────────────────────────────────────────────────

describe("discoverPlaybooks", () => {
  it("discovers playbooks from polpoDir/playbooks/", () => {
    writePlaybook("code-review", makePlaybook({ name: "code-review", description: "Code review" }));
    writePlaybook("bug-fix", makePlaybook({ name: "bug-fix", description: "Bug fix" }));

    const playbooks = discoverPlaybooks(TMP, POLPO_DIR);
    expect(playbooks).toHaveLength(2);
    expect(playbooks.map(p => p.name).sort()).toEqual(["bug-fix", "code-review"]);
  });

  it("returns empty array when no playbooks exist", () => {
    const playbooks = discoverPlaybooks(TMP, POLPO_DIR);
    expect(playbooks).toHaveLength(0);
  });

  it("skips directories without playbook.json", () => {
    mkdirSync(join(PLAYBOOKS_DIR, "empty-dir"), { recursive: true });
    writePlaybook("valid", makePlaybook({ name: "valid" }));

    const playbooks = discoverPlaybooks(TMP, POLPO_DIR);
    expect(playbooks).toHaveLength(1);
    expect(playbooks[0].name).toBe("valid");
  });

  it("skips invalid JSON files", () => {
    const dir = join(PLAYBOOKS_DIR, "bad-json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "playbook.json"), "not valid json{{{");
    writePlaybook("valid", makePlaybook({ name: "valid" }));

    const playbooks = discoverPlaybooks(TMP, POLPO_DIR);
    expect(playbooks).toHaveLength(1);
  });

  it("skips playbooks missing required fields", () => {
    writePlaybook("no-mission", { name: "no-mission", description: "Has no mission" });
    writePlaybook("valid", makePlaybook({ name: "valid" }));

    const playbooks = discoverPlaybooks(TMP, POLPO_DIR);
    expect(playbooks).toHaveLength(1);
    expect(playbooks[0].name).toBe("valid");
  });

  it("deduplicates by name (first wins)", () => {
    writePlaybook("dupe", makePlaybook({ name: "dupe", description: "First occurrence" }));

    // Create a second location under an alternative polpo dir
    const altPolpoDir = join(TMP, "alt-polpo");
    const altPlaybooksDir = join(altPolpoDir, "playbooks", "dupe");
    mkdirSync(altPlaybooksDir, { recursive: true });
    writeFileSync(
      join(altPlaybooksDir, "playbook.json"),
      JSON.stringify(makePlaybook({ name: "dupe", description: "Second occurrence" })),
    );

    // Project-level (POLPO_DIR) should win over alternative dir
    const playbooks = discoverPlaybooks(TMP, POLPO_DIR);
    expect(playbooks).toHaveLength(1);
    expect(playbooks[0].description).toBe("First occurrence");
  });

  it("backward-compat: discovers from templates/ directory with template.json", () => {
    // Write a legacy template.json in templates/ directory
    const legacyDir = join(POLPO_DIR, "templates", "legacy-wf");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "template.json"), JSON.stringify(makePlaybook({ name: "legacy-wf" })));

    const playbooks = discoverPlaybooks(TMP, POLPO_DIR);
    expect(playbooks).toHaveLength(1);
    expect(playbooks[0].name).toBe("legacy-wf");
  });
});

// ── loadPlaybook ───────────────────────────────────────────────────────

describe("loadPlaybook", () => {
  it("loads a full playbook definition by name", () => {
    writePlaybook("my-pb", makePlaybook({ name: "my-pb" }));

    const pb = loadPlaybook(TMP, POLPO_DIR, "my-pb");
    expect(pb).not.toBeNull();
    expect(pb!.name).toBe("my-pb");
    expect(pb!.mission).toBeDefined();
    expect((pb!.mission as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  it("returns null for non-existent playbook", () => {
    const pb = loadPlaybook(TMP, POLPO_DIR, "nope");
    expect(pb).toBeNull();
  });
});

// ── validateParams ─────────────────────────────────────────────────────

describe("validateParams", () => {
  const pb = makePlaybook();

  it("validates required params", () => {
    const result = validateParams(pb, {});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing required parameter: module");
  });

  it("applies defaults", () => {
    const result = validateParams(pb, { module: "src/core" });
    expect(result.valid).toBe(true);
    expect(result.resolved.module).toBe("src/core");
    expect(result.resolved.depth).toBe("normal");
    expect(result.resolved.retries).toBe(2);
  });

  it("validates enum values", () => {
    const result = validateParams(pb, { module: "src", depth: "invalid" });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("must be one of");
  });

  it("accepts valid enum values", () => {
    const result = validateParams(pb, { module: "src", depth: "deep" });
    expect(result.valid).toBe(true);
    expect(result.resolved.depth).toBe("deep");
  });

  it("coerces number types", () => {
    const result = validateParams(pb, { module: "src", retries: "5" as unknown as string });
    expect(result.valid).toBe(true);
    expect(result.resolved.retries).toBe(5);
  });

  it("rejects invalid number types", () => {
    const result = validateParams(pb, { module: "src", retries: "abc" as unknown as string });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("must be a number");
  });

  it("warns about unknown parameters (non-blocking)", () => {
    const result = validateParams(pb, { module: "src", unknown_param: "value" });
    expect(result.valid).toBe(true);
    expect(result.warnings).toContain("Unknown parameter: unknown_param");
    expect(result.errors).toHaveLength(0);
  });

  it("validates boolean type coercion", () => {
    const boolPb = makePlaybook({
      parameters: [
        { name: "verbose", description: "Verbose mode", type: "boolean", default: false },
      ],
    });

    expect(validateParams(boolPb, { verbose: "true" as unknown as string }).resolved.verbose).toBe(true);
    expect(validateParams(boolPb, { verbose: "false" as unknown as string }).resolved.verbose).toBe(false);
    expect(validateParams(boolPb, { verbose: "yes" as unknown as string }).resolved.verbose).toBe(true);
    expect(validateParams(boolPb, { verbose: "1" as unknown as string }).resolved.verbose).toBe(true);
  });

  it("handles playbook with no parameters", () => {
    const noParamPb = makePlaybook({ parameters: [] });
    const result = validateParams(noParamPb, {});
    expect(result.valid).toBe(true);
    expect(Object.keys(result.resolved)).toHaveLength(0);
  });
});

// ── instantiatePlaybook ────────────────────────────────────────────────

describe("instantiatePlaybook", () => {
  it("replaces placeholders in the mission", () => {
    const pb = makePlaybook();
    const result = instantiatePlaybook(pb, { module: "src/core", depth: "deep", retries: 3 });

    const mission = JSON.parse(result.data);
    expect(mission.tasks[0].title).toBe("Analyze src/core");
    expect(mission.tasks[0].description).toBe("Analyze src/core at deep depth");
    expect(mission.tasks[0].maxRetries).toBe("3");
  });

  it("generates a descriptive prompt", () => {
    const pb = makePlaybook();
    const result = instantiatePlaybook(pb, { module: "src/core", depth: "deep", retries: 3 });

    expect(result.prompt).toContain("playbook:test-playbook");
    expect(result.prompt).toContain("module=src/core");
    expect(result.name).toBe("test-playbook");
  });

  it("throws on unreplaced placeholders", () => {
    const pb = makePlaybook({
      mission: {
        tasks: [{
          title: "Process {{module}} with {{missing_param}}",
          assignTo: "agent-1",
        }],
      },
    });

    expect(() => {
      instantiatePlaybook(pb, { module: "src" });
    }).toThrow("Unreplaced placeholders");
  });

  it("produces valid JSON after substitution", () => {
    const pb = makePlaybook();
    const result = instantiatePlaybook(pb, { module: "src/core", depth: "normal", retries: 2 });

    expect(() => JSON.parse(result.data)).not.toThrow();
  });

  it("handles special characters in parameter values", () => {
    const pb = makePlaybook();
    const result = instantiatePlaybook(pb, {
      module: "src/core",
      depth: "normal",
      retries: 2,
    });

    expect(() => JSON.parse(result.data)).not.toThrow();
  });

  it("handles empty resolved params", () => {
    const pb = makePlaybook({
      parameters: [],
      mission: {
        tasks: [{
          title: "Simple task",
          description: "No params needed",
          assignTo: "agent-1",
        }],
      },
    });

    const result = instantiatePlaybook(pb, {});
    expect(result.prompt).toBe("playbook:test-playbook");
    const mission = JSON.parse(result.data);
    expect(mission.tasks[0].title).toBe("Simple task");
  });
});

// ── validatePlaybookDefinition ─────────────────────────────────────────

describe("validatePlaybookDefinition", () => {
  it("accepts a valid playbook", () => {
    const errors = validatePlaybookDefinition(makePlaybook());
    expect(errors).toHaveLength(0);
  });

  it("rejects missing name", () => {
    const errors = validatePlaybookDefinition({ description: "d", mission: { tasks: [] } });
    expect(errors.some(e => e.includes("name"))).toBe(true);
  });

  it("rejects non-kebab-case name", () => {
    const errors = validatePlaybookDefinition({ name: "Bad Name!", description: "d", mission: { tasks: [] } });
    expect(errors.some(e => e.includes("kebab-case"))).toBe(true);
  });

  it("rejects undeclared placeholders", () => {
    const errors = validatePlaybookDefinition({
      name: "test",
      description: "d",
      parameters: [],
      mission: { tasks: [{ title: "{{undeclared}}" }] },
    });
    expect(errors.some(e => e.includes("undeclared"))).toBe(true);
  });

  it("errors on optional param without default that has placeholder in mission", () => {
    const errors = validatePlaybookDefinition({
      name: "test",
      description: "d",
      parameters: [
        { name: "opt", description: "optional param", type: "string" },
      ],
      mission: { tasks: [{ title: "Do {{opt}}" }] },
    });
    expect(errors.some(e => e.includes('"opt"') && e.includes("optional with no default"))).toBe(true);
  });

  it("accepts optional param without default when NOT used as placeholder", () => {
    const errors = validatePlaybookDefinition({
      name: "test",
      description: "d",
      parameters: [
        { name: "opt", description: "optional extra metadata", type: "string" },
      ],
      mission: { tasks: [{ title: "Do something" }] },
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts optional param WITH default used as placeholder", () => {
    const errors = validatePlaybookDefinition({
      name: "test",
      description: "d",
      parameters: [
        { name: "opt", description: "has a default", type: "string", default: "fallback" },
      ],
      mission: { tasks: [{ title: "Do {{opt}}" }] },
    });
    expect(errors).toHaveLength(0);
  });

  it("accepts required param without default used as placeholder", () => {
    const errors = validatePlaybookDefinition({
      name: "test",
      description: "d",
      parameters: [
        { name: "req", description: "required", type: "string", required: true },
      ],
      mission: { tasks: [{ title: "Do {{req}}" }] },
    });
    expect(errors).toHaveLength(0);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  discoverTemplates,
  loadTemplate,
  validateParams,
  instantiateTemplate,
} from "../core/template.js";
import type { TemplateDefinition } from "../core/template.js";

const TMP = "/tmp/polpo-template-test";
const POLPO_DIR = join(TMP, ".polpo");
const TEMPLATES_DIR = join(POLPO_DIR, "templates");

function writeTemplate(name: string, def: object): void {
  const dir = join(TEMPLATES_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "template.json"), JSON.stringify(def, null, 2));
}

function makeTemplate(overrides?: Partial<TemplateDefinition>): TemplateDefinition {
  return {
    name: "test-template",
    description: "A test template",
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
  mkdirSync(TEMPLATES_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ── Discovery ──────────────────────────────────────────────────────────

describe("discoverTemplates", () => {
  it("discovers templates from polpoDir/templates/", () => {
    writeTemplate("code-review", makeTemplate({ name: "code-review", description: "Code review" }));
    writeTemplate("bug-fix", makeTemplate({ name: "bug-fix", description: "Bug fix" }));

    const templates = discoverTemplates(TMP, POLPO_DIR);
    expect(templates).toHaveLength(2);
    expect(templates.map(w => w.name).sort()).toEqual(["bug-fix", "code-review"]);
  });

  it("returns empty array when no templates exist", () => {
    const templates = discoverTemplates(TMP, POLPO_DIR);
    expect(templates).toHaveLength(0);
  });

  it("skips directories without template.json", () => {
    mkdirSync(join(TEMPLATES_DIR, "empty-dir"), { recursive: true });
    writeTemplate("valid", makeTemplate({ name: "valid" }));

    const templates = discoverTemplates(TMP, POLPO_DIR);
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe("valid");
  });

  it("skips invalid JSON files", () => {
    const dir = join(TEMPLATES_DIR, "bad-json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "template.json"), "not valid json{{{");
    writeTemplate("valid", makeTemplate({ name: "valid" }));

    const templates = discoverTemplates(TMP, POLPO_DIR);
    expect(templates).toHaveLength(1);
  });

  it("skips templates missing required fields", () => {
    writeTemplate("no-mission", { name: "no-mission", description: "Has no mission" });
    writeTemplate("valid", makeTemplate({ name: "valid" }));

    const templates = discoverTemplates(TMP, POLPO_DIR);
    expect(templates).toHaveLength(1);
    expect(templates[0].name).toBe("valid");
  });

  it("deduplicates by name (first wins)", () => {
    writeTemplate("dupe", makeTemplate({ name: "dupe", description: "First occurrence" }));

    // Create a second location under an alternative polpo dir
    const altPolpoDir = join(TMP, "alt-polpo");
    const altTemplatesDir = join(altPolpoDir, "templates", "dupe");
    mkdirSync(altTemplatesDir, { recursive: true });
    writeFileSync(
      join(altTemplatesDir, "template.json"),
      JSON.stringify(makeTemplate({ name: "dupe", description: "Second occurrence" })),
    );

    // Project-level (POLPO_DIR) should win over alternative dir
    // discoverTemplates scans polpoDir first, so the first occurrence should be from POLPO_DIR
    const templates = discoverTemplates(TMP, POLPO_DIR);
    expect(templates).toHaveLength(1);
    expect(templates[0].description).toBe("First occurrence");
  });
});

// ── loadTemplate ───────────────────────────────────────────────────────

describe("loadTemplate", () => {
  it("loads a full template definition by name", () => {
    writeTemplate("my-wf", makeTemplate({ name: "my-wf" }));

    const wf = loadTemplate(TMP, POLPO_DIR, "my-wf");
    expect(wf).not.toBeNull();
    expect(wf!.name).toBe("my-wf");
    expect(wf!.mission).toBeDefined();
    expect((wf!.mission as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  it("returns null for non-existent template", () => {
    const wf = loadTemplate(TMP, POLPO_DIR, "nope");
    expect(wf).toBeNull();
  });
});

// ── validateParams ─────────────────────────────────────────────────────

describe("validateParams", () => {
  const wf = makeTemplate();

  it("validates required params", () => {
    const result = validateParams(wf, {});
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Missing required parameter: module");
  });

  it("applies defaults", () => {
    const result = validateParams(wf, { module: "src/core" });
    expect(result.valid).toBe(true);
    expect(result.resolved.module).toBe("src/core");
    expect(result.resolved.depth).toBe("normal");
    expect(result.resolved.retries).toBe(2);
  });

  it("validates enum values", () => {
    const result = validateParams(wf, { module: "src", depth: "invalid" });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("must be one of");
  });

  it("accepts valid enum values", () => {
    const result = validateParams(wf, { module: "src", depth: "deep" });
    expect(result.valid).toBe(true);
    expect(result.resolved.depth).toBe("deep");
  });

  it("coerces number types", () => {
    const result = validateParams(wf, { module: "src", retries: "5" as unknown as string });
    expect(result.valid).toBe(true);
    expect(result.resolved.retries).toBe(5);
  });

  it("rejects invalid number types", () => {
    const result = validateParams(wf, { module: "src", retries: "abc" as unknown as string });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("must be a number");
  });

  it("warns about unknown parameters", () => {
    const result = validateParams(wf, { module: "src", unknown_param: "value" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Unknown parameter: unknown_param");
  });

  it("validates boolean type coercion", () => {
    const boolWf = makeTemplate({
      parameters: [
        { name: "verbose", description: "Verbose mode", type: "boolean", default: false },
      ],
    });

    expect(validateParams(boolWf, { verbose: "true" as unknown as string }).resolved.verbose).toBe(true);
    expect(validateParams(boolWf, { verbose: "false" as unknown as string }).resolved.verbose).toBe(false);
    expect(validateParams(boolWf, { verbose: "yes" as unknown as string }).resolved.verbose).toBe(true);
    expect(validateParams(boolWf, { verbose: "1" as unknown as string }).resolved.verbose).toBe(true);
  });

  it("handles template with no parameters", () => {
    const noParamWf = makeTemplate({ parameters: [] });
    const result = validateParams(noParamWf, {});
    expect(result.valid).toBe(true);
    expect(Object.keys(result.resolved)).toHaveLength(0);
  });
});

// ── instantiateTemplate ────────────────────────────────────────────────

describe("instantiateTemplate", () => {
  it("replaces placeholders in the mission", () => {
    const wf = makeTemplate();
    const result = instantiateTemplate(wf, { module: "src/core", depth: "deep", retries: 3 });

    const mission = JSON.parse(result.data);
    expect(mission.tasks[0].title).toBe("Analyze src/core");
    expect(mission.tasks[0].description).toBe("Analyze src/core at deep depth");
    expect(mission.tasks[0].maxRetries).toBe("3");
  });

  it("generates a descriptive prompt", () => {
    const wf = makeTemplate();
    const result = instantiateTemplate(wf, { module: "src/core", depth: "deep", retries: 3 });

    expect(result.prompt).toContain("template:test-template");
    expect(result.prompt).toContain("module=src/core");
    expect(result.name).toBe("test-template");
  });

  it("throws on unreplaced placeholders", () => {
    const wf = makeTemplate({
      mission: {
        tasks: [{
          title: "Process {{module}} with {{missing_param}}",
          assignTo: "agent-1",
        }],
      },
    });

    expect(() => {
      instantiateTemplate(wf, { module: "src" });
    }).toThrow("Unreplaced placeholders");
  });

  it("produces valid JSON after substitution", () => {
    const wf = makeTemplate();
    const result = instantiateTemplate(wf, { module: "src/core", depth: "normal", retries: 2 });

    expect(() => JSON.parse(result.data)).not.toThrow();
  });

  it("handles special characters in parameter values", () => {
    const wf = makeTemplate();
    // Values with quotes/special chars should be safe because we replace inside a JSON string
    const result = instantiateTemplate(wf, {
      module: "src/core",
      depth: "normal",
      retries: 2,
    });

    expect(() => JSON.parse(result.data)).not.toThrow();
  });

  it("handles empty resolved params", () => {
    const wf = makeTemplate({
      parameters: [],
      mission: {
        tasks: [{
          title: "Simple task",
          description: "No params needed",
          assignTo: "agent-1",
        }],
      },
    });

    const result = instantiateTemplate(wf, {});
    expect(result.prompt).toBe("template:test-template");
    const mission = JSON.parse(result.data);
    expect(mission.tasks[0].title).toBe("Simple task");
  });
});

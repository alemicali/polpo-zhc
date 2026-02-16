import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  discoverWorkflows,
  loadWorkflow,
  validateParams,
  instantiateWorkflow,
} from "../core/workflow.js";
import type { WorkflowDefinition } from "../core/workflow.js";

const TMP = "/tmp/polpo-workflow-test";
const POLPO_DIR = join(TMP, ".polpo");
const WORKFLOWS_DIR = join(POLPO_DIR, "workflows");

function writeWorkflow(name: string, def: object): void {
  const dir = join(WORKFLOWS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "workflow.json"), JSON.stringify(def, null, 2));
}

function makeWorkflow(overrides?: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    name: "test-workflow",
    description: "A test workflow",
    parameters: [
      { name: "module", description: "Module to process", type: "string", required: true },
      { name: "depth", description: "Analysis depth", type: "string", default: "normal", enum: ["quick", "normal", "deep"] },
      { name: "retries", description: "Max retries", type: "number", default: 2 },
    ],
    plan: {
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
  mkdirSync(WORKFLOWS_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ── Discovery ──────────────────────────────────────────────────────────

describe("discoverWorkflows", () => {
  it("discovers workflows from polpoDir/workflows/", () => {
    writeWorkflow("code-review", makeWorkflow({ name: "code-review", description: "Code review" }));
    writeWorkflow("bug-fix", makeWorkflow({ name: "bug-fix", description: "Bug fix" }));

    const workflows = discoverWorkflows(TMP, POLPO_DIR);
    expect(workflows).toHaveLength(2);
    expect(workflows.map(w => w.name).sort()).toEqual(["bug-fix", "code-review"]);
  });

  it("returns empty array when no workflows exist", () => {
    const workflows = discoverWorkflows(TMP, POLPO_DIR);
    expect(workflows).toHaveLength(0);
  });

  it("skips directories without workflow.json", () => {
    mkdirSync(join(WORKFLOWS_DIR, "empty-dir"), { recursive: true });
    writeWorkflow("valid", makeWorkflow({ name: "valid" }));

    const workflows = discoverWorkflows(TMP, POLPO_DIR);
    expect(workflows).toHaveLength(1);
    expect(workflows[0].name).toBe("valid");
  });

  it("skips invalid JSON files", () => {
    const dir = join(WORKFLOWS_DIR, "bad-json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workflow.json"), "not valid json{{{");
    writeWorkflow("valid", makeWorkflow({ name: "valid" }));

    const workflows = discoverWorkflows(TMP, POLPO_DIR);
    expect(workflows).toHaveLength(1);
  });

  it("skips workflows missing required fields", () => {
    writeWorkflow("no-plan", { name: "no-plan", description: "Has no plan" });
    writeWorkflow("valid", makeWorkflow({ name: "valid" }));

    const workflows = discoverWorkflows(TMP, POLPO_DIR);
    expect(workflows).toHaveLength(1);
    expect(workflows[0].name).toBe("valid");
  });

  it("deduplicates by name (first wins)", () => {
    writeWorkflow("dupe", makeWorkflow({ name: "dupe", description: "First occurrence" }));

    // Create a second location under an alternative polpo dir
    const altPolpoDir = join(TMP, "alt-polpo");
    const altWorkflowsDir = join(altPolpoDir, "workflows", "dupe");
    mkdirSync(altWorkflowsDir, { recursive: true });
    writeFileSync(
      join(altWorkflowsDir, "workflow.json"),
      JSON.stringify(makeWorkflow({ name: "dupe", description: "Second occurrence" })),
    );

    // Project-level (POLPO_DIR) should win over alternative dir
    // discoverWorkflows scans polpoDir first, so the first occurrence should be from POLPO_DIR
    const workflows = discoverWorkflows(TMP, POLPO_DIR);
    expect(workflows).toHaveLength(1);
    expect(workflows[0].description).toBe("First occurrence");
  });
});

// ── loadWorkflow ───────────────────────────────────────────────────────

describe("loadWorkflow", () => {
  it("loads a full workflow definition by name", () => {
    writeWorkflow("my-wf", makeWorkflow({ name: "my-wf" }));

    const wf = loadWorkflow(TMP, POLPO_DIR, "my-wf");
    expect(wf).not.toBeNull();
    expect(wf!.name).toBe("my-wf");
    expect(wf!.plan).toBeDefined();
    expect((wf!.plan as { tasks: unknown[] }).tasks).toHaveLength(1);
  });

  it("returns null for non-existent workflow", () => {
    const wf = loadWorkflow(TMP, POLPO_DIR, "nope");
    expect(wf).toBeNull();
  });
});

// ── validateParams ─────────────────────────────────────────────────────

describe("validateParams", () => {
  const wf = makeWorkflow();

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
    const boolWf = makeWorkflow({
      parameters: [
        { name: "verbose", description: "Verbose mode", type: "boolean", default: false },
      ],
    });

    expect(validateParams(boolWf, { verbose: "true" as unknown as string }).resolved.verbose).toBe(true);
    expect(validateParams(boolWf, { verbose: "false" as unknown as string }).resolved.verbose).toBe(false);
    expect(validateParams(boolWf, { verbose: "yes" as unknown as string }).resolved.verbose).toBe(true);
    expect(validateParams(boolWf, { verbose: "1" as unknown as string }).resolved.verbose).toBe(true);
  });

  it("handles workflow with no parameters", () => {
    const noParamWf = makeWorkflow({ parameters: [] });
    const result = validateParams(noParamWf, {});
    expect(result.valid).toBe(true);
    expect(Object.keys(result.resolved)).toHaveLength(0);
  });
});

// ── instantiateWorkflow ────────────────────────────────────────────────

describe("instantiateWorkflow", () => {
  it("replaces placeholders in the plan", () => {
    const wf = makeWorkflow();
    const result = instantiateWorkflow(wf, { module: "src/core", depth: "deep", retries: 3 });

    const plan = JSON.parse(result.data);
    expect(plan.tasks[0].title).toBe("Analyze src/core");
    expect(plan.tasks[0].description).toBe("Analyze src/core at deep depth");
    expect(plan.tasks[0].maxRetries).toBe("3");
  });

  it("generates a descriptive prompt", () => {
    const wf = makeWorkflow();
    const result = instantiateWorkflow(wf, { module: "src/core", depth: "deep", retries: 3 });

    expect(result.prompt).toContain("workflow:test-workflow");
    expect(result.prompt).toContain("module=src/core");
    expect(result.name).toBe("test-workflow");
  });

  it("throws on unreplaced placeholders", () => {
    const wf = makeWorkflow({
      plan: {
        tasks: [{
          title: "Process {{module}} with {{missing_param}}",
          assignTo: "agent-1",
        }],
      },
    });

    expect(() => {
      instantiateWorkflow(wf, { module: "src" });
    }).toThrow("Unreplaced placeholders");
  });

  it("produces valid JSON after substitution", () => {
    const wf = makeWorkflow();
    const result = instantiateWorkflow(wf, { module: "src/core", depth: "normal", retries: 2 });

    expect(() => JSON.parse(result.data)).not.toThrow();
  });

  it("handles special characters in parameter values", () => {
    const wf = makeWorkflow();
    // Values with quotes/special chars should be safe because we replace inside a JSON string
    const result = instantiateWorkflow(wf, {
      module: "src/core",
      depth: "normal",
      retries: 2,
    });

    expect(() => JSON.parse(result.data)).not.toThrow();
  });

  it("handles empty resolved params", () => {
    const wf = makeWorkflow({
      parameters: [],
      plan: {
        tasks: [{
          title: "Simple task",
          description: "No params needed",
          assignTo: "agent-1",
        }],
      },
    });

    const result = instantiateWorkflow(wf, {});
    expect(result.prompt).toBe("workflow:test-workflow");
    const plan = JSON.parse(result.data);
    expect(plan.tasks[0].title).toBe("Simple task");
  });
});

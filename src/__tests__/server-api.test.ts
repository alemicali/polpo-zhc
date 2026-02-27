import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Orchestrator } from "../core/orchestrator.js";
// ── Test Setup ───────────────────────────────────────────────────────

const POLPO_CONFIG = JSON.stringify({
  project: "test-api",
  team: {
    name: "api-team",
    agents: [
      { name: "agent-1", role: "Test agent" },
    ],
  },
  settings: { maxRetries: 2, logLevel: "quiet" },
}, null, 2);

let tmpDir: string;
let app: Hono;
let orchestrator: Orchestrator;

/**
 * Build the full API path.
 * Routes are mounted at /api/v1/...
 */
function api(path: string): string {
  return `/api/v1${path}`;
}

/** Shorthand for JSON POST/PATCH/PUT requests. */
function jsonReq(
  method: string,
  body: unknown,
): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-api-test-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), POLPO_CONFIG);

  const { Orchestrator: OrchestratorClass } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");

  orchestrator = new OrchestratorClass(tmpDir);
  await orchestrator.initInteractive("test-api", {
    name: "api-team",
    agents: [{ name: "agent-1", role: "Test agent" }],
  });

  const sseBridge = new SSEBridge(orchestrator);
  sseBridge.start();

  // Create Hono app without API key auth
  app = createApp(orchestrator, sseBridge);
});

afterAll(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true });
  }
});

// ── Health ────────────────────────────────────────────────────────────

describe("Health", () => {
  test("GET /api/v1/health returns 200 with version and uptime", async () => {
    const res = await app.request("/api/v1/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("ok");
    expect(body.data).toHaveProperty("version");
    expect(body.data).toHaveProperty("uptime");
    expect(typeof body.data.uptime).toBe("number");
  });
});

// ── Tasks API ────────────────────────────────────────────────────────

describe("Tasks API", () => {
  test("GET /tasks returns 200 with task array", async () => {
    const res = await app.request(api("/tasks"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("POST /tasks creates a task (201)", async () => {
    const res = await app.request(
      api("/tasks"),
      jsonReq("POST", {
        title: "Integration test task",
        description: "Created via API test",
        assignTo: "agent-1",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.title).toBe("Integration test task");
    expect(body.data.description).toBe("Created via API test");
    expect(body.data.assignTo).toBe("agent-1");
    expect(body.data.status).toBe("pending");
    expect(body.data).toHaveProperty("id");
  });

  test("GET /tasks/:id returns 200 for existing task", async () => {
    // Create a task first
    const createRes = await app.request(
      api("/tasks"),
      jsonReq("POST", {
        title: "Fetch test",
        description: "For get-by-id",
        assignTo: "agent-1",
      }),
    );
    const created = await createRes.json();
    const taskId = created.data.id;

    const res = await app.request(api(`/tasks/${taskId}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe(taskId);
    expect(body.data.title).toBe("Fetch test");
  });

  test("GET /tasks/:id returns 404 for unknown ID", async () => {
    const res = await app.request(api("/tasks/nonexistent-id-12345"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("PATCH /tasks/:id updates task description", async () => {
    // Create task
    const createRes = await app.request(
      api("/tasks"),
      jsonReq("POST", {
        title: "Patch test",
        description: "Original desc",
        assignTo: "agent-1",
      }),
    );
    const created = await createRes.json();
    const taskId = created.data.id;

    // Patch it
    const res = await app.request(
      api(`/tasks/${taskId}`),
      jsonReq("PATCH", {
        description: "Updated desc",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.description).toBe("Updated desc");
  });

  test("DELETE /tasks/:id removes the task", async () => {
    // Create task
    const createRes = await app.request(
      api("/tasks"),
      jsonReq("POST", {
        title: "Delete me",
        description: "Will be deleted",
        assignTo: "agent-1",
      }),
    );
    const created = await createRes.json();
    const taskId = created.data.id;

    // Delete
    const res = await app.request(api(`/tasks/${taskId}`), { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.removed).toBe(true);

    // Verify it's gone
    const getRes = await app.request(api(`/tasks/${taskId}`));
    expect(getRes.status).toBe(404);
  });

  test("POST /tasks/:id/retry works on a failed task", async () => {
    // Create a task and transition it to failed via kill
    const createRes = await app.request(
      api("/tasks"),
      jsonReq("POST", {
        title: "Retry test",
        description: "Will be failed then retried",
        assignTo: "agent-1",
      }),
    );
    const created = await createRes.json();
    const taskId = created.data.id;

    // Kill the task to force it into failed state
    await app.request(api(`/tasks/${taskId}/kill`), { method: "POST" });

    // Verify it's failed
    const getRes = await app.request(api(`/tasks/${taskId}`));
    const task = await getRes.json();
    expect(task.data.status).toBe("failed");

    // Retry it
    const retryRes = await app.request(api(`/tasks/${taskId}/retry`), { method: "POST" });
    expect(retryRes.status).toBe(200);
    const retryBody = await retryRes.json();
    expect(retryBody.ok).toBe(true);
    expect(retryBody.data.retried).toBe(true);

    // Verify it went back to pending
    const afterRetry = await app.request(api(`/tasks/${taskId}`));
    const retried = await afterRetry.json();
    expect(retried.data.status).toBe("pending");
  });

  test("POST /tasks/:id/kill works on a pending task", async () => {
    const createRes = await app.request(
      api("/tasks"),
      jsonReq("POST", {
        title: "Kill test",
        description: "Will be killed",
        assignTo: "agent-1",
      }),
    );
    const created = await createRes.json();
    const taskId = created.data.id;

    const res = await app.request(api(`/tasks/${taskId}/kill`), { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.killed).toBe(true);
  });

  test("POST /tasks with missing title is rejected", async () => {
    const res = await app.request(
      api("/tasks"),
      jsonReq("POST", {
        description: "No title provided",
        assignTo: "agent-1",
      }),
    );
    // Validation error: must not succeed
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("POST /tasks with missing description is rejected", async () => {
    const res = await app.request(
      api("/tasks"),
      jsonReq("POST", {
        title: "Has title but no desc",
        assignTo: "agent-1",
      }),
    );
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("GET /tasks supports status filter", async () => {
    // Create a task (pending by default)
    await app.request(
      api("/tasks"),
      jsonReq("POST", {
        title: "Filter test",
        description: "Pending task for filter",
        assignTo: "agent-1",
      }),
    );

    const res = await app.request(api("/tasks?status=pending"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    for (const t of body.data) {
      expect(t.status).toBe("pending");
    }
  });
});

// ── Plans API ────────────────────────────────────────────────────────

describe("Plans API", () => {
  const PLAN_DATA = JSON.stringify({
    tasks: [
      { title: "Build feature", description: "Implement the new feature", assignTo: "agent-1" },
      { title: "Write tests", description: "Write tests for the feature", assignTo: "agent-1", dependsOn: ["Build feature"] },
    ],
  });

  test("GET /plans returns 200 with plan array", async () => {
    const res = await app.request(api("/plans"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("POST /plans creates a plan (201)", async () => {
    const res = await app.request(
      api("/plans"),
      jsonReq("POST", {
        data: PLAN_DATA,
        name: "test-plan-create",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty("id");
    expect(body.data.data).toBe(PLAN_DATA);
    expect(body.data.name).toBe("test-plan-create");
    expect(body.data.status).toBe("draft");
  });

  test("GET /plans/:id returns 200 for existing plan", async () => {
    // Create a plan first
    const createRes = await app.request(
      api("/plans"),
      jsonReq("POST", {
        data: PLAN_DATA,
        name: "test-plan-get",
      }),
    );
    const created = await createRes.json();
    const planId = created.data.id;

    const res = await app.request(api(`/plans/${planId}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe(planId);
    expect(body.data.name).toBe("test-plan-get");
  });

  test("GET /plans/:id returns 404 for unknown ID", async () => {
    const res = await app.request(api("/plans/nonexistent-plan-xyz"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("DELETE /plans/:id removes the plan", async () => {
    // Create a plan
    const createRes = await app.request(
      api("/plans"),
      jsonReq("POST", {
        data: PLAN_DATA,
        name: "test-plan-delete",
      }),
    );
    const created = await createRes.json();
    const planId = created.data.id;

    // Delete it
    const res = await app.request(api(`/plans/${planId}`), { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toBe(true);

    // Verify gone
    const getRes = await app.request(api(`/plans/${planId}`));
    expect(getRes.status).toBe(404);
  });

  test("POST /plans/:id/execute creates tasks from plan", async () => {
    // Create a plan
    const createRes = await app.request(
      api("/plans"),
      jsonReq("POST", {
        data: PLAN_DATA,
        name: "test-plan-execute",
      }),
    );
    const created = await createRes.json();
    const planId = created.data.id;

    // Execute it
    const res = await app.request(api(`/plans/${planId}/execute`), { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty("tasks");
    expect(body.data).toHaveProperty("group");
    expect(Array.isArray(body.data.tasks)).toBe(true);
    expect(body.data.tasks.length).toBe(2);
    expect(body.data.tasks[0].title).toBe("Build feature");
    expect(body.data.tasks[1].title).toBe("Write tests");
    // Second task should depend on the first
    expect(body.data.tasks[1].dependsOn).toContain(body.data.tasks[0].id);
  });

  test("POST /plans with empty data is rejected", async () => {
    const res = await app.request(
      api("/plans"),
      jsonReq("POST", {
        data: "",
      }),
    );
    // Validation error: must not succeed
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("PATCH /plans/:id updates plan status", async () => {
    // Create a plan
    const createRes = await app.request(
      api("/plans"),
      jsonReq("POST", {
        data: PLAN_DATA,
        name: "test-plan-patch",
      }),
    );
    const created = await createRes.json();
    const planId = created.data.id;

    // Patch status
    const res = await app.request(
      api(`/plans/${planId}`),
      jsonReq("PATCH", {
        status: "cancelled",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.status).toBe("cancelled");
  });
});

// ── Agents API ───────────────────────────────────────────────────────

describe("Agents API", () => {
  test("GET /agents returns 200 with agent array", async () => {
    const res = await app.request(api("/agents"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    // Should have at least agent-1 from config
    expect(body.data.length).toBeGreaterThanOrEqual(1);
    const agent1 = body.data.find((a: any) => a.name === "agent-1");
    expect(agent1).toBeDefined();
  });

  test("POST /agents adds a new agent (201)", async () => {
    const res = await app.request(
      api("/agents"),
      jsonReq("POST", {
        name: "agent-2",
        role: "helper",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.added).toBe(true);

    // Verify it's in the list
    const listRes = await app.request(api("/agents"));
    const listBody = await listRes.json();
    const agent2 = listBody.data.find((a: any) => a.name === "agent-2");
    expect(agent2).toBeDefined();
    expect(agent2.role).toBe("helper");
  });

  test("DELETE /agents/:name removes an agent", async () => {
    // First add a disposable agent
    await app.request(
      api("/agents"),
      jsonReq("POST", {
        name: "agent-disposable",
      }),
    );

    // Delete it
    const res = await app.request(api("/agents/agent-disposable"), { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.removed).toBe(true);

    // Verify it's gone
    const listRes = await app.request(api("/agents"));
    const listBody = await listRes.json();
    const gone = listBody.data.find((a: any) => a.name === "agent-disposable");
    expect(gone).toBeUndefined();
  });

  test("DELETE /agents/:name returns 404 for unknown agent", async () => {
    const res = await app.request(api("/agents/no-such-agent"), { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("GET /agents/team returns 200 with team info", async () => {
    const res = await app.request(api("/agents/team"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty("name");
    expect(body.data).toHaveProperty("agents");
    expect(body.data.name).toBe("api-team");
  });

  test("PATCH /agents/team renames the team", async () => {
    const res = await app.request(
      api("/agents/team"),
      jsonReq("PATCH", {
        oldName: "api-team",
        name: "renamed-team",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe("renamed-team");

    // Rename back to avoid affecting other tests
    await app.request(
      api("/agents/team"),
      jsonReq("PATCH", {
        oldName: "renamed-team",
        name: "api-team",
      }),
    );
  });

  test("POST /agents with missing name is rejected", async () => {
    const res = await app.request(
      api("/agents"),
      jsonReq("POST", {}),
    );
    // Validation error: must not succeed
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ── Memory API ───────────────────────────────────────────────────────

describe("Memory API", () => {
  test("GET /memory returns 200", async () => {
    const res = await app.request(api("/memory"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty("exists");
    expect(body.data).toHaveProperty("content");
  });

  test("PUT /memory saves content, verified by GET", async () => {
    const content = "# Test Memory\n\nThis is test memory content.";
    const putRes = await app.request(
      api("/memory"),
      jsonReq("PUT", { content }),
    );
    expect(putRes.status).toBe(200);
    const putBody = await putRes.json();
    expect(putBody.ok).toBe(true);
    expect(putBody.data.saved).toBe(true);

    // Verify with GET
    const getRes = await app.request(api("/memory"));
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.ok).toBe(true);
    expect(getBody.data.exists).toBe(true);
    expect(getBody.data.content).toBe(content);
  });

  test("PUT /memory with empty string clears memory", async () => {
    // First set something
    await app.request(
      api("/memory"),
      jsonReq("PUT", { content: "something" }),
    );

    // Clear it
    const res = await app.request(
      api("/memory"),
      jsonReq("PUT", { content: "" }),
    );
    expect(res.status).toBe(200);

    // Verify empty
    const getRes = await app.request(api("/memory"));
    const body = await getRes.json();
    expect(body.data.content).toBe("");
  });
});

// ── State routes ─────────────────────────────────────────────────────

describe("State routes", () => {
  test("GET /state returns full state snapshot", async () => {
    const res = await app.request(api("/state"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty("project");
    expect(body.data).toHaveProperty("teams");
    expect(typeof body.data.project).toBe("string");
  });

  test("GET /orchestrator-config returns orchestrator config", async () => {
    const res = await app.request(api("/orchestrator-config"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty("version");
    expect(body.data).toHaveProperty("project");
    expect(body.data).toHaveProperty("teams");
    expect(body.data).toHaveProperty("settings");
  });
});

// ── Agents Detail & Processes ────────────────────────────────────────

describe("Agents Detail API", () => {
  test("GET /agents/:name returns 200 for existing agent", async () => {
    const res = await app.request(api("/agents/agent-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe("agent-1");
    expect(body.data.role).toBe("Test agent");
  });

  test("GET /agents/:name returns 404 for unknown agent", async () => {
    const res = await app.request(api("/agents/nonexistent-agent"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("GET /agents/processes returns 200 with empty array", async () => {
    const res = await app.request(api("/agents/processes"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("GET /agents/processes/:taskId/activity returns 200 with empty array for unknown task", async () => {
    const res = await app.request(api("/agents/processes/nonexistent-task/activity"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(0);
  });
});

// ── Plans Resume/Abort ───────────────────────────────────────────────

describe("Plans Resume/Abort API", () => {
  test("GET /plans/resumable returns 200 with array", async () => {
    const res = await app.request(api("/plans/resumable"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("POST /plans/:id/abort returns 404 for unknown plan", async () => {
    const res = await app.request(api("/plans/nonexistent-plan/abort"), { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("POST /plans/:id/abort aborts an executed plan's tasks", async () => {
    const PLAN_DATA = JSON.stringify({
      tasks: [
        { title: "Abort test 1", description: "Will be aborted", assignTo: "agent-1" },
        { title: "Abort test 2", description: "Will be aborted too", assignTo: "agent-1" },
      ],
    });

    // Create and execute plan
    const createRes = await app.request(
      api("/plans"),
      jsonReq("POST", { data: PLAN_DATA, name: "abort-test" }),
    );
    const created = await createRes.json();
    const planId = created.data.id;

    await app.request(api(`/plans/${planId}/execute`), { method: "POST" });

    // Abort
    const res = await app.request(api(`/plans/${planId}/abort`), { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.data.aborted).toBe("number");
    expect(body.data.aborted).toBeGreaterThanOrEqual(0);
  });

  test("POST /plans/:id/resume resumes an executed plan", async () => {
    const PLAN_DATA = JSON.stringify({
      tasks: [
        { title: "Resume test 1", description: "Task one", assignTo: "agent-1" },
        { title: "Resume test 2", description: "Task two", assignTo: "agent-1" },
      ],
    });

    // Create and execute plan
    const createRes = await app.request(
      api("/plans"),
      jsonReq("POST", { data: PLAN_DATA, name: "resume-test" }),
    );
    const created = await createRes.json();
    const planId = created.data.id;

    await app.request(api(`/plans/${planId}/execute`), { method: "POST" });

    // Resume with empty body
    const res = await app.request(
      api(`/plans/${planId}/resume`),
      jsonReq("POST", {}),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty("retried");
    expect(body.data).toHaveProperty("pending");
  });
});

// ── Config Reload ────────────────────────────────────────────────────

describe("Config Reload API", () => {
  test("POST /config/reload returns 200 with valid polpo.json", async () => {
    const res = await app.request(api("/config/reload"), { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.message).toContain("reloaded");
  });

  test("POST /config/reload returns 500 when polpo.json is invalid", async () => {
    // Corrupt the config file
    const configPath = join(tmpDir, ".polpo", "polpo.json");
    await writeFile(configPath, "NOT VALID JSON!!!");

    const res = await app.request(api("/config/reload"), { method: "POST" });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);

    // Restore the valid config
    await writeFile(configPath, POLPO_CONFIG);
    await app.request(api("/config/reload"), { method: "POST" });
  });
});

// ── Approvals API ────────────────────────────────────────────────────

describe("Approvals API", () => {
  test("GET /approvals returns 200 with empty array (no gates configured)", async () => {
    const res = await app.request(api("/approvals"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(0);
  });

  test("GET /approvals supports status filter", async () => {
    const res = await app.request(api("/approvals?status=pending"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("GET /approvals/:id returns 404 for nonexistent request", async () => {
    const res = await app.request(api("/approvals/nonexistent-id"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("POST /approvals/:id/approve returns 404 for nonexistent request", async () => {
    const res = await app.request(
      api("/approvals/nonexistent-id/approve"),
      jsonReq("POST", {}),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("POST /approvals/:id/reject returns 404 for nonexistent request", async () => {
    const res = await app.request(
      api("/approvals/nonexistent-id/reject"),
      jsonReq("POST", { feedback: "nope" }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
  });

  test("POST /approvals/:id/reject returns 400 when feedback is missing", async () => {
    const res = await app.request(
      api("/approvals/any-id/reject"),
      jsonReq("POST", { feedback: "" }),
    );
    // Zod validation rejects empty feedback (minLength 1)
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

// ── Notifications API ────────────────────────────────────────────────

describe("Notifications API", () => {
  test("GET /notifications returns 200 (no router = empty with message)", async () => {
    const res = await app.request(api("/notifications"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // Without notifications config, data is empty array
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("GET /notifications supports query filters", async () => {
    const res = await app.request(api("/notifications?status=sent&limit=10"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  test("GET /notifications/stats returns 200 with counts", async () => {
    const res = await app.request(api("/notifications/stats"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty("total");
    expect(body.data).toHaveProperty("sent");
    expect(body.data).toHaveProperty("failed");
    expect(body.data.total).toBe(0);
  });

  test("POST /notifications/send returns 400 when not configured", async () => {
    const res = await app.request(
      api("/notifications/send"),
      jsonReq("POST", {
        channel: "test",
        title: "Test",
        body: "Test body",
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_CONFIGURED");
  });
});

// ── Templates API ────────────────────────────────────────────────────

describe("Templates API", () => {
  test("GET /templates returns 200 with array", async () => {
    const res = await app.request(api("/templates"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("GET /templates/:name returns 404 for nonexistent template", async () => {
    const res = await app.request(api("/templates/nonexistent-wf"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("GET /templates/:name returns 200 for existing template", async () => {
    // Create a template in the temp dir
    const wfDir = join(tmpDir, ".polpo", "templates", "test-wf");
    await mkdir(wfDir, { recursive: true });
    await writeFile(join(wfDir, "template.json"), JSON.stringify({
      name: "test-wf",
      description: "A test template",
      plan: {
        tasks: [
          { title: "{{taskName}}", description: "Do the thing", assignTo: "agent-1" },
        ],
      },
      parameters: [
        { name: "taskName", description: "Name of the task", required: true },
      ],
    }));

    const res = await app.request(api("/templates/test-wf"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe("test-wf");
    expect(body.data.description).toBe("A test template");
    expect(Array.isArray(body.data.parameters)).toBe(true);
  });

  test("POST /templates/:name/run returns 404 for nonexistent template", async () => {
    const res = await app.request(
      api("/templates/nonexistent-wf/run"),
      jsonReq("POST", { params: {} }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("POST /templates/:name/run returns 400 when required params missing", async () => {
    const res = await app.request(
      api("/templates/test-wf/run"),
      jsonReq("POST", { params: {} }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  test("POST /templates/:name/run executes template with valid params (201)", async () => {
    const res = await app.request(
      api("/templates/test-wf/run"),
      jsonReq("POST", { params: { taskName: "Build feature X" } }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty("plan");
    expect(body.data).toHaveProperty("tasks");
    expect(body.data).toHaveProperty("group");
    expect(body.data.tasks).toBeGreaterThanOrEqual(1);
  });
});

// ── Skills API ───────────────────────────────────────────────────────

describe("Skills API", () => {
  test("GET /skills returns 200 with array", async () => {
    const res = await app.request(api("/skills"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("DELETE /skills/:name returns 404 for nonexistent skill", async () => {
    const res = await app.request(api("/skills/nonexistent-skill"), { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("POST /skills/:name/assign returns 404 for nonexistent skill", async () => {
    const res = await app.request(
      api("/skills/nonexistent-skill/assign"),
      jsonReq("POST", { agent: "agent-1" }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("skill lifecycle: install, list, assign, remove", async () => {
    // Create a mock skill source
    const sourceDir = join(tmpDir, "skill-source");
    await mkdir(join(sourceDir, "test-skill"), { recursive: true });
    await writeFile(join(sourceDir, "test-skill", "SKILL.md"), "---\nname: test-skill\ndescription: A test skill\n---\n\nDo things well.");

    // Install
    const installRes = await app.request(
      api("/skills/add"),
      jsonReq("POST", { source: sourceDir }),
    );
    expect(installRes.status).toBe(201);
    const installBody = await installRes.json();
    expect(installBody.ok).toBe(true);
    expect(installBody.data.installed.length).toBeGreaterThanOrEqual(1);

    // List — should include the installed skill
    const listRes = await app.request(api("/skills"));
    const listBody = await listRes.json();
    const skill = listBody.data.find((s: any) => s.name === "test-skill");
    expect(skill).toBeDefined();

    // Assign to agent
    const assignRes = await app.request(
      api("/skills/test-skill/assign"),
      jsonReq("POST", { agent: "agent-1" }),
    );
    expect(assignRes.status).toBe(200);
    const assignBody = await assignRes.json();
    expect(assignBody.ok).toBe(true);
    expect(assignBody.data.skill).toBe("test-skill");
    expect(assignBody.data.agent).toBe("agent-1");

    // Remove
    const removeRes = await app.request(api("/skills/test-skill"), { method: "DELETE" });
    expect(removeRes.status).toBe(200);
    const removeBody = await removeRes.json();
    expect(removeBody.ok).toBe(true);
    expect(removeBody.data.removed).toBe("test-skill");
  });
});

// ── Logs API ─────────────────────────────────────────────────────────

describe("Logs API", () => {
  test("GET /logs returns 200 with session array", async () => {
    const res = await app.request(api("/logs"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    // initInteractive starts a log session automatically
    expect(body.data.length).toBeGreaterThanOrEqual(1);
  });

  test("GET /logs/:sessionId returns 200 with entries for valid session", async () => {
    // Get the current session ID from the log store
    const logStore = orchestrator.getLogStore()!;
    const sessions = logStore.listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const sessionId = sessions[0].id;

    const res = await app.request(api(`/logs/${sessionId}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });
});

// ── Chat Sessions API ────────────────────────────────────────────────

describe("Chat Sessions API", () => {
  test("GET /chat/sessions returns 200 with sessions array", async () => {
    const res = await app.request(api("/chat/sessions"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty("sessions");
    expect(Array.isArray(body.data.sessions)).toBe(true);
  });

  test("GET /chat/sessions/:id/messages returns 404 for nonexistent session", async () => {
    const res = await app.request(api("/chat/sessions/nonexistent-session/messages"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("DELETE /chat/sessions/:id returns 404 for nonexistent session", async () => {
    const res = await app.request(api("/chat/sessions/nonexistent-session"), { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("session lifecycle: create, list, get messages, delete", async () => {
    // Seed a session via orchestrator (avoids LLM dependency)
    const sessionStore = orchestrator.getSessionStore()!;
    const sessionId = sessionStore.create("Test session");
    sessionStore.addMessage(sessionId, "user", "Hello from test");
    sessionStore.addMessage(sessionId, "assistant", "Hi! How can I help?");

    // List — should include our session
    const listRes = await app.request(api("/chat/sessions"));
    const listBody = await listRes.json();
    const session = listBody.data.sessions.find((s: any) => s.id === sessionId);
    expect(session).toBeDefined();

    // Get messages
    const msgRes = await app.request(api(`/chat/sessions/${sessionId}/messages`));
    expect(msgRes.status).toBe(200);
    const msgBody = await msgRes.json();
    expect(msgBody.ok).toBe(true);
    expect(msgBody.data).toHaveProperty("session");
    expect(msgBody.data).toHaveProperty("messages");
    expect(msgBody.data.messages.length).toBe(2);
    expect(msgBody.data.messages[0].role).toBe("user");
    expect(msgBody.data.messages[0].content).toBe("Hello from test");
    expect(msgBody.data.messages[1].role).toBe("assistant");

    // Delete
    const deleteRes = await app.request(api(`/chat/sessions/${sessionId}`), { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    const deleteBody = await deleteRes.json();
    expect(deleteBody.ok).toBe(true);
    expect(deleteBody.data.deleted).toBe(true);

    // Verify deleted
    const verifyRes = await app.request(api(`/chat/sessions/${sessionId}/messages`));
    expect(verifyRes.status).toBe(404);
  });
});

// ── OpenAPI Spec ─────────────────────────────────────────────────────

describe("OpenAPI Spec", () => {
  test("GET /api/v1/openapi.json returns valid OpenAPI 3.1 spec", async () => {
    const res = await app.request("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const spec = await res.json();
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info.title).toBe("Polpo API");
    expect(spec.paths).toBeDefined();
    expect(Object.keys(spec.paths).length).toBeGreaterThanOrEqual(40);
    // Security scheme should be present
    expect(spec.components.securitySchemes).toHaveProperty("bearerAuth");
  });
});

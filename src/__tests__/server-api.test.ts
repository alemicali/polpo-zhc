import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
// ── Test Setup ───────────────────────────────────────────────────────

const PROJECT_ID = "test-api";

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

/**
 * Build the full API path for per-project routes.
 * Routes are mounted at /api/v1/projects/:projectId/...
 */
function api(path: string): string {
  return `/api/v1/projects/${PROJECT_ID}${path}`;
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

  // Dynamically import server modules (ESM)
  const { ProjectManager } = await import("../server/project-manager.js");
  const { createApp } = await import("../server/app.js");

  const pm = new ProjectManager();
  pm.register({ id: PROJECT_ID, workDir: tmpDir });

  // Create Hono app without API key auth
  app = createApp(pm);
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
    expect(agent1.adapter).toBeUndefined();
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
        name: "api-team",
      }),
    );
  });

  test("POST /agents with missing name is rejected", async () => {
    const res = await app.request(
      api("/agents"),
      jsonReq("POST", {
        adapter: "generic",
      }),
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

// ── Project-level routes ─────────────────────────────────────────────

describe("Project routes", () => {
  test("GET /projects lists registered projects", async () => {
    const res = await app.request("/api/v1/projects");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    const proj = body.data.find((p: any) => p.id === PROJECT_ID);
    expect(proj).toBeDefined();
    // Project name comes from initInteractive or basename(workDir)
    expect(typeof proj.name).toBe("string");
    expect(proj.name.length).toBeGreaterThan(0);
  });

  test("GET /state returns full state snapshot", async () => {
    const res = await app.request(api("/state"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty("project");
    expect(body.data).toHaveProperty("team");
    expect(typeof body.data.project).toBe("string");
  });

  test("GET /config returns orchestrator config", async () => {
    const res = await app.request(api("/config"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty("version");
    expect(body.data).toHaveProperty("project");
    expect(body.data).toHaveProperty("team");
    expect(body.data).toHaveProperty("settings");
  });

  test("unknown project ID returns 404", async () => {
    const res = await app.request("/api/v1/projects/nonexistent/tasks");
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });
});

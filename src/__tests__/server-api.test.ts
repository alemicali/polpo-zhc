import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Orchestrator } from "../core/orchestrator.js";
// ── Test Setup ───────────────────────────────────────────────────────

const POLPO_CONFIG = JSON.stringify({
  org: "test-api",
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
}, 30_000);

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

// ── Missions API ─────────────────────────────────────────────────────

describe("Missions API", () => {
  const MISSION_DATA = JSON.stringify({
    tasks: [
      { title: "Build feature", description: "Implement the new feature", assignTo: "agent-1" },
      { title: "Write tests", description: "Write tests for the feature", assignTo: "agent-1", dependsOn: ["Build feature"] },
    ],
  });

  test("GET /missions returns 200 with mission array", async () => {
    const res = await app.request(api("/missions"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("POST /missions creates a mission (201)", async () => {
    const res = await app.request(
      api("/missions"),
      jsonReq("POST", {
        data: MISSION_DATA,
        name: "test-mission-create",
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty("id");
    expect(body.data.data).toBe(MISSION_DATA);
    expect(body.data.name).toBe("test-mission-create");
    expect(body.data.status).toBe("draft");
  });

  test("GET /missions/:id returns 200 for existing mission", async () => {
    // Create a mission first
    const createRes = await app.request(
      api("/missions"),
      jsonReq("POST", {
        data: MISSION_DATA,
        name: "test-mission-get",
      }),
    );
    const created = await createRes.json();
    const missionId = created.data.id;

    const res = await app.request(api(`/missions/${missionId}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe(missionId);
    expect(body.data.name).toBe("test-mission-get");
  });

  test("GET /missions/:id returns 404 for unknown ID", async () => {
    const res = await app.request(api("/missions/nonexistent-mission-xyz"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("DELETE /missions/:id removes the mission", async () => {
    // Create a mission
    const createRes = await app.request(
      api("/missions"),
      jsonReq("POST", {
        data: MISSION_DATA,
        name: "test-mission-delete",
      }),
    );
    const created = await createRes.json();
    const missionId = created.data.id;

    // Delete it
    const res = await app.request(api(`/missions/${missionId}`), { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toBe(true);

    // Verify gone
    const getRes = await app.request(api(`/missions/${missionId}`));
    expect(getRes.status).toBe(404);
  });

  test("POST /missions/:id/execute creates tasks from mission", async () => {
    // Create a mission
    const createRes = await app.request(
      api("/missions"),
      jsonReq("POST", {
        data: MISSION_DATA,
        name: "test-mission-execute",
      }),
    );
    const created = await createRes.json();
    const missionId = created.data.id;

    // Execute it
    const res = await app.request(api(`/missions/${missionId}/execute`), { method: "POST" });
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

  test("POST /missions with empty data is rejected", async () => {
    const res = await app.request(
      api("/missions"),
      jsonReq("POST", {
        data: "",
      }),
    );
    // Validation error: must not succeed
    expect(res.ok).toBe(false);
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  test("PATCH /missions/:id updates mission status", async () => {
    // Create a mission
    const createRes = await app.request(
      api("/missions"),
      jsonReq("POST", {
        data: MISSION_DATA,
        name: "test-mission-patch",
      }),
    );
    const created = await createRes.json();
    const missionId = created.data.id;

    // Patch status
    const res = await app.request(
      api(`/missions/${missionId}`),
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
    expect(body.data).toHaveProperty("org");
    expect(body.data).toHaveProperty("teams");
    expect(typeof body.data.org).toBe("string");
  });

  test("GET /orchestrator-config returns orchestrator config", async () => {
    const res = await app.request(api("/orchestrator-config"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toHaveProperty("version");
    expect(body.data).toHaveProperty("org");
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

// ── Missions Resume/Abort ────────────────────────────────────────────

describe("Missions Resume/Abort API", () => {
  test("GET /missions/resumable returns 200 with array", async () => {
    const res = await app.request(api("/missions/resumable"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("POST /missions/:id/abort returns 404 for unknown mission", async () => {
    const res = await app.request(api("/missions/nonexistent-mission/abort"), { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("POST /missions/:id/abort aborts an executed mission's tasks", async () => {
    const MISSION_DATA = JSON.stringify({
      tasks: [
        { title: "Abort test 1", description: "Will be aborted", assignTo: "agent-1" },
        { title: "Abort test 2", description: "Will be aborted too", assignTo: "agent-1" },
      ],
    });

    // Create and execute mission
    const createRes = await app.request(
      api("/missions"),
      jsonReq("POST", { data: MISSION_DATA, name: "abort-test" }),
    );
    const created = await createRes.json();
    const missionId = created.data.id;

    await app.request(api(`/missions/${missionId}/execute`), { method: "POST" });

    // Abort
    const res = await app.request(api(`/missions/${missionId}/abort`), { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.data.aborted).toBe("number");
    expect(body.data.aborted).toBeGreaterThanOrEqual(0);
  });

  test("POST /missions/:id/resume resumes an executed mission", async () => {
    const MISSION_DATA = JSON.stringify({
      tasks: [
        { title: "Resume test 1", description: "Task one", assignTo: "agent-1" },
        { title: "Resume test 2", description: "Task two", assignTo: "agent-1" },
      ],
    });

    // Create and execute mission
    const createRes = await app.request(
      api("/missions"),
      jsonReq("POST", { data: MISSION_DATA, name: "resume-test" }),
    );
    const created = await createRes.json();
    const missionId = created.data.id;

    await app.request(api(`/missions/${missionId}/execute`), { method: "POST" });

    // Resume with empty body
    const res = await app.request(
      api(`/missions/${missionId}/resume`),
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
      mission: {
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
    expect(body.data).toHaveProperty("mission");
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
    const sessions = await logStore.listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const sessionId = sessions[0].sessionId;

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
    const sessionId = await sessionStore.create("Test session");
    await sessionStore.addMessage(sessionId, "user", "Hello from test");
    await sessionStore.addMessage(sessionId, "assistant", "Hi! How can I help?");

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

// ── Update Agent API ─────────────────────────────────────────────────

describe("Update Agent API", () => {
  test("PATCH /agents/:name updates agent role", async () => {
    const res = await app.request(
      api("/agents/agent-1"),
      jsonReq("PATCH", { role: "Updated role" }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe("agent-1");
    expect(body.data.role).toBe("Updated role");

    // Restore
    await app.request(api("/agents/agent-1"), jsonReq("PATCH", { role: "Test agent" }));
  });

  test("PATCH /agents/:name returns 404 for unknown agent", async () => {
    const res = await app.request(
      api("/agents/no-such-agent"),
      jsonReq("PATCH", { role: "x" }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("PATCH /agents/:name updates multiple fields", async () => {
    // Add a temp agent
    await app.request(api("/agents"), jsonReq("POST", { name: "agent-update-test", role: "original" }));

    const res = await app.request(
      api("/agents/agent-update-test"),
      jsonReq("PATCH", {
        role: "new role",
        maxTurns: 10,
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.role).toBe("new role");
    expect(body.data.maxTurns).toBe(10);

    // Cleanup
    await app.request(api("/agents/agent-update-test"), { method: "DELETE" });
  });
});

// ── Force Fail Task API ──────────────────────────────────────────────

describe("Force Fail Task API", () => {
  test("POST /tasks/:id/force-fail transitions task to failed", async () => {
    const createRes = await app.request(
      api("/tasks"),
      jsonReq("POST", {
        title: "Force fail test",
        description: "Will be force-failed",
        assignTo: "agent-1",
      }),
    );
    const created = await createRes.json();
    const taskId = created.data.id;

    const res = await app.request(api(`/tasks/${taskId}/force-fail`), { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.failed).toBe(true);

    // Verify task is now failed
    const getRes = await app.request(api(`/tasks/${taskId}`));
    const task = await getRes.json();
    expect(task.data.status).toBe("failed");
  });

  test("POST /tasks/:id/force-fail returns 404 for unknown task", async () => {
    const res = await app.request(api("/tasks/nonexistent-id/force-fail"), { method: "POST" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });
});

// ── Bulk Delete Tasks API ────────────────────────────────────────────

describe("Bulk Delete Tasks API", () => {
  test("DELETE /tasks?status= removes tasks by status", async () => {
    // Create several tasks
    for (let i = 0; i < 3; i++) {
      await app.request(
        api("/tasks"),
        jsonReq("POST", {
          title: `Bulk del status ${i}`,
          description: "For bulk delete by status",
          assignTo: "agent-1",
        }),
      );
    }

    const res = await app.request(api("/tasks?status=pending"), { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.data.deleted).toBe("number");
    expect(body.data.deleted).toBeGreaterThanOrEqual(3);
  });

  test("DELETE /tasks?group= removes tasks by group", async () => {
    // Create tasks with a specific group via mission execution
    const missionData = JSON.stringify({
      tasks: [
        { title: "Bulk grp 1", description: "For bulk delete", assignTo: "agent-1" },
        { title: "Bulk grp 2", description: "For bulk delete", assignTo: "agent-1" },
      ],
    });
    const createRes = await app.request(
      api("/missions"),
      jsonReq("POST", { data: missionData, name: "bulk-delete-grp" }),
    );
    const mission = await createRes.json();
    await app.request(api(`/missions/${mission.data.id}/execute`), { method: "POST" });

    // Now delete by group
    const res = await app.request(api(`/tasks?group=bulk-delete-grp`), { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toBe(2);
  });

  test("DELETE /tasks without filter returns 400", async () => {
    const res = await app.request(api("/tasks"), { method: "DELETE" });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NO_FILTER");
  });
});

// ── Queue Task API ───────────────────────────────────────────────────

describe("Queue Task API", () => {
  test("POST /tasks/:id/queue transitions draft to pending", async () => {
    // Create a draft task
    const createRes = await app.request(
      api("/tasks"),
      jsonReq("POST", {
        title: "Queue test",
        description: "Draft task to queue",
        assignTo: "agent-1",
        draft: true,
      }),
    );
    const created = await createRes.json();
    const taskId = created.data.id;
    expect(created.data.status).toBe("draft");

    // Queue it
    const res = await app.request(api(`/tasks/${taskId}/queue`), { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.queued).toBe(true);

    // Verify it's now pending
    const getRes = await app.request(api(`/tasks/${taskId}`));
    const task = await getRes.json();
    expect(task.data.status).toBe("pending");
  });

  test("POST /tasks/:id/queue returns 404 for unknown task", async () => {
    const res = await app.request(api("/tasks/nonexistent-id/queue"), { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ── Watchers API ─────────────────────────────────────────────────────

describe("Watchers API", () => {
  test("GET /watchers returns 200 with array", async () => {
    const res = await app.request(api("/watchers"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("watcher lifecycle: create, list, delete", async () => {
    // Create a task to watch
    const taskRes = await app.request(
      api("/tasks"),
      jsonReq("POST", {
        title: "Watched task",
        description: "Task for watcher test",
        assignTo: "agent-1",
      }),
    );
    const taskBody = await taskRes.json();
    const taskId = taskBody.data.id;

    // Create watcher
    const createRes = await app.request(
      api("/watchers"),
      jsonReq("POST", {
        taskId,
        targetStatus: "done",
        action: { type: "create_task", title: "Follow-up", description: "Auto-created", assignTo: "agent-1" },
      }),
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.ok).toBe(true);
    expect(created.data).toHaveProperty("id");
    expect(created.data.taskId).toBe(taskId);
    expect(created.data.targetStatus).toBe("done");
    expect(created.data.fired).toBe(false);
    const watcherId = created.data.id;

    // List — should include our watcher
    const listRes = await app.request(api("/watchers"));
    const listBody = await listRes.json();
    const found = listBody.data.find((w: any) => w.id === watcherId);
    expect(found).toBeDefined();

    // List active only
    const activeRes = await app.request(api("/watchers?active=true"));
    const activeBody = await activeRes.json();
    const activeFound = activeBody.data.find((w: any) => w.id === watcherId);
    expect(activeFound).toBeDefined();

    // Delete
    const deleteRes = await app.request(api(`/watchers/${watcherId}`), { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    const deleteBody = await deleteRes.json();
    expect(deleteBody.ok).toBe(true);
    expect(deleteBody.data.deleted).toBe(true);

    // Verify gone
    const listRes2 = await app.request(api("/watchers"));
    const listBody2 = await listRes2.json();
    const gone = listBody2.data.find((w: any) => w.id === watcherId);
    expect(gone).toBeUndefined();
  });

  test("POST /watchers returns 400 for nonexistent task", async () => {
    const res = await app.request(
      api("/watchers"),
      jsonReq("POST", {
        taskId: "nonexistent-task-id",
        targetStatus: "done",
        action: { type: "create_task" },
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("DELETE /watchers/:id returns 404 for unknown watcher", async () => {
    const res = await app.request(api("/watchers/nonexistent-watcher"), { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });
});

// ── Schedules API ────────────────────────────────────────────────────

describe("Schedules API", () => {
  test("GET /schedules returns 200 with array", async () => {
    const res = await app.request(api("/schedules"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("schedule lifecycle: create, list, update, delete", async () => {
    // Create a mission first
    const missionData = JSON.stringify({
      tasks: [{ title: "Sched task", description: "Scheduled", assignTo: "agent-1" }],
    });
    const missionRes = await app.request(
      api("/missions"),
      jsonReq("POST", { data: missionData, name: "sched-test" }),
    );
    const mission = await missionRes.json();
    const missionId = mission.data.id;

    // Create schedule (recurring cron expression)
    const createRes = await app.request(
      api("/schedules"),
      jsonReq("POST", {
        missionId,
        expression: "0 9 * * *",
        recurring: true,
      }),
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.ok).toBe(true);
    expect(created.data).toHaveProperty("missionId");

    // List — should include our schedule
    const listRes = await app.request(api("/schedules"));
    const listBody = await listRes.json();
    expect(listBody.data.length).toBeGreaterThanOrEqual(1);
    const found = listBody.data.find((s: any) => s.missionId === missionId);
    expect(found).toBeDefined();

    // Update — change enabled
    const updateRes = await app.request(
      api(`/schedules/${missionId}`),
      jsonReq("PATCH", { enabled: false }),
    );
    expect(updateRes.status).toBe(200);
    const updated = await updateRes.json();
    expect(updated.ok).toBe(true);

    // Delete
    const deleteRes = await app.request(api(`/schedules/${missionId}`), { method: "DELETE" });
    expect(deleteRes.status).toBe(200);
    const deleteBody = await deleteRes.json();
    expect(deleteBody.ok).toBe(true);
    expect(deleteBody.data.deleted).toBe(true);
  });

  test("POST /schedules returns 404 for nonexistent mission", async () => {
    const res = await app.request(
      api("/schedules"),
      jsonReq("POST", {
        missionId: "nonexistent-mission-id",
        expression: "0 9 * * *",
      }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("PATCH /schedules/:missionId returns 404 for unknown schedule", async () => {
    const res = await app.request(
      api("/schedules/nonexistent-id"),
      jsonReq("PATCH", { enabled: false }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });

  test("DELETE /schedules/:missionId returns 404 for unknown schedule", async () => {
    const res = await app.request(api("/schedules/nonexistent-id"), { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });
});

// ── Notification Rules API ───────────────────────────────────────────

describe("Notification Rules API", () => {
  test("GET /notifications/rules returns 200 with array", async () => {
    const res = await app.request(api("/notifications/rules"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  test("POST /notifications/rules returns 400 when not configured", async () => {
    // The test orchestrator has no notification config, so router is undefined
    const res = await app.request(
      api("/notifications/rules"),
      jsonReq("POST", {
        name: "test-rule",
        events: ["task:done"],
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_CONFIGURED");
  });

  test("DELETE /notifications/rules/:ruleId returns 404 when not configured", async () => {
    const res = await app.request(api("/notifications/rules/any-rule"), { method: "DELETE" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("NOT_FOUND");
  });
});

// ── Vault API ────────────────────────────────────────────────────────

describe("Vault API", () => {
  // Helper for vault API paths (mounted at /api/v1/vault)
  function vault(path: string): string {
    return `/api/v1/vault${path}`;
  }

  test("POST /vault/entries saves a vault entry", async () => {
    const res = await app.request(
      vault("/entries"),
      jsonReq("POST", {
        agent: "agent-1",
        service: "github",
        type: "api_key",
        label: "GitHub token",
        credentials: { token: "ghp_test123" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.agent).toBe("agent-1");
    expect(body.data.service).toBe("github");
    expect(body.data.type).toBe("api_key");
    expect(body.data.keys).toEqual(["token"]);
    // Ensure credentials are NOT returned
    expect(body.data).not.toHaveProperty("credentials");
  });

  test("GET /vault/entries/:agent lists entries (metadata only)", async () => {
    // Ensure there's an entry from the previous test
    await app.request(
      vault("/entries"),
      jsonReq("POST", {
        agent: "agent-1",
        service: "slack",
        type: "oauth",
        credentials: { access_token: "xoxb-test", client_id: "abc" },
      }),
    );

    const res = await app.request(vault("/entries/agent-1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
    const slack = body.data.find((e: any) => e.service === "slack");
    expect(slack).toBeDefined();
    expect(slack.type).toBe("oauth");
    expect(slack.keys).toContain("access_token");
    expect(slack.keys).toContain("client_id");
    // No credential values exposed
    expect(slack).not.toHaveProperty("credentials");
  });

  test("GET /vault/entries/:agent returns empty array for unknown agent", async () => {
    const res = await app.request(vault("/entries/no-such-agent"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data).toEqual([]);
  });

  test("PATCH /vault/entries/:agent/:service merges credentials", async () => {
    // Ensure a base entry exists
    await app.request(
      vault("/entries"),
      jsonReq("POST", {
        agent: "agent-1",
        service: "smtp-patch",
        type: "smtp",
        credentials: { host: "smtp.example.com", port: "587", user: "old-user" },
      }),
    );

    // Patch — update user, add pass (host and port should survive)
    const res = await app.request(
      vault("/entries/agent-1/smtp-patch"),
      jsonReq("PATCH", {
        credentials: { user: "new-user", pass: "secret" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.agent).toBe("agent-1");
    expect(body.data.service).toBe("smtp-patch");
    expect(body.data.type).toBe("smtp");
    // Merged keys: original host, port, user + new pass
    expect(body.data.keys).toContain("host");
    expect(body.data.keys).toContain("port");
    expect(body.data.keys).toContain("user");
    expect(body.data.keys).toContain("pass");
    // No credential values returned
    expect(body.data).not.toHaveProperty("credentials");

    // Verify via the store directly that values were merged correctly
    const vaultStore = orchestrator.getVaultStore()!;
    const entry = (await vaultStore.get("agent-1", "smtp-patch"))!;
    expect(entry.credentials.host).toBe("smtp.example.com"); // preserved
    expect(entry.credentials.port).toBe("587");               // preserved
    expect(entry.credentials.user).toBe("new-user");           // updated
    expect(entry.credentials.pass).toBe("secret");             // added
  });

  test("PATCH /vault/entries/:agent/:service updates type and label", async () => {
    // Ensure a base entry exists
    await app.request(
      vault("/entries"),
      jsonReq("POST", {
        agent: "agent-1",
        service: "patch-meta",
        type: "custom",
        label: "Old label",
        credentials: { key: "val" },
      }),
    );

    const res = await app.request(
      vault("/entries/agent-1/patch-meta"),
      jsonReq("PATCH", {
        type: "api_key",
        label: "New label",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.type).toBe("api_key");

    // Verify label and type via store
    const entry = (await orchestrator.getVaultStore()!.get("agent-1", "patch-meta"))!;
    expect(entry.type).toBe("api_key");
    expect(entry.label).toBe("New label");
    expect(entry.credentials.key).toBe("val"); // credentials unchanged
  });

  test("PATCH /vault/entries/:agent/:service returns 404 for nonexistent entry", async () => {
    const res = await app.request(
      vault("/entries/agent-1/nonexistent-service"),
      jsonReq("PATCH", {
        credentials: { key: "val" },
      }),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toContain("No vault entry");
  });

  test("DELETE /vault/entries/:agent/:service removes the entry", async () => {
    // Ensure entry exists
    await app.request(
      vault("/entries"),
      jsonReq("POST", {
        agent: "agent-1",
        service: "delete-me",
        type: "login",
        credentials: { user: "u", pass: "p" },
      }),
    );

    const res = await app.request(vault("/entries/agent-1/delete-me"), { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.removed).toBe(true);

    // Verify gone
    const entry = await orchestrator.getVaultStore()!.get("agent-1", "delete-me");
    expect(entry).toBeUndefined();
  });

  test("DELETE /vault/entries/:agent/:service returns removed:false for nonexistent", async () => {
    const res = await app.request(vault("/entries/agent-1/no-such-service"), { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.removed).toBe(false);
  });

  test("vault lifecycle: create, list, patch, verify, delete", async () => {
    const ag = "agent-1";
    const svc = "lifecycle-test";

    // 1. Create
    const createRes = await app.request(
      vault("/entries"),
      jsonReq("POST", {
        agent: ag,
        service: svc,
        type: "smtp",
        label: "SMTP creds",
        credentials: { host: "mail.example.com", port: "465", user: "admin" },
      }),
    );
    expect(createRes.status).toBe(200);

    // 2. List — should include it
    const listRes = await app.request(vault(`/entries/${ag}`));
    const listBody = await listRes.json();
    const found = listBody.data.find((e: any) => e.service === svc);
    expect(found).toBeDefined();
    expect(found.type).toBe("smtp");
    expect(found.keys).toContain("host");

    // 3. Patch — add password, change user
    const patchRes = await app.request(
      vault(`/entries/${ag}/${svc}`),
      jsonReq("PATCH", {
        credentials: { user: "new-admin", pass: "hunter2" },
      }),
    );
    expect(patchRes.status).toBe(200);
    const patchBody = await patchRes.json();
    expect(patchBody.data.keys).toContain("pass");
    expect(patchBody.data.keys).toContain("host"); // preserved

    // 4. Verify merged state
    const store = orchestrator.getVaultStore()!;
    const entry = (await store.get(ag, svc))!;
    expect(entry.credentials.host).toBe("mail.example.com");
    expect(entry.credentials.port).toBe("465");
    expect(entry.credentials.user).toBe("new-admin");
    expect(entry.credentials.pass).toBe("hunter2");
    expect(entry.label).toBe("SMTP creds");

    // 5. Delete
    const delRes = await app.request(vault(`/entries/${ag}/${svc}`), { method: "DELETE" });
    expect(delRes.status).toBe(200);
    expect((await delRes.json()).data.removed).toBe(true);

    // 6. Verify deleted
    expect(await store.get(ag, svc)).toBeUndefined();
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

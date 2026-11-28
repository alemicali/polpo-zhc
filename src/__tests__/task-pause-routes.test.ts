/**
 * REST: POST /tasks/:id/pause and /resume (and PATCH status: paused), against the real app.
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

let tmpDir: string;
let app: Hono;
const api = (path: string) => `/api/v1${path}`;
const jsonReq = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-pause-api-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({ project: "pause-api", team: { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] }, settings: { logLevel: "quiet" } }));
  const { Orchestrator } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  const orchestrator = new Orchestrator(tmpDir);
  await orchestrator.initInteractive("pause-api", { name: "t", agents: [{ name: "agent-1", role: "Test agent" }] });
  const bridge = new SSEBridge(orchestrator);
  bridge.start();
  app = createApp(orchestrator, bridge);
}, 30_000);

afterAll(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
});

describe("Task pause API", () => {
  test("POST /tasks/:id/pause and /resume: paused with the reason, listed as paused, resumed to pending", async () => {
    const created = await (await app.request(api("/tasks"), jsonReq("POST", { title: "Pause test", description: "Will be paused", assignTo: "agent-1" }))).json();
    const taskId = created.data.id;

    expect((await app.request(api(`/tasks/${taskId}/resume`), { method: "POST" })).status).toBe(409);
    const paused = await app.request(api(`/tasks/${taskId}/pause`), jsonReq("POST", { reason: "waiting for the client" }));
    expect(paused.status).toBe(200);
    const pausedBody = await paused.json();
    expect(pausedBody.data).toMatchObject({ paused: true, task: { status: "paused", pause: { reason: "waiting for the client", from: "pending" } } });
    expect((await app.request(api(`/tasks/${taskId}/pause`), { method: "POST" })).status).toBe(409);

    const list = await (await app.request(api("/tasks?status=paused&slim=true"))).json();
    const row = (list.data as Array<{ id: string; pause?: { reason?: string } }>).find((t) => t.id === taskId);
    expect(row?.pause?.reason).toBe("waiting for the client");

    const resumed = await app.request(api(`/tasks/${taskId}/resume`), jsonReq("POST", { message: "go on" }));
    expect(resumed.status).toBe(200);
    expect((await resumed.json()).data).toMatchObject({ resumed: true, continued: false, task: { status: "pending" } });
    expect((await app.request(api("/tasks/nope/pause"), { method: "POST" })).status).toBe(404);
    // PATCH status: paused is the real pause too
    const patched = await app.request(api(`/tasks/${taskId}`), jsonReq("PATCH", { status: "paused" }));
    expect((await patched.json()).data).toMatchObject({ status: "paused", pause: { from: "pending" } });
    await app.request(api(`/tasks/${taskId}/kill`), { method: "POST" });
  });

});

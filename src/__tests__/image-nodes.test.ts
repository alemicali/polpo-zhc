/**
 * Mission (and playbook) image nodes in the mission executor: the tasks receiving an image wait for
 * it; it is generated (the imager: the media service) once the after tasks finished, from a prompt
 * over their results; the tasks get its files in their description (form → an agent writes the
 * post → an image → an agent sends both). A failure lets them go on told so, or fails them
 * (onError "fail"). The document is validated; a restart keeps a finished node.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MissionExecutor } from "../core/mission-executor.js";
import { TaskManager } from "../core/task-manager.js";
import { AgentManager } from "../core/agent-manager.js";
import { HookRegistry } from "../core/hooks.js";
import { TypedEmitter } from "../core/events.js";
import { InMemoryTaskStore, InMemoryRunStore, createMockStores } from "./fixtures.js";
import type { OrchestratorContext } from "../core/orchestrator-context.js";
import type { Mission, PolpoConfig, Task } from "../core/types.js";
import { missionDocumentSchema, type MissionImager } from "@polpo-ai/core";
import { FileCheckpointStore } from "../stores/file-checkpoint-store.js";
import { FileDelayStore } from "../stores/file-delay-store.js";
import { FileImageNodeStore } from "../stores/file-image-node-store.js";
import { instantiatePlaybook, validatePlaybookDefinition } from "../core/playbook.js";

function makeCtx(dir: string): OrchestratorContext {
  const store = new InMemoryTaskStore();
  const missions = new Map<string, Mission>();
  let n = 0;
  const registry = Object.assign(store, {
    saveMission: async (o: { name: string; data: string; status?: string }) => {
      const m: Mission = { id: `mission-${++n}`, name: o.name, data: o.data, status: (o.status as Mission["status"]) ?? "draft", createdAt: "", updatedAt: "" };
      missions.set(m.id, m);
      return m;
    },
    getMission: async (id: string) => missions.get(id),
    getMissionByName: async (name: string) => [...missions.values()].find((m) => m.name === name),
    getAllMissions: async () => [...missions.values()],
    updateMission: async (id: string, u: Partial<Mission>) => Object.assign(missions.get(id)!, u),
    deleteMission: async (id: string) => missions.delete(id),
    nextMissionName: async () => `mission-${n + 1}`,
  });
  const config: PolpoConfig = { version: "1", project: "t", teams: [{ name: "t", agents: [{ name: "a" }] }], tasks: [], settings: { maxRetries: 2, workDir: dir, logLevel: "quiet" } };
  const { teamStore, agentStore } = createMockStores(config.teams);
  return {
    emitter: new TypedEmitter(), registry, runStore: new InMemoryRunStore(), hooks: new HookRegistry(), config, teamStore, agentStore,
    workDir: dir, agentWorkDir: dir, polpoDir: dir, assessFn: vi.fn(),
    checkpointStore: new FileCheckpointStore(dir), delayStore: new FileDelayStore(dir), imageNodeStore: new FileImageNodeStore(dir),
  } as unknown as OrchestratorContext;
}

const DOC = {
  tasks: [
    { title: "Write", description: "Write the post for {{product}}" },
    { title: "Send", description: "Send the post and the image on Telegram", dependsOn: ["Write"] },
    { title: "Archive", description: "Archive the post", dependsOn: ["Write"] },
  ],
  images: [{ name: "cover", afterTasks: ["Write"], prompt: "A cover image for this post: {{tasks.Write}}", forTasks: ["Send"], size: "1024x1024" }],
};

describe("mission image nodes", () => {
  let dir: string;
  let ctx: OrchestratorContext;
  let exec: MissionExecutor;
  const events: Array<{ status: string; mediaId?: string; error?: string }> = [];
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "polpo-image-nodes-"));
    ctx = makeCtx(dir);
    exec = new MissionExecutor(ctx, new TaskManager(ctx), new AgentManager(ctx));
    await exec.ready;
    events.length = 0;
    ctx.emitter.on("media:node", (e) => events.push(e));
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

  async function start(doc: unknown, imager?: MissionImager) {
    if (imager) exec.setImager(imager);
    const m = await exec.saveMission({ data: JSON.stringify(doc), name: "post" });
    const { tasks, group } = await exec.executeMission(m.id);
    const byTitle = (t: string) => tasks.find((x) => x.title === t)!;
    const all = () => ctx.registry.getAllTasks();
    const finish = async (title: string, stdout: string) => {
      await ctx.registry.updateTask(byTitle(title).id, { result: { exitCode: 0, stdout, stderr: "", duration: 1 } });
      await ctx.registry.unsafeSetStatus(byTitle(title).id, "done", "test");
    };
    const blocking = async (title: string) => exec.getBlockingImage(group, title, byTitle(title).id, await all());
    return { m, group, byTitle, all, finish, blocking };
  }

  const doc = { ...DOC, tasks: DOC.tasks.map((t) => ({ ...t, description: t.description.replace("{{product}}", "the spring sale") })) };

  test("the receiving task waits; the image is made from the after tasks' results; its files go into the task", async () => {
    const imager = vi.fn<MissionImager>(async () => ({ id: "img_abc123", files: ["/p/.polpo/media/images/img_abc123/0.png"], urls: ["/api/v1/media/images/img_abc123/0"], model: "vercel-ai-gateway:openai/gpt-image-2" }));
    const s = await start(doc, imager);
    expect(await s.blocking("Send")).toMatchObject({ image: { name: "cover" } });
    expect(await s.blocking("Archive")).toBeUndefined();
    expect(imager).not.toHaveBeenCalled();
    await s.finish("Write", "Spring sale: 20% off everything");
    expect((await s.blocking("Send"))?.state?.status).toBe("generating");
    expect(exec.hasPendingImages()).toBe(true);
    await vi.waitFor(() => expect(events.some((e) => e.status === "done")).toBe(true));
    expect(imager).toHaveBeenCalledTimes(1);
    expect(imager.mock.calls[0][0]).toMatchObject({ prompt: "A cover image for this post: Spring sale: 20% off everything", size: "1024x1024", caller: { id: s.m.id, missionId: s.m.id } });
    expect(await s.blocking("Send")).toBeUndefined();
    const send = (await s.all()).find((t) => t.title === "Send")!;
    expect(send.description).toContain('## Image "cover"');
    expect(send.description).toContain("/p/.polpo/media/images/img_abc123/0.png (/api/v1/media/images/img_abc123/0)");
    expect(events.map((e) => e.status)).toEqual(["generating", "done"]);
    expect(exec.listImageNodes()[0]).toMatchObject({ node: "cover", status: "done", mediaId: "img_abc123" });
    expect(exec.hasPendingImages()).toBe(false);
  });

  test("a failure: the tasks go on told so (default), or fail (onError fail)", async () => {
    const s = await start(doc, async () => { throw new Error("No image model is configured"); });
    await s.finish("Write", "x");
    await s.blocking("Send");
    await vi.waitFor(() => expect(events.some((e) => e.status === "failed")).toBe(true));
    const send = (await s.all()).find((t) => t.title === "Send")!;
    expect(send.status).toBe("pending");
    expect(send.description).toContain("The image could not be generated: No image model is configured");

    events.length = 0;
    const strict = { ...doc, images: [{ ...doc.images[0], onError: "fail" }] };
    const f = await start(strict, async () => { throw new Error("gateway down"); });
    await f.finish("Write", "x");
    await f.blocking("Send");
    await vi.waitFor(() => expect(events.some((e) => e.status === "failed")).toBe(true));
    const failed = (await f.all()).find((t) => t.title === "Send" && t.group === f.group)!;
    expect(failed).toMatchObject({ status: "failed", result: { stderr: expect.stringContaining("gateway down") } });
  });

  test("a restart keeps a finished node; documents without images are unaffected", async () => {
    const plain = await start({ tasks: [{ title: "A", description: "a" }, { title: "B", description: "b", dependsOn: ["A"] }] });
    expect(await plain.blocking("B")).toBeUndefined();
    const s = await start(doc, async () => ({ id: "img_x12345", files: ["/f.png"], urls: [], model: "m" }));
    await s.finish("Write", "x");
    await s.blocking("Send");
    await vi.waitFor(() => expect(events.some((e) => e.status === "done")).toBe(true));
    const again = new MissionExecutor(ctx, new TaskManager(ctx), new AgentManager(ctx));
    await again.ready;
    expect(again.listImageNodes()).toEqual([expect.objectContaining({ node: "cover", status: "done" })]);
    const mission = await ctx.registry.getMission!(s.m.id);
    expect(await again.getBlockingImage(s.group, "Send", s.byTitle("Send").id, await s.all() as Task[], mission!.data)).toBeUndefined();
  });

  test("the mission document is validated", () => {
    expect(missionDocumentSchema.safeParse(doc).success).toBe(true);
    const bad = missionDocumentSchema.safeParse({ ...doc, images: [{ name: "cover", afterTasks: ["Write"], prompt: "x", forTasks: ["Nope"] }] });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain('forTasks references unknown task \\"Nope\\"');
  });
});

describe("playbooks with image nodes", () => {
  test("parameters fill the playbook; {{tasks.<title>}} stays for run time", () => {
    const def = { name: "post-with-image", description: "Post with an image", parameters: [{ name: "product", description: "The product", required: true }], mission: DOC };
    expect(validatePlaybookDefinition(def)).toEqual([]);
    const out = JSON.parse(instantiatePlaybook(def, { product: "the spring sale" }).data);
    expect(out.tasks[0].description).toBe("Write the post for the spring sale");
    expect(out.images[0].prompt).toBe("A cover image for this post: {{tasks.Write}}");
  });
});

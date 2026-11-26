/**
 * Image nodes of missions and playbooks (media.ts MissionImage): the tasks in a node's `forTasks`
 * wait until its after tasks have all finished and its image is generated (the media service, wired
 * by the server as the "imager"); then they get the image's files in their description. Like
 * decision nodes: the definitions come from the mission's document, the state is persisted
 * (an image cut short by a restart is generated again).
 */
import type { OrchestratorContext } from "./orchestrator-context.js";
import type { Task } from "./types.js";
import { imageNodeNote, renderImageNodePrompt, type ImageNodeState, type ImageNodeStore, type MissionImage, type MissionImager } from "./media.js";

class InMemoryImageNodeStore implements ImageNodeStore {
  private state: Record<string, ImageNodeState> = {};
  async load(): Promise<Record<string, ImageNodeState>> { return this.state; }
  async save(state: Record<string, ImageNodeState>): Promise<void> { this.state = state; }
}

export class MissionImageNodes {
  private byGroup = new Map<string, MissionImage[]>();
  private state: Record<string, ImageNodeState> = {};
  private store: ImageNodeStore;
  private imager?: MissionImager;
  readonly ready: Promise<void>;

  constructor(private readonly ctx: Pick<OrchestratorContext, "registry" | "emitter"> & { imageNodeStore?: ImageNodeStore }) {
    this.store = ctx.imageNodeStore ?? new InMemoryImageNodeStore();
    this.ready = this.store.load().then((s) => {
      // an image cut short by a restart is generated again
      this.state = Object.fromEntries(Object.entries(s ?? {}).filter(([, x]) => x.status !== "generating"));
    }).catch(() => undefined);
  }

  setImager(imager: MissionImager | undefined): void { this.imager = imager; }

  /** A new run of a group: its nodes from the document, generated again. */
  async startRun(group: string, nodes: MissionImage[] | undefined): Promise<void> {
    await this.drop(group);
    if (nodes?.length) this.byGroup.set(group, nodes);
  }

  nodes(group: string, missionData?: string): MissionImage[] {
    const known = this.byGroup.get(group);
    if (known) return known;
    if (!missionData) return [];
    try {
      const doc = JSON.parse(missionData) as { images?: MissionImage[] };
      const list = Array.isArray(doc.images) ? doc.images : [];
      this.byGroup.set(group, list);
      return list;
    } catch { return []; }
  }

  list(): ImageNodeState[] {
    return Object.values(this.state).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  hasPending(): boolean {
    return Object.values(this.state).some((s) => s.status === "generating");
  }

  /** Is a task waiting for an image? Starts the node once its after tasks have finished. */
  async blocking(group: string, taskTitle: string, taskId: string, tasks: Task[], missionData?: string): Promise<{ image: MissionImage; state?: ImageNodeState } | undefined> {
    for (const n of this.nodes(group, missionData)) {
      if (!n.forTasks?.includes(taskTitle) && !n.forTasks?.includes(taskId)) continue;
      const st = this.state[`${group}:${n.name}`];
      if (st && st.status !== "generating") continue; // done or failed: the note is in the task
      if (st) return { image: n, state: st };
      const after = tasks.filter((t) => n.afterTasks.includes(t.title) || n.afterTasks.includes(t.id));
      const finished = after.length >= n.afterTasks.length && after.every((t) => t.status === "done" || t.status === "failed");
      if (!finished) return { image: n };
      return { image: n, state: this.start(group, n, tasks) };
    }
    return undefined;
  }

  private start(group: string, n: MissionImage, tasks: Task[]): ImageNodeState {
    const key = `${group}:${n.name}`;
    const missionId = tasks.find((t) => t.group === group && t.missionId)?.missionId;
    const st: ImageNodeState = { group, ...(missionId ? { missionId } : {}), node: n.name, status: "generating", startedAt: new Date().toISOString() };
    this.state[key] = st;
    void this.store.save(this.state);
    this.ctx.emitter.emit("media:node", { group, missionId, node: n.name, status: "generating" });
    const run = async () => {
      if (!this.imager) throw new Error("Image generation is not available here (no server)");
      const prompt = renderImageNodePrompt(n, tasks);
      if (!prompt) throw new Error("the prompt is empty (the tasks before it produced no result)");
      return this.imager({
        prompt, ...(n.size ? { size: n.size } : {}), ...(n.n ? { n: n.n } : {}), ...(n.model ? { model: n.model } : {}),
        caller: { ...(missionId ? { id: missionId, missionId } : {}), label: `${group} → ${n.name}` },
      });
    };
    void run().then(
      (r) => this.finish(group, n, { status: "done", mediaId: r.id, files: r.files }, r.urls),
      (err) => this.finish(group, n, { status: "failed", error: err instanceof Error ? err.message : String(err) }),
    ).catch((err) => this.ctx.emitter.emit("log", { level: "error", message: `Image "${n.name}" (${group}): ${err instanceof Error ? err.message : String(err)}` }));
    return st;
  }

  /** The image arrived (or failed): its tasks get the files (or the error) in their description; with onError "fail" they fail. */
  private async finish(group: string, n: MissionImage, r: Pick<ImageNodeState, "status" | "mediaId" | "files" | "error">, urls: string[] = []): Promise<void> {
    const key = `${group}:${n.name}`;
    const st = this.state[key];
    if (!st || st.status !== "generating") return; // the run was aborted meanwhile
    const next: ImageNodeState = { ...st, ...r, finishedAt: new Date().toISOString() };
    const groupTasks = (await this.ctx.registry.getAllTasks()).filter((t) => t.group === group && (!st.missionId || t.missionId === st.missionId));
    const open = (t: Task) => t.status === "pending" || t.status === "draft";
    const note = imageNodeNote(n, next, urls);
    for (const t of groupTasks.filter((x) => (n.forTasks.includes(x.title) || n.forTasks.includes(x.id)) && open(x))) {
      if (next.status === "failed" && n.onError === "fail") {
        const from = t.status;
        await this.ctx.registry.updateTask(t.id, { result: { exitCode: 1, stdout: "", stderr: `The image "${n.name}" could not be generated: ${next.error ?? "error"}`, duration: 0 } });
        const failed = await this.ctx.registry.unsafeSetStatus(t.id, "failed", `image "${n.name}" failed`);
        this.ctx.emitter.emit("task:transition", { taskId: t.id, from, to: "failed", task: failed, reason: `image "${n.name}" failed` });
      } else {
        await this.ctx.registry.updateTask(t.id, { description: `${t.description}${note}` });
      }
    }
    this.state[key] = next;
    await this.store.save(this.state);
    this.ctx.emitter.emit("media:node", { group, missionId: st.missionId, node: n.name, status: next.status, ...(next.mediaId ? { mediaId: next.mediaId } : {}), ...(next.error ? { error: next.error } : {}) });
  }

  /** Forget a group's nodes (its run ended or was aborted). */
  async drop(group: string): Promise<void> {
    this.byGroup.delete(group);
    let changed = false;
    for (const [k, s] of Object.entries(this.state)) if (s.group === group) { delete this.state[k]; changed = true; }
    if (changed) await this.store.save(this.state);
  }
}

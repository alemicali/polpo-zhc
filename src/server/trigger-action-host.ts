/**
 * The trigger action engine's host on a running instance: each action calls the same internal
 * function the other surfaces use — no HTTP to ourselves.
 *
 *   playbook  runPlaybook (what POST /playbooks/{name}/run and polpo_playbook_run call)
 *   mission   Orchestrator.executeMission (POST /missions/{id}/execute); a copy with variables
 *             through Orchestrator.saveMission when asked or when it cannot start again
 *   task      Orchestrator.addTask (POST /tasks)
 *   agent     one turn of the completions pipeline, in-process (as channels, checks and agent talk)
 *   notify    NotificationRouter.sendDirect (POST /notifications/send)
 *
 * Everything created carries the action's origin and, when the trigger's owner is a member, is
 * theirs (requestedBy / mission owner), so the owner policies (e.g. a CLI engine on a personal plan)
 * apply as for work they start themselves.
 */
import { parseAgentRef, type Mission, type Task } from "@polpo-ai/core";
import { PlaybookRunError, runPlaybook, TURN_MAX_STEPS_HEADER, TURN_TOOLS_HEADER, internalCallHeaders } from "@polpo-ai/server";
import type { Orchestrator } from "../core/orchestrator.js";
import type { ActionContext, TriggerActionHost, WaitOutcome } from "../triggers/actions.js";

/** Statuses a mission can be (re)started from. */
const EXECUTABLE: Mission["status"][] = ["draft", "scheduled", "recurring", "failed", "cancelled"];
const MISSION_ENDED: Mission["status"][] = ["completed", "failed", "cancelled"];
const POLL_MS = 2000;

export interface TriggerActionHostDeps {
  orchestrator: Orchestrator;
  /** The completions app (in-process): one turn per call. */
  completions: { request: (req: Request) => Response | Promise<Response> };
  /** The instance's first API key, when the completions endpoint needs one. */
  apiKey?: () => string | undefined;
  /** What a session's turns cost (USD), from the recorded token usage. */
  sessionCost?: (sessionId: string) => Promise<number | undefined>;
  pollMs?: number;
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve) => {
  if (signal.aborted) return resolve();
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal.removeEventListener("abort", done); resolve(); }
  signal.addEventListener("abort", done, { once: true });
});

/** A JSON string's inside (a value spliced into a mission document between quotes). */
const jsonInside = (v: string) => JSON.stringify(v).slice(1, -1);

const taskResult = (t: Task) => (t.result?.stdout ?? "").trim();

export function createTriggerActionHost(deps: TriggerActionHostDeps): TriggerActionHost {
  const o = deps.orchestrator;
  const pollMs = deps.pollMs ?? POLL_MS;
  const missionOwner = (ctx: ActionContext) => ({ origin: ctx.origin, ...(ctx.requestedBy ? { owner: ctx.requestedBy } : {}) });
  const runAs = (ctx: ActionContext) => ({ origin: ctx.origin, ...(ctx.requestedBy ? { requestedBy: ctx.requestedBy } : {}) });

  return {
    async runPlaybook(name, params, ctx) {
      try {
        const r = await runPlaybook({
          playbookStore: o.getPlaybookStore(),
          saveMission: (opts: any) => o.saveMission(opts),
          executeMission: (id: string, opts?: any) => o.executeMission(id, opts),
          deleteMission: (id: string) => o.deleteMission(id),
          onRun: (n: string, missionId: string, p: string[]) => o.emit("playbook:run", { name: n, missionId, params: p }),
        }, name, params, { missionOpts: missionOwner(ctx), executeOpts: runAs(ctx) });
        return { missionId: r.mission.id, missionName: r.mission.name, tasks: r.tasks };
      } catch (err) {
        if (err instanceof PlaybookRunError) throw new Error(`Playbook "${name}": ${err.message}${err.details?.length ? ` (${err.details.join("; ")})` : ""}`);
        throw err;
      }
    },

    async runMission(ref, variables, ctx) {
      const all = await o.getAllMissions();
      const m = (await o.getMission(ref)) ?? all.find((x) => x.name === ref);
      if (!m) throw new Error(`No mission "${ref}"`);
      if (!variables && EXECUTABLE.includes(m.status)) {
        await o.executeMission(m.id, runAs(ctx));
        return { missionId: m.id, missionName: m.name };
      }
      // a copy: with the variables in its {{name}} placeholders, or because it cannot start again
      let data = m.data;
      for (const [k, v] of Object.entries(variables ?? {})) data = data.split(`{{${k}}}`).join(jsonInside(v));
      try { JSON.parse(data); } catch (err) { throw new Error(`Mission "${m.name}" with these variables is not valid JSON: ${err instanceof Error ? err.message : String(err)}`); }
      const copy = await o.saveMission({
        data, name: m.name, ...(m.prompt ? { prompt: m.prompt } : {}), ...(m.notifications ? { notifications: m.notifications } : {}),
        ...(m.budgetUsd !== undefined ? { budgetUsd: m.budgetUsd } : {}), ...missionOwner(ctx),
      });
      try {
        await o.executeMission(copy.id, runAs(ctx));
      } catch (err) {
        await o.deleteMission(copy.id).catch(() => false);
        throw err;
      }
      return { missionId: copy.id, missionName: copy.name, copyOf: m.id };
    },

    async createTask(t, ctx) {
      const name = parseAgentRef(t.assignTo).name;
      if (!(await o.getAgents()).some((a) => a.name === name)) throw new Error(`No agent "${name}" to assign the task to`);
      const task = await o.addTask({ title: t.title, description: t.description, assignTo: t.assignTo, ...runAs(ctx) });
      return { taskId: task.id };
    },

    async agentTurn(t, ctx) {
      const sessions = o.getSessionStore();
      if (!sessions) throw new Error("Chat sessions are not available");
      if (t.agent && !(await o.getAgents()).some((a) => a.name === parseAgentRef(t.agent!).name)) throw new Error(`No agent "${t.agent}"`);
      const sessionId = await sessions.create(t.title.slice(0, 120), t.agent ? parseAgentRef(t.agent).name : undefined, { scope: t.scope });
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "x-session-id": sessionId,
        "x-polpo-lease-wait": String(10 * 60 * 1000),
        [TURN_MAX_STEPS_HEADER]: String(t.maxSteps),
        ...(t.allowedTools ? { [TURN_TOOLS_HEADER]: encodeURIComponent(JSON.stringify(t.allowedTools)) } : {}),
        ...internalCallHeaders(),
      };
      const key = deps.apiKey?.();
      if (key) headers.authorization = `Bearer ${key}`;
      const response = await deps.completions.request(new Request("http://polpo.internal/", {
        method: "POST", headers, signal: ctx.signal,
        body: JSON.stringify({ stream: false, ...(t.agent ? { agent: t.agent } : {}), messages: [{ role: "user", content: t.message }] }),
      }));
      const payload = await response.json().catch(() => null) as any;
      if (!response.ok) throw new Error(payload?.error?.message ?? payload?.error ?? `The turn failed (HTTP ${response.status})`);
      const content = payload?.choices?.[0]?.message?.content;
      const cost = await deps.sessionCost?.(sessionId).catch(() => undefined);
      return { sessionId, reply: typeof content === "string" ? content : "", ...(cost !== undefined ? { costUsd: cost } : {}) };
    },

    async deliver(target, text, agent) {
      await o.sendToChat({ channel: target.channel, chatId: target.chatId, ...(target.threadId !== undefined ? { threadId: target.threadId } : {}), ...(target.name ? { name: target.name } : {}) }, text, agent);
    },

    async notify(n) {
      const router = o.getNotificationRouter();
      if (!router) throw new Error("Notifications are not configured on this instance");
      const r = await router.sendDirect({ channel: n.channel, title: n.title, body: n.body, ...(n.severity ? { severity: n.severity } : {}), throwOnError: true, ruleName: n.ruleName });
      return { notificationId: r.id };
    },

    async waitMission(missionId, timeoutMs, signal): Promise<WaitOutcome | "timeout"> {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const m = await o.getMission(missionId);
        if (!m) return { status: "deleted" };
        if (MISSION_ENDED.includes(m.status)) {
          const tasks = (await o.getStore().getAllTasks()).filter((t) => t.missionId === missionId);
          const result = tasks.map((t) => (taskResult(t) ? `${t.title}:\n${taskResult(t)}` : "")).filter(Boolean).join("\n\n").slice(0, 8000);
          return { status: m.status, ...(result ? { result } : {}) };
        }
        if (signal.aborted) throw new Error(String((signal.reason as Error)?.message ?? "Stopped"));
        if (Date.now() >= until) return "timeout";
        await sleep(Math.min(pollMs, Math.max(1, until - Date.now())), signal);
      }
    },

    async waitTask(taskId, timeoutMs, signal): Promise<WaitOutcome | "timeout"> {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const t = await o.getStore().getTask(taskId);
        if (!t) return { status: "deleted" };
        if (t.status === "done" || t.status === "failed") return { status: t.status, ...(taskResult(t) ? { result: taskResult(t).slice(0, 8000) } : {}) };
        if (signal.aborted) throw new Error(String((signal.reason as Error)?.message ?? "Stopped"));
        if (Date.now() >= until) return "timeout";
        await sleep(Math.min(pollMs, Math.max(1, until - Date.now())), signal);
      }
    },
  };
}

import { Hono } from "hono";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { ServerEnv } from "../app.js";
import { AddAgentSchema, RenameTeamSchema, parseBody } from "../schemas.js";

/**
 * Agent/team management routes.
 */
export function agentRoutes(): Hono<ServerEnv> {
  const app = new Hono<ServerEnv>();

  // GET /agents — list agents
  app.get("/", (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({ ok: true, data: orchestrator.getAgents() });
  });

  // POST /agents — add agent
  app.post("/", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = parseBody(AddAgentSchema, await c.req.json());

    orchestrator.addAgent({
      name: body.name,
      adapter: body.adapter,
      role: body.role,
      model: body.model,
      allowedTools: body.allowedTools,
      systemPrompt: body.systemPrompt,
      skills: body.skills,
      maxTurns: body.maxTurns,
      enableBrowser: body.enableBrowser,
      enableHttp: body.enableHttp,
      enableGit: body.enableGit,
      enableMultifile: body.enableMultifile,
      enableDeps: body.enableDeps,
      enableExcel: body.enableExcel,
      enablePdf: body.enablePdf,
      enableDocx: body.enableDocx,
      enableEmail: body.enableEmail,
      enableAudio: body.enableAudio,
      enableImage: body.enableImage,
    });

    return c.json({ ok: true, data: { added: true } }, 201);
  });

  // DELETE /agents/:name — remove agent
  app.delete("/:name", (c) => {
    const orchestrator = c.get("orchestrator");
    const removed = orchestrator.removeAgent(c.req.param("name"));
    if (!removed) {
      return c.json({ ok: false, error: "Agent not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: { removed: true } });
  });

  // GET /team — get team info
  app.get("/team", (c) => {
    const orchestrator = c.get("orchestrator");
    return c.json({ ok: true, data: orchestrator.getTeam() });
  });

  // PATCH /team — rename team
  app.patch("/team", async (c) => {
    const orchestrator = c.get("orchestrator");
    const body = parseBody(RenameTeamSchema, await c.req.json());
    orchestrator.renameTeam(body.name);
    return c.json({ ok: true, data: orchestrator.getTeam() });
  });

  // GET /processes — active agent processes
  app.get("/processes", (c) => {
    const orchestrator = c.get("orchestrator");
    const state = orchestrator.getStore().getState();
    return c.json({ ok: true, data: state.processes || [] });
  });

  // GET /processes/:taskId/activity — activity history for a task (from run JSONL)
  app.get("/processes/:taskId/activity", (c) => {
    const orchestrator = c.get("orchestrator");
    const taskId = c.req.param("taskId");
    const logsDir = join(orchestrator.getPolpoDir(), "logs");

    if (!existsSync(logsDir)) {
      return c.json({ ok: true, data: [] });
    }

    // Strategy: first check active RunStore for the runId, otherwise scan JSONL headers
    let runId: string | undefined;
    const run = orchestrator.getRunStore().getRunByTaskId(taskId);
    if (run) {
      runId = run.id;
    } else {
      // Scan run-*.jsonl files for matching taskId in the header line
      const files = readdirSync(logsDir).filter(f => f.startsWith("run-") && f.endsWith(".jsonl"));
      for (const file of files) {
        try {
          const firstLine = readFileSync(join(logsDir, file), "utf-8").split("\n")[0];
          const header = JSON.parse(firstLine);
          if (header._run && header.taskId === taskId) {
            runId = header.runId;
            break;
          }
        } catch { /* skip malformed files */ }
      }
    }

    if (!runId) {
      return c.json({ ok: true, data: [] });
    }

    const logPath = join(logsDir, `run-${runId}.jsonl`);
    if (!existsSync(logPath)) {
      return c.json({ ok: true, data: [] });
    }

    try {
      const lines = readFileSync(logPath, "utf-8").split("\n").filter(Boolean);
      const entries = lines
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean);
      return c.json({ ok: true, data: entries });
    } catch {
      return c.json({ ok: true, data: [] });
    }
  });

  // GET /agents/:name — single agent detail (registered after static routes to avoid conflicts)
  app.get("/:name", (c) => {
    const orchestrator = c.get("orchestrator");
    const name = c.req.param("name");
    const agent = orchestrator.getAgents().find(a => a.name === name);
    if (!agent) {
      return c.json({ ok: false, error: "Agent not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ ok: true, data: agent });
  });

  return app;
}

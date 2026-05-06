import { OpenAPIHono } from "@hono/zod-openapi";
import { spawnSync } from "node:child_process";
import type { Context } from "hono";
import { z } from "zod";
import type { CodingSessionStore } from "../../core/coding-session-store.js";
import {
  isCodeServerEnabled,
  proxyCodeServerRequest,
  type CodeServerManager,
  type CodeServerSessionInfo,
} from "../code-server.js";
import { isTerminalEnabled } from "../terminal.js";

const CodingWorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cwd: z.string().min(1),
});

const CodingTerminalSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  label: z.string().default(""),
  revision: z.number().finite().default(0),
  agentKind: z.enum(["terminal", "claude", "codex"]).optional(),
  agentSessionId: z.string().optional(),
  cwdOverride: z.string().optional(),
  branch: z.string().optional(),
});

const CodingCodeServerSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  cwd: z.string().min(1),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const CodingSessionStateSchema = z.object({
  workspaces: z.array(CodingWorkspaceSchema).min(1),
  terminals: z.array(CodingTerminalSchema).min(1),
  codeServers: z.array(CodingCodeServerSchema).default([]),
  activeId: z.string().min(1),
});

const CodeServerStartSchema = z.object({
  workspaceId: z.string().min(1),
  cwd: z.string().min(1).default("."),
  force: z.boolean().optional().default(false),
  theme: z.enum(["light", "dark"]).optional().default("dark"),
});

const CodeServerStopSchema = z.object({
  workspaceId: z.string().min(1),
});

export function codingRoutes(getDeps: () => {
  codingSessionStore: CodingSessionStore;
  codeServerManager?: CodeServerManager;
}): OpenAPIHono {
  const app = new OpenAPIHono();

  app.get("/sessions", async (c) => {
    const { state, initialized } = await getDeps().codingSessionStore.getState();
    return c.json({ ok: true, data: { state, initialized } });
  });

  app.patch("/sessions", async (c) => {
    const parsed = CodingSessionStateSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ ok: false, error: "Invalid coding session state" }, 400);
    }

    const workspaceIds = new Set(parsed.data.workspaces.map((workspace) => workspace.id));
    if (parsed.data.terminals.some((terminal) => !workspaceIds.has(terminal.workspaceId))) {
      return c.json({ ok: false, error: "Invalid coding session state: terminal workspace not found" }, 400);
    }
    if (parsed.data.codeServers.some((session) => !workspaceIds.has(session.workspaceId))) {
      return c.json({ ok: false, error: "Invalid coding session state: VS Code workspace not found" }, 400);
    }
    if (!parsed.data.terminals.some((terminal) => terminal.id === parsed.data.activeId)) {
      return c.json({ ok: false, error: "Invalid coding session state: active terminal not found" }, 400);
    }

    const state = await getDeps().codingSessionStore.saveState(parsed.data);
    return c.json({ ok: true, data: { state, initialized: true } });
  });

  app.get("/capabilities", (c) => {
    return c.json({
      ok: true,
      data: {
        terminal: {
          enabled: isTerminalEnabled(),
          shell: process.env.POLPO_TERMINAL_SHELL || process.env.SHELL || "/bin/bash",
          available: commandExists(process.env.POLPO_TERMINAL_SHELL || process.env.SHELL || "bash"),
        },
        codeServer: {
          enabled: isCodeServerEnabled(),
          available: !!getDeps().codeServerManager && commandExists(process.env.POLPO_CODE_SERVER_BIN || "code-server"),
          bin: process.env.POLPO_CODE_SERVER_BIN || "code-server",
        },
        agents: {
          terminal: {
            available: isTerminalEnabled() && commandExists(process.env.POLPO_TERMINAL_SHELL || process.env.SHELL || "bash"),
            command: process.env.POLPO_TERMINAL_SHELL || process.env.SHELL || "bash",
          },
          claude: {
            available: commandExists("claude"),
            command: "claude",
          },
          codex: {
            available: commandExists("codex"),
            command: "codex",
          },
        },
      },
    });
  });

  app.get("/code-server/status", (c) => {
    return c.json({
      ok: true,
      data: {
        enabled: isCodeServerEnabled(),
        available: !!getDeps().codeServerManager,
        bin: process.env.POLPO_CODE_SERVER_BIN || "code-server",
        sessions: getDeps().codeServerManager?.listSessions().map((session) => ({
          ...session,
          directUrl: makeRequestDirectUrl(session.port, c.req.url),
        })) ?? [],
      },
    });
  });

  app.post("/code-server/start", async (c) => {
    const deps = getDeps();
    if (!deps.codeServerManager) {
      return c.json({ ok: false, error: "code-server is not available on this server." }, 501);
    }

    const parsed = CodeServerStartSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ ok: false, error: "Invalid code-server start request" }, 400);
    }

    try {
      const { state } = await deps.codingSessionStore.getState();
      const workspaceIds = new Set(state.workspaces.map((workspace) => workspace.id));
      if (!workspaceIds.has(parsed.data.workspaceId)) {
        return c.json({ ok: false, error: "Workspace not found." }, 404);
      }

      const sessionId = makeCodeServerSessionId(parsed.data.workspaceId);
      const info = await deps.codeServerManager.ensureSession(sessionId, parsed.data.cwd, {
        force: parsed.data.force,
        theme: parsed.data.theme,
      });
      const directUrl = makeRequestDirectUrl(info.port, c.req.url);
      const now = new Date().toISOString();
      const existing = state.codeServers.find((session) => session.id === sessionId);
      await deps.codingSessionStore.saveState({
        ...state,
        codeServers: [
          ...state.codeServers.filter((session) => session.id !== sessionId),
          {
            id: sessionId,
            workspaceId: parsed.data.workspaceId,
            cwd: info.cwd,
            createdAt: existing?.createdAt ?? now,
            updatedAt: now,
          },
        ],
      });

      return c.json({ ok: true, data: { ...info, directUrl } });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : "Failed to start code-server." }, 500);
    }
  });

  app.post("/code-server/stop", async (c) => {
    const deps = getDeps();
    if (!deps.codeServerManager) {
      return c.json({ ok: false, error: "code-server is not available on this server." }, 501);
    }

    const parsed = CodeServerStopSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ ok: false, error: "Invalid code-server stop request" }, 400);
    }

    const sessionId = makeCodeServerSessionId(parsed.data.workspaceId);
    const stopped = await deps.codeServerManager.stopSession(sessionId);
    return c.json({ ok: true, data: { stopped } });
  });

  app.all("/code-server/:sessionId", async (c) => {
    return proxyRunningCodeServer(c, getDeps().codeServerManager, "");
  });

  app.all("/code-server/:sessionId/*", async (c) => {
    return proxyRunningCodeServer(c, getDeps().codeServerManager, c.req.param("*") ?? "");
  });

  return app;
}

async function proxyRunningCodeServer(
  c: Context,
  manager: CodeServerManager | undefined,
  path: string,
): Promise<Response> {
  if (!manager) return c.json({ ok: false, error: "code-server is not available on this server." }, 501);
  const session = manager.getSession(c.req.param("sessionId"));
  if (!session) return c.json({ ok: false, error: "code-server session not found." }, 404);
  const info: CodeServerSessionInfo = {
    id: session.id,
    port: session.port,
    cwd: session.cwd,
    url: `/api/v1/coding/code-server/${encodeURIComponent(session.id)}/`,
    directUrl: makeRequestDirectUrl(session.port, c.req.url),
    running: session.process.exitCode == null,
    theme: session.theme,
  };
  return proxyCodeServerRequest(info, path, c.req.raw);
}

function makeCodeServerSessionId(workspaceId: string): string {
  return `vscode_${workspaceId.replace(/[^a-zA-Z0-9_.-]/g, "_")}`;
}

function makeRequestDirectUrl(port: number, requestUrl: string): string {
  const request = new URL(requestUrl);
  const protocol = process.env.POLPO_CODE_SERVER_PUBLIC_PROTOCOL || request.protocol.replace(":", "") || "http";
  const host = process.env.POLPO_CODE_SERVER_PUBLIC_HOST || request.hostname || "localhost";
  return `${protocol}://${host}:${port}/`;
}

function commandExists(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(trimmed)}`], {
    stdio: "ignore",
    timeout: 2_000,
  });
  return result.status === 0;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

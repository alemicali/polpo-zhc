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
import { isTerminalEnabled, type TerminalWebSocketHandle } from "../terminal.js";
import { readCodingConfig, writeCodingConfig } from "../coding-config-store.js";
import { describeTrees } from "../process-registry.js";

/** Run `cmd args` and return trimmed stdout, or empty string on any
 * failure (missing binary, non-zero exit). Used for "best effort"
 * identity probes — we don't surface errors to the user. */
function execCommand(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise) => {
    try {
      const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 3_000 });
      resolvePromise(r.status === 0 ? (r.stdout ?? "").trim() : "");
    } catch {
      resolvePromise("");
    }
  });
}

function execGit(args: string[]): Promise<string> {
  return execCommand("git", args);
}

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
  agentCommand: z.string().optional(),
  cwdOverride: z.string().optional(),
  branch: z.string().optional(),
  workspaceLabel: z.string().optional(),
  tabHidden: z.boolean().optional(),
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

const CodingConfigSchema = z.object({
  agentCommands: z
    .object({
      claude: z.string().trim().optional(),
      codex: z.string().trim().optional(),
      terminal: z.string().trim().optional(),
    })
    .partial()
    .default({}),
  allowedExtraRoots: z
    .array(z.string().trim().min(1))
    .default([]),
  prCommand: z.string().trim().min(1).optional(),
});

export function codingRoutes(getDeps: () => {
  codingSessionStore: CodingSessionStore;
  codeServerManager?: CodeServerManager;
  polpoDir: string;
  getTerminalHandle?: () => TerminalWebSocketHandle | null | undefined;
}): OpenAPIHono {
  const app = new OpenAPIHono();

  // Persisted coding config (agent commands + allowed extra workspace
  // roots). Lives in `<polpoDir>/coding-config.json`. The "allowed roots"
  // list is *also* the security source-of-truth used by the terminal /
  // code-server cwd resolvers — never trust the client for that check.
  app.get("/config", (c) => {
    return c.json({ ok: true, data: readCodingConfig(getDeps().polpoDir) });
  });

  app.put("/config", async (c) => {
    const parsed = CodingConfigSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success) {
      return c.json({ ok: false, error: "Invalid coding config" }, 400);
    }
    const next = writeCodingConfig(getDeps().polpoDir, parsed.data);
    return c.json({ ok: true, data: next });
  });

  // Git + GitHub identity surface — surfaced in the Settings dialog so the
  // user can confirm "who am I committing as" before the agent runs `gh
  // pr create` on their behalf.
  // List the authenticated user's GitHub repos via `gh`. Used by the
  // "Add project → from repo" picker so the user doesn't have to paste
  // a URL when gh is signed in.
  app.get("/projects/gh-repos", async (c) => {
    const stdout = await execCommand("gh", [
      "repo", "list",
      "--limit", "100",
      "--json", "nameWithOwner,description,sshUrl,url,updatedAt,isPrivate,isArchived",
    ]);
    if (!stdout) {
      return c.json({ ok: false, error: "gh not signed in or returned no repos" }, 401);
    }
    try {
      const repos = JSON.parse(stdout) as Array<{
        nameWithOwner: string;
        description: string | null;
        sshUrl: string;
        url: string;
        updatedAt: string;
        isPrivate: boolean;
        isArchived: boolean;
      }>;
      return c.json({ ok: true, data: repos.filter((r) => !r.isArchived) });
    } catch {
      return c.json({ ok: false, error: "Failed to parse gh output" }, 500);
    }
  });

  // Clone a remote repo into a polpo-managed location, then return the
  // resulting on-disk path so the UI can add it as a project. The clone
  // sits under <polpoDir>/repos/<basename>; safe under the implicit
  // allowed-roots whitelist that lives there too.
  app.post("/projects/clone", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url = String(body?.url ?? "").trim();
    if (!url) return c.json({ ok: false, error: "url required" }, 400);
    if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(url)) {
      return c.json({ ok: false, error: "Unsupported URL scheme" }, 400);
    }
    // Parse "owner/repo" out of GitHub URLs so we can hand the clone to
    // `gh` — it uses its own OAuth token instead of requiring an SSH key
    // (which is the most common dead-end for the SSH form).
    const ghMatch = url.match(/^(?:git@github\.com:|https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)(?:\.git)?$/);
    const ghTarget = ghMatch?.[1];
    const repoLeaf = (ghTarget ? ghTarget.split("/")[1] : url.split(/[\/:]/).pop()) ?? "repo";
    const slug = repoLeaf.replace(/\.git$/, "").replace(/[^a-zA-Z0-9._-]/g, "-") || "repo";
    const reposDir = `${getDeps().polpoDir}/repos`;
    const target = `${reposDir}/${slug}`;
    try {
      const fs = await import("node:fs");
      fs.mkdirSync(reposDir, { recursive: true });
      if (fs.existsSync(target)) {
        return c.json({ ok: false, error: `Already exists: ${target}` }, 409);
      }
      // Prefer `gh repo clone <owner/repo>` for github URLs (handles auth
      // via the user's gh token). Fall back to plain `git clone` otherwise.
      const r = ghTarget
        ? spawnSync("gh", ["repo", "clone", ghTarget, target], { encoding: "utf-8", timeout: 600_000 })
        : spawnSync("git", ["clone", "--", url, target], { encoding: "utf-8", timeout: 600_000 });
      if (r.status !== 0) {
        return c.json({ ok: false, error: (r.stderr || r.stdout || "clone failed").trim() }, 500);
      }
      return c.json({ ok: true, data: { path: target, name: slug } });
    } catch (err) {
      return c.json({ ok: false, error: err instanceof Error ? err.message : "clone failed" }, 500);
    }
  });

  app.get("/git-identity", async (c) => {
    const [name, email, ghUser, ghHost] = await Promise.all([
      execGit(["config", "--global", "user.name"]),
      execGit(["config", "--global", "user.email"]),
      execCommand("gh", ["api", "user", "-q", ".login"]),
      execCommand("gh", ["api", "user", "-q", ".html_url"]),
    ]);
    return c.json({
      ok: true,
      data: {
        git: { name: name || null, email: email || null },
        gh: ghUser ? { login: ghUser, url: ghHost || null } : null,
      },
    });
  });

  // ── Live process tracker ──
  // Lists every long-running OS process spawned through the polpo server
  // (terminal ptys + code-server children) and walks /proc to surface
  // their descendant tree (the user-launched `bun run dev`, `claude`, etc.).
  app.get("/processes", (c) => {
    const deps = getDeps();
    const handle = deps.getTerminalHandle?.();
    const terminals = handle?.listSessions() ?? [];
    const codeServers = deps.codeServerManager?.listSessions() ?? [];

    const rootPids = [
      ...terminals.map((t) => t.pid),
      ...codeServers.map((s) => s.pid),
    ].filter((n): n is number => typeof n === "number" && n > 0);
    const trees = describeTrees(rootPids, 4);
    const treeByPid = new Map(trees.map((t) => [t.pid, t]));

    const items = [
      ...terminals.map((t) => ({
        kind: "terminal" as const,
        id: t.id,
        pid: t.pid,
        cwd: t.cwd,
        agentKind: t.agentKind,
        agentCommand: t.agentCommand,
        startedAt: t.startedAt,
        clients: t.clients,
        tree: treeByPid.get(t.pid) ?? null,
      })),
      ...codeServers.map((s) => ({
        kind: "code-server" as const,
        id: s.id,
        pid: s.pid ?? null,
        cwd: s.cwd,
        port: s.port,
        startedAt: s.startedAt,
        running: s.running,
        tree: s.pid ? treeByPid.get(s.pid) ?? null : null,
      })),
    ];

    return c.json({ ok: true, data: { items, capturedAt: new Date().toISOString() } });
  });

  // DELETE /processes/<kind>/<id>  — kill a managed session (and, by way
  // of pty SIGHUP propagation, its descendants).
  app.delete("/processes/:kind/:id", async (c) => {
    const { kind, id } = c.req.param();
    const deps = getDeps();
    if (kind === "terminal") {
      const handle = deps.getTerminalHandle?.();
      const ok = handle?.killSession(id) ?? false;
      return c.json({ ok });
    }
    if (kind === "code-server") {
      const ok = (await deps.codeServerManager?.stopSession(id)) ?? false;
      return c.json({ ok });
    }
    return c.json({ ok: false, error: "unknown kind" }, 400);
  });

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

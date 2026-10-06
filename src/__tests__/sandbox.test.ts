import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { resolveSandbox, readsExternalContent, normalizeSandboxSettings, type EffectiveSandbox } from "@polpo-ai/core/sandbox";
import { BwrapWorkspace, LocalWorkspace, bwrapAvailable } from "../sandbox/workspaces.js";
import { WorkspaceShell, createWorkspace } from "../sandbox/manager.js";
import { hostAllowed } from "../sandbox/net-proxy.js";

const all = new Set(["local", "bwrap", "docker", "daytona", "e2b"] as const);

describe("sandbox cascade", () => {
  test("instance and agent set the sandbox; mission and task may only tighten", () => {
    const out = resolveSandbox({
      instance: { provider: "bwrap", allowedProviders: ["bwrap", "docker", "e2b"], network: { mode: "allowlist", allow: ["github.com", "*.npmjs.org"] }, resources: { memoryMb: 2048 } },
      mission: { provider: "local", network: { mode: "open" }, resources: { memoryMb: 8192 } },
      task: { network: { mode: "allowlist", allow: ["github.com", "evil.com"] } },
    }, { scope: "task", available: all });
    expect(out.provider).toBe("bwrap");
    expect(out.network).toEqual({ mode: "allowlist", allow: ["github.com"] });
    expect(out.resources.memoryMb).toBe(2048);
    expect(out.denied.map((d) => `${d.level}.${d.field}`)).toEqual(["mission.provider", "mission.network", "mission.resources.memoryMb", "task.network"]);
  });

  test("a stronger, allowed provider is accepted from a task", () => {
    const out = resolveSandbox({ instance: { provider: "bwrap", allowedProviders: ["bwrap", "e2b"] }, task: { provider: "e2b", network: { mode: "deny" } } }, { scope: "task", available: all });
    expect(out.provider).toBe("e2b");
    expect(out.network.mode).toBe("deny");
    expect(out.denied).toEqual([]);
  });

  test("agents that read external content never run unconfined unless a person allows it", () => {
    expect(readsExternalContent(["read", "browser_navigate"])).toBe(true);
    expect(readsExternalContent(["read", "write", "bash"])).toBe(false);
    expect(readsExternalContent(["email_*"])).toBe(true);
    expect(readsExternalContent(undefined)).toBe(true); // no list: core tools include http_fetch
    expect(readsExternalContent([])).toBe(false);
    // opt-in: without the instance switch everything stays where it is configured (default: this machine)
    expect(resolveSandbox({}, { scope: "task", agentTools: ["http_fetch"], available: all }).provider).toBe("local");
    expect(resolveSandbox({}, { scope: "task", agentTools: undefined, available: all }).provider).toBe("local");
    const confined = resolveSandbox({ instance: { provider: "local", confineExternalContent: true } }, { scope: "task", agentTools: ["http_fetch"], available: all });
    expect(confined.provider).toBe("bwrap");
    const allowed = resolveSandbox({ instance: { confineExternalContent: true }, agent: { allowLocal: true } }, { scope: "task", agentTools: ["http_fetch"], available: all });
    expect(allowed.provider).toBe("local");
    expect(resolveSandbox({ instance: { confineExternalContent: true } }, { scope: "task", agentTools: ["read", "bash"], available: all }).provider).toBe("local");
  });

  test("chats stay on this machine; unavailable providers fall back to stronger local isolation", () => {
    expect(resolveSandbox({ agent: { provider: "e2b" } }, { scope: "chat", available: all }).provider).toBe("docker");
    expect(resolveSandbox({ agent: { provider: "e2b" } }, { scope: "chat", available: new Set(["local", "bwrap"] as const) }).provider).toBe("bwrap");
    expect(resolveSandbox({ agent: { provider: "docker" } }, { scope: "task", available: new Set(["local", "bwrap"] as const) }).provider).toBe("bwrap");
  });

  test("settings are normalized: unknown keys and bad values dropped", () => {
    expect(normalizeSandboxSettings({ provider: "bwrap", network: { mode: "allowlist", allow: [" a.com ", 3] }, resources: { memoryMb: -1, cpus: 2 }, junk: true }))
      .toEqual({ provider: "bwrap", network: { mode: "allowlist", allow: ["a.com"] }, resources: { cpus: 2 } });
    expect(normalizeSandboxSettings({ provider: "nope" })).toBeUndefined();
  });

  test("allowlist matching", () => {
    expect(hostAllowed("registry.npmjs.org", ["*.npmjs.org"])).toBe(true);
    expect(hostAllowed("npmjs.org", ["*.npmjs.org"])).toBe(true);
    expect(hostAllowed("evilnpmjs.org", ["*.npmjs.org"])).toBe(false);
    expect(hostAllowed("GitHub.com.", ["github.com"])).toBe(true);
  });
});

const sandbox = (network: EffectiveSandbox["network"]): EffectiveSandbox => ({ provider: "bwrap", network, resources: {}, providerOptions: {}, denied: [] });

describe.skipIf(!bwrapAvailable())("bubblewrap workspace", () => {
  let root: string;
  let secretDir: string;
  let server: Server;
  let port = 0;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "polpo-sbx-root-"));
    secretDir = mkdtempSync(join(tmpdir(), "polpo-sbx-secret-"));
    writeFileSync(join(secretDir, "vault.key"), "TOP-SECRET");
    server = createServer((_req, res) => res.end("hello from the host"));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    rmSync(root, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
    await new Promise<void>((r) => server.close(() => r()));
  });

  test("sees and writes its working directory, not the home or other paths", async () => {
    const ws = new BwrapWorkspace({ root, sandbox: sandbox({ mode: "deny" }) });
    const result = await ws.exec(`echo ok > made.txt; ls ${JSON.stringify(homedir())} 2>&1; cat ${JSON.stringify(join(secretDir, "vault.key"))} 2>&1; echo "env:$(env | grep -c DATABASE_URL)"`);
    expect(readFileSync(join(root, "made.txt"), "utf8").trim()).toBe("ok");
    expect(result.stdout).not.toContain("TOP-SECRET");
    expect(result.stdout).toContain("No such file or directory");
    expect(result.stdout).toContain("env:0");
    await ws.dispose();
  });

  test("read-only paths can be read but not written", async () => {
    const shared = mkdtempSync(join(tmpdir(), "polpo-sbx-ro-"));
    writeFileSync(join(shared, "doc.txt"), "shared");
    const ws = new BwrapWorkspace({ root, readable: [shared], sandbox: sandbox({ mode: "deny" }) });
    const result = await ws.exec(`cat ${shared}/doc.txt; echo x > ${shared}/new.txt 2>&1 || echo WRITE-DENIED`);
    expect(result.stdout).toContain("shared");
    expect(result.stdout).toContain("WRITE-DENIED");
    rmSync(shared, { recursive: true, force: true });
  });

  test(".polpo inside the working directory stays hidden; granted paths inside it keep their mode", async () => {
    const project = mkdtempSync(join(tmpdir(), "polpo-sbx-project-"));
    const polpoDir = join(project, ".polpo");
    const output = join(polpoDir, "output", "t1");
    const skills = join(polpoDir, "skills");
    const mount = join(polpoDir, "mounts", "docs");
    for (const dir of [output, skills, mount]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(polpoDir, "polpo.json"), "{\"botToken\":\"SECRET\"}");
    writeFileSync(join(polpoDir, ".env"), "KEY=SECRET");
    writeFileSync(join(skills, "run.sh"), "echo skill-ok");
    writeFileSync(join(mount, "readme.txt"), "bucket");
    const ws = new BwrapWorkspace({
      root: project,
      writable: [output],
      readable: [skills],
      mounts: [{ name: "docs", path: mount, hostPath: mount, readOnly: true }],
      hide: [polpoDir],
      sandbox: sandbox({ mode: "deny" }),
    });
    const r = await ws.exec([
      `cat ${polpoDir}/polpo.json 2>&1 || true`, `cat ${polpoDir}/.env 2>&1 || true`,
      `echo done > ${output}/result.txt`, `bash ${skills}/run.sh`, `echo x > ${skills}/new 2>/dev/null || echo SKILLS-RO`,
      `cat ${mount}/readme.txt`, `echo x > ${mount}/new 2>/dev/null || echo MOUNT-RO`, "echo top > top.txt",
    ].join("; "));
    expect(r.stdout).not.toContain("SECRET");
    expect(readFileSync(join(output, "result.txt"), "utf8").trim()).toBe("done");
    expect(readFileSync(join(project, "top.txt"), "utf8").trim()).toBe("top");
    for (const marker of ["skill-ok", "SKILLS-RO", "bucket", "MOUNT-RO"]) expect(r.stdout).toContain(marker);
    rmSync(project, { recursive: true, force: true });
  });

  test("network deny: no connection at all", async () => {
    const ws = new BwrapWorkspace({ root, sandbox: sandbox({ mode: "deny" }) });
    const result = await ws.exec(`curl -s -m 3 http://127.0.0.1:${port}/ || echo NO-NET`);
    expect(result.stdout).toContain("NO-NET");
  });

  test("network allowlist: allowed hosts through the proxy, others refused", async () => {
    const denied: string[] = [];
    const ws = new BwrapWorkspace({ root, sandbox: sandbox({ mode: "allowlist", allow: ["127.0.0.1"] }), onNetworkDenied: (h) => denied.push(h) });
    const env = { NO_PROXY: "", no_proxy: "" };
    const ok = await ws.exec(`curl -s -m 5 http://127.0.0.1:${port}/`, { env });
    expect(ok.stdout).toBe("hello from the host");
    const blocked = await ws.exec(`curl -s -m 5 http://example.com/ ; echo`, { env });
    expect(blocked.stdout).toContain("not in the network allowlist");
    expect(denied).toContain("example.com");
    await ws.dispose();
  });

  test("timeouts kill the command", async () => {
    const ws = new BwrapWorkspace({ root, sandbox: sandbox({ mode: "deny" }) });
    const result = await ws.exec("sleep 10", { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test("the Shell adapter runs the system tools' commands in the workspace", async () => {
    const ws = createWorkspace(sandbox({ mode: "deny" }), { root });
    const shell = new WorkspaceShell(ws);
    const out = await shell.execute("pwd; echo $HOME", { cwd: root });
    expect(out.exitCode).toBe(0);
    expect(out.stdout.split("\n")[0]).toBe(root);
  });
});

describe("local workspace", () => {
  test("runs with the filtered environment", async () => {
    const root = mkdtempSync(join(tmpdir(), "polpo-local-"));
    mkdirSync(root, { recursive: true });
    const ws = new LocalWorkspace({ root, sandbox: { provider: "local", network: { mode: "open" }, resources: {}, providerOptions: {}, denied: [] } }, () => ({ PATH: "/usr/bin:/bin" }));
    const result = await ws.exec("pwd; env | grep -c DATABASE_URL || true");
    expect(result.stdout).toContain(root);
    expect(result.stdout.trim().endsWith("0")).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("file tools never reach .polpo through a broader grant", () => {
  test("protected paths", async () => {
    const { isPathAllowed, setProtectedPaths } = await import("../tools/path-sandbox.js");
    const project = mkdtempSync(join(tmpdir(), "polpo-guard-"));
    const polpoDir = join(project, ".polpo");
    for (const d of ["output/t1", "mounts/docs", "mounts/other", "skills", "tmp/tool-output/a"]) mkdirSync(join(polpoDir, d), { recursive: true });
    setProtectedPaths([polpoDir], [join(polpoDir, "tmp", "tool-output"), join(polpoDir, "skills")]);
    try {
      const allowed = [project, join(polpoDir, "output/t1"), join(polpoDir, "mounts/docs")];
      expect(isPathAllowed(join(project, "notes.md"), allowed)).toBe(true);
      expect(isPathAllowed(join(polpoDir, "polpo.json"), allowed)).toBe(false);
      expect(isPathAllowed(join(polpoDir, ".env"), allowed)).toBe(false);
      expect(isPathAllowed(join(polpoDir, "mounts/other/x"), allowed)).toBe(false);
      expect(isPathAllowed(join(polpoDir, "mounts/docs/x"), allowed)).toBe(true);
      expect(isPathAllowed(join(polpoDir, "output/t1/report.md"), allowed)).toBe(true);
      expect(isPathAllowed(join(polpoDir, "tmp/tool-output/a/out.txt"), allowed)).toBe(true);
      expect(isPathAllowed(join(polpoDir, "skills/s/SKILL.md"), allowed)).toBe(true);
      expect(isPathAllowed(join(project, "..", "elsewhere"), allowed)).toBe(false);
    } finally {
      setProtectedPaths([]);
      rmSync(project, { recursive: true, force: true });
    }
  });
});

describe("agents are told about their sandbox", () => {
  test("prompt note", async () => {
    const { sandboxPromptNote } = await import("../adapters/engine.js");
    expect(sandboxPromptNote(undefined, [])).toBe("");
    expect(sandboxPromptNote({ provider: "local", network: { mode: "open" }, resources: {}, providerOptions: {}, denied: [] }, [])).toBe("");
    const note = sandboxPromptNote(
      { provider: "bwrap", network: { mode: "allowlist", allow: ["github.com"] }, resources: { timeoutMin: 10 }, providerOptions: {}, denied: [] },
      [{ name: "docs", path: "/p/.polpo/mounts/docs", hostPath: "/p/.polpo/mounts/docs", readOnly: true }],
    );
    expect(note).toContain("## Sandbox");
    expect(note).toContain("github.com");
    expect(note).toContain("10 min per command");
    expect(note).toContain('storage "docs": /p/.polpo/mounts/docs (read-only)');
  });
});

describe("Polpo's tools", () => {
  function fakePolpo(agent: Record<string, unknown>) {
    const agents = [agent];
    return {
      agents,
      getAgents: async () => agents,
      getConfig: () => ({ settings: { sandbox: { network: { mode: "allowlist", allow: ["github.com"] } } } }),
      updateAgent: async (name: string, updates: Record<string, unknown>) => { Object.assign(agents[0]!, updates); return agents[0]; },
    } as any;
  }

  test("update_agent sets a sandbox but never turns on running without isolation", async () => {
    const { executeOrchestratorTool } = await import("../llm/orchestrator-tools.js");
    const polpo = fakePolpo({ name: "dev", allowedTools: ["read", "bash"] });
    const out = await executeOrchestratorTool("update_agent", { name: "dev", sandbox: { provider: "bwrap", network: { mode: "deny" }, allowLocal: true } }, polpo);
    expect(polpo.agents[0].sandbox).toEqual({ provider: "bwrap", network: { mode: "deny" } });
    expect(out).toContain("can only be allowed by a person");
    await executeOrchestratorTool("update_agent", { name: "dev", sandbox: { inherit: true } }, polpo);
    expect(polpo.agents[0].sandbox).toBeUndefined();
  });

  test("inherit keeps a person's choice to run without isolation", async () => {
    const { executeOrchestratorTool } = await import("../llm/orchestrator-tools.js");
    const polpo = fakePolpo({ name: "dev", sandbox: { allowLocal: true, provider: "local", network: { mode: "open" } } });
    await executeOrchestratorTool("update_agent", { name: "dev", sandbox: { network: { mode: "deny" } } }, polpo);
    expect(polpo.agents[0].sandbox).toEqual({ allowLocal: true, provider: "local", network: { mode: "deny" } });
    await executeOrchestratorTool("update_agent", { name: "dev", sandbox: { inherit: true } }, polpo);
    expect(polpo.agents[0].sandbox).toEqual({ allowLocal: true });
  });

  test("sandbox_status explains where commands run", async () => {
    const { executeOrchestratorTool } = await import("../llm/orchestrator-tools.js");
    const out = await executeOrchestratorTool("sandbox_status", {}, fakePolpo({ name: "web", allowedTools: ["http_fetch"] }));
    expect(out).toContain("Available on this server");
    expect(out).toMatch(/- web: tasks (bwrap|local), network allowlist \[github.com\]/);
  });
});

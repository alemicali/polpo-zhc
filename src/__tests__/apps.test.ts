import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { normalizeAppTags, type CreateRegisteredApp } from "../core/app-registry.js";
import { ALL_ORCHESTRATOR_TOOLS, READ_TOOLS, WRITE_TOOLS } from "../llm/orchestrator-tools.js";
import { AppRuntimeManager, appRuntimePath, resolveAppCwd } from "../server/app-runtime-manager.js";
import { appsRoutes } from "../server/routes/apps.js";
import { FileAppRegistryStore } from "../stores/file-app-registry-store.js";

describe("app registry", () => {
  let root: string;
  let project: string;
  let store: FileAppRegistryStore;
  let runtime: AppRuntimeManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "polpo-apps-"));
    project = join(root, "project");
    await mkdir(project);
    store = new FileAppRegistryStore(join(root, ".polpo"));
    runtime = new AppRuntimeManager(store);
  });

  afterEach(async () => {
    await runtime.stopApp("app_test");
    await rm(root, { recursive: true, force: true });
  });

  test("persists CRUD records atomically", async () => {
    const app = await store.create(appInput(project));
    expect((await store.list()).map((item) => item.slug)).toEqual(["test-app"]);

    await store.update(app.id, { description: "Updated" });
    expect((await store.get("test-app"))?.description).toBe("Updated");
    expect(JSON.parse(await readFile(join(root, ".polpo", "apps.json"), "utf8"))).toMatchObject({ version: 1 });

    expect(await store.delete(app.id)).toBe(true);
    expect(await store.get(app.id)).toBeNull();
  });

  test("normalizes app tags without case-insensitive duplicates", () => {
    expect(normalizeAppTags([" frontend ", "Internal Tools", "FRONTEND", "", "internal   tools", "api"]))
      .toEqual(["api", "frontend", "Internal Tools"]);
  });

  test("rejects service working directories outside the app root", () => {
    expect(resolveAppCwd(project, "packages/web")).toBe(join(project, "packages/web"));
    expect(() => resolveAppCwd(project, "../outside")).toThrow("inside the app root");
  });

  test("adds user package-manager binaries to service PATH", () => {
    expect(appRuntimePath("/home/test", ["/usr/bin", "/bin"].join(delimiter)).split(delimiter)).toEqual([
      "/home/test/.bun/bin",
      "/home/test/.local/bin",
      "/home/test/.npm-global/bin",
      "/home/test/.local/share/pnpm",
      "/usr/bin",
      "/bin",
    ]);
  });

  test("starts and stops a service process group while retaining logs", async () => {
    await store.create(appInput(project, {
      services: [{ id: "web", name: "Web", kind: "frontend", command: "node -e 'console.log(\"ready\"); setInterval(() => {}, 1000)'" }],
    }));

    const started = await runtime.startService("app_test", "web");
    expect(started.pid).toBeTypeOf("number");
    await waitFor(() => runtime.get("app_test", "service", "web")?.logs.some((line) => line.text === "ready") === true);
    expect(await runtime.stop("app_test", "service", "web")).toBe(true);
    expect(runtime.get("app_test", "service", "web")?.status).toBe("cancelled");
  });

  test("runs deployments and persists their result", async () => {
    await store.create(appInput(project, {
      deployments: [{ id: "production", name: "Production", environment: "production", command: "printf deployed" }],
    }));

    await runtime.runDeployment("app_test", "production");
    await waitFor(() => runtime.get("app_test", "deployment", "production")?.status === "succeeded");
    await waitFor(async () => (await store.get("app_test"))?.deployments[0]?.lastRun?.status === "succeeded");
    expect(runtime.get("app_test", "deployment", "production")?.logs.some((line) => line.text === "deployed")).toBe(true);
  });

  test("coordinates app lifecycle using autoStart services", async () => {
    await store.create(appInput(project, {
      services: [
        { id: "web", name: "Web", kind: "frontend", command: "node -e 'setInterval(() => {}, 1000)'", autoStart: true },
        { id: "worker", name: "Worker", kind: "worker", command: "node -e 'setInterval(() => {}, 1000)'", autoStart: false },
      ],
    }));

    const result = await runtime.startApp("app_test");
    expect(result.errors).toEqual([]);
    expect(result.statuses.map((item) => item.resourceId)).toEqual(["web"]);
    expect(runtime.get("app_test", "service", "worker")).toBeNull();
    await runtime.stopApp("app_test");
    expect(runtime.get("app_test", "service", "web")?.status).toBe("cancelled");
  });

  test("exposes CRUD and runtime routes", async () => {
    const routes = appsRoutes(() => ({ store, runtime }));
    const created = await routes.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(appInput(project)),
    });
    expect(created.status).toBe(201);
    const listed = await routes.request("/");
    const body = await listed.json() as any;
    expect(body.data[0]).toMatchObject({ slug: "test-app", runtime: [] });
    expect(body.data[0].id).toEqual(expect.any(String));
  });

  test("advertises app tools with appropriate approval semantics", () => {
    for (const name of ["list_apps", "get_app"]) {
      expect(READ_TOOLS.has(name)).toBe(true);
      expect(ALL_ORCHESTRATOR_TOOLS.some((tool) => tool.name === name)).toBe(true);
    }
    for (const name of [
      "register_app", "update_app_registry", "tag_app", "remove_app_registry",
      "configure_app_service", "configure_app_deployment", "configure_app_domain",
      "control_app", "control_app_service", "run_app_deployment", "capture_app_screenshot",
    ]) {
      expect(WRITE_TOOLS.has(name)).toBe(true);
      expect(ALL_ORCHESTRATOR_TOOLS.some((tool) => tool.name === name)).toBe(true);
    }
  });
});

function appInput(project: string, overrides: Partial<CreateRegisteredApp> = {}): CreateRegisteredApp {
  return {
    id: "app_test",
    name: "Test App",
    slug: "test-app",
    localPath: project,
    tags: [],
    services: [],
    deployments: [],
    domains: [],
    ...overrides,
  };
}

async function waitFor(check: () => boolean | Promise<boolean>, timeout = 3_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition");
}

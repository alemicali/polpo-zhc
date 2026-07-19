import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join, resolve, relative, sep } from "node:path";
import type {
  AppDeployment,
  AppRegistryStore,
  AppRuntimeLog,
  AppRuntimeStatus,
  AppService,
  RegisteredApp,
} from "../core/app-registry.js";
import { FileAppRegistryStore } from "../stores/file-app-registry-store.js";

type Runtime = AppRuntimeStatus & { process: ChildProcessWithoutNullStreams };
const MAX_LOGS = 600;

export class AppRuntimeManager {
  private readonly runtimes = new Map<string, Runtime>();
  private sequence = 0;

  constructor(private readonly store: AppRegistryStore) {}

  list(appId?: string): AppRuntimeStatus[] {
    return [...this.runtimes.values()]
      .filter((runtime) => !appId || runtime.appId === appId)
      .map((runtime) => this.publicStatus(runtime));
  }

  get(appId: string, kind: "service" | "deployment", resourceId: string): AppRuntimeStatus | null {
    const runtime = this.runtimes.get(this.key(appId, kind, resourceId));
    return runtime ? this.publicStatus(runtime) : null;
  }

  async startService(appId: string, serviceId: string): Promise<AppRuntimeStatus> {
    const app = await this.requireApp(appId);
    const service = app.services.find((item) => item.id === serviceId);
    if (!service) throw new Error(`Service "${serviceId}" not found`);
    return this.start(app, "service", service, service.command, service.cwd);
  }

  async runDeployment(appId: string, deploymentId: string): Promise<AppRuntimeStatus> {
    const app = await this.requireApp(appId);
    const deployment = app.deployments.find((item) => item.id === deploymentId);
    if (!deployment) throw new Error(`Deployment "${deploymentId}" not found`);
    const status = await this.start(app, "deployment", deployment, deployment.command, deployment.cwd);
    await this.persistDeploymentRun(app, deployment, status);
    return status;
  }

  async restartService(appId: string, serviceId: string): Promise<AppRuntimeStatus> {
    await this.stop(appId, "service", serviceId);
    return this.startService(appId, serviceId);
  }

  async startApp(appId: string): Promise<{ statuses: AppRuntimeStatus[]; errors: string[] }> {
    const app = await this.requireApp(appId);
    const autoStart = app.services.filter((service) => service.autoStart);
    const services = autoStart.length > 0 ? autoStart : app.services;
    const results = await Promise.allSettled(services.map((service) => this.startService(app.id, service.id)));
    return {
      statuses: results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
      errors: results.flatMap((result) => result.status === "rejected" ? [errorMessage(result.reason)] : []),
    };
  }

  async restartApp(appId: string): Promise<{ statuses: AppRuntimeStatus[]; errors: string[] }> {
    await this.stopApp(appId);
    return this.startApp(appId);
  }

  async stop(appId: string, kind: "service" | "deployment", resourceId: string): Promise<boolean> {
    const key = this.key(appId, kind, resourceId);
    const runtime = this.runtimes.get(key);
    if (!runtime || runtime.process.exitCode != null) return false;
    this.append(runtime, "system", "Stopping process");
    runtime.status = "cancelled";
    await new Promise<void>((done) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        done();
      };
      const timeout = setTimeout(() => {
        this.signal(runtime, "SIGKILL");
        finish();
      }, 3_000);
      runtime.process.once("exit", finish);
      this.signal(runtime, "SIGTERM");
    });
    return true;
  }

  async stopApp(appId: string): Promise<void> {
    await Promise.all(this.list(appId)
      .filter((runtime) => runtime.status === "running" || runtime.status === "starting")
      .map((runtime) => this.stop(appId, runtime.kind, runtime.resourceId)));
  }

  private async start(
    app: RegisteredApp,
    kind: "service" | "deployment",
    resource: AppService | AppDeployment,
    command: string,
    cwdValue?: string,
  ): Promise<AppRuntimeStatus> {
    const key = this.key(app.id, kind, resource.id);
    const existing = this.runtimes.get(key);
    if (existing && existing.process.exitCode == null) return this.publicStatus(existing);
    const cwd = resolveAppCwd(app.localPath, cwdValue);
    const child = spawn("bash", ["-lc", command], {
      cwd,
      detached: process.platform !== "win32",
      env: { ...process.env, PATH: appRuntimePath(), POLPO_APP_ID: app.id, POLPO_APP_SLUG: app.slug },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.end();
    const runtime: Runtime = {
      key,
      kind,
      appId: app.id,
      resourceId: resource.id,
      status: "starting",
      pid: child.pid,
      startedAt: new Date().toISOString(),
      logs: [],
      process: child,
    };
    this.runtimes.set(key, runtime);
    this.append(runtime, "system", `Started ${command}`);
    child.stdout.on("data", (chunk) => this.append(runtime, "stdout", String(chunk)));
    child.stderr.on("data", (chunk) => this.append(runtime, "stderr", String(chunk)));
    child.once("spawn", () => {
      if (runtime.status === "starting") runtime.status = "running";
    });
    child.once("error", (error) => {
      runtime.status = "failed";
      runtime.error = error.message;
      runtime.finishedAt = new Date().toISOString();
      this.append(runtime, "system", error.message);
    });
    child.once("exit", (code, signal) => {
      runtime.exitCode = code ?? undefined;
      runtime.finishedAt = new Date().toISOString();
      if (runtime.status !== "cancelled") runtime.status = code === 0 ? "succeeded" : "failed";
      if (signal) runtime.error = `Exited with signal ${signal}`;
      this.append(runtime, "system", code === null ? `Exited with signal ${signal}` : `Exited with code ${code}`);
      if (kind === "deployment") void this.finishDeployment(app.id, resource.id, runtime);
    });
    return this.publicStatus(runtime);
  }

  private async requireApp(id: string): Promise<RegisteredApp> {
    const app = await this.store.get(id);
    if (!app) throw new Error(`App "${id}" not found`);
    return app;
  }

  private append(runtime: Runtime, stream: AppRuntimeLog["stream"], text: string): void {
    for (const line of text.replace(/\r/g, "").split("\n").filter(Boolean)) {
      runtime.logs.push({ seq: ++this.sequence, at: new Date().toISOString(), stream, text: line });
    }
    if (runtime.logs.length > MAX_LOGS) runtime.logs.splice(0, runtime.logs.length - MAX_LOGS);
  }

  private signal(runtime: Runtime, signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && runtime.pid) process.kill(-runtime.pid, signal);
      else runtime.process.kill(signal);
    } catch {
      runtime.process.kill(signal);
    }
  }

  private key(appId: string, kind: "service" | "deployment", resourceId: string): string {
    return `${appId}:${kind}:${resourceId}`;
  }

  private publicStatus(runtime: Runtime): AppRuntimeStatus {
    const { process: _process, ...status } = runtime;
    return { ...status, logs: [...status.logs] };
  }

  private async persistDeploymentRun(app: RegisteredApp, deployment: AppDeployment, status: AppRuntimeStatus): Promise<void> {
    const deployments = app.deployments.map((item) => item.id === deployment.id
      ? { ...item, lastRun: { status: "running" as const, startedAt: status.startedAt } }
      : item);
    await this.store.update(app.id, { deployments });
  }

  private async finishDeployment(appId: string, deploymentId: string, runtime: Runtime): Promise<void> {
    const app = await this.store.get(appId);
    if (!app) return;
    const deployments = app.deployments.map((item) => item.id === deploymentId ? {
      ...item,
      lastRun: {
        status: runtime.status === "succeeded" ? "succeeded" as const : runtime.status === "cancelled" ? "cancelled" as const : "failed" as const,
        startedAt: runtime.startedAt,
        finishedAt: runtime.finishedAt,
        exitCode: runtime.exitCode,
        error: runtime.error,
      },
    } : item);
    await this.store.update(app.id, { deployments });
  }
}

export function resolveAppCwd(root: string, requested?: string): string {
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, requested || ".");
  const rel = relative(absoluteRoot, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Working directory must stay inside the app root");
  return candidate;
}

export function appRuntimePath(home = process.env.HOME || homedir(), current = process.env.PATH || ""): string {
  const paths = [
    join(home, ".bun", "bin"),
    join(home, ".local", "bin"),
    join(home, ".npm-global", "bin"),
    join(home, ".local", "share", "pnpm"),
    ...current.split(delimiter),
  ].filter(Boolean);
  return [...new Set(paths)].join(delimiter);
}

const registries = new Map<string, { store: FileAppRegistryStore; runtime: AppRuntimeManager }>();

export function getAppRegistryRuntime(polpoDir: string): { store: FileAppRegistryStore; runtime: AppRuntimeManager } {
  let registry = registries.get(polpoDir);
  if (!registry) {
    const store = new FileAppRegistryStore(polpoDir);
    registry = { store, runtime: new AppRuntimeManager(store) };
    registries.set(polpoDir, registry);
  }
  return registry;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

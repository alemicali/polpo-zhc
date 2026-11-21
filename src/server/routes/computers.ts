/**
 * Computers: persistent machines agents work on (settings.computers), for the dashboard, Polpo
 * and API clients. Mounted under the authenticated API (/api/v1/computers).
 *
 *   GET    /computers                 list, with live status (?live=0: the last known status) and the agents using each
 *   POST   /computers                 create { id, name, kind, image?, snapshot?, template?, resources?, lifecycle?, network?, egress?, volumes?, start? }
 *   GET    /computers/:id
 *   PATCH  /computers/:id             change name, description, image/snapshot/template, resources, lifecycle, network, egress, volumes (id and kind stay)
 *   DELETE /computers/:id             { confirm: true }: deletes the machine and its disk, and the computer
 *   POST   /computers/:id/start       start or resume it (created if it has no machine yet)
 *   POST   /computers/:id/stop        stop (Daytona container) or pause (E2B, Daytona VM); never deletes
 *   POST   /computers/:id/restart
 *   POST   /computers/:id/reset       { confirm: true }: delete the machine and create a new one (its disk is lost)
 *   GET    /computers/:id/egress      a remote computer's egress through Tailscale: tailnet up/down, node, path (direct/DERP),
 *                                     proxy reachable, where its browser goes out now (looks inside only a running machine)
 *
 * "host" (this server) is listed as a built-in computer; it cannot be changed, started or stopped.
 * Machines are created on first use (an agent's chat or task) or on start, never on every call.
 */
import { Hono, type Context } from "hono";
import {
  ComputerConfigError, HOST_COMPUTER, HOST_COMPUTER_ID, computerEgressProblem, computerProviderProblem, computerUsers, isRemoteComputer, parseComputer,
  type AgentConfig, type ComputerConfig, type EffectiveSandbox, type PolpoEventMap, type PolpoSettings,
} from "@polpo-ai/core";
import { computerEgressStatus, type ComputerLive, type ComputerManager } from "../../sandbox/computers.js";

export interface ComputerRouteDeps {
  computers: () => ComputerConfig[];
  settings: () => PolpoSettings | undefined;
  agents: () => Promise<AgentConfig[]>;
  manager: () => ComputerManager;
  /** Write settings.computers to polpo.json and reload the configuration. */
  save: (computers: ComputerConfig[]) => Promise<void>;
  /** The sandbox a computer's machine is created with, or why it cannot be (no API key). */
  sandboxFor: (computer: ComputerConfig) => EffectiveSandbox | { error: string };
  emit: (payload: PolpoEventMap["computer:changed"]) => void;
  /** The instance's name (the project): part of the computers' node names in the tailnet. */
  instance?: () => string | undefined;
}

const LIVE_TIMEOUT_MS = 8_000;

type View = ComputerConfig & ComputerLive & { builtin?: boolean; agents: { name: string; isDefault: boolean }[] };

function fail(c: Context, status: 400 | 404 | 409 | 500 | 502, error: string, code?: string) {
  return c.json({ ok: false, error, ...(code ? { code } : {}) }, status);
}

export function computerRoutes(deps: ComputerRouteDeps): Hono {
  const app = new Hono();

  const find = (id: string): ComputerConfig | undefined => id === HOST_COMPUTER_ID ? HOST_COMPUTER : deps.computers().find((c) => c.id === id);

  /** The Daytona snapshot a new machine of this computer comes from (to report an inactive one). */
  const snapshotOf = (computer: ComputerConfig): string | undefined => {
    if (computer.kind !== "daytona") return undefined;
    const s = deps.sandboxFor(computer);
    return "error" in s || typeof s.providerOptions.snapshot !== "string" ? undefined : s.providerOptions.snapshot;
  };

  /** Live status from the provider, or the last known one when it does not answer in time. */
  const liveOf = async (computer: ComputerConfig, live: boolean): Promise<ComputerLive> => {
    if (!isRemoteComputer(computer)) return { id: computer.id, status: "running", uptimeMinutes: 0 };
    const manager = deps.manager();
    if (!live) return manager.live(computer.id);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<ComputerLive>((resolve) => { timer = setTimeout(() => resolve(manager.live(computer.id)), LIVE_TIMEOUT_MS); });
    try {
      return await Promise.race([manager.refresh(computer, snapshotOf(computer)).catch((err) => ({ ...manager.live(computer.id), status: "unknown" as const, lastError: (err as Error).message })), late]);
    } finally {
      clearTimeout(timer);
    }
  };

  const view = async (computer: ComputerConfig, live = true, agents?: AgentConfig[]): Promise<View> => {
    const all = agents ?? await deps.agents();
    const users = computer.id === HOST_COMPUTER_ID
      ? all.filter((a) => !a.defaultComputer || a.defaultComputer === HOST_COMPUTER_ID).map((a) => ({ name: a.name, isDefault: true }))
      : computerUsers(computer.id, all);
    return { ...computer, ...(await liveOf(computer, live)), ...(computer.id === HOST_COMPUTER_ID ? { builtin: true } : {}), agents: users };
  };

  /** The sandbox to create/start a machine with, or an error response. */
  const sandbox = (c: Context, computer: ComputerConfig): EffectiveSandbox | Response => {
    const s = deps.sandboxFor(computer);
    return "error" in s ? fail(c, 409, s.error, "PROVIDER_UNAVAILABLE") : s;
  };


  const operationError = (c: Context, what: string, err: unknown) =>
    fail(c, 502, `${what} failed: ${err instanceof Error ? err.message : String(err)}`, "PROVIDER_ERROR");

  app.get("/", async (c) => {
    const live = c.req.query("live") !== "0";
    const agents = await deps.agents();
    const computers = await Promise.all([HOST_COMPUTER, ...deps.computers()].map((computer) => view(computer, live, agents)));
    return c.json({ ok: true, data: { computers } });
  });

  app.get("/:id", async (c) => {
    const computer = find(c.req.param("id"));
    if (!computer) return fail(c, 404, `There is no computer "${c.req.param("id")}"`, "NOT_FOUND");
    return c.json({ ok: true, data: await view(computer, c.req.query("live") !== "0") });
  });

  app.post("/", async (c) => {
    const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    let computer: ComputerConfig;
    try {
      computer = parseComputer(body);
    } catch (err) {
      return fail(c, 400, (err as Error).message, "VALIDATION_ERROR");
    }
    const existing = deps.computers();
    if (existing.some((x) => x.id === computer.id)) return fail(c, 409, `A computer "${computer.id}" already exists`, "CONFLICT");
    const egressError = checkEgress(computer, deps.settings());
    if (egressError) return fail(c, 400, egressError, "VALIDATION_ERROR");
    await deps.save([...existing, computer]);
    deps.emit({ id: computer.id, action: "created", status: isRemoteComputer(computer) ? "missing" : "running" });
    if (body.start === true && isRemoteComputer(computer)) {
      const s = sandbox(c, computer);
      if (s instanceof Response) return s;
      // the manager announces the status changes (computer:changed)
      try { await deps.manager().start(computer, s); }
      catch (err) { return operationError(c, `Starting computer "${computer.id}"`, err); }
    }
    return c.json({ ok: true, data: await view(computer, false) }, 201);
  });

  app.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (id === HOST_COMPUTER_ID) return fail(c, 400, "\"host\" is this server: it cannot be changed", "VALIDATION_ERROR");
    const existing = deps.computers();
    const current = existing.find((x) => x.id === id);
    if (!current) return fail(c, 404, `There is no computer "${id}"`, "NOT_FOUND");
    const patch = await c.req.json().catch(() => ({})) as Record<string, unknown>;
    if (patch.id !== undefined && patch.id !== id) return fail(c, 400, "A computer's id cannot change (create a new one)", "VALIDATION_ERROR");
    if (patch.kind !== undefined && patch.kind !== current.kind) return fail(c, 400, "A computer's kind cannot change (create a new one)", "VALIDATION_ERROR");
    // null clears a field
    const merged: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(patch)) {
      if (k === "id" || k === "kind") continue;
      if (v === null) delete merged[k];
      else merged[k] = v;
    }
    let next: ComputerConfig;
    try {
      next = parseComputer(merged);
    } catch (err) {
      return fail(c, 400, (err as Error).message, "VALIDATION_ERROR");
    }
    const egressError = checkEgress(next, deps.settings());
    if (egressError) return fail(c, 400, egressError, "VALIDATION_ERROR");
    await deps.save(existing.map((x) => (x.id === id ? next : x)));
    deps.emit({ id, action: "updated" });
    // image, size and network are fixed when the machine is created
    const fixed = ["image", "snapshot", "template", "resources", "network"].filter((k) => JSON.stringify((current as unknown as Record<string, unknown>)[k]) !== JSON.stringify((next as unknown as Record<string, unknown>)[k]));
    const note = fixed.length && isRemoteComputer(next) && deps.manager().live(id).status !== "missing"
      ? `${fixed.join(", ")} apply to a new machine: reset the computer to use them (its disk is lost)` : undefined;
    return c.json({ ok: true, data: { ...(await view(next, false)), ...(note ? { note } : {}) } });
  });

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    if (id === HOST_COMPUTER_ID) return fail(c, 400, "\"host\" is this server: it cannot be deleted", "VALIDATION_ERROR");
    const existing = deps.computers();
    const computer = existing.find((x) => x.id === id);
    if (!computer) return fail(c, 404, `There is no computer "${id}"`, "NOT_FOUND");
    const body = await c.req.json().catch(() => ({})) as { confirm?: unknown };
    if (body.confirm !== true && c.req.query("confirm") !== "true") {
      return fail(c, 400, `Deleting computer "${id}" deletes its machine and everything on its disk: send { "confirm": true }`, "CONFIRM_REQUIRED");
    }
    const users = computerUsers(id, await deps.agents()).filter((u) => u.isDefault);
    if (users.length) {
      return fail(c, 409, `Computer "${id}" is the default of ${users.map((u) => u.name).join(", ")}: choose another default for ${users.length > 1 ? "them" : "it"} first`, "IN_USE");
    }
    try {
      await deps.manager().delete(computer);
    } catch (err) {
      return operationError(c, `Deleting the machine of computer "${id}"`, err);
    }
    await deps.save(existing.filter((x) => x.id !== id));
    deps.emit({ id, action: "deleted" });
    return c.json({ ok: true, data: { deleted: id } });
  });

  const control = (op: "start" | "stop" | "restart" | "reset") => async (c: Context) => {
    const id = c.req.param("id")!;
    const computer = find(id);
    if (!computer) return fail(c, 404, `There is no computer "${id}"`, "NOT_FOUND");
    if (!isRemoteComputer(computer)) return fail(c, 400, `"${id}" runs on this server: there is no machine to ${op}`, "VALIDATION_ERROR");
    if (op === "reset") {
      const body = await c.req.json().catch(() => ({})) as { confirm?: unknown };
      if (body.confirm !== true && c.req.query("confirm") !== "true") {
        return fail(c, 400, `Resetting computer "${id}" deletes its machine and everything on its disk, then creates a new one: send { "confirm": true }`, "CONFIRM_REQUIRED");
      }
    }
    const manager = deps.manager();
    try {
      // the manager announces each status change (computer:changed)
      if (op === "stop") await manager.stop(computer);
      else {
        const s = sandbox(c, computer);
        if (s instanceof Response) return s;
        await (op === "start" ? manager.start(computer, s) : op === "restart" ? manager.restart(computer, s) : manager.reset(computer, s));
      }
      return c.json({ ok: true, data: await view(computer, false) });
    } catch (err) {
      return operationError(c, `${op[0]!.toUpperCase()}${op.slice(1)} of computer "${id}"`, err);
    }
  };
  app.post("/:id/start", control("start"));
  app.post("/:id/stop", control("stop"));
  app.post("/:id/restart", control("restart"));
  app.post("/:id/reset", control("reset"));

  app.get("/:id/egress", async (c) => {
    const id = c.req.param("id");
    const computer = find(id);
    if (!computer) return fail(c, 404, `There is no computer "${id}"`, "NOT_FOUND");
    if (!computer.egress) return c.json({ ok: true, data: { computerId: id, egress: null } });
    if (!isRemoteComputer(computer)) {
      return c.json({ ok: true, data: { computerId: id, proxy: computer.egress, tailnet: null, note: "a computer on this server uses the proxy directly (egress_status)" } });
    }
    const status = await computerEgressStatus(deps.manager(), computer, deps.settings(), deps.instance?.());
    return c.json({ ok: true, data: status });
  });

  return app;
}

/**
 * An error when a computer cannot work with the settings: a Daytona computer on Daytona v2 (Linux
 * sandboxes there cannot pause or stop); its egress: an unknown proxy; for a remote computer, no
 * Tailscale settings, a proxy that is not SOCKS5 on a tailnet address, or no network.
 */
function checkEgress(computer: ComputerConfig, settings: PolpoSettings | undefined): string | null {
  return computerProviderProblem(computer, settings as Parameters<typeof computerProviderProblem>[1]) ?? computerEgressProblem(computer, settings);
}

export { ComputerConfigError };

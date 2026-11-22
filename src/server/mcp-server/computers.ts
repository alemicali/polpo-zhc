/**
 * Computers: persistent machines agents work on (a Daytona or E2B machine that keeps its files,
 * installed tools and browser profile between chats and tasks). List with live status, create or
 * change, start/stop/restart/reset, delete. Changes need polpo:computers (or polpo:admin) (they cost money and change
 * where agents run); reset and delete need confirm: true.
 */
import { z } from "zod";
import type { ComputerConfig } from "@polpo-ai/core";
import { describeComputerEgress, type ComputerEgressStatus } from "../../sandbox/computers.js";
import type { EgressOverview } from "../routes/computers.js";
import { DESTRUCTIVE, READ, UPDATE, apiError, apiGet, apiSend, confirmParam, enc, fail, looseObject, ok, type McpDeps, type Register } from "./kit.js";

type Computer = {
  id: string; name: string; kind: string; status: string; builtin?: boolean; snapshot?: string; image?: string; template?: string;
  lastUsedAt?: string; uptimeMinutes?: number; lastError?: string; agents?: Array<{ name: string; isDefault: boolean }>;
  lifecycle?: { idleStopMinutes?: number; autoArchiveDays?: number }; note?: string;
  lastSnapshot?: { at: string; diskBytes?: number; memoryBytes?: number }; notice?: string;
};

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GB`;

/** "snapshot 2026-11-21T22:18:55Z (0.2 GB memory + 1.4 GB disk)" */
function snapshotLine(s: NonNullable<Computer["lastSnapshot"]>): string {
  const sizes = [s.memoryBytes !== undefined ? `${gb(s.memoryBytes)} memory` : "", s.diskBytes !== undefined ? `${gb(s.diskBytes)} disk` : ""].filter(Boolean).join(" + ");
  return `last snapshot ${s.at}${sizes ? ` (${sizes})` : ""}`;
}

const computerItem = z.object({ id: z.string(), name: z.string(), kind: z.string(), status: z.string() }).passthrough();

const line = (c: Computer) => {
  const image = c.snapshot ? `snapshot ${c.snapshot}` : c.image ? `image ${c.image}` : c.template ? `template ${c.template}` : "";
  const users = (c.agents ?? []).map((a) => `${a.name}${a.isDefault ? " (default)" : ""}`).join(", ");
  return `- ${c.id}${c.builtin ? " (this server)" : ` "${c.name}"`} [${c.kind}${image ? `, ${image}` : ""}]: ${c.status}${c.status === "hibernated" ? " (resumes in a few seconds on its next use)" : ""}`
    + `${c.lastUsedAt ? `, last used ${c.lastUsedAt}` : ""}${c.uptimeMinutes ? `, ${c.uptimeMinutes} min running so far` : ""}`
    + `${c.lastSnapshot ? `, ${snapshotLine(c.lastSnapshot)}` : ""}${c.notice ? `, note: ${c.notice}` : ""}`
    + `${c.lastError ? `, error: ${c.lastError}` : ""}${users ? ` · agents: ${users}` : ""}`;
};

const notFound = (id: string) => fail(`There is no computer "${id}". List them with polpo_computers_list.`);

export function registerComputerTools(tool: Register, deps: McpDeps): void {
  tool("computers", "polpo_computers_list", {
    title: "List computers",
    description: "The computers agents work on: \"host\" (this server) and persistent machines (Daytona, E2B) with their live status "
      + "(running, stopped, paused, hibernated, archived, creating, error; missing = not created yet), last use, uptime (a rough cost signal), "
      + "the last snapshot (Daytona v2: time, memory and disk size) and the agents using each. With id, one computer.",
    inputSchema: { id: z.string().optional().describe("One computer") },
    outputSchema: { items: z.array(computerItem) },
    annotations: READ,
  }, async ({ id }) => {
    const r = await apiGet(deps, id ? `/computers/${enc(id)}` : "/computers");
    if (!r.ok) return id && r.status === 404 ? notFound(id) : apiError(r, "Listing computers");
    const items = id ? [r.data as Computer] : ((r.data as { computers?: Computer[] })?.computers ?? []);
    return ok(items.map(line).join("\n"), { items });
  });

  tool("computers", "polpo_computer_save", {
    title: "Create or change a computer",
    description: "Create a computer (a persistent machine for agents) or change one. Its machine is created on first use or with start: true, "
      + "stops (or pauses) after lifecycle.idleStopMinutes without use (default 15) and is never deleted automatically. Image, snapshot, "
      + "template and size apply to a new machine (reset); so does the network, except on Daytona v2 where it applies at the next start or wake "
      + "(and v2 allowlists take host names only: IP addresses are refused). Allowlist entries are checked when saved. Make it an agent's default with polpo_agent_update defaultComputer. "
      + "Ask the person first: a running machine costs money.",
    inputSchema: {
      id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase letters, digits and -").describe("Slug, e.g. nina"),
      name: z.string().optional().describe("Display name"),
      kind: z.enum(["daytona", "e2b", "host"]).optional().describe("Where it runs (needed to create; cannot change): daytona, e2b, or host (this server, e.g. with an egress proxy)"),
      description: z.string().optional().describe("What it is for, in a line"),
      snapshot: z.string().nullable().optional().describe("Daytona snapshot (default: the instance's; its class decides container or linux-vm)"),
      image: z.string().nullable().optional().describe("Daytona Docker image instead of a snapshot (sized by resources)"),
      template: z.string().nullable().optional().describe("E2B template (default: the instance's)"),
      resources: z.object({ cpus: z.number().positive().optional(), memoryMb: z.number().positive().optional(), diskMb: z.number().positive().optional() }).nullable().optional()
        .describe("CPU, memory and disk (Daytona with an image; snapshots and E2B templates have a fixed size)"),
      lifecycle: z.object({
        idleStopMinutes: z.number().int().min(1).max(1440).optional().describe("Stop/pause after this many minutes without use (default 15)"),
        autoArchiveDays: z.number().int().min(1).max(30).optional().describe("Daytona: archive after this many days stopped"),
      }).nullable().optional().describe("When it stops and archives by itself (it is never deleted automatically)"),
      network: z.object({ mode: z.enum(["deny", "allowlist", "open", "unrestricted"]), allow: z.array(z.string()).optional() }).nullable().optional()
        .describe("Network rule; default the instance's. allow: host names (\"*.example.com\" covers subdomains); Daytona v2 takes host names only"),
      egress: z.string().nullable().optional().describe("Egress proxy name (settings.egressProxies) for its agents' browsers; a remote computer reaches it through Tailscale in its VM (needs settings.tailscale and a SOCKS5 proxy on a tailnet address)"),
      volumes: z.array(z.union([z.string(), looseObject])).nullable().optional().describe("Volumes attached to runs on it (names granted to the agent)"),
      start: z.boolean().optional().describe("Create: start the machine now"),
    },
    outputSchema: { computer: computerItem, created: z.boolean() },
    annotations: UPDATE,
  }, async ({ id, start, ...fields }) => {
    const cur = await apiGet(deps, `/computers/${enc(id)}?live=0`);
    if (cur.ok) {
      const patch = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      if (Object.keys(patch).length === 0) return fail("Nothing to change: give at least one field.");
      const r = await apiSend(deps, "PATCH", `/computers/${enc(id)}`, patch);
      if (!r.ok) return apiError(r, `Changing computer ${id}`);
      const c = r.data as Computer;
      return ok(`Changed computer ${id}.${c.note ? ` Note: ${c.note}.` : ""}\n${line(c)}`, { computer: c, created: false });
    }
    if (cur.status !== 404) return apiError(cur, `Reading computer ${id}`);
    if (!fields.kind) return fail(`There is no computer "${id}" yet: give kind (daytona, e2b or host) to create it.`);
    const body = Object.fromEntries(Object.entries({ id, ...fields, ...(start ? { start: true } : {}) }).filter(([, v]) => v !== undefined && v !== null));
    const r = await apiSend(deps, "POST", "/computers", body);
    if (!r.ok) return apiError(r, `Creating computer ${id}`);
    const c = r.data as Computer;
    return ok(`Created computer ${id}${start ? " and started it" : " (its machine is created on first use)"}. Make it an agent's default with polpo_agent_update defaultComputer.\n${line(c)}`, { computer: c, created: true });
  });

  tool("computers", "polpo_computer_control", {
    title: "Start, stop, restart or reset a computer",
    description: "Start (or resume, or wake a hibernated one) a computer's machine, stop it (Daytona v0: disk kept; E2B/VM: paused, memory kept; "
      + "Daytona v2: hibernated = memory and disk snapshot, VM deleted, wakes in a few seconds), restart it, or reset it: "
      + "delete the machine (and its snapshots) and create a new one — everything on its disk is lost, so reset needs confirm: true.",
    inputSchema: {
      id: z.string().min(1).describe("The computer's id (polpo_computers_list)"),
      action: z.enum(["start", "stop", "restart", "reset"]).describe("What to do"),
      confirm: confirmParam("reset it (its disk is lost)"),
    },
    outputSchema: { computer: computerItem },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ id, action, confirm }) => {
    if (action === "reset" && confirm !== true) return fail(`Resetting ${id} deletes its machine and everything on its disk: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "POST", `/computers/${enc(id)}/${action}`, action === "reset" ? { confirm: true } : undefined);
    if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, `${action} of computer ${id}`);
    const c = r.data as Computer;
    return ok(`${action[0]!.toUpperCase()}${action.slice(1)}: ${line(c).slice(2)}${c.note ? `\nNote: ${c.note}.` : ""}`, { computer: c });
  });

  tool("computers", "polpo_egress_status", {
    title: "Egress status",
    description: "Where agents' browsers go out to the internet: each egress proxy (settings.egressProxies, e.g. a residential line) — "
      + "whether this server reaches it and which agents (browser on this server) and host computers use it — and each remote computer "
      + "with an egress, as seen from its VM through Tailscale (tailnet up/down, node, path, proxy reachable, where its browser goes out now). "
      + "Read-only: a stopped or hibernated computer is not started (its egress is checked again when it wakes). With computer, one computer.",
    inputSchema: { computer: z.string().min(1).optional().describe("One computer's id (polpo_computers_list)") },
    outputSchema: {
      proxies: z.array(z.object({ name: z.string(), reachable: z.boolean(), agents: z.array(z.string()), hostComputers: z.array(z.string()) }).passthrough()),
      unknown: z.array(z.object({ agent: z.string(), proxy: z.string() }).passthrough()).describe("Agents naming a proxy that does not exist"),
      computers: z.array(z.object({ computerId: z.string() }).passthrough()),
    },
    annotations: READ,
  }, async ({ computer }) => {
    if (computer) {
      const r = await apiGet(deps, `/computers/${enc(computer)}/egress`);
      if (!r.ok) return r.status === 404 ? notFound(computer) : apiError(r, `Egress of computer ${computer}`);
      const s = r.data as ComputerEgressStatus & { egress?: null; note?: string };
      if (s.egress === null) return ok(`Computer ${computer} has no egress: its browser goes out directly.`, { proxies: [], unknown: [], computers: [s] });
      if (s.tailnet === null) return ok(`Computer ${computer} runs on this server and uses ${s.proxy} directly (no tailnet).`, { proxies: [], unknown: [], computers: [s] });
      const kind = ((await apiGet(deps, `/computers/${enc(computer)}?live=0`)) as { data?: { kind?: string } }).data?.kind ?? "remote";
      return ok(describeComputerEgress({ id: computer, kind: kind as ComputerConfig["kind"] }, s), { proxies: [], unknown: [], computers: [{ ...s, kind }] });
    }
    const r = await apiGet(deps, "/egress");
    if (!r.ok) return apiError(r, "Egress status");
    const o = r.data as EgressOverview;
    const lines = [
      ...(o.proxies.length ? o.proxies.map((p) => `- ${p.name}: ${p.reachable ? "reachable from this server" : "UNREACHABLE from this server (browsers go out directly; profiles signed in through it pause)"}`
        + `; agents: ${p.agents.join(", ") || "none"}${p.hostComputers.length ? `; host computers: ${p.hostComputers.join(", ")}` : ""}`) : ["No egress proxies (settings.egressProxies): every browser goes out directly."]),
      ...(o.unknown.length ? [`Agents naming a proxy that does not exist: ${o.unknown.map((u) => `${u.agent} (${u.proxy})`).join(", ")}`] : []),
      ...(o.computers.length ? ["Remote computers (through Tailscale in their VM):", ...o.computers.map((s) => `- ${describeComputerEgress({ id: s!.computerId, kind: s!.kind as ComputerConfig["kind"] }, s!)}`)] : []),
    ];
    return ok(lines.join("\n"), o as unknown as Record<string, unknown>);
  });

  tool("computers", "polpo_computer_delete", {
    title: "Delete a computer",
    description: "Delete a computer and its machine, with everything on its disk. It cannot be undone; a computer that is an agent's default "
      + "cannot be deleted (choose another default first). Needs confirm: true.",
    inputSchema: { id: z.string().min(1).describe("The computer's id"), confirm: confirmParam("delete it and its disk") },
    outputSchema: { deleted: z.string() },
    annotations: DESTRUCTIVE,
  }, async ({ id, confirm }) => {
    if (confirm !== true) return fail(`Deleting ${id} deletes its machine and everything on its disk: ask the person, then call again with confirm: true.`);
    const r = await apiSend(deps, "DELETE", `/computers/${enc(id)}`, { confirm: true });
    if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, `Deleting computer ${id}`);
    return ok(`Deleted computer ${id} and its machine.`, { deleted: id });
  });
}

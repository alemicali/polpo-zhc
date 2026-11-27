/**
 * Computers: persistent machines agents work on (a Daytona or E2B machine that keeps its files,
 * installed tools and browser profile between chats and tasks). List with live status, create or
 * change, start/stop/restart/reset, delete; a computer's live view (polpo_computer_desktop: status,
 * start, stop, the agents waiting for a person) and take control (polpo_computer_takeover,
 * polpo_computer_release); never a VNC password (it never leaves the server). Changes need polpo:computers (or polpo:admin) (they cost money and change
 * where agents run); reset and delete need confirm: true.
 */
import { z } from "zod";
import type { ComputerConfig } from "@polpo-ai/core";
import { describeComputerEgress, type ComputerEgressStatus } from "../../sandbox/computers.js";
import type { ComputerDetailView, EgressOverview } from "../routes/computers.js";

type ComputerDetail = ComputerDetailView & { status: string };
import { DESTRUCTIVE, READ, UPDATE, apiError, apiGet, apiSend, confirmParam, enc, fail, looseObject, ok, type McpDeps, type Register } from "./kit.js";
import { setupHandoff } from "./setup.js";

type Computer = {
  id: string; name: string; kind: string; status: string; builtin?: boolean; snapshot?: string; image?: string; template?: string;
  lastUsedAt?: string; uptimeMinutes?: number; lastError?: string; agents?: Array<{ name: string; isDefault: boolean }>;
  lifecycle?: { idleStopMinutes?: number; autoArchiveDays?: number }; note?: string;
  lastSnapshot?: { at: string; diskBytes?: number; memoryBytes?: number }; notice?: string;
};

/** A provider webhook delivery, as the event log keeps it (sandbox/computer-webhook-events.ts). */
type WebhookEvent = {
  id: string; receivedAt: string; outcome: string; reason?: string; httpStatus: number; signature: string; eventType?: string;
  deliveryId?: string; sandboxId?: string; snapshotName?: string; computerId?: string; providerState?: { from?: string; to?: string };
  statusChange?: { from?: string; to?: string; error?: string; appliedAt?: string }; action?: string; processingMs: number; bytes: number;
  payload?: unknown; payloadTruncated?: boolean;
};

/** "2026-11-23T10:00:00Z accepted sandbox.state.updated sandbox abc (started → stopped) → computer nina: running → stopped" */
function eventLine(e: WebhookEvent): string {
  const states = e.providerState ? [e.providerState.from, e.providerState.to].filter(Boolean).join(" → ") : "";
  const status = e.statusChange?.to && e.statusChange.to !== e.statusChange.from ? `: ${e.statusChange.from ?? "?"} → ${e.statusChange.to}` : "";
  return [
    e.receivedAt, e.outcome, e.eventType ?? "(no type)",
    e.sandboxId ? `sandbox ${e.sandboxId}` : e.snapshotName ? `snapshot ${e.snapshotName}` : "",
    states ? `(${states})` : "",
    e.computerId ? `→ computer ${e.computerId}${status}` : "",
    e.reason ? `— ${e.reason}` : "",
  ].filter(Boolean).join(" ");
}

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
  return `- ${c.id}${c.builtin ? " (this server)" : ` "${c.name}"`} [${c.kind}${image ? `, ${image}` : ""}]: ${c.status}${c.status === "hibernated" ? " (resumes in a few seconds on its next use)" : c.status === "deleted" ? " (deleted at the provider: its next use makes a new machine from the image)" : ""}`
    + `${c.lastUsedAt ? `, last used ${c.lastUsedAt}` : ""}${c.uptimeMinutes ? `, ${c.uptimeMinutes} min running so far` : ""}`
    + `${c.lastSnapshot ? `, ${snapshotLine(c.lastSnapshot)}` : ""}${c.notice ? `, note: ${c.notice}` : ""}`
    + `${c.lastError ? `, error: ${c.lastError}` : ""}${users ? ` · agents: ${users}` : ""}`;
};

type TakeoverRequest = { id: string; computerId: string; agent: string; reason: string; url?: string; whatToDo?: string; createdAt: string; expiresAt: string; status: string; takenBy?: string; note?: string; taskId?: string };
type ControlView = { computerId: string; holder: "agent" | "person"; person?: string; since?: string; lastNote?: string; requests: TakeoverRequest[]; open: TakeoverRequest[] };
/** What the desktop routes answer (never a password: the server answers the VM's VNC authentication itself). */
type DesktopView = { desktop: { state: string; display: string; note?: string; error?: string; startedAt?: string; processes?: Record<string, boolean> }; control: ControlView };

function desktopLine(id: string, d: DesktopView["desktop"]): string {
  const what = d.state === "running" ? `running${d.startedAt ? ` since ${d.startedAt}` : ""} (open it in the dashboard: Computers → ${id} → Live)`
    : d.state === "machine-off" ? "off: its machine is not running (start starts it)" : d.state === "unsupported" ? "not available" : "stopped";
  return `Live view of ${id}: ${what}${d.note ? `. ${d.note}` : ""}${d.error ? `. Error: ${d.error}` : ""}`;
}

function controlLine(c: ControlView): string {
  return c.holder === "person"
    ? `${c.person ?? "A person"} has control of ${c.computerId} since ${c.since ?? "?"} (its agents' browsers wait).`
    : `The agent has control of ${c.computerId}${c.lastNote ? ` (last note from a person: ${c.lastNote})` : ""}.`;
}

function requestLines(reqs: TakeoverRequest[]): string[] {
  return reqs.map((r) => `- [${r.id}] ${r.agent} on ${r.computerId}: ${r.status}${r.takenBy ? ` (${r.takenBy})` : ""} — ${r.reason}`
    + `${r.url ? ` · page ${r.url}` : ""}${r.whatToDo ? ` · to do: ${r.whatToDo}` : ""}${r.status === "pending" || r.status === "in_control" ? ` · waits until ${r.expiresAt}` : ""}${r.note ? ` · note: ${r.note}` : ""}${r.taskId ? ` · task ${r.taskId}` : ""}`);
}

const notFound = (id: string) => fail(`There is no computer "${id}". List them with polpo_computers_list.`);

export function registerComputerTools(tool: Register, deps: McpDeps): void {
  tool("computers", "polpo_computers_list", {
    title: "List computers",
    description: "The computers agents work on: \"host\" (this server) and persistent machines (Daytona, E2B) with their live status "
      + "(running, stopped, paused, hibernated, archived, creating, error; missing = not created yet; deleted = its machine was deleted at the provider, outside Polpo: its next use or a reset makes a new one, without its files), last use, uptime (a rough cost signal), "
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

  tool("computers", "polpo_computer_get", {
    title: "Get a computer",
    description: "One computer in full, as its page shows it: live status, the agents using it, its snapshots (Daytona v2), what a new machine "
      + "is made from (image or snapshot, region, size), when it hibernates or stops by itself, its recent activity (status changes, wakes, "
      + "rotations, errors, a machine deleted at the provider), the agent harness sessions on it (Claude Code, Codex, OpenCode: state, turns, tokens, cost), "
      + "the recent task runs on it (agent, engine, model, status, duration, cost) and what was spent on it. Read-only: never starts it.",
    inputSchema: { id: z.string().min(1).describe("The computer's id (polpo_computers_list)") },
    outputSchema: { computer: computerItem },
    annotations: READ,
  }, async ({ id }) => {
    const r = await apiGet(deps, `/computers/${enc(id)}?detail=1`);
    if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, `Reading computer ${id}`);
    const c = r.data as Computer & ComputerDetail;
    const lines = [line(c).slice(2)];
    if (c.machine) {
      const m = c.machine;
      const size = m.resources ? [m.resources.cpus ? `${m.resources.cpus} CPU` : "", m.resources.memoryMb ? `${m.resources.memoryMb} MB memory` : "", m.resources.diskMb ? `${m.resources.diskMb} MB disk` : ""].filter(Boolean).join(", ") : "";
      lines.push(`New machine from: ${m.snapshot ? `snapshot ${m.snapshot}` : m.image ? `image ${m.image}` : m.template ? `template ${m.template}` : "the provider's default"}${m.region ? `, region ${m.region}` : ""}${size ? `, ${size}` : ""}`);
    }
    if (c.idleStopAt) lines.push(`${c.status === "running" && c.hibernate ? "Hibernates" : "Stops"} by itself at ${c.idleStopAt} unless used`);
    if (c.snapshots?.length) lines.push(`Snapshots (${c.snapshots.length}${c.hibernate ? `, keeps ${c.hibernate.keepSnapshots}` : ""}): ${c.snapshots.map((s) => `${s.at} ${s.status}`).join("; ")}`);
    lines.push(`Spent: $${c.cost.totalUsd.toFixed(2)} (task runs $${c.cost.runsUsd.toFixed(2)}, chat harness sessions $${c.cost.chatSessionsUsd.toFixed(2)})`);
    if (c.sessions.length) {
      lines.push(`Harness sessions (${c.sessions.length}):`);
      for (const s of c.sessions.slice(0, 10)) lines.push(`- ${s.harness} · ${s.agent}${s.taskId ? ` · task ${s.taskId}` : " · chat"}: ${s.live ? "running" : s.state}, ${s.turns} turns, $${(s.costUsd ?? 0).toFixed(2)}, updated ${s.updatedAt}`);
    }
    if (c.runs.length) {
      lines.push(`Recent task runs (${c.runs.length}):`);
      for (const x of c.runs.slice(0, 10)) lines.push(`- ${x.taskTitle} (${x.taskId}) · ${x.agent ?? "?"} · ${x.engine}${x.model ? ` ${x.model}` : ""}: ${x.status}, started ${x.startedAt}${x.durationMs !== undefined ? `, ${Math.round(x.durationMs / 1000)} s` : ""}${x.costUsd !== undefined ? `, $${x.costUsd.toFixed(2)}` : ""}`);
    }
    if (c.activity.length) {
      lines.push("Recent activity:");
      for (const a of c.activity.slice(0, 10)) lines.push(`- ${a.at} ${a.kind === "status" ? `${a.from ? `${a.from} → ` : ""}${a.status}${a.message ? ` (${a.message})` : ""}` : `${a.level ?? "info"}: ${a.message}`}`);
    }
    return ok(lines.join("\n"), { computer: c });
  });

  tool("computers", "polpo_computer_webhooks", {
    title: "Computer provider webhooks",
    description: "Whether the computers' providers push their machines' state to Polpo (webhooks), so a machine deleted, stopped or paused "
      + "outside Polpo shows at once (without them, or while a provider sends nothing, a check every 5 minutes; with events arriving, every 20). action status (default): per provider "
      + "(daytona, e2b) the state (receiving / configured / not-configured), last event, the URL to give the provider. Daytona: the person "
      + "adds the endpoint in Daytona's dashboard (Webhooks → Add Endpoint) and enters its signing secret in the dashboard (setup_url; never in chat). "
      + "E2B: action register (Polpo registers the endpoint with its own secret) or unregister. Needs POLPO_PUBLIC_URL, and behind Tailscale Funnel "
      + "the /<instance>/api/v1/computers/webhooks/ path exposed. events: true (with provider): the provider's event log, newest first: every delivery "
      + "with its outcome (accepted / ignored / rejected / error), reason, sandbox, matched computer and status change; event_id: one delivery with its redacted payload.",
    inputSchema: {
      action: z.enum(["status", "register", "unregister"]).optional().describe("status (default), or register / unregister (E2B)"),
      provider: z.enum(["daytona", "e2b"]).optional().describe("One provider (register and unregister: e2b; events: required)"),
      events: z.boolean().optional().describe("true: the provider's recent deliveries (its event log) instead of the status"),
      outcome: z.array(z.enum(["accepted", "ignored", "rejected", "error"])).optional().describe("events: only these outcomes"),
      limit: z.number().int().min(1).max(200).optional().describe("events: how many (default 20)"),
      cursor: z.string().optional().describe("events: next_cursor of the previous call"),
      event_id: z.string().optional().describe("One delivery (from events) with its redacted payload and headers"),
    },
    outputSchema: {
      providers: z.array(z.object({ provider: z.string(), state: z.string() }).passthrough()).optional(),
      provider: z.string().optional(),
      events: z.array(z.object({ id: z.string(), outcome: z.string() }).passthrough()).optional(),
      counts: z.record(z.string(), z.number()).optional(),
      next_cursor: z.string().optional(),
      event: z.object({ id: z.string(), outcome: z.string() }).passthrough().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ action = "status", provider, events, outcome, limit, cursor, event_id }) => {
    if (event_id || events) {
      if (!provider) return fail("Say which provider's events: provider daytona or e2b.");
      if (event_id) {
        const r = await apiGet(deps, `/computer-webhooks/${enc(provider)}/events/${enc(event_id)}`);
        if (!r.ok) return apiError(r, "Reading the webhook delivery");
        const e = r.data as WebhookEvent;
        const lines = [eventLine(e)];
        if (e.statusChange) lines.push(`Polpo: ${e.action ?? ""}${e.statusChange.error ? ` (error: ${e.statusChange.error})` : ""}`);
        if (e.deliveryId) lines.push(`Delivery ${e.deliveryId}; signature ${e.signature}; HTTP ${e.httpStatus}; ${e.processingMs} ms; ${e.bytes} bytes`);
        if (e.payload !== undefined) lines.push(`Payload (redacted${e.payloadTruncated ? ", truncated" : ""}):\n${typeof e.payload === "string" ? e.payload : JSON.stringify(e.payload, null, 2)}`);
        return ok(lines.join("\n"), { provider, event: e });
      }
      const q = new URLSearchParams({ limit: String(limit ?? 20) });
      if (cursor) q.set("cursor", cursor);
      if (outcome?.length) q.set("outcome", outcome.join(","));
      const r = await apiGet(deps, `/computer-webhooks/${enc(provider)}/events?${q}`);
      if (!r.ok) return apiError(r, "Reading the webhook events");
      const d = r.data as { events: WebhookEvent[]; nextCursor?: string; total: number; counts: Record<string, number> };
      const label = provider === "daytona" ? "Daytona" : "E2B";
      const lines = [`${label} webhook deliveries (${d.total} kept: ${Object.entries(d.counts).map(([k, v]) => `${v} ${k}`).join(", ")})${outcome?.length ? `, showing ${outcome.join(" / ")}` : ""}:`];
      if (!d.events.length) {
        const s = await apiGet(deps, "/computer-webhooks");
        const st = s.ok ? (s.data as { providers: Array<{ provider: string; state: string; waitingNote?: string }> }).providers.find((p) => p.provider === provider) : undefined;
        lines.push(st?.state === "not-configured" ? `  none: ${label} webhooks are not configured (call without events for the setup).` : `  none.${st?.waitingNote ? ` ${st.waitingNote}` : ""}`);
      }
      for (const e of d.events) lines.push(`- ${eventLine(e)} [${e.id}]`);
      if (d.nextCursor) lines.push(`More: cursor ${d.nextCursor}`);
      return ok(lines.join("\n"), { provider, events: d.events, counts: d.counts, ...(d.nextCursor ? { next_cursor: d.nextCursor } : {}) });
    }
    if (action !== "status") {
      if (provider && provider !== "e2b") return fail("Only E2B webhooks are registered by Polpo; Daytona's endpoint is added in Daytona's dashboard (see status for the URL).");
      const r = await apiSend(deps, action === "register" ? "POST" : "DELETE", "/computer-webhooks/e2b/register");
      if (!r.ok) return apiError(r, `${action === "register" ? "Registering" : "Unregistering"} E2B's webhook`);
    }
    const r = await apiGet(deps, "/computer-webhooks");
    if (!r.ok) return apiError(r, "Reading the computer webhooks");
    const d = r.data as { providers: Array<Record<string, unknown> & { provider: string; label: string; state: string; url?: string; secretSet: boolean; lastEventAt?: string; registration: string; lastError?: string; waitingNote?: string; received: number; rejected: number; ignored: number; errors?: number;
      before?: { received: number; ignored: number; rejected: number; errors: number; until: string } }>; note: string };
    const providers = d.providers.filter((p) => !provider || p.provider === provider);
    const lines: string[] = [];
    const extra: Record<string, unknown> = {};
    for (const p of providers) {
      lines.push(`- ${p.label}: ${p.state}${p.lastEventAt ? `, last event ${p.lastEventAt}` : ""}${p.url ? `; URL ${p.url}` : "; no URL (POLPO_PUBLIC_URL is not set)"}`
        + `; event log: ${p.received} received (${p.ignored} ignored), ${p.rejected} rejected${p.errors ? `, ${p.errors} errors` : ""}${p.lastError ? `; last error: ${p.lastError}` : ""}`);
      if (p.before) {
        const b = p.before;
        const accepted = Math.max(0, b.received - b.ignored - b.errors);
        const parts = [[accepted, "accepted"], [b.ignored, "ignored"], [b.rejected, "rejected"], [b.errors, "errors"]].filter(([n]) => Number(n) > 0).map(([n, w]) => `${n} ${w}`);
        if (parts.length) lines.push(`  Before the event log (until ${b.until}): ${parts.join(", ")} — totals only, no details (not in the events list).`);
      }
      if (p.waitingNote) lines.push(`  ${p.waitingNote}`);
      if (p.provider === "daytona" && !p.secretSet) {
        const h = setupHandoff(deps, { kind: "computer-webhook", item: "daytona", field: "secret" }, "Daytona webhook signing secret (whsec_…, from Daytona's dashboard → Webhooks → the endpoint)");
        Object.assign(extra, h);
        lines.push(`  Daytona: add an endpoint with that URL in Daytona's dashboard (Webhooks → Add Endpoint; events sandbox.created, sandbox.state.updated, snapshot.removed), then ${h.next_step}`);
      }
      if (p.provider === "e2b" && p.state === "not-configured") lines.push("  E2B: call again with action register.");
    }
    lines.push("Each provider's deliveries: call with events: true and provider.");
    lines.push(d.note);
    return ok(lines.join("\n"), { providers, ...extra });
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

  tool("computers", "polpo_computer_desktop", {
    title: "A computer's live view",
    description: "A remote computer's desktop (Daytona v2): the virtual display its agents' headed browsers open on (agent browserHeaded), "
      + "watched live and taken control of from its page in the dashboard (Computers → the computer → Live). action status (default): whether the live view runs, "
      + "who holds the desktop (the agent, or a person since when) and its agents' open takeover requests; never starts the computer. start: start the live "
      + "view (starts or wakes the computer: it costs money while it runs; packages missing on an older image are installed once). stop: stop the live view "
      + "(the display and browser windows stay). Without id: every agent waiting for a person (request_computer_takeover: a login, 2FA, a CAPTCHA), oldest first. "
      + "An agent's takeover request starts the live view by itself, and it survives a server restart. No VNC password ever leaves the server "
      + "(it answers the VM's VNC authentication itself): the person opens the live view in the dashboard.",
    inputSchema: {
      id: z.string().min(1).optional().describe("The computer's id (polpo_computers_list); omit to list the agents waiting for a person on any computer"),
      action: z.enum(["status", "start", "stop"]).optional().describe("status (default), start or stop"),
    },
    outputSchema: { desktop: looseObject.optional(), control: looseObject.optional(), requests: z.array(looseObject).optional() },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async ({ id, action = "status" }) => {
    if (!id) {
      if (action !== "status") return fail("Say which computer to start or stop (id).");
      const all = await apiGet(deps, "/computer-takeovers");
      if (!all.ok) return apiError(all, "Reading the takeover requests");
      const reqs = (all.data as { requests: TakeoverRequest[] }).requests;
      return ok(reqs.length ? requestLines(reqs).join("\n") : "No agent is waiting for a person.", { requests: reqs as unknown as Record<string, unknown>[] });
    }
    const r = action === "status" ? await apiGet(deps, `/computers/${enc(id)}/desktop`) : await apiSend(deps, "POST", `/computers/${enc(id)}/desktop/${action}`);
    if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, `${action === "status" ? "Reading" : action === "start" ? "Starting" : "Stopping"} the live view of ${id}`);
    const v = r.data as DesktopView;
    const recent = v.control.requests.filter((x) => x.status !== "pending" && x.status !== "in_control").slice(0, 5);
    return ok([desktopLine(id, v.desktop), controlLine(v.control), ...requestLines(v.control.open), ...(recent.length ? ["Recent requests:", ...requestLines(recent)] : [])].join("\n"),
      { desktop: v.desktop as unknown as Record<string, unknown>, control: v.control as unknown as Record<string, unknown>, requests: v.control.requests as unknown as Record<string, unknown>[] });
  });

  tool("computers", "polpo_computer_takeover", {
    title: "Take control of a computer",
    description: "The person takes control of a remote computer's desktop: from now on their live view (dashboard → the computer → Live) is interactive and "
      + "the computer's agents' browser tools wait; an agent's open takeover request is now theirs. Use it when the person says they will do something there "
      + "(a login, 2FA, a CAPTCHA). They type in the live view, never in chat. Give it back with polpo_computer_release. force: take it from another person.",
    inputSchema: {
      id: z.string().min(1).describe("The computer's id"),
      force: z.boolean().optional().describe("Take it from another person who holds it"),
    },
    outputSchema: { control: looseObject },
    annotations: UPDATE,
  }, async ({ id, force }) => {
    const r = await apiSend(deps, "POST", `/computers/${enc(id)}/takeover`, force ? { force: true } : {});
    if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, `Taking control of ${id}`, r.status === 409 ? "Someone else has it: ask them, or call again with force: true." : undefined);
    const v = r.data as DesktopView;
    return ok(`${controlLine(v.control)}\nThe person works in the live view (dashboard → Computers → ${id} → Live); give control back with polpo_computer_release.`, { control: v.control as unknown as Record<string, unknown> });
  });

  tool("computers", "polpo_computer_release", {
    title: "Give control back to the agent",
    description: "The person gives a remote computer's desktop back to its agent, with an optional note the waiting agent reads (what was done, what to know: "
      + "never a password or a code). The agent's request_computer_takeover returns with that note and its browser goes on. force: give it back for another person.",
    inputSchema: {
      id: z.string().min(1).describe("The computer's id"),
      note: z.string().max(2000).optional().describe("For the agent: e.g. \"Signed in, 2FA done; you are on the feed\""),
      force: z.boolean().optional().describe("Give it back although another person holds it"),
    },
    outputSchema: { control: looseObject },
    annotations: UPDATE,
  }, async ({ id, note, force }) => {
    const r = await apiSend(deps, "POST", `/computers/${enc(id)}/release`, { ...(note ? { note } : {}), ...(force ? { force: true } : {}) });
    if (!r.ok) return r.status === 404 ? notFound(id) : apiError(r, `Giving control of ${id} back`);
    const v = r.data as DesktopView;
    return ok(controlLine(v.control), { control: v.control as unknown as Record<string, unknown> });
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

/**
 * Computers' provider webhooks: Svix-style (Daytona) and E2B signatures, replays, event mapping,
 * idempotency, unknown machines, limits, E2B registration, the routes, and the fallback (reconcile)
 * when no webhook is set up.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ComputerWebhookEventLog, redactWebhookPayload, webhookPayloadPreview, COMPUTER_WEBHOOK_PAYLOAD_MAX_BYTES } from "../sandbox/computer-webhook-events.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComputerConfig, RemoteSandboxProvider, VaultEntry, VaultStore } from "@polpo-ai/core";
import { ComputerManager, ComputerUpkeep } from "../sandbox/computers.js";
import {
  ComputerWebhooks, E2B_WEBHOOK_EVENTS, daytonaWebhooks, e2bSignature, e2bWebhooks, verifySvix, WEBHOOK_RATE_PER_MINUTE,
} from "../sandbox/computer-webhooks.js";
import { computerWebhookAdminRoutes, computerWebhookInboundRoutes } from "../server/routes/computer-webhooks.js";
import type { CreateSpec, RemoteAdapter, RemoteDriver, RemoteVmSummary } from "../sandbox/remote-adapters.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "polpo-webhooks-")); dirs.push(d); return d; };

const NOW = Date.parse("2026-11-22T12:00:00Z");
const SECRET = `whsec_${Buffer.from("a-daytona-signing-secret-32-bytes!").toString("base64")}`;

/** A delivery signed as Svix signs it. */
function svixHeaders(raw: string, o: { id?: string; at?: number; secret?: string; names?: "svix" | "webhook" } = {}): Record<string, string> {
  const id = o.id ?? "msg_1";
  const ts = String(Math.floor((o.at ?? NOW) / 1000));
  const secret = o.secret ?? SECRET;
  const sig = createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${raw}`).digest("base64");
  const p = o.names ?? "svix";
  return { [`${p}-id`]: id, [`${p}-timestamp`]: ts, [`${p}-signature`]: `v1,bm90LXRoaXMtb25l v1,${sig}` };
}
const get = (h: Record<string, string>) => (name: string) => h[name.toLowerCase()];

class MemoryVault implements Partial<VaultStore> {
  entries = new Map<string, VaultEntry>();
  async get(owner: string, service: string) { return this.entries.get(`${owner}/${service}`); }
  async set(owner: string, service: string, entry: VaultEntry) { this.entries.set(`${owner}/${service}`, entry); }
  async remove(owner: string, service: string) { return this.entries.delete(`${owner}/${service}`); }
}

/** A provider whose machines are records (as in the routes test). */
class FakeProvider implements RemoteAdapter {
  readonly fastSuspend = false;
  machines = new Map<string, { state: string; labels: Record<string, string>; deleted?: boolean }>();
  lists = 0;
  private n = 0;
  constructor(readonly provider: RemoteSandboxProvider) {}
  private driver(id: string): RemoteDriver {
    return { remoteId: id, exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }), readFile: async () => new Uint8Array(), writeFile: async () => {}, suspend: async () => {}, resume: async () => {}, destroy: async () => {} };
  }
  async create(spec: CreateSpec) { const id = `m-${++this.n}`; this.machines.set(id, { state: "started", labels: spec.labels }); return this.driver(id); }
  async connect(id: string) { const m = this.machines.get(id)!; m.state = "started"; return this.driver(id); }
  async list(labels: Record<string, string>): Promise<RemoteVmSummary[]> {
    this.lists++;
    return [...this.machines.entries()].filter(([, m]) => !m.deleted && Object.entries(labels).every(([k, v]) => m.labels[k] === v)).map(([id, m]) => ({ remoteId: id, state: m.state, labels: m.labels }));
  }
  async remove(id: string) { this.machines.get(id)!.deleted = true; }
  async suspendById(id: string) { this.machines.get(id)!.state = "stopped"; }
}

function setup(o: { computers?: ComputerConfig[]; publicBase?: string; e2bKey?: string; fetch?: typeof fetch } = {}) {
  const polpoDir = tmp();
  const provider = new FakeProvider("daytona");
  let clock = NOW;
  const manager = new ComputerManager(polpoDir, { adapter: () => provider, now: () => clock });
  const vault = new MemoryVault();
  const computers = o.computers ?? [{ id: "nina", name: "Nina", kind: "daytona" } as ComputerConfig];
  const emitted: Array<{ provider: string; id: string; action: string; outcome: string; computerId?: string }> = [];
  const w = new ComputerWebhooks({
    polpoDir: () => polpoDir, manager: () => manager, computers: () => computers, vault: () => vault as unknown as VaultStore,
    publicBase: () => o.publicBase, e2bApiKey: async () => o.e2bKey, fetch: o.fetch, now: () => clock,
    emit: (payload) => { emitted.push(payload); },
  });
  return { w, manager, provider, vault, computers, advance: (ms: number) => { clock += ms; }, polpoDir, emitted };
}

describe("signatures", () => {
  it("Svix (Daytona): valid, tampered, wrong secret, replayed outside 5 minutes, missing headers; webhook-* names too", () => {
    const raw = JSON.stringify({ event: "sandbox.state.updated", id: "m-1" });
    expect(verifySvix(raw, get(svixHeaders(raw)), SECRET, NOW)).toEqual({ ok: true, deliveryId: "msg_1" });
    expect(verifySvix(raw, get(svixHeaders(raw, { names: "webhook" })), SECRET, NOW)).toMatchObject({ ok: true });
    expect(verifySvix(`${raw} `, get(svixHeaders(raw)), SECRET, NOW)).toEqual({ ok: false, reason: "signature does not match" });
    expect(verifySvix(raw, get(svixHeaders(raw, { secret: `whsec_${Buffer.from("another").toString("base64")}` })), SECRET, NOW).ok).toBe(false);
    expect(verifySvix(raw, get(svixHeaders(raw, { at: NOW - 6 * 60_000 })), SECRET, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/5-minute window/) });
    expect(verifySvix(raw, get({}), SECRET, NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/missing/) });
  });

  it("E2B: base64(sha256(secret + body)) without padding; tampered and day-old events refused", () => {
    const raw = JSON.stringify({ id: "ev1", type: "sandbox.lifecycle.killed", sandbox_id: "sbx", timestamp: new Date(NOW).toISOString() });
    const sig = e2bSignature("s3cret", raw);
    expect(sig).not.toMatch(/=$/);
    expect(e2bWebhooks.verify(raw, get({ "e2b-signature": sig }), "s3cret", NOW)).toEqual({ ok: true });
    expect(e2bWebhooks.verify(raw, get({ "e2b-signature": e2bSignature("other", raw) }), "s3cret", NOW).ok).toBe(false);
    expect(e2bWebhooks.verify(raw, get({}), "s3cret", NOW).ok).toBe(false);
    const old = JSON.stringify({ id: "ev0", type: "sandbox.lifecycle.killed", sandbox_id: "sbx", timestamp: new Date(NOW - 25 * 3_600_000).toISOString() });
    expect(e2bWebhooks.verify(old, get({ "e2b-signature": e2bSignature("s3cret", old) }), "s3cret", NOW)).toMatchObject({ ok: false, reason: expect.stringMatching(/24 h/) });
  });
});

describe("event mapping", () => {
  it("Daytona: sandbox state changes (destroyed = gone), snapshot removal; unknown events ignored", () => {
    expect(daytonaWebhooks.parse({ event: "sandbox.state.updated", id: "sbx1", organizationId: "o", oldState: "started", newState: "destroyed", updatedAt: "2026-11-22T11:59:00Z" }))
      .toEqual([{ id: "sandbox.state.updated:sbx1:started:destroyed:2026-11-22T11:59:00Z", type: "sandbox.state.updated", at: "2026-11-22T11:59:00Z", remoteId: "sbx1", from: "started", state: "destroyed", gone: true }]);
    expect(daytonaWebhooks.parse({ event: "sandbox.state.updated", id: "sbx1", oldState: "started", newState: "stopped" })[0]).toMatchObject({ state: "stopped", gone: false });
    expect(daytonaWebhooks.parse({ event: "sandbox.created", id: "sbx2", state: "started", createdAt: "x" })[0]).toMatchObject({ remoteId: "sbx2", state: "started", gone: false });
    expect(daytonaWebhooks.parse({ event: "snapshot.removed", id: "snap1", name: "polpo-computer-x-nina-20261122110000000", removedAt: "t" })[0])
      .toMatchObject({ snapshotName: "polpo-computer-x-nina-20261122110000000", gone: true });
    expect(daytonaWebhooks.parse({ event: "volume.created", id: "v" })).toEqual([]);
    expect(daytonaWebhooks.parse(null)).toEqual([]);
  });

  it("E2B: lifecycle events to states (killed = gone), the computer's label from the sandbox metadata", () => {
    const ev = (type: string) => ({ id: `e-${type}`, type, sandbox_id: "sbx", timestamp: "t", event_data: { sandbox_metadata: { "polpo-computer": "inst:box" }, kill_reason: "request" } });
    expect(e2bWebhooks.parse(ev("sandbox.lifecycle.killed"))[0]).toMatchObject({ remoteId: "sbx", labelValue: "inst:box", gone: true });
    expect(e2bWebhooks.parse(ev("sandbox.lifecycle.paused"))[0]).toMatchObject({ state: "paused", gone: false });
    expect(e2bWebhooks.parse(ev("sandbox.lifecycle.resumed"))[0]).toMatchObject({ state: "running" });
    expect(e2bWebhooks.parse(ev("sandbox.lifecycle.unknown"))).toEqual([]);
    expect(E2B_WEBHOOK_EVENTS).toHaveLength(6);
  });
});

describe("receiving", () => {
  const destroyed = (remoteId: string, extra: Record<string, unknown> = {}) => JSON.stringify({ event: "sandbox.state.updated", id: remoteId, oldState: "started", newState: "destroyed", updatedAt: "2026-11-22T11:59:00Z", ...extra });

  it("not configured: refused (503); a bad signature: 401, counted; then a valid event checks the computer at once: deleted", async () => {
    const t = setup({ publicBase: "https://host.ts.net/lumea" });
    const nina = t.computers[0]!;
    await t.manager.ensure(nina, { provider: "daytona", network: { mode: "open" }, resources: {}, providerOptions: {}, denied: [] } as never);
    const raw = destroyed("m-1");
    expect((await t.w.handle("daytona", raw, get(svixHeaders(raw)))).status).toBe(503);
    await t.w.setSecret("daytona", SECRET);
    expect((await t.w.handle("daytona", raw, get(svixHeaders(raw, { secret: `whsec_${Buffer.from("x".repeat(20)).toString("base64")}` })))).status).toBe(401);
    let [daytona] = await t.w.status();
    expect(daytona).toMatchObject({ provider: "daytona", secretSet: true, rejected: 2, state: "configured", url: "https://host.ts.net/lumea/api/v1/computers/webhooks/daytona", inUse: true });
    expect(daytona!.lastError).toMatch(/Signature refused/);
    // Daytona deleted the VM (the person did, in its dashboard) and says so
    t.provider.machines.get("m-1")!.deleted = true;
    const r = await t.w.handle("daytona", raw, get(svixHeaders(raw)));
    expect(r).toEqual({ status: 200, body: { ok: true, matched: ["nina"], ignored: 0 } });
    await t.w.idle();
    expect(t.manager.live("nina").status).toBe("deleted");
    await vi.waitFor(() => expect(t.manager.detail("nina").activity.map((a) => a.message ?? "")).toContain("The provider reported sandbox.state.updated (started → destroyed) for m-1"));
    [daytona] = await t.w.status();
    expect(daytona).toMatchObject({ received: 1, state: "receiving", lastEventType: "sandbox.state.updated", lastEventAt: new Date(NOW).toISOString() });
    // never the secret
    expect(JSON.stringify(await t.w.status())).not.toContain(SECRET);
  });

  it("idempotent: the same delivery, or the same event in another delivery, is applied once", async () => {
    const t = setup();
    await t.w.setSecret("daytona", SECRET);
    const nina = t.computers[0]!;
    await t.manager.ensure(nina, { provider: "daytona", network: { mode: "open" }, resources: {}, providerOptions: {}, denied: [] } as never);
    const spy = vi.spyOn(t.manager, "providerEvent");
    const raw = JSON.stringify({ event: "sandbox.state.updated", id: "m-1", oldState: "stopped", newState: "started", updatedAt: "u1" });
    expect((await t.w.handle("daytona", raw, get(svixHeaders(raw, { id: "msg_a" })))).body).toMatchObject({ matched: ["nina"] });
    expect((await t.w.handle("daytona", raw, get(svixHeaders(raw, { id: "msg_a" })))).body).toEqual({ ok: true, duplicate: true });
    expect((await t.w.handle("daytona", raw, get(svixHeaders(raw, { id: "msg_b" })))).body).toEqual({ ok: true, duplicate: true });
    await t.w.idle();
    expect(spy).toHaveBeenCalledTimes(1);
    // the same state as Polpo knew: no activity line for it
    expect(t.manager.detail("nina").activity.some((a) => a.kind === "notice")).toBe(false);
  });

  it("machines that are not this instance's computers are ignored; snapshots are matched by their computer's name", async () => {
    const t = setup();
    await t.w.setSecret("daytona", SECRET);
    const spy = vi.spyOn(t.manager, "providerEvent").mockResolvedValue({} as never);
    const other = destroyed("someone-elses");
    expect((await t.w.handle("daytona", other, get(svixHeaders(other)))).body).toEqual({ ok: true, matched: [], ignored: 1 });
    const name = `polpo-computer-${t.manager.labelValue("nina").replace(/[^a-z0-9]+/g, "-")}-20261122110000000`;
    const snap = JSON.stringify({ event: "snapshot.removed", id: "s1", name, removedAt: "r" });
    expect((await t.w.handle("daytona", snap, get(svixHeaders(snap, { id: "msg_s" })))).body).toMatchObject({ matched: ["nina"] });
    await t.w.idle();
    expect(spy).toHaveBeenCalledWith(t.computers[0], expect.objectContaining({ snapshotName: name, gone: true }));
    expect((await t.w.status())[0]!.ignored).toBe(1);
  });

  it("E2B events find the computer by its label; unknown providers 404; big bodies 413; floods 429", async () => {
    const box = { id: "box", name: "Box", kind: "e2b" } as ComputerConfig;
    const t = setup({ computers: [box] });
    t.vault.entries.set("$computers/webhook-e2b", { type: "custom", credentials: { secret: "s3cret", webhookId: "wh1" } });
    const spy = vi.spyOn(t.manager, "providerEvent").mockResolvedValue({} as never);
    const raw = JSON.stringify({ id: "ev1", type: "sandbox.lifecycle.killed", sandbox_id: "sbx9", timestamp: new Date(NOW).toISOString(), event_data: { sandbox_metadata: { "polpo-computer": t.manager.labelValue("box") }, kill_reason: "request" } });
    expect((await t.w.handle("e2b", raw, get({ "e2b-signature": e2bSignature("s3cret", raw) }))).body).toMatchObject({ matched: ["box"] });
    await t.w.idle();
    expect(spy).toHaveBeenCalledWith(box, expect.objectContaining({ remoteId: "sbx9", gone: true }));
    expect((await t.w.handle("vercel", "{}", get({}))).status).toBe(404);
    expect((await t.w.handle("e2b", "x".repeat(300 * 1024), get({}))).status).toBe(413);
    let last = 0;
    for (let i = 0; i < WEBHOOK_RATE_PER_MINUTE + 1; i++) last = (await t.w.handle("e2b", "{}", get({}))).status;
    expect(last).toBe(429);
  });

  it("E2B registration: Polpo registers its endpoint with a fresh secret (kept in the vault), unregisters it; automatic only with E2B computers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(init.method === "POST" ? JSON.stringify({ id: "wh_42" }) : "", { status: 200 });
    }) as unknown as typeof fetch;
    const none = setup({ publicBase: "https://host.ts.net/lumea", e2bKey: "e2b_key", fetch: fake });
    await none.w.autoRegister();
    expect(calls).toEqual([]); // no E2B computer here
    const t = setup({ computers: [{ id: "box", name: "Box", kind: "e2b" } as ComputerConfig], publicBase: "https://host.ts.net/lumea", e2bKey: "e2b_key", fetch: fake });
    expect(await t.w.pushing()).toBe(false);
    await t.w.autoRegister();
    expect(calls[0]!.url).toBe("https://api.e2b.app/events/webhooks");
    expect((calls[0]!.init.headers as Record<string, string>)["X-API-Key"]).toBe("e2b_key");
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body).toMatchObject({ url: "https://host.ts.net/lumea/api/v1/computers/webhooks/e2b", enabled: true, events: E2B_WEBHOOK_EVENTS });
    expect(body.signatureSecret.length).toBeGreaterThan(30);
    expect(t.vault.entries.get("$computers/webhook-e2b")!.credentials).toMatchObject({ secret: body.signatureSecret, webhookId: "wh_42" });
    expect((await t.w.status()).find((s) => s.provider === "e2b")).toMatchObject({ registered: true, secretSet: true, state: "configured" });
    // registered but silent: the 5-minute check stays; once events arrive the reconcile slows down
    expect(await t.w.pushing()).toBe(false);
    const ev = JSON.stringify({ id: "ev-r", type: "sandbox.lifecycle.paused", sandbox_id: "elsewhere", timestamp: new Date(NOW).toISOString() });
    expect((await t.w.handle("e2b", ev, get({ "e2b-signature": e2bSignature(body.signatureSecret, ev) }))).status).toBe(200);
    expect(await t.w.pushing()).toBe(true);
    await t.w.autoRegister();
    expect(calls).toHaveLength(1);
    await t.w.unregisterE2b();
    expect(calls[1]).toMatchObject({ url: "https://api.e2b.app/events/webhooks/wh_42", init: { method: "DELETE" } });
    expect(t.vault.entries.has("$computers/webhook-e2b")).toBe(false);
    // no public URL: it says so
    await expect(setup({ computers: [], e2bKey: "k", fetch: fake }).w.registerE2b()).rejects.toThrow(/POLPO_PUBLIC_URL/);
  });

  it("no webhook: the reconcile stays at its 5-minute pace (and is the only way a deletion is seen)", async () => {
    const t = setup();
    const nina = t.computers[0]!;
    await t.manager.ensure(nina, { provider: "daytona", network: { mode: "open" }, resources: {}, providerOptions: {}, denied: [] } as never);
    let clock = NOW;
    const every = vi.fn(async () => ((await t.w.pushing()) ? 20 * 60_000 : 5 * 60_000));
    const upkeep = new ComputerUpkeep(t.manager, () => [nina], undefined, undefined, { reconcileEveryMs: every, now: () => clock });
    t.provider.lists = 0;
    await upkeep.tick();
    expect(t.provider.lists).toBe(1);
    t.provider.machines.get("m-1")!.deleted = true;
    clock += 5 * 60_000;
    t.advance(5 * 60_000);
    await upkeep.tick();
    expect(t.manager.live("nina").status).toBe("deleted");
    expect(await every.mock.results[0]!.value).toBe(5 * 60_000);
  });
});

describe("routes", () => {
  it("public inbound (signature only) and the authenticated status / secret routes", async () => {
    const t = setup({ publicBase: "https://host.ts.net/lumea" });
    const inbound = computerWebhookInboundRoutes({ webhooks: () => t.w });
    const admin = computerWebhookAdminRoutes({ webhooks: () => t.w });
    const status = await (await admin.request("/")).json();
    expect(status.data.providers.map((p: any) => [p.provider, p.state])).toEqual([["daytona", "not-configured"], ["e2b", "not-configured"]]);
    expect(status.data.note).toMatch(/Tailscale Funnel/);
    expect((await admin.request("/daytona/secret", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "short" }) })).status).toBe(400);
    expect((await admin.request("/e2b/secret", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: SECRET }) })).status).toBe(400);
    const saved = await admin.request("/daytona/secret", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: SECRET }) });
    expect((await saved.json()).data).toMatchObject({ provider: "daytona", secretSet: true });
    const raw = JSON.stringify({ event: "sandbox.state.updated", id: "nobody", oldState: "started", newState: "stopped" });
    const res = await inbound.request("/daytona", { method: "POST", headers: { "content-type": "application/json", ...svixHeaders(raw) }, body: raw });
    expect(res.status).toBe(200);
    expect((await inbound.request("/daytona", { method: "POST", body: raw })).status).toBe(401);
    expect((await inbound.request("/daytona", { method: "POST", headers: { "content-length": String(1024 * 1024) }, body: raw })).status).toBe(413);
    expect((await admin.request("/daytona/secret", { method: "DELETE" })).status).toBe(200);
    expect((await t.w.status())[0]!.secretSet).toBe(false);
  });
});

describe("MCP polpo_computer_webhooks", () => {
  it("status with a setup link for Daytona's secret (never taken through MCP); E2B registered on request", async () => {
    const { handleMcpRequest } = await import("../server/mcp.js");
    const fake = (async (_url: string, init: RequestInit) => new Response(init.method === "POST" ? JSON.stringify({ id: "wh_1" }) : "", { status: 200 })) as unknown as typeof fetch;
    const t = setup({ publicBase: "https://host.ts.net/lumea", e2bKey: "k", fetch: fake });
    const admin = computerWebhookAdminRoutes({ webhooks: () => t.w });
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await admin.request(path.replace(/^\/api\/v1\/computer-webhooks/, "") || "/", { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    };
    const deps = { api, version: "x", toolsets: ["computers"], principal: { kind: "oauth" as const, actor: "test", scopes: ["polpo"] } };
    const call = async (args: Record<string, unknown>) => (await (await handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "polpo_computer_webhooks", arguments: args } }),
    }), deps as never)).json()).result;
    const status = await call({});
    expect(status.isError).toBeFalsy();
    expect(status.structuredContent.providers.map((p: any) => [p.provider, p.state])).toEqual([["daytona", "not-configured"], ["e2b", "not-configured"]]);
    expect(status.structuredContent.setup_id).toBe("computer-webhook:daytona:secret");
    expect(status.structuredContent.setup_url).toMatch(/\/config\?section=computers&provider=daytona&focus=secret/);
    expect(status.content[0].text).toMatch(/Webhooks → Add Endpoint/);
    const reg = await call({ action: "register", provider: "e2b" });
    expect(reg.structuredContent.providers.find((p: any) => p.provider === "e2b")).toMatchObject({ registered: true, state: "configured" });
    expect((await call({ action: "register", provider: "daytona" })).isError).toBe(true);
  });
});

describe("stale errors", () => {
  it("a 'not configured' error from before the secret was saved is not shown once configured; a newer problem is", async () => {
    const t = setup();
    const raw = JSON.stringify({ event: "sandbox.state.updated", id: "m-1", oldState: "started", newState: "stopped" });
    expect((await t.w.handle("daytona", raw, get(svixHeaders(raw)))).status).toBe(503);
    expect((await t.w.status())[0]!.lastError).toMatch(/not configured on this instance/);
    await t.w.setSecret("daytona", SECRET);
    let [d] = await t.w.status();
    expect(d).toMatchObject({ state: "configured", secretSet: true, rejected: 1 });
    expect(d!.lastError).toBeUndefined();
    expect(d!.waitingNote).toMatch(/Waiting for the first event.*Daytona v2.*every 5 minutes/s);
    // a signature problem after the configuration is shown
    t.advance(1000);
    expect((await t.w.handle("daytona", raw, get(svixHeaders(raw, { at: NOW + 1000, secret: `whsec_${Buffer.from("y".repeat(20)).toString("base64")}` })))).status).toBe(401);
    [d] = await t.w.status();
    expect(d!.lastError).toMatch(/Signature refused/);
    // an accepted (here: ignored, it is about no computer) delivery ends the wait
    const ok = await t.w.handle("daytona", raw, get(svixHeaders(raw, { id: "msg_ok", at: NOW + 1000 })));
    expect(ok.status).toBe(200);
    [d] = await t.w.status();
    expect(d!.waitingNote).toBeUndefined();
    expect(d!.state).toBe("receiving");
  });

  it("legacy status files (no error code): the 'not configured' text is recognised and hidden when configured", async () => {
    const t = setup();
    await t.w.setSecret("daytona", SECRET);
    // as on lumea: the error was written by the previous version (no code, no configuration time)
    const file = join(t.polpoDir, "computer-webhooks.json");
    const f = JSON.parse(readFileSync(file, "utf8"));
    f.providers.daytona = { received: 0, rejected: 4, ignored: 0, lastError: "Daytona webhooks are not configured on this instance", lastErrorAt: new Date(NOW + 5000).toISOString() };
    writeFileSync(file, JSON.stringify(f));
    const [d] = await t.w.status();
    expect(d).toMatchObject({ state: "configured", secretSet: true });
    expect(d!.lastError).toBeUndefined();
  });
});

describe("counts before the event log (legacy status files)", () => {
  /** A status file as the version before the event log wrote it: counters, no log. */
  const legacy = (polpoDir: string, daytona: Record<string, unknown>) =>
    writeFileSync(join(polpoDir, "computer-webhooks.json"), JSON.stringify({ version: 1, providers: { daytona }, seen: {} }));
  const agree = async (t: ReturnType<typeof setup>) => {
    const [d] = await t.w.status();
    const { counts, total } = t.w.events("daytona", { limit: 200 });
    // the card's numbers are the sheet's
    expect({ received: d!.received, ignored: d!.ignored, rejected: d!.rejected, errors: d!.errors })
      .toEqual({ received: counts.accepted + counts.ignored + counts.error, ignored: counts.ignored, rejected: counts.rejected, errors: counts.error });
    expect(d!.received + d!.rejected).toBe(total);
    return d!;
  };

  it("counters without a log (as on lumea: 7 ignored, 1 rejected, an empty log) move to `before`, once, persisted", async () => {
    const t = setup();
    await t.w.setSecret("daytona", SECRET);
    legacy(t.polpoDir, { received: 7, ignored: 7, rejected: 1, lastEventAt: new Date(NOW - 3_600_000).toISOString(), lastEventType: "sandbox.state.updated" });
    const d = await agree(t);
    expect(d).toMatchObject({ received: 0, ignored: 0, rejected: 0, errors: 0, lastEventType: "sandbox.state.updated", state: "receiving" });
    expect(d.before).toEqual({ received: 7, ignored: 7, rejected: 1, errors: 0, until: new Date(NOW).toISOString() });
    // persisted: version 2, the totals in `before`, no counters left
    const file = JSON.parse(readFileSync(join(t.polpoDir, "computer-webhooks.json"), "utf8"));
    expect(file.version).toBe(2);
    expect(file.providers.daytona).toMatchObject({ before: { received: 7, ignored: 7, rejected: 1, errors: 0 } });
    expect(file.providers.daytona.received).toBeUndefined();
    // once: reading again (another process, a restart) does not move them again
    t.advance(60_000);
    const again = new ComputerWebhooks({ polpoDir: () => t.polpoDir, manager: () => t.manager, computers: () => t.computers, vault: () => t.vault as unknown as VaultStore, now: () => NOW + 60_000 });
    expect((await again.status())[0]!.before).toEqual(d.before);
    expect((await again.status())[0]).toMatchObject({ received: 0, ignored: 0, rejected: 0 });
    // the sheet lists nothing for them
    expect(t.w.events("daytona").total).toBe(0);
  });

  it("only the difference with the log moves (the log's entries keep their own counts); `until` is the log's first entry", async () => {
    const t = setup();
    const log = new ComputerWebhookEventLog(() => t.polpoDir);
    const at = (s: number) => new Date(NOW - s * 1000).toISOString();
    log.add({ id: "a", provider: "daytona", receivedAt: at(30), outcome: "rejected", httpStatus: 503, signature: "not-checked", processingMs: 1, bytes: 2 });
    log.add({ id: "b", provider: "daytona", receivedAt: at(20), outcome: "ignored", httpStatus: 200, signature: "valid", processingMs: 1, bytes: 2 });
    log.add({ id: "c", provider: "daytona", receivedAt: at(10), outcome: "error", httpStatus: 200, signature: "valid", processingMs: 1, bytes: 2 });
    legacy(t.polpoDir, { received: 9, ignored: 5, rejected: 3, errors: 2 });
    const d = await agree(t);
    expect(d).toMatchObject({ received: 2, ignored: 1, rejected: 1, errors: 1 });
    expect(d.before).toEqual({ received: 7, ignored: 4, rejected: 2, errors: 1, until: at(30) });
  });

  it("a legacy file whose counters the log already covers gets no `before`", async () => {
    const t = setup();
    new ComputerWebhookEventLog(() => t.polpoDir).add({ id: "a", provider: "daytona", receivedAt: new Date(NOW).toISOString(), outcome: "rejected", httpStatus: 503, signature: "not-checked", processingMs: 1, bytes: 2 });
    legacy(t.polpoDir, { received: 0, ignored: 0, rejected: 1 });
    const d = await agree(t);
    expect(d.rejected).toBe(1);
    expect(d.before).toBeUndefined();
  });

  it("new deliveries count in the card and the sheet alike; `before` stays as it was (also when the first thing after the upgrade is a delivery)", async () => {
    const t = setup();
    legacy(t.polpoDir, { received: 7, ignored: 7, rejected: 1 });
    // the first delivery after the upgrade: refused (not configured), recorded before anything read the status
    const raw = JSON.stringify({ event: "sandbox.state.updated", id: "someone-elses", oldState: "started", newState: "stopped" });
    expect((await t.w.handle("daytona", raw, get(svixHeaders(raw, { id: "msg_nc" })))).status).toBe(503);
    let d = await agree(t);
    expect(d).toMatchObject({ received: 0, ignored: 0, rejected: 1 });
    expect(d.before).toMatchObject({ received: 7, ignored: 7, rejected: 1, errors: 0 });
    await t.w.setSecret("daytona", SECRET);
    expect((await t.w.handle("daytona", raw, get(svixHeaders(raw, { id: "msg_other" })))).status).toBe(200);
    const nina = t.computers[0]!;
    await t.manager.ensure(nina, { provider: "daytona", network: { mode: "open" }, resources: {}, providerOptions: {}, denied: [] } as never);
    const mine = JSON.stringify({ event: "sandbox.state.updated", id: "m-1", oldState: "started", newState: "stopped" });
    expect((await t.w.handle("daytona", mine, get(svixHeaders(mine, { id: "msg_mine" })))).body).toMatchObject({ matched: ["nina"] });
    await t.w.idle();
    d = await agree(t);
    expect(d).toMatchObject({ received: 2, ignored: 1, rejected: 1, errors: 0 });
    expect(d.before).toMatchObject({ received: 7, ignored: 7, rejected: 1, errors: 0 });
  });
});

describe("event log", () => {
  const sbx = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ event: "sandbox.state.updated", id, oldState: "started", newState: "stopped", updatedAt: `u-${id}`, ...extra });

  it("records every outcome: rejected (not configured, signature, not JSON, size), ignored (unknown sandbox, unknown event, duplicate), accepted with the status change", async () => {
    const t = setup();
    const nina = t.computers[0]!;
    await t.manager.ensure(nina, { provider: "daytona", network: { mode: "open" }, resources: {}, providerOptions: {}, denied: [] } as never);
    const raw = sbx("m-1");
    await t.w.handle("daytona", raw, get(svixHeaders(raw, { id: "msg_nc" })));
    await t.w.setSecret("daytona", SECRET);
    await t.w.handle("daytona", raw, get({ "svix-id": "msg_bad", "svix-timestamp": String(NOW / 1000), "svix-signature": "v1,nope" }));
    await t.w.handle("daytona", raw, get({}));
    await t.w.handle("daytona", "not json", get(svixHeaders("not json", { id: "msg_text" })));
    await t.w.handle("daytona", "x".repeat(300 * 1024), get({}));
    const other = sbx("someone-elses");
    await t.w.handle("daytona", other, get(svixHeaders(other, { id: "msg_other" })));
    const vol = JSON.stringify({ event: "volume.created", id: "v1" });
    await t.w.handle("daytona", vol, get(svixHeaders(vol, { id: "msg_vol" })));
    // the provider stopped the machine; the event says so
    await t.provider.suspendById("m-1");
    expect((await t.w.handle("daytona", raw, get(svixHeaders(raw, { id: "msg_1" })))).body).toMatchObject({ matched: ["nina"] });
    await t.w.handle("daytona", raw, get(svixHeaders(raw, { id: "msg_1" })));
    await t.w.idle();
    const page = t.w.events("daytona", { limit: 50 });
    expect(page.total).toBe(9);
    expect(page.counts).toEqual({ accepted: 1, ignored: 3, rejected: 5, error: 0 });
    const [dup, accepted, unknownEvent, unknownSandbox, size, text, missing, bad, notConfigured] = page.events;
    expect(notConfigured).toMatchObject({ outcome: "rejected", httpStatus: 503, signature: "not-checked", reason: expect.stringMatching(/not configured/), eventType: "sandbox.state.updated" });
    expect(bad).toMatchObject({ outcome: "rejected", httpStatus: 401, signature: "invalid", deliveryId: "msg_bad", reason: expect.stringMatching(/signature does not match/) });
    expect(missing).toMatchObject({ outcome: "rejected", signature: "missing" });
    expect(text).toMatchObject({ outcome: "rejected", httpStatus: 400, signature: "valid", reason: "Not JSON" });
    expect(size).toMatchObject({ outcome: "rejected", httpStatus: 413, reason: expect.stringMatching(/Body too large \(300 KB/) });
    expect(unknownSandbox).toMatchObject({ outcome: "ignored", sandboxId: "someone-elses", reason: expect.stringMatching(/Not about one of this instance's computers \(sandbox someone-elses\)/) });
    expect(unknownSandbox!.computerId).toBeUndefined();
    expect(unknownEvent).toMatchObject({ outcome: "ignored", eventType: "volume.created", reason: expect.stringMatching(/Not an event Polpo acts on/) });
    expect(accepted).toMatchObject({
      outcome: "accepted", httpStatus: 200, signature: "valid", eventType: "sandbox.state.updated", sandboxId: "m-1", computerId: "nina", deliveryId: "msg_1",
      providerState: { from: "started", to: "stopped" }, statusChange: { from: "running", to: "stopped" }, action: expect.stringMatching(/running → stopped/),
    });
    expect(accepted!.processingMs).toBeGreaterThanOrEqual(0);
    expect(dup).toMatchObject({ outcome: "ignored", reason: expect.stringMatching(/Duplicate delivery/) });
    // the list has no payloads; one entry has its redacted payload and safe headers
    expect("payload" in accepted!).toBe(false);
    const full = t.w.event("daytona", accepted!.id)!;
    expect(full.payload).toMatchObject({ event: "sandbox.state.updated", id: "m-1" });
    expect(full.headers).toEqual({ "svix-id": "msg_1", "svix-timestamp": String(Math.floor(NOW / 1000)) });
    expect(JSON.stringify(full)).not.toMatch(/v1,/);
    expect(t.w.event("daytona", size!.id)!.payload).toBeUndefined();
    // counters follow the log
    const [d] = await t.w.status();
    expect(d).toMatchObject({ received: 4, ignored: 3, rejected: 5, errors: 0 });
    // filtered by outcome, paged with a cursor
    expect(t.w.events("daytona", { outcomes: ["rejected"] }).events.map((e) => e.httpStatus)).toEqual([413, 400, 401, 401, 503]);
    const first = t.w.events("daytona", { limit: 4 });
    expect(first.nextCursor).toBe(first.events[3]!.id);
    const second = t.w.events("daytona", { limit: 4, cursor: first.nextCursor });
    expect(second.events[0]!.id).toBe(page.events[4]!.id);
    // announced over the bus: recorded, then updated once applied
    expect(t.emitted.filter((e) => e.id === accepted!.id).map((e) => e.action)).toEqual(["recorded", "updated"]);
  });

  it("an event Polpo cannot apply is an error, with the reason; rate-limited floods are recorded once", async () => {
    const t = setup();
    await t.w.setSecret("daytona", SECRET);
    const nina = t.computers[0]!;
    await t.manager.ensure(nina, { provider: "daytona", network: { mode: "open" }, resources: {}, providerOptions: {}, denied: [] } as never);
    vi.spyOn(t.manager, "providerEvent").mockRejectedValue(new Error("Daytona is down"));
    const raw = sbx("m-1");
    await t.w.handle("daytona", raw, get(svixHeaders(raw)));
    await t.w.idle();
    const [e] = t.w.events("daytona").events;
    expect(e).toMatchObject({ outcome: "error", computerId: "nina", reason: "Could not apply it: Daytona is down", statusChange: { from: "running", error: "Daytona is down" } });
    expect((await t.w.status())[0]).toMatchObject({ errors: 1, lastError: "Could not apply it: Daytona is down" });
    for (let i = 0; i < WEBHOOK_RATE_PER_MINUTE + 5; i++) await t.w.handle("daytona", "{}", get({}));
    expect(t.w.events("daytona", { outcomes: ["rejected"], limit: 200 }).events.filter((x) => x.httpStatus === 429)).toHaveLength(1);
  });

  it("redaction: secrets, tokens, keys and signatures by key or by value; payloads capped", () => {
    const red = redactWebhookPayload({
      event: "sandbox.created", id: "sbx", env: { OPENAI_API_KEY: "sk-abc" }, envVars: { A: "b" }, apiKey: "k", token: "t", password: "p",
      nested: { webhookSecret: "whsec_xyz", note: "auth Bearer abcdefghijklmnop and whsec_QUJDREVGR0g=", signature: "v1,abc" }, labels: { "polpo-computer": "inst:nina" }, empty: "",
    }) as Record<string, any>;
    expect(red).toMatchObject({ event: "sandbox.created", id: "sbx", env: "[redacted]", envVars: "[redacted]", apiKey: "[redacted]", token: "[redacted]", password: "[redacted]", labels: { "polpo-computer": "inst:nina" }, empty: "" });
    expect(red.nested).toEqual({ webhookSecret: "[redacted]", note: "auth [redacted] and [redacted]", signature: "[redacted]" });
    const big = webhookPayloadPreview(JSON.stringify({ event: "x", blob: "a".repeat(10_000) }));
    expect(big.truncated).toBe(true);
    expect(String(big.payload).length).toBeLessThanOrEqual(COMPUTER_WEBHOOK_PAYLOAD_MAX_BYTES + 1);
    expect(webhookPayloadPreview("plain whsec_AAAABBBBCCCC text")).toEqual({ payload: "plain [redacted] text" });
  });

  it("keeps the last N per provider (the oldest are dropped), per provider", () => {
    const dir = tmp();
    const log = new ComputerWebhookEventLog(() => dir, 5);
    for (let i = 0; i < 8; i++) log.add({ id: `e${i}`, provider: "daytona", receivedAt: `t${i}`, outcome: "ignored", httpStatus: 200, signature: "valid", processingMs: 1, bytes: 2 });
    log.add({ id: "x", provider: "e2b", receivedAt: "t", outcome: "accepted", httpStatus: 200, signature: "valid", processingMs: 1, bytes: 2 });
    expect(log.all("daytona").map((e) => e.id)).toEqual(["e7", "e6", "e5", "e4", "e3"]);
    expect(log.all("e2b").map((e) => e.id)).toEqual(["x"]);
    expect(log.update("daytona", "e0", { reason: "gone" })).toBe(false);
    expect(log.update("daytona", "e3", { reason: "kept" })).toBe(true);
    expect(log.get("daytona", "e3")!.reason).toBe("kept");
    // a broken file starts over
    writeFileSync(join(dir, "computer-webhook-events", "daytona.json"), "{");
    expect(log.all("daytona")).toEqual([]);
  });

  it("routes: list with outcome filter and cursor, one event, 404s and a bad outcome", async () => {
    const t = setup();
    const admin = computerWebhookAdminRoutes({ webhooks: () => t.w });
    const inbound = computerWebhookInboundRoutes({ webhooks: () => t.w });
    await t.w.setSecret("daytona", SECRET);
    const raw = sbx("nobody");
    await inbound.request("/daytona", { method: "POST", headers: { "content-type": "application/json", ...svixHeaders(raw) }, body: raw });
    await inbound.request("/daytona", { method: "POST", body: raw });
    // refused before being read (content-length), still recorded
    await inbound.request("/daytona", { method: "POST", headers: { "content-length": String(1024 * 1024) }, body: raw });
    const list = await (await admin.request("/daytona/events?limit=2")).json();
    expect(list.data).toMatchObject({ provider: "daytona", total: 3, counts: { ignored: 1, rejected: 2 } });
    expect(list.data.events.map((e: any) => e.httpStatus)).toEqual([413, 401]);
    expect(list.data.nextCursor).toBe(list.data.events[1].id);
    const next = await (await admin.request(`/daytona/events?cursor=${list.data.nextCursor}`)).json();
    expect(next.data.events.map((e: any) => e.outcome)).toEqual(["ignored"]);
    const only = await (await admin.request("/daytona/events?outcome=ignored")).json();
    expect(only.data.events).toHaveLength(1);
    const one = await (await admin.request(`/daytona/events/${only.data.events[0].id}`)).json();
    expect(one.data).toMatchObject({ outcome: "ignored", sandboxId: "nobody", payload: { id: "nobody" } });
    expect((await admin.request("/daytona/events/whe_nope")).status).toBe(404);
    expect((await admin.request("/vercel/events")).status).toBe(404);
    expect((await admin.request("/daytona/events?outcome=weird")).status).toBe(400);
    expect((await (await admin.request("/e2b/events")).json()).data).toMatchObject({ events: [], total: 0 });
    // unknown providers are not recorded
    await inbound.request("/vercel", { method: "POST", body: "{}" });
    expect(readFileSync(join(t.polpoDir, "computer-webhook-events", "daytona.json"), "utf8")).not.toContain("vercel");
  });

  it("MCP: events: true lists a provider's deliveries (text + structured); event_id shows one with its payload", async () => {
    const { handleMcpRequest } = await import("../server/mcp.js");
    const t = setup();
    await t.w.setSecret("daytona", SECRET);
    const admin = computerWebhookAdminRoutes({ webhooks: () => t.w });
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await admin.request(path.replace(/^\/api\/v1\/computer-webhooks/, "") || "/", { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const text = await res.text();
      return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
    };
    const deps = { api, version: "x", toolsets: ["computers"], principal: { kind: "oauth" as const, actor: "test", scopes: ["polpo"] } };
    const call = async (args: Record<string, unknown>) => (await (await handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "polpo_computer_webhooks", arguments: args } }),
    }), deps as never)).json()).result;
    // nothing yet: the waiting note
    const empty = await call({ provider: "daytona", events: true });
    expect(empty.isError).toBeFalsy();
    expect(empty.content[0].text).toMatch(/Waiting for the first event/);
    const raw = sbx("nobody");
    await t.w.handle("daytona", raw, get(svixHeaders(raw)));
    await t.w.handle("daytona", raw, get({}));
    const all = await call({ provider: "daytona", events: true });
    expect(all.structuredContent.events.map((e: any) => e.outcome)).toEqual(["rejected", "ignored"]);
    expect(all.structuredContent.counts).toMatchObject({ ignored: 1, rejected: 1 });
    expect(all.content[0].text).toMatch(/ignored sandbox\.state\.updated sandbox nobody \(started → stopped\)/);
    const rejected = await call({ provider: "daytona", events: true, outcome: ["rejected"] });
    expect(rejected.structuredContent.events).toHaveLength(1);
    const one = await call({ provider: "daytona", event_id: all.structuredContent.events[1].id });
    expect(one.structuredContent.event).toMatchObject({ outcome: "ignored", payload: { id: "nobody" } });
    expect(one.content[0].text).toMatch(/Payload \(redacted\)/);
    expect((await call({ events: true })).isError).toBe(true);
    // the status points to the log
    expect((await call({})).content[0].text).toMatch(/events: true/);
  });
});

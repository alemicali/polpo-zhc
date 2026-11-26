/**
 * Triggers end to end on a real instance (orchestrator + createApp): the public POST /hooks/:id is
 * mounted outside /api and the auth gate (an API key protects /api/v1/triggers, not the hook), the
 * REST API, the event on the orchestrator's bus, and the MCP tools with their scopes and the card.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Orchestrator } from "../core/orchestrator.js";
import { handleMcpRequest, type McpDeps } from "../server/mcp.js";

let tmpDir: string;
let app: any;
let orchestrator: Orchestrator;
const KEY = "test-api-key";

const api = (path: string, init?: { method?: string; body?: unknown; key?: string | null }) => app.request(`/api/v1${path}`, {
  method: init?.method ?? (init?.body !== undefined ? "POST" : "GET"),
  headers: { "content-type": "application/json", ...(init?.key === null ? {} : { authorization: `Bearer ${init?.key ?? KEY}` }) },
  ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
});
const json = async (res: Response) => (await res.json()) as { ok: boolean; data: any; error?: string; code?: string; details?: string[] };

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "polpo-triggers-e2e-"));
  await mkdir(join(tmpDir, ".polpo"), { recursive: true });
  await writeFile(join(tmpDir, ".polpo", "polpo.json"), JSON.stringify({ project: "triggers-e2e", team: { name: "t", agents: [] }, settings: { logLevel: "quiet" } }));
  const { Orchestrator: O } = await import("../core/orchestrator.js");
  const { SSEBridge } = await import("../server/sse-bridge.js");
  const { createApp } = await import("../server/app.js");
  orchestrator = new O(tmpDir);
  await orchestrator.initInteractive("triggers-e2e", { name: "t", agents: [] });
  const bridge = new SSEBridge(orchestrator);
  bridge.start();
  app = createApp(orchestrator, bridge, { apiKeys: [KEY] });
}, 60_000);

afterAll(async () => { if (tmpDir) await rm(tmpDir, { recursive: true, force: true }); });

describe("triggers over REST on a real instance", () => {
  test("create → POST /hooks/:id (outside the auth gate) → delivery recorded and announced on the bus; the REST API needs the key", async () => {
    expect((await api("/triggers", { key: null })).status).toBe(401);
    const created = await json(await api("/triggers", { body: {
      name: "Tally signup", contract: { schema: { type: "object", required: ["eventId"] } },
      mapping: { email: "{{body.data.fields[0].value}}" }, dedupe: { key: "{{body.eventId}}", ttlSeconds: 600 },
    } }));
    expect(created.ok).toBe(true);
    const { trigger, secret } = created.data;
    expect(trigger.path).toBe(`/hooks/${trigger.id}`);
    expect(secret).toMatch(/^pts_/);

    const seen: any[] = [];
    const onDelivery = (p: any) => seen.push(p);
    orchestrator.on("trigger:delivery", onDelivery);
    const hook = (body: unknown, auth = secret) => app.request(`/hooks/${trigger.id}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${auth}` }, body: JSON.stringify(body),
    });
    const res = await hook({ eventId: "e1", data: { fields: [{ value: "ada@example.com" }] } });
    expect(res.status).toBe(202);
    const { deliveryId, status } = await res.json() as { deliveryId: string; status: string };
    expect(status).toBe("accepted");
    expect(seen).toEqual([expect.objectContaining({ triggerId: trigger.id, deliveryId, status: "accepted", mapped: { email: "ada@example.com" } })]);
    orchestrator.off("trigger:delivery", onDelivery);

    expect((await hook({ eventId: "e1" })).status).toBe(200);
    const bad = await hook({ nope: 1 });
    expect(bad.status).toBe(400);
    expect((await bad.json() as { errors: string[] }).errors).toEqual(["body.eventId: required"]);
    expect((await hook({ eventId: "e2" }, "pts_wrong")).status).toBe(401);
    expect((await app.request("/hooks/does-not-exist-00000000", { method: "POST", body: "{}" })).status).toBe(404);

    const page = await json(await api(`/triggers/${trigger.id}/deliveries`));
    expect(page.data.counts).toMatchObject({ accepted: 1, duplicate: 1, rejected: 2 });
    const one = await json(await api(`/triggers/${trigger.id}/deliveries/${deliveryId}`));
    expect(one.data).toMatchObject({ mapped: { email: "ada@example.com" }, headers: { authorization: "[redacted]" } });
    const replay = await json(await api(`/triggers/${trigger.id}/deliveries/${deliveryId}/replay`, { body: { draft: { mapping: { id: "{{body.eventId}}" } } } }));
    expect(replay.data).toMatchObject({ status: "duplicate", mapped: { id: "e1" }, replayOf: deliveryId });
    const filtered = await json(await api(`/triggers/${trigger.id}/deliveries?status=rejected`));
    expect(filtered.data.deliveries).toHaveLength(2);
    expect((await api(`/triggers/${trigger.id}/deliveries?status=bogus`)).status).toBe(400);

    const list = await json(await api("/triggers"));
    expect(list.data[0]).toMatchObject({ id: trigger.id, stats: { lastStatus: "rejected" } });
    expect(JSON.stringify(list.data)).not.toContain(secret);
  }, 30_000);

  test("validation errors list the problems; secrets rotate and the HMAC secret is write-only; delete", async () => {
    const bad = await json(await api("/triggers", { body: { name: "x", auth: { secret: false } } }));
    expect(bad).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
    expect(bad.details).toEqual([expect.stringContaining("never open")]);
    const { data } = await json(await api("/triggers", { body: { name: "Signed", auth: { secret: false, hmac: { header: "x-signature", algorithm: "sha256", encoding: "hex" } } } }));
    const id = data.trigger.id;
    expect(data.secret).toBeUndefined();
    const set = await json(await api(`/triggers/${id}/hmac-secret`, { method: "PUT", body: { secret: "the-senders-secret" } }));
    expect(set.data).toEqual({ status: { secretSet: true } });
    const gen = await json(await api(`/triggers/${id}/hmac-secret`, { method: "PUT", body: { generate: true, overlapSeconds: 60 } }));
    expect(gen.data.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(gen.data.status.previousUntil).toBeDefined();
    expect(JSON.stringify((await json(await api(`/triggers/${id}`))).data)).not.toContain("the-senders-secret");
    const rotated = await json(await api(`/triggers/${id}/rotate-secret`, { body: { overlapSeconds: 0 } }));
    expect(rotated.data.secret).toMatch(/^pts_/);
    expect(rotated.data.trigger.auth.secret).toBe(true);
    const versions = await json(await api(`/triggers/${id}/contract-versions`));
    expect(versions.data).toHaveLength(1);
    const inferred = await json(await api("/triggers/infer-schema", { body: { sample: { a: "x@y.zz" } } }));
    expect(inferred.data.schema.properties.a).toEqual({ type: "string", format: "email" });
    expect((await json(await api(`/triggers/${id}`, { method: "DELETE" }))).data).toEqual({ deleted: true });
    expect((await api(`/triggers/${id}`)).status).toBe(404);
    expect((await orchestrator.getVaultStore()?.get("$triggers", `trigger-${id}-hmac`))).toBeUndefined();
  }, 30_000);
});

describe("triggers over MCP (on the real instance)", () => {
  const mcp = (scopes: string[]) => {
    const deps: McpDeps = {
      version: "x", toolsets: ["all"], principal: { kind: "oauth", actor: "ada@example.com via Claude", scopes },
      api: async (method, path, body) => {
        const res = await app.request(path, { method, headers: { "content-type": "application/json", authorization: `Bearer ${KEY}` }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        return { status: res.status, body: await res.json(), headers: res.headers };
      },
    };
    const rpc = (method: string, params: Record<string, unknown>) => handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }), deps).then(async (res) => (await res.json()).result);
    return { call: (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args }), list: () => rpc("tools/list", {}) };
  };

  test("read lists and shows; work creates (no secret shown) and tests; admin rotates and configures HMAC via a setup link", async () => {
    const names = async (scopes: string[]) => ((await mcp(scopes).list()).tools as Array<{ name: string }>).map((t) => t.name).filter((n) => n.includes("trigger"));
    expect((await names(["polpo:read"])).sort()).toEqual(["polpo_trigger_deliveries", "polpo_trigger_get", "polpo_trigger_show", "polpo_triggers_list"]);
    expect(await names(["polpo:work"])).not.toContain("polpo_trigger_auth");
    expect(await names(["polpo:work"])).toEqual(expect.arrayContaining(["polpo_trigger_create", "polpo_trigger_update", "polpo_trigger_delete", "polpo_trigger_test"]));
    expect(await names(["polpo:admin"])).toContain("polpo_trigger_auth");

    const work = mcp(["polpo:work"]);
    const created = await work.call("polpo_trigger_create", { name: "Typeform", mapping: { email: "{{body.email}}" }, contract: { schema: { type: "object", required: ["email"] } } });
    expect(created.isError).toBeFalsy();
    expect(created.content[0].text).toContain("needs admin scope");
    expect(created.structuredContent.secret).toBeUndefined();
    const id = created.structuredContent.trigger.id as string;
    const sent = await work.call("polpo_trigger_test", { id, action: "send", sample: { body: { email: "a@b.c" } } });
    expect(sent.content[0].text).toMatch(/Test delivery tdl_\w+: accepted/);
    expect(sent.content[0].text).toContain('"email":"a@b.c"');
    const valid = await work.call("polpo_trigger_test", { id, action: "validate", sample: { body: {} } });
    expect(valid.content[0].text).toContain("body.email: required");
    const schema = await work.call("polpo_trigger_test", { id, action: "infer_schema", sample: { body: { email: "a@b.c", n: 1 } } });
    expect(schema.structuredContent.schema.required).toEqual(["email", "n"]);

    const read = mcp(["polpo:read"]);
    const deliveries = await read.call("polpo_trigger_deliveries", { id });
    expect(deliveries.content[0].text).toMatch(/accepted \(test\) HTTP 202/);
    const card = await read.call("polpo_trigger_show", { id });
    expect(card.structuredContent).toMatchObject({ kind: "trigger", trigger: { id, name: "Typeform" }, lastMapped: { email: "a@b.c" } });
    expect(card.content[0].text).toContain("last mapped values: {\"email\":\"a@b.c\"}");
    const listCard = await read.call("polpo_trigger_show", {});
    expect(listCard.structuredContent.kind).toBe("triggers");

    const admin = mcp(["polpo:admin"]);
    const rotated = await admin.call("polpo_trigger_auth", { id, action: "rotate_secret" });
    expect(rotated.structuredContent.secret).toMatch(/^pts_/);
    const hmac = await admin.call("polpo_trigger_auth", { id, action: "hmac", hmac: { header: "typeform-signature", encoding: "base64", prefix: "sha256=" } });
    expect(hmac.structuredContent.setup_id).toBe(`trigger:${id}:hmac`);
    expect(hmac.structuredContent.setup_url).toContain(`/triggers?trigger=${id}`);
    const wait = await admin.call("polpo_setup_wait", { setup_id: `trigger:${id}:hmac`, timeout_seconds: 0 });
    expect(wait.structuredContent.status).toBe("pending");
    await api(`/triggers/${id}/hmac-secret`, { method: "PUT", body: { secret: "typeform-secret" } });
    expect((await admin.call("polpo_setup_wait", { setup_id: `trigger:${id}:hmac`, timeout_seconds: 0 })).structuredContent.status).toBe("done");
    const ip = await admin.call("polpo_trigger_auth", { id, action: "ip_allowlist", ip_allowlist: ["34.0.0.0/8"] });
    expect(ip.content[0].text).toContain("34.0.0.0/8");

    expect((await work.call("polpo_trigger_delete", { id })).isError).toBe(true);
    expect((await work.call("polpo_trigger_delete", { id, confirm: true })).structuredContent).toEqual({ deleted: true });
  }, 60_000);
});

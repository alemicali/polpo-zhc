/**
 * Triggers: the reception pipeline through the public route (POST /hooks/:id) on a bare Hono app
 * with a temporary .polpo and an in-memory vault — auth (bearer, header, query token, HMAC hex /
 * base64 with prefix and timestamp tolerance, rotation overlap, IP allowlist), content types
 * (JSON, form, multipart with files, text), size limits, contract errors, filter, dedupe, rate
 * limit, mapping, delivery pruning, 404 for unknown / disabled triggers, the event announced, and
 * the test tools (test delivery, dry run, replay, schema inference, contract diff).
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { VaultEntry, VaultStore } from "@polpo-ai/core";
import { TriggerService, TRIGGER_VAULT_OWNER, type TriggerEventPayloads } from "../triggers/service.js";
import { triggerInboundRoutes } from "../server/routes/triggers.js";
import { inferJsonSchema, ipAllowed, senderIp, signHmac, verifyHmac } from "../triggers/evaluate.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function memoryVault(): VaultStore & { entries: Map<string, VaultEntry> } {
  const entries = new Map<string, VaultEntry>();
  const k = (a: string, s: string) => `${a}/${s}`;
  return {
    entries,
    get: async (a, s) => entries.get(k(a, s)),
    getAllForAgent: async () => ({}),
    set: async (a, s, e) => { entries.set(k(a, s), e); },
    patch: async () => [],
    remove: async (a, s) => entries.delete(k(a, s)),
  } as unknown as VaultStore & { entries: Map<string, VaultEntry> };
}

function setup(o: { now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "polpo-triggers-"));
  dirs.push(dir);
  const events: Array<{ kind: keyof TriggerEventPayloads; payload: unknown }> = [];
  const vault = memoryVault();
  const service = new TriggerService({
    polpoDir: () => dir, vault: () => vault, publicBase: () => "https://host.example/acme",
    emit: (kind, payload) => { events.push({ kind, payload }); }, ...(o.now ? { now: o.now } : {}),
  });
  const app = new Hono();
  app.route("/hooks", triggerInboundRoutes({ service: () => service }));
  const post = (id: string, body: BodyInit | null, headers: Record<string, string> = {}, query = "") =>
    app.request(`/hooks/${id}${query}`, { method: "POST", headers, body, duplex: "half" } as RequestInit);
  return { dir, service, app, post, events, vault };
}

const JSON_CT = { "content-type": "application/json" };

describe("trigger definitions", () => {
  it("creates a trigger with a one-time secret (only its hash stored), an unguessable id and the public endpoint", async () => {
    const { service, dir } = setup();
    const { trigger, secret } = await service.create({ name: "Tally signup" }, "ada@example.com");
    expect(trigger.id).toMatch(/^tally-signup-[0-9a-f]{8}$/);
    expect(trigger.endpoint).toBe(`https://host.example/acme/hooks/${trigger.id}`);
    expect(trigger.path).toBe(`/hooks/${trigger.id}`);
    expect(secret).toMatch(/^pts_/);
    expect(trigger.owner).toBe("ada@example.com");
    expect(JSON.stringify(trigger)).not.toContain(secret);
    const stored = (await import("node:fs")).readFileSync(join(dir, "triggers", trigger.id, "trigger.json"), "utf8");
    expect(stored).not.toContain(secret);
    expect(trigger.secrets[0]!.hint).toBe(`${secret!.slice(0, 8)}…`);
    expect(trigger.contract).toEqual({ contentTypes: ["json"], maxBodyBytes: 262144 });
  });

  it("refuses an open trigger, bad templates, bad CIDRs, bad filters", async () => {
    const { service } = setup();
    await expect(service.create({ name: "x", auth: { secret: false } })).rejects.toThrow(/never open/);
    await expect(service.create({ name: "x", mapping: { email: "{{input.email}}" } })).rejects.toThrow(/use body\.\*, headers\.\* or query\.\*/);
    await expect(service.create({ name: "x", auth: { ipAllowlist: ["10.0.0.0/40"] } })).rejects.toThrow(/prefix/);
    await expect(service.create({ name: "x", filter: { conditions: [{ path: "status", op: "equals", value: 1 }] } })).rejects.toThrow(/starts with body/);
    await expect(service.create({ name: "x", auth: { secret: false, hmac: { header: "x-sig", algorithm: "md5" as never, encoding: "hex" } } })).rejects.toThrow(/sha256 or sha1/);
  });

  it("versions the contract on every change and diffs two versions", async () => {
    const { service } = setup();
    const { trigger } = await service.create({ name: "Form" });
    await service.update(trigger.id, { contract: { schema: { type: "object", required: ["email"] } }, contractNote: "email required" });
    await service.update(trigger.id, { name: "Renamed" }); // not a contract change
    const v = service.contractRevisions(trigger.id);
    expect(v.map((r) => r.version)).toEqual([2, 1]);
    expect(v[0]!.note).toBe("email required");
    expect((await service.get(trigger.id)).contractVersion).toBe(2);
    const { diff } = service.contractDiff(trigger.id, 1, 2);
    expect(diff).toContain("+");
    expect(diff).toContain("\"email\"");
  });
});

describe("POST /hooks/:id — authentication", () => {
  it("unknown and disabled triggers answer 404 without leaking existence", async () => {
    const { service, post } = setup();
    expect((await post("nope-12345678", "{}", JSON_CT)).status).toBe(404);
    expect((await post("../etc", "{}", JSON_CT)).status).toBe(404);
    const { trigger, secret } = await service.create({ name: "Off" });
    await service.update(trigger.id, { enabled: false });
    const res = await post(trigger.id, "{}", { ...JSON_CT, authorization: `Bearer ${secret}` });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Not found" });
  });

  it("accepts the secret as Bearer or X-Polpo-Secret; ?token= only when allowed; records refusals without the body", async () => {
    const { service, post } = setup();
    const { trigger, secret } = await service.create({ name: "Auth" });
    expect((await post(trigger.id, '{"a":1}', { ...JSON_CT, authorization: `Bearer ${secret}` })).status).toBe(202);
    expect((await post(trigger.id, '{"a":1}', { ...JSON_CT, "x-polpo-secret": secret! })).status).toBe(202);
    expect((await post(trigger.id, '{"a":1}', JSON_CT, `?token=${secret}`)).status).toBe(401);
    const wrong = await post(trigger.id, '{"secret":"leak"}', { ...JSON_CT, authorization: "Bearer pts_wrong" });
    expect(wrong.status).toBe(401);
    const refused = service.delivery(trigger.id, ((await wrong.json()) as { deliveryId: string }).deliveryId);
    expect(refused).toMatchObject({ status: "rejected", httpStatus: 401, reasons: ["Wrong or expired secret"] });
    expect(refused.body).toBeUndefined();
    expect(refused.headers.authorization).toBe("[redacted]");
    await service.update(trigger.id, { auth: { allowQueryToken: true } });
    const viaQuery = await post(trigger.id, '{"a":1}', JSON_CT, `?token=${secret}&ref=x`);
    expect(viaQuery.status).toBe(202);
    const d = service.delivery(trigger.id, ((await viaQuery.json()) as { deliveryId: string }).deliveryId);
    expect(d.auth).toMatchObject({ secret: "query" });
    expect(d.query).toEqual({ token: "[redacted]", ref: "x" });
  });

  it("rotation keeps the previous secret working for the overlap, then not; overlap 0 revokes at once", async () => {
    let now = Date.parse("2026-11-26T10:00:00Z");
    const { service, post } = setup({ now: () => now });
    const { trigger, secret: first } = await service.create({ name: "Rotate" });
    const { secret: second, previousValidUntil } = await service.rotateSecret(trigger.id, 3600);
    expect(previousValidUntil).toBe("2026-11-26T11:00:00.000Z");
    const send = (s: string) => post(trigger.id, "{}", { ...JSON_CT, authorization: `Bearer ${s}` });
    expect((await send(first!)).status).toBe(202);
    expect((await send(second)).status).toBe(202);
    now += 3601_000;
    expect((await send(first!)).status).toBe(401);
    expect((await send(second)).status).toBe(202);
    const { secret: third } = await service.rotateSecret(trigger.id, 0);
    expect((await send(second)).status).toBe(401);
    expect((await send(third)).status).toBe(202);
    expect((await service.get(trigger.id)).secrets).toHaveLength(1);
  });

  it("HMAC hex with a prefix, base64, timestamp tolerance, and the previous HMAC secret during the overlap", async () => {
    let now = Date.parse("2026-11-26T10:00:00Z");
    const { service, post, vault } = setup({ now: () => now });
    const hmac = { header: "X-Hub-Signature-256", algorithm: "sha256" as const, encoding: "hex" as const, prefix: "sha256=" };
    const { trigger, secret } = await service.create({ name: "Hub", auth: { secret: false, hmac } });
    expect(secret).toBeUndefined();
    expect((await service.get(trigger.id)).hmacSecret).toEqual({ secretSet: false });
    const body = '{"event":"push"}';
    // not set yet: refused
    expect((await post(trigger.id, body, { ...JSON_CT, "x-hub-signature-256": signHmac(hmac, body, "s3cret-one") })).status).toBe(401);
    await service.setHmacSecret(trigger.id, { secret: "s3cret-one" });
    expect([...vault.entries.keys()]).toEqual([`${TRIGGER_VAULT_OWNER}/trigger-${trigger.id}-hmac`]);
    const ok = await post(trigger.id, body, { ...JSON_CT, "x-hub-signature-256": signHmac(hmac, body, "s3cret-one") });
    expect(ok.status).toBe(202);
    const tampered = await post(trigger.id, '{"event":"pull"}', { ...JSON_CT, "x-hub-signature-256": signHmac(hmac, body, "s3cret-one") });
    expect(tampered.status).toBe(401);
    // rotation with overlap: both work for an hour
    await service.setHmacSecret(trigger.id, { secret: "s3cret-two", overlapSeconds: 3600 });
    expect((await post(trigger.id, body, { ...JSON_CT, "x-hub-signature-256": signHmac(hmac, body, "s3cret-one") })).status).toBe(202);
    expect((await post(trigger.id, body, { ...JSON_CT, "x-hub-signature-256": signHmac(hmac, body, "s3cret-two") })).status).toBe(202);
    now += 3601_000;
    expect((await post(trigger.id, body, { ...JSON_CT, "x-hub-signature-256": signHmac(hmac, body, "s3cret-one") })).status).toBe(401);
    // the secret is never echoed
    expect(JSON.stringify(await service.get(trigger.id))).not.toContain("s3cret");
  });

  it("verifies Standard Webhooks (webhook-id / -timestamp / -signature v1,<base64>, whsec_ secret, rotation)", () => {
    const now = Date.parse("2026-11-26T19:40:12Z");
    const cfg = { scheme: "standard-webhooks" as const, header: "webhook-signature", algorithm: "sha256" as const, encoding: "base64" as const };
    const keyBytes = Buffer.from("polpo-standard-webhooks-test-key-32b!");
    const secret = `whsec_${keyBytes.toString("base64")}`;
    const raw = Buffer.from('{"type":"site.offer_reserved.v1","data":{"attivita":"Barberia Mario"}}');
    const id = "msg_2Kq9";
    const ts = String(Math.floor(now / 1000));
    const sign = (key: Buffer) => createHmac("sha256", key).update(`${id}.${ts}.`).update(raw).digest("base64");
    const good = `v1,${sign(keyBytes)}`;
    const headers = (h: Record<string, string>) => (n: string) => h[n];
    const ok = { "webhook-id": id, "webhook-timestamp": ts };
    expect(verifyHmac(cfg, raw, headers({ ...ok, "webhook-signature": good }), { current: secret }, now)).toEqual({ ok: true, which: "current" });
    // two signatures after a sender-side rotation: any match is enough
    expect(verifyHmac(cfg, raw, headers({ ...ok, "webhook-signature": `v1,${sign(Buffer.from("old"))} ${good}` }), { current: secret }, now)).toEqual({ ok: true, which: "current" });
    expect(verifyHmac(cfg, raw, headers({ ...ok, "webhook-signature": `v1,${sign(Buffer.from("old"))}` }), { current: secret }, now)).toMatchObject({ ok: false, reason: "Invalid signature" });
    // the body or the id changed: invalid
    expect(verifyHmac(cfg, Buffer.from(raw.toString() + " "), headers({ ...ok, "webhook-signature": good }), { current: secret }, now)).toMatchObject({ ok: false });
    expect(verifyHmac(cfg, raw, headers({ ...ok, "webhook-id": "msg_other", "webhook-signature": good }), { current: secret }, now)).toMatchObject({ ok: false });
    // older than 5 minutes, missing headers, no v1 entry
    expect(verifyHmac(cfg, raw, headers({ ...ok, "webhook-signature": good }), { current: secret }, now + 301_000)).toMatchObject({ ok: false, reason: expect.stringContaining("tolerance") });
    expect(verifyHmac(cfg, raw, headers({ "webhook-timestamp": ts, "webhook-signature": good }), { current: secret }, now)).toMatchObject({ ok: false, reason: expect.stringContaining("webhook-id") });
    expect(verifyHmac(cfg, raw, headers({ ...ok, "webhook-signature": `v2,${sign(keyBytes)}` }), { current: secret }, now)).toMatchObject({ ok: false, reason: expect.stringContaining("v1") });
    // the secret's previous value during our own overlap
    expect(verifyHmac(cfg, raw, headers({ ...ok, "webhook-signature": good }), { current: "whsec_b3RoZXI=", previous: secret }, now)).toEqual({ ok: true, which: "previous" });
  });

  it("verifies base64 signatures over {timestamp}.{body} within the tolerance only", () => {
    const now = Date.parse("2026-11-26T10:00:00Z");
    const cfg = { header: "typeform-signature", algorithm: "sha256" as const, encoding: "base64" as const, prefix: "sha256=", timestampHeader: "x-ts", toleranceSeconds: 300, signedPayload: "{timestamp}.{body}" };
    const raw = Buffer.from('{"form_response":{}}');
    const ts = String(Math.floor(now / 1000));
    const sig = signHmac(cfg, raw, "k", ts);
    expect(sig.startsWith("sha256=")).toBe(true);
    const headers = (h: Record<string, string>) => (n: string) => h[n];
    expect(verifyHmac(cfg, raw, headers({ "typeform-signature": sig, "x-ts": ts }), { current: "k" }, now)).toEqual({ ok: true, which: "current" });
    expect(verifyHmac(cfg, raw, headers({ "typeform-signature": sig, "x-ts": ts }), { current: "k" }, now + 301_000)).toMatchObject({ ok: false, reason: expect.stringContaining("tolerance") });
    expect(verifyHmac(cfg, raw, headers({ "typeform-signature": sig }), { current: "k" }, now)).toMatchObject({ ok: false, reason: expect.stringContaining("timestamp") });
    expect(verifyHmac(cfg, raw, headers({ "typeform-signature": sig, "x-ts": ts }), { current: "other", previous: "k" }, now)).toEqual({ ok: true, which: "previous" });
    // sha1 hex, no prefix, a Stripe-like list of signatures
    const s1 = { header: "x-sig", algorithm: "sha1" as const, encoding: "hex" as const };
    expect(verifyHmac(s1, raw, headers({ "x-sig": `v0=deadbeef,v1=${signHmac(s1, raw, "k")}` }), { current: "k" }, now)).toEqual({ ok: true, which: "current" });
  });

  it("IP allowlist: CIDR v4 and v6; outside it answers 404 and is recorded; the address comes from the proxy's X-Forwarded-For", async () => {
    expect(ipAllowed("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("::ffff:10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("11.1.2.3", ["10.0.0.0/8", "192.168.1.5"])).toBe(false);
    expect(ipAllowed("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(ipAllowed(undefined, ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed(undefined, [])).toBe(true);
    // behind a local proxy the last X-Forwarded-For entry (added by the proxy) counts; a public socket ignores the header
    expect(senderIp("127.0.0.1", "6.6.6.6, 34.1.2.3")).toBe("34.1.2.3");
    expect(senderIp("34.1.2.3", "10.0.0.1")).toBe("34.1.2.3");

    const { service, post } = setup();
    const { trigger, secret } = await service.create({ name: "Ip", auth: { ipAllowlist: ["34.1.2.0/24"] } });
    const auth = { ...JSON_CT, authorization: `Bearer ${secret}` };
    expect((await post(trigger.id, "{}", { ...auth, "x-forwarded-for": "34.1.2.9" })).status).toBe(202);
    expect((await post(trigger.id, "{}", { ...auth, "x-forwarded-for": "8.8.8.8" })).status).toBe(404);
    const page = service.deliveries(trigger.id, { statuses: ["rejected"] });
    expect(page.deliveries[0]!.reasons[0]).toContain("8.8.8.8");
  });
});

describe("POST /hooks/:id — content, contract, filter, dedupe, rate limit, mapping", () => {
  it("parses JSON, form, multipart (files as metadata, per-file cap) and text; refuses other types with 415", async () => {
    const { service, post } = setup();
    const { trigger, secret } = await service.create({ name: "Kinds", contract: { contentTypes: ["json", "form", "multipart", "text"], maxFileBytes: 20 } });
    const auth = { authorization: `Bearer ${secret}` };
    const id = async (res: Response) => ((await res.json()) as { deliveryId: string }).deliveryId;
    const form = await post(trigger.id, "name=Ada&tag=a&tag=b", { ...auth, "content-type": "application/x-www-form-urlencoded" });
    expect(service.delivery(trigger.id, await id(form)).body).toEqual({ name: "Ada", tag: ["a", "b"] });
    const text = await post(trigger.id, "hello", { ...auth, "content-type": "text/plain" });
    expect(service.delivery(trigger.id, await id(text)).body).toBe("hello");
    const fd = new FormData();
    fd.append("name", "Ada");
    fd.append("cv", new Blob(["%PDF-small"], { type: "application/pdf" }), "cv.pdf");
    const multi = await post(trigger.id, fd, auth);
    expect(multi.status).toBe(202);
    const d = service.delivery(trigger.id, await id(multi));
    expect(d.kind).toBe("multipart");
    expect(d.files).toEqual([expect.objectContaining({ field: "cv", filename: "cv.pdf", contentType: "application/pdf", size: 10, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) })]);
    expect(d.body).toMatchObject({ name: "Ada", cv: { filename: "cv.pdf", size: 10 } });
    const big = new FormData();
    big.append("cv", new Blob(["x".repeat(50)]), "big.bin");
    expect((await post(trigger.id, big, auth)).status).toBe(413);
    expect((await post(trigger.id, "<a/>", { ...auth, "content-type": "application/xml" })).status).toBe(415);
    const onlyJson = await service.create({ name: "Json only" });
    expect((await post(onlyJson.trigger.id, "a=1", { authorization: `Bearer ${onlyJson.secret}`, "content-type": "application/x-www-form-urlencoded" })).status).toBe(415);
    expect((await post(onlyJson.trigger.id, "{bad", { authorization: `Bearer ${onlyJson.secret}`, ...JSON_CT })).status).toBe(400);
  });

  it("caps the body: Content-Length and a streamed body over maxBodyBytes get 413", async () => {
    const { service, post } = setup();
    const { trigger, secret } = await service.create({ name: "Small", contract: { maxBodyBytes: 32 } });
    const auth = { ...JSON_CT, authorization: `Bearer ${secret}` };
    expect((await post(trigger.id, JSON.stringify({ text: "x".repeat(100) }), auth)).status).toBe(413);
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(`{"t":"${"y".repeat(100)}"}`)); c.close(); } });
    const res = await post(trigger.id, stream as unknown as BodyInit, auth);
    expect(res.status).toBe(413);
    expect(service.deliveries(trigger.id).counts.rejected).toBe(2);
  });

  it("contract: 400 with the list of errors; the delivery keeps the body and the errors", async () => {
    const { service, post } = setup();
    const { trigger, secret } = await service.create({ name: "Contract", contract: { schema: { type: "object", required: ["email", "age"], properties: { email: { type: "string", format: "email" }, age: { type: "integer", minimum: 18 } } } } });
    const res = await post(trigger.id, '{"age":12}', { ...JSON_CT, authorization: `Bearer ${secret}` });
    expect(res.status).toBe(400);
    const b = await res.json() as { errors: string[]; status: string; deliveryId: string };
    expect(b.status).toBe("rejected");
    expect(b.errors).toEqual(["body.email: required", "body.age: must be ≥ 18"]);
    expect(service.delivery(trigger.id, b.deliveryId)).toMatchObject({ status: "rejected", errors: b.errors, body: { age: 12 }, contractVersion: 1 });
  });

  it("filter: deliveries not matching are recorded as filtered (202), with the mapping shown", async () => {
    const { service, post } = setup();
    const { trigger, secret } = await service.create({
      name: "Filter", filter: { mode: "all", conditions: [{ path: "body.event", op: "equals", value: "submitted" }, { path: "body.score", op: "gte", value: 5 }] },
      mapping: { email: "{{body.email}}" },
    });
    const auth = { ...JSON_CT, authorization: `Bearer ${secret}` };
    const r1 = await post(trigger.id, '{"event":"started","score":9,"email":"a@b.c"}', auth);
    expect(r1.status).toBe(202);
    expect(await r1.json()).toMatchObject({ status: "filtered" });
    const r2 = await post(trigger.id, '{"event":"submitted","score":9}', auth);
    expect(await r2.json()).toMatchObject({ status: "accepted" });
    const any = await service.update(trigger.id, { filter: { mode: "any", conditions: [{ path: "headers.x-env", op: "equals", value: "prod" }, { path: "body.vip", op: "exists" }] } });
    expect(any.trigger.filter?.mode).toBe("any");
    expect(await (await post(trigger.id, '{"vip":true}', auth)).json()).toMatchObject({ status: "accepted" });
    expect(await (await post(trigger.id, "{}", { ...auth, "x-env": "PROD" })).json()).toMatchObject({ status: "accepted" });
    expect(await (await post(trigger.id, "{}", auth)).json()).toMatchObject({ status: "filtered" });
  });

  it("dedupe: the same key within the window is a duplicate answered 200 with the original id; after the TTL it is new again", async () => {
    let now = Date.parse("2026-11-26T10:00:00Z");
    const { service, post } = setup({ now: () => now });
    const { trigger, secret } = await service.create({ name: "Dedupe", dedupe: { key: "{{body.submission_id}}", ttlSeconds: 60 } });
    const auth = { ...JSON_CT, authorization: `Bearer ${secret}` };
    const first = await post(trigger.id, '{"submission_id":"s-1"}', auth);
    expect(first.status).toBe(202);
    const original = ((await first.json()) as { deliveryId: string }).deliveryId;
    const dup = await post(trigger.id, '{"submission_id":"s-1","retry":true}', auth);
    expect(dup.status).toBe(200);
    const dupBody = await dup.json() as { deliveryId: string; status: string; duplicateDeliveryId: string };
    expect(dupBody).toMatchObject({ deliveryId: original, status: "duplicate" });
    expect(service.delivery(trigger.id, dupBody.duplicateDeliveryId)).toMatchObject({ status: "duplicate", duplicateOf: original });
    expect(JSON.stringify(service.delivery(trigger.id, original))).not.toContain("\"s-1\"," /* the key is stored only as a hash */);
    expect((await post(trigger.id, '{"submission_id":"s-2"}', auth)).status).toBe(202);
    now += 61_000;
    expect((await post(trigger.id, '{"submission_id":"s-1"}', auth)).status).toBe(202);
    // a header as the key
    await service.update(trigger.id, { dedupe: { key: "{{headers.x-request-id}}", ttlSeconds: 60 } });
    expect((await post(trigger.id, "{}", { ...auth, "x-request-id": "r1" })).status).toBe(202);
    expect((await post(trigger.id, "{}", { ...auth, "x-request-id": "r1" })).status).toBe(200);
  });

  it("rate limit per trigger: 429 with Retry-After; one rate_limited record a minute counting the refusals", async () => {
    let now = Date.parse("2026-11-26T10:00:00Z");
    const { service, post } = setup({ now: () => now });
    const { trigger, secret } = await service.create({ name: "Rate", rateLimitPerMinute: 2 });
    const auth = { ...JSON_CT, authorization: `Bearer ${secret}` };
    expect((await post(trigger.id, "{}", auth)).status).toBe(202);
    expect((await post(trigger.id, "{}", auth)).status).toBe(202);
    const limited = await post(trigger.id, "{}", auth);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post(trigger.id, "{}", auth)).status).toBe(429);
    const page = service.deliveries(trigger.id, { statuses: ["rate_limited"] });
    expect(page.deliveries).toHaveLength(1);
    expect(page.deliveries[0]!.count).toBe(2);
    expect((await service.get(trigger.id)).stats.counts.rate_limited).toBe(2);
    now += 61_000;
    expect((await post(trigger.id, "{}", auth)).status).toBe(202);
  });

  it("mapping: named fields over body, headers and query, typed when a template is one placeholder; secrets redacted from the stored headers", async () => {
    const { service, post } = setup();
    const { trigger, secret } = await service.create({ name: "Map", mapping: {
      email: "{{body.data.fields[0].value}}", answers: "{{body.data.fields}}", source: "{{query.utm ?? \"direct\"}}", greeting: "Hi {{body.name}}!", request: "{{headers.x-request-id}}",
    } });
    const res = await post(trigger.id, JSON.stringify({ name: "Ada", password: "hunter2", data: { fields: [{ key: "email", value: "ada@example.com" }] } }),
      { ...JSON_CT, authorization: `Bearer ${secret}`, "x-request-id": "rq-7", cookie: "sid=1" }, "?utm=newsletter");
    const d = service.delivery(trigger.id, ((await res.json()) as { deliveryId: string }).deliveryId);
    expect(d.mapped).toEqual({ email: "ada@example.com", answers: [{ key: "email", value: "ada@example.com" }], source: "newsletter", greeting: "Hi Ada!", request: "rq-7" });
    expect(d.headers.authorization).toBe("[redacted]");
    expect(d.headers.cookie).toBe("[redacted]");
    expect((d.body as { password: string }).password).toBe("[redacted]");
  });

  it("announces every delivery (trigger:delivery) with the mapped values, and changes (trigger:changed)", async () => {
    const { service, post, events } = setup();
    const { trigger, secret } = await service.create({ name: "Events", mapping: { e: "{{body.e}}" } });
    await post(trigger.id, '{"e":"x"}', { ...JSON_CT, authorization: `Bearer ${secret}` });
    expect(events.map((e) => e.kind)).toEqual(["changed", "delivery"]);
    expect(events[1]!.payload).toMatchObject({ triggerId: trigger.id, status: "accepted", httpStatus: 202, mapped: { e: "x" } });
    expect(events[1]!.payload).not.toHaveProperty("test");
  });

  it("keeps the newest N deliveries per trigger (retention), pruning the files too", async () => {
    const { service, post, dir } = setup();
    const { trigger, secret } = await service.create({ name: "Prune", retention: 3 });
    for (let i = 0; i < 5; i++) await post(trigger.id, JSON.stringify({ i }), { ...JSON_CT, authorization: `Bearer ${secret}` });
    const page = service.deliveries(trigger.id);
    expect(page.total).toBe(3);
    expect(page.deliveries.map((d) => service.delivery(trigger.id, d.id).body)).toEqual([{ i: 4 }, { i: 3 }, { i: 2 }]);
    expect(readdirSync(join(dir, "triggers", trigger.id, "deliveries")).filter((f) => f.startsWith("tdl_"))).toHaveLength(3);
    await service.update(trigger.id, { retention: 1 });
    expect(service.deliveries(trigger.id).total).toBe(1);
    expect(readdirSync(join(dir, "triggers", trigger.id, "deliveries")).filter((f) => f.startsWith("tdl_"))).toHaveLength(1);
  });
});

describe("test tools", () => {
  it("a test delivery goes through contract, filter, dedupe and mapping, recorded with test: true", async () => {
    const { service, events } = setup();
    const { trigger } = await service.create({ name: "Test", contract: { schema: { type: "object", required: ["email"] } }, mapping: { to: "{{body.email}}" } });
    const d = service.test(trigger.id, { body: { email: "a@b.c" } });
    expect(d).toMatchObject({ status: "accepted", test: true, httpStatus: 202, mapped: { to: "a@b.c" } });
    expect(service.test(trigger.id, { body: {} })).toMatchObject({ status: "rejected", errors: ["body.email: required"], test: true });
    expect(events.at(-1)!.payload).toMatchObject({ test: true, status: "rejected" });
    expect(service.deliveries(trigger.id, { test: false }).deliveries).toHaveLength(0);
  });

  it("validates a sample against the saved or a draft contract / filter / mapping without recording; replays a stored delivery", async () => {
    const { service } = setup();
    const { trigger } = await service.create({ name: "Dry", mapping: { n: "{{body.n}}" } });
    const stored = service.test(trigger.id, { body: { n: 3 } });
    const before = service.deliveries(trigger.id).total;
    expect(service.dryRun(trigger.id, { sample: { body: { n: 1 } } })).toMatchObject({ status: "accepted", errors: [], filterMatched: true, mapped: { n: 1 } });
    const draft = service.dryRun(trigger.id, { sample: { body: { n: 1 } }, draft: { contract: { schema: { type: "object", properties: { n: { type: "string" } } } }, filter: { conditions: [{ path: "body.n", op: "gte", value: 2 }] } } });
    expect(draft).toMatchObject({ status: "rejected", errors: ["body.n: must be string (is integer)"] });
    const replay = service.dryRun(trigger.id, { deliveryId: stored.id, draft: { filter: { conditions: [{ path: "body.n", op: "lte", value: 2 }] } } });
    expect(replay).toMatchObject({ status: "filtered", filterMatched: false, replayOf: stored.id, mapped: { n: 3 } });
    expect(service.deliveries(trigger.id).total).toBe(before);
    expect(() => service.dryRun(trigger.id, { sample: { body: {} }, draft: { mapping: { x: "{{nope.y}}" } } })).toThrow(/Invalid draft/);
  });

  it("infers a JSON Schema from a sample (types, formats, required, merged list items)", () => {
    expect(inferJsonSchema({ email: "a@b.co", at: "2026-11-26T10:00:00Z", n: 2, ok: true, tags: [{ a: 1 }, { a: 1.5, b: "x" }], none: null })).toEqual({
      type: "object",
      properties: {
        email: { type: "string", format: "email" }, at: { type: "string", format: "date-time" }, n: { type: "integer" }, ok: { type: "boolean" },
        tags: { type: "array", items: { type: "object", properties: { a: { type: "number" }, b: { type: "string" } }, required: ["a"] } }, none: { type: "null" },
      },
      required: ["email", "at", "n", "ok", "tags"],
    });
    const { service } = setup();
    expect(service.inferSchema({ sample: { a: 1 } })).toMatchObject({ $schema: expect.any(String), type: "object", required: ["a"] });
  });
});

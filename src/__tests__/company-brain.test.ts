import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { CompanyBrainRuntime } from "../server/company-brain-runtime.js";
import { companyBrainRoutes } from "../server/routes/company-brain.js";

describe("Company Brain", () => {
  let runtime: CompanyBrainRuntime;

  beforeEach(async () => {
    runtime = new CompanyBrainRuntime(await mkdtemp(join(tmpdir(), "polpo-brain-")));
  });

  it("resolves canonical entities and preserves evidence-aware claims", async () => {
    const sourceEvidence = [{
      id: "ev-1", sourceType: "manual" as const, sourceId: "notes", observedAt: new Date().toISOString(), confidence: 0.9,
    }];
    const first = await runtime.upsertEntity({ type: "Customer", name: "Acme Corp", evidence: sourceEvidence });
    const resolved = await runtime.upsertEntity({ type: "customer", name: "ACME CORP", aliases: ["Acme"], summary: "Strategic account" });
    expect(resolved.id).toBe(first.id);
    expect((await runtime.stats()).entities).toBe(1);

    await runtime.upsertClaim({ entityId: first.id, predicate: "annual_revenue", value: 120, evidence: sourceEvidence });
    await runtime.upsertClaim({ entityId: first.id, predicate: "annual_revenue", value: 130, evidence: sourceEvidence });
    const detail = await runtime.getEntity(first.id);
    expect(detail.claims).toHaveLength(2);
    expect(detail.entity.aliases).toContain("Acme");
  });

  it("builds neighborhoods and rewires relations during entity resolution", async () => {
    const company = await runtime.upsertEntity({ type: "company", name: "Lumea", status: "confirmed" });
    const duplicate = await runtime.upsertEntity({ id: "duplicate", type: "organization", name: "Lumea Labs" });
    const product = await runtime.upsertEntity({ type: "product", name: "Polpo" });
    await runtime.upsertRelation({ fromId: duplicate.id, toId: product.id, type: "builds" });

    const merged = await runtime.mergeEntities(company.id, [duplicate.id]);
    const graph = await runtime.graph({ entityId: company.id, depth: 1 });
    expect(merged.aliases).toContain("Lumea Labs");
    expect(graph.entities.map((entity) => entity.id)).toContain(product.id);
    expect(graph.relations[0]?.fromId).toBe(company.id);
  });

  it("enforces per-agent capability and entity-type grants", async () => {
    await expect(runtime.upsertEntity({ type: "customer", name: "Blocked" }, { agent: "analyst" })).rejects.toThrow("scoped grant");
    await runtime.setGrant("analyst", "write", ["customer"]);
    await runtime.upsertEntity({ type: "customer", name: "Visible" }, { agent: "analyst" });
    await expect(runtime.upsertEntity({ type: "employee", name: "Hidden" }, { agent: "analyst" })).rejects.toThrow("for employee");
    const graph = await runtime.graph({}, { agent: "analyst" });
    expect(graph.entities.map((entity) => entity.name)).toEqual(["Visible"]);
  });

  it("exposes graph CRUD over the REST surface", async () => {
    const app = companyBrainRoutes(() => runtime);
    const created = await app.request("/entities", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "project", name: "Atlas", status: "confirmed" }),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as { data: { id: string } };
    const graph = await app.request("/graph?types=project");
    const graphBody = await graph.json() as { data: { entities: Array<{ id: string }> } };
    expect(graphBody.data.entities[0]?.id).toBe(body.data.id);
    expect((await app.request(`/entities/${body.data.id}`, { method: "DELETE" })).status).toBe(200);
  });
});

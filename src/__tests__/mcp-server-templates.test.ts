/**
 * Ready-made hosted connectors: settings (validation, `{{settings.x}}`, variable fallbacks), scoped
 * default headers (Printful's X-PF-Store-Id), output shaping (filters, local paging, aggregates,
 * whole items instead of a cut), write-only secrets, the install flow (settings → secrets → agents →
 * read-only tests → publish) and the template upgrade (a new draft with the diff), every template's
 * tools against mocked APIs, and the catalog over REST and MCP. Never calls a real API.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VaultStore } from "@polpo-ai/core";
import { fitText, renderString, renderUrl, shapeResponse } from "../mcp-servers/template.js";
import { executeHttpTool, requestTemplates } from "../mcp-servers/http-executor.js";
import { effectiveSettings, validateSettings } from "../mcp-servers/settings.js";
import { normalizeSpec, specProblems } from "../mcp-servers/validate.js";
import { McpServerService } from "../mcp-servers/service.js";
import { runTool } from "../mcp-servers/runtime.js";
import { GELATO_TEMPLATE, MCP_SERVER_TEMPLATES, PRINTFUL_TEMPLATE, PRINTIFY_TEMPLATE } from "../mcp-servers/templates/index.js";
import type { McpServerTemplate } from "../mcp-servers/templates/index.js";
import { ConnectorManager } from "../mcp/manager.js";
import { mcpServerRoutes } from "../server/routes/mcp-servers.js";
import type { McpServerTool } from "../mcp-servers/types.js";

const TOKEN = "pf_secret_token_123456";
const resolve = async () => ["93.184.216.34"];
const noSleep = async () => undefined;
const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function memoryVault(seed: Record<string, Record<string, string>> = {}) {
  const entries = new Map<string, any>(Object.entries(seed).map(([k, credentials]) => [k, { type: "api_key", credentials }]));
  const vault = {
    get: async (o: string, s: string) => entries.get(`${o}/${s}`),
    set: async (o: string, s: string, e: any) => { entries.set(`${o}/${s}`, e); },
    remove: async (o: string, s: string) => entries.delete(`${o}/${s}`),
    getAllForAgent: async () => ({}),
    patch: async () => [],
  } as unknown as VaultStore;
  return { vault, entries };
}

/** A Printful product with many variants (like product 71: 200+ variants). */
function printfulProduct() {
  const colors = ["Black", "White", "Heather White", "Navy", "Red", "Athletic Heather", "Kelly", "Maroon"];
  const sizes = ["XS", "S", "M", "L", "XL", "2XL", "3XL"];
  const variants = colors.flatMap((color, ci) => sizes.map((size, si) => ({
    id: 4000 + ci * 10 + si, product_id: 71, name: `Unisex Staple T-Shirt (${color} / ${size})`, size, color, color_code: "#000000",
    image: `https://files.cdn.printful.com/products/71/${ci}_${si}.jpg`, price: (9.25 + si * 0.5).toFixed(2), in_stock: !(color === "Red" && size === "M"),
    availability_regions: { US: "United States", EU: "Europe" }, availability_status: [{ region: "US", status: "in_stock" }, { region: "EU", status: "in_stock" }],
  })));
  return { code: 200, result: { product: { id: 71, title: "Unisex Staple T-Shirt | Bella + Canvas 3001", type_name: "T-Shirt", brand: "Bella + Canvas", model: "3001", description: "Soft".repeat(50), files: [{ id: "default" }], techniques: [{ key: "DTG" }] }, variants } };
}

describe("settings", () => {
  const schema = [
    { key: "store_id", label: "Store id", type: "string" as const, pattern: "\\d{1,12}" },
    { key: "currency", label: "Currency", type: "enum" as const, options: ["EUR", "USD"], default: "EUR" },
    { key: "limit", label: "Limit", type: "number" as const, min: 1, max: 50, required: true },
    { key: "sandbox", label: "Sandbox", type: "boolean" as const },
  ];

  it("validates and coerces typed values; unknown keys and bad formats are problems; defaults fill in", () => {
    expect(validateSettings(schema, { store_id: "123", currency: "USD", limit: "20", sandbox: "true" })).toEqual({ values: { store_id: "123", currency: "USD", limit: 20, sandbox: true }, problems: [] });
    const bad = validateSettings(schema, { store_id: "abc", currency: "GBP", limit: 99, nope: 1 });
    expect(bad.problems.join("\n")).toMatch(/"nope" is not a setting/);
    expect(bad.problems.join("\n")).toMatch(/Store id \(store_id\) does not have the expected format/);
    expect(bad.problems.join("\n")).toMatch(/must be one of EUR, USD/);
    expect(bad.problems.join("\n")).toMatch(/at most 50/);
    expect(validateSettings(schema, {}).problems).toEqual(["Limit (limit) is required"]);
    expect(effectiveSettings(schema, { limit: 5 })).toEqual({ currency: "EUR", limit: 5 });
  });

  it("renders {{settings.x}} in URLs, headers and bodies, and variable fallbacks ({{input.x ?? settings.y}})", () => {
    const scope = { input: { cur: undefined }, settings: { shop_id: "77", currency: "EUR" } };
    expect(renderUrl("/shops/{{settings.shop_id}}/orders.json", scope)).toBe("/shops/77/orders.json");
    expect(() => renderUrl("/shops/{{settings.nope}}", scope)).toThrow(/set it in the server's settings/);
    expect(renderString("{{input.cur ?? settings.currency}}", scope)).toBe("EUR");
    expect(renderString("{{input.cur ?? settings.currency}}", { ...scope, input: { cur: "USD" } })).toBe("USD");
    expect(renderString("{{settings.missing}}", scope)).toBeUndefined();
  });

  it("validation: settings must be declared, scopes must exist, filter inputs must be input properties", () => {
    const s = normalizeSpec({
      name: "x", baseUrl: "https://a.test", allowedDomains: ["a.test"],
      headers: { "X-A": "{{settings.undeclared}}" },
      tools: [{
        name: "t", description: "d", kind: "http", scopes: ["nope"], inputSchema: { type: "object", properties: { q: { type: "string" } } },
        http: { method: "GET", url: "/x/{{settings.other}}", response: { filters: [{ path: "a", input: "missing" }] } },
      }],
    });
    const problems = specProblems(s).join("\n");
    expect(problems).toMatch(/server defaults: \{\{settings.undeclared\}\} is not a declared setting/);
    expect(problems).toMatch(/t: \{\{settings.other\}\} is not a declared setting/);
    expect(problems).toMatch(/scope "nope" is not declared/);
    expect(problems).toMatch(/filter input "missing" is not an input property/);
    for (const t of MCP_SERVER_TEMPLATES) expect(specProblems(normalizeSpec(t.spec)), t.id).toEqual([]);
  });
});

describe("scoped default headers (Printful's X-PF-Store-Id)", () => {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => json(200, { code: 200, result: [] }));
  const secret = async () => TOKEN;
  const tool = (name: string) => PRINTFUL_TEMPLATE.spec.tools.find((t) => t.name === name)!;
  beforeEach(() => fetch.mockClear());

  it("goes only to the tools of the scope, from the setting; left out when the setting is empty", async () => {
    expect(requestTemplates(PRINTFUL_TEMPLATE.spec, tool("list_orders")).headers).toEqual({ "X-PF-Store-Id": "{{settings.store_id}}" });
    expect(requestTemplates(PRINTFUL_TEMPLATE.spec, tool("list_catalog_categories")).headers).toEqual({});
    await executeHttpTool(PRINTFUL_TEMPLATE.spec, tool("list_orders"), {}, { secret, fetch, resolve, settings: { store_id: "4242" } });
    await executeHttpTool(PRINTFUL_TEMPLATE.spec, tool("list_catalog_categories"), {}, { secret, fetch, resolve, settings: { store_id: "4242" } });
    await executeHttpTool(PRINTFUL_TEMPLATE.spec, tool("list_orders"), {}, { secret, fetch, resolve, settings: {} });
    const headers = fetch.mock.calls.map(([, init]) => init.headers as Record<string, string>);
    expect(headers[0]!["x-pf-store-id"]).toBe("4242");
    expect(headers[1]!["x-pf-store-id"]).toBeUndefined();
    expect(headers[2]!["x-pf-store-id"]).toBeUndefined();
    expect(PRINTFUL_TEMPLATE.spec.tools.filter((t) => t.scopes?.includes("store")).map((t) => t.name).sort())
      .toEqual(["create_mockup_task", "create_order", "estimate_order_costs", "get_mockup_result", "get_order", "get_shipping_rates", "list_orders"]);
  });

  it("a server-level query and a tool's own value win in order: server < scope < tool", () => {
    const spec = normalizeSpec({
      name: "x", baseUrl: "https://a.test", allowedDomains: ["a.test"], query: { lang: "en", v: "1" }, scopes: { s: { query: { v: "2" }, headers: { "X-S": "s" } } },
      tools: [{ name: "t", description: "d", kind: "http", scopes: ["s"], http: { method: "GET", url: "/", query: { lang: "it" } } }],
    });
    expect(requestTemplates(spec, spec.tools[0]!)).toEqual({ headers: { "X-S": "s" }, query: { lang: "it", v: "2" } });
  });
});

describe("output shaping", () => {
  it("find_variant: White / M of product 71 among 56 variants, with price and availability", () => {
    const fv = PRINTFUL_TEMPLATE.spec.tools.find((t) => t.name === "find_variant")!;
    const out = shapeResponse(printfulProduct(), fv.http!.response, { product_id: 71, color: "white", size: "M" }) as any;
    expect(out.total).toBe(2); // White and Heather White
    expect(out.items.map((v: any) => v.color)).toEqual(["White", "Heather White"]);
    expect(out.items[0]).toEqual({
      id: 4012, product_id: 71, name: "Unisex Staple T-Shirt (White / M)", size: "M", color: "White", color_code: "#000000", price: "10.25", in_stock: true,
      availability_status: [{ region: "US", status: "in_stock" }, { region: "EU", status: "in_stock" }],
    });
    const inStock = shapeResponse(printfulProduct(), fv.http!.response, { color: "Red", in_stock: true }) as any;
    expect(inStock.items.map((v: any) => v.size)).not.toContain("M");
    const paged = shapeResponse(printfulProduct(), fv.http!.response, { limit: 10, offset: 50 }) as any;
    expect(paged).toMatchObject({ total: 56, offset: 50, limit: 10 });
    expect(paged.items).toHaveLength(6);
    expect(paged.next_offset).toBeUndefined();
    expect((shapeResponse(printfulProduct(), fv.http!.response, { limit: 10 }) as any).next_offset).toBe(10);
  });

  it("get_product: a summary (colors, sizes, price range, count) instead of the variant dump", () => {
    const gp = PRINTFUL_TEMPLATE.spec.tools.find((t) => t.name === "get_product")!;
    const out = shapeResponse(printfulProduct(), gp.http!.response, { product_id: 71 }) as any;
    expect(out.variants).toBeUndefined();
    expect(out).toMatchObject({ id: 71, brand: "Bella + Canvas", variant_count: 56, min_price: 9.25, max_price: 12.25 });
    expect(out.colors).toContain("Heather White");
    expect(out.sizes).toEqual(["XS", "S", "M", "L", "XL", "2XL", "3XL"]);
  });

  it("a list too long for the model keeps whole items and says how many, instead of cutting the JSON", () => {
    const items = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item ${i}`, padding: "x".repeat(80) }));
    const text = fitText(items, 4000);
    expect(text.length).toBeLessThanOrEqual(4000);
    const parsed = JSON.parse(text); // still valid JSON
    expect(parsed.total).toBe(200);
    expect(parsed.items.length).toBe(parsed.shown);
    expect(parsed.items.at(-1).padding).toHaveLength(80); // the last kept item is whole
    expect(parsed.note).toMatch(/first \d+ of 200 items/);
    const obj = JSON.parse(fitText({ paging: { total: 200 }, result: items }, 4000));
    expect(obj).toMatchObject({ paging: { total: 200 }, result_total: 200 });
    expect(fitText({ a: 1 }, 4000)).toBe(JSON.stringify({ a: 1 }, null, 2));
  });
});

/** A fetch that answers every template's endpoints with recorded-shaped bodies. */
function vendorFetch(seen: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }>) {
  return vi.fn(async (url: string, init: RequestInit) => {
    seen.push({ url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const u = new URL(url);
    const p = u.pathname;
    // Printful
    if (u.host === "api.printful.com") {
      if (p === "/stores") return json(200, { code: 200, result: [{ id: 4242, name: "Lumea", type: "native" }] });
      if (p === "/categories") return json(200, { code: 200, result: { categories: [{ id: 24, parent_id: 6, title: "T-Shirts" }] } });
      if (p === "/products") return json(200, { code: 200, result: [{ id: 71, title: "Unisex Staple T-Shirt", type_name: "T-Shirt", brand: "Bella + Canvas", model: "3001", variant_count: 56 }, { id: 380, title: "Unisex Hoodie", variant_count: 30 }] });
      if (/^\/products\/\d+$/.test(p)) return json(200, printfulProduct());
      if (/^\/products\/variant\/\d+$/.test(p)) return json(200, { code: 200, result: { variant: printfulProduct().result.variants[12], product: { id: 71, title: "Unisex Staple T-Shirt" } } });
      if (p === "/shipping/rates") return json(200, { code: 200, result: [{ id: "STANDARD", name: "Flat Rate", rate: "4.49", currency: "EUR", minDeliveryDays: 3, maxDeliveryDays: 6 }] });
      if (p === "/orders/estimate-costs") return json(200, { code: 200, result: { costs: { subtotal: 10.25, shipping: 4.49, total: 14.74, currency: "EUR" } } });
      if (p.startsWith("/mockup-generator/create-task")) return json(200, { code: 200, result: { task_key: "gt-1", status: "pending" } });
      if (p === "/mockup-generator/task") return json(200, { code: 200, result: { task_key: "gt-1", status: "completed", mockups: [{ mockup_url: "https://files.cdn.printful.com/m.png" }] } });
      if (p === "/orders" && init.method === "POST") return json(200, { code: 200, result: { id: 123, status: "draft", costs: { total: "14.74" } } });
      if (/^\/orders\/.+/.test(p)) return json(200, { code: 200, result: { id: 123, status: "draft", recipient: { name: "Ann", country_code: "IT", address1: "secret street" }, items: [], costs: {}, shipments: [] } });
      if (p === "/orders") return json(200, { code: 200, result: [{ id: 123, status: "draft" }], paging: { total: 1, offset: 0, limit: 20 } });
    }
    // Gelato
    if (u.host === "product.gelatoapis.com") {
      if (p === "/v3/catalogs") return json(200, [{ catalogUid: "apparel", title: "Apparel" }, { catalogUid: "posters", title: "Posters" }]);
      if (/^\/v3\/catalogs\/[^/]+$/.test(p)) return json(200, { catalogUid: "apparel", title: "Apparel", productAttributes: [{ productAttributeUid: "GarmentColor", values: [{ productAttributeValueUid: "white" }] }] });
      if (p.endsWith("/products:search")) return json(200, { products: [{ productUid: "apparel_product_gca_t-shirt_gsc_crewneck_gcu_unisex_gqa_classic_gsi_m_gco_white_gpr_4-0", attributes: { GarmentColor: "white", GarmentSize: "M" } }], hits: {} });
      if (p.endsWith("/prices")) return json(200, [{ productUid: "x", country: u.searchParams.get("country"), quantity: 1, price: 11.5, currency: u.searchParams.get("currency") }]);
      if (p.startsWith("/v3/products/")) return json(200, { productUid: "x", attributes: {} });
    }
    if (u.host === "shipment.gelatoapis.com" && p === "/v1/shipment-methods") return json(200, { shipmentMethods: [{ shipmentMethodUid: "dhl_global_parcel", name: "DHL Global Parcel", type: "normal", hasTracking: true, supportedCountries: ["IT"] }] });
    if (u.host === "order.gelatoapis.com") {
      if (p === "/v4/orders:quote") return json(200, { orderReferenceId: "quote", quotes: [{ id: "q1", products: [], shipmentMethods: [{ name: "Standard", price: 4.2 }] }] });
      if (p === "/v4/orders:search") return json(200, { orders: [{ id: "o1", orderReferenceId: "A1", orderType: "draft", fulfillmentStatus: "draft", createdAt: "2026-11-25" }] });
      if (p === "/v4/orders" && init.method === "POST") return json(200, { id: "o1", orderReferenceId: "A1", orderType: "draft", fulfillmentStatus: "draft", financialStatus: "draft" });
      if (p.startsWith("/v4/orders/")) return json(200, { id: "o1", orderReferenceId: "A1", orderType: "draft", fulfillmentStatus: "draft", items: [] });
    }
    // Printify
    if (u.host === "api.printify.com") {
      if (p === "/v1/shops.json") return json(200, [{ id: 555, title: "Lumea", sales_channel: "custom_integration" }]);
      if (p === "/v1/catalog/blueprints.json") return json(200, [{ id: 6, title: "Unisex Heavy Cotton Tee", brand: "Gildan", model: "5000" }, { id: 77, title: "Unisex Heavy Blend Hooded Sweatshirt", brand: "Gildan", model: "18500" }]);
      if (/^\/v1\/catalog\/blueprints\/\d+\.json$/.test(p)) return json(200, { id: 6, title: "Unisex Heavy Cotton Tee", brand: "Gildan", model: "5000", images: [] });
      if (p.endsWith("/print_providers.json")) return json(200, [{ id: 99, title: "Printify Choice", location: { country: "US" } }]);
      if (p.endsWith("/variants.json")) return json(200, { id: 99, title: "Printify Choice", variants: [{ id: 12100, title: "White / M", options: { color: "White", size: "M" }, placeholders: [] }, { id: 12101, title: "Black / M", options: { color: "Black", size: "M" }, placeholders: [] }] });
      if (p.endsWith("/shipping.json") && p.includes("/catalog/")) return json(200, { handling_time: { value: 30, unit: "day" }, profiles: [] });
      if (p.endsWith("/orders/shipping.json")) return json(200, { standard: 450, express: 1200 });
      if (/\/products\.json$/.test(p)) return json(200, { current_page: 1, last_page: 3, total: 41, data: [{ id: "p1", title: "Tee", visible: true, blueprint_id: 6, print_provider_id: 99, images: ["big"] }] });
      if (/\/products\/[^/]+\.json$/.test(p)) return json(200, { id: "p1", title: "Tee", variants: [{ id: 1, price: 2000 }, { id: 2, price: 2400 }] });
      if (/\/orders\.json$/.test(p) && init.method === "POST") return json(200, { id: "ord-1" });
      if (/\/orders\.json$/.test(p)) return json(200, { current_page: 1, last_page: 1, total: 1, data: [{ id: "ord-1", status: "on-hold", address_to: { country: "IT", address1: "secret" } }] });
      if (/\/orders\/[^/]+\.json$/.test(p)) return json(200, { id: "ord-1", status: "on-hold", line_items: [] });
    }
    return json(404, { error: { message: `no mock for ${init.method} ${url}` } });
  });
}

/** A valid sample input for a tool: required properties from the schema. */
function sample(tool: McpServerTool): Record<string, unknown> {
  const props = (tool.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
  const out: Record<string, unknown> = {};
  for (const name of (tool.inputSchema.required ?? []) as string[]) {
    const t = props[name]?.type;
    out[name] = t === "integer" || t === "number" ? 71 : t === "array" ? [{ variant_id: 4012, quantity: 1, productUid: "x", files: [] }] : t === "object" ? { country_code: "IT", country: "IT", zip: "20121" } : "A1";
  }
  return out;
}

describe("every template's tools against its mocked API", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "polpo-mcp-tpl-")); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const secretsFor = (t: McpServerTemplate) => Object.fromEntries(Object.values(t.spec.secrets).map((r) => [`${r.owner}/${r.service}`, { [r.key]: TOKEN }]));
  const settingsFor: Record<string, Record<string, string>> = { printful: { store_id: "4242" }, gelato: {}, printify: { shop_id: "555" } };

  for (const t of MCP_SERVER_TEMPLATES) {
    it(`${t.id}: valid, read-only tools answer from the vendor's hosts with the credential; approval tools queue; saved tests are read-only`, async () => {
      expect(t.revision).toBeGreaterThanOrEqual(1);
      expect(t.maturity.testedWithLiveApi).toBe(false);
      expect(Object.keys(t.secrets).sort()).toEqual(Object.keys(t.spec.secrets).sort());
      for (const test of t.tests) {
        const tool = t.spec.tools.find((x) => x.name === test.tool);
        expect(tool?.annotations?.readOnlyHint, `${t.id}/${test.tool}`).toBe(true);
      }
      const seen: Array<{ url: string; method: string; headers: Record<string, string>; body?: any }> = [];
      const fetch = vendorFetch(seen);
      const { vault } = memoryVault(secretsFor(t));
      for (const tool of t.spec.tools) {
        const r = await runTool({ serverId: t.id, spec: t.spec, toolName: tool.name, input: sample(tool), source: "private", settings: settingsFor[t.id] }, { polpoDir: dir, vault, fetch, resolve, sleep: noSleep });
        if (tool.requiresApproval) {
          expect(r.pendingApproval, `${t.id}/${tool.name}`).toBeDefined();
          continue;
        }
        expect(r.ok, `${t.id}/${tool.name}: ${r.error}`).toBe(true);
      }
      expect(seen.length).toBe(t.spec.tools.filter((x) => !x.requiresApproval).length);
      for (const s of seen) {
        expect(t.spec.allowedDomains).toContain(new URL(s.url).host);
        const credential = s.headers.authorization ?? s.headers["x-api-key"];
        expect(credential).toContain(TOKEN);
      }
    });
  }

  it("Printful: the store header on store endpoints; get_order hides the street", async () => {
    const seen: any[] = [];
    const { vault } = memoryVault(secretsFor(PRINTFUL_TEMPLATE));
    const r = await runTool({ serverId: "printful", spec: PRINTFUL_TEMPLATE.spec, toolName: "get_order", input: { order_id: "123" }, source: "test", settings: { store_id: "4242" } },
      { polpoDir: dir, vault, fetch: vendorFetch(seen), resolve });
    expect(r.text).not.toMatch(/secret street/);
    expect(seen[0].headers["x-pf-store-id"]).toBe("4242");
  });

  it("Gelato: prices use the default currency and country settings; a draft order is always orderType draft", async () => {
    const seen: any[] = [];
    const { vault } = memoryVault(secretsFor(GELATO_TEMPLATE));
    const fetch = vendorFetch(seen);
    const deps = { polpoDir: dir, vault, fetch, resolve };
    await runTool({ serverId: "gelato", spec: GELATO_TEMPLATE.spec, toolName: "get_product_prices", input: { product_uid: "x" }, source: "test" }, deps);
    expect(new URL(seen[0].url).search).toBe("?country=IT&currency=EUR");
    await runTool({ serverId: "gelato", spec: GELATO_TEMPLATE.spec, toolName: "get_product_prices", input: { product_uid: "x", currency: "USD" }, source: "test", settings: { country: "US" } }, deps);
    expect(new URL(seen[1].url).search).toBe("?country=US&currency=USD");
    const input = { order_reference_id: "A1", orderType: "order", shipping_address: { firstName: "A", lastName: "B", addressLine1: "x", city: "y", postCode: "1", country: "IT", email: "a@b.c" }, items: [{ productUid: "x", quantity: 1 }] };
    const approved = await runTool({ serverId: "gelato", spec: GELATO_TEMPLATE.spec, toolName: "create_draft_order", input, source: "approval", approved: true }, deps);
    expect(approved.ok).toBe(true);
    expect(seen.at(-1).body).toMatchObject({ orderType: "draft", orderReferenceId: "A1", currency: "EUR" });
    expect(seen.at(-1).headers["x-api-key"]).toBe(TOKEN);
  });

  it("Printify: shop tools need shop_id (a clear error without it); User-Agent sent; variants filtered by color / size", async () => {
    const seen: any[] = [];
    const { vault } = memoryVault(secretsFor(PRINTIFY_TEMPLATE));
    const deps = { polpoDir: dir, vault, fetch: vendorFetch(seen), resolve };
    const noShop = await runTool({ serverId: "printify", spec: PRINTIFY_TEMPLATE.spec, toolName: "list_orders", input: {}, source: "test" }, deps);
    expect(noShop.ok).toBe(false);
    expect(noShop.error).toMatch(/settings\.shop_id.*server's settings/);
    expect(seen).toEqual([]);
    const products = await runTool({ serverId: "printify", spec: PRINTIFY_TEMPLATE.spec, toolName: "list_products", input: {}, source: "test", settings: { shop_id: "555" } }, deps);
    expect(JSON.parse(products.text)).toMatchObject({ current_page: 1, last_page: 3, total: 41, result: [{ id: "p1", title: "Tee" }] });
    expect(new URL(seen[0].url).pathname).toBe("/v1/shops/555/products.json");
    expect(seen[0].headers["user-agent"]).toBe("Polpo");
    const variants = await runTool({ serverId: "printify", spec: PRINTIFY_TEMPLATE.spec, toolName: "find_variant", input: { blueprint_id: 6, print_provider_id: 99, color: "white", size: "M" }, source: "test" }, deps);
    expect(JSON.parse(variants.text).items).toEqual([{ id: 12100, title: "White / M", options: { color: "White", size: "M" }, placeholders: [] }]);
  });
});

describe("install flow, write-only secrets, upgrade, catalog (service + REST)", () => {
  let dir: string;
  let manager: ConnectorManager;
  let service: McpServerService;
  let vaultState: ReturnType<typeof memoryVault>;
  const seen: any[] = [];
  let fetch: ReturnType<typeof vendorFetch>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "polpo-mcp-install-"));
    seen.length = 0;
    fetch = vendorFetch(seen);
    vaultState = memoryVault();
    manager = new ConnectorManager({ polpoDir: dir, vaultStore: vaultState.vault, log: () => undefined });
    service = new McpServerService({ polpoDir: dir, vault: () => vaultState.vault, connectors: () => manager, runtime: () => ({ fetch, resolve, sleep: noSleep }) });
  });
  afterEach(async () => { await manager.closeAll(); rmSync(dir, { recursive: true, force: true }); });

  const routes = () => mcpServerRoutes({ service: () => service, llm: () => async () => "{}", actor: () => "person:a@b.c", publicBase: () => "https://polpo.test" });
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await routes().request(path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) as any };
  };

  it("missing secret: nothing published; the secret saved later (write-only) → read-only tests run BEFORE the publish → 1.0.0 deployed, access.agents set", async () => {
    const first = await service.install("printful", { settings: { store_id: "4242" }, agents: ["designer"] }, "person:a@b.c");
    expect(first).toMatchObject({ id: "printful", status: "needs_secrets", missingSecrets: ["token"], settings: { store_id: "4242" } });
    expect(service.store.versions("printful")).toEqual([]);
    expect(seen).toEqual([]);

    // the secret: PUT …/secrets/token — written to the vault entry, never echoed
    const saved = await call("PUT", "/printful/secrets/token", { value: `  ${TOKEN}  ` });
    expect(saved.body.data).toEqual({ name: "token", set: true, vault: { owner: "polpo-infra", service: "printful", key: "token" } });
    expect(saved.text).not.toContain(TOKEN);
    expect(vaultState.entries.get("polpo-infra/printful").credentials).toEqual({ token: TOKEN });
    expect((await call("GET", "/printful")).text).not.toContain(TOKEN);
    expect((await call("PUT", "/printful/secrets/nope", { value: "x" })).status).toBe(404);

    // tests run before any version exists
    fetch.mockImplementation((async (url: string, init: RequestInit) => {
      seen.push({ url, method: init.method, versionsAtCall: service.store.versions("printful").length, headers: init.headers });
      return vendorFetch([])(url, init);
    }) as never);
    const done = await service.install("printful", {}, "person:a@b.c");
    expect(done).toMatchObject({ status: "installed", version: "1.0.0", connectorId: "printful", access: { agents: ["designer"], polpo: true } });
    expect(done.tests).toMatchObject({ passed: 4, failed: 0 });
    expect(seen.length).toBe(4); // the saved tests, once (publish does not run them again)
    expect(seen.every((s) => s.versionsAtCall === 0)).toBe(true);
    expect(seen.find((s) => new URL(s.url).pathname === "/shipping/rates").headers["x-pf-store-id"]).toBe("4242");
    expect(manager.store.get("printful")!.access).toEqual({ agents: ["designer"], polpo: true });
    expect(service.store.meta("printful")).toMatchObject({ template: "printful", templateRevision: PRINTFUL_TEMPLATE.revision, settings: { store_id: "4242" } });
    // the agent sees the tools through the connector
    const { tools } = await manager.toolsFor("designer");
    expect(tools.map((t) => t.name)).toContain("mcp__printful__find_variant");
  });

  it("secrets given with the install go straight to the vault; a failing read-only test publishes nothing; settings are validated", async () => {
    await expect(service.install("printful", { settings: { store_id: "abc" } }, "x")).rejects.toThrow(/store_id.*expected format/);
    fetch.mockImplementation((async () => json(401, { code: 401, error: { message: "Invalid token" } })) as never);
    const r = await call("POST", "/templates/printful/install", { secrets: { token: TOKEN }, agents: [] });
    expect(r.text).not.toContain(TOKEN);
    expect(r.body.data).toMatchObject({ status: "tests_failed", tests: { failed: 4 } });
    expect(r.body.data.tests.results[0].error).toMatch(/Printful refused the token/);
    expect(service.store.versions("printful")).toEqual([]);
    expect(manager.store.get("printful")).toBeUndefined();
    expect(vaultState.entries.get("polpo-infra/printful").credentials.token).toBe(TOKEN);
  });

  it("catalog statuses; an older installed revision → the new revision is a draft with the diff (not published); the same revision → up to date", async () => {
    let catalog = (await call("GET", "/templates")).body.data.templates;
    expect(catalog.map((t: any) => [t.id, t.status])).toEqual([["printful", "available"], ["gelato", "available"], ["printify", "available"]]);
    expect(catalog[0]).toMatchObject({ vendor: "Printful", category: "Print on demand", revision: 2, maturity: { testedWithLiveApi: false }, approvalTools: ["create_order"] });
    expect(catalog[0].readOnlyTools).toContain("find_variant");
    expect(catalog[0].secrets[0]).toMatchObject({ name: "token", label: "Private token", vault: { owner: "polpo-infra", service: "printful", key: "token" } });
    expect(catalog[0].settings[0]).toMatchObject({ key: "store_id", type: "string" });
    expect(JSON.stringify(catalog)).not.toContain(TOKEN);

    await vaultState.vault.set("polpo-infra", "printful", { type: "api_key", credentials: { token: TOKEN } });
    await service.install("printful", {}, "x");
    // simulate an install made from revision 1: an older spec (no find_variant) in production
    const old = { ...PRINTFUL_TEMPLATE.spec, tools: PRINTFUL_TEMPLATE.spec.tools.filter((t) => t.name !== "find_variant") };
    service.updateDraft("printful", old, "x");
    await service.publish("printful", { deploy: true }, "x");
    service.store.saveMeta({ ...service.store.meta("printful")!, templateRevision: 1 });
    catalog = (await call("GET", "/templates")).body.data.templates;
    expect(catalog[0]).toMatchObject({ status: "update_available", installs: [{ serverId: "printful", production: "2.0.0", revision: 1, status: "update_available" }] });

    const up = await call("POST", "/templates/printful/install", { agents: "*" });
    expect(up.body.data).toMatchObject({ status: "upgrade_draft", revision: 2, access: { agents: "*" } });
    expect(up.body.data.diff.changes).toEqual([{ field: "tools.find_variant", kind: "added" }]);
    expect(up.body.data.diff.unified).toMatch(/\+  find_variant:/);
    expect(service.store.production("printful")).toBe("2.0.0"); // not published by the upgrade
    expect(service.store.draft("printful")!.templateRevision).toBe(2);
    // the person publishes the draft: the installed revision follows
    await service.publish("printful", { deploy: true }, "x");
    expect(service.store.meta("printful")!.templateRevision).toBe(2);
    expect((await call("GET", "/templates/printful")).body.data.status).toBe("installed");
    expect((await call("POST", "/templates/printful/install", {})).body.data.status).toBe("up_to_date");
    expect((await call("GET", "/templates/nope")).status).toBe(404);
  });

  it("settings can change later without a new version (PATCH settings); an unknown key is refused", async () => {
    await vaultState.vault.set("polpo-infra", "printful", { type: "api_key", credentials: { token: TOKEN } });
    await service.install("printful", {}, "x");
    const patched = await call("PATCH", "/printful", { settings: { store_id: "999" } });
    expect(patched.body.data.settings).toEqual({ store_id: "999" });
    expect((await call("PATCH", "/printful", { settings: { nope: 1 } })).status).toBe(400);
    const got = (await call("GET", "/printful")).body.data;
    expect(got.effectiveSettings).toEqual({ store_id: "999" });
    expect(got.templateInfo).toMatchObject({ id: "printful", latestRevision: 2, installedRevision: 2 });
    expect(service.versions("printful")).toHaveLength(1);
    await service.test("printful", { tool: "list_orders", ref: "production" });
    expect(seen.at(-1).headers["x-pf-store-id"]).toBe("999");
    expect((await call("PATCH", "/printful", { settings: { store_id: null } })).body.data.settings).toEqual({});
  });
});

describe("MCP: polpo_mcp_server_templates / install (setup link for the secret) and Polpo's chat", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists the catalog; install asks for the secret with a setup link, then installs; changes need admin", async () => {
    const { handleMcpRequest } = await import("../server/mcp.js");
    const { expectValidOutput } = await import("./helpers/mcp-output.js");
    dir = mkdtempSync(join(tmpdir(), "polpo-mcp-tpl-tools-"));
    const { vault } = memoryVault();
    const fetch = vendorFetch([]);
    const manager = new ConnectorManager({ polpoDir: dir, vaultStore: vault, log: () => undefined });
    const service = new McpServerService({ polpoDir: dir, vault: () => vault, connectors: () => manager, runtime: () => ({ fetch, resolve, sleep: noSleep }) });
    const routes = mcpServerRoutes({ service: () => service, llm: () => async () => "{}", actor: () => "mcp:test", publicBase: () => "https://polpo.test" });
    const api = async (method: string, path: string, body?: unknown) => {
      const res = await routes.request(path.replace(/^\/api\/v1\/mcp-servers/, "") || "/", { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: await res.json(), headers: res.headers };
    };
    const deps = (scopes: string[] = ["polpo:admin"]) => ({ api, version: "x", toolsets: ["connectors", "settings"], principal: { kind: "oauth" as const, actor: "t", scopes }, dashboardUrl: "https://polpo.test" });
    const rpc = async (d: ReturnType<typeof deps>, method: string, params: Record<string, unknown> = {}) => (await (await handleMcpRequest(new Request("http://localhost/mcp", {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }), d as never)).json()).result;
    const callTool = async (name: string, args: Record<string, unknown> = {}, d = deps()) => {
      const result = await rpc(d, "tools/call", { name, arguments: args });
      await expectValidOutput(d as never, async () => (await rpc(d, "tools/list")).tools, name, result);
      return result;
    };
    const readOnly = (await rpc(deps(["polpo:read", "polpo:connectors"]), "tools/list")).tools.map((t: { name: string }) => t.name);
    expect(readOnly).toContain("polpo_mcp_server_templates");
    expect(readOnly).not.toContain("polpo_mcp_server_install");

    const list = await callTool("polpo_mcp_server_templates");
    expect(list.structuredContent.templates.map((t: any) => t.id)).toEqual(["printful", "gelato", "printify"]);
    expect(list.content[0].text).toMatch(/printful "Printful" \(Print on demand, revision 2\) — available · not yet tested with the live API/);
    expect((await callTool("polpo_mcp_server_templates", { id: "printful" })).content[0].text).toMatch(/find_variant \[read-only\]/);

    const first = await callTool("polpo_mcp_server_install", { template: "printful", settings: { store_id: "4242" }, agents: ["designer"] });
    expect(first.structuredContent).toMatchObject({ id: "printful", status: "needs_secrets", missing_secrets: ["token"], setup_ids: ["mcp-server:printful:token"] });
    expect(first.structuredContent.setup_url).toMatch(/\/connectors\?tab=servers&server=printful&focus=secret%3Atoken&setup=mcp-server%3Aprintful%3Atoken/);
    expect(first.content[0].text).toMatch(/developers\.printful\.com\/tokens/);
    // the person saves it in the dashboard (the vault): polpo_setup_wait sees it
    await service.saveSecret("printful", "token", TOKEN);
    const wait = await callTool("polpo_setup_wait", { setup_id: "mcp-server:printful:token", timeout_seconds: 0 });
    expect(wait.structuredContent.status).toBe("done");
    const second = await callTool("polpo_mcp_server_install", { template: "printful" });
    expect(second.structuredContent).toMatchObject({ status: "installed", version: "1.0.0", access: { agents: ["designer"], polpo: true }, tests: { passed: 4, failed: 0 } });
    expect(JSON.stringify(second)).not.toContain(TOKEN);
    const updated = await callTool("polpo_mcp_server_update", { id: "printful", settings: { store_id: "77" } });
    expect(updated.content[0].text).toMatch(/store_id=77/);
    expect((await callTool("polpo_mcp_server_get", { id: "printful" })).content[0].text).toMatch(/setting store_id \(Store id\): 77/);
    await manager.closeAll();
  }, 60_000);

  it("Polpo's chat gets them (hosted-servers group)", async () => {
    dir = mkdtempSync(join(tmpdir(), "polpo-mcp-tpl-x-"));
    const { bridgedTools } = await import("../llm/polpo-mcp-bridge.js");
    const names = bridgedTools().map((t) => t.name);
    expect(names).toContain("mcp_server_templates");
    expect(names).toContain("mcp_server_install");
  }, 60_000);
});

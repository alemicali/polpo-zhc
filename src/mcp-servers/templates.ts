/**
 * Ready-made hosted servers ("Create from template"). No secret is in here: a template names the
 * vault entry its credential is read from, and the person adds that entry.
 */
import type { McpServerSpec, McpServerTestCase } from "./types.js";

export interface McpServerTemplate {
  id: string;
  name: string;
  description: string;
  /** What the person must do before the first call (shown in the dashboard). */
  setup: string;
  docs?: string;
  spec: McpServerSpec;
  tests: Omit<McpServerTestCase, "id">[];
}

const storeHeader = { "X-PF-Store-Id": "{{input.store_id}}" };
const storeIdProp = { store_id: { type: "integer", description: "Printful store id: only needed with an account-level token that covers several stores" } };
const recipientSchema = {
  type: "object",
  description: "Where it ships",
  properties: {
    name: { type: "string" },
    address1: { type: "string" },
    address2: { type: "string" },
    city: { type: "string" },
    state_code: { type: "string", description: "Required for US, CA and AU" },
    country_code: { type: "string", description: "ISO 3166-1 alpha-2, e.g. IT, US" },
    zip: { type: "string" },
    email: { type: "string" },
    phone: { type: "string" },
  },
  required: ["country_code"],
};
const itemsSchema = {
  type: "array",
  description: "Catalog variants and quantities",
  items: {
    type: "object",
    properties: {
      variant_id: { type: "integer", description: "Catalog variant id (get_product lists them)" },
      quantity: { type: "integer", minimum: 1 },
    },
    required: ["variant_id", "quantity"],
  },
};
const printfulErrors = [
  { status: 401, message: "Printful refused the token: check the vault entry polpo-infra/printful (field token)" },
  { status: 404, message: "Printful has no such item" },
  { status: 429, message: "Printful's rate limit was hit: wait a minute and try again" },
];

/**
 * Printful (print on demand), from its public API docs (https://developers.printful.com/docs/).
 * Read-only tools are safe to try; create_order makes a DRAFT order (never confirmed: no `confirm`
 * parameter is ever sent) and still needs a person's approval for every call.
 */
export const PRINTFUL_TEMPLATE: McpServerTemplate = {
  id: "printful",
  name: "Printful",
  description: "Print-on-demand catalog, shipping rates, mockups and draft orders on Printful.",
  setup: "Add a Printful private token to the vault: owner polpo-infra, service printful, field token "
    + "(POST /api/v1/vault/entries { agent: \"polpo-infra\", service: \"printful\", type: \"api_key\", credentials: { token } }).",
  docs: "https://developers.printful.com/docs/",
  spec: {
    name: "Printful",
    description: "Printful's print-on-demand API: browse the catalog (products, variants, prices), quote shipping, generate product mockups, "
      + "and create draft orders (a person approves every order; drafts are never confirmed for fulfillment here).",
    icon: "printful",
    baseUrl: "https://api.printful.com",
    allowedDomains: ["api.printful.com"],
    secrets: { token: { owner: "polpo-infra", service: "printful", key: "token" } },
    auth: { type: "bearer", secret: "token" },
    limits: { timeoutMs: 30_000, maxResultChars: 30_000, retries: 2 },
    tools: [
      {
        name: "list_catalog_categories",
        title: "Catalog categories",
        description: "List Printful's catalog categories (id, parent, title), e.g. to find the category id of t-shirts or posters before list_catalog_products.",
        kind: "http",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        http: { method: "GET", url: "/categories", response: { pick: "result.categories", fields: ["id", "parent_id", "title"] }, errors: printfulErrors },
      },
      {
        name: "list_catalog_products",
        title: "Search the catalog",
        description: "List the products Printful can print (blank catalog items: id, title, type, brand, model, variant count). "
          + "Narrow it with category_id (from list_catalog_categories); then get_product for variants, sizes, colors and prices.",
        kind: "http",
        inputSchema: { type: "object", properties: { category_id: { type: "integer", description: "Only this category" } } },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        http: {
          method: "GET", url: "/products", query: { category_id: "{{input.category_id}}" },
          response: { pick: "result", fields: ["id", "title", "type_name", "brand", "model", "variant_count", "is_discontinued"] }, errors: printfulErrors,
        },
      },
      {
        name: "get_product",
        title: "Product and variants",
        description: "One catalog product with all its variants (variant id, size, color, price, in stock). Use the variant ids for shipping rates, mockups and orders.",
        kind: "http",
        inputSchema: { type: "object", properties: { product_id: { type: "integer", description: "Catalog product id" } }, required: ["product_id"] },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        http: {
          method: "GET", url: "/products/{{input.product_id}}",
          response: { pick: "result", fields: ["product.id", "product.title", "product.type_name", "product.brand", "product.description", "product.files", "variants"] },
          errors: printfulErrors,
        },
      },
      {
        name: "get_variant",
        title: "Variant",
        description: "One catalog variant (size, color, price, availability) and its product.",
        kind: "http",
        inputSchema: { type: "object", properties: { variant_id: { type: "integer" } }, required: ["variant_id"] },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        http: { method: "GET", url: "/products/variant/{{input.variant_id}}", response: { pick: "result" }, errors: printfulErrors },
      },
      {
        name: "get_shipping_rates",
        title: "Shipping rates",
        description: "Quote the shipping options and costs for catalog variants to an address (no order is created).",
        kind: "http",
        inputSchema: {
          type: "object",
          properties: {
            recipient: recipientSchema, items: itemsSchema,
            currency: { type: "string", description: "e.g. EUR, USD" }, locale: { type: "string", description: "e.g. en_US" }, ...storeIdProp,
          },
          required: ["recipient", "items"],
        },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        http: {
          method: "POST", url: "/shipping/rates", headers: storeHeader,
          body: { recipient: "{{input.recipient}}", items: "{{input.items}}", currency: "{{input.currency}}", locale: "{{input.locale}}" },
          response: { pick: "result" }, errors: printfulErrors, retries: 2,
        },
      },
      {
        name: "create_mockup_task",
        title: "Generate mockups",
        description: "Start generating mockup images of a catalog product with a design (an image URL) on the given variants. "
          + "Returns a task_key: call get_mockup_result with it after a few seconds. Printful limits this to a few calls per minute.",
        kind: "http",
        inputSchema: {
          type: "object",
          properties: {
            product_id: { type: "integer", description: "Catalog product id" },
            variant_ids: { type: "array", items: { type: "integer" } },
            files: {
              type: "array",
              description: "Designs: placement (e.g. front, back, default) and a public image URL",
              items: { type: "object", properties: { placement: { type: "string" }, image_url: { type: "string" } }, required: ["placement", "image_url"] },
            },
            format: { type: "string", enum: ["jpg", "png"] },
            ...storeIdProp,
          },
          required: ["product_id", "variant_ids", "files"],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        http: {
          method: "POST", url: "/mockup-generator/create-task/{{input.product_id}}", headers: storeHeader,
          body: { variant_ids: "{{input.variant_ids}}", files: "{{input.files}}", format: "{{input.format}}" },
          response: { pick: "result", fields: ["task_key", "status"] }, errors: printfulErrors,
        },
      },
      {
        name: "get_mockup_result",
        title: "Mockup result",
        description: "The result of a mockup task: status (pending, completed, failed) and, when completed, the mockup image URLs.",
        kind: "http",
        inputSchema: { type: "object", properties: { task_key: { type: "string" }, ...storeIdProp }, required: ["task_key"] },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        http: { method: "GET", url: "/mockup-generator/task", query: { task_key: "{{input.task_key}}" }, headers: storeHeader, response: { pick: "result" }, errors: printfulErrors },
      },
      {
        name: "create_order",
        title: "Create a draft order",
        description: "Create a DRAFT order on Printful (recipient, catalog variants, print files). Drafts are not fulfilled or charged until someone "
          + "confirms them in Printful; this tool never confirms. Every call needs a person's approval.",
        kind: "http",
        inputSchema: {
          type: "object",
          properties: {
            external_id: { type: "string", description: "Your own order reference" },
            recipient: { ...recipientSchema, required: ["name", "address1", "city", "country_code", "zip"] },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  variant_id: { type: "integer" }, quantity: { type: "integer", minimum: 1 },
                  files: { type: "array", items: { type: "object", properties: { type: { type: "string" }, url: { type: "string" } }, required: ["url"] } },
                },
                required: ["variant_id", "quantity"],
              },
            },
            ...storeIdProp,
          },
          required: ["recipient", "items"],
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        requiresApproval: true,
        http: {
          // no `confirm` parameter, ever: the order stays a draft
          method: "POST", url: "/orders", headers: storeHeader,
          body: { external_id: "{{input.external_id}}", recipient: "{{input.recipient}}", items: "{{input.items}}" },
          response: { pick: "result", fields: ["id", "external_id", "status", "costs", "created"] }, errors: printfulErrors, retries: 0,
        },
      },
      {
        name: "get_order",
        title: "Order status",
        description: "One order: status (draft, pending, inprocess, fulfilled, canceled…), items, costs and shipments with tracking.",
        kind: "http",
        inputSchema: { type: "object", properties: { order_id: { type: "string", description: "Printful order id, or @external_id" }, ...storeIdProp }, required: ["order_id"] },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        http: {
          method: "GET", url: "/orders/{{input.order_id}}", headers: storeHeader,
          response: { pick: "result", fields: ["id", "external_id", "status", "shipping", "created", "updated", "recipient.name", "recipient.country_code", "items", "costs", "shipments"] },
          errors: printfulErrors,
        },
      },
      {
        name: "list_orders",
        title: "List orders",
        description: "Orders, newest first (id, external id, status, created, total). Page with offset and limit (max 100); filter by status.",
        kind: "http",
        inputSchema: {
          type: "object",
          properties: {
            status: { type: "string", description: "draft, pending, failed, canceled, inprocess, onhold, partial, fulfilled" },
            offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 }, ...storeIdProp,
          },
        },
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
        http: {
          method: "GET", url: "/orders", headers: storeHeader,
          query: { status: "{{input.status}}", offset: "{{input.offset}}", limit: "{{input.limit ?? 20}}" },
          response: { fields: ["result", "paging"] },
          pagination: { style: "offset", param: "offset", sizeParam: "limit", totalPath: "paging.total" }, errors: printfulErrors,
        },
      },
    ],
  },
  tests: [
    { name: "Categories", tool: "list_catalog_categories", input: {} },
    { name: "T-shirt product", tool: "get_product", input: { product_id: 71 } },
    { name: "Shipping to Italy", tool: "get_shipping_rates", input: { recipient: { country_code: "IT", zip: "20121" }, items: [{ variant_id: 4012, quantity: 1 }], currency: "EUR" } },
  ],
};

export const MCP_SERVER_TEMPLATES: McpServerTemplate[] = [PRINTFUL_TEMPLATE];

export function serverTemplate(id: string): McpServerTemplate | undefined {
  return MCP_SERVER_TEMPLATES.find((t) => t.id === id);
}

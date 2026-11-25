/**
 * Printful (print on demand), from its public API docs (https://developers.printful.com/docs/).
 *
 * - `store_id` (setting): an account-level token covers several stores and Printful then needs the
 *   X-PF-Store-Id header on store endpoints (shipping rates, cost estimates, mockups, orders): the
 *   "store" scope adds it from the setting, so no tool repeats it.
 * - The catalog answers with everything (a product has hundreds of variants): get_product returns
 *   a summary (colors, sizes, price range, counts) and find_variant filters the variants by color
 *   and size, paged, instead of a dump that gets cut before the variant you need.
 * - Read-only tools are safe to try. create_mockup_task is free of charge (Printful does not bill
 *   mockups; it rate-limits them) and needs no approval by default. create_order makes a DRAFT
 *   order (no `confirm` is ever sent) and still needs a person's approval for every call.
 */
import type { McpServerTemplate } from "../types.js";

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
  description: "Catalog variants and quantities (variant ids from find_variant)",
  items: {
    type: "object",
    properties: {
      variant_id: { type: "integer", description: "Catalog variant id" },
      quantity: { type: "integer", minimum: 1 },
      files: { type: "array", description: "Print files: type (default, front, back…) and a public URL", items: { type: "object", properties: { type: { type: "string" }, url: { type: "string" } }, required: ["url"] } },
    },
    required: ["variant_id", "quantity"],
  },
};
const errors = [
  { status: 400 as const, match: "store", message: "Printful needs a store for this call: set store_id in the server's settings (list_stores shows them)" },
  { status: 401 as const, message: "Printful refused the token: check the vault entry polpo-infra/printful (field token)" },
  { status: 403 as const, message: "The token may not do this: give it the scope this call needs (orders, stores, catalog…)" },
  { status: 404 as const, message: "Printful has no such item" },
  { status: 429 as const, message: "Printful's rate limit was hit: wait a minute and try again" },
];
const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };
const variantFields = ["id", "product_id", "name", "size", "color", "color_code", "price", "in_stock", "availability_status"];

export const PRINTFUL_TEMPLATE: McpServerTemplate = {
  id: "printful",
  name: "Printful",
  vendor: "Printful",
  category: "Print on demand",
  icon: "printful",
  description: "Print-on-demand catalog (find the exact variant by color and size), shipping rates, cost estimates, free mockups and draft orders on Printful.",
  docs: "https://developers.printful.com/docs/",
  revision: 2,
  changelog: [
    { revision: 2, note: "store_id setting with the X-PF-Store-Id header on store endpoints; find_variant (color / size); get_product returns a summary; products filter + paging; list_stores; estimate_order_costs." },
    { revision: 1, note: "First version: catalog, shipping rates, mockups, draft orders." },
  ],
  maturity: { testedWithLiveApi: false, note: "Revision 1 ran against the live API (catalog, shipping, mockups); revision 2 is tested against recorded-shaped responses only." },
  setup: "A Printful private token in the vault (polpo-infra / printful, field token); with an account-level token, also the store id.",
  secrets: {
    token: {
      label: "Private token",
      howTo: "In Printful open Developers → Your tokens (developers.printful.com/tokens), create a private token for your account or one store, and paste it here.",
      url: "https://developers.printful.com/tokens",
      scopes: ["View store products", "View orders", "Manage orders (for draft orders)", "View store files"],
      recommendation: "Give it only the scopes you need; drafts are never confirmed by Polpo and every order needs a person's approval.",
    },
  },
  spec: {
    name: "Printful",
    description: "Printful's print-on-demand API: browse the catalog (find_variant picks the exact color and size), quote shipping and order costs, generate product mockups, "
      + "and create DRAFT orders (a person approves every order; drafts are never confirmed for fulfillment here).",
    icon: "printful",
    baseUrl: "https://api.printful.com",
    allowedDomains: ["api.printful.com"],
    secrets: { token: { owner: "polpo-infra", service: "printful", key: "token" } },
    auth: { type: "bearer", secret: "token" },
    settingsSchema: [
      {
        key: "store_id", label: "Store id", type: "string", pattern: "\\d{1,12}",
        help: "Needed with an account-level token (it covers several stores): the store whose shipping, mockups and orders are used. list_stores shows the ids; leave it empty with a store token.",
      },
    ],
    scopes: { store: { description: "Store endpoints: shipping, costs, mockups, orders", headers: { "X-PF-Store-Id": "{{settings.store_id}}" } } },
    limits: { timeoutMs: 30_000, maxResultChars: 30_000, retries: 2 },
    tools: [
      {
        name: "list_stores",
        title: "Stores",
        description: "The Printful stores this token reaches (id, name, type). With an account-level token, put the store id in the server's settings (store_id).",
        kind: "http",
        inputSchema: { type: "object", properties: {} },
        annotations: READ,
        http: { method: "GET", url: "/stores", response: { pick: "result", fields: ["id", "name", "type"] }, errors },
      },
      {
        name: "list_catalog_categories",
        title: "Catalog categories",
        description: "Printful's catalog categories (id, parent, title), e.g. to find the category of t-shirts or posters for list_catalog_products.",
        kind: "http",
        inputSchema: { type: "object", properties: {} },
        annotations: READ,
        http: { method: "GET", url: "/categories", response: { pick: "result.categories", fields: ["id", "parent_id", "title"] }, errors },
      },
      {
        name: "list_catalog_products",
        title: "Search the catalog",
        description: "Products Printful can print (blank catalog items: id, title, type, brand, model, variant count), paged. Narrow with category_id "
          + "(list_catalog_categories) and search (words in the title); then get_product for its colors, sizes and prices, and find_variant for the variant ids.",
        kind: "http",
        inputSchema: {
          type: "object",
          properties: {
            category_id: { type: "integer", description: "Only this category" },
            search: { type: "string", description: "Words in the title, e.g. \"hoodie\", \"Bella\"" },
            offset: { type: "integer", minimum: 0, description: "Skip this many (paging)" },
            limit: { type: "integer", minimum: 1, maximum: 100, description: "How many (default 25)" },
          },
        },
        annotations: READ,
        http: {
          method: "GET", url: "/products", query: { category_id: "{{input.category_id}}" },
          response: {
            pick: "result", filters: [{ path: "title", input: "search", match: "contains" }], page: { defaultLimit: 25, maxLimit: 100 },
            fields: ["id", "title", "type_name", "brand", "model", "variant_count", "is_discontinued"],
          },
          errors,
        },
      },
      {
        name: "get_product",
        title: "Product summary",
        description: "One catalog product: title, brand, model, description, print placements, and a summary of its variants (how many, which colors and sizes, price range) "
          + "— not every variant: use find_variant with a color and / or size for the variant ids.",
        kind: "http",
        inputSchema: { type: "object", properties: { product_id: { type: "integer", description: "Catalog product id" } }, required: ["product_id"] },
        annotations: READ,
        http: {
          method: "GET", url: "/products/{{input.product_id}}",
          response: {
            pick: "result.product", fields: ["id", "title", "type_name", "brand", "model", "description", "techniques", "files", "is_discontinued"],
            aggregates: {
              variant_count: { path: "result.variants", op: "count" },
              colors: { path: "result.variants[*].color", op: "unique" },
              sizes: { path: "result.variants[*].size", op: "unique" },
              min_price: { path: "result.variants[*].price", op: "min" },
              max_price: { path: "result.variants[*].price", op: "max" },
            },
          },
          errors,
        },
      },
      {
        name: "find_variant",
        title: "Find a variant",
        description: "The variants of a catalog product matching a color and / or a size (e.g. product 71, color \"White\", size \"M\"): variant id, name, price, "
          + "in stock and availability by region. Color matches part of the name (\"white\" also finds \"Heather White\"), size matches exactly. Use the id for shipping, mockups and orders.",
        kind: "http",
        inputSchema: {
          type: "object",
          properties: {
            product_id: { type: "integer", description: "Catalog product id" },
            color: { type: "string", description: "e.g. White, Black, Navy" },
            size: { type: "string", description: "e.g. S, M, XL, 18×24" },
            in_stock: { type: "boolean", description: "true: only variants in stock" },
            offset: { type: "integer", minimum: 0 },
            limit: { type: "integer", minimum: 1, maximum: 100, description: "How many (default 50)" },
          },
          required: ["product_id"],
        },
        annotations: READ,
        http: {
          method: "GET", url: "/products/{{input.product_id}}",
          response: {
            pick: "result.variants",
            filters: [{ path: "color", input: "color", match: "contains" }, { path: "size", input: "size", match: "equals" }, { path: "in_stock", input: "in_stock" }],
            page: { defaultLimit: 50, maxLimit: 100 }, fields: variantFields,
          },
          errors,
        },
      },
      {
        name: "get_variant",
        title: "Variant",
        description: "One catalog variant (size, color, price, in stock, availability) and its product's title.",
        kind: "http",
        inputSchema: { type: "object", properties: { variant_id: { type: "integer" } }, required: ["variant_id"] },
        annotations: READ,
        http: {
          method: "GET", url: "/products/variant/{{input.variant_id}}",
          response: { pick: "result", fields: [...variantFields.map((f) => `variant.${f}`), "product.id", "product.title", "product.brand", "product.model"] }, errors,
        },
      },
      {
        name: "get_shipping_rates",
        title: "Shipping rates",
        description: "Quote the shipping options and costs for catalog variants to an address (no order is created).",
        kind: "http",
        scopes: ["store"],
        inputSchema: {
          type: "object",
          properties: { recipient: recipientSchema, items: itemsSchema, currency: { type: "string", description: "e.g. EUR, USD" }, locale: { type: "string", description: "e.g. en_US" } },
          required: ["recipient", "items"],
        },
        annotations: READ,
        http: {
          method: "POST", url: "/shipping/rates",
          body: { recipient: "{{input.recipient}}", items: "{{input.items}}", currency: "{{input.currency}}", locale: "{{input.locale}}" },
          response: { pick: "result", fields: ["id", "name", "rate", "currency", "minDeliveryDays", "maxDeliveryDays"] }, errors, retries: 2,
        },
      },
      {
        name: "estimate_order_costs",
        title: "Estimate order costs",
        description: "What an order would cost (items, printing, shipping, taxes, total) for a recipient and catalog variants — nothing is created or charged.",
        kind: "http",
        scopes: ["store"],
        inputSchema: { type: "object", properties: { recipient: recipientSchema, items: itemsSchema }, required: ["recipient", "items"] },
        annotations: READ,
        http: {
          method: "POST", url: "/orders/estimate-costs", body: { recipient: "{{input.recipient}}", items: "{{input.items}}" },
          response: { pick: "result" }, errors, retries: 2,
        },
      },
      {
        name: "create_mockup_task",
        title: "Generate mockups",
        description: "Start generating mockup images of a catalog product with a design (a public image URL) on the given variants. Free of charge on Printful (rate-limited "
          + "to a few calls a minute). Returns a task_key: call get_mockup_result with it after a few seconds.",
        kind: "http",
        scopes: ["store"],
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
          },
          required: ["product_id", "variant_ids", "files"],
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
        http: {
          method: "POST", url: "/mockup-generator/create-task/{{input.product_id}}",
          body: { variant_ids: "{{input.variant_ids}}", files: "{{input.files}}", format: "{{input.format}}" },
          response: { pick: "result", fields: ["task_key", "status"] }, errors,
        },
      },
      {
        name: "get_mockup_result",
        title: "Mockup result",
        description: "The result of a mockup task: status (pending, completed, failed) and, when completed, the mockup image URLs.",
        kind: "http",
        scopes: ["store"],
        inputSchema: { type: "object", properties: { task_key: { type: "string" } }, required: ["task_key"] },
        annotations: READ,
        http: {
          method: "GET", url: "/mockup-generator/task", query: { task_key: "{{input.task_key}}" },
          response: { pick: "result", fields: ["task_key", "status", "error", "mockups"] }, errors,
        },
      },
      {
        name: "create_order",
        title: "Create a draft order",
        description: "Create a DRAFT order on Printful (recipient, catalog variants, print files). Drafts are not fulfilled or charged until someone "
          + "confirms them in Printful; this tool never confirms. Every call needs a person's approval.",
        kind: "http",
        scopes: ["store"],
        inputSchema: {
          type: "object",
          properties: {
            external_id: { type: "string", description: "Your own order reference" },
            recipient: { ...recipientSchema, required: ["name", "address1", "city", "country_code", "zip"] },
            items: itemsSchema,
          },
          required: ["recipient", "items"],
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        requiresApproval: true,
        http: {
          // no `confirm` parameter, ever: the order stays a draft
          method: "POST", url: "/orders",
          body: { external_id: "{{input.external_id}}", recipient: "{{input.recipient}}", items: "{{input.items}}" },
          response: { pick: "result", fields: ["id", "external_id", "status", "costs", "created"] }, errors, retries: 0,
        },
      },
      {
        name: "get_order",
        title: "Order status",
        description: "One order: status (draft, pending, inprocess, fulfilled, canceled…), items, costs and shipments with tracking.",
        kind: "http",
        scopes: ["store"],
        inputSchema: { type: "object", properties: { order_id: { type: "string", description: "Printful order id, or @external_id" } }, required: ["order_id"] },
        annotations: READ,
        http: {
          method: "GET", url: "/orders/{{input.order_id}}",
          response: { pick: "result", fields: ["id", "external_id", "status", "shipping", "created", "updated", "recipient.name", "recipient.country_code", "items", "costs", "shipments"] },
          errors,
        },
      },
      {
        name: "list_orders",
        title: "List orders",
        description: "Orders, newest first (id, external id, status, created, total). Page with offset and limit (max 100); filter by status.",
        kind: "http",
        scopes: ["store"],
        inputSchema: {
          type: "object",
          properties: {
            status: { type: "string", description: "draft, pending, failed, canceled, inprocess, onhold, partial, fulfilled" },
            offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
        annotations: READ,
        http: {
          method: "GET", url: "/orders",
          query: { status: "{{input.status}}", offset: "{{input.offset}}", limit: "{{input.limit ?? 20}}" },
          response: { fields: ["result", "paging"] },
          pagination: { style: "offset", param: "offset", sizeParam: "limit", totalPath: "paging.total" }, errors,
        },
      },
    ],
  },
  tests: [
    { id: "categories", name: "Categories", tool: "list_catalog_categories", input: {} },
    { id: "tshirt-summary", name: "T-shirt summary", tool: "get_product", input: { product_id: 71 }, contains: "colors" },
    { id: "white-m", name: "White / M of the t-shirt", tool: "find_variant", input: { product_id: 71, color: "White", size: "M" } },
    { id: "shipping-it", name: "Shipping to Italy", tool: "get_shipping_rates", input: { recipient: { country_code: "IT", zip: "20121" }, items: [{ variant_id: 4012, quantity: 1 }], currency: "EUR" } },
  ],
};

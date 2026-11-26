/**
 * Printify (print on demand through a network of print providers), from its public API docs
 * (https://developers.printify.com/). Base https://api.printify.com/v1, a personal access token as
 * bearer, and a User-Agent header (Printify requires one).
 *
 * Shop endpoints need the shop id: it is a setting (`shop_id`, list_shops shows it) used in their
 * URLs. Read-only first: catalog (blueprints, print providers, variants filtered by color / size,
 * shipping), shop products, shipping costs, orders. create_order needs a person's approval; Printify
 * keeps API orders on hold until they are sent to production, and this server never sends them.
 */
import type { McpServerTemplate } from "../types.js";

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };
const errors = [
  { status: 401 as const, message: "Printify refused the token: check the vault entry polpo-infra/printify (field token)" },
  { status: 403 as const, message: "The token may not do this: give it the scope this call needs (shops.read, catalog.read, products.read, orders.read / orders.write)" },
  { status: 404 as const, message: "Printify has no such item (is shop_id in the server's settings right?)" },
  { status: 429 as const, message: "Printify's rate limit was hit: wait a minute and try again" },
];
const addressSchema = {
  type: "object",
  description: "Where it ships",
  properties: {
    first_name: { type: "string" }, last_name: { type: "string" }, email: { type: "string" }, phone: { type: "string" },
    country: { type: "string", description: "ISO 3166-1 alpha-2, e.g. IT" }, region: { type: "string" },
    address1: { type: "string" }, address2: { type: "string" }, city: { type: "string" }, zip: { type: "string" },
  },
  required: ["country"],
};
const lineItemsSchema = {
  type: "array",
  description: "Either a shop product (product_id + variant_id) or a catalog item (blueprint_id + print_provider_id + variant_id + print_areas), with a quantity",
  items: {
    type: "object",
    properties: {
      product_id: { type: "string" }, variant_id: { type: "integer" }, quantity: { type: "integer", minimum: 1 },
      blueprint_id: { type: "integer" }, print_provider_id: { type: "integer" }, print_areas: { type: "object", description: "e.g. { \"front\": \"https://…/design.png\" }" },
      sku: { type: "string" },
    },
    required: ["quantity"],
  },
};
const paging = { current_page: { path: "current_page", op: "value" as const }, last_page: { path: "last_page", op: "value" as const }, total: { path: "total", op: "value" as const } };

export const PRINTIFY_TEMPLATE: McpServerTemplate = {
  id: "printify",
  name: "Printify",
  vendor: "Printify",
  category: "Print on demand",
  icon: "printify",
  description: "Printify's catalog (blueprints, print providers, variants by color and size, shipping), your shop's products, shipping costs, orders, and orders on hold that a person approves.",
  docs: "https://developers.printify.com/",
  revision: 1,
  changelog: [{ revision: 1, note: "First version: shops, catalog, variants filter, shipping, shop products, orders (create needs approval, never sent to production)." }],
  maturity: { testedWithLiveApi: false, note: "Built from Printify's public API docs and tested against recorded-shaped responses; nobody has run it against the live API yet." },
  setup: "A Printify personal access token in the vault (polpo-infra / printify, field token) and your shop id in the settings.",
  secrets: {
    token: {
      label: "Personal access token",
      howTo: "In Printify open My account → Connections (printify.com/app/account/api), generate a personal access token with the scopes below and paste it here. It is shown once.",
      url: "https://printify.com/app/account/api",
      scopes: ["shops.read", "catalog.read", "products.read", "orders.read", "orders.write (only for create_order)"],
      recommendation: "Leave out orders.write if agents should only read; create_order then fails and nothing else changes.",
    },
  },
  spec: {
    name: "Printify",
    description: "Printify's print-on-demand API: catalog blueprints and print providers, variants by color and size, shipping, your shop's products, shipping costs and orders. "
      + "Creating an order needs a person's approval; orders stay on hold (never sent to production here).",
    icon: "printify",
    baseUrl: "https://api.printify.com/v1",
    allowedDomains: ["api.printify.com"],
    secrets: { token: { owner: "polpo-infra", service: "printify", key: "token" } },
    auth: { type: "bearer", secret: "token" },
    headers: { "User-Agent": "Polpo" },
    settingsSchema: [
      { key: "shop_id", label: "Shop id", type: "string", pattern: "\\d{1,12}", help: "The shop whose products and orders are used (list_shops shows the ids). Needed by the shop tools." },
    ],
    limits: { timeoutMs: 30_000, maxResultChars: 30_000, retries: 2 },
    tools: [
      {
        name: "list_shops",
        title: "Shops",
        description: "The shops of this Printify account (id, title, sales channel). Put the id in the server's settings (shop_id).",
        kind: "http",
        inputSchema: { type: "object", properties: {} },
        annotations: READ,
        http: { method: "GET", url: "/shops.json", response: { fields: ["id", "title", "sales_channel"] }, errors },
      },
      {
        name: "list_blueprints",
        title: "Search the catalog",
        description: "Catalog blueprints (blank products: id, title, brand, model), filtered by words in the title or the brand, paged. Then list_print_providers.",
        kind: "http",
        inputSchema: {
          type: "object",
          properties: {
            search: { type: "string", description: "Words in the title, e.g. \"hoodie\"" }, brand: { type: "string", description: "e.g. Gildan, Bella+Canvas" },
            offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 25" },
          },
        },
        annotations: READ,
        http: {
          method: "GET", url: "/catalog/blueprints.json",
          response: { filters: [{ path: "title", input: "search", match: "contains" }, { path: "brand", input: "brand", match: "contains" }], page: { defaultLimit: 25, maxLimit: 100 }, fields: ["id", "title", "brand", "model"] },
          errors,
        },
      },
      {
        name: "get_blueprint",
        title: "Blueprint",
        description: "One blueprint: title, description, brand, model, images.",
        kind: "http",
        inputSchema: { type: "object", properties: { blueprint_id: { type: "integer" } }, required: ["blueprint_id"] },
        annotations: READ,
        http: { method: "GET", url: "/catalog/blueprints/{{input.blueprint_id}}.json", response: { fields: ["id", "title", "description", "brand", "model", "images"] }, errors },
      },
      {
        name: "list_print_providers",
        title: "Print providers",
        description: "The print providers that make a blueprint (id, title, location).",
        kind: "http",
        inputSchema: { type: "object", properties: { blueprint_id: { type: "integer" } }, required: ["blueprint_id"] },
        annotations: READ,
        http: { method: "GET", url: "/catalog/blueprints/{{input.blueprint_id}}/print_providers.json", response: { fields: ["id", "title", "location"] }, errors },
      },
      {
        name: "find_variant",
        title: "Find a variant",
        description: "The variants of a blueprint at a print provider matching a color and / or a size (variant id, title, options, placeholders), paged. "
          + "Color matches part of the name, size exactly.",
        kind: "http",
        inputSchema: {
          type: "object",
          properties: {
            blueprint_id: { type: "integer" }, print_provider_id: { type: "integer" },
            color: { type: "string" }, size: { type: "string" },
            offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 50" },
          },
          required: ["blueprint_id", "print_provider_id"],
        },
        annotations: READ,
        http: {
          method: "GET", url: "/catalog/blueprints/{{input.blueprint_id}}/print_providers/{{input.print_provider_id}}/variants.json",
          response: {
            pick: "variants", filters: [{ path: "options.color", input: "color", match: "contains" }, { path: "options.size", input: "size", match: "equals" }],
            page: { defaultLimit: 50, maxLimit: 100 }, fields: ["id", "title", "options", "placeholders"],
          },
          errors,
        },
      },
      {
        name: "get_shipping_info",
        title: "Shipping (catalog)",
        description: "Shipping profiles of a blueprint at a print provider: handling time and first / additional item costs by country.",
        kind: "http",
        inputSchema: { type: "object", properties: { blueprint_id: { type: "integer" }, print_provider_id: { type: "integer" } }, required: ["blueprint_id", "print_provider_id"] },
        annotations: READ,
        http: { method: "GET", url: "/catalog/blueprints/{{input.blueprint_id}}/print_providers/{{input.print_provider_id}}/shipping.json", errors },
      },
      {
        name: "list_products",
        title: "Shop products",
        description: "The products of your shop (shop_id setting): id, title, visibility, blueprint and print provider, paged by Printify (page, limit up to 50).",
        kind: "http",
        inputSchema: { type: "object", properties: { page: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 50 } } },
        annotations: READ,
        http: {
          method: "GET", url: "/shops/{{settings.shop_id}}/products.json", query: { page: "{{input.page}}", limit: "{{input.limit ?? 20}}" },
          response: { pick: "data", fields: ["id", "title", "visible", "is_locked", "blueprint_id", "print_provider_id", "created_at"], aggregates: paging },
          pagination: { style: "page", param: "page", sizeParam: "limit", totalPath: "total" }, errors,
        },
      },
      {
        name: "get_product",
        title: "Shop product",
        description: "One product of your shop: title, description, tags, blueprint, print provider, and a summary of its variants (count, enabled, price range in cents).",
        kind: "http",
        inputSchema: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] },
        annotations: READ,
        http: {
          method: "GET", url: "/shops/{{settings.shop_id}}/products/{{input.product_id}}.json",
          response: {
            fields: ["id", "title", "description", "tags", "blueprint_id", "print_provider_id", "visible", "options"],
            aggregates: {
              variant_count: { path: "variants", op: "count" },
              min_price_cents: { path: "variants[*].price", op: "min" }, max_price_cents: { path: "variants[*].price", op: "max" },
            },
          },
          errors,
        },
      },
      {
        name: "calculate_shipping",
        title: "Shipping cost",
        description: "Shipping costs (standard, express…) for line items to an address — nothing is created.",
        kind: "http",
        inputSchema: { type: "object", properties: { line_items: lineItemsSchema, address_to: addressSchema }, required: ["line_items", "address_to"] },
        annotations: READ,
        http: { method: "POST", url: "/shops/{{settings.shop_id}}/orders/shipping.json", body: { line_items: "{{input.line_items}}", address_to: "{{input.address_to}}" }, errors, retries: 2 },
      },
      {
        name: "list_orders",
        title: "Orders",
        description: "Your shop's orders (id, status, created, totals in cents, country), newest first, paged by Printify; filter by status (e.g. on-hold, in-production, fulfilled).",
        kind: "http",
        inputSchema: { type: "object", properties: { status: { type: "string" }, page: { type: "integer", minimum: 1 }, limit: { type: "integer", minimum: 1, maximum: 50 } } },
        annotations: READ,
        http: {
          method: "GET", url: "/shops/{{settings.shop_id}}/orders.json", query: { status: "{{input.status}}", page: "{{input.page}}", limit: "{{input.limit ?? 20}}" },
          response: { pick: "data", fields: ["id", "label", "status", "created_at", "total_price", "total_shipping", "address_to.country"], aggregates: paging },
          pagination: { style: "page", param: "page", sizeParam: "limit", totalPath: "total" }, errors,
        },
      },
      {
        name: "get_order",
        title: "Order",
        description: "One order: status, line items with their status, costs in cents, shipments and tracking.",
        kind: "http",
        inputSchema: { type: "object", properties: { order_id: { type: "string" } }, required: ["order_id"] },
        annotations: READ,
        http: {
          method: "GET", url: "/shops/{{settings.shop_id}}/orders/{{input.order_id}}.json",
          response: { fields: ["id", "label", "status", "created_at", "line_items", "total_price", "total_shipping", "total_tax", "shipments", "address_to.country"] }, errors,
        },
      },
      {
        name: "create_order",
        title: "Create an order (on hold)",
        description: "Create an order in your shop. Printify keeps orders made through the API on hold until they are sent to production; this server never sends them. "
          + "Every call needs a person's approval.",
        kind: "http",
        inputSchema: {
          type: "object",
          properties: {
            external_id: { type: "string", description: "Your order reference" }, label: { type: "string" },
            line_items: lineItemsSchema, shipping_method: { type: "integer", description: "1 standard, 2 priority, 3 express, 4 economy" }, address_to: addressSchema,
          },
          required: ["external_id", "line_items", "address_to"],
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        requiresApproval: true,
        http: {
          method: "POST", url: "/shops/{{settings.shop_id}}/orders.json",
          body: {
            external_id: "{{input.external_id}}", label: "{{input.label}}", line_items: "{{input.line_items}}", shipping_method: "{{input.shipping_method ?? 1}}",
            send_shipping_notification: false, address_to: "{{input.address_to}}",
          },
          response: { fields: ["id"] }, errors, retries: 0,
        },
      },
    ],
  },
  tests: [
    { id: "shops", name: "Shops", tool: "list_shops", input: {} },
    { id: "hoodies", name: "Hoodies in the catalog", tool: "list_blueprints", input: { search: "hoodie", limit: 5 } },
  ],
};

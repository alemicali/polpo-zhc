/**
 * Gelato (print on demand, local production in 30+ countries), from its public API docs
 * (https://dashboard.gelato.com/docs/). Three hosts: product (catalog, prices), order (quote, orders)
 * and shipment (shipping methods); the API key goes in the X-API-KEY header.
 *
 * Read-only first: catalogs, product search and prices, shipping methods, order quotes and order
 * status. create_draft_order always sends orderType "draft" (Gelato does not produce or charge a
 * draft until it is turned into an order in the dashboard) and needs a person's approval.
 * The default currency and country are settings, used when a call does not say.
 */
import type { McpServerTemplate } from "../types.js";

const PRODUCT = "https://product.gelatoapis.com/v3";
const ORDER = "https://order.gelatoapis.com/v4";
const SHIPMENT = "https://shipment.gelatoapis.com/v1";
const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };
const errors = [
  { status: 401 as const, message: "Gelato refused the API key: check the vault entry polpo-infra/gelato (field api_key)" },
  { status: 403 as const, message: "Gelato refused the API key: check the vault entry polpo-infra/gelato (field api_key)" },
  { status: 404 as const, message: "Gelato has no such item" },
  { status: 429 as const, message: "Gelato's rate limit was hit: wait a moment and try again" },
];
const addressSchema = {
  type: "object",
  description: "Shipping address",
  properties: {
    firstName: { type: "string" }, lastName: { type: "string" }, companyName: { type: "string" },
    addressLine1: { type: "string" }, addressLine2: { type: "string" }, city: { type: "string" }, postCode: { type: "string" },
    state: { type: "string", description: "Required for US, CA, AU" }, country: { type: "string", description: "ISO 3166-1 alpha-2, e.g. IT" },
    email: { type: "string" }, phone: { type: "string" },
  },
  required: ["country"],
};
const productsSchema = {
  type: "array",
  description: "Products: productUid (from search_products), quantity, and the print files",
  items: {
    type: "object",
    properties: {
      itemReferenceId: { type: "string", description: "Your reference for the line" },
      productUid: { type: "string" },
      quantity: { type: "integer", minimum: 1 },
      files: { type: "array", items: { type: "object", properties: { type: { type: "string", description: "default, back…" }, url: { type: "string" } }, required: ["url"] } },
    },
    required: ["productUid", "quantity"],
  },
};

export const GELATO_TEMPLATE: McpServerTemplate = {
  id: "gelato",
  name: "Gelato",
  vendor: "Gelato",
  category: "Print on demand",
  icon: "🖨️",
  description: "Gelato's print-on-demand catalog, prices, shipping methods and quotes, order status, and draft orders that a person approves.",
  docs: "https://dashboard.gelato.com/docs/",
  revision: 1,
  changelog: [{ revision: 1, note: "First version: catalogs, product search and prices, shipping methods, quotes, order status, draft orders (approval)." }],
  maturity: { testedWithLiveApi: false, note: "Built from Gelato's public API docs and tested against recorded-shaped responses; nobody has run it against the live API yet." },
  setup: "A Gelato API key in the vault (polpo-infra / gelato, field api_key).",
  secrets: {
    api_key: {
      label: "API key",
      howTo: "In the Gelato dashboard open Developer → API keys (dashboard.gelato.com/keys/manage), create a key and paste it here.",
      url: "https://dashboard.gelato.com/keys/manage",
      recommendation: "Gelato keys are not scoped: Polpo only reads, except draft orders, which need a person's approval and are never turned into real orders here.",
    },
  },
  spec: {
    name: "Gelato",
    description: "Gelato's print-on-demand API: catalogs and products (search by attributes), prices, shipping methods, order quotes and status, and DRAFT orders "
      + "(a person approves each; drafts are never produced or charged until someone converts them in Gelato).",
    icon: "🖨️",
    allowedDomains: ["product.gelatoapis.com", "order.gelatoapis.com", "shipment.gelatoapis.com"],
    secrets: { api_key: { owner: "polpo-infra", service: "gelato", key: "api_key" } },
    auth: { type: "header", header: "X-API-KEY", secret: "api_key" },
    settingsSchema: [
      { key: "currency", label: "Default currency", type: "enum", options: ["EUR", "USD", "GBP", "CAD", "AUD", "JPY", "SEK", "NOK", "DKK", "CHF"], default: "EUR", help: "Prices and quotes use it when a call does not name one." },
      { key: "country", label: "Default country", type: "string", pattern: "[A-Z]{2}", default: "IT", help: "ISO country code for prices and shipping methods when a call does not name one." },
    ],
    limits: { timeoutMs: 30_000, maxResultChars: 30_000, retries: 2 },
    tools: [
      {
        name: "list_catalogs",
        title: "Catalogs",
        description: "Gelato's product catalogs (catalogUid, title): e.g. apparel, posters, mugs, cards. Then get_catalog for its attributes and search_products.",
        kind: "http",
        inputSchema: { type: "object", properties: {} },
        annotations: READ,
        http: { method: "GET", url: `${PRODUCT}/catalogs`, errors },
      },
      {
        name: "get_catalog",
        title: "Catalog attributes",
        description: "One catalog and its product attributes with their values (e.g. GarmentColor, GarmentSize, PaperFormat): the values to filter search_products by.",
        kind: "http",
        inputSchema: { type: "object", properties: { catalog_uid: { type: "string", description: "e.g. apparel, posters" } }, required: ["catalog_uid"] },
        annotations: READ,
        http: { method: "GET", url: `${PRODUCT}/catalogs/{{input.catalog_uid}}`, errors },
      },
      {
        name: "search_products",
        title: "Search products",
        description: "Products of a catalog, filtered by attribute values (e.g. { \"GarmentColor\": [\"white\"], \"GarmentSize\": [\"M\"] }), paged: productUid and attributes. "
          + "Use the productUid for prices, quotes and orders.",
        kind: "http",
        inputSchema: {
          type: "object",
          properties: {
            catalog_uid: { type: "string" },
            attribute_filters: { type: "object", description: "Attribute → list of values (get_catalog lists them)" },
            limit: { type: "integer", minimum: 1, maximum: 100, description: "Default 20" },
            offset: { type: "integer", minimum: 0 },
          },
          required: ["catalog_uid"],
        },
        annotations: READ,
        http: {
          method: "POST", url: `${PRODUCT}/catalogs/{{input.catalog_uid}}/products:search`,
          body: { attributeFilters: "{{input.attribute_filters}}", limit: "{{input.limit ?? 20}}", offset: "{{input.offset ?? 0}}" },
          response: { pick: "products", fields: ["productUid", "attributes", "weight", "dimensions"] }, errors, retries: 2,
        },
      },
      {
        name: "get_product",
        title: "Product",
        description: "One product by productUid: its attributes, weight, dimensions and print areas.",
        kind: "http",
        inputSchema: { type: "object", properties: { product_uid: { type: "string" } }, required: ["product_uid"] },
        annotations: READ,
        http: { method: "GET", url: `${PRODUCT}/products/{{input.product_uid}}`, errors },
      },
      {
        name: "get_product_prices",
        title: "Product prices",
        description: "The price of a product by quantity in a country and currency (defaults: the server's settings).",
        kind: "http",
        inputSchema: {
          type: "object",
          properties: { product_uid: { type: "string" }, country: { type: "string", description: "ISO code, e.g. IT" }, currency: { type: "string", description: "e.g. EUR" }, page_count: { type: "integer", description: "Books and multi-page products" } },
          required: ["product_uid"],
        },
        annotations: READ,
        http: {
          method: "GET", url: `${PRODUCT}/products/{{input.product_uid}}/prices`,
          query: { country: "{{input.country ?? settings.country}}", currency: "{{input.currency ?? settings.currency}}", pageCount: "{{input.page_count}}" },
          errors,
        },
      },
      {
        name: "list_shipment_methods",
        title: "Shipping methods",
        description: "The shipping methods to a country (uid, name, type: normal / express, tracking).",
        kind: "http",
        inputSchema: { type: "object", properties: { country: { type: "string", description: "ISO code (default: the server's setting)" } } },
        annotations: READ,
        http: {
          method: "GET", url: `${SHIPMENT}/shipment-methods`, query: { country: "{{input.country ?? settings.country}}" },
          response: { pick: "shipmentMethods", fields: ["shipmentMethodUid", "name", "type", "isBusiness", "isPrivate", "hasTracking"] }, errors,
        },
      },
      {
        name: "quote_order",
        title: "Quote an order",
        description: "Prices, production and shipping options for products to a recipient — nothing is created or charged.",
        kind: "http",
        inputSchema: {
          type: "object",
          properties: {
            order_reference_id: { type: "string", description: "Your reference" },
            customer_reference_id: { type: "string" },
            currency: { type: "string" },
            recipient: addressSchema,
            products: productsSchema,
          },
          required: ["recipient", "products"],
        },
        annotations: READ,
        http: {
          method: "POST", url: `${ORDER}/orders:quote`,
          body: {
            orderReferenceId: "{{input.order_reference_id ?? \"quote\"}}", customerReferenceId: "{{input.customer_reference_id ?? \"polpo\"}}",
            currency: "{{input.currency ?? settings.currency}}", recipient: "{{input.recipient}}", products: "{{input.products}}",
          },
          response: { pick: "quotes" }, errors, retries: 2,
        },
      },
      {
        name: "create_draft_order",
        title: "Create a draft order",
        description: "Create a DRAFT order on Gelato (orderType \"draft\": not produced or charged until someone converts it in the Gelato dashboard; this tool never does). "
          + "Every call needs a person's approval.",
        kind: "http",
        inputSchema: {
          type: "object",
          properties: {
            order_reference_id: { type: "string", description: "Your order reference" },
            customer_reference_id: { type: "string" },
            currency: { type: "string" },
            shipping_address: { ...addressSchema, required: ["firstName", "lastName", "addressLine1", "city", "postCode", "country", "email"] },
            items: productsSchema,
            shipment_method_uid: { type: "string", description: "From list_shipment_methods (optional)" },
          },
          required: ["order_reference_id", "shipping_address", "items"],
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
        requiresApproval: true,
        http: {
          method: "POST", url: `${ORDER}/orders`,
          // always a draft: the order type is fixed here, never taken from the input
          body: {
            orderType: "draft", orderReferenceId: "{{input.order_reference_id}}", customerReferenceId: "{{input.customer_reference_id ?? \"polpo\"}}",
            currency: "{{input.currency ?? settings.currency}}", items: "{{input.items}}", shippingAddress: "{{input.shipping_address}}", shipmentMethodUid: "{{input.shipment_method_uid}}",
          },
          response: { fields: ["id", "orderReferenceId", "orderType", "fulfillmentStatus", "financialStatus", "currency", "receipts"] }, errors, retries: 0,
        },
      },
      {
        name: "get_order",
        title: "Order status",
        description: "One order: type (draft / order), fulfillment and financial status, items with their status, shipments and tracking.",
        kind: "http",
        inputSchema: { type: "object", properties: { order_id: { type: "string", description: "Gelato order id" } }, required: ["order_id"] },
        annotations: READ,
        http: {
          method: "GET", url: `${ORDER}/orders/{{input.order_id}}`,
          response: { fields: ["id", "orderReferenceId", "orderType", "fulfillmentStatus", "financialStatus", "currency", "createdAt", "updatedAt", "items", "shipment", "receipts"] }, errors,
        },
      },
      {
        name: "search_orders",
        title: "Search orders",
        description: "Orders, newest first, filtered by your reference, type or status (id, reference, type, statuses, created), paged.",
        kind: "http",
        inputSchema: {
          type: "object",
          properties: {
            order_reference_id: { type: "string" },
            order_types: { type: "array", items: { type: "string", enum: ["order", "draft"] } },
            fulfillment_statuses: { type: "array", items: { type: "string" }, description: "e.g. created, printed, shipped, canceled" },
            limit: { type: "integer", minimum: 1, maximum: 100 }, offset: { type: "integer", minimum: 0 },
          },
        },
        annotations: READ,
        http: {
          method: "POST", url: `${ORDER}/orders:search`,
          body: { orderReferenceId: "{{input.order_reference_id}}", orderTypes: "{{input.order_types}}", fulfillmentStatuses: "{{input.fulfillment_statuses}}", limit: "{{input.limit ?? 20}}", offset: "{{input.offset ?? 0}}" },
          response: { pick: "orders", fields: ["id", "orderReferenceId", "orderType", "fulfillmentStatus", "financialStatus", "currency", "createdAt"] }, errors, retries: 2,
        },
      },
    ],
  },
  tests: [
    { id: "catalogs", name: "Catalogs", tool: "list_catalogs", input: {} },
    { id: "shipping-methods", name: "Shipping methods (default country)", tool: "list_shipment_methods", input: {} },
  ],
};

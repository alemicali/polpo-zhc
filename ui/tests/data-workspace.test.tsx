/* eslint-disable @typescript-eslint/no-explicit-any -- request bodies and fixtures are checked field by field */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// ── SDK mock: SSE buffer and agents ─────────────────────────────────────────
type FakeEvent = { id: string; event: string; data: unknown; timestamp: string };
const sse = vi.hoisted(() => ({
  events: [] as FakeEvent[],
  listeners: new Set<() => void>(),
}));
vi.mock("@polpo-ai/react", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEvents: (filter?: string[]) => {
      const all = useSyncExternalStore((cb) => { sse.listeners.add(cb); return () => sse.listeners.delete(cb); }, () => sse.events);
      return { events: filter?.length ? all.filter((e) => filter.includes(e.event)) : all };
    },
    useAgents: () => ({ agents: [{ name: "analyst", identity: { displayName: "Ana" } }, { name: "writer" }] }),
  };
});

import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "../src/components/ui/tooltip";
import { DataPage } from "../src/pages/data";

const now = new Date().toISOString();
const source = {
  id: "src1", name: "Business DB", slug: "business-db", description: "Customers and orders", kind: "sqlite", environment: "production",
  config: { location: "/data/business.sqlite" }, tags: ["internal"],
  grants: [{ id: "g1", agent: "analyst", capabilities: ["read"], datasets: ["*"] }], createdAt: now, updatedAt: now,
};
const customers = [
  { id: 1, name: "Ada", region: "EU", revenue: 1200 },
  { id: 2, name: "Linus", region: "US", revenue: 800 },
  { id: 3, name: "Grace", region: "US", revenue: 1600 },
];
const schema = [
  {
    id: "src1:customers", sourceId: "src1", name: "customers", kind: "table", rowCount: 3,
    columns: [
      { name: "id", type: "number", nullable: false, primaryKey: true, nativeType: "INTEGER" },
      { name: "name", type: "string", nullable: false, nativeType: "TEXT" },
      { name: "region", type: "string", nullable: true, nativeType: "TEXT" },
      { name: "revenue", type: "number", nullable: true, nativeType: "REAL", defaultValue: "0" },
    ],
    indexes: [{ name: "customers_region", columns: ["region"], unique: false }],
    foreignKeys: [],
  },
  {
    id: "src1:orders", sourceId: "src1", name: "orders", kind: "table", rowCount: 0,
    columns: [{ name: "id", type: "number", primaryKey: true }, { name: "customer_id", type: "number" }],
    indexes: [], foreignKeys: [{ columns: ["customer_id"], references: { dataset: "customers", columns: ["id"] }, onDelete: "CASCADE" }],
  },
];

type Call = { method: string; path: string; body?: any };
let calls: Call[];
let views: any[];
let root: Root;
let container: HTMLDivElement;

function applyFilters(rows: typeof customers, filters: Array<{ field: string; operator: string; value?: unknown }> = []) {
  return rows.filter((row) => filters.every((f) => {
    const v = (row as Record<string, unknown>)[f.field];
    if (f.operator === "eq") return v === f.value;
    if (f.operator === "in") return (f.value as unknown[]).includes(v);
    if (f.operator === "contains") return String(v).toLowerCase().includes(String(f.value).toLowerCase());
    return true;
  }));
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  sse.events = [];
  calls = [];
  views = [];
  localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace("/api/v1", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const reply = (data: unknown, status = 200) => new Response(JSON.stringify(status < 300 ? { ok: true, data } : { ok: false, error: data }), { status });
    if (path === "/data" && method === "GET") return reply([source]);
    if (path === "/data/src1" && method === "GET") return reply({ ...source, credentialKeys: [] });
    if (path === "/data/src1" && method === "PUT") { Object.assign(source, { grants: body.grants }); return reply(source); }
    if (path === "/data/src1/schema") return reply(schema);
    if (path === "/data/src1/activity") return reply([{ id: "a1", sourceId: "src1", agent: "analyst", action: "query", dataset: "customers", status: "succeeded", rowCount: 3, durationMs: 4, createdAt: now }]);
    if (path === "/data/src1/test") return reply({ ok: true, latencyMs: 3, datasets: 2 });
    if (path === "/data/query") {
      let rows = applyFilters(customers, body.filters);
      const total = rows.length;
      if (body.sort?.[0]) rows = [...rows].sort((a: any, b: any) => (a[body.sort[0].field] > b[body.sort[0].field] ? 1 : -1) * (body.sort[0].direction === "desc" ? -1 : 1));
      rows = rows.slice(body.offset ?? 0, (body.offset ?? 0) + (body.limit ?? 100));
      return reply({ columns: [], rows, meta: { sourceId: "src1", dataset: body.dataset, queryId: "q", rowCount: rows.length, truncated: false, durationMs: 1, fetchedAt: now, ...(body.includeTotal ? { totalCount: total } : {}) } });
    }
    if (path === "/data/sql") return reply({ columns: [{ name: "region", type: "string" }, { name: "n", type: "number" }], rows: [{ region: "EU", n: 1 }, { region: "US", n: 2 }], meta: { sourceId: "src1", dataset: "raw-sql", queryId: "s", rowCount: 2, truncated: false, durationMs: 2, fetchedAt: now } });
    if (path === "/data/mutate") return reply({ affectedRows: body.filters?.[0]?.operator === "in" ? body.filters[0].value.length : 1 });
    if (path === "/views" && method === "GET") return reply(views);
    if (path === "/views" && method === "POST") { const view = { id: "v1", ...body, createdAt: now, updatedAt: now }; views.push(view); return reply(view, 201); }
    throw new Error(`unexpected ${method} ${path}`);
  }));
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0)); });
const click = async (el: Element | null | undefined) => { expect(el, "element to click").toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); await flush(); };
const byText = (text: string | RegExp, selector = "button") =>
  [...document.querySelectorAll<HTMLElement>(selector)].find((el) => (typeof text === "string" ? el.textContent?.trim() === text : text.test(el.textContent ?? "")));
const byLabel = <T extends HTMLElement = HTMLElement>(label: string) => document.querySelector<T>(`[aria-label="${label}"]`);
async function type(el: HTMLInputElement | HTMLTextAreaElement | null, value: string) {
  expect(el, "field to type in").toBeTruthy();
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
}
const key = async (el: Element | null, keyName: string, extra: KeyboardEventInit = {}) => {
  await act(async () => { el!.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, ...extra })); });
  await flush();
};
const lastCall = (path: string) => [...calls].reverse().find((c) => c.path === path);

async function renderAt(url: string) {
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[url]}><TooltipProvider><DataPage /></TooltipProvider></MemoryRouter>);
  });
  await flush();
}

test("sources list: a card per source with type, environment, health and agents; it opens the workspace", async () => {
  await renderAt("/data");
  const card = byText("Business DB");
  expect(card).toBeTruthy();
  expect(document.body.textContent).toContain("SQLite");
  expect(document.body.textContent).toContain("production");
  expect(document.body.textContent).toContain("Connected"); // from the last activity
  expect(document.body.textContent).toContain("1 agent");
  await click(card);
  for (const tab of ["Tables", "Schema", "SQL", "Views", "Access", "Activity", "Settings"]) expect(byText(tab, "[role=tab]"), tab).toBeTruthy();
  // no table chosen: the tables as cards with their row counts
  expect(byText(/customers3 rows/)).toBeTruthy();
});

test("browse: rows with a total, sort by a header, filter, page size; keyboard moves between cells and opens a row", async () => {
  await renderAt("/data?source=src1&tab=tables&table=customers");
  const grid = document.querySelector("[role=grid]")!;
  expect(grid).toBeTruthy();
  expect(grid.querySelectorAll("tbody tr")).toHaveLength(3);
  expect(document.body.textContent).toContain("1–3 of 3 records");
  expect(lastCall("/data/query")!.body).toMatchObject({ dataset: "customers", limit: 50, offset: 0, includeTotal: true });

  // sort by revenue: ascending, then descending
  const revenueHeader = [...grid.querySelectorAll<HTMLButtonElement>("th button")].find((b) => b.textContent?.startsWith("revenue"))!;
  await click(revenueHeader);
  expect(lastCall("/data/query")!.body.sort).toEqual([{ field: "revenue", direction: "asc" }]);
  expect(revenueHeader.closest("th")!.getAttribute("aria-sort")).toBe("ascending");
  await click(revenueHeader);
  expect(lastCall("/data/query")!.body.sort).toEqual([{ field: "revenue", direction: "desc" }]);
  expect(document.querySelector("[role=grid] tbody tr td:nth-child(3)")!.textContent).toBe("Grace");

  // filter: first column (id) equals 2
  await click(byLabel("Filter"));
  await click(byText("Add filter"));
  await type(byLabel<HTMLInputElement>("Value"), "2");
  expect(lastCall("/data/query")!.body.filters).toEqual([{ field: "id", operator: "eq", value: 2 }]);
  expect(document.querySelectorAll("[role=grid] tbody tr")).toHaveLength(1);
  expect(document.body.textContent).toContain("1 row match");
  await click(byText("Clear all"));
  await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await flush();
  expect(document.querySelectorAll("[role=grid] tbody tr")).toHaveLength(3);

  // keyboard: arrows move the focus between cells, Enter opens the row
  const first = document.querySelector<HTMLElement>('[data-cell="0:1"]')!;
  expect(first.tabIndex).toBe(0);
  await act(async () => { first.focus(); });
  await key(first, "ArrowDown");
  expect(document.activeElement?.getAttribute("data-cell")).toBe("1:1");
  await key(document.activeElement, "ArrowRight");
  expect(document.activeElement?.getAttribute("data-cell")).toBe("1:2");
  await key(document.activeElement, "Enter");
  const sheet = document.querySelector("[data-slot=sheet-content]")!;
  expect(sheet).toBeTruthy();
  expect(sheet.textContent).toContain("id 1"); // titled by its primary key (Ada: second by revenue, descending)
});

test("edit in place: double-click, type, Enter → a confirmation that counts the rows → the update by primary key", async () => {
  await renderAt("/data?source=src1&tab=tables&table=customers");
  const cell = document.querySelector<HTMLElement>('[data-cell="0:3"]')!; // Ada's region (column 0 is the checkbox)
  expect(cell.textContent).toBe("EU");
  await act(async () => { cell.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })); });
  await flush();
  const input = byLabel<HTMLInputElement>("Edit region")!;
  await type(input, "UK");
  await key(input, "Enter");
  const dialog = document.querySelector("[role=dialog]")!;
  expect(dialog.textContent).toContain("Update this row?");
  expect(dialog.textContent).toContain("id equals 1");
  expect(dialog.textContent).toContain("1 row will change");
  expect(calls.some((c) => c.path === "/data/mutate")).toBe(false); // nothing written before the confirm
  await click(byText("Update"));
  expect(lastCall("/data/mutate")!.body).toEqual({ sourceId: "src1", dataset: "customers", operation: "update", values: { region: "UK" }, filters: [{ field: "id", operator: "eq", value: 1 }] });
});

test("insert and delete: the row form types values; deleting selected rows is one confirmed statement by key", async () => {
  await renderAt("/data?source=src1&tab=tables&table=customers");
  await click(byText(/Add row/));
  expect(document.body.textContent).toContain("Insert row");
  await type(document.querySelector<HTMLInputElement>("#row-field-name"), "Edsger");
  await type(document.querySelector<HTMLInputElement>("#row-field-revenue"), "500");
  await click(byText(/Review insert/));
  expect(document.body.textContent).toContain("Insert a row into customers?");
  await click(byText("Insert"));
  expect(lastCall("/data/mutate")!.body).toEqual({ sourceId: "src1", dataset: "customers", operation: "insert", values: { name: "Edsger", revenue: 500 } });

  await click(byLabel("Select row 2"));
  await click(byLabel("Select row 3"));
  expect(document.body.textContent).toContain("2 selected");
  const deleteButton = [...document.querySelectorAll<HTMLButtonElement>("[role=toolbar] button")].find((b) => b.textContent?.trim() === "Delete");
  await click(deleteButton);
  const dialog = document.querySelector("[role=dialog]")!;
  expect(dialog.textContent).toContain("Delete 2 rows?");
  expect(dialog.textContent).toContain("cannot be undone");
  expect(dialog.textContent).toContain("2 rows will be deleted");
  await click([...dialog.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Delete"));
  expect(lastCall("/data/mutate")!.body).toEqual({ sourceId: "src1", dataset: "customers", operation: "delete", filters: [{ field: "id", operator: "in", value: [2, 3] }] });
});

test("SQL: run read-only statements with Ctrl+Enter, refuse writes before sending, keep history, save as a live view", async () => {
  await renderAt("/data?source=src1&tab=sql");
  const editor = byLabel<HTMLTextAreaElement>("SQL for Business DB")!;
  expect(editor.value).toContain("FROM customers");
  await type(editor, "DELETE FROM customers");
  await key(editor, "Enter", { ctrlKey: true });
  expect(calls.some((c) => c.path === "/data/sql")).toBe(false);
  expect(document.body.textContent).toContain("Only SELECT, WITH and EXPLAIN run here");

  await type(editor, "SELECT region, COUNT(*) AS n FROM customers GROUP BY region");
  await key(editor, "Enter", { metaKey: true });
  expect(lastCall("/data/sql")!.body).toEqual({ sourceId: "src1", sql: "SELECT region, COUNT(*) AS n FROM customers GROUP BY region" });
  expect(document.querySelectorAll('[aria-label="Query results"] tbody tr')).toHaveLength(2);
  expect(document.body.textContent).toContain("2 rows");
  // highlighted copy of the text
  expect(document.querySelector("pre[aria-hidden=true] .text-primary")?.textContent).toBe("SELECT");
  // history (this browser)
  expect(JSON.parse(localStorage.getItem("polpo:data-sql-history:src1")!)[0].sql).toContain("GROUP BY region");

  await click(byText(/Save as view/));
  await type(document.querySelector<HTMLInputElement>("[role=dialog] input"), "Customers by region");
  await click(byText(/Save view/));
  expect(lastCall("/views")!.body).toMatchObject({
    name: "Customers by region",
    bindings: [{ id: "result", sql: { sourceId: "src1", statement: "SELECT region, COUNT(*) AS n FROM customers GROUP BY region" } }],
  });
});

test("save a table as a view: the binding keeps its filters and sort", async () => {
  await renderAt("/data?source=src1&tab=tables&table=customers");
  const nameHeader = [...document.querySelectorAll<HTMLButtonElement>("th button")].find((b) => b.textContent?.startsWith("name"))!;
  await click(nameHeader);
  await click(byLabel("Save as view"));
  expect(lastCall("/views")!.body).toMatchObject({
    bindings: [{ id: "rows", query: { sourceId: "src1", dataset: "customers", sort: [{ field: "name", direction: "asc" }] } }],
    widgets: [{ type: "metric" }, { type: "table" }],
  });
});

test("schema: columns with keys and types, indexes, relations both ways", async () => {
  await renderAt("/data?source=src1&tab=schema&table=customers");
  const section = document.querySelector('[aria-label="Schema of customers"]')!;
  expect(section.textContent).toContain("INTEGER");
  expect(section.querySelector('[aria-label="Primary key"]')).toBeTruthy();
  expect(section.textContent).toContain("customers_region");
  // orders.customer_id → customers.id shows as "referenced by"
  expect(section.querySelector('[aria-label="Referenced by"]')).toBeTruthy();
  await click([...section.querySelectorAll("button")].find((b) => b.textContent === "orders"));
  expect(document.querySelector('[aria-label="Schema of orders"]')!.textContent).toContain("on delete cascade");
});

test("access: an agent's scope — some datasets and hidden fields — is saved in its grant", async () => {
  await renderAt("/data?source=src1&tab=access");
  expect(document.body.textContent).toContain("Ana");
  expect(document.body.textContent).toContain("All datasets");
  await click(byLabel("Scope for analyst"));
  await click(byText(/Every dataset/, "label")?.querySelector("button"));
  await click(byText(/^orders$/, "label")?.querySelector("button"));
  await type(document.querySelector<HTMLInputElement>('[placeholder="email, phone, salary"]'), "revenue");
  await click(byText("Save scope"));
  expect(lastCall("/data/src1")!.method).toBe("PUT");
  expect(lastCall("/data/src1")!.body.grants).toEqual([{ id: "g1", agent: "analyst", capabilities: ["read"], datasets: ["orders"], excludedFields: ["revenue"] }]);
});

test("old and setup links: ?tab=sources opens the source; a setup link opens Settings on the secret", async () => {
  await renderAt("/data?tab=sources&source=src1");
  expect(byText("Tables", "[role=tab]")!.getAttribute("aria-selected")).toBe("true");
  act(() => root.unmount());
  root = createRoot(container);
  source.kind = "postgres";
  try {
    await renderAt("/data?tab=sources&source=src1&focus=password&setup=data%3Asrc1%3Apassword");
    expect(byText("Settings", "[role=tab]")!.getAttribute("aria-selected")).toBe("true");
    const secret = document.querySelector<HTMLInputElement>('[data-setup-field="password"]')!;
    expect(secret.type).toBe("password");
    expect(document.body.textContent).toContain("not set");
  } finally { source.kind = "sqlite"; }
});
